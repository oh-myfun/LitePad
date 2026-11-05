// B431 · 编辑态的格式工具条（照 InkNote 的「段落 / 格式」两份菜单）· B447 起分五组带折叠。
//
// 位置与展开由 markdown.ts 的 `.md-preview-bar` 负责：预览档只露那颗切换键，
// 编辑档把 `.md-preview-tools` 从键右侧展开（两档的显隐都走 CSS，见 preview.css）。
//
// 排布（B447，用户在方案 A/B/C 里选定的 **B · 中折**；B448 段落组加缩进两颗；
// B450 插入组加脚注一颗）：
//   历史 3 │ 模式切换 1 │ 段落 7 │ 插入 6 │ 格式 4 = 可见 21 颗。
//   折叠只折两类：① 一眼同类型的成对项（三种列表 / 上下标），② 低频的块级插入
//   （公式 + Mermaid）。下拉复用 `heading` 那套 `showPopupMenu`，子项各带字形。
//
// 动作全部走 `runFormat`（与 Ctrl+B / 菜单同一入口）；链接与图片需要弹窗，
// picker 可注入 —— 单测不弹真窗，真机走 showLinkDialog / showImageDialog。
// 撤销 / 恢复 / 保存三颗归**命令层**，由调用方经 deps 注入（工具条不反向 import
// `../commands`），可用态另由 `historyToolbarState` + `syncFormatToolbarState` 刷。
//
// 有意不搬的两项（各有承接方）：
//   · InkNote「表格编辑」子菜单 —— LitePad 的表格自带行/列/对齐工具条；
//   · 「复制 HTML」—— 剪贴板动作，不属于 Markdown 段落/格式插入。
//
// 图标（B446 定两轨、B448 定笔形、B450 扩册）：默认走 `CODICONS.<name>`（官方字体字形，16 网格，
// 与全应用同一口径）；codicon 里真没有的八枚（公式 / 下划线 / 上标 / 下标 / Mermaid 流程图 /
// 增加缩进 / 减少缩进 / 脚注）走 `shell/toolbarMarks.ts` 里按同笔补画的标记 —— 用户点名要真形，
// 不要再拿 `#` / `ab` / 层级图当替身。B431/B432 那套 Vditor SVG sprite 仍算已退场（整套搬 ≠ 补缺口）。
// 镜像一颗不占补画册：撤销 = `redo` 反着画（`.md-preview-tool--flip`）—— 官方册里独独没有 undo。
// （B450 起减少缩进也有自己的形状了：它不再靠 `indent` 镜像凑，两颗的箭头方向相反。）

import type { EditorView } from "@codemirror/view";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { closePopupMenu, popupMenuAnchor, showPopupMenu } from "../shell/menu";
import { setTip } from "../shell/tooltip";
import { CODICONS, type CodiconName } from "../shell/codicons";
import { TOOLBAR_MARKS, type ToolbarMarkName } from "../shell/toolbarMarks";
import {
  insertImageAtCursor,
  insertLinkAtCursor,
  runFormat,
  type FormatAction,
  type ImagePicker,
  type LinkPicker,
} from "./format";

export type FormatToolbarId =
  | FormatAction
  | "heading"
  | "link"
  | "image"
  // B447 新槽：三颗历史键（动作从 deps 注入）+ 三颗折叠键。
  | "undo"
  | "redo"
  | "save"
  | "list"
  | "block"
  | "style";

/** 分组（B447）：`模式切换键` 由 markdown.ts 画在条首，不在这张表里。 */
export type ToolbarGroup = "history" | "paragraph" | "insert" | "format";

/** 折叠键下拉里的一条：`id` 同时就是 `runFormat` 的那个动作。 */
export interface FormatToolbarChild {
  id: FormatAction;
  label: string;
  icon: ToolbarIconName;
}

/** 工具条图标的两轨（B446）：codicon 在册字形 + 八枚同笔补画的标记（B450）。 */
export type ToolbarIconName = CodiconName | ToolbarMarkName;

