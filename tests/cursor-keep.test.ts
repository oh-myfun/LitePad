// @vitest-environment jsdom
// B126 · 编辑器光标 / 视口位置不得因「切换标签 / 重建布局 / 关闭窗口」而复位。
//
// 为什么必须自己存取：CM6 的滚动位置只活在 `scrollDOM.scrollTop` 上，**不进
// EditorState**。切标签是 `view.setState()`（重建 ViewState）、重建布局是视图
// 销毁重建 —— 两种都会把视口拉回文档开头。光标随 EditorState 走，但滚动位置
// 必须由 main.ts 在切走前记、切回后还。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { fireDrag, makeDataTransfer } from "./dnd";
import { topLevelFnBody } from "./static";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    isAlwaysOnTop: () => Promise.resolve(false),
    setAlwaysOnTop: () => Promise.resolve(),
    onCloseRequested: () => Promise.resolve({ catch: () => {} }),
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 最后一次落盘的会话（B126：断言 scrollTop 真的进去了）。 */
const savedSession = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 0,
          tabs: [
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
          ],
        },
        {
          active: 0,
          tabs: [
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
            { path: "b.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
          ],
        },
      ],
    }),
  loadSettings: () =>
    Promise.resolve({
      theme: "system",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: false,
      hot_exit: true,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (_path: string) =>
    Promise.resolve({
      tabId: _path === "a.md" ? 101 : 102,
      text: _path === "a.md" ? "alpha\nbeta\ngamma\ndelta\nepsilon" : "second document from B",
      name: _path,
      path: _path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    }),
  reloadFile: () =>
    Promise.resolve({
      tabId: 1,
      text: "",
      name: "x",
      path: "x",
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
    }),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: (s: Record<string, unknown>) => {
    savedSession.last = s;
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

function mouse(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
}
/** 真实点击 = mousedown + click（mousedown 会重置拖拽吞击标记）。 */
function clickTab(tab: HTMLElement): void {
  tab.dispatchEvent(mouse("mousedown", 5, 5));
  tab.dispatchEvent(mouse("click", 5, 5));
}

/** 面板按文档顺序横向排布（每个 200x200，间隔 10），标签条 20x24：jsdom 无布局，
 *  命中测试（panelAt / tabUnder）全靠该桩。与 smoke 用例同一套坐标。 */
function installRectStubs(): () => void {
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const mk = (left: number, top: number, w: number, h: number) =>
      ({
        left,
        top,
        right: left + w,
        bottom: top + h,
        width: w,
        height: h,
        x: left,
        y: top,
        toJSON() {},
      }) as DOMRect;
    if (this.classList.contains("layout-panel")) {
      const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(this);
      return mk(Math.max(0, idx) * 210, 0, 200, 200);
    }
    if (this.classList.contains("panel-tabstrip")) {
      const panel = this.closest(".layout-panel");
      const idx = panel ? Array.from(document.querySelectorAll(".layout-panel")).indexOf(panel) : 0;
      return mk(Math.max(0, idx) * 210, 0, 200, 24);
    }
    if (this.classList.contains("tab")) return mk(0, 0, 20, 24);
    return mk(0, 0, 200, 200);
  };
  return () => {
    Element.prototype.getBoundingClientRect = origRect;
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 所有挂载中的编辑器视图。 */
function views(): EditorView[] {
  return Array.from(document.querySelectorAll(".cm-editor"))
    .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
    .filter((v): v is EditorView => !!v);
}

describe("B126 编辑器光标 / 视口不得复位", () => {
  it("切换标签再切回：光标位置不变", async () => {
    await import("../src/main");
    await wait(300);

    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(panels.length, "应有两个面板").toBe(2);
    // 面板1 有 a.md / b.md 两个标签，用它做切换
    const strip = panels[1].querySelectorAll(".tab") as NodeListOf<HTMLElement>;
    expect(strip.length, "面板1 应有两个标签").toBe(2);

    const view = views()[1];
    expect(view, "面板1 应挂载编辑器").toBeTruthy();
    expect(view.state.doc.toString()).toContain("gamma");

    // 光标摆到第 3 行第 3 列（"gamma" 里），并滚到 60px
    const CARET = view.state.doc.line(3).from + 2;
    const SCROLL = 60;
    view.dispatch({ selection: { anchor: CARET } });
    view.scrollDOM.scrollTop = SCROLL;
    await wait(40);

    // 切到 b.md 再切回 a.md
    clickTab(strip[1]);
    await wait(60);
    expect(views()[1].state.doc.toString(), "应切到 b.md").toContain("second document");

    const back = panels[1].querySelectorAll(".tab")[0] as HTMLElement;
    clickTab(back);
    await wait(60);

    const now = views()[1];
    expect(now.state.doc.toString(), "应切回 a.md").toContain("gamma");
    expect(now.state.selection.main.head, "光标必须还在原处").toBe(CARET);
    expect(now.scrollDOM.scrollTop, "视口必须还在原处").toBe(SCROLL);
  });

  // B180：切换激活文件时，底部状态栏的「行/列」必须跟着刷新。
  //
  // ⚠️ 根因不是「忘了写更新」，而是**没人会触发它**：CM6 的 `view.setState()` 不触发
  //    updateListener（它 `destroy` 掉插件再整个重建，不走 `update()` 循环 —— 见
  //    `EditorView.setState`），而切标签换文档走的正是 setState。于是 `handleUpdate`
  //    里那句 `updatePositionOf` 根本跑不到，状态栏会一直挂着**上一个文件**的行号，
  //    看着就像「光标位置没恢复」。修法是把光标位置也归到 `refreshStatus()` 里刷。
  it("切换激活文件：底部状态栏的「行/列」要跟着刷新（B180）", async () => {
    const sbPos = document.getElementById("sb-pos");
    expect(sbPos, "状态栏要有光标位置槽位").toBeTruthy();

    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    // 面板1 是活动面板（上面刚点过它的标签）：先把 a.md 的光标摆到第 3 行第 3 列
    clickTab(panels[1].querySelectorAll(".tab")[0] as HTMLElement);
    await wait(60);
    const v = views()[1];
    expect(v.state.doc.toString(), "前置：面板1 显示 a.md").toContain("gamma");
    v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 2 } });
    await wait(40);
    expect(sbPos!.textContent, "移动光标后状态栏跟着走").toBe("行 3, 列 3");

    // 切到 b.md（单行文档）→ 光标落在第 1 行第 1 列
    clickTab(panels[1].querySelectorAll(".tab")[1] as HTMLElement);
    await wait(60);
    expect(views()[1].state.doc.toString(), "应切到 b.md").toContain("second document");
    expect(
      sbPos!.textContent,
      "切标签走的是 setState（不触发 updateListener），必须由 refreshStatus 补刷这一眼",
    ).toBe("行 1, 列 1");

    // 还原现场，别影响后面的用例
    clickTab(panels[1].querySelectorAll(".tab")[0] as HTMLElement);
    await wait(60);
  });

  it("重建布局（标签拖去分屏）：光标与视口都跟着走", async () => {
    const CARET_LINE = 4;
    const SCROLL = 120;
    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];

    // 面板0 的 a.md 上摆好光标与视口
    const v0 = views()[0];
    const CARET = v0.state.doc.line(CARET_LINE).from + 1;
    v0.dispatch({ selection: { anchor: CARET } });
    v0.scrollDOM.scrollTop = SCROLL;
    await wait(40);
    expect(v0.state.selection.main.head, "前置：面板0 光标已就位").toBe(CARET);

    // 把面板0 的标签拖到面板1 的左侧区域 → splitPanelWithTab → rebuildLayout
    // （视图销毁重建：新的 scrollDOM，滚动位置天然是 0，只能靠显式还原）
    const restoreRects = installRectStubs();
    const tab0 = panels[0].querySelector(".tab") as HTMLElement;
    const dt = makeDataTransfer();
    fireDrag("dragstart", tab0, dt, { clientX: 10, clientY: 12 });
    fireDrag("dragover", document, dt, { clientX: 215, clientY: 100 });
    fireDrag("drop", document, dt, { clientX: 215, clientY: 100 });
    fireDrag("dragend", tab0, dt, { clientX: 215, clientY: 100 });
    restoreRects();
    await wait(80);

    const carried = views().find(
      (v) => v.state.doc.toString().includes("gamma") && v.state.selection.main.head === CARET,
    );
    expect(carried, "被搬走的标签应带着自己的光标出现在新面板").toBeTruthy();
    expect(carried!.scrollDOM.scrollTop, "重建视图后视口必须还原，不能停在开头").toBe(SCROLL);
  });

  it("关闭窗口：会话要带上光标行列与视口位置", async () => {
    // 触发一次会话落盘（handleUpdate → scheduleSessionSave，800ms 防抖）
    const v = views()[0];
    v.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(1100);

    const sess = savedSession.last as unknown as {
      panels: Array<{ tabs: Array<Record<string, unknown>> }>;
    };
    expect(sess, "会话应已落盘").toBeTruthy();
    const allTabs = sess.panels.flatMap((p) => p.tabs);
    expect(allTabs.length, "会话里应有标签").toBeGreaterThan(0);
    for (const t of allTabs) {
      expect(typeof t.cursorLine, "每个标签都要记光标行").toBe("number");
      expect("scrollTop" in t, "标签记录必须带 scrollTop 字段").toBe(true);
    }
    // 至少有一个标签带着非 0 的视口位置（上面刚滚过）
    expect(
      allTabs.some((t) => typeof t.scrollTop === "number" && t.scrollTop > 0),
      "滚过的标签进会话时必须带上视口位置",
    ).toBe(true);
    // 光标行列必须是**此刻**的：a.md 上摆的是第 4 行
    expect(
      allTabs.some((t) => t.path === "a.md" && t.cursorLine === 4),
      `会话里的光标行应为 4，实际：${JSON.stringify(allTabs)}`,
    ).toBe(true);
  });

  it("反向验证：退化实现（只 setState / 只重建视图、不还原滚动）必然丢视口", async () => {
    // 这条用例回答「上面的断言是不是恒真」：平台不会替我们保留视口，
    // 所以「重建后 scrollTop === 原值」只有显式还原才成立。
    const src = views()[0];
    src.scrollDOM.scrollTop = 200;
    await wait(20);

    // 退化替身：新建一个视图（等价于 rebuildLayout 的 mountView），只带 EditorState，
    // 不做任何滚动还原 —— 这正是修复前的写法。
    const host = document.createElement("div");
    document.body.appendChild(host);
    const degraded = new EditorView({ state: src.state, parent: host });
    expect(
      degraded.scrollDOM.scrollTop,
      "退化实现必须回到开头（否则「显式还原」这条修复就是多余的）",
    ).toBe(0);
    degraded.destroy();
    host.remove();
  });
});

