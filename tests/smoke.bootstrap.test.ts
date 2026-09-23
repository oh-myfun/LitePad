// @vitest-environment jsdom
// 启动期 + 拖拽分屏 烟雾测试：在 jsdom 中真实执行 bootstrap() 与拖拽落点，
// 捕获任何运行时异常 / 状态损坏。若 bootstrap 或拖拽后编辑器空白、窗口无响应，
// 说明“打开文档空白 + 关闭窗口无响应”源于崩溃或状态损坏。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { fireDrag, makeDataTransfer } from "./dnd";

// ---- 注入真实 index.html 的 DOM 结构（启动前必须存在）----
beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

// ---- jsdom 缺失的浏览器 API 兜底 ----
// matchMedia / requestAnimationFrame / Range.getClientRects 等贴片已统一到
// tests/setup.ts，由 vite.config.ts 的 test.setupFiles 对所有测试文件生效。

// ---- 记录启动期 / 事件期未捕获异常 ----
let capturedError: unknown = null;
process.on("unhandledRejection", (e) => {
  capturedError = e;
});
beforeAll(() => {
  window.addEventListener("error", (e) => {
    capturedError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
  });
});

// ---- 桩：Tauri 运行时 ----
const closeRequestedHandlers: Array<(e: { preventDefault: () => void }) => void> = [];
// B99「钉在顶部」的桩必须**有状态**：记住置顶值供回读，并记录每次 set 的入参。
// 无状态桩（恒 false / 空实现）只能验出「调了 API」，验不出「按钮状态真的跟着窗口状态走」——
// 而后者才是这条回归要守的：真机上 ACL 漏授权时 set 不生效、回读还是旧值，
// 无状态桩两种情况都照样绿。用 vi.hoisted 是因为 vi.mock 的工厂会被提升到 import 之前。
// `swallowSet` 用来复现「set 调了但没生效」——只有它能把「按回读值点亮」和
// 「把目标值当新状态写界面」这两种实现区分开（前者保持熄灯、后者会留下一个假的点亮态）。
const pinState = vi.hoisted(() => ({ on: false, sets: [] as boolean[], swallowSet: false }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    // B97 自建标题栏：最大化键的图标要跟着窗口状态走，桩必须补这两个 API
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    isAlwaysOnTop: () => Promise.resolve(pinState.on),
    setAlwaysOnTop: (v: boolean) => {
      pinState.sets.push(v);
      if (!pinState.swallowSet) pinState.on = v;
      return Promise.resolve();
    },
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
  // B71 ④：跨窗口同步要广播变更集。缺了 emit 的话 handleUpdate 里的广播会同步抛错
  // （CM6 只把它记成一条 listener error），测试就变成「看着是绿的、其实编辑路径带伤」。
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
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

/**
 * 触发一次原生拖放 drop。
 *
 * `pos` 是**物理像素**坐标，与 Tauri 的 `PhysicalPosition` 一致（main 里按
 * devicePixelRatio 换算成逻辑像素再命中面板）。默认 (-1,-1) 表示**不在任何面板内**
 * —— 也就是「拖到窗口空白处」，此时按没有落点面板处理（直接打开、不弹选择菜单）。
 *
 * ⚠️ 早先这里传的是 `{ Logical: {...} }`，而真实载荷的 `position` 是 `{ x, y }`，
 * 于是落点一直是 undefined（换算成 NaN、panelAt 永远返回 null）—— 落点分支其实
 * 从没被测到。B70 把菜单判据改成「看落点」之后这里必须给真坐标。
 */
function fireDragDrop(paths: string[], pos: { x: number; y: number } = { x: -1, y: -1 }): void {
  const cb = dragDropHandlers[dragDropHandlers.length - 1];
  if (!cb) throw new Error("onDragDropEvent 未注册");
  cb({ payload: { type: "drop", paths, position: pos } });
}

// ---- 桩：IPC 层 ----
// 打开对话框返回值可编程（供"打开文件"回归测试驱动 doOpen）
const openDialogResult: { value: string | null } = { value: null };
/**
 * 记录**最后一次落盘的 settings**（B79）。
 * 主题不存盘那个 bug 的本质是「存了，但存的是没被改过的对象」——
 * 光断言「调用了 saveSettings」看不出来，必须看落盘内容里 theme 到底是不是当前档位。
 */
const savedSettings = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
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
        {
          active: 0,
          tabs: [
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
          ],
        },
        // 同一路径出现两次：应创建两个同源实例（内容同步，内存一份）
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
      // B68 起的两个默认值：自动保存关、热退出开
      autosave: false,
      hot_exit: true,
    }),
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
      text:
        _path === "a.md"
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
      // 线上是 camelCase（Rust rename_all），别跟着误写成 size_class
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
  saveSession: () => Promise.resolve(),
  saveSettings: (s: Record<string, unknown>) => {
    savedSettings.last = s;
    return Promise.resolve();
  },
  // ---- B68 热退出 ----
  // restoreBackup 恒返回 null：让会话恢复走「文件兜底」这条路，
  // 与 B68 之前的用例预期一致（副本优先那条路径由回归测试静态守护）。
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

