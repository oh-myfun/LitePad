// 标签拖拽的 HTML5 DnD 传输层（B91-2）。
//
// 为什么换（用户诉求）：影像要**跟出窗口**。B64–B90 那套指针事件编排里，影像是源窗口
// 里的一个 DOM 浮层 —— 指针一越过窗口边界就看不见了（B90 刻意不夹取，于是变成「拖出去
// 影像就消失」）。HTML5 拖拽的影像由**系统绘制**，指针压在别的应用上照样跟着走。
//
// 前提：B91 已经关掉 wry 的原生拖放处理器（`tauri.conf.json` 的 `dragDropEnabled: false`）。
// 它做的两处劫持（`SetAllowExternalDrop(false)` + 覆盖子窗口 drop target）会把页面内
// HTML5 拖放一起废掉，详见 `src-tauri/src/dropbridge.rs` 模块头。关掉之后本模块与
// `filedrop.ts`（文件拖入）才重新拿得到 `dragenter/dragover/drop`。
//
// 跨窗口交接沿用 B89 定下的语义，**只是把「谁被指着」的判据从坐标换成系统事件**：
//   · 拖拽途中只有预览：目标窗口的 dragover 画落点，源窗口零副作用；
//   · **松手才提交**：drop 在目标窗口触发，由它决定放哪儿。
// 正文仍然必须过一次 IPC —— 标签快照可能几十 MB，塞进 dataTransfer 会跨进程搬运两大趟：
//   1. 目标窗口 drop → `EVT_TAB_CLAIM` 定向问源窗口要这批标签（带 dragId 认领）；
//   2. 源窗口收到 → `EVT_TAB_PAYLOAD` **只发给它一个**（快照含正文）+ 本地摘标签；
//   3. 目标窗口收到 → 按松手时算好的落点落地。
//
// ⚠️ 与 B89 相比删掉了一整套东西：广播指针屏幕坐标、每窗口几何缓存与命中判定、
//   200ms「抢单」超时、hover 节流。目标窗口是被操作系统的拖放循环**直接告知**的，
//   不存在「谁被指着」的歧义，也就不需要这些补偿机制。
//
// ⚠️ 落点（spot）只在目标窗口内算一次，**不经过 IPC** —— 源窗口不需要知道对方打算
//   放在哪块面板；它只负责把正文发过去、然后把自己这边收干净。

import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 标签拖拽的私有 MIME：用来把「标签拖拽」与「文件拖入」（`Files`）分开。 */
export const TAB_MIME = "application/x-litepad-tab";

/** 拖拽期间挂在 body 上的类（CSS 据此换抓取光标 + 禁止文本选区）。 */
export const TAB_DRAG_CLASS = "tab-drag-active";

/** 落点预览节流：dragover 触发极密，几何判定不必跟着跑。 */
const HOVER_THROTTLE_MS = 40;

/**
 * 「等别的窗口认领」的宽限（源窗口侧）。
 *
 * 目标窗口收到 drop 后才定向回来要正文，而 `dragend` 是拖放循环返回后**立刻**触发的
 * —— 认领的 IPC 一定晚于它。没有这段宽限，每一次成功的跨窗口拖拽都会同时被当成
 * 「扔在桌面上」，于是又弹出一个新窗口（标签被复制成两份）。
 */
const CLAIM_GRACE_MS = 300;

/**
 * 拖拽载荷。
 *
 * ⚠️ `from` / `dragId` 由 `startTabDrag` 补，调用方不用管（也**不该**管：自己填
 * 一个过期的 dragId 会让源窗口认不出这是不是本次拖拽）。
 */
export interface TabDragPayload {
  v: 1;
  /** 发起窗口的 label。等于本窗口 → 窗口内拖拽；否则是别的窗口拖过来的。 */
  from: string;
  /** 单标签拖拽的目标标签；整组拖拽无意义（-1）。 */
  tabId: number;
  /** 非 null = 拖的是**整组**（从标签栏空白处起手），值是那个面板的 panelId。 */
  groupPanelId: number | null;
  /** 这批标签有几个（整组时 > 1）。 */
  count: number;
  /** 一次拖拽的唯一编号：claim / payload 靠它认领，避免跨拖拽串台。 */
  dragId: string;
}

// ---------------------------------------------------------------- 编解码（纯函数）

export function encodeTabDrag(p: TabDragPayload): string {
  return JSON.stringify(p);
}

