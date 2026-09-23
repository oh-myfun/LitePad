// @vitest-environment jsdom
// 悬浮查找/替换栏行为测试（方案 C：对齐 VS Code 的紧凑浮层）。
// 契约：①一个悬浮栏统一查找/替换/跨文档查找；②不绑定文件/面板——切换标签、分屏都不自动关闭；
// ③跨文档收敛成一个文档图标（B80：右上角徽标 = 跨文档 a/b，不再有结果列表）；
// ④钉在右上角、不再可拖动；⑤替换行可折叠；⑥匹配选项是图标开关（B80 起全部照搬 codicon）；
// ⑦紧凑计数、无匹配变红。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { themeBlock, ruleBlock, stripCssComments } from "./static";
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
    // 字形来自官方 npm 包 @vscode/codicons 的图标字体（B102）：`CODICONS.x` 就是
    // `<i class="codicon codicon-x">`，直接比 innerHTML 即能证明「没写死、没自绘」。
    const same = (el: Element, html: string, msg: string): void => {
      expect(el.innerHTML, msg).toBe(html);
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
    expect(m.q<HTMLElement>(".find-docs").innerHTML, "文档图标 = files").toContain(CODICONS.files);

    // 每个图标按钮/开关都必须渲染出 codicon 字形元素，且不含任何文字字形
    const iconEls = [
      ...m.dom.querySelectorAll<HTMLElement>(
        ".find-chevron, .find-nav, .find-x, .find-replace-one, .find-replace-all, .find-toggle, .find-docs",
      ),
    ];
    expect(iconEls.length).toBeGreaterThan(10);
    for (const el of iconEls) {
      // ⚠️ 徽标本身也是 <i>，但它不带 codicon 类 —— 用 `.codicon` 选才不会误判
      expect(
        el.querySelector("i.codicon"),
        `${el.className} 必须是 codicon 字形（<i class="codicon …">）`,
      ).toBeTruthy();
      // 徽标是挂在文档图标里的数字，不算「文字字形」，先摘掉再判
      el.querySelector(".find-badge")?.remove();
      expect(el.textContent?.trim(), `${el.className} 不得再有文字字形`).toBe("");
    }
    // 颜色随主题：字形的 ::before 继承 color，所以本体不能自带颜色
    for (const name of ["replace", "replaceAll", "close"] as const) {
      expect(CODICONS[name], `${name} 必须是 codicon 字形元素`).toMatch(
        /^<i class="codicon codicon-[a-z0-9-]+" aria-hidden="true"><\/i>$/,
      );
    }
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

describe("查找栏静态契约（从 regressions 拆出）", () => {
  it("悬浮查找栏必须挂在应用根、且不随标签/面板切换关闭（用户要求）", () => {
    // 用户要求：查找/替换用一个悬浮栏，不绑定文件/面板——切换文件/面板不自动消失。
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须挂到 #app（应用级浮层），不能挂在面板里").toContain('createFindBar(el("app")');
    // 切换标签（switchTab）与切换活动面板都要重新把查询应用到新视图，而不是关闭浮层
    expect(src, "切换标签后必须重新定位查找查询").toContain("retargetFindBar()");
    const switchBody = src.match(/function switchTab\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(switchBody, "switchTab 末尾必须调 retargetFindBar").toContain("retargetFindBar()");
    const barSrc = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(barSrc, "查找栏不得自行监听标签切换而关闭").not.toContain("switchTab");
    expect(barSrc, "关闭只应由 close/Esc/× 触发").toContain("function close(): void");
  });
  it("B30 查找栏必须可关闭（[hidden] 不得被 display:flex 覆盖）且预览态接线齐全", () => {
    // 用户报告：查找/替换悬浮条无法关闭。
    // 根因：.find-bar { display: flex } 覆盖了 hidden 属性的 UA 样式（display:none），
    // close() 置 dom.hidden=true 后浮层仍然可见。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const hiddenRule = css.match(/\.find-bar\[hidden\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hiddenRule, "必须有 .find-bar[hidden] { display: none } 规则").toContain(
      "display: none",
    );
    expect(css, "查找行应有 flex 行布局（.find-row）").toMatch(
      /\.find-row\s*\{[^}]*display:\s*flex/,
    );

    // 预览态查找接线：高亮应用、重放、步进、清除
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "applyFindQuery 必须同步预览高亮").toContain("applyPreviewFindEverywhere(q)");
    // 重放必须发生在 renderMarkdownFor **函数体内**。
    // 早期这里按「renderMarkdownFor 后 600 字符内」匹配，M4 给该函数加了
    // 大文件降级分支后距离超限就误报——按函数体截取才稳。
    const rmStart = main.indexOf("function renderMarkdownFor");
    expect(rmStart, "应能定位 renderMarkdownFor").toBeGreaterThan(-1);
    const rmBody = main.slice(rmStart, main.indexOf("\nfunction ", rmStart + 10));
    expect(rmBody, "重渲染后必须重放预览高亮").toContain(
      "applyPreviewFindToPanel(panel, findSpecOf(findBar.getQuery()))",
    );
    expect(main, "clearFindHighlight 必须同时清预览高亮").toMatch(
      /clearFindHighlight[\s\S]{0,200}?applyFind\(null\)/,
    );
    expect(main, "stepFind 必须有预览分支（在预览高亮里步进）").toMatch(
      /stepFind[\s\S]{0,400}?viewMode === "preview" && panel\.preview/,
    );
    const preview = readFileSync("src/markdown/preview.ts", "utf-8");
    expect(preview, "PreviewPane 必须提供 applyFind/stepFind/findState").toMatch(
      /applyFind\(|stepFind\(|findState\(/,
    );
    expect(preview, "预览命中必须复用编辑器高亮样式类").toContain("cm-find-match");
  });
  it("B39/B40 查找范围：不得有范围下拉与文件夹搜索，跨文档收敛为文档图标（方案 C）", () => {
    // 用户要求：查找替换悬浮栏无需查找文件夹功能，也不用下拉菜单选择查找范围——
    // 但「所有打开的文档」这个能力要保留。B73（方案 C）把它从勾选框收敛成
    // 带打开文档数徽标的文档图标按钮（对齐 VS Code），能力不变、只是换了形态。
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(bar, "查询对象不得再有 scope").not.toMatch(/\bscope\b/);
    expect(bar, "不得再有范围下拉控件").not.toContain("find-scope");
    expect(bar, "查找栏内不得出现任何 select 下拉").not.toContain('createElement("select")');
    expect(bar, "不得再有文件夹搜索控件").not.toContain("find-folder");
    expect(bar, "跨文档能力必须保留（方案 C：文档图标按钮）").toContain("find-docs");
    expect(bar, "文档图标必须带徽标（B80：跨文档命中的总匹配数）").toContain("find-badge");
    expect(bar, "勾选态必须进入查询对象").toContain("allDocs");

    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "不得再调用读盘的跨文件搜索 IPC").not.toContain("searchFiles");
    expect(main, "不得再有默认搜索目录推导").not.toContain("defaultSearchDir");
    expect(main, "不得再有 Ctrl+Shift+F 入口").not.toContain("Ctrl+Shift+F");
    expect(main, "跨文档查找必须只扫内存快照").toContain("function searchOpenDocs(");
    expect(main, "整行替换必须支持勾选后的跨文档分支").toContain("if (!q.allDocs) {");

    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "读盘搜索的 IPC 包装必须删除").not.toContain("search_files");

    const rust = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    expect(rust, "Rust 搜索命令必须删除").not.toContain("pub async fn search_files");
    expect(rust, "递归收集文件的辅助函数必须删除").not.toContain("fn collect_files");
    const rustMain = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(rustMain, "不得再注册 search_files 命令").not.toContain("commands::search_files");
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf-8");
    expect(cargo, "regex 依赖只服务于读盘搜索，应一并移除").not.toMatch(/^regex\s*=/m);
  });
  it("B73 查找栏方案 C：钉右上角（不可拖动）+ 图标开关 + 折叠替换行 + 紧凑计数", () => {
    // 用户从 A/B/C 三套预览方案里选了 C：对齐 VS Code 的紧凑浮层。
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    // 去掉标题栏与拖动（方案 C 不再记忆/恢复位置）
    expect(bar, "不得再有可拖动的标题栏").not.toContain("find-bar-title");
    expect(bar, "不得再有位置持久化键").not.toContain("POS_KEY");
    expect(bar, "不得再挂布局拖拽类").not.toContain("layout-dragging");
    // 图标开关 + 折叠替换行 + 文档图标（`"find-toggle"` 带引号：容器叫 find-toggles，不能误命中）
    expect(bar, "匹配选项必须是图标开关").toContain('"find-toggle"');
    expect(bar, "替换行必须可折叠").toContain("find-row-replace");
    expect(bar, "chevron 控制替换行展开").toContain("find-chevron");
    // 查询对象要带新增两个开关
    expect(bar, "查询对象必须有 inSelection").toContain("inSelection");
    expect(bar, "查询对象必须有 preserveCase").toContain("preserveCase");

    const css = readFileSync("src/styles/global.css", "utf-8");
    const barBlock = css.match(/\.find-bar\s*\{[^}]*\}/)?.[0] ?? "";
    expect(barBlock, "浮层必须钉在右侧").toMatch(/right:\s*\d+px/);
    expect(barBlock, "浮层不得再用 left 定位").not.toMatch(/(^|[^-])left:\s*\d+px/);
    expect(css, "标题栏的 move 光标必须移除").not.toContain("cursor: move");
    expect(css, "无匹配变红的样式必须存在").toContain(".find-count-bad");
    expect(css, "图标开关激活态必须高亮").toMatch(/\.find-toggle\.on\s*\{/);
    expect(css, "文档图标徽标必须存在").toContain(".find-badge");
    // ⚠️ .find-row 是 display:flex，会盖掉 hidden 的 UA 样式 —— 折叠态必须显式 none
    expect(css, "折叠的替换行必须显式 display:none").toMatch(
      /\.find-row-replace\[hidden\]\s*\{[^}]*display:\s*none/,
    );

    const findKernel = readFileSync("src/editor/find.ts", "utf-8");
    expect(findKernel, "选区限制必须是可测的纯函数").toContain("export function restrictToRange");
    expect(findKernel, "保留大小写必须是可测的纯函数").toContain("export function preserveCase");

    // 计数改紧凑写法：不得再出现「第 N/M 处」这种冗长文案
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "计数必须用紧凑的 N / M").toMatch(
      /bar\.setCount\(`\$\{idx \+ 1\} \/ \$\{matches\.length\}`\)/,
    );
    expect(main, "不得再用旧的「第 N/M 处」查找计数").not.toContain("第 ${idx + 1}/");
    expect(main, "预览态也不得用「第 … 处」查找计数").not.toContain("第 ${st.active + 1}/");
    expect(main, "在选区中查找必须把命中限定在选区").toContain("restrictMatches");
    expect(main, "替换必须支持保留大小写（接线到替换当前）").toContain(
      "applyPreserveCase(matched, q.replace)",
    );
  });
  it("B76 查找栏三处报障：状态行不占位 / 徽标必有数字 / 选区锚点必须冻结", () => {
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    const css = readFileSync("src/styles/global.css", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");

    // ---- ① 浮层底部那条空白：状态行空文本时必须收起 ----
    // 用户实测：主行下面吊着一条空白。根因是 .find-status 一直挂着 min-height，
    // 而正常打开查找栏时主程序**从不调 setStatus**，空盒子就一直占着位置。
    expect(bar, "状态行创建后就必须先收起").toMatch(/status\.hidden = true/);
    expect(bar, "状态行必须有「空文本即收起」的派生逻辑").toMatch(/status\.hidden = !text/);
    expect(bar, "熄灭跨文档要连 a/b 一起清掉（别留下过期文案）").toMatch(
      /docA = 0;\s*\n\s*docB = 0;/,
    );

    // ---- ② 文档图标上的数字显示不出来：徽标数字必须自己存一份源真值 ----
    // 查找栏是懒建的，主程序要等搜完才知道总数；只把数字写进 DOM 的话，
    // 「先搜出结果、再点亮图标」会渲染出一个空徽标。
    // ⚠️ B80 起语义变了：徽标 = 跨文档命中的 **a/b**（a=当前文档序号，b=含结果文档数），
    //    所以源真值叫 docA/docB，由主程序用 setDocIndex 回灌。
    expect(bar, "徽标数字要自己存一份源真值").toMatch(/let docA = 0/);
    const syncBadgeBody = bar.match(/function syncBadge\(\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(syncBadgeBody, "渲染时必须用记着的那份源真值").toMatch(
      /badge\.textContent = badgeText\(\)/,
    );
    expect(bar, "徽标渲染成 a/b（a=当前文档序号，b=含结果文档数）").toMatch(
      /docB > 0 \? `\$\{docA\}\/\$\{docB\}` : ""/,
    );
    expect(bar, "⚠️ 徽标不得再依赖 setDocCount（B78 旧语义已废弃）").not.toContain("setDocCount");
    expect(bar, "徽标数字只能由主程序回灌").toMatch(/setDocIndex: \(a, b\) => \{/);
    const badgeBlock = css.match(/\.find-badge\s*\{[^}]*\}/)?.[0] ?? "";
    expect(badgeBlock, "徽标必须收在按钮盒内，不得用负偏移溢出").not.toMatch(/\b(top|right):\s*-/);
    expect(badgeBlock, "徽标只是标注，不得抢按钮的点击").toContain("pointer-events: none");

    // ---- ③ 选区锚点必须冻结（点「下一个」后计数塌缩成 1 条）----
    // 根因：restrictMatches 每次实时读活动选区，而 stepFind 会把选区换成**命中本身**，
    // 于是第二次步进的范围就只剩这一个命中。
    // 最有效的一条判据：活动选区**只允许被读一次**（在播种锚点处）。
    const withoutDecl = main.replace(/function activeSelectionRange\(\)[^{]*\{[\s\S]*?\n\}/, "");
    const liveReads = [...withoutDecl.matchAll(/activeSelectionRange\(\)/g)];
    expect(liveReads, "activeSelectionRange 只允许在播种锚点时读一次").toHaveLength(1);
    const seedBody =
      main.match(/function seedFindSelectionAnchor\(\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(seedBody, "那唯一一次读取必须在 seedFindSelectionAnchor 里").toContain(
      "activeSelectionRange()",
    );
    expect(main, "判断范围一律读冻结锚点").toContain("currentFindRestrict(q)");
    expect(main, "不得再出现「实时取选区当范围」的写法").not.toMatch(
      /restrict:\s*q\.inSelection \? activeSelectionRange\(\)/,
    );
    expect(main, "锚点只在开关「刚被打开」时播种").toMatch(
      /if \(q\.inSelection !== findSelectionOn\)/,
    );
    expect(main, "重开查找栏时重播种").toMatch(
      /if \(findSelectionOn\) seedFindSelectionAnchor\(\)/,
    );
    expect(main, "换文档时重播种（旧偏移量无意义）").toMatch(
      /findSelectionAnchor\?\.docId !== activeTabIdOf\(\)\) seedFindSelectionAnchor\(\)/,
    );
    expect(main, "F3 那条 retarget 必须走同一处判断").toMatch(/else retargetFindBar\(\);/);
  });
  it("B77 查找栏外观对齐 VS Code：盒模型折算 / 扁平按钮 / 两档悬停 / 虚焦环", () => {
    // 用户要求「参考 VS Code 优化搜索悬浮框」。已按 docs/vscode-reference 里的
    // findWidget.css / findInput.css / toggle.css / inputBox.css 逐条对齐，
    // 拿不到出处的地方（跨文档文档图标、min-width 防抖）都在 CSS 注释里注明了。
    const css = readFileSync("src/styles/global.css", "utf-8");
    // 官方图标字体样式（B102）：图标的 16px 出自这里，不在本项目里另写一遍。
    const codiconCss = readFileSync("node_modules/@vscode/codicons/dist/codicon.css", "utf-8");

    // ---- ① 浮层盒模型 = `.find-widget`（34px 高由 JS 写死，我们改由内边距自然量到）----
    const bar = ruleBlock(css, ".find-bar");
    expect(bar, "圆角 = cornerRadius-large（8px）").toMatch(/border-radius:\s*8px/);
    expect(bar, "投影必须共用 --shadow-lg（= VS Code --vscode-shadow-lg）").toContain(
      "box-shadow: var(--shadow-lg)",
    );
    expect(bar, "内边距左右必须是 9 / 4（VS Code `0 4px 0 9px`）").toMatch(
      /padding:\s*[\d.]+px\s+4px\s+[\d.]+px\s+9px/,
    );
    expect(bar, "浮层必须是定位基准（chevron 与关闭按钮都绝对定位在里面）").toMatch(
      /position:\s*(fixed|absolute)/,
    );

    // ---- ② 行盒模型 = `.find-part { margin: 3px 25px 0 17px }` ----
    // 左 17 给绝对定位的 chevron，右 25 给绝对定位的关闭按钮；两行共用同一组边距，
    // 于是主行与替换行的输入框左右边缘天然对齐。
    const row = ruleBlock(css, ".find-row");
    expect(row, "行要留出左右两条沟槽（25 / 17）").toMatch(/margin:\s*0\s+25px\s+0\s+17px/);
    expect(row, "行高 25px（= `.find-part .find-actions`）").toMatch(/height:\s*25px/);

    // ---- ③ 输入区：填充式无描边 + 聚焦向内 outline ----
    const field = ruleBlock(css, ".find-field");
    expect(field, "必须无描边（VS Code input.border 深浅两档都是 null）").toMatch(/border:\s*none/);
    expect(field, "底色必须走令牌，不得写死").toContain("background: var(--find-field-bg)");
    expect(field, "最小高度 25px（= `.monaco-inputbox`）").toMatch(/min-height:\s*25px/);
    const fieldFocus = ruleBlock(css, ".find-field:focus-within");
    expect(fieldFocus, "聚焦走 `.synthetic-focus` 的 outline").toMatch(/outline:\s*1px solid/);
    expect(fieldFocus, "⚠️ 必须 outline-offset:-1px，否则聚焦时整行抖 1px").toMatch(
      /outline-offset:\s*-1px/,
    );

    // ---- ④ 输入框内开关 = toggle.css（那份**自己声明了 border-box**，故不用折算）----
    const toggle = ruleBlock(css, ".find-toggle");
    expect(toggle, "开关宽 20px").toMatch(/width:\s*20px/);
    expect(toggle, "开关高 20px").toMatch(/height:\s*20px/);
    expect(toggle, "开关圆角 3px").toMatch(/border-radius:\s*3px/);
    expect(toggle, "⚠️ 常态边框必须是 transparent 的 1px（只占位不上色 → 激活时才不位移）").toMatch(
      /border:\s*1px solid transparent/,
    );
    expect(toggle, "内边距 1px").toMatch(/padding:\s*1px/);
    expect(toggle, "必须显式 border-box（toggle.css 原文如此）").toMatch(
      /box-sizing:\s*border-box/,
    );
    expect(toggle, "左间距 2px").toMatch(/margin-left:\s*2px/);
    // 图标尺寸不再由本项目按 svg 归：官方 codicon.css 统一给 `font: 16px/1 codicon`，
    // 字形元素继承它（B102 之前那条 `.find-toggle svg { width/height: 16px }` 已退役）。
    expect(css, "开关不得再有 svg 尺寸规则").not.toMatch(/\.find-toggle\s+svg/);
    expect(codiconCss, "16px 由官方 codicon.css 给（不是本项目猜的）").toMatch(
      /\.codicon\[class\*='codicon-'\][^{]*\{[^}]*16px\/1 codicon/,
    );

    // 激活三态 = inputOption.active{Background,Border,Foreground} 三件套一起换
    const toggleOn = ruleBlock(css, ".find-toggle.on");
    expect(toggleOn, "激活底色 = inputOption.activeBackground").toContain("var(--find-opt-active)");
    expect(toggleOn, "激活边框 = inputOption.activeBorder").toContain(
      "var(--find-opt-active-border)",
    );
    expect(toggleOn, "激活字色 = inputOption.activeForeground").toContain(
      "var(--find-opt-active-fg)",
    );

    // ---- ⑤ 工具按钮：**22px 外框**（本项目全局 border-box，必须折算）----
    // ⚠️ 本节最容易被「照着 VS Code 抄」抄错的一处：VS Code 无全局 box-sizing，
    // 它的 `.button { width:16px; padding:3px }` 是 content-box → 外框 22px。
    // 我们全局是 border-box，照抄会得到 16px 外框 + 10px 内容盒，16px 图标直接溢出去。
    const btn = ruleBlock(css, ".find-nav");
    expect(btn, "外框必须写 22px（22 − 3×2 = 16 内容盒）").toMatch(/width:\s*22px/);
    expect(btn, "高度同样 22px").toMatch(/height:\s*22px/);
    expect(btn, "⚠️ 不得直接抄 16px：全局 border-box 下图标会溢出、悬停底色缩水").not.toMatch(
      /width:\s*16px/,
    );
    expect(btn, "内边距 3px").toMatch(/padding:\s*3px/);
    expect(btn, "圆角 5px（= VS Code `.button`）").toMatch(/border-radius:\s*5px/);
    expect(btn, "平常无底色（扁平式，不像工具栏按钮那样自带填充）").toMatch(/background:\s*none/);
    expect(btn, "平常无描边").toMatch(/border:\s*none/);
    // 图标 16px 同上：由官方 codicon.css 给。本项目只在**要改字号**的地方写规则，
    // 且只能改 .codicon 的 font-size（见 .panel-op .codicon = 15px）。
    expect(css, "按钮不得再有 svg 尺寸规则").not.toMatch(/\.find-nav\s+svg/);
    expect(css, "要改尺寸就改 .codicon 的字号").toMatch(
      /\.panel-op\s+\.codicon\s*\{[^}]*font-size:\s*15px/,
    );
    expect(css, "禁用态必须弱化而不是消失").toMatch(
      /\.find-nav:disabled,[\s\S]{0,200}?opacity:\s*0?\.\d+/,
    );

    // 关闭按钮 = `.button.codicon-widget-close { position:absolute; top:5px; right:4px }`
    // ⚠️ `.find-x` 先出现在上面那组扁平按钮列表里，这里要的是它自己的定位规则 → 按内容选。
    const close = ruleBlock(css, ".find-x", "position");
    expect(close, "关闭按钮必须脱离行流钉在浮层右上").toMatch(/position:\s*absolute/);
    expect(close, "上边距 5px（VS Code 同款）").toMatch(/top:\s*5px/);
    expect(close, "右边距 4px（VS Code 同款）").toMatch(/right:\s*4px/);

    // chevron = `.button.toggle { position:absolute; top:3px; left:4px; width:18px }`
    // ⚠️ left 让出最左 4px 给宽度手柄（.find-sash 占 left:0~4px），否则两者重叠（用户实测）。
    const chev = ruleBlock(css, ".find-chevron");
    expect(chev, "chevron 必须绝对定位在最左").toMatch(/position:\s*absolute/);
    expect(chev, "宽 18px（VS Code 同款）").toMatch(/width:\s*18px/);
    expect(chev, "让出最左 4px 给宽度手柄（left: 4px，不再与折叠按钮重叠）").toMatch(/left:\s*4px/);

    // ---- ⑥ 计数 = `.matchesCount` ----
    const count = ruleBlock(css, ".find-count");
    expect(count, "高 25px").toMatch(/height:\s*25px/);
    expect(count, "行高 23px").toMatch(/line-height:\s*23px/);
    expect(count, "内边距 2px 0 0 2px").toMatch(/padding:\s*2px\s+0\s+0\s+2px/);
    expect(count, "左边距 3px").toMatch(/margin-left:\s*3px/);
    expect(count, "居中").toMatch(/text-align:\s*center/);
    // 有意偏离：VS Code 用 JS 逐次测量写死宽度，我们固定 min-width 防抖（数字位数变化时
    // 右边那排按钮不会左右横跳），已在此与 CSS 注释里记录。
    expect(count, "固定 min-width 以防抖（有意偏离，已在注释说明）").toMatch(/min-width:\s*\d+px/);
    // 计数区必须常驻占位（用户第 4 点：无内容时显示「无内容」、不隐藏），
    // 故已删除 `.find-count:empty { min-width:0 }` 折叠规则。这里反向断言：
    // 全局 CSS 里**不得再存在**该折叠规则（否则空计数会被收起、与需求冲突）。
    expect(css, "空计数也必须占位（不得再有 :empty 折叠规则，始终显示无内容）").not.toMatch(
      /\.find-count:empty\s*\{/,
    );
    // 无匹配的红 = errorForeground；⚠️ 原先写成 `var(--error, #e5534b)`，
    // 而项目根本没有 --error 令牌 → 一直吃硬编码 fallback、不随主题走。
    const bad = ruleBlock(css, ".find-count-bad");
    expect(bad, "无匹配必须走 --danger 令牌").toContain("var(--danger)");
    expect(bad, "不得再引用不存在的 --error").not.toContain("--error");

    // ---- ⑦ 两档悬停色必须**各就各位**（VS Code 给的是两个不同的值）----
    // toolbar.hoverBackground @0x50 给工具栏按钮，inputOption.hoverBackground @0x80 给输入框内开关。
    // 抄成同一个值 = 「划过输入框开关比划过按钮亮一档」的层级感丢失。
    expect(css, "工具按钮悬停必须用 --find-btn-hover").toMatch(
      /\.find-nav:hover:not\(:disabled\),[\s\S]{0,300}?\{\s*background:\s*var\(--find-btn-hover\)/,
    );
    expect(ruleBlock(css, ".find-toggle:hover"), "开关悬停必须用 --find-opt-hover").toContain(
      "var(--find-opt-hover)",
    );
    expect(
      ruleBlock(css, ".find-docs:hover"),
      "文档图标属开关，也必须用 --find-opt-hover",
    ).toContain("var(--find-opt-hover)");

    // ---- ⑧ 焦点环必须是**虚线边框**而不是 outline ----
    // outline 画在边框外面 → 开关会视觉上胀 1px，一排开关在焦点移动时互相推挤。
    expect(css, "开关/文档图标的焦点环必须是虚线边框").toMatch(
      /\.find-toggle:focus-visible,\s*\n\s*\.find-docs:focus-visible\s*\{[^}]*border-style:\s*dashed/,
    );
    expect(css, "⚠️ 不得用 outline 画开关焦点环（会胀 1px）").not.toMatch(/outline:\s*1px dashed/);

    // ---- ⑨ 令牌：两套主题都要齐，且取值 = VS Code ----
    const dark = themeBlock(css, "dark");
    const light = themeBlock(css, "light");
    expect(dark, "深色 inputOption.hoverBackground = #5a5d5e80").toContain(
      "--find-opt-hover: #5a5d5e80",
    );
    expect(dark, "深色 toolbar.hoverBackground = #5a5d5e50").toContain(
      "--find-btn-hover: #5a5d5e50",
    );
    expect(light, "浅色两档在 VS Code 里**就是同一个值** #b8b8b850").toContain(
      "--find-opt-hover: #b8b8b850",
    );
    expect(light, "浅色 toolbar 档同为 #b8b8b850").toContain("--find-btn-hover: #b8b8b850");
    expect(dark, "activeForeground 深色档 = 白").toContain("--find-opt-active-fg: #ffffff");
    expect(light, "activeForeground 浅色档 = 黑（白字压浅蓝底读不出来）").toContain(
      "--find-opt-active-fg: #000000",
    );
    for (const [name, block] of [
      ["深色", dark],
      ["浅色", light],
    ] as const) {
      for (const v of [
        "--find-field-bg:",
        "--find-btn-hover:",
        "--find-opt-hover:",
        "--find-opt-active:",
        "--find-opt-active-border:",
        "--find-opt-active-fg:",
        "--find-sash:",
        "--find-sash-hover:",
        "--shadow-lg:",
      ]) {
        expect(block, `${name}主题缺 ${v}`).toContain(v);
      }
      expect(block, `${name}主题的激活边框必须走 accent`).toContain(
        "--find-opt-active-border: var(--accent)",
      );
    }
    // 投影只此一条，tooltip 与查找栏共用（VS Code 也是同一个 --vscode-shadow-lg）
    expect(css, "投影值 = VS Code style.css 的 --vscode-shadow-lg").toContain(
      "--shadow-lg: 0 0 12px rgba(0, 0, 0, 0.14)",
    );
    expect(css, "tooltip 与查找栏必须共用同一条投影").toMatch(/--tip-shadow:\s*var\(--shadow-lg\)/);

    // ---- ⑩ 状态行的收起必须有显式 [hidden] 兜底 ----
    // 与 .find-bar[hidden] 同理：一旦有人给 .find-status 加上 display，
    // UA 的 `[hidden] { display: none }` 就会被覆盖 → B76 那条底部空白复活。
    expect(css, "状态行必须有显式 [hidden] 收起").toMatch(
      /\.find-status\[hidden\]\s*\{[^}]*display:\s*none/,
    );
  });
  it("B78 查找栏七处观感：宽度手柄 / 折叠按钮变高 / 选区按钮移位 / 两个范围互斥 / 结果区常驻 / 两框同宽 / 替换图标", () => {
    // 用户反馈的七条：①左侧有宽度调节手柄 ②替换区展开后折叠按钮变高
    // ③选区查找按钮在上下箭头之后 ④选区查找与所有文档查找互斥
    // ⑤结果区始终保留空位（输入为空也显示无结果）⑥查找与替换输入框同宽 ⑦替换图标改进
    const css = readFileSync("src/styles/global.css", "utf-8");
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");

    // ---- ① 左侧宽度手柄 = VS Code `.find-widget .monaco-sash`（sash.css 的 vertical 变体）----
    const sash = ruleBlock(css, ".find-sash");
    expect(sash, "手柄必须存在").not.toBe("");
    expect(sash, "必须绝对定位在浮层最左缘（findWidget.css 的 `left: 0 !important`）").toMatch(
      /position:\s*absolute/,
    );
    expect(sash, "必须贴左缘 left: 0").toMatch(/left:\s*0/);
    expect(sash, "宽 4px（= --vscode-sash-size）").toMatch(/width:\s*4px/);
    expect(sash, "高度铺满").toMatch(/height:\s*100%/);
    expect(sash, "光标必须是左右拉伸").toMatch(/cursor:\s*ew-resize/);
    expect(sash, "触屏要接管手势，否则会被页面滚动抢走").toMatch(/touch-action:\s*none/);
    // 高亮线画在 ::before 上：本体保持透明，只有悬停/拖拽时才显形（sash.css 的 .hover/.active）
    expect(css, "手柄的高亮必须走 ::before").toMatch(/\.find-sash::before/);
    expect(css, "悬停与拖拽都要亮").toMatch(
      /\.find-sash:hover::before,\s*\n\s*\.find-sash\.active::before/,
    );
    // 拖拽方向：浮层钉在右上角，手柄在左缘 → 往左拖 = 变宽（startX - currentX）
    expect(bar, "往左拖必须变宽（用 startX - currentX，别写反）").toMatch(
      /startW \+ \(startX - ev\.clientX\)/,
    );
    expect(bar, "双击手柄要能复原（同 VS Code 的 onDidReset）").toMatch(
      /sash\.addEventListener\("dblclick"/,
    );

    // ---- ② 替换行展开后折叠按钮变高（VS Code `.button.toggle { height: -webkit-fill-available }`）----
    const chevToggled = ruleBlock(css, ".find-bar.replace-toggled .find-chevron");
    expect(chevToggled, "展开态必须给 chevron 一个更高的高度").toMatch(/height:\s*53px/);
    // 53 = 主行 25 + 行间距 3 + 替换行 25。⚠️ 不能用 fill-available：在 LitePad 里它是相对
    // 整个浮层（含状态行）铺满，两行反而对不齐（CSS 注释里已记原因）。
    expect(css, "⚠️ chevron 不得用 fill-available（会跟着状态行一起长，两行对不齐）").not.toMatch(
      /find-chevron[\s\S]{0,200}?fill-available/,
    );
    expect(bar, "展开/折叠必须同步浮层上的 replace-toggled 类").toMatch(
      /dom\.classList\.toggle\("replace-toggled", on\)/,
    );

    // ---- ③ 选区按钮在上下箭头之后（VS Code find-actions：count → prev → next → selection）----
    expect(bar, "选区开关必须是工具栏那颗 .find-sel，不再是 .find-toggle").toMatch(
      /const selT = iconBtn\("find-nav find-sel"/,
    );
    expect(bar, "主行顺序必须是 …prev, next, selT…").toMatch(
      /rowMain\.append\(chevron, field, count, prev, next, selT, docsBtn, closeBtn\)/,
    );
    expect(css, "选区开关必须与 .find-nav 同尺寸（22×22 组里要有它）").toMatch(
      /\.find-nav,\s*\n\s*\.find-sel,/,
    );
    // 它是开关，激活态要出边框，但 .find-nav 是 border:none —— 加真 border 会把 16px 图标挤成 14px
    const selOn = ruleBlock(css, ".find-sel.on");
    expect(selOn, "激活环必须用 inset 阴影画（外框尺寸一动不动）").toMatch(
      /box-shadow:\s*inset 0 0 0 1px/,
    );
    expect(selOn, "激活底色复用开关那套令牌").toContain("var(--find-opt-active)");
    expect(selOn, "⚠️ 不得给 .find-sel.on 加真 border（border-box 下会挤掉 2px 图标）").not.toMatch(
      /border-color/,
    );

    // ---- ④ 选区查找与所有文档查找互斥 ----
    // 一个说「只搜光标选中的一段」，另一个说「搜全部已打开文档」，同时成立自相矛盾。
    expect(bar, "点亮选区必须熄掉跨文档").toMatch(
      /if \(on && docsBtn\.classList\.contains\("on"\)\) setAllDocs\(false\)/,
    );
    expect(bar, "点亮跨文档必须熄掉选区").toMatch(
      /if \(on && opt\.selection\) setSelection\(false\)/,
    );

    // ---- ⑤ 结果区已删除（B80）----
    // 用户实测反馈「右边的结果区没有一直占位，底下不要添加结果区」，并要求参考 VS Code：
    // VS Code 的查找浮层（findWidget.css / findWidget.ts）**没有任何内联结果列表** ——
    // 多文件结果在侧边栏的搜索视图里。我们这一栏只把总匹配数交给文档按钮的徽标。
    expect(css, "结果区样式必须删除").not.toContain(".find-results");
    expect(css, "空态占位样式必须删除").not.toContain(".find-empty");
    expect(css, "命中行样式必须删除").not.toContain(".find-hit");
    expect(bar, "查找栏不得再渲染结果区").not.toContain("find-results");
    expect(bar, "查找栏不得再持有命中表（命中表归主程序）").not.toMatch(/\bsetHits\b/);
    expect(bar, "查找栏不得再渲染「无结果」空态").not.toContain("无结果");
    // 删掉列表后，命中之间靠 Enter / 上下箭头跨文档步进（主程序侧）
    // ⚠️ 09-20 起跨文档**不再是命令**：搜索改由「查询/范围变化」统一触发（与另两种范围一致），
    // 回车在三种范围里一律是步进 —— 查找栏因此不再需要 onSearchAll / runSearch。
    expect(bar, "查找栏不得再持有跨文档搜索命令 onSearchAll").not.toMatch(/onSearchAll/);
    expect(bar, "查找栏不得再有跨文档专用的 runSearch 分支").not.toContain("runSearch");

    // ---- ⑥ 查找与替换输入框同宽 ----
    expect(css, "替换框必须改 flex: 0 0 auto 好让 JS 写死宽度").toMatch(
      /\.find-row-replace \.find-field\s*\{[^}]*flex:\s*0 0 auto/,
    );
    expect(bar, "必须把查找框量出来的宽度写到替换框上").toMatch(/replField\.style\.width = /);
    // jsdom（测试）没有布局，量出来是 0 —— 写死 0px 会让替换框彻底消失
    expect(bar, "⚠️ 无布局时必须不下手，别写死 0px").toMatch(/if \(w <= 0\) return;/);

    // ---- ⑦ 图标全部照搬 VS Code 的 codicon（B80 / B102）----
    // 用户要求「按钮图标可以直接照搬 vscode 的」。B102 起**直接用官方 npm 包**：
    // 依赖 @vscode/codicons（package.json，版本钉死）+ main.ts 引入 dist/codicon.css，
    // 字形就是 `<i class="codicon codicon-x">`，不再把上游 svg 抽出来内联。
    const icons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(icons, "codicons.ts 必须写明上游来源").toContain("@vscode/codicons");
    // 反面：抽取脚本与内联 svg 都必须已经退场。
    // ⚠️ 用 stripCssComments 先剥注释：本文件自己的说明里就写着「不得写死 content: "\e…」，
    //    不剥会把注释里的反例判成违规（B102 当天这条先把自己判红了一次）。
    const code = stripCssComments(icons);
    expect(code, "字形必须由官方字体绘制，不得再内联 svg").not.toContain("<svg");
    expect(code, "不得写死字形码位（码位只属于官方 codicon.css）").not.toMatch(
      /content:\s*["']\\e/,
    );
    expect(existsSync("scripts/fetch-codicons.mjs"), "上游抽取脚本必须已退役").toBe(false);
    // 每一颗都得是 `codicon codicon-<id>` 的元素串（id 全小写、连字符）
    const clsTags = [...icons.matchAll(/codicon-\$\{id\}|"codicon codicon-/g)].map((m) => m[0]);
    expect(icons, "必须把「短名 → codicon id」逐条列出").toContain("const IDS");
    expect(clsTags.length, "必须走 codicon 类名").toBeGreaterThan(0);
    expect(icons, "必须含「在选区中查找」用的 find-selection").toContain("findSelection");
    // 查找栏侧：所有图标一律来自 CODICONS，不得再有文字字形或自绘 svg
    expect(bar, "必须从 codicons.ts 取图标").toContain('from "./codicons"');
    expect(bar, "不得再自绘 svg（应全部走 CODICONS）").not.toContain("<svg");
    const innerHtmlLines = bar.match(/innerHTML = .*/g) ?? [];
    expect(innerHtmlLines.length, "图标是懒建的，必须仍走 innerHTML 注入").toBeGreaterThan(0);
    for (const line of innerHtmlLines) {
      // CODICONS.x（具名）或 CODICONS[icon]（工厂传名）都算，重点是不能写死字形
      expect(line, "图标只能来自 CODICONS，不得再写死字形").toMatch(/CODICONS[.[]/);
    }
  });
  it("B80 查找栏三处对齐：左缘手柄不再生硬 / 删除底部结果区 / 图标照搬 codicon", () => {
    // 用户实测三条：①左侧拖拽高亮条很生硬且有错位 ②底下不要结果区，多文档时只在文档
    // 按钮右上角显示总匹配数 ③按钮图标直接照搬 VS Code。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");

    // ---- ① 左缘手柄对齐 VS Code（findWidget.css + sash.css）----
    // 「错位」的根因：VS Code 的 `.find-widget` 带 `overflow: hidden`，那条 4px 手柄被
    // 8px 圆角裁掉两端的直角；我们原先没有 → 方角从圆角里戳出来，看着就是错位。
    expect(ruleBlock(css, ".find-bar"), "浮层必须照抄 overflow: hidden（圆角裁手柄）").toMatch(
      /overflow:\s*hidden/,
    );
    const sash = ruleBlock(css, ".find-sash");
    expect(sash, "手柄常态就是一条淡线（resizeBorder→border = fg@20%）").toContain(
      "background: var(--find-sash)",
    );
    const before = ruleBlock(css, ".find-sash::before");
    expect(before, "::before 常态透明（只负责悬停变色）").toMatch(/background:\s*transparent/);
    expect(before, "⚠️ 必须带 0.1s 缓动，否则变色是瞬间跳（用户实测「很生硬」）").toMatch(
      /transition:\s*background-color 0\.1s ease-out/,
    );
    // 「生硬」的另一半根因：原先高亮只有 2px、还从 left:1px 起，与 4px 手柄和浮层边缘都对不上
    expect(before, "::before 必须铺满手柄本体（100%），别再内缩 1px / 缩成 2px").toMatch(
      /width:\s*100%/,
    );
    expect(css, "悬停/拖拽换成 sash.hoverBorder（→ focusBorder = --accent）").toMatch(
      /\.find-sash:hover::before,\s*\n\s*\.find-sash\.active::before\s*\{\s*background:\s*var\(--find-sash-hover\)/,
    );

    // ---- ② 底部结果区删除，跨文档 a/b 进文档图标徽标 ----
    // （样式与 DOM 的删除已在 B78-⑤ 里断言，这里盯主程序的接线）
    expect(main, "必须有「清空跨文档命中」的收口").toMatch(/function resetFindAll\(/);
    expect(main, "跨文档查找必须把 a/b 回灌给徽标").toMatch(/updateDocBadge\(\)/);
    expect(main, "徽标数字不得再由「已打开文档数」喂（B78 旧语义）").not.toContain("setDocCount");
    expect(main, "查询变更要重搜一次，让徽标跟着实时走").toMatch(
      /if \(q\.allDocs\) runFindInDocs\(q\);/,
    );
    expect(main, "stepFind 必须把跨文档范围转给跨文档步进").toMatch(
      /if \(q\.allDocs\) \{\s*\n\s*stepFindInDocs\(dir, q\);/,
    );
    expect(main, "跨文档步进要在命中表里前后环绕").toMatch(
      /\(findHitIndex \+ dir \+ findHits\.length\) % findHits\.length/,
    );
    // ⚠️ 命中表不能再截断：它同时是「总匹配数」的来源，截断会让徽标少报数
    const searchBody = main.match(/function searchOpenDocs\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(searchBody, "searchOpenDocs 不得再截断到 300 条").not.toMatch(/300/);
    expect(searchBody, "必须扫全部已打开文档的内存快照").toMatch(
      /for \(const doc of docs\.values\(\)\)/,
    );
    // ⚠️ 09-20 起跨文档不再是「带播报标记的命令」：范围/查询变化即重算（不带 announce），
    // 且不再往底部状态行写「共 N 处匹配，回车逐个跳转」（另两种范围都没有这条提示）。
    expect(main, "查询/范围变化必须统一重算跨文档命中").toMatch(
      /if \(q\.allDocs\) runFindInDocs\(q\);/,
    );
    expect(main, "「共 N 处匹配，回车逐个跳转」提示必须删除").not.toContain("回车逐个跳转");
    expect(main, "onOpenHit 回调必须删除（已经没有结果列表可点）").not.toContain("onOpenHit");
    // 关栏即清：否则下次打开会带着上一次的总数
    expect(main, "关栏时必须清空命中表").toMatch(
      /clearFindHighlight\(\);\s*\n\s*resetFindAll\(\);/,
    );

    // ---- 查找栏侧：a/b 只由 setDocIndex 单点驱动，且不再有任何结果区痕迹 ----
    expect(bar, "徽标只能由 setDocIndex 回灌").toMatch(/setDocIndex: \(a, b\) => \{/);
    expect(bar, "查询一变就作废旧的 a/b（别挂着过期数字）").toMatch(/docA = 0;\s*\n\s*docB = 0;/);
    expect(bar, "不得再有结果区 / 命中表的任何痕迹").not.toMatch(
      /find-results|renderResults|setHits|setDocCount/,
    );
  });
});
