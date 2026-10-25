/**
 * B389 · 侧栏搜索视图（「在文件中查找」那一块，键位归 `shell/keymap` 的 `edit.findInFiles`）。
 *
 * 只做四件事：把输入区那几格与模型层**接上**（改的是模型，不在这里存第二份状态）、
 * 把结果树画出来、把「点一条命中」转成一次跳转、以及把那颗按钮列的键**装上点击**。
 * **不搜、不判范围、不算文案** —— 那些在 `./store.ts`；**不写盘、不改文档** —— 那些在
 * `./replace.ts`。视图再判一遍就是两套口径（B304 那一族的教训）。
 *
 * 结构与几何逐条照 VS Code 的搜索视图（`searchView.ts` 的 renderBody + `searchview.css`）：
 * 标题栏 → 搜索行（左缘那根 16px 的展开替换键）→ 替换行 → `.query-details`（⋯ + 两行 glob）
 * → 计数行 → 结果树。行内开关复用悬浮查找栏那一套（`.find-field` / `.find-toggle`），
 * 于是「同一族控件在两个地方长得不一样」这件事从一开始就不成立。
 *
 * ⚠️ 那颗按钮列的键的点击**必须在这里挂**：`registerDrawerView` 只管「显隐与亮灭怎么算」，
 *    不接管点击（B314-8 真机抓到过：漏一句就是一颗看着正常、点下去毫无反应的死键）。
 */
import { panels, windowKind, type Tab } from "../core/app-state";
import { activePanel, instancesOfDoc } from "../core/panels";
import { detectLanguage } from "../editor/language";
import { doOpen } from "../io/files";
import { switchTab } from "../tabs";
import {
  searchCase,
  searchClear,
  searchCollapseAll,
  searchCount,
  searchDetails,
  searchDetailsToggle,
  searchExclude,
  searchInclude,
  searchInput,
  searchPanel,
  searchRefresh,
  searchReplaceAll,
  searchReplaceInput,
  searchReplaceRow,
  searchRegex,
  searchResults,
  searchStop,
  searchToggleReplace,
  searchWord,
  sideSearch,
} from "../ui";
import { applySidebarVisible, isSidebarOff, refreshTocAtCursor } from "../toc";
import { CODICONS } from "../shell/codicons";
import { fileIconHtml } from "../shell/fileicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
import { setTextTip } from "../shell/tooltip";
import { EditorView } from "@codemirror/view";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  cancel,
  clearAll,
  collapseAll,
  emptyMessage,
  expandAll,
  getGroups,
  getQuery,
  isCollapsed,
  isInvalid,
  isRunning,
  onSearchChange,
  planReplace,
  runNow,
  scopeNote,
  setQuery,
  summaryMessage,
  isBadNews,
  toggleFile,
  type FileGroup,
} from "./store";
import { applyReplaceAll, replaceOutcomeText, type ReplaceOutcome } from "./replace";
import type { SearchMatchRow } from "../ipc/api";

/** 替换行开没开。**视图自己的状态**：它既不影响搜索结果，也不该落到设置里
 *  （VS Code 也不存 —— 那边是 `SearchWidget` 的一次性状态）。 */
let replaceShown = false;
/** 最后一次点过的那一行（结果树里的选中态）；按路径 + 行号认，重绘之后仍能指回同一行。 */
let selected: { path: string; line: number } | null = null;
/** 正在替换：那一发是异步的，期间把「全部替换」键压住，免得连点成两遍。 */
let replacing = false;

// ---------------------------------------------------------------- 装配

