// B461 · 一张差异标签的运行时（Task 1 只管「挂上去 / 拆下来」这一对，Task 4/7 再往里加长）。
//
// 落点（设计稿 ⑧·1 的裁决，本轮的地基）：**`Panel.view` 继续是右栏那颗既有的 EditorView**
// （那份文档本身 —— 脏标记、Ctrl+S、撤销栈、会话快照全按它寻址，那一大片一行都不用加分支）。
// 差异标签只多一个**旁路**：挂在 `.panel-host` 内、`.panel-editor` **之前**的一颗
// `EditorView`（B 档两文件比较时它与右栏同权可编辑；A 档左栏是上次保存的快照，只读），
// 加一根只管这一栏之内的分割线。风险因此从「几十处都要记得问 kind」
// 降级成「一处挂、一处拆」。
//
// ⚠️ 左栏那颗 view **不进同步滚动那套注册口**：那套的语义是「同一文档的两个视口」，
// 而这里是两份**不同**的内容（设计稿 ② 的反目标）；跳块的落位走既有「显式落位」那一类（Task 4）。
// B 档左栏可编辑之后，它与那份文档的其余实例靠 `notifyDiffDocChanged` 互同步 ——
// 那是「同一份文档的第二颗 view」，但仍不走同步滚动（滚动跟随是另一件事）。
//
// 两臂的装饰面（Task 3：两侧行底色 / 行号槽记号 / 对侧占位块）与右缘差异概览**在这里装上，
// 但不在这里建**：
// `face.ts` 出 `diffFace(side, blocks)`，本模块只管「哪颗 view 装哪一臂、什么时候装/拆」，
// 并把「现在这批块是什么」那一读取口交出去（预审 R1：两颗 Compartment 由本模块自己创建，
// `makeTabState` / `makeDiffInstance` 的扩展清单一个字都不改）。
// ⚠️ 右栏那颗 view 是**既有的** `Panel.view`，Task 1 没给它预留 diff 专用 Compartment
// （预留 = 空转的抽象）⇒ 装它只能走 CM6 唯一可行的「先建视图、后加配置」那一发
// `StateEffect.appendConfig`，并且把新 Compartment 一起并进去，好在拆旁路时精准摘掉这一臂。

import {
  Compartment,
  EditorState,
  StateEffect,
  type ChangeSet,
  type Extension,
} from "@codemirror/state";
import {
  BlockType,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { highlightSelectionMatches } from "@codemirror/search";
import { detectLanguage } from "../editor/language";
import { baseExtensions, gutterExtensions } from "../editor/editor";
import { findHighlight } from "../editor/find";
import { roundedSelection } from "../editor/roundedSelection";
import {
  layoutOverview,
  overviewWordMatches,
  overviewZones,
  paintOverview,
} from "../editor/overview";
import { perfOfDiffInstance } from "../doc-model";
import type { PerfProfile } from "../editor/perf";
import {
  activePanelId,
  docs,
  isWrap,
  panels,
  showInvisibles,
  tabs,
  windowLabel,
  type Panel,
} from "../core/app-state";
import { logger } from "../core/logger";
import { invisibleChars } from "../editor/invisibleChars";
import { landVisibleSideAtV } from "../sync-scroll/wire";
import { DIFF_REFRESH_MS, splitLines } from "./align";
import { blockAt, diffBlocks, type DiffBlock } from "./blocks";
import { innerChanges, type InnerResult } from "./inline";
import {
  DIFF_REVEAL_LINES,
  FOLD_BAR_HEIGHT,
  diffFace,
  foldCandidates,
  foldedRangesIn,
  foldGaps,
  gapZones,
  onFoldBarClick,
  onFoldMarkClick,
  refreshDiff,
  setFoldedRanges,
  setFoldMarks,
  textBlockOf,
  type FoldMark,
  type FoldPoint,
  type FoldRange,
  type FoldReveal,
  type GapZone,
} from "./face";
import {
  applyDiffDocEdit,
  canOpenAgainstBaseline,
  notifyDiffBlocks,
  type DiffSide,
  type DiffSpec,
} from "./model";
import { revertEdit } from "./revert";
import { createWrapMeter, type WrapMeter } from "./wrap-measure";
import { CODICONS } from "../shell/codicons";
import { setTip } from "../shell/tooltip";

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
  /** 左栏那颗视图（测试与 Task 4/7 的落位都直接按它寻址） */
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
   * 查找该作用在哪一栏：**最后一次聚焦的那一侧**（默认右栏）。
   *
   * 上游的查找挂在 `focusedEditor` 上（`diffEditorWidget` 的 `getFocusedCodeEditor()`），
   * 切到左栏后 Ctrl+F 就在左栏里搜；这里暴露同一颗状态给 `find/findbar.ts` 取目标 view。
   * 焦点落在两栏之外（查找输入框、侧栏）时保持上一次的值 —— 上游也是「最后聚焦的那一颗」。
   */
  focusedSide(): DiffSide;
  /** 两栏同步滚动现在开着没有（默认开 —— VS Code 的差异编辑器恒同步）。 */
  syncScrollEnabled(): boolean;
  /** 关掉后两栏各滚各的；重新打开时立刻对齐一次。 */
  setSyncScrollEnabled(on: boolean): void;
  /**
   * 显式落位（`landVisibleSideAtV`）收口后调用：把左栏扶到右栏视口顶对应的内容位置。
   *
   * 落位的那一栏是权威，不按「最后驱动侧」反推 —— 用户上一次可能滚的是左栏，而落位
   * 刚把右栏明确放到另一个位置。扶完左栏才算「这一格」收口（见 `revealLeft`）。
   *
   * 左栏还没被量准过（首次落位、还没露过）时不写，只排一轮测量：那一发会被浏览器夹到
   * 当前可滚上限，回声还会把驱动侧翻走。扶位与露出改由两栏测量同时收口的那一发完成。
   */
  syncLeftToRight(): void;
  /**
   * 把这一格**已经漂移**的三件事补回「差异格该有的样子」（裁决 R20 / R22 / R23，内部口）。
   *
   * 点它的两处：`syncDiffSurface`（每次刷新都跑）与「刷新」那颗动作（Task 8 · 裁决 R37，
   * 读口刚换过快照 ⇒ 靠这一手把左栏那份文档跟上）。那张标签还是这一格现在露出的那张
   * （`spec()` 对得上）时，旁路不重建，但下面三条可能在无人认领的期间被改坏 ——
   *   · 左栏的**折行**停在旧值（全局开关改的是右栏借用那颗 `comps.wrap`，左栏自己有一颗）；
   *   · 右栏的**主题**被换掉（`applyDarkToTabs`），而左栏吃的是挂上那一刻的现值；
   *   · `doc.baseline` 被就地换成新正文（保存 / 以磁盘为准重载），而左栏那份**文档**还是旧的。
   * 第三条最狠：块表是按新基线算的、左栏正文还是旧基线 ⇒ 装饰会画在错的那几行上，且屏上
   * 看不出所以然（B458 那轮「基线换了而标注没换」的同形病）。
   */
  reassert(): void;
  /**
   * 外观（字号 / 代码字体 / 行距）或窗口尺寸变了之后，重新实测两栏行高并对齐。
   *
   * 与 `reassert` 分开：那一条是「补漂移」，可能整态重建左栏；这一条只排一次测量，
   * 给 Ctrl+滚轮改字号那种高频动作一个便宜入口（`appearance.ts` 的三颗 setter 点它）。
   */
  remeasure(): void;
  dispose(): void;
}

/** 分割线可拖的范围：左栏占这一栏宽度的 15%–85%（简报 Step 7 定死）。 */
const MIN_SHARE = 15;
const MAX_SHARE = 85;

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
 * 左栏那颗 view 的 state。
 *
 * **能不能编辑只由「栏背后有没有文档」决定**（用户口径 2026-11）：
 *   · B 档（`spec.leftDocId != null`）—— 左栏就是另一份文档，与右栏同权：带完整编辑扩展；
 *   · A 档（基线快照）—— 只读**不是**「两手」，是三道一起给（R12：「左栏只读」是设计稿 ⑤
 *     的事实项、⑦·⑤ 的验收对象）：
 *     · `EditorView.editable(false)`：内容 DOM 落 `contenteditable="false"` ⇒ 敲字进不去。
 *     · `EditorState.readOnly`：CM6 的口径是「**commands 与扩展**在动手之前问这一颗」，
 *       它**不**否决裸 `view.dispatch`。
 *     · `EditorState.transactionFilter`（丢掉 `docChanged`）：这一道才兑现绑定约束那句
 *       「任何事务都不许改动基线正文」。少了它，前两道只是「看起来不能打字」——
 *       查找替换、脚本改文档、任何后来接上这颗 view 的写点都能直接重写基线正文。
 *
 * `EditorView.contentAttributes` 那颗 `tabindex: "0"`：`editable(false)` 把 contentDOM 写成
 * `contenteditable=false`，而 CM6 聚焦靠的正是点下去那一下 `focus()` —— 不可编辑又没有
 * tabindex 的元素 `focus()` 是空操作 ⇒ 左栏点不进焦点、选不出字、复制不了（⑦·⑤ 要的正是
 * 「选得中才复制得了」）。`src/preview/wysiwyg.ts:44-48` 把「两道都必要」记过一遍，这里同方。
 * 可编辑那一支也留着它：与右栏同一颗口径，且查找框把焦点交回来时行为一致。
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
 * `wrap` 是这一栏的折行槽：值来自**全局设置** `isWrap`，「查看 → 自动换行」一变就由
 * `reassert` 对着设置重配一次 —— 差异格没有自己的折行开关。
 *
 * `invisibles` 是「显示不可见字符」那一档：同样是全局开关，右栏借标签自己的槽，
 * 左栏这颗旁路由 `reassert` 补发（与折行同一发补齐）。
 *
 * `perf` 与右栏**同一档**（两栏都由 `perfOfDiffInstance` 给）：折叠在这一档里恒为关，
 * 依据是上游的差异子编辑器写死 `folding = false`（`diffEditorEditors.ts` 的
 * `_adjustOptionsForSubEditor`）—— 差异格里根本没有折叠槽，也就没有「一列没有差异行底色的
 * 孤立折槽」这件事。其余档位（语法高亮的开关）两栏必须同档，否则一边有一边没有更像 bug。
 */
function leftState(
  spec: DiffSpec,
  perf: PerfProfile,
  face: Extension,
  theme: Extension,
  wrap: Extension,
  invisibles: Extension,
  writable: boolean,
): EditorState {
  // 左栏按**自己的文件类型**解析，不从右栏借语言（VS Code 的差异编辑器给两份 model 各挂
  // 自己的 language id：`DiffEditorViewModel` 直接读 `originalModel.getLanguageId()` /
  // `modifiedModel.getLanguageId()`，两侧 token 化互不影响）。B 档跨扩展名比较时（.md ↔ .ts），
  // 两栏因此各是各的高亮；A 档两侧同名，自然同一套。
  const language = detectLanguage(spec.leftName).extension;
  return EditorState.create({
    doc: spec.leftText(),
    extensions: [
      EditorView.contentAttributes.of({ tabindex: "0" }),
      ...(writable
        ? // 与右栏同一套编辑扩展（历史、键位、括号、多选、查找命中……只差 gutter/语言/主题
          // 那几颗由下面按本栏追加）—— 左栏可编辑之后，撤销栈与快捷键必须与右栏同款。
          baseExtensions(perf)
        : [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
            // 只读 ≠ 看不见：VS Code 的原稿栏是一颗完整的子编辑器，只关编辑；当前行、选区、
            // 同词出现这三层高亮照编辑器选项生效（`diffEditorEditors.ts` 的
            // `_adjustOptionsForSubEditor` 不动 `selectionHighlight` / `occurrencesHighlight`）。
            // `drawSelection()` 是选区高亮的地基（右栏 `baseExtensions` 那一颗同源）：少了它，
            // 选中只走浏览器原生高亮，`.cm-selectionBackground` 这套主题色全不生效。
            // 圆角层跟着它走：右栏在 `baseExtensions` 里成对挂，这里也得成对。
            drawSelection(),
            roundedSelection(),
            ...(perf.activeLine ? [highlightActiveLineGutter(), highlightActiveLine()] : []),
            // 同词出现的正文层与概览标尺同闸（右栏 `editor.ts` 同一对）：正文不亮时右缘也不许亮。
            ...(perf.selectionMatches
              ? [highlightSelectionMatches(), overviewWordMatches.of(true)]
              : []),
            // 查找命中（正文高亮 + 概览标记）也挂在这一栏：查找作用于**当前聚焦的那一侧**，
            // 焦点在左栏时 `find/findbar.ts` 会把查询派给这颗 view。少了这些字段，派过来的
            // `setFindQuery` 只会静默空转 ⇒ 左侧搜不到、也没有命中标记。
            findHighlight(),
          ]),
      // 行号走与右栏**同一颗**工厂（`gutterExtensions`）—— `perf` 已由 `perfOfDiffInstance`
      // 把折叠关掉，所以这里只会给出行号槽，与上游差异子编辑器的 folding = false 同口径。
      ...gutterExtensions(perf),
      ...(perf.syntax && language ? [language] : []),
      theme,
      wrap,
      invisibles,
      face,
    ],
  });
}

/**
 * 左栏那颗 view 与它背后文档的**双向链**的一半：文档在别处被改了，补进挂着它的左栏。
 *
 * 为什么需要：B 档左栏可编辑之后，它与那份文档自己的标签是两颗 view。`syncDocInstances`
 * 只认 `tabs` 里的实例，够不到旁路这颗 view —— 不补这一发，另一格改同一份文件时
 * 差异左栏会停在旧正文，而块表读的却是新正文（底色与正文错行）。
 *
 * 另一半（左栏 → 文档）在左栏的 `updateListener` 里，走 `applyDiffDocEdit`。两个方向都带
 * 「别回声」的闸：本 surface 自己发出去的那一笔，回来时不再应用第二次。
 */
interface LeftMirror {
  apply(changes: ChangeSet): void;
}
const leftMirrors = new Map<number, Set<LeftMirror>>();

/** 文档正文在别处改了 ⇒ 把同一笔改动补进所有挂着它的左栏（`syncDocInstances` 末尾点名）。 */
export function notifyDiffDocChanged(docId: number, changes: ChangeSet): void {
  for (const mirror of leftMirrors.get(docId) ?? []) mirror.apply(changes);
}

/**
 * 挂起这一格之内的分割线（不复用 splitview 那套 sash：那一套管面板树，这一根只管一栏之内）。
 * 宽度不落设置 —— 本轮「记住宽度」不是需求。
 *
 * ⚠️ 按**像素位移**换算，不写百分比（旧实现写 `flexBasis = share%`，而两栏都是
 * `flex: 1 1 50%`：百分比 basis 之外剩下的自由空间还会被 `flex-grow` 对半分，于是
 * 指针走 1px、分割线只走 0.5px —— 既跟不上手，也让「按一次拖到哪儿」对不上指针）。
 * 现在两侧各写一支像素 basis 且**和等于正文宽**，自由空间为 0 ⇒ 指针位移 1:1 落到宽度。
 * 每轮都从实测宽度重新起算 ⇒ 反复拖不累积漂移；窗口尺寸变了以后下一次拖动照样准确。
 *
 * 中间那 35px 回退列与右缘 30px 概览**不参与**：正文宽取两栏实测宽度之和，不拿整格宽度
 * 按比例折算（旧口径的第二个偏差来源）。
 *
 * `onResize` 在松手（含 `pointercancel`）时点一次：栏宽一变换行结果全变，调用方要按新宽度
 * 重量占位缝与概览轴。拖动途中不点 —— 每像素重测全文档折行会卡，且途中视觉本来就在变。
 * @returns 解除 `pointerdown` / `dblclick` 绑定的动作（dispose 时调用）
 */
