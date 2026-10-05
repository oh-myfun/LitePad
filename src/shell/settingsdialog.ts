/**
 * 统一设置页（B106：把原「设置 → 首选项」与「设置 → 快捷键」两个弹窗合并成
 * 一个三栏设置页：顶部搜索 + 左侧分类导航 + 右侧设置项，并改名为「设置」。
 * 入口放到「文件 → 设置…」（见 menubar.ts）。
 *
 * 结构与类名参考 InkNote 的 Settings.tsx：
 *   settings-overlay > settings-panel >
 *     settings-toolbar(搜索 + 关闭) + settings-layout(settings-nav + settings-content)
 * 分类：通用 / 外观 / 编辑器 / 新建文件 / 快捷键（快捷键复用 keymapdialog
 * 的改键逻辑，作为其中一个分类页）。B229 起原先那个独立的预览分类并入「编辑器」，
 * 预览侧两项（预览行距、预览布局宽度）在本页末尾的「预览」小分组里。
 * B235：原先在这儿的「大纲宽度」已按用户要求删除 —— 大纲宽度改由左侧栏的
 * 拖拽分隔条单独控制，设置页不再有那一项。
 *
 * 与旧首选项弹窗一致：每个控件 change 即回调 main 的 setter（即时生效 + 持久化），
 * 不需要「保存」按钮。快捷键的录制态会挂 KEYMAP_RECORDING_CLASS，让全局快捷键分发器让路。
 */

import { mountKeymapPage, type KeymapDialogOptions, type KeymapPageHandle } from "./keymapdialog";
import { createDropdown } from "./dropdown";
import { createSwitch } from "./switch";
// B235：`PreviewWidth` 是宽度档的类型（standard / wide / full）。
import type { PreviewWidth } from "../ipc/api";

export type ThemeChoice = "system" | "light" | "dark";

export interface SettingsDialogOptions {
  theme: () => ThemeChoice;
  onTheme: (mode: ThemeChoice) => void;
  /** 空串 = 内置默认字体栈 */
  fontFamily: () => string;
  onFontFamily: (family: string) => void;
  /** B227：代码字体族名（预览 code / pre）；空串 = 用内嵌 Cascadia Mono */
  codeFontFamily: () => string;
  onCodeFontFamily: (family: string) => void;
  /**
   * B227：本机字体清单（Rust `list_fonts` 的缓存结果，`is_monospace` 判等宽）。
   * 空数组 = 枚举没到手（非 Windows / IPC 失败），此时退回 `fontFamilyOptions()`
   * 那份手抄清单，**不许**把这一栏变空。
   */
  systemFonts: () => { name: string; is_monospace: boolean }[];
  fontSize: () => number;
  onFontSize: (px: number) => void;
  editorLineHeight: () => number;
  onEditorLineHeight: (value: number) => void;
  previewLineHeight: () => number;
  onPreviewLineHeight: (value: number) => void;
  /**
   * B235：预览正文宽度档（`standard` / `wide` / `full`）。
   *
   * ⚠️ 顶掉了原先的 `sideWidth` / `onTocWidth`：设置页不再有「大纲宽度」那一项
   *    （用户点名去掉），大纲宽度改由左侧栏的拖拽分隔条单独控制。
   */
  previewWidth: () => PreviewWidth;
  onPreviewWidth: (value: PreviewWidth) => void;
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
  /** 标签操作槽位恒预留空位（B115，VS Code tabActionReserveSpace，默认 true）。 */
  tabActionReserveSpace: () => boolean;
  onTabActionReserveSpace: (on: boolean) => void;
  /** 快捷键分类页所需的改键逻辑（复用 keymapdialog） */
  keymap: KeymapDialogOptions;
}

/** 「本机没装」候选的标注后缀（选了会静默回落到内置等宽栈，看着像没反应）。 */
export const FONT_FAMILY_NO_DIFF_SUFFIX = "（本机未安装，会回落默认）";

