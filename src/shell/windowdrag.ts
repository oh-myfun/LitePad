// 跨窗口标签拖拽协议（B89）。
//
// 背景（用户报的毛病）：拖标签出窗口边界时**立刻**生效——从主窗口拖出，鼠标还没松手
// 就弹了个新窗口；从卫星窗口拖出，指针擦过主窗口就整组合入了，根本没法挑落到主窗口
// 的哪块面板。根因是 `splitview.ts` 在 `onTabDragMove` 里一判定出界就收尾并上报，
// 副作用发生在**拖拽途中**而不是**松手时**。
//
// 本模块把跨窗口这一段改成和窗口内一样的语义：**拖拽途中只有预览，松手才提交**。
//
// 为什么需要一整套 IPC 协议，而不是发起窗口自己算：
//   鼠标按下后 Windows 会把鼠标消息**隐式捕获**给按下的那个窗口（SetCapture），
//   指针掠过另一个 LitePad 窗口时，那个窗口**收不到任何鼠标事件**，发起窗口反而能
//   继续收到 mousemove/mouseup。所以「指针现在在哪块面板上」只有目标窗口自己知道
//   —— 它得通过 IPC 被告知指针位置，并把「我是候选」回报给发起窗口。
//
// 协议（事件名见下方常量，全部是 fire-and-forget）：
//   1. hover    发起窗口广播：指针的**屏幕坐标**（轻量，不含正文）——各窗口判定自己
//               是否被指着：是 → 渲染落点预览并记住落点；否 → 清掉自己的预览。
//   2. release  发起窗口松手时广播：仍然只有坐标，不含正文。
//   3. claim    被指着的窗口定向回给发起窗口：「我接了」。
//   4. payload  发起窗口**只发给接手的那个窗口**：标签快照（含正文）。
//   5. end      收尾广播：没接手的窗口据此清掉预览。
//
// ⚠️ 正文为什么要等 claim 之后再单独发：`emit` 是**广播**，每个窗口都会收到一份完整
//    payload。标签快照里带着正文，几十 MB 的文件这么广播一次就是几十 MB × 窗口数，
//    而真正需要的只有接手的那一个窗口——所以正文走定向的 `emitTo`。
//
// ⚠️ 坐标口径一律是**逻辑像素**（与 CSS 像素一致）：`outerPosition/outerSize/innerSize`
//    返回的都是物理像素，高 DPI 屏上不除以 scaleFactor 会整体偏一倍。

import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 指针位置（逻辑像素，虚拟桌面口径）。 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * 本窗口客户区在**虚拟桌面**上的位置与尺寸（逻辑像素）。
 *
 * ⚠️ 取不到就当 null：宁可不参与命中判定（用户看到的只是「那个窗口没亮预览」），
 * 也不能拿一个瞎猜的几何把标签送到错误的窗口。
 */
export interface WindowGeometry {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** 纯函数（jsdom 可测）：屏幕坐标是否落在本窗口客户区内。 */
export function hitTest(g: WindowGeometry | null, p: ScreenPoint | null): boolean {
  if (!g || !p) return false;
  return (
    p.x >= g.originX &&
    p.x <= g.originX + g.width &&
    p.y >= g.originY &&
    p.y <= g.originY + g.height
  );
}

/** 纯函数：屏幕坐标 → 客户坐标。只在上一步 hitTest 为真之后调用。 */
export function screenToClient(g: WindowGeometry, p: ScreenPoint): ScreenPoint {
  return { x: p.x - g.originX, y: p.y - g.originY };
}

/** 纯函数：客户坐标 → 屏幕坐标（发起窗口广播指针位置时用）。 */
export function clientToScreen(g: WindowGeometry, x: number, y: number): ScreenPoint {
  return { x: g.originX + x, y: g.originY + y };
}

// ---------------------------------------------------------------- 本窗口几何

let geomCache: WindowGeometry | null = null;
let geomPending: Promise<WindowGeometry | null> | null = null;

/**
 * 问一次窗口几何。
 *
 * 与 `main.ts` 的 `dropSpotOf` 同一套换算（边框均分、标题栏算在上边），只是这里要的是
 * **客户区原点**而不是某个指针位置的屏幕坐标。几十像素的偏差换来「不依赖 screenX/
 * screenY」——那对坐标在多显示器下是相对**当前显示器**的口径，跨屏会跑偏。
 */
async function fetchGeometry(): Promise<WindowGeometry | null> {
  try {
    const win = getCurrentWindow();
    const [outer, outerSize, innerSize, scale] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.innerSize(),
      win.scaleFactor(),
    ]);
    const s = scale > 0 ? scale : 1;
    const borderX = (outerSize.width - innerSize.width) / 2;
    const chromeY = outerSize.height - innerSize.height;
    return {
      originX: (outer.x + borderX) / s,
      originY: (outer.y + chromeY) / s,
      width: innerSize.width / s,
      height: innerSize.height / s,
    };
  } catch {
    return null;
  }
}

/**
 * 取本窗口几何（带缓存）。
 *
 * 为什么必须缓存：hover 是跟着 mousemove 走的，每次都问一遍 `outerPosition` 等于把
 * 鼠标移动频率直接变成 IPC 频率。窗口在拖拽期间不会移动，一次拖拽问一次足够。
 */
