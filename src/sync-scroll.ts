// Auto-extracted synchronized-scroll module (B273+ refactor).
// All sync cursor / geometry / restore / measure logic lives here, decoupled from main.ts.

import { logger } from "./core/logger";
import { EditorView } from "@codemirror/view";
import { emitCrossWindow } from "./ipc/api";
import { isProgrammatic, markProgrammatic } from "./core/scroll-guard";
import {
  tabs,
  activePanelId,
  suppressSyncPush,
  unmeasuredPanels,
  docSyncModes,
} from "./core/app-state";
import { panelOfTab, instancesOfDoc, displayedPanelOfTab } from "./core/panels";
import { pinInFlight, recordScroll, pinScrollTop, logViewportGeom, fmtPx } from "./core/viewport";
import { EVT_SYNC_POS } from "./core/events";
import type { Tab, Panel } from "./core/app-state";

/**
 * 一轮「几何变化后重落」共用的取消标记（`landOnFrameGeometry` 用它）。
 *
 * 同一次同步执行块里注册的重落算**同一轮**（copy 分支一次会注册两条：原标签 + 新副本；
 * `disposePanel` / `openPreviewToSide` 也各是一整轮）—— 这一格里**任何一个**容器在那一
 * 拍里被用户接管，整轮就都得作废：这一轮的任务是「把几块面板一起还原回几何变化之前」，
 * 用户既已接管其中一块，剩下的跟着旧游标还原就是再造一次「切标签不同步」。
 *
 * 微任务回合即「一轮结束」：重落注册全在同一块同步代码里，微任务一定排在它们之后、
 * 也排在 rAF 之前 ⇒ 下一条同步块自然换新一轮。
 */
let landRound: { userTookOver: boolean } | null = null;

/**
 * 同源**光标**同步回环抑制（B176）。
 *
 * `pushSyncToSiblings` 把源位置推给兄弟时，会顺手把光标也 dispatch 到兄弟那一侧。
 * 那发 dispatch **同步**触发兄弟的 `handleUpdate`；若兄弟恰好是「激活面板的激活标签」
 * （`isSyncSource` 为真），它又会 `pushSyncToSiblings` 把位置**反推回源** —— 而源此刻
 * 的位置还是上一帧的旧值（用户还在连续滚），于是源被拽回旧位置、下一帧又被用户推新、
 * 再被拽回…… 非激活文件滚动就是这种 A↔B 拉锯（用户反复报的「非激活文档滚动抖」）。
 *
 * ⚠️ 这个回环是 B154「谁滚谁当源」引入的：此前 `pushSyncToSiblings` 只从 `isSyncSource`
 * （激活源）调用，兄弟永不是激活标签、`isSyncSource` 必假，不会反推；B154 起滚动监听
 * 直接调它，源可以是非激活面板，兄弟就可能正好是激活那份 ⇒ 旧假设被打破（B167 那条
 * 注释仍写着「兄弟恰好是激活标签的情况不存在（源才是）」，已不成立）。
 *
 * 修法：dispatch 光标期间给 `syncingCursorDocId` 打标，`handleUpdate` 的 `isSyncSource`
 * 分支见标即跳过这一轮 `pushSyncToSiblings`（光标仍照常落到兄弟，只是不再反推回源）。
 * 仅覆盖「活视图」那一路 —— 离线快照走 `other.state.update`、不触发 updateListener。
 */
export let syncingCursorDocId: number | null = null;

/**
 * 编辑器可视区顶行 —— **带行内比例的小数**（B174），落点是**同一个**实数行号。
 *
 * ⚠️ 取整版 `topVisibleLineOf` 已于 B257 删掉：它那句「用于切视图模式交接这类一次性定位
 *    正好」在 `applyPanelMode` 里留了半个行高的残差 —— 切模式一来一回源码 287 ⇒ 280
 *    （自测台实测）。取整的动机是「源在一行内滚动时行号不变 ⇒ 目标一动不动、跨行瞬间跳
 *    一格，连起来就是‘卡一下、跳一下’的阶梯」，而**小数版正好把这条阶梯抹平**（用户报：
 *    预览跟随同步时跳动）；所以同步滚动与切模式交接现在**同一条**小数口径，没有特产的
 *    整数档。一行内滚动 ⇒ 比例连续、跨行 ⇒ 行号 +1，两边都是同一个 `v`。
 */
/**
 * 找「视口顶边那一行」时的**内缩量**（像素，＜1）。
 *
 * ⚠️ B251 定案 **ANCHOR = 0**：视口坐标与内容坐标之间**不许**再有任何常数平移（读 `+8`/
 * 写 `−8` 那套是 B23 留下的魔法数，`.md-preview` 的 `padding` 里找不到 8px 的几何依据）。
 * 这个常量不是偏移 —— 它只用来在**块/行边界上**问「顶边压在谁身上」：踏在整行/整块顶上
 * 时 CM6 的 `lineBlockAtHeight` / 预览的二分都按「含这个 height」取值，正好压界会退到上一
 * 行。内缩半像素问一次，比例仍按真·scrollTop 算 ⇒ 读与写严格互逆、往返不攒误差。
 */
const TOP_PROBE = 0.5;

/**
 * B251：**同步坐标的唯一取值口** —— 跟随 / 切标签收口 / 切模式交接三路都从这里取
 * 「源」的规范游标 `v`。
 *
 * 以前这里是三处各取各的：跟随走 `px`（源是源码时的编辑器像素）+ `line`（源是预览时的
 * 整数块首）两套，收口 `syncSourceSnapshot` 又是另一套 `{px, line}`，切模式 handoff 又是
 * `topBlockStartLine + editorLineTopPx` 手工拼 —— 同一个「源显示在哪一侧」被抄成三种口径，
 * 每换一次手就吃一次差（B247 守卫 / B249 改整数 / B240 二轮读实时值，全是在这三层不一致上
 * 打的补丁）。现在只有 `v` 一种东西：源码侧就是 `topVisibleLineFrac` 那个小数，
 * 预览侧就是 `topVisibleLine()` 那个小数 —— **两边本来就是同一个公式**，只是此前没人认。
 *
 * ⚠️⚠️⚠️ B257（本轮**翻案**，别把 B251/B242 那几句结论再抄回去）：
 *
 *    B251 认为「两个小数归一在不同的东西上（行高 / 块高）⇒ 跨侧必须丢小数（只交整数块首、
 *    源码侧 `Math.floor`）」，本轮把它**推翻**了 —— 丢小数正是「切换标签 / 切模式那一点
 *    偏移」的全部来源（自测台 `tests/sync-stability.test.ts` 抓到：源码 287 ⇒ 切模式一轮
 *    变 280、预览 847 ⇒ 切标签一轮变 840，每跨一次侧吃掉半个行高 / 1/6 块高）。
 *
 *    真病根是 B251 自己**没看出来的那一步**：`topVisibleLine()` 读出来的小数**根本不是**
 *    「块高比例」—— 它算的是 `start + ratio × range`（`range` = 这一块占**几行源码**），
 *    已经把块高折回**行**；而 `applySyncToLine` 写的时候又按 `into / range` 除回去
 *    （`top += (块顶间距) × into / range`）。**乘 `range` 与除 `range` 正好抵消**，
 *    于是预览读/写互逆，交出来的 `v` 与源码侧 `topVisibleLineFrac` 的「行号 + 行内比例」
 *    是**同一个量**：行号定「哪一行（块）」，小数定「这一行（这块）走了多少」。
 *    两边的高度只影响「一格有多高」，**不影响这个数**。
 *
 *    ⇒ 跨侧**照交完整 `v`**，谁也不许再 floor / 只取块首。验证（同几何，块高 42 = 3×行高、
 *    一行一块）：源码停 287 ⇒ v=21.5 ⇒ 预览按 21 + 0.5×1 落到 903 = 21×42+21（块内 1/2），
 *    预览再读出来还是 21.5 ⇒ 源码落点仍是 287，**闭合一分不差**；换成三行一块的段落
 *    （块高 3×行高、range=3）源码 v=23 落在块中段 ⇒ 预览落 块顶 + 1×块高（第 2 行行顶）
 *    ⇒ 读回仍 23，同样闭合。
 *
 *    ⚠️ 留一句给后来人：B247 那条「源是预览、显示的是源码 ⇒ 收口早退」的守卫**仍然有效**
 *      且必须留（它管的是「不许拿块首把 `restoreViewScroll` 刚还原的精确位置盖回段首」），
 *      但它管的是**覆盖**，与「跨侧重不影响小数」是两件事 —— 别再拿它当「跨侧要丢小数」的
 *      旁证。
 */

/**
 * ⚠️ B256：「DOM 里的位置 ≠ 这份标签记的位置」到多少 px 才算「DOM 还没接过我们写的值」。
 *
 * 与 `pinScrollTop` 那条「同一处就算立住」的容差同值（那边的 `PIN_EPSILON_PX`）——
 * 两边判的都是同一个问题：**这两个数是不是同一处**。
 */
const LAND_STALE_PX = 1;

/**
 * 这个实例此刻是不是它那个文档在同步模式下的**源**。
 *
 * 只有**激活面板里激活的那一份**算 —— 这正是「切换激活文档时按新的激活文档同步」
 * 的实现方式：源换人，兄弟跟着新源走，而开关状态不动。
 *
 * ⚠️ 它同时是**回环闸门**：把值推给兄弟时，兄弟自己也会派发 update（光标）与 scroll，
 *    若那时又推一次就成了 A→B→A 来回拉。兄弟恰好是激活标签的情况不存在（源才是），
 *    所以这一句就掐断了回环 —— 别再叠一层多余的守卫去挡（B146 删过 `swappingView`，
 *    挡掉的并不只是程序滚动）。
 *
 * ⚠️ B154 起它**只守光标那一半**：两条滚动监听已经改成「谁滚谁当源」（用户要求窗口
 *    没激活、面板没点过时也能同步），位置同步的回环由 `scroll-guard` 的来源标记自限
 *    （程序钉位的回执被监听见 `markProgrammatic` 即吞，不赌时序、不靠窗口）。选区不同 ——
 *    移动鼠标不改变激活面板，非激活那份的光标本来就是被同步推过去的结果，让它也能当源
 *    就会跟「谁在编辑」打起来。
 */
export function isSyncSource(tab: Tab, panel: Panel): boolean {
  return (
    docSyncModes.get(tab.docId) === true &&
    panel.panelId === activePanelId &&
    panel.activeTabId === tab.tabId
  );
}

/**
 * ⚠️⚠️ B263（用户报：同文档三标签、分屏 A 挂源码 a + 预览 b、分屏 B 挂纯预览 c，
 *    滚任意一个再切激活标签 a / b，位置偏移）：**离屏的源码兄弟常常换不出一把能用的尺子。**
 *
 * 一个 panel 只挂一个 `EditorView`：「面板正显示预览标签」⇒ 源码那一格连人带容器一起
 * `display:none`（`.panel-host.mode-preview .panel-editor`），`view` 还活着、state 也在，
 * 但 CM6 量不出行顶（`lineBlockAt` 报 0 或上一次的陈旧值）。拿它去 `sourceTopOfV` ⇒ `top`
 * 恒 0 ⇒ 下面那句 `recordScroll` 就把那份离屏兄弟的槽写成「第 1 行」⇒ 切过去
 * `restoreViewScroll` 读出来 ⇒ **回顶**（自测台实测：滚 c 到 v=33.31，切回 a 落到 v=1.00）。
 *
 * ⚠️⚠️ 修法（B288⑤-4 后收敛为一条 + 一道闸）：
 *    ① **闸门**：借来的尺子正躺在纯预览那一格里（面板带 `mode-preview` 类）⇒ 这一手
 *       量不成，**连换算带写槽一起跳过** —— 写下去的 0 会当成「用户停在第 1 行」，
 *       那是「重启回顶」，与本条症状同型；
 *    ② **离屏兄弟靠 `other.syncV` 跟上**（B273）：v 与模式/测量无关、无条件写；
 *       它现形时 `restoreViewScroll` 的 v 分支按同一游标现算像素落位。
 *       （B288⑤-4 前②是「挂起 pending + 现形补写槽」—— 单轨下落盘只存 v，
 *       挂起补写是重复劳动，已删。）
 *    ⚠️ 闸门仍不可省：不设闸门那个 0 就进了 DOM 和槽，中间那一次落盘就会把「重启回顶」留下。
 *
 * ⚠️ 为什么不拿「`getClientRects().length > 0`」当闸门（真机的准话：元素 `display:none`
 *    ⇒ 空 rect）：**jsdom 不做布局**，没覆写 `getClientRects` 的桩恒返回空列表 ⇒ 那一判据
 *    在桩上恒假 ⇒ 既有的 `sync-*` 用例（它们的桩把 `lineBlockAt` 覆成实时几何、本来就
 *    「离屏也能量」）会**集体翻红**。判据得落在真机与桩**同价**的量上 —— 面板模式类是
 *    产品自己的口径（`applyPanelMode` 写它、`rememberViewScroll` 读它），两边都对。
 */

