// B78 反向验证：证明本次交付的守卫真的会咬人，且不误伤。
//
// 覆盖用户提的七条（每条至少一个探针）：
//   ① 左侧宽度手柄      → 手柄宽度改胖（4px → 8px）判红；拖拽方向写反判红
//   ② 折叠按钮变高      → replace-toggled 下 chevron 高度改回 25px 判红
//   ③ 选区按钮在箭头后  → 主行 append 顺序把 selT 挪到 prev 之前判红
//   ④ 两个范围互斥      → 挖掉「点亮选区就熄掉跨文档」判红
//   ⑤ 结果区常驻        → 挖掉 .find-results 的 min-height 判红
//   ⑥ 两框同宽          → 替换框改回 flex:1 判红；「无布局不下手」的兜底挖掉判红
//   ⑦ 替换图标          → 把「全部替换」砍成一支箭头判红
//   ⑧ 反向对照（应**不**判红）：改一句与契约无关的提示文案 → 必须仍然绿
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git；`from` 片段必须**全文唯一命中**，
// 否则该条硬失败（String.replace 只换第一处，命中的若是无关处，判红判绿都不构成证据）；
// 每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 用法：node scripts/reverse-verify-B78.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const CSS = "src/styles/global.css";
const BAR = "src/shell/findbar.ts";
const REG = "tests/regressions.test.ts";

const sources = { [CSS]: readFileSync(CSS, "utf8"), [BAR]: readFileSync(BAR, "utf8") };
const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const originalHashes = Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, hashOf(s)]));

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
    name: "①-1 手柄宽度 4px → 8px",
    target: CSS,
    filter: "B78",
    expectRed: true,
    from: ".find-sash {\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 4px;",
    to: ".find-sash {\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 8px;",
  },
  {
    name: "①-2 拖拽方向写反（往左拖变成变窄）",
    target: BAR,
    filter: "B78",
    expectRed: true,
    from: "startW + (startX - ev.clientX)",
    to: "startW + (ev.clientX - startX)",
  },
  {
    name: "② 展开态 chevron 还是 25px（没跟着变高）",
    target: CSS,
    filter: "B78",
    expectRed: true,
    from: ".find-bar.replace-toggled .find-chevron {\n  height: 53px;\n}",
    to: ".find-bar.replace-toggled .find-chevron {\n  height: 25px;\n}",
  },
  {
    name: "③ 选区按钮挪回箭头之前",
    target: BAR,
    filter: "B78",
    expectRed: true,
    from: "rowMain.append(chevron, field, count, prev, next, selT, docsBtn, closeBtn);",
    to: "rowMain.append(chevron, field, count, selT, prev, next, docsBtn, closeBtn);",
  },
  {
    name: "④ 挖掉互斥（点亮选区不再熄掉跨文档）",
    target: BAR,
    filter: "B78",
    expectRed: true,
    from: '    if (on && docsBtn.classList.contains("on")) setAllDocs(false);\n',
    to: "",
  },
  {
    name: "⑤ 结果区不再留空位（挖掉 min-height）",
    target: CSS,
    filter: "B78",
    expectRed: true,
    from: "  max-height: 220px;\n  overflow: auto;\n  min-height: 22px;",
    to: "  max-height: 220px;\n  overflow: auto;",
  },
  {
    name: "⑥-1 替换框改回 flex:1（不再由 JS 定宽）",
    target: CSS,
    filter: "B78",
    expectRed: true,
    from: ".find-row-replace .find-field {\n  flex: 0 0 auto;\n}",
    to: ".find-row-replace .find-field {\n  flex: 1 1 auto;\n}",
  },
  {
    name: "⑥-2 挖掉「无布局不下手」的兜底（会把 0px 写死到替换框）",
    target: BAR,
    filter: "B78",
    expectRed: true,
    from: "    if (w <= 0) return;\n",
    to: "",
  },
  {
    name: "⑦ 全部替换砍成一支箭头（与替换同形）",
    target: BAR,
    filter: "B78",
    expectRed: true,
    from: "M10.6 9.4h3.2M12.2 7.8l1.6 1.6-1.6 1.6",
    to: "",
  },
  {
    name: "⑧ 反向对照：改一句与契约无关的提示文案（应不误伤）",
    target: BAR,
    filter: "B78",
    expectRed: false,
    from: 'setTip(sash, "拖动调整宽度，双击复原"',
    to: 'setTip(sash, "拖动改宽度，双击回默认"',
  },
];

const results = [];
for (const p of probes) {
  const target = p.target;
  const original = sources[target];
  let code;
  let note = "";
  try {
    writeFileSync(target, replaceOnce(original, p.from, p.to), "utf8");
    code = runVitest(p.file ?? REG, p.filter);
  } catch (e) {
    code = null;
    note = `  ⚠ 探针无效：${e.message}`;
  } finally {
    writeFileSync(target, original, "utf8");
  }
  const isRed = code !== null && code !== 0;
  const ok = code !== null && isRed === p.expectRed;
  results.push(ok);
  const verdict = code === null ? "无效" : isRed ? "红" : "绿";
  console.log(
    `${ok ? "✓" : "✗"} ${p.name}: exit=${code} → ${verdict}（期望${p.expectRed ? "红" : "绿"}）${note}`,
  );
}

let restored = true;
for (const [f, h] of Object.entries(originalHashes)) {
  const now = hashOf(readFileSync(f, "utf8"));
  const same = now === h;
  restored = restored && same;
  console.log(
    `还原校验 ${f}：sha256 ${same ? "一致" : "不一致（立即人工修！）"} ${now.slice(0, 12)}…`,
  );
}
console.log(`\n反向验证 B78: ${results.filter(Boolean).length}/${results.length} 通过`);

if (!restored) {
  console.error("✗ 文件未按字节还原，请先 git diff 检查");
  process.exit(1);
}
process.exit(results.every(Boolean) ? 0 : 1);
