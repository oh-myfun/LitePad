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

---

## 七、B60 用户反馈三项（分隔条变细 / 落点回退浅蓝 / 对齐联动）

用户原话：「分割条有点粗（参考 vscode 样式）。分屏预览颜色还是用之前的浅蓝色。
如果两条竖分割线位置一致时要能同时调整上下两根竖分割线（vscode 逻辑）。」

### ① 分隔条改细 —— 根因是「占位」不是「线宽」

B59 的 `.layout-sep` 是 `flex: 0 0 7px` 的**透明占位**：线本身只有 2px，但 7px 的空档
把两侧内容撑开，中间露出祖先底色（标签栏行上是 `--bg-status` 与 `--bg` 之差），
于是在标签栏那一横排看起来就是一条 **7px 粗带**。VS Code 的 sash 是 **absolute 浮层、
完全不占位**（`sash.css`，`--vscode-sash-size: 4px`），所以边界永远只是一条细线。

改法（分屏 `.layout-sep` 与大纲 `.toc-resizer` 同步，B28 同款约定）：

- 元素本身 `flex: 0 0 0`（**主轴尺寸 0**；交叉轴仍 stretch 成满长，所以
  `.layout-sep-h::before` 能写 `top:0;bottom:0`、`.layout-sep-v::before` 能写 `left:0;right:0`）。
- 7px 命中区搬到 `::before`，向两侧各溢出 3.5px，压在相邻面板之上（B53 的宽命中区保留）。
- 视觉线由 `::after` 画：静息 **1px**（VS Code `editorGroup.border` 就是 1px），
  悬停/拖拽/联动涨到 **4px**（= `--vscode-sash-size`）。
- 角手柄随之从「贴着 7px 带摆」（`top:0` / `left:0`）改为**骑在界线上**（`-4px` + 8px）。

### ② 落点预览回退浅蓝

B59 照搬的 VS Code `editorGroup.dropBackground`（深灰 `#53595D`@0.5 / 浅蓝 `#2677CB`@0.18）
在 LitePad 上落点边界几乎看不出来。回退到 B59 之前的观感：**accent @0.22 填充 +
同色 2px 描边 + 4px 圆角**；描边压在填充上叠加成约 @0.39，形成「淡蓝底 + 略深蓝边」。
填充与描边**同源**（都走 `--drop-fill`），改主题不会只改一半。
过渡（70ms 位移 / 150ms opacity）保留 —— 那是 B59 从 `editordroptarget.css` 搬来的，有效。

### ③ 对齐联动（对标 VS Code 2x2 的 linkedSash）

上游依据：

- `gridview.ts:715-722` 的 `trySet2x2`：两个 2 子节点分支且首子尺寸相等时互为 `linkedSash`。
- `sash.ts:342-347`：「A linked sash will be forwarded the same user interactions and events
  so it moves exactly the same way as this sash. Useful in 2x2 grids.」
- `sash.ts:622-623`：`_onDidReset` 也转发给 linkedSash（**双击复位要联动**）。
- `sash.ts:629-648`：`onMouseEnter/onMouseLeave` 同样转发（**悬停高亮要联动**）。

LitePad 的判定比 VS Code 更通用：不要求「2x2 且尺寸相等」，而是**同向 + 中线差 ≤ 2px**
（`sashRegistry` + `centerOf()` + `alignedSashesOf()`，容差 `ALIGN_TOL`）。因为用户说的是
「两条竖分割线**位置一致**时」，中线判定最直接，且能覆盖 3×2 等多行网格。

转发三件事：拖拽中同步 `applyTarget`、松手各自 `commit`、双击复位。**角手柄不参与**
（它是双轴操作，`links = []`）。

⚠️ `sashRegistry` 必须在 `renderSplitview` 里清空 —— 否则会拿已脱离文档的旧句柄算对齐
（`centerOf` 恒为 0，误判成「全部对齐」）。

**测试**：`tests/splitview.test.ts` 新增 4 条（联动生效 / 错开不联动 / 悬停 `.linked` /
双击复位联动）+ `regressions.test.ts` 新增 B60 静态块。全量 **346 vitest + 22 cargo** 全绿。

### ④ 二次反馈：联动没生效 + 预览不要描边

**联动「还是没法一起拖动」——根因是用主轴判空。**

`centerOf()` 原先这样判「有没有布局」：

```ts
const len = entry.dir === "h" ? r.width : r.height;   // ❌ 主轴
if (!(len > 0)) return null;
```

