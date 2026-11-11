// B465 · 折行行高的量尺：把「每一行折出来多高」一次算清，而不是等滚到才准。
//
// 病根：CM6 只对**进过视口**的行给实测高度，视口外的折行行按字符数估
// （`HeightOracle.heightForLine`），而 `lineBlockAt` 读到的就是这份估值。估值会随着
// 「又量到几行」而变 ⇒ 概览色带/滑块每滚一段就换一次答案，调整分屏比例后也要等
// 再滚一下才落到最终值（用户报的「色条不稳定」「滚动条区域要拖动才刷新」）。
//
// ⚠️ **只喂概览轴，不喂补缝**。补缝必须吃 CM6 的高度图（`lineHeights`），缝与滚动坐标
// 才同源、两栏逐行对齐；概览轴是「给整篇画一张稳定的像素地图」，要的是不随视口漂移的
// 实测值。两处各取所需，别合并。
//
// 上游 VS Code 的概览尺也不读子编辑器的懒量测：行高由 `viewModelLines.ts` 的折行计算
// 对任意行现算（`LineBreaksComputer`）。这里走同一口径，只把「按字符宽度推算」换成更准的
// 「让浏览器自己折一遍」：把每一行正文放进一颗与正文同宽、同一套排版样式的隐藏量具里量。
//
// ⚠️ 量具里是**纯文本**。本仓库的语法配色只改颜色（`editor/theme.ts` 的
// `HighlightStyle` 只有 Markdown 的标题 / 粗体 / 斜体改字形），代码文件的折行与正文
// 完全一致；Markdown 那几个加粗行可能宽出一两个字符，是已知的近似。
// ⚠️ 只在折行开着时用（不折行时一个文档行恒等于一个视觉行，`defaultLineHeight` 就是答案）。
// ⚠️ 量具挂在 `.cm-editor` 里、绝对定位且零高裁剪：参与布局（浏览器真的折行、真的算高），
// 但不占位、不进滚动区。CM6 的 DOM 观察只盯 `.cm-content`，动这里不会触发它的同步。

import type { EditorView } from "@codemirror/view";

/** 空行也要占一个视觉行：量具里给一颗零宽空格。 */
const EMPTY_PROBE = "\u200b";

/** 量具行与真实行共用 `.cm-line` 的内距规则（baseTheme），只多一颗测试与调试用的钩子类。 */
const PROBE_LINE_CLASS = "diff-wrap-probe-line";

/** 缓存上限：一份文档的行文本集合不会无界增长，超了就整个丢掉重来。 */
const CACHE_LIMIT = 20000;

/** 决定「一行折出来多高」的排版属性 —— 变了就必须把缓存全部作废。 */
const TYPOGRAPHY = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "fontFeatureSettings",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "textAlign",
  "textIndent",
  "direction",
  "textTransform",
] as const;

export interface WrapMeter {
  /**
   * 这一栏每行（1-based，索引 0 = 第 1 行）折行后的像素高度。
   *
   * 量不出来（面板还没宽度、整栏不可见、没有渲染环境）⇒ `null`，调用方退回 CM6 的估值。
   */
  heights(): number[] | null;
  /** 排版变了（异步字体就绪 / 字号行距换了）⇒ 丢掉缓存，下次重量。 */
  invalidate(): void;
  dispose(): void;
}

/**
 * 给一颗视图配一把量尺。
 *
 * 缓存按**行文本**记账（不是行号）：键入只让一两行变成新文本，其余行一次命中；
 * 拖分屏 / 改字号则靠签名整批作废。
 */
export function createWrapMeter(view: EditorView): WrapMeter {
  let host: HTMLElement | null = null;
  let signature = "";
  const cache = new Map<string, number>();
  let disposed = false;

  const ensureHost = (): HTMLElement => {
    if (host) return host;
    host = document.createElement("div");
    host.className = "diff-wrap-probe";
    host.setAttribute("aria-hidden", "true");
    const css = host.style;
    css.position = "absolute";
    css.top = "0";
    css.left = "0";
    css.maxHeight = "0";
    css.overflow = "hidden";
    css.visibility = "hidden";
    css.pointerEvents = "none";
    css.boxSizing = "border-box";
    view.dom.appendChild(host);
    return host;
  };

  const heights = (): number[] | null => {
    if (disposed) return null;
    const content = view.contentDOM;
    const rect = content.getBoundingClientRect();
    const cs = window.getComputedStyle(content);
    const width =
      rect.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (!(width > 0)) return null;

    // 排版来源优先取**渲染出来的第一行**：它把行上的内距 / 行距 / 继承下来的空白折叠
    // 规则都算进去了；一行都没渲染时退回正文容器（此时也量不到行高，随后会返回 null）。
    const lineEl = content.querySelector<HTMLElement>(".cm-line");
    const style = lineEl ? window.getComputedStyle(lineEl) : cs;

    const sig = [Math.round(width * 100), ...TYPOGRAPHY.map((p) => style[p])].join("|");
    if (sig !== signature) {
      signature = sig;
      cache.clear();
    }

    const hostEl = ensureHost();
    hostEl.style.width = `${width}px`;
    for (const prop of TYPOGRAPHY) hostEl.style[prop] = style[prop];

    const doc = view.state.doc;
    const keys = new Array<string>(doc.lines);
    const missing: string[] = [];
    const seen = new Set<string>();
    for (let line = 1; line <= doc.lines; line++) {
      const key = doc.line(line).text || EMPTY_PROBE;
      keys[line - 1] = key;
      if (!cache.has(key) && !seen.has(key)) {
        seen.add(key);
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      if (cache.size + missing.length > CACHE_LIMIT) cache.clear();
      const frag = document.createDocumentFragment();
      const els: HTMLElement[] = [];
      for (const text of missing) {
        const el = document.createElement("div");
        el.className = `cm-line ${PROBE_LINE_CLASS}`;
        el.textContent = text;
        els.push(el);
        frag.appendChild(el);
      }
      hostEl.appendChild(frag);
      let bad = false;
      for (let i = 0; i < els.length; i++) {
        const h = els[i].getBoundingClientRect().height;
        if (h > 0) cache.set(missing[i], h);
        else bad = true;
      }
      hostEl.replaceChildren();
      if (bad) return null;
    }

    const out = new Array<number>(doc.lines);
    for (let i = 0; i < keys.length; i++) {
      const h = cache.get(keys[i]);
      if (h === undefined) return null;
      out[i] = h;
    }
    return out;
  };

  return {
    heights,
    invalidate: () => {
      signature = "";
      cache.clear();
    },
    dispose: () => {
      disposed = true;
      cache.clear();
      host?.remove();
      host = null;
    },
  };
}
