// 多窗口 / 卫星窗口 / 跨窗口同源同步（从 main.ts 拆出，解耦第十四步 / #415）。
//
// 职责：标签搬出与回收（transferSnapshotOf / remoteTabLocally / reclaimRemoted /
// openTabsInNewWindow / adoptTransferredTabs / returnTabsToMain / returnTabToMain /
// detachLocally）、拖拽出窗成窗（dragTabIds / snapshotDrag / relinquishDrag /
// dropOnDesktop / desktopSpotOf / acceptDroppedTabs）、消失窗口清理（applyTabsReturn /
// applyBackupIds / reclaimFromVanished / dropRemotedDoc / dropRemotedForOwner）、
// 关标签防误杀（hasVisibleInstanceOf / handleDocCloseQuery / docHeldElsewhere）、
// 跨窗口同源同步（broadcastDocChange / applyRemoteDocChange / requestDocResync /
// answerDocResync / applyDocResyncFull / listenDocSync）。
// **零外部函数依赖（无 DI）**——共享状态（windowKind / windowLabel / remotedTabs /
// remoteOpenByWindow / loanedDocIds）已在 core/app-state。
// 对 main.ts 零反向依赖。

import {
  MAIN_WINDOW_LABEL,
  activePanelId,
  docSyncModes,
  docs,
  loanedDocIds,
  panels,
  remotedTabs,
  remoteOpenByWindow,
  tabs,
  windowKind,
  windowLabel,
  setSyncingDocId,
} from "../core/app-state";
import { activeTab, instancesOfDoc } from "../core/panels";
import { syncCoordinator } from "../sync-scroll/wire";
import {
  DocChangePayload,
  DocClosePayload,
  DocPresencePayload,
  EVT_DOC_CHANGE,
  EVT_DOC_CLOSE_HELD,
  EVT_DOC_CLOSE_NOTIFY,
  EVT_DOC_CLOSE_QUERY,
  EVT_DOC_OPEN,
  EVT_DOC_OPEN_RESYNC,
  EVT_DOC_RESYNC_FULL,
  EVT_DOC_RESYNC_REQ,
  EVT_WINDOW_CLOSED,
} from "../core/events";
import type { TabDragPayload } from "../shell/tabdnd";
import { logger } from "../core/logger";
import { ChangeSet } from "@codemirror/state";
import {
  attachTabToPanel,
  isDirtyVsBaseline,
  isMdTab,
  makeDoc,
  makeInstance,
  registerDoc,
} from "../doc-model";
import {
  exitMaximize,
  freshTextOfDoc,
  moveTabToStrip,
  pruneEmptyPanels,
  rebuildLayout,
  renderPanelTabs,
  splitPanelWithTab,
} from "../tabs";
import { refreshAll, refreshSyncButton, refreshTitle, showMessage } from "../ui";
import { scheduleSessionSave } from "../session/session";
import { normalizeSizeClass } from "../editor/perf";
import {
  openSatelliteWindow,
  SatellitePayload,
  SatelliteTab,
  WindowSpot,
  emitCrossWindow,
} from "../ipc/api";
import type { DropSpot } from "../shell/splitview";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ---------------------------------------------------------------- 多窗口（B71 ④）
//
// 一个 LitePad 进程可以开多个窗口：`main` 是主窗口（会话、设置、自动保存的持有者），
// `sat-<n>` 是**卫星窗口**（承载用户拎出去的几个标签）。
//
// 设计要点（都是踩过或差点踩到的点）：
//   · 文档 id 是**进程级**的，两个窗口共用同一批 id，卫星窗口不重新分配 —— 于是
//     `save_file` / `write_backup` 这些按 id 寻址的命令天然通用。
//   · 正文**随载荷一起传**：未保存的修改、未命名的文档都只存在于源窗口的内存里，
//     让新窗口自己去读盘会拿到旧内容。
//   · 源窗口必须等新窗口**确认拿到载荷**才敢把标签摘掉 —— 建窗失败（内存不足等）
//     时若已经摘了，用户看到的就是「标签没了，新窗口也没出来」。
//   · 会话始终由**主窗口**持有：卫星窗口不读也不写 session.json，否则两个窗口会
//     互相覆盖（见 scheduleSessionSave 的闸门）。

/** 等新窗口「已就绪」的上限。超时按没开起来处理（源窗口保留标签，只提示一句）。 */
const SATELLITE_READY_TIMEOUT_MS = 6000;

/**
 * B161：**曾经借出去过**的文档 id（只在 `remoteTabLocally` 里加，从不删）。
 *
 * 与 `remotedTabs` 的区别：那份隐藏实例被「在本窗口重新打开同一文件」回收后就从
 * `remotedTabs` 里消失了，可**别的窗口手上那份还在** —— 只认 `remotedTabs` 会在这种
 * 情况下误判成「没人拿着」，主窗口关标签时又把别人那份一起关掉。
 * 判据宁粗勿细：多问一圈只是多 150ms，漏问就是别人的文档变成空壳。
 */

