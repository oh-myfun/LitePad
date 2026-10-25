/**
 * 统一设置页（B106：把原「设置 → 首选项」与「设置 → 快捷键」两个弹窗合并成
 * 一个三栏设置页：顶部搜索 + 左侧分类导航 + 右侧设置项，并改名为「设置」。
 * 入口两处：「文件 → 设置…」（见 menubar.ts）与侧栏按钮列底部那颗齿轮
 * （B353，见 prefs.ts 的 setupSettingsEntry）。
 *
 * 结构与类名参考 InkNote 的 Settings.tsx，B353 起外面套一层**窗口壳**：
 *   settings-overlay > win-frame.settings-window(标题栏「设置」+ 八向把手) > win-body >
 *     settings-toolbar(搜索) + settings-layout(settings-nav + settings-content)
 * 分类：通用 / 外观 / 编辑器 / 新建文件 / 快捷键（快捷键复用 keymapdialog
 * 的改键逻辑，作为其中一个分类页）。B229 起原先那个独立的预览分类并入「编辑器」，
 * 预览侧两项（预览行距、预览布局宽度）在本页末尾的「预览」小分组里。
 *
 * B353（用户点名「参考 vscode 做成带标题栏可拖拽和可调整大小的设置窗口」）：
 * 关闭键从工具栏搬进标题栏，尺寸与位置归窗框（原来是 `.settings-panel` 的
 * `width: min(880px, 94vw)` 那一档，现在由 JS 的默认矩形给）。
 * B235：原先在这儿的「大纲宽度」已按用户要求删除 —— 大纲宽度改由左侧栏的
 * 拖拽分隔条单独控制，设置页不再有那一项。
 *
 * 与旧首选项弹窗一致：每个控件 change 即回调 main 的 setter（即时生效 + 持久化），
 * 不需要「保存」按钮。快捷键的录制态会挂 KEYMAP_RECORDING_CLASS，让全局快捷键分发器让路。
 */

import { mountKeymapPage, type KeymapDialogOptions, type KeymapPageHandle } from "./keymapdialog";
import { buildFrame, centeredRect, type WinViewport } from "./windowframe";
import { createDropdown } from "./dropdown";
import { createSwitch } from "./switch";
// B235：`PreviewWidth` 是宽度档的类型（standard / wide / full）。
// B385：文件关联的条目状态类型。
import type { AssocEntry, PreviewWidth } from "../ipc/api";
import type { ThemeFamily } from "../theme/theme";
// B288：日志级别五档的类型（设置页下拉要用它收窄回调参数）。
import { type LogLevel } from "../core/logger";

export type ThemeChoice = "system" | "light" | "dark";