// 指针事件构造（点击、分隔条缩放等仍走指针序列）
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

/**
 * 模拟一次标签拖拽：dragstart(标签) → dragover(落点) → drop(落点) → dragend(标签)。
 *
 * B91-2：标签拖拽从指针编排换回 HTML5 DnD，所以这里是拖放事件序列而不是鼠标序列。
 * ⚠️ 全程必须用**同一个 dataTransfer**：载荷（含 dragId）在 dragstart 里写进去、drop
 * 时再读出来。换一个实例，`from` 就对不上，drop 会被当成「别的窗口拖来的」，
 * 于是本地什么都不发生 —— 表现出来就是「拖了没反应」。
 */
function dragTab(
  tab: HTMLElement,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  ctrlKey = false,
): void {
  const dt = makeDataTransfer();
  fireDrag("dragstart", tab, dt, { clientX: fromX, clientY: fromY });
  // dragover 中途一次再直接落点一次：与真实拖拽的形状一致（也顺带压过 40ms 节流）
  fireDrag("dragover", document, dt, {
    clientX: Math.round((fromX + toX) / 2),
    clientY: Math.round((fromY + toY) / 2),
    ctrlKey,
  });
  fireDrag("dragover", document, dt, { clientX: toX, clientY: toY, ctrlKey });
  fireDrag("drop", document, dt, { clientX: toX, clientY: toY, ctrlKey });
  fireDrag("dragend", tab, dt, { clientX: toX, clientY: toY, ctrlKey });
}

/** 真实点击 = mousedown + click（mousedown 会重置拖拽吞击标记）。 */
function clickTab(tab: HTMLElement): void {
  tab.dispatchEvent(mouse("mousedown", 5, 5));
  tab.dispatchEvent(mouse("click", 5, 5));
}

