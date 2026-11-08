/**
 * B314 / B315 / B424 · 资源管理器面板（视图层）。
 *
 * 只做五件事：把**每一根**那几棵**懒加载的树**画出来、把三种手势（点开目录 / 点文件 /
 * 键盘上下）转成一次调用、把头部的三颗键（打开文件夹 / 全部折叠 / 新建）加上**每根行上
 * 自带的刷新键**接上、把新建与改名的名字输入框放在**它该在的那一层**、以及 B315 的
 * **右键菜单**（复用 `shell/menu` 那套浮层，不另造一个菜单组件）。
 * **不读盘、不排序、不校验名字、不拼路径** —— 那些在 `commands/explorer.rs`；
 * **不缓存、不判在飞、不动剪贴板** —— 那些在 `./store.ts`。视图再判一遍就是两套口径（B304 那一族的教训）。
 *
 * 依赖方向：本模块 → `shell/drawer`（登记成外壳的一个视图）→ `ui`；
 * 打开文件走 `io/files` 的 `doOpen`（与拖放、最近打开、文件关联同一扇漏斗，
 * 「最近打开」的记入因此自动跟着生效，不必这里再报一发）。
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { windowKind, settings } from "../core/app-state";
import {
  createDir,
  createFile,
  filterTree,
  isDir,
  revealInFolder,
  saveSettings,
  type FsEntry,
} from "../ipc/api";
import { doOpen } from "../io/files";
import { clearCompareSelection, compareMenuItems, toggleCompareSelection } from "../diff/compare";
import { openFileDiff } from "../diff/model";
import { noteOpened } from "../recents/store";
import { detectLanguage } from "../editor/language";
import { CODICONS } from "../shell/codicons";
import { fileIconHtml } from "../shell/fileicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
import { showPopupMenu, type MenuItem } from "../shell/menu";
import { setTip, setTextTip } from "../shell/tooltip";
import { isTreeDrag, TREE_DRAG_FILE_MIME, TREE_DRAG_MIME } from "../shell/filedrop";
import {
  explorerCollapse,
  explorerFilterCase,
  explorerFilterClear,
  explorerFilterExcludes,
  explorerFilterInput,
  explorerFilterRegex,
  explorerFilterWord,
  explorerNewDir,
  explorerNewFile,
  explorerOpen,
  explorerPanel,
  explorerTitle,
  explorerTree,
  showMessage,
  sideExplorer,
} from "../ui";
import {
  addRoot,
  childrenOf,
  collapseAll,
  errorOf,
  getClipboard,
  getRoots,
  hasRoot,
  isExpanded,
  isLoading,
  moveTo,
  onExplorerChange,
  pasteInto,
  refreshDir,
  refreshRoot,
  removeRoot,
  renameEntryAt,
  rootOf,
  setClipboard,
  setRoots,
  toggleDir,
  trashAt,
  type ClipItem,
} from "./store";
import {
  DEFAULT_FILTER,
  filterActive,
  treeOf,
  visibleOf,
  type FilterNode,
  type FilterOpts,
} from "./filter";

type Kind = "file" | "dir";

/** 焦点行：新建的目标目录、键盘移动、菜单动作的主语都读它。 */
let selected: string | null = null;
/**
 * 多选的那一批（按**选中顺序**排）；焦点可以在这一批之外（Ctrl 点掉某条后焦点仍留在那一行，
 * 与 VS Code 的 list 同形）。顺序不是摆设：右键「将已选择进行比较」时第一条当左栏。
 */
let picks: string[] = [];
/** Shift 连选的锚点：最近一次无修饰点击或 Ctrl 点击落下的那一行。 */
let anchor: string | null = null;
/** 正在输入名字的创建：目标目录 + 建什么。非 null 时那一层下面多一个输入框。 */
let creating: { dir: string; kind: Kind } | null = null;
/** 正在改名那一条（路径 + 它所在层）。非 null 时它那一行的名字换成输入框。 */
let renaming: { path: string; dir: string } | null = null;
/**
 * B424：哪些根那一行**被收起**了（存折叠的那几根，不是存展开的）。
 * 空表 = 全都摊开 —— 新加的一根、启动回放的一根都默认摊开（VS Code / InkNote 都是这样：
 * 「加进来就该看得见里面」）。不跟 `store.expanded` 混一格：那一格记的是树里的目录，
 * 「全部折叠」要清得掉它，而根那一行必须留着（清掉就没法把整块收干净了）。
 */
const rootsCollapsed = new Set<string>();
/** 每一行的父亲与类型：渲染时顺手记下，新建目标目录靠它算，**不做路径字符串手术**。 */
const rows = new Map<string, pathRow>();
/** 当前可见行的顺序（键盘上下走的就是这份）。 */
let visible: string[] = [];

/** 渲染时记下的父子表（`rows` 的元素类型，抽出来只为让签名短一行）。 */
type pathRow = { dir: string; kind: Kind };

// ---------------------------------------------------------------- B427 · 过滤态

/** 过滤框此刻的取值（`text` 为空 = 常规树）。字段就地改，整只不换（开关与输入共用一个对象）。 */
const filter: FilterOpts = { ...DEFAULT_FILTER };
/** 每一根一段结果；`null` = 还没跑过（框里刚敲下第一下时画「过滤中…」）。 */
let filterSegments:
  { root: string; nodes: FilterNode[]; truncated: boolean; error: string | null }[] | null = null;
/** 过滤态里被收起的目录 / 根。**与 `rootsCollapsed` 分家**：清空过滤不该带走常规树的折叠。 */
const filterCollapsed = new Set<string>();
/** 单飞：后发先至只认最新那一发（与 `search/store.ts` 同口径 —— 慢的那发回来不许盖新结果）。 */
let filterSeq = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
/** 每敲一下都发一次 IPC 太重（实盘整棵扫），攒一小段再发；回车不等，直接发。 */
const FILTER_DEBOUNCE_MS = 180;

/** 设置里那张表的唯一写点：store 是权威，落盘只抄它一份。 */
async function persistRoots(): Promise<void> {
  if (!settings) return;
  settings.folder_roots = getRoots();
  await saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与展开区开合同一口径）
  });
}

/**
 * B424「打开文件夹」= **追加**一根（照 InkNote 的 `addWorkspaceFolders`：append + 去重 + 落盘）。
 *
 * 已经在表里 ⇒ store 返回 false ⇒ 这里什么都不做（不记名单、不落盘：一次没发生的追加
 * 不该把 LRU 顶到最前，也不该白写一次盘）。
 * B332：追加成功就是「用户打开了这个文件夹」⇒ 往最近名单记一条。
 * 启动回放那一路走 `store.setRoots`，不经这一扇 —— 「恢复不算打开」对两类都成立。
 */
export async function addFolder(path: string): Promise<boolean> {
  if (!addRoot(path)) return false;
  noteOpened(path, "folder");
  await persistRoots();
  return true;
}

/**
 * B424：根那一行右键菜单里的「移除目录」。
 *
 * ⚠️ 它**只从名单里摘掉这一根**：已打开的标签一个都不关、文件一个都不删
 * （InkNote 的 `handleRemoveWorkspaceFolder` 与 VS Code「从工作区移除文件夹」同口径 ——
 * 动的是「在哪儿看」，不是「手里有什么」）。也不从「最近打开」里删那条：刚移除的正是
 * 下一次最可能重开的（B331 立的规矩）。
 */
export async function removeFolder(path: string): Promise<void> {
  removeRoot(path);
  rootsCollapsed.delete(normPath(path));
  // 这一根名下那些行可能正被选着（Ctrl 凑组时最容易被拖下水）：树里已经看不见它们了，
  // 不留「选着一条谁也找不到的路径」的幽灵（否则右键还能对着它开出比较）。
  const gone = (p: string): boolean => !rootOf(p);
  picks = picks.filter((p) => !gone(p));
  if (selected && gone(selected)) selected = null;
  anchor = anchor && gone(anchor) ? null : anchor;
  await persistRoots();
}

/** 「打开文件夹…」：系统目录选择器。多选（B424）；取消什么都不做。 */
export async function promptOpenFolder(): Promise<void> {
  if (windowKind === "satellite") return;
  const picked = await openDialog({ directory: true, multiple: true }).catch(() => null);
  const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  let added = false;
  for (const one of list) {
    if (!one) continue;
    if (await addFolder(one)) added = true;
  }
  if (!added) return;
  // VS Code 的口径：选完文件夹就把资源管理器摊开 —— 用户下一步要看的就是它。
  if (activeDrawer() !== "explorer") setDrawer("explorer");
}

