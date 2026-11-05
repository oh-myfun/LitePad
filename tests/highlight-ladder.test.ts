// @vitest-environment jsdom
// B425 · 查找高亮的分档与「在选区中查找」那一层。
//
// 用户口径（2026-10-30，原文）：
//   「搜索结果选区内和选区外的高亮效果区分要明显一点，平时选择文本出现的自动高亮也一样。」
//
// 判据分两半：
//   ① 装饰层 —— 范围带必须按**整行**画（VS Code 的 findDecorations `_FIND_SCOPE_DECORATION`
//      是 isWholeLine），并且不许与命中装饰撞车（各行一颗 StateField，各供一份 decorations）。
//   ② 分档 —— 把 global.css 的取值**合成到各档底色上**再算 RGB 距离。判「看不看得出区别」
//      只有量合色才有鉴别力：alpha 差一档在深底上几乎显不出来（旧那两档 Δ5.9 / Δ8.8）。
//
// 取色出处：`E:/Project/vscode`（1.143）
//   2026-dark.json / 2026-light.json 的 editor.findRangeHighlightBackground，
//   src/vs/platform/channel 无关；其余四族都没覆盖 ⇒ 落 editorColors.ts 的注册默认。
import { SearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { findHighlight, scopeLineStarts, setFindQuery } from "../src/editor/find";
import { stripCssComments } from "./static";

const CSS = "src/styles/global.css";

type RGB = [number, number, number];

// ---------------------------------------------------------------- ① 范围带的行

describe("B425 · 「在选区中查找」的范围带落在哪几行", () => {
  //  行首位置：0（甲甲）3（针一）6（针二）9（针三）12（乙乙）；文档长 14
  const doc = "甲甲\n针一\n针二\n针三\n乙乙";
  const text = EditorState.create({ doc }).doc;

  it("覆盖选区经过的每一行（整行带，不是只涂选区那截）", () => {
    expect(scopeLineStarts(text, { from: 4, to: 10 })).toEqual([3, 6, 9]);
  });

  it("选区终点正好落在下一行行首时，那一行不算", () => {
    expect(scopeLineStarts(text, { from: 4, to: 9 })).toEqual([3, 6]);
    expect(scopeLineStarts(text, { from: 4, to: 10 })).toContain(9);
  });

  it("没有范围（没开「在选区中查找」）就没有带；空选区与越界都不画", () => {
    expect(scopeLineStarts(text, null)).toEqual([]);
    expect(scopeLineStarts(text, { from: 5, to: 5 })).toEqual([]);
    expect(scopeLineStarts(text, { from: 99, to: 999 })).toEqual([]);
  });

  it("装饰真的挂上 .cm-line，且与命中装饰共存不打架（两颗 StateField 各供一份）", () => {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [findHighlight()] }),
      parent: document.body,
    });
    view.dispatch({
      effects: setFindQuery.of({
        query: new SearchQuery({ search: "针" }),
        activeFrom: 6,
        restrict: { from: 4, to: 10 },
      }),
    });
    const banded = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-find-range")];
    expect(banded.length, "带子应覆盖选区经过的三行").toBe(3);
    expect(banded.map((e) => e.textContent)).toEqual(["针一", "针二", "针三"]);
    // 选区从第 2 行行内开始 ⇒ 第 1 行行首那枚命中（from=3）落在范围外，只剩两枚
    expect(view.contentDOM.querySelectorAll(".cm-find-match").length, "命中照旧画").toBe(2);

    view.dispatch({
      effects: setFindQuery.of({ query: null, activeFrom: null, restrict: null }),
    });
    expect(view.contentDOM.querySelectorAll(".cm-find-range").length, "关栏不许留残影").toBe(0);
    expect(view.contentDOM.querySelectorAll(".cm-find-match").length, "命中也不许留残影").toBe(0);
    view.destroy();
  });
});

// ---------------------------------------------------------------- ② 分档的距离

