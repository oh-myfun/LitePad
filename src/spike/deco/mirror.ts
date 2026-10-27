// B391 spike · 只读镜像视图与 ChangeSet 桥。
//
// 参照 LitePad 自己的多实例口径（src/main.ts:328 `syncDocInstances`、:356 定义）：
// 同一文档的每份实例各持一个 `EditorState`，内容靠把同一个 `ChangeSet` 映射过去对齐，
// **不是**共享 state。装饰预览因此只是「同文档的第 N 份实例」，不需要新造多视图机制。

import { EditorState, type ChangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { findHighlight } from "../../editor/find";
import { draftFences } from "./codeFence";
import { livePreview } from "./livePreview";
import { taskClick } from "./taskClick";

/** 装饰面要交回宿主的两件事（B391F-5）：点勾与「这一格此刻许不许写」。 */
export interface DecoMirrorOpts {
  /**
   * 用户点中第 `line` 行（**文档行号**，1 起）的方框。
   * 宿主拿它去调 `markdown.ts` 那颗唯一写点，写的是源码那棵 view。
   */
  onToggleTask?: (line: number) => void;
  /** 只读文档 / 非 Markdown 时返回 false：点了不许有反应（B228 口径）。 */
  canToggleTask?: () => boolean;
  /**
   * 镜像可写（B391F-8「摸手感」那一档）。
   * 开着 = 摘掉 `editable(false)` 与 `State.readOnly(true)`，并把 `livePreview` 的
   * 光标显形打开 —— 但**权威仍是源码那颗 view**，镜像的键入经 `onMirrorEdit` 交回宿主。
   */
  editable?: boolean;
  /** 镜像里真打字了（桥写进来的那一发不算）。宿主拿它去调 `mirrorToSource`。 */
  onMirrorEdit?: (changes: ChangeSet) => void;
}

export interface DecoMirror {
  view: EditorView;
  /**
   * 这颗镜像**实际躺着**哪份文档。
   *
   * ⚠️ 不能拿「面板此刻显示的文档」当它：换显示而没重新播种那一形（`tabs/split.ts`
   * 分屏接班、`io/files.ts` 重开同一文件）留下的就是这个状态 —— 面板说 doc1、镜像里
   * 躺着另一篇。而 `ChangeSet.length` 只比长度，两篇等长时长道闸放行、`changes.apply`
   * 按位置把别人的文档套进来（评审 I5；`tests/spike-deco-wiring.test.ts` ⑤ 钉住）。
   */
  docId: number;
  /** 建的时候拿到的宿主回调；`reseedDecoMirror` 换 state 时要原样带过去。 */
  opts: DecoMirrorOpts;
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
export type BridgeStatus = "applied" | "skipped-identical" | "skipped-echo" | "skipped-stale";

export function mirrorChanges(dst: EditorView, changes: ChangeSet): BridgeStatus {
  if (syncing) return "skipped-echo";
  if (changes.empty) return "skipped-identical";
  if (changes.length !== dst.state.doc.length) return "skipped-stale";

  // 「文本其实没变」不许拿两次全文字符串比：113 KB 的文档每发击键要拼两次 `toString()`
  // （P3-2 实测装饰面击键平均 32ms，这是其中白送的一截）。`Text.eq` 比的是结构，
  // 不物化字符串，语义与「前后文本相同」一致。
  if (changes.apply(dst.state.doc).eq(dst.state.doc)) return "skipped-identical";

  syncing = true;
  try {
    dst.dispatch({ changes, userEvent: "mirror" });
  } finally {
    syncing = false;
  }
  return "applied";
}

/**
 * 反向桥：把**镜像里**打的那一发套回源码那颗 view。
 *
 * 三道闸与 `mirrorChanges` 同口径（回声 / 同文 / 过期），方向反过来问的目标也反过来：
 * `changes.length` 要比的是**源码此刻**的长度。写源码期间把 `syncing` 抬起，
 * 于是源码自己的监听再调正向桥时会被 `skipped-echo` 挡掉 —— 少了这一抬，
 * 「打一个字多两个字」就是这里的第一个病灶。
 */
export function mirrorToSource(src: EditorView, changes: ChangeSet): BridgeStatus {
  if (syncing) return "skipped-echo";
  if (changes.empty) return "skipped-identical";
  if (changes.length !== src.state.doc.length) return "skipped-stale";
  if (changes.apply(src.state.doc).eq(src.state.doc)) return "skipped-identical";

  syncing = true;
  try {
    src.dispatch({ changes, userEvent: "mirror" });
  } finally {
    syncing = false;
  }
  return "applied";
}

/**
 * 装饰面实例的 state：新建与重新播种共用一份，别写两遍。
 *
 * `editable`（B391F-8 的可写镜像）问的是「谁落笔」：开着也只表示**这颗 view 能打字**，
 * 权威仍是源码那颗 —— 键入经 `onMirrorEdit` → `mirrorToSource` 套回源码，
 * 下游（置脏 / 自动保存 / 大纲 / 同步滚动）一行不改。
 */
function mirrorState(doc: string, opts: DecoMirrorOpts): EditorState {
  const editable = opts.editable === true;
  // ⚠️ 这一发监听必须待在 extensions 里，不能事后挂到 view 的 config 上：
  // `EditorView.updateListener` 是 state facet（台账「CM6 六条接口硬事实」第 1 条），
  // 挂 config 或 `state.update({ extensions })` 都静默收不到任何东西。
  // 两道闸缺一不可：`isMirrorSyncing()` 挡正向桥那一发（回声在源头就不报），
  // `userEvent: "mirror"` 挡「同步期之外程序化写进镜像」的那一发。
  const editBridge = opts.onMirrorEdit
    ? EditorView.updateListener.of((update) => {
        if (!update.docChanged || isMirrorSyncing()) return;
        const tr = update.transactions.find((t) => t.docChanged);
        if (!tr || tr.isUserEvent("mirror")) return;
        opts.onMirrorEdit?.(update.changes);
      })
    : [];

  return EditorState.create({
    doc,
    extensions: [
      // B391F-8：可写（IR 手感）与只读共用这一份构造，缺省仍是只读镜像。
      editable ? [] : [EditorView.editable.of(false), EditorState.readOnly.of(true)],
      markdown({ base: markdownLanguage }),
      draftFences,
      // 可写 ⇒ 光标压住标记才显形源码（Typora 那一半机械）；只读 ⇒ 标记永不显形。
      livePreview({ readOnly: !editable }),
      editBridge,
      // B391F-5：装饰面是 CM6 视图，查找就直接用编辑器那套内核 —— 现方案给预览格
      // 另写了一台 DOM 命中机（`markdown/preview.ts` 的 applyFind），而开关开着时
      // 那台机器压根没被构造 ⇒ 预览格里 Ctrl+F 曾是空操作（结果文档② 评审 I8）。
      findHighlight(),
      opts.onToggleTask
        ? taskClick({ onToggleTask: opts.onToggleTask, canToggleTask: opts.canToggleTask })
        : [],
      EditorView.lineWrapping,
    ],
  });
}

/** 在 `parent` 里建一个装饰面实例（Task 5 由面板模型持有它）。`docId` 是它装着的那篇文档。 */
export function createDecoMirror(
  parent: HTMLElement,
  doc: string,
  docId: number,
  opts: DecoMirrorOpts = {},
): DecoMirror {
  const view = new EditorView({ state: mirrorState(doc, opts), parent });
  return {
    view,
    docId,
    opts,
    dispose: () => view.destroy(),
  };
}

/**
 * 把镜像**重新播种**成 `text` —— 面板换文档 / 接班那一形（此时两侧不再是同一基线，
 * 走 `mirrorChanges` 会被判 `skipped-stale`）。同文档的增量编辑一律走桥，不走这里。
 *
 * 文本一致时直接返回：`view.setState` 会把 `scrollDOM.scrollTop` 归零（与本仓库
 * 记过的那条「结构性滚动来源」同源），白白多发一次跳。
 */
export function reseedDecoMirror(mirror: DecoMirror, text: string, docId: number): void {
  // 戳记先跟着走：文本一致但归属变了（同一篇内容被注册成另一份文档）也要认出来。
  const sameText = mirror.view.state.doc.toString() === text;
  mirror.docId = docId;
  // 文本一致时不 setState：`view.setState` 会把 `scrollDOM.scrollTop` 归零（与本仓库
  // 记过的那条「结构性滚动来源」同源），白白多发一次跳。
  if (sameText) return;
  mirror.view.setState(mirrorState(text, mirror.opts));
}