/**
 * B331「关闭文件夹」→ B424「**移除全部目录**」（命令 id 与键位覆盖都留着 `file.closeFolder`，
 * 改的只是文案：用户自己配的键不该因为一次改名失效）。
 *
 * 清整张表 + 落盘 + 树回初屏。已开着的标签**一个都不动**，也不从最近名单里删。
 * ⚠️ 子窗口没有左边栏，但 `settings` 是全窗口共用那份盘：不挡住就是「子窗口替主窗口抹根」。
 */
export async function closeFolder(): Promise<void> {
  if (windowKind === "satellite") return;
  setRoots([]);
  rootsCollapsed.clear();
  picks = [];
  anchor = null;
  selected = null;
  await persistRoots();
}

/**
 * B333 · 「拖目录落到资源管理器这一块」= **追加**这些根（B424：不再是换根）。
 *
 * 三条都成立才认领，差一条就交回原来那一路（`io/files` 的 `landDroppedPaths`，那一路会把
 * 拖进来的东西当**文件**打开）：落点在那一块里、拖进来的**全是**盘上真有目录的那几层。
 * 「全是」是刻意的：混着文件时把目录当追加认领、文件那几条却谁也接不住 —— 交回文件那一路
 * 至少行为完整（用户看得见文件被打开，目录那一条自己再拖一次）。
 *
 * 是不是目录要问后端：路径长什么样判不出目录（`报价` 与 `报价.md` 一样没有可扩展的线索），
 * 而盘上有什么只有 Rust 知道。
 *
 * ⚠️ 命中测试做成可注入的一发，因为宿主桥**只回传坐标** —— `tauri://drag-drop` 的载荷形状
 * 不能加字段（那是与原生事件逐字对齐的那条约束，见 `dropbridge.rs` 模块头），而 jsdom
 * 压根没有 `elementFromPoint`。
 */
export async function claimExplorerDrop(
  paths: string[],
  x: number,
  y: number,
  hitAt: (x: number, y: number) => Element | null = elementUnderPoint,
): Promise<boolean> {
  // 子窗口整条左栏都不在，而这里会写 `folder_roots` —— 那等于替主窗口改根名单（同 B331）。
  if (windowKind === "satellite") return false;
  if (!explorerPanel.contains(hitAt(x, y))) return false;
  if (paths.length === 0) return false;
  const kinds = await Promise.all(paths.map((p) => (p ? isDir(p) : Promise.resolve(false))));
  if (kinds.some((d) => !d)) return false;
  let added = false;
  for (const p of paths) {
    if (await addFolder(p)) added = true;
  }
  if (!added) return true; // 全都在表里了：这一次确实没什么可加，但也确实归这一块管
  if (activeDrawer() !== "explorer") setDrawer("explorer");
  return true;
}

/**
 * 拖拽悬停时点亮这一块（B333-2）：外部拖入在页面上没有原生反馈 —— 光标是默认的「可以放」，
 * 而这一块离编辑面板的矩形太远，`spotAt` 算不出落点、什么也不画。松手之前这是唯一看得见的话。
 *
 * ⚠️ 点亮**不按「拖的是不是目录」筛**：拖拽途中前端拿不到可信的类型（路径要过宿主桥换，而桥
 * 只在松手时跑一次）。所以这条亮带说的是「这一格会接住你这一发」——对目录（换根）与对文件
 * （在编辑区打开，这是 B333 之前就有的行为）都成立，不是一句谎话。
 */
export function markExplorerDropHover(
  x: number,
  y: number,
  hitAt: (x: number, y: number) => Element | null = elementUnderPoint,
): void {
  explorerPanel.classList.toggle("is-drop-hover", explorerPanel.contains(hitAt(x, y)));
}

/** 松手 / 拖出窗口 / 拖到别处：亮带必须跟着收，否则会留在屏幕上（同标签插入竖线那一族）。 */
export function clearExplorerDropHover(): void {
  explorerPanel.classList.remove("is-drop-hover");
}

/** 那一点底下的元素。宿主不提供这能力时按「不在这里」算（交回原来那一路）。 */
function elementUnderPoint(x: number, y: number): Element | null {
  return typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
}

export function setupExplorer(): void {
  sideExplorer.innerHTML = CODICONS.files;
  explorerOpen.innerHTML = CODICONS.folderOpened;
  explorerCollapse.innerHTML = CODICONS.collapseAll;
  explorerNewFile.innerHTML = CODICONS.newFile;
  explorerNewDir.innerHTML = CODICONS.newFolder;
  registerDrawerView("explorer", {
    panel: explorerPanel,
    button: sideExplorer,
    onShow: renderTree,
  });
  // B427：盘上变了 ⇒ 常规树重画；**正过滤时再补一发过滤**（命中行跟着新盘面走，
  // 否则刚粘进来的那个文件名在结果里要等下一次敲键才出现）。
  onExplorerChange(() => {
    renderTree();
    if (filterOn()) scheduleFilter();
  });
  // ⚠️ 按钮列那颗的点击**必须在这里挂**：`registerDrawerView` 只管「显隐与亮灭怎么算」，
  //   不接管点击（口径同 `toc.ts` 的 `sideOutline` / `recents/panel.ts` 的 `sideRecent`）。
  //   真机验收抓到过：漏这一句时那颗键看着正常、点下去毫无反应，而用例全是
  //   「程序里调 `setDrawer` 再断言亮灭」，永远照不出来。
  sideExplorer.addEventListener("click", () => toggleExplorer());
  // B424：头部这一排**只有一颗「打开文件夹」**（追加一根）。刷新键从头部搬走了 ——
  // 多根之后「刷新」得有主语，一颗管整排的键要么刷全部（慢、且不是用户点的那一棵），
  // 要么猜哪一棵，都不如把键放回每一根那一行。
  explorerOpen.addEventListener("click", () => void promptOpenFolder());
  explorerCollapse.addEventListener("click", () => collapseAllHere());
  explorerNewFile.addEventListener("click", () => startCreate("file"));
  explorerNewDir.addEventListener("click", () => startCreate("dir"));
  // B427 · 过滤框：输入（攒 180ms）/ 回车（立刻）/ Esc（有字先清、没字放手）/ 五颗开关 / 清除。
  explorerFilterCase.innerHTML = CODICONS.caseSensitive;
  explorerFilterWord.innerHTML = CODICONS.wholeWord;
  explorerFilterRegex.innerHTML = CODICONS.regex;
  explorerFilterExcludes.innerHTML = CODICONS.exclude;
  explorerFilterClear.innerHTML = CODICONS.close;
  explorerFilterInput.value = filter.text;
  syncFilterButtons();
  explorerFilterInput.addEventListener("input", () => {
    filter.text = explorerFilterInput.value;
    syncFilterButtons();
    scheduleFilter();
  });
  explorerFilterInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setFilterText(explorerFilterInput.value);
      return;
    }
    if (e.key !== "Escape") return;
    if (filter.text === "" && explorerFilterInput.value === "") {
      // 没字可清 ⇒ 这一下不归框管：只把焦点交还，别把按键吞掉（外层还有别的 Esc 口径）。
      explorerFilterInput.blur();
      return;
    }
    // 用户点名的「框内 esc 也可清除」：先清字，不回常规树之外的任何一步。
    e.preventDefault();
    e.stopPropagation();
    setFilterText("");
  });
  const toggleOf = (btn: HTMLButtonElement, key: "case" | "word" | "regex" | "excludes"): void => {
    btn.addEventListener("click", () => {
      filter[key] = !filter[key];
      syncFilterButtons();
      scheduleFilter();
    });
  };
  toggleOf(explorerFilterCase, "case");
  toggleOf(explorerFilterWord, "word");
  toggleOf(explorerFilterRegex, "regex");
  toggleOf(explorerFilterExcludes, "excludes");
  explorerFilterClear.addEventListener("click", () => {
    setFilterText("");
    explorerFilterInput.focus();
  });
  explorerTree.addEventListener("click", (e) => onRowClick(e as MouseEvent));
  // 多选之后树的选中态不再只有一条：读屏器要知道 Ctrl / Shift 那两种手势存在。
  explorerTree.setAttribute("aria-multiselectable", "true");
  explorerTree.addEventListener("contextmenu", (e) => onRowContext(e as MouseEvent));
  // B316：拖到别的那一层 = 移动。五个事件都挂在树上（行是重绘出来的，逐行挂必漏）。
  explorerTree.addEventListener("dragstart", (e) => onRowDragStart(e as DragEvent));
  explorerTree.addEventListener("dragover", (e) => onRowDragOver(e as DragEvent));
  explorerTree.addEventListener("dragleave", (e) => onRowDragLeave(e as DragEvent));
  explorerTree.addEventListener("drop", (e) => onRowDrop(e as DragEvent));
  explorerTree.addEventListener("dragend", () => endDrag());
  explorerTree.addEventListener("keydown", (e) => onTreeKey(e));
  renderTree();
}

