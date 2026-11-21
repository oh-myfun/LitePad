// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ruleBlock } from "./static";
import { ensureListScrollbar } from "../src/shell/scrollbar";

// --------------------------------------------------------------------------- #
// 边栏列表：悬浮、自动隐藏、不占宽度的纵向滚动条
// --------------------------------------------------------------------------- #
const SIDEBAR_LISTS = [
  "toc-list",
  "recent-list",
  "explorer-tree",
  "search-results",
  "diff-list",
] as const;

describe("边栏列表滚动条（静态契约）", () => {
  const css = readFileSync("src/styles/preview.css", "utf-8");

  it("原生纵向条收成 0 宽：不占布局空间（否则每一行都比标题栏窄 8px）", () => {
    const selector = SIDEBAR_LISTS.map((c) => `.${c}::-webkit-scrollbar`).join(", ");
    const block = ruleBlock(css, selector);
    expect(block, "五个列表都必须覆盖原生滚动条尺寸").toBeTruthy();
    expect(block).toMatch(/width:\s*0/);
    expect(block).toMatch(/height:\s*0/);
  });

  it("浮层默认隐藏、隐藏时不挡行点击；可见态才出现并吃事件", () => {
    const bar = ruleBlock(css, ".side-scrollbar");
    expect(bar).toContain("position: absolute");
    expect(bar, "宽度比原生 8px 窄一档").toMatch(/width:\s*6px/);
    expect(bar, "默认隐藏（VS Code 的 ScrollbarVisibility.Auto）").toMatch(/opacity:\s*0/);
    expect(bar, "看不见时不能挡住最右 6px 的行点击").toContain("pointer-events: none");
    const visible = ruleBlock(css, ".side-scrollbar.is-visible");
    expect(visible).toMatch(/opacity:\s*1/);
    expect(ruleBlock(css, ".side-scrollbar.is-visible .side-scrollbar-thumb")).toContain(
      "pointer-events: auto",
    );
  });

  it("thumb 与原生滚动条同一套配色 / 圆角 token", () => {
    const thumb = ruleBlock(css, ".side-scrollbar-thumb");
    expect(thumb).toContain("var(--sb-thumb");
    expect(thumb, "滑块要圆角（与 ::-webkit-scrollbar-thumb 同款）").toMatch(
      /border-radius:\s*3px/,
    );
    expect(ruleBlock(css, ".side-scrollbar-thumb:hover")).toContain("--sb-thumb-hover");
    expect(ruleBlock(css, ".side-scrollbar-thumb:active")).toContain("--sb-thumb-active");
  });

  it("包含块由面板提供（bar 是列表的兄弟，不能随列表内容滚走）", () => {
    expect(ruleBlock(css, ".side-scroll-anchor")).toMatch(/position:\s*relative/);
  });

  it("五块侧栏列表全部接入悬浮滚动条（漏一块就还是原生条占 8px）", () => {
    const src = readFileSync("src/toc.ts", "utf-8");
    const setup = src.slice(src.indexOf("function setupSideBar"));
    expect(setup, "接线必须发生在侧栏装配处").toContain("ensureListScrollbar(");
    for (const c of SIDEBAR_LISTS) {
      const handle = c.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      expect(setup, `列表 ${c} 必须接入`).toContain(handle);
    }
  });
});

