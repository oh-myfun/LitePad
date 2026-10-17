/**
 * 同步滚动 v1 —— scroll 事件驱动 + 「结构性滚动抑制」的协调器（T3 起；T6 改输入触发
 * 为 scroll 触发；T7 先试了「用户滚动武装」但因过度抑制、交互卡死而回退，改用本文件的
 * 「结构性滚动抑制（自适应突发吞没，非固定时间窗）」）。
 *
 * 触发点 = 每个锚点的 `scroll` 事件：滚动**落定后**才触发，天然覆盖滚轮、键盘滚动键、
 * 滚动条拖动、触摸拖动、惯性所有情形，且读到的 `v` 就是最终位置——没有「读在滚动生效
 * 之前」的滞后（原方案根因）。
 *
 * 回环用**按锚点 programmatic 守卫**抑制（取代旧全局 suppressSyncPush，不再有脆弱的
 * 全局布尔与振荡）：广播给目标 T 前置 `T.programmatic = true`；T 因本次 setV 产生的
 * scroll 事件清位并跳过（不回灌）。driver 自身不置位 → 它的用户 scroll 正常广播。
 * 置位同时排一个 rAF 安全复位，防「no-op setV 不产生 scroll 事件」导致守卫卡死。
 *
 * ⚠️ 结构性滚动抑制（修自动跳变根因，T7 修正版 = 自适应突发吞没，非固定时间窗）：
 *   CM6 在标签切换 / 复制标签 / 分屏 / 标签拖拽重挂时会 `setState` 把 `scrollTop` 归零并
 *   重排（`tabs/lifecycle.ts:270/471`、`tabs/split.ts:92` 注释明载「那几下滚动不是用户造成的」）。
 *   这些滚动若被广播，同 docId 其它视口就会「自动跳变 / 调回顶部」。
 *   —— T7 初版用「输入武装」猜用户滚动，结果把正常滚动也误杀且交互易卡死，已回退。
 *   —— 本方案（参考 VS Code 预览同步的「程序化滚动标记 + 结构化锁」范式）改为**由我们自己的
 *      代码在结构性操作处显式进入抑制**：`reconcileSyncRegistrations()` 在重注册每个 docId 时
 *      调 `suppressStructural(docId)`，`switchTab`/`splitActivePanel` 在 `setState` 前对旧 docId 调它。
 *   —— 抑制的**解除是自适应**的（见 `onScroll`）：进入抑制后，该 docId 的每条 scroll 若在
 *      「上一条被吞 scroll」的 `quiesceMs` 间隙内，就视为同一结构性突发继续吞没并刷新时间戳；
 *      一旦静默超过 `quiesceMs`（结构性突发已结束），下一条 scroll 即视为真正的用户滚动，
 *      自动解除抑制并照常广播。既不靠猜输入、也不靠固定墙钟——突发多长盖多长，用户滚动只在
 *      「紧挨着结构性突发」时才被极短暂吞没，绝大多数情况零延迟同步。
 *
 * B152 语义（用户 2026-10-16 拍板）：按**文档**记开关（`docSyncModes` 同口径）。
 * 关 → 仅当前 pane 滚（不广播）；开 → 所有同文件视口（同 docId 的 editor + preview +
 * 其它 tab/面板）同步。`isOn(docId)` 默认 true（与 B152 默认开一致），关掉后 `drive`
 * 直接返回，当前 pane 仍按浏览器原生滚动，仅不做跨 pane 广播。
 *
 * 设计背景见项目记忆 `2026-10-16.md` 与 `MEMORY.md` 的「同步滚动新方案」。
 */

import type { ScrollAnchor } from "./anchor";

/** 协调器挂监听的可视面（生产传入预览/编辑器滚动容器，测试用 fake）。 */
export interface CoordinatedSurface {
  /** 滚动容器（DOM 节点），协调器挂 `scroll` 监听来感知该 pane 的滚动落点。 */
  readonly events: EventTarget;
}

/** 已注册的锚点句柄（register 返回，unregister / syncFrom 用）。 */
export interface AnchorHandle {
  readonly anchor: ScrollAnchor;
  readonly docId: string;
  readonly surface?: CoordinatedSurface;
}

/** 驱动源的最小形状：一个锚点 + 它所属的文档。 */
type DriverRef = { anchor: ScrollAnchor; docId: string };

