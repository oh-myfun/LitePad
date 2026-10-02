// @vitest-environment jsdom
// B205（用户原话「大纲展开区参考 vscode 改进下：列表支持折叠展开，顶部有大纲字样，
// 以及全部展开/折叠按钮」）：大纲列表从「扁平一排」改成**可折叠的层级树**。
// 本文件盯三件事：① 结构（标题栏 / 两颗全量键）；② 层级（扭角只给有子的节点、
// 缩进靠嵌套）；③ 行为（扭角只折叠不跳转、全量折叠/展开、折叠态跨重渲染不丢）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createTocList } from "../src/markdown/toc";
import type { TocEntry } from "../src/markdown/pipeline";
import { CODICONS } from "../src/shell/codicons";

/** 造一条大纲条目（id 与 level/line 绑定，正好当折叠态的键）。 */
function e(level: number, line: number, text: string): TocEntry {
  return { level, line, text, id: `h${level}-${line}` };
}

function mount(): HTMLElement {
  const list = document.createElement("div");
  list.className = "toc-list";
  document.body.appendChild(list);
  return list;
}

const items = (list: HTMLElement) => Array.from(list.querySelectorAll<HTMLElement>(".toc-item"));
describe("B205 大纲标题栏：顶部「大纲」字样 + 全部折叠/展开两颗键", () => {
  it("index.html 里标题栏在列表**之前**，两颗键各自带 aria-label", () => {
    const html = readFileSync("index.html", "utf-8");
    const head = html.indexOf('id="toc-head"');
    const list = html.indexOf('id="toc-list"');
    const collapse = html.indexOf('id="toc-collapse-all"');
    const expand = html.indexOf('id="toc-expand-all"');
    expect(head, "index.html 要有 #toc-head").toBeGreaterThan(-1);
    expect(list, "index.html 要有 #toc-list").toBeGreaterThan(-1);
    expect(collapse, "index.html 要有 #toc-collapse-all").toBeGreaterThan(-1);
    expect(expand, "index.html 要有 #toc-expand-all").toBeGreaterThan(-1);
    expect(head, "标题栏必须排在列表之前（不然不是「顶部」）").toBeLessThan(list);
    expect(html, "标题栏要有「大纲」字样").toMatch(/id="toc-title"[^>]*>大纲</);
    expect(html, "全部折叠键要有 aria-label").toMatch(
      /id="toc-collapse-all"[\s\S]{0,240}?aria-label="全部折叠"/,
    );
    expect(html, "全部展开键要有 aria-label").toMatch(
      /id="toc-expand-all"[\s\S]{0,240}?aria-label="全部展开"/,
    );
  });

  it("两颗键的字形走 CODICONS.collapseAll / expandAll（不写死 codicon id，不手绘）", () => {
    const main = readFileSync("src/main.ts", "utf-8");
    const at = (needle: string): number => main.indexOf(needle);
    expect(
      at("tocCollapseAll.innerHTML = CODICONS.collapseAll;"),
      "全部折叠键要装 collapse-all 字形",
    ).toBeGreaterThan(-1);
    expect(
      at("tocExpandAll.innerHTML = CODICONS.expandAll;"),
      "全部展开键要装 expand-all 字形",
    ).toBeGreaterThan(-1);
    // 反向：不许内联写死 `.codicon-collapse-all` 这种字符串（字形只能从 IDS 取）
    expect(main, "不许写死 codicon id").not.toMatch(/codicon-(collapse|expand)-all/);
    const icons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(icons, "IDS 要收 collapse-all —— 没有调用点的字形不许收（文件头纪律）").toMatch(
      /collapseAll:\s*"collapse-all"/,
    );
    expect(icons, "IDS 要收 expand-all").toMatch(/expandAll:\s*"expand-all"/);
  });

  it("CSS：面板上下两条（标题栏固着 + 列表滚动），缩进改由嵌套承担", () => {
    const css = readFileSync("src/styles/preview.css", "utf-8");
    const block = (sel: string): string =>
      css.match(new RegExp(sel.replace(".", "\\.") + "\\s*\\{[^}]*\\}"))?.[0] ?? "";
    const panel = block(".toc-panel");
    expect(panel, "要能定位 .toc-panel").toContain("flex-direction: column");
    expect(panel, "滚动归列表，面板只当容器").toContain("overflow: hidden");
    const list = block(".toc-list");
    expect(list, "列表要自己滚").toMatch(/overflow-y:\s*auto/);
    // 缩进：level 分档那一套（12/24/36/48px）已经删了 —— 没有扭角列时它还能凑，
    // 有扭角之后档距（12px）对不上扭角宽（14px），只能改靠 .toc-children 的左外边距。
    for (const sel of [".toc-h1", ".toc-h2", ".toc-h3", ".toc-h4", ".toc-h5", ".toc-h6"]) {
      expect(css, `${sel} 不该再留 padding-left 分档缩进（B205 之后缩进走嵌套）`).not.toContain(
        `${sel} {`,
      );
    }
    const kids = block(".toc-children.is-collapsed");
    expect(kids, "折叠态必须真的藏起来").toMatch(/display:\s*none/);
    expect(css, "扭角要有固定列宽（缩进标尺那一格）").toMatch(
      /\.toc-caret\s*\{[^}]*flex:\s*0 0 \d+px/,
    );
    expect(css, "子层缩进要跟扭角列宽对齐").toMatch(
      /\.toc-node > \.toc-children\s*\{[^}]*margin-left/,
    );
  });
});

