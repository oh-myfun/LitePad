// @vitest-environment jsdom
// B71：拖标签栏**空白处** = 拖整组（对标 VS Code `editorTabsControl.onGroupDragStart`
// 的 `e.target === tabsContainer` 判据）。落点只有两种语义：
//   落在别的面板的标签区 / 中心 → 整组并入；落在边缘 → 整组搬到该侧新分屏。
// 拖回自己所在面板 = 无操作。
//
// ⚠️ 与单标签拖拽的分界必须锁住：命中任何 .tab 都只能拖那一个标签 ——
// 判据写反的话「拖标签」会变成「拖整组」，用户会莫名其妙丢掉一个分屏。
//
// B91-2：运输方式从指针事件换成 HTML5 DnD，本文件因此把「派发 mousedown/mousemove/
// mouseup」换成「派发 dragstart/dragover/drop」；**落点语义的断言一条没动** ——
// 这正是那次替换该有的样子（换运输，不换语义）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));

import {
  clearDropIndicators,
  commitTabDrop,
  previewDropAt,
  renderSplitview,
  type PanelRenderData,
  type SplitviewCallbacks,
} from "../src/shell/splitview";
import {
  GROUP_IMAGE_ANCHOR,
  TAB_IMAGE_ANCHOR,
  createGroupDragImage,
  createTabDragImage,
} from "../src/shell/tabstrip";
import { TAB_MIME, encodeTabDrag, installTabDnd, readTabDragPayload } from "../src/shell/tabdnd";
import { leaf, type LayoutNode } from "../src/shell/layout";
import { fireDrag, makeDataTransfer, type FakeDataTransfer } from "./dnd";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

/** 面板 1 的标签描述（B72：支持多标签，用来验整组影像的药丸文案）。 */
type TabSpec = { name: string; active?: boolean; dirty?: boolean };

/** 左右两个面板：左 [0..400)，右 [400..800)，标签栏各占顶部 28px。 */
function mount(tabs: TabSpec[] = []) {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.appendChild(root);

  const onMergeGroup = vi.fn();
  const onMoveGroupToPanel = vi.fn();
  const onDropTabToPanel = vi.fn();
  const onMoveTabToStrip = vi.fn();
  const cb = {
    onActivatePanel: () => {},
    onActivateTab: () => {},
    onCloseTab: () => {},
    onClosePanel: () => {},
    onRatioChange: () => {},
    onMoveTabToStrip,
    onDropTabToPanel,
    onMergeGroup,
    onMoveGroupToPanel,
    mountView: () => {},
  } as unknown as SplitviewCallbacks;

  const tree: LayoutNode = { kind: "split", dir: "h", ratio: 0.5, a: leaf(1), b: leaf(2) };
  const data = new Map<number, PanelRenderData>();
  data.set(1, {
    panelId: 1,
    active: true,
    canClose: true,
    tabs: tabs.map((t, i) => ({
      tabId: 11 + i,
      name: t.name,
      dirty: !!t.dirty,
      readonly: false,
      active: !!t.active,
    })),
  });
  data.set(2, { panelId: 2, active: false, canClose: true, tabs: [] });
  renderSplitview(root, tree, data, cb);

  const panels = root.querySelectorAll<HTMLElement>(".layout-panel");
  panels[0].getBoundingClientRect = () => rect(0, 0, 400, 300);
  panels[1].getBoundingClientRect = () => rect(400, 0, 400, 300);
  const strips = root.querySelectorAll<HTMLElement>(".panel-tabstrip");
  strips[0].getBoundingClientRect = () => rect(0, 0, 400, 28);
  strips[1].getBoundingClientRect = () => rect(400, 0, 400, 28);

  return {
    root,
    panels,
    strips,
    onMergeGroup,
    onMoveGroupToPanel,
    onDropTabToPanel,
    onMoveTabToStrip,
  };
}

/** 复刻 main.ts 的接线：drop → commitTabDrop，预览/清理走 splitview 的那两个导出。 */
let uninstall: (() => void) | null = null;
async function armDrop(): Promise<void> {
  uninstall = await installTabDnd({
    selfLabel: "main",
    preview: (x, y, alt) => previewDropAt(x, y, alt),
    clear: () => clearDropIndicators(),
    commitLocal: (req) => commitTabDrop(req),
    snapshot: () => null,
    relinquish: () => {},
    adopt: () => false,
    onFallback: () => {},
  });
}

/** 从一个真实拖拽元素起手（dragstart 会冒泡到 strip，判据在那边）。 */
function dragStartFrom(el: HTMLElement): FakeDataTransfer {
  const dt = makeDataTransfer();
  fireDrag("dragstart", el, dt);
  return dt;
}

