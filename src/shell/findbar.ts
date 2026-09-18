/**
 * 悬浮查找/替换栏（方案 C：对齐 VS Code 的紧凑浮层）。
 *
 * 设计要点：
 * - **不绑定文件/面板**：挂在 #app 上，是应用级浮层；切换标签/面板/分屏都不会自动关闭。
 * - **一个入口干所有事**：查找、替换、跨文档查找都在这一栏里，编辑器内不再嵌 CM6 搜索面板。
 * - **钉在右上角**：去掉了可拖动的标题栏（方案 C），固定停靠编辑器右上，尽量少遮挡正文。
 * - **替换行可折叠**：主行永远是「查找」；点 chevron（或菜单「替换」）才展开替换行。
 * - **匹配选项改成图标开关**（Aa / ab / .* / 选区 / AB），嵌在输入框右内侧，激活态高亮。
 * - **跨文档收敛成一个文档图标**：不再用「复选框 + 查找全部按钮」，徽标显示当前打开文档数。
 * - 紧凑计数 `N / M`；无匹配变红。
 * - 不绑定快捷键：VS Code 的 Alt+C/W/R/L/P 在 LitePad 不可用（菜单助记符与 B71 命令已占），
 *   故只在 UI 上做图标开关，不注册快捷键。
 */

import { setTip } from "./tooltip";

export interface FindBarQuery {
  text: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  /** 勾选「所有打开的文档」时为真：查找全部 / 全部替换作用于全部已打开文档 */
  allDocs: boolean;
  /** 在选区中查找：命中只限定在活动视图的当前选区（跨文档忽略） */
  inSelection: boolean;
  /** 保留大小写：替换时把命中词的大小写迁移到替换串 */
  preserveCase: boolean;
}

/** 一条命中（仅在已打开文档的内存快照里，不涉及磁盘文件）。 */
export interface FindHit {
  /** Rust tabId */
  docId: number;
  path: string;
  name: string;
  line: number;
  col: number;
  text: string;
  from: number;
  to: number;
}

export interface FindBarCallbacks {
  /** 查找内容 / 选项变化（主程序据此刷新高亮与计数） */
  onQueryChange: (q: FindBarQuery) => void;
  /** 上一个 / 下一个（当前文档） */
  onStep: (dir: 1 | -1, q: FindBarQuery) => void;
  onReplace: (q: FindBarQuery) => void;
  onReplaceAll: (q: FindBarQuery) => void;
  /** 勾选「所有打开的文档」时执行跨文档搜索（扫内存快照，同步返回） */
  onSearchAll: (q: FindBarQuery) => FindHit[];
  onOpenHit: (hit: FindHit) => void;
  onClose: () => void;
}

export interface FindBarHandle {
  open(seed?: string, expandReplace?: boolean): void;
  close(): void;
  isOpen(): boolean;
  /** 切换标签/面板后重新把当前查询应用到新的活动视图（栏本身保持打开） */
  retarget(): void;
  step(dir: 1 | -1): void;
  setCount(text: string, bad?: boolean): void;
  setStatus(text: string): void;
  setHits(hits: FindHit[]): void;
  /** 刷新「打开文档数」徽标（由主程序在标签增删时调用） */
  setDocCount(n: number): void;
  focusFind(): void;
  focusReplace(): void;
  getQuery(): FindBarQuery;
}

/** 图标内联 SVG（避免依赖图标字体/emoji，渲染稳定）。 */
const SVG = {
  prev: '<svg viewBox="0 0 16 16"><path d="M8 12V4M4.5 7.5L8 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M8 4v8M4.5 8.5L8 12l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  repl: '<svg viewBox="0 0 16 16"><path d="M2.5 5.5h7l-2-2M13.5 10.5h-7l2 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  replAll:
    '<svg viewBox="0 0 16 16"><path d="M2.5 4h6l-1.8-1.8M13.5 12H7.5l1.8 1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 7.4h7.5l-1.8-1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sel: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="3 2"/></svg>',
  docs: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="8.5" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M12.5 4.5v9.5a1 1 0 0 1-1 1H5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  close:
    '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  chevR:
    '<svg viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevD:
    '<svg viewBox="0 0 16 16"><path d="M3.5 6L8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function svg(name: keyof typeof SVG): string {
  return SVG[name];
}

/**
 * 图标按钮工厂。B58 起提示走自绘层：`tip` 是文案、`key` 是快捷键（渲染成键帽）。
 * 纯图标按钮没有可读文本，必须显式补 aria-label。
 */
function iconBtn(
  cls: string,
  svgName: keyof typeof SVG,
  label: string,
  tip: string,
  key?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.innerHTML = svg(svgName);
  setTip(b, tip, { key, group: "findbar" });
  b.setAttribute("aria-label", key ? `${label} (${key})` : label);
  return b;
}

