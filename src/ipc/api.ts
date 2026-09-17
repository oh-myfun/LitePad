import { invoke } from "@tauri-apps/api/core";

/** 与 Rust `TabInfo` 对应（rename_all = camelCase）。 */
export interface TabInfo {
  tabId: number;
  /** 未关联磁盘路径时为空字符串 */
  path: string;
  name: string;
  encoding: string;
  eol: string;
  readonly: boolean;
}

/** 与 Rust `OpenedFile` 对应（rename_all = camelCase）。 */
export interface OpenedFile {
  tabId: number;
  /** true 表示该路径已在某标签打开（前端应激活既有标签并保留编辑状态） */
  reused: boolean;
  path: string;
  name: string;
  /** 已归一化到 LF 的文本 */
  text: string;
  encoding: string;
  eol: string;
  mixedEol: boolean;
  readonly: boolean;
  size: number;
  /** 解码时出现无法映射的字节，提示编码可能选错 */
  lossy: boolean;
  /**
   * M4 大文件档位："normal" | "large" | "huge"。由 Rust 按字节数判定，
   * 前端据此裁剪编辑器特性（见 src/editor/perf.ts）。
   *
   * ⚠️ 字段名是 **camelCase**：Rust 侧 `OpenedFile` 标了 `rename_all = "camelCase"`，
   * 于是 `size_class` 出去的线上名字是 `sizeClass`。B68 之前这里写的是
   * `size_class`，一直读到 undefined → 回落 "normal" → **大文件降级从未真正生效**。
   * 同名的 `mixed_eol` / `lossy_chars` 早就按 camelCase 写对了，只有这两个漏了。
   */
  sizeClass: string;
  /** 分级提示文案（normal 为空串），直接显示给用户。 */
  sizeHint: string;
}

export interface LossyChar {
  ch: string;
  line: number;
  col: number;
}

export interface SavedFile {
  tabId: number;
  path: string;
  name: string;
  size: number;
  encoding: string;
  eol: string;
  lossy: boolean;
  lossyChars: LossyChar[];
}

export interface Settings {
  theme: string;
  default_eol: string;
  default_encoding: string;
  recent_files: string[];
  font_size: number;
  /** 编辑器等宽字体族名；空串 = 用内置默认栈（Cascadia Code / Consolas…） */
  font_family: string;
  /** 编辑器行距（1.0–2.5，默认 1.5） */
  editor_line_height: number;
  word_wrap: boolean;
  /** 自动保存：把脏文档写回**原文件**（VS Code `files.autoSave`）。B68 起默认关。 */
  autosave: boolean;
  /**
   * 热退出：关窗时把未保存内容写进独立副本，于是不必弹「未保存将丢失」的确认框，
   * 下次启动还原成未保存标签（VS Code `files.hotExit`）。B68 起默认开。
   *
   * 与 `autosave` 是两件事：自动保存写**原文件**（脏标记清除），
   * 热退出只写 LitePad 自己的备份区（原文件一个字节都不动）。
   */
  hot_exit: boolean;
  /** Markdown 预览行距（1.0–2.5） */
  preview_line_height: number;
  /** 大纲抽屉宽度（px，160–640） */
  toc_width: number;
  /**
   * 快捷键覆盖表：命令 id → 键位串（如 `file.save: "Ctrl+S"`）。
   * 空串表示显式解绑；缺项表示用 COMMANDS 里的默认键位。
   */
  keymap: Record<string, string>;
  /**
   * 键位预设 id（M4）。优先级：keymap 覆盖 > keymap_preset > 命令默认键位。
   * 未知值按 "default" 处理。
   */
  keymap_preset: string;
}

export function newTab(encoding?: string | null): Promise<TabInfo> {
  return invoke<TabInfo>("new_tab", { encoding: encoding ?? null });
}

export function openFile(path: string, encoding?: string | null): Promise<OpenedFile> {
  return invoke<OpenedFile>("open_file", { path, encoding: encoding ?? null });
}

/** 以指定编码重新载入某标签（覆盖状态栏切换编码的场景）。 */
export function reloadFile(tabId: number, encoding?: string | null): Promise<OpenedFile> {
  return invoke<OpenedFile>("reload_file", { tabId, encoding: encoding ?? null });
}

export function saveFile(args: {
  tabId: number;
  text: string;
  encoding: string;
  eol: string;
  path?: string | null;
}): Promise<SavedFile> {
  return invoke<SavedFile>("save_file", args);
}

export function closeTab(tabId: number): Promise<void> {
  return invoke<void>("close_tab", { tabId });
}

export function listTabs(): Promise<TabInfo[]> {
  return invoke<TabInfo[]>("list_tabs");
}

/** 保存前探测目标编码是否会丢字符（不可逆保护）。 */
export function checkEncodable(text: string, encoding: string): Promise<LossyChar[]> {
  return invoke<LossyChar[]>("check_encodable", { text, encoding });
}

