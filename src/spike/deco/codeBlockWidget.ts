// 壳移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/codeBlock.ts:131-315
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-3 · 围栏代码块的**就地编辑**。
//
// 与 InkNote 的两处有意差异（其余每一根线照抄）：
// 1. 高亮器：InkNote 每敲一键同步跑一次 hljs；LitePad 的高亮器是 Shiki（异步、要懒加载、
//    还要跟主题族出双份色），逐键跑等于把 B391F-6 刚压下来的击键成本再抬回去。
//    所以这里改成「**打字期间纯文本，退出编辑/外部改动时才上色**」—— 上色那一发
//    只换 `<pre>` 里的内容，换完把可编辑标记重新贴回新的 `<code>` 上（事件全挂在根节点，
//    跟着冒泡，不换监听）。
// 2. 只读锁：InkNote 用 `state.readOnly` 在每条路径上早退；LitePad 的锁还多一道
//    `transactionFilter`（wysiwyg.ts），所以这里照抄它的早退，锁只是兜底。
//
// ⚠️ `updateDOM` 是这一整片的存在理由：CM6 在 `eq()` 判不等时先试 `updateDOM`，
// 返回 false 才重建 DOM（view/dist:2566-2568）。少了它 ⇒ 每敲一键整块换新 ⇒ 光标被打掉，
// 「就地编辑」就退化成「点一下跳回源码」。

import { EditorView, WidgetType } from "@codemirror/view";
import { highlightCodeHtml } from "../../markdown/highlight";
import { LAZY_THRESHOLD_LINES } from "../../editor/perf";
import { currentBlockRange, stampBlockRange, bindBlockBoundaryCursor } from "./blockRange";
import {
  attachSourceEditing,
  clickedOnBlockPadding,
  makePlainTextEditable,
  setCaretOffset,
  sourceText,
} from "./editableSource";

/** 语言下拉里的候选项（照 InkNote 那份表；LitePad 的 Shiki 认不出的会停在纯文本）。 */
export const LANGUAGE_OPTIONS = [
  "",
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "go",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "markdown",
  "mermaid",
  "php",
  "python",
  "ruby",
  "rust",
  "sql",
  "toml",
  "typescript",
  "xml",
  "yaml",
];

const LANGUAGE_LABELS: Record<string, string> = {
  cpp: "C++",
  csharp: "C#",
  javascript: "JavaScript",
  typescript: "TypeScript",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  xml: "XML",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  php: "PHP",
  go: "Go",
};

function normalizeLang(info: string): string {
  const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (raw === "tsx") return "typescript";
  if (raw === "jsx") return "javascript";
  return raw;
}

function langLabel(lang: string): string {
  return LANGUAGE_LABELS[lang] ?? (lang || "纯文本");
}

/** 把代码写进元素（纯文本）；结尾换行补一个空文本节点，否则最后一行点不进去。 */
function paintCode(codeEl: HTMLElement, code: string): void {
  codeEl.textContent = code;
  if (code.endsWith("\n")) codeEl.appendChild(document.createTextNode(""));
}

