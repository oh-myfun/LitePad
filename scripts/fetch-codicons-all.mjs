#!/usr/bin/env node
/**
 * 下载 @vscode/codicons 的**全量**图标（639 颗）到 docs/vscode-reference/codicons/，
 * 作为完整参考库。与 scripts/fetch-codicons.mjs（只抽应用用到的子集并生成
 * src/shell/codicons.ts）互补：本脚本**只填参考副本**，绝不碰 codicons.ts。
 *
 * 为什么需要它：fetch-codicons.mjs 出于体积考虑只保留应用实际用到的那几颗，导致
 * docs/vscode-reference/codicons/ 长期只有「一小部分」。本脚本把官方包 src/icons/*.svg
 * （共 639 颗，版本钉死 0.0.46-24）全量补齐，并附带 dist/codicon.ttf / codicon.css。
 *
 * ⚠️ 版本钉死，与 docs/vscode-reference/REVISION.txt、fetch-codicons.mjs 的 VERSION 同代。
 * ⚠️ 复制的是**原始上游 SVG**（与 fetch-codicons.mjs 写入参考副本的 34 颗同款、未改字形），
 *    应用内联用的归一化版在 src/shell/codicons.ts（由 fetch-codicons.mjs 生成）。
 *
 * 用法：node scripts/fetch-codicons-all.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, copyFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 必须和 fetch-codicons.mjs 的 VERSION 一致（钉死的同代 codicon）。 */
const VERSION = "0.0.46-24";
const PKG = "@vscode/codicons";
const REF_DIR = join(REPO, "docs/vscode-reference/codicons");

mkdirSync(join(REPO, ".tmp"), { recursive: true });
const work = mkdtempSync(join(REPO, ".tmp", "codicons-all-"));

/** 取回并解包上游图标（优先 npm pack，与 fetch-codicons.mjs 同机制）。 */
function downloadPkg() {
  execFileSync("npm", ["pack", `${PKG}@${VERSION}`], {
    cwd: work,
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack 没有产出 tgz");
  execFileSync("tar", ["-xzf", tgz], { cwd: work, stdio: "pipe" });
}

downloadPkg();

const iconsDir = join(work, "package", "src", "icons");
const icons = readdirSync(iconsDir).filter((f) => f.toLowerCase().endsWith(".svg"));
if (!icons.length) throw new Error(`在 ${iconsDir} 找不到任何 svg`);

mkdirSync(REF_DIR, { recursive: true });
let n = 0;
for (const f of icons) {
  copyFileSync(join(iconsDir, f), join(REF_DIR, f));
  n++;
}

// 字体 + css 也落参考副本，便于离线对照字形
for (const rel of ["dist/codicon.ttf", "dist/codicon.css"]) {
  const base = rel.split("/").pop();
  try {
    copyFileSync(join(work, "package", rel), join(REF_DIR, base));
  } catch {
    console.warn(`⚠ 没找到 ${rel}，跳过`);
  }
}

writeFileSync(
  join(REF_DIR, "REVISION.txt"),
  `upstream: https://github.com/microsoft/vscode-codicons
package:  ${PKG}
version:  ${VERSION}
fetched:  ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}
license:  MIT
count:    ${n} 颗 SVG（全量）+ codicon.ttf / codicon.css
note:     本目录是 codicon 图标源**全量**只读参考副本。应用 src/shell/codicons.ts 只引用其中
          子集，由 scripts/fetch-codicons.mjs 生成；全量补齐由 scripts/fetch-codicons-all.mjs 负责。
          不要在这里改 —— 重跑这两个脚本即可复现。
`,
  "utf8",
);

rmSync(work, { recursive: true, force: true });
console.log(`codicons 全量已写入：${n} 颗 SVG + ttf/css → ${REF_DIR}`);
