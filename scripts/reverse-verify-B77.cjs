// B77 反向验证：证明本次交付的守卫真的会咬人，且不误伤。
//
// 覆盖两组：
//   甲、守卫基建（themeBlock / ruleBlock 从 `\{[^}]*\}` 迁走）—— 见 pitfalls/0075
//       ① 挖掉浅色 --tip-bg        → B58 主题令牌用例必须判红
//       ② 深色块注释里塞一个花括号   → 必须**仍然绿**（旧写法会在这儿误判缺失，这就是迁走的理由）
//       ③ 挖掉深色 --bg           → 「四处底色一致」用例必须判红（旧写法会跨块拿浅色值顶包）
//   乙、B77 外观契约（对齐 VS Code）
//       ④ 工具按钮 22px 抄回 16px  → 红（全局 border-box 下图标会溢出，本次最核心的一条）
//       ⑤ 聚焦环去掉 outline-offset → 红
//       ⑥ 开关常态边框 transparent → none → 红
//       ⑦ 抽掉 .find-status[hidden] → 红
//       ⑧ 深色 --find-opt-hover 抄成 btn 那一档 → 红
//       ⑨ 按钮悬停误用 --find-opt-hover → 红
//       ⑩ 计数去掉 line-height:23px → 红
//
// 铁律（同技能）：不碰 .git；`from` 片段必须**全文唯一命中**，否则该条硬失败
// （String.replace 只换第一处，命中的若是无关处，判红判绿都不构成证据 —— B77 手搓探针实测踩过）；
// 每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 用法：node scripts/reverse-verify-B77.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const CSS = "src/styles/global.css";
const REG = "tests/regressions.test.ts";

const original = readFileSync(CSS, "utf8");
const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const originalHash = hashOf(original);

function runVitest(file, filter) {
  try {
    execFileSync("node", ["scripts/run-vitest.cjs", file, "-t", filter], {
      stdio: "pipe",
      cwd: process.cwd(),
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

/** 唯一命中替换：命中数 ≠ 1 直接判定该探针无效（不是「绿」）。 */
function replaceOnce(src, from, to) {
  const parts = src.split(from);
  if (parts.length !== 2) {
    throw new Error(`from 片段命中 ${parts.length - 1} 次（必须恰好 1 次）：${from.slice(0, 60)}…`);
  }
  return parts.join(to);
}

const probes = [
  {
    name: "① 挖掉浅色 --tip-bg",
    file: REG,
    filter: "两套主题都备齐",
    expectRed: true,
    from: "  --tip-bg: #f3f3f3;\n",
    to: "",
  },
  {
    name: "② 深色块注释塞花括号 {A,B}（应不误伤）",
    file: REG,
    filter: "两套主题都备齐",
    expectRed: false,
    from: "  --find-opt-active-fg: #ffffff;\n",
    to: "  --find-opt-active-fg: #ffffff;\n  /* 探针：注释里的花括号 {A,B} 不该影响取值 */\n",
  },
  {
    name: "③ 挖掉深色 --bg",
    file: REG,
    filter: "四处底色必须一致",
    expectRed: true,
    from: "  --bg: #1b1d1f;\n",
    to: "",
  },
  {
    name: "④ 工具按钮 22px → 16px",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: "  width: 22px;\n  height: 22px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 3px;\n  margin-left: 3px;\n  border: none;\n  border-radius: 5px;",
    to: "  width: 16px;\n  height: 16px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 3px;\n  margin-left: 3px;\n  border: none;\n  border-radius: 5px;",
  },
  {
    name: "⑤ 聚焦环去掉 outline-offset",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: ".find-field:focus-within {\n  outline: 1px solid var(--accent);\n  outline-offset: -1px;\n}",
    to: ".find-field:focus-within {\n  outline: 1px solid var(--accent);\n}",
  },
  {
    name: "⑥ 开关边框 transparent → none",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: "  padding: 1px;\n  border: 1px solid transparent;\n  border-radius: 3px;\n  background: none;\n  color: var(--fg-muted);\n  font-size: 11px;",
    to: "  padding: 1px;\n  border: none;\n  border-radius: 3px;\n  background: none;\n  color: var(--fg-muted);\n  font-size: 11px;",
  },
  {
    name: "⑦ 抽掉 .find-status[hidden]",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: "\n.find-status[hidden] {\n  display: none;\n}",
    to: "",
  },
  {
    name: "⑧ 深色 --find-opt-hover 抄成 btn 档",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: "  --find-opt-hover: #5a5d5e80;",
    to: "  --find-opt-hover: #5a5d5e50;",
  },
  {
    name: "⑨ 按钮悬停误用 --find-opt-hover",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: ".find-x:hover {\n  background: var(--find-btn-hover);",
    to: ".find-x:hover {\n  background: var(--find-opt-hover);",
  },
  {
    name: "⑩ 计数去掉 line-height:23px",
    file: REG,
    filter: "B77",
    expectRed: true,
    from: "  line-height: 23px;\n  margin-left: 3px;",
    to: "  margin-left: 3px;",
  },
];

const results = [];
for (const p of probes) {
  let code;
  let note = "";
  try {
    writeFileSync(CSS, replaceOnce(original, p.from, p.to), "utf8");
    code = runVitest(p.file, p.filter);
  } catch (e) {
    code = null;
    note = `  ⚠ 探针无效：${e.message}`;
  } finally {
    writeFileSync(CSS, original, "utf8");
  }
  const isRed = code !== null && code !== 0;
  const ok = code !== null && isRed === p.expectRed;
  results.push(ok);
  const verdict = code === null ? "无效" : isRed ? "红" : "绿";
  console.log(
    `${ok ? "✓" : "✗"} ${p.name}: exit=${code} → ${verdict}（期望${p.expectRed ? "红" : "绿"}）${note}`,
  );
}

const afterHash = hashOf(readFileSync(CSS, "utf8"));
const restored = afterHash === originalHash;
console.log(
  `\n还原校验：sha256 ${restored ? "一致" : "不一致（立即人工修！）"}  ${afterHash.slice(0, 12)}…`,
);
console.log(`反向验证 B77: ${results.filter(Boolean).length}/${results.length} 通过`);

if (!restored) {
  console.error("✗ 文件未按字节还原，请先 git diff 检查 " + CSS);
  process.exit(1);
}
process.exit(results.every(Boolean) ? 0 : 1);
