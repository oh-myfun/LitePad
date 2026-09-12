import { convertFileSrc } from "@tauri-apps/api/core";

import type { MdBlock } from "./pipeline";

/**
 * Markdown 预览面板（M3）：
 * - 增量 patch：按顶层 block 复用 DOM（html 不变的 block 不动节点）
 * - 懒加载增强：KaTeX / Mermaid / Shiki 均动态 import，首次用到才加载
 * - 双向同步滚动：block 锚点对齐 + 回环锁
 */

const LAZY_THRESHOLD_LINES = 5000; // 大文档：关闭 Mermaid/Shiki 自动渲染

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
  /** 同步回环锁：editor→preview 滚动期间丢弃 preview 的 scroll 事件，反之亦然 */
  private syncLock: "editor" | "preview" | null = null;
  private lockTimer: number | null = null;
  /** 程序定位（大纲跳转/转到行）的目标行：异步增强或图片加载重排后据此重定位 */
  private pendingSyncLine: number | null = null;
  /** 程序设定的滚动位置：scroll 事件是异步的，同步锁过期后仍要能识别出自家滚动
   *  （重渲染把 scrollTop 清零再改回也会冒出一次 scroll 事件） */
  private programmaticTop: number | null = null;
  private mermaidSeq = 0;
  /** 活动文档目录（相对路径图片解析基准） */
  private baseDir: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "md-preview";
    this.root.addEventListener("scroll", () => this.onPreviewScroll());
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

  /** 编辑器→预览方向正在同步（预览→编辑器的程序滚动引发的事件应忽略）。 */
  isSyncing(): boolean {
    return this.syncLock === "preview";
  }

  // ------------------------------------------------ 渲染

  /** 增量 patch：逐 index 比对 html，相同复用节点。 */
  setBlocks(list: MdBlock[], options: { enhanced?: boolean } = {}): void {
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
      this.programmaticTop = prevScroll;
    }
    if (options.enhanced !== false) void this.enhance();
    // 重排后布局可能变化（图片/公式占位），按 pending 行再定位一次
    this.applyPending();
  }

  clear(): void {
    this.blocks = [];
    this.root.replaceChildren();
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

  /** 编辑器 → 预览：把编辑器可视区顶行对应的 block 滚到预览顶部附近。 */
  syncFromEditor(): void {
    if (!this.host) return;
    this.syncToLine(this.host.topVisibleLine());
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

  private applySyncToLine(line: number): void {
    const target = this.blockAtLine(line);
    if (!target) return;
    this.acquireLock("editor");
    const idx = this.blocks.indexOf(target);
    const next = this.blocks[idx + 1];
    const el = target.el;
    // 关键：offsetTop 的基准是最近的**定位祖先**（外层 .layout-panel，含标签栏），
    // 拿它当预览内容偏移会带上几十像素常量误差 → 改用相对预览容器的 rect 差值。
    let top = this.blockTop(el);
    if (next) {
      const range =
        Math.max(1, (Number(next.el.dataset.lineStart) - Number(el.dataset.lineStart)) || 1);
      const into = Math.min(range, Math.max(0, line - Number(el.dataset.lineStart)));
      top += ((this.blockTop(next.el) - top) * into) / range;
    }
    const nextTop = Math.max(0, top - 8);
    this.root.scrollTop = nextTop;
    this.programmaticTop = nextTop;
  }

  /** block 相对预览内容区的偏移（不受 offsetParent 与当前滚动影响）。 */
  private blockTop(el: HTMLElement): number {
    const base = this.root.getBoundingClientRect();
    return el.getBoundingClientRect().top - base.top + this.root.scrollTop;
  }

  /** 布局稳定后按 pending 行再定位一次（异步增强 / 图片加载后调用）。 */
  private applyPending(): void {
    if (this.pendingSyncLine === null) return;
    const line = this.pendingSyncLine;
    requestAnimationFrame(() => {
      if (this.pendingSyncLine === line) this.applySyncToLine(line);
    });
  }

  private onPreviewScroll(): void {
    if (this.syncLock === "editor") return;
    // 自家程序滚动的回执：锁（120ms）可能刚好在重渲染清空 scrollTop 后过期，
    // 只靠锁会把这次事件误判成用户手动滚动 → 清掉 pendingSyncLine，跳转落点丢失。
    if (
      this.programmaticTop !== null &&
      Math.abs(this.root.scrollTop - this.programmaticTop) < 1
    ) {
      return;
    }
    this.programmaticTop = null;
    if (!this.host) return;
    // 用户手动滚动预览：取消待重定位（避免异步重排后又把视图拉回）
    this.pendingSyncLine = null;
    this.acquireLock("preview");
    const top = this.root.scrollTop;
    const target = this.blockAtOffset(top + 8);
    if (!target) return;
    this.host.scrollToLine(Number(target.el.dataset.lineStart));
  }

  private blockAtLine(line: number): BlockNode | null {
    for (const b of this.blocks) {
      const s = Number(b.el.dataset.lineStart);
      const e = Number(b.el.dataset.lineEnd);
      if (line >= s && line <= e) return b;
    }
    return this.blocks[this.blocks.length - 1] ?? null;
  }

  private blockAtOffset(offset: number): BlockNode | null {
    let result: BlockNode | null = null;
    for (const b of this.blocks) {
      if (this.blockTop(b.el) <= offset) result = b;
      else break;
    }
    return result ?? this.blocks[0] ?? null;
  }

  private acquireLock(who: "editor" | "preview"): void {
    this.syncLock = who;
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => {
      this.syncLock = null;
      this.lockTimer = null;
      // 锁过期后不再认领旧的程序滚动回执，避免误吞之后的用户滚动
      this.programmaticTop = null;
    }, 120) as unknown as number;
  }
}
