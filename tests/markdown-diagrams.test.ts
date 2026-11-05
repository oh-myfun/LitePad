// @vitest-environment jsdom
// B452 · 四类图（脑图 / Graphviz / Flowchart / PlantUML）跟 mermaid 共用同一条「图种臂」。
//
// 之前只有 ```mermaid 一种围栏会被认成图（pipeline 的 fence 规则里写死一个 `info === "mermaid"`），
// 其余四类落进普通代码块。vditor 那条路是每类一个渲染器 + 各自的懒加载脚本；LitePad 这边
// 收成一颗注册表：`diagramKindOf(语言) → 图种` ⇒ 占位 pre ⇒ `renderDiagram(图种, …)`。
// mermaid 作为第一个住户迁进去，**旧类名 mermaid-src 保留**（样式与既有判据都指着它）。

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mmdLedger = vi.hoisted(() => ({ ids: [] as string[] }));
const mmLedger = vi.hoisted(
  () =>
    ({
      md: "",
      svg: null as unknown,
      opts: null as unknown as Record<string, unknown> | null,
      root: null as unknown,
    }) as {
      md: string;
      svg: unknown;
      opts: Record<string, unknown> | null;
      root: unknown;
    },
);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("mermaid", () => ({
  default: {
    initialize() {},
    async render(id: string, code: string) {
      mmdLedger.ids.push(id);
      // 哨兵：让某一发失败，用来验「渲染炸了不许把源码吞掉」（enhance 那一臂）
      if (code.includes("渲染失败")) throw new Error("mock 渲染失败");
      return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg">图</svg>` };
    },
  },
}));
// 脑图两件套：markmap-lib 负责 parse，markmap-view 负责画（都只在 ```mindmap 出现时才 import）
vi.mock("markmap-lib", () => ({
  Transformer: class {
    transform(md: string) {
      mmLedger.md = md;
      return { root: { content: "教程", children: [] }, features: [] };
    }
  },
}));
// B453：markmap 内部用 d3-zoom，它默认的 extent 去读 `svg.width.baseVal.value`。
// 记一下我们有没有把那颗 extent 换掉（换掉才量得出脱离文档的格子）。
// B455-6：同一颗 zoom 还得让位给统一变换层 ⇒ 顺手记一下 filter 有没有接管。
const mmZoom = vi.hoisted(() => ({
  extentFn: null as null | ((node: unknown) => [[number, number], [number, number]]),
  filterFn: null as null | ((node: unknown, event: unknown) => boolean),
}));
// B454：编辑改成实时重画 ⇒ 同一格每 400ms 就换一个 Markmap。上一发不 destroy 就是每停一下
// 打字漏一颗 ResizeObserver，所以数一下 destroy 被叫了几回。
const mmDispose = vi.hoisted(() => ({ calls: 0 }));
vi.mock("markmap-view", () => ({
  Markmap: {
    create(svg: unknown, opts: Record<string, unknown>, root: unknown) {
      mmLedger.svg = svg;
      mmLedger.opts = opts;
      mmLedger.root = root;
      return {
        fit() {},
        setData() {},
        destroy() {
          mmDispose.calls++;
        },
        zoom: {
          extent(fn: (node: unknown) => [[number, number], [number, number]]) {
            mmZoom.extentFn = fn;
            return this;
          },
          filter(fn: (node: unknown, event: unknown) => boolean) {
            mmZoom.filterFn = fn;
            return this;
          },
        },
      };
    },
  },
}));
vi.mock("shiki", () => ({ codeToHtml: async () => "<pre>高亮</pre>" }));
// Flowchart = flowchart.js（内部 require raphael，画进容器）。CJS ⇒ mock 给 default。
const fcLedger = vi.hoisted(() => ({
  code: "",
  opts: null as unknown as Record<string, unknown>,
  container: null as unknown as HTMLElement,
  /** 动笔那一刻容器在不在文档里：raphael 的 `getBBox()` 只对进了文档的节点给出真实字宽。 */
  connectedAtDraw: null as unknown as boolean | null,
}));
vi.mock("flowchart.js", () => ({
  default: {
    parse(code: string) {
      fcLedger.code = code;
      return {
        clean() {},
        drawSVG(container: HTMLElement, opts: Record<string, unknown>) {
          fcLedger.container = container;
          fcLedger.opts = opts;
          fcLedger.connectedAtDraw = container.isConnected;
          container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        },
      };
    },
  },
}));
// Graphviz = wasm 版 dot。`load()` 异步装 wasm，`layout()` 同步出结果（真输出前面挂着 XML 前导）。
const gvLedger = vi.hoisted(() => ({ dot: "" }));
vi.mock("@hpcc-js/wasm-graphviz", () => ({
  Graphviz: {
    async load() {
      return {
        layout(dot: string) {
          gvLedger.dot = dot;
          return (
            '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n' +
            '<svg xmlns="http://www.w3.org/2000/svg"><g class="graph">' +
            '<polygon fill="white" stroke="black"/><text fill="black">节点</text></g></svg>'
          );
        },
      };
    },
  },
}));
// B455 · ECharts：`init(dom, theme, opts)` ⇒ `setOption` ⇒ `dispose`。我们只关心这三件事怎么被叫。
const ecLedger = vi.hoisted(() => ({
  container: null as unknown as HTMLElement,
  initOpts: null as unknown as Record<string, unknown> | null,
  option: null as unknown as Record<string, unknown> | null,
  disposed: 0,
}));
vi.mock("echarts", () => ({
  init(dom: HTMLElement, _theme: unknown, opts: Record<string, unknown>) {
    ecLedger.container = dom;
    ecLedger.initOpts = opts;
    const box = document.createElement("div");
    box.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    dom.append(box);
    return {
      setOption(option: Record<string, unknown>) {
        ecLedger.option = option;
      },
      dispose() {
        ecLedger.disposed++;
        box.remove();
      },
    };
  },
}));
// B455 · 五线谱：abcjs 的 `renderAbc(target, abc, params)` 会先把 target 清空再画谱线。
const abcLedger = vi.hoisted(() => ({
  target: null as unknown as HTMLElement | null,
  code: "",
  params: null as unknown as Record<string, unknown> | null,
  /** B457-2：判「宽度变了有没有重画」只能数动笔次数。 */
  calls: 0,
  /** 模拟「解析不出曲子」那一形：abcjs 不抛异常，只是不产生谱线。 */
  drawsStaff: true,
}));
vi.mock("abcjs", () => ({
  renderAbc(target: HTMLElement, code: string, params: Record<string, unknown>) {
    abcLedger.target = target;
    abcLedger.code = code;
    abcLedger.params = params;
    abcLedger.calls++;
    target.innerHTML = abcLedger.drawsStaff
      ? '<div><svg xmlns="http://www.w3.org/2000/svg"></svg></div>'
      : "";
    return [];
  },
}));

import { renderFull } from "../src/markdown/pipeline";
import {
  PLANTUML_SERVER_DEFAULT,
  type DiagramKind,
  diagramKindOf,
  plantumlImageUrl,
  renderDiagram,
  retintGraphviz,
} from "../src/markdown/diagrams";
import { mixColors, resolvePalette, seriesPalette } from "../src/markdown/mermaidTheme";
import { enhanceMarkdown, nextEnhanceSeq } from "../src/markdown/enhance";
import { stripCssComments } from "./static";
// B454：编辑态的「预览 + 源码同时显示」要看真组件（DiagramWidget.toDOM + attachSourceEditing）
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DiagramWidget } from "../src/preview/richWidgets";

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

