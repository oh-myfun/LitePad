/**
 * 快捷键注册表：默认键位 + 用户覆盖 + 事件匹配 + 冲突检测。
 *
 * 设计要点
 * - 键位统一用 `Ctrl+Shift+S` 这样的字符串表示（Windows 习惯，`Ctrl` 即 Mod）。
 * - 解析以 `KeyboardEvent.code` 为主：`Ctrl+Shift+[` 的 `e.key` 是 `{`，
 *   只看 `key` 会把 `Ctrl+Shift+[` 和别的键位搞混；`code` 是物理键位，稳定得多。
 * - 一个命令可以有多条默认键位（如标签切换的 Ctrl+Tab / Ctrl+PgDn）。
 *   一旦用户自定义，就只保留自定义的那一条。
 * - `editable: false` 的命令由 CodeMirror / 系统原生处理，只作展示，不参与分发。
 */

export interface Binding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** 规范化键名：单字符小写（"s" "/" "[" "=" "0"），或命名键（"f5" "arrowright" "pageup"） */
  key: string;
}

export interface CommandDef {
  id: string;
  /** 命令名（用于快捷键对话框与菜单） */
  label: string;
  /** 分组名（快捷键对话框按此分段） */
  group: string;
  /** 默认键位，可多条 */
  keys: string[];
  /** false = 编辑器/系统内置，仅展示不可改 */
  editable?: boolean;
  /** true = 事件已被编辑器处理时也照常触发（F5 必须拦住 WebView2 刷新） */
  force?: boolean;
  /** 备注（悬停提示） */
  note?: string;
}

/** 用户覆盖表：命令 id → 键位字符串。空表即全部使用默认。 */
export type KeymapOverrides = Record<string, string>;

// ---------------------------------------------------------------- 键名规范化

const NAMED_KEYS: Record<string, string> = {
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  PageUp: "pageup",
  PageDown: "pagedown",
  Home: "home",
  End: "end",
  Insert: "insert",
  Delete: "delete",
  Backspace: "backspace",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  Space: "space",
};

/** KeyboardEvent.code → 规范化键名 */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Backslash: "\\",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  ...NAMED_KEYS,
};

/** 显示名（带箭头的方向键更省空间，与 Windows 习惯一致）。 */
const KEY_LABELS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  pageup: "PgUp",
  pagedown: "PgDn",
  escape: "Esc",
  delete: "Del",
  insert: "Ins",
  space: "Space",
  tab: "Tab",
  enter: "Enter",
  backspace: "Backspace",
  home: "Home",
  end: "End",
};

/** 无修饰键也允许绑定的键（功能键 / 导航键），避免把裸字母绑走导致无法输入。 */
const NON_TEXT_KEYS = new Set<string>([
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "pageup",
  "pagedown",
  "home",
  "end",
  "insert",
  "delete",
  "escape",
  "tab",
]);

/** 常见简写 → 规范化键名 */
const KEY_ALIASES: Record<string, string> = {
  del: "delete",
  ins: "insert",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
  spacebar: "space",
  return: "enter",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
};

function normalizeKeyToken(token: string): string {
  if (token.length === 1) return token.toLowerCase();
  const lower = token.toLowerCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower;
  if (NAMED_KEYS[token]) return NAMED_KEYS[token];
  return KEY_ALIASES[lower] ?? lower;
}

/** 修饰键写法。最后一段若仍是修饰键，说明这个串没有真正的按键，判为非法。 */
const MODIFIER_TOKENS = new Set([
  "ctrl",
  "control",
  "cmd",
  "meta",
  "win",
  "alt",
  "option",
  "shift",
]);

/**
 * 解析键位字符串；无法解析返回 null。
 *
 * 末段键名采取**宽容**策略：非修饰键的命名键一律接受（小写化）。
 * 因为 `bindingFromEvent` 会按 `code` 派生出 `numpad0` / `intlbackslash` /
 * `printscreen` 这类冷门键名，若这里只认白名单，录进来的键位会在下次启动
 * 时被 sanitize 掉，表现为「改了键却失效」。
 */