export function selfGeometry(): Promise<WindowGeometry | null> {
  if (geomCache) return Promise.resolve(geomCache);
  if (!geomPending) {
    geomPending = fetchGeometry().then((g) => {
      geomCache = g;
      geomPending = null;
      return g;
    });
  }
  return geomPending;
}

/** 窗口被移动/缩放后几何就脏了；下一次拖拽重新问。 */
export function invalidateGeometry(): void {
  geomCache = null;
}

// ---------------------------------------------------------------- 协议事件

export const EVT_HOVER = "tab-drag-hover";
export const EVT_RELEASE = "tab-drag-release";
export const EVT_CLAIM = "tab-drag-claim";
export const EVT_PAYLOAD = "tab-drag-payload";
export const EVT_END = "tab-drag-end";

interface CoordPayload {
  from?: string;
  screen?: { x?: number; y?: number } | null;
}
interface ClaimPayload {
  target?: string;
}
interface PayloadOfTabs {
  from?: string;
  tabs?: unknown;
}

/** 坐标字段的完整性与有限性校验（半个坐标 / NaN / ∞ 一律当没看见）。 */
function readPoint(raw: CoordPayload["screen"]): ScreenPoint | null {
  const x = raw?.x;
  const y = raw?.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// ---------------------------------------------------------------- 接收侧

/**
 * 落点由**宿主**算：协议层不该知道布局长什么样。
 * `spot` 对协议层是不透明值——它只负责把「预览时算出来的落点」原样交还给 `accept`。
 */
export interface DropTargetHandler<Spot> {
  /** 指针（客户坐标）落在本窗口何处；null = 没落在任何可放置的地方（此时请清预览）。 */
  preview: (clientX: number, clientY: number) => Spot | null;
  /** 松手落在了本窗口：接管这批标签。返回 false = 一个都没接住（发起方会回落）。 */
  accept: (tabs: unknown, spot: Spot | null) => boolean;
  /** 清掉本窗口的落点预览。 */
  clear: () => void;
}

let receiverLabel = "";
let receiver: DropTargetHandler<unknown> | null = null;
/** 最近一次 hover 算出的落点；release 命中时就用它（松手坐标与之同一时刻）。 */
let lastSpot: unknown = null;
/** 本窗口此刻是否真的画着预览——避免指针在窗外时每帧都白清一次 DOM。 */
let previewActive = false;
let receiverUnlisten: UnlistenFn[] = [];

/**
 * 收掉本窗口的落点预览。
 *
 * `forgetSpot`（默认 true）= 连落点一起作废：指针**不在本窗口**了，那个落点已经过时。
 *
 * ⚠️ 拖拽结束（`EVT_END`）必须传 **false** —— 只收视觉、留住落点。因为发起窗口是
 * 「先广播 END 收尾、再定向投递正文」（`finishTabDrag` 早于落点提交），把落点一起清掉
 * 的话，接手方收到正文时已经不知道该放哪儿了，只能退回活动面板（预览在这、落下在那）。
 */
function clearReceiver(forgetSpot = true): void {
  if (!receiver) return;
  if (previewActive) receiver.clear();
  previewActive = false;
  if (forgetSpot) lastSpot = null;
}

/**
 * 安装接收侧（每个窗口都要装：谁都可能成为落点）。
 *
 * `selfLabel` 用来忽略自己广播的事件——`emit` 会把事件也送回发起窗口自己。
 */
export async function installWindowDropTarget<Spot>(
  selfLabel: string,
  h: DropTargetHandler<Spot>,
): Promise<void> {
  for (const off of receiverUnlisten) off();
  receiverUnlisten = [];
  receiverLabel = selfLabel;
  receiver = h as unknown as DropTargetHandler<unknown>;
  lastSpot = null;

  const onHover = async (e: { payload: CoordPayload }) => {
    if (!receiver || e.payload?.from === receiverLabel) return;
    const p = readPoint(e.payload?.screen);
    const g = await selfGeometry();
    if (!hitTest(g, p)) {
      // 指针不在本窗口：清掉上一次留下的预览，避免「两个窗口同时亮着」。
      clearReceiver();
      return;
    }
    const c = screenToClient(g as WindowGeometry, p as ScreenPoint);
    lastSpot = receiver.preview(c.x, c.y);
    previewActive = true;
  };

  const onRelease = async (e: { payload: CoordPayload }) => {
    if (!receiver || e.payload?.from === receiverLabel) return;
    const p = readPoint(e.payload?.screen);
    const g = await selfGeometry();
    if (!hitTest(g, p)) {
      clearReceiver();
      return;
    }
    // 松手坐标可能比最后一次 hover 精确一帧：按它重算一次落点。
    const c = screenToClient(g as WindowGeometry, p as ScreenPoint);
    lastSpot = receiver.preview(c.x, c.y);
    previewActive = true;
    void emitTo(e.payload?.from ?? "", EVT_CLAIM, { target: receiverLabel }).catch(() => {});
  };

  const onPayload = (e: { payload: PayloadOfTabs }) => {
    if (!receiver || e.payload?.from === receiverLabel) return;
    // 一个都没接住也要收尾：发起方正等着回话，否则它要白白等到超时才回落。
    const ok = receiver.accept(e.payload?.tabs, lastSpot);
    clearReceiver();
    if (!ok) void emitTo(e.payload?.from ?? "", EVT_END, { from: receiverLabel }).catch(() => {});
  };

  const onEnd = (e: { payload: CoordPayload }) => {
    if (!receiver || e.payload?.from === receiverLabel) return;
    clearReceiver(false);
  };

  receiverUnlisten = await Promise.all([
    listen<CoordPayload>(EVT_HOVER, onHover),
    listen<CoordPayload>(EVT_RELEASE, onRelease),
    listen<PayloadOfTabs>(EVT_PAYLOAD, onPayload),
    listen<CoordPayload>(EVT_END, onEnd),
  ]);
}

/** 拆掉接收侧（窗口关闭/测试收尾用）。 */
export function uninstallWindowDropTarget(): void {
  for (const off of receiverUnlisten) off();
  receiverUnlisten = [];
  clearReceiver();
  receiver = null;
  previewActive = false;
}

// ---------------------------------------------------------------- 发起侧

/** hover 的最小间隔：mousemove 的频率不该直接变成 IPC 的频率。 */
const HOVER_THROTTLE_MS = 40;

/**
 * 等「有人接手」的上限。
 *
 * 松手到看见结果之间最多卡这么久（只有**扔到桌面**这条路径会真等到超时——那时本来
 * 就要建一个新窗口，200ms 无感）。取太短会漏掉慢一拍的 claim，取太长会让「新建窗口」
 * 显得迟钝。
 */
const CLAIM_TIMEOUT_MS = 200;

export interface WindowDragSession {
  /** 拖拽途中每次移动都调（内部节流）：广播指针的屏幕坐标。 */
  hover: (clientX: number, clientY: number) => void;
  /** 松手：广播 release，等一小会儿看有没有窗口接手。返回接手的窗口 label。 */
  release: () => Promise<string | null>;
  /** 把标签正文**只**发给接手的窗口。 */
  deliver: (target: string, tabs: unknown) => void;
  /** 收尾：广播 end，让没接手的窗口清掉预览。 */
  finish: () => void;
}

/** 正在等 claim 的 release（同时只会有一个拖拽）。 */
let claimWaiter: ((label: string | null) => void) | null = null;
let claimTimer: ReturnType<typeof setTimeout> | null = null;
let claimUnlisten: UnlistenFn | null = null;

function settleClaim(label: string | null): void {
  const w = claimWaiter;
  claimWaiter = null;
  if (claimTimer) clearTimeout(claimTimer);
  claimTimer = null;
  w?.(label);
}

/**
 * 开始一次跨窗口拖拽（发起侧）。
 *
 * `selfLabel` 用来认领自己发出的事件之外的 claim。
 */
export function beginWindowDrag(selfLabel: string): WindowDragSession {
  let lastClient: ScreenPoint | null = null;
  let lastSentAt = 0;

  return {
    hover(clientX, clientY) {
      lastClient = { x: clientX, y: clientY };
      const now = Date.now();
      if (now - lastSentAt < HOVER_THROTTLE_MS) return;
      lastSentAt = now;
      void selfGeometry().then((g) => {
        if (!g || !lastClient) return;
        void emit(EVT_HOVER, {
          from: selfLabel,
          screen: clientToScreen(g, lastClient.x, lastClient.y),
        }).catch(() => {});
      });
    },

    release() {
      return new Promise<string | null>((resolve) => {
        void (async () => {
          // ⚠️ 顺序是刻意的：**先挂上 claim 监听，再广播 release**。反过来的话，
          // 目标窗口的回答可能早于监听就位，这一次拖拽就永远等不到接手的人，
          // 只能干等到超时再回落成「开新窗口」——表现就是「明明拖到了另一个窗口，
          // 却还是新建了一个」。
          const off = await listen<ClaimPayload>(EVT_CLAIM, (e) => {
            const t = e.payload?.target;
            if (!t || t === selfLabel) return;
            settleClaim(t);
          });
          claimUnlisten?.();
          claimUnlisten = off;
          const g = await selfGeometry();
          const screen = g && lastClient ? clientToScreen(g, lastClient.x, lastClient.y) : null;
          claimWaiter = resolve;
          claimTimer = setTimeout(() => settleClaim(null), CLAIM_TIMEOUT_MS);
          void emit(EVT_RELEASE, { from: selfLabel, screen }).catch(() => {
            // 广播失败 = 没人会来认领 → 别让用户干等到超时
            settleClaim(null);
          });
        })();
      });
    },

    deliver(target, tabs) {
      void emitTo(target, EVT_PAYLOAD, { from: selfLabel, tabs }).catch(() => {});
    },

    finish() {
      claimUnlisten?.();
      claimUnlisten = null;
      settleClaim(null);
      invalidateGeometry();
      void emit(EVT_END, { from: selfLabel }).catch(() => {});
    },
  };
}