/** 协调器可注入的选项（测试用，生产走默认）。 */
export interface CoordinatorOptions {
  /** 当前时间（ms）。默认 `performance.now`，与 rAF 同钟。 */
  now?: () => number;
  /**
   * 结构性突发之间的静默间隙（ms）：进入抑制后，若相邻两条被吞 scroll 间隔不超过该值，
   * 视为同一结构性突发继续吞没；静默超过该值即判定突发结束、解除抑制（视为用户滚动）。
   * 默认 150。CM6 `setState` 的归零重排通常同一帧内连续派发（远小于该值），故能稳稳盖住。
   */
  quiesceMs?: number;
}

interface InternalEntry extends AnchorHandle {
  /** 本锚点因协调器 setV 产生的 scroll 需被忽略（回声抑制），下次 scroll 清位。 */
  programmatic?: boolean;
  handlers?: {
    onScroll: EventListener;
  };
}

/**
 * 同步滚动协调器：把同 docId 的多个锚点（editor/preview/其它 tab/面板）按滚动联动。
 */
export class SyncScrollCoordinator {
  private readonly entries = new Map<string, Set<InternalEntry>>();
  /** 按文档的开关（默认 true，与 B152 默认开一致）。 */
  private readonly docEnabled = new Map<string, boolean>();
  /**
   * 结构性滚动抑制的「最近一次被吞 scroll 时间戳」（按 docId）。存在即表示该 docId 处于
   * 抑制中；相邻被吞 scroll 间隔 ≤ `quiesceMs` 视为同一突发继续吞，超间隙则解除。
   */
  private readonly lastStructural = new Map<string, number>();
  private rafId: number | null = null;
  private pendingDriver: DriverRef | null = null;
  private readonly schedule: (fn: () => void) => number | null;
  private readonly now: () => number;
  private readonly quiesceMs: number;

  constructor(
    schedule: (fn: () => void) => number | null = (fn) => requestAnimationFrame(fn),
    opts: CoordinatorOptions = {},
  ) {
    this.schedule = schedule;
    this.now = opts.now ?? (() => performance.now());
    this.quiesceMs = opts.quiesceMs ?? 150;
  }

  /** B152 开关（按文档）：开 → 所有同文件视口同步；关 → 仅当前 pane（不广播）。 */
  setEnabled(docId: string, on: boolean): void {
    this.docEnabled.set(docId, on);
  }

  /** 该文档当前是否开启同步（默认开）。 */
  isOn(docId: string): boolean {
    return this.docEnabled.get(docId) !== false;
  }

  /**
   * 结构性滚动抑制：标记某 docId 进入结构性突发抑制。由我们自己的结构性操作调用——
   * `reconcileSyncRegistrations`（重注册每个 docId）与 `switchTab`/`splitActivePanel`
   * （`setState` 前对旧 docId）——覆盖标签切换 / 复制 / 分屏 / 拖拽重挂引发的 `setState`
   * 归零重排。进入后该 docId 的 scroll 会被「自适应吞没」（见 `onScroll`）：突发内不广播，
   * 突发结束后（静默超 `quiesceMs`）自动解除，用户滚动照常同步。
   */
  suppressStructural(docId: string): void {
    // 立即进入抑制：时间戳打在「现在」，使紧随其后的结构性 scroll（通常下一帧）必被吞。
    this.lastStructural.set(docId, this.now());
  }

  /** 注册一个锚点（可带可视面，自动挂 scroll 监听）。返回句柄供注销/驱动。 */
  register(anchor: ScrollAnchor, docId: string, surface?: CoordinatedSurface): AnchorHandle {
    const entry: InternalEntry = { anchor, docId, surface };
    let set = this.entries.get(docId);
    if (!set) {
      set = new Set();
      this.entries.set(docId, set);
    }
    set.add(entry);
    if (surface) this.attach(entry);
    return entry;
  }

  /** 注销锚点并解绑其监听。 */
  unregister(handle: AnchorHandle): void {
    const set = this.entries.get(handle.docId);
    if (!set) return;
    for (const e of set) {
      if (e.anchor === handle.anchor) {
        if (e.surface) this.detach(e);
        set.delete(e);
        break;
      }
    }
    if (set.size === 0) this.entries.delete(handle.docId);
  }

