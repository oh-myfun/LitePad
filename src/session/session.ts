// 会话 / 自动保存 / 热退出（从 main.ts 拆出，解耦第十一步 / #412）。
//
// 职责：会话落盘与恢复（scheduleSessionSave / persistSession / restoreSession /
// snapshotSession / refreshSession / restoreSatelliteWindows）、自动保存（scheduleAutosave）、
// 热退出副本（scheduleBackup / flushBackups / discardBackupFor / discardAllBackups）、
// 外部文件变更恢复（handleFileChanged / resolveExternalChange* / applyDiskContent /
// openDiskCopyForCompare）。权威类型在 ./store（SessionState），本模块是行为侧。
// 只依赖 core/* + ui + doc-model + editor/* + ipc + session/store，对 main.ts 零反向依赖。
//
// ⚠️ 过渡期 DI：rebuildDocInstances（→ src/io/，#414）、reclaimRemoted / openTabsInNewWindow
//    （→ src/multiwindow/，#415）已随 #414/#415 全部换成直接 import——本模块无 DI。

import {
  MAIN_WINDOW_LABEL,
  activePanelId,
  docSyncModes,
  docs,
  layout,
  panels,
  remotedTabs,
  settings,
  tabs,
  windowKind,
  windowLabel,
  setActivePanelId,
  setDocs,
  setLayout,
  setNextInstId,
  setNextPanelId,
  setTabs,
  takePanelId,
  type Doc,
  type Tab,
} from "../core/app-state";
import { activePanel, getPanel, instancesOfDoc } from "../core/panels";
import { logViewport, recordScroll, viewportOfTab } from "../core/viewport";
import { logger } from "../core/logger";
import {
  attachTabToPanel,
  isMdTab,
  makeDoc,
  makeInstance,
  markClean,
  markDiskVersion,
  registerDoc,
} from "../doc-model";
import { normalizeSizeClass } from "../editor/perf";
import {
  FileChangedPayload,
  OpenedFile,
  newTab as ipcNewTab,
  isUnicodeEncoding,
  openFile,
  reloadFile,
  saveFile,
  discardBackup,
  loadSession,
  restoreBackup,
  saveSession,
  writeBackup,
  type RestoredBackup,
  type SessionState,
  type TabSession,
} from "../ipc/api";
import { LayoutNode, leaf } from "../shell/layout";
import { showExternalConflictDialog } from "../shell/conflictdialog";
import { rememberViewScroll } from "../sync-scroll";
import { freshTextOfDoc, layoutForSession, rebuildLayout, renderPanelTabs } from "../tabs";
import { refreshAll, showMessage } from "../ui";
import { sessionStore } from "./store";
import { emitTo } from "@tauri-apps/api/event";
import { rebuildDocInstances } from "../io/files";
import { openTabsInNewWindow, reclaimRemoted } from "../multiwindow/windows";

// ---------------------------------------------------------------- 会话 / 自动保存（M2）

function scheduleSessionSave(): void {
  // 卫星窗口不碰 session.json：会话只有一份，两个窗口都写就是互相覆盖
  // （表现为「另一个窗口的标签时有时无」）。卫星窗口承载的标签由主窗口兜底持有。
  if (windowKind !== "main") {
    // 卫星窗口每次打字 / 滚动都会走到这儿，所以压到 trace（B147）。
    // 「卫星窗口怎么不写会话」要看的就是这一条 —— 它一直在跳，但主窗口的日志里
    // 一条都不该出现。
    logger.trace("session", "排程落盘 · 卫星窗口不写会话");
    return;
  }
  if (sessionTimer !== null) {
    // B147：连打十几个字就是十几次重排。没有这条，日志上只剩「800ms 后落了一次」，
    // 看着像丢了数据，其实是防抖在正常工作 —— 反而更容易误判。
    logger.trace("session", "排程落盘 · 取消并重排");
    clearTimeout(sessionTimer);
  }
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    logger.debug("session", "排程落盘 · 800ms 到，开始写");
    void persistSession();
  }, 800) as unknown as number;
}

let sessionTimer: number | null = null;

/**
 * 落盘前把**当前视图**的最新状态回写进标签快照（B140）。
 *
 * 光标与视口都只活在视图 / DOM 上，而 `t.state` 只在切标签、重建布局、拖标签那几处
 * 被回写过（`switchTab` / `rebuildLayout` / `disposePanel`…）。于是「打开 → 编辑 → 移
 * 光标 → 滚动 → 直接关窗」落下去的还是**打开时**那份 —— 重启后光标与位置都回到开头。
 *
 * 放在 `snapshotSession` 开头而不是关窗那一处：防抖的 800ms 落盘、热退出、装更新前的
 * persist 走的都是这条出口，一次同步全照顾到。回写是幂等的（值就来自当下这个视图）。
 */
/**
 * 把活动态的**全部**会话信息刷进 store（B141）。
 *
 * 分两段：
 *  ① 结构 —— 面板的标签顺序 / 活动标签 / 布局 / 活动面板 / 跨窗口标签。这些变化集中在
 *     少数函数里，但落点分散（拖拽、分屏、关闭…），逐个挂 setter 容易漏，所以落盘前
 *     统一同步一次，保证**绝不**拿旧结构写盘。
 *  ② 标签记录 —— 文档字段（path / encoding / eol / backupId）从 `Doc` 取；光标与视口
 *     只活在视图 / DOM 上，从**当前正显示**的那个视图采集（同 `syncShownViewToTab`）。
 *
 * 高频又最容易丢的光标 / 视口 / 视图模式另有即时写入口（`sessionStore.setCursor` 等，
 * 挂在 `handleUpdate` 与滚动监听上）；这里是兜底，两者不冲突 —— setter 写的是同一份记录。
 */
