/**
 * 会话状态的**唯一权威**（B141）。
 *
 * 之前会话没有常驻模型：信息散在 `tabs` / `docs` / `panels` / `layout` /
 * `activePanelId` / `remotedTabs` 六处，只在要落盘那一刻由 `snapshotSession()`
 * 现场拼出来（B132 / B140 两次丢状态都是这么来的：拼装的那一刻拿不到最新值，
 * 或者压根忘了排程）。
 *
 * 现在反过来：**会话是一份常驻记录，磁盘形状就是它的形状**。活动态（EditorState、
 * DOM 滚动、`Doc.path` 这些视图真正在用的东西）变化时，由持有者调这里的 setter 写进来；
 * 落盘只是把这份记录序列化，不再现场拼装；恢复则由这份记录驱动重建。
 *
 * ⚠️ 活动态本身**不能**搬进来 —— EditorState 不可序列化、视图还得照常工作。所以这里
 * 存的是会话关心的那 9 个字段（`TabSession`），活动态是它们的来源而非副本：
 * 「权威」指的是**会话只有一个出口、一份记录**，不是「视图改读这里」。
 */
import type { SessionState, TabSession } from "../ipc/api";

/** 一个标签的会话记录（与磁盘 `TabSession` 一一对应，多了 `tabId` 这个内存键）。 */
export interface SessionTabRecord {
  tabId: number;
  docId: number;
  path: string;
  encoding: string;
  eol: string;
  cursorLine: number;
  cursorCol: number;
  scrollTop: number | null;
  viewMode: string | null;
  backupId: string | null;
}

/** 一个面板的会话记录：标签顺序 + 活动标签。 */
export interface SessionPanelRecord {
  tabIds: number[];
  activeTabId: number;
}

/** 会话恢复的「建设计划」：`hydrate` 的输出，交给调用方按它建实例。 */
export interface SessionPlan {
  panels: { recs: TabSession[]; active: number }[];
  satellites: TabSession[];
  layout: unknown;
  activePanel: number;
}

function blankRecord(tabId: number, docId: number): SessionTabRecord {
  return {
    tabId,
    docId,
    path: "",
    encoding: "UTF-8",
    eol: "CRLF",
    cursorLine: 1,
    cursorCol: 1,
    scrollTop: null,
    viewMode: null,
    backupId: null,
  };
}

function toDisk(r: SessionTabRecord): TabSession {
  return {
    path: r.path,
    encoding: r.encoding,
    eol: r.eol,
    cursorLine: r.cursorLine,
    cursorCol: r.cursorCol,
    scrollTop: r.scrollTop,
    viewMode: r.viewMode,
    backupId: r.backupId,
    docId: r.docId,
  };
}

class SessionStore {
  private recs = new Map<number, SessionTabRecord>();
  private panels = new Map<number, SessionPanelRecord>();
  /** 搬到别的窗口的标签（docId → 归属）。卫星窗口自己不写会话，由主窗口代登记。 */
  private satellites = new Map<number, { tabId: number; owner: string }>();
  private layout: unknown = null;
  private activePanelId = 0;

  // ---------------------------------------------------------------- 生命周期

  /** 整体重置（会话恢复 / 窗口重建时）：容器与这份记录一起换新的。 */
  reset(): void {
    this.recs = new Map();
    this.panels = new Map();
    this.satellites = new Map();
    this.layout = null;
    this.activePanelId = 0;
  }

  /**
   * 载入磁盘会话，产出「建设计划」。
   *
   * 这一步**不建实例**：tabId / docId 是内存里的键，由调用方（恢复流程）分配完再
   * `register` 回来。计划里保留的是磁盘顺序，恢复出来的顺序必须与之一致。
   */
  hydrate(state: SessionState | null): SessionPlan | null {
    if (!state?.panels?.length) return null;
    return {
      panels: state.panels.map((p) => ({ recs: p.tabs ?? [], active: p.active ?? 0 })),
      satellites: state.satelliteTabs ?? [],
      layout: state.layout ?? null,
      activePanel: state.activePanel ?? 0,
    };
  }

  // ---------------------------------------------------------------- 标签记录

  register(tabId: number, docId: number, seed: Partial<SessionTabRecord> = {}): void {
    this.recs.set(tabId, { ...blankRecord(tabId, docId), ...seed, tabId, docId });
  }

  drop(tabId: number): void {
    this.recs.delete(tabId);
  }

  /** 取一份记录（不存在返回 null，调用方自行兜底）。 */
  get(tabId: number): SessionTabRecord | null {
    return this.recs.get(tabId) ?? null;
  }

  /** 文档级字段（path / encoding / eol / backupId）由 `Doc` 的变化推过来。 */
  setDoc(
    tabId: number,
    patch: Partial<Pick<SessionTabRecord, "path" | "encoding" | "eol" | "backupId">>,
  ): void {
    const r = this.recs.get(tabId);
    if (!r) return;
    Object.assign(r, patch);
  }

  setCursor(tabId: number, line: number, col: number): void {
    const r = this.recs.get(tabId);
    if (!r) return;
    r.cursorLine = line;
    r.cursorCol = col;
  }

  setScroll(tabId: number, px: number | null): void {
    const r = this.recs.get(tabId);
    if (r) r.scrollTop = px;
  }

  setViewMode(tabId: number, mode: string | null): void {
    const r = this.recs.get(tabId);
    if (r) r.viewMode = mode;
  }

  // ---------------------------------------------------------------- 结构（面板 / 布局）

  setPanel(panelId: number, tabIds: number[], activeTabId: number): void {
    this.panels.set(panelId, { tabIds: [...tabIds], activeTabId });
  }

  dropPanel(panelId: number): void {
    this.panels.delete(panelId);
  }

  setLayout(layout: unknown): void {
    this.layout = layout;
  }

  setActivePanel(panelId: number): void {
    this.activePanelId = panelId;
  }

  setSatellite(docId: number, tabId: number, owner: string): void {
    this.satellites.set(docId, { tabId, owner });
  }

  dropSatellite(docId: number): void {
    this.satellites.delete(docId);
  }

  satelliteOf(docId: number): { tabId: number; owner: string } | null {
    return this.satellites.get(docId) ?? null;
  }

  /** 已登记的面板 / 跨窗口文档 id（供同步时清理「已经消失的那份」）。 */
  panelIds(): number[] {
    return [...this.panels.keys()];
  }

  satelliteDocIds(): number[] {
    return [...this.satellites.keys()];
  }

  // ---------------------------------------------------------------- 出口

  /**
   * 序列化成磁盘形状。
   *
   * `worthy` 由调用方给出（哪些标签该进会话：空未命名、临时对照文档之类要排除），
   * 因为那是**业务**判据，不属于这份记录的职责。
   */
  toSessionState(worthy: (tabId: number) => boolean): SessionState {
    const panelIds = [...this.panels.keys()];
    const indexOf = new Map<number, number>();
    panelIds.forEach((id, i) => indexOf.set(id, i));

    return {
      panels: panelIds.map((id) => {
        const p = this.panels.get(id)!;
        const kept = p.tabIds.filter(worthy);
        return {
          tabs: kept.map((tid) => toDisk(this.recs.get(tid)!)),
          active: Math.max(0, kept.indexOf(p.activeTabId)),
        };
      }),
      layout: this.layout,
      activePanel: indexOf.get(this.activePanelId) ?? 0,
      satelliteTabs: [...this.satellites.values()]
        .map((s) => this.recs.get(s.tabId))
        .filter((r): r is SessionTabRecord => !!r && worthy(r.tabId))
        .map(toDisk),
    };
  }
}

export const sessionStore = new SessionStore();