/** 把某实例摊平成可跨窗口传输的快照（正文取实例状态，不需要回写磁盘）。 */
function transferSnapshotOf(tabId: number): SatelliteTab | null {
  const tab = tabs.get(tabId);
  if (!tab) return null;
  const doc = docs.get(tab.docId);
  if (!doc) return null;
  const text = tab.state.doc.toString();
  const pos = Math.min(tab.state.selection.main.head, text.length);
  const line = tab.state.doc.lineAt(pos);
  return {
    docId: doc.tabId,
    path: doc.path,
    name: doc.name,
    text,
    encoding: doc.encoding,
    eol: doc.eol,
    readonly: doc.readonly,
    dirty: doc.dirty,
    viewMode: isMdTab(tab) ? tab.viewMode : "source",
    cursorLine: line.number,
    cursorCol: pos - line.from + 1,
    // B169：同步滚动开关一起带走——否则主窗口开着同步、子窗口收下后按钮还是灭的，
    // 两边状态对不上（用户报「子窗口的同步按钮状态和主窗口的要一致」）。
    syncMode: docSyncModes.get(tab.docId) === true,
    sizeClass: doc.sizeClass,
    backupId: doc.backupId,
    backedUp: doc.backedUp,
  };
}

/**
 * 标签被搬到别的窗口后，本地要留一个**隐藏实例**（panelId = -1）。
 *
 * 为什么不留着不管、直接删掉：会话与热退出都靠「本地还认得这个文档」才能把它的
 * 内容写进 session.json。卫星窗口自己不写会话（见 scheduleSessionSave 闸门），
 * 如果这里删干净，用户把一份未保存文档拖到新窗口、然后用任务管理器结束进程，
 * 那份文档就再也没人记得 —— 副本会变成孤儿被清理掉。
 *
 * 隐藏实例不进任何面板（标签条上看不到），只用于：
 *   · snapshotSession 把它写进会话的 `satelliteTabs` 段
 *   · 卫星窗口异常消失（崩溃/被杀）时把它**恢复成可见标签**当作兜底
 */
function remoteTabLocally(tabId: number, owner: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = panels.get(tab.panelId);
  if (panel) {
    const idx = panel.tabs.indexOf(tabId);
    if (idx >= 0) panel.tabs.splice(idx, 1);
    if (panel.activeTabId === tabId)
      panel.activeTabId = panel.tabs[idx] ?? panel.tabs[idx - 1] ?? -1;
    if (panel.viewTabId === tabId) panel.viewTabId = null;
  }
  tab.panelId = -1;
  remotedTabs.set(tab.docId, { tabId, owner });
  // B161：记一笔「这份文档借出去过」—— 隐藏实例被回收后仍要当作「可能在别人手上」
  loanedDocIds.add(tab.docId);
}

/** 把隐藏实例恢复成可见标签（卫星窗口消失、或用户点「移回主窗口」时用）。 */
function reclaimRemoted(tabId: number, panelId = activePanelId): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = panels.get(panelId) ?? panels.get([...panels.keys()][0]);
  if (!panel) return;
  remotedTabs.delete(tab.docId);
  tab.panelId = panel.panelId;
  panel.tabs.push(tabId);
  panel.activeTabId = tabId;
}

/**
 * 把指定标签搬到新窗口。
 *
 * 顺序是刻意的：先挂「就绪 / 失败」监听 → 建窗 → 等到应答 → 才摘本地标签。
 * 反向（先摘再建）在建窗失败时会让标签凭空消失，用户没有任何补救手段。
 */
async function openTabsInNewWindow(tabIds: number[], spot?: WindowSpot | null): Promise<void> {
  const snapshots = tabIds
    .map((id) => transferSnapshotOf(id))
    .filter((s): s is SatelliteTab => s !== null);
  if (snapshots.length === 0) return;

  const title = snapshots.length === 1 ? snapshots[0].name : `LitePad — ${snapshots.length} 个标签`;
  const payload: SatellitePayload = { tabs: snapshots };

  // 新窗口冷启可能比一次 IPC 往返还快 → 监听必须先挂上，且不能假设「label 已拿到」
  const readyLabels = new Set<string>();
  // label → 失败原因。B72 起必须**带出原因**：原先两种情况（建窗失败 / 就绪超时）都
  // 只报一句「没能打开」，把 WebView2 拒绝创建这种可诊断的错误信息一起吞掉了。
  const failedLabels = new Map<string, string>();
  let notify: ((label: string) => void) | null = null;
  const onReady = await listen<{ label: string }>("satellite-ready", (e) => {
    const l = e.payload?.label;
    if (!l) return;
    readyLabels.add(l);
    notify?.(l);
  });
  const onFailed = await listen<{ label: string; message?: string }>("satellite-failed", (e) => {
    const l = e.payload?.label;
    if (!l) return;
    failedLabels.set(l, e.payload?.message ?? "");
    notify?.(l);
  });

  let label: string;
  try {
    label = await openSatelliteWindow(title, payload, spot);
    const ok = await new Promise<boolean>((resolve) => {
      if (readyLabels.has(label)) return resolve(true);
      if (failedLabels.has(label)) return resolve(false);
      const timer = setTimeout(() => resolve(false), SATELLITE_READY_TIMEOUT_MS);
      notify = (l) => {
        if (l !== label) return;
        clearTimeout(timer);
        resolve(readyLabels.has(label));
      };
    });
    if (!ok) {
      const why = failedLabels.get(label);
      const detail = why ? `：${why}` : "：等待新窗口就绪超时";
      logger.error("window", `satellite ${label} failed${detail}`);
      showMessage(`新窗口没能打开${detail}，标签保留在原窗口`, true);
      return;
    }
  } catch (err) {
    showMessage(`新窗口打开失败：${err}`, true);
    return;
  } finally {
    notify = null;
    onReady();
    onFailed();
  }

  // 面板结构变了（标签被摘走）→ 最大化态必须先还原，否则会留下「0 宽但还在树里」
  // 的面板（同 splitPanelWithTab / closePanelById 的处理）
  exitMaximize();
  for (const id of tabIds) remoteTabLocally(id, label);
  // B90：最后一个标签被送到新窗口后原面板会空 —— 摘掉，别留一个空框
  pruneEmptyPanels();
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
}

