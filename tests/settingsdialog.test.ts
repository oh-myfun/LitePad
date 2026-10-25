// @vitest-environment jsdom
// B106 统一设置页运行时测试：
// 1) 打开后是三栏结构（顶部搜索 + 左侧分类导航 + 右侧设置项），默认停在「通用」；
// 2) 控件初值取自 opts 的 getter，change 立即回调对应 setter（即时生效 + 持久化由 main 负责）；
// 3) 「快捷键」作为其中一个分类，复用 keymapdialog 的改键界面；
// 4) 顶部搜索按分类过滤左侧导航；
// 5) 关闭按钮 / Esc / 点蒙层都能关窗。
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  showSettingsDialog,
  fontOptionsFor,
  type SettingsDialogOptions,
  DEFAULT_BODY_FONT_LABEL,
  DEFAULT_CODE_FONT_LABEL,
  FONT_FAMILY_NO_DIFF_SUFFIX,
} from "../src/shell/settingsdialog";
import { DEFAULT_PRESET_ID, type KeymapOverrides } from "../src/shell/keymap";
import { ruleBlock, cssDecls, stripCssComments, stripLineComments, resolveCssVars } from "./static";

const noop = (): void => {};

/** B385：设置页关联分类的内存夹具（jsdom 无 IPC / 注册表）。
 *  B385 二轮起预设是文本格式全家桶，夹具照 Rust CANDIDATE_EXTS 的量级造。 */
const ASSOC_PRESET_EXTS = [
  "md",
  "markdown",
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "ts",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "cs",
  "sh",
  "bat",
  "cmd",
  "ps1",
  "sql",
];
const ASSOC_FIXTURE: { ext: string; registered: boolean; isDefault: boolean }[] =
  ASSOC_PRESET_EXTS.map((ext) => ({
    ext,
    registered: ext === "md",
    isDefault: ext === "md",
  }));

