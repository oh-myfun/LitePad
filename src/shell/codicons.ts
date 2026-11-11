/**
 * VS Code codicon 的**唯一取用层**（B102 起）。
 *
 * 形态：直接用官方 npm 包 `@vscode/codicons` 的**图标字体**（`@vscode/codicons/dist/codicon.css`
 * + `codicon.ttf`，MIT）。样式由 `src/main.ts` 在最前面引入（早于 `./styles/global.css`，
 * 好让本项目的规则能覆盖它），字体文件由 vite 打进 `dist/assets`。
 *
 * ⚠️ B102 之前这里是**生成物**：`scripts/fetch-codicons.mjs` 从官方包里抽出 `src/icons/*.svg`
 *    内联成本文件，还要为「npm pack / unpkg curl / 本地参考副本」维护三条降级路径。
 *    现在依赖装上即全量可用（639 颗随取随用），升级只是 bump package.json 里的版本号。
 *
 * 取用：`CODICONS.<name>` 给出 `<i class="codicon codicon-<id>"></i>`。
 *   · 字形由字体的 `::before` 绘制，`color` 走继承 —— 与原先 SVG 的 `fill="currentColor"` 同口径；
 *   · 尺寸由 codicon.css 统一给 16px（`font: 16px/1 codicon`），需要别的大小就在 CSS 里
 *     用 `.xxx .codicon { font-size: Npx }` 覆盖（见 global.css 的 `.panel-op .codicon`）。
 *
 * 🚩 **红线（不变）**：应用内所有按钮图标一律取 `CODICONS.<name>`；
 *     · **不得手绘 SVG**；
 *     · **不得写死码位**（`content: "\eb2b"` 这种只该出现在官方 codicon.css 里）；
 *     · codicon 里确无合适字形时，先与用户商量是否引入别的图标集
 *       （见 `docs/conventions.md`「图标」节）。
 */

/**
 * 代码里的短名 → codicon id（= `codicon.css` 里 `.codicon-<id>` 的后缀）。
 *
 * ⚠️ 只收**当前有消费方**的字形：加一颗就要有一个调用点，没有调用点的字形会在改版时
 *    静默腐坏（B97 移走顶栏快捷按钮、B102 换掉单颗 pin 时都清过一批）。
 * ⚠️ `findSelection` 取的是 `list-selection`：官方把 `selection` 与 `list-selection` 合并到
 *    同一码位（\eb85，见上游 `codiconsLibrary.ts` 的 `selection: 0xeb85`），包内已不存在
 *    selection.svg。VS Code 查找栏的「在选区中查找」用的正是它。
 */
