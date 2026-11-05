// B452 · 图种注册表：围栏语言 → 图种 → 渲染器（各自懒 import）。
//
// 之前只有 ```mermaid 被认成图：`pipeline.ts` 的 fence 规则里写死一颗 `info === "mermaid"`，
// `enhance.ts` 里再写死一发 mermaid。现在收成一处 ⇒ 加一类图 = 在 LANGS 里加一行、在
// RENDERERS 里加一个懒分支，其余（占位、卡片样式、bigDoc 闸、就地编辑、失败留源码）全共用。
//
// ⚠️ mermaid 是这里的住户，不是新客：它的旧类名（`mermaid-src` / `md-mermaid` /
// `md-mermaid-widget` …）被 preview.css 与十几条判据指着，所以通用类名**叠**在旧名前面，
// 不替换。`diagramClass()` 就是为这件事存在的。
//
// 渲染器一律「把结果塞进调用方给的 host」，异步与陈旧判定（`isEnhanceStale`）留给调用方，
// 这样两格同文档时的落位/重画口径与 B319 那条 render id 契约都还是原来那一套。

import { encode as encodePlantuml } from "plantuml-encoder";
import {
  buildMermaidConfig,
  chartTiers,
  isDarkColor,
  mixColors,
  resolvePalette,
  seriesPalette,
  type MermaidPalette,
} from "./mermaidTheme";

export type DiagramKind =
  "mermaid" | "mindmap" | "graphviz" | "flowchart" | "plantuml" | "echarts" | "abc" | "wavedrom";

/** 围栏语言别名：照 vditor / lute 那套写法（puml、dot、flow）。 */
const LANGS: Record<string, DiagramKind> = {
  mermaid: "mermaid",
  mindmap: "mindmap",
  markmap: "mindmap",
  graphviz: "graphviz",
  dot: "graphviz",
  flowchart: "flowchart",
  flow: "flowchart",
  plantuml: "plantuml",
  puml: "plantuml",
  // B455：echarts / 五线谱（ABC 记谱）/ WaveDrom。围栏写法取自用户的样例文档 `docs/zh_CN.md`。
  echarts: "echarts",
  abc: "abc",
  abcjs: "abc",
  wavedrom: "wavedrom",
  wave: "wavedrom",
};

/** 认不出来就不是图（普通代码语言、空 info、`mermaidish` 这种前缀撞车的都不算）。 */
export function diagramKindOf(lang: string): DiagramKind | null {
  return LANGS[(lang ?? "").trim().toLowerCase()] ?? null;
}

/** 通用类名 + mermaid 的历史类名（见文件头 ⚠️）。 */
export function diagramClass(kind: DiagramKind, generic: string, legacy: string): string {
  return kind === "mermaid" ? `${generic} ${legacy}` : generic;
}

/** PlantUML 没有纯 JS 渲染器 ⇒ 编码后交给在线服务器画（用户拍板：vditor 同款）。 */
export const PLANTUML_SERVER_DEFAULT = "https://www.plantuml.com/plantuml";

export function plantumlImageUrl(code: string, server: string = PLANTUML_SERVER_DEFAULT): string {
  // 路径后面**直接**接编码串。`~1` 之类的前缀在 PlantUML 那边是「密文」标记，服务器会换一套
  // 解码器，回来的是它自己的错误图（不是画不出的图，是一张写着错误的图）。
  return `${server.replace(/\/+$/, "")}/svg/${encodePlantuml(code.trim())}`;
}

/**
 * Graphviz 的 dot 默认按「白纸黑字」画：白纸压在灰卡片上是一块白板，黑字在暗档等于没字。
 * 只换这三颗**没被作者显式改过的默认值**（dot 输出里它们就是 `white` / `black` 两个字面量，
 * 作者写了 `color=red` 之类的是 `#ff0000`，碰不到）。
 *
 * ⚠️ 标签那一颗另有落点：dot 只在**非默认**颜色上写属性，正文黑是 SVG 的初始值 ⇒
 * `<text>` 上根本没有 `fill`，字符串替换没有靶子。CSS 补一条会把作者显式写的 fontcolor
 * 一起盖掉（CSS 永远赢过属性），所以只能给「没写 fill 的 text」补一颗主题墨色。
 */
