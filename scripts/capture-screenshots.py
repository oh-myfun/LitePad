"""
一键补拍 `docs/screenshots/` 里的界面截图（唯一入口）。

以前这里有两套流程：`capture-screenshots.mjs`（走 CDP 调试端口）+ `screenshot.py`
（BitBlt 抓屏），前者在**开不出调试端口的环境**里会「启动了但一直没内容」，两套还各有一半
逻辑，容易用错。现在只留这一套：**BitBlt 抓真实窗口 + 可见外框裁剪**，启动/摆状态/抓图/
还原都在同一个进程里跑完（本机实测：spawn 出来的 GUI 进程活不过一次工具调用，
所以「起 → 抓 → 杀」必须一口气做完）。

它做四件事：
  1. 备份真实 `session.json` / `settings.json`，写一份演示会话（拍完原样还原）；
  2. 清 WebView2 用户数据（硬杀留下的残留会让新 webview 起不来，表现是整窗全黑）；
  3. 起 app，**等窗口标题带上演示文件名**再抓（标题还是裸 `LitePad` 说明会话没恢复，
     这时候抓到的就是全黑图）；抓前把系统光标挪到窗口外、用 AttachThreadInput 抢前台；
  4. 空白自检（PNG 压得太小 → 报错而不是把白图写进 docs/）。

用法：
  python scripts/capture-screenshots.py                 # 拍 main
  python scripts/capture-screenshots.py --list          # 看有哪些配方
  python scripts/capture-screenshots.py --size 1440x900
  python scripts/capture-screenshots.py --keep          # 保留演示会话（排查用）
  python scripts/capture-screenshots.py --inset 1       # 圆角混进桌面时四边各切 1px

依赖：`scripts/screenshot.py`（只提供 PNG 编码、窗口查找、BitBlt 抓图这些底层件）。
"""

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import screenshot as sc  # noqa: E402

