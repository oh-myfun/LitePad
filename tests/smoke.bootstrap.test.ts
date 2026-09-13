// @vitest-environment jsdom
// 启动期 + 拖拽分屏 烟雾测试：在 jsdom 中真实执行 bootstrap() 与拖拽落点，
// 捕获任何运行时异常 / 状态损坏。若 bootstrap 或拖拽后编辑器空白、窗口无响应，
// 说明“打开文档空白 + 关闭窗口无响应”源于崩溃或状态损坏。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

// ---- 注入真实 index.html 的 DOM 结构（启动前必须存在）----
beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

// ---- jsdom 缺失的浏览器 API 兜底（真实 WebView2 自带，仅 jsdom 需要）----
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error 测试环境补丁
    window.matchMedia = (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!window.requestAnimationFrame) {
    // @ts-expect-error 测试环境补丁
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as unknown as number;
    // @ts-expect-error 测试环境补丁
    window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
  // jsdom 24 未实现 Range.getClientRects/getBoundingClientRect，
  // 而 CodeMirror 在 mousedown 处理里会调用 → 抛 “getClientRects is not a function”。
  // WebView2（Chromium）原生支持，这里补一个空实现让交互测试可运行。
  if (typeof (window.Range?.prototype as { getClientRects?: unknown }).getClientRects !== "function") {
    const rangeProto = window.Range.prototype as unknown as {
      getClientRects: () => DOMRectList;
      getBoundingClientRect: () => DOMRect;
    };
    rangeProto.getClientRects = () => [] as unknown as DOMRectList;
    rangeProto.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
});

// ---- 记录启动期 / 事件期未捕获异常 ----
let capturedError: unknown = null;
process.on("unhandledRejection", (e) => { capturedError = e; });
beforeAll(() => {
  window.addEventListener("error", (e) => { capturedError = (e as ErrorEvent).error ?? (e as ErrorEvent).message; });
});

// ---- 桩：Tauri 运行时 ----
const closeRequestedHandlers: Array<(e: { preventDefault: () => void }) => void> = [];
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    onCloseRequested: (cb: (e: { preventDefault: () => void }) => void) => {
      closeRequestedHandlers.push(cb);
      return Promise.resolve({ catch: () => {} });
    },
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
}));

// ---- 桩：原生拖放事件（文件拖入窗口）----
// 测试通过 dragDropHandlers 手动触发 drop，断言 doOpen 被驱动
const dragDropHandlers: Array<(ev: { payload: unknown }) => void> = [];
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (ev: { payload: unknown }) => void) => {
      dragDropHandlers.push(cb);
      return Promise.resolve({ unlisten: () => {} });
    },
  }),
}));

function fireDragDrop(paths: string[]): void {
  const cb = dragDropHandlers[dragDropHandlers.length - 1];
  if (!cb) throw new Error("onDragDropEvent 未注册");
  cb({ payload: { type: "drop", paths, position: { Logical: { x: 0, y: 0 } } } });
}

// ---- 桩：IPC 层 ----
// 打开对话框返回值可编程（供"打开文件"回归测试驱动 doOpen）
const openDialogResult: { value: string | null } = { value: null };
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(openDialogResult.value),
  save: () => Promise.resolve(null),
}));
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
        { active: 0, tabs: [{ path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 }] },
        // 同一路径出现两次：应创建两个同源实例（内容同步，内存一份）
        { active: 0, tabs: [{ path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 }, { path: "b.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 }] },
      ],
    }),
  loadSettings: () =>
    Promise.resolve({ theme: "system", word_wrap: true, font_size: 14, default_encoding: "UTF-8", default_eol: "CRLF" }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (_path: string) =>
    Promise.resolve({
      tabId:
        _path === "a.md"
          ? 101
          : _path === "b.md"
            ? 102
            : _path === "c.md"
              ? 103
              : _path === "d.md"
                ? 104
                : 105,
      text: _path === "a.md"
        ? "hello world from A"
        : _path === "b.md"
          ? "second document from B"
          : _path === "c.md"
            ? "third document from C"
            : _path === "d.md"
              ? "fourth document from D"
              : "fifth document from E",
      name: _path,
      path: _path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
    }),
  reloadFile: () =>
    Promise.resolve({ tabId: 1, text: "", name: "x", path: "x", encoding: "UTF-8", eol: "LF", readonly: false, mixedEol: false }),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  searchFiles: () => Promise.resolve([]),
}));

