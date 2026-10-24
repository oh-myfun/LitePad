// 导出（HTML / PDF）与图片粘贴（从 main.ts 拆出，解耦第十五步 / #416-1）。
//
// 职责：`exportHtml` / `exportPdf`（导出当前文档）、`attachPasteHandler` /
// `pasteImageToAssets`（把剪贴板图片落到 ./assets 并插入引用）。
// 零外部依赖、零模块状态——纯叶子模块。
// 只依赖 core/* + doc-model + markdown（渲染与路径）+ editor/* + ipc/api + ui + markdown.ts。

import { activeTab, docOf, panelOfTab } from "../core/panels";
import { docs, tabs, type Tab } from "../core/app-state";
import { isMdTab } from "../doc-model";
import { dirname } from "../markdown";
import { irEditable } from "../markdown/ir-state";
import { buildExportHtml } from "../markdown/exporter";
import { renderFull } from "../markdown/pipeline";
import { printToPdf } from "../markdown/exporter";
import { exportFile, savePasteImage } from "../ipc/api";
import { showMessage } from "../ui";
import { logger } from "../core/logger";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "../ipc/api";
import type { Panel } from "../core/app-state";

// ---------------------------------------------------------------- 导出（M3）

async function exportHtml(): Promise<void> {
  const tab = activeTab();
  if (!tab || !isMdTab(tab)) return;
  const doc = docOf(tab);
  const srcPanel = panelOfTab(tab.tabId);
  if (srcPanel?.view && srcPanel.viewTabId === tab.tabId) {
    tab.state = srcPanel.view.view.state;
  }
  const picked = await saveDialog({
    defaultPath: doc.name.replace(/\.(md|markdown|mdown|mkd)$/i, "") + ".html",
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!picked) return;
  try {
    const html = buildExportHtml(doc.name, renderFull(tab.state.doc.toString()));
    await exportFile(picked, html);
    showMessage(`已导出 ${picked}`);
    logger.info("export", `html ${doc.name}`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

function exportPdf(): void {
  const tab = activeTab();
  if (!tab || !isMdTab(tab)) return;
  const doc = docOf(tab);
  const bodyHtml = renderFull(tab.state.doc.toString());
  // 打印 DOM 中的相对路径图片重写为 asset 协议地址
  const dir = doc.path ? dirname(doc.path) : null;
  const docEl = new DOMParser().parseFromString(bodyHtml, "text/html");
  if (dir) {
    for (const img of docEl.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:|#|\/)/i.test(src)) continue;
      const abs = dir.replace(/[\\/]+$/, "") + "\\" + src;
      img.setAttribute("src", convertFileSrc(abs));
    }
  }
  const wrapped = docEl.body.innerHTML;
  printToPdf(doc.name, wrapped);
  logger.info("export", `pdf ${doc.name}`);
}

// ---------------------------------------------------------------- 图片粘贴（M3）

function attachPasteHandler(panel: Panel): void {
  if (!panel.view) return;
  panel.view.view.dom.addEventListener("paste", (e: ClipboardEvent) => {
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    const doc = tab ? docs.get(tab.docId) : undefined;
    if (!tab || !doc || !isMdTab(tab) || !doc.path) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        void pasteImageToAssets(panel, tab, file);
        return;
      }
    }
  });
}

async function pasteImageToAssets(panel: Panel, tab: Tab, file: File): Promise<void> {
  // B352-11（评审 I3）：这一发**既往磁盘落文件、又往文档插一行**。闸要排在最前面 ——
  // 锁着的时候连「为一次不会写进文档的粘贴而生成的 assets 文件」都不该发生。
  if (!irEditable(tab)) {
    showMessage("即时渲染已锁定");
    return;
  }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
    const img = await savePasteImage(docOf(tab).tabId, b64, ext);
    const view = panel.view!.view;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: `![](${img.rel})` },
      selection: { anchor: pos + img.rel.length + 4 },
    });
    tab.state = view.state;
    showMessage(`图片已保存到 ${img.rel}`);
    logger.info("paste", `image ${img.rel} ${file.size}B`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

export { exportHtml, exportPdf, attachPasteHandler, pasteImageToAssets };
