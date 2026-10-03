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

/**
 * B212（用户点名）：收起与展开**共用同一个**过冲阈值，取**最小宽度的一半**
 * （`TOC_MIN_WIDTH / 2` = 80）。
 *
 * 「过冲」是什么：宽度**已经贴到 `TOC_MIN_WIDTH`** 之后，还要**再**往左拖这么多 px
 * 才收起展开区（反之，收起态往右拖这么多 px 才放回来）。留这一段而不是「一贴到最小
 * 就收/就放」：「把宽拖窄到 160」这个动作本身就带一两像素的过冲，「只想拖窄一点」和
 * 「收起来」是两件事，中间必须有缓冲。
 *
 * ⚠️⚠️ 为什么原来是两档（40 / 24）、现在合成一档：B209 那次把 12 提到 40 是因为
 *      「太容易触发折叠展开了」，但**不对称本身又带来新的别扭** —— 收起要比展开多拖
 *      16px，用户的肌肉记忆（「拖过这条线就该放出来了」）在两个方向上不一致。
 *      所以 B212 不再分方向，统一按「最小宽度的一半」走：收起线 = 展开线 = 80。
 *      80 这个量级也比「一次拖窄」的自然过冲（个位数 px）大一个数量级，
 *      同时还在「同一个手势之内」够得着（不用松手重来）。
 *
 * ⚠️ 展开后的宽度从 `TOC_MIN_WIDTH` 起算、按**超出阈值的那一段**增长：拖出阈值那一刻
 *     展开区**先落在最小宽**，再往右拖多少才加多少 —— 与「拖多宽就多宽」的手感一致，
 *     不会一展开就跳到上次那个宽度。
 */
export const TOC_OVERDRAG_PX = TOC_MIN_WIDTH / 2;

export interface TocResizerOptions {
  /** 初始宽度（一般由设置载入，非法值自动收敛） */
  initial: number;
  /** 拖拽结束 / 双击重置后回调，供调用方持久化 */
  onChange: (width: number) => void;
  /**
   * B207：展开区此刻是不是摊开着。收起态往右拖要能**拖回来**，而开关状态只有调用方那
   * 一份（`setTocOpen` 是显隐的唯一出口），这里问它，不自己另记一份。
   */
  isOpen?: () => boolean;
  /**
   * B207：拖拽 / 双击把展开区收起（false）或拖回来（true）时回调。
   *
   * 缺省 = 这个实例只管宽度、不管收放（不用收放的用法不用补两份胶水）。
   */
  onOpenChange?: (open: boolean) => void;
}

export interface TocResizerHandle {
  getWidth(): number;
  setWidth(width: number): void;
  /** B207：展开区当前是不是摊开着（与 `opts.isOpen` 同一个来源，别各记一份）。 */
  isOpen(): boolean;
}

/**
 * 给大纲抽屉挂上可拖拽的宽度分隔条。
 *
 * 说明：分隔条是独立元素（#toc-resizer）而非面板边框，且沿用与分屏一致的
 * 指针事件序列（mousedown → document mousemove/mouseup）自行编排 ——
 * 历史原因是 WebView2 的拖放钩子会禁用页面内 HTML5 拖放（B91 已关掉该钩子），
 * 现在依旧用指针序列：拖分隔条是「按住并移动」，与 HTML5 DnD 的搬运语义无关。
 *
 * B207（用户点名「拖到最小后再往左拖 → 隐藏左栏展开区；隐藏后分割线仍看得见、仍可操作，
 * 往右拖把它展开」）补的是**收放**这一半：
 *   · `isOpen()` / `onOpenChange(open)` 两个口子 —— 收放状态仍然只有调用方那一处
 *     （`#toc-panel` 的 hidden），这里只负责报「该收了 / 该放了」；
 *   · 收起态**照样吃指针**（CSS 的 `.is-off` 不再 `pointer-events: none`、把手也不再
 *     `visibility: hidden`），往右一拖就回来。
 *   ⚠️ 收起后 `width` 原样留着：拖回来时它是「上次拖到底那个宽度」，不是默认值。
 */
