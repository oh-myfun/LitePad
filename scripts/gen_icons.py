"""生成 LitePad 的 Tauri 打包图标。

纯矢量自绘（Pillow），不依赖任何外部源图。

**当前采用方案 B**：透明画布上直接是「折角文档 + 钢笔」，不加圆角渐变底；
钢笔沿对角线反放——**笔头朝左下角、笔尾在右上角**。
（用户要求：不排除背景时白纸在浅色底上会糊成一片，故纸面加了极淡描边 + 投影兜底。）

用法（venv 解释器）：
  PY=C:/Users/maoyu/.workbuddy/binaries/python/envs/default/Scripts/python.exe
  $PY scripts/gen_icons.py                # 生成候选对比图 generated-images/icon_variants.png
  $PY scripts/gen_icons.py --install B    # 写入 src-tauri/icons 并出预览板（当前采用）

三个变体（B 为选定方案，A/C 保留备查）：
  A  便签纸 + 铅笔（带圆角渐变底，B34 的进化）
  B  折角文档 + 钢笔（**无背景**，透明画布）
  C  字母 L + 光标（带圆角渐变底）

产物：src-tauri/icons/{32x32.png, 128x128.png, 128x128@2x.png, icon.ico(多尺寸)}
"""

from __future__ import annotations

import argparse
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "src-tauri", "icons")
PREVIEW_DIR = os.path.join(ROOT, "generated-images")

