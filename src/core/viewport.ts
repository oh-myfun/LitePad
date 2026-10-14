// 视口位置原语（唯一闸口 + 钉稳）（从 main.ts 拆出的可复用核心模块）。
//
// 拆出来的理由：这几块是**别的模块都要用的公共底座**，留在 main.ts 里就等于
// 逼着每个功能模块反过来 import main.ts（hub 型耦合 + 循环依赖）。
// 归到 core/ 之后，功能模块只依赖 core/*，各自可单独单测。

import { Panel, Tab, tabs } from "./app-state";
import { activePanel } from "./panels";
import { logger } from "./logger";
import { sessionStore } from "../session/store";
import { isProgrammatic, markProgrammatic } from "./scroll-guard";

/**
 * 标签当前的视口滚动位置（B126 + B129）。
 *
 * 正显示在面板上的实例要取视图的**实时值**（用户刚滚过但还没切走，快照还没更新）；
 * 离屏实例只能取上次记下的快照。
 *
 * 纯预览态取**预览那一侧**（B129）：编辑器是 `display:none`，它的 scrollTop 被
 * 浏览器清零，记下来只会把「视图位置」写成 0 —— 于是重启后预览每次都弹回开头。
 */
export function viewportOfTab(t: Tab): number | null {
  // 快照就是 `Tab.scrollTop` 这一处全局记录（B139）：按 tabId 索引、与视图生命周期
  // 解耦，**绝不回头读容器**。读容器等于把「谁最后摆过它」混进来 —— 预览容器是
  // 面板级的、所有标签共用，编辑器里摆的还可能是刚被清零的 0。
  return t.scrollTop;
}

/**
 * 正在重试「钉稳」的容器（B145）。
 *
 * 位置还没立住的容器是不可信的：里面的值随时会被下一次补钉改写。所以别的模块
 * （`rememberViewScroll`）看见这个集合里有它就别采 —— 采一份半路的中间值，等于把
 * 一个还没生效的落点当成用户停过的位置。
 */
export const pinningContainers = new WeakSet<HTMLElement>();

export function pinInFlight(el: HTMLElement): boolean {
  return pinningContainers.has(el);
}

/**
 * 同一容器「最新一条补钉链」的令牌（B172）。
 *
 * 同步滚动时源每派发一次 scroll 就调一次 `pinScrollTop`，而一条链要跑到
 * `PIN_MAX_FRAMES`（12 帧）才收工 —— 连续滚动下十几条链会**同时**往同一个 `scrollTop`
 * 上钉不同的 px：这一帧钉 100、下一帧被上一条链拉回 200、再下一帧又被更新的那条拉回
 * 300 ⇒ 目标那份来回拉锯，正是「同步滚动抖动」。典型触发是**滚的不是激活文档**（源在
 * 非激活面板上连续滚，激活那份被反复钉）。
 *
 * 新链一起来，旧链就此作废：只有最新那条有资格写值。
 */
export const pinTokens = new WeakMap<HTMLElement, number>();

/**
 * 视口调试日志（B146）。
 *
 * 用户报「切换标签时 md 文档的滚动位置会不断往下移」，而位置只在 DOM 上、写进记录的
 * 路径有好几条（切标签、滚动采样、刷新会话、预览二次定位…）。想知道**哪一步**把手
 * 放歪了，就得在每一步都留一条：快照值 / 编辑器实际值 / 预览实际值 / 视图模式。
 *
 * 默认级别是 info，这一条打开看不到 —— 要看就把设置里的日志级别调到 debug（或 trace）。
 * 别为了「always on」把它提到 info：滚动采样一秒能打几十条，会把 2MB 的日志冲掉。
 */
export function logViewport(where: string, panel?: Panel): void {
  const p = panel ?? activePanel();
  if (!p) return;
  const view = p.view?.view;
  const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
  const mode = t?.viewMode ?? "-";
  const root = p.preview?.root;
  const shown = mode === "preview" ? root?.scrollTop : view?.scrollDOM.scrollTop;
  logger.debug(
    "viewport",
    `${where} tab=${t?.tabId ?? "-"} 模式=${mode} 快照=${t?.scrollTop ?? "null"} 视图=${shown ?? "-"}`,
  );
}

/**
 * B280：**还原几何**诊断（debug）。
 *
 * 「切回去位置不对 / 渲染不完整」这类症状只有把**当时的几何**打全才定位得了：容器高 /
 * 内容高 / 实际渲染行数 / 可滚范围 / 留白，外加「想钉 vs 落下」。默认 info 看不到，
 * 排查时把设置里的日志级别调到 debug（或 trace）再按 tabId 过滤。
 * ⚠️ 别提到 info：滚动采样一秒几十条，会把 2MB 的日志冲掉（同 `logViewport` 的纪律）。
 */