function mkRoot(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

describe("B452 · 图种注册表", () => {
  it("八类语言各认各的（含 vditor 那套别名）", () => {
    expect(diagramKindOf("mermaid")).toBe("mermaid");
    expect(diagramKindOf("mindmap")).toBe("mindmap");
    expect(diagramKindOf("graphviz")).toBe("graphviz");
    expect(diagramKindOf("dot")).toBe("graphviz");
    expect(diagramKindOf("flowchart")).toBe("flowchart");
    expect(diagramKindOf("flow")).toBe("flowchart");
    expect(diagramKindOf("plantuml")).toBe("plantuml");
    expect(diagramKindOf("puml")).toBe("plantuml");
    // B455：echarts / 五线谱（ABC 记谱）/ WaveDrom
    expect(diagramKindOf("echarts")).toBe("echarts");
    expect(diagramKindOf("abc")).toBe("abc");
    expect(diagramKindOf("abcjs")).toBe("abc");
    expect(diagramKindOf("wavedrom")).toBe("wavedrom");
    expect(diagramKindOf("wave")).toBe("wavedrom");
  });

  it("大小写与围栏后缀不许影响判定", () => {
    expect(diagramKindOf("MindMap")).toBe("mindmap");
    expect(diagramKindOf("  PlantUML  ")).toBe("plantuml");
  });

  it("普通代码语言不是图（go / text / 空）", () => {
    for (const lang of ["go", "text", "", "mermaidish"]) {
      expect(diagramKindOf(lang), lang).toBeNull();
    }
  });

  // B455：语言下拉是注册表的入口，不是第二份表 ⇒ 每一类图都得在那颗下拉里点得到。
  it("每一类图都在代码块的语言下拉里有入口", () => {
    const widget = readFileSync("src/preview/codeBlockWidget.ts", "utf-8");
    for (const kind of [
      "mermaid",
      "mindmap",
      "graphviz",
      "flowchart",
      "plantuml",
      "echarts",
      "abc",
      "wavedrom",
    ]) {
      expect(widget, `语言下拉里点不到 ${kind}`).toContain(`{ value: "${kind}"`);
    }
  });
});

describe("B455 · 三类新图（echarts / 五线谱 / WaveDrom）的围栏占位", () => {
  for (const lang of ["echarts", "abc", "wavedrom"] as const) {
    it(`\`\`\`${lang} 画成图种占位（不落普通代码块）`, () => {
      const html = renderFull(`\`\`\`${lang}\n内容\n\`\`\`\n`);
      expect(html).toContain('class="diagram-src"');
      expect(html).toContain(`data-diagram="${lang}"`);
      expect(html).not.toContain('class="md-code"');
    });
  }
});

describe("B452 · 围栏占位", () => {
  it("```mindmap 画成图种占位（不再落普通代码块）", () => {
    const html = renderFull("```mindmap\n- 教程\n  - 语法指导\n```\n");
    expect(html).toContain('class="diagram-src"');
    expect(html).toContain('data-diagram="mindmap"');
    expect(html).not.toContain('class="md-code"');
  });

  it("```mermaid 迁进通用臂，但旧类 mermaid-src 保留", () => {
    const html = renderFull("```mermaid\ngraph TD; A-->B;\n```\n");
    expect(html).toContain("mermaid-src");
    expect(html).toContain("diagram-src");
    expect(html).toContain('data-diagram="mermaid"');
  });
});

describe("B452 · renderDiagram 分派", () => {
  it("mermaid 这一发已接线：host 里落进 SVG", async () => {
    const root = mkRoot('<pre class="diagram-src" data-diagram="mermaid">graph TD;A-->B;</pre>');
    const host = document.createElement("div");
    await renderDiagram("mermaid", host, "graph TD;A-->B;", { root });
    expect(host.querySelector("svg")).toBeTruthy();
    root.remove();
  });

  // B455：八类图全接完了线 ⇒ 这一条只能拿一颗不存在的图种来验那层兜底（enhance 靠 reject
  // 保留源码块）。真正「在册图种不许漏接线」由下面那条静态守卫管。
  it("未接线的图种 ⇒ reject（调用方因此保留源码块，不崩）", async () => {
    const host = document.createElement("div");
    await expect(
      renderDiagram("vega" as DiagramKind, host, "{}", { root: document.body }),
    ).rejects.toThrow(/vega/);
  });

  // `RENDERERS` 是 `Partial<Record<DiagramKind, …>>` ⇒ 往 union 里加一类图而忘了渲染器，
  // `tsc --noEmit` 一声不响，用户看到的是围栏永远停在源码块（B455 加三 kinds 时最容易踩的）。
  it("在册的图种每一颗都有渲染器", () => {
    const missing = (text: string) => {
      const union = text.match(/export type DiagramKind =([\s\S]*?);/)?.[1] ?? "";
      const kinds = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
      const start = text.indexOf("const RENDERERS");
      const wired = new Set(
        [...text.slice(start, text.indexOf("\n};", start)).matchAll(/^ {2}([a-z]+):/gm)].map(
          (m) => m[1],
        ),
      );
      return kinds.filter((kind) => !wired.has(kind));
    };
    const src = readFileSync("src/markdown/diagrams.ts", "utf-8");
    expect(missing(src), `漏接线的图种：${missing(src).join(", ")}`).toEqual([]);
    // 鉴别力自检：把 wavedrom 那一支在内存影本里改名 ⇒ 判据必须报出它
    expect(
      missing(src.replace("\n  wavedrom: async", "\n  wavedromX: async")),
      "抹掉一支渲染器判据不红 = 假绿",
    ).toEqual(["wavedrom"]);
  });
});

describe("B452-2 · 脑图（markmap）", () => {
  beforeEach(() => {
    mmLedger.md = "";
    mmLedger.svg = null;
    mmLedger.opts = null;
    mmLedger.root = null;
  });

  it("围栏里的 markdown 列表喂给 markmap-lib，SVG 挂在 host 那一格", async () => {
    const host = document.createElement("div");
    await renderDiagram("mindmap", host, "- 教程\n  - 语法指导\n", { root: document.body });
    expect(mmLedger.md).toContain("语法指导");
    const svg = host.querySelector("svg");
    expect(svg, "markmap 画在自己的 SVG 里").toBeTruthy();
    expect(mmLedger.svg).toBe(svg);
    expect(mmLedger.root, "解析出来的树要交给 markmap-view").toMatchObject({ content: "教程" });
  });

  it("分支色从 token 派生（不用 markmap 自带彩虹）", async () => {
    const host = document.createElement("div");
    await renderDiagram("mindmap", host, "- 教程", { root: document.body });
    const t = resolvePalette(document.body);
    const six = [t.blue, t.green, t.yellow, t.orange, t.red, t.purple];
    const color = mmLedger.opts!.color as (n: { state: { depth: number } }) => string;
    expect(typeof color, "配色必须由主题派生，而不是 markmap 的默认彩虹").toBe("function");
    const c0 = color({ state: { depth: 0 } });
    const c1 = color({ state: { depth: 1 } });
    expect(six, `第 0 层 ${c0} 不在调色板里`).toContain(c0);
    expect(six, `第 1 层 ${c1} 不在调色板里`).toContain(c1);
    expect(c1, "分支要分色（用户点名适当彩色）").not.toBe(c0);
    expect(color({ state: { depth: 6 } })).toBe(c0); // 轮完一圈回蓝，不许 undefined
  });

  // markmap 把默认色写在它自己注入的 `.markmap` 那一档上（--markmap-text-color: #333 …），
  // 宿主根上的自定义属性会被这条后代规则盖掉 ⇒ 覆盖必须落在 `.md-diagram--mindmap .markmap`。
  it("文字 / 圆点 / 代码底跟着应用 token（盖掉 markmap 自带那一档）", () => {
    const css = readFileSync("src/preview/preview.css", "utf-8");
    const block = css.slice(
      (css.match(/\.md-diagram--mindmap \.markmap\s*\{/) ?? { index: -1 }).index,
    );
    expect(block, "缺 `.md-diagram--mindmap .markmap` 覆盖段").toContain("--markmap-text-color");
    for (const token of ["--md-fg", "--md-panel-bg", "--md-accent"]) {
      expect(block, `markmap 的色要引用 token ${token}`).toContain(token);
    }
  });

  it("脑图那一格必须有高度：markmap 按容器尺寸画，写 0 就整块空白", () => {
    const css = readFileSync("src/preview/preview.css", "utf-8");
    expect(css).toMatch(/\.md-diagram--mindmap\s*\{[^}]*height:/s);
  });

  // B453：脑图画在 CM6 的 widget 里 ⇒ 那块 DOM 随时可能不在文档上（enhance 半路放弃、滚动重画
  // 把旧的整层摘掉）。d3-zoom 的默认 extent 会去读 `svg.width.baseVal.value`，Chromium 对
  // 「量不出的相对长度」直接抛 NotSupportedError: Could not resolve relative length
  // （真机日志 07:39:39 `boot error:`）⇒ extent 必须自己量矩形，一颗 SVGLength 都不许碰。
  it("extent 自己量矩形，不许碰 <svg> 的 SVGLength（脱离文档也量得出来）", async () => {
    mmZoom.extentFn = null;
    const host = document.createElement("div");
    await renderDiagram("mindmap", host, "- 教程", { root: document.body });
    expect(mmZoom.extentFn, "没接管 d3-zoom 的 extent ⇒ 它默认要去读 SVGLength").toBeTruthy();
    const extent = mmZoom.extentFn as unknown as (
      node: unknown,
    ) => [[number, number], [number, number]];

    const svg = mmLedger.svg as SVGElement;
    for (const key of ["width", "height"] as const) {
      Object.defineProperty(svg, key, {
        configurable: true,
        get() {
          throw new Error(`NotSupportedError: 读了 ${key}.baseVal`);
        },
      });
    }
    const rect = { width: 640, height: 340 } as DOMRect;
    svg.getBoundingClientRect = () => rect;
    expect(extent(svg)).toEqual([
      [0, 0],
      [640, 340],
    ]);
    // 每次现量：格子被拉宽之后 extent 要跟着变（不许把尺寸焊死在第一次）
    (rect as unknown as { width: number }).width = 900;
    expect(extent(svg)).toEqual([
      [0, 0],
      [900, 340],
    ]);
  });

  // B455 拍板「统一外层变换」：滚轮缩放 / 拖拽平移由 `diagramViewport` 一处管。markmap 自己那颗
  // d3-zoom 要是还收手势，同一发就会被缩放两遍（图跳一下），而右上角三颗键也管不住它 ⇒ filter
  // 一律拒收。程序化的 `fit()` 不走 filter，照常能用。
  it("自己的 d3-zoom 让位给统一变换层（filter 一律拒收）", async () => {
    mmZoom.filterFn = null;
    await renderDiagram("mindmap", document.createElement("div"), "- 教程", {
      root: document.body,
    });
    expect(mmZoom.filterFn, "没接管 filter ⇒ 滚轮会被两颗缩放各画一遍").toBeTruthy();
    expect(mmZoom.filterFn!({}, {}), "任何手势都不许再过 d3-zoom").toBe(false);
  });
});

describe("B452 · enhance 那一臂", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mmdLedger.ids.length = 0;
  });

  it("渲染炸了 ⇒ 源码占位留着 + diagram-error（图不许把正文吞掉）", async () => {
    const root = mkRoot(
      '<pre class="mermaid-src diagram-src" data-diagram="mermaid">渲染失败</pre>',
    );
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false });
    await flush();
    const pre = root.querySelector("pre");
    expect(pre, "源码不许被吞").toBeTruthy();
    expect(pre!.classList.contains("diagram-error")).toBe(true);
    expect(pre!.textContent).toBe("渲染失败");
  });

  it("bigDoc 档位不碰图（占位原样留着，也不标错）", async () => {
    const root = mkRoot(
      '<pre class="mermaid-src diagram-src" data-diagram="mermaid">graph TD;A-->B;</pre>',
    );
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: true });
    await flush();
    const pre = root.querySelector("pre")!;
    expect(pre.classList.contains("diagram-error")).toBe(false);
    expect(pre.textContent).toBe("graph TD;A-->B;");
  });

  it("mindmap 占位经 enhance 换成画好的图（顶掉源码那一格）", async () => {
    const root = mkRoot('<pre class="diagram-src" data-diagram="mindmap">- 教程</pre>');
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false });
    await flush();
    expect(root.querySelector(".md-diagram--mindmap svg"), "图要落在通用臂那一格").toBeTruthy();
    expect(root.querySelector("pre.diagram-src"), "画完了就不该留占位").toBeNull();
  });

  it("mermaid 经通用臂仍然画成 .md-mermaid（B452-1 的迁移不许回退）", async () => {
    const root = mkRoot(
      '<pre class="mermaid-src diagram-src" data-diagram="mermaid">graph TD;A-->B;</pre>',
    );
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false });
    await flush();
    expect(root.querySelector(".md-mermaid svg")).toBeTruthy();
  });
});

