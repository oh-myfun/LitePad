// @vitest-environment jsdom
// B358 预览面的勾选框点击：可写性决定灰不灰、点击把序号交回宿主（换算与落笔都不在这层）。
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/sync-scroll/wire", () => ({
  syncCoordinator: { expectSurfaceV: vi.fn() },
  PreviewScrollAnchor: class {
    getV() {
      return 1;
    }
    setV() {}
  },
}));

vi.mock("../src/ipc/api", () => ({
  convertFileSrc: (p: string) => `http://asset.localhost/${p}`,
}));

import { PreviewPane } from "../src/markdown/preview";
import type { MdBlock } from "../src/markdown/pipeline";

/** 照管线产物写：`disabled` 在 HTML 里，可写性由 pane 在 patch 后统一解锁。 */
const TASKS = (checked: boolean): MdBlock => ({
  lineStart: 3,
  lineEnd: 4,
  html:
    '<ul>\n<li class="task-item"><input type="checkbox" class="md-task" disabled' +
    (checked ? " checked" : "") +
    "> 甲</li>\n</ul>",
});

function mount(writable: boolean) {
  const pane = new PreviewPane();
  const toggle = vi.fn();
  pane.setHost({
    lineCount: () => 10,
    canWrite: () => writable,
    toggleTaskAt: toggle,
  });
  document.body.appendChild(pane.root);
  pane.setBlocks([TASKS(false)]);
  return { pane, toggle };
}

describe("B358 预览面：勾选框可点性随宿主、点击交回宿主", () => {
  it("可写 ⇒ 解锁；点第一个框 ⇒ toggleTaskAt(3, 4, 0)", () => {
    const { pane, toggle } = mount(true);
    const box = pane.root.querySelector<HTMLInputElement>("input.md-task")!;
    expect(box.disabled, "可写文档的框不该灰着").toBe(false);
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggle).toHaveBeenCalledWith(3, 4, 0);
  });

  it("只读 ⇒ 保持灰着，点了也不交回宿主", () => {
    const { pane, toggle } = mount(false);
    const box = pane.root.querySelector<HTMLInputElement>("input.md-task")!;
    expect(box.disabled).toBe(true);
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggle, "灰着的框不许触发写").not.toHaveBeenCalled();
  });

  it("复用的岛也跟着可写性走（patch 后全量对一遍，不是只管新建的）", () => {
    const { pane } = mount(false);
    // 同一份 html 再 patch 一发：岛被复用（对齐判据只比 html），disabled 必须仍是灰的
    pane.setBlocks([TASKS(false)]);
    const box = pane.root.querySelector<HTMLInputElement>("input.md-task")!;
    expect(box.disabled).toBe(true);
  });
});