/**
 * B251：把**规范游标 `v`** 落到一份兄弟上 —— 「谁被推、推到哪儿」的**唯一落点函数**。
 *
 * 签名从 `(px, line)` 双参改成单一 `v`：源码态与预览态两条分支各自只差「`v` 怎么变成
 * 自己那侧的像素」，而「先记槽、再钉 DOM」那个顺序纪律不再有两份。
 */
/**
 * B284「到底」锚点：把**在屏**的兄弟摆到**它自己那一侧的底**。
 *
 * 与按游标换算那一支互斥：到底了就不换算（`v` 在两侧本就不相等 —— 内容高天生不同），
 * 直接各回各的底 ⇒ 底↔底互推是**不动点**，来回滚不会跳。
 *
 * ⚠️ 抽成独立函数、且排在落点函数**之前**，不只是为了短：`sync-scroll-mode` 那几条契约是
 *   按「落点函数 → 取收口游标那函数」这段**源码切片**来扫的，锚点里就有
 *   「预览态兄弟那一支」这种形态串 —— 这段若内联进落点函数体，切片会先撞上本函数这份，
 *   把判据全锚错地方（实测三条契约集体误伤）。
 *   ⚠️ 同理，**注释里不许原样复述那些切片起止串**：契约扫的是整段源码，注释里写一遍
 *   一样会被 `indexOf` 先命中（本轮就是这么踩的）。这里一律用「落点函数」这类说法指代。
 *
 * @returns 是否真的落了位。离屏 / 没有容器 ⇒ `false` ⇒ 调用方落回按游标换算那一支。
 *   当初写成「到底就直接 return」把这条整跳过了 ⇒ 离屏源码兄弟切回来位置不对
 *   （sync-three-tabs 实测：v 从 33.31 掉到 32.8）。
 */
function landAtOwnFloor(other: Tab, shown: Panel | undefined): boolean {
  if (other.viewMode === "preview") {
    const preview = shown?.preview;
    if (!preview) return false;
    const floorPx = ownFloorPx(preview.root);
    preview.setScrollTop(floorPx);
    // ⚠️ 补记**实际落点**（不是算出来的那个数）：容器还没撑开时摆位落不下去，
    //    把算出来的值记进槽等于把「没落地」写成「停在那儿」（B134 同型）。
    const landed = preview.root.scrollTop;
    recordScroll(other.tabId, landed);
    // ⚠️⚠️ **B285**：落点是「**自己这一侧**的底」，与源那一侧的 `v` **不是同一个数**
    //   （到底时源码顶行 ≈20.71、预览顶行 ≈21.57，内容高天生不同）⇒ 规范游标必须
    //   改写成**实际落点反算的 v**，不能留着源那一侧的值。
    //   留着会怎样：`restorePreviewScroll` 优先按 `syncV` 派生（B273），而 `syncV`
    //   此刻是源的 v ⇒ 落 828，把刚摆好的 864 覆盖掉。离屏预览现形时同病
    //   （`switchTab` 的收口先把 `syncV` 写成源的 v，紧接着的还原就按它派生）。
    //   用户报的就是这个：**没显示的预览标签滚动位置和显示的预览标签滚动位置不一致**。
    //   ⚠️ 往返严格互逆：`topVisibleLine` 与 `applySyncToLine` 同一套块几何、ANCHOR=0，
    //      按反算值再派生落回同一个像素（B245 立的互逆，这里不另起一套）。
    //   ⚠️ 反算失败（host 没挂 / 块没渲染）就留着 `v` —— 那一支至少指向源的真实位置，
    //      比抹成 null 强（null 会让还原整段跳过同步那一支）。
    const backAtFloor = preview.topVisibleLine();
    if (backAtFloor !== null) other.syncV = backAtFloor;
    return true;
  }
  const sv = shown?.view?.view;
  if (!sv) return false;
  const floorPx = ownFloorPx(sv.scrollDOM);
  // 顺序同下面那一支：先记槽、再钉 DOM（离屏兄弟只有槽能带走位置）。
  // ⚠️ 变量名取 `floorPx` 而不是 `px`：后者在历史上专指「源那一侧的像素」，B154 那条
  //    契约（不许拿源像素当落点）正是按那个调用形态抓的；而这里是**兄弟自己那一侧**的底。
  recordScroll(other.tabId, floorPx);
  pinScrollTop(sv.scrollDOM, floorPx);
  // ⚠️ 源码支**不**跟着预览支改写 `syncV`（B285 只修预览那一支）：
  //   `restoreViewScroll` 按源的 v 换算出像素后，会被**自然上限裁回底**自愈 —— 源码
  //   到底 ⇔ scrollTop = 自然上限，任何超出的值都裁到上限。而预览侧按源的 v 换算出
  //   828 < 864 是**合法** scrollTop，裁剪救不回来（B285 实测 36px 裂口）。
  //   ⚠️ 真要源码侧也坏，得构造「预览比源码矮」（块高 < 行高）的非自然几何 —— 真实 md
  //      里段落至少占一行 ⇒ 块高 >= 行高 ⇒ 证不出危害，按纪律不预先收窄。
  return true;
}

export function applySyncToSibling(other: Tab, v: number | null, atFloor = false): void {
  const shown = displayedPanelOfTab(other.tabId);
  // B167：落点也留一条 —— 「谁被推、推到哪儿」与上面那条「谁在推」配对看，
  //   拉锯的表现就是同一个 docId 上 A→B、B→A 交替出现，且 px 在几个值之间来回跳。
  logger.debug(
    "sync",
    `落 other=${other.tabId} doc=${other.docId} mode=${other.viewMode} v=${v} shown=${!!shown}`,
  );
  // ⚠️ **B273**：规范游标 `syncV` 无条件写——不论在屏/离屏、源码/预览，所有兄弟都先
  //   记下同一个规范性位置。这正是修「离屏实例跟随不更新 / 切回跳变」的关键：离屏的
  //   源码兄弟（下面 `rulerHidden` 早退那一支）和离屏的预览兄弟（上面 `viewMode==="preview"`
  //   且 `!shown?.preview` 早退那一支）此前都拿不到任何位置，切回来只能读陈旧的 `scrollTop`
  //   （甚至 null ⇒ 退化光标可见），于是看着像「位置变了」。`syncV` 与模式无关、不依赖 DOM
  //   测量，离屏也能准确持有；`restoreViewScroll` / `restorePreviewScroll` 切回时按各自
  //   模式从 `syncV` 派生像素，已同步好的实例不跳。
  other.syncV = v;
  // ⚠️⚠️ **B284「到底」共享锚点**：源顶到它自己那一侧的底 ⇒ 兄弟落到**它自己那一侧的底**，
  //    不再按顶行游标 `v` 换算（两侧内容高天生不同 ⇒ 到底时顶行本来就不相等，照 v 换算
  //    必然把对方拽离它自己的底，来回滚就是用户报的「到底后跳变」）。底↔底互推是**不动点**。
  if (atFloor && landAtOwnFloor(other, shown)) return;
  // 兄弟是预览态 ⇒ 它只认行：编辑器像素塞不进它的槽（纪律 2）。换算只能从源那侧
  // 的**顶行**来，所以跨视图模式这一路必须走 `line`；离屏的预览兄弟没有容器可算，
  // 只能靠它的槽自己那份记录，这里不写任何东西（写了就是污染）。
  if (other.viewMode === "preview") {
    if (v === null || !shown?.preview) return;
    const preview = shown.preview;
    // B170：跨面板同步把预览按行定位 —— 程序摆位，回执由预览的 scroll 监听经 scroll-guard
    // 标记吞掉（不比位置、不赌时序、不靠还原窗口，渲染扰动也免疫）。
    // B240 三轮：`syncToLineProgrammatic` 返回**实际落点**（`null` = 没落地，
    //   预览还没渲染 / 行号找不到 block ⇒ 容器一动没动）。
    //   ⚠️ 没落地就**不许**把容器里的值（多半是 0）补记进这份的槽 —— 那是把
    //   「定位没做」写成「它停在顶部」，下一次切过去天然回顶（B134 同型）。
    // ⚠️ `v` 一律带小数（含跨侧）：小数 = 「这一块（这一行）走了多少」，与预览侧
    //    `topVisibleLine` 互逆（它是 `start + ratio × range`、这里 `applySyncToLine` 是
    //    `into / range`，乘除抵消），也与 `applyPanelMode` 那次 `syncToLine(anchorLine)`
    //    同口径 —— 跨侧同步与切模式于是落在预览的同一个位置。
    //    B251 那会儿这里写「只给整数行号（块首对齐）」并给跨侧配了只交整数块首的一档，
    //    本轮 B257 撤掉那一档 —— 那正是「切换标签 / 切模式那一点偏移」的全部来源
    //    （自测台：预览 847 ⇒ 切标签一轮变 840）。
    const landed = preview.syncToLineProgrammatic(v);
    // `syncToLine` 同步落地，容器里的值可直接读；落点显式补记（程序定位不写快照）。
    if (landed !== null) recordScroll(other.tabId, landed);
    return;
  }
  const shownView = shown?.view?.view;
  // ⚠️ B251：原先这里先判 `px !== null`（源码态 ⇒ 编辑器像素直通过来一次写完），否则才
  //    退到下面「源是预览 ⇒ 从行号换算」那一大段 —— 两路各写一遍「先记槽、再钉 DOM」。
  //    现在统一交 `v`，两路合并成一条：在屏用 `shownView` 自己、离屏借一个同文档的视图，
  //    落点一律 `sourceTopOfV` ⇒ 源码态与预览态只在**换算方式**上不同，顺序纪律只剩一份。
  if (v === null) return;
  // B240：落点**先记**，且**离屏的兄弟也要记**。
  //   一个 panel 只挂一个 `EditorView`（`viewTabId` 决定它此刻显示谁），所以「非激活
  //   标签」没有自己的容器可钉 —— 但它的快照槽 `t.scrollTop` 是能写的，而
  //   `restoreViewScroll` 切过去时正是拿这个槽钉位置 ⇒ 离屏标签也得先把落点落进槽。
  //   ⚠️ 这里记的是**由 `v` 换算出**的像素（源码态那一路），不再是「源那侧的 px 直通」；
  //      两边同为源码态、同一份文档同一套排版，换算回来同一个位置。
  // 走到这里 = 源是**预览**那一侧（`px` 恒为 null，B160），手上只有行号。
  // B240：离屏的源码兄弟换不出编辑器像素 —— 行号→像素要按它**自己那份文档**的
  //   `lineBlockAt` 算，而它此刻没有视图（`view` 归面板所有，正在显示别的标签）。
  //   硬写就是污染（B154 踩过：把预览像素当编辑器像素塞进去，切回源码时位置全错）。
  // ⚠️ B248：但**「没有视图」不等于「换不出」** —— 同文档的**源码态**实例（分屏另一半 /
  //   另一个面板正显示着的那一格）排版与这份文档完全一致，拿它的 view 量 `lineBlockAt`
  //   就等于量离屏兄弟自己的几何 ⇒ 换算出来的编辑器像素写进它自己的槽，
  //   `restoreViewScroll` 切过去直接读到新值（用户报：滚激活的预览时，未显示的那份
  //   代码标签位置纹丝不动 ⇒ 切过去/显示出来还是老位置）。
  //   ⚠️ 写进去的**必须是换算后的 `top`**，不是 `px`（那一路是「硬塞预览像素」的死，
  //      见上面 `sync-scroll-mode` 的反向闸：预览源那一路不许出现 `recordScroll(…, px)`）。
  //   ⚠️ 真·换不出（同文档一个源码视图都没有）才继续留死格 —— 那是物理限制。
  // ⚠️ B248 补第二层兜底：离屏兄弟**自己**没有视图 ⇒ `displayedPanelOfTab` 是 undefined。
  //    但**面板那个 `EditorView` 一直在**（一个 panel 只挂一个 EditorView，`viewTabId`
  //    只决定它显示谁、不决定它的存亡）。用户最常见的场景就是「代码 tab 与预览 tab
  //    同处一个面板」：此刻面板正显示预览 tab、源码 tab 离屏 —— 这里既没有第二个源码
  //    实例，又非真的换不出。这块 view 里的 `state` 就是这份文档（同 docId、同正文），
  //    量它的 `lineBlockAt` 得到的就是离屏源码兄弟自己的几何。
  //    再兜不住（面板压根没视图，例如纯预览面板还没建过编辑器）才去找同文档其它源码
  //    实例，最后才是真的「换不出 ⇒ 留死格」。
  // ⚠️⚠️ **B280**：借尺子之前先认「这把尺子此刻量的是不是同一份文档」。
  //    `panelOfTab(other.tabId).view` 是**面板**那块唯一的 EditorView，它显示的是面板的
  //    活动标签 —— 那份**可能是别的文档**。拿它去 `sourceTopOfV` ⇒ `v` 被按别人的行数夹
  //    一遍、换出一个属于别人几何的 px（短文档甚至恒 0），下一行 `recordScroll` 把它写进
  //    这份兄弟的槽 ⇒ 落盘固化 ⇒ 切过去 / 重启读到错值就**跳回开头**（用户报的症状①）。
  //    ⇒ 文档对不上就**不借**：交给下面那个循环去找同文档真正显示着的源码实例；找不到
  //    就 `if (!view) return` 留死格（B162 那条老纪律 —— 宁可不动，也不许拿错值抹真位置）。
  let view = shownView;
  if (!view) {
    const p = panelOfTab(other.tabId);
    const shownTabId = p?.viewTabId ?? null;
    const shownTab = shownTabId !== null ? tabs.get(shownTabId) : undefined;
    view = shownTab && shownTab.docId === other.docId ? p?.view?.view : undefined;
  }
  // ⚠️⚠️ **B263**：借来的这块尺子正躺在**纯预览那一格**里 —— 面板带 `mode-preview` 类
  //    ⇒ `.panel-editor { display: none }` ⇒ CM6 量不出行顶 ⇒ 这一手**量不成**。
  //    量不成就**两步都不做**：既不换算、也不写槽（写下去的 `top` 恒 0，会当成「用户停在
  //    第 1 行」进会话记录 ⇒ 重启回顶，B162 那条老纪律：宁可留死格，不许拿 0 抹真位置）。
  //    ⚠️ **B288⑤-4：挂起补写已删** —— 单轨下兄弟现形时 `restoreViewScroll` 的 v 分支
  //       直接按 `other.syncV` 落位（同一个 v，1b 起不再要求同步开着），挂起补写是重复
  //       劳动，且它写的「估算空间 px 槽」正是要消灭的东西。
  //    ⚠️ 闸门判据取**面板模式类**（`applyPanelMode` 写它、`rememberViewScroll` 读它，是
  //       产品自己的口径）—— 不取「量得到量不到」：那在桩上恒真（既有桩把 `lineBlockAt`
  //       覆成实时几何、离屏也能量）⇒ 闸门在桩上恒假 ⇒ 怎么退化都绿。
  const rulerHidden =
    !shownView && !!panelOfTab(other.tabId)?.bodyEl?.classList.contains("mode-preview");
  if (rulerHidden) return;
  // ⚠️⚠️ **B271**：尺子未测（`setState`/新建视图之后、measure 帧之前，见 `unmeasuredPanels`）
  //    ⇒ 换算必落「估算空间」—— 一个字节的估算 px 都不许写。**在屏目标同样有毒**
  //    （毒的是它自己的 DOM+槽）⇒ 同样直接跳过。
  //    ⚠️ **B288⑤-4**：不再挂起 —— `measureAndKeepScroll` 的 rAF（measure 完成、
  //       heightMap 已实测）会调 `restoreViewScroll` 按 v 重落，一步到位。
  const rulerPanel = shownView ? shown : panelOfTab(other.tabId);
  if (view && rulerPanel && unmeasuredPanels.has(rulerPanel)) {
    return;
  }
  if (!view) {
    for (const t of instancesOfDoc(other.docId)) {
      if (t.tabId === other.tabId || t.viewMode === "preview") continue;
      // ⚠️ B251：改名 —— `v` 现在已经是**规范游标**，不能拿它当「借来的 EditorView」用
      //    （同名会让下面 `sourceTopOfV(view, v)` 读成借来的那个 view，静默换算错目标）。
      const instPanel = displayedPanelOfTab(t.tabId);
      const instView = instPanel?.view?.view;
      // B271：借尺子也要借**测过的** —— 未测面板的尺子同样是估算空间
      if (instView && instPanel && !unmeasuredPanels.has(instPanel)) {
        view = instView;
        break;
      }
    }
  }
  if (!view) return;
  // ⚠️ B251：落点走 `sourceTopOfV` —— 与切源码/预览那一路（toggleViewMode 的 handoff）
  //   **同一个函数**，且**允许带行内比例**（内部显式插值，不再被 CM6 的上取整吞掉）。
  //   ⚠️ 跨侧**照收带小数的 `v`**（B257 翻案）：小数 = 「这一行走了多少」，与
  //     `applySyncToSibling` 预览那一支、以及 `topVisibleLineFrac` / `topVisibleLine`
  //     是同一个量，各自在自己那侧按同一份几何插 ⇒ 往返恒等、不会每轮吃掉一点。
  //    B251 那会儿这里写的是「旧写法只给行首是有意的（B242：比例跨侧量纲不对）」——
  //    那句结论已被本轮推翻（量纲没错，`applySyncToLine` 的 `/ range` 与
  //    `topVisibleLine` 的 `× range` 本来就抵消；真病根是跨侧**丢**小数），别再抄回去。
  const top = sourceTopOfV(view, v);
  if (top === null) return;
  // ⚠️ 顺序：**先记槽、再钉 DOM**（与源码在屏那一支同源 —— 槽里得先有值，离屏那份
  //   根本没容器可钉，只有槽能把它带走）。
  recordScroll(other.tabId, top);
  // ⚠️ 只有兄弟**自己**在屏时才钉它自己的 DOM —— `view` 有可能是借来的（同文档另一个
  //    源码视图），离屏兄弟压根没容器可钉，拿它去 pin 等于把正显示着的那个实例推走。
  //    槽上面那行已经记好，切过去 `restoreViewScroll` 会自己读出来。
  if (shownView) pinScrollTop(shownView.scrollDOM, top);
}

