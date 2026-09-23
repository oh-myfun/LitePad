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
import { stripCssComments, ruleBlock, topLevelFnBody } from "./static";

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
    // 整条都能拖：deep 让子树里的非可点击元素也触发拖动，按钮会自动豁免
    expect(html, '拖动区必须用 data-tauri-drag-region="deep"').toContain(
      'data-tauri-drag-region="deep"',
    );
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
    expect(s, "必须有窗口控制键规则").toMatch(/\.win-btn\s*\{/);
    // 关闭键悬停的红底是 Windows 的系统约定，不是随手挑的颜色
    expect(s, "关闭键悬停必须是系统约定的红底").toMatch(/\.win-btn-close:hover\s*\{[^}]*#e81123/);
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
    const main = mainSrc();
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

  it("搬走的功能必须仍有入口：导出进「文件 → 导出 ▸」，主题留在首选项", () => {
    const m = menuSrc();
    const fileBlock = m.slice(m.indexOf('label: "文件"'), m.indexOf('label: "编辑"'));
    expect(fileBlock, "「文件」菜单必须有导出入口").toContain('label: "导出"');
    expect(fileBlock, "导出项要能按当前文档置灰").toContain("disabled: !cb.exportable()");
    expect(m, "导出必须有 HTML / PDF 两项").toContain("导出 HTML（自包含单文件）");
    expect(m, "导出必须有 HTML / PDF 两项").toContain("导出 PDF（系统打印对话框）");
    // 主题：B42/B46 已定「只收在设置 → 首选项」，本次不再新增菜单入口
    const dlg = readFileSync("src/shell/preferencesdialog.ts", "utf-8");
    expect(dlg, "主题必须仍有首选项入口").toContain('selectRow("主题"');
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
    expect(actions, "图标按钮不能失名").toContain('aria-label="钉在顶部"');
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

  it("B99：图标与 exe / 任务栏用同一份源图，不往前端目录另存副本", () => {
    const main = mainSrc();
    expect(main, "必须引入 src-tauri 下的应用图标").toMatch(
      /import\s+appMarkUrl\s+from\s+"\.\.\/src-tauri\/icons\/32x32\.png"/,
    );
    // 同源的另一半证据：bundle.icon 里也有这张图（换成别的尺寸会让两处观感不一致）
    const conf = JSON.parse(tauriConf()) as { bundle: { icon: string[] } };
    expect(conf.bundle.icon.join(","), "bundle.icon 必须包含被引入的那张").toContain("32x32.png");
    expect(main, "位图要真的挂到元素上").toContain("appMark.style.backgroundImage");
  });

  it("B99：置顶开关的样式沿用「开关点亮」那一套，且不挤图标", () => {
    const s = css();
    for (const sel of [".title-actions", ".title-btn", ".title-btn.is-on"]) {
      expect(ruleBlock(s, sel), `${sel} 必须有规则`).not.toBe("");
    }
    const on = ruleBlock(s, ".title-btn.is-on");
    // 全应用「开关点亮」只有一套语言（查找栏那几个开关的 inputOption.active 三件套）
    expect(on, "点亮态应与查找栏开关同源").toContain("--find-opt-active");
    // ⚠️ 全局是 border-box，真 border 会把 16px 图标挤小（.find-sel.on 同一个坑）
    expect(on, "1px 环必须用 inset 阴影画，不能加真 border").toContain("box-shadow: inset");
    expect(on, "不得用真 border").not.toMatch(/^\s*border:\s*1px/m);
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

  it("B99：置顶用 pin 字形，且字形不带状态（开关态靠配色）", () => {
    const gen = readFileSync("scripts/fetch-codicons.mjs", "utf-8");
    expect(gen, "ICONS 必须收 pin").toMatch(/pin:\s*"pin"/);
    // 不用 pinned / unpin：pin 是横放图钉（笔画最简），另两颗一个带斜杠、一个斜 45°，
    // 都会让读者去猜「哪边是开」。开关态由 .is-on 的配色表达。
    expect(gen, "不得改用带状态语义的字形").not.toMatch(/pin:\s*"(pinned|unpin)"/);
    const codicons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(codicons, "生成物里必须有 pin 条目").toMatch(/^\s*pin:/m);
    expect(mainSrc(), "置顶键必须取 CODICONS.pin").toMatch(/\[winPin,\s*"pin"\]/);
  });
});
