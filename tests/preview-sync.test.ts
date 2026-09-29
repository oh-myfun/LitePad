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
    await new Promise((r) => setTimeout(r, 20)); // 让这一次定位落定（新方案无时间窗锁）
    // B170：程序定位的标记是「黏性」的，只靠用户接管滚动的真实输入（wheel / 拖滚动条）
    // 清除，不靠时间窗。这里模拟用户接管：先派发 wheel 清掉标记，再手动滚到 10。
    root.dispatchEvent(new Event("wheel"));
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

// B160：跨面板同步滚动（源码面板 → 预览面板）定位时**不许**留下 `pendingSyncLine`。
// 尾巴是给大纲跳转这类一次性目标用的：留着它，之后任意一次图片 / KaTeX / Shiki 增强
// 完成（`applyPending`）或一次重渲染，都会把预览按那个早已过期的行号再拽一次 ——
// 同步滚动每帧都定位，等于每帧往预览里塞一个「待重定位」钩子，抖的就是这个。
describe("B160 程序定位（同步滚动）不留待重定位的尾巴", () => {
  it("尾巴在 ⇒ 异步增强会把预览按目标行拽回去（对照）", async () => {
    const { pane, root, els } = paneWithBlocks();
    pane.syncToLine(12); // 与 `applySyncToSibling` 只差最后那句 clearPendingSync
    expect(root.scrollTop).toBe(300 - 8);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pane as any).pendingSyncLine, "对照：尾巴确实留下了").toBe(12);
    moveBlock(els[2], 380);
    const img = document.createElement("img");
    els[0].appendChild(img);
    img.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.scrollTop, "留着尾巴 ⇒ 增强后重新定位").toBe(380 - 8);
  });

  it("抹掉尾巴 ⇒ 同样的增强不再动预览（同步滚动的落点只算一次）", async () => {
    const { pane, root, els } = paneWithBlocks();
    pane.syncToLine(12);
    pane.clearPendingSync(); // main.ts 的 `applySyncToSibling` 紧跟这一句
    moveBlock(els[2], 380);
    const img = document.createElement("img");
    els[0].appendChild(img);
    img.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.scrollTop, "同步定位不许被异步增强重新定位").toBe(300 - 8);
  });

  it("抹掉尾巴 ⇒ 内容未变的重渲染保持像素，不按行重定位", () => {
    const { pane, root } = paneWithBlocks();
    pane.syncToLine(12);
    root.scrollTop = 305; // 定位之后用户（或同步链路）又挪了一点
    pane.clearPendingSync();
    // 有尾巴时这里会走 `applySyncToLine(pendingSyncLine)` 把位置拽回 292
    pane.setBlocks(mdBlocks(), { enhanced: false });
    expect(root.scrollTop, "重渲染要保持像素，别按旧行号重定位").toBe(305);
  });
});