describe("B205 大纲层级树：扭角只给有子的节点，缩进靠嵌套", () => {
  it("扁平 entries 按 level 归纳成嵌套容器：h1 > h2 > h3", () => {
    const list = mount();
    const h = createTocList(list);
    h.render([e(1, 1, "一"), e(2, 5, "一·子"), e(3, 9, "一·子·孙"), e(2, 13, "一·另子")], -1, {
      onJump: () => {},
    });

    const first = list.querySelector(".toc-node") as HTMLElement;
    expect(first.dataset.tocId, "节点要带 id（折叠态的索引）").toBe("h1-1");
    expect(first.querySelector(".toc-item")?.textContent, "标题文本要在 .toc-item 里").toBe("一");
    const kids = first.querySelector(".toc-children") as HTMLElement;
    expect(kids, "有子的节点要挂子节点容器").toBeTruthy();
    // ⚠️ 必须用 `:scope >`：querySelectorAll 收的是**全部**后代，这里会顺手把孙节点也数进来
    expect(kids.querySelectorAll(":scope > .toc-node").length, "两条 h2 都挂在 h1 下").toBe(2);
    // 第一条 h2 下面还有一条 h3 ⇒ 它自己是「分支」，第二条 h2 是叶子
    expect(
      kids.querySelectorAll(":scope > .toc-node")[0].querySelector(".toc-children"),
      "h2 下面有 h3",
    ).toBeTruthy();
    expect(
      kids.querySelectorAll(":scope > .toc-node")[1].querySelector(".toc-caret"),
      "叶子 h2 不给扭角",
    ).toBeNull();
    // 文本前后缀：标题文本仍然**只在按钮里**（.toc-text），扭角是空 <i>，textContent 不受污染
    expect(
      items(list).map((it) => it.textContent),
      "textContent 仍是纯标题（扭角是空元素）",
    ).toEqual(["一", "一·子", "一·子·孙", "一·另子"]);
  });

  it("跳级的 level 不串层：h1 → h4 → h2 各归各位", () => {
    const list = mount();
    const h = createTocList(list);
    h.render([e(1, 1, "一"), e(4, 5, "深"), e(2, 9, "二")], -1, { onJump: () => {} });
    expect(list.querySelectorAll(":scope > .toc-node").length, "顶层只有一条").toBe(1);
    expect(
      list.querySelectorAll(".toc-node")[0].querySelectorAll(":scope > .toc-children > .toc-node")
        .length,
      "跳级的 h4 与后面的 h2 都挂在 h1 下（不当成两棵）",
    ).toBe(2);
  });

  it("扭角只挂在有子的节点上，且折叠态直接画在字形上", () => {
    const list = mount();
    const h = createTocList(list);
    h.render([e(1, 1, "一"), e(2, 5, "一·子")], -1, { onJump: () => {} });
    const all = Array.from(list.querySelectorAll<HTMLElement>(".toc-item"));
    expect(all.length, "两行标题两个按钮").toBe(2);
    expect(all[0].querySelector(".toc-caret"), "有子的 h1 要有扭角").toBeTruthy();
    // ⚠️ B208：字形在**内层 .codicon** 上，`.toc-caret` 只是占位列的容器 ——
    //    盯 `.className` 会假绿（旧 bug 就是「把 CODICONS 那个元素串拼进 className」，
    //    畸形属性里照样含 `codicon-chevron-down` 这个子串，箭头却一个都没画出来）。
    // ⚠️ 所以判据用**与 CODICONS 元素串严格相等**，再用结构判据钉死「字形落在子元素上」：
    //    只要哪天有人把 CODICONS 那串塞回 className，这里两个判据一起咬。
    const caret0 = all[0].querySelector(".toc-caret");
    expect(caret0?.innerHTML, "展开态.inner 就是 CODICONS.chevronDown 那串").toBe(
      CODICONS.chevronDown,
    );
    expect(
      caret0?.querySelector(".codicon")?.getAttribute("class"),
      "字形必须落在内层 .codicon 元素上",
    ).toContain("codicon-chevron-down");
    expect(
      caret0?.classList.contains("codicon"),
      "占位列自己不许带字形类（那就画在错的地方）",
    ).toBe(false);
    expect(all[1].querySelector(".toc-caret"), "叶子不给扭角").toBeNull();
    expect(all[0].getAttribute("aria-expanded"), "分支要报可展开").toBe("true");
    expect(all[1].getAttribute("aria-expanded"), "叶子不许报 aria-expanded").toBeNull();
  });

  it("空态两档文案照旧，且不清掉标题栏（标题栏在 #toc-panel 里，不在被清的 #toc-list 里）", () => {
    const list = mount();
    const h = createTocList(list);
    h.render(null, -1, { onJump: () => {} });
    expect(list.querySelector(".toc-empty")?.textContent).toBe("当前文档类型不支持大纲");
    h.render([], -1, { onJump: () => {} });
    expect(list.querySelector(".toc-empty")?.textContent).toBe("当前文档没有标题");
    expect(list.querySelectorAll(".toc-item").length, "空态不渲染任何标题行").toBe(0);
  });
});

