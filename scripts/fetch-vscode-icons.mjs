#!/usr/bin/env node
/**
 * 从钉住的 microsoft/vscode commit 下载 **codicon 之外** 的 VS Code 图标资源，落到
 * docs/vscode-reference/ 下三个子目录：
 *
 *   - file-icons/seti/  ← extensions/theme-seti/icons/      （seti 文件图标主题）
 *   - theme-icons/      ← src/vs 各 media 目录下的 svg/png  （编辑器/工作台 UI 主题图标）
 *   - product/          ← resources 下的 ico/png/icns        （VS Code 产品 / logo 图标）
 *
 * 与 codicons/ 一样，这些目录只读、不入库（见 .gitignore）。要更新请重跑本脚本。
 *
 * 机制：先调 GitHub git/trees API 枚举整仓文件树（递归，1 次请求），按扩展名 + 路径白名单
 * 过滤出图标资源，再逐颗 curl raw.githubusercontent（带 --ssl-no-revoke + 重试，规避 Windows
 * schannel 证书吊销检查失败与限流）。
 *
 * ⚠️ commit 与 docs/vscode-reference/REVISION.txt 同代（632abec…）。
 * 用法：node scripts/fetch-vscode-icons.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF = join(REPO, "docs/vscode-reference");
/** 与 REVISION.txt / fetch-codicons.mjs 同代钉死。 */
const COMMIT = "632abec535785c5fd76dec5b8ceb2f4c53d8cfc3";
const RAW = `https://raw.githubusercontent.com/microsoft/vscode/${COMMIT}`;
const API = `https://api.github.com/repos/microsoft/vscode/git/trees/${COMMIT}?recursive=1`;
const CACHE = join(REPO, ".tmp", "vscode-icons-tree.json");

/** 图标相关的二进制 / 矢量扩展名。 */
const IMG = new Set([".svg", ".png", ".ico", ".icns", ".woff", ".woff2", ".ttf"]);
const extOf = (p) => {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
};

function curl(url, out) {
  execFileSync(
    "curl",
    [
      "-fsSL",
      "--ssl-no-revoke",
      "--retry",
      "6",
      "--retry-delay",
      "2",
      "--retry-all-errors",
      "--max-time",
      "60",
      "-o",
      out,
      url,
    ],
    { stdio: "pipe" },
  );
}

/** 把仓库内路径分到参考目录下的落点；返回 null 表示不要。 */
function classify(p) {
  // seti 文件图标主题：整目录都要（含 .woff / .yml 映射）
  if (p.startsWith("extensions/theme-seti/icons/")) {
    return join("file-icons/seti", p.slice("extensions/theme-seti/icons/".length));
  }
  if (!IMG.has(extOf(p))) return null;
  // 排除非图标资源：Monaco standalone / 语言定义 / codicon 源（已在 codicons/）/ node_modules
  if (
    p.includes("/standalone/") ||
    p.includes("/basic-languages/") ||
    p.includes("/language/") ||
    p.includes("codicons/codicon") ||
    p.includes("/node_modules/")
  ) {
    return null;
  }
  if (p.startsWith("src/vs/") && p.includes("/media/")) {
    return join("theme-icons", p);
  }
  if (
    p.startsWith("resources/") &&
    !p.includes("/app/") &&
    !p.includes("/cli/") &&
    !p.includes("/server/")
  ) {
    return join("product", p.slice("resources/".length));
  }
  return null;
}

// 1) 拉整仓 tree（递归）。沙箱/网络不稳时复用 .tmp 缓存。
mkdirSync(dirname(CACHE), { recursive: true });
try {
  curl(API, CACHE);
} catch (e) {
  // ⚠️ 抛新错误时必须用 `cause` 带上原始异常：丢掉它，上层就只能看到一句
  //    「tree 拉取失败」，真正的原因（DNS / TLS / 限流）全被吞掉 —— 这正是
  //    eslint `preserve-caught-error` 要拦的。
  if (!existsSync(CACHE)) {
    throw new Error(`tree 拉取失败：${String(e.message).split("\n")[0]}`, { cause: e });
  }
  console.warn("⚠ tree 拉取失败，复用 .tmp 缓存");
}
const tree = JSON.parse(readFileSync(CACHE, "utf8"));
if (tree.truncated) console.warn("⚠ tree 被 GitHub 截断（>100k 条目），可能漏图标");

const targets = [];
for (const e of tree.tree) {
  if (e.type !== "blob") continue;
  const dest = classify(e.path);
  if (dest) targets.push({ src: e.path, dest });
}
console.log(`枚举到图标资源：${targets.length} 个`);

let ok = 0;
const failed = [];
// RESUME=1 跳过已下载成功的文件（断点续传，避免重跑整仓网络）
const RESUME = process.env.RESUME === "1";
for (const t of targets) {
  const out = join(REF, t.dest);
  if (RESUME && existsSync(out) && statSync(out).size > 0) {
    ok++;
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  try {
    curl(`${RAW}/${t.src}`, out);
    ok++;
  } catch {
    // ⚠️ 失败分支**不要**调 rmSync：node-safe-delete-shim 对「单 turn 批量删除」有护栏
    // （阈值 50），会直接抛错中断整个脚本。curl -f 在 HTTP 失败时本就不写文件，
    // 留个空文件无妨；RESUME=1 重跑会自动覆盖。清理交给 .tmp 与 gitignore。
    failed.push(t.src);
  }
}

writeFileSync(
  join(REF, "REVISION_ICONS.txt"),
  `upstream: https://github.com/microsoft/vscode
commit:   ${COMMIT}
fetched:  ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}
license:  MIT
count:    ${ok} 个（失败 ${failed.length}）
scope:    codicon 之外的图标集：
          file-icons/seti  ← extensions/theme-seti/icons（seti 文件图标主题）
          theme-icons      ← src/vs/**/media/*.{svg,png}（UI 主题图标）
          product          ← resources/**/*.{ico,png,icns}（产品/logo 图标）
note:     本目录树不入库（.gitignore），重跑 scripts/fetch-vscode-icons.mjs 复现。
`,
  "utf8",
);

console.log(`完成：${ok}/${targets.length}（失败 ${failed.length}）`);
if (failed.length) {
  console.log("失败清单（多为限流/路径变动，重跑即可）：");
  failed.forEach((f) => console.log("  - " + f));
}
