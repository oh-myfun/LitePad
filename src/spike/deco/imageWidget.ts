// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/image.ts:1-152
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-4c · 图片组件。块级图整行接管（figure）；行内图跟着文字走（span），
// 点击露出源码（与其它行内小件同一条）。
//
// 与 InkNote 的三处差异（都不是省事，是那边的东西 LitePad 没有）：
// 1. **没有 pendingUrl**：InkNote 粘贴图片时先用内存 Blob URL 回显、随文档提交后才落盘；
//    LitePad 还没有那套「粘贴即插图」的管线，这一格不预造。
// 2. **没有双击换图**：InkNote 双击块级图会开选图器（`editorPickImage`）；LitePad 没有
//    选图器，所以块级图只保留「点击选中 / Backspace 删」这一套。
// 3. **不写原生 `title`**：InkNote 把 title 直接挂 `<img title>`；LitePad 的红线是不用
//    原生提示（tooltip.ts 文件头），改走 `setTip`。

import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { setTip } from "../../shell/tooltip";
import { assetUrl } from "./assets";
import { bindBlockBoundaryCursor, bindBlockClickEdit, stampBlockRange } from "./blockRange";
import { attachBlockSelection } from "./editableSource";

export class ImageWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly src: string,
    readonly alt: string,
    readonly resolved: string,
    readonly inline = false,
    readonly title = "",
  ) {
    super();
  }

  /** 只比内容与长度：位置变化不该让图片重新加载。 */
  eq(other: ImageWidget): boolean {
    return (
      other.to - other.from === this.to - this.from &&
      other.src === this.src &&
      other.alt === this.alt &&
      other.resolved === this.resolved &&
      other.inline === this.inline &&
      other.title === this.title
    );
  }

  private buildImage(): HTMLImageElement {
    const img = document.createElement("img");
    img.alt = this.alt;
    img.loading = "lazy";
    img.draggable = false;
    img.src = assetUrl(this.resolved);
    return img;
  }

  toDOM(): HTMLElement {
    const root = document.createElement(this.inline ? "span" : "figure");
    root.className = this.inline ? "md-image-inline" : "md-image-widget";
    stampBlockRange(root, this.from, this.to);

    const img = this.buildImage();
    // 图片是异步变高的：不通知 CM 重量一次，之后所有点击定位都会偏
    img.onload = () => EditorView.findFromDOM(root)?.requestMeasure();
    img.onerror = () => {
      img.style.display = "none";
      const err = document.createElement("span");
      err.className = "md-image-error";
      err.textContent = `无法加载：${this.src}`;
      root.appendChild(err);
      EditorView.findFromDOM(root)?.requestMeasure();
    };
    if (this.title) setTip(img, this.title);
    root.appendChild(img);

    if (this.inline) {
      // 行内图片跟其它行内标记一致：点击落光标 / 显形源码
      bindBlockClickEdit(root, this.from, this.to);
      return root;
    }

    const hint = document.createElement("span");
    hint.className = "md-image-path-hint";
    hint.textContent = this.src;
    hint.setAttribute("aria-hidden", "true");
    root.appendChild(hint);
    bindBlockBoundaryCursor(root, img);

    // 块级图片：点击选中，而不是把 Markdown 源码翻出来
    attachBlockSelection(root);
    return root;
  }

  /** 不实现 updateDOM：换图/改 alt 必须重建，否则 `<img>` 不会刷新。 */
  ignoreEvent(): boolean {
    return true;
  }
}

/** 从 Image 语法节点提取 alt 与 url（引用式 `![图][ref]` 查定义表）。 */
export function parseImage(
  node: SyntaxNodeRef,
  doc: { sliceString: (from: number, to: number) => string },
  definitions: ReadonlyMap<string, { url: string; title: string }> = new Map(),
): { alt: string; url: string; title: string } {
  let alt = "";
  let url = "";
  let title = "";
  const marks = node.node.getChildren("LinkMark");
  if (marks.length >= 2) alt = doc.sliceString(marks[0].to, marks[1].from);

  const directUrl = node.node.getChild("URL");
  if (directUrl) {
    url = doc.sliceString(directUrl.from, directUrl.to).replace(/^<|>$/g, "");
    const directTitle = node.node.getChild("LinkTitle");
    if (directTitle) title = doc.sliceString(directTitle.from + 1, directTitle.to - 1);
  } else {
    const labelNode = node.node.getChild("LinkLabel");
    const rawLabel = labelNode ? doc.sliceString(labelNode.from + 1, labelNode.to - 1) : alt;
    const definition = definitions.get(rawLabel.trim().replace(/\s+/g, " ").toLowerCase());
    if (definition) ({ url, title } = definition);
  }
  return { alt, url, title };
}
