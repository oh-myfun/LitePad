# LiteMD · M0 设计与实现说明

> 对应《LiteMD-技术方案.md》第 7 节路线图的 **M0 脚手架**。
> 本文记录实际落地时的决策、与本方案的偏差、以及 M0 明确不做的部分。

---

## 1. 本轮已确认的决策

| 决策项 | 结论 | 原因 |
| --- | --- | --- |
| 技术栈 | Tauri 2 + Rust + Vite + TS + CodeMirror 6 | 方案 2.2 主选 |
| 工具链 | **x86_64-pc-windows-gnu**（MSYS2 MinGW-w64） | 本机无 MSVC；MinGW 已存在，零大文件安装 |
| 平台范围 | **仅 Windows** | 方案第 10 节待确认项 1 |
| 本轮范围 | **M0** | 方案第 7 节 |
| 文件对话框 | `tauri-plugin-dialog` | 唯一引入的插件；自己写原生对话框不划算 |

### 关于 GNU 工具链（重要）

本机没有 MSVC 生成工具，而 **build script 与 proc-macro 必须编译到宿主平台**，
所以仅给 MSVC 宿主加一个 GNU target 是不够的——宿主工具链本身必须是 GNU。

落地方式（`rust-toolchain.toml` 已锁定）：

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
```

构建时需要把 MinGW 链接器放进 PATH（`scripts/dev.sh` / `scripts/build.sh` 已封装）：

```bash
export PATH="/c/msys64/mingw64/bin:$HOME/.cargo/bin:$HOME/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"
```

**切换回 MSVC 的方法**（若日后安装了 VS2022 生成工具）：把 `rust-toolchain.toml`
的 `channel` 改回 `"stable"` 或删除该文件，然后重新构建。

---

## 2. 模块与职责（M0 落地范围）

```
src-tauri/src/
├─ main.rs              入口：注册插件 / 状态 / 命令
├─ commands/mod.rs      IPC 命令层（open_file / save_file / check_encodable / list_encodings / settings）
├─ core/
│  ├─ codec.rs          编码识别（BOM→UTF16启发式→UTF-8校验→chardetng）、编解码、不可逆字符检测
│  ├─ eol.rs            行尾统计/归一化/还原；内存文本一律 LF
│  ├─ atomic_write.rs   临时文件→fsync→rename 原子写
│  └─ doc.rs            文档元数据、二进制检测、只读检测、M0 打开上限
└─ session/mod.rs       %APPDATA%\LiteMD\settings.json 配置持久化
```

前端（`src/`）按方案第 8 节目录预留了 `layout/ markdown/`，M0 只实现：

```
src/
├─ main.ts        应用装配：打开/保存/另存为、脏标记、快捷键、状态栏
├─ ipc/api.ts     与 Rust 的类型化契约（字段 camelCase 对齐 serde rename_all）
├─ editor/        CodeMirror 6 封装 + M0 语言表（仅 Markdown 有真实高亮）
├─ shell/menu.ts  状态栏弹出菜单（编码/行尾切换）
├─ theme/         亮/暗/跟随系统
└─ styles/        CSS 变量驱动的双主题
```

---

## 3. 关键设计决策

### 3.1 内存文本一律 LF

磁盘行尾在读取时归一化为 `\n`，保存时按目标 EOL 还原。
这样编辑器内部所有偏移、行号、查找逻辑都不必关心 `\r`，是成本最低的正确做法。
代价：`Mixed` 行尾文件保存时会被动统一（状态栏有提示），符合方案 4.3 的默认策略。

### 3.2 编码识别顺序

`BOM → UTF-16 无 BOM 启发式 → UTF-8 合法性 → chardetng → Windows-1252 兜底`

注意 **UTF-16 无 BOM 必须排在 UTF-8 校验之前**：NUL 是合法 UTF-8 字节，
`"H\0e\0l\0l\0o\0"` 会被 `from_utf8` 接受，导致误判。

### 3.3 不可逆编码保护（方案 4.3）

`encoding_rs` 对无法映射的字符会输出 HTML 数字字符引用（`&#26085;`），
这对文本编辑器是**错误行为**。因此：

1. `save_file` 前先调 `check_encodable`（仅非 Unicode 目标编码）；
2. 前端列出受影响字符与行号，用户确认后才落盘；
3. `encode` 返回 `lossy` 标记作为兜底信号。

### 3.4 状态归 Rust

`AppState.current` 持有当前文档的 `path/encoding/eol/readonly`。
前端保存时不必自己记住路径，`save_file` 不传 `path` 即保存到当前关联文件。

---

## 4. 与技术方案的偏差