const IDS = {
  // —— 查找栏 ——
  chevronRight: "chevron-right",
  chevronDown: "chevron-down",
  arrowUp: "arrow-up",
  arrowDown: "arrow-down",
  replace: "replace",
  replaceAll: "replace-all",
  findSelection: "list-selection",
  caseSensitive: "case-sensitive",
  wholeWord: "whole-word",
  regex: "regex",
  preserveCase: "preserve-case",
  // B421：侧栏搜索「要排除的文件」框里那颗「使用排除设置与忽略文件」
  // （VS Code `ExcludePatternInputWidget.renderSubcontrols` 的 `useExcludesAndIgnoreFiles`）。
  exclude: "exclude",
  // B427：资源管理器过滤框里那颗「跟随 .gitignore / .ignore」。上游这版 codicon 没有
  // `git-ignore`（包内 `codicon-git-ignore:before` 零命中），取 `eye-closed` 读作「不看那些」。
  eyeClosed: "eye-closed",
  close: "close",
  files: "files",
  // —— 自定义标题栏的窗口控制（B97）——
  // chrome-close 比查找栏用的 close 画得更满（同样 16 网格，笔画覆盖到 13.35 而非 12.5），
  // 正是 VS Code 标题栏关闭键那一颗，所以两者并存、各用各的场景。
  chromeMinimize: "chrome-minimize",
  chromeMaximize: "chrome-maximize",
  chromeClose: "chrome-close",
  chromeRestore: "chrome-restore",
  // —— 标题栏右侧的工具键（B99 / B102 / B166）——
  // 「钉在顶部」是**双字形开关**：已置顶画 `pinned`（斜图钉，钉住的状态），
  // 未置顶画 `pin`（空心图钉）。字形直接反映**当前状态**，与按钮的 aria-pressed
  // 和 tooltip 文案（取消钉在顶部 / 钉在顶部）同一口径，读者不必猜哪边是开。
  // B166：不再用 `unpin`（斜杠那颗）当未置顶态 —— 用户点名「pinned 和 pin 图标切换」；
  //   同时**不再靠 `.is-on` 配色**表达状态，全落在字形上。
  pinned: "pinned",
  pin: "pin",
  // —— 更新键（B107，B311 起钉在「左栏开关」左边）——
  // 一颗键按阶段换画法：发现新版本 = cloud-download（点击下载安装），就绪待重启 = refresh
  // （点击 relaunch），这两档是字形；检查中 / 下载中是**圆环**（CSS 画的，见 global.css 的
  // `.upd-ring`：下载按 percent 走，检查中是固定弧长旋转）。
  // 沿革：B107 原本是 loading 旋转 → 换成横进度条 → B311 键搬家后统一成圆环
  // （横条在新位置读起来像一条没对齐的下划线；旋转又回到了「检查中」这一档，但只在手动检查时）。
  cloudDownload: "cloud-download",
  refresh: "refresh",
  // —— 标题栏文档名后的同步滚动键（B152 / B154 / B166）——
  // 取 `link`（链条）而不是 B152 原来那颗 `sync`（圆箭头穿竖线）：链条画的正是
  // 「这几份被连在一起」，而 `sync` 那颗跟右上角更新键（`cloud-download` / `refresh`
  // 那一族）撞形 —— 同在标题栏里两颗都像「转圈」，用户分不清哪个管滚动、哪个管升级。
  // B166：改成与置顶键同款的**双字形开关** —— 开 = `link`（连着），关 = `unlink`；
  //   状态全落在字形上，不再靠 `.is-on` 配色。
  // `unlink` 是**自定义字形**：codicon 官方没有 unlink（只有 link / link-external），
  //   用户点名自己造一颗，并在「去杠 / 叠斜线」两个方案里挑了**去杠** —— 实现 =
  //   官方 `link` 字形 + `.codicon-unlink` 的 CSS 抹掉中间那根连接杆（y=7..8 的横杠），
  //   官方路径一个字节都不改（「不得手绘 SVG」红线的满足方式：裁剪而非绘制）。
  //   抹杠的规则在 global.css（`.codicon-unlink::after`），这里只负责挂上修饰类。
  link: "link",
  unlink: "link codicon-unlink",
  // —— 标题栏左栏显隐开关（B198）——
  // 与置顶 / 同步滚动那两颗同款**双字形开关**：左栏在 = `layout-sidebar-left`（画的是
  // 「左栏已经展开」），左栏收 = `layout-sidebar-left-off`（画的是「左栏不在了」）。
  // ⚠️ 与 VS Code 的差别在**生效范围**：那边只折展开区、活动栏仍留 ⇒ 按钮一直显示；
  //   本软件按用户点名「直接隐藏整个左边栏」（按钮列 + 展开区 + 中间缝一起收光）。
  //   两边都不靠 `.is-on` 配色表达状态，全落在字形上，tooltip / aria-label 跟着换。
  layoutSidebarLeft: "layout-sidebar-left",
  layoutSidebarLeftOff: "layout-sidebar-left-off",
  // —— 侧栏（B195）——
  // ① 大纲：用户裁决取 `symbol-class`（那对花括号 `{ }`，即 VS Code outline 的符号图标）。
  //    ⚠️ 别改回 `list-tree`：那是层级树，管的是「大纲树长什么样」，而这一档要表达的
  //       是「这是代码符号列表」—— 与 symbolClass（fileicons 那一族）同一套语义。
  outline: "symbol-class",
  // ② 空隙里的拖拽把手：用户点名「三个点」⇒ `kebab-vertical`（竖排三点）。
  //    `gripper`（六点两列）是 VS Code 拖动手柄那一族，点更多、更密，在 4px 宽的
  //    缝里会糊成一团，且与 kebab 那颗同为「点阵」，所以只留三点的这颗。
  grip: "kebab-vertical",
  // —— 侧栏第二颗键（B305 最近打开）——
  // `history`（带箭头的时钟，VS Code「最近使用」那一族用的就是它）；清单标题栏那颗
  // 清空键取 `trash`（与「全部折叠」那两颗同为标题栏小动作键，只用字形不写文字）。
  history: "history",
  trash: "trash",
  // —— 侧栏展开区的全量折叠 / 展开（B205）——
  // 字形照 VS Code `outlineActions.ts`：Collapse All 用 `collapse-all`（两道相向的
  // 折角，把整棵树收起来），Expand All 用 `expand-all`（反向）。那两颗按钮的 `when`
  // 是「还没全折 / 还没全开」，本软件**两颗常驻**（与置顶 / 同步滚动同口径：
  // 状态全落在字形上，读者不必猜哪边是开），所以不需要为它们准备反相字形。
  collapseAll: "collapse-all",
  expandAll: "expand-all",
  // —— 侧栏第三颗键与资源管理器（B314）——
  // 按钮列那颗取 `files`（两张纸，VS Code 活动栏给 Explorer 用的正是它，上面 `files`
  // 那颗归查找栏那族用）。树里两颗：**双字形开关**照本应用一贯口径落在字形上 ——
  // 目录收起画 `folder`（空心合口）、展开画 `folder-opened`（开口）。
  folder: "folder",
  folderOpened: "folder-opened",
  // 文件用通用的 `file`（白纸折角）。不按扩展名换字形：`src/shell/fileicons.ts` 那十族
  // 是**标签**上的身份标记，树里再画一遍就是两套口径。
  file: "file",
  // 标题栏两颗新建：官方名 `new-file` / `new-folder`（带 + 号的那两颗）。
  newFile: "new-file",
  newFolder: "new-folder",
  // —— 侧栏按钮列底部（B353 设置入口）——
  // `gear` 就是 VS Code 给「设置」用的那一颗（上游 `preferencesIcons.ts` 的
  // `settingsMoreActionIcon = Codicon.gear`）；按钮列底部放管理类动作也是它的位置。
  gear: "gear",
  // B437 设置窗标题栏：用户点名「是 settings，不是 gear」—— codicon 里这是两颗
  // 不同的字形（settings 带横档的滑杆钮，gear 是纯齿轮）。
  settings: "settings",
  // —— 面板 / 标签 ——
  circleFilled: "circle-filled",
  // —— 标签区右侧的 Markdown 操作键（B224，对齐 VS Code 的 editor/title 动作）——
  // ①「打开侧边预览」：`open-preview` 是 VS Code `markdown.showPreviewToSide` 那一颗
  //    （文档 + 向右的开口），语义正是「在旁边开一份预览」，不必另挑字形。
  openPreview: "open-preview",
  // ②「切换源码 / 预览」是**双字形开关**，与置顶 / 同步滚动 / 左栏那三颗同款：
  //    字形直接反映**当前状态** —— 源码态画 `preview`（点了进预览），预览态画
  //    `edit-code`（点了回源码）；tooltip / aria-label 跟着换，读者不必猜哪边是开。
  //    ⚠️ 别写成「一颗 + .is-on 配色」：状态落在颜色上，暗色主题下几乎分不出来。
  preview: "preview",
  editCode: "edit-code",
  // `edit` 现在的消费方是图片块那颗「编辑图片」键（B410）。页面内「预览 ↔ 编辑」
  // 切换键 B445 起改锁形一对（见下面 `lock` / `unlock`）—— `eye` 随之零调用点，
  // 按本文件的红线删掉（留着会在改版时静默腐坏）。
  edit: "edit",
  // B462 · 预览块右上角的复制键（代码 / 公式 / 图块共用）。`copy` 是 VS Code
  // notebook / markdown preview 那一族用的同一颗；反馈态换 `check`（上面已有）。
  copy: "copy",
  // B418 · 面板最大化后的「还原面板」：取 `screen-normal`（两个错开的方框，
  // VS Code 给「还原编辑器组大小」用的就是它，见 auxiliaryEditorPart.ts 的
  // `icon: Codicon.screenNormal`）。窗口标题栏那颗「向下还原」仍用
  // chrome-restore —— 那是**窗口**的还原，与**面板**是两件事，别合并。
  screenNormal: "screen-normal",
  // —— 标签上的文件类型字形（10 个家族，见 src/shell/fileicons.ts）——
  markdown: "markdown",
  code: "code",
  json: "json",
  terminal: "terminal",
  tag: "tag",
  symbolClass: "symbol-class",
  database: "database",
  diff: "diff",
  tools: "tools",
  fileText: "file-text",
  // —— B365 居顶快速选择（照 VS Code quick input）——
  // 搜索框左侧的放大镜与选中项左侧的勾，都取官方字形，不手绘。
  search: "search",
  check: "check",
  // —— B389 侧栏搜索视图（照 VS Code `searchIcons.ts` 的注册表逐颗取名）——
  // · `searchLarge` = 活动栏那颗搜索键的字形（VS Code `search-view-icon` → `search-large`），
  //   与快速选择那颗小放大镜不是一颗，别混用；
  // · `ellipsis` = 「切换搜索详情」那颗 ⋯（`search-details` → `ellipsis`）；
  // · `clearAll` = 「清除搜索结果」（`search-clear-results` → `clear-all`），与垃圾桶
  //   （`trash`，最近打开那颗「清空全部」）不同款：那边删的是**账**，这边清的只是**这一屏**。
  searchLarge: "search-large",
  ellipsis: "ellipsis",
  clearAll: "clear-all",
  // B417 ·「仅在打开的编辑器中搜索」那颗开关：VS Code `patternInputWidget.ts` 的
  // `useSearchInEditorsBox` 用的就是 `Codicon.book`（`codicon-book`，官方字体自带）。
  book: "book",
  // —— B444 · Markdown 格式工具条（用户点名「工具条按钮图标尽量使用 codicon」）——
  // 这一族取代 B431 的 Vditor SVG sprite（`shell/vditorIcons.ts` 已随之删除）。
  // B446（用户看了「就近替身」仍要改）：公式 / 下划线 / 上标 / 下标四颗**不再借字形**，
  // 改走 `shell/toolbarMarks.ts` 里按同笔补画的四枚（官方 746 颗里确无这四件事的字形）。
  // 当时借来的 `symbol-numeric`（⌗）、`graph`（柱状图）、`type-hierarchy-super/sub` 全部
  // 撤册（红线：不躺零调用点的 id）；`whole-word` 留着 —— 查找栏与资源管理器过滤框那颗
  // 「全词」开关还在用，只是不再当下划线的替身。
  textSize: "text-size", // 标题：一大一小两个 A = 字阶
  listUnordered: "list-unordered",
  listOrdered: "list-ordered",
  tasklist: "tasklist", // 任务列表（带勾的那一行行）
  quote: "quote", // 引用：一对引号
  horizontalRule: "horizontal-rule",
  listTree: "list-tree", // 插入目录：分级缩进的条目
  table: "table",
  // B448 · Mermaid 那颗 `type-hierarchy` 下册：它画的是**圆节点**的组织图，而 mermaid
  // 流程图是方框 + 折线箭头 —— 用户点名「调整」。补画册多收第 5 枚 `flowchart`，
  // 于是这里不留零调用点的 id（红线）。
  // B450 · `indent` 跟着下册：用户点名缩进两颗要「文本编辑器里常用的那种」形状（四行字 +
  // 一支箭头），codicon 那颗不是 ⇒ 两颗都进补画册（`indent` / `outdent`），
  // 减少缩进也不再靠镜像凑。
  bold: "bold",
  italic: "italic",
  strikethrough: "strikethrough",
  bracket: "bracket", // 行内代码：`|`
  paintcan: "paintcan", // 高亮：一罐漆
  fileMedia: "file-media", // 图片：纸上那座小山
  // B445 · 页面内那颗「预览 ↔ 编辑」切换键（B401 起在工具条里，是这一组最左一颗）。
  // 字形是「点了会去的那一档」：编辑档（可写）画 `lock` = 点了锁上进预览。
  // B450（用户点名）预览档改画 `edit` = 点了进编辑 —— 原先那颗 `unlock` 随之下册（红线：
  // 不留零调用点的 id），「开锁」这层意思由那颗铅笔直接说出来了。
  lock: "lock",
  // B447 · 工具条左侧那组「历史」三颗。**官方册里有 `redo`、有 `save`，独独没有 `undo`**
  // （逐条对过 `@vscode/codicons/dist/codicon.csv`）—— 用户拍板不为此再画一枚字形，
  // 撤销那颗直接用 `redo` 配 `.md-preview-tool--flip` 水平镜像：同一颗、同尺寸、天然成对。
  // 于是 `undo` 这颗**没有**独立短名（写了就是零调用点的 id，红线不让）。
  redo: "redo",
  save: "save",
  // —— 差异标题栏（B461 Task 8）——
  // 只补**真有调用点**的（本文件那条红线）：`arrow-up` / `arrow-down` 上方查找栏那族已有。
  // 上游 `swapDiffEditors` 的 `arrow-swap` **不进册**：那条只在「⋯」菜单里出现、靠中文标签认，
  // LitePad 的菜单条目一律不带字形（`MenuItem.icon` 的口径是「同组每项都带、且标签认不出」
  // 才给）⇒ 写了就是零调用点的 id。
  // `fold` / `unfold` 是例外：折条自己就要 unfold（`hideUnchangedRegionsFeature.ts` 的
  // `renderLabelWithIcons('$(unfold)')`），整段展开后行号区那颗收起按钮要 fold（上游
  // `unchangedLinesDecorationShow` 的 `codicon-fold`）—— 两颗都有真调用点。
  fold: "fold",
  unfold: "unfold",
  whitespace: "whitespace", // 「显示首尾空白差异」（带 toggled 状态的那颗）
  map: "map", // 「折叠 / 显示未改动的内容」
  // B461：差异格的三处字形，全部照 VS Code 源码取同名图标。
  // · add / remove = `registrations.contribution.ts` 的 `diff-insert` / `diff-remove`
  //   （行号槽那两颗记号，11px）；
  // · arrowRight = `revertButtonsFeature.ts` / `diffEditor.contribution.ts` 的
  //   `Codicon.arrowRight`（中间那列的「回退此块」）。
  add: "add",
  remove: "remove",
  arrowRight: "arrow-right",
} as const;

/** 图标短名（上方 IDS 的键）。 */
export type CodiconName = keyof typeof IDS;

/**
 * 短名 → 可直接塞进 `innerHTML` 的字形元素。
 *
 * `<i>` + `aria-hidden` 是刻意的：字形由 `::before` 的码位绘制，对读屏器不是有意义的内容，
 * 显式隐藏省得个别实现把它念出来；按钮的可访问名由各自的 `aria-label` 承担。
 */
export const CODICONS = Object.fromEntries(
  (Object.entries(IDS) as [CodiconName, string][]).map(([name, id]) => [
    name,
    `<i class="codicon codicon-${id}" aria-hidden="true"></i>`,
  ]),
) as Record<CodiconName, string>;