export function retintGraphviz(svg: string, t: MermaidPalette): string {
  return svg
    .replace(/fill="white"/g, `fill="${t.panel}"`)
    .replace(/fill="black"/g, `fill="${t.fg}"`)
    .replace(/stroke="black"/g, `stroke="${t.muted}"`)
    .replace(/<text(?![^>]*\bfill=)/g, `<text fill="${t.fg}"`);
}

export interface DiagramContext {
  /** 这一发渲染发生在哪个面上：取色（`resolvePalette`）与陈旧判定都以它为根。 */
  root: HTMLElement;
  plantumlServer?: string;
}

type DiagramRenderer = (host: HTMLElement, code: string, ctx: DiagramContext) => Promise<void>;

/**
 * mermaid 的 render id 计数器是**模块级**（整个窗口唯一），不是每格 / 每块各自一份：
 * `mermaid.render(id, …)` 进 body 的第一件事就是 `document.getElementById(id)?.remove()`，
 * 同一份 md 开两个渲染面时 id 撞车会把别格刚插进 DOM 的 SVG 删掉（B319 真机抓到）。
 */
let renderUid = 0;

const SVG_NS = "http://www.w3.org/2000/svg";

/** 等 DOM 进文档的上限：过了就在 body 上照样画，图不能永远空着。 */
const LAYOUT_WAIT_MS = 250;

/**
 * 量尺寸要靠真实布局的那一类图（flowchart.js 用 raphael 的 `getBBox()` 量每个节点上的字）
 * 的临时测量格。
 *
 * 预览臂在 CM6 `toDOM()` 里就发起渲染，那一刻整块 widget DOM 还在文档外 —— 而脱离文档的
 * 节点 `getBBox()` 一律给 0×0，于是节点全塌成内边距那么宽（真机量到 56px）。所以先等它
 * 进文档，再画在一格**不占位**（`.md-diagram-measure` 走绝对定位）的挂载点上；画完把
 * 成品 SVG 挪进 host，测量格当场撤掉。
 */
