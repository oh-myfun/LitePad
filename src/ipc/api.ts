import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  /**
   * 读盘那一刻的磁盘版本号（mtime 毫秒，取不到为 0）。
   *
   * 前端把它记成「已知磁盘版本」，用来区分 `file-changed` 是外部改动还是
   * 自己刚保存激起的回声。字段名是 camelCase（Rust `rename_all`）。
   */
  mtimeMs: number;
}

/**
 * 外部修改事件（`file-changed`）。
 *
 * ⚠️ 认文档靠 `tabId` 而不是路径：监听用的是规范化后的绝对路径，
 * 而 `OpenedFile.path` 是用户给的原始写法，两端比不出来（M2 起就是这么漏事件的）。
 * 匹配由 Rust 侧做（它持有全部 doc），这里只负责消费。
 */
export interface FileChangedPayload {
  tabId: number;
  /** 事件当时的 mtime 毫秒；文件已被删除/暂时读不到时为 0 */
  mtimeMs: number;
  /** 事件当时的字节数；读不到时为 0 */
  size: number;
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
  /**
   * 写盘之后的磁盘版本号（mtime 毫秒）。前端据此刷新「已知磁盘版本」，
   * 否则自己保存激起的 `file-changed` 会被当成外部修改，表现为「保存完立刻弹冲突框」。
   */
  mtimeMs: number;
}

/**
 * B235：预览**正文内容区**的宽度档位。
 *
 * ⚠️ 这是**正文居中宽度**，不是源码与预览两栏的分屏比例（那个由拖拽分隔条管）。
 * 三档：
 *   · `standard` 标准 —— 860px（原先硬编码的那个值）
 *   · `wide`     宽屏 —— 1100px
 *   · `full`     全宽 —— 不限宽，正文铺满预览区（**默认**，用户 B235 点名要的）
 */
export type PreviewWidth = "standard" | "wide" | "full";

/** 左栏展开区里「此刻轮到哪一块」（B312；B314 加了第三块资源管理器）。外壳 `DrawerView` 是这个别名的再导出。 */
export type DrawerViewName = "toc" | "recent" | "explorer";

export interface Settings {
  theme: string;
  default_eol: string;
  default_encoding: string;
  recent_files: string[];
  font_size: number;
  /** 编辑器等宽字体族名；空串 = 用内置默认栈（Cascadia Code / Consolas…） */
  font_family: string;
  /** B227：代码字体族名（预览的 code/pre）；空串 = 用内嵌 Cascadia Mono */
  code_font_family: string;
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
  /**
   * B235：预览**正文内容区**的宽度档位（`standard` / `wide` / `full`，默认 `full`）。
   *
   * ⚠️ 这是**正文居中宽度**（原先硬编码在 `preview.css` 的 `max-width: 860px`），
   *    不是源码与预览两栏的分屏比例 —— 那个由拖拽分隔条管。
   * 存**档位名**而非 px：同一档在不同分辨率/缩放下观感才稳定。
   */
  preview_width: PreviewWidth;
  /** 大纲抽屉宽度（px，160–640） */
  toc_width: number;
  /**
   * B194：左栏**展开区是否摊开**。默认 false（与 index.html 的 `hidden` 初值一致）。
   *
   * 和 `toc_width` 一样放在设置里，而不是会话文件：它是**窗口级外观状态**
   * （关掉再开应该保持原样），不属于某份文档的状态 —— 会话是按文档组织的，放进去
   * 会变成「换了个文件，侧栏开合就跟着变」。
   *
   * B312 起它只管「开没开」，「开着的是哪一块」交给 `drawer_view`。
   */
  toc_open: boolean;
  /**
   * B312：展开区**摊开的是哪一块**（`toc` 大纲 / `recent` 最近打开 / `explorer` 资源管理器）。
   *
   * 与 `toc_open` 是一对：那颗记「开没开」，这颗记「开着的是谁」。收起时**不覆盖**
   * 这一颗（保留最后一次摊开的那块）⇒ 拖分隔条拖回来、与下次启动都指向同一块。
   * 旧配置文件没这个字段 ⇒ Rust 侧默认 `toc`，行为与加字段之前完全一致。
   */
  drawer_view: DrawerViewName;
  /**
   * B198：整个左栏（按钮列 + 展开区 + 中间缝）是否**收起**。默认 false（左栏在）。
   *
   * 与 `toc_open` 的关系是**两层、互不撤销** —— 这一条管「左栏在不在」，
   * `toc_open` 管「卡片里的展开区开没开」：整栏收起时展开区的开合值照旧留着，
   * 重新露出时回到用户上次的样子（这跟设置对话框里那颗大纲开关是同一件事的两层，
   * 谁也不该替对方清除状态）。
   */
  sidebar_off: boolean;
  /**
   * B314：资源管理器当前打开的**文件夹根路径**（空串 = 没有）。
   *
   * 归设置不归会话，理由与 `toc_open` 同一套（见 `session/mod.rs` 那一段）：它是**窗口级
   * 外观状态**，不属于某份文档。反过来放会话里会变成「打开一份新文件，根目录跟着那份
   * 文档的会话走」，而用户期望的是「我上次在看哪个文件夹」。
   * ⚠️ 只存根路径，**不存展开态**：一棵树的展开态是「这一轮浏览的临时足迹」，
   * 存下来只会让下次启动先画半屏、再去盘上把每一层要开的目录挨个读一遍。
   * 旧配置缺这格 ⇒ Rust 侧 `#[serde(default)]` 给空串（读不出来就当没开文件夹）。
   */
  folder_root: string;
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
  /**
   * 标签样式（B114）："connected"（VS Code 1.139 相连标签，默认）| "pill"（经典药丸）。
   * 未知值按 "connected" 处理；后端不校验。
   */
  tab_style: string;
  /**
   * 标签右侧 ●/× 操作槽位是否恒定预留空位（B115，对齐 VS Code
   * `workbench.editor.tabActionReserveSpace`，默认 true）。false = 紧凑档。
   */
  tab_action_reserve_space: boolean;
}

