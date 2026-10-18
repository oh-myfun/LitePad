/**
 * 同步滚动 v1 —— 运行时接线（T4）。
 *
 * 单一协调器单例 + 一个 reconciler：每次面板/标签/视图模式变化后，把当前**看得见**的
 * 编辑器与预览按各自文档 id 注册进协调器（同 docId 的 editor+preview+其它面板
 * 共享一组锚点）。reconciler 先解绑旧句柄再重注册，是唯一的注册 chokepoint，避免去
 * 改动每处创建/销毁 EditorView / PreviewPane 的站点。
 *
 * ⚠️ 只注册看得见的那一侧。生产里每个面板同时挂着 `.panel-editor` 与 `.md-preview`，
 * 靠 `.panel-host.mode-*` 的 CSS 藏掉其中一个（`src/styles/preview.css:632-640`），
 * 而那个类名由 `tab.viewMode` 决定。被藏起来的那一侧 `getV()` 只能报 1.0、`setV()`
 * 只能挂 pending：注册进去等于引入一个「永远读不准、现形时又补发滚动」的幽灵锚点
 * —— B285 那类「没显示的预览标签与显示的标签位置不一致」就是它。
 * 可见性按**状态**判（与 `applyPanelMode` 同源那条规则），不按 DOM 矩形判，理由写在
 * `reconcileSyncRegistrations` 的注释里。
 *
 * 抑制策略不在本文件：结构性写入由调用方在写完的同一同步栈内经
 * `syncCoordinator.expectSurfaceV(滚动面, 意图 v, 那一写的真实落点)` 登记进账本
 * （见 coordinator.ts）。
 * 本文件**不再**上任何锁——上一版在这里给每个 docId 上结构性锁，那是「猜时间」的一部分，
 * 已由期望账本取代。
 *
 * 依赖方向：本模块只 import core/app-state、doc-model 与同目录 sync-scroll/*
 * （功能模块 → core/*，不反向依赖 main.ts），各功能模块（main / commands / toc /
 * lifecycle）按需 import 本模块。
 */

import {
  docSyncModes,
  panels,
  remotedTabs,
  tabs,
  windowLabel,
  type Panel,
} from "../core/app-state";
import { isMdTab } from "../doc-model";
import { logger } from "../core/logger";
import { sessionStore } from "../session/store";
import type { WindowScrollPosition } from "../core/events";
import { EditorScrollAnchor, type ScrollAnchor } from "./anchor";
import { PreviewScrollAnchor } from "./preview";
import { SyncScrollCoordinator, type AnchorHandle, type CoordinatedSurface } from "./coordinator";

/**
 * 同步滚动这一族日志的统一出口。
 *
 * 前缀里的窗口身份不是装饰：多个窗口共用同一个 `litepad.log`，而 `P1:editor` 这种标签是
 * **每窗口各自**的 panelId —— 真机 14:19:51 那段跨窗口拖出，两份 `重建前快照` 混在一起，
 * 分不清是「同一格被重建两轮」还是「两个窗口各建一轮」，只能靠时间戳猜。
 * `windowLabel` 由 `main.ts:997` 在启动的第一件事就写好（B71 ④），所以除最早那几行外都有。
 */
export function syncTrace(msg: string): void {
  logger.trace("sync", `[${windowLabel}] ${msg}`);
}

/**
 * 应用级协调器单例（B152 按文档开关挂在其上）。
 *
 * 第二个参数是 TRACE 出口：账本每次 `scroll` 的**判定结果**（判成用户滚动 / 吞掉回声 /
 * 补写兑现 / 认账）只有打在真机日志里才能分辨「哪一步没落地」。协调器本身保持零依赖
 * （纯逻辑 + 注入），所以这里注入而不是在 coordinator 里 import 日志模块。
 */
export const syncCoordinator = new SyncScrollCoordinator(undefined, syncTrace);

/** 当前在册的锚点句柄（reconcile 时先全解绑再重注册）。 */
let handles: AnchorHandle[] = [];

function surfaceOf(el: HTMLElement, label: string): CoordinatedSurface {
  return { events: el, label };
}

