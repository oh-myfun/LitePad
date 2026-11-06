/**
 * B461 · Task 9 —— 左侧栏第五块「差异」：按**差异块**列出，点一条两侧同时落位，高亮跟着右栏光标。
 *
 * 一句话的职责：把 surface 那一摞块（`DiffSurface.blocks()`）**誊**成一列可读的行，
 * 外加「点这一行 = 跳那一块」。不重算对齐、不自存块表 —— 设计稿 ⑥ 的同源口径：
 * 两侧底色、占位块、跳块与这一列吃的是同一份答案，谁再算一遍就是第二份真相
 * （`tests/diff-drawer-contract.test.ts` 按「本模块不许出现对齐内核」钉住）。
 *
 * 三条刷新路，全部收在 `updateDiffDrawer` 一处：
 *   · 摊开这一块（外壳的 `onShow`）；
 *   · 块表变了（`setDiffBlocksListener` —— surface 的 `syncBlocks` 末尾与挂上旁路那一刻广播）；
 *   · 右栏光标跨过了一块（`refreshDiffAtCursor`，闸在下面那条 ⚠️）。
 *
 * ⚠️ 高亮的**权威只有右栏**（设计稿 ⑩·2）：左栏只是对照物，它里面有选区也不许抢这一列的高亮 ——
 *    所以这里问的是 `surface.activeIndex()`（它按右栏光标行算，见 `surface.ts`），不读左栏。
 * ⚠️ 光标跟随**要装闸**（B388 那条纪律）：比的是「活动块序号变没变」而不是「有没有选区事件」——
 *    方向键每按一下都会走到这里，无闸就是每键一次全量重建 DOM。
 * ⚠️ 那一列行是**上一次画的那一格**的（`renderedPanelId`）：分屏下点另一格面板不会重画这里，
 *    所以点击按它寻址、并把那一格设为活动格 —— 否则就是「两侧都动了、那一格还不是活动格」的半跳。
 * ⚠️ 这颗键的点击**必须在这里挂**：`registerDrawerView` 只管显隐与亮灭（B314-8 那颗死键）。
 */
import { activePanelId, panels, windowKind, type Panel } from "../core/app-state";
import { activePanel } from "../core/panels";
import { diffCount, diffList, diffPanel, markActivePanel, sideDiff } from "../ui";
import { applySidebarVisible, isSidebarOff } from "../toc";
import { CODICONS } from "../shell/codicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
import { setTextTip } from "../shell/tooltip";
import type { DiffBlock, DiffKind } from "./blocks";
import { setDiffBlocksListener, type DiffSide } from "./model";
import { diffSurfaceOf, type DiffSurface } from "./surface";

/** 一行的全部读数（纯函数出，DOM 只照着画 —— 用例据此测「一块一行」而不碰 DOM）。 */
export interface DiffRow {
  index: number;
  kind: DiffKind;
  added: number;
  removed: number;
  /** 那一块首行的正文（截断）；删除块右栏没有真行 ⇒ 取左栏那行并前置 `−`。 */
  summary: string;
  /** 「左 → 右」的行区间，形如 `2–4 → 2–5`；某侧是空段时写它的**落点行**（单个数字）。 */
  range: string;
}

/** 摘要最长多少字（超过补省略号；完整那串走 tooltip）。 */
const SUMMARY_MAX = 80;

/** 行区间那一形：空段（`start > end`，这一侧没有真行）报落点行 = `end + 1`（与 `landingLine` 同一口径）。 */
function spanText(start: number, end: number): string {
  return start > end ? String(end + 1) : `${start}–${end}`;
}

function cut(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/**
 * 一块一行。`readLine` 由调用方给（面板交生产那两份文档的读数口，用例交 `Text`）——
 * 有了这颗注入，本函数是纯的：块表进、行读数出，不碰 view 也不碰 DOM。
 */
export function diffRowsOf(
  blocks: DiffBlock[],
  readLine: (side: DiffSide, n: number) => string,
): DiffRow[] {
  return blocks.map((b, index) => {
    // 右栏是空段 = 这一块的行全在左栏（删除）⇒ 摘要只能取左栏，并给一个「被删掉」的前置号。
    const deleted = b.modifiedStart > b.modifiedEnd;
    const read = deleted
      ? readLine("original", b.originalStart)
      : readLine("modified", b.modifiedStart);
    const text = read.trim();
    return {
      index,
      kind: b.kind,
      added: b.added,
      removed: b.removed,
      summary: `${deleted ? "−" : ""}${cut(text || "（空行）")}`,
      range: `${spanText(b.originalStart, b.originalEnd)} → ${spanText(b.modifiedStart, b.modifiedEnd)}`,
    };
  });
}

/** 空态那两句话（一句「这一格现在不是差异编辑器」，一句「是，但没有差异」——两种白屏用户得分得清）。 */
export function emptyTextFor(kind: "notDiff" | "noBlocks"): string {
  return kind === "notDiff" ? "当前标签不是差异编辑器" : "两份内容一致 —— 没有差异项";
}

/** 上一次画的是**哪一格**的旁路（见文件头那条 ⚠️：分屏下抽屉里的行不等于活动面板的行）。 */
let renderedPanelId: number | null = null;
/** 上一次画时亮的是第几块（-1 = 都没亮）。光标跟随的闸门比的就是它（B388）。 */
let renderedActiveIndex = -1;

/** 两侧正文的读数口：左栏吃旁路那颗只读 view，右栏吃这一格既有的 `Panel.view`（= 那份文档本身）。 */
function lineReaderOf(panel: Panel, surface: DiffSurface): (side: DiffSide, n: number) => string {
  const sides = [surface.left.state.doc, panel.view?.view.state.doc ?? null];
  return (side, n) => {
    const doc = sides[side === "original" ? 0 : 1];
    if (!doc) return "";
    // 行号夹到本栏的首/末行：块表按另一栏算，两栏可能差一步（与 `surface.ts` 的 `lineStartOf` 同理）。
    return doc.line(Math.min(Math.max(n, 1), doc.lines)).text;
  };
}

function iconFor(kind: DiffKind): string {
  if (kind === "insert") return CODICONS.arrowUp;
  if (kind === "delete") return CODICONS.arrowDown;
  return CODICONS.diff;
}

/** 徽标那一格：行级块表里 `added` 与 `removed` 恒不同时非零（各是 `max(差, 0)`），所以只会出现一边。 */
function badgeFor(row: DiffRow): string {
  if (row.added) return `+${row.added}`;
  return row.removed ? `−${row.removed}` : "";
}

function makeEmpty(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "diff-empty";
  el.textContent = text;
  return el;
}

function makeRow(row: DiffRow): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "diff-item";
  el.dataset.index = String(row.index);
  // 三族颜色挂在形状上（`data-kind`），DOM 与判据问的都是同一件事：这一块是哪一族。
  el.dataset.kind = row.kind;

  const icon = document.createElement("span");
  icon.className = "diff-icon";
  icon.innerHTML = iconFor(row.kind);

  const badge = document.createElement("span");
  badge.className = "diff-badge";
  badge.textContent = badgeFor(row);

  const text = document.createElement("span");
  text.className = "diff-text";
  text.textContent = row.summary;

  const lines = document.createElement("span");
  lines.className = "diff-lines";
  lines.textContent = row.range;

  el.append(icon, text, badge, lines);
  // 摘要那一截会被截断，提示给完整的一行 + 区间（文本档：跟着鼠标走、不带尖尖，口径同大纲）。
  setTextTip(el, `${row.summary}  ${row.range}`);
  if (row.index === renderedActiveIndex) el.classList.add("diff-active");
  return el;
}

