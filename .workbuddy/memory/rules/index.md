# rules/ — 约束与红线全量目录

> 本目录是项目**约束的权威分类目录**。每条约束一行，指向 `ref/<domain>.md` 的深层不变量或
> `pitfalls/<NNNN>-<slug>.md` 的踩坑根因。`MEMORY.md` 的「红线」是其中最高优先级子集（内联）。
> 路由总表见 `MEMORY.md`。

## 红线（最高优先级，违反即回滚）
- 临时文件一律落本项目 `.tmp/`；禁写 `%TEMP%`/`~/.workbuddy/`（除 memory/skills）/Git Bash `/tmp` → `MEMORY.md` 红线 / `docs/conventions.md`
- 沙箱内禁 `git stash -u` 或任何触碰 `.git` 重操作 → `MEMORY.md` 红线
- 状态归 Rust、视图归前端；内存 LF、落盘还原原行尾 → `ref/architecture-detail.md` §1
- 每个交付一个 Conventional Commit + 回归测试 + 反向验证 → `docs/conventions.md` / 技能 `litepad-reverse-verify`
- 界面改动必刷 `docs/screenshots/` 同一提交 → `MEMORY.md` 红线
- **按钮图标一律用 VS Code codicon**（`src/shell/codicons.ts` + `scripts/fetch-codicons.mjs`）；**禁手绘 SVG**；codicon 无对应字形时**先与用户商量**再引别的图标集 → `docs/conventions.md`
- `docs/*.md` 是说明不是契约，改语义同步清单/状态表（B67） → `MEMORY.md` 红线
- 编译门：tsc→vite→vitest→cargo build+test→tauri build（`.githooks`+CI） → `docs/build-env.md`
- README 使用者向（顶部一张 `main.png`，无快捷键/安装/构建） → `docs/conventions.md`
- 发布仅 `v*` tag（`git push origin main --follow-tags`）+ GitHub Actions → `docs/conventions.md`
- **版本号跟着交付动**：有 `feat` → minor、有效提交 ≥10 → patch；pre-push 守卫 `scripts/check-version-bump.sh`（达阈值阻断）；三处版本号须一致 → `docs/conventions.md`
- `CHANGELOG.md` 由 `scripts/gen-changelog.sh` 自动生成，`release.sh` 里刷新，**勿手改** → `docs/conventions.md`

## 文档模型 / 同步
- 同文件多面板同源：Doc 持有元数据/脏标记，实例持有 state/comps/viewMode；ChangeSet 广播同步，`syncingDocId` 抑制回环 → `ref/architecture-detail.md` §1
- `handleUpdate` 用 `panelOfView` 反查面板（不得闭包捕获） → `ref/architecture-detail.md` §1
- 仅最后一个实例关闭才走保存确认 + `ipcCloseTab` → `ref/architecture-detail.md` §1
- 跨 IPC DTO 命名两侧对齐（camelCase round-trip 测试锁） → `ref/architecture-detail.md` §8
- 自动保存（写原文件）与热退出（写副本）是两个独立开关 → `ref/architecture-detail.md` §7（保存体系）
- 副本 ID 必须白名单；孤儿清理只在会话读成功时做；空未命名文档靠 `docId` 认领 → `ref/architecture-detail.md` §7