async function measuringMount(root: HTMLElement): Promise<HTMLElement> {
  const deadline = Date.now() + LAYOUT_WAIT_MS;
  while (!root.isConnected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  const mount = document.createElement("div");
  mount.className = "md-diagram-measure";
  mount.setAttribute("aria-hidden", "true");
  (root.isConnected ? root : document.body).append(mount);
  return mount;
}

/**
 * 每一格（`ctx.root`，即那一块 `.md-diagram-inner`）当前活着的那一发 Markmap 的释放口。
 * B454 把编辑改成实时重画之后，不释放就等于每 400ms 漏一颗 ResizeObserver。
 */
const liveMarkmaps = new WeakMap<HTMLElement, () => void>();

/**
 * 卡片（`.md-diagram`）的左右内边距：preview.css 写的是 20px，而 echarts 这类「按容器尺寸排版」的
 * 图要把这两道扣掉才知道自己能画多宽。两处各写各的迟早会出现「改了 CSS，图还按老宽度画」⇒
 * 判据同时盯着 CSS 的那条 padding 与这颗常量。
 */
const CARD_PADDING_X = 20;
/**
 * 谱表左右各留的那一档白（五线谱专用，见 `abc` 那一臂）：abcjs 用它排 SVG 总宽与墨迹的位置，
 * 两边都不能少 —— 少了右边就被裁，留着不扣就被卡片切。
 */
const ABC_INK_MARGIN = 15;
/** 量不到宽度时的兜底：宁可画宽一点再由 `max-width: 100%` 缩回来，也不能画成 0 宽（整块空白）。 */
const CARD_MIN_WIDTH = 320;
/** 图表卡片的高度：echarts 要显式尺寸，而这一格没有「内容高」可量（SVG 由它自己画）。 */
const ECHARTS_HEIGHT = 360;

/**
 * 卡片内容那一格的可用宽度（扣掉上面那道内边距）。
 *
 * `ctx.root` 在动笔这一刻多半还在文档外 —— enhance 是「先画进 host，画成了才 `replaceWith` 顶掉
 * 源码占位」。所以顺着 parentElement 找最近一颗真在文档上的祖先去量；量不到就吃兜底档。
 * （同一颗坑 B452-4 的 flowchart 也踩过：脱离文档量尺寸 = 全 0。）
 */
export function cardContentWidth(root: HTMLElement): number {
  let node: HTMLElement | null = root;
  while (node && !node.isConnected) node = node.parentElement;
  return Math.max((node?.clientWidth ?? 0) - CARD_PADDING_X * 2, CARD_MIN_WIDTH);
}

/** echarts 要的是显式像素尺寸：宽度按卡片那一格，高度这一格没得量 ⇒ 定一档。 */
function echartsSize(root: HTMLElement): { width: number; height: number } {
  return { width: cardContentWidth(root), height: ECHARTS_HEIGHT };
}

/**
 * 围栏里那一段是「JS 对象字面量」，不是严格 JSON —— ECharts 的 option 与 WaveDrom 的 WaveJSON
 * 惯例都写裸键名、单引号、尾逗号（用户的样例文档就是 `{ signal: [ { name: "clk", … } ] }`）。
 * JSON5 正是这套写法的规范解析器（wavedrom 自己也依赖它）；少了外层花括号的裸 body 再补一次试。
 */
async function parseObjectLiteral(code: string, kind: string): Promise<Record<string, unknown>> {
  const JSON5 = (await import("json5")).default;
  const text = code.trim();
  for (const candidate of [text, `{${text}}`]) {
    try {
      const value: unknown = JSON5.parse(candidate);
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // 换下一形；两形都不行才报错（报错 ⇒ 调用方退回源码块，与画失败同一口径）
    }
  }
  throw new Error(`${kind} 的围栏内容不是合法的对象写法`);
}

/** 每一格当前活着的那一发 ECharts 实例：编辑档实时重画之前先 dispose，不然每停一下漏一颗。 */
const liveCharts = new WeakMap<HTMLElement, { dispose(): void }>();

/**
 * WaveDrom 的皮肤把一整张 CSS 装在 svg 里那颗 `<style>` 上，而内联 SVG 的 `<style>` 作用于
 * **整个文档**（`.h1{font-size:33pt}`、`.muted{fill:#aaa}`、`.s1…`），且每块波形都**重抄一遍**
 * 它自己那两百多颗写死的 id（`pclk`、`socket`…，`<use xlink:href="#pclk">` 按整篇文档解析）。
 *
 * 收口办法是**每发波形关进自己的 shadow root**：皮肤 style 与那批 id 都只活在那棵树里。
 *
 * ⚠️ 别改回「给皮肤选择器加祖先前缀」那一形 —— B455-7 真机抓过：加前缀之后 defs 里的**原件**
 * 照样命中（`getComputedStyle` 量得到 `fill:none`），但画出来的是 `<use>` 的**克隆体**，
 * 它在 use 自己的 shadow 树里，文档选择器跨不过那道树边界 ⇒ 时钟行变成一排实心黑三角。
 */
/**
 * 八档数据格各自的色相（WaveJSON 的 `2`–`9`，即皮肤的 `.s7`–`.s14`）。
 *
 * 逐档对上皮肤原有的色相（黄 / 橙 / 蓝 / 青 / 绿 / 品红 / 红），换档时同一格波形不会「3 一会儿黄
 * 一会儿绿」。皮肤那八颗是为白纸调的粉彩，暗档要的是同一族色相的压深版，所以这里只给**色相**，
 * 深浅由 `wavedromInk` 按卡片那一格算。调色板没有青 ⇒ `6` 落在蓝绿之间轮一发。
 */
function dataStateHues(t: MermaidPalette): string[] {
  return [
    // `2` 皮肤给的是纯白：暗档不再占一格「无彩色」，直接吃应用自己的强调色。
    t.accent,
    t.yellow,
    t.orange,
    t.blue,
    mixColors(t.blue, t.green, 0.5),
    t.green,
    t.purple,
    t.red,
  ];
}

/** 暗档把数据色往卡片那一格压多深：再浅就是用户报的「泛白」，再深就跟卡片分不开了。 */
const DATA_STATE_DARKEN = 0.45;

/**
 * 波形取色覆盖（每一发画完挂在皮肤那张 `<style>` **之后**：同特异度后者胜）。
 *
 * 暗档必须动八档数据格的填充：皮肤那八颗（#fff、#ffffb4、#ffe0b9、#b9e0ff、#ccfdfe、#cdfdc5、
 * #f0c1fb、#f5c2c0）贴在深色卡片上就是一块「泛白」，而皮肤的 `text{}` 不带 fill ⇒ 格里的数据标签
 * 吃我们的 `--md-fg`（暗档近白）⇒ 浅字压浅底，两头一起糊（B457-4 用户点名）。压深到中线以下之后，
 * 近白的标签才落得上去。同一道理还有皮肤里那两颗写死的黑 / 白：`gap`（#fff，白纸上等于隐形）与
 * `P`/`N` 时钟标记（#000，暗档等于看不见）。
 */
function wavedromInk(t: MermaidPalette): string {
  const dark = isDarkColor(t.panel);
  const states = dark
    ? dataStateHues(t)
        .map((hue, i) => `.s${7 + i}{fill:${mixColors(hue, t.panel, DATA_STATE_DARKEN)}}`)
        .join("") + `.s5{fill:${t.panel}}.s6{fill:var(--md-fg)}`
    : "";
  return `
svg{max-width:100%;height:auto}
text{fill:var(--md-fg)}
.muted{fill:var(--md-muted)}
.s1,.s2,.s3,.s4{stroke:var(--md-fg)}
/* 信号名那一格带的就是这颗类（B455-7 真机量的），皮肤给的是写死的 #0041c4 ⇒ 暗档等于没字。
   .warning / .error / .success 是作者在 WaveJSON 里点名的状态色，留着不动。 */
.info{fill:var(--md-accent)}
${states}
`;
}

const RENDERERS: Partial<Record<DiagramKind, DiagramRenderer>> = {
  mermaid: async (host, code, ctx) => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize(buildMermaidConfig(resolvePalette(ctx.root)));
    const { svg } = await mermaid.render(`mmd-${++renderUid}`, code);
    host.innerHTML = svg;
  },

  // 脑图 = markdown 列表（```mindmap 里就是普通 `- 项目` 那套），markmap-lib 解析、markmap-view 画。
  mindmap: async (host, code, ctx) => {
    const t = resolvePalette(ctx.root);
    const { Transformer } = await import("markmap-lib");
    const { Markmap } = await import("markmap-view");
    const { root } = new Transformer().transform(code.trim());
    const svg = document.createElementNS(SVG_NS, "svg");
    host.append(svg);
    // 文字 / 圆点 / 代码底走 CSS（preview.css 的 `.md-diagram--mindmap .markmap`）：markmap 自己
    // 注入的那一档会盖掉挂在宿主上的自定义属性，只有同级选择器压得住。分支色是函数选项，
    // 只能在这里从同一颗调色板轮出来（B377 红线：不许有第二份色表 ⇒ 表在 `seriesPalette`）。
    const branch = seriesPalette(t);
    // B454：编辑档改成实时重画 ⇒ 同一格每 400ms 换一个 Markmap，而每一发都自带一颗
    // ResizeObserver（观察它自己那些 foreignObject）。上一发不释放就是「每停一下打字漏一个」。
    liveMarkmaps.get(ctx.root)?.();
    const mm = Markmap.create(
      svg,
      {
        color: (node) => branch[node.state.depth % branch.length],
        duration: 0,
        initialExpandLevel: -1,
        spacingHorizontal: 70,
        spacingVertical: 8,
        paddingX: 8,
        fitRatio: 0.92,
      },
      root,
    );
    // B453：d3-zoom 不接管 extent 时，默认那颗去读 `svg.width.baseVal.value`。这块 DOM 是 CM6 的
    // widget，画完到 `fit()` 落地之间随时可能不在文档上（enhance 半路放弃 / 滚动重画摘掉旧层），
    // 而 Chromium 对「量不出的相对长度」直接抛 NotSupportedError: Could not resolve relative length
    // —— 真机日志里那条 `boot error` 就是它。`getBoundingClientRect()` 两种状态都量得出来（脱离
    // 文档时是 0，不炸），所以 extent 自己给。
    mm.zoom.extent((): [[number, number], [number, number]] => {
      const { width, height } = svg.getBoundingClientRect();
      return [
        [0, 0],
        [width, height],
      ];
    });
    // B455-6（用户拍板「统一外层变换」）：滚轮缩放与拖拽平移由 `diagramViewport` 一处管八类图，
    // markmap 自己那颗 d3-zoom 要让位 —— 它还在收手势的话，同一发会被缩放两遍（图跳一下），
    // 而且右上角那三颗键管不住它。filter 一律拒收只挡**用户事件**，程序化的 `fit()` 照旧能用。
    mm.zoom.filter(() => false);
    liveMarkmaps.set(ctx.root, () => mm.destroy());
  },

  // Graphviz = wasm 版 dot（自带 wasm，不联网）。排版全由 dot 算，我们只管换那一层纸墨。
  graphviz: async (host, code, ctx) => {
    const { Graphviz } = await import("@hpcc-js/wasm-graphviz");
    const gv = await Graphviz.load();
    const out = gv.layout(code.trim(), "svg");
    // dot 的 svg 输出前面挂着 `<?xml …?>` / `<!DOCTYPE …>` ⇒ innerHTML 会把它们当垃圾节点，从 `<svg` 起截。
    host.innerHTML = retintGraphviz(out.slice(out.indexOf("<svg")), resolvePalette(ctx.root));
  },

  // Flowchart = flowchart.js 那套 `st=>start:` 语法（**不是** mermaid 的 flowchart），raphael 画。
  // 它没有主题系统 ⇒ 三档口径直接从 mermaid 那一套拿（`chartTiers`），别自己再定深浅。
  flowchart: async (host, code, ctx) => {
    const flowchart = (await import("flowchart.js")).default;
    const t = resolvePalette(ctx.root);
    const { nodeTint, line } = chartTiers(t);
    const mount = await measuringMount(ctx.root);
    try {
      flowchart.parse(code.trim()).drawSVG(mount, {
        fill: nodeTint,
        "element-color": line,
        "line-color": t.muted,
        "font-color": t.fg,
        "font-size": 13,
        "line-width": 1.2,
        "text-margin": 6,
        roundness: 6,
      });
      const svg = mount.firstElementChild;
      if (svg) host.append(svg);
    } finally {
      mount.remove();
    }
  },

  // PlantUML 的官方渲染器是 Java 那一个 jar，纯 JS 没有 ⇒ 用户拍板照 vditor：编码后交给在线
  // 服务器画（`<img>` 指向它返回的 SVG）。等 `load` / `error` 落地，不是「扔进去就算画完」：
  // 离线、语法错、服务器挂了都要 reject，让 enhance 保住源码占位 —— 一个碎图图标不如源码有用。
  plantuml: async (host, code, ctx) => {
    const server = ctx.plantumlServer?.trim() || PLANTUML_SERVER_DEFAULT;
    const img = document.createElement("img");
    img.alt = "PlantUML";
    host.append(img);
    await new Promise<void>((resolve, reject) => {
      // ⚠️ 先挂处理器再写 `src`：赋 src 那一刻加载就启动了，快的话（缓存命中）
      // 事件在下一帧就到，晚挂的处理器永远等不到 ⇒ 这一块永远转不完。
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`PlantUML 服务器（${server}）没画出图`));
      img.src = plantumlImageUrl(code, server);
    });
  },

  // ECharts（B455）：用户拍板「全量包打进」⇒ 围栏里写什么 series 都能出，不用维护一张组件裁剪表。
  echarts: async (host, code, ctx) => {
    const option = await parseObjectLiteral(code, "echarts");
    const { init } = await import("echarts");
    const box = document.createElement("div");
    host.append(box);
    liveCharts.get(ctx.root)?.dispose();
    // SVG renderer + 显式尺寸（见 `echartsSize`）：canvas 在暗档糊、导出/打印要矢量；而这一刻
    // 容器多半还在文档外，让 echarts 自己去量就量到 0。
    const chart = init(box, null, { renderer: "svg", ...echartsSize(ctx.root) });
    // 默认档全从 token 派生（B377 红线：系列色与脑图同一颗表）；顶层键整个让位给作者写的，
    // 与 Graphviz 那条「只换没被作者改过的默认值」同一口径。
    const t = resolvePalette(ctx.root);
    // 标题那一颗不吃根 `textStyle`（库里给它写死了一档深灰 ⇒ B455-7 暗档目视几乎看不见）。
    // 只给「对象形」的 title 补色、作者写过的键照旧让位；数组形（多标题）整个不动。
    const authored = option.title as { textStyle?: Record<string, unknown> } | undefined;
    const title =
      authored === undefined ||
      (authored !== null && typeof authored === "object" && !Array.isArray(authored))
        ? { ...authored, textStyle: { color: t.fg, ...authored?.textStyle } }
        : authored;
    chart.setOption({
      backgroundColor: "transparent",
      color: seriesPalette(t),
      textStyle: { color: t.fg },
      ...option,
      title,
    });
    liveCharts.set(ctx.root, chart);
  },

  // 五线谱（B455）= ABC 记谱（`X:1 / T:… / K:Em` 那套文本），abcjs 直接 engrave 成 SVG。
  abc: async (host, code, ctx) => {
    const { renderAbc } = await import("abcjs");
    const box = document.createElement("div");
    // ⚠️ 不能把 host 本格交出去：abcjs 进来第一行就是 `target.innerHTML = ""`，那会把这一格里
    // 别的住户（变换层那颗键、下一次重画的落点）一并抹掉。
    host.append(box);
    renderAbc(box, code, {
      // 墨色从 token 派生：abcjs 默认 `currentColor`，但那是「画的那一刻继承到的色」——
      // 与其余图种同一口径，取现成的那颗 fg，切档重画时一起跟着换。
      foregroundColor: resolvePalette(ctx.root).fg,
      // 谱表按卡片那一格的宽度排，并允许换行：abcjs 默认按 745px 铺一行，窄格里会撑破。
      // `wrap` 要的是那颗参数表（三档间距；abcjs 内部按 `params.wrap.minSpacing` 读，写 `true`
      // 虽然也判真，但把整张表留成 undefined 等于让换行按「无偏好」走）。
      // 不许开 `responsive: 'resize'` —— 那颗是按 `window.innerWidth` 铺的，分屏里会横贯整窗。
      staffwidth: cardContentWidth(ctx.root) - ABC_INK_MARGIN * 2,
      // B457-2 与 B457-5 是同一笔账的两半：abcjs 把这两格加在 `staffwidth` **之外**当成 SVG 的
      // 总宽（浏览器里量到：默认档 `svg.width = staffwidth + 30`），而**墨迹**落在
      // `[paddingleft, paddingleft + staffwidth] 那一段里`（默认档墨迹右沿 998 = 15 + 983）。
      // · 留白照默认给 ⇒ 总宽比卡片那一格宽出 30，被卡片的 `overflow:hidden` 切掉（B457-2）。
      // · 留白归零 ⇒ 总宽不超了，可墨迹右沿跟着顶到 SVG **自己的**右边界：窄格实测
      //   `svg width=547` 而 `getBBox()=549`，越界那 2px 由 SVG 根节点裁掉 ⇒ 右缘被切（B457-5）。
      // 两头都要：留白保留，但从 `staffwidth` 里扣 ⇒ 总宽仍等于格子那一格，墨迹左右各空出一档。
      paddingleft: ABC_INK_MARGIN,
      paddingright: ABC_INK_MARGIN,
      wrap: { preferredMeasuresPerLine: 4, minSpacing: 2, maxSpacing: 12 },
    });
    // abcjs 对不合法的 ABC 不抛异常，只是画不出谱线 ⇒ 空框不如源码有用，与其余图种同一口径退回。
    if (!box.querySelector("svg")) throw new Error("abc 没有画出谱线（检查 ABC 记谱的写法）");
  },

  // WaveDrom（B455）= WaveJSON 那套 `{ signal: [ { name, wave } ] }`，画数字时序波形。库是 CJS，
  // 只用 `renderWaveElement` + 那张皮肤表；`processAll` 那条路不碰（它按 id 满文档找 DOM、
  // 还往 document.head 塞它的右键菜单样式）。
  wavedrom: async (host, code, ctx) => {
    const source = await parseObjectLiteral(code, "wavedrom");
    // 皮肤的三选一入口（波形 / 逻辑式 / 位域），一个都没有就不是波形图 ⇒ 退回源码。
    if (!source.signal && !source.assign && !source.reg) {
      throw new Error("wavedrom 的围栏里没有 signal / assign / reg");
    }
    const wavedrom = (await import("wavedrom")).default;
    // 第一个参会被拼进 DOM id（`waves_<i>` / `lanes_<i>` / `svgcontent_<i>`，皮肤里靠它做引用）
    // ⇒ 每块取唯一那一发（同文档两块波形同时在场时，两份皮肤不会互相指认）。
    const uid = ++renderUid;
    const box = document.createElement("div");
    box.className = "md-wavedrom-box";
    const tree = box.attachShadow({ mode: "open" });
    host.append(box);
    wavedrom.renderWaveElement(uid, source, tree, wavedrom.waveSkin);
    const svg = tree.querySelector("svg");
    if (!svg) throw new Error("wavedrom 没有画出波形");
    const palette = resolvePalette(ctx.root);
    // 白底：皮肤在 `g#waves_<i>` 的第一格铺了一块写死的 `fill:white`（inline style，CSS 压不住）
    // ⇒ 换成卡片那一格的底。svg 的直接子节点是 style / defs / 那一格 g，所以取最后一个子节点。
    const bg = svg.lastElementChild?.querySelector("rect");
    if (bg) bg.setAttribute("style", `stroke:none;fill:${palette.panel}`);
    // 取色覆盖挂在皮肤**之后**：同特异度后者胜，而 `--md-*` 是自定义属性，能穿进 shadow 树。
    const ink = document.createElement("style");
    ink.textContent = wavedromInk(palette);
    tree.append(ink);
  },
};

/** 画一类图：结果塞进 host；未接线 / 画失败一律 reject，由调用方退回源码块。 */
export function renderDiagram(
  kind: DiagramKind,
  host: HTMLElement,
  code: string,
  ctx: DiagramContext,
): Promise<void> {
  const renderer = RENDERERS[kind];
  if (!renderer) return Promise.reject(new Error(`图种 ${kind} 还没有接线`));
  return renderer(host, code, ctx);
}
