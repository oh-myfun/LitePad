/**
 * B389 · 侧栏搜索视图（「在文件中查找」那一块，键位归 `shell/keymap` 的 `edit.findInFiles`）。
 *
 * 只做四件事：把输入区那几格与模型层**接上**（改的是模型，不在这里存第二份状态）、
 * 把结果树画出来、把「点一条命中」转成一次跳转、以及把那颗按钮列的键**装上点击**。
 * **不搜、不判范围、不算文案** —— 那些在 `./store.ts`；**不写盘、不改文档** —— 那些在
 * `./replace.ts`。视图再判一遍就是两套口径（B304 那一族的教训）。
 *
 * 结构与几何逐条照 VS Code 的搜索视图（`searchView.ts` 的 renderBody + `searchview.css`）：
 * 标题栏 → 搜索行（左缘那根 16px 的展开替换键）→ 替换行 → `.query-details`（⋯ + 两行 glob）
 * → 计数行 → 结果树。行内开关复用悬浮查找栏那一套（`.find-field` / `.find-toggle`），
 * 于是「同一族控件在两个地方长得不一样」这件事从一开始就不成立。
 *
 * B417 补齐 VS Code 的三样东西（都照那边的注册表取名，不发明新形状）：
 *   · 包含框里的「仅在打开的编辑器中搜索」= `patternInputWidget` 的 `useSearchInEditorsBox`（Codicon.book）；
 *   · 替换框里的「保留大小写」= 查找栏同款 AB 开关（`editor.find.ts` 的 `preserveCase`，Rust 侧同规则）；
 *   · 结果文件行的行内动作 = `MenuId.SearchActionMenu` 的 inline 组：Dismiss（清这一屏）+ 在文件中全部替换。
 *
 * B419（用户）：命中数改成 VS Code 的 count badge（圆角徽标，动作键出现时让位）；每条命中行
 * 也补同一组动作（替换这一处 / 清除这一条）；计数文案收成一句「在 N 个文件中找到 M 个结果」
 * （不再按范围换三种说法）。
 * ⚠️ 计数行（`#search-count`）在骨架上必须是 `.search-widgets` 的**兄弟** —— VS Code 的
 *    `.messages` 也是 `.search-widgets-container` 的兄弟；嵌进去时那条 -5px 上沿会压进
 *    「要排除的文件」输入框（B417 真机截图抓到）。
 *
 * ⚠️ 那颗按钮列的键的点击**必须在这里挂**：`registerDrawerView` 只管「显隐与亮灭怎么算」，
 *    不接管点击（B314-8 真机抓到过：漏一句就是一颗看着正常、点下去毫无反应的死键）。
 */
import { activePanelId, panels, windowKind, type Tab } from "../core/app-state";
import { activePanel, visibleInstancesOfDoc } from "../core/panels";
import { detectLanguage } from "../editor/language";
import { doOpen } from "../io/files";
import { switchTab } from "../tabs";
import {
  markActivePanel,
  searchCase,
  searchClear,
  searchCollapseAll,
  searchCount,
  searchDetails,
  searchDetailsToggle,
  searchExclude,
  searchInclude,
  searchInput,
  searchOpenEditors,
  searchPanel,
  searchPreserveCase,
  searchRefresh,
  searchReplaceAll,
  searchReplaceInput,
  searchReplaceRow,
  searchRegex,
  searchResults,
  searchToggleReplace,
  searchUseExcludes,
  searchWord,
  sideSearch,
} from "../ui";
import { applySidebarVisible, isSidebarOff, refreshTocAtCursor } from "../toc";
import { CODICONS } from "../shell/codicons";
import { fileIconHtml } from "../shell/fileicons";
import { activeDrawer, registerDrawerView, setDrawer } from "../shell/drawer";
import { setTextTip } from "../shell/tooltip";
import { EditorView } from "@codemirror/view";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  clearAll,
  collapseAll,
  dismissFile,
  dismissMatch,
  emptyMessage,
  expandAll,
  getGroups,
  getQuery,
  isCollapsed,
  isInvalid,
  onSearchChange,
  openDocIdFor,
  planReplace,
  planReplaceFor,
  runNow,
  scopeNote,
  sections,
  searchedRootCount,
  setQuery,
  summaryMessage,
  isBadNews,
  toggleFile,
  type FileGroup,
  type ReplacePlan,
  type RootSection,
} from "./store";
import {
  applyReplaceAll,
  replaceOutcomeText,
  replaceSingleMatch,
  type MatchTarget,
  type ReplaceOutcome,
} from "./replace";
import type { SearchMatchRow } from "../ipc/api";

