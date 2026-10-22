/**
 * B305 · 最近打开面板（视图层）。
 *
 * 只做三件事：把这一块登记成外壳的一个视图、把 Rust 给的那份名单画出来、
 * 把三种手势（打开一条 / 单条清除 / 清空全部）转成一次调用。
 * **不判「这份文件还开着吗」、不排序、不去重** —— 那些归 Rust（`src-tauri/src/session/recent.rs`），
 * 视图再判一遍就是两套口径，迟早跟真值错开（B304 那一族的教训）。
 *
 * 依赖方向说清，免得日后有人顺手补一条反向 import 成环：
 *   本模块 → `shell/drawer`（把这一块登记成外壳的一个视图）→ `ui`；
 *   「整栏在不在」那一层仍问 `toc`（两层互不撤销，B198 的口径）。
 * B307 起**没有**反向注入了：互斥与点亮态都由外壳一处写，大纲那边不认识本模块。
 */
import { windowKind } from "../core/app-state";
import { doOpen } from "../io/files";
import { CODICONS } from "../shell/codicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
import { setTip } from "../shell/tooltip";
import { openFolder } from "../explorer/panel";
import { applySidebarVisible, isSidebarOff } from "../toc";
import { recentClear, recentList, recentPanel, sideRecent, showMessage } from "../ui";
import {
  clearRecentEntries,
  forgetRecentEntry,
  getRecentLimit,
  getRecents,
  onRecentsChange,
} from "./store";
import type { RecentEntry } from "../ipc/api";
import type { MenuItem } from "../shell/menu";

/** 键与监听只装一次：重复装配会让一次点击触发好几遍（测试里逐用例重新装配时尤其明显）。 */
let wired = false;

export function setupRecentsPanel(): void {
  sideRecent.innerHTML = CODICONS.history;
  recentClear.innerHTML = CODICONS.trash;
  // B307：把这一块登记成外壳的一个视图。面板 `hidden`、那颗键的 `is-on` / `aria-pressed`、
  // 与大纲的互斥、宽度与那条竖线 —— 全在 `setDrawer` 一处，这里只交「轮到我时重画什么」。
  registerDrawerView("recent", { panel: recentPanel, button: sideRecent, onShow: renderRecents });
  onRecentsChange(() => renderRecents());
  if (!wired) {
    wired = true;
    sideRecent.addEventListener("click", () => toggleRecentPanel());
    recentClear.addEventListener("click", () => void clearAll());
    recentList.addEventListener("click", (e) => onListClick(e));
  }
  renderRecents();
}

/** 上限为 0 = 整个功能关掉（Rust 那边既不记录也把名单清了），所以入口也不该留着。 */
function isRecentsDisabled(): boolean {
  return getRecentLimit() === 0;
}

export function toggleRecentPanel(): void {
  // 子窗口整条左栏都不在（CSS 收掉了卡片）：不挡这道就会把看不见的面板打开，
  // 还顺手把开合值写进设置 —— 下次到主窗口就表现为「没点它，那块自己开起来了」。
  if (windowKind === "satellite") return;
  // B306：上限 0 时那颗键已经收了（点不到），但这里仍是唯一的入口 —— 将来挂快捷键 /
  // 命令面板就从这里进，规则要长在门上而不是长在门把手上。
  // ⚠️ 必须排在「整栏收着先放出来」**之前**：挡晚了就是一次空转改掉用户的「左栏收起」
  // 偏好（而且落盘），下次启动左栏莫名其妙地开着。
  if (isRecentsDisabled()) return;
  if (activeDrawer() === "recent") {
    setDrawer(null);
    return;
  }
  // 整栏收着时先把它放出来（口径同 `toggleToc` 的 B198：藏在 display:none 里切显隐＝死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("recent");
}

/** 菜单里每类各露几条 —— 与 VS Code 的 `MAX_MENU_RECENT_ENTRIES` 同值（10）。 */
const MENU_MAX_PER_KIND = 10;

/** 「更多...」那颗：把完整清单摊开（全部条目与单条移除都在那块面板里）。 */
export function showRecentPanel(): void {
  if (windowKind === "satellite" || isRecentsDisabled()) return;
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("recent");
}