/**
 * B259：**一次性落位** —— 把**源**的游标 `v` 落到某一（刚建的）预览实例上。
 *
 * 落点走的是 `applySyncToSibling` 的**同一个出口**（同一个 `v`、同一套 `recordScroll`
 * 与程序标记），差别只有一个：**不看 `docSyncModes` 闸口**。
 *
 * ⚠️ 为什么必须不看同步开关（用户拍定：「不管是否开启同步滚动都应该生效」）：下面两条
 *    路径都会**新建一份实例**（无右邻居 ⇒ `splitPanelWithTab` 的 copy 分支；右邻居存在
 *    但它挂着别份文档 ⇒ 现场 `makeInstance`），而新实例那一份编辑器视口是**空档**
 *    （scrollTop 恒 0），`applyPanelMode` 里那句 `if (anchorLine > 1) syncToLine(...)`
 *    读到的就永远是 0 ⇒ 新预览从**文档开头**起。同步关掉时这条推播本来就不存在，
 *    于是「关了同步之后再开侧边预览」反而更容易看出病（自测台两条用例都是 0 而不是 861）。
 *
 * ⚠️ 与「跟随」的区别：跟随是**每帧**都按当前源更正一次，漏一帧下一帧就补上；这里是
 *    一次性动作，得当场落下去 —— 所以走 `landPreviewAtSource` 而不指望后续跟随。
 */
export function landPreviewAtSource(other: Tab, v: number | null): void {
  if (v === null) return;
  applySyncToSibling(other, v);
}

/**
 * B262：几何变化（开/关侧边预览、加/删分屏）之后，把一份兄弟按**这一帧的几何**重落回
 * 它原来的游标上 —— 「先采后落」这条纪律里，「落」这一半的**落点换算**必须等几何到位。
 *
 * ⚠️⚠️ 为什么不能像 `landPreviewAtSource` 那样**当场**落下去（用户报：打开侧边预览 /
 *     加删分屏之后，原先那个标签的滚动位置**跳到别的行**了）：
 *
 *    几何（面板数）一变 ⇒ 面板宽窄变 ⇒ 折行数变 ⇒ 一条逻辑行的**视觉行高**变。但
 *    `rebuildLayout()` 换上去的那批 `EditorView` 的 heightMap 还是**旧宽度的** ——
 *    CM6 的 `requestMeasure()` 排的是**下一帧**的 rAF，在那之前 `lineBlockAt` 报的是
 *    旧宽度下的行顶。于是「拿旧尺子量新位置」：`sourceTopOfV` 把旧几何算出来的行顶
 *    钉进已经变窄/变宽的编辑器 ⇒ **落到另一行**（自测台滞后几何桩实测：整宽 287 ⇒
 *    窄栏该落 95.67，当场落算出 287 = 旧几何下的 v=20.5，真机几何下一看已是第 61 行，
 *    差 40 行）。
 *
 *    ⚠️ 这一层**现有桩全盖住了**：`tests/sync-*` 那批把 `lineBlockAt` 覆写成**实时**几何
 *      （`rowH()` 按面板数立刻变）⇒ 桩上「游标全程闭合」是**桩的特权**，不是产品行为。
 *      真要用例得咬住它，见 `tests/sync-geometry-lag.test.ts`（几何一变，CM 那把尺子
 *      留到帧头才换，与 CM6 的时序一致）。
 *
 * ⚠️ 为什么这里能够/必须「排到下一帧再落」—— 第四轮那个跨帧 `landAfterMeasure`
 *     当初是**没加闸门**才被撤的（commit `6db1663`）：跨一帧 ⇒ 那一帧里切标签 / 切模式 /
 *     再 rebuild 都可能发生 ⇒ `displayedPanelOfTab` 已指向别处，而它还拿着分屏前采的
 *     `vCopy` 硬钉 ⇒ 把用户刚切好的位置按旧游标钉回去（「切标签不同步」）。所以这里把
 *     那一帧的**闸门**补上：下面回调里认死「我注册时看到的那一个 (view, viewTabId)」，
 *     两者任一变了 ⇒ 整条作废、**一个字节都不动**（既不是硬钉回去，也不是硬钉）。
 *     ⚠️ 先试过把换算排进 CM6 measure 的 `write` 阶段（`view.requestMeasure({ write })`，
 *        与几何变化同帧、跑在 `viewState.measure()` 之后）：**放弃**，理由是 CM6 的写阶段
 *        在 `Updating` 状态里重入 `LayerView.draw`，jsdom 桩上它自带的那些 write 回调
 *        直接抛 `Cannot read properties of undefined` ⇒ 连 ours 那一轮也被吞掉（同一份桩
 *        里换回「下一帧」就稳）。同帧的甜头（那一帧插不进用户输入）其实由上面那道闸门等价
 *        换来 —— 认死 view/viewTabId 就是「同一帧才成立」的判据。
 *
 * ⚠️ 游标 `v` 仍然**采在几何变化之前**：变化之后再采，读到的是「新面板按旧像素还原出来
 *    的歪位置」换算出的游标，量的是同一个错。
 *
 * ⚠️ 只换「落点换算」这一步，落位出口还是 `applySyncToSibling`（同一个 `v`、同一套
 *    `recordScroll` / 程序标记），所以同步关着这一路照样生效。
 */
export function landOnFrameGeometry(tab: Tab, v: number | null): void {
  if (v === null) return;
  const view = displayedPanelOfTab(tab.tabId)?.view?.view ?? panelOfTab(tab.tabId)?.view?.view;
  if (!view) return;
  // ⚠️ 注册这一刻这个容器是不是「我们程序摆的」（那几条几何变化路径都经 `pinScrollTop`
  //    打过标记）。它只有在**本来是自家、这一拍里又不是了**才算用户接管；本来就没标记是
  //    稳态，什么都说明不了。
  const markedAtReg = isProgrammatic(view.scrollDOM);
  if (landRound === null) {
    landRound = { userTookOver: false };
    queueMicrotask(() => {
      landRound = null;
    });
  }
  const round = landRound;
  // ⚠️ 落位排到**这一帧的末尾**（CM6 的 measure 就在这一帧里把 heightMap 刷成新的，而
  //    我们的 rAF 排在它之后 ⇒ 换算用的已经是这一帧的几何）。
  //    ⚠️ 不用 CM6 measure 的 **write 阶段**（试过，撤）：`applySyncToSibling` 尾巴上那句
  //       `pinScrollTop` 在 measure 周期里写 `scrollTop` ⇒ 重入 CM6 的 `LayerView.draw`
  //       ⇒ 位置被清零（真机未必炸，但这里炸了就得当它炸）。
  requestAnimationFrame(() => {
    // ⚠️⚠️ 跨帧闸门（第四轮 `landAfterMeasure` 缺的就是这一道，commit `6db1663`）：
    //    跨一帧 ⇒ 那一帧里切标签 / 切模式 / 用户滚一下都可能发生，而这个 `v` 是**几何
    //    变化之前**采的 ⇒ 一律不许拿它去盖那一拍里新发生的事。
    //    ⚠️ 判「谁在显示谁」用 `viewTabId` 而不是 `activeTabId`（见 `syncSourceV` 那条）。
    const now = displayedPanelOfTab(tab.tabId);
    if (now?.view?.view !== view || now?.viewTabId !== tab.tabId) return;
    // ⚠️⚠️ 「用户有没有在那一拍里接管这个容器」只能靠 `markProgrammatic` 那套来源标记
    //    （见 `scroll-guard.ts`）：用户一滚（wheel / 滚键 / 拖滚动条）`clearProgrammatic`
    //    就把标记摘掉 ⇒ 标记从有到无 = 位置在这一拍里归了用户 ⇒ 陈旧游标不许盖回去。
    //    ⚠️ 之前试过拿**像素**当基准（注册时记 `scrollTop`、回调时比较）：不成 ——
    //      rebuild 那条路会把容器归零**并记账**（`t.scrollTop` 也跟着从 287 变 0），与
    //      「用户滚到别处」在数值上完全一样，闸门要么挡掉合法落位、要么挡不住用户滚动。
    //      来源标记是唯一分得清「归零重排」与「用户接管」这两者的信号。
    if (markedAtReg && !isProgrammatic(view.scrollDOM)) round.userTookOver = true;
    if (round.userTookOver) return;
    applySyncToSibling(tab, v);
  });
}

