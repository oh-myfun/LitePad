// B391F-4 · 装饰面的块级富构造：公式 / mermaid。
//
// 形状照 InkNote 的 `editor/widgets/{math,mermaid}.ts`（本机参照
// E:\Project\InkNote\InkNote），**渲染器不照**：InkNote 在 widget 里直调
// `katex.renderToString` 与 `mermaid.render`，LitePad 这两发已经有唯一出口
// `markdown/enhance.enhanceMarkdown`（B352-2 抽它就是为了「别把四件事抄进每个渲染面」）。
// 所以这里的 widget 只负责「把源码区间换成一个占位节点 + 请 enhance 来认领」：
//
//   · 公式 → `.math-inline-src` / `.math-display-src`（KaTeX，懒加载）
//   · mermaid → `pre.mermaid-src`（懒加载 mermaid，`bigDoc` 档位照旧不画）
//
// 两条都因此与现方案共享同一份主题口径（Shiki 双主题、`--shiki-light/dark`、
// 大文档降级），不会出现「预览格两种实现各渲染各的」那种漂移。
//
// ⚠️ 表格不在这个文件里了：B397-3b 把它换成**可就地编辑**的那一颗（`tableWidget.ts`），
// 内容由手写的 `parseTable` 拆格而不是 `renderFull` —— 写回源码要按格改，整段 HTML 做不到。
//
// ⚠️ 与 InkNote 的差异：公式仍是只读占位；**mermaid 已按它的两段式补上就地编辑**
// （B434：平时看图，点图在原位换源码区 —— 结构照 InkNote `mermaid.ts`，
// 机械复用本仓的 `editableSource` / `.md-block-source`）。公式的源码区不在本轮。

import { EditorView, WidgetType } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { settings } from "../core/app-state";
import { diagramClass, type DiagramKind } from "../markdown/diagrams";
import { enhanceMarkdown, nextEnhanceSeq } from "../markdown/enhance";
import { LAZY_THRESHOLD_LINES } from "../editor/perf";
import { bindBlockBoundaryCursor, bindBlockClickEdit, stampBlockRange } from "./blockRange";
import {
  attachSourceEditing,
  beginSourceEditing,
  clickedOnBlockPadding,
  makePlainTextEditable,
  sourceText,
} from "./editableSource";

/** 大文档档位与派生 DOM 共用一个阈值（超过就不自动跑 mermaid / Shiki）。 */
function bigDocOf(view: EditorView): boolean {
  return view.state.doc.lines > LAZY_THRESHOLD_LINES;
}

/**
 * 主题代数（B412）：mermaid 的 `theme:` 是 `render` 那一刻读的，而 widget DOM 只要
 * `eq()` 判等就会被 CM6 复用 ⇒ 切主题后必须让这几类 widget 判不等，重建 DOM 重画一遍。
 * KaTeX / Shiki 跟 CSS 变量走，重建只是顺带，代价可以忽略。
 */
let widgetThemeGen = 0;

/** 主题翻了 ⇒ 换代（下一发重建装饰时 `eq()` 自然判不等）。 */
export function bumpWidgetThemeGen(): void {
  widgetThemeGen += 1;
}

/**
 * 请 `enhanceMarkdown` 把这一个 widget 里的占位认领掉，画完之后让 CM6 重量一次行高。
 *
 * `requestMeasure` 不是可选的：KaTeX / mermaid 都是异步落地的，落地那一发把一行
 * 变成三行高，不重新测量的话 `scrollHeight` 与行号图都停在估算值上 ——
 * 那正是派生 DOM 那条线当年 B272/B282 那一族「底部留白 / 滚不到顶」的来源。
 */
function enhanceThenMeasure(el: HTMLElement, view: EditorView): void {
  const seq = nextEnhanceSeq(el);
  enhanceMarkdown(el, seq, {
    bigDoc: bigDocOf(view),
    baseDir: null,
    // 现读：设置页改完服务器，下一次重画就吃新值（与搜索那两格同一口径，不需要启动回放）。
    plantumlServer: settings?.plantuml_server,
  })
    .then(() => view.requestMeasure())
    .catch(() => {
      /* 加载失败就停在占位文本（与预览格同一口径） */
    });
}

