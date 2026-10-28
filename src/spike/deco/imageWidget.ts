// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/image.ts:1-152
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-4c · 图片组件。块级图整行接管（figure）；行内图跟着文字走（span），
// 点击露出源码（与其它行内小件同一条）。
//
// 与 InkNote 的差异（都不是省事，是那边的东西 LitePad 没有）：
// 1. **没有 pendingUrl**：InkNote 粘贴图片时先用内存 Blob URL 回显、随文档提交后才落盘；
//    LitePad 还没有那套「粘贴即插图」的管线，这一格不预造。
// 2. **不写原生 `title`**：InkNote 把 title 直接挂 `<img title>`；LitePad 的红线是不用
//    原生提示（tooltip.ts 文件头），改走 `setTip`。
//
// B406 · 两种编辑入口：
//   · **点图改代码**：块级图的光标窗口就是它自己（previewSets 的 `imageReveal`），
//     点一下把选区落进块内，装饰让位、露出 `![alt](path "title")` 原文，直接在 CM 里改。
//     只读档不做 reveal ⇒ 预览里点图不会翻源码。
//   · **悬浮编辑按钮 → 弹窗**：照 InkNote 的 `ImageInsertDialog`（替代文本 + 路径 + 浏览），
//     确认后整块换成新的 Markdown。按钮只在可编辑档出现（`.md-deco--readonly` 隐藏）。

import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { CODICONS } from "../../shell/codicons";
import { showImageDialog } from "../../shell/imagedialog";
import { setTip } from "../../shell/tooltip";
import { assetUrl } from "./assets";
import {
  bindBlockBoundaryCursor,
  bindBlockClickEdit,
  currentBlockRange,
  stampBlockRange,
} from "./blockRange";

/** `alt` / 地址 / title → 一行图片 Markdown（地址含空格或括号时套 `<…>`）。 */
export function imageMarkdown(alt: string, src: string, title = ""): string {
  const altText = alt.replace(/[\\[\]]/g, "\\$&");
  const dest = /[\s()<>]/.test(src) ? `<${src.replace(/>/g, "%3E")}>` : src;
  const titleText = title ? ` "${title.replace(/["\\]/g, "\\$&")}"` : "";
  return `![${altText}](${dest}${titleText})`;
}

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

  /** 悬浮编辑按钮：打开应用内的图片弹窗，确认后整块回写。 */
  private editWithDialog(wrap: HTMLElement): void {
    const view = EditorView.findFromDOM(wrap);
    if (!view || view.state.readOnly) return;
    void showImageDialog({ alt: this.alt, path: this.src }).then((result) => {
      if (!result) return;
      const range = currentBlockRange(view, wrap);
      if (!range) return;
      const next = imageMarkdown(result.alt, result.path, this.title);
      if (view.state.doc.sliceString(range.from, range.to) === next) return;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: next },
        userEvent: "input.image",
      });
      view.focus();
    });
  }

  toDOM(): HTMLElement {
    const root = document.createElement(this.inline ? "span" : "figure");
    root.className = this.inline ? "md-image-inline" : "md-image-widget";
    stampBlockRange(root, this.from, this.to);

    const img = this.buildImage();
    // 图挂了以后提示要顶在可见的位置：块级图的错误提示放进 frame（编辑键仍可点），
    // 行内图没有 frame，直接挂在根上。
    let errorHost: HTMLElement = root;
    // 图片是异步变高的：不通知 CM 重量一次，之后所有点击定位都会偏
    img.onload = () => EditorView.findFromDOM(root)?.requestMeasure();
    img.onerror = () => {
      img.style.display = "none";
      root.classList.add("md-image-widget--error");
      const err = document.createElement("span");
      err.className = "md-image-error";
      err.textContent = `无法加载：${this.src}`;
      errorHost.appendChild(err);
      EditorView.findFromDOM(root)?.requestMeasure();
    };
    if (this.title) setTip(img, this.title);

    if (this.inline) {
      root.appendChild(img);
      // 行内图片跟其它行内标记一致：点击落光标 / 显形源码
      bindBlockClickEdit(root, this.from, this.to);
      return root;
    }

    // 按钮贴在**图片**右上角（不是整行右缘）：frame 收缩到图片宽度。
    const frame = document.createElement("div");
    frame.className = "md-image-frame";
    errorHost = frame;
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "md-image-edit-btn";
    editBtn.innerHTML = CODICONS.edit;
    editBtn.setAttribute("aria-label", "编辑图片");
    setTip(editBtn, "编辑图片");
    editBtn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.editWithDialog(root);
    });
    frame.append(img, editBtn);
    root.appendChild(frame);

    const hint = document.createElement("span");
    hint.className = "md-image-path-hint";
    hint.textContent = this.src;
    hint.setAttribute("aria-hidden", "true");
    root.appendChild(hint);
    bindBlockBoundaryCursor(root, frame);

    // 点图 = 把光标落进这一块 ⇒ 装饰让位，露出这行 Markdown 供直接编辑（B406）。
    // 落点固定到 alt 的第一个字符：`mapClickToBlockPos` 在文档开头的图上会算出 from，
    // 而 from 是刻意留在显形窗口之外的（见 previewSets 的 imageReveal）。
    root.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const view = EditorView.findFromDOM(root);
      if (!view || view.state.readOnly) return;
      const range = currentBlockRange(view, root);
      if (!range) return;
      const sel = view.state.selection.main;
      if (sel.from >= range.from + 1 && sel.from < range.to) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: Math.min(range.from + 2, range.to) },
        scrollIntoView: true,
      });
      view.focus();
    });
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
