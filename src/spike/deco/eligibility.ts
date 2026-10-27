// B397-1 · 「这一格/这一份该不该上所见即所得」的谓词。
//
// 从 `tabs/lifecycle.ts` 搬过来（原来在那儿只服务挂载点）。搬的理由：一颗 view 两档之后，
// 这个判断不再只属于「建面板」那一刻，而是**每次换档都要问一遍**（`applyPanelMode` 也问它），
// 留在 lifecycle 里就得让 `markdown.ts` 反向 import 过去 —— 那正是本仓库花十几步拆掉的环。
// 这个模块只读 `core/*` 与 `editor/perf`，谁都能指它。

import { docs, isDecoPreviewEnabled, settings } from "../../core/app-state";
import type { Tab } from "../../core/app-state";
import { isMdTab } from "../../doc-model";
import { normalizeSizeClass, perfProfileFor } from "../../editor/perf";

/**
 * B391F-3 · 三条都得问，缺一条就能把应用拖死。
 *
 * 三条各挡什么：
 *   · **开关**：`isDecoPreviewEnabled` 仍是全仓唯一读 `deco_preview` 的地方（闸只有一个，
 *     判据才数得清调用点）；
 *   · **是不是 Markdown**：装饰吃的是 markdown 语法树，一篇 `.txt` 开档等于每颗键
 *     全篇重 parse 却什么也不画；
 *   · **档位让不让自动预览**：>2MB / >20MB 两档生产是「停用自动预览 + 给提示」，
 *     装饰档照开就是绕过降级（InkNote 的 `previewSyntaxTree` 强制全文同步 parse，
 *     大文档那一档正是它的代价所在）。
 */
export function shouldMountDecoPreview(tab: Tab | undefined): boolean {
  if (!tab || !isDecoPreviewEnabled(settings)) return false;
  if (!isMdTab(tab)) return false;
  // 问 `docs.get` 而不是 `docOf`：后者查不到就抛，而「拿到一颗孤儿实例」这一形
  // 不该把整次换档带崩。
  return perfProfileFor(normalizeSizeClass(docs.get(tab.docId)?.sizeClass)).autoPreview;
}