export function parseKey(spec: string): Binding | null {
  const parts = spec
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const binding: Binding = { ctrl: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lower = p.toLowerCase();
    const isLast = i === parts.length - 1;
    if (isLast) {
      if (MODIFIER_TOKENS.has(lower)) return null;
      binding.key = normalizeKeyToken(p);
    } else if (
      lower === "ctrl" ||
      lower === "control" ||
      lower === "cmd" ||
      lower === "meta" ||
      lower === "win"
    ) {
      // 仅面向 Windows：把 Cmd/Meta/Win 一并归到 Ctrl
      binding.ctrl = true;
    } else if (lower === "alt" || lower === "option") {
      binding.alt = true;
    } else if (lower === "shift") {
      binding.shift = true;
    } else {
      return null;
    }
  }
  return binding.key ? binding : null;
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.key === b.key;
}

/** 规范化键位字符串（用于去重与比较），无法解析时原样返回。 */
export function normalizeSpec(spec: string): string {
  const b = parseKey(spec);
  return b ? formatBinding(b) : spec;
}

export function formatBinding(b: Binding): string {
  const mods: string[] = [];
  if (b.ctrl) mods.push("Ctrl");
  if (b.alt) mods.push("Alt");
  if (b.shift) mods.push("Shift");
  let label: string;
  if (KEY_LABELS[b.key]) label = KEY_LABELS[b.key];
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(b.key)) label = b.key.toUpperCase();
  else label = b.key.length === 1 ? b.key.toUpperCase() : b.key;
  return [...mods, label].join("+");
}

/** 纯修饰键的 code（ControlLeft / ShiftRight / MetaLeft …），录制时不算有效按键。 */
const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS|AltGraph)(Left|Right)?$/;
const LOCK_CODES = new Set(["CapsLock", "NumLock", "ScrollLock"]);

/** 从键盘事件取出键位；纯修饰键按下返回 null（录制时应继续等待）。 */
export function bindingFromEvent(e: KeyboardEvent): Binding | null {
  const code = e.code || "";
  if (MODIFIER_CODE.test(code) || LOCK_CODES.has(code)) return null;
  let key = CODE_KEYS[code];
  if (!key) {
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code.toLowerCase();
    else if (code) key = code.toLowerCase();
    else if (e.key && e.key.length === 1) key = e.key.toLowerCase();
    else if (e.key) key = normalizeKeyToken(e.key);
    else return null;
  }
  return {
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key,
  };
}

/** 是否是可用的绑定（裸字母/数字/符号不允许，避免抢走正常输入）。 */
export function isUsableBinding(b: Binding): boolean {
  return b.ctrl || b.alt || NON_TEXT_KEYS.has(b.key);
}

// ---------------------------------------------------------------- 命令注册表

