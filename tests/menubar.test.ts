// @vitest-environment jsdom
// 菜单栏回归测试（B42 结构 + B106 统一设置页）：
// 1) 运行时断言四份菜单的结构——主题/预览行距/大纲宽度/分屏已从「查看」移出，
//    新建默认行尾/编码已从「文件」移出，统一收进「文件 → 设置…」；帮助只剩「关于」；
// 2) 设置入口在「文件」菜单里，点击即回调、打开统一设置页；
// 3) 静态断言入口唯一（不再有设置窗口/独立「设置」菜单；分屏只留快捷键）。
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  hasDistIntegrityGuard,
  hasStep3NotDeliverableWarning,
  stripCssComments,
  stripLineComments,
  topLevelFnBody,
} from "./static";
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
  // 按钮文本是「标签(助记字母)」（B103 起，如「文件(F)」），所以按前缀匹配
  const btn = [...host.querySelectorAll("button.menu-btn")].find((b) =>
    b.textContent?.startsWith(label),
  );
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
    // B97：导出从顶栏搬进「文件 → 导出 ▸」
    onExportHtml: noop,
    onExportPdf: noop,
    exportable: () => true,
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
    // 文件 → 设置…
    onSettings: noop,
    // 帮助 → 检查更新…
    onCheckUpdate: noop,
    onAbout: noop,
    // 用真实注册表，顺带断言菜单显示的键位与生效键位一致
    keyHint: (id) => realKeyHint(id, {}),
  };
}

afterEach(() => {
  closePopupMenu();
  document.body.textContent = "";
});

