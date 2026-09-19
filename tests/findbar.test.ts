// @vitest-environment jsdom
// 悬浮查找/替换栏行为测试（方案 C：对齐 VS Code 的紧凑浮层）。
// 契约：①一个悬浮栏统一查找/替换/跨文档查找；②不绑定文件/面板——切换标签、分屏都不自动关闭；
// ③跨文档收敛成一个文档图标（B80：右上角徽标 = 跨文档 a/b，不再有结果列表）；
// ④钉在右上角、不再可拖动；⑤替换行可折叠；⑥匹配选项是图标开关（B80 起全部照搬 codicon）；
// ⑦紧凑计数、无匹配变红。
import { describe, it, expect } from "vitest";
import { createFindBar, type FindBarQuery } from "../src/shell/findbar";
import { CODICONS } from "../src/shell/codicons";
import { preserveCase, restrictToRange } from "../src/editor/find";

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
    lastQuery: () => lastQuery,
    toggles: () => [...dom.querySelectorAll<HTMLElement>(".find-toggle")],
    docs: () => q<HTMLButtonElement>(".find-docs"),
    badge: () => q<HTMLElement>(".find-badge"),
    // 「在选区中查找」B78 起从输入框内嵌开关（.find-toggle）挪到了 prev/next 之后，
    // 成了工具栏上的一颗 .find-sel —— 不再被 .find-toggle 选中。
    selBtn: () => q<HTMLButtonElement>(".find-sel"),
    sash: () => q<HTMLElement>(".find-sash"),
    replaceRow: () => q<HTMLElement>(".find-row-replace"),
    chevron: () => q<HTMLButtonElement>(".find-chevron"),
    closeBtn: () => q<HTMLButtonElement>(".find-x"),
  };
}

