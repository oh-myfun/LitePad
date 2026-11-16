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
// 进入编辑靠 `md-block--editing` 这一颗类（preview.css 里那组规则的存在理由）。

import { EditorView, WidgetType } from "@codemirror/view";
import { dirOf, followLink } from "../markdown/links";
import { renderFragment } from "../markdown/pipeline";
import { sanitizeHtmlInto } from "../markdown/sanitize";
import { assetBase, assetUrl, resolveAssetPath } from "./assets";
import { bindBlockBoundaryCursor, bindBlockClickEdit, stampBlockRange } from "./blockRange";
import { previewHooks } from "./hooks";
import {
  attachBlockSelection,
  attachSourceEditing,
  beginSourceEditing,
  clickedOnBlockPadding,
  makePlainTextEditable,
} from "./editableSource";
import { bindFootnoteJump } from "./footnoteJump";

/**
 * B459 · 行首「标记槽」的占位件（列表符 / 勾选框 / 引用竖线那一档缩进）。
 *
 * 这些标记的墨迹归 CSS 画，源码区间此前是**零宽** replace ⇒ 行首那一档缩进整个住在
 * `.cm-line` 的左内距里。而 CM6 铺选区色带时只读「渲染出来的第一颗 `.cm-line`」的
 * `paddingLeft + min(0, textIndent)`（view/dist/index.js:9328-9330），把它套给选区里所有行
 * ⇒ 第一颗行是列表行时，整屏色带的左沿跑到正文左沿右边一档：列表行行首的方框没被盖住，
 * 段落行开头一截字反倒被吃掉。
 *
 * 修法是把那一档缩进拆成两半：左内距继续管续行对齐，负 `text-indent`（`.md-lead-slot`）
 * 把 CM6 那颗左沿按回正文左沿，**首行正文原本的位置由这颗件补回来** —— 它只占宽
 * （`width: var(--md-lead)`）、高度 0（不顶行盒，同步滚动的逐行对齐才不偏）、不画墨。
 *
 * 走 replace-with-widget 而不是 mark 装饰：`textContent` 里不许留着源码 `- [ ]`
 * —— 「折起来」的口径与 B404/B405 的显形判据都钉在这一点上。
 */
export class MarkSlotWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: MarkSlotWidget): boolean {
    return other.from === this.from && other.to === this.to;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "md-mark-slot";
    return el;
  }

  /** 点击归 CM6（落到标记区间里的某个位置）；点勾那颗键位仍由 `taskClick` 判。 */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 行内替换成「一段文本」的小件（实体字符 `&amp;` → `&`；光标压进去显形源码）。
 *
 * B450 · 脚注那颗多带一份 `jumpTo`（它那条定义在文档里的起点）：DOM 上挂 `data-fn-jump`，
 * 跳转监听挂在**这颗 DOM 自己**上（`footnoteJump.ts` 讲为什么走不通 view 级那道闸）。
 * 普通点击仍归「放光标显形源码」，Ctrl+点击才跳 —— 与 B403 的链接同一条口径，
 * 所以这里要把 `shouldHandle` 关掉那一下（不然它先 `stopPropagation`，跳不动）。
 */
export class InlinePreviewWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly text: string,
    readonly className: string,
    readonly tag: "span" | "sup" = "span",
    readonly jumpTo: number | null = null,
  ) {
    super();
  }

  eq(other: InlinePreviewWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.text === this.text &&
      other.className === this.className &&
      other.tag === this.tag &&
      other.jumpTo === this.jumpTo
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.tag);
    el.className = this.className;
    el.textContent = this.text;
    if (this.jumpTo !== null) el.dataset.fnJump = String(this.jumpTo);
    // 行内小件也走「点击落位」：`ignoreEvent` 让 CM 不理这颗点击，不给它挂监听
    // 就是一颗点不动的死字（InkNote 同一发）。
    // 带跳转目标的那颗：普通点击仍归放光标，Ctrl+点击让给 `bindFootnoteJump`
    // （它挂在这颗 DOM 上，与 B403 链接同一条口径）。
    bindBlockClickEdit(el, this.from, this.to, {
      shouldHandle: (event) => !event.ctrlKey && !event.metaKey,
    });
    bindFootnoteJump(el, this.jumpTo);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 链接定义 `[ref]: url "title"`：折成一条元信息，点它改源码。
 *
 * B449 · 脚注那颗多带一份**渲染出来的定义体**（`.md-metadata-body`）：GFM 允许 `[^x]:`
 * 后面跟多段（缩进四空格起，里面还能有围栏）。此前卡片只画标题那一行，正文只活在隐藏的
 * 源码区里 ⇒ 用户看到的就是「脚注 2 只有一句话，后面的段落和代码块都不见了」。
 * 正文与标题同住 `.md-metadata-preview` 那一格（一张框，不是叠两张），编辑档靠
 * `> .md-metadata-preview` 一起收掉。传空串（链接定义那颗）就一个正文元素都不建。
 */
