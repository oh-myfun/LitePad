/**
 * B315 · 「盘上的路径变了」→「内存里那份文档的账」的对账口。
 *
 * 为什么单独一个模块：改名 / 剪切 / 删除动的都是**正在编辑器里开着的那份文档**的地盘，
 * 而缓存层（`store.ts`）不该知道文档长什么样、文档层更不该知道树里点了什么。接缝就摆在这里：
 * 上游只有一条 `onPathsChanged(changes)`，下游要办的三件事都得到处都有人办 ——
 *
 *   1. 本窗口 `docs` 里的路径与标签名（屏上那一格 + 窗口标题）；
 *   2. 后端 `state.docs` 里那一条 —— ⚠️ 这条最容易漏：自动保存传的是 `path: null`，
 *      Rust 回落到**它自己记的那条**（`save_paste_image` 与外部修改的监听匹配同理）。
 *      只改前端的话，「改名成 b.md」之后下一次自动保存会把 `a.md` 凭空写回来。
 *   3. 「最近打开」与别的窗口。
 *
 * 分工口径：**盘上的账只由发起方记**（那几发写盘与名单改写不重复做），但
 * `set_doc_path` 是「谁拿着这份文档谁来改」——Rust 的文档表全进程一份，而这条路径完全
 * 可能只在卫星窗口开着，发起方那侧压根没有这份 `Doc` 只改它的窗口就永远漏。它幂等
 * （同一条路径重复设置是空操作，见 `commands/mod.rs` 里 `old != target` 那两道闸）。
 */
import { listen } from "@tauri-apps/api/event";
import { type Doc, docs, windowLabel } from "../core/app-state";
import { EVT_DOC_PATH_CHANGED, type DocPathChangedPayload } from "../core/events";
import { logger } from "../core/logger";
import { emitCrossWindow, setDocPath } from "../ipc/api";
import { forgetRecentEntry, retitleRecentEntry } from "../recents/store";
import { scheduleSessionSave } from "../session/persist";
import { refreshAll } from "../ui";
import { onPathsChanged, type PathChange } from "./store";

/** 分隔符统一成 `\` 并去掉尾部那几颗 —— 比对与改写都走同一个口径，尾巴才不会多一个 `\`。 */
function asKey(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "");
}

function nameOf(p: string): string {
  return asKey(p).split("\\").pop() ?? "";
}

/**
 * 命中则返回「它在 `from` 里面那一段尾巴」：同一条给空串，不相干给 `null`。
 * Windows 路径大小写不敏感（名单里同一文件可能以两种写法进来），比时必须折叠。
 */
function tailOf(path: string, from: string): string | null {
  const p = asKey(path);
  const f = asKey(from);
  if (!p || !f) return null;
  if (p.length === f.length && p.toLowerCase() === f.toLowerCase()) return "";
  const head = p.slice(0, f.length + 1);
  if (head.length < f.length + 1) return null;
  return head.toLowerCase() === `${f.toLowerCase()}\\` ? p.slice(f.length + 1) : null;
}

/** 这条盘上路径变了，牵不牵到这一份文档？（目录改名会牵到它里面每一条） */
function touches(path: string, from: string): boolean {
  return tailOf(path, from) !== null;
}

/**
 * 改写后的新路径；没命中给 `null`。
 *
 * 尾巴保留条目自己那一份写法（大小写不动）—— 与 Rust `session::recent::retitle` 同规则。
 * 两处各写一遍是跨语言的必然：文档在 JS 手里，名单在 Rust 手里，谁也不该为了共用一段代码
 * 去 import 对方那一侧。
 */
export function rewritePath(path: string, from: string, to: string): string | null {
  const tail = tailOf(path, from);
  if (tail === null) return null;
  const next = asKey(to);
  if (!next) return null;
  return tail ? `${next}\\${tail}` : next;
}

/** 改名 / 挪走：换路径、换标签名，别的都不动。 */
function relabel(doc: Doc, next: string): void {
  doc.path = next;
  doc.name = nameOf(next);
  // 基线、脏标记、已知磁盘版本一概不改：改名与挪走都不动一个字节，盘上那份还是同一份内容。
}

