# 标签栏样式优化方案（对标 VS Code 最新版）

> 状态：**方案 B 已实施（B55）**；方案 C（Connected）未做，留作后续候选。
> 前置：B54 已回退 34px 方角平标签 → 24px 上圆角 + 描边；标签栏 28px；滚动条 2px 无箭头。
> 相关源码：`src/styles/global.css`（`.tab*` / `.panel-tabstrip`）、`src/shell/tabstrip.ts`、`src/shell/splitview.ts`
>
> **实际落地的取值**（与下方方案 B 表格的差异已注明）：
> - 药丸 **20px**（compact 档）→ 标签栏保持 **28px** = 4 + 20 + 4 ✔按计划
> - 滚动条 **4px**，正好吃掉下方那 4px 间隙（用户指定，原计划是 2px）
> - 圆角 4px、无描边、间距 4px、非活动文字 `color-mix(fg 50%)` ✔按计划
> - 操作列保持 16px 槽位（未引入 24px 覆盖层 + 渐变）✔按计划
> - 新增三档变量 `--tab-bg-hover` / `--tab-bg-active` / `--tab-bg-active-hover`，浅深各一套
> - 顺带删掉两条**死代码** `.tab-dragging` / `.tab-drag-over`（无任何 JS 引用，
>   拖拽指示早已由 `.tab-insert` 承担；留着会让「无描边药丸 + border-left」互相矛盾）
> - ⚠️ **保留**了 `.panel-head` 的 1px 底边线（VS Code Modern UI 里这条是透明的）。
>   保留理由：LitePad 的标签栏与编辑区没有额外的「卡片外框」，去掉这条线后两者仅靠
>   底色差（#17191b / #1b1d1f）分隔，面板结构会显得没有边界。若要彻底「浮动化」，
>   需要连带做方案 C 的编辑区轮廓 —— 见下方「未做项」。
> - 未做：`.panel-tabstrip` 的 overlay 滚动条（仍用 4px 自绘，理由见待确认表）

---

## 0. 结论先行

**推荐：方案 B（Modern UI 药丸）+ 可选叠加方案 C（Connected 接通）**，分两步走。
理由是 B 可以做到**标签栏总高不变（28px）**——VS Code 的 compact 档恰好是「20px 药丸 + 上下各 4px 间距 = 28px」，
与我们现在的 28px 完全对齐，因此不需要动 `.panel-tabstrip` 高度、不需要重算滚动条余量、不会引出「溢出↔不溢出」抖动。

若只想小步走、不冒险：**方案 A**（保守打磨，只做 4 项低风险对齐）。

---

## 1. 研究结论：VS Code 最新版的标签到底是什么样

✅ **版本锚点**：当前稳定版 **1.137.0**（2026-09-09/10）。标签样式的主体变化来自 **1.129 引入的 Modern UI 预览**
（`workbench.experimental.modernUI`，**默认只在 Insiders 开启**），所以"最新版 VS Code 的标签"实际有 **两种形态**。

### 1.1 经典形态（stable 默认）

来源：`src/vs/workbench/browser/parts/editor/editorTabsControl.ts`、`media/multieditortabscontrol.css`

| 项 | 值 |
| --- | --- |
| 标签高 | `EDITOR_TAB_HEIGHT = { normal: 35, compact: 22 }` |
| 底色 | `tab.inactiveBackground` / `tab.activeBackground`（+ unfocused 两档） |
| 活动态 | 默认靠**底色 + 前景**区分；`tab.activeBorderTop` 可加 1px 顶边（需主题给色） |
| 脏标记 | 图标字体 `circle-filled` 圆点，**悬停换 `close`**（与 LitePad 现在的 ●/× 同构） |
| 固定标签 | `sticky-compact` 宽 38px，`position: sticky` 不随滚动 |
| 标签栏滚动条 | **完全隐藏**（`scrollbar-width: none` + `::-webkit-scrollbar{display:none}`），改用 overlay 滚动条浮在标签上（z-index 11） |
| 拖拽落点 | 2px，相邻边界用 `transform: translateX(-50%)` 对齐到间距中点 |

### 1.2 Modern UI 药丸形态（1.129+，实验性）

来源：`src/vs/workbench/contrib/modernUI/browser/media/tabs.css`
（文件头注释原文：*"transparent, rounded, borderless **pills** with a subtle active highlight"*）