/** 替换行开没开。**视图自己的状态**：它既不影响搜索结果，也不该落到设置里
 *  （VS Code 也不存 —— 那边是 `SearchWidget` 的一次性状态）。 */
let replaceShown = false;
/** 最后一次点过的那一行（结果树里的选中态）；按路径 + 行号认，重绘之后仍能指回同一行。 */
let selected: { path: string; line: number } | null = null;
/** 正在替换：那一发是异步的，期间把「全部替换」键压住，免得连点成两遍。 */
let replacing = false;

// ---------------------------------------------------------------- 装配

export function setupSearch(): void {
  sideSearch.innerHTML = CODICONS.searchLarge;
  searchToggleReplace.innerHTML = CODICONS.chevronRight;
  searchCase.innerHTML = CODICONS.caseSensitive;
  searchWord.innerHTML = CODICONS.wholeWord;
  searchRegex.innerHTML = CODICONS.regex;
  searchReplaceAll.innerHTML = CODICONS.replaceAll;
  searchPreserveCase.innerHTML = CODICONS.preserveCase;
  searchOpenEditors.innerHTML = CODICONS.book;
  searchUseExcludes.innerHTML = CODICONS.exclude;
  setTextTip(searchPreserveCase, "替换时保留被替换文本的大小写");
  setTextTip(searchOpenEditors, "仅在打开的编辑器中搜索");
  setTextTip(searchUseExcludes, "使用排除设置与忽略文件");
  searchDetailsToggle.innerHTML = CODICONS.ellipsis;
  searchRefresh.innerHTML = CODICONS.refresh;
  searchCollapseAll.innerHTML = CODICONS.collapseAll;
  searchClear.innerHTML = CODICONS.clearAll;

  registerDrawerView("search", {
    panel: searchPanel,
    button: sideSearch,
    onShow: () => {
      render();
      searchInput.focus();
      searchInput.select();
    },
  });
  // ⚠️ 这一句就是 B314-8 那条教训的本体：登记视图 ≠ 挂按钮。
  sideSearch.addEventListener("click", () => toggleSearch());

  searchInput.addEventListener("input", () => setQuery({ text: searchInput.value }));
  searchInput.addEventListener("keydown", (e) => {
    // 回车 = 立刻搜（与输入即搜那 300ms 去抖是两条路：用户按下回车时不打算再等一截）
    if (e.key === "Enter") {
      e.preventDefault();
      void runNow();
    }
  });
  searchCase.addEventListener("click", () =>
    setQuery({ caseSensitive: !getQuery().caseSensitive }),
  );
  searchWord.addEventListener("click", () => setQuery({ wholeWord: !getQuery().wholeWord }));
  searchRegex.addEventListener("click", () => setQuery({ regexp: !getQuery().regexp }));

  searchReplaceInput.addEventListener("input", () =>
    setQuery({ replaceText: searchReplaceInput.value }),
  );
  searchReplaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void replaceAll();
    }
  });
  searchPreserveCase.addEventListener("click", () =>
    setQuery({ preserveCase: !getQuery().preserveCase }),
  );
  searchToggleReplace.addEventListener("click", () => setReplaceShown(!replaceShown));
  searchDetailsToggle.addEventListener("click", () =>
    setQuery({ detailsOpen: !getQuery().detailsOpen }),
  );
  searchInclude.addEventListener("input", () => setQuery({ include: searchInclude.value }));
  searchExclude.addEventListener("input", () => setQuery({ exclude: searchExclude.value }));
  searchOpenEditors.addEventListener("click", () =>
    setQuery({ onlyOpenEditors: !getQuery().onlyOpenEditors }),
  );
  // B421：这颗键关掉 = 不读 `.gitignore` / `.ignore`、也不跳点文件与噪声目录（VS Code 同义）。
  searchUseExcludes.addEventListener("click", () =>
    setQuery({ useExcludes: !getQuery().useExcludes }),
  );
  searchRefresh.addEventListener("click", () => void runNow());
  searchClear.addEventListener("click", () => {
    clearAll();
    selected = null;
  });
  searchCollapseAll.addEventListener("click", () => {
    if (allCollapsed()) expandAll();
    else collapseAll();
  });
  searchReplaceAll.addEventListener("click", () => void replaceAll());
  searchResults.addEventListener("click", (e) => onTreeClick(e as MouseEvent));
  // 文件行从 `<button>` 换成了 `div[role=treeitem]`（行内要放动作键，button 套 button 不合法），
  // 键盘上的回车 / 空格仍按「点这一行」处理 —— 原先 button 天生带的语义不许丢。
  searchResults.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // B419：命中行也从 `<button>` 换成了 `div[role=treeitem]`（行内要放动作键）——
    // 「回车 / 空格 = 点这一行」的语义对两层都要补回来。
    const row = (e.target as Element).closest?.(".search-file, .search-line") as HTMLElement | null;
    if (!row || e.target !== row) return;
    e.preventDefault();
    row.click();
  });
  onSearchChange(render);
  render();
}

