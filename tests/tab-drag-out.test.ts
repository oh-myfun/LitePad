// @vitest-environment jsdom
// B400：Ctrl+拖动标签 = 把这份文档当**系统文件**拖给外部应用（VS Code / 资源管理器 / 记事本）。
//
// 手势口径（用户拍定）：「只需要让外部软件比如 vscode 接收到文件，litepad 行为不变，
// 只是拖到别的应用不产生行为」。所以两条手势严格分开：
//   · 普通拖动：HTML5 DnD，排序 / 跨格 / 跨窗口 / 拖出开新窗 —— 一行不动；
//   · Ctrl+拖动：不进 HTML5，`preventDefault` 掐掉浏览器拖拽，交给原生 OLE（CF_HDROP）。
// 没有磁盘路径的标签（未命名）退回普通拖拽 —— 拖不出文件，但还能拖来拖去。
//
// 另半截：脏文档**先存盘再拖**（用户拍定），存盘失败就不起拖 —— 宁可这次手势没反应，
// 也不能让外部应用打开一份和屏幕上不一致的旧文件。
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const saveMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock("../src/io/files", () => ({
  saveDocCore: (...args: unknown[]) => saveMock(...args),
}));

import { renderTabstrip, type TabViewData } from "../src/shell/tabstrip";
import { docs, type Doc } from "../src/core/app-state";
import { canDragTabFile, dragTabAsFile } from "../src/io/filedrag";
import { fireDrag, makeDataTransfer } from "./dnd";

const FILE_PATH = "E:\\笔记\\a.md";

/** 只数起拖那一发 —— `logger.warn` 也会走 invoke("log_event")，不能用整体调用数判。 */
function startDragCalls(): unknown[][] {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "start_file_drag");
}

function fakeDoc(over: Partial<Doc> = {}): Doc {
  return {
    tabId: 1,
    path: FILE_PATH,
    name: "a.md",
    dirty: false,
    ...over,
  } as unknown as Doc;
}

function mountTab(over: Partial<TabViewData> = {}, cb: Record<string, unknown> = {}) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const tab: TabViewData = {
    tabId: 1,
    name: "a.md",
    dirty: false,
    readonly: false,
    active: true,
    path: FILE_PATH,
    ...over,
  };
  renderTabstrip(host, [tab], { onActivate: () => {}, onClose: () => {}, ...cb });
  return host.querySelector(".tab") as HTMLElement;
}

describe("B400 Ctrl+拖动标签 = 起原生文件拖拽", () => {
  it("有路径 + Ctrl：拦掉 HTML5 拖拽并交给 onDragFileOut", () => {
    const onDragFileOut = vi.fn();
    const tab = mountTab({}, { onDragFileOut });
    const dt = makeDataTransfer();
    const ev = fireDrag("dragstart", tab, dt, { ctrlKey: true });

    expect(onDragFileOut, "原生拖出的入口必须拿到被拖的标签").toHaveBeenCalledWith(1);
    expect(ev.defaultPrevented, "必须 preventDefault：否则浏览器还会起一次 HTML5 拖拽").toBe(true);
    expect(dt.types, "不得再写 HTML5 载荷（两条手势互斥）").toEqual([]);
    expect(dt.images.length, "不得给 HTML5 拖拽设影像").toBe(0);
  });

  it("没有磁盘路径：不起原生拖出（退回普通拖拽）", () => {
    const onDragFileOut = vi.fn();
    const tab = mountTab({ path: undefined }, { onDragFileOut });
    fireDrag("dragstart", tab, makeDataTransfer(), { ctrlKey: true });

    expect(onDragFileOut, "未命名标签拖不出文件，不该调原生侧").not.toHaveBeenCalled();
  });

  it("不按 Ctrl：普通拖动一行不动，绝不触发原生拖出", () => {
    const onDragFileOut = vi.fn();
    const tab = mountTab({}, { onDragFileOut });
    fireDrag("dragstart", tab, makeDataTransfer());

    expect(onDragFileOut).not.toHaveBeenCalled();
  });

  it("宿主没接 onDragFileOut：Ctrl+拖动不崩，退回普通拖拽", () => {
    const tab = mountTab({});
    const ev = fireDrag("dragstart", tab, makeDataTransfer(), { ctrlKey: true });
    expect(ev.defaultPrevented, "没有原生出口时仍走 startTabDrag（无配置时它自己拦默认）").toBe(
      true,
    );
  });
});

describe("B400 dragTabAsFile：先存盘再拖", () => {
  beforeEach(() => {
    docs.clear();
    invokeMock.mockClear();
    saveMock.mockClear();
    saveMock.mockResolvedValue(true);
  });

  it("干净文档：直接把路径交给原生侧", async () => {
    const doc = fakeDoc();
    docs.set(1, doc);
    await dragTabAsFile({ tabId: 1, docId: 1 } as never);

    expect(saveMock, "不脏就不该存盘").not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("start_file_drag", { paths: [FILE_PATH] });
  });

  it("脏文档：先存盘，再按存盘后的路径起拖", async () => {
    const doc = fakeDoc({ dirty: true });
    docs.set(1, doc);
    // 另存类分支会改写路径 —— 拖出去的必须是眼前这份内容的新位置
    saveMock.mockImplementation(async () => {
      doc.dirty = false;
      doc.path = "E:\\笔记\\新名.md";
      return true;
    });
    await dragTabAsFile({ tabId: 1, docId: 1 } as never);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("start_file_drag", { paths: ["E:\\笔记\\新名.md"] });
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0],
    );
  });

  it("脏文档存盘失败：不起拖（不能把旧内容拖给外部应用）", async () => {
    docs.set(1, fakeDoc({ dirty: true }));
    saveMock.mockResolvedValue(false);
    await dragTabAsFile({ tabId: 1, docId: 1 } as never);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(startDragCalls(), "存盘失败就必须停在本地").toEqual([]);
  });

  it("没有路径的标签：什么都不做", async () => {
    docs.set(1, fakeDoc({ path: null }));
    expect(canDragTabFile({ tabId: 1, docId: 1 } as never)).toBe(false);
    await dragTabAsFile({ tabId: 1, docId: 1 } as never);

    expect(saveMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
