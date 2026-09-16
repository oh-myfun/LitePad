# LitePad 项目长期备忘

应用名 **LitePad**（B34 起更名；原名 LiteMD 已于 B36 在**全仓库**清理完毕）。工作区 `E:\Project\LitePad`。

> 本文件是精炼索引，不承载全部细节。展开见同目录：
> `ARCHITECTURE.md`（架构不变量与踩坑根因）· `BUILD-ENV.md`（构建/会话环境精确命令）·
> `LiteMD-Space-Archive.md`（旧 LiteMD 空间会话与记忆归档）· `2026-09-*.md`（逐日工作日志，最详细）。

## 技术栈与范围

- Tauri 2（Rust 持有状态）+ Vite 6/TypeScript + CodeMirror 6（视图）；**仅 Windows**。
- 标识：productName/exe `litepad`、identifier `com.litepad.app`、配置落 `%APPDATA%\LitePad`。
- 编码 encoding_rs + chardetng；原子写入 = 临时文件 + fsync + rename。
- 明确不做：插件商店、内置终端、Git 集成、LSP。

## 项目约定（用户明确要求）

- **状态归 Rust、视图归前端**；内存中文本一律 LF，落盘时还原原行尾。
- **git 全程管理**：每个交付一个 Conventional Commit。
- **README 定位 = 面向使用者的说明**（0914 用户明确）：开头**只放一张截图**（`main.png`），
  不写截图生成/维护方法，不写快捷键表、安装、从源码构建、明确不做等章节；
  特性描述用使用者视角，避免库名/内部机制等实现细节。技术细节留在
  `docs/screenshots/README.md`、`.workbuddy/memory/` 与代码注释里。
- **用户报告的每个 bug 必须补对应回归测试用例**，修 bug 与补测试同一提交：
  运行时可测 → `tests/smoke.bootstrap.test.ts`（jsdom 真实 bootstrap）；
  配置/样式根因 → `tests/regressions.test.ts`（静态文件断言）；
  Rust 侧 wire 格式/序列化 → `src-tauri/src/**` 内联 `#[cfg(test)] mod tests`。
- **界面有改动必须刷新 `docs/screenshots/` 截图**（B49 起，用户明确要求）：
  菜单/工具栏/状态栏/对话框/配色/字体/标签栏等观感变化，与代码改动**同一提交**更新截图；
  代码合并前确认截图与当前界面一致，确实不影响观感则在提交信息注明「界面无变化」。
  截图清单、演示会话构造与截取命令见 `docs/screenshots/README.md`。
- **每次编译都要产出发布版本**：`npm run build:all`（tsc → vite → vitest → cargo build+test → tauri build，出 exe + NSIS）。
- 质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt --check；pre-push: vitest/cargo test）；
  GitHub 侧另跑 `CI`（push main / PR：format→lint→tsc→vite→vitest→cargo test）。
- ⚠️ **沙箱内禁止 `git stash -u` 或任何触碰 `.git` 的重操作**（09-13 一次误操作致全历史丢失，只能重建）。

## 发布

- `bash scripts/release.sh <x.y.z|patch|minor|major> [--ci]`：版本**四处**同步
  （package.json / tauri.conf.json / Cargo.toml / Cargo.lock）→ 构建 → `chore(release): vX.Y.Z` + tag。
  `--ci` 跳过本地全量构建（本机冷启 tauri build 要 38 分钟；Actions 本来就会构建）。
- **GitHub 的 Release 只由 `v*` tag 触发**：只推 `main` 只会跑 CI 编译校验，不会发布。
  推 tag：`git push origin main --follow-tags`；失败可在 Actions 手动 dispatch（填 tag）重跑。
- 当前状态：**v0.2.2 已发布**（v0.2.0 首个 Release → v0.2.1 构建成功 → v0.2.2 修好安装包缺 DLL）；
  版本一致性由 `tests/regressions.test.ts` 断言守护。

## 构建环境要点

