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

describe("B91 接线（静态断言）", () => {
  const main = readFileSync("src/main.ts", "utf-8");
  const bridge = readFileSync("src-tauri/src/dropbridge.rs", "utf-8");

  it("页面侧必须装上收接，且只处理 drop（enter/over/leave 已由页面内监听接管）", () => {
    expect(main, "必须装页面级文件拖入收接").toMatch(
      /installFileDropTarget\(\{[\s\S]{0,120}preview:[\s\S]{0,80}clear:/,
    );
    expect(main, "onDragDropEvent 只该管 drop").toMatch(/if \(p\.type !== "drop"\) return;/);
    expect(main, "出口不可用要留一行日志，别静默失效").toContain("hasFileDropBridge()");
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
