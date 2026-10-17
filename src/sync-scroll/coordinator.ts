/**
 * 同步滚动 v1 —— scroll 事件驱动 + 「结构性滚动抑制」的协调器（T3 起；T6 改输入触发
 * 为 scroll 触发；T7 经「用户滚动武装」→「固定窗口」→「自适应突发（墙钟）」→「确定性
 * 帧释放（静默计数）」四版迭代，最终收敛为**本文件的「结构性锁 + 用户手势解锁」**：
 * 彻底去掉一切时间窗 / 帧计数 / 输入猜测（见下方 ⚠️）。
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
 * ⚠️ 结构性滚动抑制（修自动跳变根因，T7 终版 = 结构性锁 + 用户手势解锁）：
 *   CM6 在标签切换 / 复制标签 / 分屏 / 标签拖拽重挂 / 文件重载 / 多窗整态重建时会 `setState`
 *   把 `scrollTop` 归零并重排（`tabs/lifecycle.ts`/`tabs/split.ts`/`io/files.ts`/
 *   `multiwindow/windows.ts` 注释明载「那几下滚动不是用户造成的」）。这些滚动若被广播，
 *   同 docId 其它视口就会「自动跳变 / 调回顶部」。
 *   —— T7 前四版（用户滚动武装 / 固定窗口 / 墙钟 quiesceMs / 确定性帧释放=静默计数）都
 *      有一个**同类脆弱点**：靠「静默 N 帧 / N 毫秒后判定突发结束」来解除抑制，只要结构性
 *      scroll 在解除后（或两次结构性 scroll 间出现空隙后）迟到，就会漏出广播 → 仍然自动跳变。
 *   —— 终版（本文件）改为**结构性锁**：`suppressStructural(docId)` 给该 docId 上一把锁
 *      （在 `structural` 集合里），期间该 docId 的所有 scroll 被持续吞没；**只有两种途径
 *      解锁**：(1) 用户真实手势（wheel / pointerdown / keydown / touchstart 任一落在
 *      该 docId 的某面板上）—— 用户一旦接管滚动，锁即解开、后续滚动照常同步；(2) 兜底
 *      静默 `fallbackFrames`（默认 60 帧 ≈ 1s）强制解锁，防漏调 / 永不触发手势导致永久
 *      过抑制。完全不靠时间窗 / 帧计数 / 输入猜测，不受异步派发（setState 重排 scroll
 *      迟到数帧）或空隙影响：锁一直挂到用户滚动或 ~1s 兜底，结构性 scroll 无论多晚到都被
 *      吞没。参考 VS Code 预览同步的「程序化滚动标记 + 结构化锁」范式。
 *
 * B152 语义（用户 2026-10-16 拍板）：按**文档**记开关（docSyncModes 同口径）。
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
  /**
   * 兜底静默帧数：某 docId 上了结构性锁却长时间（>`fallbackFrames` 帧）无任何结构性
   * scroll，强制解锁，防止该 docId 永久过抑制。默认 60（≈1s @60fps）。
   */
  fallbackFrames?: number;
}

