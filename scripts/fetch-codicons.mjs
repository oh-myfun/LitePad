#!/usr/bin/env node
/**
 * 从官方包拉取 VS Code codicon（MIT）里**全应用用到的**图标轮廓，并把它们内联成
 * `src/shell/codicons.ts`。
 *
 * 为什么这么做（而不是手绘或引字体）：
 *   · 手绘的字形与 VS Code 永远差一档（我们原先自绘的工具栏图标、查找栏文字字形 Aa/ab/.* 就是如此）；
 *   · 引字体要带一个 150KB 的 ttf + 一份 css，而全项目只用到几十颗图标；
 *   · codicon 的 `src/icons/*.svg` 是**纯路径 + fill="currentColor"**，16×16 网格，
 *     内联进来即 1:1 像素对应，零缩放、零依赖。
 * 所以：官方 SVG 抽到 `docs/vscode-reference/codicons/`（只读参考副本，被 gitignore），
 *      生成物 `src/shell/codicons.ts` 入库 —— 它是**构建产物**，不要手改，重跑本脚本即可复现。
 *
 * 🚩 **红线**：应用内所有按钮图标一律取 `CODICONS.<name>`，**不得手绘 SVG**；codicon 里确无
 *    合适字形时先与用户商量是否引入别的图标集（见 docs/conventions.md「图标」节）。
 *    当前唯一豁免：主题的 sun / moon 两颗 —— 官方 639 颗清单里没有日/月字形，经用户确认保留手绘。
 *
 * ⚠️ 版本是**钉死**的：字体/图标在不同 codicon 版本间会改字形。升级要连版本号一起改，
 *    并重跑 + 目视核对 `generated-images` 里的对照页（见 docs/vscode-reference/INDEX.md 的 J 段）。
 *
 * ⚠️ 取图有两条路：默认走 `npm pack`（本机 npm 配的是 npmmirror 镜像，且 node 的全局 fetch
 *    不读代理）；npm 不可用时（如受限沙箱把 npm 拦了）**回退到直连 unpkg 逐颗 curl**。
 *
 * 用法：node scripts/fetch-codicons.mjs        （需要能访问 npm registry 或 unpkg）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 钉死的上游版本。与 docs/vscode-reference/REVISION.txt 里的 VS Code 版本同代。 */
const VERSION = "0.0.46-24";
const PKG = "@vscode/codicons";
const CDN = "https://unpkg.com";

const REF_DIR = join(REPO, "docs/vscode-reference/codicons");
const OUT_TS = join(REPO, "src/shell/codicons.ts");

/** 生成物的折行宽度，必须与 `.prettierrc.json` 的 printWidth 一致（否则 format:check 会红）。 */
const PRINT_WIDTH = 100;

/**
 * 代码里的短名 → codicon 文件名。
 * ⚠️ `findSelection` 取的是 `list-selection.svg`：官方把 `selection` 与 `list-selection`
 *    合并到同一码位（\eb85，见上游 codiconsLibrary.ts 的 `selection: 0xeb85`），
 *    包内已不存在 selection.svg。VS Code 查找栏的「在选区中查找」用的正是它。
 * ⚠️ 主题的浅/深两颗（sun/moon）官方**没有**字形，经用户确认豁免，仍在 `src/shell/icons.ts` 手绘。
 */
const ICONS = {
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
  // —— 工具栏 ——
  newFile: "new-file",
  folderOpened: "folder-opened",
  save: "save",
  saveAs: "save-as",
  search: "search",
  listTree: "list-tree",
  export: "export",
  // —— 主题（sun/moon 无官方字形，见文件头豁免说明）——
  colorMode: "color-mode",
  // —— 面板 / 标签 ——
  chromeRestore: "chrome-restore",
  circleFilled: "circle-filled",
  // —— 标签上的文件类型字形（原 fileicons.ts 的 10 个家族）——
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
};

/**
 * 标签上的**文件类型字形**：家族 → codicon 名（与 `src/shell/fileicons.ts` 的 FAM_ICON 一致）。
 *
 * ⚠️ 10 个家族必须是 10 颗**互不相同**的 codicon —— `regressions.test.ts` 有
 *    「十个家族应有十个不同字形」的断言（`new Set(svgs).size === 10`）。
 *    早先 brace 与 brk 都想用 `symbol-class`，一撞车这条断言就红（且视觉上也分不出
 *    「结构化配置」和「编译型语言」），所以：brace 走 `json`（花括号）、brk 走 `symbol-class`。
 *    下面的 assertFamilies() 会在生成前把这种撞车直接喊出来，别等测试。
 */
const FILE_FAMILIES = {
  md: "markdown",
  code: "code",
  brace: "json",
  hash: "terminal",
  tag: "tag",
  brk: "symbolClass",
  db: "database",
  diff: "diff",
  build: "tools",
  txt: "fileText",
};

