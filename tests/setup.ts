// 共享 jsdom 环境桩（在 vite.config.ts 的 test.setupFiles 注册，对所有测试文件生效）。
//
// 目的：把「jsdom 与真实 WebView2(Chromium) 的差距」集中收口到一处，
// 避免每个测试文件各抄一份贴片。此前 smoke.bootstrap / view-switch-noedit 各自
// 本地打了 Range 桩，而 toc-follows-panel 漏打 → 用例虽全过，jsdom 却在
// mousedown 处理里抛出未捕获异常，使 vitest 以非 0 退出、pre-push 钩子误拦推送。
// 新增测试文件不再需要自行打桩。

import { vi } from "vitest";

// no-isolate 下环境跨文件复用（见 vite.config.ts 的 test.isolate）：
// 每个文件开始前，把上一个文件留下的**全局副作用**清掉，让它看起来仍是一间新房。
// 只清环境级残留，模块状态由 vi.resetModules() 交还 —— 不然 resetModules 之后
// 旧模块的 window/document 监听还会抢在新模块前面处理事件。
type TrackedListener = {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
};
type ListenerTracker = { listeners: TrackedListener[] };
type PatchTarget = {
  addEventListener: typeof EventTarget.prototype.addEventListener;
  removeEventListener: typeof EventTarget.prototype.removeEventListener;
};
const PATCH_FLAG = "__litepadListenerPatch";
const trackerHost = globalThis as typeof globalThis & { __litepadListeners?: ListenerTracker };

/**
 * 监听器登记：把新增的监听记在全局账本上，供下一个文件开头统一摘除。
 * ⚠️ 必须同时补 `EventTarget.prototype` 与 `window`：jsdom 的 window 自带一份
 * 同名方法、不经原型，只补原型会漏掉挂在 window 上的全局监听（main.ts 的快捷键
 * 就在那里；漏掉后它会吃掉 CodeMirror 的 Mod-/ 用例）。
 */
function patchListeners(target: PatchTarget): void {
  const add = target.addEventListener;
  const remove = target.removeEventListener;
  if (typeof add !== "function" || (add as unknown as Record<string, unknown>)[PATCH_FLAG]) return;
  const wrappedAdd = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener) {
      const capture = typeof options === "boolean" ? options : !!options?.capture;
      trackerHost.__litepadListeners?.listeners.push({ target: this, type, listener, capture });
    }
    add.call(this, type, listener, options);
  } as typeof target.addEventListener;
  (wrappedAdd as unknown as Record<string, unknown>)[PATCH_FLAG] = true;
  const wrappedRemove = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const list = trackerHost.__litepadListeners?.listeners;
    const i = list?.findIndex(
      (l) =>
        l.target === this && l.type === type && l.listener === listener && l.capture === capture,
    );
    if (list && i !== undefined && i >= 0) list.splice(i, 1);
    remove.call(this, type, listener, options);
  } as typeof target.removeEventListener;
  (wrappedRemove as unknown as Record<string, unknown>)[PATCH_FLAG] = true;
  target.addEventListener = wrappedAdd;
  target.removeEventListener = wrappedRemove;
}

// 1) 摘下上个文件的监听：旧的 window/document 监听器持有已废弃的模块状态，
//    却仍能先截事件（实测 Ctrl+Shift+O、dragover 都被上一份 main.ts 吃掉）。
const previous = trackerHost.__litepadListeners;
if (previous) {
  const stale = previous.listeners.splice(0);
  for (const { target, type, listener, capture } of stale) {
    try {
      target.removeEventListener(type, listener, capture);
    } catch {
      /* 目标元素已随上个文件的 DOM 一起销毁 */
    }
  }
}
if (!trackerHost.__litepadListeners) trackerHost.__litepadListeners = { listeners: [] };
patchListeners(EventTarget.prototype);
if (typeof window !== "undefined") patchListeners(window as unknown as PatchTarget);

