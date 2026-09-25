// @vitest-environment jsdom
// B53：标签栏溢出策略由「折叠进下拉列表」改为**原生横向滚动**（用户要求，VS Code 式）。
// 本文件取代原 tabstrip-overflow.test.ts —— 那批用例断言的是已整体删除的折叠机制
// （.tab-more 按钮、可见窗口区间、预算铺满…），保留它们只会锁死旧行为。
//
// 用法要点：jsdom 没有排版，所以这里把几何量做成语义化桩 ——
//   标签固定宽 100px、间距 2px、标签栏可视宽 VIEW_W；
//   scrollLeft 按真实浏览器语义**钳制**在 [0, scrollWidth-clientWidth]。
import { describe, it, expect, afterAll, beforeAll, afterEach, vi } from "vitest";
import { renderTabstrip, type TabViewData, type TabstripCallbacks } from "../src/shell/tabstrip";

/** B125：jsdom 没有 ResizeObserver，这里记下回调供用例手动触发（模拟面板宽度变化）。 */
const roCallbacks: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private cb: () => void) {
    roCallbacks.push(cb);
  }
  observe(): void {}
  disconnect(): void {}
}

const TAB_W = 100;
const GAP = 2;
/** 标签栏可视宽度（用例可改，模拟窗口/分屏缩放） */
let VIEW_W = 250;

const scrollStore = new WeakMap<HTMLElement, number>();
const contentWidth = (host: HTMLElement): number => {
  const n = host.querySelectorAll(".tab").length;
  return n === 0 ? 0 : n * TAB_W + (n - 1) * GAP;
};

let restore: (() => void) | null = null;

beforeAll(() => {
  const proto = HTMLElement.prototype;
  const def = (prop: string, desc: PropertyDescriptor): void =>
    Object.defineProperty(proto, prop, { configurable: true, ...desc });

  // B125：装在渲染之前，tabstrip 里 `typeof ResizeObserver !== "undefined"` 才成立
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

  // ⚠️ B125：轨道（.panel-tabstrip-scrollbar）也要有宽度，否则 syncOverlayScrollbar
  //    里 track=0 会让 thumb 恒为最小宽 24px —— 「跟随面板宽度变化」这条就验不出来。
  def("clientWidth", {
    get(this: HTMLElement) {
      return this.classList.contains("panel-tabstrip") ||
        this.classList.contains("panel-tabstrip-scrollbar")
        ? VIEW_W
        : 0;
    },
  });
  def("scrollWidth", {
    get(this: HTMLElement) {
      return contentWidth(this);
    },
  });
  // 标签位置由它在 strip 中的次序推出，**渲染期间**就可读
  // （ensureVisible 在 append 之后立刻调用，必须能拿到真实几何）
  def("offsetLeft", {
    get(this: HTMLElement) {
      const host = this.parentElement;
      if (!host || !this.classList.contains("tab")) return 0;
      return [...host.querySelectorAll(".tab")].indexOf(this) * (TAB_W + GAP);
    },
  });
  def("offsetWidth", {
    get(this: HTMLElement) {
      return this.classList.contains("tab") ? TAB_W : 0;
    },
  });
  def("scrollLeft", {
    get(this: HTMLElement) {
      return scrollStore.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      const max = Math.max(0, this.scrollWidth - this.clientWidth);
      scrollStore.set(this, Math.max(0, Math.min(max, v)));
    },
  });

  restore = () => {
    for (const p of ["clientWidth", "scrollWidth", "offsetLeft", "offsetWidth", "scrollLeft"]) {
      delete (proto as unknown as Record<string, unknown>)[p];
    }
    delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  };
});

afterAll(() => restore?.());
afterEach(() => {
  document.body.textContent = "";
  VIEW_W = 250;
  roCallbacks.length = 0;
});

function tabs(n: number, active = 0): TabViewData[] {
  return Array.from({ length: n }, (_, i) => ({
    tabId: i + 1,
    name: `tab${i + 1}`,
    dirty: false,
    readonly: false,
    active: i === active,
  }));
}

