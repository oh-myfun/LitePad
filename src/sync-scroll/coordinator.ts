/**
 * 同步滚动 v1 —— **期望账本**（expectation ledger）协调器。
 *
 * ## 为什么要把上一版的机制全删掉
 * 触发点用 `scroll` 事件是对的（它是**落定后**的位置，天然覆盖滚轮 / 键盘滚动键 / 滚动条
 * 拖动 / 触摸 / 惯性，且没有「读在滚动生效之前」的一帧滞后）。但 `scroll` 是**结果**信号，
 * 而 `scrollTop` 在协调器之外还有多个写入方（CM6 `setState`、`PreviewPane.setBlocks` 的
 * 清零+复原、`applySyncToLine`、`applyPending` 的下一帧补定位、位置恢复）。
 * 从结果信号**反推不出是谁写的**，于是 T7 连出五版「猜时间」的抑制机制：
 * 用户滚动武装 → 固定窗口 → 自适应突发 → 确定性帧释放 → 结构性锁+手势解锁。
 * 五版全量门禁 ✅ 却五版真机复现，因为它们都只是在「猜紧 ⇒ 误杀用户滚动（不同步）」与
 * 「猜松 ⇒ 结构性滚动漏出（自动跳变/调回顶部）」之间挪位置——**同一个 bug 的两面**。
 * 真机验证台（`scripts/sync-scroll-probe.mjs`）给出的判决性证据是 S7：唯一没登记写入的那个
 * 点（`setBlocks`），就是唯一还在坏的那个点。
 *
 * ## 本文件的做法：把「猜」换成「查」
 * 谁写了 `scrollTop`、打算写到哪，就**先登记**；`scroll` 事件到来时只做一次查表比较。
 * 每笔承诺记**三个**事实：意图 `expectedV`（要去哪儿）、真实落点 `landedV`（那一写当时
 * 换算到哪）、以及落点那一刻的**像素** `landedPx`：
 *   - 没登记过 ⇒ 这一下不是我们写的 ⇒ 用户滚动 ⇒ 广播；
 *   - 观察值 ≈ 意图 ⇒ 承诺兑现 ⇒ 吞掉，销账；
 *   - 像素还是我们写下去那一个（±1px）而 v 没到意图 ⇒ 是我们的回声但位置没落地 ⇒ 补写兑现，
 *     仍不广播；补到上限（`MAX_REASSERT`）还补不上 ⇒ 认账：把当前落点登记成**新基线**
 *     （不是清空账本——清空会让这一格下一发原地重报的余波被误判成用户滚动，把对栏拽走）；
 *   - 像素也不是我们那一个 ⇒ **有人把它挪到了我们没写过的地方** ⇒ 用户滚动 ⇒ 广播。
 *
 * ⚠️ 回声的身份为什么必须认像素：`v` 是「源码行号」，而**行号↔像素的换算表本身会迟到**。
 * CM6 虚拟化下 `setState` 之后高度图只覆盖到视口附近，写入被当时的 `scrollHeight` 裁住；
 * 高度图细化后**同一个 `scrollTop` 被重新解释成另一个行号**。真机 2026-10-18 02:42 的
 * `意图=20.25 落点=14.74 obs=20.13`（像素自始至终 702）就是这一形状 —— 只按 v 比，
 * 自己那一发被判成「别人挪走了」⇒ 一发假广播拽走对栏，还把漂移值存进位置记忆
 * （每次切标签掉 0.03~0.2 行：23.32→23.10→23.03→23.01），正是「跳变从来没被扶回过、
 * 最后位置还是错的」那一条。
 *
 * 最后那条「像素不是我们那一个」也是「到底」一族的判据：意图被容器上限裁住时承诺永远
 * 兑不了现，若只比意图，此后用户的每一格滚动都会被判成「没兑现」而被补写拽回原地 ——
 * 表现就是到底以后不再跟手。
 * 全部判定都是事件驱动的确定性比较：**没有时间窗、没有帧计数、没有看门狗、没有猜输入事件**。
 *
 * ## 账本按「滚动面（DOM 节点）」记，不按锚点对象记
 * `reconcileSyncRegistrations()` 每次都会重建锚点对象（wire.ts 的既有形状）。若账本挂在锚点
 * 上，重注册就把在途的承诺洗掉了——那正是上一版 `programmatic` 标志会漏的路径。
 *
 * B152 语义（用户 2026-10-16 拍板）：按**文档**记开关。关 → 仅当前 pane 滚（不广播）；
 * 开 → 所有同文件视口（同 docId 的 editor + preview + 其它 tab/面板）同步。
 *
 * B297（用户 2026-10-18 拍板）：这条联动不再止于本窗口 —— 开着同步的那份文档，滚任何一个
 * 窗口，所有窗口里同一文档的可见面都落到同一个 `v`。跨窗口只是本模块的一个**可选端口**
 * （`setOutbound`）：判定与广播的时机与窗内完全同一个，所以「回声不外发、补写不外发、
 * 远端套用不外发」不需要再写第二套规则。
 */