// ---------------------------------------------------------------- 开合

/** 摊开 / 收起搜索这一块（按钮列那颗 / 命令面板那一路都走这里）。 */
export function toggleSearch(): void {
  if (windowKind === "satellite") return;
  if (activeDrawer() === "search") {
    setDrawer(null);
    return;
  }
  // 整栏收着时先把它放出来（口径同 `toggleToc` 的 B198：藏在 display:none 里切显隐＝死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("search");
}

/**
 * 从命令 / 快捷键摊开搜索，并把当前选区灌进去（VS Code `workbench.action.findInFiles`
 * 的手感：按下去就已经把要搜的那词填好了）。框里已经有字时**不覆盖** —— 用户再按一次
 * 通常只是想回到那个面板，不是想丢掉刚打的那串。
 *
 * `showReplace` 那一档是「在文件中替换」（VS Code `workbench.action.replaceInFiles`）：
 * 同一个面板，只是顺手把替换行掀开、焦点交给替换框 —— 另起一块面板就是两套口径了。
 */
export function openSearchView(showReplace = false): void {
  if (windowKind === "satellite") return;
  if (isSidebarOff()) applySidebarVisible(false);
  setDrawer("search");
  if (showReplace) {
    setReplaceShown(true);
    searchReplaceInput.focus();
  }
  const seed = selectedTextInActiveView();
  if (seed && !searchInput.value) {
    setQuery({ text: seed });
    // 改的是模型，框里那句要跟着画出来：`setQuery` 只排了去抖，等它跑完已经是 300ms 之后，
    // 用户按下快捷键看见的是一个**空框**。
    render();
  }
}

/** 活动视图选中的文本（单行且非空才作为种子；口径同 `find/findbar.ts`）。 */
function selectedTextInActiveView(): string {
  const view = activePanel()?.view?.view;
  if (!view) return "";
  const sel = view.state.selection.main;
  if (sel.empty) return "";
  const text = view.state.sliceDoc(sel.from, sel.to);
  return text.includes("\n") ? "" : text;
}

function setReplaceShown(on: boolean): void {
  replaceShown = on;
  searchReplaceRow.hidden = !on;
  searchPanel.classList.toggle("is-replace-shown", on);
  searchToggleReplace.innerHTML = on ? CODICONS.chevronDown : CODICONS.chevronRight;
  const label = on ? "折叠替换" : "展开替换";
  searchToggleReplace.setAttribute("aria-label", label);
  searchToggleReplace.setAttribute("data-tip", label);
  searchToggleReplace.setAttribute("aria-expanded", String(on));
  // B417：结果行上那颗「在文件中全部替换」只在替换行摊开时才有意义（VS Code 同款——
  // `ReplaceAllInFileAction` 挂的 when 是 `ReplaceActiveKey`）⇒ 展开/收起要重画一遍。
  render();
}

// ---------------------------------------------------------------- 重绘

