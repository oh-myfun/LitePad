/**
 * 统一设置页（B106：把原「设置 → 首选项」与「设置 → 快捷键」两个弹窗合并成
 * 一个三栏设置页：顶部搜索 + 左侧分类导航 + 右侧设置项，并改名为「设置」。
 * 入口放到「文件 → 设置…」（见 menubar.ts）。
 *
 * 结构与类名参考 InkNote 的 Settings.tsx：
 *   settings-overlay > settings-panel >
 *     settings-toolbar(搜索 + 关闭) + settings-layout(settings-nav + settings-content)
 * 分类：外观 / 编辑器 / Markdown 预览 / 新建文件 / 快捷键（快捷键复用 keymapdialog
 * 的改键逻辑，作为其中一个分类页）。
 *
 * 与旧首选项弹窗一致：每个控件 change 即回调 main 的 setter（即时生效 + 持久化），
 * 不需要「保存」按钮。快捷键的录制态会挂 KEYMAP_RECORDING_CLASS，让全局快捷键分发器让路。
 */

import { mountKeymapPage, type KeymapDialogOptions, type KeymapPageHandle } from "./keymapdialog";
import { createDropdown } from "./dropdown";
import { createSwitch } from "./switch";

export type ThemeChoice = "system" | "light" | "dark";

export interface SettingsDialogOptions {
  theme: () => ThemeChoice;
  onTheme: (mode: ThemeChoice) => void;
  /** 空串 = 内置默认字体栈 */
  fontFamily: () => string;
  onFontFamily: (family: string) => void;
  fontSize: () => number;
  onFontSize: (px: number) => void;
  editorLineHeight: () => number;
  onEditorLineHeight: (value: number) => void;
  previewLineHeight: () => number;
  onPreviewLineHeight: (value: number) => void;
  tocWidth: () => number;
  onTocWidth: (px: number) => void;
  defaultEol: () => string;
  eolOptions: () => string[];
  onDefaultEol: (value: string) => void;
  defaultEncoding: () => string;
  encodingOptions: () => string[];
  onDefaultEncoding: (value: string) => void;
  /** 自动保存：把脏文档写回**原文件**（B68 起默认关）。「通用」分类里的开关。 */
  autosave: () => boolean;
  onAutosave: (on: boolean) => void;
  /** 热退出：关窗时把未保存内容写进独立副本（B68 起默认开）。「通用」分类里的开关。 */
  hotExit: () => boolean;
  onHotExit: (on: boolean) => void;
  /** 标签样式（B114）："connected" | "pill"。「外观」分类里的下拉。 */
  tabStyle: () => string;
  onTabStyle: (style: string) => void;
  /** 快捷键分类页所需的改键逻辑（复用 keymapdialog） */
  keymap: KeymapDialogOptions;
}

/** 编辑器等宽字体候选（第一个是「默认」占位，value 为空串）。 */
export const FONT_FAMILY_OPTIONS: { label: string; value: string }[] = [
  { label: "默认（Cascadia Code / Consolas…）", value: "" },
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Consolas", value: "Consolas" },
  { label: "Courier New", value: "Courier New" },
];

/** 编辑器行距候选（倍数）。 */
export const EDITOR_LINE_HEIGHT_OPTIONS = [1.2, 1.5, 1.8, 2.1];

/** 预览行距候选（倍数），沿用原菜单三档。 */
export const PREVIEW_LINE_HEIGHT_OPTIONS = [1.3, 1.7, 2.1];

/** 大纲宽度候选（px），沿用原菜单三档。 */
export const TOC_WIDTH_OPTIONS = [200, 240, 320];

interface Category {
  id: string;
  label: string;
  /** 顶部搜索时用于命中的关键词（含分类名与各设置项文案）。 */
  keywords: string[];
}