function refreshSession(): void {
  const panelIndex = new Map<number, number>();
  [...panels.keys()].forEach((id, i) => panelIndex.set(id, i));

  // 清理上一轮留下、这轮已经不存在的面板与跨窗口登记
  const gonePanels: string[] = [];
  for (const id of sessionStore.panelIds()) {
    if (!panels.has(id)) {
      sessionStore.dropPanel(id);
      gonePanels.push(String(id));
    }
  }
  for (const p of panels.values()) {
    sessionStore.setPanel(p.panelId, p.tabs, p.activeTabId);
  }
  sessionStore.setLayout(convertLayoutForSession(layoutForSession(), panelIndex));
  sessionStore.setActivePanel(activePanelId);

  // 跨窗口标签：卫星窗口不写会话，这些由主窗口代登记
  const liveRemoted = new Set<number>();
  for (const [docId, r] of remotedTabs) {
    if (!tabs.has(r.tabId)) continue;
    sessionStore.setSatellite(docId, r.tabId, r.owner);
    liveRemoted.add(docId);
  }
  const goneSats: string[] = [];
  for (const docId of sessionStore.satelliteDocIds()) {
    if (!liveRemoted.has(docId)) {
      sessionStore.dropSatellite(docId);
      goneSats.push(String(docId));
    }
  }
  // B147：摘掉登记是正常的（面板被合并 / 标签被别的窗口收走），但「上一次的登记
  // 这轮一个都没对上」值得看一眼 —— 那往往说明有地方改了结构却忘了同步 store。
  if (gonePanels.length > 0 || goneSats.length > 0) {
    logger.trace(
      "session",
      `同步结构 · 摘掉面板 ${gonePanels.join(",") || "无"} / 跨窗口 ${goneSats.join(",") || "无"}`,
    );
  }

  for (const t of tabs.values()) {
    const d = docs.get(t.docId);
    if (!d) continue;
    if (!sessionStore.get(t.tabId)) {
      // ⚠️ 新登记的记录要**带着** `t` 里已有的视口位置进来（B145）：会话恢复的标签在
      // `restoreSession` 里已经把位置读进 `t.scrollTop`，登记成空白的话，下面那条写入
      // 又会被还原期的闸口挡掉 —— 「刚恢复出来的位置」这一轮就白恢复了。
      sessionStore.register(t.tabId, t.docId, { scrollTop: t.scrollTop });
    }
    sessionStore.setDoc(t.tabId, {
      path: d.path ?? "",
      encoding: d.encoding,
      eol: d.eol,
      backupId: d.backupId,
    });
    sessionStore.setViewMode(t.tabId, isMdTab(t) ? t.viewMode : null);
    // B169：同步滚动开关是 `docSyncModes`（按文档记，B152）里的值，退出前刷进记录，
    // 落盘后重开时由 `restoreSession` 写回，让同步键点亮态与退出前一致。
    sessionStore.setSyncMode(t.tabId, docSyncModes.get(t.docId) === true);
    // 正显示在面板上的那个：光标与视口都在视图 / DOM 上，先采一次再写进记录
    // （同 B140 的「消失前看最后一眼」，只不过现在写的是 store 而不是 Tab）。
    // 其余标签的光标在 `handleUpdate` 里就已经即时写进来了，这里不动它。
    //
    // ⚠️ 读容器的那一下由 `rememberViewScroll` 自己把关（B145）：它认 `pinInFlight`，
    // 钉位置还在重试时一个字都不采；写记录走 `recordScroll`，还原期一律挡掉。
    const p = panels.get(t.panelId);
    if (p?.view && p.viewTabId === t.tabId) {
      t.state = p.view.view.state;
      const pos = t.state.selection.main.head;
      const line = t.state.doc.lineAt(pos);
      sessionStore.setCursor(t.tabId, line.number, pos - line.from + 1);
      rememberViewScroll(p);
    }
    // ⚠️ 这一条走 `recordScroll` 而不是直连 store（B145 单一闸口）：落盘前的这次刷新
    // 读的是 `t`，而 `t` 里的位置可能正好来自「刚钉、还没立住」的容器。
    recordScroll(t.tabId, viewportOfTab(t));
  }
}

// B141：`sessionTabRecordOf` 已删除 —— 标签的会话记录现在由 `sessionStore`（`src/session/store.ts`
// 的 `toDisk`）产出，会话只有一个出口。面板标签与跨窗口标签共用同一份记录，不再各拼一次。

/**
 * 这个标签**为什么**没进会话（进了返回 null）（B147）。
 *
 * 「我的标签怎么重启后没了」只有一种答案：这里的某一条判据拦下了它。以前这个判定
 * 是纯布尔的、一个字都不留 —— 于是文件被删了、热退出没开、文档正脏着，三种情况
 * 全都是「消失了」，查起来只能靠猜。现在判断与**理由**分开，理由进日志。
 */
function sessionRejectReason(t: Tab): string | null {
  const d = docs.get(t.docId);
  if (!d) return "文档已不存在";
  // B68：有磁盘路径的照旧入会话；没有路径的未命名文档，只有在
  // 备份区里确实存着副本时才值得留住（否则恢复时无据可依，只会白占一行）。
  if (d.path) return null;
  if (d.backedUp) return null;
  // B69：热退出开着时，**空的**未命名文档也要留住。它没有内容要救，
  // 但标签本身该原样回来——「新建了还没开始打字」不该重启后凭空消失。
  //
  // ⚠️ 判定必须是「无路径 **且 不脏**」：脏、却又没备份成功的未命名文档
  // 绝不能按空文档恢复，那会把用户打的字真的丢掉。那种情况只能走
  // 关窗确认框（快照里没有它 → 恢复时也不会被当成空文档）。
  if (settings?.hot_exit !== true) return "无路径且无副本（热退出未开）";
  if (d.dirty) return "无路径且脏（不进会话，避免被当成空文档丢掉内容）";
  return null;
}

/** 该文档值不值得进会话（B68/B69 的判据；面板标签与隐藏实例共用）。 */
function sessionWorthy(t: Tab): boolean {
  return sessionRejectReason(t) === null;
}

/**
 * 会话摘要（B147，一行装完）。
 *
 * 「会话写不进去」「会话里少了标签」这两类问题最难查的地方在于：日志上只留一句
 * `save failed: …`，要写的是什么、少了谁全看不出来。所以落盘前后各记一次 ——
 * 前后一比就知道内容压根有没有进去。标签多的会话只打前 8 个：一行几十 KB
 * 会把 2MB 的日志冲掉。
 */