/** 摊开 / 收起这一块的入口（命令面板 / 快捷键那一路也走这里）。 */
export function toggleExplorer(): void {
  if (windowKind === "satellite") return;
  if (activeDrawer() === "explorer") {
    setDrawer(null);
    return;
  }
  setDrawer("explorer");
}

// ---------------------------------------------------------------- 渲染

/** 名字那一格。**一律 textContent**：文件名里可以有 `<`、`&`，拼 innerHTML 就是给自己造注入点
 *  （口径同 recents/panel.ts 的 `rowOf`）。 */
function nameSpan(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "explorer-name";
  span.textContent = text;
  return span;
}

/**
 * B373 · 缩进引导线（VS Code `.monaco-tl-indent`）：每行自己带一列绝对定位的线，
 * 左沿固定 16px、每层一根 8px，只画**祖先**那几根（depth-1 根）—— 顶层的行没有线。
 * 每根线记着它对应哪位祖先，选中变化时只换颜色，不必重画整棵树（`paintActiveGuides`）。
 */
function guideColumn(path: string | null, depth: number): HTMLElement | null {
  if (depth <= 1) return null;
  const ancestors = path ? ancestorPaths(path) : [];
  const active = activeGuidePaths();
  const box = document.createElement("span");
  box.className = "explorer-indent";
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < depth - 1; i++) {
    const line = document.createElement("span");
    line.className = "explorer-guide";
    const owner = ancestors[i];
    if (owner) {
      line.dataset.guideFor = owner;
      if (active.has(owner)) line.classList.add("is-active");
    }
    box.append(line);
  }
  return box;
}

/**
 * 这一条是不是**某一根**那一行（不是树里的普通目录）。多根之下「是不是根」不能问 `rows`
 * 里有没有（根压根不进那张表，文件改名前也可能不在），要问名单。
 */
function isRootPath(path: string): boolean {
  if (!path) return false;
  const key = normPath(path);
  return getRoots().some((r) => normPath(r) === key);
}

/** 根那一行收没收起（`rootsCollapsed` 是黑名单 ⇒ 默认摊开）。 */
function isRootCollapsed(path: string): boolean {
  return rootsCollapsed.has(normPath(path));
}

/**
 * 这一行此刻收着还是开着。**两处态不同源**（根行走 `rootsCollapsed`、树里的目录走
 * store 的 `expanded`），所以判据只许有这一处 —— 键盘、悬停展开、`aria-expanded`
 * 三处各写一遍 ternary，迟早有一处忘了算根行（那正是 B224 那条教训的形状）。
 */
function isCollapsed(path: string): boolean {
  // B427：过滤态里展开态读 `filterCollapsed`（根与普通目录同一份集合）。键盘、悬停展开、
  // `aria-expanded` 三处读的仍是这一处判据 —— 别在别处再写一遍三元。
  if (filterOn()) return filterCollapsed.has(normPath(path));
  return isRootPath(path) ? isRootCollapsed(path) : !isExpanded(path);
}

/** 从这一行往顶层数到根之前（不含根）：顺序 = 左→右，正好对上 VS Code 的祖先线列。 */
function ancestorPaths(path: string): string[] {
  const chain: string[] = [];
  let cur = rows.get(path)?.dir;
  while (cur && !isRootPath(cur)) {
    chain.unshift(cur);
    cur = rows.get(cur)?.dir;
  }
  return chain;
}

/**
 * VS Code 的「活动引导线」：焦点那条若是展开的目录就亮它自己（给它的孩子看），
 * 否则亮它父亲。这里没有焦点概念，用选中的那一行对齐同一口径。
 */
function activeGuidePaths(): Set<string> {
  const out = new Set<string>();
  if (!selected) return out;
  const r = rows.get(selected);
  if (!r) return out; // 选中的是根那一行
  out.add(r.kind === "dir" && !isCollapsed(selected) ? selected : r.dir);
  return out;
}

/** 选中变了只换线的颜色（重画整棵树会丢焦点）；新建 / 改名 / 展开那几条重画路径直接带上态。 */
function paintActiveGuides(): void {
  const active = activeGuidePaths();
  for (const line of explorerTree.querySelectorAll<HTMLElement>(".explorer-guide")) {
    const owner = line.dataset.guideFor;
    line.classList.toggle("is-active", !!owner && active.has(owner));
  }
}

function note(text: string, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "explorer-note";
  row.style.setProperty("--depth", String(depth));
  const guide = guideColumn(null, depth);
  if (guide) row.append(guide);
  row.append(text);
  return row;
}

/** 改名用的输入框：预填当前名字、默认只选中**主名**（扩展名留着，与 VS Code 一致）。 */
function renameInput(e: FsEntry): HTMLElement {
  const input = document.createElement("input");
  input.className = "explorer-input";
  input.type = "text";
  input.value = e.name;
  input.setAttribute("aria-label", `重命名 ${e.name}（回车确认，Esc 取消）`);
  const dot = e.name.lastIndexOf(".");
  queueMicrotask(() => {
    input.focus();
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
  input.addEventListener("keydown", (ev) => {
    const k = (ev as KeyboardEvent).key;
    if (k === "Enter") {
      ev.preventDefault();
      void commitRename(input.value);
    } else if (k === "Escape") {
      ev.preventDefault();
      renaming = null;
      renderTree();
    }
  });
  // blur 也提交：口径与 `inputRow` 一致（点空白处之后回来看见名字没改，用户读作 bug）
  input.addEventListener("blur", () => {
    if (renaming) void commitRename(input.value);
  });
  return input;
}

function inputRow(kind: Kind, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "explorer-row is-creating";
  row.style.setProperty("--depth", String(depth));
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  const input = document.createElement("input");
  input.className = "explorer-input";
  input.type = "text";
  input.setAttribute(
    "aria-label",
    kind === "dir" ? "新目录名（回车确认，Esc 取消）" : "新文件名（回车确认，Esc 取消）",
  );
  input.placeholder = kind === "dir" ? "目录名" : "文件名.md";
  // ⚠️ `blur` 也提交：VS Code 是这样，而且用户点空白处之后回来看见名字没了会以为是 bug。
  // 空名字不提交（那是取消，不是「建一个没有名字的」）。
  input.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter") {
      e.preventDefault();
      void commitCreate(input.value);
    } else if (k === "Escape") {
      e.preventDefault();
      creating = null;
      renderTree();
    }
  });
  input.addEventListener("blur", () => {
    if (creating) void commitCreate(input.value);
  });
  // B373：输入框落在**它将成为的那一层**，并占与同层行相同的那一格 22px ——
  // 文件用 Seti 缺省字形（打字时看得出是文件），目录只留箭头槽（Seti 不画文件夹图标）。
  const parts: HTMLElement[] = [];
  const guide = guideColumn(null, depth);
  if (guide) parts.push(guide);
  const slot = document.createElement("span");
  slot.className = kind === "file" ? "explorer-glyph" : "explorer-twisty";
  if (kind === "file") slot.innerHTML = fileIconHtml(null);
  parts.push(slot, input);
  row.append(...parts);
  queueMicrotask(() => input.focus());
  return row;
}

/** 一个目录节点之下该画的东西：输入框 / 读取中 / 错误 / 空 / 子项。 */
function renderChildren(host: HTMLElement, dir: string, depth: number): void {
  // 输入框长在该层最前，但**不取代**这一层的内容：以前这里直接 return，
  // 结果一按「新建」整层条目就消失，用户读作「文件被删了」。
  const creatingHere = creating && creating.dir === dir ? creating : null;
  if (creatingHere) host.append(inputRow(creatingHere.kind, depth));
  const kids = childrenOf(dir);
  if (isLoading(dir)) {
    host.append(note("读取中…", depth));
    return;
  }
  if (!kids) {
    const err = errorOf(dir);
    host.append(note(err ? `读不了：${err}` : "（未读取）", depth));
    return;
  }
  if (kids.length === 0) {
    // 已经在写名字的那一层不必再挂「（空）」
    if (!creatingHere) host.append(note("（空）", depth));
    return;
  }
  for (const e of kids) host.append(renderEntry(e, dir, depth));
}

/**
 * 画一行（缩进 / 箭头 / 图标 / 名字 / 提示都在这里）—— 常规树与过滤结果**共用这一份**。
 * 两处各画一遍的话，箭头与图标槽的几何迟早分家（B304 那一族的教训）。
 * 要不要再包一层 children 容器由调用方决定（过滤结果是拍平的，没有那一层）。
 */