# ⚠️ 演示会话一律写在**项目内** `SHOT_DIR/config`，靠 `LITEPAD_CONFIG_DIR` 告诉应用。
#    以前这里直接指向真实的 `%APPDATA%\LitePad`，于是脚本得「备份真实配置 → 覆盖成演示 →
#    拍完还原」：每轮两次文件往返、含两处 `os.remove`，而且**进程被硬杀时 `finally` 兜不住**，
#    真实会话会停在演示状态。现在真实配置**一次都不写**，只读一份设置当底稿（字号/字体
#    与用户保持一致，那不产生任何修改）。热退出副本也跟着走（见 `backup::backup_root`）。
SHOT_DIR = os.path.join(ROOT, ".tmp", "shot")
CFG_DIR = os.path.join(SHOT_DIR, "config")
os.environ["LITEPAD_CONFIG_DIR"] = CFG_DIR  # 子进程（exe）继承这份环境
REAL_CFG_DIR = os.path.join(os.environ["APPDATA"], "LitePad")
REAL_SETTINGS = os.path.join(REAL_CFG_DIR, "settings.json")
SESSION = os.path.join(CFG_DIR, "session.json")
SETTINGS = os.path.join(CFG_DIR, "settings.json")
OUT_DIR = os.path.join(ROOT, "docs", "screenshots")
EXE = os.path.join(ROOT, "src-tauri", "target", "release", "litepad.exe")
# 仍指向用户目录，但**只在首轮抓图失败时才移开**（见 `capture_recipe` 的重试分支），
# 不再每轮无条件清 —— 那一清就是删掉上一轮 stash 的 326 个文件。
WEBVIEW_UDD = os.path.join(os.environ["LOCALAPPDATA"], "com.litepad.app", "EBWebView")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# 演示会话里引用的文件必须真实存在，否则会话恢复会开出一个错误标签
MD = os.path.join(ROOT, "test-data", "完整样例.md")
TS = os.path.join(ROOT, "src", "shell", "findbar.ts")
JSONFILE = os.path.join(ROOT, "src-tauri", "tauri.conf.json")

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def say(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 配方

def tab(path, view="source", line=1, doc_id=1):
    """单个标签（字段名与 src/ipc/api.ts 的 TabSession 一致，camelCase）。"""
    return {
        "path": path, "encoding": "UTF-8", "eol": "LF",
        "cursorLine": line, "cursorCol": 1, "viewMode": view,
        "backupId": None, "docId": doc_id,
    }


def split_session(left_tabs, right_tab):
    """左右分屏：左源码（多标签）右预览。"""
    return {
        "panels": [{"tabs": left_tabs, "active": 0}, {"tabs": [right_tab], "active": 0}],
        "layout": {"kind": "split", "dir": "h", "ratio": 0.5,
                   "a": {"kind": "leaf", "panelId": 0}, "b": {"kind": "leaf", "panelId": 1}},
        "activePanel": 0,
    }


def single_session(tabs, active=0):
    return {"panels": [{"tabs": tabs, "active": active}],
            "layout": {"kind": "leaf", "panelId": 0}, "activePanel": 0}


def diff_tab(path, left_path, line=1, doc_id=1):
    """B 档差异标签：右栏 `path`，左栏 `left_path`（字段见 `src/ipc/api.ts` 的 TabSession）。

    `kind` 必须是显式 `"diff"`：会话恢复只认这一个值，缺键会被当成普通编辑器标签
    （`diff/model.ts:diffKindOf` 的三态口径）。
    """
    return dict(tab(path, "source", line, doc_id), kind="diff", diffLeftPath=left_path)


# 差异配方的演示文件：写进项目内 `.tmp/shot/demo`，每次重拍都重建 —— 内容即真相，
# 不依赖仓库里某个恰好「改过几行」的文件。左边 before.ts、右边 after.ts，四类块都齐：
#   改行（两侧同色）、纯插入（左栏斜纹）、纯删除（右栏斜纹）、函数整体替换。
DEMO_DIR = os.path.join(SHOT_DIR, "demo")
DIFF_BEFORE = os.path.join(DEMO_DIR, "before.ts")
DIFF_AFTER = os.path.join(DEMO_DIR, "after.ts")
DIFF_BEFORE_TEXT = "\n".join([
    'import { readFile } from "fs/promises";',
    'import { join } from "path";',
    "",
    "export interface Options {",
    "  root: string;",
    "  encoding: string;",
    "  maxLines: number;",
    "  verbose: boolean;",
    "}",
    "",
    "export function defaults(): Options {",
    "  return {",
    "    root: cwd(),",
    '    encoding: "utf-8",',
    "    maxLines: 5000,",
    "    verbose: false,",
    "  };",
    "}",
    "",
    "export function clamp(text, max) {",
    r'  return text.split("\n").slice(0, max);',
    "}",
    "",
    "export async function readText(path) {",
    "  const buf = await readFile(join(root, path));",
    '  return buf.toString("utf-8");',
    "}",
    "",
    "export function isLarge(text) {",
    r'  return text.split("\n").length > 5000;',
    "}",
])
DIFF_AFTER_TEXT = "\n".join([
    'import { readFile } from "fs/promises";',
    'import { basename, join } from "path";',
    "",
    "export interface Options {",
    "  root: string;",
    "  encoding: string;",
    '  theme: "light" | "dark";',
    "  strict: boolean;",
    "  verbose: boolean;",
    "}",
    "",
    "export function defaults(): Options {",
    "  return {",
    "    root: cwd(),",
    '    encoding: "utf-8",',
    '    theme: "dark",',
    "    strict: true,",
    "    verbose: false,",
    "  };",
    "}",
    "",
    "export async function readText(path) {",
    "  try {",
    "    const buf = await readFile(join(root, path));",
    '    return buf.toString("utf-8");',
    "  } catch (err) {",
    '    throw new Error(`读不到 ${basename(path)}`);',
    "  }",
    "}",
    "",
    "export function sizeOf(text) {",
    "  return new TextEncoder().encode(text).length;",
    "}",
])


# HTML 预览配方的演示文件：同样写进项目内 `.tmp/shot/demo`（每次重建）。
# 页面故意外链 `preview.css` / `logo.svg` / `preview.js` —— 截图要能证明 iframe 的 `<base>`
# 指到了文档目录（否则相对资源全丢、脚本也不跑，页面只剩裸文本）。
HTML_PREVIEW = os.path.join(DEMO_DIR, "preview.html")
HTML_PREVIEW_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LitePad · HTML 预览</title>
  <link rel="stylesheet" href="preview.css">
</head>
<body>
  <header class="hero">
    <img class="logo" src="logo.svg" alt="LitePad">
    <div>
      <p class="eyebrow">LitePad</p>
      <h1>HTML 源码 / 预览</h1>
      <p class="lede">预览是沙箱 iframe：网页按自己的样式渲染，相对样式 / 图片 / 脚本照常加载。</p>
    </div>
  </header>
  <main>
    <section class="cards">
      <article>
        <h2>源码档</h2>
        <p>CodeMirror 6 编辑，语法按需高亮。</p>
      </article>
      <article>
        <h2>预览档</h2>
        <p>浏览器排版引擎出图，不改写页面 CSS。</p>
      </article>
      <article>
        <h2>切换</h2>
        <p><kbd>Ctrl</kbd> + <kbd>/</kbd> 或标题区预览键。</p>
      </article>
    </section>
    <section class="note">
      <h2>安全边界</h2>
      <p>页面脚本在沙箱里运行，拿不到宿主与 Tauri IPC；链接由宿主接管。</p>
      <p id="script-state">外部脚本尚未运行</p>
    </section>
  </main>
  <footer>这是 <code>preview.html</code> 的真实渲染结果</footer>
  <script src="preview.js"></script>
</body>
</html>
"""
HTML_PREVIEW_JS = """// 截图要证明的是「相对 JS 被加载并执行」，所以这里只改一处可见文案。
document.getElementById("script-state").textContent = "外部脚本 preview.js 已加载并执行";
"""
HTML_PREVIEW_CSS = """* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh;
  padding: 24px 28px 18px;
  font: 14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #1f2937;
  background:
    radial-gradient(900px 420px at 12% -10%, #dbeafe 0%, transparent 62%),
    radial-gradient(700px 360px at 96% 0%, #fae8ff 0%, transparent 58%),
    #f8fafc;
}
.hero { display: flex; gap: 16px; align-items: center; margin-bottom: 20px; }
.logo { width: 54px; height: 54px; flex: none; filter: drop-shadow(0 10px 18px rgba(37, 99, 235, .28)); }
.eyebrow { margin: 0 0 2px; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #2563eb; }
h1 { margin: 0; font-size: 27px; line-height: 1.2; letter-spacing: -.02em; }
.lede { margin: 6px 0 0; max-width: 640px; color: #4b5563; }
.cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.cards article {
  padding: 14px 14px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: rgba(255, 255, 255, .82);
  box-shadow: 0 12px 30px -22px rgba(15, 23, 42, .45);
}
.cards h2, .note h2 { margin: 0 0 6px; font-size: 14px; color: #0f172a; }
.cards p, .note p { margin: 0; color: #52606d; font-size: 12.5px; }
.note {
  margin-top: 12px;
  padding: 12px 14px;
  border-left: 4px solid #7c3aed;
  border-radius: 0 12px 12px 0;
  background: rgba(124, 58, 237, .07);
}
.note h2 { color: #6d28d9; }
#script-state { margin-top: 6px; font-weight: 600; color: #047857; }
kbd {
  padding: 1px 6px;
  border: 1px solid #cbd5e1;
  border-bottom-width: 2px;
  border-radius: 6px;
  background: #fff;
  font: 600 12px/1.5 "Segoe UI", sans-serif;
  color: #334155;
}
footer { margin-top: 24px; color: #94a3b8; font-size: 12.5px; }
code { padding: 1px 5px; border-radius: 5px; background: #eef2ff; color: #4338ca; }
"""
HTML_PREVIEW_LOGO = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#38bdf8"/>
      <stop offset=".55" stop-color="#2563eb"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#g)"/>
  <path d="M20 43V21h7v15.5h11V43H20z" fill="#fff"/>
  <circle cx="44" cy="24" r="5" fill="#fff" opacity=".9"/>
</svg>
"""


# 根 README 开头只放 main.png；差异编辑器那张 diff.png 归 `docs/screenshots/README.md`
# 的表格，两处都要提到（改配方就同步改那份 README 的复现命令）。
# 要补拍「设置」里的弹窗，加一条 recipe 并用 clicks 摆状态即可，例如：
#
#   {
#     "name": "preferences", "what": "设置 → 首选项…", "theme": "dark",
#     "session": lambda: single_session([tab(MD, "source", 8, 1)]),
#     # 菜单栏按钮（1600x1000 窗口、150% 缩放实测，窗口贴着 (0,0)，故坐标即屏幕坐标）：
#     #   文件 0-75 / 编辑 76-151 / 查看 152-227 / 设置 228-304 / 帮助 305-380
#     "clicks": [(266, 67), (266, 121)],   # 设置 → 首选项…
#   }
#
# 弹窗的第二项「快捷键…」在同一列的 y≈164。注意：Alt 助记符在本机收不到合成键
# （键盘事件到不了 WebView2），所以用点击；按钮位置变了就用 --shot-each 重测。
RECIPES = [
    {
        "name": "main",
        "what": "主界面：左右分屏，左源码（多标签）右预览（深色）",
        "theme": "dark",
        "session": lambda: split_session(
            [tab(MD, "source", 8, 1), tab(TS, "source", 40, 2), tab(JSONFILE, "source", 12, 3)],
            tab(MD, "preview", 1, 4),
        ),
    },
    {
        "name": "diff",
        "what": "差异编辑器：before.ts ↔ after.ts（删/增行、对侧斜纹、中间回退键、右缘概览）",
        "theme": "dark",
        "files": {"before.ts": DIFF_BEFORE_TEXT, "after.ts": DIFF_AFTER_TEXT},
        # 光标落在第一处改动（第 2 行）：中间那一列的「回退此块」键靠 `.is-current` 常显，
        # 截图才拍得到它；停在未改动的第 1 行时那一列按 VS Code 的口径是空的（只有悬停才现形）。
        # 两侧文件都开成普通标签再挂差异：B 档左栏现在也是**文档本身**（两侧都能编辑），
        # 只放一张差异记录的话还原出来是旧会话那条只读快照，拍到的就不是真实用法。
        "session": lambda: single_session(
            [tab(DIFF_BEFORE, "source", 1, 1), tab(DIFF_AFTER, "source", 2, 2),
             diff_tab(DIFF_AFTER, DIFF_BEFORE, 2, 2)],
            active=2,
        ),
    },
    {
        "name": "html",
        "what": "HTML 源码 / 预览：左侧源码、右侧沙箱 iframe 渲染（相对样式 / 图片 / 脚本照常加载）",
        "theme": "dark",
        # 相对资源还要经 asset 协议再取一轮（CSS / 图片 / 脚本），冷 profile 下默认 3 秒不够。
        "settle": 8,
        # 演示文件写进 `.tmp/shot/demo`：`preview.html` 外链同目录的 `preview.css`、
        # `logo.svg` 与 `preview.js`，截图也就顺带验证了 iframe 的 `<base>` 真的指到了文档目录。
        "files": {
            "preview.html": HTML_PREVIEW_HTML,
            "preview.css": HTML_PREVIEW_CSS,
            "preview.js": HTML_PREVIEW_JS,
            "logo.svg": HTML_PREVIEW_LOGO,
        },
        "session": lambda: {**split_session([tab(HTML_PREVIEW, "source", 6, 1)],
                                            tab(HTML_PREVIEW, "preview", 1, 2)),
                            "activePanel": 1},
    },
]


def active_basename(recipe):
    """活动标签的文件名——窗口标题恢复成 `LitePad - <文件名>` 才算 webview 真加载了。"""
    s = recipe["session"]()
    panel = s["panels"][s.get("activePanel", 0)]
    t = panel["tabs"][panel.get("active", 0)]
    return os.path.basename(t["path"])


# ---------------------------------------------------------------- 进程 / 配置

def pids_alive(exe="litepad.exe"):
    return sc.pids_by_exe(exe)


def litepad_webview_pids():
    """只挑 LitePad 自己的 WebView2 进程（命令行里带 `com.litepad.app`）。

    ⚠️ 不能像以前那样 `taskkill /IM msedgewebview2.exe /T` 一刀切：本机上同时有
    Windows 搜索、小组件、PowerToys Peek 的 WebView2 在跑，那一刀等于替用户关掉
    别的应用。孤儿进程（litepad 已经被硬杀）认不出父进程，但都带着自己的
    `--user-data-dir=...\\com.litepad.app\\EBWebView`，按这个挑最稳。
    """
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
             "Where-Object { $_.CommandLine -like '*com.litepad.app*' } | "
             "Select-Object -ExpandProperty ProcessId"],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception:
        return []
    return sorted({int(x) for x in out.split() if x.strip().isdigit()})


def stop_app():
    """先温和再强杀；连带清掉**属于 LitePad 的** WebView2 孤儿进程（它们会占住用户数据目录）。"""
    if pids_alive():
        subprocess.run(["taskkill", "/IM", "litepad.exe", "/T"], capture_output=True)
        for _ in range(12):
            if not pids_alive():
                break
            time.sleep(0.25)
        if pids_alive():
            subprocess.run(["taskkill", "/F", "/IM", "litepad.exe", "/T"], capture_output=True)
    for pid in litepad_webview_pids():
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
    for _ in range(20):
        if not pids_alive():
            break
        time.sleep(0.2)
    time.sleep(0.4)


def clear_webview_profile():
    """把 WebView2 用户数据挪走：硬杀留下的残留会让新 webview 起不来（白窗）。"""
    if not os.path.isdir(WEBVIEW_UDD):
        return
    stash = WEBVIEW_UDD + ".shotbak"
    try:
        if os.path.isdir(stash):
            shutil.rmtree(stash, ignore_errors=True)
        os.rename(WEBVIEW_UDD, stash)
        say("  · 已移开 WebView2 用户数据（残留会让新 webview 起不来）")
    except Exception as e:
        say("  ! WebView2 用户数据没移开: %s" % e)


def write_demo_config(recipe):
    r"""把演示会话写进**隔离**配置目录；设置以真实设置打底（**只读**），只覆盖主题。

    隔离靠 `LITEPAD_CONFIG_DIR`（见文件头常量）：应用会把 settings / session /
    热退出副本全部写到 `.tmp/shot/config`，真实 `%APPDATA%\LitePad` **一次都不会被写**。
    真实设置只是读来当底稿（字号/字体与用户一致），不产生任何修改。
    """
    os.makedirs(CFG_DIR, exist_ok=True)
    base = {}
    if os.path.exists(REAL_SETTINGS):
        try:
            with open(REAL_SETTINGS, encoding="utf-8") as f:
                base = json.load(f)
        except Exception:
            base = {}
    base["theme"] = recipe["theme"]
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, indent=2)
    with open(SESSION, "w", encoding="utf-8") as f:
        json.dump(recipe["session"](), f, ensure_ascii=False, indent=2)
    # 配方自带的演示文件（差异格要一对真实文件）：每次重写，内容以脚本里的常量为准。
    files = recipe.get("files") or {}
    if files:
        os.makedirs(DEMO_DIR, exist_ok=True)
        for name, text in files.items():
            with open(os.path.join(DEMO_DIR, name), "w", encoding="utf-8", newline="\n") as f:
                f.write(text)


# ---------------------------------------------------------------- 窗口操作

def force_foreground(hwnd):
    """抢前台：把当前前台窗口所在线程的输入队列挂过来再 Set，绕过焦点窃取防护。"""
    fg = user32.GetForegroundWindow()
    cur = kernel32.GetCurrentThreadId()
    tgt = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = False
    if tgt and tgt != cur:
        attached = bool(user32.AttachThreadInput(cur, tgt, True))
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.SetFocus(hwnd)
    if attached:
        user32.AttachThreadInput(cur, tgt, False)


def park_cursor(rect):
    """把光标挪到窗口矩形之外，返回原位置。"""
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    saved = (pt.x, pt.y)
    user32.SetCursorPos(user32.GetSystemMetrics(0) - 2, user32.GetSystemMetrics(1) - 2)
    return saved


def click(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.18)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.45)


def wait_window(exe, want_title, timeout):
    """等窗口出现且标题带上演示文件名（后者 = webview 真加载了内容）。"""
    deadline = time.time() + timeout
    last = None
    t0 = time.time()
    while time.time() < deadline:
        pids = set(sc.pids_by_exe(exe))
        if pids:
            hwnd, title = sc.find_window("", pids)
            if hwnd:
                r = sc.visible_rect(hwnd)
                if r.right > r.left and r.bottom > r.top and want_title in title:
                    return hwnd, title
                if title != last:
                    say("  [%5.1fs] 窗口标题 %r" % (time.time() - t0, title))
                    last = title
        elif time.time() - t0 > 3:
            say("  [%5.1fs] %s 已退出" % (time.time() - t0, exe))
            return None, None
        time.sleep(0.5)
    if last is not None:
        say("!! 标题一直是 %r，没等到含 %r —— 会话可能没恢复" % (last, want_title))
    return None, None


# ---------------------------------------------------------------- 抓图

def shoot(recipe, size, settle, inset, shot_each=None):
    w, h = size
    say("  起 app ...")
    proc = subprocess.Popen([EXE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        hwnd, title = wait_window("litepad.exe", active_basename(recipe), 40)
        if not hwnd:
            return None
        say("  窗口: %r" % title)
        sc.resize_window(hwnd, w, h)  # 可见外框 = (0,0)-(w,h)，于是窗口坐标 = 屏幕坐标
        time.sleep(settle)
        rect = sc.visible_rect(hwnd)
        say("  可见外框 (%d,%d)-(%d,%d)" % (rect.left, rect.top, rect.right, rect.bottom))
        saved = park_cursor(rect)
        force_foreground(hwnd)
        time.sleep(1.0)
        if user32.GetForegroundWindow() != hwnd:
            say("  ! 没抢到前台——可能被别的窗口压着，成品请人工确认")
        try:
            for i, (cx, cy) in enumerate(recipe.get("clicks", []), 1):
                say("  点击 #%d (%d,%d)" % (i, cx, cy))
                click(cx, cy)
                if shot_each:
                    park_cursor(rect)
                    png_i, dim_i = sc.capture(hwnd, inset)
                    p = shot_each % i
                    open(p, "wb").write(png_i)
                    say("    中间图 -> %s %dx%d" % (p, dim_i[0], dim_i[1]))
            if recipe.get("clicks"):
                time.sleep(0.8)
                park_cursor(rect)  # 点击后光标在窗口里，抓图前再挪出去
            png, dim = sc.capture(hwnd, inset)
        finally:
            user32.SetCursorPos(*saved)
    finally:
        proc.terminate()
    return png, dim


def capture_recipe(recipe, size, settle, inset, shot_each):
    """抓一张；**只有首轮没拿到内容时**才移开 WebView2 用户数据再试一次。

    ⚠️ 为什么改成「按需」：以前无条件调 `clear_webview_profile()`，而它第一件事就是
    `rmtree` 上一轮的 stash —— 实测 326 个文件，而且发生在**用户目录**
    `%LOCALAPPDATA%` 里，每刷一次截图就删一遍。真正需要移开 profile 的只有
    「硬杀留下的残留让新 webview 起不来」这一种情况，正常路径根本用不到。
    """
    settle = recipe.get("settle", settle)
    for attempt in (1, 2):
        # 顺序要紧：先杀干净再写演示配置——否则退出中的旧实例会把自己的会话写回来，
        # 把演示配置覆盖掉（表现就是新实例「启动了但一直没内容」）。
        stop_app()
        write_demo_config(recipe)
        got = shoot(recipe, size, settle, inset, shot_each)
        if got:
            png, dim = got
            # 空白自检：webview 没渲染内容时整片同色，PNG 会被压得极小。
            # 实测 1600x1000 全黑图 ~18KB（0.011 字节/像素），正常界面 ~200KB（0.13）。
            ratio = len(png) / (dim[0] * dim[1])
            if ratio >= 0.04:
                return png, dim
            say("  ✗ 疑似空白图（%d 字节 / %dx%d，%.3f 字节每像素）—— 重试"
                % (len(png), dim[0], dim[1], ratio))
        else:
            say("  ✗ 没拍到")
        if attempt == 1:
            say("  首轮没拿到内容 —— 移开 WebView2 用户数据后重试一次（残留会让新 webview 起不来）")
            clear_webview_profile()
    return None


def main():
    parser = argparse.ArgumentParser(description="一键补拍 docs/screenshots/ 截图")
    parser.add_argument("--size", default="1600x1000", help="输出尺寸 WxH（物理像素）")
    parser.add_argument("--settle", type=float, default=3.0, help="定尺寸后等布局稳定（秒）")
    parser.add_argument("--inset", type=int, default=0, help="四边各再切掉几像素（圆角用）")
    parser.add_argument("--shot-each", default=None, help="每次点击后也存一张，如 .tmp/step-%%d.png")
    parser.add_argument("--list", action="store_true", help="列出配方后退出")
    parser.add_argument("names", nargs="*", help="要拍的配方名（默认全部）")
    args = parser.parse_args()

    if args.list:
        for r in RECIPES:
            say("%-14s %s" % (r["name"], r["what"]))
        return 0

    recipes = [r for r in RECIPES if not args.names or r["name"] in args.names]
    if not recipes:
        say("没有匹配的配方。可选：%s" % " / ".join(r["name"] for r in RECIPES))
        return 2
    if not os.path.exists(EXE):
        say("找不到 %s\n先跑一次 npm run tauri -- build（见 docs/screenshots/README.md）" % EXE)
        return 2

    w, h = (int(v) for v in args.size.lower().split("x"))
    user32.SetProcessDPIAware()
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    orig_cursor = (pt.x, pt.y)

    say("配方：%s  尺寸 %dx%d" % (", ".join(r["name"] for r in recipes), w, h))
    say("隔离配置目录：%s" % CFG_DIR)
    say("真实配置目录：%s（**全程只读**，一次都不会被写）" % REAL_CFG_DIR)
    failed = 0
    try:
        for recipe in recipes:
            say("\n【%s】%s" % (recipe["name"], recipe["what"]))
            got = capture_recipe(recipe, (w, h), args.settle, args.inset, args.shot_each)
            if not got:
                failed += 1
                continue
            png, dim = got
            out = os.path.join(OUT_DIR, "%s.png" % recipe["name"])
            os.makedirs(OUT_DIR, exist_ok=True)
            with open(out, "wb") as f:
                f.write(png)
            say("  ✓ %s %dx%d（%d 字节，sha=%s）"
                % (out, dim[0], dim[1], len(png), hashlib.sha256(png).hexdigest()[:12]))
    finally:
        stop_app()
        user32.SetCursorPos(*orig_cursor)
        say("\n演示配置留在 %s（真实配置从未被改写）" % CFG_DIR)
    say("\n有 %d 张没拍成。" % failed if failed else "\n全部拍完。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
