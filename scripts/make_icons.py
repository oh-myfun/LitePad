"""从 docs/LitePad.png 出全套打包图标（B222）。

源图 = `docs/LitePad.png`（512×512，深色圆角方块底 + 白色羽毛，四角透明圆角）。
本脚本**只做缩放与格式转换**，不改内容：不重绘、不锐化、不加投影、不加底色。
图标的几何与配色真相全在源图里 —— 想换图标，先换源图，再重跑本脚本。

与 `gen_icons.py` 的关系（按用户要求**原样保留**、不删）：
  · gen_icons.py 仍是矢量自绘那套（变体 B/D、石墨档、无底版 app-mark）的真相源，
    想回退自绘方案时重跑它即可；
  · 当前采用源图方案，**打包产物以本脚本为准**。两套写的是同一批文件
    （src-tauri/icons/），谁最后跑谁的产物生效 —— 产物即真相，别混着跑。

产物（全部落在 src-tauri/icons/）：
  icon.ico                                七档 16..256；目录第一档重排为 64
                                          （B221：Tauri 只取第一档做窗口图标，
                                          第二档往后 Windows 按尺寸自己选）
  32x32.png / 128x128.png / 128x128@2x.png    bundle.icon / installer 用
  icon-{32,48,64,128}.rgba                运行时按 DPI 挑档的裸 RGBA（window_icon.rs）
  app-mark.png                            标题栏那颗（B222：与打包图标同源的带底版，
                                          用户拍定标题栏不再用无底版）

用法（venv 解释器）：
  PY=C:/Users/maoyu/.workbuddy/binaries/python/envs/default/Scripts/python.exe
  $PY scripts/make_icons.py
"""

from __future__ import annotations

import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "src-tauri", "icons")
SOURCE = os.path.join(ROOT, "docs", "LitePad.png")

# 复用自绘脚本里的档位定义与 ICO 目录重排 —— 单一真相源，别再抄一份。
sys.path.insert(0, HERE)
from gen_icons import (  # noqa: E402
    APP_MARK_SIZE,
    ICO_FIRST_ENTRY,
    ICO_SIZES,
    SIZES,
    WINDOW_ICON_SIZES,
    reorder_ico_first,
)


def write_all(src: Image.Image) -> None:
    """源图 → 全套产物。唯一允许的像素操作是 `resize(LANCZOS)`。"""
    os.makedirs(OUT_DIR, exist_ok=True)

    # bundle.icon 的三张 png（installer / 快捷方式 / 商店用）
    for name, size in SIZES:
        src.resize((size, size), Image.LANCZOS).save(os.path.join(OUT_DIR, name))
        print(f"  {name}  ({size}x{size})")

    # icon.ico：七档全部**从源图一次 LANCZOS 到位**。
    # ⚠️ 传给 save 的主图必须是源图本身：Pillow 的 ICO _save 拿 `im.size` 当尺寸上限，
    #    主图比某档小，那档会被整条跳过（静默少档、不报错）。源图 512 ≥ 256，安全。
    frames = [src.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    src.save(
        os.path.join(OUT_DIR, "icon.ico"),
        sizes=[(v, v) for v in ICO_SIZES],
        append_images=frames,
    )
    reorder_ico_first(os.path.join(OUT_DIR, "icon.ico"), ICO_FIRST_ENTRY)
    print(f"  icon.ico  ({', '.join(str(v) for v in ICO_SIZES)}，第一档={ICO_FIRST_ENTRY})")

    # 运行时按 DPI 挑档的裸 RGBA（src-tauri/src/window_icon.rs include_bytes 直喂）
    for size in WINDOW_ICON_SIZES:
        raw = src.resize((size, size), Image.LANCZOS).convert("RGBA").tobytes()
        with open(os.path.join(OUT_DIR, f"icon-{size}.rgba"), "wb") as fp:
            fp.write(raw)
        print(f"  icon-{size}.rgba  ({size}x{size} RGBA {len(raw)}B)")

    # 标题栏那颗（B222：与打包图标同源，带底版 —— 用户拍定不再用无底版）
    mark = src.resize((APP_MARK_SIZE, APP_MARK_SIZE), Image.LANCZOS)
    mark.save(os.path.join(OUT_DIR, "app-mark.png"))
    print(f"  app-mark.png  ({APP_MARK_SIZE}x{APP_MARK_SIZE})  ← 标题栏（带底）")


def main() -> None:
    if not os.path.exists(SOURCE):
        raise SystemExit(f"源图不存在：{SOURCE}")
    src = Image.open(SOURCE).convert("RGBA")
    print(f"  源图：docs/LitePad.png  {src.size[0]}x{src.size[1]} {src.mode}")
    write_all(src)


if __name__ == "__main__":
    main()
