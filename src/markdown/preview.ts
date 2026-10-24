import { enhanceMarkdown, nextEnhanceSeq } from "./enhance";

import type { MdBlock } from "./pipeline";
import type { PreviewScrollSurface } from "../sync-scroll/preview";
import { PreviewScrollAnchor } from "../sync-scroll/preview";
import { syncCoordinator } from "../sync-scroll/wire";

/**
 * Markdown 预览面板（M3）：
 * - 增量 patch：按顶层 block 复用 DOM（html 不变的 block 不动节点）
 * - 增强走 `./enhance` 的共享出口（B352-2：IR 的块 widget 调同一个，防两份懒加载守卫各漂一半）
 * - 本地定位：按源行号滚动（大纲跳转 / 转到行），异步重排后按待定位行重落
 */

const LAZY_THRESHOLD_LINES = 5000; // 大文档：关闭 Mermaid/Shiki 自动渲染

export interface PreviewHost {
  /** 文档总行数（大文档降级判断用） */
  lineCount(): number;
}

interface BlockNode {
  html: string;
  el: HTMLElement;
}

/**
 * 新旧岛表的最长公共前段 / 后段。
 *
 * ⚠️ 判据**只许比 `html`**，不许掺行号：上方多一段就会把下面所有块的行号推走，
 * 掺进行号等于每次插入都让整条后段作废 —— 就地补丁的收益当场归零。
 */
function alignIslands(prev: BlockNode[], next: MdBlock[]): { head: number; tail: number } {
  let head = 0;
  while (head < prev.length && head < next.length && prev[head].html === next[head].html) head++;
  const room = Math.min(prev.length - head, next.length - head);
  let tail = 0;
  while (tail < room && prev[prev.length - 1 - tail].html === next[next.length - 1 - tail].html) {
    tail++;
  }
  return { head, tail };
}

