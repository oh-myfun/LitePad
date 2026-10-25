// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  themeBlock,
  cssDecls,
  ruleBlock,
  stripLineComments,
  stripCssComments,
  resolveCssVars,
  tabsAll,
} from "./static";

describe("标签栏静态契约（从 regressions 拆出）", () => {
  it("B53/B117 标签区横向滚动改自绘悬浮滚动条（折叠机制已整体移除）", () => {
    // 用户要求：去掉 tab 折叠功能（B53）→ 滚动条改 VS Code 式悬浮不占高度（B117）。
    // 原生横向滚动条在 Chromium 里永远占布局空间，做不出悬浮形态 —— 改自绘：
    // strip 只负责被程序滚动（overflow hidden 下 scrollLeft 可编程设置），
    // 可见 thumb 由 tabstrip.ts 的 syncOverlayScrollbar 叠在底部。
    const css = readFileSync("src/styles/global.css", "utf-8");
    // ⚠️ 必须 \n 锚定行首：pill 覆盖块（B114）的选择器是
    //   :root[data-tab-style="pill"] .panel-tabstrip
    // 无锚定时 \.panel-tabstrip\s*\{ 会命中它的尾段，抓回来的是 pill 块的块体。
    const strip = ruleBlock(css, ".panel-tabstrip", undefined, true);
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    expect(strip, "标签区不再吃原生滚动条（B117 悬浮化）").toContain("overflow-x: hidden");
    expect(css, "原生 webkit 滚动条规则必须整体删除").not.toMatch(
      /\.panel-tabstrip::-webkit-scrollbar/,
    );
    expect(css, "悬浮条轨道必须存在").toMatch(/\.panel-tabstrip-scrollbar\s*\{/);
    expect(css, "悬浮条必须悬浮（absolute，不占布局）").toMatch(
      /\.panel-tabstrip-scrollbar\s*\{[^}]*position:\s*absolute/,
    );
    expect(css, "thumb 要比 B55 的 4px 更细").toMatch(
      /\.panel-tabstrip-scrollbar-thumb\s*\{[^}]*height:\s*[1-3]px/,
    );
    expect(strip, "标签永不换行（VS Code）").toContain("flex-wrap: nowrap");
    expect(css, "折叠按钮的样式必须整体删除").not.toContain("tab-more");

    // P2 内聚拆分：滚动交互/自绘滚动条已迁 src/shell/scrollbar.ts —— 拼接两份再锚
    // （本段全部是 toContain/not.toMatch 类锚点，无跨文件 indexOf 顺序闸）。
    const ts =
      readFileSync("src/shell/tabstrip.ts", "utf-8") +
      "\n" +
      readFileSync("src/shell/scrollbar.ts", "utf-8");
    const tsCode = stripLineComments(ts);
    expect(tsCode, "折叠机制必须整体删除（含下拉列表构造）").not.toContain("tab-more");
    expect(tsCode, "不应再按 tabId 重对齐可见窗口").not.toContain("reanchorStart");
    // ⚠️ B125 起**允许**手写 ResizeObserver，但只准一种用途：跟随面板宽度改 thumb 几何
    //    （拖分屏条不改窗口尺寸，window.resize 兜不住）。B53 禁的是「重算可见区间」——
    //    那个已经被原生滚动取代；这里禁止的是用它记账（reanchorStart / 折叠残留）。
    //    判据：RO 回调里只能调 syncOverlayScrollbar，不得出现其它记账动作。
    expect(tsCode, "ResizeObserver 只能用于同步 thumb 几何（B125），不得拿去重算可见区间").toMatch(
      /new ResizeObserver\(\(\) => syncOverlayScrollbar\(host\)\)/,
    );
    expect(
      (tsCode.match(/new ResizeObserver/g) ?? []).length,
      "只允许这一处 ResizeObserver（多一处就要问是不是又在记账）",
    ).toBe(1);
    expect(tsCode, "必须挂载滚轮滚动").toContain('addEventListener("wheel"');
    expect(tsCode, "滚轮需用 passive:false 才能 preventDefault").toContain("passive: false");
    expect(tsCode, "Ctrl+滚轮要让位给字号缩放").toContain("if (e.ctrlKey) return;");
    expect(tsCode, "全量重绘必须存取滚动位置，否则每次重绘都跳回最左").toContain(
      "const prevScroll = host.scrollLeft",
    );
    expect(tsCode, "必须把活动标签滚进可见区").toContain("ensureVisible(host");
    // 用 scrollIntoView 会连带滚动所有祖先容器（分屏/嵌套布局下整页跳），且 jsdom 没有它。
    // 只禁止**调用**（注释里提到它没关系），故匹配带接收者的调用式。
    expect(tsCode, "定位用自身几何而不是 scrollIntoView").not.toMatch(/\.scrollIntoView\(/);
    // B117：自绘悬浮条三件套 —— 包裹、同步、拖拽
    expect(tsCode, "必须包裹 wrap 并挂自绘条").toContain("ensureOverlayScrollbar");
    expect(tsCode, "必须有 thumb 几何同步").toContain("syncOverlayScrollbar");
    expect(tsCode, "scroll 事件驱动同步（程序滚动也覆盖）").toContain('addEventListener("scroll"');
    expect(tsCode, "thumb 必须可拖拽").toContain("bindThumbDrag");

    // B125：默认隐藏（VS Code 标签条走 ScrollbarVisibility.Auto）
    const barRule = css.match(/^\.panel-tabstrip-scrollbar \{[\s\S]*?\}/m)?.[0] ?? "";
    expect(barRule, "轨道默认必须透明（不悬停就不画）").toMatch(/opacity:\s*0/);
    expect(barRule, "淡出必须有过渡（对齐 VS Code .invisible.fade = 800ms linear）").toMatch(
      /transition:\s*opacity\s+800ms/,
    );
    const shown = ruleBlock(css, ".panel-tabstrip-scrollbar.is-visible");
    expect(shown, "可见态必须不透明").toMatch(/opacity:\s*1/);
    expect(shown, "出现要即时（过渡只留给淡出）").toMatch(/transition:\s*none/);
    const thumbRule = ruleBlock(css, ".panel-tabstrip-scrollbar-thumb");
    expect(thumbRule, "隐藏时 thumb 必须让出点击（否则一条看不见的条挡住标签底部）").toContain(
      "pointer-events: none",
    );
    expect(css, "只有可见态才让 thumb 吃事件").toMatch(
      /\.panel-tabstrip-scrollbar\.is-visible \.panel-tabstrip-scrollbar-thumb \{[^}]*pointer-events:\s*auto/,
    );
    expect(tsCode, "悬停即现").toContain('addEventListener("pointerenter"');
    expect(tsCode, "离开即收").toContain('addEventListener("pointerleave"');
    expect(tsCode, "淡出延时要等于 VS Code 的 HIDE_TIMEOUT（500）").toContain(
      "SCROLLBAR_HIDE_DELAY = 500",
    );
    expect(tsCode, "必须有显隐两个助手").toContain("function revealScrollbar");
    expect(tsCode).toContain("function hideScrollbar");

    // 反向验证：滚动条改回「常显」（默认不透明）必须被咬住
    const ALWAYS = css.replace(
      /(\.panel-tabstrip-scrollbar \{[\s\S]*?)opacity: 0;/,
      "$1opacity: 1;",
    );
    expect(ALWAYS, "替身必须真的改成常显").not.toBe(css);
    expect(
      ALWAYS.match(/^\.panel-tabstrip-scrollbar \{[\s\S]*?\}/m)?.[0],
      "替身的常显必须被抓到",
    ).toMatch(/opacity:\s*1/);

    // 条带高度：悬浮条不占布局 → 28px = 3px 上间距 + 22px 标签 + 3px 下间隙
    // （B123-6 两档统一，上下对称，下间隙 = thumb 高度）
    expect(strip, "标签栏高度必须固定（无溢出↔有溢出恒定，不抖）").toMatch(/height:\s*\d+px/);
    const tabRule = ruleBlock(css, ".tab", undefined, true);
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    const tabH = Number(tabRule.match(/height:\s*(\d+)px/)![1]);
    expect(stripH - tabH, "上下间隙共 6px（3+3 对称，B123-6）").toBe(6);
  });
  it("B364：自绘滚动条压在活动标签之上，并让开条带下沿那条线（thumb 完整可见）", () => {
    // 用户实测（标签条溢出、指针停在条带上）报了两件事：
    //  ① 滚动条被活动标签挡住 —— 活动 fill 下探到条带底（B113 的 -3px 舌片），
    //     原来没有 z-index 的滚动条被它整段盖住，滚到活动标签那一段像断了；
    //  ② 下半截被裁掉 / 被边框挡住 —— thumb 原来贴条带最底缘（bottom: 0），
    //     最下面 1px 正好与 `.panel-head::after` 那条横贯线重叠，被线盖成另一种颜色。
    // 判据只锁**关系**（不锁具体层号），以后调层不会误伤；但「又被盖上」一定红。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const zIndexOf = (src: string, selector: string): number => {
      const decls = cssDecls(ruleBlock(src, selector, undefined, true));
      return Number(decls.match(/z-index:\s*(-?\d+)/)?.[1] ?? NaN);
    };
    const fillZ = zIndexOf(css, ".tab-active .tab-fill");
    expect(fillZ, "活动标签 fill 应有 z-index（B349 定的层）").not.toBeNaN();
    expect(
      zIndexOf(css, ".panel-tabstrip-scrollbar"),
      "滚动条必须压在活动标签 fill 之上",
    ).toBeGreaterThan(fillZ);
    // 反相对照：把轨道打回 z-index: 0（活动 fill 就是 1）⇒ 同一条判据必须咬住
    const BAD_COVER = css.replace(
      /(\.panel-tabstrip-scrollbar \{[^}]*?)z-index:\s*-?\d+;/,
      "$1z-index: 0;",
    );
    expect(BAD_COVER, "替身必须真的改到轨道的 z-index").not.toBe(css);
    expect(
      zIndexOf(BAD_COVER, ".panel-tabstrip-scrollbar"),
      "被活动标签盖住的替身必须被咬住",
    ).not.toBeGreaterThan(fillZ);

    // 下沿让位：轨道 bottom 必须等于线的厚度（--tab-stroke），thumb 才能整条落在线上方。
    // 判像素的守卫先展开 token（B337 的规矩）：改 token 值这条也要跟着算，不能只认名字。
    const resolved = resolveCssVars(css);
    const pxOf = (decls: string, prop: string): number =>
      Number(decls.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`))?.[1] ?? NaN);
    const barBottom = pxOf(
      cssDecls(ruleBlock(resolved, ".panel-tabstrip-scrollbar", undefined, true)),
      "bottom",
    );
    const lineH = pxOf(
      cssDecls(ruleBlock(resolved, ".panel-head::after", undefined, true)),
      "height",
    );
    expect(lineH, "条带下沿线应有厚度（B349 的 --tab-stroke）").not.toBeNaN();
    expect(barBottom, "整条轨道必须让开下沿线（thumb 不许压在线上）").toBeGreaterThanOrEqual(lineH);
    // 反相对照：bottom 打回 0 ⇒ 轨道又贴到最底缘、最下面一格压回线上
    const BAD_ON_LINE = resolved.replace(
      /(\.panel-tabstrip-scrollbar \{[^}]*?)bottom:\s*[\d.]+px;/,
      "$1bottom: 0px;",
    );
    expect(BAD_ON_LINE, "替身必须真的改到轨道的 bottom").not.toBe(resolved);
    expect(
      pxOf(
        cssDecls(ruleBlock(BAD_ON_LINE, ".panel-tabstrip-scrollbar", undefined, true)),
        "bottom",
      ),
      "贴着最底缘的替身必须被咬住",
    ).toBeLessThan(lineH);
  });
  it("B56 标签不收缩 + 单标签名超长按 max-width 截断（标签栏横向滚动，不互相挤压）", () => {
    // 用户反馈（B56 原）：标签变多后标签被压窄，文件名被裁剪成「…」——根因是 .tab 上的
    // flex-shrink:1（B53「先收缩再滚动」）。B56 保留：.tab 自身 flex: 0 0 auto，标签栏
    // 标签多时它们溢出并走自绘横向滚动条，**不互相挤压**。
    // 本次新增：单个标签名超长时按 .tab 的 max-width（220px）截断成「…」（.tab-name 可收缩
    // + 溢出省略号），而不是无上限地撑宽 —— 这是用户明确要的「标签支持最大宽度」。
    // ⚠️ 用 ruleBlock 而不是「取到第一个右花括号为止」的旧写法：后者会被**块内注释里的
    //   右花括号**截断（B113 这次就在注释里引过 VS Code 的选择器，一截断 flex 声明全丢，
    //   报的是「文件名不得收缩」这种八竿子打不着的错）——见 pitfalls/0075。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tab = cssDecls(ruleBlock(css, ".tab", undefined, true));
    expect(tab, "应有 .tab 规则").toBeTruthy();
    expect(tab, "标签必须不可收缩（flex-shrink:0），否则标签变多时宽度被压窄").toMatch(
      /flex:\s*0 0 auto/,
    );
    expect(tab, "不得再写 flex: 0 1 auto（那是会裁剪文本的可收缩行为）").not.toMatch(
      /flex:\s*0 1 auto/,
    );
    expect(tab, "单标签名超长必须按 max-width 截断（用户需求）").toMatch(/max-width:\s*\d+px/);
    expect(tab, "保留收缩下限当最小宽度（短名标签不至于窄成一条）").toMatch(/min-width:\s*\d+px/);

    const name = cssDecls(ruleBlock(css, ".tab-name"));
    expect(name, "应有 .tab-name 规则").toBeTruthy();
    expect(name, "文件名可收缩以在 max-width 内截断").toMatch(/flex:\s*1 1 auto/);
    expect(name, "必须能截断溢出（超长名变「…」）").toContain("text-overflow: ellipsis");
    expect(name, "必须裁剪溢出才能出省略号").toContain("overflow: hidden");
    expect(name, "截断需要 min-width: 0 让 flex 子项能收缩").toContain("min-width: 0");
    expect(name, "省略号需要单行（nowrap）").toContain("white-space: nowrap");

    // 反向验证：删掉 max-width / 省略号必须被咬住，防止回归回「无上限撑宽」
    const noMax = css.replace(
      /(\n\.tab\s*\{[^}]*?)max-width:\s*\d+px;/,
      "$1/* max-width 已移除 */",
    );
    expect(noMax, "退化：max-width 必须真的被删").not.toMatch(
      /\n\.tab\s*\{[^}]*max-width:\s*\d+px/,
    );
    const noEll = css.replace(
      /(\n\.tab-name\s*\{[^}]*?)text-overflow:\s*ellipsis;/,
      "$1/* ell 已移除 */",
    );
    expect(noEll, "退化：省略号必须真的被删").not.toMatch(
      /\n\.tab-name\s*\{[^}]*text-overflow:\s*ellipsis/,
    );
  });
  it("B57 ● 与 × 共用固定尺寸槽位，显隐走 opacity（对齐 VS Code 标签操作列）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const slot = cssDecls(ruleBlock(css, ".tab-action", undefined, true));
    expect(slot, "应有 .tab-action 槽位规则").toBeTruthy();
    expect(slot, "槽位尺寸必须固定，否则悬停切换会改变标签宽度").toMatch(/width:\s*\d+px/);
    expect(slot).toMatch(/height:\s*\d+px/);

    // VS Code 标签操作列用 opacity 而不是 display 做显隐（经典档 multieditortabscontrol.css
    // 与 Modern UI 档 tabs.css 都是这套）：布局本来就被固定槽位锁住，
    // opacity 既能淡入，也不触发重排。
    const layer = cssDecls(ruleBlock(css, ".tab-mark, .tab-close"));
    expect(layer, "应有 .tab-mark / .tab-close 公共层规则").toBeTruthy();
    expect(layer, "默认必须隐藏（opacity: 0）").toMatch(/opacity:\s*0\b/);
    expect(layer, "不得再用 display 切换显隐").not.toMatch(/display:\s*none/);

    expect(css, "未保存时 ● 要能显示").toMatch(/\.tab-dirty[^{]*\.tab-mark\s*\{[^}]*opacity:\s*1/);
    expect(css, "悬停**已保存**标签显示 ×").toMatch(
      /\.tab:hover:not\(\.tab-dirty\)\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "**已保存的**活动标签常驻 ×（关闭当前文件是高频操作，不该先悬停）").toMatch(
      /\.tab-active:not\(\.tab-dirty\)\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "× 颜色继承标签文字色（VS Code 做法，非独立灰）").toMatch(
      /\.tab-close\s*\{[^}]*color:\s*inherit/,
    );

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "未保存必须打 tab-dirty（CSS 靠它决定槽位状态）").toContain("tab-dirty");
    expect(ts, "× 必须用矢量图标（CODICONS.close），不再是文本字形").toContain("CODICONS.close");
    expect(ts, "不得再用文本 ×").not.toContain('textContent = "×"');
    expect(ts, "未保存圆点必须走矢量（CODICONS.circleFilled）").toContain("CODICONS.circleFilled");
    expect(ts, "不得再用文本 ●").not.toContain('textContent = "●"');
  });
  it("B65 ● 与 × 不得同时显示（同槽位互斥，含 hover / 活动标签 / 拖拽影像）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");

    // × 的四个出场口（B66 起按保存状态分档）。回归点：老写法里「未保存的当前标签」
    // 必然同时带 `.tab-dirty` 与 `.tab-active`，于是 `.tab-dirty .tab-mark`（● 无条件亮）
    // 与 `.tab-active .tab-close`（× 常驻）双双 opacity: 1，叠死在同一个槽位里
    // （观感 = 一个带橙调的 ×）。B64 的拖拽影像克隆的正是活动标签、副本永不 :hover，
    // 同样中招。
    const DOORS = [
      ["关闭区悬停", ".tab-action:hover .tab-close"],
      ["关闭区聚焦", ".tab-action:focus-within .tab-close"],
      ["标签悬停（仅已保存）", ".tab:hover:not(.tab-dirty) .tab-close"],
      ["活动标签（仅已保存）", ".tab-active:not(.tab-dirty) .tab-close"],
    ] as const;

    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [label, sel] of DOORS) {
      expect(css, `${label}时必须能显示 ×`).toMatch(
        new RegExp(`${esc(sel)}[^{]*\\{[^}]*opacity:\\s*1`),
      );
    }

    // ● 的显示条件必须**显式排除**能与 `.tab-dirty` 同时命中的那两个口（关闭区悬停 /
    // 关闭区聚焦）：互斥就靠这一条 :not() 链。另两个口自带 `:not(.tab-dirty)`，
    // 不可能撞上，所以不必也不该出现在这条链里。
    const mark = cssDecls(css.match(/\.tab-dirty[^{]*\.tab-mark\s*\{[^}]*\}/)?.[0] ?? "");
    expect(mark, "应有「未保存时显示 ●」的规则").toBeTruthy();
    expect(mark, "● 只在指针不在关闭区时出场").toContain(".tab-action:not(:hover)");
    expect(mark, "● 不得在关闭键持有焦点时出场").toContain(":not(:focus-within)");

    // 反向：老写法必须消失 —— 少一条排除就会让 ● 与 × 同时亮。
    // 选择器可以写成独立规则，也可以并进逗号组，所以尾巴上的 `,` 与 `{` 都要抓。
    expect(css, "不得再把 ● 写成无条件常驻").not.toMatch(/\.tab-dirty\s+\.tab-mark\s*[,{]/);
    expect(css, "不得再靠「命中时把 ● 压回 0」的单点补丁（漏掉聚焦档就会复发）").not.toMatch(
      /\.tab-action:hover\s+\.tab-mark\s*[,{]/,
    );
    expect(css, "不得再让整个标签的悬停给脏标签换上 ×").not.toMatch(
      /\.tab:hover\s+\.tab-close\s*[,{]/,
    );
    expect(css, "不得再让脏标签的活动标签常驻 ×").not.toMatch(/\.tab-active\s+\.tab-close\s*[,{]/);

    // 非焦点面板的 × 降亮度同样要逐条对齐触发条件：无条件降亮度（B57 老写法）会让
    // 非焦点面板里**每个**标签都常驻一个 50% 的 ×，未保存标签的 ●（opacity: 1）
    // 就跟它叠在一起 —— 这是 B65 在分屏下的同一个病；B66 新增的两档也要一起补。
    expect(css, "非焦点面板不得无条件把 × 压到 0.5").not.toMatch(
      /\.layout-panel:not\(\.layout-panel-active\)\s+\.tab-close\s*\{/,
    );
    for (const [label, sel] of DOORS) {
      expect(css, `非焦点面板：${label}时 × 要暗一档（0.5 而不是 1）`).toContain(
        `.layout-panel:not(.layout-panel-active) ${sel}`,
      );
    }
    expect(css, "非焦点面板降亮度要落到 0.5").toMatch(
      /\.layout-panel:not\(\.layout-panel-active\)\s+\.tab-action:focus-within\s+\.tab-close[^{]*\{[^}]*opacity:\s*0\.5/,
    );
  });
  it("B66 未保存标签默认 ●，只有指针进入关闭区才换成 ×（用户要求）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");

    // 判据必须落在**关闭区**（`.tab-action` 那 20px 见方）上，而不是整个标签：
    // 挂到标签上就成了「指针划过文件名 ● 就消失」，不是用户要的行为。
    expect(css, "脏标签的 ● 随「关闭区未命中」出场").toMatch(
      /\.tab-dirty\s+\.tab-action:not\(:hover\)[^{]*\.tab-mark\s*\{[^}]*opacity:\s*1/,
    );
    expect(css, "…指针进关闭区时换出 ×").toMatch(
      /\.tab-action:hover\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "…键盘落到关闭键上同样换出 ×").toMatch(
      /\.tab-action:focus-within\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );

    // 反向：老写法（判据悬挂在 `.tab` 上）不得复活。
    expect(css, "不得再让整个标签的悬停收走 ●").not.toMatch(
      /\.tab-dirty:not\(:hover\)[^{]*\.tab-mark\s*\{/,
    );

    // 「关闭按钮区域」= ● 所在的那个固定槽位：× 必须铺满它，否则指针压在 ● 上
    // 却换不出 ×（或有缝隙时闪回 ●），手感直接错位。
    const layer = cssDecls(ruleBlock(css, ".tab-mark, .tab-close"));
    expect(layer, "× 与 ● 必须共用一个槽位").toMatch(/position:\s*absolute/);
    expect(layer, "槽位必须铺满（inset: 0），否则关闭区与 ● 的位置对不上").toMatch(/inset:\s*0/);
  });
});

describe("Connected 相连标签（B113，对齐 VS Code 1.139）", () => {
  it("底色由 .tab-fill 承载：相邻相连、活动标签与编辑器同色、底边不封口", () => {
    // B113 的关键翻转：底色从 .tab 搬到内层 .tab-fill。
    // 旧药丸方案 =「每颗标签自己上色 + 彼此留 4px 缝」；VS Code 1.139 的 connected =
    // 「一条连续表面 + 活动标签取编辑器背景色、只有上方两角圆、底边敞开与编辑区相连」。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tab = cssDecls(ruleBlock(css, ".tab", undefined, true));
    expect(tab, "应有 .tab 规则").toBeTruthy();
    const h = tab.match(/height:\s*(\d+)px/);
    expect(h, "标签高度必须显式给出（字号档位变化时栏高才恒定）").toBeTruthy();
    expect(
      Number(h![1]),
      "标签高 22px（B334：字号跟标题收到 ui 档 12px 后收一档；VS Code 紧凑档同值）",
    ).toBe(22);
    expect(tab, ".tab 必须是底色层的定位基准").toContain("position: relative");
    // 底色一旦还留在 .tab 上就会盖住 fill 的圆角与描边，connected 的观感直接没了
    expect(tab, "标签自身不得再上底色（底色归 .tab-fill）").not.toMatch(
      /background:\s*var\(--tab-bg/,
    );
    // B376 起非活动文字直接用 VS Code 的 tab.inactiveForeground
    // （深 #9D9D9D / 浅 #616161），不再拿前景色兑 50% 透明 —— 那一版在深色下偏暗，
    // 与 VS Code 实测值差着一档。两档的具体值由 tests/theme-vscode.test.ts 钉住。
    expect(tab, "非活动文字取 tab.inactiveForeground token").toMatch(
      /color:\s*var\(--tab-fg-inactive\)/,
    );

    const fill = cssDecls(ruleBlock(css, ".tab-fill"));
    expect(fill, "应有 .tab-fill 底色层").toBeTruthy();
    expect(fill, "底色层必须绝对定位（才能向上外扩出标签行）").toContain("position: absolute");
    // B123-6：条带 28px（3+22+3，B334 随标签收档），fill 上下各伸 3px 进间隙、直达条带两沿 ——
    // 活动标签与编辑区融合不因下间隙断线（VS Code fill bottom: -gutter 同款）；
    // ⚠️ 断言到分号，防旧值前缀混过
    expect(fill, "左右相连且上下外扩补齐间隙（B123-6）").toMatch(/inset:\s*-3px 0 -3px\s*;/);
    expect(fill, "只有上方两角是圆的（B123-2 起走 --tab-radius 单一来源）").toMatch(
      /border-radius:\s*var\(--tab-radius\) var\(--tab-radius\) 0 0/,
    );
    expect(fill, "底色层不吃鼠标事件（否则点不到标签）").toContain("pointer-events: none");

    const activeFill = cssDecls(ruleBlock(css, ".tab-active .tab-fill"));
    expect(activeFill, "活动标签底色必须收进 --tab-fill-bg 变量（B113-2 变量收口）").toMatch(
      /--tab-fill-bg:\s*var\(--tab-bg-active\)/,
    );
    expect(activeFill, "底色必须引用该变量（而不是直接写死）").toContain(
      "background: var(--tab-fill-bg)",
    );
    // B349（用户点名照 VS Code 相连档）：活动标签要描**帽形轮廓** —— 上 + 左 + 右，
    // 底边不封（开口与编辑区连成一片）。这推翻了 B116「活动标签去描边」：
    // 那次撤的是四周同宽的整圈方框，不是这种带开口的轮廓。
    expect(activeFill, "帽轮廓必须描边（上/左/右）").toMatch(
      /border:\s*var\(--tab-stroke\)\s+solid\s+var\(--tabstrip-border\)/,
    );
    // B351（用户实测「肩部边框线和编辑区的边框线差了一个像素」）：开口必须用
    // **零宽底边框**，不能用 `border-bottom-color: transparent` —— 透明的底边框照样占位，
    // 而肩部伪元素的 `bottom: 0` 锚在 fill 的 **padding box** 底，就被这一格顶上去；
    // 150% 缩放下 1px 边框被 snap 成 0.667 CSS px = 正好一个设备像素 ⇒ 肩线比条带线高一行。
    expect(activeFill, "底边必须零宽：既开口又不占位").toMatch(/border-bottom-width:\s*0\s*;/);
    expect(activeFill, "不许拿透明底边框冒充开口（它占位，会把肩部顶高 1px）").not.toMatch(
      /border-bottom-color:/,
    );
    expect(activeFill, "z-index 必须抬到 1，否则盖不住条带线（线是 0）").toMatch(/z-index:\s*1/);
    expect(activeFill, "外圆角走 --tab-cap-radius（= 内圆角 + 描边厚）").toMatch(
      /border-radius:\s*var\(--tab-cap-radius\) var\(--tab-cap-radius\) 0 0/,
    );
    // 反向对照（防恒真）①：退回「透明底边框冒充开口」（= B351 的那一版）必须被抓到
    const BAD_TRANSPARENT = css.replace(
      "border-bottom-width: 0;",
      "border-bottom-color: transparent;",
    );
    expect(BAD_TRANSPARENT, "替身必须真的换过写法").not.toBe(css);
    const badTransparent = cssDecls(ruleBlock(BAD_TRANSPARENT, ".tab-active .tab-fill"));
    expect(badTransparent, "零宽那一颗消失 ⇒ 判红").not.toMatch(/border-bottom-width:\s*0\s*;/);
    expect(badTransparent, "透明底边框必须被点名").toMatch(/border-bottom-color:/);
    // 反向对照②：把底边整个封上（退回 B116 那种方框）也要被判红
    const BAD_CLOSED = css.replace(
      "border-bottom-width: 0;",
      "border-bottom: var(--tab-stroke) solid var(--tabstrip-border);",
    );
    expect(BAD_CLOSED, "替身必须真的把底边封上了").not.toBe(css);
    expect(
      cssDecls(ruleBlock(BAD_CLOSED, ".tab-active .tab-fill")),
      "封底那一版必须被判红",
    ).not.toMatch(/border-bottom-width:\s*0\s*;/);

    const hoverFill = cssDecls(ruleBlock(css, ".tab:hover:not(.tab-active) .tab-fill"));
    expect(hoverFill, "悬停要有独立一档底色").toContain("var(--tab-bg-hover)");

    // B123（用户裁决，反转 B120）：肩部回归 —— 用户点名「标签下沿要有反向圆弧
    // 肩部（参考vscode）」。实拍用户 VS Code + 源码 connectedEditorTabs.css 双重
    // 确认：肩部 = fill 底部两外侧伪元素的反弧（box-shadow 技巧，半径与顶部
    // 圆角同源 --tab-radius，见下方 B123-2 契约），
    // 构造细节见 global.css 的 B123 注释。仍然禁止的只有「上底色的圆盘构造」
    // （B119 老做法，观感过重）。
    const cssNoComments = stripCssComments(css);
    // B123-2（用户裁决）：肩部反弧半径必须与顶部圆角**同源同值** —— VS Code
    // connectedEditorTabs.css 的变量链 shoulder-radius = cap-radius（同源自
    // cornerRadius-small）。LitePad 用 --tab-radius 单一来源，顶部圆角与肩部
    // 的 width/height/radius/阴影偏移全部引用它，改圆角只动一处。
    const rootBlock = ruleBlock(css, ":root");
    expect(rootBlock, "标签圆角单一来源变量必须在 :root 定义").toContain("--tab-radius: 5px");
    // B349：这条链往下多两环 —— 描边本身占厚度，外圆角 = 内圆角 + 描边，
    // 肩部半径 = 外圆角（VS Code cap-radius = cornerRadius + strokeThickness、
    // shoulder-radius = cap-radius）。判「同一条链」而不是判「数值相等」：
    // 抄一遍 6px 的话改 --tab-radius 就三处不同步。
    expect(rootBlock, "描边粗细也要 token 化（三处引用同一颗）").toContain("--tab-stroke: 1px");
    expect(rootBlock, "外圆角 = 内圆角 + 描边").toContain(
      "--tab-cap-radius: calc(var(--tab-radius) + var(--tab-stroke))",
    );
    expect(rootBlock, "肩部半径 = 外圆角").toContain(
      "--tab-shoulder-radius: var(--tab-cap-radius)",
    );
    // 反向对照：把 shoulder 直接指回 --tab-radius（链断一环）必须被判红
    const BAD_CHAIN = rootBlock.replace(
      "--tab-shoulder-radius: var(--tab-cap-radius)",
      "--tab-shoulder-radius: var(--tab-radius)",
    );
    expect(BAD_CHAIN, "替身必须真的断了一环").toContain("--tab-shoulder-radius: var(--tab-radius)");
    expect(BAD_CHAIN, "断链的替身必须不再满足「肩部 = 外圆角」").not.toContain(
      "--tab-shoulder-radius: var(--tab-cap-radius)",
    );
    const fillBlock = cssDecls(ruleBlock(css, ".tab-fill"));
    expect(fillBlock, "非活动标签的顶部圆角走 --tab-radius（它不描边，用内圆角）").toContain(
      "border-radius: var(--tab-radius) var(--tab-radius) 0 0",
    );
    // ⚠️ 不用 ruleBlock 取肩部群组：首条规则是群组选择器，`::after` 后恰好跟 `{`
    // 会提前命中共享块 —— 直接正则 + 块内特征（left: 100%）锚定独立规则。
    const shoulderGroup =
      css.match(
        /\.tab-active \.tab-fill::before,\s*\.tab-active \.tab-fill::after\s*\{[^}]*\}/,
      )?.[0] ?? "";
    const sg = shoulderGroup.replace(/\s+/g, " ");
    expect(sg, "两肩尺寸走 --tab-shoulder-radius（= 外圆角那条链）").toContain(
      "width: var(--tab-shoulder-radius)",
    );
    // B349：肩上也描轮廓。⚠️ 必须 border-box —— content-box 下 1px 边框把伪元素
    // 撑大一圈，反弧与帽侧边的接缝错位（1.5 倍缩放下表现为肩部多出一小截）。
    expect(sg, "肩部必须 border-box（否则边框把反弧撑偏 1px）").toContain("box-sizing: border-box");
    expect(sg, "肩下沿要接上条带那条线").toContain(
      "border-bottom: var(--tab-stroke) solid var(--tabstrip-border)",
    );
    const shoulderBefore = ruleBlock(css, ".tab-active .tab-fill::before").replace(/\s+/g, " ");
    expect(shoulderBefore, "左肩反弧半径 = 外圆角半径").toContain(
      "border-bottom-right-radius: var(--tab-shoulder-radius)",
    );
    expect(shoulderBefore, "左肩外侧描竖边（VS Code ::before { border-right }）").toContain(
      "border-right: var(--tab-stroke) solid var(--tabstrip-border)",
    );
    expect(shoulderBefore, "左肩阴影偏移 = 半径一半（VS Code R/2 R/2 0 R/2 构造）").toContain(
      "box-shadow: calc(var(--tab-shoulder-radius) / 2)",
    );
    const shoulderAfter = (
      css.match(/\.tab-active \.tab-fill::after\s*\{[^}]*left: 100%[^}]*\}/)?.[0] ?? ""
    ).replace(/\s+/g, " ");
    expect(shoulderAfter, "右肩反弧半径 = 外圆角半径（镜像）").toContain(
      "border-bottom-left-radius: var(--tab-shoulder-radius)",
    );
    expect(shoulderAfter, "右肩外侧描竖边（镜像 border-left）").toContain(
      "border-left: var(--tab-stroke) solid var(--tabstrip-border)",
    );
    expect(shoulderAfter, "右肩阴影偏移镜像为负").toContain(
      "box-shadow: calc(var(--tab-shoulder-radius) / -2)",
    );
    expect(cssNoComments, "肩部不得用上底色的圆盘构造（B119 老做法）").not.toMatch(
      /\.tab-active \.tab-fill::(?:before|after)\s*\{[^}]*background/,
    );

    // B123-3（用户裁决）：贴边顶角不圆 —— 分屏边界处（右侧区域最左标签）
    // 左上角没有圆角，左肩也免（反弧不冲着边界画）。右侧 4px 呼吸位
    // （B113-2）是有意不对称：末标签顶角不在边界上，圆角保留。
    // B349 同一处再加一条：贴边那侧也不描竖边 —— 帽的左边正压在卡片左边框上，
    // 画出来是双线（VS Code `.tab.active:first-child > .tab-fill { border-left-width: 0 }`）。
    const firstFill = cssDecls(ruleBlock(css, ".tab:first-child .tab-fill"));
    expect(firstFill, "首标签（贴边界侧）顶角必须不圆").toContain("border-top-left-radius: 0");
    expect(firstFill, "首标签贴边那侧必须不描竖边").toContain("border-left-width: 0");
    const firstShoulder = cssDecls(ruleBlock(css, ".tab:first-child .tab-fill::before"));
    expect(firstShoulder, "首标签左肩必须免画（VS Code :first-child 同款）").toContain(
      "content: none",
    );
    // 反向验证：贴边那一组回潮（改回圆角 + 补上左边框）必须被咬住。
    // ⚠️ 用正则替身而不是整块字面量 replace —— 块里加了注释就会静默替不中，
    //    于是「替身自证」那条先红，看起来像判据坏了（这一族坑见 pitfalls/）。
    const strippedCss = stripCssComments(css);
    const BAD_EDGE = strippedCss.replace(
      /\.tab:first-child \.tab-fill\s*\{[^}]*\}/,
      ".tab:first-child .tab-fill {\n  border-top-left-radius: var(--tab-radius);\n  border-left-width: var(--tab-stroke);\n}",
    );
    expect(BAD_EDGE, "替身必须真的把贴边那两格改回去了").toContain(
      "border-top-left-radius: var(--tab-radius)",
    );
    expect(() => {
      const bad = cssDecls(ruleBlock(BAD_EDGE, ".tab:first-child .tab-fill"));
      expect(bad, "替身的贴边圆角必须被抓到").toContain("border-top-left-radius: 0");
    }).toThrow();
    expect(() => {
      const bad = cssDecls(ruleBlock(BAD_EDGE, ".tab:first-child .tab-fill"));
      expect(bad, "替身的贴边描边必须被抓到").toContain("border-left-width: 0");
    }).toThrow();

    // 三档底色 + 条带表面色，两套主题都要齐：缺一个就是某主题下某状态完全没反馈
    for (const [name, block] of [
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
    ] as const) {
      expect(block, `${name}主题必须定义 --tab-strip-bg（标签条表面）`).toContain(
        "--tab-strip-bg:",
      );
      for (const v of ["--tab-bg-hover:", "--tab-bg-active:", "--tab-bg-active-hover:"]) {
        expect(block, `${name}主题必须定义 ${v}`).toContain(v);
      }
      // B119：hover 用 VS Code connected 的口径（connectedEditorTabs.css:77）
      expect(block, `${name} hover 必须 color-mix(fg 6%, 条带色)（B119 对齐 VS Code）`).toContain(
        "--tab-bg-hover: color-mix(in srgb, var(--fg) 6%, var(--tab-strip-bg));",
      );
    }
    // B121（最终形态）：活动标签 = 编辑器底色，与编辑区融为一体。
    // B376 起两套主题都取 var(--bg)：源码底色换成了 VS Code 的 editor.background
    // （深 #1f1f1f / 浅 #ffffff），这条「同源」判据不再依赖 One Dark 的具体色值 ——
    // 改主题时只要两边都跟 --bg 走，活动标签就不会和编辑区裂开。
    for (const [name, block] of [
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
    ] as const) {
      expect(block, `${name}活动标签必须同编辑器底色（var(--bg)，B121/B376）`).toContain(
        "--tab-bg-active: var(--bg);",
      );
    }
    // B349：条带下沿那条线由 `.panel-head::after` 一条通铺（标签段 + ops 段一起盖住），
    // 所以 ops 段**自己**不许再有 border-bottom —— 两处画同一条线就是 2px。
    const ops = cssDecls(ruleBlock(css, ".panel-ops"));
    expect(ops, "ops 段不得再有 border-bottom（线由 head::after 通铺）").not.toContain(
      "border-bottom",
    );
    // ⚠️ 这条线必须画在 head 盒**内**（::after + bottom:0），不能用 border-bottom：
    //    border 在盒外，被条带 overflow 裁掉的舌片够不着，「活动帽盖出开口」就做
    //    不出来 —— B121 当年踩的就是这个，判据把它钉住。
    // ⚠️ atLineStart：pill 档那条覆盖（`:root[data-tab-style="pill"] .panel-head::after`）
    //    在文件里排在前面，不带这个参数取到的是它、不是基础规则。
    const headLine = cssDecls(ruleBlock(css, ".panel-head::after", undefined, true));
    expect(headLine, "条带下沿必须有那条横贯线（B349，参考 VS Code 相连档）").toBeTruthy();
    expect(headLine, "线坐在 head 盒内的底缘").toMatch(/position:\s*absolute/);
    expect(headLine, "线坐在 head 盒内的底缘（bottom:0）").toMatch(/bottom:\s*0/);
    expect(headLine, "线厚 = 帽的描边厚（同一颗 token，别各写一个 1px）").toMatch(
      /height:\s*var\(--tab-stroke\)/,
    );
    expect(headLine, "线与帽轮廓同色（tabsBorder）").toMatch(
      /background:\s*var\(--tabstrip-border\)/,
    );
    expect(headLine, "线必须在帽之下（帽 z-index 1 才盖得出开口）").toMatch(/z-index:\s*0/);
    expect(headLine, "线不吃鼠标事件（它压在标签热区下沿）").toMatch(/pointer-events:\s*none/);
    expect(
      cssDecls(ruleBlock(css, ".panel-head", undefined, true)),
      "head 必须是定位基准，否则 ::after 会飘到祖先盒上",
    ).toMatch(/position:\s*relative/);
    // 反向对照：把线挪回盒外（border-bottom 那一手）⇒ ::after 那条规则就没了，判据必须抓走
    const headLineBlocks = (src: string): number =>
      (src.match(/\.panel-head::after\s*\{[\s\S]*?\n\}/g) ?? []).length;
    expect(headLineBlocks(css), "源里应有两条 `.panel-head::after`（基础画线 + pill 撤线）").toBe(
      2,
    );
    const BAD_OUTER = css.replace(/\.panel-head::after\s*\{[\s\S]*?\n\}/g, "");
    expect(headLineBlocks(BAD_OUTER), "替身必须真的把两条都摘掉").toBe(0);
    expect(
      ruleBlock(BAD_OUTER, ".panel-head::after", undefined, true),
      "摘掉后必须取不到规则",
    ).toBe("");
    // 这条线只属于相连档：药丸是浮在条带上的胶囊，没有与编辑区衔接的开口可盖
    expect(
      cssDecls(ruleBlock(css, ':root[data-tab-style="pill"] .panel-head::after')),
      "pill 档必须把这条线撤掉（否则胶囊行下多一道硬边）",
    ).toMatch(/content:\s*none/);
    // B123：分屏分隔条静息恢复 --sep-line 细线、外框上移为大卡片 —— 契约见
    // 「编辑区大卡片外框（B123）」一节。

    // B116：闪烁效果整体移除（用户要求）——CSS 与 TS 两侧都不得再有 tab-flash 痕迹
    // （stripCssComments 剥掉说明性注释后断言，避免被「移除记录」误伤）
    const cssCode = stripCssComments(css);
    expect(cssCode, "CSS 不得再有任何 tab-flash 规则或关键帧").not.toContain("tab-flash");
    // 自定义属性动画要有平滑插值，必须先注册成 <color>（悬停提亮仍依赖它）
    expect(css, "--tab-fill-bg 必须注册成 color 类型").toMatch(
      /@property --tab-fill-bg\s*\{[^}]*syntax:\s*"<color>"/,
    );
    // B119：connected 档活动标签悬停**不再提亮**（VS Code 的 hover fill 规则全带
    // :not(.active)，活动标签悬停只亮关闭按钮）；pill 档保留提亮（activeHoverBackground）
    expect(cssCode, "connected 档不得再有独立的活动标签悬停提亮规则").not.toMatch(
      /\}\s*\.tab-active:hover \.tab-fill\s*\{/,
    );
    expect(cssCode, "pill 档保留悬停提亮（VS Code activeHoverBackground 同款）").toContain(
      ':root[data-tab-style="pill"] .tab-active:hover .tab-fill',
    );

    // DOM 侧：CSS 写了但没渲染这个元素，标签就是全透明一片
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "必须渲染 .tab-fill 元素").toContain('className = "tab-fill"');
    expect(ts, "fill 必须排在内容之前（内容靠 z-index 浮在它上面）").toContain(
      "el.append(fill, icon, name, action)",
    );
  });
  it("B117：底部不再预留滚动条空间（条带 28px），插入线贯穿整条标签带（B309）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = ruleBlock(css, ".panel-tabstrip", undefined, true);
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    // B113：connected 标签**相连**，不再靠 gap 撑缝（缝会让 fill 接不上，
    // 活动标签与编辑器之间就出现断口）；分隔感改由活动标签的凸起给出。
    expect(strip, "标签必须相连（gap 0），不能留缝隙").toMatch(/gap:\s*0/);
    // B122 曾把条带下沿的渐变细线整个撤掉；B349 按用户点名的 VS Code 相连档把线补回，
    // 但**不补回渐变**（线是 `.panel-head::after` 的一格实色，见上一节判据）。
    expect(strip, "条带表面必须是纯底色").toContain("background: var(--tab-strip-bg)");
    expect(strip, "条带自己不许画底部细线（线在 head 的 ::after 上，通铺到 ops 段）").not.toContain(
      "linear-gradient",
    );
    expect(
      strip,
      "内边距：上 3 / 右 4 / 下 0 / 左 0（B113-2：左侧不留白；B123-6 上间距 3px）",
    ).toMatch(/padding:\s*3px 4px 0 0/);

    // B123-6：条带统一 28px = 3(上) + 22(标签) + 3(下间隙=thumb 高度)（B334 随标签收档），
    // 两档同高切档不抖；connected 的 fill 用 inset -3px 0 -3px 伸进上下间隙。
    const tabH = Number(
      cssDecls(ruleBlock(css, ".tab", undefined, true)).match(/height:\s*(\d+)px/)![1],
    );
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    expect(stripH, "条带统一 28px（B123-6 / B334）").toBe(28);
    expect(stripH - tabH, "上下间隙共 6px（3+3 对称）").toBe(6);
    expect(css, "原生 webkit 滚动条规则必须整体删除").not.toMatch(
      /\.panel-tabstrip::-webkit-scrollbar/,
    );

    // 拖拽插入线必须**贯穿整条标签带**：connected 档的 `.tab-fill` 是 `inset: -3px 0 -3px`，
    // 上下那 6px 间隙都被填成标签底色 ⇒ 线从 3px 起就比标签带短一截，用户读作
    // 「线偏下、上面缺一小段」（B309）。pill 档相反：胶囊只占中间 22px，线跟着内缩。
    // ⚠️ 锚定基础块一律用 `ruleBlock(..., atLineStart)`：pill 覆盖块的选择器尾段也是
    //   `.tab-insert`，裸正则 `\.tab-insert\s*\{` 会命中它（B123-5 那次靠「带 top:3px
    //   特征」绕过，这一版两档都有 top ⇒ 那个绕法自己就失效了）。
    const insert = ruleBlock(css, ".tab-insert", undefined, true);
    expect(insert, "基础块（connected 档）必须贯穿条带上下沿").toMatch(/top:\s*0/);
    expect(insert).toMatch(/bottom:\s*0/);
    const pillInsert = ruleBlock(css, ':root[data-tab-style="pill"] .tab-insert');
    expect(pillInsert, "pill 档的线只贯穿胶囊行（上下 3px 是空白）").toMatch(/top:\s*3px/);
    expect(pillInsert).toMatch(/bottom:\s*3px/);
  });
  it("B116 闪烁效果整体移除：CSS 无 tab-flash 规则、TS 无 flashTab（含反向验证）", () => {
    // B47 引入的「切换后闪一次」被用户要求整体移除（B116）。
    // 守卫断言两侧源码都不得再有 tab-flash / flashTab 痕迹：
    // CSS 侧剥块注释（移除记录里提到它没关系），TS 侧剥整行注释（B79 教训）。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const cssCode = stripCssComments(css);
    expect(cssCode, "CSS 不得再有 tab-flash 关键帧或规则").not.toContain("tab-flash");
    expect(cssCode, "不得残留 animation: 挂载（tab-flash 系动画全删）").not.toMatch(
      /animation:\s*tab-flash/,
    );

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const tsCode = stripLineComments(ts);
    expect(tsCode, "tabstrip.ts 不得再有 flashTab 函数/调用").not.toContain("flashTab");
    expect(tsCode, "不得再给标签挂 tab-flash 类").not.toContain('classList.add("tab-flash")');

    // 反向验证：退化替身（把 flashTab 调用与 tab-flash keyframes 塞回去）必须被咬住，
    // 证明这些 not 断言不是「怎么写都能过」的恒真假绿。
    const BAD_TS = tsCode + "\n  if (entry.lastActiveId >= 0) flashTab(els[activeIdx]);\n";
    expect(BAD_TS, "退化替身必须含 flashTab").toContain("flashTab");
    expect(() => {
      expect(stripLineComments(BAD_TS), "替身里 flashTab 必须被抓到").not.toContain("flashTab");
    }).toThrow();
    const BAD_CSS = cssCode + "\n@keyframes tab-flash {\n  0% { --tab-fill-bg: red; }\n}\n";
    expect(() => {
      expect(stripCssComments(BAD_CSS), "替身里 tab-flash 必须被抓到").not.toContain("tab-flash");
    }).toThrow();
  });
  it("B120 反向验证：肩部回潮（实色圆盘 / box-shadow 补色）与提亮回潮必须被咬住", () => {
    // 退化替身把 B120 删除的两种肩部构造与提亮规则塞回去，证明契约不是恒真假绿。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const cssCode = stripCssComments(css);

    // ① 实色四分之一圆回潮（B119 构造，观感强于 VS Code，随 B120 删除）
    const BAD_DISC =
      cssCode + "\n.tab-active .tab-fill::before {\n  background: var(--tab-fill-bg);\n}\n";
    expect(() => {
      expect(stripCssComments(BAD_DISC), "替身的实色肩部必须被抓到").not.toMatch(
        /\.tab-active \.tab-fill::(?:before|after)\s*\{[^}]*background/,
      );
    }).toThrow();

    // ② B123 反转：box-shadow 反弧从「禁止」变为「必须存在」——退化替身把
    //    肩部阴影整个摘掉（回到 B120 的直线侧边），正向契约必须咬住
    const BAD_NO_SHOULDER = cssCode.replace(
      /box-shadow: calc\(var\(--tab-shoulder-radius\)[^;]*;/g,
      "",
    );
    expect(BAD_NO_SHOULDER, "替身必须真的摘掉了肩部阴影").not.toBe(cssCode);
    expect(() => {
      expect(stripCssComments(BAD_NO_SHOULDER), "摘掉肩部的替身必须被咬住").toMatch(
        /\.tab-active \.tab-fill::before\s*\{[^}]*box-shadow/,
      );
    }).toThrow();

    // ③ 悬停提亮回潮：connected 档出现独立的活动标签悬停提亮规则
    const BAD_HOVER = cssCode + "\n.tab-active:hover .tab-fill { --tab-fill-bg: red; }\n";
    expect(() => {
      expect(stripCssComments(BAD_HOVER), "替身的提亮规则必须被抓到").not.toMatch(
        /\}\s*\.tab-active:hover \.tab-fill\s*\{/,
      );
    }).toThrow();
  });
});

describe("标签样式切换（B114：connected | pill）", () => {
  // 契约集中成一个判定函数：正向用例断言真实样式零违规；
  // 反向验证把「退化替身 CSS」（照抄 connected 的错误写法）喂给同一个函数，
  // 断言它被咬住 —— 证明这些断言不是「怎么写都能过」的恒真假绿。
  function pillViolations(css: string): string[] {
    const v: string[] = [];
    const get = (sel: string, filter?: string) => cssDecls(ruleBlock(css, sel, filter));
    if (!get(':root[data-tab-style="pill"]').includes("--tab-bg-active: #2b2f34"))
      v.push("深色档必须覆盖活动底色（#2b2f34，不再是编辑器背景）");
    if (
      !get(':root[data-tab-style="pill"][data-theme="light"]').includes("--tab-bg-active: #ffffff")
    )
      v.push("浅色档必须另设活动底色（纯白）");
    const fill = get(':root[data-tab-style="pill"] .tab-fill');
    if (!fill.includes("inset: 0")) v.push("pill 的 fill 必须收回标签框内（inset: 0）");
    if (!fill.includes("border-radius: 4px")) v.push("pill 四角都是圆的（border-radius: 4px）");
    if (!get(':root[data-tab-style="pill"] .tab-active .tab-fill').includes("border: none"))
      v.push("pill 活动标签必须无边框（B55：只靠底色区分）");
    if (
      !get(':root[data-tab-style="pill"] .tab-active .tab-fill::before').includes("content: none")
    )
      v.push("pill 必须撤掉肩部（胶囊没有舌片）");
    const strip = get(':root[data-tab-style="pill"] .panel-tabstrip');
    if (!strip.includes("gap: 4px")) v.push("pill 恢复胶囊之间的 4px 缝隙");
    // B123-6：条带高度统一 28px（基础规则），pill 只覆盖 padding —— 上下 3px
    // 对称（= thumb 高度），左右 4px（B55 胶囊呼吸位）。
    // ⚠️ padding 断言到分号：connected 的 "3px 4px 0 0" 是 "3px 4px" 的超集，
    //   前缀 includes 会混过去；必须精确匹配两值形态。
    if (!/padding:\s*3px 4px\s*;/.test(strip)) v.push("pill 条带留白上下 3px / 左右 4px");
    if (/height:\s*\d+px/.test(strip)) v.push("pill 不得覆盖条带高度（统一 28px，B123-6）");
    const pillInsertSel = ':root[data-tab-style="pill"] .tab-insert';
    if (!get(pillInsertSel).includes("bottom: 3px"))
      v.push("pill 插入线只贯穿胶囊行（bottom: 3px）");
    if (!get(pillInsertSel).includes("top: 3px")) v.push("pill 插入线不许吃掉上间隙（top: 3px）");
    return v;
  }

  it("pill 档 CSS 契约：胶囊化 + 撤肩部描边 + 恢复缝隙（真实样式零违规）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(pillViolations(css), "真实样式违反 pill 契约的条目").toEqual([]);
  });

  it("反向验证：退化替身（connected 写法混进 pill 块）必须被咬住（防恒真）", () => {
    // 替身 = 照抄 connected 的值冒充 pill 覆盖块：fill 外扩、只有上角圆、带描边、
    // 无缝、不撤肩部、活动底色不变。退化用例先自证「替身确实跑了」（咬住的条目非空
    // 且点名具体条目），再证明正向用例不恒真 —— 两者结果必须不同。
    const BAD_PILL = `
:root[data-tab-style="pill"] { --tab-bg-active: var(--bg); }
:root[data-tab-style="pill"] .tab-fill { inset: -4px 0 -4px; border-radius: 5px 5px 0 0; }
:root[data-tab-style="pill"] .tab-active .tab-fill { border: 1px solid var(--border); }
:root[data-tab-style="pill"] .panel-tabstrip { gap: 0; padding: 4px 4px 0 0; }
`;
    const v = pillViolations(BAD_PILL);
    expect(v.length, "退化替身必须至少被咬住一条").toBeGreaterThan(0);
    expect(v, "替身的具体违规要被点名（自证判定函数真的在比对）").toEqual([
      "深色档必须覆盖活动底色（#2b2f34，不再是编辑器背景）",
      "浅色档必须另设活动底色（纯白）",
      "pill 的 fill 必须收回标签框内（inset: 0）",
      "pill 四角都是圆的（border-radius: 4px）",
      "pill 活动标签必须无边框（B55：只靠底色区分）",
      "pill 必须撤掉肩部（胶囊没有舌片）",
      "pill 恢复胶囊之间的 4px 缝隙",
      "pill 条带留白上下 3px / 左右 4px",
      "pill 插入线只贯穿胶囊行（bottom: 3px）",
      "pill 插入线不许吃掉上间隙（top: 3px）",
    ]);
  });

  it("设置页与主流程接线：外观分类有「标签样式」下拉，切换立即生效并持久化", () => {
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    expect(dlg, "选项接口必须有 tabStyle/onTabStyle").toContain("tabStyle: () => string");
    expect(dlg).toContain("onTabStyle: (style: string) => void");
    expect(dlg, "外观页必须有「标签样式」下拉").toContain('"标签样式"');
    expect(dlg, "必须提供 connected 档").toContain('value: "connected"');
    expect(dlg, "必须提供 pill 档").toContain('value: "pill"');

    // main.ts：断言必须落在代码上（说明性注释里会复述这些标识符 —— B79 的教训）
    const src = stripLineComments(
      readFileSync("src/main.ts", "utf-8") +
        "\n" +
        readFileSync("src/prefs.ts", "utf-8") +
        "\n" +
        tabsAll(),
    );
    const appearance = stripLineComments(readFileSync("src/appearance.ts", "utf-8"));
    expect(appearance, "档位必须写进 html[data-tab-style]").toContain("dataset.tabStyle");
    expect(appearance, "未知值必须回落 connected（与 Rust 回落一致）").toContain(
      'style === "pill" ? "pill" : "connected"',
    );
    expect(src, "切换必须写回 settings 才能存盘（B79 同款教训）").toMatch(
      /settings\.tab_style\s*=/,
    );
    expect(src, "启动时必须应用，否则重启样式回退").toContain(
      'applyTabStyle(settings?.tab_style ?? "connected")',
    );
    expect(src, "设置对话框必须接线 onTabStyle").toContain(
      "onTabStyle: (v) => void setTabStyle(v)",
    );
    expect(src, "设置对话框必须接线 tabStyle 取值").toContain(
      'tabStyle: () => settings?.tab_style ?? "connected"',
    );
  });
});

describe("标签操作槽位空位（B115：预留 | 紧凑，对齐 VS Code tabActionReserveSpace）", () => {
  // 同 B114 的反向验证模式：契约集中成判定函数，正向断言真实样式零违规，
  // 反向验证喂退化替身断言被咬住（证明断言不是恒真假绿）。
  function reserveViolations(css: string): string[] {
    const v: string[] = [];
    const get = (sel: string, filter?: string) => cssDecls(ruleBlock(css, sel, filter));
    const compactAction = get(':root[data-tab-reserve="off"] .tab:not(.tab-dirty) .tab-action');
    // 紧凑档：干净标签的槽位必须脱流（文字收紧、悬停浮出不引起布局跳动）
    if (!compactAction.includes("position: absolute"))
      v.push("紧凑档干净标签的槽位必须脱流（position: absolute）");
    if (!compactAction.includes("top: 2px") || !compactAction.includes("right: 2px"))
      v.push("紧凑档浮层槽位必须钉在标签右上（top/right 2px）");
    // 紧凑档：活动干净标签常驻 × 必须收回（预留档的 20px 空位没了，常驻会压文字）
    if (
      !get(':root[data-tab-reserve="off"] .tab-active:not(.tab-dirty) .tab-close').includes(
        "opacity: 0",
      )
    )
      v.push("紧凑档活动干净标签不得常驻 ×（悬停才显示）");
    if (
      !get(':root[data-tab-reserve="off"] .tab-active:not(.tab-dirty):hover .tab-close').includes(
        "opacity: 1",
      )
    )
      v.push("紧凑档悬停干净的活动标签仍要能显示 ×");
    // 常驻指示器恒预留：● 的槽位规则不得被紧凑档波及（选择器必须带 :not(.tab-dirty)）
    // ⚠️ filter="width"：紧凑覆盖块的选择器尾段也是 .tab-action 且在文件更前面，
    //   不加 filter 会抓到覆盖块（0075 尾段命中坑，B115 自己踩了一回）。
    const action = cssDecls(ruleBlock(css, ".tab-action", "width"));
    if (!action.includes("width: 20px"))
      v.push("预留档（默认）槽位必须恒定 20px（B57 红线：显隐不得改变标签宽度）");
    return v;
  }

  it("紧凑档 CSS 契约：干净标签槽位脱流 + 常驻 × 收回（真实样式零违规）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(reserveViolations(css), "真实样式违反紧凑档契约的条目").toEqual([]);
  });

  it("反向验证：退化替身（删光紧凑档覆盖 / 波及脏标签）必须被咬住（防恒真）", () => {
    // 替身 A = 紧凑档覆盖块整体缺失（等于「设了开关没效果」的退化实现）
    const css = readFileSync("src/styles/global.css", "utf-8");
    const withoutCompact = css.replace(/:root\[data-tab-reserve="off"\][^{]*\{[^}]*\}/g, "");
    const vA = reserveViolations(withoutCompact);
    expect(vA.length, "替身 A（覆盖块缺失）必须至少被咬住一条").toBeGreaterThan(0);
    expect(vA, "替身 A 必须咬住「槽位脱流」与「常驻 × 收回」两条").toContain(
      "紧凑档干净标签的槽位必须脱流（position: absolute）",
    );
    expect(vA).toContain("紧凑档活动干净标签不得常驻 ×（悬停才显示）");

    // 替身 B = 紧凑档选择器漏掉 :not(.tab-dirty)（波及 ● 常驻指示器的退化实现）
    const leakingToDirty = css.replace(
      ':root[data-tab-reserve="off"] .tab:not(.tab-dirty) .tab-action',
      ':root[data-tab-reserve="off"] .tab .tab-action',
    );
    expect(
      reserveViolations(leakingToDirty),
      "替身 B（波及脏标签）不该触发槽位脱流的断言 —— 该断言锚定的是干净标签",
    ).toContain("紧凑档干净标签的槽位必须脱流（position: absolute）");
  });

  it("设置页与主流程接线：外观分类有「标签按钮预留空位」开关，切换立即生效并持久化", () => {
    const dlg = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    expect(dlg, "选项接口必须有 tabActionReserveSpace/onTabActionReserveSpace").toContain(
      "tabActionReserveSpace: () => boolean",
    );
    expect(dlg, "外观页必须有「标签按钮预留空位」开关").toContain('"标签按钮预留空位"');

    const src = stripLineComments(
      readFileSync("src/main.ts", "utf-8") +
        "\n" +
        readFileSync("src/prefs.ts", "utf-8") +
        "\n" +
        tabsAll(),
    );
    const appearance = stripLineComments(readFileSync("src/appearance.ts", "utf-8"));
    expect(appearance, "档位必须写进 html[data-tab-reserve]").toContain("dataset.tabReserve");
    expect(src, "切换必须写回 settings 才能存盘（B79 同款教训）").toMatch(
      /settings\.tab_action_reserve_space\s*=/,
    );
    expect(src, "启动时必须应用，否则重启回退").toContain(
      "applyTabActionReserve(settings?.tab_action_reserve_space ?? true)",
    );
    expect(src, "设置对话框必须接线 onTabActionReserveSpace").toContain(
      "onTabActionReserveSpace: (v) => void setTabActionReserve(v)",
    );
  });
});

describe("面板头部与标签条同色（B113-4）", () => {
  it("panel-head 必须跟随条带色，右侧关闭按钮区不得再透出旧色", () => {
    // 用户实测：tab 条右边 .panel-ops（移除分屏 ⨯）背景色与标签条不一致。
    // 根因 = B113 给 .panel-tabstrip 换了条带色（--tab-strip-bg），
    // 外层 .panel-head 还停在旧的 --bg-status，ops 无背景声明就透出旧色。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const head = cssDecls(ruleBlock(css, ".panel-head"));
    expect(head, "应有 .panel-head 规则").toBeTruthy();
    expect(head, "头部必须整体用条带色（ops 透出它即与标签条同色）").toContain(
      "background: var(--tab-strip-bg)",
    );
    expect(head, "不得再回退到 --bg-status（那是色差的来源）").not.toContain(
      "background: var(--bg-status)",
    );
    // B121：头部不再自带 border-bottom —— 细线移进条带背景（可被舌片盖住），
    // head 的 border 会在条带下方再画一根盖不掉的线，破坏「活动标签下无边框」
    expect(head, "头部不得再画 border-bottom（细线已移入条带背景，B121）").not.toContain(
      "border-bottom",
    );

    // 反向验证：把 head 改回旧色（复刻色差的退化实现），断言必须转红
    const regressed = css.replace(
      "background: var(--tab-strip-bg);",
      "background: var(--bg-status);",
    );
    expect(regressed, "替身必须真的替换过（否则反向验证空转）").not.toBe(css);
    const bad = cssDecls(ruleBlock(regressed, ".panel-head"));
    expect(bad, "退化替身应含旧色").toContain("background: var(--bg-status)");
    expect(bad, "退化替身不再满足条带色契约").not.toContain("background: var(--tab-strip-bg)");
  });
});

describe("紧凑档悬浮 × 的渐变垫底（B118，对齐 VS Code）", () => {
  it("悬停/聚焦时 × 左侧铺透明→标签底色软垫，文字尾部渐隐不硬叠", () => {
    // 用户实测：紧凑档（不预留空位）悬停标签时 × 直接叠在文件名上。
    // VS Code 紧凑档的做法 = .tab-actions::before 铺一块渐变垫
    // （transparent → 标签底色），文字尾部渐隐后再浮出 ×。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const pad = cssDecls(ruleBlock(css, ".tab-action::before", "pointer-events"));
    expect(pad, "应有 × 垫底伪元素").toBeTruthy();
    // B124：垫必须盖住 × 槽位本身（旧写法只垫左侧 → 字形底下透出文字）
    expect(pad, "垫的右缘必须贴住 × 槽位右缘").toContain("right: 0");
    expect(pad, "垫默认隐藏（随 × 一起淡入）").toMatch(/opacity:\s*0/);
    expect(pad, "不得拦截鼠标（否则挡标签点击）").toContain("pointer-events: none");
    // 垫必须比槽位宽：多出来的部分才是左侧渐隐坡道，窄了文字就压在 × 底下
    const px = (s: string, re: RegExp) => Number(s.match(re)?.[1] ?? 0);
    const padW = px(pad, /width:\s*(\d+(?:\.\d+)?)px/);
    // ⚠️ 必须带 "width" 过滤：文件里还有
    //    `:root[data-tab-reserve="off"] … .tab-action {` 那条脱流规则，
    //    它同字符串且排在前面，不过滤会读到它（里面没有 width）
    const slotW = px(
      cssDecls(ruleBlock(css, ".tab-action", "width: 20px")),
      /width:\s*(\d+(?:\.\d+)?)px/,
    );
    expect(slotW, ".tab-action 槽位宽度必须读到").toBeGreaterThan(0);
    expect(padW, `垫宽 ${padW}px 必须盖得住 ${slotW}px 槽位 + 坡道`).toBeGreaterThanOrEqual(
      slotW + 14,
    );

    // ⚠️ prettier 会把长选择器折成多行，ruleBlock 的字面量匹配会失配 ——
    //   一律用 filter（块体特征声明）取目标规则，对折行鲁棒。
    const show = cssDecls(ruleBlock(css, ".tab-action::before", "opacity: 1"));
    expect(show, "悬停/聚焦时垫必须淡入").toMatch(/opacity:\s*1/);
    // 选择器不在块体里，对整份 CSS 断言（B118 块内 hover + focus-within 两个出场口）
    expect(css, "淡入必须覆盖悬停").toMatch(
      /:root\[data-tab-reserve="off"\][^{]*\.tab:not\(\.tab-dirty\):hover \.tab-action::before/,
    );
    expect(css, "淡入必须覆盖键盘聚焦").toContain(".tab-action:focus-within::before");

    // B119 起 --tab-bg-hover 是 color-mix 不透明色：单层渐变即可盖住文字尾部。
    // B124-2：渐变必须在**坡道末端就到实色**（<色> <坡道宽>px）—— 没有这个停靠点时
    // 渐变会把整段（含 × 槽位）铺满，槽位左半只有 ~40% 不透明，文字照样透出来。
    const rampStop = (s: string, color: string) =>
      Number(
        s.match(
          new RegExp(
            `linear-gradient\\(to right, transparent, ${color.replace(/[().-]/g, "\\$&")}\\s+(\\d+(?:\\.\\d+)?)px\\)`,
          ),
        )?.[1] ?? -1,
      );
    const dimPad = cssDecls(ruleBlock(css, ".tab-action::before", "var(--tab-bg-hover)"));
    expect(dimPad, "非活动垫 = 渐变到悬停底色（单层，B119 起悬停色不透明）").toMatch(
      /linear-gradient\(to right, transparent, var\(--tab-bg-hover\)/,
    );
    // 活动垫 = 渐变到活动 fill 同色（B119 对齐 VS Code action-active-hover-background = surface；
    // ⚠️ filter 用带停靠点的 var(--tab-bg-active) 14px)，否则会被 pill 垫的
    //    active-hover 超集混过（它同样是 var(--tab-bg-active…) 的前缀）
    const activePad = cssDecls(ruleBlock(css, ".tab-action::before", "var(--tab-bg-active) 14px"));
    expect(activePad, "活动垫用单层渐变到活动 fill 同色（connected 悬停不提亮）").toMatch(
      /linear-gradient\(to right, transparent, var\(--tab-bg-active\)/,
    );
    // pill 档悬停仍提亮一档 → 垫色跟着提（覆盖块）
    const pillPad = cssDecls(ruleBlock(css, ".tab-action::before", "var(--tab-bg-active-hover)"));
    expect(pillPad, "pill 档活动垫跟随提亮后的 fill").toMatch(
      /linear-gradient\(to right, transparent, var\(--tab-bg-active-hover\)/,
    );

    // 三条垫的**实色停靠点**必须落在坡道末端、不得侵入 × 槽位（槽内全程实色）
    const ramp = padW - slotW;
    for (const [name, block, color] of [
      ["非活动垫", dimPad, "var(--tab-bg-hover)"],
      ["活动垫", activePad, "var(--tab-bg-active)"],
      ["pill 活动垫", pillPad, "var(--tab-bg-active-hover)"],
    ] as const) {
      const stop = rampStop(block, color);
      expect(stop, `${name} 必须有「坡道末端到实色」的停靠点（槽内全不透明）`).toBeGreaterThan(0);
      expect(stop, `${name} 的坡道末端不得越过槽位左缘（坡道 ${ramp}px）`).toBeLessThanOrEqual(
        ramp,
      );
    }

    // 反向验证：删光垫块后契约必须咬住（防恒真）
    const withoutPad = css.replace(
      /:root\[data-tab-reserve="off"\][^{]*\.tab-action::before[^{]*\{[^}]*\}/g,
      "",
    );
    expect(
      cssDecls(ruleBlock(withoutPad, ".tab-action::before", "pointer-events")),
      "删光垫块后应提取不到垫规则",
    ).toBe("");
    expect(
      cssDecls(ruleBlock(withoutPad, ".panel-tabstrip")),
      "替身自证：无关规则不受影响",
    ).toBeTruthy();

    // 反向验证：垫退回「只垫槽位左边」（B124 的病）必须被咬住
    const OLD_PAD = css.replace(
      /:root\[data-tab-reserve="off"\][^{]*\.tab-action::before[^{]*\{[^}]*\}/,
      (m) => m.replace("right: 0;", "right: 100%;").replace("width: 34px;", "width: 14px;"),
    );
    expect(OLD_PAD, "替身必须真的退回旧写法").not.toBe(css);
    expect(
      cssDecls(ruleBlock(OLD_PAD, ".tab-action::before", "pointer-events")),
      "替身的垫必须被判为没盖住槽位",
    ).not.toContain("right: 0");

    // 反向验证：去掉「坡道末端到实色」的停靠点（B124-2 的病：渐变铺满整段、
    // 槽位左半只有 ~40% 不透明）必须被咬住
    const NO_STOP = css.replace(/ 14px\)/g, ")");
    expect(NO_STOP, "替身必须真的去掉了停靠点").not.toBe(css);
    expect(NO_STOP, "替身自证：渐变退回老写法（无停靠点）").toContain(
      "linear-gradient(to right, transparent, var(--tab-bg-hover))",
    );
    const badBlock = cssDecls(ruleBlock(NO_STOP, ".tab-action::before", "var(--tab-bg-hover)"));
    expect(/var\(--tab-bg-hover\)\s+\d+px\)/.test(badBlock), "替身缺失的实色停靠点必须被抓到").toBe(
      false,
    );
  });
});

describe("非焦点面板里活动标签的 × 与垫色（B124-3）", () => {
  it("紧凑档必须收回「非焦点面板活动标签常驻 ×」，且悬停/聚焦两个口都留着", () => {
    // 病：`.layout-panel:not(.layout-panel-active) .tab-active .tab-close{opacity:.5}`
    //     与紧凑档「活动标签 × 只在悬停出现」特异度相同（都是 0,5,0）、排在后面 ⇒ 赢。
    //     于是非焦点面板的活动标签常驻一个 50% 的 ×，而垫底只在悬停/聚焦淡入 ——
    //     不悬停时 × 就是裸压在文件名上（B124 同款）。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const retractRule = (src: string) =>
      src.match(
        /:root\[data-tab-reserve="off"\][\s\S]{0,200}?\.layout-panel:not\(\.layout-panel-active\)[\s\S]{0,200}?\.tab-close\s*\{[^}]*\}/,
      )?.[0] ?? null;
    const r = retractRule(css);
    expect(r, "紧凑档必须有收回非焦点常驻 × 的规则").toBeTruthy();
    expect(r, "收回必须带 opacity: 0").toMatch(/opacity:\s*0/);
    // ⚠️ 两个出场口都要留：漏 :focus-within 会让键盘 Tab 到关闭键时 × 隐形
    expect(r, "收回必须豁免悬停").toContain(":not(:hover)");
    expect(r, "收回必须豁免键盘聚焦").toContain(":not(:focus-within)");

    // 悬停/聚焦时仍要暗一档（0.5）：紧凑档那条 hover 规则特异度更高会把它压掉
    const dim = css.match(
      /:root\[data-tab-reserve="off"\][\s\S]{0,200}?\.layout-panel:not\(\.layout-panel-active\)[\s\S]{0,200}?\.tab-active:not\(\.tab-dirty\):hover\s+\.tab-close\s*\{[^}]*\}/,
    )?.[0];
    expect(dim, "非焦点面板的活动标签悬停时 × 必须暗一档").toBeTruthy();
    expect(dim, "降档值仍是 0.5（与焦点面板的 1 形成对比）").toMatch(/opacity:\s*0\.5/);

    // 反向验证：去掉悬停/聚焦豁免（收回变成无条件）必须被咬住
    const BAD = css.replace(/:not\(:hover\):not\(:focus-within\)/g, "");
    expect(BAD, "替身必须真的去掉了豁免").not.toBe(css);
    const bad = retractRule(BAD);
    expect(bad, "替身仍能取到收回规则（内容变了，不是取不到）").toBeTruthy();
    expect(bad, "替身缺失的悬停/聚焦豁免必须被抓到（否则键盘够不到 ×）").not.toContain(
      ":not(:hover)",
    );
  });

  it("非焦点面板活动标签的垫色跟随 fill 降档（connected=hover 档，pill=悬停提亮档）", () => {
    // 非焦点面板里活动标签的 fill 已被降到 --tab-bg-hover（见
    // .layout-panel:not(.layout-panel-active) .tab-active .tab-fill），
    // 垫色必须跟着降，否则垫是一块比标签底色亮的补丁。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const pads = [
      ...css.matchAll(
        /\.layout-panel:not\(\.layout-panel-active\)[\s\S]{0,200}?\.tab-action::before\s*\{[^}]*\}/g,
      ),
    ].map((m) => m[0]);
    expect(pads.length, "非焦点面板的活动垫应有 connected / pill 两条").toBe(2);
    expect(pads[0], "connected 非焦点垫跟随降档后的 fill（--tab-bg-hover）").toContain(
      "var(--tab-bg-hover) 14px",
    );
    expect(pads[1], "pill 非焦点垫仍是悬停提亮档（--tab-bg-active-hover）").toContain(
      "var(--tab-bg-active-hover) 14px",
    );
    for (const p of pads) {
      expect(p, "非焦点垫同样要有实色停靠点（槽内全不透明）").toMatch(/\)\s+14px\)/);
    }

    // 反向验证：垫色退回 --tab-bg-active（不跟随降档）必须被咬住
    const BAD = css.replace(
      /(\.layout-panel:not\(\.layout-panel-active\)[\s\S]{0,200}?\.tab-action::before\s*\{[^}]*?)var\(--tab-bg-hover\) 14px/,
      "$1var(--tab-bg-active) 14px",
    );
    expect(BAD, "替身必须真的改了垫色").not.toBe(css);
    expect(
      BAD.match(
        /\.layout-panel:not\(\.layout-panel-active\)[\s\S]{0,200}?\.tab-action::before\s*\{[^}]*\}/,
      )?.[0],
      "替身不跟随降档的垫色必须被抓到",
    ).not.toContain("var(--tab-bg-hover) 14px");
  });
});

describe("编辑区大卡片外框（B123，修正 B122：卡片上移到整个标签+编辑区）", () => {
  it("layout-area = 一张大卡片（1px hover 同色 + 8px 圆角）；面板无框；分屏边界恢复细线；状态栏上沿仍无线", () => {
    // 用户裁决：不是每个分屏一张卡，而是整个「标签+编辑区」一张大卡片，
    // 分屏边界落在卡片内部（无圆角、恢复 1px 细线）；边框颜色仍 ≈
    // 非活动标签 hover 底色（实拍 VS Code #2a2b2c 同档）。
    const css = readFileSync("src/styles/global.css", "utf-8");

    // 大卡片三件套落在 .layout-area（VS Code 的 .part.editor 同款）
    const area = cssDecls(ruleBlock(css, ".layout-area"));
    expect(area, "大卡片外框必须是 1px 卡片边框（颜色=非活动 hover 色）").toContain(
      "border: 1px solid var(--editor-card-border)",
    );
    expect(area, "卡片圆角 8px（VS Code cornerRadius-large）").toContain("border-radius: 8px");
    expect(area, "overflow hidden 裁出圆角（VS Code 同款）").toContain("overflow: hidden");

    // 面板本身退回无修饰容器（B122 的每面板卡片已上移）
    const panel = cssDecls(ruleBlock(css, ".layout-panel"));
    expect(panel, "面板不得再画卡片边框（B123 卡片上移）").not.toMatch(/border/);
    expect(panel, "面板不得再有圆角").not.toContain("border-radius");

    // 状态栏上沿不在卡片里（状态栏在卡片外面）
    const statusbar = cssDecls(ruleBlock(css, ".statusbar"));
    expect(statusbar, "状态栏不得再画 border-top（B379 用 inset 阴影画上沿线）").not.toContain(
      "border-top",
    );
    // B379：状态栏有自己的底色（statusBar.background），不再跟标题栏同源
    expect(statusbar, "状态栏底色必须引用 --statusbar-bg").toContain(
      "background: var(--statusbar-bg)",
    );

    // 分屏边界恢复静息细线（大卡片内部，editorGroup.border）
    const sep = ruleBlock(css, ".layout-sep::after");
    expect(sep, "分屏分隔条静息必须画 --editor-split-border 细线").toContain(
      "background: var(--editor-split-border)",
    );
    // 悬停/拖拽高亮不受影响（B59/B60）：accent + 加宽
    const hl = css.match(/\.layout-sep:hover::after,[\s\S]{0,80}?\{[^}]*\}/)?.[0] ?? "";
    expect(hl, "分隔条悬停高亮仍为 accent").toMatch(/var\(--accent/);

    // 大纲那一档（preview.css）：B195 起改走「空隙 + 三点把手」，
    // 不再画 --sep-line 竖线 —— 把手走的是 --fg-muted（静息）→ --fg（悬停）
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    expect(previewCss, "侧栏三点把手静息走 --fg-muted（B195）").toMatch(
      /\.toc-grip\s*\{[^}]*color:\s*var\(--fg-muted[,)]/,
    );

    // 反向验证①：分屏分隔条静息透明化回潮（B122 旧契约）必须被咬住
    const sepBlock = (src: string) => ruleBlock(src, ".layout-sep::after");
    const BAD_SEP = css.replace(
      /\.layout-sep::after\s*\{[^}]*\}/,
      '.layout-sep::after {\n  content: "";\n  position: absolute;\n  background: transparent;\n}',
    );
    expect(BAD_SEP, "替身必须真的替换过").not.toBe(css);
    expect(sepBlock(BAD_SEP), "替身自证：静息透明已被塞回").toContain("background: transparent");
    expect(() => {
      expect(sepBlock(BAD_SEP), "替身的静息透明必须被抓到").toContain(
        "background: var(--editor-split-border)",
      );
    }).toThrow();

    // 反向验证②：大卡片边框退潮（layout-area 丢边框）必须被咬住
    // ⚠️ 必须**只在 .layout-area 块内**替换：.side-shell 用同一条边框声明
    //    （两张卡片必须逐字同步），全局首处替换会打在侧栏卡片上、这条就假绿了。
    const BAD_AREA = css.replace(
      /(\.layout-area\s*\{[^}]*)border: 1px solid var\(--editor-card-border\);/,
      "$1border: none;",
    );
    expect(BAD_AREA, "替身必须真的摘掉了大卡片边框").not.toBe(css);
    expect(() => {
      expect(
        cssDecls(ruleBlock(BAD_AREA, ".layout-area")),
        "替身缺失的大卡片边框必须被抓到",
      ).toContain("border: 1px solid var(--editor-card-border)");
    }).toThrow();

    // 反向验证③：状态栏 border-top 回潮必须被咬住
    // ⚠️ 锚点必须按选择器取（B379 状态栏自己那颗 `--statusbar-bg` 只在这里出现）。
    const BAD_SB = css.replace(
      /(\.statusbar\s*\{[^}]*)background:\s*var\(--statusbar-bg\);/,
      "$1background: var(--statusbar-bg);\n  border-top: 1px solid var(--border);",
    );
    expect(BAD_SB, "替身必须真的给状态栏塞上边线").not.toBe(css);
    expect(() => {
      expect(
        cssDecls(ruleBlock(BAD_SB, ".statusbar")),
        "替身的状态栏上边线必须被抓到",
      ).not.toContain("border-top");
    }).toThrow();
  });
});

describe("标签右键菜单分组与「打开文件所在目录」（B123-7）", () => {
  const at = (s: string, needle: string) => s.indexOf(needle);

  it("菜单分组与顺序：关闭类 / 复制与分屏 / 窗口 / 路径，组分隔线隔开", () => {
    const ts = stripLineComments(readFileSync("src/shell/tabstrip.ts", "utf-8"));
    const labels = [
      "关闭",
      "关闭其他标签",
      "关闭右侧标签",
      "复制标签",
      "复制到相邻面板",
      "左右分屏",
      "上下分屏",
      "在新窗口打开",
      "移回主窗口",
      "打开文件所在目录",
      "复制文件路径",
    ];
    let prev = -1;
    for (const label of labels) {
      const pos = at(ts, `label: "${label}"`);
      expect(pos, `菜单项「${label}」必须存在`).toBeGreaterThan(-1);
      expect(pos, `「${label}」必须保持分组顺序`).toBeGreaterThan(prev);
      prev = pos;
    }
    // 三组分隔线，且各自落在组与组之间
    expect((ts.match(/\{ separator: true \}/g) ?? []).length, "应有三组分隔线").toBe(3);
    const sep1 = at(ts, "{ separator: true }");
    const sep2 = ts.indexOf("{ separator: true }", sep1 + 1);
    const sep3 = ts.indexOf("{ separator: true }", sep2 + 1);
    expect(sep1, "第一组分隔线在关闭类之后").toBeGreaterThan(at(ts, 'label: "关闭右侧标签"'));
    expect(sep1, "且在复制类之前").toBeLessThan(at(ts, 'label: "复制标签"'));
    expect(sep2, "第二组分隔线在复制/分屏之后").toBeGreaterThan(at(ts, 'label: "上下分屏"'));
    expect(sep2, "且在窗口类之前").toBeLessThan(at(ts, 'label: "在新窗口打开"'));
    expect(sep3, "第三组分隔线在窗口类之后").toBeGreaterThan(at(ts, 'label: "在新窗口打开"'));
    expect(sep3, "且在路径类之前").toBeLessThan(at(ts, 'label: "打开文件所在目录"'));

    // fillMenu 不清洗分隔线，tabstrip 侧必须自带清洗（条件项缺席时防首/连续/尾分隔线）
    expect(ts, "必须有分隔线清洗（头部/连续判定）").toContain(
      "it.separator && (out.length === 0 || out[out.length - 1].separator)",
    );
    expect(ts, "必须有分隔线清洗（尾部裁剪）").toMatch(
      /while \(out\.length > 0 && out\[out\.length - 1\]\.separator\) out\.pop\(\)/,
    );
  });

  it("「打开文件所在目录」接线：回调接口 → 菜单项 → main.ts invoke → Rust 命令", () => {
    const ts = stripLineComments(readFileSync("src/shell/tabstrip.ts", "utf-8"));
    expect(ts, "回调接口必须有 onRevealInFolder").toContain(
      "onRevealInFolder?: (tabId: number) => void",
    );
    // 只在「有路径 + 有回调」时显示：未命名文档不出这项
    expect(ts, "菜单项必须以 t.path && cb.onRevealInFolder 为显示条件").toContain(
      "t.path && cb.onRevealInFolder",
    );

    const mainTs = stripLineComments(
      readFileSync("src/main.ts", "utf-8") +
        "\n" +
        readFileSync("src/prefs.ts", "utf-8") +
        "\n" +
        tabsAll(),
    );
    expect(mainTs, "main.ts 必须实现 onRevealInFolder 并 invoke 命令").toContain(
      'invoke("reveal_in_folder"',
    );

    const rs = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    expect(rs, "Rust 必须有 reveal_in_folder 命令").toContain("pub fn reveal_in_folder");
    expect(rs, "空路径必须被拒绝").toContain("文件没有路径");
    expect(rs, "必须走 explorer /select,（免 opener 插件）").toContain("/select,");
    const mainRs = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(mainRs, "命令必须注册进 generate_handler").toContain("commands::reveal_in_folder");

    // 反向验证：菜单项标签被误删必须被咬住（replaceAll：注释里也有同字样）
    const BAD = ts.replaceAll("打开文件所在目录", "打开目录");
    expect(BAD, "替身必须真的改过标签").not.toBe(ts);
    expect(at(BAD, 'label: "打开文件所在目录"')).toBe(-1);
    expect(() => {
      expect(BAD, "替身缺失的「打开文件所在目录」必须被抓到").toContain("打开文件所在目录");
    }).toThrow();
  });

  it("tooltip / 路径通道不再泄漏 \\?\\ verbatim 前缀（normalize_path 全覆盖）", () => {
    const rs = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    expect(rs, "normalize_path 助手必须存在").toContain("pub fn normalize_path");
    // 三处 canonicalize 全部过 normalize_path：裸 fs::canonicalize( 赋值不允许再出现
    const bare = (rs.match(/=\s*fs::canonicalize\(/g) ?? []).length;
    expect(bare, `还有 ${bare} 处 canonicalize 结果未过 normalize_path`).toBe(0);
    // 监听那头的比对路径必须同一写法（否则文件监听失联）
    const mainRs = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(mainRs, "watcher 事件路径也必须过 normalize_path").toMatch(
      /commands::normalize_path\(\s*std::fs::canonicalize/,
    );

    // 反向验证：摘掉某一处的 normalize_path 包装必须被咬住
    const BAD = rs.replace(
      "normalize_path(fs::canonicalize(&target).unwrap_or(target.clone()))",
      "fs::canonicalize(&target).unwrap_or(target.clone())",
    );
    expect(BAD, "替身必须真的摘掉了包装").not.toBe(rs);
    expect(() => {
      const bareBad = (BAD.match(/=\s*fs::canonicalize\(/g) ?? []).length;
      expect(bareBad, "替身的裸 canonicalize 必须被抓到").toBe(0);
    }).toThrow();
  });

  it("标题栏下沿边框线移除（B123-7：编辑区大卡片自带外框，标题栏不再画线）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(ruleBlock(css, ".title-bar"), ".title-bar 不得再画 border-bottom").not.toContain(
      "border-bottom",
    );

    // 反向验证：边框回潮必须被咬住
    const BAD = css.replace(
      ".title-bar {",
      ".title-bar {\n  border-bottom: 1px solid var(--border);",
    );
    expect(BAD, "替身必须真的塞回了边框").not.toBe(css);
    expect(() => {
      expect(ruleBlock(BAD, ".title-bar"), "替身的标题栏边框必须被抓到").not.toContain(
        "border-bottom",
      );
    }).toThrow();
  });
});

// ------------------------------------------------------- B204：状态栏与标题栏同底色
// 用户原话：「状态栏颜色和标题栏背景色一致，或者统一为没有背景色」⇒ 选了「一致」。
// B204 曾把状态栏并到标题栏那颗 `--bg-toolbar`（用户当时点名「两边同色」）。
// B379 用户重新点名「状态栏……颜色和样式尽量和 vscode 保持一致」⇒ 状态栏恢复
// 自己的 `statusBar.background / foreground`：Plus / 经典档是一条 #007ACC 蓝，
// 2026 / Modern 档才恰好与标题栏同色 —— 两者不再是同一颗变量。
// B381（用户点名「状态栏不应该有边框线」）：VS Code 的 floating panels 把
// statusBar.border 的上沿线关掉，这里也不画。
describe("状态栏按 statusBar.* 取色（B379，推翻 B204 的同源裁决）", () => {
  it("状态栏有自己的底 / 字，不画上沿线，独立的 --bg-status 仍然不许回来", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const statusbar = cssDecls(ruleBlock(css, ".statusbar"));
    expect(statusbar, "状态栏底色 = statusBar.background").toContain(
      "background: var(--statusbar-bg)",
    );
    expect(statusbar, "状态栏前景 = statusBar.foreground").toContain("color: var(--statusbar-fg)");
    expect(statusbar, "不得再画上沿线（B381）").not.toContain("box-shadow");
    expect(cssDecls(ruleBlock(css, ".title-bar")), "标题栏走 shellBackground").toContain(
      "background: var(--shell-bg)",
    );
    // ⚠️ 旧的那颗独立变量仍不许复活：它没有映射到任何 VS Code token，加了就是第三套口径。
    expect(css, "不得再定义 --bg-status").not.toMatch(/--bg-status\s*:/);
    expect(css, "不许留 --xxx: var(--bg-status) 这种别名懒政").not.toMatch(
      /--[\w-]+\s*:\s*var\(--bg-status\)/,
    );
  });

  it("反向验证①：状态栏退回标题栏那颗（B204 旧口径）必须被咬住", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const BAD = css.replace(
      /(\.statusbar\s*\{[^}]*)background:\s*var\(--statusbar-bg\);/,
      "$1background: var(--bg-toolbar);",
    );
    expect(BAD, "替身必须真的退回共用底色").not.toBe(css);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, ".statusbar")), "替身必须不再取 statusBar token").toContain(
        "background: var(--statusbar-bg)",
      );
    }).toThrow();
  });

  it("反向验证②：把 --bg-status 当新变量加回来必须被咬住", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    // 不拿某个主题值当锚点（B376/B379 换过配色，锚旧值会让替身构造静默失效）；
    // 直接补一条独立的主题覆盖块 —— 与「日后有人加回这颗变量」的形状一致。
    const BAD = `${css}\n:root[data-theme="light"] { --bg-status: #eef0f2; }\n`;
    expect(BAD, "替身必须真的补回那颗变量").not.toBe(css);
    expect(() => {
      expect(BAD, "独立的状态栏底色必须被抓到").not.toMatch(/--bg-status\s*:/);
    }).toThrow();
  });
});
