// WorkBuddy/bash 会话把 cwd 设为小写盘符（e:\...），
// vitest worker 内部模块 URL 与测试文件解析 URL 盘符大小写不一致，
// 导致 @vitest/runner 双实例、describe 报 "Cannot read properties of undefined (reading 'config')"。
// 这里统一把 cwd 盘符大写化后再启动 vitest。
const { execSync } = require("node:child_process");

let cwd = process.cwd();
if (/^[a-z]:/.test(cwd)) {
  cwd = cwd[0].toUpperCase() + cwd.slice(1);
  process.chdir(cwd);
}

const args = process.argv
  .slice(2)
  .map((a) => `"${a}"`)
  .join(" ");
execSync(`npx vitest run ${args}`, { stdio: "inherit", cwd, env: process.env });
