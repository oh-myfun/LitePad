// @vitest-environment jsdom
// B310 · 「打开侧边预览」之后，源码侧滚了、预览侧不动（开关明明亮着）。
//
// 真机 2026-10-20 00:15（v0.21.0，单标签 + 打开侧边预览）那一轮日志的形状：
//
//   23.484 reconcile 在册=P1:editor/doc2, P3:editor/doc2   ← 新那格登记的是**编辑器**面
//   23.978 外发 doc=2 v=1.06 行首@0
//   23.978 帧广播 doc=2 驱动=[P1:editor] … 目标=1
//   23.978 广播写[P3:editor] 目标=1.06 … 落点=1.00          ← 写给了一格 `display:none` 的编辑器
//   …（一路 228 发，全部落在 P3:editor 上，落点恒 1.00）
//   25.663 读可见侧[P3:preview] v=1.00                       ← 用户看得见那一侧从没被写过
//
// 病根不在协调器，在打开侧边预览那条装配顺序：`openPreviewToSide` 走
// `splitPanelWithTab` 的 copy 分支时，副本的 `viewMode` 抄的是**源那一格的**（源码态），
// 于是 `rebuildLayout` → `mountView` 末尾那次 `reconcileSyncRegistrations()` 登记的是编辑器面；
// 之后函数才把 `nt.viewMode = "preview"` 并 `applyPanelMode(np)` 换类 —— **这一换没人再重注册**。
// 结果在册的还是那格被藏起来的编辑器（它 `getV()` 恒 1.0、写进去等于没写），而用户看得见
// 的预览面一个监听都没挂 ⇒ 两个方向都不动。
//
// 同一条纪律 `toggleViewMode` 早就有了（`markdown.ts` 末尾那一发 reconcile，B285 那一族）；
// 这一支是它唯一的漏网出口。真机验证台的宿主 `addPreviewPanel` 直接按预览态建格、
// 又自己补了一发 reconcile —— 宿主比生产更正确，正是这一路一直没被台子抓到的原因。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { docSyncModes, docs, panels, tabs, type Panel, type Tab } from "../src/core/app-state";
import type { PreviewBlockGeom, PreviewScrollSurface } from "../src/sync-scroll/preview";
import {
  landVisibleSideAtV,
  readVisibleV,
  reconcileSyncRegistrations,
  syncCoordinator,
} from "../src/sync-scroll/wire";

const DOC = 12;
const nextFrame = () => new Promise((r) => setTimeout(r, 1));

/** 编辑器面：一行 10px、40 行、写得动也读得回（`getBoundingClientRect` 不给 ⇒ 只按 v 走）。 */
function fakeEditor(lines = 40) {
  const scrollDOM = document.createElement("div");
  let top = 0;
  Object.defineProperty(scrollDOM, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (x: number) => {
      top = Math.max(0, Math.min(x, lines * 10));
    },
  });
  const view = {
    scrollDOM,
    lineBlockAtHeight: (h: number) => {
      const from = Math.floor(h / 10) * 10;
      return { from, top: from, height: 10 };
    },
    lineBlockAt: (from: number) => ({ from, top: from, height: 10 }),
    state: {
      doc: {
        lines,
        line: (n: number) => ({ from: (n - 1) * 10 }),
        lineAt: (p: number) => ({ number: Math.floor(p / 10) + 1 }),
      },
    },
  };
  return { scrollDOM, view };
}

/** 预览面：两块、几何已量出来（`hasPosition()` 说得出数，不是那个兜底 1.0）。 */
function fakePreview() {
  const root = document.createElement("div");
  let top = 0;
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (x: number) => {
      top = Math.max(0, x);
    },
  });
  Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
  const blocks: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 10, top: 0, height: 100 },
    { lineStart: 11, lineEnd: 30, top: 100, height: 1000 },
  ];
  const surface: PreviewScrollSurface = {
    root,
    blocks: () => blocks,
    schedule: (fn) => fn(),
  };
  return { root, preview: { root, scrollSurface: () => surface } };
}

/**
 * 一格面板的形状与生产 `mountView` 一致：编辑器面与预览面**同时存在**，
 * 谁看得见只由 `tab.viewMode` 说了算（`sideOfPanel` 读的就是它）。
 */
