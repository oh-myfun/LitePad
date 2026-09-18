# ADR 0073：设了 `display:flex` 的元素，`hidden` 属性会失效

- **状态**：Accepted
- **域**：样式 / 显隐
- **来源**：B73（前两次：B30 查找栏、B58 提示层）；B76 补「不需要补这条规则」的反例判据
- **关联**：`ref/architecture-detail.md` §6「隐藏元素陷阱」、§7「查找/替换」；
  守卫 `tests/regressions.test.ts` 的 B30 / B58 / B73 块

## 背景（Context）
`.find-row-replace` 是折叠替换行：`setReplaceExpanded(on)` 里置 `rowReplace.hidden = !on`，
默认应折叠。实测**折叠无效**——替换行永远露在浮层外面，chevron 形同虚设。
不报错，`hidden` 属性也确实变成了 `true`，只是「看不见效果」。

同一症状在本项目已出现三次，每次都要从头猜一遍：
1. **B30**：`.find-bar` 关不掉（`close()` 置 `hidden=true` 后浮层仍在）。
2. **B58**：提示层的 `.tooltip-key` 没有快捷键时多出一块空白。
3. **B73**：`.find-row-replace` 折叠不掉。

## 根因（Root Cause）
`hidden` 属性**不是**浏览器里最高优先级的隐藏机制，它只是 UA 样式表里一条
**`[hidden] { display: none }`**，特异度极低。因此作者样式里任何一条给该元素设
`display` 非 `none` 的规则（`.find-row { display: flex }` 这类）都会把它盖掉：

| 选择器 | 特异度 |
|---|---|
| `[hidden]`（UA） | (0,1,0) |
| `.find-row`（作者） | **(0,1,0)**，但作者样式同特异度下**恒胜 UA 样式** |

→ 元素照旧 `display: flex`，`hidden` 属性形同虚设。**这是规范行为，不是浏览器 bug**。

## 决策（Decision）
**凡是给元素设了 `display` 非 `none` 的类，必须紧邻着再写一条
`<选择器>[hidden] { display: none }`**（特异度更高的 `[hidden]` 版本反过来盖回去）。

- 已写的三处：`.find-bar[hidden]`、`.tooltip-key[hidden]`/`.tooltip-detail[hidden]`、
  `.find-row-replace[hidden]`。
- 排查口诀：**「属性是 true，但看起来没隐藏」→ 先查该元素的 `display` 作者样式**，
  别去查 JS 有没有置位（置位通常是好的）。
- ⚠️ **反例：不需要补的情况**（B76 补）——元素本身是**普通块级**、没有任何作者样式给它设
  `display` 时，UA 的 `[hidden]` 照常生效，**别画蛇添足**。B76 的 `.find-status` 就是这种：
  它只有 `font-size` / `color` / `min-height`，故 `status.hidden = true` 直接生效。
  ⇒ 判断顺序：**先看该元素自己（或命中它的类）有没有设 `display`，没有就不用补这条规则**；
  反过来，「补了没坏处」是错的 —— 无谓的 `[hidden]{display:none}` 会掩盖真实原因。
- `regressions.test.ts` 里对应断言用正则匹配**整块规则**（`/[^}]*display:\s*none/`），
  而不是只 `toContain("display: none")`——后者会被文件里其它 `display:none` 假绿。

## 后果与守卫（Consequences）
- 症状恒为**静默**：不报错、属性正确，只是视觉没生效；用 DOM 单测查 `hidden === true` 会**假绿**。
  ⚠️ B73 首轮就踩了这个：`findbar.test.ts` 里断言 `rowReplace.hidden === true` 的用例
  在缺陷还原后**仍然通过**——判据得落在「默认态由 `setReplaceExpanded` 决定」与
  「CSS 规则存在」两处，不能只信属性值。
- 静态守卫：`tests/regressions.test.ts` 的 B73 块断言
  `.find-row-replace[hidden] { … display: none }` 存在且完整。
- 反向验证：`scripts/reverse-verify-b73.cjs` 中「折叠替换行丢失 [hidden] 覆盖」一条
  （**必须整块移除**才能让断言变红，只删 `display:none` 会被同文件的其它规则兜住）。
- 新增浮层/折叠区时照抄这条模式；浅色深色无关，纯 CSS 特异性问题。
