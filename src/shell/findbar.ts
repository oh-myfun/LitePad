/**
 * 悬浮查找/替换栏（统一入口）。
 *
 * 设计要点（用户要求）：
 * - **不绑定文件/面板**：挂在 #app 上，是应用级浮层；切换标签/面板/分屏都不会自动关闭。
 * - **一个入口干所有事**：查找、替换、跨文档、文件夹内搜索都在这一栏里，
 *   通过「范围」下拉切换（当前文档 / 所有打开的文档 / 文件夹…），
 *   因此工具栏只保留一个查找按钮，编辑器内不再嵌 CM6 搜索面板。
 * - 可拖动（拖标题栏），位置记在 localStorage。
 */

export type FindScope = "doc" | "docs" | "folder";

export interface FindBarQuery {
  text: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  scope: FindScope;
  /** 文件夹范围时的根目录 */
  folder: string;
}

/** 一条命中：doc = 已打开文档（内存），file = 磁盘文件（文件夹搜索）。 */
export interface FindHit {
  kind: "doc" | "file";
  /** kind=doc 时的文档 id（Rust tabId） */
  docId?: number;
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
  /** 当前文档范围：上一个 / 下一个 */
  onStep: (dir: 1 | -1, q: FindBarQuery) => void;
  onReplace: (q: FindBarQuery) => void;
  onReplaceAll: (q: FindBarQuery) => void;
  /** 所有打开的文档 / 文件夹 范围：执行搜索并返回命中 */
  onSearchAll: (q: FindBarQuery) => Promise<FindHit[]>;
  onOpenHit: (hit: FindHit) => void;
  onPickFolder: () => Promise<string | null>;
  onClose: () => void;
}

export interface FindBarHandle {
  open(scope?: FindScope, seed?: string): void;
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
  /** 预填搜索目录（文件夹范围入口用） */
  setFolder(dir: string): void;
  getQuery(): FindBarQuery;
}

const POS_KEY = "litepad.findbar.pos";

function btn(cls: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.title = title;
  b.type = "button";
  return b;
}

function check(label: string, title: string): { label: HTMLElement; input: HTMLInputElement } {
  const l = document.createElement("label");
  l.className = "find-opt";
  l.title = title;
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
  const closeBtn = btn("find-x", "×", "关闭（Esc）");
  title.append(titleText, closeBtn);

  // ---- 查找行 ----
  const findInput = document.createElement("input");
  findInput.className = "find-input search-input";
  findInput.placeholder = "查找内容（回车下一个，Shift+回车上一个）";
  findInput.spellcheck = false;
  const prev = btn("find-btn", "↑", "上一个（Shift+Enter）");
  const next = btn("find-btn", "↓", "下一个（Enter）");
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
  const doReplace = btn("find-btn", "替换", "替换当前（Ctrl+Alt+Enter）");
  const doAll = btn("find-btn", "全部替换", "替换当前范围内的全部匹配");
  const rowReplace = document.createElement("div");
  rowReplace.className = "find-row";
  rowReplace.append(replaceInput, doReplace, doAll);

  // ---- 范围 / 选项行 ----
  const scopeSel = document.createElement("select");
  scopeSel.className = "find-scope";
  for (const [v, t] of [
    ["doc", "当前文档"],
    ["docs", "所有打开的文档"],
    ["folder", "文件夹…"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    scopeSel.appendChild(o);
  }
  const folderInput = document.createElement("input");
  folderInput.className = "find-folder search-input";
  folderInput.placeholder = "搜索目录";
  folderInput.spellcheck = false;
  const pick = btn("find-btn", "浏览…", "选择搜索目录");
  const caseChk = check("区分大小写", "区分大小写");
  const wordChk = check("全词匹配", "全词匹配");
  const reChk = check("正则", "正则表达式");
  const searchAll = btn("find-btn find-primary", "查找全部", "在所有打开的文档 / 文件夹中查找");
  const rowScope = document.createElement("div");
  rowScope.className = "find-row find-row-scope";
  rowScope.append(
    scopeSel,
    folderInput,
    pick,
    caseChk.label,
    wordChk.label,
    reChk.label,
    searchAll,
  );

  // ---- 结果 / 状态 ----
  const results = document.createElement("div");
  results.className = "find-results";
  results.hidden = true;
  const status = document.createElement("div");
  status.className = "find-status";

  dom.append(title, rowFind, rowReplace, rowScope, results, status);
  host.appendChild(dom);

  function query(): FindBarQuery {
    return {
      text: findInput.value,
      replace: replaceInput.value,
      caseSensitive: caseChk.input.checked,
      wholeWord: wordChk.input.checked,
      regexp: reChk.input.checked,
      scope: scopeSel.value as FindScope,
      folder: folderInput.value.trim(),
    };
  }

  function syncScope(): void {
    const isFolder = scopeSel.value === "folder";
    folderInput.style.display = isFolder ? "" : "none";
    pick.style.display = isFolder ? "" : "none";
    searchAll.style.display = scopeSel.value === "doc" ? "none" : "";
    // 替换只作用于已打开的文档；文件夹范围（磁盘文件）不支持写回
    const canReplace = scopeSel.value !== "folder";
    replaceInput.disabled = !canReplace;
    doReplace.disabled = !canReplace;
    doAll.disabled = !canReplace;
    doAll.title =
      scopeSel.value === "docs" ? "在所有打开的文档中替换全部匹配" : "替换当前文档中的全部匹配";
    // 切到跨文件范围时清掉“第 n/m 处”这类单文档计数
    if (scopeSel.value !== "doc") count.textContent = "";
    else cb.onQueryChange(query());
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
    setStatus(`${hits.length} 条结果（${files.size} 个文件）`);
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
      item.title = `${h.path}:${h.line}:${h.col}`;
      item.addEventListener("click", () => cb.onOpenHit(h));
      results.appendChild(item);
    }
  }

  async function runSearchAll(): Promise<void> {
    const q = query();
    if (q.scope === "folder" && !q.folder) {
      setStatus("请先选择搜索目录");
      return;
    }
    if (!q.text) {
      setStatus("请输入查找内容");
      return;
    }
    setStatus("搜索中…");
    results.textContent = "";
    try {
      const hits = await cb.onSearchAll(q);
      setHits(hits);
    } catch (err) {
      setStatus(String(err));
    }
  }

  findInput.addEventListener("input", () => cb.onQueryChange(query()));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = query();
      if (q.scope === "doc") {
        if (e.shiftKey) cb.onStep(-1, q);
        else cb.onStep(1, q);
      } else {
        void runSearchAll();
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
  searchAll.addEventListener("click", () => void runSearchAll());
  scopeSel.addEventListener("change", syncScope);
  pick.addEventListener("click", () => {
    void cb.onPickFolder().then((dir) => {
      if (dir) folderInput.value = dir;
    });
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

  function open(scope?: FindScope, seed?: string): void {
    const first = dom.hidden;
    dom.hidden = false;
    if (first) {
      restorePos();
      // 无记忆位置时默认停靠右上（避开左侧标签与大纲抽屉）
      if (!dom.style.left) {
        dom.style.left = `${Math.max(0, window.innerWidth - dom.offsetWidth - 24)}px`;
      }
    }
    if (scope) scopeSel.value = scope;
    syncScope();
    if (seed) {
      findInput.value = seed;
      cb.onQueryChange(query());
    }
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
    setFolder: (dir) => {
      if (dir && !folderInput.value) folderInput.value = dir;
    },
    getQuery: query,
  };
}