describe("B205 折叠交互：扭角只折叠不跳转，全量键管全部", () => {
  it("点扭角 = 折起这一节（且不触发跳转），点标题文字才跳转", () => {
    const list = mount();
    const h = createTocList(list);
    const jumped: number[] = [];
    h.render([e(1, 1, "一"), e(2, 5, "一·子")], -1, { onJump: (en) => jumped.push(en.line) });

    const caret = list.querySelector(".toc-caret") as HTMLElement;
    caret.click();
    expect(jumped, "点扭角不许跳到标题行").toEqual([]);
    const firstKids = list.querySelector(".toc-children") as HTMLElement;
    expect(firstKids.classList.contains("is-collapsed"), "这一节要折起来").toBe(true);
    expect(
      firstKids.querySelectorAll(".toc-node").length,
      "折着不代表删了，节点还在（只是 display:none）",
    ).toBe(1);
    expect(
      list.querySelectorAll(".toc-item")[0].querySelector(".toc-caret")?.innerHTML,
      "折起后扭角翻成 chevron-right（与 CODICONS 元素串严格相等）",
    ).toBe(CODICONS.chevronRight);

    // 再点一次展开：还是不跳转
    (list.querySelector(".toc-caret") as HTMLElement).click();
    expect(jumped, "展开那一下也不跳").toEqual([]);
    expect(firstKids.classList.contains("is-collapsed"), "再点要展开").toBe(false);

    // 点标题文字（命中 .toc-text）⇒ 走跳转
    (
      list.querySelectorAll<HTMLElement>(".toc-item")[1].querySelector(".toc-text") as HTMLElement
    ).click();
    expect(jumped, "点标题文字才跳").toEqual([5]);
  });

  it("全部折叠 / 全部展开：只管有子的节点，折完还能逐条展开", () => {
    const list = mount();
    const h = createTocList(list);
    h.render([e(1, 1, "一"), e(2, 5, "一·子"), e(1, 9, "二")], -1, { onJump: () => {} });
    expect(list.querySelectorAll(".toc-children").length, "只有 h1 是分支，一个子节点容器").toBe(1);

    h.collapseAll();
    const kids = Array.from(list.querySelectorAll<HTMLElement>(".toc-children"));
    expect(
      kids.every((k) => k.classList.contains("is-collapsed")),
      "全部折起",
    ).toBe(true);
    expect(
      Array.from(list.querySelectorAll(".toc-caret")).every(
        (c) => c.innerHTML === CODICONS.chevronRight,
      ),
      "全部折起后扭角都朝右",
    ).toBe(true);
    // B208（用户点名「全部折叠后还能看到二级项」）：只断言 `is-collapsed` 那个类是假绿
    // —— jsdom 不算 CSS。真正要盯的是「除顶层外**没有一行**还站在可见层次上」：任何非
    // 顶层行都必须躺在某个 `is-collapsed` 容器里，CSS 那条 display:none 才会顺着父链命中
    // 它。这样「折了但二级项还露着」这类偏差会被咬住。
    const visibleRows = (): string[] =>
      Array.from(list.querySelectorAll<HTMLElement>(".toc-item"))
        .filter((it) => {
          for (let p: HTMLElement | null = it.parentElement; p; p = p.parentElement) {
            if (p.classList.contains("is-collapsed")) return false;
          }
          return true;
        })
        .map((it) => it.textContent ?? "");
    expect(visibleRows(), "折完只剩两条顶层标题（二级项必须一起收掉）").toEqual(["一", "二"]);

    h.expandAll();
    expect(
      Array.from(list.querySelectorAll(".toc-children")).every(
        (k) => !k.classList.contains("is-collapsed"),
      ),
      "全部展开",
    ).toBe(true);
    expect(
      Array.from(list.querySelectorAll(".toc-caret")).every(
        (c) => c.innerHTML === CODICONS.chevronDown,
      ),
      "全部展开后扭角都朝下",
    ).toBe(true);
    expect(visibleRows(), "展开后二级项回来").toEqual(["一", "一·子", "二"]);

    // 全量键只折「分支」；折完单条展开不影响别的
    h.collapseAll();
    (list.querySelector(".toc-caret") as HTMLElement).click();
    const after = Array.from(list.querySelectorAll<HTMLElement>(".toc-children"));
    expect(
      after.filter((k) => !k.classList.contains("is-collapsed")).length,
      "单条展开只放开一条",
    ).toBe(1);
  });

  it("折叠态跨重渲染不丢（光标一动就重绘，冲掉就白折了）", () => {
    const list = mount();
    const h = createTocList(list);
    h.render([e(1, 1, "一"), e(2, 5, "一·子")], -1, { onJump: () => {} });
    (list.querySelector(".toc-caret") as HTMLElement).click();
    expect(
      (list.querySelector(".toc-children") as HTMLElement).classList.contains("is-collapsed"),
    ).toBe(true);

    // 光标动了 ⇒ 换 entry 数组 + 换 activeLine，重绘一遍
    h.render([e(1, 1, "一"), e(2, 5, "一·子")], 5, { onJump: () => {} });
    expect(
      (list.querySelector(".toc-children") as HTMLElement).classList.contains("is-collapsed"),
      "重绘后折着的那一节还是折着",
    ).toBe(true);
    expect(
      list.querySelectorAll(".toc-item")[1].classList.contains("toc-active"),
      "活动项照旧高亮",
    ).toBe(true);
  });
});