const CATEGORIES: Category[] = [
  {
    id: "general",
    label: "通用",
    keywords: ["通用", "首选项", "自动保存", "热退出", "保存", "备份", "autosave", "hot exit"],
  },
  {
    id: "appearance",
    label: "外观",
    keywords: ["外观", "主题", "浅色", "深色", "跟随系统", "标签样式", "相连", "药丸", "tab"],
  },
  {
    id: "editor",
    label: "编辑器",
    keywords: ["编辑器", "字体", "字号", "行距", "编辑器字体", "编辑器行距"],
  },
  {
    id: "markdown",
    label: "Markdown 预览",
    keywords: ["markdown", "预览", "预览行距", "大纲", "大纲宽度", "目录", "toc"],
  },
  {
    id: "file",
    label: "新建文件",
    keywords: ["新建文件", "行尾", "编码", "默认行尾", "默认编码", "换行符", "eol"],
  },
  {
    id: "shortcuts",
    label: "快捷键",
    keywords: [
      "快捷键",
      "键位",
      "改键",
      "预设",
      "冲突",
      "新建",
      "打开",
      "保存",
      "另存",
      "关闭",
      "查找",
      "替换",
      "大纲",
      "折叠",
      "分屏",
      "撤销",
      "重做",
      "复制",
      "粘贴",
      "剪切",
      "全选",
      "缩放",
    ],
  },
];

export function showSettingsDialog(opts: SettingsDialogOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";

  const panel = document.createElement("div");
  panel.className = "settings-panel";

  // ---- 顶部工具栏：搜索 + 关闭 ----
  const toolbar = document.createElement("div");
  toolbar.className = "settings-toolbar";

  const searchWrap = document.createElement("div");
  searchWrap.className = "settings-search-wrap";

  const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  searchIcon.setAttribute("viewBox", "0 0 16 16");
  searchIcon.setAttribute("width", "14");
  searchIcon.setAttribute("height", "14");
  searchIcon.classList.add("settings-search-icon");
  searchIcon.innerHTML =
    '<circle cx="6.5" cy="6.5" r="4.25" fill="none" stroke="currentColor" stroke-width="1.2"></circle>' +
    '<path d="M10 10l3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>';

  const search = document.createElement("input");
  search.className = "settings-search";
  search.type = "search";
  search.placeholder = "搜索设置项…";

  searchWrap.append(searchIcon, search);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "settings-close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>';

  toolbar.append(searchWrap, closeBtn);

  // ---- 主体：左侧导航 + 右侧内容 ----
  const layout = document.createElement("div");
  layout.className = "settings-layout";

  const nav = document.createElement("nav");
  nav.className = "settings-nav";

  const content = document.createElement("div");
  content.className = "settings-content";

  layout.append(nav, content);
  panel.append(toolbar, layout);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // 每个分类页先建好，靠 hidden 切换（避免搜索时反复重建 keymap 页）
  const pages: Record<string, HTMLElement> = {};
  let keymapFilter: ((q: string) => void) | null = null;
  let keymapHandle: KeymapPageHandle | null = null;
  // 默认停在「外观」——显式写死，避免分类顺序调整（如把「通用」提到首位）时
  // 默认页跟着漂移；主题仍是最常改的一项。
  let active = "appearance";

  function visibleCategories(q: string): string[] {
    const query = q.trim().toLowerCase();
    if (!query) return CATEGORIES.map((c) => c.id);
    return CATEGORIES.filter((c) => c.keywords.some((k) => k.toLowerCase().includes(query))).map(
      (c) => c.id,
    );
  }

  function renderNav(): void {
    const visible = visibleCategories(search.value);
    // 当前分类被过滤掉时，跳到第一个可见分类
    if (!visible.includes(active) && visible.length > 0) active = visible[0];
    [...nav.children].forEach((btn) => {
      const el = btn as HTMLElement;
      const id = el.dataset.cat!;
      el.hidden = !visible.includes(id);
      el.classList.toggle("active", id === active);
    });
  }

  function showActive(): void {
    for (const id of Object.keys(pages)) pages[id].hidden = id !== active;
    // 只有快捷键分类可见时才把顶部搜索转发进 keymap 页做深过滤
    keymapFilter?.(active === "shortcuts" ? search.value.trim() : "");
  }

  function buildPage(cat: Category): HTMLElement {
    const section = document.createElement("section");
    section.className = "settings-page";
    const title = document.createElement("h2");
    title.className = "settings-page-title";
    title.textContent = cat.label;
    const body = document.createElement("div");
    body.className = "settings-page-body";
    section.append(title, body);

    if (cat.id === "shortcuts") {
      const header = document.createElement("div");
      header.className = "settings-shortcuts-header";
      const desc = document.createElement("p");
      desc.className = "settings-page-desc";
      desc.textContent = "点击键位按钮后按下新组合键即可改键；Esc 取消，Backspace 清除绑定。";
      header.appendChild(desc);
      body.appendChild(header);
      const mount = document.createElement("div");
      body.appendChild(mount);
      const handle = mountKeymapPage(mount, opts.keymap);
      keymapHandle = handle;
      keymapFilter = (q) => handle.setFilter(q);
    } else {
      fillPage(cat.id, body, opts);
    }
    return section;
  }

  for (const cat of CATEGORIES) {
    const page = buildPage(cat);
    pages[cat.id] = page;
    content.appendChild(page);

    const navItem = document.createElement("button");
    navItem.type = "button";
    navItem.className = "settings-nav-item";
    navItem.textContent = cat.label;
    navItem.dataset.cat = cat.id;
    navItem.addEventListener("click", () => {
      active = cat.id;
      renderNav();
      showActive();
    });
    nav.appendChild(navItem);
  }

  search.addEventListener("input", () => {
    renderNav();
    showActive();
  });

  renderNav();
  showActive();

  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      // 快捷键录制态时 Esc 只取消录制，不关掉整个设置页
      if (keymapHandle && keymapHandle.isRecording()) return;
      // B111：停在快捷键分类、搜索框里有内容时，第一次 Esc 只清空。
      // ⚠️ 必须由宿主在关窗前主动问一次：本监听是**捕获阶段**挂在 document 上的，
      // 等事件冒泡到输入框自己的 keydown 时窗已经关了。
      if (active === "shortcuts" && keymapHandle?.clearSearch()) return;
      close();
    }
  };
  const close = (): void => {
    keymapHandle?.destroy();
    document.removeEventListener("keydown", onDocKeyDown, true);
    overlay.remove();
  };

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onDocKeyDown, true);
}