describe("B452 · PlantUML 走在线服务器（用户拍板：vditor 同款）", () => {
  it("默认服务器 = plantuml.com", () => {
    expect(PLANTUML_SERVER_DEFAULT).toContain("plantuml");
  });

  it("URL = <服务器>/svg/<编码>，尾巴斜杠不许拼出双斜杠", () => {
    const code = "@startuml\nAlice->Bob: hi\n@enduml";
    for (const server of ["https://k.plantuml.com/plantuml", "https://k.plantuml.com/plantuml/"]) {
      const url = plantumlImageUrl(code, server);
      expect(url.startsWith("https://k.plantuml.com/plantuml/svg/")).toBe(true);
      expect(url).not.toContain("plantuml//svg");
      expect(url.length).toBeGreaterThan("https://k.plantuml.com/plantuml/svg/".length);
    }
  });

  // `~1` 是 PlantUML 的「密文」前缀：带上它，服务器不再按普通编码解，回一张
  // 「This URL does not look like HUFFMAN data」的错误图（真机截图照出来的）。
  // 判据要盯住「路径后面直接就是编码串」，别只盯前缀。
  it("编码串前面不许加 `~1`（那是密文前缀，服务器会回错误图）", () => {
    const code = "@startuml\nAlice->Bob: hi\n@enduml";
    const url = plantumlImageUrl(code, "https://k.example/plantuml");
    const tail = url.slice("https://k.example/plantuml/svg/".length);
    expect(tail.startsWith("~")).toBe(false);
    expect(tail, "路径尾巴就是 plantuml-encoder 的那一串").toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("换服务器只改前缀，编码部分不动", () => {
    const code = "@startuml\nA->B\n@enduml";
    const a = plantumlImageUrl(code, "https://one.example/plantuml");
    const b = plantumlImageUrl(code, "https://two.example/plantuml");
    expect(a.slice("https://one.example".length)).toBe(b.slice("https://two.example".length));
  });

  it("画成 <img>：src 指那台服务器的 SVG 接口，加载成功才算画完", async () => {
    const host = document.createElement("div");
    const code = "@startuml\nAlice->Bob: hi\n@enduml";
    const p = renderDiagram("plantuml", host, code, { root: document.body });
    const img = host.querySelector("img");
    expect(img, "图要画进调用方给的 host 那一格").toBeTruthy();
    expect(img!.src, "URL 由源码 + 默认服务器算出").toBe(plantumlImageUrl(code));
    img!.dispatchEvent(new Event("load"));
    await expect(p).resolves.toBeUndefined();
  });

  it("服务器取设置里那一台；没写 / 空串 / 尾巴斜杠 ⇒ 都落回默认那台", async () => {
    const code = "@startuml\nA->B\n@enduml";
    const cases: [string | undefined, string][] = [
      ["https://k.example/plantuml", "https://k.example/plantuml"],
      ["https://k.example/plantuml/", "https://k.example/plantuml"],
      ["", PLANTUML_SERVER_DEFAULT],
      ["   ", PLANTUML_SERVER_DEFAULT],
      [undefined, PLANTUML_SERVER_DEFAULT],
    ];
    for (const [server, want] of cases) {
      const host = document.createElement("div");
      const p = renderDiagram("plantuml", host, code, {
        root: document.body,
        plantumlServer: server,
      });
      const img = host.querySelector("img")!;
      expect(img, `${String(server)} ⇒ 没画出 img`).toBeTruthy();
      // 与 `plantumlImageUrl` 比同一颗（不在测试里重抄一遍 URL 形状：那条 `~1` 就是
      // 因为形状被抄在两处，两处一起绿着错）。
      expect(img.src, `${String(server)} ⇒ ${img.src}`).toBe(plantumlImageUrl(code, want));
      img.dispatchEvent(new Event("load"));
      await p;
    }
  });

  // 离线 / 语法错 / 服务器挂了：img 加载失败 ⇒ reject。enhance 那一臂接住它，
  // 保住源码占位并标 `diagram-error`（与 mermaid 画失败同一口径，比一个碎图图标有用）。
  it("服务器画不出来 ⇒ reject（调用方退回源码，不留碎图）", async () => {
    const host = document.createElement("div");
    const p = renderDiagram("plantuml", host, "@startuml\nA->B\n@enduml", { root: document.body });
    host.querySelector("img")!.dispatchEvent(new Event("error"));
    await expect(p).rejects.toThrow();
  });

  // 服务器地址是设置里的一格 ⇒ 必须从 `enhanceMarkdown` 穿到渲染器，写死等于设置项作废。
  it("地址从设置穿到渲染器（enhance 转发 + 预览面现读）", () => {
    const enhance = readFileSync("src/markdown/enhance.ts", "utf-8");
    const widgets = readFileSync("src/preview/richWidgets.ts", "utf-8");
    expect(enhance).toMatch(/plantumlServer:\s*opts\.plantumlServer/);
    expect(widgets).toMatch(/plantumlServer:\s*settings\?\.plantuml_server/);
  });

  // 服务器给回的是按图自身尺寸铺开的位图 ⇒ 卡片那一格必须收得住它。svg 早就在收了，
  // img 漏出去就是一张横向撑破预览区的图（脑图那一格同理，但它自己带 fit）。
  it("图收在卡片宽度里（img 与 svg 同一条 max-width）", () => {
    const css = readFileSync("src/preview/preview.css", "utf-8");
    const rule =
      css.match(
        /\.md-diagram-widget \.md-diagram (?:[^{,]*,)*[^{,]*\{[^}]*max-width[^}]*\}/s,
      )?.[0] ?? "";
    expect(rule, "缺 svg/img 共用的那条 max-width 规则").toContain("max-width: 100%");
    expect(rule, "img 没在那条规则里").toContain("img");
  });
});

describe("B452-3 · Graphviz（wasm 版 dot）", () => {
  it("DOT 喂给 wasm，SVG 落进 host 那一格（XML 前导不许留在 DOM 里）", async () => {
    const host = document.createElement("div");
    await renderDiagram("graphviz", host, "digraph { a -> b }", { root: document.body });
    expect(gvLedger.dot).toContain("digraph");
    const svg = host.querySelector("svg");
    expect(svg, "渲染结果要真在 DOM 里").toBeTruthy();
    expect(host.firstChild).toBe(svg);
    expect(host.textContent).not.toContain("DOCTYPE");
  });

  // dot 默认按「白纸黑字」画：白纸压在灰卡片上是一块白板，黑字在暗档等于没字。
  it("白纸黑字换到主题那一档（作者没显式改过的三颗默认值）", () => {
    const t = resolvePalette(document.body);
    const out = retintGraphviz(
      '<polygon fill="white" stroke="black"/><text fill="black">x</text>',
      t,
    );
    expect(out).not.toContain('fill="white"');
    expect(out).not.toContain('stroke="black"');
    expect(out).not.toContain('fill="black"');
    expect(out).toContain(`fill="${t.panel}"`);
    expect(out).toContain(`stroke="${t.muted}"`);
    expect(out).toContain(`fill="${t.fg}"`);
  });

  it("作者显式写的颜色一个都不许动", () => {
    const t = resolvePalette(document.body);
    const src = '<polygon fill="#ff0000" stroke="#00ff00"/><text fill="#123456">x</text>';
    expect(retintGraphviz(src, t)).toBe(src);
  });

  // B452-3 真机抓到：dot 只在**非默认**颜色上写属性 —— 正文黑是初始值，`<text>` 上压根
  // 没有 `fill`，字符串替换没有落点 ⇒ 暗档里标签照样是黑的（CSS 补也不行，会盖掉作者写的）。
  it("没写 fill 的标签补上正文墨色（写了的不许碰）", () => {
    const t = resolvePalette(document.body);
    const out = retintGraphviz('<g class="node"><text x="1" y="2">开始</text></g>', t);
    expect(out).toContain(`fill="${t.fg}"`);
    expect(retintGraphviz('<text fill="#123456" x="1">x</text>', t)).toBe(
      '<text fill="#123456" x="1">x</text>',
    );
  });
});

describe("B452-4 · Flowchart（flowchart.js，非 mermaid 那套语法）", () => {
  beforeEach(() => {
    fcLedger.code = "";
    fcLedger.opts = null as unknown as Record<string, unknown>;
    fcLedger.container = null as unknown as HTMLElement;
    fcLedger.connectedAtDraw = null as unknown as boolean | null;
  });

  it("parse 拿到源码，画完的 SVG 落在 host 那一格", async () => {
    const host = document.createElement("div");
    await renderDiagram("flowchart", host, "st=>start: Start\ne=>end\nst->e", {
      root: document.body,
    });
    expect(fcLedger.code).toContain("st=>start");
    expect(host.querySelector("svg"), "host 里要拿到那张图").toBeTruthy();
  });

  it("动笔时容器必须在真实布局里（脱离文档 ⇒ getBBox 全 0 ⇒ 节点塌成一条）", async () => {
    // 产品那一形：预览臂在 CM6 `toDOM()` 里就发起渲染，这一刻整块 widget DOM 还没进文档。
    const root = document.createElement("div");
    const host = document.createElement("div");
    const pending = renderDiagram("flowchart", host, "st=>start: Start", { root });
    await new Promise((r) => setTimeout(r, 0));
    expect(fcLedger.connectedAtDraw, "root 还在文档外就不许动笔").not.toBe(true);
    document.body.append(root);
    await pending;
    expect(fcLedger.connectedAtDraw, "进文档后补画").toBe(true);
    expect(host.querySelector("svg")).toBeTruthy();
  });

  it("临时测量格画完就撤，文档里不留残渣", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const host = document.createElement("div");
    await renderDiagram("flowchart", host, "st=>start: Start", { root });
    expect(fcLedger.container, "动笔的那一格是临时测量格，不是 host").not.toBe(host);
    expect(fcLedger.container!.isConnected).toBe(false); // 撤掉了才不算给文档留残渣
  });

  it("测量格那条样式参与布局（display:none 等于白测）且不占位置", () => {
    // 在 global.css 不在 preview.css：B397-2 那道守卫要求 preview.css 每条规则都挂在
    // `.md-preview-face` 下，而这一格兜底时会挂到 body 上，本就不是预览面的排版。
    const rule = readFileSync("src/styles/global.css", "utf8");
    const block = rule.slice(rule.indexOf(".md-diagram-measure"));
    const body = block.slice(block.indexOf("{"), block.indexOf("}"));
    expect(body).toContain("position: absolute");
    expect(body, "藏起来就不许参与布局 ⇒ 又量到 0").not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
  });

  it("root 永远进不了文档也要画（超时兜底，不能让图永远空着）", async () => {
    const root = document.createElement("div"); // 没人会挂它
    const host = document.createElement("div");
    await renderDiagram("flowchart", host, "st=>start: Start", { root });
    expect(fcLedger.connectedAtDraw, "兜底要画在文档里的测量格上").toBe(true);
    expect(host.querySelector("svg")).toBeTruthy();
  });

  it("三档颜色与 mermaid 同源（连线 muted / 描边强调压深 / 元素底淡染）", async () => {
    const host = document.createElement("div");
    await renderDiagram("flowchart", host, "st=>start: Start", { root: document.body });
    const t = resolvePalette(document.body);
    const o = fcLedger.opts;
    expect(o["line-color"], "连线：与 mermaid 的 lineColor 同一颗").toBe(t.muted);
    expect(o["element-color"], "元素描边：与 mermaid 的 nodeBorder 同一档").toBe(
      mixColors(t.accent, t.fg, 0.35),
    );
    expect(o.fill, "元素底：与 mermaid 的 nodeBkg 同一档").toBe(mixColors(t.panel, t.accent, 0.12));
    expect(o["font-color"]).toBe(t.fg);
  });
});

describe("B455-2 · ECharts（全量包 + SVG renderer）", () => {
  beforeEach(() => {
    ecLedger.container = null as unknown as HTMLElement;
    ecLedger.initOpts = null;
    ecLedger.option = null;
    ecLedger.disposed = 0;
  });

  const OPTION = `{
  "title": { "text": "最近 30 天" },
  "series": [{ "name": "帖子", "type": "line", "data": ["18", "14"] }]
}`;

  it("围栏里的 option 交出去，画好的 SVG 落进 host 那一格", async () => {
    const host = document.createElement("div");
    await renderDiagram("echarts", host, OPTION, { root: document.body });
    expect(ecLedger.option, "没 setOption ⇒ 什么也画不出来").toMatchObject({
      title: { text: "最近 30 天" },
    });
    expect(host.querySelector("svg"), "echarts 的产物要落在调用方给的 host 里").toBeTruthy();
  });

  // 位图（canvas）在暗档糊成一团，导出 / 打印也要矢量 ⇒ 与其余图种同一口径走 SVG。
  it("用 SVG renderer，不用默认的 canvas", async () => {
    const host = document.createElement("div");
    await renderDiagram("echarts", host, OPTION, { root: document.body });
    expect(ecLedger.initOpts, "renderer 没写 ⇒ echarts 默认画 canvas").toMatchObject({
      renderer: "svg",
    });
  });

  // enhance 是「先画进 host，再 `replaceWith` 顶掉源码占位」⇒ 动笔这一刻容器多半还在文档外，
  // 量出来是 0 宽（echarts 会退回它自己那对默认尺寸，真机上就是一张挤在左上角的小图）。
  // 所以尺寸由我们显式给，不许让 echarts 去量。
  it("脱离文档也给得出尺寸（显式 width / height）", async () => {
    const root = document.createElement("div"); // 没人会挂它
    const host = document.createElement("div");
    await renderDiagram("echarts", host, OPTION, { root });
    const { width, height } = ecLedger.initOpts as { width: number; height: number };
    expect(width, "宽度要兜到最小那一档，不是 0").toBeGreaterThanOrEqual(320);
    expect(height, "高度写 0 ⇒ 整块空白").toBeGreaterThan(200);
  });

  it("进了文档就按那一格的实际宽度画（格子拉宽，图跟着宽）", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 900 });
    await renderDiagram("echarts", document.createElement("div"), OPTION, { root });
    const { width } = ecLedger.initOpts as { width: number };
    expect(width, "卡片有 20px 内边距：给 echarts 的宽度要扣掉左右这两道").toBe(900 - 40);
  });

  // 卡片那 20px 内边距写死在 preview.css ⇒ 两处得对得上（B438 的教训：让位/内边距这类几何
  // 一旦各写各的，就会出现「改了 CSS 图却还按老宽度画」。
  it("扣掉的那道内边距与 preview.css 同源（谁改都要红）", () => {
    const css = readFileSync("src/preview/preview.css", "utf-8");
    const src = readFileSync("src/markdown/diagrams.ts", "utf-8");
    expect(css, "`.md-diagram` 的内边距不再是 20px ⇒ 同步 diagrams.ts 那一颗").toMatch(
      /\.md-diagram\s*\{[^}]*padding:\s*20px/,
    );
    expect(src, "diagrams.ts 里没有那颗与 CSS 同值的内边距").toMatch(/CARD_PADDING_X = 20\b/);
  });

  it("没写引号的 JS 对象写法也认（ECharts / WaveJSON 的惯例写法）", async () => {
    const host = document.createElement("div");
    await renderDiagram("echarts", host, "{ series: [ { type: 'bar', data: [1, 2], } ] }", {
      root: document.body,
    });
    expect(ecLedger.option).toMatchObject({ series: [{ type: "bar" }] });
  });

  it("默认档从 token 派生，但作者显式写的以作者为准", async () => {
    const t = resolvePalette(document.body);
    await renderDiagram("echarts", document.createElement("div"), OPTION, { root: document.body });
    const auto = ecLedger.option as Record<string, unknown>;
    expect(auto.backgroundColor, "卡片底已有色，图自己再铺一层白就是一块白板").toBe("transparent");
    expect(auto.color, "系列色必须与脑图同一颗调色板（B377 红线：不许有第二份色表）").toEqual(
      seriesPalette(t),
    );

    await renderDiagram("echarts", document.createElement("div"), `{ "color": ["#123456"] }`, {
      root: document.body,
    });
    expect((ecLedger.option as Record<string, unknown>).color).toEqual(["#123456"]);
  });

  // 真机目视抓的（B455-7 暗档截图）：根 `textStyle` 只管坐标轴/提示，**标题组件有自己的默认色**
  // （库里写死的深灰）⇒ 暗档里标题几乎看不见。
  it("标题跟着正文墨色走（根 textStyle 管不到 title，得单独给一颗默认）", async () => {
    const t = resolvePalette(document.body);
    await renderDiagram("echarts", document.createElement("div"), OPTION, { root: document.body });
    const auto = ecLedger.option as {
      textStyle?: { color?: string };
      title?: { textStyle?: { color?: string } };
    };
    expect(auto.textStyle?.color, "根 textStyle 的墨色没了").toBe(t.fg);
    expect(auto.title?.textStyle?.color, "标题留着库里那档深灰").toBe(t.fg);

    await renderDiagram(
      "echarts",
      document.createElement("div"),
      `{ title: { text: "T", textStyle: { color: "#abc" } }, series: [{ type: "bar" }] }`,
      { root: document.body },
    );
    const authored = ecLedger.option as {
      title?: { text?: string; textStyle?: { color?: string } };
    };
    expect(authored.title?.textStyle?.color, "作者写了标题的色，默认那颗不许盖掉它").toBe("#abc");
    expect(authored.title?.text, "补色时把作者写的其余键整颗顶掉了").toBe("T");
  });

  it("语法错 ⇒ reject（调用方退回源码块，不许画半张图）", async () => {
    await expect(
      renderDiagram("echarts", document.createElement("div"), "{ 这不是合法 option", {
        root: document.body,
      }),
    ).rejects.toThrow(/echarts/i);
  });

  it("同一格重画之前先 dispose 上一发（实时重画不许漏实例）", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    await renderDiagram("echarts", document.createElement("div"), OPTION, { root });
    await renderDiagram("echarts", document.createElement("div"), OPTION, { root });
    expect(ecLedger.disposed, "第二次画之前没把上一发 dispose 掉").toBe(1);
  });
});

