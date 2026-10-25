// B379 · 四个关键区域（标题栏 / 侧边栏 / 编辑区 / 状态栏）的分区域 token 与消费点。
//
// 用户要求：「标题栏（整个应用背景）、侧边栏、编辑区（标签栏、标签、编辑区）、状态栏，
// 这几个关键区域的边框，前景背景，hover 等颜色和样式尽量和 vscode 保持一致，
// 并同样统一抽取主题可替换样式，方便主题切换」。
//
// 主题表本身的字面值在 tests/theme-vscode.test.ts（AREA 表）；本文件盯的是
// 「组件样式真的消费了这些 token」以及「替身改回旧写法会被抓到」。
// 两条分开是刻意的：只钉 token 值不钉消费点，样式可以整体退回旧变量而全绿。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ruleBlock, stripCssComments, themeBlock } from "./static";

const CSS = "src/styles/global.css";
const PREVIEW = "src/styles/preview.css";

const css = () => readFileSync(CSS, "utf-8");
const preview = () => readFileSync(PREVIEW, "utf-8");

/** 取规则块并剥注释（散文里的旧值不许顶包）。 */
const rule = (src: string, selector: string, needle?: string) =>
  stripCssComments(ruleBlock(src, selector, needle));

/** 取块体里某条声明的值。 */
function decl(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  return re.exec(stripCssComments(block))?.[1]?.trim() ?? "";
}

