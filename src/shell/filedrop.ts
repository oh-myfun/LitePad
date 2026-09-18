import { showPopupMenu } from "./menu";

/**
 * 外部文件拖入（B24）：
 * - WebView2 原生拖放才有真实路径（dragDropEnabled: true），页面内不处理 drop；
 * - 悬停期间按指针位置高亮目标面板与分区（复用标签拖拽的 .split-preview 层，main.ts 接线）；
 * - 落点决定打开位置：面板中央 = 在该面板打开，边缘 = 在该面板旁分屏打开；
 * - 落到**活动文档是 Markdown 的面板**上且只拖了一个文件时弹菜单：打开文档 / 插入文件路径。
 *   （原生 OS 拖拽期间鼠标被系统捕获，无法点击页面控件，所以选择菜单在 drop 后弹出。）
 */

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