type Mode = "dark" | "light";
type Family = "2026" | "modern" | "plus" | "classic" | "hc";

/** 顶层规则（选择器组 + 块体）。主题声明都在顶层，at-rule 里的内层选择器对不上号就忽略。 */
function topRules(code: string): { sels: string[]; body: string }[] {
  const out: { sels: string[]; body: string }[] = [];
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({
      sels: m[1].split(",").map((s) => s.replace(/\s+/g, " ").trim()),
      body: m[2],
    });
  }
  return out;
}

/**
 * 某一变体里某颗 token 的**最终生效值**：按浏览器级联 —— 基座 < 深浅块 < 族块，
 * 同层里后写的顶先写的。`var(--x)` 在同一变体里展开一次（`--find-match-border: var(--accent)`）。
 * ⚠️ 不能只读第一张 `:root[data-theme="dark"]`：2026 那一族就住在深浅块里，其余族各有覆盖块。
 */
function tokenOf(
  rules: { sels: string[]; body: string }[],
  mode: Mode,
  family: Family,
  name: string,
  depth = 0,
): string {
  const tiers = [
    [":root"],
    [`:root[data-theme="${mode}"]`],
    [`:root[data-theme="${mode}"][data-theme-family="${family}"]`],
  ];
  let value = "";
  for (const tier of tiers) {
    for (const rule of rules) {
      if (!rule.sels.some((s) => tier.includes(s))) continue;
      const hit = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(rule.body);
      if (hit) value = hit[1].trim();
    }
  }
  if (depth < 3) {
    const inner = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    if (inner) return tokenOf(rules, mode, family, inner[1], depth + 1);
  }
  return value;
}

function parse(hex: string): [number, number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  const full =
    h.length === 3 ? h.replace(/./g, (c) => c + c) + "ff" : h.length === 6 ? h + "ff" : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
    parseInt(full.slice(6, 8), 16) / 255,
  ];
}

/** 半透明的一档合成到不透明底色上（屏上真正进眼睛的那三色）。 */
function blend(hex: string, bg: RGB): RGB {
  const [r, g, b, a] = parse(hex);
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
}

function dist(a: RGB, b: RGB): number {
  return Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
}

const code = stripCssComments(readFileSync(CSS, "utf-8"));
const rules = topRules(code);
const at = (mode: Mode, family: Family, name: string) => tokenOf(rules, mode, family, name);
const bgOf = (mode: Mode, family: Family): RGB =>
  parse(at(mode, family, "--bg")).slice(0, 3) as RGB;

/** 该变体五档的合色；透明档给 null（HC 全靠描边，不参与距离判定）。 */
function ladder(mode: Mode, family: Family) {
  const bg = bgOf(mode, family);
  const value = (name: string) => {
    const raw = at(mode, family, name);
    return raw && raw !== "transparent" ? blend(raw, bg) : null;
  };
  return {
    bg,
    current: value("--find-match"),
    other: value("--find-match-other"),
    occurrence: value("--editor-selection-highlight"),
    selection: value("--editor-selection"),
    range: value("--find-range"),
    rangeBorder: at(mode, family, "--find-range-border"),
    currentBorder: at(mode, family, "--find-match-border"),
  };
}

