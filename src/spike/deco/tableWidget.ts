// 壳移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/table.ts:1622-1726（widget）
// 与 474-1588（单元格 DOM / 事件 / 工具栏），本机参照 E:\Project\InkNote\InkNote
//
// B397-3b · 表格 widget 的**就地编辑**。与代码块那一格（codeBlockWidget.ts）同一条命门：
// `updateDOM`。CM6 在 `eq()` 判不等时先试 `updateDOM`，返回 false 才重建 DOM
// （@codemirror/view/dist/index.js:2566-2568）⇒ 少了它每敲一键整张表换新、光标没；
// 而表格比代码块多一根线：**结构真的变了（增删行列）时必须 return false** 走重建
// （table.ts:1673-1677），不然 DOM 会停在半新半旧。
//
// 事件必须直接挂在 widget DOM 上：`ignoreEvent()` 对格内事件返回 true，CM6 在
// `eventBelongsToEditor` 阶段就把它们丢了，`domEventHandlers` 根本收不到
// —— 也正因为 CM 不碰、不 preventDefault，原生输入（含中文输入法）才能在格子里打字。
//
// 与 InkNote 的有意差异（其余每一根线照抄）：
// 1. **i18n**：LitePad 没有语言层 ⇒ 工具栏文案/提示直接写中文。
// 2. **确认框**：它删表前按偏好问一次（`askConfirm` + `getConfirmDelete`，都是 Tauri 侧的东西）；
//    LitePad 这条路径与「代码块清空后退格整块删」同口径 —— 直接删，撤销交给 Ctrl+Z。
// 3. **剪贴板**：`@tauri-apps/plugin-clipboard-manager` → `navigator.clipboard`（复制键已在用）。
// 4. **单元格对齐**：它支持「框选若干格 → 把 `<!--inknote-align:center-->` 写进格源码」；
//    LitePad 只走 Markdown 自己那套**整列**对齐（点中哪一列改哪一列）。理由是那个注释是
//    InkNote 专有格式，会写进用户的文档，而另一臂（派生 DOM 预览）不认它 —— 同一篇文档
//    两臂口径不一致正是 B352 当初要避免的事。
// 5. **格内公式**：它自带一个行内 Markdown 子集（粗/斜/删/码/高亮/链接），**没有 KaTeX**；
//    LitePad 这版按它抄 ⇒ 表格单元格里 `$x$` 回到字面源码（原来走 `renderFull` 能画，
//    但那版整张表是只读的）。要在表里画公式属于另一件事。
// 6. **格子链接**：仍是 `data-href`（不带 `href`，点了不会把 WebView 导航走，B394-1 那一族），
//    Ctrl+点击打开（它的 `openUrl` + 锚点跳转）这一格没接。
// 7. **从表外面进表**的那几个入口（`insertTableAtCursor` / `tableBackspace` / `tableDeleteKey` /
//    `tableSelectionSnap`）归 #227 的 keymap 那一格，这里一行不留空壳。
// 8. **工具栏提示**：它用原生 `title`；本仓的口径是 tooltip 收在 `shell/tooltip` 一处、
//    按钮档带尖尖（B350），所以这里走 `setTip()`（全仓不许写原生 title，有守卫）。

import { EditorView, WidgetType } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { setTip } from "../../shell/tooltip";
import { bindBlockBoundaryCursor, currentBlockRange, stampBlockRange } from "./blockRange";
import { clickedOnBlockPadding } from "./editableSource";
import {
  colCount,
  mutateTableData,
  serializeTable,
  type CellPosition,
  type TableAlign,
  type TableData,
  type TableEditAction,
} from "./tableData";

/* ------------------------------------------------------------------ *
 * 单元格内容：DOM 展示渲染后的行内 Markdown，源码保存在 dataset.raw
 * ------------------------------------------------------------------ */

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPE[c]);
}

/** 单元格里的行内 Markdown 渲染（粗体/斜体/删除线/行内代码/高亮/链接）—— table.ts:501-521 */
export function renderInlineMarkdown(src: string): string {
  const parts = escapeHtml(src).split(/(`[^`]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${part.slice(1, -1)}</code>`;
      return part
        .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
        .replace(/\r\n?|\n/g, "<br>")
        .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, label: string, target: string) => {
          if (/^(?:javascript|data|vbscript):/i.test(target)) return label;
          return `<a class="md-table-link" data-href="${target}">${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_([^_]+)_/g, "$1<em>$2</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/==([^=]+)==/g, "<mark>$1</mark>");
    })
    .join("");
}

