// B391F-2 · 装饰面与面板模型之间的那一小段桥。
//
// 为什么单独成模块（而不是留在 `tabs/lifecycle.ts` 里）：`io/files.ts` 重载文档那一形
// 也要播种装饰面，而 `lifecycle.ts` 已经 import 了 `io/files.ts`（`saveDocCore`）——
// 反向再指回去就是本仓库花十几步拆掉的那种环。三样东西都只读 `core/*` 的状态，
// 放这儿两边都能拿。

import { tabs } from "../../core/app-state";
import type { Panel } from "../../core/app-state";
import { reseedDecoMirror } from "./mirror";

/** 这一格此刻该显示的那份文档正文（装饰面的播种源）。 */
export function decoTextOf(panel: Panel): string {
  const t = tabs.get(panel.viewTabId ?? panel.activeTabId);
  return t?.state.doc.toString() ?? "";
}

/** 这一格此刻该显示的那份文档编号（装饰面的归属戳记源）。 */
export function decoDocIdOf(panel: Panel): number {
  const t = tabs.get(panel.viewTabId ?? panel.activeTabId);
  return t?.docId ?? 0;
}

/**
 * 把这一格的装饰面重新播种到它**现在该显示**的那份文档。
 *
 * 四条同形路径都得点名，缺一条就是「镜像停在旧文档、桥按归属闸拒收」⇒ 预览面显示
 * 一篇旧文（数据不会坏，但那一格从此不跟着动）：
 *   · `switchTab` 换标签、`closeTabById` 关相邻标签接班（都在 `lifecycle.ts`）；
 *   · `tabs/split.ts` 拖出去之后原面板激活相邻标签；
 *   · `io/files.ts` 外部改动 / 重载把整份正文 setState 进去。
 * 同文档的增量编辑不走这里，走 `syncDecoMirrors` 的 ChangeSet 桥
 * （桥那边基线一致才有意义，换了文档必然被判 `skipped-stale`）。
 */
export function refreshDecoMirror(panel: Panel): void {
  if (!panel.decoMirror) return;
  reseedDecoMirror(panel.decoMirror, decoTextOf(panel), decoDocIdOf(panel));
}
