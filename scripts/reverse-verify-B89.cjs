// B89 反向验证：证明「跨窗口拖拽 = 途中只预览、松手才提交」这批守卫真的会咬人，且不误伤。
//
// 用户报的毛病：拖标签出窗口时**立刻**生效——想把窗口 A 的标签拖到窗口 B 的面板 A，
// 经过面板 B 就被合入；主窗口拖出时鼠标还没松手就弹出了新窗口。
//
// 需求的三条主线（每条至少一个探针）：
//   ① 拖拽途中不得产生副作用
//        → 出界就收尾（旧行为回归）判红
//        → 出界状态不记录（松手时不知道该走哪条路）判红
//        → 拖回窗口内不清状态（明明落在窗口内却走了跨窗口）判红
//        → 刚出界不清本窗口预览（两块预览同时亮着）判红
//   ② 松手才提交
//        → 松手分支被挖掉（永远不跨窗口）判红
//        → 宿主不问有没有人接手（直接开新窗口）判红
//        → 落点不按本窗口算出来的那块（预览在这、落下在那）判红
//        → 不装接收侧（谁都接不住）判红
//   ③ 正文绝不广播
//        → release 带正文（每个窗口都收到一份几十 MB）判红
//        → payload 用广播而非定向投递 判红
//        → hover 夹带正文 判红
//
// 反向对照（应**不**判红）：改与契约无关的文案/注释 → 必须仍然绿。
//
// ⚠️ 判据说明：这些守卫全是**文件内容断言**，所以探针的 `from` 片段必须**全文唯一命中**，
//    否则 String.replace 只换第一处，命中的若是无关处，判红判绿都不构成证据 → 该条硬失败。
//    每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git。
//
// 用法：node scripts/reverse-verify-B89.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const MAIN = "src/main.ts";
const SV = "src/shell/splitview.ts";
const WD = "src/shell/windowdrag.ts";

const FILES = [MAIN, SV, WD];
const sources = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const originalHashes = Object.fromEntries(FILES.map((f) => [f, hashOf(sources[f])]));

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
    throw new Error(`from 片段命中 ${parts.length - 1} 次（必须恰好 1 次）：${from.slice(0, 70)}…`);
  }
  return parts.join(to);
}

const REG89 = ["tests/regressions.test.ts:B89"];
const B89 = [...REG89, "tests/window-drag-out.test.ts:B89"];
const MUTEX = ["tests/tabstrip-drag.test.ts:两种预览互斥"];

