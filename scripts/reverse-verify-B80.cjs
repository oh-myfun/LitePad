// B80 反向验证：证明本次交付的守卫真的会咬人，且不误伤。
//
// 用户报的三条（每条至少一个探针）：
//   ① 左侧拖拽高亮条很生硬且有错位
//        → 挖掉 `.find-bar` 的 `overflow: hidden`（圆角不再裁手柄直角）判红
//        → 手柄常态改回全透明（悬停才凭空冒线）判红
//        → 挖掉 `::before` 的 0.1s 缓动（变硬跳）判红
//   ② 底下不要结果区，多文档时只在文档按钮右上角显示总匹配数
//        → 把 `.find-results` 样式加回来 判红
//        → 查找栏重新渲染结果区 判红
//        → 徽标退回 setDocCount（旧语义）判红
//        → 徽标不再做 99+ 折数 判红
//        → 主程序不再把总数回灌徽标 判红
//        → 关栏不清命中表 判红
//        → searchOpenDocs 重新截断到 300 条 判红
//        → stepFind 丢掉跨文档步进分支 判红
//        → 查询变更不再作废旧总数 判红
//   ③ 反向对照（应**不**判红）：改一处与契约无关的文案 / 字号 → 必须仍然绿
//
// ⚠️ 判据说明：这些守卫全是**文件内容断言**，所以探针的 `from` 片段必须**全文唯一命中**，
//    否则 String.replace 只换第一处，命中的若是无关处，判红判绿都不构成证据 → 该条硬失败。
//    每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git。
//
// 用法：node scripts/reverse-verify-B80.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const MAIN = "src/main.ts";
const BAR = "src/shell/findbar.ts";
const CSS = "src/styles/global.css";

const FILES = [MAIN, BAR, CSS];
const sources = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const originalHashes = Object.fromEntries(FILES.map((f) => [f, hashOf(sources[f])]));

const REG = "tests/regressions.test.ts";

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
  // ---- ① 左缘手柄：错位与生硬 ----
  {
    name: "①-1 挖掉 .find-bar 的 overflow: hidden（手柄方角又从 8px 圆角里戳出来 = 错位）",
    target: CSS,
    filter: "B80",
    expectRed: true,
    from: "  /* 见上方注释：裁掉左缘手柄两端的直角（VS Code `.find-widget` 同款） */\n  overflow: hidden;\n",
    to: "",
  },
  {
    name: "①-2 手柄常态改回全透明（悬停才凭空冒出一条线 = 生硬）",
    target: CSS,
    filter: "B80",
    expectRed: true,
    from: "  background: var(--find-sash);\n",
    to: "  background: transparent;\n",
  },
  {
    name: "①-3 挖掉 ::before 的 0.1s 缓动（变色瞬间跳）",
    target: CSS,
    filter: "B80",
    expectRed: true,
    from: "  transition: background-color 0.1s ease-out;\n",
    to: "",
  },
  // ---- ② 删除底部结果区、总匹配数进徽标 ----
  {
    name: "②-1 把 .find-results 样式加回来（底下又多一块结果区）",
    target: CSS,
    filter: "B78",
    expectRed: true,
    from: "/* 状态行（「共 N 处匹配」",
    to: ".find-results { min-height: 22px; }\n\n/* 状态行（「共 N 处匹配」",
  },
  {
    name: "②-2 查找栏重新渲染结果区（DOM 里又多一个 .find-results）",
    target: BAR,
    filter: "B80",
    expectRed: true,
    from: "  dom.append(sash, rowMain, rowReplace, status);\n",
    to: '  const results = document.createElement("div");\n  results.className = "find-results";\n  dom.append(sash, rowMain, rowReplace, results, status);\n',
  },
  {
    name: "②-3 徽标退回 setDocCount（B78 的「已打开文档数」旧语义）",
    target: BAR,
    filter: "B80",
    expectRed: true,
    from: "    setMatchCount: (n) => {\n",
    to: "    setDocCount: (n) => {\n",
  },
  {
    name: "②-4 徽标不再做 99+ 折数（四位数把徽标拉得比按钮还宽）",
    target: BAR,
    filter: "B76",
    expectRed: true,
    from: '    return matchCount > 99 ? "99+" : String(matchCount);\n',
    to: "    return String(matchCount);\n",
  },
  {
    name: "②-5 查询变更不再作废旧总数（徽标挂着上一串内容搜出来的数字）",
    target: BAR,
    filter: "B80",
    expectRed: true,
    from: '    if (docsBtn.classList.contains("on")) {\n      matchCount = 0;\n      syncBadge();\n    }\n',
    to: "",
  },
  {
    name: "②-6 主程序不再把总匹配数回灌徽标",
    target: MAIN,
    filter: "B80",
    expectRed: true,
    from: "  bar?.setMatchCount(findHits.length);\n",
    to: "  bar?.setMatchCount(0);\n",
  },
  {
    name: "②-7 关栏时不清命中表（下次打开带着上一次的总数）",
    target: MAIN,
    filter: "B80",
    expectRed: true,
    from: "      clearFindHighlight();\n      resetFindAll();\n",
    to: "      clearFindHighlight();\n",
  },
  {
    name: "②-8 searchOpenDocs 重新截断到 300 条（徽标开始少报数）",
    target: MAIN,
    filter: "B80",
    expectRed: true,
    from: "      const line = state.doc.lineAt(m.from);\n",
    to: "      if (out.length >= 300) break;\n      const line = state.doc.lineAt(m.from);\n",
  },
  {
    name: "②-9 stepFind 丢掉跨文档步进分支（勾了文档图标点箭头没反应）",
    target: MAIN,
    filter: "B80",
    expectRed: true,
    from: "  if (q.allDocs) {\n    stepFindInDocs(dir, q);\n    return;\n  }\n",
    to: "",
  },
  // ---- ③ 反向对照：与契约无关的改动必须不误伤 ----
  {
    name: "③-1 反向对照：改一处手柄提示文案（应不误伤）",
    target: BAR,
    filter: "B80",
    expectRed: false,
    from: '"拖动调整查找栏宽度，双击复原"',
    to: '"拖一下改宽度，双击复原"',
  },
  {
    name: "③-2 反向对照：改徽标字号 8px→9px（应不误伤）",
    target: CSS,
    filter: "B80",
    expectRed: false,
    from: "  font-size: 8px;\n  font-style: normal;\n",
    to: "  font-size: 9px;\n  font-style: normal;\n",
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
    code = runVitest(REG, p.filter);
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
for (const f of FILES) {
  const now = hashOf(readFileSync(f, "utf8"));
  const same = now === originalHashes[f];
  restored = restored && same;
  console.log(
    `还原校验 ${f}：sha256 ${same ? "一致" : "不一致（立即人工修！）"} ${now.slice(0, 12)}…`,
  );
}
console.log(`\n反向验证 B80: ${results.filter(Boolean).length}/${results.length} 通过`);

if (!restored) {
  console.error("✗ 文件未按字节还原，请先 git diff 检查");
  process.exit(1);
}
process.exit(results.every(Boolean) ? 0 : 1);