function attachSashDrag(
  originalEl: HTMLElement,
  modifiedEl: HTMLElement | null,
  sashEl: HTMLElement,
  onResize: () => void,
): () => void {
  /** 两支 basis 都写成 `content / 2`：正文宽（两栏实测宽之和）对半分，中间列/概览不参与。 */
  const resetToMiddle = () => {
    const left = originalEl.getBoundingClientRect().width;
    const right = modifiedEl?.getBoundingClientRect().width ?? 0;
    const content = left + right;
    if (!(content > 0) || !(left > 0)) return;
    const half = content / 2;
    originalEl.style.flexBasis = `${half}px`;
    if (modifiedEl) modifiedEl.style.flexBasis = `${content - half}px`;
    // 与松手同口径：栏宽换了一半，折行高度与占位缝都要按新宽度重算。
    onResize();
  };
  const onDown = (event: PointerEvent) => {
    // 量不到宽度（隐藏格 / jsdom 里 `getBoundingClientRect` 恒 0）就这一下不动手：
    // 拿 0 当基准会把 flex-basis 写成 NaN px，那一格从此不受控。
    const left = originalEl.getBoundingClientRect().width;
    const right = modifiedEl?.getBoundingClientRect().width ?? 0;
    const content = left + right;
    if (!(content > 0) || !(left > 0)) return;
    const startX = event.clientX;
    const min = (MIN_SHARE / 100) * content;
    const max = (MAX_SHARE / 100) * content;
    const onMove = (move: PointerEvent) => {
      const next = Math.min(max, Math.max(min, left + (move.clientX - startX)));
      // 两支 basis 之和恒等于正文宽 ⇒ 自由空间为 0，`flex-grow` 不再改写结果。
      originalEl.style.flexBasis = `${next}px`;
      if (modifiedEl) modifiedEl.style.flexBasis = `${content - next}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // 栏宽变了 ⇒ 两栏的折行结果全变，占位缝与概览轴都必须按新宽度重量一遍；
      // 不补这一发，拖完分屏就停在「旧宽度算出来的缝」上 —— 行数看着对不齐。
      // 放在松手时只算一次：拖动途中每一像素都重量一遍全文档折行会卡。
      onResize();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    event.preventDefault();
  };
  sashEl.addEventListener("pointerdown", onDown);
  sashEl.addEventListener("dblclick", resetToMiddle);
  return () => {
    sashEl.removeEventListener("pointerdown", onDown);
    sashEl.removeEventListener("dblclick", resetToMiddle);
  };
}

/** 回退键的提示与可访问名称同源（上游那颗 `title` 的本地化那一句）。 */
const REVERT_LABEL = "回退此块";

/**
 * 一栏在**实测像素轴**上的几何：第 `line` 行的行首位置、行高、整篇总高（1-based 行号）。
 *
 * 概览色带与标记层共用这一份：两处若各取一套，色带与光标条就会在同一条概览上错开。
 */
interface OverviewAxis {
  total: number;
  topOf(line: number): number;
  heightOf(line: number): number;
}

/**
 * 这一格滚动收口链的日志出口。
 *
 * 这套链路的故障（左栏一直藏着 / 位置被拽走）在无头探针里复现不出来 —— 它依赖真机的
 * 测量节奏与面板尺寸。链上看不见的每一步都打一条 trace，用户复现时能从日志里读出
 * 「链停在哪一步」，而不是只剩「位置最终不对」这一个事实。
 * 前缀带窗口身份：多窗口共用同一个 `litepad.log`（与 `sync-scroll/wire.ts` 的 `syncTrace` 同因）。
 */
function diffTrace(panel: Panel, msg: string): void {
  logger.trace("diff", `[${windowLabel}] P${panel.panelId}: ${msg}`);
}

/**
 * 在 `hostEl`（splitview 交下来的 `.panel-host`）里挂上差异旁路，并把 surface 记到 panel 上。
 *
 * `opts.ignoreTrimWhitespace` 从 Task 3 起**消费**：它改变的是「同一份正文算出来的块」，
 * 而块只在这里算一次再交给两臂 ⇒ 开关一拨，两侧底色与侧栏条目自己跟上（设计稿 ⑥ 的同源）。
 * 开关本身归 Task 8 那颗图标键，缺省**忽略**首尾空白（与上游 `diffEditor.ignoreTrimWhitespace`
 * 的默认值一致）；B458 那 4px 一列另有口径，不吃这颗开关。
 *
 * ⚠️ 一格**只许一排旁路**（裁决 R23-3）：进来先拆在任的那颗。不拆的话两颗 live surface 共用
 * 右栏那一槽，先 dispose 的那颗会把还挂着的那颗的底色与占位块一起摘掉（同一个 reconfigure 口
 * 上互相覆盖）。
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
  // 中间那一列 = VS Code 的 `DiffEditorGutter`（35px）：分割线住在它里面，差异块的
  // 「回退」按钮也绝对定位在这一列上。为什么要一整列而不是把按钮挂在某一次栏上：
  // VS Code 的 gutter 是两栏**之间**的独立区域，item 的坐标只跟行高走，不跟哪一栏的
  // 内边距走；单独一列才量得准、也不会被某一栏的横向滚动带走。
  const centerEl = document.createElement("div");
  centerEl.className = "diff-center";
  const sashEl = document.createElement("div");
  sashEl.className = "diff-sash";
  const revertLayerEl = document.createElement("div");
  revertLayerEl.className = "diff-reverts";
  centerEl.append(sashEl, revertLayerEl);
  // `.diff-original` 恒为 hostEl 的第一个子节点（排在 `.panel-editor` 之前）：
  // 左右次序由 DOM 决定，`.panel-host.is-diff` 只管把这一格摊成 row-flex。
  hostEl.insertBefore(originalEl, hostEl.firstChild);
  hostEl.insertBefore(centerEl, originalEl.nextSibling);

  // 右缘 30px 的差异概览（VS Code 的 `diffOverview`）：左列原稿（删除色）、右列新稿（新增色），
  // 外加一颗视口滑块。放在 `.panel-editor` 之后 ⇒ 是 host 的最后一个 flex 子项，不吃正文宽度。
  const overviewEl = document.createElement("div");
  overviewEl.className = "diff-overview";
  const originalRulerEl = document.createElement("div");
  originalRulerEl.className = "diff-overview-ruler diff-overview-original";
  const modifiedRulerEl = document.createElement("div");
  modifiedRulerEl.className = "diff-overview-ruler diff-overview-modified";
  // 标记层（选区/光标/查找命中/同词出现）单独一颗画布，压在差异色块之上、滑块之下。
  // 色块仍是既有的 `.diff-overview-mark`（上面那段注释的像素口径不动），这一层只管新增标记：
  // 命中可能有几千条，逐条 DOM 会抖，而画布一次 `paintOverview` 就够（合并规则见 overview.ts）。
  const originalCanvasEl = document.createElement("canvas");
  originalCanvasEl.className = "diff-overview-canvas";
  originalCanvasEl.setAttribute("aria-hidden", "true");
  originalRulerEl.appendChild(originalCanvasEl);
  const modifiedCanvasEl = document.createElement("canvas");
  modifiedCanvasEl.className = "diff-overview-canvas";
  modifiedCanvasEl.setAttribute("aria-hidden", "true");
  modifiedRulerEl.appendChild(modifiedCanvasEl);
  const viewportEl = document.createElement("div");
  viewportEl.className = "diff-viewport";
  overviewEl.append(originalRulerEl, modifiedRulerEl, viewportEl);
  hostEl.appendChild(overviewEl);

  const current = spec;
  /**
   * 左栏能不能编辑：背后有文档、且那份文档不是只读（B 档两文件比较）。A 档的基线快照没有
   * 落点 ⇒ 只读；旧会话恢复出来的 B 档同样（`leftDocId === null`，只有一次读盘快照）。
   */
  const leftDoc = current.leftDocId != null ? (docs.get(current.leftDocId) ?? null) : null;
  const leftWritable = !!leftDoc && !leftDoc.readonly;
  /**
   * 旁路是否已经挂完（`scheduleAlign` 在文件后半才声明）。
   *
   * 建视图时 CM6 会跑首轮 update，那时 `scheduleAlign` 还在 TDZ 里；几何回调只在挂完之后
   * 有意义，这一颗把首轮挡掉。
   */
  let armed = false;
  /**
   * 左栏吃哪一档性能档案 —— **与右栏那颗 state 同一颗函数**（`perfOfDiffInstance`，
   * `makeDiffInstance` 用它造右栏）。档位只由文档决定、不随交互变。
   */
  const leftPerf = (): PerfProfile => perfOfDiffInstance(docs.get(current.docId));
  /** 左栏那一臂的槽（随 state 进去；`reassert` 补基线换 state 时重新带上，见 `leftState`）。 */
  const leftFace = new Compartment();
  /** 左栏主题的槽（R22 取现值 + R23-2 换主题时 `reconfigure` 换掉，不重建整颗 state）。 */
  const themeSlot = new Compartment();
  /** 左栏折行的槽：开关一拨只换槽值，不重建整颗 state（与右栏 `comps.wrap` 同一口径）。 */
  const leftWrap = new Compartment();
  /** 左栏「显示不可见字符」的槽（全局开关，`reassert` 对着 `showInvisibles` 补一次）。 */
  const leftInvisibles = new Compartment();
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
   * 折行只有**全局那一颗**开关（`isWrap` / 「查看 → 自动换行」），差异格不再自带一颗。
   *
   * 右栏借标签自己的 `comps.wrap`（`applyWrapToTabs` 的同一个出口）⇒ 设置一变它自己跟上；
   * 左栏那颗 `leftWrap` 是旁路自己的 state，得在 `reassert` 里对着 `isWrap` 补一次
   *（`applyWrapToTabs` 末尾会点 `refreshDiffSurfaces`）。
   */
  const wrapValue = (): Extension => (isWrap ? EditorView.lineWrapping : []);

  /** 与 `wrapValue` 同形：值来自全局开关，`reassert` 靠 `=== invisibleChars()` 判现值。 */
  const invisiblesValue = (): Extension => (showInvisibles ? invisibleChars() : []);

  /**
   * 「忽略首尾空白」的现值（设计稿 ⑥ 那颗开关）。
   *
   * 它改变的是「同一份正文算出来的块」，而块只在这里算一次再交给两臂 ⇒ 开关一拨，
   * 两侧底色、占位块与侧栏条目自己跟上（同源口径）。**缺省忽略**：上游
   * `diffEditor.ignoreTrimWhitespace` 的默认值就是 `true`，所以新建一张差异标签时
   * 首尾空白差异不算改动（要连空白一起比就点标题栏那颗「显示首尾空白差异」）。
   */
  let ignoreWs = opts.ignoreTrimWhitespace ?? true;
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
  /**
   * 行内字符级差异（`inline.ts`）：块内配对行再跑一次词级 diff 的结果，两臂同一份。
   *
   * 与 `stored` 同一刻算：行内区间挂的是 `stored` 的行号，晚一拍就会落在新块的旧行号上。
   * 取行文本用**块表所依据的那两份正文**（`leftText()` 与右栏文档）而不是左栏 view 的
   * 当前文档 —— 基线被就地换掉、`resetLeftDoc` 还没跑的那一瞬，左栏 view 里还是旧正文。
   */
  const computeInner = (blocks: DiffBlock[]): InnerResult => {
    if (!right) return { changes: { original: [], modified: [] }, alignments: [] };
    const original = splitLines(current.leftText());
    const modified = splitLines(right.state.doc.toString());
    return innerChanges(
      blocks,
      {
        original: (line) => original[line - 1] ?? "",
        modified: (line) => modified[line - 1] ?? "",
      },
      ignoreWs,
    );
  };
  let inner = computeInner(stored);

  /**
   * 两侧当前的对齐缝（实测像素；`face.ts` 的占位块吃它）。
   *
   * 它是**测量结果**而不是块表的一部分：块表只说「哪几行对不上」，缝还要知道那几行各自
   * 折成了几个视觉行 —— 后者只有持有两颗 view 的这里量得到。块表一换（`refreshArms`）
   * 就重新量一次；折行/字号/窗口尺寸变了同理，见 `scheduleAlign`。
   */
  let gapPlans: Record<DiffSide, GapZone[]> = { original: [], modified: [] };
  // 右栏 = 面板自己那颗 `.panel-editor`（host 的直接子项，排在回退列之后）：分割线要同时写
  // 两支像素 basis，才能让自由空间归零、指针位移 1:1 落到宽度上。
  const detachSash = attachSashDrag(
    originalEl,
    Array.from(hostEl.children).find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("panel-editor"),
    ) ?? null,
    sashEl,
    // 松手后重量：栏宽变了，两栏的折行高度与占位缝都要按新宽度重算（`scheduleAlign`
    // 在函数后半段才声明，但这一发要到用户松手才执行）。
    () => scheduleAlign(),
  );

  /** 右栏那颗 view 的 state 回写进标签快照（与 `handleUpdate` / `lifecycle` 同一个寻址）。 */
  const writeBackRight = (): void => {
    if (!right) return;
    const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
    if (tab) tab.state = right.state;
  };

  // ---- Task 7 · 折叠未改动区（默认不折；开关与「每段揭示了几行」只活在这一格） ----
  /** 开关（缺省关 = 一段都不折）。不进设置，也不跨标签活：旁路拆掉就没了。 */
  let foldOn = false;
  /**
   * 每一段未改动区已经**揭示**了多少行（按段序号记账：首块之前 0、两块之间按前一块的序号、
   * 末块之后 = 块数）。
   *
   * 口径照上游 `UnchangedRegion.visibleLineCountTop / Bottom`：上下各自累计、各自收缩，
   * 缺省 `{0,0}` = 整段可折；`top + bottom >= 段长` 的那一段不再出折条（上游
   * `shouldHideControls`），但**记账留着** —— 删掉就等于回到 `{0,0}`，下一发重算又折回去。
   *
   * 段序号会随块增减错位（块被拆成两块时揭示记录跟着挪），这是本轮的已知边界，
   * 写进结果文档的「已知限制」。
   */
  const revealRuns = new Map<number, { top: number; bottom: number }>();

  const lineCountOf = (side: DiffSide): number => viewOf(side)?.state.doc.lines ?? 0;

  /** 两栏各自的行数（贴边判定要看两栏：上游 `atStart/atEnd` 是成对的）。 */
  const lineCounts = (): Record<DiffSide, number> => ({
    original: lineCountOf("original"),
    modified: lineCountOf("modified"),
  });

  /** 某一栏那颗 view（右栏可能是「没有右栏」那条兜底路 ⇒ 调用处一律允许读不到）。 */
  const viewOf = (side: DiffSide): EditorView | null => (side === "original" ? left : right);

  /** 某一栏的光标行（1-based；两栏的行轴各查各的）。 */
  const caretLineOf = (side: DiffSide): number => {
    const view = viewOf(side);
    if (!view) return 0;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  };

  const regionLengthOf = (r: FoldRange): number => r.end - r.start + 1;

  /** 这一段此刻的揭示量（夹进段长：正文改动之后旧记账可能已经越界）。 */
  const revealOf = (r: FoldRange): { top: number; bottom: number } => {
    const len = regionLengthOf(r);
    const saved = revealRuns.get(r.run);
    const top = Math.min(Math.max(saved?.top ?? 0, 0), len);
    const bottom = Math.min(Math.max(saved?.bottom ?? 0, 0), len - top);
    return { top, bottom };
  };

  /** 这一段此刻的隐藏区间（本栏行轴，含端点）。 */
  const hiddenOf = (r: FoldRange): { from: number; to: number } => {
    const { top, bottom } = revealOf(r);
    return { from: r.start + top, to: r.end - bottom };
  };

  /** 这一栏此刻真的折着哪几段（候选一律由 `diffBlocks` 交出来的块推出 —— 同源）。 */
  const foldedFor = (side: DiffSide): FoldRange[] => {
    if (!foldOn) return [];
    return foldCandidates(stored, side, lineCounts()).filter((r) => {
      const { top, bottom } = revealOf(r);
      return top + bottom < regionLengthOf(r);
    });
  };

  /** 整段全开（光标落进去 / 跳块经过时用）：上游 `showAll` 同口径。 */
  const showAllRun = (r: FoldRange): void => {
    revealRuns.set(r.run, { top: 0, bottom: regionLengthOf(r) });
  };

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
    const gapOf = (r: FoldRange): number => {
      const hidden = hiddenOf(r);
      return Math.max(hidden.from - to, from - hidden.to, 0);
    };
    let best: FoldRange | null = null;
    for (const r of cands) {
      const hidden = hiddenOf(r);
      if (hidden.from <= from && to <= hidden.to) return r;
      if (best === null || gapOf(r) < gapOf(best)) best = r;
    }
    return best;
  };

  /**
   * 画面上真的折着的那一段对回候选清单 ⇒ 整段全开。
   *
   * 查的是 `foldedRangesIn`（画法自己），不是候选清单：键入之后两者行号不同一份（见 `matchRun`）；
   * 而「全开哪一段」还得回清单去记（记账口径是段序号，不是行号）。
   * @returns 有没有真展开一段（没有 ⇒ 调用方不必点名）
   */
  const unfoldRunUnderLine = (side: DiffSide, line: number): boolean => {
    const view = viewOf(side);
    if (!view || line < 1) return false;
    const painted = foldedRangesIn(view.state);
    if (!painted.some((r) => line >= r.from && line <= r.to)) return false;
    const hit = matchRun(side, line);
    if (!hit) return false;
    const { top, bottom } = revealOf(hit);
    if (top + bottom >= regionLengthOf(hit)) return false;
    showAllRun(hit);
    return true;
  };

  /** 发进那一臂的形态（本栏行轴的行号 + 揭示量：段序号是 surface 自己的记账抓手）。 */
  const foldPointsFor = (side: DiffSide): FoldPoint[] =>
    foldedFor(side).map((r) => {
      const { top, bottom } = revealOf(r);
      return {
        from: r.start + top,
        to: r.end - bottom,
        top,
        bottom,
        regionLength: regionLengthOf(r),
      };
    });

  /** 上一次真画进两臂的折区（同一批就不重发 —— 折条 DOM 反复重建会整屏闪）。 */
  const paintedFolds: Record<DiffSide, FoldPoint[]> = { original: [], modified: [] };

  const sameFolds = (a: FoldPoint[], b: FoldPoint[]): boolean =>
    a.length === b.length &&
    a.every(
      (p, i) =>
        p.from === b[i].from &&
        p.to === b[i].to &&
        p.top === b[i].top &&
        p.bottom === b[i].bottom &&
        p.regionLength === b[i].regionLength,
    );

  /** 上一次真画进两臂的行号区折叠点（同一批就不重发 —— 按钮 DOM 反复重建会闪）。 */
  const paintedMarks: Record<DiffSide, FoldMark[]> = { original: [], modified: [] };

  const sameMarks = (a: FoldMark[], b: FoldMark[]): boolean =>
    a.length === b.length && a.every((m, i) => m.run === b[i].run && m.line === b[i].line);

  /**
   * 行号区该出现哪几颗「折叠这一段」按钮：只有**整段已展开**的候选才有（上游
   * `hideUnchangedRegionsFeature` 的 `shouldHideControls` = 全部行都可见才挂 glyph）；
   * 还折着、只揭示了一部分的，收起入口在折条自己的行号区按钮上。
   *
   * 行号取**可折区的首行**（裁掉贴边 context 之后、真正要收起的第一行）：上游 glyph 挂的是
   * `UnchangedRegion.originalLineNumber`，而 `fromDiffs` 给这个字段的正是加过 context 偏移的
   * 隐藏区首行 —— 不是整段未改动区的首行。
   */
  const markPointsFor = (side: DiffSide): FoldMark[] => {
    if (!foldOn) return [];
    return foldCandidates(stored, side, lineCounts())
      .filter((r) => {
        const { top, bottom } = revealOf(r);
        return top + bottom >= regionLengthOf(r);
      })
      .map((r) => ({ run: r.run, line: r.start }));
  };

  /**
   * 两栏一起点名：按现在的块表重画一次，并把「现在折着这些段」一起发进去。
   *
   * ⚠️ 两发必须在**同一次派发**里（`refreshDiff` 与 `setFoldedRanges`）：块表刚换、底色已经跟着
   * 新块走而折区还停在旧块上，那一帧画出来的就是错的那几行 —— 三处同刻跟上靠的是同一发事务。
   * 折区没变时只发 `refreshDiff`：重发同一批折区会让 CM6 重建替换块（并重新量高），
   * 与下一轮缝测量互相追着跑，就是用户看到的「一直重算、停不下来」。
   */
  const refreshArms = (): void => {
    // 先把缝按**此刻的行盒**重算一遍再派发：块表刚换（比如用户把删掉的行打回来了）时，
    // 还拿着上一轮的缝去画，就会在「块已经没了」的那一帧留下一条没人认领的空位 ——
    // 随后的 `scheduleAlign` 只保证下一帧收口，这一帧已经把旧缝画出去了。
    // 折行开着时这里量到的是上一帧的几何，`scheduleAlign` 落地后还会再校一次。
    applyGapPlans();
    const foldOf = (side: DiffSide): StateEffect<unknown>[] => {
      const folds = foldPointsFor(side);
      const marks = markPointsFor(side);
      const effects: StateEffect<unknown>[] = [refreshDiff.of(null)];
      if (!sameFolds(folds, paintedFolds[side])) {
        paintedFolds[side] = folds;
        effects.push(setFoldedRanges.of(folds));
      }
      if (!sameMarks(marks, paintedMarks[side])) {
        paintedMarks[side] = marks;
        effects.push(setFoldMarks.of(marks));
      }
      return effects;
    };
    left.dispatch({ effects: foldOf("original") });
    right?.dispatch({ effects: foldOf("modified") });
    writeBackRight();
    // 概览条的色块吃块表 + 折叠态，与两臂同一次收口；右栏的 scrollTop 可能刚被折条改掉，
    // 视口滑块顺便复算一帧。中间那列的按钮位置同样只跟块表/折叠走 ⇒ 一起重画。
    // 缝/折叠/行盒都可能在这一发里换过 ⇒ 概览轴作废（下一次读取按新行盒重算）。
    invalidateAxis();
    renderOverview();
    renderReverts();
    // 块表/折叠换过之后，两栏的实测行高可能变了（块的边界变了，或折条换了位置）⇒ 排一次
    // 重测。`scheduleAlign` 只在缝真的变了时才再派发，因此这一发不会自激。
    scheduleAlign();
  };

  /**
   * 落位/揭示前把「包住（或紧邻）这一行」的折区展开（简报 Step 3 的规则：
   * 凡 `from <= line <= to + DIFF_REVEAL_LINES` 的段都摘掉）。
   *
   * ⚠️ 两栏的行轴各查各的（`SIDES` 那一圈）：同一行号在左右两栏指的是不同的行，
   * 只按右栏摘 ⇒ 左栏的落点还能落进被替换掉的折区里。
   */
  const unfoldAroundLines = (lines: number[]): void => {
    if (!foldOn) return;
    const drop: FoldRange[] = [];
    for (const side of SIDES) {
      for (const r of foldedFor(side)) {
        if (drop.some((d) => d.run === r.run)) continue;
        const hidden = hiddenOf(r);
        if (lines.some((line) => hidden.from <= line && line <= hidden.to + DIFF_REVEAL_LINES)) {
          drop.push(r);
        }
      }
    }
    if (drop.length === 0) return;
    for (const r of drop) showAllRun(r);
    refreshArms();
  };

  const unfoldAround = (line: number): void => unfoldAroundLines([line]);

  /**
   * 三处「谁让光标走进折区」的兜底（简报 Step 3 那条 ⚠️ 风险的正面处理）：
   * CM6 里被 `Decoration.replace` 替掉的行**仍在文档里** ⇒ 键入/点击/`ArrowDown` 都可能把
   * 插入符送进被折起来的那几行。落位之前有 `unfoldAround`，而**用户自己走进去**这一路只能靠
   * 右栏的 `updateListener` 检查 —— 那一段当场展开，别让它带着看不见的光标继续打字。
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
   * 查两侧各自的光标行，盖住光标那一段先记成「整段全开」（只记账，不派发 —— 收口还是
   * 调用方那一发 `refreshArms()`，两栏同一次派发这一条不许破）。
   *
   * 左栏也查：A 档它恒只读（B 档可编辑，但那两种档位都会把光标停在未改动段里），
   * 而它**可选可聚焦**（R12 那一手）；那一栏没有折叠开关的监听，就借这两颗入口与右栏
   * 那一发兜住。
   */
  const guardCaretsUnderFolds = (): void => {
    if (!foldOn) return;
    for (const side of SIDES) {
      const line = caretLineOf(side);
      const hit = foldedFor(side).find((r) => {
        const hidden = hiddenOf(r);
        return line >= hidden.from && line <= hidden.to;
      });
      if (hit) showAllRun(hit);
    }
  };

  /**
   * 这一栏可视区半高能折几行（居中落位要往下让出的行数）。
   *
   * 没有布局时（jsdom / 刚挂上还没量）行高读作 0 ⇒ 退化成「落顶」，下一次跳块自然居中，
   * 不会因为量不到就把目标算到文档外。
   */
  const centerOffsetLines = (view: EditorView): number => {
    const lh = view.defaultLineHeight;
    if (!(lh > 0)) return 0;
    return Math.max(0, Math.floor(view.scrollDOM.clientHeight / lh / 2));
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
   * 落位位置是**视野中央**（上游 `revealRangeInCenter`）：顶边那行 = 目标行 − 半屏行数。
   * 因此共享坐标给的是 `centerV` 而不是目标行；两条路各自居中自己那一栏的目标行，
   * 两格行高不同也仍然对齐（这正是 B300 那条「别拿一格的顶行当另一格的顶行」的居中版）。
   */
  const landSide = (side: DiffSide, line: number): void => {
    const view = side === "original" ? left : right;
    if (!view) return;
    const at = lineStartOf(view, line);
    // 上游 `revealRangeInCenter`：跳块把目标行放到视野**中间**，不是贴顶。
    const centerV = Math.max(1, view.state.doc.lineAt(at).number - centerOffsetLines(view));
    if (side === "original") {
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "center" }),
      });
      return;
    }
    view.dispatch({ selection: { anchor: at } });
    writeBackRight();
    // 居中之后顶边不再是目标行 ⇒ 共享坐标给 `centerV`（行号口径），不再传 `at`：
    // 传 `at` 会走「按字符对齐到顶」的那一支，把居中又按回顶部。
    landVisibleSideAtV(panel, centerV, 0, null);
  };

  /**
   * 折条上的操作（两臂带进来的都是这一颗，各自认自己那一栏）：按揭示量改那一段的记账。
   *
   * 三条交互照上游 `CollapsedCodeOverlayWidget`：上下 4px 热区点一下各揭示
   * `DIFF_REVEAL_LINES` 行、拖拽连续揭示（widget 自己按行高折算后交绝对量上来）、
   * 中间双击/图标全开。全开 ⇒ `top + bottom === 段长` ⇒ 这一段不再出折条。
   *
   * ⚠️ 揭示只做**本栏**：左栏那颗不在同步滚动那套注册口里，两栏本来就是各滚各的
   * （点一栏的折条把另一栏也滚走，等于偷偷给它发明一条同步规则）。
   *
   * ⚠️ 那一段靠 `matchRun` 认（修复轮 Important 2）：折条带下来的行号是**它自己画上去那一刻**
   * 的那一份，候选清单则是按现在的 `stored` 现算的 —— 两者中间隔着一发键入就差几行，
   * 按行号精确比对 ⇒ `undefined` ⇒ 点下去静默空转（不报错、不展开，什么也不发生）。
   */
  const revealFold = (side: DiffSide, from: number, reveal: FoldReveal): void => {
    const hit = matchRun(side, from);
    if (!hit) return;
    const len = regionLengthOf(hit);
    const cur = revealOf(hit);
    let next = cur;
    if ("all" in reveal) next = { top: cur.top, bottom: len - cur.top };
    else if ("above" in reveal) {
      next = { top: Math.min(cur.top + reveal.above, len - cur.bottom), bottom: cur.bottom };
    } else if ("below" in reveal) {
      next = { top: cur.top, bottom: Math.min(cur.bottom + reveal.below, len - cur.top) };
    } else if ("top" in reveal) {
      next = { top: Math.min(Math.max(reveal.top, 0), len - cur.bottom), bottom: cur.bottom };
    } else if ("bottom" in reveal) {
      next = { top: cur.top, bottom: Math.min(Math.max(reveal.bottom, 0), len - cur.top) };
    }
    if (next.top === cur.top && next.bottom === cur.bottom) return;
    revealRuns.set(hit.run, next);
    refreshArms();
  };

  /** 两栏各自的折条出口（身份固定，见 `leftArm` 的那条 ⚠️）。 */
  const onOriginalFoldReveal = (from: number, reveal: FoldReveal): void =>
    revealFold("original", from, reveal);
  const onModifiedFoldReveal = (from: number, reveal: FoldReveal): void =>
    revealFold("modified", from, reveal);

  /** 把停在 `run` 隐藏区里的光标挪到最近的可见行（段上下各一行，谁近取谁；两栏各查各的）。 */
  const liftCaretsOutOfRun = (run: number): void => {
    for (const side of SIDES) {
      const view = viewOf(side);
      if (!view) continue;
      const r = foldCandidates(stored, side, lineCounts()).find((c) => c.run === run);
      if (!r) continue;
      const line = caretLineOf(side);
      if (line < r.start || line > r.end) continue;
      const above = r.start - 1;
      const below = r.end + 1;
      const target =
        above < 1
          ? below
          : below > view.state.doc.lines
            ? above
            : line - above <= below - line
              ? above
              : below;
      view.dispatch({ selection: { anchor: view.state.doc.line(target).from } });
    }
  };

  /**
   * 行号区那颗按钮：把**这一段**折回去（`top = bottom = 0`）。
   *
   * 与 `revealFold` 分开：那一颗按画面行号认段（折条画上去那一刻的行号），这一颗带着
   * **段序号**来（按钮只在整段展开时存在，按行号回查会被键入后的行号漂移带偏）。
   *
   * 光标就在这一段里时**先挪出去再折**：这里不能走两颗开关入口那条 `guardCaretsUnderFolds`
   * 的守卫（「保住光标所在那一段」）—— 用户点的就是这一段的按钮，原地不动等于点了没反应。
   * 上游 `setHiddenAreas` → `cursor.onLineMappingChanged` 也是同一口径：隐藏区落地时把光标
   * 夹到最近的可见行。
   */
  const collapseRun = (side: DiffSide, run: number): void => {
    if (!foldOn) return;
    const hit = foldCandidates(stored, side, lineCounts()).find((r) => r.run === run);
    if (!hit) return;
    revealRuns.set(run, { top: 0, bottom: 0 });
    liftCaretsOutOfRun(run);
    refreshArms();
  };

  /** 两栏各自的行号区折叠出口（身份固定，理由同折条那两颗）。 */
  const onOriginalFoldMark = (run: number): void => collapseRun("original", run);
  const onModifiedFoldMark = (run: number): void => collapseRun("modified", run);

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
    // 开关拨过去 = 重新按当前块表折一遍 / 全部放开；揭示记账不跨开关
    //（开着又关掉再打开，用户要的是「照现在的正文重来一次」，不是把上次那些段一条条对上）。
    revealRuns.clear();
    guardCaretsUnderFolds();
    refreshArms();
  };
  const collapseAllUnchanged = (): void => {
    foldOn = true;
    revealRuns.clear();
    guardCaretsUnderFolds();
    refreshArms();
  };
  const showAllUnchanged = (): void => {
    // 连开关一起关：只清空折区而开关留着的下一发，「全部展开」会被重算偷偷折回去。
    foldOn = false;
    revealRuns.clear();
    refreshArms();
  };

  /** 本 surface 正把左栏的一笔改动写回文档（文档那一头回声进来时不再重复应用）。 */
  let forwarding = false;
  /** 正把文档在别处的一笔改动补进左栏（左栏这一头不再回声给文档）。 */
  let applyingRemote = false;

  /**
   * 左栏那一臂（**排在折叠块之后**：`onFoldBarClick` 那颗回调得先有身份）。
   *
   * ⚠️ 回调取的是 `onOriginalFoldClick` 这一颗**固定**的函数而不是每次现做一条闭包：
   * `DiffFoldWidget.eq` 比回调身份，换一颗就等于每次重画折条的 DOM；更要紧的是换出去的
   * 那颗闭包可能已经属于上一颗 surface（与右栏共用槽那种病同形）。
   * 挂 state 与 `resetLeftDoc` 换 state 都走这一处，两栏臂的组成只有一份定义。
   */
  const leftArm = (): Extension => [
    // 缝与行内区间同一份来源：块表换了而缝还停在旧测量上，底色与占位块会互相打架；
    // 行内区间若晚一拍，字符级标记就会短暂地落在新块的旧行号上。
    diffFace("original", () => ({ blocks: stored, gaps: gapPlans.original, inner: inner.changes })),
    onFoldBarClick(onOriginalFoldReveal),
    onFoldMarkClick(onOriginalFoldMark),
    // 左栏的光标与选区会动（R12：那颗 view 可选可聚焦）⇒ 概览标记层必须跟着走，否则
    // 左列的光标条停在挂上那一刻。差异色块与折叠走 `refreshArms` 那一发，标记画布另算。
    EditorView.updateListener.of((update) => {
      // 回退列的常显块跟「最后光标」走：光标在左栏里移动也要重画（此前只认右栏）。
      if (update.selectionSet) renderReverts();
      // B 档左栏可编辑：这一笔（打字 / 查找替换 / 撤销）先写回它背后那份文档，脏标记与
      // 同文档其他实例由 main 那条既有链路负责；块表重算仍走下面同一发防抖。
      // `applyingRemote` 挡住「文档别处改 → 补进左栏 → 又回声给文档」那一圈。
      if (armed && update.docChanged && leftWritable) {
        if (!applyingRemote) {
          forwarding = true;
          try {
            applyDiffDocEdit(current.leftDocId as number, update.changes);
          } finally {
            forwarding = false;
          }
        }
        // 行数/正文换了 ⇒ 概览轴（按行记账）当场作废；缝的收口仍旧走防抖那一发。
        invalidateAxis();
        scheduleSync();
        unfoldUnderCaret();
      }
      // 行盒几何变了（拖分屏 / 窗口尺寸 / 折行重排）⇒ 行高跟着变，缝必须按新行高重测。
      // ⚠️ 不能只靠 ResizeObserver：CM6 自己的 resize 量测有 50ms 防抖，RO 那一发常常还是
      // 旧宽度的行高，等它量完又不会再发一次通知 ⇒ 缝停在旧值。geometryChanged 是 CM6
      // **量完之后**才发的，在这里重测读到的才是新行高。docChanged 交给下面那条防抖链路。
      if (armed && update.geometryChanged) {
        // 量测里 CM6 会为了保住滚动锚点自己改 `scrollTop`：那一发不是用户滚动，
        // 不记账就会被当成用户滚的、镜像给对栏（见 `settleScroll`）。
        settleScroll();
        if (!update.docChanged) scheduleAlign();
      }
      if (
        update.selectionSet ||
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.length > 0)
      ) {
        paintMarkers("original", originalRulerEl, originalCanvasEl);
      }
    }),
  ];
  const left = new EditorView({
    parent: originalEl,
    state: leftState(
      current,
      leftPerf(),
      leftFace.of(leftArm()),
      themeSlot.of(lastTheme),
      leftWrap.of(wrapValue()),
      leftInvisibles.of(invisiblesValue()),
      leftWritable,
    ),
  });
  /**
   * 新 view 的 `scrollTop` 从 0 起、行高地图还全是估值：先藏着，等第一次被右栏的映射
   * 落过位再露（`revealLeft`）。不藏的话，切到差异标签的头两帧会先画出基线开头，
   * 随后才被镜像到真正的位置 —— 用户看到的就是内容区上下抖。
   */
  left.scrollDOM.style.visibility = "hidden";

  /**
   * 文档那一头的改动补进左栏（另一半在左栏的 `updateListener` 里，见 `LeftMirror`）。
   * 只在可编辑时登记：A 档没有文档，什么也不用同步。
   */
  const leftMirror: LeftMirror = {
    apply: (changes) => {
      // 本 surface 刚把同一笔写回文档，回声回来时左栏已经是最新的。
      if (forwarding) return;
      applyingRemote = true;
      try {
        left.dispatch({ changes });
      } finally {
        applyingRemote = false;
      }
    },
  };
  if (leftWritable && current.leftDocId != null) {
    let set = leftMirrors.get(current.leftDocId);
    if (!set) leftMirrors.set(current.leftDocId, (set = new Set()));
    set.add(leftMirror);
  }

  // 查找作用于「最后聚焦的那一栏」（上游 `diffEditorWidget.getFocusedCodeEditor()`）：
  // 焦点进哪一栏就记哪一栏；焦点离开两栏（查找框、侧栏）时不改 —— 打开查找那一刻还要靠它
  // 决定目标 view。`focusin` 冒泡，点在行内任意节点都算。
  let focused: DiffSide = "modified";
  const onLeftFocus = (): void => {
    focused = "original";
    // 常显的那一颗按钮跟「最后光标」走，换栏即重画（纯显隐，不改任何文档）。
    renderReverts();
  };
  const onRightFocus = (): void => {
    focused = "modified";
    renderReverts();
  };
  left.dom.addEventListener("focusin", onLeftFocus);
  right?.dom.addEventListener("focusin", onRightFocus);

  /**
   * 某一栏每一行**屏上占多少像素**。
   *
   * 读的必须是 CM6 自己的高度图（`textBlockOf`），不能另配一把尺：补缝的目的是让两栏
   * 「同一逻辑行落在同一个 y」，而滚动、`lineBlockAt`、原生滚动区全按 CM6 那张高度图算。
   * 缝若按别的尺补，两栏的滚动区间就先差了一截（拖分屏后两栏宽度不同，同一段文本的折行
   * 估值也不同），滚到哪都对不齐。同源之后缝计划与 CM6 的 `scrollHeight` 一起收敛：
   * 未渲染的行被实测替换时两栏按同一份新高度重算，最终值与真实折行完全一致。
   *
   * 折行关着时一个文档行 = 一个视觉行，读同一张图同样成立（CM6 给的就是 `defaultLineHeight`）。
   *
   * ⚠️ 只取**行文本自己的**块：贴着行尾的占位块会被 CM6 并进同一颗 composite
   * `BlockInfo`，要把它的高度减出去，才有「补缝 → 行高不变 → 缝稳定」这条不动点。
   *
   * ⚠️ 折区里**段首记 24px（折条），其余行记 0**：整段已被替换装饰收走，屏上只剩那一条折条。
   * 段首必须认这 24px —— 少算它，另一栏给这段补的缝就短一截（用户报的「右边多出的行被折叠、
   * 左边填充不够」正是这一格：右栏补缝按 0 算，屏上却占着折条那 24px，滚到底两栏差这一截）。
   * 不读「替换块量出来多少」：折条重画（estimated → measured）时它会跳，缝跟着抖。
   */
  const lineHeights = (side: DiffSide): ((line: number) => number) => {
    const view = viewOf(side);
    if (!view) return () => 0;
    const folds = foldedRangesIn(view.state);
    const at = (line: number): number | null => {
      const fold = folds.find((f) => line >= f.from && line <= f.to);
      return fold ? (line === fold.from ? FOLD_BAR_HEIGHT : 0) : null;
    };
    return (line) => at(line) ?? textBlockOf(view, line).height;
  };

  /** 两栏的折行量尺（只喂概览轴，见 `axisHeights`）：每栏一把，按行文本缓存。 */
  const meters: Partial<Record<DiffSide, WrapMeter>> = {};
  const meterOf = (side: DiffSide): WrapMeter => (meters[side] ??= createWrapMeter(viewOf(side)!));

  /**
   * 概览轴专用的行高：**不读 CM6 的高度图**。
   *
   * CM6 只对进过视口的行给实测值，视口外按字符数估；估值会随「又量到几行」而变 ⇒
   * 概览的色带与滑块在调整分屏比例后还会继续漂，直到用户再碰一下滚动条才落到最终值
   * （用户报的「滚动条区域要拖动才会刷新」）。这里改吃折行量尺：整篇一次量准，轴只随
   * 宽度 / 排版 / 缝 / 折叠变。
   *
   * 量不出来（面板还没宽度、整栏不可见、jsdom）⇒ 退回行盒，与补缝同源。
   */
  const axisHeights = (side: DiffSide): ((line: number) => number) => {
    const view = viewOf(side);
    if (!view) return () => 0;
    const folds = foldedRangesIn(view.state);
    const at = (line: number): number | null => {
      const fold = folds.find((f) => line >= f.from && line <= f.to);
      return fold ? (line === fold.from ? FOLD_BAR_HEIGHT : 0) : null;
    };
    if (!isWrap) return lineHeights(side);
    const measured = meterOf(side).heights();
    if (measured) return (line) => at(line) ?? measured[line - 1] ?? 0;
    return (line) => at(line) ?? textBlockOf(view, line).height;
  };

  /**
   * 概览轴专用的缝计划：算法与 `measureGapPlans` 同一份，行高取**折行量尺**。
   *
   * 补缝必须吃 CM6 的高度图（与滚动坐标同源，见 `lineHeights`）；可那张图对视口外的
   * 折行行只有估值，滚过一段就换一版 ⇒ 缝高跟着变，概览色带拖一下滚动条就跳一次长度
   * （用户报的「拖拽时色条长度会变化」）。概览只要一张不漂的地图：行高与缝都从量尺来，
   * 整篇一次量准，轴只随文档 / 折叠 / 折行 / 宽度 / 排版变。
   *
   * 量尺量不出（面板没宽度、整栏不可见、jsdom）或折行关着 ⇒ 返回 null，由调用方退回行盒。
   */
  const meterGapPlans = (): Record<DiffSide, GapZone[]> | null => {
    if (!right || !isWrap) return null;
    const measured: Partial<Record<DiffSide, number[]>> = {};
    for (const side of SIDES) {
      const heights = meterOf(side).heights();
      if (!heights) return null;
      measured[side] = heights;
    }
    const folds: Record<DiffSide, readonly FoldPoint[]> = {
      original: foldedRangesIn(left.state),
      modified: foldedRangesIn(right.state),
    };
    const heightOf = (side: DiffSide, line: number): number => {
      const fold = folds[side].find((f) => line >= f.from && line <= f.to);
      if (fold) return line === fold.from ? FOLD_BAR_HEIGHT : 0;
      return measured[side]?.[line - 1] ?? 0;
    };
    const zones = gapZones(
      stored,
      { original: left.state.doc.lines, modified: right.state.doc.lines },
      heightOf,
      inner.alignments,
    );
    return {
      original: foldGaps(zones.original, folds.original),
      modified: foldGaps(zones.modified, folds.modified),
    };
  };

  const axisGapPlans = (): Record<DiffSide, GapZone[]> => meterGapPlans() ?? gapPlans;

  /**
   * 概览色带与标记层的「像素轴」。
   *
   * 行高与缝都取**折行量尺**（`axisHeights` / `axisGapPlans`），**不与补缝共用 CM6 的
   * 高度图**：补缝要的是与滚动坐标同源，概览要的是不随视口漂移的稳定地图（两张图差着
   * 视口外折行的估值误差）。折叠按同一口径记（段首 24px、其余 0），这里不再单独加折条
   * —— 两处各记一份就会在「单侧折叠」时把差值算成两倍。缝按 `afterLine` 记在那一行
   * 之后（已由 `foldGaps` 挪出折区）。
   *
   * **缓存**：滚动只读轴（滑块、色带、标记层都吃它），不能每一发 scroll 都把整篇重算。
   * 作废点只有「行盒真的换了」：缝/折叠/折行/文档/字号（见 `invalidateAxis` 的调用处）。
   */
  let axisVersion = 0;
  const axisCache = new Map<DiffSide, { version: number; axis: OverviewAxis | null }>();
  const invalidateAxis = (): void => {
    axisVersion++;
  };

  const overviewAxis = (side: DiffSide): OverviewAxis | null => {
    const cached = axisCache.get(side);
    if (cached && cached.version === axisVersion) return cached.axis;
    const view = viewOf(side);
    if (!view) return null;
    const lines = view.state.doc.lines;
    const h = axisHeights(side);
    const gaps = axisGapPlans();
    const gapAfter = new Map<number, number>();
    for (const gap of gaps[side]) {
      gapAfter.set(gap.afterLine, (gapAfter.get(gap.afterLine) ?? 0) + gap.height);
    }
    const tops = new Float64Array(lines + 2);
    const heights = new Float64Array(lines + 2);
    for (let line = 1; line <= lines; line++) {
      heights[line] = h(line);
      tops[line + 1] = tops[line] + heights[line] + (gapAfter.get(line) ?? 0);
    }
    const clamp = (line: number): number => Math.min(Math.max(line, 1), lines);
    const axis: OverviewAxis = {
      total: tops[lines + 1] ?? 0,
      topOf: (line) => tops[clamp(line)],
      heightOf: (line) => heights[clamp(line)],
    };
    axisCache.set(side, { version: axisVersion, axis });
    return axis;
  };

  /** 现在这两栏该补哪些缝（纯计算在 `face.ts` 的 `gapZones`，这里只负责量）。 */
  const measureGapPlans = (): Record<DiffSide, GapZone[]> => {
    if (!right) return { original: [], modified: [] };
    // 折行开着 ⇒ 行高取整篇一次量准的量尺：视口外的行不会被 CM6 先估后测，
    // 缝计划在进入 / 滚动时都不再变（见 `meterGapPlans`）。
    const measured = meterGapPlans();
    if (measured) return measured;
    const heights: Record<DiffSide, (line: number) => number> = {
      original: lineHeights("original"),
      modified: lineHeights("modified"),
    };
    const zones = gapZones(
      stored,
      { original: left.state.doc.lines, modified: right.state.doc.lines },
      (side, line) => heights[side](line),
      inner.alignments,
    );
    // 折区整段被替换装饰收走 ⇒ 落进去的缝渲染不出来，必须挪到折条之后（见 `foldGaps`）。
    return {
      original: foldGaps(zones.original, foldedRangesIn(left.state)),
      modified: foldGaps(zones.modified, foldedRangesIn(right.state)),
    };
  };

  /** 两份缝计划是否「一样到不必再派发」（亚像素抖动不算变化，否则会 measure 自激）。 */
  const sameGapPlans = (
    a: Record<DiffSide, GapZone[]>,
    b: Record<DiffSide, GapZone[]>,
  ): boolean => {
    for (const side of SIDES) {
      if (a[side].length !== b[side].length) return false;
      for (let i = 0; i < a[side].length; i++) {
        const x = a[side][i];
        const y = b[side][i];
        if (x.afterLine !== y.afterLine || Math.abs(x.height - y.height) > 0.25) return false;
      }
    }
    return true;
  };

  /** 量一次并收下结果；返回是否真的换了缝（换了就得重画两臂的占位块）。 */
  const applyGapPlans = (): boolean => {
    const next = measureGapPlans();
    if (sameGapPlans(next, gapPlans)) return false;
    gapPlans = next;
    return true;
  };

  /** 这一颗 surface 已经拆掉 ⇒ 迟到的测量/帧回调一律空转。 */
  let disposed = false;
  /** 测量代号：晚到的旧结果不许盖掉新一轮（两颗 view 的回调不一定同帧到齐）。 */
  let alignGen = 0;

  /**
   * 排一次「量两侧行高 → 重算缝」。
   *
   * 为什么用 `requestMeasure`：折行开关、字号、窗口尺寸一变，CM6 的 heightMap 还是旧的；
   * 只有 measure 的 read 阶段拿到的是这一帧**已经落地**的几何。两颗 view 各挂一个 read，
   * 两边都到齐才算数 —— 只等一边就可能拿左栏的新行高去比右栏的旧行高。
   *
   * 派发放到下一帧：read 阶段里改 state 会打进 CM6 的 measure 自检（它会把这次改动当成
   * 又一次布局请求），而「read 只读、write 再写」是那套 API 的硬约定。
   */
  const scheduleAlign = (): void => {
    if (disposed || !right) return;
    const gen = ++alignGen;
    let leftDone = false;
    let rightDone = false;
    const settle = (): void => {
      if (disposed || gen !== alignGen || !leftDone || !rightDone) return;
      diffTrace(panel, `量齐 gen=${gen}`);
      // read 阶段只量不写。
      const next = measureGapPlans();
      requestAnimationFrame(() => {
        if (disposed || gen !== alignGen) return;
        if (!sameGapPlans(next, gapPlans)) {
          gapPlans = next;
          // 缝换了 ⇒ 两臂的占位块要重排；这一发同时带着新的块表/折叠态。
          refreshArms();
          // ⚠️ 这一支**不能**紧接着落滚动位：新缝的 widget 要到下一轮 measure 才进 heightMap，
          // 而那一轮 measure 末尾的滚动锚定会在写入之后再做一次补偿 ⇒ 写进去的值被叠两次。
          // `refreshArms` 内部已再排一轮 `scheduleAlign`，落位交给那一轮的收口（那时缝已稳定）。
        } else {
          // 缝已稳定、两栏这一轮的锚定也都做完 ⇒ 这时按最后驱动侧重落一次才是终值。
          // 左栏第一次「露出来」也挂在这一发上（见 `resyncSharedOffset`）。
          resyncSharedOffset();
        }
        // 占位块/折叠/换行都会挪色块与按钮的像素位置，落地后统一重画一次。
        // 这一轮 measure 可能换了行盒（字体/折行/宽度）⇒ 概览轴先作废再读。
        invalidateAxis();
        renderOverview();
        renderReverts();
        renderViewport();
      });
    };
    left.requestMeasure({
      read: () => {
        leftDone = true;
        settle();
      },
    });
    right.requestMeasure({
      read: () => {
        rightDone = true;
        settle();
      },
    });
  };

  /** 窗口尺寸变化（拖窗口 / 系统缩放）：两栏宽度与折行结果都可能变，必须重测。 */
  const onWindowResize = (): void => scheduleAlign();
  window.addEventListener("resize", onWindowResize);

  // 内嵌字体是 `font-display: block`（fonts.css）：就绪前量到的是回落字形的折行结果。
  // 就绪之后把两把量尺（概览轴）与缝一起重量一次，两张图才不会停在「按错字体折出来的高度」上。
  void document.fonts?.ready.then(() => {
    if (disposed) return;
    for (const meter of Object.values(meters)) meter.invalidate();
    scheduleAlign();
  });

  /**
   * 概览条：色块坐标照 VS Code 的 overview ruler。
   *
   * 轴取 `overviewAxis`（行高走折行量尺，折叠行 0 高、折条 `FOLD_BAR_HEIGHT`）：整篇一次
   * 量准，色带不会随「滚过 / 调分屏」一段段挪位。
   *
   * 首帧/隐藏格量不出总高（面板还没进文档）：直接不画（ResizeObserver 落地后会补画）。
   */
  const paintRuler = (side: DiffSide, ruler: HTMLElement): void => {
    // 只清色块，**别** `replaceChildren()`：标记层那颗画布是常驻子节点（见创建处）。
    for (const old of ruler.querySelectorAll(".diff-overview-mark")) old.remove();
    const axis = overviewAxis(side);
    const view = viewOf(side);
    if (!axis || !view) return;
    const total = axis.total;
    if (total <= 0) return;
    const lines = view.state.doc.lines;
    for (const b of stored) {
      const start = side === "modified" ? b.modifiedStart : b.originalStart;
      const end = side === "modified" ? b.modifiedEnd : b.originalEnd;
      if (start > end) continue;
      const a = Math.min(Math.max(start, 1), lines);
      const z = Math.min(Math.max(end, 1), lines);
      if (z < a) continue;
      // 色块的上下界都取**行文本**的坐标：贴着块尾的占位块算作「缺口区」，不该染成改动色。
      const top = axis.topOf(a);
      const bottom = axis.topOf(z) + axis.heightOf(z);
      if (!(bottom > top)) continue;
      const mark = document.createElement("div");
      mark.className = "diff-overview-mark";
      mark.style.top = `${(top / total) * 100}%`;
      mark.style.height = `${((bottom - top) / total) * 100}%`;
      ruler.appendChild(mark);
    }
  };

  /**
   * 视口顶在概览轴上的位置：视口顶所在行 + 行内比例，换到 `overviewAxis` 的坐标系。
   *
   * 不能拿 `scrollTop` 直接比轴总高 —— 那是 CM6 的估值 heightMap，与轴（实测行高 + 缝）
   * 差着视口外折行的估值误差。先按 `lineBlockAtHeight` 找到顶行，再用行号回轴里查位置。
   */
  const viewportAxisTop = (view: EditorView, axis: OverviewAxis): number => {
    const top = Math.max(view.scrollDOM.scrollTop, 0);
    const block = view.lineBlockAtHeight(top);
    const lines = view.state.doc.lines;
    const line = view.state.doc.lineAt(block.from).number;
    const height = Math.max(block.height, 0);
    const frac = height > 0 ? Math.min(Math.max((top - block.top) / height, 0), 1) : 0;
    const from = axis.topOf(line);
    const to = line < lines ? axis.topOf(line + 1) : axis.total;
    return from + frac * Math.max(to - from, 0);
  };

  /**
   * 轴坐标 → 右栏滚动位置：二分找到那一行，再按行内比例落到 `lineBlockAt` 的坐标上。
   *
   * 与 `viewportAxisTop` 互逆：拖滑块时读的是同一颗轴，松手后 `scroll` 那一发读回来
   * 的滑块位置不会跳（写进去的是行盒坐标，CM6 渲染那一行时用的正是它）。
   */
  const scrollToAxisY = (axisY: number): void => {
    const view = right;
    const axis = overviewAxis("modified");
    if (!view || !axis || !(axis.total > 0)) return;
    const y = Math.min(Math.max(axisY, 0), axis.total);
    const lines = view.state.doc.lines;
    let lo = 1;
    let hi = lines;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (axis.topOf(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    const from = axis.topOf(lo);
    const to = lo < lines ? axis.topOf(lo + 1) : axis.total;
    const room = Math.max(to - from, 0);
    const frac = room > 0 ? Math.min(Math.max((y - from) / room, 0), 1) : 0;
    const block = view.lineBlockAt(view.state.doc.line(lo).from);
    view.scrollDOM.scrollTop = Math.min(
      block.top + frac * Math.max(block.height, 0),
      Math.max(view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight, 0),
    );
  };

  /**
   * 视口滑块（B461 后续轮）：几何照 VS Code `ScrollbarState` 的取值，不用百分比。
   *
   * 上游（`scrollbarState.ts`）：
   *   isNeeded   = scrollSize > 0 && scrollSize > visibleSize
   *   sliderSize = round(max(MINIMUM_SLIDER_SIZE=20, floor(visible² / scrollSize)))
   *   ratio      = (representable - sliderSize) / (scrollSize - visible)
   *   position   = round(scrollTop × ratio)
   * 百分比写法在长文档里会缩成 1px 的线，而 VS Code 的下限是 20px —— 那正是「拖得住」的保证。
   *
   * `scrollSize` / `position` 都取**概览轴**（实测行高 + 缝）而不是 CM6 的
   * `scrollHeight` / `scrollTop`：后者视口外按字符数估，滚过一段就变一次，滑块会边滚边改宽。
   * 视口顶的位置由 `viewportAxisTop` 从顶行行号换算，与拖拽的 `scrollToAxisY` 互逆。
   *
   * 不需要滚动时**整条滑块收起来**，不是铺满：上游在 `isNeeded() === false` 时把滚动条元素换成
   * `.invisible`（`scrollbars.css`：`opacity: 0; pointer-events: none;`）。以前这里照
   * `getSliderSize()` 的 `representableSize` 那一支把滑块铺满整条，于是内容装得下时右缘是一根
   * 整条都是滑块的灰柱：按下去拖不动（`scrollTop` 恒 0），看着就像一个「禁用」的控件。
   * 视觉与命中区一起收掉 —— 透明但可点比看得见却拖不动更糟。
   */
  const renderViewport = (): void => {
    const view = right;
    if (!view) return;
    const clientHeight = view.scrollDOM.clientHeight;
    const axis = overviewAxis("modified");
    const total = axis?.total ?? 0;
    // 需不需要滑块看**实测轴**，不看 CM6 的 scrollHeight：后者随滚动逐段从估值变实测，
    // 同一篇文档的滑块会一边滚一边变宽变窄 —— 用户报的「色条不稳定」正是这一条。
    const needed = total > 0 && clientHeight > 0 && total > clientHeight;
    viewportEl.classList.toggle("is-hidden", !needed);
    if (!needed || !axis) return;
    const height = Math.round(Math.max(20, Math.floor((clientHeight * clientHeight) / total)));
    const travel = Math.max(clientHeight - height, 0);
    const span = Math.max(total - clientHeight, 1);
    const top = Math.round(
      (Math.min(Math.max(viewportAxisTop(view, axis), 0), span) / span) * travel,
    );
    viewportEl.style.top = `${top}px`;
    viewportEl.style.height = `${height}px`;
  };

  /**
   * 标记层：选区 / 光标 / 查找命中 / 同词出现。
   *
   * 上游的差异概览把这几类装饰与差异色块画在同一块画布上（`diffOverview.ruler`），
   * 二者共用一套行→像素换算；这里分成两层——色块仍是 DOM（既有的像素口径与测试），
   * 新标记在它上面的画布（`z-index: 1`），滑块仍压在最上层（`.diff-viewport` 的 `z-index: 10`）。
   * 换算与色块**同一条轴**（`overviewAxis`）⇒ 色带与光标条不会在同一条概览上错开。
   */
  const paintMarkers = (side: DiffSide, ruler: HTMLElement, canvas: HTMLCanvasElement): void => {
    const view = viewOf(side);
    const axis = overviewAxis(side);
    if (!view || !axis) return;
    const width = ruler.clientWidth;
    const height = ruler.clientHeight;
    if (!(axis.total > 0) || !(width > 0) || !(height > 0)) return;
    const rects = layoutOverview(
      overviewZones(view.state),
      { height: axis.total, topOf: axis.topOf, heightOf: axis.heightOf },
      width,
      height,
    );
    paintOverview(canvas, rects);
  };

  const renderMarkers = (): void => {
    paintMarkers("original", originalRulerEl, originalCanvasEl);
    paintMarkers("modified", modifiedRulerEl, modifiedCanvasEl);
  };

  /** 概览条重画：批块、折叠、主题换壳都从这一颗口子收口（调用方统一在 `refreshArms`）。 */
  const renderOverview = (): void => {
    paintRuler("original", originalRulerEl);
    paintRuler("modified", modifiedRulerEl);
    renderMarkers();
    renderViewport();
  };

  /**
   * 概览条兼作右栏的纵向滚动条（原生那条已由 `diff.css` 收成 0 宽）。
   * 指针按下即跳到对应高度、拖动连续跟手；滚轮转发给右栏 —— VS Code 的 `diffOverview`
   * 也是把 pointerdown / wheel 直接交给 modified editor 的滚动机构。
   *
   * 拖动走**窗口级**监听，不靠元素上的指针捕获：上游 `GlobalPointerMoveMonitor` 也是全局监听。
   * 捕获那条在真机上有个洞 —— 指针拖到窗口外再松手，`pointerup` 送不回这个元素，「正在拖」
   * 的标记与捕获就永远留着，之后不按键移动鼠标也在改 `scrollTop`（看起来就是「拖不动 / 粘住」）。
   * 收尾判据照上游：按键状态一变就停（`e.buttons !== initialButtons` ⇒ `stopMonitoring`）。
   */
  const scrollToClientY = (clientY: number): void => {
    const axis = overviewAxis("modified");
    if (!axis || !(axis.total > 0)) return;
    const rect = overviewEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1);
    scrollToAxisY(ratio * axis.total);
  };
  let draggingOverview = false;
  /**
   * 按下点到滑块顶部的距离（像素）。
   *
   * 拖拽必须按**位移**走，不能让滑块顶部跳到指针：上游 `AbstractScrollbar` 的滑块拖动也是
   * 记一个 `pointerOffset`（按下位置 − 滑块位置），移动时 `newSliderPosition = pointerPosition
   * - pointerOffset`。没有这一份偏移，按下瞬间滑块会整体上跳半截，之后每次移动都在「重新对顶」，
   * 手感像在拽一根弹簧。
   */
  let dragOffset = 0;
  /** 收尾：把窗口级监听全摘掉（松手 / 指针被系统取消 / 旁路拆掉都走这一条）。 */
  const endOverviewDrag = (): void => {
    if (!draggingOverview) return;
    draggingOverview = false;
    viewportEl.classList.remove("is-dragging");
    window.removeEventListener("pointermove", onOverviewMove);
    window.removeEventListener("pointerup", endOverviewDrag);
    window.removeEventListener("pointercancel", endOverviewDrag);
  };
  const onOverviewDown = (e: PointerEvent): void => {
    // 只认左键（上游 `AbstractScrollbar._onPointerDown` 的 `isLeftClick` 同一判据）。
    if (e.button !== 0) return;
    // 不抢默认行为：否则按在概览条上会起一次文本选择 / 原生拖拽，拖动中途被它打断。
    e.preventDefault();
    // 按在滑块上 ⇒ 记抓取点；按在轨道上 ⇒ 先跳到指针处，再从「顶部对齐指针」继续拖
    // （与原来的轨道点击行为一致，只是随后拖动不再跳回）。
    const thumb = viewportEl.getBoundingClientRect();
    const onThumb =
      !viewportEl.classList.contains("is-hidden") &&
      thumb.height > 0 &&
      e.clientY >= thumb.top &&
      e.clientY <= thumb.bottom;
    if (onThumb) {
      dragOffset = e.clientY - thumb.top;
    } else {
      dragOffset = 0;
      scrollToClientY(e.clientY);
    }
    draggingOverview = true;
    // 拖动期间窗口级监听，`:active` 会在指针离开滑块后失效 ⇒ 用类名钉住「正在拖」这一态。
    viewportEl.classList.add("is-dragging");
    window.addEventListener("pointermove", onOverviewMove);
    window.addEventListener("pointerup", endOverviewDrag);
    window.addEventListener("pointercancel", endOverviewDrag);
  };
  const onOverviewMove = (e: PointerEvent): void => {
    if (!draggingOverview) return;
    if (e.buttons !== 1) {
      endOverviewDrag();
      return;
    }
    const axis = overviewAxis("modified");
    if (!axis) return;
    const rect = overviewEl.getBoundingClientRect();
    const thumb = viewportEl.getBoundingClientRect();
    const travel = rect.height - thumb.height;
    const span = Math.max(axis.total - (right?.scrollDOM.clientHeight ?? 0), 0);
    if (!(travel > 0) || !(span > 0)) return;
    // 指针位置 → 滑块顶部 → 轴坐标：与 renderViewport 的 top = axisTop / span × travel 互逆，
    // 因此一轮拖完再拖不会累积漂移（每轮都从实测的 getBoundingClientRect 重新起算）。
    const top = Math.min(Math.max(e.clientY - rect.top - dragOffset, 0), travel);
    scrollToAxisY((top / travel) * span);
  };
  const onOverviewWheel = (e: WheelEvent): void => {
    const scroller = right?.scrollDOM;
    if (!scroller) return;
    e.preventDefault();
    scroller.scrollTop += e.deltaY;
  };
  /**
   * 两栏同步滚动（默认开）：**把驱动栏的视口顶换成对栏同一个内容位置**。
   *
   * 缝计划取整篇一次量准的实测行高（`meterGapPlans`）⇒ 每个对齐段两侧等高、段首同 y；
   * 两栏各自的 `scrollTop` 却不一定相等 —— 行高地图的视口外部分是估值，两侧估值差多少，
   * 同一像素就错开多少（切标签后实测能差半屏）。所以按「段首行 + 段内偏移」换算
   * （`alignSpan`），而不是照搬像素。
   *
   * `ownPos` 只用来认出「这一发是我写的」：回声一律早退，不再反向映射。
   */
  let syncOn = true;
  /** 布局变化后以哪一栏为准：最后一次**用户**滚动的那一栏（默认右栏 —— 那份可编辑正文）。 */
  let lastDriver: DiffSide = "modified";
  /**
   * 每一格「此刻应在的位置」：只记我们自己造成的、或布局刚收口的那一个点。
   *
   * 判据只有一条：scroll 读数与它差在 1px 内 ⇒ 这一发是我们造成的（程序写入的回声，或
   * CM6 测量里的滚动锚定），吞掉；否则 ⇒ 用户滚的。
   *
   * 为什么程序写入必须记**写后读回值**而不是意图值：对栏还没量完时浏览器会把越界的写入
   * 夹到当前可滚上限，回声带着夹后的值回来。记意图的话这一发与登记对不上，就会被当成
   * 「用户滚了这一栏」—— 驱动侧翻转、右栏被拽到夹后位置，而左栏的露出口（只在右栏驱动的
   * 收口里）此后再不执行，用户看到的就是「左栏空白、滚动条位置也变了，滚一下才恢复」。
   *
   * 测量期间的锚定写入与程序写入**共用这一本**：两者要回答的是同一个问题，分开记就必然
   * 有一边漏判（布局变化期间两栏来回拽，就是用户看到的滚动位置反复抖）。
   */
  const ownPos = new WeakMap<HTMLElement, { top: number; left: number }>();
  /**
   * 差异面里**唯一**允许直接写两栏 `scrollTop/scrollLeft` 的地方。
   *
   * 写后立刻读回：只有真的移动过才登记（没移动就没有 scroll 事件，留登记会吞掉下一发真
   * 滚动）；登记的是读回值（见 `ownPos`）。返回值是「这一发是否落到了目标」，被夹住 ⇒
   * false ⇒ 调用方排下一轮测量收口再映射一次。
   */
  const writeScroll = (view: EditorView, top: number, left: number): boolean => {
    const el = view.scrollDOM;
    const beforeTop = el.scrollTop;
    const beforeLeft = el.scrollLeft;
    el.scrollTop = top;
    el.scrollLeft = left;
    const landedTop = el.scrollTop;
    const landedLeft = el.scrollLeft;
    if (Math.abs(landedTop - beforeTop) > 0.5 || Math.abs(landedLeft - beforeLeft) > 0.5) {
      ownPos.set(el, { top: landedTop, left: landedLeft });
    }
    if (Math.abs(landedTop - top) > 1) {
      diffTrace(
        panel,
        `写[${panel.view?.view === view ? "右" : "左"}]被夹住 目标=${top.toFixed(1)} 读回=${landedTop.toFixed(1)} 可滚=${(el.scrollHeight - el.clientHeight).toFixed(1)}`,
      );
    }
    return Math.abs(landedTop - top) <= 1;
  };
  /** 把某一格此刻的位置直接登记成自己人（不写、不移动）。 */
  const claimScroll = (view: EditorView): void => {
    const el = view.scrollDOM;
    ownPos.set(el, { top: el.scrollTop, left: el.scrollLeft });
  };
  /**
   * 布局收口：两栏此刻停在哪，就登记成「自己人」的位置。
   *
   * 必须在微任务里跑：锚定写在量测回调（rAF）里，scroll 事件在渲染步派发，中间只有这个
   * 空隙能读到**写完**的值；监听器里同步读到的还是锚定之前的。
   */
  const settleScroll = (): void => {
    queueMicrotask(() => {
      if (disposed) return;
      for (const view of [left, right]) {
        if (view) claimScroll(view);
      }
    });
  };
  /** 这一发 scroll 是不是我们自己造成的（是 ⇒ 消费掉登记，且不再反向映射）。 */
  const isOwnScroll = (el: HTMLElement | undefined): boolean => {
    if (!el) return false;
    const want = ownPos.get(el);
    ownPos.delete(el);
    if (!want) return false;
    return Math.abs(el.scrollTop - want.top) <= 1 && Math.abs(el.scrollLeft - want.left) <= 1;
  };

  /**
   * 左栏是否已经露出来（见 `revealLeft`）。
   */
  let leftShown = false;
  /** 左栏露出前是否已经按估值预定位过一轮（见 `resyncSharedOffset` 的露出判据）。 */
  let leftProbed = false;
  /**
   * 左栏第一次被右栏的映射落过位之前先藏着，落过且右栏不在落位隐藏期时**同一同步栈里**
   * 露出来（与 `landVisibleSideAtV` 的 hide-then-reveal 同一手法：藏/露之间没有绘制机会）。
   *
   * 判据是「右栏→左栏的那一发映射已经写进且落定」，不是「两栏 scrollTop 相等」——
   * 两栏的行高地图各含视口外估值，对齐位置本来就不一定同像素（见 `mirrorScroll`）。
   */
  const revealLeft = (): void => {
    if (leftShown || !right) return;
    // 右栏正在落位链里藏着：那一侧的中间态本来就不许画出来，这一栏跟着等。
    if (right.scrollDOM.style.visibility === "hidden") {
      diffTrace(panel, "露出让路：右栏还在落位链里藏着");
      return;
    }
    leftShown = true;
    left.scrollDOM.style.visibility = "";
    diffTrace(
      panel,
      `左栏露出 左=${left.scrollDOM.scrollTop.toFixed(1)} 右=${right.scrollDOM.scrollTop.toFixed(1)}`,
    );
  };
  /** 驱动栏视口顶落在哪个文档行（1-based）。 */
  const topLine = (view: EditorView, top: number): number =>
    view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number;
  /**
   * 视口顶是不是落在**占位缝内部**。
   *
   * 缝（`face.ts` 的 `DiffGapWidget`）高 = 对侧同一段多出来的实测像素，且落在对齐段的尾部
   * ⇒ 段的起点两侧同 y、总高相等，缝的像素区间与对侧那段内容严格同起点同高度，缝内任意
   * y 在两栏指同一个位置。这一档必须按像素一一映射：继续走「锚点行 + 段内偏移」会被锚点行
   * 的块高压住（`otherEndTop` 把整条缝缩成一行）。
   *
   * 只认 `WidgetAfter` / `WidgetBefore`（缝的两种落法，见 `face.ts` 的 `buildGapFace`）；
   * 折条是 `Decoration.replace` 的 `WidgetRange`，不是「对侧多出来的高度」，不在此列。
   */
  const inGap = (view: EditorView, top: number): boolean => {
    const block = view.lineBlockAtHeight(top);
    if (!Array.isArray(block.type)) return false;
    return block.type.some(
      (part) =>
        (part.type === BlockType.WidgetAfter || part.type === BlockType.WidgetBefore) &&
        top >= part.top &&
        top < part.top + part.height,
    );
  };
  /**
   * 驱动栏第 `line` 行落在哪个**对齐段**里，以及对栏那一段的首/末行（1-based）。
   *
   * 为什么锚在「段」而不是「行」：折行打开后同一文档行在两栏的视觉高度不同（栏宽不同），
   * 行内像素比例没有任何对应关系。但 `gapZones` 已经保证**每个对齐段两侧总高相等**
   * （块首 → 字符级对齐边界 → 块尾，加上未改动区逐行对齐）—— 段内任意像素偏移在两栏
   * 指向同一个视觉位置，这正是 VS Code 的 alignment view zone 语义。所以块内必须搬
   * 「相对段首的像素」，行号只在未改动区还能当锚（那里两侧逐行等高）。
   *
   * 段首/段末都从 `stops` 取（与 `gapZones` 同一份 `inner.alignments`）：两处若各算一套
   * 边界，缝补在一处、滚动锚在另一处，段内就会差出缝的那一截。
   */
  interface AlignSpan {
    ownStart: number;
    otherStart: number;
    /** 对栏段的结束行（不含；未改动区就是 otherStart 自己） */
    otherEnd: number;
    /**
     * 这一段在对栏**一行都不占**（对栏整段是一条缝）。
     *
     * 此时 `otherStart` 是缝**后面**那一行，拿它当段首会把对栏直接推到段尾；调用方必须
     * 改用像素一一对应（段首两侧同 y、段内总高相等，缝就是这段在对栏的全部内容）。
     */
    otherFlat: boolean;
  }

  const alignSpan = (side: DiffSide, line: number): AlignSpan => {
    const other = viewOf(side === "original" ? "modified" : "original");
    const clampLine = (n: number): number =>
      other ? Math.min(Math.max(n, 1), other.state.doc.lines) : 1;
    const ownSpan = (b: DiffBlock) =>
      side === "original"
        ? { start: b.originalStart, end: b.originalEnd }
        : { start: b.modifiedStart, end: b.modifiedEnd };
    const otherSpan = (b: DiffBlock) =>
      side === "original"
        ? { start: b.modifiedStart, end: b.modifiedEnd }
        : { start: b.originalStart, end: b.originalEnd };
    for (let i = 0; i < stored.length; i++) {
      const b = stored[i];
      const own = ownSpan(b);
      const opp = otherSpan(b);
      if (line < own.start) {
        // 未改动区：两侧行数相等且逐行等高，行号平移即是像素平移。
        const mapped = clampLine(line + (opp.start - own.start));
        return { ownStart: line, otherStart: mapped, otherEnd: mapped, otherFlat: false };
      }
      if (line <= own.end) {
        const stops = [
          { originalLine: b.originalStart, modifiedLine: b.modifiedStart },
          ...(inner.alignments[i] ?? []),
          { originalLine: b.originalEnd + 1, modifiedLine: b.modifiedEnd + 1 },
        ];
        const at = (p: { originalLine: number; modifiedLine: number }): number =>
          side === "original" ? p.originalLine : p.modifiedLine;
        const to = (p: { originalLine: number; modifiedLine: number }): number =>
          side === "original" ? p.modifiedLine : p.originalLine;
        let k = 0;
        while (k + 1 < stops.length && at(stops[k + 1]) <= line) k++;
        const cur = stops[k];
        const next = to(stops[k + 1] ?? cur);
        return {
          ownStart: at(cur),
          otherStart: clampLine(to(cur)),
          otherEnd: clampLine(next),
          otherFlat: next <= to(cur),
        };
      }
    }
    const b = stored[stored.length - 1];
    if (!b)
      return {
        ownStart: line,
        otherStart: clampLine(line),
        otherEnd: clampLine(line),
        otherFlat: false,
      };
    const own = ownSpan(b);
    const opp = otherSpan(b);
    const mapped = clampLine(line + (opp.end - own.end));
    return { ownStart: line, otherStart: mapped, otherEnd: mapped, otherFlat: false };
  };

  /**
   * 把驱动栏的视口顶换成对栏的**同一个内容位置**；返回对栏是否真的落到了算出来的位置
   * （被浏览器夹住时是 false —— 对栏还没量完，这一发不算数）。
   *
   * 不能直接搬 `scrollTop`：两栏的行高地图都含视口外估值，估值差多少，同一像素就错开多少
   * （实测切标签后能差半屏）。这里按「段首行 + 段内偏移」换算：段首两侧同 y、段内总高相等
   * （`gapZones` 的产出），所以段内偏移原样搬即可；视口顶落在缝里时缝与对侧同起点同高，
   * 直接按像素。
   *
   * 只从驱动侧往对侧算，回写不会反过来再触发一次（回声判定见 `isOwnScroll`）。
   */
  const mirrorScroll = (from: EditorView | null, to: EditorView | null): boolean => {
    if (!syncOn || !from || !to || from === to) return false;
    const a = from.scrollDOM;
    const b = to.scrollDOM;
    const side: DiffSide = from === left ? "original" : "modified";
    const top = Math.max(a.scrollTop, 0);
    let want: number;
    if (inGap(from, top)) {
      // 视口顶落在缝里：缝与对侧那一段同起点同高 ⇒ 像素一一对应（见 `inGap`）。
      want = top;
    } else {
      const line = topLine(from, top);
      const span = alignSpan(side, line);
      if (span.otherFlat) {
        // 这一段对侧一行都没有（对侧整段是一条缝）：`otherStart` 是缝**后面**那一行，
        // 当段首用会把对栏立刻推到段尾。缝就是这一段在对侧的全部内容，段首两侧同 y
        // ⇒ 像素一一对应。
        want = top;
      } else {
        const ownLine = from.state.doc.line(
          Math.min(Math.max(span.ownStart, 1), from.state.doc.lines),
        );
        const otherLine = to.state.doc.line(span.otherStart);
        const ownBlock = from.lineBlockAt(ownLine.from);
        const otherBlock = to.lineBlockAt(otherLine.from);
        // 段内偏移：段首已经补过缝，段内两侧等高 ⇒ 这个像素量在对栏指同一个位置。
        const offset = Math.max(top - ownBlock.top, 0);
        const otherEndTop =
          span.otherEnd > span.otherStart
            ? to.lineBlockAt(to.state.doc.line(span.otherEnd).from).top
            : otherBlock.top + Math.max(otherBlock.height, 0);
        // 段内偏移夹在段尾之前。
        want = Math.min(otherBlock.top + offset, otherEndTop);
      }
    }
    // 再夹一次全局可滚范围（末段贴近文档尾时可能到不了目标位置）。
    want = Math.min(Math.max(want, 0), Math.max(b.scrollHeight - b.clientHeight, 0));
    // 横向按「对栏能滚到哪」夹：两栏折行态一致时通常同宽，长行时对侧可能短一截。
    const wantX = Math.min(Math.max(a.scrollLeft, 0), Math.max(b.scrollWidth - b.clientWidth, 0));
    // 值没变就别写：写同一个值一样会排一发 scroll，白白多记一条回声。
    if (Math.abs(b.scrollTop - want) < 0.5 && Math.abs(b.scrollLeft - wantX) < 0.5) return true;
    // 浏览器把写入夹住了（对栏还没量完）⇒ 这一发不算落定，下一轮收口会再算一次。
    return writeScroll(to, want, wantX);
  };
  /**
   * 把 `lastDriver` 一侧的位置重新落给对栏：布局收口与重新打开同步都从这一颗走。
   *
   * 左栏「能不能露出来」也在这里判（`revealLeft`）：收口是唯一保证两栏都按**实测行盒**
   * 量过一轮的时机；滚动事件里的映射可能还赶在左栏量完之前，那时露出会看到一帧错位。
   */
  const resyncSharedOffset = (): void => {
    if (!syncOn || disposed) return;
    // 没露过面的左栏不可能是驱动侧：它没有用户滚动，落点只可能是我们写进去的。
    // 认它当驱动侧会拿一栏没实测的位置去拽右栏，而且这一支在露出之前就 return ——
    // 左栏从此一直藏着（用户报的「左边空白，滚一下才出来」）。
    if (lastDriver === "original" && leftShown) {
      diffTrace(panel, "收口 驱动=左");
      mirrorScroll(left, right);
      return;
    }
    // 写不进去（对栏还没量完，被浏览器夹住）⇒ 这一发不算落定，下一轮收口再算。
    if (!mirrorScroll(right, left)) {
      diffTrace(panel, "收口 驱动=右·被夹住 ⇒ 再排一轮");
      scheduleAlign();
      return;
    }
    if (leftShown) return;
    diffTrace(
      panel,
      `收口 驱动=右 左未露 探=${leftProbed} 右=${right?.scrollDOM.scrollTop.toFixed(1)} 左=${left.scrollDOM.scrollTop.toFixed(1)}`,
    );
    // 左栏还没露过：它的视口此前停在别处（首帧在顶部），CM6 还没实测目标那一段，
    // 这一轮写进去的只是按估值算出的位置。再排一轮测量，等目标区被实测后再写一次，
    // 第二轮落定才露出 —— 否则露出的是估值的错位帧（探针实测会差几百像素）。
    if (!leftProbed) {
      leftProbed = true;
      scheduleAlign();
      return;
    }
    revealLeft();
  };
  const setSyncScrollEnabled = (on: boolean): void => {
    if (syncOn === on) return;
    syncOn = on;
    // 打开时立刻对齐一次，否则要等用户滚一下才「生效」。
    if (on) resyncSharedOffset();
  };
  const onRightScroll = (): void => {
    renderViewport();
    // 自己写下的回声：只认领、不再反向映射（见上面那段注释）。
    if (isOwnScroll(right?.scrollDOM)) {
      // 布局锚定改的是**非驱动栏**的 scrollTop：那一栏没有自己的意志，立刻贴回驱动栏。
      // 不贴的话要等下一个收口（1–2 帧后）才被拉回，用户能看到一帧的错位。
      if (syncOn && lastDriver === "original") mirrorScroll(left, right);
      renderReverts();
      return;
    }
    lastDriver = "modified";
    mirrorScroll(right, left);
    renderReverts();
  };
  const onLeftScroll = (): void => {
    if (isOwnScroll(left?.scrollDOM)) {
      if (syncOn && lastDriver === "modified") mirrorScroll(right, left);
      return;
    }
    lastDriver = "original";
    mirrorScroll(left, right);
  };
  /** 点中间列的空白 = 把焦点交给右栏（VS Code 的 gutter 也是这个语义）。 */
  const onCenterDown = (e: MouseEvent): void => {
    if ((e.target as HTMLElement | null)?.closest(".diff-revert")) return;
    right?.focus();
  };
  /**
   * 滚轮落在中间列 ⇒ 委托右栏滚动（上游 `DiffEditorGutter` 把 wheel 交给 modified 编辑器：
   * `delegateScrollFromMouseWheelEvent`）。不委托的话，鼠标停在按钮列上滚轮完全不响应，
   * 那一列就成了 35px 宽的死区。`passive: false` 才能 `preventDefault`（否则外层还会再滚一次）。
   */
  const onCenterWheel = (e: WheelEvent): void => {
    if (!right) return;
    e.preventDefault();
    right.scrollDOM.scrollTop += e.deltaY;
    right.scrollDOM.scrollLeft += e.deltaX;
  };
  overviewEl.addEventListener("pointerdown", onOverviewDown);
  overviewEl.addEventListener("wheel", onOverviewWheel, { passive: false });
  centerEl.addEventListener("mousedown", onCenterDown);
  centerEl.addEventListener("wheel", onCenterWheel, { passive: false });
  left.scrollDOM.addEventListener("scroll", onLeftScroll, { passive: true });
  right?.scrollDOM.addEventListener("scroll", onRightScroll, { passive: true });
  const detachOverview = (): void => {
    endOverviewDrag();
    overviewEl.removeEventListener("pointerdown", onOverviewDown);
    overviewEl.removeEventListener("wheel", onOverviewWheel);
    centerEl.removeEventListener("mousedown", onCenterDown);
    centerEl.removeEventListener("wheel", onCenterWheel);
    left.scrollDOM.removeEventListener("scroll", onLeftScroll);
    right?.scrollDOM.removeEventListener("scroll", onRightScroll);
    overviewEl.remove();
  };

  /** 现读左右两份正文 → diffBlocks → 给两颗 view 各发 refreshDiff（+ 折叠态）→ 广播新块表。 */
  const syncBlocks = (): void => {
    stored = computeBlocks();
    inner = computeInner(stored);
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
   * 合法路（A 档那道只读硬闸会把 `dispatch({changes})` 整发丢掉；B 档可编辑时这里走
   * 「现值 ≠ 左栏正文」的漂移兜底），换完再补一发 `syncBlocks()`。
   */
  const resetLeftDoc = (): void => {
    lastTheme = themeOf();
    left.setState(
      leftState(
        current,
        leftPerf(),
        leftFace.of(leftArm()),
        themeSlot.of(lastTheme),
        leftWrap.of(wrapValue()),
        leftInvisibles.of(invisiblesValue()),
        leftWritable,
      ),
    );
    // `setState` 会把 `scrollTop` 归零，随之而来的那一发 scroll 不是用户滚的。
    // 不登记就会被判成「用户滚了左栏」⇒ 驱动侧翻过去，右栏被拽到顶部。
    claimScroll(left);
    // 左栏那份正文刚被换掉（存盘 / 以磁盘为准重载）：它上一次的位置指的不再是同一份内容，
    // 留着它当驱动侧只会把右栏拽到新正文的某一行上。此刻右栏是唯一还站着的内容。
    lastDriver = "modified";
    syncBlocks();
  };

  /** 右栏光标行：跳块/步进的起算侧固定右栏（与回退列「最后光标」口径分开）。 */
  const rightCaretLine = (): number => caretLineOf("modified");

  /**
   * 最后落焦那一栏的光标包住的那块；没有 ⇒ -1。
   *
   * 显隐跟**最后光标**走、不分左右（用户口径）：只认右栏时，光标停在左栏，
   * 常显的按钮却只认右栏那一段，看起来像"没跟着光标"。
   */
  const activeIndex = (): number => {
    if (!right) return -1;
    return blockAt(stored, focused, caretLineOf(focused));
  };

  /**
   * 两侧同时落位到各自那段的起始行（设计稿 ⑥·面板）。
   *
   * 索引越界夹到首/末块（不环绕 —— 走到头再按一次就是停在那一块，与「跳过头」比环绕好懂）。
   *
   * ⚠️ 落位之前先 `unfoldAroundLines` 两侧各自那一行（Task 7 那一发，位置就钉在这里）：
   * 目标行被折进收起区时，被替换掉的折区行仍在文档里 ⇒ 光标会「落到看不见的那一行」，
   * 而用户看到的是停在别处。两栏的行轴不同 ⇒ 两侧各查一遍，别只查右栏。
   *
   * 两颗 view 的落法不一样（左栏普通派发 / 右栏同步写 + 同栈认领，裁决 R25）—— 那一手的
   * 完整理由写在 `landSide` 上，跳块与步进共用它，不各写一份。
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
    // 走到头 ⇒ **环绕**（上游 `goToNextDiff` / `goToPreviousDiff` 到头就回另一头）：
    // 末块再点下一个回首块、首块往回点回末块。
    jumpTo(target < 0 ? (dir === 1 ? 0 : stored.length - 1) : target);
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

  /**
   * 中间那列的「回退此块」按钮（VS Code `DiffEditorGutter` 的 hunk toolbar）。
   *
   * 几何照上游两层：`EditorGutter.render` 给每个 item 的 `top/height` 取的是**整块**
   * （`getTopForLineNumber(start, true)` → `getBottomForLineNumber(end, true)`，含缝），
   * `DiffToolBar.layout` 再把按钮垂直居中于这一块、并按「视口 / 父区间」两级夹取：
   *   · 视口：`[按钮高, 列高 - 2 × 按钮高]`；
   *   · 父区间：`[块顶 + 按钮高, 块底 - 2 × 按钮高]`，只有块高 > 3 × 按钮高才生效
   *     （照上游 `preferredParentRange.start < endExclusive` 那条门槛）。
   * 块完全在视口外就不建（上游同样只渲染可见的 item）。显隐交给 CSS：默认 `opacity: 0`，
   * `.diff-center:hover` 或 `.is-current`（光标所在块）时显示 —— 对应上游 hover + `showAlways`。
   */
  const renderReverts = (): void => {
    revertLayerEl.replaceChildren();
    const view = right;
    if (!view) return;
    const column = centerEl.getBoundingClientRect();
    if (column.height <= 0) return;
    const doc = view.state.doc;
    const active = activeIndex();
    // 与 `.diff-revert` 的 CSS 高度一致（VS Code 那颗按钮：`.action-label` 的
    // 1px 上下内边距 + 16px codicon = 18px）。
    const BTN_H = 18;
    /** 这一行行首的顶（含它上方的缝）；超过末行 ⇒ 末行底。 */
    const boundaryOf = (line: number): number => {
      const n = Math.max(line, 1);
      const block =
        n <= doc.lines
          ? view.lineBlockAt(doc.line(n).from)
          : view.lineBlockAt(doc.line(doc.lines).from);
      const y = n <= doc.lines ? block.top : block.bottom;
      return view.documentTop + y - column.top;
    };
    /**
     * 第 `line` 行**文本自己的**顶/底（剥掉紧贴行尾的缝，也不含它上方那条缝）。
     *
     * ⚠️ 这是**按钮的锚点**（竖线的上下沿另按块边界算）：`lineBlockAt(...).bottom` 会把
     * 紧贴行尾的对齐缝并进 composite，单行块后面补一段 40px 时按钮就被推到缝里（用户抓到的
     * 「单行 / 单行自动换行时没落在差异行中间」）。`textBlockOf` 只取 `BlockType.Text`
     * 那一块，折行出来的视觉行仍算在行内（高度就是整条文本块）。
     */
    const textBox = (line: number): { top: number; bottom: number } => {
      const n = Math.min(Math.max(line, 1), doc.lines);
      const b = textBlockOf(view, n);
      const top = view.documentTop + b.top - column.top;
      return { top, bottom: top + b.height };
    };
    for (let i = 0; i < stored.length; i++) {
      const b = stored[i];
      // 块的可视纵向范围：
      //   · 非空段 = 首行文本顶 → 块尾边界。块尾那条紧贴末行行尾的对齐缝也算进来
      //     （上游 `getBottomForLineNumber(end, true)` 同口径）：对侧折行 / 缺行多出来的
      //     那一截正是这条缝，竖线要盖到这一块真正结束的地方，不能停在末行文本底；
      //   · 空段（删除块跨在右栏的落点行上）= 它面前那条缝的范围（上一行文本底 → 块边界），
      //     否则 item 高 0，按钮停在缝的下沿、竖线根本画不出来。
      const empty = b.modifiedStart > b.modifiedEnd;
      const textTop = empty ? 0 : textBox(b.modifiedStart).top;
      const textBottom = empty ? 0 : textBox(b.modifiedEnd).bottom;
      const top = empty
        ? b.modifiedStart > 1
          ? textBox(Math.min(b.modifiedStart - 1, doc.lines)).bottom
          : view.documentTop - column.top
        : textTop;
      const bottom = empty ? boundaryOf(b.modifiedStart) : boundaryOf(b.modifiedEnd + 1);
      const height = Math.max(bottom - top, 0);
      // 块完全在视口上下各一个按钮的余量之外 ⇒ 这一颗不建。
      if (top + height < -BTN_H || top > column.height + BTN_H) continue;

      // 居中 + 两级夹取（顺序也照上游：先视口、后父区间）。锚点用**差异行文本范围**：
      // item 高现在含块尾缝，直接拿它居中会把按钮推进缝里（B464）。
      const anchorTop = empty ? top : textTop;
      const anchorHeight = empty ? height : textBottom - textTop;
      let y = anchorTop + anchorHeight / 2 - BTN_H / 2;
      const viewStart = BTN_H;
      const viewEnd = column.height - 2 * BTN_H;
      const parentStart = anchorTop + BTN_H;
      const parentEnd = anchorTop + anchorHeight - 2 * BTN_H;
      if (parentEnd > parentStart && viewEnd > viewStart) {
        y = Math.min(Math.max(y, viewStart), viewEnd);
        y = Math.min(Math.max(y, parentStart), parentEnd);
      }

      // 每块一条竖线（上游 `.gutterItem .background` 是相对 item 的 `height: 100%`），
      // 与按钮同处一个 item ⇒ 显隐、透明度过渡都跟按钮走。
      const item = document.createElement("div");
      item.className = "diff-revert-item";
      if (i === active) item.classList.add("is-current");
      item.style.top = `${top}px`;
      item.style.height = `${height}px`;
      const rule = document.createElement("div");
      rule.className = "diff-revert-line";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "diff-revert";
      btn.style.top = `${y - top}px`;
      btn.innerHTML = CODICONS.arrowRight;
      // 可访问名称与提示同源：字形是 `aria-hidden` 的 `<i>`，读屏器认的只有这一句。
      // 提示走全应用统一的那一套（原生 `title` 由系统绘制、不吃主题，B2xx 起禁用）。
      btn.setAttribute("aria-label", REVERT_LABEL);
      setTip(btn, REVERT_LABEL);
      // mousedown 只掐掉焦点转移：点这颗键不该清掉编辑器里的选区（上游 button 同款处理）。
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        revertAt(i, b.modifiedStart);
      });

      item.append(rule, btn);
      revertLayerEl.appendChild(item);
    }
  };

  /**
   * 点下「回退」：把这一块的原稿写回右栏（边界算术在 `revert.ts`，可单测）。
   *
   * 点之前若还有防抖中的重算 ⇒ 先按现在的正文重算一遍，再按**行号**重新认块：按钮的序号是
   * 渲染那一刻的，用户打了一个字之后序号可能已经变了，照旧序号改文档会改错行。
   */
  const revertAt = (index: number, wantStart: number): void => {
    if (!right) return;
    if (syncTimer !== null) {
      cancelSync();
      syncBlocks();
    }
    if (!stored[index] || stored[index].modifiedStart !== wantStart) {
      index = stored.findIndex((b) => b.modifiedStart === wantStart);
      if (index < 0) return;
    }
    const edit = revertEdit(current.leftText(), right.state.doc.toString(), stored[index]);
    if (!edit) return;
    // 普通文档编辑：撤销栈、脏标记、防抖重算全部照旧，没有第二套写入机制。
    right.dispatch({ changes: edit });
    writeBackRight();
    syncBlocks();
    // 行高/折行层的几何在下一帧 measure 后才更新：补一帧，剩下的按钮才不会停在旧位置上。
    requestAnimationFrame(() => renderReverts());
    right.focus();
  };

  /**
   * 布局落地之后再画一次（首帧 / 换面板 / 拖分屏 / 放大还原）。
   *
   * `createDiffSurface` 末尾那一发 `refreshArms()` 是同步跑的：那一刻这一格可能还没进文档，
   * `scrollDOM.clientHeight` 与 `.diff-center` 的 `getBoundingClientRect()` 都量到 0 ⇒ 概览滑块
   * 被收成 0 高、回退键一颗都不建，此后只有滚动或换选区才会补画（真机截图抓到过：首屏中间列空白）。
   * 拖分屏同理 —— 两个几何都按像素算，尺寸不变就不会自己更正。
   *
   * jsdom 没有 ResizeObserver（与 `shell/findbar.ts` 同一口径）⇒ 整段跳过；测试路径靠显式调用。
   */
  let layoutRO: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    layoutRO = new ResizeObserver(() => {
      // 宽度变了 ⇒ 折行的视觉行数可能变，缝必须重测；高度变了只影响滑块，但一起重画最省。
      // 概览轴也要当场作废：连续拖动分屏时 `scheduleAlign` 每一轮都会被下一轮取代，收口里
      // 那次作废永远轮不到 ⇒ 滑块与色带一直画在旧宽度的地图上（用户报的「位置要拖动滚动条
      // 才刷新」）。RO 在 CM6 量完之后才来，这里读到的是新宽度的行盒。
      invalidateAxis();
      scheduleAlign();
      renderOverview();
      renderReverts();
    });
    // 三颗都要看：拖分屏改的是两栏**各占的宽度**，中心列（`.diff-center`）只挪位置、尺寸不动
    // ⇒ 只盯中心列时，分屏比例一变两侧行高就各走各的，填充总高从此对不上。
    layoutRO.observe(centerEl);
    layoutRO.observe(originalEl);
    if (right) layoutRO.observe(right.dom);
  }

  /** 右栏那一臂的内容：装饰 + 折条出口 + 键入落点（`updateListener` 是 state facet，只能并进来）。 */
  const rightArm = (): Extension => [
    diffFace("modified", () => ({ blocks: stored, gaps: gapPlans.modified, inner: inner.changes })),
    onFoldBarClick(onModifiedFoldReveal),
    onFoldMarkClick(onModifiedFoldMark),
    // 仓库同形先例 `tests/preview-face-helpers.ts:71-76`：塞进 `state.update({extensions})`
    // 会被静默丢掉，必须走 effect。
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        // 行数/正文换了 ⇒ 概览轴（按行记账）当场作废；缝的收口仍旧走防抖那一发。
        invalidateAxis();
        scheduleSync();
      }
      // 折叠期光标可能走进被替换掉的那几行（简报 Step 3 那条 ⚠️ 风险的另一半：
      // 落位之前有 `unfoldAround`，用户自己走进去这一路只能在这里补）。
      // ⚠️ `selectionSet` **一颗不够**（修复轮 Important 1 抓的第二路）：CM6 那一颗只认「这一发
      // 事务显式换了选区」—— 打字与程序化改文档时选区是被**映射**的，它是 false，而一发把折区
      // 压到光标上的改动（例如在折区上面那格上下文行的行尾按 Delete 并上来一行）正是这一类。
      // 两颗都听：`unfoldUnderCaret` 一进来就按 `foldOn` 早退，关着折叠时键入那一头分文不花；
      // 开着折叠时它只读几段行号与一次 `lineAt`，真正的重算仍旧排在防抖那一发（R24 不动）。
      if (update.selectionSet || update.docChanged) unfoldUnderCaret();
      // 同左栏：CM6 量完新宽度之后才发 geometryChanged，在这里重测缝才不会读到旧行高。
      // docChanged 那一类交给 `scheduleSync` 的防抖链路，不在这里按每一次按键重算。
      if (armed && update.geometryChanged) {
        settleScroll();
        if (!update.docChanged) scheduleAlign();
      }
      // 光标走进另一块 ⇒ 中间那列的高亮跟着走（VS Code 的 `showAlways` 是同一口径）。
      if (update.selectionSet) renderReverts();
      // 概览标记层（选区/光标/查找命中/同词出现）只吃本栏 state ⇒ 选区、正文、查找查询
      // 任一变化就重画这一块画布（差异色块与折叠仍由 `refreshArms` 统一收口）。
      if (
        update.selectionSet ||
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.length > 0)
      ) {
        paintMarkers("modified", modifiedRulerEl, modifiedCanvasEl);
      }
      // 左栏没有这一颗监听：那颗 view 的文档被硬闸钉住、不会自己动，光标停进折区也只是
      // 「选区看不见」（读不动的栏，打字那一条害处不成立）⇒ 它那一头由 `guardCaretsUnderFolds`
      // （两颗开关入口）、`liftCaretsOutOfRun`（行号区收起）与 `unfoldAroundLines`（落位）兜住。
    }),
  ];

  if (right) {
    // 把右栏那一槽换成本 surface 的臂。折行不在这里碰：它归标签自己的 `comps.wrap`
    //（全局开关的同一颗出口），旁路只借用、不改写。
    // 槽已在配置里 ⇒ `reconfigure`（顺带把上一颗 surface 留在快照里的旧 provider 顶掉，
    // 见 `rightFaceSlot` 的注释）；第一次挂 ⇒ `appendConfig` 把槽本身带进配置。
    const slotPresent = rightFaceSlot.get(right.state) !== undefined;
    right.dispatch({
      effects: [
        slotPresent
          ? rightFaceSlot.reconfigure(rightArm())
          : StateEffect.appendConfig.of(rightFaceSlot.of(rightArm())),
      ],
    });
  }
  // 换标签再换回来那一趟：`switchTab` 的同形回写会把**上一颗 surface 的折叠态**留在标签快照里
  //（`diffFoldField` 是模块级那颗，槽换挂时值不重建）⇒ 挂上这一刻必须按这一颗的口径重发一次
  // 折叠态（关着 ⇒ 两份空清单 = 把快照里那些被替换掉的行放回来）。
  // `refreshArms` 自己会先量一发缝：左栏刚建好时首帧就有占位块（不会闪一下错位）。
  refreshArms();

  /**
   * 补漂移（R20 / R22 / R23-2 的落笔处）。判据一律是「现值 ≠ 我挂上时那个样子」，
   * 一致就一个字节都不动 —— 这一发挂在 `applyPanelMode` 与 `refreshAll` 两条统一出口上，
   * 每次刷新都跑，空转必须是便宜的。
   */
  const reassert = (): void => {
    // ① 折行：全局开关改的是右栏借用的那颗 `comps.wrap`（`applyWrapToTabs` 自己会发），
    //    左栏这颗旁路自己的槽要对着设置补一次。关着也要补（用户可能在设置页打开折行）。
    const wrapped = leftWrap.get(left.state) === EditorView.lineWrapping;
    if (wrapped !== isWrap) left.dispatch({ effects: leftWrap.reconfigure(wrapValue()) });
    // ①-b 不可见字符：同一个道理 —— 右栏借用标签自己的槽，左栏这颗旁路要补自己的。
    const showing = leftInvisibles.get(left.state) === invisibleChars();
    if (showing !== showInvisibles) {
      left.dispatch({ effects: leftInvisibles.reconfigure(invisiblesValue()) });
    }
    // ② 主题：右栏换了色，左栏必须吃同一颗 —— 两半的 18% 改动色叠在不同基色上就不是同一个颜色。
    const themeNow = themeOf();
    if (themeNow !== lastTheme) {
      lastTheme = themeNow;
      left.dispatch({ effects: themeSlot.reconfigure(themeNow) });
    }
    // ③ 基线：`doc.baseline` 被就地换掉 ⇒ 左栏那份文档得跟上，否则新基线的块画在旧正文上。
    if (left.state.doc.toString() !== current.leftText()) resetLeftDoc();
    // ④ 几何：这一发挂在 `refreshAll` 上（设置页改字号/行距/主题也会经这里），行高可能刚变；
    //    重测一发，缝与按钮/色块跟着新行高走。空转时这次测量只是一次 `requestMeasure`。
    scheduleAlign();
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
    focusedSide: () => focused,
    ignoreTrimWhitespace: () => ignoreWs,
    setIgnoreTrimWhitespace: (on) => {
      if (ignoreWs === on) return;
      ignoreWs = on;
      // 立刻重算（不等防抖）：这是用户点下来的一发动作，不是键入。
      syncBlocks();
    },
    syncScrollEnabled: () => syncOn,
    setSyncScrollEnabled,
    // 左栏还没露过 ⇒ 它的行高地图还没按这一格的实测落过一遍，这一发写进去会被浏览器
    // 夹到当前可滚上限。不写：等下一轮「两栏 requestMeasure 都到齐 + 缝稳定」的收口
    // （`resyncSharedOffset` 里的映射，成功才 `revealLeft`）。那一轮**必须由这里排**：
    // 切标签时上一轮收口往往赶在右栏隐藏期（`revealLeft` 让路），之后没有东西保证收口
    // 再来一次 —— 不补这一排，左栏就一直藏着，直到用户滚动（用户报的「左边空白，
    // 滚一下才出来」）。
    syncLeftToRight: () => {
      // 宿主刚把右栏明确落到某个位置（切标签 / 重建落位）⇒ 此后以右栏为准，直到用户
      // 真的去滚某一栏。留着左栏上一次的位置当驱动侧，下一轮收口就会把右栏拽回旧位置。
      lastDriver = "modified";
      diffTrace(
        panel,
        `落位收口左露=${leftShown} 右=${right?.scrollDOM.scrollTop.toFixed(1)} 左=${left.scrollDOM.scrollTop.toFixed(1)}`,
      );
      if (!leftShown) {
        scheduleAlign();
        return;
      }
      // 已露过：直接扶；被夹住（对栏又进了未量完的窗口）就再排一轮测量收口。
      if (!mirrorScroll(right, left)) scheduleAlign();
    },
    reassert,
    remeasure: scheduleAlign,
    dispose: () => {
      disposed = true;
      window.removeEventListener("resize", onWindowResize);
      left.dom.removeEventListener("focusin", onLeftFocus);
      right?.dom.removeEventListener("focusin", onRightFocus);
      cancelSync();
      // 折叠状态跟着这一格退场（那颗 view 上的替换装饰已经随臂摘掉了，读口再报着
      // 折区就是两份真相 —— 拆掉的 surface 从此只报「没折」）。
      foldOn = false;
      revealRuns.clear();
      // 右栏那颗 view **不随旁路销毁**（它是那份文档本身）⇒ 这一臂必须精准摘掉，
      // 否则底色与占位块会留在一张普通编辑器标签上。槽值清成空 ⇒ 键入监听与两臂装饰一起走。
      // 那颗 view 已经 destroy 过的话这一发是空转（CM6 内部的 `destroyed` 分支），不抛错。
      right?.dispatch({ effects: rightFaceSlot.reconfigure([]) });
      detachSash();
      detachOverview();
      layoutRO?.disconnect();
      for (const meter of Object.values(meters)) meter.dispose();
      if (leftWritable && current.leftDocId != null) {
        const set = leftMirrors.get(current.leftDocId);
        set?.delete(leftMirror);
        if (set && set.size === 0) leftMirrors.delete(current.leftDocId);
      }
      left.destroy();
      originalEl.remove();
      // 分割线与按钮层都在这一列里，拆它一并带走。
      centerEl.remove();
      hostEl.classList.remove("is-diff");
      if (panel.diffSurface === surface) panel.diffSurface = null;
    },
  };
  panel.diffSurface = surface;
  // 挂完之前，两颗 view 的几何回调一律不排测量（`scheduleAlign` 那时还在 TDZ 里）。
  armed = true;
  diffTrace(
    panel,
    `挂上 左=${left.state.doc.lines} 行 右=${right?.state.doc.lines ?? 0} 行 右藏=${right?.scrollDOM.style.visibility === "hidden"}`,
  );
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
  } else if (have && have.spec() === want) {
    have.reassert();
  } else {
    if (have) disposeDiffSurface(panel);
    createDiffSurface(panel.bodyEl as HTMLElement, panel, want);
  }
  // 侧栏那一列永远跟着**此刻显示的那张标签**走（2026-11 修订，取代设计稿 ⑩·2 的「保持最后
  // 那块」）：挂上/拆掉/原地补漂移都要广播这一发，否则分屏下切到另一格时，列表画的还是
  // 上一格的东西（`syncDiffSurface` 是「这一格有没有旁路」的唯一判据入口，广播留在这里
  // 才不会漏掉某一条切标签的路）。
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

/**
 * 只重测几何（字号 / 代码字体 / 行距变了的时候）。
 *
 * 不走 `refreshDiffSurfaces`：那一条会判 spec 身份、必要时重建旁路，对 Ctrl+滚轮那种
 * 每一格都生效的高频动作太重；这里只让在挂的 surface 各排一次 `requestMeasure`。
 */
export function remeasureDiffSurfaces(): void {
  for (const panel of panels.values()) panel.diffSurface?.remeasure();
}
