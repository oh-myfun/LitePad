# pitfalls/ — 踩坑记录（ADR 式）

> 每条一个原子文件，按「域 + 序号」命名：`<NNNN>-<slug>.md`。
> 格式沿用 Nygard ADR：背景 / 根因 / 决策 / 后果与守卫。
> 按需读取；路由总表见 `MEMORY.md`。领域不变量见 `ref/`，约束目录见 `rules/index.md`。

| 编号 | slug | 一句话 |
|---|---|---|
| 0072 | webview2-shared-env | 卫星窗口须照抄主窗口 WebView2 浏览器参数，否则建不出窗口 |
| 0073 | hidden-vs-display-flex | 设了 `display:flex` 的元素，`hidden` 属性被盖掉（静默失效，已踩三次） |

新增踩坑时：在对应 `ref/<domain>.md` 的原文处替换为指向本目录某记录的指针，并新建一条
`<NNNN>-<slug>.md`（序号取 B 编号，slug 用 kebab-case 概括根因）。