/** 面板的两侧之一。`viewMode` 只有 source / preview 两档 ⇒ 一格同时只有一侧看得见。 */
export type SyncSide = "editor" | "preview";

/** 「算不算没落进去」的判定容差（源码行）：与协调器账本同一档，只用来决定要不要重试。 */
const LAND_TOLERANCE_V = 0.05;

/**
 * 落位重试上限。真机取证是「挂载帧（裁到顶部）→ 估算帧 → 定局帧」三帧，所以 3 次刚好
 * 走到定局那一帧；上限是为了「布局永远定不下来」（面板被藏着、内容高度恒 0）时能收口。
 */
const LAND_RETRY_LIMIT = 3;

/**
 * **在途落位**：`panelId → 欠它的位置 v`。只活在落位链跑着的那几帧里 —— 链一起就记，
 * 链一结束（落准 / 到上限认现状 / 被新的落位覆盖）就删。
 *
 * 为什么按面板记、而不是按账本那个 DOM 节点记：账本键的是 EventTarget（节点换了就换新账，
 * 那是「回声认像素」要的），而重建这一路**恰恰会换节点** —— 销毁重建之后那一格的新元素
 * 没有账，可它欠的位置还是原来那一个（真机 14:19:51 的第二轮重建就是在这里把位置读成 1.00）。
 */
const owedLanding = new Map<number, number>();

/**
 * 这一格**当前看得见**的是哪一侧。唯一口径：按应用状态判（`isMdTab` + `viewMode`），
 * 与 `applyPanelMode` 写 `mode-*` 类那条规则同源；不按 DOM 矩形判（理由见
 * `reconcileSyncRegistrations` 的注释）。
 */
export function sideOfPanel(panel: Panel): SyncSide {
  const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  const mode = tab && isMdTab(tab) ? tab.viewMode : "source";
  return mode === "preview" ? "preview" : "editor";
}

/**
 * 某一侧的滚动面：一个锚点 + 真正会派发 `scroll` 的那个 DOM 节点。
 * 结构上不管显隐 —— **读**要赶在它还给用户看的时候读，**写**是给刚现形那一侧扶位置。
 */
export function faceOf(
  panel: Panel,
  side: SyncSide,
): { anchor: ScrollAnchor; el: HTMLElement; label: string } | null {
  const label = `P${panel.panelId}:${side}`;
  if (side === "editor") {
    const view = panel.view?.view;
    if (!view) return null;
    return { anchor: new EditorScrollAnchor(view), el: view.scrollDOM, label };
  }
  const preview = panel.preview;
  if (!preview) return null;
  const root = preview.root;
  return {
    anchor: new PreviewScrollAnchor(preview.scrollSurface(), (intent, landed) =>
      // 「没铺开 ⇒ 下一帧补定位」这条异步支线写在协调器调用栈之外，落定后回登记，
      // 否则那一发 `scroll` 无人认领 ⇒ 被判成用户滚动广播出去。
      syncCoordinator.expectSurfaceV(root, intent, landed),
    ),
    el: root,
    label,
  };
}

/**
 * B152 开关的**唯一写点**：持久层那份状态与协调器必须一起翻（只改一边就是上一条的病）。
 * 读走 `core/app-state` 的 `docSyncOn`（缺省开，与协调器 `isOn` 同一口径）。
 */
export function setDocSyncMode(docId: number, on: boolean): void {
  docSyncModes.set(docId, on);
  syncCoordinator.setEnabled(String(docId), on);
}

/**
 * 把 `docSyncModes` 整表推进协调器（引导时调一次，B297）。
 *
 * 会话恢复那一步直接往 map 里写值（`session/rebuild.ts`，那一层不该反过来认识协调器），
 * 而这些值过去没有任何人推给协调器 ⇒「上次关掉的那份文件，重启后又悄悄跟着同步」。
 * 协调器的缺省是开，所以显式记过的每一条都要推。
 */
export function pushDocSyncModes(): void {
  for (const [docId, on] of docSyncModes) syncCoordinator.setEnabled(String(docId), on);
}

