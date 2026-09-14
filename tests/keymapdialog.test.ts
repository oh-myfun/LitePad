// @vitest-environment jsdom
// 快捷键对话框（B42）：浏览 + 编辑的交互回归。
// 覆盖录制改键、冲突拦截、Esc 只取消录制、Backspace 解绑、恢复默认、搜索过滤。
import { describe, it, expect, afterEach } from "vitest";
import { KEYMAP_RECORDING_CLASS, showKeymapDialog } from "../src/shell/keymapdialog";
import { DEFAULT_PRESET_ID, setKeymapPreset, type KeymapOverrides } from "../src/shell/keymap";

function pressDoc(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
}

function openDialog(
  overrides: KeymapOverrides = {},
  preset = DEFAULT_PRESET_ID,
  onPresetChange: (id: string) => void = () => {},
): { changes: KeymapOverrides[] } {
  const changes: KeymapOverrides[] = [];
  showKeymapDialog({ overrides, onChange: (n) => changes.push(n), preset, onPresetChange });
  return { changes };
}

function presetSelect(): HTMLSelectElement {
  const sel = document.querySelector<HTMLSelectElement>(".keymap-preset");
  expect(sel, "对话框应有键位预设下拉").toBeTruthy();
  return sel!;
}

function rowOf(label: string): Element {
  const row = [...document.querySelectorAll(".keymap-row")].find(
    (r) => r.querySelector(".keymap-cmd")?.textContent === label,
  );
  expect(row, `应有命令行「${label}」`).toBeTruthy();
  return row!;
}

function keyButton(label: string): HTMLButtonElement {
  const btn = rowOf(label).querySelector<HTMLButtonElement>(".keymap-key");
  expect(btn, `「${label}」应是可编辑键位按钮`).toBeTruthy();
  return btn!;
}

function hintText(): string {
  return document.querySelector(".keymap-hint")?.textContent ?? "";
}

afterEach(() => {
  for (const el of document.querySelectorAll(".settings-overlay")) el.remove();
  document.body.classList.remove(KEYMAP_RECORDING_CLASS);
  document.body.textContent = "";
});

describe("快捷键对话框：浏览", () => {
  it("按分组列出命令，可编辑项是按钮、内置项只是文字", () => {
    openDialog();
    const groups = [...document.querySelectorAll(".keymap-group")].map((g) => g.textContent);
    for (const g of ["文件", "标签", "编辑", "视图", "面板", "编辑器内置", "菜单助记符"]) {
      expect(groups, `应有分组「${g}」`).toContain(g);
    }
    // 可编辑
    expect(keyButton("保存").textContent).toBe("Ctrl+S");
    expect(keyButton("新建标签").textContent).toBe("Ctrl+N");
    // 新增默认键位必须在列表里可见
    expect(keyButton("显示/隐藏大纲 TOC").textContent).toBe("Ctrl+Shift+O");
    expect(keyButton("折叠全部").textContent).toBe("Ctrl+Alt+[");
    expect(keyButton("展开全部").textContent).toBe("Ctrl+Alt+]");
    expect(keyButton("移除分屏（标签并入相邻）").textContent).toBe("Alt+Shift+←");

    // 只读项：没有按钮，只有静态 kbd
    const undo = rowOf("撤销");
    expect(undo.querySelector(".keymap-key"), "内置命令不应可点").toBeNull();
    expect(undo.querySelector(".keymap-static")?.textContent).toBe("Ctrl+Z");
  });

  it("多条默认键位用 / 连接展示", () => {
    openDialog();
    expect(keyButton("下一个标签").textContent).toBe("Ctrl+Tab / Ctrl+PgDn");
  });

  it("搜索框按命令名和键位过滤", () => {
    openDialog();
    const input = document.querySelector<HTMLInputElement>(".keymap-search")!;

    input.value = "大纲";
    input.dispatchEvent(new Event("input"));
    expect([...document.querySelectorAll(".keymap-cmd")].map((e) => e.textContent)).toEqual([
      "显示/隐藏大纲 TOC",
    ]);

    input.value = "ctrl+alt+[";
    input.dispatchEvent(new Event("input"));
    expect([...document.querySelectorAll(".keymap-cmd")].map((e) => e.textContent)).toEqual([
      "折叠全部",
    ]);

    input.value = "不存在的命令";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector(".keymap-empty")).toBeTruthy();
  });
});

