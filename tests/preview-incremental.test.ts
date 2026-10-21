// @vitest-environment jsdom
// B319-A2 岛级就地增量：未变的岛必须**不被摘走**，这样里面已做好的 KaTeX / Shiki /
// Mermaid 结果与 <img> 解码才能活过一次重画。jsdom 没有布局，所以这里只测节点身份。
import { describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ childCountAtClaim: [] as number[] }));

vi.mock("../src/sync-scroll/wire", () => ({
  syncCoordinator: {
    // 认领的第一个实参就是滚动面本体（PreviewPane.root），就地数它的岛，
    // 不去数整份文档 —— 同一文件里多个 pane 都挂在 body 上。
    expectSurfaceV: vi.fn((surface: HTMLElement) => {
      ledger.childCountAtClaim.push(surface.querySelectorAll(".md-block").length);
    }),
  },
  PreviewScrollAnchor: class {
    getV() {
      return 1;
    }
    setV() {}
  },
}));

import { PreviewPane } from "../src/markdown/preview";
import type { MdBlock } from "../src/markdown/pipeline";

function bk(html: string, lineStart: number, lineEnd = lineStart): MdBlock {
  return { html, lineStart, lineEnd };
}

const A = "<p>甲</p>";
const B = "<p>乙</p>";
const C = "<p>丙</p>";
const X = "<p>新插入的一段</p>";

function islands(p: PreviewPane): HTMLElement[] {
  return Array.from(p.root.querySelectorAll(".md-block"));
}

/** 挂到 document 上：`isConnected` 在脱离文档的容器里恒 false，那样断言等于没测。 */
function mkPane(): PreviewPane {
  const p = new PreviewPane();
  document.body.append(p.root);
  return p;
}

describe("预览岛级增量（B319-A2）", () => {
  it("中间插入一段：其后各岛必须是同一批节点对象", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)]);
    const [a, b, c] = islands(p);
    p.setBlocks([bk(A, 1), bk(X, 3), bk(B, 5), bk(C, 7)]);
    const now = islands(p);
    expect(now[0]).toBe(a);
    expect(now[2]).toBe(b);
    expect(now[3]).toBe(c);
    expect(now[1].textContent).toBe("新插入的一段");
  });

  it("判据只比 html：行号漂移不重建，但 data-line* 跟着刷新", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3)]);
    const [a] = islands(p);
    p.setBlocks([bk(A, 4), bk(B, 6)]);
    const now = islands(p);
    expect(now[0]).toBe(a);
    expect(now[0].dataset.lineStart).toBe("4");
    expect(now[1].dataset.lineStart).toBe("6");
  });

  it("复用岛的子树一个字都没被碰（增强结果活得下来）", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)]);
    const b = islands(p)[1];
    const marker = document.createElement("span");
    marker.dataset.marker = "1";
    b.querySelector("p")!.append(marker);
    b.dataset.highlighted = "1"; // 模拟 Shiki 已高亮过
    p.setBlocks([bk(A, 1), bk(X, 3), bk(B, 5), bk(C, 7)]);
    const b2 = islands(p)[2];
    expect(b2).toBe(b);
    expect(marker.isConnected, "标记子节点被摘掉了 ⇒ 增强结果会重跑").toBe(true);
    expect(b2.dataset.highlighted).toBe("1");
  });

  it("删除首段：其余岛保持原节点，顺序与 list 一致", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)]);
    const [, b, c] = islands(p);
    p.setBlocks([bk(B, 1), bk(C, 3)]);
    const now = islands(p);
    expect(now.length).toBe(2);
    expect(now[0]).toBe(b);
    expect(now[1]).toBe(c);
    expect(now[0].dataset.lineStart).toBe("1");
  });

  it("写完 scrollTop 之后、setBlocks 返回之前，同栈向账本认领", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3)]);
    ledger.childCountAtClaim.length = 0;
    p.setBlocks([bk(A, 1), bk(X, 3), bk(B, 5)]);
    expect(ledger.childCountAtClaim.length, "一次渲染应认领一发写位").toBe(1);
    // 认领发生在同步栈内：那时 DOM 已经是新形状（3 个岛），不是旧形状（2 个）。
    expect(ledger.childCountAtClaim[0]).toBe(3);
  });

  it("空文档把岛清零；提示条不是岛，重渲染后仍排在最后", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1)]);
    p.setBlocks([]);
    expect(islands(p).length).toBe(0);
    p.setNotice("大文档已停用自动预览");
    const notice = p.root.querySelector(".md-preview-notice");
    p.setBlocks([bk(B, 1)]);
    expect(notice?.isConnected, "notice 被整容器重建摘掉了").toBe(true);
    expect(p.root.lastElementChild, "岛必须插在 notice 之前").toBe(notice);
    expect(islands(p).length).toBe(1);
  });

  it("只改末段文字：前面所有岛原节点、末段换新节点", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)]);
    const [a, b, c] = islands(p);
    p.setBlocks([bk(A, 1), bk(B, 3), bk("<p>丙改</p>", 5)]);
    const now = islands(p);
    expect(now[0]).toBe(a);
    expect(now[1]).toBe(b);
    expect(now[2]).not.toBe(c);
    expect(now[2].textContent).toBe("丙改");
  });

  it("文档内容一行都没变时不新建任何岛", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3)]);
    const before = islands(p);
    p.setBlocks([bk(A, 1), bk(B, 3)]);
    expect(islands(p).map((el) => before.indexOf(el))).toEqual([0, 1]);
  });
});