MASTER = 1024
SIZES = [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ---- 调色板 ----
BRAND_TOP = (37, 99, 235)      # #2563EB
BRAND_BOTTOM = (6, 182, 212)   # #06B6D4
INK = (30, 41, 59)             # #1E293B
LIGHT_LINE = (199, 210, 254)   # #C7D2FE
CARD_BOTTOM = (232, 240, 255)  # 卡片底部微蓝，避免纯白死板
PAPER_FOLD = (219, 234, 254)   # #DBEAFE 折角背面


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def _diag_mask(s):
    """45° 对角渐变蒙版：左上 0 → 右下 255（用两条正交 ramp 平均，无旋转伪影）。"""
    v = Image.linear_gradient("L").resize((s, s), Image.BICUBIC)
    h = Image.linear_gradient("L").rotate(90, expand=True).resize((s, s), Image.BICUBIC)
    return ImageChops.add(h, v, scale=2.0)


def _diag_gradient(size, c0, c1):
    """c0 左上 → c1 右下 的对角渐变。"""
    a = Image.new("RGBA", (size, size), c0 + (255,))
    b = Image.new("RGBA", (size, size), c1 + (255,))
    return Image.composite(b, a, _diag_mask(size))


def _vgrad(w, h, c0, c1):
    """竖直渐变 c0(上) → c1(下)。"""
    m = Image.linear_gradient("L").resize((w, h), Image.BICUBIC)
    return Image.composite(
        Image.new("RGBA", (w, h), c1 + (255,)),
        Image.new("RGBA", (w, h), c0 + (255,)),
        m,
    )


def _cyl(w, h, edge, mid):
    """圆筒明暗：上下边缘偏 edge、正中偏 mid（横向杆件的体积感）。"""
    m = Image.linear_gradient("L").resize((w, h), Image.BICUBIC)
    m = m.point(lambda v: abs(2 * v - 255))  # 边缘 255 / 中间 0
    return Image.composite(
        Image.new("RGBA", (w, h), edge + (255,)),
        Image.new("RGBA", (w, h), mid + (255,)),
        m,
    )


def _radial_alpha(size, cx, cy, r, peak):
    """以 (cx,cy)（归一化）为中心、半径 r 的径向 alpha，中心为 peak、边缘 0。"""
    g = Image.radial_gradient("L").resize((2 * r, 2 * r), Image.BICUBIC)
    g = ImageOps_invert(g)
    canvas = Image.new("L", (size, size), 0)
    canvas.paste(g, (int(cx * size - r), int(cy * size - r)))
    return canvas.point(lambda v: int(v * peak / 255))


def ImageOps_invert(img):
    return ImageChops.invert(img)


def _tint(size, color, alpha_l):
    return Image.merge(
        "RGBA",
        (
            Image.new("L", (size, size), color[0]),
            Image.new("L", (size, size), color[1]),
            Image.new("L", (size, size), color[2]),
            alpha_l,
        ),
    )


def _shadow_from_alpha(alpha, blur, offset, color, opacity):
    """由 alpha 生成柔和投影层（同尺寸 RGBA）。"""
    a = alpha.point(lambda v: int(v * opacity / 255))
    sh = Image.new("RGBA", alpha.size, color + (0,))
    sh.putalpha(a)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    out = Image.new("RGBA", alpha.size, (0, 0, 0, 0))
    out.alpha_composite(sh, offset)
    return out


# --------------------------------------------------------------------------- #
# 共同底层：玻璃质感圆角瓷砖
# --------------------------------------------------------------------------- #
def _tile(s):
    radius = int(s * 0.2237)
    mask = _rounded_mask(s, radius)
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    base.paste(_diag_gradient(s, BRAND_TOP, BRAND_BOTTOM), (0, 0), mask)

    # 右下暗角，制造纵深
    base = Image.alpha_composite(
        base, _tint(s, (6, 20, 60), _radial_alpha(s, 1.04, 1.02, int(0.88 * s), 62))
    )
    # 左上柔光，玻璃高光
    base = Image.alpha_composite(
        base, _tint(s, (255, 255, 255), _radial_alpha(s, 0.17, 0.13, int(0.95 * s), 74))
    )
    # 内描边（顶部偏亮的玻璃边缘）
    stroke = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    w = max(2, int(s * 0.0055))
    ImageDraw.Draw(stroke).rounded_rectangle(
        [w, w, s - 1 - w, s - 1 - w],
        radius=radius - w,
        outline=(255, 255, 255, 54),
        width=w,
    )
    base = Image.alpha_composite(base, stroke)
    return base, mask


def _card(s, x0, y0, x1, y1, radius, cut=0.0, outline=None, fold_edge=None):
    """白色卡片（带竖直微渐变），可选右上折角与描边。返回 (img, mask)。

    无背景方案下纸面是白色，落在浅色底上会糊掉，故支持极淡描边兜底。
    """
    bx0, by0, bx1, by1 = int(x0 * s), int(y0 * s), int(x1 * s), int(y1 * s)
    w, h = bx1 - bx0, by1 - by0
    img = _vgrad(w, h, (255, 255, 255), CARD_BOTTOM)
    m = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(m)
    md.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(radius * s), fill=255)

    if cut > 0:
        c = int(cut * s)
        md.polygon([(w - c, -2), (w + 2, -2), (w + 2, c)], fill=0)  # 削掉右上角

    img.putalpha(m)

    if cut > 0:
        c = int(cut * s)
        # 折角背面（贴回卡片内的三角）
        d = ImageDraw.Draw(img)
        d.polygon([(w - c, 0), (w - 1, c), (w - c, c)], fill=PAPER_FOLD + (255,))
        # 折痕的柔和阴影
        fold_sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(fold_sh).polygon(
            [(w - c, 0), (w - 1, c), (w - c, c)], fill=(30, 41, 59, 40)
        )
        fold_sh = fold_sh.filter(ImageFilter.GaussianBlur(max(1, int(s * 0.006))))
        fold_sh.putalpha(ImageChops.multiply(fold_sh.getchannel("A"), m))
        img.alpha_composite(fold_sh)
        if fold_edge:
            ImageDraw.Draw(img).line(
                [(w - c, 0), (w - 1, c), (w - c, c), (w - c, 0)],
                fill=fold_edge,
                width=max(1, int(s * 0.0026)),
                joint="curve",
            )

    if outline:
        ow = max(1, int(s * 0.0030))
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            [ow / 2, ow / 2, w - 1 - ow / 2, h - 1 - ow / 2],
            radius=int(radius * s) - ow // 2,
            outline=outline,
            width=ow,
        )
        layer.putalpha(ImageChops.multiply(layer.getchannel("A"), m))
        img.alpha_composite(layer)
    return img, m


