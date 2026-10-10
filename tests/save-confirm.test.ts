/**
 * B236 未保存修改确认框：静态契约。
 *
 * 守护三件事：
 * 1. 文案与按钮**逐字**对 VS Code 的 `confirmBeforeClose`（`abstractFileDialogService.ts`
 *    的 `doShowSaveConfirm`），别被后来人"润色"成别的说法。
 * 2. 两条关闭路径（关标签 / 退出）都走这个框，**都不许再用原生 `ask()`**。
 * 3. 弹窗的安全属性：Esc / 点遮罩 = 取消（不是不保存）、settled 幂等、焦点给保存。
 *
 * ⚠️ 源码断言全部落在**剥掉整行注释**的文本上（`stripLineComments`）：本文件自己在
 * 源码注释里复述了「如果不保存，您的更改将会丢失」等被扫的字面量，不剥会假绿。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fnBody, stripCssComments, stripLineComments } from "./static";

const CONFIRM = stripLineComments(readFileSync("src/shell/saveconfirm.ts", "utf-8"));
const MAIN = stripLineComments(
  readFileSync("src/main.ts", "utf-8") + "\n" + readFileSync("src/tabs.ts", "utf-8"),
);
const CSS = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));

/** 从 main.ts 截函数体；截不到直接空串，让断言给出「找不到」而不是误判通过。 */
const body = (name: string): string => fnBody(MAIN, name);

describe("B236 未保存确认框 · 文案抄 VS Code", () => {
  it("正文与 detail 逐字对 VS Code 的 confirmBeforeClose", () => {
    // VS Code 原文（en）：
    //   "Do you want to save the changes you made to {0}?"
    //   "Do you want to save the changes to the following {0} files?"
    //   "Your changes will be lost if you don't save them."
    expect(CONFIRM).toContain("是否要保存对 ${names[0]} 所做的更改？");
    expect(CONFIRM).toContain("是否要保存对以下 ${names.length} 个文件所做的更改？");
    // ⚠️ 这句「会丢失」是「不保存」那一档唯一的后果告知，删了用户就会随手点错。
    expect(CONFIRM).toContain("如果不保存，您的更改将会丢失。");
  });

  it("三个按钮：保存 | 不保存 | 取消，且顺序固定", () => {
    const save = CONFIRM.indexOf('save.textContent = opts.names.length > 1 ? "全部保存" : "保存"');
    const discard = CONFIRM.indexOf('discard.textContent = "不保存"');
    const cancel = CONFIRM.indexOf('cancel.textContent = "取消"');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeGreaterThanOrEqual(0);

    // ⚠️ **真正决定顺序的是 append 的实参次序，不是 textContent 赋值的源码位置**。
    // 第一版只量了后者，把 `actions.append(cancel, discard, save)` 换上去照样全绿
    // （B236 真退化实测）—— 排版一行就变，断言却量的是另一处 ⇒ 必须盯 append 本身。
    const appends = CONFIRM.match(/actions\.append\([^)]*\)/g) ?? [];
    expect(appends).toHaveLength(1);
    expect(appends[0]).toBe("actions.append(save, discard, cancel)");
  });

  it("「保存」按钮文案按数量变（VS Code 同款：单文件 Save / 多文件 Save All）", () => {
    expect(CONFIRM).toContain('opts.names.length > 1 ? "全部保存" : "保存"');
  });

  it("只有「保存」是主按钮，另两颗都是 secondary", () => {
    expect(CONFIRM).toContain('save.className = "save-confirm-btn save-confirm-primary"');
    expect(CONFIRM).toContain('discard.className = "save-confirm-btn save-confirm-secondary"');
    expect(CONFIRM).toContain('cancel.className = "save-confirm-btn save-confirm-secondary"');
    // 别让「不保存」也染上主色 —— 它是破坏性那一档，视觉上必须与保存区分开。
    expect(CONFIRM).not.toMatch(/discard\.className = "[^"]*primary/);
  });
});

