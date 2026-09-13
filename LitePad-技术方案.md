# LitePad · 轻量 Markdown 文本编辑器技术方案

> 目标：一个**极度轻量、启动快、内存低**的文本编辑器，具备多标签 + 自由分屏 + 完善的 Markdown 渲染，用来替代 Notepad++，并砍掉其中低频功能。
> 版本：v1.0 草案 · 2026-09-10

---

## 1. 产品定位与功能取舍

<!-- ### 1.1 一句话定位 -->

"Notepad++ 的速度与体量 + Typora 的 Markdown 体验 + VSCode 的分屏与命令面板，但只保留 20% 的功能。"

### 1.2 功能清单（保留 / 精简 / 新增）

| 类别 | 保留（必须） | 精简（不做或弱化） | 新增（相对 Notepad++） |
| --- | --- | --- | --- |
| 编辑 | 多标签、语法高亮、代码折叠、软换行、列编辑（Alt+拖）、括号匹配、缩进、书签 | 宏录制、UDL 自定义语言、多实例模式 | 多光标、命令面板、智能缩进粘贴 |
| 文件 | 编码识别与转换、行尾切换、BOM、只读检测、大文件打开 | FTP/远程编辑、文件比较（交给外部 diff）、打印排版设置 | 原子写入、自动保存、外部修改检测与冲突提示、会话恢复 |
| 分屏 | 水平/垂直分屏 | 固定 2 分屏 | Xshell 式自由拖拽分屏、任意嵌套、比例拖拽、布局持久化 |
| 搜索 | 单文件查找替换（正则）、跨文件搜索 | 文件中批量替换的复杂 UI | 并行搜索、glob 过滤、结果虚拟列表、批量替换预览 |
| Markdown | — | — | 源码/分屏/纯预览三模式、实时增量渲染、双向同步滚动、大纲 TOC、Mermaid、KaTeX、表格、任务列表、图片粘贴、导出 HTML/PDF/DOCX |
| 其他 | 快捷键自定义、主题 | 插件体系、大量对话框式设置 | JSON 配置 + 现代设置界面、亮/暗主题跟随系统、轻量更新 |

**明确不做**：插件商店、内置终端、Git 集成、远程编辑、调试器、语言服务器（LSP）。
理由：这些是"变重"的根源，与"极度轻量"定位冲突。若将来需要，以外部命令调用的方式提供（如配置外部 diff/merge 工具）。

---

## 2. 技术选型

### 2.1 候选方案对比

| 方案 | 安装包 | 常驻内存 | 冷启动 | 编辑器/渲染生态 | 工期 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| Electron + CodeMirror 6 | 150–250 MB | 250–450 MB | 1.5–3 s | 最好（Web 生态全量复用） | 短 | ✗ 体量与内存不达标 |
| **Tauri 2 + Rust + CodeMirror 6** | **8–20 MB** | **80–150 MB** | **0.2–0.5 s** | 很好（CM6 + legacy-modes + 全部 npm MD 生态） | 中 | ✅ **推荐** |
| Rust 原生（egui / GPUI） | 5–10 MB | 40–80 MB | <0.1 s | 弱，编辑器与 MD 渲染需大量自研 | 很长（×3） | ✗ 工期不可控，MD 渲染是硬伤 |
| C# WinUI 3 + AvaloniaEdit | 30–60 MB | 120–220 MB | 0.3–0.6 s | 中，MD 需再嵌 WebView2 | 中 | 备选（仅限 Windows，体积与内存略高） |
| Qt (C++/QML) + Scintilla | 40–80 MB | 100–180 MB | 0.3 s | 中，MD 需再嵌 WebEngine | 中 | 备选，商业授权需注意 |

### 2.2 结论与理由

**主选：Tauri 2（Rust 后端 + 系统 WebView 前端）+ CodeMirror 6**

- **轻**：不含浏览器内核，Windows 上复用 WebView2（Win11 自带，Win10 引导安装约 2 MB）；产物 10 MB 级。
- **快**：Rust 侧负责文件 IO、编码转换、搜索，性能接近原生；前端只做渲染与交互。
- **生态**：CodeMirror 6 是当前 Web 端最强编辑器内核——视口虚拟化、增量解析、原生支持多光标/折叠/软换行；`@codemirror/legacy-modes` 直接补齐 Notepad++ 覆盖的 80+ 种语言。
- **Markdown**：整个 npm 生态（markdown-it / micromark / shiki / katex / mermaid）直接可用，这是原生方案最难补齐的部分。

