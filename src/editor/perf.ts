/**
 * M4 大文件分级：按文档体量裁剪编辑器特性。
 *
 * 为什么要分级：CodeMirror 6 的开销随文档体量非线性上升——
 * 语法高亮要增量解析全篇、折叠与括号匹配依赖语法树、选中匹配高亮会
 * 全文档扫描。20 MB 以上的文件若按完整特性打开，界面会长时间无响应。
 *
 * 原则：**降级而不是拒绝**。宁可少几个锦上添花的特性，也要保证
 * 「打得开、能编辑」。档位由 Rust 侧按字节数判定后随文件内容一起下发
 * （`OpenedFile.sizeClass`），前端不做二次判定，避免两边阈值漂移。
 */

export type SizeClass = "normal" | "large" | "huge";

export interface PerfProfile {
  sizeClass: SizeClass;
  /** 语法高亮（最贵：增量解析整篇文档） */
  syntax: boolean;
  /** 代码折叠 gutter */
  folding: boolean;
  /** 括号匹配高亮 */
  bracketMatching: boolean;
  /** 选中文本时高亮全文相同片段（会全文档扫描，大文件很慢） */
  selectionMatches: boolean;
  /** 当前行 / 行号槽高亮 */
  activeLine: boolean;
  /** Markdown 是否自动渲染预览（改为手动切换才渲染） */
  autoPreview: boolean;
}

/** 未知值一律按 normal 处理：宁可多给特性，也不要误降级。 */
export function normalizeSizeClass(raw: string | undefined | null): SizeClass {
  return raw === "large" || raw === "huge" ? raw : "normal";
}

export function perfProfileFor(cls: SizeClass): PerfProfile {
  switch (cls) {
    case "large":
      // 关掉所有依赖语法树 / 全文档扫描的特性；行号与当前行高亮很便宜，保留。
      return {
        sizeClass: cls,
        syntax: false,
        folding: false,
        bracketMatching: false,
        selectionMatches: false,
        activeLine: true,
        autoPreview: false,
      };
    case "huge":
      return {
        sizeClass: cls,
        syntax: false,
        folding: false,
        bracketMatching: false,
        selectionMatches: false,
        // 当前行高亮在超大文档下也会带来额外的重绘，一并关掉
        activeLine: false,
        autoPreview: false,
      };
    default:
      return {
        sizeClass: "normal",
        syntax: true,
        folding: true,
        bracketMatching: true,
        selectionMatches: true,
        activeLine: true,
        autoPreview: true,
      };
  }
}
