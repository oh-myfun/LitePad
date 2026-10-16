/**
 * 同步滚动 v1 —— scroll 事件驱动的协调器（T3 起；2026-10-17 由输入事件触发改为
 * scroll 事件触发，修拖动 / 触摸 / 滚轮三处缺口）。
 *
 * 触发点从原始输入（wheel / pointerdown / keydown）改为每个锚点的 `scroll` 事件：
 * 滚动**落定后**才触发，天然覆盖滚轮、键盘滚动键、滚动条拖动、触摸拖动、惯性所有情形，
 * 且读到的 `v` 就是最终位置——没有「读在滚动生效之前」的滞后（原方案的根因）。
 *
 * 回环用**按锚点 programmatic 守卫**抑制（取代旧全局 suppressSyncPush，不再有
 * 脆弱的全局布尔与振荡）：广播给目标 T 前置 `T.programmatic = true`；T 因本次 setV
 * 产生的 scroll 事件清位并跳过（不回灌）。driver 自身不置位 → 它的用户 scroll 正常广播。
 * 置位同时排一个 rAF 安全复位，防「no-op setV 不产生 scroll 事件」导致守卫卡死。
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

interface InternalEntry extends AnchorHandle {
  /** 本锚点因协调器 setV 产生的 scroll 需被忽略（回声抑制），下次 scroll 清位。 */
  programmatic?: boolean;
  handlers?: {
    onScroll: EventListener;
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
    if (this.rafId !== null) return; // 合并同一帧内多次滚动
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
    // 仅听 `scroll`：滚动落定后才广播，天然覆盖滚轮 / 键盘滚动键 / 滚动条拖动 /
    // 触摸拖动 / 惯性；读到的是最终位置，无「读在滚动生效前」的滞后。
    const onScroll: EventListener = () => {
      if (entry.programmatic) {
        entry.programmatic = false; // 本次 setV 引发的回声，吞掉
        return;
      }
      this.drive(entry);
    };
    s.events.addEventListener("scroll", onScroll);
    entry.handlers = { onScroll };
  }

  private detach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s || !entry.handlers) return;
    s.events.removeEventListener("scroll", entry.handlers.onScroll);
    entry.handlers = undefined;
  }
}