export class PreviewPane {
  readonly root: HTMLElement;
  private blocks: BlockNode[] = [];
  private host: PreviewHost | null = null;
  /** 程序定位（大纲跳转/转到行）的目标行：异步增强或图片加载重排后据此重定位 */
  private pendingSyncLine: number | null = null;
  /** 活动文档目录（相对路径图片解析基准） */
  private baseDir: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "md-preview md-rendered";
    // 图片/iframe 的 load 不冒泡，用捕获阶段监听——布局变化后按 pending 行重定位
    this.root.addEventListener("load", () => this.applyPending(), true);
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // 任务列表点击切换（预览态，不回写源码，M3 仅展示）
      if (target instanceof HTMLInputElement && target.classList.contains("md-task")) {
        e.preventDefault();
        return;
      }
      // 点击链接交给浏览器默认行为（锚点/脚注跳转）
      if (target.closest("a")) return;
    });
  }

  setHost(host: PreviewHost): void {
    this.host = host;
  }

  setBaseDir(dir: string | null): void {
    this.baseDir = dir;
  }

  // ------------------------------------------------ 渲染

  /** 增量 patch：公共前段 + 公共后段之外才重建，未变的岛一个节点都不碰。 */
  setBlocks(list: MdBlock[], options: { enhanced?: boolean } = {}): void {
    // ⚠️ 动手之前第一件事就是读位置：摘岛会让浏览器当场按新的 `scrollHeight` 把
    //    `scrollTop` 裁小（改末块那一形最明显），删完再读拿到的是「已经跳过的位置」，
    //    扶回去等于没扶（B288，真机台 --trace=rerender 实测 调用前 602 / 调用后 0）。
    const prevScroll = this.root.scrollTop;
    const prev = this.blocks;
    const { head, tail } = alignIslands(prev, list);
    // 长度相同且前段吃满整份 = 一个字都没变
    const contentChanged = head !== list.length || head + tail !== prev.length;

    // 查找标记先拆干净：被替换的 block 会带走标记，而复用的 block 会把
    // 旧标记留在节点里，导致计数与 DOM 脱节（重放由 main 层在 patch 后进行）
    if (this.findMarks.length > 0) {
      this.clearFindMarks();
      this.findActive = -1;
    }

    for (const stale of prev.slice(head, prev.length - tail)) stale.el.remove();
    const middle = list.slice(head, list.length - tail).map((b) => this.createIsland(b));
    // 未变的那一排岛没被摘走，所以容器从头到尾没空过（位置读取排在函数开头，见上）。
    const before = prev[prev.length - tail]?.el ?? this.noticeEl ?? null;
    for (const el of middle) this.root.insertBefore(el, before);

    const next: BlockNode[] = [
      ...prev.slice(0, head),
      ...middle.map((el, i) => ({ html: list[head + i].html, el })),
      ...prev.slice(prev.length - tail),
    ];
    for (let i = 0; i < head; i++) {
      next[i].el.dataset.lineStart = String(list[i].lineStart);
      next[i].el.dataset.lineEnd = String(list[i].lineEnd);
    }
    for (let j = 0; j < tail; j++) {
      const el = next[next.length - tail + j].el;
      const b = list[list.length - tail + j];
      el.dataset.lineStart = String(b.lineStart);
      el.dataset.lineEnd = String(b.lineEnd);
    }

    // 内容变了，旧的待定位行号已失去意义（行号基准随文本漂移）→ 作废，
    // 否则下一次重渲染会把视图拽回很久以前跳转过的那一行。
    if (contentChanged) this.pendingSyncLine = null;
    // ⚠️ 先读一次 scrollHeight **强制布局**，再写 scrollTop。不强制的话，写入发生在
    //    「新内容还没定局高度」的那一刻，浏览器会按当时的 scrollHeight 把它裁掉。
    void this.root.scrollHeight;
    this.blocks = next;
    if (this.pendingSyncLine !== null) {
      this.applySyncToLine(this.pendingSyncLine);
    } else {
      this.root.scrollTop = prevScroll;
      this.declareOwnScroll();
    }
    if (options.enhanced !== false) void this.enhance();
    // 重排后布局可能变化（图片/公式占位），按 pending 行再定位一次
    this.applyPending();
  }

  /** 一个顶层 block 的岛壳。只在新建时才碰 `innerHTML`，复用路径永远不经过这里。 */
  private createIsland(b: MdBlock): HTMLElement {
    const el = document.createElement("div");
    el.className = "md-block";
    el.dataset.lineStart = String(b.lineStart);
    el.dataset.lineEnd = String(b.lineEnd);
    el.innerHTML = b.html;
    return el;
  }

  private noticeEl: HTMLElement | null = null;

  /**
   * 在预览区顶部显示一条占位说明（M4 大文件：自动预览被停用时告诉用户原因）。
   * 传 null 移除。它不是 block，不参与 patch、行号同步与查找高亮。
   *
   * 注意：`setBlocks()` 会把 `noticeEl` 当作**尾锚**（新岛一律插在它之前），所以调用顺序
   * 仍然是先 setBlocks 再 setNotice —— 反过来的话，下一次渲染会把新岛插在旧提示之后。
   */
  setNotice(text: string | null): void {
    if (!text) {
      this.noticeEl?.remove();
      this.noticeEl = null;
      return;
    }
    if (!this.noticeEl) {
      this.noticeEl = document.createElement("div");
      this.noticeEl.className = "md-preview-notice";
      this.root.appendChild(this.noticeEl);
    }
    this.noticeEl.textContent = text;
  }

  clear(): void {
    this.blocks = [];
    this.root.replaceChildren();
    this.noticeEl = null;
  }

  // ------------------------------------------------ 预览态查找高亮（B30）

  /** 当前查询包出的命中标记（文档顺序） */
  private findMarks: HTMLElement[] = [];
  private findActive = -1;

  /**
   * 把查找高亮应用到预览 DOM（q=null 清除），返回命中数。
   * 直接对渲染后的文本节点做匹配包装，语义与编辑器查找一致
   * （大小写 / 全词 / 正则）；重渲染会重建 block DOM，由 main 层重放。
   */
  applyFind(
    q: { text: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean } | null,
  ): number {
    this.clearFindMarks();
    this.findActive = -1;
    if (!q || !q.text) return 0;
    const source = q.regexp ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(q.wholeWord ? `\\b(?:${source})\\b` : source, q.caseSensitive ? "g" : "gi");
    } catch {
      return 0; // 非法正则：与编辑器一致按无命中处理
    }
    // 快照当前文本节点再逐个分割包装（包装产生的新节点不在快照里，不会重复扫描）
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const tag = (n as Text).parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      nodes.push(n as Text);
    }
    for (const node of nodes) {
      const text = node.nodeValue ?? "";
      if (!text) continue;
      re.lastIndex = 0;
      const spans: Array<[number, number]> = [];
      for (;;) {
        const m = re.exec(text);
        if (!m) break;
        if (m[0].length === 0) {
          re.lastIndex++;
          continue; // 空匹配防死循环
        }
        spans.push([m.index, m.index + m[0].length]);
      }
      if (spans.length === 0) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const [s, e] of spans) {
        if (s > at) frag.appendChild(document.createTextNode(text.slice(at, s)));
        const mark = document.createElement("mark");
        mark.className = "cm-find-match"; // 复用编辑器命中样式，视觉统一
        mark.textContent = text.slice(s, e);
        frag.appendChild(mark);
        this.findMarks.push(mark);
        at = e;
      }
      if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
      node.parentNode?.replaceChild(frag, node);
    }
    return this.findMarks.length;
  }

  /** 步进当前命中（到头环绕）并滚动到视口中央。 */
  stepFind(dir: 1 | -1): void {
    const n = this.findMarks.length;
    if (n === 0) return;
    this.findActive =
      this.findActive < 0 ? (dir === 1 ? 0 : n - 1) : (this.findActive + dir + n) % n;
    this.findMarks.forEach((m, i) =>
      m.classList.toggle("cm-find-match-active", i === this.findActive),
    );
    // jsdom 未实现 scrollIntoView；WebView2 正常。
    this.findMarks[this.findActive].scrollIntoView?.({ block: "center" });
  }

  findState(): { active: number; count: number } {
    return { active: this.findActive, count: this.findMarks.length };
  }

  /** 拆掉全部命中标记，还原原始文本节点。 */
  private clearFindMarks(): void {
    const parents = new Set<ParentNode>();
    for (const m of this.findMarks) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      m.remove();
      parents.add(parent);
    }
    this.findMarks = [];
    // 合并被标记拆开的相邻文本节点——否则下一次匹配会在拆分边界上
    // 产生伪 \b 词边界（"foo"+"bar" 被当成两个独立词）
    for (const parent of parents) parent.normalize();
  }

  // ------------------------------------------------ 懒加载增强

  private bigDoc(): boolean {
    return (this.host?.lineCount() ?? 0) > LAZY_THRESHOLD_LINES;
  }

  /**
   * 主题换了 ⇒ 把已经画好的 mermaid 岛还原成占位 `pre`，再走一遍增强。
   *
   * mermaid 的 `theme:` 只在**渲染那一刻**读 `dataset.theme`，图一旦画出来就定色了；
   * 而岛级增量会复用那一块（它的 html 没变），所以切主题后图永远停在旧配色（B321）。
   * 只还原带 mermaid 占位的岛 —— 跟着 CSS 变量走的公式 / 高亮 / 已解码的 `<img>` 一律不碰。
   */
  retheme(): void {
    let dirty = false;
    for (const b of this.blocks) {
      if (!b.html.includes("mermaid-src") || !b.el.querySelector(".md-mermaid")) continue;
      b.el.innerHTML = b.html;
      dirty = true;
    }
    if (dirty) void this.enhance();
  }

  /** 包装增强：无论成功/中断都要按 pending 行重定位一次（公式/Mermaid 会改变高度）。 */
  private async enhance(): Promise<void> {
    try {
      await enhanceMarkdown(this.root, nextEnhanceSeq(this.root), {
        bigDoc: this.bigDoc(),
        baseDir: this.baseDir,
      });
    } finally {
      this.applyPending();
    }
  }

  private applySyncToLine(line: number): number | null {
    const target = this.blockAtLine(line);
    if (!target) return null;
    const idx = this.blocks.indexOf(target);
    const next = this.blocks[idx + 1];
    const el = target.el;
    // 块几何不可用（容器未铺开 / display:none / 刚挂载尚未 layout）时，块与容器的
    // rect 全为 0，`blockTop` 算出的 `top` 必为 0——照常返回 0 会被调用方当成
    // 「停在顶部」。这里直接返回 null，让调用方走各自的兜底。判定要求「块 rect 全 0
    // 且容器高 0」二者同时成立才认作未铺开——已铺开的容器（高 > 0）即便某块恰好
    // 贴顶（rect.top=0）也不会误判。
    const eb = el.getBoundingClientRect();
    if (
      eb.top === 0 &&
      eb.left === 0 &&
      eb.width === 0 &&
      eb.height === 0 &&
      this.root.getBoundingClientRect().height === 0
    ) {
      return null;
    }
    // 关键：offsetTop 的基准是最近的**定位祖先**（外层 .layout-panel，含标签栏），
    // 拿它当预览内容偏移会带上几十像素常量误差 → 改用相对预览容器的 rect 差值。
    let top = this.blockTop(el);
    if (next) {
      const range = Math.max(
        1,
        Number(next.el.dataset.lineStart) - Number(el.dataset.lineStart) || 1,
      );
      const into = Math.min(range, Math.max(0, line - Number(el.dataset.lineStart)));
      top += ((this.blockTop(next.el) - top) * into) / range;
    } else {
      // ⚠️ 末块（next 不存在）：上面那条「跨块插值」用不上，旧写法整块落到**块顶**
      //    （lineStart 顶对齐）。但「定位到文档末行」的语义应是「最后一行顶对齐到
      //    容器顶」—— 末块占多行时，只落块顶 ⇒ 最后一行永远差一截到不了顶。
      //    按块内源行均分块高，把请求的源行顶对齐到容器顶（与中段块 `into/range`
      //    插值的落点语义一致）。
      const start = Number(el.dataset.lineStart);
      const lines = Math.max(1, Number(el.dataset.lineEnd) - start + 1);
      const lineIdx = line - start;
      if (lineIdx > 0 && lineIdx < lines) {
        const h = el.getBoundingClientRect().height || 0;
        top += (h / lines) * lineIdx;
      }
    }
    // ANCHOR = 0：落点就是块顶本身（旧口径是块顶往回让 8 像素，那一对常数是往返攒误差的
    // 来源，随 B251 一起撤掉 —— B245 的「越切越靠顶」在 ANCHOR = 0 下没有病根可犯）。
    const nextTop = Math.max(0, top);
    this.root.scrollTop = nextTop;
    // 这一发是我们自己写的（大纲跳转 / 转到行 / 增强后补定位），必须登记：否则它会被
    // 协调器当作用户滚动广播给同文档的其它视口，把那边也拽过来（拽完那边再回报回来）。
    this.declareOwnScroll();
    return nextTop;
  }

  /**
   * 向同步滚动账本认领「刚刚那次 `scrollTop` 写入是我自己干的」。
   *
   * 必须在写入之后的**同一同步调用栈**内调用：浏览器每元素每帧只派发一发 `scroll`、
   * 读的是那一帧的最终值，所以只要登记赶在那发派发之前，这一发就会被账本吞掉。
   * 登记的是**当前读回**的 `v`（不是想要的目标行）：这一发的语义是「它停在这儿也是我
   * 造成的」，位置由内容决定，我们不该替它承诺去哪儿。
   */
  private declareOwnScroll(): void {
    const anchor = new PreviewScrollAnchor(this.scrollSurface());
    // 这两处都是「刚写完，它停在这儿也是我造成的」⇒ 不假设该落在哪儿，意图与落点同值。
    const here = anchor.getV();
    syncCoordinator.expectSurfaceV(this.root, here, here);
  }

  /** block 相对预览内容区的偏移（不受 offsetParent 与当前滚动影响）。 */
  private blockTop(el: HTMLElement): number {
    const base = this.root.getBoundingClientRect();
    return el.getBoundingClientRect().top - base.top + this.root.scrollTop;
  }

  /**
   * 布局稳定后按 pending 行再定位一次（异步增强 / 图片加载后调用）。
   *
   * 图片 / 公式增强后布局变了，下一帧按 pending 行补定位一次；期间 pending 行被
   * 换掉（新的定位请求）就丢弃这一发。
   */
  private applyPending(): void {
    if (this.pendingSyncLine === null) return;
    const line = this.pendingSyncLine;
    requestAnimationFrame(() => {
      if (this.pendingSyncLine !== line) return;
      this.applySyncToLine(line);
    });
  }

  /**
   * 暴露给同步滚动协调器的预览侧几何表面（v1）。`blocks()` 实时测量各顶层 block 的
   * 源行范围与相对内容区顶的偏移；`root.scrollTop` 可写，供 `PreviewScrollAnchor`
   * 落点；`schedule` 走 rAF，未铺开时重试定位。
   */
  scrollSurface(): PreviewScrollSurface {
    const root = this.root;
    return {
      root: {
        get scrollTop() {
          return root.scrollTop;
        },
        set scrollTop(v: number) {
          root.scrollTop = v;
        },
        get clientHeight() {
          return root.clientHeight;
        },
        // 「到底」的判据要它（B319）：块间节奏让两侧底下面的剩余高度不再相等。
        get scrollHeight() {
          return root.scrollHeight;
        },
      },
      // 箭头函数：词法 this 即 PreviewPane，this.blocks 始终读实时数组（setBlocks 会换引用）。
      blocks: () =>
        this.blocks.map((b) => ({
          lineStart: Number(b.el.dataset.lineStart),
          lineEnd: Number(b.el.dataset.lineEnd),
          top: this.blockTop(b.el),
          height: b.el.getBoundingClientRect().height,
        })),
      schedule: (fn) => {
        requestAnimationFrame(fn);
      },
    };
  }

  private blockAtLine(line: number): BlockNode | null {
    // ⚠️ `line` 可能带行内比例小数（按比例插值的定位坐标）。旧写法
    // `line >= s && line <= e` 兜不住小数：12.3 落在 `[12,12]` 块里却被 `12.3 <= 12`
    // 判否、又够不到 `[13,13]` ⇒ 落到「最后一个块」⇒ 预览被钉到最底部。空行造成的
    // 区间缝隙（段落 [12,14] 与 [16,18] 之间缺 15）也会把小数行号挤到缝里、同样误坠
    // 底部。改按「行号有序」线性找：取 `lineStart <= line` 的最后一块；若该块已含
    // line 直接命中，缝隙 / 单块小数则稳定落到缝隙前那块，不再误坠底部。
    let hit: BlockNode | null = null;
    for (const b of this.blocks) {
      const s = Number(b.el.dataset.lineStart);
      if (line < s) break;
      hit = b;
      const e = Number(b.el.dataset.lineEnd);
      if (line <= e) return b;
    }
    return hit ?? this.blocks[this.blocks.length - 1] ?? null;
  }
}
