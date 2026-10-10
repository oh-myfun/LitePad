// 设置 / 编码 / 外观档位（从 main.ts 拆出，解耦第十六步 / #416-2）。
//
// 职责：编码与换行转换（convertDoc / switchEncoding / showEncodingMenu / showEolMenu /
// encodingMenuModel）、状态栏菜单入口、主题档与窗口身份落 DOM（publishThemeMode /
// publishWindowKind）、字号字体行距预览宽度等档位 setter（set*）、设置对话框与偏好
// 持久化（openSettingsDialog / persistSettings / loadPreferenceOptions / keymap）、
// 当前字号读取（currentFontSize）。
// 与 `appearance.ts` 的分工：那里是 `apply*`（把档位落到 DOM），这里是 `set*`
// （改设置 → 持久化 → 调 apply*）。
// 零外部函数依赖（无 DI）——依赖 core/* + ui + doc-model + appearance + ipc/api + shell/* + editor/*。

import {
  encodingOptions,
  eolOptions,
  isDark,
  isWrap,
  keymapOverrides,
  settings,
  themeMode,
  windowKind,
  setEncodingOptions,
  setEolOptions,
  setIsDark,
  setIsWrap,
  setKeymapOverrides,
  setSuppressDirty,
  setThemeModeState,
} from "./core/app-state";
import { activeTab, docOf } from "./core/panels";
import { applyTheme, type ThemeMode } from "./theme/theme";
import { isDirtyVsBaseline, markClean, markDiskVersion } from "./doc-model";
import {
  applyCodeFontFamily,
  applyDarkToTabs,
  applyEditorLineHeight,
  applyFontFamily,
  applyFontSize,
  applyPreviewLineHeight,
  applyPreviewWidth,
  applyTabActionReserve,
  applyTabStyle,
  applyWrapToTabs,
  normalizePreviewWidth,
} from "./appearance";
import { rebuildDocInstances } from "./io/files";
import { cancelPendingBackup, discardAllBackups, discardBackupFor } from "./session/session";
import { saveDocCore } from "./io/files";
import {
  listEncodings,
  listEols,
  listFonts,
  reloadFile,
  saveSettings,
  type FontItem,
} from "./ipc/api";
import { bomTarget, withLanguageGroups } from "./encoding";
import type { EncodingMenuModel } from "./shell/menubar";
import {
  commandById,
  effectiveKeys,
  formatBinding,
  getKeymapPreset,
  normalizePresetId,
  parseKey,
  type KeymapOverrides,
} from "./shell/keymap";
import { showPopupMenu, type MenuItem } from "./shell/menu";
import { PREVIEW_WIDTH_LABELS, showSettingsDialog } from "./shell/settingsdialog";
import { refreshAll, sbEncoding, sbEol, showMessage } from "./ui";
import { logger } from "./core/logger";
import { ask } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------- 编码转换（B215）

/**
 * 「转换为…」「添加/移除 BOM」「行尾符转换」三类的共同出口：把目标编码/行尾写进
 * doc，然后走**一次原位保存**。
 *
 * 为什么复用保存、而不是另开一组转换命令：
 *   · 原子写、只读兜底、脏写检查（外部改过就不盖）、保存回声抑制，这些都已经在
 *     `save_file` 里兜住了；转换再自起一套就是把它们抄一遍，抄一次漏一次；
 *   · 不可逆保护同样是保存路径自带的 —— legacy 编码里无法映射的字符，
 *     `saveDocCore` 会自己去 `checkEncodable` 拦下并弹确认。
 *     ⚠️ 所以**必须先写 `doc.encoding` 再调它**：顺序反了等于绕过不可逆保护。
 *
 * @param next 只写要变的那一侧（都不传 = 空操作，调用方不该这么调）。
 * @returns 是否真的启动了保存（false = 被前置条件/用户拒绝挡回，字段没动）。
 */
