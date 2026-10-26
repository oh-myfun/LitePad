// B391 spike 装饰面测试的共享 helper（计划「共享测试 helper」一节）。
//
// 后续任务一律引用本文件，不各造一份：`lastChanges` 尤其不要手搓
// `ChangeSet.empty(n)` —— 纯选区事务的 changes 尺寸必须等于文档长度，
// 手搓会造出一个真事务，测试就从「证明没回写」变成「证明回写了个空」。

import { EditorState, StateEffect, type ChangeSet, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

/** 字符串按原样建 state；数字生成 N 行 `第 k 行内容` 的文档。 */
export function docState(input: string | number): EditorState {
  const doc =
    typeof input === "number"
      ? Array.from({ length: input }, (_, i) => `第 ${i + 1} 行内容`).join("\n")
      : input;
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

/** 建视图时必须挂上它，`lastChanges` 才有东西可读。 */
export function trackChangesExt(): Extension {
  return EditorView.updateListener.of((update) => record(update));
}

const recorded = new WeakMap<EditorView, ChangeSet>();

function record(update: ViewUpdate): void {
  // `ViewUpdate.changes`：本次 update 的文档变更；纯选区事务给的是
  // 「尺寸等于文档长度的空 changes」——正是「幽灵 docChanged」要判的那个形状。
  recorded.set(update.view, update.changes);
}

/** 该视图最近一次 update 的 `tr.changes`；没挂 `trackChangesExt()` 就直接抛，不静默给空。 */
export function lastChanges(view: EditorView): ChangeSet {
  const changes = recorded.get(view);
  if (!changes) {
    throw new Error("视图建的时候没挂 trackChangesExt()，lastChanges 无从取值");
  }
  return changes;
}

/**
 * 只计数不写回的广播探针。
 *
 * 用 `StateEffect.appendConfig` 事后再挂（测试里视图已经建好了），
 * 挂完立刻把计数 disarm 到 0：配置事务本身也会走一遍监听器，
 * 不抹掉的话「无回声」那条测试会数到这次安装。
 */
export function watchBroadcast(view: EditorView, cb: (update: ViewUpdate) => void): () => void {
  let armed = false;
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (armed) cb(update);
      }),
    ),
  });
  armed = true;
  return () => {
    armed = false;
  };
}

/** 建一个可跟踪变更的视图（Task 4 起两个视图都要走它）。 */
export function trackedView(
  state: EditorState,
  parent: HTMLElement,
  extra: Extension[] = [],
): EditorView {
  return new EditorView({
    state,
    parent,
    extensions: [trackChangesExt(), ...extra],
  });
}
