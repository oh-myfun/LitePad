// @vitest-environment jsdom
// B397 · 所见即所得那一臂接进面板模型；B412 起它是**唯一**的预览 / 编辑形态
// （旧派生 DOM 预览臂与 `deco_preview` 开关都已删除）。
//
// 前身是 B391 spike 的 Task 5 那份文件。B397-1 把「预览侧第二颗 view（只读镜像）」整个拆掉
// 之后，这里判的东西跟着换了一次口径：**一格一颗 view，档位是它身上的 Compartment**。
// 于是原来那些「两侧」判据（桥、归属闸、账本认领、播种）没有了被测对象，逐条改写成了
// 「同一颗 view 的档位」判据 —— 产品性质一条没丢：打字进得去、只读进不去、点勾能改、
// 查找落在当前这一颗、换档不换 view、换文档不吃上一篇的画。
//
// 三条判据的形状抄自 tests/view-switch-noedit.test.ts（本仓库唯一能在 jsdom 里
// 真启动 `src/main.ts` 的那份配方：26 个 ipc/api 导出不许缺，缺一个 bootstrap 就
// 以 TypeError 死掉）。这里刻意**不打桩**装饰本身：它走的是真 `previewFace()`，
// 于是「Markdown 的预览档真的是所见即所得」是被真启动证明的，不是被我 mock 证明的。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { clickTaskBox } from "./preview-face-helpers";

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
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

const saved: unknown[] = [];
vi.mock("../src/ipc/api", () => ({
  assocList: () => Promise.resolve([]),
  assocSet: (ext: string, on: boolean) =>
    Promise.resolve({ ext, registered: on, isDefault: false }),
  assocSetMany: (exts: string[], on: boolean) =>
    Promise.resolve(exts.map((ext) => ({ ext, registered: on, isDefault: false }))),
  assocOpenSystemSettings: () => Promise.resolve(),
  emitCrossWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => `asset://${p}`,
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
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
      ],
    }),
  // B412 起没有开关：装饰面就是预览 / 编辑档本身，所有 Markdown 一律走它。
  loadSettings: () =>
    Promise.resolve({
      theme: "light",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: true,
      toc_width: 240,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({
      tabId: 1,
      name: "未命名",
      readonly: false,
      encoding: "UTF-8",
      eol: "CRLF",
    }),
  openFile: (p: string) =>
    Promise.resolve({
      tabId: 101,
      text: "# Title\n\nhello world\n\nsecond line\n",
      name: p,
      path: p,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
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
  saveFile: (args: unknown) => {
    saved.push(args);
    return Promise.resolve({ lossy: [], path: "" });
  },
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  // ⚠️ 这里**没有** `isDecoPreviewEnabled`：那颗闸门住在 `core/app-state.ts`（没有一份测试
  // mock 过那个模块），所以这份文件测的是「真闸门读真设置」——闸门被 mock 掉的绿不算绿。
  clearRecents: () => Promise.resolve(),
  copyEntry: () => Promise.resolve(true),
  createDir: () => Promise.resolve(null),
  createFile: () => Promise.resolve(null),
  deleteEntry: () => Promise.resolve(true),
  forgetRecent: () => Promise.resolve(),
  getRecentLimit: () => Promise.resolve(50),
  isDir: () => Promise.resolve(false),
  listDir: () => Promise.resolve([]),
  listFonts: () => Promise.resolve([]),
  listRecents: () => Promise.resolve([]),
  listTabs: () => Promise.resolve([]),
  logFilePath: () => Promise.resolve(""),
  logLevel: () => Promise.resolve("info"),
  moveEntry: () => Promise.resolve(true),
  noteOpenedPath: () => Promise.resolve(),
  openSatelliteWindow: () => Promise.resolve(),
  renameEntry: () => Promise.resolve(true),
  replaceInFiles: () => Promise.resolve({ files: [], replacements: 0 }),
  retitleRecent: () => Promise.resolve(),
  revealInFolder: () => Promise.resolve(),
  searchInFolder: () => Promise.resolve({ files: [], matches: [], truncated: false }),
  setDocPath: () => Promise.resolve(),
  setLogLevel: () => Promise.resolve(),
  setRecentLimit: () => Promise.resolve(),
  takePendingFiles: () => Promise.resolve([]),
  windowPayload: () => Promise.resolve(null),
}));

// B57 起 ● 是矢量字形且槽位恒定存在（靠 opacity 显隐），脏状态改看 tab-dirty 类。
const dirty = (): boolean =>
  Array.from(document.querySelectorAll(".tab.tab-dirty")).some(
    (t) => t.querySelector(".tab-mark i.codicon") !== null,
  );

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 每按一次 Ctrl+/ 切一回视图模式。 */
async function toggleView(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await wait(60);
  }
}

