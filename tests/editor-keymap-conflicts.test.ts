// @vitest-environment jsdom
// 回归（B42 排查中发现）：CodeMirror 的 defaultKeymap 与本应用的全局快捷键
// 存在两处真实撞键，且都会**改写文档**：
//   - `Mod-/`（切换注释）↔ 应用「源码 / 预览切换」（Ctrl+/）
//   - `Shift-Alt-ArrowDown`（向下复制行）↔ 应用「上下分屏」（Alt+Shift+↓）
//
// 因此全局分发改挂在 window **捕获阶段** 并 stopPropagation，抢在编辑器之前拿走键位。
// 本文件锁住「编辑器确实会抢这两个键」这一既有事实——若将来有人把分发改回冒泡阶段，
// 下面的行为会重新出现在真实运行里，而 tests/smoke.bootstrap.test.ts 的
// 「抢在编辑器之前」用例会立刻失败。
import { describe, it, expect } from "vitest";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

function press(init: KeyboardEventInit) {
  const state = EditorState.create({
    doc: "# 标题\n\n正文",
    extensions: [keymap.of([...defaultKeymap]), markdown()],
  });
  const view = new EditorView({ state, parent: document.body });
  view.focus();
  view.dispatch({ selection: { anchor: 0 } });
  const before = view.state.doc.toString();
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(ev);
  const out = {
    prevented: ev.defaultPrevented,
    changed: before !== view.state.doc.toString(),
    after: view.state.doc.toString(),
  };
  view.destroy();
  document.body.innerHTML = "";
  return out;
}

describe("CodeMirror 默认键位确实会抢这两个组合键（既有事实）", () => {
  it("Ctrl+/ 会被编辑器当作「切换注释」，并往 Markdown 文档里插入 HTML 注释", () => {
    const r = press({ code: "Slash", key: "/", ctrlKey: true });
    expect(r.prevented, "编辑器会消费该组合键").toBe(true);
    expect(r.changed, "会改写文档").toBe(true);
    expect(r.after, "插入的是 HTML 注释").toContain("<!--");
  });

  it("Alt+Shift+↓ 会被编辑器当作「向下复制行」，并改写文档", () => {
    const r = press({ code: "ArrowDown", key: "ArrowDown", altKey: true, shiftKey: true });
    expect(r.prevented, "编辑器会消费该组合键").toBe(true);
    expect(r.changed, "会复制当前行").toBe(true);
  });

  it("正因如此，这两个键位在注册表里必须有主，且编辑器侧的占用要登记为只读", () => {
    // 应用侧主键位：view.toggle = Ctrl+/、panel.splitV = Alt+Shift+↓（见 keymap.test.ts）
    // 编辑器侧占用：editor.toggleComment = Ctrl+/（只读项，供冲突检测使用）
    // 这里只做存在性确认，值断言在 keymap.test.ts。
    const keys = defaultKeymap
      .map((b) => (b as { key?: string }).key)
      .filter((k): k is string => !!k);
    expect(keys, "编辑器仍占用 Mod-/").toContain("Mod-/");
    expect(keys, "编辑器仍占用 Shift-Alt-ArrowDown").toContain("Shift-Alt-ArrowDown");
  });
});
