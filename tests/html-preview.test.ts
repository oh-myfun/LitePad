// @vitest-environment jsdom
// HTML 源码 / 预览切换：判定口径、srcdoc 组装（基准 URL 的落点）、预览面的挂载与收档。
//
// 这一面比 Markdown 预览多一层风险：渲染的是**任意网页**，所以判据里同时钉住两件事 ——
// 哪些文件允许进预览（静态 HTML，且差异档恒源码），以及基准 URL 必须插在解析器
// 真正会当 `<head>` 用的位置（插错位置 = 相对样式 / 图片全丢，而页面本身仍能显示，
// 肉眼很难归因）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyHtmlPreviewFace,
  buildHtmlPreviewDocument,
  refreshHtmlPreviewsOf,
} from "../src/preview/htmlPreview";
import { isHtmlDoc, isPreviewableTab, makeDoc, makeInstance, registerDoc } from "../src/doc-model";
import { docs, panels, tabs, type Panel } from "../src/core/app-state";
import { setPreviewHooks } from "../src/preview/hooks";

let seq = 9000;

function newDoc(name: string, path: string | null, text = ""): number {
  const doc = makeDoc(seq++, text, name, path, "utf-8", "\n", false);
  registerDoc(doc);
  return doc.tabId;
}

function newTab(docId: number, panelId = 1, text = "<h1>hi</h1>"): ReturnType<typeof makeInstance> {
  const doc = docs.get(docId)!;
  const tab = makeInstance(doc, panelId, text);
  tabs.set(tab.tabId, tab);
  return tab;
}

function newPanel(panelId: number, tabId: number): Panel {
  const host = document.createElement("div");
  host.className = "panel-host";
  const editor = document.createElement("div");
  editor.className = "panel-editor";
  host.appendChild(editor);
  document.body.appendChild(host);
  const panel = {
    panelId,
    bodyEl: host,
    activeTabId: tabId,
    viewTabId: tabId,
    tabs: [tabId],
  } as unknown as Panel;
  panels.set(panelId, panel);
  return panel;
}

beforeEach(() => {
  docs.clear();
  tabs.clear();
  panels.clear();
  document.body.innerHTML = "";
  vi.useRealTimers();
  setPreviewHooks({ onToggleTask: () => {}, canToggleTask: () => true, openLocalFile: () => {} });
});

describe("HTML 文档判定", () => {
  it("按后缀认静态 HTML；不把服务端模板 / 普通文本算进来", () => {
    expect(isHtmlDoc(makeDoc(1, "", "index.html", "D:\\a\\index.html", "utf-8", "\n", false))).toBe(
      true,
    );
    expect(isHtmlDoc(makeDoc(2, "", "index.htm", "D:\\a\\index.htm", "utf-8", "\n", false))).toBe(
      true,
    );
    expect(isHtmlDoc(makeDoc(3, "", "page.xhtml", "D:\\a\\page.xhtml", "utf-8", "\n", false))).toBe(
      true,
    );
    expect(isHtmlDoc(makeDoc(4, "", "notes.txt", "D:\\a\\notes.txt", "utf-8", "\n", false))).toBe(
      false,
    );
    expect(isHtmlDoc(makeDoc(5, "", "view.jsp", "D:\\a\\view.jsp", "utf-8", "\n", false))).toBe(
      false,
    );
  });

  it("手动语言覆盖优先：.html 改成 Markdown 就不再是 HTML，.txt 改成 HTML 才是", () => {
    const html = makeDoc(11, "", "index.html", "D:\\a\\index.html", "utf-8", "\n", false);
    html.langOverride = "Markdown";
    expect(isHtmlDoc(html)).toBe(false);

    const txt = makeDoc(12, "", "notes.txt", "D:\\a\\notes.txt", "utf-8", "\n", false);
    txt.langOverride = "HTML";
    expect(isHtmlDoc(txt)).toBe(true);
  });

  it("可预览 = Markdown 或 HTML；差异档恒源码，不进预览", () => {
    const mdId = newDoc("a.md", "D:\\a\\a.md", "# a");
    const htmlId = newDoc("b.html", "D:\\a\\b.html", "<h1>b</h1>");
    const txtId = newDoc("c.txt", "D:\\a\\c.txt", "c");
    expect(isPreviewableTab(newTab(mdId))).toBe(true);
    expect(isPreviewableTab(newTab(htmlId))).toBe(true);
    expect(isPreviewableTab(newTab(txtId))).toBe(false);

    const diff = newTab(htmlId);
    diff.kind = "diff";
    expect(isPreviewableTab(diff)).toBe(false);
  });
});

