import { showPopupMenu } from "./menu";

/**
 * 外部文件拖入（B24 起 / B91 改造）：
 * - wry 的原生拖放处理器已关闭（`dragDropEnabled: false`）—— 它做的两处劫持会把页面内
 *   HTML5 拖放一起废掉（详见 `src-tauri/src/dropbridge.rs` 模块头）。代价是**页面内拖放
 *   本身拿不到路径**（HTML5 file drop 只有内容），所以路径改走桥：
 *   `chrome.webview.postMessageWithAdditionalObjects` 把 drop 到的 File 对象交回宿主，
 *   Rust 取 `ICoreWebView2File::Path` 后 emit `tauri://drag-drop`（事件名与载荷与原生一致，
 *   所以「拿到路径之后怎么办」那段逻辑不用改）。
 * - 悬停高亮改由页面内 `dragover` 驱动：原生拖放没了就没有 enter/over/leave 事件，
 *   而 `clientX/clientY` 本来就是逻辑像素，比原来「物理像素 ÷ devicePixelRatio」更直接。
 * - 落点决定打开位置：面板中央 = 在该面板打开，边缘 = 在该面板旁分屏打开；
 * - 落到**活动文档是 Markdown 的面板**上且只拖了一个文件时弹菜单：打开文档 / 插入文件路径。
 *   （OS 拖拽期间鼠标被系统捕获，无法点击页面控件，所以选择菜单在 drop 后弹出。）
 * - ⚠️ 页面级监听挂**捕获阶段**并 `stopPropagation`：编辑器（CM6）会先把拖入的文件按文本
 *   内容读出来插进文档 —— 本项目没有这个功能，只有比它早拦才拦得住（见函数头）。
 */

/**
 * B316 · 树里拖出来的那一条带的自定义 MIME（值 = 被拖的路径）。
 *
 * 为什么要有它：同一扇 `drop` 事件上要分得开三种来源 —— 系统资源管理器拖进来的（`Files`）、
 * 标签拖拽（`tabdnd` 那套自定义类型）、以及树里的条目。只靠「有没有 files」判会把
 * 「从树里拖到编辑区」当成外部文件拖入，然后交给宿主桥去取路径 —— 而 HTML5 内部拖拽
 * 压根没有 `File` 对象，那一发会静默什么都不做。
 */
export const TREE_DRAG_MIME = "application/x-litepad-tree-path";

/** 这次拖拽是不是「树里的一条被拖起来」。 */
export function isTreeDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes(TREE_DRAG_MIME);
}

/**
 * 树里拖出来的是**文件**时才带这一条（值 = 路径）。
 *
 * 面板区只谈得上「打开一份文件」—— 目录拖到编辑器上没有任何合理落点（`doOpen` 会奔着
 * 一个目录去读盘），所以那一路干脆不认领，让指针停在默认的禁止态。目录的拖拽归树里自己
 * （B316-2 挪一层），两条判据各管各的。
 */
export const TREE_DRAG_FILE_MIME = "application/x-litepad-tree-file";

/** 这次拖拽是不是「树里拖出来的一条文件」（面板区那一路的认领判据）。 */
export function isTreeFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  return types.includes(TREE_DRAG_FILE_MIME) && types.includes(TREE_DRAG_MIME);
}

/** 与 Rust 侧 `dropbridge::MSG_TAG` 必须逐字一致（桥靠它筛掉别的 web message）。 */
export const FILE_DROP_TAG = "__litepad_file_drop__";

/** 悬停预览节流：dragover 触发极密，落点判定不必跟着跑。 */
const HOVER_THROTTLE_MS = 40;

/** WebView2 宿主出口（只在 Windows 的 WebView2 里有）。 */
type WebView2Host = {
  postMessageWithAdditionalObjects?: (message: string, objects: unknown[]) => void;
};

function webviewHost(): WebView2Host | null {
  const w = window as unknown as { chrome?: { webview?: WebView2Host } };
  return w.chrome?.webview ?? null;
}

/** 宿主出口在不在。不在就说明 WebView2 运行时太老（`AdditionalObjects` 是 2023 年那批 API）。 */
export function hasFileDropBridge(): boolean {
  return typeof webviewHost()?.postMessageWithAdditionalObjects === "function";
}

/**
 * 这次拖拽拖的是不是**文件**。
 *
 * 页面内的标签拖拽走自定义 MIME，不该被当成文件拖入 —— 两套拖拽共用一个 `drop` 事件，
 * 只能靠 `dataTransfer.types` 分清。
 */
export function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes("Files");
}

/**
 * 桥的消息体。坐标是**物理像素**（乘 devicePixelRatio）—— 与 Tauri 原生拖放事件同一口径，
 * 前端 `dropPosOf` 的换算因此原样沿用。
 */
export function bridgeMessage(x: number, y: number, dpr: number): string {
  return JSON.stringify({ tag: FILE_DROP_TAG, x: x * dpr, y: y * dpr });
}