**兜底方案**：若实测 WebView2 在超大文件或中文 IME 场景下不可接受，保留一条"编辑器内核下沉到 Rust"的迁移路径——因为业务逻辑已经全部在 Rust 侧，前端只是渲染层，替换成本可控。

### 2.3 关键依赖

**前端（TypeScript + Vite）**
- `codemirror` 6 全家桶：`@codemirror/state|view|commands|search|language|lang-*`、`@codemirror/legacy-modes`（C/C++/Java/PHP/INI/Batch/Shell…）
- Markdown：`markdown-it`（GFM 兼容、插件多、可控）或 `micromark`；`markdown-it-*` 插件（表格/脚注/任务列表/容器）
- 渲染增强：`shiki`（代码块高亮，语言/主题按需懒加载）、`katex`（公式）、`mermaid`（图表，懒加载）、`mermaid-isomorphic` 可选
- 状态：`zustand` 或原生 signals（极简，避免重框架）；UI 用原生 Web Component / 少量 Svelte 亦可

**Rust（Tauri 2）**
- `encoding_rs` + `chardetng`：编码识别与转换（GB18030/GBK/Big5/Shift-JIS/EUC-KR/UTF-16/Windows-1252…）
- `notify`：文件系统监听（外部修改检测）
- `ignore` + `grep`（或 `grep-searcher`）：跨文件并行搜索，复用 ripgrep 核心
- `memmap2`：大文件只读映射
- `serde` / `serde_json`：会话与配置持久化
- `tokio`：异步任务（搜索、IO）
- `tauri-plugin-*`：dialog / fs / updater / os-info（按需，能自己写就自己写，减少体积）

---

## 3. 总体架构

三层结构：**前端壳层（UI/编辑/渲染） ↔ Tauri IPC ↔ Rust 核心（IO/编码/搜索/会话）**。

设计原则：
1. **状态归 Rust，视图归前端**——文件的"真实状态"（磁盘内容、编码、行尾、脏标记）由 Rust 持有，前端只持有 buffer 与视图状态，避免双份真相。
2. **控制面与数据面分离**——控制指令走 Tauri command（小消息）；文件内容、搜索结果等大数据走流式 channel / 共享内存，避免 JSON 序列化拷贝。
3. **编辑器实例池化**——分屏再多也只保留有限个活跃 CodeMirror 实例，非活跃面板序列化保存状态。

模块划分：

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| `SessionCore` | Rust | 文件读写（原子写）、脏状态、只读/权限检测、回收站式备份 |
| `Codec` | Rust | 编码识别/转换、BOM 处理、行尾识别/转换、二进制文件检测 |
| `Watcher` | Rust | 外部修改监听、冲突事件广播 |
| `Searcher` | Rust | 跨文件并行正则搜索、glob 过滤、替换预览 |
| `SessionStore` | Rust | 会话/布局/配置持久化（JSON，含迁移版本号） |
| `Shell` | 前端 | 窗口、菜单、状态栏、命令面板、设置 UI |
| `LayoutTree` | 前端 | 多标签 + 分屏布局树、拖拽交互、焦点管理 |
| `EditorView` | 前端 | CodeMirror 6 封装：语言、折叠、软换行、列编辑、查找替换、光标/滚动状态 |
| `MarkdownPipeline` | 前端 | 解析 → 插件 → 增量渲染 → source line map → 同步滚动/导出 |
| `Theme` | 前端 | 亮/暗主题、语法配色、字体与排版 |

---

## 4. 核心设计详解

### 4.1 编辑器内核与大文件策略

- 每个面板一个 CodeMirror 6 实例，`EditorState` 与 `EditorView` 分离；非活跃面板只保留 `EditorState`（约等于文件文本 + 解析树），销毁 DOM，切换时重建（<10 ms）。
- **分级降级策略**（按文件字节数）：

| 大小 | 模式 | 行为 |
| --- | --- | --- |
| < 2 MB | 完整 | 语法高亮、括号匹配、折叠、自动缩进、软换行全开 |
| 2–20 MB | 精简 | 关闭括号匹配与自动缩进，高亮降级为行内流式解析，关闭折叠 |
| 20–200 MB | 只读虚拟 | 自研轻量行虚拟化列表，仅加载可视区 ±N 行（mmap），禁用编辑与高亮 |
| > 200 MB / 二进制 | 拒绝或十六进制预览 | 提示用户，避免 OOM |

- 输入性能：CM6 本身是增量解析 + 视口渲染；额外做三件事——(a) 输入事件与渲染解耦，用 `requestAnimationFrame` 批处理；(b) 语法解析放 Web Worker（可选，实测再定）；(c) 超大行（>10 万字符）自动关闭该行高亮。
- 撤销栈：限制步数（默认 500 步）与内存上限，避免大文件吃内存。