/**
 * 送进回收站：内容从此只活在内存里 ⇒ 退回「未关联路径 + 未保存」那一态，与未命名文档同形。
 *
 * ⚠️ 为什么把路径也一并抹掉（而不是留着让 Ctrl+S 原地重建）：留着的话自动保存那条
 * （`path: null` 让 Rust 回落）会在 1.5 秒后把刚删掉的文件凭空写回来 —— 用户读作「删了没删」，
 * 比多点一次另存为糟得多。抹掉之后：自动保存按 `!doc.path` 跳过它，Ctrl+S 走另存为、
 * 名字还带着，重建只是多按一次回车。
 */
function orphan(doc: Doc): void {
  doc.path = null;
  doc.baseline = null; // 基线未知 ⇒ `isDirtyVsBaseline` 恒真，之后每次编辑都判得脏
  doc.dirty = true; // 标签上那颗点当下就要亮，不等下一次编辑
  doc.diskMtimeMs = 0;
  doc.diskSize = 0;
  doc.external = false;
}

/**
 * 把一次变更落到本窗口的文档上。返回被改到的 docId（后端那一条要靠它去改）。
 *
 * 一次变更牵到多份文档（目录改名）时，标签条只重画一次、会话只排一次防抖。
 */
function applyToDocs(change: PathChange): number[] {
  const hit: number[] = [];
  for (const doc of docs.values()) {
    if (!doc.path || !touches(doc.path, change.from)) continue;
    if (change.to === null) {
      orphan(doc);
    } else {
      const next = rewritePath(doc.path, change.from, change.to);
      if (next === null) continue;
      relabel(doc, next);
    }
    hit.push(doc.tabId);
  }
  if (hit.length > 0) {
    // `refreshAll` 是那一组刷新的唯一出口：标签名、窗口标题、状态栏、按钮勾选态一起跟上。
    // 只调 `renderPanelTabs` 会漏掉标题栏 —— 用户盯着的正是「标签和标题写的是不是同一个名字」。
    refreshAll();
    // 会话里存的是每条文档的路径：账已经改了，就得落一次盘（卫星窗口内部自己空转，不写）。
    scheduleSessionSave();
  }
  return hit;
}

/** 本窗口 + 后端那一份。每个窗口都要办（发起方也在内），办公的是各自内存与那张全局表。 */
function applyLocally(changes: PathChange[]): void {
  for (const change of changes) {
    for (const docId of applyToDocs(change)) {
      void setDocPath(docId, change.to ?? "").catch((e: unknown) => {
        logger.warn("explorer", `后端那条路径没跟上（标签 ${docId}）：${String(e)}`);
      });
    }
  }
}

/**
 * 发起方办的事：改写名单里那一条，再把变更告诉别的窗口。
 *
 * 名单那两发只在这里发 —— 收到事件的那一侧再去发一遍，等于同一次改名把名单改两回
 * （改写是幂等的，但「就地改写」命中的是已经改过的路径，第二发就什么都改不到，
 * 反而把 LRU 里那条留在旧写法上）。
 */
function initiate(changes: PathChange[]): void {
  applyLocally(changes);
  for (const change of changes) {
    if (change.to === null) void forgetRecentEntry(change.from);
    else void retitleRecentEntry(change.from, change.to);
  }
  void emitCrossWindow(EVT_DOC_PATH_CHANGED, { changes }).catch((e: unknown) => {
    logger.warn("explorer", `路径改动没广播出去（别的窗口还认旧路径）：${String(e)}`);
  });
}

/** 装配：主窗口与卫星窗口都要装（发起方只有主窗口，但改账的每一扇窗口都得在听）。 */
export function setupPathRewiring(): void {
  onPathsChanged(initiate);
  void listen<DocPathChangedPayload>(EVT_DOC_PATH_CHANGED, (e) => {
    const p = e.payload;
    // 自己那一发已经就地办过了。主窗口也会收到自己广播的回声：不排掉的话，
    // 那几发 `set_doc_path` 会原样再来一遍（幂等，但白跑一趟）。
    if (!p || p.from === windowLabel) return;
    const changes = (p.changes ?? []).filter(
      (c) => typeof c?.from === "string" && (c.to === null || typeof c.to === "string"),
    );
    if (changes.length > 0) applyLocally(changes);
  }).catch((e: unknown) => {
    logger.warn("explorer", `路径改写监听没装上：${String(e)}`);
  });
}