/** 把 drop 到的文件交给宿主换成真实路径；出口不可用时返回 false（调用方据此记一行日志）。 */
export function postFilesToHost(files: File[], x: number, y: number, dpr: number): boolean {
  const host = webviewHost();
  if (typeof host?.postMessageWithAdditionalObjects !== "function") return false;
  try {
    host.postMessageWithAdditionalObjects(bridgeMessage(x, y, dpr), files);
    return true;
  } catch {
    return false;
  }
}

export interface FileDropHoverCallbacks {
  /** 指针落在某个落点上：高亮它 */
  preview: (x: number, y: number) => void;
  /** 离开窗口 / 拖拽收尾：清掉高亮 */
  clear: () => void;
}

/**
 * 装页面级的文件拖入收接，返回卸载函数。
 *
 * ⚠️ `dragover` 必须 `preventDefault()`：不拦的话 Chromium 按默认动作处理「拖入文件」，
 * 光标是禁止态而且 `drop` 根本不触发 —— 关掉 wry 之后，「这个窗口收文件」这句话得由
 * 页面自己说。`dragenter`/`dragleave` 用计数配对，只有归零（或真的离开窗口）才算拖出去。
 *
 * ⚠️⚠️ **监听一律挂捕获阶段 + `stopPropagation`**（用户报「拖入文档会直接插入文档内容」）：
 *    监听挂在**冒泡**阶段时，页面内的编辑器（CodeMirror 6）会**先**收到 `drop` —— 而 CM6
 *    的 drop 处理器一旦发现 `dataTransfer.files` 非空，就用 `FileReader.readAsText` 把
 *    **文件内容**读出来插进文档（`@codemirror/view` 的 `handlers.drop`）。等我们的处理器
 *    跑到，`preventDefault()` 已经无从撤销那次插入。捕获阶段挂在 document 上比任何页面内
 *    组件都早，拦得住。
 *    ⚠️ 本项目**没有「插入文档内容」这个功能**：菜单里那一项插的是**文件路径**
 *    （`main.ts` 的 `insertDroppedPath`）—— 内容从来不是我们要的东西。
 *
 * ⚠️ 只认**文件拖拽**（`types` 含 `Files`），其余原样放行：
 *    · 编辑器内部拖选区（`types` 是 `Text`）= CM6 的「把选中的文字拖到别处」，必须留给 CM6；
 *    · 标签拖拽走自定义 MIME，由 `tabdnd.ts` 在捕获阶段认领。
 */