import type { ScrollAnchor } from "./anchor";

/**
 * 协调器挂监听的可视面（生产传入预览/编辑器的滚动容器，测试用 fake）。
 * `label` 只给 TRACE 日志用（`P1:preview` 这种），判定逻辑一个字节都不看它。
 */
export interface CoordinatedSurface {
  /** 滚动容器（DOM 节点），协调器在它上面挂 `scroll` 监听。 */
  readonly events: EventTarget;
  readonly label?: string;
}

/** 已注册的锚点句柄（register 返回，unregister / syncFrom 用）。 */
export interface AnchorHandle {
  readonly anchor: ScrollAnchor;
  readonly docId: string;
  readonly surface?: CoordinatedSurface;
}

/** 驱动源的最小形状：一个锚点 + 它所属的文档。`label` 只用于 TRACE 认是谁驱动的。 */
type DriverRef = { anchor: ScrollAnchor; docId: string; label?: string };

/**
 * 判定「读到的位置就是承诺的位置」的容差，单位是**源码行**。
 * 0.05 行 = 一行高的 5%，远高于像素取整/浮点噪声，又远低于用户一次最小滚动步长
 * （键盘一次 1 行），所以它不会把「用户动了一下」误判成「就是我们写的那一下」。
 */
const V_EPS = 0.05;

/**
 * 一笔承诺最多补写几次。补写是为了**兑现自己说好的位置**（同栈写入被裁剪的场景），
 * 不是轮询布局：只有真的收到一发对不上的 scroll 才会消耗一次。到上限就承认现状，
 * 并且仍然不广播——那一下始终不是用户滚的。
 */
const MAX_REASSERT = 3;

/**
 * 判定「这一发就是**我们那次写入**的回声」的像素容差。
 * 1px 只用来吃掉取整噪声；用户最小的一步（键盘一行 ≈ 16~20px）远在它之外。
 */
const PX_EPS = 1;

/** TRACE 日志读数：两位小数足够分出「差一格」与「差半屏」。 */
const n = (v: number | null): string => (v === null ? "-" : v.toFixed(2));

/**
 * 滚动面当前的像素读数。读不到（不是元素的面、单测里的假面）⇒ null ⇒ 退回按 v 认回声。
 *
 * 为什么非像素不可：`v`（源码行号）**不是跨「布局定局」守恒的量**。CM6 虚拟化下
 * `setState` 之后高度图只覆盖到视口附近，写入被当时的 scrollHeight 裁住；高度图细化后
 * **同一个 scrollTop 会被重新解释成另一个行号**。真机 2026-10-18 02:42 就是这一形状：
 * 登记 `意图=20.25 落点=14.74`，回声 `obs=20.13`（像素一直是 702）⇒ 按 v 比既不是意图
 * 也不是落点 ⇒ 被判成「别人挪走了」⇒ 假广播拽走对栏 + 漂移值被存进位置记忆（逐次衰减）。
 */
function pxOf(target: EventTarget): number | null {
  const px = (target as { scrollTop?: unknown }).scrollTop;
  return typeof px === "number" ? px : null;
}

