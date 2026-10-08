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

/** markdown-it 实例类型（export = 风格的 @types 包不支持命名空间引用，借实例类型取 Token）。 */
type MdInstance = ReturnType<typeof MarkdownIt>;
type MdToken = ReturnType<MdInstance["parse"]>[number];

/** inline 规则实际用到的最小 state 结构（StateInline 结构兼容此接口）。 */
interface InlineState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): { content: string };
}

function createMd(): MdInstance {
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
  function mathPlaceholder(state: InlineState, silent: boolean): boolean {
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

/**
 * 与 CodeMirror 的 `doc.lines` 对齐的源码行数。
 *
 * CM6 把文档按 `\n` 切行，**结尾的空段（trailing newline）不计入额外一行**：
 *   "a\nb\n"   → 2 行；  "a\nb\n\n" → 3 行；  "a\n\n" → 2 行；  "" → 1 行。
 * 所以行数 = 换行数 + 1，若以 `\n` 结尾再把那一个空段扣掉。markdown-it 的 `map`
 * 也按 `\n` 计（并内部把 `\r\n` 归一），两边口径一致。
 */
function countSourceLines(src: string): number {
  if (src.length === 0) return 1;
  let n = 1;
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) n++;
  }
  if (src.charCodeAt(src.length - 1) === 10) n--;
  return Math.max(1, n);
}

/** 解析并切分为顶层 block（带 source 行区间）。空文档返回空数组。 */
export function renderBlocks(src: string): MdBlock[] {
  const env = {};
  const tokens = md.parse(src, env);

  const groups: { map: [number, number]; tokens: MdToken[] }[] = [];
  let current: { map: [number, number]; tokens: MdToken[] } | null = null;
  for (const t of tokens) {
    // ⚠️ 收尾 token（heading_close / paragraph_close …）**也是 level 0**，但绝不能另起一块：
    // markdown-it 的标题/段落都是「open(level0) → inline(level1) → close(level0)」三段。
    // 早先这里按 `t.level === 0` 一律当新块 ⇒ 每个标题被切成两块（开标签块 + 闭标签块），
    // 实测 24 行标题文档交出 48 块、闭标签块 `lineStart` 恒为 1；这些空壳块混进预览的
    // `this.blocks` 后，`indexOfBlockAtOffset`（取「最后一个顶边 ≤ offset」）永远命中
    // 顶边与真块相同、却 `lineStart=1` 的伪块 ⇒ 预览那份游标恒为 1（B257 后 = 块首行 + 0
    // 比例的 `v`），一收口就把源码钉回第 1 行（滚动位置清零，来回切标签就看见位置乱跳，
    // 见 B244 四标签复核）。
    // 收尾 token 必须并入当前块（它们本来就属于同一个 block 的边界）。
    if (t.level === 0 && !t.type.endsWith("_close")) {
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
  // ⚠️ B268：末块的 `lineEnd` 必须覆盖到**文档末行**（`doc.lines`），而非 markdown-it 给的
  // 「最后内容行」。文档末尾若有空行（trailing blank lines），markdown-it 的 `map[1]` 只到
  // 最后内容行、不含那些空行 ⇒ `lineEnd < doc.lines`。这会让两侧底部游标错配：
  //   · 源码侧到底 `topVisibleLineFrac` 交 `doc.lines`（最后一行贴容器顶）；
  //   · 预览侧到底 `topVisibleLine()` 交 `lineEnd`（最后一块末行）。
  // 二者不等 ⇒ 同步到底时两侧落点差「末块之后的空行数」：
  //   · 手动滚源码到底（v=doc.lines）再同步，预览只到 lineEnd（看着像没到底）；
  //   · 滚预览到底（v=lineEnd）反推源码，`sourceTopOfV` 只落到 lineEnd（向「上」跳几行）。
  // 把末块 `lineEnd` 拉到文档末行后，两侧底部 `v` 统一为 `doc.lines`，往返闭合。
  // 仅最后一个块受影响（其 `next` 恒为空，`applySyncToLine` 不插值，只落块顶），中间块不变。
  if (blocks.length > 0) {
    const total = countSourceLines(src);
    const last = blocks[blocks.length - 1];
    if (total > last.lineEnd) last.lineEnd = total;
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