describe("B236 未保存确认框 · 安全属性", () => {
  it("Esc 与点遮罩都落在 cancel（不是 discard）", () => {
    const onKeyDown = CONFIRM.slice(
      CONFIRM.indexOf("const onKeyDown"),
      CONFIRM.indexOf("save.addEventListener"),
    );
    expect(onKeyDown).toContain('e.key === "Escape"');
    expect(onKeyDown).toContain('close("cancel")');
    expect(CONFIRM).toContain('if (e.target === overlay) close("cancel")');
    expect(CONFIRM).toContain('save.addEventListener("click", () => close("save"))');
    expect(CONFIRM).toContain('discard.addEventListener("click", () => close("discard"))');
    expect(CONFIRM).toContain('cancel.addEventListener("click", () => close("cancel"))');
  });

  it("settled 幂等锁 + 移除监听，避免重复 resolve", () => {
    expect(CONFIRM).toContain("let settled = false");
    expect(CONFIRM).toContain("if (settled) return;");
    expect(CONFIRM).toContain('document.removeEventListener("keydown", onKeyDown, true)');
    expect(CONFIRM).toContain("overlay.remove()");
    expect(CONFIRM).toContain('document.addEventListener("keydown", onKeyDown, true)');
  });

  it("焦点给「保存」——与按钮顺序一致（最左、回车即它）", () => {
    expect(CONFIRM).toContain("save.focus()");
  });
});

describe("B236 未保存确认框 · 两条关闭路径都接上了", () => {
  it("关标签：改走三按钮框，三分支各有处置", () => {
    const b = body("closeTabById");
    expect(b).toContain("showSaveConfirmDialog");
    expect(b).toContain("names: [doc.name]");
    expect(b).toContain('choice === "cancel"');
    expect(b).toContain('choice === "save"');
    // saveDocCore 必须在 save 分支之后（不能顺手让 discard 也去写盘）
    const saveIdx = b.indexOf('choice === "save"');
    const coreIdx = b.indexOf("saveDocCore");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThan(saveIdx);
    // ⚠️ 反向闸：原生 ask() 必须从这个函数里消失（它表达不了「不保存」）。
    // 必须排在上面所有正向断言之后，否则被抢先报错。
    expect(b).not.toContain("await ask(");
  });

  it("退出：改走同一个框，保存失败必须整体中止", () => {
    const b = body("finishAndDestroy");
    expect(b).toContain("showSaveConfirmDialog");
    expect(b).toContain('title: "退出 LitePad"');
    expect(b).toContain("names: dirty.map((d) => d.name)");
    expect(b).toContain('choice === "cancel"');
    expect(b).toContain('choice === "save"');
    // 取消/失败都要把备份排程还回去（内容还是脏的）：至少 3 处
    const scheduleCount = b.split("scheduleBackup();").length - 1;
    expect(scheduleCount).toBeGreaterThanOrEqual(3);
    expect(b).not.toContain("await ask(");
  });

  it("导出的是三态而不是布尔", () => {
    expect(CONFIRM).toContain('export type SaveConfirmChoice = "save" | "discard" | "cancel"');
    expect(CONFIRM).toContain("Promise<SaveConfirmChoice>");
  });

  it("关窗回调仍不许 await —— 自绘弹窗是 DOM 但 finishAndDestroy 仍是没人 await 的链", () => {
    const b = body("registerWindowClose");
    expect(b).toContain("event.preventDefault()");
    expect(b).toContain("void finishAndDestroy(dirty)");
    // ⚠️ 反向闸：任何直接 await 都会踩 B135 死锁（60s 窗口纹丝不动）。
    expect(b).not.toMatch(/await finishAndDestroy/);
  });
});

describe("B236 样式", () => {
  it("框体与三个按钮的类都有定义（400px，对齐 InkNote 的 modal-sm 观感）", () => {
    for (const cls of [
      ".save-confirm-dialog",
      ".save-confirm-title",
      ".save-confirm-text",
      ".save-confirm-detail",
      ".save-confirm-actions",
      ".save-confirm-btn",
      ".save-confirm-primary",
      ".save-confirm-secondary",
    ]) {
      expect(CSS).toContain(cls);
    }
  });

  it("主按钮铺 accent，普通按钮铺普通底", () => {
    const primary = CSS.slice(CSS.indexOf(".save-confirm-primary"));
    expect(primary).toContain("background: var(--accent)");
    const btn = CSS.slice(CSS.indexOf(".save-confirm-btn {"));
    expect(btn).toContain("background: var(--bg)");
  });

  it("退出的 detail 是文件名清单 —— 必须允许折行，否则长路径撑破框", () => {
    const detail = CSS.slice(CSS.indexOf(".save-confirm-detail"));
    expect(detail).toContain("white-space: pre-line");
    expect(detail).toContain("overflow-wrap: anywhere");
  });
});