/**
 * 本窗口**屏上量得出来**的那些文档的当前位置（B302 · 卫星关窗时交给主窗口落盘）。
 *
 * 卫星窗口自己不写会话（两个窗口同时写就是互相覆盖），它那一格的位置只能靠关窗那一刻
 * 交还。只收量得出位置的那一格：量不出（没挂载 / 在途落位）就干脆不出现在交还清单里，
 * 让主窗口保留它自己那份记忆 —— 而不是拿兜底的 1.00 去覆盖（B299 同一条纪律）。
 */
export function collectWindowPositions(): WindowScrollPosition[] {
  const out: WindowScrollPosition[] = [];
  for (const p of panels.values()) {
    const t = tabs.get(p.viewTabId ?? p.activeTabId);
    if (!t) continue;
    const live = readVisibleV(p);
    if (live === null) continue;
    t.scrollV = live; // 顺手认账：交还的那一份与本地记忆必须是同一个值
    out.push({ docId: t.docId, v: live });
  }
  return out;
}

/**
 * 主窗口：收下某卫星窗口关窗时交还的位置（B302）。
 *
 * 写的是主窗口那份**隐藏实例**的记忆 + 会话记录 —— 隐藏实例没有 DOM，唯一的事实就是
 * 交还回来的这个值。`owner` 对不上的一律不认：同文档可能在三扇窗口里各停一处
 * （每个窗口各存各的），把别人的位置灌进来就是覆盖。
 */
export function applyHandedBackPositions(owner: string, positions: WindowScrollPosition[]): void {
  if (positions.length === 0) return;
  const hits: string[] = [];
  for (const pos of positions) {
    const r = remotedTabs.get(pos.docId);
    if (!r || r.owner !== owner) continue;
    const t = tabs.get(r.tabId);
    if (!t) continue;
    t.scrollV = pos.v;
    sessionStore.setScrollV(t.tabId, pos.v);
    hits.push(`${pos.docId}=${pos.v.toFixed(2)}`);
  }
  syncTrace(`交还位置 owner=${owner} 收到=${positions.length} 命中=${hits.join(",") || "无"}`);
}

/**
 * 收到对端窗口推来的共享坐标（B297）：把这一格**当前看得见**那一侧扶到 `v`。
 *
 * 走 `landVisibleSideAtV` 而不是另写一套远端落位：那条路已经带着这一族全部的纪律 ——
 * 向账本认领（回声回来会被吞掉，不会再推回对端）、没落进去就藏起来按帧重试到收口、
 * 以及在途期间这一格的位置记在账本上而不是 DOM 上。
 *
 * ⚠️ 它**不**经过 `drive` ⇒ 不会触发外发口：收端只落地、不再往外广播，A 推 B、B 推回 A
 * 那种拉锯在源头就不成立（而不是靠对端认 `from` 兜住 —— 那一层也照样有，双保险）。
 *
 * 没在显示的那些实例（旁边那张同文档标签、面板里被 CSS 藏起来那一侧）写不进滚动位置，
 * 所以只**记账**：把 `tab.scrollV` 跟着更新，它现形时（切过来 / 切模式）就落在同一处 ——
 * 已拍板「方案 A · 接班跟随共享 v」的跨窗口版。
 */
export function applySharedVFromRemote(docId: string, v: number, at: number | null = null): void {
  if (!syncCoordinator.isOn(docId)) return; // 这份文档在这窗口关着 ⇒ 一个字都不动
  const id = Number(docId);
  const landed: string[] = [];
  for (const p of panels.values()) {
    const shown = tabs.get(p.viewTabId ?? p.activeTabId);
    if (!shown || shown.docId !== id) continue;
    if (landVisibleSideAtV(p, v, 0, at)) {
      shown.scrollV = v;
      landed.push(`P${p.panelId}:${sideOfPanel(p)}`);
    }
  }
  let memoed = 0;
  for (const t of tabs.values()) {
    if (t.docId !== id) continue;
    const p = panels.get(t.panelId);
    if (p && (p.viewTabId ?? p.activeTabId) === t.tabId) continue; // 正在显示的那张由上面负责
    t.scrollV = v;
    // B302：卫星窗口自己不写会话，它那份位置就记在主窗口这份**隐藏实例**的记录上。
    // 于是「每个窗口各存各的」不必等到关窗才落地 —— 主窗口任何时候落盘都带着它。
    sessionStore.setScrollV(t.tabId, v);
    memoed++;
  }
  syncTrace(
    `远端推 doc=${docId} v=${v.toFixed(2)} ⇒ 落位 ${landed.length ? landed.join(", ") : "（无可见面）"}，记账 ${memoed} 份未显示实例`,
  );
}