/**
 * B240 三轮：切标签那一刻，把**源**（刚显示的那一份，下一刻就要离屏）的坐标就地采下来。
 *
 * ⚠️ 必须在它离屏**之前**采。离屏之后 `panelOfTab(src).view?.view` 取到的是面板的那一个
 * EditorView，而它此刻显示的是**接班的那一份** —— 拿它的 scrollTop 当源的位置，等于
 * 拿「被同步的那份」去同步「同步者自己」，收口就成了空转。
 *
 * 坐标口径与 `pushSyncToSiblings` 同一套（纪律 2 / 4）：源显示在哪一侧就取哪一侧，
 * 预览侧取预览的顶行（带行内比例的小数），源码侧取 `topVisibleLineFrac`。
 */
export function syncSourceSnapshot(src: Tab | undefined, nextTabId: number): number | null {
  if (!src || src.tabId === nextTabId) return null;
  // 同步没开 ⇒ 各认各的（B149 基线），谁也别替谁决定位置。
  if (docSyncModes.get(src.docId) !== true) return null;
  if (src.scrollTop === null) return null;
  // ⚠️⚠️ **B276：源那一格的尺子若还在估算窗口 ⇒ 这把游标不可信，宁可不收口**。
  //    `setState` / 建视图之后到 measure 帧之前，CM6 的 heightMap 是估算行高（B256/B271），
  //    此刻按源像素算出来的行号是错的 —— 真机 trace（04:34:39）：源码格在 1713.33px，
  //    被算成 **v=64.587**（1713.33/64.587 ≈ 26.5，那是**旧宽度**下的行高；实测 ≈22），
  //    收口照这个错 v 落位 ⇒ 预览落到 1887 而不是 2249，凭空偏 362px。
  //    ⇒ 与 B263「量不出就挂起」同一条纪律：不可信的坐标一个都别往外发。
  const srcPanel = panelOfTab(src.tabId);
  if (srcPanel && unmeasuredPanels.has(srcPanel)) return null;
  // ⚠️ B251/B257：交的是**规范游标 `v`**（实数行号，带行内/块内比例的小数），收口这一路
  //    **不区分跨侧 / 同侧**，一律交完整 `v`：B251 那版按两侧 viewMode 是否不同取 `cross`
  //    （跨侧丢小数），本轮 B257 撤掉 —— 收口交整数块首 = 每切一次把接班那份往回拽一整段
  //    （自测台：切模式一来一回，源码 287 ⇒ 280）。
  //    ⚠️ B284：B265 的留白已撤（用户拍板：不再把尾行滚到顶、底下不加空白）⇒ 两侧
  //    `maxScroll` 重新错配，收口这一路**重新需要**「顶没顶上限」的 `atFloor` 判据
  //    （B266 当初是因为留白才把它删掉的）。到底由调用方在**离屏前同帧**采下、经
  //    `alignShownToSyncSource` / `pushSyncToSiblings(opts.atFloor)` 传进来 ——
  //    离屏后 `clientHeight = 0`，`tabAtOwnFloor` 恒答「没到底」，问不出真话。
  const v = syncSourceV(src);
  return v;
}

/**
 * B240 三轮：同步滚动开着时，**切过来显示的这一份**按**源**的位置收口。
 *
 * 为什么不能只靠「新这份自己那份快照」（`restoreViewScroll` 现在做的事）：同文档的
 * 兄弟各有算不出自己位置的时刻 ——
 *   · 源是**预览**侧 ⇒ `px` 恒 `null`（纪律 2，预览只认行号），而离屏的源码兄弟换不出
 *     `lineBlockAt`（视图归面板所有、正显示着别人）⇒ 它的槽一个字节都写不进；
 *   · 兄弟是**预览**态且离屏 ⇒ 连容器都没有，同样写不进。
 * 于是「切过去位置不对」。而 B154 白纸黑字要求「一个预览一个源码也要同步」。
 *
 * ⚠️ 所以同步开着时，**切换后的位置由源给定**，不由新这份自己的槽给定：源此刻已经离屏，
 * 但它刚被推过、位置就停在 `src.scrollTop` 上，同文档同排版 ⇒ 同一个值落到源码侧就是
 * 同一个位置。这一下把上面两个死格一并兜住，比给每个格子都补换算便宜得多。
 *
 * ⚠️ B241 返回值不是摆设：**收口生效 ⇒ 调用方不许再 `pushSyncToSiblings`**。那一次推播
 *   会把「刚按源换算落位的接班值」回写给兄弟 —— 而兄弟正是源，等于**切换动作把源的位置
 *    也改了** ⇒ 跨侧（行号⇄像素）每切一轮误差就吸收进源那一格，来回切表现为「位置越来越
 *    歪」（用户报：两个同文件 tab 来回切换位置会变化）。收口已经让两边对齐，再推一次是
 *    纯副作用。
 *
 * @returns 本次切换是否真的收口了（同步没开 / 源没位置 ⇒ 没收口，调用方照旧推播）
 */
export function alignShownToSyncSource(
  panel: Panel,
  src: Tab | undefined,
  snap: number | null,
  atFloor = false,
): boolean {
  if (snap === null || !src) return false;
  const shown = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (!shown || shown.tabId === src.tabId) return false;
  // ⚠️ B241 曾经在这里加过「跨侧（一源码一预览）不收口」的守卫 —— 那会儿跨侧走的是
  //    「搬行内比例」的换算，往返不等值，只能不重算。后来跨侧统一到规范游标 `v` ⇒
  //    跨侧**恒等、跨侧照收**；小数丢不丢由 `syncSourceV` 那一条决定（B257 之后：不丢，
  //    跨侧交完整 `v`），这里只管「收口生效 ⇒ 调用方别再推播」那一层。
  //
  // ⚠️⚠️ **B247 那道旧守卫（判「旧双字段里 px 那格是空 ⇒ 源在预览侧」⇒ 早退）**
  //    B251 撤它是**撤错了**，本轮（用户报：切换 tab 往上偏移又出现）按**新语义**请回来：
  //      · B251 撤它的理由写的是「退化里只有 1 条静态契约红、其余 1289 全绿 ⇒ 拦不到真实
  //        路径」。那条退化验是**假绿**：补回去的是旧那道守卫的判空串，而 `snap` 早被 B251
  //        改成 `number` ⇒ 那道守卫恒不命中**任何**路径，行为一点没变，全绿只证明
  //        「补了个寂寞」，证明不了「删了无险」。
  //      · 真病根是：**跨侧拿带比例的量去覆盖** `restoreViewScroll` 刚还原的精确位置。
  //        B242 把「跨侧只交整数块首」判成病根是**因果倒置** —— 整数块首只是让病看起来像
  //        它的那层皮，皮底下是「覆盖」，而 B247 守卫管的正是「不覆盖」。
  //      · 于是连根修：再把守卫请回来 ⇒ 源是**预览**、显示中是**源码**时**彻底不推**，
  //        这份源码保住 `restoreViewScroll` 还原出来的**块内第 3 行**那个精确位置，
  //        谁也别盖（B247 原始症状：跨 3 行段落的文档 warm-up 切一轮，回来源码从 168 被
  //        压到 140 ⇒ 每切一轮往上掉一趟 —— 用户拍板「切回源码要保住自己位置」，
  //        那句拍板到现在仍然有效）。
  //
  // ⚠️⚠️ **B257 再翻这一段里的半句**：`syncSourceV` 的 `cross` 档（跨侧只交整数块首）本轮
  //    **撤了** —— 它的立论「两个小数归一在不同高度上、所以跨侧必须丢小数」不成立（读是
  //    `start + ratio × range`、写是 `into / range`，乘除抵消 ⇒ 两侧小数本来就是同一个量）；
  //    那档唯一的效果是每跨一次侧丢一格比例（自测台：切模式一轮 287 ⇒ 280、切标签一轮
  //    847 ⇒ 840）。但**这道守卫不受影响**，继续照旧生效：它管的是「源预览 / 显示源码时
  //    不许覆盖」，与「跨侧交不交小数」是两件事，别把两者绑在一起读。
  //    （历史：B247 原始症状是「文档中段代码 tab ↔ 预览 tab 来回切，滚动位置会变化」。
  //      B251 那会儿顺带写的「切模式 Ctrl+/ 也只交整数块首」同样随 `cross` 一起失效。）
  // ⚠️⚠️ **B276：这道 B247 守卫撤销了**（用户拍板，金标准优先）。
  //    它原本的语义是「源是预览、显示的是源码 ⇒ 彻底不推，保住源码自己还原出来的精确
  //    位置」（B247 / B251 两轮为「切回源码要保住自己位置」拍的板）。但那与用户在 B271
  //    拍定的金标准**直接冲突** ——「所有同文件标签不管是否激活，滚动位置都完全一致」。
  //    真机 trace 实测的代价（04:34:44）：切到源码 ⇒ 收口被这道守卫拦掉 ⇒ 源码停在
  //    v=79.6、两个预览都在 v=95 ⇒ **差 15.5 行**，正是用户反复报的「激活源码位置和预览
  //    对应不上」。
  //    ⚠️ 当初怕的「拿带比例的量覆盖掉精确位置」已经不成立：B257 之后跨侧交的是**完整
  //    小数游标 v**，覆盖就是对齐，不再每轮吃掉一格比例。
  applySyncToSibling(shown, snap, atFloor);
  return true;
}

/**
 * B159：把源这份位置广播给**别的窗口**（谁滚谁当源，双向 —— 用户拍板）。
 *
 * ⚠️ 只对「用户滚动」那几路开（`crossWindow`）：光标 / 输入那一路不广播 —— 在
 *    主窗口敲一个字就带着子窗口跳，不是「同步滚动」，是「打字干扰」。
 *
 * ⚠️⚠️ **B286**：`atFloor` 必须一起广播。本窗口内「到底 ⇒ 兄弟落自己那一侧的底」靠
 *   `applySyncToSibling` 的第三参传（B284）；跨窗口那条路原先只带 `{docId, srcTabId, v}`，
 *   对端于是**永远不知道源已到底**，只能按游标 `v` 换算 ⇒ 落到 828 而不是自己那一侧的
 *   底 864（36px 裂口，与 B285 同型）。用户报的就是「多窗口同步滚动时两个窗口对不齐」。
 */
export function broadcastSyncPos(src: Tab, v: number | null, atFloor = false): void {
  // `from` 由 emitCrossWindow 注入（= 当前窗口 label），对端据此丢回声 / 跳过源标签。
  void emitCrossWindow(EVT_SYNC_POS, {
    docId: src.docId,
    srcTabId: src.tabId,
    v,
    atFloor,
  }).catch(() => {
    // 没有别的窗口（绝大多数时候）不是错误，本窗口照常工作
  });
}