### 4.2 多标签与自由分屏（核心差异化）

**数据模型（二叉树）**

```ts
type LayoutNode =
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; a: LayoutNode; b: LayoutNode }
  | { kind: 'leaf'; tabs: TabId[]; active: TabId }

interface Tab {
  id: string
  path: string | null          // null = 未保存的新文件
  encoding: Encoding           // 每文件独立记忆
  eol: 'CRLF' | 'LF' | 'CR' | 'auto'
  dirty: boolean
  viewState: { cursor: number; scrollTop: number; folds: number[]; wrap: boolean }
}
```

**拖拽规则（Xshell 风格）**

| 拖拽落点 | 行为 |
| --- | --- |
| 目标面板中央区（>50% 区域） | 移动标签到该面板，成为其激活标签 |
| 目标面板上/下/左/右 25% 边缘带 | 在该方向新建 split，源标签进入新面板 |
| 面板之间的分隔条 | 调整比例（实时预览，`ratio` 范围 0.15–0.85） |
| 拖出窗口外（阶段 3） | 弹出为独立窗口 |
| 拖到标签栏空白处 | 新建窗口/分组 |

交互细节：拖拽时用半透明浮层 + 落点高亮遮罩（蓝色区域预览），松手前即可看到分屏结果。

**键盘操作**：`Alt+方向键` 在面板间移动焦点；`Ctrl+Alt+方向键` 移动当前标签到相邻面板；`Ctrl+1..9` 切标签；`Ctrl+W` 关标签，关掉最后一个标签时自动销毁面板并合并父 split（树自动规约）。

**持久化**：布局树 + 每个标签的 `path / encoding / eol / viewState` 序列化进 `session.json`（`$APPDATA/LitePad/session.json`），启动时恢复；写入采用防抖 + 退出时 flush，避免频繁落盘。

**树规约**：删除叶子后父节点若只剩一个子节点，用子节点替换父节点，保持树最简（避免深层嵌套带来的渲染抖动）。

### 4.3 编码与行尾

**编码**
- 支持集：UTF-8、UTF-8 with BOM、UTF-16LE/BE（带/不带 BOM）、GB18030（兼容 GBK/GB2312）、Big5、Shift-JIS、EUC-KR、ISO-8859-1、Windows-1252。
- 读取决策顺序：① BOM → ② 该文件上次用户手动指定的编码（记入最近文件表）→ ③ `chardetng` 检测（优先中文场景调参）→ ④ 配置中的默认编码（UTF-8）。
- 状态栏常驻显示编码；点击可"以指定编码重新载入"（不写盘）或"转换并保存"（写盘）。
- **不可逆保护**：UTF-8 → ANSI 类编码若存在无法映射的字符，保存前弹窗提示受影响字符数与行号，需二次确认；提供"另存为副本"逃生通道。

**行尾**
- 状态栏显示 `CRLF / LF / CR`（混合时显示 `Mixed`）；一键切换（只改内存缓冲，标记 dirty，保存时落盘）。
- 默认策略：新建文件跟随平台（Windows → CRLF），打开已有文件沿用其主行尾，可在设置中全局覆盖为"统一 LF"。
- 与 Git 协作：提供 `settings.json` 中 `eol.default` 与"保存时自动转换"开关，默认关闭（尊重原文件）。

### 4.4 自动保存与文件监听

- 触发时机：停止输入 **1.5 s**（可配）→ 保存；窗口失焦 → 立即保存；标签关闭/应用退出 → 保存；`Ctrl+S` 手动保存。
- **原子写入**：写临时文件（`xxx.tmp-<pid>`）→ fsync → `rename` 覆盖（Windows 上用 `MoveFileEx` 带 `REPLACE_EXISTING`），失败自动回滚到备份，绝不产生半截文件。
- 只读/权限不足 → 不自动保存，状态栏提示，提供"另存为"。
- `notify` 监听已打开文件：外部修改且当前不脏 → 静默重载并保留光标；当前脏 → 弹提示条（`已外部修改 · 重载 / 保留我的版本 / 查看差异`），差异用前端轻量 diff 展示。
- 使用 `DebounceEvent` 合并高频事件（如 `git checkout` 触发的批量变更）。

### 4.5 格式关联（语言识别）

优先级：
1. 用户显式覆盖（状态栏语言选择器 / `fileAssociations` 配置）
2. 完整文件名匹配（`Makefile`、`Dockerfile`、`.gitignore`、`.editorconfig`）
3. 扩展名映射（内置 ~200 条；支持多扩展名与大小写不敏感）
4. Shebang（`#!/usr/bin/env python3`）
5. 首行魔数 / 内容启发式（`<?xml`、`<?php`、XML 声明）