/** 全量键当前会做哪一支（一条结果都没有时算「没折着」，与大纲那颗同口径）。 */
function allCollapsed(): boolean {
  const groups = getGroups();
  return groups.length > 0 && groups.every((g) => isCollapsed(g.path));
}

/** 把模型里的状态搬到控件上：三档亮灭、⋯ 开合、两行 glob、计数行、非法标红。 */
function syncControls(): void {
  const q = getQuery();
  syncToggle(searchCase, q.caseSensitive);
  syncToggle(searchWord, q.wholeWord);
  syncToggle(searchRegex, q.regexp);
  syncToggle(searchPreserveCase, q.preserveCase);
  syncToggle(searchOpenEditors, q.onlyOpenEditors);
  syncToggle(searchUseExcludes, q.useExcludes);
  // ⚠️ 只在值真的不一样时才回写：`input` 事件里刚把用户的字送进模型，
  //    这里无差别再写一遍会把光标弹到串首（打字的每一个键都会弹）。
  if (searchInput.value !== q.text) searchInput.value = q.text;
  if (searchReplaceInput.value !== q.replaceText) searchReplaceInput.value = q.replaceText;
  if (searchInclude.value !== q.include) searchInclude.value = q.include;
  if (searchExclude.value !== q.exclude) searchExclude.value = q.exclude;
  searchDetails.classList.toggle("is-more", q.detailsOpen);
  searchDetailsToggle.setAttribute("aria-expanded", String(q.detailsOpen));

  const bad = isInvalid();
  searchInput.closest(".search-field")?.classList.toggle("is-invalid", bad);
  searchRegex.classList.toggle("is-bad", bad);
  searchReplaceAll.disabled = replacing || getGroups().length === 0;

  const folded = allCollapsed();
  searchCollapseAll.innerHTML = folded ? CODICONS.expandAll : CODICONS.collapseAll;
  const foldLabel = folded ? "全部展开" : "全部折叠";
  searchCollapseAll.setAttribute("aria-label", foldLabel);
  searchCollapseAll.setAttribute("data-tip", foldLabel);
  searchCollapseAll.setAttribute("aria-pressed", String(folded));

  const summary = summaryMessage();
  searchCount.textContent = summary;
  // 计数行只在「说坏消息」时变红：非法正则与后端报错（`summaryMessage` 把原话放在这一格）
  searchCount.classList.toggle("is-bad", isBadNews());
}

function syncToggle(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
}

/** 整块重绘：计数行 + 结果树。⚠️ 标题栏是静态结构，这里只动 `#search-results`（B205 那条）。 */
function render(): void {
  syncControls();
  const groups = getGroups();
  // 说明行只有两种话要说：范围（没打开文件夹时那一截，**有结果也要说** —— 用户口径第一条），
  // 以及一条都没有时的引导。它排在结果**之上**（VS Code 的 `.message` 也在 results 前面），
  // 且计数行已经念过「未找到结果。」，这里不重复（B304 那一族）。
  const note = groups.length === 0 ? emptyMessage() : scopeNote();
  const parts: Node[] = [];
  if (note) {
    const el = document.createElement("div");
    el.className = "search-note";
    el.textContent = note;
    parts.push(el);
  }
  const list = sections();
  // B424（用户「按打开的目录树状归类，独立打开的文件单独列」）：分节表由模型算好，视图只画。
  // **只有一根、且结果全在这一根里时不套容器、不画那行头** —— 那一行只是把标题栏下面那句
  // 话重念一遍，而多套一层 div 只会让现有的行选择器多一个层级要解释。
  const headed = list.length > 1 || searchedRootCount() > 1;
  for (const section of list) {
    if (!headed) {
      for (const group of section.groups) parts.push(fileRow(group));
      continue;
    }
    const box = document.createElement("div");
    box.className = "search-section";
    box.append(rootRow(section), ...section.groups.map(fileRow));
    parts.push(box);
  }
  searchResults.replaceChildren(...parts);
}

/**
 * 一节的那一行头（B424）：某一根 ⇒ 目录名 + 完整路径走提示；null ⇒ 「单独打开的文件」
 * （开在标签里、但不在这几根内的那些，含从没存过盘的那一份）。
 * 不画折叠箭头：可折的是**文件**那一层（`collapseAll` / 那颗全折键的口径没变）。
 */
