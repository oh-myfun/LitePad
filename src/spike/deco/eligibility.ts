// B397-1 · 「这一格/这一份该不该上所见即所得」的谓词。
//
// 从 `tabs/lifecycle.ts` 搬过来（原来在那儿只服务挂载点）。搬的理由：一颗 view 两档之后，
// 这个判断不再只属于「建面板」那一刻，而是**每次换档都要问一遍**（`applyPanelMode` 也问它），
// 留在 lifecycle 里就得让 `markdown.ts` 反向 import 过去 —— 那正是本仓库花十几步拆掉的环。
// 这个模块只读 `core/*` 与 `editor/perf`，谁都能指它。

import { docs, isDecoPreviewEnabled, settings } from "../../core/app-state";
import type { Tab } from "../../core/app-state";
import { isMdTab } from "../../doc-model";
import { normalizeSizeClass } from "../../editor/perf";

/**
 * B391F-3 · 三条都得问，缺一条就能把应用拖死。
 *
 * 三条各挡什么：
 *   · **开关**：`isDecoPreviewEnabled` 仍是全仓唯一读 `deco_preview` 的地方（闸只有一个，
 *     判据才数得清调用点）；
 *   · **是不是 Markdown**：装饰吃的是 markdown 语法树，一篇 `.txt` 开档等于每颗键
 *     全篇重 parse 却什么也不画；
 *   · **体积档**：B398 起只挡 `huge`（>20MB），与 VS Code 的
 *     `LARGE_FILE_SIZE_THRESHOLD` 同口径。2–20MB 的 Markdown 照开 —— 装饰的语法树
 *     只解析到「视口 + 前瞻」（`livePreview.ts`），每键成本与源码档同一量级
 *     （3.2MB 夹具实测 5–7ms）。`huge` 档仍然回派生预览：那里的整篇重建与解析
 *     都到了几百毫秒级，VS Code 在 20MB 也已经停掉令牌化。
 */
export function shouldMountDecoPreview(tab: Tab | undefined): boolean {
  if (!tab || !isDecoPreviewEnabled(settings)) return false;
  if (!isMdTab(tab)) return false;
  // 问 `docs.get` 而不是 `docOf`：后者查不到就抛，而「拿到一颗孤儿实例」这一形
  // 不该把整次换档带崩。
  return normalizeSizeClass(docs.get(tab.docId)?.sizeClass) !== "huge";
}
