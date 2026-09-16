/**
 * 悬浮查找/替换栏。
 *
 * 设计要点（用户要求）：
 * - **不绑定文件/面板**：挂在 #app 上，是应用级浮层；切换标签/面板/分屏都不会自动关闭。
 * - **一个入口干所有事**：查找、替换、跨文档查找都在这一栏里，编辑器内不再嵌 CM6 搜索面板。
 * - **范围不用下拉菜单**：跨文档能力收敛成一个「所有打开的文档」勾选框；
 *   不做文件夹搜索（不读盘、无搜索目录、无结果跨文件写回）。
 * - 可拖动（拖标题栏），位置记在 localStorage。
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
  open(seed?: string): void;
  close(): void;
  isOpen(): boolean;
  /** 切换标签/面板后重新把当前查询应用到新的活动视图（栏本身保持打开） */
  retarget(): void;
  step(dir: 1 | -1): void;
  setCount(text: string): void;
  setStatus(text: string): void;
  setHits(hits: FindHit[]): void;
  focusFind(): void;
  focusReplace(): void;
  getQuery(): FindBarQuery;
}

const POS_KEY = "litepad.findbar.pos";

/**
 * 按钮工厂。B58 起提示走自绘层：`tip` 是文案、`key` 是快捷键（渲染成键帽，
 * 不再写成 `关闭（Esc）` 那种挤在一起的括号）。
 * 图标/符号按钮（× ↑ ↓）没有可读文本，必须显式补 aria-label。
 */
function btn(cls: string, text: string, tip: string, key?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.type = "button";
  setTip(b, tip, { key, group: "findbar" });
  b.setAttribute("aria-label", key ? `${tip} (${key})` : tip);
  return b;
}

/**
 * 复选框。只在**文案不足以说明**时才给提示（`detail`）——
 * 「区分大小写」这类控件，提示文字与旁边可见的 label 一模一样，纯属噪音。
 */
function check(label: string, detail?: string): { label: HTMLElement; input: HTMLInputElement } {
  const l = document.createElement("label");
  l.className = "find-opt";
  if (detail) setTip(l, detail, { group: "findbar" });
  const input = document.createElement("input");
  input.type = "checkbox";
  l.append(input, document.createTextNode(label));
  return { label: l, input };
}

