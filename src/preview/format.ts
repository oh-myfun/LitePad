// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/commands/format.ts:64-465（纯文本那一半）
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-4d · 编辑模式的格式动作与键位。InkNote 把 `editorActionKeymap()` 装在整个编辑器上
// （editor.ts:1404），源码档也生效 —— 它只编辑 Markdown。LitePad 的标签可能是 .json/.py，
// `Ctrl+B` 往 JSON 里塞 `****` 是破坏，所以这批扩展挂在**语言档**里：只有 Markdown 文档
// 带着它（见 src/editor/language.ts 的 markdown 分支）。
//
// 与 InkNote 的有意差异：
// 1. **没有菜单/桥**：它经由 Tauri 原生菜单调 `runEditorAction`；LitePad 侧先只做键位，
//    `runFormat` 是同一个入口，将来加「格式」菜单不用再改这里。
// 2. **不搬的键**：
//    · `Mod-0`（正文）—— 与应用的 `Ctrl+0`（重置字号）撞，全局捕获先拿走；
//    · `Mod-k` / `Mod-Shift-i`（链接 / 图片）—— 它们的弹窗（editorPickLink / editorPickImage）
//      LitePad 没有对应物；
//    · `Mod-Shift-8 / 7 / \``（列表 / 行内代码）—— CM6 的键名匹配按 `event.key` 归一
//      （@codemirror/view 的 `modifiers(name, event, !isChar)`）：Shift+8 出来的字符是 `*`，
//      `"Mod-Shift-8"` 这条**永远匹配不上**（InkNote 自己那几条是哑键）。行内代码改由
//      `wrapInline` 的调用方决定，列表动作先留给菜单。
import { markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { extractToc } from "../markdown/pipeline";
import { showImageDialog } from "../shell/imagedialog";
import { showLinkDialog } from "../shell/linkdialog";
import { focusBlockStartingAt } from "./editableSource";
import { serializeTable } from "./tableData";

const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const TASK_RE = /^(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/;
const QUOTE_RE = /^>\s?/;

/** 选区两侧补标记；三种「已经是这个标记」的形态都认，再按一次就摘掉。 */
export function wrapInline(view: EditorView, before: string, after: string): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  // 选区自身带标记：**词** → 词
  if (
    selected.length >= before.length + after.length &&
    selected.startsWith(before) &&
    selected.endsWith(after)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
      userEvent: "input.format",
    });
    view.focus();
    return true;
  }

  // 标记在选区外侧：选中 **词** 中间的「词」时也应能取消
  const outerFrom = from - before.length;
  const outerTo = to + after.length;
  if (
    outerFrom >= 0 &&
    outerTo <= state.doc.length &&
    state.sliceDoc(outerFrom, from) === before &&
    state.sliceDoc(to, outerTo) === after
  ) {
    view.dispatch({
      changes: [
        { from: outerFrom, to: from, insert: "" },
        { from: to, to: outerTo, insert: "" },
      ],
      selection: { anchor: outerFrom, head: outerFrom + selected.length },
      userEvent: "input.format",
    });
    view.focus();
    return true;
  }

  const insert = `${before}${selected}${after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** 拆出缩进与正文：缩进必须保留，否则嵌套列表会被拉平到顶层 */
function stripBlockPrefix(text: string): { indent: string; content: string } {
  const indent = /^\s*/.exec(text)?.[0] ?? "";
  let rest = text.slice(indent.length);
  rest = rest.replace(QUOTE_RE, "");
  rest = rest.replace(HEADING_RE, "");
  rest = rest.replace(TASK_RE, "");
  rest = rest.replace(BULLET_RE, "");
  rest = rest.replace(ORDERED_RE, "");
  return { indent, content: rest };
}

/** 选区覆盖的所有行（块级命令应作用于整个选区，而不是首行） */
function selectedLines(state: EditorView["state"]) {
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const lines = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  return lines;
}

export function toggleLinePrefix(
  view: EditorView,
  prefix: string,
  active: RegExp,
  numbered = false,
): boolean {
  const { state } = view;
  const lines = selectedLines(state).filter((l) => l.text.trim().length > 0);
  if (!lines.length) {
    const line = state.doc.lineAt(state.selection.main.from);
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `${prefix}` },
      selection: { anchor: line.from + prefix.length },
      userEvent: "input.format",
    });
    view.focus();
    return true;
  }

  const allActive = lines.every((l) => active.test(l.text.trimStart()));
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  lines.forEach((line, i) => {
    const { indent, content } = stripBlockPrefix(line.text);
    const marker = numbered ? `${i + 1}. ` : prefix;
    const next = allActive ? `${indent}${content}` : `${indent}${marker}${content}`;
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  });

  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
  return true;
}

export function setHeading(view: EditorView, level: number): boolean {
  const { state } = view;
  const lines = selectedLines(state).filter((l) => l.text.trim().length > 0);
  if (!lines.length) return true;

  const marker = level > 0 ? `${"#".repeat(level)} ` : "";
  const allSame =
    level > 0 && lines.every((l) => new RegExp(`^#{${level}}\\s+`).test(l.text.trimStart()));

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const line of lines) {
    const { indent, content } = stripBlockPrefix(line.text);
    const next = allSame || level === 0 ? `${indent}${content}` : `${indent}${marker}${content}`;
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }

  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
  return true;
}