/**
 * 把源实例的**光标 + 滚动位置**推给同文档的其它实例（B152）。
 *
 * 兄弟分两种处理：
 *   · 正挂在某个面板视图上的 —— 直接派发选区 / 钉滚动，用户才看得见「跟着动了」；
 *   · 离屏的 —— 只改它自己的快照（`state` 的选区 + 位置），等切过去时自然生效。
 *
 * ⚠️ 位置这一路有四条纪律，踩任一条都会污染兄弟自己的记录：
 *   1. 写快照只能走 `recordScroll`（B145 定的唯一闸口，还原期还会拒）；
 *   2. 纯预览实例那个槽装的是**预览**侧的像素（B129），把编辑器侧的 px 塞进去只会
 *      污染它 —— 那类实例只跟光标；反过来，**预览态那份的槽里是预览像素，也不能被
 *      当成编辑器像素拿去推源码兄弟**（B154：这正是「一个预览一个源码」原先不生效的
 *      根因之一）；
 *   3. 钉 DOM 走 `pinScrollTop`（`B170` 起它内部 `markProgrammatic` 标来源，回执由兄弟
 *      的滚动监听经 scroll-guard 吞掉），否则兄弟那一发 scroll 会被记成「用户停过的位置」，
 *      再顺着它的滚动监听推回源；
 *   4. **跨视图模式只能换算，不能直倒**（B154）：预览那侧只认**行号**，编辑器那侧才
 *      认像素。所以坐标要从**源**当前显示的那一侧取、按**兄弟**那一侧的意义落 ——
 *      中间那次换算（顶行 ⇄ 行号）是唯一允许出现的两种坐标系。
 *
 * B154 起「谁滚谁当源」：位置同步不再要求源是激活面板的激活标签 —— **窗口没激活、
 * 面板没点过、鼠标直接放上去滚的那一份也能带着兄弟走**（两条滚动监听直接调这里，
 * 不带 `isSyncSource` 前置）。但**光标**那一半仍然单源（只看 `isSyncSource`）：
 * 选区互推会互相抢，而移动鼠标并不改变激活面板，非激活那份的光标本来就是被同步
 * 推过去的结果 —— 让它也能当源，等于给「谁推谁」多留一个不确定的入口。
 *
 * B159 加了一个开关 `crossWindow`：只有「用户滚动」那几路会打开它 —— 广播给别的
 * 窗口。光标 / 输入那一路**不**播：在窗口里敲一个字就带着另一个窗口跳，那不叫
 * 同步滚动，叫打字干扰。
 */
/**
 * @param opts.v        **覆盖取值口**（B258）：调用方手上已经有一个与收口同一个口径的 `v`
 *                      （离屏前采的那一份）时传进来 —— 收口生效后的那趟补推就靠它保证
 *                      「兄弟与接班那一份用的是同一个数」。不传则照旧走 `syncSourceV(src)`。
 * @param opts.skipTabIds 要**排除**的实例（B258）：收口已经把「源」和「接班那一份」写好了，
 *                      再推一次是把它们自己的位置也改掉（B241 明确禁止），只推其余兄弟。
 */
export function pushSyncToSiblings(
  src: Tab,
  crossWindow = false,
  opts: { v?: number | null; skipTabIds?: number[]; atFloor?: boolean } = {},
): void {
  if (docSyncModes.get(src.docId) !== true) return;
  // ⚠️ B259：`suppressSyncPush` 这一层**原来只挡光标那一路的调用点**（`handleUpdate`
  //    里那句），挡不住下面这两处「从别的函数内部发起的推播」——
  //    · `switchTab` 尾那趟（`if (tab && !aligned) pushSyncToSiblings(tab);`）；
  //    · 离屏实例挂载那一路。
  //    开侧边预览那一支要夹住的正是**第一处**：接班那一份是**刚建的空档实例**，位置
  //    还没排，从它往外推出去的就是「文档开头」，会把源与其余兄弟一起拽到顶。
  //    （B254 那条通用律的同型：`view.setState` / 重建视图这类「位置归零」的瞬间，
  //     产生的那趟推播不能拿它当源坐标。）
  //    ⚠️ **B261（真凶已定位，两条；都在这条推播的下游）**：位置「被归零 / 从没存在过」
  //       会顺着这两条路被误采进去 —— ①「scroll 事件」路（这里这一处监听）；②「主动读
  //       容器」路（`rememberViewScroll()`：DOM 消失前读一眼）。两者形态不同：事件路靠
  //       回执，主动读路靠调用点排在归零之前。⚠️⚠️ **第一轮的结论是假的**：那会儿按
  //       ① 下结论（"摘除 ⇒ 归零 ⇒ 派发 scroll"）并照它加闸 ⇒ 桩上红、真机**毫无变化**
  //       （用户报「还在」）—— 真浏览器在元素被摘除 / `display:none` 时归零 `scrollTop`
  //       属于「重置」,**根本不派发 scroll**，那一发是桩里注入的。那条闸已撤。
  //       ✅ **本轮真凶**（自测台退化 ⇒ 红、还原 ⇒ 绿，双向验过）：
  //         · **copy 分支既没夹推播、也没给新副本落位**（右键分屏 = 复制式，见
  //           `splitPanelWithTab` 里 B261 那两行）：`refreshAll()` 尾那趟以**空档副本**
  //           为源推播 ⇒ 同文档的原标签被钉到 0（用户症状②；自测台退化 `0/0` ⇒ 修复
  //           `287/287`）。
  //         · **已有右分屏那一支的顺序反了**（见 `openPreviewToSide` 里 B261 那段）：
  //           落位排在 `applyPanelMode` **之后**，而它尾那句 `if (anchorLine > 1)
  //           preview.syncToLine(anchorLine)` 读的是**面板 EditorView 上次按槽还原出来的
  //           陈旧 scrollTop ⇒ `anchorLine` 根本不是空档、是旧值** ⇒ 把刚按源落好的位置
  //           又掀回旧值（用户症状①；自测台：源 290 该落 870，被陈旧 287 掀回 861）。
  //    ⚠️ 这里挡在**函数入口**（而不是改调用方的那行判据）—— `switchTab` 尾那句的
  //      写法被 `sync-scroll-mode` 好几条契约钉着，去改它会整片翻红，而语义本来就
  //      是「这一趟推播不许发生」，压在推播自身最贴切。
  if (suppressSyncPush) return;
  const skip = opts.skipTabIds ?? [];
  const sibs = instancesOfDoc(src.docId).filter(
    (t) => t.tabId !== src.tabId && !skip.includes(t.tabId),
  );
  // B164：本地没有兄弟**不代表**没人跟着 —— 卫星窗口里那份是「主窗口还攥着一份」的
  // 唯一本地实例，从这里 return 会把末尾的跨窗口广播一并跳过（用户报：子窗口滚动
  // 带不动主窗口同一文件的其他标签）。光标那一路（`crossWindow=false`）没有广播可发，
  // 维持原判；广播那半段见函数末尾的 `if (crossWindow)`。
  if (sibs.length === 0 && !crossWindow) return;
  // 光标位置取源的 `head`。同源内容一致，但离线那一份可能还没追上最新正文
  // （`syncDocInstances` 对它是离线更新），所以要夹回它自己的行数再落。
  const head = src.state.selection.main.head;
  // 源此刻显示在哪一侧，就取那一侧的坐标（纪律 2 / 4）—— 但**只经 `syncSourceV` 一个口**，
  // 这一路自己不碰 `topVisibleLineFrac` / `topVisibleLine` / 容器的 scrollTop：
  // 先取局部变量是因为后面是同步代码块，收窄不跨块保留。
  // ⚠️ B251：坐标只有**一种东西** —— 规范游标 `v`，且**只从** `syncSourceV` 拿。
  //    以前这里是三套：`px`（源是源码时的编辑器像素）+ `line`（源是预览时的整数块首），
  //    而整数块首这一路是 B249 改的 —— 它是「跨侧只交整数块首」的补丁，代价是丢掉
  //    源在块内的位置（B247 那个「每切一轮往上掉」就是从这条补丁长出来的）。
  //    统一交 `v`（实数行号，小数 = 在**自己那一侧**按同一份几何插出来的归一化比例）：
  //    · 源是源码 ⇒ 就是 `topVisibleLineFrac` 那个小数（行内比例）；
  //    · 源是预览 ⇒ 就是 `topVisibleLine()` 那个小数（已按**块内/行内**折成行号+比例）。
  //    两条本来就是同一个公式，只是此前没人认；现在谁也不许再自己取坐标。
  //    ⚠️ 小数**不是**可以随便丢的零头：跟随要它才能「连续走」（B174 那条「卡一下、跳一下」），
  //      跨侧（行 ⇄ 块）同样要它 —— B251 那会儿这里按「两个小数归一在不同高度上」判成
  //      「跨侧必须丢小数」（跨侧取整数块首 / `Math.floor`），本轮 B257 翻案（见
  //      `syncSourceV` 上那段）：读 `start + ratio × range`、写 `into / range` 乘除抵消，
  //      两边小数本来就是同一个「走了一格多少」的量，丢掉就是那一格的比例
  //      （自测台：预览滚到 847 ⇒ 源码被打到 280，之后怎么切都回不来）。
  //    ⚠️ 所以这一路**不区分跨侧 / 同侧**，一律 `syncSourceV(src)` 交完整 `v`；跨窗广播
  //      也用同一份（同源同排版，没必要为了「稳」再丢一次位置）。
  //
  // ⚠️⚠️ **B256（真机日志钉死）**：源码这一侧读的是**实时 DOM**，而 DOM 在「还原刚写完」
  //    那一帧可能是**被浏览器裁小**的余量（见 `sourceCursorPx`）—— `switchTab` 的收尾补
  //    推就排在这个窗口里，拿它当源 ⇒ 同文档的预览兄弟被往**上**拖一整段（真机 1421→1043），
  //    且因为每轮切回来都复现同一条路径，歪值冻在那里「之后怎么切都不动」。所以像素走
  //    `sourceCursorPx`（DOM 与槽不一致 ⇒ 用槽），别再直接 `view.scrollDOM.scrollTop`。
  const v = opts.v !== undefined ? opts.v : syncSourceV(src);
  // ⚠️ B284：与 `v` **同帧**把「源顶没顶到自己的底」一起采下（此刻源还在屏、问得出真话；
  //    等到切标签收口那一刻源早已离屏、`clientHeight = 0` ⇒ 那一问恒假，见 `tabAtOwnFloor`）。
  //    ⚠️ 交接那一趟源**已经离屏**，只能信调用方当场采下来的 `opts.atFloor`。
  const atFloor = opts.atFloor ?? tabAtOwnFloor(src);
  // ⚠️ B273：源自己也要记下规范游标（与兄弟同口径），切走再切回时 restore 能从它派生像素。
  // ⚠️ B288④-1：源游标为 null（容器未测量 / 真机把 detached 容器 scrollTop 钳 0 读出假 0）
  //   时**不许**把源的规范游标 `syncV` 写成 null —— 那等于用「读不出来」覆盖「已知的真值」，
  //   后续切回 / 跨窗广播 / 落盘全按 null 派生（回顶）。源在屏且测得准才写；读不出时保留
  //   上一次同步留下的 `syncV`（指向真实位置）。
  if (v !== null) src.syncV = v;
  // ⚠️ B260：下面循环里**曾经**另取一个同名 `v = syncSourceV(src)`，把上面这个盖掉 ——
  //    于是 `opts.v` 只进了日志和跨窗广播，**落点那一趟照旧重算** `syncSourceV(src)`。
  //    B258 传 `opts.v` 就是为了「兄弟与接班落在同一个数」，被盖掉就让那趟补推名存实亡。
  //    ⇒ 这里是唯一取值口，循环里不许再取第二个同名量（换锚时一并订正，别抬杠）。
  // B167 定位用：同步滚动是「每秒几十次」的高频链路，抖起来只能靠日志看是谁在推谁。
  //   这几条全是 debug（默认 info 看不到，需在设置里把 log_level 调到 debug），
  //   排查时按 docId 过滤即可看出是不是「A 推 B、B 又推回 A」的拉锯。
  logger.debug(
    "sync",
    `推 src=${src.tabId} doc=${src.docId} v=${v} sibs=${sibs.length} cross=${crossWindow}`,
  );
  for (const other of sibs) {
    // ⚠️⚠️ 这里**不再分跨侧 / 同侧**（B257 翻案，删掉 `cross` 这一档后 `other` 只当来源用，
    //    下面 `applySyncToSibling` 按兄弟自己是源码 / 预览选换算方式，不需要这儿先判一次）。
    //    旧写法是「按跨侧判据给取值口传第二个实参，跨侧交整数块首 / 整数顶行」，那是
    //    B251 那会儿按「跨侧小数归一在不同高度上 ⇒ 必须丢小数」加的；本轮证明前提就不成立
    //    （读 ×range、
    //    写 /range 抵消，两侧小数是同一个量），丢小数 ⇒ 跟随与收口各吃一格比例。
    //    （历史：更早那版 `other.viewMode !== "preview"` 是**绝对**判断，冒充不了「跨不跨
    //     侧」这个**相对**关系 —— 源源码 + 兄弟预览被判成同侧 ⇒ 交行内比例 ⇒ 预览按块高
    //     插值 ⇒ 恒偏下；源预览 + 兄弟源码同理恒偏上。）
    //
    // ⚠️⚠️ B260：上面那条注释里没提的一行 —— 这里**曾经**另起一个同名
    //    `const v = syncSourceV(src);`，把取值口那个 `v` 盖掉 ⇒ `opts.v` 只进了日志与
    //    跨窗广播，**落点那趟照旧重算** `syncSourceV(src)`（B258 传 `opts.v` 是为了让
    //    「兄弟与接班落在同一个数」，被盖掉就等于那趟补推名存实亡）。本轮删掉这一行 ——
    //    整个函数只有上面一个取值口，循环里不许再出现第二个同名 `v`。
    const line2 = other.state.doc.lineAt(Math.min(head, other.state.doc.length));
    const pos = Math.min(head, line2.to);
    const shownView = displayedPanelOfTab(other.tabId)?.view?.view;
    if (shownView) {
      // B167：必须带 `scrollIntoView: false` —— CM6 为了让光标可见会**自己滚一下**，
      //   而它排的是**下一帧的 measure**：等它落地，包裹这次同步的两帧还原窗口早已
      //   关上，那一发 scroll 于是被当成「用户在滚」、反过来推回源 ⇒ 两边来回拉
      //   （用户反复报的同步滚动抖动）。位置由下面 `applySyncToSibling` 统一钉，
      //   这一下自动滚动纯属多余。
      // B176：这一发光标 dispatch 会**同步**触发兄弟的 `handleUpdate`；若兄弟正好是激活
      //   标签（`isSyncSource` 为真），它会在那一轮反推回源 ⇒ A↔B 拉锯（非激活源滚动抖）。
      //   打标让兄弟那一轮跳过反推，光标仍照常落到兄弟。离线快照不走 dispatch，无需标。
      syncingCursorDocId = src.docId;
      try {
        shownView.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
      } finally {
        syncingCursorDocId = null;
      }
    } else {
      other.state = other.state.update({ selection: { anchor: pos } }).state;
    }
    // 位置那一路（跨视图模式的换算都关在这一函数里）
    applySyncToSibling(other, v, atFloor);
  }
  // B159：位置广播排在最后 —— 本地兄弟已经对齐过一次，别人接手时看到的是同一个落点。
  if (crossWindow) broadcastSyncPos(src, v, atFloor);
}

