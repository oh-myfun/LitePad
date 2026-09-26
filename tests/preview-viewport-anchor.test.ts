// @vitest-environment jsdom
// B137 · 「预览文档如果不是激活状态，关窗重开后切回来跳到顶部（激活时却没事）」。
//
// 根因：预览容器是**面板级**的，所有标签共用一份。位置只活在 DOM 上，而：
//   · `rememberViewScroll()` 对纯预览实例直接 return —— 切走时不往它自己的快照里写；
//   · 预览容器上**没有滚动监听** —— 滚过预览从不被记录；
//   · 于是后台预览标签的位置只能靠「容器里恰好还留着那个值」。
//     一旦切走的那个标签也是预览，`applyPanelMode` 重渲染（setBlocks →
//     replaceChildren）就把 scrollTop 清零，关窗落盘读到 0 ⇒ 重开切回来必跳顶部。
//
// B139 换了思路：快照是按 tabId 索引的**全局记录**，与视图生命周期解耦 —— 切标签的
// setState、重渲染的 replaceChildren、销毁重建都只清 DOM、碰不到它。于是既不需要
// 抢记，也**不该**回头读容器（读容器等于把「谁最后摆过它」混进来）。两边仍然共用
// 同一个 `scrollTop` 槽（B136 试过拆两个字段各管一段，最后又合回来了），风险全压在
// 「这份值是谁写的」：用户滚的才记，程序摆的不记。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

/** 最后一次落盘的会话。 */
const wired = vi.hoisted(() => ({
  saved: [] as {
    panels: { tabs: { path: string; scrollTop: number | null; viewMode: string | null }[] }[];
  }[],
}));

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