function sessionSummary(s: SessionState, skipped: string[] = []): string {
  const all = s.panels.flatMap((p) => p.tabs);
  const total = all.length + (s.satelliteTabs?.length ?? 0);
  const shown = all.slice(0, 8);
  const body = shown
    .map(
      (t) =>
        `${t.path || "(未命名)"}|行${t.cursorLine}:${t.cursorCol}|位${t.scrollTop ?? "-"}${
          t.viewMode ? `|${t.viewMode}` : ""
        }`,
    )
    .join("  ");
  const rest = total - shown.length;
  return [
    `面板=${s.panels.length} 标签=${total}`,
    `活动面板=${s.activePanel}`,
    body,
    rest > 0 ? `…另 ${rest} 个` : "",
    skipped.length > 0
      ? `未入会话 ${skipped.length}：${skipped.slice(0, 4).join("，")}${
          skipped.length > 4 ? "…" : ""
        }`
      : "",
  ]
    .filter((x) => x !== "")
    .join(" ");
}

function snapshotSession(): Parameters<typeof saveSession>[0] {
  // B141：会话不再现场拼装 —— 先把活动态刷进 store，再把那份记录序列化出去。
  refreshSession();
  const skipped: string[] = [];
  const s = sessionStore.toSessionState((tabId) => {
    const t = tabs.get(tabId);
    if (!t) return false;
    if (sessionWorthy(t)) return true;
    const why = sessionRejectReason(t);
    skipped.push(`${docs.get(t.docId)?.name ?? `#${t.docId}`}${why ? `（${why}）` : ""}`);
    return false;
  });
  // 「标签一个都没进会话」是「重启后全没了」的唯一成因，以前完全静默（B147）。
  if (skipped.length > 0 && s.panels.every((p) => p.tabs.length === 0)) {
    logger.warn(
      "session",
      `快照里一个标签都留不下（${skipped.length} 个被拦下：${skipped
        .slice(0, 4)
        .join("；")}）→ 下次启动会回到空白窗口`,
    );
  }
  logger.debug("session", `快照 · ${sessionSummary(s, skipped)}`);
  return s;
}

/** 布局树叶子 panelId → 会话面板索引（JSON 深拷贝）。 */
function convertLayoutForSession(node: LayoutNode, panelIndex: Map<number, number>): unknown {
  if (node.kind === "leaf") {
    return { kind: "leaf", panelId: panelIndex.get(node.panelId) ?? 0 };
  }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: convertLayoutForSession(node.a, panelIndex),
    b: convertLayoutForSession(node.b, panelIndex),
  };
}

async function persistSession(): Promise<void> {
  try {
    // 落盘前看一眼：写进去的位置是哪一步留下的，下次启动会照这个回来
    logViewport("保存 · 快照前", activePanel() ?? undefined);
    const s = snapshotSession();
    // 写出前先记一份：失败时才有「本来要写的是什么」可对（B147）。
    logger.debug("session", `保存 · 写出 ${sessionSummary(s)}`);
    await saveSession(s);
    logger.trace("session", "保存 · 已交给后端");
  } catch (e) {
    // B143：这里原来是**静默**吞掉的。整份会话写不进去时界面上一点迹象都没有
    // （只表现为「位置/光标不再刷新」），排查只能靠猜 —— 小数 scrollTop 让 Rust 侧
    // 反序列化失败那次就是这么被藏起来的。至少留一条日志。
    logger.warn("session", `保存失败：${String(e)}`);
  }
}