function rowOf(
  path: string,
  name: string,
  kind: Kind,
  depth: number,
  dir: string,
  open: boolean,
  nameEl: HTMLElement,
): HTMLElement {
  rows.set(path, { dir, kind });
  visible.push(path);
  const row = document.createElement("div");
  row.className = "explorer-row";
  row.dataset.path = path;
  row.dataset.kind = kind;
  row.style.setProperty("--depth", String(depth));
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.setAttribute("aria-selected", String(picks.includes(path)));
  if (kind === "dir") row.setAttribute("aria-expanded", String(open));
  row.tabIndex = selected === path ? 0 : -1;
  // B316：树里每一行都可拖（根那一行不可 —— 它没有父亲，拖出去无处可放）。
  row.draggable = true;
  // 完整路径进自绘提示层（B350）：原先写原生 `title`，深色界面里会弹一枚不吃主题、
  // 延迟口径也不一样的系统气泡。档位与标签 / 大纲 / 最近打开同一档（setTextTip）——
  // 气泡压在鼠标下方，会盖住下面一两行，这与最近打开那排密行是同一种遮挡，可接受。
  setTextTip(row, path, { group: "explorer" });

  // B373：文件行**不再留空箭头槽**（VS Code 的非可折叠行 twistie 宽 0，Seti 图标从内容
  // 起点开始）—— 图标槽本身吃掉 22px，文件名才和同层的目录名从同一 x 起排。
  // 目录行仍只有箭头 + 名字：Seti 主题不定义文件夹图标（B370 的口径）。
  const parts: HTMLElement[] = [];
  const guide = guideColumn(path, depth);
  if (guide) parts.push(guide);
  const slot = document.createElement("span");
  slot.className = kind === "dir" ? "explorer-twisty" : "explorer-glyph";
  if (kind === "dir") slot.innerHTML = open ? CODICONS.chevronDown : CODICONS.chevronRight;
  else slot.innerHTML = fileIconHtml(detectLanguage(name).label);
  parts.push(slot, nameEl);
  row.append(...parts);
  return row;
}

function renderEntry(e: FsEntry, dir: string, depth: number): HTMLElement {
  const kind: Kind = e.isDir ? "dir" : "file";
  const open = kind === "dir" && isExpanded(e.path);
  const row = rowOf(
    e.path,
    e.name,
    kind,
    depth,
    dir,
    open,
    renaming?.path === e.path ? renameInput(e) : nameSpan(e.name),
  );

  if (kind === "dir") {
    const kids = document.createElement("div");
    kids.className = "explorer-children";
    kids.hidden = !open;
    if (open) renderChildren(kids, e.path, depth + 1);
    const wrap = document.createElement("div");
    wrap.className = "explorer-node";
    wrap.append(row, kids);
    return wrap;
  }
  return row;
}

/** 过滤结果的一行：与常规行同一份几何；展开态读 `filterCollapsed`（不碰 store 的展开缓存）。 */
function filterRow(n: FilterNode): HTMLElement {
  const kind: Kind = n.isDir ? "dir" : "file";
  const open = kind === "dir" && !filterCollapsed.has(normPath(n.path));
  const nameEl =
    renaming?.path === n.path
      ? renameInput({ name: n.name, path: n.path, isDir: n.isDir, size: 0, mtimeMs: 0 })
      : nameSpan(n.name);
  return rowOf(n.path, n.name, kind, n.depth, n.dir, open, nameEl);
}

// ---------------------------------------------------------------- B427 · 过滤

/** 框里算不算「在过滤」—— 空串 / 纯空白都回到常规树。 */
function filterOn(): boolean {
  return filterActive(filter);
}

/** 命中树里所有「可折的层」：带子项的目录（各根的根行不在内 —— 全折不碰根行）。 */
function filterDirPaths(): string[] {
  const out: string[] = [];
  for (const seg of filterSegments ?? []) {
    const nodes = seg.nodes;
    for (let i = 0; i < nodes.length; i++) {
      // 树序是 DFS ⇒ 「下一行比它深」就是这个目录下面还有东西
      if (nodes[i].isDir && nodes[i + 1] && nodes[i + 1].depth > nodes[i].depth) {
        out.push(normPath(nodes[i].path));
      }
    }
  }
  return out;
}

/** 顶部那颗键与菜单那一项共用的现状：可折的目录有哪些、是不是已经全收着。 */
function foldState(): { dirs: string[]; folded: boolean } {
  const dirs = filterOn() ? filterDirPaths() : [];
  return { dirs, folded: dirs.length > 0 && dirs.every((p) => filterCollapsed.has(p)) };
}

/**
 * 头部那颗折叠键当下该说哪句话（B428，用户点名：「过滤后顶部折叠展开要能对过滤后
 * 文件/目录进行折叠展开」）。
 *
 * · 常规树：永远是「全部折叠」、永远可点（没根时整排键由 `.no-root` 收起）；
 * · 过滤态：主语换成**命中树**；命中里一个可折的目录都没有时**禁用** ——
 *   不做「按下去没反应」的死键。收放只动 `filterCollapsed` 那一册，常规树的
 *   展开缓存（store 的 `expanded`）不归它管，也不许被它改。
 * 图标 / 文案 / aria-pressed 一起翻（口径同 `toc.ts` 的 `refreshTocToggleAll`）。
 */
function syncCollapseButton(): void {
  const { dirs, folded } = foldState();
  explorerCollapse.disabled = filterOn() && dirs.length === 0;
  explorerCollapse.innerHTML = folded ? CODICONS.expandAll : CODICONS.collapseAll;
  const label = folded ? "全部展开" : "全部折叠";
  explorerCollapse.setAttribute("aria-label", label);
  explorerCollapse.setAttribute("aria-pressed", String(folded));
  setTip(explorerCollapse, label, { group: "explorer" });
}

/** 四颗开关的亮灭 + 清除键的显隐（一处写；点哪颗都先走这里再重跑）。 */
function syncFilterButtons(): void {
  const set = (b: HTMLButtonElement, on: boolean): void => {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  };
  set(explorerFilterCase, filter.case);
  set(explorerFilterWord, filter.word);
  set(explorerFilterRegex, filter.regex);
  set(explorerFilterExcludes, filter.excludes);
  explorerFilterClear.hidden = filter.text === "";
}

/** 写框里的值并**立刻**重跑（清除键与 Esc 走这条：不攒那 180ms）。 */
function setFilterText(text: string): void {
  filter.text = text;
  explorerFilterInput.value = text;
  syncFilterButtons();
  if (filterTimer !== undefined) {
    clearTimeout(filterTimer);
    filterTimer = undefined;
  }
  void runFilter();
}

/** 敲字那一路：攒一小段再发（实盘整棵扫，一发一敲太重）。 */
function scheduleFilter(): void {
  if (filterTimer !== undefined) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterTimer = undefined;
    void runFilter();
  }, FILTER_DEBOUNCE_MS);
}

/** 扇出到每一根；`seq` 落后就整发作废（慢的那发回来时用户已经又敲过字了）。 */
async function runFilter(): Promise<void> {
  const text = filter.text.trim();
  const seq = ++filterSeq;
  const roots = getRoots();
  if (!text || roots.length === 0) {
    filterSegments = null;
    filterCollapsed.clear();
    renderTree();
    return;
  }
  const one = async (root: string) => {
    try {
      const scan = await filterTree(root, text, {
        caseSensitive: filter.case,
        wholeWord: filter.word,
        regex: filter.regex,
        // 与侧栏搜索同一发口径：总闸关着 = 设置里那串持久排除也不吃
        // （`search/store.ts` 的 `mergeGlobs(useExcludes ? … : "")` 是同一句）。
        exclude: filter.excludes ? (settings?.search_exclude ?? "") : "",
        useExcludes: filter.excludes,
        // B428（用户点名）：那颗键的文案本来就是「使用排除设置**与忽略文件**」——
        // 忽略文件跟随同一颗总闸，不再有旁边那颗独立的「跟随 .gitignore / .ignore」。
        useIgnoreFiles: filter.excludes,
      });
      return { root, nodes: treeOf(root, scan.hits), truncated: scan.truncated, error: null };
    } catch (e) {
      // 正则写坏了是这里最常见的错：原话照给用户（Rust 那句「正则无效：…」），
      // 不吞成一句「过滤失败」—— 错误话术要能读。
      return {
        root,
        nodes: [] as FilterNode[],
        truncated: false,
        error: String(e).replace(/^Error: /, ""),
      };
    }
  };
  const segs = await Promise.all(roots.map(one));
  if (seq !== filterSeq) return;
  filterSegments = segs;
  renderTree();
}

