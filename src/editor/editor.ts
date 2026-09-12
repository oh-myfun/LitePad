import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { highlightSelectionMatches, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, type ViewUpdate } from "@codemirror/view";
import { findHighlight } from "./find";

export interface EditorHandle {
  view: EditorView;
  getText(): string;
  /** 多标签核心：整态切换（撤销历史随 EditorState 保留） */
  setState(state: EditorState): void;
  focus(): void;
}

/**
 * 折叠标记：内联 SVG chevron（默认的 "⌄/›" 文本字形观感差）。
 * 颜色与悬停效果走 CSS 变量（.cm-fold-marker，见 global.css），随深浅色联动。
 */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-fold-marker";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = open
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4.5 6l3.5 4 3.5-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 4.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return span;
}

/**
 * 基础扩展集（所有标签共享同一份配置）。
 * 语言与主题用 Compartment 注入，每个 EditorState 持有独立 compartment 实例，
 * 因此切换标签（setState）时语言/主题/换行随快照自动恢复。
 */
function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter({ markerDOM: foldMarkerDOM }),
    history(),
    drawSelection(),
    dropCursor(),
    // 列编辑：Alt + 拖选
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    // 缩进：4 空格 + 输入时自动缩进
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    indentOnInput(),
    // 括号：匹配高亮 + 自动闭合
    bracketMatching(),
    closeBrackets(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      // 选中区扩展：CM searchKeymap 里只保留这两条有用的。
      // 其余（Mod-f / F3 / Mod-g / Escape / Mod-Alt-g）会打开 CM6 自带搜索面板或抢键，
      // 与“悬浮查找栏统一入口”冲突——查找统一由 src/shell/findbar.ts 处理。
      { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
      { key: "Mod-Shift-l", run: selectSelectionMatches },
      indentWithTab,
    ]),
    highlightSelectionMatches(),
    // 查找命中高亮（由悬浮查找栏通过 setFindQuery 驱动）
    findHighlight(),
  ];
}

interface EditorStateEnv {
  dark: boolean;
  wrap: boolean;
}

export interface TabCompartments {
  theme: Compartment;
  wrap: Compartment;
  lang: Compartment;
}

export interface TabState {
  state: EditorState;
  comps: TabCompartments;
}

/**
 * 构造一个标签的 EditorState：文档内容 + 语言 + 主题/换行。
 * 返回 compartment 引用，供离线更新非活动标签（如切换主题时
 * `tab.state.update({ effects: comps.theme.reconfigure(...) })`）。
 */
export function makeTabState(
  doc: string,
  language: Extension | null,
  env: EditorStateEnv,
  onUpdate: (view: EditorView, update: ViewUpdate) => void,
): TabState {
  const comps: TabCompartments = {
    theme: new Compartment(),
    wrap: new Compartment(),
    lang: new Compartment(),
  };
  const state = EditorState.create({
    doc,
    extensions: [
      ...baseExtensions(),
      comps.wrap.of(env.wrap ? EditorView.lineWrapping : []),
      comps.theme.of(env.dark ? oneDark : []),
      comps.lang.of(language ?? []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) {
          onUpdate(update.view, update);
        }
      }),
    ],
  });
  return { state, comps };
}

/**
 * CodeMirror 6 封装（M1 多标签）：
 * 单一 EditorView 承载多个标签，切换 = view.setState(标签快照)。
 */
export function createEditor(
  parent: HTMLElement,
  initialState: EditorState,
): EditorHandle {
  const view = new EditorView({ state: initialState, parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setState: (state) => view.setState(state),
    focus: () => view.focus(),
  };
}