/** 逐字段校验：半个载荷 / 类型不对 / 版本不认识 一律当没看见。 */
export function decodeTabDrag(raw: unknown): TabDragPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<TabDragPayload>;
  if (p.v !== 1) return null;
  if (typeof p.from !== "string" || p.from === "") return null;
  if (typeof p.dragId !== "string" || p.dragId === "") return null;
  if (typeof p.tabId !== "number" || !Number.isInteger(p.tabId)) return null;
  const group = p.groupPanelId ?? null;
  if (group !== null && (typeof group !== "number" || !Number.isInteger(group))) return null;
  return {
    v: 1,
    from: p.from,
    tabId: p.tabId,
    groupPanelId: group,
    count: typeof p.count === "number" && p.count > 0 ? p.count : 1,
    dragId: p.dragId,
  };
}

/** 这次拖拽是不是「标签拖拽」。只看 types（拖拽途中读不到 data，只有 types 可用）。 */
export function isTabDragData(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = dt.types as unknown as ArrayLike<string> | undefined;
  return types ? Array.from(types).includes(TAB_MIME) : false;
}

/**
 * 松手时读出载荷。
 *
 * ⚠️ 只有 `drop` 里能读 `getData`（`dragenter`/`dragover` 期间浏览器处于保护模式，
 * 一律返回空串）—— 所以「是什么」在 dragover 阶段只能靠 `types` 判，具体内容等落地。
 */
export function readTabDragPayload(dt: DataTransfer | null | undefined): TabDragPayload | null {
  if (!isTabDragData(dt)) return null;
  try {
    return decodeTabDrag(dt?.getData(TAB_MIME));
  } catch {
    return null;
  }
}

/** 影像锚点：交给 `setDragImage` 的「光标落在影像内的哪一点」。 */
export interface DragImageAnchor {
  x: number;
  y: number;
}

// ---------------------------------------------------------------- 宿主接线

export interface LocalDrop {
  payload: TabDragPayload;
  x: number;
  y: number;
  altKey: boolean;
  ctrlKey: boolean;
}

export interface TabDndConfig {
  /** 本窗口 label。用来认领「自己发起的拖拽」与忽略自己事件。 */
  selfLabel: string;
  /** 指针落在本窗口 (x, y)：画落点预览，返回落点（对传输层是不透明值）。 */
  preview: (x: number, y: number, altKey: boolean) => unknown;
  /** 清掉本窗口的落点痕迹（分屏预览 + 标签插入指示线）。 */
  clear: () => void;
  /**
   * 松手落在**本窗口**：宿主自己消化（排序 / 分屏 / 并入或什么都不做）。
   *
   * ⚠️ 返回 false 也算「这次拖拽在本窗口结束了」，不得再走回落 —— 窗口内松手
   * 却弹出个新窗口是最糟的失败模式。
   */
  commitLocal: (req: LocalDrop) => boolean;
  /** 别的窗口来要标签：给出这批标签的快照；null = 一个都交不出。 */
  snapshot: (payload: TabDragPayload) => unknown | null;
  /**
   * 交出去之后本窗口的收尾（摘标签 / 摘空面板 / 写会话）。
   *
   * `toLabel` = 接手的那个窗口。主窗口要用它登记「隐藏实例归谁」，卫星窗口异常消失
   * 时才能把标签恢复回来（见 `main.ts` 的 `remoteTabLocally`）。
   */
  relinquish: (payload: TabDragPayload, toLabel: string) => void;
  /** 接住别的窗口送来的标签（按松手时算好的落点）。 */
  adopt: (tabs: unknown, spot: unknown) => boolean;
  /** 松手在**窗口外**且没人接手（扔在桌面上）：源窗口的回落。 */
  onFallback: (payload: TabDragPayload, screenX: number, screenY: number) => void;
  /** 载荷读不出来（WebView2 跨窗口没把自定义 MIME 带过来）等异常，宿主自行记日志。 */
  onWarn?: (what: string) => void;
}

let config: TabDndConfig | null = null;

/** 本窗口正在进行的拖拽（**源窗口**侧的状态；别的窗口拖过来时这里是 null）。 */
interface SourceDrag {
  payload: TabDragPayload;
  /** 有别的窗口来认领过 → 不走回落。 */
  taken: boolean;
}
let source: SourceDrag | null = null;

let dragSeq = 0;
function nextDragId(): string {
  dragSeq += 1;
  return `${Date.now().toString(36)}-${dragSeq.toString(36)}`;
}

