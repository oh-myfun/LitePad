// B79 反向验证：证明本次交付的守卫真的会咬人，且不误伤。
//
// 用户报的两条（每条至少一个探针）：
//   ① 主题档位没落盘（每次打开都是深色）→ 挖掉 settings.theme 写回 判红
//                                        → 挖掉写回后的 persistSettings() 判红
//                                        → 启动时不再按 settings.theme 还原 判红
//   ② 深色档单独点亮（三档观感不一致）  → 把 tool-btn-active 的深色档 toggle 加回去 判红
//   ③ 反向对照（应**不**判红）：改一句与契约无关的 aria 文案 → 必须仍然绿
//
// ⚠️ 判据说明：① 不能只断言「调了 persistSettings()」——旧代码一直在调，那样会假绿；
//    必须落在「写回 settings.theme」这个**动作**上，所以探针分别挖这三处。
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git；`from` 片段必须**全文唯一命中**，
// 否则该条硬失败（String.replace 只换第一处，命中的若是无关处，判红判绿都不构成证据）；
// 每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 用法：node scripts/reverse-verify-B79.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const MAIN = "src/main.ts";
const REG = "tests/regressions.test.ts";

const sources = { [MAIN]: readFileSync(MAIN, "utf8") };
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
    name: "①-1 挖掉 settings.theme 写回（档位只在内存里，重启就丢）",
    target: MAIN,
    filter: "B79",
    expectRed: true,
    from: "  if (settings) settings.theme = mode;\n",
    to: "",
  },
  {
    name: "①-2 写回了但不落盘（挖掉 setThemeMode 里的 persistSettings）",
    target: MAIN,
    filter: "B79",
    expectRed: true,
    from: '  await persistSettings();\n  showMessage(mode === "system" ? "主题：跟随系统"',
    to: '  showMessage(mode === "system" ? "主题：跟随系统"',
  },
  {
    name: "①-3 启动时不再按 settings.theme 还原档位",
    target: MAIN,
    filter: "B79",
    expectRed: true,
    from: "  themeMode = normalizeMode(settings?.theme);\n",
    to: '  themeMode = normalizeMode("system");\n',
  },
  {
    name: "② 把深色档的激活态 toggle 加回去（三档观感又不一致）",
    target: MAIN,
    filter: "B79",
    expectRed: true,
    from: "  btnTheme.innerHTML = ICONS[state.icon];\n",
    to: '  btnTheme.innerHTML = ICONS[state.icon];\n  btnTheme.classList.toggle("tool-btn-active", themeMode === "dark");\n',
  },
  {
    name: "③ 反向对照：改一句与契约无关的 aria 文案（应不误伤）",
    target: MAIN,
    filter: "B79",
    expectRed: false,
    from: "`主题：${state.label}，点击切换为${next}`",
    to: "`主题：${state.label}，点一下变${next}`",
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
console.log(`\n反向验证 B79: ${results.filter(Boolean).length}/${results.length} 通过`);

if (!restored) {
  console.error("✗ 文件未按字节还原，请先 git diff 检查");
  process.exit(1);
}
process.exit(results.every(Boolean) ? 0 : 1);
