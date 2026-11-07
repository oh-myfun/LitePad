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
// 两臂的装饰面（Task 3：两侧行底色 / 行号槽记号 / 对侧占位块）与右缘差异概览**在这里装上，
// 但不在这里建**：
// `face.ts` 出 `diffFace(side, blocks)`，本模块只管「哪颗 view 装哪一臂、什么时候装/拆」，
// 并把「现在这批块是什么」那一读取口交出去（预审 R1：两颗 Compartment 由本模块自己创建，
// `makeTabState` / `makeDiffInstance` 的扩展清单一个字都不改）。
// ⚠️ 右栏那颗 view 是**既有的** `Panel.view`，Task 1 没给它预留 diff 专用 Compartment
// （预留 = 空转的抽象）⇒ 装它只能走 CM6 唯一可行的「先建视图、后加配置」那一发
// `StateEffect.appendConfig`，并且把新 Compartment 一起并进去，好在拆旁路时精准摘掉这一臂。

import { Compartment, EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { activePanelId, docs, isWrap, panels, tabs, type Panel } from "../core/app-state";
import { landVisibleSideAtV } from "../sync-scroll/wire";
import { DIFF_REFRESH_MS } from "./align";
import { blockAt, diffBlocks, type DiffBlock } from "./blocks";
import {
  DIFF_CONTEXT_LINES,
  DIFF_REVEAL_LINES,
  diffFace,
  foldCandidates,
  foldedRangesIn,
  onFoldBarClick,
  refreshDiff,
  setFoldedRanges,
  sideGaps,
  type FoldRange,
} from "./face";
import { canOpenAgainstBaseline, notifyDiffBlocks, type DiffSide, type DiffSpec } from "./model";

/** 两栏的寻址口径（折叠态要按 `side` 各换算一份，见 `foldedFor`）。 */
const SIDES: DiffSide[] = ["original", "modified"];

/**
 * 右栏那一臂共用的**一个具名槽**（预审 R1 说「Compartment 由本模块创建」；Task 5 把它收成一颗，
 * 原因是下面这条真实路径）。
 *
 * CM6 的 Compartment 值是**按 state** 存的，同一颗槽在两栏各自的 state 里各持各的值，互不干扰。
 * 而「换标签再换回来」这条路会把**上一颗 surface 的槽值**连同标签快照一起被 `setState` 回活视图
 * （`src/tabs/lifecycle.ts` 切出时同形回写 `tab.state = view.state`）：那时若新 surface 再
 * `appendConfig` 一颗自己的新槽，活视图上就同时挂着两臂 —— 旧那臂的 provider 还闭包着拆掉前的
 * 块表，底色就永久画在错误的行上，而且没人再摘得掉它（拆的是新那一条）。
 * 共用一颗槽 ⇒ 重挂就是「把这一槽换成我的 provider」，旧臂天然不存在第二份。
 */
const rightFaceSlot = new Compartment();

/** 一张差异标签挂在面板上的旁路 surface。 */
export interface DiffSurface {
  /** 左栏那颗只读视图（测试与 Task 4/7 的落位都直接按它寻址） */
  readonly left: EditorView;
  /** 当前输入描述（A/B 两档的读取口都从这儿取） */
  spec(): DiffSpec;
  /** 现读左右两份正文 → diffBlocks → 给两颗 view 各发 refreshDiff */
  syncBlocks(): void;
  /** 这一格现在那一批块（唯一一份答案：两侧底色、占位块、侧栏条目、跳块都吃它） */
  blocks(): DiffBlock[];
  /**
   * 两侧同时落位到各自那段的起始行；索引越界夹到首/末块；落位前先 `unfoldAround` 目标那一行。
   * 右栏那一发走**同步落位 + 同栈认领**（裁决 R25，见实现处的注释）。
   */
  jumpTo(index: number): void;
  /** 以右栏光标行为起点找下一/上一块 */
  step(dir: 1 | -1): void;
  /**
   * 右栏光标包住的那块；没有 ⇒ -1。
   *
   * 「包住」按 `blockAt` 的口径算，含 R26 那条兜底：空段（删除块在右栏那一侧）的**落点行**
   * 在没有别的块命中时也算这一块的 —— 于是「刚跳过去的那一块」不会因为差一行而读成 -1，
   * 侧栏的高亮与 `step` 的起点都跟着对得上。
   */
  activeIndex(): number;
  ignoreTrimWhitespace(): boolean;
  /** 翻转后立刻 syncBlocks()（开关改的是「同一份正文算出来的块」，两栏自己跟上） */
  setIgnoreTrimWhitespace(on: boolean): void;
  /**
   * 「折叠未改动区」这一格现在开着没有（Task 7）。
   *
   * 开关是 **surface 上的状态**，不进设置（本轮不做用户默认）：它的寿命就是这一格旁路的寿命，
   * 拆掉旁路就没了，换一张差异标签也是新的。
   */
  collapseUnchanged(): boolean;
  /** 开 ⇒ 把当前够长的未改动区全折上；关 ⇒ 清空（两栏一起，同一发） */
  setCollapseUnchanged(on: boolean): void;
  /** 三颗动作之一：够长的未改动区全折上（开关跟着打开） */
  collapseAllUnchanged(): void;
  /** 三颗动作之一：全展开（开关跟着关掉 —— 再重算也不许偷偷折回来） */
  showAllUnchanged(): void;
  /** 当前真的折起来的行区间（右栏行轴） */
  foldRanges(): Array<{ from: number; to: number }>;
  /** 落位/揭示前先把包住（或紧邻）这一行的折区展开 */
  unfoldAround(line: number): void;
  /**
   * 把这一格**已经漂移**的三件事补回「差异格该有的样子」（裁决 R20 / R22 / R23，内部口）。
   *
   * 点它的两处：`syncDiffSurface`（每次刷新都跑）与「刷新」那颗动作（Task 8 · 裁决 R37，
   * 读口刚换过快照 ⇒ 靠这一手把左栏那份文档跟上）。那张标签还是这一格现在露出的那张
   * （`spec()` 对得上）时，旁路不重建，但下面三条可能在无人认领的期间被改坏 ——
   *   · 右栏的**折行**被设置页重新打开（`applyWrapToTabs` 重配的是同一颗 Compartment）；
   *   · 右栏的**主题**被换掉（`applyDarkToTabs` 同上），而左栏吃的是挂上那一刻的现值；
   *   · `doc.baseline` 被就地换成新正文（保存 / 以磁盘为准重载），而左栏那份**文档**还是旧的。
   * 第三条最狠：块表是按新基线算的、左栏正文还是旧基线 ⇒ 装饰会画在错的那几行上，且屏上
   * 看不出所以然（B458 那轮「基线换了而标注没换」的同形病）。
   */
  reassert(): void;
  dispose(): void;
}

/** 分割线可拖的范围：左栏占这一栏宽度的 15%–85%（简报 Step 7 定死）。 */
const MIN_SHARE = 15;
const MAX_SHARE = 85;

function clampShare(share: number): number {
  return Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));
}

