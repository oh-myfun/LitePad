// run-vitest.cjs 的直调版：不走 npx（会话内 npx 解析偶发失败），
// 直接用当前 node 运行 vitest CLI；保留盘符大写化修复。
const { execFileSync } = require("node:child_process");
const path = require("node:path");

let cwd = process.cwd();
if (/^[a-z]:/.test(cwd)) {
  cwd = cwd[0].toUpperCase() + cwd.slice(1);
}
process.chdir(cwd);

const vitestCli = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const args = ["run", ...process.argv.slice(2)];
execFileSync(process.execPath, [vitestCli, ...args], {
  stdio: "inherit",
  cwd,
  env: process.env,
});