export class EditableMetadataWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly sourceText: string,
    readonly previewText: string,
    readonly kind: "reference" | "footnote",
    readonly bodyMarkdown = "",
  ) {
    super();
  }

  eq(other: EditableMetadataWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.sourceText === this.sourceText &&
      other.previewText === this.previewText &&
      other.kind === this.kind &&
      other.bodyMarkdown === this.bodyMarkdown
    );
  }

  /** 标题一行 + （有正文时）渲染过的定义体。每次重建，不留上一版的正文节点。 */
  private fillPreview(preview: HTMLElement): void {
    preview.textContent = "";
    const title = document.createElement("div");
    title.className = "md-metadata-title";
    title.textContent = this.previewText;
    preview.append(title);
    if (!this.bodyMarkdown.trim()) return;
    const body = document.createElement("div");
    // `.md-rendered` = 借派生预览那一套排版（段落间距 / 表格线 / 代码块 / 链接色），
    // 与 HTML 块那颗同源（B402）；消毒在 `renderFragment` 里已经做过。
    body.className = "md-metadata-body md-rendered";
    sanitizeHtmlInto(body, renderFragment(this.bodyMarkdown));
    preview.append(body);
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
    this.fillPreview(preview);

    wrap.append(source, preview);
    bindBlockBoundaryCursor(wrap, preview);
    attachSourceEditing(wrap, {
      source: () => source,
      toMarkdown: (text) => text.replace(/\n+$/, ""),
      indentOnTab: false,
    });
    preview.addEventListener("mousedown", (event) => {
      // 正文里的链接 / 按钮不该被「点卡片改源码」吃掉（HTML 块那颗同款闸）
      if ((event.target as HTMLElement).closest("a,button,input,select,textarea")) return;
      event.preventDefault();
      beginSourceEditing(wrap, source, false);
    });
    // B401：渲染出来的 `<a href>` 不许把 WebView 导航走；纯锚点放给默认行为。
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
        openLocal: previewHooks().openLocalFile,
      });
    });
    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const source = dom.querySelector<HTMLElement>(".md-block-source");
    const preview = dom.querySelector<HTMLElement>(".md-metadata-preview");
    if (!source || !preview) return false;
    stampBlockRange(dom, this.from, this.to);
    if (document.activeElement !== source) source.textContent = this.sourceText;
    this.fillPreview(preview);
    // 正文行数会变（多段定义在编辑中增删段落）⇒ 块高要重测，否则下方内容错位
    EditorView.findFromDOM(dom)?.requestMeasure();
    return true;
  }

  ignoreEvent(event: Event): boolean {
    return !clickedOnBlockPadding(event, "md-metadata-widget");
  }
}

/** 选择器 → 要换的属性。`video` 的 `src` 与 `poster` 各算一条（两者可同时存在）。 */
const MEDIA_SRC_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ["img[src]", "src"],
  ["video[src]", "src"],
  ["video[poster]", "poster"],
  ["audio[src]", "src"],
  ["source[src]", "src"],
];

/** HTML 块里的媒体地址（`<img>` / `<video>` / `<audio>` / `<source>`）：相对路径按文档
 *  目录拼成可加载地址（B409）。
 *
 *  HTML 块里的 `<img src="./screenshots/a.png">` 是照文档目录写的，WebView 会把它
 *  当成「应用自身的相对地址」去加载 ⇒ 一路 404。与 Markdown 图片同一口径
 *  （`resolveAssetPath` + `assetUrl`）。已带协议的地址不碰：`asset:` / `blob:` 是
 *  别处（或上一发）已经处理好的，http/data 本来就不该拼。
 *
 *  `<video>` 的封面（`poster`）与 `<source>` 的子项同一条链 —— 视频要能放出来，
 *  这三处都得换成本地可加载地址。
 */
function resolveHtmlMedia(root: HTMLElement, mdPath: string | null): void {
  for (const [selector, attr] of MEDIA_SRC_ATTRS) {
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      const src = el.getAttribute(attr) ?? "";
      // ⚠️ 只放过「已经是可加载地址」的那几种：`C:\shots\a.png` 也带冒号，别一刀切掉
      if (!src || /^(?:https?|data|blob|asset):/i.test(src) || src.startsWith("//")) return;
      el.setAttribute(attr, assetUrl(resolveAssetPath(mdPath, src)));
    });
  }
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
    // 原始 HTML 就是正文，表线/段落间距/标题线与预览面同源；编辑面只在 preview.css 里
    // 把字号/行距/颜色压回继承。
    preview.className = "md-html-preview md-rendered";
    const renderPreview = (html: string): void => {
      sanitizeHtmlInto(preview, html);
      resolveHtmlMedia(preview, this.mdPath);
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
        openLocal: previewHooks().openLocalFile,
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
    resolveHtmlMedia(preview, this.mdPath);
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
