// jsdom 的 `DataTransfer` / `DragEvent` 至今**未实现**（构造直接抛错），而 B91-2 起
// 标签拖拽整段跑的就是 HTML5 DnD。这里造一对最小的替身：只实现被测代码真正用到的那几件
// 事（types / setData / getData / setDragImage / effectAllowed / dropEffect），
// 事件则用 `MouseEvent` 打底再挂上 `dataTransfer`，这样 clientX/clientY、
// altKey/ctrlKey、screenX/screenY 全都是 jsdom 原生支持的字段。

/** 一次 `setDragImage` 调用。`inDom` / `offscreen` 记录的是**调用那一刻**的状态。 */
export interface DragImageCall {
  el: Element;
  x: number;
  y: number;
  /** 那一刻元素在不在文档里。不在 = detached，部分 Chromium 版本会拍出一张空图。 */
  inDom: boolean;
  /** 那一刻带没带离屏类。用 display:none / visibility:hidden 同样会拍出空图。 */
  offscreen: boolean;
}

/** 造一个 DataTransfer 替身。`types` 初值用来模拟「别的应用拖进来的东西」（如 `["Files"]`）。 */
export interface FakeDataTransfer {
  types: string[];
  effectAllowed: string;
  dropEffect: string;
  setData(mime: string, data: string): void;
  getData(mime: string): string;
  setDragImage(el: Element, x: number, y: number): void;
  /** `setDragImage` 的调用记录 ——「影像交给系统」这条契约靠它验。 */
  images: DragImageCall[];
  /** 打开后 `getData` 一律抛错，用来验「载荷读不出来时不许抛到调用方」。 */
  throwsOnGet: boolean;
}

export function makeDataTransfer(initialTypes: string[] = []): FakeDataTransfer {
  const store = new Map<string, string>();
  const dt: FakeDataTransfer = {
    types: [...initialTypes],
    effectAllowed: "none",
    dropEffect: "none",
    images: [],
    throwsOnGet: false,
    setData(mime, data) {
      if (!dt.types.includes(mime)) dt.types.push(mime);
      store.set(mime, data);
    },
    getData(mime) {
      if (dt.throwsOnGet) throw new Error("dataTransfer denied");
      return store.get(mime) ?? "";
    },
    setDragImage(el, x, y) {
      // ⚠️ 这两个状态必须在**调用当刻**取：影像元素是「挂上去 → 拍快照 → 摘掉」，
      // 事后查只能看到一个已摘掉的元素，分辨不出它到底是挂着拍的还是 detached 拍的。
      dt.images.push({
        el,
        x,
        y,
        inDom: document.body.contains(el),
        offscreen: el.classList.contains("tab-drag-image"),
      });
    },
  };
  return dt;
}

export interface DragInit {
  clientX?: number;
  clientY?: number;
  screenX?: number;
  screenY?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  /** 覆盖 `timeStamp`：节流逻辑按它算间隔，必须可控（jsdom 自己给的是构造时刻）。 */
  timeStamp?: number;
}

/**
 * 派发一个拖拽事件。返回事件本身，便于断言 `defaultPrevented`
 * ——「dragover 必须 preventDefault」是整条链路能不能收到 drop 的前提。
 */
export function fireDrag(
  type: string,
  target: EventTarget,
  dt: FakeDataTransfer | null,
  init: DragInit = {},
): MouseEvent {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    screenX: init.screenX ?? 0,
    screenY: init.screenY ?? 0,
    altKey: !!init.altKey,
    ctrlKey: !!init.ctrlKey,
  });
  Object.defineProperty(e, "dataTransfer", { value: dt, configurable: true });
  if (init.timeStamp !== undefined) {
    Object.defineProperty(e, "timeStamp", { value: init.timeStamp, configurable: true });
  }
  target.dispatchEvent(e);
  return e;
}