/** 够长的文档：预览能滚起来。 */
const docText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // tab0 = a.md（预览态，后台），tab1 = b.md（源码态，激活）。
  // 两边都先给一份**不一样**的 px 初值：读错人的话一眼看得出。
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 1,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 30,
              cursorCol: 1,
              viewMode: "preview",
              scrollTop: 640,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              viewMode: "source",
              scrollTop: 999,
            },
          ],
        },
      ],
      layout: { kind: "leaf", panelId: 0 },
    }),
  loadSettings: () =>
    Promise.resolve({
      theme: "system",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: false,
      hot_exit: false,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 9, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: docText,
      name: path,
      path,
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
  saveSession: (state: { panels: { tabs: { path: string; scrollTop: number | null }[] }[] }) => {
    wired.saved.push(state);
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function previewRoot(): HTMLElement {
  const el = document.querySelector(".layout-panel .md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览容器没挂载");
  return el;
}
function clickTab(i: number): void {
  const tabs = Array.from(document.querySelectorAll(".layout-panel .tab")) as HTMLElement[];
  const el = tabs[i];
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}
function lastSaved(): { a: number | null; b: number | null } {
  const last = wired.saved[wired.saved.length - 1];
  const find = (p: string) => last?.panels[0]?.tabs.find((t) => t.path === p)?.scrollTop ?? null;
  return { a: find("a.md"), b: find("b.md") };
}

describe("B137 预览位置要记在标签自己那份快照里", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("① 滚预览即时记进它自己的快照，并排程落盘（B132 同款）", async () => {
    // 先把 a.md（预览态）切到前台
    clickTab(0);
    await wait(900); // 先让路上的落盘都落定，拿到干净的基线
    const before = wired.saved.length;

    const root = previewRoot();
    root.scrollTop = 640;
    root.dispatchEvent(new Event("scroll", { bubbles: false }));
    await wait(900); // 越过 800ms 防抖

    // 「写进快照」≠「存进会话」：只记不排程的话，滚过就关窗留下的是滚之前那份。
    // 这条也是①的主断言 —— 光看载荷值会被「恰好读到容器实时值」蒙混过去。
    expect(wired.saved.length, "滚过预览必须排一次落盘，而不是只写内存快照").toBeGreaterThan(
      before,
    );

    const last = wired.saved[wired.saved.length - 1];
    const a = last?.panels[0]?.tabs.find((t) => t.path === "a.md");
    expect(a, "应已落盘").toBeTruthy();
    expect(a!.scrollTop, "滚过的预览位置应在落盘载荷里").toBe(640);
  });

  it("② 切走时把预览位置写进后台标签的快照（切走的那一刻）", async () => {
    const root = previewRoot();
    root.scrollTop = 960;
    root.dispatchEvent(new Event("scroll", { bubbles: false }));
    await wait(60);

    // 切到 b.md（源码态）—— 下面故意把容器清零，模拟「切走后渲染器把预览冲掉」：
    // B139 的快照是全局记录，这一步不该带走 a.md 记下的 960。
    clickTab(1);
    await wait(60);

    // 模拟「切走之后容器被下一次渲染清零」：这正是真正的丢位置那一步
    root.scrollTop = 0;
    await wait(900); // 越过 800ms 防抖，让这次落盘真的发生

    const saved = lastSaved();
    expect(saved.a, "a.md 应留下自己滚到的 960，而不是被清零后的 0").toBe(960);
    // b.md 是源码态、自己没滚过（这里落盘时它那份还是空的）—— 位置共用同一个 px
    // 槽，所以真正要盯的是「不许被 a.md 的 960 串档」。
    expect(saved.b, "b.md 的 px 槽不许被 a.md 的预览位置串档").not.toBe(960);
  });

  it("③ 切回那个后台预览标签，回到的是它自己的位置（修复前的症状）", async () => {
    // 上面已经把容器清零了 —— 这正是修复前的现场：快照留的是旧值 / 落盘读到 0，
    // 于是「切回预览文档时跳到顶部」。
    expect(previewRoot().scrollTop, "切走后容器已被清零").toBe(0);

    clickTab(0); // 切回 a.md
    await wait(120);

    // ⚠️ 这里只断言「≈960 而不是 0」，**不钉死 960**：jsdom 不做布局，CM6 量出的
    // 「编辑器可视区顶行」是假的，于是 applyPanelMode 那次 syncToLine 会再补一刀
    // （blockTop 退化成「当前 scrollTop，减 8」），落点随 enhance() 的节奏在
    // 960 / 952 之间抖。真机上这个假坐标不存在，落点就是 960。
    // 这条要盯的是用户症状 —— 「切回预览标签别跳到顶部」：退化成旧写法时这里会是 0。
    expect(
      previewRoot().scrollTop,
      "切回 a.md 应回到它自己滚到的位置（960 附近），而不是顶部",
    ).toBeGreaterThan(500);
  });

  it("④ 钉稳之后用户自己的滚动照旧记进快照（抑制区间不许泄漏）", async () => {
    // 抑制区间的唯一真实风险：计数器忘了降回来，于是**用户**的滚动也被当成程序滚动
    // 吞掉 —— 表现是「重启后位置永远停在第一份」。③ 里 a.md 刚被切回来、预览刚被
    // 钉稳，抑制区间就落在那几帧里，这里等它解除后再滚。
    const root = previewRoot();
    await wait(120);

    root.scrollTop = 777;
    root.dispatchEvent(new Event("scroll", { bubbles: false }));
    await wait(900); // 越过 800ms 防抖

    expect(lastSaved().a, "钉稳之后用户的滚动仍须记进快照，不能被抑制区间吞掉").toBe(777);
  });
});

describe("B139 静态契约：快照按 tabId 索引，不许回头读容器", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("落盘只读标签自己的快照，不读面板上的容器", () => {
    // 用「到 return 为止」的间隔而不是「紧跟函数体开头」：函数上面要挂说明注释，
    // 咬死开头的写法一加注释就红（踩过：B139 给 viewportOfTab 补了一句注释就挂了）。
    expect(src, "取快照时只认标签字段").toMatch(
      /function viewportOfTab\(t: Tab\): number \| null \{[\s\S]{0,160}?return t\.scrollTop;/,
    );
    // 这条与上一条互为表里：裸 `return p?...`（结尾分号）就是「落盘时只读容器」
    // 的写法（B137 原状），上一条的函数体写法抓不到它，得单独盯。
    // 分号是必需的：不加的话上一条自己的 `return t.scrollTop;` 内层也可能命中，
    // 这条契约就成永远为真的摆设（退化/不退化都一样绿）。
    expect(src, "不许再退回只读容器").not.toMatch(
      /return p\?\.preview\?\.root\.scrollTop \?\? null;/,
    );
    // 同理：不许出现「按是不是正显示分流」那套判据（B137 的 shown）
    expect(src, "不再需要「正显示在面板上的那个」判据").not.toMatch(
      /const shown = p\?\.viewTabId === t\.tabId;/,
    );
  });

  it("预览只由「用户滚过」来记录，程序摆的落点要挡住", () => {
    expect(src, "滚预览必须写进它自己那份快照").toMatch(/t\.scrollTop = preview\.root\.scrollTop;/);
    expect(src, "增强后的二次定位要置抑制位").toMatch(
      /viewportWriteDepth > 0 \|\| preview\.isSuppressingScrollWrite\(\)/,
    );
  });

  it("反向验证：退化成「落盘只读容器 / 不挡程序滚动」，上二条必须失败", () => {
    // 退化两步：取快照时改读容器（B137 原状），以及去掉二次定位的抑制。
    // 这里**刻意**用整段正则而不是字面量：viewportOfTab 的函数体上方挂着说明注释，
    // 字面量一撞注释就失配，退化会悄悄变成「什么都没改」、用例跟着假绿。
    const degrade = (s: string): string =>
      s
        .replace(
          /function viewportOfTab\(t: Tab\): number \| null \{[\s\S]*?return t\.scrollTop;/,
          "function viewportOfTab(t: Tab): number | null {\n  const p = panels.get(t.panelId);\n  return p?.preview?.root.scrollTop ?? null;\n}",
        )
        .replace("viewportWriteDepth > 0 || preview.isSuppressingScrollWrite()", "false");
    const degraded = degrade(src);
    expect(degraded, "退化实现应真的换了写法").not.toBe(src);

    expect(degraded, "退化后退回「只读容器」写法（第一条的 not.toMatch 必须命中）").toMatch(
      /return p\?\.preview\?\.root\.scrollTop \?\? null;/,
    );
    // 方向：「源码必须有这个判据」⇒ 退化后它该**消失** ⇒ 这里用 not.toMatch。
    // （写成 toMatch 就永远为真，退化用例会假绿 —— B137 那条踩过同一个坑）
    expect(degraded, "退化后程序滚动不再被挡（第二条 toMatch 此时必须落空）").not.toMatch(
      /viewportWriteDepth > 0 \|\| preview\.isSuppressingScrollWrite\(\)/,
    );
  });
});
