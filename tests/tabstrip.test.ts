// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { themeBlock, cssDecls, ruleBlock, stripLineComments } from "./static";

describe("标签栏静态契约（从 regressions 拆出）", () => {
  it("B53 标签区改为横向滚动（折叠机制已整体移除，用户要求）", () => {
    // 用户要求：去掉 tab 折叠功能，保留滚动能力，参考 VS Code 优化。
    // 旧实现是「不显示滚动条 + 溢出的标签折叠进下拉按钮」——那套机制已删除，
    // 连同它需要的 ResizeObserver 重算 / tabId 重对齐 / 预算铺满三条不变量。
    const css = readFileSync("src/styles/global.css", "utf-8");
    // ⚠️ 必须 \n 锚定行首：pill 覆盖块（B114）的选择器是
    //   :root[data-tab-style="pill"] .panel-tabstrip
    // 无锚定时 \.panel-tabstrip\s*\{ 会命中它的尾段，抓回来的是 pill 块的块体。
    const strip = css.match(/\n\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    expect(strip, "标签区必须可横向滚动").toContain("overflow-x: auto");
    // 细滚动条由 ::-webkit-scrollbar 自绘。⚠️ B54 踩坑：元素上写了 scrollbar-width /
    // scrollbar-color（标准属性）后 Chromium 会**忽略** ::-webkit-scrollbar，标签栏
    // 会拿回系统滚动条（两端带箭头、也压不细）→ 必须复位成 auto，见下面 B54 用例。
    expect(css, "标签栏滚动条必须自绘且很细").toMatch(
      /\.panel-tabstrip::-webkit-scrollbar\s*\{[^}]*height:\s*[1-4]px/,
    );
    expect(strip, "标签永不换行（VS Code）").toContain("flex-wrap: nowrap");
    expect(css, "折叠按钮的样式必须整体删除").not.toContain("tab-more");

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "折叠机制必须整体删除（含下拉列表构造）").not.toContain("tab-more");
    expect(ts, "不应再按 tabId 重对齐可见窗口（原生滚动不需要）").not.toContain("reanchorStart");
    expect(ts, "不应再手写 ResizeObserver 重算可见区间").not.toContain("new ResizeObserver");
    expect(ts, "必须挂载滚轮滚动").toContain('addEventListener("wheel"');
    expect(ts, "滚轮需用 passive:false 才能 preventDefault").toContain("passive: false");
    expect(ts, "Ctrl+滚轮要让位给字号缩放").toContain("if (e.ctrlKey) return;");
    expect(ts, "全量重绘必须存取滚动位置，否则每次重绘都跳回最左").toContain(
      "const prevScroll = host.scrollLeft",
    );
    expect(ts, "必须把活动标签滚进可见区").toContain("ensureVisible(host");
    // 用 scrollIntoView 会连带滚动所有祖先容器（分屏/嵌套布局下整页跳），且 jsdom 没有它。
    // 只禁止**调用**（注释里提到它没关系），故匹配带接收者的调用式。
    expect(ts, "定位用自身几何而不是 scrollIntoView").not.toMatch(/\.scrollIntoView\(/);

    // 滚动条余量必须**恒定预留**：原生横向滚动条从内容区里切高度，
    // 不预留则「溢出↔不溢出」切换时标签栏 26↔28px 跳变，编辑器内容跟着抖
    expect(strip, "标签栏高度必须固定（含滚动条余量）").toMatch(/height:\s*\d+px/);
    const tabRule = css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "";
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    const tabH = Number(tabRule.match(/height:\s*(\d+)px/)![1]);
    expect(stripH, "标签栏高度必须大于标签高度（差值即滚动条余量）").toBeGreaterThan(tabH);
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
    expect(fill, "底色层必须绝对定位（才能上下外扩出标签行）").toContain("position: absolute");
    expect(fill, "左右不得内缩：相邻标签必须相连（connected 而非独立药丸）").toMatch(
      /inset:\s*-4px 0 -4px/,
    );
    expect(fill, "只有上方两角是圆的（下方要与编辑器相接）").toMatch(
      /border-radius:\s*\d+px \d+px 0 0/,
    );
    expect(fill, "底色层不吃鼠标事件（否则点不到标签）").toContain("pointer-events: none");

    const activeFill = cssDecls(ruleBlock(css, ".tab-active .tab-fill"));
    expect(
      activeFill,
      "活动标签底色必须收进 --tab-fill-bg 变量（肩部补色与它同源，B113-2 方案 A）",
    ).toMatch(/--tab-fill-bg:\s*var\(--tab-bg-active\)/);
    expect(activeFill, "底色必须引用该变量（而不是直接写死）").toContain(
      "background: var(--tab-fill-bg)",
    );
    expect(activeFill, "活动标签要描一圈边").toMatch(/border:\s*1px solid var\(--border\)/);
    expect(activeFill, "底边不得封口（否则标签与编辑器之间多一条横线，就「连」不起来）").toContain(
      "border-bottom-color: transparent",
    );

    const hoverFill = cssDecls(ruleBlock(css, ".tab:hover:not(.tab-active) .tab-fill"));
    expect(hoverFill, "悬停要有独立一档底色").toContain("var(--tab-bg-hover)");

    // 肩部：把侧边描边顺圆角弯到条带底边，否则活动标签像一块硬贴上去的方砖
    expect(css, "活动标签左侧要有肩部圆角").toMatch(/\.tab-active \.tab-fill::before/);
    expect(css, "活动标签右侧要有肩部圆角").toMatch(/\.tab-active \.tab-fill::after/);
    expect(css, "首尾标签的外侧不画肩（那里没有邻居可接）").toMatch(
      /:first-child \.tab-fill::before/,
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
    }

    // tab-flash 结束态必须回到标签底色。B113-2（方案 A）：动画**只驱动 --tab-fill-bg**
    // —— fill 底色与肩部补色共用这个变量，变量一动三者同步变色；
    // 若关键帧里直接写 background，肩部就会在闪烁时被甩在旧色上。
    const flash = css.match(/@keyframes tab-flash\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(flash, "应有 tab-flash 关键帧").toBeTruthy();
    expect(flash, "闪烁必须驱动 --tab-fill-bg（肩部与底色共用它）").toContain("--tab-fill-bg:");
    expect(flash, "结束态必须回到标签底色").toContain("--tab-fill-bg: var(--tab-bg-active)");
    expect(flash, "关键帧不得再引用旧配色 var(--bg)").not.toContain("var(--bg))");
    expect(flash, "关键帧不得直接写 background（必须走变量，否则肩部跟不上）").not.toMatch(
      /^\s*background:/m,
    );
    // 自定义属性动画要有平滑插值，必须先注册成 <color>（否则是离散跳变）
    expect(css, "--tab-fill-bg 必须注册成 color 类型").toMatch(
      /@property --tab-fill-bg\s*\{[^}]*syntax:\s*"<color>"/,
    );
    // B113：底色搬到 fill 后动画也必须跟着搬 —— 挂在 .tab 上等于打在透明底上
    expect(css, "闪一下必须作用在 .tab-fill 上").toMatch(/\.tab-flash \.tab-fill/);
    // B113-2 核心：肩部补色与标签底色**同源**（同一个变量），悬停/闪烁才不会再对不上色
    // ⚠️ ::before 有两条规则（公共占位 + 定位/补色），用 filter 取含 box-shadow 的那条
    const shoulder = cssDecls(ruleBlock(css, ".tab-active .tab-fill::before", "box-shadow"));
    expect(shoulder, "肩部补色必须引用 --tab-fill-bg").toContain("var(--tab-fill-bg");
    const activeHover = cssDecls(ruleBlock(css, ".tab-active:hover .tab-fill"));
    expect(activeHover, "悬停提亮必须只改变量（底色与肩部一起变）").toMatch(
      /--tab-fill-bg:\s*var\(--tab-bg-active-hover\)/,
    );

    // DOM 侧：CSS 写了但没渲染这个元素，标签就是全透明一片
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "必须渲染 .tab-fill 元素").toContain('className = "tab-fill"');
    expect(ts, "fill 必须排在内容之前（内容靠 z-index 浮在它上面）").toContain(
      "el.append(fill, icon, name, action)",
    );
  });
  it("B55：标签栏滚动条 4px，正好塞进药丸行下方那 4px 间隙", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = css.match(/\n\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    // 关键坑：元素上指定 scrollbar-width/color 后 Chromium 会忽略 ::-webkit-scrollbar，
    // 标签栏就拿回系统滚动条（两端带箭头、压不细）。必须复位成 auto。
    expect(strip, "scrollbar-width 必须复位为 auto").toMatch(/scrollbar-width:\s*auto/);
    expect(strip, "scrollbar-color 必须复位为 auto").toMatch(/scrollbar-color:\s*auto/);
    // B113：connected 标签**相连**，不再靠 gap 撑缝（缝会让 fill 接不上，
    // 活动标签与编辑器之间就出现断口）；分隔感改由活动标签的凸起 + 描边给出。
    expect(strip, "标签必须相连（gap 0），不能留缝隙").toMatch(/gap:\s*0/);
    expect(strip, "标签条要有表面底色（活动标签取编辑器色，两者差一档才有对比）").toContain(
      "background: var(--tab-strip-bg)",
    );
    expect(
      strip,
      "内边距：上 4 / 右 4 / 下 0 / 左 0（B113-2：左侧不留白，下方让给滚动条）",
    ).toMatch(/padding:\s*4px 4px 0 0/);

    const thin = css.match(/\.panel-tabstrip::-webkit-scrollbar\s*\{[^}]*\}/)?.[0] ?? "";
    expect(thin, "必须有 webkit 滚动条规则").toBeTruthy();
    const bar = Number(thin.match(/height:\s*(\d+)px/)?.[1]);
    expect(bar, "滚动条 4px").toBe(4);

    const btn = css.match(/\.panel-tabstrip::-webkit-scrollbar-button\s*\{[^}]*\}/)?.[0] ?? "";
    expect(btn, "必须显式去掉两端箭头按钮").toBeTruthy();
    expect(btn, "箭头按钮必须 display:none").toMatch(/display:\s*none/);

    // 几何自洽：32 = 4(上间距) + 24(标签) + 4(滚动条)。三个数绑在一起，
    // 改一个必须改全部，否则滚动条会压到标签上（或标签行被挤下去）。
    const tabH = Number(cssDecls(ruleBlock(css, ".tab")).match(/height:\s*(\d+)px/)![1]);
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    expect(stripH - tabH, "药丸行上下各留 4px，滚动条正好吃下面那 4px").toBe(bar * 2);

    // 拖拽插入线必须跟着药丸行走，且让开滚动条那 4px（B55 计划的头号雷点）
    const insert = css.match(/\.tab-insert\s*\{[^}]*\}/)?.[0] ?? "";
    expect(insert, "拖拽插入线必须与药丸行等高").toMatch(/top:\s*4px/);
    expect(insert, "拖拽插入线必须让开滚动条").toMatch(/bottom:\s*4px/);
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
