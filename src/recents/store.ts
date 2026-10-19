/**
 * B305 · 最近打开的前端视图缓存 + 可见路径上报。
 *
 * 职责边界要说清：**名单归 Rust**（`src-tauri/src/commands/recents.rs`），本模块不排序、
 * 不去重、不裁剪、不判文件还在不在。它只做两件本地写得对的事：
 *
 *   1. 算「本窗口此刻屏上看得见哪些文件」并上报 —— 这是「某个文件被关掉了」的唯一信号。
 *      挂在 `broadcastDocPresence` 上（`src/ui.ts`），因为那条已经是「可见集合变了」的唯一
 *      广播点：开标签走 `refreshAll`、关标签走 `closeTabById`，两条都调它，覆盖全。
 *      不在每个关闭分支各埋一遍的理由与 B157/B188 同一族：埋点一多就会漏，而漏掉的情形
 *      （关整个子窗口、标签拖出去又关掉）恰好是最难复现的那几类。
 *   2. 缓存 Rust 给的那份 + 变了通知订阅者（面板只认这一份，不自己去 invoke）。
 *
 * ⚠️ 上报必须**在 IPC 失败时把 diff 基准退回去**。基准记的是「我以为对方已经知道的状态」，
 * 失败了还不退回去，就等于把「这条路径从没上报过」写成了一段假历史：那份文件后来被关掉
 * 也进不了名单，而且此后再也不会补报 —— 用户看到的是「明明关了却不在最近打开里」，
 * 日志里查不到原因（B303/B304 那一族「单点写坏就无声」的同款形状）。
 */
import { listen } from "@tauri-apps/api/event";
import { docs, tabs } from "../core/app-state";
import { EVT_RECENTS_CHANGED, type RecentsChangedPayload } from "../core/events";
import { logger } from "../core/logger";
import {
  clearRecents,
  forgetRecent,
  getRecentLimit as rpcGetRecentLimit,
  listRecents,
  setRecentLimit as rpcSetRecentLimit,
  syncOpenPaths,
  type RecentEntry,
} from "../ipc/api";

let entries: RecentEntry[] = [];
/** 初值只是占位：真正的上限以 Rust 为准（`initRecentsStore` 与每次改完都重新取）。 */
let limit = 20;
/** 上一次**成功**上报的可见路径集合的指纹；`null` = 还没成功上报过（或上一次失败了）。 */
let lastReportedKey: string | null = null;
const subscribers = new Set<(entries: RecentEntry[]) => void>();

function notify(): void {
  for (const cb of subscribers) cb(entries);
}

function setEntries(next: RecentEntry[]): void {
  entries = next;
  notify();
}

/**
 * 本窗口可见实例的磁盘路径（去重、未命名不算）。
 *
 * 只数 `panelId >= 0` 的实例 —— 与 `broadcastDocPresence` 的 B171/B173 口径一致：标签被
 * 拖去卫星窗口后本地留的那份隐藏实例（`panelId < 0`）**不算「还开着」**，否则主窗口的隐藏
 * 副本会把这份文件一直压住，用户子在子窗口关掉它也不会进名单。
 */
export function visibleOpenPaths(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tabs.values()) {
    if (t.panelId < 0) continue;
    const path = docs.get(t.docId)?.path;
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 可见集合变了才发一次 IPC（`refreshAll` 一轮交互能触发几十次，每次都发就是拿 IPC 刷 Rust）。
 * 回包与 `recents-changed` 广播都是同一份名单，谁先到都无所谓。
 */
export function syncVisiblePaths(): void {
  const next = visibleOpenPaths();
  // 排序后拼指纹：上报的数组本身保持原顺序（Rust 侧不依赖顺序，但日志里读起来对得上手势）。
  const key = [...next].sort().join("\n");
  if (key === lastReportedKey) return;
  lastReportedKey = key;
  // ⚠️ 这条挂在 `refreshAll` 主干上，而名单是**旁路功能**：取数那一下的同步异常也不许把界面
  // 刷新带崩（测试里那份只列了几个导出的 `../src/ipc/api` mock 就是这么炸的）。
  // 基准同样要退回去 —— 否则失败那批路径此后再也不会补报。
  let send: Promise<RecentEntry[]>;
  try {
    send = syncOpenPaths(next);
  } catch (e: unknown) {
    lastReportedKey = null;
    logger.warn("recents", `可见路径上报没发出去，下次刷新重试：${String(e)}`);
    return;
  }
  void send.then(setEntries).catch((e: unknown) => {
    if (lastReportedKey === key) lastReportedKey = null;
    logger.warn("recents", `可见路径上报失败，下次刷新重试：${String(e)}`);
    return undefined;
  });
}

/** 订阅名单变化（面板用）。返回反注册函数。 */
export function onRecentsChange(cb: (entries: RecentEntry[]) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function getRecents(): RecentEntry[] {
  // 直接交内部数组：渲染端只读。要改名单走 forget/clear，别让本地一份副本变成第二个真相。
  return entries;
}

export function getRecentLimit(): number {
  return limit;
}

/** 首帧：名单 + 上限都从 Rust 取，并装上广播监听。只有主窗口需要装（子窗口没有左栏）。 */
export async function initRecentsStore(): Promise<void> {
  try {
    setEntries(await listRecents());
  } catch (e: unknown) {
    logger.warn("recents", `首帧名单没取到：${String(e)}`);
  }
  try {
    limit = await rpcGetRecentLimit();
  } catch (e: unknown) {
    logger.warn("recents", `上限没取到（按占位值 ${limit} 显示）：${String(e)}`);
  }
  try {
    // ⚠️ 不按 `from` 过滤：这条是 **Rust 发的快照**，不是某扇窗口的回声。名单是「各窗口
    // 可见集合的并集」推导出来的，本窗口也是视图之一，所以「自己发的要丢掉」在这里是错的。
    await listen<RecentsChangedPayload>(EVT_RECENTS_CHANGED, (e) => {
      setEntries(e.payload?.entries ?? []);
    });
  } catch (e: unknown) {
    logger.warn("recents", `没装上名单变化监听：${String(e)}`);
  }
}

/** 单条清除（行上那颗 ✕）。 */
export async function forgetRecentEntry(path: string): Promise<void> {
  try {
    setEntries(await forgetRecent(path));
  } catch (e: unknown) {
    logger.warn("recents", `清除单条失败：${String(e)}`);
  }
}

/** 清空全部（标题栏那颗垃圾桶）。 */
export async function clearRecentEntries(): Promise<void> {
  try {
    setEntries(await clearRecents());
  } catch (e: unknown) {
    logger.warn("recents", `清空名单失败：${String(e)}`);
  }
}

/**
 * 改「保存数量上限」。回包是**生效后的**上限（别的窗口可能刚写过），本地一律以它为准，
 * 失败也不回滚界面 —— 与 `setLevelPersisted` 同口径：内存里已经切了，重启回落旧值是可
 * 接受的降级，把设置页卡住不是。
 */
export async function applyRecentLimit(next: number): Promise<number> {
  try {
    limit = await rpcSetRecentLimit(next);
  } catch (e: unknown) {
    logger.warn("recents", `上限没落盘（本次仍生效）：${String(e)}`);
  }
  return limit;
}
