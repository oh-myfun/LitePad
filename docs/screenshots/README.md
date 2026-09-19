# 界面截图

本目录保存 README 与文档引用的界面截图。所有图片都由 `scripts/capture-screenshots.mjs`
驱动**真实运行的 LitePad**、经 CDP（Chrome DevTools Protocol）让页面自己渲染出图的，
不含手绘、拼接或后期修饰。

## ⚠️ 维护约定（硬性）

**任何会改变界面观感的改动，必须在同一个提交里同步刷新受影响的截图。**

需要刷新截图的情形包括但不限于：

- 新增 / 修改 / 删除功能，菜单项、工具栏按钮、状态栏信息项发生变化
- 对话框（首选项、快捷键等）的内容或排版变化
- 配色、字体、行距、圆角、图标、间距等视觉样式调整
- 标签栏、分屏、大纲、查找栏等布局行为变化
- 应用更名、图标更换、版本号变更导致窗口标题变化

理由：截图是面向用户的文档，一张过期截图会直接误导使用者，且与发布版本不一致。
**代码合并前请确认 `docs/screenshots/` 与当前界面一致**；若确实不影响观感，在提交信息里注明「界面无变化」。

尚未有截图覆盖、但值得补拍的界面状态：大纲 TOC 抽屉、查找替换悬浮栏、命令面板、
标签溢出的横向滚动、浅色 / 深色主题对照、导出的 HTML 效果、
**悬停提示（tooltip，B58 起为自绘层）**。
（原先这里的「标签栏折叠下拉」已随 B53 删除，不要再拍。）

> ⚠️ **查找替换悬浮栏已按 VS Code 重做外观（B77）并补齐交互（B78）**：折叠态约 34px、
> 扁平图标按钮、输入框内嵌开关、两档悬停色；B78 起左缘还有一条 4px 宽度调节手柄、
> 「在选区中查找」位于上下箭头之后（与「所有打开的文档」互斥）、跨文档结果区常驻
> （空态显示「无结果」），详见 `src/styles/global.css` 的「悬浮查找 / 替换栏」一节。
> 补拍时请以 B78 之后的版本为准 —— 此前任何查找栏截图都已过期。
> 现有四张截图（`main.png` 等）**都没有打开查找栏**（它是浮层、默认关闭），故 B77/B78 均不受影响。

## 当前截图

| 文件 | 内容 |
| --- | --- |
| `main.png` | 主界面：左右分屏，左侧 Markdown 源码、右侧实时预览（深色主题） |
| `preferences.png` | 设置 → 首选项 弹窗：外观 / 字体与行距 / 编辑器 / Markdown 预览 |
| `keymap.png` | 设置 → 快捷键 面板：搜索过滤、分组列表、可改绑键位 |
| `code-light.png` | 浅色主题下的代码视图：多标签、TypeScript 语法高亮、代码折叠 |

⚠️ **待重拍（B79 改了工具栏主题按钮）**：`main.png`。
B79 起主题按钮三档一律不点亮（删掉了「只有深色档顶着色块」那个写死的激活态），
而 `main.png` 是深色主题、工具栏上正好有这颗按钮 —— 现图仍是旧观感。
四张图**未随 B79 一起重拍**，原因见下面「已知问题」。

> B58 把提示换成了自绘层（原生 `title` 已弃用），但**提示只在悬停时出现，静态截图不受影响**，
> 所以 `main.png` 那几张不必因此重拍；想展示提示效果可另拍一张 `tooltip.png`（悬停工具栏或标签）。

## 为什么不再用「截屏幕」

以前是 `python scripts/screenshot.py`：`SetForegroundWindow(窗口)` → `BitBlt(屏幕 DC, 窗口矩形)`，
也就是**对着屏幕那一块位置抄像素**。三个毛病是这条路本身决定的：

1. 鼠标只要停在那块区域里，就会被一起拍进去；
2. 窗口没抢到前台（Windows 的焦点窃取防护会让 `SetForegroundWindow` 静默失败）就拍到别的窗口，
   表现为「经常失败」；
3. 抓的是屏幕，所以桌面背景、压在窗口上的别的窗口都可能混进来。

现在改成 CDP：`Page.captureScreenshot` 是让**页面自己**把视口合成出来再返回 base64 ——
没有系统光标、没有遮挡窗口、不依赖前台焦点，因而可重复、可脚本化。
（`scripts/screenshot.py` 仍留在仓库里做兜底，但补拍请走下面的流程。）

## 如何刷新

### 1. 打开 WebView2 的调试端口

Tauri 在 `tauri.conf.json` 里显式设了 `additionalBrowserArgs`，**它会盖掉**
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量。所以要么把端口写进配置再构建，
要么让环境变量生效 —— 推荐后者（配置保持出厂态，端口只活在这次构建里）：

```bash
# 构建一份「不传浏览器参数」的临时变体（--no-bundle 跳过 NSIS 打包）
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle \
  --config '{"build":{"beforeBuildCommand":""},
             "app":{"windows":[{"label":"main","additionalBrowserArgs":null}]}}'
```