/** 启动时恢复上次会话：按保存的布局树重建面板，逐个打开文件并恢复光标。失败返回 false（退回空白标签）。 */
async function restoreSession(): Promise<boolean> {
  let sess: SessionState | null;
  try {
    sess = await loadSession();
  } catch (e) {
    // B147：这里是整条恢复链的第一道口子，以前却是纯静默 —— 「重启后什么都没恢复」
    // 只能靠猜到底是盘坏了还是路径不对。
    logger.warn("session", `读盘失败 · 按空会话启动：${String(e)}`);
    return false;
  }
  const sp = sess?.panels;
  if (!sess || !sp || sp.length === 0) {
    // 「没恢复」有两种完全不同的成因，日志上必须分得开（B147）：盘上压根没有
    // 会话文件（首次启动，或上次关窗时会话本来就是空的），和读得到但解析不出来。
    logger.info(
      "session",
      sp?.length ? "会话里没有标签 · 按空白标签启动" : "没有会话文件 · 按空白标签启动",
    );
    return false;
  }
  logger.debug(
    "session",
    `读盘 · 面板=${sp.length} 标签=${sp.reduce((n, p) => n + p.tabs.length, 0)} 卫星=${
      sess.satelliteTabs?.length ?? 0
    } 活动面板=${sess.activePanel}`,
  );
  // B193：卫星标签**不再并回主窗口** —— 按 `owner` 分组，各组还原成一个**真实的卫星
  // 窗口**（分组与开窗见下方 `restoreSatellites`）。v1 把它们 append 进 `sp[0].tabs`，
  // 于是「拖到子窗口的标签」重启后全跑回主窗口，多窗口布局丢得干干净净 —— 那正是
  // 用户报的「satelliteTabs 没有按照卫星窗口方式进行恢复」。
  const satTabs = sess.satelliteTabs ?? [];
  if (!sp.some((p) => p.tabs.length > 0) && satTabs.length === 0) return false;
  const panels0 = sp;

  panels.clear();
  setTabs(new Map());
  setDocs(new Map());
  setNextPanelId(1);
  setNextInstId(1);

  // 会话面板索引 → 真实面板 id（随布局树叶子创建）
  const idMap = new Map<number, number>();

  function ensurePanel(idx: number): LayoutNode {
    let realId = idMap.get(idx);
    if (realId === undefined) {
      realId = takePanelId();
      panels.set(realId, {
        panelId: realId,
        tabs: [],
        activeTabId: -1,
        view: null,
        viewTabId: null,
        preview: null,
        previewTimer: null,
        bodyEl: null,
      });
      idMap.set(idx, realId);
    }
    return leaf(realId);
  }

  function buildTree(node: unknown): LayoutNode {
    const n = node as {
      kind?: string;
      dir?: string;
      ratio?: number;
      a?: unknown;
      b?: unknown;
      panelId?: number;
    } | null;
    if (n && n.kind === "split") {
      return {
        kind: "split",
        dir: n.dir === "v" ? "v" : "h",
        ratio: typeof n.ratio === "number" && n.ratio > 0 && n.ratio < 1 ? n.ratio : 0.5,
        a: buildTree(n.a),
        b: buildTree(n.b),
      };
    }
    if (n && typeof n.panelId === "number" && n.panelId >= 0 && n.panelId < panels0.length) {
      return ensurePanel(n.panelId);
    }
    // 无效叶子：用尚未分配的会话面板索引补位
    for (let i = 0; i < panels0.length; i++) {
      if (!idMap.has(i)) return ensurePanel(i);
    }
    return ensurePanel(0);
  }

  try {
    setLayout(buildTree(sess.layout));
  } catch (e) {
    // 布局树解析失败 = 整个会话没法照原样摆回去，此时继续恢复标签只会得到一堆
    // 位置错乱的面板 —— 退回空白标签。但「为什么整份都不要了」必须留下来（B147）。
    logger.warn("session", `布局树解析失败 · 整份会话作废：${String(e)}`);
    return false;
  }
  // 会话面板没全部落到布局树（索引越界等）→ 追加水平分屏兜底
  for (let i = 0; i < panels0.length; i++) {
    if (!idMap.has(i)) {
      setLayout({ kind: "split", dir: "h", ratio: 0.5, a: layout, b: ensurePanel(i) });
    }
  }

  // 预取：并行发起所有标签的读取。
  //
  // B68 起是「**副本优先、文件兜底**」：备份区里还留着副本，就说明上次关窗时
  // 该文档是脏的，副本内容才是用户最后看到的东西；副本不在（已保存 / 已被丢弃 /
  // 写失败）才按路径读原文件。未命名文档没有路径，只能靠副本。
  //
  // 去重按**文档身份**（有 path 就是 path；未命名但有副本的用副本 ID；
  // 空的未命名文档用 B69 的 docId），**不带面板索引**：
  // 同一个文件可以同时在多个面板打开并共用同一份 doc（同源多实例），只该读一次盘。
  // ⚠️ 这里必须跨面板去重，而不能每个面板各取一次——`restore_backup` 每次都新建
  // 一个标签，取两次就会得到两份**互不同步**的文档，把「同源多实例」悄悄破坏掉。
  type Restored =
    | { kind: "backup"; data: RestoredBackup }
    | { kind: "file"; data: OpenedFile }
    /** B69：空的未命名文档——会话里既没路径也没副本，内容本来就是空的 */
    | { kind: "empty"; data: OpenedFile };
  /** 认不出身份返回空串（旧版本落盘的会话不会写出这种标签，直接跳过）。 */
  const identityOf = (st: {
    path: string;
    backupId?: string | null;
    docId?: number | null;
  }): string =>
    st.path || (st.backupId ? `#${st.backupId}` : st.docId != null ? `#doc:${st.docId}` : "");

  const pending: Array<{
    key: string;
    path: string;
    encoding: string | null;
    eol: string | null;
    backupId: string | null;
  }> = [];
  // 主窗口各面板的标签 **+ B193 卫星标签**：按身份去重后统一下去预取，两边共用同一份
  // 缓存（同一个文件同时开在主窗口和卫星窗口时只读一次盘）。
  for (const st of [...panels0.flatMap((p) => p.tabs), ...satTabs]) {
    const backupId = st.backupId ?? null;
    const key = identityOf(st);
    if (!key) continue; // 认不出身份 → 跳过（见 identityOf 注释）
    if (!pending.some((p) => p.key === key)) {
      pending.push({
        key,
        path: st.path,
        encoding: st.encoding ?? null,
        eol: st.eol ?? null,
        backupId,
      });
    }
  }
  const restoredCache = new Map<string, Restored>();
  /** 被跳过的标签（带上原因），收尾时一次打出来（B147）。 */
  const dropped: string[] = [];
  await Promise.all(
    pending.map(async (p) => {
      if (p.backupId) {
        try {
          const backup = await restoreBackup(p.backupId);
          if (backup) {
            restoredCache.set(p.key, { kind: "backup", data: backup });
            return;
          }
          dropped.push(`${p.path || "未命名"}：副本读出来是空的，改按路径打开`);
        } catch (e) {
          dropped.push(`${p.path || "未命名"}：副本读不了（${String(e)}），改按路径打开`);
        }
      }
      // B69：既没有路径、又没有副本 ⇒ 上次关窗时这是一个**空的**未命名文档。
      // 内容本来就是空的，不需要副本（也没东西可写），直接开一个空白文档即可。
      //
      // ⚠️ 走到这里的前提是「不脏」——快照只在 `!d.dirty` 时才写这种标签，
      // 所以不存在「有内容却被当成空文档恢复」的风险（那会真的丢字）。
      if (!p.path) {
        try {
          const info = await ipcNewTab(p.encoding);
          restoredCache.set(p.key, {
            kind: "empty",
            data: {
              tabId: info.tabId,
              reused: false,
              path: "",
              name: info.name,
              text: "",
              encoding: info.encoding,
              eol: p.eol || info.eol,
              mixedEol: false,
              readonly: info.readonly,
              size: 0,
              lossy: false,
              sizeClass: "normal",
              sizeHint: "",
              mtimeMs: 0,
            },
          });
        } catch (e) {
          dropped.push(`未命名#${p.key}：建不出空白文档（${String(e)}）`);
        }
        return;
      }
      try {
        restoredCache.set(p.key, { kind: "file", data: await openFile(p.path, p.encoding) });
      } catch (e) {
        dropped.push(`${p.path}：文件读不了（${String(e)}）`);
      }
    }),
  );
  if (dropped.length > 0) {
    // 预取阶段的失败**不致命**（会退回按路径打开），所以只是 debug（B147）。
    // 但「副本没生效 / 文件被删了」这种正是用户报症状的起点，不能一句话不留。
    logger.debug("session", `预取跳过 ${dropped.length} 项：${dropped.slice(0, 4).join("；")}`);
  }

  /**
   * 按一条会话记录建实例（文档按需创建、同源复用），并把光标 / 视图模式 / 视口 /
   * 同步开关一并带回去。主窗口面板与 B193 卫星标签**共用这一条** —— 副本优先、
   * 按身份去重、光标恢复这些口径必须完全一致，写两遍就会悄悄分叉。
   *
   * `panelId = -1` = **隐藏实例**：不进任何面板（标签条上看不见），是卫星标签
   * 交给窗口前的暂存态；等 `openTabsInNewWindow` 接手后经 `remoteTabLocally`
   * 登记成「已借出」，才会进会话的 `satelliteTabs` 段。
   */
  function buildInstance(st: TabSession, panelId: number): Tab | null {
    const hit = restoredCache.get(identityOf(st));
    if (!hit) return null;
    const src = hit.data;
    let doc = docs.get(src.tabId);
    if (!doc) {
      doc = makeDoc(
        src.tabId,
        src.text,
        src.name,
        src.path || null,
        src.encoding,
        src.eol,
        src.readonly,
        normalizeSizeClass(src.sizeClass),
        st.backupId ?? null,
      );
      doc.mixedEol = src.mixedEol;
      if (hit.kind === "backup") {
        // 副本还原 = 原样回到「有未保存修改」的状态：
        // 脏 + 已知副本存在，于是关窗依旧不需要确认框。
        doc.dirty = true;
        doc.backedUp = true;
        // 副本里只有「改过之后」的正文，**原文件长什么样并不知道** ⇒ 没有基线，
        // 只能等用户保存时重新钉（在此之前撤销多少次都不会自己转干净）。
        doc.baseline = null;
        // 已知版本无从得知（副本里不存 mtime），留 0：于是接下来的第一个
        // file-changed 一定被判成外部改动 —— 这份本来就脏，正是要弹冲突框的情形。
      } else if (hit.kind === "file") {
        markDiskVersion(doc, hit.data.mtimeMs, hit.data.size);
      }
      registerDoc(doc);
    }
    // 同一路径出现在多个面板：各建一个同源实例（内容自动同步）
    const inst = makeInstance(doc, panelId, src.text);
    tabs.set(inst.tabId, inst);
    // 恢复 Markdown 视图模式（旧版 "split" 映射回 source）
    if (isMdTab(inst) && (st.viewMode === "source" || st.viewMode === "preview")) {
      inst.viewMode = st.viewMode;
    }
    // 恢复光标（实例独立）
    const lineNo = Math.min(Math.max(1, st.cursorLine || 1), inst.state.doc.lines);
    const line = inst.state.doc.line(lineNo);
    const pos = line.from + Math.min(Math.max(0, (st.cursorCol || 1) - 1), line.length);
    inst.state = inst.state.update({ selection: { anchor: pos } }).state;
    // B126：视口位置一并带回（null = 旧会话没有这个字段 → 切过去时保证光标可见）
    inst.scrollTop = st.scrollTop ?? null;
    // B169：同步滚动开关（按文档记）→ 写回 `docSyncModes`，同步键点亮态与退出前一致
    if (st.syncMode) docSyncModes.set(inst.docId, true);
    return inst;
  }

  // 逐面板恢复标签
  let opened = 0;
  for (let i = 0; i < panels0.length; i++) {
    const spanel = panels0[i];
    const panel = panels.get(idMap.get(i)!);
    if (!panel) continue;
    for (const st of spanel.tabs) {
      try {
        const inst = buildInstance(st, panel.panelId);
        if (!inst) continue;
        panel.tabs.push(inst.tabId);
        opened++;
      } catch (e) {
        // 文件已被删除/无法读取 → 跳过该标签。静默过（B143 那类帮凶）：跳了几个、
        // 为什么跳，日志上完全看不出来，重启后就只剩「我的文件没了」。
        dropped.push(`${st.path || "未命名"}：恢复实例失败（${String(e)}）`);
      }
    }
    if (panel.tabs.length > 0) {
      const active = Math.min(Math.max(0, spanel.active), panel.tabs.length - 1);
      panel.activeTabId = panel.tabs[active];
    }
  }

  // B193：卫星标签 → 按 `owner` 分组，各组先落成隐藏实例（下一步交给一个真实卫星窗口）
  const satGroups: Array<{ owner: string; tabIds: number[] }> = [];
  {
    const byOwner = new Map<string, number[]>();
    for (const st of satTabs) {
      // 旧会话没有 `owner` 字段 → 整批归到同一组（退回「一个卫星窗口」的口径）
      const key = st.owner ?? "";
      try {
        const inst = buildInstance(st, -1);
        if (!inst) continue;
        const g = byOwner.get(key);
        if (g) g.push(inst.tabId);
        else byOwner.set(key, [inst.tabId]);
        opened++;
      } catch (e) {
        dropped.push(`${st.path || "未命名"}：恢复卫星实例失败（${String(e)}）`);
      }
    }
    for (const [owner, tabIds] of byOwner) satGroups.push({ owner, tabIds });
  }

  if (opened === 0) {
    // B147：一个都没恢复出来时，前面攒下的 every 条跳过原因全在这一刻才有意义 ——
    // 「文件全被删了」和「会话格式不对」看起来都是空白窗口，只有这一条分得开。
    logger.warn(
      "session",
      `一个标签都没恢复 · 退回空白窗口（跳过 ${dropped.length} 项：${
        dropped.slice(0, 4).join("；") || "无"
      }）`,
    );
    panels.clear();
    setTabs(new Map());
    setDocs(new Map());
    return false;
  }

  setActivePanelId(idMap.get(sess.activePanel) ?? [...panels.keys()][0]);
  if (!panels.has(activePanelId)) setActivePanelId([...panels.keys()][0]);
  // 恢复完看一眼：盘上的位置是怎么落到视图上的（「滚到一半闪回开头」要看这里）
  logViewport("加载 · 会话恢复后", getPanel(activePanelId) ?? undefined);
  // B147：这里给出「恢复了什么、丢了什么」的整体结论。上游 bootstrap 那一条 info
  // 只报数量，报不出「丢了哪个文件」—— 而那正是用户报症状时唯一想知道的。
  logger.debug(
    "session",
    `恢复完成 · 打开 ${opened} 个标签 / ${panels.size} 个面板，跳过 ${dropped.length} 项：${
      dropped.slice(0, 4).join("；") || "无"
    }`,
  );
  // B193：卫星标签交给真实卫星窗口（一组一个）。**不 await** —— 开窗要等新窗口就绪
  // 应答（每个最长 6s），串行等下去会把主窗口一起拖住；异步起跑，主窗口立即可用。
  if (satGroups.length > 0) {
    logger.info("session", `恢复 ${satGroups.length} 个卫星窗口（${satTabs.length} 个标签）`);
    void restoreSatelliteWindows(satGroups);
  }
  return true;
}

