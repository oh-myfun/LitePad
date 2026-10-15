import { convertFileSrc } from "../ipc/api";

import type { MdBlock } from "./pipeline";
import { attachUserScrollClear, markProgrammatic } from "../core/scroll-guard";

/**
 * Markdown 预览面板（M3）：
 * - 增量 patch：按顶层 block 复用 DOM（html 不变的 block 不动节点）
 * - 懒加载增强：KaTeX / Mermaid / Shiki 均动态 import，首次用到才加载
 * - 双向同步滚动：block 锚点对齐 + 来源标记（src/scroll-guard 合成 VS Code `scrollType`）
 */

const LAZY_THRESHOLD_LINES = 5000; // 大文档：关闭 Mermaid/Shiki 自动渲染

export interface SyncHost {
  /** 编辑器滚动到指定行（行首对齐） */
  scrollToLine(line: number): void;
  /** 文档总行数（大文档降级判断用） */
  lineCount(): number;
}

interface BlockNode {
  html: string;
  el: HTMLElement;
}

export class PreviewPane {
  readonly root: HTMLElement;
  private blocks: BlockNode[] = [];
  private host: SyncHost | null = null;
  /** 程序定位（大纲跳转/转到行）的目标行：异步增强或图片加载重排后据此重定位 */
  private pendingSyncLine: number | null = null;
  private mermaidSeq = 0;
  /** 活动文档目录（相对路径图片解析基准） */
  private baseDir: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "md-preview";
    // B170：给预览滚动容器挂「用户接管即清程序标记」的监听 —— 标记靠真实输入清除、
    // 不靠时间窗（见 src/scroll-guard.ts）。这样渲染扰动（setBlocks 归零再拉回、图片加载
    // 重排）导致的 actual≠expect 不会被误判成用户滚动反推编辑器。
    attachUserScrollClear(this.root);
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
      // 点击 block → 编辑器定位到对应行（不抢焦点，打字不被打断）
      const block = target.closest<HTMLElement>(".md-block");
      if (block?.dataset.lineStart) {
        const line = Number(block.dataset.lineStart);
        if (line > 0) this.host?.scrollToLine(line);
      }
    });
  }

  setHost(host: SyncHost): void {
    this.host = host;
  }

  setBaseDir(dir: string | null): void {
    this.baseDir = dir;
  }

  // ------------------------------------------------ 渲染

  /** 增量 patch：逐 index 比对 html，相同复用节点。 */
  setBlocks(list: MdBlock[], options: { enhanced?: boolean } = {}): void {
    // 查找标记先拆干净：被替换的 block 会带走标记，而复用的 block 会把
    // 旧标记留在节点里，导致计数与 DOM 脱节（重放由 main 层在 patch 后进行）
    if (this.findMarks.length > 0) {
      this.clearFindMarks();
      this.findActive = -1;
    }
    const frag = document.createDocumentFragment();
    const next: BlockNode[] = [];
    let contentChanged = list.length !== this.blocks.length;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const old = this.blocks[i];
      if (old && old.html === b.html) {
        next.push(old);
        frag.appendChild(old.el);
      } else {
        contentChanged = true;
        const el = document.createElement("div");
        el.className = "md-block";
        el.dataset.lineStart = String(b.lineStart);
        el.dataset.lineEnd = String(b.lineEnd);
        el.innerHTML = b.html;
        next.push({ html: b.html, el });
        frag.appendChild(el);
      }
    }
    // 未复用的旧节点从 DOM 摘除（防止事件/观察泄漏）
    for (const old of this.blocks) {
      if (!next.includes(old)) old.el.remove();
    }
    // 内容变了，旧的待定位行号已失去意义（行号基准随文本漂移）→ 作废，
    // 否则下一次重渲染会把视图拽回很久以前跳转过的那一行。
    if (contentChanged) this.pendingSyncLine = null;
    // replaceChildren 会把 scrollTop 清零：先记住原位置，插完立刻恢复。
    // 少了这一步，任何一次重渲染（编辑、切标签）都会让预览弹回文档开头。
    const prevScroll = this.root.scrollTop;
    this.blocks = next;
    this.root.replaceChildren(frag);
    if (this.pendingSyncLine !== null) {
      this.applySyncToLine(this.pendingSyncLine);
    } else {
      this.root.scrollTop = prevScroll;
      // B170：这次恢复是程序摆位（replaceChildren 把 scrollTop 清零后我们拉回），回执由
      // 预览 scroll 监听经 scroll-guard 标记吞掉，不当成用户滚动。
      markProgrammatic(this.root);
    }
    if (options.enhanced !== false) void this.enhance();
    // 重排后布局可能变化（图片/公式占位），按 pending 行再定位一次
    this.applyPending();
  }

  private noticeEl: HTMLElement | null = null;

  /**
   * 在预览区顶部显示一条占位说明（M4 大文件：自动预览被停用时告诉用户原因）。
   * 传 null 移除。它不是 block，不参与 patch、行号同步与查找高亮。
   *
   * 注意：`setBlocks()` 会 `replaceChildren` 整块重建，所以调用顺序必须是
   * 先 setBlocks 再 setNotice，否则提示会被下一次渲染抹掉。
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
    // jsdom 未实现 scrollIntoView；WebView2 正常。滚动 .md-preview 会触发
    // 编辑器↔预览同步（回环锁在 onPreviewScroll 内处理）。
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

  /** 包装 enhance：无论成功/中断都要按 pending 行重定位一次（公式/Mermaid 会改变高度）。 */
  private async enhance(): Promise<void> {
    try {
      await this.enhanceInner();
    } finally {
      this.applyPending();
    }
  }

  private async enhanceInner(): Promise<void> {
    const seq = ++this.mermaidSeq;
    const root = this.root;

    // 相对路径图片 → asset 协议地址（预览时才可显示本地图片）
    if (this.baseDir) {
      for (const img of root.querySelectorAll("img[src]")) {
        const src = img.getAttribute("src") ?? "";
        if (!src || /^(https?:|data:|#|\/)/i.test(src)) continue;
        const abs = this.baseDir.replace(/[\\/]+$/, "") + "\\" + src;
        img.setAttribute("src", convertFileSrc(abs));
      }
    }

    // KaTeX（有占位才 import）
    const maths = root.querySelectorAll<HTMLElement>(".math-inline-src, .math-display-src");
    if (maths.length > 0) {
      try {
        const katex = (await import("katex")).default;
        if (seq !== this.mermaidSeq) return;
        for (const el of maths) {
          if (!el.isConnected) continue;
          const tex = el.textContent ?? "";
          const display = el.classList.contains("math-display-src");
          const span = document.createElement(display ? "div" : "span");
          span.className = display ? "math-display" : "math-inline";
          try {
            span.innerHTML = katex.renderToString(tex, {
              displayMode: display,
              throwOnError: false,
              output: "html",
            });
          } catch {
            span.textContent = tex;
          }
          el.replaceWith(span);
        }
      } catch {
        // katex 加载失败保持占位文本
      }
    }

    // Shiki 代码高亮（大文档跳过）
    if (!this.bigDoc()) {
      const codes = root.querySelectorAll<HTMLElement>("pre.md-code[data-lang]");
      const needHighlight = [...codes].filter(
        (el) => el.dataset.highlighted !== "1" && el.dataset.lang && el.dataset.lang !== "mermaid",
      );
      if (needHighlight.length > 0) {
        try {
          const { codeToHtml } = await import("shiki");
          if (seq !== this.mermaidSeq) return;
          for (const el of needHighlight) {
            const lang = el.dataset.lang!;
            const code = el.querySelector("code")?.textContent ?? "";
            try {
              const html = await codeToHtml(code, {
                lang,
                themes: { light: "github-light", dark: "github-dark" },
              });
              if (!el.isConnected) continue;
              const holder = document.createElement("div");
              holder.innerHTML = html;
              const pre = holder.firstElementChild;
              if (pre) {
                el.replaceWith(pre);
                (pre as HTMLElement).dataset.highlighted = "1";
              }
            } catch {
              el.dataset.highlighted = "1"; // 不支持的语言保持纯文本
            }
          }
        } catch {
          // shiki 加载失败保持纯文本
        }
      }
    }

    // Mermaid（大文档不自动渲染，保留源码块 + 提示）
    const mermaids = root.querySelectorAll<HTMLElement>("pre.mermaid-src");
    if (mermaids.length > 0 && !this.bigDoc()) {
      try {
        const mermaid = (await import("mermaid")).default;
        if (seq !== this.mermaidSeq) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
        });
        for (const el of mermaids) {
          const code = el.textContent ?? "";
          const id = `mmd-${seq}-${[...mermaids].indexOf(el)}`;
          try {
            const { svg } = await mermaid.render(id, code);
            if (!el.isConnected || seq !== this.mermaidSeq) return;
            const div = document.createElement("div");
            div.className = "md-mermaid";
            div.innerHTML = svg;
            el.replaceWith(div);
          } catch {
            el.classList.add("mermaid-error");
          }
        }
      } catch {
        // mermaid 加载失败保持源码块
      }
    }
  }

  // ------------------------------------------------ 同步滚动

  /**
   * 按行号直接滚动预览（大纲跳转 / 程序定位用）。
   * 不依赖编辑器可视区 —— 预览态面板的编辑器是 display:none，其 scrollTop 不会变，
   * 必须显式按目标行定位。目标行记入 pendingSyncLine：异步增强/图片加载引发的
   * 布局变化会重新定位一次。
   */
  syncToLine(line: number): void {
    this.pendingSyncLine = line;
    this.applySyncToLine(line);
  }

  /**
   * 直接摆到指定像素位置（B129：会话恢复）。
   *
   * 与 `syncToLine` 的区别是**不认行、只认位置**：恢复会话时编辑器是 `display:none`，
   * 没法像切视图那样按「编辑器顶行」反推预览该停在哪。本次摆位 `markProgrammatic`——
   * 否则紧随其后的 scroll 事件会被当成用户手动滚动，反过来去动编辑器（B170）。
   */
  setScrollTop(px: number): void {
    const nextTop = Math.max(0, px);
    this.root.scrollTop = nextTop;
    markProgrammatic(this.root);
    // 位置已定，别再被异步重排（图片/公式增强）拽回行定位
    this.pendingSyncLine = null;
  }

  /**
   * 按行定位预览，**返回实际落点**（`null` = 没落地）。
   *
   * ⚠️ 返回值不是摆设：`blockAtLine` 找不到目标 block 时（预览还没渲染 / 行号越界）这里
   * 是直接 return、容器一动没动的。调用方若不看返回值、照例把容器里的值当落点记进快照，
   * 「定位没做」就会被记成「它停在顶部」—— 下一次切过去天然回顶（B134 那个病再犯一次：
   * 没钉住 ≠ 位置是 0，见 `pinScrollTop` 的 `stuck` 判定）。
   */
  private applySyncToLine(line: number): number | null {
    const target = this.blockAtLine(line);
    if (!target) return null;
    const idx = this.blocks.indexOf(target);
    const next = this.blocks[idx + 1];
    const el = target.el;
    // B288 三轮：块几何不可用（容器未铺开 / display:none / 刚挂载尚未 layout）时，块与
    //   容器的 rect 全为 0，`blockTop` 算出的 `top` 必为 0——照常返回 0 会被调用方当成
    //   「停在顶部」：`renderMarkdownFor` 的 B279 补落 `recordScroll(0)` 把槽里真值抹掉、
    //   预览视觉被钉回开头（用户复现「拖标签分屏预览置 0」的现场）。这里直接返回 null，
    //   让所有调用方走兜底：`restorePreviewScroll` 的 `pinScrollTop` 按槽里真值自愈、B279
    //   补落的 `if (landed !== null)` 跳过不写。jsdom 测试桩（preview-sync / sync-drag-split）
    //   给块 / 容器非 0 几何，不受影响；判定要求「块 rect 全 0 且容器高 0」二者同时成立，
    //   才认作未铺开——已铺开的容器（高 > 0）即便某块恰好贴顶（rect.top=0）也不会误判。
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
      //    （lineStart 顶对齐）。但「滚到底 / 同步到文档末行」的语义应是「最后一行顶对齐到
      //    容器顶」—— 与编辑器 `sourceTopOfV` 末行贴顶、以及本单底部留白（末行高）同口径：
      //    末块占多行时，只落块顶 ⇒ 最后一行永远差一截到不了顶（用户报「只能滚动到最后一块」
      //    的同源问题在同步 / 切标签恢复路径上同样存在）。按块内源行均分块高，把请求的源行
      //    顶对齐到容器顶（与中段块 `into/range` 插值的落点语义一致）。`topVisibleLine` 对末块
      //    仍交 `lineEnd`（滚过末块顶即交末行），往返闭合不变。
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
    // B170：程序摆位，先标来源再赋值，回执由 scroll 监听经 scroll-guard 吞掉。
    markProgrammatic(this.root);
    this.root.scrollTop = nextTop;
    return nextTop;
  }

  /** block 相对预览内容区的偏移（不受 offsetParent 与当前滚动影响）。 */
  private blockTop(el: HTMLElement): number {
    const base = this.root.getBoundingClientRect();
    return el.getBoundingClientRect().top - base.top + this.root.scrollTop;
  }

  /**
   * 布局稳定后按 pending 行再定位一次（异步增强 / 图片加载后调用）。
   *
   * B170：这一发是**异步补刀**（图片 / 公式增强后布局变了，再定位一次）。它走
   * `applySyncToLine`，内部 `markProgrammatic` 已把来源标好，回执由滚动监听直接吞掉
   * —— 不再需要 `suppressScrollWrite` 那种「先压位再解位」的时序补丁（异步补刀落点
   * 和上一次不同，旧方案里它会被当成用户滚动写进快照，正是 960/952 抖动的根）。
   */
  private applyPending(): void {
    if (this.pendingSyncLine === null) return;
    const line = this.pendingSyncLine;
    requestAnimationFrame(() => {
      if (this.pendingSyncLine !== line) return;
      this.applySyncToLine(line);
    });
  }

  private blockAtLine(line: number): BlockNode | null {
    // ⚠️ `line` 可能带行内比例小数（B174/B175：同步跟随用 `topVisibleLineFrac` 的
    //   小数坐标，让预览跟随连续而非阶梯跳）。旧写法 `line >= s && line <= e` 兜不住小数：
    //   12.3 落在 `[12,12]` 块里却被 `12.3 <= 12` 判否、又够不到 `[13,13]` ⇒ 落到「最后
    //   一个块」⇒ 预览被钉到最底部（用户：滚源码预览直接到底）。空行造成的区间缝隙
    //   （段落 [12,14] 与 [16,18] 之间缺 15）也会把小数行号挤到缝里、同样误坠底部。
    //   改按「行号有序」线性找：取 `lineStart <= line` 的最后一块；若该块已含 line 直接命中，
    //   缝隙 / 单块小数则稳定落到缝隙前那块，不再误坠底部。
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