function rootRow(section: RootSection): HTMLElement {
  const row = document.createElement("div");
  row.className = "search-root";
  row.setAttribute("role", "treeitem");
  const name = document.createElement("span");
  name.className = "search-root-name";
  name.textContent = section.root ? baseName(section.root) : "单独打开的文件";
  row.append(name);
  if (section.root) {
    const path = document.createElement("span");
    path.className = "search-root-path";
    path.textContent = parentPathOf(section.root);
    row.append(path);
    setTextTip(row, section.root);
  }
  const count = document.createElement("span");
  // B426：这一格与文件行那颗命中数徽标是同一颗盒（`.search-badge` 管几何与颜色，
  // 每族主题的 `--badge-bg/--badge-fg` 一份），`search-root-count` 只留作选择器。
  count.className = "search-root-count search-badge";
  count.textContent = String(section.groups.length);
  row.append(count);
  return row;
}

/** 路径最后一段 / 它上一层（灰字那截与文件行同一口径：名字加粗、余下的弱色）。 */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

function parentPathOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i <= 0) return "";
  // 盘符那一层要连着分隔符才读得出是「某一根的上一层」：`E:` 单看着像一句没写完的话。
  const head = trimmed.slice(0, i);
  return /^[a-zA-Z]:$/.test(head) ? `${head}\\` : head;
}

/** 结果行里的一颗动作键（B417：清除此文件 / 在文件中全部替换）。 */
function rowAction(
  act: string,
  icon: keyof typeof CODICONS,
  label: string,
  tip: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "search-rowbtn";
  // 动作按钮自己的提示已说明干什么；行本身也有提示，挂同一组里省得叠两层
  b.dataset.act = act;
  b.innerHTML = CODICONS[icon];
  b.setAttribute("aria-label", label);
  setTextTip(b, tip);
  return b;
}

/**
 * 文件行：箭头槽 + Seti 图标 + 名字 + 灰字路径 + 命中数 + 行内动作（B417）。
 *
 * ⚠️ 行本体是 `div[role=treeitem]` 而非 `<button>`：行内要放两颗动作键，button 套 button
 *    不合法（点哪颗都由外层的 click 委托接管，键盘的 Enter / 空格在 `setupSearch` 里补）。
 * 动作键照 VS Code `MenuId.SearchActionMenu` 的 inline 组：
 *   · `ReplaceAllInFileAction`（在文件中全部替换，只在替换行摊开时出现）；
 *   · `RemoveAction`（Dismiss = 从这一屏清掉这个文件的结果）。
 * 一律 `textContent`（文件名里可以有 `<`）。
 */
function fileRow(group: FileGroup): DocumentFragment {
  const frag = document.createDocumentFragment();
  const collapsed = isCollapsed(group.path);

  const row = document.createElement("div");
  row.className = "search-file";
  row.tabIndex = 0;
  row.dataset.path = group.path;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-expanded", String(!collapsed));
  row.setAttribute("aria-selected", String(selected?.path === group.path && selected.line === 0));
  const twisty = document.createElement("span");
  twisty.className = "search-twisty";
  twisty.innerHTML = collapsed ? CODICONS.chevronRight : CODICONS.chevronDown;
  const glyph = document.createElement("span");
  glyph.className = "search-glyph";
  glyph.innerHTML = fileIconHtml(detectLanguage(group.name).label);
  const name = document.createElement("span");
  name.className = "search-filename";
  name.textContent = group.name;
  const rel = document.createElement("span");
  rel.className = "search-rel";
  rel.textContent = group.rel === group.name ? "" : group.rel;
  const badge = document.createElement("span");
  badge.className = "search-badge";
  badge.textContent = `${group.rows.length}${group.truncated ? "…" : ""}`;
  row.append(twisty, glyph, name, rel, badge);
  const actions = document.createElement("span");
  actions.className = "search-row-actions";
  if (replaceShown) {
    actions.append(rowAction("replace-file", "replaceAll", "在文件中全部替换", "在文件中全部替换"));
  }
  actions.append(rowAction("dismiss", "close", "清除此文件的结果", "从结果中清除此文件"));
  row.append(actions);
  setTextTip(row, group.path);

  frag.append(row);
  const kids = document.createElement("div");
  kids.className = "search-lines";
  kids.setAttribute("role", "group");
  kids.hidden = collapsed;
  for (const m of group.rows) kids.append(lineRow(group, m));
  frag.append(kids);
  return frag;
}

