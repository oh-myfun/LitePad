// @vitest-environment jsdom
// 大纲跳转/转到行时预览态面板的滚动同步与定位精度
// 回归 1：分屏时预览的那块不跟随 toc 跳转（原只广播选区，预览不动）
// 回归 2：位置不准——syncToLine 原先用 el.offsetTop，基准是外层定位面板
//         （含标签栏）→ 带几十像素常量偏移；现改用相对预览容器的 rect 差值，
//         并在异步增强/图片 load 后按 pending 行重定位。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PreviewPane } from "../src/markdown/preview";

// 模拟真实浏览器的 rect 语义：
// - 每个 block 在**内容坐标**里的偏移固定（contentTops）
// - rect.top = contentTop - 容器当前 scrollTop + 容器相对视口的偏移(40)
// - 容器自身 rect.top 恒为 40
const contentTops = new WeakMap<Element, number>();
const CONTAINER_TOP = 40;
let curRoot: HTMLElement | null = null;

function installRectStub(): () => void {
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (curRoot && this === curRoot) {
      return {
        left: 0,
        top: CONTAINER_TOP,
        right: 0,
        bottom: CONTAINER_TOP,
        width: 0,
        height: 0,
        x: 0,
        y: CONTAINER_TOP,
        toJSON() {},
      } as DOMRect;
    }
    const ct = contentTops.get(this) ?? 0;
    const off = curRoot ? curRoot.scrollTop : 0;
    const top = ct - off + CONTAINER_TOP;
    return {
      left: 0,
      top,
      right: 0,
      bottom: top,
      width: 0,
      height: 0,
      x: 0,
      y: top,
      toJSON() {},
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = orig;
  };
}

/** block 桩：内容坐标偏移 + 模拟 offsetTop（基准为外层定位祖先，多 40px）。 */
function fakeBlock(lineStart: number, lineEnd: number, contentTop: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "md-block";
  el.dataset.lineStart = String(lineStart);
  el.dataset.lineEnd = String(lineEnd);
  contentTops.set(el, contentTop);
  Object.defineProperty(el, "offsetTop", { value: contentTop + CONTAINER_TOP });
  return el;
}

let restore: () => void;
beforeAll(() => {
  restore = installRectStub();
  // @ts-expect-error 测试环境补丁（applyPending 用 rAF）
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
});
afterAll(() => restore());

/** 与 paneWithBlocks 完全等价的 MdBlock 列表（html 一致 → 重渲染时节点复用）。 */
function mdBlocks(): { lineStart: number; lineEnd: number; html: string }[] {
  return [
    { lineStart: 1, lineEnd: 3, html: "b0" },
    { lineStart: 4, lineEnd: 9, html: "b1" },
    { lineStart: 10, lineEnd: 20, html: "b2" },
  ];
}

function paneWithBlocks(): { pane: PreviewPane; root: HTMLElement; els: HTMLElement[] } {
  const pane = new PreviewPane();
  const els = [fakeBlock(1, 3, 0), fakeBlock(4, 9, 100), fakeBlock(10, 20, 300)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pane as any).blocks = els.map((el, i) => ({ html: mdBlocks()[i].html, el }));
  pane.root.replaceChildren(...els);
  curRoot = pane.root;
  return { pane, root: pane.root, els };
}

/** 改变某 block 在内容坐标里的高度位置（模拟图片/公式加载后的重排）。 */
function moveBlock(el: HTMLElement, contentTop: number): void {
  contentTops.set(el, contentTop);
}

describe("PreviewPane.syncToLine 定位精度", () => {
  it("以预览容器为基准（不受外层定位祖先的常量偏移影响）", () => {
    const { pane, root } = paneWithBlocks();
    // 行 4 → block(4..9)：rectTop 140 - 容器 40 = 100 → scrollTop = 92
    pane.syncToLine(4);
    expect(root.scrollTop).toBe(100 - 8);
    // 行 1 → 第一块：0 → max(0, -8) = 0
    pane.syncToLine(1);
    expect(root.scrollTop).toBe(0);
    // 行 12 → 第三块：340-40=300 → 292
    pane.syncToLine(12);
    expect(root.scrollTop).toBe(300 - 8);
  });

  it("block 内按行比例插值", () => {
    const { pane, root } = paneWithBlocks();
    // 行 5 → block(4..9) 跨度 6 行，下一块相对偏移 300-100=200
    // top = 100 + 200*(5-4)/6 ≈ 133.3 → scrollTop ≈ 125.3
    pane.syncToLine(5);
    expect(root.scrollTop).toBeCloseTo(100 + (200 * 1) / 6 - 8, 0);
  });

  it("已滚动的容器按内容坐标计算（scrollTop 补偿）", () => {
    const { pane, root } = paneWithBlocks();
    root.scrollTop = 50; // 先滚到中间再跳转
    pane.syncToLine(4);
    expect(root.scrollTop).toBe(100 - 8);
  });
});