/** 抹掉注释再取源码（注释里提到函数名不算接线）。 */
function codeOf(f: string): string {
  return readFileSync(f, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const panelEditor = (): EditorView =>
  EditorView.findFromDOM(document.querySelector(".panel-editor .cm-editor") as HTMLElement)!;

/**
 * 取回那颗真启动出来的面板，并确保它停在预览（所见即所得）档。
 *
 * 「档」是 view 身上的 Compartment，而换档的唯一出口是 `applyPanelMode` ⇒ 这里刻意只按
 * 真实用户手势（Ctrl+/）切档，不直接 dispatch 扩展，免得测的是我自己搭的架子。
 */
async function mdPanelInPreview() {
  await import("../src/main");
  await wait(200);
  const { panels, tabs } = await import("../src/core/app-state");
  const p = [...panels.values()].find((x) => x.view);
  expect(p, "应有一颗带编辑器实例的面板").toBeTruthy();
  const tab = tabs.get(p!.viewTabId ?? p!.activeTabId)!;
  // B399：三档之后 Ctrl+/ 只走「源码 ↔ 预览」⇒ 从编辑档回来要按两下（编辑→源码→预览）
  for (let i = 0; i < 2 && tab.viewMode !== "preview"; i++) await toggleView(1);
  expect(tab.viewMode, "前置：这一格应在预览（所见即所得）档").toBe("preview");
  return { p: p!, tab, view: panelEditor() };
}

/**
 * B397-1 · 形态判据（用户 2026-10-27 的口径）。
 *
 * 「那个独立的只读形态完全没必要 —— 把所见即所得禁用编辑自然就是只读，效果也能一致。」
 * InkNote 全仓 `new EditorView` 只出现一次（`src/editor.ts:1466`），模式切换是
 * `previewCompartment.reconfigure`（:1370），只读是同一颗 view 上的
 * `readOnly` + `editable` + `transactionFilter`（:1391-1399）。
 */
describe("B397-1 一颗 view 两档：deco 形态下没有第二颗 view", () => {
  it("甲 预览档只有一颗 view，装饰挂在这颗上，派生 DOM 那一臂整个不在", async () => {
    await mdPanelInPreview();
    expect(
      document.querySelectorAll(".panel-host .cm-editor").length,
      "一格一颗 view ⇒ 总数应等于面板数，镜像那颗必须没了",
    ).toBe(document.querySelectorAll(".panel-host").length);
    const dom = document.querySelector(".panel-host .cm-editor")!;
    expect(
      dom.classList.contains("md-preview-face"),
      "预览档的装饰类应挂在**这颗** editor 上",
    ).toBe(true);
    expect(
      document.querySelectorAll(".panel-host .md-preview, .panel-host .md-rendered").length,
      "预览不可能再出现派生 DOM（B412：旧预览臂已删除，整仓只有这一张脸）",
    ).toBe(0);
  });

  it("己 连切 20 次视图：不置脏、不排程写盘（档位事务不是编辑）", async () => {
    await mdPanelInPreview();
    const view = panelEditor();
    const before = view.state.doc.toString();
    saved.length = 0;
    await toggleView(2); // 预览 → 源码 → 预览（一整圈）
    for (let i = 0; i < 9; i++) await toggleView(2);
    await wait(1800);
    expect(view.state.doc.toString(), "切换视图不得改内容").toBe(before);
    expect(dirty(), "切换 20 次视图不得置脏").toBe(false);
    expect(saved.length, "切换视图不得写盘（幽灵 docChanged 必须被判掉）").toBe(0);
  });

  it("乙 换档不换 view：源码档与预览档是同一个 EditorView 对象", async () => {
    const { view } = await mdPanelInPreview();
    await toggleView(1); // 预览 → 源码
    const back = panelEditor();
    expect(back, "切档不许重建 view（重建就意味着两份 state）").toBe(view);
    expect(
      back.dom.classList.contains("md-preview-face"),
      "源码档不该带装饰类（档位换了，载体没换）",
    ).toBe(false);
  });

  it("丙 编辑档打的字切回源码还在（没有第二份文本可漂）", async () => {
    const { tab, view } = await mdPanelInPreview();
    const { togglePreviewEdit } = await import("../src/markdown");
    // B399：打字这一发必须在**编辑档**（预览档是禁编辑的所见即所得）
    togglePreviewEdit();
    expect(tab.viewMode, "前置：先进编辑档").toBe("edit");
    view.dispatch({ changes: { from: 0, insert: "同源" }, userEvent: "input.type" });
    await toggleView(1); // 编辑 → 源码（Ctrl+/）
    expect(view.state.doc.toString().startsWith("同源"), "换档后仍是这一份文档").toBe(true);
  });

  it("丁 两把锁各管一段：预览档禁编辑，文档只读连编辑档也不许落笔", async () => {
    const { tab, view } = await mdPanelInPreview();
    const { docs } = await import("../src/core/app-state");
    const { togglePreviewEdit } = await import("../src/markdown");

    // ① 预览档本身就是一把锁（B399：与 doc.readonly 无关）
    view.dispatch({ changes: { from: 0, insert: "P" }, userEvent: "input.type" });
    expect(view.state.doc.toString(), "预览档不许落笔").not.toContain("P");

    // ② 文档只读：装饰照常，但编辑档也进不去
    docs.get(tab.docId)!.readonly = true;
    await toggleView(2); // 走两回出口，把只读性刷到这颗 view 上
    const before = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
    expect(view.state.doc.toString(), "只读文档在预览档不许落笔").toBe(before);
    expect(
      view.dom.classList.contains("md-preview-face"),
      "只读只关编辑，不关所见即所得（InkNote：readOnly 时装饰反而更彻底）",
    ).toBe(true);
    togglePreviewEdit();
    expect(tab.viewMode, "只读文档没有编辑档（那颗悬浮键也不出现）").toBe("preview");

    // ③ 解除只读 + 编辑档 ⇒ 同一颗 view 能写
    docs.get(tab.docId)!.readonly = false;
    await toggleView(2);
    togglePreviewEdit();
    expect(tab.viewMode).toBe("edit");
    view.dispatch({ changes: { from: 0, insert: "Y" }, userEvent: "input.type" });
    expect(view.state.doc.toString(), "解除只读 + 编辑档 ⇒ 同一颗 view 要能写").toContain("Y");
  });

  it("戊 查找落在这颗 view 上（Ctrl+F 在预览格里不是死键）", async () => {
    const { view } = await mdPanelInPreview();
    const { applyFindQuery, clearFindHighlight } = await import("../src/find/findbar");
    const q = {
      text: "line",
      replace: "",
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
      inSelection: false,
      preserveCase: false,
    };
    applyFindQuery(q);
    expect(view.dom.querySelectorAll(".cm-find-match").length, "命中应画在唯一那颗 view 里").toBe(
      1,
    );
    clearFindHighlight();
    expect(view.dom.querySelectorAll(".cm-find-match").length, "关栏不许留残影").toBe(0);
  });

  it("庚 步进在这一颗 view 上跳到命中并标成当前项", async () => {
    const { view } = await mdPanelInPreview();
    const { stepFind } = await import("../src/find/findbar");
    stepFind(1, {
      text: "line",
      replace: "",
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
      inSelection: false,
      preserveCase: false,
    });
    const at = view.state.selection.main;
    expect(view.state.sliceDoc(at.from, at.to), "步进应把选区落在这一颗 view 的文档里").toBe(
      "line",
    );
    expect(view.dom.querySelectorAll(".cm-find-match-active").length).toBe(1);
  });

  it("辛 点这一颗 view 的勾直接改它的文档（点勾落在显示那一面）", async () => {
    const { view } = await mdPanelInPreview();
    const { togglePreviewEdit } = await import("../src/markdown");
    // B399：点勾是一次写 ⇒ 要先在编辑档（预览档里这颗勾按不动，另有判据钉住）
    togglePreviewEdit();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n- [ ] 打勾行\n" },
      userEvent: "input.type",
    });
    await wait(60);
    const row = view.dom.querySelector<HTMLElement>(".cm-line.md-task-item");
    const seen = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-line")).map(
      (el) => el.className,
    );
    expect(
      row,
      `任务行应画出方框那一行（.md-task-item）；文档=${JSON.stringify(
        view.state.doc.toString(),
      )} 行=${JSON.stringify(seen)}`,
    ).toBeTruthy();
    clickTaskBox(row!, "40px", 20);
    await wait(60);
    expect(view.state.doc.toString(), "点勾必须落在显示的那颗 view 上").toContain("- [x] 打勾行");
  });

  it("癸 换文档 ⇒ 档位跟着新文档重落，不吃上一篇的画（原「桥的归属闸」这一形）", async () => {
    const { p, tab } = await mdPanelInPreview();
    const { docs, tabs } = await import("../src/core/app-state");
    const { makeDoc, makeInstance, registerDoc, attachTabToPanel } =
      await import("../src/doc-model");
    const { applyPanelMode } = await import("../src/markdown");
    const view = panelEditor();

    const txtDoc = makeDoc(
      9521,
      "纯文本一篇",
      "note.txt",
      "E:\\tmp\\note.txt",
      "UTF-8",
      "LF",
      false,
      "normal",
    );
    registerDoc(txtDoc);
    const txt = makeInstance(txtDoc, p.panelId, "纯文本一篇");
    attachTabToPanel(txt, p);
    p.viewTabId = txt.tabId;
    p.view!.setState(txt.state);
    applyPanelMode(p);
    expect(
      view.dom.classList.contains("md-preview-face"),
      "换到 .txt ⇒ 这一格退回裸编辑（装饰类不许留着）",
    ).toBe(false);

    p.activeTabId = tab.tabId;
    p.viewTabId = tab.tabId;
    p.view!.setState(tab.state);
    applyPanelMode(p);
    expect(
      view.dom.classList.contains("md-preview-face"),
      "换回 md 的预览档 ⇒ 装饰要重新落上（档位不落就是预览格一片裸文本）",
    ).toBe(true);
    expect(view.state.doc.toString(), "显示的是这一份文档，不是上一篇").toBe(
      tab.state.doc.toString(),
    );
    tabs.delete(txt.tabId);
    docs.delete(txtDoc.tabId);
    p.tabs = p.tabs.filter((id) => id !== txt.tabId);
  });

  it("子 重建布局后，新那一份 view 重新落上档位", async () => {
    await mdPanelInPreview();
    const { rebuildLayout } = await import("../src/tabs");
    const old = panelEditor();
    const destroyed: unknown[] = [];
    const orig = EditorView.prototype.destroy;
    const spy = vi.spyOn(EditorView.prototype, "destroy").mockImplementation(function (
      this: EditorView,
    ) {
      destroyed.push(this);
      return orig.call(this);
    });
    rebuildLayout();
    spy.mockRestore();
    expect(destroyed, "旧 view 必须 destroy（CM6 的 selectionchange 挂在 document 上）").toContain(
      old,
    );
    const next = panelEditor();
    expect(next).not.toBe(old);
    expect(
      next.dom.classList.contains("md-preview-face"),
      "重建后这一格仍是所见即所得（档位由唯一出口重新落，不靠镜像播种）",
    ).toBe(true);
  });
});