export function setupSearch(): void {
  sideSearch.innerHTML = CODICONS.searchLarge;
  searchToggleReplace.innerHTML = CODICONS.chevronRight;
  searchCase.innerHTML = CODICONS.caseSensitive;
  searchWord.innerHTML = CODICONS.wholeWord;
  searchRegex.innerHTML = CODICONS.regex;
  searchReplaceAll.innerHTML = CODICONS.replaceAll;
  searchDetailsToggle.innerHTML = CODICONS.ellipsis;
  searchRefresh.innerHTML = CODICONS.refresh;
  searchCollapseAll.innerHTML = CODICONS.collapseAll;
  searchClear.innerHTML = CODICONS.clearAll;
  searchStop.innerHTML = CODICONS.searchStop;

  registerDrawerView("search", {
    panel: searchPanel,
    button: sideSearch,
    onShow: () => {
      render();
      searchInput.focus();
      searchInput.select();
    },
  });
  // ⚠️ 这一句就是 B314-8 那条教训的本体：登记视图 ≠ 挂按钮。
  sideSearch.addEventListener("click", () => toggleSearch());

  searchInput.addEventListener("input", () => setQuery({ text: searchInput.value }));
  searchInput.addEventListener("keydown", (e) => {
    // 回车 = 立刻搜（与输入即搜那 300ms 去抖是两条路：用户按下回车时不打算再等一截）
    if (e.key === "Enter") {
      e.preventDefault();
      void runNow();
    }
  });
  searchCase.addEventListener("click", () =>
    setQuery({ caseSensitive: !getQuery().caseSensitive }),
  );
  searchWord.addEventListener("click", () => setQuery({ wholeWord: !getQuery().wholeWord }));
  searchRegex.addEventListener("click", () => setQuery({ regexp: !getQuery().regexp }));

  searchReplaceInput.addEventListener("input", () =>
    setQuery({ replaceText: searchReplaceInput.value }),
  );
  searchReplaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void replaceAll();
    }
  });
  searchToggleReplace.addEventListener("click", () => setReplaceShown(!replaceShown));
  searchDetailsToggle.addEventListener("click", () =>
    setQuery({ detailsOpen: !getQuery().detailsOpen }),
  );
  searchInclude.addEventListener("input", () => setQuery({ include: searchInclude.value }));
  searchExclude.addEventListener("input", () => setQuery({ exclude: searchExclude.value }));
  searchRefresh.addEventListener("click", () => void runNow());
  searchStop.addEventListener("click", () => cancel());
  searchClear.addEventListener("click", () => {
    clearAll();
    selected = null;
  });
  searchCollapseAll.addEventListener("click", () => {
    if (allCollapsed()) expandAll();
    else collapseAll();
  });
  searchReplaceAll.addEventListener("click", () => void replaceAll());
  searchResults.addEventListener("click", (e) => onTreeClick(e as MouseEvent));
  onSearchChange(render);
  render();
}

// ---------------------------------------------------------------- 开合

/** 摊开 / 收起搜索这一块（按钮列那颗 / 命令面板那一路都走这里）。 */
export function toggleSearch(): void {
  if (windowKind === "satellite") return;
  if (activeDrawer() === "search") {
    setDrawer(null);
    return;
  }
  // 整栏收着时先把它放出来（口径同 `toggleToc` 的 B198：藏在 display:none 里切显隐＝死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("search");
}

/**
 * 从命令 / 快捷键摊开搜索，并把当前选区灌进去（VS Code `workbench.action.findInFiles`
 * 的手感：按下去就已经把要搜的那词填好了）。框里已经有字时**不覆盖** —— 用户再按一次
 * 通常只是想回到那个面板，不是想丢掉刚打的那串。
 *
 * `showReplace` 那一档是「在文件中替换」（VS Code `workbench.action.replaceInFiles`）：
 * 同一个面板，只是顺手把替换行掀开、焦点交给替换框 —— 另起一块面板就是两套口径了。
 */
export function openSearchView(showReplace = false): void {
  if (windowKind === "satellite") return;
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("search");
  if (showReplace) {
    setReplaceShown(true);
    searchReplaceInput.focus();
  }
  const seed = selectedTextInActiveView();
  if (seed && !searchInput.value) {
    setQuery({ text: seed });
    // 改的是模型，框里那句要跟着画出来：`setQuery` 只排了去抖，等它跑完已经是 300ms 之后，
    // 用户按下快捷键看见的是一个**空框**。
    render();
  }
}