/** 公式占位：整层换成 enhance 认领的那一形（KaTeX 懒加载；重画时也走这里）。 */
function renderMathPlaceholder(
  holder: HTMLElement,
  tex: string,
  display: boolean,
  view: EditorView,
): void {
  const ph = document.createElement("span");
  ph.className = display ? "math-display-src" : "math-inline-src";
  ph.textContent = tex;
  holder.replaceChildren(ph);
  if (!tex.trim()) {
    // 空公式（`$$` 连写）enhance 会跳过，这里给一个不撒谎的占位
    holder.classList.add("md-math-empty");
    ph.textContent = "$$";
    return;
  }
  holder.classList.remove("md-math-empty");
  enhanceThenMeasure(holder, view);
}

/** 公式：行内 `$…$` 与块级 `$$…$$`（`block` 由扫描器按「是否占满整行」定）。 */
export class MathWidget extends WidgetType {
  /** 建那一刻的主题代数：换主题后新旧不等 ⇒ 重建 DOM（见 `bumpWidgetThemeGen`）。 */
  readonly gen = widgetThemeGen;

  constructor(
    readonly from: number,
    readonly to: number,
    readonly tex: string,
    readonly block: boolean,
  ) {
    super();
  }

  /** 只比内容与形状，不比绝对位置：上方编辑会挪位置，比位置等于每敲一键重建一遍。 */
  eq(other: MathWidget): boolean {
    return (
      other.gen === this.gen &&
      other.tex === this.tex &&
      other.block === this.block &&
      other.to - other.from === this.to - this.from
    );
  }

  toDOM(view: EditorView): HTMLElement {
    return this.block ? this.blockDOM(view) : this.inlineDOM(view);
  }

  /** 行内公式不做源码区：点一下把光标送进 `$…$`，替换装饰由 reveal 窗口撤掉露原文。 */
  private inlineDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "md-math-widget";
    renderMathPlaceholder(span, this.tex, false, view);
    bindBlockClickEdit(span, this.from, this.to);
    return span;
  }

  /** 块级公式：两段式（照 InkNote 的 `BlockMathWidget`）—— 点公式改 LaTeX，下方实时预览。 */
  private blockDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-block md-math-widget md-math-block";
    stampBlockRange(wrap, this.from, this.to);

    const source = document.createElement("div");
    source.className = "md-block-source";
    makePlainTextEditable(source);
    source.textContent = this.tex;

    const render = document.createElement("div");
    render.className = "md-math-render";
    renderMathPlaceholder(render, this.tex, true, view);

    wrap.append(source, render);
    bindBlockBoundaryCursor(wrap, render);

    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => `$$\n${text.trim()}\n$$`,
      indentOnTab: false,
      // InkNote 同一条：打字时下方公式跟着变（KaTeX 同步、便宜）
      onInput: (text) => renderMathPlaceholder(render, text.trim(), true, view),
      onEditingChange: (editing) => {
        if (editing) return;
        renderMathPlaceholder(render, sourceText(source).trim(), true, view);
      },
    });

    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (!render.contains(event.target as Node)) return;
      const v = EditorView.findFromDOM(wrap);
      if (!v || v.state.readOnly) return;
      event.preventDefault();
      beginSourceEditing(wrap, source);
    });

    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // 行内公式没有要保的焦点（点进来就换成原文了）⇒ 交给 CM6 重建更省事
    if (!this.block) return false;
    const source = dom.querySelector<HTMLElement>(".md-block-source");
    const render = dom.querySelector<HTMLElement>(".md-math-render");
    if (!source || !render) return false;
    stampBlockRange(dom, this.from, this.to);
    if (document.activeElement === source) return true;
    if (sourceText(source) !== this.tex) source.textContent = this.tex;
    renderMathPlaceholder(render, this.tex, true, view);
    return true;
  }

  /** 组件内交互自理；点在外层留白上的鼠标事件交还编辑器定位光标。 */
  ignoreEvent(event: Event): boolean {
    if (!this.block) return true;
    return !clickedOnBlockPadding(event, "md-math-block");
  }
}

/** 把一段图源摆成 enhance 认领的占位（重画时整层换掉上一次的结果）。 */
function renderDiagramPlaceholder(
  kind: DiagramKind,
  inner: HTMLElement,
  code: string,
  view: EditorView,
): void {
  const pre = document.createElement("pre");
  pre.className = diagramClass(kind, "diagram-src", "mermaid-src");
  pre.dataset.diagram = kind;
  pre.textContent = code;
  inner.replaceChildren(pre);
  enhanceThenMeasure(inner, view);
}

