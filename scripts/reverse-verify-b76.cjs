// B76 反向验证：把「查找栏三处报障」的每处修复分别「还原」一次，确认对应用例真的会红。
// 用法：node scripts/reverse-verify-b76.cjs
//
// 铁律（照 litepad-reverse-verify 技能）：
//   · 全程不碰 .git —— 备份/还原都在本进程内存里做，还原后按 sha256 逐字节自检。
//   · **红才是通过**：脚本报「会变红」才说明那条守卫真能抓到缺陷；报「无效守卫」必须回头改断言。
//   · `from` 片段必须在文件里**只出现一次**（脚本会数），否则 replace 可能改错地方 → 判据失效。
const { readFileSync, writeFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf-8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const CASES = [
  // ---------------------------------------------------------------- ① 浮层底部那条空白
  {
    name: "状态行创建后不收起（主行下面吊一条空白）",
    file: "src/shell/findbar.ts",
    from: "  status.hidden = true;",
    to: "  status.hidden = false;",
    tests: ["tests/findbar.test.ts"],
  },
  {
    name: "状态行空文本不收（文案清空后仍占位）",
    file: "src/shell/findbar.ts",
    from: "    status.hidden = !text;",
    to: "    status.hidden = false;",
    tests: ["tests/findbar.test.ts"],
  },
  {
    name: "熄灭跨文档不清「N 条结果」文案",
    file: "src/shell/findbar.ts",
    from: '      setHits([]);\n      setStatus("");',
    to: "      setHits([]);",
    tests: ["tests/findbar.test.ts"],
  },
  // ---------------------------------------------------------------- ② 徽标数字
  {
    name: "徽标不按记着的文档数渲染（点亮后是空徽标）",
    file: "src/shell/findbar.ts",
    from: "    badge.textContent = String(docCount);",
    to: "    // 还原：只等 setDocCount 来写数字",
    tests: ["tests/findbar.test.ts"],
  },
  {
    name: "打开查找栏时不喂文档数（懒建后首次点亮必空）",
    file: "src/main.ts",
    from: "  bar.setDocCount(docs.size);",
    to: "  // 还原：不喂文档数",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "徽标溢出按钮盒（负偏移，盖住关闭按钮）",
    file: "src/styles/global.css",
    from: "  top: 0;\n  right: 0;\n  font-size: 8px;",
    to: "  top: -6px;\n  right: -6px;\n  font-size: 8px;",
    tests: ["tests/regressions.test.ts"],
  },
  // ---------------------------------------------------------------- ③ 选区锚点冻结
  {
    name: "范围又实时读选区（步进后塌缩成 1 条）",
    file: "src/main.ts",
    from: "  return restrictToRange(matches, currentFindRestrict(q));",
    to: "  return restrictToRange(matches, q.inSelection ? activeSelectionRange() : null);",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "每次查询都重播种锚点（打字也会把范围收窄）",
    file: "src/main.ts",
    from: "  if (q.inSelection !== findSelectionOn) {\n    findSelectionOn = q.inSelection;\n    if (q.inSelection) seedFindSelectionAnchor();\n    else findSelectionAnchor = null;\n  }",
    to: "  if (q.inSelection) seedFindSelectionAnchor();\n  else findSelectionAnchor = null;",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "换文档不重播种（旧偏移量套到新文档上）",
    file: "src/main.ts",
    from: "  if (findSelectionOn && findSelectionAnchor?.docId !== activeTabIdOf()) seedFindSelectionAnchor();\n",
    to: "",
    tests: ["tests/regressions.test.ts"],
  },
];

function runVitest(files) {
  try {
    execSync(`node scripts/run-vitest.cjs ${files.join(" ")}`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 300000,
    });
    return true; // 全绿
  } catch {
    return false; // 有红（正是我们要的）
  }
}

let bad = 0;
let n = 0;
let broken = 0;
for (const c of CASES) {
  const orig = read(c.file);
  const origHash = sha(orig);
  const count = orig.split(c.from).length - 1;
  if (count === 0) {
    console.log(`✗ ${c.name} —— 源码里找不到要替换的片段（判据失效）`);
    bad++;
    continue;
  }
  if (count !== 1) {
    console.log(`✗ ${c.name} —— 替换片段出现 ${count} 次，判据失效`);
    bad++;
    continue;
  }
  try {
    write(c.file, orig.replace(c.from, c.to));
    const green = runVitest(c.tests);
    n++;
    console.log(`${green ? "✗ 无效守卫" : "✓ 会变红"}  ${c.name}`);
    if (green) bad++;
  } finally {
    write(c.file, orig);
    if (sha(read(c.file)) !== origHash) {
      console.log(`✗ ${c.name} —— 还原后与原文不一致，请手工检查 ${c.file}`);
      broken++;
    }
  }
}

console.log(
  bad === 0 && broken === 0
    ? `\n${n}/${CASES.length} 条用例都能真正抓到对应缺陷，文件均已逐字节还原。`
    : `\n有 ${bad} 条守卫无效、${broken} 处还原不一致。`,
);
process.exit(bad === 0 && broken === 0 ? 0 : 1);