/**
 * 从 `dragstart` 里调用：写载荷 + 把影像交给系统。
 *
 * `image` 由调用方造（标签副本 / 整组药丸）。本函数负责把它离屏挂进 body、
 * 交给 `setDragImage`、随即摘掉 —— **必须已经渲染过**才能拍出图：detached 元素在
 * 部分 Chromium 版本上会拍出一张空图，所以不能只 createElement 就传进来。
 *
 * ⚠️ `setDragImage` 是**同步快照**，返回后就可以把元素摘掉，不会拍成空白。
 */
export function startTabDrag(
  e: DragEvent,
  payload: { tabId: number; groupPanelId: number | null; count: number; name?: string },
  image: HTMLElement | null,
  anchor: DragImageAnchor = { x: 0, y: 0 },
): string | null {
  const cfg = config;
  const dt = e.dataTransfer;
  if (!cfg || !dt) {
    e.preventDefault();
    return null;
  }
  const dragId = nextDragId();
  const full: TabDragPayload = {
    v: 1,
    from: cfg.selfLabel,
    tabId: payload.tabId,
    groupPanelId: payload.groupPanelId,
    count: payload.count,
    dragId,
  };
  dt.effectAllowed = "copyMove";
  dt.setData(TAB_MIME, encodeTabDrag(full));
  // 顺手给别的应用一个可读正文（拖进编辑器 = 粘上标签名）。只给名字不给路径：
  // 路径会跟着跑到无关的应用里，而标签名已经够用户认出自己拖的是什么。
  try {
    if (payload.name) dt.setData("text/plain", payload.name);
  } catch {
    /* 个别环境拒收自定义 MIME，不影响本窗口内与窗口间的拖拽 */
  }
  if (image) {
    image.classList.add("tab-drag-image");
    document.body.appendChild(image);
    dt.setDragImage(image, anchor.x, anchor.y);
    image.remove();
  }
  source = { payload: full, taken: false };
  document.body.classList.add(TAB_DRAG_CLASS);
  return dragId;
}

/** 认领本次拖拽（目标窗口来要正文时）；返回载荷，不是本次拖拽则返回 null。 */
function takeForClaim(dragId: string): TabDragPayload | null {
  if (!source || source.payload.dragId !== dragId) return null;
  source.taken = true;
  return source.payload;
}

// ---------------------------------------------------------------- 目标窗口侧

export const EVT_TAB_CLAIM = "tab-dnd-claim";
export const EVT_TAB_PAYLOAD = "tab-dnd-payload";

interface ClaimMsg {
  from?: string;
  dragId?: string;
}
interface PayloadMsg {
  from?: string;
  dragId?: string;
  tabs?: unknown;
}

let hopDepth = 0;
let lastPreviewAt = 0;
/** 已 drop 的跨窗口拖拽：正文回来时要按当时算好的落点落地。 */
let pendingForeign: { dragId: string; spot: unknown } | null = null;

/**
 * 装上标签拖拽的页面级收接（每个窗口都要装：谁都可能成为落点）。
 * 返回卸载函数。
 */
