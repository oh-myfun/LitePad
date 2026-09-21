// @vitest-environment jsdom
// B50：**启动链路** —— 不得露出白色窗口（用户反馈打开时先白屏一下）、
// 会话恢复必须并行读盘（逐个 await 会让启动时间随标签数线性增长）。
//
// 两处都只在启动阶段生效，运行时测不到，用源码文本断言守住。
// 从 `tests/regressions.test.ts` 按模块拆出（09-22）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readJson, themeBlock } from "./static";

describe("B50 会话恢复必须并行读盘（而不是逐个 await）", () => {
  // 原先 restoreSession 对每个标签 `await openFile(...)`，N 个文件就是 N 次串行
  // 往返（读盘 + 编码检测），总耗时是各次之和；并行后总耗时≈最慢的那一次。
  // B68 起预取里多了「先问副本」这一步，但仍然是同一个 Promise.all 扇出。
  it("restoreSession 内必须先把文件并行预取好，再按序组装标签", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    const start = src.indexOf("async function restoreSession");
    expect(start, "必须能定位 restoreSession").toBeGreaterThan(-1);
    const body = src.slice(start, start + 8000);
    expect(body, "必须并行预取（Promise.all）").toContain("Promise.all");
    expect(body, "必须有预取缓存 restoredCache").toContain("restoredCache");
    expect(body, "组装阶段应读缓存而不是再读盘").toContain("restoredCache.get(");
    expect(body, "组装循环里不得再逐个 await openFile（那是串行的老写法）").not.toMatch(
      /const file = await openFile\(/,
    );
    // B68：预取必须是「副本优先、文件兜底」——先 restoreBackup，拿不到才 openFile
    expect(body, "副本必须先问，原文件作为兜底").toMatch(
      /await restoreBackup\([\s\S]*?await openFile\(/,
    );
  });
});

describe("B50 启动不得露出白色窗口（用户反馈：打开时先白屏一下）", () => {
  // 用户报告：exe 打开时会先白屏一下。根因是 WebView2 渲染出第一帧之前的那段时间
  // 窗口内容由 Chromium 用纯白填充，而前端要走完 `await loadSettings()`
  // → `await restoreSession()` 才有东西可画。
  //
  // 修法分两层：
  //   1) Rust 侧把 WebView2 的「预渲染底色」刷成界面背景色（set_background_color）；
  //   2) index.html 内联样式+脚本，让 HTML 的第一帧也是主题色。
  //
  // ⚠️ 为什么不用「visible:false + 前端就绪后 show()」：那样窗口是否出现完全
  //    取决于前端能否跑完 bootstrap。实测出现过「IPC 正常、界面却始终画不出来」
  //    的情况（WebView2 用户数据目录损坏就会这样），此时用户就是「点了图标
  //    什么都没有」，比白屏严重得多。下面两条断言就是防止这个方案复活。
  it("主窗口不得配 visible:false（前端一旦卡住用户将看不到任何窗口）", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = conf.app?.windows?.find((w: { label?: string }) => w.label === "main");
    expect(win, "必须能找到 label=main 的主窗口配置").toBeTruthy();
    expect(
      "visible" in win,
      "visible:false 会让窗口出现与否依赖前端 bootstrap，前端卡住时用户什么都看不到",
    ).toBe(false);
  });

  it("Rust 侧必须在 setup 阶段把窗口底色刷成主题色", () => {
    const src = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(src, "main.rs 必须在 setup 里取主窗口").toMatch(/get_webview_window\("main"\)/);
    expect(src, "必须调用 set_background_color 清掉白色预渲染底色").toContain(
      "set_background_color",
    );
    // 主题三态：dark / light 走设置，system 问系统
    expect(src, "必须定义深浅两套底色常量").toMatch(/const BG_DARK: Color/);
    expect(src, "必须定义深浅两套底色常量").toMatch(/const BG_LIGHT: Color/);
    expect(src, "system 模式必须跟随系统主题").toMatch(/win\.theme\(\)/);
  });

  it("四处底色必须一致：tauri.conf.json / main.rs / global.css / index.html", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = conf.app?.windows?.find((w: { label?: string }) => w.label === "main");
    const rust = readFileSync("src-tauri/src/main.rs", "utf-8");
    const css = readFileSync("src/styles/global.css", "utf-8");
    const html = readFileSync("index.html", "utf-8");

    const confBg = String(win.backgroundColor ?? "")
      .replace("#", "")
      .toLowerCase();
    expect(confBg, "tauri.conf.json 必须给出 backgroundColor").toMatch(/^[0-9a-f]{6}$/);

    // main.rs: const BG_DARK: Color = Color(0x1b, 0x1d, 0x1f, 0xff);
    const m = rust.match(/const BG_DARK: Color = Color\(([^)]*)\)/);
    expect(m, "main.rs 必须能解析出 BG_DARK 的 RGB").toBeTruthy();
    const [r, g, b] = (m?.[1] ?? "").split(",").map((s) => Number.parseInt(s.trim(), 16));
    const rustDark = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");

    expect(rustDark, "main.rs 的 BG_DARK 必须与 tauri.conf.json 的 backgroundColor 一致").toBe(
      confBg,
    );

    // global.css: :root[data-theme="dark"] { --bg: #1b1d1f; }
    // 必须在**深色块体内**取 --bg：原先用 `[data-theme="dark"][\s\S]*?--bg:` 是非贪婪
    // 跨块匹配，深色块一旦丢了 --bg 就会一路扫进浅色块、拿浅色的值来比对（假绿）。
    const cssDark = /--bg:\s*#([0-9a-fA-F]{6})/.exec(themeBlock(css, "dark"));
    expect(cssDark?.[1]?.toLowerCase(), "global.css 深色 --bg 必须同上").toBe(confBg);

    // index.html 内联首屏样式必须同时覆盖深/浅两套
    expect(html, "index.html 必须有内联首屏底色").toContain("background: #ffffff");
    expect(html, "index.html 必须给出深色首屏底色").toContain(`background: #${confBg}`);
  });

  it("index.html 必须在模块脚本之前同步定好 data-theme", () => {
    const html = readFileSync("index.html", "utf-8");
    const style = html.indexOf("<style>");
    const mod = html.indexOf('type="module"');
    expect(style, "必须有内联 <style>").toBeGreaterThan(-1);
    expect(style, "内联样式必须排在模块脚本之前才生效").toBeLessThan(mod);
    expect(html, "必须同步读 localStorage 里的主题镜像").toContain(
      'localStorage.getItem("litepad.theme")',
    );
    expect(html, "必须在首帧前设置 data-theme").toContain('setAttribute("data-theme"');
    expect(html, "缺失镜像时要用 prefers-color-scheme 兜底").toContain("prefers-color-scheme");
  });

  it("前端必须回报启动各阶段耗时（便于定位慢在哪一段）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须有 reportBoot 上报入口").toContain("function reportBoot");
    // 至少三处：定义 + 外壳就绪 + 全部就绪；任一被删都会丢失诊断
    const calls = src.match(/reportBoot\(/g) ?? [];
    expect(
      calls.length,
      "reportBoot 应在 bootstrap 中被调用（外壳 + 就绪）",
    ).toBeGreaterThanOrEqual(3);
  });
});
