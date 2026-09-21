// B91 反向验证：证明「关掉 wry 原生拖放 + 路径桥」与「标签拖拽换回 HTML5 DnD」这两批
// 改动各自的守卫真的会咬人，且不误伤。
//
// 用户诉求链路（两条都是用户报的毛病）：
//   · 拖文件进窗口应打开文件，而不是把内容插进当前文档；
//   · 标签拖拽的影像要**跟出窗口**（B64–B90 的指针编排做不到：影像是本窗口的 DOM 浮层，
//     指针一越过窗口边界就看不见了）。
// 实现：B91 关掉 wry 原生拖放（`dragDropEnabled: false`）+ 用 WebView2 官方出口补回文件
//   路径；B91-2 顺势把标签拖拽换回 HTML5 DnD（影像交系统绘制）。
//
// 每条至少一个探针：
//   ① 关原生拖放（B91-1）
//      → 配置又打开（页面内 HTML5 拖放全废）判红
//      → 主窗口 / 卫星窗口不装桥（拖文件进来毫无反应）判红
//      → 两侧桥的 tag 对不上（消息被静默丢弃）判红
//      → 桥的坐标不乘 dpr（高 DPI 下落点整体偏移）判红
//   ② 标签拖拽走 HTML5 DnD（B91-2）
//      → 标签不再可拖 / 标签栏不再可拖（DnD 入口没了）判红
//      → 整组起手判据退化（点标签也变成拖整组）判红
//      → 影像不交给系统（浮层又变回「移出窗口就消失」）判红
//      → 影像拍完不摘（与系统画的那份叠两层）判红
//      → 窗口内落点等 dragend 收尾（落点重建 DOM 后拖拽态类清不掉）判红
//      → 跨窗口不认领 / 认领后不发正文（正文发不出去 / 落点永远等不到）判红
//      → 回落不看认领（每次跨窗口拖拽都顺手弹一个新窗口 = 标签复制两份）判红
//      → 桌面坐标不挡 (0,0)（多显示器折算偏了会落到角落）判红
//      → 上游接线不接 commitTabDrop（拖拽松手什么都不发生）判红
//   ③ 交付后回归修复（B91-2 fix，用户报的两个毛病）
//      → 影像同步摘（Chromium 在 dragstart 返回后才拍快照 → 全程无跟手影像）判红
//      → 还原 `text/plain`（落点编辑器把标签名当「拖入文本」插进正文）判红
//      → 监听退回冒泡阶段（编辑器比我们先收到 drop，正文被改）判红
//      → drop 不先 claim（读不出载荷就放行默认动作 = 浏览器自己往文档里插东西）判红
//
// 反向对照（应**不**判红）：改与契约无关的注释 / 文案 → 必须仍然绿。
//
// ⚠️ 判据说明：这些守卫全是**文件内容断言 / 行为断言**，所以探针的 `from` 片段必须
//    **全文唯一命中**，否则 String.replace 只换第一处，命中的若是无关处，判红判绿都不
//    构成证据 → 该条硬失败。每条结束立刻按字节还原，运行前后 sha256 必须一致。
//
// ⚠️ 过滤器必须是**用例名**（vitest `-t` 匹配的是 describe/it 名字），不能写断言消息 ——
//    写成断言消息时 `-t` 一个用例都选不中，而 vitest 在「筛掉全部用例」时的退出码仍是
//    **0** → 探针判绿，得到一条「守卫咬不住」的**假绿**（B91 首轮实测踩到 4 条）。
//    因此脚本对每个过滤器做前置校验：未加补丁时该过滤器必须至少选中 1 个用例。
//
// ⚠️ 跑完之后**务必看末尾的 sha256 自检**：本脚本会临时改写源文件，被超时杀掉时可能
//    留下补丁（Windows 上捕不到 SIGTERM）。留了补丁的症状是「全量绿、单跑一条红」。
//
// 铁律（同技能 litepad-reverse-verify）：不碰 .git。
//
// 用法：node scripts/reverse-verify-B91.cjs
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const CONF = "src-tauri/tauri.conf.json";
const RUST_MAIN = "src-tauri/src/main.rs";
const RUST_WINS = "src-tauri/src/windows.rs";
const RUST_BRIDGE = "src-tauri/src/dropbridge.rs";
const FILEDROP = "src/shell/filedrop.ts";
const TABSTRIP = "src/shell/tabstrip.ts";
const SPLITVIEW = "src/shell/splitview.ts";
const TABDND = "src/shell/tabdnd.ts";
const MAIN = "src/main.ts";