export async function installTabDnd(cfg: TabDndConfig): Promise<() => void> {
  config = cfg;
  hopDepth = 0;
  lastPreviewAt = 0;
  pendingForeign = null;

  const onEnter = (e: DragEvent): void => {
    if (isTabDragData(e.dataTransfer)) hopDepth += 1;
  };

  const onOver = (e: DragEvent): void => {
    if (!isTabDragData(e.dataTransfer)) return;
    // ⚠️ 必须 preventDefault：不拦的话光标是禁止态、drop 根本不触发 ——
    // 「这个窗口收标签」这句话得由页面自己说。
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    const now = e.timeStamp;
    if (now - lastPreviewAt < HOVER_THROTTLE_MS) return;
    lastPreviewAt = now;
    cfg.preview(e.clientX, e.clientY, e.altKey);
  };

  const onLeave = (e: DragEvent): void => {
    if (!isTabDragData(e.dataTransfer)) return;
    hopDepth = Math.max(0, hopDepth - 1);
    // relatedTarget 为空 = 真的离开窗口，而不是在子元素之间挪动
    if (hopDepth === 0 || e.relatedTarget === null) cfg.clear();
  };

  const onDrop = (e: DragEvent): void => {
    const payload = readTabDragPayload(e.dataTransfer);
    if (!payload) {
      // types 说是标签拖拽、data 却读不出来 = 自定义 MIME 没能跨过进程边界。
      // 后果是「跨窗口拖拽静默无效」，必须留一行日志才排得动。
      if (isTabDragData(e.dataTransfer)) cfg.onWarn?.("tab drag payload unreadable");
      return;
    }
    e.preventDefault();
    hopDepth = 0;
    lastPreviewAt = 0;
    // 松手坐标可能比最后一次 dragover 精确一帧：按它重算一次落点再收痕迹
    const spot = cfg.preview(e.clientX, e.clientY, e.altKey);
    cfg.clear();

    if (payload.from === cfg.selfLabel) {
      // 自己拖的：窗口内落点，宿主自己消化（返回 false 也不得回落）。
      //
      // ⚠️ **就地收尾，不等 dragend**：落点常常会重建面板 DOM（分屏 / 并入），源标签
      // 元素随之脱离文档 —— 而 `dragend` 是派发到**源元素**上的，元素脱离文档就不再
      // 冒泡到 document，挂在那儿的监听根本收不到。等它的后果是
      // `body.tab-drag-active`（全局禁文本选区）一直挂着，直到下一次拖拽才被顶掉。
      if (source?.payload.dragId === payload.dragId) source = null;
      document.body.classList.remove(TAB_DRAG_CLASS);
      cfg.commitLocal({
        payload,
        x: e.clientX,
        y: e.clientY,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
      });
      return;
    }
    // 别的窗口拖来的：先认领（源窗口据此把正文定向发过来），落点留在这儿等正文
    pendingForeign = { dragId: payload.dragId, spot };
    void emitTo(payload.from, EVT_TAB_CLAIM, {
      from: cfg.selfLabel,
      dragId: payload.dragId,
    }).catch(() => {
      if (pendingForeign?.dragId === payload.dragId) pendingForeign = null;
    });
  };

  const onDragEnd = (e: DragEvent): void => {
    const s = source;
    document.body.classList.remove(TAB_DRAG_CLASS);
    config?.clear();
    if (!s) return;
    const sx = e.screenX;
    const sy = e.screenY;
    // ⚠️ `source` 要**等宽限期过去**才清掉：对方来认领时靠 dragId 配对，而认领是 IPC
    // 往返、一定晚于 dragend。这里提前清的话认领会配不上、被当成过期事件丢掉 ——
    // 结果是标签既没交出去（宿主不会 relinquish）又多开了一个窗口。
    setTimeout(() => {
      if (source === s) source = null;
      if (s.taken) return;
      config?.onFallback(s.payload, sx, sy);
    }, CLAIM_GRACE_MS);
  };

  const onClaim = (e: { payload: ClaimMsg }): void => {
    const from = e.payload?.from;
    const dragId = e.payload?.dragId;
    if (!from || !dragId || from === cfg.selfLabel) return;
    const payload = takeForClaim(dragId);
    if (!payload) return; // 不是本次拖拽（过期 / 串台）
    const snapshots = cfg.snapshot(payload);
    if (snapshots == null) return; // 一个都交不出：对方那边会一直等着，落点自然落空
    void emitTo(from, EVT_TAB_PAYLOAD, { from: cfg.selfLabel, dragId, tabs: snapshots }).catch(
      () => {},
    );
    cfg.relinquish(payload, from);
  };

  const onPayload = (e: { payload: PayloadMsg }): void => {
    const p = e.payload;
    if (!p || p.from === cfg.selfLabel) return;
    const pend = pendingForeign;
    if (!pend || pend.dragId !== p.dragId) return;
    pendingForeign = null;
    cfg.adopt(p.tabs, pend.spot);
  };

  document.addEventListener("dragenter", onEnter);
  document.addEventListener("dragover", onOver);
  document.addEventListener("dragleave", onLeave);
  document.addEventListener("drop", onDrop);
  document.addEventListener("dragend", onDragEnd);

  let unlisten: UnlistenFn[] = [];
  try {
    unlisten = await Promise.all([
      listen<ClaimMsg>(EVT_TAB_CLAIM, onClaim),
      listen<PayloadMsg>(EVT_TAB_PAYLOAD, onPayload),
    ]);
  } catch {
    /* 拿不到事件通道：窗口内拖拽照常，跨窗口交接退化为「扔桌面」回落 */
  }

  return () => {
    document.removeEventListener("dragenter", onEnter);
    document.removeEventListener("dragover", onOver);
    document.removeEventListener("dragleave", onLeave);
    document.removeEventListener("drop", onDrop);
    document.removeEventListener("dragend", onDragEnd);
    for (const off of unlisten) off();
    unlisten = [];
    pendingForeign = null;
    source = null;
    config = null;
  };
}