| 项 | 值 |
| --- | --- |
| 药丸高 | `--editor-group-tab-height: 24px`；**compact 档 20px** |
| 命中区 | 标签盒子 `border-block: 4px solid transparent` → **24px 药丸 + 上下各 4px = 32px**（compact 档 = 28px） |
| 横向间距 | 药丸 `.tab-fill` 用 `inset: 0 2px` → 相邻药丸视觉间距 **4px** |
| 圆角 | `--vscode-cornerRadius-small`（小圆角，🟡 推测 4px） |
| 描边 | **无**。只有活动态上下各 1px `strokeThickness`（默认透明）+ 右侧 1px 内侧描边（默认透明） |
| 非活动底色 | `modernEditorTab-inactiveBackground` |
| 活动底色 | `modernEditorTab-activeBackground`；`activeHover` 单独一档 |
| 悬停 | 底色 + **1px 下描边** |
| 非活动文字 | 降到 `color-mix(foreground 50%, transparent)` |
| 操作列 | **绝对定位覆盖层**，宽 24px，圆角只做右侧两角；悬停时从左侧 16px 宽度**渐变淡入**；活动/脏/固定标签的图标常显 |
| 固定标签 | 紧凑态 **28px**（经典是 38px） |
| 标签栏底边线 | 默认**透明**（药丸浮在底色上，不被一条线串起来） |
| 滚动条 | 仍是 overlay，且额外有 `sticky-tabs-background` 遮住滚动中的药丸 |

### 1.3 Connected 接通形态（与 Modern UI 同门，Insiders 里的最新表达）

来源：`src/vs/workbench/contrib/modernUI/browser/media/connectedEditorTabs.css`

- 活动标签的填充**向下延伸出标签行**（`bottom: -(4px + 1px)`），顶/左/右 1px 描边、**底边保持透明**；
- 顶部圆角 = `cornerRadius-small + strokeThickness`（"cap 半径"）；
- 左右各一个 `::before` / `::after` **凹圆角（shoulder）**：quarter-round + 反向 `box-shadow` 遮罩，把标签与编辑区**缝成一条连续轮廓**；
- 编辑区外框 `::after` 画 1px 描边且 `border-top: 0`，与标签轮廓接上；
- 侧栏/面板标签、Settings 标签同步改用药丸（整套语言统一）。

---

## 2. LitePad 现状 vs VS Code 最新版（差异清单）

