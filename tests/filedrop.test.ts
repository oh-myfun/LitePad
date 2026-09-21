// @vitest-environment jsdom
// B24：外部文件拖入增强；B70 B 档改了「弹不弹菜单」的判据；B91 换成页面内 HTML5 拖放 + 路径桥。
//  1) **落点是 Markdown 文档**且只拖了一个文件时弹菜单（打开文档 / 插入文件路径），
//     其余直接打开 —— 判据是「落到哪儿」不是「拖进来的是什么」（见 needsChoice 注释）；
//  2) 菜单两项分别驱动 onOpen / onInsert，点击后菜单关闭；
//  3) showPopupMenu 支持无锚点、按坐标弹出（拖放落点没有现成元素）；
//  4) B91：关掉 wry 原生拖放之后，「收文件」的责任落到页面上 —— dragover 必须
//     preventDefault（否则光标禁止态、drop 根本不触发），drop 必须把 File 对象交给宿主，
//     悬停高亮改由 dragover 驱动。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { readJson } from "./static";
import {
  FILE_DROP_TAG,
  bridgeMessage,
  hasFileDropBridge,
  installFileDropTarget,
  isFileDrag,
  needsChoice,
  postFilesToHost,
  showFileDropChoice,
} from "../src/shell/filedrop";

beforeAll(() => {
  if (!document.body) document.body = document.createElement("body");
  document.body.innerHTML = "";
});

describe("拖放选择菜单的判据：看落点，不看拖进来的是什么", () => {
  it("单个文件落到 Markdown 面板才问", () => {
    expect(needsChoice(["C:/docs/note.md"], true)).toBe(true);
    // 拖进来的不是 md 也要问：落点是 .md 时「插入文件路径」才有意义（图片、附件同理）
    expect(needsChoice(["C:/pics/a.png"], true), "落点是 md 就该问").toBe(true);
    expect(needsChoice(["C:/data/x.csv"], true)).toBe(true);
    // 反过来说：拖进来的是 md 而落点不是 md 文档时，用户要的是**打开**它，不该拦下来问
    expect(needsChoice(["a.md"], false), "落点不是 md 就不问").toBe(false);
    expect(needsChoice(["a.png"], false)).toBe(false);
    // 多文件不弹（菜单只处理一个文件）
    expect(needsChoice(["a.md", "b.md"], true), "多文件不弹菜单").toBe(false);
    expect(needsChoice([], true)).toBe(false);
  });
});

describe("落点选择菜单（打开文档 / 插入文件路径）", () => {
  it("渲染两个选项并分别触发回调，选择后菜单关闭", () => {
    let opened = 0;
    let inserted = 0;
    showFileDropChoice(
      "note.md",
      { x: 120, y: 80 },
      {
        onOpen: () => opened++,
        onInsert: () => inserted++,
      },
    );

    const menu = document.querySelector(".popup-menu");
    expect(menu, "应弹出菜单").toBeTruthy();
    const btns = Array.from(menu!.querySelectorAll("button"));
    expect(btns.length, "应有两项").toBe(2);
    expect(btns[0].textContent).toContain("打开");
    expect(btns[0].textContent).toContain("note.md");
    expect(btns[1].textContent).toContain("插入文件路径");

    btns[1].click();
    expect(inserted, "应触发插入路径回调").toBe(1);
    expect(opened, "不应触发打开回调").toBe(0);
    expect(document.querySelector(".popup-menu"), "选择后菜单应关闭").toBeNull();

    // 再验证「打开文档」分支
    showFileDropChoice(
      "note.md",
      { x: 120, y: 80 },
      {
        onOpen: () => opened++,
        onInsert: () => inserted++,
      },
    );
    (document.querySelector(".popup-menu button") as HTMLButtonElement).click();
    expect(opened, "应触发打开回调").toBe(1);
  });

  it("按坐标弹出（无锚点）时菜单仍挂到 body 且可重复打开", () => {
    showFileDropChoice("a.md", { x: 50, y: 60 }, { onOpen: () => {}, onInsert: () => {} });
    expect(document.querySelector(".popup-menu")).toBeTruthy();
    showFileDropChoice("b.md", { x: 70, y: 90 }, { onOpen: () => {}, onInsert: () => {} });
    const menus = document.querySelectorAll(".popup-menu");
    expect(menus.length, "重复弹出应先关旧菜单，只保留一个").toBe(1);
    expect(menus[0].textContent).toContain("b.md");
  });
});

