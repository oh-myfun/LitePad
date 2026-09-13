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
  autosave: boolean;
  /** Markdown 预览行距（1.0–2.5） */
  preview_line_height: number;
  /** 大纲抽屉宽度（px，160–640） */
  toc_width: number;
  /**
   * 快捷键覆盖表：命令 id → 键位串（如 `file.save: "Ctrl+S"`）。
   * 空串表示显式解绑；缺项表示用 COMMANDS 里的默认键位。
   */
  keymap: Record<string, string>;
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
