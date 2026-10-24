// @vitest-environment jsdom
// B321 · 预览渲染的配色必须跟着主题走。
//
// 两条真病灶（用户报「渲染的颜色没有随主题色切换」）：
//  1. Shiki 的 `defaultColor` 默认是 `'light'` —— 它会把**浅色的** token 色写成 span 的内联
//     `color`、把 `background-color:#fff` 写成 pre 的内联样式。内联样式压过类规则，
//     于是 `:root[data-theme="dark"] … pre.shiki span { color: var(--shiki-dark) }` 永远轮不到，
//     深色主题下代码块是一块白底 + 浅色配色。传 `defaultColor: false` 后 shiki 只留
//     `--shiki-light/--shiki-dark` 变量，切换权交回 CSS。
//  2. Mermaid 的 `theme:` 是在**渲染那一刻**取的（`dataset.theme`），图一旦画好就定色；
//     岛级增量复用之后那一格再也不会重画 ⇒ 切主题图不变色。需要一次显式 retheme。
import { beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ rendered: [] as string[] }));

vi.mock("../src/sync-scroll/wire", () => ({
  syncCoordinator: { expectSurfaceV: vi.fn() },
  PreviewScrollAnchor: class {
    getV() {
      return 1;
    }
    setV() {}
  },
}));

/** 替身只做一件事：按**当前主题**画一张图，并把每次渲染用的主题记下来。 */
vi.mock("mermaid", () => ({
  default: {
    initialize() {},
    async render(id: string) {
      const dark = document.documentElement.dataset.theme === "dark";
      ledger.rendered.push(dark ? "dark" : "light");
      return {
        svg: `<svg id="${id}" data-ink="${dark ? "#e6e8eb" : "#24292e"}">图</svg>`,
      };
    },
  },
}));

import { readFileSync } from "node:fs";

import { PreviewPane } from "../src/markdown/preview";
import { renderBlocks } from "../src/markdown/pipeline";
import { rethemePreviews } from "../src/appearance";
import { panels } from "../src/core/app-state";

const CODE = "```ts\nconst a = 1;\n```\n";
const MMD = "```mermaid\ngraph TD;A-->B;\n```\n";

/**
 * 等增强阶段落定。真 shiki 要拉 wasm + 语法 + 主题，全量并行跑时 40 个宏任务不够
 * （实测单跑绿、全量红），所以一律**按条件**等，不按拍数等。
 */
async function until(fn: () => boolean, ms = 15000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function mk(): PreviewPane {
  const p = new PreviewPane();
  document.body.append(p.root);
  return p;
}

describe("预览配色随主题（B321）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeFamily = "2026";
    ledger.rendered.length = 0;
  });

  it("Shiki 产物不许把任何一种颜色写成内联样式（否则 CSS 的主题切换全被盖掉）", async () => {
    const p = mk();
    p.setBlocks(renderBlocks(CODE)); // 走真实增强阶段（真 shiki）
    expect(
      await until(() => !!p.root.querySelector("pre.shiki")),
      "代码块没被高亮出来，这条判据就是空转",
    ).toBe(true);
    const pre = p.root.querySelector("pre.shiki");
    const style = pre!.getAttribute("style") ?? "";
    expect(style, `pre 带了内联底色：${style}`).not.toContain("background-color");
    for (const span of Array.from(pre!.querySelectorAll("span[style]"))) {
      expect(span.getAttribute("style"), "span 带了内联 color").not.toMatch(/(^|;)color:/);
    }
    // 变量必须齐两档，CSS 才有得切
    expect(style).toContain("--shiki-light");
    expect(style).toContain("--shiki-dark");
  });

  it("B377：切主题族后 retheme() 用新族重画代码块（Shiki 只在渲染那一刻取色）", async () => {
    const p = mk();
    p.setBlocks(renderBlocks(CODE));
    expect(await until(() => !!p.root.querySelector("pre.shiki")), "首绘没落地").toBe(true);
    const first = p.root.querySelector("pre.shiki")!;
    expect(first.outerHTML, "首绘应是 2026 的关键字色").toContain("#FF7B72");

    document.documentElement.dataset.themeFamily = "hc";
    p.retheme();
    expect(
      await until(() => {
        const pre = p.root.querySelector("pre.shiki");
        return !!pre && pre !== first && pre.outerHTML.includes("#569CD6");
      }),
      "切族后必须换成高对比度的关键字色（#569CD6）",
    ).toBe(true);
  });

  it("retheme() 之后 mermaid 按新主题重画", async () => {
    const p = mk();
    p.setBlocks(renderBlocks(MMD));
    expect(await until(() => ledger.rendered.length === 1), "首绘必须按当前主题（dark）").toBe(
      true,
    );
    expect(p.root.querySelector("svg")?.getAttribute("data-ink")).toBe("#e6e8eb");

    document.documentElement.dataset.theme = "light";
    p.retheme();
    expect(await until(() => ledger.rendered.length === 2), "换主题后必须再画一发").toBe(true);
    expect(ledger.rendered).toEqual(["dark", "light"]);
    expect(p.root.querySelector("svg")?.getAttribute("data-ink"), "图应换成亮色配色").toBe(
      "#24292e",
    );
  });

  it("retheme() 不许动没有 mermaid 的岛（图片/公式/高亮不该被重跑）", async () => {
    const p = mk();
    p.setBlocks(renderBlocks("正文一段\n\n" + MMD));
    expect(await until(() => ledger.rendered.length === 1), "首绘没落地").toBe(true);
    const [textIsland, mmdIsland] = Array.from(p.root.querySelectorAll(".md-block"));
    expect(mmdIsland.querySelector(".md-mermaid"), "样例里 mermaid 得是第二块").toBeTruthy();
    const marker = document.createElement("span");
    marker.dataset.marker = "1";
    textIsland!.append(marker);
    ledger.rendered.length = 0;

    document.documentElement.dataset.theme = "dark";
    p.retheme();
    expect(await until(() => ledger.rendered.length === 1), "retheme 之后要重画一发").toBe(true);
    expect(ledger.rendered).toEqual(["dark"]);
    expect(marker.isConnected, "没有 mermaid 的岛被重画了").toBe(true);
  });
});

describe("换主题那一发确实叫到了每一格（接线，不是只挂了函数）", () => {
  it("rethemePreviews 叫到每一格有预览的面板，跳过没有预览的", () => {
    const spyA = vi.fn();
    const spyB = vi.fn();
    panels.clear();
    panels.set(1, { panelId: 1, preview: { retheme: spyA } } as never);
    panels.set(2, { panelId: 2, preview: null } as never);
    panels.set(3, { panelId: 3, preview: { retheme: spyB } } as never);
    rethemePreviews();
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    panels.clear();
  });

  // 「登记了 ≠ 挂上了」那条教训（B314-8）：setter 存在不代表主题翻转时会叫它。
  it("prefs 的档位翻转里必须真的叫一发 rethemePreviews", () => {
    const src = readFileSync("src/prefs.ts", "utf-8");
    const body = src.slice(src.indexOf("async function setThemeMode"));
    expect(body.slice(0, 1200)).toContain("rethemePreviews()");
    expect(body.slice(0, 1200)).toContain("applyDarkToTabs(dark, themeFamily)");
    // B377：切主题族也要重画（Shiki / mermaid 只在渲染那一刻取色）
    const familyBody = src.slice(src.indexOf("async function setThemeFamily"));
    expect(familyBody.slice(0, 900)).toContain("rethemePreviews()");
    expect(familyBody.slice(0, 900)).toContain("applyDarkToTabs(dark, family)");
  });
});