映射到：语法模式（CM6 language / legacy StreamLanguage）、缩进规则（空格数、Tab、智能缩进）、注释符、折叠标记、行尾默认、文件图标配色。
未匹配 → Plain Text，仍保留软换行、行号、编码等全部基础能力。

### 4.6 查找与替换

- 单文件：直接用 CM6 `@codemirror/search`（正则、大小写、全词、选区搜索、替换全部），加一层自绘搜索条（更美观、支持中文提示与匹配计数）。
- 跨文件：`Rust` 侧并行搜索（rayon/tokio 多线程），支持正则、glob include/exclude、`.gitignore` 感知、大小写/全词、最大结果数截断（默认 5000 条，防止爆内存）。
- 结果面板虚拟滚动；批量替换先在内存中生成 diff 预览，确认后统一落盘并纳入撤销栈。

### 4.7 Markdown 渲染管线

```
源码文本 → 解析(markdown-it + GFM 插件) → AST
   → 增强(标题锚点/TOC、脚注、任务列表、代码高亮 Shiki、KaTeX、Mermaid)
   → HTML 片段 → 增量 patch 到预览 DOM（按 block 复用，避免整页重绘）
   → 生成 source-line ↔ block 映射表 → 同步滚动 / 双向点击定位
```

要点：
- **增量**：监听 `EditorState` 的 changedRanges，只重渲染受影响的顶层 block；配合 120 ms 防抖 + `requestAnimationFrame`。大文档（>5000 行）先渲染可视区，滚动时再补渲染。
- **同步滚动**：建立 source line ↔ 目标 DOM 元素的双向映射，用"比例插值 + 锚点对齐"而非硬滚动，避免抖动；预览滚动时反向定位源码行（关闭回环防止互相打架）。
- **支持范围**：GFM（表格、删除线、任务列表、自动链接）、脚注、Emoji 简码、前置 YAML 元数据（渲染为元信息条）、内部链接跳转、`[[wikilink]]` 可选。
- **图片**：相对路径按 md 文件所在目录解析；支持拖拽/粘贴图片自动保存到 `./assets/`（可配）并插入相对链接。
- **导出**：HTML（自包含，内联 CSS/字体子集）、PDF（调用 WebView2 打印到 PDF）、DOCX（阶段 3，用 `docx` 库或 pandoc 外部调用）。
- **三种视图**：`源码` / `分屏预览` / `纯预览`，按文件类型记忆，工具栏一键切换，`Ctrl+/` 循环。

---

## 5. 性能预算与优化清单

| 指标 | 目标（P95，中端 Windows 笔记本） | 测量方式 |
| --- | --- | --- |
| 冷启动（到可输入） | ≤ 400 ms | 进程启动到首个 input 可响应埋点 |
| 空窗口常驻内存 | ≤ 90 MB | 10 个标签 + 1 个分屏 ≤ 160 MB |
| 1 MB 文件打开 | ≤ 150 ms | — |
| 10 MB 文件打开 | ≤ 800 ms | 精简模式 |
| 输入延迟 | ≤ 16 ms（60 fps） | 输入到重绘 |
| Markdown 预览刷新 | ≤ 50 ms（1000 行文档） | 增量渲染 |
| 安装包 | ≤ 15 MB（含 WebView2 引导器） | NSIS |

优化清单：
- 前端代码分割：Shiki 语言/主题、Mermaid、KaTeX 全部动态 `import()`，首屏不加载。
- Rust 侧开启 `lto = "fat"`、`opt-level = "s"`、`panic = "abort"`、`strip = true`。
- WebView2 环境预创建（隐藏窗口预热），首窗口复用。
- 图标用 SVG sprite，字体用系统字体栈（不打包字体），仅在 PDF 导出时处理。
- 会话恢复时懒加载：只恢复激活面板的编辑器，其余标签记录路径与状态，切到时才读盘。

---

## 6. 交互与视觉规范

- **布局**：顶部标签栏（每面板独立） + 中间编辑区 + 底部状态栏（`行:列 | 编码 | 行尾 | 语言 | 缩进 | 缩放`）。隐藏传统菜单栏，改由 `Alt` 唤起；所有功能可从命令面板 `Ctrl+Shift+P` 触达。
- **主题**：亮/暗双主题 + 跟随系统；语法配色复用成熟方案（如 One Dark / GitHub Light 变体），UI 用 CSS 变量驱动，支持用户覆盖 `theme.css`。
- **快捷键**：提供两套预设——`Notepad++ 兼容`（降低迁移成本）与 `VSCode 风格`；均可在 `keybindings.json` 中覆盖。
- **动效**：只在分屏拖拽、面板切换、命令面板上使用 ≤150 ms 的缓动；其余零动效（性能优先）。
- **字体**：默认 `Cascadia Code / JetBrains Mono / Consolas` 系统探测 + 中文回退 `Microsoft YaHei UI`；支持连字开关与行高调节。