export function logViewportGeom(where: string, panel?: Panel): void {
  const p = panel ?? activePanel();
  const view = p?.view?.view;
  if (!p || !view) {
    logger.debug("viewport", `${where} 无视图（面板未挂载）`);
    return;
  }
  const el = view.scrollDOM;
  logger.debug(
    "viewport",
    `${where} tab=${p.viewTabId ?? "-"} clientH=${el.clientHeight} contentH=${fmtPx(view.contentHeight)} ` +
      `渲染行=${el.querySelectorAll(".cm-line").length} scrollH=${fmtPx(el.scrollHeight)} ` +
      `scrollTop=${fmtPx(el.scrollTop)}`,
  );
}

/**
 * 写标签的滚动位置到会话记录 —— **唯一闸口**（B145）。
 *
 * ⚠️ B170：还原期不再靠「`restoringViewports` 两帧窗口」在出口拦（那是赌时序的时间窗，
 * 异步重排会把回执拖出去、漏判成用户滚动）。现在程序摆位（`pinScrollTop` / 预览钉位 /
 * `host.scrollToLine`）都先 `markProgrammatic`，目标滚动监听**见标记即吞**，根本不会走到
 * 这个出口 —— 守卫从「时间窗」上移到了「来源标记」上，且对迟到回执免疫。
 */
export function recordScroll(tabId: number, px: number | null): void {
  // `t.scrollTop` 与记录是同一份东西（`viewportOfTab` 只读它），一并写过去别让两边分叉；
  // `null` 表示「这份实例从没显示过」，是有意义的空值，不往活动态里倒灌。
  const t = tabs.get(tabId);
  if (px !== null && t) t.scrollTop = px;
  // 记录被写进去的那一条（trace）：滚一下就有几十条，所以级别压到 trace 而不是 debug。
  // 「哪一步把手放歪了」要看的就是这一串 —— 相邻两条之间差了多少，就是那一步改的量。
  logger.trace("viewport", `写入位置 tab=${tabId} px=${px}`);
  sessionStore.setScroll(tabId, px);
  // B288④-4：规范视口游标 `syncV` 一并落盘（canonical v 是宽度无关的唯一真值；换宽度/
  // 重启都按当前几何反算）。同步关着/还没同步过 ⇒ `syncV` 为 null ⇒ 落盘 null ⇒ 恢复时
  // 回退 `scrollTop`（兼容旧会话与未同步实例）。这是写滚动位置的唯一闸口，顺手记上 v。
  if (t) sessionStore.setSyncV(tabId, t.syncV);
}

/**
 * 把标签快照里的滚动位置还给视图（B126）。
 *
 * 必须在 setState / 新建视图**之后**调：先有对的内容，滚动位置才有意义（浏览器
 * 会按新内容长度自动裁剪）。
 *
 * `scrollTop === null`（这份实例从没显示过）时退化为「保证光标可见」——
 * 会话恢复只带了 cursorLine/cursorCol，没有视口信息，硬钉 0 会让光标停在屏幕外。
 */
/**
 * 把滚动位置**钉稳**（B134）。
 *
 * 赋值那一刻容器往往还没布局完（编辑器刚从 `display:none` 出来、预览刚 `setBlocks`），
 * 浏览器按规范会把超出可滚动范围的赋值**裁掉** —— 内容高度还没撑开时裁成 0，
 * 位置就等于没设。更糟的是这次赋值会派发 scroll 事件，把「0」写回标签快照，
 * 于是下一次保存下来的也是 0（B134：重启后每次都回到顶部）。
 *
 * 所以：先按老办法写；写进去的值没被裁（读回来对得上）就收工，被裁了就**逐帧补钉**，
 * 一直补到立住为止。
 *
 * ⚠️ 只补一帧是不够的（B145）：窗口刚打开时布局可能连着好几帧都没稳 —— 窗口还没
 * 显示、大文件刚把内容撑开、预览的一次 setBlocks 还没落地。差那么一帧，位置就永久
 * 停在被裁掉的 0 上，然后被落盘、被下次启动读回来（用户报的「打开恢复位置时落盘成
 * 0」）。所以这里一直重试到立住，中途的值一个都不信。
 */
export const PIN_MAX_FRAMES = 12;

/**
 * 判定「立住」的位置容差（px）。
 *
 * ⚠️ 必须留容差：浏览器 `scrollTop` 是 **double**，缩放不是 100% 时（125% / 150%）
 * 它天然带小数 —— 「钉上去的目标值」与「读回来的落点」差零点几 px 是**正常结果**
 * （B143 那条线索就是从这类小数开始的）。拿精确相等判「钉上了没」，小数永远对不上，
 * 结果就是每次补钉都一路重试到 `PIN_MAX_FRAMES`、甩一条「没立住」出来（满屏都是
 * 这条 WARN，真出问题时反而看不见）。只有差距**明显**才算钉不进去。
 */
