"""
生成 Tauri 打包所需的图标。

优先用 AI 设计源图 generated-images/icon_final.png（gitignore 的中间产物，需要 Pillow）：
  C:/Users/maoyu/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/gen_icons.py
源图缺失时退回内置占位图绘制（纯标准库，与 M0 版一致）。

关键修复（B25）：源图上边缘圆角 ~100px、下边缘完全直角。这里把 alpha 通道与
「垂直镜像后的 alpha」逐像素取 min —— 下边缘于是获得与上边缘**完全相同**的圆角，
无需手猜半径；上边缘形状不变（min 取的是自己与更方的镜像）。

产物：src-tauri/icons/{32x32.png, 128x128.png, 128x128@2x.png, icon.ico(多尺寸)}
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "src-tauri", "icons")
SRC = os.path.join(ROOT, "generated-images", "icon_final.png")

SIZES = [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def from_source() -> "object | None":
    """读源图并做上下圆角统一；Pillow 缺失或源图不存在时返回 None。"""
    if not os.path.exists(SRC):
        return None
    try:
        from PIL import Image, ImageChops
    except ImportError:
        print("  [warn] 未安装 Pillow，退回内置占位图绘制")
        return None

    img = Image.open(SRC).convert("RGBA")
    side = min(img.size)
    img = img.crop((0, 0, side, side))
    alpha = img.getchannel("A")
    # 下边缘 = 上边缘：与垂直镜像逐像素取较暗（更透明）者
    uniform = ImageChops.darker(alpha, alpha.transpose(Image.FLIP_TOP_BOTTOM))
    img.putalpha(uniform)
    return img


def write_with_pillow(img) -> None:
    from PIL import Image  # noqa: F401  （resize 常量需要）
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size in SIZES:
        img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT_DIR, name))
        print(f"  {name}  ({size}x{size})")
    ico = img.resize((256, 256), Image.LANCZOS)
    ico.save(
        os.path.join(OUT_DIR, "icon.ico"),
        sizes=[(s, s) for s in ICO_SIZES],
    )
    print(f"  icon.ico  ({', '.join(str(s) for s in ICO_SIZES)})")


# ---------------- 内置占位图（无源图/Pillow 时的兜底，纯标准库） ----------------

BG = (31, 111, 235, 255)      # 品牌蓝
PAPER = (255, 255, 255, 255)  # 文档白
LINE = (31, 111, 235, 255)    # 文档上的行


def in_rounded_rect(x: int, y: int, w: int, h: int, r: int) -> bool:
    """判断像素是否落在圆角矩形内（含边界）。"""
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    cx = min(max(x, r), w - 1 - r)
    cy = min(max(y, r), h - 1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def render(size: int):
    """画一个「圆角蓝底 + 白色文档」的图标（四角圆角一致）。"""
    rows = []
    r = max(1, int(size * 0.20))
    dx0, dx1 = int(size * 0.30), int(size * 0.72)
    dy0, dy1 = int(size * 0.22), int(size * 0.78)
    line_gap = max(1, int(size * 0.10))
    line_h = max(1, int(size * 0.045))
    for y in range(size):
        row = []
        for x in range(size):
            if not in_rounded_rect(x, y, size, size, r):
                row.append((0, 0, 0, 0))
                continue
            pixel = BG
            if dx0 <= x < dx1 and dy0 <= y < dy1:
                pixel = PAPER
                rel = y - dy0 - line_gap
                if rel > 0 and rel % line_gap < line_h:
                    limit = dx1 - int(size * 0.12) if rel > (dy1 - dy0) * 0.55 else dx1 - int(size * 0.08)
                    if x < limit:
                        pixel = LINE
            row.append(pixel)
        rows.append(row)
    return rows


def encode_png(size: int, rows) -> bytes:
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def encode_ico(size: int, png_bytes: bytes) -> bytes:
    """ICO 容器里直接嵌入 PNG（Windows Vista+ 支持）。"""
    header = struct.pack("<HHH", 0, 1, 1)
    dim = 0 if size >= 256 else size
    entry = struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png_bytes), 6 + 16)
    return header + entry + png_bytes


def write_placeholder() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size in SIZES:
        png = encode_png(size, render(size))
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(png)
        print(f"  {name}  ({size}x{size}, {len(png)} bytes)")
    ico_png = encode_png(256, render(256))
    with open(os.path.join(OUT_DIR, "icon.ico"), "wb") as f:
        f.write(encode_ico(256, ico_png))
    print(f"  icon.ico  ({len(ico_png)} bytes payload)")


def main():
    img = from_source()
    if img is not None:
        print(f"  source: {os.path.relpath(SRC, ROOT)}（上下圆角已统一）")
        write_with_pillow(img)
    else:
        print("  source 缺失，使用内置占位图")
        write_placeholder()


if __name__ == "__main__":
    main()