export interface FormatToolbarItem {
  id: FormatToolbarId;
  label: string;
  group: ToolbarGroup;
  icon: ToolbarIconName;
  /** 下拉子项（`heading` 那颗的特例走 `HEADING_ITEMS`，它要显示「当前是哪一档」）。 */
  children?: readonly FormatToolbarChild[];
  /**
   * 字形水平镜像。只剩一颗在用：`undo`（册里有 `redo`、没有 `undo`）—— 用户拍板
   * 「不为此再画一枚」⇒ 同一颗反着画，天然成对。
   * （B450 起 `outdent` 退出这一档：它有了自己的形状，不再靠 `indent` 镜像凑。）
   */
  flip?: boolean;
  /** 提示里带的快捷键（与 `keymap.ts` 同一条），只有带既定键位的那几颗写。 */
  key?: string;
}

/**
 * 20 颗可见槽 + 页面内那颗切换键 = 21 颗（B447 用户选定的**方案 B · 中折**，
 * B448 段落组加缩进两颗、B450 插入组加脚注一颗）。
 *
 * 折叠只折两类：① 一眼同类型的成对项（三种列表 / 上下标），② 低频的块级插入
 * （公式 + Mermaid）。被折掉的 8 个动作全部进下拉，一个不丢；链接与图片仍常显，
 * 它们是从工具条进弹窗唯二的入口。
 */
export const FORMAT_TOOLBAR_ITEMS: readonly FormatToolbarItem[] = [
  { id: "undo", label: "撤销", group: "history", icon: "redo", flip: true, key: "Ctrl+Z" },
  { id: "redo", label: "恢复", group: "history", icon: "redo", key: "Ctrl+Y" },
  { id: "save", label: "保存", group: "history", icon: "save", key: "Ctrl+S" },
  { id: "heading", label: "标题", group: "paragraph", icon: "textSize" },
  {
    id: "list",
    label: "列表",
    group: "paragraph",
    icon: "listUnordered",
    children: [
      { id: "bulletList", label: "无序列表", icon: "listUnordered" },
      { id: "orderedList", label: "有序列表", icon: "listOrdered" },
      { id: "taskList", label: "任务列表", icon: "tasklist" },
    ],
  },
  // B448 · 缩进两颗紧跟列表：它们管的正是「这一项挂在哪一层」。
  // B450 · 两颗各画一枚（四行字 + 方向相反的箭头）：用户点名要文本编辑器里那种常见形状 ——
  // codicon 那颗 `indent` 不是，镜像它得到的「减少缩进」更不像。
  { id: "indent", label: "增加缩进", group: "paragraph", icon: "indent" },
  { id: "outdent", label: "减少缩进", group: "paragraph", icon: "outdent" },
  { id: "blockquote", label: "引用块", group: "paragraph", icon: "quote" },
  { id: "hr", label: "水平分割线", group: "paragraph", icon: "horizontalRule" },
  { id: "codeBlock", label: "代码块", group: "paragraph", icon: "code" },
  { id: "table", label: "表格", group: "insert", icon: "table" },
  { id: "toc", label: "插入目录", group: "insert", icon: "listTree" },
  {
    // B446：公式取补画的 Σ（`symbol-numeric` 是 `#`，读起来像「标题」不像公式）；
    // B448：Mermaid 改补画的流程图（两个方框 + 向下的箭头 = `graph TD`）——
    // `type-hierarchy` 画的是圆节点的组织图，用户看了仍要改。
    id: "block",
    label: "公式 / 图表",
    group: "insert",
    icon: "math",
    children: [
      { id: "mathBlock", label: "数学公式块", icon: "math" },
      { id: "mermaid", label: "Mermaid 图表", icon: "flowchart" },
    ],
  },
  { id: "link", label: "超链接", group: "insert", icon: "link" },
  { id: "image", label: "图片", group: "insert", icon: "fileMedia" },
  // B450 · 脚注：插一条引用 + 文末一行定义（那颗上标点了能跳到这条定义）
  { id: "footnote", label: "脚注", group: "insert", icon: "footnote" },
  { id: "bold", label: "加粗", group: "format", icon: "bold" },
  { id: "italic", label: "斜体", group: "format", icon: "italic" },
  { id: "underline", label: "下划线", group: "format", icon: "underline" },
  {
    id: "style",
    label: "更多格式",
    group: "format",
    icon: "strikethrough",
    children: [
      { id: "strikethrough", label: "删除线", icon: "strikethrough" },
      { id: "highlight", label: "高亮", icon: "paintcan" },
      { id: "inlineCode", label: "行内代码", icon: "bracket" },
      { id: "superscript", label: "上标", icon: "superscript" },
      { id: "subscript", label: "下标", icon: "subscript" },
    ],
  },
];

