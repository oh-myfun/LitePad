// B461 · 一张差异标签的运行时（Task 1 只管「挂上去 / 拆下来」这一对，Task 4/7 再往里加长）。
//
// 落点（设计稿 ⑧·1 的裁决，本轮的地基）：**`Panel.view` 继续是右栏那颗既有的 EditorView**
// （那份文档本身 —— 脏标记、Ctrl+S、撤销栈、会话快照全按它寻址，那一大片一行都不用加分支）。
// 差异标签只多一个**旁路**：挂在 `.panel-host` 内、`.panel-editor` **之前**的一颗只读
// `EditorView`，加一根只管这一栏之内的分割线。风险因此从「几十处都要记得问 kind」
// 降级成「一处挂、一处拆」。
//
// ⚠️ 左栏那颗 view **不进同步滚动那套注册口**：那套的语义是「同一文档的两个视口」，
// 而这里是两份**不同**的内容（设计稿 ② 的反目标）；跳块的落位走既有「显式落位」那一类（Task 4）。
//
// ⚠️ 两臂的装饰面（两侧底色 / 占位块 / 中间指示带）不在这里建：预审 R1 定的是 Task 3 用它
// 自己创建的 `Compartment` 在 attach 时对**两颗** view 做运行时 reconfigure，所以这一颗起步时
// 不带任何 diff 专用 Compartment（留一个空转的抽象 = 判越界）。

import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tabs, type Panel } from "../core/app-state";
import type { DiffSpec } from "./model";

/** 一张差异标签挂在面板上的旁路 surface。 */
export interface DiffSurface {
  /** 左栏那颗只读视图（测试与 Task 4/7 的落位都直接按它寻址） */
  readonly left: EditorView;
  /** 当前输入描述（可交换 ⇒ 是取值口，不是冻结字段；预审 R3） */
  spec(): DiffSpec;
  /** B 档「交换左右」就地换输入用（不换 tabId；Task 6 拥有调用者） */
  retarget(spec: DiffSpec): void;
  dispose(): void;
}

/** 分割线可拖的范围：左栏占这一栏宽度的 15%–85%（简报 Step 7 定死）。 */
const MIN_SHARE = 15;
const MAX_SHARE = 85;

function clampShare(share: number): number {
  return Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));
}

/**
 * 左栏那颗 view 的 state —— 只读**不是**「两手」，是三道一起给（R12：「左栏只读」是设计稿 ⑤
 * 的事实项、⑦·⑤ 的验收对象）：
 *   · `EditorView.editable(false)`：内容 DOM 落 `contenteditable="false"` ⇒ 敲字进不去。
 *   · `EditorState.readOnly`：CM6 的口径是「**commands 与扩展**在动手之前问这一颗」
 *     （`@codemirror/state` 的 `readOnly` 文档原话），它**不**否决裸 `view.dispatch`。
 *   · `EditorState.transactionFilter`（丢掉 `docChanged`）：这一道才兑现绑定约束那句
 *     「任何事务都不许改动它的文档」。少了它，前两道只是「看起来不能打字」——
 *     查找替换、脚本改文档、任何后来接上这颗 view 的写点都能直接重写基线正文。
 *
 * 加 `EditorView.contentAttributes` 那颗 `tabindex: "0"`：`editable(false)` 把 contentDOM 写成
 * `contenteditable=false`，而 CM6 聚焦靠的正是点下去那一下 `focus()` —— 不可编辑又没有
 * tabindex 的元素 `focus()` 是空操作 ⇒ 左栏点不进焦点、选不出字、复制不了（⑦·⑤ 要的正是
 * 「选得中才复制得了」）。`src/preview/wysiwyg.ts:44-48` 把「两道都必要」记过一遍，这里同方。
 *
 * ⚠️ 闸只管「改文档」，非 `docChanged` 的事务原样放行：Task 3 的装饰走 effects、Task 4 的
 * 落位走 selection 与滚动 —— 整片 `[]` 等于把那两件事一起锁死。
 *
 * 机制一律复用仓库现成的那一族（`previewLock`，`src/preview/wysiwyg.ts:39-49`），不自造锁。
 * 行号（`lineNumbers()`）给：两侧都要能按行号读位置。装饰面与折叠不在这里（预审 R1）。
 */
function leftState(spec: DiffSpec): EditorState {
  return EditorState.create({
    doc: spec.leftText(),
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
      lineNumbers(),
    ],
  });
}

/**
 * 挂起这一格之内的分割线（不复用 splitview 那套 sash：那一套管面板树，这一根只管一栏之内）。
 * 宽度不落设置 —— 本轮「记住宽度」不是需求。
 * @returns 解除 `pointerdown` 绑定的动作（dispose 时调用）
 */
