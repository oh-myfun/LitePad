// @vitest-environment jsdom
// B91-2：标签拖拽的 HTML5 DnD 传输层。
//
// 为什么值得单独锁一整个文件：这一层同时承担两件**失败起来很难看**的事 ——
//   · 窗口内拖拽（排序 / 分屏 / 整组并入）：错了就是「拖一下标签没了」；
//   · 跨窗口交接：错了会**复制**标签（两边都留一份）或多出一个新窗口。
// 而它依赖的两个外部事实（外部 HTML5 拖放能进页面、自定义 MIME 能跨窗口）都不是
// 单测能证明的，所以这里锁的是「在这些事实成立的前提下，我们的编排有没有按设计走」：
//
//   1. 载荷编解码：逐字段校验，半个载荷 / 版本不认识 / 类型不对一律当没看见；
//   2. 源侧：写私有 MIME + 把影像交给系统（`setDragImage`），且影像拍完即摘；
//   3. 目标侧：`dragover` 必须 preventDefault（不拦就收不到 drop）、只认自己的 MIME
//      （文件拖入与标签拖拽共用同一套事件，靠 MIME 分清）；
//   4. **松手才提交**（B89 定的语义）：落体在本窗口 → commitLocal；别的窗口 → 认领
//      + 定向投递正文；
//   5. **不误伤**：窗口内松手绝不回落（否则会莫名多出一个新窗口）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const bus = vi.hoisted(() => ({
  sent: [] as Array<{ target: string; event: string; payload: unknown }>,
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (target: string, event: string, payload: unknown) => {
    bus.sent.push({ target, event, payload });
    return Promise.resolve();
  },
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    bus.listeners.set(event, cb);
    return Promise.resolve(() => bus.listeners.delete(event));
  },
}));

import {
  EVT_TAB_CLAIM,
  EVT_TAB_PAYLOAD,
  TAB_MIME,
  decodeTabDrag,
  encodeTabDrag,
  installTabDnd,
  isTabDragData,
  readTabDragPayload,
  startTabDrag,
  type TabDndConfig,
  type TabDragPayload,
} from "../src/shell/tabdnd";
import { fireDrag, makeDataTransfer, type FakeDataTransfer } from "./dnd";

function payload(over: Partial<TabDragPayload> = {}): TabDragPayload {
  return { v: 1, from: "main", tabId: 11, groupPanelId: null, count: 1, dragId: "d1", ...over };
}

/** 收集配置里各个回调的调用；默认全部「成功」。 */
function makeConfig(over: Partial<TabDndConfig> = {}) {
  const calls = {
    preview: vi.fn(() => ({ panelId: 1, zone: "center" as const, beforeTabId: null })),
    clear: vi.fn(),
    commitLocal: vi.fn(() => true),
    snapshot: vi.fn(() => [{ docId: 7, text: "hello" }]),
    relinquish: vi.fn(),
    adopt: vi.fn(() => true),
    onFallback: vi.fn(),
    onWarn: vi.fn(),
  };
  const cfg = {
    selfLabel: "main",
    preview: calls.preview,
    clear: calls.clear,
    commitLocal: calls.commitLocal,
    snapshot: calls.snapshot,
    relinquish: calls.relinquish,
    adopt: calls.adopt,
    onFallback: calls.onFallback,
    onWarn: calls.onWarn,
    ...over,
  } as TabDndConfig;
  return { cfg, calls };
}

let uninstall: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  bus.sent.length = 0;
  bus.listeners.clear();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

/** 开始一次「本窗口发起」的拖拽，返回它写好的 dataTransfer。 */
function beginDrag(
  over: Partial<{ tabId: number; groupPanelId: number | null; count: number }> = {},
): FakeDataTransfer {
  const dt = makeDataTransfer();
  const e = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt, configurable: true });
  startTabDrag(
    e as unknown as DragEvent,
    { tabId: 11, groupPanelId: null, count: 1, ...over },
    null,
  );
  return dt;
}

/** 模拟「另一个窗口发来的事件」。 */
function fromPeers(event: string, p: unknown): void {
  bus.listeners.get(event)?.({ payload: p });
}

function sentOf(event: string) {
  return bus.sent.filter((s) => s.event === event);
}

// ------------------------------------------------------------ 1. 载荷编解码