但 ① 把分隔条改成了 `flex: 0 0 0` 的浮层 —— **主轴尺寸恒为 0**（竖线宽 0、横线高 0）。
于是 `len` 永远是 0，`centerOf` 恒返回 `null`，`alignedSashesOf` 永远拿到空数组：
**联动在真机上从来没生效过一次。**

修法是改看**交叉轴**（那是 stretch 出来的满长，它 > 0 才说明浏览器真的摆了盘）：

```ts
const cross = entry.dir === "h" ? r.height : r.width; // ✅ 交叉轴
if (!(cross > 0)) return null;
return entry.dir === "h" ? r.left + r.width / 2 : r.top + r.height / 2;
```

主轴为 0 恰好意味着 `left` / `top` **就是**界线本身，直接取用即可。
「交叉轴为 0 = 没布局」这个判据同时挡住了「全部零值被当成都在 0 点」的误判。

顺带确认：像素判据与 VS Code 的 `trySet2x2` 是**等价**的 —— 它对「两个 2 子节点分支」
要求 `getChildSize(0)` 相等；两行等宽时「首子尺寸相等」正等价于「分隔条落在同一 x」。
所以用「同向 + 位置差 ≤ 2px」既符合用户说的「位置一致」，也不会漏掉 VS Code 会联动的场景。

⚠️ **教训：测试桩必须忠实于新几何。** 原用例把分隔条 rect 桩成 `4px 宽`
（= B60 **之前**的几何），恰好把这个 bug 掩盖了 —— 桩造得比现实「宽松」，就会测试全绿、
真机全坏。现在桩成 `宽 0、高 150`，并在用例里显式断言「主轴必须是 0」。
已用「把 `centerOf` 改回主轴判空」反向验证：4 条联动用例全部失败，修回后全绿。

**预览「不用描边」**：去掉 `border: 2px solid var(--drop-fill)`，
**填充值 `--drop-fill` 一字未动**（仍是用户认可的那档 accent @0.22），
所以区域内侧的观感与上一版完全一致，只是没了那圈 2px 深边。
圆角 4px 保留（无描边时它只是边角略收，无害）。

**测试**：`tests/splitview.test.ts` 增至 21 条（新增「主轴为 0 也必须判定对齐」
「完全无布局不得联动」）；`regressions.test.ts` 的描边断言反转为「不得有描边」。
全量 **348 vitest + 22 cargo** 全绿。

---

## 八、B61 分隔条光标对齐 VS Code（用户反馈「和 vscode 不一样」）

**根因：我们抄的是 VS Code 的 mac 档。** `sash.css` 里光标是分平台给的：

```css
/* mac 档（sash.css:26 / :34，只在 .mac 类下生效） */
.monaco-sash.mac.vertical   { cursor: col-resize; }
.monaco-sash.mac.horizontal { cursor: row-resize; }

/* 基础档 = Windows / Linux（sash.css:52 / :59） */
.monaco-sash.vertical   { cursor: ew-resize; }
.monaco-sash.horizontal { cursor: ns-resize; }
```

LitePad 用的是 `col-resize` / `row-resize` —— 即 mac 档。Windows 上 `col-resize` 会渲染成
**「双箭头中间多一根竖杠」**（`⇔` 带竖线），`ew-resize` 是干净的双箭头（不带竖线），
一对比就明显不同。目标平台只有 Windows，故直接取基础档。

| 元素 | 改前 | 改后（= VS Code 非 mac 档） |
| --- | --- | --- |
| `.layout-sep-h` 竖线（左右分屏） | `col-resize` | **`ew-resize`** |
| `.layout-sep-v` 横线（上下分屏） | `row-resize` | **`ns-resize`** |
| `.layout-sep-h.at-min / .at-max` | `e-resize` / `w-resize` | 不变（极限档两平台一致） |
| `.layout-sep-v.at-min / .at-max` | `s-resize` / `n-resize` | 不变 |
| `body.layout-dragging`（拖拽中兜底） | `col-resize` | `ew-resize` |
| `body.layout-dragging-v` | `row-resize` | `ns-resize` |
| `.layout-corner` 与 `body.layout-dragging-corner` | `nwse-resize` | **`all-scroll`** |
| `.toc-resizer`（大纲，B28 同款） | `col-resize` | `ew-resize` |