/**
 * 接管一批从别的窗口交过来的标签（主窗口的 `docs-return`、或卫星窗口启动时自带的载荷）。
 *
 * 文档已在本窗口存在时**只加实例**：同一文档在两个窗口各有一份实例是允许的，
 * 但 `docs` 镜像必须只有一份（同源多实例的唯一真相）。
 */
function adoptTransferredTabs(incoming: SatelliteTab[], panelId = activePanelId): number[] {
  const panel = panels.get(panelId) ?? panels.get([...panels.keys()][0]);
  if (!panel) return [];
  const adopted: number[] = [];
  for (const st of incoming) {
    // B169：主窗口那份文档的同步滚动开关状态一起带走 —— 否则主窗口开着、子窗口收下后
    // 按钮还是灭的，两边点亮态对不上（用户报「子窗口的同步按钮状态和主窗口的要一致」）。
    // 注意：同步联动本身已禁用，这里搬的只是按键的点亮态。
    if (st.syncMode) docSyncModes.set(st.docId, true);
    // 该文档在本地还留着隐藏实例（刚从别的窗口交回来）→ 先把它摘掉，避免出现
    // 「两份实例同源但互不同步」——同源多实例的前提是同一窗口内共用一个 docs 条目，
    // 而隐藏实例的正文可能与交回来的最新正文不一致。
    const remoted = remotedTabs.get(st.docId);
    if (remoted !== undefined) {
      const hidden = tabs.get(remoted.tabId);
      if (hidden && hidden !== tabs.get(st.docId)) tabs.delete(remoted.tabId);
      remotedTabs.delete(st.docId);
    }
    let doc = docs.get(st.docId);
    if (!doc) {
      doc = makeDoc(
        st.docId,
        st.text,
        st.name,
        st.path,
        st.encoding,
        st.eol,
        st.readonly,
        normalizeSizeClass(st.sizeClass),
        st.backupId ?? null,
      );
      registerDoc(doc);
    }
    doc.dirty = st.dirty;
    // 认领来的文档里，脏的那份**没有基线** —— 只继承到「它脏」，不知道原样是啥，
    // 所以不能拿 st.text 当基线（那是改过之后的内容）；干净的那份正文即基线
    // （makeDoc 已按 st.text 设好）。
    if (st.dirty) doc.baseline = null;
    else {
      doc.baseline = st.text;
      doc.baselineEncoding = st.encoding;
      doc.baselineEol = st.eol;
    }
    doc.backedUp = st.backedUp;
    const inst = makeInstance(doc, panel.panelId, st.text);
    if (isMdTab(inst) && st.viewMode === "preview") inst.viewMode = "preview";
    const lineNo = Math.min(Math.max(1, st.cursorLine || 1), inst.state.doc.lines);
    const line = inst.state.doc.line(lineNo);
    const pos = line.from + Math.min(Math.max(0, (st.cursorCol || 1) - 1), line.length);
    inst.state = inst.state.update({ selection: { anchor: pos } }).state;
    attachTabToPanel(inst, panel);
    adopted.push(inst.tabId);
  }
  if (adopted.length === 0) return [];
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
  return adopted;
}

/** 卫星窗口：把手上的标签交还主窗口（定向投递，主窗口那边 applyTabsReturn）。 */
function returnTabsToMain(tabIds: number[]): void {
  const snapshots = tabIds
    .map((id) => transferSnapshotOf(id))
    .filter((s): s is SatelliteTab => s !== null);
  if (snapshots.length === 0) return;
  void emitTo(MAIN_WINDOW_LABEL, "tabs-return", {
    from: windowLabel,
    tabs: snapshots,
  }).catch((e: unknown) => {
    // 主窗口没在（正在退出）→ 未保存内容仍由热退出副本兜底。
    // 兜底是好的，但「标签没交回去」本身要留痕（B147）：下次启动它会以「隐藏实例」
    // 的形式出现在主窗口，用户看到的是「标签回来了、却不能编辑」。
    logger.debug("window", `标签没交回主窗口：${String(e)}`);
  });
}

/** 卫星窗口：把单个标签交回主窗口（标签右键「移回主窗口」）。 */
function returnTabToMain(tabId: number): void {
  returnTabsToMain([tabId]);
  detachLocally([tabId]);
}

