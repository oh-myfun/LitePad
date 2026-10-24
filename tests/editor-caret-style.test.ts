// B362 编辑器光标竖线粗细：CM6 默认的 `.cm-cursor` 是 `border-left: 1.2px`，
// 在 125% 缩放下落在 1.5 设备像素上，等于一条半透明的灰线（用户：「光标竖线太细，加粗点」）。
// 这里只加宽，不改颜色 —— 颜色仍由主题（B376 起是 VS Code 的 editorCursor.foreground，走 --editor-cursor）决定。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cssDecls, ruleBlock, stripCssComments } from "./static";

const CSS = "src/styles/global.css";

describe("B362 光标竖线加粗", () => {
  const css = () => stripCssComments(readFileSync(CSS, "utf-8"));

  it("`.cm-cursor` 的左边框至少 2px（默认 1.2px 太细）", () => {
    const s = css();
    const rule = ruleBlock(s, ".panel-host .cm-editor .cm-cursor");
    expect(rule, "要有编辑器光标规则").toBeTruthy();
    const width = cssDecls(rule).match(/border-left-width:\s*([\d.]+)px/)?.[1];
    expect(width, "用 border-left-width 只加宽、不重写整条边框").toBeTruthy();
    expect(Number(width), "至少 2px 才看得出是一根线").toBeGreaterThanOrEqual(2);
    // 反向对照：退回 1.2px 的替身必须被同一条判据拒掉
    const thin = s.replace(
      /(\.panel-host \.cm-editor \.cm-cursor\s*\{[^}]*?border-left-width:\s*)[\d.]+px/,
      "$11.2px",
    );
    expect(thin, "替身必须真的改细过").not.toBe(s);
    const thinWidth = cssDecls(ruleBlock(thin, ".panel-host .cm-editor .cm-cursor")).match(
      /border-left-width:\s*([\d.]+)px/,
    )?.[1];
    expect(Number(thinWidth), "1.2px 的替身必须落空").toBeLessThan(2);
  });
});