/**
 * B305：最近打开的一条记录。
 *
 * ⚠️ 名单归 Rust 持有（`<配置目录>/recents.json`，见 `src-tauri/src/session/recent.rs`），
 * 这里只是视图读的那份形状。它**不在 `Settings` 里**：那张表没有权威窗口，每个窗口都能
 * 整表覆写（`src/toc.ts` 里三处 `saveSettings`），名单放进去等于「别人一次无关的设置
 * 写入就把名单冲掉」。
 * `openedAt` 是**最后一次打开**的毫秒时间戳，相对时间（「刚才 / 3 分钟前」）由渲染端换算 ——
 * 文案归界面。B305 那版这个字段叫 `closedAt`（名单只收关掉的），B308 语义翻成「打开过就在册，
 * LRU 维护」后改了名；旧盘由 Rust 那侧的 serde alias 认下来，前端不许再读旧键。
 */
export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

/** 列名单。Rust 顺手剔掉磁盘上已不存在的条目，所以这里可能比上一次少几条。 */
export function listRecents(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("list_recents");
}

/**
 * 「用户打开了一份文件」⇒ 记一笔（Rust 侧 LRU 顶到最前）。
 *
 * ⚠️ 只由 `doOpen` 那一发调用（`src/io/files.ts`）：记的是**打开这个动作**，不是「某条路径
 * 出现在屏上」。会话恢复会让文件出现在屏上，却没人打开它（用户裁决「恢复不算打开」），
 * 而恢复走 `session/rebuild` 直接调 `open_file`，压根不经 `doOpen` —— 所以这里不需要
 * 「启动那一会儿别记」那种时间窗或旗标。
 *
 * 回包是**变更后的完整名单**（`forgetRecent` / `clearRecents` 同），视图直接拿它重画，
 * 不必再 `listRecents` 一次 —— 少一次往返就少一次读到中间态的机会。
 */
export function noteOpenedPath(path: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("note_opened", { path });
}

/** 单条清除（行上那颗 ✕）。 */
export function forgetRecent(path: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("forget_recent", { path });
}

/** 清空全部（标题栏那颗垃圾桶）。 */
export function clearRecents(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("clear_recents");
}

/** 保存数量上限（设置页那一项；0 = 不再记录并清空）。 */
export function getRecentLimit(): Promise<number> {
  return invoke<number>("get_recent_limit");
}

/** 改上限。回包是**生效后的**上限（别的窗口可能刚写过，以 Rust 为准）。 */
export function setRecentLimit(limit: number): Promise<number> {
  return invoke<number>("set_recent_limit", { limit });
}

// ---------------------------------------------------------------- B314 资源管理器

/**
 * 一层目录里的一条（Rust `commands/explorer.rs` 的 `FsEntry`，字段一律 camelCase）。
 * `size` 目录为 0、`mtimeMs` 取不到时为 0 —— 前端不许拿 0 当「文件不存在」的证据。
 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirListing {
  entries: FsEntry[];
  /** 真被上限裁过才算 true（不是「条数刚好等于上限」）；前端据此提示「只显示前 2000 条」。 */
  truncated: boolean;
}

