// HTML 的预览面：和 Markdown 不同，它不是那颗 EditorView 的一张装饰脸，
// 而是一张独立的 `<iframe>` —— 网页要由浏览器自己的排版 / 样式引擎来渲染。
//
// 口径：
//   · **脚本照常执行，但拿不到宿主**：沙箱只给 `allow-scripts`，文档落在 opaque origin。
//     页面自家的 `<script src>` / 样式 / 图片按文档目录（asset 地址）解析，行为贴近浏览器
//     直接打开本地文件；fetch / ES module / webfont 这类需要 CORS 的读取会被 opaque origin
//     拦下。**绝不能**再加 `allow-same-origin`：同源 iframe 能摸到宿主的
//     `__TAURI_INTERNALS__`，等于把读写任意文件的能力交给这份 HTML。
//   · **不许把 WebView 导航走**：脚本与宿主隔着文档边界，链接点击 / 快捷键 / 右键菜单 /
//     点击激活由注入的 bridge 走 `postMessage` 交回宿主（B401 口径）。纯锚点在页内滚，
//     本地文件开成标签，http(s) 交给系统浏览器。
//   · 相对资源按文档目录解析：`<base>` 指向该目录的 asset 地址（`assetUrl`）。
//     未保存的文档没有目录，只能按无基准渲染。

import { type Panel, type Tab, docs, panels, tabs } from "../core/app-state";
import { isHtmlTab } from "../doc-model";
import { dirOf, followLink } from "../markdown/links";
import { assetUrl } from "./assets";
import { previewHooks } from "./hooks";

/** 连续输入时合并重渲染，别每敲一个字就整页重载 iframe。 */
const REFRESH_DEBOUNCE_MS = 180;

const refreshTimers = new Map<number, number>();

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * 注入预览文档的交互 bridge。脚本能跑（`allow-scripts`）而宿主读不到 contentDocument
 * （opaque origin），链接 / 快捷键 / 右键只能由页内这一小段转发回宿主。
 */
const PREVIEW_BRIDGE = [
  "<script data-litepad-preview-bridge>(function () {",
  "  function send(type, data) {",
  '    try { parent.postMessage(Object.assign({ __litepadPreview: 1, type: type }, data), "*"); } catch (e) {}',
  "  }",
  '  document.addEventListener("contextmenu", function (e) { e.preventDefault(); }, true);',
  // iframe 里的 mousedown 冒泡不到宿主，面板自己的「点谁激活谁」监听永远收不到。
  '  document.addEventListener("mousedown", function () { send("activate", {}); }, true);',
  "  var scrollPending = false;",
  '  window.addEventListener("scroll", function () {',
  "    if (scrollPending) return;",
  "    scrollPending = true;",
  "    requestAnimationFrame(function () {",
  "      scrollPending = false;",
  '      send("scroll", { top: window.scrollY });',
  "    });",
  "  }, true);",
  '  window.addEventListener("message", function (e) {',
  "    var d = e.data;",
  '    if (e.source === parent && d && d.__litepadPreviewHost === 1 && d.type === "scrollTo") {',
  "      window.scrollTo(0, d.top);",
  "    }",
  "  });",
  '  document.addEventListener("keydown", function (e) {',
  "    if (e.isComposing) return;",
  '    send("key", { key: e.key, code: e.code, location: e.location, ctrlKey: e.ctrlKey,',
  "      shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat });",
  "  }, true);",
  '  document.addEventListener("click", function (e) {',
  "    var anchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;",
  "    if (!anchor) return;",
  '    var href = anchor.getAttribute("href") || "";',
  '    if (href.charAt(0) === "#") {',
  "      var id = href.slice(1);",
  "      try { id = decodeURIComponent(id); } catch (err) {}",
  "      var el = document.getElementById(id) || document.getElementsByName(id)[0];",
  '      if (el) { e.preventDefault(); el.scrollIntoView({ block: "start" }); }',
  "      return;",
  "    }",
  "    e.preventDefault();",
  '    send("link", { href: href });',
  "  }, true);",
  "})();</script>",
].join("\n");