export interface SettingsDialogOptions {
  theme: () => ThemeChoice;
  onTheme: (mode: ThemeChoice) => void;
  /** B377：VS Code 默认主题族（2026 / modern / plus / classic / hc）。 */
  themeFamily: () => ThemeFamily;
  onThemeFamily: (family: ThemeFamily) => void;
  /** 空串 = 内置默认字体栈 */
  fontFamily: () => string;
  onFontFamily: (family: string) => void;
  /** B227：代码字体族名（预览 code / pre）；空串 = 用内嵌 Cascadia Mono */
  codeFontFamily: () => string;
  onCodeFontFamily: (family: string) => void;
  /** B347：界面字体族名（只有窗口外壳）；空串 = 用内嵌那颗度量别名 face */
  uiFontFamily: () => string;
  onUiFontFamily: (family: string) => void;
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
  /** B372：新建空白文档的默认语言标签（空串 = 自动 / 纯文本）。 */
  defaultLang: () => string;
  languageOptions: () => string[];
  onDefaultLang: (value: string) => void;
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
  /**
   * B288：日志级别（error / warn / info / debug / trace）。「通用」分类里的下拉。
   *
   * ⚠️ 它**不在**前端 `settings` 对象里 —— 级别走独立的 `log_level` / `set_log_level`
   *    IPC（Rust 侧持有 `session.log_level` 并**即时生效**，不用重启）。所以这一对
   *    getter/setter 直连 `core/logger`，与「自动保存」那类读 `settings` 的项不是
   *    同一个来源 —— 别照抄成 `settings?.log_level`。
   */
  logLevel: () => LogLevel;
  onLogLevel: (level: LogLevel) => void;
  /**
   * B288（B289 改道）：「打开日志文件」—— 由**本应用**把 `<配置目录>/logs/litepad.log`
   * 开成一个标签页，不再交给系统关联程序（那条路依赖 `.log` 被设成什么程序，起不来时
   * 界面上只剩「点了没反应」）。
   *
   * 排查问题时（比如启动异常 / 保存失败）要反复看日志，不该让用户自己去
   * `%APPDATA%` 里摸路径 —— 何况配置目录还能被 `LITEPAD_CONFIG_DIR` 搬走。
   */
  onOpenLog: () => void;
  /**
   * B305：最近打开保留数量（0 = 不再记录并清空现有名单，B306 起还把左栏那颗键一起收起）。
   *
   * 与 `logLevel` 同款：**不在前端 `settings` 对象里**。名单与它的上限由 Rust 单点持有
   *（`recents.json`）—— `settings.json` 没有权威窗口，每扇窗口都能整表覆写，放进去迟早
   * 被一次无关的设置写入冲掉。所以这一对 getter/setter 直连 `recents/store`。
   */
  recentLimit: () => number;
  onRecentLimit: (limit: number) => void;
  /**
   * B385：文件关联。注册表是唯一权威（见 `commands/assoc.rs` 头部），设置页打开时
   * 拉一次整表、每次开关后用返回的那条就地刷新 —— 值不进前端 `settings` 对象，
   * 与 `recentLimit` 同款口径。
   */
  assocEntries: () => Promise<AssocEntry[]>;
  onAssocSet: (ext: string, on: boolean) => Promise<AssocEntry>;
  /** B385：打开系统「默认应用」设置页（UserChoice 档只能用户在那儿拍）。 */
  onOpenDefaultApps: () => void;
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
 * B347：界面字体那颗默认 face 与正文那颗**字形相同**（同一份 woff2），差别只在行盒里
 * 基线的位置（中文墨迹挪到正中）。所以这里不写「度量别名」那种实现话术 —— 对用户来说
 * 它就是「内嵌思源黑体」，字重字宽一字不差。
 */
export const DEFAULT_UI_FONT_LABEL = "默认（内嵌思源黑体）";

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
 *
 * ⚠️ 枚举为空（非 Windows / IPC 失败）时退回 B225 那份手抄清单，别把这一栏列空。
 * ⚠️ **B239：那份清单整份都是等宽字体**，直接挂在「比例（非等宽）」档下是自相矛盾
 *   的（用户会以为档位筛选没生效）。更糟的是它首项写死了「默认（Cascadia Code /
 *   Consolas…）」—— 那是**代码**字体的默认，出现在正文那栏等于把话说反了。
 *   ⇒ 兜底时把首项换成本档的 `defaultLabel`，其余项照旧（仍带未安装标记）。
 */
export function fontOptionsFor(
  kind: FontKind,
  current: string,
  systemFonts: { name: string; is_monospace: boolean }[],
  defaultLabel: string,
): { label: string; value: string }[] {
  if (!systemFonts.length) {
    // B239：兜底时把首项换成本档的内嵌默认说法（手抄清单那份首项写死的是**代码**
    // 字体的默认，出现在正文那栏等于把话说反了），其余项原样带未安装标记。
    const fallback = fontFamilyOptions();
    return [{ label: defaultLabel, value: "" }, ...fallback.slice(1)];
  }
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
//    （`clampSideWidth`，最小宽到 640px，下限见 `SIDE_MIN_WIDTH`；拖完回写 `settings.toc_width`），功能没丢。
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
    keywords: [
      "通用",
      "首选项",
      "自动保存",
      "热退出",
      "保存",
      "备份",
      "autosave",
      "hot exit",
      // B305：顶部搜索是按关键词过滤分类的，不补这几个 ⇒ 搜「最近打开」一个分类都命中不了。
      "最近打开",
      "最近文件",
      "名单",
      "上限",
      "历史",
    ],
  },
  {
    id: "appearance",
    label: "外观",
    keywords: [
      "外观",
      "主题",
      "内置主题",
      "配色",
      "2026",
      "modern",
      "plus",
      "经典",
      "高对比度",
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
    keywords: [
      "新建文件",
      "新建文档",
      "文档类型",
      "文件类型",
      "默认类型",
      "语言",
      "行尾",
      "编码",
      "默认行尾",
      "默认编码",
      "换行符",
      "eol",
      "markdown",
    ],
  },
  {
    id: "assoc",
    label: "文件关联",
    keywords: [
      "文件关联",
      "关联",
      "默认打开",
      "打开方式",
      "双击打开",
      "扩展名",
      "后缀",
      "格式",
      "md",
      "txt",
      "log",
      "默认应用",
    ],
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

/** 默认尺寸沿用旧弹层那一档（原先写在 `.settings-panel` 的 `width/height` 里）；
    实际打开时再按视口收，最小值归窗框（`WIN_MIN`）。 */
const SETTINGS_W = 880;
const SETTINGS_H = 640;

export function showSettingsDialog(opts: SettingsDialogOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";
  document.body.appendChild(overlay);

  const viewport = (): WinViewport => ({ w: window.innerWidth, h: window.innerHeight });
  const v0 = viewport();
  // onClose 在建窗那一刻就要交出去，而 close() 的真身要等下面 keymapHandle 就位才写得成
  // ⇒ 先占位、装配完再换（不占位就得把窗框建到函数末尾，标题栏会晚一帧才出现）。
  let closeWindow = (): void => {};
  const frame = buildFrame({
    title: "设置",
    // 四周各留 12px：顶满视口就看不出「这是一块浮着的窗」，也与遮罩的边距手感一致。
    rect: centeredRect(v0, Math.min(SETTINGS_W, v0.w - 24), Math.min(SETTINGS_H, v0.h - 24)),
    viewport,
    onClose: () => closeWindow(),
    className: "settings-window",
    host: overlay,
  });

  // ---- 顶部工具栏：搜索（关闭键在标题栏，见上面的 buildFrame） ----
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

  toolbar.append(searchWrap);

  // ---- 主体：左侧导航 + 右侧内容 ----
  const layout = document.createElement("div");
  layout.className = "settings-layout";

  const nav = document.createElement("nav");
  nav.className = "settings-nav";

  const content = document.createElement("div");
  content.className = "settings-content";

  layout.append(nav, content);
  frame.body.append(toolbar, layout);

  // 每个分类页先建好，靠 hidden 切换（避免搜索时反复重建 keymap 页）
  const pages: Record<string, HTMLElement> = {};
  let keymapFilter: ((q: string) => void) | null = null;
  let keymapHandle: KeymapPageHandle | null = null;
  // 默认停在「通用」——显式写死，避免分类顺序调整时默认页跟着漂移（B323 用户口径：
  // 打开设置先落在通用那一页）。改这条要连 `tests/settingsdialog.test.ts` 里那条
  // 「默认停在通用」一起改，那一条是这一句唯一的运行时证据。
  let active = "general";

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

  closeWindow = close;
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

/**
 * B372：长列表下拉（语言 60+ 条）—— 与字体下拉同款，开搜索框 + 列表限高。
 * 通用 `selectControl` 保持无搜索（`tests/dropdown.test.ts` 有反向闸：
 * 三五项的小下拉不该在展开时多一行搜索框）。
 */
function searchableSelectRow(
  label: string,
  desc: string,
  options: { label: string; value: string }[],
  current: string,
  onPick: (v: string) => void,
): HTMLElement {
  const dd = createDropdown({
    options: options.map((o) => ({ label: o.label, value: o.value })),
    current,
    onPick,
    searchable: true,
    searchPlaceholder: "搜索语言…",
    ariaLabel: options.find((o) => o.value === current)?.label,
  });
  return settingsItem(label, desc, dd.root);
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

/** B288：日志级别五档（`core/logger` 的 `LogLevel`），由低到高。 */
const LOG_LEVEL_OPTIONS: { label: string; value: LogLevel }[] = [
  { label: "错误（error）", value: "error" },
  { label: "警告（warn）", value: "warn" },
  { label: "信息（info，默认）", value: "info" },
  { label: "调试（debug）", value: "debug" },
  { label: "跟踪（trace）", value: "trace" },
];

/**
 * B288：一行「说明 + 右侧按钮」—— 设置页里唯一**触发动作**而不是改值的那类项。
 *
 * ⚠️ 与 `toggleRow` / `selectRow` 同款（`settingsItem` 拼装），只是控件换成一个普通
 *    button。全局 `button` 是透明底，行内看不出可点 ⇒ 补 `.settings-mini-btn` 那条
 *    边框（样式在 global.css），与下拉 / 开关的观感对齐。
 */
function buttonRow(
  label: string,
  desc: string,
  btnLabel: string,
  onClick: () => void,
): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "settings-mini-btn";
  btn.type = "button";
  btn.textContent = btnLabel;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", onClick);
  return settingsItem(label, desc, btn);
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
    // B305：最近打开保留数量。`0` 是**有语义的一档**（不再记录 + 清空 + 收起左栏入口，
    // 见 `src/recents/panel.ts` 的 B306），不是一个空值 —— 所以它必须出现在说明里，
    // 否则用户只能靠试才知道「选了 0，名单和那颗键就都没了」。
    // 档位就地列出来、不抽常量：这一档候选只有这一处用，抽出去反而让「行与它的档位」
    // 分在两处，改档位时说明文字容易跟着漏。
    body.appendChild(
      selectRow(
        "最近打开保留数量",
        "打开过的文档在左栏「最近打开」里留几条（正开着的也留在名单里，按最后一次打开的时间排，再打开一次就顶到最前；重新打开软件时把上次的标签开回来不算一次打开）。选 0 = 不再记录、清空现有名单，并收起左栏那颗「最近打开」键。",
        [
          { label: "不记录（0）", value: "0" },
          { label: "10 条", value: "10" },
          { label: "20 条", value: "20" },
          { label: "50 条（默认）", value: "50" },
          { label: "100 条", value: "100" },
        ],
        String(opts.recentLimit()),
        (v) => opts.onRecentLimit(Number(v)),
      ),
    );
    // B288：日志级别 —— 排查问题时临时开 debug / trace 复现，**即时生效、不用换包重启**。
    //   ⚠️ 说明里必须交代高档位的代价：滚动 / 同步那几路一秒能打几十条，默认的 2MB
    //      日志会被很快冲掉（见 core/logger 与 core/viewport 那两条「别提到 info」的
    //      纪律）⇒ 长时间挂着等于看不到更早的记录，定位完应调回「信息」。
    body.appendChild(
      selectRow(
        "日志级别",
        "排查问题时临时调高：debug / trace 会记下滚动、同步、视口等诊断行，即时生效、不用重启；级别越高日志越大、旧记录被冲掉得越快，定位完建议调回「信息」。",
        LOG_LEVEL_OPTIONS,
        opts.logLevel(),
        (v) => opts.onLogLevel(v as LogLevel),
      ),
    );
    body.appendChild(
      buttonRow(
        "日志文件",
        "在 LitePad 里把 litepad.log 开成一个标签页（配置目录下的 logs 目录）。",
        "打开",
        () => opts.onOpenLog(),
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
        "内置主题",
        "移植 VS Code 自带的默认配色（深浅各一套）：2026 是新版默认，Modern / Plus / 经典 是历代默认，高对比度为无障碍档。只换配色，不改变上面的明暗选择。",
        [
          { label: "VS Code 2026（默认）", value: "2026" },
          { label: "VS Code Modern", value: "modern" },
          { label: "VS Code Plus", value: "plus" },
          { label: "VS Code 经典", value: "classic" },
          { label: "VS Code 高对比度", value: "hc" },
        ],
        opts.themeFamily(),
        (v) => opts.onThemeFamily(v as ThemeFamily),
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
    // 三栏各管一段，互不越界（B231 定的口径，B347 补上第三栏）：
    //   · **界面字体** = 窗口外壳（标题栏 / 菜单 / 标签条 / 左侧栏 / 这一页）
    //   · **正文字体** = 预览模式的正文
    //   · **代码字体** = 编辑器源码区 + 预览里的行内代码 / 代码块（凡是代码一律等宽）
    // 候选来自 Rust `list_fonts` 的本机枚举，等宽/全部两栏切换；枚举没到手时由
    // fontOptionsFor 退回 B225 的手抄清单。
    const sys = opts.systemFonts();
    body.appendChild(
      fontRow(
        "界面字体",
        "标题栏、菜单、标签与左侧栏的文字。预览正文与代码不跟这一项。",
        opts.uiFontFamily(),
        (v) => opts.onUiFontFamily(v),
        sys,
        DEFAULT_UI_FONT_LABEL,
        // 默认那颗是内嵌思源的度量别名（中文在行盒里已居中），落在「比例」档
        "proportional",
      ),
    );
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
      searchableSelectRow(
        "默认文档类型",
        "新建空白文档时使用的文件类型；已命名文件仍按文件名自动识别。",
        [
          { label: "自动检测（纯文本）", value: "" },
          ...opts.languageOptions().map((l) => ({ label: l, value: l })),
        ],
        opts.defaultLang(),
        (v) => opts.onDefaultLang(v),
      ),
    );
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
  } else if (id === "assoc") {
    fillAssocPage(body, opts);
  }
}

/**
 * B385：「文件关联」分类页。
 *
 * 注册表读写都走 IPC（`commands/assoc.rs`），本页只管状态展示：
 *   · 整表是**异步**拉的（注册表枚举不适合阻塞建页），先渲染说明与骨架；
 *   · 展示是**勾选网格**（B385 二轮，用户口径：预设格式扩成文本全家桶后
 *     一行一条太长）；每格勾选后用返回的那条就地重画自己（不整表重拉）；
 *   · 「注册了但不是系统默认」那档挂「未生效」小标 —— UserChoice 被别的程序
 *     占着时勾了 ≠ 双击生效，必须让用户看得出差别；
 *   · 自定义扩展名也收（Rust 侧校验；拒绝时把错误写在输入行下面）。
 */
function fillAssocPage(body: HTMLElement, opts: SettingsDialogOptions): void {
  const hint = document.createElement("p");
  hint.className = "settings-page-desc";
  hint.textContent =
    "勾选后双击该格式的文件会用 LitePad 打开；取消勾选会还原之前的打开方式。若 Windows 已为某格式记住「用户选择」，可能仍按原程序打开 —— 到「系统默认应用」里确认。";
  body.appendChild(hint);

  // B385 二轮（用户口径）：预设格式扩成文本全家桶、展示从「一行一开关」改成
  // **勾选网格** —— 三十来个格式一行一条会把页面拉得过长，网格一屏放得下。
  const list = document.createElement("div");
  list.className = "settings-assoc-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "关联的文件格式");
  body.appendChild(list);

  /** 一格：native checkbox + `.ext`。注册了但不是系统默认的那档挂「未生效」小标
   *  （UserChoice 被别的程序占着，见页面说明）。 */
  const renderEntry = (e: AssocEntry): HTMLElement => {
    const label = document.createElement("label");
    label.className = "settings-assoc-item";
    label.dataset.ext = e.ext;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = e.registered;
    box.setAttribute("aria-label", `关联 .${e.ext}`);
    const text = document.createElement("span");
    text.textContent = `.${e.ext}`;
    label.append(box, text);
    if (e.registered && !e.isDefault) {
      const badge = document.createElement("span");
      badge.className = "settings-assoc-badge";
      badge.textContent = "未生效";
      label.appendChild(badge);
    }
    box.addEventListener("change", () => {
      const want = box.checked;
      box.disabled = true;
      void opts
        .onAssocSet(e.ext, want)
        .then((nu) => label.replaceWith(renderEntry(nu)))
        .catch(() => {
          // 写注册表失败（被组策略锁住之类）：回滚到真实状态，勾不能停在假位置
          void opts.assocEntries().then((all) => {
            const cur = all.find((x) => x.ext === e.ext);
            if (cur) label.replaceWith(renderEntry(cur));
          });
        })
        .finally(() => {
          box.disabled = false;
        });
    });
    return label;
  };

  const renderAll = (entries: AssocEntry[]): void => {
    list.textContent = "";
    for (const e of entries) list.appendChild(renderEntry(e));
  };
  void opts
    .assocEntries()
    .then(renderAll)
    .catch(() => {
      list.textContent = "";
      const err = document.createElement("p");
      err.className = "settings-page-desc";
      err.textContent = "读不到关联状态（注册表不可用）。";
      list.appendChild(err);
    });

  // 自定义扩展名：输入 + 添加。校验在 Rust（normalize_ext），拒绝时错误落在输入行下。
  const input = document.createElement("input");
  input.className = "settings-assoc-input";
  input.type = "text";
  input.placeholder = "扩展名，如 csv";
  input.setAttribute("aria-label", "自定义扩展名");
  const add = document.createElement("button");
  add.className = "settings-mini-btn";
  add.type = "button";
  add.textContent = "添加";
  const control = document.createElement("div");
  control.className = "settings-assoc-add";
  control.append(input, add);
  const errMsg = document.createElement("div");
  errMsg.className = "settings-item-desc";
  body.appendChild(
    settingsItem("自定义扩展名", "不在清单里的格式也可以关联；不带点，如 csv。", control),
  );
  body.appendChild(errMsg);

  const submit = (): void => {
    const ext = input.value.trim();
    if (!ext) return;
    add.disabled = true;
    errMsg.textContent = "";
    opts
      .onAssocSet(ext, true)
      .then((nu) => {
        input.value = "";
        const exist = list.querySelector<HTMLElement>(`[data-ext="${nu.ext}"]`);
        if (exist) exist.replaceWith(renderEntry(nu));
        else {
          // 网格按字母序排，插对位置再重画，别甩在末尾
          const all = Array.from(list.querySelectorAll<HTMLElement>("[data-ext]")).map(
            (el) => el.dataset.ext ?? "",
          );
          const at = all.findIndex((x) => x > nu.ext);
          const el = renderEntry(nu);
          if (at < 0) list.appendChild(el);
          else list.insertBefore(el, list.children[at]);
        }
      })
      .catch((err: unknown) => {
        errMsg.textContent = String(err instanceof Error ? err.message : err);
      })
      .finally(() => {
        add.disabled = false;
      });
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });

  body.appendChild(
    buttonRow(
      "系统默认应用",
      "Windows 记住的「用户选择」哈希保护、别的程序改不了，最终档在系统设置里确认。",
      "打开设置",
      () => opts.onOpenDefaultApps(),
    ),
  );
}
