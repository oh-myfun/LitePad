// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:851-898
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 装饰面的总装：一个 StateField 持住「与光标无关的装饰集」，
// 文档变化才重建，选区变化只做一次范围受限的过滤。
//
// ⚠️ `provide` 里是**两条** `EditorView.decorations.from`，不是一条返回数组：
// `compute`/`from` 的取值函数必须给单个 DecorationSource，返回 `[a, b]` 会让
// CM6 把整个数组当成一个源去读 `isEmpty` 直接抛（Task 1 实测，探针 .tmp/b391-probe.ts）。

import { StateField, type EditorState, type Extension } from "@codemirror/state";
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

function buildLive(state: EditorState, readOnly: boolean): LivePreviewState {
  const built = buildPreviewSets(state, previewSyntaxTree(state));
  return {
    ...built,
    visible: readOnly ? built.statics : applySelection(built.statics, state),
  };
}

/**
 * 装饰预览扩展。
 *
 * `readOnly: true`（spike 的用法）时标记永不因光标显形 —— 那一格是预览，
 * 不是 Typora 式的原位编辑面。
 */
export function livePreview(opts: { readOnly: boolean }): Extension {
  const field = StateField.define<LivePreviewState>({
    create: (state) => buildLive(state, opts.readOnly),
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(setDraftFences))) {
        return buildLive(tr.state, opts.readOnly);
      }
      if (!tr.startState.selection.eq(tr.state.selection) && !opts.readOnly) {
        return { ...value, visible: applySelection(value.statics, tr.state) };
      }
      return value;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.lines),
      EditorView.decorations.from(f, (v) => v.visible),
      EditorView.atomicRanges.of((view) => atomicBlockRanges(view.state.field(f).atomicBlocks)),
      // deco.css 的全部规则都挂在这颗类名下，不污染源码那一格
      EditorView.editorAttributes.of({ class: "md-deco" }),
    ],
  });
  return field;
}
