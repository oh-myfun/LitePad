// @vitest-environment jsdom
// B230 下拉（src/shell/dropdown.ts）两条能力：
// 1) 限高：按上下可用空间动态给 maxHeight，只有选项区滚动 ⇒ 选项再多也不顶出视口。
// 2) 搜索：searchable 时列表顶部带搜索框，按 label + note 子串过滤。
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { createDropdown, type DropdownOption } from "../src/shell/dropdown";
import { ruleBlock, cssDecls, topLevelFnBody } from "./static";

const FONT_OPTS: DropdownOption[] = [
  { label: "默认（内嵌思源黑体）", value: "" },
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "Cascadia Mono", value: "Cascadia Mono" },
  { label: "Consolas", value: "Consolas" },
  { label: "Microsoft YaHei UI", value: "Microsoft YaHei UI" },
  { label: "霞鹜文楷", value: "LXGW WenKai", note: "（未安装）" },
];

function make(over: Partial<Parameters<typeof createDropdown>[0]> = {}) {
  return createDropdown({
    options: FONT_OPTS,
    current: "Consolas",
    onPick: () => {},
    ...over,
  });
}

/** 展开并返回 { list, optionsBox, search }。 */
function open(over: Partial<Parameters<typeof createDropdown>[0]> = {}) {
  const dd = make(over);
  document.body.appendChild(dd.root);
  (dd.root.querySelector(".dropdown-trigger") as HTMLButtonElement).click();
  const list = dd.root.querySelector(".dropdown-list") as HTMLElement;
  const search = dd.root.querySelector(".dropdown-search") as HTMLInputElement | null;
  const optionsBox = dd.root.querySelector(".dropdown-options") as HTMLElement | null;
  return { root: dd.root, list, search, optionsBox: optionsBox ?? list };
}

/**
 * 派发一个方向键。⚠️ 必须派到 `document` 上：dropdown 的 keydown 监听挂在
 * document 捕获阶段（openList 时注册），派到 list 上虽然会冒泡到 document，
 * 但主动派发到 document 更贴近真实按键路径。
 */
function key(k: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

function labels(box: HTMLElement): string[] {
  return [...box.querySelectorAll(".dropdown-option")].map((b) => b.textContent ?? "");
}

function type(search: HTMLInputElement, v: string): void {
  search.value = v;
  search.dispatchEvent(new Event("input"));
}

afterEach(() => {
  document.body.textContent = "";
  // jsdom 默认 1024x768，每条用例都从干净尺寸开始
  window.innerWidth = 1024;
  window.innerHeight = 768;
});

// jsdom 不实现 scrollIntoView（setActive 会调）——显式打桩成 no-op。
// ⚠️ 必须打桩而不是从实现里删掉那行：它是「高亮项滚进可视区」的唯一保证。
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
});