  /**
   * 程序化跳转驱动（已注册的锚点）：调用方负责先把 driver 自身滚到目标位置，
   * 本方法只把 driver 的 `getV()` 广播给同 docId 的其余锚点（不回写 driver）。
   * 亦可传未注册的 ScrollAnchor，协调器按引用查找其句柄。
   * 注意：本方法**不经结构性抑制**（TOC / 查找 / 转到行是显式用户动作，必须照常同步）。
   */
  syncFrom(target: ScrollAnchor | AnchorHandle): void {
    const entry = this.toEntry(target);
    if (entry) this.drive(entry);
  }

  /**
   * 程序化跳转驱动（直接给锚点，无需先在册）：TOC 点击 / 查找下一处 / 转到行用。
   * 调用方先让某个 pane 滚到目标（如编辑器 `scrollIntoView`），再调本方法把该 pane
   * 的 `getV()` 广播给同 docId 的其余锚点（预览 + 其它面板/标签），不回写 driver 自身。
   */
  syncFromDriver(docId: string, driver: ScrollAnchor): void {
    if (!this.isOn(docId)) return;
    this.pendingDriver = { anchor: driver, docId };
    this.scheduleFrame();
  }

  private toEntry(target: ScrollAnchor | AnchorHandle): InternalEntry | null {
    if (this.isHandle(target)) {
      // 校验仍在册（防止用已注销句柄）。
      const set = this.entries.get(target.docId);
      if (set) {
        for (const e of set) if (e.anchor === target.anchor) return e;
      }
      return null;
    }
    for (const set of this.entries.values()) {
      for (const e of set) if (e.anchor === target) return e;
    }
    return null;
  }

  private isHandle(t: ScrollAnchor | AnchorHandle): t is AnchorHandle {
    return (t as AnchorHandle).anchor !== undefined && (t as AnchorHandle).docId !== undefined;
  }

  /** 原始输入触发：driver 滚动，rAF 内广播给同 docId 其余 anchor。 */
  private drive(entry: InternalEntry): void {
    if (!this.isOn(entry.docId)) return;
    this.pendingDriver = entry;
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (this.rafId !== null) return; // 合并同一帧内多次滚动（last-writer-wins）
    this.rafId = this.schedule(() => {
      this.rafId = null;
      const driver = this.pendingDriver;
      this.pendingDriver = null;
      if (!driver) return;
      const v = driver.anchor.getV();
      const set = this.entries.get(driver.docId);
      if (!set) return;
      for (const e of set) {
        if (e.anchor === driver.anchor) continue; // 不回写 driver（无回环）
        if (e.anchor.getV() === v) continue; // 已同位置：不置位、不 setV
        // 回声抑制：置位 → 本次 setV 引发的 scroll 清位并跳过；
        // 同时排一个 rAF 安全复位，防 no-op setV 不产生 scroll 事件导致守卫卡死。
        e.programmatic = true;
        this.schedule(() => {
          e.programmatic = false;
        });
        e.anchor.setV(v);
      }
    });
  }

  private attach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s) return;
    const events = s.events;
    // 仅听 `scroll`：滚动落定后才广播，天然覆盖滚轮 / 键盘滚动键 / 滚动条拖动 /
    // 触摸拖动 / 惯性；读到的是最终位置，无「读在滚动生效前」的滞后。
    const onScroll: EventListener = () => {
      if (entry.programmatic) {
        entry.programmatic = false; // 本次 setV 引发的回声，吞掉（回环抑制）
        return;
      }
      // 结构性突发抑制（自适应）：进入抑制后，相邻被吞 scroll 间隔 ≤ quiesceMs 视为同一
      // 突发继续吞没并刷新时间戳；一旦静默超间隙，判定突发结束、解除抑制并照常广播。
      const last = this.lastStructural.get(entry.docId);
      if (last !== undefined) {
        if (this.now() - last <= this.quiesceMs) {
          this.lastStructural.set(entry.docId, this.now());
          return; // 结构性突发内：吞掉，不广播
        }
        this.lastStructural.delete(entry.docId); // 突发已结束，解除抑制
      }
      this.drive(entry);
    };
    events.addEventListener("scroll", onScroll);
    entry.handlers = { onScroll };
  }

  private detach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s || !entry.handlers) return;
    s.events.removeEventListener("scroll", entry.handlers.onScroll);
    entry.handlers = undefined;
  }
}
