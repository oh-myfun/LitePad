// @vitest-environment jsdom
// B365：状态栏「文件类型」的居顶快速选择浮层（VS Code 同款观感）。
//
// 这里只测组件的 DOM 行为与样式契约：过滤 / 方向键 / 回车 / Esc / 点外关闭 /
// 勾选态 / 原始下标回传。语言怎么落地归 language-picker.test.ts 与 doc-model。

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  closeQuickPick,
  quickPickIsOpen,
  showQuickPick,
  type QuickPickItem,
} from "../src/shell/quickpick";
import { cssDecls, ruleBlock, themeBlock } from "./static";

const ITEMS: QuickPickItem[] = [
  { label: "自动检测", description: "按文件后缀自动识别" },
  { label: "Markdown" },
  { label: "Plain Text" },
  { label: "Rust" },
];

const widget = (): HTMLElement | null => document.querySelector(".quick-pick");
const input = (): HTMLInputElement => document.querySelector(".quick-pick-input")!;
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".quick-pick-item")];

afterEach(() => {
  closeQuickPick();
  document.body.textContent = "";
});

function open(items = ITEMS, activeIndex?: number) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  showQuickPick({ placeholder: "选择语言模式", items, activeIndex, onSelect, onClose });
  return { onSelect, onClose };
}

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