/** 一个滚动面的账本。 */
interface Ledger {
  /** 我们承诺它应该落在这；null = 没有任何在途承诺 ⇒ 下一次滚动算用户滚动。 */
  expectedV: number | null;
  /**
   * 我们上一次写入**真实落到**的位置（`setV` 的回报值 / 登记时的读回值）。
   * 它和意图不同才是关键：被容器上限裁住、或布局没定局时，回声报的是这个值，
   * 观察值只要既不是意图也不是它，就只能是别人挪的 ⇒ 用户滚动。
   */
  landedV: number;
  /**
   * 上一次写入落定那一刻的**像素**读数（读不到 ⇒ null）。
   * 回声的身份认它，不认 `landedV`：布局定局前后同一个像素会被换算成不同的 `v`，
   * 只比 `v` 就会把自己那一发判成用户滚动（见 `pxOf`）。
   */
  landedPx: number | null;
  /** 这笔承诺已经补写过几次（只在「收到对不上的 scroll」时递增）。 */
  reasserts: number;
}

interface InternalEntry extends AnchorHandle {
  handlers?: { onScroll: EventListener };
}

/**
 * 同步滚动协调器：把同 docId 的多个锚点（editor / preview / 其它 tab / 面板）按滚动联动。
 */
export class SyncScrollCoordinator {
  private readonly entries = new Map<string, Set<InternalEntry>>();
  /** 按文档的 B152 开关（默认开，与 B152 默认值一致）。 */
  private readonly docEnabled = new Map<string, boolean>();
  /** 账本：按滚动面（DOM 节点）记，不受锚点对象重建影响。 */
  private readonly ledgers = new Map<EventTarget, Ledger>();
  private rafId: number | null = null;
  private pendingDriver: DriverRef | InternalEntry | null = null;
  private readonly schedule: (fn: () => void) => number | null;
  /**
   * TRACE 日志出口，由 `wire.ts` 注入（绑到 `logger.trace("sync", …)`）。
   *
   * 走注入而不是直接 import `core/logger`：本模块是纯逻辑（`schedule` 同款纪律），
   * 单测里没有 Tauri IPC，引日志模块就得给 72 个测试文件补 mock。默认空实现，
   * 生产把这一步接上 ⇒ 真机报「位置最终不对」时能直接读出**哪条分支把这一发判成了什么**。
   */
  private readonly trace: (msg: string) => void;
  /** 滚动面 → 人类可读标签（只服务日志；账本按 EventTarget 记，不受它影响）。 */
  private readonly labels = new Map<EventTarget, string>();
  /**
   * 跨窗口外发口（B297）：由 `multiwindow/windows.ts` 注册，把「这一文档被用户滚到了 v」
   * 告诉其它窗口。没注册 = 单窗口行为，与本模块改造前一字不差。
   *
   * 走注入而不是在本模块 import `ipc/api`：本文件是纯逻辑（`schedule` / `trace` 同款纪律），
   * 而且依赖方向必须是 `multiwindow → sync-scroll`，反过来会把 Tauri 事件层拖进协调器。
   */
  private outbound: ((docId: string, v: number, at: number | null) => void) | null = null;
  /** 账本判成「用户挪动了这一格」时的宿主通知（B302 持久化），与同步开关无关。 */
  private onUserScroll: ((docId: string, v: number) => void) | null = null;

  constructor(
    schedule: (fn: () => void) => number | null = (fn) => requestAnimationFrame(fn),
    trace: (msg: string) => void = () => {},
  ) {
    this.schedule = schedule;
    this.trace = trace;
  }

  /** 装 / 拆跨窗口外发口（传 null 拆掉）。`at` 是顶边那一视觉行的字符位置（B300），可空。 */
  setOutbound(fn: ((docId: string, v: number, at: number | null) => void) | null): void {
    this.outbound = fn;
  }

  /**
   * 装 / 拆「这一格被用户挪动了」的宿主通知（B302 · 持久化用）。
   *
   * ⚠️ 它在 `isOn` 那道闸**之前**触发，这是与 `outbound` 唯一的区别：位置是这一格自己的
   * 事实，同步开关关着也得落盘；开关 gate 的是「要不要把别人也扶过去」，不是「发生了什么」。
   * 触发点仍然只有账本判成「用户滚动 / 主动跳转」那几支 —— 回声、补写、远端套用不算。
   */
  setOnUserScroll(fn: ((docId: string, v: number) => void) | null): void {
    this.onUserScroll = fn;
  }

