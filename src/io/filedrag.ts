// B400 · 标签拖出成文件（前端半截）。
//
// 用户口径（2026-10-28）：「标签支持拖拽到 vscode 等其他应用中打开对应文件」。
//
// 页面内的标签拖拽是 HTML5 DnD，外部应用收不到（它们只认系统拖放格式 CF_HDROP）。
// 所以 Ctrl+拖动标签这一条手势不进 HTML5，改由原生侧起一次 OLE 文件拖拽
// （`src-tauri/src/filedrag.rs`）；普通拖动一行不动，仍是排序 / 跨格 / 跨窗口 / 拖出开新窗。
//
// 「拖出去的是哪一份」：用户拍定**先存盘再拖** —— 拖到 VS Code 里看到的就是眼前这份内容。
// 存盘失败（含冲突没解决）就**不起拖**：宁可这次手势没反应，也不能让外部应用打开一份
// 和屏幕上不一致的旧文件。

import { invoke } from "@tauri-apps/api/core";

import { docs, type Tab } from "../core/app-state";
import { logger } from "../core/logger";
import { saveDocCore } from "./files";

/** 这份标签能不能拖出成文件（有磁盘路径才算）。 */
export function canDragTabFile(tab: Tab | undefined): boolean {
  if (!tab) return false;
  return !!docs.get(tab.docId)?.path;
}

/**
 * 把这份文档当系统文件拖出去（Ctrl+拖动标签时由标签条调用）。
 *
 * 返回前只做两件事：把脏文档存盘、把路径交给原生侧；真正的拖拽循环在主线程上跑，
 * 调用方（`dragstart`）不必等它。失败一律只记日志 —— 一次拖不出去不该弹窗打断阅读。
 */
export async function dragTabAsFile(tab: Tab): Promise<void> {
  const doc = docs.get(tab.docId);
  if (!doc?.path) return;

  if (doc.dirty) {
    const saved = await saveDocCore(doc, tab, false);
    if (!saved) {
      logger.warn("filedrag", `存盘失败，取消拖出：${doc.path}`);
      return;
    }
  }
  // 存盘可能改写路径（另存类分支），取最新那条
  const path = docs.get(tab.docId)?.path;
  if (!path) return;

  try {
    await invoke("start_file_drag", { paths: [path] });
  } catch (err) {
    logger.warn("filedrag", `拖出失败：${String(err)}`);
  }
}