/**
 * B412 · 装饰面是**唯一**的预览 / 编辑形态（旧派生 DOM 预览臂已删除）。
 *
 * 这一节只守一件事：装配只有 `markdown.ts` 的那一个出口，且它按「是不是 Markdown」
 * 那道闸分臂。被删掉的旧口径（开关 `deco_preview` / 大文件换臂 / 静态守卫数
 * `isDecoPreviewEnabled` 分支）全部随功能一起作废。
 */
/**
 * B399 · 三档里的「预览 = 禁编辑」与那颗**页面内悬浮键**。
 *
 * 用户口径（2026-10-28）：「预览和编辑态切换通过页面内悬浮按钮，可参考 InkNote 的单按键
 * 切换或者 VS Code 的 switch 切换。」此前（B397/B398）预览档还是可写的 —— 那是与口径
 * 相差的最后一格；这一族判据把「预览禁编辑、编辑同脸可写、悬浮键往返、Ctrl+E 同款、
 * 会话记得住」逐条钉住。
 */
describe("B399 预览 / 编辑两档与那颗悬浮键", () => {
  const fab = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(".panel-host .md-preview-fab");

  it("甲 预览档：悬浮键在场、画的是「去编辑」；点一下进编辑档并解锁", async () => {
    const { tab, view } = await mdPanelInPreview();
    const el = fab();
    expect(el, "装饰面里应有那颗悬浮键").toBeTruthy();
    expect(el!.hidden, "预览档要看得见").toBe(false);
    expect(el!.dataset.mode, "预览档").toBe("preview");
    expect(el!.getAttribute("aria-label"), "画的是点了会去的那一档").toContain("编辑");
    expect(view.state.facet(EditorState.readOnly), "预览 = 禁编辑").toBe(true);

    el!.click();
    await wait(60);
    expect(tab.viewMode, "点一下进编辑档").toBe("edit");
    expect(fab()!.dataset.mode).toBe("edit");
    expect(fab()!.getAttribute("aria-label"), "编辑档画的是回预览").toContain("预览");
    expect(view.state.facet(EditorState.readOnly), "编辑档解掉预览那把锁").toBe(false);
    const before = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, insert: "E" }, userEvent: "input.type" });
    expect(view.state.doc.toString(), "编辑档写得进去").not.toBe(before);
  });

  it("乙 编辑档再点一下回预览档：不换 view、写不进去", async () => {
    const { tab, view } = await mdPanelInPreview();
    fab()!.click();
    await wait(60);
    expect(tab.viewMode).toBe("edit");
    const before = view.state.doc.toString();
    fab()!.click();
    await wait(60);
    expect(tab.viewMode, "回到预览档").toBe("preview");
    expect(panelEditor(), "换档不换 view（这颗键换的只是锁）").toBe(view);
    expect(view.state.facet(EditorState.readOnly), "预览档又锁上了").toBe(true);
    view.dispatch({ changes: { from: 0, insert: "N" }, userEvent: "input.type" });
    expect(view.state.doc.toString(), "预览档写不进去").toBe(before);
  });

  it("丙 源码档没有这颗键（它只管预览 ↔ 编辑）", async () => {
    const { view } = await mdPanelInPreview();
    expect(fab()!.hidden, "前置：预览档它在").toBe(false);
    await toggleView(1); // 预览 → 源码
    expect(panelEditor(), "前置：换档不换 view").toBe(view);
    expect(fab()!.hidden, "源码档不该出现").toBe(true);
  });

  it("丁 Ctrl+E 与悬浮键同一动作（照 VS Code markdown.editor.toggleLocked）", async () => {
    const { tab } = await mdPanelInPreview();
    const ctrlE = () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    ctrlE();
    await wait(60);
    expect(tab.viewMode, "Ctrl+E 进编辑档").toBe("edit");
    ctrlE();
    await wait(60);
    expect(tab.viewMode, "再按一下回预览档").toBe("preview");
  });

  it("戊 Ctrl+/ 仍是源码 ↔ 预览：从编辑档按一下回源码，再按一下落在锁着的预览", async () => {
    const { tab } = await mdPanelInPreview();
    const { togglePreviewEdit } = await import("../src/markdown");
    togglePreviewEdit();
    expect(tab.viewMode).toBe("edit");
    await toggleView(1);
    expect(tab.viewMode, "编辑档 → 源码").toBe("source");
    await toggleView(1);
    expect(tab.viewMode, "源码 → 预览（锁着的，不是编辑档）").toBe("preview");
  });

  it("己 会话把三档如实落盘（edit 不许被降级成 preview）", async () => {
    const { tab } = await mdPanelInPreview();
    const { togglePreviewEdit } = await import("../src/markdown");
    const { snapshotSession } = await import("../src/session/persist");
    togglePreviewEdit();
    expect(tab.viewMode).toBe("edit");
    const snap = snapshotSession();
    const rec = snap.panels.flatMap((p) => p.tabs).find((t) => t.path.endsWith("a.md"));
    expect(rec, "前置：夹具标签在快照里").toBeTruthy();
    expect(rec!.viewMode, "落盘的档位就是 edit").toBe("edit");
  });

  it("庚 预览档点得进焦点（读的那一档要能选字复制），编辑档不带这颗 tabindex", async () => {
    const { view } = await mdPanelInPreview();
    expect(
      view.contentDOM.getAttribute("tabindex"),
      "contenteditable=false 的元素 focus() 是空操作 ⇒ 没有 tabindex 就点不进焦点（B399 真机抓到）",
    ).toBe("0");
    expect(view.contentDOM.getAttribute("contenteditable"), "打字仍然进不去").toBe("false");
    view.focus();
    expect(document.activeElement, "有 tabindex 才能聚焦（Ctrl+A / Ctrl+C 的前提）").toBe(
      view.contentDOM,
    );
    expect(view.dom.classList.contains("cm-focused"), "聚焦后落 cm-focused").toBe(true);

    const { togglePreviewEdit } = await import("../src/markdown");
    togglePreviewEdit();
    expect(
      view.contentDOM.getAttribute("tabindex"),
      "编辑档靠 contenteditable 自己可聚焦，这颗 tabindex 必须摘掉",
    ).toBeNull();
    expect(view.contentDOM.getAttribute("contenteditable"), "编辑档能打字").toBe("true");
  });
});

