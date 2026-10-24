// 文档 / 标签 / 实例的纯模型操作 + 工厂。
//
// 这一段只依赖 core/*（状态）、editor/*（CM6 状态构造）、core/layout（遍历），
// 不依赖 main.ts —— makeInstance 需要的编辑器更新回调通过 setInstanceOnUpdate 注入，
// 这样本模块对 main 零反向依赖（解耦纪律：功能模块 → core/*，不许 import main.ts）。

import {
  type Doc,
  type Tab,
  type Panel,
  docs,
  settings,
  tabs,
  takeInstId,
  isDark,
  isWrap,
  layout,
} from "./core/app-state";
import { detectLanguage, languageInfoByLabel, type LanguageInfo } from "./editor/language";
import { perfProfileFor, type SizeClass } from "./editor/perf";
import { makeTabState } from "./editor/editor";
import { eachLeaf } from "./core/layout";
import { activeTab } from "./core/panels";
import type { EditorView, ViewUpdate } from "@codemirror/view";

/** makeInstance 创建 CM6 状态时用的更新回调（由 main 在启动时注入）。 */
let instanceOnUpdate: (view: EditorView, update: ViewUpdate) => void = () => {};

/** 注册编辑器实例的更新回调（main 的 handleUpdate）。解耦 makeInstance 对 main 的依赖。 */
export function setInstanceOnUpdate(fn: (view: EditorView, update: ViewUpdate) => void): void {
  instanceOnUpdate = fn;
}

/** 读回当前注入的编辑器更新回调（io 的 rebuildDocInstances 重建状态时要用）。 */
export function getInstanceOnUpdate(): (view: EditorView, update: ViewUpdate) => void {
  return instanceOnUpdate;
}

/**
 * B372：新建空白文档的默认语言（设置页「新建文件 → 默认文档类型」）。
 * 未知标签按未设置处理 —— 旧配置/注册表删过标签时不能把文档卡在死值上。
 */
function blankDocLanguage(label: string | null | undefined): LanguageInfo | null {
  return label ? languageInfoByLabel(label) : null;
}

function makeDoc(
  tabId: number,
  text: string,
  name: string,
  path: string | null,
  encoding: string,
  eol: string,
  readonly: boolean,
  /** M4 大文件档位；缺省 normal（新建 / 未命名 / 会话里没带档位的旧数据） */
  sizeClass: SizeClass = "normal",
  /** 热退出副本 ID；恢复会话时沿用，其余情况留空等首次写副本时再生成 */
  backupId: string | null = null,
): Doc {
  const firstLine = text.split("\n", 1)[0] ?? "";
  // B372：只有**空白未命名**这一形吃「新建默认类型」：已命名文件按文件名走，
  // 带正文的未命名文档（会话恢复）不追溯改类型。设置值经注册表校验，
  // 认不出就当没设（与 languageOfDoc 对未知覆盖值的回退同口径）。
  const blank = name === "未命名" && !text;
  const preferred = blank ? blankDocLanguage(settings?.default_lang) : null;
  const lang =
    preferred ??
    (blank
      ? { label: "Plain Text", extension: null }
      : detectLanguage(name === "未命名" ? null : name, firstLine));
  return {
    tabId,
    path,
    name,
    encoding,
    eol,
    mixedEol: false,
    readonly,
    dirty: false,
    // 刚打开 / 刚新建：正文就是基线（B112），此时不脏
    baseline: text,
    baselineEncoding: encoding,
    baselineEol: eol,
    external: false,
    langLabel: lang.label,
    langOverride: preferred?.label ?? null,
    sizeClass,
    backupId,
    backedUp: false,
    diskMtimeMs: 0,
    diskSize: 0,
  };
}

/** 为文档在指定面板创建一个实例（独立 CM6 状态，内容同源）。 */
function makeInstance(doc: Doc, panelId: number, text: string): Tab {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang = languageOfDoc(doc, firstLine);
  const perf = perfProfileFor(doc.sizeClass);
  const { state, comps } = makeTabState(
    text,
    lang.extension,
    { dark: isDark, wrap: isWrap, perf },
    instanceOnUpdate,
  );
  return {
    tabId: takeInstId(),
    docId: doc.tabId,
    panelId,
    comps,
    state,
    viewMode: "source",
    scrollV: 1,
  };
}

