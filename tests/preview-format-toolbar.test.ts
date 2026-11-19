// @vitest-environment jsdom
// B431 · 编辑态的悬浮格式工具条（照 InkNote 段落 / 格式两份菜单的功能全量覆盖）。
//
// 功能清单以 InkNote `src/components/menus.ts` 为契约：
//   · 段落菜单：H1–H6 / 正文、无序 / 有序 / 任务列表、引用、水平线、代码块、
//     插入目录、表格、公式块、Mermaid（表格编辑那组由表格自身的工具条承接）；
//   · 格式菜单：加粗、斜体、删除线、行内代码、高亮、下划线、上标、下标、链接、图片
//     （「复制 HTML」是剪贴板动作，不属于 Markdown 插入/编辑，不进工具条）。
//
// 图标口径（B446 定两轨、B448 定笔形）：
//   · 默认轨 = `src/shell/codicons.ts`（官方字体字形，16 网格），全应用同一口径；
//   · 补画轨 = `src/shell/toolbarMarks.ts`，**只收 codicon 里真没有的字形**：公式 Σ、
//     下划线 U、上标 x²、下标 x₂（B446 用户点名「按同笔补画」）+ Mermaid 流程图（B448
//     用户点名「调整 Mermaid 图表按钮图标」—— `type-hierarchy` 画的是圆节点的组织图，
//     不是 mermaid 那种方框 + 折线箭头，于是改补画第 5 枚、那颗替身随之下册）。
//   · B448 同时给补画册定了**笔形**：一律 16 网格、`fill="none"` + `stroke="currentColor"`、
//     根元素 `stroke-width="1.4"`（原先 Σ 是实心填充、笔画等效 2.2 ⇒ 在同排里明显比
//     codicon 粗一档，用户报「绘制线条过粗」）。
//
// 排布口径（B447 选定方案 B · 中折，B448 段落组加缩进两颗）：
//   历史 3 │ 模式切换 1 │ 段落 7 │ 插入 5 │ 格式 4 = 19 颗按钮 + 切换键 = 可见 20 颗。
//   折叠键（列表 / 公式·图表 / 更多格式）复用 `heading` 那套 `showPopupMenu`，
//   被折的 8 个动作全部进下拉，**功能面一条不许丢、也不许多一个入口** ⇒ 下面既核
//   「键 + 子项摊平 = 26 个动作」，也核「槽名（list / block / style）不算动作」。
//   三颗历史键的灰态另有一节：判据吃 CM6 历史深度 + `doc.dirty`，刷点两处（档位出口
//   与文本变化），漏接后者就是「打了一行字，撤销那颗还是灰的」。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import {
  buildMarkdownToc,
  insertImageAtCursor,
  insertLinkAtCursor,
  runFormat,
} from "../src/preview/format";
import {
  FORMAT_TOOLBAR_ITEMS,
  ensureFormatToolbar,
  historyToolbarState,
  syncFormatToolbarState,
} from "../src/preview/formatToolbar";
import { CODICONS } from "../src/shell/codicons";
import { TOOLBAR_MARKS } from "../src/shell/toolbarMarks";
import { closePopupMenu } from "../src/shell/menu";

/**
 * 补画轨的落点（B446 那几枚标记）。B447 起分两层看：
 *   · **键**上带补画字形的是 `block`（Σ）与 `underline`；
 *   · 上标 / 下标 / Mermaid 折进了下拉 —— 它们的调用点在**子项**的字形格里。
 * B450 再加三颗：缩进两颗（用户点名「用文本编辑器常用的那种」，codicon 那颗不是）
 * 与脚注（册里连就近替身都没有）。
 */
const DRAWN_MARK_BUTTONS = new Set(["block", "underline", "indent", "outdent", "footnote"]);

type ToolbarSlot = (typeof FORMAT_TOOLBAR_ITEMS)[number];

/** 折叠槽的子项（实现没这份字段时取到空数组，断言才不会在类型层先崩）。 */
const childrenOf = (item: ToolbarSlot): { id: string; icon: string }[] =>
  (item as unknown as { children?: { id: string; icon: string }[] }).children ?? [];

/** 一张表里两级字形引用：键自己的 + 各子项的。 */
const iconRefsOf = (item: ToolbarSlot): string[] => [
  item.icon as string,
  ...childrenOf(item).map((c) => c.icon),
];

/** 摊平成「动作 id」清单：键 + 子项（B447 后动作不再只住在顶层）。 */
const actionIdsOf = (item: ToolbarSlot): string[] => [
  item.id,
  ...childrenOf(item).map((c) => c.id),
];

function makeView(doc: string, selection?: { anchor: number; head?: number }) {
  const state = EditorState.create({ doc, selection });
  return new EditorView({ state, parent: document.body });
}

