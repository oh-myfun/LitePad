// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cssDecls, ruleBlock, tabsAll, themeBlock } from "./static";

const TONES = ["blue", "yellow", "gray", "red", "orange", "green", "pink", "purple", "default"];

describe("标签前置文件类型图标（B57 → B367 Seti）", () => {
  it("标签 16px 槽位 + 共用 .seti-icon；深浅主题九档色齐全，字体与许可随包", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const icon = cssDecls(ruleBlock(css, ".tab-icon", undefined, true));
    expect(icon, "应有 .tab-icon 规则").toBeTruthy();
    expect(icon, "图标不得收缩（文件名变长不能把图标挤扁）").toMatch(/flex:\s*0 0 auto/);
    expect(icon, "图标固定 16px").toMatch(/width:\s*16px/);
    expect(icon, "非活动图标要跟着文字一起降透明度").toMatch(/opacity:\s*0\.75/);
    expect(css, "悬停/活动图标回到全不透明").toMatch(
      /\.tab-active\s+\.tab-icon\s*\{[^}]*opacity:\s*1/,
    );

    // 字形组件：Seti 字体、150%（VS Code 图标主题的既定口径，12px 下约 18px）。
    const seti = cssDecls(ruleBlock(css, ".seti-icon", undefined, true));
    expect(seti, "应有 .seti-icon 规则").toBeTruthy();
    expect(seti).toMatch(/font-family:\s*"seti"/);
    expect(seti).toMatch(/font-size:\s*150%/);

    // 九档色调 = 一条 data-tone 取色 + 浅深两套 --seti-* 变量。缺一处 = 某主题下某个色掉字色。
    for (const tone of TONES) {
      expect(css, `缺 .seti-icon[data-tone="${tone}"] 取色`).toContain(
        `.seti-icon[data-tone="${tone}"]`,
      );
    }
    for (const [name, block] of [
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
    ] as const) {
      for (const tone of TONES) {
        expect(block, `${name}主题缺 --seti-${tone}`).toContain(`--seti-${tone}:`);
      }
    }

    // 字体桥接 + 许可：字体文件必须真的在仓库里，MIT 许可不能只写在注释里。
    const fonts = readFileSync("src/styles/fonts.css", "utf-8");
    expect(fonts, "要有 seti 家族声明").toContain('font-family: "seti"');
    expect(fonts, "要指向随包字体").toContain('url("../assets/fonts/seti.woff")');
    expect(existsSync("src/assets/fonts/seti.woff"), "seti.woff 必须随包").toBe(true);
    const license = readFileSync("src/assets/fonts/seti-ui-LICENSE.txt", "utf-8");
    expect(license, "许可见证 Seti UI").toContain("Seti UI");
    expect(license, "许可见证 MIT 授权文本").toContain("Permission is hereby granted");

    // 接线：tabstrip 建图标节点，语言标签传下去。
    // 漏掉 lang 的话所有标签都会退化成缺省文件图标，是最容易静默发生的回归。
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "标签必须建 .tab-icon 节点").toContain('"tab-icon"');
    expect(ts, "图标必须来自 fileIconHtml 且按语言取").toContain("fileIconHtml(t.lang)");
    const main = readFileSync("src/main.ts", "utf-8") + "\n" + tabsAll();
    expect(main, "main 必须把语言标签喂给标签视图数据").toMatch(/lang:\s*doc\?\.langLabel/);
  });

  it("B367 映射：覆盖注册表全部 label，抽样与 VS Code Seti 一致，未知回落缺省", async () => {
    const { iconOf, knownLabels, fileIconHtml } = await import("../src/shell/fileicons");
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
    expect(uncovered, `这些语言没有图标条目：${uncovered.join(", ")}`).toEqual([]);

    // 抽样核对的是 VS Code Seti 的**码位 + 色调**（覆盖度对不代表映射对）。
    expect(iconOf("Markdown")).toEqual({ ch: "E060", tone: "blue" });
    expect(iconOf("JSON")).toEqual({ ch: "E055", tone: "yellow" });
    expect(iconOf("Python")).toEqual({ ch: "E07B", tone: "blue" });
    expect(iconOf("Rust")).toEqual({ ch: "E082", tone: "gray" });
    expect(iconOf("Java")).toEqual({ ch: "E050", tone: "red" });
    expect(iconOf("Kotlin")).toEqual({ ch: "E058", tone: "orange" });
    expect(iconOf("Shell")).toEqual({ ch: "E089", tone: "green" });
    expect(iconOf("SQL")).toEqual({ ch: "E022", tone: "pink" });
    expect(iconOf("YAML")).toEqual({ ch: "E0A7", tone: "purple" });
    expect(iconOf("CMake")).toEqual({ ch: "E05F", tone: "blue" });
    expect(iconOf("Makefile"), "同名字形、不同色，与 Seti 一致").toEqual({
      ch: "E05F",
      tone: "orange",
    });
    expect(iconOf("Scala")).toEqual({ ch: "E086", tone: "red" });
    expect(iconOf("TOML")).toEqual({ ch: "E019", tone: "gray" });
    expect(iconOf("Plain Text"), "Seti 没有纯文本字形，用其缺省文件").toEqual({
      ch: "E023",
      tone: "default",
    });
    // 未知 / 空值必须落到缺省文件图标（新建未命名缓冲区的 langLabel 可能是 null）
    expect(iconOf(null)).toEqual({ ch: "E023", tone: "default" });
    expect(iconOf("Klingon")).toEqual({ ch: "E023", tone: "default" });

    // 字形必须是带色调的 Seti 字体元素（不是空串 / 手绘 SVG）。
    expect(fileIconHtml("Markdown")).toBe(
      '<i class="seti-icon" data-tone="blue" aria-hidden="true">&#xE060;</i>',
    );
    const glyphs = labels.map((label) => iconOf(label).ch);
    expect(new Set(glyphs).size, "不能退化成同一颗缺省图标").toBeGreaterThanOrEqual(35);
    expect(glyphs.filter((ch) => ch === "E023").length, "缺省图标只覆盖少数语言").toBeLessThan(20);
  });
});
