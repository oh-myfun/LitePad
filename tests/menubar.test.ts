// @vitest-environment jsdom
// 菜单栏回归测试（B42 结构）：
// 1) 运行时断言五份菜单的结构——主题/预览行距/大纲宽度/分屏已从「查看」移出，
//    新建默认行尾/编码已从「文件」移出，统一收进「设置 → 首选项」；帮助只剩「关于」；
// 2) 首选项子菜单可展开、点击即回调、点击叶子节点收起整棵弹层树；
// 3) 静态断言入口唯一（不再有设置窗口；分屏只留快捷键）。
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createMenuBar, type MenuBarCallbacks } from "../src/shell/menubar";
import { closePopupMenu } from "../src/shell/menu";
import { keyHint as realKeyHint } from "../src/shell/keymap";

/** 让 MutationObserver 微任务跑完：menubar 用它复位内部 openBtn 状态。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 弹层里每一项的 `文字\t快捷键` 表示（无快捷键时只有文字）。 */
function itemTexts(menu: Element): string[] {
  return [...menu.querySelectorAll(":scope > button")].map((b) => {
    const kbd = b.querySelector(".menu-kbd");
    const label = b.querySelector(".menu-label")?.textContent ?? "";
    return kbd ? `${label}\t${kbd.textContent}` : label;
  });
}

/** 根菜单（第一层）的项。 */
function rootMenu(): Element {
  const menu = document.querySelector(".popup-menu");
  expect(menu, "弹层菜单应已打开").toBeTruthy();
  return menu!;
}

function rootTexts(): string[] {
  return itemTexts(rootMenu());
}

async function clickMenuBtn(host: HTMLElement, label: string): Promise<void> {
  const btn = [...host.querySelectorAll("button.menu-btn")].find((b) => b.textContent === label);
  expect(btn, `菜单栏按钮「${label}」应存在`).toBeTruthy();
  btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
}

/** 在所有已展开层里找项并点击。 */
async function clickAny(needle: string): Promise<void> {
  for (const menu of document.querySelectorAll(".popup-menu")) {
    const item = [...menu.querySelectorAll(":scope > button")].find((b) =>
      (b.querySelector(".menu-label")?.textContent ?? "").includes(needle),
    );
    if (item) {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      return;
    }
  }
  throw new Error(`菜单项「${needle}」未找到`);
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
    onGoto: noop,
    onSelectAll: noop,
    onTimeDate: noop,
    onToggleView: noop,
    onOutline: noop,
    tocChecked: () => true,
    onFoldAll: noop,
    onUnfoldAll: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoomReset: noop,
    onToggleWrap: noop,
    wrapChecked: () => true,
    onToggleStatusbar: noop,
    statusbarChecked: () => false,
    onToggleAutosave: noop,
    autosaveChecked: () => true,
    // 设置 → 首选项
    themeChecked: (mode) => mode === "system",
    onSetTheme: noop,
    lineHeightChecked: (v) => v === 1.7,
    onSetLineHeight: noop,
    tocWidthChecked: (w) => w === 240,
    onSetTocWidth: noop,
    defaultEol: () => "CRLF",
    eolOptions: () => ["CRLF", "LF", "CR"],
    onSetDefaultEol: noop,
    defaultEncoding: () => "UTF-8",
    encodingOptions: () => ["UTF-8", "GB18030"],
    onSetDefaultEncoding: noop,
    // 设置 → 快捷键
    onKeymap: noop,
    onAbout: noop,
    // 用真实注册表，顺带断言菜单显示的键位与生效键位一致
    keyHint: (id) => realKeyHint(id, {}),
  };
}

afterEach(() => {
  closePopupMenu();
  document.body.textContent = "";
});

