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
     见 `MEMORY.md` 关键红线 / `docs/build-env.md`「临时文件统一落 `.tmp/`」），定型后搬进 `scripts/`。
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
- ⚠️ **「不得出现 X」型断言会被注释误伤**（B72 实测的假红）：文件里往往正写着
  「为什么不能写死 X」的注释，于是断言「全文不含 X」永远失败。要先**剥掉注释**再断言，
  而且最好**只截目标函数的函数体**（把 `const fn = (` 到下一个顶层 `}` 之间切出来）——
  这样断言既不含解释性文字，也不会被别处的同名写法干扰。
- ⚠️ **一个 `from` 片段必须全文唯一命中**（B72 实测的假绿）：`String.replace` 只改**第一处**，
  若该片段在文件里出现多次，被改的可能根本不是这条修复所在的地方 ——
  此时无论脚本判红还是判绿，都**不构成任何证据**。模板里已把它当硬失败处理。
- ⚠️ **「还原点」必须落在因果链上最终决定值的那一处**（B73 实测的假绿）：同一个状态常常被写多次，
  若改回的是**创建时**的默认值，而之后 `open()` / 重新渲染又会把它复位，则该 case **恒绿**、
  不构成证据。改前先顺一遍「谁最后写这个值」，`from` 落在**最后生效**那一处
  （B73 折叠替换行：默认态判据在 `setReplaceExpanded`，改创建处的 `hidden = true` 测不出来）。
- ⚠️ **显隐 / 样式类修复不能只断言状态值**（B73 实测的假绿）：`expect(el.hidden).toBe(true)`
  在「属性确实置位、但样式让它照样可见」时**仍会通过**（`[hidden]` 被 `display:flex` 盖掉）。
  必须再断一条**让状态真正生效的样式规则**存在（如 `.find-row-replace[hidden]{display:none}`），
  且用正则匹配**整块规则**（`/[^}]*display:\s*none/`）而不是 `toContain("display: none")` ——
  后者会被文件里别的 `display:none` 假绿。
- ⚠️ **多条修复覆盖同一症状时，单独还原一条可能不红**（B76 实测的假绿）：同一症状常见于
  写了「两处保险」（如状态行既在创建时 `hidden = true`，又在 `syncAllDocs` 里 `setStatus("")`）。
  只还原其中一处，另一处仍把症状压住 → 该 case 恒绿。**改断言、别改 case**：把断言挪到
  **只有这一处能影响**的时机。B76 的做法是断言 `open()` **之前**的状态 —— 那里只有「创建时收起」
  生效，`syncAllDocs` 还没跑，于是还原它必红。
- ⚠️ **jsdom 没有布局**：`getBoundingClientRect().height` 恒为 0、`offsetParent` 恒为 null。
  断「高度是 0 / 元素真的没占位」在 jsdom 里**等于没断**。要么断属性/类名，要么像 B76 那样
  另用真浏览器量（`.tmp/` 里放一页 `chrome --headless --dump-dom` 把
  `getBoundingClientRect()` 写成文本再读回来）。

## 脚本模板

```js
// 放 E:/Project/LitePad/.tmp/reverse-verify-<B号>.cjs，用 node 直接跑（cwd 为项目根）；
// 定型后搬进 scripts/ 入库（入库那份必须过 prettier + eslint，见「铁律」第 2 条）。
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync, execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf-8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function runVitest(files) {
  try {
    execSync(`node ${join(ROOT, "scripts/run-vitest.cjs")} ${files.join(" ")}`, {
      cwd: ROOT, stdio: "pipe", timeout: 300000,
    });
    return true; // 绿
  } catch { return false; } // 红（正是我们要的）
}

// Rust 用例（B72 起）：runner: "cargo"。⚠️ 会话 shell 会整体丢 PATH，
// 别指望环境，脚本里自己把 MSYS2 MinGW + cargo 拼进 PATH，否则 windres 报 NotAttempted。
function runCargo(filters) {
  const PATH = [
    "C:/Users/maoyu/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin",
    "C:/msys64/mingw64/bin", "C:/Users/maoyu/.cargo/bin", "C:/WINDOWS/System32",
    process.env.PATH,
  ].join(";");
  try {
    execSync(`cargo test ${filters.join(" ")}`, {
      cwd: join(ROOT, "src-tauri"), stdio: "pipe", timeout: 900000,
      env: { ...process.env, PATH },
    });
    return true;
  } catch { return false; }
}

const CASES = [
  {
    name: "一句话说清这条修复的作用",
    file: "src/xxx.ts",
    from: "修复后的代码（必须全文唯一命中，含缩进）",
    to: "还原成修复之前的样子",
    tests: ["tests/regressions.test.ts"],
    // runner: "cargo",   // Rust 用例才写；tests 这里是 filter 名，如 ["browser_args_follow"]
  },
  // …每条修复一个 case
];

let bad = 0, broken = 0, n = 0;
for (const c of CASES) {
  const orig = read(c.file);
  const origHash = sha(orig);
  const hits = orig.split(c.from).length - 1;
  if (hits === 0) { console.log(`✗ ${c.name} —— 源码里找不到片段，判据失效`); bad++; continue; }
  if (hits > 1) { console.log(`✗ ${c.name} —— 片段出现 ${hits} 次，判据失效`); bad++; continue; }
  try {
    write(c.file, orig.replace(c.from, c.to));
    const green = c.runner === "cargo" ? runCargo(c.tests) : runVitest(c.tests);
    n++;
    console.log(`${green ? "✗ 无效守卫" : "✓ 会变红"}  ${c.name}`);
    if (green) bad++;
  } finally {
    write(c.file, orig); // 逐字节还原，不一致就是在破坏工作区
    if (sha(read(c.file)) !== origHash) { console.log(`✗ ${c.name} 还原不一致`); broken++; }
  }
}
console.log(bad === 0 && broken === 0
  ? `\n${n}/${CASES.length} 条都能抓到对应缺陷，文件均已逐字节还原。`
  : `\n有 ${bad} 条守卫无效、${broken} 处还原不一致。`);
process.exit(bad === 0 && broken === 0 ? 0 : 1); // 非零码：别让人只看最后一行就以为过了
```

跑法（会话 shell 会丢 PATH，先显式导出，见 `ref/session-env.md` / `docs/build-env.md`）：

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
2. 提交信息里写清「反向验证 N/N 通过」，并记进当日 `.workbuddy/memory/open-items/YYYY-MM-DD.md`
   （含**哪几条初版守卫无效、怎么加强的** —— 这是下次最容易重犯的地方）。
