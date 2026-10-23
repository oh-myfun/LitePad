// @vitest-environment jsdom
// B236：大纲条目的提示框改成与标签**同档**。
//
// 两套本来就是同一个出口，差别只在选项：
//   · 标签 `.tab`（tabstrip.ts）→ 跟鼠标、不画小箭头、`data-pointer="false"`（圆角 5px）、紧凑字号
//   · 大纲 `.toc-item`（toc.ts）→ 原来只有 `{group:"toc"}`
//     ⇒ 按元素定位、带小箭头、`data-pointer="true"`（圆角 3px）、13px 基础档
// 用户裁决：**连定位方式一起统一**（跟鼠标、不画箭头），**只改大纲条目**，
// 顶部那颗「全部折叠/展开」键保持原样（它走 `setAttribute("data-tip", …)` 裸属性 = 按钮档）。
//
// B350 之后那一档的开关（`follow` / `compact`）不再由站点手抄，收进了 `setTextTip()` 一处。
// 所以这一族的判据从「选项里有没有这两颗」改成「**用没用同一个出口**」，
// 开关本身对不对由 tests/tooltip-classes.test.ts 钉（那里有真 DOM 断言 + 退化替身）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fnBody, stripLineComments } from "./static";
import { createTocList } from "../src/markdown/toc";
import type { TocEntry } from "../src/markdown/pipeline";

const TOC = stripLineComments(readFileSync("src/markdown/toc.ts", "utf-8"));
const TABSTRIP = stripLineComments(readFileSync("src/shell/tabstrip.ts", "utf-8"));
const MAIN = stripLineComments(
  readFileSync("src/main.ts", "utf-8") + "\n" + readFileSync("src/toc.ts", "utf-8"),
);

/** 抠出某次 `setTextTip(<firstArg>, …)` 的完整调用（容 prettier 折行）。 */
function call(file: string, firstArg: string): string {
  const re = new RegExp(`setTextTip\\(${firstArg},[\\s\\S]{0,240}?\\);`);
  return re.exec(file)?.[0] ?? "";
}

describe("B236 大纲提示 · 与标签同档", () => {
  it("大纲条目走文本档出口（退回 setTip 就是带箭头的按钮档）", () => {
    expect(call(TOC, "item"), "toc.ts 里要能抠到 setTextTip(item, …)").not.toBe("");
  });

  it("跟着标签走：两处用同一个出口，且都不再手抄开关", () => {
    const tocCall = call(TOC, "item");
    const tabCall = call(TABSTRIP, "el");
    expect(tocCall, "大纲没走文本档").not.toBe("");
    expect(tabCall, "标签没走文本档").not.toBe("");
    // 手抄的开关会让「改一档」变成「扫全仓」—— B350 正是为这件事把取值收进 helper。
    // ⚠️ 只比抠出来的这一段：标签文件里那颗关闭 × 是**按钮**，它合法地自带 compact。
    expect(tocCall, "大纲又把手抄的开关写回站点上了").not.toMatch(/follow:|compact:/);
    expect(tabCall, "标签又把手抄的开关写回站点上了").not.toMatch(/follow:|compact:/);
  });

  it("提示文案仍是行号（标题文本就在眼前，重复没意义）", () => {
    expect(call(TOC, "item")).toContain("第 ${node.entry.line} 行");
  });

  it("反向：顶部「全部折叠」键不许跟着改（用户明确只改条目）", () => {
    // 它走裸属性，既没 follow 也没 compact ⇒ 按元素定位、带小尖尖 = 按钮档。
    // 同一块面板里两档并存是**有意为之**（用户拍的是「只改大纲条目」），
    // 把它搬进 setTextTip 会被这条拦下。
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
      expect(it.dataset.tipFollow, "follow 标记（由 setTextTip 一处给）").toBe("1");
      expect(it.dataset.tipCompact, "compact 标记（由 setTextTip 一处给）").toBe("1");
      expect(it.dataset.tipGroup).toBe("toc");
    }
    list.remove();
  });
});
