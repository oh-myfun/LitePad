// @vitest-environment jsdom
// B265 预览底部留白「测量时序」回归测试（独立单测，不依赖整 app）。
//
// 根因：原 `setBlocks` 在 `replaceChildren(frag)` **之前**调 `applyBottomBleed()`，
// 那时末块还在 `DocumentFragment` 里、未挂载 ⇒ `getBoundingClientRect()` 对游离节点
// 恒返 0（真机与 jsdom 一致）⇒ `lastH = 0` ⇒ `--md-bleed-bottom` 永远算成 0 ⇒
// 预览底部永远到不了顶（与源码「最后一行贴容器顶」对不上）。
// 修法：把 `applyBottomBleed()` 移到 `replaceChildren` **之后**（块已挂载，能量出真实高度）。
//
// ⚠️ 这条用例用「连接感知」的 `getBoundingClientRect`：游离节点返 0、挂载节点返 BLOCK。
// 这是真机行为，也是旧 mock（无条件给 .md-block 返 BLOCK）掩盖 bug 的原因 —— 那段 mock
// 让游离节点也返非 0，于是旧代码在测试里「碰巧」算对、真机却错。
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PreviewPane } from "../src/markdown/preview";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const ROW = 14;
const BLOCK = ROW * 3; // 42，末块跨 3 行
const VIEW_H = 60;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    left: 0,
    right: 600,
    bottom: top + height,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

beforeAll(() => {
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  // 连接感知：游离节点（在 DocumentFragment 里、未进文档）高度 0，挂载后高度 BLOCK。
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    if (el.classList.contains("md-block")) {
      const connected = el.isConnected;
      const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
      return rect(connected ? idx * BLOCK : 0, connected ? BLOCK : 0);
    }
    if (el.classList.contains("md-preview")) return rect(0, VIEW_H);
    return rect(0, 0);
  };
});

function sampleBlocks(): { lineStart: number; lineEnd: number; html: string }[] {
  return [
    { lineStart: 1, lineEnd: 1, html: "<h1>标题一</h1>" },
    { lineStart: 2, lineEnd: 2, html: "<h1>标题二</h1>" },
    { lineStart: 3, lineEnd: 5, html: "<p>段落第一行<br>第二行<br>第三行</p>" },
  ];
}

describe("B265 预览底部留白：必须在块挂载后测量", () => {
  it("setBlocks 后 --md-bleed-bottom 非 0 且 = clientHeight − 末块高", () => {
    const pv = new PreviewPane();
    document.body.appendChild(pv.root);
    // 视口高固定为 VIEW_H（jsdom 无布局，手动定义）。
    Object.defineProperty(pv.root, "clientHeight", {
      configurable: true,
      get: () => VIEW_H,
    });
    pv.setBlocks(sampleBlocks());
    const bleed = Number.parseFloat(pv.root.style.getPropertyValue("--md-bleed-bottom")) || 0;
    // 旧代码（replaceChildren 前测量游离节点）⇒ bleed 恒 0 ⇒ 这条断言变红。
    expect(bleed).toBeGreaterThan(0);
    expect(bleed).toBe(VIEW_H - BLOCK);
  });
});