/** 字体探测用的基线名，取一个必然不存在的字体，别改成一个真名。 */
const PROBE_BOGUS_FONT = "__lite_pad_no_such_font__";

/**
 * 编辑器等宽字体候选（第一个是「默认」占位，value 为空串）。
 *
 * B225 扩充成三组：系统自带（Windows 一定在）→ 常见开发者字体 → 中文等宽。
 * ⚠️ 后两组**本机未必装了**，所以 `global.css` 里 `.panel-host .panel-editor
 * .cm-editor` 的 `font-family` 在代码栈变量之后**还挂了一份**
 * `var(--font-mono)` 作第二回落 —— 缺字体时掉回内置等宽栈，而不是浏览器的默认
 * 非等宽字体。但代价是**选了也看不出变化**（回落到的正是默认外观），用户就会
 * 反复报「改了没反应」；`fontFamilyOptions()` 负责把这类候选标出来。
 */
export const FONT_FAMILY_OPTIONS: { label: string; value: string }[] = [
  { label: "默认（Cascadia Code / Consolas…）", value: "" },
  // ⚠️ 五项系统自带的排在前面（B225 二次修订）：这台机器上真正装着的等宽字体只有
  // 它们，选到没装的那批**不会报错**，而是静默回落到内置等宽栈 —— 观感和默认一模
  // 一样。先把看得见效果的排上来，没用的挪到后面并打标（`fontFamilyOptions`）。
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "Cascadia Mono", value: "Cascadia Mono" },
  { label: "Consolas", value: "Consolas" },
  { label: "Lucida Console", value: "Lucida Console" },
  { label: "Courier New", value: "Courier New" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Fira Code", value: "Fira Code" },
  { label: "Source Code Pro", value: "Source Code Pro" },
  { label: "IBM Plex Mono", value: "IBM Plex Mono" },
  { label: "DejaVu Sans Mono", value: "DejaVu Sans Mono" },
  { label: "Hack", value: "Hack" },
  { label: "Ubuntu Mono", value: "Ubuntu Mono" },
  { label: "Noto Sans Mono", value: "Noto Sans Mono" },
  { label: "MesloLGS NF", value: "MesloLGS NF" },
  { label: "更纱黑体 Sarasa Mono SC", value: "Sarasa Mono SC" },
  { label: "霞鹜文楷 LXGW WenKai Mono", value: "LXGW WenKai Mono" },
];

/**
 * 该候选字体本机**装没装**（headless 探针实测口径）。
 *
 * 做法：把 `"X", <必然不存在的名>` 与 `<必然不存在的名>` 画同一串字符，逐像素比
 * alpha。两边一样只有一个解释 —— X 没被用上，也就是本机没装、直接落到默认字体。
 *
 * ⚠️ 先比像素，别用 `document.fonts.check()`：它对系统字体**恒返回 true**（实测
 * 10 款全 true，含没装的 JetBrains Mono / Fira / Sarasa / LXGW），判不出装没装。
 * ⚠️ 也**不要**拿 `<默认等宽栈>` 当基线去比「选了有没有差别」：实测本机上 Cascadia
 * Code 与 Cascadia Mono 在 canvas 里逐像素同形，那写法会把装着的 Cascadia Mono
 * 误判成「选了没差别」，标注就冤枉了好字体。基线只留一个不存在的名，判据唯一。
 * 判不出来（拿不到 2d 上下文 / 抛异常）一律**当装了**，宁可不标也不误标。
 */
