// @vitest-environment jsdom
// 快捷键注册表（src/shell/keymap.ts）单元测试。
// 覆盖：键位串解析/格式化、事件匹配、冲突检测、用户覆盖与解绑、
// 以及 B42 新增的「大纲 / 折叠展开 / 移除分屏」默认键位。
import { afterEach, describe, it, expect } from "vitest";
import {
  COMMANDS,
  DEFAULT_PRESET_ID,
  KEYMAP_PRESETS,
  bindingFromEvent,
  commandById,
  duplicateKeys,
  effectiveKeys,
  findConflict,
  formatBinding,
  isUsableBinding,
  keyHint,
  normalizePresetId,
  parseKey,
  resolveCommand,
  setKeymapPreset,
  type KeymapOverrides,
} from "../src/shell/keymap";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("键位串解析与格式化", () => {
  it("解析 Ctrl+Shift+S 三要素", () => {
    const b = parseKey("Ctrl+Shift+S");
    expect(b).toEqual({ ctrl: true, alt: false, shift: true, key: "s" });
    expect(formatBinding(b!)).toBe("Ctrl+Shift+S");
  });

  it("符号键走 code 而不是 key（Ctrl+Shift+[ 的 e.key 是 { ）", () => {
    expect(parseKey("Ctrl+Shift+[")?.key).toBe("[");
    expect(formatBinding(parseKey("Ctrl+Shift+[")!)).toBe("Ctrl+Shift+[");
    expect(parseKey("Ctrl+Alt+]")?.key).toBe("]");
    expect(parseKey("Ctrl+/")?.key).toBe("/");
    expect(parseKey("Ctrl+=")?.key).toBe("=");
    expect(parseKey("Ctrl+-")?.key).toBe("-");
    expect(parseKey("Ctrl+0")?.key).toBe("0");
  });

  it("方向键/翻页键用紧凑显示名", () => {
    expect(formatBinding(parseKey("Alt+Shift+ArrowRight")!)).toBe("Alt+Shift+→");
    expect(formatBinding(parseKey("Ctrl+PageDown")!)).toBe("Ctrl+PgDn");
    expect(formatBinding(parseKey("Ctrl+PageUp")!)).toBe("Ctrl+PgUp");
    expect(formatBinding(parseKey("F5")!)).toBe("F5");
    expect(formatBinding(parseKey("Del")!)).toBe("Del");
    expect(formatBinding(parseKey("Backspace")!)).toBe("Backspace");
  });

  it("解析不了的串返回 null", () => {
    expect(parseKey("")).toBeNull();
    expect(parseKey("Foo+Bar"), "修饰键位置出现未知词").toBeNull();
    expect(parseKey("Ctrl+Alt"), "只有修饰键、没有真正的按键").toBeNull();
    expect(parseKey("Ctrl+"), "只有修饰键").toBeNull();
  });

  it("末段键名宽容：code 派生的冷门键名也要能往返", () => {
    // bindingFromEvent 会产出这些命名键，若解析时被拒，改完键重启就失效
    for (const spec of ["Ctrl+Numpad0", "Ctrl+IntlBackslash", "Ctrl+PrintScreen"]) {
      const b = parseKey(spec);
      expect(b, `${spec} 应可解析`).toBeTruthy();
      expect(parseKey(formatBinding(b!)), `${spec} 应能往返`).toBeTruthy();
    }
  });
});