describe("菜单栏（文件 / 编辑 / 查看 / 帮助）", () => {
  it("B103：菜单按钮是「标签(字母)」写法，不再有首字下划线和 Alt 键帽提示", () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    createMenuBar(host, makeCb());
    // 五个按钮的文本：VS Code 中文版的助记符写法
    const texts = [...host.querySelectorAll("button.menu-btn")].map((b) => b.textContent);
    expect(texts, "四个菜单按钮都要带括号助记符").toEqual([
      "文件(F)",
      "编辑(E)",
      "查看(V)",
      "帮助(H)",
    ]);
    // 反面：下划线（.mnemonic）与提示里的 Alt+字母 键帽都必须退场
    const src = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(src, "按钮不得再包 mnemonic 下划线").not.toContain("mnemonic");
    expect(src, "不得再往提示里挂 Alt+字母 键帽").not.toMatch(/setTip\([\s\S]{0,120}Alt\+/);
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, ".mnemonic 规则必须已删除").not.toMatch(/\.mnemonic\s*\{/);
  });

  it("文件菜单：保留 新建/打开/保存三兄弟/设置…/关闭标签/退出（自动保存与热退出已迁入设置页）", async () => {
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
    // B108：自动保存 / 热退出已搬到设置页「通用」分类，菜单不再承载
    expect(texts, "文件菜单不再有自动保存").not.toContain("自动保存");
    expect(texts, "文件菜单不再有热退出").not.toContain("热退出（关窗不询问）");
    expect(texts).toContain("设置…");
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

  it("B106：设置入口在「文件」菜单，不再有独立的「设置」菜单", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onSettings = () => calls.push("settings");
    createMenuBar(host, cb);

    // 没有独立的「设置」顶层菜单
    const btnLabels = [...host.querySelectorAll("button.menu-btn")].map((b) => b.textContent ?? "");
    expect(btnLabels, "不得再出现独立的「设置」菜单").not.toContain("设置(S)");

    // 「文件」菜单里能找到「设置…」
    await clickMenuBtn(host, "文件");
    expect(rootTexts().join("\n"), "文件菜单应包含「设置…」").toContain("设置…");
    await clickAny("设置…");
    expect(calls).toEqual(["settings"]);
    expect(document.querySelector(".popup-menu"), "点击叶子项后弹层应收起").toBeNull();
  });

  it("B107：帮助菜单 = 检查更新… + 关于 LitePad（快捷键已移入设置）", async () => {
    const host = document.createElement("nav");
    document.body.appendChild(host);
    const cb = makeCb();
    const calls: string[] = [];
    cb.onCheckUpdate = () => calls.push("check-update");
    cb.onAbout = () => calls.push("about");
    createMenuBar(host, cb);
    await clickMenuBtn(host, "帮助");
    expect(rootTexts()).toEqual(["检查更新…", "关于 LitePad"]);
    expect(rootTexts().join(""), "帮助里不得再有快捷键入口").not.toContain("快捷键");
    await clickAny("检查更新…");
    await clickMenuBtn(host, "帮助");
    await clickAny("关于 LitePad");
    expect(calls).toEqual(["check-update", "about"]);
  });
});

describe("设置项归属与接线（B42/B46）", () => {
  it("B106：统一设置页必须存在并接线，旧的首选项弹窗已删除", () => {
    expect(existsSync("src/shell/settingsdialog.ts"), "统一设置页文件必须存在").toBe(true);
    expect(existsSync("src/shell/preferencesdialog.ts"), "旧首选项弹窗必须删除").toBe(false);
    expect(existsSync("src/shell/keymapdialog.ts"), "快捷键逻辑文件应存在").toBe(true);
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "main 必须引入 showSettingsDialog").toContain("showSettingsDialog(");
    expect(src, "main 必须有打开设置页函数").toContain("function openSettingsDialog(");
    expect(src, "main 不得再残留 preferencesdialog").not.toContain("preferencesdialog");
    const html = readFileSync("index.html", "utf-8");
    expect(html, "工具栏不再有设置齿轮").not.toContain("btn-settings");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单栏必须有 onSettings 回调").toContain("onSettings:");
    expect(menu, "菜单栏不得再残留 onPreferences").not.toContain("onPreferences");
    expect(menu, "菜单栏不得再残留 onKeymap").not.toContain("onKeymap");
    expect(menu, "不得再有独立的「设置」顶层菜单").not.toContain('label: "设置"');
    expect(menu, "文件菜单必须含「设置…」入口").toContain('label: "设置…"');
  });

  it("B106：统一设置页必须含全部设置项并接线到 main.ts", () => {
    expect(existsSync("src/shell/settingsdialog.ts"), "统一设置页文件应存在").toBe(true);
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    // 收拢原首选项的全部精细选项
    for (const item of [
      "主题",
      "编辑器字体",
      "字号",
      "编辑器行距",
      "预览行距",
      "大纲宽度",
      "默认行尾",
      "默认编码",
      "快捷键",
    ]) {
      expect(dlg, `设置页必须含「${item}」`).toContain(item);
    }
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "main 必须引入 showSettingsDialog").toContain("showSettingsDialog(");
    expect(src, "main 必须有打开设置页函数").toContain("function openSettingsDialog(");
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单必须回调 onSettings").toContain("onSettings:");
  });

  it("每个被移出的设置项都在设置页里接线到 main.ts", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    // B108：自动保存 / 热退出从菜单搬进设置页，靠 onAutosave / onHotExit 接线
    expect(src, "自动保存由设置页接线").toContain("onAutosave:");
    expect(src, "热退出由设置页接线").toContain("onHotExit:");
    for (const fn of [
      "function setDefaultEol(",
      "function setDefaultEncoding(",
      "function setThemeMode(",
      "function setAutosave(",
      "function setHotExit(",
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
    // B97：顶栏那排快捷按钮（含查找）整体移除，查找入口只剩「编辑」菜单与 Ctrl+F。
    expect(html, "不得再有第二个查找按钮").not.toContain("btn-find-files");
    expect(html, "顶栏不得再有查找按钮").not.toContain('id="btn-find"');
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
    // 只看「查看」菜单那一段，避免把「文件 → 设置…」里的同名词条误判为残留
    const src = menu();
    const viewBlock = src.slice(src.indexOf('label: "查看"'), src.indexOf('label: "帮助"'));
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
    expect(fileBlock, "文件菜单不得再有自动保存（已迁到设置页「通用」）").not.toContain("自动保存");

    const helpBlock = src.slice(src.indexOf('label: "帮助"'));
    expect(helpBlock, "帮助菜单只留关于").toContain("关于 LitePad");
    expect(helpBlock, "帮助菜单不得再有快捷键入口").not.toContain("快捷键");
  });

  it("B106：「文件 → 设置…」是统一设置页入口，原「设置」菜单与首选项弹窗已移除", () => {
    const src = menu();
    // 不再有独立的「设置」顶层菜单
    expect(src, "不得再有独立的「设置」顶层菜单").not.toContain('label: "设置"');
    // 设置入口在「文件」菜单里
    const fileBlock = src.slice(src.indexOf('label: "文件"'), src.indexOf('label: "编辑"'));
    expect(fileBlock, "「文件」菜单必须有「设置…」入口").toContain('label: "设置…"');

    // 原先散落在原子菜单里的预设值全部收进统一设置页（按分组标签断言）
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    for (const item of [
      "外观",
      "主题",
      "编辑器字体",
      "字号",
      "编辑器行距",
      "Markdown 预览",
      "预览行距",
      "大纲宽度",
      "新建文件",
      "默认行尾",
      "默认编码",
      "快捷键",
    ]) {
      expect(dlg, `统一设置页必须含「${item}」`).toContain(item);
    }
    // 新增精细设置的字段必须持久化（前后端成对）
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    for (const field of ["font_family", "editor_line_height"]) {
      expect(api, `Settings 接口必须含 ${field}`).toContain(field);
      expect(rust, `Rust Settings 必须含 ${field}`).toContain(field);
    }
  });

  it("B51/B106/B108：高频开关的去向（自动换行留菜单，自动保存/热退出迁入设置页「通用」）", () => {
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    // 自动换行是高频开关，仍留在「查看」菜单，不进设置页
    expect(dlg, "设置页不得再出现自动换行").not.toContain("自动换行");
    // B108：自动保存 / 热退出反过来 —— 从「文件」菜单搬进设置页「通用」分类
    expect(dlg, "设置页「通用」分类要有自动保存").toContain("自动保存");
    expect(dlg, "设置页「通用」分类要有热退出").toContain("热退出");
    // 快捷键是设置页的一个分类（不是独立弹窗入口）
    expect(dlg, "设置页必须含「快捷键」分类").toContain("快捷键");

    const src = menu();
    const viewBlock = src.slice(src.indexOf('label: "查看"'), src.indexOf('label: "帮助"'));
    const fileBlock = src.slice(src.indexOf('label: "文件"'), src.indexOf('label: "编辑"'));
    expect(viewBlock, "「查看」菜单必须保留自动换行").toContain("自动换行");
    expect(fileBlock, "「文件」菜单不再有自动保存").not.toContain("自动保存");
    expect(fileBlock, "「文件」菜单不再有热退出").not.toContain("热退出（关窗不询问）");
    expect(fileBlock, "「文件」菜单的设置入口即快捷键去向").toContain('label: "设置…"');
  });

  it("B97/B106：主题只从「文件 → 设置…」进出，顶栏不再有主题/导出按钮", () => {
    const main = readFileSync("src/main.ts", "utf-8");
    // 档位仍要有个可读的落点（它是跨模块状态：换档要联动 CodeMirror 的明暗）
    expect(main, "档位要写进 data 属性供测试/样式用").toContain("dataset.themeMode");
    expect(main, "换档必须联动面板明暗").toContain("applyDarkToTabs");
    expect(main, "不得再退回明暗二选一的旧写法").not.toContain('isDark ? "light" : "dark"');
    // 三态循环按钮与它的三颗图标（sun / moon / color-mode）随顶栏按钮一起退役
    expect(main, "主题循环按钮必须已移除").not.toContain("cycleTheme");
    expect(main, "主题三态图标表必须已移除").not.toContain("THEME_STATES");

    const html = readFileSync("index.html", "utf-8");
    for (const gone of ["btn-theme", "btn-export", "btn-new", "toolbar-actions"]) {
      expect(html, `顶栏不得再有 ${gone}`).not.toContain(gone);
    }
    // 「移除」必须配「仍在别处可达」：导出在「文件 → 导出 ▸」，主题在「文件 → 设置… → 外观」
    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "导出必须有菜单入口").toContain('label: "导出"');
    expect(menu, "导出菜单项要带回调").toContain("onExportHtml");
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    expect(dlg, "主题必须有设置页入口").toMatch(/selectRow\(\s*"主题"/);
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

    // ---- ② 标题栏的窗口控制键也必须按「名字」取图（B97 起唯一的图标按钮组） ----
    const main = readFileSync("src/main.ts", "utf-8");
    for (const pair of [
      '[winMinimize, "chromeMinimize"]',
      '[winMaximize, "chromeMaximize"]',
      '[winClose, "chromeClose"]',
    ]) {
      expect(main, `标题栏缺 ${pair}`).toContain(pair);
    }
    expect(main, "窗口控制键必须从 CODICONS 取名取图").toContain("btn.innerHTML = CODICONS[name]");

    // ---- ③ 文件类型字形也必须走 codicon（不得再自建手绘字形表） ----
    const fi = readFileSync("src/shell/fileicons.ts", "utf-8");
    expect(fi, "家族字形必须从 CODICONS 取").toContain("CODICONS[");
    expect(fi, "不得再自建 GLYPHS 手绘表").not.toContain("GLYPHS");

    // ---- ④ 手绘豁免已全部收回（B97）----
    // 原先唯一的豁免是主题按钮的 sun / moon（官方 639 颗里没有日/月字形）。
    // 主题按钮随顶栏快捷按钮组一起移除后它们失去调用方，整个 icons.ts 被删 ——
    // 从此应用内**没有任何手绘图标**，codicon 是唯一来源。
    expect(existsSync("src/shell/icons.ts"), "手绘图标文件必须已删除").toBe(false);
  });

  it("B102 图标来源：直接用官方 npm 包 @vscode/codicons（依赖 + 官方图标字体）", () => {
    // B102 之前是把官方包里的 `src/icons/*.svg` 抽出来内联成 codicons.ts（生成物），
    // 那条路要维护「npm pack / unpkg curl / 本地参考副本」三条降级路径。现在依赖装上即用。
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      dependencies: Record<string, string>;
    };
    const ver = pkg.dependencies["@vscode/codicons"];
    expect(ver, "package.json 必须依赖 @vscode/codicons（图标唯一来源）").toBeTruthy();
    // 版本**钉死**：codicon 的字形/码位跨版本会变，^ 会让某次 npm i 悄悄换掉全部图标。
    expect(ver, "版本必须钉死（字形跨版本会变，不能给 ^）").not.toMatch(/^[\^~]/);

    // 官方样式必须由应用入口引入，且**排在本项目样式之前**：
    // `.codicon[class*='codicon-']` 与 `.panel-op .codicon` 特异性相同（0-2-0），
    // 谁在后谁生效 —— 引反了字号覆盖就静默失效（B102 当天就在这一条上踩过推理）。
    const main = readFileSync("src/main.ts", "utf-8");
    const codiconAt = main.indexOf("@vscode/codicons/dist/codicon.css");
    const globalAt = main.indexOf('"./styles/global.css"');
    expect(codiconAt, "main.ts 必须引入官方 codicon.css（否则图标全是豆腐块）").toBeGreaterThan(-1);
    expect(globalAt, "取不到 global.css 的引入位置").toBeGreaterThan(-1);
    expect(codiconAt, "codicon.css 必须排在 global.css 之前").toBeLessThan(globalAt);
    // 退化对照：把两行顺序调换，同一把尺子必须判出来（否则这条对「日后被换序」是瞎的）
    const swapped = main
      .replace('import "@vscode/codicons/dist/codicon.css";\n', "")
      .replace(
        'import "./styles/global.css";',
        'import "./styles/global.css";\nimport "@vscode/codicons/dist/codicon.css";',
      );
    expect(
      swapped.indexOf("@vscode/codicons/dist/codicon.css"),
      "退化对照要真的换序",
    ).toBeGreaterThan(swapped.indexOf('"./styles/global.css"'));

    // 反面：抽取脚本与内联 svg 都必须已经退场。
    expect(existsSync("scripts/fetch-codicons.mjs"), "上游 svg 抽取脚本必须已退役").toBe(false);
    // ⚠️ 先剥注释再判「不得写死码位」：codicons.ts 的说明里就举了 `content: "\e…"` 这个反例。
    const icons = stripCssComments(readFileSync("src/shell/codicons.ts", "utf-8"));
    expect(icons, "字形必须由官方字体绘制，不得再内联 svg").not.toContain("<svg");
    expect(icons, "不得写死码位（码位只属于官方 codicon.css）").not.toMatch(/content:\s*["']\\e/);
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

  it("B98 build-all.sh 必须拦住空壳 dist，并写明第 3 步产物不可交付", () => {
    // 09-23 一轮里连踩两个「退出码 0 ≠ 生效」的坑，都是交付物层面的静默失效：
    //   ① `tauri build` 的 vite 阶段被中断 → `dist` 只剩 `index.html`、`assets/` 全丢，
    //      但打包**照样 exit 0、日志全绿**，打出来的 exe 打开是一片空白；
    //   ② 把第 3 步 `cargo build --release` 的 exe 当交付物给了用户，打开显示
    //      「127.0.0.1 拒绝连接」—— 那个 exe 没注入 `custom-protocol`（tauri 里
    //      `dev = !custom-protocol`），是 dev 模式，会去连 `build.devUrl`。
    //      ⚠️ 因此「交付 exe」只能取第 4 步覆盖写的同名文件，中间产物必须被显式标注。
    // 判据放在 `tests/static.ts`，反向对照在 `tests/reverse-verify.test.ts`。
    const src = readFileSync("scripts/build-all.sh", "utf-8");
    expect(
      hasDistIntegrityGuard(src),
      "打包前必须点数 dist/assets，不合格就 exit 1（少了阻断那一半 = 只打印日志照样放行）",
    ).toBe(true);
    expect(
      hasStep3NotDeliverableWarning(src),
      "第 3 步必须标注「不可交付」，并点出 dev 模式的失败指纹（127.0.0.1）",
    ).toBe(true);
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

  it("B79 主题：档位必须写回 settings 才存得下（B97 起入口只剩首选项）", () => {
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

    // ---- ② 档位的可读落点：`<html data-theme-mode>` ----
    // 原先这里是「三态一律不点亮」——那条契约随循环按钮本身一起消失了（B97 移除了
    // 顶栏那颗主题按钮）。现在要守的是两件事：档位仍有个可读落点，且按钮的痕迹清干净。
    expect(main, "当前档位仍要写进 data 属性供测试/样式用").toContain(
      "document.documentElement.dataset.themeMode",
    );
    expect(main, "主题按钮的引用必须已清干净").not.toContain("btnTheme");
    const css = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
    expect(css, "顶栏快捷按钮那套样式必须已移除").not.toContain(".tool-btn");
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