describe("B126 静态契约：滚动位置必须自己存取", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("必须有「取快照 / 还原」两个helper，且还原真的写回 scrollTop", () => {
    expect(src, "落盘前要取快照").toContain("function viewportOfTab");
    expect(src, "切回后要还原滚动位置").toContain("function restoreViewScroll");
    // B134：写回要经 `pinScrollTop` —— 裸写会被「容器还没布局」裁成 0，
    // 值看着写上了、其实没进去。pinScrollTop 内部最终还是会写 scrollDOM，
    // 所以这里同时认两种写法，但**必须**经由写回函数。
    expect(src, "还原必须把快照里的值写回 scrollDOM（光调 helper 名不算）").toMatch(
      /pinScrollTop\(view\.scrollDOM, t\.scrollTop\)|view\.scrollDOM\.scrollTop = t\.scrollTop/,
    );
  });

  it("反向验证：删掉写回那一行，上一条断言必须失败", () => {
    const degraded = src
      .replace(
        /pinScrollTop\(view\.scrollDOM, t\.scrollTop\);/g,
        "view.scrollDOM.scrollTop = t.scrollTop!;",
      )
      .replace(/view\.scrollDOM\.scrollTop = t\.scrollTop!(;)?/g, "// 已删除");
    expect(degraded).not.toBe(src);
    expect(degraded, "退化后不应再匹配到写回语句（否则这条断言形同虚设）").not.toMatch(
      /view\.scrollDOM\.scrollTop = t\.scrollTop/,
    );
  });

  it("销毁视图的每一处现场都必须先采一次位置", () => {
    // B139 拎清了这两件事：快照是**全局记录**（DOM 清不掉它），但**读不到** ——
    // 位置变化不一定派发 scroll 事件（预览→编辑器同步的 `host.scrollToLine()` 就是
    // 裸写）。所以「消失前看最后一眼」仍然必需：采的是清零前的容器，不是刷新快照。
    const destroySites = src.match(/\.view\.destroy\(\)/g) ?? [];
    expect(destroySites.length, "视图销毁现场应恰好两处").toBe(2);
    const rememberSites = src.match(/rememberViewScroll\(/g) ?? [];
    expect(rememberSites.length, "每处销毁现场都要先采一次").toBeGreaterThanOrEqual(3);
    for (const site of ["rebuildLayout", "disposePanel"]) {
      const start = src.indexOf(`function ${site}`);
      expect(start, `应能定位 ${site}`).toBeGreaterThan(-1);
      const body = src.slice(start, start + 1200);
      expect(body, `${site} 销毁视图前必须采一次滚动位置`).toContain("rememberViewScroll(");
    }
  });

  it("程序滚动（还原钉位置 / 增强后二次定位）不许写回快照", () => {
    // 快照不随 DOM，于是会被**我们自己的赋值**改写：钉位置那一下派发的事件、
    // 图片公式增强后二次定位那一下派发的事件 —— 落点是程序算的，不是用户停过的。
    // B170：钉位置由 `pinScrollTop` 内部 `markProgrammatic` 标来源、回执被监听经 scroll-guard
    // 吞掉；预览的程序定位也走 `markProgrammatic(this.root)`，回执被自己的 scroll 监听吞掉。
    // ⚠️ 间距用 `[\s\S]*?` 而不是「紧跟 `{`」：pinScrollTop 开头挂着说明注释。
    const pin =
      /function pinScrollTop\(el: HTMLElement, px: number\): void \{[\s\S]*?requestAnimationFrame\(\(\) => retry\(frame \+ 1\)\);/;
    expect(src, "pinScrollTop 要逐帧补钉到立住为止").toMatch(pin);
    expect(src, "pinScrollTop 每次钉位前都要标程序来源").toMatch(
      /function pinScrollTop\(el: HTMLElement, px: number\): void \{[\s\S]*?markProgrammatic\(el\);/,
    );
    expect(src, "编辑器滚动监听要挡住程序滚动").toMatch(
      /if \(isProgrammatic\(shownView\.scrollDOM\)\) return;/,
    );
    expect(src, "预览滚动监听要挡住程序滚动").toMatch(/if \(isProgrammatic\(preview\.root\)/);
    const preview = readFileSync("src/markdown/preview.ts", "utf-8");
    expect(
      preview,
      "预览程序定位要标来源（setScrollTop / applySyncToLine / setBlocks 恢复）",
    ).toMatch(/markProgrammatic\(this\.root\);/);
  });

  it("切标签 / 接管标签的每一处 setState 之后都必须还原滚动", () => {
    // ⚠️ 不能只数 `panel.view.setState(` 的个数：切标签 / 关标签两处为了把 `view`
    // 收窄带进还原窗口的闭包，用的是局部变量 `view.setState(`，数少了就假绿。
    // 逐点看：**每一处**整态切换之后都得有还原，否则视口就停在 setState 停下的地方。
    const setStateSites = [...src.matchAll(/(\bview|panel\.view)\.setState\(/g)];
    expect(setStateSites.length, "应能定位到全部整态切换").toBeGreaterThanOrEqual(4);
    for (const m of setStateSites) {
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 600);
      expect(
        after,
        `第 ${m.index! + 1} 行的 setState 之后必须还原滚动（离得太远等于没有）`,
      ).toContain("restoreViewScroll(");
    }
    const restoreSites = src.match(/restoreViewScroll\(/g) ?? [];
    // 定义 1 处 + 调用点（切标签 / 关标签 / 搬标签 / 挂载 / 重建实例 …）
    expect(restoreSites.length, "还原滚动的调用点必须覆盖所有整态切换").toBeGreaterThanOrEqual(6);
  });

  it("会话与跨窗口载荷都要带 scrollTop", () => {
    expect(src, "会话记录要带 scrollTop").toMatch(/scrollTop: viewportOfTab\(/);
    expect(src, "恢复会话时要接住 scrollTop").toMatch(/inst\.scrollTop = st\.scrollTop/);
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "TabSession 要有 scrollTop").toContain("scrollTop?: number | null");
    expect(api, "SatelliteTab 要有 scrollTop").toContain("scrollTop: number | null");
    const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rust, "Rust 会话结构要有 scroll_top，否则落盘时被丢掉").toContain(
      "pub scroll_top: Option<u32>",
    );
  });
});

// B181：切完标签编辑器必须有焦点。
//
// ⚠️ 这一条**只能用静态契约锁**：jsdom 不计算 CSS，隐藏元素照样 `focus()` 得上，
//    真机那个「对 display:none 元素 focus 静默失败」的行为在这里复现不出来。
//    所以这里锁的是**顺序不变量** —— 类切完之后必须再补一次焦点。
describe("B181 静态契约：切标签后编辑器必须拿到焦点", () => {
  const raw = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");
  const code = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const body = code(topLevelFnBody(raw, "function switchTab("));

  it("模式类切完之后必须再补一次 view.focus()", () => {
    expect(body, "应能定位 switchTab 函数体").not.toBe("");
    const apply = body.indexOf("applyPanelMode(panel);");
    const restore = body.indexOf("restoreViewScroll(p");
    expect(restore, "应能看到钉位置").toBeGreaterThan(-1);
    expect(apply, "应能看到模式类切换").toBeGreaterThan(-1);
    // ① B145 那一次仍要在钉位置之前（不能因为补焦点就把它挪走）
    expect(body.indexOf("view.focus();"), "B145：第一次 focus 仍在钉位置之前").toBeLessThan(
      restore,
    );
    // ② B181：`mode-preview` 会把 `.panel-editor` 设成 display:none（preview.css），
    //    而 `mode-*` 类是在 applyPanelMode 里才切的 —— 若只有它之前那一次 focus，
    //    上一份标签是预览态时焦点正打在隐藏元素上、**静默失败**；等类切回
    //    mode-source 编辑器可见了却没人聚焦 ⇒ 「切完标签光标消失了，按方向键没反应，
    //    得先点一下编辑区才能输入」。所以类切完必须**再补一次**。
    const focus2 = body.indexOf("view.focus();", apply);
    expect(focus2, "applyPanelMode 之后必须再补一次 view.focus()").toBeGreaterThan(apply);
    // ③ 补的那次要紧跟在类切完之后、预览还原之前（别漂到测量之后去）
    expect(focus2, "补焦点要排在预览还原之前").toBeLessThan(body.indexOf("restorePreviewScroll(p"));
  });

  it("反向验证：删掉补的那次 focus，B181 契约必须抓住", () => {
    const FOCUS = "view.focus();";
    const apply = body.indexOf("applyPanelMode(panel);");
    const focus2 = body.indexOf(FOCUS, apply);
    expect(focus2, "退化用的补焦点必须还在").toBeGreaterThan(apply);
    // 真的删掉（只改判据不改源码 = 假绿）
    const degraded = body.slice(0, focus2) + body.slice(focus2 + FOCUS.length);
    expect(
      degraded.indexOf(FOCUS, degraded.indexOf("applyPanelMode(panel);")),
      "退化后 applyPanelMode 之后不再有 focus",
    ).toBe(-1);
  });

  it("B182（续）：切完标签要延迟一拍再补一次焦点，盖过 WebView2 手势结束回焦", () => {
    // 左键 mousedown 不再拦默认焦点（那会废掉原生拖拽，标签拖不动），焦点被偷到 body 的
    // 副作用靠 switchTab 末尾这拍延迟补焦点化解：WebView2 手势结束后会把焦点归 body，
    // 若没有这拍延迟，CM6 的 10ms 失焦兜底会把 `cm-focused` 摘掉，光标一闪而过。
    const reFocus = /setTimeout\(\s*\(\)\s*=>\s*view\.focus\(\),\s*0\s*\)/;
    expect(body, "switchTab 末尾必须延迟一拍再 focus 一次").toMatch(reFocus);
  });

  it("反向验证：删掉延迟补焦点，B182 续契约必须抓住", () => {
    const reFocus = /setTimeout\(\s*\(\)\s*=>\s*view\.focus\(\),\s*0\s*\)/;
    expect(body, "退化用的延迟补焦点必须还在").toMatch(reFocus);
    const degraded = body.replace(reFocus, "/* 已删除延迟补焦点 */");
    expect(degraded, "退化后不应再匹配到延迟补焦点（否则这条断言形同虚设）").not.toMatch(reFocus);
  });
});

// B182：切完标签「看不到跳动的光标」。
//
// ⚠️ 根因不是「没聚焦」——B181 之后焦点确实拿到了（能输入、方向键有反应），缺的是
//    `.cm-focused` 类：CM6 的 `focus()` 只做 `focusPreventScroll` + `updateSelection`，
//    **不刷新那个类**（它只在 `updateAttrs()` 里按实时 `hasFocus` 重算）。切标签那一串
//    是「失焦 → 整态切换（此刻 hasFocus 还是假 ⇒ 类被剥掉）→ 立刻重新聚焦」，焦点虽
//    回来了却没人重算类；CM6 那个 10ms 的 `updateForFocusChange` 兜底又正好撞上
//    「hasFocus 与 notifiedFocused 两边都真」⇒ 判定焦点没变直接跳过 ⇒ 类永久缺失。
//    而 `.cm-cursor` 默认 `display:none`，只有 `&.cm-focused` 才 `display:block` 并挂上
//    闪烁动画 ⇒ 光标看不见也不闪；点一下编辑区派发事务才会把类算回来。
describe("B182 光标可见性：程序化聚焦后必须有 cm-focused", () => {
  function mount(): { handle: ReturnType<typeof createEditor>; host: HTMLElement } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { state } = makeTabState(
      "alpha\nbeta\ngamma",
      null,
      { dark: false, wrap: true, perf: perfProfileFor("normal") },
      () => {},
    );
    return { handle: createEditor(host, state), host };
  }
  const otherState = (): ReturnType<typeof makeTabState>["state"] =>
    makeTabState(
      "second document",
      null,
      { dark: false, wrap: true, perf: perfProfileFor("normal") },
      () => {},
    ).state;

  it("focus() 之后必须带上 cm-focused（光标靠它才显示、才闪）", () => {
    const { handle, host } = mount();
    handle.focus();
    expect(handle.view.hasFocus, "前置：编辑器拿到了焦点").toBe(true);
    expect(
      handle.view.dom.classList.contains("cm-focused"),
      "焦点在编辑器里就得有 cm-focused，否则 .cm-cursor 是 display:none",
    ).toBe(true);
    handle.view.destroy();
    host.remove();
  });

  it("整态切换（切标签换文档）剥掉类之后，重新聚焦要把它补回来", async () => {
    const { handle, host } = mount();
    // ① 编辑器本来有焦点（用户正在打字）；等一拍让 CM6 自己那条 10ms 兜底也落定，
    //    类与它内部的属性副本（updateAttrs 的缓存）都归位 —— 这才是真机的稳态。
    handle.focus();
    await wait(20);
    expect(handle.view.hasFocus, "前置：编辑器有焦点").toBe(true);
    expect(handle.view.dom.classList.contains("cm-focused"), "前置：有焦点就有类").toBe(true);

    // ② 点标签：真机是 mousedown 把焦点带走的（jsdom 不自动做，手动 blur）。
    //    刻意**不等**那 10ms —— 真机上换文档也是紧接着发生的。
    handle.view.contentDOM.blur();
    expect(handle.view.hasFocus, "前置：编辑器已失焦").toBe(false);

    // ③ 换文档：CM6 在 updateAttrs() 里按**当时**的 hasFocus 重算类 ⇒ 剥掉
    handle.setState(otherState());
    expect(
      handle.view.dom.classList.contains("cm-focused"),
      "前置：整态切换在失焦态下把类剥掉了",
    ).toBe(false);

    // ④ switchTab 紧接着重新聚焦 —— 焦点回来了，类也必须跟着回来
    handle.focus();
    expect(handle.view.hasFocus, "前置：焦点已回到编辑器").toBe(true);
    expect(
      handle.view.dom.classList.contains("cm-focused"),
      "光标看不见的真因：焦点在、类没了 ⇒ .cm-cursor 依旧 display:none",
    ).toBe(true);
    handle.view.destroy();
    host.remove();
  });

  it("反向验证：退化实现（focus() 只调 CM6 的 focus）拿不到 cm-focused", () => {
    // 这条用例回答「上面两条是不是恒真」：CM6 的 `focus()` 自己并不会刷类，
    //   所以「focus() 之后类就在」只有显式对齐才成立 —— 这里真的退化着跑一遍。
    const { handle, host } = mount();
    handle.view.contentDOM.blur();
    handle.setState(otherState());
    handle.view.focus(); // 退化：只调 CM6 的 focus()，不做类对齐
    expect(handle.view.hasFocus, "退化实现里焦点依然拿到了（B181 之后）").toBe(true);
    expect(
      handle.view.dom.classList.contains("cm-focused"),
      "退化实现必须拿不到类（否则这个修复就是多余的）",
    ).toBe(false);
    handle.view.destroy();
    host.remove();
  });
});

describe("B182 静态契约：聚焦出口必须重算 cm-focused", () => {
  const raw = readFileSync("src/editor/editor.ts", "utf-8").replace(/\r\n/g, "\n");
  const code = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const createBody = code(topLevelFnBody(raw, "export function createEditor("));
  const focusBody = createBody.slice(createBody.indexOf("focus:"));

  it("createEditor 的 focus 出口：focus() 之后必须补一次空更新", () => {
    expect(focusBody, "应能定位 focus 出口").not.toBe("");
    const f = focusBody.indexOf("view.focus();");
    expect(f, "必须真的聚焦").toBeGreaterThan(-1);
    // `updateAttrs()`（cm-focused 唯一会被重算的地方）只在构造 / 整态切换 / 事务
    // 更新时跑；空更新就是 CM6 自己那条 10ms 兜底用的同一条路，只是提前到现在。
    const u = focusBody.indexOf("view.update([]);");
    expect(u, "聚焦之后必须补一次空更新，否则 cm-focused 不会重算").toBeGreaterThan(f);
  });

  it("反向验证：删掉那次空更新，B182 契约必须抓住", () => {
    const UPDATE = "view.update([]);";
    const at = focusBody.indexOf(UPDATE);
    expect(at, "退化用的空更新必须还在").toBeGreaterThan(-1);
    // 真的删掉（只改判据不改源码 = 假绿）
    const degraded = focusBody.slice(0, at) + focusBody.slice(at + UPDATE.length);
    expect(degraded, "退化后不再有空更新").not.toContain(UPDATE);
  });
});
