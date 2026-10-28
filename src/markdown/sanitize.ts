// Markdown 文档里的原始 HTML 消毒（B401）。
//
// 两条臂共用：markdown-it 的预览出口（pipeline）与装饰面的 HTML 块 widget。
// 口径照 B397-4a 那一份（InkNote 的渲染法）：先解析、再删能执行/能外链的节点与属性。
// VS Code 的 Markdown 预览同样允许原始 HTML，但会先消毒 —— 这里对齐的是「能渲染」+
// 「不执行」，不是把 HTML 当纯文本吐出来。

const DROP_ELEMENTS = "script,style,iframe,object,embed,link,meta,base";
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction"];

// 内联样式（B402）：VS Code 的预览**不剥** style（CSP 只挡脚本），所以从网页复制来的
// HTML 能保住原样。这里按「只影响这一段怎么画」放行；能定位到应用骨架上的
// （position / display / z-index / transform / inset / overflow / float / behavior…）
// 一个不放。url() 也拦：内联样式不该触发外部请求。
const STYLE_PROP_OK = new Set([
  "color",
  "background",
  "background-color",
  "border",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-collapse",
  "border-spacing",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "font",
  "font-size",
  "font-weight",
  "font-style",
  "font-family",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-indent",
  "vertical-align",
  "white-space",
  "list-style-type",
  "opacity",
  "width",
  "height",
  "max-width",
  "max-height",
  "table-layout",
]);

/** 按顶层 `;` 切声明：`rgb(1;2)` / `url(a;b)` 里的分号不能切。 */
function splitDeclarations(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote && raw[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  out.push(raw.slice(start));
  return out;
}

function keepStyle(raw: string): string | null {
  const kept: string[] = [];
  for (const decl of splitDeclarations(raw)) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl
      .slice(colon + 1)
      .trim()
      .replace(/\s+/g, " ");
    if (!STYLE_PROP_OK.has(prop) || !value) continue;
    if (/url\s*\(|expression\s*\(|behavior|javascript:|@import/i.test(value)) continue;
    kept.push(`${prop}:${value}`);
  }
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
        const kept = keepStyle(attr.value);
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
