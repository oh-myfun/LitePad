/**
 * B314 · 资源管理器面板（视图层）。
 *
 * 只做四件事：把这一棵**懒加载的树**画出来、把三种手势（点开目录 / 点文件 / 键盘上下）
 * 转成一次调用、把四颗标题栏键（打开文件夹 / 刷新 / 全部折叠 / 新建）接上、把新建的
 * 名字输入框放在**它该在的那一层**。
 * **不读盘、不排序、不校验名字、不拼路径** —— 那些在 `commands/explorer.rs`；
 * **不缓存、不判在飞** —— 那些在 `./store.ts`。视图再判一遍就是两套口径（B304 那一族的教训）。
 *
 * 依赖方向：本模块 → `shell/drawer`（登记成外壳的一个视图）→ `ui`；
 * 打开文件走 `io/files` 的 `doOpen`（与拖放、最近打开、文件关联同一扇漏斗，
 * 「最近打开」的记入因此自动跟着生效，不必这里再报一发）。
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { windowKind, settings } from "../core/app-state";
import { createDir, createFile, saveSettings, type FsEntry } from "../ipc/api";
import { doOpen } from "../io/files";
import { CODICONS } from "../shell/codicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
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
  getRoot,
  hasRoot,
  isExpanded,
  isLoading,
  onExplorerChange,
  refresh,
  refreshDir,
  setRoot,
  toggleDir,
} from "./store";

type Kind = "file" | "dir";

/** 上一次点中的行（新建的目标目录、`aria-selected` 都读它）。 */
let selected: string | null = null;
/** 正在输入名字的创建：目标目录 + 建什么。非 null 时那一层下面多一个输入框。 */
let creating: { dir: string; kind: Kind } | null = null;
/** 根那一行自己收没收起（根永远是树的第一节点，VS Code 一样）。 */
let rootOpen = true;
/** 每一行的父亲与类型：渲染时顺手记下，新建目标目录靠它算，**不做路径字符串手术**。 */
const rows = new Map<string, { dir: string; kind: Kind }>();
/** 当前可见行的顺序（键盘上下走的就是这份）。 */
let visible: string[] = [];

/** 换根：读盘上那个路径、写回设置。空串 = 关闭文件夹（树收干净）。 */
export async function openFolder(path: string): Promise<void> {
  setRoot(path);
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
  explorerCollapse.addEventListener("click", () => {
    collapseAll();
    rootOpen = true; // 「全部折叠」收的是子目录；根那一行留着，否则整块像被清空了
  });
  explorerNewFile.addEventListener("click", () => startCreate("file"));
  explorerNewDir.addEventListener("click", () => startCreate("dir"));
  explorerTree.addEventListener("click", (e) => onRowClick(e as MouseEvent));
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

function note(text: string, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "explorer-note";
  row.style.setProperty("--depth", String(depth));
  row.textContent = text;
  return row;
}

function inputRow(kind: Kind): HTMLElement {
  const row = document.createElement("div");
  row.className = "explorer-row is-creating";
  row.setAttribute("role", "treeitem");
  const twisty = document.createElement("span");
  twisty.className = "explorer-twisty";
  const glyph = document.createElement("span");
  glyph.className = "explorer-glyph";
  glyph.innerHTML = kind === "dir" ? CODICONS.folder : CODICONS.file;
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
  row.append(twisty, glyph, input);
  queueMicrotask(() => input.focus());
  return row;
}

/** 一个目录节点之下该画的东西：输入框 / 读取中 / 错误 / 空 / 子项。 */
function renderChildren(host: HTMLElement, dir: string, depth: number): void {
  if (creating?.dir === dir) {
    host.append(inputRow(creating.kind));
    return;
  }
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
    host.append(note("（空）", depth));
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
  // 完整路径进原生 title：悬停浮层那套（data-tip）在树里会每行挂一条、还盖住下一行，
  // 而这一句只是「看全那个路径」，title 够用且不引入新的层级。
  row.title = e.path;

  const twisty = document.createElement("span");
  twisty.className = "explorer-twisty";
  if (kind === "dir") {
    twisty.innerHTML = open ? CODICONS.chevronDown : CODICONS.chevronRight;
  }
  const glyph = document.createElement("span");
  glyph.className = "explorer-glyph";
  glyph.innerHTML =
    kind === "dir" ? (open ? CODICONS.folderOpened : CODICONS.folder) : CODICONS.file;
  const name = document.createElement("span");
  name.className = "explorer-name";
  // ⚠️ 一律 textContent：文件名里可以有 `<`、`&`，拼 innerHTML 就是给自己造注入点
  //   （口径同 recents/panel.ts 的 `rowOf`）。
  name.textContent = e.name;
  row.append(twisty, glyph, name);

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
    explorerTree.append(note("还没有打开文件夹", 0), openHintRow());
    return;
  }
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
  rootRow.title = root;
  rootRow.tabIndex = selected === root || visible.length === 0 ? 0 : -1;
  visible.unshift(root);
  const rt = document.createElement("span");
  rt.className = "explorer-twisty";
  rt.innerHTML = rootOpen ? CODICONS.chevronDown : CODICONS.chevronRight;
  const rg = document.createElement("span");
  rg.className = "explorer-glyph";
  rg.innerHTML = rootOpen ? CODICONS.folderOpened : CODICONS.folder;
  const rn = document.createElement("span");
  rn.className = "explorer-name";
  rn.textContent = rootName;
  rootRow.append(rt, rg, rn);
  explorerTree.append(rootRow);
  const kids = document.createElement("div");
  kids.className = "explorer-children";
  kids.hidden = !rootOpen;
  if (rootOpen) renderChildren(kids, root, 1);
  explorerTree.append(kids);
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
    default:
      break;
  }
}

// ---------------------------------------------------------------- 新建

/** 目标目录：选中的是目录就用它；是文件用它的父亲；什么都没选就用根。 */
function createTarget(): string | null {
  if (!hasRoot()) return null;
  if (!selected) return getRoot();
  const r = rows.get(selected);
  if (!r) return getRoot(); // 选中的就是根那一行
  return r.kind === "dir" ? selected : r.dir;
}

function startCreate(kind: Kind): void {
  const dir = createTarget();
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