**角手柄为什么是 `all-scroll` 而不是斜向箭头？** `sash.css:63` 给
`.orthogonal-drag-handle` 的**基础**光标就是 `all-scroll`；那几条 `nwse-resize` /
`nesw-resize` 覆盖规则都要求 `.orthogonal-edge-north` / `-south`（`sash.css:71-82`），
而该属性**只有 `resizable.ts` 会设**（四处边缘的定尺盒子），`gridview.ts` 从不设。
LitePad 的分屏是网格（= gridview 那一套），所以网格里的角手柄在 VS Code 里恒为
`all-scroll`（四向箭头）。原先写死 `nwse-resize` 并不符合上游行为。

⚠️ 顺手记一笔：**「不得残留 col-resize」这类断言必须先把 CSS 注释剥掉** ——
注释里恰恰要写清「为什么不用 col/row」（含这两个词），对全文断言会把说明文字当违规。

**测试**：`regressions.test.ts` 新增 B61 静态块（竖/横线、两个极限档、拖拽兜底三档、
角手柄、大纲同款，以及三条「不得残留 mac 档 / nwse」反向断言）；B28 的光标断言与
B59 的方向光标断言同步更新。全量 **349 vitest + 22 cargo** 全绿。

---

## 九、B62 双击复位要「整组居中」（用户反馈）

用户原话：「分割条联动时双击任意一条，所有的都应该居中。」

### 根因：联动集合在改比例**之后**才求出来（次序 bug）

老代码：

```ts
for (const t of targets) { applyTarget(t, 50); t.commit(0.5); }   // ← 先把本条挪到中间
for (const l of mode === "corner" ? [] : alignedSashesOf(handle, mode)) { … }
//                                        ↑ 这里才求集合
```

`alignedSashesOf` 依赖 `centerOf` → `getBoundingClientRect`，读的是**实时几何**。
第一条循环一跑，本条就移到了 50%，而联动的那条还停在原位（例如 30%）——
两者差了十几个百分点（几百 px），远超 `ALIGN_TOL = 2px`，**求出来的集合是空的**。
表现：双击只有点中的那条居中，其它的不动。3 行以上的网格更明显。

修法：**先把集合取出来，再统一改比例**（顺序反了就等于要求「挪走之后再认出它原本和谁对齐」）。

### 顺带修掉一个会「悄悄拆散」联动的 bug：纯点击也回写比例

`onUp` 无条件 `commit(pctFor(指针))`。但命中区宽 7px，指针常落在离界线几个像素处，
**一次不带拖动的点击就能把比例推走约 1%**（400px 容器 ≈ 4px）。而对齐判定只有 2px 容差：
点一下，两条对齐的线就出了容差，之后拖谁都不再联动 —— 用户会感觉「联动时灵时不灵」。
VS Code 的 sash 同样是「没有 move 事件就不改尺寸」。修法：`mousedown` 记 `moved`，
只有真正收到 `mousemove` 才在 `onUp` 回写。

### ⚠️ 测试教训（第二次了）：rect 桩不能是常量

上面两个 bug 都能被「常量 rect 桩」掩盖：
- 次序 bug 需要桩**随 inline flexBasis 变化**才会暴露（常量几何里，先把本条挪到 50%
  之后，桩仍然认为两条在同一位置）；
- 点击推挤 bug 需要 `pctFor` 真的按桩算得一个不同的比例才会暴露。

现在 `tests/splitview.test.ts` 的 `stubVerticalSash()` 会读**左栏的 inline flexBasis**
实时算界线位置，忠实于浏览器。并已反向验证：把两处修复分别还原，对应用例各自失败。

**测试**：splitview 增至 22 条（+「双击一起居中」「纯点击不回写」）；regressions 的
B60 静态块改为断言 `alignedSashesOf` 出现在 `applyTarget` **之前**（把次序写进契约）。
全量 **350 vitest + 22 cargo** 全绿。

---

## 十、B63 交叉点联动 + 双击按分割数量均分（用户反馈）

用户原话：「在交叉点拖动时，也要支持联动（高亮和一起拖动）。分割条双击不一定是居中，
而是根据分割数量均分（对应的所有分割线一起调整）。」

两件事：**① 角手柄（交叉点）也要进联动**；**② 双击的语义从「一律 50%」改成「按段数等分」**。

### ① 交叉点联动：把「一起动的那组」抽成一个入口

B60 的联动只认「同向且位置一致」，而角手柄被显式排除：

```ts
for (const l of mode === "corner" ? [] : alignedSashesOf(handle, mode)) { … }
//                       ↑ 角手柄干脆不联动
```

但角手柄恰恰是**轴互相垂直的两条线的交点**，它一次拖两条，这两条各自还有同向的联动伙伴
（2×2 网格里，交叉点一拖，x 轴的两条竖线 + y 轴的那条横线**三条**都该动）。所以：