describe("菜单栏（文件 / 编辑 / 查看 / 设置 / 帮助）", () => {
  it("文件菜单：保留 新建/打开/保存三兄弟/自动保存/关闭标签/退出", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    createMenuBar(host, makeCb());
    await clickMenuBtn(host, "文件");
    const texts = rootTexts();
    expect(texts).toContain("新建\tCtrl+N");
    expect(texts).toContain("打开…\tCtrl+O");
    expect(texts).toContain("保存\tCtrl+S");
    expect(texts).toContain("另存为…\tCtrl+Shift+S");
    expect(texts).toContain("全部保存\tCtrl+Alt+S");
    expect(texts).toContain("自动保存");
    expect(texts).toContain("关闭标签\tCtrl+W");
    expect(texts).toContain("退出");
    expect(
      document.querySelectorAll(".popup-menu .menu-sep").length,
      "文件菜单项之间要有分隔线",
    ).toBeGreaterThanOrEqual(3);
  });

  it("B42：文件菜单不得再有「新建文件默认行尾/编码」，它们已移入设置", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    createMenuBar(host, makeCb());
    await clickMenuBtn(host, "文件");
    const texts = rootTexts().join("\n");
    expect(texts, "不得再有「新建文件默认行尾…」").not.toContain("新建文件默认行尾");
    expect(texts, "不得再有「新建文件默认编码…」").not.toContain("新建文件默认编码");
  });

  it("编辑菜单：撤销/重做 + 剪贴板 + 查找定位 + 全选/时间日期（键位随注册表）", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    createMenuBar(host, makeCb());
    await clickMenuBtn(host, "编辑");
    const texts = rootTexts();
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
    expect(texts, "不得再有「在文件中查找」").not.toContain("在文件中查找\tCtrl+Shift+F");
  });

  it("B42：查看菜单去掉主题/预览行距/大纲宽度/分屏，保留缩放与勾选态开关", async () => {
    let wrap = true;
    let statusbar = false;
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    cb.wrapChecked = () => wrap;
    cb.statusbarChecked = () => statusbar;
    createMenuBar(host, cb);
    await clickMenuBtn(host, "查看");
    const texts = rootTexts();
    const joined = texts.join("\n");

    // 保留项
    expect(texts).toContain("切换 源码 / 预览\tCtrl+/");
    expect(texts, "大纲必须有默认快捷键").toContain("大纲 TOC\tCtrl+Shift+O");
    expect(texts, "折叠全部必须有默认快捷键").toContain("折叠全部\tCtrl+Alt+[");
    expect(texts, "展开全部必须有默认快捷键").toContain("展开全部\tCtrl+Alt+]");
    expect(texts).toContain("放大\tCtrl+=");
    expect(texts).toContain("缩小\tCtrl+-");
    expect(texts).toContain("重置缩放\tCtrl+0");
    expect(joined).toContain("自动换行");
    expect(joined).toContain("状态栏");

    // 移除项
    expect(joined, "查看菜单不得再有主题三态").not.toContain("主题：");
    expect(joined, "查看菜单不得再有预览行距").not.toContain("预览行距");
    expect(joined, "查看菜单不得再有大纲宽度").not.toContain("大纲宽度");
    expect(joined, "查看菜单不得再有分屏项").not.toContain("分屏");
    expect(joined, "不得再出现笼统的「切换主题」").not.toContain("切换主题");

    // 勾选态实时求值
    const wrapItem = [...document.querySelectorAll(".popup-menu > button")].find((b) =>
      (b.textContent ?? "").includes("自动换行"),
    );
    expect(wrapItem?.querySelector(".check")?.textContent, "自动换行应为勾选态").toBe("✓");
    wrap = false;
    statusbar = true;
    closePopupMenu();
    await flush();
    await clickMenuBtn(host, "查看");
    const wrap2 = [...document.querySelectorAll(".popup-menu > button")].find((b) =>
      (b.textContent ?? "").includes("自动换行"),
    );
    expect(wrap2?.querySelector(".check")?.textContent).toBe("");
  });

  it("B46：设置菜单 = 首选项… + 快捷键…，都是叶子（不再有子菜单）", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onPreferences = () => calls.push("preferences");
    cb.onKeymap = () => calls.push("keymap");
    createMenuBar(host, cb);
    await clickMenuBtn(host, "设置");
    expect(rootTexts()).toEqual(["首选项…", "快捷键…"]);

    // 弹窗化后设置菜单不得再有任何子菜单父项
    const submenuParents = [...document.querySelectorAll(".popup-menu .has-submenu")];
    expect(submenuParents, "设置菜单不得再有子菜单父项").toHaveLength(0);

    await clickAny("首选项…");
    expect(calls).toEqual(["preferences"]);
    expect(document.querySelector(".popup-menu"), "点击叶子项后弹层应收起").toBeNull();

    await clickMenuBtn(host, "设置");
    await clickAny("快捷键…");
    expect(calls).toEqual(["preferences", "keymap"]);
  });

  it("帮助菜单：只剩「关于 LitePad」（快捷键已移入设置）", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onAbout = () => calls.push("about");
    createMenuBar(host, cb);
    await clickMenuBtn(host, "帮助");
    expect(rootTexts()).toEqual(["关于 LitePad"]);
    expect(rootTexts().join(""), "帮助里不得再有快捷键入口").not.toContain("快捷键");
    await clickAny("关于 LitePad");
    expect(calls).toEqual(["about"]);
  });
});

