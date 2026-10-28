// @vitest-environment jsdom
// B406 · 图片编辑弹窗（照 InkNote ImageInsertDialog 的两栏表单）。
//
// 判据只认**行为**：预填、确定/取消/Esc/回车、浏览回填。原生文件对话框不在这里跑
// （`browse` 由测试注入），Tauri 的真实选择器留到真机台。

import { afterEach, describe, expect, it } from "vitest";
import { showImageDialog, type ImageDialogResult } from "../src/shell/imagedialog";

function dialogEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".image-dialog");
  expect(el, "弹窗没挂到 body 上").toBeTruthy();
  return el!;
}

function field<T extends HTMLElement>(selector: string): T {
  const el = dialogEl().querySelector<T>(selector);
  expect(el, `弹窗里没有 ${selector}`).toBeTruthy();
  return el!;
}

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("B406 图片编辑弹窗", () => {
  it("预填 alt / path；确定返回去空格后的值", async () => {
    const pending = showImageDialog({ alt: "示例图", path: "pic.png" });
    const alt = field<HTMLInputElement>("#image-dialog-alt");
    const path = field<HTMLInputElement>("#image-dialog-path");
    expect(alt.value).toBe("示例图");
    expect(path.value).toBe("pic.png");

    type(alt, "  新图  ");
    type(path, "  pics/a.png  ");
    field<HTMLButtonElement>(".image-dialog-confirm").click();
    await expect(pending).resolves.toEqual({ alt: "新图", path: "pics/a.png" });
    expect(document.querySelector(".image-dialog")).toBeFalsy();
  });

  it("路径为空：确定键禁用，输入后解禁", () => {
    void showImageDialog({ alt: "", path: "" });
    const path = field<HTMLInputElement>("#image-dialog-path");
    const confirm = field<HTMLButtonElement>(".image-dialog-confirm");
    expect(confirm.disabled).toBe(true);
    type(path, "pic.png");
    expect(confirm.disabled).toBe(false);
    type(path, "   ");
    expect(confirm.disabled).toBe(true);
  });

  it("浏览键把选中路径填进输入框", async () => {
    void showImageDialog({
      alt: "",
      path: "",
      browse: async () => "C:\\pics\\a.png",
    });
    field<HTMLButtonElement>(".image-dialog-browse").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(field<HTMLInputElement>("#image-dialog-path").value).toBe("C:\\pics\\a.png");
    expect(field<HTMLButtonElement>(".image-dialog-confirm").disabled).toBe(false);
  });

  it("Esc / 取消键都返回 null", async () => {
    const byEsc = showImageDialog({ alt: "", path: "pic.png" });
    press(field<HTMLInputElement>("#image-dialog-path"), "Escape");
    await expect(byEsc).resolves.toBeNull();
    expect(document.querySelector(".image-dialog")).toBeFalsy();

    const byCancel = showImageDialog({ alt: "", path: "pic.png" });
    field<HTMLButtonElement>(".image-dialog-cancel").click();
    await expect(byCancel).resolves.toBeNull();
  });

  it("路径框里回车 = 确定", async () => {
    const pending = showImageDialog({ alt: "图", path: "pic.png" });
    press(field<HTMLInputElement>("#image-dialog-path"), "Enter");
    const result: ImageDialogResult | null = await pending;
    expect(result).toEqual({ alt: "图", path: "pic.png" });
  });

  it("点遮罩空白处取消", async () => {
    const pending = showImageDialog({ alt: "", path: "pic.png" });
    const overlay = document.querySelector<HTMLElement>(".settings-overlay")!;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(pending).resolves.toBeNull();
  });
});
