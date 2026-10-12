import { convertFileSrc } from "../ipc/api";

import type { MdBlock } from "./pipeline";
import { attachUserScrollClear, isProgrammatic, markProgrammatic } from "../core/scroll-guard";

/**
 * Markdown 预览面板（M3）：
 * - 增量 patch：按顶层 block 复用 DOM（html 不变的 block 不动节点）
 * - 懒加载增强：KaTeX / Mermaid / Shiki 均动态 import，首次用到才加载
 * - 双向同步滚动：block 锚点对齐 + 来源标记（src/scroll-guard 合成 VS Code `scrollType`）
 */

const LAZY_THRESHOLD_LINES = 5000; // 大文档：关闭 Mermaid/Shiki 自动渲染

/**
 * 块边界探测点（B251 定案 **ANCHOR = 0**）。
 *
 * ⚠️ 这个常量**不是坐标平移** —— 它只用来在**块边界上**问「视口顶边压在哪一块」：
 * 二分要拿一个 offset 去和块顶边比，比的就是「视口顶 + 半像素」这个探测点。
 *
 * 旧口径是一对正负 8 像素的常数（落点写「块顶往回让 8」，取锚往前探 8）。这一对常数
 * 让「写下去的位置」和「读回来的坐标」各自带一个常量，比例里再吃一次 ⇒ 每走一次往返
 * 就攒一次误差（≈半行），预览与源码的「严格互逆」只成了一半。ANCHOR = 0 之后：
 *   · 落点就是块顶本身（`Math.max(0, top)`）；
 *   · 比例用真·`scrollTop`，不吃探测点；
 *   ⇒ 读写严格互逆，往返不攒误差。B245 那个「越切越靠顶」的病根（真实 `scrollTop` 带
 *   小数、旧口径减 8 加回来仍是「块顶 − 0.5」< 块顶 ⇒ 二分命中前一块）随着这一对常数
 *   一起没了，`indexOfBlockAtOffset` 里那半像素容差 `EPS` 也就不用兜了。
 */
const TOP_PROBE = 0.5;

/**
 * B265：底部留白（scroll past end）的 CSS 变量名。
 *
 * 与源码侧（`src/editor/editor.ts` 的 `--cm-bleed-bottom`）同一招：预览也改成**让最后一
 * 块能滚到容器顶**、下面留一屏空白。不这么做的话，预览的自然上限卡在「最后一块贴容器底」，
 * 而源码那一格卡在「最后一行贴容器底」—— 两侧底不是同一个位置，B260 那句「预览能到 966、
 * 源码只到 294」就是这么来的，滚到底时两侧游标被各自那把上限各裁一刀，怎么对齐都差一截。
 *
 * ⚠️ 同样走 CSS 变量、不写 inline `padding-bottom` 字面值：变量可以被
 *    `body.print-mode .md-preview { --md-bleed-bottom: 0px }` 归零（见 preview.css），
 *    硬写 inline 会把既有打印规则全盖掉、打印多出整整一屏空白。
 */
const BOTTOM_BLEED_VAR = "--md-bleed-bottom";

