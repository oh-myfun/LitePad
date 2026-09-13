"""
生成 LitePad 的 Tauri 打包图标（B34）。

绘制逻辑（需 Pillow，venv：
  C:/Users/maoyu/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/gen_icons.py
）：
  **矢量自绘 draw_litepad()**——简洁 flat 风：
  - 圆角方形背景（四角同半径，rounded_rectangle 天然一致）+ 蓝→青垂直渐变
    （「轻量记事本」的清爽感）
  - 白色便签纸 + 淡靛文本行（贴合「Pad / 记事」功能）
  - 右下角一支斜放铅笔（写作/编辑的隐喻）
  纯矢量自绘，不依赖任何外部源图（B25 的 AI 源图镜像方案已废弃）。

产物：src-tauri/icons/{32x32.png, 128x128.png, 128x128@2x.png, icon.ico(多尺寸)}
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "src-tauri", "icons")

SIZES = [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def draw_litepad(size: int = 1024):
    """矢量绘制 LitePad 图标：圆角渐变底 + 便签纸 + 铅笔。四角圆角天然一致。"""
    from PIL import Image, ImageDraw

    s = size
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # ---- 背景：圆角矩形 + 蓝→青垂直渐变 ----
    radius = int(s * 0.224)  # 与主流现代图标圆角比例一致，四角同半径
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)

    grad = Image.new("RGBA", (s, s))
    top, bottom = (37, 99, 235), (6, 182, 212)  # #2563EB → #06B6D4
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / (s - 1)
        gd.line(
            [(0, y), (s, y)],
            fill=(
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
                255,
            ),
        )
    base.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(base)

    # ---- 便签纸（白色圆角矩形）----
    px0, py0, px1, py1 = int(s * 0.30), int(s * 0.235), int(s * 0.745), int(s * 0.79)
    d.rounded_rectangle([px0, py0, px1, py1], radius=int(s * 0.04), fill=(255, 255, 255, 255))

    # ---- 纸上文本行（淡靛，最后一行短）----
    line_color = (199, 210, 254, 255)  # #C7D2FE
    line_h = int(s * 0.028)
    lx0, lx1 = px0 + int(s * 0.05), px1 - int(s * 0.05)
    for i, frac in enumerate((1.0, 1.0, 1.0, 0.62)):
        y = py0 + int(s * 0.075) + i * int(s * 0.085)
        d.rounded_rectangle(
            [lx0, y, lx0 + int((lx1 - lx0) * frac), y + line_h],
            radius=line_h // 2,
            fill=line_color,
        )

    # ---- 铅笔（正立绘制后旋转 -35°，压在纸右下角）----
    pw, ph = int(s * 0.42), int(s * 0.10)
    pencil = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pencil)
    eraser_w = int(pw * 0.16)   # 橡皮（粉）
    band_w = int(pw * 0.10)     # 金属箍（浅灰）
    tip_w = int(pw * 0.16)      # 木尖（黄）
    body_x0 = eraser_w + band_w
    body_x1 = pw - tip_w
    half = ph // 2
    pd.rounded_rectangle([0, half - int(ph * 0.30), eraser_w + 8, half + int(ph * 0.30)],
                         radius=int(ph * 0.14), fill=(248, 113, 113, 255))          # 橡皮
    pd.rectangle([eraser_w, half - int(ph * 0.34), eraser_w + band_w, half + int(ph * 0.34)],
                 fill=(229, 231, 235, 255))                                            # 箍
    pd.rectangle([body_x0, half - int(ph * 0.34), body_x1, half + int(ph * 0.34)],
                 fill=(245, 158, 11, 255))                                             # 杆
    pd.polygon([(body_x1, half - int(ph * 0.34)), (body_x1, half + int(ph * 0.34)), (pw - 2, half)],
               fill=(253, 224, 71, 255))                                               # 木尖
    pd.polygon([(pw - int(tip_w * 0.42), half - int(ph * 0.075)),
                (pw - int(tip_w * 0.42), half + int(ph * 0.075)), (pw - 2, half)],
               fill=(55, 65, 81, 255))                                                 # 铅芯
    pencil = pencil.rotate(-32, expand=True, resample=Image.BICUBIC)
    base.alpha_composite(pencil, (int(s * 0.50), int(s * 0.53)))

    return base


def write_with_pillow(img) -> None:
    from PIL import Image  # noqa: F401
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


def main():
    print("  绘制 LitePad 图标（圆角渐变底 + 便签纸 + 铅笔）")
    write_with_pillow(draw_litepad())


if __name__ == "__main__":
    main()
