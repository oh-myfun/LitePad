// 序列契约：生产函数体与真机宿主的镜像必须同形。
//
// 为什么要单独钉这一层：真机验证台（`scripts/sync-scroll-probe.mjs`）跑的是**宿主**复刻出来的
// 调用序列，宿主 import 的是真实模块，但「切模式 / 重建之后要做哪几步」是宿主手抄的。手抄会漂：
// 生产改了一步、宿主没跟上，台子就变成在测宿主自己的想象 —— 本轮就真遇到过：宿主的 `setMode`
// 比生产的 `toggleViewMode` 多调了一发 reconcile，于是 S13/S14 一直绿着，而线上是坏的。
// 断言的是「这段序列确实存在」，不是行为（行为归台子与 jsdom 用例）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const md = readFileSync("src/markdown.ts", "utf-8");
const life = readFileSync("src/tabs/lifecycle.ts", "utf-8");
const wire = readFileSync("src/sync-scroll/wire.ts", "utf-8");
const syncPreview = readFileSync("src/sync-scroll/preview.ts", "utf-8");
const win = readFileSync("src/multiwindow/windows.ts", "utf-8");
const split = readFileSync("src/tabs/split.ts", "utf-8");
const files = readFileSync("src/io/files.ts", "utf-8");
const host = readFileSync("tests/harness/sync-scroll-harness.ts", "utf-8");

/**
 * 取出某个函数 / 方法体的原文。
 *
 * ⚠️ 不能「从 header 往后找第一个 `{`」就当函数体开头：参数表里写内联对象类型
 * （`function f(payload: { a: number })`）时那个 `{` 先到，配平出来的会是**参数类型**，
 * 于是断言查的是错的文本（本轮就是这么让 applyDocResyncFull 那条契约假失败了一次）。
 * 正解：先把参数表的圆括号配平掉，再取它后面第一个 `{`，然后配平花括号。
 */
