import type { TocEntry } from "./pipeline";
import { setTip } from "../shell/tooltip";
import { CODICONS } from "../shell/codicons";

/**
 * 大纲 TOC 抽屉（M3）：渲染活动 Markdown 标签的标题大纲，点击跳转。
 *
 * B205（用户点名「列表支持折叠展开、顶部有大纲字样、全部展开/折叠按钮」）：列表从
 * **扁平一排**（缩进全靠 `padding-left` 按 level 分四档）改成**可折叠的层级树** ——
 *   · 折叠态跟着列表元素走（闭包里的 `collapsed`），光标一动就重绘也不会把用户折的
 *     状态冲掉；
 *   · 「全部折叠 / 全部展开」两颗键在 index.html 里（静态结构），这里只暴露
 *     `collapseAll()` / `expandAll()` 让它们按下得动；
 *   · 顶部「大纲」字样同理是静态的 —— 重绘只清 `#toc-list`，不清整个 `#toc-panel`
 *     （B205 之前清的是后者，标题栏会被一起抹掉）。
 */

export interface TocCallbacks {
  onJump: (entry: TocEntry) => void;
}

/** 大纲抽屉宽度（px）：拖拽可调，双击分隔条恢复默认。 */
export const TOC_DEFAULT_WIDTH = 240;
export const TOC_MIN_WIDTH = 160;
export const TOC_MAX_WIDTH = 640;

/** 把任意输入收敛到合法宽度（NaN/非法值回落默认，取整避免亚像素抖动）。 */
export function clampTocWidth(width: number): number {
  if (!Number.isFinite(width)) return TOC_DEFAULT_WIDTH;
  return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(width)));
}

export interface TocResizerOptions {
  /** 初始宽度（一般由设置载入，非法值自动收敛） */
  initial: number;
  /** 拖拽结束 / 双击重置后回调，供调用方持久化 */
  onChange: (width: number) => void;
}

export interface TocResizerHandle {
  getWidth(): number;
  setWidth(width: number): void;
}

/**
 * 给大纲抽屉挂上可拖拽的宽度分隔条。
 *
 * 说明：分隔条是独立元素（#toc-resizer）而非面板边框，且沿用与分屏一致的
 * 指针事件序列（mousedown → document mousemove/mouseup）自行编排 ——
 * 历史原因是 WebView2 的拖放钩子会禁用页面内 HTML5 拖放（B91 已关掉该钩子），
 * 现在依旧用指针序列：拖分隔条是「按住并移动」，与 HTML5 DnD 的搬运语义无关。
 */
