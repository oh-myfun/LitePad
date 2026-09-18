---
name: litepad-reverse-verify
description: Prove that a LitePad bug fix's regression tests really fail without the fix — patch each fix back out one at a time, run only the affected test files, confirm each guard turns red, and restore the sources byte-identically (hash-checked, never touching .git). Use in E:/Project/LitePad whenever a fix lands with new/updated tests and the user expects the project's "反向验证" requirement to be met.
description_zh: "LitePad 修复交付前的反向验证：逐条把修复改回去，确认对应用例真的会红，再按字节还原"
description_en: "LitePad reverse-verification harness: revert each fix, confirm its guard goes red, restore byte-identically"
agent_created: true
---

# LitePad 反向验证（每条修复都要证明守卫有效）

## 何时使用

- 在 `E:/Project/LitePad` 里刚修完 bug / 加完特性，并补了回归测试，准备提交。
- 项目约定（`MEMORY.md`）把「**改完先反向验证**」列为硬要求：还原修复一次，确认对应用例真会红。
- 静态契约测试（`tests/regressions.test.ts`）尤其需要：只写 `expect(src).toContain("期望片段")`
  很容易写成**永远为真**的守卫（本项目已经踩过两次），必须实测。

## 铁律

1. **绝不碰 `.git`**。不要 `git stash` / `git checkout --` / 任何重操作 ——
   本项目 09-13 曾因之丢掉全部历史。备份与还原都在脚本内存里做。
2. **脚本落 `scripts/reverse-verify-<B号>.cjs` 并入库**（B70 起定版）：每个交付一份、按 B 号命名，
   这样「这条修复当时验过没有」是可复查的。两条实测注意：
   - **必须过 prettier + eslint**：CI 的 `format:check` / `lint` 扫 `scripts/*.{cjs,mjs}`，
     而本地 pre-commit **不扫 `.cjs`** —— 本地绿、CI 红就是这么来的；跑
     `node node_modules/prettier/bin/prettier.cjs -w <file>` 与
     `node node_modules/eslint/bin/eslint.js <file>`（后者常报「无用的 eslint-disable 指令」，
     删掉那行即可）。
   - 草稿一律放**项目内** `E:/Project/LitePad/.tmp/`（项目规则：临时文件不写全局目录，
     见 `MEMORY.md` 项目约定 / `BUILD-ENV.md`「临时文件统一落 `.tmp/`」），定型后搬进 `scripts/`。
     ⚠️ 曾经把草稿放 `%TEMP%`，出现过「写进去后文件消失」，别把它当可信产物。
3. **逐条还原校验**：改回 → 跑测试 → 立即写回原文 → 用 sha256 比对确认逐字节一致 →
   报告里打印「还原一致/不一致」。任何一条不一致都必须立刻人工修。
4. **只跑受影响的测试文件**（`tests/regressions.test.ts`、`tests/tooltip.test.ts`…），
   不要跑全量：一条要 ~10s，九条就三分钟，没必要。
5. **判据是「红」**：脚本绿灯 = 守卫无效，必须回头看断言为什么没生效（这是最有价值的产出）。
6. ⚠️ **`/tmp` 不是项目内**：Git Bash 的 `/tmp` 实测就是 `%TEMP%`
   （`C:/Users/maoyu/AppData/Local/Temp`，**不是** `E:\tmp`）→ 按项目规则不许写，
   脚本路径一律写 `E:/Project/LitePad/.tmp/xxx.cjs`。
   反过来，Python 是 Windows 原生二进制，**既不认 `/c/...` 也不认 `/tmp`**（会把 `/tmp` 按
   当前盘符解析成 `E:\tmp\`），所以命令行参数要写带盘符的绝对路径。

## 硬性守卫（本项目实测最容易写空的两类）

- 断言「某字段真的写进了载荷」时，别只查 `/baseLen/` —— 它会命中**参数表**。
  要连上下文一起断：`/baseLen,\s*\n\s*changes: changes\.toJSON\(\),/`。
- 断言「某个分支存在」时，别只查函数里出现过 `foo(` —— 把守卫条件一起写进正则，
  否则「`if (false && ...)` 关掉的分支」也算命中。
- 顺序类断言（如「必须早于读取 `dataset.tip`」）要用 `indexOf` 比较先后，不能只查存在。

## 脚本模板

```js
// 放 E:/Project/LitePad/.tmp/reverse-verify-<B号>.cjs，用 node 直接跑（cwd 为项目根）；
// 定型后搬进 scripts/ 入库（入库那份必须过 prettier + eslint，见「铁律」第 2 条）。
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");

const ROOT = "E:/Project/LitePad";
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (p) => `${ROOT}/${p}`;

function runVitest(files) {
  try {
    execFileSync(process.execPath, [`${ROOT}/node_modules/vitest/vitest.mjs`, "run", ...files], {
      cwd: ROOT, stdio: "pipe", encoding: "utf-8",
    });
    return true; // 绿
  } catch { return false; } // 红（正是我们要的）
}

const cases = [
  {
    name: "一句话说清这条修复的作用",
    file: "src/xxx.ts",
    from: "修复后的代码（必须能在文件里精确命中，含缩进）",
    to: "还原成修复之前的样子",
    tests: ["tests/regressions.test.ts"],
  },
  // …每条修复一个 case
];

let problems = 0;
for (const c of cases) {
  const original = readFileSync(abs(c.file), "utf-8");
  if (!original.includes(c.from)) { console.log(`✗ 找不到片段：${c.name}`); problems++; continue; }
  const patched = original.replace(c.from, c.to);
  writeFileSync(abs(c.file), patched);
  const green = runVitest(c.tests);
  writeFileSync(abs(c.file), original);
  const restored = hash(readFileSync(abs(c.file), "utf-8")) === hash(original);
  const ok = !green && restored;
  if (!ok) problems++;
  console.log(`${ok ? "✓" : "✗"} ${c.name} → ${!green ? "红（符合预期）" : "⚠️ 仍然绿（守卫无效）"}；还原${restored ? "一致" : "不一致！"}`);
}
console.log(problems === 0 ? "\n全部通过，文件均已还原。" : `\n有 ${problems} 处要处理。`);
```

跑法（会话 shell 会丢 PATH，先显式导出，见 `BUILD-ENV.md`）：

```sh
export PATH="/c/Users/maoyu/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/msys64/mingw64/bin:/c/Users/maoyu/.cargo/bin:/c/Users/maoyu/.workbuddy/binaries/node/versions/22.22.2-3:/c/WINDOWS/System32:$PATH"
node "E:/Project/LitePad/.tmp/reverse-verify-b70.cjs"
```

## 覆盖清单（照这个列 case，别漏）

每条修复至少一条，**上游接线也要算一条**：

- 判据本身（如 `needsChoice` 的第二个参数被忽略）
- 上游是否真的把判据喂进去（如 `main.ts` 里接线写成 `true`）——「函数改对了但没人这么调」
  是最常见的漏网形态
- 顺序/时机（守卫放在读取数据之后 = 白拦）
- 每一条分支各自一条（卫星窗口 / 主窗口、鼠标路径 / 键盘路径）

## 收尾

1. 全绿后跑 `tsc -b` + `node scripts/run-vitest.cjs`（全量）+ prettier/eslint 改动文件。
2. 提交信息里写清「反向验证 N/N 通过」，并记进当日 `.workbuddy/memory/YYYY-MM-DD.md`
   （含**哪几条初版守卫无效、怎么加强的** —— 这是下次最容易重犯的地方）。