/** 活动视图选中的文本（单行且非空才作为种子；口径同 `find/findbar.ts`）。 */
function selectedTextInActiveView(): string {
  const view = activePanel()?.view?.view;
  if (!view) return "";
  const sel = view.state.selection.main;
  if (sel.empty) return "";
  const text = view.state.sliceDoc(sel.from, sel.to);
  return text.includes("\n") ? "" : text;
}

function setReplaceShown(on: boolean): void {
  replaceShown = on;
  searchReplaceRow.hidden = !on;
  searchPanel.classList.toggle("is-replace-shown", on);
  searchToggleReplace.innerHTML = on ? CODICONS.chevronDown : CODICONS.chevronRight;
  const label = on ? "折叠替换" : "展开替换";
  searchToggleReplace.setAttribute("aria-label", label);
  searchToggleReplace.setAttribute("data-tip", label);
  searchToggleReplace.setAttribute("aria-expanded", String(on));
}

// ---------------------------------------------------------------- 重绘

/** 全量键当前会做哪一支（一条结果都没有时算「没折着」，与大纲那颗同口径）。 */
function allCollapsed(): boolean {
  const groups = getGroups();
  return groups.length > 0 && groups.every((g) => isCollapsed(g.path));
}

/** 把模型里的状态搬到控件上：三档亮灭、⋯ 开合、两行 glob、计数行、取消键、非法标红。 */
function syncControls(): void {
  const q = getQuery();
  syncToggle(searchCase, q.caseSensitive);
  syncToggle(searchWord, q.wholeWord);
  syncToggle(searchRegex, q.regexp);
  // ⚠️ 只在值真的不一样时才回写：`input` 事件里刚把用户的字送进模型，
  //    这里无差别再写一遍会把光标弹到串首（打字的每一个键都会弹）。
  if (searchInput.value !== q.text) searchInput.value = q.text;
  if (searchReplaceInput.value !== q.replaceText) searchReplaceInput.value = q.replaceText;
  if (searchInclude.value !== q.include) searchInclude.value = q.include;
  if (searchExclude.value !== q.exclude) searchExclude.value = q.exclude;
  searchDetails.classList.toggle("is-more", q.detailsOpen);
  searchDetailsToggle.setAttribute("aria-expanded", String(q.detailsOpen));

  const bad = isInvalid();
  searchInput.closest(".search-field")?.classList.toggle("is-invalid", bad);
  searchRegex.classList.toggle("is-bad", bad);
  searchStop.hidden = !isRunning();
  searchReplaceAll.disabled = replacing || getGroups().length === 0;

  const folded = allCollapsed();
  searchCollapseAll.innerHTML = folded ? CODICONS.expandAll : CODICONS.collapseAll;
  const foldLabel = folded ? "全部展开" : "全部折叠";
  searchCollapseAll.setAttribute("aria-label", foldLabel);
  searchCollapseAll.setAttribute("data-tip", foldLabel);
  searchCollapseAll.setAttribute("aria-pressed", String(folded));

  const summary = summaryMessage();
  searchCount.textContent = summary;
  // 计数行只在「说坏消息」时变红：非法正则与后端报错（`summaryMessage` 把原话放在这一格）
  searchCount.classList.toggle("is-bad", isBadNews());
}

function syncToggle(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
}

/** 整块重绘：计数行 + 结果树。⚠️ 标题栏是静态结构，这里只动 `#search-results`（B205 那条）。 */
function render(): void {
  syncControls();
  const groups = getGroups();
  // 说明行只有两种话要说：范围（没打开文件夹时那一截，**有结果也要说** —— 用户口径第一条），
  // 以及一条都没有时的引导。它排在结果**之上**（VS Code 的 `.message` 也在 results 前面），
  // 且计数行已经念过「未找到结果。」，这里不重复（B304 那一族）。
  const note = groups.length === 0 ? emptyMessage() : scopeNote();
  const rows = groups.map(fileRow);
  if (note) {
    const el = document.createElement("div");
    el.className = "search-note";
    el.textContent = note;
    searchResults.replaceChildren(el, ...rows);
    return;
  }
  searchResults.replaceChildren(...rows);
}