/**
 * 匹配选项图标开关（Aa / ab / .* / 选区 / AB）。`iconSvg` 给需要图标的（选区），
 * 其余给纯文字字形。`label` 用于 aria + 提示；激活态由 `.on` 与 `aria-pressed` 表达。
 */
function toggle(
  glyph: string,
  iconSvg: keyof typeof SVG | null,
  label: string,
  tip: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "find-toggle";
  b.type = "button";
  b.innerHTML = iconSvg ? svg(iconSvg) : glyph;
  b.setAttribute("aria-pressed", "false");
  b.setAttribute("aria-label", label);
  setTip(b, tip, { group: "findbar" });
  return b;
}

export function createFindBar(host: HTMLElement, cb: FindBarCallbacks): FindBarHandle {
  const dom = document.createElement("section");
  dom.className = "find-bar";
  dom.hidden = true;

  // ---- 主行：chevron + 查找输入框（内嵌图标开关）+ 计数 + 导航 + 跨文档 + 关闭 ----
  const chevron = iconBtn("find-chevron", "chevR", "展开/折叠替换", "展开或折叠替换");
  const findInput = document.createElement("input");
  findInput.className = "find-input search-input";
  findInput.placeholder = "查找内容（回车下一个，Shift+回车上一个）";
  findInput.spellcheck = false;

  const caseT = toggle("Aa", null, "区分大小写", "区分大小写");
  const wordT = toggle("ab", null, "全词匹配", "全词匹配");
  const reT = toggle(".*", null, "正则", "使用正则表达式");
  const selT = toggle("", "sel", "在选区中查找", "仅在当前选区中查找");
  const findToggles = document.createElement("span");
  findToggles.className = "find-toggles";
  findToggles.append(caseT, wordT, reT, selT);

  const field = document.createElement("span");
  field.className = "find-field";
  field.append(findInput, findToggles);

  const count = document.createElement("span");
  count.className = "find-count";

  const prev = iconBtn("find-nav find-prev", "prev", "上一个", "上一个匹配", "Shift+Enter");
  const next = iconBtn("find-nav find-next", "next", "下一个", "下一个匹配", "Enter");

  // 跨文档：文档图标按钮（带打开文档数徽标）
  const docsBtn = iconBtn("find-docs", "docs", "所有打开的文档", "在全部已打开的文档中查找");
  const badge = document.createElement("i");
  badge.className = "find-badge";
  badge.hidden = true;
  docsBtn.appendChild(badge);

  const closeBtn = iconBtn("find-x", "close", "关闭", "关闭查找栏", "Esc");

  const rowMain = document.createElement("div");
  rowMain.className = "find-row find-row-main";
  rowMain.append(chevron, field, count, prev, next, docsBtn, closeBtn);

  // ---- 替换行（默认隐藏，chevron 展开）：替换输入框（内嵌 AB 保留大小写）+ 替换/全部替换 ----
  const chevGhost = document.createElement("span");
  chevGhost.className = "find-chevron-ghost";
  const replaceInput = document.createElement("input");
  replaceInput.className = "find-replace-input search-input";
  replaceInput.placeholder = "替换为";
  replaceInput.spellcheck = false;
  const presT = toggle("AB", null, "保留大小写", "替换时保留被替换文本的大小写");
  const replToggles = document.createElement("span");
  replToggles.className = "find-toggles";
  replToggles.append(presT);
  const replField = document.createElement("span");
  replField.className = "find-field";
  replField.append(replaceInput, replToggles);
  const doReplace = iconBtn("find-replace-one", "repl", "替换", "替换当前匹配", "Enter");
  const doAll = iconBtn("find-replace-all", "replAll", "全部替换", "替换全部匹配");
  const rowReplace = document.createElement("div");
  rowReplace.className = "find-row find-row-replace";
  rowReplace.hidden = true;
  rowReplace.append(chevGhost, replField, doReplace, doAll);

  // ---- 结果 / 状态 ----
  const results = document.createElement("div");
  results.className = "find-results";
  results.hidden = true;
  const status = document.createElement("div");
  status.className = "find-status";

  dom.append(rowMain, rowReplace, results, status);
  host.appendChild(dom);

  // ---- 选项状态（图标开关的源真值）----
  const opt = { case: false, word: false, regexp: false, selection: false, preserve: false };

  function query(): FindBarQuery {
    return {
      text: findInput.value,
      replace: replaceInput.value,
      caseSensitive: opt.case,
      wholeWord: opt.word,
      regexp: opt.regexp,
      allDocs: docsBtn.classList.contains("on"),
      inSelection: opt.selection,
      preserveCase: opt.preserve,
    };
  }

  function syncToggle(btn: HTMLButtonElement, on: boolean): void {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function setHits(hits: FindHit[]): void {
    results.textContent = "";
    if (hits.length === 0) {
      results.hidden = true;
      return;
    }
    results.hidden = false;
    const files = new Set(hits.map((h) => h.path || h.name));
    setStatus(`${hits.length} 条结果（${files.size} 个文档）`);
    for (const h of hits.slice(0, 300)) {
      const item = document.createElement("div");
      item.className = "find-hit";
      const loc = document.createElement("span");
      loc.className = "find-hit-loc";
      loc.textContent = `${h.name}:${h.line}`;
      const text = document.createElement("span");
      text.className = "find-hit-text";
      text.textContent = h.text;
      item.append(loc, text);
      setTip(item, `${h.name}:${h.line}:${h.col}`, { detail: h.path, group: "findbar" });
      item.addEventListener("click", () => cb.onOpenHit(h));
      results.appendChild(item);
    }
  }

  /** 跨文档范围：图标激活即搜索全部打开文档；取消时清掉上一次的结果。 */
  function syncAllDocs(): void {
    const on = docsBtn.classList.contains("on");
    badge.hidden = !on;
    findInput.placeholder = on
      ? "查找内容（回车在全部已打开的文档中查找）"
      : "查找内容（回车下一个，Shift+回车上一个）";
    if (!on) setHits([]);
  }

  function runSearch(): void {
    const q = query();
    if (!q.text) {
      setStatus("请输入查找内容");
      setHits([]);
      return;
    }
    setHits(cb.onSearchAll(q));
  }

  function setReplaceExpanded(on: boolean): void {
    rowReplace.hidden = !on;
    chevron.innerHTML = svg(on ? "chevD" : "chevR");
    chevron.setAttribute("aria-label", on ? "折叠替换" : "展开替换");
  }

  findInput.addEventListener("input", () => {
    if (docsBtn.classList.contains("on")) setHits([]);
    cb.onQueryChange(query());
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = query();
      if (q.allDocs) {
        runSearch();
      } else if (e.shiftKey) {
        cb.onStep(-1, q);
      } else {
        cb.onStep(1, q);
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      cb.onReplace(query());
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  prev.addEventListener("click", () => cb.onStep(-1, query()));
  next.addEventListener("click", () => cb.onStep(1, query()));
  doReplace.addEventListener("click", () => cb.onReplace(query()));
  doAll.addEventListener("click", () => cb.onReplaceAll(query()));
  docsBtn.addEventListener("click", () => {
    docsBtn.classList.toggle("on");
    syncAllDocs();
    cb.onQueryChange(query());
  });
  chevron.addEventListener("click", () => setReplaceExpanded(rowReplace.hidden));

  // 图标开关：点击翻转源真值 → 同步外观 → 通知主程序
  const toggleMap: Array<[HTMLButtonElement, keyof typeof opt]> = [
    [caseT, "case"],
    [wordT, "word"],
    [reT, "regexp"],
    [selT, "selection"],
    [presT, "preserve"],
  ];
  for (const [btn, key] of toggleMap) {
    btn.addEventListener("click", () => {
      opt[key] = !opt[key];
      syncToggle(btn, opt[key]);
      cb.onQueryChange(query());
    });
  }

  closeBtn.addEventListener("click", () => close());
  // Esc 关闭：捕获阶段拦截，避免冒泡到窗口级快捷键
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  function open(seed?: string, expandReplace = false): void {
    const first = dom.hidden;
    dom.hidden = false;
    if (first) {
      setReplaceExpanded(expandReplace);
    } else if (expandReplace) {
      setReplaceExpanded(true);
    }
    if (seed) findInput.value = seed;
    syncAllDocs();
    cb.onQueryChange(query());
  }

  function close(): void {
    if (dom.hidden) return;
    dom.hidden = true;
    cb.onClose();
  }

  return {
    open,
    close,
    isOpen: () => !dom.hidden,
    retarget: () => {
      if (!dom.hidden) cb.onQueryChange(query());
    },
    step: (dir) => cb.onStep(dir, query()),
    setCount: (t, bad) => {
      count.textContent = t;
      count.classList.toggle("find-count-bad", !!bad);
    },
    setStatus,
    setHits,
    setDocCount: (n) => {
      badge.textContent = String(n);
      badge.hidden = !docsBtn.classList.contains("on");
    },
    focusFind: () => findInput.select(),
    focusReplace: () => {
      setReplaceExpanded(true);
      replaceInput.select();
    },
    getQuery: query,
  };
}