export function attachTocResizer(
  resizer: HTMLElement,
  panel: HTMLElement,
  opts: TocResizerOptions,
): TocResizerHandle {
  let width = clampTocWidth(opts.initial);
  /** 展开区开合：调用方没给就恒为「摊开着」（只调宽度、不管收放的用法）。 */
  const isOpen = opts.isOpen ?? (() => true);

  /**
   * B207：只在该变的时候报一次 —— 拖到底会连发几十个 mousemove，每个都去切一次
   * `setTocOpen` 会把落盘与重绘打十遍。
   * ⚠️ 判据问 `isOpen()` 而不是自己缓存布尔：显隐的唯一出口在调用方那边，缓存一份迟早
   *    跟它错开（用户这时候顺手点了那颗「大纲」键，两边就对不上了）。
   */
  const notifyOpen = (open: boolean): void => {
    if (!opts.onOpenChange || isOpen() === open) return;
    opts.onOpenChange(open);
  };

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
    /**
     * B212：这一**手势**是从「收着」开始的，就整段都按「收起态恢复」那一套算宽度 —— 不
     * 看实时 `isOpen()`。
     *
     * ⚠️ 为什么必须记手势起始态：展开是过阈值那一刻才发生的（`notifyOpen(true)` 之后
     *     实时 `isOpen()` 立刻为真），若按实时状态选分支，过阈值的**下一帧**就会切回
     *     「已展开」分支、宽度瞬间跳到 `startWidth + dx` —— 一次跳掉**整条阈值**（阈值
     *     从 24 提到 80 之后这个跳变肉眼可见：面板先出 180、再“啪”一下变 260）。
     *     记住起始态 ⇒ 整段手势宽度连续：刚过阈值是最小宽，继续拖才一段段加。
     */
    const startOpen = isOpen();
    document.body.classList.add("layout-dragging");

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      if (!startOpen) {
        // B207：收起态往右拖 = 把展开区拖回来。
        // ⚠️ B209：必须越过 `TOC_OVERDRAG_PX` 才展开（旧行为 dx>0 就弹，太容易误触）；
        //    B212：展开后宽度**先落回最小宽**，按超出阈值的那一段增长 ⇒ 拖多宽就是多宽，
        //    不会一展开就跳到上次那个宽度。
        if (dx < TOC_OVERDRAG_PX) return;
        notifyOpen(true);
        width = clampTocWidth(TOC_MIN_WIDTH + (dx - TOC_OVERDRAG_PX));
        apply(width);
        return;
      }
      // 大纲在左侧，向右拖 = 变宽
      width = clampTocWidth(startWidth + dx);
      apply(width);
      // B207：贴到最小之后**还继续**往左拖过阈值 = 收起。拿 `startWidth + dx` 直接比
      // 就够，不用累加位移：dx 是按下那一点算起的总位移，越过「最小线再往左
      // `TOC_OVERDRAG_PX`」那一点就行（累加会把每次 move 的位移重复算成一大截）。
      if (dx < 0 && startWidth + dx <= TOC_MIN_WIDTH - TOC_OVERDRAG_PX) {
        notifyOpen(false);
      }
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
    const wasOpen = isOpen();
    width = TOC_DEFAULT_WIDTH;
    apply(width);
    opts.onChange(width);
    // B207：收起态双击顺手把展开区放回来 —— 双击本来就带「回到默认」的意思，收着的时候
    // 双击却什么都不放出来，等于这条捷径是坏的，还得去找那颗大纲键。
    if (!wasOpen) notifyOpen(true);
  });

  return {
    getWidth: () => width,
    setWidth: (w: number) => {
      width = clampTocWidth(w);
      apply(width);
    },
    isOpen: () => isOpen(),
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
  /**
   * B209：所有分支都折着吗 —— 合并后的那颗全量键靠它决定「这一下是折还是展」。
   * ⚠️ 没有分支时返回 `false`（全是叶子，没什么可折）：那颗键于是走「折叠」那一支，
   *    点了没有任何变化，比「点了却切成展开态、再点才折」直观。
   */
  allCollapsed(): boolean;
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
      // ⚠️ 只给**分支**报 aria-expanded —— 旧写法扫到叶子也写，读屏器会把「一行没有
      //    子标题的标题」念成「可折叠、已展开」，而它其实什么也折不了。叶子没有扭角 ⇒
      //    `caret` 为 null，顺带就把这一档排除了，不必再单独判 children 存不存在。
      const caret = item?.querySelector(".toc-caret");
      if (caret) {
        item?.setAttribute("aria-expanded", String(!on));
        // B208：与上面 render 那处同一口径 —— 换字形是换 innerHTML，不是换 className
        //        （把 CODICONS 那整个元素串拼进 className 会让箭头彻底画不出来）。
        caret.innerHTML = on ? CODICONS.chevronRight : CODICONS.chevronDown;
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
          // ⚠️ B208：字形走 **`innerHTML` + `CODICS` 那层**（`CODICONS.<name>` 给的是
          //    可直接塞进 innerHTML 的 `<i class="codicon codicon-x">`）。旧写法把它拼进
          //    `className` ⇒ 属性字符串里嵌了 HTML，实际 DOM 是
          //    `<i class="toc-caret codicon codicon-<i class="codicon codicon-chevron-…">">`
          //    —— `codicon-chevron-*` 落不到任何元素上 ⇒ **箭头从来就没画出来过**。
          //    与空隙里那颗把手（.toc-grip）完全同款：外层占位 <i> + 内层 .codicon。
          // 折叠态直接画在字形上 —— 与置顶 / 同步滚动 / 左栏显隐那几颗同口径：状态落在
          // 字形，不靠配色，也就不必为「折着」再造一颗反相图标。
          caret.className = "toc-caret";
          caret.innerHTML = collapsed.has(node.entry.id)
            ? CODICONS.chevronRight
            : CODICONS.chevronDown;
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
        } else {
          // B209（用户点名「同一层级最好左侧能对齐」）：叶子**也要占一格**等宽的槽。
          // 只给分支挂 14px 的扭角列 ⇒ 同层里「有子的」文字被顶右 14px、「叶子」贴左，
          // 两条同一层的标题看着是错开的。VS Code 的 tree 每行都有 twisty 那一列，
          // 叶子只是那一格为空 —— 这里同口径：**
          // ⚠️ 类名必须**不是** `.toc-caret`：折叠逻辑靠「有没有扭角」判分支
          //    （`applyFold` 里 `caret` 为 null ⇒ 叶子），混用同一个类会把叶子也当分支。
          const slot = document.createElement("i");
          slot.className = "toc-caret-slot";
          slot.setAttribute("aria-hidden", "true");
          item.appendChild(slot);
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
    allCollapsed: () => branchIds.length > 0 && branchIds.every((id) => collapsed.has(id)),
  };
}