export interface FormatToolbarDeps {
  pickLink?: LinkPicker;
  pickImage?: ImagePicker;
  /**
   * 三颗历史键的落点（B447）。它们归**文档 / 命令层**管（保存要写盘、撤销要认当前
   * 实例），由调用方注入 —— 工具条不许反向 `import` `../commands`。
   * 没注入时点击是空操作：`applyPanelMode` 之外（单测、非 Markdown 面板）也建得出条。
   */
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
}

/** 三颗历史键的可用态（其余 14 颗永远亮着，不参与）。 */
export interface FormatToolbarState {
  canUndo: boolean;
  canRedo: boolean;
  canSave: boolean;
}

/**
 * 从当前实例算那三颗的可用性。
 *
 * `undoDepth` / `redoDepth` 在没有 `history()` 扩展的状态上返回 0（库里就兜了
 * `state.field(..., false)`），所以非编辑档 / 测试夹具传进来也不会炸。
 * `dirty` 由调用方取 `doc.dirty` —— 那颗原点与「保存该不该亮」必须同一个权威。
 */
export function historyToolbarState(view: EditorView | null, dirty: boolean): FormatToolbarState {
  const state = view?.state;
  return {
    canUndo: !!state && undoDepth(state) > 0,
    canRedo: !!state && redoDepth(state) > 0,
    canSave: dirty,
  };
}

/**
 * 把可用态落到那三颗上（幂等：`applyPanelMode` 每帧、每次文本变化都会调）。
 *
 * 用原生 `disabled` 而不是「照常亮着、handler 里自己拦」：灰态点下去根本不发事件，
 * 少一条「按了没反应也没人知道为什么」的静默失败路径（B97 菜单项同款口径）。
 */
