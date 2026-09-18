// @vitest-environment jsdom
// 悬浮查找/替换栏行为测试（方案 C：对齐 VS Code 的紧凑浮层）。
// 契约：①一个悬浮栏统一查找/替换/跨文档查找；②不绑定文件/面板——切换标签、分屏都不自动关闭；
// ③跨文档收敛成一个文档图标（带打开文档数徽标）；④钉在右上角、不再可拖动；
// ⑤替换行可折叠；⑥匹配选项是图标开关（Aa/ab/.*/选区/AB）；⑦紧凑计数、无匹配变红。
import { describe, it, expect } from "vitest";
import { createFindBar, type FindBarQuery, type FindHit } from "../src/shell/findbar";
import { preserveCase, restrictToRange } from "../src/editor/find";

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
  const tgl = (label: string): HTMLButtonElement =>
    [...dom.querySelectorAll<HTMLButtonElement>(".find-toggle")].find(
      (b) => b.getAttribute("aria-label") === label,
    )!;
  return {
    host,
    dom,
    bar,
    calls,
    q,
    tgl,
    setHits: (h: FindHit[]) => {
      hits = h;
    },
    lastQuery: () => lastQuery,
    toggles: () => [...dom.querySelectorAll<HTMLElement>(".find-toggle")],
    docs: () => q<HTMLButtonElement>(".find-docs"),
    badge: () => q<HTMLElement>(".find-badge"),
    replaceRow: () => q<HTMLElement>(".find-row-replace"),
    chevron: () => q<HTMLButtonElement>(".find-chevron"),
    closeBtn: () => q<HTMLButtonElement>(".find-x"),
    hitRows: () => [...dom.querySelectorAll<HTMLElement>(".find-hit")],
  };
}