/**
 * 一行命中：行号 + 「前 / 命中 / 后」三段（`start` / `length` 是预览里的**字符**下标）。
 *
 * B419（用户）：每条结果也要有「替换 / 清除」两颗键 —— 与文件行同一套 `.search-row-actions`
 * （悬停 / 聚焦才出来，徽标在动作出现时让位）。VS Code 的 `MenuId.SearchActionMenu` 里
 * `ReplaceAction` 的 when 带 `ReplaceActiveKey`（替换区展开才出现），`DismissAction` 常在。
 * ⚠️ 行本体因此从 `<button>` 换成 `div[role=treeitem]`：button 套 button 不合法。
 *    键盘回车 / 空格在 `setupSearch` 的 keydown 里补（与文件行同一条）。
 */
function lineRow(group: FileGroup, m: SearchMatchRow): HTMLElement {
  const row = document.createElement("div");
  row.className = "search-line";
  row.tabIndex = 0;
  row.dataset.path = group.path;
  row.dataset.line = String(m.line);
  row.dataset.column = String(m.column);
  row.dataset.length = String(m.length);
  row.setAttribute("role", "treeitem");
  row.setAttribute(
    "aria-selected",
    String(selected?.path === group.path && selected?.line === m.line),
  );
  const num = document.createElement("span");
  num.className = "search-linenum";
  num.textContent = String(m.line);
  const chars = Array.from(m.preview);
  const text = document.createElement("span");
  text.className = "search-linetext";
  const before = document.createElement("span");
  before.textContent = chars.slice(0, m.start).join("");
  const hit = document.createElement("span");
  hit.className = "search-hit";
  hit.textContent = chars.slice(m.start, m.start + m.length).join("");
  const after = document.createElement("span");
  after.textContent = chars.slice(m.start + m.length).join("");
  text.append(before, hit, after);
  const actions = document.createElement("span");
  actions.className = "search-row-actions";
  if (replaceShown) {
    actions.append(rowAction("replace-match", "replace", "替换这一处", "替换这一处"));
  }
  actions.append(rowAction("dismiss-match", "close", "清除这一条结果", "从结果中清除这一条"));
  row.append(num, text, actions);
  setTextTip(row, `${group.path}:${m.line}`);
  return row;
}

// ---------------------------------------------------------------- 跳转

/** 结果树里的一下点击：动作键 = 清除 / 替换（文件行或命中行）；文件行 = 折 / 展；命中行 = 选中并跳过去。 */
function onTreeClick(e: MouseEvent): void {
  const action = (e.target as Element).closest?.(".search-rowbtn") as HTMLElement | null;
  if (action) {
    // 命中行动作键不在 `.search-file` 里面（`.search-lines` 是文件行的**兄弟**），
    // 所以两个宿主都要认 —— 只认 `.search-file` 时命中行的键会掉进「什么都没发生」。
    const host = action.closest(".search-file, .search-line") as HTMLElement | null;
    const path = host?.dataset.path ?? "";
    if (!path) return;
    if (action.dataset.act === "dismiss") {
      if (selected?.path === path) selected = null;
      dismissFile(path);
    } else if (action.dataset.act === "replace-file") {
      void replaceFile(path);
    } else if (action.dataset.act === "dismiss-match") {
      const line = Number(host?.dataset.line);
      const column = Number(host?.dataset.column);
      if (!Number.isFinite(line) || !Number.isFinite(column)) return;
      if (selected?.path === path && selected.line === line) selected = null;
      dismissMatch(path, line, column);
    } else if (action.dataset.act === "replace-match") {
      const line = Number(host?.dataset.line);
      const column = Number(host?.dataset.column);
      if (!Number.isFinite(line) || !Number.isFinite(column)) return;
      void replaceMatch(path, line, column);
    }
    return;
  }
  const line = (e.target as Element).closest?.(".search-line") as HTMLElement | null;
  if (line) {
    void jumpToLine(line);
    return;
  }
  const file = (e.target as Element).closest?.(".search-file") as HTMLElement | null;
  if (file?.dataset.path) {
    selected = { path: file.dataset.path, line: 0 };
    toggleFile(file.dataset.path);
  }
}