/**
 * 把本窗口的若干标签「摘掉」（交出去之后）。
 *
 * ⚠️ 不能走 `closeTabById` —— 那会连 Rust 侧的文档一起删掉，接手的窗口拿到的
 * 就只剩一个空壳（首次保存会报「文档不存在」）。这里只动本窗口的内存视图，
 * 文档本体留在 Rust 等对方认领。
 */
function detachLocally(tabIds: number[]): void {
  for (const tabId of tabIds) {
    const tab = tabs.get(tabId);
    if (!tab) continue;
    const panel = panels.get(tab.panelId);
    tabs.delete(tabId);
    if (panel) {
      panel.tabs = panel.tabs.filter((id) => id !== tabId);
      if (panel.activeTabId === tabId) panel.activeTabId = panel.tabs[0] ?? -1;
      if (panel.viewTabId === tabId) panel.viewTabId = null;
    }
    if (![...tabs.values()].some((t) => t.docId === tab.docId)) docs.delete(tab.docId);
  }
  // 空了的卫星窗口自己关掉：留一个没有标签的窗口没有意义（关窗即真关，不交还，见 B188）。
  if (windowKind === "satellite" && tabs.size === 0) {
    requestSatelliteClose();
    return;
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
}

// ------------------------------------------------- 卫星窗口怎么关（B155 / B157）

/**
 * 请求关掉卫星窗口。
 *
 * 刻意的「绕一圈」：走 `close()` 而**不是**直接 `destroy()`，为的是与用户点 X 走同一条
 * 链（CloseRequested → `registerSatelliteClose` → `finishSatelliteClose`）—— 热退出
 * 副本的收尾（cancelPendingBackup / flushBackups）就在那条链上，跳过去会漏掉。
 *
 * ⚠️ 关窗即**真关**：既不把标签交回主窗口，也不广播「文档关掉了」。没关的文件标签本就
 * 在主窗口留着一份隐藏实例（从主窗口分出去时没摘），由它接着管；未保存内容改由热退出
 * 副本兜住（`finishSatelliteClose` 里那两条），不依赖任何交还。这是 B188 起钉死的口径：
 * 用户明确「子窗口关闭时不需要将其中的标签接回」，与 B155 点 X 那档同款（见
 * `registerSatelliteClose` 注释）。
 */
function requestSatelliteClose(): void {
  void getCurrentWindow()
    .close()
    .catch((e: unknown) => {
      logger.debug("window", `请求关子窗口失败：${String(e)}`);
    });
}

/**
 * 一次拖拽涉及哪些标签实例（整组 = 该面板的全部标签）。
 *
 * 从载荷反推而不是随拖拽携带 id 列表：整组拖拽期间面板的标签集合可能被别的操作
 * 改动，**以松手那一刻的实际状态为准**才不会漏掉或多带。
 */
function dragTabIds(payload: TabDragPayload): number[] {
  if (payload.groupPanelId === null) return [payload.tabId];
  return [...(panels.get(payload.groupPanelId)?.tabs ?? [])];
}

/** 别的窗口来认领标签：把这次拖拽涉及的标签全部摊平成快照（正文一起带走）。 */
function snapshotDrag(payload: TabDragPayload): SatelliteTab[] | null {
  const snapshots = dragTabIds(payload)
    .map((id) => transferSnapshotOf(id))
    .filter((s): s is SatelliteTab => s !== null);
  return snapshots.length > 0 ? snapshots : null;
}

/**
 * 标签已经交给**另一个窗口**了，本窗口收干净（B91-2）。
 *
 * 与「交回主窗口」分成两条路径，差别只在本地留不留隐藏实例：
 *   · 主窗口 → 留隐藏实例（`remoteTabLocally`）：会话与热退出靠它记住这份文档的
 *     正文，卫星窗口被任务管理器结束时还能把标签恢复成可见的；
 *   · 卫星窗口 → 直接摘掉（`detachLocally`，摘空了它自己关窗）。
 */
function relinquishDrag(payload: TabDragPayload, toLabel: string): void {
  const ids = dragTabIds(payload);
  if (ids.length === 0) return;
  if (windowKind === "satellite") {
    // 卫星窗口不留隐藏实例：它被摘空了就自己关掉（detachLocally 里处理）
    detachLocally(ids);
    pruneEmptyPanels(); // B90：被拖走的那一组留下的空面板要摘掉
  } else {
    exitMaximize();
    for (const id of ids) remoteTabLocally(id, toLabel);
    // B90：整组（或最后一个标签）被拖走后那个面板就空了 —— 摘掉，别留一个空框。
    pruneEmptyPanels();
    rebuildLayout();
    refreshAll();
    scheduleSessionSave();
  }
  showMessage(`已移到另一个窗口 ${ids.length} 个标签`);
}

/**
 * 拖拽落在**窗口外**、且没有别的 LitePad 窗口接手（扔在桌面上）：源窗口的回落。
 *
 * B89 定下的语义一字未改：主窗口 → 在落点处开一个新窗口；卫星窗口 → 交回主窗口。
 * 区别只在「有没有别的窗口接手」不再靠源窗口猜（B89 是广播指针坐标 + 200ms 抢单），
 * 而是 `tabdnd.ts` 观察对方发来的认领 —— 走到这里就说明确实没人接。
 */
async function dropOnDesktop(
  payload: TabDragPayload,
  screenX: number,
  screenY: number,
): Promise<void> {
  const ids = dragTabIds(payload);
  if (ids.length === 0) return;
  if (windowKind === "satellite") {
    returnTabsToMain(ids);
    detachLocally(ids);
    pruneEmptyPanels(); // B90：同上，交回主窗口后不留空面板
    showMessage(`已交回主窗口 ${ids.length} 个标签`);
    return;
  }
  await openTabsInNewWindow(ids, desktopSpotOf(screenX, screenY));
}

/**
 * 桌面松手处的屏幕坐标（逻辑像素，虚拟桌面口径）。
 *
 * 用 `dragend` 的 `screenX/screenY`：整段拖拽手势被系统交给了拖放循环，页面在此期间
 * 收不到任何指针事件，`dragend` 是唯一还带着最后位置的时机。
 *
 * ⚠️ 多显示器不同缩放时这两个值会有偏差（它们按当前显示器的缩放折算）。所以拿不到
 * （0,0）就返回 null，让系统自己摆窗口 —— 摆错位置比不摆更让人困惑。
 */
function desktopSpotOf(screenX: number, screenY: number): WindowSpot | null {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  if (screenX === 0 && screenY === 0) return null;
  return { x: screenX, y: screenY };
}

/**
 * 别的窗口把标签拖到本窗口、并在这里松手（B89）。
 *
 * `spot` 是**本窗口**在对方悬停时算好的落点（哪块面板、分屏还是并入、插到哪个标签
 * 之前）。拖拽期间用户看到的就是这块预览，所以提交必须严格照它来，绝不能重新猜一个
 * ——那会让「预览在这、落下在那」。
 */
function acceptDroppedTabs(raw: unknown, spot: DropSpot | null): boolean {
  const incoming = Array.isArray(raw) ? (raw as SatelliteTab[]) : [];
  const valid = incoming.filter(
    (s) => s && typeof s.docId === "number" && typeof s.text === "string",
  );
  if (valid.length === 0) return false;
  const panelId = spot?.panelId ?? activePanelId;
  const adopted = adoptTransferredTabs(valid, panelId);
  if (adopted.length === 0) return false;
  const first = adopted[0];
  if (spot && spot.zone !== "center") {
    // 落在面板边缘 = 分屏（与窗口内拖拽同一套语义：左右成 h、上下成 v）
    const dir = spot.zone === "left" || spot.zone === "right" ? "h" : "v";
    splitPanelWithTab(panelId, dir, first, spot.zone === "left" || spot.zone === "top");
  } else if (spot?.beforeTabId != null && spot.beforeTabId !== first) {
    moveTabToStrip(panelId, first, spot.beforeTabId);
  }
  showMessage(`已从另一个窗口接来 ${adopted.length} 个标签`);
  return true;
}

/** 主窗口：接住卫星窗口交回来的标签。 */
function applyTabsReturn(payload: { from?: string; tabs?: SatelliteTab[] } | null): void {
  if (windowKind !== "main") return;
  const incoming = payload?.tabs;
  if (!incoming || incoming.length === 0) return;
  adoptTransferredTabs(incoming);
  showMessage(`已从另一个窗口接回 ${incoming.length} 个标签`);
}

/**
 * 主窗口：接收卫星窗口新分配的副本 ID。
 *
 * 会话只有主窗口在写（卫星窗口的 scheduleSessionSave 是空操作），而热退出副本是
 * 卫星窗口自己写的 —— 不回传这个 ID，主窗口的会话就会记着一个旧的（或空的）副本号，
 * 重启时用户真正看到的内容反而成了没人认领的孤儿副本被清掉。
 */
function applyBackupIds(
  payload: { docs?: Array<{ docId: number; backupId: string | null; backedUp: boolean }> } | null,
): void {
  if (windowKind !== "main") return;
  let touched = false;
  for (const d of payload?.docs ?? []) {
    const doc = docs.get(d.docId);
    if (!doc) continue;
    doc.backupId = d.backupId;
    doc.backedUp = d.backedUp;
    touched = true;
  }
  if (touched) scheduleSessionSave();
}

/**
 * 主窗口：卫星窗口**异常消失**（崩溃 / 被任务管理器结束）时的兜底。
 *
 * 命中条件：卫星窗口死了、却没走过 `finishSatelliteClose` 那条干净关窗链（所以
 * `satellite-clean-close` 没发、`remotedTabs` 里还留着这份 owner 的条目）。正常关窗
 * 走 `finishSatelliteClose` → 发 `satellite-clean-close` → 主窗口 `dropRemotedForOwner`
 * 已把 `remotedTabs` 清空，这里落到时就是空操作，不会把用户「关掉」的子窗口标签又接回来
 * （B188）。真正命中只有崩溃 / 被杀这类够不到前端收尾的路径 —— 那时把隐藏实例恢复成
 * 可见标签，至少让用户看得见、能继续编辑（代价是最后一次未交还的编辑不在，副本仍能兜住）。
 */
function reclaimFromVanished(label: string): void {
  if (windowKind !== "main") return;
  const orphans = [...remotedTabs.entries()].filter(([, v]) => v.owner === label);
  if (orphans.length === 0) return;
  for (const [docId, v] of orphans) {
    remotedTabs.delete(docId);
    reclaimRemoted(v.tabId);
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
  showMessage(`另一个窗口已关闭，接回 ${orphans.length} 个标签`);
}

// --------------------------------------------- B161 关标签：只关自己这一份

/** 本窗口还**看得见**这份文档吗（隐藏实例不算 —— 它只是借出去那一份的副本）。 */
function hasVisibleInstanceOf(docId: number): boolean {
  for (const t of tabs.values()) {
    if (t.docId === docId && t.panelId !== -1) return true;
  }
  return false;
}

/**
 * 主窗口：把「借给卫星窗口那份的隐藏实例」作废旧账。
 *
 * 人家已经把标签关掉了，这份副本再留着就是 B155 那个「关了又冒回来」—— 等卫星窗口
 * 一关，`reclaimFromVanished` 会把它恢复成可见标签，用户看到的就是「我在子窗口关掉的
 * 文件跑到主窗口来了」。
 */
function dropRemotedDoc(docId: number): void {
  const v = remotedTabs.get(docId);
  if (!v) return;
  remotedTabs.delete(docId);
  tabs.delete(v.tabId);
  if (instancesOfDoc(docId).length === 0) docs.delete(docId);
  scheduleSessionSave();
}

/**
 * 主窗口：卫星窗口**干净关窗**时，把借给它那份隐藏实例作废旧账（B188）。
 *
 * 与 `dropRemotedDoc` 同口径（删标签 + 清 `remotedTabs` + 必要时删 Rust 文档），
 * 但按 owner 批量摘 —— 这样 `reclaimFromVanished`（崩溃兜底，只在 `satellite-closed`
 * 上触发）落到时，`remotedTabs` 里已经没有这份 owner 的条目，自然成为空操作，
 * 不会把用户「关掉」的子窗口标签又恢复回主窗口。
 */
function dropRemotedForOwner(label: string): void {
  if (windowKind !== "main") return;
  const owned = [...remotedTabs.entries()].filter(([, v]) => v.owner === label);
  for (const [docId] of owned) dropRemotedDoc(docId);
}

/**
 * 收到别人的「我要关这份文档了，还有人拿着吗」。
 *
 * 两种答法：
 *   · 本窗口还有**可见**标签 → 回一条 `doc-close-held`，让对方别动 Rust 那一侧；
 *   · 没有可见标签 → 主窗口顺手把那份隐藏实例摘掉，并且**不吭声**：那只是一份副本，
 *     不算「有人拿着」（留着它才是「关了又冒回来」的根）。
 */
function handleDocCloseQuery(docId: number, from: string): void {
  if (hasVisibleInstanceOf(docId)) {
    void emitTo<DocClosePayload>(from, EVT_DOC_CLOSE_HELD, { from: windowLabel, docId }).catch(
      (e: unknown) => {
        logger.debug("window", `未能回告「仍持有文档」：${String(e)}`);
      },
    );
    return;
  }
  if (windowKind === "main" && remotedTabs.has(docId)) dropRemotedDoc(docId);
}

/**
 * 广播问一圈「这份文档还有没有别人拿着」，等一小会儿；有人应答就算有。
 *
 * ⚠️ 先装监听**再**广播：反过来的话，回得快的一方会在监听就位之前就把应答发出来，
 *    发起方一条都收不到 ⇒ 判定成「没人拿着」⇒ 又把别人的那份一起关掉（假绿）。
 * ⚠️ 应答要认 `from !== windowLabel`：广播本机也收得到自己的回声（B159 同款）。
 */
function docHeldElsewhere(docId: number, waitMs = 150): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    const finish = (held: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unlisten?.();
      resolve(held);
    };
    void listen<DocClosePayload>(EVT_DOC_CLOSE_HELD, (e) => {
      const p = e.payload;
      if (p?.docId === docId && p.from !== undefined && p.from !== windowLabel) finish(true);
    })
      .then((un) => {
        if (settled) {
          un();
          return;
        }
        unlisten = un;
        void emitCrossWindow(EVT_DOC_CLOSE_QUERY, { docId }).catch(() => {});
        // 没人应答也算数：等过了这阵就当「没人拿着」。
        timer = setTimeout(() => finish(false), waitMs);
      })
      .catch(() => finish(false));
  });
}

