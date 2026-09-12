import { showPopupMenu } from "./menu";

/**
 * 外部文件拖入（B24）：
 * - WebView2 原生拖放才有真实路径（dragDropEnabled: true），页面内不处理 drop；
 * - 悬停期间按指针位置高亮目标面板与分区（复用标签拖拽的 .split-preview 层，main.ts 接线）；
 * - 落点决定打开位置：面板中央 = 在该面板打开，边缘 = 在该面板旁分屏打开；
 * - 单个 Markdown 文件落地时弹菜单：打开文档 / 插入文件路径。
 *   （原生 OS 拖拽期间鼠标被系统捕获，无法点击页面控件，所以选择菜单在 drop 后弹出。）
 */

export interface FileDropTarget {
  panelId: number;
  zone: "left" | "right" | "top" | "bottom" | "center";
}

/** 识别 Markdown 文件（与导出/会话恢复的扩展名集合一致）。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path.trim());
}

/** 是否需要弹选择菜单：仅当「单个 Markdown 文件」时（多文件/其他类型直接打开）。 */
export function needsChoice(paths: string[]): boolean {
  return paths.length === 1 && isMarkdownPath(paths[0]);
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
      {
        label: `打开「${fileName}」`,
        title: "作为文档打开（拖到面板边缘可分屏打开）",
        onSelect: cb.onOpen,
      },
      { label: "插入文件路径", title: "把路径文本插入当前编辑器光标处", onSelect: cb.onInsert },
    ],
    at,
  );
}
