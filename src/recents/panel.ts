/**
 * B305 · 最近打开面板（视图层）。
 *
 * 只做三件事：把 `#recent-panel` 的显隐收在一个出口、把 Rust 给的那份名单画出来、
 * 把三种手势（打开一条 / 单条清除 / 清空全部）转成一次调用。
 * **不判「这份文件还开着吗」、不排序、不去重** —— 那些归 Rust（`src-tauri/src/session/recent.rs`），
 * 视图再判一遍就是两套口径，迟早跟真值错开（B304 那一族的教训）。
 *
 * 依赖方向说清，免得日后有人顺手补一条反向 import 成环：
 *   本模块 → `toc`（互斥：摊开这块就收起大纲）→ `ui`；
 *   反方向（大纲打开时收起这块）经 `ui.setCloseRecentDrawer` 注入，`toc` 不认识本模块。
 */
import { windowKind } from "../core/app-state";
import { doOpen } from "../io/files";
import { CODICONS } from "../shell/codicons";
import { applyDrawerWidth, applySidebarVisible, isSidebarOff, setSideOpen } from "../toc";
import {
  recentClear,
  recentCount,
  recentList,
  recentPanel,
  setCloseRecentDrawer,
  showMessage,
  sideRecent,
} from "../ui";
import {
  clearRecentEntries,
  forgetRecentEntry,
  getRecentLimit,
  getRecents,
  onRecentsChange,
} from "./store";
import type { RecentEntry } from "../ipc/api";

/** 键与监听只装一次：重复装配会让一次点击触发好几遍（测试里逐用例重新装配时尤其明显）。 */
let wired = false;

export function setupRecentsPanel(): void {
  sideRecent.innerHTML = CODICONS.history;
  recentClear.innerHTML = CODICONS.trash;
  setCloseRecentDrawer(() => setRecentOpen(false));
  onRecentsChange(() => renderRecents());
  if (!wired) {
    wired = true;
    sideRecent.addEventListener("click", () => toggleRecentPanel());
    recentClear.addEventListener("click", () => void clearAll());
    recentList.addEventListener("click", (e) => onListClick(e));
  }
  renderRecents();
}

/**
 * `#recent-panel` 显隐的**唯一出口**：面板 `hidden` + 键的 `is-on` / `aria-pressed`
 * 三处同源（与 `setSideOpen` 同一纪律 —— 半同步就会长出「面板开着而键是灭的」）。
 *
 * ⚠️ `hidden` 属性还不够：`.recent-panel` 的 `display: flex` 是作者样式，压得过 UA 那条
 * 隐藏规则，必须连带 `[hidden] { display: none }` 那条 CSS（见 preview.css）。jsdom 不做
 * 级联，这里断言 `hidden === true` 证明不了它真的不占位 —— 那条 CSS 由静态契约盯着。
 */
export function setRecentOpen(open: boolean): void {
  if (open) {
    // 互斥：同一刻只露一块。走 `setSideOpen` 而不是自己改 DOM —— 大纲那块的四件事
    //（面板 / 缝 / 卡片竖线 / 键点亮）只有它一个出口知道全。
    setSideOpen(false);
    // 抽屉宽度是 `attachSideResizer` 内联写在 `#toc-panel` 上的，这块得抄一份，
    // 否则「拖完分隔条再点最近打开」会看见它跳回默认宽。
    applyDrawerWidth();
  }
  recentPanel.hidden = !open;
  sideRecent.classList.toggle("is-on", open);
  sideRecent.setAttribute("aria-pressed", String(open));
  if (open) renderRecents();
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
  if (!recentPanel.hidden) {
    setRecentOpen(false);
    return;
  }
  // 整栏收着时先把它放出来（口径同 `toggleToc` 的 B198：藏在 display:none 里切显隐＝死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  setRecentOpen(true);
}

/** 按当前缓存重画。Rust 的广播、改上限、清除之后都走这里，视图自己从不缓存第二份名单。 */
export function renderRecents(): void {
  const list = getRecents();
  const cap = getRecentLimit();
  // B306：上限 0 = 功能整条关掉（Rust 那边既不记录、也把名单一起清了），入口留着只会
  // 让人点进去看一句「已停止记录」。正摊着的抽屉跟着收起 —— 门关了不许屋里还亮着，
  // 而 `is-on` / `aria-pressed` 仍由 `setRecentOpen` 那一个出口翻，这里不自己改。
  sideRecent.hidden = cap === 0;
  if (cap === 0 && !recentPanel.hidden) setRecentOpen(false);
  recentCount.textContent = `${list.length}/${cap}`;
  recentCount.setAttribute("aria-label", `${list.length} 条，上限 ${cap}`);
  recentClear.setAttribute("data-tip", list.length === 0 ? "没有可清空的记录" : "清空全部");
  recentList.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    // 两种空态得分开说：「还没关过」与「不再记录」是两件不同的事，
    // 混成一句，用户把上限调成 0 之后会以为功能坏了。
    empty.textContent = cap === 0 ? "已停止记录（上限为 0）" : "还没有关掉过的文件";
    recentList.append(empty);
    return;
  }
  for (const e of list) recentList.append(rowOf(e));
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
  dir.className = "recent-dir";
  dir.textContent = dirOf(e.path);
  line.append(name, dir);

  const del = document.createElement("button");
  del.className = "recent-del";
  del.type = "button";
  del.innerHTML = CODICONS.close;
  del.setAttribute("aria-label", `从最近打开里移除 ${e.name}`);

  // 完整路径与相对时间挂在悬停浮层上：行里两处都做了截断，看全的地方必须有。
  row.setAttribute("data-tip", e.path);
  row.setAttribute("data-tip-detail", relativeTime(e.closedAt));
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
 * 相对时间。先按**日历天**分档再谈小时：跨了天还说「23 小时前」，用户读作「今天」，
 * 而「昨天」才是他要的那个信息。
 * 分档：刚刚（<1 分）/ N 分钟前 / N 小时前（同一天内）/ 昨天 HH:mm / M月D日 HH:mm（同年）/
 * YYYY年M月D日（跨年）。
 */
export function relativeTime(closedAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - closedAt);
  const from = new Date(closedAt);
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

/** 行第二截那串目录：去掉最后一段。`C:\a\b.md → C:\a`，`bare.md → ""`。 */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (i < 0) return "";
  if (i === 0) return "/";
  return path.slice(0, i);
}
