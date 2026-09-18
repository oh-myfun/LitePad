# 0075 · CSS 注释里出现 `*/` 会提前闭合注释（并连带打穿静态守卫）

- 状态：已决策
- 日期：2026-09-18
- 触发交付：B77（查找栏外观对齐 VS Code）
- 相关：`src/styles/global.css`、`tests/regressions.test.ts`、`rules/index.md`（视图 / 样式）、
  `pitfalls/0073-hidden-vs-display-flex.md`

> ⚠️ **本条不是新发现**：`rules/index.md` 的「视图 / 样式」一节**早有红线**「CSS 注释禁 `*/`」
> （引入于 `6654b51`，与本条同源）。本次是**违反了既存约束**，所以本条的重点不在「有这个坑」，
> 而在**它长什么样**（报错位置极误导）、**谁会拦住**（CI 的 prettier），以及**同一根因的第二种
> 破坏方式**（打穿静态守卫，此前从未记录）。

## 背景

给查找栏新增两档悬停色令牌时，顺手写了条注释，说明「工具栏按钮与输入框内开关用的**不是同一个值**」，
并在注释里列出开关的字形清单：`（Aa/ab/.*/选区/AB）`。

## 根因

CSS 注释**不能嵌套**，且以**第一个** `*/` 结束。`.*` 的星号紧跟一个 `/`，正好拼出注释结束符：

```css
/* 输入框内开关（Aa / ab / .*/ 选区 / AB）走 inputOption.hoverBackground */
                              ↑ 注释在这里就结束了
```

于是同一行剩下的 `选区 / AB）走 inputOption.hoverBackground` 被当成 CSS 代码解析。
报错位置很坑人 —— 它指向注释**中间**那一列：

```
CssSyntaxError: Unknown word inputOption.hoverBackground (61:30)
```

容易误判成 prettier 抽风，而不是「注释早闭了」。

## 同一处根因还打穿了静态守卫（更要紧）

同一批改动里，主题变量块是这样取的：

```ts
css.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/)   // ← [^}]* 遇到第一个 } 就停
```

我在深色块里写了注释 `inputOption.active{Background,Border,Foreground}` —— 注释里的 `}` 让
`[^}]*` **从那里截断**，块内后面所有 `--tip-*` 全被判「缺失」，测试假红。

危险的是反方向：若断言写的是 `not.toContain` / `not.toMatch`，截断会让它**静默通过**（假绿）——
一条看起来在守护、其实什么都没看的守卫。

## 决策

1. **CSS 注释里不得出现「点 · 星号 · 斜杠」连排的字面量**（`*/` 亦同）。要点名 `.*` 时写成
   「`.*` 正则」或「点星号」，别让它紧挨斜杠。
2. 主题块 / 规则块提取一律改成「**先剥注释、再按花括号配对计数**」：
   `themeBlock(css, theme)`、`ruleBlock(css, selector, filter?)`，不要再用 `\{[^}]*\}`。
3. 新写的守卫一律用 `ruleBlock`；`ruleBlock` 的第三参支持按「块体里含某声明」选，避免数序号。

## 后果与守卫

- 注释早闭这类语法错误由 `prettier --check`（CI 的 Format + lint 步）拦住 —— 报 `Unknown word` 时
  **先怀疑注释里有 `*/`**，别急着怀疑 prettier。也就是说**这条红线实际由 CI 兜底**，
  本地 `tsc` / `vitest` 都不看 CSS 语法，光跑它们会一路绿到推送。
- 守卫侧：B77 用例 + 8 条反向验证探针（见当日记）。`themeBlock` / `ruleBlock` 都带注释剥除，
  注释里写花括号不再影响取值。
- **流程教训**：这条红线写在 `rules/index.md`，而该目录**不在每次会话自动加载**（只有 `MEMORY.md`
  会被整篇注入）。约束放在「按需读取」的文件里，就注定会被违反 —— 要么把它提到 `MEMORY.md` 的
  红线子集，要么承认它靠 CI 兜底、并在动手写 CSS 前主动去读 `rules/index.md`。
- ⚠️ **残留**：`tests/regressions.test.ts` 还有约 46 处旧的 `\{[^}]*\}` 提取点未迁移
  （其中带 `not.toContain` 的属可假绿档），已记入 `open-items/backlog.md`。
