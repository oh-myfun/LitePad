// @vitest-environment jsdom
// B27：拖拽 tab 的两种落点预览要区分开——
//   tab 区 = 调整顺序（插入指示线），面板区 = 分屏预览层；
//   且落在 tab 区绝不触发分屏。
// B26：分割条比例回写路径约定（updateRatio 已进 layout.ts，见 layout.test.ts）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { stripInsertInfo } from "../src/shell/splitview";

// 几何桩：jsdom 无布局，按元素逐个登记矩形
const rects = new WeakMap<
  Element,
  { left: number; top: number; right: number; bottom: number; width: number; height: number }
>();
let restore: (() => void) | null = null;

beforeAll(() => {
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this);
    if (r) return { ...r, x: r.left, y: r.top, toJSON() {} } as DOMRect;
    return orig.call(this);
  };
  restore = () => {
    Element.prototype.getBoundingClientRect = orig;
  };
  if (!document.body) document.body = document.createElement("body");
  document.body.innerHTML = "";
});
afterAll(() => restore?.());

function el(cls: string, r: { left: number; width: number }, tabId?: number): HTMLElement {
  const e = document.createElement("div");
  e.className = cls;
  if (tabId !== undefined) e.dataset.tabId = String(tabId);
  const top = 0;
  const height = 26;
  rects.set(e, {
    left: r.left,
    top,
    right: r.left + r.width,
    bottom: top + height,
    width: r.width,
    height,
  });
  return e;
}

/** strip [0..250]，三个 tab：[0..80][82..162][164..244] */
function stripWithTabs(): HTMLElement {
  const strip = el("panel-tabstrip", { left: 0, width: 250 });
  strip.append(
    el("tab", { left: 0, width: 80 }, 11),
    el("tab", { left: 82, width: 80 }, 12),
    el("tab", { left: 164, width: 80 }, 13),
  );
  return strip;
}

describe("stripInsertInfo（tab 区插入位置）", () => {
  it("指针在标签前半 → 插到该标签之前", () => {
    const strip = stripWithTabs();
    expect(stripInsertInfo(strip, 30)).toEqual({ beforeTabId: 11, offsetLeft: 0 });
    expect(stripInsertInfo(strip, 100)).toEqual({ beforeTabId: 12, offsetLeft: 82 });
  });

  it("指针在最后一个标签后半 → 追加到末尾", () => {
    const strip = stripWithTabs();
    expect(stripInsertInfo(strip, 240)).toEqual({ beforeTabId: null, offsetLeft: 244 });
  });

  it("strip 之外返回 null（走分屏预览分支）", () => {
    const strip = stripWithTabs();
    expect(stripInsertInfo(strip, 300)).toBeNull();
    expect(stripInsertInfo(strip, -5)).toBeNull();
  });

  it("B53 标签栏横向滚动后，插入线偏移必须补上 scrollLeft", () => {
    // .tab-insert 是 strip 的绝对定位子元素，left 走**内容坐标**（会随内容滚），
    // 而 getBoundingClientRect 的差值是**视口坐标**。B53 起标签栏可横向滚动，
    // 两者相差一个 strip.scrollLeft —— 不补就会把插入线画到错误的标签之间。
    // 其余用例里 scrollLeft 恒为 0，正好掩盖了这个 bug，所以这里显式造一个非零值。
    const strip = stripWithTabs();
    Object.defineProperty(strip, "scrollLeft", { configurable: true, value: 100 });
    // 指针视口坐标不变（桩固定），内容坐标应整体右移 100
    expect(stripInsertInfo(strip, 100)).toEqual({ beforeTabId: 12, offsetLeft: 182 });
    expect(stripInsertInfo(strip, 240)).toEqual({ beforeTabId: null, offsetLeft: 344 });
  });
});