---

## 7. 开发路线图

| 里程碑 | 内容 | 产出 | 预估 |
| --- | --- | --- | --- |
| **M0 脚手架** | Tauri 2 + Vite + TS 工程、窗口/菜单/状态栏、读写单文件、编码与行尾基础、亮暗主题、日志与埋点 | 能打开/保存一个文件的最小可用程序 | 1–2 周 |
| **M1 编辑器内核** | CM6 集成、语言包与格式关联、多标签、查找替换、折叠/软换行、列编辑、设置持久化 | 单窗口下接近 Notepad++ 的编辑体验 | 2–3 周 |
| **M2 分屏与会话** | 布局树、拖拽分屏、比例调节、树规约、会话恢复、自动保存、文件监听与冲突、跨文件搜索 | 完整的多标签/分屏体验 | 2–3 周 |
| **M3 Markdown** | 渲染管线、同步滚动、TOC、代码高亮、Mermaid/KaTeX、图片粘贴、导出 HTML/PDF | Markdown 体验成型 | 2–3 周 |
| **M4 性能与打磨** | 大文件模式、启动与内存优化、命令面板、键位预设、安装打包与自动更新 | 可发布 v1.0 | 1–2 周 |
| **M5 可选** | 独立窗口拖拽、macOS/Linux 构建、i18n、DOCX 导出、最小脚本扩展 | v1.1+ | 持续 |

**单人全职约 8–13 周**可到 v1.0；若只做 Windows 且砍掉 M3 部分高级渲染，可压缩到 6 周。

---

## 8. 建议的目录结构

```
litepad/
├─ src-tauri/                 # Rust 后端
│  ├─ src/
│  │  ├─ main.rs
│  │  ├─ commands/            # tauri command 接口
│  │  ├─ core/{doc,codec,eol,atomic_write,large_file}.rs
│  │  ├─ search/
│  │  ├─ watcher/
│  │  └─ session/             # 会话与配置持久化
│  └─ Cargo.toml
├─ src/                       # 前端
│  ├─ shell/                  # 窗口、状态栏、命令面板、设置
│  ├─ layout/                 # 布局树 + 拖拽分屏
│  ├─ editor/                 # CodeMirror 封装、语言注册表、keymap
│  ├─ markdown/               # 管线、插件、同步滚动、导出
│  ├─ theme/
│  └─ ipc/                    # 与 Rust 通信的类型化封装
├─ locales/
└─ scripts/{build,release}.ps1
```

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| WebView2 依赖（Win10 需引导安装 ~2 MB） | 首次安装体验 | 提供离线安装包；检测失败时给清晰指引 |
| 中文输入法候选框定位（CM6 已知痛点） | 中文用户体验 | 使用 `composition` 事件自绘候选锚点；必要时改为原生 `textarea` 镜像方案 |
| 超大文件内存与卡顿 | 核心指标 | 分级降级 + mmap 只读模式 + 明确的产品边界（>200 MB 提示） |
| 编码误判导致乱码 | 数据安全 | 手动覆盖优先 + 按文件记忆 + 保存前可预览转换结果 |
| Markdown 大文档渲染卡顿 | 体验 | 分块惰性渲染 + 增量 patch + 大文档关闭 Mermaid 自动渲染 |
| 分屏多实例内存膨胀 | 核心指标 | 实例池化 + 非活跃面板只保留 state |
| WebView 渲染性能不及原生 | 长期天花板 | 保留"编辑内核下沉 Rust"的迁移路径（业务逻辑已在 Rust 侧） |
| 与 Notepad++ 键位/习惯冲突 | 迁移成本 | 提供兼容键位预设 + 设置迁移引导 |

---

## 10. 待确认

1. **平台范围**：仅 Windows（可最大化优化、用 Win32 API 做原子写与文件监听），还是一开始就兼顾 macOS/Linux（Tauri 天然支持，仅需适配打包与快捷键）？
2. **是否现在开始搭 M0 脚手架**（我可以按本方案直接生成工程骨架与可运行的最小版本）。
3. **项目命名**（本文档暂用 LitePad）与是否需要内置更新服务。