/** 画这一列（**只清 `#diff-list`**：头部常驻，B205 那条纪律 —— 连头部一起换就是把标题抹掉）。 */
export function updateDiffDrawer(): void {
  const panel = activePanel();
  const surface = diffSurfaceOf(panel);
  const blocks = surface?.blocks() ?? [];
  renderedPanelId = surface && panel ? panel.panelId : null;
  renderedActiveIndex = surface ? surface.activeIndex() : -1;
  diffCount.textContent = surface ? String(blocks.length) : "";
  diffList.textContent = "";
  if (!panel || !surface) {
    diffList.append(makeEmpty(emptyTextFor("notDiff")));
    return;
  }
  const rows = diffRowsOf(blocks, lineReaderOf(panel, surface));
  if (rows.length === 0) {
    diffList.append(makeEmpty(emptyTextFor("noBlocks")));
    return;
  }
  for (const row of rows) diffList.append(makeRow(row));
}

/**
 * 光标跟随（右栏权威，带闸）。
 *
 * 三条早退各有其故：
 *   · `diffPanel.hidden` —— 轮不到这一块（含整栏收起）时一个字都不画，口径同 `toc.ts` 的 `tocPanel.hidden`；
 *   · 没有旁路 —— 光标已经离开差异标签（切标签 / 切面板），高亮**保持最后那块**（设计稿 ⑩·2）；
 *   · 序号没变 —— 方向键走过同一块内的每一列都不该重建这一列（B388）。
 */
export function refreshDiffAtCursor(): void {
  if (diffPanel.hidden) return;
  const panel = activePanel();
  const surface = diffSurfaceOf(panel);
  // 没有旁路 = 光标已经离开差异标签（切标签 / 切面板）⇒ 高亮保持最后那块，不清。
  if (!surface || panel?.panelId !== renderedPanelId) return;
  const next = surface.activeIndex();
  if (next === renderedActiveIndex) return;
  updateDiffDrawer();
}

/**
 * 点一条：先把那一格设为活动格（分屏下的半跳状态由这一步消掉），再让两侧同时落到那一块。
 *
 * 陈旧那一头：列表是上一次画的，而旁路可能已经被拆掉（那张标签被切走了）—— 此时**就地重画**，
 * 用户立刻看到那句「当前标签不是差异编辑器」，而不是留着一行点了不动的死条目。
 */
function onRowClick(index: number): void {
  const panel = panels.get(renderedPanelId ?? -1);
  const surface = diffSurfaceOf(panel);
  if (!panel || !surface) {
    updateDiffDrawer();
    return;
  }
  if (panel.panelId !== activePanelId) markActivePanel(panel.panelId);
  surface.jumpTo(index);
  updateDiffDrawer();
}

/** 摊开 / 收起这一块（按钮列那颗键；口径逐字照 `search/panel.ts` 的 `toggleSearch`）。 */
function toggleDiff(): void {
  if (windowKind === "satellite") return;
  if (activeDrawer() === "diff") {
    setDrawer(null);
    return;
  }
  // 整栏收着时先把它放出来（B198：藏在 display:none 里切显隐 = 死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("diff");
}

export function setupDiffPanel(): void {
  sideDiff.innerHTML = CODICONS.diff;
  registerDrawerView("diff", { panel: diffPanel, button: sideDiff, onShow: updateDiffDrawer });
  // 委托：条目只在重绘时换新，一颗列表级监听比 N 颗行级监听少一处脱链。
  diffList.addEventListener("click", (e) => {
    const item = (e.target as Element).closest?.(".diff-item") as HTMLElement | null;
    if (!item) return;
    onRowClick(Number(item.dataset.index));
  });
  sideDiff.addEventListener("click", () => toggleDiff());
  setDiffBlocksListener(() => updateDiffDrawer());
}
