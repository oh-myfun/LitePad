/**
 * 同步滚动 v1 —— 输入事件驱动的协调器（T3，T4 扩展为按文档开关）。
 *
 * 取代旧「scroll 事件 + 全局 suppressSyncPush + 回声抑制」机制。核心思路：
 * 同步触发点从滚动**结果**（scroll 事件）挪到**原始输入**——wheel / 滚动条拖动 /
 * 键盘滚动键 / 程序化跳转（`syncFrom` / `syncFromDriver`）。某 pane 触发 → 标
 * `pendingDriver` → rAF 内读 `v = driver.getV()` → 对**同 docId** 的其余 anchor `setV(v)`。
 *
 * 结构上无回环、无需回声抑制：`target.setV` 只改 `scrollTop`、不产生任何输入事件
 * （也不监听 scroll 事件），故无人监听 → 不会二次触发 → 不会回声。last-writer-wins：
 * rAF 合并同一帧内的多次 wheel/键盘，帧内读一次 getV（取最终落点）。
 *
 * B152 语义（用户 2026-10-16 拍板）：按**文档**记开关（`docSyncModes` 同口径）。
 * 关 → 仅当前 pane 滚（不广播）；开 → 所有同文件视口（同 docId 的 editor + preview +
 * 其它 tab/面板）同步。`isOn(docId)` 默认 true（与 B152 默认开一致），关掉后 `drive`
 * 直接返回，当前 pane 仍按浏览器原生滚动，仅不做跨 pane 广播。
 *
 * 设计背景见项目记忆 `2026-10-16.md` 与 `MEMORY.md` 的「同步滚动新方案」。
 */

import type { ScrollAnchor } from "./anchor";

/** 键盘滚动键（不含普通输入字符键；Space 仅在非编辑滚动语义下作为滚动触发）。 */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** 协调器挂监听的可视面（生产传入预览/编辑器 DOM 节点，测试用 fake）。 */
export interface CoordinatedSurface {
  /** 事件源（DOM 节点），协调器挂 wheel / pointerdown / keydown。 */
  readonly events: EventTarget;
  /** 该 pane 可视区边框（滚动条槽命中检测用）。 */
  rect(): DOMRect;
  /** 滚动条槽宽（像素）。 */
  scrollbarWidth(): number;
}

/** 已注册的锚点句柄（register 返回，unregister / syncFrom 用）。 */
export interface AnchorHandle {
  readonly anchor: ScrollAnchor;
  readonly docId: string;
  readonly surface?: CoordinatedSurface;
}

/** 驱动源的最小形状：一个锚点 + 它所属的文档。 */
type DriverRef = { anchor: ScrollAnchor; docId: string };

interface InternalEntry extends AnchorHandle {
  handlers?: {
    onWheel: EventListener;
    onPointerDown: EventListener;
    onKeyDown: EventListener;
  };
}

/**
 * 同步滚动协调器：把同 docId 的多个锚点（editor/preview/其它 tab/面板）按输入事件联动。
 */
export class SyncScrollCoordinator {
  private readonly entries = new Map<string, Set<InternalEntry>>();
  /** 按文档的开关（默认 true，与 B152 默认开一致）。 */
  private readonly docEnabled = new Map<string, boolean>();
  private rafId: number | null = null;
  private pendingDriver: DriverRef | null = null;
  private readonly schedule: (fn: () => void) => number | null;

  constructor(schedule: (fn: () => void) => number | null = (fn) => requestAnimationFrame(fn)) {
    this.schedule = schedule;
  }

  /** B152 开关（按文档）：开 → 所有同文件视口同步；关 → 仅当前 pane（不广播）。 */
  setEnabled(docId: string, on: boolean): void {
    this.docEnabled.set(docId, on);
  }

  /** 该文档当前是否开启同步（默认开）。 */
  isOn(docId: string): boolean {
    return this.docEnabled.get(docId) !== false;
  }

  /** 注册一个锚点（可带可视面，自动挂输入监听）。返回句柄供注销/驱动。 */
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
    if (this.rafId !== null) return; // 合并同一帧内多次触发
    this.rafId = this.schedule(() => {
      this.rafId = null;
      const driver = this.pendingDriver;
      this.pendingDriver = null;
      if (!driver) return;
      const v = driver.anchor.getV();
      const set = this.entries.get(driver.docId);
      if (!set) return;
      for (const e of set) {
        if (e === driver) continue; // 不回写 driver（无回环）
        e.anchor.setV(v);
      }
    });
  }

  private attach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s) return;
    const onWheel: EventListener = () => this.drive(entry);
    const onPointerDown: EventListener = (ev) => {
      const pe = ev as PointerEvent;
      const r = s.rect();
      // 命中滚动条槽（右侧 scrollbarWidth 内）→ 视作滚动条拖动。
      if (pe.clientX > r.right - s.scrollbarWidth()) this.drive(entry);
    };
    const onKeyDown: EventListener = (ev) => {
      const ke = ev as KeyboardEvent;
      if (SCROLL_KEYS.has(ke.key)) this.drive(entry);
    };
    s.events.addEventListener("wheel", onWheel, { passive: true });
    s.events.addEventListener("pointerdown", onPointerDown);
    s.events.addEventListener("keydown", onKeyDown);
    entry.handlers = { onWheel, onPointerDown, onKeyDown };
  }

  private detach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s || !entry.handlers) return;
    const h = entry.handlers;
    s.events.removeEventListener("wheel", h.onWheel);
    s.events.removeEventListener("pointerdown", h.onPointerDown);
    s.events.removeEventListener("keydown", h.onKeyDown);
    entry.handlers = undefined;
  }
}
