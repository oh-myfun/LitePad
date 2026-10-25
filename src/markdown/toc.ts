import type { TocEntry } from "./pipeline";
import { setTextTip } from "../shell/tooltip";
import { CODICONS } from "../shell/codicons";

/**
 * 大纲 TOC 抽屉（M3）：渲染活动 Markdown 标签的标题大纲，点击跳转。
 *
 * B205（用户点名「列表支持折叠展开、顶部有大纲字样、全部展开/折叠按钮」）：列表从
 * **扁平一排**（缩进全靠 `padding-left` 按 level 分四档）改成**可折叠的层级树** ——
 *   · 折叠态跟着列表元素走（闭包里的 `collapsed`），光标一动就重绘也不会把用户折的
 *     状态冲掉；
 *   · 顶部那颗「全部折叠 / 全部展开」合并键在 index.html 里（静态结构），这里只暴露
 *     `collapseAll()` / `expandAll()` 让它们按下得动；
 *   · 顶部「大纲」字样同理是静态的 —— 重绘只清 `#toc-list`，不清整个 `#toc-panel`
 *     （B205 之前清的是后者，标题栏会被一起抹掉）。
 *   · B214（用户点名「手动折叠部分或全部元素时，顶部的按钮也要同步变化」）：按钮不能
 *     只在**自己被点**时才刷 —— 点扭角折掉一节、或折完最后一节，图标都得跟着翻。
 *     所以折叠态一变就对外报一声（`createTocList` 第二参），由调用方去刷按钮；
 *     报的出口只有 `applyFold` 一个，见下面那处 ⚠️。
 */

export interface TocCallbacks {
  onJump: (entry: TocEntry) => void;
}

/** 大纲抽屉宽度（px）：拖拽可调，双击分隔条恢复默认。 */
export const SIDE_DEFAULT_WIDTH = 240;
/**
 * 展开区的最小宽度（B327 定 180；上一版 200，B317 曾从 160 提到 220）：160 那一档装不下
 * 资源管理器标题栏那一排 —— 「资源管理器」五个字 + 图标键那一排，窄到一定程度标题先被省略号吃掉。
 * 这一次能再往下收，是因为「打开文件夹」那颗键搬去了根目录那一行（B327），头部只剩四颗。
 * ⚠️ 这一颗与 `preview.css` 的 `.side-drawer { min-width }` 必须同值：CSS 那条是
 *    **没被拖过时的初值**，这一颗是拖拽时的下限，两者错开就是「一拖才终于不挤」。
 */
export const SIDE_MIN_WIDTH = 180;
export const SIDE_MAX_WIDTH = 640;

/** 把任意输入收敛到合法宽度（NaN/非法值回落默认，取整避免亚像素抖动）。 */
export function clampSideWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDE_DEFAULT_WIDTH;
  return Math.min(SIDE_MAX_WIDTH, Math.max(SIDE_MIN_WIDTH, Math.round(width)));
}