function press(key: string): void {
  input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("B365 QuickPick：居顶快速选择浮层", () => {
  it("打开：浮层 + 搜索框 + 全量条目，焦点进输入框", () => {
    open();
    expect(widget(), "必须挂出 .quick-pick").toBeTruthy();
    expect(quickPickIsOpen()).toBe(true);
    expect(input().placeholder).toBe("选择语言模式");
    expect(document.activeElement, "焦点必须在搜索框（可直接打字过滤）").toBe(input());
    expect(rows().map((r) => r.querySelector(".quick-pick-label")?.textContent)).toEqual([
      "自动检测",
      "Markdown",
      "Plain Text",
      "Rust",
    ]);
  });

  it("勾选项：aria-selected + is-checked，初始高亮落在它身上", () => {
    open([{ label: "自动检测", checked: true }, { label: "Markdown" }]);
    expect(rows()[0].classList.contains("is-checked")).toBe(true);
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    expect(rows()[1].getAttribute("aria-selected")).toBe("false");
    expect(rows()[0].classList.contains("is-active"), "初始高亮应在勾选项上").toBe(true);
  });

  it("输入即过滤（不区分大小写）；无匹配显示空态；清空恢复全量", () => {
    open();
    type("mark");
    expect(rows().map((r) => r.querySelector(".quick-pick-label")?.textContent)).toEqual([
      "Markdown",
    ]);
    type("zzz");
    expect(rows(), "无匹配时列表应为空").toHaveLength(0);
    expect(
      document.querySelector<HTMLElement>(".quick-pick-empty")?.hidden,
      "空态提示必须显示",
    ).toBe(false);
    type("");
    expect(rows()).toHaveLength(ITEMS.length);
  });

  it("方向键移动高亮，回车回传**原始下标**（过滤后也一样）", () => {
    const { onSelect } = open();
    press("ArrowDown");
    expect(rows()[1].classList.contains("is-active"), "下移一格").toBe(true);
    press("ArrowUp");
    expect(rows()[0].classList.contains("is-active"), "上移一格").toBe(true);
    press("Enter");
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(widget(), "选完必须关闭").toBeNull();

    const second = open();
    type("mark");
    press("Enter");
    expect(second.onSelect, "过滤后回车要回传清单里的原始下标 1").toHaveBeenCalledWith(1);
  });

  it("Esc 关闭并回调 onClose；点条目也能选", () => {
    const { onClose } = open();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(widget()).toBeNull();

    const again = open();
    rows()[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(again.onSelect).toHaveBeenCalledWith(2);
    expect(widget()).toBeNull();
  });

  it("点浮层外面关闭；点浮层里面不关", () => {
    open();
    input().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(widget(), "点里面不许关").toBeTruthy();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(widget(), "点外面必须关").toBeNull();
  });

  it("锚点键不算「外面」—— 再点一下才能收起（否则 pointerdown 关了 click 又开）", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    showQuickPick({
      placeholder: "选择语言模式",
      items: ITEMS,
      anchor: btn,
      onSelect: () => {},
    });
    btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(widget(), "点锚点不许被当成点外面").toBeTruthy();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(widget()).toBeNull();
  });

  it("重复打开只留一个浮层（旧实例先关）", () => {
    open();
    open();
    expect(document.querySelectorAll(".quick-pick")).toHaveLength(1);
  });
});

describe("B366 条目图标 / 分隔线 / 禁用项", () => {
  it("图标：有 icon 的条目渲染 .quick-pick-icon + data-fam；无图标项在图标列表里占位对齐", () => {
    open([
      {
        label: "Markdown",
        icon: '<i class="codicon codicon-markdown" aria-hidden="true"></i>',
        iconFamily: "md",
      },
      { label: "自动检测" },
    ]);
    const icons = document.querySelectorAll<HTMLElement>(".quick-pick-icon");
    expect(icons, "每条都占图标槽（无图标的是空槽）").toHaveLength(2);
    expect(icons[0].getAttribute("data-fam"), "配色走 data-fam").toBe("md");
    expect(icons[0].innerHTML, "字形必须是 codicon").toContain("codicon-markdown");
    expect(icons[1].classList.contains("is-empty"), "无图标项要占位对齐").toBe(true);
    expect(icons[1].innerHTML).toBe("");

    // 整表都没有图标（编码 / 行尾）⇒ 不留 22px 空槽，标签更靠左。
    open([{ label: "UTF-8" }, { label: "GBK" }]);
    expect(document.querySelectorAll(".quick-pick-icon")).toHaveLength(0);
  });

  it("分隔线：显示但不可选，键盘与回车都跳过；输入过滤时收掉", () => {
    const items: QuickPickItem[] = [
      { label: "UTF-8", checked: true },
      { label: "GB18030" },
      { label: "", separator: true },
      { label: "添加 BOM" },
    ];
    const { onSelect } = open(items);
    expect(document.querySelectorAll(".quick-pick-separator")).toHaveLength(1);
    expect(
      rows().map((r) => r.querySelector(".quick-pick-label")?.textContent),
      "分隔线不是 .quick-pick-item",
    ).toEqual(["UTF-8", "GB18030", "添加 BOM"]);
    press("ArrowDown"); // GB18030
    press("ArrowDown"); // 跳过分隔线 → 添加 BOM
    expect(rows().at(-1)?.classList.contains("is-active")).toBe(true);
    press("Enter");
    expect(onSelect, "回车必须回传原始下标（分隔线在 2）").toHaveBeenCalledWith(3);

    open(items);
    type("bom");
    expect(document.querySelectorAll(".quick-pick-separator"), "过滤时不留分隔线").toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });

  it("禁用项：仍显示、键盘跳过、点击不选中也不关浮层", () => {
    const { onSelect } = open([
      { label: "UTF-8" },
      { label: "移除 BOM", disabled: true },
      { label: "添加 BOM" },
    ]);
    expect(rows()[1].classList.contains("is-disabled")).toBe(true);
    expect(rows()[1].getAttribute("aria-disabled")).toBe("true");
    press("ArrowDown");
    expect(rows()[2].classList.contains("is-active"), "键盘必须跳过禁用项").toBe(true);
    rows()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(widget(), "点禁用项不许关浮层").toBeTruthy();
    press("Enter");
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("初始高亮可由 activeIndex 指定（编码 / 行尾按当前值开）", () => {
    open([{ label: "UTF-8" }, { label: "GBK", checked: true }, { label: "UTF-16LE" }], 1);
    expect(rows()[1].classList.contains("is-active")).toBe(true);
  });
});

describe("B365 QuickPick 样式契约（VS Code quick input 同款几何）", () => {
  const css = readFileSync("src/styles/global.css", "utf-8");
  const zIndexOf = (selector: string): number => {
    const decls = cssDecls(ruleBlock(css, selector, undefined, true));
    return Number(decls.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
  };

  it("居顶居中 600px：top 落在标题栏之下（34px），左右居中", () => {
    const pick = cssDecls(ruleBlock(css, ".quick-pick", undefined, true));
    expect(pick, "应有 .quick-pick 规则").toBeTruthy();
    expect(pick).toMatch(/position:\s*fixed/);
    expect(pick, "从标题栏下沿展开（.title-bar 高 34px）").toMatch(/top:\s*34px/);
    expect(pick).toMatch(/left:\s*50%/);
    expect(pick).toMatch(/transform:\s*translateX\(-50%\)/);
    expect(pick, "VS Code quick input 同宽").toMatch(/width:\s*600px/);
    expect(pick, "窄窗口不许溢出").toMatch(/max-width:\s*calc\(100vw - 32px\)/);
  });

  it("层级：高于弹出菜单（1000）与转到行浮层，低于提示（2000）", () => {
    expect(zIndexOf(".quick-pick")).toBeGreaterThan(zIndexOf(".popup-menu"));
    expect(zIndexOf(".quick-pick")).toBeLessThan(zIndexOf(".tooltip"));
  });

  it("列表超高自身滚动（不把浮层顶出屏幕）", () => {
    const list = cssDecls(ruleBlock(css, ".quick-pick-list", undefined, true));
    expect(list).toMatch(/max-height:/);
    expect(list).toMatch(/overflow-y:\s*auto/);
  });

  it("B366 选中态复刻 VS Code：focusBackground 取 #04395E / #0060C0，白字", () => {
    const active = cssDecls(ruleBlock(css, ".quick-pick-item.is-active", undefined, true));
    expect(active, "聚焦行底色必须走专用 token").toMatch(/background:\s*var\(--pick-focus-bg\)/);
    expect(active, "聚焦行前景取白").toMatch(/color:\s*var\(--pick-focus-fg\)/);
    // 取值是 VS Code `list.activeSelectionBackground` 的默认档（深/浅）。
    const dark = themeBlock(css, "dark");
    const light = themeBlock(css, "light");
    expect(dark).toMatch(/--pick-focus-bg:\s*#04395e/i);
    expect(light).toMatch(/--pick-focus-bg:\s*#0060c0/i);
    expect(dark).toMatch(/--pick-focus-fg:\s*#ffffff/i);
    expect(light).toMatch(/--pick-focus-fg:\s*#ffffff/i);

    // 反向对照：把聚焦底色退回普通 hover，同一条判据必须咬住。
    const BAD = css.replace(
      /(\.quick-pick-item\.is-active\s*\{[^}]*?background:\s*)var\(--pick-focus-bg\)/,
      "$1var(--bg-hover)",
    );
    expect(BAD, "替身必须真的改到聚焦底色").not.toBe(css);
    expect(cssDecls(ruleBlock(BAD, ".quick-pick-item.is-active", undefined, true))).not.toMatch(
      /background:\s*var\(--pick-focus-bg\)/,
    );
  });

  it("B366 条目图标 16px、家族配色与标签同源；禁用项降透明度", () => {
    const icon = cssDecls(ruleBlock(css, ".quick-pick-icon", undefined, true));
    expect(icon).toMatch(/width:\s*16px/);
    expect(icon).toMatch(/flex:\s*0 0 16px/);
    for (const fam of ["md", "code", "txt"]) {
      expect(css, `缺 .quick-pick-icon[data-fam="${fam}"] 配色`).toContain(
        `.quick-pick-icon[data-fam="${fam}"]`,
      );
    }
    const disabled = cssDecls(ruleBlock(css, ".quick-pick-item.is-disabled", undefined, true));
    expect(disabled).toMatch(/opacity:/);
    expect(disabled).toMatch(/cursor:\s*default/);
  });
});