const FILES = [
  CONF,
  RUST_MAIN,
  RUST_WINS,
  RUST_BRIDGE,
  FILEDROP,
  TABSTRIP,
  SPLITVIEW,
  TABDND,
  MAIN,
];
const sources = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const originalHashes = Object.fromEntries(FILES.map((f) => [f, hashOf(sources[f])]));

/**
 * 兜底还原。
 *
 * ⚠️ **被硬杀（超时 kill / 关窗）会留下补丁**：`finally` 跑不到，`src/` 就停在探针状态。
 *    实测踩过一次 —— 之后「全量 vitest 全绿、单跑那条用例却红」，排查方向被带偏很久。
 *    所以注册 `exit` / `SIGINT` 兜底；但 SIGTERM 在 Windows 上捕不到（Node 不会生成它），
 *    超时被杀仍可能留补丁 → 跑完务必看末尾的 sha256 自检，或 `git status` 复核。
 */
function restoreAll() {
  for (const f of FILES) writeFileSync(f, sources[f], "utf8");
}
process.on("exit", restoreAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}

/** 跑一个文件 + `-t` 过滤器，返回 { ok, ran, passed }。
 *
 *  ⚠️ 必须把**三种**结果分开，它们的退出码会骗人：
 *    · `ran=false` —— 过滤器一个用例都没选中。vitest 在「筛掉全部用例」时退出码仍是
 *      **0**，只看退出码会把它当成「绿」→ 一条「守卫咬不住」的**假绿**（B91 首轮实测
 *      踩到 4 条）。判据取 `Tests ` 汇总行里有没有 `N passed|N failed`。
 *    · `ran=true && passed=0` —— 选中了但**失败**（这正是探针要的红）。
 *    · `ok=false` —— vitest 非零退出。
 *  早期版本把后两者混为一谈，于是「用例失败」被误报成「过滤器无效」，排查时会被带偏。
 */