/** 文件行：箭头槽 + Seti 图标 + 名字 + 灰字路径 + 命中数。一律 `textContent`（文件名里可以有 `<`）。 */
function fileRow(group: FileGroup): DocumentFragment {
  const frag = document.createDocumentFragment();
  const collapsed = isCollapsed(group.path);

  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-file";
  row.dataset.path = group.path;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-expanded", String(!collapsed));
  row.setAttribute("aria-selected", String(selected?.path === group.path && selected.line === 0));
  const twisty = document.createElement("span");
  twisty.className = "search-twisty";
  twisty.innerHTML = collapsed ? CODICONS.chevronRight : CODICONS.chevronDown;
  const glyph = document.createElement("span");
  glyph.className = "search-glyph";
  glyph.innerHTML = fileIconHtml(detectLanguage(group.name).label);
  const name = document.createElement("span");
  name.className = "search-filename";
  name.textContent = group.name;
  const rel = document.createElement("span");
  rel.className = "search-rel";
  rel.textContent = group.rel === group.name ? "" : group.rel;
  const badge = document.createElement("span");
  badge.className = "search-badge";
  badge.textContent = `${group.rows.length}${group.truncated ? "…" : ""}`;
  row.append(twisty, glyph, name, rel, badge);
  setTextTip(row, group.path);

  frag.append(row);
  const kids = document.createElement("div");
  kids.className = "search-lines";
  kids.setAttribute("role", "group");
  kids.hidden = collapsed;
  for (const m of group.rows) kids.append(lineRow(group, m));
  frag.append(kids);
  return frag;
}

/** 一行命中：行号 + 「前 / 命中 / 后」三段（`start` / `length` 是预览里的**字符**下标）。 */
function lineRow(group: FileGroup, m: SearchMatchRow): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-line";
  row.dataset.path = group.path;
  row.dataset.line = String(m.line);
  row.dataset.column = String(m.column);
  row.dataset.length = String(m.length);
  row.setAttribute("role", "treeitem");
  row.setAttribute(
    "aria-selected",
    String(selected?.path === group.path && selected?.line === m.line),
  );
  const num = document.createElement("span");
  num.className = "search-linenum";
  num.textContent = String(m.line);
  const chars = Array.from(m.preview);
  const text = document.createElement("span");
  text.className = "search-linetext";
  const before = document.createElement("span");
  before.textContent = chars.slice(0, m.start).join("");
  const hit = document.createElement("span");
  hit.className = "search-hit";
  hit.textContent = chars.slice(m.start, m.start + m.length).join("");
  const after = document.createElement("span");
  after.textContent = chars.slice(m.start + m.length).join("");
  text.append(before, hit, after);
  row.append(num, text);
  setTextTip(row, `${group.path}:${m.line}`);
  return row;
}

// ---------------------------------------------------------------- 跳转

/** 结果树里的一下点击：文件行 = 折 / 展；命中行 = 选中并跳过去。 */
function onTreeClick(e: MouseEvent): void {
  const line = (e.target as Element).closest?.(".search-line") as HTMLElement | null;
  if (line) {
    void jumpToLine(line);
    return;
  }
  const file = (e.target as Element).closest?.(".search-file") as HTMLElement | null;
  if (file?.dataset.path) {
    selected = { path: file.dataset.path, line: 0 };
    toggleFile(file.dataset.path);
  }
}

/**
 * 跳一条命中：开着的文档直接切过去并选中；没开的先 `doOpen`（与资源管理器、拖放、
 * 最近打开同一扇漏斗 ⇒ 「最近打开」的记入自动跟着生效，不必这里再报一发）。
 */