  private labelOf(surface?: EventTarget): string {
    return (surface && this.labels.get(surface)) || "?";
  }

  // ───────────────────────────── 开关 ─────────────────────────────

  /** B152 开关（按文档）：开 → 所有同文件视口同步；关 → 仅当前 pane（不广播）。 */
  setEnabled(docId: string, on: boolean): void {
    this.docEnabled.set(docId, on);
  }

  /** 该文档当前是否开启同步（默认开）。 */
  isOn(docId: string): boolean {
    return this.docEnabled.get(docId) !== false;
  }

  // ───────────────────────────── 账本 ─────────────────────────────

  private ledgerFor(surface: EventTarget): Ledger {
    let l = this.ledgers.get(surface);
    if (!l) {
      l = { expectedV: null, landedV: 1, landedPx: null, reasserts: 0 };
      this.ledgers.set(surface, l);
    }
    return l;
  }

  /** 该文档当前的共享坐标（B292 · 方案 A）：同步开着且有**量得出位置**的在册视口时，读它们的 `v`。
   *  同一个文档的在册视口本来就互相跟齐，所以读第一个报得出数的就是那个共享值。同步关 / 一个都
   *  不在册 / 只剩量不出来的面 ⇒ null ⇒ 调用方回落到「这张标签自己记的位置」。
   *  ⚠️ 那个「量不出来」的门槛是 B299：没铺开的预览面 `getV()` 硬报 1.0，把它当权威就等于把
   *  正确记忆改写成顶部 —— 新窗口冷启动那份正是这么塌到顶的。 */
  currentV(docId: string): number | null {
    if (!this.isOn(docId)) return null;
    for (const e of this.entries.get(docId) ?? []) {
      if (!e.surface) continue;
      if (e.anchor.hasPosition?.() === false) continue;
      return e.anchor.getV();
    }
    return null;
  }

  /**
   * **单一写入方登记口**：协调器之外任何要动某个视口 `scrollTop` 的代码，都必须在写完
   * 之后的**同一同步调用栈内**调这个，把「我打算让它停在哪」和「那一写当时实际落在哪」
   * 一起登记进来。
   *
   * 语义是：随后来自这个滚动面、且位置等于这两个值之一的 scroll 是我们自己写出来的回声，
   * 别当作用户滚动去广播；落到两者之外的，才是用户。
   *
   * ⚠️ `landedV` 必须是**写入之后**读回的值，不能拿 `intentV` 顶替：布局没定局时那发回声
   * 报的就是 `landedV`，把它记成意图等于把它判成用户滚动 ⇒ 对栏被拽到落点上。
   * 「落在哪就是哪」的场景（重载 / 整态重建 / 预览重渲染）两个值传同一个即可。
   *
   * 需要它的四类调用点（漏一类就复现一条「自动跳变」）：
   *   - `switchTab()` / `split.ts`：CM6 `setState` 归零 + 位置恢复；
   *   - `io/files.ts` 重载、`multiwindow/windows.ts` 整态重建：`setState` 归零重排；
   *   - `PreviewPane.setBlocks()`：`replaceChildren` 清零再同栈复原；
   *   - `PreviewPane.applySyncToLine()` / `applyPending()`：大纲跳转、图片/增强后的补定位。
   *
   * 按**滚动面**寻址（不是按锚点对象）：`reconcileSyncRegistrations()` 每次都新建锚点，
   * 承诺必须活过那轮重建。登记也不要求这一格当前在册——被 CSS 藏着的格子的显隐时机
   * 跟账本无关。
   */
  expectSurfaceV(events: EventTarget, intentV: number, landedV: number): void {
    const l = this.ledgerFor(events);
    l.expectedV = intentV;
    l.landedV = landedV;
    // 像素必须在**登记的这一刻**取：调用方刚写完，此刻的 `scrollTop` 就是那一发的真实落点。
    l.landedPx = pxOf(events);
    l.reasserts = 0;
    this.trace(
      `登记[${this.labelOf(events)}] 意图=${n(intentV)} 落点=${n(landedV)} 落点px=${n(l.landedPx)}`,
    );
  }

