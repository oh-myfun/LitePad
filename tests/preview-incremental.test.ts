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

vi.mock("../src/ipc/api", () => ({
  assocList: () => Promise.resolve([]),
  assocSet: (ext: string, on: boolean) =>
    Promise.resolve({ ext, registered: on, isDefault: false }),
  assocOpenSystemSettings: () => Promise.resolve(),
  // 生产 Windows 上 convertFileSrc 给的是 `http://asset.localhost/…`（带 http: 前缀），
  // 正好落进「已经是绝对地址 ⇒ 不再重算」那条守卫 —— 这正是 I5 的坑，替身照实写。
  convertFileSrc: (p: string) => `http://asset.localhost/${p.replace(/[\\/]/g, "/")}`,
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
    // 行区间刻意做成「起点 ≠ 终点」：只断 lineStart 的话，漏刷 lineEnd 也能全绿，
    // 而末块按行均分与 A3 落点吃的正是 lineEnd（评审 M2）。
    p.setBlocks([bk(A, 1, 2), bk(B, 3, 5)]);
    const [a] = islands(p);
    p.setBlocks([bk(A, 4, 5), bk(B, 6, 9)]);
    const now = islands(p);
    expect(now[0]).toBe(a);
    expect(now[0].dataset.lineStart).toBe("4");
    expect(now[0].dataset.lineEnd).toBe("5");
    expect(now[1].dataset.lineStart).toBe("6");
    expect(now[1].dataset.lineEnd).toBe("9");
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

  // ↓↓ 评审补的两形：删除的两种形状。插入那一形早就钉住了，删除没有 ——
  // 而「把该留的岛删掉 / 把新岛插错位置」恰恰只在删除时才会露出来。
  it("删除中间一块：其余岛仍是同一批节点，且新块（若有）插在正确位置", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)]);
    const [a, , c] = islands(p);
    const bEl = islands(p)[1];
    p.setBlocks([bk(A, 1), bk(C, 3)]);
    const now = islands(p);
    expect(now.length).toBe(2);
    expect(now[0]).toBe(a);
    expect(now[1]).toBe(c);
    expect(bEl.isConnected, "被删的那块还挂在 DOM 上").toBe(false);
    // 再走一形：删中间一块的同时末尾多出一块 ⇒ 新岛必须排在复用岛之后
    p.setBlocks([bk(A, 1), bk(C, 3), bk(X, 5)]);
    const now2 = islands(p);
    expect(now2[0]).toBe(a);
    expect(now2[1]).toBe(c);
    expect(now2[2].textContent).toBe("新插入的一段");
  });

  it("删除末尾一块：剩下的岛不动，也不许有岛被挪到容器末尾之后", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)]);
    const [a, b] = islands(p);
    p.setNotice("提示条");
    p.setBlocks([bk(A, 1), bk(B, 3)]);
    const now = islands(p);
    expect(now.length).toBe(2);
    expect(now[0]).toBe(a);
    expect(now[1]).toBe(b);
    expect(p.root.lastElementChild?.className).toBe("md-preview-notice");
  });

  // 评审争的那一条：`contentChanged` 是不是死代码。用两侧断言把它钉住 ——
  // 内容变了必须**作废**待定位行（否则下一发被旧行号拽走），内容没变必须**仍然**照它重定位。
  // 只断言前者就是空转：桩永远不被调用它也是绿。
  it("开头插入一段 ⇒ 待定位行作废；内容一字没改 ⇒ 仍按待定位行重定位", () => {
    const mkWithPending = (list: MdBlock[]) => {
      const p = mkPane();
      p.setBlocks(list);
      const calls: number[] = [];
      const hole = p as unknown as {
        pendingSyncLine: number | null;
        applySyncToLine: (n: number) => void;
      };
      hole.applySyncToLine = (n: number) => void calls.push(n);
      hole.pendingSyncLine = 5;
      return { p, calls };
    };
    const a = mkWithPending([bk(A, 1), bk(B, 3)]);
    a.p.setBlocks([bk(X, 1), bk(A, 3), bk(B, 5)]); // 开头多了一段
    expect(a.calls, "内容变了还照旧行号重定位 ⇒ 预览会被拽到很久以前跳转过的那行").toEqual([]);

    const b = mkWithPending([bk(A, 1), bk(B, 3)]);
    b.p.setBlocks([bk(A, 1), bk(B, 3)]); // 一字没改
    expect(b.calls, "内容没改时待定位行必须仍然生效").toEqual([5]);
  });

  // B288 血泪纪律的顺序判据：`scrollTop` 必须**动手之前**读。摘掉末块会让浏览器当场把
  // scrollTop 按新的 scrollHeight 裁小，删完再读拿到的是「已经跳了的位置」，扶回去等于没扶。
  // jsdom 没有布局，所以这里给 scrollTop 装一个记账门面，直接断言事件顺序。
  it("读 scrollTop 排在摘岛之前（删完再读 = 读到被裁过的位置）", () => {
    const p = mkPane();
    p.setBlocks([bk(A, 1), bk(B, 3), bk(C, 5)], { enhanced: false });
    const [, , last] = islands(p);
    const events: string[] = [];
    Object.defineProperty(p.root, "scrollTop", {
      configurable: true,
      get: () => {
        events.push("read");
        return 42;
      },
      set: () => void events.push("write"),
    });
    const rawRemove = last.remove.bind(last);
    last.remove = () => {
      events.push("remove");
      return rawRemove();
    };
    const rawInsert = p.root.insertBefore.bind(p.root);
    p.root.insertBefore = ((node: Node, ref: Node | null) => {
      events.push("insert");
      return rawInsert(node, ref);
    }) as typeof p.root.insertBefore;

    // 只改末块 ⇒ head=2、tail=0 ⇒ 末岛被摘走、新末岛被插回来
    p.setBlocks([bk(A, 1), bk(B, 3), bk("<p>丙改</p>", 5)], { enhanced: false });

    expect(events.slice(0, 3), `事件序：${events.join(" → ")}`).toEqual([
      "read",
      "remove",
      "insert",
    ]);
  });

  // 评审 I5：A2 把复用命中面从「同下标同 html」放宽到「任意偏移的前缀/后缀」，于是
  // 两份文档共享的头几段会成批复用 —— 复用岛里已被改写成 asset URL 的 <img src>
  // 就带着**上一份文档的目录**活了下来（那条守卫见 `/^(https?:|…)/` 会跳过它）。
  it("换到另一目录的文档：复用岛里的相对图必须按新 baseDir 重算", async () => {
    const settle = async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const p = mkPane();
    const html = '<p><img src="a.png" alt="图"></p>';
    p.setBaseDir("D:\\docs\\one");
    p.setBlocks([bk(html, 1)]);
    await settle();
    const img = p.root.querySelector("img")!;
    expect(img.getAttribute("src"), "首绘就该换成 asset 地址").toContain("docs/one/a.png");

    p.setBaseDir("D:\\docs\\two");
    p.setBlocks([bk(html, 1)]); // 同一份 html ⇒ 这一发是复用岛，enhance 仍要重算 src
    await settle();
    expect(img.getAttribute("src"), "图仍停在上一份文档的目录").toContain("docs/two/a.png");
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