function cb(): TabstripCallbacks & { activated: number[] } {
  const activated: number[] = [];
  return { activated, onActivate: (id) => activated.push(id), onClose: () => {} };
}

function mount(n: number, active = 0) {
  const host = document.createElement("div");
  host.className = "panel-tabstrip";
  document.body.appendChild(host);
  const c = cb();
  renderTabstrip(host, tabs(n, active), c);
  return { host, c };
}

const namesInDom = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLElement>(".tab .tab-name")].map((e) => e.textContent ?? "");

function wheelOn(host: HTMLElement, delta: number, ctrl = false): WheelEvent {
  const e = new WheelEvent("wheel", {
    deltaY: delta,
    ctrlKey: ctrl,
    bubbles: true,
    cancelable: true,
  });
  host.dispatchEvent(e);
  return e;
}

describe("B53 标签栏不再折叠，改为横向滚动", () => {
  it("放不下时也不折叠：所有标签都留在 DOM 里，且没有折叠按钮", () => {
    const { host } = mount(6);
    // 6×100+5×2=610 > 250，旧实现这里只会留 2 个并把其余 4 个删掉
    expect(namesInDom(host), "标签一个都不能少，溢出靠滚动而不是移除").toEqual([
      "tab1",
      "tab2",
      "tab3",
      "tab4",
      "tab5",
      "tab6",
    ]);
    expect(host.querySelector(".tab-more"), "折叠按钮已删除").toBeNull();
    expect(host.dataset.start, "可见窗口区间这个概念已不存在").toBeUndefined();
  });

  it("滚轮横向滚动，并吞掉事件（不传给页面）", () => {
    const { host } = mount(6);
    expect(host.scrollLeft).toBe(0);
    // max = 610 - 250 = 360
    const e1 = wheelOn(host, 100);
    expect(host.scrollLeft, "滚轮应横向滚动").toBe(100);
    expect(e1.defaultPrevented, "滚轮应被标签栏自己消化").toBe(true);

    const e2 = wheelOn(host, -40);
    expect(host.scrollLeft).toBe(60);
    expect(e2.defaultPrevented).toBe(true);
  });

  it("没有溢出时不处理也不拦截（让页面正常滚动）", () => {
    const { host } = mount(2); // 2×100+2=202 ≤ 250
    const e = wheelOn(host, 100);
    expect(host.scrollLeft).toBe(0);
    expect(e.defaultPrevented, "没溢出就不该吞事件").toBe(false);
  });

  it("滚到边界后同方向继续滚不再吞事件", () => {
    const { host } = mount(6);
    host.scrollLeft = 360; // 钳到最右
    const e = wheelOn(host, 100);
    expect(host.scrollLeft).toBe(360);
    expect(e.defaultPrevented, "已经滚不动了，留给页面").toBe(false);
  });

  it("Ctrl+滚轮让位给字号缩放（标签栏不处理、不拦截）", () => {
    const { host } = mount(6);
    const e = wheelOn(host, 100, true);
    expect(host.scrollLeft, "Ctrl+滚轮不应滚动标签栏").toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("deltaMode=1（行）也要能滚动，不能只当像素用", () => {
    const { host } = mount(6);
    // 某些鼠标驱动按「行」上报，delta 常常只有 3；当成像素就几乎滚不动
    host.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true }),
    );
    expect(host.scrollLeft, "3 行应按行高折算，不能只滚 3px").toBeGreaterThan(3);
  });
});