describe("B26/B27 接线（静态断言）", () => {
  const main = readFileSync("src/main.ts", "utf-8");
  const sv = readFileSync("src/shell/splitview.ts", "utf-8");
  const css = readFileSync("src/styles/global.css", "utf-8");

  it("比例回写必须与 build 的路径约定一致（splitview 传节点自身路径）", () => {
    const layout = readFileSync("src/shell/layout.ts", "utf-8");
    expect(layout, "updateRatio 空路径 = 根分割自身").toMatch(
      /if \(path\.length === 0\) \{\s*\n\s*node\.ratio =/,
    );
    // 旧实现的错误判据不得再出现
    expect(layout, "不得再按「寻址子节点」解释路径").not.toMatch(
      /rest\.length === 0 && \(head === 0 \|\| head === 1\)/,
    );
    expect(main, "main.ts 不得再有本地旧实现").not.toMatch(/function updateRatio\(/);
  });

  it("tab 区拖拽 = 排序指示，且先于分屏预览判定", () => {
    // B91-2：落点提交搬进 commitTabDrop（参数从 MouseEvent 换成显式的 TabDropRequest），
    // 判据的顺序一字未改：先看是不是落在标签区（排序），再谈分屏。
    expect(sv, "落点判定时必须先判 tab 区（stripUnder）再判分屏 zone").toMatch(
      /const strip = stripUnder\(panelEl, req\.x, req\.y\);[\s\S]{0,600}zoneOf\(panelEl\.getBoundingClientRect\(\)/,
    );
    expect(sv, "tab 区落下必须走 onMoveTabToStrip（排序/移动），不得分屏").toMatch(
      /stripInsertInfo\(strip, req\.x\)[\s\S]{0,120}onMoveTabToStrip\(/,
    );
    expect(main, "main.ts 必须接线 onMoveTabToStrip → moveTabToStrip").toMatch(
      /onMoveTabToStrip: \(panelId, tabId, beforeTabId\) =>\s*\n?\s*moveTabToStrip\(panelId, tabId, beforeTabId\)/,
    );
    expect(css, "插入指示线样式必须存在").toContain(".tab-insert");
    expect(css, "strip 必须是定位基准").toMatch(/\.panel-tabstrip\s*\{[^}]*position: relative/);
  });

  it("两种预览互斥：一次落点判定只留一种痕迹", () => {
    // B89：落点判定抽成了 previewDropAt（本窗口拖拽与**跨窗口悬停**共用同一份），
    // 互斥的做法从「进 tab 区时手动清预览」变成「每次判定开头先清两种痕迹」——
    // 后者更不容易漏：任何一处忘记清理都不会留下上一帧的残影。
    expect(sv, "落点判定开头先把两种痕迹都清掉").toMatch(
      /function previewDropAt[\s\S]{0,300}clearAllPreviews\(\);\s*\n\s*clearInsertIndicators\(\);/,
    );
    expect(sv, "落在 tab 区只画插入线").toMatch(
      /if \(strip\) \{[\s\S]{0,240}showInsertIndicator\(strip, info\.offsetLeft\)/,
    );
    expect(sv, "落在面板区才画分屏预览").toMatch(
      /preview\.className = `split-preview show zone-\$\{effZone\}`/,
    );
  });

  it("空标签栏的插入线贴最左（B90：否则空面板上悬停会冒出一条滚动条）", () => {
    const strip = document.createElement("div");
    strip.className = "panel-tabstrip";
    rects.set(strip, { left: 0, top: 0, right: 300, bottom: 28, width: 300, height: 28 });
    const info = stripInsertInfo(strip, 150);
    expect(info, "空标签栏也要给出插入位置").not.toBeNull();
    // ⚠️ 取 strip 宽度会把 scrollWidth 顶到可视宽度之外 —— 指示线是 absolute 定位，
    // 一样参与滚动区域计算，于是「拖过一块空面板」就多出一条横向滚动条。
    expect(info!.offsetLeft, "空标签栏的插入线贴最左").toBe(0);
    expect(info!.beforeTabId).toBeNull();
  });
});
