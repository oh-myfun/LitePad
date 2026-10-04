// @vitest-environment jsdom
// B236 行为侧：真把弹窗挂到 DOM 上，点按钮 / 按 Esc，看它 resolve 出什么。
//
// 与 `tests/save-confirm.test.ts`（静态契约）分工：那边钉「源码写了什么」，
// 这边钉「挂出来之后真的能点、点出来的值对」。
// ⚠️ 这个模块**自己建 DOM、自己挂监听**，不需要 bootstrap `main.ts`，
//    所以不像 `statusbar-lang-behavior.test.ts` 那样受「bindEvents() 没被调」的限制
//    —— 行为侧这里是有鉴别力的。

import { beforeEach, describe, expect, it } from "vitest";
import { showSaveConfirmDialog } from "../src/shell/saveconfirm";

/** 弹窗里的三颗按钮，按 DOM 顺序返回。 */
function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".save-confirm-btn")];
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("B236 未保存确认框 · 行为", () => {
  it("三颗按钮按「保存 / 不保存 / 取消」排，且只有保存是主按钮", async () => {
    const p = showSaveConfirmDialog({ title: "关闭标签", names: ["a.md"] });
    const [save, discard, cancel] = buttons();
    expect(save.textContent).toBe("保存");
    expect(discard.textContent).toBe("不保存");
    expect(cancel.textContent).toBe("取消");
    expect(save.classList.contains("save-confirm-primary")).toBe(true);
    // 破坏性那一档（不保存）绝不能长得跟主按钮一样
    expect(discard.classList.contains("save-confirm-primary")).toBe(false);
    cancel.click();
    await p;
  });

  it("点每一颗都 resolve 出对应的三态", async () => {
    for (const [idx, want] of [
      [0, "save"],
      [1, "discard"],
      [2, "cancel"],
    ] as const) {
      document.body.innerHTML = "";
      const p = showSaveConfirmDialog({ title: "关闭标签", names: ["a.md"] });
      buttons()[idx].click();
      expect(await p).toBe(want);
      // 关掉之后 DOM 必须清干净，否则连关几次标签会堆好几层遮罩
      expect(document.querySelectorAll(".save-confirm-btn")).toHaveLength(0);
    }
  });

  it("Esc 是取消，不是不保存（也不能什么都不做）", async () => {
    const p = showSaveConfirmDialog({ title: "关闭标签", names: ["a.md"] });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBe("cancel");
  });

  it("多个文件时按钮变「全部保存」，且文件名逐个列在 detail 里", async () => {
    const p = showSaveConfirmDialog({ title: "退出 LitePad", names: ["a.md", "b.md", "c.md"] });
    expect(buttons()[0].textContent).toBe("全部保存");
    const detail = document.querySelector(".save-confirm-detail")?.textContent ?? "";
    expect(detail).toContain("a.md、b.md、c.md");
    expect(detail).toContain("如果不保存，您的更改将会丢失。");
    expect(document.querySelector(".save-confirm-text")?.textContent).toBe(
      "是否要保存对以下 3 个文件所做的更改？",
    );
    buttons()[2].click();
    await p;
  });

  it("单文件走单文件那句文案", async () => {
    const p = showSaveConfirmDialog({ title: "关闭标签", names: ["笔记.md"] });
    expect(document.querySelector(".save-confirm-text")?.textContent).toBe(
      "是否要保存对 笔记.md 所做的更改？",
    );
    buttons()[2].click();
    await p;
  });

  it("标题行在，且是调用方传进来的那句", async () => {
    const p = showSaveConfirmDialog({ title: "退出 LitePad", names: ["a.md"] });
    expect(document.querySelector(".save-confirm-title")?.textContent).toBe("退出 LitePad");
    buttons()[2].click();
    await p;
  });
});