/**
 * 跳一条命中：开着的文档直接切过去并选中；没开的先 `doOpen`（与资源管理器、拖放、
 * 最近打开同一扇漏斗 ⇒ 「最近打开」的记入自动跟着生效，不必这里再报一发）。
 *
 * B420（用户「搜索结果点击没有跳转到对应行」）：两处**不许信结果里的快照** ——
 *   · `docId` 是搜索那一刻记下的。搜完之后用户可能把标签关了（对应文档 id 还在结果里），
 *     也可能把标签拖去了别的窗口（本地只剩 `panelId < 0` 的隐藏实例）。照单全收的话
 *     `instancesOfDoc` 要么空、要么拿到看不见的那份 ⇒ 点下去**一点反应都没有**。
 *     现场问一遍标签表（`openDocIdFor`），查不着就走 `doOpen`（复用 / 取回 / 新开它都管）。
 *   · 同一条文档可能开在**另一个分屏格**。只 `switchTab` 不把那格设为活动，用户盯着
 *     眼前这格看，同样是「点了没反应」—— `markActivePanel` 就地同步活动格（不重建标签条）。
 */
async function jumpToLine(el: HTMLElement): Promise<void> {
  const path = el.dataset.path ?? "";
  const line = Number(el.dataset.line);
  const column = Number(el.dataset.column);
  const length = Number(el.dataset.length);
  const group = getGroups().find((g) => g.path === path);
  if (!group || !Number.isFinite(line) || line < 1) return;
  selected = { path, line };
  let docId = openDocIdFor(path);
  if (docId !== null && visibleInstancesOfDoc(docId).length === 0) docId = null;
  if (docId === null) {
    // ⚠️ **别信 `doOpen` 的返回值**：它回的是新开那份**实例**的 tabId
    //    （`io/files.ts` 的 `doOpen` 里 `return tab.tabId`，来自 `takeInstId()`），而下面要的
    //    `visibleInstancesOfDoc` 按 `Tab.docId` 匹配 —— 两套计数器各走各的（JS 侧
    //    `core/app-state.ts` 的实例号分配、Rust 侧 `commands/mod.rs` 的分配），撞上号时是巧合，
    //    错号时就是「文件开了、没定位」，用户得再点一次。开完**现问一次表**。
    if ((await doOpen(path)) === null) return;
    docId = openDocIdFor(path);
    if (docId === null) return;
  }
  const inst = visibleInstancesOfDoc(docId)[0];
  if (!inst) return;
  if (inst.panelId !== activePanelId) markActivePanel(inst.panelId);
  switchTab(inst.panelId, inst.tabId);
  reveal(inst, line, column, length);
  render();
}

/**
 * 把落点摆到命中本身。
 * ⚠️ 用的是 `column`（整行里的字符列号）而不是 `start`（预览里的下标）：预览带着上下文
 *    一起裁过、还补了一个省略号格，按 `start` 摆会偏掉整整一截上下文长度。
 * ⚠️ 字符下标要换成 CodeMirror 的 UTF-16 单元数，中文与 emoji 都不能按字符数直接摆。
 */
function reveal(inst: Tab, line: number, column: number, length: number): void {
  const doc = inst.state.doc;
  const info = doc.line(Math.min(Math.max(1, line), doc.lines));
  const from = info.from + units(info.text, 0, column - 1);
  const to = from + units(info.text, column - 1, column - 1 + length);
  const panel = panels.get(inst.panelId);
  if (panel?.view && panel.viewTabId === inst.tabId) {
    panel.view.view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    inst.state = panel.view.view.state;
  } else {
    inst.state = inst.state.update({ selection: { anchor: from, head: to } }).state;
  }
  activePanel()?.view?.focus();
  // 大纲跟着光标那一节走（B388）：这一跳改了选区，补同一发上报，否则切过去大纲还指着旧那节
  refreshTocAtCursor(info.number);
}