/**
 * 文档当前**应当**是脏的吗（B112）。
 *
 * 「改过就永远脏」是错的：用户改了几个字又撤销回去、或者手动改回原文，内容已经
 * 和磁盘上一模一样，却一直挂着 ●、关窗还要弹确认框、自动保存还要再写一次盘。
 * 所以脏不脏由**比较**得出：正文偏离基线 ⇒ 脏；正好等于基线 ⇒ 干净。
 *
 * 编码 / 行尾也算进判据：切换行尾本身不改内存正文（保存时才落盘），
 * 若只看正文，切了行尾再编辑又撤销就会把「行尾还没写盘」这件事悄悄抹掉。
 *
 * ⚠️ 先比长度再比内容：绝大多数编辑都会改变长度，长度不同可以直接判脏，
 * 免去大文件上每次按键都做一次 O(n) 全文比较。
 */
function isDirtyVsBaseline(doc: Doc, text: string | null): boolean {
  const base = doc.baseline;
  if (base === null || text === null) return true;
  if (text.length !== base.length) return true;
  if (text !== base) return true;
  return doc.encoding !== doc.baselineEncoding || doc.eol !== doc.baselineEol;
}

/**
 * 把「当前正文 + 当前编码/行尾」钉成新的基线，文档随之转干净。
 *
 * 保存成功、重新载入、以磁盘版本为准 —— 凡是「内容已经与磁盘一致」的时刻都走它，
 * 不要单独写 `doc.dirty = false`：那会让 dirty 与基线脱节，下一次编辑就再也判不准。
 */
function markClean(doc: Doc, text: string): void {
  doc.baseline = text;
  doc.baselineEncoding = doc.encoding;
  doc.baselineEol = doc.eol;
  doc.dirty = false;
}

/**
 * 记下「已知磁盘版本」。
 *
 * 每次从磁盘读/写之后都要更新：它是 `file-changed` 事件里区分「外部改动」与
 * 「自己刚写盘激起的回声」的唯一依据。漏更新一次，用户保存完就会立刻被弹一次
 * 「文件已在外部被修改」。
 */
function markDiskVersion(doc: Doc, mtimeMs: number, size: number): void {
  doc.diskMtimeMs = mtimeMs;
  doc.diskSize = size;
}

function registerDoc(doc: Doc): void {
  docs.set(doc.tabId, doc);
}

function attachTabToPanel(tab: Tab, panel: Panel): void {
  tabs.set(tab.tabId, tab);
  panel.tabs.push(tab.tabId);
  panel.activeTabId = tab.tabId;
}

function panelIdsInOrder(): number[] {
  const ids: number[] = [];
  eachLeaf(layout, (id) => ids.push(id));
  return ids;
}

/**
 * B365：文档当前生效的语言。
 *
 * 顺序：手动覆盖（且是注册表里认得的标签）→ 文件名 / 首行自动检测。
 * 未知覆盖值（旧数据 / 注册表删过标签）按自动处理，不让文档卡在「有覆盖但没高亮」。
 */
function languageOfDoc(doc: Doc, firstLine = ""): LanguageInfo {
  const override = doc.langOverride ? languageInfoByLabel(doc.langOverride) : null;
  if (override) return override;
  return detectLanguage(doc.name === "未命名" ? null : doc.name, firstLine);
}

/** Markdown 文档判定（B365 起：手动类型优先，其次按文件名后缀）。纯谓词：tabs / 预览 / 菜单共用一份口径。 */
function isMdDoc(doc: Doc | undefined | null): boolean {
  if (!doc) return false;
  // 只认注册表里存在的覆盖值；认不出就落回后缀判定（与 languageOfDoc 同口径）
  if (doc.langOverride && languageInfoByLabel(doc.langOverride)) {
    return doc.langOverride === "Markdown";
  }
  return /\.(md|markdown|mdown|mkd)$/i.test(doc.name);
}

function isMdTab(tab: Tab): boolean {
  return isMdDoc(docs.get(tab.docId));
}

function isMdActive(): boolean {
  const t = activeTab();
  return !!t && isMdTab(t);
}

export {
  makeDoc,
  makeInstance,
  isDirtyVsBaseline,
  markClean,
  markDiskVersion,
  registerDoc,
  attachTabToPanel,
  panelIdsInOrder,
  isMdDoc,
  isMdTab,
  isMdActive,
  languageOfDoc,
};