function key(el: HTMLElement, k: string, shift = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true }));
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

  it("点击文档图标后：回车与单文档一致地走「下一个」，徽标显示 a/b", () => {
    // 09-20 统一：搜索由「查询或范围变化」触发（onQueryChange），
    // 回车在三种范围里**一律是步进**，不再有跨文档专用的搜索分支。
    const m = mount();
    m.bar.open();
    m.docs().click();
    expect(m.lastQuery()?.allDocs, "点击后进入查询对象").toBe(true);
    expect(m.docs().classList.contains("on"), "激活态高亮").toBe(true);
    expect(m.calls, "激活范围本身就要通知主程序重算").toContain("change");

    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    expect(m.calls, "改文本也要通知主程序重算").toContain("change");

    key(input, "Enter");
    expect(m.calls, "回车 = 下一个（与单文档同一套）").toContain("step:1");

    // 主程序搜完把 a/b 回灌到徽标上（a=当前文档序号，b=含结果文档数）
    m.bar.setDocIndex(1, 7);
    expect(m.badge().textContent).toBe("1/7");
    expect(m.badge().hidden).toBe(false);
  });

  it("跨文档空查询：回车同样只是步进，不再弹「请输入查找内容」", () => {
    // 与单文档/选区一致：空文本时回车仍是一次步进，有没有命中由主程序用计数区表达，
    // 不再由查找栏往底部状态行写提示（那条提示在另外两种范围里也没有）。
    const m = mount();
    m.bar.open();
    m.docs().click();
    key(m.q<HTMLElement>(".find-input"), "Enter");
    expect(m.calls).toContain("step:1");
    expect(m.q(".find-status").hidden, "不再写底部状态行提示").toBe(true);
  });

  it("关闭跨文档后徽标收起（a/b 不再有意义）", () => {
    const m = mount();
    m.bar.open();
    m.docs().click();
    m.bar.setDocIndex(1, 3);
    expect(m.badge().textContent).toBe("1/3");
    expect(m.badge().hidden).toBe(false);

    m.docs().click();
    expect(m.lastQuery()?.allDocs).toBe(false);
    expect(m.badge().hidden, "熄掉跨文档后徽标必须收起").toBe(true);
  });

  it("查询变更会作废上一次的跨文档 a/b，避免徽标挂着过期数字", () => {
    const m = mount();
    m.bar.open();
    m.docs().click();
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    m.bar.setDocIndex(2, 4);
    expect(m.badge().hidden).toBe(false);

    input.value = "todo2";
    input.dispatchEvent(new Event("input"));
    expect(m.badge().hidden, "查询一变，旧数字必须作废").toBe(true);
  });

  it("跨文档徽标显示 a/b：a=当前文档序号，b=含结果文档数", () => {
    const m = mount();
    m.bar.open();
    m.docs().click();
    m.bar.setDocIndex(1, 3);
    expect(m.badge().textContent).toBe("1/3");
    m.bar.setDocIndex(2, 5);
    expect(m.badge().textContent).toBe("2/5");
    expect(m.badge().hidden).toBe(false);
    m.bar.setDocIndex(0, 0);
    expect(m.badge().hidden, "b=0 时收起").toBe(true);
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

  it("图标开关（大小写/全词/正则/保留大小写）进入查询对象，选区开关在箭头之后", () => {
    const m = mount();
    m.bar.open();
    // 输入框内嵌开关 3 个 + 替换行 1 个；选区那个已挪出输入框（B78）
    expect(m.toggles(), "查找行 3 个 + 替换行 1 个").toHaveLength(4);
    m.tgl("区分大小写").click();
    m.tgl("正则").click();
    m.selBtn().click();
    m.tgl("保留大小写").click();
    expect(m.lastQuery()?.caseSensitive).toBe(true);
    expect(m.lastQuery()?.wholeWord).toBe(false);
    expect(m.lastQuery()?.regexp).toBe(true);
    expect(m.lastQuery()?.inSelection).toBe(true);
    expect(m.lastQuery()?.preserveCase).toBe(true);
    expect(m.selBtn().getAttribute("aria-pressed"), "选区开关也要用 aria-pressed").toBe("true");

    // 顺序：选区开关必须排在上下箭头之后（VS Code find-actions 的顺序）
    const order = [...m.dom.querySelectorAll<HTMLElement>(".find-row-main > *")].map((el) =>
      el.classList.contains("find-field")
        ? "field"
        : el.classList.contains("find-chevron")
          ? "chevron"
          : el.classList.contains("find-count")
            ? "count"
            : el.classList.contains("find-prev")
              ? "prev"
              : el.classList.contains("find-next")
                ? "next"
                : el.classList.contains("find-sel")
                  ? "sel"
                  : el.classList.contains("find-docs")
                    ? "docs"
                    : el.classList.contains("find-x")
                      ? "close"
                      : "?",
    );
    expect(order).toEqual(["chevron", "field", "count", "prev", "next", "sel", "docs", "close"]);
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

  it("计数区：空内容显示「无内容」且 prev/next 置灰；有命中点亮；无匹配置警示色", () => {
    const m = mount();
    m.bar.open();
    m.bar.setCount(""); // 模拟「没有搜索内容」
    expect(m.q(".find-count").textContent).toBe("无内容");
    expect(m.q<HTMLButtonElement>(".find-prev").disabled).toBe(true);
    expect(m.q<HTMLButtonElement>(".find-next").disabled).toBe(true);
    m.bar.setCount("3 / 12"); // 有命中
    expect(m.q(".find-count").textContent).toBe("3 / 12");
    expect(m.q<HTMLButtonElement>(".find-prev").disabled).toBe(false);
    expect(m.q<HTMLButtonElement>(".find-next").disabled).toBe(false);
    m.bar.setCount("无匹配"); // 无匹配仍置灰 + 警示色
    expect(m.q<HTMLButtonElement>(".find-prev").disabled).toBe(true);
    expect(m.q(".find-count").classList.contains("find-count-bad")).toBe(true);
  });

  it("B80：跨文档不再有底部结果区（对齐 VS Code 的查找浮层）", () => {
    const m = mount();
    m.bar.open();
    m.docs().click();
    expect(m.dom.querySelector(".find-results"), "结果区必须整个消失").toBeNull();
    expect(m.dom.querySelector(".find-empty")).toBeNull();
    expect(m.dom.querySelector(".find-hit")).toBeNull();
  });

  it("B80：文档图标徽标 = 跨文档 a/b（点亮且有条数时才显示）", () => {
    const m = mount();
    m.bar.open();
    expect(m.badge().hidden, "没搜过 → 收起").toBe(true);
    m.bar.setDocIndex(1, 12);
    expect(m.badge().hidden, "未点亮跨文档时徽标不显示").toBe(true);
    m.docs().click();
    expect(m.badge().textContent).toBe("1/12");
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

  it("熄灭跨文档时，a/b 与状态行文案一起收掉", () => {
    const m = mount();
    m.bar.open();
    m.docs().click(); // 点亮
    m.bar.setDocIndex(1, 5);
    m.bar.setStatus("共 5 处匹配，回车逐个跳转");
    m.docs().click(); // 熄灭
    expect(m.badge().hidden, "别留下过期的总数").toBe(true);
    expect(m.q<HTMLElement>(".find-status").hidden, "别留下过期文案").toBe(true);
  });

  it("懒建后立刻点亮文档图标，a/b 回灌时徽标必须出得来", () => {
    const m = mount();
    m.bar.open();
    // 关键：**不预先喂任何值**。查找栏是懒建的，主程序可能在它建出来之前/之后才算命中数，
    // 所以徽标数字必须自己存一份源真值（只写 DOM 的话「先搜出结果、再点亮图标」会渲染出空徽标）。
    m.docs().click();
    const b = m.badge();
    expect(b.hidden, "0 命中（b=0）不点亮徽标").toBe(true);
    m.bar.setDocIndex(3, 23); // 主程序随后回灌真实 a/b
    expect(b.textContent).toBe("3/23");
    expect(b.hidden).toBe(false);
  });
});

// B78：①左侧宽度手柄 ②替换行展开后折叠按钮变高 ③选区按钮移到箭头之后
//      ④选区与跨文档互斥 ⑤两行输入框同宽 ⑥图标改为 codicon（B80 接续）
describe("B78：左侧手柄 / 折叠按钮变高 / 选区与跨文档互斥 / 两框同宽", () => {
  /** jsdom 没有布局，需要宽度的地方只能打桩 */
  const rect = (w: number): DOMRect =>
    ({
      width: w,
      height: 25,
      top: 0,
      left: 0,
      right: w,
      bottom: 25,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  it("左侧有宽度调节手柄", () => {
    const m = mount();
    m.bar.open();
    const sash = m.sash();
    expect(sash, "必须有手柄").toBeTruthy();
    expect(m.dom.firstElementChild, "手柄贴浮层左缘（与 chevron 一样绝对定位在 left:0）").toBe(
      sash,
    );
    expect(sash.getAttribute("aria-label"), "手柄要有可读名字").toBeTruthy();
  });

  it("拖手柄改宽度：浮层钉在右上，所以往左拖 = 变宽", () => {
    const m = mount();
    m.bar.open();
    const dom = m.dom;
    dom.getBoundingClientRect = () => rect(parseFloat(dom.style.width) || 470);
    m.sash().dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 100 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 60 }));
    // 470 + (100 - 60) = 510：往左拖 40px 就宽 40px
    expect(dom.style.width).toBe("510px");
    window.dispatchEvent(new MouseEvent("pointerup", {}));

    // 松手后再动鼠标不该还跟着改宽度（监听器必须解绑）
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20 }));
    expect(dom.style.width, "松手后必须解绑").toBe("510px");
  });

  it("双击手柄在「默认宽度 ↔ 可用最大宽度」间切换（同 VS Code onDidReset）", () => {
    const m = mount();
    m.bar.open();
    const dom = m.dom;
    dom.getBoundingClientRect = () => rect(parseFloat(dom.style.width) || 470);
    // 没调过宽度 → 双击放大到可用宽度（jsdom 的 innerWidth = 1024，减两侧 16）
    m.sash().dispatchEvent(new MouseEvent("dblclick", {}));
    expect(dom.style.width).toBe(`${window.innerWidth - 32}px`);
    // 再双击 → 复原到默认 470
    m.sash().dispatchEvent(new MouseEvent("dblclick", {}));
    expect(dom.style.width).toBe("470px");
  });

  it("替换行展开后浮层带 replace-toggled（CSS 据此把折叠按钮拉成两行高）", () => {
    const m = mount();
    m.bar.open();
    expect(m.dom.classList.contains("replace-toggled"), "折叠态不带").toBe(false);
    m.chevron().click();
    expect(m.dom.classList.contains("replace-toggled"), "展开态必须带").toBe(true);
    m.chevron().click();
    expect(m.dom.classList.contains("replace-toggled")).toBe(false);
  });

  it("选区查找与所有文档查找互斥：同一时间只能选一个", () => {
    const m = mount();
    m.bar.open();
    m.docs().click();
    expect(m.lastQuery()?.allDocs).toBe(true);
    // 点亮选区 → 熄掉跨文档
    m.selBtn().click();
    expect(m.lastQuery()?.inSelection).toBe(true);
    expect(m.lastQuery()?.allDocs, "点亮选区必须熄掉跨文档").toBe(false);
    expect(m.docs().classList.contains("on")).toBe(false);
    // 反过来：点亮跨文档 → 熄掉选区
    m.docs().click();
    expect(m.lastQuery()?.allDocs).toBe(true);
    expect(m.lastQuery()?.inSelection, "点亮跨文档必须熄掉选区").toBe(false);
    expect(m.selBtn().classList.contains("on")).toBe(false);
    expect(m.selBtn().getAttribute("aria-pressed")).toBe("false");
  });

  it("输入框内容清空后，跨文档总数一并归零", () => {
    const m = mount();
    m.bar.open();
    m.docs().click();
    const input = m.q<HTMLInputElement>(".find-input");
    input.value = "todo";
    input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    m.bar.setDocIndex(1, 1);
    expect(m.badge().textContent).toBe("1/1");
    expect(m.badge().hidden).toBe(false);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(m.badge().hidden, "清空输入后旧总数必须归零").toBe(true);
  });

  it("替换输入框与查找输入框同宽（JS 量出查找框宽度后写死）", () => {
    const m = mount();
    m.bar.open();
    const findField = m.q<HTMLElement>(".find-row-main .find-field");
    const replField = m.q<HTMLElement>(".find-row-replace .find-field");
    // jsdom 没有布局：量出来是 0 时不能写死 0px
    expect(replField.style.width, "无布局时不下手").toBe("");
    findField.getBoundingClientRect = () => rect(260);
    m.chevron().click();
    expect(replField.style.width).toBe("260px");
  });

  it("图标全部照搬 VS Code 的 codicon（不再自绘、也不用 Aa/ab/.*/AB 文字字形）", () => {
    const m = mount();
    m.bar.open("", true);
    // 与官方包逐字一致（codicons.ts 由 scripts/fetch-codicons.mjs 从 @vscode/codicons 抽取）
    // ⚠️ 不能直接比字符串：DOM 会把 svg 里的自闭合 `<path … />` 规整成 `<path …></path>`，
    //    所以先把官方串按同一规则归一，再逐字节比 —— 这样仍能证明「与官方轮廓逐字一致」。
    const norm = (s: string): string => s.replace(/<(\w+)([^>]*)\/>/g, "<$1$2></$1>");
    const same = (el: Element, svg: string, msg: string): void => {
      expect(el.innerHTML, msg).toBe(norm(svg));
    };
    same(m.q(".find-prev"), CODICONS.arrowUp, "上一个 = arrow-up");
    same(m.q(".find-next"), CODICONS.arrowDown, "下一个 = arrow-down");
    same(m.q(".find-sel"), CODICONS.findSelection, "在选区中查找 = find-selection");
    same(m.q(".find-x"), CODICONS.close, "关闭 = close");
    same(m.q(".find-replace-one"), CODICONS.replace, "替换 = replace");
    same(m.q(".find-replace-all"), CODICONS.replaceAll, "全部替换 = replace-all");
    same(m.tgl("区分大小写"), CODICONS.caseSensitive, "区分大小写");
    same(m.tgl("全词匹配"), CODICONS.wholeWord, "全词匹配");
    same(m.tgl("正则"), CODICONS.regex, "正则");
    same(m.tgl("保留大小写"), CODICONS.preserveCase, "保留大小写");
    // 文档图标按钮里还挂着徽标（<i class="find-badge">），故用 toContain
    expect(m.q<HTMLElement>(".find-docs").innerHTML, "文档图标 = files").toContain(
      norm(CODICONS.files),
    );

    // 每个图标按钮/开关都必须渲染出 svg，且不含任何文字字形
    const iconEls = [
      ...m.dom.querySelectorAll<HTMLElement>(
        ".find-chevron, .find-nav, .find-x, .find-replace-one, .find-replace-all, .find-toggle, .find-docs",
      ),
    ];
    expect(iconEls.length).toBeGreaterThan(10);
    for (const el of iconEls) {
      expect(el.querySelector("svg"), `${el.className} 必须是 svg 图标`).toBeTruthy();
      // 徽标是挂在文档图标里的数字，不算「文字字形」，先摘掉再判
      el.querySelector(".find-badge")?.remove();
      expect(el.textContent?.trim(), `${el.className} 不得再有文字字形`).toBe("");
    }
    // 16×16 视图框 + currentColor：落到 16px 图标位零缩放，颜色随主题
    expect(CODICONS.replace).toContain('viewBox="0 0 16 16"');
    expect(CODICONS.replaceAll).toContain('fill="currentColor"');
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