| # | 维度 | LitePad 现状（B54） | VS Code 最新 | 差距 |
| --- | --- | --- | --- | --- |
| 1 | 标签高 | 24px | 24px（Modern）/ 20px（compact） | ✅ 已对齐 |
| 2 | 标签栏总高 | 28px | 32px（Modern）/ 28px（compact） | 🟡 compact 档零差异 |
| 3 | 形状 | 上圆角 6px + **1px 描边** | 无描边药丸，圆角 4px | ❌ 主要差距 |
| 4 | 活动态 | 底色 `--bg` + 描边 | 底色 + 极淡上/下描边 | 🟡 接近 |
| 5 | 标签间距 | `gap: 2px`，靠边框分隔 | 4px 视觉间距（无边框） | ❌ |
| 6 | 底边线 | 贯穿一条 1px `--border` | 透明（药丸浮着） | ❌ |
| 7 | 非活动文字 | `--fg-muted`(#8b9299) | `color-mix(fg 50%)` | ✅ 接近 |
| 8 | ● / × | 同一 16px 槽位，悬停切换 | 同构，但**操作列 24px + 渐变淡入**，活动标签常显 | 🟡 |
| 9 | 滚动条 | 2px 自绘，**占布局高度**（恒定预留 2px） | 原生完全隐藏 + overlay 浮层 | 🟡 我们的做法更简单，代价是要预留 |
| 10 | 固定标签 | 无 | compact 28px + sticky | ❌ 缺能力（非本次必做） |
| 11 | 拖拽落点线 | 2px `.tab-insert`（已补偿 scrollLeft） | 2px + `translateX(-50%)` 对齐间距中点 | 🟡 需确认是否已对齐 |

---

## 3. 三个方案

### 方案 A · 保守打磨（低成本对齐，不动几何）

只做 4 件事，每件都只碰 `global.css`：

1. **活动标签"接通"底边线**：`.tab-active` 加 `margin-bottom: -1px`，让活动标签盖掉标签栏的 1px 底边线（现在线是穿过去的，"接通感"就没了）。
2. **悬停态**：`.tab:hover:not(.tab-active)` 加 1px 下描边 + 底色，替掉现在单纯的底色变化。
3. **活动标签的 × 常显**（现在只在 hover 显示），与小家 VS Code Modern 行为一致。
4. **标签间距 2px → 4px**，同时把描边保留（形态不变）。

- 影响面：约 20 行 CSS；不动高度、不动 `tabstrip.ts`、不动 `.tab-insert`。
- 风险：**低**。唯一要重测的是"活动标签 -1px 后与编辑器内容是否重叠 1px"。
- 收益：观感提升有限，但把"接不上"这个最刺眼的点解决掉。

### 方案 B · Modern UI 药丸（推荐）

对齐 1.2 节，**取 compact 档**以做到零高度变化：

| 项 | 取值 |
| --- | --- |
| 药丸高 | **20px** |
| 标签栏 | **保持 28px** = 4px 上间距 + 20px 药丸 + 4px 下间距 |
| 滚动条 | 2px 自绘，**放在下面那 4px 里**（不再额外占高度 → 去掉现在的"2px 恒定预留"） |
| 圆角 | 4px |
| 描边 | 去掉；活动态用底色 + `--tab-bg-active` 变量 |
| 间距 | 药丸左右各内缩 2px → 视觉 4px |
| 操作列 | 16px 槽位保留（不引入 24px 覆盖层 + 渐变，收益小、复杂度高） |
| 文字 | 非活动 = `color-mix(in srgb, var(--fg) 50%, transparent)` |

- 需要**新增主题变量**（浅/深各一套）：`--tab-bg-active` / `--tab-bg-hover`（非活动底可透明）。
- 改动点：`global.css` 的 `.tab` / `.tab-active` / `.tab:hover` / `.panel-tabstrip` / `.tab-insert`；
  `splitview.ts` 里 `.tab-insert` 的 `top/bottom`（因为标签从 24px 变 20px）——**必须同步**。
- 风险：**中**。三个已知雷点见下。
- 收益：这才是"最新版 VS Code 的样子"，且总高不变。

### 方案 C · Connected 接通（在 B 之上叠加）

对齐 1.3 节：活动标签变成"cap"向下接通编辑区 + 左右两个凹圆角填角 + 编辑区 1px 轮廓。

- 需要**给编辑区加轮廓**（LitePad 现在没有）→ 分屏时每块面板要有自己的轮廓，且与面板操作栏、状态栏、分隔条不打架。
- 凹圆角用两个小方块 + 双边描边 + `border-radius` 实现，**WebView2 上必须实测**（这是本方案唯一的不确定点）。
- 风险：**高**（涉及分屏、浅色/深色、焦点面板降级三态）。
- 收益：视觉最强，但 LitePad 是"文档编辑器"不是 IDE 外壳，编辑区轮廓会挤压本已紧凑的布局。

---

## 4. 风险预演（动手前先想"上线后最可能挂在哪"）

1. **`.tab-insert` 定位**：它靠 `top/bottom` 对齐标签行，且 `stripInsertInfo` 依赖 `+ strip.scrollLeft`。
   标签高度一变就必须同步改 `top/bottom`，否则拖拽落点线错位。
   ⚠️ 现有回归用例只覆盖了 `scrollLeft` 那一半，**高度这一半没有守护** → 本方案要补断言。
2. **`.tab-flash` 关键帧写死了结束态 `background: var(--bg)`**：药丸化后必须改成新变量，
   否则"点标签闪一下"闪完会回到旧配色（一帧视觉 bug，脚本测不出来，只能靠断言写死）。
3. **`.tab-action` 16px 槽位与 `padding-right` 耦合**：药丸方案把 `padding` 从 `0 6px 0 10px` 改为对称值后，
   `min-width: 60px` 要一起复核，否则 3 个汉字文件名会被 × 挤掉。
4. **非活动面板降亮度**：`.layout-panel:not(.layout-panel-active) .tab-active` 现在是"背景透明 + 文字变灰"，
   药丸化后要改成"药丸底色降一档 + 文字变灰"，否则**分屏时活动标签的药丸仍在发亮**，焦点判断反而变差。
5. **标签栏高度与滚动条余量**：B53 留下的"恒定预留"不变量不能破坏；方案 B 把 2px 塞进 4px 间距里，
   正好把这条不变量的成因消掉——但要确认"溢出↔不溢出"不再有 2px 跳变。
6. **浅色主题**：新增变量必须两套齐补；`color-mix` 在 WebView2（Chromium）可用，但浅色下 50% 前景可能偏淡，
   需要实测调参。
7. **性能**：与本改动无关（纯 CSS + 少量 DOM 类名），无风险。

## 5. 验收标准

- 视觉：与 VS Code 1.137 Modern UI（或 Connected）**并排截图比对**，标签高度 / 药丸间距 / 描边一致；
- 六态正确：活动、非活动、悬停、脏、焦点面板降级、切换闪一下；
- 分屏 2×2 下每块面板表现正确（不做 Connected 则只查降级）；
- 溢出滚动正常，且「溢出 ↔ 不溢出」标签栏高度**不跳变**；
- 浅色 + 深色各一张截图；
- 回归：`299 vitest + 22 cargo` 全绿；新增静态断言锁定几何与配色变量；构出 exe + NSIS。
- ⚠️ 截图与视觉确认**必须在桌面环境**完成（沙箱内 WebView2 起不来）。

## 6. 待确认（M-S-C）

| 优先级 | 问题 | 备选 |
| --- | --- | --- |
| Must | 对标哪一版？ | ① B 药丸（推荐）② C Connected ③ A 保守 |
| Should | 若选 B，接受药丸高 **20px**（总高不变）还是 24px（总高 28→32px）？ | 20px 推荐 |
| Should | 活动标签的 × 是否常显？ | 常显（对齐 VS Code） |
| Could | 是否顺带做固定标签（pinned，28px sticky）？ | 建议单独立项 |
| Could | 是否引入 overlay 滚动条替代现在的 2px 自绘？ | 建议不做（B53 已评估：为 2px 引入自绘指示条 + 指针拖拽不划算） |