async function jumpToLine(el: HTMLElement): Promise<void> {
  const path = el.dataset.path ?? "";
  const line = Number(el.dataset.line);
  const column = Number(el.dataset.column);
  const length = Number(el.dataset.length);
  const group = getGroups().find((g) => g.path === path);
  if (!group || !Number.isFinite(line) || line < 1) return;
  selected = { path, line };
  // 正开着的走 `docId`；盘上那条要先把文件开出来（`doOpen` 回的是文档 id，不是实例 id）
  const docId = group.docId ?? (await doOpen(path));
  if (docId === null || docId === undefined) return;
  const inst = instancesOfDoc(docId)[0];
  if (!inst) return;
  switchTab(inst.panelId, inst.tabId);
  reveal(inst, line, column, length);
  render();
}

/**
 * 把落点摆到命中本身。
 * ⚠️ 用的是 `column`（整行里的字符列号）而不是 `start`（预览里的下标）：预览带着上下文
 *    一起裁过、还补了一个省略号格，按 `start` 摆会偏掉整整一截上下文长度。
 * ⚠️ 字符下标要换成 CodeMirror 的 UTF-16 单元数，中文与 emoji 都不能按字符数直接摆。
 */
function reveal(inst: Tab, line: number, column: number, length: number): void {
  const doc = inst.state.doc;
  const info = doc.line(Math.min(Math.max(1, line), doc.lines));
  const from = info.from + units(info.text, 0, column - 1);
  const to = from + units(info.text, column - 1, column - 1 + length);
  const panel = panels.get(inst.panelId);
  if (panel?.view && panel.viewTabId === inst.tabId) {
    panel.view.view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    inst.state = panel.view.view.state;
  } else {
    inst.state = inst.state.update({ selection: { anchor: from, head: to } }).state;
  }
  activePanel()?.view?.focus();
  // 大纲跟着光标那一节走（B388）：这一跳改了选区，补同一发上报，否则切过去大纲还指着旧那节
  refreshTocAtCursor(info.number);
}

/** 字符下标区间 → UTF-16 单元数。 */
function units(text: string, from: number, to: number): number {
  return Array.from(text).slice(from, to).join("").length;
}

// ---------------------------------------------------------------- 替换

/**
 * 全部替换：先确认（这一发会动盘上的文件，且**不可撤销** —— 编辑器里的撤销栈管不到
 * 没打开的那些），再交给 `./replace.ts`，最后重跑一次搜索。
 *
 * ⚠️ 重跑是必须的：不换就等于把「已替换」的旧结果继续列给用户看，而那一屏已经假了。
 * ⚠️ 次序也是必须的：重跑会 notify → 重绘 → 计数行换回「在 N 个文件中发现 M 个结果」，
 *    所以「已替换几处」要在它**之后**才写。先写就等于永远没人看得见那句话
 *    （而那一发到底是做成了还是失败了，用户只剩猜）。
 */
async function replaceAll(): Promise<void> {
  const q = getQuery();
  if (!q.text || replacing) return;
  const plan = planReplace();
  if (plan.files === 0) return;
  const where = plan.diskFiles.length
    ? `其中 ${plan.diskFiles.length} 个没开在标签里：会被直接写盘，且改完不可撤销。`
    : "这些都开在标签里：只改内存，落盘仍由各自的保存流程决定。";
  const ok = await ask(`将在 ${plan.files} 个文件的 ${plan.lines} 行里替换全部匹配。\n${where}`, {
    title: "全部替换",
    kind: "warning",
    okLabel: "替换",
    cancelLabel: "取消",
  });
  if (!ok) return;
  replacing = true;
  syncControls();
  let out: ReplaceOutcome | null = null;
  let failure = "";
  try {
    out = await applyReplaceAll(plan, q);
  } catch (e: unknown) {
    failure = e instanceof Error ? e.message : String(e);
  }
  replacing = false;
  await runNow();
  searchCount.textContent = out ? replaceOutcomeText(out) : failure;
  searchCount.classList.toggle("is-bad", out ? out.errors.length > 0 : true);
}
