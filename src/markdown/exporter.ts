import katexCss from "katex/dist/katex.min.css?inline";
import previewCss from "../styles/preview.css?inline";

/**
 * Markdown 导出（M3）：
 * - HTML：自包含单文件（内联预览样式 + KaTeX 样式）
 * - PDF：WebView2 打印管线（专用打印 DOM + window.print，用户在系统对话框中「另存为 PDF」）
 */

export function buildExportHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${previewCss}
</style>
<style>
${katexCss}
</style>
</head>
<body class="md-export">
<article class="md-preview md-export-body">
${bodyHtml}
</article>
</body>
</html>`;
}

/** 打印导出 PDF：把渲染结果放进专用打印容器，触发系统打印对话框。 */
export function printToPdf(title: string, bodyHtml: string): void {
  const holder = document.createElement("div");
  holder.id = "print-root";
  const article = document.createElement("article");
  article.className = "md-preview";
  article.innerHTML = bodyHtml;
  holder.appendChild(article);
  document.body.appendChild(holder);
  document.body.classList.add("print-mode");

  const cleanup = () => {
    document.body.classList.remove("print-mode");
    holder.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  document.title = `${title} - LiteMD`;
  window.print();
  // afterprint 在取消打印时也可能不触发，兜底清理
  setTimeout(cleanup, 60_000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