- 本机**无 MSVC**，宿主工具链用 `stable-x86_64-pc-windows-gnu`（`rust-toolchain.toml` 锁定 + MSYS2 MinGW 链接器）。
- 精确 PATH、会话内分步构建、以及 safe-delete shim / npx 异常 / cargo collect2 ICE 等坑 → 见 `BUILD-ENV.md`。
- 沙箱内 cargo/tauri 构建需 `dangerouslyDisableSandbox`，链接前先杀掉运行中的 `litepad.exe`。

## 进度

- **M0–M3 全部交付**：M0 脚手架 → M1（语言注册表 55 类/多标签/搜索/设置/日志）→
  M2（自由分屏/会话恢复/自动保存/文件监听/跨文件搜索）→ M3（Markdown 渲染）。
- 之后是 B4–B35 系列缺陷修复与 UI 打磨：菜单栏 + 图标工具栏二分、同源多实例、
  指针拖拽分屏、查找悬浮栏、大纲跟随活动面板、标签溢出折叠、Ctrl+滚轮缩放、图标矢量重绘、
  发布流程与格式检查链。逐条见 git log 与日志。
- **B34** 应用更名 LitePad + 矢量图标；**B35** prettier/eslint/rustfmt 链 + `scripts/release.sh` + GitHub Actions；
  **B36** 全仓库清理 LiteMD 残留（回归断言升级为全仓库扫描）+ 旧空间记忆归档；
  **B37** 接入 main 分支 CI + 手动触发，发布 **v0.2.0**（首个 GitHub Release，流水线首次实跑通过）。
- **B41** 图标定为无背景折角文档+钢笔（钢笔头朝左下），修好 `build.rs` 未盯 `icons/` 导致旧图标入 exe；
  **B42** 菜单重组为 文件/编辑/查看/设置/帮助，新增「设置→首选项（二级子菜单）」与**可编辑快捷键面板**
  （`src/shell/keymap.ts` 注册表 + `Settings.keymap` 持久化），大纲/折叠展开补齐默认键位。
  该批暴露 **CodeMirror 内置键位静默吞键并改写文档** 的问题（详见 `ARCHITECTURE.md` §8）。
- **B43** 图标微调：钢笔 0.78→0.62、笔尖收进文档中间靠下（不再压角）、去掉文档投影。
  方案 B 几何已收进 `gen_icons.py` 的 `B_*` 常量，改图标只需动那几个数。
- **B44** 标签栏折叠态不重算：补尺寸监听（ResizeObserver + window.resize 退化 + rAF 合并）、
  活动标签拉回门控 `activeChanged`、窗口没铺满时左移补满（`fitCountFromEnd`）。
  三条不变量已写进 `ARCHITECTURE.md` §7「标签栏溢出」，改这块前务必先读。
- **B45** 关闭非活动标签不再「先切过去再切回」：保存改用按实例寻址的 `saveDocCore`，
  并加 `wasShown` 判定——关后台标签不动显示内容。「关闭其他/右侧」的批量闪烁一并解决。
  通用教训见 `ARCHITECTURE.md` §8 首条（同步改 UI + 之后 await = 中间态被绘制）。
- **B46** 首选项从二级子菜单升级为**弹窗设置窗口**（`src/shell/preferencesdialog.ts`，即时生效+持久化），
  新增精细选项：编辑器字体（`Settings.font_family`）、编辑器行距（`Settings.editor_line_height`）、
  字号档位；偏好 setter 全部改为绝对值型（setWordWrap/setAutosave 等），toggle 系是其包装。
- **B47** 折叠标签列表：点选后**菜单保持打开**可连点（menu.ts 的 keepOpen + refreshPopupMenu）、
  当前项不打 ✓ 改整行观感（`.menu-item-current`）、激活标签闪一下（`.tab-flash`）、
  折叠按钮改矢量图标 + 角标（`MORE_WIDTH` 34→28）并可再点收起（anchorToggle）。
  弹层通用能力见 `ARCHITECTURE.md` §7。