/**
 * B332 ·「文件 ▸ 打开最近 ▸」里的那一屏。菜单每次展开时重新求值 ⇒ 拿的就是当下这份缓存。
 *
 * 两段：文件夹在上、文件在下（用户点名，与 VS Code 的 Open Recent 同序），各取前 10 条。
 * 名单可以有 50+50 条，菜单不是用来翻到底的 —— 底部那颗「更多...」才是入口。
 * 点文件夹条目 = 换根（走 `openFolder`，顺手记一条新的 LRU）；点文件条目 = 打开（`doOpen`，
 * 与面板里点那一行走的是同一扇）。
 */
export function recentMenuItems(): MenuItem[] {
  const list = getRecents();
  const folders = list.filter((e) => e.kind === "folder").slice(0, MENU_MAX_PER_KIND);
  const files = list.filter((e) => e.kind !== "folder").slice(0, MENU_MAX_PER_KIND);
  if (folders.length === 0 && files.length === 0) {
    // 空子菜单点开是一片空白 = 用户以为功能坏了；给一句说明 + 那颗还能去的「更多...」。
    return [
      { label: "还没有打开过的记录", disabled: true },
      { separator: true },
      { label: "更多...", onSelect: showRecentPanel },
    ];
  }
  const items: MenuItem[] = [];
  for (const e of folders)
    items.push({ label: menuLabelFor(e.name, e.path), onSelect: () => void openFolder(e.path) });
  if (folders.length > 0 && files.length > 0) items.push({ separator: true });
  for (const e of files)
    items.push({ label: menuLabelFor(e.name, e.path), onSelect: () => void doOpen(e.path) });
  items.push({ separator: true }, { label: "更多...", onSelect: showRecentPanel });
  return items;
}

/** 按当前缓存重画。Rust 的广播、改上限、清除之后都走这里，视图自己从不缓存第二份名单。 */
export function renderRecents(): void {
  const list = getRecents();
  const cap = getRecentLimit();
  // B306：上限 0 = 功能整条关掉（Rust 那边既不记录、也把名单一起清了），入口留着只会
  // 让人点进去看一句「已停止记录」。正摊着这一块就把外壳收起 —— 门关了不许屋里还亮着，
  // 而点亮态与 `is-collapsed` 仍由 `setDrawer` 那一个出口翻，这里不自己改 DOM。
  sideRecent.hidden = cap === 0;
  if (cap === 0 && activeDrawer() === "recent") setDrawer(null);
  const folders = list.filter((e) => e.kind === "folder");
  const files = list.filter((e) => e.kind !== "folder");
  recentClear.setAttribute("data-tip", list.length === 0 ? "没有可清空的记录" : "清空全部");
  recentList.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    // 两种空态得分开说：「还没打开过」与「不再记录」是两件不同的事，
    // 混成一句，用户把上限调成 0 之后会以为功能坏了。
    empty.textContent = cap === 0 ? "已停止记录（上限为 0）" : "还没有打开过的文件或文件夹";
    recentList.append(empty);
    return;
  }
  // 文件夹那一组永远在文件之上（用户点名，与 VS Code 的 Open Recent 同序）。
  // B348：两类之间只画一条横线 —— 原先那两行「文件夹」/「文件」小标题撤掉了：
  // 条目名与次行的完整路径已经把「这是目录还是文件」说清楚，标题只是把它重复一遍。
  for (const e of folders) recentList.append(rowOf(e));
  if (folders.length > 0 && files.length > 0) recentList.append(divider());
  for (const e of files) recentList.append(rowOf(e));
}

/** 两组之间那条横线（不可点：它不是条目，`rowOf` 那套 dataset.path / ✕ 一概不挂）。 */
function divider(): HTMLElement {
  const el = document.createElement("div");
  el.className = "recent-divider";
  return el;
}

/**
 * 一行。⚠️ 一律 `createElement` + `textContent`，不许用 `innerHTML` 拼路径 ——
 * 路径里可以出现 `<`、`&`，那就是给自己造一个注入点。
 */
