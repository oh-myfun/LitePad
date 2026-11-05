// B451 · mermaid 三种图（流程/时序/甘特）的配色与布局从应用主题 token 派生。
//
// 之前的口径是 `theme: dark ? "dark" : "default"` —— mermaid 自带调色板（紫节点、黄便签、
// 刺眼的甘特红）与 LitePad 的 10 个主题族毫无关系，用户点名「借鉴成熟的方案优化」。
// 成熟方案即 Vditor / VS Code 预览那一派：`theme: "base"` + `themeVariables` 从宿主 CSS
// 变量算出来 ⇒ 图表跟主题走，也不需要第二份色表（B377 的红线）。
//
// 拆两层：`resolvePalette`（DOM 侧，读 token）/ `buildMermaidConfig`（纯函数，拼配置）。
// 判据全打在纯函数上 —— jsdom 不解析 CSS 变量，DOM 那层只验证「缺 token 落兜底」。

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMermaidConfig,
  mixColors,
  resolvePalette,
  type MermaidPalette,
} from "../src/markdown/mermaidTheme";

const LIGHT: MermaidPalette = {
  bg: "#ffffff",
  panel: "#eaeaea",
  border: "#e5e5e5",
  fg: "#202020",
  muted: "#606060",
  accent: "#0069cc",
  blue: "#519aba",
  green: "#8dc149",
  yellow: "#cbcb41",
  orange: "#e37933",
  red: "#cc3e44",
  purple: "#a074c4",
};

/** 2026 Dark（`global.css` 的 `:root[data-theme="dark"]`）：暗档画布比浅色深得多，档位另一形。 */
const DARK: MermaidPalette = {
  ...LIGHT,
  bg: "#121314",
  panel: "#242526",
  border: "#2a2b2c",
  fg: "#bbbebf",
  muted: "#8c8c8c",
  accent: "#3994bc",
};

