/**
 * 同步滚动 v1 —— 运行时接线（T4）。
 *
 * 单一协调器单例 + 一个 reconciler：每次面板/标签/视图模式变化后，把当前所有**可见**
 * 面板的编辑器与预览按各自文档 id 注册进协调器（同 docId 的 editor+preview+其它面板
 * 共享一组锚点）。reconciler 先解绑旧句柄再重注册，是唯一的注册 chokepoint，避免去
 * 改动每处创建/销毁 EditorView / PreviewPane 的站点。
 *
 * 依赖方向：本模块只 import core/app-state 与同目录 sync-scroll/*（功能模块 → core/*，
 * 不反向依赖 main.ts），各功能模块（main / commands / toc / lifecycle）按需 import 本模块。
 */

import { panels, tabs } from "../core/app-state";
import { EditorScrollAnchor } from "./anchor";
import { PreviewScrollAnchor } from "./preview";
import { SyncScrollCoordinator, type AnchorHandle, type CoordinatedSurface } from "./coordinator";

/** 应用级协调器单例（B152 按文档开关挂在其上）。 */
export const syncCoordinator = new SyncScrollCoordinator();

/** 当前在册的锚点句柄（reconcile 时先全解绑再重注册）。 */
let handles: AnchorHandle[] = [];

/** 编辑器只暴露给同步滚动的表面（scrollDOM 是 EventTarget + 有几何）。 */
interface ScrollDom {
  readonly scrollDOM: HTMLElement;
}

function editorSurface(view: ScrollDom): CoordinatedSurface {
  return {
    events: view.scrollDOM,
    rect: () => view.scrollDOM.getBoundingClientRect(),
    scrollbarWidth: () => view.scrollDOM.offsetWidth - view.scrollDOM.clientWidth,
  };
}

function previewSurface(root: HTMLElement): CoordinatedSurface {
  return {
    events: root,
    rect: () => root.getBoundingClientRect(),
    scrollbarWidth: () => root.offsetWidth - root.clientWidth,
  };
}

/**
 * 解绑旧锚点、按当前可见面板重注册。应在以下时机调用：面板挂载（mountView）、
 * 切换标签（switchTab，docId 会变）、视图模式切换、分屏/关闭、文件打开/会话恢复。
 */
export function reconcileSyncRegistrations(): void {
  for (const h of handles) syncCoordinator.unregister(h);
  handles = [];
  for (const p of panels.values()) {
    const tab = tabs.get(p.viewTabId ?? p.activeTabId);
    if (!tab) continue;
    const docId = String(tab.docId);
    if (p.view?.view) {
      handles.push(
        syncCoordinator.register(
          new EditorScrollAnchor(p.view.view),
          docId,
          editorSurface(p.view.view),
        ),
      );
    }
    if (p.preview) {
      handles.push(
        syncCoordinator.register(
          new PreviewScrollAnchor(p.preview.scrollSurface()),
          docId,
          previewSurface(p.preview.root),
        ),
      );
    }
  }
}
