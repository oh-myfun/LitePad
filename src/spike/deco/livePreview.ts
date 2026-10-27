// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:851-898
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 装饰的总装：一个 StateField 持住「与光标无关的装饰集」，
// 文档变化才重建，选区变化只做一次范围受限的过滤。
//
// ⚠️ `provide` 里是**两条** `EditorView.decorations.from`，不是一条返回数组：
// `compute`/`from` 的取值函数必须给单个 DecorationSource，返回 `[a, b]` 会让
// CM6 把整个数组当成一个源去读 `isEmpty` 直接抛（Task 1 实测，探针 .tmp/b391-probe.ts）。
//
// B397-1：这里不再有构造期的 `readOnly` 参数。所见即所得是**同一颗 view 的一档**，
// 只读是与之正交的另一把锁（`EditorState.readOnly` facet），所以「这一份许不许因光标
// 显形」只能在重建装饰时问 state —— 与 InkNote 的 `visiblePreview()`（editor.ts:861-866）
// 同一条语义：**只读时装饰反而更彻底**（不做 reveal 过滤，标记全程折好）。

import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { applySelection, buildPreviewSets, type BlockRange, type PreviewSets } from "./previewSets";
import { previewSyntaxTree, setDraftFences } from "./codeFence";
import "./deco.css";

const ATOMIC_MARK = Decoration.mark({});

interface LivePreviewState extends PreviewSets {
  /** statics 按当前选区过滤后的结果（只读面 = statics 本身）。 */
  visible: DecorationSet;
}

function atomicBlockRanges(sets: readonly BlockRange[]): DecorationSet {
  if (!sets.length) return Decoration.none;
  return Decoration.set(
    sets.map((b) => ATOMIC_MARK.range(b.from, b.to)),
    true,
  );
}

/** 只读 = 不做光标显形过滤（标记永远折着），与 InkNote `visiblePreview` 同口径。 */
function visiblePreview(statics: DecorationSet, state: EditorState): DecorationSet {
  return state.facet(EditorState.readOnly) ? statics : applySelection(statics, state);
}

function buildLive(state: EditorState): LivePreviewState {
  const built = buildPreviewSets(state, previewSyntaxTree(state));
  return { ...built, visible: visiblePreview(built.statics, state) };
}

/**
 * 所见即所得档的装饰扩展（进 `previewCompartment`，源码档换成了空）。
 *
 * 挂上时 `EditorView.editorAttributes` 会给编辑器根打 `md-deco` —— 那颗类既是样式的
 * 选择器根（`deco.css` 全挂它下面），也是判据「这一格此刻是不是所见即所得」的读数点。
 *
 * ⚠️ field 是**模块级单例**而不是每次调用新建：`applyPanelMode` 每次落到视图模式都要问一句
 * 「这一档已经开着了吗」（`wysiwygInstalled`），已开着就不许再 reconfigure —— reconfigure 会
 * 销毁重建这个 StateField，等于白白全篇重 parse 一遍。
 */
const livePreviewField = StateField.define<LivePreviewState>({
  create: (state) => buildLive(state),
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(setDraftFences))) {
      return buildLive(tr.state);
    }
    // 只读锁换了也要重建：`visible` 的过滤口径跟着 facet 走，不重建就把上一把锁的读数留下
    if (
      tr.startState.facet(EditorState.readOnly) !== tr.state.facet(EditorState.readOnly) ||
      !tr.startState.selection.eq(tr.state.selection)
    ) {
      return { ...value, visible: visiblePreview(value.statics, tr.state) };
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.lines),
    EditorView.decorations.from(f, (v) => v.visible),
    EditorView.atomicRanges.of((view) => atomicBlockRanges(view.state.field(f).atomicBlocks)),
    EditorView.editorAttributes.of({ class: "md-deco" }),
  ],
});

export function livePreview(): Extension {
  return livePreviewField;
}

/** 这一档装在这份 state 上吗（换档前问一句，避免无谓的 reconfigure 重 parse 全篇）。 */
export function wysiwygInstalled(state: EditorState): boolean {
  return state.field(livePreviewField, false) !== undefined;
}