// ------------------------------------------------------------------ B91 路径桥（页面这半边）

/** 造事件：jsdom 没有 DragEvent 构造器，用普通 Event 挂上处理器要读的属性即可。 */
function dragEvent(
  type: string,
  init: { types?: string[]; x?: number; y?: number; at?: number; files?: File[] },
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: { types: init.types ?? [], files: init.files ?? [], dropEffect: "" },
  });
  Object.defineProperty(e, "clientX", { value: init.x ?? 0 });
  Object.defineProperty(e, "clientY", { value: init.y ?? 0 });
  if (init.at !== undefined) Object.defineProperty(e, "timeStamp", { value: init.at });
  return e;
}

type HostStub = { postMessageWithAdditionalObjects: (m: string, o: unknown[]) => void };
const sent: { message: string; objects: unknown[] }[] = [];
let host: HostStub | undefined;

beforeEach(() => {
  sent.length = 0;
  host = undefined;
});

afterEach(() => {
  host = undefined;
  delete (window as unknown as { chrome?: unknown }).chrome;
});

function installHost(): void {
  host = {
    postMessageWithAdditionalObjects: (message, objects) => sent.push({ message, objects }),
  };
  (window as unknown as { chrome?: unknown }).chrome = { webview: host };
}

describe("B91 路径桥：只认文件拖拽，坐标按物理像素上报", () => {
  it("只把 Files 当文件拖入；页面内标签拖拽（自定义 MIME）不掺和", () => {
    expect(isFileDrag(null), "没有 dataTransfer 就不是文件拖拽").toBe(false);
    expect(isFileDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    // 标签拖拽走自定义 MIME：同一条 drop 事件上有它也有 Files 时必须能区分开
    expect(
      isFileDrag({ types: ["application/x-litepad-tab"] } as unknown as DataTransfer),
      "标签拖拽不该被当成文件拖入",
    ).toBe(false);
    expect(
      isFileDrag({ types: ["text/plain"] } as unknown as DataTransfer),
      "纯文本拖拽也不走这条路",
    ).toBe(false);
  });

  it("消息体带 tag 与物理像素坐标（乘 dpr）", () => {
    // ⚠️ 这里必须是**乘**：Tauri 原生拖放事件给的是物理像素，main.ts 的 dropPosOf
    // 再除以 devicePixelRatio 还原成逻辑像素。改成「直接传逻辑像素」会在 HiDPI 屏上
    // 把落点整体缩掉一半（拖到哪、开在别处），而且只在缩放 ≠ 100% 的机器上犯。
    const msg = JSON.parse(bridgeMessage(120, 80, 2));
    expect(msg).toEqual({ tag: FILE_DROP_TAG, x: 240, y: 160 });
    expect(JSON.parse(bridgeMessage(10, 10, 1))).toEqual({ tag: FILE_DROP_TAG, x: 10, y: 10 });
  });

  it("宿主出口不可用时如实回报 false（旧 WebView2 运行时），可用时把文件原样交出去", () => {
    const files = [{ name: "a.md" }] as unknown as File[];
    expect(hasFileDropBridge(), "jsdom 里没有 chrome.webview").toBe(false);
    expect(postFilesToHost(files, 1, 2, 1), "没有出口必须返回 false").toBe(false);

    installHost();
    expect(hasFileDropBridge()).toBe(true);
    expect(postFilesToHost(files, 3, 4, 2)).toBe(true);
    expect(sent.length, "只能发一条消息").toBe(1);
    expect(sent[0].objects, "File 对象要原样交给宿主（路径由它解析）").toBe(files);
    expect(JSON.parse(sent[0].message)).toEqual({ tag: FILE_DROP_TAG, x: 6, y: 8 });
  });
});

describe("B91 页面级收接：dragover 允许落点、悬停节流、离开与落地清高亮", () => {
  let previews: { x: number; y: number }[];
  let clears: number;
  let uninstall: () => void;

  beforeEach(() => {
    previews = [];
    clears = 0;
    uninstall = installFileDropTarget(
      { preview: (x, y) => previews.push({ x, y }), clear: () => clears++ },
      1,
    );
  });
  afterEach(() => uninstall());

  it("dragover 必须 preventDefault（否则光标禁止态且 drop 不触发）并高亮落点", () => {
    const over = dragEvent("dragover", { types: ["Files"], x: 30, y: 40, at: 1000 });
    document.dispatchEvent(over);
    expect(over.defaultPrevented, "不拦默认动作的话根本收不到 drop").toBe(true);
    expect(previews).toEqual([{ x: 30, y: 40 }]);
  });

  it("非文件拖拽一个字节都不该动", () => {
    const over = dragEvent("dragover", { types: ["application/x-litepad-tab"], x: 30, y: 40 });
    document.dispatchEvent(over);
    expect(over.defaultPrevented, "标签拖拽的默认动作不该被文件通道拦掉").toBe(false);
    expect(previews.length).toBe(0);
  });

  it("悬停预览按 40ms 节流（dragover 触发极密，落点判定不必跟着跑）", () => {
    document.dispatchEvent(dragEvent("dragover", { types: ["Files"], x: 1, y: 1, at: 1000 }));
    document.dispatchEvent(dragEvent("dragover", { types: ["Files"], x: 2, y: 2, at: 1010 }));
    expect(previews.length, "10ms 内的第二次不该再算一次").toBe(1);
    document.dispatchEvent(dragEvent("dragover", { types: ["Files"], x: 3, y: 3, at: 1100 }));
    expect(previews, "过了节流窗口就该跟上").toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]);
  });

  it("进出的嵌套计数：只有真的离开窗口（或计数归零）才清高亮", () => {
    document.dispatchEvent(dragEvent("dragenter", { types: ["Files"] }));
    document.dispatchEvent(dragEvent("dragenter", { types: ["Files"] }));
    document.dispatchEvent(dragEvent("dragleave", { types: ["Files"] }));
    expect(clears, "还在窗口内（只是换了个子元素）不该清").toBe(0);
    document.dispatchEvent(dragEvent("dragleave", { types: ["Files"] }));
    expect(clears, "计数归零 = 拖出窗口").toBe(1);
  });

  it("落地：拦住默认动作、清高亮、把文件交给宿主（路径由桥回传）", () => {
    installHost();
    const drop = dragEvent("drop", {
      types: ["Files"],
      x: 50,
      y: 60,
      files: [{ name: "note.md" } as unknown as File],
    });
    document.dispatchEvent(drop);
    expect(drop.defaultPrevented, "文件落进页面不该触发浏览器默认动作").toBe(true);
    expect(clears, "落地即清高亮（桥万一不可用也不能留一块高亮）").toBe(1);
    expect(sent.length, "要交给宿主换路径").toBe(1);
    expect(sent[0].objects.length).toBe(1);
    expect(JSON.parse(sent[0].message).x, "坐标按物理像素上报").toBe(50);
  });
});

