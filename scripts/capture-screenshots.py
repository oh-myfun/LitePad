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
MD = os.path.join(ROOT, "docs", "example.md")
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


# README 只用一张图（docs/conventions.md：开头只放一张 main.png），所以只维护 main。
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


def stop_app():
    """先温和再强杀；连带清掉 msedgewebview2 孤儿进程（它们会占住用户数据目录）。"""
    if pids_alive():
        subprocess.run(["taskkill", "/IM", "litepad.exe", "/T"], capture_output=True)
        for _ in range(12):
            if not pids_alive():
                break
            time.sleep(0.25)
        if pids_alive():
            subprocess.run(["taskkill", "/F", "/IM", "litepad.exe", "/T"], capture_output=True)
    subprocess.run(["taskkill", "/F", "/IM", "msedgewebview2.exe", "/T"], capture_output=True)
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
    # B123-3 修正：标签样式**强制缺省档（connected）** —— 此前从真实设置打底，
    # 用户配置是 pill，导致 main.png 一直是胶囊档：connected 档的界面改动
    # （B113+ 舌片/肩部/贴边顶角）从未真正进过截图验收，像素结论全是假阳性
    # （条带底部的自绘滚动条 thumb 被误认成肩部反弧）。pill 档自有设置页预览。
    base["tab_style"] = "connected"
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, indent=2)
    with open(SESSION, "w", encoding="utf-8") as f:
        json.dump(recipe["session"](), f, ensure_ascii=False, indent=2)


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
