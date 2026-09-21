// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { themeBlock, cssDecls } from "./static";

describe("标签栏静态契约（从 regressions 拆出）", () => {
  it("B53 标签区改为横向滚动（折叠机制已整体移除，用户要求）", () => {
    // 用户要求：去掉 tab 折叠功能，保留滚动能力，参考 VS Code 优化。
    // 旧实现是「不显示滚动条 + 溢出的标签折叠进下拉按钮」——那套机制已删除，
    // 连同它需要的 ResizeObserver 重算 / tabId 重对齐 / 预算铺满三条不变量。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = css.match(/\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
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
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tab = cssDecls(css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "");
    expect(tab, "应有 .tab 规则").toBeTruthy();
    expect(tab, "标签必须不可收缩（flex-shrink:0），否则标签变多时宽度被压窄").toMatch(
      /flex:\s*0 0 auto/,
    );
    expect(tab, "不得再写 flex: 0 1 auto（那是会裁剪文本的可收缩行为）").not.toMatch(
      /flex:\s*0 1 auto/,
    );
    expect(tab, "不得再给标签设宽度上限，否则超长文件名仍会被截断").not.toMatch(/max-width/);
    expect(tab, "保留收缩下限当最小宽度（短名标签不至于窄成一条）").toMatch(/min-width:\s*\d+px/);

    const name = cssDecls(css.match(/\n\.tab-name\s*\{[^}]*\}/)?.[0] ?? "");
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

describe("标签药丸与标签栏滚动条（B55）", () => {
  it("B55：标签改成 Modern UI 药丸（无描边、圆角 4px、非活动文字 50%）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tab = css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tab, "应有 .tab 规则").toBeTruthy();
    const h = tab.match(/height:\s*(\d+)px/);
    expect(h, "标签高度必须显式给出（字号档位变化时栏高才恒定）").toBeTruthy();
    expect(Number(h![1]), "药丸高 24px（VS Code Modern UI 常规档）").toBeLessThanOrEqual(26);
    expect(tab, "药丸必须无描边（B54 的 1px 描边是旧观感）").toMatch(/border:\s*none/);
    expect(tab, "药丸圆角 4px").toMatch(/border-radius:\s*4px/);
    expect(tab, "不得退回上圆角方标签").not.toContain("6px 6px 0 0");
    expect(tab, "非活动文字降到 50% 前景（VS Code color-mix 写法）").toMatch(
      /color:\s*color-mix\(in srgb, var\(--fg\) 50%, transparent\)/,
    );

    const active = css.match(/\n\.tab-active\s*\{[^}]*\}/)?.[0] ?? "";
    expect(active, "活动标签只靠药丸底色区分").toContain("var(--tab-bg-active)");
    expect(active, "活动标签不得再有描边").not.toContain("border");

    const hover = css.match(/\.tab:hover:not\(\.tab-active\)\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hover, "悬停要有独立一档底色").toContain("var(--tab-bg-hover)");

    // 三档底色两套主题都要齐：缺一个就是某个主题下某状态完全没有反馈
    for (const [name, block] of [
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
    ] as const) {
      for (const v of ["--tab-bg-hover:", "--tab-bg-active:", "--tab-bg-active-hover:"]) {
        expect(block, `${name}主题必须定义 ${v}`).toContain(v);
      }
    }

    // tab-flash 结束态必须回到药丸底色。写 var(--bg) 会「闪完变回旧配色」——
    // 一帧的视觉 bug，运行时测不出来，只能静态锁死。
    const flash = css.match(/@keyframes tab-flash\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(flash, "应有 tab-flash 关键帧").toBeTruthy();
    expect(flash, "结束态必须回到药丸底色").toContain("background: var(--tab-bg-active)");
    expect(flash, "关键帧不得再引用旧配色 var(--bg)").not.toContain("var(--bg))");
  });
  it("B55：标签栏滚动条 4px，正好塞进药丸行下方那 4px 间隙", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = css.match(/\n\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    // 关键坑：元素上指定 scrollbar-width/color 后 Chromium 会忽略 ::-webkit-scrollbar，
    // 标签栏就拿回系统滚动条（两端带箭头、压不细）。必须复位成 auto。
    expect(strip, "scrollbar-width 必须复位为 auto").toMatch(/scrollbar-width:\s*auto/);
    expect(strip, "scrollbar-color 必须复位为 auto").toMatch(/scrollbar-color:\s*auto/);
    expect(strip, "药丸之间要有 4px 间距").toMatch(/gap:\s*4px/);
    expect(strip, "下内边距为 0（下方 4px 让给滚动条）").toMatch(/padding:\s*4px 4px 0/);

    const thin = css.match(/\.panel-tabstrip::-webkit-scrollbar\s*\{[^}]*\}/)?.[0] ?? "";
    expect(thin, "必须有 webkit 滚动条规则").toBeTruthy();
    const bar = Number(thin.match(/height:\s*(\d+)px/)?.[1]);
    expect(bar, "滚动条 4px").toBe(4);

    const btn = css.match(/\.panel-tabstrip::-webkit-scrollbar-button\s*\{[^}]*\}/)?.[0] ?? "";
    expect(btn, "必须显式去掉两端箭头按钮").toBeTruthy();
    expect(btn, "箭头按钮必须 display:none").toMatch(/display:\s*none/);

    // 几何自洽：32 = 4(上间距) + 24(药丸) + 4(滚动条)。三个数绑在一起，
    // 改一个必须改全部，否则滚动条会压到药丸上（或药丸行被挤下去）。
    const tabH = Number(css.match(/\n\.tab\s*\{[^}]*\}/)![0].match(/height:\s*(\d+)px/)![1]);
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    expect(stripH - tabH, "药丸行上下各留 4px，滚动条正好吃下面那 4px").toBe(bar * 2);

    // 拖拽插入线必须跟着药丸行走，且让开滚动条那 4px（B55 计划的头号雷点）
    const insert = css.match(/\.tab-insert\s*\{[^}]*\}/)?.[0] ?? "";
    expect(insert, "拖拽插入线必须与药丸行等高").toMatch(/top:\s*4px/);
    expect(insert, "拖拽插入线必须让开滚动条").toMatch(/bottom:\s*4px/);
  });
});
