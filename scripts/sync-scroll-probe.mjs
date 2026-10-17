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
    await cdp.evalJson(`__harness.rerenderPreview(${previewPanelId})`);
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
