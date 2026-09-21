// @vitest-environment jsdom
// M4 命令面板（src/shell/commandpalette.ts）：模糊匹配、键盘导航、执行与关闭。
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { topLevelFnBody } from "./static";
import {
  PALETTE_OPEN_CLASS,
  PALETTE_OVERLAY_CLASS,
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
  // ⚠️ 必须**用 Esc 正式关闭**，不能直接 remove 元素：
  // close() 里才会摘掉挂在 document 上的 keydown 监听。直接摘元素会把监听留在
  // document 上，后续用例按方向键时旧监听也会响应（打到已脱离文档的旧列表上），
  // 造成「一次按键触发多次滚动」这类幽灵现象。
  let guard = 0;
  while (document.querySelector(`.${PALETTE_OVERLAY_CLASS}`) && guard++ < 20) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  for (const el of document.querySelectorAll(".palette-overlay")) el.remove();
  for (const el of document.querySelectorAll(".popup-menu")) el.remove();
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

// ---- B70 C 档 ----
// 两个用户报告的缺陷：
//  1. 「光标挪到某一项时，列表会自动滚动到最顶端」—— 根因是悬停走整表重绘，
//     `list.textContent = ""` 把滚动位置归零。修法是悬停只切 `.is-active`。
//  2. 「有菜单打开着时呼出命令面板，菜单不消失」—— 菜单只认 Escape 与外部
//     pointerdown，不认键盘呼出，所以 Ctrl+Shift+P 时它原地留着、还压在面板之上。
describe("B70 C 档：悬停不重建列表 / 呼出面板顶掉菜单", () => {
  it("悬停只切 is-active，不销毁重建行（重建会让列表滚动位置归零）", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    const before = rows();
    expect(before.length).toBeGreaterThan(2);

    before[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    const after = rows();
    expect(after.length, "行数不变").toBe(before.length);
    // 节点同一性：一旦重建，这些引用全部失效（"列表弹回顶端" 的根因）
    expect(after[0], "第一行必须是同一个节点").toBe(before[0]);
    expect(after[2], "第 3 行也必须是同一个节点").toBe(before[2]);
    expect(activeRow()).toBe(after[2]);
  });

  it("鼠标悬停不调 scrollIntoView，只有键盘导航才滚动", () => {
    // 只统计**仍在文档里**的行：万一有用例留下没关闭的面板，那些旧监听会打到
    // 已脱离文档的旧列表上 —— 那是用例污染，不是本缺陷，不该计入。
    const live = (els: Element[]): Element[] => els.filter((e) => e.isConnected);
    const calls: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(this);
    };
    try {
      showCommandPalette({ overrides: {}, onRun: () => {} });
      expect(live(calls).length, "初次渲染本来就在顶端，不该滚动").toBe(0);

      rows()[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      expect(live(calls).length, "悬停不得触碰滚动位置（列表才不会弹回顶端）").toBe(0);

      pressKey("ArrowDown");
      expect(live(calls).length, "键盘导航才把选中行滚进视野").toBe(1);
      // 滚的必须是**当下高亮的那一行**（悬停已经把高亮挪到第 2 行，↓ 之后是第 3 行，
      // 所以这里不能写死 index）
      expect(live(calls)[0]).toBe(activeRow());
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("悬停在已选中行上不重复切态（避免无谓的写样式）", () => {
    showCommandPalette({ overrides: {}, onRun: () => {} });
    const first = rows()[0];
    expect(first.classList.contains("is-active")).toBe(true);
    first.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(rows()[0], "仍应是同一节点且仍选中").toBe(first);
    expect(activeRow()).toBe(first);
  });

  it("呼出命令面板会顶掉打开着的菜单", async () => {
    const { showPopupMenu, closePopupMenu } = await import("../src/shell/menu");
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    showPopupMenu(anchor, [{ label: "示例项" }]);
    expect(document.querySelector(".popup-menu"), "先得有菜单开着").toBeTruthy();

    showCommandPalette({ overrides: {}, onRun: () => {} });

    expect(document.querySelector(".popup-menu"), "面板一开菜单就该消失").toBeNull();
    expect(paletteOpen()).toBe(true);
    closePopupMenu();
  });
});

describe("C 档：命令面板两处修复", () => {
  const paletteSrc = readFileSync("src/shell/commandpalette.ts", "utf-8");
  it("悬停只切选中态，绝不重建列表（重建会把滚动位置归零 → 弹回顶端）", () => {
    const show = topLevelFnBody(paletteSrc, "function showCommandPalette");
    expect(show, "取不到 showCommandPalette").toBeTruthy();

    expect(paletteSrc, "必须有独立的 paint（只切 is-active，不碰 DOM 结构）").toMatch(
      /const paint = \(\): void => \{/,
    );
    expect(paletteSrc, "必须有 revealActive（滚动只在键盘导航时发生）").toMatch(
      /const revealActive = \(\): void => \{/,
    );
    expect(paletteSrc, "select 的第二个参数决定是否滚动").toMatch(
      /const select = \(i: number, reveal: boolean\): void => \{/,
    );

    // 鼠标路径：只 select(i, false) —— 不重建、不滚动
    const box = show.slice(show.indexOf('"mousemove"'));
    const handler = box.slice(0, box.indexOf("});"));
    expect(handler, "悬停必须走静默路径 select(i, false)").toMatch(/select\(i, false\);/);
    expect(handler, "悬停不得调 render()（那是重建列表）").not.toMatch(/render\(\)/);

    // 键盘路径：select(..., true) 才滚动
    expect(show, "↓ 必须滚动选中行").toMatch(/select\(\(active \+ 1\) % rows\.length, true\)/);
    expect(show, "↑ 必须滚动选中行").toMatch(
      /select\(\(active - 1 \+ rows\.length\) % rows\.length, true\)/,
    );

    // 渲染路径里不得再出现 scrollIntoView 调用：它曾经就在这里「重建完再补一次滚动」，
    // 而重建本身已经把滚动位置清零 —— 补不回来的那一次就是用户看到的「弹回顶端」。
    const renderBody = paletteSrc.slice(
      paletteSrc.indexOf("const render = ()"),
      paletteSrc.indexOf("const run = (id"),
    );
    expect(renderBody.length, "必须能截出渲染函数体").toBeGreaterThan(0);
    expect(renderBody, "渲染里不得再调 scrollIntoView").not.toMatch(/scrollIntoView\(/);
  });

  it("呼出面板先把打开着的菜单收掉（菜单只认 Esc / 外部 pointerdown，不认键盘呼出）", () => {
    expect(paletteSrc, "必须引入 closePopupMenu").toMatch(
      /import \{ closePopupMenu \} from "\.\/menu";/,
    );
    const show = topLevelFnBody(paletteSrc, "function showCommandPalette");
    const guard = show.indexOf("if (paletteOpen()) return;");
    const close = show.indexOf("closePopupMenu();");
    expect(guard, "取不到「已有面板就不叠第二层」的守卫").toBeGreaterThan(-1);
    expect(close, "必须调用 closePopupMenu").toBeGreaterThan(-1);
    expect(close, "收菜单必须在守卫之后（面板没开才需要收）").toBeGreaterThan(guard);
  });
});

it("命令面板：模块存在、命令已登记、main 已分发", () => {
  const km = readFileSync("src/shell/keymap.ts", "utf-8");
  expect(km, "必须登记 palette.open 命令").toMatch(/id: "palette\.open"/);

  const main = readFileSync("src/main.ts", "utf-8");
  expect(main).toMatch(/case "palette\.open":/);
  expect(main).toMatch(/showCommandPalette\(/);
  // 面板打开期间全局快捷键必须让路，否则输入框里的按键会触发命令
  expect(main).toMatch(/if \(paletteOpen\(\)\) return;/);
});