describe("B53 滚动定位：活动标签要看得见，但不乱跳", () => {
  it("新激活的标签必须滚进可见区", () => {
    const { host } = mount(6, 5); // 活动 = 末位 tab6：offsetLeft 510，右缘 610
    // 只需滚到能看见它的最小距离：610 - 250 = 360，而不是把它左对齐
    expect(host.scrollLeft).toBe(360);
  });

  it("激活一个已经可见的标签时，滚动位置不动（不跳）", () => {
    const { host } = mount(6, 0);
    expect(host.scrollLeft).toBe(0);
    // tab2 在 102..202，视窗 0..250 内已完全可见
    renderTabstrip(host, tabs(6, 1), cb());
    expect(host.scrollLeft, "已可见的标签不该把标签栏拽动").toBe(0);
  });

  it("重绘必须保留滚动位置（全量重绘会把 scrollLeft 归零）", () => {
    const { host } = mount(6, 5);
    expect(host.scrollLeft).toBe(360);
    // 同内容重绘：活动标签没变 → 不得重新定位、也不得归零
    renderTabstrip(host, tabs(6, 5), cb());
    expect(host.scrollLeft, "重绘后滚动位置必须原样保留").toBe(360);
    // 关闭一个不相关的标签后仍不应跳回最左
    const rest = tabs(6, 5).filter((t) => t.tabId !== 1);
    renderTabstrip(host, rest, cb());
    expect(host.scrollLeft).toBeGreaterThan(0);
  });

  it("切换可见标签时不滚动；关到放得下时也不残留偏移", () => {
    const { host } = mount(6, 3); // tab4 → 滚到 156
    expect(host.scrollLeft).toBe(156);
    renderTabstrip(host, tabs(6, 2), cb()); // tab3 在 204..304，视窗 156..406 内可见
    expect(host.scrollLeft, "可见就不动").toBe(156);
    // 只剩 2 个标签，内容 202 < 250 → 浏览器会把 scrollLeft 钳回 0
    renderTabstrip(host, tabs(2, 1), cb());
    expect(host.scrollLeft, "内容不再溢出时必须回到起点").toBe(0);
  });
});

describe("B53 脏标记与关闭按钮共用槽位（VS Code 行为）", () => {
  it("未保存的标签带 tab-dirty 且槽位显示矢量圆点（B57）", () => {
    const { host } = mount(2);
    const [clean, dirty] = [
      host.querySelectorAll<HTMLElement>(".tab")[0],
      host.querySelectorAll<HTMLElement>(".tab")[1],
    ];
    expect(clean.classList.contains("tab-dirty"), "已保存不该带 tab-dirty").toBe(false);
    expect(dirty.classList.contains("tab-dirty")).toBe(false);

    renderTabstrip(host, [tabs(2)[0], { ...tabs(2)[1], dirty: true }], cb());
    const els = host.querySelectorAll<HTMLElement>(".tab");
    expect(els[1].classList.contains("tab-dirty")).toBe(true);
    // B57 起 ● 是矢量字形（VS Code codicon 的 circle-filled），且槽位用 opacity 显隐、
    // 恒定存在于 DOM，所以这里断「有图标」+「带 tab-dirty」，而不是断文本内容。
    expect(els[1].querySelector(".tab-mark i.codicon"), "未保存要显示矢量圆点").toBeTruthy();
    expect(els[0].classList.contains("tab-dirty"), "已保存不带 tab-dirty").toBe(false);
    expect(
      els[0].querySelector(".tab-mark i.codicon"),
      "已保存槽位结构仍在（靠 opacity: 0 隐藏，固定槽位保证悬停切换不抖动）",
    ).toBeTruthy();
  });

  it("● 与 × 在同一个固定尺寸槽位里（.tab-action）", () => {
    const { host } = mount(1);
    const action = host.querySelector(".tab .tab-action");
    expect(action, "两者必须共用槽位，否则悬停切换时标签宽度会变、整排抖动").toBeTruthy();
    expect(action!.querySelector(".tab-mark")).toBeTruthy();
    expect(action!.querySelector(".tab-close")).toBeTruthy();
  });

  it("B65/B66 未保存的当前标签会同时带 tab-dirty 与 tab-active —— 显隐只能由 CSS 保证", () => {
    // 这条用例的价值在于**锁住前提**：同一个标签上两个状态类会并存，而且槽位里
    // ● 与 × 两个 glyph 始终都在 DOM 里（靠 opacity 显隐）。所以「显示哪一个」
    // 不可能是 JS 的职责，只能在 CSS 里用 `:not()` 链表达（B65 定互斥，B66 定判据：
    // 未保存时默认 ●，指针进关闭区才换 ×）。
    // 哪天有人把槽位改成「谁可见才渲染谁」，这条会失败 —— 那时才该删掉 CSS 那份判据。
    const { host } = mount(1);
    renderTabstrip(host, [{ ...tabs(1)[0], dirty: true, active: true }], cb());

    const el = host.querySelector<HTMLElement>(".tab")!;
    expect(el.classList.contains("tab-dirty"), "未保存 → tab-dirty").toBe(true);
    expect(el.classList.contains("tab-active"), "当前标签 → tab-active").toBe(true);

    const action = el.querySelector(".tab-action")!;
    expect(action.querySelector(".tab-mark"), "● 常驻 DOM，靠 CSS 决定显隐").toBeTruthy();
    expect(action.querySelector(".tab-close"), "× 常驻 DOM，靠 CSS 决定显隐").toBeTruthy();
  });

  it("关闭按钮仍然能关（即使 CSS 平时把它藏起来）", () => {
    const { host } = mount(1);
    const closed: number[] = [];
    renderTabstrip(host, tabs(1), {
      onActivate: () => {},
      onClose: (id) => closed.push(id),
    });
    host.querySelector<HTMLButtonElement>(".tab-close")!.click();
    expect(closed).toEqual([1]);
  });
});