function makeOpts(): SettingsDialogOptions {
  return {
    theme: () => "system",
    onTheme: noop,
    themeFamily: () => "2026",
    onThemeFamily: noop,
    fontFamily: () => "",
    onFontFamily: noop,
    // B227：代码字体 + 本机枚举清单（枚举空 ⇒ 退回内置手抄清单那份候选）
    codeFontFamily: () => "",
    onCodeFontFamily: noop,
    // B347：界面字体（只有窗口外壳），与正文/代码各一栏
    uiFontFamily: () => "",
    onUiFontFamily: noop,
    systemFonts: () => [],
    fontSize: () => 14,
    onFontSize: noop,
    editorLineHeight: () => 1.5,
    onEditorLineHeight: noop,
    previewLineHeight: () => 1.7,
    onPreviewLineHeight: noop,
    // B235：顶掉了原先的 sideWidth / onTocWidth（设置页不再有「大纲宽度」那一项）
    previewWidth: () => "full",
    onPreviewWidth: noop,
    defaultEol: () => "CRLF",
    eolOptions: () => ["CRLF", "LF", "CR"],
    onDefaultEol: noop,
    defaultEncoding: () => "UTF-8",
    encodingOptions: () => ["UTF-8", "GB18030"],
    onDefaultEncoding: noop,
    // B372：新建空白文档的默认类型（空串 = 自动 / 纯文本）
    defaultLang: () => "",
    languageOptions: () => ["Markdown", "Plain Text", "JSON"],
    onDefaultLang: noop,
    // B385：文件关联（jsdom 里不走真 IPC —— 假数据在内存里翻）
    // 照 Rust candidate_exts 的口径：按扩展名排序后返回
    assocEntries: async () => [...ASSOC_FIXTURE].sort((a, b) => a.ext.localeCompare(b.ext)),
    onAssocSet: async (ext, on) => {
      // 照 Rust normalize_ext 的口径拒非法名（jsdom 里没有真 IPC / 注册表）
      const norm = ext.trim().replace(/^\.+/, "").toLowerCase();
      if (!norm || norm.length > 16 || !/^[0-9a-z_+~ -]*$/.test(norm) || norm.includes(" ")) {
        throw new Error(`不支持的扩展名：${ext}`);
      }
      let e = ASSOC_FIXTURE.find((x) => x.ext === norm);
      if (!e) {
        e = { ext: norm, registered: false, isDefault: false };
        ASSOC_FIXTURE.push(e);
      }
      e.registered = on;
      e.isDefault = on && norm !== "txt";
      return e;
    },
    onOpenDefaultApps: noop,
    autosave: () => false,
    onAutosave: noop,
    hotExit: () => true,
    onHotExit: noop,
    tabStyle: () => "connected",
    onTabStyle: noop,
    tabActionReserveSpace: () => true,
    onTabActionReserveSpace: noop,
    // B288：日志级别 —— 走独立的 log_level / set_log_level IPC（Rust 侧持有并即时生效），
    // **不读 settings**；另一项是「打开日志文件」的动作回调。
    logLevel: () => "info",
    onLogLevel: noop,
    onOpenLog: noop,
    // B305：最近打开保留数量 —— 与日志级别同款：**不读 settings**，值由 Rust 持有
    //（名单存 recents.json，那张表没有权威窗口，见 src-tauri/src/session/recent.rs 头部）。
    recentLimit: () => 20,
    onRecentLimit: noop,
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
  return [...rowControl(label).querySelectorAll<HTMLElement>(".dropdown-option")].map(
    (o) => o.dataset.value ?? "",
  );
}

/** 选中某一下拉项的某个值（模拟点击选项，触发 onPick）。 */
function pickRow(label: string, value: string): void {
  const opt = [...rowControl(label).querySelectorAll<HTMLElement>(".dropdown-option")].find(
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
    expect(document.querySelector(".settings-window"), "应有面板").toBeTruthy();
    expect(
      document.querySelector(".settings-toolbar .settings-search"),
      "应有顶部搜索框",
    ).toBeTruthy();
    expect(document.querySelector(".settings-nav"), "应有左侧分类导航").toBeTruthy();
    expect(document.querySelector(".settings-content"), "应有右侧内容区").toBeTruthy();
  });

  it("B353：外面套的是窗框 —— 标题栏 + 八向把手，尺寸位置只由窗框写 inline style", () => {
    showSettingsDialog(makeOpts());
    const win = document.querySelector(".settings-window") as HTMLElement;
    expect(win, "应有设置窗").toBeTruthy();
    expect(win.classList.contains("win-frame"), "面板本体必须就是那块窗框").toBe(true);
    const head = win.querySelector(":scope > .win-head") as HTMLElement;
    expect(head, "标题栏要是窗框的**直接**子节点（挂在里面就拖不动了）").toBeTruthy();
    expect(
      (head.querySelector(".win-title") as HTMLElement).textContent,
      "标题栏要写着「设置」",
    ).toBe("设置");
    expect(head.querySelector(".win-head-close"), "关闭键搬进标题栏").toBeTruthy();
    expect(
      win.querySelector(".settings-toolbar .settings-close"),
      "工具栏不该再留一颗关闭键（两处各一颗 = 两个权威）",
    ).toBeNull();
    expect(win.querySelectorAll(":scope > .win-resize"), "八向把手必须齐").toHaveLength(8);
    expect(win.style.left, "位置由窗框写成 inline style").toMatch(/^-?\d+px$/);
    expect(win.style.width, "尺寸同上，不靠 CSS").toMatch(/^\d+px$/);

    // 反向盯 CSS 那一头：这一档尺寸原先就写在 `.settings-panel` 里，拖过一次之后
    // 它会与窗框写的 inline style 打对台 ⇒ 类名换成 .settings-window 也不许再写几何。
    const code = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
    for (const prop of ["width", "height", "left", "top", "margin"]) {
      expect(
        code,
        `.settings-window 的规则里不得写 ${prop}（几何只许在 settingsdialog.ts 的默认矩形那一处）`,
      ).not.toMatch(new RegExp(`\\.settings-window[^{}]*\\{[^}]*\\b${prop}:`));
    }
    const BAD = code + "\n.settings-window { width: 880px; }\n";
    expect(BAD, "替身必须真的写回了几何").not.toBe(code);
    expect(() => {
      expect(BAD, "替身那份第二个权威必须被抓到").not.toMatch(
        /\.settings-window[^{}]*\{[^}]*\bwidth:/,
      );
    }).toThrow();
  });

  it("左侧分类导航含 6 个分类（通用在前），默认停在「通用」", () => {
    showSettingsDialog(makeOpts());
    // B229：原「Markdown 预览」分类已并入「编辑器」，导航少一项。
    expect(navItems()).toEqual(["通用", "外观", "编辑器", "新建文件", "文件关联", "快捷键"]);
    const pageByTitle = (t: string) =>
      [...document.querySelectorAll(".settings-page")].find(
        (p) => p.querySelector(".settings-page-title")?.textContent === t,
      ) as HTMLElement | undefined;
    const general = pageByTitle("通用");
    const appearance = pageByTitle("外观");
    expect(general, "应有通用分类页").toBeTruthy();
    expect(appearance, "应有外观分类页").toBeTruthy();
    expect(general!.hidden, "通用分类默认应可见（B323 用户口径：打开设置先落在通用）").toBe(false);
    expect(appearance!.hidden, "默认停在通用 ⇒ 外观那一页此刻该藏着").toBe(true);
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

describe("B288 通用页：日志级别 + 打开日志文件", () => {
  it("日志级别下拉五档齐全，默认 info，改选回调新级别", () => {
    const opts = makeOpts();
    const picked: string[] = [];
    opts.onLogLevel = (v) => {
      picked.push(v);
    };
    showSettingsDialog(opts);
    expect(rowValue("日志级别"), "默认应为 info").toBe("info");
    expect(rowValues("日志级别"), "五档应齐全且按低→高排").toEqual([
      "error",
      "warn",
      "info",
      "debug",
      "trace",
    ]);
    // 排查时临时开 debug —— 回调必须把新级别交出去（main 侧走 setLevelPersisted 即时生效）
    pickRow("日志级别", "debug");
    expect(picked, "改选应回调新级别").toEqual(["debug"]);
  });

  it("「日志文件」行的按钮点击触发 onOpenLog（一键打开 litepad.log）", () => {
    const opts = makeOpts();
    let opened = 0;
    opts.onOpenLog = () => {
      opened += 1;
    };
    showSettingsDialog(opts);
    const btn = [...document.querySelectorAll(".settings-item")]
      .find((r) => r.querySelector(".settings-item-label")?.textContent === "日志文件")
      ?.querySelector("button.settings-mini-btn") as HTMLButtonElement | undefined;
    expect(btn, "「日志文件」行应有一颗按钮").toBeTruthy();
    btn!.click();
    expect(opened, "点击应触发 onOpenLog 一次").toBe(1);
  });
});

describe("B106 设置项：初值 + 即时回调", () => {
  it("所有设置项初值取自 getter", () => {
    showSettingsDialog(makeOpts());
    for (const [label, val] of [
      ["主题", "system"],
      ["内置主题", "2026"],
      ["正文字体", ""],
      ["字号（px）", "14"],
      ["编辑器行距", "1.5"],
      ["预览行距", "1.7"],
      ["预览布局宽度", "full"],
      ["默认文档类型", ""],
      ["默认行尾", "CRLF"],
      ["默认编码", "UTF-8"],
    ] as const) {
      expect(rowValue(label), `「${label}」初值应为 ${val}`).toBe(val);
    }
    expect(rowValues("默认行尾")).toEqual(["CRLF", "LF", "CR"]);
    expect(rowValues("默认文档类型"), "自动检测置顶，后接语言注册表").toEqual([
      "",
      "Markdown",
      "Plain Text",
      "JSON",
    ]);
    expect(
      rowControl("默认文档类型").querySelector(".dropdown-search"),
      "语言有 60+ 条，应带搜索框",
    ).toBeTruthy();
  });

  it("任何控件 change 立即回调对应 setter", () => {
    const opts = makeOpts();
    const calls: string[] = [];
    opts.onTheme = (m) => calls.push(`theme:${m}`);
    opts.onThemeFamily = (f) => calls.push(`family:${f}`);
    opts.onFontFamily = (f) => calls.push(`font:${f}`);
    opts.onFontSize = (px) => calls.push(`size:${px}`);
    opts.onEditorLineHeight = (v) => calls.push(`elh:${v}`);
    opts.onPreviewLineHeight = (v) => calls.push(`plh:${v}`);
    opts.onPreviewWidth = (w) => calls.push(`pw:${w}`);
    opts.onDefaultEol = (e) => calls.push(`eol:${e}`);
    opts.onDefaultEncoding = (e) => calls.push(`enc:${e}`);
    opts.onDefaultLang = (l) => calls.push(`lang:${l}`);
    showSettingsDialog(opts);

    const fire = (label: string, value: string): void => {
      pickRow(label, value);
    };

    fire("主题", "dark");
    fire("内置主题", "classic");
    fire("正文字体", "Consolas");
    fire("字号（px）", "18");
    fire("编辑器行距", "1.8");
    fire("预览行距", "2.1");
    fire("预览布局宽度", "standard");
    fire("默认文档类型", "Markdown");
    fire("默认行尾", "LF");
    fire("默认编码", "GB18030");

    expect(calls).toEqual([
      "theme:dark",
      "family:classic",
      "font:Consolas",
      "size:18",
      "elh:1.8",
      "plh:2.1",
      "pw:standard",
      "lang:Markdown",
      "eol:LF",
      "enc:GB18030",
    ]);
    // 即时生效模式：弹窗不因修改而关闭
    expect(document.querySelector(".settings-window")).toBeTruthy();
  });

  it("B108：「通用」分类承载自动保存 / 热退出，初值取自 getter，切换立即回调", () => {
    const opts = makeOpts();
    const calls: string[] = [];
    opts.autosave = () => false;
    opts.onAutosave = (v) => calls.push(`autosave:${v}`);
    opts.hotExit = () => true;
    opts.onHotExit = (v) => calls.push(`hotExit:${v}`);
    showSettingsDialog(opts);

    // 「通用」是 B323 之后的默认页，这一发点击点的是**已经停着**的那一页 —— 顺带钉住重点不炸
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
    expect(visible, "搜「预览」应命中已并入预览项的编辑器分类").toEqual(["编辑器"]);

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
    expect(document.querySelector(".settings-window"), "Esc 应关窗").toBeNull();

    // 蒙层点击关窗（点面板内部不关）
    showSettingsDialog(makeOpts());
    const overlay = document.querySelector(".settings-overlay")!;
    (overlay as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".settings-window"), "点蒙层应关窗").toBeNull();

    // 关闭按钮关窗
    showSettingsDialog(makeOpts());
    const close = document.querySelector(".win-head-close") as HTMLButtonElement;
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".settings-window"), "关闭按钮应关窗").toBeNull();
  });
});