/**
 * 落位的那一行（1-based）：非空段落落自己那段的起始行；**空段**（`start > end`，
 * 即这一侧根本没有真行）落「块前缘那行的行首」= `end + 1`（设计稿 ⑥·面板，与
 * `blocks.ts` 的空段表示法同一口径 —— 那里恒有 `start = end + 1`）。
 *
 * 裁决 R26 把这一条**原样保留**：贴文首的删除块上「块前缘」是第 0 行，落位规则是唯一合法的
 * 那一个 ⇒ 改的是查询口（`blockAt` 认空段的落点行作兜底），不是这一头。
 */
function landingLine(b: DiffBlock, side: DiffSide): number {
  const start = side === "modified" ? b.modifiedStart : b.originalStart;
  const end = side === "modified" ? b.modifiedEnd : b.originalEnd;
  return start > end ? end + 1 : start;
}

/**
 * 某一行的行首位置，行号越界就夹到本栏的首/末行。
 *
 * 为什么必须夹：块表是按 provider 那一份正文算的，而**对栏可能先动了一步**（右栏刚打进去
 * 一行、左栏的基线还没跟上），那一发的落点行号就不在这份文档里。`doc.line(n)` 越界是直接
 * 抛错，落位这一族里最坏的写法就是把一发异常丢进用户的按键链路。
 */
