// 会话落盘 / 自动保存 / 热退出副本 / 外部文件变更（从 session.ts 拆出，P3 批次）。
//
// 职责：scheduleSessionSave / refreshSession / sessionWorthy / snapshotSession /
// persistSession / scheduleAutosave / scheduleBackup / cancelPendingBackup / flushBackups /
// discardBackupFor / discardAllBackups / handleFileChanged / resolveExternalChange* /
// applyDiskContent / openDiskCopyForCompare，以及各自的模块级定时器与防抖状态。
// 恢复侧（restoreSession / restoreSatelliteWindows）在 ./rebuild，它单向依赖本模块的
// scheduleSessionSave；权威类型在 ./store（SessionState），本模块是行为侧。

import {
  MAIN_WINDOW_LABEL,
  activePanelId,
  docSyncModes,
  docs,
  panels,
  remotedTabs,
  settings,
  tabs,
  windowKind,
  windowLabel,
  type Doc,
  type Tab,
} from "../core/app-state";
import { activePanel, getPanel, instancesOfDoc } from "../core/panels";
import { logViewport } from "../core/viewport";
import { logger } from "../core/logger";
import {
  isMdTab,
  makeDoc,
  makeInstance,
  markClean,
  markDiskVersion,
  registerDoc,
  attachTabToPanel,
} from "../doc-model";
import { normalizeSizeClass } from "../editor/perf";
import {
  FileChangedPayload,
  OpenedFile,
  newTab as ipcNewTab,
  isUnicodeEncoding,
  reloadFile,
  saveFile,
  discardBackup,
  saveSession,
  writeBackup,
  type SessionState,
} from "../ipc/api";
import { LayoutNode } from "../core/layout";
import { showExternalConflictDialog } from "../shell/conflictdialog";
import { rememberViewScroll } from "../sync-scroll";
import { freshTextOfDoc, layoutForSession, rebuildLayout, renderPanelTabs } from "../tabs";
import { refreshAll, showMessage } from "../ui";
import { sessionStore } from "./store";
import { emitTo } from "@tauri-apps/api/event";
import { rebuildDocInstances } from "../io/files";

// ---------------------------------------------------------------- 会话 / 自动保存（M2）

export function scheduleSessionSave(): void {
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
export function refreshSession(): void {
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
      // ⚠️ 新登记的记录要**带着** `t` 里已有的位置进来（B145）：会话恢复的标签在
      // `restoreSession` 里已经把位置读进 `t.syncV`，登记成空白的话，下面那条写入
      // 又会被还原期的闸口挡掉 —— 「刚恢复出来的位置」这一轮就白恢复了。
      // B288⑤-1c：只带规范游标 `v`（像素已不落盘）。
      sessionStore.register(t.tabId, t.docId, { syncV: t.syncV });
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
    // B288⑤-1c：原先这里有一条 `recordScroll(t.tabId, viewportOfTab(t))`（落盘前刷新）。
    //   它读的是像素槽、再写回同一个像素槽 —— 像素已不落盘（只落 `syncV`），
    //   而 `syncV` 的落盘本就由各处 `recordScroll` 走同一闸口完成 ⇒ 这一条纯自赋值，删。
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
export function sessionRejectReason(t: Tab): string | null {
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
export function sessionWorthy(t: Tab): boolean {
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
export function sessionSummary(s: SessionState, skipped: string[] = []): string {
  const all = s.panels.flatMap((p) => p.tabs);
  const total = all.length + (s.satelliteTabs?.length ?? 0);
  const shown = all.slice(0, 8);
  const body = shown
    .map(
      (t) =>
        // B288⑤-1c：位置只以规范游标 v 入日志（像素已不落盘，显示「位」没有意义）。
        `${t.path || "(未命名)"}|行${t.cursorLine}:${t.cursorCol}|v${t.syncV ?? "-"}${
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

export function snapshotSession(): Parameters<typeof saveSession>[0] {
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
export function convertLayoutForSession(
  node: LayoutNode,
  panelIndex: Map<number, number>,
): unknown {
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

export async function persistSession(): Promise<void> {
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

let autosaveTimer: number | null = null;

/** 自动保存：仅对已关联磁盘且 Unicode 编码的脏文档（无 lossy 风险），1.5s 防抖。 */
export function scheduleAutosave(): void {
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
export function newBackupId(): string {
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
export function scheduleBackup(): void {
  if (!settings?.hot_exit) return;
  if (backupTimer !== null) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void flushBackups();
  }, 1000) as unknown as number;
}

/** 取消排队的备份（关窗前要换成「立刻写」）。 */
export function cancelPendingBackup(): void {
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
export async function flushBackups(): Promise<number> {
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
export function discardBackupFor(doc: Doc): void {
  if (!doc.backedUp || !doc.backupId) return;
  const id = doc.backupId;
  doc.backedUp = false;
  void discardBackup(id).catch(() => {
    // 删不掉不阻塞任何事：最坏只是下次启动多还原一个陈旧副本
  });
}

/** 丢弃全部副本（用户关掉热退出开关 / 应用启动后的孤儿清理之外的重置场景）。 */
export function discardAllBackups(): void {
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
export function handleFileChanged(payload: FileChangedPayload): void {
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

export async function resolveExternalChange(tabId: number): Promise<void> {
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

export async function resolveExternalChangeCore(
  doc: Doc,
  payload: FileChangedPayload,
): Promise<void> {
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
export function applyDiskContent(doc: Doc, file: OpenedFile, mtimeMs: number, size: number): void {
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
export async function openDiskCopyForCompare(doc: Doc, file: OpenedFile): Promise<void> {
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