function isFontInstalled(family: string): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    if (!ctx) return true;
    const sample = "lLiL0OQMW@#8";
    const draw = (font: string): Uint8ClampedArray => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `36px ${font}`;
      ctx.fillText(sample, 2, 6);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const withFont = draw(`"${family}", ${PROBE_BOGUS_FONT}`);
    const baseline = draw(PROBE_BOGUS_FONT);
    for (let i = 3; i < withFont.length; i += 4) {
      if (withFont[i] !== baseline[i]) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * 带本机可用性标注的编辑器字体候选（B225 二次修订）。
 *
 * 本机没装的那几项加 `FONT_FAMILY_NO_DIFF_SUFFIX` —— 它们**仍然可选**（用户自己
 * 装上字体后立刻就能用），只是先把「选了会静默回落、看着像没反应」说在前面，
 * 免得每次都当成 bug 报回来。
 */
export function fontFamilyOptions(): { label: string; value: string }[] {
  return FONT_FAMILY_OPTIONS.map((o) =>
    o.value.trim() && !isFontInstalled(o.value)
      ? { label: `${o.label}${FONT_FAMILY_NO_DIFF_SUFFIX}`, value: o.value }
      : o,
  );
}

/** 编辑器行距候选（倍数）。 */
export const EDITOR_LINE_HEIGHT_OPTIONS = [1.2, 1.5, 1.8, 2.1];

// ---------------------------------------------------------------- B227 字体两栏

/**
 * 字体候选的两小类：**等宽** 与 **比例**（非等宽）。
 *
 * ⚠️ B236：原先是「全部 / 等宽」——「全部」其实只是「不过滤」，等于把等宽混在正文
 * 那一栏里。用户裁决改成两档互斥（比例 / 等宽），并且**两栏共用同一个列表**：
 * 两栏的候选集合完全一样，唯一差别是**默认停在哪一档**（正文 → 比例、代码 → 等宽）。
 */
export type FontKind = "mono" | "proportional";

/** 两小类的分段标签（顺序即渲染顺序）。 */
export const FONT_KIND_LABELS: { kind: FontKind; label: string }[] = [
  { kind: "proportional", label: "比例" },
  { kind: "mono", label: "等宽" },
];

/** 内嵌默认在候选里的说法（value 是空串 = 移除变量、回落默认栈）。 */
export const DEFAULT_BODY_FONT_LABEL = "默认（内嵌思源黑体）";
export const DEFAULT_CODE_FONT_LABEL = "默认（内嵌 Cascadia Mono）";

/**
 * 某一栏的候选：内嵌默认 + 本机枚举里**当前这一档**的字体。
 *
 * ⚠️ 正文与代码两栏调用的是**同一个函数、同一份枚举**，所以候选集合完全一样；
 * 差别只在调用方传的 `kind`（默认停哪一档）与 `defaultLabel`（内嵌默认那一项的说法）。
 *
 * ⚠️ 当前值不在本档里要分两种情况：
 *   · **本机没装**（选过、后来卸了）⇒ 照样列出来并打未安装标记 —— 悄悄退回默认值
 *     会让人以为设置被重置了，而它其实只是「没装」。
 *   · **装了但不在这一档**（当前是等宽、正切在「比例」档）⇒ 也列出来，但**不打标**
 *     （它装得好好的，打了标是误导），否则下拉触发器显示不出当前值。
 * ⚠️ 枚举为空（非 Windows / IPC 失败）时退回 B225 那份手抄清单，别把这一栏变空。
 */
export function fontOptionsFor(
  kind: FontKind,
  current: string,
  systemFonts: { name: string; is_monospace: boolean }[],
  defaultLabel: string,
): { label: string; value: string }[] {
  if (!systemFonts.length) return fontFamilyOptions();
  // 两档互斥（B236）：等宽那批归 mono，其余归 proportional。
  const bucket = systemFonts.filter((f) => (kind === "mono" ? f.is_monospace : !f.is_monospace));
  const out: { label: string; value: string }[] = [{ label: defaultLabel, value: "" }];
  const picked = current.trim();
  if (picked && !bucket.some((f) => f.name === picked)) {
    const installed = systemFonts.some((f) => f.name === picked);
    out.push({
      label: installed ? picked : `${picked}${FONT_FAMILY_NO_DIFF_SUFFIX}`,
      value: picked,
    });
  }
  for (const f of bucket) out.push({ label: f.name, value: f.name });
  return out;
}

/** 预览行距候选（倍数），沿用原菜单三档。 */
export const PREVIEW_LINE_HEIGHT_OPTIONS = [1.3, 1.7, 2.1];

/**
 * B235：预览**正文内容区**宽度三档（顺序即渲染顺序）。
 *
 * ⚠️ 管的是**正文居中宽度**，不是源码与预览两栏的分屏比例（那个由拖拽分隔条管）。
 * `value` 是**档位名**而不是 px —— 同一档在不同分辨率/缩放下观感才稳定。
 */
export const PREVIEW_WIDTH_OPTIONS: { value: PreviewWidth; label: string }[] = [
  { value: "standard", label: "标准（860px）" },
  { value: "wide", label: "宽屏（1100px）" },
  { value: "full", label: "全宽（不限宽）" },
];

/** 档位 → 中文标签（提示气泡与设置项共用一份，别手抄第二遍）。 */
export const PREVIEW_WIDTH_LABELS: Record<PreviewWidth, string> = {
  standard: "标准",
  wide: "宽屏",
  full: "全宽",
};

// ⚠️ B235：`TOC_WIDTH_OPTIONS`（大纲宽度候选）已连同设置项一起删除 ——
//    用户点名「去除大纲宽度」。大纲宽度仍由左侧栏的拖拽分隔条控制
//    （`clampSideWidth`，160–640px，拖完回写 `settings.toc_width`），功能没丢。
//    这个常量原先只有设置页那一行在用 ⇒ 删干净，别留死代码。

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
    keywords: [
      "外观",
      "主题",
      "浅色",
      "深色",
      "跟随系统",
      "标签样式",
      "相连",
      "药丸",
      "tab",
      "预留",
      "空位",
      "标签按钮",
    ],
  },
  {
    id: "editor",
    label: "编辑器",
    // B229：原先那个独立的预览分类已并入本页，所以预览侧的关键词也归到这儿
    // ——否则搜「预览行距」「大纲」会一个分类都命中不了。
    keywords: [
      "编辑器",
      "字体",
      "字号",
      "行距",
      "正文字体",
      "代码字体",
      "编辑器行距",
      "markdown",
      "预览",
      "预览行距",
      // B235：设置项换成了「预览布局宽度」⇒ 关键词同步跟着换。
      // 「宽度」「全宽」「宽屏」都补上，用户按**结果**搜比按设置项名搜更自然。
      "预览布局宽度",
      "宽度",
      "全宽",
      "宽屏",
      "大纲",
      "目录",
      "toc",
    ],
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

/**
 * B227：字体选择行 ＝ 分段小切换（B236 起是 比例 / 等宽）＋ 字体下拉。
 *
 * 切小类时整块重建下拉（`createDropdown` 没有 setOptions，destroy 后再建一个）：
 * 候选集合变了，触发器上「当前项」那几个字也得跟着重算，不能留着上一栏的。
 * 两行各自记着自己那一栏的小类（闭包里的 `kind`），互不干扰。
 */
function fontRow(
  label: string,
  desc: string,
  current: string,
  onPick: (v: string) => void,
  systemFonts: { name: string; is_monospace: boolean }[],
  defaultLabel: string,
  initialKind: FontKind,
): HTMLElement {
  let kind: FontKind = initialKind;
  const wrap = document.createElement("div");
  wrap.className = "font-picker";
  const tabs = document.createElement("div");
  tabs.className = "font-picker-tabs";
  tabs.setAttribute("role", "tablist");
  const slot = document.createElement("div");
  slot.className = "font-picker-slot";
  let dd: ReturnType<typeof createDropdown> | null = null;

  function buildTabs(): void {
    tabs.textContent = "";
    for (const { kind: k, label: text } of FONT_KIND_LABELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "font-picker-tab" + (k === kind ? " is-on" : "");
      b.textContent = text;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(k === kind));
      b.addEventListener("click", () => {
        if (k === kind) return;
        kind = k;
        buildTabs();
        buildDropdown();
      });
      tabs.appendChild(b);
    }
  }
  function buildDropdown(): void {
    dd?.destroy();
    const options = fontOptionsFor(kind, current, systemFonts, defaultLabel);
    dd = createDropdown({
      options,
      current,
      onPick,
      ariaLabel: options.find((o) => o.value === current)?.label,
      // B230：本机字体枚举动辄几十项，翻找不现实 ⇒ 开搜索框 + 列表限高滚动。
      // （其它下拉三五项，不开搜索，免得展开时多一行噪声。）
      searchable: true,
      searchPlaceholder: "搜索字体…",
    });
    slot.textContent = "";
    slot.appendChild(dd.root);
  }
  buildTabs();
  buildDropdown();
  wrap.append(tabs, slot);
  return settingsItem(label, desc, wrap);
}

