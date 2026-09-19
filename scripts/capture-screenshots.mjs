// 一键重拍 README / docs 引用的界面截图（`docs/screenshots/*.png`）。
//
// 为什么要有它：这几张图以前是「手工构状态 → 手点菜单 → 跑截图脚本」三步拼出来的，
// 中间任何一步忘了就拍到错状态；而且旧脚本靠 BitBlt 抓屏幕，会连鼠标和桌面一起拍进去。
// 现在把「演示会话 → 启动 → 开对话框 → 抓图 → 收尾」整条链子固化成一份可重复的配方：
// 状态写进临时目录的 session.json/settings.json，抓图走 CDP（见 scripts/cdp-shot.mjs），
// 全程不碰真实会话，拍完原样还原。
//
// 用法：
//   node scripts/capture-screenshots.mjs             # 拍全部四张
//   node scripts/capture-screenshots.mjs main keymap # 只拍指定几张
//   node scripts/capture-screenshots.mjs --size 1440x900
//   node scripts/capture-screenshots.mjs --keep      # 保留演示会话不还原（排查用）
//
// ⚠️ 会**重启 LitePad**（先杀再起），并把 WebView2 的用户数据目录挪走一份——
// 原因见 docs/screenshots/README.md「为什么每次都要清 WebView2 用户数据」。

import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = join(ROOT, "docs/screenshots");
const TMP = join(ROOT, ".tmp");

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const SIZE = flag("--size", "1600x1000");
const PORT = flag("--port", "9222");
const VIEWPORT_MODE = flag("--mode", "emulate");
const EXE = flag("--exe", join(ROOT, "src-tauri/target/release/litepad.exe"));
const KEEP = args.includes("--keep");
const CONSUMED = new Set([SIZE, PORT, VIEWPORT_MODE, EXE]);
const WANTED = args.filter((a) => !a.startsWith("--") && !CONSUMED.has(a));

const APPDATA = process.env.APPDATA;
const CFG_DIR = join(APPDATA, "LitePad");
const SESSION = join(CFG_DIR, "session.json");
const SETTINGS = join(CFG_DIR, "settings.json");
const BACKUP = join(TMP, "screenshot-backup");
// WebView2 的 profile 目录（Tauri 按 identifier 命名）
const WEBVIEW_UDD = join(process.env.LOCALAPPDATA, "com.litepad.app", "EBWebView");
// 演示会话里引用的文件都必须真实存在，否则会话恢复会开出一个错误标签
const md = join(ROOT, "docs/example.md");
const ts = join(ROOT, "src/shell/findbar.ts");
const ts2 = join(ROOT, "src/shell/codicons.ts");
const json = join(ROOT, "src-tauri/tauri.conf.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** 单个标签的会话条目（字段名与 src/ipc/api.ts 的 TabSession 一致，camelCase）。 */
const tab = (path, viewMode = "source", cursorLine = 1, docId = 1) => ({
  path,
  encoding: "UTF-8",
  eol: "LF",
  cursorLine,
  cursorCol: 1,
  viewMode,
  backupId: null,
  docId,
});

/** 左右分屏：同一个 md 文件，左源码右预览。 */
const splitSession = (leftTabs, rightTab, activeLeft = 0) => ({
  panels: [
    { tabs: leftTabs, active: activeLeft },
    { tabs: [rightTab], active: 0 },
  ],
  layout: {
    kind: "split",
    dir: "h",
    ratio: 0.5,
    a: { kind: "leaf", panelId: 0 },
    b: { kind: "leaf", panelId: 1 },
  },
  activePanel: 0,
});

const singleSession = (tabs, active = 0) => ({
  panels: [{ tabs, active }],
  layout: { kind: "leaf", panelId: 0 },
  activePanel: 0,
});

/** 打开「设置 → 首选项…/快捷键…」的页内脚本。菜单是自绘 DOM，直接点最稳。 */
const openSettingsMenu = (label) => `(() => {
  const bar = document.getElementById("menu-bar");
  const btn = [...bar.querySelectorAll(".menu-btn")].find((b) => b.textContent.trim().startsWith("设置"));
  if (!btn) throw new Error("菜单栏里没找到「设置」");
  btn.click();
  const items = [...document.querySelectorAll(".popup-menu button")];
  const it = items.find((e) => e.textContent.replace(/\\s+/g, "").startsWith(${JSON.stringify(label)}));
  if (!it) throw new Error("菜单里没找到「" + ${JSON.stringify(label)} + "」: " + items.map((e) => e.textContent.trim()).join(" | "));
  it.click();
  return "clicked " + ${JSON.stringify(label)};
})()`;

const RECIPES = [
  {
    name: "main",
    what: "主界面：左右分屏，左源码右预览（深色）",
    theme: "dark",
    session: () =>
      splitSession(
        [tab(md, "source", 8, 1), tab(ts, "source", 40, 2), tab(json, "source", 12, 3)],
        tab(md, "preview", 1, 4),
      ),
  },
  {
    name: "code-light",
    what: "浅色主题的代码视图：多标签 + TS 高亮 + 折叠",
    theme: "light",
    session: () =>
      singleSession(
        [tab(ts, "source", 60, 1), tab(ts2, "source", 30, 2), tab(json, "source", 8, 3)],
        0,
      ),
  },
  {
    name: "preferences",
    what: "设置 → 首选项 弹窗",
    theme: "dark",
    session: () => singleSession([tab(md, "source", 8, 1)]),
    eval: openSettingsMenu("首选项"),
    settle: 900,
  },
  {
    name: "keymap",
    what: "设置 → 快捷键 面板",
    theme: "dark",
    session: () => singleSession([tab(md, "source", 8, 1)]),
    eval: openSettingsMenu("快捷键"),
    settle: 900,
  },
];

const recipes = WANTED.length ? RECIPES.filter((r) => WANTED.includes(r.name)) : RECIPES;
if (!recipes.length) {
  console.error(`没有匹配的配方。可选：${RECIPES.map((r) => r.name).join(" / ")}`);
  process.exit(2);
}
if (!existsSync(EXE)) {
  console.error(
    `找不到可执行文件：${EXE}\n先跑一次 npm run tauri -- build（见 docs/screenshots/README.md）`,
  );
  process.exit(2);
}

const alive = () => {
  try {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq litepad.exe", "/FO", "CSV"], {
      encoding: "utf8",
    }).includes("litepad.exe");
  } catch {
    return false;
  }
};

