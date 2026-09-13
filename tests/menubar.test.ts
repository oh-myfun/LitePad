// @vitest-environment jsdom
// 参考记事本优化菜单栏与搜索组件的回归测试：
// 1) 运行时断言四份菜单的结构（编辑菜单含 撤销/重做/剪贴板/查找定位/全选/时间日期；
//    文件菜单含 全部保存/关闭标签；查看菜单含 缩放与勾选态开关）；
// 2) 菜单项点击正确触发回调并收起弹层；
// 3) 静态断言查找入口已统一到悬浮查找栏（不再有 CM6 面板 / 独立查找窗口两套 UI）。
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createMenuBar, type MenuBarCallbacks } from "../src/shell/menubar";
import { closePopupMenu } from "../src/shell/menu";

/** 让 MutationObserver 微任务跑完：menubar 用它复位内部 openBtn 状态。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function menuTexts(): string[] {
  const menu = document.querySelector(".popup-menu");
  expect(menu, "弹层菜单应已打开").toBeTruthy();
  return [...menu!.querySelectorAll("button")].map((b) => {
    const kbd = b.querySelector(".menu-kbd");
    const label = b.childNodes[1]?.textContent ?? "";
    return kbd ? `${label}\t${kbd.textContent}` : label;
  });
}

async function clickMenuBtn(host: HTMLElement, label: string): Promise<void> {
  const btn = [...host.querySelectorAll("button.menu-btn")].find((b) => b.textContent === label);
  expect(btn, `菜单栏按钮「${label}」应存在`).toBeTruthy();
  btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
}

async function clickItem(needle: string): Promise<void> {
  const menu = document.querySelector(".popup-menu");
  expect(menu, "弹层菜单应已打开").toBeTruthy();
  const item = [...menu!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(needle),
  );
  expect(item, `菜单项「${needle}」应存在`).toBeTruthy();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
}

const noop = (): void => {};

function makeCb(): MenuBarCallbacks {
  return {
    onNew: noop,
    onOpen: noop,
    onSave: noop,
    onSaveAs: noop,
    onSaveAll: noop,
    onCloseTab: noop,
    onExit: noop,
    onUndo: noop,
    onRedo: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
    onDelete: noop,
    onFind: noop,
    onFindNext: noop,
    onFindPrev: noop,
    onReplace: noop,
    onFindInFiles: noop,
    onGoto: noop,
    onSelectAll: noop,
    onTimeDate: noop,
    onToggleView: noop,
    onOutline: noop,
    onFoldAll: noop,
    onUnfoldAll: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoomReset: noop,
    onToggleWrap: noop,
    wrapChecked: () => true,
    onToggleStatusbar: noop,
    statusbarChecked: () => false,
    onSplitH: noop,
    onSplitV: noop,
    onClosePanel: noop,
    // 原设置对话框拆散后的菜单项
    onToggleAutosave: noop,
    autosaveChecked: () => true,
    onDefaultEol: noop,
    onDefaultEncoding: noop,
    themeChecked: (mode) => mode === "system",
    onSetTheme: noop,
    lineHeightChecked: (v) => v === 1.7,
    onSetLineHeight: noop,
    tocWidthChecked: (w) => w === 240,
    onSetTocWidth: noop,
    onKeymap: noop,
    onAbout: noop,
  };
}

afterEach(() => {
  closePopupMenu();
  document.body.textContent = "";
});

describe("菜单栏（参考 Win11 记事本）", () => {
  it("文件菜单：含 全部保存 Ctrl+Alt+S 与 关闭标签 Ctrl+W，带分隔线", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    createMenuBar(host, makeCb());
    await clickMenuBtn(host, "文件");
    const texts = menuTexts();
    expect(texts).toContain("新建\tCtrl+N");
    expect(texts).toContain("打开…\tCtrl+O");
    expect(texts).toContain("保存\tCtrl+S");
    expect(texts).toContain("另存为…\tCtrl+Shift+S");
    expect(texts).toContain("全部保存\tCtrl+Alt+S");
    expect(texts).toContain("关闭标签\tCtrl+W");
    expect(texts).toContain("退出");
    const seps = document.querySelectorAll(".popup-menu .menu-sep").length;
    expect(seps).toBeGreaterThanOrEqual(2);
  });

  it("编辑菜单：撤销/重做 + 剪切/复制/粘贴/删除 + 查找/步进/替换/转到 + 全选/时间日期", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    createMenuBar(host, makeCb());
    await clickMenuBtn(host, "编辑");
    const texts = menuTexts();
    for (const t of [
      "撤销\tCtrl+Z",
      "重做\tCtrl+Y",
      "剪切\tCtrl+X",
      "复制\tCtrl+C",
      "粘贴\tCtrl+V",
      "删除\tDel",
      "查找…\tCtrl+F",
      "查找下一个\tF3",
      "查找上一个\tShift+F3",
      "替换…\tCtrl+H",
      "转到…\tCtrl+G",
      "全选\tCtrl+A",
      "时间/日期\tF5",
    ]) {
      expect(texts, `编辑菜单应含「${t}」`).toContain(t);
    }
    // B39：跨文件/文件夹搜索已从查找能力中移除，菜单不得再有该入口
    expect(texts, "不得再有「在文件中查找」").not.toContain("在文件中查找\tCtrl+Shift+F");
  });

  it("查看菜单：缩放三项 + 自动换行/状态栏勾选态实时求值", async () => {
    let wrap = true;
    let statusbar = false;
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    cb.wrapChecked = () => wrap;
    cb.statusbarChecked = () => statusbar;
    createMenuBar(host, cb);
    await clickMenuBtn(host, "查看");
    const texts = menuTexts();
    expect(texts).toContain("放大\tCtrl+=");
    expect(texts).toContain("缩小\tCtrl+-");
    expect(texts).toContain("重置缩放\tCtrl+0");
    expect(texts, "查看菜单应含折叠全部/展开全部").toContain("折叠全部");
    expect(texts).toContain("展开全部");
    expect(texts, "主题应为三态单选项").toContain("主题：跟随系统");
    expect(texts).toContain("主题：浅色");
    expect(texts).toContain("主题：深色");
    expect(texts, "不得再出现笼统的「切换主题」").not.toContain("切换主题");
    expect(texts, "预览行距归入查看菜单").toContain("预览行距：标准");
    expect(texts, "大纲宽度归入查看菜单").toContain("大纲宽度：默认");
    // 勾选标记
    const items = [...document.querySelectorAll(".popup-menu button")];
    const wrapItem = items.find((b) => (b.textContent ?? "").includes("自动换行"));
    expect(wrapItem?.querySelector(".check")?.textContent, "自动换行应为勾选态").toBe("✓");
    const sbItem = items.find((b) => (b.textContent ?? "").includes("状态栏"));
    expect(sbItem?.querySelector(".check")?.textContent, "状态栏应为未勾选态").toBe("");
    // 翻转后重新打开，勾选态跟随
    wrap = false;
    statusbar = true;
    closePopupMenu();
    await flush();
    await clickMenuBtn(host, "查看");
    const items2 = [...document.querySelectorAll(".popup-menu button")];
    const wrap2 = items2.find((b) => (b.textContent ?? "").includes("自动换行"));
    expect(wrap2?.querySelector(".check")?.textContent).toBe("");
    const sb2 = items2.find((b) => (b.textContent ?? "").includes("状态栏"));
    expect(sb2?.querySelector(".check")?.textContent).toBe("✓");
  });

  it("帮助菜单：只剩快捷键说明与关于，不再有设置入口", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onKeymap = () => calls.push("keymap");
    cb.onAbout = () => calls.push("about");
    createMenuBar(host, cb);
    await clickMenuBtn(host, "帮助");
    const texts = menuTexts();
    expect(texts).toContain("快捷键…");
    expect(texts).toContain("关于 LitePad");
    expect(texts, "帮助菜单不得再保留设置入口").not.toContain("设置");
    await clickItem("快捷键…");
    expect(calls).toEqual(["keymap"]);
  });

  it("分散到菜单的设置项：主题/行距/大纲宽度点击即回调", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onSetTheme = (m) => calls.push(`theme:${m}`);
    cb.onSetLineHeight = (v) => calls.push(`lh:${v}`);
    cb.onSetTocWidth = (w) => calls.push(`toc:${w}`);
    cb.onToggleAutosave = () => calls.push("autosave");
    createMenuBar(host, cb);
    await clickMenuBtn(host, "查看");
    await clickItem("主题：深色");
    await clickMenuBtn(host, "查看");
    await clickItem("预览行距：宽松");
    await clickMenuBtn(host, "查看");
    await clickItem("大纲宽度：宽");
    await clickMenuBtn(host, "文件");
    await clickItem("自动保存");
    expect(calls).toEqual(["theme:dark", "lh:2.1", "toc:320", "autosave"]);
  });

  it("点击菜单项触发对应回调并收起弹层", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onSelectAll = () => calls.push("selectAll");
    cb.onGoto = () => calls.push("goto");
    cb.onSaveAll = () => calls.push("saveAll");
    createMenuBar(host, cb);
    await clickMenuBtn(host, "编辑");
    await clickItem("全选");
    expect(calls).toEqual(["selectAll"]);
    expect(document.querySelector(".popup-menu")).toBeNull();
    await clickMenuBtn(host, "编辑");
    await clickItem("转到…");
    expect(calls).toEqual(["selectAll", "goto"]);
    await clickMenuBtn(host, "文件");
    await clickItem("全部保存");
    expect(calls).toEqual(["selectAll", "goto", "saveAll"]);
  });
});

describe("设置项分散到各菜单（不再有设置窗口）", () => {
  it("设置对话框必须已删除，且不再有任何入口", () => {
    expect(existsSync("src/shell/settingsdialog.ts"), "设置对话框文件必须删除").toBe(false);
    expect(existsSync("src/shell/keymapdialog.ts"), "快捷键说明对话框应存在").toBe(true);
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src).not.toContain("showSettingsDialog");
    expect(src).not.toContain("openSettings");
    expect(src).not.toContain("./shell/settingsdialog");
    const html = readFileSync("index.html", "utf-8");
    expect(html, "工具栏不再有设置齿轮").not.toContain("btn-settings");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单栏不得再保留设置项").not.toContain("onSettings");
    expect(menu, "帮助菜单只留快捷键与关于").toContain('label: "快捷键…"');
  });

  it("每个原设置项都能在菜单里找到归属并接线到 main.ts", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    // 文件菜单：自动保存 + 新建文件默认行尾/编码
    expect(menu).toContain("onToggleAutosave");
    expect(menu).toContain("onDefaultEol");
    expect(menu).toContain("onDefaultEncoding");
    // 查看菜单：主题三态 + 预览行距 + 大纲宽度（字号由缩放三键覆盖）
    expect(menu).toContain("onSetTheme");
    expect(menu).toContain("onSetLineHeight");
    expect(menu).toContain("onSetTocWidth");
    for (const fn of [
      "function setThemeMode(",
      "function showDefaultEolMenu(",
      "function showDefaultEncodingMenu(",
      "function toggleAutosave(",
      "function setPreviewLineHeight(",
      "function setTocWidthValue(",
    ]) {
      expect(src, `main.ts 必须实现 ${fn}`).toContain(fn);
    }
  });
});

describe("查找入口统一（悬浮查找栏）", () => {
  it("main.ts 必须接线悬浮查找栏：查找/替换都走同一个 openFindBar", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    // prettier 会重排 import，断言只看标识符存在（不锁定排版）
    expect(/\bcreateFindBar\b/.test(src), "必须引入 createFindBar").toBe(true);
    expect(src.includes("function openFindBar("), "必须有统一入口 openFindBar").toBe(true);
    expect(src.includes('openFindBar("replace")'), "菜单「替换…」/Ctrl+H 走同一入口").toBe(true);
    expect(src.includes("async function doSaveAll")).toBe(true);
    // F5 插入时间日期必须拦截 WebView2 默认刷新
    expect(src.includes('"F5"')).toBe(true);
    expect(src.includes("insertTimeDate")).toBe(true);
  });

  it("B39：查找不得再有跨文件/文件夹范围（无 range 下拉、无 Ctrl+Shift+F）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "不得再出现 folder 范围入口").not.toContain('openFindBar("folder")');
    expect(src, "不得再调用跨文件搜索 IPC").not.toContain("searchFiles");
    expect(src, "不得再有默认搜索目录推导").not.toContain("defaultSearchDir");
    expect(src, "不得再注册 Ctrl+Shift+F").not.toContain("Ctrl+Shift+F");

    const barSrc = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(barSrc, "查找栏不得再有 scope 概念").not.toContain("FindScope");
    expect(barSrc, "查找栏不得再有范围下拉").not.toContain("find-scope");
    expect(barSrc, "查找栏不得再有文件夹搜索控件").not.toContain("find-folder");
    expect(barSrc, "查找栏不得再有跨文件结果列表").not.toContain("find-results");
  });

  it("不得再存在第二套查找 UI（CM6 面板 / 独立查找窗口）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "不得再打开 CM6 内置搜索面板").not.toContain("openSearchPanel");
    expect(src, "不得再引用旧的 searchbar 模块").not.toContain("./editor/searchbar");
    expect(src, "不得再引用独立的在文件中查找窗口").not.toContain("./shell/findinfiles");
    expect(existsSync("src/shell/findinfiles.ts"), "旧窗口文件必须删除").toBe(false);
    expect(existsSync("src/editor/searchbar.ts"), "旧面板文件必须删除").toBe(false);

    const ed = readFileSync("src/editor/editor.ts", "utf-8");
    expect(ed, "编辑器不得再挂 CM6 自带 search() 面板").not.toContain("search({");
    expect(ed, "编辑器不得再展开 searchKeymap（Mod-f/F3 会抢键）").not.toContain("...searchKeymap");
    expect(ed, "必须挂载自持的查找高亮").toContain("findHighlight()");

    const html = readFileSync("index.html", "utf-8");
    expect(html, "工具栏只保留一个查找按钮").not.toContain("btn-find-files");
    expect(html).toContain('id="btn-find"');
  });
});