export function attachTocResizer(
  resizer: HTMLElement,
  panel: HTMLElement,
  opts: TocResizerOptions,
): TocResizerHandle {
  let width = clampTocWidth(opts.initial);

  const apply = (w: number): void => {
    // 同时写 width 与 min-width：父容器是 flex 行，min-width 才能挡住被挤压
    panel.style.width = `${w}px`;
    panel.style.minWidth = `${w}px`;
  };
  apply(width);

  resizer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    document.body.classList.add("layout-dragging");

    const onMove = (ev: MouseEvent): void => {
      // 大纲在左侧，向右拖 = 变宽
      width = clampTocWidth(startWidth + (ev.clientX - startX));
      apply(width);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("layout-dragging");
      opts.onChange(width);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 双击分隔条恢复默认宽度
  resizer.addEventListener("dblclick", () => {
    width = TOC_DEFAULT_WIDTH;
    apply(width);
    opts.onChange(width);
  });

  return {
    getWidth: () => width,
    setWidth: (w: number) => {
      width = clampTocWidth(w);
      apply(width);
    },
  };
}

/** 大纲里的一个层级节点（由扁平 `entries` 按 level 归纳出来）。 */
interface TocNode {
  entry: TocEntry;
  children: TocNode[];
  /** 有子标题 ⇒ 给扭角（叶子不给：VS Code 的 twisty 只挂在有子的节点上） */
  branch: boolean;
}

/**
 * 把扁平的 `TocEntry[]`（按源码行序、只有 `level`）归纳成层级树。
 *
 * 靠 **level 单调** 归纳，而不是「level - 1 就是父」：各格式的 level 取值并不整齐
 * （toml 的 `[section]` 从 1 起、json 的键也可能跳级），只认单调 + 出栈，「父节点 =
 * 最近一个 level 更小的祖先」才不会在跳级时串层。
 */
function buildTocTree(entries: TocEntry[]): TocNode[] {
  const roots: TocNode[] = [];
  /** 祖先链：栈内 level 单调递减，栈顶是最近一个 level 更小的候选父。 */
  const stack: TocNode[] = [];
  for (const entry of entries) {
    const node: TocNode = { entry, children: [], branch: false };
    while (stack.length > 0 && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
      parent.branch = true;
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
}

/** 大纲列表控制器（挂在 index.html 的 `#toc-list` 上）。 */
export interface TocListHandle {
  /**
   * 重绘列表；`entries = null` = 当前文档类型不支持大纲，`[]` = 支持但没标题。
   *
   * `cb` 走参数而不是建表时传：光标一动就要重绘，而重绘时得用**刚跳到哪个实例**的
   * 上下文里的跳转逻辑，写死在建表那一步会指向过期的闭包。
   */
  render(entries: TocEntry[] | null, activeLine: number, cb: TocCallbacks): void;
  /** 全部折起（只留最外层标题） */
  collapseAll(): void;
  /** 全部展开 */
  expandAll(): void;
}

/**
 * 建一个大纲列表控制器（**只建一次**）。
 *
 * 折叠态在闭包里（`collapsed`），跟着 `list` 活 —— `render` 会把节点整个重建一遍，
 * 状态存在 DOM 上会在重绘那一刻丢光（光标每动一次就重绘一次，用户折的节会被冲回默认
 * 全展开）。所以「建表 = 一次」，重绘只走 `render`。
 *
 * ⚠️ 单条扭角的折叠**不做整表重绘**（只切这个节点的 `is-collapsed` 并翻字形）：重绘
 *    会重置列表滚动位置，长文档里点一下扭角就跳回顶部，很难用。
 */
export function createTocList(list: HTMLElement): TocListHandle {
  const collapsed = new Set<string>();
  /** 最近一次 render 里所有「有子的节点」的 id —— 全量折叠/展开只认这一类。 */
  let branchIds: string[] = [];

  /** 把 `collapsed` 这份状态刷到 DOM 上（同样只动这几个节点，不重建）。 */
  const applyFold = (): void => {
    for (const wrap of Array.from(list.querySelectorAll<HTMLElement>(".toc-node"))) {
      const id = wrap.dataset.tocId;
      if (id === undefined) continue;
      const on = collapsed.has(id);
      wrap.querySelector(".toc-children")?.classList.toggle("is-collapsed", on);
      const item = wrap.querySelector(".toc-item");
      item?.setAttribute("aria-expanded", String(!on));
      const caret = item?.querySelector(".toc-caret");
      if (caret) {
        caret.className =
          "toc-caret codicon codicon-" + (on ? CODICONS.chevronRight : CODICONS.chevronDown);
      }
    }
  };

  const render = (entries: TocEntry[] | null, activeLine: number, cb: TocCallbacks): void => {
    // 重绘前记住滚动位置：光标一动就重绘，列表跳回顶部比不刷新还难受
    const keepScroll = list.scrollTop;
    list.textContent = "";
    branchIds = [];
    if (entries === null || entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc-empty";
      empty.textContent = entries === null ? "当前文档类型不支持大纲" : "当前文档没有标题";
      list.appendChild(empty);
      return;
    }
    const walk = (nodes: TocNode[], parent: HTMLElement): void => {
      for (const node of nodes) {
        const wrap = document.createElement("div");
        wrap.className = "toc-node";
        wrap.dataset.tocId = node.entry.id;
        parent.appendChild(wrap);

        const item = document.createElement("button");
        item.type = "button";
        item.className =
          "toc-item toc-h" +
          node.entry.level +
          (node.entry.line === activeLine ? " toc-active" : "") +
          (node.branch ? " toc-branch" : "");
        if (node.branch) item.setAttribute("aria-expanded", String(!collapsed.has(node.entry.id)));
        wrap.appendChild(item);

        if (node.branch) {
          const caret = document.createElement("i");
          // 折叠态直接画在字形上 —— 与置顶 / 同步滚动 / 左栏显隐那几颗同口径：状态落在
          // 字形，不靠配色，也就不必为「折着」再造一颗反相图标。
          caret.className =
            "toc-caret codicon codicon-" +
            (collapsed.has(node.entry.id) ? CODICONS.chevronRight : CODICONS.chevronDown);
          caret.setAttribute("aria-hidden", "true");
          // 扭角只管这一节的折/展：必须掐住冒泡 —— 它长在标题按钮**里面**，不掐的话
          // 同一下点击会顺带跳到标题行（「点扭角＝折叠」变成「折叠＋跳转」）。
          caret.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const on = !collapsed.has(node.entry.id);
            if (on) collapsed.add(node.entry.id);
            else collapsed.delete(node.entry.id);
            applyFold();
          });
          item.appendChild(caret);
        }

        const text = document.createElement("span");
        text.className = "toc-text";
        text.textContent = node.entry.text || "(无标题)";
        item.appendChild(text);
        // B58：提示给行号（标题文本本身就在眼前，重复它没意义）；group 让顺着大纲扫过去秒开
        setTip(item, `第 ${node.entry.line} 行`, { group: "toc" });
        item.addEventListener("click", () => cb.onJump(node.entry));

        if (node.branch) {
          branchIds.push(node.entry.id);
          const kids = document.createElement("div");
          kids.className = "toc-children";
          if (collapsed.has(node.entry.id)) kids.classList.add("is-collapsed");
          wrap.appendChild(kids);
          walk(node.children, kids);
        }
      }
    };
    walk(buildTocTree(entries), list);
    list.scrollTop = keepScroll;
  };

  return {
    render,
    collapseAll: () => {
      for (const id of branchIds) collapsed.add(id);
      applyFold();
    },
    expandAll: () => {
      for (const id of branchIds) collapsed.delete(id);
      applyFold();
    },
  };
}