/** 本窗口整组拖拽的等价载荷（dragstart 那一段另有用例覆盖，这里只验落点）。 */
function selfGroupDt(panelId: number, count: number): FakeDataTransfer {
  const dt = makeDataTransfer();
  dt.setData(
    TAB_MIME,
    encodeTabDrag({
      v: 1,
      from: "main",
      tabId: -1,
      groupPanelId: panelId,
      count,
      dragId: "d1",
    }),
  );
  return dt;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("B71 拖标签栏空白处 = 拖整组（dragstart 载荷）", () => {
  it("空白处起手 → groupPanelId 是本面板、tabId 是占位 -1、count 是标签数", async () => {
    await armDrop();
    const m = mount([{ name: "a.md" }, { name: "b.md" }, { name: "c.md" }]);
    const p = readTabDragPayload(dragStartFrom(m.strips[0]))!;
    expect(p.groupPanelId).toBe(1);
    expect(p.tabId).toBe(-1);
    expect(p.count).toBe(3);
  });

  it("⚠️ 命中 .tab 时绝不能变成整组拖拽（分界判据）", async () => {
    await armDrop();
    const m = mount([{ name: "a.md", active: true }]);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    const p = readTabDragPayload(dragStartFrom(tab))!;
    expect(p.groupPanelId, "单标签拖拽的载荷不该带整组信息").toBeNull();
    expect(p.tabId).toBe(11);
    expect(p.count).toBe(1);
  });

  it("空标签栏起手 → 直接挡掉（没有可拖的东西）", async () => {
    await armDrop();
    const m = mount();
    const e = fireDrag("dragstart", m.strips[0], makeDataTransfer());
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("B71 整组落点语义（松手才提交）", () => {
  it("落在另一个面板的中心 → 整组并入（源面板消失）", async () => {
    await armDrop();
    const m = mount();
    fireDrag("drop", document, selfGroupDt(1, 2), { clientX: 600, clientY: 150 });
    expect(m.onMergeGroup).toHaveBeenCalledWith(1, 2);
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("落在另一个面板的右缘 → 整组搬到右侧新分屏", async () => {
    await armDrop();
    const m = mount();
    fireDrag("drop", document, selfGroupDt(1, 2), { clientX: 790, clientY: 150 });
    expect(m.onMoveGroupToPanel).toHaveBeenCalledWith(1, 2, "h", false);
    expect(m.onMergeGroup).not.toHaveBeenCalled();
  });

  it("落点在上/下缘 → 垂直分屏", async () => {
    await armDrop();
    const m = mount();
    fireDrag("drop", document, selfGroupDt(1, 2), { clientX: 600, clientY: 295 });
    expect(m.onMoveGroupToPanel).toHaveBeenCalledWith(1, 2, "v", false);
  });

  it("落在目标面板的标签区 → 按并入处理（整组不插队）", async () => {
    await armDrop();
    const m = mount();
    fireDrag("drop", document, selfGroupDt(1, 2), { clientX: 600, clientY: 14 });
    expect(m.onMergeGroup).toHaveBeenCalledWith(1, 2);
    expect(m.onMoveTabToStrip, "整组不按单标签那样插到某个标签前").not.toHaveBeenCalled();
  });

  it("Alt = 临时取消分屏：边缘落点也按并入处理（与单标签拖拽一致）", async () => {
    await armDrop();
    const m = mount();
    fireDrag("drop", document, selfGroupDt(1, 2), { clientX: 790, clientY: 150, altKey: true });
    expect(m.onMergeGroup).toHaveBeenCalledWith(1, 2);
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("拖回自己所在的面板 = 无操作（不做原地重排）", async () => {
    await armDrop();
    const m = mount();
    fireDrag("drop", document, selfGroupDt(1, 2), { clientX: 200, clientY: 150 });
    expect(m.onMergeGroup).not.toHaveBeenCalled();
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("单标签拖到另一面板 → 走 onDropTabToPanel（老路径没被整组改到）", async () => {
    await armDrop();
    const m = mount([{ name: "a.md", active: true }]);
    const dt = dragStartFrom(m.strips[0].querySelector<HTMLElement>(".tab")!);
    fireDrag("drop", document, dt, { clientX: 600, clientY: 150 });
    expect(m.onDropTabToPanel).toHaveBeenCalled();
    expect(m.onDropTabToPanel.mock.calls[0][0], "带的是被拖标签的 id").toBe(11);
    expect(m.onMergeGroup).not.toHaveBeenCalled();
  });

  it("落在面板之外（面板间的空隙）→ 什么都不做，也不许回落", async () => {
    await armDrop();
    const m = mount();
    const dt = selfGroupDt(1, 2);
    const e = fireDrag("drop", document, dt, { clientX: 399, clientY: 500 });
    expect(e.defaultPrevented, "是我们的拖拽就得拦，免得浏览器按默认动作处理").toBe(true);
    expect(m.onMergeGroup).not.toHaveBeenCalled();
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
    expect(m.onDropTabToPanel).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ B72 整组影像
// 用户反馈：「面板整体拖拽时，随鼠标拖动的图案优化下，尤其是面板包含多个标签时，
// 可以参考 vscode。」—— 旧实现克隆整条标签栏（裁掉尾部 / 不裁就盖住落点），
// B72 改成 VS Code 的**聚合药丸**（`editorTabsControl.ts:489-494` 的
// `{活动标签名} (+{其余数量})` + `applyDragImage` 的 `.monaco-drag-image`）。
// B91-2：影像不再自己跟光标，而是交给系统绘制；**长什么样（药丸文案与锚点）没变**。

describe("B72 整组影像 = 聚合药丸", () => {
  function pill(strip: HTMLElement): HTMLElement {
    return createGroupDragImage(strip);
  }

  it("报的是**活动**标签名 + 其余数量，不再是整条标签栏的副本", () => {
    const m = mount([{ name: "a.md" }, { name: "b.md", active: true }, { name: "c.md" }]);
    const g = pill(m.strips[0]);
    expect(g.textContent, "报的是**活动**标签名，不是第一个").toBe("b.md (+2)");
    expect(g.querySelectorAll(".tab").length, "药丸里不该再有标签 DOM 副本").toBe(0);
    expect(g.querySelectorAll("[data-tab-id]").length, "更不该带 tabId").toBe(0);
  });

  it("名字与计数分成两个 span：超长文件名被省略号截断时，计数必须还在", () => {
    // ⚠️ 这是有意偏离 VS Code 的一处：它把「名字 (+N)」当一个字符串，
    //    `max-width` 截断会**连计数一起吃掉**，而「一共几个」才是整组影像唯一
    //    不可替代的信息。所以名字可截断、计数不可截断。
    const m = mount([
      { name: "2026-09-18-很长的设计文档名字草稿.markdown", active: true },
      { name: "b.md" },
    ]);
    const g = pill(m.strips[0]);
    const nameEl = g.querySelector<HTMLElement>(".tab-drag-ghost-name");
    const countEl = g.querySelector<HTMLElement>(".tab-drag-ghost-count");
    expect(nameEl, "名字 span").not.toBeNull();
    expect(countEl, "计数 span").not.toBeNull();
    expect(nameEl!.textContent).toBe("2026-09-18-很长的设计文档名字草稿.markdown");
    expect(countEl!.textContent).toBe(" (+1)");
  });

  it("只有一个标签时不带计数（同 VS Code 的 count > 1 判据）", () => {
    const m = mount([{ name: "a.md", active: true }]);
    expect(pill(m.strips[0]).textContent).toBe("a.md");
  });

  it("标签名读不出来时也别给一颗空药丸（至少把数量说清楚）", () => {
    const m = mount([{ name: "" }, { name: "", active: true }]);
    expect(pill(m.strips[0]).textContent).toBe("2 个标签");
  });

  it("锚点分档：药丸内缩 10px、单标签贴左上角（VS Code 的两处 setDragImage）", () => {
    expect(GROUP_IMAGE_ANCHOR, "药丸：指针落在内部靠左上（setDragImage(pill, -10, -10)）").toEqual({
      x: 10,
      y: 10,
    });
    expect(TAB_IMAGE_ANCHOR, "单标签：左上角顶到指针（setDragImage(tab, 0, 0)）").toEqual({
      x: 0,
      y: 0,
    });
  });

  it("单标签影像仍是标签副本，且剥掉了 tabId 与提示接线", () => {
    const m = mount([{ name: "a.md", active: true }]);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    const g = createTabDragImage(tab);
    expect(g.classList.contains("tab-drag-ghost-group"), "单标签不是药丸").toBe(false);
    expect(g.querySelectorAll(".tab").length, "单标签影像仍是标签副本").toBe(1);
    expect(g.querySelectorAll("[data-tab-id]").length, "副本不得带 tabId").toBe(0);
    expect(g.querySelectorAll("[data-tip]").length, "副本不该带提示接线").toBe(0);
    expect(g.querySelector("button")?.tabIndex, "副本里的按钮不该可聚焦").toBe(-1);
  });
});
