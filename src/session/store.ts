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
  viewMode: string | null;
  backupId: string | null;
  /** B169：同步滚动开关（按文档记，B152）。恢复时写回前端 `docSyncModes`。 */
  syncMode: boolean;
  /**
   * B302：这一格上次被看到时的共享坐标 `v`；`null` = 从没被看到过。
   *
   * ⚠️ 必须允许 `null`：`1`（停在顶部）与「没记过」在数据里长成一个样，恢复时就会把
   * 同文档兄弟格那份对的记忆覆盖成顶部（B299 那一族）。落盘时只由**看得见那一侧**现采。
   */
  scrollV: number | null;
  /**
   * B352-10：即时渲染的两个状态位。`null` = 没记过（非 md 标签也写 null，与 `viewMode` 同口径），
   * `"off"` 是「进过渲染、又退回源码」—— 两件事，混成一份就恢复不回用户离开时的样子。
   */
  liveRender: string | null;
  /** 渲染态的锁位：`false` = 用户明确解过锁，`null` = 从没记过（恢复时回落 `true`，B302 同一个理由）。 */
  irLocked: boolean | null;
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
    viewMode: null,
    backupId: null,
    syncMode: false,
    scrollV: null,
    liveRender: null,
    irLocked: null,
  };
}

function toDisk(r: SessionTabRecord): TabSession {
  return {
    path: r.path,
    encoding: r.encoding,
    eol: r.eol,
    cursorLine: r.cursorLine,
    cursorCol: r.cursorCol,
    viewMode: r.viewMode,
    backupId: r.backupId,
    docId: r.docId,
    syncMode: r.syncMode,
    scrollV: r.scrollV,
    liveRender: r.liveRender,
    irLocked: r.irLocked,
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

  setViewMode(tabId: number, mode: string | null): void {
    const r = this.recs.get(tabId);
    if (r) r.viewMode = mode;
  }

  /** B169：同步滚动开关（按文档记）。`docSyncModes` 是前端权威，退出前刷进记录即可落盘。 */
  setSyncMode(tabId: number, on: boolean): void {
    const r = this.recs.get(tabId);
    if (r) r.syncMode = on;
  }

  /**
   * B302：这一格的视口位置（共享坐标 `v`）。
   *
   * 只有三个来源配写它：① 落盘前对**看得见那一侧**的现采（`samplePanelScrollV`）；
   * ② 卫星窗口交还的位置；③ 同一份文档里**没在显示**的那些实例的记账
   * （`sync-scroll/wire` 的 `memoVToHiddenInstances`，B344 —— 它们没有面可采，不记就永远停在
   * 「上次被显示时」，拖出新窗口读的就是这份记忆）。
   * 隐藏侧的读数恒 0、在途落位的 DOM 还是旧位置，两者都不许直接写这里
   * （前者由 `readVisibleV` 报 null 挡住，后者由账本挡）。
   */
  setScrollV(tabId: number, v: number | null): void {
    const r = this.recs.get(tabId);
    if (r) r.scrollV = v;
  }

  /**
   * B352-10：即时渲染的模式位与锁位。唯一写点（B304 的口径：显示与行为两处写迟早分裂）。
   *
   * 值由 `refreshSession` 从活动态刷进来 —— 这份记录是**会话的出口**，不是视图的副本，
   * 所以这里不校验取值（`"wysiwyg"` 之类由恢复侧的 `coerceIrState` 兜）。
   */
  setIr(tabId: number, liveRender: string | null, irLocked: boolean | null): void {
    const r = this.recs.get(tabId);
    if (!r) return;
    r.liveRender = liveRender;
    r.irLocked = irLocked;
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
      // B193：卫星标签要**带窗口归属**落盘 —— 少了它，多个卫星窗口在恢复时会被坍缩成
      // 一份（只能一并并回主窗口）。`owner` 只是分组键，恢复时窗口 label 会重新分配。
      satelliteTabs: [...this.satellites.values()]
        .map((s): TabSession | null => {
          const r = this.recs.get(s.tabId);
          return r && worthy(r.tabId) ? { ...toDisk(r), owner: s.owner } : null;
        })
        .filter((x): x is TabSession => !!x),
    };
  }
}

export const sessionStore = new SessionStore();