```ts
/** 本次拖拽会一起动的全部分隔条：每个目标自身 + 与它同向对齐的伙伴。 */
function movingGroupOf(targets: ResizeTarget[]): BuiltSash[] { … }
```

- 普通分隔条 1 个目标 → 组 = 本条 + 同向伙伴；
- 角手柄 2 个目标（双轴）→ 两轴各自的组都并进来。

四个地方（`mouseenter` 悬停预告 / `mousedown` 高亮 / `onMove` 应用 / `onUp` 回写）
**全部改走这一个入口**，避免「高亮了一组、实际只动了一条」的错位。

⚠️ **角手柄必须复用子分隔条已注册的那个 `ResizeTarget` 对象**，不能另造：

```ts
attachResize(cHandle, [self, child.target], "corner");   // child.target = 已注册的那个
```

注册表按 **target 身份**（`sashOfTarget`）查联动伙伴。另造一个对象的话，
`sashOfTarget` 找不到它 → 子轴一侧的联动静默失效（而且不会报错）。
为此 `BuiltNode.split` 新增了 `target: ResizeTarget` 字段把注册对象带出来。

### ② 双击均分：同轴链 + 均分比例

「居中」在**只有 2 段**时恰好等于均分，段数一多就不对了。用户要的是「按分割数量均分」，
所以先要能认出「**哪些分隔条属于同一条链**」——即同一条边界上相连的那些。

```ts
interface ChainCtx { dir: "h" | "v"; chainId: number }   // 父节点同向 → 沿用父的链号
function segmentsAlong(node, d): number                  // 沿轴向数「最后并排几个面板」
// equalRatio = segA / (segA + segB)                     // 两侧段数相等即为均分点
```

`build()` 顺带算出每条的 `chainId` 与 `equalRatio`，登记进注册表。双击时：

```ts
const chains = new Set(movingGroupOf(targets).map((s) => s.chainId));
for (const s of sashRegistry) {
  if (!chains.has(s.chainId)) continue;
  applyTarget(s.target, s.equalRatio * 100);
  s.target.commit(s.equalRatio);
}
```

`equalRatio` 是**相对本节点两侧**的比例，但逐层累乘后正好每格等宽 —— 这是它的关键性质：

| 段数 | 逐级比例 | 各格实际占比 |
| --- | --- | --- |
| 2 | 1/2 | 50 / 50 |
| 3 | 1/3 · 1/2 | 33.3 / 33.3 / 33.3 |
| 4 | 1/4 · 1/3 · 1/2 | 25 / 25 / 25 / 25 |

> 直觉：第 k 级拿到 1/(n−k+1)，剩余 (n−k)/(n−k+1) 交给下一级，望远镜式相乘后每格都是 1/n。

`movingGroupOf` 让双击也带上**同向对齐的伙伴**（2×2 网格里两条竖线一起调），
所以「对应的所有分割线一起调整」既覆盖**同轴链**，也覆盖**跨行的对齐条**。
不同向的嵌套各自成链（横线归横线的链、竖线归竖线的链），互不干扰。

⚠️ `chainSeq`（链号自增源）必须与 `sashRegistry` 一同在 `renderSplitview` 归零 ——
注册表既然清了，链号留着不会串场，但归零后同一棵树每次渲染的链号恒定，
断言与调试都不再依赖绘制次数。

### ⚠️ 连带修掉的旧断言

B59 那条「父分隔条不得被连带激活」的用例，判据本身就是 B63 要推翻的语义：

```ts
expect(corner.parentElement.classList.contains("resizing")).toBe(false);  // 旧
```

角手柄挂在子分隔条上，B63 起**它本该高亮**（因为它跟着动）。但 `stopPropagation`
这条不变量仍然要守（否则子分隔条会再开一次拖拽 → 重复监听 + 重复 commit），
**判据换成「回写次数」**：一次斜拖恰好 2 条（父 + 子），多一条就说明注册了两次。

**测试**：splitview 增至 27 条（+ 交叉点拖动联动 / 交叉点悬停预告 / 三栏均分 /
四栏均分 / 异向嵌套不串链）；regressions 新增 B63 静态块（`movingGroupOf` 单一入口、
角手柄复用 target、链号与 `equalRatio`、`chainSeq` 随注册表重置），B60 静态块同步升级
（「角手柄不参与联动」的反向断言删除，改为断言链式均分）。
全量 **356 vitest + 22 cargo** 全绿；已反向验证：把 `movingGroupOf` 限回单目标、
把均分改回 `commit(0.5)`，对应用例各自失败。