/**
 * B193：把会话里的卫星标签交给**真实的卫星窗口**（一个 owner 组 → 一个窗口）。
 *
 * 标签在 `restoreSession` 里已先落成隐藏实例（`panelId = -1`），这里只负责把它们
 * 送进窗口 —— 走的是和用户手动「拖到新窗口」完全相同的 `openTabsInNewWindow`，
 * 于是快照、跨窗口交接、`remotedTabs` 登记、会话回写这些口径天然一致。
 *
 * ⚠️ **兜底是必须的**：`openTabsInNewWindow` 失败时（建窗被拒 / 就绪超时）它**不会**
 * 摘掉本地标签 —— 那些实例此刻仍是隐藏态（panelId = -1 且没进 `remotedTabs`）：
 * 既不在任何面板里、也写不进会话 ⇒ 用户的字会凭空消失。所以每批跑完必须把
 * 「没被接走」的隐藏实例收回主窗口（退回 v1 的并回口径，至少不丢内容）。
 */
async function restoreSatelliteWindows(
  groups: Array<{ owner: string; tabIds: number[] }>,
): Promise<void> {
  for (const g of groups) {
    try {
      await openTabsInNewWindow(g.tabIds);
    } catch (e) {
      // ⚠️ 必须兜住：这条链上任何一处抛异常都会跳过 `remoteTabLocally`，若不接住，
      // 整批标签就停在隐藏态（不进面板、也不写会话）⇒ 用户的字凭空消失，
      // 而且一组失败会连带拖死后面所有分组。
      logger.error("window", `恢复卫星窗口失败（${g.tabIds.length} 个标签）：${String(e)}`);
    }
    for (const tabId of g.tabIds) {
      const t = tabs.get(tabId);
      // 还挂在 -1 且没被登记成「已借出」⇒ 窗口没接走 → 收回主窗口
      if (t && t.panelId === -1 && !remotedTabs.has(t.docId)) reclaimRemoted(tabId);
    }
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
}

let autosaveTimer: number | null = null;

/** 自动保存：仅对已关联磁盘且 Unicode 编码的脏文档（无 lossy 风险），1.5s 防抖。 */
function scheduleAutosave(): void {
  if (!settings?.autosave) return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void (async () => {
      let savedAny = false;
      for (const doc of docs.values()) {
        if (!doc.dirty || !doc.path || doc.readonly) continue;
        if (!isUnicodeEncoding(doc.encoding)) continue;
        const text = freshTextOfDoc(doc);
        if (text === null) continue;
        try {
          const outcome = await saveFile({
            tabId: doc.tabId,
            text,
            encoding: doc.encoding,
            eol: doc.eol,
            path: null,
            expectMtimeMs: doc.diskMtimeMs > 0 ? doc.diskMtimeMs : null,
            expectSize: doc.diskMtimeMs > 0 ? doc.diskSize : null,
          });
          // 撞冲突（磁盘版本被外部改过）→ **静默跳过**：自动保存既不能在用户打字时
          // 弹模态框，也不能替他盖掉外部的新版本。文档保持脏，手动保存时会再问一次。
          if (outcome.kind === "conflict") continue;
          const saved = outcome.value;
          // 写出去的就是新的基线（正文 + 编码 + 行尾）
          markClean(doc, text);
          doc.external = false;
          markDiskVersion(doc, saved.mtimeMs, saved.size);
          // 内容已经落盘，备份区里的副本就成了「过期快照」——留着会让下次启动
          // 拿旧内容顶掉用户的已保存版本。必须在转干净的同时丢弃。
          discardBackupFor(doc);
          savedAny = true;
        } catch (e) {
          // 单个文档保存失败不打断其余。⚠️ 静默过（B147）：自动保存是**用户以为存了**
          // 的那条路径，写失败却一声不响，等于把「没存上」伪装成「存好了」。
          logger.warn("save", `自动保存失败（${doc.name}）：${String(e)}`);
        }
      }
      if (savedAny) {
        refreshAll();
        showMessage("已自动保存");
      }
    })();
  }, 1500) as unknown as number;
}

