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
const boot = readFileSync("src/main.ts", "utf-8");
const chrome = readFileSync("src/ui.ts", "utf-8");
const coord = readFileSync("src/sync-scroll/coordinator.ts", "utf-8");
const events = readFileSync("src/core/events.ts", "utf-8");
const appState = readFileSync("src/core/app-state.ts", "utf-8");
const sessRebuild = readFileSync("src/session/rebuild.ts", "utf-8");
const tocSrc = readFileSync("src/toc.ts", "utf-8");
const cmdsSrc = readFileSync("src/commands.ts", "utf-8");
const sessPersist = readFileSync("src/session/persist.ts", "utf-8");
const sessStore = readFileSync("src/session/store.ts", "utf-8");
const rustSession = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

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

  // B293：`readVisibleV` → `sideOfPanel` 判「哪一侧看得见」用的就是 `tab.viewMode`，而那一刻
  // DOM 上的 `mode-*` 类还没换（`applyPanelMode` 才换）。所以「读 v 早于换类」这句老判据
  // 单独成立是不够的 —— **还必须早于写 `viewMode`**，否则读到的是即将现形、此刻仍被
  // `display:none` 归零的那一侧 ⇒ keepV 恒 1.00 ⇒ 落位把用户钉回文档顶部。
  // 台子的宿主一度比生产「更正确」（先读后写），于是 S13/S14/S16/S20 一路绿灯而线上是坏的；
  // 这条契约与宿主镜像一起把顺序钉死。
  for (const [label, src, header] of [
    ["生产 toggleViewMode", md, "function toggleViewMode"],
    ["宿主 setMode 镜像", host, "setMode(panelId, mode)"],
  ] as const) {
    it(`${label}：读可见侧的 v 排在写 viewMode 之前`, () => {
      const b = bodyOf(src, header);
      expect(b).toContain("viewMode = ");
      expect(b.indexOf("readVisibleV(")).toBeLessThan(b.indexOf("viewMode = "));
    });
  }

  it("宿主 setMode 也照抄生产末尾那记延迟补焦点（少抄一步就会把抢位置藏起来）", () => {
    expect(bodyOf(host, "setMode(panelId, mode)")).toContain("setTimeout(() => handle.focus(), 0)");
    expect(bodyOf(md, "function toggleViewMode")).toContain("setTimeout(() => handle.focus(), 0)");
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

describe("重建路径的共享位置 · 方案 A 也必须管住销毁重建（B293）", () => {
  // 取证结论（真机 + `__harness.scrollVOf`）：
  //   复制一张标签 → 出现那一下 `P0 ed=1.00/0px`、`currentV(X)=1` → 切回原来那张也落到 1.00；
  //   拖走正在显示的那张 → 源面板接班那张落在它自己记的陈值上。
  // 两处都因为 `mountView` 只认 `tab.scrollV`，而同一文档没被显示过的那一张从不注册、
  // 收不到广播 ⇒ 陈值冒充记忆。修法是 `rebuildLayout` 在**销毁任何 view 之前**把各文档的
  // 共享位置抄一份、`mountView` 落位之前消费。销毁时机这条判据只有真机能验（台子 S26/S27），
  // 这里钉的是序列本身。
  it("生产 rebuildLayout：共享位置抄在销毁之前", () => {
    const b = bodyOf(life, "export function rebuildLayout()");
    expect(b).toContain("rebuildSharedV = sharedVByDoc()");
    expect(b.indexOf("sharedVByDoc()")).toBeLessThan(b.indexOf(".destroy()"));
  });

  it("生产 mountView：落位之前跟随共享位置，取不到才用自己的记忆", () => {
    const b = bodyOf(life, "mountView: (panelId, hostEl) =>");
    expect(b).toContain("rebuildSharedV.get(String(tab.docId))");
    expect(b).toContain("tab.scrollV = shared");
    expect(b.indexOf("rebuildSharedV.get(")).toBeLessThan(b.indexOf("landVisibleSideAtV("));
    expect(b.indexOf("landVisibleSideAtV(")).toBeGreaterThan(b.indexOf("applyPanelMode("));
  });

  it("宿主同形：整轮 rebuildLayoutMirror 先抄共享位置、remountPanel 落位前消费", () => {
    const capture = bodyOf(host, "function rebuildLayoutMirror(");
    expect(capture).toContain("sharedVByDoc()");
    expect(capture.indexOf("sharedVByDoc()")).toBeLessThan(capture.indexOf("remountPanel("));
    const mount = bodyOf(host, "function remountPanel(");
    expect(mount).toContain("shared.get(String(tab.docId))");
    expect(mount).toContain("tab.scrollV = follow");
    expect(mount.indexOf("shared.get(")).toBeLessThan(mount.indexOf("landVisibleSideAtV("));
  });

  it("复制与跨面板拖拽两条路都走整轮重建镜像（宿主不许只重建受影响的两格）", () => {
    for (const header of ["duplicateTab(panelId, index)", "moveTab(tabId, hostPanelId)"]) {
      const b = bodyOf(host, header);
      expect(b).toContain("rebuildLayoutMirror()");
    }
  });
});

describe("落位这个动作本身 · 写下去必须同栈认领", () => {
  it("landVisibleSideAtV 写 v 并向账本登记（意图 + 真实落点）", () => {
    const b = bodyOf(wire, "export function landVisibleSideAtV(");
    expect(b).toContain(".setV(v)");
    expect(b).toContain("expectSurfaceV(face.el, byPos ? landed : v, landed)");
    // B300：按字符位置对齐那一发，**意图必须记成自己读回的 v**（两格宽度不同时同一个字符
    // 各自算出的 v 本来就不等，记成对方的就会被判成「没兑现」而补写回去，逐行对齐被自己拆掉）
    expect(b).toContain("const byPos = at !== null && !!face.anchor.setVAt;");
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

describe("落位没进去要自己重试（B294）", () => {
  // 真机 07:59:35 的重建路径：编辑器刚 new 出来没有布局 ⇒ 写入被裁到 0，而**像素没变就不派发
  // `scroll`** ⇒ 回声永远不来 ⇒ 靠回声驱动的补写兑现一次都不触发 ⇒ 位置静默丢在顶部。
  // 所以「重试」不能挂在账本上，只能挂在写这一发的人身上。钉的是序列里存在这个分支。
  it("wire.landVisibleSideAtV 下一帧重写自己那一发，且带上限", () => {
    const b = bodyOf(wire, "export function landVisibleSideAtV(");
    expect(b).toContain(
      "requestAnimationFrame(() => landVisibleSideAtV(panel, v, attempt + 1, at))",
    );
    expect(b).toContain("attempt < LAND_RETRY_LIMIT");
    expect(b).toContain("expectSurfaceV(face.el, byPos ? landed : v, landed)"); // 重试那一发同样要认领
  });

  it("链条的**起点**仍是「完全没进去」，不是泛泛的读回≠意图（这条取舍不许漂）", () => {
    // 第一版写成「不等就重试」，被 `tests/multi-instance-preview.test.ts` 当场抓住（它把
    // 500 改成了 800）：部分落位本来就不该被推翻。只有从「裁到 0px」起步的链条才允许
    // 按「收口了没有」续跑（`attempt > 0`）。
    // B299 给起点加了第二种「完全没进去」：预览那条异步支线只排了下一帧、一个像素都没写
    // （`hasPosition()` 说量不出来 ⇒ 那一发只是承诺）。它和 `stuckAtTop` 同族，不是「读回
    // ≠意图」那一条 —— 部分落位（意图 800、读回 500）今天照样不许被推翻。
    const b = bodyOf(wire, "export function landVisibleSideAtV(");
    expect(b).toContain("stuckAtTop || !measurable || (attempt > 0 && !settled)");
    expect(b).not.toContain("(stuckAtTop || !settled)");
    expect(b.indexOf("const stuckAtTop =")).toBeLessThan(b.indexOf("const retry ="));
  });
});

describe("落位链在途时，位置的家是账本不是 DOM（B296 · 跨窗口双重建）", () => {
  // 真机 14:19:51：拖标签出窗口那一下主窗口被 `rebuildLayout` 连做两轮，第二轮的快照按 DOM 读
  // 到「还没落成的投影」（1.00）⇒ `tab.scrollV` 被写坏、新元素被扶到文档顶部，并原样落进会话。
  // 行为判据在 `tests/sync-scroll-landing-conceal.test.ts`；这里钉的是「读谁」这个接线本身，
  // 防止以后有人在某个读取点上把它换回纯 DOM 读数（那正是本轮的病）。
  it("readVisibleV 与 sharedVByDoc 都先认在途落位，DOM 只兜底", () => {
    expect(bodyOf(wire, "export function readVisibleV(")).toContain(
      "owedLanding.get(panel.panelId)",
    );
    const s = bodyOf(wire, "export function sharedVByDoc(");
    expect(s).toContain("owedLanding.get(p.panelId) ?? syncCoordinator.currentV(key)");
  });

  it("欠账由落位链自己记 / 自己销：重试时记，链一结束（落准或到上限）就销", () => {
    const b = bodyOf(wire, "export function landVisibleSideAtV(");
    expect(b).toContain("owedLanding.set(panel.panelId, v)");
    expect(b).toContain("owedLanding.delete(panel.panelId)");
    // 记与销必须在同一个分支结构里（`if (retry) … else …`）：分两处写就会有一边漏销，
    // 而漏销的后果是「用户已经滚到别处，快照还记着那个旧的在途值」。
    expect(b.indexOf("owedLanding.set")).toBeLessThan(b.indexOf("owedLanding.delete"));
  });
});

describe("落位中间帧不画出来（B295 · 用户报的「对齐前闪动」）", () => {
  // 真机 08:14:45：重建路径落位要三帧才定局（顶部 0px → 按估算行高的 410.67px → 定局 608px），
  // 每一帧都有绘制机会 ⇒ 用户看见两次跳动。修法是把「藏 → 重试 → 收口那一发同栈露出」做成
  // 一条链：藏/露之间不绘制，于是露出来的第一帧就是收口后的位置。
  it("藏与露都在写这一下的同步栈里，收口判据用的是读数而不是时间窗", () => {
    const b = bodyOf(wire, "export function landVisibleSideAtV(");
    expect(b).toContain('face.el.style.visibility = "hidden"');
    expect(b).toContain('face.el.style.visibility = ""');
    expect(b).toContain("Math.abs(landed - v) <= LAND_TOLERANCE_V");
    // 露出若靠 `setTimeout` 就既慢又会在窗口被最小化时把内容永久藏死；只许在同一发写完就露。
    expect(b).not.toContain("setTimeout(");
  });
});

describe("跨窗口同步滚动的接线（B297）", () => {
  // 语义：开着同步的那份文档，滚**任何一个窗口**，所有窗口里这一文档的可见面都落到同一个
  // 共享坐标 `v`；开关也是**文档**的属性，翻转即跨窗口联动。
  // 行为判据在 `tests/sync-scroll-cross-window.test.ts`（外发的时机 / 收端落到哪 / 开关口径）
  // 与台子 S30（真实浏览器里两端各自接线成立）；这一层只钉**接线没被拆掉**：
  // 尤其「发只从用户滚动那一支走、收端绝不窗内广播」这两条 —— 少任何一条就是回声环。
  it("协调器：外发只在帧广播那一处；被写入的兄弟面（writeTo）一个字节都不外发", () => {
    const f = bodyOf(coord, "private scheduleFrame()");
    expect(f).toContain("this.outbound?.(driver.docId, v, at)");
    expect(bodyOf(coord, "private writeTo(")).not.toContain("this.outbound");
  });

  it("windows.listenDocSync：装外发口 + 两条监听，且都按 from 滤掉自己的回声", () => {
    const b = bodyOf(win, "function listenDocSync()");
    expect(b).toContain("syncCoordinator.setOutbound(");
    expect(b).toContain("listen<SyncPosPayload>(EVT_SYNC_POS");
    expect(b).toContain("listen<SyncModePayload>(EVT_SYNC_MODE");
    expect(b).toContain(
      'applySharedVFromRemote(String(p.docId), p.v, typeof p.pos === "number" ? p.pos : null)',
    );
    // 自己的回声：Tauri 的广播本机也收得到，两条都必须先按 `from` 关掉自己
    expect(b.split("p.from === windowLabel").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("事件名是这两个字面量（改名等于换协议，必须在这里显式过一遍）", () => {
    expect(events).toContain('export const EVT_SYNC_POS = "sync-pos"');
    expect(events).toContain('export const EVT_SYNC_MODE = "sync-mode"');
  });

  it("wire.applySharedVFromRemote：先 gate 开关、落位走同一条纪律，且不窗内广播（防回环）", () => {
    const b = bodyOf(wire, "export function applySharedVFromRemote(");
    expect(b).toContain("syncCoordinator.isOn(docId)");
    expect(b).toContain("landVisibleSideAtV(p, v, 0, at)");
    expect(b).not.toContain("syncFrom"); // 一窗内广播就会再走一次帧回调 ⇒ 回声环
    expect(b).not.toContain("this.outbound");
    // 没在显示的那些实例只记账（方案 A 的跨窗口版）：现形时落在同一处
    expect(b).toContain("t.scrollV = v");
  });

  it("main.ts 那颗键：翻转走唯一写点，并广播给所有窗口", () => {
    expect(boot).toContain("setDocSyncMode(tab.docId, on)");
    expect(boot).toContain("broadcastSyncMode(tab.docId, on)");
    // B304：不再有「引导末尾整表补推」那一步 —— 它排在 `restoreSession()` 之前推的是空表，
    // 而恢复那一步直接写 map，两边就分裂了（按钮灭着却还在同步）。
    expect(boot).not.toMatch(/pushDocSyncModes\s*\(/);
  });

  it("开关的缺省只有一处定义，UI 不再自写 === true；提示也不许再说「已禁用」", () => {
    expect(appState).toContain("docSyncModes.get(docId) !== false");
    expect(chrome).toContain("docSyncOn(tab.docId)");
    expect(chrome).not.toContain("已禁用，仅记录开关状态");
    // 两头都记：只写 true 的话，退出前关着的那份文档重启后自己翻回「开」
    expect(sessRebuild).toContain("setDocSyncMode(inst.docId, st.syncMode !== false)");
    // 而且**只**走那个写点：直接写 map 就是绕过协调器（B304 的真病灶，契约原先还把它钉死了）
    expect(sessRebuild).not.toMatch(/docSyncModes\.set\(/);
  });

  it("宿主不另抄一份：收端直接用生产函数", () => {
    expect(host).toContain("applySharedVFromRemote(docId, v, at ?? null)");
  });
});

describe("卫星窗口也得有取证能力（B298）", () => {
  // 过滤发生在**发 IPC 之前**：前端级别没和后端对齐，就按默认 info 把 trace/debug 全挡掉，
  // 文件里连一行都不会有。卫星窗口在 `bootstrap` 里走的是「拿到身份 → 分支 → return」那条
  // 近路，所以任何排在分支之后的对齐调用都等于没调 —— 真机 17:39–17:41 那一整轮，主窗口
  // 456 行 sync trace、新窗口 0 行，而新窗口明明在往外发位置（主窗口的 `远端推` 是证据）。
  // 「拖出窗口建新窗口」出问题的那一段只有子窗口看得见，没这些行就只能猜。
  it("syncLevel() 排在卫星窗口分支之前，且全篇只此一处", () => {
    const b = bodyOf(boot, "async function bootstrap(");
    const lvl = b.indexOf("void syncLevel();");
    const branch = b.indexOf("initSatelliteWindow(me)");
    expect(lvl).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThanOrEqual(0);
    expect(lvl).toBeLessThan(branch);
    // 只留一处：再往后的启动收尾里不许还藏着一次（那等于子窗口重新被关进 info）
    expect(b.indexOf("syncLevel(", lvl + "void syncLevel();".length)).toBe(-1);
  });
});

describe("主动跳转把坐标交给协调器，不委托某个面去读（B301）", () => {
  // 病根（真机 19:23:27 / 19:23:33，都是预览态标签上点大纲）：`toc.ts` 与 `commands.ts`
  // 把自己 new 出来的**编辑器**锚点交给 `syncFromDriver`，协调器在下一帧读它 —— 可这一格
  // 处于预览态时编辑器是 `display:none`，`scrollTop` 恒 0，读回来只有兜底的 1.00，
  // 于是 `外发 doc=1 v=1.00` + 本窗口看得见那一侧被拽上顶。行为判据在
  // `tests/sync-scroll-coordinator.test.ts`（含一条记录旧入口病形的留案用例）；
  // 这里钉的是**接线**：这两处今后也不许再退回「驱动一个可能看不见的面」。
  it("两处跳点都走 syncTo，且不再 new EditorScrollAnchor 去驱动", () => {
    expect(tocSrc).toContain("syncCoordinator.syncTo(String(tab2.docId), line)");
    expect(cmdsSrc).toContain("syncCoordinator.syncTo(String(t.docId), target)");
    for (const [label, src] of [
      ["toc.ts", tocSrc],
      ["commands.ts", cmdsSrc],
    ] as const) {
      expect(src, label).not.toContain("syncFromDriver");
      expect(src, label).not.toContain("EditorScrollAnchor");
    }
  });
});

describe("滚动位置随会话进出（B302）", () => {
  // 持久化这条链没有 DOM 因果可循：写的人（落盘现采）与读的人（恢复落位）之间隔着一次进程
  // 重启，jsdom 只能各测一头，接线本身只能钉原文。三处最容易悄悄断掉的：
  //   ① 落盘时**只采看得见那一侧**，量不出就不改（改成兜底 1.00 就是跳顶那一族）；
  //   ② 恢复时**无条件写** `inst.scrollV`（带守卫就会把「没记过」与「在顶部」一起跳过）；
  //   ③ 交还回来的位置必须**先落账再作废旧账**（`dropRemotedForOwner` 一跑，记录就没了）。
  it("落盘现采排在可见侧口径上，且量不出就一个字都不写", () => {
    expect(bodyOf(sessPersist, "export function refreshSession()")).toContain(
      "samplePanelScrollV(p)",
    );
    const b = bodyOf(sessPersist, "export function samplePanelScrollV(");
    expect(b).toContain("readVisibleV(p)");
    expect(b).toContain("if (live === null) return;");
    expect(sessStore, "记录要真的进磁盘形状").toContain("scrollV: r.scrollV,");
    expect(rustSession, "Rust 那一侧也要有这一格（Option：没记过与停在顶部是两件事）").toContain(
      "pub scroll_v: Option<f64>",
    );
  });

  it("恢复无条件写回视口位置，并先铺好文档级兜底那张表", () => {
    expect(sessRebuild).toContain("const docScrollV = new Map<number, number>();");
    const b = bodyOf(sessRebuild, "function buildInstance(st: TabSession, panelId: number)");
    expect(b).toContain('inst.scrollV = typeof st.scrollV === "number"');
    expect(b).toContain("docScrollV.get(inst.docId) ?? 1");
    // 反向：不许有人再给这一句加「大于 1 才写」那类守卫（不变量 4 的老病根）
    expect(b).not.toMatch(/if\s*\(\s*st\.scrollV\s*>\s*1\s*\)/);
  });

  it("交还：发出去带位置清单，收下来先落账再作废旧账（顺序即判据）", () => {
    expect(bodyOf(boot, "async function finishSatelliteClose()")).toContain(
      "positions: collectWindowPositions()",
    );
    const apply = boot.indexOf("applyHandedBackPositions(lbl");
    const drop = boot.indexOf("dropRemotedForOwner(lbl)");
    expect(apply, "没有把交还回来的位置落到那份记录上").toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(apply, "位置必须排在旧账作废之前落下去").toBeLessThan(drop);
  });

  it("落盘通知装在跨窗口接线上：主窗口排落盘，卫星窗口报给主窗口", () => {
    expect(win).toContain("syncCoordinator.setOnUserScroll(");
    expect(win).toContain("emitCrossWindow(EVT_WINDOW_POS");
    expect(win).toContain("applyHandedBackPositions(p.from, p.positions)");
  });

  it("落盘通知排在同步开关之前（关着同步也得记住位置）", () => {
    const frame = bodyOf(coord, "private scheduleFrame()");
    const note = frame.indexOf("this.onUserScroll?.(driver.docId, v)");
    const gate = frame.indexOf("if (!this.isOn(driver.docId)) return;");
    expect(note).toBeGreaterThanOrEqual(0);
    expect(gate, "帧体里找不到开关闸 ⇒ 联动口径变了，这条契约得跟着重看").toBeGreaterThanOrEqual(0);
    expect(note, "位置通知不许被同步开关挡在后面").toBeLessThan(gate);
    // 反向：闸从 `drive` 挪进了帧体 —— `drive` 里再留一道，关着同步就又听不到落盘了
    expect(bodyOf(coord, "private drive(entry: InternalEntry)")).not.toContain("isOn");
  });

  it("但**位置落地**那三条路都得先问开关（B303：关着同步不许串位置）", () => {
    // 上面那条管的是「记不记」，这一条管的是「用不用」：把某个实例的位置写成另一个实例的位置，
    // 就是用户眼里的同步 —— 真机关着同步时同文档四个格子全落在 24.95，走的正是下面三条路。
    //   ① 恢复时的文档级兜底（`rebuild.ts` 那张 `docScrollV` 表）；
    //   ② 重建那一路的接班跟随（`sharedVByDoc` 的在途落位分支绕过 `currentV` 自己的闸）；
    //   ③ 落盘时给恢复回来的实例补建记录（不带 seed 就把位置弄丢，下一次重启只剩兜底可走）。
    expect(sessRebuild, "兜底表要跳过同步关着的那些记录").toMatch(/rec\.syncMode === false/);
    const shared = bodyOf(wire, "export function sharedVByDoc()");
    const gate = shared.indexOf("syncCoordinator.isOn(");
    const owed = shared.indexOf("owedLanding.get(");
    expect(
      gate,
      "sharedVByDoc 里没有开关闸 ⇒ 关着同步时接班那张会跟到兄弟格的位置",
    ).toBeGreaterThanOrEqual(0);
    expect(owed).toBeGreaterThanOrEqual(0);
    expect(gate, "闸要排在读位置之前").toBeLessThan(owed);
    expect(bodyOf(sessPersist, "export function refreshSession()")).toMatch(
      /\{\s*scrollV:\s*t\.scrollV\s*\}/,
    );
  });

  it("副本的位置是与开关无关的显式种子（生产与宿主同形，B259 不许因为加了闸而退化成顶部）", () => {
    for (const [label, src, header] of [
      ["生产 duplicateTabToPanel", split, "export function duplicateTabToPanel("],
      ["宿主 duplicateTab 镜像", host, "duplicateTab(panelId, index)"],
    ] as const) {
      const b = bodyOf(src, header);
      expect(b, label).toContain("readVisibleV(");
      expect(b, label).toContain("inst.scrollV = srcLive ?? src.scrollV;");
      // 种子必须排在把这张挂上去之前落好：`mountView` 读的就是它。
      expect(b.indexOf("inst.scrollV = srcLive"), label).toBeGreaterThanOrEqual(0);
    }
  });
});
