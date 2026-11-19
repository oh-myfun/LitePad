// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cssDecls, ruleBlock, stripLineComments, resolveCssVars, tabsAll } from "./static";

describe("标签栏静态契约（从 regressions 拆出）", () => {
  it("B53/B117 标签区横向滚动改自绘悬浮滚动条（折叠机制已整体移除）", () => {
    // 用户要求：去掉 tab 折叠功能（B53）→ 滚动条改 VS Code 式悬浮不占高度（B117）。
    // 原生横向滚动条在 Chromium 里永远占布局空间，做不出悬浮形态 —— 改自绘：
    // strip 只负责被程序滚动（overflow hidden 下 scrollLeft 可编程设置），
    // 可见 thumb 由 tabstrip.ts 的 syncOverlayScrollbar 叠在底部。
    const css = readFileSync("src/styles/global.css", "utf-8");
    // ⚠️ 行首锚定：`.panel-tabstrip` 还出现在 `.panel-tabstrip-scrollbar` 等复合
    // 选择器里，行首 + 紧跟 `{` 才只命中基础规则本身。
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
    // 同一套判据现在服务两条滚动条：标签条（横向）+ 边栏列表（纵向）。两处回调必须是
    // 同一句几何同步；总数仍锁死，防止又长出第三种用途（记账 / 重算可见区间）。
    expect(
      (tsCode.match(/new ResizeObserver\(\(\) => syncOverlayScrollbar\(host\)\)/g) ?? []).length,
      "标签条 + 边栏列表，两处都必须只同步 thumb 几何",
    ).toBe(2);
    expect(
      (tsCode.match(/new ResizeObserver/g) ?? []).length,
      "只允许上面两处 ResizeObserver，多一处就要问是不是又在记账",
    ).toBe(2);
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

  it("标题栏不画任何下沿线（B123-7 去 border-bottom · B390 连 HC 那根 box-shadow 也摘）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    // 判据按**形状**而不是某一根声明：B380 那次就是绕开这条只盯 `border-bottom` 的判据，
    // 用 `box-shadow: inset 0 -1px 0` 给 HC 补了一根线（用户 B390 点名要去掉）。
    const 画线 = /border-bottom|box-shadow/;
    expect(ruleBlock(css, ".title-bar"), ".title-bar 不得画下沿线").not.toMatch(画线);

    // 反向验证：两种画法回潮都必须被咬住
    for (const 塞回的 of [
      "  border-bottom: 1px solid var(--border);",
      "  box-shadow: inset 0 -1px 0 var(--titlebar-border);",
    ]) {
      const BAD = css.replace(".title-bar {", `.title-bar {\n${塞回的}`);
      expect(BAD, "替身必须真的塞回了线").not.toBe(css);
      expect(() => {
        expect(ruleBlock(BAD, ".title-bar"), `替身塞的「${塞回的.trim()}」必须被抓到`).not.toMatch(
          画线,
        );
      }).toThrow();
    }
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