/**
 * 「画那一刻的宽度写进了版式」的图种（B457-2）：abcjs 按 `staffwidth` 分行排谱表，ECharts 要显式
 * 像素尺寸。余下的（mermaid / Graphviz / Flowchart / PlantUML / WaveDrom）按内容自己定宽，脑图
 * markmap 内部本来就带一台跟随容器的观察器 ⇒ 给它们重画只是白跑一次。
 */
const WIDTH_FITTED_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>(["abc", "echarts"]);

/** 拖分屏线 / 改窗口宽度是连发信号 ⇒ 停手再画（比实时重画那 400ms 短，缩放的手感要跟得上）。 */
const REFIT_DEBOUNCE_MS = 160;

const widthRefits = new WeakMap<
  HTMLElement,
  { ro: ResizeObserver; width: number; timer?: number }
>();

/**
 * 卡片那一格变宽窄就按新宽度重画一发（用户：「窗口缩放也没有自动刷新」）。
 *
 * ⚠️ 第一发通知不算「变了」：`toDOM()` 那一刻整棵树还在文档外（`clientWidth` 量到 0），
 * `observe()` 立刻发来的那一发才是它的真实宽度 ⇒ 只记账、不动笔（否则挂载即双份渲染）。
 */
function attachWidthRefit(inner: HTMLElement, kind: DiagramKind, redraw: () => void): void {
  if (!WIDTH_FITTED_KINDS.has(kind) || typeof ResizeObserver !== "function") return;
  detachWidthRefit(inner);
  const state: { ro: ResizeObserver; width: number; timer?: number } = {
    ro: null as unknown as ResizeObserver,
    // -1 = 「还没量过」：`toDOM()` 那一刻这块还在文档外，量到的 0 不是它的真实宽度。
    width: -1,
  };
  state.ro = new ResizeObserver(() => {
    const width = inner.clientWidth;
    if (width === state.width) return;
    // 挂载后的第一发只是「它原来多宽」（-1 = 还没记过），不是「变宽了」⇒ 记账，不动笔。
    const first = state.width < 0;
    state.width = width;
    if (first) return;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.timer = undefined;
      if (inner.isConnected) redraw();
    }, REFIT_DEBOUNCE_MS);
  });
  state.ro.observe(inner);
  widthRefits.set(inner, state);
}

/** 卸载必须摘掉：观察器强引用着目标，摘不掉等于把整块 widget 的 DOM 一直拖在内存里。 */
function detachWidthRefit(inner: HTMLElement): void {
  const state = widthRefits.get(inner);
  if (!state) return;
  widthRefits.delete(inner);
  window.clearTimeout(state.timer);
  state.ro.disconnect();
}

/**
 * 「点了一下图」到「浮出源码框」之间的那一拍（B456-2）。
 *
 * 源码框开在图的**上方** ⇒ 当场开就把图往下顶，用户双击的第二发会落到源码框里（还顺手选个词），
 * 「双击复位」根本轮不到。这一拍只要盖住「第二发点击之前」就够：开晚了用户觉得点了没反应，
 * 开早了双击必崩。
 */
const TAP_SETTLE_MS = 200;

/**
 * 图围栏（B452）：占位 `pre.diagram-src[data-diagram]` 交给 enhance 里那一发懒 import 画成 SVG。
 *
 * `kind` 默认 `mermaid` ⇒ 旧的 mermaid 调用形状不变；mermaid 的历史类名一律叠在通用类名后面
 * （preview.css 与十几条判据指着旧名，见 `markdown/diagrams.ts` 文件头）。
 */
export class DiagramWidget extends WidgetType {
  /** 同 `MathWidget.gen`：图的配色只在 `render` 那一刻定。 */
  readonly gen = widgetThemeGen;

  constructor(
    readonly from: number,
    readonly to: number,
    readonly code: string,
    readonly kind: DiagramKind = "mermaid",
  ) {
    super();
  }