interface InternalEntry extends AnchorHandle {
  /** 本锚点因协调器 setV 产生的 scroll 需被忽略（回声抑制），下次 scroll 清位。 */
  programmatic?: boolean;
  handlers?: {
    onScroll: EventListener;
    onUserInput: EventListener;
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
   * 结构性滚动抑制的「锁」集合（按 docId）：存在即表示该 docId 正处于结构性操作中——
   * 期间持续吞没该 docId 的所有 scroll，直到用户真实手势或兜底静默解锁。
   */
  private readonly structural = new Set<string>();
  /**
   * 兜底「最后结构性 scroll 帧」计数（按 docId）：上锁期间，每次吞没结构性 scroll
   * 都重置为 `fallbackFrames`；递减到 0 仍无结构性 scroll 即强制解锁（防永久过抑制）。
   */
  private readonly fallbackSeen = new Map<string, number>();
  private fallbackRafId: number | null = null;
  private rafId: number | null = null;
  private pendingDriver: DriverRef | null = null;
  private readonly schedule: (fn: () => void) => number | null;
  private readonly fallbackFrames: number;

  constructor(
    schedule: (fn: () => void) => number | null = (fn) => requestAnimationFrame(fn),
    opts: CoordinatorOptions = {},
  ) {
    this.schedule = schedule;
    this.fallbackFrames = opts.fallbackFrames ?? 60;
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
   * 结构性滚动抑制：给某 docId 上一把「结构性锁」（确定性、无时间窗）。
   * 由我们自己的结构性操作调用——`reconcileSyncRegistrations`（重注册每个 docId）、
   * `switchTab`/`splitActivePanel`/`closeTabById` 在 `setState` 前、以及 `io/files.ts`
   * 文件重载、`multiwindow/windows.ts` 整态重建——覆盖标签切换 / 复制 / 分屏 / 拖拽重挂 /
   * 文件重载 / 多窗重建引发的 `setState` 归零重排。锁期间该 docId 的 scroll 被持续吞没，
   * **不受异步派发（setState 重排 scroll 迟到）或空隙影响**；解锁只靠：(1) 用户真实手势
   * （wheel/pointerdown/keydown/touchstart 落在该 docId 某面板）或 (2) 兜底静默
   * `fallbackFrames` 帧强制解锁（防漏调导致永久过抑制）。
   */
  suppressStructural(docId: string): void {
    this.structural.add(docId);
    this.fallbackSeen.set(docId, this.fallbackFrames);
    this.scheduleFallback();
  }

  /** 兜底静默循环：上锁期间每帧递减 fallbackSeen，归零仍无结构性 scroll 则强制解锁。 */
  private scheduleFallback(): void {
    if (this.fallbackRafId !== null) return;
    this.fallbackRafId = this.schedule(() => {
      this.fallbackRafId = null;
      for (const [docId, n] of this.fallbackSeen) {
        if (n <= 1) {
          this.fallbackSeen.delete(docId);
          this.structural.delete(docId); // 强制解锁
        } else {
          this.fallbackSeen.set(docId, n - 1);
        }
      }
      if (this.fallbackSeen.size > 0) this.scheduleFallback();
    });
  }

  /** 注册一个锚点（可带可视面，自动挂 scroll + 用户手势监听）。返回句柄供注销/驱动。 */
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
   * 注意：本方法**不经结构性锁**（TOC / 查找 / 转到行是显式用户动作，必须照常同步）。
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
      // 结构性锁：docId 上锁期间，本 scroll 视为结构性重排（非用户），吞掉；并刷新兜底计数。
      if (this.structural.has(entry.docId)) {
        this.fallbackSeen.set(entry.docId, this.fallbackFrames); // 续杯：结构性 scroll 续命
        return;
      }
      this.drive(entry);
    };
    // 用户真实手势（滚轮 / 指针按下 / 键盘 / 触摸开始）落在某面板上 ⇒ 该 docId 解锁：
    // 用户一旦接管滚动，结构性锁解除，后续滚动照常同步。完全不靠时间窗 / 帧计数。
    const onUserInput: EventListener = () => {
      this.structural.delete(entry.docId);
      this.fallbackSeen.delete(entry.docId);
    };
    events.addEventListener("scroll", onScroll);
    events.addEventListener("wheel", onUserInput);
    events.addEventListener("pointerdown", onUserInput);
    events.addEventListener("keydown", onUserInput);
    events.addEventListener("touchstart", onUserInput);
    entry.handlers = { onScroll, onUserInput };
  }

  private detach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s || !entry.handlers) return;
    s.events.removeEventListener("scroll", entry.handlers.onScroll);
    s.events.removeEventListener("wheel", entry.handlers.onUserInput);
    s.events.removeEventListener("pointerdown", entry.handlers.onUserInput);
    s.events.removeEventListener("keydown", entry.handlers.onUserInput);
    s.events.removeEventListener("touchstart", entry.handlers.onUserInput);
    entry.handlers = undefined;
  }
}
