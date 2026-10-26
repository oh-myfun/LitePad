// B391 spike · 只读镜像视图与 ChangeSet 桥。
//
// 参照 LitePad 自己的多实例口径（src/main.ts:328 `syncDocInstances`、:356 定义）：
// 同一文档的每份实例各持一个 `EditorState`，内容靠把同一个 `ChangeSet` 映射过去对齐，
// **不是**共享 state。装饰预览因此只是「同文档的第 N 份实例」，不需要新造多视图机制。

import { EditorState, type ChangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { draftFences } from "./codeFence";
import { livePreview } from "./livePreview";

export interface DecoMirror {
  view: EditorView;
  dispose(): void;
}

/**
 * 回写进行中。
 *
 * 与 LitePad 里 `syncingDocId` 那道位同一个道理：镜像写入 dst 时 dst 也会发 update，
 * 若那一发再被当成「用户在 dst 里编辑」广播回 src，就成了回声环。
 */
let syncing = false;

export function isMirrorSyncing(): boolean {
  return syncing;
}

/**
 * 把 src 的一发变更镜像进 `dst`。
 *
 * 四种结果里 `skipped-identical` 是重点：切视图 / 重新测量 / 仅改选区这些事务，
 * CM6 会报 `docChanged` 但前后文本完全一致 —— 现方案的自动保存就是为此在
 * src/main.ts:296-310 加了「文本真的变了才算编辑」那道闸。回写层同口径。
 *
 * ⚠️ `changes.length` 是「这套变更**照着多大的文档**算出来的」，也就是变更前的
 * 长度；拿它跟 `src.state.doc.length`（变更后）比，每一发真编辑都会被判陈旧。
 * 该比的是 dst 此刻的长度 —— 两侧基线不一致时 `changes.apply` 会按位置写出花来。
 * 也正因为这道闸问的是 dst，参数里不留 src：计划原先写的 `mirrorChanges(src, dst, changes)`
 * 里 src 是个纯摆设（台账 Task 4 有 Ruling）。
 */
export function mirrorChanges(
  dst: EditorView,
  changes: ChangeSet,
): "applied" | "skipped-identical" | "skipped-echo" | "skipped-stale" {
  if (syncing) return "skipped-echo";
  if (changes.empty) return "skipped-identical";
  if (changes.length !== dst.state.doc.length) return "skipped-stale";

  const next = changes.apply(dst.state.doc).toString();
  if (next === dst.state.doc.toString()) return "skipped-identical";

  syncing = true;
  try {
    dst.dispatch({ changes, userEvent: "mirror" });
  } finally {
    syncing = false;
  }
  return "applied";
}

/** 在 `parent` 里建一个只读装饰面实例（Task 5 由面板模型持有它）。 */
export function createDecoMirror(parent: HTMLElement, doc: string): DecoMirror {
  const state = EditorState.create({
    doc,
    extensions: [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      markdown({ base: markdownLanguage }),
      draftFences,
      livePreview({ readOnly: true }),
      EditorView.lineWrapping,
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    dispose: () => view.destroy(),
  };
}
