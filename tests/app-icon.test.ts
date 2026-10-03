// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
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

  it("B221 真根因：ico 第一档必须给窗口图标用，不能是小尺寸", () => {
    // ⚠️ 这才是「任务栏图标糊」的真正来源，前面两条都只是把图本身画实：
    // Tauri 在 Windows 上把窗口图标嵌进二进制时**只取 ICO 的第一档**
    // （tauri-codegen/src/image.rs 的 new_ico：`&icon_dir.entries()[0]`），
    // 解码成 RGBA 交给 tao 生成一个 HICON（WM_SETICON）。
    // **任务栏 / Alt+Tab 显示的是这个 HICON** —— 第一档是 16 的话，任务栏要 32/40/48
    // 就只能把 16 放大 2~3 倍。所以改其他档的锐度，任务栏**毫无反应**（用户实测如此）。
    // 实测指纹：构建 out 目录里被 include_bytes 的那份图标是 1024 字节 = 16×16×4。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");
    const iconsBody = pyFnBody(gen, "write_icons");

    // ⚠️ 反例前置：Pillow 的 ICO 目录恒按尺寸升序写，第一档天然是 16 ——
    //    不重排就等于把 16 交给任务栏去放大。
    expect(iconsBody, "write_icons 必须调用目录重排（Pillow 写完第一档是 16）").toMatch(
      /reorder_ico_first\(/,
    );
    expect(gen, "第一档要定在 64（任务栏最大物理尺寸）").toMatch(/ICO_FIRST_ENTRY\s*=\s*64/);

    const entries = icoEntries(readFileSync("src-tauri/icons/icon.ico"));
    expect(
      entries[0].size,
      "产物第一档不能是小尺寸：Tauri 只取它做窗口图标，小了任务栏就是放大显示",
    ).not.toBeLessThan(64);
    expect(entries[0].size, "第一档应正好是 ICO_FIRST_ENTRY").toBe(64);
    // 重排只许换顺序，不许弄丢档位（目录项 16 字节，载荷偏移不动）
    expect(new Set(entries.map((e) => e.size)).size, "重排后档位不许重复/丢失").toBe(
      entries.length,
    );
  });

  it("B221：窗口图标按显示缩放挑档（不赌某一个缩放）", () => {
    // 单靠 ICO 只能给 Windows 一个 HICON，任何缩放都基于它缩放 —— 做不到「各种缩放都最优」。
    // 所以运行时按 scale_factor 挑：100%/125%/150%/200% 分别要 32/40/48/64，
    // 取**不小于目标的最小档** ⇒ 系统只会缩小、绝不放大。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");
    const rs = readFileSync("src-tauri/src/window_icon.rs", "utf-8");
    const main = readFileSync("src-tauri/src/main.rs", "utf-8");
    const sat = readFileSync("src-tauri/src/windows.rs", "utf-8");

    // ⚠️ 反例前置：只生成一档 / 只 include 一档 ⇒ 又退化成「一张图打天下」
    expect(rs, "四档都要 include，缺一档就没得挑").toMatch(
      /include_bytes!\("\.\.\/icons\/icon-32\.rgba"\)[\s\S]*include_bytes!\("\.\.\/icons\/icon-48\.rgba"\)[\s\S]*include_bytes!\("\.\.\/icons\/icon-64\.rgba"\)[\s\S]*include_bytes!\("\.\.\/icons\/icon-128\.rgba"\)/,
    );
    for (const size of [32, 48, 64, 128]) {
      expect(
        statSync(`src-tauri/icons/icon-${size}.rgba`).size,
        `icon-${size}.rgba 必须是裸 RGBA（边长²×4）`,
      ).toBe(size * size * 4);
    }
    // 选档必须是「不小于目标的最小档」—— 写成 < 32 就会拿小图去放大
    expect(rs, "选档判据要落在目标尺寸上").toMatch(/target\s*<=\s*32\.0/);
    expect(rs, "48 那档也要有判据").toMatch(/target\s*<=\s*48\.0/);
    expect(rs, "64 那档也要有判据（200% 缩放要 64）").toMatch(/target\s*<=\s*64\.0/);
    expect(gen, "档位由 gen_icons 出，不许手抄").toMatch(/WINDOW_ICON_SIZES/);
    expect(gen).toMatch(/write_window_icon_frames/);

    // 三个调用点：主窗口启动、缩放变化、卫星窗口
    expect(main, "主窗口启动时按当前缩放设一次").toMatch(/set_icon\(window_icon::pick\(/);
    expect(main, "缩放变化要重挑（否则任务栏继续用旧倍率那档）").toMatch(
      /ScaleFactorChanged[\s\S]{0,160}?window_icon::pick\(\*scale_factor\)/,
    );
    expect(sat, "卫星窗口也要设（它同样占任务栏一格）").toMatch(
      /set_icon\(crate::window_icon::pick\(/,
    );
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
    // ⚠️ 锐度阈值是**跟着源图走的**，换源图必须重测重定（换完跑 .tmp 里的实测脚本）：
    //   · 自绘折角文档时代（石墨底白纸，锐化过）：32/48/64 = 18.9/13.6/10.5，阈值 17/12.5/9.5；
    //   · B222 换羽毛图后实测 12.01/9.74/8.73（LANCZOS 直出，不锐化），阈值整体下移。
    // 还要注意：羽毛图对「二次缩放」几乎不敏感（直出 12.01 vs 256 中转 12.00），
    // 这组阈值**防不了**二次缩放退化 —— 那条判据改锁 make_icons.py 的源码（见 B222 用例）。
    expect(energy.get(32)!, "32px 锐度（羽毛图直出 12.01）").toBeGreaterThan(11);
    expect(energy.get(48)!, "48px 锐度（羽毛图直出 9.74）").toBeGreaterThan(9);
    expect(energy.get(64)!, "64px 锐度（羽毛图直出 8.73）").toBeGreaterThan(8);
  });

  it("B222：图标源 = docs/LitePad.png，make_icons.py 只做缩放与格式转换", () => {
    // 用户拍定：图标内容以 docs/LitePad.png（512×512 深色圆角方块底 + 白色羽毛）为准，
    // **不改内容** —— 不重绘、不锐化、不加底。gen_icons.py（矢量自绘）保留但不再是产物来源。
    const make = readFileSync("scripts/make_icons.py", "utf-8");

    // ⚠️ 反例前置：脚本里只要出现绘制类调用，就说明有人开始「改内容」了 ——
    // 那是 gen_icons.py 的职责，这条链要永远保持「像素搬运工」。
    expect(make, "不许出现绘制调用（改内容就走样了）").not.toMatch(
      /ImageDraw|rounded_rectangle|UnsharpMask|sharpen_small|ImageChops/,
    );
    // 每档都必须从源图直出：中途缩到 256 再往下缩就是二次缩放（B221 的老毛病）
    expect(make, "不许出现中间尺寸缩放").not.toMatch(/resize\(\(\s*256\s*,/);
    // 逐档从 src 一次 LANCZOS 到位（ICO / rgba / png 三条产物线都是）
    expect(make, "必须从源图直出各档").toMatch(/src\.resize\(/);
    expect(make, "ICO 目录要重排（第一档 64，Tauri 只取第一档当窗口图标）").toMatch(
      /reorder_ico_first\(/,
    );
    expect(make, "必须复用 gen_icons 的档位定义（单一真相源）").toMatch(
      /from\s+gen_icons\s+import/,
    );
    expect(make, "rgba 档位也要出（运行时按 DPI 挑）").toMatch(/WINDOW_ICON_SIZES/);
    expect(make, "标题栏那颗也要出（B222 带底版）").toMatch(/app-mark\.png/);

    // 源图本体必须入库（脚本可复现的前提）
    expect(statSync("docs/LitePad.png").size, "源图必须入库，否则脚本跑不起来").toBeGreaterThan(0);

    // 产物侧：标题栏那颗必须真的是源图缩出来的（带底），而不是旧自绘图残留在盘上。
    // 判据：app-mark 与 128x128.png 同为源图直出 —— 四边中点都应落在深色底内（非透明）。
    // （结构性的七档 / 第一档断言在上面 B221 两条里，这里不重复。）
    const mark = pngAlpha(readFileSync("src-tauri/icons/app-mark.png"));
    expect(mark.at(2, Math.floor(mark.height / 2)), "app-mark 左边中点应是带底的").toBe(255);
  });
});