describe("B455-3 · 五线谱（ABC 记谱 + abcjs）", () => {
  beforeEach(() => {
    abcLedger.target = null;
    abcLedger.code = "";
    abcLedger.params = null;
    abcLedger.drawsStaff = true;
  });

  const ABC = 'X:1\nT:Clouds Thicken\nM:6/8\nL:1/8\nK:Em\n|:"Em"EEE E2G|\n';

  // abcjs 拿到目标格第一件事就是 `innerHTML = ""` ⇒ 把 host 交给它等于把别的住户一并抹掉
  //（变换层那颗键、下一次重画的落点）。它只能画进自己那一格内层。
  it("ABC 原文交给 renderAbc，谱线画在 host 里的一颗内层格", async () => {
    const host = document.createElement("div");
    await renderDiagram("abc", host, ABC, { root: document.body });
    expect(abcLedger.code, "要原样交给 abcjs（不许裁剪/改写）").toContain("Clouds Thicken");
    expect(abcLedger.target, "不许把 host 本格交给 abcjs：它进来先清空").not.toBe(host);
    expect(host.contains(abcLedger.target as Node), "内层格要在 host 里").toBe(true);
    expect(host.querySelector("svg"), "谱线要真落在 DOM 里").toBeTruthy();
  });

  it("墨色从 token 派生（暗档不许画成黑线黑字）", async () => {
    await renderDiagram("abc", document.createElement("div"), ABC, { root: document.body });
    expect(abcLedger.params!.foregroundColor).toBe(resolvePalette(document.body).fg);
  });

  it("谱表宽度按卡片那一格算，并且开了换行（默认 745px 会撑破窄格）", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 900 });
    await renderDiagram("abc", document.createElement("div"), ABC, { root });
    const p = abcLedger.params! as {
      staffwidth: number;
      paddingleft: number;
      paddingright: number;
    };
    expect(
      p.staffwidth + p.paddingleft + p.paddingright,
      "SVG 的总宽要正好等于卡片那一格（扣掉它自己那 20px 内边距）",
    ).toBe(860);
    // abcjs 内部按 `params.wrap.minSpacing` 那几档读（写 `true` 也判真，但等于把整张间距表留空）。
    expect(abcLedger.params!.wrap, "不开换行 ⇒ 一小节一行，窄格里只剩竖线").toMatchObject({
      preferredMeasuresPerLine: expect.any(Number),
      minSpacing: expect.any(Number),
      maxSpacing: expect.any(Number),
    });
  });

  // B457-2 与 B457-5 是同一笔账的两半，只算一半就会留下另一半年在咬人。abcjs 那一边：
  //   SVG 总宽 = `staffwidth + paddingleft + paddingright`，而**墨迹**落在
  //   `[paddingleft, paddingleft + staffwidth]` 这一段里（真机量过：默认档 staffwidth=983、
  //   左右各 15 ⇒ svg 宽 1013、墨迹右沿 998）。
  // · B457-2 的病：总宽 1013 > 格子 983 ⇒ 多出的 30 被卡片的 `overflow:hidden` 切掉。
  //   当时的修法是两格留白归零 ⇒ 总宽不超了，可墨迹右沿也跟着顶到 SVG **自己的**右边界：
  //   窄格实测 `svg width=547` 而 `getBBox()=549`，越界那 2px 由 SVG 根节点的默认裁切吃掉 ⇒
  //   右对齐的署名与最后一小节的尾巴不见了（用户：「五线谱右边缘被裁剪了」）。
  // · 正解是一笔同时结两边：留白照留，但从 `staffwidth` 里扣 ⇒ 总宽仍等于格宽，墨迹左右各空出一档。
  it("左右留白从谱表宽度里扣：总宽不超出卡片那一格，墨迹也不许顶到 SVG 自己的边界", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 900 });
    await renderDiagram("abc", document.createElement("div"), ABC, { root });
    const p = abcLedger.params! as {
      staffwidth: number;
      paddingleft: number;
      paddingright: number;
    };
    expect(p.paddingleft, "左缘不留白 ⇒ 起笔贴着卡片内边距").toBeGreaterThan(0);
    expect(p.paddingright, "右缘不留白 ⇒ 墨迹顶到 SVG 自己的边界，被根节点裁掉（B457-5）").toBe(
      p.paddingleft,
    );
    expect(
      p.staffwidth + p.paddingleft + p.paddingright,
      "总宽超出卡片那一格 ⇒ B457-2 那 30px 的病又回来（被 overflow:hidden 切）",
    ).toBe(860);
  });

  // `responsive: 'resize'` 是按**整窗**宽度铺的（它自己算 `window.innerWidth - offsetLeft*2`）：
  // 分屏里一张谱表横贯整个窗口，等于把隔壁那格压掉。
  it("不许开 responsive（那颗按整窗宽度铺，分屏里会横贯窗口）", async () => {
    await renderDiagram("abc", document.createElement("div"), ABC, { root: document.body });
    expect(abcLedger.params!.responsive).toBeUndefined();
  });

  // abcjs 对不合法的 ABC 不抛异常，只是画不出谱线 ⇒ 空框比源码难懂，退回源码块（与其余图种同口径）。
  it("画不出谱线 ⇒ reject（调用方退回源码，不留一格空框）", async () => {
    abcLedger.drawsStaff = false;
    await expect(
      renderDiagram("abc", document.createElement("div"), "这不是 ABC", { root: document.body }),
    ).rejects.toThrow(/abc/i);
  });
});