/** 让源码里的标记字符串走一遍与页面同一套序列化，比对才不被自闭合标签骗到。 */
function normalize(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.innerHTML;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mountToolbar(
  view: EditorView,
  deps?: Parameters<typeof ensureFormatToolbar>[2],
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return ensureFormatToolbar(container, () => view, deps);
}

describe("B431 工具条的按钮清单（覆盖 InkNote 段落 / 格式菜单）", () => {
  it("动作集合与 InkNote 两份菜单对齐（折叠后按「键 + 子项」摊平核），外加历史三颗与缩进两颗", () => {
    // 折叠键自己的 id（`list` / `block` / `style`）是**槽名**、不是动作 ⇒ 先摘掉再核。
    const SLOT_NAMES = new Set(["list", "block", "style"]);
    const actions = FORMAT_TOOLBAR_ITEMS.flatMap(actionIdsOf).filter((id) => !SLOT_NAMES.has(id));
    expect(new Set(actions)).toEqual(
      new Set([
        "heading",
        "bulletList",
        "orderedList",
        "taskList",
        "blockquote",
        "hr",
        "codeBlock",
        "toc",
        "table",
        "mathBlock",
        "mermaid",
        "bold",
        "italic",
        "strikethrough",
        "inlineCode",
        "highlight",
        "underline",
        "superscript",
        "subscript",
        "link",
        "image",
        // B447：撤销 / 恢复 / 保存不属于「Markdown 插入」，但它们住在同一条里
        "undo",
        "redo",
        "save",
        // B448：缩进调整（列表嵌套与目录层级都靠它）
        "indent",
        "outdent",
        // B450：脚注（插引用 + 在文末补一条定义）
        "footnote",
      ]),
    );
    // 一个动作只该有一个入口：27 条、去重后还是 27 条
    expect(actions).toHaveLength(27);
    expect(new Set(actions)).toHaveLength(27);
  });

  it("B446 · 图标两轨：codicon 有的走字体字形，确无对应的补画轨（键与子项都算调用点）", () => {
    const view = makeView("x", { anchor: 0 });
    const tools = mountToolbar(view);
    const buttons = tools.querySelectorAll<HTMLButtonElement>("button[data-action]");
    expect(buttons).toHaveLength(FORMAT_TOOLBAR_ITEMS.length);
    for (const btn of buttons) {
      const action = btn.dataset.action!;
      const item = FORMAT_TOOLBAR_ITEMS.find((i) => i.id === action)!;
      expect(btn.innerHTML.trim(), `${action} 没字形`).not.toBe("");
      expect(btn.getAttribute("aria-label")?.length, `${action} 没可读名`).toBeGreaterThan(0);
      expect(btn.querySelector(".md-preview-glyph"), `${action} 混入了文字字形`).toBeNull();
      const svg = btn.querySelector("svg");
      // 两本册子的键合起来才是 `item.icon` 的类型 ⇒ 按名字取，别让 TS 替我们判存在性
      const marks = TOOLBAR_MARKS as Record<string, string>;
      const icons = CODICONS as Record<string, string>;
      if (DRAWN_MARK_BUTTONS.has(action)) {
        expect(svg, `${action} 该用补画的标记（codicon 里真没有这个字形）`).toBeTruthy();
        // 比对要过一遍 DOM 序列化：源码里写的 `<path/>` 进了 innerHTML 会变成 `<path></path>`
        expect(svg!.outerHTML, `${action} 标记取错`).toBe(normalize(marks[item.icon]));
      } else {
        const glyph = btn.querySelector("i.codicon");
        expect(glyph, `${action} 不是 codicon 字形`).toBeTruthy();
        expect(glyph!.className, `${action} 没挂 codicon id`).toMatch(
          /^codicon codicon-[a-z0-9-]+$/,
        );
        // 比对**字形本身**而不是 innerHTML：折叠键的标签后面还挂着一颗下拉小箭头
        expect(glyph!.outerHTML, `${action} 字形取错`).toBe(icons[item.icon]);
      }
    }

    // 折进下拉的那些（上标 / 下标 / Mermaid…）：字形进了菜单项的 `.menu-icon` 格，
    // 一样得逐条对上 —— 否则「有标记没人用」会在这次折叠后悄悄成立。
    for (const item of FORMAT_TOOLBAR_ITEMS.filter((i) => childrenOf(i).length > 0)) {
      const btn = tools.querySelector<HTMLButtonElement>(`[data-action="${item.id}"]`)!;
      btn.click();
      const menu = document.querySelector(".popup-menu")!;
      const rows = Array.from(menu.querySelectorAll("button")).filter((b) =>
        b.querySelector(".menu-label"),
      );
      expect(rows, `${item.id} 的子项数与表里不一致`).toHaveLength(childrenOf(item).length);
      childrenOf(item).forEach((child, i) => {
        const cell = rows[i].querySelector(".menu-icon");
        expect(cell, `${item.id} › ${child.id} 没有字形格`).toBeTruthy();
        const marks = TOOLBAR_MARKS as Record<string, string>;
        const icons = CODICONS as Record<string, string>;
        const want = marks[child.icon] ?? icons[child.icon];
        expect(want, `${child.icon} 两本册子里都没有`).toBeTruthy();
        expect(cell!.innerHTML.trim(), `${item.id} › ${child.id} 字形取错`).toBe(
          normalize(want).trim(),
        );
      });
      closePopupMenu();
    }
    view.destroy();
  });

  it("B446/B448/B450 · 补画只补 codicon 真没有的：八颗在册、都有调用点（含折进下拉的子项）、跟着字色走", () => {
    expect(Object.keys(TOOLBAR_MARKS).sort()).toEqual(
      [
        "flowchart",
        "footnote",
        "indent",
        "math",
        "outdent",
        "subscript",
        "superscript",
        "underline",
      ].sort(),
    );
    for (const [name, svg] of Object.entries(TOOLBAR_MARKS)) {
      expect(svg, `${name} 不是 inline SVG`).toMatch(/^<svg\b/);
      expect(svg, `${name} 该画在 16 网格上（与 codicon 同格）`).toContain('viewBox="0 0 16 16"');
      expect(svg, `${name} 颜色不许写死（要跟着 --fg-muted 走）`).toContain("currentColor");
      expect(
        // B447 之后调用点分两级：键自己的字形 + 折叠键子项的字形（上下标住在下拉里）
        FORMAT_TOOLBAR_ITEMS.some((i) => iconRefsOf(i).includes(name)),
        `${name} 躺在那儿没人用`,
      ).toBe(true);
    }
    // 退场的「就近替身」不许留在 codicon 册里（红线：不躺零调用点的 id）。
    // ⚠️ `whole-word` 不在此列 —— 查找栏 / 资源管理器过滤框那颗全词开关还在用。
    const registry = readFileSync("src/shell/codicons.ts", "utf-8");
    for (const gone of [
      // 切换键预览档换成 `edit` ⇒ `unlock` 零调用点，同一条红线。 // B450：缩进两颗改补画（`indent:` 带冒号才咬得到册项，注释里也写着 `indent`）； // B448：Mermaid 从 `type-hierarchy` 换成补画的流程图 ⇒ 那颗短名跟着退场
      "symbolNumeric",
      "graph:",
      "typeHierarchySuper",
      "typeHierarchySub",
      "typeHierarchy",
      "indent:",
      "unlock:",
    ]) {
      expect(registry, `${gone} 该随替身一起退场`).not.toContain(gone);
    }
  });

  it("B448 · 笔形统一：描边不填充、根元素一支 1.4 的笔（Σ 那种实心块在同排里粗一档）", () => {
    for (const [name, svg] of Object.entries(TOOLBAR_MARKS)) {
      const head = /^<svg[^>]*>/.exec(svg)?.[0] ?? "";
      expect(head, `${name} 的根元素该描边（fill=none）`).toContain('fill="none"');
      expect(head, `${name} 的笔要经 currentColor 跟字色`).toContain('stroke="currentColor"');
      expect(head, `${name} 缺根元素线宽 ⇒ 会退回 1 与同排对不上`).toMatch(/stroke-width="1\.4"/);
      expect(svg, `${name} 不许拿实心填充画（B446 那版 Σ 就是这么粗的）`).not.toContain(
        'fill="currentColor"',
      );
    }
  });

  /**
   * B460 · 上下标那两枚的墨迹框（用户：「小数字太大且不够标准」）。
   *
   * 只吃 `M` / `L` / `Q` 的**绝对坐标**：`A` 的凸出量、`h`/`v` 的相对位移都得自己再算一遍，
   * 判据就成了「跟着画法重抄一遍」—— 两处一起绿的自伤就是这么来的。
   */
  function inkBoxes(name: "superscript" | "subscript") {
    const paths = [...String(TOOLBAR_MARKS[name]).matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length, `${name} 该是两支 path：一支 x、一支小写数字`).toBe(2);
    const box = (d: string) => {
      expect(d, `${name} 的 path 只许用绝对坐标 M/L/Q（A/h/v 量不准）`).not.toMatch(/[AaHhVv]/);
      const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      };
    };
    return { x: box(paths[0]), digit: box(paths[1]) };
  }

  it("B460 · 上标/下标的小数字收到 x 高的六成半，且真抬起/真落下（不是并排两颗大字）", () => {
    for (const name of ["superscript", "subscript"] as const) {
      const { x, digit } = inkBoxes(name);
      const xH = x.maxY - x.minY;
      const dH = digit.maxY - digit.minY;
      // 「太大」的直接反证：数字墨迹高不许过半档以上（标准排版里上标 ≈ 正文的 58–65%）
      expect(dH / xH, `${name} 的小数字相对 x 太高`).toBeLessThanOrEqual(0.7);
      expect(digit.maxX - digit.minX, `${name} 的小数字相对 x 太宽`).toBeLessThanOrEqual(xH * 0.7);
      // 位置：上标整颗抬到 x 顶之上、下标整颗落到 x 底之下（挨着但不重叠）
      if (name === "superscript") {
        expect(digit.maxY, "上标的小数字没抬到 x 之上").toBeLessThan(x.minY);
      } else {
        expect(digit.minY, "下标的小数字没落到 x 之下").toBeGreaterThan(x.maxY);
      }
      expect(digit.minX, `${name} 的小数字要住在 x 的右边`).toBeGreaterThan(x.maxX);
      // 留白：墨迹 + 半个笔宽不许贴 16 边框（贴边会被切）
      for (const v of [x.minX, x.minY, digit.minX, digit.minY]) {
        expect(v, `${name} 的墨迹贴到 16 网格左上边框了`).toBeGreaterThanOrEqual(2.0);
      }
      for (const v of [x.maxX, x.maxY, digit.maxX, digit.maxY]) {
        expect(v, `${name} 的墨迹贴到 16 网格右下边框了`).toBeLessThanOrEqual(14.0);
      }
    }
    const sup = inkBoxes("superscript").digit;
    const sub = inkBoxes("subscript").digit;
    // 两颗天然成对：同一个「2」，只是住在上下两处
    expect(sub.maxY - sub.minY, "上下标的小数字高度不一致").toBeCloseTo(sup.maxY - sup.minY, 2);
    expect(sub.maxX - sub.minX, "上下标的小数字宽度不一致").toBeCloseTo(sup.maxX - sup.minX, 2);
  });

  it("B444 · 图标取用收在一处：工具条不再引 vditorIcons，那个模块也已删除", () => {
    expect(existsSync("src/shell/vditorIcons.ts"), "vditorIcons.ts 该随 sprite 一起退场").toBe(
      false,
    );
    const src = readFileSync("src/preview/formatToolbar.ts", "utf-8");
    expect(src).not.toMatch(/from "\.\.\/shell\/vditorIcons"/);
    expect(src).toContain('from "../shell/codicons"');
  });

  it("重复同步不会重复建按钮（applyPanelMode 每帧都会调它）", () => {
    const view = makeView("x", { anchor: 0 });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const first = ensureFormatToolbar(container, () => view);
    const second = ensureFormatToolbar(container, () => view);
    expect(second).toBe(first);
    expect(container.querySelectorAll(".md-preview-tools")).toHaveLength(1);
    expect(container.querySelectorAll("button[data-action]")).toHaveLength(
      FORMAT_TOOLBAR_ITEMS.length,
    );
    view.destroy();
  });
});

