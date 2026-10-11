/**
 * 文件对话框过滤器 —— 纯数据，无依赖。
 *
 * 从 `ui.ts` 抽出：这是打开/保存对话框用的扩展名清单，本就是 io 关注的数据，
 * 放进 io 后 files.ts 直接 import，不必绕道 ui 的服务桶。
 */

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