/**
 * 触发式位置跳转（大纲点击 / 转到行 / 查找命中）的统一同步入口。
 *
 * 三处触发源原先各自手工 `for (inst of instancesOfDoc(...))` 循环本地实例，**完全没有
 * crossWindow 广播**，且重写了兄弟派发逻辑（与 `pushSyncToSiblings` 行为差异：y:"center"
 * vs y:"start"、漏光标派发、漏离屏快照落槽……）。多窗口下点击大纲跳转不跟随就是这一条漏广播。
 *
 * 收口到这一处后：本地兄弟派发 + 跨窗口广播都由 `pushSyncToSiblings` 负责，三处不再各写一遍，
 * 行为天然一致。`v` 用与收口同一个口径的实数行号（带小数比例），这里不另取坐标；
 * 跨窗口广播恒开（`crossWindow=true`）—— 这几类「用户主动跳转」本就该带着别的窗口一起走
 * （前提是该文档开了同步滚动，由 `pushSyncToSiblings` 内部 `docSyncModes` 守卫裁决）。
 *
 * @param src 触发跳转的活动实例（它自身的定位由调用方 dispatch 完成，本函数只推兄弟 + 广播）。
 * @param v   跳转目标行（实数行号，小数 = 行内比例；整数即顶到该行顶，与 y:"start" 对齐）。
 */
export function syncJumpToLine(src: Tab, v: number | null): void {
  pushSyncToSiblings(src, true, { v });
}

export function topVisibleLineFrac(view: EditorView, px = view.scrollDOM.scrollTop): number {
  // ⚠️ B256：`px` **可以显式指定**（见 `sourceCursorPx`：还原刚写完、浏览器还没接过那一刻
  //    要按「这份标签**该**停在哪」取游标，而不是按 DOM 里那个被裁小的余量）。不传就照旧
  //    读实时 DOM —— 函数体其余部分一个字没动。
  const scrollTop = px;
  // ⚠️ B251（ANCHOR = 0）：探测点只是「问 CM6 视口顶上那一块是哪一块」时的**内缩量**，
  //    **不是**坐标平移 —— 比例下面按**真·scrollTop** 算。旧写法把 `+1` 一起算进比例
  //    （`(scrollTop + 1 - lineTop) / lineHeight`），而落点 `sourceTopOfV` 写的是
  //    `lineTop + frac * lineHeight`（不补这 1px）⇒ 每走一次往返就偏 1px：预览→源码→预览
  //    看着没事，源码→预览→源码每轮掉 1px，切几十次就看得出来（B245 那类「越切越靠顶」）。
  //    ⚠️ 内缩量必须＞0：滚到**整行顶**（scrollTop === lineTop）时 CM6 的 `lineBlockAtHeight`
  //    按「块含 this height」取，正好压在边界会退到**上一行** ⇒ 行号错一格。半像素安全网。
  const block = view.lineBlockAtHeight(scrollTop + TOP_PROBE);
  const line = view.state.doc.lineAt(block.from);
  // B175：换行（isWrap=true）下一条逻辑行会被 CM6 拆成**多个视觉块**（每块一行高），
  // 这些块的 `lineAt(block.from).number` 都是同一个逻辑行号、块 `height` 只是一条视觉行高。
  // 若只用「当前视觉块内比例」拼行号，滚过一段折行段落时行号会卡在 N±1 上下跳 ⇒ 推给预览
  // 的坐标跟着抖，预览那份看起来就是「整页重渲染 / 跳动」（用户反复报的同步抖动）。
  // 必须把比例算在**整条逻辑行**的高度上：取这一行的顶（首视觉块 top）与下一行顶之差当
  // 总高，再算「滚动进入这一行的比例」—— 折行段落里行号随滚动平滑推进 N→N+1，预览落点才连续。
  const lineTop = view.lineBlockAt(line.from).top;
  const nextLine = line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : null;
  const nextTop = nextLine ? view.lineBlockAt(nextLine.from).top : lineTop + (block.height || 1);
  const lineHeight = nextTop - lineTop || block.height || 1;
  // ⚠️ B251：比例**不加探针**（ANCHOR = 0）—— 与 `sourceTopOfV` 的 `lineTop + frac*h`
  //    严格互逆，往返一分不差。探针只影响「是哪一行」，不影响「行内走了多少」。
  const ratio = Math.min(1, Math.max(0, (scrollTop - lineTop) / lineHeight));
  return line.number + ratio;
}

/**
 * B242：把「md 逻辑行号」换成**这一行的行首**在编辑器里的像素。
 *
 * ⚠️ 口径是**行首**，不是「行内某个比例的位置」——两边只有这个口径是闭合的：
 *    源码按**行**排版、预览按**块**排版，「行内 40%」在两边量的是完全不一样的高度，
 *    把这一路的行内比例搬到另一侧，往返就不等值，每切一轮吃掉一点，来回切表现为
 *    「位置越来越歪」。而「行首」两边都有确定对应（编辑器 = 这一行顶部，预览 =
 *    这个块顶部），同一个行号 ⇒ 同一个像素，来回切恒等。
 *
 * ⚠️「同步滚动与代码/预览切换用同一套位置计算」这句话就落在这个函数上：
 *    切源码/预览（toggleViewMode 的 handoff）与**跨侧**同步落点（applySyncToSibling）
 *    都只调它，别各写一份带比例的换算。行内比例只留给**同侧跟随**
 *    （源码→源码走 px 直通、源码→预览那条跟随链），那条路根本不做跨坐标系搬运。
 *
 * @returns 行号越界返回 `null`（文档比行号短 / 还没同步完正文）
 */
export function editorLineTopPx(view: EditorView, line: number): number | null {
  const n = Math.min(Math.max(1, line), view.state.doc.lines);
  return Math.max(0, view.lineBlockAt(view.state.doc.line(n).from).top);
}

/**
 * B251：把**规范游标 `v`**（实数行号）换算成编辑器像素 —— 源码侧落点的**唯一出口**。
 *
 * `v = 行号 + 行内比例`：整数部分定行（走 `editorLineTopPx`），小数部分按**行高插值**
 * （下一行顶 − 本行顶，含折行的整逻辑行高，与 `topVisibleLineFrac` 同口径）
 * ⇒ **读与写严格互逆**。
 *
 * ⚠️ 旧写法把 `v` 的小数直接丢给 `editorLineTopPx` —— CM6 的 `doc.line(小数)` 会**向上
 *    取整**，于是每一路跨侧换算都白吃一次取整（B249 那个「差一行」有一半就在这一处：
 *    收口交的 `line` 明明带了块内比例，去程被上取整、回程预览侧 `Math.floor` 下取整，
 *    各取整各的）。现在显式插值，小数不再被吞掉。
 */
export function sourceTopOfV(view: EditorView, v: number): number | null {
  const lines = view.state.doc.lines;
  const base = Math.floor(Math.min(Math.max(v, 1), lines));
  const lineTop = editorLineTopPx(view, base);
  if (lineTop === null) return null;
  // ⚠️ 量不出下一个行顶（末行）就退回行首 —— 绝不拿 `block.height` 之类的近似值顶上，
  //    否则跨侧换算每轮带一点误差，来回切就漂（B240 二轮同型：别拿缓存做实时决策）。
  const nextTop = base < lines ? editorLineTopPx(view, base + 1) : null;
  const h = nextTop !== null ? nextTop - lineTop : 0;
  return h > 0 ? lineTop + (v - base) * h : lineTop;
}

/**
 * B256：源码侧「取游标」时以**哪个像素**为准 —— 只有这一处会决定源码侧的 `v`。
 *
 * ⚠️⚠️ 默认读**实时 DOM**，但 DOM 里的值可能是**还没被浏览器接过**的：刚 `setState` 换完
 *    文档，CM6 用的还是**估算行高**建的 heightMap，可滚余量比最终短 —— 那一帧往里写 `px`
 *    会被浏览器按当时的余量**裁小**，下一帧 measure 跑完余量长回来、补钉才真正到位
 *    （真机日志 B255：写 1222.67，当帧只落 **858.67**；下一帧的「锚点补偿」才把它钉回
 *    1222.67）。这种窗口里 DOM **说的不是**这份标签该停的位置，而槽里那份 `t.scrollTop`
 *    正是 `restoreViewScroll` 刚按它钉过一次的值。
 *
 *    而 `switchTab` 的收尾补推**就排在还原之后、锚点补偿之前**（同帧）：它读的就是这个
 *    被裁小的 DOM ⇒ 算出 v=41（同几何真值 59）⇒ 把同文档的预览兄弟从 1421 钉到 **1043**，
 *    用户报的「另一个预览向上偏移、之后怎么切都不动」；第二轮切回来一模一样复现，歪值
 *    于是被冻在那儿。差超过一个像素就认定「DOM 还没立住」，改按槽里那份算。
 *
 *    ⚠️ 只在**真的不一致**时才回退：跟随那一路（用户滚、DOM 与槽本来就该相等）一个字节
 *       都不变；真有程序摆位让两者分家（`pinScrollTop` + 回执被吞）时，槽里记的也是
 *      「我们最后决定的位置」，比一个半路的中间值更接近用户看到的东西。
 */
export function sourceCursorPx(t: Tab, view: EditorView): number {
  const dom = view.scrollDOM.scrollTop;
  if (t.scrollTop !== null && Math.abs(dom - t.scrollTop) > LAND_STALE_PX) return t.scrollTop;
  return dom;
}

export function syncSourceV(t: Tab | undefined): number | null {
  if (!t) return null;
  const p = panelOfTab(t.tabId);
  // ⚠️ 预览侧**一律** `topVisibleLine()`（带块内/行内比例的小数）。B251 那会儿这里分了
  //    `cross` 两档给 `topBlockStartLine()`（整数块首），本轮 B257 撤掉 —— 见上面那段
  //    翻案：读是 `start + ratio × range`、写是 `into / range`，乘除抵消 ⇒ 交整数块首
  //    纯属自丢位置（自测台：预览 847 ⇒ 切一轮变 840）。
  if (t.viewMode === "preview") {
    // ⚠️ B288④-1：预览容器未测量（拖标签摘面板 / 重挂载的零尺寸窗口）时 `topVisibleLine()`
    //    **不可信**——此刻 scrollTop 被钳 0、块却还在 ⇒ 读出「第一块行号」假游标（约 v=1），
    //    把停在深处的预览当成「置顶」推给兄弟 ⇒ 源码瞬拖到 0，且把 `syncV` 毒化成假值
    //    （下次切回预览时从毒化的 v 派生，位置错乱）。与源码侧 `sourceCursorPx` 回退槽值、
    //    `restorePreviewScroll` 的 `!unmeasuredPanels.has(panel)` 守卫同款纪律（B271）：未测量
    //    一律报**上次同步的规范游标 `t.syncV`**（宁可报已知真值，不许报 0 抹位置）。已测量才
    //    走 `topVisibleLine()` 读当前真实可见行（用户滚预览时的实时同步靠它）。
    if (p && unmeasuredPanels.has(p)) return t.syncV ?? null;
    return p?.preview?.topVisibleLine() ?? null;
  }
  const view = p?.view?.view;
  if (!view) return null;
  // ⚠️ B256：像素过 `sourceCursorPx`（DOM 与槽不一致 ⇒ 用槽）—— 别再直接读
  //    `view.scrollDOM.scrollTop`：那一路会把「还原刚写完、被浏览器裁小的那一帧」当成源。
  return topVisibleLineFrac(view, sourceCursorPx(t, view));
}