/** 编辑时用真实换行，行内代码里的字面量保持原样。 */
function editableCellText(raw: string): string {
  return raw
    .split(/(`[^`]+`)/g)
    .map((part, index) => (index % 2 ? part : part.replace(/<br\s*\/?>/gi, "\n")))
    .join("");
}

/** 写入单元格：聚焦中的单元格保持源码，其余显示渲染结果。 */
function setCellRaw(cell: HTMLElement, raw: string, columnAlign: TableAlign = "left"): void {
  cell.dataset.raw = raw;
  // 对齐是 CSS 能改而不打断光标的属性 ⇒ 聚焦中的那格也照改，只重写文本会打掉光标
  cell.style.textAlign = columnAlign;
  if (document.activeElement === cell) {
    const editable = editableCellText(raw);
    if (cell.textContent !== editable) cell.textContent = editable;
  } else {
    cell.innerHTML = renderInlineMarkdown(raw);
  }
}

/** 读取单元格源码（聚焦中的以实时文本为准）。 */
function cellRawText(cell: HTMLElement): string {
  if (document.activeElement === cell) return cell.textContent ?? "";
  return cell.dataset.raw ?? cell.textContent ?? "";
}

function showCellSource(cell: HTMLElement): void {
  const raw = cell.dataset.raw ?? cell.textContent ?? "";
  cell.dataset.raw = raw;
  const editable = editableCellText(raw);
  if (cell.textContent !== editable) cell.textContent = editable;
}

/**
 * 切回渲染态。
 *
 * 一律以 dataset.raw 为准：失焦时 updateDOM 可能已经把单元格渲染过一遍，
 * 这时再去读 textContent 拿到的是渲染结果（`粗` 而不是 `**粗**`），会把源码写坏。
 */
function showCellRendered(cell: HTMLElement): void {
  const raw = cell.dataset.raw ?? cell.textContent ?? "";
  cell.dataset.raw = raw;
  cell.innerHTML = renderInlineMarkdown(raw);
}

function readAligns(wrap: HTMLElement): TableAlign[] {
  const raw = wrap.dataset.tableAligns ?? "";
  if (!raw) return [];
  return raw.split(",").map((a) => {
    if (a === "center" || a === "right") return a;
    return "left";
  });
}

/** 对齐档位要在 DOM 上记一份：回写走 readTableFromDom，源码里的 `:---:` 得跟着走回来。 */
function writeAligns(wrap: HTMLElement, aligns: TableAlign[]): void {
  wrap.dataset.tableAligns = aligns.join(",");
}

function readTableFromDom(wrap: HTMLElement): TableData {
  const header: string[] = [];
  wrap.querySelectorAll<HTMLElement>("thead th").forEach((th) => {
    header.push(cellRawText(th));
  });

  const rows: string[][] = [];
  wrap.querySelectorAll<HTMLElement>("tbody tr").forEach((tr) => {
    const row: string[] = [];
    tr.querySelectorAll<HTMLElement>("td").forEach((td) => {
      row.push(cellRawText(td));
    });
    if (row.length) rows.push(row);
  });

  return { header, rows, aligns: readAligns(wrap) };
}

function getEditableCells(wrap: Element): HTMLElement[] {
  return Array.from(wrap.querySelectorAll<HTMLElement>("th[contenteditable], td[contenteditable]"));
}

/** 按行列取单元格：不做等宽假设，残缺表格也能定位。 */
function cellAt(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  if (row === 0) return wrap.querySelectorAll<HTMLElement>("thead th")[col] ?? null;
  const tr = wrap.querySelectorAll<HTMLElement>("tbody tr")[row - 1];
  if (!tr) return null;
  return tr.querySelectorAll<HTMLElement>("td")[col] ?? null;
}

/** 单元格在表格里的行列位置（表头为第 0 行）。 */
function cellPosition(cell: HTMLElement): CellPosition | null {
  const tr = cell.closest("tr");
  if (!tr) return null;
  const col = Array.from(tr.children).indexOf(cell);
  if (col < 0) return null;
  if (cell.tagName === "TH") return { row: 0, col };
  const tbody = tr.parentElement;
  return { row: 1 + (tbody ? Array.from(tbody.children).indexOf(tr) : 0), col };
}

function getFocusedCellInfo(wrap: HTMLElement): CellPosition | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !wrap.contains(active)) return null;
  return active.closest("th,td") ? cellPosition(active) : null;
}

function rowCount(wrap: HTMLElement): number {
  return wrap.querySelectorAll("thead tr").length + wrap.querySelectorAll("tbody tr").length;
}

function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return true;
  const probe = range.cloneRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}

function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return true;
  const probe = range.cloneRange();
  probe.selectNodeContents(el);
  probe.setStart(range.endContainer, range.endOffset);
  return probe.toString().length === 0;
}

function placeCaret(cell: HTMLElement, atEnd: boolean): void {
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(!atEnd);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function insertCellText(cell: HTMLElement, text: string): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (range && cell.contains(range.startContainer) && cell.contains(range.endContainer)) {
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection!.removeAllRanges();
    selection!.addRange(range);
  } else {
    cell.appendChild(document.createTextNode(text));
    placeCaret(cell, true);
  }
  cell.dataset.raw = cell.textContent ?? "";
}

function focusCellOnWrap(wrap: HTMLElement, row: number, col: number, atEnd = false): void {
  const cell = cellAt(wrap, row, col);
  if (!cell) return;
  wrap.classList.add("md-table-widget--focused");
  showCellSource(cell);
  cell.focus();
  placeCaret(cell, atEnd);
}

function focusAdjacentCell(cell: HTMLElement, backward: boolean): void {
  const wrap = cell.closest<HTMLElement>(".md-table-widget");
  if (!wrap) return;
  const cells = getEditableCells(wrap);
  const idx = cells.indexOf(cell);
  if (idx < 0) return;
  const next = backward ? cells[idx - 1] : cells[idx + 1];
  if (!next) return;
  showCellSource(next);
  next.focus();
  placeCaret(next, !backward);
}

function exitTableToLineAbove(view: EditorView, wrap: HTMLElement): void {
  const range = currentBlockRange(view, wrap);
  flushSync(wrap, view);
  if (!range) return;
  const line = view.state.doc.lineAt(Math.min(range.from, view.state.doc.length));
  const pos = line.number > 1 ? view.state.doc.line(line.number - 1).to : line.from;
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
}

function exitTableToLineBelow(view: EditorView, wrap: HTMLElement): void {
  flushSync(wrap, view);
  const range = currentBlockRange(view, wrap);
  if (!range) return;
  const doc = view.state.doc;
  const pos =
    range.to < doc.length && doc.sliceString(range.to, range.to + 1) === "\n"
      ? range.to + 1
      : range.to;
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
}

/* ------------------------------------------------------------------ *
 * 框选（按住拖过多个单元格）：跨格的原生选区在 contenteditable 之间很难看，自己画
 * ------------------------------------------------------------------ */

function clearCellSelection(wrap: HTMLElement): void {
  wrap.querySelectorAll(".md-table-cell-selected").forEach((el) => {
    el.classList.remove("md-table-cell-selected");
  });
}

/** 框选一个矩形区域；只选中一个格时不算多选。 */
function selectCellRange(wrap: HTMLElement, a: HTMLElement, b: HTMLElement): void {
  clearCellSelection(wrap);
  const pa = cellPosition(a);
  const pb = cellPosition(b);
  if (!pa || !pb) return;
  if (pa.row === pb.row && pa.col === pb.col) return;

  const r0 = Math.min(pa.row, pb.row);
  const r1 = Math.max(pa.row, pb.row);
  const c0 = Math.min(pa.col, pb.col);
  const c1 = Math.max(pa.col, pb.col);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      cellAt(wrap, r, c)?.classList.add("md-table-cell-selected");
    }
  }
  window.getSelection()?.removeAllRanges();
}

function selectedCells(wrap: HTMLElement): HTMLElement[] {
  return Array.from(wrap.querySelectorAll<HTMLElement>(".md-table-cell-selected"));
}

function cellPlainText(cell: HTMLElement): string {
  const template = document.createElement("template");
  template.innerHTML = renderInlineMarkdown(cellRawText(cell));
  template.content.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (template.content.textContent ?? "").replace(/\u00a0/g, " ");
}

/** 框选区域的文本（行内 \t、行间 \n）；没框选返回 null。 */
function selectedTextFromTable(wrap: HTMLElement): string | null {
  const selected = new Set(selectedCells(wrap));
  if (!selected.size) return null;

  return Array.from(wrap.querySelectorAll<HTMLTableRowElement>("tr"))
    .map((row) =>
      Array.from(row.children)
        .filter((cell): cell is HTMLElement => cell instanceof HTMLElement && selected.has(cell))
        .map(cellPlainText),
    )
    .filter((row) => row.length > 0)
    .map((row) => row.join("\t"))
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * 回写：DOM → 源码（rAF 合并，失焦/换格/撤销前 flush 一次）
 * ------------------------------------------------------------------ */

let tableSyncing = false;
const syncFrames = new Map<HTMLElement, number>();

/** 回写那一发正在跑：输入监听读到它就跳过（否则自触发成环）。 */
export function isTableSyncing(): boolean {
  return tableSyncing;
}

function syncTableFromDom(wrap: HTMLElement, view: EditorView, data?: TableData): void {
  const range = currentBlockRange(view, wrap);
  if (!range) return;

  // 增删行列那一发带的是**算好的新矩阵**：DOM 此刻还是旧结构，从 DOM 读回来等于把改动丢掉
  const tableData = data ?? readTableFromDom(wrap);
  const insert = serializeTable(tableData.header, tableData.rows, tableData.aligns);
  const current = view.state.doc.sliceString(range.from, range.to);
  if (current === insert) return;
  // 只读锁最后一个兜底：调用方都问了 readOnly，锁还多一条 transactionFilter，
  // 两道闸都指不到对方时「只读」就只是看起来不能打字（见 editableSource.ts 文件头）
  if (view.state.readOnly) return;

  tableSyncing = true;
  try {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      userEvent: "input.table",
    });
  } finally {
    tableSyncing = false;
  }
}

function scheduleSync(wrap: HTMLElement, view: EditorView): void {
  const existing = syncFrames.get(wrap);
  if (existing) cancelAnimationFrame(existing);
  const id = requestAnimationFrame(() => {
    syncFrames.delete(wrap);
    syncTableFromDom(wrap, view);
  });
  syncFrames.set(wrap, id);
}

function flushSync(wrap: HTMLElement, view: EditorView): void {
  const existing = syncFrames.get(wrap);
  if (existing) {
    cancelAnimationFrame(existing);
    syncFrames.delete(wrap);
  }
  syncTableFromDom(wrap, view);
}

/** 增删行列之后那张表要重新画，且焦点要跟着落到新那一格。 */
const pendingFocusByTable = new Map<number, CellPosition>();

function applyTableData(
  wrap: HTMLElement,
  view: EditorView,
  data: TableData,
  focusAt?: CellPosition,
): void {
  const cols = colCount(data);
  while (data.header.length < cols) data.header.push("");
  while (data.aligns.length < cols) data.aligns.push("left");
  for (const row of data.rows) while (row.length < cols) row.push("");

  writeAligns(wrap, data.aligns);
  if (focusAt) {
    const range = currentBlockRange(view, wrap);
    if (range) pendingFocusByTable.set(range.from, focusAt);
  }
  syncTableFromDom(wrap, view, data);
}

function applyTableEdit(wrap: HTMLElement, view: EditorView, action: TableEditAction): void {
  const info = getFocusedCellInfo(wrap);
  const data = readTableFromDom(wrap);
  const result = mutateTableData(data, info?.row ?? 0, info?.col ?? 0, action);
  if (!result) return;
  applyTableData(wrap, view, result.data, result.focus);
}

/** 清空框选区域里的内容（框选状态下的 Backspace/Delete）。 */
function clearSelectedCells(wrap: HTMLElement, view: EditorView): boolean {
  const cells = selectedCells(wrap);
  if (!cells.length) return false;
  for (const cell of cells) {
    cell.dataset.raw = "";
    cell.innerHTML = "";
  }
  clearCellSelection(wrap);
  flushSync(wrap, view);
  return true;
}

function deleteTable(wrap: HTMLElement, view: EditorView): void {
  const range = currentBlockRange(view, wrap);
  if (!range) return;
  const doc = view.state.doc;
  let end = range.to;
  if (end < doc.length && doc.sliceString(end, end + 1) === "\n") end += 1;
  view.dispatch({
    changes: { from: range.from, to: end, insert: "" },
    selection: { anchor: range.from },
    userEvent: "delete.table",
  });
  view.focus();
}

/* ------------------------------------------------------------------ *
 * 工具栏（table.ts:1500-1588 的结构与图标，文案换成中文）
 * ------------------------------------------------------------------ */

interface ToolbarItem {
  action: TableEditAction;
  label: string;
  icon?: string;
  danger?: boolean;
}

const MENU_ITEMS: ToolbarItem[] = [
  { action: "row-below", label: "下方插入行" },
  { action: "row-above", label: "上方插入行" },
  { action: "row-delete", label: "删除当前行", danger: true },
  { action: "col-left", label: "左侧插入列" },
  { action: "col-right", label: "右侧插入列" },
  { action: "col-delete", label: "删除当前列", danger: true },
];

const ICONS = {
  rows: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 4h12v1.5H2V4zm0 3.25h12v1.5H2V7.25zm0 3.25h12V12H2v-1.5z"/></svg>',
  alignLeft:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 3h12v1.5H2V3zm0 3.5h8v1.5H2V6.5zm0 3.5h12v1.5H2V10zm0 3.5h8v1.5H2v-1.5z"/></svg>',
  alignCenter:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 3h12v1.5H2V3zm2 3.5h8v1.5H4V6.5zm-2 3.5h12v1.5H2V10zm2 3.5h8v1.5H4v-1.5z"/></svg>',
  alignRight:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 3h12v1.5H2V3zm4 3.5h8v1.5H6V6.5zm-4 3.5h12v1.5H2V10zm4 3.5h8v1.5H6v-1.5z"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M5 2V1h6v1h4v1.5H1V2h4zm1 4h1.5v7H6V6zm3 0H10.5v7H9V6zM3.5 6H5v9.5c0 .8.7 1.5 1.5 1.5h3c.8 0 1.5-.7 1.5-1.5V6h1.5v9.5c0 1.7-1.3 3-3 3h-3c-1.7 0-3-1.3-3-3V6z"/></svg>',
};

const ALIGN_ITEMS: ToolbarItem[] = [
  { action: "align-left", label: "左对齐", icon: ICONS.alignLeft },
  { action: "align-center", label: "居中", icon: ICONS.alignCenter },
  { action: "align-right", label: "右对齐", icon: ICONS.alignRight },
];

function createToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "md-table-toolbar";
  bar.setAttribute("contenteditable", "false");

  const dropdown = document.createElement("div");
  dropdown.className = "md-table-toolbar-dropdown";

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "md-table-toolbar-btn";
  menuBtn.dataset.action = "menu-toggle";
  setTip(menuBtn, "行/列");
  menuBtn.innerHTML = ICONS.rows;

  const menu = document.createElement("div");
  menu.className = "md-table-toolbar-menu";
  for (const item of MENU_ITEMS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = item.action;
    btn.textContent = item.label;
    if (item.danger) btn.classList.add("md-table-toolbar-menu-danger");
    menu.appendChild(btn);
  }

  dropdown.appendChild(menuBtn);
  dropdown.appendChild(menu);
  bar.appendChild(dropdown);

  const alignGroup = document.createElement("div");
  alignGroup.className = "md-table-toolbar-group";
  for (const item of ALIGN_ITEMS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-table-toolbar-btn";
    btn.dataset.action = item.action;
    setTip(btn, item.label);
    btn.innerHTML = item.icon ?? "";
    alignGroup.appendChild(btn);
  }
  bar.appendChild(alignGroup);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "md-table-toolbar-btn md-table-toolbar-delete";
  deleteBtn.dataset.action = "delete";
  setTip(deleteBtn, "删除表格");
  deleteBtn.innerHTML = ICONS.trash;
  bar.appendChild(deleteBtn);

  const slot = document.createElement("div");
  slot.className = "md-table-toolbar-slot";
  slot.appendChild(bar);
  return slot;
}

function closeAllTableMenus(except?: Element): void {
  document.querySelectorAll(".md-table-toolbar-menu.is-open").forEach((menu) => {
    if (menu !== except) menu.classList.remove("is-open");
  });
}

function handleToolbarAction(wrap: HTMLElement, view: EditorView, action: string): void {
  switch (action) {
    case "row-below":
    case "row-above":
    case "row-delete":
    case "col-left":
    case "col-right":
    case "col-delete":
    case "align-left":
    case "align-center":
    case "align-right":
      applyTableEdit(wrap, view, action);
      break;
    case "delete":
      deleteTable(wrap, view);
      break;
  }
}

function attachToolbarEvents(wrap: HTMLElement): void {
  wrap.addEventListener("mousedown", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(
      ".md-table-toolbar button[data-action], .md-table-toolbar-menu button[data-action]",
    );
    if (!btn || !wrap.contains(btn)) return;

    event.preventDefault();
    event.stopPropagation();

    const view = EditorView.findFromDOM(wrap);
    if (!view) return;
    const action = btn.dataset.action;
    if (!action) return;
    if (view.state.readOnly) return;

    wrap.classList.add("md-table-widget--focused");

    if (action === "menu-toggle") {
      const menu = wrap.querySelector(".md-table-toolbar-menu");
      const willOpen = !menu?.classList.contains("is-open");
      closeAllTableMenus();
      if (willOpen) menu?.classList.add("is-open");
    } else {
      handleToolbarAction(wrap, view, action);
      closeAllTableMenus();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 单元格事件（table.ts:1172-1449）
 * ------------------------------------------------------------------ */

/** 属性而不是反射属性：jsdom 的 setter 不落属性，而「这格能不能编辑/能不能聚焦」都按属性判。 */
function setCellEditable(cell: HTMLElement, editable: boolean): void {
  cell.setAttribute("contenteditable", editable ? "true" : "false");
  cell.spellcheck = false;
}

function appendEditableRow(
  tr: HTMLTableRowElement,
  cells: string[],
  aligns: TableAlign[],
  tag: "th" | "td",
): void {
  cells.forEach((cell, i) => {
    const el = document.createElement(tag);
    setCellEditable(el, true);
    el.dataset.col = String(i);
    setCellRaw(el, cell, aligns[i] ?? "left");
    tr.appendChild(el);
  });
}

function attachCellEvents(wrap: HTMLElement): void {
  let composing = false;
  let dragAnchor: HTMLElement | null = null;
  let dragging = false;

  const viewOf = () => EditorView.findFromDOM(wrap);
  const cellOf = (event: Event) =>
    (event.target as HTMLElement | null)?.closest<HTMLElement>("th, td") ?? null;

  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const view = viewOf();
    const cell = cellOf(event);
    if (!cell) return;
    if (view?.state.readOnly) {
      // 只读预览仍允许浏览器原生框选和复制；在默认聚焦发生前关掉编辑能力
      setCellEditable(cell, false);
      return;
    }
    setCellEditable(cell, true);
    wrap.classList.add("md-table-widget--focused");
    // 不做整列高亮：点一下就把一整列刷上底色，看着像「整列被选中」
    // 在浏览器放置光标之前换成源码文本，否则之后改写 textContent 会把光标打掉
    showCellSource(cell);
    clearCellSelection(wrap);
    dragAnchor = cell;
    dragging = true;
  });

  // 按住拖过多个单元格 = 框选
  wrap.addEventListener("mouseover", (event) => {
    if (!dragging || !dragAnchor) return;
    const cell = cellOf(event);
    if (!cell || cell === dragAnchor) return;
    selectCellRange(wrap, dragAnchor, cell);
  });

  const endDrag = () => {
    dragging = false;
    dragAnchor = null;
  };
  wrap.addEventListener("mouseup", endDrag);
  wrap.addEventListener("mouseleave", endDrag);

  wrap.addEventListener("focusin", (event) => {
    if (viewOf()?.state.readOnly) return;
    wrap.classList.add("md-table-widget--focused");
    const cell = cellOf(event);
    if (cell) showCellSource(cell);
  });

  wrap.addEventListener("focusout", (event) => {
    const cell = cellOf(event);
    const view = viewOf();
    if (cell && view) {
      // 失焦时单元格显示的还是源码，先落到 dataset.raw 再同步
      cell.dataset.raw = cell.textContent ?? "";
      flushSync(wrap, view);
      showCellRendered(cell);
    }
    requestAnimationFrame(() => {
      if (!wrap.contains(document.activeElement)) {
        wrap.classList.remove("md-table-widget--focused");
        closeAllTableMenus();
      }
    });
  });

  wrap.addEventListener("compositionstart", () => {
    composing = true;
  });

  wrap.addEventListener("compositionend", (event) => {
    composing = false;
    const cell = cellOf(event);
    const view = viewOf();
    if (!cell || !view) return;
    cell.dataset.raw = cell.textContent ?? "";
    scheduleSync(wrap, view);
  });

  wrap.addEventListener("input", (event) => {
    if (tableSyncing) return;
    if (viewOf()?.state.readOnly) return;
    // 输入法组合期间同步会打断候选词
    if (composing) return;
    const cell = cellOf(event);
    const view = viewOf();
    if (!cell || !view) return;
    cell.dataset.raw = cell.textContent ?? "";
    scheduleSync(wrap, view);
  });

  wrap.addEventListener("paste", (event) => {
    const cell = cellOf(event);
    const view = viewOf();
    if (!cell || !view) return;
    if (view.state.readOnly) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
    insertCellText(cell, text);
    scheduleSync(wrap, view);
  });

  wrap.addEventListener("keydown", (event) => {
    const cell = cellOf(event);
    if (!cell) return;
    const view = viewOf();
    if (!view) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (view.state.readOnly) {
      // 只读预览仍应保留系统复制能力
      if (mod && key === "c") return;
      event.preventDefault();
      return;
    }

    if (mod) {
      if (key === "c") {
        const text = selectedTextFromTable(wrap);
        if (text !== null) {
          event.preventDefault();
          event.stopPropagation();
          void navigator.clipboard?.writeText(text).catch(() => {});
          return;
        }
      }
      if (key === "a") {
        event.preventDefault();
        event.stopPropagation();
        clearCellSelection(wrap);
        getEditableCells(wrap).forEach((item) => item.classList.add("md-table-cell-selected"));
        window.getSelection()?.removeAllRanges();
        return;
      }
      // 浏览器原生富文本命令会往格子里塞 <b>/<i>/<u>
      if (key === "b" || key === "i" || key === "u") {
        event.preventDefault();
        return;
      }
      // 原生 contenteditable 撤销与文档历史不同步，交给 CodeMirror
      if (key === "z" || key === "y") {
        event.preventDefault();
        flushSync(wrap, view);
        cell.blur();
        view.focus();
        if (key === "y" || event.shiftKey) redo(view);
        else undo(view);
        return;
      }
      // 其余（Ctrl+S 等）放行冒泡到 window，让全局快捷键生效
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      clearCellSelection(wrap);
      exitTableToLineBelow(view, wrap);
      return;
    }

    // 框选状态下的删除：清空选中区域的内容
    if ((event.key === "Backspace" || event.key === "Delete") && selectedCells(wrap).length) {
      event.preventDefault();
      clearSelectedCells(wrap, view);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      flushSync(wrap, view);
      focusAdjacentCell(cell, event.shiftKey);
      return;
    }

    if (event.key === "Enter") {
      if (composing || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      clearCellSelection(wrap);
      insertCellText(cell, "\n");
      scheduleSync(wrap, view);
      return;
    }

    if (event.key === "Backspace" && isCaretAtStart(cell)) {
      event.preventDefault();
      const cells = getEditableCells(wrap);
      if (cells[0] === cell) {
        exitTableToLineAbove(view, wrap);
      } else {
        flushSync(wrap, view);
        focusAdjacentCell(cell, true);
      }
      return;
    }

    if (event.key === "Delete" && isCaretAtEnd(cell)) {
      event.preventDefault();
      const cells = getEditableCells(wrap);
      if (cells[cells.length - 1] === cell) {
        exitTableToLineBelow(view, wrap);
      } else {
        flushSync(wrap, view);
        focusAdjacentCell(cell, false);
      }
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const info = getFocusedCellInfo(wrap);
      if (!info) return;
      const next = event.key === "ArrowUp" ? info.row - 1 : info.row + 1;
      event.preventDefault();
      if (next < 0) {
        exitTableToLineAbove(view, wrap);
      } else if (next >= rowCount(wrap)) {
        exitTableToLineBelow(view, wrap);
      } else {
        flushSync(wrap, view);
        focusCellOnWrap(wrap, next, info.col);
      }
      return;
    }

    // 其它按键交给浏览器原生编辑，不 preventDefault、不阻断冒泡
  });
}

function restorePendingFocus(wrap: HTMLElement, tableFrom: number): void {
  const pending = pendingFocusByTable.get(tableFrom);
  if (!pending) return;
  pendingFocusByTable.delete(tableFrom);
  requestAnimationFrame(() => focusCellOnWrap(wrap, pending.row, pending.col));
}

export class TableWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly header: string[],
    readonly rows: string[][],
    readonly aligns: TableAlign[] = [],
  ) {
    super();
  }

  /**
   * 比较内容与源码长度，位置不参与比较（否则上方一有编辑整张表就重建）；
   * 长度参与比较则保证复用 DOM 时缓存的 blockLen 依然有效。
   */
  eq(other: TableWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.header.join("\0") === this.header.join("\0") &&
      other.rows.map((r) => r.join("\0")).join("\n") ===
        this.rows.map((r) => r.join("\0")).join("\n") &&
      other.aligns.join() === this.aligns.join()
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-table-widget";
    // 不绑「点击进入源码」：点表格空白处应该定位光标，不该翻出 Markdown
    stampBlockRange(wrap, this.from, this.to);
    writeAligns(wrap, this.aligns);

    wrap.appendChild(createToolbar());

    const body = document.createElement("div");
    body.className = "md-table-body";

    const table = document.createElement("table");
    const aligns = [...this.aligns];
    const cols = Math.max(this.header.length, ...this.rows.map((r) => r.length), aligns.length, 1);
    while (aligns.length < cols) aligns.push("left");

    if (this.header.length) {
      const thead = document.createElement("thead");
      const headerTr = document.createElement("tr");
      appendEditableRow(headerTr, this.header, aligns, "th");
      thead.appendChild(headerTr);
      table.appendChild(thead);
    }

    const tbody = document.createElement("tbody");
    for (const row of this.rows) {
      const tr = document.createElement("tr");
      appendEditableRow(tr, row, aligns, "td");
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
    wrap.appendChild(body);
    bindBlockBoundaryCursor(wrap, body);

    attachToolbarEvents(wrap);
    attachCellEvents(wrap);

    restorePendingFocus(wrap, this.from);
    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const ths = dom.querySelectorAll<HTMLElement>("thead th");
    const trs = dom.querySelectorAll<HTMLElement>("tbody tr");
    const aligns = [...this.aligns];
    const cols = Math.max(this.header.length, ...this.rows.map((r) => r.length), aligns.length, 1);
    while (aligns.length < cols) aligns.push("left");

    // 结构真的变了（增删行列）⇒ 交给重建，逐格改 DOM 会把表格停在半新半旧
    const structureMismatch =
      ths.length !== this.header.length ||
      trs.length !== this.rows.length ||
      this.rows.some((row, ri) => trs[ri]?.querySelectorAll("td").length !== row.length);
    if (structureMismatch) return false;

    stampBlockRange(dom, this.from, this.to);
    writeAligns(dom, this.aligns);

    if (dom.contains(document.activeElement)) {
      dom.classList.add("md-table-widget--focused");
    }

    this.header.forEach((text, i) => {
      const th = ths[i];
      if (!th) return;
      // 正在输入的格子由 setCellRaw 那一支处理：只写 textContent（相等就不写），
      // 直接 innerHTML 会把光标打掉
      setCellRaw(th, text, aligns[i] ?? "left");
    });

    this.rows.forEach((row, ri) => {
      const tds = trs[ri]?.querySelectorAll<HTMLElement>("td");
      if (!tds) return;
      row.forEach((text, ci) => {
        const td = tds[ci];
        if (!td) return;
        setCellRaw(td, text, aligns[ci] ?? "left");
      });
    });

    restorePendingFocus(dom, this.from);
    return true;
  }

  /**
   * 格子里的所有事件都由 attachCellEvents 自理，CodeMirror 一律不插手：
   * 返回 false 会让 CM 对按键调用 preventDefault，原生输入就被吃掉了。
   * 例外是点在外层留白上 —— 交还给编辑器用于定位光标。
   */
  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-table-widget");
  }
}
