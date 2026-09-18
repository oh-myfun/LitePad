# ADR 0072：卫星窗口必须照抄主窗口的 WebView2 浏览器参数

- **状态**：Accepted
- **域**：多窗口 / 窗口创建
- **来源**：B72
- **关联**：`ref/multiwindow.md` §9.4；守卫 `tests/regressions.test.ts`「B72…」块（4 条）

## 背景（Context）
新增卫星窗口后，拖出标签时状态栏只留下一句「新窗口没能打开，标签保留在原窗口」，
窗口根本建不出来。不报错、不崩，只静默失败。

## 根因（Root Cause）
1. Windows 的 WebView2 **按 user data 目录共享同一个环境**；Tauri 强制同一 app 下所有
   `windows` 用同一目录（`%LOCALAPPDATA%\<identifier>`，见 `tauri/src/manager/webview.rs`
   的「in `windows`, we need to force a data_directory」）。
2. MS Learn `CoreWebView2Environment` 明写：**user data 目录相同时，若 Environment 的
   `CoreWebView2EnvironmentOptions` 不一致，WebView 创建失败**（对应
   `0x8007139F` `ERROR_INVALID_STATE`，见 WebView2Feedback#257）。
3. 主窗口的参数来自 `tauri.conf.json` 的 `additionalBrowserArgs`（本项目含 `--disable-gpu`），
   而 `WebviewWindowBuilder::new(...)` **不继承**它 → 卫星窗口落到 wry 默认值 → 与已在跑的
   主窗口环境参数分叉 → 创建被拒。

## 决策（Decision）
`windows.rs::shared_browser_args()` 从**运行时 `app.config()`** 读 `main` 条目的
`additional_browser_args` 喂给 `build_satellite`。
- ⚠️ **别写死 `--disable-gpu`** —— 配置将来一改两边又分叉；取不到（没配）就返回 `None`，
  全体回落 wry 默认值（仍然一致）。`main.rs` setup 里有启动自检
  `smoke_log("browser args = …")` 可直接核。
- 建窗失败的**原因必须原样带出**（`satellite-failed` 载荷从 `e` 改成 `e.to_string()`，
  状态栏渲染成「新窗口没能打开:<原因>」）：只报「没能打开」的话，下一次同类故障又要从头猜。

## 后果与守卫（Consequences）
- 不照抄的表现是**根本建不出窗口**，状态栏只留一句失败提示；不报错、不崩。
- 同不变量由 `tests/regressions.test.ts` 的「B72 卫星窗口必须照抄主窗口的 WebView2
  浏览器参数」锁住（4 条：不写死字面量 / 从 `app.config()` 取 / 喂给 builder / 原因回传）。
- 改 `tauri.conf.json` 的 `additionalBrowserArgs` 或窗口创建逻辑时，必须先确认卫星窗口仍能正常建出。
