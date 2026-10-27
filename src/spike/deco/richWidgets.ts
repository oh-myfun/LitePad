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
// ⚠️ 与 InkNote 的有意差异：它的 math/mermaid widget 带源码区就地编辑
// （`editableSource` + `.md-block-source` 那一层显隐），这里两条还是只读占位。

import { WidgetType, type EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { enhanceMarkdown, nextEnhanceSeq } from "../../markdown/enhance";
import { LAZY_THRESHOLD_LINES } from "../../editor/perf";

/** 大文档档位与派生 DOM 共用一个阈值（超过就不自动跑 mermaid / Shiki）。 */
function bigDocOf(view: EditorView): boolean {
  return view.state.doc.lines > LAZY_THRESHOLD_LINES;
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
  enhanceMarkdown(el, seq, { bigDoc: bigDocOf(view), baseDir: null })
    .then(() => view.requestMeasure())
    .catch(() => {
      /* 加载失败就停在占位文本（与预览格同一口径） */
    });
}

/** 公式：行内 `$…$` 与块级 `$$…$$`（`block` 由扫描器按「是否占满整行」定）。 */
export class MathWidget extends WidgetType {
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
      other.tex === this.tex &&
      other.block === this.block &&
      other.to - other.from === this.to - this.from
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement(this.block ? "div" : "span");
    wrap.className = this.block ? "md-block md-math-widget md-math-block" : "md-math-widget";
    const ph = document.createElement("span");
    ph.className = this.block ? "math-display-src" : "math-inline-src";
    ph.textContent = this.tex;
    wrap.appendChild(ph);
    if (!this.tex.trim()) {
      // 空公式（`$$` 连写 / `$ $`）enhance 会跳过，这里给一个不撒谎的占位
      wrap.classList.add("md-math-empty");
      ph.textContent = this.block ? "$$" : "$$";
    } else {
      enhanceThenMeasure(wrap, view);
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** mermaid 围栏：占位 `pre.mermaid-src` 交给 enhance 里那一发懒 import 画成 SVG。 */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly code: string,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.to - other.from === this.to - this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-block md-mermaid-widget";
    const pre = document.createElement("pre");
    pre.className = "mermaid-src";
    pre.textContent = this.code;
    wrap.appendChild(pre);
    enhanceThenMeasure(wrap, view);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
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