/** 生成前的自检：家族映射不得撞车、不得指向没被抽出来的字形。 */
function assertFamilies() {
  const names = Object.values(FILE_FAMILIES);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) {
    throw new Error(`文件类型字形重复：${dup.join("、")} —— 10 个家族必须是 10 颗不同 codicon`);
  }
  const missing = names.filter((n) => !Object.hasOwn(ICONS, n));
  if (missing.length) throw new Error(`文件类型字形没进 ICONS：${missing.join("、")}`);
}

/** 取 `<svg>` 的属性与内容，并统一成 16×16 + aria-hidden（上游 files 是 24 视图框）。 */
function normalize(raw, file) {
  const open = raw.match(/<svg\b([^>]*)>/);
  if (!open) throw new Error(`${file}: 找不到 <svg> 开标签`);
  const viewBox = (/viewBox="([^"]+)"/.exec(open[1]) ?? [])[1];
  if (!viewBox) throw new Error(`${file}: 缺少 viewBox`);
  const body = raw.slice(raw.indexOf(open[0]) + open[0].length, raw.lastIndexOf("</svg>")).trim();
  const svg = `<svg viewBox="${viewBox}" width="16" height="16" fill="currentColor" aria-hidden="true">${body}</svg>`;
  return { svg, viewBox };
}

// ⚠️ 工作目录必须落**项目内**的 `.tmp/`（已 gitignore），不要用系统临时目录 ——
//    见 .workbuddy/memory/MEMORY.md 的「临时文件一律落在本项目内」红线。
mkdirSync(join(REPO, ".tmp"), { recursive: true });
const work = mkdtempSync(join(REPO, ".tmp", "codicons-fetch-"));

/**
 * 直连 unpkg 拉单颗上游 SVG（npm 不可用时的回退路径）。
 * ⚠️ 用 curl 而不是 node 的 fetch：curl 默认读代理/系统证书，受限环境里实测可通。
 */
function curlIcon(destDir, file) {
  execFileSync(
    "curl",
    [
      "-fsSL",
      "--max-time",
      "60",
      `${CDN}/${PKG}@${VERSION}/src/icons/${file}.svg`,
      "-o",
      join(destDir, `${file}.svg`),
    ],
    { stdio: "pipe" },
  );
}

/**
 * 取回并解包上游图标。
 * ⚠️ 首选 `npm pack` 而不是自己 fetch registry：
 *    ① 本机 npm 配的是 npmmirror 镜像，而 node 的全局 fetch **不读** HTTP(S)_PROXY 环境变量
 *       （实测直连 registry.npmjs.org 直接 connect timeout，走 npm 才通）；
 *    ② Windows 上 spawn `npm` 找不到（它是无扩展名的 shell 脚本）、spawn `npm.cmd` 又要
 *       `shell: true` 才行（Node 针对批处理注入的安全修复）—— 这里显式带上。
 *    ③ npm 被环境禁用时回退到 unpkg 逐颗 curl（受限沙箱实测：npm 触发 wsl.exe 被安全策略拦）。
 */