/** 两色的最大单通道差：判「贴不贴得上画布」够用（#e5e5e5 vs #eaeaea = 5）。 */
function rgbDistance(a: string, b: string): number {
  const hex = (c: string) => {
    const h = c.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const [A, B] = [hex(a), hex(b)];
  return Math.max(...A.map((v, i) => Math.abs(v - B[i])));
}

describe("B451 · mixColors", () => {
  it("按比例线性插值（黑到白 0.5 = 中灰）", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("0 与 1 两端就是原色", () => {
    expect(mixColors("#123456", "#abcdef", 0)).toBe("#123456");
    expect(mixColors("#123456", "#abcdef", 1)).toBe("#abcdef");
  });
});

describe("B451 · buildMermaidConfig", () => {
  it("走 base 主题 + 派生 themeVariables（不再用 mermaid 自带的 default/dark 调色板）", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect(cfg.theme).toBe("base");
    expect(cfg.startOnLoad).toBe(false);
    expect(cfg.securityLevel).toBe("strict");
    // 节点底 = 画布（面板色）上淡染一层强调色：既不是 mermaid 的紫，也不是一片死灰
    expect(cfg.themeVariables!.primaryColor).toBe(mixColors(LIGHT.panel, LIGHT.accent, 0.12));
    expect(cfg.themeVariables!.primaryColor).not.toBe(LIGHT.panel);
    expect(cfg.themeVariables!.primaryTextColor).toBe(LIGHT.fg);
    expect(cfg.themeVariables!.actorBkg).toBe(cfg.themeVariables!.primaryColor);
  });

  it("描边同一档（强调色压深），连线保持中性 —— 线条清楚但不刺眼", () => {
    const cfg = buildMermaidConfig(LIGHT);
    const line = mixColors(LIGHT.accent, LIGHT.fg, 0.35);
    for (const key of [
      "primaryBorderColor",
      "nodeBorder",
      "actorBorder",
      "taskBorderColor",
      "critBorderColor",
    ] as const) {
      expect(cfg.themeVariables![key], key).toBe(line);
    }
    expect(cfg.themeVariables!.lineColor).toBe(LIGHT.muted);
    expect(cfg.themeVariables!.defaultLinkColor).toBe(LIGHT.muted);
  });

  it("边标签的底 = 画布色（给成正文底色会在灰卡片上挂一块白）", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect(cfg.themeVariables!.edgeLabelBackground).toBe(LIGHT.panel);
  });

  // 用户复看 B451：甘特网格、时序图生命线、集群框这些**结构线**取了 --md-panel-border
  // （#e5e5e5），画布是 --md-panel-bg（#eaeaea）—— 两个色只差 5，等于没画。
  // 档位基准用「画布上压一半正文墨」，不用 muted：muted 在 light modern 族里等于 fg、
  // 在 dark 族里只差几十 ⇒ 拿它当基准，同一档会在不同族里忽深忽浅。
  it("结构线不许贴着画布：与画布的 RGB 距离要够看得见（先量再定档）", () => {
    for (const pal of [LIGHT, DARK]) {
      const tv = buildMermaidConfig(pal).themeVariables!;
      for (const key of ["gridColor", "actorLineColor"] as const) {
        const d = rgbDistance(String(tv[key]), pal.panel);
        expect(
          d,
          `${pal.panel} 档的 ${key}=${tv[key]} 离画布只有 ${d}，看不见`,
        ).toBeGreaterThanOrEqual(60);
      }
      // 集群是「框」不是「底纹」：跟节点描边同一档（vditor 用 accent 同思路）
      expect(tv.clusterBorder).toBe(mixColors(pal.accent, pal.fg, 0.35));
      // 已完成条的描边也不许和它自己的填充糊在一起（条描边归描边那一档）
      expect(tv.doneTaskBorderColor).toBe(mixColors(pal.accent, pal.fg, 0.35));
    }
  });

  it("themeCSS 的网格线也走同一档（别在 CSS 里偷偷退回 --md-panel-border）", () => {
    const cfg = buildMermaidConfig(LIGHT);
    const faint = mixColors(LIGHT.panel, LIGHT.fg, 0.5);
    expect(cfg.themeCSS).toContain(`stroke: ${faint}`);
    expect(cfg.themeCSS).not.toContain(`stroke: ${LIGHT.border}`);
  });

  it("便签/次级色是从 token 调出来的（不把 Seti 原色整块铺上去）", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect(cfg.themeVariables!.noteBkgColor).toBe(mixColors(LIGHT.yellow, LIGHT.panel, 0.55));
    expect(cfg.themeVariables!.doneTaskBkgColor).toBe(mixColors(LIGHT.muted, LIGHT.panel, 0.55));
  });

  it("甘特任务条用 Seti 调色板，critical 用红、active 用强调色", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect(cfg.themeVariables!.taskBkgColor).toBe(LIGHT.blue);
    expect(cfg.themeVariables!.critBkgColor).toBe(LIGHT.red);
    expect(cfg.themeVariables!.activeTaskBkgColor).toBe(LIGHT.accent);
  });

  it("三种图各有布局参数（宽随容器、间距、字号），themeCSS 去阴影 + 统一线宽", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect(cfg.flowchart!.useMaxWidth).toBe(true);
    expect(cfg.sequence!.useMaxWidth).toBe(true);
    expect(cfg.gantt!.useMaxWidth).toBe(true);
    expect(cfg.gantt!.barHeight).toBeGreaterThan(0);
    expect(cfg.themeCSS).toContain("stroke-width: 1.2px");
    expect(cfg.themeCSS).toContain(LIGHT.panel);
    expect(cfg.themeCSS).toContain(mixColors(LIGHT.panel, LIGHT.fg, 0.5));
  });

  // B457-6 · 流程图布局对标 Vditor：用户点名「样例文档里的 One 和 Three 区块，Vditor 是左右排布，
  // LitePad 是上下排布，而且连线绕出更多曲折」。v12 里这不是版本差而是布局器差（同配置下
  // `layout: 'layered'` 就把三块摆成一排）⇒ 换布局器，不降依赖。
  it("流程图换 layered 布局器：区块并排、回边不绕（.tmp/b457-mermaid-cmp 实测 484×522/拐点6 → 950×254/拐点0）", () => {
    expect(buildMermaidConfig(LIGHT).flowchart!.layout).toBe("layered");
  });

  // `layout` 在 mermaid 的键表里既有全局那颗，也有每族各自那颗（`BaseDiagramConfig.layout`）。
  // 实测全局那颗除了流程图还会挪状态图（382→332）与类图（286→296）⇒ 只许写在 flowchart 这一族。
  it("布局器只写在流程图这一族（全局那颗会连着换状态图/类图的排布）", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect((cfg as { layout?: string }).layout).toBeUndefined();
  });

  it("阴影从源头关掉：base 主题自带 dropShadow（灰边糊影），覆盖成 none", () => {
    const cfg = buildMermaidConfig(LIGHT);
    // mermaid 的 Theme.calculate 把 themeVariables 的键原样盖回去，所以这一发有效；
    // 时序图的 `g rect.rect` / 状态图 / 思维导图都读这一颗。
    expect(cfg.themeVariables!.dropShadow).toBe("none");
  });

  it("themeCSS 再兜一层（!important 才压得住 mermaid 写在元素上的 filter）", () => {
    const cfg = buildMermaidConfig(LIGHT);
    expect(cfg.themeCSS).toContain("filter: none !important");
    // 时序图的背景矩形（rect 段落）那根类名不在 .actor/.note 里，得单独列出
    expect(cfg.themeCSS).toContain("rect.rect");
  });
});