  /**
   * 该滚动面当前的承诺（只读，供验证台与单测断言「此刻有没有在途认领」）。
   * null = 没有承诺在途 ⇒ 下一发 scroll 会被判成用户滚动。
   */
  pendingExpectation(events: EventTarget): number | null {
    return this.ledgers.get(events)?.expectedV ?? null;
  }

  // ───────────────────────────── 注册 ─────────────────────────────

  /** 注册一个锚点（带可视面时自动挂 `scroll` 监听）。返回句柄供注销 / 驱动。 */
  register(anchor: ScrollAnchor, docId: string, surface?: CoordinatedSurface): AnchorHandle {
    const entry: InternalEntry = { anchor, docId, surface };
    if (surface?.label) this.labels.set(surface.events, surface.label);
    let set = this.entries.get(docId);
    if (!set) {
      set = new Set();
      this.entries.set(docId, set);
    }
    set.add(entry);
    if (surface) this.attach(entry);
    return entry;
  }

  /** 注销锚点并解绑监听。**账本不跟着清**：它在途的承诺属于那个 DOM 节点，不属于这个对象。 */
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

  // ───────────────────────────── 驱动 ─────────────────────────────

  /**
   * 程序化跳转驱动（已注册的锚点）：调用方先把 driver 自身滚到目标，本方法只把它的
   * `getV()` 广播给同 docId 的其余锚点（不回写 driver）。亦可传未注册的 ScrollAnchor。
   */
  syncFrom(target: ScrollAnchor | AnchorHandle): void {
    const entry = this.toEntry(target);
    if (entry) this.drive(entry);
  }

  /**
   * 程序化跳转驱动（直接给锚点，无需先在册）：调用方先把 driver 自身滚到目标，本方法在
   * **下一帧**读它的 `getV()` 并广播。
   *
   * ⚠️ 别用它驱动「此刻看不见的那一侧」：被 `display:none` 藏起来的编辑器 `scrollTop` 恒 0，
   * 只能报出兜底的 1.00 ⇒ 全窗口被拽上顶（B301，真机 19:23 预览态标签上点大纲那一族）。
   * 跳转的目标行调用方本来就知道，那种场合用 `syncTo`。
   */
  syncFromDriver(docId: string, driver: ScrollAnchor): void {
    if (!this.isOn(docId)) return;
    this.pendingDriver = { anchor: driver, docId };
    this.scheduleFrame();
  }

  /**
   * 程序化跳转驱动（直接给坐标）：TOC 点击 / 转到行用。
   *
   * 「跳到哪一行」是调用方的**事实**，不是任何一个面此刻的读数 —— 所以这一发谁都不去读：
   * 值直接外发给别的窗口，窗内则写进每一个在册面（包括本窗口看得见的那一侧）。
   * 关着那份文档的同步时一声不响：开关 gate 的是整条联动，收端与本地跳转都算。
   */
  syncTo(docId: string, v: number): void {
    this.onUserScroll?.(docId, v); // 跳转也是用户的一次意图，关着同步同样要落盘
    if (!this.isOn(docId)) return;
    this.pendingDriver = { anchor: { getV: () => v, setV: (x) => x }, docId, label: "跳转" };
    this.scheduleFrame();
  }

