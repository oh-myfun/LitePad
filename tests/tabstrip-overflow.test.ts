// @vitest-environment jsdom
// 标签栏溢出折叠：不显示滚动条、放不下的标签折叠进下拉按钮、滚轮切换可见区间。
// jsdom 没有排版，因此用桩模拟：标签固定宽 100px、标签区可视宽 250px。
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { renderTabstrip, type TabViewData, type TabstripCallbacks } from "../src/shell/tabstrip";
import { closePopupMenu } from "../src/shell/menu";

const TAB_W = 100;
const STRIP_W = 250;

beforeAll(() => {
  // 可视宽度：只有标签栏容器有宽度
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("panel-tabstrip") ? STRIP_W : 0;
    },
  });
  // 元素宽度：标签 100px，其余 0
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const w = this.classList?.contains("tab") ? TAB_W : 0;
    return {
      width: w,
      height: 20,
      top: 0,
      left: 0,
      right: w,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  closePopupMenu();
  document.body.textContent = "";
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
  return {
    activated,
    onActivate: (id) => activated.push(id),
    onClose: () => {},
  };
}

function mount(n: number, active = 0) {
  const host = document.createElement("div");
  host.className = "panel-tabstrip";
  document.body.appendChild(host);
  const c = cb();
  renderTabstrip(host, tabs(n, active), c);
  return { host, c };
}

const visibleNames = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLElement>(".tab .tab-name")].map((e) => e.textContent ?? "");

function wheel(host: HTMLElement, delta: number, ctrl = false): void {
  const e = new WheelEvent("wheel", {
    deltaY: delta,
    ctrlKey: ctrl,
    bubbles: true,
    cancelable: true,
  });
  host.dispatchEvent(e);
}