async function convertDoc(next: { encoding?: string; eol?: string }): Promise<boolean> {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc || !tab) return false;

  const enc = next.encoding ?? doc.encoding;
  const eol = next.eol ?? doc.eol;
  if (enc === doc.encoding && eol === doc.eol) return false;

  // 转换 = 写盘，未命名文档没有落点可写
  if (!doc.path) {
    showMessage("该文件还没有关联磁盘路径，请先「另存为」保存一次再转换", true);
    return false;
  }
  // 转换会盖掉没保存的修改：先问一句，别替用户做这个决定
  if (isDirtyVsBaseline(doc, null)) {
    const ok = await ask(
      `有未保存的修改，转换为 ${enc} / ${eol} 会立即写盘并覆盖这些修改。继续吗？`,
      { title: "转换将写入磁盘", kind: "warning" },
    );
    if (!ok) return false;
  }

  const prevEnc = doc.encoding;
  const prevEol = doc.eol;
  doc.encoding = enc;
  doc.eol = eol;
  const ok = await saveDocCore(doc, tab, false);
  if (!ok) {
    // 保存被拒 / 冲突未覆盖 / lossy 取消：字段必须退回，否则状态栏会显示一个
    // 跟磁盘对不上的编码，下一次保存才悄悄写错字节。
    doc.encoding = prevEnc;
    doc.eol = prevEol;
    refreshAll();
    return false;
  }
  showMessage(`已转换为 ${doc.encoding} / ${doc.eol}`);
  logger.info("convert", `${doc.name} ${doc.encoding}/${doc.eol}`);
  return true;
}

/**
 * 主菜单「编码」与状态栏那颗键**共用**的一份菜单模型（B215）。
 *
 * ⚠️ 两边都从这里取，不接受第二份手抄的列表 —— 两份迟早差一项，而差的那一项
 *    表现就是「菜单里有、功能没接上」。
 */
function encodingMenuModel(): EncodingMenuModel {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  const current = doc?.encoding ?? "";
  const currentEol = doc?.eol ?? "";
  // 没有活动文档时只有「解读编码」那一组还能操作，其余全置灰
  const canWrite = !!doc && !!doc.path;

  // 分组名按条目顺序对齐（后端那份列表里 group 排在 label 旁边，同序）
  const groups = encodingOptions.map((it) => it.group);
  const encodedIn = withLanguageGroups(
    encodingOptions.map((it) => ({
      label: it.label,
      checked: it.label === current,
      onSelect: () => void switchEncoding(it.label),
    })),
    groups,
  );
  const convertTo = withLanguageGroups(
    encodingOptions.map((it) => ({
      label: it.label,
      disabled: !canWrite,
      onSelect: () => void convertDoc({ encoding: it.label }),
    })),
    groups,
  );
  const addTarget = bomTarget(current, true);
  const removeTarget = bomTarget(current, false);
  const bom: MenuItem[] = [
    {
      label: "添加 BOM",
      disabled: !canWrite || addTarget === null,
      onSelect: () => void convertDoc({ encoding: addTarget ?? current }),
    },
    {
      label: "移除 BOM",
      disabled: !canWrite || removeTarget === null,
      onSelect: () => void convertDoc({ encoding: removeTarget ?? current }),
    },
  ];
  const eol = eolOptions.map((value) => ({
    label: value,
    checked: value === currentEol,
    disabled: !canWrite,
    onSelect: () => void convertDoc({ eol: value }),
  }));
  return { encodedIn, convertTo, bom, eol };
}

// ---------------------------------------------------------------- 状态栏菜单

/**
 * 状态栏那颗「编码」键的菜单（B219）：只把**常用那几条**平铺在顶层，后面接 BOM 两项
 * 与「转换行尾符▸」。状态栏是「顺手看一眼当前编码 + 切到最常用的那几种」的地方，
 * 摊 40 条全量两级进去反而没人点得到。主菜单「编码」那条**不动**：那里才是全量。
 *
 * ⚠️ 常用集只认后端下发的 `common` 字段（在 `encodingOptions` 上过滤），**不许**在
 *    前端另写一份标签白名单 —— 又一张表，迟早差一条，差的表现就是「菜单里没有它」。
 * ⚠️ 这里也不再复用 `encodingMenuModel().encodedIn / convertTo`：那两路是给主菜单的
 *    摆法（首组内联 + 其余组子菜单），跟这里要的「常用平铺」不是一回事；BOM 与行尾
 *    符仍然同取 `encodingMenuModel()` 那一份，别在两边各写一遍。
 */