  eq(other: DiagramWidget): boolean {
    return (
      other.gen === this.gen &&
      other.kind === this.kind &&
      other.code === this.code &&
      other.to - other.from === this.to - this.from
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `md-block ${diagramClass(this.kind, "md-diagram-widget", "md-mermaid-widget")}`;
    stampBlockRange(wrap, this.from, this.to);

    // B434：两段式（照 InkNote `mermaid.ts`）—— 平时看图；点图在原位换源码区。
    const source = document.createElement("div");
    source.className = "md-block-source";
    makePlainTextEditable(source);
    source.textContent = this.code;

    const inner = document.createElement("div");
    inner.className = diagramClass(this.kind, "md-diagram-inner", "md-mermaid-inner");
    renderDiagramPlaceholder(this.kind, inner, this.code, view);
    // B457-2：这两种图把宽度写进了版式 ⇒ 宽度一变就要重画。文本现取源码框那一份
    //（编辑期间改过内容，重画不许画回围栏里旧的）。
    attachWidthRefit(inner, this.kind, () =>
      renderDiagramPlaceholder(this.kind, inner, sourceText(source), view),
    );

    // 外层只管留白，视觉盒放内层（根元素带 margin 会破坏高度测量）
    const box = document.createElement("div");
    box.className = diagramClass(this.kind, "md-diagram-box", "md-mermaid-box");
    box.append(source, inner);
    wrap.appendChild(box);
    bindBlockBoundaryCursor(wrap, box);

    // B454（用户：「所有图表编辑时统一使用预览 + 源码同时显示的方式，参考 inknote 那样」）：
    // 源码框浮上来，图留在下面**不藏**，且打字停手 400ms 跟着重画（InkNote `mermaid.ts:94` 同
    // 一把尺）。PlantUML 例外 —— 它发给在线服务器画，每停一下发一次请求太贵，半截语法还会回一
    // 张写着错误文案的图（用户拍板：不实时重画，退出编辑那一发才画）。
    let liveRedraw = 0;
    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => `\`\`\`${this.kind}\n${text.replace(/\n+$/, "")}\n\`\`\``,
      indentOnTab: true,
      onInput: (text) => {
        if (this.kind === "plantuml") return;
        window.clearTimeout(liveRedraw);
        liveRedraw = window.setTimeout(
          () => renderDiagramPlaceholder(this.kind, inner, text, view),
          400,
        );
      },
      onEditingChange: (editing) => {
        if (editing) return;
        // 退出编辑：补上打字期间被防抖吃掉的那几发，以源码框里的最终文本为准
        window.clearTimeout(liveRedraw);
        renderDiagramPlaceholder(this.kind, inner, sourceText(source), view);
      },
    });

    // 点画好的图 ⇒ 进源码编辑；只读档在 `beginSourceEditing` 里早退，图照常可读可复制。
    //
    // B455-5/6：「点一下」这笔账由变换层（`diagramViewport`）判 —— 拖过阈值是搬图，没拖过才是
    // 点图，判出来回发一颗 `md-diagram-tap`。这里不再直接吃 mousedown：那样一来拖一下等于改一次
    // 文档，而且脑图那颗 d3-zoom 会 `stopImmediatePropagation()`（B454-2 真机抓的「脑图点不动」）。
    //
    // B456-2 · 浮源码框这一发**延后一拍**：源码框开在图的上方 ⇒ 当场开就会把图往下顶，
    // 用户双击的第二发落到源码框里（还顺手选了个词），「双击复位」根本轮不到。
    // 延后期里来了 `md-diagram-reset`（变换层判定这一下是双击=视图操作）⇒ 整发取消，不进编辑态。
    let openPending: number | undefined;
    wrap.addEventListener("md-diagram-tap", () => {
      const v = EditorView.findFromDOM(wrap);
      if (!v || v.state.readOnly) return;
      window.clearTimeout(openPending);
      openPending = window.setTimeout(() => {
        openPending = undefined;
        beginSourceEditing(wrap, source);
      }, TAP_SETTLE_MS);
    });
    wrap.addEventListener("md-diagram-reset", () => {
      if (openPending === undefined) return; // 用户本来就在改这张图 ⇒ 复位视图不许抢走源码框
      window.clearTimeout(openPending);
      openPending = undefined;
    });