describe("标签栏溢出折叠", () => {
  it("放得下时不折叠、也不显示折叠按钮", () => {
    const { host } = mount(2);
    // 2×100 + gap 2 = 202 ≤ 250
    expect(visibleNames(host)).toEqual(["tab1", "tab2"]);
    expect(host.querySelector(".tab-more"), "不应出现折叠按钮").toBeNull();
  });

  it("放不下时折叠超出的标签，并在右侧给出下拉按钮（箭头 + 数量徽标）", () => {
    const { host } = mount(6);
    // 预算 = 250 - 34 = 216 → 只能放 2 个（100 + 2 + 100 = 202）
    expect(visibleNames(host)).toEqual(["tab1", "tab2"]);
    const more = host.querySelector<HTMLButtonElement>(".tab-more");
    expect(more, "必须有折叠按钮").toBeTruthy();
    expect(more!.querySelector(".tab-more-chev")?.textContent).toBe("»");
    expect(more!.querySelector(".tab-more-count")?.textContent, "折叠数量徽标").toBe("4");
    expect(more!.title).toContain("4 个标签已折叠");
  });

  it("B32 活动标签被折叠时按钮高亮（tab-more-active）", () => {
    const { host } = mount(6, 3);
    // 活动标签 tab4 被拉进窗口，不触发高亮
    expect(visibleNames(host)).toEqual(["tab3", "tab4"]);
    expect(host.querySelector(".tab-more-active")).toBeNull();
    // 滚轮浏览使活动标签离开可视区（滚离活动标签是允许的）→ 高亮提示
    wheel(host, 100);
    wheel(host, 100);
    expect(visibleNames(host)).toEqual(["tab5", "tab6"]);
    expect(host.querySelector(".tab-more-active"), "活动标签已折叠应高亮").toBeTruthy();
  });

  it("B32 关闭左侧折叠标签后窗口不漂移（按 tabId 锚定，不再按纯下标）", () => {
    const { host } = mount(6, 0);
    wheel(host, 100);
    wheel(host, 100);
    expect(visibleNames(host)).toEqual(["tab3", "tab4"]);
    // 关掉折叠在左侧的 tab2：下标整体前移，窗口内容必须仍是 tab3/tab4
    const list = tabs(6, 0).filter((t) => t.tabId !== 2);
    renderTabstrip(host, list, cb());
    expect(visibleNames(host), "锚点 tab3 应停在原位").toEqual(["tab3", "tab4"]);
  });

  it("B32 切换两个可见标签时窗口不跳动", () => {
    const { host } = mount(6, 0);
    wheel(host, 100);
    wheel(host, 100);
    expect(visibleNames(host)).toEqual(["tab3", "tab4"]);
    // 激活可见的 tab4：窗口保持不动（旧实现会把活动标签强制左对齐 → 跳成 tab4/tab5）
    renderTabstrip(host, tabs(6, 3), cb());
    expect(visibleNames(host), "活动标签已可见，窗口不得移动").toEqual(["tab3", "tab4"]);
  });

  it("B32 追加打开新文件只做最小移动（尾部对齐，保留左侧上下文）", () => {
    const { host } = mount(6, 0);
    expect(visibleNames(host)).toEqual(["tab1", "tab2"]);
    // 新开的 tab7 追加在末尾并激活：窗口尾部对齐，tab6 仍在可视区
    renderTabstrip(host, tabs(7, 6), cb());
    expect(visibleNames(host), "应显示 tab6/tab7 而不是只显示 tab7").toEqual(["tab6", "tab7"]);
  });

  it("下拉里同时列出左侧与右侧被折叠的标签（中间用分隔线分组）", () => {
    const { host, c } = mount(6);
    // 先把窗口滚到中间，制造"两侧都有折叠"
    wheel(host, 100);
    wheel(host, 100);
    expect(visibleNames(host)).toEqual(["tab3", "tab4"]);
    const more = host.querySelector<HTMLButtonElement>(".tab-more")!;
    more.click();
    const menu = document.querySelector(".popup-menu");
    expect(menu, "点击应展开下拉列表").toBeTruthy();
    // 去掉勾选列（活动项前面会有 ✓），只取标签名
    const labels = [...menu!.querySelectorAll("button")].map(
      (b) => b.childNodes[1]?.textContent ?? "",
    );
    expect(labels, "左侧 tab1/tab2 + 右侧 tab5/tab6 都应在列表里").toEqual([
      "tab1",
      "tab2",
      "tab5",
      "tab6",
    ]);
    expect(
      menu!.querySelector("button")!.querySelector(".check")?.textContent,
      "列表里应标出当前活动标签",
    ).toBe("✓");
    expect(menu!.querySelectorAll(".menu-sep").length, "左右两组之间要有分隔线").toBe(1);
    // 点列表项即激活对应标签
    [...menu!.querySelectorAll<HTMLButtonElement>("button")][3].click();
    expect(c.activated).toEqual([6]);
  });

  it("滚轮改变可见区间，并吞掉事件（不传给页面）", () => {
    const { host } = mount(6);
    expect(visibleNames(host)).toEqual(["tab1", "tab2"]);
    const e1 = wheelEvent(host, 100);
    expect(visibleNames(host)).toEqual(["tab2", "tab3"]);
    expect(e1.defaultPrevented, "滚轮应被标签栏自己消化").toBe(true);
    wheelEvent(host, -100);
    expect(visibleNames(host), "反向滚回上一个区间").toEqual(["tab1", "tab2"]);
  });

  it("Ctrl+滚轮让位给字号缩放（标签栏不处理、不拦截）", () => {
    const { host } = mount(6);
    const e = wheelEvent(host, 100, true);
    expect(visibleNames(host), "Ctrl+滚轮不应切换标签区间").toEqual(["tab1", "tab2"]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("活动标签切换后必须出现在可见区间内", () => {
    const { host } = mount(6, 0);
    expect(visibleNames(host)).toEqual(["tab1", "tab2"]);
    // 激活末尾的 tab6：窗口应滑过去把它显示出来
    renderTabstrip(host, tabs(6, 5), cb());
    expect(visibleNames(host)).toContain("tab6");
    expect(host.querySelector(".tab-active")?.textContent).toContain("tab6");
  });

  it("标签关闭到能放下时，折叠按钮消失", () => {
    const { host } = mount(6);
    expect(host.querySelector(".tab-more")).toBeTruthy();
    renderTabstrip(host, tabs(2, 1), cb());
    expect(host.querySelector(".tab-more")).toBeNull();
    expect(visibleNames(host)).toEqual(["tab1", "tab2"]);
  });
});

function wheelEvent(host: HTMLElement, delta: number, ctrl = false): WheelEvent {
  const e = new WheelEvent("wheel", {
    deltaY: delta,
    ctrlKey: ctrl,
    bubbles: true,
    cancelable: true,
  });
  host.dispatchEvent(e);
  return e;
}
