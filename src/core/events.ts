// 跨窗口事件名与载荷（从 main.ts 拆出的可复用核心模块）。
//
// 拆出来的理由：这几块是**别的模块都要用的公共底座**，留在 main.ts 里就等于
// 逼着每个功能模块反过来 import main.ts（hub 型耦合 + 循环依赖）。
// 归到 core/ 之后，功能模块只依赖 core/*，各自可单独单测。

// 只取类型（`api.ts` 不 import 本文件，这条依赖不会成环）：载荷里的 RecentEntry 与 IPC
// 回包是同一个形状，复制一份字段表迟早跟 Rust 那边错开。
import type { RecentEntry } from "../ipc/api";

/**
 * 同一文档同时挂在两个窗口上时，正文必须双向实时同步。
 *
 * 什么情况下会同时挂两个窗口：
 *   · 一个窗口把标签拖出去，又在原窗口重新打开了同一个文件（本地会先取回隐藏实例）；
 *   · 两个窗口各用「打开文件」打开了同一个路径（Rust 侧是同一条文档记录）。
 * 这时如果不同步，两边各编各的，最后谁按保存谁赢 —— 另一边的编辑无声消失。
 *
 * 只传变更集，不传全文：CM6 的 ChangeSet 本身就是可 JSON 化的位置增量，几百字节，
 * 每次按键发一份也不心疼；传全文在几十 MB 的文件上会把 IPC 打爆。
 *
 * 三层保护，缺一不可：
 *   1. 发送侧 `applyingRemote` —— 正在套用远端变更时产生的 update 不再广播，
 *      否则 A 改 → B 广播 → A 广播 …… 无穷弹；
 *   2. 接收侧复用 `syncingDocId` —— 让 handleUpdate 不把远端变更当用户编辑，
 *      否则两个窗口会各排一份自动保存与热退出副本，对着同一个文件写盘打架；
 *   3. 基准校验 —— 变更集自带 baseLen，对端长度对不上说明两边**已经分叉**
 *      （对端从磁盘重载过、或中间丢过一次事件）。此时硬套位置增量就会在错误的
 *      位置插入文本，属于静默改坏用户内容，绝不接受 → 转为要一份全文（见下）。
 */
export interface DocChangePayload {
  from?: string;
  docId?: number;
  /** 变更前的文档长度（两个窗口必须一致，否则视为分叉） */
  baseLen?: number;
  changes?: unknown;
}

/** 事件名三兄弟：常规变更、分叉纠错请求、分叉纠错应答。 */
export const EVT_DOC_CHANGE = "doc-change";

export const EVT_DOC_RESYNC_REQ = "doc-resync-request";

export const EVT_DOC_RESYNC_FULL = "doc-resync-full";

/**
 * B161：关标签之前先问一圈「这份文档还有没有人拿着」。
 *
 * Rust 侧的文档是**进程级**的（`state.docs` 一份），而标签是每个窗口各持一份 ——
 * 本窗口这是最后一个实例，不等于别的窗口没有：主窗口那份**隐藏实例**（借给卫星
 * 窗口的副本）、另一个卫星窗口的可见标签，都算「有人拿着」。直接 `close_tab` 会把
 * 别人手上那份一起废掉（保存时报「文档不存在」）—— 用户看到的正是「在子窗口关一个
 * 文件，主窗口同文件的标签也被关了」。
 *
 * 所以关之前广播一次 `doc-close-query`；还在拿着的窗口回一条 `doc-close-held`，
 * 发起方等一小会儿，有人应答就只摘本地、不动 Rust 那一侧。
 *
 * ⚠️ `from` 同样是自证字段：tauri 的广播本机也会收到自己的回声（与上面几条同口径）。
 */
export const EVT_DOC_CLOSE_QUERY = "doc-close-query";

export const EVT_DOC_CLOSE_HELD = "doc-close-held";

export interface DocClosePayload {
  from?: string;
  docId?: number;
}

export const EVT_APP_QUIT = "app-quit";

/**
 * B178：跨窗口「这份文档在别的窗口还开着（且可见）吗」的存在性登记。
 *
 * `visibleInstancesOfDoc` 只数**本窗口**的可见实例，于是「主窗口开一份 X、卫星窗口也
 * 开一份 X」时两边各自只数到 1，同步键都不露脸 —— 用户要的是「只要同一个文件跨窗口
 * 开了 ≥2 份，两个窗口都要有这颗键，且点亮态一致」（开关状态随卫星标签载荷一起搬运，
 * 这里只补**可见性**）。
 *
 * 做法：每个窗口广播自己「有 ≥1 个可见实例的 docId 集合」，对端按 `from`（窗口标签）
 * 记进 `remoteOpenByWindow`。按钮显隐的「多份」判据 = 本窗口可见实例数 +
 * （任一远端窗口也开着就算 1）。窗口干净关掉就从对应 `from` 条目整条删掉，清得干净。
 *
 * ⚠️ 只数**可见**实例（`panelId >= 0`）—— 与 B173 同口径：搬到别的窗口后在本地的那份
 *    隐藏实例（`panelId < 0`）不广播，否则会出现「主窗口只开了一份却因为卫星的隐藏
 *    副本而露脸」的错位（B171 已否掉这种口径）。
 */
