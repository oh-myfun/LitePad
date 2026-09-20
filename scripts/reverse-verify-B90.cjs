// B90 反向验证：证明这批「拖拽观感 + 空面板」的守卫真的会咬人，且不误伤。
//
// 用户报的四条毛病，每条至少一个探针：
//   ① 拖拽影像要始终跟着鼠标
//        → 影像被夹取（出界后不再精确跟随）判红
//   ② 目标窗口预览的瑕疵
//        → 空标签栏的插入线顶到最右（空面板上悬停冒出滚动条）判红
//        → 收尾不通知宿主（拖出去又拖回来，另一个窗口的预览一直亮着）判红
//        → END 连落点一起清掉（正文到达时已不知放哪 → 预览在这、落下在那）判红
//   ③ 面板移空 / 整组移出后留下空面板
//        → 跨窗口拖走后不清空面板 判红
//        → 同面板分屏挪走唯一标签后留空框 判红
//
// 反向对照（应**不**判红）：改与契约无关的文案/注释 → 必须仍然绿。
//
// ⚠️ 判据说明：这些守卫全是**文件内容断言 / 行为断言**，所以探针的 `from` 片段必须
//    **全文唯一命中**，否则 String.replace 只换第一处，命中的若是无关处，判红判绿都不
//    构成证据 → 该条硬失败。每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git。
//
// 用法：node scripts/reverse-verify-B90.cjs
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

const REG90 = ["tests/regressions.test.ts:B90"];
const GHOST = ["tests/window-drag-out.test.ts:影像始终精确跟随"];
const STRIP = ["tests/tabstrip-drag.test.ts:空标签栏的插入线贴最左"];
const ENDING = ["tests/window-drag-out.test.ts:拖出去又拖回来松手", ...REG90];

const probes = [
  // ---- ① 影像始终跟随 ----
  {
    name: "①-1 影像被夹取（出界后不再精确跟随光标）",
    target: SV,
    filters: GHOST,
    expectRed: true,
    from: "  dragGhost.style.left = `${x - dragGhostAnchor.x}px`;",
    to: "  dragGhost.style.left = `${Math.min(Math.max(x - dragGhostAnchor.x, 0), 900)}px`;",
  },
  // ---- ② 目标窗口预览的瑕疵 ----
  {
    name: "②-1 空标签栏的插入线顶到最右（空面板上悬停冒出滚动条）",
    target: SV,
    filters: STRIP,
    expectRed: true,
    from: "    return { beforeTabId: null, offsetLeft: 0 };",
    to: "    return { beforeTabId: null, offsetLeft: r.width };",
  },
  {
    name: "②-2 收尾不通知宿主（拖出去又拖回来，另一个窗口的预览一直亮着）",
    target: SV,
    filters: ENDING,
    expectRed: true,
    from: "  cb?.onDragEnd?.();",
    to: "  void cb;",
  },
  {
    name: "②-3 END 连落点一起清掉（正文到达时已不知放哪）",
    target: WD,
    filters: REG90,
    expectRed: true,
    from: "    clearReceiver(false);",
    to: "    clearReceiver();",
  },
  // ---- ③ 空面板 ----
  {
    name: "③-1 跨窗口拖走后不清空面板（留下占位的空框）",
    target: MAIN,
    filters: REG90,
    expectRed: true,
    from: "      pruneEmptyPanels();\n      rebuildLayout();",
    to: "      rebuildLayout();",
  },
  {
    name: "③-2 同面板分屏挪走唯一标签后留空框",
    target: MAIN,
    filters: REG90,
    expectRed: true,
    from: "    if (!pruneEmptyPanels()) {",
    to: "    if (true) {",
  },
  // ---- 反向对照：改无关的东西必须仍然绿 ----
  {
    name: "对照-1 改协议层注释（与契约无关）",
    target: WD,
    filters: REG90,
    expectRed: false,
    from: "// 协议（事件名见下方常量，全部是 fire-and-forget）：",
    to: "// 协议（事件名见下方常量，全部是 fire-and-forget）——改注释不影响任何判定：",
  },
  {
    name: "对照-2 改接手提示文案（与契约无关）",
    target: MAIN,
    filters: REG90,
    expectRed: false,
    from: "已从另一个窗口接来 ",
    to: "已从别的窗口接过 ",
  },
];

let failed = 0;
console.log("═══════════════════════════════════════");
console.log(" B90 反向验证：影像跟随 / 预览收尾 / 空面板");
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
      results.push({ f, red: runVitest(file, filter) !== 0 });
    }
  } finally {
    writeFileSync(p.target, file, "utf8"); // 立刻按字节还原
  }
  const allRed = results.every((r) => r.red);
  const anyRed = results.some((r) => r.red);
  const ok = p.expectRed ? allRed : !anyRed;
  if (!ok) failed++;
  const detail = results.map((r) => `${r.f.split(":")[1]}=${r.red ? "红" : "绿"}`).join(" ");
  console.log(`${ok ? "✓" : "✗"} ${p.name}  [${detail}]`);
}

console.log("───────────────────────────────────────");
let dirty = 0;
for (const f of FILES) {
  if (hashOf(readFileSync(f, "utf8")) !== originalHashes[f]) {
    console.log(`✗ ${f} 未还原（sha256 不一致）`);
    dirty++;
  }
}
if (dirty === 0) console.log("✓ 三个文件均已按字节还原（sha256 一致）");
else failed += dirty;

console.log("───────────────────────────────────────");
console.log(failed === 0 ? `✓ 全部 ${probes.length} 个探针通过` : `✗ ${failed} 个探针未通过`);
process.exit(failed === 0 ? 0 : 1);