// --------------------------------------------------- B91-2 回归：文件拖入不能漏给页面内编辑器

describe("B91-2 回归：文件拖入被捕获阶段拦下，不漏给页面内编辑器", () => {
  let previews: { x: number; y: number }[];
  let clears: number;
  let uninstall: () => void;
  /** 编辑器 DOM 的替身：真实环境里 CM6 把 dragover/drop 等监听挂在 `view.contentDOM` 上。 */
  let editor: HTMLElement;
  /** 替身收到的事件类型 —— 收到 `drop` 就等于 CM6 会把文件内容读出来插进文档。 */
  let leaked: string[];

  beforeEach(() => {
    previews = [];
    clears = 0;
    leaked = [];
    editor = document.createElement("div");
    editor.className = "cm-content";
    document.body.appendChild(editor);
    for (const t of ["dragenter", "dragover", "dragleave", "drop"]) {
      editor.addEventListener(t, () => leaked.push(t));
    }
    uninstall = installFileDropTarget(
      { preview: (x, y) => previews.push({ x, y }), clear: () => clears++ },
      1,
    );
  });

  afterEach(() => {
    uninstall();
    editor.remove();
  });

  it("文件落到编辑器上：编辑器收不到 drop（否则 CM6 会把文件内容读出来插进文档）", () => {
    installHost();
    const drop = dragEvent("drop", {
      types: ["Files"],
      x: 5,
      y: 6,
      files: [{ name: "note.md" } as unknown as File],
    });
    editor.dispatchEvent(drop);
    expect(drop.defaultPrevented, "默认动作必须由文件通道拦掉").toBe(true);
    expect(leaked, "编辑器不该收到 drop —— 收到就会插入文件内容").toEqual([]);
    expect(sent.length, "路径仍要交给宿主（打开/分屏逻辑不受影响）").toBe(1);
    expect(clears, "落地照常清高亮").toBe(1);
  });

  it("文件悬停也不该漏给编辑器（CM6 的 dragover 观察器会画落点光标）", () => {
    const over = dragEvent("dragover", { types: ["Files"], x: 1, y: 2, at: 2000 });
    editor.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(leaked, "文件拖拽的 dragover 不该漏下去").toEqual([]);
    expect(previews, "高亮仍由文件通道自己驱动").toEqual([{ x: 1, y: 2 }]);
  });

  it("编辑器内部拖选区（types=Text）原样放行：那是 CM6 自己的功能", () => {
    const drop = dragEvent("drop", { types: ["Text"], x: 1, y: 1 });
    editor.dispatchEvent(drop);
    expect(drop.defaultPrevented, "不该拦 CM6 自己的拖选区").toBe(false);
    expect(leaked, "必须留给 CM6").toEqual(["drop"]);
  });

  it("标签拖拽（自定义 MIME）原样放行：不归文件通道管", () => {
    const drop = dragEvent("drop", { types: ["application/x-litepad-tab"], x: 1, y: 1 });
    editor.dispatchEvent(drop);
    expect(drop.defaultPrevented, "标签拖拽的默认动作不该被文件通道拦掉").toBe(false);
    expect(leaked, "要留给 tabdnd 认领").toEqual(["drop"]);
  });
});

