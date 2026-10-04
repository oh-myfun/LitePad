/**
 * 未保存修改确认框（VS Code `confirmBeforeClose` 的落地形式）。
 *
 * 触发点是**用户想关掉一个脏文档**的时候 —— 关标签、关窗口、走退出，两条路共用这一个框。
 * 三选一：
 *
 * - `save`    保存后关闭：走 `saveDocCore`，写盘失败 / 用户在保存冲突框里取消 ⇒ 整体中止。
 * - `discard` 不保存直接关：编辑器里那份内容就此丢弃。
 * - `cancel`  取消：什么都不做。
 *
 * ## 文案抄的是 VS Code 原文
 *
 * 参照 `vs/workbench/services/dialogs/browser/abstractFileDialogService.ts`
 * 的 `doShowSaveConfirm`：
 *
 * - message 单文件 `Do you want to save the changes you made to {0}?`
 *          多文件 `Do you want to save the changes to the following {0} files?`
 * - detail `Your changes will be lost if you don't save them.`（多文件时前面再拼文件名清单）
 *
 * ⚠️ **detail 那句「会丢失」不能省**：它是「不保存」这一档唯一的后果告知，
 * 删了之后三个按钮看起来只是三个平级选项，用户会随手点错。
 *
 * ⚠️ 按钮文案按数量变（VS Code 同款）：单文件「保存」，多文件「全部保存」。
 */

/** 三选一的结果。`cancel` 是唯一既没写盘、也没丢改动的那一支。 */
export type SaveConfirmChoice = "save" | "discard" | "cancel";

export interface SaveConfirmOptions {
  /** 标题行文案（VS Code 这个框没有标题，这里保留一行以便区分关标签 / 退出） */
  title: string;
  /** 文件名列表（含扩展名）。**长度决定文案与「保存」按钮的措辞**：1 个 → 单文件句。 */
  names: string[];
}

/** 组装正文两行：message 与 detail（VS Code 同款）。 */
function composeTexts(names: string[]): { message: string; detail: string } {
  const lost = "如果不保存，您的更改将会丢失。";
  if (names.length === 1) {
    return { message: `是否要保存对 ${names[0]} 所做的更改？`, detail: lost };
  }
  return {
    message: `是否要保存对以下 ${names.length} 个文件所做的更改？`,
    detail: `${names.join("、")}\n${lost}`,
  };
}

export function showSaveConfirmDialog(opts: SaveConfirmOptions): Promise<SaveConfirmChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog save-confirm-dialog";

    const title = document.createElement("div");
    title.className = "save-confirm-title";
    title.textContent = opts.title;

    const { message, detail } = composeTexts(opts.names);

    const messageEl = document.createElement("p");
    messageEl.className = "save-confirm-text";
    messageEl.textContent = message;

    const detailEl = document.createElement("p");
    detailEl.className = "save-confirm-detail";
    detailEl.textContent = detail;

    const actions = document.createElement("div");
    actions.className = "save-confirm-actions";

    const save = document.createElement("button");
    save.className = "save-confirm-btn save-confirm-primary";
    save.textContent = opts.names.length > 1 ? "全部保存" : "保存";
    save.title = "先把改动写盘，再关闭";

    const discard = document.createElement("button");
    discard.className = "save-confirm-btn save-confirm-secondary";
    discard.textContent = "不保存";
    discard.title = "放弃这些改动，直接关闭";

    const cancel = document.createElement("button");
    cancel.className = "save-confirm-btn save-confirm-secondary";
    cancel.textContent = "取消";
    cancel.title = "不关闭，回到编辑器";

    // 顺序按用户口径：保存 | 不保存 | 取消（保存在左、为主按钮）
    actions.append(save, discard, cancel);

    dialog.append(title, messageEl, detailEl, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let settled = false;
    const close = (choice: SaveConfirmChoice): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(choice);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Esc 必须落在「什么都不做」这一支：不能「什么都不做」（对话框会反复弹），
        // 更不能替用户选「不保存」。
        close("cancel");
      }
    };

    save.addEventListener("click", () => close("save"));
    discard.addEventListener("click", () => close("discard"));
    cancel.addEventListener("click", () => close("cancel"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("cancel");
    });
    document.addEventListener("keydown", onKeyDown, true);
    // 焦点给「保存」（排在最左、回车即它）—— 与按钮顺序一致，也与 VS Code 一致。
    save.focus();
  });
}