describe("B425 · 高亮阶梯：合到底色上之后，各档必须分得开", () => {
  for (const mode of ["dark", "light"] as const) {
    for (const family of ["2026", "modern", "plus", "classic"] as const) {
      it(`${mode}/${family}：命中两档、自动出现、选区两两分得开`, () => {
        const l = ladder(mode, family);
        expect(
          l.current && l.other && l.occurrence && l.selection,
          `${mode}/${family} 该有四档底色`,
        ).toBeTruthy();
        // 病灶一（「选区外那一层淡蓝到底是命中还是自动高亮」）：其余命中 vs 自动出现
        expect(dist(l.other!, l.occurrence!), "其余命中 vs 自动出现").toBeGreaterThanOrEqual(40);
        // 病灶二：当前项 vs 其余命中
        expect(dist(l.current!, l.other!), "当前项 vs 其余命中").toBeGreaterThanOrEqual(40);
        // 已有的一档不许被调糊：选区 vs 自动出现
        expect(dist(l.selection!, l.occurrence!), "选区 vs 自动出现").toBeGreaterThanOrEqual(40);
      });

      it(`${mode}/${family}：范围带在底色上看得见（画不出来就等于没这一层）`, () => {
        const l = ladder(mode, family);
        expect(l.range, `${mode}/${family} 应有范围带底色`).toBeTruthy();
        expect(dist(l.range!, l.bg), "范围带 vs 底色").toBeGreaterThanOrEqual(20);
      });
    }

    it(`${mode}/hc：底色档全透明（VS Code 注册成 null），分档靠描边`, () => {
      const l = ladder(mode, "hc");
      expect(l.range, "HC 不画范围带底色").toBeNull();
      expect(l.rangeBorder, "HC 的范围带只有一圈边").not.toBe("transparent");
      expect(l.currentBorder, "HC 的当前项有描边").not.toBe("transparent");
    });
  }

  it("取值逐族照 VS Code 抄：2026 有显式值，其余族落注册默认", () => {
    expect(at("dark", "2026", "--find-range")).toBe("#ffffff13"); // 2026-dark.json
    expect(at("light", "2026", "--find-range")).toBe("#00000015"); // 2026-light.json
    expect(at("dark", "modern", "--find-range")).toBe("#3a3d4166"); // editorColors.ts 默认
    expect(at("dark", "plus", "--find-range")).toBe("#3a3d4166");
    expect(at("light", "classic", "--find-range")).toBe("#b4b4b44d");
    expect(at("dark", "hc", "--find-range-border")).toBe("#f3851866"); // transparent(橙, .4)
    expect(at("light", "hc", "--find-range-border")).toBe("#006bbd66");
  });

  it("2026 一族的「其余命中」跨到橙，当前项有一圈该族 focusBorder", () => {
    for (const mode of ["dark", "light"] as const) {
      // 换档的理由写在 global.css 的注释里：2026 原表两档与自动出现同色相，只差一档 alpha。
      expect(at(mode, "2026", "--find-match-other")).toBe("#ea5c0055");
      expect(
        at(mode, "2026", "--find-match-border"),
        "描边跟着该族 focusBorder，不是写死一颗",
      ).toBe(at(mode, "2026", "--accent"));
    }
  });

  it("范围带用 background-image 画，不许改成定位伪元素（那会盖到文字上面）", () => {
    const src = readFileSync(CSS, "utf-8");
    const rule = stripCssComments(
      src.slice(src.indexOf(".panel-host .cm-editor .cm-line.cm-find-range")).slice(0, 400),
    );
    expect(rule).toContain("background-image: linear-gradient(var(--find-range)");
    expect(rule, "同一元素的 background 只有一处生效：底色与带子要叠得起来").not.toMatch(
      /\bbackground:\s*var\(--find-range\)/,
    );
  });

  // ---- 判据鉴别力（--selftest 那一族做法）：把两档调回旧值，同一把尺必须塌 ----
  it("反向验证：旧那两档（同色相）喂同一把尺，判成「分不开」", () => {
    const bg = bgOf("light", "2026");
    const oldOther = blend("#0069cc1a", bg); // 2026-light 的原「其余命中」
    const auto = blend(at("light", "2026", "--editor-selection-highlight"), bg);
    expect(dist(oldOther, auto), "旧值只差一档 alpha —— 这就是用户报的那一坑").toBeLessThan(40);
    const nowOther = blend(at("light", "2026", "--find-match-other"), bg);
    expect(dist(nowOther, auto), "换档后同一把尺要能拉开").toBeGreaterThanOrEqual(40);
  });
});