/**
 * 「顶到自然上限」的容差（px）—— 与 `PIN_EPSILON_PX` 同口径：缩放不是 100% 时
 * `scrollTop` 天生带小数，差不到一个像素就别当成「还没到顶」。
 */
const FLOOR_EPSILON_PX = 1;

/** 一侧自己的可滚上限（px）：`maxScroll`。「到底」锚点落的就是这个位置。 */
export function ownFloorPx(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * B284：这一份**此刻显示在屏的那一侧**是不是顶到了它自己一侧的自然上限。
 *
 * ⚠️ 为什么「到底」必须脱离游标单独判：撤掉底部留白后，源码按行排、预览按块排 ⇒ 同一份
 *    文档两侧内容高天生不同 ⇒ `maxScroll` 不同 ⇒ 「各自到底」时它们的**顶行游标 v 本来
 *    就不相等**（24 行 md / 视口 60：源码底 v≈20.7、预览底 v≈21.6）。照旧用 v 互推，
 *    到底那一发必然把对方拽离它自己的底，来回滚就看到位置跳变（用户报：滚动到底部后
 *    跳变滚动位置）。⇒ 「到底」做成**共享状态**：源到底 ⇒ 兄弟各自落到自己的底。
 *
 * ⚠️ 只在**量得出**时才回答：`clientHeight <= 0`（离屏 `display:none`）时
 *    `scrollHeight - 0 - scrollTop` 恒 ≤ 容差 ⇒ **恒判「到底」**（B261 踩过：切标签收口
 *    那一问源早已离屏 ⇒ 恒真 ⇒ 每次切换都把位置顶走）。量不出一律答「没到底」。
 */
export function tabAtOwnFloor(t: Tab | undefined): boolean {
  if (!t) return false;
  const p = displayedPanelOfTab(t.tabId);
  if (!p) return false;
  const el = t.viewMode === "preview" ? p.preview?.root : p.view?.view?.scrollDOM;
  if (!el) return false;
  // ⚠️ 离屏（`display:none` ⇒ `clientHeight = 0`）：`scrollHeight - 0 - scrollTop` 恒 ≤ 容差
  //    ⇒ 不闸住就**恒判「到底」**（B261 踩过：切标签收口那一问源已离屏 ⇒ 恒真 ⇒ 每次
  //    切换都把位置顶走）。量不出一律答「没到底」。
  if (el.clientHeight <= 0) return false;
  // ⚠️⚠️ 同理，**可滚范围必须真存在**：`scrollHeight` 还没撑开（新建实例 / 内容未渲染 /
  //    桩里没建模）时 `ownFloorPx` 算出 0，而 `scrollTop` 也是 0 ⇒ `0 - 0 ≤ 容差` ⇒
  //    照样**恒判「到底」**（B284 实测：sync-three-tabs 那条用例被这一路假阳性打红 ——
  //    锚点分支一进就 `return`，把按游标换算那一支整条跳过了）。
  //    ⇒ 没有可滚范围就谈不上「到底」，一律答「没到底」，交回按游标换算那一路。
  const floor = ownFloorPx(el);
  if (floor <= 0) return false;
  return floor - el.scrollTop <= FLOOR_EPSILON_PX;
}

/**
 * 程序滚动期间禁止写快照（B139）：已由 `src/scroll-guard.ts` 的来源标记取代。
 *
 * 现在每次程序摆位（`pinScrollTop` / 预览钉位 / `host.scrollToLine`）都先
 * `markProgrammatic(el)`，目标容器的 scroll 监听一见标记即吞（不写快照、不推兄弟），
 * 标记靠用户接管滚动的真实输入清除 —— 不比位置、不赌时序、无时间窗。旧的
 * `viewportWriteDepth` 计数与 `restoringViewport` 两帧窗口已删除；`pinScrollTop` 的
 * 逐帧补钉只负责「钉稳」，不再兼任「抑制写快照」的计时器。
 */

/**
 * ⚠️ 这里**曾经**另起过一个 `swappingView`：`setState` 前后把 `viewportWriteDepth` +1 一帧，
 * 想连「浏览器下一帧才派发的那发 scroll」一起挡住。已删（B146 二轮定稿）—— 它挡掉的
 * 并不只有换文档那两下自动滚动，**切完标签同一帧内的用户滚动也一并丢了**，而那本来就该记。
 * 如今换文档那几下自动滚动改由「`markProgrammatic(view.scrollDOM)` + 监听见标记即吞」认领
 * （见 `switchTab` / `restoreViewScroll`），不再靠时间窗赌时序。
 */

/**
 * 在视图消失**之前**把此刻的位置采进快照（B126，B139 保留但换了理由）。
 *
 * 快照是与 DOM 解耦的全局记录（见 `viewportOfTab`），`setState` / `view.destroy()`
 * 清不掉它 —— 但**读不到**：位置变化不一定派发 scroll 事件，最典型的是程序里的裸写
 * （预览→编辑器同步的 `host.scrollToLine()`、用例里的直接赋值）。最后一次变化若不采，
 * 这份快照就一直停在更早的位置上。
 *
 * 所以这里不是「随 DOM 刷新」，而是「DOM 消失前看最后一眼」：读的是清零**之前**
 * 的容器，采完立刻就销毁。两件事各管一段 —— 滚动采样覆盖「用户滚过」，这里覆盖
 * 「最后的落点是程序摆的、且没发过事件」。
 */
export function rememberViewScroll(panel: Panel): void {
  if (!panel.view || panel.viewTabId === null) return;
  const t = tabs.get(panel.viewTabId);
  if (!t) return;
  // 纯预览实例：编辑器是 display:none、scrollDOM.scrollTop 恒为 0，照常写回来
  // 就等于「切走的一刻把上次的位置抹平」（B130）。这类实例的位置归预览那一侧。
  // B145：钉位置**还在重试**的那一刻，容器里摆的是没立住的值（多半是被裁成的 0）。
  // 这段空窗期归还原管，「消失前看最后一眼」看出来的会是一份假位置，采进去就等于
  // 把「还原没成功」记成「用户停在这里」—— 于是落盘成 0、重启回顶部。
  if (pinInFlight(panel.view.view.scrollDOM)) return;
  if (t.viewMode === "preview") {
    const mode = panel.bodyEl?.classList;
    if (mode?.contains("mode-preview") || mode?.contains("mode-split")) {
      const root = panel.preview?.root ?? null;
      if (root === null || !pinInFlight(root)) {
        // ⚠️ B288 诊断：这一眼读到的就是**即将写进槽**的值。真机复现里出现过
        //    「容器已被 rebuild 换掉 ⇒ 读到 0 ⇒ 槽被抹平」，靠这条 trace 区分
        //    「容器真的归零」与「读到的是旧值」。（trace 级：默认看不到，排错时开）
        // ⚠️ B288 同款根因：预览根容器未测量（scrollHeight ≤ 0，拖标签把面板摘空后的
        //    零尺寸窗口）且读到 0、槽里却有真值 ⇒ 跳过，不许拿 0 抹真实位置。
        if (
          root !== null &&
          root.scrollHeight <= 0 &&
          root.scrollTop === 0 &&
          t.scrollTop !== null
        ) {
          logger.trace(
            "viewport",
            `记忆 · 预览容器未测量 tab=${t.tabId}，跳过二次污染（保留原槽=${fmtPx(t.scrollTop)}）`,
          );
        } else {
          logger.trace(
            "viewport",
            `记忆 · 预览容器 tab=${t.tabId} 读到=${root ? fmtPx(root.scrollTop) : "无容器"} 原槽=${t.scrollTop === null ? "null" : fmtPx(t.scrollTop)}`,
          );
          recordScroll(t.tabId, root ? root.scrollTop : null);
        }
      }
    }
    return;
  }
  // ⚠️ B288 诊断：同上 —— 源码侧「消失前看最后一眼」读到的容器值。与下面那条
  //    `写入位置` trace 成对看：两条的 px 一致说明读的是真值，出现 0 就是容器已归零。
  const scroller = panel.view.view.scrollDOM;
  // ⚠️ B288 根因修复：容器未测量（拖标签把源面板摘空 / 摘出渲染树后的零尺寸窗口，
  //   真实浏览器会把 detached / 零尺寸容器的 scrollTop 钳成 0）时，读出来的 0 会抹掉
  //   槽里那份真实位置（拖完一回车就停在开头、会话落盘成 0、还经同步推播传染兄弟）。
  //   与 pinInFlight 守卫同款纪律（B130/B162：宁留死格、不许拿 0 抹真位置）：读到的
  //   也是 0、且槽里确有真值，就跳过。jsdom 下 scrollHeight 恒为 0、且 detached 容器
  //   不钳 0（读到的是桩里存的非零值），所以这条在桩里放行；真机那个会抹真值的窗口
  //   靠它拦住。前置：拖分屏路径在 `setLayout` 摘空源面板之前已采过一次
  //   （见 `splitPanelWithTab` 里的 `rememberViewScroll(src)`），这里拦的是「二次污染」。
  if (scroller.scrollHeight <= 0 && scroller.scrollTop === 0 && t.scrollTop !== null) {
    logger.trace(
      "viewport",
      `记忆 · 源码容器未测量 tab=${t.tabId}，跳过二次污染（保留原槽=${fmtPx(t.scrollTop)}）`,
    );
    return;
  }
  logger.trace(
    "viewport",
    `记忆 · 源码容器 tab=${t.tabId} 读到=${fmtPx(scroller.scrollTop)} 原槽=${t.scrollTop === null ? "null" : fmtPx(t.scrollTop)}`,
  );
  recordScroll(t.tabId, scroller.scrollTop);
}

export function restoreViewScroll(panel: Panel): void {
  if (!panel.view || panel.viewTabId === null) return;
  const t = tabs.get(panel.viewTabId);
  if (!t) return;
  // 纯预览实例：这个槽位里记的是**预览**的滚动位置（B129），编辑器此时是
  // display:none，把像素值塞给它只会污染「编辑器顶行」，预览那边反而没人管。
  if (t.viewMode === "preview") return;
  const view = panel.view.view;
  // B170：整段还原都是程序摆位 —— 先标来源，赋值派发的 scroll 由监听经 scroll-guard 吞掉，
  // 不会被当成用户滚动反推 / 落盘成 0。`pinScrollTop` 内部也会继续标、覆盖补钉回执。
  markProgrammatic(view.scrollDOM);
  // B280：还原几何（debug）—— 症状「切回去渲染不完整 / 跳回开头」靠这一条定位：
  //   钉位**前**的容器高 / 内容高 / 渲染行数 / 可滚范围 / 留白全打出来（见 logViewportGeom）。
  logViewportGeom("还原 · 钉前", panel);
  // ⚠️ **B273 + B288⑤-1b**：这份实例有规范游标 ⇒ 一律从 `syncV` 派生源码像素，
  //   而不是读可能陈旧的 `scrollTop`。离屏实例跟随时只有 `syncV` 是准的（`scrollTop` 没更新过），
  //   直接读它切回来就会跳。派生后再 `recordScroll` 把新像素写回槽，陈旧值被覆盖。
  //   ⚠️⚠️ **1b 不再要求「同步开着」**：B288⑤-1a 之后**每个标签都有自己的 v**（滚动监听
  //      无条件维护，与同步开关无关），v 的语义就是「这份标签自己停在第几行」。
  //      同步关着时它正是 B149 基线要的「各认各的」——按自己的 v 还原自己的位置，
  //      而不是退回像素槽（像素几何相关，宽度一变就错行）。
  //   ⚠️ 尺子未测（新建视图 / setState 之后到 measure 帧之前）⇒ 此刻换算必落「估算空间」，
  //      一个字节都不写，落到下面槽支兜底；measure 后 `measureAndKeepScroll` 的 rAF 会调
  //      **本函数**按实测几何重落（B288⑤-4：挂起补写已删，重落就是重还原）。
  if (t.syncV !== null) {
    if (unmeasuredPanels.has(panel)) {
      // ⚠️ 尺子未测：v→px 换算会落「估算空间」，**什么都不写**（B288⑤-4：挂起补写已删）。
      //    槽里那份 `t.scrollTop` 是之前实测过的真值，**照样落到下面旧路径钉它兜底**：
      //    浏览器按此刻估算余量裁一下（正是 B256 那条「还原被裁小」窗口），measure 后
      //    `measureAndKeepScroll` 的 rAF 调**本函数**按实测几何重落（v 分支一步到位）。
      //    不放行 ⇒ 离屏/未测期间这一格至少停在「真值被裁一帧」，
      //    不会空着等到 measure 才动（B256 的桩靠这个把裁剪窗口造出来）。
    } else {
      const top = sourceTopOfV(view, t.syncV);
      if (top !== null) {
        pinScrollTop(view.scrollDOM, top);
        recordScroll(t.tabId, top);
        logViewportGeom(`还原 · 钉后(游标) 目标=${fmtPx(top)}`, panel);
        return;
      }
      // top 为 null（量不出几何）：落到下面用 scrollTop 的旧路径兜底。
    }
  }
  if (t.scrollTop !== null) {
    pinScrollTop(view.scrollDOM, t.scrollTop);
    logViewportGeom(`还原 · 钉后(槽) 目标=${fmtPx(t.scrollTop)}`, panel);
    return;
  }
  // 快照里没有位置（这份实例从没显示过）：退化为「保证光标可见」
  const head = view.state.selection.main.head;
  if (head <= 0) return;
  view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "nearest" }) });
}

