// B397-1 · 所见即所得档的总装：一颗 view、两档切换，只读是与档位正交的另一把锁。
//
// 形态照 InkNote：`previewCompartment.reconfigure(previewExt(mode, ctx))`
// （`E:\Project\InkNote\InkNote\src\editor.ts:1370`）+
// `readOnlyCompartment.of([readOnly, editable])` 与一条丢 docChanged 的
// `transactionFilter`（同文件 1391-1399）。LitePad 这里以前是「源码 view + 一颗独立
// 只读镜像 + ChangeSet 桥」——InkNote 全仓只 `new EditorView` 一次，那颗镜像没有对应物，
// 所以整块拆掉：预览就是这一颗 view 换档，禁编辑就是它只读。

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { draftFences } from "./codeFence";
import { decoKeymap } from "./keymap";
import { livePreview } from "./livePreview";
import { taskClick } from "./taskClick";

export interface DecoHooks {
  /** 用户点中第 `line` 行（**文档行号**，1 起）的方框。宿主写的是这一颗 view 那份文档的那一行。 */
  onToggleTask: (view: EditorView, line: number) => void;
  /** 这一格现在许不许写（只读文档 / 非 Markdown ⇒ false，点了不许有反应，B228 口径）。 */
  canToggleTask: (view: EditorView) => boolean;
}

// 装饰扩展活在**标签的 EditorState** 里（多标签共用一颗 view），比任何一个面板都长寿
// ⇒ 回调只能晚绑定，不能像挂载点那样闭包面板引用。
let hooks: DecoHooks = {
  onToggleTask: () => {},
  canToggleTask: () => true,
};

/** 组合根（main.ts）注入：把「点勾写哪一行」「这一格许不许写」交给宿主。 */
export function setDecoHooks(next: DecoHooks): void {
  hooks = next;
}

/** 预览档（源码档换成了空数组）。 */
export function decoFace(): Extension {
  return [
    draftFences,
    livePreview(),
    taskClick({
      onToggleTask: (view, line) => hooks.onToggleTask(view, line),
      canToggleTask: (view) => hooks.canToggleTask(view),
    }),
    // B397-4b · 编辑模式的键位（续列表 / 组件边界回车 / 方向键进组件）
    decoKeymap(),
  ];
}

/**
 * 只读锁。与「是不是所见即所得」无关：关着编辑，装饰照常（InkNote 里只读时
 * 标记反而全程折着 —— reveal 过滤只在可写时才做）。
 *
 * 两道都必要：`EditorState.readOnly` 挡 CM6 自己的输入处理，`transactionFilter`
 * 挡**程序化**的那一发（查找替换、脚本改文档）—— 少了后者，只读只是「看起来不能打字」。
 */
export function decoLock(readonly: boolean): Extension {
  if (!readonly) return [];
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
    // 样式侧要知道「这一把锁现在落着」（藏光标、收工具栏）：CM6 会把多颗
    // editorAttributes 的 class 合并，所以这颗与 livePreview 的 `md-deco` 并存
    EditorView.editorAttributes.of({ class: "md-deco--readonly" }),
  ];
}
