// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { edgeEnergy, icoEntries, pngAlpha, pyFnBody, readJson } from "./static";

describe("应用图标（矢量自绘，四角一致）", () => {
  it("B25/B34 应用图标四角圆角必须一致（矢量自绘，非镜像修角）", () => {
    // B25 用户报告：图标下边缘接近直角、上边缘是大圆角。
    // B34 用户要求：改名 LitePad 并重绘图标，背景四角全部圆角。
    // 修复：scripts/gen_icons.py 改为矢量自绘——圆角矩形 rounded_rectangle
    // 一次成型（四角半径天然一致），不再依赖 AI 源图与镜像修角。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");
    expect(gen, "必须用 rounded_rectangle 保证四角圆角一致").toMatch(/rounded_rectangle\(/);
    expect(gen, "背景必须是渐变（蓝→青）").toMatch(
      /2563EB[\s\S]{0,600}06B6D4|06B6D4[\s\S]{0,600}2563EB/,
    );
    expect(gen, "不得再依赖 AI 源图（B25 镜像方案已废弃）").not.toContain("icon_final.png");
    expect(gen, "ico 必须包含多尺寸（任务栏/资源管理器清晰）").toMatch(/ICO_SIZES/);
    const conf = readJson("src-tauri/tauri.conf.json");
    const icons: string[] = conf.bundle?.icon ?? [];
    expect(
      icons.some((i) => i.includes("icon.ico")),
      "bundle.icon 必须含 icon.ico（exe/安装包图标来源）",
    ).toBe(true);
  });
  it("B43 折角文档不得带投影，钢笔需缩短且笔尖收进文档中部（不再顶角）", () => {
    // B43 用户反馈：① 钢笔太长；② 笔尖不要顶到文档角落，落在「中间靠下」即可；
    //              ③ 去掉折角文档的投影（折角处与下面两个圆角处能看到阴影）。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");

    // ① 文档投影必须关闭（保留开关常量，便于日后回退）
    expect(gen, "方案 B 必须关闭文档投影").toMatch(/B_CARD_SHADOW\s*=\s*False/);

    // ② 钢笔必须明显短于 B41 那版（0.78）
    const lenRaw = gen.match(/B_PEN_LENGTH\s*=\s*([\d.]+)/)?.[1];
    expect(lenRaw, "缺少 B_PEN_LENGTH 常量").toBeTruthy();
    const len = Number(lenRaw);
    expect(len, "钢笔应明显短于原 0.78").toBeLessThanOrEqual(0.66);
    expect(len, "钢笔也不该短到失去比例").toBeGreaterThanOrEqual(0.5);

    // ③ 笔尖落点 = 中心 + (长度/2)·(-0.707, +0.707)，必须收在文档内、且在中线以下
    const cRaw = gen.match(/B_PEN_CENTER\s*=\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
    const cardRaw = gen.match(
      /B_CARD\s*=\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/,
    );
    expect(cRaw, "缺少 B_PEN_CENTER").toBeTruthy();
    expect(cardRaw, "缺少 B_CARD").toBeTruthy();

    const cx = Number(cRaw![1]);
    const cy = Number(cRaw![2]);
    const [x0, y0, x1, y1] = cardRaw!.slice(1, 5).map(Number);
    const k = (len / 2) * 0.7071067811865476; // 135° 对角线的单位分量
    const tipX = cx - k;
    const tipY = cy + k;

    expect(tipX, "笔尖不得再顶到文档左边缘").toBeGreaterThan(x0 + 0.08);
    expect(tipY, "笔尖不得再顶到文档下边缘").toBeLessThan(y1 - 0.08);
    expect(tipY, "笔尖应落在文档水平中线以下（中间靠下）").toBeGreaterThan((y0 + y1) / 2);
    expect(Math.abs(tipX - (x0 + x1) / 2), "笔尖不应偏离文档竖直中线过远").toBeLessThan(0.12);
  });

  it("B221 任务栏发糊的修法：ico 小档不许二次缩放、必须锐化", () => {
    // 用户报告：Windows 任务栏上 LitePad 那颗图标太模糊。
    // 定位于 scripts/gen_icons.py 的 ico 生成：原先是 母版(1024) → 缩到 256 → 再缩到
    // 16/24/32/48/64，两道缩放把边抹平了；而任务栏/资源管理器吃的正是 ≤64 那几档
    // （exe 图标来自 build.rs 生成的 resource.rc 里的 `32512 ICON ...icon.ico`）。
    // 改法：每档从母版一次 LANCZOS 到位 + 小档叠轻度 UnsharpMask；
    // 实测 32px 锐度 14.5 → 18.9（+30%），48px 10.0 → 13.6，64px 8.0 → 10.5。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");
    const framesBody = pyFnBody(gen, "ico_frames");
    const iconsBody = pyFnBody(gen, "write_icons");

    // ⚠️ 反例必须排在正向断言**之前**：退化时被正向断言抢先报错，这条反向闸等于没验过。
    expect(
      framesBody,
      "ICO 小档不许再从 256 那张中间图二次缩放（B221 任务栏发糊的直接根因）",
    ).not.toMatch(/resize\(\(\s*256\s*,/);
    expect(framesBody, "不许让 Pillow 从主图 thumbnail 兜底（那等于又走一遍缩放）").not.toMatch(
      /thumbnail\(/,
    );
    expect(iconsBody, "write_icons 不许再出现「先缩 256，再存 icon.ico」的旧写法").not.toMatch(
      /resize\(\(\s*256\s*,\s*256\s*\)[\s\S]{0,220}?icon\.ico/,
    );
    expect(framesBody, "每一档都要从母版 img 一次到位").toMatch(/img\.resize\(\(size,\s*size\)/);
    expect(framesBody, "小档要过锐化，且只在小档上做").toMatch(/if\s+size\s*<=\s*ICO_SHARPEN_MAX/);
    expect(framesBody, "锐化必须落到帧上").toMatch(/sharpen_small\(frame\)/);
    expect(gen, "锐化开关闭上限在 64").toMatch(/ICO_SHARPEN_MAX\s*=\s*64/);
    expect(gen, "必须用 UnsharpMask").toMatch(/ImageFilter\.UnsharpMask\(/);
    expect(iconsBody, "ICO 的 append_images 必须直接喂 ico_frames 的逐档结果").toMatch(
      /append_images=ico_frames\(img\)/,
    );
    // 主图必须是母版本身：Pillow 的 ICO _save 拿 `im.size` 当尺寸上限，
    // 主图要是 16 那档，所有 >16 的档会被整条跳过（静默少档、不报错）。
    expect(iconsBody, "传给 ICO 的主图必须是母版 img").toMatch(/^ {4}img\.save\(/m);
  });

  it("B221 产物侧：已出包的 icon.ico 小档锐度必须高于二次缩放那版", () => {
    // 源码侧对了、但忘了重跑 gen_icons.py 更新 icon.ico —— 任务栏照样是糊的，
    // 所以这一半必须落在**实际产物**上（src-tauri/icons/icon.ico 是入库的真身）。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");
    const declared = (gen.match(/ICO_SIZES\s*=\s*\[([^\]]+)\]/)?.[1] ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const entries = icoEntries(readFileSync("src-tauri/icons/icon.ico"));
    expect(entries.length, "ICO 档位必须齐全").toBe(declared.length);
    expect(entries.map((e) => e.size).sort((a, b) => a - b)).toEqual(declared);
    expect(
      entries.every((e) => e.bpp === 32),
      "每档都必须是 32bpp",
    ).toBe(true);

    const energy = new Map<number, number>();
    for (const e of entries) energy.set(e.size, edgeEnergy(pngAlpha(e.payload)));

    // ⚠️ 反例前置：解码器要是恒 0 / 恒返回同一个数，下面几条阈值断言会全绿（假绿）。
    // 「小档必须比 128 档锐得多」这条恒真关系既当对照组，也顺带证明解码器在动。
    expect(energy.get(32)!, "32px 档必须有内容（解码器 sanity）").toBeGreaterThan(0);
    expect(energy.get(128)!, "对照组：128 是平滑大图，锐度必然低于小档").toBeLessThan(
      energy.get(32)!,
    );
    expect(energy.get(32)!, "32px 锐度（二次缩放那版只有 14.5）").toBeGreaterThan(17);
    expect(energy.get(48)!, "48px 锐度（二次缩放那版只有 10.0）").toBeGreaterThan(12.5);
    expect(energy.get(64)!, "64px 锐度（二次缩放那版只有 8.0）").toBeGreaterThan(9.5);
  });
});