describe("B431 按钮真的落到编辑器上", () => {
  it("加粗：选中一段 → 两侧补 **，选区仍罩原文", () => {
    const view = makeView("hello world", { anchor: 6, head: 11 });
    const tools = mountToolbar(view);
    tools.querySelector<HTMLButtonElement>('[data-action="bold"]')!.click();
    expect(view.state.doc.toString()).toBe("hello **world**");
    view.destroy();
  });

  it("标题下拉：列出正文 + 六级标题，选二级 → 行首写 ## ", async () => {
    const view = makeView("标题", { anchor: 0 });
    const tools = mountToolbar(view);
    tools.querySelector<HTMLButtonElement>('[data-action="heading"]')!.click();
    const menu = document.querySelector(".popup-menu");
    expect(menu, "标题键要弹出菜单").toBeTruthy();
    const labels = Array.from(menu!.querySelectorAll(".menu-label")).map((n) => n.textContent);
    expect(labels).toEqual([
      "正文",
      "一级标题",
      "二级标题",
      "三级标题",
      "四级标题",
      "五级标题",
      "六级标题",
    ]);
    const item = Array.from(menu!.querySelectorAll("button")).find(
      (b) => b.querySelector(".menu-label")?.textContent === "二级标题",
    );
    item!.click();
    expect(view.state.doc.toString()).toBe("## 标题");
    closePopupMenu();
    view.destroy();
  });

  it("链接：选择器回包 → 插入 [文本](url)，替换当前选区", async () => {
    const view = makeView("老文字", { anchor: 0, head: 3 });
    const tools = mountToolbar(view, {
      pickLink: async () => ({ text: "示例", url: "https://example.com" }),
    });
    tools.querySelector<HTMLButtonElement>('[data-action="link"]')!.click();
    await flush();
    expect(view.state.doc.toString()).toBe("[示例](https://example.com)");
    view.destroy();
  });

  it("图片：选择器回包 → 插入 ![alt](path)", async () => {
    const view = makeView("", { anchor: 0 });
    const tools = mountToolbar(view, {
      pickImage: async () => ({ alt: "图示", path: "assets/a.png" }),
    });
    tools.querySelector<HTMLButtonElement>('[data-action="image"]')!.click();
    await flush();
    expect(view.state.doc.toString()).toBe("![图示](assets/a.png)");
    view.destroy();
  });
});

