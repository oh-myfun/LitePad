// @vitest-environment jsdom
// 悬浮查找/替换栏行为测试。
// 用户要求（B39）：①悬浮栏只作用于当前活动文档——不得有范围下拉，也不得做跨文件/文件夹搜索；
// ②不绑定文件/面板——切换标签、分屏都不自动关闭；
// ③查找/替换/选项（大小写、全词、正则）都在这一栏里。本文件覆盖这些交互契约。
import { describe, it, expect } from "vitest";
import { createFindBar, type FindBarQuery } from "../src/shell/findbar";

function mount(overrides: Partial<Parameters<typeof createFindBar>[1]> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const calls: string[] = [];
  let lastQuery: FindBarQuery | null = null;
  const bar = createFindBar(host, {
    onQueryChange: (q) => {
      lastQuery = q;
      calls.push("change");
    },
    onStep: (dir, q) => {
      lastQuery = q;
      calls.push(`step:${dir}`);
    },
    onReplace: (q) => {
      lastQuery = q;
      calls.push("replace");
    },
    onReplaceAll: (q) => {
      lastQuery = q;
      calls.push("replaceAll");
    },
    onClose: () => calls.push("close"),
    ...overrides,
  });
  const dom = host.querySelector<HTMLElement>(".find-bar")!;
  const q = <T extends HTMLElement>(sel: string): T => dom.querySelector<T>(sel)!;
  const byText = (text: string): HTMLButtonElement =>
    [...dom.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === text,
    )!;
  return {
    host,
    dom,
    bar,
    calls,
    q,
    byText,
    lastQuery: () => lastQuery,
  };
}

function key(el: HTMLElement, k: string, shift = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
}

describe("悬浮查找栏：入口与当前文档范围", () => {
  it("未打开时不可见，open() 后可见", () => {
    const m = mount();
    expect(m.bar.isOpen(), "初始应关闭").toBe(false);
    m.bar.open();
    expect(m.bar.isOpen()).toBe(true);
    expect(m.dom.hidden).toBe(false);
  });

  it("B39：不得再有范围下拉，也不得再有文件夹搜索控件/结果列表", () => {
    const m = mount();
    // 范围下拉是「选查找范围」的唯一入口，用户要求去掉
    expect(m.dom.querySelector(".find-scope"), "不得再有范围下拉").toBeNull();
    expect(m.dom.querySelector(".find-folder"), "不得再有搜索目录输入").toBeNull();
    expect(m.dom.querySelector(".find-results"), "跨文件结果列表应一并移除").toBeNull();
    expect(m.dom.querySelectorAll(".find-hit")).toHaveLength(0);
    // 按钮只剩：× / ↑ / ↓ / 替换 / 全部替换
    const labels = [...m.dom.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(labels).toEqual(["×", "↑", "↓", "替换", "全部替换"]);
  });

  it("查询对象只含查找/替换/选项，不含 scope/folder", () => {
    const m = mount();
    m.bar.open();
    expect(Object.keys(m.lastQuery()!).sort()).toEqual([
      "caseSensitive",
      "regexp",
      "replace",
      "text",
      "wholeWord",
    ]);
  });

  it("回车下一个、Shift+回车上一个", () => {
    const m = mount();
    m.bar.open();
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    key(input, "Enter", true);
    // open() 先同步一次查询（刷新高亮），随后输入变更再同步一次
    expect(m.calls).toEqual(["change", "change", "step:1", "step:-1"]);
    expect(m.lastQuery()?.text).toBe("abc");
  });

  it("种子文本在 open() 时写入并只同步一次查询", () => {
    const m = mount();
    m.bar.open("选中文本");
    expect(m.q<HTMLInputElement>(".find-input").value).toBe("选中文本");
    expect(m.calls).toEqual(["change"]);
    expect(m.lastQuery()?.text).toBe("选中文本");
  });

  it("替换按钮始终可用（不再有「文件夹范围不支持写回」的禁用态）", () => {
    const m = mount();
    m.bar.open();
    expect(m.q<HTMLInputElement>(".find-replace-input").disabled).toBe(false);
    expect(m.byText("替换").disabled).toBe(false);
    expect(m.byText("全部替换").disabled).toBe(false);
  });

  it("选项（大小写/全词/正则）进入查询对象", () => {
    const m = mount();
    m.bar.open();
    const boxes = [...m.dom.querySelectorAll<HTMLInputElement>(".find-opt input")];
    expect(boxes).toHaveLength(3);
    boxes[0].checked = true;
    boxes[2].checked = true;
    boxes[0].dispatchEvent(new Event("change"));
    boxes[2].dispatchEvent(new Event("change"));
    expect(m.lastQuery()?.caseSensitive).toBe(true);
    expect(m.lastQuery()?.wholeWord).toBe(false);
    expect(m.lastQuery()?.regexp).toBe(true);
  });
});

describe("悬浮查找栏：不绑定文件/面板", () => {
  it("切换文档（retarget）后仍然打开，并把查询重新应用到新视图", () => {
    const m = mount();
    m.bar.open();
    m.q<HTMLInputElement>(".find-input").value = "keep";
    m.bar.retarget();
    expect(m.bar.isOpen(), "切文档后查找栏不能被关掉").toBe(true);
    expect(m.lastQuery()?.text).toBe("keep");
  });

  it("只有当调用 close / Esc / × 时才关闭，并回调 onClose", () => {
    const m = mount();
    m.bar.open();
    m.bar.close();
    expect(m.bar.isOpen()).toBe(false);
    expect(m.calls).toContain("close");

    m.bar.open();
    key(m.q<HTMLElement>(".find-input"), "Escape");
    expect(m.bar.isOpen(), "Esc 应关闭").toBe(false);

    m.bar.open();
    m.byText("×").click();
    expect(m.bar.isOpen()).toBe(false);
  });

  it("状态与计数由主程序写入", () => {
    const m = mount();
    m.bar.open();
    m.bar.setCount("第 2/9 处");
    m.bar.setStatus("已替换 12 处");
    expect(m.q(".find-count").textContent).toBe("第 2/9 处");
    expect(m.q(".find-status").textContent).toContain("12 处");
  });

  it("标题栏可拖动（指针事件序列，HTML5 DnD 在 WebView2 下不可用）", () => {
    const m = mount();
    m.bar.open();
    const title = m.q<HTMLElement>(".find-bar-title");
    title.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 200, clientY: 60, button: 0 }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 90 }),
    );
    expect(document.body.classList.contains("layout-dragging")).toBe(true);
    expect(m.dom.style.left).toBe("100px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 90 }));
    expect(document.body.classList.contains("layout-dragging")).toBe(false);
  });
});
