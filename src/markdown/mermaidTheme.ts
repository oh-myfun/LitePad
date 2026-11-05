// B451 · mermaid 图表配色 = 应用主题 token 的派生（Vditor 成熟方案的同构移植）。
//
// 之前 `enhance.ts` 只给 mermaid 一句 `theme: dark ? "dark" : "default"` —— mermaid 自带
// 调色板（紫节点、亮黄便签、刺眼的甘特红）与 LitePad 的 10 个主题族毫无关系，三种常用图
// 都不好看。成熟方案（Vditor `mermaidTheme.ts` / VS Code 预览那一派）：`theme: "base"` +
// `themeVariables` 从宿主 CSS 变量算出来 ⇒ 图表永远跟主题走，也不引入第二份色表
// （B377 红线：预览与源码共用同一颗 token，不许有第二份）。
//
// 拆两层：`resolvePalette`（DOM 侧，读 token，jsdom 落兜底）/ `buildMermaidConfig`
// （纯函数，拼配置）。分类型填色用 Seti 调色板（B367 进册的那批 token，两档共用）。

import type { MermaidConfig } from "mermaid";

export interface MermaidPalette {
  bg: string;
  panel: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  blue: string;
  green: string;
  yellow: string;
  orange: string;
  red: string;
  purple: string;
}

/** 2026 浅色档（styles/global.css 的默认族）：jsdom 不解析 CSS 变量时的兜底。 */
const FALLBACK: MermaidPalette = {
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

function parseRgb(color: string): [number, number, number] {
  const value = color.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as [number, number, number];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ] as [number, number, number];
  }
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

const toHex = (rgb: number[]): string =>
  "#" +
  rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

/** 线性插值两色：`pct` 是 b 的占比（0 = a，1 = b）。 */
export function mixColors(a: string, b: string, pct: number): string {
  const A = parseRgb(a);
  const B = parseRgb(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * pct));
}

export const isDarkColor = (color: string): boolean => {
  const [r, g, b] = parseRgb(color);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
};

/** 压在某色块上的文字用反色（便签、任务条内文字）。 */
const onColor = (bg: string): string => (isDarkColor(bg) ? "#ffffff" : "#1f2020");