function rowOf(e: RecentEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "recent-row";
  row.dataset.path = e.path;

  const line = document.createElement("div");
  line.className = "recent-line";
  const name = document.createElement("div");
  name.className = "recent-name";
  name.textContent = e.name;
  const dir = document.createElement("div");
  dir.className = "recent-path";
  // B335：次行给**完整路径**，不再只给父目录 —— 同名文件散在好几层时，父目录那一截
  // 分不开「报价\单.md」与「10月\单.md」之外更深的差别。放不下仍旧省略号截断，
  // 悬停浮层（data-tip）里是全串。
  dir.textContent = e.path;
  line.append(name, dir);

  const del = document.createElement("button");
  del.className = "recent-del";
  del.type = "button";
  del.innerHTML = CODICONS.close;
  del.setAttribute("aria-label", `从最近打开里移除 ${e.name}`);

  // 完整路径与相对时间挂在悬停浮层上：行里两处都做了截断，看全的地方必须有。
  // B348：档位与标签条 / 大纲同款（跟着鼠标走、紧凑档、带分组标记），所以经 setTip
  // 挂 —— 裸写 `data-tip` 拿到的是默认档（画 caret、不跟鼠标、非紧凑），两处就不齐了。
  setTip(row, e.path, {
    detail: relativeTime(e.openedAt),
    group: "recents",
    follow: true,
    compact: true,
  });
  row.append(line, del);
  return row;
}

/**
 * 行的点击（**委托**在 `#recent-list` 上，一次装配管到底）：整行 = 打开，✕ = 单条清除。
 * 逐行挂监听的话，每次广播重绘都会把旧监听连着旧 DOM 一起丢掉/重挂，更容易漏。
 */
function onListClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  const row = target?.closest<HTMLElement>(".recent-row");
  if (!row) return;
  const path = row.dataset.path ?? "";
  if (!path) return;
  if (target?.closest(".recent-del")) {
    // 同一颗点击面里两颗动作：挡在这一句就完了，别让它再冒到「打开这一行」。
    void forgetRecentEntry(path);
    return;
  }
  void doOpen(path);
}

async function clearAll(): Promise<void> {
  if (getRecents().length === 0) return; // 空名单不值得一次 IPC，也不值得冒一句「已清空」
  await clearRecentEntries();
  showMessage("最近打开已清空");
}

/**
 * 相对时间（读的是「最后一次打开」那一刻）。先按**日历天**分档再谈小时：跨了天还说
 * 「23 小时前」，用户读作「今天」，而「昨天」才是他要的那个信息。
 * 分档：刚刚（<1 分）/ N 分钟前 / N 小时前（同一天内）/ 昨天 HH:mm / M月D日 HH:mm（同年）/
 * YYYY年M月D日（跨年）。
 */
export function relativeTime(openedAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - openedAt);
  const from = new Date(openedAt);
  const to = new Date(now);
  const days = dayDiff(from, to);
  if (days >= 1) {
    if (days === 1) return `昨天 ${hhmm(from)}`;
    if (from.getFullYear() === to.getFullYear())
      return `${from.getMonth() + 1}月${from.getDate()}日 ${hhmm(from)}`;
    return `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日`;
  }
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return `${Math.floor(diff / 3_600_000)} 小时前`;
}

/** 日历天差。用本地年月日构造再比 UTC，避开夏令时/时区把差值抖出一天。 */
function dayDiff(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function hhmm(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 菜单标签的字符上限（VS Code 的 Open Recent 同档：120）。
 * `.popup-menu` 只有 `min-width` 没有 `max-width` ⇒ 一条深路径能把整块弹层顶出窗口。
 */
const MENU_LABEL_MAX = 120;

/**
 * 菜单里每一项的标签：`名字 — 完整路径`（B335，用户点名）。
 * 挤不下的那几条走**中间省略**：头部留「名字 + 路径开头」，尾部留路径末尾 ——
 * 一条路径的分辨力集中在末尾（哪一层、哪个文件），砍尾等于白写。
 */
export function menuLabelFor(name: string, path: string): string {
  const full = `${name} — ${path}`;
  if (full.length <= MENU_LABEL_MAX) return full;
  const keep = MENU_LABEL_MAX - 1; // 留给那一个省略号
  const head = Math.ceil(keep / 2);
  return `${full.slice(0, head)}…${full.slice(full.length - (keep - head))}`;
}