/** 读一层目录。**一次只读一层**（递归在盘符根或 `node_modules` 上能把进程卡死）。 */
export function listDir(path: string): Promise<DirListing> {
  return invoke<DirListing>("list_dir", { path });
}

/**
 * 新建空文件。`name` 原样透传、**校验在 Rust**：`..` / 分隔符 / 盘符这些一旦要求每个
 * 调用者自己滤，就总会有人漏 —— 收名字的那一方必须自己验。
 * 重名一律报错，不覆盖（覆盖用户手里的东西从来不是「新建」该有的行为）。
 */
export function createFile(dir: string, name: string): Promise<FsEntry> {
  return invoke<FsEntry>("create_file", { dir, name });
}

/** 新建一层目录。参数语义与 `createFile` 完全一致（只建一段，父目录必须已在）。 */
export function createDir(dir: string, name: string): Promise<FsEntry> {
  return invoke<FsEntry>("create_dir", { dir, name });
}

// ------------------------------------------------------ B315 树里的常规文件操作
//
// 五条都带 `root`：**写操作的 target 必须在当前根之内**，而这道判定在 Rust。
// 前端传根不是冗余 —— 剪贴板那份路径存在我们自己的内存里，记错一层就会把东西
// 写到用户没看着的地方；看不见 ≠ 没发生（口径同 `check_name`：边界上的校验
// 由收下参数的那一方做）。
// `destDir` / `newName` 会被 Tauri 换成 Rust 那侧的 `dest_dir` / `new_name`，
// 两端各自拼错一个字母的代价是「命令收得到、参数是 undefined」，所以配套用例
// 在 `tests/explorer-contract.test.ts` 里钉着。

/** 改名。**撞名报错、不加后缀**（与粘贴相反：改名时静默换个名字，用户会以为盘上真叫那个）。 */
export function renameEntry(root: string, path: string, newName: string): Promise<FsEntry> {
  return invoke<FsEntry>("rename_entry", { root, path, newName });
}

/** 复制一份到 `destDir`（目录整棵跟着走；撞名自动加后缀 `x (2).ext`）。 */
export function copyEntry(root: string, src: string, destDir: string): Promise<FsEntry> {
  return invoke<FsEntry>("copy_entry", { root, src, destDir });
}

/** 挪走到 `destDir`（同层是空操作 → 报错；跨卷时 Rust 退化成「复制整份成功后再删原件」）。 */
export function moveEntry(root: string, src: string, destDir: string): Promise<FsEntry> {
  return invoke<FsEntry>("move_entry", { root, src, destDir });
}

/** 送进**系统回收站**（可反悔；本应用没有「永久删除」这个入口）。 */
export function deleteEntry(root: string, path: string): Promise<void> {
  return invoke<void>("delete_entry", { root, path });
}

/** 在系统资源管理器里选中这一条。 */
export function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
}

export function newTab(encoding?: string | null): Promise<TabInfo> {
  return invoke<TabInfo>("new_tab", { encoding: encoding ?? null });
}

export function openFile(path: string, encoding?: string | null): Promise<OpenedFile> {
  return invoke<OpenedFile>("open_file", { path, encoding: encoding ?? null });
}

/** 取走并清空 Rust 侧「文件关联待打开队列」（首次启动带参 / 收到 open-file 事件时各调一次）。 */
export function takePendingFiles(): Promise<string[]> {
  return invoke<string[]>("take_pending_files");
}

/** 以指定编码重新载入某标签（覆盖状态栏切换编码的场景）。 */
export function reloadFile(tabId: number, encoding?: string | null): Promise<OpenedFile> {
  return invoke<OpenedFile>("reload_file", { tabId, encoding: encoding ?? null });
}

/**
 * 保存冲突：磁盘上的版本比编辑器已知的新。
 *
 * ⚠️ 撞冲突时 Rust **一个字节都没写** —— 不是「保存失败」，所以不能走 Err。
 */
export interface SaveConflict {
  tabId: number;
  path: string;
  name: string;
  /** 磁盘上当前的文件版本号（mtime 毫秒） */
  diskMtimeMs: number;
  /** 磁盘上当前的字节数 */
  diskSize: number;
}

/**
 * `save_file` 的回包（Rust `SaveOutcome`，adjacently tagged：`kind` + `value`）。
 *
 * 前端按 `kind` 分派：`saved` 走正常落盘流程，`conflict` 弹框让用户选。
 */
export type SaveOutcome =
  { kind: "saved"; value: SavedFile } | { kind: "conflict"; value: SaveConflict };