> 直接改 `tauri.conf.json` 加 `--remote-debugging-port` 也能通，但那样**发布版 exe 也带着
> 调试端口**，不要这么干。

### 2. 一键重拍

```bash
node scripts/capture-screenshots.mjs            # 全部四张
node scripts/capture-screenshots.mjs main keymap # 只拍指定几张
node scripts/capture-screenshots.mjs --size 1440x900
```

它会：把 WebView2 的用户数据目录挪走一份 → 写入演示 `session.json` / `settings.json`
（**真实会话先备份到 `.tmp/screenshot-backup/`**）→ 带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
启动 exe → 需要开对话框的配方用页内脚本点菜单 → 抓图 → 最后杀进程并**原样还原真实会话**。

配方的演示状态（哪个文件、什么主题、要不要开对话框）都写在脚本顶部的 `RECIPES` 里，
要加一张新截图就往里加一条。四张图的配方：

| 配方 | 状态 |
| --- | --- |
| `main` | 深色；左面板 `example.md`(源码) + `.ts` + `.json` 三个标签，右面板 `example.md`(预览) |
| `code-light` | 浅色；单面板，`findbar.ts`(活动) + `codicons.ts` + `tauri.conf.json` |
| `preferences` | 深色；点「设置 → 首选项…」 |
| `keymap` | 深色；点「设置 → 快捷键…」 |

只拍单张、或要自己控制状态时，直接用底层引擎（它只负责「连上 → 定视口 → 抓图」）：

```bash
node scripts/cdp-shot.mjs --out docs/screenshots/main.png --size 1600x1000 \
    --eval "document.getElementById('btn-theme').click()"
node scripts/cdp-shot.mjs --list          # 列 CDP 目标，排查用
```

- `--size` 是**输出图片的像素尺寸**，默认走视口模拟（`Emulation.setDeviceMetricsOverride`）
  定死，不动系统窗口 —— 实测 `Browser.setWindowBounds` 会让 WebView2 渲染进程直接崩，
  所以默认不碰窗口（代价：图里不含系统标题栏）。想要带标题栏的真窗口可加 `--mode window`。
- `--eval` 是抓图前在页面里执行的 JS，用来摆出静态截图需要的那一下点击。

### 3. 拍完检查

- `git status docs/screenshots/` 应该只多了你要的那几张；
- 打开看一眼：没有鼠标、没有桌面背景、没有半截别的窗口；
- 真实 `session.json` / `settings.json` 已还原（脚本会在结尾打印一行确认）。

## 已知问题（本沙箱环境实测）

在 WorkBuddy 会话沙箱里，**开调试端口后 WebView2 会起不来或随即崩掉**：

- CDP 端口能打开、`/json/list` 能列出目标，但页面**停在 `about:blank`** 不导航，
  紧接着渲染进程消失；
- 渲染进程活着时执行 `Page.captureScreenshot` 也不返回（连接被重置）。

顺带排掉的两条路：`PrintWindow(PW_RENDERFULLCONTENT)` 抓不到 WebView2 的合成画面
（内容区全黑，只有窗口边框）；注册表策略 `HKCU\Software\Policies\Microsoft\Edge\
WebView2\AdditionalBrowserArguments` 在本沙箱里写不进去（`New-Item` 报成功但 `Test-Path` 仍是 false）。

**处置**：`capture-screenshots.mjs` / `cdp-shot.mjs` 保留并经静态检查；四张图**未重拍**，
需要在不受该限制的桌面会话里跑一次第 2 步。别再回到 `screenshot.py` 当主力 ——
它的三个毛病是方法本身的。

### 重拍失败时先做这三件事

1. **关干净**：任务管理器里确认 `litepad.exe` 与它的 `msedgewebview2.exe` 子进程都没了。
   硬杀（`taskkill /F`）会留下孤儿 webview 进程占住用户数据目录 —— 这是本机最常见的
   「webview 起不来」原因（`DESIGN.md` 的「WebView2 browser 进程复用陷阱」记的就是它）；
2. **挪走用户数据**：`%LOCALAPPDATA%\com.litepad.app\EBWebView` 改名即可（纯缓存，
   删了会自动重建；`capture-screenshots.mjs` 每次启动前都会自动做这一步）；
3. **确认端口**：`node scripts/cdp-shot.mjs --list` 能列出 `page` 目标才算通了。

## 注意

- 会话与会话恢复相关字段若出现「重启后光标回到第 1 行 / 预览模式丢失」，
  多半是 Rust `TabSession` 的 serde 命名与前端不一致（详见 `.workbuddy/memory/ref/architecture-detail.md`），
  而不是截图脚本的问题。
- 本机显示缩放为 150%。CDP 的 `--size` 按**物理像素**折算 CSS 视口
  （`round(像素 / devicePixelRatio)`），所以四张图仍是 1600×1000。
- 演示会话引用的文件路径必须真实存在，否则会话恢复会开出一个错误标签；
  换机器前先改 `capture-screenshots.mjs` 顶部那几个路径常量。