describe("事件 → 绑定", () => {
  it("以 KeyboardEvent.code 为准", () => {
    expect(
      bindingFromEvent(key({ code: "BracketLeft", key: "{", shiftKey: true, ctrlKey: true })),
    ).toEqual({ ctrl: true, alt: false, shift: true, key: "[" });
    expect(bindingFromEvent(key({ code: "Slash", key: "/", ctrlKey: true }))?.key).toBe("/");
    expect(bindingFromEvent(key({ code: "Digit0", key: "0", ctrlKey: true }))?.key).toBe("0");
    expect(bindingFromEvent(key({ code: "Equal", key: "=", ctrlKey: true }))?.key).toBe("=");
    expect(bindingFromEvent(key({ code: "PageDown", key: "PageDown", ctrlKey: true }))?.key).toBe(
      "pagedown",
    );
    expect(bindingFromEvent(key({ code: "KeyS", key: "S", ctrlKey: true }))?.key).toBe("s");
    expect(bindingFromEvent(key({ code: "F5", key: "F5" }))?.key).toBe("f5");
  });

  it("纯修饰键按下返回 null（录制时应继续等待）", () => {
    expect(bindingFromEvent(key({ code: "ShiftLeft", key: "Shift", shiftKey: true }))).toBeNull();
    expect(
      bindingFromEvent(key({ code: "ControlLeft", key: "Control", ctrlKey: true })),
    ).toBeNull();
  });

  it("裸字母/数字不可绑定，功能键与带修饰键可以", () => {
    expect(isUsableBinding(parseKey("N")!)).toBe(false);
    expect(isUsableBinding(parseKey("5")!)).toBe(false);
    expect(isUsableBinding(parseKey("Ctrl+N")!)).toBe(true);
    expect(isUsableBinding(parseKey("F3")!)).toBe(true);
    expect(isUsableBinding(parseKey("Shift+F3")!)).toBe(true);
    expect(isUsableBinding(parseKey("Alt+Shift+ArrowLeft")!)).toBe(true);
  });
});

describe("命令分发", () => {
  const none: KeymapOverrides = {};

  it("默认键位命中对应命令", () => {
    expect(resolveCommand(key({ code: "KeyS", key: "s", ctrlKey: true }), none)).toBe("file.save");
    expect(
      resolveCommand(key({ code: "KeyS", key: "S", ctrlKey: true, shiftKey: true }), none),
    ).toBe("file.saveAs");
    expect(resolveCommand(key({ code: "KeyS", key: "s", ctrlKey: true, altKey: true }), none)).toBe(
      "file.saveAll",
    );
  });

  it("折叠：光标处 vs 全部，两套键位互不串台", () => {
    expect(
      resolveCommand(key({ code: "BracketLeft", key: "{", ctrlKey: true, shiftKey: true }), none),
    ).toBe("view.foldCode");
    expect(
      resolveCommand(key({ code: "BracketRight", key: "}", ctrlKey: true, shiftKey: true }), none),
    ).toBe("view.unfoldCode");
    expect(
      resolveCommand(key({ code: "BracketLeft", key: "[", ctrlKey: true, altKey: true }), none),
    ).toBe("view.foldAll");
    expect(
      resolveCommand(key({ code: "BracketRight", key: "]", ctrlKey: true, altKey: true }), none),
    ).toBe("view.unfoldAll");
  });

  it("标签切换两条默认键位都生效", () => {
    expect(resolveCommand(key({ code: "Tab", key: "Tab", ctrlKey: true }), none)).toBe("tab.next");
    expect(resolveCommand(key({ code: "PageDown", key: "PageDown", ctrlKey: true }), none)).toBe(
      "tab.next",
    );
    expect(
      resolveCommand(key({ code: "Tab", key: "Tab", ctrlKey: true, shiftKey: true }), none),
    ).toBe("tab.prev");
    expect(resolveCommand(key({ code: "PageUp", key: "PageUp", ctrlKey: true }), none)).toBe(
      "tab.prev",
    );
  });

  it("B42：大纲与折叠展开都有默认快捷键；移除分屏也不再失联", () => {
    expect(
      resolveCommand(key({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true }), none),
    ).toBe("view.outline");
    expect(resolveCommand(key({ code: "F5", key: "F5" }), none)).toBe("edit.timeDate");
    expect(
      resolveCommand(
        key({ code: "ArrowRight", key: "ArrowRight", altKey: true, shiftKey: true }),
        none,
      ),
    ).toBe("panel.splitH");
    expect(
      resolveCommand(
        key({ code: "ArrowDown", key: "ArrowDown", altKey: true, shiftKey: true }),
        none,
      ),
    ).toBe("panel.splitV");
    expect(
      resolveCommand(
        key({ code: "ArrowLeft", key: "ArrowLeft", altKey: true, shiftKey: true }),
        none,
      ),
    ).toBe("panel.close");
  });

  it("裸字母不进分发（否则编辑器没法打字）", () => {
    expect(resolveCommand(key({ code: "KeyN", key: "n" }), none)).toBeNull();
    expect(resolveCommand(key({ code: "KeyS", key: "s" }), none)).toBeNull();
  });

  it("只读的内置项不参与分发（由 CM / 系统自己处理）", () => {
    expect(resolveCommand(key({ code: "KeyD", key: "d", ctrlKey: true }), none)).toBeNull();
    expect(resolveCommand(key({ code: "KeyZ", key: "z", ctrlKey: true }), none)).toBeNull();
  });
});