export const COMMANDS: CommandDef[] = [
  // ---- 文件 ----
  { id: "file.new", label: "新建标签", group: "文件", keys: ["Ctrl+N"] },
  { id: "file.open", label: "打开文件…", group: "文件", keys: ["Ctrl+O"] },
  { id: "file.save", label: "保存", group: "文件", keys: ["Ctrl+S"] },
  { id: "file.saveAs", label: "另存为…", group: "文件", keys: ["Ctrl+Shift+S"] },
  { id: "file.saveAll", label: "全部保存", group: "文件", keys: ["Ctrl+Alt+S"] },
  { id: "file.close", label: "关闭标签", group: "文件", keys: ["Ctrl+W"] },

  // ---- 标签 ----
  {
    id: "tab.next",
    label: "下一个标签",
    group: "标签",
    keys: ["Ctrl+Tab", "Ctrl+PageDown"],
  },
  {
    id: "tab.prev",
    label: "上一个标签",
    group: "标签",
    keys: ["Ctrl+Shift+Tab", "Ctrl+PageUp"],
  },

  // ---- 编辑 ----
  { id: "edit.find", label: "查找…", group: "编辑", keys: ["Ctrl+F"] },
  { id: "edit.replace", label: "替换…", group: "编辑", keys: ["Ctrl+H"] },
  { id: "edit.findNext", label: "查找下一个", group: "编辑", keys: ["F3"] },
  { id: "edit.findPrev", label: "查找上一个", group: "编辑", keys: ["Shift+F3"] },
  {
    id: "edit.goto",
    label: "转到行…",
    group: "编辑",
    keys: ["Ctrl+G"],
    note: "编辑器聚焦时若被编辑器自身占用则跳过",
  },
  { id: "edit.timeDate", label: "插入时间/日期", group: "编辑", keys: ["F5"], force: true },

  // ---- 视图 ----
  { id: "view.toggle", label: "切换 源码 / 预览", group: "视图", keys: ["Ctrl+/"] },
  { id: "view.outline", label: "显示/隐藏大纲 TOC", group: "视图", keys: ["Ctrl+Shift+O"] },
  { id: "view.foldCode", label: "折叠光标处代码块", group: "视图", keys: ["Ctrl+Shift+["] },
  { id: "view.unfoldCode", label: "展开光标处代码块", group: "视图", keys: ["Ctrl+Shift+]"] },
  { id: "view.foldAll", label: "折叠全部", group: "视图", keys: ["Ctrl+Alt+["] },
  { id: "view.unfoldAll", label: "展开全部", group: "视图", keys: ["Ctrl+Alt+]"] },
  { id: "view.zoomIn", label: "放大字号", group: "视图", keys: ["Ctrl+="] },
  { id: "view.zoomOut", label: "缩小字号", group: "视图", keys: ["Ctrl+-"] },
  { id: "view.zoomReset", label: "重置字号", group: "视图", keys: ["Ctrl+0"] },
  {
    id: "palette.open",
    label: "命令面板…",
    group: "视图",
    keys: ["Ctrl+Shift+P"],
    note: "按名字搜索并执行任意命令，右侧显示当前键位",
  },

  // ---- 面板 ----
  { id: "panel.splitH", label: "左右分屏", group: "面板", keys: ["Alt+Shift+ArrowRight"] },
  {
    id: "panel.splitV",
    label: "上下分屏",
    group: "面板",
    keys: ["Alt+Shift+ArrowDown"],
    // CodeMirror 的 defaultKeymap 把 Shift-Alt-ArrowDown 绑成「向下复制行」。
    // 本应用在 window 捕获阶段先拿走这个键位，编辑器那条因此被覆盖。
    note: "默认键位会覆盖编辑器的「向下复制行」（Shift+Alt+↓）",
  },
  {
    id: "panel.close",
    label: "移除分屏（标签并入相邻）",
    group: "面板",
    keys: ["Alt+Shift+ArrowLeft"],
  },
  {
    id: "panel.moveTabNext",
    label: "把标签移到下一个面板",
    group: "面板",
    keys: ["Ctrl+Alt+ArrowRight"],
    note: "按分屏树的顺序环状移动；只有一个面板时此命令不抢键",
  },
  {
    id: "panel.moveTabPrev",
    label: "把标签移到上一个面板",
    group: "面板",
    keys: ["Ctrl+Alt+ArrowLeft"],
  },
  {
    id: "panel.focusNext",
    label: "聚焦下一个面板",
    group: "面板",
    // F6 是 Windows「下一窗格」的通行键位，VS Code 也是 F6
    keys: ["F6"],
  },
  {
    id: "panel.focusPrev",
    label: "聚焦上一个面板",
    group: "面板",
    keys: ["Shift+F6"],
  },
  {
    id: "panel.toggleMaximize",
    label: "最大化 / 还原面板",
    group: "面板",
    // ↑ 补上分屏三键（→分屏 / ↓上下分屏 / ←移除）的第四向；
    // 与它们一样会覆盖编辑器的「向上复制行」（Shift+Alt+↑）。
    keys: ["Alt+Shift+ArrowUp"],
    note: "最大化时其余面板收起但保留；再按一次（或点面板上的还原按钮、双击标签）还原",
  },

  // ---- 编辑器内置（只读） ----
  { id: "editor.undo", label: "撤销", group: "编辑器内置", keys: ["Ctrl+Z"], editable: false },
  { id: "editor.redo", label: "重做", group: "编辑器内置", keys: ["Ctrl+Y"], editable: false },
  { id: "editor.cut", label: "剪切", group: "编辑器内置", keys: ["Ctrl+X"], editable: false },
  { id: "editor.copy", label: "复制", group: "编辑器内置", keys: ["Ctrl+C"], editable: false },
  { id: "editor.paste", label: "粘贴", group: "编辑器内置", keys: ["Ctrl+V"], editable: false },
  { id: "editor.delete", label: "删除选区", group: "编辑器内置", keys: ["Del"], editable: false },
  { id: "editor.selectAll", label: "全选", group: "编辑器内置", keys: ["Ctrl+A"], editable: false },
  {
    id: "editor.selectNext",
    label: "选中下一个相同项",
    group: "编辑器内置",
    keys: ["Ctrl+D"],
    editable: false,
  },
  {
    id: "editor.selectMatches",
    label: "选中全部相同项",
    group: "编辑器内置",
    keys: ["Ctrl+Shift+L"],
    editable: false,
  },
  {
    id: "editor.closeBrackets",
    label: "跳过自动闭合括号",
    group: "编辑器内置",
    keys: ["Backspace"],
    editable: false,
  },
  { id: "editor.indent", label: "缩进", group: "编辑器内置", keys: ["Tab"], editable: false },
  {
    id: "editor.toggleComment",
    label: "切换注释（Markdown 下是「源码 / 预览切换」）",
    group: "编辑器内置",
    keys: ["Ctrl+/"],
    editable: false,
    note: "CodeMirror 的 Mod-/；本应用只在 Markdown 里用 Ctrl+/，其它格式留给编辑器",
  },
  {
    id: "editor.copyLineUp",
    label: "向上复制行",
    group: "编辑器内置",
    keys: ["Shift+Alt+ArrowUp"],
    editable: false,
  },
  {
    id: "editor.moveLineUp",
    label: "上移当前行",
    group: "编辑器内置",
    keys: ["Alt+ArrowUp"],
    editable: false,
  },
  {
    id: "editor.moveLineDown",
    label: "下移当前行",
    group: "编辑器内置",
    keys: ["Alt+ArrowDown"],
    editable: false,
  },
  {
    id: "editor.syntaxLeft",
    label: "按语法单元左移",
    group: "编辑器内置",
    keys: ["Alt+ArrowLeft"],
    editable: false,
  },
  {
    id: "editor.syntaxRight",
    label: "按语法单元右移",
    group: "编辑器内置",
    keys: ["Alt+ArrowRight"],
    editable: false,
  },

  // ---- 菜单助记符（只读） ----
  {
    id: "menu.file",
    label: "打开「文件」菜单",
    group: "菜单助记符",
    keys: ["Alt+F"],
    editable: false,
  },
  {
    id: "menu.edit",
    label: "打开「编辑」菜单",
    group: "菜单助记符",
    keys: ["Alt+E"],
    editable: false,
  },
  {
    id: "menu.view",
    label: "打开「查看」菜单",
    group: "菜单助记符",
    keys: ["Alt+V"],
    editable: false,
  },
  {
    id: "menu.settings",
    label: "打开「设置」菜单",
    group: "菜单助记符",
    keys: ["Alt+S"],
    editable: false,
  },
  {
    id: "menu.help",
    label: "打开「帮助」菜单",
    group: "菜单助记符",
    keys: ["Alt+H"],
    editable: false,
  },

  // ---- 查找栏（只读） ----
  {
    id: "findbar.next",
    label: "查找栏：下一个",
    group: "查找栏",
    keys: ["Enter"],
    editable: false,
  },
  {
    id: "findbar.prev",
    label: "查找栏：上一个",
    group: "查找栏",
    keys: ["Shift+Enter"],
    editable: false,
  },
  {
    id: "findbar.close",
    label: "查找栏：关闭",
    group: "查找栏",
    keys: ["Escape"],
    editable: false,
  },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function commandById(id: string): CommandDef | undefined {
  return BY_ID.get(id);
}

/**
 * 键位预设：在「LitePad 默认」之上替换一组键位（M4）。
 *
 * 优先级：**用户覆盖 > 当前预设 > COMMANDS 里的默认值**。
 * 预设只记**差异项**（与默认值不同才有必要写），这样以后新增命令时
 * 不必回头同步维护每一套预设，缺项自然落回默认值。
 */
export interface KeymapPreset {
  id: string;
  label: string;
  /** 一句话说明这套预设的取向（对话框下拉旁显示） */
  note: string;
  overrides: KeymapOverrides;
}

export const KEYMAP_PRESETS: KeymapPreset[] = [
  {
    id: "default",
    label: "LitePad 默认",
    note: "常规 Windows 编辑器习惯",
    overrides: {},
  },
  {
    id: "notepadpp",
    label: "Notepad++",
    note: "另存为 / 全部保存对调，折叠用 Alt+0",
    overrides: {
      // Notepad++ 里「另存为」是 Ctrl+Alt+S、「全部保存」是 Ctrl+Shift+S，
      // 与 LitePad 默认正好相反——这是两套预设最容易被感知的差异。
      "file.saveAs": "Ctrl+Alt+S",
      "file.saveAll": "Ctrl+Shift+S",
      "view.foldAll": "Alt+0",
      "view.unfoldAll": "Alt+Shift+0",
    },
  },
  {
    id: "vscode",
    label: "VS Code",
    note: "预览 Ctrl+Shift+V、左右分屏 Ctrl+\\",
    overrides: {
      "view.toggle": "Ctrl+Shift+V",
      "panel.splitH": "Ctrl+\\",
    },
  },
];

export const DEFAULT_PRESET_ID = KEYMAP_PRESETS[0].id;

export function presetById(id: string): KeymapPreset | undefined {
  return KEYMAP_PRESETS.find((p) => p.id === id);
}

/** 归一化预设 id：未知值一律回落默认，避免旧配置里的脏数据把键位表清空。 */
export function normalizePresetId(id: string | undefined | null): string {
  return presetById(id ?? "") ? (id as string) : DEFAULT_PRESET_ID;
}

/**
 * 当前预设（模块级状态）。
 *
 * 刻意不做成 `effectiveKeys` 的入参：预设是全局基线，调用点有菜单、命令面板、
 * 快捷键对话框、事件分发器四处，逐个传参容易漏；漏了就表现为「改了预设没生效」。
 */
let currentPreset: KeymapPreset = KEYMAP_PRESETS[0];

export function getKeymapPreset(): KeymapPreset {
  return currentPreset;
}

/** 切换预设。返回是否真的变了（调用方据此决定是否提示/持久化）。 */
export function setKeymapPreset(id: string): boolean {
  const next = presetById(id);
  if (!next || next.id === currentPreset.id) return false;
  currentPreset = next;
  // 预设换了，绑定索引必须重建，否则 resolveCommand 还按旧键位分发
  resetBindingIndex();
  return true;
}

/** 某命令当前生效的键位（有覆盖则只返回覆盖的那条；显式解绑返回空数组）。 */
export function effectiveKeys(id: string, overrides: KeymapOverrides): string[] {
  const custom = overrides[id];
  if (custom !== undefined) return custom ? [custom] : [];
  const fromPreset = currentPreset.overrides[id];
  if (fromPreset !== undefined) return fromPreset ? [fromPreset] : [];
  return BY_ID.get(id)?.keys ?? [];
}

/** 某命令当前生效键位的展示串，如 "Ctrl+Shift+S"；无键位返回 ""。 */
export function keyHint(id: string, overrides: KeymapOverrides): string {
  const keys = effectiveKeys(id, overrides);
  if (keys.length === 0) return "";
  return keys
    .map((k) => formatBinding(parseKey(k) ?? { ctrl: false, alt: false, shift: false, key: k }))
    .join(" / ");
}

/**
 * 检查把 `id` 改成 `spec` 是否与其他命令冲突。
 * 返回占用该键位的命令（优先返回可编辑项），无冲突返回 null。
 */
export function findConflict(
  id: string,
  spec: string,
  overrides: KeymapOverrides,
): CommandDef | null {
  const target = parseKey(spec);
  if (!target) return null;
  let readonly: CommandDef | null = null;
  for (const cmd of COMMANDS) {
    if (cmd.id === id) continue;
    for (const k of effectiveKeys(cmd.id, overrides)) {
      const b = parseKey(k);
      if (b && sameBinding(b, target)) {
        if (cmd.editable === false) {
          readonly = readonly ?? cmd;
        } else {
          return cmd;
        }
      }
    }
  }
  return readonly;
}

/** 绑定 → 命令 id 的扁平索引（按 overrides 对象身份缓存，改键时整表重建）。 */
let indexForOverrides: KeymapOverrides | null = null;
let index: Map<string, string> | null = null;

/** 让绑定索引失效：切预设、改键位后必须调用，否则命中表是旧的。 */
function resetBindingIndex(): void {
  indexForOverrides = null;
  index = null;
}

/** `effectiveKeys` 的「无用户覆盖」视角：只取预设 + 默认，用作铺底基线。 */
const NO_OVERRIDES: KeymapOverrides = {};

function bindingKey(b: Binding): string {
  return `${b.ctrl ? 1 : 0}${b.alt ? 1 : 0}${b.shift ? 1 : 0}:${b.key}`;
}

function indexOf(overrides: KeymapOverrides): Map<string, string> {
  if (indexForOverrides === overrides && index) return index;
  const map = new Map<string, string>();

  // ① 铺底：所有可编辑命令的「预设 + 默认」键位。
  for (const cmd of COMMANDS) {
    if (cmd.editable === false) continue;
    for (const k of effectiveKeys(cmd.id, NO_OVERRIDES)) {
      const b = parseKey(k);
      if (b) map.set(bindingKey(b), cmd.id);
    }
  }

  // ② 撤掉被覆盖命令的铺底键位（含显式解绑：spec 为空 = 注销该键）。
  //    先统一删、再统一写，避免「A 解绑 Ctrl+S / B 改到 Ctrl+S」互相踩。
  for (const id of Object.keys(overrides)) {
    const cmd = BY_ID.get(id);
    if (!cmd || cmd.editable === false) continue;
    for (const k of effectiveKeys(id, NO_OVERRIDES)) {
      const b = parseKey(k);
      if (b) map.delete(bindingKey(b));
    }
  }

  // ③ 写入用户覆盖。
  //
  // 覆盖是用户的显式意图，必须压过任何默认/预设键位。若只按声明顺序写一张表，
  // 后声明的命令会用它的「默认键位」静默抢走先声明命令的「用户覆盖键位」
  // （如 palette.open 默认 Ctrl+Shift+P 抢走用户给 file.save 设的同键位）。
  for (const [id, spec] of Object.entries(overrides)) {
    const cmd = BY_ID.get(id);
    if (!cmd || cmd.editable === false || !spec) continue;
    const b = parseKey(spec);
    if (b) map.set(bindingKey(b), id);
  }

  indexForOverrides = overrides;
  index = map;
  return map;
}

/**
 * 事件 → 命令 id。只命中可编辑命令（内置项由各自的处理器负责）。
 * 调用方需自行处理 `defaultPrevented`（`force` 命令除外）。
 */
export function resolveCommand(e: KeyboardEvent, overrides: KeymapOverrides): string | null {
  if (e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) return null;
  const pressed = bindingFromEvent(e);
  if (!pressed || !isUsableBinding(pressed)) return null;
  return indexOf(overrides).get(bindingKey(pressed)) ?? null;
}

/** 按分组聚合（保持 COMMANDS 的声明顺序）。 */
export function groupedCommands(): { group: string; commands: CommandDef[] }[] {
  const out: { group: string; commands: CommandDef[] }[] = [];
  for (const cmd of COMMANDS) {
    const last = out[out.length - 1];
    if (last && last.group === cmd.group) last.commands.push(cmd);
    else out.push({ group: cmd.group, commands: [cmd] });
  }
  return out;
}

/**
 * 键位集合是否存在重复（默认表自检，也供测试断言）。
 *
 * 只看**可编辑**命令：只读项是 CodeMirror / 系统内置，与应用自身的键位有意重叠
 * （如 Ctrl+/ 在 Markdown 下是「源码/预览切换」，其它格式才是编辑器「切换注释」；
 * Alt+Shift+↓ 是「上下分屏」而非编辑器「向下复制行」），这种重叠是设计，不算冲突。
 */
export function duplicateKeys(overrides: KeymapOverrides): string[] {
  const seen = new Map<string, string[]>();
  for (const cmd of COMMANDS) {
    if (cmd.editable === false) continue;
    for (const k of effectiveKeys(cmd.id, overrides)) {
      const norm = normalizeSpec(k);
      const list = seen.get(norm) ?? [];
      list.push(cmd.id);
      seen.set(norm, list);
    }
  }
  return [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([k]) => k);
}
