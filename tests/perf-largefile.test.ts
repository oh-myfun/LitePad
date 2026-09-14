// @vitest-environment jsdom
// M4 大文件分级：perf.ts 的档位裁剪 + editor.ts 按档关掉昂贵扩展。
//
// 判据选择：CM6 没有公开的「扩展清单」API，所以一律用**可观测事实**——
// 挂到真实 DOM 上数 gutter、或用 languageDataAt 判断语言扩展是否注入，
// 而不是去猜内部字段名。这样 CM6 升级时测试不会因内部重构而假失败。
import { afterEach, describe, expect, it } from "vitest";
import { javascript } from "@codemirror/lang-javascript";
import { undo } from "@codemirror/commands";
import { createEditor, makeTabState } from "../src/editor/editor";
import { normalizeSizeClass, perfProfileFor, type SizeClass } from "../src/editor/perf";

const NOOP = (): void => {};
const CLASSES: SizeClass[] = ["normal", "large", "huge"];

interface Mounted {
  parent: HTMLElement;
  text(): string;
  view: ReturnType<typeof createEditor>["view"];
}

function mount(cls: SizeClass, doc = "x", lang: null | ReturnType<typeof javascript> = null) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const { state } = makeTabState(
    doc,
    lang,
    { dark: false, wrap: true, perf: perfProfileFor(cls) },
    NOOP,
  );
  const handle = createEditor(parent, state);
  const m: Mounted = { parent, view: handle.view, text: () => handle.getText() };
  return m;
}

afterEach(() => {
  for (const el of document.querySelectorAll("div.cm-editor")) el.parentElement?.remove();
  document.body.textContent = "";
});

describe("M4 perf：档位归一化", () => {
  it("未知值一律按 normal（宁可多给特性，也不误降级）", () => {
    expect(normalizeSizeClass("normal")).toBe("normal");
    expect(normalizeSizeClass("large")).toBe("large");
    expect(normalizeSizeClass("huge")).toBe("huge");
    expect(normalizeSizeClass(undefined)).toBe("normal");
    expect(normalizeSizeClass(null)).toBe("normal");
    expect(normalizeSizeClass("garbage")).toBe("normal");
    expect(normalizeSizeClass("")).toBe("normal");
  });
});

describe("M4 perf：各档位关掉什么", () => {
  it("normal 全开", () => {
    expect(perfProfileFor("normal")).toMatchObject({
      syntax: true,
      folding: true,
      bracketMatching: true,
      selectionMatches: true,
      activeLine: true,
      autoPreview: true,
    });
  });

  it("large 关掉依赖语法树与全文档扫描的特性", () => {
    const p = perfProfileFor("large");
    expect(p.syntax).toBe(false);
    expect(p.folding).toBe(false);
    expect(p.bracketMatching).toBe(false);
    expect(p.selectionMatches).toBe(false);
    // 当前行高亮很便宜，保留；预览不再自动渲染
    expect(p.activeLine).toBe(true);
    expect(p.autoPreview).toBe(false);
  });

  it("huge 在 large 基础上再关当前行高亮", () => {
    const p = perfProfileFor("huge");
    expect(p.syntax).toBe(false);
    expect(p.folding).toBe(false);
    expect(p.activeLine).toBe(false);
    expect(p.autoPreview).toBe(false);
  });

  it("档位单调递增：文件越大，特性只减不增", () => {
    const flags = (p: ReturnType<typeof perfProfileFor>) =>
      [p.syntax, p.folding, p.bracketMatching, p.selectionMatches, p.activeLine, p.autoPreview]
        .map((b) => (b ? 1 : 0))
        .join("");
    expect(flags(perfProfileFor("normal"))).toBe("111111");
    // 按位串比较：每降一档，只允许把 1 变 0
    for (const [hi, lo] of [
      ["normal", "large"],
      ["large", "huge"],
    ] as const) {
      const a = flags(perfProfileFor(hi));
      const b = flags(perfProfileFor(lo));
      for (let i = 0; i < a.length; i++) {
        expect(a[i] === "1" || b[i] === "0", `${hi}→${lo} 第 ${i} 项只应减少`).toBe(true);
      }
    }
  });
});

describe("M4 编辑器：语言扩展按档位注入", () => {
  /** 语言扩展是否真的注入：高亮/折叠/括号匹配都由语言数据驱动。 */
  function hasLangData(cls: SizeClass): boolean {
    const { state } = makeTabState(
      "const a = 1;",
      javascript(),
      { dark: false, wrap: true, perf: perfProfileFor(cls) },
      NOOP,
    );
    return state.languageDataAt<string>("commentTokens", 0).length > 0;
  }

  it("normal 有语言数据（高亮/折叠/括号匹配可用）", () => {
    expect(hasLangData("normal")).toBe(true);
  });

  it("large / huge 不注入语言扩展", () => {
    expect(hasLangData("large")).toBe(false);
    expect(hasLangData("huge")).toBe(false);
  });

  it("不传 perf 时按 normal 处理（新建文档不受影响）", () => {
    const { state } = makeTabState("const a = 1;", javascript(), { dark: false, wrap: true }, NOOP);
    expect(state.languageDataAt<string>("commentTokens", 0).length).toBeGreaterThan(0);
  });
});

describe("M4 编辑器：真实 DOM 上的降级效果", () => {
  it("折叠 gutter 只在 normal 出现", () => {
    expect(
      mount("normal", "a\nb", javascript()).parent.querySelector(".cm-foldGutter"),
    ).toBeTruthy();
    expect(mount("large", "a\nb", javascript()).parent.querySelector(".cm-foldGutter")).toBeNull();
    expect(mount("huge", "a\nb", javascript()).parent.querySelector(".cm-foldGutter")).toBeNull();
  });

  it("任何档位都必须保留行号（导航底线）", () => {
    for (const cls of CLASSES) {
      const m = mount(cls, "a\nb\ncc");
      expect(m.parent.querySelector(".cm-lineNumbers"), `${cls} 应有行号槽`).toBeTruthy();
      // 行数正确才算真的渲染出来
      expect(m.parent.querySelectorAll(".cm-gutterElement").length).toBeGreaterThan(1);
    }
  });

  it("任何档位都必须保留撤销历史（安全底线）", () => {
    for (const cls of CLASSES) {
      const m = mount(cls, "x");
      m.view.dispatch({ changes: { from: 0, insert: "abc" } });
      expect(m.text(), `${cls} 应能编辑`).toBe("abcx");
      undo(m.view);
      expect(m.text(), `${cls} 应能撤销`).toBe("x");
    }
  });

  it("降级不改变文档内容本身", () => {
    for (const cls of CLASSES) {
      expect(mount(cls, "line1\nline2", javascript()).text()).toBe("line1\nline2");
    }
  });
});