/** 值必须像颜色：`var()` / `color-mix()` 这类没换成具体色的 token 一律当缺失走兜底。 */
function isUsableColor(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && !/^(?:var\(|color-mix\()/i.test(v);
}

/**
 * 从装饰面 / 渲染根上把这一档主题的图表调色板读出来。
 *
 * 自定义属性的计算值在 Chromium 里已把 `var()` 链换成具体色（`--md-panel-bg: var(--code-bg)`
 * 读到的就是 `#eaeaea`），所以直接按名取；读不到（jsdom / 没挂上主题）整表落 2026 浅色兜底。
 *
 * ⚠️ 组件那一臂（CM6 widget）传进来的根常常**还没挂进文档**：`toDOM()` 返回后 CM6 才 append，
 * 而取色就在返回前。游离节点读不到任何继承来的自定义属性 ⇒ 整表落兜底，画出来的是色表里的
 * 假色（B452-2 真机抓到：脑图分支色是 `#cc3e44` 而不是主题里的 `#b8383d`）。
 * ⇒ 游离时退到 `documentElement`，并且每颗 `--md-*` 都带上它的源 token 作第二选择。
 */
export function resolvePalette(root: HTMLElement): MermaidPalette {
  const target = root.isConnected ? root : (root.ownerDocument?.documentElement ?? root);
  const cs = getComputedStyle(target);
  const read = (...names: string[]): string => {
    for (const name of names) {
      const value = cs.getPropertyValue(name).trim();
      if (isUsableColor(value)) return value;
    }
    return "";
  };
  const pick = (names: string[], fb: string): string => {
    const value = read(...names);
    return value || fb;
  };
  return {
    bg: pick(["--md-bg", "--bg"], FALLBACK.bg),
    panel: pick(["--md-panel-bg", "--code-bg"], FALLBACK.panel),
    border: pick(["--md-panel-border", "--border"], FALLBACK.border),
    fg: pick(["--md-fg", "--editor-fg"], FALLBACK.fg),
    muted: pick(["--md-muted", "--fg-muted"], FALLBACK.muted),
    accent: pick(["--md-accent", "--accent"], FALLBACK.accent),
    blue: pick(["--seti-blue"], FALLBACK.blue),
    green: pick(["--seti-green"], FALLBACK.green),
    yellow: pick(["--seti-yellow"], FALLBACK.yellow),
    orange: pick(["--seti-orange"], FALLBACK.orange),
    red: pick(["--seti-red"], FALLBACK.red),
    purple: pick(["--seti-purple"], FALLBACK.purple),
  };
}

const FONT_STACK = '"Noto Sans SC", "Microsoft YaHei UI", sans-serif';

/**
 * 图表的三档共用口径（B451 定 mermaid，B452 的脑图 / Graphviz / Flowchart 都吃这一份）：
 * 画布、节点淡染、描边、结构线。各图种自己算一遍 = 迟早会算出四种深浅。
 */
export interface ChartTiers {
  /** 图表卡片那一格（`preview.css` 的 `.md-diagram { background: var(--md-panel-bg) }`）。 */
  canvas: string;
  /** 节点底：在画布上压一层强调色。整片灰 = 「没有彩色」，再高就成了 mermaid 自带那种色块。 */
  nodeTint: string;
  /** 描边：强调色压深 ⇒ 线条清楚、不刺眼。 */
  line: string;
  /**
   * 结构线（甘特网格、时序生命线）比描边轻一档，但**不能贴画布**：取 --md-panel-border
   * （#e5e5e5）与画布 #eaeaea 只差 5，等于没画（B451-2 用户点名）。基准用正文墨、不用
   * muted：muted 在 light hc 族里等于 fg、在暗档里只差几十，拿它当基准同一档会随族忽深忽浅
   * （暗档实测只有 57，仍然糊）。画布上压一半墨 ⇒ 十档变体都拉开 66～108。
   */
  lineFaint: string;
}

export function chartTiers(palette: MermaidPalette): ChartTiers {
  const canvas = palette.panel;
  return {
    canvas,
    nodeTint: mixColors(canvas, palette.accent, 0.12),
    line: mixColors(palette.accent, palette.fg, 0.35),
    lineFaint: mixColors(canvas, palette.fg, 0.5),
  };
}

/**
 * 系列色（脑图的分枝、ECharts 的 series）：一套六色，全从同一颗调色板轮出来。
 * B377 红线 —— 图种的彩色只许有这一处定义。
 */
export function seriesPalette(palette: MermaidPalette): string[] {
  return [palette.blue, palette.green, palette.yellow, palette.orange, palette.red, palette.purple];
}

/** 三种常用图 + 通用件的完整 mermaid 配置：配色全从调色板派生，布局参数照 Vditor 起步再校。 */
export function buildMermaidConfig(palette: MermaidPalette): MermaidConfig {
  const t = palette;
  // 画布 = 图表卡片那一格：边标签的底必须与它同色 —— 给成正文底色会在灰卡片上挂一块白
  // （B451 真机照出来的）。
  const { canvas, nodeTint, line, lineFaint } = chartTiers(t);
  const noteBg = mixColors(t.yellow, canvas, 0.55);
  const clusterBkg = mixColors(canvas, t.accent, 0.05);
  const onAccent = onColor(t.accent);

  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: FONT_STACK,
    themeVariables: {
      darkMode: isDarkColor(t.bg),
      background: canvas,
      fontFamily: FONT_STACK,
      fontSize: "14px",
      // —— 通用（节点 = 淡染底 + 强调色描边；连线保持中性，不让图变成一团彩线）——
      primaryColor: nodeTint,
      primaryTextColor: t.fg,
      primaryBorderColor: line,
      secondaryColor: t.blue,
      secondaryTextColor: onColor(t.blue),
      secondaryBorderColor: line,
      tertiaryColor: mixColors(t.purple, canvas, 0.35),
      tertiaryTextColor: t.fg,
      tertiaryBorderColor: line,
      textColor: t.fg,
      lineColor: t.muted,
      gridColor: lineFaint,
      // base 主题自带一层灰糊影（`drop-shadow( 1px 2px 2px rgba(185,185,185,1))`），时序图
      // 的背景矩形、状态图、思维导图都读这一颗 ⇒ 从源头关掉（用户点名「清晰的线条，不带阴影」）。
      dropShadow: "none",
      mainBkg: nodeTint,
      nodeBkg: nodeTint,
      nodeBorder: line,
      clusterBkg,
      clusterBorder: line,
      clusterTextColor: t.muted,
      titleColor: t.fg,
      edgeLabelBackground: canvas,
      labelBackground: canvas,
      labelColor: t.fg,
      // —— 流程 ——
      defaultLinkColor: t.muted,
      // —— 时序 ——
      actorBkg: nodeTint,
      actorBorder: line,
      actorTextColor: t.fg,
      actorLineColor: lineFaint,
      signalColor: t.muted,
      signalTextColor: t.fg,
      labelBoxBkgColor: nodeTint,
      labelBoxBorderColor: line,
      labelTextColor: t.fg,
      loopTextColor: t.muted,
      noteBkgColor: noteBg,
      noteTextColor: onColor(noteBg),
      noteBorderColor: mixColors(t.yellow, canvas, 0.3),
      activationBkgColor: mixColors(t.accent, canvas, 0.25),
      activationBorderColor: line,
      sequenceNumberColor: onAccent,
      // —— 甘特 ——
      sectionBkgColor: mixColors(canvas, t.bg, 0.55),
      sectionBkgColor2: canvas,
      altSectionBkgColor: canvas,
      sectionBkgColor3: mixColors(canvas, t.bg, 0.75),
      taskBkgColor: t.blue,
      taskBorderColor: line,
      taskTextColor: onColor(t.blue),
      taskTextOutsideColor: t.fg,
      taskTextDarkColor: onColor(t.blue),
      taskTextLightColor: onColor(t.blue),
      taskTextClickableColor: t.accent,
      activeTaskBkgColor: t.accent,
      activeTaskBorderColor: line,
      doneTaskBkgColor: mixColors(t.muted, canvas, 0.55),
      // 已完成条的描边跟其它任务条同一档（line）：它是「条的轮廓」，不是背景网格线。
      // 结构线那一档是拿来画网格的，贴在自己的灰填充上照样糊。
      doneTaskBorderColor: line,
      critBkgColor: t.red,
      critBorderColor: line,
      todayLineColor: t.red,
      // —— 分类型填色（饼图 / 类图等）：Seti 调色板 ——
      fillType0: canvas,
      fillType1: t.blue,
      fillType2: t.green,
      fillType3: t.yellow,
      fillType4: t.orange,
      fillType5: t.red,
      fillType6: t.purple,
      fillType7: mixColors(t.blue, canvas, 0.4),
      pie1: t.blue,
      pie2: t.green,
      pie3: t.yellow,
      pie4: t.orange,
      pie5: t.red,
      pie6: t.purple,
      pieTitleTextSize: "14px",
      pieTitleTextColor: t.fg,
      pieSectionTextColor: onColor(t.blue),
      pieStrokeColor: line,
      errorBkgColor: t.red,
      errorTextColor: onColor(t.red),
    },
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true,
      // B457-6 · 换布局器：默认的 dagre 臂按「rank」把子图一层层往下摞，样例文档那张
      // （`graph TB` + one/two/three 三块）量到 484×522、三块里两块上下排布、回边 6 个拐点；
      // `layered` 臂同一张给出 950×254、三块并排、拐点 0 —— 与 Vditor（mermaid 11 的 dagre）同形。
      // 所以这不是 11/12 的版本差，不必为此降依赖。
      // ⚠️ `layered` 走的是 mermaid 自带那颗 ELK 分片（`layout` 注册表里 `{name:'layered'}` 由
      // elk 那一支 map 出来），第一次画流程图时会懒加载 ~1.4MB 的 `elk-*.js` —— 分片本来就在构建
      // 产物里，只是从前没人取。另两把键实测无效：`flowchart.defaultRenderer` 与 `layout:'elk'`
      // 出来的几何与不写一模一样（配了没生效的哑配置）。
      // 键位写在 `flowchart` 这一族，不写全局那颗 `layout`：全局那颗会连着把状态图（382→332）
      // 和类图（286→296）的排布也换掉，而用户点名的只有流程图。
      layout: "layered",
      // `basis` = 折角处走弧线：默认 `linear` 在回边（B→A 那种）上会硬拐两个直角
      // ⚠️ 这三颗（curve / padding / nodeSpacing / rankSpacing）只在换了布局器之后才吃：
      // 旧的 dagre 臂上把它们从 42/48 改成 200/200，几何逐字节没变（实测 484×522 → 484×522）。
      curve: "basis",
      padding: 14,
      nodeSpacing: 42,
      rankSpacing: 48,
    },
    sequence: {
      useMaxWidth: true,
      boxMargin: 8,
      noteMargin: 8,
      messageMargin: 32,
      diagramMarginX: 10,
      diagramMarginY: 10,
      // 底部不再镜像一遍参与者：长图里那一份纯属重复，滚到底还得多看一屏
      mirrorActors: false,
      width: 140,
      actorMargin: 60,
    },
    gantt: {
      useMaxWidth: true,
      barHeight: 20,
      barGap: 6,
      topPadding: 48,
      leftPadding: 90,
      rightPadding: 14,
      gridLineStartPadding: 30,
      fontSize: 12,
      sectionFontSize: 12,
      numberSectionStyles: 2,
    },
    themeCSS: `
      /* 线条档：mermaid 的糊影有两处来源 —— themeVariables.dropShadow（上面已关）
         和直接写在元素上的 filter 属性 / 内联样式 ⇒ 这发要 !important 才压得住。
         图形组（.node / .edgePath）自己也可能是宿主，选择器连它一起列。 */
      .node, .node rect, .node polygon, .node circle, .node ellipse, .node path,
      .edgePath, .edgeLabel, .actor, .actor-line, .note, rect.rect, rect.labelBox,
      .loopLine, .cluster, .cluster rect, .task, .taskText {
        filter: none !important;
      }
      .node rect, .node polygon, .node circle, .node ellipse,
      .actor, .note, .cluster rect { stroke-width: 1.2px; }
      .flowchart-link, .edgePath .path, .messageLine0, .messageLine1 { stroke-width: 1.2px; }
      .edgeLabel rect, .edgeLabel foreignObject div { background-color: ${canvas} !important; }
      .edgeLabel foreignObject div span { padding: 1px 4px; }
      .actor { font-weight: 600; }
      .messageText, .loopText, .noteText { font-size: 13px; }
      .grid .tick line, .grid path { stroke: ${lineFaint}; }
      .taskText, .sectionTitle { font-size: 12px; }
      .node .label, .cluster .label { font-size: 13px; }
    `,
  };
}