describe("B116 闪烁效果移除（原 B47/B53「切换后闪一下」）", () => {
  it("首次渲染不闪，切换后也不闪（tab-flash 已整体移除）", () => {
    const { host } = mount(6, 0);
    expect(host.querySelector(".tab-flash"), "首次渲染不该有 tab-flash").toBeNull();

    renderTabstrip(host, tabs(6, 5), cb());
    expect(host.querySelector(".tab-flash"), "切换后也不得再挂 tab-flash 类").toBeNull();
  });
});

describe("B123-4 标签 tooltip 只留一行完整路径（文件名不重复）", () => {
  it("有路径：提示主行就是路径，无第二行 detail", () => {
    const host = document.createElement("div");
    host.className = "panel-tabstrip";
    document.body.appendChild(host);
    renderTabstrip(
      host,
      [
        {
          tabId: 1,
          name: "example.md",
          dirty: false,
          readonly: false,
          active: true,
          path: "E:/docs/example.md",
        },
      ],
      cb(),
    );
    const tab = host.querySelector<HTMLElement>(".tab")!;
    expect(tab.dataset.tip, "提示必须是完整路径本身").toBe("E:/docs/example.md");
    expect(tab.dataset.tipDetail, "不得再挂第二行 detail（路径已 monopoly 主行）").toBeUndefined();
  });

  it("只读文件：路径后跟 [只读] 标记，同行显示", () => {
    const host = document.createElement("div");
    host.className = "panel-tabstrip";
    document.body.appendChild(host);
    renderTabstrip(
      host,
      [
        {
          tabId: 1,
          name: "ro.md",
          dirty: false,
          readonly: true,
          active: true,
          path: "E:/docs/ro.md",
        },
      ],
      cb(),
    );
    const tab = host.querySelector<HTMLElement>(".tab")!;
    expect(tab.dataset.tip, "只读标记跟在路径后").toBe("E:/docs/ro.md [只读]");
  });

  it("无路径（未命名文件）：退回文件名，不得渲染出 undefined", () => {
    const host = document.createElement("div");
    host.className = "panel-tabstrip";
    document.body.appendChild(host);
    renderTabstrip(
      host,
      [{ tabId: 1, name: "未命名", dirty: false, readonly: false, active: true }],
      cb(),
    );
    const tab = host.querySelector<HTMLElement>(".tab")!;
    expect(tab.dataset.tip, "无路径时退回文件名").toBe("未命名");
  });
});

