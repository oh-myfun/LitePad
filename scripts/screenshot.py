"""
窗口截屏工具（纯标准库：ctypes + zlib，不依赖 Pillow）。

⚠️ **补拍 README 截图请用 `scripts/capture-screenshots.py`**（它会备份/写演示会话、
清 WebView2 用户数据、抢前台、空白自检，一条龙）。本脚本是它底下的**底层件**：
PNG 编码、窗口查找、BitBlt 抓图，也能单独当命令行用（见下）。

抓图口径：只抓**窗口可见外框**（`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`），
不是 `GetWindowRect` —— Win10/11 那圈不可见的调整边框会把桌面背景带进图里。
仍有两个固有毛病（调用方负责规避）：① 光标停在窗口里会被拍进去（补拍脚本会先挪走）；
② 没抢到前台（`SetForegroundWindow` 会被焦点窃取防护静默拒掉）就会拍到别的窗口。
完整流程与踩坑记录见 docs/screenshots/README.md。

用法：
  python scripts/screenshot.py <标题关键字> <输出路径>
      查找标题含关键字的第一个可见窗口（注意：资源管理器标题里也含
      "LitePad" 这类目录名时容易误抓，此时请改用 --exe）。
  python scripts/screenshot.py --exe litepad.exe <输出路径>
      按进程名定位窗口，比标题关键字可靠（补拍脚本用这个）。
  python scripts/screenshot.py --pid 24076 <输出路径>
      直接指定窗口所属进程 pid。
  python scripts/screenshot.py --screen <输出路径>
      抓全屏。

可选参数：`--size WxH` 先把窗口可见外框调成该尺寸；`--inset N` 四边各再切 N 像素。
默认输出 scripts 同级的 smoke-window.png。
"""

import ctypes
import ctypes.wintypes as wt
import struct
import sys
import time
import zlib

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

SRCCOPY = 0x00CC0020
SW_RESTORE = 9
TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", ctypes.c_uint32),
        ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_char * MAX_PATH),
    ]


def pids_by_exe(exe_name: str) -> list[int]:
    """按镜像名（如 litepad.exe）枚举进程 pid，不依赖 OpenProcess 权限。"""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return []
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    pids: list[int] = []
    ok = kernel32.Process32First(snap, ctypes.byref(entry))
    while ok:
        name = entry.szExeFile.decode("mbcs", "ignore").lower()
        if name == exe_name.lower():
            pids.append(int(entry.th32ProcessID))
        ok = kernel32.Process32Next(snap, ctypes.byref(entry))
    kernel32.CloseHandle(snap)
    return pids


def find_window(keyword: str = "", pids: set[int] | None = None):
    """返回标题含 keyword（或属于 pids）的第一个可见顶层窗口。"""
    result = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        if pids is not None:
            owner = wt.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value not in pids:
                return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if keyword and keyword not in buf.value:
            return True
        result.append((hwnd, buf.value, length))
        return True

    user32.EnumWindows(callback, 0)
    if not result:
        return (None, None)
    # 优先取标题最长的那个：Tauri 主窗口标题最长，托盘/隐藏壳窗口更短
    result.sort(key=lambda r: -r[2])
    return result[0][0], result[0][1]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


DWMWA_EXTENDED_FRAME_BOUNDS = 9


def visible_rect(hwnd, inset: int = 0):
    """窗口**可见**外框。

    为什么不用 `GetWindowRect`：Win10/11 会给窗口套一圈**不可见**的调整边框（左右下各约
    7-8px），`GetWindowRect` 把它算在内，直接照这个矩形 BitBlt 就会在图四周留一圈
    桌面背景（实测左边和上边各约 7px）。DWM 的 extended frame bounds 才是眼睛看到的框。
    """
    rect = RECT()
    ok = -1
    try:
        ok = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)
        )
    except Exception:
        ok = -1
    if ok != 0 or rect.right <= rect.left or rect.bottom <= rect.top:
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    if inset:
        rect.left += inset
        rect.top += inset
        rect.right -= inset
        rect.bottom -= inset
    return rect


def resize_window_to_frame(hwnd, width: int, height: int, inset: int = 0) -> None:
    """把**可见外框**调成 width×height 并贴到屏幕 (0,0)。

    对 `SetWindowPos` 来说尺寸含那圈不可见边框，所以先设一次、量一次实际可见框，
    再按差值补一次——两次就收敛。这样导出的 PNG 正好是 width×height，
    且窗口坐标 = 屏幕坐标（点击时不用换算）。
    """
    SWP_NOZORDER = 0x0004
    user32.SetWindowPos(hwnd, 0, 0, 0, width, height, SWP_NOZORDER)
    time.sleep(0.5)
    r = visible_rect(hwnd, inset)
    dx, dy = r.left, r.top
    # 可见框比外框小一圈（左右下各约 8px），所以要**补上**差值，不是减掉
    dw = width - (r.right - r.left)
    dh = height - (r.bottom - r.top)
    user32.SetWindowPos(hwnd, 0, -dx, -dy, width + dw, height + dh, SWP_NOZORDER)
    time.sleep(0.6)


class BMIHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


def capture(hwnd, inset: int = 0) -> bytes:
    """截取窗口**可见外框**，返回 (PNG 字节, (宽, 高))。

    `inset` 会从四边再各切掉几个像素（取整像素用；圆角窗口的四个角若混进桌面可给 1-2）。
    """
    user32.SetProcessDPIAware()
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)  # 等待窗口置顶与重绘

    rect = visible_rect(hwnd, inset)
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise RuntimeError(f"窗口尺寸异常: {width}x{height}")

    screen_dc = user32.GetDC(0)
    mem_dc = gdi32.CreateCompatibleDC(screen_dc)
    bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)
    gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, rect.left, rect.top, SRCCOPY)

    header = BMIHEADER()
    header.biSize = ctypes.sizeof(BMIHEADER)
    header.biWidth = width
    # 负高度 = 自顶向下的行序，免去逐行翻转
    header.biHeight = -height
    header.biPlanes = 1
    header.biBitCount = 32
    header.biCompression = 0  # BI_RGB

    row_bytes = width * 4
    buf = ctypes.create_string_buffer(row_bytes * height)
    gdi32.GetDIBits(mem_dc, bitmap, 0, height, buf, ctypes.byref(header), 0)

    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(0, screen_dc)

    # BGRA -> RGBA
    raw = bytearray()
    data = buf.raw
    for y in range(height):
        row = data[y * row_bytes:(y + 1) * row_bytes]
        for x in range(width):
            b, g, r = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
            raw += bytes((r, g, b, 255))

    return encode_png(width, height, bytes(raw)), (width, height)


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter 0
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def resize_window(hwnd, width: int, height: int) -> None:
    """把窗口的**可见外框**调成 width×height 并贴到 (0,0)（物理像素，需先 DPI aware）。"""
    resize_window_to_frame(hwnd, width, height)


def main() -> int:
    # 先声明 DPI 感知，否则 SetWindowPos 的尺寸会被系统按缩放比放大
    user32.SetProcessDPIAware()

    args = sys.argv[1:]
    out = "smoke-window.png"
    mode = "title"
    value = "LitePad"
    size = None
    inset = 0
    rest: list[str] = []

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--exe", "--pid", "--screen"):
            mode = a[2:]
            if a != "--screen":
                i += 1
                value = args[i] if i < len(args) else ""
        elif a == "--out":
            i += 1
            out = args[i] if i < len(args) else out
        elif a == "--inset":
            i += 1
            try:
                inset = int(args[i])
            except (IndexError, ValueError):
                print("--inset 需要整数")
                return 2
        elif a == "--size":
            i += 1
            spec = args[i] if i < len(args) else ""
            try:
                w, h = spec.lower().split("x")
                size = (int(w), int(h))
            except ValueError:
                print(f"--size 需要 WxH 格式，收到 {spec!r}")
                return 2
        else:
            rest.append(a)
        i += 1

    if rest:
        if mode == "title":
            value = rest[0]
            if len(rest) > 1:
                out = rest[1]
        else:
            out = rest[0]

    if mode == "screen":
        user32.SetProcessDPIAware()
        width = user32.GetSystemMetrics(0)
        height = user32.GetSystemMetrics(1)
        screen_dc = user32.GetDC(0)
        mem_dc = gdi32.CreateCompatibleDC(screen_dc)
        bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
        gdi32.SelectObject(mem_dc, bitmap)
        gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, 0, 0, SRCCOPY)

        header = BMIHEADER()
        header.biSize = ctypes.sizeof(BMIHEADER)
        header.biWidth = width
        header.biHeight = -height
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = 0
        row_bytes = width * 4
        buf = ctypes.create_string_buffer(row_bytes * height)
        gdi32.GetDIBits(mem_dc, bitmap, 0, height, buf, ctypes.byref(header), 0)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(0, screen_dc)

        raw = bytearray()
        data = buf.raw
        for y in range(height):
            row = data[y * row_bytes:(y + 1) * row_bytes]
            for x in range(width):
                b, g, r = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
                raw += bytes((r, g, b, 255))
        with open(out, "wb") as f:
            f.write(encode_png(width, height, bytes(raw)))
        print(f"已捕获全屏 ({width}x{height}) -> {out}")
        return 0

    pids = None
    if mode == "pid":
        try:
            pids = {int(value)}
        except ValueError:
            print(f"--pid 需要整数，收到 {value!r}")
            return 2
    elif mode == "exe":
        found = pids_by_exe(value)
        if not found:
            print(f"未找到名为 {value!r} 的进程")
            return 1
        pids = set(found)

    hwnd, title = find_window("" if pids else value, pids)
    if not hwnd:
        print(f"未找到匹配窗口 (mode={mode}, value={value!r})")
        return 1

    if size:
        resize_window(hwnd, size[0], size[1])

    png, dim = capture(hwnd, inset)
    with open(out, "wb") as f:
        f.write(png)
    print(f"已捕获 {title!r} ({dim[0]}x{dim[1]}) -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