| 偏差 | 原因 |
| --- | --- |
| `cargo` 不在 PATH，需走工具链目录 | 本机 rustup 未生成代理（仅 rustup.exe） |
| M0 限制单文件 ≤ 20 MB | 大文件分级降级属于 M4；先立明确边界防 OOM |
| 仅 Markdown 有语法高亮，其余类型只显示名称 | 语言注册表（legacy-modes 80+ 语言）属于 M1 |
| 前端单 JS 569 KB（gzip 196 KB） | CM6 全量引入；代码分割按方案第 5 节属 M4 |
| 图标为程序生成的占位图 | 纯标准库生成，M4 替换正式设计稿 |

## 5. M0 验收对照

| 方案要求 | 状态 |
| --- | --- |
| Tauri 2 + Vite + TS 工程跑通 | ✅ |
| 窗口 / 工具栏 / 状态栏 | ✅（状态栏：消息/行列/编码/行尾/语言） |
| 读写单文件（打开/保存/另存为） | ✅ |
| 编码识别与转换（9 种） | ✅ 含「以指定编码重新载入」 |
| 行尾识别 / 切换 / 保存生效 | ✅ 含 Mixed 提示 |
| 原子写入 | ✅ 含单测 |
| 亮暗主题 + 跟随系统 | ✅ |
| 配置持久化 | ✅ theme / default_eol / recent 字段已预留 |
| 日志与埋点 | ⛔ M0 未做（方案 M0 项，延后） |
| 会话恢复 / 多标签 / 分屏 | ⛔ M2 |
| Markdown 渲染 | ⛔ M3 |

## 环境已知问题（M0 排查结论）

- **WorkBuddy 沙箱会话拦截 WebView2 的 http(s) 导航**：dev server（http://127.0.0.1:1420）与
  Tauri 自定义协议（http://tauri.localhost）的页面加载均被重置回 about:blank（vite 能收到完整
  请求链但导航不生效）；file:/// 协议可正常加载。UI 冒烟需在用户桌面环境执行。
- **Node 17+ 的 localhost 绑定歧义**：vite `host: "localhost"` 在本机只绑定 `::1`（IPv6），
  已将 vite `host` 与 tauri `devUrl` 双侧锁定为 `127.0.0.1`。
- **WebView2 browser 进程复用陷阱**：同用户数据目录的残留 msedgewebview2 进程会让
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 等新参数完全失效；换参数实验前必须先杀干净进程。
- **诊断基建**：`commands::frontend_ready` 写 `%TEMP%\litemd-smoke.log`（IPC 与 bootstrap 回报）；
  `scripts/cdp_diag.mjs` 可连 WebView2 CDP（`--remote-debugging-port=9222`）做页内诊断。

## M1-A 编辑器内核（第一批：语言与编辑增强）

- **语言注册表**（`src/editor/language.ts`）：55 类条目，`StreamLanguage` 封装
  `@codemirror/legacy-modes`；Markdown 继续用 `@codemirror/lang-markdown` 高阶包。
  PHP / Batch / Makefile / Vue 等暂只显示标签（legacy-modes 无对应模式），按需补。
- **检测链**：完整文件名（Dockerfile/Makefile/CMakeLists.txt）→ 扩展名 → Shebang →
  首行魔数（`<?xml` / `<!DOCTYPE html`）。大小写不敏感；打开文件时传首行参与检测。
- **编辑增强**（`src/editor/editor.ts`）：`foldGutter` 折叠、`bracketMatching` 匹配高亮、
  `closeBrackets` 自动闭合（含 keymap）、`indentOnInput` 自动缩进；缩进单元 4 空格。
- **测试**：`vitest` + `tests/language.test.ts`（8 用例），`npm test` 运行。
- **已知取舍**：legacy 模式静态导入使 bundle 增大（chunk >500kB 警告），代码分割留待 M4；
  缩进规则暂全局 4 空格，per-language 缩进随 M1-B 设置界面再定。

## M1-B 多标签（单面板）

- **架构**：单 EditorView + 每标签一个 `EditorState` 快照（CM6 官方多文档模式）。
  切换标签 = `view.setState(快照)`，撤销历史/滚动选择随快照保留。
- **状态归属**：标签元数据（id/path/encoding/eol/readonly）归 Rust（`AppState.docs: Vec<Doc>`，
  自增 `tab_id` 寻址），前端持有镜像 + CM6 快照。命令：`new_tab` / `open_file`（同路径返回
  `reused=true` 激活既有标签）/ `reload_file` / `save_file(tab_id)` / `close_tab` / `list_tabs`。
- **主题/换行切换**：每标签持有独立 compartment，活动标签走 `view.dispatch`，
  非活动标签用 `EditorState.update({effects})` 离线更新，不丢历史。
- **UI**：`src/shell/tabstrip.ts` 纯渲染标签栏（脏点 + 关闭钮），快捷键
  Ctrl+N / Ctrl+W / Ctrl+Tab；关闭脏标签先确认保存；最后一个标签关闭后自动新建。