export function installFileDropTarget(
  cb: FileDropHoverCallbacks,
  dpr: number = window.devicePixelRatio || 1,
): () => void {
  let depth = 0;
  let lastHover = 0;

  /** 认领一个文件拖拽事件：preventDefault（拦默认动作）+ stopPropagation（拦住页面内组件）。 */
  const claim = (e: DragEvent): boolean => {
    if (!isFileDrag(e.dataTransfer)) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const onEnter = (e: DragEvent): void => {
    if (claim(e)) depth += 1;
  };
  const onOver = (e: DragEvent): void => {
    if (!claim(e)) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const now = e.timeStamp;
    if (now - lastHover < HOVER_THROTTLE_MS) return;
    lastHover = now;
    cb.preview(e.clientX, e.clientY);
  };
  const onLeave = (e: DragEvent): void => {
    if (!claim(e)) return;
    depth = Math.max(0, depth - 1);
    // relatedTarget 为空 = 真的离开窗口，而不是在子元素之间移动
    if (depth === 0 || e.relatedTarget === null) cb.clear();
  };
  const onDrop = (e: DragEvent): void => {
    if (!claim(e)) return;
    depth = 0;
    lastHover = 0;
    // 先清高亮再做别的：桥万一不可用（旧运行时）或取文件出错，也不该在界面上留一块高亮
    cb.clear();
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    postFilesToHost(files, e.clientX, e.clientY, dpr);
  };

  /** 捕获阶段挂载：见函数头「CM6 会先把文件内容读出来插进文档」的说明。 */
  const CAPTURE = { capture: true } as const;
  document.addEventListener("dragenter", onEnter, CAPTURE);
  document.addEventListener("dragover", onOver, CAPTURE);
  document.addEventListener("dragleave", onLeave, CAPTURE);
  document.addEventListener("drop", onDrop, CAPTURE);
  return () => {
    document.removeEventListener("dragenter", onEnter, CAPTURE);
    document.removeEventListener("dragover", onOver, CAPTURE);
    document.removeEventListener("dragleave", onLeave, CAPTURE);
    document.removeEventListener("drop", onDrop, CAPTURE);
  };
}

/**
 * 装「树里拖出来的文件落到面板区」的页面级收接，返回卸载函数（B316-3）。
 *
 * 为什么不能借用上面那套：wry 的原生拖放被关了（`dragDropEnabled: false`），外部文件的
 * 路径靠宿主桥换（`postFilesToHost` → Rust → `tauri://drag-drop`）。而**页面内**的 HTML5
 * 拖拽压根没有 `File` 对象 —— 走桥那一发会静默什么都不做。路径本来就躺在 `dataTransfer`
 * 里，就地取出来直接落地即可。
 *
 * ⚠️ 只认领 `landable` 说「这儿落得下去」的那几下（= 面板区，含标签条）。树的空白处、
 *   侧栏、标题栏都不算：那里没有「打开到哪儿」这回事，而树里那一层的落点由
 *   `explorer/panel.ts` 自己判（B316-2）。不 `preventDefault` = 默认的禁止光标，正是想要的。
 * ⚠️ 捕获阶段挂载 + `stopPropagation`：口径同 `installFileDropTarget`，比页面内任何组件都早，
 *   CodeMirror 才没机会把这次拖拽当成它自己的选区拖放（它看见 `Text` 才动手，但抢在前面更稳）。
 */
export interface TreeFileDropCallbacks {
  /** 指针底下是不是一个能落地的面板区落点。 */
  landable: (x: number, y: number) => boolean;
  /** 与外部文件拖入**同一份**悬停高亮（分屏预览 / 标签插入竖线）。 */
  preview: (x: number, y: number) => void;
  clear: () => void;
  /** 松手：路径 + 逻辑像素坐标。「怎么落地」交回调用方，与 `tauri://drag-drop` 那一路同源。 */
  land: (path: string, x: number, y: number) => void;
}

export function installTreeFileDropTarget(cb: TreeFileDropCallbacks): () => void {
  let lastHover = 0;

  /** 载荷 + 落点两道闸都过了才认领。 */
  const claim = (e: DragEvent): string | null => {
    if (!isTreeFileDrag(e.dataTransfer)) return null;
    if (!cb.landable(e.clientX, e.clientY)) return null;
    e.preventDefault();
    e.stopPropagation();
    return e.dataTransfer?.getData(TREE_DRAG_FILE_MIME) ?? "";
  };

  const onOver = (e: DragEvent): void => {
    if (claim(e) === null) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const now = e.timeStamp;
    if (now - lastHover < HOVER_THROTTLE_MS) return;
    lastHover = now;
    cb.preview(e.clientX, e.clientY);
  };
  const onLeave = (e: DragEvent): void => {
    if (!isTreeFileDrag(e.dataTransfer)) return;
    // 离开窗口那一刻 `relatedTarget` 为空；行与行之间挪动不该把高亮抹掉（下一发 dragover 会重画）。
    if (e.relatedTarget === null) cb.clear();
  };
  const onDrop = (e: DragEvent): void => {
    const path = claim(e);
    lastHover = 0;
    if (path === null) return;
    cb.clear();
    if (path) cb.land(path, e.clientX, e.clientY);
  };
  /** 拖拽在别处结束（比如松手在窗口外）：高亮不能留在屏幕上。 */
  const onEnd = (e: DragEvent): void => {
    if (isTreeFileDrag(e.dataTransfer)) cb.clear();
  };

  const CAPTURE = { capture: true } as const;
  document.addEventListener("dragover", onOver, CAPTURE);
  document.addEventListener("dragleave", onLeave, CAPTURE);
  document.addEventListener("drop", onDrop, CAPTURE);
  document.addEventListener("dragend", onEnd, CAPTURE);
  return () => {
    document.removeEventListener("dragover", onOver, CAPTURE);
    document.removeEventListener("dragleave", onLeave, CAPTURE);
    document.removeEventListener("drop", onDrop, CAPTURE);
    document.removeEventListener("dragend", onEnd, CAPTURE);
  };
}

/**
 * 是否需要弹选择菜单：**单个文件**落到**活动文档是 Markdown 的面板**上时才问。
 *
 * ⚠️ 判据是「落点是 Markdown 文档」，不是「拖进来的文件是 Markdown」（B70 之前的写法）。
 * 菜单里那两项的意义是「打开它」还是「把路径插进光标处」—— 后者只有落点是一份 .md
 * 才谈得上（往 .txt 里插一行路径没有读者要的语义）。反过来说：拖进来的是 .md 而落点
 * 是 .txt 时，用户想做的是**打开**这份 md，不该被拦下来问一句。
 */
export function needsChoice(paths: string[], targetIsMarkdown: boolean): boolean {
  return paths.length === 1 && targetIsMarkdown;
}

export interface FileDropChoiceCallbacks {
  /** 用户选择「打开文档」 */
  onOpen: () => void;
  /** 用户选择「插入文件路径」 */
  onInsert: () => void;
}

/** 落点弹出选择菜单（Markdown 文件）：打开文档 / 插入文件路径。 */
export function showFileDropChoice(
  fileName: string,
  at: { x: number; y: number },
  cb: FileDropChoiceCallbacks,
): void {
  showPopupMenu(
    null,
    [
      { label: `打开「${fileName}」`, onSelect: cb.onOpen },
      { label: "插入文件路径", onSelect: cb.onInsert },
    ],
    at,
  );
}