- **B48** 安装包补 `WebView2Loader.dll`（否则装好起不来）；踩坑与排查三步见 `BUILD-ENV.md`。
- **B49** ① 写 `README.md`（含真实截图）；② **修会话恢复全线失效**：Rust `TabSession`/`SessionState`
  少 `rename_all = "camelCase"`，前端 camelCase 与落盘 snake_case 两侧对不上，
  表现为重启后**光标回到第 1 行、预览模式丢失、活动面板错位**（B49 前一直是坏的）。
  修法 = 加 `rename_all` + 对旧字段加 `serde(alias)` 兼容，并补 Rust round-trip 测试。
  截图基建：`scripts/screenshot.py` 支持 `--exe` / `--pid` / `--size`（按进程定位窗口，避免标题撞名）。
- **B50** 消除启动白屏：WebView2 首帧前的客户区是 Chromium 纯白，深色主题下就是「白屏一下」。
  修法 = `main.rs` 的 `set_background_color`（按 settings.theme / 系统主题取 `--bg` 同款色）
  + `tauri.conf.json` 的 `backgroundColor` 兜底 + `index.html` 内联首屏样式/脚本（同步读
  `localStorage["litepad.theme"]` 设 `data-theme`）。**四处配色必须一致**，回归测试守护。
  另：`restoreSession` 改为 `Promise.all` 并行预取（原先逐文件串行 await）。
  ⚠️ **不要用 `visible:false` + 就绪后 show()**：窗口出现与否会依赖前端 bootstrap，
  前端卡住时用户「点了图标什么都没有」（实测发生过），比白屏严重得多。
  ⚠️ **WebView2 数据目录损坏 = 窗口空白且无 IPC**：`%LOCALAPPDATA%\com.litepad.app\EBWebView`
  坏掉时页面不加载；改名重建即可恢复（不要删，改名留退路）。强杀进程易造成。