/** 杀干净（含 WebView2 子进程），必要时升级为强杀。 */
async function stopApp() {
  if (!alive()) return;
  try {
    execFileSync("taskkill", ["/IM", "litepad.exe"], { stdio: "ignore" });
  } catch {
    /* 已经没了 */
  }
  for (let i = 0; i < 16 && alive(); i++) await sleep(250);
  if (alive()) {
    try {
      execFileSync("taskkill", ["/F", "/IM", "litepad.exe", "/T"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 16 && alive(); i++) await sleep(250);
  }
  await sleep(400);
}

/** 把 WebView2 用户数据挪走（保留一份，便于对照）；残留会让新实例起不来。 */
function clearWebViewProfile() {
  if (!existsSync(WEBVIEW_UDD)) return;
  const stash = `${WEBVIEW_UDD}.shotbak`;
  try {
    if (existsSync(stash)) rmSync(stash, { recursive: true, force: true });
    renameSync(WEBVIEW_UDD, stash);
    log("  · 已移开 WebView2 用户数据（残留会让新 webview 起不来）");
  } catch (e) {
    log(
      `  ! WebView2 用户数据没移开（${e.code}）——若启动白屏，先手动关掉所有 LitePad/WebView2 进程`,
    );
  }
}

/** 起 app，等 CDP 端口就绪。 */
async function startApp() {
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu --remote-debugging-port=${PORT}`,
  };
  const child = spawn(EXE, [], { env, stdio: "ignore", detached: false });
  child.on("error", (e) => log("  ! 启动失败: " + e.message));
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (list.some((t) => t.type === "page")) return child;
    } catch {
      /* 端口还没起 */
    }
    await sleep(300);
  }
  throw new Error(`起了 15s 还没等到 CDP 端口 ${PORT}，多半是 webview 没起来`);
}

function backupConfig() {
  mkdirSync(BACKUP, { recursive: true });
  for (const f of [SESSION, SETTINGS]) {
    const dst = join(BACKUP, f === SESSION ? "session.json" : "settings.json");
    if (existsSync(f)) copyFileSync(f, dst);
    else if (existsSync(dst)) rmSync(dst); // 记录「原本就没有」
  }
}

function restoreConfig() {
  for (const f of [SESSION, SETTINGS]) {
    const src = join(BACKUP, f === SESSION ? "session.json" : "settings.json");
    if (existsSync(src)) copyFileSync(src, f);
    else if (existsSync(f)) rmSync(f);
  }
}

function writeDemoConfig(recipe) {
  mkdirSync(CFG_DIR, { recursive: true });
  // 以真实设置打底（字号/字体/行高等保持用户环境一致），只覆盖主题
  let base = {};
  const realSettings = join(BACKUP, "settings.json");
  if (existsSync(realSettings)) {
    try {
      base = JSON.parse(readFileSync(realSettings, "utf8"));
    } catch {
      base = {};
    }
  }
  const settings = { ...base, theme: recipe.theme };
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), "utf8");
  writeFileSync(SESSION, JSON.stringify(recipe.session(), null, 2), "utf8");
}

async function shoot(recipe) {
  const out = join(OUT_DIR, `${recipe.name}.png`);
  const cmd = [
    join(HERE, "cdp-shot.mjs"),
    "--port",
    PORT,
    "--out",
    out,
    "--size",
    SIZE,
    "--settle",
    String(recipe.settle ?? 1200),
    "--mode",
    VIEWPORT_MODE,
  ];
  if (recipe.eval) cmd.push("--eval", recipe.eval);
  const r = execFileSync(process.execPath, cmd, { encoding: "utf8", cwd: ROOT });
  for (const line of r.trim().split(/\r?\n/)) log("  " + line);
  return out;
}

log(`配方：${recipes.map((r) => r.name).join(", ")}  尺寸 ${SIZE}`);
backupConfig();
let failed = 0;
try {
  for (const recipe of recipes) {
    log(`\n【${recipe.name}】${recipe.what}`);
    await stopApp();
    clearWebViewProfile();
    writeDemoConfig(recipe);
    await startApp();
    try {
      const out = await shoot(recipe);
      log(`  ✓ ${out}`);
    } catch (e) {
      failed++;
      log(`  ✗ ${recipe.name}: ${e.message.split("\n")[0]}`);
      if (e.stderr) log(String(e.stderr).trim().split("\n").slice(-3).join("\n"));
    }
  }
} finally {
  await stopApp();
  if (!KEEP) {
    restoreConfig();
    log("\n已还原真实 session.json / settings.json");
  } else {
    log("\n--keep：保留演示会话，真实会话仍在 " + BACKUP);
  }
}
log(failed ? `\n有 ${failed} 张没拍成。` : "\n全部拍完。");
process.exit(failed ? 1 : 0);
