// @vitest-environment jsdom
// 悬浮查找/替换栏行为测试。
// 用户要求：①一个悬浮栏统一查找/替换/跨文档查找；②不绑定文件/面板——切换标签、分屏都不自动关闭；
// ③范围不用下拉菜单——跨文档能力是「所有打开的文档」勾选框；④不做文件夹搜索（不读盘）。
// 本文件覆盖这些交互契约。
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
    onSearchAll: (q) => {
      lastQuery = q;
      calls.push("searchAll");
      return hits;
    },
    onOpenHit: (h) => calls.push(`hit:${h.name}:${h.line}`),
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
    docsChk: () => q<HTMLInputElement>(".find-opt-docs input"),
    hitRows: () => [...dom.querySelectorAll<HTMLElement>(".find-hit")],
  };
}

function key(el: HTMLElement, k: string, shift = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
}

function toggle(el: HTMLInputElement, on: boolean): void {
  el.checked = on;
  el.dispatchEvent(new Event("change"));
}

function hit(name: string, line: number): FindHit {
  return {
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
  it("未打开时不可见，open() 后可见", () => {
    const m = mount();
    expect(m.bar.isOpen(), "初始应关闭").toBe(false);
    m.bar.open();
    expect(m.bar.isOpen()).toBe(true);
    expect(m.dom.hidden).toBe(false);
  });

  it("范围必须是勾选框而不是下拉菜单，且不得有文件夹搜索控件", () => {
    const m = mount();
    // 范围下拉是「选查找范围」的旧入口，用户要求去掉
    expect(m.dom.querySelector(".find-scope"), "不得再有范围下拉").toBeNull();
    expect(m.dom.querySelector("select"), "查找栏内不应有任何下拉菜单").toBeNull();
    expect(m.dom.querySelector(".find-folder"), "不得再有搜索目录输入").toBeNull();
    // 跨文档能力改为勾选
    const docs = m.docsChk();
    expect(docs, "必须有「所有打开的文档」勾选框").toBeTruthy();
    expect(docs.checked, "默认只查当前文档").toBe(false);
    expect(m.q(".find-opt-docs").textContent).toContain("所有打开的文档");
  });

  it("查询对象含 allDocs 勾选态，且不含 scope/folder", () => {
    const m = mount();
    m.bar.open();
    expect(Object.keys(m.lastQuery()!).sort()).toEqual([
      "allDocs",
      "caseSensitive",
      "regexp",
      "replace",
      "text",
      "wholeWord",
    ]);
  });

  it("未勾选时：不显示「查找全部」，回车为下一个 / Shift+回车为上一个", () => {
    const m = mount();
    m.bar.open();
    expect(m.byText("查找全部").style.display, "当前文档范围不需要「查找全部」").toBe("none");
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    key(input, "Enter", true);
    // open() 先同步一次查询（刷新高亮），随后输入变更再同步一次
    expect(m.calls).toEqual(["change", "change", "step:1", "step:-1"]);
    expect(m.lastQuery()?.text).toBe("abc");
  });

  it("勾选「所有打开的文档」后：显示「查找全部」，回车执行跨文档查找并渲染结果", () => {
    const m = mount();
    m.setHits([hit("a.md", 3), hit("b.md", 7)]);
    m.bar.open();
    toggle(m.docsChk(), true);
    expect(m.lastQuery()?.allDocs, "勾选态必须进入查询对象").toBe(true);
    expect(m.byText("查找全部").style.display).toBe("");

    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    expect(m.calls).toContain("searchAll");
    const rows = m.hitRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("a.md:3");
    rows[1].click();
    expect(m.calls[m.calls.length - 1]).toBe("hit:b.md:7");
  });

  it("「查找全部」按钮与回车等效，空查询给提示且不产生结果", () => {
    const m = mount();
    m.setHits([hit("a.md", 1)]);
    m.bar.open();
    toggle(m.docsChk(), true);
    m.byText("查找全部").click();
    expect(m.calls).not.toContain("searchAll");
    expect(m.q(".find-status").textContent).toBe("请输入查找内容");
    expect(m.hitRows()).toHaveLength(0);
  });

  it("取消勾选后清空结果列表并收起「查找全部」", () => {
    const m = mount();
    m.setHits([hit("a.md", 3)]);
    m.bar.open();
    toggle(m.docsChk(), true);
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    expect(m.hitRows()).toHaveLength(1);

    toggle(m.docsChk(), false);
    expect(m.hitRows()).toHaveLength(0);
    expect(m.q<HTMLElement>(".find-results").hidden).toBe(true);
    expect(m.byText("查找全部").style.display).toBe("none");
  });

  it("查询变更会作废上一次的跨文档结果，避免展示过期命中", () => {
    const m = mount();
    m.setHits([hit("a.md", 3)]);
    m.bar.open();
    toggle(m.docsChk(), true);
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    expect(m.hitRows()).toHaveLength(1);
    input.value = "todo2";
    input.dispatchEvent(new Event("input"));
    expect(m.hitRows()).toHaveLength(0);
  });

  it("种子文本在 open() 时写入并只同步一次查询", () => {
    const m = mount();
    m.bar.open("选中文本");
    expect(m.q<HTMLInputElement>(".find-input").value).toBe("选中文本");
    expect(m.calls).toEqual(["change"]);
    expect(m.lastQuery()?.text).toBe("选中文本");
  });

  it("替换控件始终可用（不做文件夹搜索，故不存在「不能写回」的禁用态）", () => {
    const m = mount();
    m.bar.open();
    expect(m.q<HTMLInputElement>(".find-replace-input").disabled).toBe(false);
    expect(m.byText("替换").disabled).toBe(false);
    expect(m.byText("全部替换").disabled).toBe(false);
    m.byText("全部替换").click();
    expect(m.calls).toContain("replaceAll");
  });

  it("选项（大小写/全词/正则）进入查询对象", () => {
    const m = mount();
    m.bar.open();
    const boxes = [...m.dom.querySelectorAll<HTMLInputElement>(".find-opt input")];
    expect(boxes, "三个匹配选项 + 一个范围勾选").toHaveLength(4);
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

  it("setHits 直接渲染结果并给出「N 条结果（M 个文档）」", () => {
    const m = mount();
    m.bar.open();
    m.bar.setHits([hit("a.md", 3), hit("b.md", 7)]);
    expect(m.hitRows()).toHaveLength(2);
    expect(m.q(".find-status").textContent).toContain("2 条结果（2 个文档）");
    m.bar.setHits([]);
    expect(m.hitRows()).toHaveLength(0);
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
