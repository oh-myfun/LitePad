/**
 * 悬浮查找/替换栏。
 *
 * 设计要点（用户要求）：
 * - **只作用于当前活动文档**：栏内不再有「范围」下拉，也不做跨文件/文件夹搜索。
 * - **不绑定文件/面板**：挂在 #app 上，是应用级浮层；切换标签/面板/分屏都不会自动关闭。
 * - 一个入口干所有事：查找、替换、替换全部都在这一栏里，编辑器内不再嵌 CM6 搜索面板。
 * - 可拖动（拖标题栏），位置记在 localStorage。
 */

export interface FindBarQuery {
  text: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface FindBarCallbacks {
  /** 查找内容 / 选项变化（主程序据此刷新高亮与计数） */
  onQueryChange: (q: FindBarQuery) => void;
  /** 上一个 / 下一个 */
  onStep: (dir: 1 | -1, q: FindBarQuery) => void;
  onReplace: (q: FindBarQuery) => void;
  onReplaceAll: (q: FindBarQuery) => void;
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
  focusFind(): void;
  focusReplace(): void;
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
  const doReplace = btn("find-btn", "替换", "替换当前（Enter）");
  const doAll = btn("find-btn", "全部替换", "替换当前文档中的全部匹配");
  const rowReplace = document.createElement("div");
  rowReplace.className = "find-row";
  rowReplace.append(replaceInput, doReplace, doAll);

  // ---- 选项行 ----
  const caseChk = check("区分大小写", "区分大小写");
  const wordChk = check("全词匹配", "全词匹配");
  const reChk = check("正则", "正则表达式");
  const rowOpts = document.createElement("div");
  rowOpts.className = "find-row find-row-opts";
  rowOpts.append(caseChk.label, wordChk.label, reChk.label);

  // ---- 状态 ----
  const status = document.createElement("div");
  status.className = "find-status";

  dom.append(title, rowFind, rowReplace, rowOpts, status);
  host.appendChild(dom);

  function query(): FindBarQuery {
    return {
      text: findInput.value,
      replace: replaceInput.value,
      caseSensitive: caseChk.input.checked,
      wholeWord: wordChk.input.checked,
      regexp: reChk.input.checked,
    };
  }

  function setStatus(text: string): void {
    status.textContent = text;
  }

  findInput.addEventListener("input", () => cb.onQueryChange(query()));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = query();
      if (e.shiftKey) cb.onStep(-1, q);
      else cb.onStep(1, q);
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
    focusFind: () => findInput.select(),
    focusReplace: () => replaceInput.select(),
    getQuery: query,
  };
}