describe("B125 标签区滚动条：自动隐藏 + 跟随面板宽度自适应（对标 VS Code）", () => {
  const wrapOf = (host: HTMLElement): HTMLElement => host.parentElement!;
  const barOf = (host: HTMLElement): HTMLElement =>
    wrapOf(host).querySelector<HTMLElement>(".panel-tabstrip-scrollbar")!;
  const thumbOf = (host: HTMLElement): HTMLElement => barOf(host).firstElementChild as HTMLElement;
  const visible = (host: HTMLElement): boolean => barOf(host).classList.contains("is-visible");
  const fire = (el: HTMLElement, type: string): void => el.dispatchEvent(new Event(type));
  const px = (v: string): number => Number.parseInt(v, 10);

  it("默认隐藏：溢出也只是把 thumb 备好，不画出来", () => {
    const { host } = mount(6);
    expect(barOf(host), "溢出时滚动条元素要在").toBeTruthy();
    expect(barOf(host).style.display, "溢出时元素可见性打开").not.toBe("none");
    expect(visible(host), "不悬停就不该显示（VS Code 的 ScrollbarVisibility.Auto）").toBe(false);
  });

  it("放得下时连元素一起收起，且不残留可见态", () => {
    const { host } = mount(2); // 202 ≤ 250
    fire(wrapOf(host), "pointerenter");
    expect(barOf(host).style.display, "放得下就完全不显示").toBe("none");
    expect(visible(host), "不溢出时不得留可见类（下次溢出才不会闪一下）").toBe(false);
  });

  it("悬停条带即出现，离开即收起", () => {
    const { host } = mount(6);
    fire(wrapOf(host), "pointerenter");
    expect(visible(host), "悬停要立刻看得见").toBe(true);
    fire(wrapOf(host), "pointerleave");
    expect(visible(host), "离开要收起").toBe(false);
  });

  it("滚动唤起后 500ms 自动淡出（= VS Code HIDE_TIMEOUT）", () => {
    vi.useFakeTimers();
    try {
      const { host } = mount(6);
      wheelOn(host, 100);
      expect(visible(host), "滚动时要出现").toBe(true);
      vi.advanceTimersByTime(499);
      expect(visible(host), "不到 500ms 不该消失").toBe(true);
      vi.advanceTimersByTime(1);
      expect(visible(host), "停手 500ms 后淡出").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("悬停期间不会被自动淡出计时器收走（计时器只看「是否在用」）", () => {
    vi.useFakeTimers();
    try {
      const { host } = mount(6);
      fire(wrapOf(host), "pointerenter");
      wheelOn(host, 100);
      vi.advanceTimersByTime(2000);
      expect(visible(host), "指针还在条带上就不能消失").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("面板宽度变化（拖分屏条，不改窗口尺寸）时 thumb 几何跟着变", () => {
    const { host } = mount(6); // 内容 610
    const w1 = thumbOf(host).style.width;
    expect(px(w1), "250 视宽下 thumb 应已算出宽度").toBeGreaterThan(0);

    // 拖窄 → 可视占比变小 → thumb 更短
    VIEW_W = 150;
    expect(
      roCallbacks.length,
      "必须挂了 ResizeObserver：拖分屏条不触发 window.resize，光靠它兜不住",
    ).toBeGreaterThan(0);
    for (const cb of roCallbacks) cb();
    const w2 = thumbOf(host).style.width;
    expect(px(w2), `面板变窄后 thumb 必须变短（${w1} → ${w2}）`).toBeLessThan(px(w1));

    // 拖宽回去 → thumb 变长
    VIEW_W = 600;
    for (const cb of roCallbacks) cb();
    const w3 = thumbOf(host).style.width;
    expect(px(w3), `面板变宽后 thumb 必须变长（${w2} → ${w3}）`).toBeGreaterThan(px(w2));
  });

  it("拖 thumb 期间常显：手拖出条带也不消失，松手后才开始计时", () => {
    vi.useFakeTimers();
    try {
      const { host } = mount(6);
      fire(wrapOf(host), "pointerenter");
      thumbOf(host).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0 }));
      fire(wrapOf(host), "pointerleave"); // 拖出条带
      expect(visible(host), "拖拽中必须保持可见").toBe(true);
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      vi.advanceTimersByTime(500);
      expect(visible(host), "松手且指针不在条带上 → 淡出").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
