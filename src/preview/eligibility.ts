// B397-1 · 「这一格/这一份该不该上所见即所得」的谓词。
//
// 从 `tabs/lifecycle.ts` 搬过来（原来在那儿只服务挂载点）。搬的理由：一颗 view 两档之后，
// 这个判断不再只属于「建面板」那一刻，而是**每次换档都要问一遍**（`applyPanelMode` 也问它），
// 留在 lifecycle 里就得让 `markdown.ts` 反向 import 过去 —— 那正是本仓库花十几步拆掉的环。
// 这个模块只读 `core/*`，谁都能指它。
//
// B412：`deco_preview` 开关删除、派生 DOM 预览臂删除 ⇒ 只剩下**一道闸**：
// 是不是 Markdown（装饰吃的是 markdown 语法树，一篇 `.txt` 开档等于每颗键
// 全篇重 parse 却什么也不画）。huge 档也走新面（用户 2026-10-29 拍板「新面全接」）：
// 装饰的语法树只解析到「视口 + 前瞻」（`livePreview.ts`），每键成本与源码档同一量级。

import type { Tab } from "../core/app-state";
import { isMdTab } from "../doc-model";

/**
 * 这一张标签的预览档要不要装装饰面。
 *
 * 孤儿实例（文档不在册）由 `isMdTab` 兜住：它走 `docs.get`，查不到就是 false ——
 * 那条路不抛，整次换档不会被一颗悬空实例带崩。
 */
export function shouldMountPreview(tab: Tab | undefined): boolean {
  return !!tab && isMdTab(tab);
}
