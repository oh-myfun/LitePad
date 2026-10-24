/**
 * B314 / B315 · 资源管理器面板（视图层）。
 *
 * 只做五件事：把这一棵**懒加载的树**画出来、把三种手势（点开目录 / 点文件 / 键盘上下）
 * 转成一次调用、把四颗标题栏键（打开文件夹 / 刷新 / 全部折叠 / 新建）接上、把新建与
 * 改名的名字输入框放在**它该在的那一层**、以及 B315 的**右键菜单**（复用 `shell/menu`
 * 那套浮层，不另造一个菜单组件）。
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
  isDir,
  revealInFolder,
  saveSettings,
  type FsEntry,
} from "../ipc/api";
import { doOpen } from "../io/files";
import { noteOpened } from "../recents/store";
import { detectLanguage } from "../editor/language";
import { CODICONS } from "../shell/codicons";
import { fileIconHtml } from "../shell/fileicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
import { showPopupMenu, type MenuItem } from "../shell/menu";
import { setTextTip } from "../shell/tooltip";
import { isTreeDrag, TREE_DRAG_FILE_MIME, TREE_DRAG_MIME } from "../shell/filedrop";
import {
  explorerCollapse,
  explorerNewDir,
  explorerNewFile,
  explorerOpen,
  explorerPanel,
  explorerRefresh,
  explorerTitle,
  explorerTree,
  showMessage,
  sideExplorer,
} from "../ui";
import {
  childrenOf,
  collapseAll,
  errorOf,
  getClipboard,
  getRoot,
  hasRoot,
  isExpanded,
  isLoading,
  moveTo,
  onExplorerChange,
  pasteInto,
  refresh,
  refreshDir,
  renameEntryAt,
  setClipboard,
  setRoot,
  toggleDir,
  trashAt,
  type ClipItem,
} from "./store";

type Kind = "file" | "dir";

/** 上一次点中的行（新建的目标目录、`aria-selected` 都读它）。 */
let selected: string | null = null;
/** 正在输入名字的创建：目标目录 + 建什么。非 null 时那一层下面多一个输入框。 */
let creating: { dir: string; kind: Kind } | null = null;
/** 正在改名那一条（路径 + 它所在层）。非 null 时它那一行的名字换成输入框。 */
let renaming: { path: string; dir: string } | null = null;
/** 根那一行自己收没收起（根永远是树的第一节点，VS Code 一样）。 */
let rootOpen = true;
/** 每一行的父亲与类型：渲染时顺手记下，新建目标目录靠它算，**不做路径字符串手术**。 */
const rows = new Map<string, { dir: string; kind: Kind }>();
/** 当前可见行的顺序（键盘上下走的就是这份）。 */
let visible: string[] = [];

/** 换根：读盘上那个路径、写回设置。空串 = 关闭文件夹（树收干净）。 */
export async function openFolder(path: string): Promise<void> {
  setRoot(path);
  // B332：换根就是「用户打开了这个文件夹」⇒ 往最近名单记一条。空串（关闭）不记。
  // 启动回放那一路走 `store.setRoot`，不经这一扇 —— 「恢复不算打开」对两类都成立。
  if (path) noteOpened(path, "folder");
  if (!settings) return;
  settings.folder_root = path;
  await saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与展开区开合同一口径）
  });
}

/** 「打开文件夹…」：系统目录选择器。取消什么都不做。 */
export async function promptOpenFolder(): Promise<void> {
  if (windowKind === "satellite") return;
  const picked = await openDialog({ directory: true, multiple: false }).catch(() => null);
  if (typeof picked !== "string" || !picked) return;
  await openFolder(picked);
  // VS Code 的口径：选完文件夹就把资源管理器摊开 —— 用户下一步要看的就是它。
  if (activeDrawer() !== "explorer") setDrawer("explorer");
}

/**
 * B331「关闭文件夹」：清根 + 清掉设置里那一格 + 树回初屏。
 * 走 `openFolder("")` 那条漏斗 —— 换根的三件事（store、设置、落盘）只有一处实现。
 * 已开着的标签**一个都不动**：关的是「资源管理器看哪个目录」，不是文档（VS Code 的
 * 「关闭工作区」同样不碰编辑器里的标签）。也不从最近名单里删那条 —— 刚关掉的那个
 * 正是下一次最可能重开的。
 * ⚠️ 子窗口没有左边栏，但 `settings` 是全窗口共用那份盘：不挡住就是「子窗口替主窗口抹根」。
 */
