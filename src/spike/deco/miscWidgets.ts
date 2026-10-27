// 壳移植自 InkNote (MIT, Copyright (c) 2026 likehao19)
//   src/editor/widgets/preview.ts:10-179（行内预览 / 链接定义 / HTML 块）
//   src/editor/widgets/codeBlock.ts:317-354（分割线）
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-4a · 编辑模式的「小件」：实体字符、链接定义、HTML 块、分割线。
// 四件都不碰资源加载（图片另开一片：它要先定「本地图片路径怎么解析」，与 B394-4 同一件事）。
//
// 与 InkNote 的唯一差异：i18n —— LitePad 没有语言层，链接定义那句预览文案由
// previewSets 现拼中文（InkNote 走 `tr(getLocale(), "editor.linkDefinition")`）。
//
// ⚠️ 可编辑的两件（链接定义 / HTML 块）照抄它的两段式：默认显示渲染结果，
// 点击切到**同位置**的源码区；源码区是 `.md-block-source`，平时 `display: none`，
// 进入编辑靠 `md-block--editing` 这一颗类（deco.css 里那组规则的存在理由）。

import { EditorView, WidgetType } from "@codemirror/view";
import { bindBlockBoundaryCursor, bindBlockClickEdit, stampBlockRange } from "./blockRange";
import {
  attachBlockSelection,
  attachSourceEditing,
  beginSourceEditing,
  clickedOnBlockPadding,
  makePlainTextEditable,
} from "./editableSource";

/** 行内替换成「一段文本」的小件（实体字符 `&amp;` → `&`；光标压进去显形源码）。 */
export class InlinePreviewWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly text: string,
    readonly className: string,
    readonly tag: "span" | "sup" = "span",
  ) {
    super();
  }

  eq(other: InlinePreviewWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.text === this.text &&
      other.className === this.className &&
      other.tag === this.tag
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.tag);
    el.className = this.className;
    el.textContent = this.text;
    // 行内小件也走「点击落位」：`ignoreEvent` 让 CM 不理这颗点击，不给它挂监听
    // 就是一颗点不动的死字（InkNote 同一发）。
    bindBlockClickEdit(el, this.from, this.to);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 链接定义 `[ref]: url "title"`：折成一条元信息，点它改源码。 */
export class EditableMetadataWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly sourceText: string,
    readonly previewText: string,
    readonly kind: "reference" | "footnote",
  ) {
    super();
  }

  eq(other: EditableMetadataWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.sourceText === this.sourceText &&
      other.previewText === this.previewText &&
      other.kind === this.kind
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `md-metadata-widget md-metadata-${this.kind}`;
    stampBlockRange(wrap, this.from, this.to);

    const source = document.createElement("div");
    source.className = "md-block-source";
    makePlainTextEditable(source);
    source.textContent = this.sourceText;

    const preview = document.createElement("div");
    preview.className = "md-metadata-preview";
    preview.textContent = this.previewText;

    wrap.append(source, preview);
    bindBlockBoundaryCursor(wrap, preview);
    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => text.replace(/\n+$/, ""),
      indentOnTab: false,
    });
    preview.addEventListener("mousedown", (event) => {
      event.preventDefault();
      beginSourceEditing(wrap, source, false);
    });
    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const source = dom.querySelector<HTMLElement>(".md-block-source");
    const preview = dom.querySelector<HTMLElement>(".md-metadata-preview");
    if (!source || !preview) return false;
    stampBlockRange(dom, this.from, this.to);
    if (document.activeElement !== source) source.textContent = this.sourceText;
    preview.textContent = this.previewText;
    return true;
  }

  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-metadata-widget");
  }
}

/**
 * 把一段 HTML 安全地放进预览区。
 *
 * 与 InkNote 同一条：先解析、再删掉能执行/能外链的节点与属性。LitePad 的
 * markdown-it 那一臂是 `html: false`（原样吐字），所以这段只服务编辑模式里的 HTML 块。
 */
function renderSafeHtml(target: HTMLElement, html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed
    .querySelectorAll("script,style,iframe,object,embed,link,meta,base")
    .forEach((el) => el.remove());
  parsed.querySelectorAll<HTMLElement>("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // 先剥掉所有 ≤ U+0020 的字符再判协议：`java\nscript:` 是 classic 混淆手法
      // （InkNote 写的是 /[\u0000-\u0020]+/g，这里按码位过滤，免得踩 no-control-regex 那条 lint）
      const value = Array.from(attr.value.trim())
        .filter((ch) => ch.charCodeAt(0) > 0x20)
        .join("");
      if (name.startsWith("on") || name === "style") el.removeAttribute(attr.name);
      if (
        ["href", "src", "xlink:href", "action", "formaction"].includes(name) &&
        (/^(?:javascript|vbscript):/i.test(value) ||
          (/^data:/i.test(value) &&
            !(name === "src" && /^data:image\/(?:png|gif|jpe?g|webp);/i.test(value))))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });
  target.replaceChildren(...Array.from(parsed.body.childNodes));
}

/** HTML 块：默认显示渲染结果（已消毒），点它改源码。 */
export class HtmlBlockWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly html: string,
  ) {
    super();
  }

  eq(other: HtmlBlockWidget): boolean {
    return other.to - other.from === this.to - this.from && other.html === this.html;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "md-html-widget";
    stampBlockRange(wrap, this.from, this.to);

    const source = document.createElement("div");
    source.className = "md-block-source";
    makePlainTextEditable(source);
    source.textContent = this.html;

    const preview = document.createElement("div");
    preview.className = "md-html-preview";
    renderSafeHtml(preview, this.html);
    wrap.append(source, preview);
    bindBlockBoundaryCursor(wrap, preview);

    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => text.replace(/\n+$/, ""),
      onInput: (text) => renderSafeHtml(preview, text),
      indentOnTab: true,
    });
    preview.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("a,button,input,select,textarea")) return;
      event.preventDefault();
      beginSourceEditing(wrap, source, false);
    });
    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const source = dom.querySelector<HTMLElement>(".md-block-source");
    const preview = dom.querySelector<HTMLElement>(".md-html-preview");
    if (!source || !preview) return false;
    stampBlockRange(dom, this.from, this.to);
    if (document.activeElement !== source) {
      source.textContent = this.html;
      renderSafeHtml(preview, this.html);
    }
    EditorView.findFromDOM(dom)?.requestMeasure();
    return true;
  }

  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-html-widget");
  }
}

/** 分割线：一条渐隐的横线；不含文本 ⇒ 点击选中，Backspace/Delete 整块删。 */
export class HrWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: HrWidget): boolean {
    return other.to - other.from === this.to - this.from;
  }

  toDOM(): HTMLElement {
    const hr = document.createElement("div");
    hr.className = "md-hr-widget";
    hr.setAttribute("role", "separator");
    stampBlockRange(hr, this.from, this.to);

    const line = document.createElement("span");
    line.className = "md-hr-line";
    line.setAttribute("aria-hidden", "true");
    hr.appendChild(line);

    // 分割线上下的视觉留白跳过已折叠源码空行，落到相邻可见段落
    bindBlockBoundaryCursor(hr, line);
    attachBlockSelection(hr);
    return hr;
  }

  updateDOM(dom: HTMLElement): boolean {
    stampBlockRange(dom, this.from, this.to);
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
