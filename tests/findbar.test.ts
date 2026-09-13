// @vitest-environment jsdom
// 悬浮查找/替换栏行为测试。
// 用户要求：①一个悬浮栏统一查找/替换/跨文件；②不绑定文件/面板——切换标签、分屏都不自动关闭；
// ③栏内可切范围（当前文档 / 所有打开的文档 / 文件夹）。本文件覆盖这些交互契约。
import { describe, it, expect } from "vitest";
import { createFindBar, type FindBarQuery, type FindHit } from "../src/shell/findbar";

function mount(overrides: Partial<Parameters<typeof createFindBar>[1]> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const calls: string[] = [];
  let hits: FindHit[] = [];
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
    onSearchAll: async (q) => {
      lastQuery = q;
      calls.push("searchAll");
      return hits;
    },
    onOpenHit: (h) => calls.push(`hit:${h.name}:${h.line}`),
    onPickFolder: async () => {
      calls.push("pickFolder");
      return "C:\\notes";
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
    setHits: (h: FindHit[]) => {
      hits = h;
    },
    lastQuery: () => lastQuery,
  };
}

function key(el: HTMLElement, k: string, shift = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
}

function hit(name: string, line: number): FindHit {
  return {
    kind: "doc",
    docId: 1,
    path: `C:\\${name}`,
    name,
    line,
    col: 1,
    text: "hello",
    from: 0,
    to: 5,
  };
}

describe("悬浮查找栏：入口与范围", () => {
  it("未打开时不可见，open() 后可见并聚焦查找框", () => {
    const m = mount();
    expect(m.bar.isOpen(), "初始应关闭").toBe(false);
    m.bar.open("doc");
    expect(m.bar.isOpen()).toBe(true);
    expect(m.dom.hidden).toBe(false);
  });

  it("范围下拉必须有「当前文档 / 所有打开的文档 / 文件夹…」三项", () => {
    const m = mount();
    const values = [...m.q<HTMLSelectElement>(".find-scope").options].map((o) => o.value);
    expect(values).toEqual(["doc", "docs", "folder"]);
  });

  it("当前文档范围：回车下一个、Shift+回车上一个", () => {
    const m = mount();
    m.bar.open("doc");
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    key(input, "Enter", true);
    // 首次 open() 会先同步一次查询（刷新高亮），随后输入变更再同步一次
    expect(m.calls).toEqual(["change", "change", "step:1", "step:-1"]);
    expect(m.lastQuery()?.text).toBe("abc");
  });

  it("跨文件范围：回车执行「查找全部」，并渲染结果列表", async () => {
    const m = mount();
    m.setHits([hit("a.md", 3), hit("b.md", 7)]);
    m.bar.open("docs");
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    await new Promise((r) => setTimeout(r, 0));
    expect(m.calls).toContain("searchAll");
    const rows = [...m.dom.querySelectorAll<HTMLElement>(".find-hit")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("a.md:3");
    rows[1].click();
    expect(m.calls[m.calls.length - 1]).toBe("hit:b.md:7");
  });

  it("文件夹范围才显示目录输入与「浏览…」，替换控件禁用（磁盘文件不支持写回）", () => {
    const m = mount();
    m.bar.open("docs");
    const folder = m.q<HTMLInputElement>(".find-folder");
    expect((folder as HTMLInputElement).style.display, "非文件夹范围应隐藏目录输入").toBe("none");
    m.bar.open("folder");
    expect(folder.style.display).toBe("");
    const replace = m.q<HTMLInputElement>(".find-replace-input");
    expect(replace.disabled, "文件夹范围不能替换").toBe(true);
    expect(m.byText("全部替换").disabled).toBe(true);
    m.byText("浏览…").click();
    expect(m.calls).toContain("pickFolder");
  });

  it("选项（大小写/全词/正则）进入查询对象", () => {
    const m = mount();
    m.bar.open("doc");
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
    m.bar.open("doc");
    m.q<HTMLInputElement>(".find-input").value = "keep";
    m.bar.retarget();
    expect(m.bar.isOpen(), "切文档后查找栏不能被关掉").toBe(true);
    expect(m.lastQuery()?.text).toBe("keep");
  });

  it("只有当调用 close / Esc / × 时才关闭，并回调 onClose", () => {
    const m = mount();
    m.bar.open("doc");
    m.bar.close();
    expect(m.bar.isOpen()).toBe(false);
    expect(m.calls).toContain("close");

    m.bar.open("doc");
    key(m.q<HTMLElement>(".find-input"), "Escape");
    expect(m.bar.isOpen(), "Esc 应关闭").toBe(false);

    m.bar.open("doc");
    m.byText("×").click();
    expect(m.bar.isOpen()).toBe(false);
  });

  it("状态与计数由主程序写入", () => {
    const m = mount();
    m.bar.open("doc");
    m.bar.setCount("第 2/9 处");
    m.bar.setStatus("已在 3 个文档中替换 12 处");
    expect(m.q(".find-count").textContent).toBe("第 2/9 处");
    expect(m.q(".find-status").textContent).toContain("12 处");
  });

  it("标题栏可拖动（指针事件序列，HTML5 DnD 在 WebView2 下不可用）", () => {
    const m = mount();
    m.bar.open("doc");
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
