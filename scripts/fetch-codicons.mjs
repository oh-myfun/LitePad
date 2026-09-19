#!/usr/bin/env node
/**
 * 从官方包拉取 VS Code codicon（MIT）里**查找栏用到的**图标轮廓，并把它们内联成
 * `src/shell/codicons.ts`。
 *
 * 为什么这么做（而不是手绘或引字体）：
 *   · 手绘的字形与 VS Code 永远差一档（我们原先自绘的替换图标、文字字形 Aa/ab/.* 就是如此）；
 *   · 引字体要带一个 150KB 的 ttf + 一份 css，而全项目只用到十来颗图标；
 *   · codicon 的 `src/icons/*.svg` 是**纯路径 + fill="currentColor"**，16×16 网格，
 *     内联进来即 1:1 像素对应，零缩放、零依赖。
 * 所以：官方 SVG 抽到 `docs/vscode-reference/codicons/`（只读参考副本，被 gitignore），
 *      生成物 `src/shell/codicons.ts` 入库 —— 它是**构建产物**，不要手改，重跑本脚本即可复现。
 *
 * ⚠️ 版本是**钉死**的：字体/图标在不同 codicon 版本间会改字形。升级要连版本号一起改，
 *    并重跑 + 目视核对 `generated-images` 里的对照页（见 docs/vscode-reference/INDEX.md 的 J 段）。
 *
 * 用法：node scripts/fetch-codicons.mjs        （需要能访问 npm registry）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 钉死的上游版本。与 docs/vscode-reference/REVISION.txt 里的 VS Code 版本同代。 */
const VERSION = "0.0.46-24";
const PKG = "@vscode/codicons";

const REF_DIR = join(REPO, "docs/vscode-reference/codicons");
const OUT_TS = join(REPO, "src/shell/codicons.ts");

/** 生成物的折行宽度，必须与 `.prettierrc.json` 的 printWidth 一致（否则 format:check 会红）。 */
const PRINT_WIDTH = 100;

/**
 * 代码里的短名 → codicon 文件名。
 * ⚠️ `findSelection` 取的是 `list-selection.svg`：官方把 `selection` 与 `list-selection`
 *    合并到同一码位（\eb85，见上游 codiconsLibrary.ts 的 `selection: 0xeb85`），
 *    包内已不存在 selection.svg。VS Code 查找栏的「在选区中查找」用的正是它。
 */
const ICONS = {
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
};

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
 * 取回并解包上游 tgz。
 * ⚠️ 走 `npm pack` 而不是自己 fetch registry：
 *    ① 本机 npm 配的是 npmmirror 镜像，而 node 的全局 fetch **不读** HTTP(S)_PROXY 环境变量
 *       （实测直连 registry.npmjs.org 直接 connect timeout，走 npm 才通）；
 *    ② Windows 上 spawn `npm` 找不到（它是无扩展名的 shell 脚本）、spawn `npm.cmd` 又要
 *       `shell: true` 才行（Node 针对批处理注入的安全修复）—— 这里显式带上。
 */
function downloadPkg(work) {
  execFileSync("npm", ["pack", `${PKG}@${VERSION}`], {
    cwd: work,
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack 没有产出 tgz");
  execFileSync("tar", ["-xzf", tgz, "package/src/icons"], { cwd: work, stdio: "pipe" });
}

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

本目录是 codicon 图标源的**只读参考副本**（只含 src/shell/codicons.ts 用到的那几颗）。
不要在这里改 —— 重跑 scripts/fetch-codicons.mjs 即可复现。
`,
    "utf8",
  );

  // ---- 生成 src/shell/codicons.ts ----
  const odd = entries.filter((e) => e.viewBox !== "0 0 16 16");
  const lines = entries.map((e) => {
    // prettier 的选号规则：字符串里双引号更多时用单引号 → 生成的写法与 src/shell/icons.ts 一致
    const quoted = e.svg.includes("'") ? JSON.stringify(e.svg) : `'${e.svg}'`;
    const oneLine = `  ${e.name}: ${quoted},`;
    // ⚠️ 生成的排版必须与 prettier 一致，否则 `npm run format:check` 会把生成物判成未格式化：
    //    codicon 的 path 数据很长，绝大多数条目都会超过 printWidth（见 .prettierrc.json），
    //    prettier 的折行是「冒号后换行 + 再缩进一级」。PRINT_WIDTH 与配置保持一致。
    return oneLine.length <= PRINT_WIDTH ? oneLine : `  ${e.name}:\n    ${quoted},`;
  });
  writeFileSync(
    OUT_TS,
    `/**
 * 查找栏用的 VS Code codicon 轮廓（16×16，fill=currentColor，零缩放 1:1 落到 16px 图标上）。
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
 * 与 VS Code 的对应关系（findWidget.ts / findInputToggles.ts 的注册名）：
 *   chevronRight/Down → find-collapsed / find-expanded
 *   arrowUp/arrowDown → find-previous-match / find-next-match
 *   replace / replaceAll → find-replace / find-replace-all
 *   findSelection → find-selection（官方码位 \\eb85，与 list-selection 同一字形）
 *   caseSensitive / wholeWord / regex / preserveCase → 输入框内嵌的四颗开关
 *   close → widgetClose
 *${odd.length ? `\n * ⚠️ 上游非 16 视图框的：${odd.map((e) => `${e.name} (${e.viewBox})`).join("、")}。\n` : ""} */
export const CODICONS = {
${lines.join("\n")}
} as const;

/** 图标名（上方 CODICONS 的键）。 */
export type CodiconName = keyof typeof CODICONS;
`,
    "utf8",
  );

  console.log(`✓ ${entries.length} 颗图标 → ${REF_DIR}`);
  console.log(`✓ 生成 ${OUT_TS}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