    // 剩下那一形：bigDoc 档位 / 画失败时留下的是**源码占位**，没有可缩放的那一格，点了就进编辑。
    //
    // ⚠️ 两颗放行都是必需的：这条挂在 `wrap` 的捕获相比变换层（挂在**卡片**上）**先**跑，
    // 所以画好的图和右上角按键条都会从这里过一遍 —— 放行条件写漏一个，就是
    // 「点图进不了编辑」或「放大键按不动」（后者是 B455-7 真机抓的）。
    wrap.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (!target || !inner.contains(target)) return;
        // 画好的图与右上角三颗键都归变换层那一臂（tap 事件 / 直接缩放）
        if (target.closest(".md-diagram-canvas, .md-diagram-zoom")) return;
        const v = EditorView.findFromDOM(wrap);
        if (!v || v.state.readOnly) return;
        event.preventDefault();
        beginSourceEditing(wrap, source);
      },
      true,
    );

    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView, prev?: WidgetType): boolean {
    // CM6 找可复用的块 widget 分两趟：第一趟按 `eq` 比，第二趟只认「同一个构造器」，就把别的
    // 实例的旧 DOM 递过来问一句 `updateDOM`（`view` 的 `findWidget` 里 pass==1 那一支）。
    // 图种不同 ⇒ 这块 DOM 的类名与 `toDOM` 那一刻挂的观察器都是按原主打的：接下去画会变成
    // 「名字是 mermaid、内容是五线谱」的混合体，而按宽度重排那条链永远挂不上
    // （B457-2 真机：窗口缩放后五线谱不重画，`<svg width>` 停在旧值）。让它重新 toDOM。
    if (!(prev instanceof DiagramWidget) || prev.kind !== this.kind) return false;
    const source = dom.querySelector<HTMLElement>(".md-block-source");
    const inner = dom.querySelector<HTMLElement>(".md-diagram-inner");
    if (!source || !inner) return false;
    stampBlockRange(dom, this.from, this.to);
    // 正在打字的源码区不能重写（否则光标被打掉）；图也等退出编辑那一发再画
    if (document.activeElement === source) return true;
    if (sourceText(source) !== this.code) source.textContent = this.code;
    renderDiagramPlaceholder(this.kind, inner, this.code, view);
    return true;
  }

  /** `updateDOM` 复用同一颗 `inner` ⇒ 观察器接着用；整块离场才摘（B457-2）。 */
  destroy(dom: HTMLElement): void {
    const inner = dom.querySelector<HTMLElement>(".md-diagram-inner");
    if (inner) detachWidthRefit(inner);
  }

  /** 组件内交互自理；点在外层留白上的鼠标事件交还编辑器定位光标。 */
  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-diagram-widget");
  }
}

// ---------------------------------------------------------------- 公式扫描
// 移植自 InkNote src/editor/widgets/math.ts:160-244（`scanMath`）。
// lezer 的 markdown 没有数学节点，所以这一类只能按文本扫。

export interface MathRange {
  from: number;
  to: number;
  tex: string;
  block: boolean;
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /[0-9]/.test(c);

function occupiesWholeLines(doc: Text, from: number, to: number): boolean {
  return doc.lineAt(from).from === from && doc.lineAt(to).to === to;
}

/**
 * 扫描文档中的数学公式区间（排除代码里）。
 *
 * 行内公式采用与 Typora 一致的保守规则，避免把金额当成公式：开定界符后必须紧跟
 * 非空白、闭定界符前必须是非空白、闭定界符后不能紧跟数字（`价格 $5 到 $10 元` 不算）。
 * 与 `markdown/pipeline.ts` 那条 markdown-it 内联规则同口径 —— 两种预览实现
 * 对「什么算公式」的答案必须一致，否则对标矩阵里这一行永远对不平。
 */
export function scanMath(
  doc: Text,
  inCode: (from: number, to: number) => boolean,
  sourceText?: string,
): MathRange[] {
  const text = sourceText ?? doc.sliceString(0, doc.length);
  const results: MathRange[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2; // 跳过转义（含 \$）
      continue;
    }
    if (ch !== "$") {
      i++;
      continue;
    }
    if (text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close < 0) {
        i += 2;
        continue;
      }
      const from = i;
      const to = close + 2;
      if (!inCode(from, to)) {
        results.push({
          from,
          to,
          tex: text.slice(from + 2, close).trim(),
          block: occupiesWholeLines(doc, from, to),
        });
      }
      i = to;
      continue;
    }
    if (isSpace(text[i + 1])) {
      i++;
      continue;
    }
    let j = i + 1;
    let close = -1;
    while (j < text.length) {
      const c = text[j];
      if (c === "\n") break;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "$") {
        if (!isSpace(text[j - 1]) && !isDigit(text[j + 1])) close = j;
        break;
      }
      j++;
    }
    if (close < 0) {
      i++;
      continue;
    }
    const from = i;
    const to = close + 1;
    if (!inCode(from, to)) {
      results.push({ from, to, tex: text.slice(from + 1, close).trim(), block: false });
    }
    i = to;
  }
  return results;
}
