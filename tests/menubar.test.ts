// @vitest-environment jsdom
// 菜单栏回归测试（B42 结构）：
// 1) 运行时断言五份菜单的结构——主题/预览行距/大纲宽度/分屏已从「查看」移出，
//    新建默认行尾/编码已从「文件」移出，统一收进「设置 → 首选项」；帮助只剩「关于」；
// 2) 首选项子菜单可展开、点击即回调、点击叶子节点收起整棵弹层树；
// 3) 静态断言入口唯一（不再有设置窗口；分屏只留快捷键）。
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { stripLineComments, topLevelFnBody } from "./static";
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
    onToggleHotExit: noop,
    hotExitChecked: () => true,
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
  it("文件菜单：保留 新建/打开/保存三兄弟/自动保存/热退出/关闭标签/退出", async () => {
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
    // B68：热退出与自动保存并列，但语义完全不同（一个写原文件、一个写副本）
    expect(texts).toContain("热退出（关窗不询问）");
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

  it("B39/B40：查找范围不用下拉菜单，跨文档改为文档图标，且不做文件夹搜索", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "不得再出现 folder 范围入口").not.toContain('openFindBar("folder")');
    expect(src, "不得再调用读盘的跨文件搜索 IPC").not.toContain("searchFiles");
    expect(src, "不得再有默认搜索目录推导").not.toContain("defaultSearchDir");
    expect(src, "不得再注册 Ctrl+Shift+F").not.toContain("Ctrl+Shift+F");

    const barSrc = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(barSrc, "查找栏不得再有 scope 概念").not.toContain("FindScope");
    expect(barSrc, "查找栏不得再有范围下拉").not.toContain("find-scope");
    expect(barSrc, "查找栏不得再有文件夹搜索控件").not.toContain("find-folder");
    expect(barSrc, "跨文档必须保留（方案 C：文档图标按钮）").toContain("find-docs");
    // ⚠️ B80 反转了这条：原先要求「结果列表必须保留」，用户实测要求「底下不要结果区」，
    //    参考 VS Code（它的查找浮层里没有内联结果列表）后整个删掉 —— 总匹配数改由
    //    文档图标右上角的徽标承载。
    expect(barSrc, "不得再有底部结果列表").not.toContain("find-results");
    expect(barSrc, "总匹配数必须由徽标承载").toContain("find-badge");
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

describe("B 档：删掉菜单项提示（写了也永远不显示 = 死代码）", () => {
  const menuSrc = readFileSync("src/shell/menu.ts", "utf-8");
  const tabstripSrc = readFileSync("src/shell/tabstrip.ts", "utf-8");
  const filedropSrc = readFileSync("src/shell/filedrop.ts", "utf-8");
  const mainSrc = readFileSync("src/main.ts", "utf-8");
  it("MenuItem 不再有 title 字段，fillMenu 也不再挂提示", () => {
    expect(menuSrc, "MenuItem 不该再留 title 字段").not.toMatch(/^\s*title\?: string;/m);
    const fill = topLevelFnBody(menuSrc, "function fillMenu");
    expect(fill, "取不到 fillMenu").toBeTruthy();
    expect(fill, "菜单项不得再调 setTip").not.toMatch(/setTip\(/);
  });

  it("标签右键菜单的高频项不带 title（复制标签 / 在新窗口打开）", () => {
    for (const label of ["复制标签", "在新窗口打开"]) {
      const i = tabstripSrc.indexOf(`label: "${label}"`);
      expect(i, `找不到菜单项 ${label}`).toBeGreaterThan(-1);
      // 该项到下一个 } 之间不得出现 title
      const chunk = tabstripSrc.slice(i, tabstripSrc.indexOf("}", i));
      expect(chunk, `${label} 不该再挂提示`).not.toMatch(/title/);
    }
  });

  it("拖放选择菜单两项也不再挂 title", () => {
    const choice = topLevelFnBody(filedropSrc, "function showFileDropChoice");
    expect(choice, "取不到 showFileDropChoice").toBeTruthy();
    expect(choice, "两项都不该有 title").not.toMatch(/title/);
  });

  it("触发判据改成「落点面板的活动文档是 Markdown」，而不是「拖进来的是 .md」", () => {
    expect(filedropSrc, "needsChoice 必须接收落点文档是否为 Markdown").toMatch(
      /export function needsChoice\(paths: string\[\], targetIsMarkdown: boolean\): boolean/,
    );
    expect(filedropSrc, "单个文件 + 落点是 Markdown 才问").toMatch(
      /return paths\.length === 1 && targetIsMarkdown;/,
    );
    expect(filedropSrc, "isMarkdownPath 这条旧判据应已删除").not.toMatch(/isMarkdownPath/);

    // main.ts 接线：落点面板的活动文档是不是 md 由 panelDocIsMarkdown 回答
    expect(mainSrc, "落点判定必须问「落点面板的活动文档」").toMatch(
      /needsChoice\(p\.paths, target !== null && panelDocIsMarkdown\(target\.panelId\)\)/,
    );
    const helper = topLevelFnBody(mainSrc, "function panelDocIsMarkdown");
    expect(helper, "取不到 panelDocIsMarkdown").toBeTruthy();
    expect(helper, "必须取该面板的活动标签再判 isMdTab").toMatch(/isMdTab\(t\)/);
  });
});

describe("B42：菜单重组为 文件/编辑/查看/设置/帮助", () => {
  const menu = (): string => readFileSync("src/shell/menubar.ts", "utf-8");
  const main = (): string => readFileSync("src/main.ts", "utf-8");

  it("「查看」不得再有主题 / 预览行距 / 大纲宽度 / 分屏", () => {
    // 只看「查看」菜单那一段，避免把「设置 → 首选项」里的同名词条误判为残留
    const src = menu();
    const viewBlock = src.slice(src.indexOf('label: "查看"'), src.indexOf('label: "设置"'));
    expect(viewBlock, "查看菜单不得再有主题三态").not.toContain("主题：");
    expect(viewBlock, "查看菜单不得再有预览行距").not.toContain("预览行距");
    expect(viewBlock, "查看菜单不得再有大纲宽度").not.toContain("大纲宽度");
    expect(viewBlock, "查看菜单不得再有分屏项").not.toContain("分屏");
    // 保留项不能被顺手删掉
    expect(viewBlock).toContain("切换 源码 / 预览");
    expect(viewBlock).toContain("大纲 TOC");
    expect(viewBlock).toContain("折叠全部");
    expect(viewBlock).toContain("自动换行");
    expect(viewBlock).toContain("状态栏");
  });

  it("「文件」不得再有新建默认行尾/编码，「帮助」不得再有快捷键", () => {
    const src = menu();
    const fileBlock = src.slice(src.indexOf('label: "文件"'), src.indexOf('label: "编辑"'));
    expect(fileBlock, "文件菜单不得再有新建默认行尾入口").not.toContain("新建文件默认行尾");
    expect(fileBlock, "文件菜单不得再有新建默认编码入口").not.toContain("新建文件默认编码");
    expect(fileBlock, "文件菜单应保留自动保存").toContain("自动保存");

    const helpBlock = src.slice(src.indexOf('label: "帮助"'));
    expect(helpBlock, "帮助菜单只留关于").toContain("关于 LitePad");
    expect(helpBlock, "帮助菜单不得再有快捷键入口").not.toContain("快捷键");
  });

  it("「设置」菜单 = 首选项弹窗入口 + 快捷键；预设值收进弹窗（B46）", () => {
    const src = menu();
    const setBlock = src.slice(src.indexOf('label: "设置"'), src.indexOf('label: "帮助"'));
    expect(setBlock, "设置菜单必须有首选项入口").toContain('label: "首选项…"');
    expect(setBlock, "B46 后首选项不再是子菜单").not.toContain("submenu:");
    expect(setBlock, "设置菜单必须有快捷键入口").toContain('label: "快捷键…"');

    // 原子菜单的预设值全部收进首选项弹窗（按分组标签断言）
    const dlg = readFileSync("src/shell/preferencesdialog.ts", "utf-8");
    for (const item of [
      "外观",
      "主题",
      "字体与行距",
      "编辑器字体",
      "字号",
      "编辑器行距",
      "Markdown 预览",
      "预览行距",
      "大纲宽度",
      "新建文件",
      "默认行尾",
      "默认编码",
    ]) {
      expect(dlg, `首选项弹窗必须含「${item}」`).toContain(item);
    }
    // 新增精细设置的字段必须持久化（前后端成对）
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    for (const field of ["font_family", "editor_line_height"]) {
      expect(api, `Settings 接口必须含 ${field}`).toContain(field);
      expect(rust, `Rust Settings 必须含 ${field}`).toContain(field);
    }
  });

  it("B51：首选项弹窗移除自动换行 / 自动保存 / 快捷键（功能留在菜单里）", () => {
    // 需求：这三项从首选项弹窗里去掉——它们是高频开关，菜单里一点即达，
    // 塞进弹窗只会让「改一个开关」变成三层点击。
    const dlg = readFileSync("src/shell/preferencesdialog.ts", "utf-8");
    for (const gone of [
      '"自动换行"',
      '"自动保存"',
      '"快捷键…"',
      "onWordWrap",
      "onAutosave",
      "onKeymap",
      "checkRow",
    ]) {
      expect(dlg, `首选项弹窗不得再出现 ${gone}`).not.toContain(gone);
    }
    // 只是搬家，不是砍功能：菜单入口必须都还在
    // （自动换行在「查看」，自动保存在「文件」，快捷键在「设置」）
    const src = menu();
    const viewBlock = src.slice(src.indexOf('label: "查看"'), src.indexOf('label: "设置"'));
    const setBlock = src.slice(src.indexOf('label: "设置"'), src.indexOf('label: "帮助"'));
    expect(viewBlock, "「查看」菜单必须保留自动换行").toContain("自动换行");
    expect(src, "「文件」菜单必须保留自动保存").toContain("自动保存");
    expect(setBlock, "「设置」菜单必须保留快捷键入口").toContain('label: "快捷键…"');
  });

  it("B51：主题按钮三态循环，导出图标改语义", () => {
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "主题必须按档位循环（三态）").toContain("nextThemeMode()");
    expect(main, "档位要写进 data 属性供测试/样式用").toContain("dataset.themeMode");
    expect(main, "「跟随系统」档须照搬官方 color-mode（半明半暗的圆）").toContain(
      "CODICONS.colorMode",
    );
    expect(main, "不得再退回明暗二选一的旧写法").not.toContain('isDark ? "light" : "dark"');

    // 导出图标（B51 本来改过一次语义：下载托盘 → 文档 + 出向箭头）现在直接照搬官方
    // `export`，手绘版已删 —— 字形由上游版本钉住（scripts/fetch-codicons.mjs 的 VERSION），
    // 这里只守「确实来自 codicon」。
    const codicons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(codicons, "导出图标必须来自官方 export").toContain("export:");
  });

  it("B81 图标红线：按钮图标一律走 codicon，手绘只剩 sun/moon（用户确认豁免）", () => {
    // 用户要求：「软件里按钮图标全部使用 vscode 图标集中的图标（如果没有合适的就和我商量
    // 去下载别的图标集），不要自己绘制 svg（除非和我讨论确认或者我明确要求）。」
    // 据此：消费方一律从 codicons.ts 取；源码里不得再内联手绘字形。

    // ---- ① 消费方一律不得手绘 <svg> ----
    const CONSUMERS = [
      "src/main.ts",
      "src/shell/tabstrip.ts",
      "src/shell/splitview.ts",
      "src/shell/findbar.ts",
      "src/shell/fileicons.ts",
      "src/editor/editor.ts",
    ] as const;
    for (const f of CONSUMERS) {
      expect(readFileSync(f, "utf-8"), `${f} 不得手绘 <svg>，图标必须来自 CODICONS`).not.toContain(
        "<svg",
      );
    }

    // ---- ② 工具栏整张表都得是 codicon 名（旧的自绘名 new/open/find/outline 已废） ----
    const main = readFileSync("src/main.ts", "utf-8");
    for (const pair of [
      '[btnNew, "newFile"]',
      '[btnOpen, "folderOpened"]',
      '[btnSave, "save"]',
      '[btnSaveAs, "saveAs"]',
      '[btnFind, "search"]',
      '[btnOutline, "listTree"]',
      '[btnExport, "export"]',
    ]) {
      expect(main, `工具栏缺 ${pair}`).toContain(pair);
    }
    expect(main, "工具栏必须从 CODICONS 取名取图").toContain("btn.innerHTML = CODICONS[name]");

    // ---- ③ 文件类型字形也必须走 codicon（不得再自建手绘字形表） ----
    const fi = readFileSync("src/shell/fileicons.ts", "utf-8");
    expect(fi, "家族字形必须从 CODICONS 取").toContain("CODICONS[");
    expect(fi, "不得再自建 GLYPHS 手绘表").not.toContain("GLYPHS");

    // ---- ④ 手绘豁免只有 icons.ts 的 sun / moon 两颗 ----
    // 官方 639 颗 codicon 里没有日/月字形（最接近的 color-mode 已用于「跟随系统」），
    // 经用户确认这两颗保留手绘；其余任何键冒出来都说明有人又手绘了图标。
    const icons = readFileSync("src/shell/icons.ts", "utf-8");
    const body = icons.slice(icons.indexOf("export const ICONS = {"), icons.indexOf("} as const;"));
    const keys = [...body.matchAll(/\n {2}(\w+):/g)].map((m) => m[1]);
    expect(keys, "icons.ts 只应剩 sun / moon（其余一律 codicon）").toEqual(["sun", "moon"]);
  });

  it("B82 CHANGELOG 生成器不得吞掉区间内最后一个提交（git log 无尾换行）", () => {
    // 事故：v0.8.0 的 CHANGELOG 少了本版唯一的 feat 条目（a3bc51f）。
    // 根因：`git log --pretty=format:'%h%x1f%s'` 的最后一条记录**不带尾换行**，而
    // `while IFS=… read` 在「有内容但无换行」的 EOF 上返回非 0 → 循环体不执行 →
    // 区间内**最旧**的提交被静默丢弃（新→旧排列下，丢的正好是本版头号 feature）。
    // 修法：循环条件补 `|| [ -n "$sha" ]`。这条断言就是防止它被「简化」回去。
    const sh = readFileSync("scripts/gen-changelog.sh", "utf-8");
    expect(sh, '读循环必须补 EOF 兜底（|| [ -n "$sha" ]），否则吞提交').toContain(
      'read -r sha subj || [ -n "$sha" ]',
    );
  });

  it("B83 pre-push 的 windres 目录必须归一成 POSIX 路径（Windows 风格条目是死路）", () => {
    // 事故：钩子打印「cargo test（windres: C:/msys64/mingw64/bin）」，看起来工具链找到了，
    // cargo 却 panic `NotAttempted("windres")` —— 因为 MSYS 下 `C:/…` 风格的 PATH 条目
    // 既搜不到、也不会被转成可用形式传给**原生**子进程（cargo → build.rs → embed-resource）。
    // 归一成 `/c/msys64/mingw64/bin` 后 40 个 Rust 测试全绿（实测）。
    // ⚠️ 这条与 COREUTILS_DIR 的 `cd … && pwd` 是同一类教训：命中路径必须规范化。
    const hook = readFileSync(".githooks/pre-push", "utf-8");
    expect(hook, "WINDRES_DIR 必须经 `cd … && pwd` 归一，不能直接用 C:/… 条目").toContain(
      'WINDRES_DIR="$(cd "$w" 2>/dev/null && pwd)"',
    );
  });

  it("B84 pre-push 必须先本地构建并产出 release exe（exe 不刷新 ⇒ 截图也刷不了）", () => {
    // 09-20 复盘：v0.7.0 / v0.8.0 连续两个版本没刷新 `docs/screenshots/main.png`，
    // 当时归因为「沙箱拍不了图」，真正原因是 **release exe 是旧的** ——
    // `release.sh <ver> --ci` 会跳过本地构建，而 `scripts/capture-screenshots.py` 的
    // 前置就是 `src-tauri/target/release/litepad.exe`。把构建做成 pre-push 的硬门后，
    // exe 每次推送都是新的，截图随时可拍。
    // ⚠️ 断言必须**先剥 `#` 注释**再比：本守卫要找的 `npm run build`、
    //   `beforeBuildCommand` 等字样在说明性注释里同样出现，直接比对整份文件的话，
    //   挖掉真正的命令照样通过 —— B79 那条已经踩过一次这种假绿。
    const raw = readFileSync(".githooks/pre-push", "utf-8");
    const hook = raw
      .split("\n")
      .map((l) => (/^\s*#/.test(l) ? "" : l))
      .join("\n");

    expect(hook, "pre-push 必须跑前端构建（tsc + vite）").toContain("npm run build");
    expect(hook, "pre-push 必须生成 release exe").toContain("npm run tauri -- build");
    expect(
      hook,
      "必须置空 beforeBuildCommand，否则 tauri 会把 vite 再跑一遍（build-all.sh 里卡死过）",
    ).toContain('{"build":{"beforeBuildCommand":""}}');
    expect(hook, "vite 清 dist/assets 会被 safe-delete 钩子拦，必须关掉").toContain(
      "CODEBUDDY_SAFE_DELETE_ENABLED=0",
    );
    // 「构建命令返回 0 却没写出 exe」出现过，光看退出码不够
    expect(hook, "必须复核 exe 真的产出，不能只信退出码").toContain(
      "src-tauri/target/release/litepad.exe",
    );
    // 硬门：构建失败必须阻断推送，不是警告跳过
    expect(hook, "release 构建失败必须 exit 1 阻断推送").toMatch(
      /release 构建未通过[\s\S]*?exit 1/,
    );
  });

  it("B85 vite 构建前必须剥离 PATH 里的 MSYS2 条目（否则 vite 挂死）", () => {
    // 09-20 实测坐实（此前只标为「疑点未定论」）：PATH 里带 `/c/msys64/mingw64/bin`
    // （为给 cargo 提供 windres 而加）时，`vite build` 会**挂死** —— 不是慢，是不动：
    // CPU 只走 ~25s 就停、内存涨到 1.8G、`dist/assets` 被清空后一直不写入，
    // 挂 13 分钟也不出产物。同一指纹 09-19 在 build-all.sh 里出现过两次。
    // 摘掉这些条目后同一条命令 **40s** 完成。
    // ⚠️ 同样先剥 `#` 注释再断言（注释里也写了 `msys64` / `npm run build`）。
    const stripHash = (src: string) =>
      src
        .split("\n")
        .map((l) => (/^\s*#/.test(l) ? "" : l))
        .join("\n");
    const hook = stripHash(readFileSync(".githooks/pre-push", "utf-8"));
    const buildAll = stripHash(readFileSync("scripts/build-all.sh", "utf-8"));

    expect(hook, "pre-push 必须过滤掉含 msys64 的 PATH 条目").toContain("*msys64*) ;;");
    expect(hook, "前端构建必须用剥离后的 PATH 跑，不能直接用原 PATH").toContain('PATH="$FE_PATH"');
    // ⚠️ 剥离 PATH **不足以兜住**：09-20 钩子内实测剥离后仍挂在写盘阶段（内存 ~1.7G），
    // 而手动跑同一命令 71s 就完成 —— 是间歇性的。所以必须有超时 + 重试，
    // 否则一次挂死就会把推送无限期卡住（第一次就是挂了 12 分钟才被人工杀掉）。
    expect(hook, "vite 必须带超时，挂死时能自己退场").toContain("timeout -k 10 240");
    expect(hook, "超时/失败后要重试一次，别把间歇性挂死当真失败").toMatch(/for attempt in 1 2/);
    // build-all.sh 顶部恰恰把 msys64 前插进 PATH，是卡死的原发地，同样要剥
    expect(buildAll, "build-all.sh 的前端构建同样必须剥离 MSYS2 条目").toContain(
      'PATH="$FE_PATH" npm run build',
    );
  });

  it("B86 三种查找范围共用同一套触发与计数逻辑（不再靠回车触发搜索）", () => {
    // 事故：点亮「所有打开的文档」后既不刷新结果也不更新按钮，改搜索文本同样没反应，
    // **必须再按一次回车**才搜。两个根因：
    //   ① 查找栏把跨文档做成**独立命令**（onSearchAll），只有回车会调它；
    //   ② 主程序 `runFindInDocs` 刚写完计数，紧随其后的 `refreshFindCount()` 又因
    //      `q.allDocs` 把它覆盖成「无内容」→ prev/next 被置灰，看起来就是「没触发」。
    // 修法：搜索统一由「查询或范围变化」触发；计数统一由 `refreshFindCount()` 一个出口产出；
    // 回车在三种范围里一律是步进（下一个 / 上一个）。
    const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    const bar = stripLineComments(readFileSync("src/shell/findbar.ts", "utf-8"));

    // ① 触发统一：回车不再按范围分叉
    expect(bar, "回车在三种范围里一律是步进，不得再按 allDocs 分叉").not.toContain("q.allDocs");
    expect(bar, "查找栏不再有跨文档专用搜索入口").not.toContain("runSearch");
    expect(main, "范围/查询变化必须统一重算跨文档命中").toMatch(
      /if \(q\.allDocs\) runFindInDocs\(q\);/,
    );

    // ② 计数统一：跨文档也走 refreshFindCount 这一个出口
    const refresh = main.match(/function refreshFindCount\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(refresh, "refreshFindCount 必须覆盖跨文档范围").toContain("q.allDocs");
    expect(refresh, "跨文档有命中时计数 = 当前序号 / 总数").toMatch(/findHits\.length/);
    expect(refresh, "跨文档有文本无命中时显示「无匹配」（与单文档一致）").toContain("无匹配");
    // ⚠️ 关键回归点：早先这里一律写「无内容」，会顺带把 prev/next 置灰
    expect(refresh, "跨文档不得一律写成「无内容」").not.toMatch(/q\.allDocs[\s\S]{0,200}无内容/);

    // ③ 底部提示：跨文档不再写「共 N 处匹配，回车逐个跳转」
    expect(main, "删除「共 N 处匹配，回车逐个跳转」提示").not.toContain("回车逐个跳转");

    // ④ 步进后同样走那一个出口，不再自己写计数/状态行
    const step = main.match(/function stepFindInDocs\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(step, "跨文档步进后必须走 refreshFindCount").toContain("refreshFindCount()");
    expect(step, "跨文档步进不得再自己写状态行").not.toContain("setStatus");
  });

  it("B79 主题：档位必须写回 settings 才存得下；三态按钮一律不点亮", () => {
    // ⚠️ 断言必须落在**代码**上，不能落在整份文件上：上面这段说明性的注释里就写着
    // `persistSettings()` 和 `themeMode = normalizeMode(settings?.theme)`，
    // 反向验证实测——挖掉真正的调用后，只要还比对整份文件，断言照样通过（假绿）。
    // 所以先剥掉整行注释再断言。
    const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));

    // ---- ① 落盘：settings.theme 必须被写回 ----
    // 用户实测「每次打开都是深色」。根因：启动时读的是 `settings.theme`，而 setThemeMode
    // 只改了内存里的 themeMode，**没写回 settings** —— persistSettings() 存的是整个对象，
    // 于是 theme 永远是启动时的 "system"，深色系统下解析出来就是深色。
    // ⚠️ 判据必须落在「写回」这个动作上：只断言「调了 persistSettings」会假绿（一直在调）。
    const setBody =
      main.match(/async function setThemeMode\(mode: ThemeMode\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(setBody, "setThemeMode 必须把档位写回 settings（否则根本存不下来）").toMatch(
      /settings\.theme = mode/,
    );
    expect(setBody, "写回之后必须落盘").toContain("persistSettings()");
    expect(main, "启动时必须按 settings.theme 还原档位").toContain(
      "normalizeMode(settings?.theme)",
    );

    // ---- ② 激活态：循环按钮三档外观必须一致 ----
    // 用户实测「深色模式按钮带激活状态，其它模式没有」。旧代码是
    // `btnTheme.classList.toggle("tool-btn-active", themeMode === "dark")`：
    // 它是**循环按钮**不是开关，「激活」没有语义，且只有深色档点亮 = 三档观感各不相同。
    expect(main, "⚠️ 主题按钮不得再按深色档点亮（循环按钮没有「激活」语义）").not.toMatch(
      /btnTheme[\s\S]{0,160}?tool-btn-active/,
    );
    expect(main, "当前档位仍要写进 data 属性供测试/样式用").toContain("btnTheme.dataset.themeMode");
    // .tool-btn-active 本身还要留着（自动换行等开关按钮在用），别整条删掉
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, "开关按钮的激活态样式必须保留").toContain(".tool-btn.tool-btn-active");
  });

  it("菜单显示的键位必须来自快捷键注册表（不能写死）", () => {
    const src = menu();
    expect(src, "菜单必须通过 keyHint 取键位").toContain("cb.keyHint(");
    expect(src, "不得再手写硬编码快捷键").not.toContain("新建\\tCtrl+N");
    expect(main(), "main 必须提供 keyHint 实现").toContain("function keyHint(");
  });

  it("子菜单能力与长菜单滚动", () => {
    const m = readFileSync("src/shell/menu.ts", "utf-8");
    expect(m, "MenuItem 必须支持 submenu").toContain("submenu?");
    expect(m, "必须有子菜单箭头").toContain("menu-arrow");
    expect(m, "嵌套层必须能被整体回收").toContain("function closeDeeperThan");

    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, "子菜单箭头样式").toContain(".menu-arrow");
    expect(css, "长菜单必须自身滚动").toMatch(/\.popup-menu\s*\{[\s\S]*?overflow-y:\s*auto/);
  });
});