describe("B451 · resolvePalette", () => {
  it("jsdom 不解析 CSS 变量 ⇒ 整表落到 2026 浅色兜底（键一个不少）", () => {
    const pal = resolvePalette(document.body);
    expect(Object.keys(pal).sort()).toEqual(Object.keys(LIGHT).sort());
    expect(pal.bg).toBe("#ffffff");
    expect(pal.accent).toBe("#0069cc");
  });

  // B452-2 真机抓到：组件那一臂把 `inner`（CM6 widget 的 DOM，toDOM 返回后才 append）交给
  // enhance ⇒ 取色时它是游离的，`getComputedStyle` 什么自定义属性都读不到 ⇒ 整表落兜底，
  // 画出来的分支色是色表里的假色，不是主题里的真色。
  it("root 还没挂进文档 ⇒ 退到 documentElement 读源 token（不许整表落兜底）", () => {
    const detached = document.createElement("div"); // 故意不 append
    const set = (k: string, v: string) => document.documentElement.style.setProperty(k, v);
    const names = [
      "--code-bg",
      "--editor-fg",
      "--fg-muted",
      "--accent",
      "--border",
      "--seti-blue",
      "--seti-green",
      "--seti-yellow",
      "--seti-orange",
      "--seti-red",
      "--seti-purple",
    ];
    names.forEach((n, i) => {
      const h = i.toString(16).padStart(2, "0");
      set(n, `#${h}${h}${h}`);
    });
    try {
      const pal = resolvePalette(detached);
      expect(pal.panel, "--md-panel-bg 读不到要退到它的源 token --code-bg").toBe("#000000");
      expect(pal.fg).toBe("#010101");
      expect(pal.muted).toBe("#020202");
      expect(pal.accent).toBe("#030303");
      expect(pal.border).toBe("#040404");
      expect(pal.blue).toBe("#050505");
      expect(pal.purple, "六颗 Seti 一颗都不许落兜底").toBe("#0a0a0a");
    } finally {
      names.forEach((n) => document.documentElement.style.removeProperty(n));
    }
  });

  it("挂在文档里时仍优先吃装饰面那一档的 --md-*（区域 token 可以只改面不改 :root）", () => {
    const face = document.createElement("div");
    face.style.setProperty("--md-panel-bg", "#0f0f0f");
    document.documentElement.style.setProperty("--code-bg", "#f0f0f0");
    face.append(document.createElement("div"));
    document.body.append(face);
    try {
      expect(resolvePalette(face).panel).toBe("#0f0f0f");
    } finally {
      face.remove();
      document.documentElement.style.removeProperty("--code-bg");
    }
  });
});

describe("B451 · 渲染接线契约", () => {
  // B452：mermaid 的渲染从 enhance 搬进图种注册表（`diagrams.ts`），判据跟着换文件读。
  const src = readFileSync("src/markdown/diagrams.ts", "utf-8");

  it("mermaid.initialize 必须经 buildMermaidConfig（配色单一出处）", () => {
    expect(src).toContain("buildMermaidConfig(resolvePalette(");
    expect(
      src.split("buildMermaidConfig(resolvePalette(").length - 1,
      "第二处调用 = 第二份色表（B377 红线）",
    ).toBe(1);
  });

  it("不再按 dataset.theme 挑 mermaid 自带主题", () => {
    for (const f of ["src/markdown/diagrams.ts", "src/markdown/enhance.ts"]) {
      expect(readFileSync(f, "utf-8"), f).not.toMatch(/dataset\.theme[^)]*(?:dark|default)/);
    }
  });
});