describe("设置项归属与接线（B42/B46）", () => {
  it("原设置对话框必须已删除，且不再有任何入口", () => {
    expect(existsSync("src/shell/settingsdialog.ts"), "设置对话框文件必须删除").toBe(false);
    expect(existsSync("src/shell/keymapdialog.ts"), "快捷键对话框应存在").toBe(true);
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src).not.toContain("showSettingsDialog");
    expect(src).not.toContain("openSettings");
    expect(src).not.toContain("./shell/settingsdialog");
    const html = readFileSync("index.html", "utf-8");
    expect(html, "工具栏不再有设置齿轮").not.toContain("btn-settings");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单栏不得再保留设置项回调").not.toContain("onSettings");
    expect(menu, "设置菜单必须有首选项入口").toContain('label: "首选项…"');
    expect(menu, "B46 后首选项不再是子菜单").not.toContain("submenu:");
    expect(menu, "设置菜单必须有快捷键入口").toContain('label: "快捷键…"');
  });

  it("B46：首选项弹窗必须存在并接线到 main.ts", () => {
    expect(existsSync("src/shell/preferencesdialog.ts"), "首选项弹窗文件应存在").toBe(true);
    const dlg = readFileSync("src/shell/preferencesdialog.ts", "utf-8");
    // 收拢原子菜单的全部预设值 + 新增精细选项
    for (const item of [
      "主题",
      "编辑器字体",
      "字号",
      "编辑器行距",
      "自动换行",
      "自动保存",
      "预览行距",
      "大纲宽度",
      "默认行尾",
      "默认编码",
    ]) {
      expect(dlg, `首选项弹窗必须含「${item}」`).toContain(item);
    }
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "main 必须引入 showPreferencesDialog").toContain("showPreferencesDialog(");
    expect(src, "main 必须有弹窗入口函数").toContain("function openPreferencesDialog(");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单必须回调 onPreferences").toContain("onPreferences");
  });

  it("每个被移出的设置项都在首选项里接线到 main.ts", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu).toContain("onToggleAutosave");
    for (const fn of [
      "function setDefaultEol(",
      "function setDefaultEncoding(",
      "function setThemeMode(",
      "function toggleAutosave(",
      "function setPreviewLineHeight(",
      "function setTocWidthValue(",
      "function loadPreferenceOptions(",
    ]) {
      expect(src, `main.ts 必须实现 ${fn}`).toContain(fn);
    }
    // 旧的「以菜单按钮为锚点弹列表」实现应已删除
    expect(src, "旧的就地弹列表实现应删除").not.toContain("function showDefaultEolMenu(");
    expect(src, "旧的就地弹列表实现应删除").not.toContain("function showDefaultEncodingMenu(");
  });

  it("分屏只留快捷键：菜单不含分屏项，但快捷键处理必须保留", () => {
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单栏不得再有分屏回调").not.toContain("onSplitH");
    expect(menu, "菜单栏不得再有分屏回调").not.toContain("onClosePanel");

    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "main.ts 必须保留左右分屏处理").toContain('splitActivePanel(activePanelId, "h")');
    expect(src, "main.ts 必须保留上下分屏处理").toContain('splitActivePanel(activePanelId, "v")');
    expect(src, "main.ts 必须保留移除分屏处理").toContain("closePanelById(activePanelId)");

    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    expect(km, "分屏快捷键必须有默认值").toContain("panel.splitH");
    expect(km, "分屏快捷键必须有默认值").toContain("panel.splitV");
    expect(km, "移除分屏必须也有快捷键（否则功能失联）").toContain("panel.close");
  });
});