function paintGutter(gutter: HTMLElement, code: string): void {
  const lines = code.split("\n").length;
  let text = "";
  for (let i = 1; i <= lines; i++) text += (i > 1 ? "\n" : "") + i;
  if (gutter.textContent !== text) gutter.textContent = text;
}

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
   * 文档上方一编辑，整块绝对位置就变了而内容没变 —— 比位置等于每敲一键把所有代码块
   * 重建一遍。内容真变了也不等于重建：那时走 `updateDOM`（见文件头）。
   */
  eq(other: CodeBlockWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.code === this.code &&
      other.lang === this.lang
    );
  }

  private serialize(code: string, lang: string): string {
    return `\`\`\`${lang.trim()}\n${code.replace(/\n+$/, "")}\n\`\`\``;
  }

  /** 上色只在**没在打字**时跑：换 `<pre>` 会打掉光标，边打字边上色就是边打字边打断。 */
  private paintHighlight(
    view: EditorView | null,
    wrap: HTMLElement,
    codeEl: HTMLElement,
    lang: string,
  ): void {
    // `view` 由调用方给：`toDOM` 那一刻这颗 DOM 还没进文档，`findFromDOM` 只会给 null
    const normalized = normalizeLang(lang);
    if (!normalized || !view) return;
    if (view.state.doc.lines > LAZY_THRESHOLD_LINES) return; // 大文档档：与派生 DOM 同一口径
    const code = sourceText(codeEl);
    void highlightCodeHtml(code, normalized).then((html) => {
      if (!html || !codeEl.isConnected) return;
      if (wrap.contains(document.activeElement)) return;
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const pre = holder.firstElementChild as HTMLElement | null;
      const oldPre = codeEl.closest("pre");
      if (!pre || !oldPre) return;
      pre.dataset.lang = normalized;
      const nextCode = pre.querySelector<HTMLElement>("code");
      if (nextCode) makePlainTextEditable(nextCode);
      oldPre.replaceWith(pre);
      // 高亮落地可能改了行高 ⇒ 让 CM 重量一次（不然高度图停在估算值上）
      view.requestMeasure();
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-block md-codeblock-widget";
    stampBlockRange(wrap, this.from, this.to);

    // 外层只负责纵向留白，视觉盒子放内层：根元素带 margin 会让 CM 的高度图算不准
    const box = document.createElement("div");
    box.className = "md-codeblock-box";
    wrap.appendChild(box);

    const gutter = document.createElement("div");
    gutter.className = "md-codeblock-gutter";
    // 属性而不是 .contentEditable：判「这一格能不能落光标」看的是属性（见 makePlainTextEditable）
    gutter.setAttribute("contenteditable", "false");
    paintGutter(gutter, this.code);

    const pre = document.createElement("pre");
    pre.className = "md-code";
    pre.dataset.lang = normalizeLang(this.lang) || "text";
    const codeEl = document.createElement("code");
    makePlainTextEditable(codeEl);
    paintCode(codeEl, this.code);
    pre.appendChild(codeEl);

    box.appendChild(gutter);
    box.appendChild(pre);

    const header = document.createElement("div");
    header.className = "md-codeblock-header";
    header.setAttribute("contenteditable", "false");

    const languageControl = document.createElement("div");
    languageControl.className = "md-codeblock-language-control";
    languageControl.setAttribute("contenteditable", "false");

    const select = document.createElement("select");
    select.className = "md-codeblock-lang";
    const current = normalizeLang(this.lang);
    const options = LANGUAGE_OPTIONS.includes(current)
      ? LANGUAGE_OPTIONS
      : [...LANGUAGE_OPTIONS, current];
    for (const value of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = langLabel(value);
      if (value === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.value = current;
    const languageLabel = document.createElement("span");
    languageLabel.className = "md-codeblock-language-label";
    languageLabel.textContent = langLabel(current);
    select.addEventListener("mousedown", (e) => e.stopPropagation());
    select.addEventListener("change", () => {
      const v = EditorView.findFromDOM(wrap);
      const range = v && currentBlockRange(v, wrap);
      if (!v || !range) return;
      if (v.state.readOnly) return;
      const code = sourceText(wrap.querySelector('[data-block-source="1"]') ?? codeEl);
      v.dispatch({
        changes: { from: range.from, to: range.to, insert: this.serialize(code, select.value) },
        userEvent: "input.codeblock",
      });
      v.focus();
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "md-codeblock-copy";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(sourceText(codeEl) || this.code);
      copyBtn.textContent = "已复制";
      window.setTimeout(() => {
        copyBtn.textContent = "复制";
      }, 1200);
    });

    header.appendChild(copyBtn);
    languageControl.appendChild(select);
    languageControl.appendChild(languageLabel);
    box.appendChild(header);
    box.appendChild(languageControl);
    bindBlockBoundaryCursor(wrap, box);

    attachSourceEditing(wrap, {
      // 上色那一发会把 `<code>` 整个换掉 ⇒ 每次现查，不闭包旧节点
      source: () => wrap.querySelector<HTMLElement>('[data-block-source="1"]'),
      toMarkdown: (text) => this.serialize(text, select.value),
      onInput: (text) => {
        // 打字期间只修行号栏：上色留给退出编辑那一发（见文件头第 1 条）
        paintGutter(gutter, text);
      },
      onEditingChange: (editing) => {
        if (editing) return;
        const live = wrap.querySelector<HTMLElement>('[data-block-source="1"]');
        if (live) this.paintHighlight(view, wrap, live, select.value);
      },
      indentOnTab: true,
      exitOnTrailingBlankLine: true,
    });

    // 点在代码区以外的盒内留白也进入编辑；外层留白不抢点击
    wrap.addEventListener("mousedown", (event) => {
      const v = EditorView.findFromDOM(wrap);
      const live = wrap.querySelector<HTMLElement>('[data-block-source="1"]');
      if (!live) return;
      if (v?.state.readOnly) {
        // 只读预览不进入源码编辑，但必须保留浏览器原生文本框选
        if (live.contains(event.target as Node)) return;
        if ((event.target as HTMLElement).closest(".md-codeblock-header")) return;
        event.preventDefault();
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest(".md-codeblock-header")) return;
      if (!box.contains(target)) return;
      if (live.contains(target) || target === live) return;
      event.preventDefault();
      live.focus();
      setCaretOffset(live, sourceText(live).length);
    });

    this.paintHighlight(view, wrap, codeEl, this.lang);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const codeEl = dom.querySelector<HTMLElement>('[data-block-source="1"]');
    const select = dom.querySelector<HTMLSelectElement>(".md-codeblock-lang");
    const gutter = dom.querySelector<HTMLElement>(".md-codeblock-gutter");
    if (!codeEl || !select || !gutter) return false;

    stampBlockRange(dom, this.from, this.to);

    const lang = normalizeLang(this.lang);
    const languageLabel = dom.querySelector<HTMLElement>(".md-codeblock-language-label");
    if (languageLabel) languageLabel.textContent = langLabel(lang);
    if (select.value !== lang) {
      if (!Array.from(select.options).some((o) => o.value === lang)) {
        const opt = document.createElement("option");
        opt.value = lang;
        opt.textContent = langLabel(lang);
        select.appendChild(opt);
      }
      select.value = lang;
    }

    // 正在输入的元素不能重写，否则光标会被打掉
    if (document.activeElement !== codeEl && sourceText(codeEl) !== this.code) {
      paintCode(codeEl, this.code);
      paintGutter(gutter, this.code);
      this.paintHighlight(view, dom, codeEl, this.lang);
    }
    return true;
  }

  /** 组件内交互自理；点在外层留白上的鼠标事件交还编辑器定位光标。 */
  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-codeblock-widget");
  }
}