/** 这一格当前可见面的共享坐标 `v`；量不到（还没挂载 / 没有该侧 / 那一侧报不出位置）⇒ null。
 *
 * ⚠️ 位置的家是**账本里的在途意图**，DOM 读数只在没有欠账时才作准（B296）：落位链在途的
 * 那两三帧里，DOM 还停在「写入被裁到的那一处」（通常就是顶部 1.00）。谁在这时按 DOM 快照，
 * 谁就把 `tab.scrollV` 写坏成 1.00 —— 真机 14:19:51 跨窗口拖出那一段正是这样：主窗口 16ms 内
 * 被 `rebuildLayout` 两轮，第二轮读到 1.00 ⇒ 新元素被画在顶部、位置塌进会话。
 */
export function readVisibleV(panel: Panel): number | null {
  const face = faceOf(panel, sideOfPanel(panel));
  if (!face) return null;
  const owed = owedLanding.get(panel.panelId);
  if (owed !== undefined) {
    // 把 DOM 那个「假读数」也打出来：取证时要能看出「认账本认对了」，而不是怀疑账本。
    syncTrace(
      `读可见侧[${face.label}] v=${owed.toFixed(2)}（认在途落位，DOM 还在 ${face.anchor.getV().toFixed(2)}）`,
    );
    return owed;
  }
  const v = face.anchor.getV();
  if (face.anchor.hasPosition?.() === false) {
    // 量不出来的面没有发言权（B299）：这里报 null，调用方回落到标签自己的记忆，
    // 而不是把那个兜底的 1.0 当成「现在就停在顶部」。
    syncTrace(`读可见侧[${face.label}] 量不出位置（兜底读数 ${v.toFixed(2)}）⇒ 交回记忆`);
    return null;
  }
  syncTrace(`读可见侧[${face.label}] v=${v.toFixed(2)}`);
  return v;
}

/**
 * 「这一格现在就停在这儿，而那是**我**造成的」——结构性写入之后就地认领当前位置。
 *
 * 用在协调器之外那些会改内容高度、却没打算移动视口的写入：远端正文增量 / 整段纠错
 * （浏览器会按新的 `scrollHeight` 裁掉 `scrollTop`）、文件重载后的 `setState`。
 * 不认领，那一发裁剪就被协调器当作用户滚动广播给同文档的其它视口 ⇒ 本窗口对栏跟着跳。
 *
 * 认领的是**看得见那一侧**：隐藏侧此刻恒 0，按它认领等于把「现形后被扶到的那一发」
 * 提前吞掉。量不到（还没挂载）⇒ null。
 */
export function claimVisibleHere(panel: Panel): number | null {
  const face = faceOf(panel, sideOfPanel(panel));
  if (!face) return null;
  const here = face.anchor.getV();
  syncCoordinator.expectSurfaceV(face.el, here, here);
  syncTrace(`认领[${face.label}] here=${here.toFixed(2)}`);
  return here;
}

/**
 * 把这一格**当前看得见**那一侧扶到共享坐标 `v`，并向账本认领这一写（意图 + 真实落点）。
 *
 * 谁需要它：一切「让这一格换了一侧显示」的操作 —— 同格 source↔preview 切换
 * （`markdown.ts:toggleViewMode`）、布局销毁重建后重新挂载（`rebuildLayout` → `mountView`）。
 * 被 `display:none` 藏起来的一侧现形时持有的是残值：预览被归零（弹回文档开头），源码被
 * `focus()` 滚到**光标**那一行 —— 都不是用户切走之前看到的那一行。写完不认领，这一发还会
 * 被协调器当作用户滚动广播给同文档的其它视口，把别处一起拽走。
 *
 * 布局还没定局时这一写可能进不去（或只按估算行高进去一截）：本函数自己按帧重试到收口，
 * 并在收口之前把那一侧藏着不画（B294 + B295，细则见函数体）。`attempt` 就是这条重试链的
 * 内部序号，调用方一律省略。
 */