/**
 * B398 · 大文件落进装饰格：**装饰臂不换**（与 VS Code 同口径，只按视口解析）。
 *
 * B397-5 判的是「大文件就地换派生 DOM 那一臂」。B398 把 2–20MB 的 Markdown 放回装饰臂：
 * `livePreview` 的语法树只解析到「视口 + 前瞻」，每键成本与源码档同一量级（3.2MB 夹具
 * 实测 5–7ms），于是换臂这条判据的载体只剩三类：非 Markdown、开关关着、`huge`（>20MB）。
 * 甲 判大文件**不换臂**（用户问出来的那一条）；乙 用一篇 `.txt` 走完整往返（换臂与换回）；
 * 丙 判 `huge` 仍换臂（VS Code 的 20MB 阈值）。
 */
describe("B398/B412 大文件落进装饰格：新面全接", () => {
  let seq = 9700;

  async function tabInPanel(
    p: Awaited<ReturnType<typeof mdPanelInPreview>>["p"],
    name: string,
    cls: "normal" | "large" | "huge",
  ) {
    const { makeDoc, makeInstance, registerDoc, attachTabToPanel } =
      await import("../src/doc-model");
    const doc = makeDoc(
      ++seq,
      "# 文档\n\n正文",
      name,
      `E:\\tmp\\${name}`,
      "UTF-8",
      "LF",
      false,
      cls,
    );
    registerDoc(doc);
    const tab = makeInstance(doc, p.panelId, "# 文档\n\n正文");
    // 建实例的缺省档是源码；这里量的是「大文件进预览档」那一形
    tab.viewMode = "preview";
    attachTabToPanel(tab, p);
    return { tab, doc };
  }

  /** 真的走一次换文档（`setState` + `viewTabId`），和 癸 / switchTab 同形。 */
  async function switchTo(
    p: Awaited<ReturnType<typeof mdPanelInPreview>>["p"],
    tab: { tabId: number; state: Parameters<EditorView["setState"]>[0] },
  ) {
    const { applyPanelMode } = await import("../src/markdown");
    p.activeTabId = tab.tabId;
    p.viewTabId = tab.tabId;
    p.view!.setState(tab.state);
    applyPanelMode(p);
  }

  async function restore(
    p: Awaited<ReturnType<typeof mdPanelInPreview>>["p"],
    small: Awaited<ReturnType<typeof mdPanelInPreview>>["tab"],
    extra: { tab: { tabId: number }; doc: { tabId: number } },
  ) {
    // 把这一格还给后续用例：换回小文件 + 摘掉临时文档（清理放 finally，红的时候也不污染下一例）
    await switchTo(p, small);
    const { tabs, docs } = await import("../src/core/app-state");
    tabs.delete(extra.tab.tabId);
    docs.delete(extra.doc.tabId);
    p.tabs = p.tabs.filter((id) => id !== extra.tab.tabId);
  }

  it("甲 切到大文件：装饰挂在这颗 view 上，没有派生预览", async () => {
    const { p, tab } = await mdPanelInPreview();
    const big = await tabInPanel(p, "big.md", "large");
    try {
      await switchTo(p, big.tab);

      expect(p.bodyEl!.querySelector(".md-preview"), "派生 DOM 那一臂已不存在").toBeNull();
      expect(
        panelEditor().dom.classList.contains("md-preview-face"),
        "大文件的装饰要真装在这颗 view 上（只解析视口，不是不解析）",
      ).toBe(true);
      expect(tab.viewMode, "前置：小文件那张仍是预览档（切换不动它）").toBe("preview");
    } finally {
      await restore(p, tab, big);
    }
  });

  it("乙 非 Markdown 落进装饰格：装饰摘干净，切回小文件再落上", async () => {
    const { p, tab } = await mdPanelInPreview();
    const txt = await tabInPanel(p, "note.txt", "normal");
    try {
      await switchTo(p, txt.tab);

      expect(
        panelEditor().dom.classList.contains("md-preview-face"),
        "同一颗 view 上已经装着的装饰要摘干净（.txt 没有 markdown 语法树可用）",
      ).toBe(false);
      expect(p.bodyEl!.querySelector(".md-preview"), "B412：任何文档都不再有派生预览").toBeNull();

      await switchTo(p, tab);

      expect(
        panelEditor().dom.classList.contains("md-preview-face"),
        "换回 Markdown ⇒ 装饰重新落在这颗 view 上",
      ).toBe(true);
    } finally {
      await restore(p, tab, txt);
    }
  });

  it("丙 huge 档（>20MB）同样走装饰面（B412：新面全接，用户拍板）", async () => {
    const { p, tab } = await mdPanelInPreview();
    const huge = await tabInPanel(p, "huge.md", "huge");
    try {
      await switchTo(p, huge.tab);

      expect(p.bodyEl!.querySelector(".md-preview"), "huge 档也不再回派生预览").toBeNull();
      expect(
        panelEditor().dom.classList.contains("md-preview-face"),
        "新面全接 ⇒ huge 档照样装装饰",
      ).toBe(true);
    } finally {
      await restore(p, tab, huge);
    }
  });
});