## 布局 / 拖拽 / 标签栏
- 布局树 path 语义（寻址自身 vs 子节点）、`promoteSibling` 比例补偿 → `ref/architecture-detail.md` §3
- 最大化只改比例不动结构；`exitMaximize()` 必须在所有改布局操作前；会话存未最大化比例 → `ref/architecture-detail.md` §3
- `dragDropEnabled:true` 才能拿真实路径；页面内 HTML5 DnD 因此失效，改指针编排 → `ref/architecture-detail.md` §4
- drop 物理像素 ÷ devicePixelRatio；选择菜单判据 = 落点活动文档是 md（非拖入的是 .md） → `ref/architecture-detail.md` §4
- 标签拖拽影像：克隆原标签、锚点左上角、`pointer-events:none`、越过阈值才建、blur 清理；整组药丸两个 span → `ref/architecture-detail.md` §4
- 同面板排序绝不改 `activeTabId`；strip 判定先于 `zoneOf` → `ref/architecture-detail.md` §4
- 标签栏：横向滚动不折叠；`scrollbar-width/color` 显式复位；高度 4+N+4（N=24）；`.tab` `flex:0 0 auto`；药丸无描边；`scrollLeft` 存还原；`ensureVisible()` 定位 → `ref/architecture-detail.md` §7
- ●/× 同槽位固定尺寸；B57 起 `opacity` 显隐、判据挂 `.tab-action`、互斥一条 `:not()` 链、非活动面板 × 降亮同步 → `ref/architecture-detail.md` §7
- 分隔条浮层不占位（flex 0 0 0）；对齐联动 `centerOf` 看交叉轴、先取集合再改比例、纯点击不回写 → `ref/architecture-detail.md` §7

## 视图 / 样式
- `mousedown` 链路禁 DOM 重建（避免点两下）；滚动容器补 `min-height:0`；单面板补 `flex` → `ref/architecture-detail.md` §5
- 组件用全局 CSS 变量；CSS 注释禁 `*/`；`[hidden]` 须显式 `display:none` → `ref/architecture-detail.md` §6
- 提示自绘层（弃用原生 `title`）；`[hidden]` 显式 `display:none`；菜单开着早退且判据先于读 `dataset.tip` → `ref/architecture-detail.md` §7
- 菜单系统：子菜单挂 `document.body`；菜单项不挂提示；菜单 vs 面板/提示互斥 → `ref/architecture-detail.md` §7

## 构建 / 环境
- 工具链 `rust-toolchain.toml` stable-x86_64-pc-windows-gnu + MSYS2 MinGW；WebView2Loader.dll 声明为 `bundle.resources` → `docs/build-env.md`
- `cargo build --release` ≠ 可运行 exe（用 `tauri build`）；改名后 `cargo clean`；图标 `build.rs` `rerun-if-changed=icons` → `docs/build-env.md`
- **沙箱 PATH 丢失**：先 `export PATH=...usr/bin...` 再跑 coreutils；`git` 走系统 PATH → `ref/session-env.md`
- **沙箱 WebView2 http(s) 导航被拦**：预览/本地资源走 file:// 或 release build，绕过 dev server → `ref/session-env.md`
- 截图经 `scripts/screenshot.py`；临时文件落 `.tmp/` → `docs/build-env.md` / `ref/session-env.md`
- **写进 PATH 的探测结果必须 `cd … && pwd` 归一**（`C:/…` 与带 `..` 的原始路径对 shell 与原生子进程都是死路；pre-push 的 COREUTILS_DIR / WINDRES_DIR 各踩一次） → `pitfalls/0083-prepush-windres-posix-path.md` / `0074`
- `while read` 消费 `git log --pretty=format:` 时必须带 `|| [ -n "$sha" ]`（末条无换行会被静默吞掉，区间内最旧提交整条丢失） → `pitfalls/0082-changelog-gen-drops-last.md`
- `scripts/gen-changelog.sh` 只在前置位置插新小节、**不去重**：仅能在发布流程里跑一次；核对历史版本用 `git show <release-commit>:CHANGELOG.md` → `pitfalls/0082`
- **门禁脚本「退出码 0 + 日志正常」≠ 生效**：钩子/脚本/生成器改完必须**真跑一次并回读产物**（已连续出现 0074 半落盘、0082 静默丢提交、0083 打印正确却失败） → `pitfalls/0074` / `0082` / `0083`

## 范围（明确不做）
- 不做：插件商店 / 内置终端 / Git / LSP → `docs/conventions.md`
- 大文件分级降级：≤2MB 全功能 / 2–20MB 关高亮等 / 20–64MB 再关当前行高亮 / >64MB 拒绝打开 → `docs/conventions.md`
- 键位三档预设 default / Notepad++ / VS Code，优先级：用户覆盖 > 预设 > 默认 → `docs/conventions.md`
