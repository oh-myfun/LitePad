/**
 * B369 · 内嵌思源必须**真的**覆盖 `fonts.css` 声称的那几段中文。
 *
 * 病根是「声明」与「文件」脱节：B227 的子集只有 GB2312 一级 3755 个汉字，而等宽汉字层
 * 声明了 `U+4E00-9FFF` 整段 —— 区外字（「龘」「㐀」）逐字回落到微软雅黑，源码模式同一行
 * 中文出现两种字形。所以判据不读文案，直接拆 woff2：
 *   · 解出 cmap，逐码位验扩展 A / 统一表意两段（用户实际会打到的汉字都在这里）；
 *   · 反向对照（emoji / 未分配码位必须不在）防止解析退化成「什么都算有」；
 *   · 新增段必须同时出现在 CSS 的 unicode-range 里 —— 文件里有、声明里没有，浏览器照样回落；
 *   · 度量仍是 B347 那两个 override 的基底（upm 1000 / win 1160+288 / 未开 USE_TYPO_METRICS）。
 */
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { stripCssComments } from "./static";

const FONT = readFileSync("src/assets/fonts/noto-sans-sc-regular.woff2");
const FONTS_CSS = stripCssComments(readFileSync("src/styles/fonts.css", "utf-8"));

/** WOFF2 规范里的已知表标签（flags 低 6 位是它的下标，0x3F 表示标签显式写在目录里）。 */
const KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];

/** WOFF2 目录里的 UIntBase128（1–5 字节，每字节 7 位、高位续位）。 */
function u128(b: Buffer, at: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[at++];
    if (i === 0 && byte === 0x80) throw new Error("非法 UIntBase128");
    v = v * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [v, at];
  }
  throw new Error("非法 UIntBase128");
}

/** 拆出 WOFF2 的各张表（目录 + 解 Brotli 的整段数据流）。 */
function woff2Tables(b: Buffer): Map<string, Buffer> {
  if (b.toString("latin1", 0, 4) !== "wOF2") throw new Error("不是 WOFF2 文件");
  const numTables = b.readUInt16BE(12);
  const totalCompressed = b.readUInt32BE(20);
  let at = 48;
  const dir: Array<{ tag: string; length: number }> = [];
  for (let n = 0; n < numTables; n++) {
    const flags = b[at++];
    const index = flags & 0x3f;
    const transform = flags >> 6;
    let tag: string;
    if (index === 0x3f) {
      tag = b.toString("latin1", at, at + 4);
      at += 4;
    } else tag = KNOWN_TAGS[index];
    const [origLength, next] = u128(b, at);
    at = next;
    let length = origLength;
    // glyf/loca 的 transformVersion 0 = 做过变换，目录里多一个 transformLength
    if ((tag === "glyf" || tag === "loca") && transform === 0) {
      [length, at] = u128(b, at);
    }
    dir.push({ tag, length });
  }
  const raw = brotliDecompressSync(b.subarray(at, at + totalCompressed));
  const out = new Map<string, Buffer>();
  let off = 0;
  for (const e of dir) {
    out.set(e.tag, raw.subarray(off, off + e.length));
    off += e.length;
  }
  return out;
}

/** cmap 里**真正有字形**（gid ≠ 0）的码位集合。只认 format 4 / 12，思源两者都有。 */
function cmapCodepoints(cmap: Buffer): Set<number> {
  const v = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const count = v.getUint16(2);
  const offsets = new Set<number>();
  for (let i = 0; i < count; i++) offsets.add(v.getUint32(4 + i * 8 + 4));
  const cps = new Set<number>();
  for (const off of offsets) {
    const format = v.getUint16(off);
    if (format === 4) {
      const segCount = v.getUint16(off + 6) / 2;
      const endAt = off + 14;
      const startAt = endAt + segCount * 2 + 2; // 中间隔着 reservedPad
      const deltaAt = startAt + segCount * 2;
      const rangeAt = deltaAt + segCount * 2;
      for (let i = 0; i < segCount; i++) {
        const end = v.getUint16(endAt + i * 2);
        const start = v.getUint16(startAt + i * 2);
        const delta = v.getInt16(deltaAt + i * 2);
        const rangeOffset = v.getUint16(rangeAt + i * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid: number;
          if (rangeOffset === 0) gid = (c + delta) & 0xffff;
          else {
            const gidAt = rangeAt + i * 2 + rangeOffset + (c - start) * 2;
            gid = v.getUint16(gidAt);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) cps.add(c);
        }
      }
    } else if (format === 12) {
      const groups = v.getUint32(off + 12);
      for (let i = 0; i < groups; i++) {
        const g = off + 16 + i * 12;
        const start = v.getUint32(g);
        const end = v.getUint32(g + 4);
        const firstGid = v.getUint32(g + 8);
        for (let c = start; c <= end; c++) if (firstGid + (c - start) !== 0) cps.add(c);
      }
    }
  }
  return cps;
}