// B170：同步滚动的程序定位必须与「大纲跳转」分家，且靠显式来源标记挡回执 ——
// ① 不留 pendingSyncLine 尾巴（同步滚动每帧都定位，尾巴＝每帧一个拽回钩子）；
// ② 程序定位前 `markProgrammatic(this.root)`（合成 VS Code 的 `scrollType`）：这一侧的
//    scroll 回执见标记即吞（不比位置、不赌时序、不靠还原窗口，对迟到回执免疫）；
// ③ 标记靠用户接管滚动的真实输入（wheel / 键 / 触 / 拖条）清除，黏性保留到那一刻。
describe("B170 同步滚动的程序定位回执屏蔽", () => {
  it("syncToLineProgrammatic 不留尾巴（落点只算一次，重排不拽回）", async () => {
    const { pane, root, els } = paneWithBlocks();
    pane.syncToLineProgrammatic(12);
    expect(root.scrollTop).toBe(300 - 8);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pane as any).pendingSyncLine, "程序定位不许留尾巴").toBeNull();
    // 同 B160 对照组：增强重排后不许把预览拽回旧行号
    moveBlock(els[2], 380);
    const img = document.createElement("img");
    els[0].appendChild(img);
    img.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.scrollTop, "重排不许按行重定位").toBe(300 - 8);
  });

  it("程序定位后那发 scroll 被吞（黏性标记，回执不当用户滚动）", async () => {
    const { pane, root } = paneWithBlocks();
    let pushed = 0;
    pane.setHost({ topVisibleLine: () => 4, scrollToLine: () => pushed++, lineCount: () => 20 });
    pane.syncToLineProgrammatic(12);
    // 程序钉位的回执：标记是黏性的（不靠计时器 / rAF），监听见标记即吞。
    root.dispatchEvent(new Event("scroll"));
    expect(pushed, "程序定位的 scroll 必须被吞（不反推编辑器）").toBe(0);
  });

  it("标记靠用户接管清除：wheel 之后才允许反推编辑器", async () => {
    const { pane, root } = paneWithBlocks();
    let pushed = 0;
    pane.setHost({ topVisibleLine: () => 4, scrollToLine: () => pushed++, lineCount: () => 20 });
    pane.syncToLineProgrammatic(12);
    // 黏性标记：不靠 rAF / 计时器，只靠真实用户输入清除。
    root.dispatchEvent(new Event("scroll"));
    expect(pushed, "未接管前程序回执仍被吞").toBe(0);
    root.dispatchEvent(new Event("wheel")); // 用户接管滚动 → 清标记
    root.scrollTop = 50;
    root.dispatchEvent(new Event("scroll"));
    expect(pushed, "用户接管后的滚动必须照常同步回编辑器").toBe(1);
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

// B171：编辑器滚动 → 预览跟随（`syncFromEditor`）也必须走「不留尾巴」那支。
// 它是**跟随**路径 —— 编辑器每滚一次就走一次；用留尾巴的 `syncToLine`，等于每次都给
// 后续任意一次图片 / 公式增强或重渲染塞一个「把预览拽回那一行」的钩子。
// 症状：同步滚动时预览被反复拽回（用户报的「抖动还有」）。此前这条路径无任何用例覆盖。
describe("B171 编辑器→预览的跟随也不许留尾巴", () => {
  it("syncFromEditor 定位到位，且不留 pendingSyncLine", () => {
    const { pane, root } = paneWithBlocks();
    pane.setHost({ topVisibleLine: () => 12, scrollToLine: () => {}, lineCount: () => 20 });
    pane.syncFromEditor();
    expect(root.scrollTop, "跟随要真的定位过去").toBe(300 - 8);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pane as any).pendingSyncLine, "跟随定位不许留尾巴").toBeNull();
  });

  it("跟随之后的异步增强不许再把预览拽回那一行", async () => {
    const { pane, root, els } = paneWithBlocks();
    pane.setHost({ topVisibleLine: () => 12, scrollToLine: () => {}, lineCount: () => 20 });
    pane.syncFromEditor();
    expect(root.scrollTop).toBe(300 - 8);
    // 与 B160 对照组同构：异步布局位移 + 一次图片 load ⇒ 留着尾巴就会被拽到 892
    moveBlock(els[2], 900);
    const img = document.createElement("img");
    els[0].appendChild(img);
    img.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(root.scrollTop, "跟随之后不许被增强重新定位").toBe(300 - 8);
  });
});

