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
 */

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
 */
export function installFileDropTarget(
  cb: FileDropHoverCallbacks,
  dpr: number = window.devicePixelRatio || 1,
): () => void {
  let depth = 0;
  let lastHover = 0;

  const onEnter = (e: DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return;
    depth += 1;
  };
  const onOver = (e: DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const now = e.timeStamp;
    if (now - lastHover < HOVER_THROTTLE_MS) return;
    lastHover = now;
    cb.preview(e.clientX, e.clientY);
  };
  const onLeave = (e: DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    // relatedTarget 为空 = 真的离开窗口，而不是在子元素之间移动
    if (depth === 0 || e.relatedTarget === null) cb.clear();
  };
  const onDrop = (e: DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    lastHover = 0;
    // 先清高亮再做别的：桥万一不可用（旧运行时）或取文件出错，也不该在界面上留一块高亮
    cb.clear();
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    postFilesToHost(files, e.clientX, e.clientY, dpr);
  };

  document.addEventListener("dragenter", onEnter);
  document.addEventListener("dragover", onOver);
  document.addEventListener("dragleave", onLeave);
  document.addEventListener("drop", onDrop);
  return () => {
    document.removeEventListener("dragenter", onEnter);
    document.removeEventListener("dragover", onOver);
    document.removeEventListener("dragleave", onLeave);
    document.removeEventListener("drop", onDrop);
  };
}

export interface FileDropTarget {
  panelId: number;
  zone: "left" | "right" | "top" | "bottom" | "center";
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