/** 一行设置项：左侧文案 + 右侧控件。 */
function settingsItem(label: string, desc: string, control: HTMLElement): HTMLElement {
  const item = document.createElement("div");
  item.className = "settings-item";

  const info = document.createElement("div");
  info.className = "settings-item-info";
  const lab = document.createElement("div");
  lab.className = "settings-item-label";
  lab.textContent = label;
  info.appendChild(lab);
  if (desc) {
    const d = document.createElement("div");
    d.className = "settings-item-desc";
    d.textContent = desc;
    info.appendChild(d);
  }

  const wrap = document.createElement("div");
  wrap.className = "settings-item-control";
  wrap.appendChild(control);

  item.append(info, wrap);
  return item;
}

/** 一行开关项：左侧文案 + 右侧 switch（B111：原生 checkbox → 自绘 switch）。 */
function toggleRow(
  label: string,
  desc: string,
  checked: boolean,
  onToggle: (v: boolean) => void,
): HTMLElement {
  const sw = createSwitch({ checked, onToggle, ariaLabel: label });
  return settingsItem(label, desc, sw.root);
}

function selectControl(
  options: { label: string; value: string }[],
  current: string,
  onPick: (v: string) => void,
): HTMLElement {
  // B108：用自定义下拉替代原生 <select>，展开列表复用 .popup-menu 视觉
  const dd = createDropdown({
    options: options.map((o) => ({ label: o.label, value: o.value })),
    current,
    onPick,
    ariaLabel: options.find((o) => o.value === current)?.label,
  });
  return dd.root;
}

