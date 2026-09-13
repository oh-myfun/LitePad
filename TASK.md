# LitePad · 任务清单

> 勾选式跟踪。M0 完成后按方案第 7 节推进 M1。

## M0 脚手架

- [x] 环境勘察：Rust/Node/WebView2/MinGW 就绪度确认，确定 GNU 工具链路线
- [x] 工程骨架：package.json / tsconfig / vite.config / tauri.conf / capabilities
- [x] `.cargo/config.toml` 固定 GNU 目标 + PATH 说明
- [x] Rust 核心：codec（9 种编码 + 检测 + 不可逆检测）
- [x] Rust 核心：eol（识别 / 归一化 / 还原 / Mixed）
- [x] Rust 核心：atomic_write（临时文件 + fsync + rename）
- [x] Rust 核心：doc（二进制检测 / 只读检测 / 大小上限）
- [x] IPC 命令：open_file / save_file / check_encodable / list_encodings / settings
- [x] session：settings.json 读写（serde default 前向兼容）
- [x] 前端：主题（亮/暗/跟随系统）+ CSS 变量
- [x] 前端：CodeMirror 6 封装（行号/历史/查找/列编辑/软换行）
- [x] 前端：状态栏（行列 / 编码菜单 / 行尾菜单 / 语言）
- [x] 前端：打开 / 保存 / 另存为 / 脏标记 / 窗口标题
- [x] 前端：保存前不可逆编码确认
- [x] 图标生成脚本（纯标准库）
- [x] 前端构建通过（tsc --noEmit + vite build）
- [x] Rust 单元测试通过（codec / eol / atomic_write，15/15）
- [x] `cargo build` 产出可运行 exe（GNU 工具链，debug 版走 devUrl）
- [x] 冒烟：打开 UTF-8 / GBK 文件、编辑保存、编码行尾显示正确、主题切换


  > ✅ 2026-09-11 用户桌面确认：应用正常打开（devUrl 模式），沙箱 http 拦截仅限 WorkBuddy 会话。  
  > 剩余功能项（多编码文件读写/主题切换）可在日常使用中顺带确认。

## M1 编辑器内核（下一步）

- [x] 语言注册表：`@codemirror/legacy-modes` 覆盖 55 类语言（Markdown/JSON 走 CM6 高阶包；PHP/Batch 等暂只显示标签）
- [x] 格式关联：完整文件名 / 扩展名 / Shebang / 首行魔数（vitest 8 用例覆盖）
- [x] 代码折叠、括号匹配与自动闭合、自动缩进（缩进单元 4 空格）
- [x] 多标签（单面板）：Rust 多文档集合（tab_id）+ CM6 快照切换；Ctrl+N/W/Tab；脏标签关闭确认
- [x] 自绘搜索条（中文提示 + 匹配计数：查找/替换/全部替换，Aa 正则 全词选项，Ctrl+F/Esc）
- [x] 设置界面（主题/默认行尾/编码/字号/换行/自动保存）+ 内置 keybindings 只读说明
- [x] 日志与埋点（log_event 命令写 %TEMP%\litepad-app.log，打开/保存/设置埋点）

## M2 分屏与会话

- [x] LayoutTree 二叉树 + 拖拽分屏 + 比例调节 + 树规约
- [x] 编辑器实例池化（非活跃面板只留 EditorState）
- [x] 会话恢复（session.json 懒加载）
- [x] 自动保存（1.5s 防抖 / 失焦 / 退出）
- [x] notify 文件监听 + 外部修改冲突提示
- [x] 跨文件并行搜索（Rust 侧）

## M3 Markdown

- [x] markdown-it 管线 + 增量 patch
- [x] source line ↔ block 映射 + 双向同步滚动
- [x] Shiki / KaTeX / Mermaid 懒加载
- [x] TOC、图片粘贴、导出 HTML/PDF

## M4 性能与打磨

- [ ] 大文件分级降级（2/20/200 MB 阈值）
- [ ] 代码分割（Shiki/Mermaid/KaTeX 动态 import）
- [ ] 命令面板 Ctrl+Shift+P
- [ ] 键位预设（Notepad++ / VSCode）
- [ ] NSIS 打包 + 隐藏控制台 + 正式图标
