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

/**
 * 预览侧的「大文档」行数阈值：超过它就不自动跑 Shiki / Mermaid（公式便宜，仍算）。
 *
 * 与上面那三档**不是一条轴**：`sizeClass` 是 Rust 按**字节**判的编辑器降级，这一条是
 * 预览按**行数**判的渲染降级（5000 行的 md 可以只有几百 KB，两边都不该替对方说话）。
 * B391F-3 起两条渲染实现共用这一个数：派生 DOM（`markdown/preview.ts`）与 CM6 装饰面
 * （`spike/deco/codeBlockWidget.ts`）—— 两边阈值漂移过一次，装饰面写死 `bigDoc:false`，
 * 结果同一篇 5001 行文档装饰面比现方案多跑一整轮 Shiki（spike 结果文档①P3-2 那条不对称）。
 */
export const LAZY_THRESHOLD_LINES = 5000;

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

/**
 * B398 · 这一份文档的档位，Markdown 在 `large` 档例外：**语言扩展照装**。
 *
 * 理由（照 VS Code 的取舍）：`syntax:false` 原本是把「增量解析整篇」当最大开销省掉，
 * 但 CM6 的解析是**视口优先**的 —— 打开时只解析头 3000 字符，之后按视口推进
 * （`@codemirror/language` 的 parseWorker）。而 Markdown 的语法树还是所见即所得
 * 装饰面的原料（装饰只解析到视口 + 前瞻，见 `spike/deco/livePreview.ts`）⇒ 大文件
 * 没有解析器就等于没有装饰面。`huge`（>20MB）照关：与 VS Code 的
 * `LARGE_FILE_SIZE_THRESHOLD` 同口径，那里它连令牌化都停了。
 *
 * 只影响「装不装语言扩展」；折叠 / 括号匹配 / 选中匹配那三条仍按原档位关着。
 */
export function perfProfileForDoc(cls: SizeClass, markdown: boolean): PerfProfile {
  const base = perfProfileFor(cls);
  return markdown && !base.syntax && cls !== "huge" ? { ...base, syntax: true } : base;
}
