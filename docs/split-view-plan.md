# 分屏操作与样式改进方案

> 来源：`docs/vscode-reference/` 里 VS Code 的上游源码（只读参考库，commit 见 `REVISION*.txt`）。
> 本文只做**分析与方案**，不含实现；实施与否、实施哪一档由你决定。
> 所有数值均标注了出处文件，未凭记忆编写。

## 一、VS Code 的事实（读源码得到，不是二手文章）

### 1.1 分隔条（sash）—— `base/browser/ui/sash/`

| 事实 | 出处 | 数值 |
| --- | --- | --- |
| 命中区宽度 = 可见高亮线宽度 | `sash.css:7-8` | `--vscode-sash-size: 4px` / `--vscode-sash-hover-size: 4px` |
| 平时**完全透明**，只在悬停/拖拽时染色 | `sash.css:105-121` | `.monaco-sash:before{background:transparent}` → `.hover/.active:before{background:var(--vscode-sash-hoverBorder)}` |
| 染色有过渡 | `sash.css:114-116` | `transition: background-color .1s ease-out` |
| **双击复位** | `sash.ts:451,626` | `dblclick → onPointerDoublePress → _onDidReset.fire()` |
| 到达最小/最大时**光标变形** | `sash.css:25-31,37-43` | `.minimum{cursor:e-resize}` / `.maximum{cursor:w-resize}` |
| **正交角手柄**（可斜向拖，两条 sash 联动） | `sash.css:64-103`、`sash.ts:357-417` | 手柄 `2×sash-size = 8px`，`cursor:all-scroll`，四角 `nwse/nesw-resize` |
| 最小/最大尺寸是**像素**且硬约束 | `splitview.ts:871,916-933` | `clamp(size, item.minimumSize, item.maximumSize)`，拖拽 delta 也被 clamp |
| 可选**1px 常态分隔线** | `splitview.css:52-70` | `.separator-border ... ::before{width:1px; background:var(--separator-border)}` |
| 编辑器组之间的分隔色 | `workbench/common/theme.ts:237-242` | `editorGroup.border`：深 `#444444` / 浅 `#E7E7E7` |

### 1.2 拖拽分屏落点 —— `workbench/browser/parts/editor/editorDropTarget.ts`

| 事实 | 出处 | 数值 |
| --- | --- | --- |
| 中心区 = **不分屏**（合并进当前组） | `editorDropTarget.ts:429-434` | 指针在「边缘阈值以内」的整体中心区 |
| **边缘 10%** 触发分屏（拖编辑器） | `editorDropTarget.ts:408,414` | `edgeWidthThresholdFactor = 0.1` |
| 拖「组」时按偏好方向**非对称**放宽 | `editorDropTarget.ts:405-412` | 偏好方向那侧 `0.3`，另一侧 `0.1` |
| 方向选择用 **1/3 阈值** | `editorDropTarget.ts:424-425,448-479` | `splitWidthThreshold = width/3`，就近 1/3 决定左/右 或 上/下 |
| 高亮框 = 对应半边 | `editorDropTarget.ts:483-503` | 左/右/上/下 = 50%；中心 = 100% |
| **修饰键**：复制 / 切换分屏 / 放入编辑器 | `editorDropTarget.ts:374-384` | `Ctrl`=复制（Win）；`Alt`=临时反转「拖拽分屏」开关；`Shift`=drop-into-editor |
| 拖走**最后一个**编辑器时优先移动整组 | `editorDropTarget.ts:317-322` | 配合 `closeEmptyGroups` |
| 高亮层 | `media/editordroptarget.css` | `z-index:10000`、`pointer-events:none`、`opacity` 初始 0 |
| **高亮过渡**：「滑动」到目标区 | `media/editordroptarget.css:41-42` | `transition: top/left/width/height 70ms ease-out, opacity 150ms ease-out`（首次出现不加位移过渡，避免从错误位置飞过来） |
| 落点填充色（**无边框**，纯半透明） | `theme.ts:244-249` | `editorGroup.dropBackground`：深 `#53595D`@0.5 / 浅 `#2677CB`@0.18；仅高对比度主题才有虚线轮廓 |

---

## 二、LitePad 现状对照