// ---------------------------------------------------------------- 热退出（B68）
//
// 与自动保存是两件事，别混：
//   自动保存 → 写**原文件**，脏标记随之清除；
//   热退出  → 写 %APPDATA%\LitePad\backups 里的**独立副本**，原文件一个字节不动。
// 正因为原文件不动，「关窗」才有了另一种处理方式：内容没丢，不必再问
// 「未保存的内容将丢失」。VS Code 里这个职责属于 files.hotExit 而不是 autoSave。
//
// 对应 VS Code 的 WorkingCopyBackupTracker：内容一变就防抖排一次备份，
// 而不是攒到关窗才写——这样强杀进程（任务管理器 / 断电）也能捞回未保存内容。

/**
 * 单个副本的体积上限（字符数）。
 *
 * 超过 2 MB 的文档不写副本：这类文档每次按键都要重写几 MB 到几十 MB，
 * 副本本身也极占地方（备份区落在 %APPDATA% 这个用户配置目录里）。
 * 它们关窗时退回确认框，行为与 B68 之前一致——宁可多问一句，不要拖垮交互。
 */
const BACKUP_MAX_CHARS = 2 * 1024 * 1024;

/**
 * 副本 ID：32 位十六进制 + 连字符。
 *
 * ⚠️ 字符集必须与 Rust `backup::is_valid_id` 的白名单一致（ASCII 字母数字与连字符）。
 * 这个 ID 由前端生成后直接参与拼路径，一旦掺进 `/` 或 `..` 就能写到备份区之外。
 */
function newBackupId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

let backupTimer: number | null = null;

/** 热退出：把脏文档排进副本队列（1s 防抖，与 VS Code 的备份节奏一致）。 */
function scheduleBackup(): void {
  if (!settings?.hot_exit) return;
  if (backupTimer !== null) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void flushBackups();
  }, 1000) as unknown as number;
}

/** 取消排队的备份（关窗前要换成「立刻写」）。 */
function cancelPendingBackup(): void {
  if (backupTimer !== null) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
}

