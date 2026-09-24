// @vitest-environment jsdom
// B106 统一设置页运行时测试：
// 1) 打开后是三栏结构（顶部搜索 + 左侧分类导航 + 右侧设置项），默认停在「外观」；
// 2) 控件初值取自 opts 的 getter，change 立即回调对应 setter（即时生效 + 持久化由 main 负责）；
// 3) 「快捷键」作为其中一个分类，复用 keymapdialog 的改键界面；
// 4) 顶部搜索按分类过滤左侧导航；
// 5) 关闭按钮 / Esc / 点蒙层都能关窗。
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { showSettingsDialog, type SettingsDialogOptions } from "../src/shell/settingsdialog";
import { DEFAULT_PRESET_ID, type KeymapOverrides } from "../src/shell/keymap";
import { ruleBlock, cssDecls, stripCssComments, stripLineComments } from "./static";

const noop = (): void => {};

function makeOpts(): SettingsDialogOptions {
  return {
    theme: () => "system",
    onTheme: noop,
    fontFamily: () => "",
    onFontFamily: noop,
    fontSize: () => 14,
    onFontSize: noop,
    editorLineHeight: () => 1.5,
    onEditorLineHeight: noop,
    previewLineHeight: () => 1.7,
    onPreviewLineHeight: noop,
    tocWidth: () => 240,
    onTocWidth: noop,
    defaultEol: () => "CRLF",
    eolOptions: () => ["CRLF", "LF", "CR"],
    onDefaultEol: noop,
    defaultEncoding: () => "UTF-8",
    encodingOptions: () => ["UTF-8", "GB18030"],
    onDefaultEncoding: noop,
    autosave: () => false,
    onAutosave: noop,
    hotExit: () => true,
    onHotExit: noop,
    tabStyle: () => "connected",
    onTabStyle: noop,
    tabActionReserveSpace: () => true,
    onTabActionReserveSpace: noop,
    keymap: {
      overrides: {} as KeymapOverrides,
      onChange: noop,
      preset: DEFAULT_PRESET_ID,
      onPresetChange: noop,
    },
  };
}

/** 在所有分类页里按标签文本找到行内自定义下拉控件（B108 起为 .dropdown）。 */
function rowControl(label: string): HTMLElement {
  const item = [...document.querySelectorAll(".settings-item")].find(
    (r) => r.querySelector(".settings-item-label")?.textContent === label,
  );
  expect(item, `行「${label}」应存在`).toBeTruthy();
  const ctl = item!.querySelector(".dropdown");
  expect(ctl, `行「${label}」应有下拉控件`).toBeTruthy();
  return ctl as HTMLElement;
}

/** 下拉当前值（写在容器的 data-value 上）。 */
function rowValue(label: string): string {
  return rowControl(label).dataset.value ?? "";
}

/** 下拉选项值列表。 */
function rowValues(label: string): string[] {
  return [...rowControl(label).querySelectorAll(".dropdown-option")].map(
    (o) => o.dataset.value ?? "",
  );
}

/** 选中某一下拉项的某个值（模拟点击选项，触发 onPick）。 */
function pickRow(label: string, value: string): void {
  const opt = [...rowControl(label).querySelectorAll(".dropdown-option")].find(
    (o) => o.dataset.value === value,
  ) as HTMLButtonElement | undefined;
  expect(opt, `下拉「${label}」应有值「${value}」的选项`).toBeTruthy();
  opt!.click();
}

function navItems(): string[] {
  return [...document.querySelectorAll(".settings-nav-item")].map((b) => b.textContent ?? "");
}

afterEach(() => {
  document.body.textContent = "";
});