function insertBlock(view: EditorView, text: string, cursorOffset?: number): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const prefix = line.text.length > 0 ? "\n\n" : "";
  const insert = `${prefix}${text}`;
  const at = line.to;
  view.dispatch({
    changes: { from: at, insert },
    selection: {
      anchor: at + insert.length + (cursorOffset ?? 0),
      head: at + insert.length + (cursorOffset ?? 0),
    },
  });
  view.focus();
  return true;
}

/** 在当前行下方插入一张空表，并把焦点交给第一格（照 InkNote 的 RAF×2）。 */
export function insertTableAtCursor(view: EditorView, rows: number, cols: number): boolean {
  const r = Math.max(1, rows);
  const c = Math.max(1, cols);
  const header = Array(c).fill("") as string[];
  const body = Array.from({ length: Math.max(0, r - 1) }, () => Array(c).fill("") as string[]);
  const text = serializeTable(header, body);

  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const prefix = line.text.length > 0 ? "\n\n" : "";
  const insert = `${prefix}${text}`;
  const at = line.to;
  const tableFrom = at + prefix.length;
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
  });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      focusBlockStartingAt(view, tableFrom);
    });
  });
  return true;
}

/**
 * B431 · 把当前文档的标题抽成 Markdown 目录（照 InkNote `buildMarkdownToc`）。
 * 层级按最小标题级别归一；锚点 id 与渲染侧同一个 `extractToc`，点目录能落到位。
 */
export function buildMarkdownToc(src: string): string {
  const items = extractToc(src);
  if (!items.length) return "";
  const minLevel = Math.min(...items.map((item) => item.level));
  return items
    .map(
      (item) => `${"  ".repeat(Math.max(0, item.level - minLevel))}- [${item.text}](#${item.id})`,
    )
    .join("\n");
}

export interface LinkPick {
  text: string;
  url: string;
}

export interface ImagePick {
  alt: string;
  path: string;
}

export type LinkPicker = (selected: string) => Promise<LinkPick | null>;
export type ImagePicker = (selected: string) => Promise<ImagePick | null>;

async function pickLinkWithDialog(selected: string): Promise<LinkPick | null> {
  return showLinkDialog(selected);
}

async function pickImageWithDialog(selected: string): Promise<ImagePick | null> {
  return showImageDialog({ alt: selected, path: "", title: "插入图片" });
}

function insertInlineAtSelection(view: EditorView, insert: string): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.format",
  });
  view.focus();
}

/** B431 · 链接插入（工具条与将来的键位共用；picker 可注入便于测试）。 */
export async function insertLinkAtCursor(
  view: EditorView,
  pick: LinkPicker = pickLinkWithDialog,
): Promise<boolean> {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const result = await pick(selected);
  const url = result?.url.trim() ?? "";
  if (!url) return false;
  const text = result?.text.trim() || url;
  insertInlineAtSelection(view, `[${text}](${url})`);
  return true;
}