describe("B455-4 · WaveDrom（数字波形，用真库跑）", () => {
  const WAVE = `{ signal: [ { name: "clk", wave: "p......" }, { name: "bus", wave: "x.34.5x", data: "head body tail" } ] }`;

  /** B455-7：每一发波形画在自己的 shadow root 里 ⇒ 判据都从那颗树里读。 */
  function treeOf(host: HTMLElement): ShadowRoot {
    const box = host.querySelector<HTMLElement>(".md-wavedrom-box");
    const tree = box?.shadowRoot;
    expect(tree, "波形没关进 shadow root ⇒ 皮肤 CSS 与那批 id 会外溢").toBeTruthy();
    return tree!;
  }

  it("WaveJSON 画成波形，信号名落在图里", async () => {
    const host = document.createElement("div");
    await renderDiagram("wavedrom", host, WAVE, { root: document.body });
    const tree = treeOf(host);
    expect(tree.querySelector("svg"), "没画出 svg").toBeTruthy();
    expect(tree.textContent).toContain("clk");
    expect(tree.textContent, "第二段波形的数据也要在").toContain("tail");
  });

  it("少了外层花括号的裸 body 也认（wavedrom 编辑器里就常这么写）", async () => {
    const host = document.createElement("div");
    await renderDiagram("wavedrom", host, 'signal: [ { name: "x", wave: "01" } ]', {
      root: document.body,
    });
    expect(treeOf(host).querySelector("svg")).toBeTruthy();
  });

  it("既没有 signal 也没有 assign / reg ⇒ reject（调用方退回源码）", async () => {
    await expect(
      renderDiagram("wavedrom", document.createElement("div"), `{ "note": "画的不是波形" }`, {
        root: document.body,
      }),
    ).rejects.toThrow(/wavedrom/i);
  });

  // ⚠️ 这一条挡的是「换一种收口办法」的回退：给皮肤选择器加祖先前缀看着同样收得住，
  // 但 B455-7 真机抓到它画出来是一排实心黑 —— defs 里的**原件**照样命中（`getComputedStyle`
  // 量得到 `fill:none`），可画出来的是 `<use>` 的**克隆体**，它在 use 自己的 shadow 树里，
  // 文档选择器跨不过那道边界。所以皮肤那张表必须**逐字不动**，靠 shadow root 收口。
  it("皮肤那张 CSS 逐字保留，且只活在那棵树里（文档一棵 style 都不许多）", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      await renderDiagram("wavedrom", host, WAVE, { root: document.body });
      const tree = treeOf(host);
      const style = tree.querySelector("style");
      expect(style, "皮肤的 <style> 要留着（去掉它波形就散了）").toBeTruthy();
      const css = style!.textContent!;
      expect(css, "皮肤选择器被改写过 ⇒ <use> 的克隆体会丢样式").toContain(".h1{");
      expect(css).not.toContain("md-diagram--wavedrom");
      expect(host.querySelectorAll("style,svg").length, "图的内容漏进了文档那一层").toBe(0);
      expect(document.querySelectorAll("#pclk").length, "皮肤的 id 落到了文档里").toBe(0);
    } finally {
      host.remove();
    }
  });

  it("两块波形各用各的 id（引用不出自己那棵树）", async () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    await renderDiagram("wavedrom", a, WAVE, { root: document.body });
    await renderDiagram("wavedrom", b, WAVE, { root: document.body });
    const ta = treeOf(a);
    const tb = treeOf(b);
    expect(ta.querySelectorAll("[id]").length, "没生成带 id 的分组").toBeGreaterThan(0);
    expect(ta.querySelector("#pclk"), "皮肤那颗符号没在自己树里").toBeTruthy();
    expect(tb.querySelector("#pclk"), "第二发的树里也该有一份").toBeTruthy();
    expect(
      [...a.querySelectorAll("[id]"), ...b.querySelectorAll("[id]")].length,
      "两发的 id 都不许出现在文档那一层（否则后一块会指到前一块的 defs）",
    ).toBe(0);
  });

  it("皮肤那块硬编码的白底换成卡片色（暗档不许一块白）", async () => {
    const host = document.createElement("div");
    await renderDiagram("wavedrom", host, WAVE, { root: document.body });
    const bg = treeOf(host).querySelector("svg > g > rect");
    expect(bg, "找不到铺底那一格").toBeTruthy();
    expect(bg!.getAttribute("style"), "白底还在").not.toContain("fill:white");
    expect(bg!.getAttribute("style")).toContain(resolvePalette(document.body).panel);
  });

  it("线墨与正文同色：取色覆盖挂在树内、且排在皮肤之后", async () => {
    const host = document.createElement("div");
    await renderDiagram("wavedrom", host, WAVE, { root: document.body });
    const tree = treeOf(host);
    const styles = [...tree.querySelectorAll("style")];
    expect(styles.length, "取色覆盖没挂上").toBeGreaterThanOrEqual(2);
    const ink = styles[styles.length - 1].textContent ?? "";
    expect(ink, "缺 wavedrom 的取色段").toContain("var(--md-fg)");
    expect(ink, "波形线（.s1…）没跟着换墨").toMatch(/\.s1[^{]*\{[^}]*stroke/s);
    expect(ink, "注释档要跟着 --md-muted").toContain("var(--md-muted)");
    // B455-7 真机量的：信号名那一格带皮肤的 `.info`（写死 `#0041c4`），特异度比裸 `text` 高 ⇒
    // 不映射它就等于「暗档里三行信号名全部看不见」。
    expect(ink, "信号名（.info）没跟着换色").toMatch(/\.info[^{]*\{[^}]*--md-accent/);
    // preview.css 里那些规则跨不进 shadow 树 ⇒ 留着就是死 CSS（B455-7 从那儿搬走的）
    const css = readFileSync("src/preview/preview.css", "utf-8");
    expect(css, "文档样式管不到 shadow 里的波形，别再往回搬").not.toMatch(
      /\.md-diagram--wavedrom\s+(text|\.s\d|\.muted)/,
    );
  });
});