describe("边栏列表滚动条行为（jsdom 桩几何）", () => {
  const geom = { viewH: 100, contentH: 400 };
  const scrollStore = new WeakMap<HTMLElement, number>();
  let restore: (() => void) | null = null;

  beforeAll(() => {
    const proto = HTMLElement.prototype;
    // jsdom 自己在 HTMLElement.prototype 上实现了这些几何属性（默认返回 0）。
    // 只删不还原会把 jsdom 的实现一起抹掉，后续文件读 offsetLeft/scrollHeight 就成了
    // undefined（文件级隔离时看不出来，worker 复用环境时会连锁污染）。
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const def = (prop: string, desc: PropertyDescriptor): void => {
      if (!originals.has(prop)) originals.set(prop, Object.getOwnPropertyDescriptor(proto, prop));
      Object.defineProperty(proto, prop, { configurable: true, ...desc });
    };
    const isHost = (n: HTMLElement): boolean => n.classList.contains("toc-list");
    const isBar = (n: HTMLElement): boolean => n.classList.contains("side-scrollbar");
    def("clientHeight", {
      get(this: HTMLElement) {
        return isHost(this) || isBar(this) ? geom.viewH : 0;
      },
    });
    def("scrollHeight", {
      get(this: HTMLElement) {
        return isHost(this) ? geom.contentH : 0;
      },
    });
    def("scrollTop", {
      get(this: HTMLElement) {
        return scrollStore.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        scrollStore.set(this, Math.max(0, Math.min(max, v)));
      },
    });
    def("offsetTop", { get: () => 28 });
    def("offsetLeft", { get: () => 0 });
    def("offsetWidth", {
      get(this: HTMLElement) {
        return isHost(this) ? 240 : 8;
      },
    });
    def("offsetHeight", {
      get(this: HTMLElement) {
        const h = Number.parseFloat(this.style.height);
        return Number.isFinite(h) ? h : 0;
      },
    });
    restore = () => {
      for (const [p, d] of originals) {
        if (d) Object.defineProperty(proto, p, d);
        else delete (proto as unknown as Record<string, unknown>)[p];
      }
    };
  });

  afterAll(() => restore?.());
  afterEach(() => {
    document.body.textContent = "";
    geom.viewH = 100;
    geom.contentH = 400;
  });

  function mount(): {
    panel: HTMLElement;
    host: HTMLElement;
    bar: HTMLElement;
    thumb: HTMLElement;
  } {
    const panel = document.createElement("aside");
    const host = document.createElement("div");
    host.className = "toc-list";
    panel.append(host);
    document.body.append(panel);
    ensureListScrollbar(host);
    const bar = panel.querySelector<HTMLElement>(".side-scrollbar")!;
    return { panel, host, bar, thumb: bar.firstElementChild as HTMLElement };
  }

  const visible = (bar: HTMLElement): boolean => bar.classList.contains("is-visible");

  it("装上浮层：面板成为包含块，bar 是列表的兄弟而不是子节点", () => {
    const { panel, host, bar, thumb } = mount();
    expect(panel.classList.contains("side-scroll-anchor")).toBe(true);
    expect(bar.parentElement).toBe(panel);
    expect(host.contains(bar), "放进列表会随内容滚走").toBe(false);
    expect(thumb.className).toBe("side-scrollbar-thumb");
    // 幂等：重复装配不得加第二条
    ensureListScrollbar(host);
    expect(panel.querySelectorAll(".side-scrollbar").length).toBe(1);
  });

  it("溢出才显示；几何贴着列表右缘、thumb 按可视占比算", () => {
    const { bar, thumb } = mount();
    expect(bar.style.display, "溢出时要备好").not.toBe("none");
    expect(bar.style.top).toBe("28px");
    expect(bar.style.height).toBe("100px");
    expect(bar.style.left, "240 - 6：轨道右缘与列表右缘对齐").toBe("234px");
    expect(thumb.style.height, "100 × (100/400) = 25px").toBe("25px");
    expect(thumb.style.transform).toBe("translateY(0px)");
  });

  it("放得下时连元素一起收起，且不残留可见态", () => {
    geom.contentH = 100;
    const { bar } = mount();
    expect(bar.style.display).toBe("none");
  });

  it("指针进列表即出现，离开即收起；挪到 thumb 上不算离开", () => {
    const { host, bar } = mount();
    host.dispatchEvent(new MouseEvent("pointerenter"));
    expect(visible(bar)).toBe(true);
    host.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: bar }));
    expect(visible(bar), "移到滚动条 thumb 上仍算在列表里").toBe(true);
    host.dispatchEvent(new MouseEvent("pointerleave"));
    expect(visible(bar)).toBe(false);
  });

  it("滚动唤起后 500ms 自动淡出（= VS Code HIDE_TIMEOUT）", () => {
    vi.useFakeTimers();
    try {
      const { host, bar } = mount();
      host.scrollTop = 150;
      host.dispatchEvent(new Event("scroll"));
      expect(visible(bar), "滚动时要出现").toBe(true);
      expect(host.querySelector(".side-scrollbar")).toBeNull();
      vi.advanceTimersByTime(499);
      expect(visible(bar)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(visible(bar), "停手 500ms 后淡出").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("thumb 位置跟着 scrollTop 走（滚到底时贴着轨道下端）", () => {
    const { host, thumb } = mount();
    host.scrollTop = 300; // max = 400 - 100
    host.dispatchEvent(new Event("scroll"));
    expect(thumb.style.transform).toBe("translateY(75px)"); // (300/300) × (100 - 25)
  });

  it("拖 thumb 改 scrollTop（不再依赖原生滚动条）", () => {
    const { host, bar, thumb } = mount();
    thumb.dispatchEvent(new MouseEvent("pointerdown", { clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 37.5 }));
    expect(host.scrollTop, "37.5 / (100 - 25) × 300 = 150").toBe(150);
    expect(visible(bar), "拖拽期间常显").toBe(true);
    window.dispatchEvent(new MouseEvent("pointerup"));
  });

  it("列表重绘（内容高度变化）不靠 ResizeObserver 也能重新同步", async () => {
    const { host, bar } = mount();
    expect(bar.style.display).not.toBe("none");
    geom.contentH = 100; // 内容变矮到放得下
    host.append(document.createElement("span"));
    await new Promise((r) => setTimeout(r, 0));
    expect(bar.style.display, "MutationObserver 要补上「内容变矮」这一半").toBe("none");
  });
});