/** B431 · 图片插入。 */
export async function insertImageAtCursor(
  view: EditorView,
  pick: ImagePicker = pickImageWithDialog,
): Promise<boolean> {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const result = await pick(selected);
  const path = result?.path.trim() ?? "";
  if (!path) return false;
  insertInlineAtSelection(view, `![${result?.alt ?? ""}](${path})`);
  return true;
}

/**
 * B448 · Markdown 的一级缩进 = **两个空格**。
 * 与 `buildMarkdownToc` 的 `"  ".repeat(level)`、大纲侧的 `Math.floor(indent / 2)` 同一口径；
 * 换一档会让工具条缩出来的列表在大纲里少一层。
 * ⚠️ 与编辑器 Tab 不是一回事：那边吃 CM6 的 `indentUnit`（本应用设成 4 空格，
 * 见 `src/editor/editor.ts`），所以这两颗**不带** Tab / Shift+Tab 的键位提示。
 */
const INDENT_UNIT = "  ";

/** 退一级：最多吃掉两个前导空格；制表符缩进按一级算，不留半个。 */
function stripOneIndent(text: string): string {
  const m = /^( {1,2}|\t)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * B448 · 选区跨的各行一起进 / 退一级缩进（列表嵌套与目录层级都靠它）。
 * 空行不参与：缩进空行在 Markdown 里没有意义，只会把行尾空白写进文件。
 */
export function shiftIndent(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const lines = selectedLines(state).filter((l) => l.text.trim().length > 0);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const line of lines) {
    const next = dir > 0 ? `${INDENT_UNIT}${line.text}` : stripOneIndent(line.text);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
  return true;
}

/**
 * B450 · 脚注：光标处插一条引用 `[^n]`，文末补一行定义 `[^n]: `，光标落在定义里等打字。
 *
 * 编号取「已用过的最大编号 + 1」再跳过撞名（`[^1]` 与 `[^bignote]` 混着写的文档很常见，
 * 只按个数排会把已有那条盖掉）。分隔按文末那一段的真实情况给：已经空了一行就不再空。
 *
 * ⚠️ 光标正好在文末时，引用与定义两段是**相邻**的：分成两发 change 会在同一位置上重叠，
 * CM6 直接抛 ⇒ 那一支合成一发写。
 */
export function insertFootnote(view: EditorView): boolean {
  const { state } = view;
  const doc = state.doc.toString();
  const tail = state.doc.length;
  const used = new Set<string>();
  for (const m of doc.matchAll(/\[\^([^\]\n]+)\]/g)) used.add(m[1]);
  let n = used.size + 1;
  while (used.has(String(n))) n++;
  const label = String(n);
  const ref = `[^${label}]`;
  const { from, to } = state.selection.main;
  const before = to === tail ? doc.slice(0, from) + ref : doc;
  const sep = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const def = `${sep}[^${label}]: `;
  const changes =
    to === tail
      ? [{ from, to, insert: ref + def }]
      : [
          { from, to, insert: ref },
          { from: tail, insert: def },
        ];
  // 选区/光标吃**新文档**的坐标：定义就是文末那一段，光标停在它末尾
  const caret = tail - (to - from) + ref.length + def.length;
  view.dispatch({ changes, selection: { anchor: caret }, userEvent: "input.format" });
  view.focus();
  return true;
}

export type FormatAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inlineCode"
  | "highlight"
  | "underline"
  | "superscript"
  | "subscript"
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "indent"
  | "outdent"
  | "hr"
  | "codeBlock"
  | "toc"
  | "mathBlock"
  | "mermaid"
  | "table"
  | "footnote";