// B457-4（用户：「深色模式下，wavedrom 的波形填充区域颜色饱和度有点低，泛白」）。
//
// 皮肤的八档数据色（`.s7`–`.s14` = WaveJSON 的 `2`–`9`）是为**白纸**调的粉彩：#fff、#ffffb4、#ffe0b9、
// #b9e0ff、#ccfdfe、#cdfdc5、#f0c1fb、#f5c2c0。贴到深色卡片上就是「泛白」，而皮肤的 `text{}` 不带 fill
// ⇒ 格里的数据标签吃我们的 `--md-fg`（暗档近白）⇒ 浅字压浅底，两头一起糊。
// 深色档要把这八档换成「同族色相的压深版」：彩色保住、明度压到中线以下，近白的标签才落得上去。
describe("B457-4 · 深色档的波形数据格不许泛白", () => {
  const WAVE = `{ signal: [ { name: "bus", wave: "x.23456789" } ] }`;
  const STATES = [".s7", ".s8", ".s9", ".s10", ".s11", ".s12", ".s13", ".s14"];

  function rgbOf(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const v = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
  }
  /** ITU-R BT.601 的亮度。测试自己算一遍，不抄实现里那颗 `isDarkColor`（否则判据只会跟着实现一起错）。 */
  const luma = (hex: string): number => {
    const [r, g, b] = rgbOf(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  };
  /** 彩度（最大通道减最小通道）：低于这把尺就是「灰糊」，不是彩色。 */
  const chroma = (hex: string): number => {
    const [r, g, b] = rgbOf(hex);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };

  /** 取那一档数据格的填充（`fill:#rrggbb`）；没有覆盖就返回 null。 */
  function fillOf(ink: string, cls: string): string | null {
    const m = ink.match(new RegExp(`\\${cls}\\s*\\{[^}]*?fill:\\s*(#[0-9a-fA-F]{3,6})`));
    return m ? m[1] : null;
  }

  /** 取色覆盖排在皮肤之后 ⇒ 树里最后一棵 `<style>`。 */
  async function inkOf(host: HTMLElement): Promise<string> {
    await renderDiagram("wavedrom", host, WAVE, { root: document.body });
    const tree = host.querySelector<HTMLElement>(".md-wavedrom-box")?.shadowRoot;
    expect(tree, "波形没关进 shadow root").toBeTruthy();
    const styles = [...tree!.querySelectorAll("style")];
    expect(styles.length, "取色覆盖没挂上").toBeGreaterThanOrEqual(2);
    return styles[styles.length - 1].textContent ?? "";
  }

  /**
   * 把卡片换成暗档：`resolvePalette` 读的就是宿主上这几颗自定义属性，jsdom 里手工摆上去即可切档
   * （没摆的那几颗照旧落 FALLBACK，与真机同一口径）。
   */
  async function onDarkCard(fn: () => Promise<void>): Promise<void> {
    const style = document.documentElement.style;
    const keys = ["--md-panel-bg", "--md-fg", "--md-muted", "--md-accent"];
    const before = keys.map((k) => [k, style.getPropertyValue(k)] as const);
    style.setProperty("--md-panel-bg", "#1e1e1e");
    style.setProperty("--md-fg", "#e8e8e8");
    style.setProperty("--md-muted", "#9a9a9a");
    style.setProperty("--md-accent", "#0a84ff");
    try {
      await fn();
    } finally {
      for (const [key, value] of before) {
        if (value) style.setProperty(key, value);
        else style.removeProperty(key);
      }
    }
  }

  it("暗档：八档数据格都是「压深的彩色」（不泛白，也不糊成灰）", async () => {
    await onDarkCard(async () => {
      const ink = await inkOf(document.createElement("div"));
      const seen = new Set<string>();
      for (const cls of STATES) {
        const fill = fillOf(ink, cls);
        expect(fill, `${cls} 没被覆盖 ⇒ 皮肤为白底调的粉彩泛在暗卡片上`).toBeTruthy();
        expect(
          luma(fill!),
          `${cls} 的 ${fill} 还是浅色 ⇒ 近白的标签压浅底，就是「泛白」`,
        ).toBeLessThan(0.5);
        expect(chroma(fill!), `${cls} 的 ${fill} 几乎是灰 ⇒ 没有彩色`).toBeGreaterThanOrEqual(28);
        seen.add(fill!.toLowerCase());
      }
      expect(seen.size, "八档压成同一种色 ⇒ 波形分不出数据组了").toBeGreaterThanOrEqual(6);
    });
  });

  it("暗档：皮肤里写死的黑 / 白两颗（gap、P·N 时钟标记）跟着归位", async () => {
    await onDarkCard(async () => {
      const ink = await inkOf(document.createElement("div"));
      const panel = resolvePalette(document.body).panel;
      expect(fillOf(ink, ".s5"), "gap 那一格皮肤给的是 #fff ⇒ 暗卡片上一道白痕").toBe(panel);
      expect(ink, "P·N 时钟标记皮肤给的是 #000 ⇒ 暗卡片上看不见").toMatch(
        /\.s6\s*\{[^}]*var\(--md-fg\)/,
      );
    });
  });

  it("浅色档原样交给皮肤（八档粉彩本就配深色字，别把暗档的修法糊上去）", async () => {
    const ink = await inkOf(document.createElement("div"));
    for (const cls of [...STATES, ".s5", ".s6"]) {
      expect(fillOf(ink, cls), `${cls} 在浅色档被改写 ⇒ 深色档的条件没守住`).toBeNull();
    }
  });
});

describe("B454 · 编辑时预览与源码同时显示（照 InkNote，五类图 + metadata / HTML 一起）", () => {
  // B434 那一形是「点图 ⇒ 同一位置换成源码区」：画好的图整块 `display:none`。脑图的源码就是
  // 一串 `- 项目`，图一藏等于盲改（用户：「脑图未支持编辑」）。InkNote 的做法：源码框浮在
  // 上面、图留在下面不藏，打字停手 ~400ms 跟着重画。
  it("编辑态不许再藏渲染结果（图 / metadata / HTML 三处规则一起作废）", () => {
    // ⚠️ 剥注释：CSS 里留着「原来这里还有一条 `.md-diagram-inner { display: none }`」那段变更史，
    // 不剥的话 `not.toMatch` 会被自己的文档误伤（tests/static.ts 讲的就是这个坑）。
    const css = stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));
    expect(css, "编辑态还在藏画好的图 ⇒ 打字时看不见结果").not.toMatch(
      /\.md-diagram-widget\.md-block--editing[^{]*\{[^}]*display:\s*none/,
    );
    expect(css, "metadata / HTML 块同理：源码浮上去，渲染结果留着").not.toMatch(
      /\.md-block--editing[^{]*\.md-(metadata|html)-preview[^{]*\{[^}]*display:\s*none/,
    );
  });

  it("同一格重画之前先释放上一发 Markmap（实时重画不许漏 ResizeObserver）", async () => {
    mmDispose.calls = 0;
    const root = document.createElement("div");
    document.body.append(root);
    await renderDiagram("mindmap", document.createElement("div"), "- 教程", { root });
    await renderDiagram("mindmap", document.createElement("div"), "- 教程改过", { root });
    expect(mmDispose.calls, "第二次画之前没把上一发 destroy 掉").toBe(1);
  });

  async function mountDiagram(kind: DiagramKind, code: string) {
    document.body.innerHTML = "";
    const view = new EditorView({
      state: EditorState.create({ doc: code }),
      parent: document.body,
    });
    const dom = new DiagramWidget(0, code.length, code, kind).toDOM(view);
    // ⚠️ 挂在 `.cm-editor` 下而不是 body 上：这两条判据要读「点/打字之后这块的状态」，
    // 而这块的写回与重画入口第一步就是 `EditorView.findFromDOM(wrap)`。
    view.dom.append(dom);
    await flush();
    return { view, dom, source: dom.querySelector<HTMLElement>(".md-block-source")! };
  }

  async function typeInto(source: HTMLElement, text: string): Promise<void> {
    source.textContent = text;
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500)); // 比防抖那一档（400ms）长一点
    await flush();
  }

  it("打字停手 ⇒ 本地图跟着重画（markmap 收到的是新文本）", async () => {
    const { source } = await mountDiagram("mindmap", "- 教程\n");
    expect(mmLedger.md).toContain("教程");
    await typeInto(source, "- 教程\n- 新增的一支\n");
    expect(mmLedger.md, "编辑期间图要跟着活：没收到新文本 ⇒ 没重画").toContain("新增的一支");
  }, 20000);

  it("PlantUML 不实时重画（每停一下发一次请求太贵）", async () => {
    // jsdom 不会真去加载图片 ⇒ 数「建过几颗 <img>」就是「打了几次服务器」。
    const seen: HTMLImageElement[] = [];
    const orig = document.createElement.bind(document) as (t: string) => HTMLElement;
    document.createElement = ((tag: string) => {
      const el = orig(tag);
      if (tag === "img") seen.push(el as HTMLImageElement);
      return el;
    }) as typeof document.createElement;
    try {
      const { dom, source } = await mountDiagram("plantuml", "@startuml\nclient\n@enduml");
      expect(seen.length, "第一次画要建过一颗 img").toBe(1);
      seen[0].dispatchEvent(new Event("load"));
      await flush();
      expect(dom.querySelector("img"), "画好的 img 要留在块里").toBeTruthy();
      await typeInto(source, "@startuml\napp\n@enduml");
      expect(seen.length, "打字期间不许再打服务器（退出编辑那一发才画）").toBe(1);
    } finally {
      document.createElement = orig as unknown as typeof document.createElement;
    }
  }, 20000);
});