export function createFindBar(host: HTMLElement, cb: FindBarCallbacks): FindBarHandle {
  const dom = document.createElement("section");
  dom.className = "find-bar";
  dom.hidden = true;

  // ---- 标题栏（拖动把手 + 关闭）----
  const title = document.createElement("div");
  title.className = "find-bar-title";
  const titleText = document.createElement("span");
  titleText.textContent = "查找 / 替换";
  const closeBtn = btn("find-x", "×", "关闭", "Esc");
  title.append(titleText, closeBtn);

  // ---- 查找行 ----
  const findInput = document.createElement("input");
  findInput.className = "find-input search-input";
  findInput.placeholder = "查找内容（回车下一个，Shift+回车上一个）";
  findInput.spellcheck = false;
  const prev = btn("find-btn", "↑", "上一个", "Shift+Enter");
  const next = btn("find-btn", "↓", "下一个", "Enter");
  const count = document.createElement("span");
  count.className = "find-count";
  const rowFind = document.createElement("div");
  rowFind.className = "find-row";
  rowFind.append(findInput, prev, next, count);

  // ---- 替换行 ----
  const replaceInput = document.createElement("input");
  replaceInput.className = "find-replace-input search-input";
  replaceInput.placeholder = "替换为";
  replaceInput.spellcheck = false;
  const doReplace = btn("find-btn", "替换", "替换当前", "Enter");
  const doAll = btn("find-btn", "全部替换", "替换全部匹配");
  const rowReplace = document.createElement("div");
  rowReplace.className = "find-row";
  rowReplace.append(replaceInput, doReplace, doAll);

  // ---- 选项行：匹配选项 + 右对齐的跨文档范围勾选 ----
  const caseChk = check("区分大小写");
  const wordChk = check("全词匹配");
  const reChk = check("正则");
  const docsChk = check(
    "所有打开的文档",
    "勾选后在全部已打开的文档中查找（回车或「查找全部」）；不勾选只查当前文档",
  );
  docsChk.label.classList.add("find-opt-docs");
  const searchAll = btn("find-btn", "查找全部", "在全部已打开的文档中查找");
  const spacer = document.createElement("span");
  spacer.className = "find-spacer";
  const rowOpts = document.createElement("div");
  rowOpts.className = "find-row find-row-opts";
  rowOpts.append(caseChk.label, wordChk.label, reChk.label, spacer, docsChk.label, searchAll);

  // ---- 结果 / 状态 ----
  const results = document.createElement("div");
  results.className = "find-results";
  results.hidden = true;
  const status = document.createElement("div");
  status.className = "find-status";

  dom.append(title, rowFind, rowReplace, rowOpts, results, status);
  host.appendChild(dom);

  function query(): FindBarQuery {
    return {
      text: findInput.value,
      replace: replaceInput.value,
      caseSensitive: caseChk.input.checked,
      wholeWord: wordChk.input.checked,
      regexp: reChk.input.checked,
      allDocs: docsChk.input.checked,
    };
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
      // B58：命中行的可见文本是「文件名:行 + 片段」，提示补上完整路径
      setTip(item, `${h.name}:${h.line}:${h.col}`, { detail: h.path, group: "findbar" });
      item.addEventListener("click", () => cb.onOpenHit(h));
      results.appendChild(item);
    }
  }

  /** 勾选态联动：只有跨文档范围才需要「查找全部」；取消勾选时清掉上一次的结果。 */
  function syncAllDocs(): void {
    const on = docsChk.input.checked;
    searchAll.style.display = on ? "" : "none";
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

  findInput.addEventListener("input", () => {
    // 查询变了，上一次的跨文档结果就作废，避免展示过期命中
    if (docsChk.input.checked) setHits([]);
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
  searchAll.addEventListener("click", () => runSearch());
  docsChk.input.addEventListener("change", () => {
    syncAllDocs();
    cb.onQueryChange(query());
  });
  for (const c of [caseChk.input, wordChk.input, reChk.input]) {
    c.addEventListener("change", () => cb.onQueryChange(query()));
  }
  closeBtn.addEventListener("click", () => close());
  // Esc 关闭：捕获阶段拦截，避免冒泡到窗口级快捷键
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  // ---- 拖动（指针事件序列：dragDropEnabled=true 下 HTML5 DnD 不可用）----
  function restorePos(): void {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as { left?: number; top?: number };
      if (typeof p.left === "number" && typeof p.top === "number") {
        dom.style.left = `${p.left}px`;
        dom.style.top = `${p.top}px`;
      }
    } catch {
      // 位置损坏则忽略
    }
  }
  function savePos(): void {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left: dom.offsetLeft, top: dom.offsetTop }));
    } catch {
      // 忽略
    }
  }
  title.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".find-x")) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = dom.offsetLeft;
    const startTop = dom.offsetTop;
    document.body.classList.add("layout-dragging");
    const onMove = (ev: MouseEvent): void => {
      const maxLeft = Math.max(0, window.innerWidth - dom.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - 40);
      const left = Math.min(maxLeft, Math.max(0, startLeft + (ev.clientX - startX)));
      const top = Math.min(maxTop, Math.max(0, startTop + (ev.clientY - startY)));
      dom.style.left = `${left}px`;
      dom.style.top = `${top}px`;
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("layout-dragging");
      savePos();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  function open(seed?: string): void {
    const first = dom.hidden;
    dom.hidden = false;
    if (first) {
      restorePos();
      // 无记忆位置时默认停靠右上（避开左侧标签与大纲抽屉）
      if (!dom.style.left) {
        dom.style.left = `${Math.max(0, window.innerWidth - dom.offsetWidth - 24)}px`;
      }
    }
    if (seed) {
      findInput.value = seed;
    }
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
    setCount: (t) => {
      count.textContent = t;
    },
    setStatus,
    setHits,
    focusFind: () => findInput.select(),
    focusReplace: () => replaceInput.select(),
    getQuery: query,
  };
}
