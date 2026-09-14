// @vitest-environment jsdom
// M4 命令面板（src/shell/commandpalette.ts）：模糊匹配、键盘导航、执行与关闭。
import { afterEach, describe, expect, it } from "vitest";
import {
  PALETTE_OPEN_CLASS,
  filterItems,
  paletteItems,
  paletteOpen,
  scoreItem,
  showCommandPalette,
  type PaletteItem,
} from "../src/shell/commandpalette";
import { DEFAULT_PRESET_ID, setKeymapPreset } from "../src/shell/keymap";

// jsdom 不实现 scrollIntoView，面板键盘导航会调它
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => {};
}

function item(id: string, label: string, group = "文件", keys = ""): PaletteItem {
  return { id, label, group, keys };
}

function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".palette-item")];
}

function activeRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".palette-item.is-active");
}

function type(text: string): void {
  const input = document.querySelector<HTMLInputElement>(".palette-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

afterEach(() => {
  for (const el of document.querySelectorAll(".palette-overlay")) el.remove();
  document.body.classList.remove(PALETTE_OPEN_CLASS);
  setKeymapPreset(DEFAULT_PRESET_ID);
});

describe("M4 命令面板：数据源来自 keymap 注册表", () => {
  it("只列可执行命令（editable:false 的编辑器/系统项不该出现）", () => {
    const items = paletteItems({});
    const ids = items.map((i) => i.id);
    // 菜单助记符与查找栏都是只读项
    expect(ids).not.toContain("menu.file");
    expect(ids).not.toContain("findbar.next");
    // 真实命令必须在
    expect(ids).toContain("file.save");
    expect(ids).toContain("palette.open");
  });

  it("键位串跟随覆盖表与预设（面板显示的必须是当前真正生效的键位）", () => {
    const custom = paletteItems({ "file.save": "Ctrl+Q" }).find((i) => i.id === "file.save");
    expect(custom?.keys).toBe("Ctrl+Q");

    setKeymapPreset("notepadpp");
    const fromPreset = paletteItems({}).find((i) => i.id === "file.saveAs");
    expect(fromPreset?.keys).toBe("Ctrl+Alt+S");
  });
});

describe("M4 命令面板：模糊匹配", () => {
  it("连续包含优先于子序列", () => {
    const save = item("file.save", "保存");
    expect(scoreItem(save, "保存")).toBeGreaterThan(scoreItem(save, "存"));
    expect(scoreItem(save, "保存")).toBeGreaterThan(0);
    expect(scoreItem(save, "打不开")).toBe(-1);
  });

  it("命令 id（英文）也能搜：输入 save 找到「保存」", () => {
    const s = item("file.save", "保存");
    expect(scoreItem(s, "save")).toBeGreaterThan(0);
  });

  it('子序列能命中（fs → "file save"）', () => {
    const s = item("file.save", "file save");
    expect(scoreItem(s, "fs")).toBeGreaterThan(0);
  });

  it("键位也能搜（输入 ctrl+s 找到保存）", () => {
    const s = item("file.save", "保存", "文件", "Ctrl+S");
    expect(scoreItem(s, "ctrl+s")).toBeGreaterThan(0);
  });

  it("空查询保持注册表原顺序", () => {
    const items = paletteItems({});
    expect(filterItems(items, "").map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it("过滤后不匹配的项被剔除", () => {
    const items = [item("a", "新建标签"), item("b", "保存")];
    expect(filterItems(items, "保存").map((i) => i.id)).toEqual(["b"]);
  });
});

describe("M4 命令面板：交互", () => {
  it("打开后渲染命令并高亮第一项", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    expect(paletteOpen()).toBe(true);
    expect(rows().length).toBeGreaterThan(0);
    expect(activeRow()).toBe(rows()[0]);
    expect(document.body.classList.contains(PALETTE_OPEN_CLASS)).toBe(true);
  });

  it("同一时刻只开一个面板（连按 Ctrl+Shift+P 不叠加）", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    showCommandPalette({ overrides: {}, onRun: () => {} });
    expect(document.querySelectorAll(".palette-overlay").length).toBe(1);
  });

  it("输入即过滤，且高亮回到第一项", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    type("保存");
    const labels = rows().map((r) => r.querySelector(".palette-item-label")?.textContent);
    expect(labels.length).toBeGreaterThan(0);
    expect(activeRow()).toBe(rows()[0]);
  });

  it("↑↓ 移动高亮，走到头会绕回", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    const n = rows().length;
    pressKey("ArrowDown");
    expect(activeRow()).toBe(rows()[1]);
    pressKey("ArrowUp");
    expect(activeRow()).toBe(rows()[0]);
    pressKey("ArrowUp");
    expect(activeRow(), "第一项再往上应绕到最后一项").toBe(rows()[n - 1]);
  });

  it("Enter 执行当前高亮项并关闭面板", () => {
    const ran: string[] = [];
    showCommandPalette({ overrides: {}, onRun: (id) => ran.push(id) });
    pressKey("ArrowDown");
    const expected = activeRow()!.dataset.id;
    pressKey("Enter");
    expect(ran).toEqual([expected]);
    expect(paletteOpen()).toBe(false);
    expect(document.body.classList.contains(PALETTE_OPEN_CLASS)).toBe(false);
  });

  it("Esc 关闭且不执行任何命令", () => {
    const ran: string[] = [];
    showCommandPalette({ overrides: {}, onRun: (id) => ran.push(id) });
    pressKey("Escape");
    expect(ran).toEqual([]);
    expect(paletteOpen()).toBe(false);
  });

  it("点击某项即执行", () => {
    const ran: string[] = [];
    showCommandPalette({ overrides: {}, onRun: (id) => ran.push(id) });
    const row = rows()[2];
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ran).toEqual([row.dataset.id]);
  });

  it("关闭时回调 onClose（main 用它把焦点还给编辑器）", () => {
    let closed = 0;
    showCommandPalette({ overrides: {}, onRun: () => {}, onClose: () => closed++ });
    pressKey("Escape");
    expect(closed).toBe(1);
  });

  it("没有匹配时给出空态而不是空白列表", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    type("zzzzzzz");
    expect(rows().length).toBe(0);
    expect(document.querySelector(".palette-empty")).toBeTruthy();
  });
});