function runVitest(file, filter) {
  let out;
  let ok = true;
  try {
    out = execFileSync("node", ["scripts/run-vitest.cjs", file, "-t", filter], {
      stdio: "pipe",
      cwd: process.cwd(),
    }).toString();
  } catch (e) {
    ok = false;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const summary = out.split(/\r?\n/).find((l) => l.includes("Tests ")) ?? "";
  const ran = /\d+ (passed|failed)/.test(summary);
  const m = summary.match(/(\d+) passed/);
  return { ok, ran, passed: m ? Number(m[1]) : 0 };
}

/** 过滤器前置校验：未加补丁时至少要**选中** 1 个用例，否则判红判绿都没意义。 */
const filterCache = new Map();
function checkFilter(f) {
  if (!filterCache.has(f)) {
    const [file, filter] = f.split(":");
    const { ran } = runVitest(file, filter);
    filterCache.set(f, ran ? null : `过滤器「${filter}」一个用例都没选中（应写用例名）`);
  }
  return filterCache.get(f);
}

/** 唯一命中替换：命中数 ≠ 1 直接判定该探针无效（不是「绿」）。 */
function replaceOnce(src, from, to) {
  const parts = src.split(from);
  if (parts.length !== 2) {
    throw new Error(`from 片段命中 ${parts.length - 1} 次（必须恰好 1 次）：${from.slice(0, 70)}…`);
  }
  return parts.join(to);
}

// ---- 测试过滤器（文件:用例名子串；⚠️ 一律写用例名，别写断言消息）----
const REG91 = ["tests/regressions.test.ts:关掉原生拖放必须与路径桥成对出现"];
const TAGSYNC = ["tests/filedrop.test.ts:桥的 tag 必须与 Rust 侧逐字一致"];
const DPR = ["tests/filedrop.test.ts:消息体带 tag 与物理像素坐标"];
const DRAGGABLE = ["tests/regressions.test.ts:标签拖拽必须走 HTML5 DnD"];
const GROUP_START = ["tests/regressions.test.ts:拖标签栏空白处"];
const STRIP_DRAG = ["tests/regressions.test.ts:拖标签栏空白处"];
const IMAGE_HANDOFF = [
  "tests/tabdnd.test.ts:影像：挂进 body 拍快照",
  "tests/splitview.test.ts:影像是原标签的克隆",
];
const IMAGE_REMOVE = [
  "tests/tabdnd.test.ts:影像：挂进 body 拍快照",
  "tests/splitview.test.ts:拍快照那一刻影像",
];
const IMAGE_SYNC_REMOVE = [
  "tests/tabdnd.test.ts:推一帧再摘",
  "tests/splitview.test.ts:拍快照那一刻影像",
];
const NO_TEXT_PLAIN = ["tests/tabdnd.test.ts:不放可读正文"];
const NO_LEAK = ["tests/tabdnd.test.ts:绝不漏进页面内组件"];
const DROP_CLAIMS = ["tests/tabdnd.test.ts:载荷读不出来"];
const LOCAL_FINISH = ["tests/tabdnd.test.ts:窗口内落点就地收尾"];
const FOREIGN_CLAIM = ["tests/tabdnd.test.ts:别的窗口拖来的"];
const CLAIM_DELIVER = ["tests/tabdnd.test.ts:有人来认领"];
const FALLBACK_GRACE = ["tests/tabdnd.test.ts:别的窗口接手了"];
const DESKTOP_SPOT = ["tests/regressions.test.ts:新窗口落点"];
const WIRING = ["tests/regressions.test.ts:跨窗口拖拽协议"];

const probes = [
  // ---- ① 关掉 wry 原生拖放 + 路径桥（B91-1）----
  {
    name: "①-1 重新打开 wry 原生拖放（页面内 HTML5 拖放被一起废掉）",
    target: CONF,
    filters: REG91,
    expectRed: true,
    from: '"dragDropEnabled": false,',
    to: '"dragDropEnabled": true,',
  },
  {
    name: "①-2 主窗口不装路径桥（拖文件进来毫无反应）",
    target: RUST_MAIN,
    filters: REG91,
    expectRed: true,
    from: "dropbridge::install(app.handle(), windows::MAIN_LABEL)",
    to: "let _ = windows::MAIN_LABEL;",
  },
  {
    name: "①-3 卫星窗口建窗时不关原生拖放（文件落在它上面没反应）",
    target: RUST_WINS,
    filters: REG91,
    expectRed: true,
    from: ".drag_and_drop(false)",
    to: ".drag_and_drop(true)",
  },
  {
    name: "①-4 两侧桥的 tag 对不上（消息被静默丢弃）",
    target: RUST_BRIDGE,
    filters: TAGSYNC,
    expectRed: true,
    from: 'pub const MSG_TAG: &str = "__litepad_file_drop__";',
    to: 'pub const MSG_TAG: &str = "__litepad_file_drop_x__";',
  },
  {
    name: "①-5 桥的坐标不乘 dpr（高 DPI 屏落点整体偏移）",
    target: FILEDROP,
    filters: DPR,
    expectRed: true,
    from: "return JSON.stringify({ tag: FILE_DROP_TAG, x: x * dpr, y: y * dpr });",
    to: "return JSON.stringify({ tag: FILE_DROP_TAG, x, y });",
  },
  // ---- ② 标签拖拽走 HTML5 DnD（B91-2）----
  {
    name: "②-1 标签不再可拖（HTML5 DnD 的入口没了）",
    target: TABSTRIP,
    filters: DRAGGABLE,
    expectRed: true,
    from: "  el.draggable = true;",
    to: "  el.draggable = false;",
  },
  {
    name: "②-2 标签栏不再可拖（标签栏空白处拖不动整组）",
    target: SPLITVIEW,
    filters: STRIP_DRAG,
    expectRed: true,
    from: "  strip.draggable = true;",
    to: "  strip.draggable = false;",
  },
  {
    name: "②-3 整组起手判据退化（点标签也变成拖整组）",
    target: SPLITVIEW,
    filters: GROUP_START,
    expectRed: true,
    from: "    if (e.target !== strip) return;",
    to: "    if (false) return;",
  },
  {
    name: "②-4 影像不交给系统（浮层又变回「移出窗口就消失」）",
    target: TABDND,
    filters: IMAGE_HANDOFF,
    expectRed: true,
    from: "    dt.setDragImage(image, anchor.x, anchor.y);",
    to: "    void image;",
  },
  {
    name: "②-5 影像拍完不摘（与系统画的那份叠成两层）",
    target: TABDND,
    filters: IMAGE_REMOVE,
    expectRed: true,
    from: "    setTimeout(() => image.remove(), 0);",
    to: "    void image;",
  },
  {
    name: "②-6 窗口内落点等 dragend 收尾（落点重建 DOM 后拖拽态类清不掉）",
    target: TABDND,
    filters: LOCAL_FINISH,
    expectRed: true,
    from:
      "      if (source?.payload.dragId === payload.dragId) source = null;\n" +
      "      document.body.classList.remove(TAB_DRAG_CLASS);\n",
    to: "      void source;\n",
  },
  {
    name: "②-7 跨窗口不认领（正文永远发不出去）",
    target: TABDND,
    filters: FOREIGN_CLAIM,
    expectRed: true,
    from: "    void emitTo(payload.from, EVT_TAB_CLAIM, {",
    to: "    void emitTo(cfg.selfLabel, EVT_TAB_CLAIM, {",
  },
  {
    name: "②-8 认领后不发正文（对方落点永远等不到标签）",
    target: TABDND,
    filters: CLAIM_DELIVER,
    expectRed: true,
    from:
      "    void emitTo(from, EVT_TAB_PAYLOAD, { from: cfg.selfLabel, dragId, tabs: snapshots }).catch(\n" +
      "      () => {},\n" +
      "    );\n",
    to: "    void [from, dragId, snapshots];\n",
  },
  {
    name: "②-9 回落不看认领（每次跨窗口拖拽都顺手弹一个新窗口 = 标签复制两份）",
    target: TABDND,
    filters: FALLBACK_GRACE,
    expectRed: true,
    from: "      if (s.taken) return;",
    to: "      if (false) return;",
  },
  {
    name: "②-10 桌面坐标不挡 (0,0)（多显示器折算偏了会落到角落）",
    target: MAIN,
    filters: DESKTOP_SPOT,
    expectRed: true,
    from: "  if (screenX === 0 && screenY === 0) return null;",
    to: "  void screenX;",
  },
  {
    name: "②-11 上游不接 commitTabDrop（拖拽松手什么都不发生）",
    target: MAIN,
    filters: WIRING,
    expectRed: true,
    from: "    commitLocal: (req) => commitTabDrop(req),",
    to: "    commitLocal: () => true,",
  },
  // ---- ③ 交付后回归修复（B91-2 fix）----
  {
    name: "③-1 影像同步摘掉（Chromium 在 dragstart 返回后才拍快照 → 全程没有跟手影像）",
    target: TABDND,
    filters: IMAGE_SYNC_REMOVE,
    expectRed: true,
    from: "    setTimeout(() => image.remove(), 0);",
    to: "    image.remove();",
  },
  {
    name: "③-2 还原 text/plain（落点编辑器把标签名当「拖入文本」插进正文）",
    target: TABDND,
    filters: NO_TEXT_PLAIN,
    expectRed: true,
    from: "  dt.setData(TAB_MIME, encodeTabDrag(full));",
    to: '  dt.setData(TAB_MIME, encodeTabDrag(full));\n  dt.setData("text/plain", "note.md");',
  },
  {
    name: "③-3 监听退回冒泡阶段（编辑器比我们先收到 drop，正文被改）",
    target: TABDND,
    filters: NO_LEAK,
    expectRed: true,
    from: '  document.addEventListener("drop", onDrop, CAPTURE);',
    to: '  document.addEventListener("drop", onDrop);',
  },
  {
    name: "③-4 drop 不先 claim（读不出载荷就放行默认动作 = 浏览器自己往文档里插东西）",
    target: TABDND,
    filters: DROP_CLAIMS,
    expectRed: true,
    from: "    if (!claim(e)) return;\n    hopDepth = 0;",
    to: "    if (!isTabDragData(e.dataTransfer)) return;\n    hopDepth = 0;",
  },
  // ---- 反向对照：改无关的东西必须仍然绿 ----
  {
    name: "对照-1 改传输层注释（与契约无关）",
    target: TABDND,
    filters: ["tests/tabdnd.test.ts:拖拽载荷"],
    expectRed: false,
    from: "// 标签拖拽的 HTML5 DnD 传输层（B91-2）。",
    to: "// 标签拖拽的 HTML5 DnD 传输层（B91-2）。改注释不该影响任何判定：",
  },
  {
    name: "对照-2 改交出去之后的提示文案（与契约无关）",
    target: MAIN,
    filters: DESKTOP_SPOT,
    expectRed: false,
    from: "已移到另一个窗口 ",
    to: "已移到别的窗口 ",
  },
];

let failed = 0;
console.log("═══════════════════════════════════════");
console.log(" B91 反向验证：关原生拖放 + 路径桥 / 标签拖拽走 HTML5 DnD");
console.log("═══════════════════════════════════════");

// 前置：所有过滤器必须真选中用例（否则判绿只是「什么都没跑」）
for (const p of probes) {
  for (const f of p.filters) {
    const err = checkFilter(f);
    if (err) {
      console.log(`✗ ${p.name}\n    ${err}`);
      failed++;
    }
  }
}
if (failed > 0) {
  console.log("───────────────────────────────────────");
  console.log(`✗ ${failed} 个过滤器无效，先修过滤器再探（判绿无意义）`);
  process.exit(1);
}

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
      const [vfile, filter] = f.split(":");
      const { ok, ran } = runVitest(vfile, filter);
      // ⚠️ 红 = 「非零退出 **且** 确实选中并跑了用例」。只看退出码的话，vitest 启动失败
      //    （配置错 / 模块加载失败）会让每个探针都「红」，看着全绿其实什么都没验。
      results.push({ f, red: !ok && ran, noRun: !ran });
    }
  } finally {
    writeFileSync(p.target, file, "utf8"); // 立刻按字节还原
  }
  const anyRed = results.some((r) => r.red);
  const ok = p.expectRed ? anyRed : !anyRed;
  if (!ok) failed++;
  const detail = results
    .map((r) => `${r.f.split(":")[1]}=${r.noRun ? "未选中" : r.red ? "红" : "绿"}`)
    .join(" ");
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
if (dirty === 0) console.log(`✓ ${FILES.length} 个文件均已按字节还原（sha256 一致）`);
else failed += dirty;

console.log("───────────────────────────────────────");
console.log(failed === 0 ? `✓ 全部 ${probes.length} 个探针通过` : `✗ ${failed} 个探针未通过`);
process.exit(failed === 0 ? 0 : 1);