describe("拖拽载荷：编解码与校验", () => {
  it("往返一致", () => {
    const p = payload({ groupPanelId: 3, count: 4 });
    expect(decodeTabDrag(encodeTabDrag(p))).toEqual(p);
  });

  it("半个载荷 / 类型不对 / 版本不认识 → 一律 null（宁可什么都不做）", () => {
    expect(decodeTabDrag(undefined)).toBeNull();
    expect(decodeTabDrag("")).toBeNull();
    expect(decodeTabDrag("{ not json")).toBeNull();
    expect(decodeTabDrag("42")).toBeNull();
    expect(decodeTabDrag("null")).toBeNull();
    expect(decodeTabDrag(JSON.stringify({ ...payload(), v: 2 })), "版本不认识").toBeNull();
    expect(decodeTabDrag(JSON.stringify({ ...payload(), from: "" })), "发起窗口不明").toBeNull();
    expect(decodeTabDrag(JSON.stringify({ ...payload(), dragId: "" })), "没有认领编号").toBeNull();
    expect(decodeTabDrag(JSON.stringify({ ...payload(), tabId: 1.5 })), "tabId 非整数").toBeNull();
    expect(
      decodeTabDrag(JSON.stringify({ ...payload(), groupPanelId: "1" })),
      "groupPanelId 类型不对",
    ).toBeNull();
  });

  it("可选字段缺省补齐：count → 1、groupPanelId → null", () => {
    const raw = JSON.stringify({ v: 1, from: "main", tabId: 3, dragId: "x" });
    expect(decodeTabDrag(raw)).toEqual({
      v: 1,
      from: "main",
      tabId: 3,
      groupPanelId: null,
      count: 1,
      dragId: "x",
    });
  });

  it("只认自己的 MIME：文件拖入（Files）不算标签拖拽", () => {
    expect(isTabDragData(makeDataTransfer([TAB_MIME]))).toBe(true);
    expect(isTabDragData(makeDataTransfer(["Files"])), "文件拖入走 filedrop 那条路").toBe(false);
    expect(isTabDragData(makeDataTransfer(["text/plain"]))).toBe(false);
    expect(isTabDragData(null)).toBe(false);
    expect(isTabDragData(undefined)).toBe(false);
  });

  it("types 说是标签拖拽但 data 读不出来 → null，且不把异常抛出去", () => {
    const dt = makeDataTransfer([TAB_MIME]);
    dt.throwsOnGet = true;
    expect(() => readTabDragPayload(dt)).not.toThrow();
    expect(readTabDragPayload(dt)).toBeNull();
  });
});

// ------------------------------------------------------------ 2. 源侧

describe("源侧：dragstart 写载荷 + 把影像交给系统", () => {
  it("写私有 MIME、effectAllowed 允许移动/复制，且**不放可读正文**", async () => {
    uninstall = await installTabDnd(makeConfig().cfg);
    const dt = beginDrag({ count: 2 });
    const p = readTabDragPayload(dt)!;
    expect(p.from, "载荷里带上发起窗口").toBe("main");
    expect(p.dragId, "每次拖拽都有唯一编号").not.toBe("");
    expect(dt.effectAllowed, "Ctrl 拖拽 = 复制，所以两种都要允许").toBe("copyMove");
    // ⚠️ 用户报的 bug：拖标签会把文件名插进落点文档的正文。根因就是这里曾经写了
    //    `text/plain` —— 落点的 contenteditable 编辑器看到可读文本，就当成「有人拖了
    //    一段文本进来」插进正文（窗口内我们自己的 drop 拦得住，跨窗口时自定义 MIME
    //    可能没跨过进程边界、载荷读不出来，就完全拦不住）。标签拖拽是**内部协议**，
    //    对外不留任何可读正文。
    expect(dt.getData("text/plain"), "标签拖拽不对提供正文").toBe("");
    expect(dt.types, "对外只暴露私有 MIME").toEqual([TAB_MIME]);
  });

  it("影像：挂进 body 拍快照、**推一帧再摘**（同步摘会让系统拍不到图）", async () => {
    uninstall = await installTabDnd(makeConfig().cfg);
    const image = document.createElement("div");
    image.className = "tab-drag-ghost";
    const dt = makeDataTransfer();
    const e = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: dt, configurable: true });
    startTabDrag(e as unknown as DragEvent, { tabId: 11, groupPanelId: null, count: 1 }, image, {
      x: 10,
      y: 10,
    });
    expect(dt.images.length, "必须交给 setDragImage").toBe(1);
    expect(dt.images[0].el).toBe(image);
    expect(dt.images[0], "锚点要连影像一起传（整组药丸 = 指针落在内部）").toMatchObject({
      x: 10,
      y: 10,
    });
    // ⚠️ 拍快照当刻必须是「已挂进文档 + 离屏可见」：detached 或用 display:none 隐藏，
    // Chromium 会拍出一张空图 —— 用户看到的就是「拖着个看不见的东西」。
    expect(dt.images[0].inDom, "拍快照那一刻必须在文档里").toBe(true);
    expect(dt.images[0].offscreen, "而且是离屏摆着（可见但不在屏内）").toBe(true);
    // ⚠️ 摘除**必须推到下一轮宏任务**（用户报的另一个 bug：拖标签完全没有影像）。
    //    Chromium 是在 `dragstart` 派发**返回之后**才去读元素、给它拍快照的；这里同步
    //    `remove()` 会让快照时元素已 detached → 系统拿不到图 → 全程无跟手影像。
    expect(document.body.contains(image), "快照当刻绝不能提前摘").toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.body.contains(image), "快照拍完就摘，不留浮层").toBe(false);
  });

  it("没有影像也照常起拖（不抛错）", async () => {
    uninstall = await installTabDnd(makeConfig().cfg);
    const dt = makeDataTransfer();
    const e = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: dt, configurable: true });
    expect(() =>
      startTabDrag(e as unknown as DragEvent, { tabId: 11, groupPanelId: null, count: 1 }, null),
    ).not.toThrow();
    expect(readTabDragPayload(dt)).not.toBeNull();
  });

  it("拖拽期间 body 打上标记，dragend 收掉", async () => {
    uninstall = await installTabDnd(makeConfig().cfg);
    const dt = beginDrag();
    expect(document.body.classList.contains("tab-drag-active")).toBe(true);
    fireDrag("dragend", document, dt, { screenX: 100, screenY: 100 });
    expect(document.body.classList.contains("tab-drag-active")).toBe(false);
  });

  it("宿主没有装接收侧时不起拖（preventDefault，免得只有一个空 dataTransfer）", () => {
    const dt = makeDataTransfer();
    const e = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: dt, configurable: true });
    const id = startTabDrag(
      e as unknown as DragEvent,
      { tabId: 11, groupPanelId: null, count: 1 },
      null,
    );
    expect(id).toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });
});