export const PIN_EPSILON_PX = 1;

/** 落点打印：493.3333435058594 这种没必要整串塞进日志。 */
export function fmtPx(v: number): string {
  return v.toFixed(2);
}

export function pinScrollTop(el: HTMLElement, px: number): void {
  // B172：领一个新令牌，把还在飞的那条链作废（注释见 `pinTokens`）。
  const token = (pinTokens.get(el) ?? 0) + 1;
  pinTokens.set(el, token);
  pinningContainers.add(el);
  // B170：整段「逐帧补钉」期间都标程序来源 —— 赋值派发的 scroll 由监听经 scroll-guard
  // 直接吞掉（不写快照、不推兄弟），不再靠 `viewportWriteDepth` 那种时间窗赌时序。
  // 标记是**黏性的**：钉完之后一直留在容器上，直到用户真正接管滚动（wheel/键/触/拖条）
  // 才清 —— 这样「钉完那一刻」与「几百 ms 后迟到回执」都被认成自家回执，闭环拉锯根除。
  const retry = (frame: number): void => {
    // B172：已被更新的调用取代 ⇒ 这一条作废，一个字节都不许再写。
    // ⚠️ 别在这里 `pinningContainers.delete` —— 接手的新链还在跑，删了会让
    //    `pinInFlight` 误判「没人在钉」，把半路那个中间值采进快照（B145 的读闸口）。
    if (pinTokens.get(el) !== token) return;
    // ⚠️⚠️ **B276：用户接管滚动 ⇒ 整轮补钉作废**（与 B262「整轮取消」同一条纪律）。
    //    补钉每帧都 `markProgrammatic` 并 `el.scrollTop = px`：用户在补钉窗口里滚一下，
    //    ①那一发 scroll 因黏性标记被**吞掉**（不写快照、**不推兄弟**）；②下一帧补钉又把
    //    位置顶回 px ⇒「我滚了但另一格不动、位置还弹回去」。
    //    真机 trace（04:34:45）：切标签后用户把源码从 2352 滚到 1796.67，全程**没有一条
    //    推播**，两个预览都停在旧游标 v95 —— 用户报的「同步还是有问题」就是这一处。
    //    判据与 measure 那条同款：帧首是我们标的、此刻标记没了 ⇒ 真实输入清过它。
    if (frame > 0 && !isProgrammatic(el)) {
      pinningContainers.delete(el);
      return;
    }
    // 每次赋值前都标：重试途中（被浏览器裁成 0 后下一帧再钉）每一发都被认领。
    markProgrammatic(el);
    el.scrollTop = px;
    const landed = el.scrollTop;
    const diff = landed - px;
    // 落在容差内（含缩放小数 / 轻微反超）⇒ 钉稳，收工。
    const withinTol = Math.abs(diff) <= PIN_EPSILON_PX;
    if (withinTol) {
      // B139/B145：钉稳的这下发已经被标记吞掉，无需再记「白名单」；只退出补钉循环。
      // 标记仍留在容器上（黏性），等用户接管才清。
      pinningContainers.delete(el);
      return;
    }
    // ⚠️⚠️ **B278（修用户报的回退）**：「向下裁切」（`landed < px`，落点被浏览器裁到更靠上的
    //   可滚上限）**不再**当场当「立住」停重试 —— 两类情况都会表现为向下裁切：
    //   ① 文档真·短、`px` 本就超出可滚上限 —— 合法落点（停在 maxScroll），无可奈何；
    //   ② **`scrollHeight` 还没撑开**（内容未渲染 / 分屏新建实例 measure 未完成的临时窗口）
    //      —— 几帧内会涨回来，涨回后这一票本应能落定。
    //   ⇒ 向下裁切一律**继续重试到窗口末**；只有「落点仍在容差外且 `landed<=0`（面板 0 宽 /
    //   内容始终没撑开，真·坏掉）」才告警，落点在某个合法 maxScroll（`landed>0`）的短文档场景
    //   静默收工（那本来就是正确落点，不该刷 WARN）。
    if (frame + 1 >= PIN_MAX_FRAMES) {
      pinningContainers.delete(el);
      if (landed <= 0) {
        // 尺寸早就有、却始终钉不进去 ⇒ 真出问题了（面板还是 0 宽、内容始终没撑开）。
        // 留一条：这正是「重启后位置回到顶部」那类症状要看的东西。
        logger.warn(
          "viewport",
          `pin ${px} 没立住（${frame + 1} 帧后 scrollTop=${fmtPx(landed)}，差 ${fmtPx(diff)}px）`,
        );
      }
      return;
    }
    logger.trace("viewport", `pin ${px} 被裁（第 ${frame + 1} 帧，scrollTop=${fmtPx(landed)}）`);
    requestAnimationFrame(() => retry(frame + 1));
  };
  retry(0);
}