/**
 * 立刻把所有脏文档写进备份区，返回**没能备份成功**的文档数。
 *
 * 返回值 0 是「关窗可以不弹确认框」的唯一充分条件，所以判定必须严格：
 * 正文取不到、体积超限、写盘失败都计入失败，绝不假装成功——
 * 一旦这里虚报成功，用户的未保存内容就真的没了。
 */
async function flushBackups(): Promise<number> {
  if (!settings?.hot_exit) return 0;
  let failed = 0;
  let assignedNewId = false;
  const jobs: Promise<void>[] = [];

  for (const doc of docs.values()) {
    if (!doc.dirty) continue;
    const text = freshTextOfDoc(doc);
    if (text === null || text.length > BACKUP_MAX_CHARS) {
      failed++;
      // ⚠️ 这里静默过（B147）：撑爆体积上限 / 正文取不到，都是「这份内容这次没兜住」，
      // 归到 failed 里行为是对的（关窗会弹确认框），但没留痕就等于让排查的人去猜。
      logger.warn(
        "hot-exit",
        text === null
          ? `副本未写：取不到正文（${doc.name}）`
          : `副本未写：超过 ${BACKUP_MAX_CHARS} 字符上限（${doc.name}，${text.length} 字）`,
      );
      continue;
    }
    if (!doc.backupId) {
      doc.backupId = newBackupId();
      assignedNewId = true;
    }
    const id = doc.backupId;
    jobs.push(
      writeBackup({
        id,
        text,
        path: doc.path ?? "",
        name: doc.name,
        encoding: doc.encoding,
        eol: doc.eol,
        mixedEol: doc.mixedEol,
      })
        .then(() => {
          doc.backedUp = true;
        })
        .catch((e) => {
          failed++;
          // B147：副本写失败 = 这份未保存内容**一点兜底都没有**。上面 `failed++`
          // 让关窗时该弹的确认框照弹（行为是对的），可「为什么没备上」一个字都留不下。
          logger.warn("hot-exit", `副本写入失败（${doc.name}）：${String(e)}`);
        }),
    );
  }

  // 新分配的 ID 要尽快落到会话里：强杀进程时全靠会话把副本认领回来，
  // 晚一步落盘就等于白写了一份没人认领的副本。
  if (assignedNewId) {
    scheduleSessionSave();
    // B71 ④：卫星窗口新分配的副本 ID 必须同步给主窗口 —— 会话只有主窗口在写，
    // 主窗口不知道这个 ID 的话，重启时会拿**旧的** backupId（或干脆没有）去恢复，
    // 用户真正最后看到的内容反而成了没人认领的孤儿副本被清掉。
    if (windowKind === "satellite") {
      const assigned = [...docs.values()]
        .filter((d) => d.backupId)
        .map((d) => ({ docId: d.tabId, backupId: d.backupId, backedUp: d.backedUp }));
      void emitTo(MAIN_WINDOW_LABEL, "backup-ids", { from: windowLabel, docs: assigned }).catch(
        (e: unknown) => {
          // 交不出去不影响安全（副本已经写好了，下次启动靠会话认领），
          // 但主窗口的会话会记着旧的 backupId —— 这条值得留痕（B147）。
          logger.debug("hot-exit", `副本 ID 没交给主窗口：${String(e)}`);
        },
      );
    }
  }
  await Promise.all(jobs);
  return failed;
}

/**
 * 丢弃某文档的副本（保存成功 / 内容转干净 / 重载 / 关闭标签选「不保存」）。
 *
 * 「备份区里存着副本」≡「该文档有未保存内容」，这是恢复时唯一的判据，
 * 所以内容一旦与磁盘一致就必须立刻丢弃，否则下次启动会拿旧快照
 * 冒充用户的修改。
 */
function discardBackupFor(doc: Doc): void {
  if (!doc.backedUp || !doc.backupId) return;
  const id = doc.backupId;
  doc.backedUp = false;
  void discardBackup(id).catch(() => {
    // 删不掉不阻塞任何事：最坏只是下次启动多还原一个陈旧副本
  });
}

/** 丢弃全部副本（用户关掉热退出开关 / 应用启动后的孤儿清理之外的重置场景）。 */
function discardAllBackups(): void {
  for (const doc of docs.values()) discardBackupFor(doc);
}

/**
 * 外部修改事件的防抖窗口（ms）。
 *
 * notify（ReadDirectoryChangesW）一次保存常常连着给好几个 Modify 事件，
 * 写内容、写属性、目录项变更都会各来一次，全落在几十毫秒内。
 * 攒一下再读盘，省掉一串无意义的读盘（以及随之而来的弹框）。
 */
const EXTERNAL_DEBOUNCE_MS = 150;

/** 防抖窗口内最后一次事件的磁盘版本（以最后一次为准，中间的作废）。 */
const externalPending = new Map<number, FileChangedPayload>();
/** 每文档的防抖定时器。 */
const externalTimers = new Map<number, number>();
/** 正在处理中的文档：读盘 / 等用户选择期间不重入。 */
const externalBusy = new Set<number>();

/**
 * 外部修改事件：磁盘内容变了，把编辑器里这份同步过去（VS Code 的三态模型）。
 *
 * 三种情形：
 *   1. 磁盘内容与内存**完全一致** → 静默（外部只是重写了同样的字节）。
 *   2. 编辑器**没改过**（clean） → 直接以磁盘为准，自动重新载入（保留光标）。
 *   3. 两边**都改过** → 弹三选一：保留我的修改 / 载入磁盘版本 / 打开磁盘版本对照。
 *
 * ⚠️ 回声抑制：保存也会激起 file-changed（watcher 看的是同一个文件）。
 * 判据是「已知磁盘版本」（mtime+size），与事件里的一致就说明是自己的写入，忽略。
 */
function handleFileChanged(payload: FileChangedPayload): void {
  const doc = docs.get(payload.tabId);
  if (!doc || !doc.path) return;
  // 这份文档的正主在另一个窗口（本窗口只剩一个隐藏实例，跟着远端同步走）。
  // 两个窗口都会收到同一个事件，让对面去处理：否则会各弹一个冲突框。
  if (remotedTabs.has(payload.tabId)) return;
  if (payload.mtimeMs === doc.diskMtimeMs && payload.size === doc.diskSize) return;

  // 一次保存往往会连着给好几个 Modify 事件，攒一下再读盘
  externalPending.set(doc.tabId, payload);
  const timer = externalTimers.get(doc.tabId);
  if (timer !== undefined) clearTimeout(timer);
  externalTimers.set(
    doc.tabId,
    window.setTimeout(() => {
      externalTimers.delete(doc.tabId);
      void resolveExternalChange(doc.tabId);
    }, EXTERNAL_DEBOUNCE_MS),
  );
}

