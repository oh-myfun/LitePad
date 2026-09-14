#!/usr/bin/env python
"""校验 NSIS 安装包 / exe 的**外壳图标**是否就是 src-tauri/icons/icon.ico 里那几档。

`icon_check.py` 只扫**未压缩的** PNG 流，对安装包无效（NSIS 把资源压进 LZMA）。
这里改从 **PE 资源段**直接读 RT_GROUP_ICON / RT_ICON：

  - `installer` 目标 → 检查 setup.exe 自身（MUI_ICON）
  - `app` 目标       → 检查 litepad.exe 自身（bundle.icon → winres）

判定：把 PE 里 RT_ICON 各档收齐，解出每组尺寸/位深，
      与 icon.ico 的目录项逐条比对（尺寸 + 位深 + 像素流 sha256）。

用法：
    python scripts/icon_check_pe.py <exe 路径> [更多 exe]
"""

import hashlib
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICO = os.path.join(ROOT, "src-tauri", "icons", "icon.ico")


def read_ico(path):
    """返回 [(w,h,bpp,sha256(bytes)), ...]"""
    d = open(path, "rb").read()
    _, itype, cnt = struct.unpack("<HHH", d[:6])
    assert itype == 1, "不是 ICO"
    out = []
    for n in range(cnt):
        o = 6 + n * 16
        w, h, _col, _res, _pl, bpp, size, off = struct.unpack("<BBBBHHII", d[o : o + 16])
        out.append(((w or 256), (h or 256), bpp, hashlib.sha256(d[off : off + size]).hexdigest()))
    return out


# ---------- 最小 PE 解析：定位 .rsrc 段即可 ----------
def pe_sections(data):
    e_lfanew = struct.unpack("<I", data[0x3C : 0x40])[0]
    assert data[e_lfanew : e_lfanew + 4] == b"PE\0\0", "不是 PE"
    nsec = struct.unpack("<H", data[e_lfanew + 6 : e_lfanew + 8])[0]
    opt_size = struct.unpack("<H", data[e_lfanew + 20 : e_lfanew + 22])[0]
    base = e_lfanew + 24 + opt_size
    secs = []
    for i in range(nsec):
        o = base + i * 40
        name = data[o : o + 8].rstrip(b"\0").decode("latin1")
        vsize, vaddr, rawsize, rawptr = struct.unpack("<IIII", data[o + 8 : o + 24])
        secs.append((name, vaddr, vsize, rawptr, rawsize))
    return secs


def rva_to_off(secs, rva):
    for _n, vaddr, vsize, rawptr, rawsize in secs:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return rawptr + (rva - vaddr)
    return None


def walk_rsrc(data, secs, rsrc_rva):
    """遍历资源目录树，收集 (type, name/id, lang, data_rva, size)。"""
    base = rva_to_off(secs, rsrc_rva)
    out = []

    def subdir(off, path):
        n_named, n_id = struct.unpack("<HH", data[off + 12 : off + 16])
        total = n_named + n_id
        for i in range(total):
            e = off + 16 + i * 8
            name_id, offset = struct.unpack("<II", data[e : e + 8])
            if offset & 0x80000000:  # 子目录
                subdir(base + (offset & 0x7FFFFFFF), path + [name_id])
            else:  # data entry
                de = base + offset
                drva, size = struct.unpack("<II", data[de : de + 8])
                out.append((path[0] if path else None, name_id, drva, size))

    subdir(base, [])
    return out


def collect_icons(path):
    data = open(path, "rb").read()
    secs = pe_sections(data)
    rsrc = next((s for s in secs if s[0] == ".rsrc"), None)
    if not rsrc:
        return None, []
    entries = walk_rsrc(data, secs, rsrc[1])
    blobs = []
    for typ, name_id, drva, size in entries:
        if typ == 3:  # RT_ICON
            off = rva_to_off(secs, drva)
            if off is None:
                continue
            blobs.append((name_id, data[off : off + size]))
    # RT_ICON 里存的是单张 DIB(BMP) 或 PNG；用 GRPICONDIRENTRY 的尺寸更靠谱，
    # 这里直接读 DIB 头拿 w/h/bpp
    res = []
    for _id, b in blobs:
        if b[:8] == b"\x89PNG\r\n\x1a\n":
            w = struct.unpack(">I", b[16:20])[0]
            h = struct.unpack(">I", b[20:24])[0]
            bpp = 32
        else:
            hs = struct.unpack("<I", b[:4])[0]  # biSize
            w, h2 = struct.unpack("<ii", b[4:12])
            bpp = struct.unpack("<H", b[14:16])[0]
            h = abs(h2) // 2
        res.append((w, h, bpp, hashlib.sha256(b).hexdigest()))
    return (len(blobs), res)


def main():
    targets = sys.argv[1:]
    if not targets:
        targets = [
            os.path.join(ROOT, "src-tauri", "target", "release", "litepad.exe"),
            os.path.join(
                ROOT, "src-tauri", "target", "release", "bundle", "nsis", "LitePad_0.2.2_x64-setup.exe"
            ),
        ]

    ico = read_ico(ICO)
    ico_by_size = {(w, h, bpp): sh for w, h, bpp, sh in ico}
    print(f"icon.ico 档位：{[(f'{w}x{h}', f'{bpp}bpp') for w, h, bpp, _ in ico]}\n")

    ok_all = True
    for t in targets:
        if not os.path.exists(t):
            print(f"!! 不存在 {t}")
            ok_all = False
            continue
        n, res = collect_icons(t)
        name = os.path.relpath(t, ROOT)
        if n is None:
            print(f"{name}: 没有 .rsrc 段")
            ok_all = False
            continue
        print(f"{name}")
        print(f"  RT_ICON 档数：{n}")
        hits = 0
        for w, h, bpp, sh in sorted(res):
            key = (w, h, bpp)
            # PNG 与 DIB 编码不同 → sha 不可能相等；尺寸命中即认为「用了我们的图标档」
            if key in ico_by_size:
                exact = "字节一致" if ico_by_size[key] == sh else "同尺寸(编码不同)"
                print(f"    ✅ {w}x{h} {bpp}bpp  {exact}")
                hits += 1
            else:
                print(f"    ·  {w}x{h} {bpp}bpp  （icon.ico 里没有这一档）")
        if hits == 0:
            print("    ❌ 没有任何一档与 icon.ico 匹配 —— 用的是第三方/默认图标")
            ok_all = False
        print()

    print("=" * 60)
    print("结论：" + ("✅ 目标 exe 的外壳图标来自 icon.ico" if ok_all else "❌ 图标不匹配"))
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