describe("buildHtmlPreviewDocument：<base> 与 bridge 的落点", () => {
  const base = "http://asset.localhost/E%3A%5Cdocs%5C";

  it("没有目录基准时不插 base，但 bridge 仍要进（否则链接 / 快捷键没人接管）", () => {
    const src = "<!doctype html><html><head><title>x</title></head></html>";
    const out = buildHtmlPreviewDocument(src, null);
    expect(out).not.toContain("<base");
    expect(out).toContain("data-litepad-preview-bridge");
    expect(out.startsWith("<!doctype html>")).toBe(true);
  });

  it("有 <head>：紧跟开标签插入，base 在页面自己的 meta 之前", () => {
    const src =
      '<!doctype html><html><head data-x="1"><meta charset="utf-8"></head><body>x</body></html>';
    const out = buildHtmlPreviewDocument(src, base);
    expect(out).toContain('<head data-x="1"><base href="http://asset.localhost/E%3A%5Cdocs%5C">');
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<meta"));
  });

  it("只有 <html>：补一颗 <head> 塞在它后面", () => {
    const src = "<!doctype html><html><body>x</body></html>";
    const out = buildHtmlPreviewDocument(src, base);
    expect(out).toContain('<html><head><base href="http://asset.localhost/E%3A%5Cdocs%5C">');
    expect(out).toContain("data-litepad-preview-bridge");
  });

  it("只有 doctype 的片段：doctype 保持首位，html/head 补在它后面", () => {
    const out = buildHtmlPreviewDocument("<!doctype html><h1>x</h1>", base);
    expect(out.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(out.endsWith("</body></html>")).toBe(true);
    expect(out).toContain("<h1>x</h1>");
  });

  it("连 doctype 都没有：整段包一层（不能让 base 落在解析器会丢掉的位置）", () => {
    const out = buildHtmlPreviewDocument("<h1>x</h1>", base);
    expect(out.startsWith("<html><head><base href=")).toBe(true);
    expect(out.endsWith("</body></html>")).toBe(true);
  });

  it("base 属性做转义", () => {
    const out = buildHtmlPreviewDocument("<html><head></head><body></body></html>", 'D:\\a&b"c\\');
    expect(out).toContain('<base href="D:\\a&amp;b&quot;c\\">');
  });

  it("bridge 自己带链接 / 按键 / 右键 / 点击激活四条转发", () => {
    const out = buildHtmlPreviewDocument("<h1>x</h1>", base);
    expect(out).toContain("closest('a[href]')");
    expect(out).toContain('send("key"');
    expect(out).toContain('send("link"');
    expect(out).toContain('send("activate"');
    expect(out).toContain('addEventListener("contextmenu"');
  });
});

describe("applyHtmlPreviewFace：预览面的挂载 / 收档", () => {
  it("预览档挂出 iframe 并写入 srcdoc；源码档收掉内容与宿主标记", () => {
    const docId = newDoc("index.html", "D:\\docs\\index.html", "<h1>标题</h1>");
    const tab = newTab(docId, 21, "<h1>标题</h1>");
    tab.viewMode = "preview";
    const panel = newPanel(21, tab.tabId);

    applyHtmlPreviewFace(panel, tab, "preview");
    const host = panel.bodyEl!;
    expect(host.classList.contains("preview-kind-html")).toBe(true);
    const frame = host.querySelector<HTMLIFrameElement>(".html-preview iframe");
    expect(frame).not.toBeNull();
    // 脚本要在沙箱里执行（allow-scripts），但绝不能给同源（同源 = 页面能摸到 Tauri IPC）。
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame!.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame!.srcdoc).toContain("<h1>标题</h1>");
    expect(frame!.srcdoc).toContain("<base href=");
    expect(frame!.srcdoc).toContain("data-litepad-preview-bridge");
    expect(frame!.dataset.docId).toBe(String(docId));

    applyHtmlPreviewFace(panel, tab, "source");
    expect(host.classList.contains("preview-kind-html")).toBe(false);
    expect(frame!.srcdoc).toBe("");
  });

  it("Markdown 标签不建这张面（它的预览是装饰脸）", () => {
    const docId = newDoc("a.md", "D:\\docs\\a.md", "# a");
    const tab = newTab(docId, 22);
    tab.viewMode = "preview";
    const panel = newPanel(22, tab.tabId);

    applyHtmlPreviewFace(panel, tab, "preview");
    expect(panel.bodyEl!.querySelector(".html-preview")).toBeNull();
    expect(panel.bodyEl!.classList.contains("preview-kind-html")).toBe(false);
  });

  it("iframe 里的按键经 bridge 转回宿主 window：预览抢到焦点后快捷键不能全失灵", () => {
    const docId = newDoc("index.html", "D:\\docs\\index.html", "<h1>x</h1>");
    const tab = newTab(docId, 24, "<h1>x</h1>");
    tab.viewMode = "preview";
    const panel = newPanel(24, tab.tabId);
    applyHtmlPreviewFace(panel, tab, "preview");
    const frame = panel.bodyEl!.querySelector<HTMLIFrameElement>(".html-preview iframe")!;

    const seen = vi.fn();
    window.addEventListener("keydown", seen, true);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          __litepadPreview: 1,
          type: "key",
          key: "/",
          code: "Slash",
          location: 0,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          repeat: false,
        },
        source: frame.contentWindow!,
      }),
    );
    expect(seen).toHaveBeenCalled();
    window.removeEventListener("keydown", seen, true);
  });

  it("认不出源的消息丢掉：别的窗口不能借 bridge 触发宿主快捷键", () => {
    const docId = newDoc("index.html", "D:\\docs\\index.html", "<h1>x</h1>");
    const tab = newTab(docId, 25, "<h1>x</h1>");
    tab.viewMode = "preview";
    const panel = newPanel(25, tab.tabId);
    applyHtmlPreviewFace(panel, tab, "preview");

    const seen = vi.fn();
    window.addEventListener("keydown", seen, true);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __litepadPreview: 1, type: "key", key: "/", ctrlKey: true },
        source: window,
      }),
    );
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen, true);
  });

  it("链接消息按文档目录落地：相对链接开成标签而不是把 WebView 导航走", () => {
    const docId = newDoc("index.html", "D:\\docs\\index.html", "<h1>x</h1>");
    const tab = newTab(docId, 26, "<h1>x</h1>");
    tab.viewMode = "preview";
    const panel = newPanel(26, tab.tabId);
    applyHtmlPreviewFace(panel, tab, "preview");
    const frame = panel.bodyEl!.querySelector<HTMLIFrameElement>(".html-preview iframe")!;

    const openLocal = vi.fn();
    setPreviewHooks({
      onToggleTask: () => {},
      canToggleTask: () => true,
      openLocalFile: openLocal,
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __litepadPreview: 1, type: "link", href: "notes.txt" },
        source: frame.contentWindow!,
      }),
    );
    expect(openLocal).toHaveBeenCalledWith("D:\\docs\\notes.txt");
  });

  it("点中预览内容：向所属分屏补发 mousedown，激活面板与标签", () => {
    const docId = newDoc("index.html", "D:\\docs\\index.html", "<h1>x</h1>");
    const tab = newTab(docId, 28, "<h1>x</h1>");
    tab.viewMode = "preview";
    const panel = newPanel(28, tab.tabId);
    // 真实结构：.layout-panel > .panel-host > .html-preview > iframe
    const layoutPanel = document.createElement("div");
    layoutPanel.className = "layout-panel";
    layoutPanel.dataset.panelId = "28";
    layoutPanel.appendChild(panel.bodyEl!);
    document.body.appendChild(layoutPanel);
    const activated = vi.fn();
    layoutPanel.addEventListener("mousedown", activated);

    applyHtmlPreviewFace(panel, tab, "preview");
    const frame = panel.bodyEl!.querySelector<HTMLIFrameElement>(".html-preview iframe")!;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __litepadPreview: 1, type: "activate" },
        source: frame.contentWindow!,
      }),
    );
    expect(activated).toHaveBeenCalledTimes(1);
  });

  it("阅读位置按文档记：切到另一份 HTML 不继承上一份的滚动量", () => {
    const docA = newDoc("a.html", "D:\\docs\\a.html", "<h1>a</h1>");
    const tabA = newTab(docA, 27, "<h1>a</h1>");
    tabA.viewMode = "preview";
    const panel = newPanel(27, tabA.tabId);
    applyHtmlPreviewFace(panel, tabA, "preview");
    const frame = panel.bodyEl!.querySelector<HTMLIFrameElement>(".html-preview iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __litepadPreview: 1, type: "scroll", top: 120 },
        source: frame.contentWindow!,
      }),
    );

    const docB = newDoc("b.html", "D:\\docs\\b.html", "<h1>b</h1>");
    const tabB = newTab(docB, 27, "<h1>b</h1>");
    tabB.viewMode = "preview";
    panel.viewTabId = tabB.tabId;
    panel.activeTabId = tabB.tabId;
    applyHtmlPreviewFace(panel, tabB, "preview");
    frame.dispatchEvent(new Event("load"));
    expect(post).not.toHaveBeenCalled();

    panel.viewTabId = tabA.tabId;
    panel.activeTabId = tabA.tabId;
    applyHtmlPreviewFace(panel, tabA, "preview");
    frame.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledWith({ __litepadPreviewHost: 1, type: "scrollTo", top: 120 }, "*");
  });

  it("同源另一格改正文：可见预览合并重渲染，源码档不渲染", () => {
    vi.useFakeTimers();
    const docId = newDoc("index.html", "D:\\docs\\index.html", "<h1>旧</h1>");
    const tab = newTab(docId, 23, "<h1>旧</h1>");
    tab.viewMode = "preview";
    const panel = newPanel(23, tab.tabId);
    applyHtmlPreviewFace(panel, tab, "preview");
    const frame = panel.bodyEl!.querySelector<HTMLIFrameElement>(".html-preview iframe")!;

    tab.state = tab.state.update({
      changes: { from: 0, to: tab.state.doc.length, insert: "<h1>新</h1>" },
    }).state;
    refreshHtmlPreviewsOf(docId);
    vi.advanceTimersByTime(500);
    expect(frame.srcdoc).toContain("<h1>新</h1>");

    tab.viewMode = "source";
    tab.state = tab.state.update({
      changes: { from: 0, to: tab.state.doc.length, insert: "<h1>源码</h1>" },
    }).state;
    const before = frame.srcdoc;
    refreshHtmlPreviewsOf(docId);
    vi.advanceTimersByTime(500);
    expect(frame.srcdoc).toBe(before);
  });
});

describe("HTML 预览与分屏拖拽", () => {
  it("拖分隔条期间 iframe 对指针透明（否则事件被 iframe 文档接走，拖动断流）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/body\.layout-dragging\s+iframe\s*\{[^}]*pointer-events:\s*none/);
  });
});