export function landVisibleSideAtV(
  panel: Panel,
  v: number,
  attempt = 0,
  at: number | null = null,
): boolean {
  const face = faceOf(panel, sideOfPanel(panel));
  // 链条的**续跑**只在一个前提下才合法：这一格此刻欠的还是我这一个 v。
  // 期间若有更晚的一笔接管了这格（用户又切了一次、面板被重建、或对端窗口推来新的 v ——
  // B297），旧链必须闭嘴：两条链各写各的意图，谁都收不了口。真机 14:19:51 正是这一形状
  //（第二轮重建把新元素扶回顶部，而第一轮的链还在往 17.33 写，位置靠运气才被救回来）。
  const owed = owedLanding.get(panel.panelId);
  if (attempt > 0 && owed !== v) {
    syncTrace(
      `落位链让位 意图=${v.toFixed(2)} 这一格现在欠=${owed === undefined ? "（没人欠）" : owed.toFixed(2)}`,
    );
    return false;
  }
  // 这一条是「静默空操作」唯一的可见证据：找不到面（还没挂载 / 这一格没有该侧）时
  // 位置恢复整个没发生，而调用方拿到的只有一个 false —— 不打日志就只能看到「位置最终不对」，
  // 看不出是**没人写过**。
  if (!face) {
    syncTrace(`落位跳过[P${panel.panelId}:${sideOfPanel(panel)}] 意图=${v.toFixed(2)} 无滚动面`);
    return false;
  }
  // `at` 是顶边那一视觉行的行首字符位置（B300 · 逐行对齐）：这一格宽度与对端不同时，
  // 同一个 `v` 对应的不是同一行文字（真机对照：同一 `v=6.83`，主窗口 376px、新窗口 280px）。
  // 面能按字符对齐就按字符对齐，**意图登记成它自己读回的 v**：两格算出的 v 本来就不等，
  // 登记成对方的那个就会被判成「没兑现」而补写回去 —— 逐行对齐会被自己拆掉（B290 那一族
  // 换了个方向复发）。只有 `v`（老对端 / 预览面）时走原来的按比例落位。
  const byPos = at !== null && !!face.anchor.setVAt;
  const landed = byPos ? face.anchor.setVAt!(at!) : face.anchor.setV(v);
  syncCoordinator.expectSurfaceV(face.el, byPos ? landed : v, landed);
  // 「量不量得出来」决定这一发是**落定**还是**承诺**（B299 · 真机 sat-3）：预览那条
  // 「块还没铺开 ⇒ 只排下一帧」的异步支线原样返回入参当落点（`登记 意图=6.84 落点=6.84
  // 落点px=0.00`），可那一发补定位随后会被还不敷高的容器裁回 0 —— 而像素没变就不派发
  // `scroll`，账本的补写兑现一次都不触发（正是 B294 那一族的病）。承诺被消费掉、位置静默
  // 丢在顶部，而这笔欠账谁都没记 ⇒ 下一发重建按 DOM 读到 1.00，连 `tab.scrollV` 一起写坏。
  // 所以：**只是承诺就不算收口**，欠账记下、链自己续跑。
  const measurable = face.anchor.hasPosition?.() !== false;
  const settled =
    measurable &&
    (byPos ? face.anchor.topPos?.() === at : Math.abs(landed - v) <= LAND_TOLERANCE_V);
  // B294：**没落进去就自己重试** —— 账本的补写兑现救不了这一发。真机 07:59:35 的重建路径：
  // 编辑器刚 `new` 出来还没有布局 ⇒ 写入被裁到 0 ⇒ `登记 意图=30.33 落点=1.00 落点px=0.00`。
  // 而**像素没变就不派发 `scroll`** ⇒ 回声永远不会来 ⇒ 靠回声驱动的补写兑现一次都不触发
  // ⇒ 位置静默丢在文档顶部（用户报的「复制标签 / 拖标签后位置跳变」）；共享值塌成 1.00 之后，
  // 还会把旁边本来记对了的标签一起拽上顶（同一条日志里 `tab=6 记忆=30.33 跟随共享=1.00`）。
  //
  // ⚠️ 链条的**起点**刻意收成「完全没进去」这一种形状（塌到文档第一行 + 像素读回 0），不是泛泛的
  // 「读回≠意图」：部分落位（意图 800、读回 500 这类）本来就不该被推翻 —— 第一版写的就是
  // 「不等就重试」，被 `tests/multi-instance-preview.test.ts` 当场抓住（它把 500 改成了 800）。
  // 起点之后（`attempt > 0`）才按「收口了没有」续跑：见下面 B295。
  const stuckAtTop =
    face.el.scrollTop === 0 && landed <= 1 + LAND_TOLERANCE_V && v > 1 + LAND_TOLERANCE_V;
  const retry =
    (stuckAtTop || !measurable || (attempt > 0 && !settled)) && attempt < LAND_RETRY_LIMIT;
  // B295：**位置还没收口，就别把中间态画出来**（用户报的「对齐前会闪动」）。
  // 真机 08:14:45 的重建路径三帧各有绘制机会：`0px`（顶部）→ `410.67px`（按估算行高的软折行
  // 落位，差 200px）→ `608px`（量完行高才是对的）。每一帧都是用户看见的一次跳动。
  //
  // 做法：链条在途时把这一侧的滚动面 `visibility:hidden` —— 它仍然参与布局，所以像素照样能写、
  // `scroll` 照样派发、CM6 照样量行高（换成 `display:none` 就全塌了，那正是隐藏侧落不进位的成因）；
  // 收口（或到上限认现状）时**在写下这一位的同一个同步栈里**取消隐藏 —— 藏/露之间没有绘制机会，
  // 于是露出来的第一帧就是收口后的位置。同一个手法已用在悬浮查找上
  // （`src/shell/tooltip.ts:377` 「用 visibility 挡住这一帧的 (0,0) 位置；同一帧内就摆好，不会闪」）。
  // 判据只有「读回的 v 等不等得到意图」：不猜时间、不数帧。
  if (retry) {
    // B296：链在途 ⇒ 这一格的位置记在「欠它的那一个 v」上，谁都不许在这几帧里按 DOM 快照
    // （`owedLanding` 的注释里有真机那一段的形状）。
    owedLanding.set(panel.panelId, v);
    face.el.style.visibility = "hidden";
    syncTrace(
      `落位未收口·先藏起来重试#${attempt + 1} 意图=${v.toFixed(2)} 读回=${landed.toFixed(2)} px=${face.el.scrollTop.toFixed(2)}`,
    );
    requestAnimationFrame(() => landVisibleSideAtV(panel, v, attempt + 1, at));
  } else {
    // 链到此为止（落准 / 到上限认现状 / 这一发本来就是好位）⇒ 位置交还给 DOM 读数。
    // 新的落位写下去也要先清掉上一轮的欠账：否则「用户已经滚到别处」会被在途值一直盖着。
    owedLanding.delete(panel.panelId);
    if (face.el.style.visibility === "hidden") {
      // 收口，或到上限认现状：同栈露出来。别留「内容一直是藏的」这种死角 ——
      // 另一条路径（切标签）落准了但上一轮的链条把它藏着，也得在这里取消隐藏。
      face.el.style.visibility = "";
      syncTrace(`落位收口·露出 意图=${v.toFixed(2)} 读回=${landed.toFixed(2)}`);
    }
  }
  return true;
}