// ------------------------------------------------------------ 3. 目标侧

describe("目标侧：dragover / drop", () => {
  it("认自己的 MIME：preventDefault + dropEffect 跟着 Ctrl 走", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    const e = fireDrag("dragover", document, dt, { clientX: 10, clientY: 20, timeStamp: 1000 });
    expect(e.defaultPrevented, "不拦就没有 drop").toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(calls.preview).toHaveBeenCalledWith(10, 20, false);
    const ec = fireDrag("dragover", document, dt, { clientX: 11, clientY: 21, ctrlKey: true });
    expect(ec.defaultPrevented).toBe(true);
    expect(dt.dropEffect, "Ctrl = 复制").toBe("copy");
  });

  it("不碰文件拖入（那些事件归 filedrop.ts）", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = makeDataTransfer(["Files"]);
    const e = fireDrag("dragover", document, dt, { clientX: 10, clientY: 20 });
    expect(e.defaultPrevented, "不许替文件拖入做决定").toBe(false);
    expect(calls.preview).not.toHaveBeenCalled();
    fireDrag("drop", document, dt, { clientX: 10, clientY: 20 });
    expect(calls.commitLocal).not.toHaveBeenCalled();
  });

  it("dragover 节流：40ms 内的连续移动只重画一次落点", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    fireDrag("dragover", document, dt, { timeStamp: 1000 });
    fireDrag("dragover", document, dt, { timeStamp: 1020 });
    fireDrag("dragover", document, dt, { timeStamp: 1039 });
    expect(calls.preview).toHaveBeenCalledTimes(1);
    fireDrag("dragover", document, dt, { timeStamp: 1040 });
    expect(calls.preview, "过了节流窗口就重画").toHaveBeenCalledTimes(2);
  });

  it("松手在本窗口 → commitLocal，且**不**去问别的窗口", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    fireDrag("dragover", document, dt, { clientX: 600, clientY: 150 });
    fireDrag("drop", document, dt, { clientX: 600, clientY: 150, altKey: true, ctrlKey: true });
    expect(calls.commitLocal).toHaveBeenCalledTimes(1);
    expect(calls.commitLocal.mock.calls[0][0], "松手坐标 + 修饰键原样交给宿主").toMatchObject({
      x: 600,
      y: 150,
      altKey: true,
      ctrlKey: true,
    });
    expect(sentOf(EVT_TAB_CLAIM), "自己拖的自己消化，不该外发").toHaveLength(0);
  });

  it("drop 时按松手坐标重算一次落点，然后收掉痕迹", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    fireDrag("dragover", document, dt, { clientX: 1, clientY: 1 });
    calls.preview.mockClear();
    fireDrag("drop", document, dt, { clientX: 700, clientY: 160 });
    expect(calls.preview, "drop 要按松手位置再算一次（dragover 可能差一帧）").toHaveBeenCalledWith(
      700,
      160,
      false,
    );
    expect(calls.clear).toHaveBeenCalled();
  });

  it("别的窗口拖来的 → 定向认领，且**不**在本地提交", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = makeDataTransfer();
    dt.setData(TAB_MIME, encodeTabDrag(payload({ from: "x1", dragId: "peer-1" })));
    fireDrag("drop", document, dt, { clientX: 300, clientY: 120 });
    expect(calls.commitLocal, "不是自己的拖拽").not.toHaveBeenCalled();
    const claims = sentOf(EVT_TAB_CLAIM);
    expect(claims).toHaveLength(1);
    expect(claims[0].target, "认领要发回发起窗口").toBe("x1");
    expect(claims[0].payload).toMatchObject({ from: "main", dragId: "peer-1" });
  });

  it("载荷读不出来（自定义 MIME 没跨过进程边界）→ 拦掉默认动作 + 记一笔告警，不抛错", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = makeDataTransfer([TAB_MIME]);
    dt.throwsOnGet = true;
    let e!: MouseEvent;
    expect(() => {
      e = fireDrag("drop", document, dt);
    }).not.toThrow();
    // ⚠️ 用户报的 bug：拖标签会把文件名插进落点文档的正文。读不出载荷也必须
    //    preventDefault —— 放行默认动作 = 浏览器自己往编辑器里插东西。
    expect(e.defaultPrevented, "读不出载荷也要拦默认动作").toBe(true);
    expect(calls.onWarn).toHaveBeenCalledWith("tab drag payload unreadable");
    expect(calls.commitLocal).not.toHaveBeenCalled();
  });

  it("标签拖拽的事件绝不漏进页面内组件（捕获阶段就拦下）", async () => {
    // ⚠️ 用户报的 bug 的另一半根因：监听曾挂在**冒泡**阶段，页面内的编辑器
    //    （contenteditable）会比我们先收到 dragover/drop，于是按「有人拖了一段文本
    //    进来」处理、把内容插进正文。捕获阶段挂在 document 上比任何组件都早。
    const { cfg } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const editor = document.createElement("div");
    document.body.appendChild(editor);
    const heard: string[] = [];
    for (const type of ["dragover", "drop", "dragend"]) {
      editor.addEventListener(type, () => heard.push(type));
    }
    const dt = beginDrag();
    fireDrag("dragover", editor, dt, { clientX: 10, clientY: 10 });
    fireDrag("drop", editor, dt, { clientX: 10, clientY: 10 });
    fireDrag("dragend", editor, dt, { screenX: 1, screenY: 1 });
    expect(heard, "编辑器一个都不该听到").toEqual([]);
  });

  it("但文件拖入照旧漏给页面内组件（那是 filedrop.ts 的地盘，不许误伤）", async () => {
    const { cfg } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const editor = document.createElement("div");
    document.body.appendChild(editor);
    const heard: string[] = [];
    editor.addEventListener("dragover", () => heard.push("dragover"));
    fireDrag("dragover", editor, makeDataTransfer(["Files"]), { clientX: 10, clientY: 10 });
    expect(heard, "文件拖入必须原样放行").toEqual(["dragover"]);
  });
});

