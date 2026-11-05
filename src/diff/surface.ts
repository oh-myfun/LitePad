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
 * 左栏那颗 view 的 state —— 只读要**两手一起给**（简报 Step 5）：
 *   · `EditorView.editable(false)`：内容 DOM 落 `contenteditable="false"` ⇒ 敲字进不去。
 *     光靠这一手还不够 —— B399 记过：只给 `editable(false)` 会让 `focus()` 空操作、选不出字。
 *   · `EditorState.readOnly`：CM6 的口径是「**commands 与扩展**在动手之前问这一颗」
 *     （`@codemirror/state` 的 `readOnly` 文档原话），它**不**否决裸 `view.dispatch`。
 *
 * ⚠️ 所以「别的模块程序化写不进去」这一句不成立，别照着它设计：真要挡裸派发，仓库既有
 * 那一手是 `previewLock`（`EditorState.readOnly` + 丢 `docChanged` 的 `transactionFilter`，
 * 见 `src/preview/wysiwyg.ts:39`）。这一格暂时不需要：那颗 view 不进 doc 记账、不进协调器、
 * 也不在任何按 `panel.view` 寻址的路径上，今天没有裸派发方；等 Task 3/6 真出现写点再上那道闸。
 *
 * 行号（`lineNumbers()`）给：两侧都要能按行号读位置。装饰面与折叠不在这里（预审 R1）。
 */
function leftState(spec: DiffSpec): EditorState {
  return EditorState.create({
    doc: spec.leftText(),
    extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers()],
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