function mountPanel(panelId: number, tabId: number, viewMode: "source" | "preview"): Panel {
  tabs.set(tabId, {
    tabId,
    docId: DOC,
    panelId,
    viewMode,
    scrollV: 1,
  } as unknown as Tab);
  const e = fakeEditor();
  const p = fakePreview();
  const bodyEl = document.createElement("div");
  bodyEl.className = `panel-host mode-${viewMode}`;
  const panel = {
    panelId,
    tabs: [tabId],
    activeTabId: tabId,
    viewTabId: tabId,
    view: { view: e.view },
    preview: p.preview,
    previewTimer: null,
    bodyEl,
  } as unknown as Panel;
  panels.set(panelId, panel);
  return panel;
}

/** 生产 `applyPanelMode` 落到 DOM 的那一步（换 `mode-*` 类）；jsdom 里没人读它，照抄形状。 */
function applyModeClass(panel: Panel, mode: string): void {
  panel.bodyEl?.classList.remove("mode-source", "mode-split", "mode-preview");
  panel.bodyEl?.classList.add(`mode-${mode}`);
}

beforeEach(() => {
  panels.clear();
  tabs.clear();
  docs.clear();
  docSyncModes.clear();
  docs.set(DOC, { docId: DOC, name: "todo.md", path: `/tmp/todo.md` } as never);
  syncCoordinator.setEnabled(String(DOC), true);
});
afterEach(() => {
  panels.clear();
  tabs.clear();
  docs.clear();
  docSyncModes.clear();
});