// ------------------------------------------------------------ 跨窗口同源同步

/** 主窗口要销毁了（B155）：在场的卫星窗口收到这条就得自己收场。 */
// ⚠️ 这里**没有**「谁关了文档就广播给别的窗口」那条事件（B155 加过、B157 删掉）：
//    标签是每个窗口各持一份，但**关标签只有发起窗口说了算** —— 让对端跟着摘的结果是
//    「在子窗口关个文件，主窗口的同名标签也被关掉」，用户明确否掉。卫星窗口无论怎么关
//    （点 X / 关空 / 关唯一面板）都不再把标签交回主窗口（B188，见 `requestSatelliteClose`）。

/** 正在套用远端变更：期间本窗口产生的 update 不再广播。 */
let applyingRemote = false;
/** 已发出、还没等到应答的重同步请求（同一文档不重复发）。 */
const resyncPending = new Set<number>();

/** 把本地编辑广播给其他窗口（自己也会收到这份事件，靠 payload.from 过滤掉）。 */
function broadcastDocChange(docId: number, changes: ChangeSet, baseLen: number): void {
  if (applyingRemote || changes.empty) return;
  void emitCrossWindow(EVT_DOC_CHANGE, {
    docId,
    baseLen,
    changes: changes.toJSON(),
  }).catch(() => {
    // 没有别的窗口 / 事件系统不可用：本窗口照常工作，不是错误
  });
}

