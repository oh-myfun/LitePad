/**
 * 快捷键对话框：浏览 + 编辑。
 *
 * - 分组命令清单，右侧显示当前键位。可编辑项是按钮：点一下进入录制态，
 *   按下新组合键即生效（Esc 取消，Backspace/Delete 清除绑定）。
 * - `editable: false` 的命令由 CodeMirror / 系统原生处理，只展示不可改。
 * - 冲突会当场拦下并提示占用者，避免两个命令抢同一个键。
 * - 改动即时交给 `onChange`（由 main 负责持久化），不需要「保存」按钮。
 */

import {
  bindingFromEvent,
  commandById,
  effectiveKeys,
  findConflict,
  formatBinding,
  groupedCommands,
  isUsableBinding,
  KEYMAP_PRESETS,
  parseKey,
  presetById,
  setKeymapPreset,
  type KeymapOverrides,
} from "./keymap";

export interface KeymapDialogOptions {
  overrides: KeymapOverrides;
  /** 覆盖表变化时回调（含清空恢复默认） */
  onChange: (next: KeymapOverrides) => void;
  /** 当前键位预设 id */
  preset: string;
  /** 切换预设时回调（由 main 持久化） */
  onPresetChange: (id: string) => void;
}

/** 录制态 body class，供全局快捷键分发器让路（否则 Ctrl+N 会被当成「新建」）。 */
export const KEYMAP_RECORDING_CLASS = "keymap-recording";

