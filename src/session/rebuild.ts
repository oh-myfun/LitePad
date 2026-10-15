// 会话恢复（从 session.ts 拆出，P3 批次）。
//
// 职责：restoreSession / restoreSatelliteWindows —— 按保存的布局树重建面板、逐个打开
// 文件（副本优先、按文档身份去重预取）、恢复光标 / 视口 / 视图模式 / 同步开关，并把
// 卫星标签交给真实卫星窗口。落盘侧（scheduleSessionSave / persistSession / 备份 /
// 外部变更）在 ./persist，本模块单向依赖它的 scheduleSessionSave。

import {
  activePanelId,
  docSyncModes,
  docs,
  layout,
  panels,
  remotedTabs,
  setDocs,
  setLayout,
  setNextInstId,
  setNextPanelId,
  setTabs,
  setActivePanelId,
  takePanelId,
  tabs,
  type Tab,
} from "../core/app-state";
import { getPanel } from "../core/panels";
import { logViewport } from "../core/viewport";
import { logger } from "../core/logger";
import { LayoutNode, leaf } from "../core/layout";
import { isMdTab, makeDoc, makeInstance, markDiskVersion, registerDoc } from "../doc-model";
import { normalizeSizeClass } from "../editor/perf";
import {
  OpenedFile,
  newTab as ipcNewTab,
  openFile,
  restoreBackup,
  loadSession,
  type RestoredBackup,
  type SessionState,
  type TabSession,
} from "../ipc/api";
import { rebuildLayout } from "../tabs";
import { refreshAll } from "../ui";
import { scheduleSessionSave } from "./persist";
import { openTabsInNewWindow, reclaimRemoted } from "../multiwindow/windows";

/** 启动时恢复上次会话：按保存的布局树重建面板，逐个打开文件并恢复光标。失败返回 false（退回空白标签）。 */
export async function restoreSession(): Promise<boolean> {
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
    // B288⑤-1c：像素不再从会话恢复（磁盘已不存 `scrollTop`）。位置只认规范游标 `v`：
    //   有 v ⇒ 按当前几何反算像素（换宽度重启也按同一行还原）；无 v（旧会话 / 从未滚动过）
    //   ⇒ 保持 null，切过去时退化为「保证光标可见」（同 B126 的空值语义）。
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
export async function restoreSatelliteWindows(
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