/** 本窗口某文档的当前正文（取挂载中的实例，与 freshTextOfDoc 同一口径）。 */
function textOfDocId(docId: number): string | null {
  const doc = docs.get(docId);
  return doc ? freshTextOfDoc(doc) : null;
}

/** 收到远端变更：按「同源多实例」的方式落到本窗口该文档的每个实例上。 */
function applyRemoteDocChange(payload: DocChangePayload | null): void {
  const docId = payload?.docId;
  if (!payload || payload.from === windowLabel || typeof docId !== "number") return;
  const instances = [...tabs.values()].filter((t) => t.docId === docId);
  if (instances.length === 0) return; // 本窗口没这份文档：谁显示谁同步，无需理会

  let changes: ChangeSet;
  try {
    changes = ChangeSet.fromJSON(payload.changes);
  } catch {
    requestDocResync(docId);
    return;
  }
  if (changes.empty) return;

  const baseLen = payload.baseLen;
  if (typeof baseLen === "number" && instances.some((t) => t.state.doc.length !== baseLen)) {
    // 分叉了：宁可要一份全文，也不在错的基准上套增量
    requestDocResync(docId);
    return;
  }

  applyingRemote = true;
  setSyncingDocId(docId); // 与窗口内同源同步共用同一个回环闸门
  try {
    for (const inst of instances) {
      const p = panels.get(inst.panelId);
      if (p?.view && p.viewTabId === inst.tabId) {
        p.view.view.dispatch({ changes });
      } else {
        inst.state = inst.state.update({ changes }).state;
      }
    }
  } catch {
    // 位置越界（理论上过不了 baseLen 校验才会到这里）→ 退回全文纠错
    requestDocResync(docId);
    return;
  } finally {
    setSyncingDocId(null);
    applyingRemote = false;
  }

  // 同一个文档、同一份磁盘文件：远端改了内容，本窗口这份同样算「有未保存修改」。
  // 不能指望 handleUpdate —— 远端变更被 syncingDocId 抑制，走不到置脏那一段。
  // ⚠️ 也不在这里排自动保存/热退出：那些由**动手编辑的那个窗口**负责，两边都写
  // 同一个文件只会互相触发 file-changed。
  const doc = docs.get(docId);
  if (doc && !doc.dirty) {
    // 同样按「是否偏离基线」判（B112）：远端恰好把内容改回原样时就不该变脏。
    // ⚠️ 保留 `doc.dirty = true` 直写——这里只是补上被 syncingDocId 抑制的置脏，
    // 不是内容回到基线的场景，用不着走 refreshTitle/renderPanelTabs 之外的逻辑。
    if (isDirtyVsBaseline(doc, freshTextOfDoc(doc))) {
      doc.dirty = true;
      refreshTitle();
      renderPanelTabs();
    }
  }
  scheduleSessionSave();
}