export interface SyncHost {
  /** 编辑器可视区顶行（1-based） */
  topVisibleLine(): number;
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
  /** 上一次真正写进 DOM 的底部留白值（-1 = 还没写过）；「值没变就不写」的记账，见 applyBottomBleed */
  private bleedPx = -1;
  /** 是否已有一次「布局落定后再补量」的 rAF 在飞（避免 setBlocks 每发都排队、叠成无限循环） */
  private bleedRafPending = false;
  /**
   * B272：ResizeObserver 那一路的跨帧重算在飞（同一轮通知合并成一发）。
   * ⚠️ 存在的唯一理由：**绝不在这帧的回调里动样式** —— 在同一次 delivery 里改被观察量，
   * 浏览器会再收一轮通知，攒够就抛 `ResizeObserver loop completed with undelivered
   * notifications`（真机：预览可见后每帧一条，被 `index.html` 的全局 error 监听堆成满屏
   * 红条）。排到 rAF 里写 ⇒ 新通知落到下一帧，属于正常迭代，不再抛错。
   */
  private bleedRoPending = false;
  /**
   * B272：连续「重算又变了」的次数 —— 熔断用。
   * 真机上存在**结构性抖动**：留白写进 `padding-bottom`，而 `px` 又拿 `clientHeight`
   * （padding-box，含这份留白）去算；容器高度由内容撑开时，这一笔会把「被观察量」改大
   * ⇒ 下一帧再算出另一个 px ⇒ 又写…… 叠加「滚动条出/没 ⇒ 折行 ⇒ 末块高变」就成了每帧
   * 一条的稳定环。值稳定即归零；连续 `BLEED_CHURN_LIMIT` 次仍变 ⇒ 本轮停手，
   * 由下一次 `setBlocks`（内容/块高真变化）重置。
   */
  private bleedChurn = 0;
  /** B272：连续重算多少次还在变就算失控（本轮停手）。3 次足以吃掉临界抖动。 */
  private static readonly BLEED_CHURN_LIMIT = 3;
  /** B272：`px` 的变化小于这个值就当没变（亚像素 / 滚动条临界那 1px 抖扭不值得重写一次）。 */
  private static readonly BLEED_EPSILON_PX = 1;
  /** 活动文档目录（相对路径图片解析基准） */
  private baseDir: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "md-preview";
    this.root.addEventListener("scroll", () => this.onPreviewScroll());
    // B170：给预览滚动容器挂「用户接管即清程序标记」的监听 —— 标记靠真实输入清除、
    // 不靠时间窗（见 src/scroll-guard.ts）。这样渲染扰动（setBlocks 归零再拉回、图片加载
    // 重排）导致的 actual≠expect 不会被误判成用户滚动反推编辑器。
    attachUserScrollClear(this.root);
    // 图片/iframe 的 load 不冒泡，用捕获阶段监听——布局变化后按 pending 行重定位
    this.root.addEventListener("load", () => this.applyPending(), true);
    // B265：底部留白跟着**容器尺寸**重算（分屏拖分隔条、窗口缩放、字号档都动它）。
    // jsdom 里没有 ResizeObserver ⇒ 判空，留白那帧由下面的 setBlocks 兜底算一次。
    if (typeof ResizeObserver !== "undefined") {
      // ⚠️ B272：回调**不直接算** —— 改走 `scheduleBleedFromRo()`（排到 rAF 跨帧写）。
      //    在这帧的回调里动 `padding-bottom` ⇒ 浏览器同帧再收一轮通知 ⇒ 抛
      //    `ResizeObserver loop completed with undelivered notifications`（真机每帧一条，
      //    被全局 error 监听堆成满屏红条）。跨帧写则新通知落到下一帧，是正常迭代。
      const ro = new ResizeObserver(() => this.scheduleBleedFromRo());
      // ⚠️ 必须观察 **border-box**：留白写在 `root` 自己的 `padding-bottom` 上，而
      //    `ResizeObserver` 默认看的是 **content-box** —— 那等于「我们这一笔把被观察量
      //    改小了」⇒ 回调再来一轮 ⇒ 自反馈成环（启动那帧布局还没稳，浏览器直接抛
      //    `ResizeObserver loop completed with undelivered notifications`）。
      //    border-box 不受 padding 影响 ⇒ 容器真变了才回调，绝不成环。
      ro.observe(this.root, { box: "border-box" });
    }
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
    // ⚠️ B265 修复：留白必须在**插回 DOM 之后**算 —— 块此刻才真正挂载到文档，
    //   `getBoundingClientRect()` 才能量出真实高度。插之前量的是 DocumentFragment 里
    //   的游离节点（高度恒 0）⇒ `lastH = 0` ⇒ `--md-bleed-bottom` 永远算成 0 ⇒ 预览
    //   底部永远到不了顶（与源码「最后一行贴容器顶」对不上）。插完立刻算，先把可滚上限
    //   放宽，下面 scrollTop 恢复才不会被旧上限裁小（与源码 restoreViewScroll 同型）。
    // B272：内容/块高真变了 ⇒ 熔断计数归零（上一次抖动判定的结论对新内容不成立）
    this.bleedChurn = 0;
    this.applyBottomBleed();
    // ⚠️ B269：同步那一发若量不出（预览离屏 / 刚建实例还没布局 ⇒ `clientHeight = 0`，或末块异步
    //   增强未落地 ⇒ 末块高 0），`applyBottomBleed` 内部那道闸会**一个字节都不写**，保留上一次的
    //   值。但「进入预览模式 / 恢复会话」那一帧往往是第一次量（还没有「上一次」），这一发跳过后
    //   就必须有下一发补上 —— 而 `.md-preview` 是**固定高的滚动容器**，它的 border-box 尺寸恒定，
    //   **内容 / 块高变化不触发 ResizeObserver**，所以光靠 RO 补不回来。这里显式排一帧 rAF，在布局
    //   落定之后按真实几何再量一次。`bleedPx` 闸门保证这一发幂等（值没变就不写），`bleedRafPending`
    //   保证每个 setBlocks 最多排一发、绝不成环（不写那发不会自触发新 rAF）。
    if (!this.bleedRafPending && (this.root.clientHeight <= 0 || this.bleedPx < 0)) {
      this.bleedRafPending = true;
      requestAnimationFrame(() => {
        this.bleedRafPending = false;
        this.applyBottomBleed();
      });
    }
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
   * 编辑器 → 预览：把编辑器可视区顶行对应的 block 滚到预览顶部附近（跟随）。
   *
   * B171：这一路是**跟随**（编辑器每滚一次就走一次），必须走「不留尾巴」那支 ——
   * 用 `syncToLine` 会记下 `pendingSyncLine`，之后任意一次图片 / 公式增强
   * （`applyPending`）或重渲染都会把预览按那个**早已过期**的行号再拽一次，
   * 表现为同步滚动时预览反复跳（用户反复报的抖动）。
   */
  syncFromEditor(): void {
    if (!this.host) return;
    this.syncToLineProgrammatic(this.host.topVisibleLine());
  }

