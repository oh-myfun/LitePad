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
  close: "close",
  files: "files",
  // —— 自定义标题栏的窗口控制（B97）——
  // chrome-close 比查找栏用的 close 画得更满（同样 16 网格，笔画覆盖到 13.35 而非 12.5），
  // 正是 VS Code 标题栏关闭键那一颗，所以两者并存、各用各的场景。
  chromeMinimize: "chrome-minimize",
  chromeMaximize: "chrome-maximize",
  chromeClose: "chrome-close",
  chromeRestore: "chrome-restore",
  // —— 标题栏右侧的工具键（B99 / B102）——
  // 「钉在顶部」是**双字形开关**：已置顶画 `pinned`（斜图钉，钉住的状态），
  // 未置顶画 `unpin`（斜图钉 + 斜杠）。字形直接反映**当前状态**，与按钮的 aria-pressed
  // 和 tooltip 文案（取消钉在顶部 / 钉在顶部）同一口径，读者不必猜哪边是开。
  // （B102 之前只用一颗 `pin` + 按钮配色表达状态，用户要求改成两颗字形切换。）
  pinned: "pinned",
  unpin: "unpin",
  // —— 右上角更新键（B107）——
  // 三态共用一颗按钮、字形即状态：发现新版本 = cloud-download（点击下载安装），
  // 下载中 = loading（配 .is-busy 的旋转动画），就绪待重启 = refresh（点击 relaunch）。
  cloudDownload: "cloud-download",
  loading: "loading",
  refresh: "refresh",
  // —— 面板 / 标签 ——
  circleFilled: "circle-filled",
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