function bodyOf(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}`);
  // 从 header 起找**第一个** `(`：header 带不带结尾括号都对（只从 header 末尾之后找的话,
  // `setMode(panelId, mode)` 这种「header 已含参数表」的写法会跳到函数体里第一个括号去,
  // 配平出来的是个 if 块,断言查的又是错文本）。
  const paren = src.indexOf("(", at);
  if (paren < 0) throw new Error(`${header} 后面没有参数表`);
  let pd = 0;
  let i = paren;
  for (; i < src.length; i++) {
    if (src[i] === "(") pd += 1;
    else if (src[i] === ")") {
      pd -= 1;
      if (pd === 0) break;
    }
  }
  // 返回类型是**内联对象**时（`): { a: T } | null {`），参数表后面第一个 `{` 属于类型而不是
  // 函数体 ⇒ 必须配平跳过它再取下一个。`: void {` 那种不算（冒号后第一个非空字符不是 `{`）。
  // 本轮就是被 `faceOf` 的返回类型骗过一次，查错文本还差点以为代码写坏了。
  let open = src.indexOf("{", i + 1);
  const colon = src.indexOf(":", i + 1);
  if (colon >= 0 && colon < open && /^\s*\{/.test(src.slice(colon + 1))) {
    let d = 0;
    for (; open < src.length; open++) {
      if (src[open] === "{") d += 1;
      else if (src[open] === "}") {
        d -= 1;
        if (d === 0) {
          open += 1;
          break;
        }
      }
    }
    open = src.indexOf("{", open);
  }
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  throw new Error(`${header} 的花括号没配平`);
}

describe("切模式序列 · 生产与宿主同形", () => {
  // 顺序本身也是判据：读 v 必须**早于**换类（换完另一侧就 display:none，读不到），
  // 落位必须**晚于** applyPanelMode（隐藏的那一侧写不进去）。
  const seq = [
    "readVisibleV(",
    "applyPanelMode",
    "landVisibleSideAtV(",
    "reconcileSyncRegistrations()",
  ];

  for (const needle of seq) {
    it(`生产 toggleViewMode 里有「${needle}」`, () => {
      expect(bodyOf(md, "function toggleViewMode")).toContain(needle);
    });
    it(`宿主 setMode 镜像里有「${needle}」`, () => {
      expect(bodyOf(host, "setMode(panelId, mode)")).toContain(needle);
    });
  }

  it("生产 toggleViewMode 里读 v 排在换类之前、落位排在换类之后", () => {
    const b = bodyOf(md, "function toggleViewMode");
    expect(b.indexOf("readVisibleV(")).toBeLessThan(b.indexOf("applyPanelMode("));
    expect(b.indexOf("landVisibleSideAtV(")).toBeGreaterThan(b.indexOf("applyPanelMode("));
  });
});

describe("重建落位序列 · 快照与恢复配成一对", () => {
  it("rebuildLayout 在 destroy **之前**按可见侧快照 scrollV", () => {
    const b = bodyOf(life, "export function rebuildLayout()");
    expect(b).toContain("readVisibleV(");
    expect(b).toContain("shown.scrollV = v");
    expect(b.indexOf("readVisibleV(")).toBeLessThan(b.indexOf(".destroy()"));
  });

  it("mountView 在 applyPanelMode **之后**把 scrollV 扶回可见侧", () => {
    const b = bodyOf(life, "mountView: (panelId, hostEl) =>");
    expect(b).toContain("landVisibleSideAtV(");
    expect(b.indexOf("landVisibleSideAtV(")).toBeGreaterThan(b.indexOf("applyPanelMode("));
  });

  it("宿主 remountPanel 同形", () => {
    const b = bodyOf(host, "function remountPanel(");
    expect(b).toContain("readVisibleV(");
    expect(b).toContain("landVisibleSideAtV(");
  });
});

describe("落位这个动作本身 · 写下去必须同栈认领", () => {
  it("landVisibleSideAtV 写 v 并向账本登记（意图 + 真实落点）", () => {
    const b = bodyOf(wire, "export function landVisibleSideAtV(");
    expect(b).toContain(".setV(v)");
    expect(b).toContain("expectSurfaceV(face.el, v, landed)");
  });

  it("claimVisibleHere 认领的是读回的当前位置（意图 = 落点），不是假设的目标", () => {
    const b = bodyOf(wire, "export function claimVisibleHere(");
    expect(b).toContain("face.anchor.getV()");
    expect(b).toContain("expectSurfaceV(face.el, here, here)");
  });

  it("可见侧只有一条规则：reconcile 与读写共用 sideOfPanel", () => {
    expect(bodyOf(wire, "export function reconcileSyncRegistrations()")).toContain(
      "sideOfPanel(p)",
    );
    expect(bodyOf(wire, "export function readVisibleV(")).toContain("sideOfPanel(panel)");
    expect(bodyOf(wire, "export function landVisibleSideAtV(")).toContain("sideOfPanel(panel)");
    expect(bodyOf(wire, "export function claimVisibleHere(")).toContain("sideOfPanel(panel)");
  });
});

describe("切标签序列 · 两端都按「当前可见那一侧」读写", () => {
  // 真机日志给形状：`切换 · 还原窗口内 tab=4 模式=preview 视图=0`。预览态的标签里
  // `.panel-editor` 是 display:none ⇒ 按编辑器读恒 1.0、按编辑器写是空操作，
  // 而用户看见的那份预览没人记忆位置。所以快照与恢复都必须走可见侧。
  const needles = ["readVisibleV(panel)", "landVisibleSideAtV(panel, ", "applyPanelMode("];

  it("生产 switchTab 两端按可见侧，且顺序对（读在 setState 前、扶在 applyPanelMode 后）", () => {
    const b = bodyOf(life, "export function switchTab(");
    for (const n of needles) expect(b).toContain(n);
    expect(b.indexOf("readVisibleV(")).toBeLessThan(b.indexOf("setState("));
    expect(b.indexOf("landVisibleSideAtV(")).toBeGreaterThan(b.indexOf("applyPanelMode("));
    // 同栈的 focus 必须排在扶位置**之前**（B145：focus 会把光标滚进视野，晚一步就把刚钉好的
    // 位置顶掉）。之后 B182 那记补焦点走 `focusPreventScroll`，不动视口，所以只断前一条。
    expect(b.indexOf("view.focus()")).toBeLessThan(b.indexOf("landVisibleSideAtV("));
  });

  it("宿主 switchTab 镜像同形", () => {
    const b = bodyOf(host, "switchTab(panelId, index)");
    expect(b).toContain("readVisibleV(panel)");
    expect(b).toContain("landVisibleSideAtV(panel, nextTab.scrollV)");
    expect(b.indexOf("landVisibleSideAtV(")).toBeGreaterThan(b.indexOf("applyPanelModeMirror("));
  });

  it("splitActivePanel 同样两端按可见侧", () => {
    const b = bodyOf(split, "export function splitActivePanel(");
    expect(b).toContain("readVisibleV(panel)");
    expect(b).toContain("landVisibleSideAtV(panel, prev.scrollV)");
    expect(b.indexOf("readVisibleV(")).toBeLessThan(b.indexOf("setState("));
    expect(b.indexOf("landVisibleSideAtV(")).toBeGreaterThan(b.indexOf("applyPanelMode("));
  });
});

describe("预览的异步补定位 · 写在协调器栈外也要回登记", () => {
  it("未铺开时排下一帧，落定后才回登记（还在延迟状态时不登记，免得把补定位判成用户滚动）", () => {
    const b = bodyOf(syncPreview, "private scheduleRetry(");
    expect(b).toContain("this.deferred = true");
    expect(b).toContain("if (!this.deferred) this.declare?.(retry, landed)");
  });

  it("回登记口由 wire 注入，并且注册与落位用的是同一个构造方式（faceOf）", () => {
    expect(bodyOf(wire, "export function faceOf(")).toContain(
      "expectSurfaceV(root, intent, landed)",
    );
    expect(bodyOf(wire, "export function reconcileSyncRegistrations()")).toContain(
      "faceOf(p, sideOfPanel(p))",
    );
    expect(bodyOf(wire, "export function landVisibleSideAtV(")).toContain(
      "faceOf(panel, sideOfPanel(panel))",
    );
  });
});
describe("跨窗口 · 位置传 v，远端写入认领", () => {
  it("跨窗口载荷带 scrollV（共享坐标），且不是像素", () => {
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api).toContain("scrollV: number");
    expect(bodyOf(win, "function transferSnapshotOf(")).toContain("scrollV,");
    expect(bodyOf(win, "function transferSnapshotOf(")).toContain("readVisibleV(shownPanel)");
  });

  it("接手侧把载荷里的 v 落到新实例上", () => {
    expect(bodyOf(win, "function adoptTransferredTabs(")).toContain("inst.scrollV = st.scrollV");
  });

  it("远端增量 / 整段纠错写完就地认领，并把快照认账成现实", () => {
    const b = bodyOf(win, "function applyRemoteDocChange(");
    expect(b.indexOf("dispatch({ changes })")).toBeLessThan(b.indexOf("claimVisibleHere(p)"));
    expect(b).toContain("inst.scrollV = here");
    const r = bodyOf(win, "function applyDocResyncFull(");
    expect(r).toContain("claimVisibleHere(panel)");
    expect(r).toContain("inst.scrollV = here");
  });

  it("复制分屏（打开侧边预览那条）让副本继承源的 v", () => {
    const b = bodyOf(split, "export function splitPanelWithTab(");
    expect(b).toContain("tab.scrollV = live");
    expect(b).toContain("inst.scrollV = tab.scrollV");
  });

  it("重载路径也走认领，不再手搓锚点登记", () => {
    const b = bodyOf(files, "function rebuildDocInstances(");
    expect(b).toContain("claimVisibleHere(panel)");
    expect(b).not.toContain("expectSurfaceV");
  });
});

describe("落位是无条件的 · 「没位置记忆」不等于「不用写」（B291）", () => {
  // `scrollV` 的缺省值是 1，于是「这张标签停在文档顶部」与「这张标签从来没记过位置」在数据里
  // 长得一样。老写法 `if (tab.scrollV > 1) land(...)` 把两种一起跳过 ⇒ 接班标签从没被写过
  // 位置，视口留在 setState + focus 带过去的那一格。真机 03:24:59 的形状：
  // `切入 tab=2 意图=1.00` 后面**没有**登记行，`视图=800`（= 上一张的 20.67 行）。
  // 断言的是序列本身：行为层（focus 会不会滚）只有真机能看，这里钉的是「必须有人写」。
  for (const [label, src, header] of [
    ["生产 switchTab", life, "export function switchTab("],
    ["生产 mountView", life, "mountView: (panelId, hostEl) =>"],
    ["宿主 switchTab 镜像", host, "switchTab(panelId, index)"],
    ["宿主 remountPanel 镜像", host, "function remountPanel("],
  ] as const) {
    it(`${label}：落位不带 scrollV > 1 守卫`, () => {
      const b = bodyOf(src, header);
      expect(b).toContain("landVisibleSideAtV(");
      expect(b).not.toContain("scrollV > 1");
    });
  }
});

describe("方案 A · 接班标签跟随共享位置（B292）· 生产与宿主同形", () => {
  // 台子跑的是宿主复刻的序列，所以「镜像有、生产没有」会让 S25 变成假绿（本轮之前就
  // 被同形问题咬过一次：宿主的 setMode 多调了一发 reconcile，S13/S14 一路绿灯）。
  const needle = "syncCoordinator.currentV(String(";
  const tail = "if (followV !== null)";
  for (const [label, src, header] of [
    ["生产 switchTab", life, "export function switchTab("],
    ["宿主 switchTab 镜像", host, "switchTab(panelId, index)"],
  ] as const) {
    it(`${label}：先取共享 v，取不到才用自己的记忆`, () => {
      const b = bodyOf(src, header);
      expect(b).toContain(needle);
      expect(b).toContain(tail);
      // 取共享值必须排在落位之前，否则落下去的还是那份陈值。
      expect(b.indexOf(needle)).toBeLessThan(b.indexOf("landVisibleSideAtV("));
    });
  }
});
