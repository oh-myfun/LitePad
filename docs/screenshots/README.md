# 界面截图

本目录只保存**一张**截图 `main.png`，供根 `README.md` 开头展示
（`docs/conventions.md`：README 使用者向，开头只放一张 `main.png`）。
图片由 `scripts/capture-screenshots.py` 驱动**真实运行的 LitePad** 抓取，不含手绘、拼接或后期修饰。

## ⚠️ 维护约定（硬性）

**任何会改变界面观感的改动，必须在同一个提交里同步刷新 `main.png`。**

需要刷新的情形包括但不限于：

- 新增 / 修改 / 删除功能，菜单项、标题栏、状态栏信息项发生变化
- 配色、字体、行距、圆角、图标、间距等视觉样式调整
- 标签栏、分屏、标题栏、状态栏等布局行为变化
- 应用更名、图标更换、版本号变更导致窗口标题变化

理由：截图是面向用户的文档，一张过期截图会直接误导使用者，且与发布版本不一致。
**代码合并前请确认 `docs/screenshots/main.png` 与当前界面一致**；若确实不影响观感，
在提交信息里注明「界面无变化」。

## 当前截图

| 文件 | 内容 |
| --- | --- |
| `main.png` | 主界面：左右分屏，左侧 Markdown 源码（三个标签）+ 右侧实时预览（深色主题） |

约定（与配方一致，改配方就改这里）：1600×1000、深色主题、左面板活动标签 `example.md`
且光标在第 8 行、右面板同一文件的预览。

## 怎么拍

```sh
bash scripts/shot.sh                 # 拍 main（唯一入口，自带所需环境）
bash scripts/shot.sh --list          # 看有哪些配方
bash scripts/shot.sh --size 1440x900
bash scripts/shot.sh --inset 1       # 圆角混进桌面时四边各切 1px
```

> 为什么不直接调 `python scripts/capture-screenshots.py`：那一层要自带
> `CODEBUDDY_SAFE_DELETE_ENABLED=0` 与正确的 python 路径，两件都在会话里手敲过，
> 漏一件不会报错、只会让截图停在旧图。入口统一到 `scripts/shot.sh`。

**演示会话是隔离的**：脚本通过 `LITEPAD_CONFIG_DIR` 把应用指向项目内的
`.tmp/shot/config`，你自己的配置（`%APPDATA%\LitePad`）**一次都不会被写**——
只读取其中的字号/字体当底稿。拍完也不需要「还原」这一步。

前提：`src-tauri/target/release/litepad.exe` 要存在（先 `npm run tauri -- build`）。

脚本一条龙做完这些事，**每一步都是踩过坑才加的**：

1. **备份真实会话**到 `.tmp/screenshot-backup/`，写一份演示 `session.json` / `settings.json`；
2. **先杀干净旧实例再写演示配置**。反过来的话，正在退出的旧实例会把自己的会话写回来，
   把演示配置覆盖掉 —— 表现是「新实例启动了，但一直没有内容」（窗口标题停在裸 `LitePad`）；
3. **清 WebView2 用户数据**（`%LOCALAPPDATA%\com.litepad.app\EBWebView` 挪走一份）。
   硬杀留下的孤儿 `msedgewebview2.exe` 会占住这个目录，新 webview 起不来；
4. **起 app，等窗口标题变成 `LitePad - example.md` 才抓图**。标题还是裸 `LitePad`
   说明会话没恢复，这时候抓到的就是一张全黑图；
5. 抓图前把**系统光标挪到窗口之外**（否则会被一起拍进去）、用 `AttachThreadInput`
   **抢前台**（裸 `SetForegroundWindow` 会被焦点窃取防护静默拒掉，这是「经常失败」的根因）；
6. **只抓窗口的可见外框**（DWM `DWMWA_EXTENDED_FRAME_BOUNDS`）。`GetWindowRect` 会把
   Win10/11 那圈**不可见**的调整边框（左右下各约 8px）算进去，按它抓就会在图四周留一圈
   桌面背景；
7. 抓到图后做**空白自检**：PNG 压缩后小于 0.04 字节/像素（实测全黑图约 0.011、正常界面约
   0.13）就报错退出，**不写出**，免得白图进仓库；
8. 最后杀进程并**原样还原真实会话**。

配方的演示状态（哪个文件、什么主题、要不要点菜单）写在脚本顶部的 `RECIPES` 里。
要补拍「设置 → 首选项…」这类弹窗，加一条 recipe 并用 `clicks` 摆状态即可，注释里有菜单栏
按钮的实测坐标与示例。

## 为什么不用 CDP

试过走 CDP（`Page.captureScreenshot`）：它让**页面自己**合成视口，因此不含系统标题栏、
不受遮挡影响、也不依赖前台焦点，理论上比抓屏干净。但在本机的沙箱会话里这条路不通：

- 调试端口能打开、`/devtools` 能列目标，但页面**停在 `about:blank`** 不导航，渲染进程随即消失；
- 渲染进程活着时执行 `Page.captureScreenshot` 也不返回（连接被重置）。

顺带排掉的两条路：`PrintWindow(PW_RENDERFULLCONTENT)` 抓不到 WebView2 的合成画面
（内容区全黑，只有窗口边框）；注册表策略 `HKCU\Software\Policies\Microsoft\Edge\WebView2\
AdditionalBrowserArguments` 写不进去（`New-Item` 报成功但 `Test-Path` 仍是 false）。

所以最终只保留 BitBlt 这一套（`scripts/cdp-shot.mjs`、`scripts/capture-screenshots.mjs`
已删除）。代价是**图里含系统标题栏**，换来的是在任何有桌面会话的机器上都能一条命令重拍。

## 拍完检查

- `git status docs/screenshots/` 只应有 `main.png` 的改动；
- 打开看一眼：**四边没有桌面背景**、没有鼠标、没有半截别的窗口、内容不是全黑；
- 真实 `session.json` / `settings.json` 已还原（脚本结尾会打印一行确认）。

## 排错

1. **抓到全黑**：窗口标题是否已变成 `LitePad - <文件名>` 再抓；加大 `--settle`；
   确认演示会话引用的文件真实存在（路径常量在脚本顶部）。
2. **webview 起不来（白窗）**：任务管理器里确认 `litepad.exe` 与 `msedgewebview2.exe`
   都没了（硬杀会留孤儿进程占住用户数据目录）；`EBWebView` 挪走即可，纯缓存会自动重建
   （脚本每次启动前都会做）。
3. **边上还有一小圈桌面背景**：圆角窗口的角落会混进背景，加 `--inset 1`。
4. **菜单点不开**：本机**合成键盘事件到不了 WebView2**（Alt+S 助记符无效），只能用鼠标
   点击；菜单栏按钮坐标随字体/缩放变化，用 `--shot-each .tmp/step-%d.png` 逐步截图重测。

## 注意

- 会话恢复相关字段若出现「重启后光标回到第 1 行 / 预览模式丢失」，多半是 Rust `TabSession`
  的 serde 命名与前端不一致（详见 `.workbuddy/memory/ref/architecture-detail.md`），
  而不是截图脚本的问题。
- 本机显示缩放为 150%，`--size` 按**物理像素**处理，所以成品就是 1600×1000。
- 演示会话引用的文件路径必须真实存在，否则会话恢复会开出一个错误标签；
  换机器前先改 `scripts/capture-screenshots.py` 顶部那几个路径常量。
