// 视口调试日志（从 main.ts 拆出的可复用核心模块）。
//
// 拆出来的理由：这几块是**别的模块都要用的公共底座**，留在 main.ts 里就等于
// 逼着每个功能模块反过来 import main.ts（hub 型耦合 + 循环依赖）。
// 归到 core/ 之后，功能模块只依赖 core/*，各自可单独单测。

import { Panel, tabs } from "./app-state";
import { activePanel } from "./panels";
import { logger } from "./logger";

/**
 * 视口调试日志（B146）。
 *
 * 用户报「切换标签时 md 文档的滚动位置会不断往下移」，而位置只在 DOM 上、写进记录的
 * 路径有好几条（切标签、滚动采样、刷新会话、预览二次定位…）。想知道**哪一步**把手
 * 放歪了，就得在每一步都留一条：快照值 / 编辑器实际值 / 预览实际值 / 视图模式。
 *
 * 默认级别是 info，这一条打开看不到 —— 要看就把设置里的日志级别调到 debug（或 trace）。
 * 别为了「always on」把它提到 info：滚动采样一秒能打几十条，会把 2MB 的日志冲掉。
 */
export function logViewport(where: string, panel?: Panel): void {
  const p = panel ?? activePanel();
  if (!p) return;
  const view = p.view?.view;
  const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
  const mode = t?.viewMode ?? "-";
  const root = p.preview?.root;
  const shown = mode === "preview" ? root?.scrollTop : view?.scrollDOM.scrollTop;
  logger.debug("viewport", `${where} tab=${t?.tabId ?? "-"} 模式=${mode} 视图=${shown ?? "-"}`);
}