function selectRow(
  label: string,
  desc: string,
  options: { label: string; value: string }[],
  current: string,
  onPick: (v: string) => void,
): HTMLElement {
  return settingsItem(label, desc, selectControl(options, current, onPick));
}

function numberSelectRow(
  label: string,
  values: number[],
  current: number,
  format: (v: number) => string,
  onPick: (v: number) => void,
): HTMLElement {
  return selectRow(
    label,
    "",
    values.map((v) => ({ label: format(v), value: String(v) })),
    String(current),
    (v) => onPick(Number(v)),
  );
}

function fillPage(id: string, body: HTMLElement, opts: SettingsDialogOptions): void {
  if (id === "general") {
    body.appendChild(
      toggleRow(
        "自动保存",
        "修改后自动写回原文件（1.5 秒防抖）；开启后不再有「未保存」状态。",
        opts.autosave(),
        (v) => opts.onAutosave(v),
      ),
    );
    body.appendChild(
      toggleRow(
        "热退出",
        "关窗时把未保存内容写进独立副本（原文件不动），下次启动还原成未保存标签，且关窗不再询问。",
        opts.hotExit(),
        (v) => opts.onHotExit(v),
      ),
    );
  } else if (id === "appearance") {
    body.appendChild(
      selectRow(
        "主题",
        "控制窗口与编辑器的明暗；「跟随系统」随操作系统切换。",
        [
          { label: "跟随系统", value: "system" },
          { label: "浅色", value: "light" },
          { label: "深色", value: "dark" },
        ],
        opts.theme(),
        (v) => opts.onTheme(v as ThemeChoice),
      ),
    );
    body.appendChild(
      selectRow(
        "标签样式",
        "「相连」= 标签连成一条带、活动标签与编辑区一体（VS Code 1.139 默认）；「药丸」= 独立圆角胶囊（经典样式）。",
        [
          { label: "相连（默认）", value: "connected" },
          { label: "药丸", value: "pill" },
        ],
        opts.tabStyle(),
        (v) => opts.onTabStyle(v),
      ),
    );
  } else if (id === "editor") {
    body.appendChild(
      selectRow("编辑器字体", "", FONT_FAMILY_OPTIONS, opts.fontFamily(), (v) =>
        opts.onFontFamily(v),
      ),
    );
    body.appendChild(
      numberSelectRow(
        "字号（px）",
        [10, 11, 12, 13, 14, 16, 18, 20, 24, 28],
        opts.fontSize(),
        (v) => `${v}px`,
        (v) => opts.onFontSize(v),
      ),
    );
    body.appendChild(
      numberSelectRow(
        "编辑器行距",
        EDITOR_LINE_HEIGHT_OPTIONS,
        opts.editorLineHeight(),
        (v) => `${v} 倍`,
        (v) => opts.onEditorLineHeight(v),
      ),
    );
  } else if (id === "markdown") {
    body.appendChild(
      numberSelectRow(
        "预览行距",
        PREVIEW_LINE_HEIGHT_OPTIONS,
        opts.previewLineHeight(),
        (v) => `${v} 倍`,
        (v) => opts.onPreviewLineHeight(v),
      ),
    );
    body.appendChild(
      numberSelectRow(
        "大纲宽度",
        TOC_WIDTH_OPTIONS,
        opts.tocWidth(),
        (v) => `${v}px`,
        (v) => opts.onTocWidth(v),
      ),
    );
  } else if (id === "file") {
    body.appendChild(
      selectRow(
        "默认行尾",
        "新建文件写入磁盘时使用的换行符。",
        opts.eolOptions().map((e) => ({ label: e, value: e })),
        opts.defaultEol(),
        (v) => opts.onDefaultEol(v),
      ),
    );
    body.appendChild(
      selectRow(
        "默认编码",
        "新建文件使用的文本编码。",
        opts.encodingOptions().map((e) => ({ label: e, value: e })),
        opts.defaultEncoding(),
        (v) => opts.onDefaultEncoding(v),
      ),
    );
  }
}