describe("B106 统一设置页：三栏结构", () => {
  it("打开后是 顶部搜索 + 左侧分类 + 右侧内容 的三栏骨架", () => {
    showSettingsDialog(makeOpts());
    expect(document.querySelector(".settings-overlay"), "应有模态层").toBeTruthy();
    expect(document.querySelector(".settings-panel"), "应有面板").toBeTruthy();
    expect(
      document.querySelector(".settings-toolbar .settings-search"),
      "应有顶部搜索框",
    ).toBeTruthy();
    expect(document.querySelector(".settings-nav"), "应有左侧分类导航").toBeTruthy();
    expect(document.querySelector(".settings-content"), "应有右侧内容区").toBeTruthy();
  });

  it("左侧分类导航含 6 个分类（通用在前），默认停在「外观」", () => {
    showSettingsDialog(makeOpts());
    expect(navItems()).toEqual(["通用", "外观", "编辑器", "Markdown 预览", "新建文件", "快捷键"]);
    const appearance = [...document.querySelectorAll(".settings-page")].find(
      (p) => p.querySelector(".settings-page-title")?.textContent === "外观",
    ) as HTMLElement | undefined;
    expect(appearance, "应有外观分类页").toBeTruthy();
    expect(appearance!.hidden, "外观分类默认应可见").toBe(false);
    expect(rowValue("主题"), "默认主题应为 system").toBe("system");
  });

  it("点击左侧分类切到对应页（快捷键分类复用 keymapdialog）", () => {
    showSettingsDialog(makeOpts());
    const shortcutNav = [...document.querySelectorAll(".settings-nav-item")].find(
      (b) => b.textContent === "快捷键",
    ) as HTMLButtonElement;
    shortcutNav.click();
    expect(document.querySelector(".keymap-key"), "快捷键分类应渲染改键按钮").toBeTruthy();
    // 切走后外观页隐藏
    const appearance = [...document.querySelectorAll(".settings-page")].find(
      (p) => p.querySelector(".settings-page-title")?.textContent === "外观",
    ) as HTMLElement;
    expect(appearance.hidden, "切到快捷键后外观页应隐藏").toBe(true);
  });
});

describe("B106 设置项：初值 + 即时回调", () => {
  it("所有设置项初值取自 getter", () => {
    showSettingsDialog(makeOpts());
    for (const [label, val] of [
      ["主题", "system"],
      ["编辑器字体", ""],
      ["字号（px）", "14"],
      ["编辑器行距", "1.5"],
      ["预览行距", "1.7"],
      ["大纲宽度", "240"],
      ["默认行尾", "CRLF"],
      ["默认编码", "UTF-8"],
    ] as const) {
      expect(rowValue(label), `「${label}」初值应为 ${val}`).toBe(val);
    }
    expect(rowValues("默认行尾")).toEqual(["CRLF", "LF", "CR"]);
  });

  it("任何控件 change 立即回调对应 setter", () => {
    const opts = makeOpts();
    const calls: string[] = [];
    opts.onTheme = (m) => calls.push(`theme:${m}`);
    opts.onFontFamily = (f) => calls.push(`font:${f}`);
    opts.onFontSize = (px) => calls.push(`size:${px}`);
    opts.onEditorLineHeight = (v) => calls.push(`elh:${v}`);
    opts.onPreviewLineHeight = (v) => calls.push(`plh:${v}`);
    opts.onTocWidth = (w) => calls.push(`toc:${w}`);
    opts.onDefaultEol = (e) => calls.push(`eol:${e}`);
    opts.onDefaultEncoding = (e) => calls.push(`enc:${e}`);
    showSettingsDialog(opts);

    const fire = (label: string, value: string): void => {
      pickRow(label, value);
    };

    fire("主题", "dark");
    fire("编辑器字体", "Consolas");
    fire("字号（px）", "18");
    fire("编辑器行距", "1.8");
    fire("预览行距", "2.1");
    fire("大纲宽度", "320");
    fire("默认行尾", "LF");
    fire("默认编码", "GB18030");

    expect(calls).toEqual([
      "theme:dark",
      "font:Consolas",
      "size:18",
      "elh:1.8",
      "plh:2.1",
      "toc:320",
      "eol:LF",
      "enc:GB18030",
    ]);
    // 即时生效模式：弹窗不因修改而关闭
    expect(document.querySelector(".settings-panel")).toBeTruthy();
  });

  it("B108：「通用」分类承载自动保存 / 热退出，初值取自 getter，切换立即回调", () => {
    const opts = makeOpts();
    const calls: string[] = [];
    opts.autosave = () => false;
    opts.onAutosave = (v) => calls.push(`autosave:${v}`);
    opts.hotExit = () => true;
    opts.onHotExit = (v) => calls.push(`hotExit:${v}`);
    showSettingsDialog(opts);

    // 切到「通用」分类（默认停在「外观」）
    const generalNav = [...document.querySelectorAll(".settings-nav-item")].find(
      (b) => b.textContent === "通用",
    ) as HTMLButtonElement;
    generalNav.click();

    // B111：开关是自绘 switch（role=switch + aria-checked），不再是原生 checkbox
    const find = (label: string): HTMLElement => {
      const item = [...document.querySelectorAll(".settings-item")].find(
        (r) => r.querySelector(".settings-item-label")?.textContent === label,
      );
      expect(item, `「通用」分类应有「${label}」`).toBeTruthy();
      const sw = item!.querySelector(".switch") as HTMLElement | null;
      expect(sw, `「${label}」应是自绘 .switch`).toBeTruthy();
      expect(sw!.tagName, "switch 外壳应是 button（白拿键盘与焦点环）").toBe("BUTTON");
      expect(sw!.getAttribute("role"), "switch 必须声明 role=switch").toBe("switch");
      return sw!;
    };
    expect(find("自动保存").getAttribute("aria-checked"), "自动保存默认关").toBe("false");
    expect(find("热退出").getAttribute("aria-checked"), "热退出默认开").toBe("true");

    find("自动保存").click();
    find("热退出").click();

    expect(calls).toEqual(["autosave:true", "hotExit:false"]);
    // 状态与 aria-checked 同步 —— 样式只认 aria-checked（.switch[aria-checked="true"]），
    // 不同步就会出现「点了没反应」的观感。
    expect(find("自动保存").getAttribute("aria-checked"), "点后应变开").toBe("true");
    expect(find("热退出").getAttribute("aria-checked"), "点后应变关").toBe("false");
  });
});

