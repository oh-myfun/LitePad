// 壳移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/codeBlock.ts:131-315
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 唯一的块级 widget：围栏代码。
//
// 与 InkNote 的两处有意差异：
// 1. 高亮走 LitePad 现成的 Shiki 出口（`markdown/enhance.enhanceMarkdown`），不引 hljs ——
//    复用同一发懒加载与「双主题 `--shiki-light/--shiki-dark` + 主题档切换」的既有口径。
// 2. spike 的装饰面是**只读**的，所以不搬 `attachSourceEditing`（原位编辑），
//    `ignoreEvent()` 也返回 false：让 CM6 正常处理事件，块里的代码仍可原生选中复制。

import { WidgetType, type EditorView } from "@codemirror/view";
import { enhanceMarkdown, nextEnhanceSeq } from "../../markdown/enhance";
import { LAZY_THRESHOLD_LINES } from "../../editor/perf";

export class CodeBlockWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly code: string,
    readonly lang: string,
  ) {
    super();
  }

  /**
   * 只比「长度 + 内容 + 语言」，不比绝对位置。
   *
   * CM6 在 `eq()` 判相等时直接复用旧 DOM（既不调 `toDOM` 也不调 `updateDOM`）。
   * 文档上方发生编辑时整块的绝对位置会变，但内容没变 —— 比位置就等于每敲一次
   * 键就把所有代码块重建一遍（Shiki 也跟着重跑）。
   */
  eq(other: CodeBlockWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.code === this.code &&
      other.lang === this.lang
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-block md-code-widget";
    const pre = document.createElement("pre");
    pre.className = "md-code";
    // `data-lang` 是 enhanceMarkdown 认领这一发的唯一凭据（与 markdown-it 那条渲染链同款）
    pre.dataset.lang = this.lang || "text";
    const code = document.createElement("code");
    code.textContent = this.code;
    pre.appendChild(code);
    wrap.appendChild(pre);

    const seq = nextEnhanceSeq(wrap);
    // B391F-3：大文档那一档与派生 DOM 共用同一个阈值（原先这里写死 `false`，
    // 结果同一篇 5001 行文档，装饰面比现方案多跑一整轮 Shiki —— spike 结果文档①P3-2
    // 那条不对称）。行数就在手上，不必为此把 opts 一路穿到 buildPreviewSets。
    enhanceMarkdown(wrap, seq, {
      bigDoc: view.state.doc.lines > LAZY_THRESHOLD_LINES,
      baseDir: null,
    })
      .then(() => {
        // 高亮回来的那一发可能改了行高，让 CM 重新量一次
        view.requestMeasure();
      })
      .catch(() => {
        // 加载失败就停在纯文本（与预览格同一口径）
      });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
