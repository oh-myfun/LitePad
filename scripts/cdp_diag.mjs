// CDP 诊断脚本：连接 WebView2 远程调试端口，捕获页面异常/console，并检查 IPC 环境
// 用法: node scripts/cdp_diag.mjs [--reload]
const CDP = "http://127.0.0.1:9222";
const doReload = process.argv.includes("--reload");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(CDP + "/json/list");
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* port not ready yet */
    }
    await sleep(500);
  }
  throw new Error("no CDP page target found on 9222");
}

const page = await waitPageTarget();
console.log("page target:", page.url, "| title:", JSON.stringify(page.title));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const events = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    const text = d.exception?.description || d.text || "(unknown)";
    events.push(`[EXCEPTION] ${text} @ ${d.url || "?"}:${d.lineNumber}:${d.columnNumber}`);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const args = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    events.push(`[console.${msg.params.type}] ${args}`);
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    events.push(`[log.${e.level}] ${e.text} (${e.url || ""})`);
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error("ws error: " + e.message));
});

await send("Runtime.enable");
await send("Page.enable");

if (doReload) {
  console.log("reloading page to capture boot-time errors...");
  await send("Page.reload");
}

await sleep(5000);

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r?.result?.value ?? JSON.stringify(r);
};

console.log("--- live state ---");
console.log("location      :", await evalJs("location.href"));
console.log("readyState    :", await evalJs("document.readyState"));
console.log("title         :", await evalJs("document.title"));
console.log("hasInternals  :", await evalJs("!!window.__TAURI_INTERNALS__"));
console.log(
  "internalsKeys :",
  await evalJs(
    'window.__TAURI_INTERNALS__ ? Object.keys(window.__TAURI_INTERNALS__).join(",") : "none"',
  ),
);
console.log(
  "hasInvoke     :",
  await evalJs("!!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)"),
);
console.log(
  "body head     :",
  await evalJs('document.body ? document.body.innerHTML.slice(0, 200) : "NO BODY"'),
);

console.log("--- captured events (since connect) ---");
if (events.length) for (const e of events) console.log(e);
else console.log("(none)");

console.log("--- manual invoke test ---");
console.log(
  await evalJs(
    `(async () => {
      try {
        const r = await window.__TAURI_INTERNALS__.invoke("list_encodings");
        return "INVOKE OK: " + JSON.stringify(r).slice(0, 200);
      } catch (e) {
        return "INVOKE FAIL: " + (e && e.message ? e.message : String(e));
      }
    })()`,
  ),
);

ws.close();
process.exit(0);
