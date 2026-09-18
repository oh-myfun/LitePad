// B73 反向验证：把「查栏方案 C」的每处改动分别「还原」一次，确认对应用例真的会红。
// 用法：node scripts/reverse-verify-b73.cjs
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
  // ---------------------------------------------------------------- 去掉标题栏 / 拖动
  {
    name: "可拖动标题栏复活（方案 C 已删除）",
    file: "src/shell/findbar.ts",
    from: "  dom.append(rowMain, rowReplace, results, status);",
    to: '  const t = document.createElement("div");\n  t.className = "find-bar-title";\n  dom.append(t, rowMain, rowReplace, results, status);',
    tests: ["tests/findbar.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "位置持久化键 POS_KEY 复活（不再钉右上角）",
    file: "src/shell/findbar.ts",
    from: "const SVG = {",
    to: 'const POS_KEY = "litepad.findbar.pos";\nconst SVG = {',
    tests: ["tests/regressions.test.ts"],
  },
  // ---------------------------------------------------------------- 折叠替换行
  {
    name: "替换行默认展开（chevron 失去意义）",
    file: "src/shell/findbar.ts",
    // ⚠️ 不能改创建时的 `rowReplace.hidden = true;` —— open() 会再调 setReplaceExpanded(false)
    //    把它复位，改那里测不出来（首轮实测「无效守卫」）。真正的默认态判据在 setReplaceExpanded。
    from: "    rowReplace.hidden = !on;",
    to: "    rowReplace.hidden = false;",
    tests: ["tests/findbar.test.ts"],
  },
  {
    name: "折叠替换行丢失 [hidden] 覆盖（display:flex 盖掉 UA 的 none）",
    file: "src/styles/global.css",
    // ⚠️ 只删 `display:none` 不够——必须整块移除，否则 `.find-row-replace { height:28px }`
    //    仍在，判定「规则不存在」的断言才可能红。这里整块替换为空注释。
    from: ".find-row-replace[hidden] {\n  display: none;\n}",
    to: "/* 折叠覆盖已被移除 */",
    tests: ["tests/regressions.test.ts"],
  },
  // ---------------------------------------------------------------- 图标开关
  {
    name: "匹配选项退回复选框（图标开关消失）",
    file: "src/shell/findbar.ts",
    from: '  b.className = "find-toggle";',
    to: '  b.className = "find-opt";',
    tests: ["tests/findbar.test.ts", "tests/regressions.test.ts"],
  },
  // ---------------------------------------------------------------- 跨文档文档图标
  {
    name: "跨文档文档图标 class 写错（选择器命中不到）",
    file: "src/shell/findbar.ts",
    from: 'const docsBtn = iconBtn("find-docs", "docs", "所有打开的文档", "在全部已打开的文档中查找");',
    to: 'const docsBtn = iconBtn("find-docx", "docs", "所有打开的文档", "在全部已打开的文档中查找");',
    tests: ["tests/findbar.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "文档图标徽标不随激活显示",
    file: "src/shell/findbar.ts",
    from: "    badge.hidden = !on;",
    to: "    badge.hidden = true;",
    tests: ["tests/findbar.test.ts"],
  },
  // ---------------------------------------------------------------- 紧凑计数 / 无匹配变红
  {
    name: "无匹配不再变红",
    file: "src/shell/findbar.ts",
    from: '      count.classList.toggle("find-count-bad", !!bad || t === "无匹配");',
    to: '      count.classList.toggle("find-count-bad", false);',
    tests: ["tests/findbar.test.ts"],
  },
  // ---------------------------------------------------------------- 在选区中查找
  {
    name: "在选区中查找不进入查询对象",
    file: "src/shell/findbar.ts",
    from: "      inSelection: opt.selection,",
    to: "      inSelection: false,",
    tests: ["tests/findbar.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "选区限制失效（命中不再过滤）",
    file: "src/editor/find.ts",
    from: "  if (!range) return matches;\n  return matches.filter((m) => m.from >= range.from && m.to <= range.to);",
    to: "  return matches;",
    tests: ["tests/findbar.test.ts"],
  },
  // ---------------------------------------------------------------- 保留大小写
  {
    name: "保留大小写：全小写分支不再迁移",
    file: "src/editor/find.ts",
    from: "  if (!hasUpper) return replacement.toLowerCase();",
    to: "  if (!hasUpper) return replacement;",
    tests: ["tests/findbar.test.ts"],
  },
  {
    name: "替换不再接线保留大小写",
    file: "src/main.ts",
    from: "  const insert = q.preserveCase ? applyPreserveCase(matched, q.replace) : q.replace;",
    to: "  const insert = q.replace;",
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
    return false; // 有红
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