function attachSashDrag(originalEl: HTMLElement, sashEl: HTMLElement): () => void {
  const onDown = (event: PointerEvent) => {
    const host = sashEl.parentElement;
    if (!host) return;
    // 量不到宽度（隐藏格 / jsdom 里 `getBoundingClientRect` 恒 0）就这一下不动手：
    // 拿 0 当基准会把 flex-basis 写成 NaN%，那一格从此不受控。
    const total = host.getBoundingClientRect().width;
    if (total <= 0) return;
    const startX = event.clientX;
    const startShare = (originalEl.getBoundingClientRect().width / total) * 100;
    const onMove = (move: PointerEvent) => {
      const share = clampShare(startShare + ((move.clientX - startX) / total) * 100);
      originalEl.style.flexBasis = `${share}%`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    event.preventDefault();
  };
  sashEl.addEventListener("pointerdown", onDown);
  return () => sashEl.removeEventListener("pointerdown", onDown);
}

/**
 * 在 `hostEl`（splitview 交下来的 `.panel-host`）里挂上差异旁路，并把 surface 记到 panel 上。
 *
 * `_opts.ignoreTrimWhitespace` 在这一发里不消费：「忽略首尾空白」影响的是**差异计算**
 * （Task 2 的对齐器）与两侧底色（Task 3 的装饰面），Task 1 只建那颗只读左栏。
 * 参数位置照 Interfaces 留着，调用方现在就能带；前缀下划线是仓库对未用参数的豁免写法。
 */
export function createDiffSurface(
  hostEl: HTMLElement,
  panel: Panel,
  spec: DiffSpec,
  _opts?: { ignoreTrimWhitespace?: boolean },
): DiffSurface {
  hostEl.classList.add("is-diff");
  const originalEl = document.createElement("div");
  originalEl.className = "diff-original";
  const sashEl = document.createElement("div");
  sashEl.className = "diff-sash";
  // `.diff-original` 恒为 hostEl 的第一个子节点（排在 `.panel-editor` 之前）：
  // 左右次序由 DOM 决定，`.panel-host.is-diff` 只管把这一格摊成 row-flex。
  hostEl.insertBefore(originalEl, hostEl.firstChild);
  hostEl.insertBefore(sashEl, originalEl.nextSibling);

  let current = spec;
  const left = new EditorView({ parent: originalEl, state: leftState(current) });
  const detachSash = attachSashDrag(originalEl, sashEl);

  const surface: DiffSurface = {
    left,
    spec: () => current,
    retarget: (next) => {
      current = next;
      // 换输入 = 换**文档**，不是往当前文档里改：整态换一颗干净的只读 state，
      // 既不给对照缓冲留撤销历史，也不走 `dispatch({changes})` 那条「写文档」的路。
      // ⚠️ 必须用 `setState`：`dispatch({changes})` 如今会被 leftState 那道硬闸整发丢掉
      // （「换输入」看着像没反应）。`setState` 是换 state 不是发事务，天然不受那道闸牵连。
      left.setState(leftState(current));
    },
    dispose: () => {
      detachSash();
      left.destroy();
      originalEl.remove();
      sashEl.remove();
      hostEl.classList.remove("is-diff");
      if (panel.diffSurface === surface) panel.diffSurface = null;
    },
  };
  panel.diffSurface = surface;
  return surface;
}

/** 拆掉这一格的旁路（没有就空转）。`panel.view` 那颗右栏 view 不受牵连。 */
export function disposeDiffSurface(panel: Panel): void {
  const surface = panel.diffSurface;
  if (!surface) return;
  panel.diffSurface = null;
  surface.dispose();
}

/** 这一格当前的旁路（Task 4/7/8/9 都按它寻址）。 */
export function diffSurfaceOf(panel: Panel): DiffSurface | null {
  return panel.diffSurface ?? null;
}

/**
 * 这一格现在**该不该**有旁路，以及它该吃哪份 spec（不该有就返回 `null`）。
 *
 * 认「视图实际显示的那张标签」（`viewTabId`，缺省才落回 `activeTabId`）：旁路是挂在那颗
 * 右栏 view 旁边的对照物，跟着实际露出来的内容走才不会「显示 A、对照 B」。
 * `panel.view` 不在（空面板 / 已拆）时也一律不给 —— 没有右栏就没有可比的那一侧。
 */
function wantedSpec(panel: Panel): DiffSpec | null {
  if (!panel.view || !panel.bodyEl) return null;
  const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  return tab && tab.kind === "diff" ? tab.diff : null;
}

/**
 * 挂/拆的**唯一**判据入口：现状与「该不该有」不一致才动手。
 *
 * Task 1 接的三个点都在 `src/tabs/lifecycle.ts`：`mountView`（挂载那一刻挂）与
 * `rebuildLayout` 的销毁循环、`disposePanel`（拆）。Task 5 会把「换标签不换面板」那条同形路
 * 也接进来（`applyPanelMode` 的末尾 —— DOM 已就位那一刻）。
 * `switchTab` **不加** kind 分支：它已经靠 `rebuildLayout` / `setState` 两条路走，
 * 分支加在那里等于把 B232/B355 那两条顺序纪律再搅一遍。
 *
 * ⚠️ 判「是不是这张标签的旁路」用 spec 的**对象身份**：`tab.diff` 与 `surface.spec()` 必须
 * 指向同一个对象（Task 6 的「交换左右」走 `retarget`，那边要同步把新 spec 写回 `tab.diff`）。
 * 对不上就重建 —— 宁可重建，也不许把 A 标签的对照物留在 B 标签上。
 */
export function syncDiffSurface(panel: Panel): void {
  const want = wantedSpec(panel);
  const have = panel.diffSurface;
  if (!want) {
    if (have) disposeDiffSurface(panel);
    return;
  }
  if (have) {
    if (have.spec() === want) return; // 一致 ⇒ 一个字都不动（防每发刷新都重建）
    disposeDiffSurface(panel);
  }
  createDiffSurface(panel.bodyEl as HTMLElement, panel, want);
}