describe("B379 · 四个关键区域：分区域 token 与消费点", () => {
  it("组件样式引用的每一颗分区 token，两套基座主题都定义了", () => {
    const source = css();
    const referenced = [
      ...new Set(
        [
          ...source.matchAll(
            /var\((--(?:shell-bg|titlebar-[\w-]+|menubar-[\w-]+|toolbar-[\w-]+|activitybar-[\w-]+|sidebar-[\w-]+|list-(?:hover|active|inactive|selection)[\w-]*|editor-fg|editor-card-border|editor-split-border|tab-strip-bg|tabstrip-border|tab-(?:fg-[\w-]+|bg-[\w-]+)|statusbar-[\w-]+))(?=[,)])/g,
          ),
        ].map((m) => m[1]),
      ),
    ];
    // 探针空转会假绿：这条清单必须真的抓到东西
    expect(referenced.length, "应引用多颗分区 token").toBeGreaterThanOrEqual(25);
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      for (const token of referenced) {
        expect(block, `${name} 基座缺 ${token}`).toContain(`${token}:`);
      }
    }
  });

  it("外壳与标题栏：整窗 = shell-bg，标题 / 三种按钮各取自己的 token", () => {
    const source = css();
    expect(rule(source, "html, body"), "整窗底色 = shellBackground").toContain(
      "background: var(--shell-bg)",
    );
    expect(rule(source, ".title-bar"), "标题栏 = shellBackground").toContain(
      "background: var(--shell-bg)",
    );
    expect(rule(source, ".title-text"), "标题文字 = titleBar.activeForeground").toContain(
      "color: var(--titlebar-fg)",
    );
    expect(rule(source, ".title-dirty"), "未保存原点跟标题同一颗").toContain(
      "color: var(--titlebar-fg)",
    );
    // 三族按钮的悬停各按 VS Code 的 token 分家（B379 推翻 B103 的「共用一条」）
    expect(rule(source, ".win-btn:hover"), "窗口控制悬停").toContain(
      "background: var(--titlebar-hover-bg)",
    );
    expect(rule(source, ".title-btn:hover"), "标题栏工具键悬停").toContain(
      "background: var(--toolbar-hover-bg)",
    );
    const menuHover = rule(source, ".menu-btn:hover, .menu-btn.menu-open");
    expect(menuHover, "菜单键悬停背景").toContain("background: var(--menubar-hover-bg)");
    expect(menuHover, "菜单键悬停前景").toContain("color: var(--menubar-hover-fg)");
    expect(menuHover, "HC 的菜单选中靠一圈实线").toContain(
      "box-shadow: inset 0 0 0 1px var(--menubar-hover-border)",
    );
    expect(rule(source, ".win-btn-close:hover"), "关闭键红底也走 token").toContain(
      "background: var(--titlebar-close-hover)",
    );
  });

  it("侧边栏：卡片 / 活动栏 / 列表行三层各有各的底色与 hover", () => {
    const source = css();
    const shell = rule(source, ".side-shell");
    expect(shell, "侧栏卡片 = sideBar.background").toContain("background: var(--sidebar-bg)");
    expect(shell, "侧栏文字 = sideBar.foreground").toContain("color: var(--sidebar-fg)");
    expect(shell, "卡片边框 = surface.border").toContain(
      "border: 1px solid var(--editor-card-border)",
    );
    const bar = rule(source, ".side-bar");
    expect(bar, "活动栏 = activityBar.background").toContain("background: var(--activitybar-bg)");
    expect(bar, "活动栏分隔线 = activityBar.border").toContain(
      "border-right: 1px solid var(--activitybar-border)",
    );
    expect(rule(source, ".side-btn"), "活动栏图标常态").toContain(
      "color: var(--activitybar-inactive-fg)",
    );
    expect(rule(source, ".side-btn:hover"), "活动栏悬停").toContain(
      "background: var(--activitybar-hover-bg)",
    );
    const on = rule(source, ".side-btn.is-on");
    expect(on, "当前视图 = activityBar.activeBackground").toContain(
      "background: var(--activitybar-active-bg)",
    );
    expect(on, "当前视图前景").toContain("color: var(--activitybar-active-fg)");
    expect(on, "HC 的当前视图靠一圈实线").toContain(
      "outline: 1px solid var(--activitybar-active-border)",
    );
  });

  it("编辑区：卡片 / 分屏线 / 标签条 / 标签描边 / 标签悬停各就各位", () => {
    const source = css();
    const area = rule(source, ".layout-area");
    expect(area, "编辑区 = editor.background").toContain("background: var(--bg)");
    expect(area, "卡片边框 = surface.border").toContain(
      "border: 1px solid var(--editor-card-border)",
    );
    expect(rule(source, ".layout-sep::after"), "分屏线 = editorGroup.border").toContain(
      "background: var(--editor-split-border)",
    );
    expect(rule(source, ".panel-head"), "标签条表面 = connectedTabsBackground").toContain(
      "background: var(--tab-strip-bg)",
    );
    expect(
      rule(source, ".panel-head::after", "var(--tabstrip-border)"),
      "条带下沿 = tabsBorder",
    ).toContain("background: var(--tabstrip-border)");
    const fill = rule(source, ".tab-active .tab-fill", "--tab-fill-bg");
    expect(fill, "活动标签帽轮廓 = tabsBorder").toContain(
      "border: var(--tab-stroke) solid var(--tabstrip-border)",
    );
    expect(fill, "活动标签底色 = 编辑区底色").toContain("--tab-fill-bg: var(--tab-bg-active)");
    expect(rule(source, ".tab:hover:not(.tab-active)"), "非活动标签悬停前景").toContain(
      "color: var(--tab-fg-hover)",
    );
    for (const [sel, label] of [
      [".tab-active .tab-fill::before", "左肩"],
      [".tab-active .tab-fill::after", "右肩"],
    ] as const) {
      expect(rule(source, sel), `${label}描边同用 tabsBorder`).toContain("var(--tabstrip-border)");
    }
  });

  it("状态栏：自己的底 / 字 / 上沿 / 两档条目色，不再跟标题栏同源", () => {
    const source = css();
    const bar = rule(source, ".statusbar");
    expect(bar, "状态栏 = statusBar.background").toContain("background: var(--statusbar-bg)");
    expect(bar, "状态栏文字 = statusBar.foreground").toContain("color: var(--statusbar-fg)");
    expect(bar, "上沿线 = statusBar.border（inset 不占布局）").toContain(
      "box-shadow: inset 0 1px 0 var(--statusbar-border)",
    );
    expect(rule(source, ".sb-btn:hover"), "条目悬停").toContain(
      "background: var(--statusbar-item-hover-bg)",
    );
    expect(rule(source, ".sb-btn:active"), "条目按下").toContain(
      "background: var(--statusbar-item-active-bg)",
    );
  });

  it("侧栏列表行（资源管理器 / 最近打开 / 大纲）走 list.* 而不是通用 hover", () => {
    const per = preview();
    for (const [sel, label] of [
      [".explorer-row:hover, .explorer-root:hover", "资源管理器行悬停"],
      [".recent-row:hover", "最近打开行悬停"],
      [".toc-item:hover", "大纲行悬停"],
    ] as const) {
      expect(rule(per, sel), `${label}必须用 list.hoverBackground`).toContain(
        "var(--list-hover-bg",
      );
    }
    const selected = rule(
      per,
      '.explorer-row[aria-selected="true"], .explorer-root[aria-selected="true"]',
    );
    expect(selected, "树不持焦点时 = inactiveSelection").toContain(
      "background: var(--list-inactive-bg)",
    );
    const focused = rule(
      per,
      '.explorer-tree:focus-within .explorer-row[aria-selected="true"], .explorer-tree:focus-within .explorer-root[aria-selected="true"]',
    );
    expect(focused, "树持焦点时 = activeSelection").toContain("background: var(--list-active-bg)");
    expect(focused, "HC 选中靠描边").toContain(
      "outline: 1px solid var(--list-selection-border, transparent)",
    );
    const root = rule(per, ".md-rendered", "--md-bg");
    expect(decl(root, "--md-fg"), "预览正文 = editor.foreground").toBe("var(--editor-fg, #202020)");
  });

  it("首帧着色也走外壳色：整窗露出的那层不是 editor.background", () => {
    // 真机抓到的病：global.css 的 body 已改 shell，但 index.html 内联首屏样式
    // 仍按 editor.background 刷 html/body（选择器特异度更高）⇒ 卡片四周的缝
    // 和窗口外留白仍是编辑区色，与标题栏/状态栏对不上。VS Code 的依据：
    // partsSplash.ts 在 modernUI 时 splash 取 modernUIShellBackground。
    const html = readFileSync("index.html", "utf-8");
    const boot = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(boot, "取不到 index.html 的内联首屏样式").toBeTruthy();
    expect(boot, "2026 深色外壳").toContain("background: #191a1b");
    expect(boot, "2026 浅色外壳").toContain("background: #fafafd");
    expect(boot, "Modern 深色外壳").toContain("background: #181818");
    expect(boot, "Plus/Classic 深色外壳").toContain("background: #3c3c3c");
    expect(boot, "首帧样式不得再刷 editor.background").not.toContain("#121314");
  });

  it("反向验证：状态栏退回标题栏那颗、活动栏不刷底色、帽轮廓退回通用边框，都必须被咬住", () => {
    const source = css();
    const isStatusBarToken = (src: string) =>
      rule(src, ".statusbar").includes("background: var(--statusbar-bg)");
    const badBar = source.replace(
      "background: var(--statusbar-bg);",
      "background: var(--bg-toolbar);",
    );
    expect(badBar, "替身必须真的改掉了").not.toBe(source);
    expect(isStatusBarToken(source), "前置条件：原文通过").toBe(true);
    expect(isStatusBarToken(badBar), "退化替身必须被抓到").toBe(false);

    const isActivity = (src: string) =>
      rule(src, ".side-bar").includes("background: var(--activitybar-bg)");
    const badSide = source.replace(
      "background: var(--activitybar-bg);",
      "background: transparent;",
    );
    expect(badSide, "替身必须真的改掉了").not.toBe(source);
    expect(isActivity(source)).toBe(true);
    expect(isActivity(badSide), "活动栏不刷底色必须被抓到").toBe(false);

    const isTabStroke = (src: string) =>
      rule(src, ".tab-active .tab-fill", "--tab-fill-bg").includes(
        "var(--tab-stroke) solid var(--tabstrip-border)",
      );
    const badTab = source.replace(
      "border: var(--tab-stroke) solid var(--tabstrip-border);",
      "border: var(--tab-stroke) solid var(--border);",
    );
    expect(badTab, "替身必须真的改掉了").not.toBe(source);
    expect(isTabStroke(source)).toBe(true);
    expect(isTabStroke(badTab), "帽轮廓退回 --border 必须被抓到").toBe(false);
  });
});