/** 请对端把全文发过来：只在侦测到分叉时的一次性纠错，不是常规路径。 */
function requestDocResync(docId: number): void {
  if (resyncPending.has(docId)) return;
  resyncPending.add(docId);
  window.setTimeout(() => resyncPending.delete(docId), 2000);
  void emitCrossWindow(EVT_DOC_RESYNC_REQ, { docId }).catch(() => {});
}

/** 收到全文纠错请求：本窗口持有该文档就回一份全文（两边取到的内容相同）。 */
function answerDocResync(payload: DocChangePayload | null): void {
  const docId = payload?.docId;
  if (!payload?.from || payload.from === windowLabel || typeof docId !== "number") return;
  const text = textOfDocId(docId);
  if (text === null) return;
  void emitTo(payload.from, EVT_DOC_RESYNC_FULL, {
    from: windowLabel,
    docId,
    text,
  }).catch(() => {});
}

/**
 * 收到全文纠错应答：把本窗口该文档的正文换成对端的。
 *
 * ⚠️ 这一步会**丢弃本窗口的正文**，所以加了闸门：本地有未保存修改时自动纠正可能
 * 正好把用户刚敲的东西抹掉（分叉意味着谁更新已经无从判断）。这时只提示、不动手，
 * 把选择权交回用户。
 */
