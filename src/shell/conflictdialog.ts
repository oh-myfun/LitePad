/**
 * 外部修改冲突对话框（VS Code `files.saveConflictResolution` 的简化版）。
 *
 * 触发条件：**磁盘内容变了，而编辑器里这份也有未保存修改** —— 两边都改过，
 * 谁覆盖谁都不能替用户决定。三选一：
 *
 * - `keep-mine`  保留我的修改：编辑器不动，仍为脏；下次保存覆盖磁盘上的外部版本。
 * - `take-disk`  载入磁盘版本：放弃我的修改，内容换成磁盘上的（同时作废热退出副本）。
 * - `compare`    打开磁盘版本对照：把磁盘那份开成一个未命名标签，当前文档一字不动，
 *                用户可以拖去分屏左右对照后再自己决定。
 *
 * ⚠️「比较」没有做 diff 编辑器（本项目范围内不做），用「另开一份对照」替代 ——
 * 既不丢任何一边的内容，也不需要引入并排 diff 视图这一整套新机制。
 *
 * 关闭对话框（Esc / 点遮罩）等价于 `keep-mine`：这是唯一不会丢数据的默认行为，
 * 用户什么都没选时绝不能替他丢掉编辑器里的修改。
 */

export type ExternalConflictChoice = "keep-mine" | "take-disk" | "compare";

export interface ExternalConflictOptions {
  /** 文件名（含扩展名） */
  name: string;
  /** 磁盘版本的字符数 */
  diskChars: number;
  /** 编辑器里那份的字符数 */
  mineChars: number;
}

export function showExternalConflictDialog(
  opts: ExternalConflictOptions,
): Promise<ExternalConflictChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog conflict-dialog";

    const title = document.createElement("div");
    title.className = "settings-title";
    title.textContent = "文件在外部被修改了";

    const body = document.createElement("div");

    const lead = document.createElement("p");
    lead.className = "conflict-text";
    lead.textContent = `${opts.name} 已在 LitePad 之外被修改，而你在编辑器里也有未保存的修改。想保留哪一份？`;

    const meta = document.createElement("div");
    meta.className = "conflict-meta";
    meta.textContent = `磁盘版本 ${opts.diskChars} 字符 · 你的版本 ${opts.mineChars} 字符`;

    body.append(lead, meta);

    const actions = document.createElement("div");
    actions.className = "settings-actions conflict-actions";

    const keep = document.createElement("button");
    keep.className = "settings-ok";
    keep.textContent = "保留我的修改";
    keep.title = "编辑器内容不动，保存时会覆盖磁盘上的外部版本";

    const take = document.createElement("button");
    take.className = "settings-cancel";
    take.textContent = "载入磁盘版本";
    take.title = "放弃我的未保存修改，内容换成磁盘上的";

    const compare = document.createElement("button");
    compare.className = "settings-cancel";
    compare.textContent = "打开磁盘版本对照";
    compare.title = "把磁盘那份开成一个新标签，当前文档不动";

    actions.append(keep, take, compare);

    dialog.append(title, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let settled = false;
    const close = (choice: ExternalConflictChoice): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(choice);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Esc 不能「什么都不做」：那会让对话框在下一次事件时被反复弹出来。
        // 取不会丢数据的那一支。
        close("keep-mine");
      }
    };

    keep.addEventListener("click", () => close("keep-mine"));
    take.addEventListener("click", () => close("take-disk"));
    compare.addEventListener("click", () => close("compare"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("keep-mine");
    });
    document.addEventListener("keydown", onKeyDown, true);
    keep.focus();
  });
}

export type SaveConflictChoice = "overwrite" | "revert" | "compare" | "cancel";

export interface SaveConflictOptions {
  /** 文件名（含扩展名） */
  name: string;
  /** 磁盘版本的字符数 */
  diskChars: number;
  /** 编辑器里那份的字符数 */
  mineChars: number;
}

/**
 * **保存时**撞上「磁盘版本更新」的对话框（VS Code `FILE_MODIFIED_SINCE` 的落地形式）。
 *
 * 与上面那个（监听器发现外部改动）的区别在**触发点**：这里是用户**主动保存**的瞬间，
 * 写盘前发现磁盘上的版本已经变了 —— 此时一个字节都还没写，所以四个选项都是安全的：
 *
 * - `overwrite` 覆盖保存：用我的修改盖掉磁盘上的新版本（磁盘那份会丢）。
 * - `revert`   载入磁盘版本：放弃我的未保存修改，内容换成磁盘上的。
 * - `compare`  对照比较：把磁盘那份开成一个新标签，当前文档不动，看过再决定。
 * - `cancel`   取消：这次不保存，文档仍然脏，下次保存会再问一次。
 *
 * ⚠️ Esc / 点遮罩 = `cancel`。这是唯一既没写盘、也没丢改动的选项 ——
 * 用户什么都没选时，绝不能替他覆盖外部的新版本，也不能替他丢掉编辑器里的修改。
 * ⚠️ 焦点给「对照比较」（VS Code 把 Compare 排在首位）：它不产生任何破坏性后果，
 * 而「覆盖保存」一旦误触就再也找不回磁盘上那份。
 */
export function showSaveConflictDialog(opts: SaveConflictOptions): Promise<SaveConflictChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog conflict-dialog";

    const title = document.createElement("div");
    title.className = "settings-title";
    title.textContent = "保存时发现磁盘上的内容更新了";

    const body = document.createElement("div");

    const lead = document.createElement("p");
    lead.className = "conflict-text";
    lead.textContent = `${opts.name} 在磁盘上的版本比编辑器里这份更新（你上次载入或保存之后被改过）。要怎么处理？`;

    const meta = document.createElement("div");
    meta.className = "conflict-meta";
    meta.textContent = `磁盘版本 ${opts.diskChars} 字符 · 你的版本 ${opts.mineChars} 字符`;

    const hint = document.createElement("div");
    hint.className = "conflict-meta";
    hint.textContent = "按 Esc 取消本次保存（不会写盘，也不会丢弃你的修改）";

    body.append(lead, meta, hint);

    const actions = document.createElement("div");
    actions.className = "settings-actions conflict-actions";

    const compare = document.createElement("button");
    compare.className = "settings-ok";
    compare.textContent = "对照比较";
    compare.title = "把磁盘那份开成一个新标签，当前文档不动";

    const overwrite = document.createElement("button");
    overwrite.className = "settings-cancel";
    overwrite.textContent = "覆盖保存";
    overwrite.title = "用编辑器里的修改覆盖磁盘上的新版本（磁盘那份会丢失）";

    const revert = document.createElement("button");
    revert.className = "settings-cancel";
    revert.textContent = "载入磁盘版本";
    revert.title = "放弃我的未保存修改，内容换成磁盘上的";

    actions.append(compare, overwrite, revert);

    dialog.append(title, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let settled = false;
    const close = (choice: SaveConflictChoice): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(choice);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close("cancel");
      }
    };

    compare.addEventListener("click", () => close("compare"));
    overwrite.addEventListener("click", () => close("overwrite"));
    revert.addEventListener("click", () => close("revert"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("cancel");
    });
    document.addEventListener("keydown", onKeyDown, true);
    compare.focus();
  });
}