  private toEntry(target: ScrollAnchor | AnchorHandle): InternalEntry | null {
    if (this.isHandle(target)) {
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

  /**
   * 用户滚动：driver 落定后，下一帧把它的 v 广播给同 docId 的其余锚点。
   *
   * ⚠️ 这里**不**过 `isOn` 那道闸：位置是这一格自己的事实，开关关着也得让宿主知道一次
   * （B302 落盘）。闸在帧体里，gate 掉的是「把别人也扶过去」，不是「发生了什么」；
   * 而通知跟着帧走还有一个必要的好处 —— 一次滚动手势几十发 `scroll` 只在落定那帧报一次。
   */
  private drive(entry: InternalEntry): void {
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
      // 顶边那一视觉行的字符位置（B300 · 逐行对齐）：`v` 的小数是「该逻辑行块高的比例」，
      // 而块高随宽度变 ⇒ 两格宽度不同时同一个 `v` 对应的不是同一行文字。字符位置是宽度无关
      // 的事实，所以能拿到就一起带出去；拿不到（隐藏侧 / 预览面 / 老对端）就照旧只传 `v`。
      const at = driver.anchor.topPos?.() ?? null;
      // 落盘通知（B302）：一次滚动手势几十发 `scroll` 在这里只汇成一发，且报的是**落定后**
      // 的读数。它在开关闸之前 —— 同步关着的时候，「这一格停在哪」照样是该记的事实。
      this.onUserScroll?.(driver.docId, v);
      if (!this.isOn(driver.docId)) return;
      // 跨窗口外发（B297）：能走到这里，说明这一发已经被账本判成「用户滚的 / 有人主动跳」，
      // 而 `v` 是**这一帧落定后**的读数（`syncTo` 那一类跳转则是跳转本身给的坐标）——
      // 与本窗口兄弟面拿到的那一个字节不差。
      // 只在能到达这里的路径上触发（回声、补写、远端套用都不经过 `drive`），所以这一发
      // 天然不会把对端推回来的位置再推回去。
      this.outbound?.(driver.docId, v, at);
      const set = this.entries.get(driver.docId);
      if (!set) return;
      this.trace(
        `帧广播 doc=${driver.docId} 驱动=[${
          (driver as DriverRef).label ?? this.labelOf((driver as InternalEntry).surface?.events)
        }] v=${n(v)}${at === null ? "" : ` 行首@${at}`} 目标=${set.size - 1}`,
      );
      for (const e of set) {
        if (e.anchor === driver.anchor) continue; // 不回写 driver（无回环）
        this.writeTo(e, v, at);
      }
    });
  }

  /**
   * 把某个锚点写到 v，并把这一笔（意图 + 真实落点）登记进账本。
   *
   * 两个值都要记。只记意图的话，「布局没定局所以还没落地」与「这一格真的到不了那儿」
   * 在账本里长得一样，于是到底之后用户的每一格滚动都会被判成前者而被补写拽回去。
   * 真实落点由 `setV` 诚实回报（见 anchor.ts）；意图则不能换成落点，否则内容刚重建时
   * 承诺会被改写成那个错位置、再也追不上——那正是历代「到底两侧对不齐」的形态。
   */
  private writeTo(e: InternalEntry, v: number, at: number | null = null): number {
    const byPos = at !== null && at !== undefined && !!e.anchor.setVAt;
    if (byPos && e.anchor.topPos?.() === at) return e.anchor.getV(); // 已经在那一视觉行 ⇒ 一个字节都不写
    const before = e.anchor.getV();
    if (!byPos && Math.abs(before - v) <= V_EPS) return before;
    const landed = byPos ? e.anchor.setVAt!(at!) : e.anchor.setV(v);
    // 按 pos 对齐的那一发，**意图记成读回值**（就地认领）：两格宽度不同时，同一字符各自算出
    // 的 `v` 本来就不相等，把意图登记成对方的 `v`，紧随其后的回声就会被判成「没兑现」而补写
    // 回去 —— 逐行对齐会被自己拽掉，正是 B290 那一族（认像素不认 v）换了个方向复发。
    const intent = byPos ? landed : v;
    this.trace(
      `广播写[${this.labelOf(e.surface?.events)}] 目标=${n(v)}${
        at === null ? "" : ` 行首@${at}`
      } 落点=${n(landed)}${!byPos && Math.abs(landed - v) > V_EPS ? " (被裁/未定局)" : ""}`,
    );
    if (e.surface) {
      // 先写后登记是安全的：`scroll` 按帧异步派发，同一同步栈内不会重入 onScroll；
      // 而登记必须拿到 setV 的回报值——那才是这一发回声会报上来的位置。
      const l = this.ledgerFor(e.surface.events);
      l.expectedV = intent;
      l.landedV = landed;
      l.landedPx = pxOf(e.surface.events);
      l.reasserts = 0;
    }
    return landed;
  }

  // ───────────────────────────── 事件 ─────────────────────────────