describe("B106 设置页：搜索过滤 + 关闭", () => {
  it("顶部搜索按分类过滤左侧导航", () => {
    showSettingsDialog(makeOpts());
    const search = document.querySelector(".settings-search") as HTMLInputElement;

    search.value = "预览";
    search.dispatchEvent(new Event("input"));
    const visible = navItems().filter((_, i) => {
      return !(document.querySelectorAll(".settings-nav-item")[i] as HTMLElement).hidden;
    });
    expect(visible, "搜「预览」应只剩 Markdown 预览分类").toEqual(["Markdown 预览"]);

    // 清空后全部恢复
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(
      navItems().every((_, i) => {
        return !(document.querySelectorAll(".settings-nav-item")[i] as HTMLElement).hidden;
      }),
      "清空搜索应恢复全部分类",
    ).toBe(true);
  });

  it("关闭按钮 / Esc / 点蒙层都能关窗", () => {
    showSettingsDialog(makeOpts());

    // Esc 关窗
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".settings-panel"), "Esc 应关窗").toBeNull();

    // 蒙层点击关窗（点面板内部不关）
    showSettingsDialog(makeOpts());
    const overlay = document.querySelector(".settings-overlay")!;
    (overlay as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".settings-panel"), "点蒙层应关窗").toBeNull();

    // 关闭按钮关窗
    showSettingsDialog(makeOpts());
    const close = document.querySelector(".settings-close") as HTMLButtonElement;
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".settings-panel"), "关闭按钮应关窗").toBeNull();
  });
});

describe("B106 设置页：接线守卫", () => {
  it("preferencesdialog.ts 已删除，统一设置页文件存在并接线到 main.ts", () => {
    expect(existsSync("src/shell/preferencesdialog.ts"), "旧的 preferencesdialog.ts 应已删除").toBe(
      false,
    );
    expect(existsSync("src/shell/settingsdialog.ts"), "统一设置页文件应存在").toBe(true);

    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "main 必须引入 showSettingsDialog").toContain("showSettingsDialog(");
    expect(main, "main 必须有打开设置页的函数").toContain("function openSettingsDialog(");
    expect(main, "菜单回调必须接到 onSettings").toContain("onSettings: () => openSettingsDialog()");
    expect(main, "不得再残留 openPreferencesDialog").not.toContain(
      "function openPreferencesDialog(",
    );

    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单栏回调接口必须有 onSettings").toContain("onSettings:");
    expect(menu, "不得再残留 onPreferences").not.toContain("onPreferences");
    expect(menu, "不得再残留 onKeymap").not.toContain("onKeymap");
    expect(menu, "不得再有「设置」顶层菜单").not.toContain('label: "设置"');
    expect(menu, "文件菜单必须含「设置…」入口").toContain('label: "设置…"');
  });
});