/**
 * 各文档**此刻**的共享位置（B293 · 方案 A 的跨重建版）。key = `String(docId)`。
 *
 * 为什么需要它：`switchTab` 里那条「接班标签跟随当前共享 v」（B292 方案 A）只覆盖
 * 「面板已经挂着 EditorView、只是换一份文档」的路；而**布局销毁重建**那一路
 * （`rebuildLayout` → `mountView`：拖标签跨面板、同源复制一张、把正在显示的标签关掉的接班）
 * 落位用的是那张标签自己记的 `scrollV`。同一文档的第二张、第三张在被显示之前**从不注册**进
 * 协调器（B285 幽灵锚点的取舍），同步走过的这一段它一个字都没收到 ⇒ 记的是缺省 1 或上一次
 * 显示时的陈值。真机取证（台子 scrollVOf + currentV）：
 *   复制一张 → 新出现的那张 `ed=1.00`，而 `currentV(X)` 跟着变成 1（它成了该文档第一个在册视口）
 *   → 切回原来那张也被落到 1.00 ⇒ **整份文档被拽到顶部**。
 *
 * ⚠️ 必须在**任何 view 销毁之前**调：`currentV` 读的是在册锚点，view 一销毁那些锚点只会
 * 报 0/1.0，之后再取就等于把整份文档钉回顶部（这正是本条要修的病）。
 * 同步关着的文档、一个视口都不在册的文档 ⇒ 该文档没有条目 ⇒ 调用方回落到标签自己的记忆。
 */