function showEncodingMenu(): void {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc) return;

  const current = doc.encoding ?? "";
  const common = encodingOptions
    .filter((it) => it.common)
    .map((it) => ({
      label: it.label,
      checked: it.label === current,
      onSelect: () => void switchEncoding(it.label),
    }));
  const model = encodingMenuModel();
  showPopupMenu(sbEncoding, [
    ...common,
    { separator: true },
    ...model.bom,
    { separator: true },
    { label: "转换行尾符", submenu: model.eol },
  ]);
}

async function switchEncoding(label: string): Promise<void> {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc || label === doc.encoding) return;

  if (!doc.path) {
    doc.encoding = label;
    doc.dirty = true;
    refreshAll();
    showMessage(`新建文件的保存编码已设为 ${label}`);
    return;
  }

  if (doc.dirty) {
    const ok = await ask("文件有未保存的修改，重新载入会丢失这些修改。继续吗？", {
      title: "以指定编码重新载入",
      kind: "warning",
    });
    if (!ok) return;
  }

  try {
    const file = await reloadFile(doc.tabId, label);
    setSuppressDirty(true);
    doc.encoding = file.encoding;
    doc.eol = file.eol;
    doc.mixedEol = file.mixedEol;
    doc.readonly = file.readonly;
    doc.name = file.name;
    // 重新载入 = 内容以磁盘为准：正文、编码、行尾一起钉成新基线
    markClean(doc, file.text);
    markDiskVersion(doc, file.mtimeMs, file.size);
    // 重新载入 = 内容以磁盘为准，此前的未保存副本必须作废
    discardBackupFor(doc);
    // 重载替换内容：重建该文档全部实例并刷新挂载中的视图
    rebuildDocInstances(doc, file.text);
    setSuppressDirty(false);
    refreshAll();
    showMessage(`已用 ${label} 重新载入 ${file.name}`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

function showEolMenu(): void {
  void (async () => {
    let eols: string[];
    try {
      eols = await listEols();
    } catch {
      eols = ["CRLF", "LF", "CR"];
    }
    const tab = activeTab();
    const doc = tab ? docOf(tab) : undefined;
    if (!doc) return;
    showPopupMenu(
      sbEol,
      eols.map((value) => ({
        label: value,
        checked: value === doc.eol,
        onSelect: () => {
          doc.eol = value;
          doc.mixedEol = false;
          doc.dirty = true;
          refreshAll();
          showMessage(`行尾已切换为 ${value}，保存时生效`);
        },
      })),
    );
  })();
}

/**
 * 把当前主题档位写到 `<html data-theme-mode>`（light / dark / system）。
 *
 * B97 之前这里刷的是顶栏那颗主题按钮的图标（三态循环：sun / moon / color-mode）。
 * 顶栏快捷按钮整排移除后，主题只从「设置」页「外观」分类的下拉进出，
 * 循环按钮与那三颗图标一并退役。留下这个 data 属性是因为档位仍是**跨模块状态**：
 * 换档要联动 CodeMirror 的明暗，样式与回归测试也都靠它读当前档位。
 */
function publishThemeMode(): void {
  document.documentElement.dataset.themeMode = themeMode;
}

/**
 * 把本窗口的身份写到 `<html data-window-kind>`（main / satellite）。
 *
 * 卫星窗口要**比主窗口简洁**：菜单条这类只属于主窗口的部件，由这条属性在 CSS 里收掉。
 *
 * ⚠️ 必须在 `setupShell()` 之前落 —— 卫星窗口冷启动要先问 Rust 拿身份，这段时间里外壳
 *    已经画出来了，晚一步就会看到「菜单条闪一下再消失」。
 * 其余按窗口身份分流的行为（会话读写、关窗收尾、事件监听）读的是 `windowKind` 变量
 * 本身，不靠这个属性 —— 属性只管"长什么样"，语义判断仍然走代码里的那个值。
 */
function publishWindowKind(): void {
  document.documentElement.dataset.windowKind = windowKind;
}

// ---------------------------------------------------------------- 主题 / 换行 / 字号

/** 字号持久化防抖：Ctrl+滚轮/连续按 Ctrl+= 会触发很多次，攒一起写盘。 */
let fontSizeSaveTimer: number | null = null;
function scheduleFontSizeSave(): void {
  if (fontSizeSaveTimer !== null) clearTimeout(fontSizeSaveTimer);
  fontSizeSaveTimer = setTimeout(() => {
    fontSizeSaveTimer = null;
    void persistSettings();
  }, 400);
}

/** 预览行距：写 :root 上的 --md-line-height，.md-preview 通过 var() 生效。 */

/** 未知档位一律落「全宽」（B235 的默认口径，也是最不容易显得窄的那档）。 */

/** 预览正文宽度：写 :root 上的 --md-content-max，`.md-preview .md-block` 通过 var() 生效。 */

/** 编辑器行距：写 :root 上的 --editor-line-height，.cm-content 通过 var() 生效。 */

/**
 * B227：本机字体清单缓存（Rust `list_fonts`）。
 *
 * 枚举要走 GDI、返回上百条，**只在打开设置页时取一次**并留着：设置页里来回切
 * 等宽/全部两栏是纯前端过滤，不该反复过 IPC。取不到就留空数组，设置页会退回
 * B225 那份手抄清单（见 `fontOptionsFor`），不会把那一栏变空。
 */
let systemFontsCache: FontItem[] = [];

async function ensureSystemFonts(): Promise<void> {
  if (systemFontsCache.length) return;
  try {
    systemFontsCache = await listFonts();
  } catch (err) {
    logger.warn("settings", `枚举本机字体失败，设置页退回内置清单 ${String(err)}`);
  }
}

// ---------------------------------------------------------------- 偏好（文件 → 设置）

/**
 * 过滤从磁盘读回的快捷键覆盖表：
 * 丢掉未知命令、无法解析的键位，以及抄了默认值的冗余项。
 * 让配置文件被手改坏时也只影响个别命令，而不是整张键位表。
 */
function sanitizeKeymap(raw: Record<string, string>): KeymapOverrides {
  const out: KeymapOverrides = {};
  for (const [id, spec] of Object.entries(raw)) {
    const cmd = commandById(id);
    if (!cmd || cmd.editable === false) continue;
    if (spec === "") {
      out[id] = "";
      continue;
    }
    if (!parseKey(spec)) continue;
    out[id] = formatBinding(parseKey(spec)!);
  }
  return out;
}

/** 预取行尾/编码候选，供「设置」页同步渲染（IPC 失败则用内置兜底）。 */
async function loadPreferenceOptions(): Promise<void> {
  try {
    const list = await listEols();
    if (list.length > 0) setEolOptions(list);
  } catch {
    // 保持内置三档
  }
  try {
    const list = await listEncodings();
    if (list.length > 0) setEncodingOptions(list);
  } catch {
    // 保持空列表：宁可这一刻菜单里一条不列，也不塞一份自造的兜底清单
  }
}

/** 菜单右侧显示的当前生效键位（可用 `\t` 拼进菜单项）。 */
function keyHint(id: string): string {
  const keys = effectiveKeys(id, keymapOverrides);
  if (keys.length === 0) return "";
  return keys
    .map((k) => formatBinding(parseKey(k) ?? { ctrl: false, alt: false, shift: false, key: k }))
    .join(" / ");
}

/** 标签样式（设置页「外观 → 标签样式」的下拉）：立即生效。 */

/** 标签样式切换（设置页）：立即生效 + 持久化。 */
async function setTabStyle(style: string): Promise<void> {
  applyTabStyle(style);
  if (settings) {
    settings.tab_style = style === "pill" ? "pill" : "connected";
    await persistSettings();
  }
  showMessage(style === "pill" ? "标签样式：药丸" : "标签样式：相连");
}

/** 标签操作槽位空位（设置页「外观」开关）：立即生效。 */

/** 标签操作槽位空位切换（设置页）：立即生效 + 持久化。 */
async function setTabActionReserve(on: boolean): Promise<void> {
  applyTabActionReserve(on);
  if (settings) {
    settings.tab_action_reserve_space = on;
    await persistSettings();
  }
  showMessage(on ? "标签按钮：预留空位" : "标签按钮：紧凑");
}

/** 主题档位（设置页「外观」分类的下拉）：立即生效 + 持久化。 */
async function setThemeMode(mode: ThemeMode): Promise<void> {
  setThemeModeState(mode);
  // ⚠️ **必须写回 settings，否则根本存不下来**（B79 用户实测：每次打开都是深色）。
  // 根因：persistSettings() 存的是整个 settings 对象，而启动时读的是 `settings.theme`
  // （main 里 `themeMode = normalizeMode(settings?.theme)`）。其它每一项设置都会在这里写回
  // 自己的字段，唯独主题漏了 —— 于是落盘永远是启动时那个 "system"，深色系统上解析成深色，
  // 表现为「主题设了、重启就丢」。写回之后紧跟的 persistSettings() 才真正把它存下去。
  if (settings) settings.theme = mode;
  const dark = applyTheme(mode);
  if (dark !== isDark) applyDarkToTabs(dark);
  setIsDark(dark);
  publishThemeMode();
  await persistSettings();
  showMessage(mode === "system" ? "主题：跟随系统" : mode === "dark" ? "主题：深色" : "主题：浅色");
}

/** 新建文件的默认行尾（设置页「新建文件」分类）。 */
async function setDefaultEol(value: string): Promise<void> {
  if (!settings) return;
  settings.default_eol = value;
  await persistSettings();
  showMessage(`新建文件默认行尾：${value}`);
}

/** 新建文件的默认编码（设置页「新建文件」分类）。 */
async function setDefaultEncoding(value: string): Promise<void> {
  if (!settings) return;
  settings.default_encoding = value;
  await persistSettings();
  showMessage(`新建文件默认编码：${value}`);
}

/** 快捷键覆盖表变更（快捷键对话框 → 立即持久化）。 */
async function applyKeymapOverrides(next: KeymapOverrides): Promise<void> {
  setKeymapOverrides(next);
  if (settings) {
    settings.keymap = { ...next };
    await persistSettings();
  }
}

/**
 * 切换键位预设（快捷键对话框下拉 → 立即生效 + 持久化）。
 *
 * 预设是「基线」，切换时前端已把旧的自定义覆盖清空（见 keymapdialog），
 * 这里跟着落盘，避免重启后覆盖表残留成旧预设的差异项。
 */
async function applyKeymapPreset(id: string): Promise<void> {
  if (!settings) return;
  settings.keymap_preset = normalizePresetId(id);
  await persistSettings();
  showMessage(`键位预设：${getKeymapPreset().label}`);
}

// 快捷键不再单独弹窗：它作为「设置」页里的一个分类（见 src/shell/settingsdialog.ts）。

/**
 * 自动保存开关（绝对值；由设置页「通用」分类的开关切换）。
 *
 * 写的是**原文件**——这正是它与热退出的分野，提示语必须说清，
 * 否则用户以为开了自动保存就不会有未保存状态（B68 把默认值改成了关）。
 */
async function setAutosave(on: boolean): Promise<void> {
  if (!settings || settings.autosave === on) return;
  settings.autosave = on;
  await persistSettings();
  showMessage(on ? "已启用自动保存（修改会直接写入原文件）" : "已停用自动保存");
}

/**
 * 热退出开关（绝对值）。
 *
 * 关掉时要一并丢弃现存副本：留着的话，下次启动仍会拿旧快照还原出「未保存标签」，
 * 那就成了「关了还生效」。同时清空排程，避免关闭瞬间又写出几份新的。
 */
async function setHotExit(on: boolean): Promise<void> {
  if (!settings || settings.hot_exit === on) return;
  settings.hot_exit = on;
  cancelPendingBackup();
  if (!on) discardAllBackups();
  await persistSettings();
  showMessage(on ? "已启用热退出（关窗不再询问，未保存内容下次启动还原）" : "已停用热退出");
}

/** Markdown 预览行距（查看菜单三档）。 */
async function setPreviewLineHeight(value: number): Promise<void> {
  applyPreviewLineHeight(value);
  if (settings) {
    settings.preview_line_height = value;
    await persistSettings();
  }
  showMessage(`预览行距 ${value}`);
}

/** B235：预览正文内容区宽度档（设置页三选）。管的是**正文居中宽度**，不是分屏比例。 */
async function setPreviewWidth(kind: string): Promise<void> {
  const k = normalizePreviewWidth(kind);
  applyPreviewWidth(k);
  if (settings) {
    settings.preview_width = k;
    await persistSettings();
  }
  showMessage(`预览宽度 ${PREVIEW_WIDTH_LABELS[k]}`);
}

// ⚠️ B235：原先这里有个 `setTocWidthValue()`（大纲宽度的「程序化设置」入口，
//    设置页那个三选下拉专用）—— 设置项删除后**没有调用方了，已一并删掉**
//    （`tsc` 的 `noUnusedLocals` 会拦死代码，说明项目不留无主函数）。
//    调大纲宽度现在只有一条路：左侧栏的拖拽分隔条，其 `onChange` 里已经做完
//    「夹取 → 同步 sideWidth → 回写 `settings.toc_width`」这三步
//    （见上面 `setupSideResizer`）。真要加命令入口，从那里复用。

/** B231：正文字体族（设置页；只作用于预览模式正文，空串 = 内置思源黑体）。 */
async function setFontFamily(family: string): Promise<void> {
  applyFontFamily(family);
  if (settings) {
    settings.font_family = family.trim();
    await persistSettings();
  }
  showMessage(family.trim() ? `正文字体 ${family.trim()}` : "正文字体：默认");
}

/**
 * B231：代码字体（设置页「代码字体」那一栏；空串 = 内嵌 Cascadia Mono）。
 * 作用于**编辑器源码区 + 预览里的行内代码/代码块**。
 */
async function setCodeFontFamily(family: string): Promise<void> {
  applyCodeFontFamily(family);
  if (settings) {
    settings.code_font_family = family.trim();
    await persistSettings();
  }
  showMessage(family.trim() ? `代码字体 ${family.trim()}` : "代码字体：默认");
}

/** 编辑器行距（设置页，1.0–2.5 倍）。 */
async function setEditorLineHeight(value: number): Promise<void> {
  applyEditorLineHeight(value);
  if (settings) {
    settings.editor_line_height = applyClamp(value);
    await persistSettings();
  }
  showMessage(`编辑器行距 ${applyClamp(value)}`);
}

/** 行距落盘值与生效值共用同一夹取范围（1.0–2.5）。 */
function applyClamp(value: number): number {
  return Math.min(2.5, Math.max(1, Number(value) || 1.5));
}

/** 字号绝对值设置（设置页；快捷键缩放走 changeFontSize 增量链路）。 */
async function setFontSizeValue(px: number): Promise<void> {
  const next = Math.min(28, Math.max(10, Math.round(px)));
  if (next === currentFontSize()) return;
  applyFontSize(next);
  if (settings) {
    settings.font_size = next;
    await persistSettings();
  }
  showMessage(`字号 ${next}px`);
}

/** 自动换行开关（绝对值；由「查看」菜单的勾选项切换）。 */
async function setWordWrap(on: boolean): Promise<void> {
  if (isWrap === on) return;
  setIsWrap(on);
  applyWrapToTabs(on);
  if (settings) {
    settings.word_wrap = on;
    await persistSettings();
  }
}

/** 打开统一设置页（文件 → 设置…）。 */
async function openSettingsDialog(): Promise<void> {
  // B227：字体两栏的候选来自本机枚举 —— 先取回再开页，免得用户看到空列表。
  //
  // B239：这里原先是「发起枚举但不等它」（`void`）就开页，而设置页是**同步**建好
  // 每一个分类页的（见 settingsdialog 的 buildPage），字体行在那一刻读 `systemFonts()`
  // 读到的还是空数组 ⇒ `fontOptionsFor` 退回 B225 那份**手抄 17 条全等宽**清单，
  // 而缓存回来后没有任何重建机制 ⇒ 整轮会话字体列表都是错的（要关掉设置页再开一次
  // 才对）。**枚举类数据必须在开页前 await 到位**，这一类假绿不会再有第二次。
  // 实测本机枚举 114 条耗时 10ms，等一下完全无感。
  await ensureSystemFonts();
  showSettingsDialog({
    theme: () => themeMode,
    onTheme: (mode) => void setThemeMode(mode),
    fontFamily: () => settings?.font_family ?? "",
    onFontFamily: (family) => void setFontFamily(family),
    // B227：代码字体（预览 code/pre），与正文那条分开设
    codeFontFamily: () => settings?.code_font_family ?? "",
    onCodeFontFamily: (family) => void setCodeFontFamily(family),
    // 本机字体枚举结果（懒取一次，见 ensureSystemFonts）
    systemFonts: () => systemFontsCache,
    fontSize: () => currentFontSize(),
    onFontSize: (px) => void setFontSizeValue(px),
    editorLineHeight: () => settings?.editor_line_height ?? 1.5,
    onEditorLineHeight: (v) => void setEditorLineHeight(v),
    previewLineHeight: () => settings?.preview_line_height ?? 1.7,
    onPreviewLineHeight: (v) => void setPreviewLineHeight(v),
    // B235：预览正文宽度档（顶掉了原先的「大纲宽度」设置项）
    previewWidth: () => normalizePreviewWidth(settings?.preview_width),
    onPreviewWidth: (v) => void setPreviewWidth(v),
    defaultEol: () => settings?.default_eol ?? "CRLF",
    eolOptions: () => eolOptions,
    onDefaultEol: (v) => void setDefaultEol(v),
    defaultEncoding: () => settings?.default_encoding ?? "UTF-8",
    // 设置页那颗下拉只要 label（它是扁平一屏，不需要语言分组）
    encodingOptions: () => encodingOptions.map((e) => e.label),
    onDefaultEncoding: (v) => void setDefaultEncoding(v),
    // 「通用」分类：自动保存 / 热退出（原「文件」菜单的勾选项，B108 搬进设置页）
    autosave: () => settings?.autosave ?? false,
    onAutosave: (v) => void setAutosave(v),
    hotExit: () => settings?.hot_exit ?? true,
    onHotExit: (v) => void setHotExit(v),
    tabStyle: () => settings?.tab_style ?? "connected",
    onTabStyle: (v) => void setTabStyle(v),
    tabActionReserveSpace: () => settings?.tab_action_reserve_space ?? true,
    onTabActionReserveSpace: (v) => void setTabActionReserve(v),
    keymap: {
      overrides: keymapOverrides,
      onChange: (next) => void applyKeymapOverrides(next),
      preset: getKeymapPreset().id,
      onPresetChange: (id) => void applyKeymapPreset(id),
    },
  });
}

async function persistSettings(): Promise<void> {
  if (!settings) return;
  try {
    await saveSettings(settings);
  } catch {
    // 配置写失败不应影响使用
  }
}

function currentFontSize(): number {
  return settings?.font_size ?? 14;
}

export {
  convertDoc,
  encodingMenuModel,
  showEncodingMenu,
  showEolMenu,
  switchEncoding,
  publishThemeMode,
  publishWindowKind,
  applyClamp,
  currentFontSize,
  scheduleFontSizeSave,
  setThemeMode,
  setDefaultEol,
  setDefaultEncoding,
  setPreviewLineHeight,
  setPreviewWidth,
  setFontFamily,
  setCodeFontFamily,
  setEditorLineHeight,
  setFontSizeValue,
  setWordWrap,
  setTabStyle,
  setTabActionReserve,
  setAutosave,
  setHotExit,
  applyKeymapOverrides,
  applyKeymapPreset,
  sanitizeKeymap,
  keyHint,
  loadPreferenceOptions,
  openSettingsDialog,
  persistSettings,
  ensureSystemFonts,
};
