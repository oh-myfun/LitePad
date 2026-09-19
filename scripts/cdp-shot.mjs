// 用 Chrome DevTools Protocol 直接抓「渲染进程的画面」，替代以前 BitBlt 抓屏幕区域的做法。
//
// 为什么换：旧的 `scripts/screenshot.py` 走的是
//   `SetForegroundWindow(窗口)` → `BitBlt(屏幕 DC, 窗口矩形)`，
// 也就是**对着屏幕那个位置抄一块像素**。于是有三个天生的毛病：
//   ① 鼠标只要停在那块区域里就会被一起拍进去；
//   ② 窗口没抢到前台（焦点窃取防护会让 SetForegroundWindow 静默失败）就拍到别的窗口，
//      表现为「经常失败」；
//   ③ 抓的是屏幕，桌面背景/别的窗口都可能混进来。
// CDP 的 `Page.captureScreenshot` 是让**页面自己**把当前视口合成出来再返回 base64：
// 没有系统光标、没有遮挡窗口、不依赖前台焦点，因此可重复、可脚本化。
//
// 前置：目标进程的 WebView2 必须开了调试端口（见 docs/screenshots/README.md）。
//
// 用法：
//   node scripts/cdp-shot.mjs --out docs/screenshots/main.png
//   node scripts/cdp-shot.mjs --out x.png --size 1600x1000 --settle 1200
//   node scripts/cdp-shot.mjs --out x.png --eval "document.querySelector('.menu-settings').click()"
//   node scripts/cdp-shot.mjs --list          # 只列 CDP 目标，便于排查
//   node scripts/cdp-shot.mjs --out x.png --mode window   # 改窗口外框（见下）
//
// 约定：`--size` 指的是**输出图片的像素尺寸**。默认走视口模拟（Emulation）把它定死，
// 不动系统窗口 —— 实测 WebView2 上改窗口尺寸会让渲染进程崩，详见 prepareViewport()。

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const PORT = Number(opt("--port", "9222"));
const OUT = opt("--out");
const SETTLE = Number(opt("--settle", "900"));
const EVAL = opt("--eval");
const SIZE = opt("--size", "1600x1000");
/** 视口怎么定：emulate（默认，模拟视口）| window（改窗口外框）| none（不动）。 */
const MODE = opt("--mode", "emulate");

if (!OUT && !has("--list")) {
  console.error(
    "用法: node scripts/cdp-shot.mjs --out <输出.png> [--size WxH] [--settle ms] [--eval js]",
  );
  process.exit(2);
}

const EP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等调试端口起来并挑一个「真正的页面」目标（排除 devtools 自身的页面）。 */
async function waitPageTarget(tries = 40) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`${EP}/json/list`)).json();
      const pages = list.filter(
        (t) => t.type === "page" && !String(t.url).startsWith("devtools://"),
      );
      if (pages.length) return pages[0];
      last = `端口通了但没有 page 目标（${list.length} 个目标）`;
    } catch (e) {
      last = e.message;
    }
    await sleep(300);
  }
  throw new Error(
    `${EP} 上没找到页面目标：${last}\n` +
      `→ 目标进程的 WebView2 没开调试端口。见 docs/screenshots/README.md「打开调试端口」。`,
  );
}

const page = await waitPageTarget();
if (has("--list")) {
  const list = await (await fetch(`${EP}/json/list`)).json();
  for (const t of list) console.log(`${t.type}\t${t.title}\t${t.url}`);
  process.exit(0);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
/**
 * ⚠️ 每个请求都要带超时。CDP 的响应丢了不会 reject —— 只会在事件循环耗尽后抛
 * 「Detected unsettled top-level await」，报不出是哪个方法卡住的。实测 WebView2 上
 * `Page.captureScreenshot` 就有卡死（不返回也不报错）的情形，必须自己兜住。
 */
const send = (method, params = {}, ms = 20000) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超过 ${ms}ms 没有响应（CDP 连接是否还活着？）`));
    }, ms);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
let wsClosed = false;
ws.onclose = () => {
  wsClosed = true;
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else resolve(msg.result);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error(`ws 连不上 ${page.webSocketDebuggerUrl}`));
});

await send("Page.enable");
await send("Runtime.enable");

/** ⚠️ evaluate 抛异常时 CDP 不 reject，只在 exceptionDetails 里报 —— 必须显式抛。 */
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `页面里执行失败: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  }
  return r.result?.value;
}