function key(el: HTMLElement, k: string, shift = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
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

  it("方案 C：不再有可拖动的标题栏，改为钉右上角", () => {
    const m = mount();
    m.bar.open();
    expect(m.dom.querySelector(".find-bar-title"), "标题栏与拖动把手应已移除").toBeNull();
  });

  it("范围不是下拉菜单，也不再有文件夹搜索控件", () => {
    const m = mount();
    expect(m.dom.querySelector(".find-scope"), "不得有范围下拉").toBeNull();
    expect(m.dom.querySelector("select"), "查找栏内不应有任何下拉菜单").toBeNull();
    expect(m.dom.querySelector(".find-folder"), "不得再有搜索目录输入").toBeNull();
    // 跨文档能力收敛成文档图标按钮
    expect(m.docs(), "必须有跨文档文档图标").toBeTruthy();
  });

  it("查询对象含 allDocs / inSelection / preserveCase，且不含 scope/folder", () => {
    const m = mount();
    m.bar.open();
    expect(Object.keys(m.lastQuery()!).sort()).toEqual([
      "allDocs",
      "caseSensitive",
      "inSelection",
      "preserveCase",
      "regexp",
      "replace",
      "text",
      "wholeWord",
    ]);
  });

  it("主行是查找：回车为下一个 / Shift+回车为上一个", () => {
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

  it("点击文档图标后：回车执行跨文档查找并渲染结果", () => {
    const m = mount();
    m.setHits([hit("a.md", 3), hit("b.md", 7)]);
    m.bar.open();
    m.docs().click();
    expect(m.lastQuery()?.allDocs, "点击后进入查询对象").toBe(true);
    expect(m.docs().classList.contains("on"), "激活态高亮").toBe(true);

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

  it("跨文档空查询给提示且不产生结果", () => {
    const m = mount();
    m.setHits([hit("a.md", 1)]);
    m.bar.open();
    m.docs().click();
    key(m.q<HTMLElement>(".find-input"), "Enter");
    expect(m.calls).not.toContain("searchAll");
    expect(m.q(".find-status").textContent).toBe("请输入查找内容");
    expect(m.hitRows()).toHaveLength(0);
  });

  it("关闭跨文档后清空结果列表", () => {
    const m = mount();
    m.setHits([hit("a.md", 3)]);
    m.bar.open();
    m.docs().click();
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    expect(m.hitRows()).toHaveLength(1);

    m.docs().click();
    expect(m.lastQuery()?.allDocs).toBe(false);
    expect(m.hitRows()).toHaveLength(0);
    expect(m.q<HTMLElement>(".find-results").hidden).toBe(true);
  });

  it("查询变更会作废上一次的跨文档结果，避免展示过期命中", () => {
    const m = mount();
    m.setHits([hit("a.md", 3)]);
    m.bar.open();
    m.docs().click();
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
});

describe("悬浮查找栏：方案 C 的折叠替换行与图标开关", () => {
  it("替换行默认折叠，点 chevron 展开/收起", () => {
    const m = mount();
    m.bar.open();
    expect(m.replaceRow().hidden, "默认折叠").toBe(true);
    m.chevron().click();
    expect(m.replaceRow().hidden).toBe(false);
    m.chevron().click();
    expect(m.replaceRow().hidden).toBe(true);
  });

  it("以「替换」入口打开时自动展开替换行", () => {
    const m = mount();
    m.bar.open("", true);
    expect(m.replaceRow().hidden, "替换入口应展开替换行").toBe(false);
  });

  it("focusReplace 展开替换行并聚焦替换框", () => {
    const m = mount();
    m.bar.open();
    m.bar.focusReplace();
    expect(m.replaceRow().hidden).toBe(false);
    expect(document.activeElement).toBe(m.q(".find-replace-input"));
  });

  it("五个图标开关（大小写/全词/正则/选区/保留大小写）进入查询对象", () => {
    const m = mount();
    m.bar.open();
    expect(m.toggles(), "查找行 4 个 + 替换行 1 个").toHaveLength(5);
    m.tgl("区分大小写").click();
    m.tgl("正则").click();
    m.tgl("在选区中查找").click();
    m.tgl("保留大小写").click();
    expect(m.lastQuery()?.caseSensitive).toBe(true);
    expect(m.lastQuery()?.wholeWord).toBe(false);
    expect(m.lastQuery()?.regexp).toBe(true);
    expect(m.lastQuery()?.inSelection).toBe(true);
    expect(m.lastQuery()?.preserveCase).toBe(true);
  });

  it("图标开关用 aria-pressed 表达激活态", () => {
    const m = mount();
    m.bar.open();
    const b = m.tgl("全词匹配");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    b.click();
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.classList.contains("on")).toBe(true);
  });

  it("替换控件在展开后可用（不做文件夹搜索，故无「不能写回」禁用态）", () => {
    const m = mount();
    m.bar.open("", true);
    expect(m.q<HTMLInputElement>(".find-replace-input").disabled).toBe(false);
    expect(m.q<HTMLButtonElement>(".find-replace-one").disabled).toBe(false);
    expect(m.q<HTMLButtonElement>(".find-replace-all").disabled).toBe(false);
    m.q<HTMLButtonElement>(".find-replace-all").click();
    expect(m.calls).toContain("replaceAll");
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
    m.closeBtn().click();
    expect(m.bar.isOpen()).toBe(false);
  });

  it("紧凑计数写入，且「无匹配」置警示色", () => {
    const m = mount();
    m.bar.open();
    m.bar.setCount("3 / 12");
    m.bar.setStatus("已替换 12 处");
    expect(m.q(".find-count").textContent).toBe("3 / 12");
    expect(m.q(".find-count").classList.contains("find-count-bad")).toBe(false);
    expect(m.q(".find-status").textContent).toContain("12 处");

    m.bar.setCount("无匹配");
    expect(m.q(".find-count").classList.contains("find-count-bad"), "无匹配变红").toBe(true);
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

  it("文档图标徽标显示打开文档数（仅在跨文档激活时可见）", () => {
    const m = mount();
    m.bar.open();
    m.bar.setDocCount(23);
    expect(m.badge().textContent).toBe("23");
    expect(m.badge().hidden, "未激活跨文档时徽标不显示").toBe(true);
    m.docs().click();
    expect(m.badge().hidden).toBe(false);
  });
});

// 用户实测反馈的三条：①浮层底部多一条空白 ②文档图标上的数字显示不出来 ③计数塌缩
describe("B76：状态行不占位、徽标数字必有值、选区锚点冻结", () => {
  it("打开后状态行为空时必须收起（否则浮层底部吊一条空白）", () => {
    const m = mount();
    const status = m.q<HTMLElement>(".find-status");
    // ⚠️ 判据必须落在「元素真的收起了」上：CSS 的 min-height 管的是**有文案时**的高度，
    //    空盒子照样占位；而 jsdom 没有布局，getBoundingClientRect 恒为 0，断它等于没断。
    //    创建时就要收起 —— 正常打开查找栏时主程序从不调 setStatus。
    expect(status.hidden, "创建时就该收起").toBe(true);
    m.bar.open();
    expect(status.hidden, "打开后仍收起").toBe(true);
    m.bar.setStatus("已替换 1 处");
    expect(status.hidden, "有文案时必须显示").toBe(false);
    m.bar.setStatus("");
    expect(status.hidden, "文案清空后要重新收起").toBe(true);
  });

  it("熄灭跨文档时，结果列表与「N 条结果」文案一起收掉", () => {
    const m = mount();
    m.bar.open();
    m.bar.setHits([hit("a.md", 3)]);
    expect(m.q(".find-status").textContent).toContain("条结果");
    m.docs().click(); // 点亮
    m.docs().click(); // 熄灭
    expect(m.hitRows()).toHaveLength(0);
    expect(m.q<HTMLElement>(".find-status").hidden, "别留下过期文案").toBe(true);
  });

  it("懒建后立刻点亮文档图标，徽标也必须有数字", () => {
    const m = mount();
    m.bar.open();
    // 关键：**不调 setDocCount**。查找栏是懒建的，主程序只在标签栏重绘时才喂文档数，
    // 所以「打开查找栏 → 立刻点亮文档图标」这条路是常态。
    m.docs().click();
    const b = m.badge();
    expect(b.hidden).toBe(false);
    expect(b.textContent, "空徽标 = 数字显示不出来（用户实测）").not.toBe("");
    expect(b.textContent).toBe("0");
    m.bar.setDocCount(23); // 主程序随后补喂真实数量
    expect(m.badge().textContent).toBe("23");
    m.docs().click(); // 熄灭后重亮，数字不能丢
    m.docs().click();
    expect(m.badge().textContent).toBe("23");
  });
});

describe("查找内核：选区限制与保留大小写", () => {
  it("restrictToRange 只保留完全落在选区内的命中", () => {
    const ms = [
      { from: 0, to: 3 },
      { from: 10, to: 13 },
      { from: 20, to: 23 },
    ];
    expect(restrictToRange(ms, { from: 8, to: 18 })).toEqual([{ from: 10, to: 13 }]);
    expect(restrictToRange(ms, null), "null = 不限").toHaveLength(3);
    // 部分越界的命中被剔除（替换会改文档，不能让命中跨出选区）
    expect(restrictToRange([{ from: 5, to: 12 }], { from: 8, to: 18 })).toEqual([]);
  });

  it("preserveCase 按命中词大小写迁移替换串", () => {
    expect(preserveCase("concat", "join")).toBe("join"); // 全小写 → 全小写
    expect(preserveCase("concat", "JOIN"), "全小写命中 → 替换串也压成小写").toBe("join");
    expect(preserveCase("CONCAT", "join")).toBe("JOIN"); // 全大写 → 全大写
    expect(preserveCase("CONCAT", "Join"), "全大写命中 → 替换串也抬成大写").toBe("JOIN");
    expect(preserveCase("Concat", "join")).toBe("Join"); // Title → Title
    expect(preserveCase("ConCat", "join"), "混合大小写不迁移").toBe("join");
    expect(preserveCase("Ab", "")).toBe("");
  });
});