export async function closeFolder(): Promise<void> {
  if (windowKind === "satellite") return;
  await openFolder("");
}

/**
 * B333 · 「拖一条目录落到资源管理器这一块」= 打开这个文件夹（换根）。
 *
 * 三条都成立才认领，差一条就交回原来那一路（`io/files` 的 `landDroppedPaths`，那一路会把
 * 拖进来的东西当**文件**打开）：落点在那一块里、**只**拖了一条、那一条在盘上真是目录。
 * 「只一条」是刻意的：根只能有一个，多条时猜用户想开哪个就是替他做错。
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
  // 子窗口整条左栏都不在，而换根会写 `folder_root` —— 那等于替主窗口把根抹掉（同 B331）。
  if (windowKind === "satellite") return false;
  if (!explorerPanel.contains(hitAt(x, y))) return false;
  if (paths.length !== 1) return false;
  const path = paths[0];
  if (!path || !(await isDir(path))) return false;
  await openFolder(path);
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
  explorerRefresh.innerHTML = CODICONS.refresh;
  explorerCollapse.innerHTML = CODICONS.collapseAll;
  explorerNewFile.innerHTML = CODICONS.newFile;
  explorerNewDir.innerHTML = CODICONS.newFolder;
  registerDrawerView("explorer", {
    panel: explorerPanel,
    button: sideExplorer,
    onShow: renderTree,
  });
  onExplorerChange(() => renderTree());
  // ⚠️ 按钮列那颗的点击**必须在这里挂**：`registerDrawerView` 只管「显隐与亮灭怎么算」，
  //   不接管点击（口径同 `toc.ts` 的 `sideOutline` / `recents/panel.ts` 的 `sideRecent`）。
  //   真机验收抓到过：漏这一句时那颗键看着正常、点下去毫无反应，而用例全是
  //   「程序里调 `setDrawer` 再断言亮灭」，永远照不出来。
  sideExplorer.addEventListener("click", () => toggleExplorer());
  explorerOpen.addEventListener("click", () => void promptOpenFolder());
  explorerRefresh.addEventListener("click", () => void refresh());
  explorerCollapse.addEventListener("click", () => collapseAllHere());
  explorerNewFile.addEventListener("click", () => startCreate("file"));
  explorerNewDir.addEventListener("click", () => startCreate("dir"));
  explorerTree.addEventListener("click", (e) => onRowClick(e as MouseEvent));
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

/** 从这一行往顶层数到根之前（不含根）：顺序 = 左→右，正好对上 VS Code 的祖先线列。 */
function ancestorPaths(path: string): string[] {
  const chain: string[] = [];
  let cur = rows.get(path)?.dir;
  while (cur && cur !== getRoot()) {
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
  out.add(r.kind === "dir" && isExpanded(selected) ? selected : r.dir);
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

function renderEntry(e: FsEntry, dir: string, depth: number): HTMLElement {
  const kind: Kind = e.isDir ? "dir" : "file";
  rows.set(e.path, { dir, kind });
  visible.push(e.path);
  const open = kind === "dir" && isExpanded(e.path);
  const row = document.createElement("div");
  row.className = "explorer-row";
  row.dataset.path = e.path;
  row.dataset.kind = kind;
  row.style.setProperty("--depth", String(depth));
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.setAttribute("aria-selected", String(selected === e.path));
  if (kind === "dir") row.setAttribute("aria-expanded", String(open));
  row.tabIndex = selected === e.path ? 0 : -1;
  // B316：树里每一行都可拖（根那一行不可 —— 它没有父亲，拖出去无处可放）。
  row.draggable = true;
  // 完整路径进自绘提示层（B350）：原先写原生 `title`，深色界面里会弹一枚不吃主题、
  // 延迟口径也不一样的系统气泡。档位与标签 / 大纲 / 最近打开同一档（setTextTip）——
  // 气泡压在鼠标下方，会盖住下面一两行，这与最近打开那排密行是同一种遮挡，可接受。
  setTextTip(row, e.path, { group: "explorer" });

  const name = nameSpan(e.name);
  // B373：文件行**不再留空箭头槽**（VS Code 的非可折叠行 twistie 宽 0，Seti 图标从内容
  // 起点开始）—— 图标槽本身吃掉 22px，文件名才和同层的目录名从同一 x 起排。
  // 目录行仍只有箭头 + 名字：Seti 主题不定义文件夹图标（B370 的口径）。
  const parts: HTMLElement[] = [];
  const guide = guideColumn(e.path, depth);
  if (guide) parts.push(guide);
  const slot = document.createElement("span");
  slot.className = kind === "dir" ? "explorer-twisty" : "explorer-glyph";
  if (kind === "dir") slot.innerHTML = open ? CODICONS.chevronDown : CODICONS.chevronRight;
  else slot.innerHTML = fileIconHtml(detectLanguage(e.name).label);
  parts.push(slot, renaming?.path === e.path ? renameInput(e) : name);
  row.append(...parts);

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

function renderTree(): void {
  rows.clear();
  visible = [];
  explorerTree.replaceChildren();
  if (!hasRoot()) {
    explorerTitle.textContent = "资源管理器";
    // B317（用户点名）：没有根时顶部那一排键没一颗用得上 —— 新建 / 刷新 / 全部折叠都要先有
    // 一棵树，而「打开文件夹」下面那颗大按钮就是它自己的出口。整排收起，标题独占那一行。
    // B327：打开键平时住在根那一行，无根时放回头部这一排（跟着整排一起被 `.no-root` 收起）。
    explorerPanel.classList.add("no-root");
    explorerPanel.querySelector<HTMLElement>(".explorer-head")?.append(explorerOpen);
    explorerTree.append(note("还没有打开文件夹", 0), openHintRow());
    return;
  }
  explorerPanel.classList.remove("no-root");
  const root = getRoot();
  const rootName = nameOf(root);
  explorerTitle.textContent = "资源管理器";
  const rootRow = document.createElement("div");
  rootRow.className = "explorer-root";
  rootRow.dataset.path = root;
  rootRow.dataset.kind = "dir";
  rootRow.setAttribute("role", "treeitem");
  rootRow.setAttribute("aria-expanded", String(rootOpen));
  rootRow.setAttribute("aria-level", "1");
  setTextTip(rootRow, root, { group: "explorer" });
  rootRow.tabIndex = selected === root || visible.length === 0 ? 0 : -1;
  visible.unshift(root);
  const rt = document.createElement("span");
  rt.className = "explorer-twisty";
  rt.innerHTML = rootOpen ? CODICONS.chevronDown : CODICONS.chevronRight;
  const rn = document.createElement("span");
  rn.className = "explorer-name";
  rn.textContent = rootName;
  // B327：「打开文件夹」挂进根这一行的最右（换目录是跟这棵树走的事）。元素还是骨架里那一颗，
  // 监听与 data-tip 都在它身上，搬的只是位置；`replaceChildren` 每次把它摘下来，这里再挂回去。
  // B370：根行与目录行同口径，不再挂文件夹图标（VS Code 的 Seti 主题没有文件夹图标）。
  rootRow.append(rt, rn, explorerOpen);
  explorerTree.append(rootRow);
  const kids = document.createElement("div");
  kids.className = "explorer-children";
  kids.hidden = !rootOpen;
  if (rootOpen) renderChildren(kids, root, 1);
  explorerTree.append(kids);
  // 拖拽途中被悬停展开打断过一次重绘：那两层高亮贴在的是**刚被丢掉**的旧元素上，得按路径重贴。
  if (dragging) paintMarks();
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
  // B327：根那一行里现在挂着「打开文件夹」那颗键，而整棵树是**委托**点击 —— 不挡掉的话一发
  // 点击会同时开目录选择器 + 把根折叠/展开一遍（`activateDir` 当场 renderTree，键还会被搬走）。
  if ((ev.target as HTMLElement | null)?.closest("button")) return;
  const row = rowFromEvent(ev);
  if (!row) return;
  const path = row.dataset.path ?? "";
  if (!path) return;
  select(path);
  if (row.dataset.kind === "dir") void activateDir(path);
  else void doOpen(path);
}

async function activateDir(path: string): Promise<void> {
  if (path === getRoot()) {
    rootOpen = !rootOpen;
    renderTree();
    return;
  }
  await toggleDir(path);
}

/** 点中一行：只重画 `aria-selected` 与 roving tabindex，不整棵树重绘（选中的代价不该是重读盘）。 */
function select(path: string | null): void {
  selected = path;
  for (const el of explorerTree.querySelectorAll<HTMLElement>("[data-path]")) {
    const on = el.dataset.path === path;
    el.setAttribute("aria-selected", String(on));
    el.tabIndex = on ? 0 : -1;
  }
  paintActiveGuides();
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
    select(next);
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
      if (row?.dataset.kind === "dir" && !isExpanded(cur) && cur !== getRoot())
        void activateDir(cur);
      else if (cur === getRoot() && !rootOpen) void activateDir(cur);
      break;
    case "ArrowLeft":
      ev.preventDefault();
      if (cur === getRoot()) {
        if (rootOpen) void activateDir(cur);
        return;
      }
      if (row?.dataset.kind === "dir" && isExpanded(cur)) void activateDir(cur);
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
      const onRoot = cur === getRoot();
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
 * 该动手的那一层：选中的是目录就用它；是文件用它的父亲；什么都没选（或选的就是根）用根。
 * 「新建文件 / 新建目录 / 粘贴」三条共用这一份判据 —— 两条各算一遍目标，
 * 迟早会出现「新建落在这层、粘贴落在那层」那种没人解释得清的分裂。
 */
function targetDir(): string | null {
  if (!hasRoot()) return null;
  if (!selected) return getRoot();
  const r = rows.get(selected);
  if (!r) return getRoot(); // 选中的就是根那一行
  return r.kind === "dir" ? selected : r.dir;
}

function startCreate(kind: Kind): void {
  const dir = targetDir();
  if (!dir) {
    showMessage("还没有打开文件夹");
    return;
  }
  creating = { dir, kind };
  // 目标没展开的话先展开：输入框画在看不见的一层里等于没反应。
  if (dir !== getRoot() && !isExpanded(dir)) void toggleDir(dir).then(() => renderTree());
  renderTree();
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
 */
function clipItem(path: string): ClipItem | null {
  if (!path || path === getRoot()) return null; // 根自己不进剪贴板：它就是整棵树
  return { path, dir: rows.get(path)?.dir ?? getRoot() };
}

function onRowContext(ev: MouseEvent): void {
  ev.preventDefault();
  if (windowKind === "satellite") return;
  // 按钮上右键不许弹那一行的菜单：菜单问的是「选中了谁」，而右键这颗键的人要的是这颗键
  if ((ev.target as HTMLElement | null)?.closest("button")) return;
  const row = rowFromEvent(ev);
  const path = row?.dataset.path ?? "";
  // 先选中再弹菜单：菜单里那几项问的全是「选中了谁」，不选就会对着上一行的目标动手
  if (path) select(path);
  showPopupMenu(null, menuFor(path), { x: ev.clientX, y: ev.clientY });
}

/**
 * 菜单条目。`path` 为空 = 空白处（等价于对根动手）；根那一行自己**不参与**改名 /
 * 复制 / 剪切 / 删除 —— 那是整棵树，删了它面板就空了，而「打开文件夹」那条键才是它的出口。
 */
function menuFor(path: string): MenuItem[] {
  if (!hasRoot()) {
    return [{ label: "打开文件夹…", onSelect: () => void promptOpenFolder() }];
  }
  const isRoot = !path || path === getRoot();
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
  push({ label: "复制路径", onSelect: () => doCopyPath(isRoot ? getRoot() : path) });
  push({
    label: "在资源管理器中显示",
    onSelect: () => void doReveal(isRoot ? getRoot() : path),
  });
  if (isRoot) {
    push(
      { label: "刷新", onSelect: () => void refresh() },
      { label: "全部折叠", onSelect: () => void collapseAllHere() },
    );
  }
  return out;
}

/** 「全部折叠」那颗键与菜单里那一条**共用**：收的是子目录，根那一行留着（否则整块像被清空了）。 */
function collapseAllHere(): void {
  collapseAll();
  rootOpen = true;
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
    select(made.path);
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
  if (!path || path === getRoot()) {
    showMessage("根目录不能删除", true);
    return;
  }
  const dir = rows.get(path)?.dir ?? getRoot();
  try {
    await trashAt(dir, path);
    selected = null;
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
  const collapsed = path === getRoot() ? !rootOpen : !isExpanded(path);
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
