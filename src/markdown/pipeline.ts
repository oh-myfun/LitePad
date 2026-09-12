import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";

/**
 * Markdown 渲染管线（M3）：
 * - markdown-it + GFM（表格/删除线/任务列表/自动链接为内置或轻量规则）
 * - 顶层 block 切分：每个 block 带 source line 区间 [mapStart, mapEnd)，供增量 patch 与同步滚动
 * - 标题提取（TOC/大纲）+ 标题锚点 id
 * - KaTeX / Mermaid 占位输出（懒加载增强阶段替换），Shiki 高亮走增强阶段
 */

export interface MdBlock {
  /** source 起始行（1-based） */
  lineStart: number;
  /** source 结束行（含，1-based） */
  lineEnd: number;
  /** 该 block 的 HTML 片段 */
  html: string;
}

export interface TocEntry {
  level: number;
  text: string;
  /** source 行（1-based） */
  line: number;
  /** 锚点 id（与渲染 HTML 中的 heading id 一致） */
  id: string;
}

function slugify(text: string): string {
  return (
    "h-" +
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
  );
}

function createMd(): ReturnType<typeof MarkdownIt> {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  md.use(footnote);

  // ---------- 任务列表（GFM）：[ ] / [x] → checkbox ----------
  md.core.ruler.after("inline", "task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      const children = tokens[i].children;
      if (!children || children.length === 0) continue;
      // 列表项首 text token 为 "[ ] " / "[x] "
      const first = children[0];
      const m = /^\[([ xX])\]\s+/.exec(first.content);
      if (!m || tokens[i - 1]?.type !== "paragraph_open") continue;
      const checked = m[1].toLowerCase() === "x";
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="md-task" disabled${checked ? " checked" : ""}> `;
      children.unshift(box);
      tokens[i - 1].attrJoin("class", "task-item");
    }
    return true;
  });

  // ---------- 数学占位：$...$ / $$...$$ → span（增强阶段用 KaTeX 替换）----------
  function mathPlaceholder(state: any, silent: boolean): boolean {
    const src = state.src;
    const pos = state.pos;
    if (src[pos] !== "$") return false;
    const display = src.startsWith("$$", pos);
    const start = pos + (display ? 2 : 1);
    if (display && src[start] === "$") return false; // 空公式
    const endStr = display ? "$$" : "$";
    const end = src.indexOf(endStr, start);
    if (end < 0) return false;
    const tex = src.slice(start, end).trim();
    if (!tex) return false;
    // 行内公式前后不能紧贴数字/字母（避免 "$5 和 3$" 这类误判）
    if (!display) {
      const before = src[pos - 1];
      if (before && /[0-9A-Za-z]/.test(before)) return false;
      if (/^[0-9]/.test(tex) && /\s/.test(src.slice(start, end))) return false;
    }
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      const cls = display ? "math-display-src" : "math-inline-src";
      token.content = `<span class="${cls}">${md!.utils.escapeHtml(tex)}</span>`;
      // $$ 独占段落时避免生成多余 <p> 包裹问题——保持简单，交给 CSS
    }
    state.pos = end + endStr.length;
    return true;
  }
  md.inline.ruler.before("escape", "math", mathPlaceholder);

  // ---------- Mermaid 围栏 → 占位 pre（增强阶段用 Mermaid 替换）----------
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || "").trim().split(/\s+/)[0].toLowerCase();
    if (info === "mermaid") {
      return `<pre class="mermaid-src">${md.utils.escapeHtml(token.content)}</pre>`;
    }
    const inner = `<code class="language-${md.utils.escapeHtml(info)}">${md.utils.escapeHtml(token.content)}</code>`;
    return `<pre class="md-code" data-lang="${md.utils.escapeHtml(info)}">${inner}</pre>`;
  };

  // ---------- 标题锚点 id ----------
  const defaultHeadingOpen = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const inline = tokens[idx + 1];
    const text = inline?.content ?? "";
    if (!tokens[idx].attrGet("id")) {
      tokens[idx].attrSet("id", slugify(text));
    }
    return defaultHeadingOpen
      ? defaultHeadingOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  return md;
}

const md = createMd();

/** 解析并切分为顶层 block（带 source 行区间）。空文档返回空数组。 */
export function renderBlocks(src: string): MdBlock[] {
  const env = {};
  const tokens = md.parse(src, env);

  const groups: { map: [number, number]; tokens: any[] }[] = [];
  let current: { map: [number, number]; tokens: any[] } | null = null;
  for (const t of tokens) {
    if (t.level === 0) {
      if (t.hidden && current && t.type !== "heading_open") {
        // 隐藏的顶层 token（如 text 特例）并入当前 block
        current.tokens.push(t);
        continue;
      }
      current = { map: (t.map ?? [0, 1]) as [number, number], tokens: [t] };
      groups.push(current);
    } else if (current) {
      current.tokens.push(t);
      const end = t.map ? t.map[1] : current.map[1];
      if (end > current.map[1]) current.map[1] = end;
    }
  }

  const blocks: MdBlock[] = [];
  for (const g of groups) {
    // 区间修正：用 close token 之后的边界；map[1] 为 exclusive，转 inclusive
    const html = md.renderer.render(g.tokens, md.options, env);
    blocks.push({ lineStart: g.map[0] + 1, lineEnd: Math.max(g.map[1], g.map[0] + 1), html });
  }
  return blocks;
}

/** 提取标题大纲（h1–h6），含 source 行与锚点 id。 */
export function extractToc(src: string): TocEntry[] {
  const env = {};
  const tokens = md.parse(src, env);
  const out: TocEntry[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || t.level !== 0) continue;
    const level = Number(t.tag.slice(1));
    const inline = tokens[i + 1];
    const text = (inline?.content ?? "").trim();
    let id = slugify(text);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    out.push({ level, text, line: (t.map?.[0] ?? 0) + 1, id });
  }
  return out;
}

/** 一次性全量渲染（导出 HTML 用）。 */
export function renderFull(src: string): string {
  return md.render(src, {});
}