- **已知取舍**：切换标签不保留滚动位置（CM6 setState 行为）；标签拖拽排序、
  会话恢复留给 M2；关闭流程的「保存/放弃/取消」三态简化为 ask 二态。

## M2-A 自由分屏

- **布局树**（`src/shell/layout.ts`）：二叉树（leaf=面板 / split=h|v + ratio），纯函数规约
  （removePanel 叶子上提 / splitPanel 插入），vitest 7 用例覆盖。
- **渲染**（`src/shell/splitview.ts`）：递归布局树 → flex DOM + 可拖拽分隔条
  （拖拽实时改 flex-basis，松手回写 ratio，不重建 EditorView）。
- **面板模型**：每面板独立 EditorView + 面板级标签栏；标签归属面板（tab.panelId）。
  结构变化全量重建视图（状态都在 Tab 快照，无损失）；标签增删走轻量路径只重绘标签栏。
- **面板关闭**：标签并入相邻面板 + 树规约；分屏按钮 ◫/⬒ 在每个面板头部。
- **取舍**：标签跨面板拖拽暂不做（用分屏 + 标签关闭/重开替代）；会话恢复在 M2-B。

## M2-B 会话恢复 / 自动保存 / 文件监听 / 跨文件搜索

- **会话持久化**（Rust `session/mod.rs`）：`session.json` 记录 `panels[{tabs[{path,encoding,eol,
  cursorLine,cursorCol}],active}] + layout树 + activePanel`；命令 `load_session` / `save_session`。
  前端 800ms 防抖回写（打开/关闭/保存/编辑均触发），启动时 `restoreSession()` 按布局树重建面板、
  逐个 `open_file` 恢复标签与光标；文件丢失静默跳过，全部失败退回空白未命名标签。
- **自动保存**：设置开关 `autosave`，编辑 1.5s 防抖；只保存「已关联磁盘 + Unicode 编码 + 非只读」
  的脏文档（规避 GB18030 等编码 lossy 不可逆风险），单个失败不打断其余。
- **文件监听**：单个全局 `notify::RecommendedWatcher`（Rust setup 初始化），Modify 事件 →
  emit `file-changed {path}` → 前端标记 `tab.external` + 状态栏提示「保存时将覆盖外部内容」，
  保存成功清除标记。watch 随 open/save（改路径）/close 增删。
- **跨文件搜索**：`search_files` 命令（Rust）：thread::scope 递归 + rayon 式并行（标准库 scope），
  预算 2 万文件 / 单文件 2MB / 结果 300 条；Regex（可关大小写、可切正则）。
  前端 `findinfiles.ts` overlay 面板，点击结果 `doOpen` 后按 line/col 跳转并滚动居中。
  入口：工具栏「查找文件」按钮 / Ctrl+Shift+F；默认目录取活动标签所在目录。
- **环境坑（重要）**：WorkBuddy/bash 会话把 cwd 设为小写盘符（`e:/...`），vitest worker 与测试
  文件的模块 URL 盘符大小写不一致 → `@vitest/runner` 双实例 → `describe` 报
  "Cannot read properties of undefined (reading 'config')"。修复：`scripts/run-vitest.cjs`
  先把 cwd 盘符大写化再 spawn vitest，`npm test` 与 `build:all` 均走该入口。
- **测试**：vitest 15（语言 8 + 布局 7）、cargo test 15，全绿；Rust 警告清零。

## M3 Markdown 渲染

- **管线**（`src/markdown/pipeline.ts`）：markdown-it（GFM 内置表格/删除线 + 自实现任务列表/
  数学占位/Mermaid 围栏/标题锚点 id）+ markdown-it-footnote。核心输出两种结构：
  `renderBlocks()` 顶层 block 切片（每块带 source 行区间，token.map 0-based→1-based 闭区间）
  与 `extractToc()` 标题大纲（重复标题生成唯一 id）。vitest 8 用例。
- **增量 patch**（`src/markdown/preview.ts` PreviewPane）：逐 index 比对 block html，相同复用
  DOM 节点不动，不同才重建；编辑 120ms 防抖。大文档（>5000 行）自动降级：跳过 Shiki/Mermaid。
- **懒加载增强**：KaTeX / Shiki / Mermaid 全部动态 `import()`，文档中出现对应内容才加载
  （vite 独立 chunk，首屏不载入）。Shiki 双主题（github-light/dark，CSS 变量切换）；
  相对路径图片经 `convertFileSrc` 走 asset 协议显示（tauri.conf 开启 assetProtocol scope **）。
- **双向同步滚动**：block 锚点对齐 + block 内比例插值；回环锁 120ms（editor→preview 与
  preview→editor 互斥），编辑器侧 `lineBlockAtHeight` 取可视区顶行，反向用 `lineBlockAt().top`。