/**
 * B212（用户点名）：收起与展开**共用同一个**过冲阈值，取**最小宽度的一半**
 * （`SIDE_MIN_WIDTH / 2` —— 跟着那颗派生，B326 的 200 就是现在的 100）。
 *
 * 「过冲」是什么：宽度**已经贴到 `SIDE_MIN_WIDTH`** 之后，还要**再**往左拖这么多 px
 * 才收起展开区。留这一段而不是「一贴到最小就收」：「把宽拖窄到最小档」这个动作本身就带
 * 一两像素的过冲，「只想拖窄一点」和「收起来」是两件事，中间必须有缓冲。
 *
 * ⚠️⚠️ B213：收起与展开**共用**这条迟滞带（线 = 最小宽往左半个最小宽），收起线 = 展开线。
 *       收起态面板不占位、缝钉在按钮列右缘，放回来就得先把面板从 0 撑到
 *       `SIDE_MIN_WIDTH`（缝自己往右挪一整个最小宽）—— 所以展开那一下缝必然先落到鼠标**右边**，
 *       这是「先撑到最小宽」的几何代价，躲不掉。
 *       ⚠️ 但那不是「光标和分割条之间始终有差距」：累计位移再走到最小宽之后，缝就贴回
 *         鼠标下、每帧差恒 0。B213 之前那个真凶是**多扣了一条阈值**（`MIN + (dx-80)`，
 *         当时最小宽 160、阈值 80），缝−鼠标才**永久**恒 80。现在不扣，只让出「撑到最小宽」这一小段。
 *
 * ⚠️⚠️ 为什么原来是两档（40 / 24）、现在合成一档：B209 那次把 12 提到 40 是因为
 *      「太容易触发折叠展开了」，但**不对称本身又带来新的别扭** —— 收起要比展开多拖
 *      16px，用户的肌肉记忆（「拖过这条线就该放出来了」）在两个方向上不一致。
 *      所以 B212 不再分方向，统一按「最小宽度的一半」走：收起线 = 展开线。
 *      这一量级也比「一次拖窄」的自然过冲（个位数 px）大一个数量级，
 *      同时还在「同一个手势之内」够得着（不用松手重来）。
 *
 * ⚠️ 上面那些「当时是多少 px」是历史现场，别拿它们当现值：阈值与最小宽都从
 *    `SIDE_MIN_WIDTH` 派生，那颗一提，这里所有数字跟着动（用例读的也是符号不是字面量）。
 *
 * ⚠️ 展开后的宽度从 `SIDE_MIN_WIDTH` 起算、按**超出阈值的那一段**增长：拖出阈值那一刻
 *     展开区**先落在最小宽**，再往右拖多少才加多少 —— 与「拖多宽就多宽」的手感一致，
 *     不会一展开就跳到上次那个宽度。
 */
export const SIDE_OVERDRAG_PX = SIDE_MIN_WIDTH / 2;

export interface SideResizerOptions {
  /** 初始宽度（一般由设置载入，非法值自动收敛） */
  initial: number;
  /** 拖拽结束 / 双击重置后回调，供调用方持久化 */
  onChange: (width: number) => void;
  /**
   * B207：展开区此刻是不是摊开着。收起态往右拖要能**拖回来**，而开关状态只有调用方那
   * 一份（`setDrawer` 是显隐的唯一出口），这里问它，不自己另记一份。
   */
  isOpen?: () => boolean;
  /**
   * B207：拖拽 / 双击把展开区收起（false）或拖回来（true）时回调。
   *
   * 缺省 = 这个实例只管宽度、不管收放（不用收放的用法不用补两份胶水）。
   */
  onOpenChange?: (open: boolean) => void;
}

export interface SideResizerHandle {
  getWidth(): number;
  setWidth(width: number): void;
  /** B207：展开区当前是不是摊开着（与 `opts.isOpen` 同一个来源，别各记一份）。 */
  isOpen(): boolean;
}