/** 等宽汉字层那条 `@font-face`（Cascadia Mono + unicode-range）。 */
function cjkLayer(): string {
  const blocks = [...FONTS_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  return (
    blocks.find((b) => /font-family:\s*"Cascadia Mono"/.test(b) && /unicode-range\s*:/.test(b)) ??
    ""
  );
}

/** 从声明块里读出 unicode-range 的区间表。 */
function rangesIn(block: string): Array<[number, number]> {
  const value = block.match(/unicode-range\s*:\s*([^;]+);/)?.[1] ?? "";
  const out: Array<[number, number]> = [];
  for (const m of value.matchAll(/U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/g)) {
    const lo = parseInt(m[1], 16);
    out.push([lo, m[2] ? parseInt(m[2], 16) : lo]);
  }
  return out;
}

const tables = woff2Tables(FONT);
const cps = cmapCodepoints(tables.get("cmap")!);
const declared = rangesIn(cjkLayer());

const view = (tag: string): DataView => {
  const t = tables.get(tag);
  if (!t) throw new Error(`内嵌字体缺 ${tag} 表`);
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
};

describe("B369 · 内嵌思源的全量中文覆盖（按 cmap 实测，不按 CSS 文案）", () => {
  it("解码得出上万码位；反向对照（未收的码位）必须不在", () => {
    expect(cps.size, "旧子集只有 4671 个码位；这条同时兜住「换了别的字体文件」").toBeGreaterThan(
      28000,
    );
    expect(cps.has(0x4e00), "最基本的「一」都没有，说明解包或字体本身坏了").toBe(true);
    // 反向对照：这两条变绿就说明 cmap 解析退化成了「什么都算有」
    expect(cps.has(0x1f600), "emoji 不在 BMP 子集里").toBe(false);
    expect(cps.has(0x0378), "U+0378 是未分配码位，不该有字形").toBe(false);
  });

  it("扩展 A 与统一表意逐码位都有字形（只允许源字体版本解释得了的尾段例外）", () => {
    // 允许缺席的两段（其余任何缺席都算回归）：
    //   · U+4DB6-4DBF：扩展 A 的未分配位，Unicode 本来就没给字；
    //   · U+9FF0-9FFF：Unicode 13/14 新增的 16 个字，本机源字体（NotoSansSC-VF）版本更早。
    // 写成「只允许这两段」而不是「断言它们一定缺」：将来换新源字体补上，这条不会误伤。
    const allowed = (c: number) => (c >= 0x4db6 && c <= 0x4dbf) || (c >= 0x9ff0 && c <= 0x9fff);
    const blocks: Array<[number, number, string]> = [
      [0x3400, 0x4dbf, "CJK 扩展 A"],
      [0x4e00, 0x9fff, "CJK 统一表意"],
    ];
    for (const [lo, hi, name] of blocks) {
      const missing: number[] = [];
      for (let c = lo; c <= hi; c++) if (!cps.has(c) && !allowed(c)) missing.push(c);
      expect(
        missing.length,
        `${name} 有 ${missing.length} 个已分配码位没有字形（首个 U+${missing[0]?.toString(16).toUpperCase()}）`,
      ).toBe(0);
    }
  });

  it("新增的每一段都写进了等宽汉字层的 unicode-range（只进文件不进声明 = 仍然回落）", () => {
    const required: Array<[number, number, string]> = [
      [0x2e80, 0x2eff, "CJK 部首补充"],
      [0x3000, 0x303f, "CJK 标点"],
      [0x3040, 0x30ff, "日文假名"],
      [0x31c0, 0x31ef, "CJK 笔画"],
      [0x3400, 0x4dbf, "CJK 扩展 A"],
      [0x4e00, 0x9fff, "CJK 统一表意"],
      [0xf900, 0xfaff, "CJK 兼容表意"],
      [0xfe10, 0xfe19, "竖排形式"],
      [0xfe30, 0xfe4f, "CJK 兼容形式"],
      [0xff00, 0xffef, "全角形式"],
    ];
    for (const [lo, hi, name] of required) {
      const hit = declared.some(([a, b]) => a <= lo && b >= hi);
      expect(
        hit,
        `${name}（U+${lo.toString(16)}-U+${hi.toString(16)}）没被 unicode-range 覆盖`,
      ).toBe(true);
    }
  });

  it("各段的代表字符都有字形（跨 10 个区间各取一个）", () => {
    const samples: Array<[number, string]> = [
      [0x2e80, "⺀"],
      [0x3002, "。"],
      [0x3042, "あ"],
      [0x30a2, "ア"],
      [0x31c0, "㇀"],
      [0x3400, "㐀"],
      [0x9f98, "龘"],
      [0xf900, "豈"],
      [0xfe10, "︐"],
      [0xfe30, "︰"],
      [0xff0c, "，"],
      [0xff21, "Ａ"],
    ];
    for (const [cp, ch] of samples) {
      expect(cps.has(cp), `「${ch}」U+${cp.toString(16).toUpperCase()} 没有字形`).toBe(true);
    }
  });

  it("度量仍是 B347 那两个 override 的基底", () => {
    expect(view("head").getUint16(18), "unitsPerEm").toBe(1000);
    expect(view("hhea").getInt16(4), "hhea.ascent").toBe(1000);
    expect(view("hhea").getInt16(6), "hhea.descent").toBe(-200);
    expect(view("OS/2").getUint16(74), "usWinAscent").toBe(1160);
    expect(view("OS/2").getUint16(76), "usWinDescent").toBe(288);
    expect(view("OS/2").getInt16(68), "sTypoAscender").toBe(880);
    expect(view("OS/2").getInt16(70), "sTypoDescender").toBe(-120);
    // Chrome 在未开 USE_TYPO_METRICS 时用 win metrics（1.16 + 0.288 ≈ B347 量到的 1.45em 行盒）；
    // 一开就改用 typo 880/120，界面别名那组 110.5%/34.5% 的约束会整体失准。
    expect(view("OS/2").getUint16(62) & (1 << 7), "USE_TYPO_METRICS 必须关着").toBe(0);
  });
});