/**
 * 把「纯预览实例」的视图位置还给预览容器（B129）。
 *
 * 与 `restoreViewScroll` 是一对、但要**单独调**：纯预览下值记在预览那一侧，
 * 而 `applyPanelMode` 会按编辑器顶行把预览 `syncToLine` 一次，不补这一下，
 * 用户上次翻到的位置就被行定位顶掉了（B130 实测：存 300、回来变成 284）。
 *
 * 必须在 `applyPanelMode` **之后**：预览那一次 `setBlocks` 才把内容撑开，
 * 早一步设浏览器会裁成 0。
 */
export function restorePreviewScroll(panel: Panel): void {
  if (panel.viewTabId === null || !panel.preview) return;
  const t = tabs.get(panel.viewTabId);
  if (!t || t.viewMode !== "preview") return;
  const preview = panel.preview;
  // ⚠️ **B273 + B288⑤-1b**：这份预览有规范游标 ⇒ 一律从 `syncV` 派生预览像素。
  //   离屏预览兄弟跟随时只拿到了 `syncV`（没有容器可换算），切回来若直接读陈旧的
  //   `scrollTop`（甚至 null）就会跳。`syncToLineProgrammatic` 返回**实际落点**，
  //   落点写回槽覆盖陈旧值（没落地 ⇒ 落到下面用 scrollTop 的旧路径兜底）。
  //   ⚠️ `applyPanelMode` 先于本函数把预览 `setBlocks` 渲染好，这里一定能算到块几何
  //      （B129 纪律：必须在 applyPanelMode 之后）。
  //   ⚠️⚠️ **1b 不再要求「同步开着」**（同 `restoreViewScroll`）：1a 之后每个标签都有自己的
  //      v，同步关着时 v 就是这份预览自己停的那一行 ⇒ 按它现算像素（宽度无关），
  //      而不是退回几何相关的像素槽（宽度一变就错行）。
  if (t.syncV !== null) {
    // ⚠️ B288 二轮（用户复现：拖标签分屏预览仍复位）：尺子未测（新建视图 / setState
    //    之后到 measure 帧之前，或拖标签把面板摘出渲染树后重挂载的窗口）时，
    //    `syncToLineProgrammatic(v)` 拿不到块几何，会把 v→px 算成 **0**（返回 0 而非
    //    null）—— 不像 `restoreViewScroll` 里 `sourceTopOfV` 返回 null 能自然兜底。
    //    若此刻 `recordScroll(0)` + `return`，会把槽里正确的真值（如 2886）抹成 0，
    //    之后 `rememberViewScroll` 的未测量守卫也救不回（那时容器已 measured、
    //    scrollHeight>0，三判据合取不成立）。与 `restoreViewScroll` 同款纪律：未测量
    //    时跳过游标分支，落到下面「槽支」用 `t.scrollTop` 钉，`pinScrollTop` 逐帧补钉，
    //    等容器撑开后自愈。
    if (!unmeasuredPanels.has(panel)) {
      const landed = preview.syncToLineProgrammatic(t.syncV);
      if (landed !== null) {
        recordScroll(t.tabId, landed);
        preview.clearPendingSync();
        // ⚠️ B288 诊断：按游标还原预览的**落点**。
        logger.trace(
          "viewport",
          `还原 · 预览(游标) tab=${t.tabId} 游标=${t.syncV} 落到=${fmtPx(landed)} 容器=${fmtPx(preview.root?.scrollTop ?? -1)}`,
        );
        return;
      }
    }
    // 未测量（跳过游标）/ landed 为 null（没找到块）⇒ 落到下面用 scrollTop 的旧路径兜底。
  }
  if (t.scrollTop === null) return;
  // 预览那一次 `setBlocks` 刚把内容撑开，同一帧内赋值会被裁成 0（B134），
  // 所以走同一套「钉稳」：写不进去就下一帧再钉。`pinScrollTop` 内部标程序来源，
  // 回执被预览滚动监听经 scroll-guard 吞掉，不会写脏这份快照（B170）。
  // 先取局部变量：闭包里 TS 不保留对 `panel.preview` / `t.scrollTop` 的收窄
  const root = preview.root as HTMLElement;
  const px = t.scrollTop;
  pinScrollTop(root, px);
  // ⚠️ B288 诊断：**这条最能坐实「还原值被容器裁掉」** —— 想钉的是槽里的真值
  //    （比如 2886），若此刻预览内容还没渲染完（容器可滚范围还是 0），浏览器会把它
  //    裁成 0 ⇒ 下面打出来的「容器」就是 0，而「想钉」还是 2886。两者不等即中招。
  logger.trace(
    "viewport",
    `还原 · 预览(槽) tab=${t.tabId} 想钉=${fmtPx(px)} 容器=${fmtPx(root.scrollTop)}`,
  );
  // 位置已按像素钉死，待重定位行号就是过期的了：留着它，下一次图片/公式增强的
  // 二次定位（`applyPending`）会把预览从我们钉的落点拽回那一行（B146）。
  preview.clearPendingSync();
}

/**
 * 切换标签 / 切换源码↔预览之后让 CM6 重新测量，并把视口位置**收回来**（B146）。
 *
 * ⚠️ CM6 在 measure 结束时会做「滚动锚点补偿」（`@codemirror/view` 内部逻辑）：
 * 它拿视口顶行那块的高度和上次记下的锚点比，差超过 1px 就 `scrollTop += diff`，
 * 目的是编辑时内容别乱跳。而 `setState` 换文档后 heightMap 是拿 `HeightOracle`
 * 按**估算行高**建的，measure 一跑换成**实测行高** —— 软换行、中英文混排下实测
 * 普遍比估算高，`diff` 就恒为正 ⇒ 于是「切一次标签，视口再多挪一点」，切十次
 * 偏出好几屏。源码 / 预览（分屏）都中。
 *
 * ⚠️ 不过这只是**次要**成因（B146 二轮修订）：`setState` 末尾那句
 * `if (hadFocus) this.focus(); this.requestMeasure();` 换完文档会自己再滚一次，
 * 才是「位置不断往下移」的主因。真正的修法在 `switchTab` —— 把 `viewTabId` 提前到
 * `setState` 之前、换文档前先 `markProgrammatic(view.scrollDOM)`，那几下自动滚动被监听
 * 经 scroll-guard 认领吞掉、进不了记录（B170，不再靠还原窗口赌时序）。
 * 这一手只是把测量顺带挪走的量收回来，别拿它当主修复。
 *
 * 时序上很难躲开：`requestMeasure()` 排的是**下一帧**的 rAF，而 `pinScrollTop`
 * 第一次就「立住」了、不再补钉，中间没人把关 —— 补偿改完位置就永久生效。
 *
 * 所以在这里补一道：测量（同帧、rAF 队列靠后）跑完再确认一次，位置被挪走了就
 * 钉回来。`pinScrollTop` 的逐帧补钉是第二道保险 —— 补偿若拖到更后面的帧，
 * 它的 `stuck` 判定会认出「值不是我们设的那个」并继续补钉。
 */
export function measureAndKeepScroll(panel: Panel): void {
  if (!panel.view) return;
  panel.view.view.requestMeasure();
  // B271：帧首快照 —— rAF 里用来判「这一帧里**用户接管了编辑器**没有」。
  //   接管 = 位置变了（DOM scrollTop ≠ 帧首）**且**程序标记已被真实输入清除
  //   （scroll-guard 的黏性标记只认用户接管）。这正是 B262「整轮取消」的同一条纪律：
  //   分屏那一帧里用户滚了，随后按旧游标补写/重钉就是把用户刚滚的位置盖回去
  //   （sync-split-copy 回归：应 196 被钉回 287）。
  const dom = panel.view.view.scrollDOM;
  const startPx = dom.scrollTop;
  requestAnimationFrame(() => {
    // B271：CM6 的 measure（rAF 序在前）此刻已完成、heightMap 已是实测行高 ——
    // 估算窗口就此关闭。
    unmeasuredPanels.delete(panel);
    const userTookOver = dom.scrollTop !== startPx && !isProgrammatic(dom);
    if (userTookOver) {
      logger.trace(
        "viewport",
        `panel=${panel.panelId} 这一帧用户接管编辑器（${startPx}→${dom.scrollTop}）⇒ 挂起与重钉全部让路`,
      );
      return;
    }
    // ⚠️ **B288⑤-4：挂起补写与重钉两道已删**，
    //    换成**重还原**一步到位 —— measure 完成后几何是实测的，`restoreViewScroll` 的
    //    v 分支按实测几何把 v 现算成 px 钉回 DOM 并落槽（同一函数、同一条纪律）。
    //    预览面板会被它开头的 `viewMode === "preview"` 闸跳过 —— 预览的重落必须留在
    //    自己那条链路（B279 补落），不许借 CM6 的 measure 帧越俎代庖（④-3 的教训）。
    //    ⚠️ B274 的「离屏兄弟的槽也要跟上」随之瓦解：单轨下落盘只存 v，而 v 由
    //       `applySyncToSibling` 无条件写 ⇒ 离屏兄弟的会话位置永远是最新的，槽（px）
    //       只是 v=null 时的兜底，不再需要跨面板补写。
    restoreViewScroll(panel);
    // ⚠️⚠️ **B288④-3 已撤回（e2e 证明有害，勿再加回来）**：曾在这里补 `restorePreviewScroll(panel)`
    //    让预览「测完按 syncV 重落」。实测（sync-e2e-matrix ③ / sync-e2e-switch-cycle ②③）：
    //    ① 此处 `unmeasuredPanels.delete(panel)`（上面第 1269 行）**已经跑过** ⇒ 它不走
    //       「未测量 ⇒ 跳过游标」那条守卫，而是直接走游标支 `syncToLineProgrammatic(t.syncV)`；
    //    ② 但此刻**预览的块几何还没渲染/测量好**（预览靠 `renderMarkdownFor`→`setBlocks`
    //       自己的那条链路铺开，与本帧 CM6 measure 不是同一拍）⇒ v→px 按未铺开的几何算出
    //       287（= v×源码行高 14，而非 v×块高 42 的 861）；
    //    ③ `syncToLineProgrammatic` 落地即 `recordScroll(287)` **把槽写成错的 287** ⇒
    //       后续步骤（新增/减少分屏、关回单面板）全部从被污染的值派生，连锁红 5 条。
    //    ⇒ 预览的重落**必须留在它自己那条链路**（B279 补落 / `renderMarkdownFor` 之后），
    //      不许借 CM6 的 measure 帧越俎代庖。宽度变化后预览按 v 重落由 ④-2（split move 支）负责。
  });
}

/** 测量后的滚动锚点补偿把位置挪走了 → 钉回标签自己那份快照（B146）。 */
export function reassertViewScroll(panel: Panel): void {
  if (!panel.view || panel.viewTabId === null) return;
  const t = tabs.get(panel.viewTabId);
  if (!t || t.viewMode === "preview") return;
  const px = t.scrollTop;
  if (px === null) return;
  const view = panel.view.view;
  // 没被动过就别碰：钉一次会占用 `pinningContainers`，白白干扰随后可能发生的
  // 「视图消失前看最后一眼」（B145 的读闸口见 `pinInFlight` 会跳过它）。
  if (view.scrollDOM.scrollTop === px) return;
  logger.trace(
    "viewport",
    `锚点补偿挪走了位置 tab=${t.tabId} 实际 ${view.scrollDOM.scrollTop} → 钉回 ${px}`,
  );
  // B170：`pinScrollTop` 标程序来源，回执被监听吞掉，不再罩还原窗口。
  pinScrollTop(view.scrollDOM, px);
}