// 2) 换房：全局桩、模块注册表、DOM、存储、假定时器、视口尺寸都回到初始值。
//    模块 mock 不需要手动清：vitest 在每个文件结束时 restoreAllMocks，且 mocker
//    的注册按请求它的文件生效（实测换个文件不会继承上一个文件的 vi.mock）。
vi.unstubAllGlobals();
vi.resetModules();
vi.useRealTimers();

// 3) 原型上的量测桩也要还原：有些文件直接给 Element.prototype.getBoundingClientRect
//    赋值（没有 vi.spyOn 可 restore），漏掉后下一个文件里所有元素都「有尺寸」，
//    布局/联动用例会莫名其妙地绿或红。按首次快照的描述符还原（原本没有自有属性就删掉）。
type ProtoProp = [object, string];
type ProtoSnapshot = Map<string, PropertyDescriptor | undefined>;
function protoProps(): ProtoProp[] {
  const props: ProtoProp[] = [];
  const add = (obj: object | undefined, prop: string): void => {
    if (obj) props.push([obj, prop]);
  };
  if (typeof Element !== "undefined") {
    add(Element.prototype, "getBoundingClientRect");
    add(Element.prototype, "getClientRects");
    add(Element.prototype, "scrollIntoView");
  }
  if (typeof HTMLElement !== "undefined") {
    add(HTMLElement.prototype, "getBoundingClientRect");
    add(HTMLElement.prototype, "offsetWidth");
    add(HTMLElement.prototype, "offsetHeight");
    add(HTMLElement.prototype, "clientWidth");
    add(HTMLElement.prototype, "clientHeight");
  }
  if (typeof Range !== "undefined") {
    add(Range.prototype, "getClientRects");
    add(Range.prototype, "getBoundingClientRect");
  }
  return props;
}
// 按**原型对象**分别记账：环境在 node / jsdom 之间切换时 Vitest 会换一套新的
// Element/HTMLElement/Range，同一份全局快照只认得旧那套，新的一套就又没人管了。
const protoHost = globalThis as typeof globalThis & {
  __litepadProtoOriginals?: WeakMap<object, ProtoSnapshot>;
};
const protoOriginals = (protoHost.__litepadProtoOriginals ??= new WeakMap());
for (const [obj, prop] of protoProps()) {
  let saved = protoOriginals.get(obj);
  if (!saved) {
    saved = new Map();
    protoOriginals.set(obj, saved);
  }
  if (!saved.has(prop)) {
    saved.set(prop, Object.getOwnPropertyDescriptor(obj, prop));
    continue;
  }
  try {
    const desc = saved.get(prop);
    if (desc) Object.defineProperty(obj, prop, desc);
    else if (Object.prototype.hasOwnProperty.call(obj, prop)) {
      delete (obj as Record<string, unknown>)[prop];
    }
  } catch {
    /* 不可配置的属性：留给各文件自己的还原逻辑 */
  }
}
if (typeof window !== "undefined") {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
  window.innerWidth = 1024;
  window.innerHeight = 768;
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* 无 storage 的环境 */
  }
}

type RangeLikeProto = { getClientRects?: unknown; getBoundingClientRect?: unknown };

if (typeof window !== "undefined") {
  // 1) matchMedia：jsdom 未实现，主题/深浅色代码依赖
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
  }

  // 2) requestAnimationFrame / cancelAnimationFrame：**无条件覆盖**。
  //    jsdom 自带的实现走 16 ms 视觉时钟且在测试里不可靠，会让「等一帧」的用例
  //    逼近 5 s 默认超时（view-switch-noedit 曾因此稳定超时）。统一换成
  //    setTimeout(0)，与既有可稳定通过的配置一致。
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(
      () => cb(performance.now()),
      0,
    ) as unknown as number) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as typeof window.cancelAnimationFrame;

  // 3) Range.getClientRects / getBoundingClientRect：jsdom 未实现，
  //    而 CodeMirror 在 mousedown 处理里会调用 → 「getClientRects is not a function」。
  const rangeProto = window.Range?.prototype as unknown as RangeLikeProto | undefined;
  if (rangeProto && typeof rangeProto.getClientRects !== "function") {
    rangeProto.getClientRects = () => [] as unknown as DOMRectList;
    rangeProto.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
  }
}