// B177：跟随坐标带行内比例小数时，预览不许坠到最底部。
// B175 让 `host.topVisibleLine()`（编辑器那侧 `topVisibleLineFrac`）返回带小数行号，经
// `syncFromEditor → syncToLineProgrammatic → applySyncToLine → blockAtLine` 落到预览。
// 旧 `blockAtLine` 的 `line >= s && line <= e` 不匹配小数行号：单/多行块里 `12.3` 既被
// `12.3 <= 12` 判否、又够不到下一块 ⇒ 退回最后一块 ⇒ 预览钉到底（B176 修抖动前被掩盖）。
describe("B177 跟随坐标带小数时预览不许坠底", () => {
  it("单/多行块 + 小数行号命中对应块并按比例插值（不坠底）", () => {
    const pane = new PreviewPane();
    const els = [12, 13, 14, 15].map((ln) => fakeBlock(ln, ln, (ln - 12) * 100));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pane as any).blocks = els.map((el, i) => ({ html: `b${i}`, el }));
    pane.root.replaceChildren(...els);
    curRoot = pane.root;
    // 模拟真实跟随：编辑器那侧带比例的小数行号
    pane.setHost({ topVisibleLine: () => 12.3, scrollToLine: () => {}, lineCount: () => 20 });
    pane.syncFromEditor();
    // 12.3 → 第 12 行块（内容偏移 0），下一块第 13 行（偏移 100），跨 1 行插 0.3
    // top ≈ 30 ⇒ scrollTop = 22（坠底应为 300-8 = 292）
    expect(pane.root.scrollTop, "小数行号要落到对应块、按比例插值，不能坠底").toBeCloseTo(22, 0);
    expect(pane.root.scrollTop, "绝不能是最后一块的底部").toBeLessThan(100);
  });

  it("滚过块尾的带小数行号也落到当前块，不坠到最后一个块", () => {
    const pane = new PreviewPane();
    // 真实段落：块 [4,9] 顶 0 → 块 [10,17] 顶 200 → 块 [18,29] 顶 500（多行块）
    const els = [fakeBlock(4, 9, 0), fakeBlock(10, 17, 200), fakeBlock(18, 29, 500)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pane as any).blocks = els.map((el, i) => ({ html: `b${i}`, el }));
    pane.root.replaceChildren(...els);
    curRoot = pane.root;
    // 编辑器顶行落在第 9 行 50% ⇒ 小数 9.5，已超过块 [4,9] 的 lineEnd
    pane.setHost({ topVisibleLine: () => 9.5, scrollToLine: () => {}, lineCount: () => 40 });
    pane.syncFromEditor();
    // 9.5 → 段落块 [4,9]（顶 0），下一块 [10,17] 顶 200，跨 6 行插 5.5/6
    // top ≈ 183.3 ⇒ scrollTop ≈ 175（坠底应为 500-8 = 492）
    expect(pane.root.scrollTop, "小数行号坠过块尾必须落到当前块，不坠底").toBeCloseTo(175, 0);
    expect(pane.root.scrollTop, "绝不能是最后一块的底部").toBeLessThan(200);
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

describe("B172 预览侧顶行（topVisibleLine / blockAtOffset）", () => {
  it("滚到文档中部：取最后一个顶边不超过 scrollTop+8 的 block", () => {
    const pane = new PreviewPane();
    const tops = [0, 100, 300, 520, 900, 1400, 2100, 3000];
    const lines = [1, 4, 10, 18, 30, 44, 60, 80];
    const els = tops.map((t, i) => fakeBlock(lines[i], lines[i] + 3, t));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pane as any).blocks = els.map((el, i) => ({ html: `b${i}`, el }));
    pane.root.replaceChildren(...els);
    curRoot = pane.root;
    pane.setHost({ topVisibleLine: () => 1, scrollToLine: () => {}, lineCount: () => 100 });
    pane.root.scrollTop = 0;
    // B174 起返回**带行内比例的小数**：+8 的偏移落在第 1 块（0..100）里占 8%，
    // 该块跨 1..3 行（下一块从第 4 行起，range=3）⇒ 1 + 0.08*3 ≈ 1.24
    expect(pane.topVisibleLine()).toBeCloseTo(1.24, 1);
    pane.root.scrollTop = 300; // +8 = 308 ⇒ 命中顶边 300 那块（line 10），不是 520 那块
    expect(pane.topVisibleLine()).toBeCloseTo(10.29, 1);
    pane.root.scrollTop = 899; // 907 ⇒ 命中顶边 900 那块（line 30）
    expect(pane.topVisibleLine()).toBeCloseTo(30.2, 1);
    pane.root.scrollTop = 5000; // 滚过末尾 ⇒ 最后一块（没有下一块，返回行首）
    expect(pane.topVisibleLine()).toBe(80);
  });

  it("顶行映射与按行定位互逆：读出来的行摆回去还落在同一处（B174）", () => {
    const pane = new PreviewPane();
    const tops = [0, 100, 300, 520, 900, 1400, 2100, 3000];
    const lines = [1, 4, 10, 18, 30, 44, 60, 80];
    // 行号区间要**连续**（真实 block 就是首尾相接的）：留空隙的话 line 落在缝里，
    // `blockAtLine` 会退回最后一块，互逆性无从谈起。
    const els = tops.map((t, i) => fakeBlock(lines[i], (lines[i + 1] ?? 101) - 1, t));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pane as any).blocks = els.map((el, i) => ({ html: `b${i}`, el }));
    pane.root.replaceChildren(...els);
    curRoot = pane.root;
    const hostLine = { v: 1 };
    pane.setHost({
      topVisibleLine: () => hostLine.v,
      scrollToLine: () => {},
      lineCount: () => 100,
    });
    for (const px of [0, 120, 307, 900, 2500]) {
      pane.root.scrollTop = px;
      const line = pane.topVisibleLine();
      expect(line, `scrollTop=${px} 要问得出顶行`).not.toBeNull();
      pane.syncToLineProgrammatic(line as number);
      // 互逆：读出的行摆回去，落点回到同一个像素（±1px）
      expect(pane.root.scrollTop, `scrollTop=${px} 读出行 ${line} 摆回去要落在原处`).toBeCloseTo(
        px,
        0,
      );
    }
  });

  it("跟随路径每帧都走它：不许线性扫全表（改二分）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/markdown/preview.ts", "utf-8").replace(/\r\n/g, "\n");
    const at = src.indexOf("private indexOfBlockAtOffset(");
    const body = at >= 0 ? src.slice(at, src.indexOf("\n  }", at)) : "";
    expect(body, "要切到二分查找的函数体").toContain("private indexOfBlockAtOffset(");
    expect(body, "二分取中点").toMatch(/const mid = \(lo \+ hi\) >> 1;/);
    expect(body, "不再逐个 block 摸一遍布局").not.toMatch(/for \(const b of this\.blocks\)/);
  });
});
