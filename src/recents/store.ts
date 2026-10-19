/**
 * B305 · 最近打开的前端视图缓存 + 「刚打开了哪份文件」的记入。
 *
 * 职责边界要说清：**名单归 Rust**（`src-tauri/src/commands/recents.rs`），本模块不排序、
 * 不去重、不裁剪、不判文件还在不在。它只做两件本地写得对的事：
 *
 *   1. 把「用户打开了一份文件」这个动作报一发（`noteOpened`，唯一调用点是 `io/files.ts`
 *      的 `doOpen`）。B308 收尾的裁决是「**恢复不算打开**」：记入源必须是动作而不是「某条
 *      路径出现在屏上」那个结果 —— 会话恢复会让文件出现在屏上却没人打开它，而恢复走
 *      `session/rebuild` 直接调 `open_file`，压根不经 `doOpen`，所以语义一对，机制上就
 *      不需要时间窗、旗标，也不需要 per-window 的上一份可见集合来算差集。
 *   2. 缓存 Rust 给的那份 + 变了通知订阅者（面板只认这一份，不自己去 invoke）。
 *
 * ⚠️ 记入失败只留一行日志：打开动作是一次性的，没有「下一次刷新补报」这条路可走；
 * 但它**绝不许把打开流程带崩** —— 名单是旁路功能，`doOpen` 是主干。
 */
import { listen } from "@tauri-apps/api/event";
import { EVT_RECENTS_CHANGED, type RecentsChangedPayload } from "../core/events";
import { logger } from "../core/logger";
import {
  clearRecents,
  forgetRecent,
  getRecentLimit as rpcGetRecentLimit,
  listRecents,
  noteOpenedPath,
  setRecentLimit as rpcSetRecentLimit,
  type RecentEntry,
} from "../ipc/api";

let entries: RecentEntry[] = [];
/** 初值只是占位：真正的上限以 Rust 为准（`initRecentsStore` 与每次改完都重新取）。 */
let limit = 20;
/**
 * 请求序号。回包到达顺序**没有保证**：连发两报时旧那一包可能后到，直接写缓存就会把
 * 名单退回旧状态（用户读作「刚打开的那份没露脸」）。只认最新那一个。
 */
let requestSeq = 0;
const subscribers = new Set<(entries: RecentEntry[]) => void>();

function applyIfFresh(seq: number, list: RecentEntry[]): void {
  if (seq !== requestSeq) return;
  setEntries(list);
}

function notify(): void {
  for (const cb of subscribers) cb(entries);
}

function setEntries(next: RecentEntry[]): void {
  entries = next;
  notify();
}

/**
 * 记一笔「用户打开了这份文件」。唯一调用点是 `io/files.ts` 的 `doOpen` —— 那里是所有打开
 * 动作共用的漏斗（文件对话框、拖放、文件关联、点名单那一行、设置页打开日志）。
 *
 * 回包是变更后的完整名单，直接进缓存；`requestSeq` 那道闸照样适用（连点两行名单时，
 * 旧那一包后到会把手上这份写回旧样子）。
 */
export function noteOpened(path: string): void {
  const seq = ++requestSeq;
  let send: Promise<RecentEntry[]>;
  try {
    send = noteOpenedPath(path);
  } catch (e: unknown) {
    // ⚠️ 这一发挂在 `doOpen` 的主干上：名单取不成都不能把「打开文件」带崩。
    logger.warn("recents", `打开记录没记上：${String(e)}`);
    return;
  }
  void send
    .then((list) => applyIfFresh(seq, list))
    .catch((e: unknown) => {
      logger.warn("recents", `打开记录没记上（这份文件已经打开了）：${String(e)}`);
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
    // ⚠️ 上限到手要**再通知一次**：上面那次（`setEntries`）带的还是模块里的占位 20。
    // 漏了这一发，面板首帧的计数会写成「1/20」，而 B306 那条「上限 0 收起入口」更是
    // 直接拿错口径 —— 真上限是 0 时那颗键会留在按钮列里点不开。
    notify();
  } catch (e: unknown) {
    logger.warn("recents", `上限没取到（按占位值 ${limit} 显示）：${String(e)}`);
  }
  try {
    // ⚠️ 这是 **Rust 发的全量快照**，不是某扇窗口的增量：名单只有一份、由 Rust 统一持有并广播，
    // 本窗口也是它的订阅者之一。按「自己发的要丢掉」去过滤在这一层是错的 —— 点名单那一行
    // 触发的记入也会被判成回声，面板停在旧名单上。
    await listen<RecentsChangedPayload>(EVT_RECENTS_CHANGED, (e) => {
      setEntries(e.payload?.entries ?? []);
    });
  } catch (e: unknown) {
    logger.warn("recents", `没装上名单变化监听：${String(e)}`);
  }
}

/** 单条清除（行上那颗 ✕）。 */
export async function forgetRecentEntry(path: string): Promise<void> {
  const seq = ++requestSeq;
  try {
    applyIfFresh(seq, await forgetRecent(path));
  } catch (e: unknown) {
    logger.warn("recents", `清除单条失败：${String(e)}`);
  }
}

/** 清空全部（标题栏那颗垃圾桶）。 */
export async function clearRecentEntries(): Promise<void> {
  const seq = ++requestSeq;
  try {
    applyIfFresh(seq, await clearRecents());
  } catch (e: unknown) {
    logger.warn("recents", `清空名单失败：${String(e)}`);
  }
}

/**
 * 改「保存数量上限」。回包是**生效后的**上限（别的窗口可能刚写过），本地一律以它为准，
 * 失败也不回滚界面 —— 与 `setLevelPersisted` 同口径：内存里已经切了，重启回落旧值是可
 * 接受的降级，把设置页卡住不是。
 *
 * ⚠️ 改完也要 `notify()`：面板标题栏那格「6/20」带的是上限，不是条数。只等条目变化的话，
 *    裁掉的条目会从名单里消失、而计数还写着旧上限（Rust 那边裁与广播是一起的，本地这一路
 *    要是漏了通知，就要等下一次广播才 correction —— 中间那一段就是用户眼里的「没反应」）。
 */
export async function applyRecentLimit(next: number): Promise<number> {
  try {
    limit = await rpcSetRecentLimit(next);
  } catch (e: unknown) {
    logger.warn("recents", `上限没落盘（本次仍生效）：${String(e)}`);
  }
  notify();
  return limit;
}