// ------------------------------------------------------------ 4. 回落判据

describe("回落判据：什么时候才该开新窗口 / 交回主窗口", () => {
  it("窗口内落点就地收尾：**不等 dragend** 也要摘掉拖拽态类", async () => {
    // ⚠️ 落点常常重建面板 DOM（分屏 / 并入），源标签元素随之脱离文档 —— 而 dragend 是
    //    派发到**源元素**上的，元素脱离文档就不再冒泡到 document，我们的监听收不到。
    //    等它就等于让 `body.tab-drag-active`（全局禁文本选区）一直挂着。
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    fireDrag("drop", document, dt, { clientX: 600, clientY: 150 });
    expect(document.body.classList.contains("tab-drag-active")).toBe(false);
    // 此后迟到的 dragend 不该再触发回落（这次拖拽已经在本窗口了结了）
    fireDrag("dragend", document, dt, { screenX: 900, screenY: 500 });
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    expect(calls.onFallback).not.toHaveBeenCalled();
  });

  it("窗口内松手 → 绝不回落（哪怕落点没人要）", async () => {
    const { cfg, calls } = makeConfig({ commitLocal: vi.fn(() => false) });
    uninstall = await installTabDnd(cfg);
    vi.useFakeTimers();
    const dt = beginDrag();
    fireDrag("drop", document, dt, { clientX: 600, clientY: 150 });
    fireDrag("dragend", document, dt, { screenX: 900, screenY: 500 });
    vi.advanceTimersByTime(1000);
    expect(calls.onFallback, "窗口内松手还弹新窗口是最糟的失败模式").not.toHaveBeenCalled();
  });

  it("扔在桌面上（没人认领）→ 回落，带 dragend 的屏幕坐标", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    vi.useFakeTimers();
    const dt = beginDrag();
    fireDrag("dragend", document, dt, { screenX: 880, screenY: 460 });
    expect(calls.onFallback, "宽限期内先别急").not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(calls.onFallback).toHaveBeenCalledTimes(1);
    expect(calls.onFallback.mock.calls[0].slice(1)).toEqual([880, 460]);
  });

  it("别的窗口接手了 → 不回落（认领会晚于 dragend 到，所以要留宽限）", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    vi.useFakeTimers();
    const dt = beginDrag();
    const mine = readTabDragPayload(dt)!;
    fireDrag("dragend", document, dt, { screenX: 880, screenY: 460 });
    // 认领在 dragend 之后才到 —— 正是顺序上的这个先后，逼出了那段宽限
    fromPeers(EVT_TAB_CLAIM, { from: "x1", dragId: mine.dragId });
    vi.advanceTimersByTime(400);
    expect(calls.onFallback).not.toHaveBeenCalled();
  });

  it("过期认领不算数：dragId 对不上就仍按「扔桌面」回落", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    vi.useFakeTimers();
    const dt = beginDrag();
    fireDrag("dragend", document, dt, { screenX: 880, screenY: 460 });
    fromPeers(EVT_TAB_CLAIM, { from: "x1", dragId: "another-drag" });
    vi.advanceTimersByTime(400);
    expect(calls.onFallback).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------ 5. 跨窗口交接

describe("跨窗口交接：认领 → 定向投递正文 → 落地", () => {
  it("有人来认领 → 交快照（只发给它一个）+ 本地收尾", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag({ groupPanelId: 4, count: 3 });
    const mine = readTabDragPayload(dt)!;
    fromPeers(EVT_TAB_CLAIM, { from: "x1", dragId: mine.dragId });
    expect(calls.snapshot).toHaveBeenCalledTimes(1);
    expect(calls.snapshot.mock.calls[0][0]).toMatchObject({ groupPanelId: 4 });
    const sends = sentOf(EVT_TAB_PAYLOAD);
    expect(sends, "正文只发给认领者一个窗口（emitTo 不是广播）").toHaveLength(1);
    expect(sends[0].target).toBe("x1");
    expect(calls.relinquish, "交出去之后本地要收干净").toHaveBeenCalledWith(
      expect.objectContaining({ dragId: mine.dragId }),
      "x1",
    );
  });

  it("自己发的事件要忽略（emit 会把事件也送回发起窗口）", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    const mine = readTabDragPayload(dt)!;
    fromPeers(EVT_TAB_CLAIM, { from: "main", dragId: mine.dragId });
    expect(calls.snapshot).not.toHaveBeenCalled();
  });

  it("快照取不出（标签已不在）→ 不发正文（对方落点自然落空，不制造半个标签）", async () => {
    const { cfg, calls } = makeConfig({ snapshot: vi.fn(() => null) });
    uninstall = await installTabDnd(cfg);
    const dt = beginDrag();
    const mine = readTabDragPayload(dt)!;
    fromPeers(EVT_TAB_CLAIM, { from: "x1", dragId: mine.dragId });
    expect(sentOf(EVT_TAB_PAYLOAD)).toHaveLength(0);
    expect(calls.relinquish, "没交出去就不能收尾，否则标签凭空消失").not.toHaveBeenCalled();
  });

  it("收到正文 → 按**当时算好的落点**落地", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    calls.preview.mockReturnValue({ panelId: 2, zone: "right", beforeTabId: null });
    const dt = makeDataTransfer();
    dt.setData(TAB_MIME, encodeTabDrag(payload({ from: "x1", dragId: "peer-9" })));
    fireDrag("dragover", document, dt, { clientX: 700, clientY: 160 });
    fireDrag("drop", document, dt, { clientX: 700, clientY: 160 });
    fromPeers(EVT_TAB_PAYLOAD, { from: "x1", dragId: "peer-9", tabs: [{ docId: 7 }] });
    expect(calls.adopt).toHaveBeenCalledTimes(1);
    expect(calls.adopt.mock.calls[0][1], "落点必须与拖拽期间看到的预览一致").toEqual({
      panelId: 2,
      zone: "right",
      beforeTabId: null,
    });
  });

  it("正文的 dragId 与本地待收的对不上 → 丢弃（防止上一次拖拽的正文串台）", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    const dt = makeDataTransfer();
    dt.setData(TAB_MIME, encodeTabDrag(payload({ from: "x1", dragId: "peer-9" })));
    fireDrag("drop", document, dt, { clientX: 700, clientY: 160 });
    fromPeers(EVT_TAB_PAYLOAD, { from: "x1", dragId: "peer-8", tabs: [{ docId: 7 }] });
    expect(calls.adopt).not.toHaveBeenCalled();
  });

  it("没人认领过的窗口收到正文 → 忽略", async () => {
    const { cfg, calls } = makeConfig();
    uninstall = await installTabDnd(cfg);
    fromPeers(EVT_TAB_PAYLOAD, { from: "x1", dragId: "peer-9", tabs: [] });
    expect(calls.adopt).not.toHaveBeenCalled();
  });
});