export const EVT_DOC_OPEN = "doc-open";

export const EVT_DOC_CLOSE_NOTIFY = "doc-close-notify";

/**
 * 新窗口上线时问一圈「你们都开着哪些可见文档」—— 对端把当前可见集合重播一遍，
 * 上线方据此补齐自己的 `remoteOpenByWindow`（否则它只知道自己开的，收不到老窗口
 * 已经开着的那些）。只发一次（引导末尾），不进刷新循环，不会形成回声环。
 */
export const EVT_DOC_OPEN_RESYNC = "doc-open-resync";

/** 卫星窗口干净关窗时通知对端「本窗口没了」，对端清掉它那一条。 */
export const EVT_WINDOW_CLOSED = "window-closed";

export interface DocPresencePayload {
  from?: string;
  docId?: number;
}

/**
 * B297（2026-10-18）：跨窗口同步滚动 —— 这两个事件在 `7a8290a` 那一轮整体清除里被删掉，
 * 现在按**期望账本**的口径重新接上：只有账本判成「用户滚的 / 主动跳」那一发才外发，
 * 收到的那一端走本窗口同一条落位纪律（认领 + 没落进去就藏起重试），所以不会形成回声环。
 *
 * `sync-pos` 只带共享坐标 `v`（源码行号 + 小数），**不带像素**：每个窗口、每一侧、每档
 * 宽度都在自己的边缘换算，像素是各自的事（同一份文档两个窗口的「到底」本来就是两个像素）。
 * `docId` 用数字与 `doc-change` 同口径；协调器内部按 `String(docId)` 记，转换在两端各自做。
 */
export const EVT_SYNC_POS = "sync-pos";

/** B152 的开关是**那份文档**的属性，不是这个窗口的属性 ⇒ 改动要跨窗口联动。 */
export const EVT_SYNC_MODE = "sync-mode";

export interface SyncPosPayload {
  from?: string;
  docId?: number;
  /** 共享坐标：源码行号 + 小数。 */
  v?: number;
  /**
   * 顶边那一**视觉行**的行首字符位置（B300 · 逐行对齐）。可选：老对端不发、以及隐藏侧
   * 量不出来时就是 `undefined`，收端退回按 `v` 落位。
   * ⚠️ 为什么 `v` 不够：`v` 的小数是「该逻辑行**块高**的比例」，块高随宽度变（软折行数不同）
   * ⇒ 两个宽度的窗口按同一个 `v` 对齐，顶边会差半行到一行（真机对照：同一 `v=6.83`，
   * 主窗口 376px、新窗口 280px）。字符位置才是宽度无关的事实。仍**不传像素**：像素在跨窗口
   * 这条路上从没有意义（每格内容高度不同）。
   */
  pos?: number;
}

/**
 * 一扇窗口「此刻屏上停在哪」的一条读数（B302 · 卫星关窗时交还给主窗口落盘）。
 *
 * 带的是共享坐标 `v` 而不是像素：会话只有主窗口在写，卫星那份位置要能落进主窗口那份
 * session.json，就必须是主窗口那一格换算得出的那个口径。
 */
export interface WindowScrollPosition {
  docId: number;
  /** 共享坐标 `v`（与宽度无关的那一份，不是像素）。 */
  v: number;
}

/**
 * B302：非主窗口把自己屏上的位置报给主窗口 —— 会话只有主窗口在写。
 *
 * 与 `sync-pos` 分开是有意的：那条**受同步开关管**（关着就不该动别人的视口），而「我滚到了
 * 哪儿」是这一格的事实，开关关着也得持久化。收端只记账（写主窗口那份隐藏实例的记录），
 * 绝不扶任何一格的视口。
 */
export const EVT_WINDOW_POS = "window-positions";

export interface WindowPosPayload {
  from?: string;
  positions?: WindowScrollPosition[];
}

export interface SyncModePayload {
  from?: string;
  docId?: number;
  on?: boolean;
}

/**
 * B305：最近打开名单变了。
 *
 * ⚠️ 这条**不是** `from`-family 的跨窗口回声，发人是 Rust（`commands/recents.rs` 的
 * `publish`）：名单归它单点持有，改完就广播一份完整快照。所以收端不许按 `from === windowLabel`
 * 过滤掉自己 —— 没有「自己发的」这一说，本窗口只是视图。
 * 载荷是变更后的完整条目，视图拿它整块重画，不再回头 `list_recents`。
 */
export const EVT_RECENTS_CHANGED = "recents-changed";

export interface RecentsChangedPayload {
  entries?: RecentEntry[];
}