/** 过滤态的整棵树：每一根一行（与常规树同形）+ 它那段拍平的命中行。 */
function renderFilterBody(): void {
  const segs = filterSegments;
  for (const root of getRoots()) {
    const open = !filterCollapsed.has(normPath(root));
    visible.push(root);
    explorerTree.append(rootRow(root, open));
    if (!open) continue;
    const seg = segs?.find((s) => normPath(s.root) === normPath(root));
    if (!seg) {
      explorerTree.append(note("过滤中…", 1));
      continue;
    }
    if (seg.error) {
      explorerTree.append(note(`过滤失败：${seg.error}`, 1));
      continue;
    }
    if (seg.nodes.length === 0) {
      explorerTree.append(note("没有匹配的名字", 1));
      continue;
    }
    for (const n of visibleOf(seg.nodes, filterCollapsed)) explorerTree.append(filterRow(n));
    if (seg.truncated) explorerTree.append(note("只显示前 1000 条（把查询写细一点）", 1));
  }
}

/**
 * 重画整棵树 = 画 + 把头部那颗折叠键的说法跟着翻新。**只走这一个入口** ——
 * 调用点三十来处，谁都不必记得补第二发；漏一处的表现是「键上的字跟实际状态对不上」。
 */
function renderTree(): void {
  paintTree();
  syncCollapseButton();
}

function paintTree(): void {
  rows.clear();
  visible = [];
  explorerTree.replaceChildren();
  const roots = getRoots();
  if (roots.length === 0) {
    explorerTitle.textContent = "资源管理器";
    // B317（用户点名）：没有根时头部那一排键没一颗用得上 —— 新建 / 全部折叠都要先有
    // 一棵树，而「打开文件夹」下面那颗大按钮就是它自己的出口。整排收起，标题独占那一行。
    explorerPanel.classList.add("no-root");
    explorerTree.append(note("还没有打开文件夹", 0), openHintRow());
    return;
  }
  explorerPanel.classList.remove("no-root");
  explorerTitle.textContent = "资源管理器";
  // B427：框里有字 ⇒ 画过滤结果（同一棵树的壳，内容换成合成出来的命中树）。
  if (filterOn()) {
    renderFilterBody();
    if (dragging) paintMarks();
    return;
  }
  // B424：**每一根一段**（根行 + 它的子层容器），顺序 = 名单顺序 = 屏幕从上到下。
  for (const root of roots) {
    const open = !isRootCollapsed(root);
    visible.push(root);
    explorerTree.append(rootRow(root, open), rootChildren(root, open));
  }
  // 拖拽途中被悬停展开打断过一次重绘：那两层高亮贴在的是**刚被丢掉**的旧元素上，得按路径重贴。
  if (dragging) paintMarks();
}

/** 根行里那颗自带刷新键（B424：刷新从头部搬进来，每根一颗）。 */
function rootRefreshBtn(root: string): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toc-head-btn explorer-root-refresh";
  btn.innerHTML = CODICONS.refresh;
  btn.setAttribute("aria-label", "刷新该文件夹");
  setTip(btn, "刷新", { group: "explorer" });
  btn.addEventListener("click", () => void refreshRoot(root));
  return btn;
}

/** 某一根的那一行：箭头 + 名字 + 刷新键（B370：根行与目录行同口径，不挂文件夹图标）。 */
function rootRow(root: string, open: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "explorer-root";
  el.dataset.path = root;
  el.dataset.kind = "dir";
  el.setAttribute("role", "treeitem");
  el.setAttribute("aria-expanded", String(open));
  el.setAttribute("aria-selected", String(picks.includes(root)));
  el.setAttribute("aria-level", "1");
  setTextTip(el, root, { group: "explorer" });
  el.tabIndex = selected === root || visible.length <= 1 ? 0 : -1;
  const rt = document.createElement("span");
  rt.className = "explorer-twisty";
  rt.innerHTML = open ? CODICONS.chevronDown : CODICONS.chevronRight;
  const rn = document.createElement("span");
  rn.className = "explorer-name";
  rn.textContent = nameOf(root);
  el.append(rt, rn, rootRefreshBtn(root));
  return el;
}

/** 某一根的子层容器。收起时整块 `hidden`（CSS 那条 `.explorer-children[hidden]` 兜底）。 */
function rootChildren(root: string, open: boolean): HTMLElement {
  const kids = document.createElement("div");
  kids.className = "explorer-children";
  kids.hidden = !open;
  if (open) renderChildren(kids, root, 1);
  return kids;
}

/** 没有根那一行时给的出口：一句提示 + 一颗「打开文件夹」的入口（不让人对着空白版发呆）。 */
function openHintRow(): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "explorer-hint-btn";
  btn.type = "button";
  btn.innerHTML = CODICONS.folderOpened;
  const label = document.createElement("span");
  label.textContent = "打开文件夹";
  btn.append(label);
  btn.addEventListener("click", () => void promptOpenFolder());
  const wrap = document.createElement("div");
  wrap.className = "explorer-hint";
  wrap.append(btn);
  return wrap;
}

/** 绝对路径的最后一段（只用于显示根的名字；父目录一律从 `rows` 里查，不做字符串手术）。 */
function nameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

// ---------------------------------------------------------------- 交互

function rowFromEvent(ev: Event): HTMLElement | null {
  const t = ev.target as HTMLElement | null;
  if (!t) return null;
  return t.closest<HTMLElement>(".explorer-row, .explorer-root");
}

function onRowClick(ev: MouseEvent): void {
  // B424：根那一行里挂着它自己的刷新键，而整棵树是**委托**点击 —— 不挡掉的话一发点击
  // 会同时刷这一根 + 把根行折叠/展开一遍（`activateDir` 当场 renderTree，键还会被重建）。
  if ((ev.target as HTMLElement | null)?.closest("button")) return;
  const row = rowFromEvent(ev);
  if (!row) {
    // 点空白 = 清干净选中（VS Code 的 list 同口径）。后来右键还对着一条「已选中」的
    // 幽灵路径动手，正是这条手势要防的事。
    clearSelection();
    return;
  }
  const path = row.dataset.path ?? "";
  if (!path) return;
  const additive = ev.ctrlKey || ev.metaKey;
  const range = ev.shiftKey;
  if (range) extendSelection(path);
  else if (additive) togglePick(path);
  else select(path);
  // 多选手势只改选中，不展开、不打开：Ctrl / Shift 那两下是「凑一组」，不是「打开这一条」。
  // 与 VS Code 的 list 一致（选中数不为 1 时资源管理器也不会顺手预览）。
  if (additive || range) return;
  if (row.dataset.kind === "dir") void activateDir(path);
  else void doOpen(path);
}

async function activateDir(path: string): Promise<void> {
  // B427：过滤态里的开合是**纯视图**的（命中树已经全在手里，不读盘、不碰 store 的展开缓存）。
  if (filterOn()) {
    const key = normPath(path);
    if (filterCollapsed.has(key)) filterCollapsed.delete(key);
    else filterCollapsed.add(key);
    renderTree();
    return;
  }
  if (isRootPath(path)) {
    // 根那一行的开合只动 `rootsCollapsed` 这一份黑名单，不碰 store 的 `expanded`：
    // 「全部折叠」清的是后者，根行必须留着（否则整块像被清空了）。
    const key = normPath(path);
    if (rootsCollapsed.has(key)) rootsCollapsed.delete(key);
    else rootsCollapsed.add(key);
    renderTree();
    return;
  }
  await toggleDir(path);
}

/**
 * 普通点击（或程序里指定「就选这一条」）：选中收成一条，锚点跟着落到它。
 * 只重画选中态与 roving tabindex，不整棵树重绘（选中的代价不该是重读盘）。
 */
function select(path: string | null): void {
  picks = path ? [path] : [];
  anchor = path;
  selected = path;
  paintSelection();
}

/** Ctrl+点击：切换这一条的入组状态，焦点与锚点都落到这一条（VS Code 的 list 同形）。 */
function togglePick(path: string): void {
  picks = picks.includes(path) ? picks.filter((p) => p !== path) : [...picks, path];
  anchor = path;
  selected = path;
  paintSelection();
}

/**
 * Shift+点击：从锚点到这一条的那一段（含两端，按**屏幕上的可见顺序**）当选中。
 * 锚点缺失（比如刚清空过）时退化成单选 —— 没有起点就没有区间。
 */
function extendSelection(path: string): void {
  const start = anchor ? visible.indexOf(anchor) : -1;
  const end = visible.indexOf(path);
  if (start < 0 || end < 0) {
    select(path);
    return;
  }
  const [a, b] = start <= end ? [start, end] : [end, start];
  picks = visible.slice(a, b + 1);
  selected = path;
  paintSelection();
}

/** 点空白：选中与锚点一起清掉（焦点也放开，否则下一发菜单还对着一条看不见的行）。 */
function clearSelection(): void {
  picks = [];
  anchor = null;
  selected = null;
  paintSelection();
}

/**
 * 这一条是不是选中的（渲染与增量重画共用这一颗判据）。
 * 根那一行也走 `picks` —— 它同样能被 Ctrl / Shift 选进组里。
 */
