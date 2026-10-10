// @vitest-environment jsdom
// B97 自建标题栏（参考 VS Code）的契约测试。
//
// 这一版把窗口的**原生边框整个去掉了**（tauri.conf.json 的 decorations:false），
// 于是「窗口怎么拖、怎么关、标题显示在哪」全部改由界面自建。这类改动最容易出的
// 事故是**只改了一半**：
//   · 去了原生边框却没给窗口控制键 → 窗口关不掉（只能 Alt+F4）；
//   · 拖动区没授权 `core:window:allow-start-dragging` → 标题栏按住拖不动（ACL 静默拒绝）；
//   · 只改了主窗口、忘了卫星窗口 → 卫星窗口顶着两条标题栏。
// 所以这里逐条钉住：配置、HTML 结构、样式、权限、接线，缺一根都算红。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripCssComments, ruleBlock, pngAlpha, topLevelFnBody } from "./static";

const tauriConf = (): string => readFileSync("src-tauri/tauri.conf.json", "utf-8");
const indexHtml = (): string => readFileSync("index.html", "utf-8");
const mainSrc = (): string => readFileSync("src/main.ts", "utf-8");
// 只拿**规则**文本：删样式时留的说明注释不算样式，见 stripCssComments 的说明。
const css = (): string => stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
const menuSrc = (): string => readFileSync("src/shell/menubar.ts", "utf-8");
const menuLib = (): string => readFileSync("src/shell/menu.ts", "utf-8");
const capabilities = (): string => readFileSync("src-tauri/capabilities/default.json", "utf-8");
const windowsRs = (): string => readFileSync("src-tauri/src/windows.rs", "utf-8");