describe("B457-2 · 卡片宽度变了要按新宽度重画（abc / echarts）", () => {
  // 用户：「五线谱也没有完整渲染（窗口缩放也没有自动刷新）」。这两种图把**画那一刻**的宽度写进了
  // 版式（abcjs 按 `staffwidth` 分行；ECharts 要显式尺寸）⇒ 拖分屏线、改窗口宽度之后，旧版式
  // 留在原地：宽的被卡片 `overflow:hidden` 切，窄的那一侧空一片。
  //
  // jsdom 没有 ResizeObserver ⇒ 这里塞一颗假的，测试自己发信号（`src/shell/*` 那几处同一个办法）。
  class FakeRO {
    static instances: FakeRO[] = [];
    targets: HTMLElement[] = [];
    disconnected = false;
    constructor(private cb: ResizeObserverCallback) {
      FakeRO.instances.push(this);
    }
    observe(target: HTMLElement) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    /** 假装元素量出来是这么宽：先改 `clientWidth`，再发通知（生产那一发读的就是这个值）。 */
    fire(width: number) {
      if (this.disconnected) return; // 真观察器摘掉之后不再发信号
      for (const t of this.targets) {
        Object.defineProperty(t, "clientWidth", { configurable: true, value: width });
      }
      this.cb([], this as unknown as ResizeObserver);
    }
  }

  const TUNE = 'X:1\nT:Clouds Thicken\nM:6/8\nL:1/8\nK:Em\n|:"Em"EEE E2G|\n';
  const WAVE = `{ signal: [ { name: "clk", wave: "p......" } ] }`;

  async function mountFitted(kind: DiagramKind, code: string) {
    document.body.innerHTML = "";
    FakeRO.instances = [];
    abcLedger.calls = 0;
    const view = new EditorView({
      state: EditorState.create({ doc: code }),
      parent: document.body,
    });
    const widget = new DiagramWidget(0, code.length, code, kind);
    const dom = widget.toDOM(view);
    view.dom.append(dom);
    await flush();
    const inner = dom.querySelector<HTMLElement>(".md-diagram-inner")!;
    return {
      widget,
      dom,
      inner,
      // ⚠️ 不能直接取 `instances[0]`：`new EditorView` 自己也挂了一颗 ResizeObserver
      //（盯 `.cm-scroller`）⇒ 按「盯的是不是那一格」认，否则判据读到的是 CM6 的观察器。
      ro: FakeRO.instances.find((i) => i.targets.includes(inner)),
    };
  }

  /** 比防抖那一档长一点，再把异步渲染跑完。 */
  async function settle() {
    await new Promise((r) => setTimeout(r, 250));
    await flush();
  }

  beforeEach(() => {
    abcLedger.drawsStaff = true;
    globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  });

  /** 装好五线谱那一格并要回盯着它的观察器（没装就当场抛，别把后面的断言写成空转）。 */
  async function mountAbc() {
    const m = await mountFitted("abc", TUNE);
    const ro = m.ro;
    if (!ro) throw new Error("五线谱那一格没被任何 ResizeObserver 盯住 ⇒ 宽度变了不会重画");
    return { ...m, ro };
  }

  it("按宽度排版的两种图各装一颗观察器", async () => {
    const abc = await mountFitted("abc", TUNE);
    expect(abc.ro, "五线谱没装 ⇒ 窗口缩放永远不重画").toBeTruthy();
    expect(abc.ro?.targets).toContain(abc.inner);
    const ec = await mountFitted("echarts", "{ xAxis: {}, yAxis: {}, series: [] }");
    expect(ec.ro, "ECharts 没装 ⇒ 同上").toBeTruthy();
  });

  it("固有尺寸的图种不许装（波形自己按 `period` 定宽，重画是白跑一次）", async () => {
    const wave = await mountFitted("wavedrom", WAVE);
    expect(wave.ro, "波形那一格不该被盯住").toBeUndefined();
  });

  it("第一发只记账：刚挂上时量到的宽度就是渲染用的那个，不许因此重画", async () => {
    const { ro } = await mountAbc();
    expect(abcLedger.calls, "挂载本身就画了一发").toBe(1);
    ro.fire(900);
    await settle();
    expect(abcLedger.calls, "`observe()` 立刻发来的那一发是初始值，不是「变了」").toBe(1);
  });

  it("宽度变了 ⇒ 按新宽度重画一发（谱表跟着改到 700 那一格）", async () => {
    const { ro } = await mountAbc();
    ro.fire(900);
    await settle();
    ro.fire(700);
    await settle();
    expect(abcLedger.calls, "缩了一格却没重画 ⇒ 旧版式留在原地").toBe(2);
    const p = abcLedger.params! as {
      staffwidth: number;
      paddingleft: number;
      paddingright: number;
    };
    expect(
      p.staffwidth + p.paddingleft + p.paddingright,
      "重画要按当前宽度算（SVG 总宽 = 卡片那一格扣掉它自己那 20px 内边距）",
    ).toBe(660);
  });

  it("拖分屏线是连发的 ⇒ 停手只重画一次", async () => {
    const { ro } = await mountAbc();
    ro.fire(900); // 初始那一发只记账
    ro.fire(800);
    ro.fire(750);
    ro.fire(700);
    await settle();
    expect(abcLedger.calls, "每发信号画一次 = 拖一下条要重画几十次").toBe(2);
    const p = abcLedger.params! as {
      staffwidth: number;
      paddingleft: number;
      paddingright: number;
    };
    expect(p.staffwidth + p.paddingleft + p.paddingright, "防抖之后要用最后那个宽度").toBe(660);
  });

  it("组件卸载：观察器摘掉，且防抖里那一发不能留（漏一颗 = 之后每发重画多一个幽灵）", async () => {
    const { widget, dom, ro } = await mountAbc();
    ro.fire(900); // 初始那一发只记账
    ro.fire(600); // 变更：防抖里等着
    widget.destroy!(dom);
    expect(ro.disconnected, "没调 disconnect ⇒ 这块已经不在文档里了，观察器还挂着").toBe(true);
    await settle();
    expect(abcLedger.calls, "摘掉时没清那颗延时 ⇒ 卸载后还会画一次").toBe(1);
  });
});