describe("B397-1/B412 守卫 · 装饰面只有一个入口、一道闸", () => {
  it("lifecycle.ts 不再自己分臂（B412：旧预览臂删除 ⇒ 装备全部收在 markdown.ts）", () => {
    const src = codeOf("src/tabs/lifecycle.ts");
    expect(src, "挂载点不该再问「挂哪一臂」").not.toContain("shouldMountPreview(");
    expect(src, "也不该再放换臂用的类名").not.toContain("deco-face");
  });

  it("markdown.ts：装配装饰扩展的唯一入口必含谓词，且装配器各只出现一次", () => {
    const src = codeOf("src/markdown.ts");
    expect(src, "`on` 里摘掉谓词 = 绕过「是不是 Markdown」那道闸").toMatch(
      /const on = [^\n]*&& shouldMountPreview\(tab\)/,
    );
    for (const name of ["previewFace(", "previewLock("]) {
      const n = (src.match(new RegExp(name.replace("(", "\\("), "g")) ?? []).length;
      expect(n, `多一处 ${name} 就是一个不问闸的新入口`).toBe(1);
    }
  });

  it("谓词本体只问「是不是 Markdown」；开关已删（B412）", () => {
    const src = codeOf("src/preview/eligibility.ts");
    expect(src, "入口谓词不许搬家").toContain("export function shouldMountPreview");
    expect(src, "开关删除之后不许再读设置").not.toContain("settings");
    expect(src, "体积档不再是闸（用户拍板：新面全接）").not.toContain("huge");
  });

  it("镜像那一类机械不许被搬回来（一格一颗 view 是形态，不是偏好）", () => {
    const prod = [
      "src/markdown.ts",
      "src/main.ts",
      "src/tabs/lifecycle.ts",
      "src/core/app-state.ts",
    ];
    for (const f of prod) {
      const src = codeOf(f);
      for (const name of [
        "createDecoMirror",
        "syncDecoMirrors",
        "refreshDecoMirror",
        "decoMirror",
      ]) {
        expect(src, `${f} 里不该再出现 ${name}`).not.toContain(name);
      }
    }
    expect(
      codeOf("src/styles/global.css"),
      "global.css 里 `.md-preview-face-host` 那批覆盖随镜像一起作废（恢复它等于恢复两套行盒）",
    ).not.toContain(".md-preview-face-host");
  });
});

