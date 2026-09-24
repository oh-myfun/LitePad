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
    // B103 起窗口控制键与「钉在顶部」共用**同一条声明**，所以选择器是一对。
    // ⚠️ 判据要写成「一对选择器后紧跟 {」：只判 `.win-btn {` 会在合并成
    //    `.win-btn, .title-btn {` 之后永远为真/假得莫名其妙（这次就是先红的）。
    expect(s, "必须有窗口控制键规则").toMatch(/\.win-btn,\s*\.title-btn\s*\{/);
    // 关闭键悬停的红底是 Windows 的系统约定，不是随手挑的颜色
    expect(s, "关闭键悬停必须是系统约定的红底").toMatch(/\.win-btn-close:hover\s*\{[^}]*#e81123/);
    // 钉住态只高亮图标（.codicon），整按钮不点亮；图标规则必须排在 hover 之后
    // （同特异度后写者胜），否则悬停的继承色会盖掉图标高亮。
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
    // .title-bar 的 gap:8px 会在这两群之间插出 8px 留白；用 -8px 正好抵消，让置顶键紧贴
    // 右侧三键（视觉上四键连成一组）。这条断言同时是回归守卫：删掉负边距就会回归到「分组留白」。
    expect(actions, "置顶键必须用 -8px 抵消与三键之间的 gap").toMatch(/margin-right:\s*-8px/);
    // .title-bar 的 gap 必须仍是 8px（其余分组：图标↔菜单↔标题 仍靠它分隔），
    // 不能为了「贴齐」去把整条 gap 抹平，否则会连图标与菜单的间距也吃掉。
    expect(ruleBlock(s, ".title-bar"), ".title-bar 的 gap 必须保持 8px").toMatch(/gap:\s*8px/);
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

  it("B102：置顶键用 pinned / unpin 两颗字形切换，不靠按钮配色表达状态", () => {
    const main = mainSrc();
    // ⚠️ B99 原本只挂一颗 `pin`、状态交给 .is-on 配色；用户要求改成**两颗字形**切换，
    //    字形直接反映当前状态（已置顶 = pinned，未置顶 = unpin），别再退回单字形。
    expect(main, "不得再只用单颗 pin").not.toMatch(/\[winPin,\s*"pin"\]/);
    const refresh = topLevelFnBody(main, "async function refreshPinButton");
    expect(refresh, "取不到 refreshPinButton").toBeTruthy();
    expect(refresh, "字形必须由回读值决定").toMatch(
      /winPin\.innerHTML = pinned \? CODICONS\.pinned : CODICONS\.unpin/,
    );
    // 启动链要先给一颗兜底字形，否则回读失败时按钮是空的
    const setup = topLevelFnBody(main, "function setupTitleBar");
    expect(setup, "未置顶时的兜底字形").toContain("winPin.innerHTML = CODICONS.unpin");
    // 两颗字形都必须真的存在（写错名 = 空图标，界面上只有一个方块）
    const codicons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(codicons, "codicons 必须有 pinned").toMatch(/^\s*pinned:\s*"pinned"/m);
    expect(codicons, "codicons 必须有 unpin").toMatch(/^\s*unpin:\s*"unpin"/m);
  });

  it("B103：钉在顶部与窗口控制三键共用同一条声明（同宽 / 同高 / 同圆角）", () => {
    const s = css();
    // ⚠️ 必须**同一条声明**：拆成两条规则就会各自漂移（宽度 / 圆角 / hover 底色），
    //    标题栏右侧会出现「两种按钮」—— 用户就是看到这个才提的要求。
    expect(s, "必须与 .title-btn 共用一条声明").toMatch(/\.win-btn,\s*\.title-btn\s*\{/);
    const shared = ruleBlock(s, ".win-btn");
    expect(shared, "取不到共享规则").toBeTruthy();
    expect(shared, "宽度与三键一致（46px）").toMatch(/width:\s*46px/);
    expect(shared, "高度撑满标题栏").toMatch(/height:\s*100%/);
    expect(shared, "无圆角（与窗口控制键同款）").toMatch(/border-radius:\s*0/);
    // 悬停也得共用，否则三键亮、置顶键不亮
    expect(s, "悬停底色必须共用").toMatch(/\.win-btn:hover,\s*\.title-btn:hover\s*\{/);
    // 退化对照：把共享宽度改回旧的 30px，判据必须判出来（防止写成恒真）
    const regressed = s.replace(/(\.win-btn,\s*\.title-btn\s*\{[^}]*?width:\s*)46px/, "$130px");
    expect(ruleBlock(regressed, ".win-btn"), "退化对照要真的改成 30px").toMatch(/width:\s*30px/);
    expect(ruleBlock(regressed, ".win-btn"), "退化到 30px 后不该再是 46px").not.toMatch(
      /width:\s*46px/,
    );
  });

  it("B101：标题栏左侧留足内边距，左上角图标不顶到窗口左缘", () => {
    const s = css();
    // 判据：直接读 .title-bar 的 padding-left 数值。图标是标题栏的第一个子元素，
    // 这条内边距就是它离窗口左缘的全部距离（图标自身没有 margin 可调）。
    const readInset = (src: string): number | null => {
      const m = ruleBlock(src, ".title-bar").match(/padding-left:\s*(\d+(?:\.\d+)?)px/);
      return m ? Number(m[1]) : null;
    };
    const inset = readInset(s);
    expect(inset, ".title-bar 必须显式给出 padding-left（否则图标贴边）").not.toBeNull();
    // 8px 是下限：原来 4px 时图标字形几乎挨着边框，观感是「顶在边上」。
    expect(inset!, "图标离左缘太近（4px 会顶边，至少 8px）").toBeGreaterThanOrEqual(8);
    // 退化对照：把值改回 4px，同一把尺子必须判它不合格 ——
    // 否则这条断言对「日后被改小」是瞎的（数值断言最容易写成恒真）。
    const regressed = s.replace(/(\.title-bar\s*\{[^}]*?padding-left:\s*)\d+(?:\.\d+)?px/, "$14px");
    expect(readInset(regressed), "退化对照要真把值改成 4px").toBe(4);
    expect(readInset(regressed)!, "退化到 4px 必须被判为不合格").toBeLessThan(8);
  });
});
