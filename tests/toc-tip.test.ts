// @vitest-environment jsdom
// B236：大纲条目的提示框改成与标签**同档**。
//
// 两套本来就是同一个 `setTip()`，差别只在选项：
//   · 标签 `.tab`（tabstrip.ts）→ `{group:"tabstrip", follow:true, compact:true}`
//     ⇒ 跟鼠标、不画小箭头、提示层 `data-pointer="false"`（圆角 5px）、12px 紧凑档
//   · 大纲 `.toc-item`（toc.ts）→ 原来只有 `{group:"toc"}`
//     ⇒ 按元素定位、带小箭头、`data-pointer="true"`（圆角 3px）、13px 基础档
// 用户裁决：**连定位方式一起统一**（跟鼠标、不画箭头），**只改大纲条目**，
// 顶部那颗「全部折叠/展开」键保持原样（它走 `setAttribute("data-tip", …)` 裸属性）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fnBody, stripLineComments } from "./static";
import { createTocList } from "../src/markdown/toc";
import type { TocEntry } from "../src/markdown/pipeline";

const TOC = stripLineComments(readFileSync("src/markdown/toc.ts", "utf-8"));
const TABSTRIP = stripLineComments(readFileSync("src/shell/tabstrip.ts", "utf-8"));
const MAIN = stripLineComments(readFileSync("src/main.ts", "utf-8"));

/** 抠出某次 `setTip(<firstArg>, …)` 的完整调用（容 prettier 折行）。 */
function call(file: string, firstArg: string): string {
  const re = new RegExp(`setTip\\(${firstArg},[\\s\\S]{0,240}?\\}\\);`);
  return re.exec(file)?.[0] ?? "";
}

/** 调用里出现的开关名（follow / compact / key / detail / placement / group）。 */
function switches(c: string): string[] {
  return ["follow", "compact", "key", "detail", "placement", "group"].filter((k) =>
    new RegExp(`\\b${k}\\b`).test(c),
  );
}

describe("B236 大纲提示 · 与标签同档", () => {
  it("大纲条目必须同时开 follow 与 compact（缺一个就退回带箭头的 13px 那档）", () => {
    const c = call(TOC, "item");
    expect(c, "toc.ts 里要能抠到 setTip(item, …)").not.toBe("");
    expect(c).toContain("follow: true");
    expect(c).toContain("compact: true");
  });

  it("跟着标签走：两个开关与标签那颗完全一致", () => {
    const tocSw = switches(call(TOC, "item"));
    const tabSw = switches(call(TABSTRIP, "el"));
    expect(tabSw, "标签那颗的开关要能抠到").not.toHaveLength(0);
    // 观感相关的两个开关必须都在；group 只是结构性标记，两边不同名没关系
    for (const k of ["follow", "compact"]) {
      expect(tocSw, `大纲缺 ${k}`).toContain(k);
      expect(tabSw, `标签缺 ${k}`).toContain(k);
    }
  });

  it("提示文案仍是行号（标题文本就在眼前，重复没意义）", () => {
    expect(call(TOC, "item")).toContain("第 ${node.entry.line} 行");
  });

  it("反向：顶部「全部折叠」键不许跟着改（用户明确只改条目）", () => {
    // 它走裸属性，既没 follow 也没 compact —— 同一块面板里两种提示并存是**有意为之**，
    // 用户拍的是「只改大纲条目」。改成 setTip 会被这条拦下。
    const b = fnBody(MAIN, "refreshTocToggleAll");
    expect(b).toContain('setAttribute("data-tip", label)');
    expect(b).not.toContain("setTip(");
  });
});

describe("B236 大纲提示 · 真挂出来的 DOM", () => {
  const e = (level: number, line: number, text: string): TocEntry => ({
    level,
    line,
    text,
    id: `h${level}-${line}`,
  });

  it("每个条目都带上 follow / compact 两个标记，且文案是行号", () => {
    const list = document.createElement("div");
    list.className = "toc-list";
    document.body.appendChild(list);
    // ⚠️ 签名是 `createTocList(list, onFoldChange?)` → `handle.render(entries, activeLine, {onJump})`
    //    （不是「一次性把条目塞进构造参数」），照抄 tests/toc-tree.test.ts 的写法。
    const h = createTocList(list);
    h.render([e(1, 3, "一"), e(2, 12, "二")], -1, { onJump: () => {} });

    const items = Array.from(list.querySelectorAll<HTMLElement>(".toc-item"));
    expect(items).toHaveLength(2);
    expect(items[0].dataset.tip).toBe("第 3 行");
    expect(items[1].dataset.tip).toBe("第 12 行");
    for (const it of items) {
      expect(it.dataset.tipFollow, "follow 标记").toBe("1");
      expect(it.dataset.tipCompact, "compact 标记").toBe("1");
      expect(it.dataset.tipGroup).toBe("toc");
    }
    list.remove();
  });
});