/**
 * B397-1 · 「谁给面板的 view 换 state，谁就得让档位重新落一次」。
 *
 * 原来是 `refreshDecoMirror` 播种；一颗 view 两档之后要落的不再是镜像，而是**档位**：
 * `makeTabState` 建出来的 compartment 从空起步，换完 state 不重落，预览格就退回裸文本，
 * 而且没有任何报错（数据不坏，那一格只是不再所见即所得）。
 * 静态数一遍仍是这里最划算的判据：漏接线的那一形在 jsdom 里造齐四条真路径成本太高。
 */
describe("B397-1 换 state 必重落档位", () => {
  for (const f of ["src/tabs/lifecycle.ts", "src/tabs/split.ts", "src/io/files.ts"]) {
    it(`${f}：applyPanelMode 的发数不少于 view.setState 的发数`, () => {
      const src = codeOf(f);
      const sets = (src.match(/view\.setState\(/g) ?? []).length;
      const lands = (src.match(/applyPanelMode\(/g) ?? []).length;
      expect(sets, `${f} 一条 setState 都没有 ⇒ 判据空转，先确认扫描点没搬走`).toBeGreaterThan(0);
      expect(
        lands,
        `${f}：${sets} 发 view.setState，只有 ${lands} 发档位重落`,
      ).toBeGreaterThanOrEqual(sets);
    });
  }
});

/**
 * B391F-1 · 同一颗 view ⇒ 天然同一套几何。
 *
 * 原来这一节判的是「装饰面宿主 `.md-preview-face-host` 不在 `.panel-editor` 里，三条排版 token
 * 一条都吃不到」（真机实测：同一篇 5001 行，源码格行距 18.05px、镜像 13.80px ⇒ 逐行对齐必差一行）。
 * 镜像没了，那个结构性病灶也没了：装饰就挂在拿这三条 token 的那颗 view 上。
 * 所以判据换成问「token 还在不在」+「两套几何的那个载体是不是真没了」。
 */
describe("B397-1 所见即所得吃编辑器自己的排版 token", () => {
  function cssBlocks(): { sel: string; body: string }[] {
    const raw = readFileSync("src/styles/global.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const out: { sel: string; body: string }[] = [];
    for (const m of raw.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ sel: m[1].trim(), body: m[2] });
    }
    return out;
  }

  const onPanelEditor = (decl: string) =>
    cssBlocks().some(
      (b) =>
        b.body.includes(decl) &&
        b.sel.split(",").some((s) => s.includes(".panel-editor") && s.includes(".cm-")),
    );

  for (const [name, decl] of [
    ["字号", "font-size: var(--font-size)"],
    ["字体", "var(--font-code)"],
    ["行距", "line-height: var(--editor-line-height"],
  ] as const) {
    it(`${name}：有一条把该声明给到 .panel-editor 里 .cm-* 的规则（装饰挂的就是这颗 view）`, () => {
      expect(onPanelEditor(decl), `global.css 里没有覆盖 .panel-editor 的「${decl}」规则`).toBe(
        true,
      );
    });
  }

  it("预览态不许把 .panel-editor 藏掉（藏了 = 预览格一片空白）", () => {
    const raw = readFileSync("src/styles/preview.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      raw,
      "B412：三档共用这一颗编辑器 ⇒ 任何 mode-* 下都不许出现「把 .panel-editor 藏起来」的规则",
    ).not.toMatch(
      /\.panel-host[^{]*mode-(?:preview|source)[^{]*\.panel-editor\s*\{[^}]*display:\s*none/,
    );
  });
});

/**
 * B391F-3 · 挂哪一臂的三道闸（切片 11 那一形，原样保留）。
 *
 * 谓词搬到了 `src/preview/eligibility.ts` —— 一颗 view 两档之后「开不开装饰」每次换档都
 * 要问一遍（`applyPanelMode` 也问它），留在 lifecycle 里就得让 markdown 反向 import 过去。
 * 走谓词而不是整窗启动：jsdom 里造一篇 `.txt` 与一份 `huge` 文档的**真**面板成本，
 * 全花在装配夹具上，判据本身一个字都不多。
 */
describe("B391F-3 装饰档挂载的三道闸", () => {
  let docSeq = 9100;

  async function tabOf(name: string, sizeClass: "normal" | "large" | "huge") {
    const { docs } = await import("../src/core/app-state");
    const { makeDoc, makeInstance, registerDoc } = await import("../src/doc-model");
    const doc = makeDoc(
      ++docSeq,
      "# 标题\n\n正文",
      name,
      `E:\\tmp\\${name}`,
      "UTF-8",
      "LF",
      false,
      sizeClass,
    );
    registerDoc(doc);
    return { tab: makeInstance(doc, 0, "# 标题\n\n正文"), docId: doc.tabId, docs };
  }

  it("Markdown + normal ⇒ 挂", async () => {
    const { tab } = await tabOf("b.md", "normal");
    const { shouldMountPreview } = await import("../src/preview/eligibility");
    expect(shouldMountPreview(tab), "这一形是装饰档的正题，判 false 就等于把功能关了").toBe(true);
  });

  it("Markdown + large 档 ⇒ 挂（B398：只解析视口，2–20MB 与源码档同一量级）", async () => {
    const { tab } = await tabOf("c-large.md", "large");
    const { shouldMountPreview } = await import("../src/preview/eligibility");
    expect(shouldMountPreview(tab), "这一档正是 B398 放回来的，判 false 就把大文件又挡在外面").toBe(
      true,
    );
  });

  it("Markdown + huge 档 ⇒ 也挂（B412：新面全接，体积不再设闸）", async () => {
    const { tab } = await tabOf("c-huge.md", "huge");
    const { shouldMountPreview } = await import("../src/preview/eligibility");
    expect(shouldMountPreview(tab)).toBe(true);
  });

  it("非 Markdown（.txt）⇒ 不挂（装饰吃 markdown 语法树）", async () => {
    const { tab } = await tabOf("d.txt", "normal");
    const { shouldMountPreview } = await import("../src/preview/eligibility");
    expect(shouldMountPreview(tab)).toBe(false);
  });

  it("孤儿实例（文档不在册）⇒ 不挂，且**不许抛**", async () => {
    const { shouldMountPreview } = await import("../src/preview/eligibility");
    const ghost = await tabOf("e.md", "normal");
    ghost.docs.delete(ghost.docId); // 抽掉文档记录：`docOf` 这一形会抛
    expect(() => shouldMountPreview(ghost.tab)).not.toThrow();
    expect(shouldMountPreview(ghost.tab)).toBe(false);
    expect(shouldMountPreview(undefined), "空面板没有活动标签 ⇒ 同样不挂").toBe(false);
  });
});

/**
 * B397-1/B412 · 「可见侧」必须按**实际存在的滚动面**回答。
 *
 * B412 起一格只有一颗编辑器 view（预览 / 编辑 / 源码三档共用），`sideOfPanel` 永远答
 * editor；答 preview 会让 `faceOf` 返回 null ⇒ 这一格整个不注册进协调器，症状是
 * 「滚动谁都不跟着动、切回来位置不对」，而日志里只留一条「无滚动面」。
 */
describe("B397-1/B412 一面之格没有 preview 侧", () => {
  it("预览档 ⇒ sideOfPanel 答 editor", async () => {
    const { sideOfPanel, faceOf } = await import("../src/sync-scroll/wire");
    const { tabs } = await import("../src/core/app-state");
    const p = (await mdPanelInPreview()).p;
    const tab = tabs.get(p.viewTabId ?? p.activeTabId)!;
    expect(tab.viewMode, "前置：这一格在预览档").toBe("preview");
    expect(sideOfPanel(p), "只有一个面 ⇒ 可见侧只能是 editor").toBe("editor");
    expect(faceOf(p, "editor"), "editor 侧必须量得出面").not.toBeNull();
  });
});