export function sharedVByDoc(): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of panels.values()) {
    const tab = tabs.get(p.viewTabId ?? p.activeTabId);
    if (!tab) continue;
    const key = String(tab.docId);
    if (out.has(key)) continue;
    // B303：这一路下面那道 `currentV` 自带的闸挡不住在途落位那一条 —— 链在途时 DOM 还没落成，
    // `currentV` 报不上数，位置却实在 `owedLanding` 里。关着同步的文档于是照样能把这一格的
    // 位置发给接班那一张（真机 22:37：关着同步、同文档四格全停 24.95）。闸提到读位置之前。
    if (!syncCoordinator.isOn(key)) continue;
    // 同 `readVisibleV`：这一格有在途落位时，那个 v 才是该文档此刻的位置；`currentV` 走的是
    // 在册锚点 = DOM 读数，链在途时它报的是「还没落成的投影」（真机 14:19:51 的 1.00）。
    const v = owedLanding.get(p.panelId) ?? syncCoordinator.currentV(key);
    if (v !== null && v !== undefined) out.set(key, v);
  }
  return out;
}

/**
 * 解绑旧锚点、按当前可见视口重注册。应在以下时机调用：面板挂载（mountView）、
 * 切换标签（switchTab，docId 会变）、视图模式切换、分屏/关闭、文件打开/会话恢复。
 *
 * ⚠️ 「这一格看得见吗」按**应用状态**判（`isMdTab` + `viewMode`，与 `applyPanelMode`
 * 写 `mode-*` 类那条规则同源），不按 DOM 矩形判。两个原因：
 *   1. 状态才是显隐的**因**，CSS 只是它的果——按果判会随样式表改动而漂。
 *   2. 按矩形判在单测环境里恒为「不可见」（jsdom 无布局，`getClientRects()` 恒空），
 *      于是协调器在测试里一个锚点都不注册，同步相关用例会集体空转绿灯。
 * 取标签用 `viewTabId ?? activeTabId`（这一格 EditorView 当前挂着的那张），比
 * `applyPanelMode` 的 `activeTabId` 更贴「实际显示的是谁」；两者在所有写点上是一起赋的
 * （`switchTab` / `mountView` / `splitActivePanel` / 重载），所以显隐与内容不会错档。
 * 被藏起来的那一侧不注册：它的 `getV()` 只能报 1.0、`setV()` 只能挂 pending，
 * 注册进去等于引入一个「永远读不准、现形时又补发滚动」的幽灵锚点（B285 那一族）。
 */
export function reconcileSyncRegistrations(): void {
  for (const h of handles) syncCoordinator.unregister(h);
  handles = [];
  const registered: string[] = [];
  for (const p of panels.values()) {
    const tab = tabs.get(p.viewTabId ?? p.activeTabId);
    if (!tab) continue;
    const docId = String(tab.docId);
    // 走 `faceOf` 而不是在这里自己 new 锚点：预览锚点那条「未铺开 ⇒ 下一帧补定位」的异步
    // 支线需要回登记口，两处必须用同一个构造方式，否则注册出来的锚点没有这个口。
    const face = faceOf(p, sideOfPanel(p));
    if (!face) continue;
    handles.push(syncCoordinator.register(face.anchor, docId, surfaceOf(face.el, face.label)));
    registered.push(`${face.label}/doc${docId}`);
  }
  // 「对栏怎么没跟着动」的第一现场：这一格到底在册没有。
  syncTrace(`reconcile 在册=${registered.length ? registered.join(", ") : "（空）"}`);
}
