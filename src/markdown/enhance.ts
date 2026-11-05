import { convertFileSrc } from "../ipc/api";
import { attachDiagramViewport } from "./diagramViewport";
import { diagramClass, diagramKindOf, renderDiagram } from "./diagrams";
import { highlightCodeHtml } from "./highlight";

/**
 * Markdown 渲染结果的**增强层**（B352-2 从 `PreviewPane` 抽出来）。
 *
 * 单独成文件是为了别把四件事（相对路径图片、KaTeX、Shiki、图种）的懒加载守卫
 * 抄进每个渲染面 —— 多一处渲染面（现在与将来）都调这一个出口，
 * `opts.bigDoc` 由调用方按自己的档位给。
 *
 * 懒加载：各库都在**真的用到**时才 import（`.math-*-src` / `pre.md-code[data-lang]` /
 * `pre.diagram-src` 任一存在），首屏不为它们付体积。
 */

/**
 * 「过期」判据的域：**每个 root 自己一发**，不是全窗口一张表。
 *
 * ⚠️ B352-11 评审 C2 推翻台账 Task 2 那条裁定（当时把两个计数器当成了同一件事）：
 * 图种的 render id 计数器必须全局（撞了会删掉别格刚插进 DOM 的 SVG，见 `diagrams.ts`），
 * 而 seq 的语义是「**同一个容器**上后发的一发作废先发的那发」。提到模块级之后：IR 一次画 N 块、
 * 每块各发一发 ⇒ 后一块把前 N-1 块一起取消，而那些节点又被 `eq()` 复用、再也轮不到重跑
 * ⇒ 代码块永远纯文本、公式停在 `$$…$$`；主预览格 + 侧边预览格同时开时也是同一形互砍
 * （搬家之前它是每格一个的 `private mermaidSeq`，跨格互不影响）。
 */
const latestSeqByRoot = new WeakMap<HTMLElement, number>();
let seqCounter = 0;

/** 在 `root` 上开始一次增强。后续每次 `nextEnhanceSeq(root)` 都会作废这个 root 上在途的那一发。 */
export function nextEnhanceSeq(root: HTMLElement): number {
  const seq = ++seqCounter;
  latestSeqByRoot.set(root, seq);
  return seq;
}

/** 这一个 root 上不是最新的一发 ⇒ 每个 await 之后都要复检，过期就立刻退出。 */
export function isEnhanceStale(root: HTMLElement, seq: number): boolean {
  return latestSeqByRoot.get(root) !== seq;
}

export interface EnhanceOptions {
  /** 大文档档位：关掉 Shiki / Mermaid 的自动渲染（公式仍然算，它便宜） */
  bigDoc: boolean;
  /** 活动文档所在目录，用来把相对路径图片换成 asset 协议地址；`null` = 未命名文档 */
  baseDir?: string | null;
  /** PlantUML 在线服务器（设置里那一格）。空 / 缺省 = 用 `diagrams.ts` 的默认那台。 */
  plantumlServer?: string;
}

/** 就地把 `root` 子树里的渲染结果增强一遍。调用方自己负责 await 与错误后的重排。 */
export async function enhanceMarkdown(
  root: HTMLElement,
  seq: number,
  opts: EnhanceOptions,
): Promise<void> {
  // 相对路径图片 → asset 协议地址（预览时才可显示本地图片）
  if (opts.baseDir) {
    for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
      // ⚠️ 原始相对值记在 `data-rel-src` 上：岛级增量会让两份文档共享的头几段成批
      // 复用，而复用岛里的 `src` 已经是 asset 地址 —— 拿 `src` 判「是不是相对路径」
      // 就等于永远不重算，换文档后图还停在上一份的目录（评审 I5）。
      const rel = img.dataset.relSrc ?? img.getAttribute("src") ?? "";
      if (!rel || /^(https?:|data:|#|\/)/i.test(rel)) continue;
      img.dataset.relSrc = rel;
      const abs = opts.baseDir.replace(/[\\/]+$/, "") + "\\" + rel;
      const next = convertFileSrc(abs);
      // 同值不重写：改 `src` 哪怕值一样也可能让浏览器重新解码那张图
      if (img.getAttribute("src") !== next) img.setAttribute("src", next);
    }
  }

  // KaTeX（有占位才 import）
  const maths = root.querySelectorAll<HTMLElement>(".math-inline-src, .math-display-src");
  if (maths.length > 0) {
    try {
      const katex = (await import("katex")).default;
      if (isEnhanceStale(root, seq)) return;
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
  if (!opts.bigDoc) {
    const codes = root.querySelectorAll<HTMLElement>("pre.md-code[data-lang]");
    const needHighlight = [...codes].filter(
      (el) =>
        el.dataset.highlighted !== "1" && !!el.dataset.lang && !diagramKindOf(el.dataset.lang),
    );
    if (needHighlight.length > 0) {
      if (isEnhanceStale(root, seq)) return;
      for (const el of needHighlight) {
        const lang = el.dataset.lang!;
        const code = el.querySelector("code")?.textContent ?? "";
        const html = await highlightCodeHtml(code, lang);
        if (!html) {
          el.dataset.highlighted = "1"; // 不支持的语言保持纯文本
          continue;
        }
        if (!el.isConnected) continue;
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const pre = holder.firstElementChild;
        if (pre) {
          el.replaceWith(pre);
          (pre as HTMLElement).dataset.highlighted = "1";
        }
      }
    }
  }

  // 图种（B452）：mermaid / 脑图 / Graphviz / Flowchart / PlantUML 共用这一条臂。
  // 大文档档位不自动画（留源码块），与 Shiki 同一颗闸；画失败也只留源码，标一个 diagram-error
  // 让样式把它摆成「没画成的图」而不是普通代码块。
  const diagrams = root.querySelectorAll<HTMLElement>("pre.diagram-src");
  if (diagrams.length > 0 && !opts.bigDoc) {
    for (const el of diagrams) {
      const kind = diagramKindOf(el.dataset.diagram ?? "") ?? "mermaid";
      const code = el.textContent ?? "";
      const host = document.createElement("div");
      host.className = diagramClass(kind, `md-diagram md-diagram--${kind}`, "md-mermaid");
      // 渲染结果落在卡片里的这一格（B455-5）：渲染器可以随意清空它（mermaid 直接 `innerHTML =`），
      // 卡片本身还要放右上角那三颗键，不能被一起抹掉。变换层也只搬这一格。
      const canvas = document.createElement("div");
      canvas.className = "md-diagram-canvas";
      host.append(canvas);
      try {
        await renderDiagram(kind, canvas, code, { root, plantumlServer: opts.plantumlServer });
      } catch {
        el.classList.add("diagram-error");
        continue;
      }
      if (!el.isConnected || isEnhanceStale(root, seq)) return;
      attachDiagramViewport(host);
      el.replaceWith(host);
    }
  }
}
