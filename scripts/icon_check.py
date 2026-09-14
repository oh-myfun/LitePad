#!/usr/bin/env python
"""校验 exe / 安装包里嵌的图标是否与 src-tauri/icons/icon.ico 逐字节一致。

用法：
    python scripts/icon_check.py [exe 路径 ...]
默认检查：
    src-tauri/target/release/litepad.exe
    src-tauri/target/release/bundle/nsis/*.exe （最新的一个）

原理：PNG 文件从签名 \\x89PNG\\r\\n\\x1a\\n 起，到 IEND chunk 结束。
把每个 PNG 整个 chunk 流切出来做 sha256，与 icon.ico 各档解出的 PNG 比对。
"""

import glob
import hashlib
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICO = os.path.join(ROOT, "src-tauri", "icons", "icon.ico")

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def png_slices(data: bytes):
    """从任意二进制里切出所有完整 PNG（含 IEND）。返回 [(offset, bytes)]。"""
    out = []
    i = 0
    while True:
        i = data.find(PNG_SIG, i)
        if i < 0:
            break
        # 逐 chunk 走到 IEND
        p = i + len(PNG_SIG)
        ok = True
        while p + 8 <= len(data):
            (length,) = struct.unpack(">I", data[p : p + 4])
            ctype = data[p + 4 : p + 8]
            end = p + 8 + length + 4
            if end > len(data):
                ok = False
                break
            p = end
            if ctype == b"IEND":
                break
        if ok:
            out.append((i, data[i:p]))
        i += len(PNG_SIG)
    return out


def ico_pngs(path: str):
    """从 .ico 里抽出所有 PNG 档（现代 ico 内嵌 PNG）。返回 dict[size_key] = png bytes。"""
    with open(path, "rb") as f:
        data = f.read()
    reserved, itype, count = struct.unpack("<HHH", data[:6])
    assert reserved == 0 and itype == 1, "不是合法 ico"
    res = {}
    for n in range(count):
        off = 6 + n * 16
        w, h, colors, _, planes, bpp, size, offset = struct.unpack(
            "<BBBBHHII", data[off : off + 16]
        )
        blob = data[offset : offset + size]
        key = f"{w or 256}x{h or 256}@{bpp}bpp"
        if blob.startswith(PNG_SIG):
            res[key] = blob
    return res


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main():
    targets = sys.argv[1:]
    if not targets:
        default_exe = os.path.join(ROOT, "src-tauri", "target", "release", "litepad.exe")
        if os.path.exists(default_exe):
            targets.append(default_exe)
        nsis = sorted(
            glob.glob(os.path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis", "*.exe")),
            key=os.path.getmtime,
        )
        if nsis:
            targets.append(nsis[-1])

    ico = ico_pngs(ICO)
    ico_by_hash = {sha(v): k for k, v in ico.items()}
    print(f"icon.ico: {ICO}")
    print(f"  内嵌 PNG 档位 ({len(ico)}):")
    for k, v in sorted(ico.items()):
        print(f"    {k:>16}  {len(v):>7} B  sha256={sha(v)[:16]}…")
    print()

    all_ok = True
    for t in targets:
        if not os.path.exists(t):
            print(f"!! 不存在: {t}")
            all_ok = False
            continue
        with open(t, "rb") as f:
            data = f.read()
        found = png_slices(data)
        matched, suspect = [], []
        for off, blob in found:
            h = sha(blob)
            if h in ico_by_hash:
                matched.append((off, ico_by_hash[h], len(blob)))
            # 只看和我们图标尺寸档位相近的（ICO 里的档），其余是无关的内嵌图
            elif len(blob) in (len(v) for v in ico.values()):
                suspect.append((off, len(blob), h))
        print(f"{os.path.relpath(t, ROOT)}  ({len(data)} B)")
        print(f"  切出完整 PNG: {len(found)} 个")
        if matched:
            for off, key, ln in matched:
                print(f"    ✅ 命中 icon.ico[{key}]  @0x{off:x}  {ln} B")
        else:
            print("    ❌ 没有任何一个 PNG 与 icon.ico 匹配 —— 图标是旧的/没嵌进去")
            all_ok = False
        if suspect:
            for off, ln, h in suspect:
                print(f"    ⚠️ 大小相同但哈希不同 @0x{off:x} {ln} B sha256={h[:16]}…（疑似旧图标）")
        print()

    # 顺带报告 exe 的 winres 资源里 ICON 组声明的尺寸
    print("=" * 60)
    print("结论：" + ("✅ 图标已正确嵌入" if all_ok else "❌ 图标不一致，需要重建"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