| 维度 | LitePad 现状 | 出处 | VS Code | 差距 |
| --- | --- | --- | --- | --- |
| 分隔条命中区 | **7px** 透明 + `::after` **2px** 线 | `global.css:1168-1204` | 4px（线与命中同宽） | LitePad 更易抓（B53 有意为之），**不建议缩** |
| 分隔条常态 | 线色 `--border`，**始终可见** | 同上 | 平时透明，仅剩 1px `separator-border` | 观感取向不同，可保留 |
| 分隔条悬停 | `:hover::after → var(--accent)` | `global.css:1206-1208` | hover/active 同色 | 缺 **active（拖拽中）** 状态 |
| 拖拽中光标 | `body.layout-dragging{cursor:col-resize}`（**恒为 col**） | `global.css:1475-1478` | 按方向 `ew/ns-resize` | **垂直分屏时光标是错的**（bug） |
| 双击复位 | **无** | `splitview.ts:attachDrag` | `onDidReset` | 缺 |
| 极限光标反馈 | **无** | 同上 | `.minimum/.maximum` 变形 | 缺 |
| 正交角手柄 | **无** | — | 8px `all-scroll` | 缺 |
| 尺寸约束 | `flexBasis` 百分比 clamp **10%–90%** + CSS `min-width:120px/min-height:80px` | `splitview.ts:404-413`、`global.css:1210-1216` | 像素 `minimumSize/maximumSize` 硬约束 | 百分比 clamp 在窗口很小时可能小于 min（被 CSS 兜住），够用 |
| 落点阈值 | 边缘 **28%** 对称，中心 = 合并 | `splitview.ts:363-373` | 10% + 1/3 方向优先 | 手感不同，非 bug |
| 落点高亮 | `--accent` **22% 填充 + 2px accent 边框 + 圆角 4px**，**无过渡** | `global.css:1240-1275` | 半透明填充、**无边框**、70/150ms 过渡 | 缺过渡；配色更「硬」 |
| 修饰键 | `Ctrl` = 同源复制 | `splitview.ts:229` | `Ctrl` 复制 / `Alt` 切换分屏 / `Shift` 放入 | 缺 `Alt` |
| 分屏入口 | 拖标签到边缘 / 菜单 / 快捷键（B54 起无面板按钮） | `splitview.ts:303-340` | 拖拽 / 菜单 / 快捷键 | 一致 |

**结论**：LitePad 的分屏**结构上是对的**（递归树 + 命中区比视觉宽 + 拖拽预览），差距集中在**反馈细节**与**少数交互语义**，属于「打磨」而非「重做」。

---

## 三、改进项清单（可组合）

编号用于第三个方案里挑选。风险 = 改动面 × 回归测试量。

### 操作类

| 编号 | 改进 | 依据 | 成本/风险 | 涉及 |
| --- | --- | --- | --- | --- |
| **O1** | **双击分隔条复位到 50%** | `sash.ts:451,626` | 低 | `splitview.ts` + 测试 |
| **O2** | **拖到 10%/90% 极限时光标变形** | `sash.css:25-31` | 低 | `splitview.ts` |
| **O3** | 修正 `layout-dragging` 恒为 `col-resize` 的 bug（垂直→`row-resize`） | `sash.css:50-62` | 低（修 bug） | `global.css` + `splitview.ts` |
| **O4** | 大拖拽时自动锁定光标（`setPointerCapture`），避免移出条就丢事件 | — | 低 | `splitview.ts` |
| **O5** | `Alt` 临时反转「拖到边缘是否分屏」 | `editorDropTarget.ts:382-384` | 中 | `splitview.ts` |
| **O6** | 落点方向用 **1/3 优先**（角部归属更可预期），边缘阈值维持 28% | `editorDropTarget.ts:424-425` | 中（改手感，需实机校准） | `splitview.ts` + 测试 |
| **O7** | **正交角手柄**（斜向同时拖两条分隔条） | `sash.ts:357-417` | 高（需判定相邻 sep 交点） | `splitview.ts` + CSS |
| **O8** | 拖走面板最后一个标签时，移除该面板并让邻居吃满（对标「空组收起」） | `editorDropTarget.ts:317-322` | 中 | `main.ts` |

### 样式类

| 编号 | 改进 | 依据 | 成本/风险 | 涉及 |
| --- | --- | --- | --- | --- |
| **S1** | 分隔条加**拖拽中（active）**染色，与 hover 同色 | `sash.css:118-121` | 低 | `global.css` |
| **S2** | 落点高亮改**无边框 + 主题变量**（深色灰调 / 浅色蓝调），更「水面」感 | `theme.ts:244-249` | 低（观感主观） | `global.css` + 两套主题变量 |
| **S3** | 落点高亮加 **70ms 位移 + 150ms opacity** 过渡（区域间平滑滑动） | `editordroptarget.css:41-42` | 低 | `global.css` |
| **S4** | 拖拽分隔条时给被拖面板加 `.dragging` 类（可做轻微降亮度或取消过渡） | — | 低 | `splitview.ts` + CSS |
| **S5** | 分隔条常态线色对齐 `editorGroup.border` 观感（`#444` 档） | `theme.ts:237-242` | 低（观感主观） | `global.css` |

⚠️ **约束（不可破坏）**：
- `.layout-sep*` 与 `.toc-resizer` **必须同款**（B28 约定，`ARCHITECTURE.md` §7）。
- 命中区 7px **不缩**（B53 明确记录：原 5px 难抓）。
- 改动 `zoneOf` 会动到**文件拖入**的落点（与标签拖拽共用 `zoneOf`），必须同步回归。
- 新增主题变量**浅色/深色两套齐补**。

---

## 四、三个方案（供选择）