describe("B91 接线（静态断言）", () => {
  const main = readFileSync("src/main.ts", "utf-8");
  const filedrop = readFileSync("src/shell/filedrop.ts", "utf-8");
  const bridge = readFileSync("src-tauri/src/dropbridge.rs", "utf-8");

  it("页面侧必须装上收接，且只处理 drop（enter/over/leave 已由页面内监听接管）", () => {
    expect(main, "必须装页面级文件拖入收接").toMatch(
      /installFileDropTarget\(\{[\s\S]{0,120}preview:[\s\S]{0,80}clear:/,
    );
    expect(main, "onDragDropEvent 只该管 drop").toMatch(/if \(p\.type !== "drop"\) return;/);
    expect(main, "出口不可用要留一行日志，别静默失效").toContain("hasFileDropBridge()");
  });

  it("页面级监听必须挂捕获阶段 + stopPropagation（冒泡阶段抢不过 CM6）", () => {
    // ⚠️ 这条是 B91-2 回归的契约：CM6 的 drop 处理器一旦发现 dataTransfer.files 非空，
    // 就用 FileReader.readAsText 把**文件内容**读出来插进文档。监听挂在冒泡阶段时它已经
    // 跑完了 —— 只有捕获阶段（document 上比任何页面内组件都早）+ stopPropagation 拦得住。
    for (const t of ["dragenter", "dragover", "dragleave", "drop"]) {
      expect(filedrop, `${t} 必须挂捕获阶段`).toMatch(
        new RegExp(`addEventListener\\("${t}", on\\w+, CAPTURE\\)`),
      );
    }
    expect(filedrop, "CAPTURE 必须是 { capture: true }").toMatch(/capture:\s*true/);
    expect(filedrop, "光 preventDefault 不够，还要 stopPropagation").toContain("stopPropagation()");
    // 卸载也要带同样的选项，否则 removeEventListener 摘不掉
    expect(filedrop).toMatch(/removeEventListener\("drop", onDrop, CAPTURE\)/);
  });

  it("落点之后怎么办：仍按面板+分区打开，落点是 Markdown 才弹菜单", () => {
    expect(main, "落地必须按面板+分区打开（边缘分屏走 splitPanelWithTab）").toMatch(
      /splitPanelWithTab\(target\.panelId, dir, tabId, newFirst, false\)/,
    );
    expect(main, "doOpen 必须支持指定落点面板").toContain(
      "async function doOpen(\n  presetPath?: string,\n  encoding?: string,\n  targetPanelId?: number,\n)",
    );
    expect(main, "必须把落点面板的 md 判据传进去").toMatch(
      /needsChoice\(p\.paths, target !== null && panelDocIsMarkdown\(target\.panelId\)\)/,
    );
    expect(main, "「插入文件路径」必须插入活动编辑器光标处").toContain(
      "function insertDroppedPath(path: string)",
    );
  });

  it("桥的 tag 必须与 Rust 侧逐字一致（对不上 = 消息被静默丢弃）", () => {
    const rustTag = bridge.match(/pub const MSG_TAG: &str = "([^"]+)"/)?.[1];
    expect(rustTag, "Rust 侧必须有 MSG_TAG 常量").toBeTruthy();
    expect(rustTag, "两侧 tag 必须逐字一致").toBe(FILE_DROP_TAG);
  });
});

describe("B91 路径桥静态契约（从 regressions 拆出）", () => {
  it("拖文件进窗口仍要拿得到真实路径：关掉原生拖放必须与路径桥成对出现（B91）", () => {
    // 用户报告：拖文件进窗口应打开文件而不是把内容插进当前文档。
    //
    // B91 起改走「页面内 HTML5 拖放 + 路径桥」：wry 的原生处理器（dragDropEnabled: true）
    // 在 Windows 上会 `SetAllowExternalDrop(false)` 并覆盖子窗口的 drop target，把页面内
    // HTML5 拖放一起废掉（源码位置与原文注释见 `src-tauri/src/dropbridge.rs` 模块头）。
    // 关掉它之后路径由 WebView2 官方出口补回：页面 postMessageWithAdditionalObjects →
    // 宿主从 `ICoreWebView2File::Path` 取真实路径。
    //
    // ⚠️ 这条断言是**成对**的，拆开任一半都是静默故障：
    //   · 只改配置不装桥 → 拖文件进来毫无反应；
    //   · 只留桥不改配置 → 页面内收不到 drop，桥永远等不到消息。
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = (conf.app?.windows ?? []).find((w: { label?: string }) => w.label === "main");
    expect(win, "tauri.conf.json 应有 main 窗口配置").toBeTruthy();
    expect(win.dragDropEnabled, "必须关掉 wry 原生拖放（否则页面内 HTML5 拖放全废）").toBe(false);

    const bridge = readFileSync("src-tauri/src/dropbridge.rs", "utf-8");
    expect(bridge, "必须用 ICoreWebView2File 取真实路径").toContain("ICoreWebView2File");
    expect(bridge, "必须发与 Tauri 逐字同名的事件（前端因此零改动）").toContain(
      '"tauri://drag-drop"',
    );
    const main = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(main, "主窗口必须装桥").toMatch(
      /dropbridge::install\(app\.handle\(\), windows::MAIN_LABEL\)/,
    );
    const wins = readFileSync("src-tauri/src/windows.rs", "utf-8");
    expect(wins, "卫星窗口建窗时必须一起关掉原生拖放").toContain(".drag_and_drop(false)");
    expect(wins, "卫星窗口必须装桥（文件也可以落在它上面）").toMatch(
      /dropbridge::install\(app, label\)/,
    );
  });
});