describe("用户覆盖", () => {
  it("覆盖后旧键位失效、新键位生效", () => {
    const ov: KeymapOverrides = { "file.save": "Ctrl+Shift+P" };
    expect(resolveCommand(key({ code: "KeyP", key: "P", ctrlKey: true, shiftKey: true }), ov)).toBe(
      "file.save",
    );
    expect(resolveCommand(key({ code: "KeyS", key: "s", ctrlKey: true }), ov)).toBeNull();
    expect(effectiveKeys("file.save", ov)).toEqual(["Ctrl+Shift+P"]);
  });

  it("空串表示显式解绑", () => {
    const ov: KeymapOverrides = { "file.save": "" };
    expect(effectiveKeys("file.save", ov)).toEqual([]);
    expect(keyHint("file.save", ov)).toBe("");
    expect(resolveCommand(key({ code: "KeyS", key: "s", ctrlKey: true }), ov)).toBeNull();
  });

  it("M4：用户覆盖压过别的命令的默认键位（与声明顺序无关）", () => {
    // palette.open 默认就是 Ctrl+Shift+P，且声明在 file.save 之后。
    // 若绑定索引按声明顺序「后写覆盖前写」，覆盖会被默认键位静默抢走。
    const ov: KeymapOverrides = { "file.save": "Ctrl+Shift+P" };
    expect(resolveCommand(key({ code: "KeyP", key: "P", ctrlKey: true, shiftKey: true }), ov)).toBe(
      "file.save",
    );
  });

  it("M4：命令面板默认键位在无覆盖时仍归命令面板", () => {
    const noOv: KeymapOverrides = {};
    expect(
      resolveCommand(key({ code: "KeyP", key: "P", ctrlKey: true, shiftKey: true }), noOv),
    ).toBe("palette.open");
  });

  it("M4：解绑命令面板后该键位不再分发", () => {
    const ov: KeymapOverrides = { "palette.open": "" };
    expect(
      resolveCommand(key({ code: "KeyP", key: "P", ctrlKey: true, shiftKey: true }), ov),
    ).toBeNull();
  });

  it("覆盖会取代命令的多条默认键位", () => {
    const ov: KeymapOverrides = { "tab.next": "Ctrl+Alt+N" };
    expect(effectiveKeys("tab.next", ov)).toEqual(["Ctrl+Alt+N"]);
    expect(resolveCommand(key({ code: "Tab", key: "Tab", ctrlKey: true }), ov)).toBeNull();
  });

  it("keyHint 展示生效键位（多条用 / 连接）", () => {
    expect(keyHint("view.outline", {})).toBe("Ctrl+Shift+O");
    expect(keyHint("tab.next", {})).toBe("Ctrl+Tab / Ctrl+PgDn");
    expect(keyHint("file.new", {})).toBe("Ctrl+N");
  });
});

describe("冲突检测", () => {
  const none: KeymapOverrides = {};

  it("撞到别的可编辑命令会被拦下", () => {
    const hit = findConflict("file.open", "Ctrl+S", none);
    expect(hit?.id).toBe("file.save");
  });

  it("撞到编辑器内置（只读）命令也会被拦下", () => {
    const hit = findConflict("file.open", "Backspace", none);
    expect(hit?.id).toBe("editor.closeBrackets");
    expect(hit?.editable).toBe(false);
  });

  it("自己原本占用的键位不算冲突（改回原键位允许）", () => {
    expect(findConflict("file.save", "Ctrl+S", none)).toBeNull();
  });

  it("未被占用的键位不冲突", () => {
    expect(findConflict("file.open", "Ctrl+Shift+F9", none)).toBeNull();
  });

  it("默认键位表本身无重复", () => {
    expect(duplicateKeys({})).toEqual([]);
  });

  it("覆盖成别人的键位后，重复检测能报出来", () => {
    expect(duplicateKeys({ "file.open": "Ctrl+S" }).length).toBeGreaterThan(0);
  });
});