### 方案 A｜低风险打磨（纯增强，不动手感）
**O1 + O2 + O3 + O4 + S1**

双击复位、极限光标、修 `col-resize` bug、指针捕获、拖拽中染色。
全部是「加上去不会改变现有操作方式」的改进，回归测试主要是**新增**断言，风险最低。
预期：分屏从「能用」变「顺手」，但视觉上几乎不变。

### 方案 B｜操作对齐 VS Code（推荐）
**A 的全部 + O5 + O6 + S2 + S3**

在 A 之上，补齐 `Alt` 切换分屏、落点 1/3 方向优先、落点高亮改半透明无边框 + 过渡动画。
分屏的手感与视觉**明显向 VS Code 靠拢**。
⚠️ O6 会改变落点手感（28% 保留、仅细分方向），需实机确认；S2 是观感取向，可回退。

### 方案 C｜完整对齐（含角手柄）
**B 的全部 + O7 + O8 + S4 + S5**

再加正交角手柄（斜向联动拖两条）、空面板自动收起、拖拽降亮度、底色对齐。
功能最全，但 O7 的实现复杂度最高（要判定相邻 sep 的交点并联动），且**对「最多几个分屏」的文档编辑器收益有限**，性价比最低。

---

## 五、建议

- 若目标是「用户能明显感到更顺」→ 选 **A**，一次到位、零风险。
- 若愿意花一次实机校准换「明显更像 VS Code」→ 选 **B**。
- **C 的 O7（角手柄）性价比最低**：LitePad 分屏通常 2–3 块，角部联动拖拽的使用频率很低，建议单独评估或直接跳过。

> 视觉确认与截图**必须在桌面环境**做（沙箱内 WebView2 起不来）。O6/S2 属观感项，建议先做 A、再在实机上评估 B 的观感项。

---

## 六、实施记录（B59，用户选定「C 完整对齐」）

逐项落地情况：

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| O1 双击复位 | ✅ | `attachResize` 的 `dblclick` → 50% 并回写树（对标 sash 的 `onDidReset`） |
| O2 极限光标 | ✅ | 拖到 10%/90% 加 `.at-min`/`.at-max`，四个方向光标齐备 |
| O3 光标 bug | ✅ | 新增 `body.layout-dragging-v` → `row-resize`；默认 `col-resize` 不变（大纲/查找栏共用 `layout-dragging`，不受影响） |
| O4 指针捕获 | ✅ | `setPointerCapture`（无此 API 的环境静默跳过） |
| O5 Alt 取消分屏 | ✅ | 拖拽时按 Alt → 落点按 `center` 处理，预览同步切换 |
| O6 1/3 方向优先 | ✅ | 边缘带维持 28%，方向改用 VS Code 的 1/3 判定（角部归左右） |
| O7 正交角手柄 | ✅ | 相垂直接处生成 8px 手柄，斜向**同时**改两条比例；双击可双复位 |
| O8 空面板收起 | ⚠️ **原本已实现** | `closeTabById` / `moveTabToPanel` / `splitPanelWithTab` 三处早已在源面板空了且非唯一时 `disposePanel`，而 `removePanel` 的 ratio 补偿正是「邻居吃满」。**无需改动** |
| S1 拖拽中染色 | ✅ | `.layout-sep.resizing::after` 与 hover 同色 |
| S2 落点高亮无边框 | ✅ | 改用 `--drop-fill`（深色灰 `#53595D`@0.5 / 浅色蓝 `#2677CB`@0.18），去掉 2px 描边与圆角 |
| S3 落点过渡 | ✅ | `::after` 加 70ms 位移 + 150ms opacity；基础态铺满，避免首次弹出时「飞」 |
| S4 拖拽期过渡抑制 | ✅ | `body.layout-dragging .layout-panel *` → `transition: none`。**未做「降亮度」**：VS Code 缩放时并不压暗面板，压暗只会加噪音，故按本档说明采用「取消过渡」 |
| S5 线色抽取 | ✅ | 新增 `--sep-line`（深 `#444444` / 浅沿用 `#dcdfe3`），分屏与大纲分隔条共用（B28 同款约定保持） |

**与 VS Code 的有意偏离**（记录以免后人「修回原样」）：

- 边缘阈值维持 **28%**（VS Code 为 10%）：LitePad 面板少、拖拽更需容错。
- 浅色分隔线沿用 `#dcdfe3`（VS Code 为 `#E7E7E7`，在 LitePad 更密的布局里几乎不可见）。
- 角手柄统一用 `nwse-resize` 光标，未按四个角细分方向。

**测试**：新增 `tests/splitview.test.ts`（15 条）+ `regressions.test.ts` 的 B59 静态块；
`regressions.test.ts` 的 B28 两条断言随线色变量更名同步更新。全量 **341 vitest + 22 cargo** 全绿。

⚠️ **视觉确认需在桌面环境**（沙箱内 WebView2 起不来）：尤其 **S2 落点填充色**与 **O7 角手柄手感**。
