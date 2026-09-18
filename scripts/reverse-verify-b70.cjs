// B70 反向验证：把每处修复分别「还原」一次，确认对应用例真的会红。
// 用法：node scripts/reverse-verify-b70.cjs
//
// 铁律（照着做，别图省事）：
//   · 全程不碰 .git —— 备份/还原都在本进程内存里做，还原后按 sha256 自检，
//     任何一条不一致都会打印出来（本项目曾因操作 .git 丢掉过全部历史）。
//   · **红才是通过**：脚本绿灯说明那条守卫抓不到对应缺陷，必须回头改断言。
const { readFileSync, writeFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf-8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const CASES = [
  {
    name: "A 档：tooltip 不再拦「菜单开着」",
    file: "src/shell/tooltip.ts",
    from: "  if (menuOpen(el.ownerDocument)) return;\n",
    to: "",
    tests: ["tests/tooltip.test.ts"],
  },
  {
    name: "A 档：守卫挪到读取 dataset.tip 之后（顺序断言）",
    file: "src/shell/tooltip.ts",
    from: "  if (menuOpen(el.ownerDocument)) return;\n  const text = el.dataset.tip;\n  if (!text || !el.isConnected) return;\n",
    to: "  const text = el.dataset.tip;\n  if (!text || !el.isConnected) return;\n  if (menuOpen(el.ownerDocument)) return;\n",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "A 档：开菜单不再收掉已显示的提示",
    file: "src/shell/menu.ts",
    from: "  hideTip();\n",
    to: "",
    tests: ["tests/tooltip.test.ts"],
  },
  {
    name: "B 档：菜单项又挂上提示字段",
    file: "src/shell/menu.ts",
    from: "export interface MenuItem {\n  label?: string;\n",
    to: "export interface MenuItem {\n  label?: string;\n  /** 悬停提示（可选） */\n  title?: string;\n",
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "B 档：拖放菜单项又挂上说明文字",
    file: "src/shell/filedrop.ts",
    from: "      { label: `打开「${fileName}」`, onSelect: cb.onOpen },",
    to: '      { label: `打开「${fileName}」`, title: "作为文档打开", onSelect: cb.onOpen },',
    tests: ["tests/regressions.test.ts"],
  },
  {
    name: "B 档：拖放判据退回「只数文件个数」",
    file: "src/shell/filedrop.ts",
    from: "  return paths.length === 1 && targetIsMarkdown;",
    to: "  return paths.length === 1;",
    tests: ["tests/filedrop.test.ts"],
  },
  {
    name: "B 档：main 接线不再问落点面板的文档类型",
    file: "src/main.ts",
    from: "needsChoice(p.paths, target !== null && panelDocIsMarkdown(target.panelId))",
    to: "needsChoice(p.paths, true)",
    tests: ["tests/regressions.test.ts", "tests/smoke.bootstrap.test.ts"],
  },
  {
    name: "C 档：悬停重新走整表重绘",
    file: "src/shell/commandpalette.ts",
    from: "        select(i, false);\n",
    to: "        render();\n",
    tests: ["tests/commandpalette.test.ts"],
  },
  {
    name: "C 档：悬停恢复滚动",
    file: "src/shell/commandpalette.ts",
    from: "        select(i, false);\n",
    to: "        select(i, true);\n",
    tests: ["tests/commandpalette.test.ts"],
  },
  {
    name: "C 档：render 里又补回 scrollIntoView",
    file: "src/shell/commandpalette.ts",
    from: "      list.appendChild(row);\n",
    to: '      list.appendChild(row);\n      if (i === active) row.scrollIntoView({ block: "nearest" });\n',
    tests: ["tests/commandpalette.test.ts", "tests/regressions.test.ts"],
  },
  {
    name: "C 档：呼出面板不再顶掉菜单",
    file: "src/shell/commandpalette.ts",
    from: "  closePopupMenu();\n",
    to: "",
    tests: ["tests/commandpalette.test.ts"],
  },
];

function vitest(files) {
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
  if (!orig.includes(c.from)) {
    console.log(`✗ ${c.name} —— 源码里找不到要替换的片段（判据失效）`);
    bad++;
    continue;
  }
  if (orig.split(c.from).length - 1 !== 1) {
    console.log(`⚠ ${c.name} —— 替换片段出现多次，可能改错位置`);
  }
  try {
    write(c.file, orig.replace(c.from, c.to));
    const green = vitest(c.tests);
    n++;
    console.log(`${green ? "✗ 无效守卫" : "✓ 会变红"}  ${c.name}`);
    if (green) bad++;
  } finally {
    write(c.file, orig);
    // 还原必须**逐字节一致**，否则「验证」本身就在破坏工作区
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