describe("命令表自检", () => {
  it("命令 id 唯一", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个可编辑命令都有默认键位或明确无键位说明", () => {
    for (const cmd of COMMANDS) {
      if (cmd.editable === false) continue;
      expect(cmd.keys.length, `${cmd.id} 应有默认键位`).toBeGreaterThan(0);
    }
  });

  it("所有默认键位都能被解析", () => {
    for (const cmd of COMMANDS) {
      for (const k of cmd.keys) {
        expect(parseKey(k), `${cmd.id} 的键位「${k}」应可解析`).toBeTruthy();
      }
    }
  });

  it("大纲 / 折叠 / 分屏命令均已登记", () => {
    for (const id of [
      "view.outline",
      "view.foldCode",
      "view.unfoldCode",
      "view.foldAll",
      "view.unfoldAll",
      "panel.splitH",
      "panel.splitV",
      "panel.close",
    ]) {
      expect(commandById(id), `应登记 ${id}`).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------------ M4 键位预设

describe("M4 键位预设：优先级 = 用户覆盖 > 预设 > 默认", () => {
  // 预设是模块级状态，测试之间必须复位，否则会串味
  afterEach(() => {
    setKeymapPreset(DEFAULT_PRESET_ID);
  });

  it("预设表第一项就是默认预设，且 id 唯一", () => {
    expect(KEYMAP_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(KEYMAP_PRESETS[0].id).toBe(DEFAULT_PRESET_ID);
    const ids = KEYMAP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("未知预设 id 一律回落默认（旧配置脏数据不得清空键位表）", () => {
    expect(normalizePresetId("nope")).toBe(DEFAULT_PRESET_ID);
    expect(normalizePresetId(undefined)).toBe(DEFAULT_PRESET_ID);
    expect(normalizePresetId(null)).toBe(DEFAULT_PRESET_ID);
    expect(normalizePresetId("notepadpp")).toBe("notepadpp");
  });

  it("切到 Notepad++ 预设：另存为与全部保存对调", () => {
    expect(effectiveKeys("file.saveAs", {})).toEqual(["Ctrl+Shift+S"]);
    expect(setKeymapPreset("notepadpp")).toBe(true);
    expect(effectiveKeys("file.saveAs", {})).toEqual(["Ctrl+Alt+S"]);
    expect(effectiveKeys("file.saveAll", {})).toEqual(["Ctrl+Shift+S"]);
  });

  it("预设未覆盖的命令仍取默认值（预设只记差异）", () => {
    setKeymapPreset("notepadpp");
    expect(effectiveKeys("file.save", {})).toEqual(["Ctrl+S"]);
    expect(effectiveKeys("edit.find", {})).toEqual(["Ctrl+F"]);
  });

  it("用户覆盖压过预设", () => {
    setKeymapPreset("notepadpp");
    expect(effectiveKeys("file.saveAs", { "file.saveAs": "Ctrl+Q" })).toEqual(["Ctrl+Q"]);
    // 显式解绑（空串）同样压过预设
    expect(effectiveKeys("file.saveAs", { "file.saveAs": "" })).toEqual([]);
  });

  it("所有预设的键位串都能解析，且不与自身默认表重复", () => {
    for (const p of KEYMAP_PRESETS) {
      setKeymapPreset(p.id);
      for (const [id, spec] of Object.entries(p.overrides)) {
        expect(parseKey(spec), `${p.id} 的 ${id} 键位「${spec}」应可解析`).toBeTruthy();
        expect(commandById(id), `${p.id} 引用了不存在的命令 ${id}`).toBeTruthy();
      }
      expect(duplicateKeys({}), `${p.id} 预设内部不应有重复键位`).toEqual([]);
    }
  });

  it("切预设后事件分发立即走新键位（绑定索引必须重建）", () => {
    setKeymapPreset("notepadpp");
    // Ctrl+Alt+S → 另存为（默认预设下它是「全部保存」）
    expect(resolveCommand(key({ code: "KeyS", ctrlKey: true, altKey: true }), {})).toBe(
      "file.saveAs",
    );
    setKeymapPreset(DEFAULT_PRESET_ID);
    expect(resolveCommand(key({ code: "KeyS", ctrlKey: true, altKey: true }), {})).toBe(
      "file.saveAll",
    );
  });

  it("切到同一预设返回 false（避免无谓的持久化与提示）", () => {
    setKeymapPreset("vscode");
    expect(setKeymapPreset("vscode")).toBe(false);
    expect(setKeymapPreset("unknown")).toBe(false);
  });
});