/**
 * B229：页内小分组标题（纯装饰）。用于「编辑器」页把源码侧与预览侧隔开。
 * 上下留白比 `.settings-item` 的 padding 小一档，视觉上从属于它下面那几行。
 */
function groupTitle(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "settings-group-title";
  h.textContent = text;
  return h;
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
    body.appendChild(
      toggleRow(
        "标签按钮预留空位",
        "开启：每个标签右侧固定预留 ●/× 槽位，已保存的活动标签常驻关闭按钮（VS Code 默认）；关闭：已保存标签收紧文字，悬停时按钮浮出。",
        opts.tabActionReserveSpace(),
        (v) => opts.onTabActionReserveSpace(v),
      ),
    );
  } else if (id === "editor") {
    // B231：口径 —— **正文字体**只管预览模式的正文，**代码字体**管编辑器源码区
    // （源码是代码）+ 预览里的行内代码/代码块。两者彻底分开，界面文字不跟
    // （用户裁决：标签栏/菜单/状态栏保持不可配）。候选来自 Rust `list_fonts`
    // 的本机枚举，等宽/全部两栏切换；枚举没到手时由 fontOptionsFor 退回
    // B225 的手抄清单。
    const sys = opts.systemFonts();
    body.appendChild(
      fontRow(
        "正文字体",
        "预览模式的正文（非等宽）。编辑器源码区与预览里的代码归「代码字体」。",
        opts.fontFamily(),
        (v) => opts.onFontFamily(v),
        sys,
        DEFAULT_BODY_FONT_LABEL,
        // B236：正文默认停在「比例」档（非等宽）。两栏的候选集合是同一份，
        // 用户切到「等宽」照样能挑等宽字体 —— 只是默认落点不同。
        "proportional",
      ),
    );
    body.appendChild(
      fontRow(
        "代码字体",
        "编辑器源码区，以及预览里的行内代码与代码块（凡是代码一律等宽）。",
        opts.codeFontFamily(),
        (v) => opts.onCodeFontFamily(v),
        sys,
        DEFAULT_CODE_FONT_LABEL,
        // 代码默认停在「等宽」档（与正文同为一份候选，只是默认落点不同，B236）
        "mono",
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
    // B229：预览侧的两项从原预览分类并到本页，末尾加个小分组标题，
    // 免得 6 行平铺时看不出哪两项只管预览。分组标题是纯装饰，不进搜索关键词。
    body.appendChild(groupTitle("预览"));
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
      selectRow(
        "预览布局宽度",
        // B238：说明压到一句（用户嫌长）。三档的具体宽度在选项标签里已经写着
        // （标准 860px / 宽屏 1100px / 全宽不限宽），这里只交代**它管的是什么**。
        "预览模式内容区的宽度",
        PREVIEW_WIDTH_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
        opts.previewWidth(),
        // `selectRow` 的回调签名是 `string`（它不认枚举）⇒ 在这里收窄回档位类型，
        // 别把 `as PreviewWidth` 甩到别处去。
        (v) => opts.onPreviewWidth(v as PreviewWidth),
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