function isPicked(path: string): boolean {
  return picks.includes(path);
}

/**
 * 只换选中态与 roving tabindex（不重绘树）。`selected` 是焦点行：它可以在选之外
 * （Ctrl 点掉一条后焦点仍留在那一行），没有焦点时退到第一条可见行，树总得有个 tab 停靠点。
 */
function paintSelection(): void {
  const tabStop = selected ?? visible[0] ?? null;
  for (const el of explorerTree.querySelectorAll<HTMLElement>("[data-path]")) {
    const path = el.dataset.path ?? "";
    el.setAttribute("aria-selected", String(isPicked(path)));
    el.tabIndex = path === tabStop ? 0 : -1;
  }
  paintActiveGuides();
}

/** 路径或它的子孙都在这一批里去掉（删目录时不能留下它名下那些「幽灵选中」）。 */
function dropPicks(path: string): void {
  const key = normPath(path);
  picks = picks.filter((p) => {
    const k = normPath(p);
    return !(k === key || k.startsWith(`${key}\\`));
  });
}

/** 改名 / 移动之后选中态跟着走到新路径（子孙一并换，目录改名才有整串可跟）。 */
function replacePick(from: string, to: string): void {
  const key = normPath(from);
  picks = picks.map((p) => {
    const k = normPath(p);
    if (k === key) return to;
    return k.startsWith(`${key}\\`) ? to + p.slice(from.length) : p;
  });
}

/** 按路径找那一行的元素。不写 `querySelector("[data-path=\"…\"]")`：Windows 路径里的 `\`
 *  与 `:` 得先过一层 CSS 转义，而转义写错的代价是「键盘一动就选不中」这种难查的假象。 */
function rowEl(path: string): HTMLElement | null {
  for (const el of explorerTree.querySelectorAll<HTMLElement>("[data-path]")) {
    if (el.dataset.path === path) return el;
  }
  return null;
}

/**
 * 键盘：上下在**可见行**之间移动，左右 = 折叠 / 展开，回车 = 执行（目录开合、文件打开）。
 * `visible` 是渲染那一份顺序，与屏幕一致 ⇒ 不需要再遍历 DOM 猜谁在谁前面。
 */