/** 菜单/键位/将来的工具栏共用的唯一入口（对照 InkNote 的 `runEditorAction`）。 */
export function runFormat(view: EditorView, action: FormatAction): boolean {
  switch (action) {
    case "bold":
      return wrapInline(view, "**", "**");
    case "italic":
      return wrapInline(view, "*", "*");
    case "strikethrough":
      return wrapInline(view, "~~", "~~");
    case "inlineCode":
      return wrapInline(view, "`", "`");
    case "highlight":
      return wrapInline(view, "==", "==");
    case "underline":
      return wrapInline(view, "<u>", "</u>");
    case "superscript":
      return wrapInline(view, "<sup>", "</sup>");
    case "subscript":
      return wrapInline(view, "<sub>", "</sub>");
    case "paragraph":
      return setHeading(view, 0);
    case "heading1":
      return setHeading(view, 1);
    case "heading2":
      return setHeading(view, 2);
    case "heading3":
      return setHeading(view, 3);
    case "heading4":
      return setHeading(view, 4);
    case "heading5":
      return setHeading(view, 5);
    case "heading6":
      return setHeading(view, 6);
    case "bulletList":
      return toggleLinePrefix(view, "- ", BULLET_RE);
    case "orderedList":
      return toggleLinePrefix(view, "1. ", ORDERED_RE, true);
    case "taskList":
      return toggleLinePrefix(view, "- [ ] ", TASK_RE);
    case "blockquote":
      return toggleLinePrefix(view, "> ", QUOTE_RE);
    case "indent":
      return shiftIndent(view, 1);
    case "outdent":
      return shiftIndent(view, -1);
    case "hr":
      return insertBlock(view, "---");
    case "codeBlock":
      return insertBlock(view, "```\n\n```", -4);
    case "toc": {
      const toc = buildMarkdownToc(view.state.doc.toString());
      return toc ? insertBlock(view, toc) : false;
    }
    case "mathBlock":
      return insertBlock(view, "$$\n\n$$", -3);
    case "mermaid":
      return insertBlock(view, "```mermaid\ngraph TD\n  A --> B\n```", -4);
    case "table":
      return insertTableAtCursor(view, 2, 2);
    case "footnote":
      return insertFootnote(view);
    default:
      return false;
  }
}

/** 选中文本后按这些字符直接包裹（Typora 习惯），光标态不做自动配对 */
const WRAP_CHARS: Record<string, string> = {
  "*": "*",
  _: "_",
  "`": "`",
  "~": "~",
  "=": "=",
  '"': '"',
  "'": "'",
};

/**
 * 仅在存在选区时包裹，光标态交给默认输入。
 *
 * 之所以不对光标态做配对：`don't` 会变成 `don't'`、`2 * 3` 会变成 `2 ** 3`、
 * `snake_case` 会变成 `snake_case_`，这些在 Markdown 里都是高频输入。
 */
function wrapSelection(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (from === to) return false;
    const close = WRAP_CHARS[text];
    if (!close) return false;

    view.dispatch({
      changes: [
        { from, insert: text },
        { from: to, insert: close },
      ],
      selection: { anchor: from + text.length, head: to + text.length },
      userEvent: "input.type",
    });
    return true;
  });
}

/** Markdown 档的格式扩展：键位 + 选中包裹 + 括号集合（引号不配对，照 InkNote）。 */
export function markdownFormatExtensions(): Extension {
  return [
    // 引号从配对集合里移除，避免英文缩写被打断（LitePad 基础档用的是 CM 缺省全集合）
    markdownLanguage.data.of({
      closeBrackets: { brackets: ["(", "[", "{"] },
    }),
    wrapSelection(),
    keymap.of([
      { key: "Mod-b", run: (v) => runFormat(v, "bold"), preventDefault: true },
      { key: "Mod-i", run: (v) => runFormat(v, "italic"), preventDefault: true },
      { key: "Mod-1", run: (v) => runFormat(v, "heading1"), preventDefault: true },
      { key: "Mod-2", run: (v) => runFormat(v, "heading2"), preventDefault: true },
      { key: "Mod-3", run: (v) => runFormat(v, "heading3"), preventDefault: true },
      { key: "Mod-4", run: (v) => runFormat(v, "heading4"), preventDefault: true },
      { key: "Mod-5", run: (v) => runFormat(v, "heading5"), preventDefault: true },
      { key: "Mod-6", run: (v) => runFormat(v, "heading6"), preventDefault: true },
      { key: "Mod-Shift-x", run: (v) => runFormat(v, "taskList"), preventDefault: true },
      { key: "Mod-Shift-q", run: (v) => runFormat(v, "blockquote"), preventDefault: true },
      { key: "Mod-Shift-k", run: (v) => runFormat(v, "codeBlock"), preventDefault: true },
      { key: "Mod-Shift-m", run: (v) => runFormat(v, "mathBlock"), preventDefault: true },
      { key: "Mod-t", run: (v) => runFormat(v, "table"), preventDefault: true },
    ]),
  ];
}