describe("快捷键注册表与对话框", () => {
  it("全局快捷键改由注册表统一分发（不再散落硬编码监听）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须用 resolveCommand 分发").toContain("resolveCommand(e, keymapOverrides)");
    expect(src, "必须有 runShortcut 动作表").toContain("function runShortcut(");
    expect(src, "设置对话框打开时应让路").toContain(".settings-overlay");
    // 旧的硬编码分支应已删除
    expect(src, "不得再用 e.key.toLowerCase() 手写分支").not.toContain(
      "const key = e.key.toLowerCase();",
    );
  });

  it("编辑器不再自带 foldKeymap，折叠键位归注册表", () => {
    const ed = readFileSync("src/editor/editor.ts", "utf-8");
    expect(ed, "不得再展开 CM 的 foldKeymap").not.toContain("...foldKeymap");
    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    expect(km, "折叠当前块必须有默认键位").toContain("view.foldCode");
    expect(km, "折叠全部必须有默认键位").toContain("view.foldAll");
  });

  it("快捷键对话框必须可浏览也可编辑", () => {
    const dlg = readFileSync("src/shell/keymapdialog.ts", "utf-8");
    expect(dlg, "必须有搜索框").toContain("keymap-search");
    expect(dlg, "必须有可点击改键的按钮").toContain("keymap-key");
    expect(dlg, "必须支持恢复默认").toContain("恢复全部默认");
    expect(dlg, "必须做冲突检测").toContain("findConflict");
    expect(dlg, "只读项不得渲染成可点按钮").toContain("editable === false");
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "改动必须持久化").toContain("settings.keymap");
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
    expect(src.includes("insertTimeDate")).toBe(true);
    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    expect(km, "F5 必须是 force（否则会被 WebView2 刷新吃掉）").toContain("force: true");
  });

  it("B39/B40：查找范围不用下拉菜单，跨文档改为勾选框，且不做文件夹搜索", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "不得再出现 folder 范围入口").not.toContain('openFindBar("folder")');
    expect(src, "不得再调用读盘的跨文件搜索 IPC").not.toContain("searchFiles");
    expect(src, "不得再有默认搜索目录推导").not.toContain("defaultSearchDir");
    expect(src, "不得再注册 Ctrl+Shift+F").not.toContain("Ctrl+Shift+F");

    const barSrc = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(barSrc, "查找栏不得再有 scope 概念").not.toContain("FindScope");
    expect(barSrc, "查找栏不得再有范围下拉").not.toContain("find-scope");
    expect(barSrc, "查找栏不得再有文件夹搜索控件").not.toContain("find-folder");
    expect(barSrc, "跨文档必须保留为勾选框").toContain("find-opt-docs");
    expect(barSrc, "跨文档结果列表必须保留").toContain("find-results");
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