  private attach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s) return;
    const onScroll: EventListener = () => this.onScroll(entry);
    s.events.addEventListener("scroll", onScroll);
    entry.handlers = { onScroll };
  }

  private detach(entry: InternalEntry): void {
    const s = entry.surface;
    if (!s || !entry.handlers) return;
    s.events.removeEventListener("scroll", entry.handlers.onScroll);
    entry.handlers = undefined;
  }

  /**
   * 一发 scroll 的判定。全程只做查表与比较，不猜时间、不猜输入。
   * 见文件头的三条分支。
   */
  private onScroll(entry: InternalEntry): void {
    const surface = entry.surface?.events;
    if (!surface) {
      this.trace(`scroll[${this.labelOf(surface)} doc=${entry.docId}] 判=无滚动面→广播`);
      this.drive(entry);
      return;
    }
    const label = this.labelOf(surface);
    const l = this.ledgerFor(surface);
    if (l.expectedV === null) {
      this.trace(`scroll[${label}] 判=账本无承诺→用户滚动·广播`);
      this.drive(entry); // 没人承诺过位置 ⇒ 这一下只能是用户滚的
      return;
    }
    const observed = entry.anchor.getV();
    const observedPx = pxOf(surface);
    // **回声的身份认像素**：像素没动 ⇒ 就是我们那一发，哪怕 `v` 因为高度图细化换了读数
    // （见 `pxOf` 那段：真机 02:42 的 `意图=20.25 落点=14.74 obs=20.13` 全是同一个 702px）。
    // 读不到像素的面（不是元素 / 单测假面）退回旧的「按 v 比落点」判据，行为不变。
    const echo =
      observedPx !== null && l.landedPx !== null
        ? Math.abs(observedPx - l.landedPx) <= PX_EPS
        : Math.abs(observed - l.landedV) <= V_EPS;
    this.trace(
      `scroll[${label}] obs=${n(observed)} px=${n(observedPx)} 意图=${n(l.expectedV)} 落点=${n(
        l.landedV,
      )}/${n(l.landedPx)} 补=${l.reasserts}`,
    );
    if (Math.abs(observed - l.expectedV) <= V_EPS) {
      l.expectedV = null; // 兑现了：这就是我们自己写的那一下
      l.reasserts = 0;
      this.trace(`  →判=兑现·吞掉`);
      return;
    }
    if (!echo) {
      // 既不是承诺的位置、像素也不是我们写下去那一个 ⇒ 有人把它挪走了 ⇒ 用户滚动。
      // 「到底」那一族靠这条分支保住：意图被容器上限裁住之后承诺永远兑不了现，只比意图
      // 就会把此后每一格用户滚动都判成「没兑现」而被补写拽回原地（到底以后不再跟手）。
      l.expectedV = null;
      l.reasserts = 0;
      this.trace(`  →判=被人挪走→用户滚动·广播`);
      this.drive(entry);
      return;
    }
    if (l.reasserts < MAX_REASSERT) {
      // 还是我们那一发的回声，但位置没落地（内容刚重建、布局还没定局）⇒ 补写兑现。
      // ⚠️ 意图不动：把承诺改成读回值就等于退回「按现状认账」，而布局滞后时读回值正是
      // 那个错位置 —— 一改就永远追不上了。落点（v 与像素）跟着更新，供下一发回声比对。
      l.reasserts++;
      l.landedV = entry.anchor.setV(l.expectedV);
      l.landedPx = pxOf(surface);
      this.trace(`  →判=没兑现·补写#${l.reasserts} 新落点=${n(l.landedV)}/${n(l.landedPx)}`);
      return;
    }
    // 补不上就认账：把**当前落点**登记成新基线，而不是把账本清空。
    // 清空的话，这一格下一次原地重报的那发（内容高度定局后的余波）就会因为没有承诺
    // 在途而被判成用户滚动 ⇒ 把对栏一起拽走。认账成基线之后，只有真的动了新位置才算用户。
    l.expectedV = observed;
    l.landedV = observed;
    l.landedPx = observedPx;
    l.reasserts = 0;
    this.trace(`  →判=补不上→认账为新基线`);
  }
}