const metrics = () =>
  evalJs(
    "JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,url:location.href})",
  ).then(JSON.parse);

/**
 * 让视口正好是 target（像素）。
 *
 * ⚠️ **默认用 `Emulation.setDeviceMetricsOverride`，不动窗口尺寸**：实测在 WebView2 上调
 * `Browser.setWindowBounds` 会让渲染进程直接崩（CDP 连接随即断开，抓图永远不返回）。
 * 视口模拟是纯渲染侧的事，不碰窗口，稳定得多；代价是图里不含系统标题栏。
 * 想要「带标题栏的真窗口」可以传 `--mode window`（在能跑的机器上），或 `--mode none`
 * 就按当前窗口大小抓。
 */
async function prepareViewport(target, mode) {
  const m0 = await metrics();
  if (mode === "none") return m0;

  if (mode === "window") {
    let windowId;
    try {
      ({ windowId } = await send("Browser.getWindowForTarget", { targetId: page.id }, 5000));
    } catch (e) {
      throw new Error(`--mode window 需要 Browser 域，但取窗口失败：${e.message}`, { cause: e });
    }
    let m = m0;
    let outerW = Math.round(target.w / m.dpr);
    let outerH = Math.round(target.h / m.dpr);
    for (let i = 0; i < 4; i++) {
      await send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 0, top: 0, width: outerW, height: outerH, windowState: "normal" },
      });
      await sleep(350);
      m = await metrics();
      const needW = Math.round(target.w / m.dpr);
      const needH = Math.round(target.h / m.dpr);
      if (m.w === needW && m.h === needH) return m;
      outerW += needW - m.w;
      outerH += needH - m.h;
    }
    return m;
  }

  // mode === "emulate"（默认）
  const dpr = m0.dpr || 1;
  const cssW = Math.max(1, Math.round(target.w / dpr));
  const cssH = Math.max(1, Math.round(target.h / dpr));
  await send("Emulation.setDeviceMetricsOverride", {
    width: cssW,
    height: cssH,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  await sleep(300);
  const m = await metrics();
  console.log(`· 视口模拟：${cssW}×${cssH} CSS px @ ${dpr}x → ${m.w * m.dpr}×${m.h * m.dpr} 像素`);
  return m;
}

const parseSize = (s) => {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) throw new Error(`--size 需要 WxH，收到 ${JSON.stringify(s)}`);
  return { w: Number(m[1]), h: Number(m[2]) };
};

const target = parseSize(SIZE);
const before = await prepareViewport(target, MODE);
await sleep(SETTLE);
if (EVAL) {
  const r = await evalJs(EVAL);
  console.log(`· 页内动作：${r === undefined ? "(无返回)" : String(r)}`);
  await sleep(400);
}

// ⚠️ 抓图本身做两层兜底：WebView2 上 `fromSurface` 偶尔不返回，退到不带该参数的写法。
let shot = null;
const attempts = [
  { format: "png", fromSurface: true },
  { format: "png" },
  { format: "png", captureBeyondViewport: false },
];
let lastErr = null;
for (const opts of attempts) {
  try {
    shot = await send("Page.captureScreenshot", opts, 15000);
    break;
  } catch (e) {
    lastErr = e;
    if (wsClosed) {
      throw new Error(`CDP 连接在抓图时断开（渲染进程没了）：${e.message}`, { cause: e });
    }
  }
}
if (!shot) {
  throw new Error(`Page.captureScreenshot 三次都没成功：${lastErr?.message}`, { cause: lastErr });
}

const buf = Buffer.from(shot.data, "base64");
writeFileSync(OUT, buf);

const after = await metrics();
console.log(`页面      : ${after.url}`);
console.log(`视口      : ${after.w}×${after.h} CSS px @ ${after.dpr}x`);
console.log(`输出      : ${OUT}  ${buf.length} 字节（图片本身 ${target.w}×${target.h}）`);
if (before.w !== after.w || before.h !== after.h)
  console.log("（settle 期间视口变过，已按最终尺寸出图）");
ws.close();
process.exit(0);
