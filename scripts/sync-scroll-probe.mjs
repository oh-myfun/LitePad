#!/usr/bin/env node
/**
 * 同步滚动真机验证台。
 *
 * 为什么需要它：jsdom 无布局（`getBoundingClientRect` 恒 0、`Range.getClientRects` 空、
 * `scrollTop` setter 不裁剪、摘节点不派发 scroll），而同步滚动的全部真实失败模式都住在
 * 布局与滚动事件的时序里。T7 连出五版「全量门禁 ✅ 但真机立刻复现」，根子就是这个盲区。
 * 本脚本把**真实生产模块**（CM6 编辑器、真实 markdown 管线、真实协调器与锚点、真实接线）
 * 打进真实 Chromium，用 CDP 派发**真实**滚轮 / 鼠标 / 键盘事件，再读真实布局出来判定。
 *
 * 为什么不接 Tauri 产物：本仓库实测过 WebView2 不吃
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`、Tauri 也不转发 `--remote-debugging-port`
 * （`.workbuddy/memory/2026-10-02.md`、`2026-09-14.md`），CDP 接不上被测进程。
 * 「真实浏览器 + CDP 派发真实鼠标」这条路在本仓库 `docs/split-view-plan.md` 的取证方法
 * 里已经跑通，这里沿用它，只把被测面从 splitview 换成滚动同步。
 *
 * 独立性判据：`v` 由本脚本从 DOM 几何**独立复算**，不调用被测的 getV()。否则「换算写错」
 * 会和「断言」一起错，绿灯照样骗人。
 *
 * 用法：
 *   node scripts/sync-scroll-probe.mjs                 # 构建 harness 并跑全部场景
 *   node scripts/sync-scroll-probe.mjs --only=S1,S6    # 只跑指定场景
 *   node scripts/sync-scroll-probe.mjs --verbose       # 每步打印实测 v
 *   node scripts/sync-scroll-probe.mjs --keep-open     # 跑完不关浏览器（人工对照）
 *
 * 退出码：0 全绿 / 1 有 FAIL / 2 台子本身起不来（环境问题，不算被测代码失败）。
 */

import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { buildSync } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, ".tmp", "sync-probe");
const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const has = (name) => argv.includes(`--${name}`);

const PORT = Number(flag("port") ?? 9229);
const VERBOSE = has("verbose");
const ONLY = flag("only")
  ?.split(",")
  .map((s) => s.trim());
/** 容差：两侧顶边的源码行差多少行以内算「同步上了」。1 行 ≈ 一次键盘步长。 */
const TOL = Number(flag("tol") ?? 1.0);

const HARNESS_TS = path.join(ROOT, "tests", "harness", "sync-scroll-harness.ts");
const FIXTURE_LONG = path.join(ROOT, "tests", "fixtures", "sync-scroll.md");
const FIXTURE_SHORT = path.join(ROOT, "tests", "fixtures", "sync-scroll-b.md");

function findBrowser() {
  if (flag("browser")) return flag("browser");
  const candidates = [
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Chromium", "Application", "chrome.exe"),
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit)
    throw new Error(
      "找不到 Edge/Chromium，可用 --browser=<路径> 指定。尝试过：" + candidates.join(", "),
    );
  return hit;
}