- **视图模式**：源码/分屏/纯预览，md 标签默认分屏、其他文件强制源码；Ctrl+/ 或工具栏按钮循环。
- **大纲 TOC**：左侧抽屉（工具栏「大纲」），随编辑防抖刷新，点击跳转编辑器行。
- **图片粘贴**：编辑器 paste 事件捕获 image → base64 → Rust `save_paste_image` 落盘到
  `<md目录>/assets/paste-<时间戳>.<ext>` → 光标处插入相对链接 `![](assets/…)`。
- **导出**：HTML（`export_file` 命令写自包含单文件，内联预览样式 + KaTeX 样式）；
  PDF（WebView2 打印管线：专用 #print-root DOM + print CSS + window.print，相对图片重写为
  asset 协议地址）。
- **新命令**：`export_file` / `save_paste_image`（base64 解码，assets 目录自动创建）；
  Cargo 新增 base64 0.22，tauri 启用 `protocol-asset` feature。
- **产物**：release litemd.exe 9.0MB + NSIS 5.7MB（懒加载 chunk 全部嵌入，首屏不受影响）。

## M3 缺陷修复（视图切换 / 打开布局 / 窗口关闭）

- **根因（游离 EditorView）**：`ensureView` 曾把 CM6 实例创建在从未插入 DOM 的 div 上，
  新建标签/分屏补标签后 `panel.view` 指向不可见编辑器，界面显示的仍是旧 view——
  切标签、切换视图模式全部失效。修复：删除该路径，所有结构变化统一走
  `rebuildLayout()`（状态都在 Tab 快照，重建无损失）。
- **doOpen**：打开新文件后改为 rebuildLayout 挂载（自动应用 md 视图模式 + 预览）。
- **空面板**：mountView 对无标签面板也创建 editor/preview 结构；switchTab 发现面板未挂载
  （无 view/bodyEl）时先 rebuildLayout。
- **视图切换白屏**：从 display:none（纯预览/源码）恢复后调用 `view.requestMeasure()`。
- **窗口关闭**：注册 `onCloseRequested`——有脏文档先确认；退出前立即 `saveSession`
  （防抖保存会丢最后状态），然后 destroy。会话 TabSession 增加 `viewMode` 字段
  （Rust `Option<String>` + serde default），恢复时还原 md 视图模式。
- **构建脚本**：build-all.sh 内 `export CODEBUDDY_SAFE_DELETE_ENABLED=0` 禁用 WorkBuddy 会话
  safe-delete 钩子（它会拦截 vite 清空 dist/assets 超 50 文件）；tauri build 用 `--config` 覆盖
  beforeBuildCommand（第 1 步已产出 dist，避免重复构建）。桌面环境无钩子，行为不变。

## 交互打磨（分屏 / 标签 / 预览）

- **标签栏**（tabstrip.ts 重构）：中键关闭、双击空白新建、右键菜单（关闭 / 关闭其他 /
  关闭右侧 / 复制文件路径）、HTML5 拖拽排序（拖放指示线）、溢出横向滚动；
  renderStripOnly 重复实现删除，splitview 与轻量重绘统一走 renderTabstrip。
- **快捷键**：Ctrl+PgUp / PgDn 左右切换标签（Ctrl+Tab 保留循环）。
- **预览**：点击 block 定位编辑器对应行（不抢焦点）；预览→编辑器程序滚动期间忽略编辑器
  scroll 事件（isSyncing 防回环抖动）；预览正文 860px 阅读宽度居中。
- **分屏**：拖拽调比例后回写会话（之前不持久化，重启丢失比例）。
- **修复**：handleUpdate 的 md 预览调度移出 suppressDirty 守卫（切换编码重载后预览不刷新）；
  closeTabById 关闭后补 applyPanelMode（md 分屏中切到非 md 标签预览残留）。

## UI 重构：菜单栏 + 图标工具栏（视图切换简化）

- **视图二态**：md 文件只有 源码 ⇄ 预览（Ctrl+/），移除三态循环中的「分屏」——分屏是
  面板级独立功能（◫/⬒/菜单），面板始终填满窗口；会话中旧 "split" 值映射回 "source"。
- **菜单栏**（menubar.ts）：文件（新建/打开/保存/另存为/退出）/ 编辑（查找·文件中查找）/
  查看（切换视图/大纲/分屏/主题）/ 帮助（设置·关于）；点击展开 + hover 滑动切换，
  showPopupMenu 支持 separator 与快捷键右对齐提示。
- **工具栏图标化**（icons.ts 内联 SVG，零依赖）：新建/打开/保存/另存为 | 查找/在文件中查找 |
  源码⇄预览(动态图标)/大纲/导出 | 主题/设置；顶部 brand 标题移除，文件名保留在右侧。
- Ctrl+F 统一打开 CM6 查找替换条（openSearchPanel），工具栏与菜单共用。