describe("B457-2b · 不同图种不许共用同一份 DOM（真机「缩放不重画」的病灶）", () => {
  // 真机取证（`.tmp/b457-ro.py` + `.tmp/b457-chain.py`）：窗口宽度变了，环境里现挂的观察器
  // 正常开火（1065→587→1065），产品那条重画链却压根没动 —— 因为**观察器根本没挂上**。
  //
  // 根因在 CM6：`findWidget` 第一趟按 `compare()`（= `eq`）找，第二趟放宽到「同一个构造器」
  // 就直接问 `updateDOM`（@codemirror/view `dist/index.js` 里 pass==1 那一支）。我们这边
  // `updateDOM` 无条件返回 true ⇒ 五线谱的 widget 被嫁接到甘特图建好的那块 DOM 上：
  // 类名还是 `md-mermaid-widget/md-mermaid-inner`（toDOM 那一刻 kind=mermaid 打的），
  // 内容却是 abcjs 画的谱 —— 而 `attachWidthRefit` 是 mermaid 那一发跑的（不在按宽度重排
  // 的名单里）⇒ 直接早退，这块格子从此没人盯着宽度。
  const TUNE = 'X:1\nT:Clouds Thicken\nM:6/8\nL:1/8\nK:Em\n|:"Em"EEE E2G|\n';
  const GANTT = "gantt\n    title A Gantt Diagram\n    dateFormat YYYY-MM-DD\n";

  function pair() {
    document.body.innerHTML = "";
    const view = new EditorView({ state: EditorState.create({ doc: "x" }), parent: document.body });
    const mermaid = new DiagramWidget(0, 10, GANTT, "mermaid");
    const abc = new DiagramWidget(0, 10, TUNE, "abc");
    return { view, mermaid, abc, mermaidDom: mermaid.toDOM(view) };
  }

  it("别的图种来嫁接 ⇒ 拒绝（返回 false），让 CM6 重新 toDOM 打一遍类名", () => {
    const { view, mermaid, abc, mermaidDom } = pair();
    expect(abc.updateDOM(mermaidDom, view, mermaid), "五线谱接在了 mermaid 那块 DOM 上").toBe(
      false,
    );
  });

  it("同图种换内容 ⇒ 照旧复用（不许把这条闸扩成「每次更新都重建」）", () => {
    const { view, abc } = pair();
    const dom = abc.toDOM(view);
    const edited = new DiagramWidget(0, 10, abc.code + "|:F#2|\n", "abc");
    expect(edited.updateDOM(dom, view, abc)).toBe(true);
  });

  it("五线谱那块 DOM 不许带 mermaid 的历史类名（类名 = 这块是谁建的）", () => {
    const { view, mermaid, abc, mermaidDom } = pair();
    // 嫁接被拒之后，CM6 走的是 `abc.toDOM()` ⇒ 类名跟着本种走
    const fresh = abc.toDOM(view);
    expect(fresh.className).not.toContain("md-mermaid-widget");
    expect(fresh.querySelector(".md-diagram-inner")!.className).not.toContain("md-mermaid-inner");
    expect(abc.updateDOM(mermaidDom, view, mermaid), "先证明那块确实是 mermaid 建的").toBe(false);
  });
});