function onTreeKey(ev: KeyboardEvent): void {
  // 输入框里的按键**不属于树**：回车是提交、左右是移光标。少了这道闸，回车的冒泡会同时
  // 走到下面「回车 = 打开这一行」，而那行的 `data-path` 还是空的 ⇒ doOpen("") 发一次空路径。
  const from = ev.target as HTMLElement | null;
  if (from && (from.tagName === "INPUT" || from.closest(".explorer-row.is-creating"))) return;
  const row = rowFromEvent(ev);
  const cur = row?.dataset.path ?? "";
  if (!cur) return;
  const i = visible.indexOf(cur);
  const move = (delta: number): void => {
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + delta))];
    if (!next) return;
    // Shift+上下 = 从锚点连选到新焦点（与鼠标那一手同一份区间算法）。
    if (ev.shiftKey) extendSelection(next);
    else select(next);
    rowEl(next)?.focus();
  };
  switch (ev.key) {
    case "ArrowDown":
      ev.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      ev.preventDefault();
      move(-1);
      break;
    case "ArrowRight":
      ev.preventDefault();
      if (row?.dataset.kind === "dir" && isCollapsed(cur)) void activateDir(cur);
      break;
    case "ArrowLeft":
      ev.preventDefault();
      if (isRootPath(cur)) {
        // 根那一行：收起 ⇒ 展开它；已经收着 ⇒ 就地不动（它没有父亲可以跳）。
        if (!isRootCollapsed(cur)) void activateDir(cur);
        return;
      }
      if (row?.dataset.kind === "dir" && !isCollapsed(cur)) void activateDir(cur);
      else {
        const parent = rows.get(cur)?.dir;
        if (parent) select(parent);
      }
      break;
    case "Enter":
    case " ":
      ev.preventDefault();
      if (row?.dataset.kind === "dir") void activateDir(cur);
      else if (row) void doOpen(cur);
      break;
    case "F2":
    case "Delete":
    case "c":
    case "x":
    case "v": {
      // 键盘那一路的动作都问「选中了谁」，所以先把焦点那一条变成选中那一条 ——
      // 用 Tab 键走进树时 `selected` 还可能是上一回点中的另一行。
      const wantClip = ev.key === "c" || ev.key === "x" || ev.key === "v";
      if (wantClip && (ev.altKey || ev.metaKey || !ev.ctrlKey)) break;
      ev.preventDefault();
      select(cur);
      const onRoot = isRootPath(cur);
      if (ev.key === "F2" && !onRoot) startRename(cur);
      else if (ev.key === "Delete" && !onRoot) void doDelete();
      else if (ev.key === "v") void doPaste();
      else if (!onRoot) void doClip(ev.key === "x");
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- 新建

/**
 * 该动手的那一层：选中的是目录就用它；是文件用它的父亲；选中的是**某一根那一行**就用那根；
 * 什么都没选用**第一根**（B424 多根：总得有个主语，而「第一根」是屏幕上最上面那一棵，
 * 用户看得见，不是凭空挑的）。
 * 「新建文件 / 新建目录 / 粘贴」三条共用这一份判据 —— 两条各算一遍目标，
 * 迟早会出现「新建落在这层、粘贴落在那层」那种没人解释得清的分裂。
 */
function targetDir(): string | null {
  const list = getRoots();
  if (list.length === 0) return null;
  if (!selected) return list[0];
  const r = rows.get(selected);
  if (r) return r.kind === "dir" ? selected : r.dir;
  if (isRootPath(selected)) return selected;
  // 父子表里查不到、又不是某一根那一行 ⇒ 选中的那一条已经不在树上（被删/被挪走，或正撞上
  // 后台刷新那一帧）：退到它归属的那一根，再退到第一根 —— 既不许把文件路径当目录，
  // 也不许对着空串发一次 IPC。
  return rootOf(selected) ?? list[0];
}

function startCreate(kind: Kind): void {
  const dir = targetDir();
  if (!dir) {
    showMessage("还没有打开文件夹");
    return;
  }
  creating = { dir, kind };
  // 目标没展开的话先展开：输入框画在看不见的一层里等于没反应。
  // 两种「看不见」分开治：根那一行收起 ⇒ 只清黑名单（不碰 store）；树里的目录 ⇒ 走 toggleDir
  // （它才负责读那一层，输入框要有数据可画）。
  if (isRootCollapsed(dir)) {
    rootsCollapsed.delete(normPath(dir));
    renderTree();
  } else if (!isRootPath(dir) && !isExpanded(dir)) {
    void toggleDir(dir).then(() => renderTree());
    renderTree();
  } else renderTree();
}

async function commitCreate(raw: string): Promise<void> {
  const plan = creating;
  creating = null;
  if (!plan) return;
  const name = raw.trim();
  if (!name) {
    renderTree();
    return;
  }
  try {
    const made =
      plan.kind === "dir" ? await createDir(plan.dir, name) : await createFile(plan.dir, name);
    selected = made.path;
    picks = [made.path];
    anchor = made.path;
    await refreshDir(plan.dir);
    showMessage(plan.kind === "dir" ? `已创建 ${name}\\` : `已创建 ${name}`);
    // 建完就地选中，顺手把新建的文件打开 —— 用户的下一步十有八九是写它。
    if (plan.kind === "file") void doOpen(made.path);
  } catch (e: unknown) {
    renderTree();
    // Rust 那句校验的话直接给用户（「名字里不能有 / \\ …」），不再包一层「失败了」。
    showMessage(String(e), true);
  }
}

// ---------------------------------------------------------------- B315 · 右键菜单与常规操作

/**
 * 剪贴板里的一条要带上它**当下所在那一层**：缓存层不做路径手术（`rows` 这份父子表
 * 只在这里有），所以「父亲」由面板算好再交出去。
 *
 * 根那一行不进剪贴板（它就是整棵树，复制它等于要求「粘贴一个自己」）。
 * ⚠️ 父亲查不到时**不许把这一次操作悄悄吞掉**：后台刷新（`读取中…` 那一帧）会让树只画
 * 一句提示、`rows` 暂时空着 —— 这时候右键到点菜单那一发之间的竞态是常规手感，不是野路径。
 * 兜底交归属的那一根（`dir` 只用于「动完盘刷哪一层」，刷错一层顶多多读一次盘；不发那一发
 * 才是用户看得见的 bug）。
 */
function clipItem(path: string): ClipItem | null {
  if (!path || isRootPath(path)) return null;
  return { path, dir: rows.get(path)?.dir ?? rootOf(path) ?? "" };
}

function onRowContext(ev: MouseEvent): void {
  ev.preventDefault();
  if (windowKind === "satellite") return;
  // 按钮上右键不许弹那一行的菜单：菜单问的是「选中了谁」，而右键这颗键的人要的是这颗键
  if ((ev.target as HTMLElement | null)?.closest("button")) return;
  const row = rowFromEvent(ev);
  const path = row?.dataset.path ?? "";
  // 先选中再弹菜单：菜单里那几项问的全是「选中了谁」，不选就会对着上一行的目标动手。
  // 多选已成组时右键组内的一条**不许把组打散**（VS Code 同口径）—— 否则「将已选择进行比较」
  // 永远等不到那一发右键；焦点仍落到被右键的那一条（新建 / 粘贴的主语）。
  if (path) {
    if (picks.length > 1 && isPicked(path)) {
      selected = path;
      paintSelection();
    } else select(path);
  }
  showPopupMenu(null, menuFor(path), { x: ev.clientX, y: ev.clientY });
}

/**
 * 多选里**文件**那几条（按选中顺序）。比较只对文件成立：目录没有正文可比。
 * 用 `rows` 判种类而不是路径长相 —— 「是不是目录」只有盘上那份事实说了算。
 */
function pickedFiles(): string[] {
  return picks.filter((p) => rows.get(p)?.kind === "file");
}

/**
 * 菜单条目。三条路各有各的主语（B424 多根之后不能再拿「根」当唯一主语）：
 *
 * · 没有根 ⇒ 只有「打开文件夹」这一颗出口；
 * · 空白处 ⇒ 说的是**这一块**（打开 / 移除全部 / 全部折叠）；
 * · 根那一行 ⇒ 新建、粘贴、复制路径、**刷新这一根**、**移除这一根**、全部折叠；
 * · 树里的目录或文件 ⇒ 全套动作（改名 / 复制 / 剪切 / 粘贴 / 删除）。
 *
 * 根那一行**不参与**改名 / 复制 / 剪切 / 删除 —— 那是整棵树，删了它面板就空了；
 * 但它现在有了自己的两条：刷新与移除（`移除目录` 只动名单，标签一个不关）。
 */
function menuFor(path: string): MenuItem[] {
  if (!hasRoot()) return [{ label: "打开文件夹", onSelect: () => void promptOpenFolder() }];
  if (!path) return blankMenu();
  const isRoot = isRootPath(path);
  const kind: Kind = rows.get(path)?.kind ?? "dir";
  const clip = getClipboard();
  const dest = targetDir();
  const out: MenuItem[] = [];
  const push = (...items: MenuItem[]): void => {
    const last = out[out.length - 1];
    const first = items[0];
    // 分组整组缺席时不留孤零零的分隔线（口径同 tabstrip 的 fillMenu）
    if (out.length && first && !first.separator && !last?.separator) out.push({ separator: true });
    out.push(...items);
  };

  if (!isRoot && kind === "file") {
    push({ label: "打开", onSelect: () => void doOpen(path) });
  }
  push(
    { label: "新建文件", onSelect: () => startCreate("file") },
    { label: "新建目录", onSelect: () => startCreate("dir") },
  );
  if (!isRoot) {
    // 标签里的 `\t` 是 `shell/menu` 的快捷键位约定（左标签、右按键提示），
    // 与下面 `onTreeKey` 那几条一一对应 —— 写了提示就得真做得到，所以两处同一批键。
    push(
      { label: "重命名\tF2", onSelect: () => startRename(path) },
      { label: "复制\tCtrl+C", onSelect: () => void doClip(false) },
      { label: "剪切\tCtrl+X", onSelect: () => void doClip(true) },
      {
        label: "粘贴\tCtrl+V",
        disabled: !clip || !dest,
        onSelect: () => void doPaste(),
      },
      { label: "删除\tDel", onSelect: () => void doDelete() },
    );
  } else {
    push({ label: "粘贴\tCtrl+V", disabled: !clip, onSelect: () => void doPaste() });
  }
  if (kind === "file") {
    // B461 · B 档那一对（VS Code 形）：先「选择以进行比较」把这条设成**左栏对照物**，
    // 再到另一条上点「与 X 比较」（那条是右栏）。次序是这一层的手势约定，不是设计稿规定的。
    // 标签与显隐的真相在 `diff/compare.ts`（与标签右键同一颗），这里只接侧效应。
    push(
      ...compareMenuItems(path, {
        onSelectToCompare: (p) => toggleCompareSelection(p),
        onCompareWith: (left, right) => {
          void openFileDiff(left, right);
          clearCompareSelection();
        },
      }),
    );
    // 多选手势那一路（VS Code 的 Compare Selected）：**整组恰好两条、且都是文件**才给，
    // 左右次序就是选中顺序。一条 / 三条 / 掺了目录一律不出现 —— 判据不成立，不是「置灰给人看」。
    const pair = pickedFiles();
    if (picks.length === 2 && pair.length === 2) {
      push({
        label: "将已选择进行比较",
        onSelect: () => {
          void openFileDiff(pair[0], pair[1]);
          // 上一条两击手势留下的对照物顺手清掉：这一发已经真的开出了差异面。
          clearCompareSelection();
        },
      });
    }
  }
  push({ label: "复制路径", onSelect: () => doCopyPath(path) });
  push({ label: "在资源管理器中显示", onSelect: () => void doReveal(path) });
  if (isRoot) {
    push(
      { label: "刷新该文件夹", onSelect: () => void refreshRoot(path) },
      // B424（用户点名）：只把它从名单里摘掉。已打开的标签、盘上的文件都不动。
      { label: "移除目录", onSelect: () => void removeFolder(path) },
      // 过滤态全收着时这一项就是「全部展开」（同一个动作，文案跟着现状走）
      { label: foldState().folded ? "全部展开" : "全部折叠", onSelect: () => collapseAllHere() },
    );
  }
  return out;
}

/** 树里空白处那一发：说的是「这一块」，不是某一棵目录树。 */
function blankMenu(): MenuItem[] {
  return [
    { label: "打开文件夹", onSelect: () => void promptOpenFolder() },
    { label: "移除全部目录", onSelect: () => void closeFolder() },
    { separator: true },
    { label: "全部折叠", onSelect: () => collapseAllHere() },
  ];
}

/**
 * 头部那颗键与菜单里那一条**共用**：
 * · 常规树：收的是子目录，各根行自己留着（否则整块像被清空了）；
 * · 过滤态（B428，用户点名）：主语换成**命中树** —— 所有带子项的目录一起收；
 *   全收着时再按一下 = 全部展开（连手动收起的根行一起放开）。只动 `filterCollapsed`，
 *   常规树的展开缓存一个不碰。
 */
function collapseAllHere(): void {
  if (filterOn()) {
    const dirs = filterDirPaths();
    if (dirs.length === 0) return;
    if (dirs.every((p) => filterCollapsed.has(p))) filterCollapsed.clear();
    else for (const p of dirs) filterCollapsed.add(p);
    renderTree();
    return;
  }
  collapseAll();
  rootsCollapsed.clear();
  renderTree();
}

function startRename(path: string): void {
  const dir = rows.get(path)?.dir;
  if (!dir) {
    showMessage("根目录不能改名", true);
    return;
  }
  renaming = { path, dir };
  renderTree();
}

async function commitRename(raw: string): Promise<void> {
  const plan = renaming;
  renaming = null;
  if (!plan) return;
  const name = raw.trim();
  if (!name || name === nameOf(plan.path)) {
    renderTree(); // 没改 = 取消，不发那一发 IPC
    return;
  }
  try {
    const made = await renameEntryAt(plan.dir, plan.path, name);
    showMessage(`已重命名为 ${made.name}`);
    // 选中态跟着走到新路径：`refreshDir` 已经按**旧**路径重画过一遍（那一格谁也不匹配 ⇒
    // 高亮凭空消失），用户刚改完名却看见选中没了，读作「改名把这一条弄丢了」。
    // 多选时只换那一条（其余同组的不受牵连），焦点落到新名字上。
    replacePick(plan.path, made.path);
    selected = made.path;
    paintSelection();
  } catch (e: unknown) {
    renderTree();
    showMessage(String(e), true);
  }
}

/** 复制 / 剪切：把选中那一条连同它所在层交给缓存层。 */
function doClip(cut: boolean): Promise<void> {
  const item = selected ? clipItem(selected) : null;
  if (!item) {
    showMessage(cut ? "这一条不能剪切" : "这一条不能复制", true);
    return Promise.resolve();
  }
  setClipboard(cut ? "cut" : "copy", [item]);
  showMessage(`${cut ? "已剪切" : "已复制"} ${item.path.split(/[\\/]/).pop() ?? ""}`);
  return Promise.resolve();
}

async function doPaste(): Promise<void> {
  const dest = targetDir();
  if (!dest) {
    showMessage("还没有打开文件夹", true);
    return;
  }
  if (!getClipboard()) {
    showMessage("剪贴板是空的", true);
    return;
  }
  try {
    const made = await pasteInto(dest);
    showMessage(`已粘贴 ${made.length} 条`);
  } catch (e: unknown) {
    showMessage(String(e), true);
  }
}

async function doDelete(): Promise<void> {
  const path = selected;
  if (!path || isRootPath(path)) {
    showMessage("根目录不能删除", true);
    return;
  }
  // 父亲只从父子表里查（多根下「一律兜底用第一根」会刷错层），查不到时退到它归属的那一根
  // —— 理由与 `clipItem` 同一处：后台刷新那一帧 `rows` 是空的，而那不该让删除 silently 失效。
  const dir = rows.get(path)?.dir ?? rootOf(path) ?? "";
  try {
    await trashAt(dir, path);
    // 焦点与选中一起收：删掉的那一条（以及它名下若有的）不许留在组里假装还选着。
    dropPicks(path);
    selected = picks[picks.length - 1] ?? null;
    anchor = anchor && picks.includes(anchor) ? anchor : selected;
    renderTree();
    showMessage(`已送进回收站：${path.split(/[\\/]/).pop() ?? path}`);
  } catch (e: unknown) {
    showMessage(String(e), true);
  }
}

function doCopyPath(path: string): void {
  void navigator.clipboard.writeText(path).then(() => showMessage(`已复制路径：${path}`));
}

async function doReveal(path: string): Promise<void> {
  try {
    await revealInFolder(path);
  } catch (e: unknown) {
    showMessage(String(e), true);
  }
}

// ---------------------------------------------------------------- B316 · 树内拖拽 = 移动

/** 悬停在折叠的目录上多久自己摊开。再短会把「路过」读成「要展开」，再长用户就以为没反应。 */
const HOVER_EXPAND_MS = 600;

/** 正被拖着的那一条：路径 + 它**当下所在那一层**（同层松手是空操作，得知道从哪来）。 */
let dragging: { path: string; dir: string } | null = null;
/** 当前落点那一行的路径（高亮与悬停展开都按路径算，不攥元素 —— 见 `paintMarks`）。 */
let dropPath: string | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hoverPath: string | null = null;

/** 分隔符折成 `\`、去尾、折叠大小写 —— Windows 路径比来比去都得先过这一道（口径同 `paths.ts`）。 */
function normPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * 落点那一层：目录行 = 它自己；根行 = 根；文件行 = **那个文件所在的那一层**（与
 * `targetDir` 同一判据 —— 指着 `a.md` 松手，用户的意图是「跟 a.md 放一起」，不是钻进
 * 一个叫 a.md 的目录）。
 */
function dropDirOf(row: HTMLElement): string | null {
  const path = row.dataset.path ?? "";
  if (!path) return null;
  const r = rows.get(path);
  if (!r) return path; // 父子表里没有 `path` 的只有根那一行
  return r.kind === "dir" ? path : r.dir;
}

/** `dest` 是不是落在 `src` 里面（含 `src` 自己）。目录拖进自己的子孙 = 盘上不可能成立。 */
function withinDragged(dest: string, src: string): boolean {
  const d = normPath(dest);
  const s = normPath(src);
  return d === s || d.startsWith(`${s}\\`);
}

/**
 * 这次拖该落到哪儿。给 `null` 就是「松手什么都不发」：同层（空操作）、落在自己身上、
 * 落在自己的子孙里。调用方据此决定拦不拦 `dragover` 的默认行为 —— 不拦，浏览器给的
 * 正好是那根「禁止」光标，不必自己画。
 */
function dropPlan(ev: DragEvent): { src: string; srcDir: string; destDir: string } | null {
  if (!dragging) return null;
  const row = rowFromEvent(ev);
  if (!row) return null; // 空白处不算落点，更不等于「移到根」—— 那会把一次滑手变成一次真搬家
  const destDir = dropDirOf(row);
  if (!destDir) return null;
  if (withinDragged(destDir, dragging.path)) return null;
  if (normPath(destDir) === normPath(dragging.dir)) return null;
  return { src: dragging.path, srcDir: dragging.dir, destDir };
}

/** 高亮一律**按路径重贴**：悬停展开会重绘整棵树，攥着旧元素等于贴在一堆已丢弃的节点上。 */
function paintMarks(): void {
  for (const el of explorerTree.querySelectorAll<HTMLElement>(
    ".explorer-dragging, .explorer-drop-on",
  )) {
    el.classList.remove("explorer-dragging", "explorer-drop-on");
  }
  if (dragging) rowEl(dragging.path)?.classList.add("explorer-dragging");
  if (dropPath) rowEl(dropPath)?.classList.add("explorer-drop-on");
}

function markDropRow(path: string | null): void {
  if (dropPath === path) return;
  dropPath = path;
  paintMarks();
}

function cancelHover(): void {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = null;
  hoverPath = null;
}

/** 在折叠的目录落点上排队一次自动摊开；`dragover` 每帧都来，同一条只留一个计时器。 */
function scheduleHover(path: string): void {
  if (hoverPath === path && hoverTimer !== null) return; // 这一条已经在计时了（dragover 每帧都来）
  cancelHover();
  const kind = rows.get(path)?.kind ?? "dir";
  if (kind !== "dir") return;
  const collapsed = isCollapsed(path);
  if (!collapsed) return;
  hoverPath = path;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    hoverPath = null;
    void activateDir(path);
  }, HOVER_EXPAND_MS);
}