function buildHarness() {
  mkdirSync(OUT, { recursive: true });
  // 用 esbuild 的 JS API：`node_modules/.bin/esbuild` 在 Windows 上是 shell 包装，
  // spawn 它会 ENOENT。
  buildSync({
    entryPoints: [HARNESS_TS],
    bundle: true,
    format: "iife",
    outfile: path.join(OUT, "harness.js"),
    logLevel: "warning",
  });
  const css = path.join(OUT, "harness.css");
  writeFileSync(
    path.join(OUT, "harness.html"),
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="harness.css">${existsSync(css) ? "" : ""}
<style>
  /* 复刻 app 的视口尺寸纪律：layout 吃满，面板各占一半，纵向不滚。 */
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { background: #fff; }
  #layout { display: flex; height: 100vh; width: 100vw; }
  #layout > .panel-host { flex: 1 1 50%; min-width: 0; }
  .panel-editor { flex: 1 1 auto; min-height: 0; }
  .panel-head { height: 34px; flex: 0 0 34px; background: #f2f2f2; }
  .tab { display: inline-block; padding: 6px 10px; font: 13px/1.4 sans-serif; }
</style>
</head><body>
<div id="layout"></div>
<script>
window.__FIXTURE_LONG__ = ${JSON.stringify(readFileSync(FIXTURE_LONG, "utf8"))};
window.__FIXTURE_SHORT__ = ${JSON.stringify(readFileSync(FIXTURE_SHORT, "utf8"))};
</script>
<script src="harness.js"></script>
</body></html>`,
  );
}

// ───────────────────────────── CDP ─────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }
  static async open(url) {
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error("CDP WebSocket 连不上"));
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJson(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(
        "页内求值异常：" + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text),
      );
    }
    return r.result.value;
  }
  wheel(x, y, deltaY, deltaX = 0) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }
  async move(x, y, button = "none") {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button });
  }
  async press(x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  async release(x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  async click(x, y) {
    await this.move(x, y);
    await this.press(x, y);
    await delay(50);
    await this.release(x, y);
  }
  async key(code, key, vk) {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      code,
      key,
      windowsVirtualKeyCode: vk,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      code,
      key,
      windowsVirtualKeyCode: vk,
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已经断了 */
    }
  }
}

// ───────────────────────────── 页内测量（独立复算 v）─────────────────────────────

/**
 * 顶边源码行坐标 v（1-based 行号 + 行内小数），两侧各自独立复算：
 *   编辑器：视口顶落在哪条 `.cm-line` 的哪个比例。软折行只放大该行块高，不改行号。
 *   预览  ：视口顶落在哪一对 `[data-line-start]` 块之间，按「块顶→下一块顶」对行号跨度线性插值。
 * 两侧算的是同一个量，所以「同 v ⇒ 顶边显示同一处源码」可以被直接断言。
 *
 * 可测性按**布局真相**判（`getClientRects()`），不按 class：class 是我们自己写的约定，
 * 布局才是用户看到的东西。生产里每个面板都同时挂着编辑器与预览、靠 CSS 藏一个
 * （`src/styles/preview.css:632-640`），被藏起来的那一侧不参与判定。
 */
const MEASURE = `(() => {
  const origin = (scroller) => scroller.getBoundingClientRect();
  const relTop = (el, scRect, scroller) => el.getBoundingClientRect().top - scRect.top + scroller.scrollTop;
  const out = [];
  for (const host of document.querySelectorAll(".panel-host")) {
    const entry = {
      panelId: Number(host.dataset.panelId),
      editor: null,
      preview: null,
      tabs: [...host.querySelectorAll(".panel-tabstrip .tab[data-tab-id]")].map((t) => {
        const r = t.getBoundingClientRect();
        return {
          tabId: Number(t.dataset.tabId),
          active: t.classList.contains("tab-active"),
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          visible: r.width > 0 && r.height > 0,
        };
      }),
    };

    const scroller = host.querySelector(".cm-scroller");
    const content = host.querySelector(".cm-content");
    if (scroller && content && scroller.getClientRects().length) {
      const rect = origin(scroller);
      // ⚠️ CM6 只渲染视口附近的行，cm-line 的**下标不是文档行号**（下标 0 可能是第 24 行）。
      // 而行号栏里混着 cm-gap 占位格（文本不是数字），**按下标对齐会串位**——本探针第一版
      // 就是这么数错行号的。改按几何对齐：取与该行顶边 y 最近的数字格，它写的就是行号。
      const lines = [...content.querySelectorAll(":scope > .cm-line")];
      const marks = [...host.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
        .map((el) => ({ n: Number(el.textContent.trim()), top: el.getBoundingClientRect().top }))
        .filter((m) => Number.isFinite(m.n));
      const top = scroller.scrollTop;
      let idx = 0;
      for (let i = 0; i < lines.length; i++) {
        if (relTop(lines[i], rect, scroller) <= top + 0.5) idx = i;
        else break;
      }
      const el = lines[idx] ?? lines[0];
      const t = el ? relTop(el, rect, scroller) : 0;
      const h = el ? Math.max(1, el.getBoundingClientRect().height) : 1;
      let lineNo = idx + 1;
      if (marks.length && el) {
        const want = el.getBoundingClientRect().top;
        let best = marks[0];
        for (const m of marks) if (Math.abs(m.top - want) < Math.abs(best.top - want)) best = m;
        lineNo = best.n;
      }
      entry.editor = {
        v: lineNo + Math.min(1, Math.max(0, (top - t) / h)),
        lineNoSource: marks.length ? "gutter-by-geometry" : "index-fallback",
        scrollTop: top,
        maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        atBottom: top >= Math.max(0, scroller.scrollHeight - scroller.clientHeight) - 1,
        renderedLines: lines.length,
        firstRenderedLine: marks.length ? marks[0].n : 1,
        lineCount: marks.length ? marks[marks.length - 1].n : lines.length,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        right: rect.right,
        height: rect.height,
        scrollbarSpace: rect.width - scroller.clientWidth,
      };
    }

    const pv = host.querySelector(".md-preview");
    if (pv && pv.getClientRects().length) {
      const rect = origin(pv);
      const top = pv.scrollTop;
      const blocks = [...pv.querySelectorAll(":scope > [data-line-start]")].map((el) => ({
        lineStart: Number(el.dataset.lineStart),
        lineEnd: Number(el.dataset.lineEnd ?? el.dataset.lineStart),
        top: relTop(el, rect, pv),
        height: el.getBoundingClientRect().height,
      }));
      let v = blocks.length ? blocks[0].lineStart : 1;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const next = blocks[i + 1];
        if (top < b.top) { v = b.lineStart; break; }
        if (!next) {
          const lines = Math.max(1, b.lineEnd - b.lineStart + 1);
          v = b.lineStart + (b.height > 0 ? (top - b.top) / (b.height / lines) : 0);
          break;
        }
        if (top < next.top) {
          const span = Math.max(1, next.top - b.top);
          const range = Math.max(1, next.lineStart - b.lineStart);
          v = b.lineStart + ((top - b.top) / span) * range;
          break;
        }
      }
      entry.preview = {
        v,
        scrollTop: top,
        maxScroll: Math.max(0, pv.scrollHeight - pv.clientHeight),
        atBottom: top >= Math.max(0, pv.scrollHeight - pv.clientHeight) - 1,
        blockCount: blocks.length,
        lineCount: blocks.length ? blocks[blocks.length - 1].lineEnd : 0,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        height: rect.height,
      };
    }
    out.push(entry);
  }
  return out;
})()`;

/** 取「可见的编辑器」与「可见的预览」那一对表面（同文档，用户眼里就是左右两栏）。 */
function pair(snap) {
  const ep = snap.find((p) => p.editor);
  const pp = snap.find((p) => p.preview && p.preview.blockCount > 0);
  if (!ep || !pp) return null;
  // 摊平一层：场景直接用 `.v` / `.x`，`panelId` 带在表面上一并存。
  return {
    editor: { ...ep.editor, panelId: ep.panelId },
    preview: { ...pp.preview, panelId: pp.panelId },
  };
}

const fmt = (snap) =>
  snap
    .map(
      (p) =>
        `P${p.panelId} ed=${p.editor ? p.editor.v.toFixed(2) : "·"} pv=${p.preview ? p.preview.v.toFixed(2) : "·"}`,
    )
    .join(" | ");

/** 条件式等待：轮到所有 v 连续 stableRounds 次不变才认「落定」，不拍固定睡眠。 */
async function settle(cdp, { stableRounds = 3, timeoutMs = 4000 } = {}) {
  const start = Date.now();
  let last = null;
  let same = 0;
  while (Date.now() - start < timeoutMs) {
    const snap = await cdp.evalJson(MEASURE);
    const key = snap
      .map((p) => `${p.editor?.v.toFixed(2) ?? "-"},${p.preview?.v.toFixed(2) ?? "-"}`)
      .join(";");
    same = key === last ? same + 1 : 0;
    last = key;
    if (same >= stableRounds) return snap;
    await delay(50);
  }
  return cdp.evalJson(MEASURE);
}

// ───────────────────────────── 判定 ─────────────────────────────

const results = [];
function verdict(id, name, status, detail) {
  results.push({ id, status });
  console.log(`${{ PASS: "✅", FAIL: "❌", SKIP: "⚠️ " }[status]} [${id}] ${name}\n     ${detail}`);
}
const delta = ({ editor, preview }) => Math.abs(editor.v - preview.v);

/** 快照里每个可见 pane 的 v，用于「没人碰它，它不许动」。 */
const fingerprint = (snap) =>
  snap.map((p) => ({ panelId: p.panelId, ed: p.editor?.v ?? null, pv: p.preview?.v ?? null }));

function movedPanes(before, after, ignorePanelIds = []) {
  const out = [];
  for (const b of before) {
    if (ignorePanelIds.includes(b.panelId)) continue;
    const a = after.find((x) => x.panelId === b.panelId);
    if (!a) continue;
    if (b.ed !== null && a.ed !== null && Math.abs(b.ed - a.ed) > TOL)
      out.push(`P${b.panelId}.编辑器 ${b.ed.toFixed(2)}→${a.ed.toFixed(2)}`);
    if (b.pv !== null && a.pv !== null && Math.abs(b.pv - a.pv) > TOL)
      out.push(`P${b.panelId}.预览 ${b.pv.toFixed(2)}→${a.pv.toFixed(2)}`);
  }
  return out;
}

/**
 * 把两侧带离顶部并返回那一帧的配对。
 * 没有它，「不许动」类断言会在两侧本来就停在 1.00 时恒真 —— 那是空转断言，
 * 不是通过（本仓库的反假绿纪律：断言必须有鉴别力）。
 */
async function preScroll(cdp, px = 900) {
  const p = pair(await settle(cdp));
  await cdp.click(p.editor.x, p.editor.y);
  // 先回顶再向下滚：否则上一条场景把视口留在底部时，这次 wheel 位移为 0，
  // 「关掉同步后预览没动」会因为「什么都没滚」而恒真（S9 第一版就这么假过）。
  await cdp.wheel(p.editor.x, p.editor.y, -20000);
  await settle(cdp, { stableRounds: 3 });
  await cdp.wheel(p.editor.x, p.editor.y, px);
  const s = pair(await settle(cdp, { stableRounds: 4 }));
  return { start: s, credible: s.editor.v >= 5 };
}

/**
 * 轨迹诊断：`--trace=wheel|pagedown|drag|switch|rerender`。
 * 高频采样两侧的 v，用来区分两种完全不同的病：
 *   「一次都没广播」（对侧全程不动）vs「广播了但值错」（对侧跟了但停在错的位置）vs
 *   「广播了半程就停」（对侧跟到一半不动了）。三者的修法不一样，不能靠猜。
 */
async function trace(cdp, kind) {
  const p = pair(await settle(cdp));
  const t0 = Date.now();
  const samples = [];
  const sampler = setInterval(async () => {
    try {
      const s = pair(await cdp.evalJson(MEASURE));
      samples.push([Date.now() - t0, s.editor.v, s.preview.v]);
    } catch {
      /* 采样失败不干扰主流程 */
    }
  }, 30);

  if (kind === "wheel") {
    await cdp.click(p.editor.x, p.editor.y);
    await delay(200);
    await cdp.wheel(p.editor.x, p.editor.y, 600);
  } else if (kind === "pagedown") {
    await cdp.click(p.editor.x, p.editor.y);
    await delay(200);
    await cdp.key("PageDown", "PageDown", 34);
  } else if (kind === "drag") {
    const slot = p.editor.scrollbarSpace;
    if (slot < 4) console.log("滚动条槽太窄，覆盖式滚动条 ⇒ 用 wheel 代替");
    const x = p.editor.right - Math.floor(Math.max(4, slot) / 2);
    const y0 = p.editor.y - p.editor.height / 3;
    await cdp.press(x, y0);
    for (let i = 1; i <= 6; i++) {
      await cdp.move(x, y0 + i * 26, "left");
      await delay(60);
    }
    await cdp.release(x, y0 + 6 * 26);
  } else if (kind === "switch") {
    await cdp.wheel(p.editor.x, p.editor.y, 900);
    await delay(400);
    await cdp.evalJson(`__harness.switchTab(${p.editor.panelId}, 1)`);
    await delay(300);
    await cdp.evalJson(`__harness.switchTab(${p.editor.panelId}, 0)`);
  } else if (kind === "rerender") {
    await cdp.wheel(p.editor.x, p.editor.y, 700);
    await delay(400);
    const previewPanelId = (await cdp.evalJson(MEASURE)).find((x) => x.preview)?.panelId;
    const diag = await cdp.evalJson(`__harness.rerenderPreview(${previewPanelId})`);
    console.log("同栈诊断（setBlocks 前后）：", JSON.stringify(diag));
  }
  await delay(1200);
  clearInterval(sampler);

  console.log(`轨迹（${kind}）    t(ms)   编辑器v    预览v      差`);
  for (const [t, e, v] of samples) {
    console.log(
      `  ${String(t).padStart(7)}  ${e.toFixed(2).padStart(8)}  ${v.toFixed(2).padStart(8)}  ${Math.abs(
        e - v,
      )
        .toFixed(2)
        .padStart(7)}`,
    );
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const previewEverMoved = samples.some((s) => Math.abs(s[2] - first[2]) > 0.2);
  console.log(
    `\n判定线索：编辑器动了 ${Math.abs(last[1] - first[1]).toFixed(2)} 行；预览${previewEverMoved ? "跟过" : "全程没动"}；` +
      `末帧差 ${Math.abs(last[1] - last[2]).toFixed(2)} 行` +
      `${previewEverMoved && Math.abs(last[1] - last[2]) > 1 ? " ⇒ 广播了半程或值算错，不是没广播" : ""}`,
  );
}

// ───────────────────────────── 场景 ─────────────────────────────

const SCENARIOS = [
  {
    id: "S1",
    name: "编辑器滚轮向下 → 预览跟手（正向同步真的发生）",
    async: async ({ cdp }) => {
      const before = pair(await settle(cdp));
      await cdp.move(before.editor.x, before.editor.y);
      await cdp.click(before.editor.x, before.editor.y);
      const start = pair(await settle(cdp));
      await cdp.wheel(before.editor.x, before.editor.y, 600);
      const after = pair(await settle(cdp));
      const moved = after.editor.v - start.editor.v;
      const d = delta(after);
      if (moved < 0.5)
        return ["FAIL", `滚轮 600px，编辑器只动了 ${moved.toFixed(2)} 行 ⇒ 同步没跟上`];
      return d <= TOL
        ? [
            "PASS",
            `编辑器动了 ${moved.toFixed(1)} 行，两侧顶边差 ${d.toFixed(2)} 行（容差 ${TOL}）`,
          ]
        : ["FAIL", `两侧顶边差 ${d.toFixed(2)} 行 > 容差 ${TOL} ⇒ 同步了但位置偏移`];
    },
  },
  {
    id: "S2",
    name: "预览滚轮向上 → 编辑器跟手（反向同步，不是单向跟随）",
    async: async ({ cdp }) => {
      // 必须先带离顶部：在 v=1.00 处向上滚 450px 浏览器本来就动不了，
      // 那样「编辑器没跟」会被误读成反向不同步（本探针第一版就是这么假红的）。
      const seeded = await preScroll(cdp, 1200);
      if (!seeded.credible)
        return [
          "SKIP",
          `预置滚动不足（编辑器在 ${seeded.start.editor.v.toFixed(2)} 行）⇒ 无法向上滚`,
        ];
      const p = seeded.start;
      const startV = p.editor.v;
      const startPvV = p.preview.v;
      const startPvTop = p.preview.scrollTop;
      await cdp.wheel(p.preview.x, p.preview.y, -450);
      const after = pair(await settle(cdp));
      // 先自证「输入真的作用在预览上」，否则「编辑器没动」不能归给同步代码。
      if (
        Math.abs(after.preview.scrollTop - startPvTop) < 2 &&
        Math.abs(after.preview.v - startPvV) < 0.5
      )
        return [
          "SKIP",
          `注入的滚轮没有作用到预览（scrollTop ${startPvTop}→${after.preview.scrollTop}）⇒ 探针落点问题，不判被测代码`,
        ];
      const moved = startV - after.editor.v;
      const d = delta(after);
      if (moved < 0.5)
        return [
          "FAIL",
          `预览从 ${startPvV.toFixed(2)} 滚到 ${after.preview.v.toFixed(2)}，编辑器却只动了 ${moved.toFixed(2)} 行 ⇒ 反向不同步`,
        ];
      return d <= TOL
        ? ["PASS", `编辑器回退 ${moved.toFixed(1)} 行，差 ${d.toFixed(2)} 行`]
        : ["FAIL", `反向同步后两侧差 ${d.toFixed(2)} 行`];
    },
  },
  {
    id: "S3",
    name: "连续滚轮（惯性节拍）→ 每一拍都跟手，不是「只同步上一次」",
    async: async ({ cdp }) => {
      const p = pair(await settle(cdp));
      const worst = [];
      for (let i = 0; i < 6; i++) {
        await cdp.wheel(p.editor.x, p.editor.y, 120);
        const after = pair(await settle(cdp, { stableRounds: 2, timeoutMs: 1200 }));
        worst.push(delta(after));
      }
      const max = Math.max(...worst);
      return max <= TOL
        ? ["PASS", `6 拍逐拍最大偏差 ${max.toFixed(2)} 行`]
        : ["FAIL", `逐拍最大偏差 ${max.toFixed(2)} 行（滞后一拍的表现）`];
    },
  },
  {
    id: "S4",
    name: "键盘 PageDown → 也算用户滚动（不只认滚轮）",
    async: async ({ cdp }) => {
      const p = pair(await settle(cdp));
      await cdp.click(p.editor.x, p.editor.y);
      const before = pair(await settle(cdp));
      await cdp.key("PageDown", "PageDown", 34);
      const after = pair(await settle(cdp));
      const moved = after.editor.v - before.editor.v;
      const d = delta(after);
      if (moved < 0.5) return ["FAIL", `PageDown 后编辑器只动了 ${moved.toFixed(2)} 行`];
      return d <= TOL
        ? ["PASS", `键盘滚 ${moved.toFixed(1)} 行，差 ${d.toFixed(2)} 行`]
        : ["FAIL", `键盘滚动后两侧差 ${d.toFixed(2)} 行`];
    },
  },
  {
    id: "S5",
    name: "拖滚动条 → 全程跟手（按下那一下不算滚动）",
    async: async ({ cdp }) => {
      const p = pair(await settle(cdp));
      const slot = p.editor.scrollbarSpace;
      if (slot < 4) return ["SKIP", `滚动条槽宽 ${slot}px（覆盖式滚动条），无法按坐标拖动`];
      const x = p.editor.right - Math.floor(slot / 2);
      const y0 = p.editor.y - p.editor.height / 3;
      await cdp.press(x, y0);
      const worst = [];
      for (let i = 1; i <= 6; i++) {
        await cdp.move(x, y0 + i * 26, "left");
        const s = pair(await settle(cdp, { stableRounds: 2, timeoutMs: 900 }));
        worst.push(delta(s));
      }
      await cdp.release(x, y0 + 6 * 26);
      const d = delta(pair(await settle(cdp)));
      const max = Math.max(...worst);
      return max <= TOL && d <= TOL
        ? ["PASS", `拖动过程最大偏差 ${max.toFixed(2)} 行、落点 ${d.toFixed(2)} 行`]
        : ["FAIL", `拖动中最大偏差 ${max.toFixed(2)} 行（按下即读、拖动不续 ⇒ 滞后一拍）`];
    },
  },
  {
    id: "S6",
    name: "切标签 → 另一栏预览纹丝不动（结构性滚动不得广播）",
    async: async ({ cdp }) => {
      // 先把两侧带离顶部：都在 1.00 时「切回来原位复现」是恒真的空转断言。
      const { start, credible } = await preScroll(cdp);
      if (!credible)
        return ["SKIP", `预置滚动后编辑器只在 ${start.editor.v.toFixed(2)} 行 ⇒ 断言会空转，不判`];

      const before = fingerprint(await cdp.evalJson(MEASURE));
      const editorPanelId = start.editor.panelId;
      const startEditorV = start.editor.v;
      const startPreviewV = start.preview.v;

      await cdp.evalJson(`__harness.switchTab(${editorPanelId}, 1)`);
      const mid = fingerprint(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      const movedAway = movedPanes(before, mid, [editorPanelId]);

      await cdp.evalJson(`__harness.switchTab(${editorPanelId}, 0)`);
      const after = fingerprint(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      const movedBack = movedPanes(before, after, [editorPanelId]);
      const restored = after.find((x) => x.panelId === editorPanelId)?.ed;
      const previewNow = after.find((x) => x.panelId !== editorPanelId)?.pv ?? null;

      const problems = [];
      if (movedAway.length) problems.push(`切走时动了不该动的：${movedAway.join("，")}`);
      if (movedBack.length) problems.push(`切回时动了不该动的：${movedBack.join("，")}`);
      if (previewNow !== null && Math.abs(previewNow - startPreviewV) > TOL)
        problems.push(`预览从 ${startPreviewV.toFixed(2)} 漂到 ${previewNow.toFixed(2)}`);
      if (restored === null || Math.abs(restored - startEditorV) > TOL)
        problems.push(
          `切回后编辑器在 ${restored === null ? "∅" : restored.toFixed(2)}，切走前是 ${startEditorV.toFixed(2)} ⇒ 位置记忆丢失（调回顶部）`,
        );
      return problems.length
        ? ["FAIL", problems.join("；")]
        : [
            "PASS",
            `另一栏未动（预览仍在 ${previewNow.toFixed(2)}），标签原位复现 ${restored.toFixed(2)}`,
          ];
    },
  },
  {
    id: "S7",
    name: "预览整块重渲染（编辑/重载路径）→ 不许把对栏拽走",
    async: async ({ cdp }) => {
      const p = pair(await settle(cdp));
      await cdp.wheel(p.editor.x, p.editor.y, 300);
      const before = fingerprint(await settle(cdp));
      const previewPanelId = (await cdp.evalJson(MEASURE)).find((x) => x.preview)?.panelId;
      await cdp.evalJson(`__harness.rerenderPreview(${previewPanelId})`);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const moved = movedPanes(before, fingerprint(after));
      const d = delta(pair(after));
      if (moved.length) return ["FAIL", `重渲染拽动了：${moved.join("，")}`];
      return d <= TOL
        ? ["PASS", `重渲染后仍对齐（差 ${d.toFixed(2)} 行）`]
        : ["FAIL", `重渲染后两侧差 ${d.toFixed(2)} 行`];
    },
  },
  {
    id: "S8",
    name: "滚到底 → 两侧各自到达自己的可滚上限（「到底」不是 v 相等）",
    async: async ({ cdp }) => {
      const p = pair(await settle(cdp));
      await cdp.click(p.editor.x, p.editor.y);
      for (let i = 0; i < 8; i++) await cdp.wheel(p.editor.x, p.editor.y, 3000);
      const after = pair(await settle(cdp, { stableRounds: 4, timeoutMs: 6000 }));
      const e = after.editor;
      const v = after.preview;
      return e.atBottom && v.atBottom
        ? [
            "PASS",
            `两侧均到底（ed ${e.scrollTop}/${e.maxScroll}，pv ${v.scrollTop}/${v.maxScroll}）`,
          ]
        : [
            "FAIL",
            `编辑器到底=${e.atBottom}（${e.scrollTop}/${e.maxScroll}），预览到底=${v.atBottom}（${v.scrollTop}/${v.maxScroll}）` +
              ` ⇒ 一侧被裁剪后 v 永不等，反复重设或直接卡住`,
          ];
    },
  },
  {
    id: "S15",
    name: "到底之后再往上滚一格 → 必须恢复跟手（被裁住的承诺不许锁死联动）",
    async: async ({ cdp }) => {
      // 先把两侧带到底（与 S8 同一手法），拿到「谁被自己的可滚上限裁住了」这个前提。
      const p = pair(await settle(cdp));
      await cdp.click(p.editor.x, p.editor.y);
      for (let i = 0; i < 8; i++) await cdp.wheel(p.editor.x, p.editor.y, 3000);
      const at = pair(await settle(cdp, { stableRounds: 4, timeoutMs: 6000 }));
      if (!at.editor.atBottom || !at.preview.atBottom)
        return ["SKIP", "没能把两侧都带到底 ⇒ 前提不成立，不判"];
      // 自证「承诺真的被裁住过」：两侧各自到底时 v 不同，说明广播过去的那个意图至少有一侧
      // 是够不着的。两侧 v 相同 ⇒ 没有裁剪发生 ⇒ 本场景对这条缺陷是空转的（不判通过）。
      if (Math.abs(at.editor.v - at.preview.v) <= TOL)
        return [
          "SKIP",
          `两侧到底时 v 已相等（${at.editor.v.toFixed(2)} = ${at.preview.v.toFixed(2)}）⇒ 没有被裁住的承诺，不判`,
        ];
      const pvTop = at.preview.scrollTop;
      const start = at;
      await cdp.wheel(at.preview.x, at.preview.y, -600);
      const after = pair(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      if (Math.abs(after.preview.scrollTop - pvTop) < 2)
        return [
          "FAIL",
          `预览向上滚却被弹回原地（仍在 ${after.preview.scrollTop}）⇒ 兑不了现的承诺把用户滚动判成「没兑现」并补写拽回`,
        ];
      const edMoved = start.editor.v - after.editor.v;
      if (edMoved < 0.5)
        return [
          "FAIL",
          `预览从 ${start.preview.v.toFixed(2)} 滚回 ${after.preview.v.toFixed(2)}，编辑器仍在 ${after.editor.v.toFixed(2)} ⇒ 到底以后联动锁死`,
        ];
      const d = delta(after);
      return d <= TOL
        ? [
            "PASS",
            `预览回退 ${(start.preview.v - after.preview.v).toFixed(1)} 行，编辑器跟着回退 ${edMoved.toFixed(1)} 行，差 ${d.toFixed(2)} 行`,
          ]
        : ["FAIL", `恢复跟手但两侧差 ${d.toFixed(2)} 行`];
    },
  },
  {
    id: "S9",
    name: "B152 关掉 → 两侧彻底独立（关掉还同步 = 开关没生效）",
    async: async ({ cdp }) => {
      const ids = await cdp.evalJson(`__harness.docIds()`);
      const { start, credible } = await preScroll(cdp);
      if (!credible)
        return [
          "SKIP",
          `预置滚动不足（编辑器在 ${start.editor.v.toFixed(2)} 行）⇒「没动」会恒真，不判`,
        ];
      await cdp.evalJson(`__harness.setSyncEnabled("${ids.long}", false)`);
      const before = fingerprint(await settle(cdp, { stableRounds: 3 }));
      const p = pair(await cdp.evalJson(MEASURE));
      await cdp.wheel(p.editor.x, p.editor.y, 500);
      const after = fingerprint(await settle(cdp, { stableRounds: 4 }));
      const pvBefore = before.find((b) => b.pv !== null);
      const pvAfter = after.find((b) => b.pv !== null);
      const edMoved = Math.abs(
        (after.find((b) => b.ed !== null)?.ed ?? 0) - (before.find((b) => b.ed !== null)?.ed ?? 0),
      );
      const drift = Math.abs((pvAfter?.pv ?? 0) - (pvBefore?.pv ?? 0));
      await cdp.evalJson(`__harness.setSyncEnabled("${ids.long}", true)`);
      if (edMoved < 0.5) return ["SKIP", `关掉同步后编辑器自己也没动 ⇒ 输入没落上，不判`];
      if (drift > TOL)
        return ["FAIL", `关掉同步后预览仍被拽动 ${drift.toFixed(2)} 行（开关没生效）`];
      return [
        "PASS",
        `编辑器动了 ${edMoved.toFixed(1)} 行，预览纹丝不动（漂移 ${drift.toFixed(2)} 行）`,
      ];
    },
  },
  {
    id: "S10",
    name: "无用户手势的空转期 → 任何 pane 都不许自己动（回声/看门狗不该产生位移）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 500);
      if (!credible)
        return [
          "SKIP",
          `预置滚动不足（编辑器在 ${start.editor.v.toFixed(2)} 行）⇒「不动」会恒真，不判`,
        ];
      const before = fingerprint(await settle(cdp, { stableRounds: 5 }));
      await delay(1800); // 盖过 60 帧兜底看门狗（≈1s）：它一旦解锁就会把迟到的结构性 scroll 广播出去
      const after = fingerprint(await cdp.evalJson(MEASURE));
      const moved = movedPanes(before, after);
      return moved.length
        ? ["FAIL", `没人碰它却动了：${moved.join("，")} ⇒ 兜底解锁后迟到的结构性滚动漏出广播`]
        : ["PASS", "1.8s 静默期内零位移"];
    },
  },
  {
    id: "S11",
    name: "新开一格侧边预览（分屏新增）→ 已有两栏不许动",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const before = fingerprint(await settle(cdp, { stableRounds: 4 }));
      await cdp.evalJson(`__harness.addPreviewPanel()`);
      const after = fingerprint(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      const moved = movedPanes(before, after);
      // 清理：别把新增的面板留给后续场景
      const newId = after.find((a) => !before.some((b) => b.panelId === a.panelId))?.panelId;
      if (newId !== undefined) await cdp.evalJson(`__harness.removePanel(${newId})`);
      await settle(cdp, { stableRounds: 3 });
      return moved.length
        ? ["FAIL", `新增分屏拽动了已有面板：${moved.join("，")}`]
        : ["PASS", "新增一格未影响已有两栏"];
    },
  },
  {
    id: "S12",
    name: "关掉一格面板 → 剩下的两栏不许动",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const newId = await cdp.evalJson(`__harness.addPreviewPanel()`);
      await settle(cdp, { stableRounds: 3 });
      const before = fingerprint(await settle(cdp, { stableRounds: 3 }));
      await cdp.evalJson(`__harness.removePanel(${newId})`);
      const after = fingerprint(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      const moved = movedPanes(before, after, [newId]);
      return moved.length
        ? ["FAIL", `关掉一格把剩下的拽动了：${moved.join("，")}`]
        : ["PASS", "注销一格未影响其余面板"];
    },
  },
  {
    id: "S13",
    name: "源码/预览模式切换 → 对栏不许被拽动（B270 那一族）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const previewPanelId = (await cdp.evalJson(MEASURE)).find((x) => x.preview)?.panelId;
      const before = fingerprint(await settle(cdp, { stableRounds: 4 }));
      await cdp.evalJson(`__harness.setMode(${previewPanelId}, "source")`);
      const flipped = fingerprint(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      await cdp.evalJson(`__harness.setMode(${previewPanelId}, "preview")`);
      const after = fingerprint(await settle(cdp, { stableRounds: 4, timeoutMs: 5000 }));
      const movedOnFlip = movedPanes(before, flipped, [previewPanelId]);
      const movedBack = movedPanes(before, after, [previewPanelId]);
      const problems = [];
      if (movedOnFlip.length) problems.push(`切模式时动了：${movedOnFlip.join("，")}`);
      if (movedBack.length) problems.push(`切回时动了：${movedBack.join("，")}`);
      return problems.length
        ? ["FAIL", problems.join("；")]
        : ["PASS", "切模式 / 切回均未带动对栏"];
    },
  },
  {
    id: "S14",
    name: "面板由隐藏转可见 → 落回被藏起来之前的位置（B233/B285 那一族）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 1200);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const previewPanelId = (await cdp.evalJson(MEASURE)).find((x) => x.preview)?.panelId;
      const pvBefore = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === previewPanelId)
        ?.preview?.v;
      await cdp.evalJson(`__harness.setMode(${previewPanelId}, "source")`);
      await settle(cdp, { stableRounds: 3, timeoutMs: 4000 });
      await cdp.evalJson(`__harness.setMode(${previewPanelId}, "preview")`);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const pvAfter = after.find((x) => x.panelId === previewPanelId)?.preview?.v;
      if (pvBefore === undefined || pvAfter === undefined)
        return ["SKIP", "揭示后该面板的预览不可测（布局没给出矩形）"];
      const drift = Math.abs(pvAfter - pvBefore);
      return drift <= TOL
        ? ["PASS", `揭示后回到原位 ${pvAfter.toFixed(2)}（藏前 ${pvBefore.toFixed(2)}）`]
        : [
            "FAIL",
            `揭示后落在 ${pvAfter.toFixed(2)}，藏前是 ${pvBefore.toFixed(2)} ⇒ 漂移 ${drift.toFixed(2)} 行（显隐丢位置）`,
          ];
    },
  },
  {
    id: "S16",
    name: "同格「源码 ↔ 预览」切换 → 现形那一侧必须停在同一处源码（不许弹顶、不许跳光标行）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const peerPanelId = start.preview.panelId;
      const wantV = start.editor.v;
      const peerV = start.preview.v;
      // ⚠️ `preScroll` 里那次 click 把光标留在视口中间，而生产的 `toggleViewMode` 切回源码
      // 时会 `focus()`（CM6 把光标行滚进视野）。所以「落在 1.00」是弹顶、「落在光标那一行」
      // 是 focus 抢了落点 —— 两种病都要能跟「停在 wantV」分开认。
      await cdp.evalJson(`__harness.setMode(${panelId}, "preview")`);
      const mid = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const pv = mid.find((x) => x.panelId === panelId)?.preview?.v ?? null;
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      const back = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const ev = back.find((x) => x.panelId === panelId)?.editor?.v ?? null;
      const peerNow = back.find((x) => x.panelId === peerPanelId)?.preview?.v ?? null;
      const problems = [];
      if (pv === null) problems.push("切到预览后这一格量不到预览（没现形？）");
      else if (Math.abs(pv - wantV) > TOL)
        problems.push(
          `切到预览落在 ${pv.toFixed(2)}，切走前编辑器在 ${wantV.toFixed(2)}${pv < 2 ? "（≈顶部 ⇒ display:none 把它归零了）" : ""}`,
        );
      if (ev === null) problems.push("切回源码后这一格量不到编辑器");
      else if (Math.abs(ev - wantV) > TOL)
        problems.push(
          `切回源码落在 ${ev.toFixed(2)}，切走前在 ${wantV.toFixed(2)}${ev < 2 ? "（≈顶部）" : ""}`,
        );
      if (peerNow !== null && Math.abs(peerNow - peerV) > TOL)
        problems.push(
          `对栏被带动 ${peerV.toFixed(2)}→${peerNow.toFixed(2)} ⇒ 切模式没重注册，幽灵锚点把滚动广播了出去`,
        );
      return problems.length
        ? ["FAIL", problems.join("；")]
        : ["PASS", `来回切换都停在 ${wantV.toFixed(2)} 行附近，对栏未动`];
    },
  },
  {
    id: "S17",
    name: "把另一张标签拖到别的面板 → 这一格正在显示的位置不许被抹掉（B281/B288）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const snap = await cdp.evalJson(MEASURE);
      const src = snap.find((x) => x.tabs.length > 1 && x.editor);
      if (!src) return ["SKIP", "没有任何一格挂着两张标签 ⇒ 拖放无从发生"];
      const host = snap.find((x) => x.panelId !== src.panelId);
      if (!host) return ["SKIP", "只有一格面板 ⇒ 没有「另一格」可拖过去"];
      const tabId = src.tabs[1].tabId; // 拖走**没在显示**的那张：这一格的内容与位置都不该变
      const wantV = src.editor.v;
      const wantTop = src.editor.scrollTop;
      await cdp.evalJson(`__harness.moveTab(${tabId}, ${host.panelId})`);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const now = after.find((x) => x.panelId === src.panelId)?.editor;
      // 还原：拖回去 + 指回第一张，别让后续场景接手一个已经改过档的台子
      await cdp.evalJson(`__harness.moveTab(${tabId}, ${src.panelId})`);
      await cdp.evalJson(`__harness.switchTab(${src.panelId}, 0)`);
      await settle(cdp, { stableRounds: 3 });
      if (!now) return ["SKIP", "拖放后源面板量不到编辑器"];
      return Math.abs(now.v - wantV) <= TOL
        ? ["PASS", `另一张标签被拖走后仍停在 ${now.v.toFixed(2)} 行`]
        : [
            "FAIL",
            `只是把**没在显示**的另一张标签拖走，这一格却从 ${wantV.toFixed(2)}（top ${wantTop}px）跳到 ${now.v.toFixed(2)}（top ${now.scrollTop}px）` +
              ` ⇒ rebuildLayout 销毁重建 view，而这条路上没有任何 scrollV 快照 / 账本登记`,
          ];
    },
  },
  {
    id: "S18",
    name: "打开侧边预览（同源复制新开一格）→ 必须停在源当前的位置（B259）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const wantV = start.editor.v;
      const newId = await cdp.evalJson(`__harness.addPreviewPanel()`);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const pv = after.find((x) => x.panelId === newId)?.preview?.v;
      await cdp.evalJson(`__harness.removePanel(${newId})`);
      await settle(cdp, { stableRounds: 3 });
      if (pv === undefined) return ["SKIP", "新格量不到预览（布局没给出矩形）"];
      return Math.abs(pv - wantV) <= TOL
        ? ["PASS", `新格预览落在 ${pv.toFixed(2)}，与源 ${wantV.toFixed(2)} 对齐`]
        : [
            "FAIL",
            `新格预览落在 ${pv.toFixed(2)}，源编辑器在 ${wantV.toFixed(2)} ⇒ 复制出的实例没带源视口位置（跨窗口同理：载荷里根本没有 scrollV）`,
          ];
    },
  },
  {
    id: "S19",
    name: "预览态的标签切走再切回 → 必须回到这张标签自己的位置（真机日志：模式=preview 视图=0）",
    async: async ({ cdp }) => {
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const wantV = start.editor.v;
      // 真机日志的形状是**两张预览态标签之间**互切（`tab=3 模式=preview 视图=1149` →
      // `tab=4 模式=preview 视图=0`，而且是两份不同文档），不是「预览 ↔ 源码」互切。
      // 所以这里把这一格的两张标签都摆成预览态：A 停在 wantV，B 是另一份文档。
      const toPreviewMode = async (index) => {
        await cdp.evalJson(`__harness.switchTab(${panelId}, ${index})`);
        await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
        await cdp.evalJson(`__harness.setMode(${panelId}, "preview")`);
        await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      };
      await toPreviewMode(0);
      const aShown = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId)?.preview?.v;
      if (aShown === undefined || Math.abs(aShown - wantV) > TOL)
        return [
          "SKIP",
          `A 切到预览后这一格在 ${aShown?.toFixed(2) ?? "∅"}，不是 ${wantV.toFixed(2)} ⇒ 前提（S16）没立住，本场景不判`,
        ];
      await toPreviewMode(1); // 切到 B：另一份文档，预览被整块重渲染
      const bV = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId)?.preview?.v;
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`); // 再切回 A
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const now = after.find((x) => x.panelId === panelId)?.preview?.v ?? null;
      // 收尾：两张都切回源码态，别把预览态留给后续场景
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`);
      await settle(cdp, { stableRounds: 3 });
      if (now === null) return ["SKIP", "切回后量不到这一格的预览"];
      return Math.abs(now - wantV) <= TOL
        ? [
            "PASS",
            `切回 A 后预览仍在 ${now.toFixed(2)}（切走前 ${wantV.toFixed(2)}，中途 B 在 ${bV?.toFixed(2) ?? "∅"}）`,
          ]
        : [
            "FAIL",
            `两张预览态标签互切：A 切走前在 ${wantV.toFixed(2)}，绕 B（${bV?.toFixed(2) ?? "∅"}）切回来却落在 ${now.toFixed(2)}` +
              `（真机同形：模式=preview 视图=0）⇒ switchTab 的快照与恢复两端都只认编辑器，` +
              `而预览态下它是 display:none：读回恒 1.0、写回是空操作，预览位置没有任何记忆`,
          ];
    },
  },
  {
    id: "S20",
    name: "落位过程中的每一帧都不许出现「归零帧」（用户肉眼看到的跳变 = 中间态被画出来了）",
    async: async ({ cdp }) => {
      // 台子的其它场景都在 `settle()`（落定 3~4 帧）之后才测 ⇒ 天生看不见中间态。
      // 用户报「动作当场就跳」而四条路径全中、本台子全绿，最吻合的解释就是这个盲区：
      // `setState` / `display:none` 把位置抹成 0 的那一帧**被画出来了**，下一帧才扶回去。
      // 这里在动作之后立刻高频采样（不等落定），任何一帧掉到顶部附近即判 FAIL。
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const wantV = start.editor.v;
      const samples = [];
      const shoot = async (label) => {
        for (let i = 0; i < 10; i++) {
          const host = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId);
          const v = host?.preview?.v ?? host?.editor?.v ?? null;
          if (v !== null) samples.push([label, i, v]);
          await delay(28);
        }
      };
      await cdp.evalJson(`__harness.setMode(${panelId}, "preview")`);
      await shoot("切到预览");
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      await shoot("切回源码");
      await cdp.evalJson(`__harness.switchTab(${panelId}, 1)`);
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`);
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      await settle(cdp, { stableRounds: 3 });
      const dips = samples.filter(([, , v]) => v < 2 && wantV > 5);
      if (!samples.length) return ["SKIP", "一个样本都没采到（该格切换后量不到）"];
      if (dips.length)
        return [
          "FAIL",
          `切到 ${wantV.toFixed(1)} 行的位置时，中途有 ${dips.length} 帧在顶部附近（最低 ${Math.min(
            ...dips.map((x) => x[2]),
          ).toFixed(2)}）⇒ 归零的那一帧被画出来了，落定后才扶回 = 肉眼「当场就跳」。` +
            `帧序列：${dips
              .slice(0, 4)
              .map((x) => `${x[0]}#${x[1]}=${x[2].toFixed(2)}`)
              .join(" ")}`,
        ];
      return [
        "PASS",
        `${samples.length} 帧里没有任何一帧掉到顶部（最低 ${Math.min(...samples.map((x) => x[2])).toFixed(2)}，目标 ${wantV.toFixed(2)}）⇒ 落位发生在同一帧内`,
      ];
    },
  },
  {
    id: "S21",
    name: "落位之后块高才定局（KaTeX / Mermaid 后到）→ v 不许漂（用户：最后还是错的）",
    async: async ({ cdp }) => {
      // 这条验的是上一轮查到的台子/真机不对称：落位发生在 `setBlocks` 的同一同步栈里，而
      // `enhance()`（公式、图、代码高亮）是**之后**才替换节点、才把块高定下来的。
      // 要让它有鉴别力，两件事缺一不可：
      //   1. fixture 里必须有「渲染之后才变高」的内容，且排在落点**之上**（公式 + mermaid 图，
      //      见 `tests/fixtures/sync-scroll.md` 的「第一节之二」）；落点之下变高什么都动不了。
      //   2. 第一次取样**不能等 settle**：`settle()` 要等 v 连续几轮不动才返回，而块高正是在
      //      落位之后的那一拍定下来的 —— 等过它再比，两次读数天然一样（本条上一版自报
      //      「无鉴别力」就是这个原因）。
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const wantV = start.editor.v;
      await cdp.evalJson(`__harness.setMode(${panelId}, "preview")`);
      const grab = async () =>
        (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId)?.preview ?? null;
      const pv0 = await grab(); // 落位之后**立刻**读：这时增强还没跑完
      if (!pv0) return ["SKIP", "切到预览后量不到该格预览"];
      // 等几何定局（连续两轮 maxScroll / 块数一致），最多 6s
      let pv1 = pv0;
      const t0 = Date.now();
      for (;;) {
        await delay(120);
        const now = await grab();
        if (!now) return ["SKIP", "静置过程中量不到该格预览"];
        const stable =
          Math.abs(now.maxScroll - pv1.maxScroll) <= 1 && now.blockCount === pv1.blockCount;
        pv1 = now;
        if (stable || Date.now() - t0 > 6000) break;
      }
      // 先问「这条场景**能**失败吗」，再谈它绿不绿。
      const grew = Math.abs(pv1.maxScroll - pv0.maxScroll) > 1 || pv1.blockCount !== pv0.blockCount;
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      await settle(cdp, { stableRounds: 3 });
      if (!grew)
        return [
          "SKIP",
          `无鉴别力：落位之后几何没再变过（maxScroll ${pv0.maxScroll} → ${pv1.maxScroll}，` +
            `块数 ${pv0.blockCount} → ${pv1.blockCount}）⇒ 增强没有在落点后改块高，` +
            `这一发测不出「落位钉在旧几何」，不能当证据`,
        ];
      const drift = Math.abs(pv1.v - pv0.v);
      if (drift > TOL)
        return [
          "FAIL",
          `落定那一刻在 ${pv0.v.toFixed(2)}（top ${pv0.scrollTop}），几何后到定局后漂到 ` +
            `${pv1.v.toFixed(2)}（top ${pv1.scrollTop}，maxScroll ${pv0.maxScroll} → ${pv1.maxScroll}）` +
            `⇒ 块高是**之后**才定局的，落位钉在旧几何上 = 最终位置本身就是错的（切走前源在 ${wantV.toFixed(2)}）`,
        ];
      const off = Math.abs(pv1.v - wantV);
      if (off > TOL)
        return [
          "FAIL",
          `几何定局后停在 ${pv1.v.toFixed(2)}，而切走前源码在 ${wantV.toFixed(2)}（差 ${off.toFixed(2)} 行，` +
            `maxScroll ${pv0.maxScroll} → ${pv1.maxScroll}）⇒ 增强改块高把接力位置冲掉了`,
        ];
      return [
        "PASS",
        `静置期间几何确实后到定局（maxScroll ${pv0.maxScroll} → ${pv1.maxScroll}，` +
          `块数 ${pv0.blockCount} → ${pv1.blockCount}），v 仍在 ${pv1.v.toFixed(2)}` +
          `（当场 ${pv0.v.toFixed(2)}，漂 ${drift.toFixed(2)} 行；源 ${wantV.toFixed(2)}）` +
          `⇒ 落位跟上了后到的块高变化`,
      ];
    },
  },
  {
    id: "S22",
    name: "源码态标签互切 5 轮 → 位置不许逐次衰减（真机 02:42：23.32→23.10→23.03→23.01）",
    async: async ({ cdp }) => {
      // 真机那一族每切一次掉 0.03~0.2 行，而台子的判定容差是 1 行 —— 上一轮 S6 打出的
      // 「原位复现 43.00 vs 43.67」其实就是同一件事，只是被容差吃掉了。所以这条**必须**
      // 用远小于 TOL 的严格容差，否则它永远绿，等于没测。
      const STRICT = 0.1;
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const readA = async () =>
        (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId)?.editor?.v ?? null;
      const go = async (index, rounds) => {
        await cdp.evalJson(`__harness.switchTab(${panelId}, ${index})`);
        await settle(cdp, { stableRounds: rounds, timeoutMs: 5000 });
        return readA();
      };
      const samples = [await go(0, 3)];
      for (let round = 1; round <= 5; round++) {
        await go(1, 3); // 切到另一张（不同文档 ⇒ setState 整篇重排）
        samples.push(await go(0, 4)); // 切回来：这一发的落点就是「位置记忆」的真实读数
      }
      const first = samples[0];
      const known = samples.filter((x) => x !== null);
      if (known.length < samples.length) return ["SKIP", "互切过程中量不到这一格的编辑器"];
      const worst = Math.max(...known.map((x) => Math.abs(x - first)));
      const series = known.map((x) => x.toFixed(2)).join(" → ");
      const tail = known[known.length - 1];
      return worst <= STRICT
        ? [
            "PASS",
            `5 轮互切每次回到 ${first.toFixed(2)} 附近（最大漂 ${worst.toFixed(3)} 行，严格容差 ${STRICT}）：${series}`,
          ]
        : [
            "FAIL",
            `5 轮互切后落在 ${tail.toFixed(2)}（起点 ${first.toFixed(2)}，最大漂 ${worst.toFixed(3)} 行 > ${STRICT}）：${series}` +
              `⇒ 落位被当时还没定局的布局裁住，随后同一像素被重新解释成另一个行号，` +
              `而账本按 v 认回声 ⇒ 自己那一发被判成用户滚动（假广播拽对栏）+ 漂移读数被存进位置记忆`,
          ];
    },
  },
  {
    id: "S25",
    name: "同源复制的第二张源码标签（复制后一直在旁边没显示过）→ 切过去必须跟随当前共享位置（B292 方案 A）",
    async: async ({ cdp }) => {
      // 真机时序（03:45 / 05:36）：A 滚到中段并同步走右栏 ⇒ 切到那张**复制出来后就再没显示过**的
      // B。B 自己记的是它出现那一刻的顶部；隐藏期间它不注册、收不到广播 ⇒ 旧行为「B 停在滚动前」。
      // 注意别把复制那一刻当成测量点：复制出来的 B 会被立刻设为活动并停在顶部，那时「共享位置」
      // 合法地就是 1.00（本轮第一版就是这么写错了，SKIP 而非 PASS）。
      const first = await preScroll(cdp, 900);
      if (!first.credible) return ["SKIP", `预置滚动不足（${first.start.editor.v.toFixed(2)} 行）`];
      const panelId = first.start.editor.panelId;
      const dup = await cdp.evalJson(`__harness.duplicateTab(${panelId}, 0)`);
      if (typeof dup !== "number" || dup < 0) return ["SKIP", "同源复制这张标签没建起来"];
      await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`); // 切回 A，让 B 从此只在旁边待着
      await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      await preScroll(cdp, 600); // 再滚 A：这一步才制造出「A 有新位置、B 记的是陈值」的分叉
      const again = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId)?.editor?.v;
      if (again === undefined || again < 3)
        return ["SKIP", `切回 A 再滚之后在 ${again?.toFixed(2) ?? "∅"}，位置差不足 ⇒ 前提没立住`];
      const wantV = again;
      const stale = 1.0; // B 记的那一份：它出现时停在顶部
      await cdp.evalJson(`__harness.switchTab(${panelId}, ${dup})`);
      const landed = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const onB = landed.find((x) => x.panelId === panelId)?.editor?.v ?? null;
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`);
      await settle(cdp, { stableRounds: 3 });
      if (onB === null) return ["SKIP", "切到 B 后量不到这一格的编辑器"];
      return Math.abs(onB - wantV) <= TOL
        ? [
            "PASS",
            `B 切过去落在 ${onB.toFixed(2)}，与当前共享位置 ${wantV.toFixed(2)} 一致（它自己记的是 ${stale.toFixed(2)}）⇒ 接班标签跟随共享 v`,
          ]
        : [
            "FAIL",
            `B 切过去落在 ${onB.toFixed(2)}：既不是共享位置 ${wantV.toFixed(2)}，` +
              `⇒ 隐藏那一张不注册 ⇒ 收不到广播，接班时回到的是自己的陈值`,
          ];
    },
  },
  {
    id: "S26",
    name: "复制标签（同源新开一张）→ 出现那一下就得停在文档当前位置，且不许把整份文档拽到顶部（B293）",
    async: async ({ cdp }) => {
      // S25 管的是「切到那张复制品」，这一条管的是「复制品**出现**那一下」：
      // `duplicateTabToPanel` 直接把新实例设为活动并 `rebuildLayout`，`mountView` 按
      // `tab.scrollV` 落位，而 `makeInstance` 的缺省是 1 ⇒ 新标签停在顶部。
      // 更狠的是第二半：这张新标签随即成为该文档**第一个在册视口**，于是 B292 方案 A
      // （接班跟随共享 v）读到的共享值就变成 1.00 ⇒ 整份文档被拽到顶部。这两步在
      // `.tmp` 取证里的原始读数：`P0 ed=1.00/0px`、`currentV(X)=1`、切回第一张 `ed=1.00`。
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const ids = await cdp.evalJson(`__harness.docIds()`);
      const wantV = start.editor.v;
      const shared0 = await cdp.evalJson(`__harness.currentV("${ids.long}")`);
      const dup = await cdp.evalJson(`__harness.duplicateTab(${panelId}, 0)`);
      if (typeof dup !== "number" || dup < 0) return ["SKIP", "同源复制这张标签没建起来"];
      const shown = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const onCopy = shown.find((x) => x.panelId === panelId)?.editor?.v ?? null;
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`); // 切回原来那张
      const back = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const onOrigin = back.find((x) => x.panelId === panelId)?.editor?.v ?? null;
      if (onCopy === null || onOrigin === null) return ["SKIP", "复制/切回过程中量不到这一格"];
      const problems = [];
      if (Math.abs(onCopy - wantV) > TOL)
        problems.push(
          `复制出来的那张出现在 ${onCopy.toFixed(2)}，文档此刻在 ${wantV.toFixed(2)}` +
            `${onCopy < 2 ? "（≈顶部 ⇒ 新实例带的是 makeInstance 的缺省 1，没人把共享位置种给它）" : ""}`,
        );
      if (Math.abs(onOrigin - wantV) > TOL)
        problems.push(
          `切回原来那张落到 ${onOrigin.toFixed(2)}（切走前 ${wantV.toFixed(2)}）` +
            `⇒ 停在顶部的复制品成了该文档第一个在册视口，方案 A 把整份文档拽上顶`,
        );
      return problems.length
        ? ["FAIL", problems.join("；")]
        : [
            "PASS",
            `出现在 ${onCopy.toFixed(2)}、切回 ${onOrigin.toFixed(2)}（源 ${wantV.toFixed(2)}，抄下时共享 ${shared0?.toFixed(2)}）⇒ 复制那一下没把位置丢掉，也没带塌整份文档`,
          ];
    },
  },
  {
    id: "S27",
    name: "拖标签跨面板 → 搬走的那张与源面板接班的那张都停在共享位置（B293）",
    async: async ({ cdp }) => {
      // 取证结论：被拖走的那张**没病**（`rebuildLayout` 销毁前按可见侧快照了它，落位拿到的是
      // 活值 ⇒ 真机 43.67 原样跟到新格）。病在**源面板接班那一张**：`moveTabToPanel` 把
      // `src.activeTabId` 指向 `src.tabs[last]`，如果那是一张从没显示过的同源标签，它的
      // `scrollV` 是陈值 ⇒ 这一格弹到旧位置/顶部，而它随即成为该文档第一个在册视口。
      // 所以这条判据是「mountView 这条重建路径也要跟随共享 v」，与 `switchTab` 同口径。
      const { start, credible } = await preScroll(cdp, 900);
      if (!credible) return ["SKIP", `预置滚动不足（${start.editor.v.toFixed(2)} 行）`];
      const panelId = start.editor.panelId;
      const host = start.preview.panelId;
      const ids = await cdp.evalJson(`__harness.docIds()`);
      // 1) 造一张「同源、之后一直在旁边没显示过」的标签当接班（复用 duplicateTab 构造器）。
      const dup = await cdp.evalJson(`__harness.duplicateTab(${panelId}, 0)`);
      if (typeof dup !== "number" || dup < 0) return ["SKIP", "接班用的同源标签没造出来"];
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`);
      await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      // 2) 再滚一次：这一步才让「共享位置」与「接班那张记的陈值」分叉。
      await preScroll(cdp, 600);
      const now = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === panelId)?.editor;
      const stale = await cdp.evalJson(`__harness.scrollVOf(${panelId}, ${dup})`);
      if (!now || now.v < 3)
        return ["SKIP", `再滚之后这一格在 ${now?.v.toFixed(2) ?? "∅"} ⇒ 前提没立住`];
      if (stale === null || Math.abs(stale - now.v) <= TOL)
        return [
          "SKIP",
          `无鉴别力：接班那张记的 ${stale?.toFixed(2) ?? "∅"} 与当前共享位置 ${now.v.toFixed(2)} 没分叉 ⇒ 本条判据这一发测不出`,
        ];
      const wantV = now.v;
      const shared0 = await cdp.evalJson(`__harness.currentV("${ids.long}")`);
      const shownTabId = (await cdp.evalJson(MEASURE))
        .find((x) => x.panelId === panelId)
        .tabs.find((t) => t.active).tabId;
      // 3) 把**正在显示**的那张拖到另一格面板 ⇒ 源面板由那张陈值标签接班。
      await cdp.evalJson(`__harness.moveTab(${shownTabId}, ${host})`);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 6000 });
      const srcNow = after.find((x) => x.panelId === panelId)?.editor ?? null;
      const hostNow = after.find((x) => x.panelId === host)?.editor ?? null;
      // 还原：拖回去 + 指回第一张，别把改过档的台子留给后续场景。
      await cdp.evalJson(`__harness.moveTab(${shownTabId}, ${panelId})`);
      await cdp.evalJson(`__harness.switchTab(${panelId}, 0)`);
      await settle(cdp, { stableRounds: 3 });
      if (!srcNow || !hostNow)
        return [
          "SKIP",
          `拖放后量不到（源面板=${srcNow ? "有" : "无"} 目标面板=${hostNow ? "有" : "无"}）`,
        ];
      const problems = [];
      if (Math.abs(srcNow.v - wantV) > TOL)
        problems.push(
          `源面板接班那张落在 ${srcNow.v.toFixed(2)}，拖走前文档在 ${wantV.toFixed(2)}，` +
            `而它自己记的陈值是 ${stale.toFixed(2)}${Math.abs(srcNow.v - stale) <= TOL ? "（= 陈值 ⇒ 重建路径按 tab.scrollV 落位，没人跟随共享 v）" : ""}`,
        );
      if (Math.abs(hostNow.v - wantV) > TOL)
        problems.push(`被拖走的那张落在 ${hostNow.v.toFixed(2)}，拖走前在 ${wantV.toFixed(2)}`);
      return problems.length
        ? ["FAIL", problems.join("；")]
        : [
            "PASS",
            `拖走后源面板接班那张 ${srcNow.v.toFixed(2)}、新格里那张 ${hostNow.v.toFixed(2)}，都在共享位置 ${wantV.toFixed(2)} 附近（接班那张自己记的是陈值 ${stale.toFixed(2)}）`,
          ];
    },
  },
  {
    id: "S30",
    name: "跨窗口同步滚动（B297）：只有用户滚动才外发；对端推来的 v 落到本窗口每个面，且绝不回推",
    async: async ({ cdp }) => {
      // 真机才有两个窗口与一条 IPC，台子只有一个 JS 上下文 —— 但**两端各自的接线**在真实
      // 浏览器里全部可判：① 用户滚一格，外发口必须被叫到、且发的是这一帧落定后的 v；
      // ② 对端推来一个远处的 v，本窗口这一文档的每个可见面（源码侧 + 预览侧）各自换算落到
      //    同一个 v（**像素必须不同**，相同就说明跨窗口传的是像素而不是共享坐标）；
      // ③ 这一发远端套用**不得**再外发（回声环在源头就不成立，而不是靠对端认 `from`）；
      // ④ 这份文档的同步关着 ⇒ 推不动（开关 gate 的是整条联动，收端也算）。
      // 台子的场景按顺序复用同一页状态 ⇒ 前提自己摆正，并且**认准同一份文档**的两个面：
      // 上一条留下的是哪份文档、哪一格露着源码侧，都会让判据②把别的文档的预览算进来。
      const long = Number((await cdp.evalJson(`__harness.docIds()`)).long);
      const doc = String(long);
      const snapDocs = async () => {
        const sn = await cdp.evalJson(MEASURE);
        const pd = await cdp.evalJson(`__harness.docIdsOfPanels()`);
        const docOf = (id) => pd.find((x) => x.panelId === id)?.docId;
        return { sn, docOf };
      };
      // 面板的显隐与模式是**上一条场景留下的既态**（S27 收尾把这份文档留在了预览态），
      // 所以「哪一格露着源码侧」不能靠碰运气找：先把挂着这份文档的面板自己切成源码态，
      // 量不到就换下一格，全部失败才认 SKIP —— 前置是自己摆的，判据才只测被测的那件事。
      const hostIds = async () =>
        (await cdp.evalJson(`__harness.docIdsOfPanels()`))
          .filter((x) => x.docId === long)
          .map((x) => x.panelId);
      let srcHost = null;
      let candidates = await hostIds();
      if (!candidates.length) {
        // 这份文档一格都没有（前面被关掉/拖走了）⇒ 「打开侧边预览」那条路会造出 docLongId 的新格
        await cdp.evalJson(`__harness.addPreviewPanel()`);
        await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
        candidates = await hostIds();
      }
      for (const id of candidates) {
        await cdp.evalJson(`__harness.setMode(${id}, "source")`);
        await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
        srcHost = (await cdp.evalJson(MEASURE)).find((h) => h.panelId === id && h.editor);
        if (srcHost) break;
      }
      if (!srcHost)
        return [
          "SKIP",
          `把挂着这份文档的面板（${candidates.join(",") || "∅，且开不出新格"}）逐个切到源码态后仍量不到编辑器`,
        ];
      const ep = srcHost.panelId;
      let { sn, docOf } = await snapDocs();
      let pvHost = sn.find(
        (h) => h.panelId !== ep && h.preview?.blockCount > 0 && docOf(h.panelId) === long,
      );
      if (!pvHost) {
        // 「打开侧边预览」那条路造的正是这份文档的预览格
        await cdp.evalJson(`__harness.addPreviewPanel()`);
        await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
        ({ sn, docOf } = await snapDocs());
        pvHost = sn.find(
          (h) => h.panelId !== ep && h.preview?.blockCount > 0 && docOf(h.panelId) === long,
        );
      }
      if (!pvHost) return ["SKIP", "造不出同一文档的预览面 ⇒ 判据②（各自换算）测不了"];
      const pp = pvHost.panelId;

      // 真实滚轮预置：先回顶再向下滚（滚轮位移在已经贴底时是 0，会把「什么都没发生」读成通过）
      const ed0 = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === ep)?.editor;
      if (!ed0) return ["SKIP", "切回源码后这一格量不到了"];
      await cdp.evalJson(`__harness.clearOutbound()`);
      await cdp.click(ed0.x, ed0.y);
      await cdp.wheel(ed0.x, ed0.y, -20000);
      await settle(cdp, { stableRounds: 3 });
      await cdp.wheel(ed0.x, ed0.y, 700);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const edV = after.find((x) => x.panelId === ep)?.editor?.v ?? 0;
      if (edV < 5)
        return [
          "SKIP",
          `预置滚动不足（${edV.toFixed(2)} 行）⇒ 这一格的布局没定局，本条判据无从下手`,
        ];

      // ① 用户真的滚了一格 ⇒ 外发口被叫到，且发的是这一帧落定后的 v
      const count = await cdp.evalJson(`__harness.outboundCount()`);
      const last = await cdp.evalJson(`__harness.lastOutbound()`);
      if (!count)
        return [
          "SKIP",
          "无鉴别力：这一发用户滚动一个字节都没外发（外发口没接上，或被账本判成了回声）⇒ 本条测不出跨窗口",
        ];
      if (!last || last.docId !== doc || Math.abs(last.v - edV) > TOL)
        return [
          "FAIL",
          `用户滚动外发了 ${JSON.stringify(last)}，而编辑器落定在 ${edV.toFixed(2)}（doc ${doc}）⇒ 发的不是这一帧的位置`,
        ];

      // ② / ③ 对端推来一个远处的 v
      const want = Math.max(3, Math.round(edV / 2));
      await cdp.evalJson(`__harness.clearOutbound()`);
      await cdp.evalJson(`__harness.applyRemoteV("${doc}", ${want})`);
      const moved = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const ed2 = moved.find((x) => x.panelId === ep)?.editor;
      const pv2 = moved.find((x) => x.panelId === pp)?.preview;
      const echoed = await cdp.evalJson(`__harness.outboundCount()`);
      const problems = [];
      if (echoed)
        problems.push(
          `远端套用之后又外发了 ${echoed} 次 ⇒ 回声环：对端会被推回同一个位置，两个窗口互相拽`,
        );
      if (!ed2 || Math.abs(ed2.v - want) > TOL)
        problems.push(`源码侧落在 ${ed2 ? ed2.v.toFixed(2) : "∅"}，对端要求 ${want}`);
      if (!pv2 || Math.abs(pv2.v - want) > TOL)
        problems.push(`预览侧落在 ${pv2 ? pv2.v.toFixed(2) : "∅"}，对端要求 ${want}`);
      if (ed2 && pv2 && Math.abs(ed2.scrollTop - pv2.scrollTop) < 2)
        problems.push(
          `两侧像素一模一样（${Math.round(ed2.scrollTop)}）⇒ 跨窗口传的大概率是像素而不是共享坐标 v`,
        );

      // ④ 关着 ⇒ 推不动
      if (!problems.length) {
        const off = want + 8;
        await cdp.evalJson(`__harness.setSyncEnabled("${doc}", false)`);
        await cdp.evalJson(`__harness.applyRemoteV("${doc}", ${off})`);
        await settle(cdp, { stableRounds: 2, timeoutMs: 2500 });
        const held = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === ep)?.editor;
        await cdp.evalJson(`__harness.setSyncEnabled("${doc}", true)`);
        if (held && Math.abs(held.v - off) <= TOL)
          problems.push(
            `这份文档的同步关着，却被对端推到了 ${held.v.toFixed(2)} ⇒ 开关没 gate 收端`,
          );
      }
      return problems.length
        ? ["FAIL", problems.join("；")]
        : [
            "PASS",
            `用户滚一格 ⇒ 外发 ${count} 次（最后一发 v=${last.v.toFixed(2)}，与落定一致）；` +
              `对端推 ${want} ⇒ 源码 ${ed2.v.toFixed(2)} / 预览 ${pv2.v.toFixed(2)} 同一个 v、` +
              `各自像素 ${Math.round(ed2.scrollTop)} vs ${Math.round(pv2.scrollTop)}，回推 0 次；关着推不动`,
          ];
    },
  },
  {
    id: "S31",
    name: "两格宽度不同 ⇒ 按行首字符贴得到同一视觉行、只按 v 贴不到（B300 逐行对齐）",
    async: async ({ cdp }) => {
      // 判据本体。`v` 的小数是「该逻辑行**块高**的比例」，而块高随宽度变（软折行数不同）⇒
      // 两格宽度不同时，同一个 `v` 对应的根本不是同一行文字（真机对照：同一 `v=6.83`，
      // 主窗口 376px、新窗口 280px ⇒ 用户眼里的「有点偏移」）。这一条把同一份文档摆进两格
      // 源码、给它们**不同宽度**，然后比两种落法的差别：
      //   1. 用户滚 A ⇒ 外发必须带数字型的行首字符位置（不带 = 接线没通，红）。
      //   2. 按 pos 推给 B ⇒ B 顶边所在视觉行必须**包含**那个字符（真 CM6 的 coordsAtPos 比行顶）。
      //   3. 只按 v 推给 B ⇒ 对照。若这样也贴得到同一行，说明这两档宽度此刻折行没差别
      //      ⇒ 这一发无鉴别力，如实报 SKIP，不算通过。
      const snap = () => cdp.evalJson(MEASURE);
      const docIds = await cdp.evalJson(`__harness.docIdsOfPanels()`);
      const long = Number((await cdp.evalJson(`__harness.docIds()`)).long);
      let A = -1;
      for (const x of docIds.filter((d) => d.docId === long)) {
        await cdp.evalJson(`__harness.setMode(${x.panelId}, "source")`);
        await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
        if ((await snap()).find((h) => h.panelId === x.panelId)?.editor) {
          A = x.panelId;
          break;
        }
      }
      if (A < 0) return ["SKIP", "没有一格能把这份文档摆在源码侧"];
      const others = (await snap()).filter((h) => h.panelId !== A);
      if (!others.length) return ["SKIP", "台子只剩一格，摆不出第二档宽度"];
      const B = others[0].panelId;
      // 同源复制一张搬到 B（S26/S27 的构造器），两格都源码态显示这份文档
      const dupIndex = await cdp.evalJson(`__harness.duplicateTab(${A}, 0)`);
      if (typeof dupIndex !== "number" || dupIndex < 0) return ["SKIP", "同源复制这张标签没建起来"];
      await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      // ⚠️ `duplicateTab` 返回的是**序号**（host.tabs.length-1），不是 tabId：拿序号当 id 去
      // moveTab 会搬错一张（本轮就是这么把 doc=2 搬过去的）。按序号把 id 取回来。
      const aIds = await cdp.evalJson(`__harness.tabIdsOf(${A})`);
      const copyId = aIds[dupIndex];
      if (typeof copyId !== "number") return ["SKIP", "按序号取不回复制那张的 tabId"];
      await cdp.evalJson(`__harness.moveTab(${copyId}, ${B})`);
      // 搬过去不等于挂上去：显式切到那一张，否则 B 挂的还是它自己原来那份文档
      const bIds = await cdp.evalJson(`__harness.tabIdsOf(${B})`);
      const bIdx = bIds.indexOf(copyId);
      if (bIdx < 0) return ["SKIP", `搬过去那张不在 B 的标签表里（B=${bIds.join(",")}）`];
      await cdp.evalJson(`__harness.switchTab(${B}, ${bIdx})`);
      await cdp.evalJson(`__harness.setMode(${B}, "source")`);
      await cdp.evalJson(`__harness.switchTab(${A}, 0)`);
      await settle(cdp, { stableRounds: 3, timeoutMs: 6000 });
      const docsNow = await cdp.evalJson(`__harness.docIdsOfPanels()`);
      if (docsNow.find((x) => x.panelId === B)?.docId !== long)
        return [
          "SKIP",
          `搬不到第二格：B 现在挂的是 doc=${docsNow.find((x) => x.panelId === B)?.docId ?? "?"}，不是这份文档`,
        ];
      // 前提：得有**真的会软折行**的长行，否则两档宽度下同一行都只有一视觉行，按 v 与按
      // 字符落的是同一行 ⇒ 本条测不出差别（上一发就是这么如实报无鉴别力的）。
      // 长行由场景自己塞进来、跑完还原（用 fixture 原文再走一次整段纠错那条生产路径）。
      const NL = String.fromCharCode(10);
      const longLines =
        "# 折行试验" +
        NL +
        Array.from({ length: 12 }, (_, i) => `第${i}段 ` + "长".repeat(600)).join(NL) +
        NL;
      await cdp.evalJson(`__harness.remoteFullResync(${long}, ${JSON.stringify(longLines)})`);
      await settle(cdp, { stableRounds: 4, timeoutMs: 6000 });
      // 两档宽度：让同一行在 A 里折得多、在 B 里折得少（这正是跨窗口那种不一致）
      await cdp.evalJson(`__harness.setWidth(${A}, 620)`);
      await cdp.evalJson(`__harness.setWidth(${B}, 980)`);
      await settle(cdp, { stableRounds: 4, timeoutMs: 6000 });
      const both = await snap();
      const ea = both.find((x) => x.panelId === A)?.editor;
      const eb = both.find((x) => x.panelId === B)?.editor;
      if (!ea || !eb) {
        await cdp.evalJson(`__harness.setWidth(${A}, 0)`);
        await cdp.evalJson(`__harness.setWidth(${B}, 0)`);
        return ["SKIP", "改宽度之后量不到两格的源码面"];
      }
      // A 真滚一格（CDP 真实滚轮）⇒ 外发带 pos
      await cdp.evalJson(`__harness.clearOutbound()`);
      await cdp.click(ea.x, ea.y);
      await cdp.wheel(ea.x, ea.y, -12000);
      await settle(cdp, { stableRounds: 3 });
      await cdp.wheel(ea.x, ea.y, 900);
      const after = await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const vA = after.find((x) => x.panelId === A)?.editor?.v ?? 0;
      const last = await cdp.evalJson(`__harness.lastOutbound()`);
      const problems = [];
      if (vA < 3) {
        problems.push(`A 预置滚动只有 ${vA.toFixed(2)} 行 ⇒ 前提没立住`);
      } else if (!last || typeof last.pos !== "number") {
        problems.push(`外发没带行首字符位置（最后一发 ${JSON.stringify(last)}）⇒ pos 那条接线没通`);
      }
      let byPos = null;
      let byV = null;
      if (!problems.length) {
        const pos = last.pos;
        await cdp.evalJson(`__harness.applyRemoteV("${long}", ${vA}, ${pos})`);
        await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
        byPos = await cdp.evalJson(`__harness.alignReport(${B}, ${pos})`);
        if (!byPos || byPos.charTop === null) {
          problems.push("B 格顶边量不到 A 顶边那个字符 ⇒ 判据无从下手");
        } else if (Math.abs(byPos.charTop) > 2) {
          problems.push(
            `按 pos 对齐后，A 顶边那个字符在 B 顶边${byPos.charTop > 0 ? "下方" : "上方"} ${Math.abs(byPos.charTop)}px` +
              `（B 行首=${byPos.topPos}）⇒ 逐行对齐没生效`,
          );
        }
        // 对照：**只按 v 推**（改造前的行为）。`v` 的小数是「该行块高的比例」，块高随宽度变
        // ⇒ 顶边落在那一视觉行的中间，用户看到的「有点偏移」就是这个。它要也能把那个字符
        // 摆到顶边，说明这两档宽度此刻折行没差别 ⇒ 这一发没有鉴别力，如实报 SKIP，不许当通过。
        await cdp.evalJson(`__harness.applyRemoteV("${long}", ${vA}, null)`);
        await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
        byV = await cdp.evalJson(`__harness.alignReport(${B}, ${pos})`);
        if (byV && Math.abs(byV.charTop ?? 0) <= Math.abs(byPos?.charTop ?? 0) + 2)
          problems.push("SKIP-无鉴别力");
      }
      // 还原台子：文本、宽度、复制那张都归位，别把改过几何的台子留给后面的场景
      await cdp.evalJson(`__harness.remoteFullResync(${long}, window.__FIXTURE_LONG__)`);
      await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      await cdp.evalJson(`__harness.setWidth(${A}, 0)`);
      await cdp.evalJson(`__harness.setWidth(${B}, 0)`);
      await cdp.evalJson(`__harness.moveTab(${copyId}, ${A})`);
      await cdp.evalJson(`__harness.switchTab(${A}, 0)`);
      await settle(cdp, { stableRounds: 3, timeoutMs: 5000 });
      if (problems.includes("SKIP-无鉴别力"))
        return [
          "SKIP",
          `无鉴别力：这一档宽度组合下只按 v 也能把 A 顶边那个字符摆到 B 顶边` +
            ` ⇒ 本条测不出两种落法的差别（byPos=${JSON.stringify(byPos)} byV=${JSON.stringify(byV)}）`,
        ];
      return problems.length
        ? ["FAIL", problems.join("；")]
        : [
            "PASS",
            `用户滚 A（${vA.toFixed(2)} 行）外发带顶边字符 ${last.pos}；推给另一档宽度的 B：` +
              `按 pos 那个字符就在顶边（偏 ${byPos?.charTop}px，像素 ${byPos?.scrollTop}），` +
              `只按 v 差 ${byV?.charTop}px（像素 ${byV?.scrollTop}）⇒ 行对齐要靠字符，不靠块高比例`,
          ];
    },
  },
  {
    id: "S28",
    name: "落位链必须自己收口：没布局时先藏起来、收口后一定露出来（B294/B295）",
    async: async ({ cdp }) => {
      // 台子平时「一帧就落准」，复现不了真机那条 `落点px=0.00` 的多帧落位。`landWhileHidden`
      // 用「没有布局盒」把同一个形状造出来（`display:none` 下 `scrollTop` 写入无效 ⇒ 读回恒 1.00），
      // 于是这条场景同时判两件事：
      //   1. **链条有没有藏**：写入进不去时必须把那一侧的滚动面藏起来 —— 不藏就是把「顶部 /
      //      估算位置」这些中间态画给用户看（用户报的「对齐前闪动」）。改动前这条是红的。
      //   2. **收口守卫**：落准或到重试上限之后必须露出来，绝不能把内容永久藏死（那比闪动更糟）。
      const first = (await cdp.evalJson(MEASURE)).find((x) => x.editor || x.preview);
      if (!first) return ["SKIP", "一格都量不到"];
      const panelId = first.panelId;
      // 造的形是「编辑器那一侧没有布局盒」⇒ 可见侧必须是编辑器。`setMode` 是**赋值**不是取反
      // （与 `toggleViewMode` 同形），已经是源码态时这一发无害。
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
      const want = 20;
      const r = await cdp.evalJson(`__harness.landWhileHidden(${panelId}, ${want})`);
      if (!r) return ["SKIP", "宿主拿不到这一格的滚动面（faceOf 返回 null）"];
      const after = await settle(cdp, { stableRounds: 3, timeoutMs: 4000 });
      const vis = await cdp.evalJson(
        `(() => { const el = document.querySelector('.panel-host[data-panel-id="${panelId}"] .cm-scroller');` +
          `return el` +
          ` ? { v: getComputedStyle(el).visibility, top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }` +
          ` : null; })()`,
      );
      const geom = `滚动面 vis=${vis?.v} scrollTop=${vis?.top} scrollHeight=${vis?.sh} clientHeight=${vis?.ch}`;
      const ed = after.find((x) => x.panelId === panelId)?.editor;
      if (r.concealed !== "hidden")
        return [
          "FAIL",
          `写入被裁到 0 的那一发没有把滚动面藏起来（concealed="${r.concealed}"）⇒ ` +
            `顶部/估算位置那些中间态又会被画出来（B295）`,
        ];
      if (vis?.v === "hidden")
        return [
          "FAIL",
          `链条走完滚动面仍是 visibility:hidden ⇒ 内容被永久藏死（露出那一发丢了；${geom}）`,
        ];
      return [
        "PASS",
        `没布局时藏起来重试（concealed=hidden）→ 收口露出（vis=${vis?.v}）→ ` +
          `停在 ${ed ? ed.v.toFixed(2) : "∅"}（意图 ${want}；${geom}）。` +
          `判据只有前两条（藏过 / 不许留在藏着）：这里用 display:none 造的「完全没有布局」比真机` +
          `「刚 new 出来还没量行高」更狠，链条能否在 3 次上限内落准取决于那一格先前量过没有，` +
          `所以位置只作读数不作判据。`,
      ];
    },
  },
  {
    id: "S29",
    name: "落位链在途时又来一轮结构性重建 ⇒ 位置不许被读成顶部（B296 · 跨窗口双重建）",
    async: async ({ cdp }) => {
      // 真机 14:19:51（拖标签出窗口那一下）：主窗口被 `rebuildLayout` 连做两轮，第一轮的落位链
      // 还在途（DOM 被裁在顶部 0px），第二轮的快照**按 DOM 读** ⇒ 读到 1.00 ⇒ `tab.scrollV` 被
      // 写坏、新建的元素被扶到文档顶部，随后这个 1.00 原样落进会话。
      // 判据：链在途时做第二轮重建，那张标签记下的位置不许塌到顶部。
      // 「快照必须在销毁前读」那条纪律没改 —— 改的是**读谁**：账本（欠着的那个 v）在前，DOM 兜底。
      const first = (await cdp.evalJson(MEASURE)).find((x) => x.editor || x.preview);
      if (!first) return ["SKIP", "一格都量不到"];
      const panelId = first.panelId;
      await cdp.evalJson(`__harness.setMode(${panelId}, "source")`);
      await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
      const want = 20;
      const r = await cdp.evalJson(`__harness.landWhileHidden(${panelId}, ${want})`);
      if (!r) return ["SKIP", "宿主拿不到这一格的滚动面"];
      if (r.concealed !== "hidden")
        return [
          "SKIP",
          `无鉴别力：那一发第 0 帧就落准、重试链根本没起来 ⇒ 此刻台子测不出「链在途时快照读谁」`,
        ];
      const idx = (await cdp.evalJson(MEASURE))
        .find((x) => x.panelId === panelId)
        .tabs.findIndex((t) => t.active);
      // 链正跑着（DOM 还停在被裁到的顶部）—— 立刻再来一轮结构性重建，正是真机那 16ms 内的第二发。
      await cdp.evalJson(`__harness.rebuildLayout()`);
      const stored = await cdp.evalJson(`__harness.scrollVOf(${panelId}, ${idx})`);
      await settle(cdp, { stableRounds: 3, timeoutMs: 4000 });
      if (stored === null) return ["SKIP", "读不到那张标签的记忆值"];
      if (stored < want - 5)
        return [
          "FAIL",
          `链在途时第二轮重建把第 ${idx} 张的 scrollV 记成 ${stored.toFixed(2)}` +
            `（欠的位置是 ${want.toFixed(2)}）⇒ 快照按 DOM 读到了还没落成的投影（B296）`,
        ];
      return [
        "PASS",
        `链在途时第二轮重建仍记 ${stored.toFixed(2)}（欠的位置 ${want.toFixed(2)}，没塌成顶部）`,
      ];
    },
  },
  {
    id: "S32",
    name: "同步关着 ⇒ 每一格各停各的：副本停在源此刻的位置，切回原来那张不跟到副本的位置（B303）",
    async: async ({ cdp }) => {
      // 用户报的「开关关闭时会出现位置同步」在真机日志里的形状是：关着同步，同文档的几格
      // 全落在同一个值上。串位置有三条**借用**路径：恢复时的文档级兜底、重建/切标签时的
      // 接班跟随、落盘补建记录不带 seed（下一次的恢复就只能走兜底）。
      // B303 给跟随加上了开关的闸，副本的位置改由 `duplicateTabToPanel` 显式种 —— 所以这条
      // 判两件事：
      //   1. 关着同步，副本出现那一下仍停在源此刻的位置（靠的是显式种子，不是共享值）；
      //      这一半有鉴别力：摘掉宿主镜像那道种子立刻红（副本停在 1.00）。
      //   2. 把副本往下滚一段再切回原来那一张，它回到**自己**记着的位置，而不是副本那一个。
      //      这一半是 `switchTab` 那道 `currentV` 闸的回归护栏；`sharedVByDoc` 新加的闸只挡
      //      「落位链在途时」那一发（要第二格同文档 + 链正跑着才碰得到），台子此刻造不出那个
      //      形，所以它由 `sync-scroll-sequence` 的序列契约钉，不在这条的判据里。
      //
      // ⚠️ 台子的 setup 自己搭（不走 `preScroll`）：前面那条场景会把视口留在没布局好的格子上，
      // 借它的状态就得到「预置滚动 1.00 ⇒ SKIP」，判据永远跑不到（本轮就是这么空转了一发）。
      const long = Number((await cdp.evalJson(`__harness.docIds()`)).long);
      const onOff = async () => {
        await cdp.evalJson(`__harness.setSyncEnabled("${long}", true)`);
      };
      const docAt = await cdp.evalJson(`__harness.docIdsOfPanels()`);
      let A = -1;
      for (const x of docAt.filter((d) => d.docId === long)) {
        await cdp.evalJson(`__harness.setMode(${x.panelId}, "source")`);
        await settle(cdp, { stableRounds: 2, timeoutMs: 3000 });
        if ((await cdp.evalJson(MEASURE)).find((h) => h.panelId === x.panelId)?.editor) {
          A = x.panelId;
          break;
        }
      }
      if (A < 0) return ["SKIP", "没有一格能把这份文档摆在源码侧"];
      await cdp.evalJson(`__harness.setSyncEnabled("${long}", false)`);
      // 先回顶再向下滚（同 `preScroll` 的纪律：不留「滚不动 ⇒ 谁都没动 ⇒ 恒真」那个形状）
      const at = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === A)?.editor;
      if (!at) {
        await onOff();
        return ["SKIP", "摆在源码侧那一格量不到编辑器"];
      }
      await cdp.click(at.x, at.y);
      await cdp.wheel(at.x, at.y, -20000);
      await settle(cdp, { stableRounds: 3, timeoutMs: 4000 });
      await cdp.wheel(at.x, at.y, 700);
      await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const wantV = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === A)?.editor?.v ?? null;
      if (wantV === null || wantV < 5) {
        await onOff();
        return ["SKIP", `预置滚动不足（${wantV === null ? "量不到" : wantV.toFixed(2)} 行）`];
      }
      const dup = await cdp.evalJson(`__harness.duplicateTab(${A}, 0)`);
      if (typeof dup !== "number" || dup < 0) {
        await onOff();
        return ["SKIP", "同源复制这张标签没建起来"];
      }
      const vOf = async () =>
        (await cdp.evalJson(MEASURE)).find((x) => x.panelId === A)?.editor?.v ?? null;
      // ⚠️ 每一次读数之前都要先 `settle`：滚轮与落位都是跨帧才落定的，读完就判会拿到「还没
      // 动」的那一帧（上一版就是这样：副本停在源的位置、滚那一下却读成没滚 ⇒ 自己报无鉴别力）。
      await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const onCopy = await vOf();
      const snap = (await cdp.evalJson(MEASURE)).find((x) => x.panelId === A);
      if (!snap?.editor || onCopy === null) {
        await onOff();
        return ["SKIP", "复制之后量不到这一格的编辑器"];
      }
      await cdp.click(snap.editor.x, snap.editor.y);
      await cdp.wheel(snap.editor.x, snap.editor.y, 600); // 往下：与顶部（落位坏掉的那个形状）分得开
      await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const onCopy2 = await vOf();
      await cdp.evalJson(`__harness.switchTab(${A}, 0)`); // 切回原来那一张
      await settle(cdp, { stableRounds: 4, timeoutMs: 5000 });
      const onOrigin = await vOf();
      await onOff();
      if (onCopy2 === null || onOrigin === null) return ["SKIP", "滚副本或切回那一下量不到这一格"];
      const problems = [];
      if (Math.abs(onCopy - wantV) > TOL)
        problems.push(
          `副本出现在 ${onCopy.toFixed(2)}，源此刻在 ${wantV.toFixed(2)}` +
            `⇒ 关着同步时没人给它种位置（` +
            `${onCopy < 2 ? "≈顶部：mountView 的跟随已被开关挡下，而 duplicateTabToPanel 那道显式种子没了）" : "不是顶部，那就是种子取错了地方）"}`,
        );
      const gap = Math.abs(onCopy2 - wantV);
      if (gap < 3)
        return [
          "SKIP",
          `无鉴别力：副本只停在 ${onCopy2.toFixed(2)}，与源的 ${wantV.toFixed(2)} 差 ${gap.toFixed(2)} 行` +
            `⇒ 切回原来那张时「跟自己的」与「跟副本的」分不出来`,
        ];
      if (Math.abs(onOrigin - onCopy2) <= TOL)
        problems.push(
          `切回原来那张落到 ${onOrigin.toFixed(2)} = 副本的位置（它自己记的是 ${wantV.toFixed(2)}）` +
            `⇒ 开关关着还在串位置（接班跟随没问开关）`,
        );
      else if (Math.abs(onOrigin - wantV) > TOL)
        problems.push(
          `切回原来那张落在 ${onOrigin.toFixed(2)}，既不是副本的 ${onCopy2.toFixed(2)} 也不是它自己的` +
            ` ${wantV.toFixed(2)}（差 ${(onOrigin - wantV).toFixed(2)} 行）⇒ 落位取到了别处的值`,
        );
      return problems.length
        ? ["FAIL", problems.join("；")]
        : [
            "PASS",
            `副本停在 ${onCopy.toFixed(2)}（源 ${wantV.toFixed(2)}）→ 滚到 ${onCopy2.toFixed(2)} → ` +
              `切回原来那张回自己那份 ${onOrigin.toFixed(2)} ⇒ 关着同步各停各的，副本仍停在源的位置`,
          ];
    },
  },
];
// ───────────────────────────── 装配 ─────────────────────────────

async function pageTarget() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const targets = await res.json();
    return targets.find((t) => t.type === "page" && /harness\.html/.test(t.url)) ?? null;
  } catch {
    return null;
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  buildHarness();
  console.log("已构建真机宿主（真实 CM6 + 真实预览 + 真实协调器接线）");

  const browser = findBrowser();
  const proc = spawn(
    browser,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-features=OverlayScrollbar,OverlayScrollbarFlashAfterAnyScrollUpdate",
      "--force-device-scale-factor=1",
      "--window-size=1440,900",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(OUT, "profile")}`,
      `file:///${path.join(OUT, "harness.html").replace(/\\/g, "/")}`,
    ],
    { stdio: "ignore" },
  );

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    target = await pageTarget();
    if (!target) await delay(250);
  }
  if (!target) {
    proc.kill();
    throw new Error(`CDP ${PORT} 上没有 harness.html 目标（浏览器启动失败？）`);
  }

  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  for (let i = 0; i < 40; i++) {
    const ready = await cdp.evalJson(
      `!!window.__harness && document.querySelectorAll(".cm-line").length > 0`,
    );
    if (ready) break;
    await delay(150);
  }

  const snap = await cdp.evalJson(MEASURE);
  console.log(`实测布局：${fmt(snap)}`);
  if (!pair(snap)) {
    cdp.close();
    proc.kill();
    throw new Error("宿主没同时给出「可见编辑器 + 可见预览」，验证台装配失败。");
  }

  const traced = flag("trace");
  if (traced) {
    await trace(cdp, traced);
    cdp.close();
    proc.kill();
    process.exit(0);
  }

  // `--dump`：把两侧顶边行的原始几何摊开。探针自己的判据必须先可信，否则它给出的
  // 红/绿都不能用来做架构决策（本轮就先因为它数错行号，差点把「对侧没跟」误判成同步缺陷）。
  if (has("dump")) {
    const dump = await cdp.evalJson(`(() => {
      const host = document.querySelector(".panel-host");
      const sc = host.querySelector(".cm-scroller");
      const rect = sc.getBoundingClientRect();
      const lines = [...sc.querySelectorAll(".cm-content > .cm-line")];
      const nums = [...host.querySelectorAll(".cm-lineNumbers .cm-gutterElement")].map((e) => e.textContent.trim());
      return {
        scrollTop: sc.scrollTop,
        clientHeight: sc.clientHeight,
        scrollHeight: sc.scrollHeight,
        renderedLines: lines.length,
        gutterCount: nums.length,
        gutterHead: nums.slice(0, 6),
        lineTopsRelViewport: lines.slice(0, 4).map((el) => +(el.getBoundingClientRect().top - rect.top).toFixed(1)),
        lineHeights: lines.slice(0, 4).map((el) => +el.getBoundingClientRect().height.toFixed(1)),
        contentChildren: [...sc.querySelector(".cm-content").children].map((el) => el.className || el.tagName),
        gutterSiblings: [...host.querySelector(".cm-gutters").children].map((el) => el.className),
      };
    })()`);
    console.log("原始几何：", JSON.stringify(dump, null, 2));
    cdp.close();
    proc.kill();
    process.exit(0);
  }

  console.log(`\n判定容差：${TOL} 源码行。场景：\n`);
  for (const sc of SCENARIOS) {
    if (ONLY && !ONLY.includes(sc.id)) continue;
    try {
      const [status, detail] = await sc.async({ cdp, snap });
      verdict(sc.id, sc.name, status, detail);
    } catch (err) {
      verdict(sc.id, sc.name, "FAIL", `探针执行异常：${err.message}`);
    }
    // 每个场景之间复位到文档顶部，避免上一条留下的位置影响下一条
    try {
      const p = pair(await cdp.evalJson(MEASURE));
      await cdp.evalJson(`__harness.switchTab(${p.editor.panelId}, 0)`);
      await settle(cdp, { stableRounds: 3 });
      await cdp.wheel(p.editor.x, p.editor.y, -20000);
      await settle(cdp, { stableRounds: 3 });
    } catch {
      /* 复位失败不掩盖场景结论 */
    }
  }

  if (!has("keep-open")) {
    cdp.close();
    proc.kill();
  }

  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n真机验证台：${n("PASS")} PASS / ${n("FAIL")} FAIL / ${n("SKIP")} SKIP`);
  if (n("SKIP")) console.log("（SKIP = 该场景的前置条件在真实浏览器里没构造出来，不是通过。）");
  process.exit(n("FAIL") ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n验证台自身失败：${err.message}`);
  process.exit(2);
});