export function saveFile(args: {
  tabId: number;
  text: string;
  encoding: string;
  eol: string;
  path?: string | null;
  /**
   * 编辑器上次读/写时记下的磁盘版本（「已知版本」）。
   * 两个都给了才做脏写检查；缺一个或为 0 表示没有基线（未命名 / 备份恢复 /
   * 另存到别处），此时不检查。
   */
  expectMtimeMs?: number | null;
  expectSize?: number | null;
  /**
   * true = 跳过磁盘版本检查直接覆盖。只在用户在冲突框里明确选了「覆盖保存」时传，
   * 其余情况一律不带 —— 否则就失去了防脏写的意义。
   */
  force?: boolean;
}): Promise<SaveOutcome> {
  return invoke<SaveOutcome>("save_file", args);
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

/**
 * 菜单里的一条编码（B218）：`label` 原样传回后端，`group` 是它所属的语言组名
 * （现在归口是「首组内联 + 其余组子菜单」，菜单那几级就是按 `group` 切出来的），
 * `common` 标这条是不是常用编码 —— 状态栏那颗键只铺常用几条（B219），主菜单那条
 * 全量不受它影响。
 *
 * ⚠️ 分组**由后端那份扁平列表自己带出来**，前端不许再维护一份「编码 → 语言」的
 *    对照表去分组 —— 两份迟早差一条，而差的那一条表现就是「菜单里有、功能没接上」。
 *    常用集同理：只按 `common` 过滤，不许另写一个标签白名单。
 */
export interface EncodingItem {
  label: string;
  group: string;
  common: boolean;
}

export function listEncodings(): Promise<EncodingItem[]> {
  return invoke<EncodingItem[]>("list_encodings");
}

export function listEols(): Promise<string[]> {
  return invoke<string[]>("list_eols");
}

/**
 * 本机字体清单（B227）：Rust 侧 `EnumFontFamiliesExW` 枚举的真实结果。
 *
 * ⚠️ 枚举类字段一律 snake_case（`FontItem` 没加 `rename_all`），与项目其余命令
 *    负载口径一致；改 Rust 那边字段名要同步这里。
 */
export interface FontItem {
  name: string;
  is_monospace: boolean;
}

export function listFonts(): Promise<FontItem[]> {
  return invoke<FontItem[]>("list_fonts");
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

/**
 * 后端当前生效的日志级别（B144），启动时拉一次。
 *
 * 前端也要拿它做**发前过滤**：级别是「前端决定发不发」还是「后端决定记不记」必须一致，
 * 否则要么白发一串注定被丢的行，要么用户临时开了 trace 而前端一直在挡。
 */
export function logLevel(): Promise<string> {
  return invoke<string>("log_level");
}

/** 运行时改级别并持久化（B144：出问题设 debug 复现，不用换包）。 */
export function setLogLevel(level: string): Promise<void> {
  return invoke<void>("set_log_level", { level });
}

/**
 * 日志文件的绝对路径（B289）。
 *
 * 设置页那颗「打开日志」用它：路径由 **Rust 侧**算（`<配置目录>/logs/litepad.log`，
 * 尊重 `LITEPAD_CONFIG_DIR`），前端拿到路径后交给自己这边的 `doOpen` 开成标签页。
 * ⚠️ 前端不许自己拼这个路径（配置目录可能被环境变量搬走）；也不许再走系统关联程序 ——
 * 上一版 `cmd /C start` 依赖 `.log` 关联到谁，关联程序起不来时用户只看到「点了没反应」。
 */
export function logFilePath(): Promise<string> {
  return invoke<string>("log_file_path");
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
  /**
   * B169：同步滚动开关（按文档记，B152）。落盘后重新打开时写回前端 `docSyncModes`，
   * 让同步键点亮态与退出前一致。`undefined` = 旧会话没有这个字段 → 当作没开过。
   */
  syncMode?: boolean;
  /**
   * B302：这一格**上次被看到时**的共享坐标 `v`（源码行号 + 小数）。
   *
   * 存 `v` 不存像素：面板宽度、字号、软折行都改行高，像素在另一档宽度下不指向同一处内容；
   * `v` 与宽度无关，重启后落在同一行（与 `Tab.scrollV` 同一个理由）。
   *
   * ⚠️ `null` / 缺省 ＝「这一格从没被看到过」，与 `1`（就停在顶部）是两件事（B299 的教训）。
   * 恢复时先取自己这一份，取不到才借同文档别的实例那一份（文档级兜底），都没有才回顶部。
   */
  scrollV?: number | null;
  /**
   * B193：**仅 `satelliteTabs` 段使用** —— 这个标签当时属于哪个卫星窗口（窗口 label 作分组键）。
   *
   * 会话里卫星标签是一份扁平列表，少了它就只能「全部并回主窗口」（v1 行为），
   * 多个卫星窗口会被坍缩成一份。带上 owner 才能按窗口分组、各自还原成一个卫星窗口。
   * 旧会话没有这个字段 → `undefined`，整批当作同一组。
   */
  owner?: string | null;
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
  /**
   * B71 ④：被搬到其他窗口的标签。卫星窗口不写会话，由主窗口代为登记，
   * 启动时一律并回主窗口（v1 不回放多窗口布局）。
   */
  satelliteTabs?: TabSession[];
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

// ---------------------------------------------------------------- 多窗口（B71 ④）

/**
 * 卫星窗口承载的标签快照。
 *
 * ⚠️ 正文必须**随载荷一起传**，不能让新窗口自己去读盘：未保存的修改、未命名文档
 * 都只存在于源窗口的内存里，读盘会拿到旧内容（甚至拿不到路径）。这也是把载荷
 * 定义成一个显式结构、而不是让新窗口「按 docId 回问」的原因。
 */
export interface SatelliteTab {
  /** 文档 id（全进程唯一，两个窗口共用同一批 id，不重新分配） */
  docId: number;
  path: string | null;
  name: string;
  /** LF 归一化的正文 */
  text: string;
  encoding: string;
  eol: string;
  readonly: boolean;
  dirty: boolean;
  /** 编辑器视图模式；非 Markdown 恒为 "source" */
  viewMode: string;
  cursorLine: number;
  cursorCol: number;
  /**
   * 共享坐标 `v`（源码行号 + 行内小数）—— 同步滚动 v1 的「这一格看到哪儿」。
   * 只传 cursorLine 的话，接手窗口只能把视口摆到**光标**那一行，而那不是发起窗口当下
   * 显示的那一处 ⇒「同一份文档，两个窗口显示的不是同一处」（B286 那一族）。
   * 存 v 而不是像素：两个窗口的宽度/字号/软折行都不同，像素在那边没有意义。
   */
  scrollV: number;
  /** B169：同步滚动开关（按文档记）——让接手窗口的同步键点亮态与主窗口一致 */
  syncMode?: boolean;
  sizeClass: "normal" | "large" | "huge";
  /** 热退出副本 id / 是否已备份，随标签一起带走，避免新窗口重复写一份副本 */
  backupId: string | null;
  backedUp: boolean;
}

/** 交付给卫星窗口的载荷（Rust 只透传，结构由前端定义）。 */
export interface SatellitePayload {
  tabs: SatelliteTab[];
}

/** 窗口身份应答。 */
export interface WindowPayload {
  kind: "main" | "satellite";
  label: string;
  payload: SatellitePayload | null;
}

/** 问 Rust「我是谁、我承载什么」。每个窗口启动时调一次。 */
export function windowPayload(): Promise<WindowPayload> {
  return invoke<WindowPayload>("window_payload");
}

/** 新窗口落点（逻辑像素，相对整个虚拟桌面）。 */
export interface WindowSpot {
  x: number;
  y: number;
}

/**
 * 新建卫星窗口，返回其 label。`payload` 会原样存在 Rust 侧等新窗口来取。
 * `spot` 给定时新窗口出现在该处 —— 「把标签拖到窗口外」的落点就是用户松手的
 * 地方，不让新窗口跑到系统随机摆放的位置去。
 */
export function openSatelliteWindow(
  title: string,
  payload: SatellitePayload,
  spot?: WindowSpot | null,
): Promise<string> {
  return invoke<string>("open_satellite_window", {
    title,
    payload,
    x: spot?.x ?? null,
    y: spot?.y ?? null,
  });
}

/**
 * 跨窗口广播封装：自动注入 `from` = 当前窗口 label，替换散落的
 * `emit(event, { from: windowLabel, ... })` 手写形态。`from`-family 纯广播走这里；
 * 与 Rust 同源的 `label`-family（`satellite-*`）定向 `emitTo`、以及 `tabdnd` 的
 * `cfg.selfLabel` 不在此收口范围内，保持各事件族语义不变。
 */
export function emitCrossWindow(event: string, payload: Record<string, unknown>): Promise<void> {
  // 注入的 `from` 放在展开之后 ⇒ 调用方若误传 `from` 也会被真实窗口身份覆盖，
  // 保证跨窗口身份唯一可信（调用方本就不该手写 `from`）。
  return emit(event, { ...payload, from: getCurrentWindow().label });
}

/** 路径 → 前端 `src` 可用的 Tauri 资产 URL（统一收口再导出，避免散落 import）。 */
export { convertFileSrc } from "@tauri-apps/api/core";