async function resolveExternalChange(tabId: number): Promise<void> {
  // 读盘 / 等用户选的过程里不许重入：否则同一个冲突会叠出好几个弹框
  if (externalBusy.has(tabId)) return;
  const payload = externalPending.get(tabId);
  if (!payload) return;
  externalPending.delete(tabId);
  const doc = docs.get(tabId);
  if (!doc || !doc.path) return;

  externalBusy.add(tabId);
  try {
    await resolveExternalChangeCore(doc, payload);
  } finally {
    externalBusy.delete(tabId);
  }
  // 处理期间又来了新事件（用户对着一个过期的弹框做了决定 / 外部又写了一次）→ 接着处理
  if (externalPending.has(tabId)) void resolveExternalChange(tabId);
}

async function resolveExternalChangeCore(doc: Doc, payload: FileChangedPayload): Promise<void> {
  // 带上当前编码：不指定时 open_file 会重新探测编码，那会把用户手动选定的编码冲掉
  // —— 外部刷新只该换内容，不该顺手改掉用户的编码/行尾选择。
  let file: OpenedFile;
  try {
    file = await reloadFile(doc.tabId, doc.encoding);
  } catch {
    // 文件正被别的进程独占 / 刚被删 → 这次跳过，下一个事件还会再来
    return;
  }
  // 已知版本按「实际读到的那一份」记（事件与读盘之间可能又变了一次），
  // 这样「已知版本」与「编辑器里的内容」永远是一一对应的。
  const mtimeMs = file.mtimeMs || payload.mtimeMs;
  const size = file.size || payload.size;

  const mine = freshTextOfDoc(doc);
  if (mine === null) return;

  if (file.text === mine) {
    // 情形 1：内容一致 → 静默，连提示都不给（提示会让人以为丢了什么）
    markDiskVersion(doc, mtimeMs, size);
    doc.external = false;
    return;
  }

  if (!doc.dirty) {
    // 情形 2：编辑器没动过 → 自动以磁盘为准
    applyDiskContent(doc, file, mtimeMs, size);
    showMessage(`${doc.name} 已在外部被修改，已自动载入最新内容`);
    return;
  }

  // 情形 3：两边都改过 → 交给用户决定
  const choice = await showExternalConflictDialog({
    name: doc.name,
    diskChars: file.text.length,
    mineChars: mine.length,
  });
  if (choice === "take-disk") {
    applyDiskContent(doc, file, mtimeMs, size);
    showMessage(`已载入 ${doc.name} 的磁盘版本`);
    return;
  }
  if (choice === "compare") {
    markDiskVersion(doc, mtimeMs, size);
    await openDiskCopyForCompare(doc, file);
    return;
  }
  // keep-mine：内容一字不动，只记下「磁盘上有一份更新的版本」，保存时覆盖它是用户刚做的选择
  markDiskVersion(doc, mtimeMs, size);
  doc.external = true;
  refreshAll();
  for (const inst of instancesOfDoc(doc.tabId)) renderPanelTabs(inst.panelId);
  showMessage(`保留你的修改：保存 ${doc.name} 时会覆盖磁盘上的外部版本`);
}

/** 用磁盘内容替换整个文档（自动刷新 / 用户选择「载入磁盘版本」）。 */
function applyDiskContent(doc: Doc, file: OpenedFile, mtimeMs: number, size: number): void {
  const eol = doc.eol;
  doc.name = file.name;
  doc.mixedEol = file.mixedEol;
  doc.readonly = file.readonly;
  // 外部那一下可能把文件撑大了：档位跟着变，否则重载完反而少了降级
  doc.sizeClass = normalizeSizeClass(file.sizeClass);
  doc.eol = eol;
  markDiskVersion(doc, mtimeMs, size);
  // 内容以磁盘为准 → 磁盘这份就是新基线（不只是「清掉脏标记」，
  // 否则下一次编辑就无从判断「是否已经回到和磁盘一致」）
  markClean(doc, file.text);
  doc.external = false;
  // 内容以磁盘为准 → 此前那份未保存副本作废（留着会让下次启动拿它顶掉刚载入的内容）
  discardBackupFor(doc);
  rebuildDocInstances(doc, file.text, true);
  refreshAll();
}

/** 把磁盘版本开成一个新的未命名标签（对照用），当前文档一字不动。 */
async function openDiskCopyForCompare(doc: Doc, file: OpenedFile): Promise<void> {
  try {
    const info = await ipcNewTab(file.encoding);
    // 后缀插在扩展名**之前**（`a（磁盘版本）.md`）：语言判定与 Markdown 预览
    // 都认扩展名，把它盖掉的话这份对照就只是纯文本了。
    const dot = doc.name.lastIndexOf(".");
    const copyName =
      dot > 0
        ? `${doc.name.slice(0, dot)}（磁盘版本）${doc.name.slice(dot)}`
        : `${doc.name}（磁盘版本）`;
    const copy = makeDoc(
      info.tabId,
      file.text,
      copyName,
      null,
      file.encoding,
      file.eol,
      false,
      normalizeSizeClass(file.sizeClass),
    );
    copy.mixedEol = file.mixedEol;
    registerDoc(copy);
    const panel = activePanel() ?? [...panels.values()][0];
    if (!panel) return;
    const inst = makeInstance(copy, panel.panelId, file.text);
    attachTabToPanel(inst, panel);
    rebuildLayout();
    refreshAll();
    getPanel(panel.panelId)?.view?.focus();
    renderPanelTabs(panel.panelId);
    showMessage(`已在新标签中打开磁盘版本，${doc.name} 未改动`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

export {
  scheduleSessionSave,
  refreshSession,
  sessionWorthy,
  snapshotSession,
  persistSession,
  restoreSession,
  scheduleAutosave,
  scheduleBackup,
  cancelPendingBackup,
  flushBackups,
  discardBackupFor,
  discardAllBackups,
  handleFileChanged,
  applyDiskContent,
  openDiskCopyForCompare,
};