describe("标签拖拽静态契约（从 regressions 拆出）", () => {
  it("标签拖拽必须走 HTML5 DnD：影像才能跟出窗口（B91-2）", () => {
    // 历史链：`dragDropEnabled: true` 时 wry 会 `SetAllowExternalDrop(false)` 并覆盖
    // 子窗口的 drop target，把页面内 HTML5 拖放一起废掉 —— 于是标签拖拽只能退化成指针
    // 编排，代价是影像是本窗口的一个 DOM 浮层：**指针一移出窗口就看不见了**（用户报的
    // 诉求）。B91 关掉那个开关（文件拖入改走路径桥），B91-2 顺势把标签拖拽换回
    // HTML5 DnD —— 影像交给系统绘制，跟出窗口、压在别的应用上都在。
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts.includes("draggable = true"), "标签必须可拖（HTML5 DnD 的入口）").toBe(true);
    expect(ts.includes('addEventListener("dragstart"'), "必须监听 dragstart").toBe(true);
    expect(ts.includes("startTabDrag("), "起拖必须走传输层（写载荷 + 交影像）").toBe(true);
    // 旧指针编排那套入口必须彻底消失，否则两套运输会互相打架
    expect(ts.includes("beginTabDrag"), "指针编排的入口不得残留").toBe(false);
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    expect(
      sv.includes("getCurrentWebview"),
      "splitview 不得处理文件拖放（归 main.ts 原生通道）",
    ).toBe(false);
    // B91-2 之前这里断言「面板不得挂 drop 处理器」；现在由 tabdnd 挂**一份**页面级的，
    // 面板自己仍然不挂 —— 判定落在几何命中（panelAt / stripUnder）上，与事件目标无关。
    expect(sv.includes('addEventListener("drop"'), "面板仍不得自己挂 drop 处理器").toBe(false);
    expect(sv.includes("export function commitTabDrop"), "落点提交必须留在 splitview").toBe(true);
  });
  it("B64 标签拖拽影像交给系统绘制，能跟出窗口（静态契约）", () => {
    // 用户反馈：「标签拖动时，要像 vscode 那样有一个 tab 随光标移动的效果。」
    // VS Code 出处：`multiEditorTabsControl.ts:1295` —— 拖单个标签且 tabSizing 非
    // shrink 时 `e.dataTransfer.setDragImage(tab, 0, 0)`（注释：把被拖标签的左上角
    // 放到光标处，好给落点边框反馈让位）。本项目标签是 tabSizing: fixed（B56 起
    // 不收缩、不裁剪），正落在那一档。
    //
    // ⚠️ B91-2 起改用 **HTML5 DnD**：影像由 `setDragImage` 交**系统**绘制，指针移出
    // 窗口、压到别的应用上照样跟着走。B64–B90 那套指针编排的 DOM 浮层做不到这一点
    // （指针越过窗口边界就看不见了），那整套实现已删除。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const dnd = readFileSync("src/shell/tabdnd.ts", "utf-8");
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const tsCode = stripComments(ts);
    const dndCode = stripComments(dnd);

    // ① 标签元素必须可拖（`draggable = true`），起手写载荷 + 交影像 —— 只测 tabdnd 的
    //    setDragImage 会漏掉这层接线（没人调它照样「测试通过」）
    expect(tsCode, "标签元素可拖").toMatch(/el\.draggable = true;/);
    expect(tsCode, "起手写载荷并交出影像").toMatch(
      /startTabDrag\([\s\S]{0,200}?createTabDragImage\(el\),\s*\n\s*TAB_IMAGE_ANCHOR,/,
    );
    // 影像里的 × 是按钮：从它上面起拖会让用户「点关闭却拖走了标签」，显式挡掉
    expect(tsCode, "挡掉从关闭按钮起拖").toMatch(
      /closest\("\.tab-close"\)[\s\S]{0,140}?preventDefault\(\)/,
    );

    // ② 影像是原标签的**克隆**（原地不动的原标签才是参照物），且副本去掉 tabId
    //    （否则「按 tabId 查元素」会命中副本而非真标签）
    const imageFn = tsCode.match(/function createTabDragImage[\s\S]*?\n\}/)?.[0] ?? "";
    expect(imageFn, "影像工厂必须存在").not.toBe("");
    expect(imageFn, "影像是原标签的克隆").toMatch(/cloneNode\(true\) as HTMLElement/);
    expect(imageFn, "副本去掉 tabId").toMatch(/removeAttribute\("data-tab-id"\)/);

    // ③ 影像是「离屏挂进 body → 交快照 → **推一帧再摘**」：detached 元素在部分 Chromium
    //    版本上会拍成空图，所以必须先渲染；而 Chromium 是在 `dragstart` 派发**返回之后**
    //    才读元素拍快照的，**同步 `remove()` 会让快照时元素已 detached → 系统拿不到图**
    //    （用户报过「拖标签完全没有影像」）。所以摘除必须推到下一轮宏任务
    //    （对齐 VS Code `applyDragImage` 的 `setTimeout(() => dragImage.remove(), 0)`）。
    expect(dndCode, "影像离屏挂进 body").toMatch(/document\.body\.appendChild\(image\)/);
    expect(dndCode, "交给系统绘制（带锚点）").toMatch(
      /dt\.setDragImage\(image, anchor\.x, anchor\.y\)/,
    );
    expect(dndCode, "摘除必须推到下一轮宏任务，绝不能同步摘").toMatch(
      /setDragImage\(image, anchor\.x, anchor\.y\);[\s\S]{0,40}?setTimeout\(\(\) => image\.remove\(\), 0\)/,
    );

    // ③′ **不放 `text/plain`**：dataTransfer 里只要有一份可读文本，落点的 contenteditable
    //    编辑器就会把它当「拖进来的一段文本」插进正文（用户报过「拖标签会把文件名插进
    //    别的文档」）。标签拖拽是内部协议，只写私有 MIME。
    expect(dndCode, "不对外提供可读正文").not.toMatch(/setData\(\s*["']text\/plain["']/);
    expect(dndCode, "只写私有 MIME").toMatch(/dt\.setData\(TAB_MIME,/);

    // ③″ 监听一律挂**捕获阶段**：冒泡阶段的话，页面内组件（编辑器）会先收到事件并
    //     插入文本 —— 捕获阶段挂在 document 上比任何组件都早，拦得住。
    expect(dndCode, "事件监听挂捕获阶段").toMatch(/addEventListener\("drop", onDrop, CAPTURE\)/);
    expect(dndCode, "捕获阶段就 stopPropagation").toMatch(
      /e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\)/,
    );

    // ④ 拖拽期间挂 body 类（禁文本选区）；收尾会摘掉（拖拽循环结束 / drop 就地收尾）
    expect(dndCode, "拖拽期间挂类").toMatch(/document\.body\.classList\.add\(TAB_DRAG_CLASS\)/);
    expect(dndCode, "收尾摘类").toMatch(/document\.body\.classList\.remove\(TAB_DRAG_CLASS\)/);

    // ⑤ 样式：快照源要**离屏但可渲染**（fixed + left/top 挪出屏），绝不能用
    //    display:none / visibility:hidden —— 不渲染就拍出一张空图。
    const imageRule = css.match(/\.tab-drag-image\s*\{[^}]*\}/)?.[0] ?? "";
    expect(imageRule, "快照容器规则必须存在").not.toBe("");
    expect(imageRule, "离屏摆放（fixed + 挪出屏）").toMatch(
      /position:\s*fixed[\s\S]*?left:\s*-10000px/,
    );
    expect(imageRule, "拍快照的容器绝不能隐藏（否则拍出空图）").not.toMatch(
      /display:\s*none|visibility:\s*hidden/,
    );
    // 不再是指针编排的常驻浮层：`pointer-events` / `z-index: 1000` 那套随之退场
    const ghostRule = css.match(/\.tab-drag-ghost\s*\{[^}]*\}/)?.[0] ?? "";
    expect(ghostRule, "影像不再是常驻浮层（交系统后无需拦截指针）").not.toMatch(
      /pointer-events:\s*none/,
    );
  });
  it("B72 整组拖拽影像 = VS Code 的聚合药丸，不再是裁剪的标签栏副本（静态契约）", () => {
    // 用户反馈：「面板整体拖拽时，随鼠标拖动的图案优化下，尤其是面板包含多个标签时，
    // 可以参考 vscode。」旧实现（B71）把整个 `.panel-tabstrip` 克隆成影像 + CSS
    // `max-width: 260px; overflow: hidden` 硬裁 → 最后一个标签被切掉半个，像坏了。
    // VS Code 出处：`editorTabsControl.ts:487-494` 拖整组时取活动标签名拼其余数量
    // （`localize('draggedEditorGroup', "{0} (+{1})")`），再交给 `applyDragImage`
    // 渲染成 `.monaco-drag-image`（`base/browser/ui/dnd/dnd.css`：12px、圆角 10px、
    // 单行、max-width + 省略号）。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const svCode = stripComments(sv);
    const tsCode = stripComments(ts);
    const pill = css.match(/\.tab-drag-ghost-group\s*\{([^}]*)\}/)?.[1] ?? "";
    const nameRule =
      css.match(/\.tab-drag-ghost-group \.tab-drag-ghost-name\s*\{([^}]*)\}/)?.[1] ?? "";
    const countRule =
      css.match(/\.tab-drag-ghost-group \.tab-drag-ghost-count\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(pill, "药丸规则必须存在").not.toBe("");
    expect(nameRule, "名字 span 规则必须存在").not.toBe("");
    expect(countRule, "计数 span 规则必须存在").not.toBe("");

    // ① 药丸本体：单行 + 圆角 + 收宽度（旧实现的整条带子硬裁已删除）
    expect(pill, "单行").toMatch(/white-space:\s*nowrap/);
    expect(pill, "圆角药丸").toMatch(/border-radius:\s*10px/);
    expect(pill, "12px（对齐 .monaco-drag-image）").toMatch(/font-size:\s*12px/);
    expect(pill, "宽度收住").toMatch(/max-width:\s*220px/);
    // ② 名字可截断：flex 子项要真截断，必须同时有 overflow:hidden 与 min-width:0
    //    （少了 min-width 就根本不会收缩，省略号静默不出现）
    expect(nameRule, "名字要能截断").toMatch(/overflow:\s*hidden/);
    expect(nameRule, "名字打省略号").toMatch(/text-overflow:\s*ellipsis/);
    expect(nameRule, "flex 子项必须 min-width: 0").toMatch(/min-width:\s*0/);
    // ③ 计数不可截断 —— 这正是有意偏离 VS Code 的那一处
    expect(countRule, "计数不得被压缩").toMatch(/flex:\s*0 0 auto/);

    // ④ 文案 = 活动标签名 (+其余数量)；计数只在多标签时出现
    //    （B91-2 起药丸工厂从 splitview 搬到 tabstrip，与标签副本影像同处一模块）
    expect(tsCode, "整组文案取活动标签名").toMatch(
      /querySelector<HTMLElement>\("\.tab\.tab-active"\)/,
    );
    expect(tsCode, "文案形态 name (+N)").toMatch(/\(\+\$\{tabs\.length - 1\}\)/);
    expect(tsCode, "计数判据 tabs.length > 1").toMatch(/if \(tabs\.length > 1\)/);
    expect(tsCode, "名字读不出来时不出现空药丸").toMatch(/`\$\{tabs\.length\} 个标签`/);
    // ⑤ 药丸是**纯文字**：不能再往里塞标签 DOM 副本（那正是旧实现的病根）；
    //    名字与计数必须是**两个** span（合成一个字符串的话 max-width 会把计数一起吃掉）
    const pillFn = tsCode.match(/function createGroupDragImage[\s\S]*?\n\}/)?.[0] ?? "";
    expect(pillFn, "药丸工厂必须存在").not.toBe("");
    expect(pillFn, "不得克隆标签栏").not.toMatch(/cloneNode/);
    expect(pillFn, "名字 span").toMatch(/className = "tab-drag-ghost-name"/);
    expect(pillFn, "计数 span").toMatch(/className = "tab-drag-ghost-count"/);

    // ⑤ 锚点分档：药丸 = setDragImage(pill, 10, 10)（指针落在药丸内部，「捏着它」），
    //    单标签 = setDragImage(tab, 0, 0)（左上角顶到指针）
    expect(tsCode, "药丸锚点 10,10").toMatch(
      /GROUP_IMAGE_ANCHOR: DragImageAnchor = \{ x: 10, y: 10 \}/,
    );
    expect(tsCode, "单标签锚点 0,0").toMatch(
      /TAB_IMAGE_ANCHOR: DragImageAnchor = \{ x: 0, y: 0 \}/,
    );
    // ⚠️ 「定义了常量却没人用」是最常见的漏网形态：起手处必须真把药丸影像与药丸锚点
    //    交给 startTabDrag（单标签侧由 tabstrip 自己交，见 B64）。
    expect(svCode, "整组起手交药丸影像 + 药丸锚点").toMatch(
      /createGroupDragImage\(strip\),\s*\n\s*GROUP_IMAGE_ANCHOR,/,
    );
  });
});