describe("B111 设置页：switch 组件 + 快捷键搜索框 Esc", () => {
  /** 切到「快捷键」分类（默认停在「外观」）。 */
  function gotoShortcuts(): HTMLInputElement {
    const shortcutNav = [...document.querySelectorAll(".settings-nav-item")].find(
      (b) => b.textContent === "快捷键",
    ) as HTMLButtonElement;
    shortcutNav.click();
    const input = document.querySelector<HTMLInputElement>(".keymap-search");
    expect(input, "快捷键分类应有搜索框").toBeTruthy();
    return input!;
  }

  function pressEscape(): void {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  it("快捷键分类下 Esc 先清空搜索框，再按一次才关窗", () => {
    showSettingsDialog(makeOpts());
    const input = gotoShortcuts();

    input.value = "大纲";
    input.dispatchEvent(new Event("input"));
    expect([...document.querySelectorAll(".keymap-cmd")].map((e) => e.textContent)).toEqual([
      "显示/隐藏大纲 TOC",
    ]);

    // 第一次 Esc：只清空，窗还在
    pressEscape();
    expect(document.querySelector(".settings-panel"), "有内容时 Esc 不应关窗").toBeTruthy();
    expect(input.value, "Esc 应清空搜索框").toBe("");
    expect(
      document.querySelectorAll(".keymap-cmd").length,
      "清空后应重新筛选（列表恢复全量）",
    ).toBeGreaterThan(1);

    // 第二次 Esc：关窗
    pressEscape();
    expect(document.querySelector(".settings-panel"), "空框时 Esc 应关窗").toBeNull();
  });

  it("搜索框为空时 Esc 直接关窗（不会白吃一次按键）", () => {
    showSettingsDialog(makeOpts());
    gotoShortcuts();
    pressEscape();
    expect(document.querySelector(".settings-panel")).toBeNull();
  });

  it("不在快捷键分类时 Esc 直接关窗（不被隐藏的搜索框吃掉）", () => {
    showSettingsDialog(makeOpts());
    const input = document.querySelector<HTMLInputElement>(".keymap-search")!;
    input.value = "大纲";
    input.dispatchEvent(new Event("input"));
    pressEscape();
    expect(document.querySelector(".settings-panel")).toBeNull();
  });

  it("守卫：设置页不再生成原生 checkbox，改用 src/shell/switch.ts", () => {
    expect(existsSync("src/shell/switch.ts"), "switch 组件文件应存在").toBe(true);

    const code = stripLineComments(readFileSync("src/shell/settingsdialog.ts", "utf-8"));
    expect(code, "设置页应引入 createSwitch").toContain('from "./switch"');
    expect(code, "设置页不应再有原生 checkbox").not.toContain('type = "checkbox"');
    expect(code, "不应再残留 .settings-toggle").not.toContain("settings-toggle");
    expect(code, "Esc 处理必须先问 clearSearch").toContain("clearSearch()");

    const sw = stripLineComments(readFileSync("src/shell/switch.ts", "utf-8"));
    expect(sw, "switch 必须声明 role=switch").toContain('"switch"');
    expect(sw, "状态必须落在 aria-checked（样式只认它）").toContain("aria-checked");
  });

  it("守卫：.switch 样式由 aria-checked 驱动（轨道 + 滑块）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(
      cssDecls(ruleBlock(css, ".switch")),
      "轨道应声明 position: relative（滑块的定位基准）",
    ).toContain("position: relative");
    expect(cssDecls(ruleBlock(css, ".switch-knob")), "滑块应是圆点").toContain(
      "border-radius: 50%",
    );
    expect(
      cssDecls(ruleBlock(css, '.switch[aria-checked="true"]')),
      "开启态轨道应填 accent",
    ).toContain("background: var(--accent)");
    expect(
      cssDecls(ruleBlock(css, '.switch[aria-checked="true"] .switch-knob')),
      "滑块位移应走 transform（合成层，不触发重排）",
    ).toContain("transform: translateX(");
    expect(stripCssComments(css), "不应再残留 .settings-toggle 复选框规则").not.toContain(
      ".settings-toggle",
    );
  });

  it("守卫：快捷键搜索框聚焦高光与设置页顶部搜索框同款", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const focus = cssDecls(ruleBlock(css, ".keymap-search:focus"));
    expect(focus, "应有 accent 边框").toContain("border-color: var(--accent)");
    expect(focus, "应有 1px accent 外环").toContain("box-shadow: 0 0 0 1px var(--accent)");

    const wrap = cssDecls(ruleBlock(css, ".settings-search-wrap:focus-within"));
    expect(wrap, "顶部搜索框同样是 accent 边框").toContain("border-color: var(--accent)");
    expect(wrap, "顶部搜索框同样是 1px accent 环").toContain("box-shadow: 0 0 0 1px var(--accent)");
  });
});