function onRowDragStart(ev: DragEvent): void {
  const from = ev.target as HTMLElement | null;
  // 改名输入框里选中一段文字拖一下，同样是 `dragstart` —— 那不是在拖这一行。
  if (from && (from.tagName === "INPUT" || from.closest(".explorer-input"))) return;
  const row = rowFromEvent(ev);
  const path = row?.dataset.path ?? "";
  const r = rows.get(path);
  // 根那一行压根没设 `draggable`（`renderEntry` 才设）；拿父子表当闸，顺带挡住它以外的野路径。
  if (!r) {
    ev.preventDefault();
    return;
  }
  dragging = { path, dir: r.dir };
  dropPath = null;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = "move";
    // 只塞自家这一种 MIME：外部文件（`Files`）与标签拖拽各有各的落点判定，而拖到窗口外
    // 不做（用户口径）。B316-3 靠这个 MIME 认出「这是树里拖出来的，不是外部文件」。
    ev.dataTransfer.setData(TREE_DRAG_MIME, path);
    // 文件再多带一条：面板区只谈得上打开**文件**，目录拖过去没有落点，所以那一路不认领
    // （指针停在默认的禁止态）。目录想挪一层归树里自己判（B316-2）。
    if (r.kind === "file") ev.dataTransfer.setData(TREE_DRAG_FILE_MIME, path);
  }
  paintMarks();
}

function onRowDragOver(ev: DragEvent): void {
  if (!isTreeDrag(ev.dataTransfer)) return;
  const plan = dropPlan(ev);
  if (!plan) {
    markDropRow(null);
    cancelHover();
    return; // 不 preventDefault ⇒ 默认的「禁止」光标
  }
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  const row = rowFromEvent(ev);
  markDropRow(row?.dataset.path ?? null);
  // 悬停展开只对**目录落点**成立：指着文件时那一层本来就看得见，等 0.6 秒只会莫名其妙。
  const p = row?.dataset.path ?? "";
  if (p && (rows.get(p)?.kind ?? "dir") === "dir") scheduleHover(p);
  else cancelHover();
}

function onRowDragLeave(ev: DragEvent): void {
  if (!isTreeDrag(ev.dataTransfer)) return;
  const row = rowFromEvent(ev);
  const to = ev.relatedTarget as Node | null;
  // 从名字那一格挪到同一行的箭头，也会冒出一个 `dragleave`；按「指针还在不在这一行」判，
  // 否则悬停展开的计时每帧被重置一次，永远等不到那 0.6 秒。
  if (row && to && row.contains(to)) return;
  markDropRow(null);
  cancelHover();
}

function onRowDrop(ev: DragEvent): void {
  if (!isTreeDrag(ev.dataTransfer)) return;
  ev.preventDefault(); // 不交给默认处理：否则这次拖拽可能被当成文本塞进别处
  const plan = dropPlan(ev);
  const name = nameOf(dragging?.path ?? "");
  endDrag();
  if (!plan) return;
  void moveTo(plan.src, plan.srcDir, plan.destDir)
    .then((made) => {
      select(made.path);
      showMessage(`已移动 ${name}`);
    })
    .catch((e: unknown) => {
      showMessage(String(e), true);
    });
}

function endDrag(): void {
  cancelHover();
  dragging = null;
  dropPath = null;
  paintMarks();
}
