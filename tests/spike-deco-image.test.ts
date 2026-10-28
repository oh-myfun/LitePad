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
//
// B406 新增两组判据：
//   · `resolveAssetPath` 的边界（`..` / `file:///` / UNC / 扩展长度前缀）；
//   · 点图显形源码、悬浮编辑键 → 弹窗回写。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAssetPath, setAssetBase } from "../src/spike/deco/assets";
import { imageMarkdown } from "../src/spike/deco/imageWidget";
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

afterEach(() => {
  document.body.innerHTML = "";
});

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

describe("B406 地址解析边界", () => {
  const md = "C:\\docs\\笔记.md";

  it("`..` 段要折平（asset 协议不认带 `..` 的地址）", () => {
    expect(resolveAssetPath(md, "../pics/甲.png")).toBe("C:\\pics\\甲.png");
    expect(resolveAssetPath(md, ".\\sub\\..\\pic.png")).toBe("C:\\docs\\pic.png");
  });

  it("`file:///` 还原成本地路径再按绝对路径走", () => {
    expect(resolveAssetPath(md, "file:///C:/pics/a.png")).toBe("C:\\pics\\a.png");
    expect(resolveAssetPath(md, "file:///C:/pics/a%20b.png")).toBe("C:\\pics\\a b.png");
  });

  it("UNC / 扩展长度前缀是绝对路径，不拿文档目录去拼", () => {
    expect(resolveAssetPath(md, "\\\\server\\share\\a.png")).toBe("\\\\server\\share\\a.png");
    expect(resolveAssetPath(md, "//server/share/a.png")).toBe("\\\\server\\share\\a.png");
    expect(resolveAssetPath(md, "\\\\?\\C:\\pics\\a.png")).toBe("C:\\pics\\a.png");
    expect(resolveAssetPath("\\\\?\\C:\\docs\\笔记.md", "pic.png")).toBe("C:\\docs\\pic.png");
  });

  it("正斜杠文档路径按 `/` 拼", () => {
    expect(resolveAssetPath("C:/docs/笔记.md", "./pics/a.png")).toBe("C:/docs/pics/a.png");
    expect(resolveAssetPath("C:/docs/笔记.md", "../a.png")).toBe("C:/a.png");
  });

  it("imageMarkdown：地址含空格/括号套尖括号，alt 的 ] 转义", () => {
    expect(imageMarkdown("图", "a b.png")).toBe("![图](<a b.png>)");
    expect(imageMarkdown("图", "a(1).png")).toBe("![图](<a(1).png>)");
    expect(imageMarkdown("图", "a.png", "提示")).toBe('![图](a.png "提示")');
    expect(imageMarkdown("a]b", "a.png")).toBe("![a\\]b](a.png)");
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

describe("B406 图片块编辑", () => {
  it("光标落进图片块 ⇒ 装饰让位，露出 Markdown 原文；离开后恢复", () => {
    const view = decoView(BLOCK_DOC);
    const from = BLOCK_DOC.indexOf("![");
    expect(view.dom.querySelector(".md-image-widget")).toBeTruthy();
    view.dispatch({ selection: { anchor: from + 2 } });
    expect(view.dom.querySelector(".md-image-widget"), "光标在块内时还画组件").toBeFalsy();
    expect(view.dom.textContent).toContain("![示例图](pic.png)");
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".md-image-widget"), "光标离开后没恢复渲染").toBeTruthy();
  });

  it("只读档不显形（预览里点图不翻源码）", () => {
    const view = decoView(BLOCK_DOC, true);
    const from = BLOCK_DOC.indexOf("![");
    view.dispatch({ selection: { anchor: from + 2 } });
    expect(view.dom.querySelector(".md-image-widget")).toBeTruthy();
  });

  it("点图片 = 把光标送进块内", () => {
    const view = decoView(BLOCK_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-image-widget")!;
    wrap.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const range = buildPreviewSets(view.state).atomicBlocks[0];
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(range.from);
    expect(view.state.selection.main.head).toBeLessThanOrEqual(range.to);
  });

  it("悬浮编辑键：打开弹窗，确认后整块回写（title 原样保留）", async () => {
    const view = decoView('![示例图](pic.png "标题")');
    const btn = view.dom.querySelector<HTMLButtonElement>(".md-image-edit-btn");
    expect(btn, "编辑键没画出来，这条判据就是空转").toBeTruthy();
    expect(btn!.querySelector(".codicon"), "图标必须走 codicon").toBeTruthy();

    btn!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.dom.querySelector(".md-image-widget"), "点编辑键不该翻源码").toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const dialog = document.querySelector<HTMLElement>(".image-dialog");
    expect(dialog, "弹窗没挂到 body 上").toBeTruthy();
    const alt = dialog!.querySelector<HTMLInputElement>("#image-dialog-alt")!;
    const path = dialog!.querySelector<HTMLInputElement>("#image-dialog-path")!;
    expect(alt.value).toBe("示例图");
    expect(path.value).toBe("pic.png");

    alt.value = "新图";
    alt.dispatchEvent(new Event("input", { bubbles: true }));
    path.value = "pics/new 图.png";
    path.dispatchEvent(new Event("input", { bubbles: true }));
    dialog!.querySelector<HTMLButtonElement>(".image-dialog-confirm")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe('![新图](<pics/new 图.png> "标题")');
    expect(document.querySelector(".image-dialog"), "确认后弹窗没关").toBeFalsy();
  });
});
