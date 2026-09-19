import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import {
  highlightSelectionMatches,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { findHighlight } from "./find";
import { perfProfileFor, type PerfProfile } from "./perf";
import { CODICONS } from "../shell/codicons";

export interface EditorHandle {
  view: EditorView;
  getText(): string;
  /** 多标签核心：整态切换（撤销历史随 EditorState 保留） */
  setState(state: EditorState): void;
  focus(): void;
}

/**
 * 折叠标记：内联 SVG chevron。
 *
 * ⚠️ 图标红线（docs/conventions.md「图标」节）：一律取 VS Code codicon，不手绘。
 * 这里原先手写了两段 12px 视图框的 chevron path，现改取官方的 chevron-down /
 * chevron-right —— 16 网格，正好填满 `.cm-fold-marker` 的 16px 槽位（见 global.css）。
 * 颜色与悬停效果仍走 CSS 变量，随深浅色联动。
 */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-fold-marker";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = open ? CODICONS.chevronDown : CODICONS.chevronRight;
  return span;
}

/**
 * 基础扩展集（所有标签共享同一份配置）。
 * 语言与主题用 Compartment 注入，每个 EditorState 持有独立 compartment 实例，
 * 因此切换标签（setState）时语言/主题/换行随快照自动恢复。
 *
 * M4：`perf` 按文档体量裁剪昂贵特性（语法高亮 / 折叠 / 括号匹配 / 选中匹配高亮 /
 * 当前行高亮），见 `perf.ts`。行号与撤销历史始终保留——它们是导航与安全的底线。
 */
function baseExtensions(perf: PerfProfile): Extension[] {
  const ext: Extension[] = [
    lineNumbers(),
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
    closeBrackets(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      // 折叠键位（foldKeymap：Ctrl-Shift-[ / ] 折叠展开光标块、Ctrl-Alt-[ / ] 全部）
      // 不在这里注册——已收归 src/shell/keymap.ts 统一管理，这样设置里能改键，
      // 且菜单显示的键位提示与实际生效键位始终一致。折叠由 editor.ts 之外的
      // foldOperation / foldCodeOperation 驱动。
      // 选中区扩展：CM searchKeymap 里只保留这两条有用的。
      // 其余（Mod-f / F3 / Mod-g / Escape / Mod-Alt-g）会打开 CM6 自带搜索面板或抢键，
      // 与“悬浮查找栏统一入口”冲突——查找统一由 src/shell/findbar.ts 处理。
      { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
      { key: "Mod-Shift-l", run: selectSelectionMatches },
      indentWithTab,
    ]),
    // 查找命中高亮（由悬浮查找栏通过 setFindQuery 驱动）
    findHighlight(),
  ];

  if (perf.activeLine) {
    ext.push(highlightActiveLineGutter(), highlightActiveLine());
  }
  if (perf.folding) {
    ext.push(foldGutter({ markerDOM: foldMarkerDOM }));
  }
  if (perf.bracketMatching) {
    ext.push(bracketMatching());
  }
  if (perf.selectionMatches) {
    ext.push(highlightSelectionMatches());
  }
  return ext;
}

interface EditorStateEnv {
  dark: boolean;
  wrap: boolean;
  /** M4 大文件分级档位；缺省 normal（新建/未命名文档） */
  perf?: PerfProfile;
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
 *
 * M4：`env.perf.syntax === false` 时不注入语言扩展（语法高亮是最大的一项开销）。
 * 语言 compartment 仍然建着——用户后续手动改回时无需重建状态。
 */
export function makeTabState(
  doc: string,
  language: Extension | null,
  env: EditorStateEnv,
  onUpdate: (view: EditorView, update: ViewUpdate) => void,
): TabState {
  const perf = env.perf ?? perfProfileFor("normal");
  const comps: TabCompartments = {
    theme: new Compartment(),
    wrap: new Compartment(),
    lang: new Compartment(),
  };
  const state = EditorState.create({
    doc,
    extensions: [
      ...baseExtensions(perf),
      comps.wrap.of(env.wrap ? EditorView.lineWrapping : []),
      comps.theme.of(env.dark ? oneDark : []),
      comps.lang.of(perf.syntax ? (language ?? []) : []),
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
export function createEditor(parent: HTMLElement, initialState: EditorState): EditorHandle {
  const view = new EditorView({ state: initialState, parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setState: (state) => view.setState(state),
    focus: () => view.focus(),
  };
}
