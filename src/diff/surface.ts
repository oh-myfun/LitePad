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
// 两臂的装饰面（Task 3：两侧行底色 / 对侧占位块 / 中间指示带）**在这里装上，但不在这里建**：
// `face.ts` 出 `diffFace(side, blocks)`，本模块只管「哪颗 view 装哪一臂、什么时候装/拆」，
// 并把「现在这批块是什么」那一读取口交出去（预审 R1：两颗 Compartment 由本模块自己创建，
// `makeTabState` / `makeDiffInstance` 的扩展清单一个字都不改）。
// ⚠️ 右栏那颗 view 是**既有的** `Panel.view`，Task 1 没给它预留 diff 专用 Compartment
// （预留 = 空转的抽象）⇒ 装它只能走 CM6 唯一可行的「先建视图、后加配置」那一发
// `StateEffect.appendConfig`，并且把新 Compartment 一起并进去，好在拆旁路时精准摘掉这一臂。

import { Compartment, EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tabs, type Panel } from "../core/app-state";
import { claimVisibleHere } from "../sync-scroll/wire";
import { DIFF_REFRESH_MS } from "./align";
import { blockAt, diffBlocks, type DiffBlock } from "./blocks";
import { diffFace, refreshDiff } from "./face";
import { notifyDiffBlocks, type DiffSide, type DiffSpec } from "./model";