describe("快捷键对话框：编辑", () => {
  it("点键位按钮进入录制态，按下组合键即改键并回调", () => {
    const { changes } = openDialog();
    keyButton("打开文件…").click();
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS), "应进入录制态").toBe(true);
    expect(keyButton("打开文件…").textContent).toBe("按下新键…");

    // Ctrl+Shift+P 已是「命令面板」的默认键位，这里换一个确实空闲的键
    pressDoc({ code: "KeyJ", key: "J", ctrlKey: true, altKey: true });

    expect(changes).toEqual([{ "file.open": "Ctrl+Alt+J" }]);
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS), "录制应结束").toBe(false);
    // 列表已重绘为新键位
    expect(keyButton("打开文件…").textContent).toBe("Ctrl+Alt+J");
  });

  it("纯修饰键按下不结束录制（等真正的按键）", () => {
    const { changes } = openDialog();
    keyButton("打开文件…").click();
    pressDoc({ code: "ShiftLeft", key: "Shift", shiftKey: true });
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS)).toBe(true);
    expect(changes).toEqual([]);
  });

  it("撞到已占用的键位会被拦下，并提示占用者", () => {
    const { changes } = openDialog();
    keyButton("打开文件…").click();
    pressDoc({ code: "KeyS", key: "s", ctrlKey: true });

    expect(changes, "冲突时不得写入").toEqual([]);
    expect(hintText()).toContain("已占用");
    expect(hintText()).toContain("Ctrl+S");
    expect(hintText()).toContain("保存");
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS), "仍应停留在录制态").toBe(true);
  });

  it("裸字母会被拒绝（否则会抢走正常输入）", () => {
    const { changes } = openDialog();
    keyButton("打开文件…").click();
    pressDoc({ code: "KeyP", key: "p" });
    expect(changes).toEqual([]);
    expect(hintText()).toContain("Ctrl");
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS)).toBe(true);
  });

  it("Esc 在录制中只取消录制，不关闭对话框", () => {
    const { changes } = openDialog();
    keyButton("打开文件…").click();
    pressDoc({ code: "Escape", key: "Escape" });

    expect(document.querySelector(".settings-overlay"), "对话框应仍在").toBeTruthy();
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS)).toBe(false);
    expect(changes).toEqual([]);

    // 再按一次才关闭
    pressDoc({ code: "Escape", key: "Escape" });
    expect(document.querySelector(".settings-overlay")).toBeNull();
  });

  it("Backspace / Delete 清除绑定（显式解绑）", () => {
    const { changes } = openDialog();
    keyButton("保存").click();
    pressDoc({ code: "Backspace", key: "Backspace" });
    expect(changes).toEqual([{ "file.save": "" }]);
    expect(keyButton("保存").textContent).toBe("未设置");
  });

  it("恢复全部默认会清空覆盖表并重绘", () => {
    const { changes } = openDialog({ "file.save": "Ctrl+Shift+P" });
    expect(keyButton("保存").textContent).toBe("Ctrl+Shift+P");
    document.querySelector<HTMLButtonElement>(".keymap-reset")!.click();
    expect(changes).toEqual([{}]);
    expect(keyButton("保存").textContent).toBe("Ctrl+S");
    expect(hintText()).toContain("已恢复全部默认键位");
  });

  it("确定关闭后不再响应按键（监听器已摘除）", () => {
    openDialog();
    keyButton("保存").click();
    document.querySelector<HTMLButtonElement>(".settings-ok")!.click();
    expect(document.querySelector(".settings-overlay")).toBeNull();
    expect(document.body.classList.contains(KEYMAP_RECORDING_CLASS)).toBe(false);
  });
});

// ------------------------------------------------------------------ M4 键位预设下拉

describe("M4 快捷键对话框：键位预设下拉", () => {
  afterEach(() => {
    setKeymapPreset(DEFAULT_PRESET_ID);
  });

  it("下拉列出全部预设，并选中当前预设", () => {
    openDialog({}, "vscode");
    const sel = presetSelect();
    expect([...sel.options].map((o) => o.textContent)).toContain("Notepad++");
    expect(sel.value).toBe("vscode");
  });

  it("切换预设立即改变列表里显示的键位", () => {
    openDialog({});
    expect(keyButton("另存为…").textContent).toBe("Ctrl+Shift+S");

    const sel = presetSelect();
    sel.value = "notepadpp";
    sel.dispatchEvent(new Event("change"));

    // Notepad++ 预设下另存为是 Ctrl+Alt+S
    expect(keyButton("另存为…").textContent).toBe("Ctrl+Alt+S");
  });

  it("切换预设会清掉旧的自定义覆盖（否则换回默认仍带着旧键位）", () => {
    const { changes } = openDialog({ "file.save": "Ctrl+Q" });
    changes.length = 0;

    const sel = presetSelect();
    sel.value = "vscode";
    sel.dispatchEvent(new Event("change"));

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[changes.length - 1], "覆盖表应已被清空").toEqual({});
  });

  it("切换预设会回调 onPresetChange（供 main 持久化）", () => {
    const picked: string[] = [];
    openDialog({}, DEFAULT_PRESET_ID, (id) => picked.push(id));

    const sel = presetSelect();
    sel.value = "notepadpp";
    sel.dispatchEvent(new Event("change"));

    expect(picked).toEqual(["notepadpp"]);
  });

  it("预设 id 非法时下拉回落默认，不崩也不改状态", () => {
    openDialog({}, "no-such-preset");
    expect(presetSelect().value).toBe(DEFAULT_PRESET_ID);
  });
});