describe("bootstrap + drag-split smoke", () => {
  const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** 点开菜单栏里的某个顶层菜单（文件 / 编辑 / 查看 / 设置 / 帮助）。 */
  async function openMenu(label: string): Promise<void> {
    const host = document.getElementById("menu-bar") as HTMLElement;
    const btn = [...host.querySelectorAll("button.menu-btn")].find((b) =>
      b.textContent?.startsWith(label),
    );
    expect(btn, `菜单栏应有「${label}」`).toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
  }

  /** 点已展开菜单里的项（按标签包含匹配）。 */
  async function clickMenuItem(needle: string): Promise<void> {
    for (const menu of document.querySelectorAll(".popup-menu")) {
      const item = [...menu.querySelectorAll(":scope > button")].find((b) =>
        (b.querySelector(".menu-label")?.textContent ?? "").includes(needle),
      );
      if (item) {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick();
        return;
      }
    }
    throw new Error(`菜单项「${needle}」未找到`);
  }

  /**
   * 走「文件 → 打开…」驱动 doOpen。
   *
   * B97 把顶栏那排快捷按钮整体移除后，原先靠 `#btn-open.click()` 驱动的路径改走菜单 ——
   * 菜单是这条动作现在唯一（也是真实）的入口。
   */
  async function openViaMenu(): Promise<void> {
    await openMenu("文件");
    await clickMenuItem("打开…");
  }

  /**
   * 走「设置 → 首选项…」换主题档位。
   *
   * B97 起顶栏那颗三态循环的主题按钮已移除，主题只从首选项的下拉进出，所以凡是验证
   * 「换档立即生效 / 写回 settings / 编辑器跟随」的用例都走这条真实链路。
   */
  async function setThemeViaPreferences(mode: "light" | "dark" | "system"): Promise<void> {
    await openMenu("设置");
    await clickMenuItem("首选项…");
    const rows = [...document.querySelectorAll(".preferences-dialog .settings-row")];
    const row = rows.find((r) => r.querySelector(".settings-label")?.textContent === "主题");
    const sel = row?.querySelector("select") as HTMLSelectElement | null;
    expect(sel, "首选项里应有「主题」下拉").toBeTruthy();
    sel!.value = mode;
    sel!.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(30);
    // 关掉模态弹窗，别影响后续用例
    (document.querySelector(".preferences-dialog .settings-ok") as HTMLButtonElement)?.click();
    await tick(0);
  }

  /** 当前主题档位（main 写在 `<html data-theme-mode>` 上，取代已移除的主题按钮）。 */
  const themeModeOf = (): string | undefined => document.documentElement.dataset.themeMode;

  /** 把档位归位到「跟随系统」，免得上一个用例留下的显式档影响本次断言。 */
  async function resetThemeToSystem(): Promise<void> {
    if (themeModeOf() === "system") return;
    await setThemeViaPreferences("system");
  }

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
    expect(allViews[1].state.doc.toString(), "面板1 的同源实例应实时跟随内容变更").toContain(
      "SYNC-MARK hello world",
    );
    // B57 起 ● 是矢量字形（VS Code codicon 的 circle-filled），槽位恒定存在、靠 opacity 显隐，
    // 所以脏状态只能看 tab-dirty 类，不能再看 .tab-mark 的文本。
    const dirtyTabs = Array.from(document.querySelectorAll(".tab.tab-dirty"));
    expect(dirtyTabs.length, "脏标记应出现在标签上").toBeGreaterThan(0);
    expect(
      dirtyTabs[0].querySelector(".tab-mark i.codicon"),
      "脏标记槽位里应有矢量圆点",
    ).toBeTruthy();

    // ---- 模拟把面板0的标签拖到面板1的左侧区域（应触发 splitPanelWithTab）----
    const panels = Array.from(layoutArea!.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(panels.length, "应有两个面板").toBe(2);
    const panel0 = panels[0];
    const tab0 = panel0.querySelector(".tab") as HTMLElement;
    expect(tab0, "面板0应有标签").toBeTruthy();

    // 面板横向排布桩：panel1 左缘在 210，落点 (215,100) → 面板1 左侧区域
    const restoreRects = installRectStubs();
    // 拖拽态标记：dragstart 起 body 带 tab-drag-active（CSS 据此禁文本选区），dragend
    // 移除。B91-2 起这一段的指针形状由系统按 dropEffect 决定，不再是页面的 grabbing。
    const dt0 = makeDataTransfer();
    fireDrag("dragstart", tab0, dt0, { clientX: 10, clientY: 12 });
    expect(document.body.classList.contains("tab-drag-active"), "拖拽中应有拖拽态类").toBe(true);
    fireDrag("dragover", document, dt0, { clientX: 215, clientY: 100 });
    fireDrag("drop", document, dt0, { clientX: 215, clientY: 100 });
    fireDrag("dragend", tab0, dt0, { clientX: 215, clientY: 100 });
    expect(document.body.classList.contains("tab-drag-active"), "松手后拖拽态类应移除").toBe(false);
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
    const textsAfter = Array.from(document.querySelectorAll(".cm-content")).map(
      (c) => c.textContent ?? "",
    );
    expect(
      textsAfter.some((t) => t === "SYNC-MARK hello world from A"),
      "被拖动文档应原样出现在新分屏",
    ).toBe(true);
    expect(
      textsAfter.some((t) => /from A\s*\d/.test(t)),
      "CM 不应把 tabId 数字插入正文",
    ).toBe(false);
  });

  it("B97：主题从「设置 → 首选项 → 主题」换档，立即生效且明暗必定翻转", async () => {
    // B97 把顶栏那颗三态循环的主题按钮移除了，主题只剩首选项这一个入口。
    // 这条盖住最要紧的一点：换档之后**外观当场就变**。
    // （旧实现有「点了没反应」，根因是 cycle 顺序在系统偏好与当前档一致时不翻转；
    //  现在是从下拉里直接选档，那条边根本不存在。）
    await resetThemeToSystem();
    const themeOf = () => document.documentElement.dataset.theme;
    const systemTheme = themeOf();
    expect(systemTheme, "初始应有明暗状态").toBeTruthy();

    await setThemeViaPreferences("dark");
    expect(themeModeOf(), "档位应切到深色").toBe("dark");
    expect(themeOf(), "选深色后外观必须真的变深").not.toBe(systemTheme);

    await setThemeViaPreferences("light");
    expect(themeModeOf(), "档位应切到浅色").toBe("light");
    expect(themeOf(), "浅 ⇄ 深之间必须翻转").toBe(systemTheme);

    await setThemeViaPreferences("system");
    expect(themeModeOf(), "应能切回跟随系统").toBe("system");
  });

  it("B79：主题档位必须写进 settings 才能存盘（回归：重启后变回深色）", async () => {
    // 用户实测：每次打开都是深色。根因是 `settings.theme` 只在启动时**读**，
    // 切换时从没**写回** —— persistSettings() 存的是整个 settings 对象，而它的 theme
    // 一直停在启动时的 "system"，深色系统下解析出来就是深色。
    // ⚠️ 判据必须落在**落盘内容**上：只断言「调用了 saveSettings」会假绿（存了一直存，
    // 只是存的是旧值）。
    await resetThemeToSystem();
    for (const mode of ["light", "dark", "system"] as const) {
      await setThemeViaPreferences(mode);
      expect(savedSettings.last, `切到 ${mode} 必须落一次盘`).toBeTruthy();
      expect(savedSettings.last!.theme, `落盘的 theme 必须等于当前档位（${mode}）`).toBe(mode);
    }
  });

  it("B54：面板操作栏只剩「移除分屏」一个矢量图标按钮，标签栏不再有折叠按钮", async () => {
    // B53 参考 VS Code 把面板头图标化，B54 按用户要求去掉左右/上下分屏按钮
    // （分屏改为把标签拖到面板边缘），只留「移除该分屏」。
    const panel = document.querySelector(".layout-panel") as HTMLElement;
    expect(panel, "应有面板").toBeTruthy();
    const ops = Array.from(panel.querySelectorAll<HTMLButtonElement>(".panel-op"));
    expect(ops.length, "应只剩 移除分屏 共 1 个操作按钮").toBe(1);
    for (const op of ops) {
      expect(op.querySelector("i.codicon"), `「${op.dataset.tip}」必须是矢量图标`).toBeTruthy();
    }
    expect(ops[0].dataset.tip, "唯一按钮是移除分屏").toContain("移除");

    // 折叠机制已整体删除
    expect(document.querySelector(".tab-more"), "折叠按钮必须已删除").toBeNull();
    expect(document.querySelector(".tab-action"), "● 与 × 应共用一个动作槽位").toBeTruthy();

    // 焦点面板 class 必须恰好落在一块面板上
    expect(document.querySelectorAll(".layout-panel-active").length, "有且仅有一个活动面板").toBe(
      1,
    );
  });

  it("新建标签必须是空白文档（回归：attach 后 rebuild 快照回写污染新标签）", async () => {
    // 机制：attachTabToPanel 已把 activeTabId 指向新标签，而视图仍显示旧标签；
    // 若 rebuildLayout 的回写按 activeTabId 寻址，会把旧文档内容写进新标签。
    const strips = Array.from(document.querySelectorAll(".panel-tabstrip")) as HTMLElement[];
    expect(strips.length).toBeGreaterThan(0);
    const before = document.querySelectorAll(".cm-content").length;
    strips[0].dispatchEvent(new Event("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120)); // newUntitled 内部有 ipcNewTab 异步
    const contents = Array.from(document.querySelectorAll(".cm-content")).map(
      (c) => c.textContent ?? "",
    );
    expect(contents.length, "新建后面板数不减").toBeGreaterThanOrEqual(before);
    // 新建标签应插入一个空文档视图；任何视图都不应凭空出现旧文档内容重复
    const emptyish = contents.filter((t) => t.length === 0);
    expect(emptyish.length, "应存在一个空的新建标签视图").toBeGreaterThanOrEqual(1);
  });

  it("打开文件必须立即显示内容（回归：打开后内容空白）", async () => {
    // 用户报告：打开文件内容全空白，重启会话恢复后同一文件却正常。
    // 走「文件 → 打开…」驱动 doOpen（对话框 mock 返回路径），断言挂载视图立即有内容。
    openDialogResult.value = "c.md";
    await openViaMenu();
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
    await openViaMenu();
    await new Promise((r) => setTimeout(r, 120));
    openDialogResult.value = null;

    const tabOf = (name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
        (el) => el.dataset.tip === name,
      );
    const dTab = tabOf("d.md");
    expect(dTab, "打开的 d.md 应出现在标签条").toBeTruthy();
    const strip = dTab!.closest(".panel-tabstrip") as HTMLElement;
    const panelEl = dTab!.closest(".layout-panel") as HTMLElement;
    const otherTab = Array.from(strip.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.dataset.tip !== "d.md",
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
    await openViaMenu();
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
    await openViaMenu();
    await new Promise((r) => setTimeout(r, 120));
    openDialogResult.value = null;

    expect(
      views().some((v) => v.state.doc.toString().includes("third document from C")),
      "新打开的 c.md 应立即显示内容",
    ).toBe(true);

    // 切回 d.md：内容必须还在（被清空即为用户报告的空白回归）
    const dTab = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.dataset.tip === "d.md",
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
      (el) => el.dataset.tip === "c.md",
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
    expect(view?.state.doc.toString() ?? "", "click 后该面板应显示 c.md 的内容").toContain(
      "third document from C",
    );
  });

  it("从资源管理器拖入文件必须打开该文件（回归：拖入变成插入内容）", async () => {
    // 用户报告：拖文件进窗口应打开文件，而不是把内容复制进当前文档。
    // 实现：onDragDropEvent(drop)（B91 起 wry 原生拖放关掉了，路径改走页面内拖放 + 桥）。
    // B91-2：光有这条不够 —— 它只测到宿主事件层；页面这一层的拦截（CM6 会把拖入的文件
    // 按文本内容读出来插进文档）由 `tests/filedrop.test.ts` 的捕获阶段用例守着。
    // B24：落到 Markdown 文档上时先弹「打开文档 / 插入文件路径」选择菜单，
    // 选「打开」才真正打开；落点不是 Markdown / 多文件则直接打开。
    // B70 B 档：弹菜单的判据是**落点面板的活动文档**，不再是「拖进来的文件是 .md」。
    expect(dragDropHandlers.length, "onDragDropEvent 应在启动时注册").toBeGreaterThan(0);

    // 需要真实几何：否则所有面板的 rect 都是 0，panelAt 永远命中文档里第一个面板，
    // 「落到哪个面板」这件事就测不出来了。
    const restoreRects = installRectStubs();
    try {
      // 挑一个活动标签是 .md 的面板（前面若干用例可能把布局换成过别的形态）
      const panelsEl = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
      const mdPanelIdx = panelsEl.findIndex((p) =>
        (p.querySelector(".tab.tab-active .tab-name")?.textContent ?? "").includes(".md"),
      );
      expect(mdPanelIdx, "夹具里应有一个显示 .md 的面板").toBeGreaterThanOrEqual(0);
      // 面板矩形是 [idx*210, +200]，取中心偏下（避开顶部 24px 的标签条）
      const at = { x: mdPanelIdx * 210 + 100, y: 100 };

      fireDragDrop(["e.md"], at);
      await new Promise((r) => setTimeout(r, 120));

      expect(capturedError, `拖入文件不应抛错：${String(capturedError)}`).toBeNull();

      const choiceMenu = document.querySelector(".popup-menu");
      expect(choiceMenu, "落到 Markdown 文档上应弹出 打开/插入路径 选择菜单").toBeTruthy();
      const choices = Array.from(choiceMenu!.querySelectorAll("button")).map(
        (b) => b.textContent ?? "",
      );
      expect(
        choices.some((t) => t.includes("打开")),
        "应有「打开文档」项",
      ).toBe(true);
      expect(
        choices.some((t) => t.includes("插入文件路径")),
        "应有「插入文件路径」项",
      ).toBe(true);
      const contentsBefore = Array.from(document.querySelectorAll(".cm-content")).map(
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

      // B70 B 档的反向约束：拖进来的**不是** md 也要问 —— 判据看落点。
      // 这里只验「菜单起来了」，随后 Esc 取消，别真去打开一个 txt。
      fireDragDrop(["notes.txt"], at);
      await new Promise((r) => setTimeout(r, 120));
      const menuForNonMd = document.querySelector(".popup-menu");
      expect(menuForNonMd, "拖非 md 文件落到 Markdown 文档上同样要问（可以只插路径）").toBeTruthy();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector(".popup-menu"), "Esc 应关掉菜单").toBeNull();
    } finally {
      restoreRects();
    }
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
          (t) => t.dataset.tip === "a.md",
        );
        const bmd = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
          (t) => t.dataset.tip === "b.md",
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
      const firstName = firstTab.dataset.tip;
      const stripLeft = target!.querySelector(".panel-tabstrip")!.getBoundingClientRect().left;
      const dt1 = makeDataTransfer();
      const dropX = Math.round(stripLeft) + 150;
      fireDrag("dragstart", firstTab, dt1, { clientX: 5, clientY: 5 });
      fireDrag("dragover", document, dt1, { clientX: dropX, clientY: 12 });
      fireDrag("drop", document, dt1, { clientX: dropX, clientY: 12 });
      fireDrag("dragend", firstTab, dt1, { clientX: dropX, clientY: 12 });
      await new Promise((r) => setTimeout(r, 60));

      expect(
        document.querySelectorAll(".layout-panel").length,
        "tab 区落下不得分屏（面板数不变）",
      ).toBe(beforePanels);
      expect(document.body.classList.contains("tab-drag-active"), "拖拽光标类应移除").toBe(false);
      expect(document.querySelector(".tab-insert"), "松手后插入指示线应移除").toBeNull();
      const names = Array.from(target!.querySelectorAll(".tab")).map((t) => t.dataset.tip);
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
      (el) => el.dataset.tip === "c.md",
    );
    expect(cTab, "c.md 标签应存在").toBeTruthy();
    const cPanel = cTab!.closest(".layout-panel") as HTMLElement;

    // 找一个不在 c.md 所在面板的标签（跨面板点击）
    const target = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (el) => el.dataset.tip === "a.md" && el.closest(".layout-panel") !== cPanel,
    );
    expect(target, "应存在其他面板中的 a.md 标签").toBeTruthy();
    const targetPanel = target!.closest(".layout-panel") as HTMLElement;

    // 真实点击：mousedown 与 click 之间有按压间隔（≥ 一帧）。
    // 旧实现的 setTimeout 延迟重绘会在此间隔内触发、销毁光标下的标签。
    target!.dispatchEvent(mouse("mousedown", 5, 5));
    await new Promise((r) => setTimeout(r, 15));
    expect(target!.isConnected, "按压期间（跨面板激活后）标签不得被重绘替换").toBe(true);
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
    // 断言：换档之后每一个已挂载面板的 CodeMirror 明暗状态都同步翻转。
    // B97 起换档入口是「设置 → 首选项 → 主题」，不再是顶栏那颗循环按钮。
    await resetThemeToSystem();
    const viewsOf = () =>
      Array.from(document.querySelectorAll(".cm-editor"))
        .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
        .filter((v): v is EditorView => !!v);
    const darkFlags = () => viewsOf().map((v) => v.state.facet(EditorView.darkTheme));

    const before = darkFlags();
    expect(before.length, "应存在已挂载的编辑器视图").toBeGreaterThan(0);
    // 显式选一个与当前相反的档（下拉是「直接选档」，不再有「切下一档」的循环语义）
    const want: "light" | "dark" = before[0] ? "light" : "dark";
    const wantDark = want === "dark";

    await setThemeViaPreferences(want);
    const mid = darkFlags();
    expect(
      mid.every((d) => d === wantDark),
      `所有面板编辑器都应切到${wantDark ? "深色" : "浅色"}，实际：${String(mid)}`,
    ).toBe(true);

    await setThemeViaPreferences(wantDark ? "light" : "dark");
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
      const panelTabs = (p: HTMLElement) => Array.from(p.querySelectorAll(".tab")) as HTMLElement[];
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
      expect(amdViewsBefore[1].state.doc.toString(), "第二实例应同步到新内容").toBe(md);

      // 打开大纲（B97 起走「查看 → 大纲 TOC」菜单，顶栏那颗按钮已移除）
      await openMenu("查看");
      await clickMenuItem("大纲 TOC");
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
        expect(v.state.selection.main.head, `实例${i} 应跳到「## 第二题」行首`).toBe(h2Pos);
      }
      // 大纲活动项高亮应更新到点击的标题
      const activeItems = document.querySelectorAll("#toc-panel .toc-active");
      expect(activeItems.length, "应有活动高亮项").toBe(1);
      expect(activeItems[0].textContent, "高亮应落在「## 第二题」").toContain("第二题");

      // 收起大纲，避免影响其他状态（同样走菜单，B97 后没有顶栏按钮可点）
      await openMenu("查看");
      await clickMenuItem("大纲 TOC");
    } finally {
      restoreRects();
    }
  });

  it("B42：全局快捷键走注册表（大纲开合 / 裸字母不被吞 / 设置对话框让路）", async () => {
    capturedError = null;
    const toc = document.getElementById("toc-panel") as HTMLElement;
    const hotkey = (init: KeyboardEventInit): KeyboardEvent =>
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

    // 大纲此前没有快捷键；Ctrl+Shift+O 是 B42 新增的默认键位
    const before = toc.hidden;
    const open = hotkey({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true });
    window.dispatchEvent(open);
    expect(open.defaultPrevented, "命中的快捷键应被接管").toBe(true);
    expect(toc.hidden, "Ctrl+Shift+O 应切换大纲").toBe(!before);
    window.dispatchEvent(hotkey({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true }));
    expect(toc.hidden, "再按一次应回到原状态").toBe(before);

    // 裸字母绝不能被全局快捷键吞掉，否则编辑器没法打字
    for (const code of ["KeyN", "KeyS", "KeyO"]) {
      const bare = hotkey({ code, key: code.slice(3).toLowerCase() });
      window.dispatchEvent(bare);
      expect(bare.defaultPrevented, `${code} 裸按下不得被吞`).toBe(false);
    }
    expect(capturedError, `裸按键不应抛错：${String(capturedError)}`).toBeNull();

    // 折叠全部/展开全部（B42 起从 CM foldKeymap 收归应用层，Ctrl+Alt+[ / ]）
    window.dispatchEvent(hotkey({ code: "BracketLeft", key: "[", ctrlKey: true, altKey: true }));
    window.dispatchEvent(hotkey({ code: "BracketRight", key: "]", ctrlKey: true, altKey: true }));
    // 折叠光标处（Ctrl+Shift+[ / ]）走 CM 命令，不得抛错
    window.dispatchEvent(hotkey({ code: "BracketLeft", key: "{", ctrlKey: true, shiftKey: true }));
    window.dispatchEvent(hotkey({ code: "BracketRight", key: "}", ctrlKey: true, shiftKey: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedError, `折叠快捷键不应抛错：${String(capturedError)}`).toBeNull();

    // 设置 → 快捷键：对话框打开时全局快捷键必须整体让路
    const { showKeymapDialog } = await import("../src/shell/keymapdialog");
    showKeymapDialog({ overrides: {}, onChange: () => {} });
    expect(document.querySelector(".settings-overlay"), "对话框应已打开").toBeTruthy();
    const during = hotkey({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented, "对话框打开时全局快捷键应让路").toBe(false);
    expect(toc.hidden, "让路时不得改动大纲状态").toBe(before);

    document.querySelector<HTMLButtonElement>(".settings-ok")!.click();
    expect(document.querySelector(".settings-overlay"), "确定后应关闭").toBeNull();

    // 关掉对话框后快捷键必须恢复
    window.dispatchEvent(hotkey({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true }));
    expect(toc.hidden, "关闭对话框后快捷键应恢复").toBe(!before);
    window.dispatchEvent(hotkey({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true }));
  });

  it("B45 关闭非活动标签不得切换视图（回归：切到待关文件→关掉→切回来，闪一下）", async () => {
    // 用户报告：关掉的标签不是当前文件时会闪一下。
    // 根因两处（都在 closeTabById）：
    //   ① 为了复用只保存“活动标签”的 doSave，先把待关标签 switchTab 成活动标签；
    //      switchTab 是**同步**的，而保存确认 await 在其后——中间态会被真的绘制出来。
    //   ② 关完又无条件把面板切到待关标签的邻居（关后台标签本不该动显示内容）。
    // 修复：保存改用按实例寻址的 saveDocCore，且仅当关的是正显示的标签才换内容。
    capturedError = null;

    const panelWithTwo = () =>
      (Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[]).find(
        (p) => p.querySelectorAll(".tab").length >= 2,
      ) ?? null;
    let panel = panelWithTwo();
    if (!panel) {
      // 前置用例可能把标签都拆成单标签面板：补开一个文件凑出多标签面板
      openDialogResult.value = "c.md";
      await openViaMenu();
      await new Promise((r) => setTimeout(r, 150));
      openDialogResult.value = null;
      panel = panelWithTwo();
    }
    expect(panel, "应存在含两个及以上标签的面板（否则测不到后台标签关闭）").toBeTruthy();

    const strip = panel!.querySelector(".panel-tabstrip") as HTMLElement;
    const activeEl = strip.querySelector<HTMLElement>(".tab.tab-active");
    expect(activeEl, "面板应有活动标签").toBeTruthy();
    const activeName = activeEl!.dataset.tip;
    const others = Array.from(strip.querySelectorAll<HTMLElement>(".tab")).filter(
      (t) => t !== activeEl,
    );
    expect(others.length, "应存在可关闭的非活动标签").toBeGreaterThan(0);
    const victim = others[0];
    const victimName = victim.dataset.tip;

    const dom = panel!.querySelector(".cm-editor");
    const view = dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
    expect(view, "面板应挂载编辑器视图").toBeTruthy();
    const before = view!.state.doc.toString();

    // 点待关标签上的 ×（真实路径：tab-close 的 click → onClose → closeTabById）
    const closeBtn = victim.querySelector<HTMLButtonElement>(".tab-close");
    expect(closeBtn, "标签应有关闭按钮").toBeTruthy();
    closeBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // 同步采样：旧实现在这里已经 switchTab 过去，视图内容立刻变成待关文件。
    // 这一步就是「闪一下」的可观测证据。
    expect(view!.state.doc.toString(), "按下关闭的瞬间不得立刻切到待关文件（闪一下的第一段）").toBe(
      before,
    );

    await new Promise((r) => setTimeout(r, 200));

    // 关完之后：活动标签没变、视图内容没变（不得跳到邻居标签）
    const afterActive = strip.querySelector<HTMLElement>(".tab.tab-active");
    expect(afterActive?.dataset.tip, "关闭后台标签后活动标签不得改变").toBe(activeName);
    expect(view!.state.doc.toString(), "关闭后台标签后不得跳到邻居标签（闪一下的第二段）").toBe(
      before,
    );

    // 待关标签确实已经消失
    const names = Array.from(strip.querySelectorAll(".tab")).map((t) => t.dataset.tip);
    expect(names, `${victimName} 应已被关闭`).not.toContain(victimName);
    expect(capturedError, `关闭标签不应抛错：${String(capturedError)}`).toBeNull();
  });

  it("B99：标题栏「钉在顶部」开关必须切换真实窗口状态并按回读值点亮", async () => {
    const pin = document.getElementById("win-pin") as HTMLButtonElement;
    expect(pin, "标题栏应有置顶开关").toBeTruthy();
    // 桩的初值是「未置顶」，所以按钮必须先处于熄灯态 —— 否则下面的点亮断言恒真
    expect(pin.getAttribute("aria-pressed"), "初始应为未置顶").toBe("false");
    expect(pin.classList.contains("is-on"), "初始不应点亮").toBe(false);

    // ---- 第一次点击：开 ----
    const before = pinState.sets.length;
    pin.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(pinState.sets.length, "点击应调用 setAlwaysOnTop").toBe(before + 1);
    expect(pinState.sets.at(-1), "应把置顶设为 true（初值是 false）").toBe(true);
    // ⚠️ 关键：断言的是**回读后的呈现**。若实现把「目标值」当新状态直接写界面，
    // 这里会因为桩改了值而照样通过；真机上 ACL 漏授权时 set 不生效、回读仍是 false，
    // 那时只有「按回读值点亮」的实现才会把按钮保持熄灯 —— 这条断言守的就是这个差别。
    expect(pin.getAttribute("aria-pressed"), "点亮状态应写在 aria-pressed 上").toBe("true");
    expect(pin.classList.contains("is-on"), "置顶后应点亮").toBe(true);
    expect(pin.dataset.tip, "提示应换成取消语义").toBe("取消钉在顶部");
    expect(pin.getAttribute("aria-label"), "图标按钮不能失名").toBe("取消钉在顶部");

    // ---- 第二次点击：关 ----
    pin.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(pinState.sets.at(-1), "再点一次应取消置顶").toBe(false);
    expect(pinState.on, "窗口置顶态应已还原").toBe(false);
    expect(pin.getAttribute("aria-pressed"), "取消后应熄灯").toBe("false");
    expect(pin.classList.contains("is-on"), "取消后不应再点亮").toBe(false);
    expect(pin.dataset.tip, "提示应还原").toBe("钉在顶部");

    // ---- 判别式：set 调了但**没生效**时，界面必须按回读值走 ----
    // 真机上 ACL 漏授权就是这副样子：调用不报错、窗口态没变。此时「把目标值当新状态写界面」
    // 的实现在这里会留下一个**假的点亮态**（界面说已置顶、窗口其实没有），
    // 而按回读值刷新的实现会老老实实保持熄灯。这才是这条用例真正区分的东西 ——
    // 上面两次点击只证明「开关会切换」，区分不出这两种实现。
    pinState.swallowSet = true;
    pin.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(pinState.sets.at(-1), "即使不生效也应先尝试置顶").toBe(true);
    expect(
      pin.getAttribute("aria-pressed"),
      "set 未生效时必须保持熄灯（按回读值，而非乐观目标值）",
    ).toBe("false");
    expect(pin.classList.contains("is-on"), "不得留下假的点亮态").toBe(false);
    pinState.swallowSet = false;
    pinState.sets.length = 0;
    expect(capturedError, `置顶开关不应抛错：${String(capturedError)}`).toBeNull();
  });

  it("B104：状态栏不挂快捷键提示，默认网页右键菜单被屏蔽", async () => {
    await import("../src/main");
    await new Promise((r) => setTimeout(r, 300));

    // ---- ① 状态栏左侧消息：只报状态，不带 Ctrl+… 教程 ----
    // ⚠️ 只能静态钉「启动消息」：前面的用例已经把消息换成「主题：浅色」之类了，
    //    运行时此刻的文本不一定是启动那句。
    const msg = document.getElementById("sb-message")?.textContent ?? "";
    expect(msg, "不得再挂快捷键提示").not.toContain("Ctrl+");
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "启动消息不得再是快捷键教程").not.toContain("Ctrl+N 新建");
    expect(main, "启动消息只报状态").toMatch(/已恢复上次会话" : "就绪"/);

    // ---- ② 右键不再弹默认网页菜单 ----
    // 挂在 document 冒泡阶段的全局屏蔽（bindEvents）。标签条的自定义右键菜单
    // 在目标元素上 stopPropagation，到不了 document —— 这里用 body 验证「其它区域」。
    for (const target of [document.body, document.querySelector(".cm-content") as Element]) {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      expect(ev.defaultPrevented, `${target.className || "body"} 右键必须被屏蔽`).toBe(true);
    }
    // 静态另一面：WebView2 默认菜单的入口就是没拦 —— 源码里必须有全局屏蔽这一条
    expect(main, "必须有 document 级 contextmenu 屏蔽").toMatch(
      /document\.addEventListener\("contextmenu",\s*\(e\)\s*=>\s*e\.preventDefault\(\)\)/,
    );
  });
});