/**
 * 给**左栏**挂上可拖拽的宽度分隔条（B212 起与大纲同名前缀 `TOC_` 全部撒手 —— 左栏
 * 以后不只有大纲，宽度与收放这两件事不该挂在大纲的名下）。
 *
 * 说明：分隔条是独立元素（#side-resizer）而非面板边框，且沿用与分屏一致的
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
export function attachSideResizer(
  resizer: HTMLElement,
  panel: HTMLElement,
  opts: SideResizerOptions,
): SideResizerHandle {
  let width = clampSideWidth(opts.initial);
  /** 展开区开合：调用方没给就恒为「摊开着」（只调宽度、不管收放的用法）。 */
  const isOpen = opts.isOpen ?? (() => true);

  /**
   * B207：只在该变的时候报一次 —— 拖到底会连发几十个 mousemove，每个都去切一次
   * `setDrawer` 会把落盘与重绘打十遍。
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
    /**
     * B213（用户实测报的两个 bug，根因都在这条**锚**上）：锚只能记**按下那一刻**的基准，
     * 每帧按**增量**往前推 —— 绝不能在切到收起/展开的那一帧还抱着手势最开始那个基准。
     *
     * 原来错在哪（两个症状一次对上）：
     *   · 收起态那一路算的是 `SIDE_MIN_WIDTH + (dx - SIDE_OVERDRAG_PX)`，`dx` 从按下点
     *     起算。80 的阈值把展开触发在 dx=80 那一点，可缝这时已经要长到最小宽 160（当时的
     *     最小宽，现值见 `SIDE_MIN_WIDTH`）——
     *     缝**比鼠标右移了整整一条阈值**，而且之后每一帧都恒差这么多 ⇒ 症状 2：
     *     「鼠标还没到最小宽度位置，分割条就先往右挪了」。
     *   · 展开态那一路是 `startWidth + dx`，`startWidth` 记的是**手势开始时**的宽度。
     *     拖到收起那一帧之后面板 hidden、缝缩回按钮列右缘，可 dx 还得先爬回 0 附近才
     *     推得动它 ⇒ 按住不松手往右拖，缝纹丝不动（症状 1：「折叠后再拖回展不开」）。
     *
     * 现在收起态的锚 = 0（面板不占位、缝钉在按钮列右缘）、展开态的锚 = 当前宽度，
     * 每帧 `target += 本帧位移` ⇒ **缝的位移恒等于鼠标的位移**，两个方向都跟手。
     * ⚠️ 展开线就是这条迟滞带（**最小宽的一半**）—— 用户拍定「触发展开是一半的宽度」：
     *    还没拖到最小宽就放出来，省掉一截死区；放出来那一帧宽度**先落在最小宽**
     *    （`clampSideWidth` 保底 = `SIDE_MIN_WIDTH`），再往右拖多少才加多少，与 B212 那条
     *    「先变最小宽、继续拖拽才再变宽」同口径。
     */
    /** 这个实例到底管不管「收放」：没接 `onOpenChange` 的用法只看宽度，收起线对它不成立。 */
    const canCollapse = typeof opts.onOpenChange === "function";
    let lastX = e.clientX;
    let target = isOpen() ? width : 0;
    document.body.classList.add("layout-dragging");
    // 点亮只挂**这一条**（对齐分屏那条 `.layout-sep.resizing` 的口径，B217：
    // 拖哪条就亮哪条 —— 全局的 layout-dragging 会让别的分割条一起亮）。
    // 与 body 那个类同生命周期：按下加、松手摘，别漏了 remove。
    resizer.classList.add("resizing");

    const onMove = (ev: MouseEvent): void => {
      // ⚠️ 增量累加，不是每帧拿「按下那一点」重算总位移：折叠 / 展开那一下锚会换，
      //    用总位移算就永久错位（症状 1 就是这么来的）。
      target += ev.clientX - lastX;
      lastX = ev.clientX;
      // 收起态面板不占位、缝钉在按钮列右缘：还没过「最小宽的一半」这条线就别动它
      // （一碰就弹开）。收起线 = 展开线 = 这条，收起那一支在下面同用一个数。
      if (!isOpen() && target <= SIDE_MIN_WIDTH - SIDE_OVERDRAG_PX) return;
      if (target <= SIDE_MIN_WIDTH - SIDE_OVERDRAG_PX) {
        if (canCollapse) {
          // B207：收起后宽度留在最小宽，拖回来接着用（不是默认值、也不是收起那一刻的值）
          width = SIDE_MIN_WIDTH;
          // ⚠️ 先落盘再转 hidden：面板一 hidden 就没人管 inline 宽度了，拖回来时
          //    「接着用」的那份宽度得先写进去。
          apply(width);
          notifyOpen(false);
          return;
        }
      } else {
        // 同一个手势里折过又拖回来，这一下照样放得开
        if (!isOpen()) notifyOpen(true);
      }
      width = clampSideWidth(target);
      apply(width);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("layout-dragging");
      resizer.classList.remove("resizing");
      opts.onChange(width);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 双击分隔条恢复默认宽度
  resizer.addEventListener("dblclick", () => {
    const wasOpen = isOpen();
    width = SIDE_DEFAULT_WIDTH;
    apply(width);
    opts.onChange(width);
    // B207：收起态双击顺手把展开区放回来 —— 双击本来就带「回到默认」的意思，收着的时候
    // 双击却什么都不放出来，等于这条捷径是坏的，还得去找那颗大纲键。
    if (!wasOpen) notifyOpen(true);
  });

  return {
    getWidth: () => width,
    setWidth: (w: number) => {
      width = clampSideWidth(w);
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
 * B382 · 缩进引导线（照 `explorer/panel.ts` 的 `guideColumn` / VS Code
 * `.monaco-tl-indent`）：每行自己带一列绝对定位的线，左沿 16px、每根 8px，只画
 * **祖先**那几根。深度对齐资源管理器的计法（最外层占根位 = depth 0）：
 * h1 与它的直接子层（depth ≤ 1）不画线，depth ≥ 2 才有 depth-1 根 ——
 * 与 explorer「根行与顶层条目无线」同形。
 * 每根线记着它对应哪位祖先（`data-toc-id`），光标行的祖先链由 `paintActiveGuides`
 * 点亮实色，与 explorer 选中行同一口径。
 */
function guideColumn(depth: number, chain: string[]): HTMLElement | null {
  if (depth <= 1) return null;
  const owners = chain.slice(1); // 去掉最外层（h1 占根位）⇒ 正好 depth-1 根
  const box = document.createElement("span");
  box.className = "toc-indent";
  box.setAttribute("aria-hidden", "true");
  for (const owner of owners) {
    const line = document.createElement("span");
    line.className = "toc-guide";
    line.dataset.tocId = owner;
    box.append(line);
  }
  return box;
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
/**
 * `onFoldChange`：折叠态**每变一次**就报一声（B214）。调用方用它刷新顶部那颗全量键 ——
 * 按钮显示的是「下一次点下去会折还是会展」，得跟着扭角 / 全量键的每一次折展走。
 *
 * ⚠️ 为什么是可选参数、不建表后再挂：`createTocList` 全程只调一次（见文件头），
 *    参数形态与 `attachSideResizer` 的 `onOpenChange` 同款；不让它收第二份状态，
 *    免得调用方还得记得「挂了监听没」。
 */
export function createTocList(list: HTMLElement, onFoldChange?: () => void): TocListHandle {
  const collapsed = new Set<string>();
  /** 最近一次 render 里所有「有子的节点」的 id —— 全量折叠/展开只认这一类。 */
  let branchIds: string[] = [];
  /** B382：光标行节点的 id（可能多条同行的标题都算）—— 引导线 active 判据的源头。 */
  const activeIds = new Set<string>();
  /** B382：id → 父 id / 是否分支 —— 折叠变化时重算活动引导线要用，不必留着整棵树。 */
  const nodeMeta = new Map<string, { parent: string | null; branch: boolean }>();

  /**
   * B382（照 explorer 的 `paintActiveGuides`）：光标行若是有子且摊开的分支就亮它自己
   * （给它的孩子看），否则亮它的父亲。线早就随行建好了，这里只换 `is-active` 类，
   * 不重画 —— 折/展一变也要跟着刷（摊开的分支折上后，亮的那根该让给父亲）。
   */
  const paintActiveGuides = (): void => {
    const owners = new Set<string>();
    for (const id of activeIds) {
      const meta = nodeMeta.get(id);
      if (!meta) continue;
      if (meta.branch && !collapsed.has(id)) owners.add(id);
      else if (meta.parent !== null) owners.add(meta.parent);
    }
    for (const line of list.querySelectorAll<HTMLElement>(".toc-guide")) {
      line.classList.toggle(
        "is-active",
        line.dataset.tocId !== undefined && owners.has(line.dataset.tocId),
      );
    }
  };

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
    // ⚠️ B214：出口**只留这一个**（`applyFold`）。扭角 handler、collapseAll、expandAll
    //    三处都各自去刷调用方的话，就是三个同步点，迟早错开（「手动折了、按钮没动」就是
    //    这么来的）。放在这里还有一个好处：通知发出去时 DOM 已经刷完，调用方再问
    //    `allCollapsed()` 拿到的一定是新状态，不必再等一帧。
    onFoldChange?.();
    // B382：折/展会改变「亮哪根线」的判据（摊开的分支折上 ⇒ 让给父亲），补刷一发。
    paintActiveGuides();
  };

  const render = (entries: TocEntry[] | null, activeLine: number, cb: TocCallbacks): void => {
    // 重绘前记住滚动位置：光标一动就重绘，列表跳回顶部比不刷新还难受
    const keepScroll = list.scrollTop;
    list.textContent = "";
    branchIds = [];
    activeIds.clear();
    nodeMeta.clear();
    if (entries === null || entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc-empty";
      empty.textContent = entries === null ? "当前文档类型不支持大纲" : "当前文档没有标题";
      list.appendChild(empty);
      return;
    }
    const walk = (nodes: TocNode[], parent: HTMLElement, depth: number, chain: string[]): void => {
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
        // B382：缩进照 explorer 走 `--depth`（每层 8px），不再靠嵌套容器的 margin ——
        // 折叠时子容器整体 display:none，靠容器累加缩进的写法行高会随祖先开合抖动。
        item.style.setProperty("--depth", String(depth));
        item.setAttribute("aria-level", String(depth + 1));
        if (node.branch) item.setAttribute("aria-expanded", String(!collapsed.has(node.entry.id)));
        wrap.appendChild(item);

        nodeMeta.set(node.entry.id, {
          parent: chain.length > 0 ? chain[chain.length - 1] : null,
          branch: node.branch,
        });
        if (node.entry.line === activeLine) activeIds.add(node.entry.id);

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
          // 只给分支挂扭角列 ⇒ 同层里「有子的」文字被顶右、「叶子」贴左，
          // 两条同一层的标题看着是错开的。VS Code 的 tree 每行都有 twisty 那一列，
          // 叶子只是那一格为空 —— 这里同口径。
          // ⚠️ 类名必须**不是** `.toc-caret`：折叠逻辑靠「有没有扭角」判分支
          //    （`applyFold` 里 `caret` 为 null ⇒ 叶子），混用同一个类会把叶子也当分支。
          const slot = document.createElement("i");
          slot.className = "toc-caret-slot";
          slot.setAttribute("aria-hidden", "true");
          item.appendChild(slot);
        }
        // B382：引导线列（depth ≥ 2 才有）放在扭角之后 —— 绝对定位不吃布局，
        // 但首格契约（扭角/占位槽是第一个子元素）保持不变。
        const guide = guideColumn(depth, chain);
        if (guide) item.appendChild(guide);

        const text = document.createElement("span");
        text.className = "toc-text";
        text.textContent = node.entry.text || "(无标题)";
        item.appendChild(text);
        // B58：提示给行号（标题文本本身就在眼前，重复它没意义）；group 只作结构性标记
        // （B127 之后它已不参与秒开）。
        // B236 定的是「与标签完全同档」（跟鼠标、不画小箭头、12px 紧凑）；B350 起那一档
        // 的开关收进 setTextTip 一处，站点再手抄一遍就会漏改。
        setTextTip(item, `第 ${node.entry.line} 行`, { group: "toc" });
        item.addEventListener("click", () => cb.onJump(node.entry));

        if (node.branch) {
          branchIds.push(node.entry.id);
          const kids = document.createElement("div");
          kids.className = "toc-children";
          if (collapsed.has(node.entry.id)) kids.classList.add("is-collapsed");
          wrap.appendChild(kids);
          walk(node.children, kids, depth + 1, [...chain, node.entry.id]);
        }
      }
    };
    walk(buildTocTree(entries), list, 0, []);
    list.scrollTop = keepScroll;
    paintActiveGuides();
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