// 指针事件序列（标签拖拽已从 HTML5 DnD 改为 mousedown/mousemove/mouseup 编排）
function mouse(type: string, x: number, y: number, ctrlKey = false): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    ctrlKey,
  });
}

/** 面板按文档顺序横向排布（每个 200x200，间隔 10），标签固定 20x24：
 *  jsdom 无布局，命中测试（panelAt/tabUnder）全靠该桩。 */
function installRectStubs(): () => void {
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const mk = (left: number, top: number, w: number, h: number) =>
      ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;
    if (this.classList.contains("layout-panel")) {
      const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(this);
      return mk(Math.max(0, idx) * 210, 0, 200, 200);
    }
    // B27：tab 区必须是面板顶部的窄条——否则整个面板都被当成 tab 区，
    // 拖拽落点全被判定为「排序」而永远无法分屏
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

/** 模拟一次标签拖拽：mousedown(标签) → mousemove(落点) → mouseup(落点)。 */
function dragTab(tab: HTMLElement, fromX: number, fromY: number, toX: number, toY: number, ctrlKey = false): void {
  tab.dispatchEvent(mouse("mousedown", fromX, fromY));
  document.dispatchEvent(mouse("mousemove", Math.round((fromX + toX) / 2), Math.round((fromY + toY) / 2), ctrlKey));
  document.dispatchEvent(mouse("mousemove", toX, toY, ctrlKey));
  document.dispatchEvent(mouse("mouseup", toX, toY, ctrlKey));
}

/** 真实点击 = mousedown + click（mousedown 会重置拖拽吞击标记）。 */
function clickTab(tab: HTMLElement): void {
  tab.dispatchEvent(mouse("mousedown", 5, 5));
  tab.dispatchEvent(mouse("click", 5, 5));
}

describe("bootstrap + drag-split smoke", () => {
  it("启动正常、内容渲染、拖拽分屏后状态仍有效", async () => {
    await import("../src/main");
    await new Promise((r) => setTimeout(r, 300));
    capturedError = null; // 启动期 mock 噪声清零

    const layoutArea = document.getElementById("layout-area");
    expect(layoutArea, "layout-area 应存在").toBeTruthy();
    expect(layoutArea?.querySelector(".panel-editor .cm-editor"), "应挂载编辑器").toBeTruthy();
    const content = layoutArea?.querySelector(".cm-content")?.textContent ?? "";
    expect(content, "编辑器应渲染文档内容").toContain("hello world");
    expect(layoutArea?.querySelectorAll(".layout-panel").length, "应有两个面板").toBe(2);
    expect(closeRequestedHandlers.length, "窗口关闭处理器应已注册").toBeGreaterThan(0);

    // ---- 同源实例同步：a.md 在两个面板各有一个实例，编辑任一实时同步 ----
    const allViews = Array.from(document.querySelectorAll(".cm-editor"))
      .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
      .filter((v): v is EditorView => !!v);
    expect(allViews.length, "两个面板都应挂载编辑器视图").toBe(2);
    // 恢复会话后两个面板的活动标签都是 a.md（同源实例）
    expect(allViews[0].state.doc.toString(), "面板0 应载入 a.md").toContain("hello world");
    expect(allViews[1].state.doc.toString(), "面板1 应载入 a.md").toContain("hello world");
    allViews[0].dispatch({ changes: { from: 0, insert: "SYNC-MARK " } });
    await new Promise((r) => setTimeout(r, 30));
    expect(
      allViews[1].state.doc.toString(),
      "面板1 的同源实例应实时跟随内容变更",
    ).toContain("SYNC-MARK hello world");
    const marks = Array.from(document.querySelectorAll(".tab-mark")).map((m) => m.textContent ?? "");
    expect(marks.some((m) => m.includes("●")), "脏标记应出现在标签上").toBe(true);

    // ---- 模拟把面板0的标签拖到面板1的左侧区域（应触发 splitPanelWithTab）----
    const panels = Array.from(layoutArea!.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(panels.length, "应有两个面板").toBe(2);
    const panel0 = panels[0];
    const panel1 = panels[1];
    const tab0 = panel0.querySelector(".tab") as HTMLElement;
    expect(tab0, "面板0应有标签").toBeTruthy();

    // 面板横向排布桩：panel1 左缘在 210，落点 (215,100) → 面板1 左侧区域
    const restoreRects = installRectStubs();
    // 拖拽光标：进入拖拽态后 body 必须带 tab-drag-active（grabbing 光标），松手移除
    tab0.dispatchEvent(mouse("mousedown", 10, 12));
    document.dispatchEvent(mouse("mousemove", 100, 60));
    expect(document.body.classList.contains("tab-drag-active"), "拖拽中应有 grabbing 光标类").toBe(
      true,
    );
    document.dispatchEvent(mouse("mousemove", 215, 100));
    document.dispatchEvent(mouse("mouseup", 215, 100));
    expect(document.body.classList.contains("tab-drag-active"), "松手后光标类应移除").toBe(false);
    restoreRects();

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedError, `拖拽落点不应抛错：${String(capturedError)}`).toBeNull();

    // 拖拽后：面板0 已被并走、面板1 旁新增面板；至少仍应有面板且编辑器带内容
    const panelsAfter = document.querySelectorAll(".layout-panel").length;
    expect(panelsAfter, "拖拽后应有面板").toBeGreaterThanOrEqual(2);
    const editorsAfter = document.querySelectorAll(".panel-editor .cm-editor").length;
    expect(editorsAfter, "拖拽后编辑器应仍在").toBeGreaterThan(0);
    const anyContent = document.querySelector(".cm-content")?.textContent ?? "";
    expect(anyContent.length, "拖拽后应有可见文档内容").toBeGreaterThan(0);
    expect(closeRequestedHandlers.length, "窗口关闭处理器仍应已注册").toBeGreaterThan(0);

    // ---- 同面板边缘拖放（落在编辑器内容上）：应真正分屏，且正文不被插入数字 ----
    // 面板按文档顺序横向排布；取最后一个面板自身左缘区域落点 → 同面板水平分屏
    const panelsMid = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    const selfPanel = panelsMid[panelsMid.length - 1];
    const selfTab = selfPanel.querySelector(".tab") as HTMLElement;
    expect(selfTab, "分屏面板应有标签").toBeTruthy();
    const beforeSelf = document.querySelectorAll(".layout-panel").length;
    const restoreRects2 = installRectStubs();
    // selfLeft 必须在装上几何桩之后读取（jsdom 无布局时全为 0）；
    // 落点 y=100 在 tab 区（高 24px）之下 → 面板区边缘 → 分屏
    const selfLeft = selfPanel.getBoundingClientRect().left;
    dragTab(selfTab, 10, 12, selfLeft + 10, 100);
    restoreRects2();
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedError, `同面板边缘拖放不应抛错：${String(capturedError)}`).toBeNull();
    expect(
      document.querySelectorAll(".layout-panel").length,
      "同面板边缘拖放应真正分屏（面板数 +1）",
    ).toBe(beforeSelf + 1);
    const textsAfter = Array.from(document.querySelectorAll(".cm-content")).map((c) => c.textContent ?? "");
    expect(
      textsAfter.some((t) => t === "SYNC-MARK hello world from A"),
      "被拖动文档应原样出现在新分屏",
    ).toBe(true);
    expect(
      textsAfter.some((t) => /from A\s*\d/.test(t)),
      "CM 不应把 tabId 数字插入正文",
    ).toBe(false);
  });

  it("主题按钮每次点击都必须切换明暗（回归：深色切浅色要点两下才生效）", async () => {
    // 用户报告：深浅色按钮有时候要点两下才生效。
    // 根因是旧的 system→light→dark 循环在系统偏好与当前态一致时视觉无变化；
    // 回归断言：任意连续两次点击，dataset.theme 都必须翻转。
    const btn = document.getElementById("btn-theme") as HTMLButtonElement | null;
    expect(btn, "btn-theme 应存在").toBeTruthy();
    const themeOf = () => document.documentElement.dataset.theme;
    const first = themeOf();
    expect(first, "初始应有明暗状态").toBeTruthy();

    btn!.click();
    await new Promise((r) => setTimeout(r, 20));
    const second = themeOf();
    expect(second, "第一次点击必须改变明暗").not.toBe(first);

    btn!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(themeOf(), "第二次点击必须切回").not.toBe(second);
  });

  it("新建标签必须是空白文档（回归：attach 后 rebuild 快照回写污染新标签）", async () => {
    // 机制：attachTabToPanel 已把 activeTabId 指向新标签，而视图仍显示旧标签；
    // 若 rebuildLayout 的回写按 activeTabId 寻址，会把旧文档内容写进新标签。
    const strips = Array.from(document.querySelectorAll(".panel-tabstrip")) as HTMLElement[];
    expect(strips.length).toBeGreaterThan(0);
    const before = document.querySelectorAll(".cm-content").length;
    strips[0].dispatchEvent(new Event("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120)); // newUntitled 内部有 ipcNewTab 异步
    const contents = Array.from(document.querySelectorAll(".cm-content")).map((c) => c.textContent ?? "");
    expect(contents.length, "新建后面板数不减").toBeGreaterThanOrEqual(before);
    // 新建标签应插入一个空文档视图；任何视图都不应凭空出现旧文档内容重复
    const emptyish = contents.filter((t) => t.length === 0);
    expect(emptyish.length, "应存在一个空的新建标签视图").toBeGreaterThanOrEqual(1);
  });

  it("打开文件必须立即显示内容（回归：打开后内容空白）", async () => {
    // 用户报告：打开文件内容全空白，重启会话恢复后同一文件却正常。
    // 通过“打开”按钮驱动 doOpen（对话框 mock 返回路径），断言挂载视图立即有内容。
    openDialogResult.value = "c.md";
    const btn = document.getElementById("btn-open") as HTMLButtonElement | null;
    expect(btn, "btn-open 应存在").toBeTruthy();
    btn!.click();
    await new Promise((r) => setTimeout(r, 120));
    openDialogResult.value = null;

    expect(capturedError, `打开文件不应抛错：${String(capturedError)}`).toBeNull();
    const contents = Array.from(document.querySelectorAll(".cm-content")).map(
      (c) => c.textContent ?? "",
    );
    expect(
      contents.some((t) => t.includes("third document from C")),
      `打开的文件应立即显示内容，实际视图内容：${JSON.stringify(contents)}`,
    ).toBe(true);
  });

  it("打开文件后切换标签再切回，内容必须保持（回归：打开后内容空白）", async () => {
    // 用户报告：打开文件内容全空白，重启会话恢复后同一文件却正常。
    // 会话恢复按路径重读磁盘，因此该现象说明前端内存中的标签状态被污染。
    // 本用例覆盖最常见链路：打开 → 切走 → 切回，内容必须原样保留。
    openDialogResult.value = "d.md";
    (document.getElementById("btn-open") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 120));
    openDialogResult.value = null;

    const tabOf = (name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
        (el) => el.title === name,
      );
    const dTab = tabOf("d.md");
    expect(dTab, "打开的 d.md 应出现在标签条").toBeTruthy();
    const strip = dTab!.closest(".panel-tabstrip") as HTMLElement;
    const panelEl = dTab!.closest(".layout-panel") as HTMLElement;
    const otherTab = Array.from(strip.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.title !== "d.md",
    );
    expect(otherTab, "所在面板应有其他标签可供切换").toBeTruthy();

    // 切走
    clickTab(otherTab!);
    await new Promise((r) => setTimeout(r, 60));
    const viewIn = (el: HTMLElement) => {
      const dom = el.querySelector(".cm-editor");
      return dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
    };
    const away = viewIn(panelEl);
    expect(away?.state.doc.toString() ?? "", "切走后不应显示 d.md 内容").not.toContain(
      "fourth document from D",
    );

    // 切回
    clickTab(dTab!);
    await new Promise((r) => setTimeout(r, 60));
    const back = viewIn(panelEl);
    expect(
      back?.state.doc.toString() ?? "",
      "切回后 d.md 内容必须原样保留（空白即为回归）",
    ).toContain("fourth document from D");
  });

  it("重新打开已在标签中的文件（reused 分支）必须仍显示内容", async () => {
    // doOpen 的 reused 分支：切换到已有实例而非新建。任何一步都不应造成内容丢失。
    const viewsWithD = () =>
      Array.from(document.querySelectorAll(".cm-editor"))
        .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
        .filter((v): v is EditorView => !!v)
        .filter((v) => v.state.doc.toString().includes("fourth document from D"));

    openDialogResult.value = "d.md";
    (document.getElementById("btn-open") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 120));
    openDialogResult.value = null;

    expect(capturedError, `reused 打开不应抛错：${String(capturedError)}`).toBeNull();
    const shown = viewsWithD();
    expect(shown.length, "reused 打开后应仍有一个实例显示内容（不得清空/重复建实例）").toBe(1);
  });

  it("连续打开两个文件，切回先前文件内容不得丢失（回归：打开后内容空白）", async () => {
    // 复现「打开 → 打开另一个 → 切回第一个」的污染类缺陷：打开新文件后，
    // 先前文件变为离屏标签是正常行为；但切回时其内容必须原样保留。
    const views = () =>
      Array.from(document.querySelectorAll(".cm-editor"))
        .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
        .filter((v): v is EditorView => !!v);

    openDialogResult.value = "c.md";
    (document.getElementById("btn-open") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 120));
    openDialogResult.value = null;

    expect(
      views().some((v) => v.state.doc.toString().includes("third document from C")),
      "新打开的 c.md 应立即显示内容",
    ).toBe(true);

    // 切回 d.md：内容必须还在（被清空即为用户报告的空白回归）
    const dTab = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.title === "d.md",
    );
    expect(dTab, "d.md 标签应仍存在").toBeTruthy();
    const panelEl = dTab!.closest(".layout-panel") as HTMLElement;
    clickTab(dTab!);
    await new Promise((r) => setTimeout(r, 60));
    const dom = panelEl.querySelector(".cm-editor");
    const back = dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
    expect(
      back?.state.doc.toString() ?? "",
      "切回 d.md 后内容必须原样保留（空白即为回归）",
    ).toContain("fourth document from D");
  });

  it("同面板点标签切换：mousedown 不得销毁被按下的标签（回归：标签切换失效）", async () => {
    // 用户报告：同一个面板内文件标签切换失效。
    // 根因：面板 mousedown → onActivatePanel → renderPanelTabs() 同步全量重绘，
    // 被按下的 .tab 被销毁重建，click 永远不会落在原元素上（×/中键关闭因
    // stopPropagation 幸免）。回归断言两层：
    // ① 同面板 mousedown 后原 .tab 元素必须仍在文档中（未被重绘替换）；
    // ② mousedown 之后对该元素派发 click，视图必须真的切过去。
    const cTab = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.title === "c.md",
    );
    expect(cTab, "c.md 标签应存在").toBeTruthy();
    const panelEl = cTab!.closest(".layout-panel") as HTMLElement;

    // ① 真实点击的第一步是 mousedown（冒泡到面板）：原元素必须存活
    cTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(cTab!.isConnected, "mousedown 后被按下的标签不得被重绘替换（替换即丢失 click）").toBe(
      true,
    );

    // ② 随后浏览器在原元素上派发 click：视图必须切换
    cTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80)); // 跨面板激活的延迟重绘也等完
    const dom = panelEl.querySelector(".cm-editor");
    const view = dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
    expect(
      view?.state.doc.toString() ?? "",
      "click 后该面板应显示 c.md 的内容",
    ).toContain("third document from C");
  });

  it("从资源管理器拖入文件必须打开该文件（回归：拖入变成插入内容）", async () => {
    // 用户报告：拖文件进窗口应打开文件，而不是把内容复制进当前文档。
    // 实现：dragDropEnabled: true + onDragDropEvent(drop)。
    // B24：拖入单个 Markdown 时先弹「打开文档 / 插入文件路径」选择菜单，
    // 选「打开」才真正打开；其他类型 / 多文件仍然直接打开。
    expect(dragDropHandlers.length, "onDragDropEvent 应在启动时注册").toBeGreaterThan(0);
    fireDragDrop(["e.md"]);
    await new Promise((r) => setTimeout(r, 120));

    expect(capturedError, `拖入文件不应抛错：${String(capturedError)}`).toBeNull();

    // B24：md 落地应弹选择菜单，且此时文件尚未打开
    const choiceMenu = document.querySelector(".popup-menu");
    expect(choiceMenu, "拖入 Markdown 应弹出 打开/插入路径 选择菜单").toBeTruthy();
    const choices = Array.from(choiceMenu!.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(choices.some((t) => t.includes("打开")), "应有「打开文档」项").toBe(true);
    expect(choices.some((t) => t.includes("插入文件路径")), "应有「插入文件路径」项").toBe(true);
    let contentsBefore = Array.from(document.querySelectorAll(".cm-content")).map(
      (c) => c.textContent ?? "",
    );
    expect(
      contentsBefore.some((t) => t.includes("fifth document from E")),
      "菜单未选择前不应直接打开",
    ).toBe(false);

    // 选择「打开」→ 文件作为新标签打开
    const openBtn = Array.from(choiceMenu!.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("打开"),
    )!;
    openBtn.click();
    await new Promise((r) => setTimeout(r, 120));

    const contents = Array.from(document.querySelectorAll(".cm-content")).map(
      (c) => c.textContent ?? "",
    );
    expect(
      contents.some((t) => t.includes("fifth document from E")),
      `拖入的 e.md 应作为新标签打开并显示内容，实际：${JSON.stringify(contents)}`,
    ).toBe(true);
    contentsBefore = [];
  });

  it("拖拽 tab 到 tab 区 = 调整顺序（B27：显示插入线而非分屏预览，也不分屏）", async () => {
    const restoreRects = installRectStubs();
    try {
      // 需要一个含两个标签的面板：panel1 = [a.md, b.md]（会话恢复即有）
      const panelWithTwo = (): HTMLElement | null =>
        (Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[]).find(
          (p) => p.querySelectorAll(".tab").length >= 2,
        ) ?? null;
      let target = panelWithTwo();
      if (!target) {
        // 前置用例可能改过布局：把 b.md 拖进含 a.md 的面板（面板区中央 = 移入）
        const amd = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
          (t) => t.title === "a.md",
        );
        const bmd = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
          (t) => t.title === "b.md",
        );
        expect(amd && bmd, "a.md 与 b.md 标签应可定位").toBeTruthy();
        const p = bmd!.closest(".layout-panel") as HTMLElement;
        const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(p);
        dragTab(amd!, 5, 5, idx * 210 + 100, 100);
        await new Promise((r) => setTimeout(r, 60));
        target = panelWithTwo();
      }
      expect(target, "应存在含两个标签的面板").toBeTruthy();
      const beforePanels = document.querySelectorAll(".layout-panel").length;
      const beforeCount = target!.querySelectorAll(".tab").length;

      // 拖该面板的第一个标签到 tab 区末尾（y=12 在 24px 高的 strip 内）→ 追加
      const firstTab = target!.querySelector(".tab") as HTMLElement;
      const firstName = firstTab.title;
      const stripLeft = target!.querySelector(".panel-tabstrip")!.getBoundingClientRect().left;
      firstTab.dispatchEvent(mouse("mousedown", 5, 5));
      document.dispatchEvent(mouse("mousemove", Math.round(stripLeft) + 150, 12));
      document.dispatchEvent(mouse("mouseup", Math.round(stripLeft) + 150, 12));
      await new Promise((r) => setTimeout(r, 60));

      expect(
        document.querySelectorAll(".layout-panel").length,
        "tab 区落下不得分屏（面板数不变）",
      ).toBe(beforePanels);
      expect(document.body.classList.contains("tab-drag-active"), "拖拽光标类应移除").toBe(false);
      expect(document.querySelector(".tab-insert"), "松手后插入指示线应移除").toBeNull();
      const names = Array.from(target!.querySelectorAll(".tab")).map((t) => t.title);
      expect(names[names.length - 1], "被拖标签应追加到末尾").toBe(firstName);
      expect(names.length, "标签总数不变").toBe(beforeCount);
    } finally {
      restoreRects();
    }
  });

  it("跨面板点击 tab 必须一次激活（回归：要点两下才激活）", async () => {
    // 用户报告：更换面板点击 tab 标签，没法马上激活，要再点一下。
    // 根因链：面板 mousedown → onActivatePanel 曾延迟重绘标签条，真实用户
    // 按住鼠标期间 timeout 触发 → 销毁光标下的 .tab → click 丢失。
    // 修复后 onActivatePanel 完全不重绘；单击必须直接切换并显示内容。
    const cTab = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.title === "c.md",
    );
    expect(cTab, "c.md 标签应存在").toBeTruthy();
    const cPanel = cTab!.closest(".layout-panel") as HTMLElement;

    // 找一个不在 c.md 所在面板的标签（跨面板点击）
    const target = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.title === "a.md" && el.closest(".layout-panel") !== cPanel,
    );
    expect(target, "应存在其他面板中的 a.md 标签").toBeTruthy();
    const targetPanel = target!.closest(".layout-panel") as HTMLElement;

    // 真实点击：mousedown 与 click 之间有按压间隔（≥ 一帧）。
    // 旧实现的 setTimeout 延迟重绘会在此间隔内触发、销毁光标下的标签。
    target!.dispatchEvent(mouse("mousedown", 5, 5));
    await new Promise((r) => setTimeout(r, 15));
    expect(
      target!.isConnected,
      "按压期间（跨面板激活后）标签不得被重绘替换",
    ).toBe(true);
    target!.dispatchEvent(mouse("click", 5, 5));
    await new Promise((r) => setTimeout(r, 80));

    const dom = targetPanel.querySelector(".cm-editor");
    const view = dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
    expect(
      view?.state.doc.toString() ?? "",
      "跨面板单击后该面板应立即显示被点击标签的内容",
    ).toContain("hello world from A");
  });

  it("深浅色切换时所有面板的编辑器必须一起变（回归：部分面板不跟随）", async () => {
    // 用户报告：深浅色切换，所有面板要一起跟着变。
    // 断言：点击主题按钮后，每一个已挂载面板的 CodeMirror 明暗状态都同步翻转。
    const btn = document.getElementById("btn-theme") as HTMLButtonElement | null;
    expect(btn, "btn-theme 应存在").toBeTruthy();
    const viewsOf = () =>
      Array.from(document.querySelectorAll(".cm-editor"))
        .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
        .filter((v): v is EditorView => !!v);
    const darkFlags = () => viewsOf().map((v) => v.state.facet(EditorView.darkTheme));

    const before = darkFlags();
    expect(before.length, "应存在已挂载的编辑器视图").toBeGreaterThan(0);
    const target = !before[0];

    btn!.click();
    await new Promise((r) => setTimeout(r, 30));
    const mid = darkFlags();
    expect(
      mid.every((d) => d === target),
      `所有面板编辑器都应切到${target ? "深色" : "浅色"}，实际：${String(mid)}`,
    ).toBe(true);

    btn!.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(
      darkFlags().every((d) => d === before[0]),
      "切回应同步还原所有面板",
    ).toBe(true);
  });

  it("大纲点击跳转必须同步同文件全部实例（回归：只跳活动面板）", async () => {
    const restoreRects = installRectStubs();
    try {
      // 准备：让至少两个面板显示同一文档 a.md（同源实例）。
      // 前置测试可能移动/新开标签甚至改变面板数，这里不假设布局：
      // 找到 a.md 标签 → 若仅一个面板持有，Ctrl 拖拽复制出第二实例 → 逐面板激活 a.md。
      const viewsOf = () =>
        Array.from(document.querySelectorAll(".cm-editor"))
          .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
          .filter((v): v is EditorView => !!v);
      const panelTabs = (p: HTMLElement) =>
        Array.from(p.querySelectorAll(".tab")) as HTMLElement[];
      const tabIsAmd = (t: HTMLElement) => (t.textContent ?? "").includes("a.md");

      let panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
      const findAmdTab = (): { tab: HTMLElement; panel: HTMLElement } | null => {
        for (const p of panels) {
          const t = panelTabs(p).find(tabIsAmd);
          if (t) return { tab: t, panel: p };
        }
        return null;
      };
      let loc = findAmdTab();
      if (!loc) {
        fireDragDrop(["a.md"]);
        await new Promise((r) => setTimeout(r, 30));
        loc = findAmdTab();
      }
      expect(loc, "a.md 应可定位").toBeTruthy();
      const holders = () => panels.filter((p) => panelTabs(p).some(tabIsAmd));
      if (holders().length < 2) {
        // 复制到第一个不含 a.md 的面板左侧区域（Ctrl=复制实例）
        const target = panels.find((p) => !panelTabs(p).some(tabIsAmd));
        expect(target, "应存在可复制入的目标面板").toBeTruthy();
        const rect = loc!.tab.getBoundingClientRect();
        const tIdx = panels.indexOf(target!);
        dragTab(loc!.tab, rect.left + 5, rect.top + 5, tIdx * 210 + 5, 100, true);
        await new Promise((r) => setTimeout(r, 30));
        panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
      }
      expect(holders().length, "复制后至少两个面板持有 a.md").toBeGreaterThanOrEqual(2);
      for (const p of holders()) {
        const t = panelTabs(p).find(tabIsAmd)!;
        clickTab(t);
        await new Promise((r) => setTimeout(r, 20));
      }

      // 以内容特征锁定“显示 a.md 的视图”（可能多于两个：复制会分裂出新面板）
      const amdViewsBefore = viewsOf().filter((v) =>
        v.state.doc.toString().includes("hello world"),
      );
      expect(amdViewsBefore.length, "至少两个视图显示 a.md").toBeGreaterThanOrEqual(2);

      // 写入带标题的 markdown（同源广播会同步到其余实例）
      const md = "# 第一题\n\n正文\n\n## 第二题\n";
      amdViewsBefore[0].dispatch({
        changes: { from: 0, to: amdViewsBefore[0].state.doc.length, insert: md },
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(
        amdViewsBefore[1].state.doc.toString(),
        "第二实例应同步到新内容",
      ).toBe(md);

      // 打开大纲
      const btnOutline = document.getElementById("btn-outline") as HTMLButtonElement;
      expect(btnOutline, "btn-outline 应存在").toBeTruthy();
      btnOutline.click();
      await new Promise((r) => setTimeout(r, 20));
      const itemOf = () =>
        Array.from(document.querySelectorAll("#toc-panel .toc-item")) as HTMLElement[];
      expect(itemOf().length, "大纲应渲染两个标题").toBe(2);

      // 点击第二个标题（## 第二题，第 5 行）
      const h2Pos = amdViewsBefore[0].state.doc.line(5).from;
      // B29：拦截全部视图的 dispatch——源码模式跳转必须携带 y:"start" 滚动效果
      // （把标题行顶到视口顶部），不得再用最小滚动的 scrollIntoView:true（会贴底）
      const dispatchSpecs: Array<Record<string, unknown>> = [];
      const wrapped = viewsOf().map((v) => {
        const orig = v.dispatch.bind(v);
        (v as unknown as { dispatch: unknown }).dispatch = (spec: unknown) => {
          dispatchSpecs.push(spec as Record<string, unknown>);
          return orig(spec as Parameters<typeof orig>[0]);
        };
        return v;
      });
      itemOf()[1].click();
      await new Promise((r) => setTimeout(r, 20));
      wrapped.forEach((v) => {
        delete (v as unknown as { dispatch?: unknown }).dispatch;
      });
      const hasStartScroll = dispatchSpecs.some((spec) => {
        const effs = Array.isArray(spec.effects)
          ? spec.effects
          : spec.effects
            ? [spec.effects]
            : [];
        return effs.some((ef) => (ef as { value?: { y?: string } })?.value?.y === "start");
      });
      expect(hasStartScroll, "源码模式大纲跳转必须以 y:start 滚动（行顶到视口顶部）").toBe(true);
      expect(
        dispatchSpecs.some((spec) => spec.scrollIntoView === true),
        "不得再用最小滚动的 scrollIntoView:true",
      ).toBe(false);

      // 断言：每一个 a.md 实例选区都跳到该标题行首
      for (const [i, v] of amdViewsBefore.entries()) {
        expect(
          v.state.selection.main.head,
          `实例${i} 应跳到「## 第二题」行首`,
        ).toBe(h2Pos);
      }
      // 大纲活动项高亮应更新到点击的标题
      const activeItems = document.querySelectorAll("#toc-panel .toc-active");
      expect(activeItems.length, "应有活动高亮项").toBe(1);
      expect(activeItems[0].textContent, "高亮应落在「## 第二题」").toContain("第二题");

      // 收起大纲，避免影响其他状态
      btnOutline.click();
    } finally {
      restoreRects();
    }
  });
});