const probes = [
  // ---- ① 拖拽途中不得产生副作用 ----
  {
    name: "①-1 出界就收尾（旧行为回归：路过就被合入）",
    target: SV,
    filters: B89,
    expectRed: true,
    from: "    tabDrag.outOfWindow = true;\n    svCallbacks?.onDragOutside?.({",
    to: "    tabDrag.outOfWindow = true;\n    finishTabDrag();\n    svCallbacks?.onDragOutside?.({",
  },
  {
    name: "①-2 出界状态不记录（松手时无从判断走哪条路）",
    target: SV,
    filters: B89,
    expectRed: true,
    from: "    tabDrag.outOfWindow = true;",
    to: "    tabDrag.outOfWindow = false;",
  },
  {
    name: "①-3 拖回窗口内不清状态（落在窗口内却走了跨窗口）",
    target: SV,
    filters: B89,
    expectRed: true,
    from: "  tabDrag.outOfWindow = false;",
    to: "  tabDrag.outOfWindow = true;",
  },
  {
    name: "①-4 刚出界不清本窗口预览（两个窗口同时亮着）",
    target: SV,
    filters: REG89,
    expectRed: true,
    from: "      clearAllPreviews();\n      clearInsertIndicators();\n    }\n    tabDrag.outOfWindow = true;",
    to: "    }\n    tabDrag.outOfWindow = true;",
  },
  {
    name: "①-5 落点判定开头不清痕迹（插入线与分屏预览同时留着）",
    target: SV,
    filters: MUTEX,
    expectRed: true,
    from: "  clearAllPreviews();\n  clearInsertIndicators();\n  const panelEl = panelAt(x, y);",
    to: "  const panelEl = panelAt(x, y);",
  },
  // ---- ② 松手才提交 ----
  {
    name: "②-1 松手分支被挖掉（跨窗口拖拽永远不生效）",
    target: SV,
    filters: B89,
    expectRed: true,
    from: "  if (drag.outOfWindow) {",
    to: "  if (false) {",
  },
  {
    name: "②-2 宿主不问有没有人接手（一律开新窗口）",
    target: MAIN,
    filters: REG89,
    expectRed: true,
    from: "  const target = session ? await session.release() : null;",
    to: "  const target = null;",
  },
  {
    name: "②-3 落点不按本窗口算出来的那块（预览在这、落下在那）",
    target: MAIN,
    filters: REG89,
    expectRed: true,
    from: "    preview: (x, y) => previewDropAt(x, y),",
    to: "    preview: () => null,",
  },
  {
    name: "②-4 不装接收侧（谁都接不住，只能一直开新窗口）",
    target: MAIN,
    filters: REG89,
    expectRed: true,
    from: "  void installWindowDropTarget(windowLabel, {",
    to: "  if (false) void installWindowDropTarget(windowLabel, {",
  },
  // ---- ③ 正文绝不广播 ----
  {
    name: "③-1 release 夹带正文（广播一次 = 每个窗口一份几十 MB）",
    target: WD,
    filters: REG89,
    expectRed: true,
    from: "void emit(EVT_RELEASE, { from: selfLabel, screen })",
    to: "void emit(EVT_RELEASE, { from: selfLabel, screen, tabs })",
  },
  {
    name: "③-2 payload 用广播而非定向投递",
    target: WD,
    filters: REG89,
    expectRed: true,
    from: "void emitTo(target, EVT_PAYLOAD, { from: selfLabel, tabs })",
    to: "void emit(EVT_PAYLOAD, { from: selfLabel, tabs })",
  },
  {
    name: "③-3 hover 夹带正文（每次移动都广播一遍正文）",
    target: WD,
    filters: REG89,
    expectRed: true,
    from: "          screen: clientToScreen(g, lastClient.x, lastClient.y),",
    to: "          screen: clientToScreen(g, lastClient.x, lastClient.y),\n          tabs: 1,",
  },
  // ---- 反向对照：改无关的东西必须仍然绿 ----
  {
    name: "对照-1 改协议层注释（与契约无关）",
    target: WD,
    filters: REG89,
    expectRed: false,
    from: "// 协议（事件名见下方常量，全部是 fire-and-forget）：",
    to: "// 协议（事件名见下方常量，全部是 fire-and-forget）——注释改了不影响任何判定：",
  },
  {
    name: "对照-2 改提示文案（与契约无关）",
    target: MAIN,
    filters: REG89,
    expectRed: false,
    from: "已移到另一个窗口 ",
    to: "已送到另一个窗口 ",
  },
];

let failed = 0;
console.log("═══════════════════════════════════════");
console.log(" B89 反向验证：跨窗口拖拽（途中预览、松手提交）");
console.log("═══════════════════════════════════════");

for (const p of probes) {
  const file = sources[p.target];
  let patched;
  try {
    patched = replaceOnce(file, p.from, p.to);
  } catch (e) {
    console.log(`✗ ${p.name}\n    ${e.message}`);
    failed++;
    continue;
  }
  writeFileSync(p.target, patched, "utf8");
  const results = [];
  try {
    for (const f of p.filters) {
      const [file, filter] = f.split(":");
      const code = runVitest(file, filter);
      results.push({ f, red: code !== 0 });
    }
  } finally {
    writeFileSync(p.target, file, "utf8"); // 立刻按字节还原
  }
  const allRed = results.every((r) => r.red);
  const anyRed = results.some((r) => r.red);
  const ok = p.expectRed ? allRed : !anyRed;
  if (!ok) failed++;
  const mark = ok ? "✓" : "✗";
  const detail = results.map((r) => `${r.f.split(":")[1]}=${r.red ? "红" : "绿"}`).join(" ");
  console.log(`${mark} ${p.name}  [${detail}]`);
}

// 还原校验：跑完每个文件的字节必须和开局一致
console.log("───────────────────────────────────────");
let dirty = 0;
for (const f of FILES) {
  const now = hashOf(readFileSync(f, "utf8"));
  if (now !== originalHashes[f]) {
    console.log(`✗ ${f} 未还原（sha256 不一致）`);
    dirty++;
  }
}
if (dirty === 0) console.log("✓ 三个文件均已按字节还原（sha256 一致）");
else failed += dirty;

console.log("───────────────────────────────────────");
console.log(failed === 0 ? `✓ 全部 ${probes.length} 个探针通过` : `✗ ${failed} 个探针未通过`);
process.exit(failed === 0 ? 0 : 1);
