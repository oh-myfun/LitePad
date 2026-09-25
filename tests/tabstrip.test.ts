// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { themeBlock, cssDecls, ruleBlock, stripLineComments, stripCssComments } from "./static";

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
    const strip = css.match(/\n\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
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

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const tsCode = stripLineComments(ts);
    expect(tsCode, "折叠机制必须整体删除（含下拉列表构造）").not.toContain("tab-more");
    expect(tsCode, "不应再按 tabId 重对齐可见窗口").not.toContain("reanchorStart");
    expect(tsCode, "不应再手写 ResizeObserver 重算可见区间").not.toContain("new ResizeObserver");
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

    // 条带高度：悬浮条不占布局 → 28px = 4px 上间距 + 24px 标签，无底部预留
    expect(strip, "标签栏高度必须固定（无溢出↔有溢出恒定，不抖）").toMatch(/height:\s*\d+px/);
    const tabRule = css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "";
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    const tabH = Number(tabRule.match(/height:\s*(\d+)px/)![1]);
    expect(stripH - tabH, "标签栏只留顶部 4px 上间距，底部不再预留").toBe(4);
  });
  it("B56 标签不收缩：宽度跟内容走，放不下就横向滚动（文件名不裁剪成「…」）", () => {
    // 用户反馈：标签变多后标签被压窄，文件名被裁剪成「…」。
    // 根因 = .tab 上的 flex-shrink:1（B53 的「先收缩再滚动」）+ .tab-name 的
    // text-overflow: ellipsis。B56 反过来：宽度 = 内容宽度，溢出交给横向滚动。
    // ⚠️ 用 ruleBlock 而不是「取到第一个右花括号为止」的旧写法：后者会被**块内注释里的
    //   右花括号**截断（B113 这次就在注释里引过 VS Code 的选择器，一截断 flex 声明全丢，
    //   报的是「文件名不得收缩」这种八竿子打不着的错）——见 pitfalls/0075。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tab = cssDecls(ruleBlock(css, ".tab"));
    expect(tab, "应有 .tab 规则").toBeTruthy();
    expect(tab, "标签必须不可收缩（flex-shrink:0），否则标签变多时宽度被压窄").toMatch(
      /flex:\s*0 0 auto/,
    );
    expect(tab, "不得再写 flex: 0 1 auto（那是会裁剪文本的可收缩行为）").not.toMatch(
      /flex:\s*0 1 auto/,
    );
    expect(tab, "不得再给标签设宽度上限，否则超长文件名仍会被截断").not.toMatch(/max-width/);
    expect(tab, "保留收缩下限当最小宽度（短名标签不至于窄成一条）").toMatch(/min-width:\s*\d+px/);

    const name = cssDecls(ruleBlock(css, ".tab-name"));
    expect(name, "应有 .tab-name 规则").toBeTruthy();
    expect(name, "文件名不得收缩").toMatch(/flex:\s*1 0 auto/);
    expect(name, "不得再用省略号裁剪文件名").not.toContain("text-overflow: ellipsis");
    expect(name, "不得再裁剪溢出（文件名必须整段可见）").not.toContain("overflow: hidden");
  });
  it("B57 ● 与 × 共用固定尺寸槽位，显隐走 opacity（对齐 VS Code 标签操作列）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const slot = cssDecls(css.match(/\n\.tab-action\s*\{[^}]*\}/)?.[0] ?? "");
    expect(slot, "应有 .tab-action 槽位规则").toBeTruthy();
    expect(slot, "槽位尺寸必须固定，否则悬停切换会改变标签宽度").toMatch(/width:\s*\d+px/);
    expect(slot).toMatch(/height:\s*\d+px/);

    // VS Code 标签操作列用 opacity 而不是 display 做显隐（经典档 multieditortabscontrol.css
    // 与 Modern UI 档 tabs.css 都是这套）：布局本来就被固定槽位锁住，
    // opacity 既能淡入，也不触发重排。
    const layer = cssDecls(css.match(/\.tab-mark,\s*\.tab-close\s*\{[^}]*\}/)?.[0] ?? "");
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
    const layer = cssDecls(css.match(/\.tab-mark,\s*\.tab-close\s*\{[^}]*\}/)?.[0] ?? "");
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
    const tab = cssDecls(ruleBlock(css, ".tab"));
    expect(tab, "应有 .tab 规则").toBeTruthy();
    const h = tab.match(/height:\s*(\d+)px/);
    expect(h, "标签高度必须显式给出（字号档位变化时栏高才恒定）").toBeTruthy();
    expect(Number(h![1]), "标签高 24px（VS Code 常规档 --editor-group-tab-height）").toBe(24);
    expect(tab, ".tab 必须是底色层的定位基准").toContain("position: relative");
    // 底色一旦还留在 .tab 上就会盖住 fill 的圆角与描边，connected 的观感直接没了
    expect(tab, "标签自身不得再上底色（底色归 .tab-fill）").not.toMatch(
      /background:\s*var\(--tab-bg/,
    );
    expect(tab, "非活动文字降到 50% 前景（VS Code color-mix 写法）").toMatch(
      /color:\s*color-mix\(in srgb, var\(--fg\) 50%, transparent\)/,
    );

    const fill = cssDecls(ruleBlock(css, ".tab-fill"));
    expect(fill, "应有 .tab-fill 底色层").toBeTruthy();
    expect(fill, "底色层必须绝对定位（才能向上外扩出标签行）").toContain("position: absolute");
    // B119：底部外扩收回（-4px→0）—— B117 后标签底 = 条带底，外扩部分会被 overflow 裁掉；
    // ⚠️ 断言到分号：`-4px 0 0` 是 `-4px 0 -4px` 的前缀，不锚定分号会被旧值混过
    expect(fill, "左右相连（connected）且底部不再外扩（B119）").toMatch(/inset:\s*-4px 0 0\s*;/);
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
    // B116：描边整体去掉（用户要求），活动标签只靠底色区分
    expect(activeFill, "活动标签不得再描边（用户要求去边框）").not.toMatch(/border/);

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
    const rootBlock = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rootBlock, "标签圆角单一来源变量必须在 :root 定义").toContain("--tab-radius: 5px");
    // ⚠️ 不用 ruleBlock 取肩部：首条规则是群组选择器，`::after` 后恰好跟 `{`
    // 会提前命中共享块 —— 直接正则 + 块内特征（left: 100%）锚定独立规则。
    const fillBlock = cssDecls(ruleBlock(css, ".tab-fill"));
    expect(fillBlock, "活动标签顶部圆角走 --tab-radius").toContain(
      "border-radius: var(--tab-radius) var(--tab-radius) 0 0",
    );
    const shoulderGroup =
      css.match(
        /\.tab-active \.tab-fill::before,\s*\.tab-active \.tab-fill::after\s*\{[^}]*\}/,
      )?.[0] ?? "";
    expect(shoulderGroup.replace(/\s+/g, " "), "两肩尺寸走 --tab-radius（与顶部同半径）").toContain(
      "width: var(--tab-radius)",
    );
    const shoulderBefore = (
      css.match(/\.tab-active \.tab-fill::before\s*\{[^}]*\}/)?.[0] ?? ""
    ).replace(/\s+/g, " ");
    expect(shoulderBefore, "左肩反弧半径 = 顶部圆角半径").toContain(
      "border-bottom-right-radius: var(--tab-radius)",
    );
    expect(shoulderBefore, "左肩阴影偏移 = 半径一半（VS Code R/2 R/2 0 R/2 构造）").toContain(
      "box-shadow: calc(var(--tab-radius) / 2)",
    );
    const shoulderAfter = (
      css.match(/\.tab-active \.tab-fill::after\s*\{[^}]*left: 100%[^}]*\}/)?.[0] ?? ""
    ).replace(/\s+/g, " ");
    expect(shoulderAfter, "右肩反弧半径 = 顶部圆角半径（镜像）").toContain(
      "border-bottom-left-radius: var(--tab-radius)",
    );
    expect(shoulderAfter, "右肩阴影偏移镜像为负").toContain(
      "box-shadow: calc(var(--tab-radius) / -2)",
    );
    expect(cssNoComments, "肩部不得用上底色的圆盘构造（B119 老做法）").not.toMatch(
      /\.tab-active \.tab-fill::(?:before|after)\s*\{[^}]*background/,
    );

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
    // B121（最终形态）：活动标签 = 编辑器底色，与编辑区融为一体 —— 深色取
    // oneDark 的 #282c34（editor.ts 挂 oneDark，内容区实际底色），浅色 = var(--bg)。
    // （B120 曾按「深色凹槽」取 var(--bg)，融合裁决后回正。）
    expect(themeBlock(css, "dark"), "深色活动标签必须同编辑器底色（oneDark #282c34）").toContain(
      "--tab-bg-active: #282c34;",
    );
    expect(themeBlock(css, "light"), "浅色活动标签仍取 --bg（纯白）").toContain(
      "--tab-bg-active: var(--bg);",
    );
    // B122：ops 段同样无线（B121 的补线随条带细线一并退场）
    const ops = cssDecls(ruleBlock(css, ".panel-ops"));
    expect(ops, "ops 段不得再有 border-bottom（B122 细线整体退场）").not.toContain("border-bottom");
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
  it("B117：底部不再预留滚动条空间（32 → 28px），插入线直达条带底", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = css.match(/\n\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    // B113：connected 标签**相连**，不再靠 gap 撑缝（缝会让 fill 接不上，
    // 活动标签与编辑器之间就出现断口）；分隔感改由活动标签的凸起给出。
    expect(strip, "标签必须相连（gap 0），不能留缝隙").toMatch(/gap:\s*0/);
    // B122：条带下沿不再画线（B121 的渐变细线移除）——条带与内容的分界就是
    // 两块底色的交界本身；面板整体轮廓交给 .layout-panel 的圆角卡片边框
    expect(strip, "条带表面必须是纯底色（下沿无线，B122）").toContain(
      "background: var(--tab-strip-bg)",
    );
    expect(strip, "条带不得再画底部细线（B122）").not.toContain("linear-gradient");
    expect(
      strip,
      "内边距：上 4 / 右 4 / 下 0 / 左 0（B113-2：左侧不留白，下方让给编辑区）",
    ).toMatch(/padding:\s*4px 4px 0 0/);

    // B55 时代「滚动条 4px 坐在下间隙里」的整套预留随 B117 悬浮化一起退场：
    // 条带 28 = 4(上间距) + 24(标签)，底部 0 预留 —— 溢出与否高度恒定不抖。
    const tabH = Number(cssDecls(ruleBlock(css, ".tab")).match(/height:\s*(\d+)px/)![1]);
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    expect(stripH, "条带收窄到 28px").toBe(28);
    expect(stripH - tabH, "底部不再有滚动条预留").toBe(4);
    expect(css, "原生 webkit 滚动条规则必须整体删除").not.toMatch(
      /\.panel-tabstrip::-webkit-scrollbar/,
    );

    // 拖拽插入线必须跟着标签行走；底部间隙取消后直达条带底（B117）
    const insert = css.match(/\.tab-insert\s*\{[^}]*\}/)?.[0] ?? "";
    expect(insert, "拖拽插入线必须与标签行等高").toMatch(/top:\s*4px/);
    expect(insert, "插入线必须直达条带底（无下间隙）").toMatch(/bottom:\s*0/);
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
    const BAD_NO_SHOULDER = cssCode.replace(/box-shadow: calc\(var\(--tab-radius\)[^;]*;/g, "");
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
    // ⚠️ 断言到分号为止：connected 的 padding 值是 "4px 4px 0 0"，它是
    //   "4px 4px 0" 的超集 —— 只 includes 前缀的话，替身写 connected 值也混得过去。
    if (!/padding:\s*4px 4px 0\s*;/.test(strip)) v.push("pill 恢复条带 4px 左留白");
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
      "pill 恢复条带 4px 左留白",
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
    const src = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    expect(src, "档位必须写进 html[data-tab-style]").toContain("dataset.tabStyle");
    expect(src, "未知值必须回落 connected（与 Rust 回落一致）").toContain(
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

    const src = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    expect(src, "档位必须写进 html[data-tab-reserve]").toContain("dataset.tabReserve");
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
    expect(pad, "垫必须贴在 × 左侧").toContain("right: 100%");
    expect(pad, "垫默认隐藏（随 × 一起淡入）").toMatch(/opacity:\s*0/);
    expect(pad, "不得拦截鼠标（否则挡标签点击）").toContain("pointer-events: none");

    // ⚠️ prettier 会把长选择器折成多行，ruleBlock 的字面量匹配会失配 ——
    //   一律用 filter（块体特征声明）取目标规则，对折行鲁棒。
    const show = cssDecls(ruleBlock(css, ".tab-action::before", "opacity: 1"));
    expect(show, "悬停/聚焦时垫必须淡入").toMatch(/opacity:\s*1/);
    // 选择器不在块体里，对整份 CSS 断言（B118 块内 hover + focus-within 两个出场口）
    expect(css, "淡入必须覆盖悬停").toMatch(
      /:root\[data-tab-reserve="off"\][^{]*\.tab:not\(\.tab-dirty\):hover \.tab-action::before/,
    );
    expect(css, "淡入必须覆盖键盘聚焦").toContain(".tab-action:focus-within::before");

    // B119 起 --tab-bg-hover 是 color-mix 不透明色：单层渐变即可盖住文字尾部
    const dimPad = cssDecls(ruleBlock(css, ".tab-action::before", "var(--tab-bg-hover)"));
    expect(dimPad, "非活动垫 = 渐变到悬停底色（单层，B119 起悬停色不透明）").toContain(
      "linear-gradient(to right, transparent, var(--tab-bg-hover))",
    );
    // 活动垫 = 渐变到活动 fill 同色（B119 对齐 VS Code action-active-hover-background = surface；
    // ⚠️ filter 用带收尾括号的 var(--tab-bg-active))，否则会被 pill 垫的 active-hover 超集混过）
    const activePad = cssDecls(ruleBlock(css, ".tab-action::before", "var(--tab-bg-active))"));
    expect(activePad, "活动垫用单层渐变到活动 fill 同色（connected 悬停不提亮）").toContain(
      "linear-gradient(to right, transparent, var(--tab-bg-active))",
    );
    // pill 档悬停仍提亮一档 → 垫色跟着提（覆盖块）
    const pillPad = cssDecls(ruleBlock(css, ".tab-action::before", "var(--tab-bg-active-hover)"));
    expect(pillPad, "pill 档活动垫跟随提亮后的 fill").toContain(
      "linear-gradient(to right, transparent, var(--tab-bg-active-hover))",
    );

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
      "border: 1px solid var(--tab-bg-hover)",
    );
    expect(area, "卡片圆角 8px（VS Code cornerRadius-large）").toContain("border-radius: 8px");
    expect(area, "overflow hidden 裁出圆角（VS Code 同款）").toContain("overflow: hidden");

    // 面板本身退回无修饰容器（B122 的每面板卡片已上移）
    const panel = cssDecls(ruleBlock(css, ".layout-panel"));
    expect(panel, "面板不得再画卡片边框（B123 卡片上移）").not.toMatch(/border/);
    expect(panel, "面板不得再有圆角").not.toContain("border-radius");

    // 状态栏上沿无线（状态栏在卡片外面）
    const statusbar = cssDecls(ruleBlock(css, ".statusbar"));
    expect(statusbar, "状态栏不得再画 border-top").not.toContain("border-top");

    // 分屏边界恢复静息细线（大卡片内部，实拍 VS Code #272829 ≈ --sep-line）
    const sep = css.match(/\.layout-sep::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sep, "分屏分隔条静息必须画 --sep-line 细线（B123）").toContain(
      "background: var(--sep-line)",
    );
    // 悬停/拖拽高亮不受影响（B59/B60）：accent + 加宽
    const hl = css.match(/\.layout-sep:hover::after,[\s\S]{0,80}?\{[^}]*\}/)?.[0] ?? "";
    expect(hl, "分隔条悬停高亮仍为 accent").toMatch(/var\(--accent/);

    // 大纲分隔条（preview.css .toc-resizer）不受影响，仍走 --sep-line
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    expect(previewCss, "大纲分隔条线色仍走 --sep-line").toMatch(
      /\.toc-resizer::after\s*\{[^}]*background:\s*var\(--sep-line\)/,
    );

    // 反向验证①：分屏分隔条静息透明化回潮（B122 旧契约）必须被咬住
    const sepBlock = (src: string) => src.match(/\.layout-sep::after\s*\{[^}]*\}/)?.[0] ?? "";
    const BAD_SEP = css.replace(
      /\.layout-sep::after\s*\{[^}]*\}/,
      '.layout-sep::after {\n  content: "";\n  position: absolute;\n  background: transparent;\n}',
    );
    expect(BAD_SEP, "替身必须真的替换过").not.toBe(css);
    expect(sepBlock(BAD_SEP), "替身自证：静息透明已被塞回").toContain("background: transparent");
    expect(() => {
      expect(sepBlock(BAD_SEP), "替身的静息透明必须被抓到").toContain(
        "background: var(--sep-line)",
      );
    }).toThrow();

    // 反向验证②：大卡片边框退潮（layout-area 丢边框）必须被咬住
    const BAD_AREA = css.replace("border: 1px solid var(--tab-bg-hover);", "border: none;");
    expect(BAD_AREA, "替身必须真的摘掉了大卡片边框").not.toBe(css);
    expect(() => {
      expect(
        cssDecls(ruleBlock(BAD_AREA, ".layout-area")),
        "替身缺失的大卡片边框必须被抓到",
      ).toContain("border: 1px solid var(--tab-bg-hover)");
    }).toThrow();

    // 反向验证③：状态栏 border-top 回潮必须被咬住
    const BAD_SB = css.replace(
      "background: var(--bg-status);",
      "background: var(--bg-status);\n  border-top: 1px solid var(--border);",
    );
    expect(() => {
      expect(
        cssDecls(ruleBlock(BAD_SB, ".statusbar")),
        "替身的状态栏上边线必须被抓到",
      ).not.toContain("border-top");
    }).toThrow();
  });
});