describe("B431 插入目录（TOC）", () => {
  it("按标题层级生成缩进列表，锚点与渲染侧同源", () => {
    // 渲染侧（pipeline.extractToc）的 id 带 `h-` 前缀 —— 目录里的锚点必须用它，
    // 否则点了不落位（B401 的标题 id 契约）。
    expect(buildMarkdownToc("# Alpha\n\n## Beta\n\n### Gamma")).toBe(
      "- [Alpha](#h-alpha)\n  - [Beta](#h-beta)\n    - [Gamma](#h-gamma)",
    );
  });

  it("没有标题 → 返回空串（调用方不插任何东西）", () => {
    expect(buildMarkdownToc("正文\n\n```\n## 代码里的不算\n```")).toBe("");
  });

  it("runFormat('toc') 把目录插到当前行下方", () => {
    const view = makeView("# Alpha\n\n## Beta", { anchor: 0 });
    expect(runFormat(view, "toc")).toBe(true);
    expect(view.state.doc.toString()).toContain("- [Alpha](#h-alpha)\n  - [Beta](#h-beta)");
    view.destroy();
  });
});

describe("B431 插入助手可注入（TDD 与真机共用同一条路径）", () => {
  it("insertLinkAtCursor：默认文本取回包里的 text，空 text 回落 url", async () => {
    const view = makeView("", { anchor: 0 });
    await insertLinkAtCursor(view, async () => ({ text: "", url: "https://a.dev" }));
    expect(view.state.doc.toString()).toBe("[https://a.dev](https://a.dev)");
    view.destroy();
  });

  it("insertImageAtCursor：取消（null）一个字符都不改", async () => {
    const view = makeView("abc", { anchor: 1 });
    const ok = await insertImageAtCursor(view, async () => null);
    expect(ok).toBe(false);
    expect(view.state.doc.toString()).toBe("abc");
    view.destroy();
  });
});