export function listEncodings(): Promise<string[]> {
  return invoke<string[]>("list_encodings");
}

export function listEols(): Promise<string[]> {
  return invoke<string[]>("list_eols");
}

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

/** 运行日志埋点：追加写 %TEMP%\litepad-app.log，失败静默。 */
export function logEvent(event: string, detail?: string, level = "info"): void {
  void invoke("log_event", { level, event, detail: detail ?? null }).catch(() => {});
}

// ---------------------------------------------------------------- 会话（M2）

export interface TabSession {
  path: string;
  encoding: string;
  eol: string;
  cursorLine: number;
  cursorCol: number;
  /** Markdown 视图模式（source/split/preview） */
  viewMode?: string | null;
  /**
   * 热退出副本 ID（B68）。跨会话稳定，一个文档一个。
   *
   * 恢复时**副本优先于 `path`**：副本还在就说明关窗时该文档是脏的，
   * 要用副本内容而不是磁盘内容；副本不存在则退回按 `path` 打开原文件。
   * 未命名文档只靠它才能被恢复。
   */
  backupId?: string | null;
  /**
   * 前端文档 ID（B69，与 Rust `doc::Doc::id` 同源）。
   *
   * 空的未命名文档既没有 `path`、也不脏（没输入过内容 → 不会写副本），
   * 上面两个字段都认不出它，只能靠 `docId`：既用来把它记进会话，
   * 也用来在恢复时判断「哪些标签其实是同一个文档」——同一个空文档被分屏成
   * 两个实例时，不能恢复成两份互不相干的文档。
   */
  docId?: number | null;
}

export interface PanelSession {
  tabs: TabSession[];
  active: number;
}

export interface SessionState {
  panels: PanelSession[];
  /** 前端布局树（leaf.panelId = panels 索引），Rust 纯透传 */
  layout: unknown;
  activePanel: number;
}

export function loadSession(): Promise<SessionState | null> {
  return invoke<SessionState | null>("load_session");
}

export function saveSession(state: SessionState): Promise<void> {
  return invoke<void>("save_session", { state });
}

// ---------------------------------------------------------------- 热退出（B68）

/** 与 Rust `RestoredBackup` 对应（rename_all = camelCase）。 */
export interface RestoredBackup {
  tabId: number;
  /** 原路径；未命名文档为空字符串 */
  path: string;
  name: string;
  /** LF 归一化的正文 */
  text: string;
  encoding: string;
  eol: string;
  mixedEol: boolean;
  readonly: boolean;
  /** 同 `OpenedFile`：线上是 camelCase（`rename_all = "camelCase"`） */
  sizeClass: string;
  sizeHint: string;
}

/**
 * 写入热退出副本。
 *
 * ⚠️ 写的是 LitePad 自己的备份区（`%APPDATA%\LitePad\backups`），
 * **绝不碰 `path` 指向的原文件** —— 写原文件是自动保存的职责。
 */
export function writeBackup(args: {
  id: string;
  text: string;
  path: string;
  name: string;
  encoding: string;
  eol: string;
  mixedEol: boolean;
}): Promise<void> {
  return invoke<void>("write_backup", args);
}

/**
 * 把副本还原成新标签（内容仍是未保存状态）。
 *
 * 返回 `null` 表示「没有可用副本」（已丢弃 / 写失败 / 格式坏了）——
 * 正常分支而非错误，调用方退回按原路径打开原文件。
 */
export function restoreBackup(id: string): Promise<RestoredBackup | null> {
  return invoke<RestoredBackup | null>("restore_backup", { id });
}

/** 丢弃单个副本（保存成功 / 转干净 / 关闭标签选「不保存」）。幂等。 */
export function discardBackup(id: string): Promise<void> {
  return invoke<void>("discard_backup", { id });
}

/**
 * 清理会话不再引用的孤儿副本，返回删除个数。
 *
 * ⚠️ 只在**会话读成功之后**调用：会话文件坏掉时 `keep` 会是空表，
 * 那时候清理等于把用户全部未保存内容删掉。
 */
export function discardOrphanBackups(keep: string[]): Promise<number> {
  return invoke<number>("discard_orphan_backups", { keep });
}

/** Unicode 编码不会丢字符，可跳过不可逆检查以省掉一次全量扫描。 */
export function isUnicodeEncoding(label: string): boolean {
  return /^utf-?8|^utf-?16/i.test(label.trim());
}

// ---------------------------------------------------------------- 导出 / 粘贴图片（M3）

export function exportFile(path: string, contents: string): Promise<void> {
  return invoke<void>("export_file", { path, contents });
}

export interface PastedImage {
  path: string;
  /** 相对 md 文件的引用路径（assets/xxx.png） */
  rel: string;
}

export function savePasteImage(tabId: number, dataB64: string, ext: string): Promise<PastedImage> {
  return invoke<PastedImage>("save_paste_image", {
    tabId,
    dataB64,
    ext,
  });
}