/** 字符下标区间 → UTF-16 单元数。 */
function units(text: string, from: number, to: number): number {
  return Array.from(text).slice(from, to).join("").length;
}

// ---------------------------------------------------------------- 替换

/**
 * 全部替换：先确认（这一发会动盘上的文件，且**不可撤销** —— 编辑器里的撤销栈管不到
 * 没打开的那些），再交给 `./replace.ts`，最后重跑一次搜索。
 *
 * ⚠️ 重跑是必须的：不换就等于把「已替换」的旧结果继续列给用户看，而那一屏已经假了。
 * ⚠️ 次序也是必须的：重跑会 notify → 重绘 → 计数行换回「在 N 个文件中找到 M 个结果」，
 *    所以「已替换几处」要在它**之后**才写。先写就等于永远没人看得见那句话
 *    （而那一发到底是做成了还是失败了，用户只剩猜）。
 */
async function replaceAll(): Promise<void> {
  const q = getQuery();
  if (!q.text || replacing) return;
  const plan = planReplace();
  if (plan.files === 0) return;
  const where = plan.diskFiles.length
    ? `其中 ${plan.diskFiles.length} 个没开在标签里：会被直接写盘，且改完不可撤销。`
    : "这些都开在标签里：只改内存，落盘仍由各自的保存流程决定。";
  const ok = await ask(`将在 ${plan.files} 个文件的 ${plan.lines} 行里替换全部匹配。\n${where}`, {
    title: "全部替换",
    kind: "warning",
    okLabel: "替换",
    cancelLabel: "取消",
  });
  if (!ok) return;
  await runReplacePlan(plan);
}

/**
 * B417 · 结果行那颗「在文件中全部替换」（VS Code 的 `ReplaceAllInFileAction`）。
 *
 * 计划只含这一个文件，且走 `planReplaceFor` —— 确认框念的与写回的是同一份分组
 * （B389 那条纪律：两处各分一遍就会各写各的）。盘上那一个仍要确认：不可撤销。
 */
async function replaceFile(path: string): Promise<void> {
  if (!getQuery().text || replacing) return;
  const plan = planReplaceFor(path);
  if (!plan || plan.files === 0) return;
  const where = plan.diskFiles.length
    ? "这个文件没开在标签里：会被直接写盘，且改完不可撤销。"
    : "这个文件开在标签里：只改内存，落盘仍由它的保存流程决定。";
  const ok = await ask(`将在 1 个文件的 ${plan.lines} 行里替换全部匹配。\n${where}`, {
    title: "在文件中全部替换",
    kind: "warning",
    okLabel: "替换",
    cancelLabel: "取消",
  });
  if (!ok) return;
  await runReplacePlan(plan);
}

async function runReplacePlan(plan: ReplacePlan): Promise<void> {
  await runReplace(() => applyReplaceAll(plan, getQuery()));
}

/**
 * B419 · 结果行那颗「替换这一处」（VS Code 的 `ReplaceAction`）：**不弹确认框**（那边也不弹），
 * 直接改、随后重跑搜索 —— 不重跑就等于把已经假了的那一屏继续列着。
 * 盘上那一份同样直接写（不可撤销），与「在文件中全部替换」同一档风险。
 */
async function replaceMatch(path: string, line: number, column: number): Promise<void> {
  const q = getQuery();
  const group = getGroups().find((g) => g.path === path);
  if (!q.text || !group || replacing) return;
  const target: MatchTarget = { line, column };
  await runReplace(() => replaceSingleMatch(group, target, q));
}

/** 替换的发令与收尾（全部替换 / 在文件中全部替换 / 这一处共用）：两处各写一遍就会漏重搜或漏念结果。 */
async function runReplace(apply: () => Promise<ReplaceOutcome>): Promise<void> {
  replacing = true;
  syncControls();
  let out: ReplaceOutcome | null = null;
  let failure = "";
  try {
    out = await apply();
  } catch (e: unknown) {
    failure = e instanceof Error ? e.message : String(e);
  }
  replacing = false;
  await runNow();
  searchCount.textContent = out ? replaceOutcomeText(out) : failure;
  searchCount.classList.toggle("is-bad", out ? out.errors.length > 0 : true);
}