// B447（用户点名「模式切换键单独成组 + 左侧加撤销/恢复/保存 + 按段落/格式重新分组 +
// 同类型或不常用的折成下拉」）里的「折」全部走**已有**的弹层先例：
// `showPopupMenu(anchor, items, undefined, { anchorToggle: true })` + `.md-preview-tool-caret`
// —— 就是 `heading` 那颗一直在用的那套，不新造菜单机制。
// 槽位口径取用户选定的**方案 B · 中折**（B448 段落组再加缩进两颗）：
//   19 颗按钮 + 切换键 = 可见 20 颗，组序 `历史(3) │ 模式(1) │ 段落(7) │ 插入(5) │ 格式(4)`。
describe("B447 分组与折叠（方案 B：历史3 │ 模式1 │ 段落7 │ 插入6 │ 格式4）", () => {
  it("槽清单：20 颗按钮按四组排列（切换键不住在 tools 里，它是 bar 的第一颗）", () => {
    expect(FORMAT_TOOLBAR_ITEMS.map((i) => i.id)).toEqual([
      "undo",
      "redo",
      "save",
      "heading",
      "list",
      "indent",
      "outdent",
      "blockquote",
      "hr",
      "codeBlock",
      "table",
      "toc",
      "block",
      "link",
      "image",
      // B450：脚注归插入组（它插的是「引用 + 文末一条定义」两段）
      "footnote",
      "bold",
      "italic",
      "underline",
      "style",
    ]);
    const count = (group: string) => FORMAT_TOOLBAR_ITEMS.filter((i) => i.group === group).length;
    expect(count("history"), "历史组 = 撤销 / 恢复 / 保存").toBe(3);
    expect(count("paragraph"), "段落组 = 标题 / 列表 / 缩进×2 / 引用 / 分割线 / 代码块").toBe(7);
    expect(count("insert"), "插入组 = 表格 / 目录 / 公式·图表 / 链接 / 图片 / 脚注").toBe(6);
    expect(count("format")).toBe(4);
  });

  it("折叠不丢功能：原 21 个段落 / 格式动作在「键 + 子项」摊平后一个不少", () => {
    const ids = FORMAT_TOOLBAR_ITEMS.flatMap(actionIdsOf);
    for (const want of [
      "heading",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
      "hr",
      "codeBlock",
      "toc",
      "table",
      "mathBlock",
      "mermaid",
      "bold",
      "italic",
      "strikethrough",
      "inlineCode",
      "highlight",
      "underline",
      "superscript",
      "subscript",
      "link",
      "image",
    ]) {
      expect(ids, `${want} 折进下拉后消失了`).toContain(want);
    }
    // 折起来的那几颗不许同时以「独立键」再出现一遍（否则同一动作有两个入口、宽度也白花）
    for (const folded of ["bulletList", "mathBlock", "strikethrough", "superscript"]) {
      expect(ids.filter((id) => id === folded)).toHaveLength(1);
    }
  });

  it("组界各一根分隔线，切换键自己占一组（tools 的第一根线就在键与历史组之间）", () => {
    const view = makeView("x", { anchor: 0 });
    const tools = mountToolbar(view);
    expect(tools.querySelectorAll("button[data-action]")).toHaveLength(20);
    const seps = tools.querySelectorAll(".md-preview-tool-sep");
    expect(seps, "键|历史|段落|插入|格式 ⇒ 4 根").toHaveLength(4);
    expect(tools.firstElementChild!.className, "第一颗之前要有那根线：模式组单独成组").toContain(
      "md-preview-tool-sep",
    );
    view.destroy();
  });

  it("四颗折叠键挂下拉箭头、点击只弹菜单不动文档；独立键不挂箭头", () => {
    const view = makeView("hello", { anchor: 0, head: 5 });
    const tools = mountToolbar(view);
    for (const id of ["heading", "list", "block", "style"]) {
      const btn = tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!;
      expect(btn.querySelector(".md-preview-tool-caret"), `${id} 该挂箭头`).toBeTruthy();
      btn.click();
      expect(document.querySelector(".popup-menu"), `${id} 点击要弹菜单`).toBeTruthy();
      expect(view.state.doc.toString(), `${id} 不该顺手改文档`).toBe("hello");
      closePopupMenu();
    }
    for (const id of ["bold", "hr", "undo", "redo", "save", "indent", "outdent", "footnote"]) {
      const btn = tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!;
      expect(btn.querySelector(".md-preview-tool-caret"), `${id} 不该挂箭头`).toBeNull();
    }
    view.destroy();
  });

  it("列表▾ 三条子项各归位：选「有序列表」真把行首写成 1.", () => {
    const view = makeView("hello", { anchor: 0 });
    const tools = mountToolbar(view);
    tools.querySelector<HTMLButtonElement>('[data-action="list"]')!.click();
    const menu = document.querySelector(".popup-menu")!;
    expect(Array.from(menu.querySelectorAll(".menu-label")).map((n) => n.textContent)).toEqual([
      "无序列表",
      "有序列表",
      "任务列表",
    ]);
    Array.from(menu.querySelectorAll("button"))
      .find((b) => b.querySelector(".menu-label")?.textContent === "有序列表")!
      .click();
    expect(view.state.doc.toString()).toBe("1. hello");
    closePopupMenu();
    view.destroy();
  });

  it("块▾ = 数学公式块 / Mermaid 图表；样式▾ = 删除线 / 高亮 / 行内代码 / 上标 / 下标", () => {
    const view = makeView("hello", { anchor: 0 });
    const tools = mountToolbar(view);
    const labelsOf = (action: string): string[] => {
      tools.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
      const menu = document.querySelector(".popup-menu");
      const labels = Array.from(menu?.querySelectorAll(".menu-label") ?? []).map(
        (n) => n.textContent,
      );
      closePopupMenu();
      return labels;
    };
    expect(labelsOf("block")).toEqual(["数学公式块", "Mermaid 图表"]);
    expect(labelsOf("style")).toEqual(["删除线", "高亮", "行内代码", "上标", "下标"]);
    view.destroy();
  });

  it("B450 · 镜像只剩撤销一颗：减少缩进改补画自己的形状（不再拿 indent 反着画）", () => {
    const view = makeView("x", { anchor: 0 });
    const tools = mountToolbar(view);
    const codiconOf = (id: string) =>
      tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!.querySelector("i.codicon")
        ?.outerHTML;
    const svgOf = (id: string) =>
      tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!.querySelector("svg")
        ?.outerHTML;
    // 撤销 = `redo` 反着画（官方册里没有 undo 这一颗）
    expect(codiconOf("undo")).toBe((CODICONS as Record<string, string>).redo);
    expect(codiconOf("redo")).toBe((CODICONS as Record<string, string>).redo);
    // 缩进两颗各画一枚（用户点名「用文本编辑器常用的那种」：行 + 方向相反的箭头）
    expect(svgOf("indent"), "增加缩进该是自己的补画标记").toBe(normalize(TOOLBAR_MARKS.indent));
    expect(svgOf("outdent"), "减少缩进该是自己的补画标记").toBe(normalize(TOOLBAR_MARKS.outdent));
    expect(svgOf("indent")).not.toBe(svgOf("outdent"));
    expect(codiconOf("indent") ?? codiconOf("outdent"), "两颗都不再吃 codicon 字形").toBeFalsy();
    // 镜像只写在 CSS 里（同一颗字形反向），键自己身上那颗类是唯一开关
    expect(tools.querySelector('[data-action="undo"]')!.className).toContain(
      "md-preview-tool--flip",
    );
    expect(
      tools.querySelector('[data-action="outdent"]')!.className,
      "减少缩进有自己的形状，不该再靠镜像",
    ).not.toContain("md-preview-tool--flip");
    expect(tools.querySelector('[data-action="redo"]')!.className).not.toContain(
      "md-preview-tool--flip",
    );
    expect(tools.querySelector('[data-action="indent"]')!.className).not.toContain(
      "md-preview-tool--flip",
    );
    const css = readFileSync("src/styles/preview.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    // 镜像得真落到 codicon 元素上
    expect(css).toMatch(/\.md-preview-tool--flip\s+\.codicon\s*\{[^}]*scaleX\(-1\)/s);
    // 补画册的每一颗都得是「codicon 真没有」—— 撤销那颗仍不许为它画一枚
    expect(TOOLBAR_MARKS).not.toHaveProperty("undo");
    const registry = readFileSync("src/shell/codicons.ts", "utf8");
    expect(registry, "镜像的键不许另立短名").not.toMatch(/^\s*(undo|outdent):/m);
    view.destroy();
  });

  it("历史三颗的动作从 deps 注入：点了才动，工具条不反向引 commands", () => {
    const view = makeView("x", { anchor: 0 });
    const hits: string[] = [];
    const deps = {
      onUndo: () => hits.push("undo"),
      onRedo: () => hits.push("redo"),
      onSave: () => hits.push("save"),
    } as unknown as Parameters<typeof ensureFormatToolbar>[2];
    const tools = mountToolbar(view, deps);
    for (const id of ["undo", "redo", "save"]) {
      tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!.click();
    }
    expect(hits).toEqual(["undo", "redo", "save"]);
    // 提示带键位（与页面内那颗切换键的 `Ctrl+E` 同款）：三颗都各有既定快捷键，
    // 工具条上看不出来就等于让用户白按一次。
    const tipKey = (id: string) =>
      tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!.dataset.tipKey;
    expect(tipKey("undo"), "撤销的提示要写 Ctrl+Z").toBe("Ctrl+Z");
    expect(tipKey("redo")).toBe("Ctrl+Y");
    expect(tipKey("save")).toBe("Ctrl+S");
    const src = readFileSync("src/preview/formatToolbar.ts", "utf-8");
    expect(src, "反向依赖会让 preview 层去命令层要点东西（deps 注入是唯一出口）").not.toMatch(
      /from "\.\.\/(commands|markdown)"/,
    );
    view.destroy();
  });

  it("菜单项字形是 MenuItem 的可选字段：不传就一格不留（老菜单零变化）", () => {
    const menu = readFileSync("src/shell/menu.ts", "utf-8");
    expect(menu).toMatch(/icon\?:\s*string/);
    expect(menu).toContain('className = "menu-icon"');
    const css = readFileSync("src/styles/global.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.popup-menu button \.menu-icon\s*\{([^}]*)\}/s.exec(css)?.[1] ?? "";
    expect(rule, "字形格必须定宽，否则标签左沿会随有条形没条形错开").toMatch(/flex:\s*0 0 16px/);
    // codicon.css 用 `font` 简写（自带 font-size）⇒ 字号只能挂在内层 .codicon 上（B208）
    // 字号那一族照 `.menu-arrow .codicon` 的**短选择器**写：带上 `.popup-menu` 前缀会被
    // B337 那条按子串过滤的自证判据扫进去（图标声明冒充文字字阶）。
    expect(css).toMatch(/(?:^|\n)\.menu-icon \.codicon\s*\{[^}]*font-size:\s*16px/s);
    expect(css).toMatch(/(?:^|\n)\.menu-icon svg\s*\{[^}]*width:\s*16px/s);
  });
});

// B447-2 · 三颗历史键的可用态（用户选定「全按状态置灰」）：
//   · 判据 = CM6 历史深度（`undoDepth` / `redoDepth`，没有 history 扩展时恒 0，不炸）
//            + 文档脏态（`doc.dirty` 是唯一权威 —— 与标签上那颗原点同源）；
//   · 置灰 = 原生 `disabled`（点了不发事件，比「handler 里自己拦」少一条静默失败的路）；
//   · 刷新点 = 档位出口（`syncPreviewEditFab`）**加**文本变化（main.handleUpdate）两处，
//     漏掉后者的话「打了一行字，撤销那颗还是灰的」。
describe("B447 历史三颗按状态置灰", () => {
  const disabledOf = (tools: HTMLElement, id: string): boolean =>
    tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!.disabled;

  function makeHistoryView(doc: string): EditorView {
    const state = EditorState.create({ doc, extensions: [history()] });
    return new EditorView({ state, parent: document.body });
  }

  it("判据真吃历史：新文档只有保存亮 → 打一次字撤销亮 → 撤销后恢复亮", () => {
    const view = makeHistoryView("abc");
    const tools = mountToolbar(view);
    const sync = () => syncFormatToolbarState(tools, historyToolbarState(view, true));
    sync();
    expect(disabledOf(tools, "undo"), "没改过就没有可撤销").toBe(true);
    expect(disabledOf(tools, "redo")).toBe(true);
    expect(disabledOf(tools, "save"), "脏着 ⇒ 保存该亮").toBe(false);

    view.dispatch({ changes: { from: 3, insert: "d" } });
    sync();
    expect(disabledOf(tools, "undo"), "打了一个字就该能撤").toBe(false);
    expect(disabledOf(tools, "redo")).toBe(true);

    undo(view);
    sync();
    expect(disabledOf(tools, "undo"), "撤到底了").toBe(true);
    expect(disabledOf(tools, "redo"), "撤过就该能恢复").toBe(false);
    view.destroy();
  });

  it("保存那颗跟着 doc.dirty：不脏就灰（不靠「点了才发现没得存」）", () => {
    const view = makeHistoryView("abc");
    const tools = mountToolbar(view);
    syncFormatToolbarState(tools, historyToolbarState(view, false));
    expect(disabledOf(tools, "save")).toBe(true);
    syncFormatToolbarState(tools, historyToolbarState(view, true));
    expect(disabledOf(tools, "save")).toBe(false);
    view.destroy();
  });

  it("置灰走原生 disabled：那一下点不出回调", () => {
    const view = makeHistoryView("abc");
    let hits = 0;
    const deps = { onSave: () => hits++ } as unknown as Parameters<typeof ensureFormatToolbar>[2];
    const tools = mountToolbar(view, deps);
    syncFormatToolbarState(tools, { canUndo: false, canRedo: false, canSave: false });
    tools.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    expect(hits, "灰着的键不该动磁盘").toBe(0);
    syncFormatToolbarState(tools, { canUndo: false, canRedo: false, canSave: true });
    tools.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    expect(hits).toBe(1);
    view.destroy();
  });

  it("只动那三颗：段落 / 插入 / 格式 17 颗一颗不沾", () => {
    const view = makeHistoryView("abc");
    const tools = mountToolbar(view);
    syncFormatToolbarState(tools, { canUndo: false, canRedo: false, canSave: false });
    const off = Array.from(tools.querySelectorAll<HTMLButtonElement>("button:disabled")).map(
      (b) => b.dataset.action,
    );
    expect(off.sort()).toEqual(["redo", "save", "undo"]);
  });

  it("CSS 契约：置灰与菜单项同一档（0.4 + default 指针），键不藏", () => {
    const css = readFileSync("src/styles/preview.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.md-preview-tool:disabled\s*\{([^}]*)\}/s.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/opacity:\s*0\.4/);
    expect(rule).toMatch(/cursor:\s*default/);
    // 灰 ≠ 没：不许 display / visibility（用户口径是「置灰不隐藏」，B331 同源）
    expect(rule).not.toMatch(/display:/);
    expect(rule).not.toMatch(/visibility:/);
    // 灰掉的键也不该吃悬停底（菜单那边同款）
    expect(css).toMatch(/\.md-preview-tool:hover:not\(:disabled\)/s);
  });

  it("接线：三颗落点从 markdown.ts 注入，档位出口与文本变化两处都刷", () => {
    const md = readFileSync("src/markdown.ts", "utf-8");
    expect(md, "撤销/恢复该走当前实例的 view").toMatch(/onUndo:\s*\(\)/);
    expect(md).toMatch(/onRedo:\s*\(\)/);
    expect(md, "保存那颗的落点与 Ctrl+S 同一个 doSave（不另开一条写盘路）").toMatch(
      /onSave:\s*\(\)/,
    );
    expect(md).toMatch(/doSave\(false\)/);
    expect(md, "档位出口：切档 / 切标签那一刻就得刷一次").toMatch(/refreshHistoryTools\(/);
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "文本变化：打第一个字那一刻撤销要亮起来（漏这处就是「撤销永远灰」）").toMatch(
      /refreshHistoryTools\(/,
    );
  });
});

// B448 · 缩进调整两颗（用户点名「添加缩进调整按钮」）。
// 一级 = **两个空格**，与 `buildMarkdownToc` 的 `"  ".repeat(level)`、大纲侧的
// `Math.floor(indent / 2)` 同一口径 —— 换一档就会让工具条缩出来的列表在大纲里少一层。
describe("B448 缩进调整（增加 / 减少）", () => {
  it("runFormat('indent')：选区跨几行就各加一级，已有缩进照旧保留（嵌套不是拉平）", () => {
    const view = makeView("- 甲\n  - 乙\n\n正文", { anchor: 0, head: 10 });
    expect(runFormat(view, "indent")).toBe(true);
    expect(view.state.doc.toString()).toBe("  - 甲\n    - 乙\n\n正文");
    view.destroy();
  });

  it("runFormat('outdent')：一次退一级（两个空格），只剩一个空格就退到顶", () => {
    const view = makeView("    - 甲", { anchor: 0 });
    runFormat(view, "outdent");
    expect(view.state.doc.toString()).toBe("  - 甲");
    runFormat(view, "outdent");
    expect(view.state.doc.toString()).toBe("- 甲");
    runFormat(view, "outdent");
    expect(view.state.doc.toString(), "没有缩进时不许把正文吃掉").toBe("- 甲");
    view.destroy();
  });

  it("空行不参与：缩进空行在 Markdown 里没有意义，还会把行尾空白写进文件", () => {
    const view = makeView("甲\n\n乙", { anchor: 0, head: 4 });
    runFormat(view, "indent");
    expect(view.state.doc.toString()).toBe("  甲\n\n  乙");
    view.destroy();
  });

  it("制表符缩进也退一级（一个 tab 算一级，不留半个）", () => {
    const view = makeView("\t- 甲", { anchor: 0 });
    runFormat(view, "outdent");
    expect(view.state.doc.toString()).toBe("- 甲");
    view.destroy();
  });

  it("两枚键真落到编辑器上（与 runFormat 同一入口，不是只画了个键）", () => {
    const view = makeView("- 甲", { anchor: 0 });
    const tools = mountToolbar(view);
    tools.querySelector<HTMLButtonElement>('[data-action="indent"]')!.click();
    expect(view.state.doc.toString()).toBe("  - 甲");
    tools.querySelector<HTMLButtonElement>('[data-action="outdent"]')!.click();
    expect(view.state.doc.toString()).toBe("- 甲");
    view.destroy();
  });

  it("两颗各有可读名（条上只有字形，读屏与悬停都靠 label）", () => {
    const view = makeView("x", { anchor: 0 });
    const tools = mountToolbar(view);
    const label = (id: string) =>
      tools.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!.getAttribute("aria-label");
    expect(label("indent")).toBe("增加缩进");
    expect(label("outdent")).toBe("减少缩进");
    // ⚠️ 这两颗**不带**键位提示：Tab / Shift+Tab 走的是 CM6 的 `indentUnit`（编辑器里
    // 是 4 空格），与本条的 Markdown 一级（2 空格）不是同一档 —— 写上反而误导。
    expect(
      tools.querySelector<HTMLButtonElement>('[data-action="indent"]')!.dataset.tipKey,
    ).toBeUndefined();
    view.destroy();
  });
});

/** 取那一枚闭合箭头（`…Z`）的顶点 —— 只认绝对坐标的 M/L 点对。 */
function arrowPoints(svg: string): [number, number][] {
  const d = /<path d="([^"]*Z[^"]*)"/i.exec(svg)?.[1];
  expect(d, "没有闭合的箭头那一笔").toBeTruthy();
  const nums = (d!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

describe("B450 缩进两颗改补画（文本编辑器常用的那种：几行字 + 一支箭头）", () => {
  it("两枚都是「四行字 + 一支箭头」：横画四根、箭头一笔闭合", () => {
    for (const name of ["indent", "outdent"] as const) {
      const svg = TOOLBAR_MARKS[name];
      const lines = [...svg.matchAll(/<path d="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((d) => !/Z/i.test(d));
      expect(lines.join(" ").match(/H/g), `${name} 该有四根横画`).toHaveLength(4);
      expect(arrowPoints(svg), `${name} 的箭头是三个顶点`).toHaveLength(3);
    }
  });

  it("箭头方向相反：增加缩进朝右、减少缩进朝左（两颗天然成对）", () => {
    const tip = (name: "indent" | "outdent"): number => {
      const pts = arrowPoints(TOOLBAR_MARKS[name]);
      const xs = pts.map((p) => p[0]);
      // 三角形里「x 唯一」的那个点就是尖：底边那两点 x 相同
      const unique = xs.filter((x) => xs.filter((o) => o === x).length === 1);
      expect(unique, `${name} 的箭头画得不像三角形`).toHaveLength(1);
      return unique[0];
    };
    expect(tip("indent"), "增加缩进的尖该在右边").toBeGreaterThan(tip("outdent"));
    const ys = (name: "indent" | "outdent") => arrowPoints(TOOLBAR_MARKS[name]).map((p) => p[1]);
    expect(ys("indent").sort()).toEqual(ys("outdent").sort());
  });

  it("墨迹不贴 16 边框、也不与横画粘连（B448 那三条病）", () => {
    for (const name of ["indent", "outdent"] as const) {
      const svg = TOOLBAR_MARKS[name];
      const pts = arrowPoints(svg);
      for (const [x, y] of pts) {
        expect(x, `${name} 贴左右边框`).toBeGreaterThan(1.5);
        expect(x, `${name} 贴左右边框`).toBeLessThan(14.5);
        expect(y, `${name} 贴上下边框`).toBeGreaterThan(1.5);
        expect(y, `${name} 贴上下边框`).toBeLessThan(14.5);
      }
      // 箭头尖与**同一横带里**那几行字之间要留得下两支笔（1.4 + 1.4 ⇒ 缝隙 ≥ 2 单位）；
      // 通栏那两行在箭头上/下，本来就横过去，比的是纵向留白。
      const ys = [...svg.matchAll(/M(-?[\d.]+) (-?[\d.]+)H/g)].map((m) => Number(m[2]));
      const xs = [...svg.matchAll(/M(-?[\d.]+) (-?[\d.]+)H/g)].map((m) => Number(m[1]));
      const bandTop = Math.min(...pts.map((p) => p[1]));
      const bandBottom = Math.max(...pts.map((p) => p[1]));
      const tipX = Math.max(...pts.map((p) => p[0]));
      // 箭头尖与**同一横带里**那几行字之间要留得下两支笔（1.4 + 1.4 ⇒ 缝隙 ≥ 2 单位）；
      // 通栏那两行在箭头上/下，本来就横过去，比的是纵向留白。
      const inBand = ys
        .map((y, i) => [y, xs[i]] as const)
        .filter(([y]) => y > bandTop - 2 && y < bandBottom + 2);
      expect(inBand.length, "箭头那一横带里该有缩进去的那两行").toBeGreaterThanOrEqual(2);
      for (const [y, x1] of inBand) {
        expect(x1 - tipX, `${name} 的箭头与 y=${y} 那行糊在一起`).toBeGreaterThanOrEqual(2);
      }
      expect(
        bandTop - Math.max(...ys.filter((y) => y < bandTop)),
        `${name} 箭头贴上那行`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        Math.min(...ys.filter((y) => y > bandBottom)) - bandBottom,
        `${name} 箭头贴下那行`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("B450 脚注插入", () => {
  it("光标处写 [^1]、文末补一行定义，光标落在定义里等打字", () => {
    const doc = "这里要加一条脚注。";
    const view = makeView(doc, { anchor: doc.length });
    expect(runFormat(view, "footnote")).toBe(true);
    expect(view.state.doc.toString()).toBe(`${doc}[^1]\n\n[^1]: `);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it("编号避开已用过的：文档里已有 [^1] ⇒ 新那条是 [^2]", () => {
    const view = makeView("正文[^1]\n\n[^1]: 一", { anchor: 2 });
    runFormat(view, "footnote");
    expect(view.state.doc.toString()).toBe("正文[^2][^1]\n\n[^1]: 一\n\n[^2]: ");
    view.destroy();
  });

  it("光标在文末也不炸：引用与定义两段挨着 ⇒ 合成一发 change", () => {
    const view = makeView("甲", { anchor: 1 });
    expect(() => runFormat(view, "footnote")).not.toThrow();
    expect(view.state.doc.toString()).toBe("甲[^1]\n\n[^1]: ");
    view.destroy();
  });

  it("空文档：引用单独一段、定义空一行跟上（不许贴成 [^1][^1]: 那种一串）", () => {
    const view = makeView("", { anchor: 0 });
    runFormat(view, "footnote");
    expect(view.state.doc.toString()).toBe("[^1]\n\n[^1]: ");
    view.destroy();
  });

  it("工具条那颗真走同一入口（点一下文档就长出这两段）", () => {
    const view = makeView("正文", { anchor: 2 });
    const tools = mountToolbar(view);
    tools.querySelector<HTMLButtonElement>('[data-action="footnote"]')!.click();
    expect(view.state.doc.toString()).toBe("正文[^1]\n\n[^1]: ");
    view.destroy();
  });

  it("那颗有自己的可读名，且吃补画册里的 footnote 字形", () => {
    const view = makeView("x", { anchor: 0 });
    const tools = mountToolbar(view);
    const btn = tools.querySelector<HTMLButtonElement>('[data-action="footnote"]')!;
    expect(btn.getAttribute("aria-label")).toBe("脚注");
    expect(btn.querySelector("svg")!.outerHTML).toBe(normalize(TOOLBAR_MARKS.footnote));
    view.destroy();
  });
});