  /**
   * 按行号直接滚动预览（大纲跳转 / 程序定位用）。
   * 与 syncFromEditor 的区别：不依赖编辑器可视区——预览态面板的编辑器
   * 是 display:none，其 scrollTop 不会变，必须显式按目标行定位。
   * 目标行记入 pendingSyncLine：异步增强/图片加载引发的布局变化会重新定位一次。
   */
  syncToLine(line: number): void {
    this.pendingSyncLine = line;
    this.applySyncToLine(line);
  }

  /**
   * B170：**程序发起**的按行定位 —— 凡「跟随」类定位都走它：跨面板同步滚动，
   * 以及编辑器滚动时让预览跟随的 `syncFromEditor`（B171 起也改走这里）。
   *
   * 与 `syncToLine`（大纲跳转：一次性目标，增强后还要按它重定位）的区别：
   *   · **不留 `pendingSyncLine` 尾巴**：跟随的目标行每帧都在变，记下来等于给
   *     每次重排留一个「把预览拽回某一行」的钩子（B160 抖动的根源之一）；
   *   · **标程序来源**：定位前 `markProgrammatic(this.root)`，回执 scroll 被监听见标记
   *     即吞（见 src/scroll-guard.ts，合成 VS Code 的 `scrollType`）。标记靠用户接管
   *     滚动的真实输入清除，**不靠时间窗** —— 渲染扰动（setBlocks 归零再拉回、图片加载
   *     重排）把 actual 拖离 expect 也不会被误判成用户滚动反推编辑器，闭环拉锯根除。
   */
  syncToLineProgrammatic(line: number): number | null {
    this.pendingSyncLine = null;
    // 返回**实际落点**（`null` = 没落地）；内部 `markProgrammatic(this.root)` 覆盖本次回执。
    return this.applySyncToLine(line);
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
   * 位置已由调用方按**像素**钉死，抹掉待重定位的行号（B146）。
   *
   * `applySyncToLine` 只写 `pendingSyncLine`、不消费它，而 `applyPending` 会被任意
   * 一次图片 / 公式增强的 `load` 唤醒 —— 留着旧行号，预览就会从刚钉好的落点被拽回
   * 那一行。切标签后位置是**按像素**还原的（不是按行），这一行必须清掉。
   */
  clearPendingSync(): void {
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
   * B265（本单修复）：按当前几何重算预览的**底部留白** —— 量 = `clientHeight − 最后一行的高`。
   *
   * 推导（与 `--cm-bleed-bottom` 同源）：加完 padding 后
   *     maxScroll = contentH + padding − clientH
   * 想让「最后一行顶」正好贴在容器顶（`maxScroll === 最后一行.top`）
   *     ⇒ padding === clientHeight − 最后一行高。
   *
   * ⚠️ 与编辑器侧 `sourceBottomBleedPx` **同一个公式、同一个粒度（末行）**：编辑器按
   *    `clientH − 末行高` 算；预览此前按 `clientH − 末块高` 算 —— 末块若占多行（段落 /
   *    代码块 / 列表……），最后一行就永远滚不到容器顶（用户报「只能滚动到最后一块」）。
   *    本修复把预览也改成按**最后一行**算，两侧底对齐、最后一行都能贴顶。
   * ⚠️ 只有**最后一行**才配这个量：前面那些行本来就能滚到顶，给它们多留一屏只会让视图
   *    一进预览就空一大截（「预览一打开先白一屏」）。
   * ⚠️ 量不出（离屏 `clientHeight = 0`，或空文档没有块）一律写 **0** —— 把「看不见」当
   *    成「可滚」会把这一格钉死在开头，正是 B257 那份教训。
   */
  private applyBottomBleed(): void {
    const clientH = this.root.clientHeight;
    // ⚠️ B269：离屏 / 还没布局 ⇒ `clientHeight = 0` ⇒ **一个字节都不写**，保留上一次量出来的
    //   值（与源码侧 `--cm-bleed-bottom` 那道闸同口径：写「瞬态的 0」比不写更糟 —— 真机要等布局
    //   落定再由 `setBlocks` 里那发 rAF 补，补之前这一格的可滚上限是错误的）。旧写法这里直接算成
    //   0 写下去：预览若先以隐藏态被量过一次（clientHeight=0 ⇒ 写 0），之后进入预览模式那一发只要
    //   也踩到 0，就把上一次对的值抹掉、再也翻不回正数 —— 正是用户报的「预览模式最后一个块滚不到顶」。
    if (!(clientH > 0)) return;
    const last = this.blocks[this.blocks.length - 1];
    if (!last) return;
    const lastH = this.lastLineHeightOf(last.el);
    // 末行高还没量出（刚 replaceChildren、异步增强未落地）⇒ 不写，等下一帧再量。
    if (!(lastH > 0)) return;
    const px = Math.max(0, clientH - lastH);
    // ⚠️⚠️ **值没变就一个字节都不写**：在 `ResizeObserver` 回调里动样式，浏览器会在同一帧
    //    里再收一轮通知，攒够就抛 `ResizeObserver loop completed with undelivered
    //    notifications`（B265 首版启动即弹红条 —— `index.html` 的全局 error 监听把它当成
    //    启动失败渲染出来了）。`px` 只由「容器高 + 末行高」决定，值不变 ⇒ 这一帧没有真
    //    变化 ⇒ 不写，循环到此为止（「不写」本身就是收敛保证）。
    //    ⚠️ B272：**带 1px 容差** —— `clientHeight` 里含我们自己这份 `padding-bottom`，
    //    容器高度由内容撑开时它随这一笔变化；叠上「滚动条出/没 ⇒ 折行 ⇒ 末行高 ±1」就是
    //    每帧都"变"一点的稳定环（真机每帧一条 RO loop）。1px 的差没有任何观感差别，
    //    ≤1px 一律当没变 ⇒ 环在此收敛。
    if (Math.abs(px - this.bleedPx) <= PreviewPane.BLEED_EPSILON_PX) return;
    this.bleedPx = px;
    this.root.style.setProperty(BOTTOM_BLEED_VAR, `${px}px`);
  }

  /**
   * 最后一块里「最后一行」的高（与编辑器 `sourceBottomBleedPx` 的末行高同口径）。
   *
   * 标题 / 段落 / 列表项 / 代码块……每一**视觉行**都是一个 line-box，高 = 该块的计算行高；
   * 量得出就用 `getComputedStyle` 解析出的 px（真实浏览器恒可得、且天然 = 一个视觉行高，
   * 含折行：末行就是最后那个 line-box，高 = line-height）。
   * jsdom 解析不出行高（返回空串 / `"normal"`）⇒ 退回「块高 ÷ 本块占的源行数」——
   * 测试桩里每块高 `BLOCK`、每块 3 源行 ⇒ 单源行高 = `ROW`，与编辑器末行高同口径；
   * 真实浏览器不会走到这一支。末块高量不出（异步增强未落地）⇒ 返回 0，由调用方吞掉。
   */
  private lastLineHeightOf(el: HTMLElement): number {
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    const lh = cs ? parseFloat(cs.lineHeight) : NaN;
    if (Number.isFinite(lh) && lh > 0) return lh;
    const lines = Math.max(1, Number(el.dataset.lineEnd) - Number(el.dataset.lineStart) + 1);
    const h = el.getBoundingClientRect().height || el.offsetHeight;
    return h > 0 ? h / lines : 0;
  }

  /**
   * B272：ResizeObserver 那一路的**跨帧重算**（含熔断）。
   *
   * 两条纪律：
   *   ① **跨帧** —— 回调当帧不写样式，写排到 rAF，避免同帧连续通知（RO loop 错误的成因）；
   *   ② **熔断** —— 连续 `BLEED_CHURN_LIMIT` 次重算后值还在变 ⇒ 判为结构性抖动（留白改变
   *      被观察量 / 滚动条临界），本轮停手，不再排队。值稳定一次即归零；`setBlocks`
   *      （内容或块高真变化）也会归零 ⇒ 后续真实变化照常生效。
   *      ⚠️ 停手≠算错：留白停在最后一次量出的值上，观感与「多抖 1px」无差别，换来的是
   *      不再每帧抛错、不再刷满屏红条、不再每帧重排。
   */
  private scheduleBleedFromRo(): void {
    if (this.bleedRoPending) return; // 同一轮通知合并成一发
    if (this.bleedChurn >= PreviewPane.BLEED_CHURN_LIMIT) return; // 熔断：本轮停手
    this.bleedRoPending = true;
    requestAnimationFrame(() => {
      this.bleedRoPending = false;
      const before = this.bleedPx;
      this.applyBottomBleed();
      this.bleedChurn = this.bleedPx === before ? 0 : this.bleedChurn + 1;
    });
  }

  /**
   * 预览此刻停在哪一行（md 源码行号），定不出来返回 `null`（B148）。
   *
   * 纯预览态切回源码时用得上：编辑器那一路位置在 `display:none` 期间被浏览器清零
   * （CM6 的 `inputState.lastScrollTop` 也会被那发 0 值 scroll 改写），**无从恢复**；
   * 唯一说得通的落点是「用户正在看的那一行」。取法与 `onPreviewScroll` 完全一样
   * （同一个 `blockAtOffset`、同一个 `TOP_PROBE` 探测点），免得两边对「顶行」的定义分叉。
   */
  /**
   * 预览此刻停在哪一行 —— **带行内比例的小数**（B174）。
   *
   * 同步滚动的坐标若是整数：源在一行内滚动时行号不变 ⇒ 目标一动不动，跨行瞬间跳一格，
   * 连起来就是「卡一下、跳一下」（用户报：跟随同步时预览跳动，而 TOC 一次性大跳反而没
   * 问题 —— 一次大跳人眼接受，持续小跳很扎眼）。
   *
   * ⚠️ 映射必须与 `applySyncToLine` **互逆**：落点就是块顶（`Math.max(0, top)`），这个比例
   * 就按「到下一块顶边」用真·`scrollTop` 算（探测点只拿去问「压在哪一块」，不进比例），
   * 否则「读出来的行」与「按行摆下去的位置」对不上，跟随会自带一个来回偏的量。
   */
  topVisibleLine(): number | null {
    if (!this.host) return null;
    const idx = this.indexOfBlockAtOffset(this.root.scrollTop + TOP_PROBE);
    if (idx < 0) return null;
    const el = this.blocks[idx].el;
    const start = Number(el.dataset.lineStart);
    if (!Number.isFinite(start) || start <= 0) return null;
    const next = this.blocks[idx + 1];
    // ⚠️ B265：走到这里说明**已经滚过最后一块的顶**（`indexOfBlockAtOffset` 只挑「顶边
    //    不超过探测点」的最后一块，末块被选中 ⇔ 它顶到了容器顶）⇒ 该交**块末行**而不是
    //    块起始行。源码那一格到底时交的是 `doc.lines`（末行贴容器顶 ⇒ 行号 = 文档末行、
    //    行内比例 0），两边若一个给末块尾、一个给末行头，就差一个**末块的高度**（末块占
    //    3 行就差 2 行）⇒ 切标签 / 切模式之后两格各回各的「底」。
    //    落点仍走块顶（`applySyncToLine`）：v = 末块末行 ⇒ `blockAtLine` 命中末块 ⇒ 沉到
    //    块顶 ⇒ 读回来还是末块末行，往返不攒误差。
    if (!next) {
      const end = Number(el.dataset.lineEnd);
      return Number.isFinite(end) && end > 0 ? end : start;
    }
    const top = this.blockTop(el);
    const nextTop = this.blockTop(next.el);
    const range = Number(next.el.dataset.lineStart) - start;
    if (!(nextTop > top) || !(range > 0)) return start;
    const ratio = Math.min(1, Math.max(0, (this.root.scrollTop - top) / (nextTop - top)));
    return start + ratio * range;
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

  private onPreviewScroll(): void {
    // B170：程序摆位的回执（跨面板同步钉位、会话恢复、setBlocks 恢复、异步二次定位）
    // 一律由 scroll-guard 标记认领、直接吞（不写快照、不推兄弟）。标记靠用户接管滚动的
    // 真实输入清除，**不比位置、不赌时序、无时间窗** —— 渲染扰动（setBlocks 归零再拉回、
    // 图片加载重排位移）把 actual 拖离 expect 也不会被误判成用户滚动反推编辑器，闭环拉锯根除。
    if (isProgrammatic(this.root)) return;
    if (!this.host) return;
    // 用户手动滚动预览：取消待重定位（避免异步重排后又把视图拉回）
    this.pendingSyncLine = null;
    const top = this.root.scrollTop;
    const target = this.blockAtOffset(top + TOP_PROBE);
    if (!target) return;
    this.host.scrollToLine(Number(target.el.dataset.lineStart));
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

  /**
   * 命中「最后一个顶边不超过 offset 的 block」。
   *
   * B172：跟随路径（用户滚预览、预览当源做同步）**每个 scroll 事件**都走这里。block 的
   * 顶边在文档里单调递增，所以可以二分 —— 线性版要从头摸到命中位置，滚到文档中部就是
   * 几百个节点、上千次 `getBoundingClientRect`；二分只需 log₂N 次，且基准 rect 提到循环
   * 外只算一次。语义与线性版一致（都取最后一个 ≤ offset 的，一个都不满足则退回首个）。
   */
  private indexOfBlockAtOffset(offset: number): number {
    const n = this.blocks.length;
    if (n === 0) return -1;
    const base = this.root.getBoundingClientRect().top;
    const scroll = this.root.scrollTop;
    const topAt = (i: number): number =>
      this.blocks[i].el.getBoundingClientRect().top - base + scroll;
    // ⚠️ ANCHOR = 0（B251）：落点就是块顶本身（见 `TOP_PROBE` 的说明），所以「写下去的位
    // 置」与「读回来的坐标」不掺任何常数，下面这条比较在带小数的真实 `scrollTop` 上也成立。
    // 旧口径落点比块顶少 8、取锚又加 8 还原，等宽几何里正好抵消、看不出问题；真实浏览器
    // `scrollTop` 常带小数，减 8 加回来仍是「块顶 − 0.5」< 块顶 ⇒ 二分命中**前一个块** ⇒
    // 每次「预览→源码」都退回上一块，越切越靠顶（B245 那个「越切越靠顶」symptom）。
    // 当时只能拿半像素容差 `EPS` 兜；现在那一对常数撤了，容差跟着撤，判据回到纯比较。
    let lo = 0;
    let hi = n - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (topAt(mid) <= offset) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit >= 0 ? hit : 0;
  }

  private blockAtOffset(offset: number): BlockNode | null {
    const i = this.indexOfBlockAtOffset(offset);
    return i < 0 ? null : (this.blocks[i] ?? null);
  }
}
