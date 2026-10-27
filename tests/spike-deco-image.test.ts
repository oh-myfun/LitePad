// @vitest-environment jsdom
// B397-4c · 图片组件（壳移植自 InkNote src/editor/widgets/image.ts）。
//
// 与其它组件的判据侧重不同：图片的「画没画出来」不只是 DOM，「**地址对不对**」才是主线 ——
// 相对路径要跟文档目录拼，引用式要查定义表，网页图 / data: 原样用。
// `convertFileSrc` 在 jsdom 里不存在（Tauri 才注入）⇒ `assetUrl` 的 try/catch 会回落到
// 原路径，所以本文件断言的是**解析后的路径**，不是 asset 协议地址。
//
// ⚠️ 基准目录是 state 里的一颗字段（`setAssetBase`）。换文档必须让它重建 ——
// widget 的 `eq()` 会复用 DOM，不复用就停在上一份文档的目录。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { setAssetBase } from "../src/spike/deco/assets";
import { buildPreviewSets } from "../src/spike/deco/previewSets";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";

function decoView(doc: string, readonly = false): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        decoFace(),
        decoLock(readonly),
        EditorView.lineWrapping,
      ],
    }),
    parent: document.body,
  });
}

function atomicTexts(view: EditorView): string[] {
  return buildPreviewSets(view.state)
    .atomicBlocks.slice()
    .sort((a, b) => a.from - b.from)
    .map((r) => view.state.doc.sliceString(r.from, r.to));
}

const BLOCK_DOC = ["甲", "", "![示例图](pic.png)", "", "乙"].join("\n");

describe("B397-4c 地址解析：相对路径按文档目录拼，网页图原样", () => {
  it("块级图：figure + img，alt 与地址都在", () => {
    const view = decoView(BLOCK_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-image-widget");
    expect(wrap, "装饰档没画出图片组件，这条判据就是空转").toBeTruthy();
    expect(wrap!.tagName).toBe("FIGURE");
    const img = wrap!.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("示例图");
    expect(img.getAttribute("src")).toBe("pic.png");
  });

  it("发一发基准目录 → 相对路径拼成绝对路径，widget 重建", () => {
    const view = decoView(BLOCK_DOC);
    const before = view.dom.querySelector<HTMLElement>(".md-image-widget");
    view.dispatch({ effects: setAssetBase.of("C:\\docs\\笔记.md") });
    const after = view.dom.querySelector<HTMLElement>(".md-image-widget");
    expect(after!.querySelector("img")!.getAttribute("src")).toBe("C:\\docs\\pic.png");
    expect(after, "基准目录变了必须换一颗 DOM（eq 复用会停在旧目录）").not.toBe(before);
  });

  it("网页图 / data: 不拼目录", () => {
    const view = decoView(["![网图](https://example.com/a.png)", "", "乙"].join("\n"));
    view.dispatch({ effects: setAssetBase.of("C:\\docs\\笔记.md") });
    expect(view.dom.querySelector(".md-image-widget img")!.getAttribute("src")).toBe(
      "https://example.com/a.png",
    );
  });

  it("引用式图片查定义表", () => {
    const doc = ["![图][logo]", "", "[logo]: https://example.com/logo.png"].join("\n");
    const view = decoView(doc);
    expect(view.dom.querySelector(".md-image-widget img")!.getAttribute("src")).toBe(
      "https://example.com/logo.png",
    );
  });
});

describe("B397-4c 块级 / 行内两档", () => {
  it("块级图整行接管 ⇒ 原子块；行内图不进原子块", () => {
    expect(atomicTexts(decoView(BLOCK_DOC))).toEqual(["![示例图](pic.png)"]);
    expect(atomicTexts(decoView("甲 ![小图](pic.png) 乙"))).toEqual([]);
  });

  it("行内图是 span，块级图后面的正文照常", () => {
    const view = decoView("甲 ![小图](pic.png) 乙");
    const inline = view.dom.querySelector<HTMLElement>(".md-image-inline");
    expect(inline, "行内图没画出来，这条判据就是空转").toBeTruthy();
    expect(inline!.tagName).toBe("SPAN");
    expect(view.dom.textContent).toContain("甲");
    expect(view.dom.textContent).toContain("乙");
  });

  it("加载失败：图藏起来，换成一行带路径的提示", () => {
    const view = decoView(BLOCK_DOC);
    const img = view.dom.querySelector<HTMLImageElement>(".md-image-widget img")!;
    img.dispatchEvent(new Event("error"));
    expect(img.style.display).toBe("none");
    expect(view.dom.querySelector(".md-image-error")!.textContent).toBe("无法加载：pic.png");
  });

  it("块级图带 title 时走应用的提示层，不写原生属性", () => {
    const view = decoView('![示例图](pic.png "这是提示")');
    const img = view.dom.querySelector<HTMLImageElement>(".md-image-widget img")!;
    expect(img.hasAttribute("title"), "原生 title 在红线里").toBe(false);
  });
});
