/**
 * 文件对话框过滤器 —— 纯数据，无依赖。
 *
 * 从 `ui.ts` 抽出：这是打开/保存对话框用的扩展名清单，本就是 io 关注的数据，
 * 放进 io 后 files.ts 直接 import，不必绕道 ui 的服务桶。
 */

import { MEDIA_EXTENSIONS } from "./media";

export const TEXT_FILTERS = [
  {
    name: "文本文件",
    extensions: [
      "txt",
      "md",
      "markdown",
      "json",
      "js",
      "ts",
      "rs",
      "py",
      "html",
      "css",
      "xml",
      "yml",
      "yaml",
      "ini",
      "bat",
      "sh",
      "sql",
      "log",
    ],
  },
  { name: "所有文件", extensions: ["*"] },
];

/**
 * 打开对话框的过滤器：在文本档旁多给一档「图片、视频与音频」。
 *
 * 只给**打开**用 —— 保存/另存的目标永远是文本，媒体标签没有另存语义
 * （见 `saveDocCore` 的拦截），那边继续用 `TEXT_FILTERS`。
 */
export const OPEN_FILTERS = [
  TEXT_FILTERS[0],
  { name: "图片、视频与音频", extensions: MEDIA_EXTENSIONS },
  TEXT_FILTERS[1],
];