describe("B230 下拉限高：不再顶出视口", () => {
  it("展开时按可用空间给 maxHeight（不是靠整屏 max-height 兜）", () => {
    const { list } = open();
    const h = parseFloat(list.style.maxHeight);
    expect(Number.isFinite(h), "maxHeight 必须是具体像素值，不能为空").toBe(true);
    // 触发器在视口顶部附近（jsdom getBoundingClientRect 全 0）⇒ 下方空间≈整屏
    expect(h, "maxHeight 不应超过视口高度").toBeLessThanOrEqual(768 - 16);
    expect(h, "maxHeight 应有下限，别缩成一条缝").toBeGreaterThanOrEqual(120);
  });

  it("视口极矮时也只占视口高度，不会溢出", () => {
    window.innerHeight = 200;
    const { list } = open();
    const h = parseFloat(list.style.maxHeight);
    expect(h, "限高必须被视口高度压住").toBeLessThanOrEqual(200 - 16);
  });

  it("下方空间更小时用 translateY 翻到上方，且不越过触发器上沿", () => {
    // 触发器贴近视口底部：下方几乎没空间
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList?.contains("dropdown-trigger")) {
        return {
          left: 100,
          right: 320,
          top: 700,
          bottom: 728,
          width: 220,
          height: 28,
          x: 100,
          y: 700,
          toJSON: () => {},
        } as DOMRect;
      }
      return orig.call(this);
    };
    try {
      const { list } = open();
      expect(list.style.transform, "下方放不下应翻到上方").toBe("translateY(-100%)");
      // translateY(-100%) ⇒ 列表占据 [top - maxHeight, top]，底边贴 style.top
      const top = parseFloat(list.style.top);
      const h = parseFloat(list.style.maxHeight);
      expect(top, "翻上方时 style.top 应贴触发器上沿（700）").toBe(700 - 4);
      expect(top, "底边不得越过触发器上沿").toBeLessThanOrEqual(700);
      expect(top - h, "顶边不得小于视口上沿").toBeGreaterThanOrEqual(0);
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("翻到上方时 maxH 必然等于 above（只有 above > below 才翻，无需再单独收高）", () => {
    // 这条是**反向**判据：锁住「maxH 两侧取大」这个事实，防止有人再加一道
    // 按 above 收高的分支（当前几何下两者同值，那道分支是多余的）。
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList?.contains("dropdown-trigger")) {
        return {
          left: 100,
          right: 320,
          top: 620,
          bottom: 648,
          width: 220,
          height: 28,
          x: 100,
          y: 620,
          toJSON: () => {},
        } as DOMRect;
      }
      return orig.call(this);
    };
    try {
      const { list } = open();
      expect(list.style.transform, "上方更宽时应翻到上方").toBe("translateY(-100%)");
      // above = 620-4-8 = 608 > below = 108 ⇒ maxH 必为 608
      expect(parseFloat(list.style.maxHeight), "maxH 应等于 above(608)").toBe(608);
      expect(parseFloat(list.style.top) - 608, "顶边恰好落在视口上沿，不为负").toBe(8);
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("静态：positionList 必须走「可用空间」而不是旧的整块翻上判据", () => {
    const src = readFileSync("src/shell/dropdown.ts", "utf-8");
    const fn = topLevelFnBody(src, "createDropdown");
    expect(fn, "应能截到 createDropdown 函数体").not.toBe("");
    // 旧的失效判据：列表被限高后 listH≈整屏，`r.top - 4 - listH > 0` 恒假
    expect(fn, "不得再用 listH 判据翻上方").not.toContain("listH");
    // 反向闸排在正向之前
    expect(fn, "应按 below/above 计算可用空间").toMatch(
      /const below =[\s\S]{0,120}window\.innerHeight/,
    );
    expect(fn, "应取两侧较大者作为 maxHeight").toMatch(/Math\.max\(below, above\)/);
  });

  it("静态：只有 .dropdown-options 滚动，搜索框所在层不滚", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    // 展开态必须覆盖 .popup-menu 的 overflow-y: auto，否则整体滚动把搜索框卷走
    const open = cssDecls(ruleBlock(css, ".dropdown.open .dropdown-list"));
    expect(open, "展开态应显式 overflow: hidden").toContain("overflow: hidden");
    expect(open, "展开态应改成 flex 纵列").toContain("flex-direction: column");
    expect(open, "展开态应有 max-height 兜底").toContain("max-height");

    const box = cssDecls(ruleBlock(css, ".dropdown-options"));
    expect(box, "选项区才该滚动").toContain("overflow-y: auto");
    expect(box, "flex 子项要 min-height: 0（B209 同类坑）").toContain("min-height: 0");
  });
});

describe("B230 下拉搜索", () => {
  it("searchable 才建搜索框，默认不开", () => {
    expect(open().search, "默认不该有搜索框").toBeNull();
    expect(open({ searchable: true }).search, "searchable 应建搜索框").toBeTruthy();
  });

  it("输入即过滤 label 子串（大小写不敏感）", () => {
    const { search, optionsBox } = open({ searchable: true });
    type(search!, "consol");
    expect(labels(optionsBox), "大小写不敏感命中 Consolas").toEqual(["Consolas"]);
    // ⚠️ 用 label 里真有的子串：字体名是「Microsoft YaHei UI」，不含「雅黑」，
    // 搜中文别名命中不了 —— 这是预期行为（Rust 那边枚举的就是英文名）。
    type(search!, "yahei");
    expect(labels(optionsBox), "YaHei 子串命中").toEqual(["Microsoft YaHei UI"]);
  });

  it("note 也参与匹配（「未安装」标记搜得到）", () => {
    const { search, optionsBox } = open({ searchable: true });
    type(search!, "未安装");
    expect(labels(optionsBox), "应命中带 note 的项").toEqual(["霞鹜文楷（未安装）"]);
  });

  it("无命中时给空态提示，清空后恢复全量", () => {
    const { search, optionsBox } = open({ searchable: true });
    type(search!, "zzzz不存在");
    expect(labels(optionsBox), "无命中时不该有选项").toEqual([]);
    const empty = optionsBox.querySelector(".dropdown-empty");
    expect(empty, "应有空态提示").toBeTruthy();
    expect(empty!.textContent, "空态要带上搜索词").toContain("zzzz不存在");
    type(search!, "");
    expect(labels(optionsBox).length, "清空后应恢复全部 6 项").toBe(FONT_OPTS.length);
  });

  it("过滤后 ↑/↓ 在可见列表里移动，不会跳到看不见的项", () => {
    const { search, optionsBox } = open({ searchable: true });
    type(search!, "c");
    // 4 项：Consolas / Cascadia Code / Cascadia Mono / Mi**c**rosoft YaHei UI
    expect(labels(optionsBox).length, "c 应命中 4 项").toBe(4);
    // 输入后高亮落在第 0 项
    const btns = () => [...optionsBox.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
    expect(btns()[0].classList.contains("dd-active"), "过滤后高亮应回到第 0 项").toBe(true);
    // ArrowDown 在 4 项里循环，不会绕到被过滤掉的项上
    key("ArrowDown");
    expect(btns()[1].classList.contains("dd-active"), "↓ 应移到第 1 项").toBe(true);
    key("ArrowUp");
    expect(btns()[0].classList.contains("dd-active"), "↑ 应回到第 0 项").toBe(true);
    key("ArrowUp");
    expect(btns()[3].classList.contains("dd-active"), "↑ 越过第 0 项应循环到可见列表末项").toBe(
      true,
    );
  });

  it("回车选中高亮项并回调 onPick", () => {
    const seen: string[] = [];
    const { search, optionsBox } = open({
      searchable: true,
      onPick: (v) => seen.push(v),
    });
    type(search!, "cascadia mono");
    expect(labels(optionsBox), "应只剩 Cascadia Mono").toEqual(["Cascadia Mono"]);
    key("Enter");
    expect(seen, "回车应回调 onPick").toEqual(["Cascadia Mono"]);
  });

  it("搜索框里按 Space 能打出空格（不被全局键盘处理吃掉）", () => {
    const { search } = open({ searchable: true });
    const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    search!.dispatchEvent(e);
    expect(e.defaultPrevented, "Space 不该被 preventDefault").toBe(false);
  });

  it("重新展开时搜索词清空（与原生 select 一致）", () => {
    const { search: sMaybe, root } = open({ searchable: true });
    const search = sMaybe!; // searchable: true ⇒ 搜索框必建
    const trigger = root.querySelector(".dropdown-trigger") as HTMLButtonElement;
    type(search, "consol");
    expect(search.value).toBe("consol");
    trigger.click(); // 关闭
    expect(root.classList.contains("open"), "应已关闭").toBe(false);
    trigger.click(); // 再开
    expect(root.classList.contains("open"), "应已重新展开").toBe(true);
    expect(search.value, "重新展开应清空搜索词").toBe("");
    expect(root.querySelectorAll(".dropdown-option").length, "重新展开应显示全量选项").toBe(
      FONT_OPTS.length,
    );
  });

  it("设置页的字体下拉开了 searchable，主题等小下拉没开", () => {
    const src = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    const fn = topLevelFnBody(src, "fontRow");
    expect(fn, "应能截到 fontRow 函数体").not.toBe("");
    expect(fn, "字体下拉必须开 searchable").toContain("searchable: true");
    // 反向闸在前：通用 selectControl 不得被顺手打开搜索
    const sel = topLevelFnBody(src, "selectControl");
    expect(sel, "通用下拉不该开搜索").not.toContain("searchable");
  });
});