function lineStartOf(view: EditorView, line: number): number {
  const n = Math.min(Math.max(line, 1), view.state.doc.lines);
  return view.state.doc.line(n).from;
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
 * 行号（`lineNumbers()`）给：两侧都要能按行号读位置。
 *
 * `theme` 给的是**右栏那颗 state 里主题 Compartment 的现值**（预审 R22），并且包在
 * `themeSlot` 里 —— Task 5 之后主题会在设置页被换掉（`applyDarkToTabs`），那时靠重建整颗
 * state 来跟色太重，靠 `reconfigure` 换槽值就够；不包槽就等于把「左栏吃什么色」冻在挂上那一刻。
 * 两栏必须叠在同一颗基色上，18% 的改动色才在两半看着是同一个颜色。取现值而不是在这儿再配
 * 一份：明暗与主题族的权威只有编辑器那一处（硬写 CSS 底色同样是第二处真相，dark / HC 族必错）。
 * 位置排在 `lineNumbers()` 之后 —— 与右栏（`makeTabState` 里 gutter 在前、主题在后）同一层叠顺序。
 *
 * `face` 是这一臂装饰（`faceComp.of(diffFace("original", …))`，Task 3）：**CompartmentInstance
 * 必须出现在 state 的扩展清单里**，之后 `faceComp.reconfigure()` 才管得到它（CM6 的
 * `flatten` 只走 base 里出现过的 Compartment，没出现的那一发 reconfigure 是静默空转）。
 * `reassert` 补基线走的是整态换 state，所以那一臂也只能靠这里带进去 —— 换进来的那颗
 * state 若不含它，左栏就没有底色了。折叠（Task 7）也在这同一臂里
 * （`diffFace` 现在带着 `diffFoldField` + 折条出口 ⇒ 换 state 时折叠面跟着进去，不必另装）。
 *
 * ⚠️ 这一栏**不装折行**（R19，见 `createDiffSurface` 里那一手）：折行从一开始就不进来。
 */
function leftState(spec: DiffSpec, face: Extension, theme: Extension): EditorState {
  return EditorState.create({
    doc: spec.leftText(),
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
      lineNumbers(),
      theme,
      face,
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
 * `opts.ignoreTrimWhitespace` 从 Task 3 起**消费**：它改变的是「同一份正文算出来的块」，
 * 而块只在这里算一次再交给两臂 ⇒ 开关一拨，两侧底色与侧栏条目自己跟上（设计稿 ⑥ 的同源）。
 * 开关本身归 Task 8 那颗图标键，缺省不设 = 不忽略，与 B458 那 4px 一列的口径一致。
 *
 * ⚠️ 一格**只许一排旁路**（裁决 R23-3）：进来先拆在任的那颗。不拆的话两颗 live surface 共用
 * 右栏那一槽与那颗 wrap Compartment，先 dispose 的那颗会把折行还成「它读到的现值」，把还挂着
 * 的那颗踩坏（底色与占位块也会在同一个 reconfigure 口上互相覆盖）。
 */
export function createDiffSurface(
  hostEl: HTMLElement,
  panel: Panel,
  spec: DiffSpec,
  opts: { ignoreTrimWhitespace?: boolean } = {},
): DiffSurface {
  disposeDiffSurface(panel);
  hostEl.classList.add("is-diff");
  const originalEl = document.createElement("div");
  originalEl.className = "diff-original";
  const sashEl = document.createElement("div");
  sashEl.className = "diff-sash";
  // `.diff-original` 恒为 hostEl 的第一个子节点（排在 `.panel-editor` 之前）：
  // 左右次序由 DOM 决定，`.panel-host.is-diff` 只管把这一格摊成 row-flex。
  hostEl.insertBefore(originalEl, hostEl.firstChild);
  hostEl.insertBefore(sashEl, originalEl.nextSibling);

  // 右缘 30px 的差异概览（VS Code 的 `diffOverview`）：左列原稿（删除色）、右列新稿（新增色），
  // 外加一颗视口滑块。放在 `.panel-editor` 之后 ⇒ 是 host 的最后一个 flex 子项，不吃正文宽度。
  const overviewEl = document.createElement("div");
  overviewEl.className = "diff-overview";
  const originalRulerEl = document.createElement("div");
  originalRulerEl.className = "diff-overview-ruler diff-overview-original";
  const modifiedRulerEl = document.createElement("div");
  modifiedRulerEl.className = "diff-overview-ruler diff-overview-modified";
  const viewportEl = document.createElement("div");
  viewportEl.className = "diff-viewport";
  overviewEl.append(originalRulerEl, modifiedRulerEl, viewportEl);
  hostEl.appendChild(overviewEl);

  const current = spec;
  /** 左栏那一臂的槽（随 state 进去；`reassert` 补基线换 state 时重新带上，见 `leftState`）。 */
  const leftFace = new Compartment();
  /** 左栏主题的槽（R22 取现值 + R23-2 换主题时 `reconfigure` 换掉，不重建整颗 state）。 */
  const themeSlot = new Compartment();
  /** 右栏那颗 view（`Panel.view` 的本身）：装上/摘掉这一臂都按它寻址，不跟着 `panel.view` 漂。 */
  const right = panel.view?.view ?? null;
  /**
   * 这一格现在挂的那张标签（与 `wantedSpec` 同一寻址）：**两栏的折行与主题都从它身上取现值**。
   * 这两件事的权威各自只有一处（`makeTabState` 的 `comps.wrap` / `comps.theme`，
   * `src/editor/editor.ts`），差异面只是借用同一个出口读一遍 —— 不另配一份。
   */
  const comps = tabs.get(panel.viewTabId ?? panel.activeTabId)?.comps ?? null;

  /**
   * 左栏的主题 = 右栏那颗 state 里主题 Compartment 的**现值**（预审 R22）。
   *
   * 为什么必须在 state 里装主题而不能在 CSS 里给 `.diff-original` 硬写一颗底色：两半的 18%
   * 改动色是**透明**的，叠在不同基色上就不是同一个颜色（左栏那一半原先直接画在页面底色上）；
   * 而硬写一份 = 第二处「当前主题是什么」的真相，dark / HC 族必然跟着错。取现值同样意味着
   * 「同一套」是**结构**上的同一套（`{ dark }` 那一参与主题族都由编辑器那一处定）。
   *
   * 读不到（没有右栏 / 那颗 Compartment 不在那份配置里）就交空扩展，与装主题之前一致，不抛错。
   */
  const themeOf = (): Extension => {
    if (!right || !comps) return [];
    return comps.theme.get(right.state) ?? [];
  };
  /** 挂上/最近一次补色时读到的主题，`reassert` 拿它比「右栏现在吃的是哪颗」。 */
  let lastTheme: Extension = themeOf();

  /**
   * 折行（R19：差异格两栏一律不折行）。
   *
   * 为什么必须关：设计稿 ⑥ 的头条是**两侧行行对齐**。折行一开，一个文档行就不止一个视觉行，
   * 而两栏宽度各自不同（还可拖）⇒ 同一行长文在两栏折出的行数天然不等，两栏的高度从第一条长行
   * 起就分家 —— 跳块（Task 4）与肉眼比对同时错位。三条推论：
   *   · **不给左栏镜像装上折行**（两栏宽度不同 ⇒ 「两边都折」永远不可能行行对齐）；
   *   · **不做** VS Code 那套按对侧实测行高来对齐的机制（B398 用户定过「参考 vscode，
   *     不要弄这么复杂」）；
   *   · 关折行之后「一行 = 一个视觉行」严格成立 ⇒ `face.ts` 里 `count * view.defaultLineHeight`
   *     那颗占位高度才是准的。
   * 代价明写：差异格里长行要横向滚 —— 这是取舍，不是遗漏。
   *
   * 落点：那颗 wrap Compartment 在右栏的实例上，与设置项**同一个出口**（`applyWrapToTabs` 走的
   * 就是它）⇒ attach 关掉、dispose 还回**设置**里的那一颗。
   *
   * ⚠️ 还值为什么读 `isWrap` 而不是读 attach 时那份现值（裁决 R23-1）：`switchTab` 切出时会把
   * **当前 view state** 回写进 `tab.state`（`src/tabs/lifecycle.ts`），被差异格强制关掉的那一发
   * 就这样漏进标签快照；下一次 attach 若从 state 读「他原来开着吗」，读到的是 `[]` —— 用户的
   * 自动换行设置在这个标签上就再也回不来了。设置的权威只有 `isWrap` 那一颗。
   */
  let wrapComp: Compartment | null = null;
  if (right && comps) {
    // 读出 `undefined` = 这颗 Compartment 根本不在那份配置里（面板显示的不是这张标签的 state）
    // ⇒ 这一手整段跳过：给配置里没有的 Compartment 发 reconfigure 等于凭空往 state 里装一颗。
    if (comps.wrap.get(right.state) !== undefined) wrapComp = comps.wrap;
  }
  const wrapOff = wrapComp ? [wrapComp.reconfigure([])] : [];
  // ⚠️ **函数**而不是在 attach 那一刻算好的数组：这一发在 dispose 时才落地，而 `isWrap` 可能在
  // 差异面挂着期间被用户改掉（那颗设置 setter 会先 `applyWrapToTabs` 再 `refreshDiffSurfaces`）。
  // 提前捕获就等于还回一份过期值 —— 正是 R23-1 要避免的两口径病，只是换了个方向。
  const wrapBack = () =>
    wrapComp ? [wrapComp.reconfigure(isWrap ? EditorView.lineWrapping : [])] : [];

  /**
   * 「忽略首尾空白」的现值（设计稿 ⑥ 那颗开关）。
   *
   * 它改变的是「同一份正文算出来的块」，而块只在这里算一次再交给两臂 ⇒ 开关一拨，
   * 两侧底色、占位块与侧栏条目自己跟上（同源口径）。缺省不设 = 不忽略，与 B458
   * 那 4px 一列一致；那颗图标键归 Task 8。
   */
  let ignoreWs = opts.ignoreTrimWhitespace ?? false;
  /**
   * 「现在这批块是什么」的唯一一份答案（设计稿 ⑥ 的同源口径）。
   *
   * 只有一份、只在 `syncBlocks()` 与挂上旁路那一刻算：两臂的读取口交回的是**这同一摞**
   * （`face.ts` 的 provider 是函数，不是快照），侧栏面板（Task 9）经 `notifyDiffBlocks`
   * 领到的也是它。于是「同刻跟上」不会有第二份真相，也不需要再拿两份全文串做比较来
   * 判「正文动过没有」—— 那一格缓存连同臂内那颗防抖一起由裁决 R24 撤掉：
   * **谁重算由 surface 这一处定**，别处只消费结果。
   */
  let stored: DiffBlock[] = [];
  const computeBlocks = (): DiffBlock[] =>
    // 没有右栏 = 没有可比的那一侧（`wantedSpec` 已经闸过，这里只兜直接调用那条测试路）。
    right
      ? diffBlocks(current.leftText(), right.state.doc.toString(), {
          ignoreTrimWhitespace: ignoreWs,
        })
      : [];
  stored = computeBlocks();
  const detachSash = attachSashDrag(originalEl, sashEl);

  /** 右栏那颗 view 的 state 回写进标签快照（与 `handleUpdate` / `lifecycle` 同一个寻址）。 */
  const writeBackRight = (): void => {
    if (!right) return;
    const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
    if (tab) tab.state = right.state;
  };

  // ---- Task 7 · 折叠未改动区（默认不折；开关与「折着哪几段」只活在这一格） ----
  /** 开关（缺省关 = 一段都不折）。不进设置，也不跨标签活：旁路拆掉就没了。 */
  let foldOn = false;
  /**
   * 手动展开过的未改动区（按**段序号**记账：首块之前 0、两块之间按前一块的序号、末块之后 = 块数）。
   *
   * 为什么记「展开过」而不是记「折起来」：开关开着 = 政策「够长的未改动区就折」，而键入之后
   * 块表会变 —— 记展开过 ⇒ 新长出来的未改动区自己会折上（与开关的语义一致），而用户刚点开的那
   * 一段不会被偷偷折回去。段序号会随块增减错位（块被拆成两块时展开记录跟着挪），这是本轮的
   * 已知边界，写进结果文档的「已知限制」。
   */
  const expandedRuns = new Set<number>();

  const lineCountOf = (side: DiffSide): number => viewOf(side)?.state.doc.lines ?? 0;

  /** 某一栏那颗 view（右栏可能是「没有右栏」那条兜底路 ⇒ 调用处一律允许读不到）。 */
  const viewOf = (side: DiffSide): EditorView | null => (side === "original" ? left : right);

  /** 某一栏的光标行（1-based；两栏的行轴各查各的）。 */
  const caretLineOf = (side: DiffSide): number => {
    const view = viewOf(side);
    if (!view) return 0;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  };

  /** 这一栏此刻真的折着哪几段（候选一律由 `diffBlocks` 交出来的块推出 —— 同源）。 */
  const foldedFor = (side: DiffSide): FoldRange[] =>
    foldOn
      ? foldCandidates(stored, side, lineCountOf(side)).filter((r) => !expandedRuns.has(r.run))
      : [];

  /**
   * 把「画面那一段」（一个行号或一段行号，本栏行轴）对回候选清单里的**那一段**。
   *
   * ⚠️ 不许按行号**精确**比对（修复轮 Important 2 抓的那一条）：折条带上来的 `from` 是它画上去
   * 那一刻的行号，而候选清单按现在的 `stored` 现算 —— 两者中间隔着一发键入就差几行（清单停在
   * 旧正文的行号上，画面与光标却跟着改动往前走，差的正是「上面插进来／并上来的那几行」）。
   * 精确比对 ⇒ `hit` 为 `undefined` ⇒ 点下去/查下去都**静默空转**：不报错、不展开，什么也不发生；
   * 防抖之后画法自己跟上，被吞掉的那一次点击却追不回来。
   * 两步走：① 整个落进某一段（含端点）就是那一段；② 否则取**间隔最小**的那一段（间隔 0 =
   * 有重叠）—— 宁可展开隔壁那一段，也不许点下去什么都不发生（下一次重算会把行号对上）。
   */
  const matchRun = (side: DiffSide, from: number, to = from): FoldRange | null => {
    const cands = foldedFor(side);
    const gapOf = (r: FoldRange): number => Math.max(r.from - to, from - r.to, 0);
    let best: FoldRange | null = null;
    for (const r of cands) {
      if (r.from <= from && to <= r.to) return r;
      if (best === null || gapOf(r) < gapOf(best)) best = r;
    }
    return best;
  };

  /**
   * 画面上真的折着的那一段对回候选清单 ⇒ 记下**那一段**（`run`）。
   *
   * 查的是 `foldedRangesIn`（画法自己），不是候选清单：键入之后两者行号不同一份（见 `matchRun`）；
   * 而「摘掉哪一段」还得回清单去记（`expandedRuns` 记的是段序号，不是行号）。
   * @returns 有没有真摘掉一段（没有 ⇒ 调用方不必点名）
   */
  const unfoldRunUnderLine = (side: DiffSide, line: number): boolean => {
    const view = viewOf(side);
    if (!view || line < 1) return false;
    const painted = foldedRangesIn(view.state);
    if (!painted.some((r) => line >= r.from && line <= r.to)) return false;
    const hit = matchRun(side, line);
    if (!hit || expandedRuns.has(hit.run)) return false;
    expandedRuns.add(hit.run);
    return true;
  };

  /** 发进那一臂的形态（只带本栏行轴的行号；`run` 是 surface 自己的记账抓手）。 */
  const foldPointsFor = (side: DiffSide): Array<{ from: number; to: number }> =>
    foldedFor(side).map(({ from, to }) => ({ from, to }));

  /**
   * 两栏一起点名：按现在的块表重画一次，并把「现在折着这些段」一起发进去。
   *
   * ⚠️ 两发必须在**同一次派发**里（`refreshDiff` 与 `setFoldedRanges`）：块表刚换、底色已经跟着
   * 新块走而折区还停在旧块上，那一帧画出来的就是错的那几行 —— 三处同刻跟上靠的是同一发事务。
   */
  const refreshArms = (): void => {
    const foldOf = (side: DiffSide): StateEffect<unknown>[] => [
      refreshDiff.of(null),
      setFoldedRanges.of(foldPointsFor(side)),
    ];
    left.dispatch({ effects: foldOf("original") });
    right?.dispatch({ effects: foldOf("modified") });
    writeBackRight();
    // 概览条的色块吃块表 + 折叠态，与两臂同一次收口；右栏的 scrollTop 可能刚被折条改掉，
    // 视口滑块顺便复算一帧。
    renderOverview();
  };

  /**
   * 落位/揭示前把「包住（或紧邻）这一行」的折区展开（简报 Step 3 的规则：
   * 凡 `from <= line <= to + DIFF_REVEAL_LINES` 的段都摘掉）。
   *
   * ⚠️ 两栏的行轴各查各的（`SIDES` 那一圈）：同一行号在左右两栏指的是不同的行，
   * 只按右栏摘 ⇒ 左栏的落点还能落进被 `display: none` 的行里。
   */
  const unfoldAroundLines = (lines: number[]): void => {
    if (!foldOn) return;
    const drop: number[] = [];
    for (const side of SIDES) {
      for (const r of foldedFor(side)) {
        if (drop.includes(r.run)) continue;
        if (lines.some((line) => r.from <= line && line <= r.to + DIFF_REVEAL_LINES)) {
          drop.push(r.run);
        }
      }
    }
    if (drop.length === 0) return;
    for (const run of drop) expandedRuns.add(run);
    refreshArms();
  };

  const unfoldAround = (line: number): void => unfoldAroundLines([line]);

  /**
   * 三处「谁让光标走进折区」的兜底（简报 Step 3 那条 ⚠️ 风险的正面处理）：
   * CM6 里 `display: none` 的行**仍在文档里** ⇒ 键入/点击/`ArrowDown` 都可能把插入符送进
   * 被折起来的那几行。落位之前有 `unfoldAround`，而**用户自己走进去**这一路只能靠右栏的
   * `updateListener` 检查 —— 那一段当场展开，别让它带着看不见的光标继续打字。
   *
   * ⚠️ 两颗入口都得查（修复轮 Important 1）：翻开关/`collapseAllUnchanged` **不动选区**，
   * 而差异文件里未改动的行占绝大多数 ⇒ 「光标正停在那一段里」是最常见的落点，只听
   * `updateListener` 这一发永远够不着 ⇒ 见 `guardCaretsUnderFolds`。
   * ⚠️ 查的是**画面上**那一段（`unfoldRunUnderLine`），不是候选清单：一发只映射选区的键入
   * （按 Delete 把折区第一行并上来）会把折区压到 stationary 的光标上，那一刻候选清单的行号
   * 还停在旧正文上，按清单查会读到「没盖住」而屏幕上那一行就是看不见。
   */
  const unfoldUnderCaret = (): void => {
    if (!foldOn) return;
    let dropped = false;
    for (const side of SIDES) {
      if (unfoldRunUnderLine(side, caretLineOf(side))) dropped = true;
    }
    if (dropped) refreshArms();
  };

  /**
   * 开关那两颗入口动手**之前**补的那一手（Important 1 的第一路）：按将要画出去的那份候选清单
   * 查两侧各自的光标行，盖住光标那一段先记进 `expandedRuns`（只记账，不派发 —— 收口还是
   * 调用方那一发 `refreshArms()`，两栏同一次派发这一条不许破）。
   *
   * 左栏也查：它硬只读、打字进不去，但它**可选可聚焦**（R12 那一手），光标同样会停在
   * 未改动的那一段里；那一栏没有监听（文档不会自己动），就借这两颗入口与右栏那一发兜住。
   */
  const guardCaretsUnderFolds = (): void => {
    if (!foldOn) return;
    for (const side of SIDES) {
      const line = caretLineOf(side);
      const hit = foldedFor(side).find((r) => line >= r.from && line <= r.to);
      if (hit) expandedRuns.add(hit.run);
    }
  };

  /**
   * 把某一栏落到第 `line` 行（裁决 R25 的落笔处，两颗 view 的落法**不一样**，这不是手滑）：
   *   · **左栏**（旁路那颗）走 `EditorView.scrollIntoView`：它不在同步滚动那套注册口里
   *     （两份**不同**的内容，见文件头），那一发晚一帧落位也没人记账 ⇒ 普通派发就够。
   *   · **右栏**（`Panel.view` 那颗 = 这份文档本身，在册）必须**同步写完再认领**：CM6 的
   *     `scrollIntoView` 只把 `scrollTarget` 存下来，真正写 `scrollTop` 排在 `measure()` 里
   *     （下一帧）⇒ 紧跟其后的认领读到的是**跳之前**的位置，账本就把「跳之前」登记成意图；
   *     下一帧真实的落位回声进来时既不是那个意图也不是那个像素 ⇒ 判成「用户自己滚的」⇒
   *     广播给同文档的其它视口（正是设计稿 ⑥/⑩·3 明令禁的那一发）。
   *     走的是仓库那条**真落位口** `landVisibleSideAtV`（同步写 + 同栈登记意图与真实落点 +
   *     没落进去就逐帧重试到收口；`markdown.ts` / `tabs/lifecycle.ts` / `tabs/split.ts`
   *     的所有落位都用它）。原来那个「认领我此刻停在哪」的口（`wire.ts` 里那颗）的语义是
   *     「我已经把位置写好了」，不许弯成「位置即将写好」⇒ 这条路里不用它，
   *     由上面那条真落位口自己登记（`tests/diff-surface.test.ts` 有守卫钉着这一手）。
   *
   * 共享坐标 `v` 给的是落点那一行（整数 = 「那一行的行顶贴容器顶」，与 `y: "start"` 同一档
   * 语义），`at` 给的是同一行的行首字符位置：两格宽度不同也能按字符对齐（B300），
   * 量不到矩形时锚点自己退回按 `v` 的比例落位。
   */
  const landSide = (side: DiffSide, line: number): void => {
    const view = side === "original" ? left : right;
    if (!view) return;
    const at = lineStartOf(view, line);
    if (side === "original") {
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "start" }),
      });
      return;
    }
    view.dispatch({ selection: { anchor: at } });
    writeBackRight();
    landVisibleSideAtV(panel, view.state.doc.lineAt(at).number, 0, at);
  };

  /**
   * 折条被点（两臂带进来的都是这一颗，各自认自己那一栏）：就地展开那一段，
   * 再把「上下各 `DIFF_REVEAL_LINES` 行」的揭示窗口第一行落到视野顶上。
   *
   * ⚠️ 揭示只做**本栏**：左栏那颗不在同步滚动那套注册口里，两栏本来就是各滚各的
   * （点一栏的折条把另一栏也滚走，等于偷偷给它发明一条同步规则）。
   *
   * ⚠️ 那一段靠 `matchRun` 认（修复轮 Important 2）：折条带下来的行号是**它自己画上去那一刻**
   * 的那一份，候选清单则是按现在的 `stored` 现算的 —— 两者中间隔着一发键入就差几行，
   * 按行号精确比对 ⇒ `undefined` ⇒ 点下去静默空转（不报错、不展开，什么也不发生）。
   */
  const expandFold = (side: DiffSide, from: number): void => {
    const hit = matchRun(side, from);
    if (!hit) return;
    expandedRuns.add(hit.run);
    refreshArms();
    landSide(side, Math.max(1, from - DIFF_CONTEXT_LINES - DIFF_REVEAL_LINES));
  };

  /** 两栏各自的折条出口（身份固定，见 `leftArm` 的那条 ⚠️）。 */
  const onOriginalFoldClick = (from: number): void => expandFold("original", from);
  const onModifiedFoldClick = (from: number): void => expandFold("modified", from);

  /**
   * 三颗动作 + 开关（简报 Interfaces 的那四颗）。
   *
   * ⚠️ 每一颗都以 `refreshArms()` 收口：改了状态就两栏一起点名，别留给下一次重算去补 ——
   * 「谁重算由 surface 这一处定」（R24），而这里改的是**画法**，不是块表。
   * ⚠️ 两颗「折起来」的入口在点名之前先 `guardCaretsUnderFolds()`（Important 1 的第一路：
   * 翻开关不动选区 ⇒ 监听那一发够不着，而光标停在未改动区里是最常见的位置）。
   */
  const setCollapseUnchanged = (on: boolean): void => {
    if (foldOn === on) return;
    foldOn = on;
    // 开关拨过去 = 重新按当前块表折一遍 / 全部放开；手动展开过的那几笔不跨开关记账
    //（开着又关掉再打开，用户要的是「照现在的正文重来一次」，不是把上次那些段一条条对上）。
    expandedRuns.clear();
    guardCaretsUnderFolds();
    refreshArms();
  };
  const collapseAllUnchanged = (): void => {
    foldOn = true;
    expandedRuns.clear();
    guardCaretsUnderFolds();
    refreshArms();
  };
  const showAllUnchanged = (): void => {
    // 连开关一起关：只清空折区而开关留着的下一发，「全部展开」会被重算偷偷折回去。
    foldOn = false;
    expandedRuns.clear();
    refreshArms();
  };

  /**
   * 左栏那一臂（**排在折叠块之后**：`onFoldBarClick` 那颗回调得先有身份）。
   *
   * ⚠️ 回调取的是 `onOriginalFoldClick` 这一颗**固定**的函数而不是每次现做一条闭包：
   * `DiffFoldWidget.eq` 比回调身份，换一颗就等于每次重画折条的 DOM；更要紧的是换出去的
   * 那颗闭包可能已经属于上一颗 surface（与右栏共用槽那种病同形）。
   * 挂 state 与 `resetLeftDoc` 换 state 都走这一处，两栏臂的组成只有一份定义。
   */
  const leftArm = (): Extension => [
    diffFace("original", () => stored),
    onFoldBarClick(onOriginalFoldClick),
  ];
  const left = new EditorView({
    parent: originalEl,
    state: leftState(current, leftFace.of(leftArm()), themeSlot.of(lastTheme)),
  });

  /**
   * 概览条的行轴：VS Code 的 overview ruler 画在**视图坐标**里（对齐占位块与折叠都计入），
   * 所以两列在同一高度上的色块才对得齐。这里同样把「文档行 → 视觉行」算出来：
   *   · 占位块：`sideGaps` 每段吃掉 `count` 行（两侧总行数因此相等）；
   *   · 折叠：被折的 `to - from` 行被一条折条顶替，净少 `to - from` 行。
   * 未改动的块不会落进折区（折区候选本身就是未改动区），因此块的跨度不必再剪折叠。
   */
  const visualAxis = (side: DiffSide): { total: number; rowOf: (line: number) => number } => {
    const view = viewOf(side);
    const gaps = sideGaps(stored, side);
    const folds = view ? foldedRangesIn(view.state) : [];
    const total =
      (view?.state.doc.lines ?? 0) +
      gaps.reduce((n, g) => n + g.count, 0) -
      folds.reduce((n, f) => n + Math.max(f.to - f.from, 0), 0);
    const rowOf = (line: number): number =>
      line +
      gaps.reduce((n, g) => n + (g.afterLine < line ? g.count : 0), 0) -
      folds.reduce((n, f) => n + (line > f.to ? Math.max(f.to - f.from, 0) : 0), 0);
    return { total, rowOf };
  };

  const paintRuler = (side: DiffSide, ruler: HTMLElement): void => {
    ruler.replaceChildren();
    const { total, rowOf } = visualAxis(side);
    if (total <= 0) return;
    for (const b of stored) {
      const start = side === "modified" ? b.modifiedStart : b.originalStart;
      const end = side === "modified" ? b.modifiedEnd : b.originalEnd;
      const len = end - start + 1;
      if (len <= 0) continue;
      const mark = document.createElement("div");
      mark.className = "diff-overview-mark";
      mark.style.top = `${((rowOf(start) - 1) / total) * 100}%`;
      mark.style.height = `${(len / total) * 100}%`;
      ruler.appendChild(mark);
    }
  };

  const renderViewport = (): void => {
    const scroller = right?.scrollDOM;
    if (!scroller) return;
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    if (scrollHeight <= 0 || clientHeight <= 0) {
      viewportEl.style.height = "0";
      return;
    }
    const height = Math.max((clientHeight / scrollHeight) * 100, 2);
    const span = Math.max(scrollHeight - clientHeight, 0);
    const top = span > 0 ? (scrollTop / span) * Math.max(100 - height, 0) : 0;
    viewportEl.style.top = `${top}%`;
    viewportEl.style.height = `${height}%`;
  };

  /** 概览条重画：批块、折叠、主题换壳都从这一颗口子收口（调用方统一在 `refreshArms`）。 */
  const renderOverview = (): void => {
    paintRuler("original", originalRulerEl);
    paintRuler("modified", modifiedRulerEl);
    renderViewport();
  };

  /**
   * 概览条兼作右栏的纵向滚动条（原生那条已由 `diff.css` 收成 0 宽）。
   * 指针按下即跳到对应高度、拖动连续跟手；滚轮转发给右栏 —— VS Code 的 `diffOverview`
   * 也是把 pointerdown / wheel 直接交给 modified editor 的滚动机构。
   */
  const scrollToClientY = (clientY: number): void => {
    const scroller = right?.scrollDOM;
    if (!scroller) return;
    const rect = overviewEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1);
    scroller.scrollTop = ratio * Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  };
  let draggingOverview = false;
  const onOverviewDown = (e: PointerEvent): void => {
    draggingOverview = true;
    overviewEl.setPointerCapture?.(e.pointerId);
    scrollToClientY(e.clientY);
  };
  const onOverviewMove = (e: PointerEvent): void => {
    if (draggingOverview) scrollToClientY(e.clientY);
  };
  const onOverviewUp = (e: PointerEvent): void => {
    draggingOverview = false;
    if (overviewEl.hasPointerCapture?.(e.pointerId)) overviewEl.releasePointerCapture(e.pointerId);
  };
  const onOverviewWheel = (e: WheelEvent): void => {
    const scroller = right?.scrollDOM;
    if (!scroller) return;
    e.preventDefault();
    scroller.scrollTop += e.deltaY;
  };
  const onRightScroll = (): void => renderViewport();
  overviewEl.addEventListener("pointerdown", onOverviewDown);
  overviewEl.addEventListener("pointermove", onOverviewMove);
  overviewEl.addEventListener("pointerup", onOverviewUp);
  overviewEl.addEventListener("pointercancel", onOverviewUp);
  overviewEl.addEventListener("wheel", onOverviewWheel, { passive: false });
  right?.scrollDOM.addEventListener("scroll", onRightScroll, { passive: true });
  const detachOverview = (): void => {
    overviewEl.removeEventListener("pointerdown", onOverviewDown);
    overviewEl.removeEventListener("pointermove", onOverviewMove);
    overviewEl.removeEventListener("pointerup", onOverviewUp);
    overviewEl.removeEventListener("pointercancel", onOverviewUp);
    overviewEl.removeEventListener("wheel", onOverviewWheel);
    right?.scrollDOM.removeEventListener("scroll", onRightScroll);
    overviewEl.remove();
  };

  /** 现读左右两份正文 → diffBlocks → 给两颗 view 各发 refreshDiff（+ 折叠态）→ 广播新块表。 */
  const syncBlocks = (): void => {
    stored = computeBlocks();
    // 两颗都要点名：装饰层不会自己醒（`refreshDiff` 与 `refreshGutterDiff` 同形），
    // 而对栏那颗 view **看不见**这一栏的键入 ⇒ 只有持有两颗 view 的这一处能一起发。
    // 折叠态同一次派发跟上：候选来自**同一份** `stored`，两栏与侧栏才不会各说各话。
    refreshArms();
    // Task 9 的侧栏面板从这里领新块表（surface **不 import** 面板模块 —— 单槽注册口，R6）。
    notifyDiffBlocks(current);
  };

  /**
   * 左栏那份文档跟着基线走（裁决 R20 的落笔处）。
   *
   * `leftText` 是**读取口**，所以块表自己会跟上（`computeBlocks` 现读）；但左栏那颗 view 的
   * **文档**是挂上那一刻写进去的一份快照，基线被就地换掉（Ctrl+S / 以磁盘为准重载）之后它还是旧的
   * ⇒ 下一发 `refreshDiff` 会用**新基线**算出的块去给**旧正文**上色。换文档只有 `setState` 这一条
   * 合法路（`dispatch({changes})` 会被 `leftState` 那道硬闸整发丢掉），换完再补一发 `syncBlocks()`。
   */
  const resetLeftDoc = (): void => {
    lastTheme = themeOf();
    left.setState(leftState(current, leftFace.of(leftArm()), themeSlot.of(lastTheme)));
    syncBlocks();
  };

  /** 右栏光标行（权威侧 = 右栏，设计稿 ⑩·2：左栏有选区也不参与）。 */
  const rightCaretLine = (): number => caretLineOf("modified");

  /** 右栏光标包住的那块；没有 ⇒ -1。 */
  const activeIndex = (): number => {
    if (!right) return -1;
    return blockAt(stored, "modified", rightCaretLine());
  };

  /**
   * 两侧同时落位到各自那段的起始行（设计稿 ⑥·面板）。
   *
   * 索引越界夹到首/末块（不环绕 —— 走到头再按一次就是停在那一块，与「跳过头」比环绕好懂）。
   *
   * ⚠️ 落位之前先 `unfoldAroundLines` 两侧各自那一行（Task 7 那一发，位置就钉在这里）：
   * 目标行被折进收起区时，`display: none` 的行仍在文档里 ⇒ 光标会「落到看不见的那一行」，
   * 而用户看到的是停在别处。两栏的行轴不同 ⇒ 两侧各查一遍，别只查右栏。
   *
   * 两颗 view 的落法不一样（左栏普通派发 / 右栏同步写 + 同栈认领，裁决 R25）—— 那一手的
   * 完整理由写在 `landSide` 上，跳块与点折条共用它，不各写一份。
   */
  const jumpTo = (index: number): void => {
    if (stored.length === 0) return;
    const b = stored[Math.min(Math.max(index, 0), stored.length - 1)];
    const lines = [landingLine(b, "original"), landingLine(b, "modified")];
    unfoldAroundLines(lines);
    landSide("original", lines[0]);
    landSide("modified", lines[1]);
  };

  /**
   * 以右栏光标行为起点找下一/上一块。
   *
   * 判据是**位置**而不是「当前序号 ±1」：光标停在两块之间（`activeIndex()` 为 -1）时，
   * 往后的意思就是「起点还在光标之后的第一块」，往回的是「终点已越过光标的那一块」，
   * 于是从任何位置按下去都有确定的一发，不需要为 -1 另设一套。
   *
   * ⚠️ 往回那一支多一条「落点就是当前这一行 ⇒ 跳过」：删掉的行在右栏**没有真行**，
   * 空段的落点 `end + 1` 恰好就是光标站着的那一行，落回去就是原地不动 —— 用户按的是
   * 「上一个差异」，那就得继续往前找到真会动的那一块为止（往那一支不会出这情况：
   * 候选的起点本来就严格在光标之后）。
   *
   * ⚠️ 这条与裁决 R26 各管一头，**不许混**：R26 改的是「光标停在那一行时那块算不算 active」
   * （读数），这条管的是「按下去之后到底动没动」（动作）。两条撞在同一行上正是设计意图：
   * 读数说「你在这块」，动作说「这块已经去过了，再往前找」。摘掉这条 ⇒ 往回原地不动；
   * 摘掉 R26 那条兜底 ⇒ 刚跳过去的块丢掉高亮（都有专门用例）。
   */
  const step = (dir: 1 | -1): void => {
    if (!right || stored.length === 0) return;
    const from = rightCaretLine();
    const landsAt = (b: DiffBlock): number =>
      right.state.doc.lineAt(lineStartOf(right, landingLine(b, "modified"))).number;
    let target = -1;
    if (dir === 1) {
      target = stored.findIndex((b) => b.modifiedStart > from);
    } else {
      for (let i = stored.length - 1; i >= 0; i--) {
        if (stored[i].modifiedEnd < from && landsAt(stored[i]) !== from) {
          target = i;
          break;
        }
      }
    }
    // 走到头 ⇒ 夹到末块/首块（与 `jumpTo` 的越界同一口径），不环绕。
    jumpTo(target < 0 ? (dir === 1 ? stored.length - 1 : 0) : target);
  };

  // 键入期只映射不重算：`update.docChanged` 只重置定时器，停手 `DIFF_REFRESH_MS` 才走
  // `syncBlocks()` 那一发（与 `gutterDiffField` 同一条纪律，B398）。这颗定时器是**全差异面
  // 唯一的一颗**（裁决 R24：`face.ts` 原先在自己那一臂里还藏了一颗，两把同时跑就是
  // 一次停手算两遍），所以它一响就得把**两颗** view 都带上（对栏看不见这边的键入）。
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelSync = (): void => {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = null;
  };
  const scheduleSync = (): void => {
    cancelSync();
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncBlocks();
    }, DIFF_REFRESH_MS);
  };

  /** 右栏那一臂的内容：装饰 + 折条出口 + 键入落点（`updateListener` 是 state facet，只能并进来）。 */
  const rightArm = (): Extension => [
    diffFace("modified", () => stored),
    onFoldBarClick(onModifiedFoldClick),
    // 仓库同形先例 `tests/preview-face-helpers.ts:71-76`：塞进 `state.update({extensions})`
    // 会被静默丢掉，必须走 effect。
    EditorView.updateListener.of((update) => {
      if (update.docChanged) scheduleSync();
      // 折叠期光标可能走进 `display: none` 的那几行（简报 Step 3 那条 ⚠️ 风险的另一半：
      // 落位之前有 `unfoldAround`，用户自己走进去这一路只能在这里补）。
      // ⚠️ `selectionSet` **一颗不够**（修复轮 Important 1 抓的第二路）：CM6 那一颗只认「这一发
      // 事务显式换了选区」—— 打字与程序化改文档时选区是被**映射**的，它是 false，而一发把折区
      // 压到光标上的改动（例如在折区上面那格上下文行的行尾按 Delete 并上来一行）正是这一类。
      // 两颗都听：`unfoldUnderCaret` 一进来就按 `foldOn` 早退，关着折叠时键入那一头分文不花；
      // 开着折叠时它只读几段行号与一次 `lineAt`，真正的重算仍旧排在防抖那一发（R24 不动）。
      if (update.selectionSet || update.docChanged) unfoldUnderCaret();
      // 左栏没有这一颗监听：那颗 view 的文档被硬闸钉住、不会自己动，光标停进折区也只是
      // 「选区看不见」（读不动的栏，打字那一条害处不成立）⇒ 它那一头由 `guardCaretsUnderFolds`
      // （两颗开关入口）与 `unfoldAroundLines`（落位）兜住。
    }),
  ];

  if (right) {
    // 一发事务里两件一起办：关掉这一栏的折行（R19）+ 把右栏那一槽换成本 surface 的臂。
    // 槽已在配置里 ⇒ `reconfigure`（顺带把上一颗 surface 留在快照里的旧 provider 顶掉，
    // 见 `rightFaceSlot` 的注释）；第一次挂 ⇒ `appendConfig` 把槽本身带进配置。
    const slotPresent = rightFaceSlot.get(right.state) !== undefined;
    right.dispatch({
      effects: [
        ...wrapOff,
        ...(slotPresent
          ? [rightFaceSlot.reconfigure(rightArm())]
          : [StateEffect.appendConfig.of(rightFaceSlot.of(rightArm()))]),
      ],
    });
  }
  // 换标签再换回来那一趟：`switchTab` 的同形回写会把**上一颗 surface 的折叠态**留在标签快照里
  //（`diffFoldField` 是模块级那颗，槽换挂时值不重建）⇒ 挂上这一刻必须按这一颗的口径重发一次
  // 折叠态（关着 ⇒ 两份空清单 = 把快照里那些 `display: none` 的行放回来）。
  refreshArms();

  /**
   * 补漂移（R20 / R22 / R23-2 的落笔处）。判据一律是「现值 ≠ 我挂上时那个样子」，
   * 一致就一个字节都不动 —— 这一发挂在 `applyPanelMode` 与 `refreshAll` 两条统一出口上，
   * 每次刷新都跑，空转必须是便宜的。
   */
  const reassert = (): void => {
    // ① 折行：只有被重新打开时才压回去（设置那一发刚落地时 `applyWrapToTabs` 之后就是这一手）。
    if (right && wrapComp && comps && comps.wrap.get(right.state) === EditorView.lineWrapping) {
      right.dispatch({ effects: wrapOff });
      writeBackRight();
    }
    // ② 主题：右栏换了色，左栏必须吃同一颗 —— 两半的 18% 改动色叠在不同基色上就不是同一个颜色。
    const themeNow = themeOf();
    if (themeNow !== lastTheme) {
      lastTheme = themeNow;
      left.dispatch({ effects: themeSlot.reconfigure(themeNow) });
    }
    // ③ 基线：`doc.baseline` 被就地换掉 ⇒ 左栏那份文档得跟上，否则新基线的块画在旧正文上。
    if (left.state.doc.toString() !== current.leftText()) resetLeftDoc();
  };

  const surface: DiffSurface = {
    left,
    spec: () => current,
    syncBlocks,
    blocks: () => stored,
    jumpTo,
    step,
    activeIndex,
    collapseUnchanged: () => foldOn,
    setCollapseUnchanged,
    collapseAllUnchanged,
    showAllUnchanged,
    foldRanges: () => foldPointsFor("modified"),
    unfoldAround,
    ignoreTrimWhitespace: () => ignoreWs,
    setIgnoreTrimWhitespace: (on) => {
      if (ignoreWs === on) return;
      ignoreWs = on;
      // 立刻重算（不等防抖）：这是用户点下来的一发动作，不是键入。
      syncBlocks();
    },
    reassert,
    dispose: () => {
      cancelSync();
      // 折叠状态跟着这一格退场（那颗 view 上的 `display: none` 已经随臂摘掉了，读口再报着
      // 折区就是两份真相 —— 拆掉的 surface 从此只报「没折」）。
      foldOn = false;
      expandedRuns.clear();
      // 右栏那颗 view **不随旁路销毁**（它是那份文档本身）⇒ 这一臂必须精准摘掉，
      // 否则底色与占位块会留在一张普通编辑器标签上。槽值清成空 ⇒ 键入监听与两臂装饰一起走。
      // 那颗 view 已经 destroy 过的话这一发是空转（CM6 内部的 `destroyed` 分支），不抛错。
      // 折行跟着还回**设置**里的那一颗（R19 + R23-1：读 `isWrap`，不读被同形回写污染的快照）。
      right?.dispatch({ effects: [rightFaceSlot.reconfigure([]), ...wrapBack()] });
      detachSash();
      detachOverview();
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

/**
 * 这一格当前的旁路（Task 4/7/8/9 都按它寻址）。
 *
 * 参数容忍 `undefined`：分发那一头的 `activePanel()` 本来就可能是「没有活动面板」，
 * 那一发读到的就是 `null`，调用方一律 `?.` —— 比在每个调用点先 `if (p)` 再取干净。
 */
export function diffSurfaceOf(panel: Panel | undefined | null): DiffSurface | null {
  return panel?.diffSurface ?? null;
}

/**
 * 这一格现在**该不该**有旁路，以及它该吃哪份 spec（不该有就返回 `null`）。
 *
 * 认「视图实际显示的那张标签」（`viewTabId`，缺省才落回 `activeTabId`）：旁路是挂在那颗
 * 右栏 view 旁边的对照物，跟着实际露出来的内容走才不会「显示 A、对照 B」（预审 R13，
 * 与 B232/B355 那条「按 `viewTabId` 寻址，否则会写到别人身上」同口径）。
 * `panel.view` 不在（空面板 / 已拆）时也一律不给 —— 没有右栏就没有可比的那一侧。
 */
function wantedSpec(panel: Panel): DiffSpec | null {
  if (!panel.view || !panel.bodyEl) return null;
  const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  const spec = tab && tab.kind === "diff" ? tab.diff : null;
  // A 档再问一次那道闸（评审 R31）：挂着的时候基线可以被**抹掉** —— 资源管理器把正开着
  // 差异面的文件删进回收站 ⇒ `orphan()` 置 `doc.baseline = null` 并调 `refreshAll()`。
  // 那颗读取口于是交出 `""`，`reassert` ③ 忠实地把左栏换成空文档，右栏每一行都被判成
  // 「新增」：一张全绿的脸。那一档没有「原样」可比 ⇒ 正确的样子是没这一排。
  if (spec?.tier === "baseline" && !canOpenAgainstBaseline(docs.get(spec.docId) ?? null)) {
    return null;
  }
  return spec;
}

/**
 * 挂/拆/补的**唯一**判据入口（Task 5 把三条同形路径接全：换标签不换面板、切档、重建布局）。
 *
 * 调用点（裁决 R13 / R14）：
 *   · `src/markdown.ts` 的 `applyPanelMode` **末尾**（DOM 已就位那一刻 —— 渲染回调跑在
 *     append 之前那条老坑：早动手就量不到、也挂不上）；
 *   · `src/tabs/lifecycle.ts` 的 `mountView` / `rebuildLayout` / `disposePanel`（Task 1 接的）；
 *   · `refreshDiffSurfaces()`（`ui.ts` 的 `refreshAll` 统一出口，保存路径不经 `applyPanelMode`）。
 * `switchTab` **不加** kind 分支：它已经靠 `rebuildLayout` / `setState` 两条路走，
 * 分支加在那里等于把 B232/B355 那两条顺序纪律再搅一遍。
 *
 * ⚠️ 判「是不是这张标签的旁路」用 spec 的**对象身份**：`tab.diff` 与 `surface.spec()` 必须
 * 指向同一个对象（换一张差异标签就是换一颗 spec —— 「交换左右」那一发开的是**另一张**标签，
 * 裁决 R38，所以这里没有「就地换 spec」那条形路可对身份）。
 * 对不上就重建 —— 宁可重建，也不许把 A 标签的对照物留在 B 标签上。
 *
 * 一致时**不是**直接返回：还要走一发 `reassert()` 把「设置页换了折行/主题」与「基线被就地
 * 换掉」这三处漂移补上（R20 / R23）。这一发是读值比较，空转很便宜。
 */
export function syncDiffSurface(panel: Panel): void {
  const want = wantedSpec(panel);
  const have = panel.diffSurface;
  if (!want) {
    if (have) disposeDiffSurface(panel);
    return;
  }
  if (have) {
    if (have.spec() === want) {
      have.reassert();
      return;
    }
    disposeDiffSurface(panel);
  }
  createDiffSurface(panel.bodyEl as HTMLElement, panel, want);
  // B461 · Task 9（裁决 R41）：**挂上**旁路那一刻就广播一次。
  // 不等下一次 `syncBlocks` 的理由：切回那张差异标签走的是「重建旁路」，块表在构造那一刻已经
  // 算好而没人再广播 ⇒ 侧栏那一列要等用户打一个字才回来。**拆**那一头不广播 —— 设计稿 ⑩·2
  // 定的是「光标离开差异标签时高亮保持最后那块」，抹掉它就是让用户丢了参照。
  if (panel.panelId === activePanelId) notifyDiffBlocks(want);
}

/**
 * 全窗口补一遍（`ui.ts` 的 `refreshAll` 出口，与 `refreshGutterDiffBaselines` 同一位、同一理）：
 * `doc.baseline` 被换掉时 CM6 不会自己醒，保存那条路又不经过 `applyPanelMode`。
 * 遍历的是在册面板 —— 隐藏实例（没有 `panel.view`）天然被 `wantedSpec` 闸掉，等它被挂载时
 * 由 `syncDiffSurface` 自己补第一发。
 */
export function refreshDiffSurfaces(): void {
  for (const panel of panels.values()) syncDiffSurface(panel);
}