def _bar(img, box, color, radius_px):
    ImageDraw.Draw(img).rounded_rectangle(
        [int(box[0]), int(box[1]), int(box[2]), int(box[3])], radius=int(radius_px), fill=color
    )


# --------------------------------------------------------------------------- #
# 工具：铅笔 / 钢笔（水平绘制，笔尖朝右，之后整体旋转）
# --------------------------------------------------------------------------- #
def _tool(s, kind, length=0.62):
    L = int(s * length)
    W = int(s * 0.098) if kind == "pencil" else int(s * 0.064)
    img = Image.new("RGBA", (L, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if kind == "pencil":
        er_w, fer_w = int(L * 0.135), int(L * 0.082)
        body_x0 = er_w + fer_w
        wood_len = int(L * 0.205)
        body_x1 = L - wood_len
        cap_r = int(W * 0.46)

        # 橡皮（圆筒）
        _paste_cyl(img, (0, 0, er_w + cap_r, W), (219, 39, 119), (249, 168, 212), cap_r)
        # 金属箍
        _paste_cyl(img, (er_w, 0, body_x0, W), (148, 163, 184), (241, 245, 249), int(W * 0.1))
        # 笔杆（琥珀圆筒）
        _paste_cyl(img, (body_x0, 0, body_x1, W), (180, 83, 9), (251, 191, 36), int(W * 0.12))
        # 笔杆高光条
        d.rounded_rectangle(
            [body_x0 + int(W * 0.28), int(W * 0.26), body_x1 - int(W * 0.22), int(W * 0.40)],
            radius=int(W * 0.07),
            fill=(255, 255, 255, 118),
        )
        # 木尖（锥）
        d.polygon(
            [(body_x1, 0), (body_x1, W - 1), (L - 1, W // 2)],
            fill=(253, 230, 138, 255),
        )
        # 木尖根部阴影
        d.rectangle([body_x1, 0, body_x1 + int(W * 0.09), W], fill=(217, 119, 6, 150))
        # 铅芯
        lead = int(wood_len * 0.30)
        hw = int((W / 2) * (lead / wood_len))
        d.polygon(
            [(L - lead, W // 2 - hw), (L - lead, W // 2 + hw), (L - 1, W // 2)],
            fill=(51, 65, 85, 255),
        )
    else:  # pen
        cap_r = int(W * 0.46)
        cone_x = int(L * 0.775)
        # 笔身（深石墨圆筒）
        _paste_cyl(img, (0, 0, cone_x, W), (9, 14, 32), (92, 107, 130), cap_r)
        # 笔身纵向高光（收细，模拟光泽）
        d.rounded_rectangle(
            [int(W * 0.12), int(W * 0.26), cone_x - int(W * 0.55), int(W * 0.35)],
            radius=int(W * 0.05),
            fill=(255, 255, 255, 96),
        )
        # 握位（略深的收束带）
        grip_x0 = int(L * 0.66)
        _paste_cyl(img, (grip_x0, 0, cone_x, W), (2, 6, 23), (51, 65, 85), 0)
        # 品牌色环
        ring_x0, ring_x1 = int(L * 0.688), int(L * 0.736)
        _paste_cyl(img, (ring_x0, 0, ring_x1, W), (8, 145, 178), (165, 243, 252), 0)
        # 笔尖锥（细长）
        d.polygon([(cone_x, 0), (cone_x, W - 1), (L - 1, W // 2)], fill=(15, 23, 42, 255))
        d.polygon(
            [(cone_x, int(W * 0.30)), (cone_x, int(W * 0.47)), (int(L * 0.955), W // 2)],
            fill=(100, 116, 139, 220),
        )
    return img


def _paste_cyl(img, box, edge, mid, radius):
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    cyl = _cyl(w, h, edge, mid)
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(cyl, (x0, y0), m)


def _place_tool(base, tool, s, center, angle, shadow_op=95):
    rot = tool.rotate(angle, expand=True, resample=Image.BICUBIC)
    x = int(center[0] * s - rot.width / 2)
    y = int(center[1] * s - rot.height / 2)
    off = Image.new("RGBA", base.size, (0, 0, 0, 0))
    off.alpha_composite(rot, (x, y))
    sh = _shadow_from_alpha(
        off.getchannel("A"),
        max(2, int(s * 0.016)),
        (int(s * 0.008), int(s * 0.018)),
        (12, 20, 48),
        shadow_op,
    )
    base.alpha_composite(sh)
    base.alpha_composite(rot, (x, y))


# --------------------------------------------------------------------------- #
# 变体 A：便签纸 + 铅笔（精修）
# --------------------------------------------------------------------------- #
def variant_a(s):
    base, mask = _tile(s)
    card, cm = _card(s, 0.258, 0.205, 0.706, 0.795, 0.050)
    cx, cy = int(0.258 * s), int(0.205 * s)
    base.alpha_composite(
        _shadow_from_alpha(cm, max(2, int(s * 0.022)), (int(s * 0.010), int(s * 0.024)),
                           (8, 18, 50), 105),
        (cx, cy),
    )
    base.alpha_composite(card, (cx, cy))

    # 标题条（品牌对角渐变）
    hx0, hy0, hx1, hy1 = int(0.318 * s), int(0.292 * s), int(0.556 * s), int(0.353 * s)
    head = _diag_gradient(hx1 - hx0, BRAND_TOP, BRAND_BOTTOM).resize(
        (hx1 - hx0, hy1 - hy0), Image.LANCZOS
    )
    hm = Image.new("L", (hx1 - hx0, hy1 - hy0), 0)
    ImageDraw.Draw(hm).rounded_rectangle(
        [0, 0, hx1 - hx0 - 1, hy1 - hy0 - 1], radius=int(0.031 * s), fill=255
    )
    base.paste(head, (hx0, hy0), hm)

    # 文本行
    lx0, lx1 = int(0.318 * s), int(0.648 * s)
    lh = int(0.034 * s)
    for i, frac in enumerate((1.0, 0.92, 1.0, 0.66)):
        y = int((0.408 + i * 0.077) * s)
        _bar(base, (lx0, y, lx0 + (lx1 - lx0) * frac, y + lh), LIGHT_LINE + (255,), lh / 2)

    _place_tool(base, _tool(s, "pencil"), s, (0.585, 0.655), -34)
    return _finish(base, mask)


# --------------------------------------------------------------------------- #
# 变体 B：折角文档 + 钢笔（无背景，用户选定方案）
# --------------------------------------------------------------------------- #
def variant_b(s):
    """透明画布上直接是「折角文档 + 钢笔」，不加圆角渐变底。

    钢笔反放：笔头朝左下角、笔尾在右上角（局部 +x 是笔尖方向，故旋转 -135°）。
    """
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    card, cm = _card(
        s,
        0.232,
        0.150,
        0.684,
        0.830,
        0.044,
        cut=0.148,
        outline=(203, 213, 225, 205),
        fold_edge=(165, 180, 252, 255),
    )
    cx, cy = int(0.232 * s), int(0.150 * s)
    base.alpha_composite(
        _shadow_from_alpha(
            cm, max(2, int(s * 0.026)), (int(s * 0.013), int(s * 0.028)), (15, 23, 42), 118
        ),
        (cx, cy),
    )
    base.alpha_composite(card, (cx, cy))

    # 文本行：首行是「标题」（中靛，兼作白纸上的对比锚点），其余淡靛
    lx0, lx1 = int(0.292 * s), int(0.624 * s)
    lh = int(0.036 * s)
    rows = (
        (0.60, (99, 102, 241)),
        (1.0, (165, 180, 252)),
        (1.0, (165, 180, 252)),
        (1.0, (165, 180, 252)),
        (0.72, (165, 180, 252)),
    )
    for i, (frac, col) in enumerate(rows):
        y = int((0.338 + i * 0.078) * s)
        _bar(base, (lx0, y, lx0 + (lx1 - lx0) * frac, y + lh), col + (255,), lh / 2)

    _place_tool(base, _tool(s, "pen", length=0.78), s, (0.524, 0.524), -135)
    return base


# --------------------------------------------------------------------------- #
# 变体 C：字母 L + 光标
# --------------------------------------------------------------------------- #
def variant_c(s):
    base, mask = _tile(s)

    glyph = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bw = int(0.140 * s)                      # 笔画宽度
    vx0, vy0, vy1 = int(0.318 * s), int(0.242 * s), int(0.762 * s)
    _bar(glyph, (vx0, vy0, vx0 + bw, vy1), (255, 255, 255, 255), bw / 2)
    fx1 = int(0.634 * s)
    _bar(glyph, (vx0, vy1 - bw, fx1, vy1), (255, 255, 255, 255), bw / 2)
    # 光标（细高的插入符，紧贴 L 右侧）
    _bar(glyph, (0.716 * s, 0.338 * s, 0.756 * s, 0.666 * s), (252, 211, 77, 255), 0.020 * s)

    sh = _shadow_from_alpha(
        glyph.getchannel("A"), max(2, int(s * 0.018)), (int(s * 0.008), int(s * 0.020)),
        (8, 18, 50), 110,
    )
    base.alpha_composite(sh)
    base.alpha_composite(glyph)
    return _finish(base, mask)


def _finish(base, mask):
    a = base.getchannel("A")
    base.putalpha(ImageChops.multiply(a, mask))
    return base


VARIANTS = {
    "A": ("便签纸 + 铅笔（精修）", variant_a),
    "B": ("折角文档 + 钢笔", variant_b),
    "C": ("字母 L + 光标", variant_c),
}


def render(letter, size=MASTER):
    return VARIANTS[letter][1](size)


# --------------------------------------------------------------------------- #
# 输出
# --------------------------------------------------------------------------- #
def write_icons(img):
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size in SIZES:
        img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT_DIR, name))
        print(f"  {name}  ({size}x{size})")
    img.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT_DIR, "icon.ico"), sizes=[(v, v) for v in ICO_SIZES]
    )
    print(f"  icon.ico  ({', '.join(str(v) for v in ICO_SIZES)})")


def write_single_preview(img, letter):
    """预览板：透明底（棋盘格）+ 浅色底 / 深色底 + 尺寸梯队。

    无背景方案必须同时看两种底色，否则「白纸在浅色底上会不会糊掉」判断不了。
    """
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    path = os.path.join(PREVIEW_DIR, "litepad_icon_preview.png")

    W, H, pad, col_x = 1120, 584, 28, 540
    board = Image.new("RGBA", (W, H), (20, 20, 30, 255))
    d = ImageDraw.Draw(board)
    f_title, f_cap, f_lab = _font(20), _font(15), _font(17)

    d.text(
        (pad, 18),
        f"LitePad 图标 · 方案 {letter}（透明画布，无背景）",
        font=f_title,
        fill=(226, 232, 240, 255),
    )

    # 透明底：棋盘格示意
    cb = Image.new("RGBA", (480, 480), (255, 255, 255, 255))
    cbd = ImageDraw.Draw(cb)
    step = 20
    for i in range(0, 480, step):
        for j in range(0, 480, step):
            if (i // step + j // step) % 2:
                cbd.rectangle([i, j, i + step - 1, j + step - 1], fill=(226, 232, 240, 255))
    board.alpha_composite(cb, (pad, 50))
    board.alpha_composite(img.resize((480, 480), Image.LANCZOS), (pad, 50))
    d.text((pad, 540), "透明底（棋盘格示意）", font=f_cap, fill=(139, 147, 168, 255))

    # 浅色底 / 深色底对照
    for k, (bg, fg, cap) in enumerate(
        (
            ((247, 249, 252, 255), (100, 116, 139, 255), "浅色底"),
            ((30, 32, 48, 255), (148, 163, 184, 255), "深色底"),
        )
    ):
        y0 = 50 + k * 160
        d.rounded_rectangle((col_x, y0, W - pad, y0 + 144), radius=14, fill=bg)
        board.alpha_composite(img.resize((112, 112), Image.LANCZOS), (col_x + 26, y0 + 16))
        d.text((col_x + 166, y0 + 62), cap, font=f_lab, fill=fg)

    # 尺寸梯队（底对齐）
    d.text((col_x, 386), "尺寸梯队", font=f_cap, fill=(139, 147, 168, 255))
    x = col_x
    for sz in (128, 64, 48, 32, 16):
        board.alpha_composite(
            img.resize((sz, sz), Image.LANCZOS), (x, 408 + (128 - sz))
        )
        x += sz + 16

    board.convert("RGB").save(path)
    print(f"  预览板：{path}")


def _font(size):
    for p in (
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        try:
            return ImageFont.truetype(p, size)
        except Exception:  # noqa: BLE001
            continue
    try:
        return ImageFont.load_default(size=size)
    except Exception:  # noqa: BLE001
        return ImageFont.load_default()


def build_sheet():
    pad, col_w, gap = 30, 350, 26
    W = pad * 2 + col_w * 3 + gap * 2
    big, smalls = 236, [128, 64, 48, 32, 16]
    H = pad + 44 + big + 22 + 140 + 22 + 86 + pad
    sheet = Image.new("RGBA", (W, H), (20, 20, 30, 255))
    d = ImageDraw.Draw(sheet)
    f_title, f_name, f_cap = _font(21), _font(23), _font(15)

    d.text((pad, 16), "LitePad 图标候选 · 迭代对比", font=f_title, fill=(226, 232, 240, 255))

    for i, (letter, (name, _)) in enumerate(VARIANTS.items()):
        x = pad + i * (col_w + gap)
        y = pad + 44
        d.text((x, y - 34), f"{letter}   {name}", font=f_name, fill=(148, 197, 253, 255))

        # 大图
        icon = render(letter).resize((big, big), Image.LANCZOS)
        sheet.alpha_composite(icon, (x + (col_w - big) // 2, y))

        # 小尺寸行（深底）
        sy = y + big + 22
        sx = x
        for sz in smalls:
            sm = render(letter).resize((sz, sz), Image.LANCZOS)
            sheet.alpha_composite(sm, (sx, sy + (128 - sz) // 2))
            sx += sz + 12

        # 浅色底 / 深色底 对照
        cy0 = sy + 140
        half = (col_w - 12) // 2
        chips = (
            ((247, 249, 252, 255), (100, 116, 139, 255), "浅色底"),
            ((30, 32, 48, 255), (148, 163, 184, 255), "深色底"),
        )
        for j, (bg, fg, cap) in enumerate(chips):
            bx = x + j * (half + 12)
            d.rounded_rectangle((bx, cy0, bx + half, cy0 + 86), radius=14, fill=bg)
            ic = render(letter).resize((50, 50), Image.LANCZOS)
            sheet.alpha_composite(ic, (bx + (half - 50) // 2, cy0 + 10))
            tw = d.textlength(cap, font=f_cap)
            d.text((bx + (half - tw) / 2, cy0 + 64), cap, font=f_cap, fill=fg)

    os.makedirs(PREVIEW_DIR, exist_ok=True)
    path = os.path.join(PREVIEW_DIR, "icon_variants.png")
    sheet.convert("RGB").save(path)
    print(f"  对比图：{path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", choices=list(VARIANTS), help="把选定变体写入 src-tauri/icons")
    args = ap.parse_args()

    if args.install:
        print(f"  安装变体 {args.install} · {VARIANTS[args.install][0]}")
        img = render(args.install)
        write_icons(img)
        write_single_preview(img, args.install)
    else:
        print("  生成候选对比图（未写入 src-tauri/icons）")
        build_sheet()


if __name__ == "__main__":
    main()
