// 跨窗口事件名与载荷（从 main.ts 拆出的可复用核心模块）。
//
// 拆出来的理由：这几块是**别的模块都要用的公共底座**，留在 main.ts 里就等于
// 逼着每个功能模块反过来 import main.ts（hub 型耦合 + 循环依赖）。
// 归到 core/ 之后，功能模块只依赖 core/*，各自可单独单测。

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