export function showKeymapDialog(opts: KeymapDialogOptions): void {
  // 对话框持有副本，每次改动同步外抛（main 负责持久化）
  const overrides: KeymapOverrides = { ...opts.overrides };

  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";

  const dialog = document.createElement("div");
  dialog.className = "settings-dialog keymap-dialog";

  const title = document.createElement("div");
  title.className = "settings-title";
  title.textContent = "快捷键";

  const toolbar = document.createElement("div");
  toolbar.className = "keymap-toolbar";

  // 预设下拉（M4）：换的是「基线」，下拉右边跟一句说明
  const presetSel = document.createElement("select");
  presetSel.className = "keymap-preset";
  presetSel.title = "键位预设：决定各命令的默认键位；在此之上的单独改动仍可继续自定义";
  for (const p of KEYMAP_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    opt.title = p.note;
    presetSel.appendChild(opt);
  }
  presetSel.value = presetById(opts.preset)?.id ?? KEYMAP_PRESETS[0].id;

  const search = document.createElement("input");
  search.className = "keymap-search";
  search.type = "search";
  search.placeholder = "搜索命令或键位…";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "keymap-reset";
  reset.textContent = "恢复全部默认";
  toolbar.append(presetSel, search, reset);

  const hint = document.createElement("div");
  hint.className = "keymap-hint";

  const list = document.createElement("div");
  list.className = "keymap-list";

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const ok = document.createElement("button");
  ok.className = "settings-ok";
  ok.textContent = "确定";
  actions.append(ok);

  dialog.append(title, toolbar, hint, list, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // 录制态：同一时刻只允许一个键位按钮处于录制中
  let recording: HTMLButtonElement | null = null;
  let recordId: string | null = null;
  let recordHandler: ((e: KeyboardEvent) => void) | null = null;

  function stopRecording(): void {
    if (recordHandler) document.removeEventListener("keydown", recordHandler, true);
    recordHandler = null;
    recordId = null;
    recording?.classList.remove("recording");
    recording = null;
    document.body.classList.remove(KEYMAP_RECORDING_CLASS);
    hint.textContent = "";
    hint.classList.remove("warn");
  }

  function applyChange(): void {
    opts.onChange({ ...overrides });
  }

  function displayKeys(id: string, editable: boolean): string {
    const keys = effectiveKeys(id, overrides);
    if (keys.length === 0) return editable ? "未设置" : "";
    return keys
      .map((k) => formatBinding(parseKey(k) ?? { ctrl: false, alt: false, shift: false, key: k }))
      .join(" / ");
  }

  /** 按键 → 写入覆盖表。返回是否已处理完（用于决定是否退出录制态）。 */
  function handleRecordKey(e: KeyboardEvent, id: string, rerender: () => void): void {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      stopRecording();
      rerender();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      overrides[id] = "";
      stopRecording();
      applyChange();
      rerender();
      return;
    }

    const b = bindingFromEvent(e);
    if (!b) return; // 纯修饰键：继续等待
    if (!isUsableBinding(b)) {
      hint.textContent = "该键位需要配合 Ctrl 或 Alt，或改用功能键";
      hint.classList.add("warn");
      return;
    }
    const spec = formatBinding(b);
    const conflictCmd = findConflict(id, spec, overrides);
    if (conflictCmd) {
      hint.textContent = `已占用：${spec} → ${conflictCmd.label}`;
      hint.classList.add("warn");
      return;
    }
    overrides[id] = spec;
    stopRecording();
    applyChange();
    rerender();
  }

  /**
   * 录制监听挂在 document 捕获阶段，而不是键位按钮上：
   * 按钮不一定拿到焦点，挂按钮会「点了没反应」。
   */
  function startRecording(btn: HTMLButtonElement, id: string, rerender: () => void): void {
    stopRecording();
    recording = btn;
    recordId = id;
    btn.classList.add("recording");
    btn.textContent = "按下新键…";
    document.body.classList.add(KEYMAP_RECORDING_CLASS);
    hint.textContent = "按下新的组合键；Esc 取消，Backspace 清除绑定";
    hint.classList.remove("warn");
    btn.focus();
    recordHandler = (e) => {
      if (recordId !== id) return;
      handleRecordKey(e, id, rerender);
    };
    document.addEventListener("keydown", recordHandler, true);
  }

  const render = (): void => {
    stopRecording();
    list.textContent = "";
    const query = search.value.trim().toLowerCase();

    for (const { group, commands } of groupedCommands()) {
      const rows = commands.filter((cmd) => {
        if (!query) return true;
        const keys = effectiveKeys(cmd.id, overrides).join(" ").toLowerCase();
        return (
          cmd.label.toLowerCase().includes(query) ||
          cmd.group.toLowerCase().includes(query) ||
          keys.includes(query)
        );
      });
      if (rows.length === 0) continue;

      const head = document.createElement("div");
      head.className = "keymap-group";
      head.textContent = group;
      list.appendChild(head);

      for (const cmd of rows) {
        const row = document.createElement("div");
        row.className = "keymap-row";

        const name = document.createElement("span");
        name.className = "keymap-cmd";
        name.textContent = cmd.label;
        if (cmd.note) name.title = cmd.note;
        row.appendChild(name);

        if (cmd.editable === false) {
          const kbd = document.createElement("span");
          kbd.className = "settings-kbd keymap-static";
          kbd.textContent = displayKeys(cmd.id, false);
          row.appendChild(kbd);
        } else {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "keymap-key";
          btn.textContent = displayKeys(cmd.id, true);
          btn.addEventListener("click", () => {
            if (recording === btn) {
              stopRecording();
              render();
            } else {
              startRecording(btn, cmd.id, render);
            }
          });
          row.appendChild(btn);
        }

        list.appendChild(row);
      }
    }

    if (list.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.className = "keymap-empty";
      empty.textContent = "没有匹配的命令";
      list.appendChild(empty);
    }
  };

  search.addEventListener("input", render);

  presetSel.addEventListener("change", () => {
    const p = presetById(presetSel.value);
    if (!p) return;
    if (setKeymapPreset(p.id)) {
      // 预设换的是基线，旧的自定义覆盖语义已失效（它们原本是相对上一套预设的
      // 差异），一并清空，否则会出现「换回默认却仍带着旧键位」的错觉。
      for (const key of Object.keys(overrides)) delete overrides[key];
      opts.onPresetChange(p.id);
      applyChange();
      render();
    }
    hint.textContent = `${p.label} · ${p.note}`;
    hint.classList.remove("warn");
  });

  reset.addEventListener("click", () => {
    for (const key of Object.keys(overrides)) delete overrides[key];
    stopRecording();
    applyChange();
    render();
    hint.textContent = "已恢复全部默认键位";
    hint.classList.remove("warn");
  });

  render();
  search.focus();

  const onDocKeyDown = (e: KeyboardEvent): void => {
    // 录制中的按键由 recordHandler 专管，不能顺带把对话框关掉
    if (e.key === "Escape" && !recording) close();
  };

  const close = (): void => {
    stopRecording();
    document.removeEventListener("keydown", onDocKeyDown, true);
    overlay.remove();
  };

  ok.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onDocKeyDown, true);
}

/** 供 main 判断某命令是否可编辑（菜单/提示用）。 */
export function commandEditable(id: string): boolean {
  return commandById(id)?.editable !== false;
}