export function syncFormatToolbarState(tools: HTMLElement, state: FormatToolbarState): void {
  const flags: Record<"undo" | "redo" | "save", boolean> = {
    undo: state.canUndo,
    redo: state.canRedo,
    save: state.canSave,
  };
  for (const [id, on] of Object.entries(flags)) {
    const btn = tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`);
    if (btn) btn.disabled = !on;
  }
}

/** 按名字取那一轨里的字形原文（补画轨优先 —— 四枚标记的名字已从 codicon 册撤下）。 */
export function toolbarIcon(name: ToolbarIconName): string {
  const marks: Partial<Record<ToolbarIconName, string>> = TOOLBAR_MARKS;
  return marks[name] ?? CODICONS[name as CodiconName];
}

/** 下拉小箭头（B431 起就有的一颗，画在键内右侧）。 */
const CARET = '<span class="md-preview-tool-caret" aria-hidden="true"></span>';

const HEADING_ITEMS: Array<{ level: number; label: string }> = [
  { level: 0, label: "正文" },
  { level: 1, label: "一级标题" },
  { level: 2, label: "二级标题" },
  { level: 3, label: "三级标题" },
  { level: 4, label: "四级标题" },
  { level: 5, label: "五级标题" },
  { level: 6, label: "六级标题" },
];

function currentHeadingLevel(view: EditorView): number {
  const line = view.state.doc.lineAt(view.state.selection.main.head).text.trimStart();
  const m = /^(#{1,6})\s+/.exec(line);
  return m ? m[1].length : 0;
}

function openHeadingMenu(anchor: HTMLButtonElement, view: EditorView): void {
  if (popupMenuAnchor() === anchor) {
    closePopupMenu();
    return;
  }
  const active = currentHeadingLevel(view);
  showPopupMenu(
    anchor,
    HEADING_ITEMS.map((item) => ({
      label: item.label,
      checked: item.level === active,
      onSelect: () => {
        runFormat(view, item.level === 0 ? "paragraph" : (`heading${item.level}` as FormatAction));
      },
    })),
    undefined,
    { anchorToggle: true },
  );
}

/** 这颗键是不是「点开是一列子项」的折叠键（`heading` 也算，它那份清单另有状态）。 */
function isDropdown(item: FormatToolbarItem): boolean {
  return item.id === "heading" || !!item.children;
}

/**
 * 折叠键的下拉（B447）：复用 `heading` 那一套弹层，只是子项跑的是普通 `runFormat`，
 * 而且每条带自己的字形 —— 上标 / 下标 折进去以后仍认得出形状，不靠中文标签硬认。
 */
function openChildMenu(anchor: HTMLButtonElement, item: FormatToolbarItem, view: EditorView): void {
  if (popupMenuAnchor() === anchor) {
    closePopupMenu();
    return;
  }
  showPopupMenu(
    anchor,
    (item.children ?? []).map((child) => ({
      label: child.label,
      icon: toolbarIcon(child.icon),
      onSelect: () => runFormat(view, child.id),
    })),
    undefined,
    { anchorToggle: true },
  );
}

function createButton(
  item: FormatToolbarItem,
  getView: () => EditorView | null,
  deps: FormatToolbarDeps,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-preview-tool";
  btn.dataset.action = item.id;
  btn.setAttribute("aria-label", item.label);
  if (item.flip) btn.classList.add("md-preview-tool--flip");
  btn.innerHTML = toolbarIcon(item.icon) + (isDropdown(item) ? CARET : "");
  // 提示带键位：三颗历史键各有既定快捷键（`keymap.ts` 是同一条），工具条上不写就等于
  // 让用户白按一次；其余动作没有专属快捷键，留空。
  setTip(btn, item.label, item.key ? { key: item.key } : {});
  // 保住编辑器里的选区 / 光标：工具条不是输入目标，鼠标按下不该把焦点搬走。
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    // 三颗历史键归命令层（保存要写盘、撤销要认当前实例），一律走注入的回调。
    if (item.id === "undo") return deps.onUndo?.();
    if (item.id === "redo") return deps.onRedo?.();
    if (item.id === "save") return deps.onSave?.();
    const view = getView();
    if (!view) return;
    if (item.id === "heading") {
      openHeadingMenu(btn, view);
      return;
    }
    if (item.children) {
      openChildMenu(btn, item, view);
      return;
    }
    if (item.id === "link") {
      void insertLinkAtCursor(view, deps.pickLink);
      return;
    }
    if (item.id === "image") {
      void insertImageAtCursor(view, deps.pickImage);
      return;
    }
    // 槽表保证了：非折叠、非 link/image、非历史三颗的键，id 就是一个 FormatAction
    runFormat(view, item.id as FormatAction);
  });
  return btn;
}

/**
 * 在容器里建（或取回）工具条。重复调用是空操作 —— `applyPanelMode` 每帧都会调到。
 * `getView` 在点击时求值，调用方可以安全地持有 panel 而不用管 view 何时重建。
 */
export function ensureFormatToolbar(
  container: HTMLElement,
  getView: () => EditorView | null,
  deps: FormatToolbarDeps = {},
): HTMLElement {
  const existing = container.querySelector<HTMLElement>(".md-preview-tools");
  if (existing) return existing;

  const tools = document.createElement("div");
  tools.className = "md-preview-tools";
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", "Markdown 格式工具条");

  // 起点记成 `"mode"`：切换键（markdown.ts 画在条首）自己占一组 ⇒ 历史组之前也落一根线。
  let lastGroup: ToolbarGroup | "mode" = "mode";
  for (const item of FORMAT_TOOLBAR_ITEMS) {
    if (item.group !== lastGroup) {
      const sep = document.createElement("span");
      sep.className = "md-preview-tool-sep";
      sep.setAttribute("aria-hidden", "true");
      tools.appendChild(sep);
    }
    lastGroup = item.group;
    tools.appendChild(createButton(item, getView, deps));
  }

  container.appendChild(tools);
  return tools;
}