describe("B310 · 打开侧边预览之后，两侧必须互相跟得上", () => {
  /**
   * 复刻 `openPreviewToSide` 的「右侧没有面板」那一支：
   * 副本先按源的 `viewMode`（源码态）建格并重建挂载（末尾 reconcile），**然后**才后置 preview。
   *
   * ⚠️ 这一支的调用顺序由**宿主抄写**，生产 `openPreviewToSide` 本身在 jsdom 里跑不动
   * （要真的 `rebuildLayout` + CM6 + 布局树）。所以「生产到底有没有这一发」不归本文件判 ——
   * 那是 `sync-scroll-sequence.test.ts` 的序列契约。本文件钉的是**这几发值不值钱**：
   * 走同一条生产链（`reconcileSyncRegistrations` + 两个真锚点 + 协调器账本），
   * 只把「后置 preview 之后补不补落位 / 重注册」这两个变量拨来拨去。
   */
  async function openSidePreview(opts: {
    reconcileAfterFlip: boolean;
    landAfterFlip?: boolean;
    srcScrollTop?: number;
  }): Promise<{ src: Panel; side: Panel }> {
    const { reconcileAfterFlip, landAfterFlip = false, srcScrollTop = 0 } = opts;
    const src = mountPanel(1, 101, "source");
    const side = mountPanel(2, 102, "source"); // copy 分支：inst.viewMode = tab.viewMode
    // 源先被滚到某处，再点「打开侧边预览」：`splitPanelWithTab` 的 copy 分支会按当下可见侧
    // 取一次实时 v 种进副本（`tab.scrollV = live` → `inst.scrollV = tab.scrollV`，B259）。
    faces(src).editor.scrollTop = srcScrollTop;
    const seed = readVisibleV(src) ?? 1;
    tabs.get(102)!.scrollV = seed;
    // mountView：把种子扶到**此刻可见**那一侧（还是源码态 ⇒ 扶的是编辑器），然后 reconcile。
    landVisibleSideAtV(side, tabs.get(102)!.scrollV);
    reconcileSyncRegistrations();
    const tab = tabs.get(102)!;
    tab.viewMode = "preview"; // ⚠️ 后置
    applyModeClass(side, "preview"); // applyPanelMode(np)
    if (landAfterFlip) landVisibleSideAtV(side, tab.scrollV);
    if (reconcileAfterFlip) reconcileSyncRegistrations();
    return { src, side };
  }

  const faces = (p: Panel) => ({
    editor: (p.view as never as { view: { scrollDOM: HTMLElement } }).view.scrollDOM,
    preview: (p.preview as never as { root: HTMLElement }).root,
  });

  it("滚源码侧 ⇒ 看得见的预览侧跟着走（而不是写给那格被藏起来的编辑器）", async () => {
    const { src, side } = await openSidePreview({ reconcileAfterFlip: true });
    const editor = faces(src).editor;
    const hiddenEditor = faces(side).editor;
    const shownPreview = faces(side).preview;

    editor.scrollTop = 200; // 源码侧滚到 v=21
    editor.dispatchEvent(new Event("scroll"));
    await nextFrame();

    expect(
      shownPreview.scrollTop,
      "预览侧一个像素都没动 ⇒ 用户报的「没有同步滚动」",
    ).toBeGreaterThan(0);
    expect(hiddenEditor.scrollTop, "在册的必须是可见面，被藏起来那一侧不该再收到写").toBe(0);
  });

  it("滚预览侧 ⇒ 源码侧也跟着走（预览面得挂着监听，否则它连「有人滚了」都发不出去）", async () => {
    const { src, side } = await openSidePreview({ reconcileAfterFlip: true });
    const shownPreview = faces(side).preview;
    const srcEditor = faces(src).editor;

    shownPreview.scrollTop = 500;
    shownPreview.dispatchEvent(new Event("scroll"));
    await nextFrame();

    expect(srcEditor.scrollTop, "预览侧滚了源码侧不动 ⇒ 同一件事的反方向").toBeGreaterThan(0);
  });

  // 留案（B310 的病形，2026-10-20 00:15 真机 228 发 `广播写[P3:editor] … 落点=1.00`）：
  // 少掉那一发重注册，在册的就是一格 `display:none` 的编辑器 —— 它写得进像素、
  // 却永远读不出位置（恒 1.0），而看得见那份预览一个监听都没挂，两个方向都静。
  // 这条不是「顺手记个历史」：它证明上面两条断言量的确实是这个变量，不是恒真。
  it("留案 · 后置 preview 却不重注册 ⇒ 复现用户报的「开关亮着但两侧都不动」", async () => {
    const { src, side } = await openSidePreview({ reconcileAfterFlip: false });
    const editor = faces(src).editor;
    const hiddenEditor = faces(side).editor;
    const shownPreview = faces(side).preview;

    editor.scrollTop = 200;
    editor.dispatchEvent(new Event("scroll"));
    await nextFrame();

    expect(shownPreview.scrollTop, "看得见那一侧本该跟着动").toBe(0);
    expect(
      hiddenEditor.scrollTop,
      "写全落进了被藏起来那一侧（真机那个恒 1.00 的落点）",
    ).toBeGreaterThan(0);

    shownPreview.scrollTop = 500;
    shownPreview.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(
      faces(src).editor.scrollTop,
      "预览面没在册 ⇒ 它连「有人滚了」都发不出去",
    ).toBeLessThanOrEqual(200);
  });

  // 同一条装配顺序的第二发：副本的 `scrollV` 种子（`split.ts` 为 B259 埋的那一句）是被
  // `mountView` 扶到**当时可见**那一侧的 —— 那一刻还是源码态，扶的是编辑器；随后才后置
  // preview，于是用户看见的预览停在顶部。B259 那句「打开侧边预览要出现在用户此刻看到的
  // 那一处」在这条分支上一直是空的。
  it("后置 preview 之后，新那格的**可见侧**要落在副本继承来的位置上", async () => {
    const { src, side } = await openSidePreview({
      reconcileAfterFlip: true,
      landAfterFlip: true,
      srcScrollTop: 200,
    });
    expect(faces(src).editor.scrollTop, "前提：源码侧停在 v=21（200px）").toBe(200);
    expect(
      faces(side).preview.scrollTop,
      "预览侧停在顶部 ⇒ 打开那一瞬间两侧对不上",
    ).toBeGreaterThan(0);
  });

  // 留案（上一条的反面，同一处少一步）：只重注册不落位 ⇒ 种子还挂在已经被藏起来的编辑器上，
  // 预览停在文档顶部。`split.ts` 里那句「不带这一句，新格永远从顶部起步（B259）」当时是
  // 靠 mountView 兑现的，而 mountView 跑在 `viewMode = "preview"` **之前**。
  it("留案 · 后置 preview 只重注册、不落位 ⇒ 新那格停在顶部", async () => {
    const { side } = await openSidePreview({
      reconcileAfterFlip: true,
      srcScrollTop: 200,
    });
    expect(faces(side).editor.scrollTop, "种子落在了源码态那一侧（随后被藏起来）").toBe(200);
    expect(faces(side).preview.scrollTop, "看得见那一侧没人给它落位").toBe(0);
  });
});
