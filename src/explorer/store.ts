/**
 * B314 · 资源管理器的**缓存层**：根、懒读到的每一层、展开态。
 *
 * 职责边界照 `src/recents/store.ts` 那一刀：**判定归 Rust，画归面板，本模块只管这一份缓存**。
 * 不拼路径、不校验名字、不排序（那些在 `commands/explorer.rs`），也不碰任何 DOM。
 *
 * 三件必须在这里做对的事：
 *
 * 1. **懒加载**：`children` 只装「被展开过的那几层」。一次读整棵树在盘符根上会把进程卡死，
 *    而展开态天然是浅的 —— 用户看的永远是几条路径。
 * 2. **换根要作废在飞的那一发**（`generation`）：连点两次「打开文件夹」，旧那一发的回包
 *    后到就会把上一个目录的顶层画进新树里（用户读作「我明明换了文件夹，列表还是旧的」）。
 *    口径同 `recents/store.ts` 的 `requestSeq`。
 * 3. **一层读失败不许拖垮整棵树**：目录可能被权限策略挡住、正被别的进程删、或是个断掉的
 *    重组点。失败只记在这一条路径上（`failed`），面板画一句能读的话，别的分支照旧。
 */
import { listDir, type FsEntry } from "../ipc/api";

/** 目录路径 → 已经读过的那一层子项。`undefined` = 还没读过（面板据此画「没展开过」）。 */
const children = new Map<string, FsEntry[]>();
/** 目录路径 → 读失败的原因文案。留着它才能显示「这一层读不了」而不是「这一层是空的」。 */
const failed = new Map<string, string>();
/** 展开着的目录路径。根不算展开（它那一层总是画出来）。 */
const expanded = new Set<string>();
/** 正在读的路径，防同一层被并发读两次（双击快、或刷新撞上展开）。 */
const loading = new Set<string>();

let root = "";
/** 在飞的那一发属于哪一代。换根 = 代际 +1，旧回包一律作废。 */
let generation = 0;

const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

export function onExplorerChange(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function getRoot(): string {
  return root;
}

/**
 * 换根：清空**全部**缓存与展开态，并作废在飞的回包。
 *
 * ⚠️ 清空是必须的：`children` 的 key 是绝对路径，换根后旧 key 理论上不会再撞上，
 * 但「E:\\a 的下层」这种路径在新根里可能真存在（用户选了同一个盘的另一层），
 * 留着旧那一层就会画出根本没读过的东西。缓存与真相同源，才谈得上懒加载。
 */
export function setRoot(path: string): void {
  generation += 1;
  root = path;
  children.clear();
  failed.clear();
  expanded.clear();
  loading.clear();
  // 根那一层立刻读：面板展开时必须有东西可画，不能先给一片空白等一次点击。
  void loadDir(path);
  notify();
}

export function childrenOf(path: string): FsEntry[] | undefined {
  return children.get(path);
}

export function errorOf(path: string): string | undefined {
  return failed.get(path);
}

export function isLoading(path: string): boolean {
  return loading.has(path);
}

export function isExpanded(path: string): boolean {
  return expanded.has(path);
}

export function expandedPaths(): string[] {
  return [...expanded];
}

/** 读一层并写进缓存。同一层并发只发一次；回包只认自己那一代。 */
export async function loadDir(path: string): Promise<void> {
  if (loading.has(path)) return;
  const gen = generation;
  loading.add(path);
  notify();
  try {
    const listing = await listDir(path);
    if (gen !== generation) return;
    children.set(path, listing.entries);
    failed.delete(path);
    if (listing.truncated) {
      failed.set(path, `这一层太多，只显示前 ${listing.entries.length} 条`);
    }
  } catch (e: unknown) {
    if (gen !== generation) return;
    // 旧的那一层要一起扔掉：留着它，面板就会在新错误旁边继续画旧内容（半真半假的一屏）。
    children.delete(path);
    failed.set(path, String(e));
  } finally {
    loading.delete(path);
    if (gen === generation) notify();
  }
}

/**
 * 展开 / 折叠一个目录。展开时**才**读那一层（懒加载的入口就在这）。
 * 折叠不删缓存：再展开时先画已有的那份、后台 quietly 重读一次，比每次都空一帧好。
 */
export async function toggleDir(path: string): Promise<void> {
  if (expanded.has(path)) {
    expanded.delete(path);
    notify();
    return;
  }
  expanded.add(path);
  await loadDir(path);
}

export function collapseAll(): void {
  expanded.clear();
  notify();
}

/** 全部展开的目录挨个重读，展开态保留。外部改了文件（别的程序建的）之后点刷新。 */
export async function refresh(): Promise<void> {
  // 根 + 每个展开着的目录。用 `expandedPaths()` 的快照：加载中又展开的话，那一层由
  // `toggleDir` 自己负责读，不该被这一次刷新漏算或重复算。
  const paths = [root, ...expandedPaths()].filter((p) => p);
  for (const p of paths) {
    loading.delete(p); // 刷新要绕过「正在读」那道闸，否则撞上在飞那一发就永远刷不动
    await loadDir(p);
  }
}

/** 新建文件/目录之后重读**那一层**（不刷新整棵树：一次新建只动了一个目录）。 */
export async function refreshDir(path: string): Promise<void> {
  loading.delete(path);
  await loadDir(path);
}

/** 只有「有根」才算可用（卫星窗口、以及从没打开过文件夹的主窗口都该是 false）。 */
export function hasRoot(): boolean {
  return root !== "";
}