/**
 * 把 `<base>`（有目录时才插）与 bridge 插进用户 HTML 的 `<head>`。
 *
 * 为什么不直接拼在最前面：`<!doctype html>` 必须留在首位，否则整页掉进怪异模式；
 * 没有 `<head>` 时把 `<head>` 放在 `<html>` 与 doctype 之间也会被解析器丢掉。
 * 所以按「head → html → doctype 后面包一层 html → 整段包一层」四级落点。
 */
export function buildHtmlPreviewDocument(source: string, baseHref: string | null): string {
  const injection = (baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "") + PREVIEW_BRIDGE;
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(source);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return source.slice(0, at) + injection + source.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(source);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return source.slice(0, at) + `<head>${injection}</head>` + source.slice(at);
  }
  const doctype = /<!doctype[^>]*>/i.exec(source);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return (
      source.slice(0, at) +
      `<html><head>${injection}</head><body>` +
      source.slice(at) +
      "</body></html>"
    );
  }
  return `<html><head>${injection}</head><body>` + source + "</body></html>";
}

/** 文档目录的 asset 基准地址（带结尾斜杠）；没有路径就没有基准。 */
function htmlPreviewBase(docPath: string | null): string | null {
  if (!docPath) return null;
  const dir = dirOf(docPath);
  if (!dir || dir === docPath) return null;
  const url = assetUrl(dir);
  return url.endsWith("/") ? url : `${url}/`;
}

/** 跨文档后只能按「消息来自哪个窗口」找回 iframe。 */
const frameByWindow = new WeakMap<Window, HTMLIFrameElement>();
let hostMessageBound = false;
/**
 * 阅读位置按**文档**记：同一面板里的 HTML 标签共用一个 iframe，位置若跟着元素走，
 * 切到另一份 HTML 就会继承上一份的滚动量。
 */
const previewScrollByDoc = new Map<number, number>();

function ensureFrame(host: HTMLElement): HTMLIFrameElement {
  const existing = host.querySelector<HTMLIFrameElement>(":scope > .html-preview > iframe");
  if (existing) return existing;
  const wrap = document.createElement("div");
  wrap.className = "html-preview";
  const frame = document.createElement("iframe");
  frame.className = "html-preview-frame";
  // 只给脚本执行权、不给同源：opaque origin 让页面够不到宿主的 Tauri IPC（见文件头）。
  frame.setAttribute("sandbox", "allow-scripts");
  // 原生 title 由系统绘制（不吃主题），无障碍名走 aria-label（tooltip-classes 契约）。
  frame.setAttribute("aria-label", "HTML 预览");
  wrap.appendChild(frame);
  host.appendChild(wrap);
  const win = frame.contentWindow;
  if (win) frameByWindow.set(win, frame);
  if (!hostMessageBound) {
    hostMessageBound = true;
    window.addEventListener("message", onPreviewMessage);
  }
  return frame;
}

