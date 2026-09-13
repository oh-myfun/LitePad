"""
窗口截屏工具（纯标准库：ctypes + zlib，不依赖 Pillow）。

用法：python scripts/screenshot.py [标题关键字] [输出路径]
默认查找标题含 "LiteMD" 的可见窗口，保存到 scripts 同级的 smoke-window.png。
"""

import ctypes
import ctypes.wintypes as wt
import struct
import sys
import time
import zlib

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
SW_RESTORE = 9


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class BMIHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


def find_window(keyword: str):
    """返回第一个标题含 keyword 的可见窗口句柄。"""
    result = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if keyword in buf.value:
            result.append((hwnd, buf.value))
            return False
        return True

    user32.EnumWindows(callback, 0)
    return result[0] if result else (None, None)


def capture(hwnd) -> bytes:
    """截取窗口矩形区域，返回 PNG 字节。"""
    user32.SetProcessDPIAware()
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)  # 等待窗口置顶与重绘

    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
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


def main() -> int:
    keyword = sys.argv[1] if len(sys.argv) > 1 else "LiteMD"
    out = sys.argv[2] if len(sys.argv) > 2 else "smoke-window.png"

    if keyword == "--screen":
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

    hwnd, title = find_window(keyword)
    if not hwnd:
        print(f"未找到标题含 {keyword!r} 的可见窗口")
        return 1

    png, size = capture(hwnd)
    with open(out, "wb") as f:
        f.write(png)
    print(f"已捕获 {title!r} ({size[0]}x{size[1]}) -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
