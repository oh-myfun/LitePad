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
import { dirOf, followLink } from "../../markdown/links";
import { sanitizeHtmlInto } from "../../markdown/sanitize";
import { assetBase, assetUrl, resolveAssetPath } from "./assets";
import { bindBlockBoundaryCursor, bindBlockClickEdit, stampBlockRange } from "./blockRange";
import { decoHooks } from "./hooks";
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

/** HTML 块里的 `<img src>`：相对路径按文档目录拼成可加载地址（B409）。
 *
 *  HTML 块里的 `<img src="./screenshots/a.png">` 是照文档目录写的，WebView 会把它
 *  当成「应用自身的相对地址」去加载 ⇒ 一路 404。与 Markdown 图片同一口径
 *  （`resolveAssetPath` + `assetUrl`）。已带协议的地址不碰：`asset:` / `blob:` 是
 *  别处（或上一发）已经处理好的，http/data 本来就不该拼。
 */
function resolveHtmlImages(root: HTMLElement, mdPath: string | null): void {
  root.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    // ⚠️ 只放过「已经是可加载地址」的那几种：`C:\shots\a.png` 也带冒号，别一刀切掉
    if (!src || /^(?:https?|data|blob|asset):/i.test(src) || src.startsWith("//")) return;
    img.setAttribute("src", assetUrl(resolveAssetPath(mdPath, src)));
  });
}

/** HTML 块：默认显示渲染结果（已消毒），点它改源码。 */
export class HtmlBlockWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly html: string,
    /** 文档路径（HTML 里的相对图片按它拼）；换文档时 eq 必须判不等，DOM 才会重解析 */
    readonly mdPath: string | null = null,
  ) {
    super();
  }

  eq(other: HtmlBlockWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.html === this.html &&
      other.mdPath === this.mdPath
    );
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
    // B402：HTML 块借用派生预览的排版（`.md-rendered` 那一套规则）—— VS Code 的预览里
    // 原始 HTML 就是正文，表线/段落间距/标题线与预览面同源；编辑面只在 deco.css 里
    // 把字号/行距/颜色压回继承。
    preview.className = "md-html-preview md-rendered";
    const renderPreview = (html: string): void => {
      sanitizeHtmlInto(preview, html);
      resolveHtmlImages(preview, this.mdPath);
    };
    renderPreview(this.html);
    wrap.append(source, preview);
    bindBlockBoundaryCursor(wrap, preview);

    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => text.replace(/\n+$/, ""),
      onInput: renderPreview,
      indentOnTab: true,
    });
    preview.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("a,button,input,select,textarea")) return;
      event.preventDefault();
      beginSourceEditing(wrap, source, false);
    });
    // B401：HTML 块里的 `<a href>` 同样不许把 WebView 导航走；纯锚点（`#id`）放给默认行为。
    preview.addEventListener("click", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      const docPath = EditorView.findFromDOM(wrap)?.state.field(assetBase, false) ?? null;
      followLink(href, {
        baseDir: docPath ? dirOf(docPath) : null,
        openLocal: decoHooks().openLocalFile,
      });
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
      sanitizeHtmlInto(preview, this.html);
    }
    // 换文档（assetBase 变了）而 HTML 文本没变：eq() 判不等走进 updateDOM，
    // 这里把图片地址按新文档目录重解析一次（已解析过的 asset: 地址会被跳过）。
    resolveHtmlImages(preview, this.mdPath);
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