function downloadPkg(work) {
  const iconsDir = join(work, "package", "src", "icons");
  try {
    execFileSync("npm", ["pack", `${PKG}@${VERSION}`], {
      cwd: work,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack 没有产出 tgz");
    execFileSync("tar", ["-xzf", tgz, "package/src/icons"], { cwd: work, stdio: "pipe" });
  } catch (err) {
    console.warn(
      `⚠ npm pack 失败（${String(err.message).split("\n")[0]}），回退到直连 unpkg 逐颗下载`,
    );
    mkdirSync(iconsDir, { recursive: true });
    for (const file of Object.values(ICONS)) curlIcon(iconsDir, file);
  }
}

/**
 * 用 prettier 给生成物收尾。
 *
 * ⚠️ 生成物必须过 `npm run format:check`（CI 门之一）。**不要手写折行规则去猜 prettier** ——
 *    实测「按 printWidth 数长度」在 33 颗里有 5 颗判错（save / code / json / tag / diff
 *    被判成超宽、折了行，而 prettier 认为放得下），`format:check` 直接红。
 *    prettier 本来就在 devDependencies，直接调它即可；万一没装（纯净环境），
 *    退回内置规则并告警 —— 产物功能正确，只是可能过不了 format:check。
 */
async function prettierFormat(code) {
  try {
    const { format } = await import("prettier");
    return await format(code, { filepath: OUT_TS });
  } catch (err) {
    console.warn(
      `⚠ prettier 不可用（${String(err.message).split("\n")[0]}），按内置 PRINT_WIDTH 规则排版`,
    );
    return code;
  }
}

assertFamilies();

try {
  downloadPkg(work);
  mkdirSync(REF_DIR, { recursive: true });
  const entries = [];
  for (const [name, file] of Object.entries(ICONS)) {
    const src = join(work, "package/src/icons", `${file}.svg`);
    const { svg, viewBox } = normalize(readFileSync(src, "utf8"), `${file}.svg`);
    writeFileSync(join(REF_DIR, `${file}.svg`), readFileSync(src));
    entries.push({ name, file, svg, viewBox });
  }

  writeFileSync(
    join(REF_DIR, "REVISION.txt"),
    `upstream: https://github.com/microsoft/vscode-codicons
package:  ${PKG}
version:  ${VERSION}
fetched:  ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}
license:  MIT (见同目录上游包内的 LICENSE)

本目录是 codicon 图标源的**只读参考副本（全量 639 颗）。应用 src/shell/codicons.ts
只引用其中子集，子集的抽取由 scripts/fetch-codicons.mjs 生成、全量补齐由
scripts/fetch-codicons-all.mjs 负责。不要在这里改 —— 重跑这两个脚本即可复现。
`,
    "utf8",
  );

  // ---- 生成 src/shell/codicons.ts ----
  const odd = entries.filter((e) => e.viewBox !== "0 0 16 16");
  const famLine = Object.entries(FILE_FAMILIES)
    .map(([fam, name]) => `${fam}→${name}`)
    .join("、");
  const lines = entries.map((e) => {
    // prettier 的选号规则：字符串里双引号更多时用单引号 → 生成的写法与 src/shell/icons.ts 一致
    const quoted = e.svg.includes("'") ? JSON.stringify(e.svg) : `'${e.svg}'`;
    const oneLine = `  ${e.name}: ${quoted},`;
    // ⚠️ 生成的排版必须与 prettier 一致，否则 `npm run format:check` 会把生成物判成未格式化：
    //    codicon 的 path 数据很长，绝大多数条目都会超过 printWidth（见 .prettierrc.json），
    //    prettier 的折行是「冒号后换行 + 再缩进一级」。PRINT_WIDTH 与配置保持一致。
    return oneLine.length <= PRINT_WIDTH ? oneLine : `  ${e.name}:\n    ${quoted},`;
  });
  let out = `/**
 * 全应用的 VS Code codicon 轮廓（16×16，fill=currentColor，零缩放 1:1 落到 16px 图标上）。
 *
 * ⚠️ **本文件是生成物，不要手改** —— 由 \`node scripts/fetch-codicons.mjs\` 从官方包
 * \`${PKG}@${VERSION}\`（MIT）的 \`src/icons/*.svg\` 逐字抽取。要换图标/升级版本，
 * 改脚本里的 ICONS / VERSION 后重跑。
 * 上游副本落在 \`docs/vscode-reference/codicons/\`（只读、被 gitignore），
 * 取用约定见 \`docs/vscode-reference/INDEX.md\` 的 J 段。
 *
 * 为什么内联而不是引字体：全项目只用到这 ${entries.length} 颗，字体要带 150KB ttf + 一份 css；
 * 而 codicon 的 SVG 是纯路径 + currentColor，内联即与官方**逐字一致**（抽取后已用
 * headless Chromium 把 SVG 与官方字形并排渲染核对过）。
 *
 * 分组（消费方）：
 *   查找栏：chevronRight/Down、arrowUp/Down、replace、replaceAll、findSelection、
 *           caseSensitive、wholeWord、regex、preserveCase、close、files
 *   工具栏：newFile、folderOpened、save、saveAs、search、listTree、export
 *   主题：  colorMode（「跟随系统」；浅/深两颗官方无字形，仍在 src/shell/icons.ts 手绘）
 *   面板 / 标签：chromeRestore、close、circleFilled
 *   文件类型字形（标签）：10 个家族 ↔ 10 颗不同字形 —— ${famLine}
 *
 * ⚠️ 查找栏的注册名对应（findWidget.ts / findInputToggles.ts）：
 *   chevronRight/Down → find-collapsed / find-expanded
 *   arrowUp/arrowDown → find-previous-match / find-next-match
 *   findSelection → find-selection（官方码位 \\eb85，与 list-selection 同一字形）
 *   close → widgetClose
 *${odd.length ? `\n * ⚠️ 上游非 16 视图框的：${odd.map((e) => `${e.name} (${e.viewBox})`).join("、")}。\n` : ""} */
export const CODICONS = {
${lines.join("\n")}
} as const;

/** 图标名（上方 CODICONS 的键）。 */
export type CodiconName = keyof typeof CODICONS;
`;

  writeFileSync(OUT_TS, await prettierFormat(out), "utf8");

  console.log(`✓ ${entries.length} 颗图标 → ${REF_DIR}`);
  console.log(`✓ 生成 ${OUT_TS}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