- **M4（0914，提交 0be87d2）性能与打磨收尾**：① 大文件分级降级（>64MB 拒绝；
  2–20MB 关语法/折叠/括号/选区匹配/**自动预览**；20–64MB 再关活动行高亮；
  `core/doc.rs` 的 `size_class()` + 新文件 `src/editor/perf.ts` 的 `perfProfileFor`，
  `baseExtensions(perf)` 按档裁剪，预览降级提示 `.md-preview-notice`）；
  ② 命令面板（`src/shell/commandpalette.ts`，`palette.open` 默认 Ctrl+Shift+P）；
  ③ 键位预设（`KEYMAP_PRESETS`：default/notepadpp/vscode 只记差异；
  `effectiveKeys` 链 = 用户覆盖 > 预设 > 默认；`Settings.keymap_preset` 持久化，
  bootstrap 最先落地）。
  ⚠️ **绑定索引不能按声明顺序写一张表**：`palette.open` 靠后会用默认键位抢走
  先声明命令的用户覆盖。`indexOf()` 必须三趟：铺底 → 撤被覆盖命令的铺底（含
  显式解绑）→ 写用户覆盖，保证覆盖与声明顺序无关（有回归测试）。
  ⚠️ 遗留：截图未刷新（keymap.png 多了预设下拉、建议补 command-palette.png），
  沙箱 WebView2 引导卡死无法补拍，**需桌面环境按 docs/screenshots/README.md 补拍**。

- **B51（0914，提交 f3f142a）界面微调**：① 首选项弹窗去掉「自动换行 / 自动保存 /
  快捷键」（功能留在 查看菜单 / 文件菜单 / 设置菜单，有回归断言同时查「弹窗没有 + 菜单有」）；
  ② 导出图标由「箭头落入托盘」改「文档 + 出向箭头」；
  ③ 主题按钮改三态循环 浅色/深色/跟随系统（`followSystem` 半明半暗圆图标，
  档位写 `dataset.themeMode`）。
  ⚠️ **三态循环顺序跟着系统偏好走**（`themeCycle()`：system 的下一档取「与当前生效相反」
  的显式档）：三态里「显式档 → system」是否翻转取决于系统偏好，无法三条边全保证翻转；
  这样排序可保证从默认档出发第一下必翻转（老 bug「要点两下才生效」的场景）。
  改这块前先读 `.workbuddy/memory/2026-09-14.md` 的 B51 段与
  `smoke.bootstrap.test.ts` 里的 `resetThemeToSystem()`（档位是跨用例共享状态）。

- **B52（0914）安装程序图标**：用户报「二进制图标还是旧的」，实测**应用本体 exe 完全正确**，
  错的是**安装器外壳**（双击 setup.exe 的图标、「应用和功能」里的卸载图标 = NSIS 默认图标）。
  根因：`bundle.icon` 只喂 exe 与快捷方式，NSIS 安装/卸载器图标要单独配
  `bundle.windows.nsis.installerIcon` / `uninstallerIcon`，不配就渲染成 `INSTALLERICON ""` 且零报错。
  ⚠️ **排查图标问题先分层**：exe 图标 / 安装器外壳图标 / 快捷方式图标是三套机制。
  新增两个校验脚本：`scripts/icon_check.py`（扫未压缩 PNG 流）与
  `scripts/icon_check_pe.py`（解析 PE 资源段 RT_ICON，**外壳图标只在这一层**，前者查不到）。

- **B53（0915，提交 80f982b）标签栏改原生横向滚动 + VS Code 化**：**折叠机制整体删除**
  （`.tab-more` 下拉 + 可见窗口区间 + B44 三条不变量 + ResizeObserver/liveStrips 记账 +
  B47 keepOpen 菜单），因为**原生滚动自带这些能力**；`tabstrip.ts` 484 → 245 行。
  同时按 VS Code：标签先收缩再滚动（`flex:0 1 auto` + min-width）、活动标签顶部 accent 条
  （**必须用 `::before`**，`box-shadow` 会被 `.tab-flash` 关键帧盖掉）、●/× 共用固定尺寸槽位
  `.tab-action`（平时 ● 或空，悬停才变 ×）、面板操作栏 3 个矢量图标、焦点面板降亮度、
  分隔条 7px 命中区（B53 起「细线 + 宽命中区」，**B60 改为不占布局**：元素 `flex: 0 0 0`、
  命中区搬到 `::before` 向两侧溢出、视觉线静息 1px / 激活 4px；`.toc-resizer` 必须同款，B28 约定）。
  ⚠️ 三个坑：① 全量重绘会重置 `scrollLeft`，必须存/还原 `prevScroll`；
  ② `.tab-insert` 的 `left` 走内容坐标，`stripInsertInfo` 必须 `+ scrollLeft`
  （原用例 `scrollLeft=0` 正好掩盖）；③ 原生横向滚动条占 3px，必须**恒定预留**
  （`height:37px` = 34px 标签 + 3px 余量）否则溢出切换时编辑器内容上下抖。
  ⚠️ 切面板**绝不能重绘标签条**（会销毁光标下的 `.tab` → 点标签要点两下）；
  焦点面板视觉只能靠 `main.ts` 的 `markActivePanel()` 切 class。
  ⚠️ 遗留待清理：`menu.ts` 的 `MenuItem.active` 与 `.menu-item-current` 已无使用者
  （折叠列表是唯一调用方）。详见 `.workbuddy/memory/2026-09-15.md` 与 `ARCHITECTURE.md` §7。

- **B54（0915）标签风格回退 + 面板按钮精简 + 滚动条 2px 去箭头**：B53 的 34px 方角平标签
  被用户嫌「太高、风格退回」→ 标签回 24px 上圆角 + 1px 描边（accent 条删除）；
  面板操作栏去掉 B53 加的分屏按钮（分屏改由**把标签拖到面板边缘**触发）；
  `::-webkit-scrollbar` 收到 2px、`::-webkit-scrollbar-button { display:none }`。
  ⚠️ **Chromium 坑**：元素上写 `scrollbar-width/color`（**非 `auto`**）会让它**忽略
  `::-webkit-scrollbar`** → 标签栏拿回系统滚动条（带箭头、压不细）。必须显式复位 `auto`。

- **B55（0915，提交 c52e257）标签改 VS Code Modern UI 药丸 + 滚动条 4px 塞下间隙**：
  对标 `contrib/modernUI/browser/media/tabs.css` 的 **compact 档**（20px 药丸 + 上下各 4px = 28px，
  **与 B54 标签栏同高 → 零高度变化**）：`.tab` 20px / `border:none` / `border-radius:4px` /
  非活动文字 `color-mix(--fg 50%, transparent)`；间距 4px；`::-webkit-scrollbar` 4px。
  新增三档底色 `--tab-bg-hover/-active/-active-hover`（**浅深两套主题齐补**），活动态改**只靠底色**。
  ⚠️ **几何不变量**：28px = 4 + 20 + 4，**那 4px 滚动条正好吃掉下间隙**，滚动条出现/消失不改栏高；
  `.tab` 高 / `strip` 高 / 滚动条高 / `.tab-insert` 的 top·bottom **四处绑死**（回归断言
  `stripH - tabH === 滚动条高 × 2`）。⚠️ `@keyframes tab-flash` 结束态必须写 `var(--tab-bg-active)`
  （原 `var(--bg)` 会「闪完回旧配色」，一帧的 bug 测不出）；非活动面板降亮度规则要**连 `:hover` 一起覆盖**。
  ⚠️ 标签视觉已摇摆三次（B53 accent 条 → B54 描边 → B55 药丸）：**「描边」是最易被推翻的一项**，
  再改前先确认用户要「描边派」还是「底色派」。

- **B56（0916）标签不再收缩（宽度跟内容走，溢出交给横向滚动）**：用户报「标签变多后标签被压窄、
  文件名被裁剪成 `…`」。根因两处叠加：`.tab { flex: 0 1 auto }`（B53 的「先收缩再滚动」，
  模仿 VS Code `tabSizing: fit`）+ `.tab-name { text-overflow: ellipsis }`；另有
  `.tab { max-width: 200px }` 让长文件名**即使标签不多**也被截断。
  改法 = `.tab` 改 **`flex: 0 0 auto`** 并**删掉 `max-width`**（对应 `tabSizing: fixed`），
  `.tab-name` 改 **`flex: 1 0 auto`** 并删掉 `ellipsis` / `overflow: hidden`（`min-width: 60px` 仅作下限保留）。
  高度几何（20px / 28px = 4+20+4）**当时不变**，只改横向排布（⚠️ B57 已把药丸升到 24px / 栏 32px）。
  💡 教训：**「标签太窄」与「标签太高」是最易被反复推翻的两项** —— 改标签尺寸前先问用户要
  「收缩派」还是「自然宽度派」，别默认抄 VS Code 的 fit。
  ⚠️ 静态断言要先剥 CSS 注释：本批第一版断言被 `.tab` 注释里记录的旧值
  （`flex: 0 1 auto`）误伤 → 新增 `cssDecls()` 辅助函数（`tests/regressions.test.ts`）。
  ⚠️ 副作用：不收缩 ⇒ 更早进入溢出 ⇒ 横向滚动比以前更常出现（预期行为）。

- **B57（0916）标签高度 / 关闭按钮 / 文件类型图标全面对齐 VS Code Modern UI**：
  用户要求「标签高度和关闭按钮也参考下 vscode，vscode 标签上还有图标」，开工前 AskUserQuestion
  确认两处设计：**24px 药丸 / 32px 栏（常规档，非 compact 的 20/28）** + **家族矢量字形 + 家族配色**。
  ① **高度 20→24px**（`EDITOR_TAB_HEIGHT.modernUI = 32 = 4+24+4`）：上游源码注释写明
  「20px 只是刚够放 16px 图标的下限」，24px 才从容 → 几何不变量整体从 `28=4+20+4` 升到 **`32=4+24+4`**，
  四值依旧绑死（`.tab` / `.panel-tabstrip` / 滚动条 / `.tab-insert` top·bottom）。
  ② **关闭/未保存槽位改 `opacity` 显隐**（原 `display:none`）：`.tab-mark`/`.tab-close` 共用
  `.tab-action`（16→20px）固定槽位，`.tab-dirty .tab-mark{opacity:1}`、
  `:hover`/`.tab-active`/`:focus-within` 显示 ×、悬停时 ● 让位 ×；`.tab-close` 改 `color:inherit`；
  非焦点面板 `opacity:0.5`。
  ③ **新增 `src/shell/fileicons.ts`**：10 个家族（md/code/brace/hash/tag/brk/db/diff/build/txt）
  各一 SVG 字形 + `--ficon-*` 配色（浅深两套），`FAMILY_OF` **覆盖 language.ts 全部 56 个 label**，
  未知/`null` 回落 `txt`；`tabstrip` 在名字前插 `.tab-icon`（`data-fam`），`main.ts` 传 `lang`。
  ⚠️ **改 ● 的表示法会连带改测试**：脏状态判定要从「`.tab-mark` 文本含 ●」改为
  「存在 `.tab.tab-dirty`」（B57 槽位恒定存在、靠 opacity 显隐，不能再断「已保存留空」）——
  改了 `tabstrip-scroll` / `smoke.bootstrap` / `view-switch-noedit` 三处。
  新增回归：图标 16px 不收缩 + 10 个 `data-fam` + **浅深两套各 10 个 `--ficon-*`** + 家族覆盖度。

- **B58（0916）应用级 tooltip 自绘层（取代原生 `title`，外观对齐 VS Code hover）**：
  用户要求「优化 tooltips 样式，可参考 vscode 源码」。动机：原生提示由 OS 绘制，**配色/圆角/
  键帽/延迟全不可控**，深色界面里会弹出一个浅色系统气泡。
  ① **新增 `src/shell/tooltip.ts`**：全局单例 `.tooltip` 层 + `data-tip` 系列属性
  （`data-tip` / `-key` / `-detail` / `-placement` / `-group`），**事件委托**（`document` 上
  `mouseover/mouseout/focusin/focusout/mousedown`，`window` 上 `scroll/resize/blur` + `Esc`）。
  导出 `setTip/clearTip/initTooltips/hideTip/isTipVisible/resetTooltipsForTest/computeTipGeometry`。
  ② **数值全部有出处**（逐条写在 `tooltip.ts` 模块注释）：`13px/19px`、`padding:4px 8px`、
  **带指针档圆角 3px**、`PointerSize=3`（caret 6px 方块）、`EdgeMargin=2`、
  `workbench.hover.delay=500`（仅 Windows）、键帽 `11px/min-width 12px/3px 圆角`。
  ③ **两处有意偏离**：`max-width:420px`（VS Code 700px，那是给树视图长文本的）；
  提示层 `pointer-events:none`（**否则鼠标滑到提示上会掐断目标 `:hover`、提示闪烁**）。
  ④ **秒开规则**取 VS Code `groupId`：同 `data-tip-group` 内已有提示时下一个**秒开且不淡入**
  （工具栏 `data-tip-group="toolbar"`、菜单栏 `menubar`、状态栏 `statusbar`、标签 `tabstrip`）。
  ⑤ **定位抽成纯函数 `computeTipGeometry`**（jsdom 无布局，只能喂数字测）：垂直越界翻面、
  水平夹进视口、caret 默认居中/越界对准目标中心/最后夹进框内。
  ⑥ ⚠️ **两个坑**：`.tooltip` / `.tooltip-key` 是 `display:flex`，**`[hidden]` 必须显式
  `display:none`**（同 B30 查找栏）；`setTip` 会给「自身无文本且无 aria-label」的元素**补
  `aria-label`**（原生 `title` 兼任可访问名，去掉后图标按钮会失名）。
  ⑦ **接线**：`index.html` 顶栏按钮改 `data-tip`、`initTooltips()` 在 `bootstrap` 里装配；
  `menubar/menu/tabstrip/splitview/toc/commandpalette/keymapdialog/findbar/main` 共 10 处
  `title` 全部迁到 `setTip`（`keymapdialog.ts` 的 `<option>` 仍留原生 `opt.title`，
  原生下拉覆盖不到自绘层）。
  新增 `tests/tooltip.test.ts`（20 条：纯函数 + DOM 行为）+ `regressions.test.ts` 的 B58 静态块。

- **B59（0917）分屏操作与样式对齐 VS Code（用户选「C 完整对齐」）**：先出
  `docs/split-view-plan.md`（13 项改进 + A/B/C 三档，逐条注上游出处），用户选档后实施。
  ① **`splitview.ts`**：`attachDrag` → **`attachResize(handle, targets[], mode)`**
  （targets = 一对兄弟元素 + 容器 + ratio 回写路径；普通分隔条 1 个、
  **角手柄 2 个 → 斜向同时拖两条**）；`build` 改返回 `BuiltNode {el, split}` 以便挂角手柄；
  `zoneOf` 改 VS Code 的 **1/3 方向优先**（边缘带维持 28%，角部归左右；零尺寸早退 `center`）；
  Alt 落点改判 `center`（临时取消分屏，**无需改 `main.ts`**）；双击复位 50%。
  ② **样式**：新增 `--sep-line`（深 `#444444` / 浅 `#dcdfe3`，**分屏与大纲分隔条共用**）与
  `--drop-fill`（深 `#53595D`@0.5 / 浅 `#2677CB`@0.18）；`.layout-corner` 角手柄（**双类** start/end）；
  `.split-preview` 改「常驻 + `::after` 70ms 位移 / 150ms opacity + **无边框半透明**」；
  极限光标 `.at-min/.at-max`、拖拽中 `.resizing` 染色、`layout-dragging[-v|-corner]` 方向光标。
  ③ ⚠️ `body.layout-dragging` **三处共用**（分屏 / 大纲 `toc.ts` / 查找栏 `findbar.ts`）→
  只加方向修饰类，**别改基础类的语义**。
  ④ ⚠️ `zoneOf` 也被**文件拖入**（`main.ts`）复用；`tabstrip-drag.test.ts` 有**源码级静态断言**
  锁 `clearInsertIndicators();` 紧跟 `const zone = zoneOf(`。
  ⑤ **O8「空面板收起」原本就实现了**（`closeTabById` / `moveTabToPanel` / `splitPanelWithTab`
  三处早已调 `disposePanel`，`removePanel` + `promoteSibling` 即「邻居吃满」）—— 方案里列了但无需改。
  新增 `tests/splitview.test.ts`（15 条）+ `regressions.test.ts` 的 B59 静态块（全量 **341 vitest**）。

- **参考源码库**：`docs/vscode-reference/`（VS Code MIT **只读**副本，分两类，均落 `src/` 被 `.gitignore` 排除）：
  - **A–H 精选约 82 份**（`fetch-vscode-ref.sh` + `REVISION.txt`，commit `632abec`）：逐文件 curl，镜像上游路径，
    B58 后补的 hover / keybindingLabel / 色彩令牌共 12 份已登记进 FILES 与 `INDEX.md` 的「D2. 悬停提示」段；
    `INDEX.md` 按 A–H 说明**每份文件对我们有什么用**。
  - **I 编辑器整模块约 3283 份**（`fetch-vscode-editor-ref.sh` + `REVISION_EDITOR.txt`，commit `9100222`，main 抓取）：
    sparse-clone `src/vs/editor` + `src/vs/base` + `src/vs/platform`，**仅源码**——过滤
    `.test.ts` / worker（`/worker/` 与文件名含 worker 的 `.ts/.css`）/ 语法定义（`/basic-languages/`、`/language/`）。
    导航见 `INDEX.md` 的「I. 编辑器模块」段。
  ⚠️ **`src/` 不入库**（只入库 INDEX/REVISION*/LICENSE + 脚本）：否则上千份上游 `.css/.ts/.tsx` 会被
  pre-commit 的 prettier/eslint 扫到；它是可复现的，需要时重跑脚本。
  ⚠️ 环境坑：① 整仓 clone 走 HTTP/2 易 `CANCEL` 中断 → 设 `git config --global http.version HTTP/1.1` +
  `core.compression 0` + `postBuffer`，用 `--depth 1 --filter=blob:none --sparse`；② 逐文件 curl 走
  `raw.githubusercontent` 间歇限流 → `--retry 4 --retry-all-errors`，或改用 `gh api repos/microsoft/vscode/contents/<path>?ref=main`。
  改观感先读 A 段（Modern UI），改交互读 B/C 段的 `.ts`（重点抄状态机与边界，不抄实现）；I 段是 Monaco/编辑器内核，按需深挖。

