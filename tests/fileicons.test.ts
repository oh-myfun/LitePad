// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { themeBlock, cssDecls, FILE_FAMILIES } from "./static";

describe("标签前置文件类型图标（B57）", () => {
  it("B57 标签前置文件类型图标：家族字形 + 家族配色，且家族覆盖注册表全部语言", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const icon = cssDecls(css.match(/\n\.tab-icon\s*\{[^}]*\}/)?.[0] ?? "");
    expect(icon, "应有 .tab-icon 规则").toBeTruthy();
    expect(icon, "图标不得收缩（文件名变长不能把图标挤扁）").toMatch(/flex:\s*0 0 auto/);
    expect(icon, "图标固定 16px").toMatch(/width:\s*16px/);
    expect(icon, "非活动图标要跟着文字一起降透明度").toMatch(/opacity:\s*0\.75/);
    expect(css, "悬停/活动图标回到全不透明").toMatch(
      /\.tab-active\s+\.tab-icon\s*\{[^}]*opacity:\s*1/,
    );

    // 家族配色 = 10 个 data-fam 选择器 + 浅深两套 --ficon-* 变量。
    // 缺任意一处 → 某主题下该家族图标没有颜色（继承文字色，等于「图标丢了」）。
    const FAMILIES = FILE_FAMILIES;
    for (const fam of FAMILIES) {
      expect(css, `缺 .tab-icon[data-fam="${fam}"] 配色`).toContain(`.tab-icon[data-fam="${fam}"]`);
    }
    for (const [name, block] of [
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
    ] as const) {
      for (const fam of FAMILIES) {
        expect(block, `${name}主题缺 --ficon-${fam}`).toContain(`--ficon-${fam}:`);
      }
    }

    // 接线：tabstrip 建图标节点并带上 data-fam；main 把检测到的语言传下去。
    // 漏掉 lang 的话所有标签都会退化成 txt 图标（灰三条横线），是最容易静默发生的回归。
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "标签必须建 .tab-icon 节点").toContain('"tab-icon"');
    expect(ts, "图标必须带 data-fam（CSS 靠它取色）").toContain("data-fam");
    expect(ts, "图标必须来自 fileIconHtml").toContain("fileIconHtml(");
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "main 必须把语言标签喂给标签视图数据").toMatch(/lang:\s*doc\?\.langLabel/);
  });
  it("B57 图标家族：覆盖语言注册表全部 label，未知语言回落 txt", async () => {
    const { familyOf, knownLabels, fileIconHtml } = await import("../src/shell/fileicons");
    const known = new Set(knownLabels());

    // 从 language.ts 抽出 REGISTRY 里的全部 label（未导出，只能静态抽）。
    const src = readFileSync("src/editor/language.ts", "utf-8");
    const reg = src.slice(
      src.indexOf("const REGISTRY"),
      src.indexOf("export interface LanguageInfo"),
    );
    const labels = [...reg.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length, "应当抽到语言注册表（数量级在 50+）").toBeGreaterThanOrEqual(50);
    const uncovered = labels.filter((l) => !known.has(l));
    expect(uncovered, `这些语言没有归属家族（会退化成 txt 图标）：${uncovered.join(", ")}`).toEqual(
      [],
    );

    // 抽样确认映射方向正确（覆盖度对不代表映射对）。
    expect(familyOf("Markdown")).toBe("md");
    expect(familyOf("TypeScript")).toBe("code");
    expect(familyOf("JSON")).toBe("brace");
    expect(familyOf("Python")).toBe("hash");
    expect(familyOf("HTML")).toBe("tag");
    expect(familyOf("Rust")).toBe("brk");
    expect(familyOf("SQL")).toBe("db");
    expect(familyOf("Diff")).toBe("diff");
    expect(familyOf("Dockerfile")).toBe("build");
    expect(familyOf("Plain Text")).toBe("txt");
    // 未知 / 空值必须落到 txt（新建未命名缓冲区的 langLabel 可能是 null）
    expect(familyOf(null)).toBe("txt");
    expect(familyOf("Klingon")).toBe("txt");

    // 字形必须真的是 codicon 字形元素（不是空串 / 占位文本），且每个家族各不相同。
    const htmls = FILE_FAMILIES.map((f) => fileIconHtml(f));
    for (let i = 0; i < htmls.length; i++) {
      expect(htmls[i], `家族 ${FILE_FAMILIES[i]} 的字形不能为空`).toMatch(
        /^<i class="codicon codicon-[a-z0-9-]+"/,
      );
    }
    expect(new Set(htmls).size, "十个家族应有十个不同字形").toBe(FILE_FAMILIES.length);
  });
});