describe("异步重定位（pending）", () => {
  it("图片 load 后按目标行重新定位，不被异步布局变化带走", async () => {
    const { pane, root, els } = paneWithBlocks();
    pane.syncToLine(12);
    expect(root.scrollTop).toBe(300 - 8);
    // 异步：图片加载让前面的块变高（目标块内容偏移下移 80）
    moveBlock(els[2], 380);
    const img = document.createElement("img");
    els[0].appendChild(img);
    img.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.scrollTop, "load 后应重定位到新的目标块位置").toBe(380 - 8);
  });

  it("用户手动滚动预览后取消待重定位", async () => {
    const { pane, root, els } = paneWithBlocks();
    pane.setHost({ topVisibleLine: () => 4, scrollToLine: () => {}, lineCount: () => 20 });
    pane.syncToLine(12);
    await new Promise((r) => setTimeout(r, 150)); // 等同步锁过期
    root.scrollTop = 10;
    root.dispatchEvent(new Event("scroll"));
    moveBlock(els[2], 900);
    const img = document.createElement("img");
    els[0].appendChild(img);
    img.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.scrollTop, "手动滚动后不应被拉回").toBe(10);
  });
});

describe("重渲染不丢失滚动位置（B23）", () => {
  it("内容未变的重渲染保持 scrollTop，不弹回文档开头", () => {
    const { pane, root } = paneWithBlocks();
    pane.syncToLine(12);
    expect(root.scrollTop).toBe(300 - 8);
    // 同内容重渲染（replaceChildren 会把 scrollTop 清零）→ 必须原地恢复
    pane.setBlocks(mdBlocks(), { enhanced: false });
    expect(root.scrollTop, "重渲染后应仍在原位置").toBe(300 - 8);
  });

  it("重渲染时若带待定位行，立即落到目标行（不等 rAF）", () => {
    const { pane, root } = paneWithBlocks();
    pane.syncToLine(12);
    pane.setBlocks(mdBlocks(), { enhanced: false });
    expect(root.scrollTop, "setBlocks 内应立刻按目标行定位").toBe(300 - 8);
  });

  it("内容变化后作废旧的待定位行，不再把视图拽回历史跳转点", () => {
    const { pane, root } = paneWithBlocks();
    pane.syncToLine(12);
    expect(root.scrollTop).toBe(300 - 8);
    // 文本真的变了 → 旧行号失去意义
    const changed = mdBlocks();
    changed[0] = { lineStart: 1, lineEnd: 3, html: "<p>edited</p>" };
    pane.setBlocks(changed, { enhanced: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pane as any).pendingSyncLine, "内容变化应清空 pending").toBeNull();
    root.scrollTop = 0;
    root.dispatchEvent(new Event("scroll"));
    // 之后任何重排都不应再拉回第 12 行
    const img = document.createElement("img");
    pane.root.querySelector(".md-block")!.appendChild(img);
    img.dispatchEvent(new Event("load"));
    expect(root.scrollTop, "不得被历史跳转点拽走").toBe(0);
  });

  it("程序滚动的 scroll 回执即便在锁过期后到达，也不会清掉待定位行", async () => {
    const { pane, root } = paneWithBlocks();
    pane.setHost({ topVisibleLine: () => 4, scrollToLine: () => {}, lineCount: () => 20 });
    pane.syncToLine(12);
    await new Promise((r) => setTimeout(r, 150)); // 让同步锁过期
    // 重渲染把 scrollTop 清零后立刻恢复 → 浏览器随后补发一次 scroll 事件，
    // 位置与程序设定值一致，必须认领为自家滚动而不是用户滚动
    pane.setBlocks(mdBlocks(), { enhanced: false });
    root.dispatchEvent(new Event("scroll"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pane as any).pendingSyncLine, "自家滚动回执不得清掉 pending").toBe(12);
    expect(root.scrollTop).toBe(300 - 8);
  });
});

describe("预览同步接线（静态断言）", () => {
  it("main.ts 的大纲跳转/转到行必须对预览态实例显式 syncToLine", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "大纲 onJump 需按 viewMode===preview 调 syncToLine").toMatch(
      /viewMode === "preview"\)?\s*(panel\.preview|p\.preview)\?\.syncToLine/,
    );
    expect(src, "转到行也需同步预览").toContain("panel.preview?.syncToLine(target)");
  });

  it("md 预览重渲染必须由「文本真的变了」门控（B23：否则跳转落点被冲掉）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/main.ts", "utf-8");
    // 仅改选区/点击也会触发 update → 若按任意 update 排程重渲染，
    // 大纲跳转后 120ms 的 replaceChildren 会把预览 scrollTop 清零。
    expect(src, "scheduleMdRender 调用必须由 textChanged 门控").toMatch(
      /if \(textChanged && isMdTab\(tab\)\) scheduleMdRender\(/,
    );
    expect(src, "不得再出现「任意 update 都重渲染预览」的写法").not.toMatch(
      /\n\s*if \(isMdTab\(tab\)\) scheduleMdRender\(/,
    );
  });

  it("syncToLine 必须相对预览容器计算（不得直接用 offsetTop 当内容偏移）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/markdown/preview.ts", "utf-8");
    expect(src, "应有 blockTop 相对坐标辅助").toContain("private blockTop(");
    expect(src, "blockTop 用 rect 差值而非 offsetTop").toMatch(
      /getBoundingClientRect\(\)\.top - base\.top/,
    );
    expect(src, "应有 pending 重定位").toContain("pendingSyncLine");
  });
});