describe("B97 自建标题栏", () => {
  it("主窗口必须去掉原生边框，否则会出现「两条标题栏」", () => {
    const conf = JSON.parse(tauriConf()) as {
      app: { windows: { label: string; decorations?: boolean }[] };
    };
    const main = conf.app.windows.find((w) => w.label === "main");
    expect(main, "配置里应有 main 窗口").toBeTruthy();
    expect(main!.decorations, "主窗口必须 decorations:false（自建标题栏）").toBe(false);
  });

  it("卫星窗口必须同步去掉原生边框（WebviewWindowBuilder 不继承主窗口配置）", () => {
    const rs = windowsRs();
    const build = rs.slice(rs.indexOf("fn build_satellite"));
    expect(build, "取不到 build_satellite").toBeTruthy();
    expect(
      build,
      "卫星窗口建窗时必须显式 .decorations(false) —— 它加载同一个 index.html，" +
        "自建标题栏会一起画出来，留着原生标题栏就是两条叠着",
    ).toContain(".decorations(false)");
  });

  it("拖动区、最小化、最大化必须逐条授权（漏了 start-dragging 表现是「拖不动」）", () => {
    const caps = JSON.parse(capabilities()) as { permissions: string[] };
    for (const p of [
      // Tauri 内置 drag.js 在按住拖动区时调 start_dragging；这条**不在 core:window:default 里**
      "core:window:allow-start-dragging",
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
    ]) {
      expect(caps.permissions, `权限集缺 ${p}`).toContain(p);
    }
    // 卫星窗口也要能拖：通配必须还在
    const raw = capabilities();
    expect(raw, "capabilities 必须覆盖 sat-* 通配").toContain('"sat-*"');
  });

  it("index.html：标题栏结构 = 左侧菜单 + 中间文档名 + 右侧窗口控制", () => {
    const html = indexHtml();
    expect(html, "必须是自建标题栏").toContain('class="title-bar"');
    // B192：拖动改由 main.ts 自己接管（mousedown + 越过阈值的 mousemove → startDragging），
    // **不许**再挂 data-tauri-drag-region —— 它会模拟系统标题栏点击、吞掉 mouseup、
    // 让窗口卡在移动循环里跟着鼠标走（Tauri #10767）。
    // ⚠️ 先剥 HTML 注释再判：说明「为什么不用它」的注释里必然提到这个属性名，
    //    不剥就会被自己写的注释绊倒（与「注释别照抄被契约扫描的字面量」同一个坑）。
    const markup = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(markup, "不得再用 data-tauri-drag-region").not.toContain("data-tauri-drag-region");
    // 双击最大化要自己接，所以标题栏必须有 id 可取（原来靠 drag.js，没 id 也行）
    expect(markup, "标题栏要有 id 供接线").toContain('id="title-bar"');
    expect(html, "菜单必须搬进标题栏内部").toMatch(
      /class="title-bar"[\s\S]*?id="menu-bar"[\s\S]*?class="window-controls"/,
    );
    expect(html, "中间要有文档名容器").toContain('id="title-text"');
    for (const id of ["win-minimize", "win-maximize", "win-close"]) {
      expect(html, `窗口控制键缺 #${id}`).toContain(`id="${id}"`);
    }
    // 三颗键都没有文本，必须显式给 aria-label，否则「失名」
    for (const label of ["最小化", "最大化", "关闭窗口"]) {
      expect(html, `窗口控制键必须有 aria-label「${label}」`).toContain(`aria-label="${label}"`);
    }
  });

  it("index.html：顶栏那排快捷按钮必须全部移除（不留半截）", () => {
    const html = indexHtml();
    expect(html, "整排快捷按钮容器必须删除").not.toContain("toolbar-actions");
    for (const id of [
      "btn-new",
      "btn-open",
      "btn-save",
      "btn-save-as",
      "btn-find",
      "btn-outline",
      "btn-export",
      "btn-theme",
    ]) {
      expect(html, `顶栏不得再有 #${id}`).not.toContain(`id="${id}"`);
    }
  });

  it("样式：标题栏与窗口控制键各有规则，旧快捷按钮样式整段删掉", () => {
    const s = css();
    expect(s, "必须有标题栏规则").toMatch(/\.title-bar\s*\{/);
    expect(s, "必须有窗口控制容器规则").toMatch(/\.window-controls\s*\{/);
    // B103 起窗口控制键、B110 起菜单按钮与「钉在顶部」共用**同一条声明**，所以选择器是一组。
    // ⚠️ 判据要写成「一组选择器后紧跟 {」：只判 `.win-btn {` 会在合并成
    //    `.win-btn, .title-btn {` 之后永远为真/假得莫名其妙（这次就是先红的）。
    expect(s, "必须有窗口控制键规则").toMatch(/\.win-btn,\s*\.title-btn,\s*\.menu-btn\s*\{/);
    // 关闭键悬停的红底是 Windows 的系统约定，不是随手挑的颜色
    expect(s, "关闭键悬停必须是系统约定的红底").toMatch(/\.win-btn-close:hover\s*\{[^}]*#e81123/);
    // 钉住态只高亮图标（.codicon），整按钮不点亮；图标规则必须排在 hover 之后
    // （同特异度后写者胜），否则悬停的继承色会盖掉图标高亮。
    // B166：字形改成 pinned / pin 切换，但这层配色**保留**（用户拍板）。
    expect(
      s.indexOf(".win-btn:hover"),
      ".title-btn.is-on .codicon 必须写在 hover 之后（同特异度后写者胜）",
    ).toBeLessThan(s.indexOf(".title-btn.is-on .codicon"));
    expect(s, "旧快捷按钮样式必须整段删掉").not.toContain(".toolbar-actions");
    expect(s, "旧快捷按钮样式必须整段删掉").not.toContain(".tool-btn");
  });

  it("接线：三颗键各自对应 minimize / toggleMaximize / close", () => {
    const main = mainSrc();
    expect(main, "最小化键接 minimize").toMatch(
      /winMinimize\.addEventListener\("click",\s*\(\)\s*=>\s*void getCurrentWindow\(\)\.minimize\(\)\)/,
    );
    expect(main, "最大化键接 toggleMaximize").toMatch(
      /winMaximize\.addEventListener\("click",\s*\(\)\s*=>\s*void getCurrentWindow\(\)\.toggleMaximize\(\)\)/,
    );
    // ⚠️ 关闭必须走 close()（会先过 onCloseRequested 的脏文档确认 / 热退出），
    //    用 destroy() 会直接销毁窗口，把「未保存内容怎么办」整条流程绕过去。
    expect(main, "关闭键接 close（不是 destroy）").toMatch(
      /winClose\.addEventListener\("click",\s*\(\)\s*=>\s*void getCurrentWindow\(\)\.close\(\)\)/,
    );
    expect(main, "关闭键不得绕过脏文档确认").not.toMatch(/winClose[\s\S]{0,120}?\.destroy\(\)/);
  });

  it("最大化键是双态的：普通态 chrome-maximize，最大化时换 chrome-restore", () => {
    const main = mainSrc();
    expect(main, "必须回读窗口是否最大化").toContain("isMaximized()");
    expect(main, "最大化态要换成还原字形").toMatch(
      /maximized\s*\?\s*CODICONS\.chromeRestore\s*:\s*CODICONS\.chromeMaximize/,
    );
    // 状态可能在别处变（双击拖动区 / Win+↑），所以必须挂 resize 回读
    expect(main, "必须监听窗口尺寸变化回读最大化态").toContain("onResized(");
  });

  it("标题栏中间的文档名与窗口标题同源（都来自 refreshTitle）", () => {
    const main = readFileSync("src/ui.ts", "utf-8");
    const body = main.slice(
      main.indexOf("function refreshTitle("),
      main.indexOf("function refreshStatus("),
    );
    expect(body, "取不到 refreshTitle").toBeTruthy();
    expect(body, "标题栏文字必须写进 #title-text").toContain("titleText.textContent");
    expect(body, "任务栏/Alt+Tab 读的窗口标题仍要 setTitle").toContain(".setTitle(title)");
    // 自建标题栏里应用名是噪声（窗口与任务栏已经有了），只放文档名
    expect(body, "标题栏不得重复写应用名").not.toMatch(/titleText\.textContent\s*=[^;]*LitePad/);
  });

  it("搬走的功能必须仍有入口：导出进「文件 → 导出 ▸」，主题在「文件 → 设置…」", () => {
    const m = menuSrc();
    const fileBlock = m.slice(m.indexOf('label: "文件"'), m.indexOf('label: "编辑"'));
    expect(fileBlock, "「文件」菜单必须有导出入口").toContain('label: "导出"');
    expect(fileBlock, "导出项要能按当前文档置灰").toContain("disabled: !cb.exportable()");
    expect(m, "导出必须有 HTML / PDF 两项").toContain("导出 HTML（自包含单文件）");
    expect(m, "导出必须有 HTML / PDF 两项").toContain("导出 PDF（系统打印对话框）");
    // 主题：B106 收进「文件 → 设置…」打开的统一设置页「外观」分类
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    expect(dlg, "主题必须仍有统一设置页入口").toMatch(/selectRow\(\s*"主题"/);
  });

  it("菜单项支持置灰（导出在非 Markdown 文档上不可点）", () => {
    const lib = menuLib();
    expect(lib, "MenuItem 必须支持 disabled").toMatch(/disabled\?:\s*boolean/);
    const fill = lib.slice(lib.indexOf("function fillMenu"), lib.indexOf("function positionMenu"));
    expect(fill, "fillMenu 必须把 disabled 落到 DOM 上").toContain("btn.disabled = true");
    const s = css();
    expect(s, "置灰项必须有样式，且不该有悬停高亮").toMatch(
      /\.popup-menu button:disabled\s*\{[^}]*opacity/,
    );
  });

  it("B99：置顶开关自成一个容器，且排在窗口控制键左侧", () => {
    const html = indexHtml();
    const bar = html.slice(html.indexOf('class="title-bar"'), html.indexOf("</header>"));
    // 结构上必须收在 .title-actions 里，而不是混进 .window-controls：
    // 后者那套 .win-btn 规则是「等高贴边 / 悬停淡底 / 关闭键红底」的系统约定，
    // 混进去会被连带影响（宽度、圆角、hover 底色全不对）。
    // ⚠️ 收尾的 `</div>` 必须从 .title-actions **之后**找起：
    //    标题栏里更靠前的 #app-mark 也是 <div></div>，直接用 indexOf("</div>") 会切出空串。
    const start = bar.indexOf('class="title-actions"');
    const actions = bar.slice(start, bar.indexOf("</div>", start));
    expect(start, "标题栏里应有 .title-actions").toBeGreaterThan(-1);
    expect(actions, "置顶键必须落在 .title-actions 容器里").toContain('id="win-pin"');
    expect(
      bar.indexOf('id="win-pin"'),
      "工具键必须排在窗口控制三键之前（Control 键永远贴最右）",
    ).toBeLessThan(bar.indexOf('class="window-controls"'));
    // 开关型控件必须给 aria-pressed，否则读屏器只知道「一个按钮」
    expect(actions, "开关状态要用 aria-pressed 上报").toContain('aria-pressed="false"');
    // B157：改名叫「始终在最前」（旧称「钉在顶部」，tooltip / aria-label 同一口径）
    expect(actions, "图标按钮不能失名").toContain('aria-label="始终在最前"');
    // 与同步滚动键同款 ⇒ 必须自带 `pin-btn`，才有那一条共享规则可压住 46px 方键
    expect(actions, "外观要跟着同步滚动键走").toContain('class="title-btn pin-btn"');
  });

  it("B99：左上角软件图标必须是纯标识（不挂按钮、不响应点击）", () => {
    const html = indexHtml();
    const bar = html.slice(html.indexOf('class="title-bar"'), html.indexOf("</header>"));
    expect(bar, "标题栏应有 #app-mark").toContain('id="app-mark"');
    // 顺序：图标 → 菜单 → 中间文档名 → 工具键 → 窗口控制
    expect(bar.indexOf('id="app-mark"'), "图标必须在最左（菜单之前）").toBeLessThan(
      bar.indexOf('id="menu-bar"'),
    );
    // 纯标识：不做成 <button>，于是它仍属于拖动区（可拖窗口），也不需要 aria-label
    expect(bar, "图标只是装饰，对读屏器隐藏").toMatch(/id="app-mark"[^>]*aria-hidden="true"/);
    expect(bar, "图标不得做成按钮（否则既失拖动又要求可点语义）").not.toMatch(
      /<button[^>]*id="app-mark"/,
    );
    expect(
      ruleBlock(css(), ".app-mark"),
      "图标必须显式声明不可点，免得日后被当成按钮挂事件",
    ).toContain("pointer-events: none");
  });

  it("B99：图标位图取自 src-tauri/icons，不往前端目录另存副本", () => {
    const main = mainSrc();
    expect(main, "必须引入 src-tauri/icons 下的位图").toMatch(
      /import\s+appMarkUrl\s+from\s+"\.\.\/src-tauri\/icons\//,
    );
    // 只喂前端这一张 ⇒ 不该被塞进打包清单（那是 exe / 任务栏 / installer 的活）
    const conf = JSON.parse(tauriConf()) as { bundle: { icon: string[] } };
    expect(conf.bundle.icon, "标题栏那颗不进 bundle.icon").not.toContain("app-mark.png");
    // 打包图本身没被顶掉：B222 的羽毛源图产物仍在清单里
    expect(conf.bundle.icon.join(","), "bundle.icon 必须仍含打包图").toContain("128x128.png");
    expect(main, "位图要真的挂到元素上").toContain("appMark.style.backgroundImage");
  });

  it("B222：标题栏那颗与打包图标同源（带底版），显示尺寸 24px", () => {
    const s = ruleBlock(css(), ".app-mark");
    // ⚠️ 反例一律排在正向断言之前：B219 的教训 —— 反例一旦被正向抢先报错，
    // 这条反向闸等于根本没验过（退化照样能「通过反向验证」）。
    expect(s, "不许悄悄缩回原先那个 16px").not.toMatch(/(^|[^-])width:\s*16px/);
    expect(s, "不许悄悄缩回原先那个 16px").not.toMatch(/(^|[^-])height:\s*16px/);
    expect(s, "也不许停在上次那个 30px").not.toMatch(/(^|[^-])width:\s*30px/);
    expect(s, "必须显式声明宽度").toContain("width: 24px");
    expect(s, "必须显式声明高度").toContain("height: 24px");
    expect(s, "带底版靠 contain 等比缩，不许拉伸").toContain("background-size: contain");

    // 带底版的唯一真相源是 make_icons.py（B222 换源图后由它出全套），不许手画一张丢进来
    const make = readFileSync("scripts/make_icons.py", "utf-8");
    expect(make, "标题栏那张要有脚本出口").toContain("app-mark.png");

    // ⚠️ 像素判据的图必须**跟着 import 走**，不能写死文件名 ——
    // B220 第二遍真退化就踩过：d2 把 import 换成另一张，可判据读的仍是 app-mark.png，
    // 两条断言各说各话 ⇒ 退化照样全绿。这里从 import 里抠出文件名，两处才咬在一起。
    const src = mainSrc().match(/import\s+appMarkUrl\s+from\s+"\.\.\/src-tauri\/icons\/([^"]+)"/);
    expect(src, "标题栏那颗必须有 import 落点").toBeTruthy();
    expect(src![1], "标题栏那颗必须挂 app-mark.png").toBe("app-mark.png");

    // B222 用户拍定标题栏也用带底版（羽毛图自带深色圆角方底）：
    // 四边中点必须**不透明**（无底版时代这里断言的是 alpha=0，方向整个反过来）
    const alpha = pngAlpha(readFileSync(`src-tauri/icons/${src![1]}`));
    const mid = (a: number, b: number) => Math.floor((a + b) / 2);
    for (const [x, y, where] of [
      [mid(0, alpha.width - 1), 2, "上边中点"],
      [mid(0, alpha.width - 1), alpha.height - 3, "下边中点"],
      [2, mid(0, alpha.height - 1), "左边中点"],
      [alpha.width - 3, mid(0, alpha.height - 1), "右边中点"],
    ] as [number, number, string][]) {
      expect(alpha.at(x, y), `${where}必须不透明（带底版；全透明说明退回了无底版）`).toBe(255);
    }
    expect(alpha.hasInk, "全透明就是图没画上 / 脚本没出图").toBe(true);
    // 对照组：打包图同四个点也必须不透明 —— 这条是解码器自己的反向闸：
    // 万一 pngAlpha 恒返回 255，上面的断言永远绿，有这一条才炸得出来。
    // （两版都带底，方向一致；恒 255 的假解码器靠 hasInk 与七档断言兜底。）
    const packed = pngAlpha(readFileSync("src-tauri/icons/128x128.png"));
    const mid2 = (a: number, b: number) => Math.floor((a + b) / 2);
    expect(packed.at(mid2(0, packed.width - 1), 2), "对照组上边中点应当不透明").toBeGreaterThan(0);
    expect(packed.at(2, mid2(0, packed.height - 1)), "对照组左边中点应当不透明").toBeGreaterThan(0);
  });

  it("B220：标题栏 gap 16px，且四键之间的抵消量必须同取这一颗变量", () => {
    const root = ruleBlock(css(), ":root");
    expect(root, "几何量只认 :root 里那一颗").toMatch(/--title-gap:\s*16px/);
    // 反例放最前：写死 gap 就等于把「抵消量」甩下了车（gap 8→16 那次差的正是这一处）
    expect(root, "不许再写死 8px 的老间距").not.toMatch(/--title-gap:\s*8px/);

    const bar = ruleBlock(css(), ".title-bar");
    expect(bar, "子项间距必须引用变量").toContain("gap: var(--title-gap)");
    expect(bar, "不许写死 gap 像素（改 gap 要连抵消量一起改）").not.toMatch(/gap:\s*\d+px/);

    // 置顶键 ↔ 窗口控制三键：这两颗要连成一组，靠负 margin 把 gap 吃掉
    const actions = ruleBlock(css(), ".title-actions");
    expect(actions, "抵消量必须跟着变量走").toContain("margin-right: calc(-1 * var(--title-gap))");
    expect(actions, "不许写死 -8px（gap 一变这条就漏，四键会裂开）").not.toMatch(
      /margin-right:\s*-8px/,
    );
    // 耦合的另一半：两条都得是「引用」，任一侧漏成字面量就失联 —— 从 ref 反查两边
    const refs = (text: string) => text.match(/var\(--title-gap\)/g)?.length ?? 0;
    expect(refs(bar), ".title-bar 至少要引用一次").toBeGreaterThan(0);
    expect(refs(actions), ".title-actions 至少要引用一次").toBeGreaterThan(0);
  });

  it("B223：图标左右留白同取一颗变量（右侧靠 calc 抵消 gap，净宽与左侧一致）", () => {
    const root = ruleBlock(css(), ":root");
    // ⚠️ 反例一律排在正向断言之前（B219 定式）：反例被正向抢先报错，这条闸等于没验过。
    expect(root, "不许把留白写成 gap 那颗（那是四键之间的间距，不是图标留白）").not.toMatch(
      /--title-mark-pad:\s*16px/,
    );
    expect(root, "留白量只在 :root 里定义一次").toMatch(/--title-mark-pad:\s*10px/);

    const bar = ruleBlock(css(), ".title-bar");
    expect(bar, "左侧留白必须引用变量").toContain("padding-left: var(--title-mark-pad)");
    expect(bar, "不许写死左留白（改了右边跟不上）").not.toMatch(/padding-left:\s*\d+px/);

    const mark = ruleBlock(css(), ".app-mark");
    expect(mark, "右侧必须做差抵消容器那道 gap").toContain(
      "margin-right: calc(var(--title-mark-pad) - var(--title-gap))",
    );
    // 两条反向闸：写正像素会与 gap **叠加**（右侧反而比左侧更宽），写负字面量则 gap 一改就失联
    expect(mark, "不许写正的像素（会与 gap 叠成 26px）").not.toMatch(/margin-right:\s*\d+px/);
    expect(mark, "不许写死负像素（gap 一变就失联）").not.toMatch(/margin-right:\s*-\d+px/);

    // 代入验算：右侧净留白 = 容器 gap + 这条 margin，必须正好等于左侧那颗变量的值。
    // 🎯 这条尺子**天生恒真**（gap + (pad - gap) 恒等于 pad），所以光有它等于没验 ——
    // 必须配对照组：同一把尺子去量「做差两项对调」的替身，必须量出**不一样**的数。
    const netInset = (src: string): number => {
      const r = ruleBlock(src, ":root");
      const m = ruleBlock(src, ".app-mark").match(/margin-right:\s*calc\(([^;]+)\);/);
      if (!m) return NaN;
      // ⚠️ 按变量名抠，别用 split("-") —— 变量名自己带连字符（title-mark-pad），
      // 按减号切会碎成四段，这条断言就成了恒假。
      const names = [...m[1].matchAll(/var\(--([\w-]+)\)/g)].map((x) => x[1]);
      if (names.length !== 2) return NaN;
      const val = (v: string) => Number(r.match(new RegExp(`--${v}:\\s*(\\d+)px`))?.[1] ?? NaN);
      return val("title-gap") + (val(names[0]) - val(names[1]));
    };
    const pad = Number(root.match(/--title-mark-pad:\s*(\d+)px/)![1]);
    expect(netInset(css()), "右侧净留白必须与左侧留白同宽").toBe(pad);
    const swapped = css().replace(
      "margin-right: calc(var(--title-mark-pad) - var(--title-gap))",
      "margin-right: calc(var(--title-gap) - var(--title-mark-pad))",
    );
    expect(swapped, "对照组的替身必须真的换掉表达式").not.toBe(css());
    expect(netInset(swapped), "对照组必须量出不同的净宽（否则这把尺子是恒真的）").not.toBe(pad);
  });

  it("B99：置顶开关的样式沿用「开关点亮」那一套，且不挤图标", () => {
    const s = css();
    for (const sel of [
      ".title-actions",
      ".title-btn",
      ".title-btn.is-on",
      ".title-btn.is-on .codicon",
    ]) {
      expect(ruleBlock(s, sel), `${sel} 必须有规则`).not.toBe("");
    }
    // 钉住态只高亮图标，整按钮不得点亮：图标用强调色，整按钮不得再带 --find-opt-active
    // 背景 / inset 环 / 真 border（避免「整颗键点亮」）。
    // B166：字形改成 pinned / pin 切换，但这层图标配色**保留**（用户拍板）。
    const on = ruleBlock(s, ".title-btn.is-on .codicon");
    expect(on, "钉住态必须用 .codicon 子选择器单独高亮图标").not.toBe("");
    expect(on, "图标高亮必须用强调色（--accent）").toContain("--accent");
    const btn = ruleBlock(s, ".title-btn.is-on");
    expect(btn, "整按钮不得用 --find-opt-active 点亮背景").not.toContain("--find-opt-active");
    expect(btn, "整按钮不得画 inset 环").not.toContain("box-shadow: inset");
    expect(btn, "整按钮不得用真 border").not.toMatch(/^\s*border:\s*1px/m);
  });

  it("Request N：钉在顶部键与窗口控制三键之间不加额外空隙，四键贴成一组", () => {
    const s = css();
    const actions = ruleBlock(s, ".title-actions");
    // .title-bar 的 gap 会在这两群之间插出一段留白；用等量负 margin 正好抵消，让置顶键紧贴
    // 右侧三键（视觉上四键连成一组）。这条断言同时是回归守卫：删掉负边距就会回归到「分组留白」。
    // ⚠️ 抵消量取 --title-gap 的**变量**而非字面：B220 把 gap 8→16 时，只改 gap 不改这条
    //    就会在四键之间凭空多出 8px —— 两者是同一件事的两半。
    expect(actions, "置顶键要抵消与三键之间的 gap").toContain(
      "margin-right: calc(-1 * var(--title-gap))",
    );
    // 其余分组（图标↔菜单↔标题）的间距仍由同一颗 gap 撑着，
    // 不能为了「贴齐」去把整条 gap 抹平，否则会连图标与菜单的间距也吃掉。
    expect(ruleBlock(s, ".title-bar"), "子项间距仍须走 --title-gap").toContain(
      "gap: var(--title-gap)",
    );
  });

  it("B163：.title-actions 里的 24px 方键要纵向居中（不许吃满高键时代的 stretch）", () => {
    // B157 起置顶 / 更新键是 24×24 方形图标键，但容器还留着 B103 满高键时代的
    // `align-items: stretch; align-self: stretch` —— 定高的键被顶到标题栏**上沿**，
    // 用户报「钉在最前图标没有纵向居中（同步键是正的），下载更新键也一样」。
    // 同步键在 .title-center（align-items: center）里所以没事，这两颗在 .title-actions 里。
    const actions = ruleBlock(css(), ".title-actions");
    expect(actions, "容器要纵向居中").toMatch(/align-items:\s*center/);
    expect(actions, "不许再拉伸子项（stretch 会把定高键顶到上沿）").not.toMatch(
      /align-items:\s*stretch/,
    );
    expect(actions, "容器自身也不必再撑满标题栏高").not.toMatch(/align-self:\s*stretch/);
  });

  it("B167：.title-actions 要自己撑开并右对齐（B165 后靠它把工具键顶回右边）", () => {
    // B165 把 .title-center 改成绝对定位后，「flex:1 子项把右侧两组顶到右端」的推力没了；
    // 这一族从来没写过 margin-left:auto。只补 auto 也不行 —— `.window-controls` 自己
    // 也有一条，两个 auto 会把剩余空间**平分**，置顶键与三键之间裂开一条缝。
    const actions = ruleBlock(css(), ".title-actions");
    expect(actions, "要吸满剩余空间").toMatch(/flex:\s*1 1 auto/);
    expect(actions, "内容要右对齐").toMatch(/justify-content:\s*flex-end/);
    expect(actions, "不许只给 margin-left:auto（会与三键平分留白）").not.toMatch(
      /margin-left:\s*auto/,
    );
    // 三键那一条仍在（B103 的口径：右端贴边）
    expect(ruleBlock(css(), ".window-controls"), "三键仍靠自己那条").toMatch(/margin-left:\s*auto/);
  });

  it("B167 反向验证：把 .title-actions 退回「只给 margin-left:auto」，上一条必须落空", () => {
    const orig = ruleBlock(css(), ".title-actions");
    expect(orig, "要能取到 .title-actions 规则块").not.toBe("");
    const degraded = orig
      .replace("flex: 1 1 auto;", "margin-left: auto;")
      .replace("justify-content: flex-end;", "");
    expect(degraded, "退化实现应真的换了写法").not.toBe(orig);
    expect(degraded, "退化后「不许只给 margin-left:auto」必须命中").toMatch(/margin-left:\s*auto/);
    expect(degraded, "退化后「要吸满剩余空间」必须落空").not.toMatch(/flex:\s*1 1 auto/);
  });

  it("B165：文件名要绝对居中（不许只是剩余空位内居中）", () => {
    // 用户报：左侧菜单一长，原来 flex:1 + justify-content:center 的「居中」整体被挤偏。
    // 正解是 .title-center 盖在整条标题栏正中（absolute + left:50% + translateX 回半）。
    const bar = ruleBlock(css(), ".title-bar");
    expect(bar, ".title-bar 要当定位基准").toMatch(/position:\s*relative/);
    const center = ruleBlock(css(), ".title-center");
    expect(center, "文档名容器要绝对定位").toMatch(/position:\s*absolute/);
    expect(center, "要钉在水平正中（left 50% + translateX 回自身一半）").toMatch(/left:\s*50%/);
    expect(center, "要 translateX(-50%) 回自身一半").toMatch(/translateX\(-50%\)/);
    expect(center, "不许再吃 flex:1（那是「空位内居中」的写法）").not.toMatch(/flex:\s*1/);
    expect(center, "绝对定位后会压住底下元素，pointer-events 必须关掉").toMatch(
      /pointer-events:\s*none/,
    );
    // 容器关了事件，里面的可点元素（同步滚动键）要显式拿回来
    expect(ruleBlock(css(), ".title-center > button"), "可点元素要开回 pointer-events").toMatch(
      /pointer-events:\s*auto/,
    );
  });

  it("B165 反向验证：把 .title-center 退回 flex 子项，上一条必须落空", () => {
    const orig = ruleBlock(css(), ".title-center");
    expect(orig, "要能取到 .title-center 规则块").not.toBe("");
    const degraded = orig
      .replace("position: absolute;", "flex: 1 1 auto;")
      .replace(/left:\s*50%;/, "")
      .replace(/transform:\s*translateX\(-50%\);/, "");
    expect(degraded, "退化实现应真的换了写法").not.toBe(orig);
    expect(degraded, "退化后「要绝对定位」必须落空").not.toMatch(/position:\s*absolute/);
    expect(degraded, "退化后「要 left 50%」必须落空").not.toMatch(/left:\s*50%/);
  });

  it("B163 反向验证：把 .title-actions 退回 stretch，上一条必须落空", () => {
    const orig = ruleBlock(css(), ".title-actions");
    expect(orig, "要能取到 .title-actions 规则块").not.toBe("");
    const degraded = orig.replace(
      "align-items: center;",
      "align-items: stretch;\n  align-self: stretch;",
    );
    expect(degraded, "退化实现应真的换了写法").not.toBe(orig);
    expect(degraded, "退化后「容器要纵向居中」必须落空").not.toMatch(/align-items:\s*center/);
    expect(degraded, "退化后「不许 stretch」的两条断言必须命中").toMatch(/align-items:\s*stretch/);
    expect(degraded, "退化后「不许 align-self: stretch」必须命中").toMatch(/align-self:\s*stretch/);
  });

  it("B99：置顶开关按**回读值**刷新，且状态不落盘", () => {
    const main = mainSrc();
    expect(main, "置顶键要有接线").toMatch(/winPin\.addEventListener\("click"/);
    // ⚠️ 用 topLevelFnBody 取函数体：手写 indexOf("function ") 会命中 "async function" 里的
    //    那半截，切出一个空切片 —— 断言立刻变成「expected 'async ' to contain ...」。
    const toggle = topLevelFnBody(main, "async function togglePin");
    expect(toggle, "取不到 togglePin").toBeTruthy();
    expect(toggle, "必须真的调 setAlwaysOnTop").toContain("setAlwaysOnTop(");
    // ⚠️ 回读是这条修复的要害：set 可能在「ACL 拒了 / 系统没接受」时静默不生效，
    //    拿目标值当新状态就会在界面上留一个假的点亮态。
    expect(toggle, "必须回读窗口真实置顶态").toContain("isAlwaysOnTop()");
    const refresh = topLevelFnBody(main, "async function refreshPinButton");
    expect(refresh, "开关状态要用 aria-pressed 报给读屏器").toContain(
      'setAttribute("aria-pressed"',
    );
    expect(refresh, "点亮类名必须由回读值决定").toContain('classList.toggle("is-on"');
    // 置顶是窗口的瞬时状态：settings 只存偏好（窗口几何/最大化态都没存过），
    // 这里跟着同一口径走 —— 一旦落盘就成了「重启后窗口莫名置顶」。
    expect(toggle, "置顶状态不得写回 settings").not.toContain("persistSettings");
    expect(toggle, "置顶状态不得写回 settings").not.toMatch(/settings\.\w+\s*=/);
  });

  it("B102：置顶键用 pinned / pin 两颗字形切换（.is-on 配色保留）", () => {
    const main = mainSrc();
    // ⚠️ B99 原本只挂一颗 `pin`、状态交给 .is-on 配色；用户要求改成**两颗字形**切换，
    //    字形直接反映当前状态（已置顶 = pinned，未置顶 = pin），别再退回单字形。
    //    B166：未置顶那颗从 unpin（斜杠）换成 pin（空心）—— 用户点名这两颗。
    expect(main, "不得再只用单颗 pin").not.toMatch(/\[winPin,\s*"pin"\]/);
    const refresh = topLevelFnBody(main, "async function refreshPinButton");
    expect(refresh, "取不到 refreshPinButton").toBeTruthy();
    expect(refresh, "字形必须由回读值决定").toMatch(
      /winPin\.innerHTML = pinned \? CODICONS\.pinned : CODICONS\.pin/,
    );
    // 启动链要先给一颗兜底字形，否则回读失败时按钮是空的
    const setup = topLevelFnBody(main, "function setupTitleBar");
    expect(setup, "未置顶时的兜底字形").toContain("winPin.innerHTML = CODICONS.pin");
    // 两颗字形都必须真的存在（写错名 = 空图标，界面上只有一个方块）
    const codicons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(codicons, "codicons 必须有 pinned").toMatch(/^\s*pinned:\s*"pinned"/m);
    expect(codicons, "codicons 必须有 pin").toMatch(/^\s*pin:\s*"pin"/m);
  });

  it("B103：钉在顶部与窗口控制三键共用同一条声明（同宽 / 同高 / 同圆角）", () => {
    const s = css();
    // ⚠️ 必须**同一条声明**：拆成两条规则就会各自漂移（宽度 / 圆角 / hover 底色），
    //    标题栏右侧会出现「两种按钮」—— 用户就是看到这个才提的要求。
    expect(s, "必须与 .title-btn 共用一条声明").toMatch(
      /\.win-btn,\s*\.title-btn,\s*\.menu-btn\s*\{/,
    );
    const shared = ruleBlock(s, ".win-btn");
    expect(shared, "取不到共享规则").toBeTruthy();
    expect(shared, "宽度与三键一致（46px）").toMatch(/width:\s*46px/);
    expect(shared, "高度撑满标题栏").toMatch(/height:\s*100%/);
    expect(shared, "无圆角（与窗口控制键同款）").toMatch(/border-radius:\s*0/);
    // 悬停也得共用，否则三键亮、置顶键 / 菜单键不亮
    expect(s, "悬停底色必须共用").toMatch(
      /\.win-btn:hover,\s*\.title-btn:hover,\s*\.menu-btn:hover/,
    );
    // 退化对照：把共享宽度改回旧的 30px，判据必须判出来（防止写成恒真）
    const regressed = s.replace(
      /(\.win-btn,\s*\.title-btn,\s*\.menu-btn\s*\{[^}]*?width:\s*)46px/,
      "$130px",
    );
    expect(ruleBlock(regressed, ".win-btn"), "退化对照要真的改成 30px").toMatch(/width:\s*30px/);
    expect(ruleBlock(regressed, ".win-btn"), "退化到 30px 后不该再是 46px").not.toMatch(
      /width:\s*46px/,
    );
  });

  it("B110：菜单按钮与窗口三键同一条声明（无圆角 / 满高 / 同悬停）", () => {
    const s = css();
    // 菜单按钮必须并进 .win-btn / .title-btn 的共用声明，否则三处各自漂移
    expect(s, "菜单按钮必须并入共用声明").toMatch(/\.win-btn,\s*\.title-btn,\s*\.menu-btn\s*\{/);
    expect(s, "悬停与展开态共用同一底色").toMatch(/\.menu-btn:hover,\s*\.menu-btn\.menu-open/);
    // 菜单是文字标签：宽度随文本走，不能套 46px 的图标方键宽度
    expect(s, "菜单按钮宽度随文本").toMatch(/\.menu-btn\s*\{[^}]*width:\s*auto/);
    // 容器撑满标题栏，按键才会像三键一样满高（否则 height:100% 无从解析）
    expect(ruleBlock(s, ".menu-bar"), "菜单容器必须撑满标题栏").toMatch(/align-self:\s*stretch/);
    // 退化对照：把菜单按钮从共用声明里摘出来，守卫必须判出来（防恒真）
    const regressed = s.replace(
      /\.win-btn,\s*\.title-btn,\s*\.menu-btn\s*\{/,
      ".win-btn,\n.title-btn {",
    );
    expect(regressed, "摘掉 .menu-btn 后守卫必须不再匹配").not.toMatch(
      /\.win-btn,\s*\.title-btn,\s*\.menu-btn\s*\{/,
    );
  });

  it("B101：标题栏左侧留足内边距，左上角图标不顶到窗口左缘", () => {
    const s = css();
    const readInset = (src: string): number | null => {
      // 判据：直接读 .title-bar 的 padding-left 数值。图标是标题栏的第一个子元素，
      // 这条内边距就是它离窗口左缘的全部距离（图标自身没有 margin 可调）。
      // B223 起这个值可能挂在变量上（与图标右侧留白共用 `--title-mark-pad`），
      // 所以要不就取字面量、要不就回 :root 把变量值解出来 —— 只认字面量会在换成变量后恒 null。
      const decl = ruleBlock(src, ".title-bar").match(
        /padding-left:\s*(?:(\d+(?:\.\d+)?)px|var\(--([\w-]+)\))/,
      );
      if (!decl) return null;
      if (decl[1] !== undefined) return Number(decl[1]);
      const v = ruleBlock(src, ":root").match(new RegExp(`--${decl[2]}:\\s*(\\d+(?:\\.\\d+)?)px`));
      return v ? Number(v[1]) : null;
    };
    const inset = readInset(s);
    expect(inset, ".title-bar 必须显式给出 padding-left（否则图标贴边）").not.toBeNull();
    // 8px 是下限：原来 4px 时图标字形几乎挨着边框，观感是「顶在边上」。
    expect(inset!, "图标离左缘太近（4px 会顶边，至少 8px）").toBeGreaterThanOrEqual(8);
    // 退化对照：把值改回 4px，同一把尺子必须判它不合格 ——
    // 否则这条断言对「日后被改小」是瞎的（数值断言最容易写成恒真）。
    const regressed = s.replace(
      /(\.title-bar\s*\{[^}]*?padding-left:\s*)(?:\d+(?:\.\d+)?px|var\(--[\w-]+\))/,
      "$14px",
    );
    expect(readInset(regressed), "退化对照要真把值改成 4px").toBe(4);
    expect(readInset(regressed)!, "退化到 4px 必须被判为不合格").toBeLessThan(8);
  });

  // ------------------------------------------------------------------ B191 / B192
  // B191 用户报「在 A 窗口编辑区点一下，再点 B 窗口标题栏，B 就跟着鼠标走，像按住不放」。
  // 根因是 Tauri 的 data-tauri-drag-region：它向顶层 Win32 窗口模拟一次标题栏点击
  // （WM_NCLBUTTONDOWN）来起拖，mouseup 永远到不了 webview；mousedown→起拖是异步 IPC，
  // 模拟的那次可能晚于真实松手 ⇒ 窗口卡在移动循环里（Tauri #10767，官方未修）。
  //
  // B192 改 app-region: drag 之后又报「第一下移动发涩」：Chromium 要**先确认这是一次拖动**
  // 才把拖拽交给窗口，首次还有跨进程开销。于是最终方案 = **自己接管**：
  // mousedown 只记起点，第一个越过阈值（3px）的 mousemove 立刻调 `watchdog_start_drag`
  // 交给系统移动循环（最跟手），**纯点击一次都不碰拖拽**（也就绕开了 #10767 的触发条件）。

  it("B192：样式里不许再留 app-region（与 watchdog_start_drag 双重起拖会抖）", () => {
    const s = css();
    // B191 那版是 WebView2 自己拖（app-region: drag）。改自管之后若还留着，就变成
    // 「Chromium 起一次 + watchdog_start_drag 起一次」两条 WM_NCLBUTTONDOWN，窗口反而抖。
    expect(s, "不得再声明 app-region: drag").not.toMatch(/app-region:\s*drag/);
    expect(s, "不得再声明 app-region: no-drag").not.toMatch(/app-region:\s*no-drag/);
    // 反向验证：把声明加回 .title-bar，上面那条「不许」必须落空（防恒真）
    const degraded = s.replace(/\.title-bar\s*\{/, ".title-bar {\n  app-region: drag;");
    expect(degraded, "退化实现要真的加了声明").toMatch(/app-region:\s*drag/);
  });

  it("B192：拖动自管 —— 越过阈值才调 watchdog_start_drag（纯点击不起拖）", () => {
    const setup = topLevelFnBody(mainSrc(), "function setupTitleBar");
    expect(setup, "取不到 setupTitleBar").toBeTruthy();
    // ① 起点记在 mousedown 上
    expect(setup, "必须接 mousedown").toMatch(/titleBar\.addEventListener\("mousedown"/);
    const fromDown = setup.slice(setup.indexOf('titleBar.addEventListener("mousedown"'));
    // ② 起拖必须挂在 mousemove 上、且**先过阈值** —— 这是「纯点击不进系统移动循环」的
    //    唯一保证（#10767 就是「点一下也送进移动循环」触发的）。
    //    ⚠️ 判据按位置取：看的是「mousedown 之后 → watchdog_start_drag 之前」这段里有没有阈值，
    //       写成全函数 `toContain` 会在「阈值常量挪到别处」时假绿。
    const beforeDrag = fromDown.slice(0, fromDown.indexOf("watchdog_start_drag"));
    expect(beforeDrag, "startDragging 必须出现在 mousedown 接线之后").not.toBe("");
    expect(beforeDrag, "起拖前必须先判阈值").toContain("DRAG_THRESHOLD_PX");
    expect(setup, "阈值要有显式常量").toMatch(/const DRAG_THRESHOLD_PX\s*=\s*\d+/);
    expect(setup, "必须真的调 watchdog_start_drag").toContain("watchdog_start_drag");
    // ③ 临时监听必须摘得干净：起拖后 / 松手后都要 removeEventListener，
    //    否则每按一次标题栏就往 window 上叠一层监听（下一次点击会重复起拖）。
    expect(setup, "mousemove 监听必须能摘").toMatch(/removeEventListener\("mousemove"/);
    expect(setup, "mouseup 监听必须能摘").toMatch(/removeEventListener\("mouseup"/);
    // ④ 按钮上的按下不算拖动（与下面双击最大化的豁免同一口径）。
    //    ⚠️ 判据只在「mousedown → watchdog_start_drag」这段里找：整段 setupTitleBar 里还有
    //       双击最大化的那句 closest("button")，放宽到全函数就永远为真（反向验证已证明）。
    expect(beforeDrag, "按钮上的 mousedown 必须跳过").toContain('closest("button")');
    // 反向验证：把阈值判据摘掉（= 一按下就起拖，退回 #10767 的老路），
    // 「起拖前必须先判阈值」必须落空。
    //    ⚠️ 判据要跨行（`\s*`）：prettier 会把这个两条件 `if` 折成四行，
    //       写死 `if (Math.abs(...` 会在格式化之后悄悄失配（反向验证变成恒真）。
    const degraded = fromDown.replace(
      /if\s*\(\s*Math\.abs\(ev\.clientX[\s\S]*?DRAG_THRESHOLD_PX\s*\)\s*return;/,
      "",
    );
    expect(degraded, "退化实现要真的换了写法").not.toBe(fromDown);
    expect(
      degraded.slice(0, degraded.indexOf("watchdog_start_drag")),
      "退化后「起拖前必须先判阈值」必须落空",
    ).not.toContain("DRAG_THRESHOLD_PX");
  });

  it("B191：双击标题栏空白处 = 最大化 / 还原（原来由 drag.js 提供，改自管后自己接）", () => {
    const main = mainSrc();
    const setup = topLevelFnBody(main, "function setupTitleBar");
    expect(setup, "取不到 setupTitleBar").toBeTruthy();
    expect(setup, "必须接 dblclick").toMatch(/titleBar\.addEventListener\("dblclick"/);
    expect(setup, "双击要调 toggleMaximize").toContain("toggleMaximize()");
    // ⚠️ 落在按钮上的双击不算 —— 否则「点菜单顺带把窗口最大化了」
    expect(setup, "按钮上的双击必须跳过").toMatch(/closest\("button"\)/);
    // 反向验证：把跳过判据摘掉，这条必须落空
    const degraded = setup.replace(/closest\("button"\)/, "closest('button') && false");
    expect(degraded, "退化实现要真的换了写法").not.toBe(setup);
  });
});