describe("B106 设置页：接线守卫", () => {
  it("preferencesdialog.ts 已删除，统一设置页文件存在并接线到 main.ts", () => {
    expect(existsSync("src/shell/preferencesdialog.ts"), "旧的 preferencesdialog.ts 应已删除").toBe(
      false,
    );
    expect(existsSync("src/shell/settingsdialog.ts"), "统一设置页文件应存在").toBe(true);

    const main =
      readFileSync("src/main.ts", "utf-8") +
      "\n" +
      readFileSync("src/prefs.ts", "utf-8") +
      "\n" +
      readFileSync("src/commands.ts", "utf-8");
    expect(main, "main 必须引入 showSettingsDialog").toContain("showSettingsDialog(");
    expect(main, "main 必须有打开设置页的函数").toContain("function openSettingsDialog(");
    // B239：openSettingsDialog 改成 async（开页前要 await 字体枚举），菜单回调包 void
    expect(main, "菜单回调必须接到 onSettings").toContain(
      "onSettings: () => void openSettingsDialog()",
    );
    expect(main, "不得再残留 openPreferencesDialog").not.toContain(
      "function openPreferencesDialog(",
    );

    const menu = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menu, "菜单栏回调接口必须有 onSettings").toContain("onSettings:");
    expect(menu, "不得再残留 onPreferences").not.toContain("onPreferences");
    expect(menu, "不得再残留 onKeymap").not.toContain("onKeymap");
    // 顶层条目的形状是 `label: "X"` 紧跟 `items:`；菜单文案去掉省略号后，旧的
    // not.toContain('label: "设置"') 会被「文件」里那颗叶子命中 ⇒ 改成按形状判。
    expect(menu, "不得再有「设置」顶层菜单").not.toMatch(/label:\s*"设置",\s*\n\s*items:/);
    expect(menu, "文件菜单必须含「设置」入口").toContain('label: "设置", onSelect: cb.onSettings');
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
    expect(document.querySelector(".settings-window"), "有内容时 Esc 不应关窗").toBeTruthy();
    expect(input.value, "Esc 应清空搜索框").toBe("");
    expect(
      document.querySelectorAll(".keymap-cmd").length,
      "清空后应重新筛选（列表恢复全量）",
    ).toBeGreaterThan(1);

    // 第二次 Esc：关窗
    pressEscape();
    expect(document.querySelector(".settings-window"), "空框时 Esc 应关窗").toBeNull();
  });

  it("搜索框为空时 Esc 直接关窗（不会白吃一次按键）", () => {
    showSettingsDialog(makeOpts());
    gotoShortcuts();
    pressEscape();
    expect(document.querySelector(".settings-window")).toBeNull();
  });

  it("不在快捷键分类时 Esc 直接关窗（不被隐藏的搜索框吃掉）", () => {
    showSettingsDialog(makeOpts());
    const input = document.querySelector<HTMLInputElement>(".keymap-search")!;
    input.value = "大纲";
    input.dispatchEvent(new Event("input"));
    pressEscape();
    expect(document.querySelector(".settings-window")).toBeNull();
  });

  it("守卫：设置页不再生成原生 checkbox，改用 src/shell/switch.ts", () => {
    expect(existsSync("src/shell/switch.ts"), "switch 组件文件应存在").toBe(true);

    const code = stripLineComments(readFileSync("src/shell/settingsdialog.ts", "utf-8"));
    expect(code, "设置页应引入 createSwitch").toContain('from "./switch"');
    // B385 二轮：关联网格是 native checkbox 的**唯一**豁免区（勾选语义），其余设置行
    // 仍一律 switch —— 判据按形状切：fillAssocPage 之前不许有 checkbox。
    const beforeAssoc = code.slice(0, code.indexOf("function fillAssocPage"));
    expect(beforeAssoc, "设置行不应再有原生 checkbox（关联网格除外）").not.toContain(
      'type = "checkbox"',
    );
    const assocCode = code.slice(code.indexOf("function fillAssocPage"));
    expect(assocCode, "关联网格用 native checkbox + accent-color").toContain('type = "checkbox"');
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

// B227 起两栏：B231 调整为「正文字体（**只**预览模式正文）」与
// 「代码字体（编辑器源码区 + 预览里的行内代码/代码块）」；两栏的候选都来自
// 本机枚举，并各带一个 全部/等宽 的小切换。
describe("B236 字体三栏：界面 / 正文 / 代码 + 比例·等宽切换（各栏候选同一份）", () => {
  const SYS = [
    { name: "Consolas", is_monospace: true },
    { name: "Cascadia Code", is_monospace: true },
    { name: "Microsoft YaHei UI", is_monospace: false },
    { name: "Arial", is_monospace: false },
  ];
  function openWithFonts(): void {
    showSettingsDialog({ ...makeOpts(), systemFonts: () => SYS });
  }
  /** 该行「比例 / 等宽」小切换里的那颗按钮（按**文案**定位）。 */
  function tab(label: string, text: string): HTMLElement {
    const item = [...document.querySelectorAll(".settings-item")].find(
      (r) => r.querySelector(".settings-item-label")?.textContent === label,
    );
    const btn = [...(item?.querySelectorAll(".font-picker-tab") ?? [])].find(
      (b) => b.textContent === text,
    ) as HTMLElement | undefined;
    expect(btn, `行「${label}」应有「${text}」小切换`).toBeTruthy();
    return btn!;
  }

  it("两行都在：正文默认停「比例」、代码默认停「等宽」", () => {
    openWithFonts();
    rowControl("正文字体");
    rowControl("代码字体");
    // 默认项（value 空串 = 回落内嵌栈）必须在首位
    expect(rowValues("正文字体")[0], "默认项要在首位").toBe("");
    expect(rowValues("代码字体")[0], "默认项要在首位").toBe("");
    // 正文默认「比例」⇒ 比例字体在、等宽不在
    expect(rowValues("正文字体")).toContain("Microsoft YaHei UI");
    expect(rowValues("正文字体"), "比例档不该混进等宽").not.toContain("Consolas");
    // 代码默认「等宽」⇒ 等宽在、比例不在
    expect(rowValues("代码字体")).toContain("Consolas");
    expect(rowValues("代码字体"), "等宽档不该混进比例").not.toContain("Microsoft YaHei UI");
  });

  it("两栏的候选集合完全一样（只差默认停哪一档 + 内嵌默认那一项的说法）", () => {
    openWithFonts();
    // 初始：正文停「比例」、代码停「等宽」⇒ 此刻两栏**不同**（这是「默认落点不同」）
    expect(rowValues("正文字体")).not.toEqual(rowValues("代码字体"));
    // 把代码那栏也切到「比例」⇒ 两栏逐项相同（value 层面含空串那一项）
    tab("代码字体", "比例").click();
    expect(rowValues("代码字体"), "都切到比例后两栏应逐项相同").toEqual(rowValues("正文字体"));
    // 再都切到「等宽」⇒ 仍然逐项相同
    tab("正文字体", "等宽").click();
    tab("代码字体", "等宽").click();
    expect(rowValues("正文字体"), "都切到等宽后两栏应逐项相同").toEqual(rowValues("代码字体"));
    expect(rowValues("正文字体").length, "两栏都得有候选").toBeGreaterThan(1);
  });

  it("切档只影响自己那一栏，另一栏不跟着变", () => {
    openWithFonts();
    tab("正文字体", "等宽").click();
    expect(rowValues("正文字体"), "系统等宽要留下").toContain("Consolas");
    expect(rowValues("正文字体")).not.toContain("Microsoft YaHei UI");
    // 另一栏记住自己那一档
    expect(rowValues("代码字体")).not.toContain("Microsoft YaHei UI");

    tab("正文字体", "比例").click();
    expect(rowValues("正文字体"), "切回比例要恢复").toContain("Microsoft YaHei UI");

    tab("代码字体", "比例").click();
    expect(rowValues("代码字体")).toContain("Microsoft YaHei UI");
  });

  it("选值会回调对应 setter（正文走 onFontFamily，代码走 onCodeFontFamily）", () => {
    const seen: string[] = [];
    const seenCode: string[] = [];
    showSettingsDialog({
      ...makeOpts(),
      systemFonts: () => SYS,
      onFontFamily: (v) => seen.push(v),
      onCodeFontFamily: (v) => seenCode.push(v),
    });
    // 正文默认停在「比例」档 ⇒ 挑一个比例字体；代码栏挑等宽那个
    pickRow("正文字体", "Arial");
    pickRow("代码字体", "Consolas");
    expect(seen, "正文字体要回调 onFontFamily").toEqual(["Arial"]);
    expect(seenCode, "代码字体要回调 onCodeFontFamily").toEqual(["Consolas"]);
  });

  it("B347：界面字体那一栏默认停「比例」，选值回调 onUiFontFamily", () => {
    const seenUi: string[] = [];
    showSettingsDialog({
      ...makeOpts(),
      systemFonts: () => SYS,
      onUiFontFamily: (v) => seenUi.push(v),
    });
    expect(rowValues("界面字体")[0], "默认项（空串 = 内嵌那颗别名）要在首位").toBe("");
    expect(rowValues("界面字体"), "界面字体默认停「比例」档").toContain("Arial");
    expect(rowValues("界面字体"), "比例档不该混进等宽").not.toContain("Consolas");
    pickRow("界面字体", "Arial");
    expect(seenUi, "界面字体要回调 onUiFontFamily").toEqual(["Arial"]);
    // 反向对照（防恒真）：这一族断言全靠「按标签取行」，标签不存在时辅助函数必须**报错**，
    // 否则上面几条就是在对着空气打勾。
    expect(() => rowValues("没有这一栏"), "不存在的标签必须取不到行").toThrow();
  });
});

describe("B234 字体候选：内嵌默认 + 系统全量（等宽判定已修）", () => {
  const SYS = [
    { name: "Consolas", is_monospace: true },
    { name: "Cascadia Mono", is_monospace: true },
    { name: "Arial", is_monospace: false },
    { name: "Segoe UI", is_monospace: false },
    { name: "Microsoft YaHei UI", is_monospace: false },
  ];

  it("内嵌默认项在首位，两档互斥（比例档不含等宽、等宽档不含比例）", () => {
    for (const kind of ["proportional", "mono"] as const) {
      const opts = fontOptionsFor(kind, "", SYS, "默认（内嵌思源黑体）");
      // ⚠️ 反向闸排在正向断言之前：默认项的 value 必须是空串（= 移除变量、回落内嵌栈）
      expect(opts[0].value, `${kind} 栏默认项的 value 应为空串`).toBe("");
      expect(opts[0].label, "默认项要在首位").toContain("内嵌");
    }
    // B236：两档**互斥**（原来是「全部 / 等宽」，等宽混在全部里）—— 分开断言
    const prop = fontOptionsFor("proportional", "", SYS, "默认（内嵌思源黑体）").map(
      (o) => o.value,
    );
    expect(prop, "比例档要有比例字体").toContain("Arial");
    expect(prop, "比例档要有 Segoe UI").toContain("Segoe UI");
    expect(prop, "比例档不该混进等宽").not.toContain("Consolas");
    expect(prop, "比例档不该混进等宽").not.toContain("Cascadia Mono");
    const mono = fontOptionsFor("mono", "", SYS, "默认（内嵌思源黑体）").map((o) => o.value);
    expect(mono, "等宽档要有系统等宽字体").toContain("Consolas");
    expect(mono, "等宽档要有 Cascadia Mono").toContain("Cascadia Mono");
    expect(mono, "等宽档不该有 Arial").not.toContain("Arial");
    expect(mono, "等宽档不该有 Segoe UI").not.toContain("Segoe UI");
  });

  it("B236：两栏（同档下）的候选逐项相同 —— 只有内嵌默认那一项的说法不同", () => {
    const body = fontOptionsFor("proportional", "", SYS, DEFAULT_BODY_FONT_LABEL);
    const code = fontOptionsFor("proportional", "", SYS, DEFAULT_CODE_FONT_LABEL);
    expect(
      body.map((o) => o.value),
      "value 层面必须完全一致",
    ).toEqual(code.map((o) => o.value));
    expect(body[0].label, "正文的内嵌默认说法").toBe(DEFAULT_BODY_FONT_LABEL);
    expect(code[0].label, "代码的内嵌默认说法").toBe(DEFAULT_CODE_FONT_LABEL);
  });

  it("装了但不在本档的当前值：照样列出，但**不打**未安装标记（它装得好好的）", () => {
    // 当前值是等宽 Consolas，正切在「比例」档 ⇒ 要列出来（否则下拉显示不出当前值），
    // 但不能打「本机未安装」——那是误导。
    const opts = fontOptionsFor("proportional", "Consolas", SYS, "默认（内嵌思源黑体）");
    const hit = opts.find((o) => o.value === "Consolas");
    expect(hit, "装着的当前值要照样列出").toBeTruthy();
    expect(hit!.label, "装着的当前值不该打未安装标记").toBe("Consolas");
  });

  it("枚举结果不再有字重变体与 @ 副本（B234 前端侧也要干净）", () => {
    // ⚠️ 这条钉的是**前端不再自己加工** —— 后端已经去了重/去变体，
    // 前端若再拼一次就会把变体放回来。
    const opts = fontOptionsFor("proportional", "", SYS, "默认（内嵌思源黑体）");
    for (const o of opts) {
      expect(o.label, `候选不该以 @ 开头：${o.label}`).not.toMatch(/^@/);
    }
  });

  it("当前值不在枚举里（用户装过后卸了）要列在首位并打未安装标记", () => {
    const opts = fontOptionsFor("proportional", "已卸载字体", SYS, "默认（内嵌思源黑体）");
    expect(opts[0].value, "默认项仍在首位").toBe("");
    expect(
      opts.some((o) => o.value === "已卸载字体"),
      "卸掉的那个当前值要照样列出来（否则用户以为设置被重置了）",
    ).toBe(true);
    expect(opts.find((o) => o.value === "已卸载字体")!.label, "真没装才打未安装标记").toContain(
      FONT_FAMILY_NO_DIFF_SUFFIX,
    );
  });

  it("枚举为空（非 Windows / IPC 失败）要退回手抄清单，不能把这一栏列空", () => {
    const opts = fontOptionsFor("proportional", "", [], "默认（内嵌思源黑体）");
    expect(opts.length, "空枚举时要有候选可列").toBeGreaterThan(0);
    expect(opts.map((o) => o.value)).toContain("");
  });

  it("B239：枚举为空时首项换成本档的内嵌默认说法（手抄清单首项写死的是代码字体的默认）", () => {
    // 退化前：两档都返回手抄清单，首项一律「默认（Cascadia Code / Consolas…）」
    //⇒ 出现在**正文**那栏等于把话说反了（正文默认明明是内嵌思源黑体）。
    const prop = fontOptionsFor("proportional", "", [], DEFAULT_BODY_FONT_LABEL);
    const mono = fontOptionsFor("mono", "", [], DEFAULT_CODE_FONT_LABEL);
    // ⚠️ 反向闸排在正向断言之前
    expect(prop[0].label, "正文那栏不许出现代码字体的默认说法").not.toContain("Cascadia Code /");
    expect(mono[0].label, "代码那栏同理").not.toContain("Cascadia Code /");
    // 正向：首项就是本档的内嵌默认，且 value 仍是空串（= 移除变量、回落内嵌栈）
    expect(prop[0].label, "正文兜底首项应是内嵌思源黑体").toBe(DEFAULT_BODY_FONT_LABEL);
    expect(mono[0].label, "代码兜底首项应是内嵌 Cascadia Mono").toBe(DEFAULT_CODE_FONT_LABEL);
    expect(prop[0].value, "兜底首项的 value 仍应是空串").toBe("");
    expect(mono[0].value, "兜底首项的 value 仍应是空串").toBe("");
    // 其余项照旧退回手抄清单（不能把这一栏列空）
    expect(prop.length, "兜底仍要有候选可列").toBeGreaterThan(1);
  });
});

/**
 * B239：字体列表退回手抄清单（= 用户报「怎么不是内嵌+系统字体」）。
 *
 * 根因不是后端枚举有问题（Rust 侧实测 114 条、等宽判定正确），而是**取数与建页
 * 之间的竞态**：`openSettingsDialog` 发起枚举但**不等它**（`void`），而设置页是
 * **同步**建好每一个分类页的 —— 字体行在 `buildPage("editor")` 那一刻读
 * `systemFonts()` 读到的还是空数组 ⇒ `fontOptionsFor` 走兜底 ⇒ 整轮会话都列不对。
 *
 * 这一类假绿的通用教训：**枚举类数据必须在开页前 await 到位**。fire-and-forget
 * + 同步建页 = 拿兜底数据当正常数据用，且**没有任何重建机制**能救（要关掉设置页
 * 再开一次才对）。
 */
describe("B239 字体列表：开页前必须已拿到本机枚举", () => {
  /** openSettingsDialog 的函数体（只认 `function <name>(`，见 tests/static.ts）。 */
  function openSettingsBody(): string {
    const main =
      readFileSync("src/main.ts", "utf-8") +
      "\n" +
      readFileSync("src/prefs.ts", "utf-8") +
      "\n" +
      readFileSync("src/commands.ts", "utf-8");
    const start = main.indexOf("async function openSettingsDialog(");
    expect(start, "main.ts 里应有 async function openSettingsDialog(").toBeGreaterThanOrEqual(0);
    // 顶层函数收尾 = 行首 `}` 后紧跟换行/EOF
    let end = main.indexOf("\n}", start);
    while (end > -1) {
      const after = main[end + 2];
      if (after === undefined || after === "\n") break;
      end = main.indexOf("\n}", end + 1);
    }
    return main.slice(start, end + 2);
  }

  it("枚举要 await 到位才开页（不许 fire-and-forget），且 await 在建页之前", () => {
    const body = stripLineComments(openSettingsBody());
    // ⚠️ 反向闸排在正向断言之前：这一条正是 B239 的病根，改回去必须红。
    //    判据只写调用形态（含 `void ` 前缀与 `;` 收尾），**不写函数名** ——
    //    源码注释里复述了同一句，剥了行注释才扫，但函数名仍可能出现在别处。
    expect(body, "开页前不许 fire-and-forget 发起枚举").not.toMatch(/void\s+\w+\(\);/);
    expect(body, "开页前必须等枚举回来").toContain("await ");
    // 位置闸：两个下标都要先确认存在（缺一个时 indexOf 是 -1，会「看起来满足 <
    // ⇒ 必须配 toBeGreaterThanOrEqual(0)，否则是假绿）。
    const awaitAt = body.indexOf("await ");
    const openAt = body.indexOf("showSettingsDialog({");
    expect(awaitAt, "应能找到 await 那一行").toBeGreaterThanOrEqual(0);
    expect(openAt, "应能找到 showSettingsDialog 调用").toBeGreaterThanOrEqual(0);
    expect(awaitAt, "枚举必须在建页之前到位（设置页是同步建页的）").toBeLessThan(openAt);
  });

  it("枚举失败也不阻断开页（ensureSystemFonts 内部已兜住，await 它不会抛）", () => {
    const main =
      readFileSync("src/main.ts", "utf-8") +
      "\n" +
      readFileSync("src/prefs.ts", "utf-8") +
      "\n" +
      readFileSync("src/commands.ts", "utf-8");
    const start = main.indexOf("async function ensureSystemFonts(");
    expect(start, "应有 ensureSystemFonts").toBeGreaterThanOrEqual(0);
    let end = main.indexOf("\n}", start);
    while (end > -1) {
      const after = main[end + 2];
      if (after === undefined || after === "\n") break;
      end = main.indexOf("\n}", end + 1);
    }
    const body = stripLineComments(main.slice(start, end + 2));
    // await 之后紧跟建页，所以这里抛出去 = 设置页彻底打不开。必须仍走 catch 兜底。
    expect(body, "枚举失败要有 try/catch 兜住").toContain("try {");
    expect(body, "枚举失败要记日志").toContain("logger.warn(");
  });

  it("兜底路径不再是「整份等宽清单挂在比例档下」（B239 顺手修的语义矛盾）", () => {
    // 手抄清单（FONT_FAMILY_OPTIONS）整份都是等宽字体。枚举失败时直接返回它，
    // 等于「比例（非等宽）」档下列出一堆 Consolas/Cascadia —— 用户会以为档位
    // 筛选没生效。判据：兜底返回的**非首项**仍来自手抄清单（不许把这一栏列空），
    // 而首项必须是本档的内嵌默认（见上面那条）。
    const opts = fontOptionsFor("proportional", "", [], DEFAULT_BODY_FONT_LABEL);
    expect(opts.length, "兜底仍要有候选").toBeGreaterThan(1);
    // 反向闸：正文兜底里不该再出现手抄清单那句写死的首项
    expect(opts[0].label, "首项不许是手抄清单写死的那句").not.toBe(
      "默认（Cascadia Code / Consolas…）",
    );
    // 正向：其余项确实是手抄清单里的东西（说明没把这一栏列空）
    expect(
      opts.slice(1).some((o) => o.value === "Consolas"),
      "其余项应仍来自手抄清单",
    ).toBe(true);
  });
});

describe("B229「Markdown 预览」分类并入「编辑器」", () => {
  /** 取某一分类页（按 .settings-page-title 文案定位）的 body。 */
  function pageBody(label: string): HTMLElement {
    const page = [...document.querySelectorAll(".settings-page")].find(
      (p) => p.querySelector(".settings-page-title")?.textContent === label,
    ) as HTMLElement | undefined;
    if (!page) throw new Error(`没有「${label}」分类页`);
    return page.querySelector(".settings-page-body") as HTMLElement;
  }

  function rowLabels(body: HTMLElement): string[] {
    return [...body.querySelectorAll(".settings-item-label")].map((e) => e.textContent ?? "");
  }

  it("导航不再有独立的「Markdown 预览」分类（B385 起多出「文件关联」共 6 项）", () => {
    showSettingsDialog(makeOpts());
    expect(navItems()).toEqual(["通用", "外观", "编辑器", "新建文件", "文件关联", "快捷键"]);
    expect(navItems(), "独立预览分类必须已删除").not.toContain("Markdown 预览");
    expect(
      document.querySelectorAll(".settings-page").length,
      "分类页数应与导航一致（每分类恰好一页）",
    ).toBe(6);
  });

  it("编辑器页含 7 项，末尾是「预览」小分组下的预览行距 + 预览布局宽度", () => {
    showSettingsDialog(makeOpts());
    const body = pageBody("编辑器");
    expect(rowLabels(body), "编辑器页的项顺序").toEqual([
      // B347：三栏字体各管一段 —— 界面（外壳）/ 正文（预览）/ 代码（编辑器 + 代码块）
      "界面字体",
      "正文字体",
      "代码字体",
      "字号（px）",
      "编辑器行距",
      "预览行距",
      "预览布局宽度",
    ]);

    const groups = [...body.querySelectorAll(".settings-group-title")].map((e) => e.textContent);
    expect(groups, "应有且只有一个「预览」小分组标题").toEqual(["预览"]);

    // 分组标题必须落在两项预览设置**之前**（否则分组等于没分组）
    const kids = [...body.children] as HTMLElement[];
    const gi = kids.findIndex((el) => el.classList.contains("settings-group-title"));
    const pi = kids.findIndex((el) => rowLabels(el).includes("预览行距"));
    const di = kids.findIndex((el) => rowLabels(el).includes("预览布局宽度"));
    expect(gi, "分组标题应存在").toBeGreaterThanOrEqual(0);
    expect(pi, "预览行距行应存在").toBeGreaterThan(gi);
    expect(di, "预览布局宽度行应存在").toBeGreaterThan(pi);
  });

  it("B235：预览正文宽度由 CSS 变量驱动，三档值正确（全宽=不限宽）", () => {
    const main =
      readFileSync("src/main.ts", "utf-8") +
      "\n" +
      readFileSync("src/prefs.ts", "utf-8") +
      "\n" +
      readFileSync("src/commands.ts", "utf-8");
    const appearance = readFileSync("src/appearance.ts", "utf-8");
    // ⚠️ 反向闸排在正向断言之前
    expect(main, "预览 CSS 不该再有硬编码的 860px 上限").not.toMatch(/--md-content-max[^;]*860px/);

    // 正向：三档映射齐全，且**全宽必须是 none（不限宽）**
    for (const [kind, px] of [
      ["standard", "860px"],
      ["wide", "1100px"],
      ["full", "none"],
    ] as const) {
      expect(appearance, `${kind} 档应映射到 ${px}`).toContain(`${kind}: "${px}"`);
    }
    // 全宽给 none 才是真「不限宽」—— 写一个大数字就等于还有个上限
    expect(appearance, "全宽档必须是 none，写成具体 px 就仍会被截住").toMatch(/full:\s*"none"/);

    // CSS 侧：`.md-block` 读这个变量，且不再写死 860px
    // （B352-1 起排版规则挂在共用类 `.md-rendered` 上，`.md-preview` 只剩容器职责）
    const css = readFileSync("src/styles/preview.css", "utf-8");
    const block = cssDecls(ruleBlock(css, ".md-rendered .md-block"));
    expect(block, "正文宽度应读 --md-content-max").toContain("var(--md-content-max");
    // ⚠️ B238 修正：B235 这里原先断言「`.md-preview` 上要有 `--md-content-max: none`
    //    作默认」—— **那条断言把 bug 钉成了期望**。元素自身的声明**优先于**从 `:root`
    //    继承来的值 ⇒ main.ts 写在 `:root` 的档位被整条遮蔽 ⇒ 换档永远没反应。
    //    「没设过」由 `var()` 的兜底参数负责，不需要那一行（详见下面那条 B238 契约）。
    //    B352-1：两个类都要管 —— 排版类现在是 token 的宿主，在它上面重声明会重演同一个 bug。
    for (const sel of [".md-preview", ".md-rendered"]) {
      expect(cssDecls(ruleBlock(css, sel)), `变量不许在 ${sel} 上重声明`).not.toContain(
        "--md-content-max",
      );
    }
  });

  it("B238：预览布局宽度的说明保持一句（用户嫌原来的太长）", () => {
    const src = stripLineComments(readFileSync("src/shell/settingsdialog.ts", "utf-8"));
    const m = /selectRow\(\s*\n?\s*"预览布局宽度",\s*\n?\s*"([^"]*)"/.exec(src);
    expect(m, "要能抠到预览布局宽度那一项的说明").toBeTruthy();
    const desc = m![1];
    // ⚠️ 反向闸在前：不许再把「分屏比例 / 分隔条 / 注意…」那类旁白塞回来
    expect(desc, "说明里不该再夹带分屏比例的辨析").not.toContain("分屏");
    expect(desc.length, `说明应保持一句（当前 ${desc.length} 字）`).toBeLessThanOrEqual(20);
    // 正向：得说清它管的是「预览模式的内容区」
    expect(desc, "要说明这是预览模式内容区").toContain("预览模式");
  });

  it("B238：CSS 里不许再声明 --md-content-max（声明即遮蔽 :root ⇒ 换档没反应）", () => {
    const css = stripCssComments(readFileSync("src/styles/preview.css", "utf-8"));
    // ⚠️ 反向闸排在正向断言之前
    const decls = css.split("\n").filter((l) => /--md-content-max\s*:/.test(l));
    expect(decls, `预览样式里不许声明这个变量，只许读：${decls.join(" / ")}`).toHaveLength(0);
    // 正向：兜底参数必须在（导出 HTML 只注入本文件、`:root` 不在 ⇒ 靠它落到不限宽）
    expect(css, "兜底参数要还在").toContain("var(--md-content-max, none)");
    // 正向：值只能由 main.ts 写在 :root 上，**一处**
    const main =
      readFileSync("src/main.ts", "utf-8") +
      "\n" +
      readFileSync("src/prefs.ts", "utf-8") +
      "\n" +
      readFileSync("src/commands.ts", "utf-8");
    const appearance = readFileSync("src/appearance.ts", "utf-8");
    // ⚠️ 反向闸在前：不许去挨个改 `.md-preview` 元素 —— 元素自身的声明优先于
    // :root 继承值，那就等于把档位顶掉（与上面那条是同一个 bug 的另一条路径）。
    expect(main, "不许直接往 .md-preview 元素上写这个变量").not.toContain(
      'querySelectorAll(".md-preview")',
    );
    expect(
      appearance.split('setProperty("--md-content-max"').length - 1,
      "写这个变量的地方只能有 :root 一处",
    ).toBe(1);
    expect(appearance, "档位必须写在 :root 上才传得到 .md-block").toContain(
      'document.documentElement.style.setProperty("--md-content-max"',
    );
  });

  it("B235：宽度档走 applyPreviewWidth 写 :root，缺省全宽", () => {
    const main =
      readFileSync("src/main.ts", "utf-8") +
      "\n" +
      readFileSync("src/prefs.ts", "utf-8") +
      "\n" +
      readFileSync("src/commands.ts", "utf-8");
    const appearance = readFileSync("src/appearance.ts", "utf-8");
    // 正向：启动回放 + 设置接线都在
    expect(main, "启动时应回放该档").toContain("applyPreviewWidth(settings?.preview_width");
    expect(main, "设置项接线应在").toContain("onPreviewWidth:");
    // 未知档位一律落全宽（B235 的默认口径）
    expect(appearance, "未知档位应落全宽").toContain(
      'return v === "standard" || v === "wide" ? v : "full"',
    );
  });

  it("B235：大纲宽度已从设置页移除（拖拽分隔条仍是唯一入口）", () => {
    showSettingsDialog(makeOpts());
    const body = pageBody("编辑器");
    // ⚠️ 反向闸：这一项**必须**不再出现（用户点名去掉）
    expect(rowLabels(body), "设置页不该再有「大纲宽度」").not.toContain("大纲宽度");
    expect(rowLabels(body), "设置页不该再有「大纲」开头的项").not.toContain("大纲");
    // 反向闸：设置对话框那份候选常量也一并删干净了（别留死代码）。
    // ⚠️ 判据**不能照抄常量名**：源码里我自己写的注释里就提到了它，会被命中 ——
    //    所以这里只断言「那一行 `const ... = [200, 240, 320]` 不存在」。
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    expect(src, "大纲宽度的候选常量应已删除").not.toMatch(
      /const \w*TOC_WIDTH\w* = \[200, 240, 320\]/,
    );
    // 正向：拖拽那条路还在（分隔条元素仍挂着）
    expect(
      document.querySelector("#toc-resizer") ?? document.body.innerHTML,
      "大纲拖拽分隔条不能被一起删掉",
    ).toBeTruthy();
  });

  it("预览两项仍走原 setter（没因搬家丢回调）", () => {
    const seen: string[] = [];
    showSettingsDialog({
      ...makeOpts(),
      onPreviewLineHeight: (v) => seen.push(`lh:${v}`),
      onPreviewWidth: (v) => seen.push(`pw:${v}`),
    });
    // ⚠️ 必须挑**与初值不同**的值：dropdown 与原生 <select> 一致，重选当前项不回调
    // （makeOpts 的默认正是 1.7 / "full"）。
    pickRow("预览行距", "2.1");
    pickRow("预览布局宽度", "standard");
    expect(seen, "预览行距走 onPreviewLineHeight、宽度走 onPreviewWidth").toEqual([
      "lh:2.1",
      "pw:standard",
    ]);
  });

  it("静态：源码里不再有 markdown 分类与分支，预览关键词已并入 editor", () => {
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    // 反向闸必须排在正向断言之前，否则会被正向抢先报错
    expect(src, '不得再有 id: "markdown" 的分类项').not.toContain('id: "markdown"');
    expect(src, "fillPage 不得再有 markdown 分支").not.toContain('id === "markdown"');
    expect(src, "不得再有「Markdown 预览」这个分类名").not.toContain("Markdown 预览");

    // editor 分类必须收下预览侧全部关键词，否则搜「大纲」会一个分类都命中不了
    // ⚠️ 锚点只锚 `id: "editor"` 那行：源码里 `{` 与 `id` 之间有换行 + 缩进，
    // 锚 `{ id: "editor"` 恒 -1（位置闸会因此假红）。
    const start = src.indexOf('id: "editor"');
    const end = src.indexOf('id: "file"');
    expect(start, "应能找到 editor 分类项").toBeGreaterThanOrEqual(0);
    expect(end, "editor 分类项应在 file 分类项之前").toBeGreaterThan(start);
    const editorBlock = src.slice(start, end);
    for (const kw of ["预览行距", "预览布局宽度", "markdown", "大纲", "toc"]) {
      expect(editorBlock, `editor 分类关键词应含「${kw}」`).toContain(`"${kw}"`);
    }
    // B235：大纲宽度那项已删 ⇒ 关键词也不该再有它（留着会让搜「宽度」命中一个不存在的项）
    expect(editorBlock, "不该再有「大纲宽度」这个关键词").not.toContain('"大纲宽度"');
  });

  it("静态：.settings-group-title 样式存在且带分组边框", () => {
    // ⚠️ cssDecls 只是「剥掉注释的声明串」，不解析成对象 —— 按位置/字面量断言即可
    const css = readFileSync("src/styles/global.css", "utf-8");
    const block = cssDecls(ruleBlock(css, ".settings-group-title"));
    expect(block, "缺少 .settings-group-title 规则块").not.toBe("");
    // B337：字号改写字阶 token ⇒ 判「小一号」要拿**展开后的像素**（口径见 static.ts）。
    // 只钉 token 名等于把闸拆了：将来谁把 ui 档调到 14px，分组标题就不再是小一号，
    // 而 `toContain("var(--fs-ui)")` 照样绿。
    const r = cssDecls(ruleBlock(resolveCssVars(css), ".settings-group-title"));
    expect(r, "分组标题应更小一号（ui 档 = 12px，比正文 14px 小）").toMatch(/font-size:\s*12px/);
    expect(block, "分组标题下沿应有分隔线").toContain("border-bottom: 1px solid var(--border)");
  });
});

describe("B305 通用页：最近打开保留数量", () => {
  /** 行整块（要读它的说明文字）。 */
  function rowItem(label: string): HTMLElement {
    const item = [...document.querySelectorAll(".settings-item")].find(
      (r) => r.querySelector(".settings-item-label")?.textContent === label,
    );
    expect(item, `行「${label}」应存在`).toBeTruthy();
    return item as HTMLElement;
  }

  it("五档齐全（0/10/20/50/100），当前值取 getter", () => {
    showSettingsDialog(makeOpts());
    expect(rowValue("最近打开保留数量")).toBe("20");
    expect(rowValues("最近打开保留数量")).toEqual(["0", "10", "20", "50", "100"]);
  });

  it("改档位 ⇒ 交出的是数字，不是字符串（0 档要能被认成「不记录」而不是「无」）", () => {
    const opts = makeOpts();
    const picked: number[] = [];
    opts.onRecentLimit = (v) => picked.push(v);
    showSettingsDialog(opts);
    pickRow("最近打开保留数量", "50");
    pickRow("最近打开保留数量", "0");
    expect(picked).toEqual([50, 0]);
  });

  it("说明里必须写清 0 档语义，否则用户只能靠试", () => {
    showSettingsDialog(makeOpts());
    const desc =
      rowItem("最近打开保留数量").querySelector(".settings-item-desc")?.textContent ?? "";
    expect(desc).toContain("0");
    expect(desc, "0 档不解释就等于一个吞掉名单的开关").toContain("不再记录");
    // B306：0 档还会把左栏那颗键一起收起 —— 不写清，用户下次看到的就只是「键自己消失了」。
    expect(desc, "0 档会收起入口，这句必须写在说明里").toContain("收起");
  });

  it("静态：档位候选不许悄悄少一档（上限与名单是同一份文件里的两个字段）", () => {
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    const block = src.slice(
      src.indexOf('"最近打开保留数量"'),
      src.indexOf('"最近打开保留数量"') + 900,
    );
    for (const n of ["0", "10", "20", "50", "100"]) {
      expect(block, `档位缺 ${n}`).toContain(`value: "${n}"`);
    }
  });

  it("静态：搜索关键词补了「最近打开」，否则按名字搜不到这一项", () => {
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    const general = src.slice(src.indexOf('id: "general"'), src.indexOf('id: "appearance"'));
    expect(general).toContain('"最近打开"');
    expect(general).toContain('"上限"');
  });
});

// B356（用户点名「设置窗口顶部的搜索区改的紧凑点」）。
// 病根不是「32px 太大」，而是同一张面板里输入类控件有**两档**：搜索框 32px、
// 它下面几行的下拉触发器 28px。所以判据钉的是「同取一颗 token」+「顶部带总高有预算」，
// 而不是把 28px 抄进第二条守卫里（抄了就等于允许两边各写各的）。

// ---------------------------------------------------------------- B385 文件关联
describe("B385 设置页「文件关联」分类（B386 三轮：纵向勾选列表）", () => {
  /** 切到文件关联分类（走真实那一下点击，别直呼内部函数）。 */
  function openAssoc(): void {
    const btn = document.querySelector<HTMLElement>('.settings-nav-item[data-cat="assoc"]');
    expect(btn, "导航里应有「文件关联」").toBeTruthy();
    btn!.click();
  }

  /** 等关联整表（异步 IPC）渲染出指定格。 */
  async function waitItem(ext: string): Promise<HTMLElement> {
    await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>(`.settings-assoc-item[data-ext="${ext}"]`);
      expect(el, `格「${ext}」应渲染出来`).toBeTruthy();
    });
    return document.querySelector<HTMLElement>(
      `.settings-assoc-item[data-ext="${ext}"]`,
    ) as HTMLElement;
  }

  it("网格异步渲染：预设是文本格式全家桶（不止四种），.md 勾着", async () => {
    showSettingsDialog(makeOpts());
    openAssoc();
    await waitItem("md");
    await vi.waitFor(() => {
      const n = document.querySelectorAll(".settings-assoc-item").length;
      expect(
        n,
        "预设格式应是全家桶量级（≥ 20 种），不是一行一开关时代的四种",
      ).toBeGreaterThanOrEqual(20);
    });
    const md = await waitItem("md");
    expect(md.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
    expect(
      md.querySelector(".settings-assoc-badge"),
      "md 是系统默认 ⇒ 不该挂「未生效」",
    ).toBeNull();
    // 网格不是逐行开关
    expect(document.querySelectorAll(".settings-assoc-item .switch").length).toBe(0);
  });

  it("勾选 ⇒ 走 onAssocSet 且就地刷新；「非默认」的格要挂「未生效」小标", async () => {
    const opts = makeOpts();
    const calls: [string, boolean][] = [];
    opts.onAssocSet = async (ext, on) => {
      calls.push([ext, on]);
      const e = ASSOC_FIXTURE.find((x) => x.ext === ext)!;
      e.registered = on;
      e.isDefault = false;
      return e;
    };
    showSettingsDialog(opts);
    openAssoc();
    const txt = await waitItem("txt");
    txt.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    await vi.waitFor(() => {
      expect(calls).toContainEqual(["txt", true]);
    });
    await vi.waitFor(() => {
      const cur = document.querySelector<HTMLElement>('.settings-assoc-item[data-ext="txt"]');
      // fixture 里 isDefault 恒 false ⇒ 勾上后必须挂「未生效」，把 UserChoice 口径亮出来
      expect(cur?.querySelector(".settings-assoc-badge")?.textContent, "勾了但非默认要标出来").toBe(
        "未生效",
      );
    });
  });

  it("自定义扩展名：提交走 onAssocSet、按字母序插进网格；非法输入把错误显示出来", async () => {
    showSettingsDialog(makeOpts());
    openAssoc();
    await waitItem("md");
    const input = document.querySelector<HTMLInputElement>(".settings-assoc-input");
    expect(input, "应有自定义扩展名输入框").toBeTruthy();
    const addBtn = document.querySelector<HTMLButtonElement>(
      ".settings-assoc-add .settings-mini-btn",
    );
    expect(addBtn).toBeTruthy();
    // 不在预设里的扩展名 ⇒ 走「插入」分支，且按字母序落在 bat 之前，不甩末尾
    input!.value = "abc";
    addBtn!.click();
    await waitItem("abc");
    const order = [...document.querySelectorAll(".settings-assoc-item")].map(
      (el) => (el as HTMLElement).dataset.ext,
    );
    expect(order[0], "abc 按字母序排到最前").toBe("abc");
    // 已在预设里的（csv）再添加 ⇒ 就地刷新，不得重复成两格
    input!.value = "csv";
    addBtn!.click();
    await vi.waitFor(() => {
      const n = document.querySelectorAll('.settings-assoc-item[data-ext="csv"]').length;
      expect(n, "csv 不得重复").toBe(1);
    });
    // 等上一次提交收尾（按钮恢复可用）—— vi.waitFor 的首轮同步检查可能赶在
    // .finally 之前放行，直接点会被 disabled 吞掉
    await vi.waitFor(() => {
      expect(addBtn!.disabled, "上次提交应已收尾").toBe(false);
    });
    // 非法输入（带空格）会被 Rust 拒 ⇒ 前端要把错误落在输入行下面，而不是静默
    input!.value = "a b";
    addBtn!.click();
    await vi.waitFor(() => {
      const err = [...document.querySelectorAll(".settings-item-desc")].map(
        (d) => d.textContent ?? "",
      );
      expect(
        err.some((t) => t.includes("扩展名")),
        "非法扩展名的错误要可见",
      ).toBe(true);
    });
  });

  it("搜索关键词补齐：搜「关联」「打开方式」能命中本分类", () => {
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    const cat = src.slice(src.indexOf('id: "assoc"'), src.indexOf('id: "shortcuts"'));
    expect(cat).toContain('"文件关联"');
    expect(cat).toContain('"打开方式"');
    expect(cat).toContain('"默认应用"');
  });

  it("静态：说明必须交代 UserChoice 口径（勾了 ≠ 一定生效）与「还原旧关联」语义", () => {
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    const page = src.slice(
      src.indexOf("function fillAssocPage"),
      src.indexOf("function fillAssocPage") + 4000,
    );
    expect(page, "要给「系统默认应用」入口").toContain("系统默认应用");
    expect(page, "要提取消还原").toContain("还原");
    expect(page, "要挂「未生效」小标").toContain("settings-assoc-badge");
  });

  it("B386 静态：关联清单是纵向勾选列表（一格式一行、限高滚动），不是换行网格", () => {
    const css = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
    const list = ruleBlock(css, ".settings-assoc-list");
    expect(cssDecls(list), "清单要单列排").toContain("flex-direction: column");
    expect(cssDecls(list), "不许再回到 flex 换行网格").not.toContain("flex-wrap");
    // 限高 + 滚动（别全展开把页面撑长）；行不许被 flex 收缩（收缩就没有滚动条了）
    expect(cssDecls(list), "要限高").toMatch(/max-height:\s*\d+px/);
    expect(cssDecls(list), "超高要自己滚").toContain("overflow-y: auto");
    const item = ruleBlock(css, ".settings-assoc-item");
    expect(cssDecls(item), "行高要钉死，别让 flex 列把 36 行压进限高里").toContain("flex: none");
    const hover = ruleBlock(css, ".settings-assoc-item:hover");
    expect(cssDecls(hover), "行 hover 走列表高亮 token（VS Code 列表行同源）").toContain(
      "--list-hover-bg",
    );
  });
});

describe("B356 设置窗口顶部搜索区紧凑", () => {
  const css = readFileSync("src/styles/global.css", "utf-8");
  /** 取某条规则里某条声明的原文（取不到返回空串）。 */
  const declOf = (selector: string, prop: string): string =>
    cssDecls(ruleBlock(css, selector)).match(new RegExp(`${prop}:\\s*[^;]*`))?.[0] ?? "";
  /** 把 padding 的一到四值展开成 [上, 右, 下, 左]（够判这一页用到的写法）。 */
  const boxOf = (padding: string): number[] => {
    const n = padding
      .split(/\s+/)
      .filter(Boolean)
      .map((v) => Number.parseFloat(v));
    if (n.length === 1) return [n[0], n[0], n[0], n[0]];
    if (n.length === 2) return [n[0], n[1], n[0], n[1]];
    if (n.length === 3) return [n[0], n[1], n[2], n[1]];
    return [n[0], n[1], n[2], n[3]];
  };

  it("搜索框与下拉触发器同取 --input-h（一处一档，不再各写各的）", () => {
    for (const sel of [".settings-search-wrap", ".dropdown-trigger"]) {
      expect(declOf(sel, "height"), `${sel} 的高度必须引用 --input-h`).toBe(
        "height: var(--input-h)",
      );
    }
    // 展开后确实是 28px 那一档 —— 只判 token 名的话，token 被改成 40px 也照样绿。
    const resolved = resolveCssVars(declOf(".settings-search-wrap", "height"), css);
    expect(resolved, "--input-h 展开后必须是同页下拉那一档 28px").toBe("height: 28px");
    // token 只许在 :root 定义一次（两处各定义 = 取值取决于谁后来）。
    const defs = (css.match(/^\s*--input-h:/gm) ?? []).length;
    expect(defs, "--input-h 只许在 :root 定义一次").toBe(1);
  });

  it("工具栏纵向收到 6px，横向保持 12px 与标题栏那条左边线对齐", () => {
    const pad = boxOf(declOf(".settings-toolbar", "padding").replace(/^padding:\s*/, ""));
    expect(pad[0], "上留白收到 6px（= 左栏按钮列那一档）").toBe(6);
    expect(pad[2], "下留白与上对称").toBe(6);
    // 横向不是随手写的：它与 .win-head 的 padding-left 是同一条左边线 —— 搜索框必须与
    // 标题栏那两个字左对齐，收小一格就变成两列参差（这正是 B317 那一类「同一排要对齐」）。
    const headLeft = boxOf(declOf(".win-head", "padding").replace(/^padding:\s*/, ""))[3];
    expect(pad[1], "工具栏左留白必须与标题栏左留白同源同值").toBe(headLeft);
    expect(pad[1], "左边线那一档是 12px").toBe(12);
  });

  it("顶部带总高有预算：标题栏 + 搜索行不超过 80px", () => {
    const head = Number.parseFloat(declOf(".win-head", "height").replace(/^height:\s*/, ""));
    const wrap = Number.parseFloat(
      resolveCssVars(declOf(".settings-search-wrap", "height"), css).replace(/^height:\s*/, ""),
    );
    const pad = boxOf(declOf(".settings-toolbar", "padding").replace(/^padding:\s*/, ""));
    const total = head + pad[0] + wrap + pad[2] + 1; // +1 = 工具栏下那条 1px 边框
    // 改之前是 34 + 10 + 32 + 10 + 1 = 87，两行头部吃掉快半屏；这一档是产品事实。
    expect(total, `顶部带实测 ${total}px，预算 80px`).toBeLessThanOrEqual(80);
  });

  it("反向验证：搜索框退回自成一档的 32px 必须被咬住", () => {
    const BAD = css.replace(
      /(\.settings-search-wrap\s*\{[^}]*?)height:\s*var\(--input-h\);/,
      "$1height: 32px;",
    );
    expect(BAD, "替身必须真的写回过 32px").not.toBe(css);
    // 咬法：替身已违反「同取 token」⇒ 正向那条断言在 BAD 上必须落空。
    expect(() => {
      const h = cssDecls(ruleBlock(BAD, ".settings-search-wrap")).match(/height:\s*[^;]*/)?.[0];
      expect(h, "替身丢了 token 必须被抓到").toBe("height: var(--input-h)");
    }).toThrow();
  });

  it("反向验证：工具栏横向跟着收到 8px（左边线断开）必须被咬住", () => {
    const BAD = css.replace(
      /(\.settings-toolbar\s*\{[^}]*?)padding:\s*6px 12px;/,
      "$1padding: 6px 8px;",
    );
    expect(BAD, "替身必须真的改过横向留白").not.toBe(css);
    expect(() => {
      const pad = boxOf(
        cssDecls(ruleBlock(BAD, ".settings-toolbar"))
          .match(/padding:\s*[^;]*/)?.[0]
          .replace(/^padding:\s*/, "") ?? "",
      );
      expect(pad[1], "替身与标题栏左边线对不上，必须被抓到").toBe(12);
    }).toThrow();
  });
});