interface PreviewKeyMessage {
  __litepadPreview: 1;
  type: "key";
  key: string;
  code: string;
  location: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

interface PreviewLinkMessage {
  __litepadPreview: 1;
  type: "link";
  href: string;
}

interface PreviewScrollMessage {
  __litepadPreview: 1;
  type: "scroll";
  top: number;
}

interface PreviewActivateMessage {
  __litepadPreview: 1;
  type: "activate";
}

/**
 * bridge 的回执。`event.source` 是唯一可信的身份：页面脚本能伪造消息内容，但改变不了
 * 自己来自哪张 iframe；认不出源的消息一律丢掉。
 */
function onPreviewMessage(event: MessageEvent): void {
  const frame = event.source ? frameByWindow.get(event.source as Window) : undefined;
  if (!frame) return;
  const data = event.data as
    PreviewKeyMessage | PreviewLinkMessage | PreviewScrollMessage | PreviewActivateMessage | null;
  if (!data || data.__litepadPreview !== 1) return;
  if (data.type === "scroll") {
    previewScrollByDoc.set(Number(frame.dataset.docId ?? ""), data.top);
    return;
  }
  if (data.type === "activate") {
    // 面板的「点谁激活谁」挂在 `.layout-panel` 的 mousedown 上，而 iframe 里的点击
    // 跨不过文档边界。补一次 mousedown 走同一条激活路径（标题 / 状态 / 大纲 / 查找栏
    // 都跟着刷新）；预览档里编辑器是 display:none，激活时那次 focus 落空，网页不会失焦。
    frame.closest(".layout-panel")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return;
  }
  if (data.type === "key") {
    // 跨文档拿不到「宿主认没认领」的同步结果：照常分发，页面自己的默认行为保留。
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: data.key,
        code: data.code,
        location: data.location,
        ctrlKey: data.ctrlKey,
        shiftKey: data.shiftKey,
        altKey: data.altKey,
        metaKey: data.metaKey,
        repeat: data.repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
    return;
  }
  const doc = docs.get(Number(frame.dataset.docId ?? ""));
  if (!doc) return;
  followLink(data.href, {
    baseDir: doc.path ? dirOf(doc.path) : null,
    openLocal: previewHooks().openLocalFile,
  });
}

function renderPreview(panel: Panel, tab: Tab): void {
  const host = panel.bodyEl;
  if (!host) return;
  const doc = docs.get(tab.docId);
  if (!doc) return;
  const frame = ensureFrame(host);
  frame.dataset.docId = String(tab.docId);
  // 实时刷新时整页会重载：把阅读位置带过去，别每改一个字就弹回顶部。
  // opaque origin 下宿主读不到 contentWindow 的滚动，位置由 bridge 的 scroll 回执按文档记着；
  // 重载完再让 bridge 自己滚回这个位置。
  const top = previewScrollByDoc.get(tab.docId) ?? 0;
  frame.srcdoc = buildHtmlPreviewDocument(tab.state.doc.toString(), htmlPreviewBase(doc.path));
  if (top > 0) {
    frame.addEventListener(
      "load",
      () => {
        frame.contentWindow?.postMessage({ __litepadPreviewHost: 1, type: "scrollTo", top }, "*");
      },
      { once: true },
    );
  }
}

/**
 * 档位出口（`markdown.applyPanelMode` 调用）：HTML 预览档挂出 iframe，其余档收掉。
 *
 * `mode` 由调用方按可预览类型归一（非可预览标签恒 `source`），这里仍再问一次
 * `isHtmlTab`：Markdown 的预览/编辑档是装饰脸，没有这张 DOM 面。
 */
export function applyHtmlPreviewFace(panel: Panel, tab: Tab | undefined, mode: string): void {
  const host = panel.bodyEl;
  if (!host) return;
  const on = !!tab && panel.viewTabId === tab.tabId && isHtmlTab(tab) && mode !== "source";
  host.classList.toggle("preview-kind-html", on);
  const frame = host.querySelector<HTMLIFrameElement>(":scope > .html-preview > iframe");
  if (!on) {
    // 阅读位置已由 bridge 的 scroll 回执按文档记着，清空文档即可。
    if (frame && frame.srcdoc !== "") frame.srcdoc = "";
    return;
  }
  renderPreview(panel, tab);
}

/** 同源另一格改了正文：把可见的 HTML 预览重渲染一遍（合并连续击键）。 */
export function refreshHtmlPreviewsOf(docId: number): void {
  for (const panel of panels.values()) {
    const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
    if (!tab || tab.docId !== docId || !isHtmlTab(tab) || tab.viewMode === "source") continue;
    const panelId = panel.panelId;
    const pending = refreshTimers.get(panelId);
    if (pending !== undefined) window.clearTimeout(pending);
    refreshTimers.set(
      panelId,
      window.setTimeout(() => {
        refreshTimers.delete(panelId);
        const p = panels.get(panelId);
        const t = p ? tabs.get(p.viewTabId ?? p.activeTabId) : undefined;
        if (!p || !t || t.docId !== docId || !isHtmlTab(t) || t.viewMode === "source") return;
        renderPreview(p, t);
      }, REFRESH_DEBOUNCE_MS),
    );
  }
}