function applyDocResyncFull(
  payload: { from?: string; docId?: number; text?: string } | null,
): void {
  const { from, docId, text } = payload ?? {};
  if (!from || from === windowLabel || typeof docId !== "number" || typeof text !== "string") {
    return;
  }
  const instances = [...tabs.values()].filter((t) => t.docId === docId);
  if (instances.length === 0) return;
  const doc = docs.get(docId);
  if (doc?.dirty) {
    showMessage(`${doc.name} 在两个窗口的内容已不一致，为避免覆盖未保存的修改请手动处理`, true);
    return;
  }
  applyingRemote = true;
  setSyncingDocId(docId);
  try {
    for (const inst of instances) {
      const p = panels.get(inst.panelId);
      const view = p && p.viewTabId === inst.tabId ? p.view : null;
      // 基准取**挂载中的视图状态**（同 freshTextOfDoc 的口径）：快照与视图万一短暂不一致，
      // 按快照算出的整段替换会把视图拽回旧长度。
      const base = view ? view.view.state : inst.state;
      const whole = base.update({
        changes: { from: 0, to: base.doc.length, insert: text },
      }).state;
      // 整态重建：只 dispatch changes 的话 tab.state 与视图会不同步（后续切标签立刻串档）
      if (view) {
        // 同步滚动 v1：整态重建会归零重排，滚动不是用户造成的；给该 docId 上结构性锁，
        // 吞没同 docId 其它视口的自动跳变 / 调回顶部（锁挂到用户手势或 ~1s 兜底）。
        syncCoordinator.suppressStructural(String(inst.docId));
        view.setState(whole);
      }
      inst.state = whole;
      // 同步滚动的重落 / 还原逻辑已在重构清除：整段替换后
      // 不再把视图按旧视口位置还回去。
    }
  } finally {
    setSyncingDocId(null);
    applyingRemote = false;
  }
  if (doc) {
    showMessage(`${doc.name} 已按另一个窗口的内容重新同步`);
    refreshTitle();
    renderPanelTabs();
  }
}

/** 注册跨窗口同步的监听（两种窗口都要装，见 listenDocSync 的调用点）。 */
function listenDocSync(): void {
  void listen<DocChangePayload>("doc-change", (e) => applyRemoteDocChange(e.payload ?? null)).catch(
    () => {},
  );
  void listen<DocChangePayload>("doc-resync-request", (e) =>
    answerDocResync(e.payload ?? null),
  ).catch(() => {});
  void listen<{ from?: string; docId?: number; text?: string }>("doc-resync-full", (e) =>
    applyDocResyncFull(e.payload ?? null),
  ).catch(() => {});
  // B178：跨窗口「这份文档在别的窗口还开着吗」的存在性登记（让同步键在主/子窗口同显隐）。
  // 按 `from`（窗口标签）记进 `remoteOpenByWindow`，自己的回声一律丢（与上面几条同口径）。
  // B159：同步滚动的跨窗口开关 / 位置广播已在重构整体清除，这里不再注册任何相关监听。
  void listen<DocPresencePayload>(EVT_DOC_OPEN, (e) => {
    const p = e.payload;
    if (!p?.docId || !p.from || p.from === windowLabel) return;
    let s = remoteOpenByWindow.get(p.from);
    if (!s) {
      s = new Set<number>();
      remoteOpenByWindow.set(p.from, s);
    }
    s.add(p.docId);
    refreshSyncButton(activeTab());
  }).catch(() => {});
  void listen<DocPresencePayload>(EVT_DOC_CLOSE_NOTIFY, (e) => {
    const p = e.payload;
    if (!p?.docId || !p.from || p.from === windowLabel) return;
    remoteOpenByWindow.get(p.from)?.delete(p.docId);
    refreshSyncButton(activeTab());
  }).catch(() => {});
  // 新窗口上线问了一圈，这里把本窗口当前可见集合重播一遍（idempotent，重复加无害）。
  void listen<{ from?: string }>(EVT_DOC_OPEN_RESYNC, (e) => {
    const p = e.payload;
    if (!p?.from || p.from === windowLabel) return;
    for (const t of tabs.values()) {
      if (t.panelId >= 0) {
        void emitCrossWindow(EVT_DOC_OPEN, { docId: t.docId }).catch(() => {});
      }
    }
  }).catch(() => {});
  // 卫星窗口干净关窗通知：清掉它那条，主窗口那份同文档的同步键随之收起。
  void listen<{ from?: string }>(EVT_WINDOW_CLOSED, (e) => {
    const p = e.payload;
    if (!p?.from || p.from === windowLabel) return;
    remoteOpenByWindow.delete(p.from);
    refreshSyncButton(activeTab());
  }).catch(() => {});
  // B161：关标签前那句「还有人拿着这份文档吗」—— 两种窗口都要接。
  // 应答由 `handleDocCloseQuery` 直接 emitTo 给发起方，所以这里只装监听、不回包。
  void listen<DocClosePayload>(EVT_DOC_CLOSE_QUERY, (e) => {
    const p = e.payload;
    // 自己的回声：广播本机也收得到（与上面几条同口径）
    if (!p?.docId || !p.from || p.from === windowLabel) return;
    handleDocCloseQuery(p.docId, p.from);
  }).catch(() => {});
}

export {
  transferSnapshotOf,
  remoteTabLocally,
  reclaimRemoted,
  openTabsInNewWindow,
  adoptTransferredTabs,
  returnTabsToMain,
  returnTabToMain,
  detachLocally,
  requestSatelliteClose,
  snapshotDrag,
  relinquishDrag,
  dropOnDesktop,
  acceptDroppedTabs,
  applyTabsReturn,
  applyBackupIds,
  reclaimFromVanished,
  dropRemotedForOwner,
  handleDocCloseQuery,
  docHeldElsewhere,
  broadcastDocChange,
  listenDocSync,
};
