// Markdown 文档里的原始 HTML 消毒（B401）。
//
// 两条臂共用：markdown-it 的预览出口（pipeline）与装饰面的 HTML 块 widget。
// 口径照 B397-4a 那一份（InkNote 的渲染法）：先解析、再删能执行/能外链的节点与属性。
// VS Code 的 Markdown 预览同样允许原始 HTML，但会先消毒 —— 这里对齐的是「能渲染」+
// 「不执行」，不是把 HTML 当纯文本吐出来。

const DROP_ELEMENTS = "script,style,iframe,object,embed,link,meta,base";
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction"];

// VS Code 的 Markdown 预览只给 `<span>` 留几条无害的样式（颜色 / 圆角）；
// 其它元素上的 style 一律剥掉 —— 排版靠文档自己的 CSS，不靠内联样式改应用骨架。
const SPAN_STYLE_OK = [
  /^color:#[0-9a-f]{3,8}$/i,
  /^background-color:#[0-9a-f]{3,8}$/i,
  /^border-radius:\d+px$/i,
];

function keepSpanStyle(raw: string): string | null {
  const kept = raw
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, ""))
    .filter((d) => d && SPAN_STYLE_OK.some((re) => re.test(d)));
  return kept.length ? kept.join(";") : null;
}

export function sanitizeHtmlInto(target: Element, html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll(DROP_ELEMENTS).forEach((el) => el.remove());
  parsed.querySelectorAll<HTMLElement>("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // 先剥掉所有 ≤ U+0020 的字符再判协议：`java\nscript:` 是 classic 混淆手法
      // （InkNote 写的是 /[\u0000-\u0020]+/g，这里按码位过滤，免得踩 no-control-regex 那条 lint）
      const value = Array.from(attr.value.trim())
        .filter((ch) => ch.charCodeAt(0) > 0x20)
        .join("");
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if (name === "style") {
        const kept = el.tagName === "SPAN" ? keepSpanStyle(attr.value) : null;
        if (kept) el.setAttribute("style", kept);
        else el.removeAttribute(attr.name);
      }
      if (
        URL_ATTRS.includes(name) &&
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

/** 同一份口径的字符串出口（markdown-it 的 block html 在插进 DOM 之前先过一遍）。 */
export function sanitizeHtmlString(html: string): string {
  const wrap = document.createElement("div");
  sanitizeHtmlInto(wrap, html);
  return wrap.innerHTML;
}