## 下一步

- 待办：桌面环境补拍截图（M4 的 keymap.png / command-palette.png + B51 的
  main.png / preferences.png + **B53–B60 的 main.png**：标签栏（含文件类型图标）/面板操作栏/
  分隔条（B60 起细线）/分屏落点高亮（B60 起回退浅蓝）都变了；B58 后**任一控件的悬停提示观感也变了**，可选补一张 tooltip 演示图）。
- **B60（0917）用户反馈三项**：① **分隔条改细** —— 根因不是线宽而是**占位**：
  `flex: 0 0 7px` 的透明空档撑开两侧、露出祖先底色（标签栏行 `--bg-status` vs `--bg`），
  看着就是 7px 粗带；改法 = 元素 `flex: 0 0 0`（**主轴 0、交叉轴仍 stretch 满长**）+
  7px 命中区交给 `::before` 向两侧各溢出 3.5px + `::after` 静息 1px / 激活 4px（VS Code
  sash 是 absolute 浮层不占位）。角手柄随之改成**骑线**（`-4px` + 8px）。
  ② **落点预览回退浅蓝** —— `--drop-fill` 回到 accent @0.22（深 `#4c9ffe` / 浅 `#0969da`）
  + 同色 2px 描边 + 4px 圆角；B59 照搬的 VS Code `dropBackground` 在 LitePad 上边界看不清。
  填充与描边**同源**（都走 `--drop-fill`）。③ **对齐联动**（对标 VS Code 2x2 的
  `linkedSash`，`gridview.ts:715` / `sash.ts:342,622,629`）—— `sashRegistry` +
  `alignedSashesOf()`，判定 **同向 + 中线差 ≤ 2px**（比 VS Code 更通用，覆盖 3×2）；
  转发拖拽/回写/双击复位 + 悬停 `.linked` 高亮；角手柄不参与。
  ⚠️ `sashRegistry` 必须在 `renderSplitview` 清空（旧句柄 `centerOf` 恒 0 → 误判全对齐）。
  测试 346 vitest + 22 cargo；逐条依据见 `docs/split-view-plan.md` 第七节。
- ⚠️ **B60 观感项待桌面环境确认**：1px 静息线是否偏细（VS Code 也是 1px）、4px 激活线宽、
  角手柄骑线后是否好抓、浅蓝落点在深色下是否够醒目；**对齐联动**需真机拖一次 2×2 验证。
- 待清理：`menu.ts` 的 `MenuItem.active` / `.menu-item-current`（B53 后无使用者）。
- 待定：是否发 **v0.3.1**（B55–B59 都改了界面；B54 也留了同一问题未决）。
- M4 之后：M5 规划未定；候选见 DESIGN.md；观感/交互改进可对照 `docs/vscode-reference/`。
- 待用户桌面环境验证的条目散见各日志（沙箱内无法做 UI 冒烟）。