/** 一张差异标签挂在面板上的旁路 surface。 */
export interface DiffSurface {
  /** 左栏那颗只读视图（测试与 Task 4/7 的落位都直接按它寻址） */
  readonly left: EditorView;
  /** 当前输入描述（可交换 ⇒ 是取值口，不是冻结字段；预审 R3） */
  spec(): DiffSpec;
  /** B 档「交换左右」就地换输入用（不换 tabId；Task 6 拥有调用者） */
  retarget(spec: DiffSpec): void;
  /** 现读左右两份正文 → diffBlocks → 给两颗 view 各发 refreshDiff */
  syncBlocks(): void;
  /** 这一格现在那一批块（唯一一份答案：两侧底色、占位块、侧栏条目、跳块都吃它） */
  blocks(): DiffBlock[];
  /** 两侧同时落位；索引越界夹到首/末块；先 unfoldAround 目标（Task 7 补实现，此时为 no-op） */
  jumpTo(index: number): void;
  /** 以右栏光标行为起点找下一/上一块 */
  step(dir: 1 | -1): void;
  /** 右栏光标包住的那块；没有 ⇒ -1 */
  activeIndex(): number;
  ignoreTrimWhitespace(): boolean;
  /** 翻转后立刻 syncBlocks()（开关改的是「同一份正文算出来的块」，两栏自己跟上） */
  setIgnoreTrimWhitespace(on: boolean): void;
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
 * `theme` 给的是**右栏那颗 state 里主题 Compartment 的现值**（预审 R22）：两栏必须叠在同一颗
 * 基色上，18% 的改动色才在两半看着是同一个颜色，而左栏那一半原先**一颗主题都没装** ⇒ 画在页面
 * 底色上。取现值而不是在这儿再配一份：明暗与主题族的权威只有编辑器那一处（硬写 CSS 底色同样
 * 是第二处真相，dark / HC 族必然跟着错）。位置排在 `lineNumbers()` 之后 —— 与右栏
 * （`makeTabState` 里 gutter 在前、主题在后）同一层叠顺序。
 *
 * `face` 是这一臂装饰（`faceComp.of(diffFace("original", …))`，Task 3）：**CompartmentInstance
 * 必须出现在 state 的扩展清单里**，之后 `faceComp.reconfigure()` 才管得到它（CM6 的
 * `flatten` 只走 base 里出现过的 Compartment，没出现的那一发 reconfigure 是静默空转）。
 * `retarget` 走的是整态换 state，所以那一臂也只能靠这里带进去 —— 换进来的那颗 state
 * 若不含它，「交换左右」之后左栏就没有底色了。折叠不在这里（归 Task 7）。
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
 */
export function createDiffSurface(
  hostEl: HTMLElement,
  panel: Panel,
  spec: DiffSpec,
  opts: { ignoreTrimWhitespace?: boolean } = {},
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
  /** 两臂各自的 Compartment（预审 R1：本任务创建、attach 那一刻装上、dispose 时摘掉）。 */
  const leftFace = new Compartment();
  const rightFace = new Compartment();
  /** 右栏那颗 view（`Panel.view` 的本身）：装上/摘掉这一臂都按它寻址，不跟着 `panel.view` 漂。 */
  const right = panel.view?.view ?? null;
  /**
   * 这一格现在挂的那张标签（与 `wantedSpec` 同一寻址）：**两栏的折行与主题都从它身上取现值**。
   * 这两件事的权威各自只有一处（`makeTabState` 的 `comps.wrap` / `comps.theme`，
   * `src/editor/editor.ts:186-187`），差异面只是借用同一个出口读一遍 —— 不另配一份。
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
   * 就是它）⇒ attach 关掉、dispose 还回它**原来那个值**（出厂就关着的人，detach 之后仍是关着）。
   */
  let wrapComp: Compartment | null = null;
  let wrapWas: Extension | undefined;
  if (right && comps) {
    // 读出 `undefined` = 这颗 Compartment 根本不在那份配置里（面板显示的不是这张标签的 state）
    // ⇒ 这一手整段跳过：给配置里没有的 Compartment 发 reconfigure 等于凭空往 state 里装一颗。
    const previous = comps.wrap.get(right.state);
    if (previous !== undefined) {
      wrapComp = comps.wrap;
      wrapWas = previous;
    }
  }
  const wrapOff = wrapComp ? [wrapComp.reconfigure([])] : [];
  const wrapBack = wrapComp && wrapWas !== undefined ? [wrapComp.reconfigure(wrapWas)] : [];
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
  const left = new EditorView({
    parent: originalEl,
    state: leftState(current, leftFace.of(diffFace("original", () => stored)), themeOf()),
  });
  const detachSash = attachSashDrag(originalEl, sashEl);

  /** 右栏那颗 view 的 state 回写进标签快照（与 `handleUpdate` / `lifecycle` 同一个寻址）。 */
  const writeBackRight = (): void => {
    if (!right) return;
    const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
    if (tab) tab.state = right.state;
  };

  /** 现读左右两份正文 → diffBlocks → 给两颗 view 各发 refreshDiff → 广播新块表。 */
  const syncBlocks = (): void => {
    stored = computeBlocks();
    // 两颗都要点名：装饰层不会自己醒（`refreshDiff` 与 `refreshGutterDiff` 同形），
    // 而对栏那颗 view **看不见**这一栏的键入 ⇒ 只有持有两颗 view 的这一处能一起发。
    left.dispatch({ effects: refreshDiff.of(null) });
    right?.dispatch({ effects: refreshDiff.of(null) });
    writeBackRight();
    // Task 9 的侧栏面板从这里领新块表（surface **不 import** 面板模块 —— 单槽注册口，R6）。
    notifyDiffBlocks(current);
  };

  /** 右栏光标行（权威侧 = 右栏，设计稿 ⑩·2：左栏有选区也不参与）。 */
  const rightCaretLine = (): number => {
    if (!right) return 0;
    return right.state.doc.lineAt(right.state.selection.main.head).number;
  };

  /** 右栏光标包住的那块；没有 ⇒ -1。 */
  const activeIndex = (): number => {
    if (!right) return -1;
    return blockAt(stored, "modified", rightCaretLine());
  };

  /**
   * 两侧同时落位到各自那段的起始行（设计稿 ⑥·面板）。
   *
   * 索引越界夹到首/末块（不环绕 —— 走到头再按一次就是停在那一块，与「跳过头」比环绕好懂）。
   * 落位走既有**显式落位**那一类：selection + `scrollIntoView` 一发带过去，不靠 scroll 猜，
   * 也不许把这一发广播给同文档的其它视口（B290 起的纪律：滚动是**结果**信号）。
   */
  const jumpTo = (index: number): void => {
    if (stored.length === 0) return;
    const b = stored[Math.min(Math.max(index, 0), stored.length - 1)];
    // Task 7 的「折叠未改动区」在这里补 `unfoldAround`（目标行被折进收起区时先展开那段再落）；
    // 本轮还没有折叠，那一发天然是 no-op ⇒ 位置留在这句话上，不预先建空抽象。
    const at = lineStartOf(left, landingLine(b, "original"));
    left.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: "start" }),
    });
    if (!right) return;
    const to = lineStartOf(right, landingLine(b, "modified"));
    right.dispatch({
      selection: { anchor: to },
      effects: EditorView.scrollIntoView(to, { y: "start" }),
    });
    writeBackRight();
    // 认领这下发起的滚动（照 `src/io/files.ts:136` 的先例）：落位改的是视口位置，
    // 不认领就会被协调器当作用户滚动，把同一份文档的别的面板一起拽走。
    claimVisibleHere(panel);
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

  if (right) {
    // 一发事务里两件一起办：关掉这一栏的折行（R19）+ 装上右侧那一臂。
    right.dispatch({
      effects: [
        ...wrapOff,
        StateEffect.appendConfig.of(
          rightFace.of([
            diffFace("modified", () => stored),
            // 键入落点：`updateListener` 是 state facet，只能这样并进来（仓库同形先例
            // `tests/preview-face-helpers.ts:71-76`：塞进 `state.update({extensions})` 会被静默丢掉）。
            EditorView.updateListener.of((update) => {
              if (update.docChanged) scheduleSync();
            }),
          ]),
        ),
      ],
    });
  }

  const surface: DiffSurface = {
    left,
    spec: () => current,
    retarget: (next) => {
      current = next;
      // 换输入 = 换**文档**，不是往当前文档里改：整态换一颗干净的只读 state，
      // 既不给对照缓冲留撤销历史，也不走 `dispatch({changes})` 那条「写文档」的路。
      // ⚠️ 必须用 `setState`：`dispatch({changes})` 如今会被 leftState 那道硬闸整发丢掉
      // （「换输入」看着像没反应）。`setState` 是换 state 不是发事务，天然不受那道闸牵连。
      // 那一臂靠 `leftFace.of(...)` 随 state 一起进去（换 state 会把旧 config 整个换掉）；
      // provider 交回的是 `stored`，所以新块表由紧随其后的那一发 `syncBlocks()` 现算 ——
      // 这里不再自己 `diffBlocks`，也不另发 refreshDiff（重算只有一条路：R24）。
      // 主题同样重新读一遍现值（右栏那颗 state 才是权威：换输入时它可能已经换过档）。
      left.setState(leftState(current, leftFace.of(diffFace("original", () => stored)), themeOf()));
      syncBlocks();
    },
    syncBlocks,
    blocks: () => stored,
    jumpTo,
    step,
    activeIndex,
    ignoreTrimWhitespace: () => ignoreWs,
    setIgnoreTrimWhitespace: (on) => {
      if (ignoreWs === on) return;
      ignoreWs = on;
      // 立刻重算（不等防抖）：这是用户点下来的一发动作，不是键入。
      syncBlocks();
    },
    dispose: () => {
      cancelSync();
      // 右栏那颗 view **不随旁路销毁**（它是那份文档本身）⇒ 这一臂必须精准摘掉，
      // 否则底色与占位块会留在一张普通编辑器标签上。CompartmentInstance 已在 base 里，
      // `reconfigure([])` 就把它清空；那颗 view 已经 destroy 过的话这一发是空转（CM6 内部
      // 的 `destroyed` 分支），不抛错。折行跟着还回 attach 之前的那个值（R19）。
      right?.dispatch({ effects: [rightFace.reconfigure([]), ...wrapBack] });
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
