// @vitest-environment jsdom
// 反向验证：**静态断言工具自身**不得失真。
//
// 为什么单独一个文件：`tests/static.ts` 里的 themeBlock / ruleBlock / cssDecls /
// stripLineComments / stripCssComments / topLevelFnBody 是**所有静态契约用例的地基**。地基一旦失真，
// 上面几十条用例会集体变成假绿或假红 —— 而它们自己看起来还是「正常的断言」。
// 所以这里锁的不是业务，是**工具本身**：
//   · 退化写法（`\{[^}]*\}` 一类）在什么输入下会失真；
//   · 正确写法在同一输入下必须仍然取到完整块体；
//   · 断言对象被挖掉时，工具必须**如实反映缺失**（`toContain` 不能是恒真）。
//
// 来源：原 `scripts/reverse-verify-B7x.cjs` 里的「甲、守卫基建」那几组探针
// （见 pitfalls/0075：旧写法被块内注释里的花括号截断）。脚本那层要临时改写真实源码、
// 且已随 regressions.test.ts 退役；能在测试里证明的这一半搬到这里，
// 随 `npm test` 一起跑，零副作用。

import { describe, it, expect } from "vitest";
import {
  themeBlock,
  ruleBlock,
  cssDecls,
  stripLineComments,
  stripCssComments,
  topLevelFnBody,
} from "./static";

// 变量块里塞一条**含花括号的注释**：旧写法 `\{[^}]*\}` 会从注释里的 `}` 处截断。
// ⚠️ 注释必须用 CSS 的 `/* */` —— themeBlock / cssDecls 只剥这一种；
//    用 `//` 的话 CSS 里本就不是注释，剥不掉属于预期行为。
const CSS = `:root[data-theme="dark"] {
  --bg: #1b1d1f;
  /* 探针：注释里的花括号 {A,B} 不该影响取值 */
  --tip-bg: #2b2d2f;
}
`;

describe("反向验证：themeBlock 不得被块内注释截断（守卫基建）", () => {
  it("基准：注释之后声明的变量仍取得到（含花括号的注释不影响配对）", () => {
    const block = themeBlock(CSS, "dark");
    expect(block, "应取到完整块体").toBeTruthy();
    expect(block, "注释之前的变量要取到").toContain("--bg");
    expect(block, "注释之后的变量也要取到").toContain("--tip-bg");
  });

  it("退化：旧的 `\\{[^}]*\\}` 写法会被注释里的花括号截断 → 后面的变量整片消失", () => {
    const naive = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    // ⚠️ 先自证退化写法**确实跑了**：它得先取到东西，才有资格谈「取少了」。
    //    否则「取不到」也可能只是正则没匹配上，证明不了截断这回事。
    expect(naive, "退化写法应当匹配上了（这样才能谈它取少了）").toContain("--bg");
    expect(naive, "截断之后注释后面的变量就没了 —— 这正是旧写法的失真点").not.toContain("--tip-bg");
    // 与基准对照：两者结果不同 ⇒ 「块内含 --tip-bg」这条正向断言不是恒真。
    expect(themeBlock(CSS, "dark")).not.toBe(naive);
  });

  it("退化对照：变量被挖掉时，块体必须如实反映缺失（否则 toContain 是恒真）", () => {
    const gutted = CSS.replace("  --tip-bg: #2b2d2f;\n", "");
    expect(gutted, "前置条件：确实挖掉了").not.toContain("--tip-bg");
    expect(themeBlock(gutted, "dark"), "工具必须如实反映「没有了」").not.toContain("--tip-bg");
    expect(themeBlock(gutted, "dark"), "同块内其它变量不受影响").toContain("--bg");
  });

  it("深浅两块互不串味（旧写法会跨块拿浅色的值顶包）", () => {
    const both = `${CSS}
:root[data-theme="light"] {
  --bg: #ffffff;
  --tip-bg: #f3f3f3;
}
`;
    expect(themeBlock(both, "dark"), "深色块取深色值").toContain("#1b1d1f");
    expect(themeBlock(both, "light"), "浅色块取浅色值").toContain("#f3f3f3");
  });
});

describe("反向验证：cssDecls / ruleBlock 的取值边界", () => {
  it("cssDecls 剥掉块注释（注释里写的旧值不得影响断言）", () => {
    const block = "  flex: 0 1 auto; /* 旧值：flex: 1 */";
    expect(cssDecls(block), "注释必须剥掉").not.toContain("旧值");
    expect(cssDecls(block), "声明本身要留着").toContain("flex: 0 1 auto");
  });

  it("退化：不剥注释时，`not.toMatch(旧值)` 会被自己的文档误伤（静默通过）", () => {
    const block = "  flex: 0 1 auto; /* 旧值：flex: 1 */";
    // 不剥注释：断言「不得再出现 flex: 1」会命中**注释里的旧值** → 假红；
    // 反过来，若断言的是 `not.toContain("flex: 0 1 auto")` 之类就会因注释兜底而假绿。
    expect(block, "退化写法仍能在注释里看到旧值（这就是失真的来源）").toContain("flex: 1");
    expect(cssDecls(block), "剥掉之后旧值消失 —— 两者结果不同，说明剥离是有效的").not.toContain(
      "flex: 1",
    );
  });

  it("ruleBlock 不会误命中「属性值里提到的同名选择器」", () => {
    const css = '.a { content: ".find-x"; }\n.find-x { position: absolute; }\n';
    const body = ruleBlock(css, ".find-x", "position");
    expect(body, "应按声明命中真正那一条").toContain("position: absolute");
    expect(body, "不得把属性值里的那处当规则体").not.toContain("content:");
  });
});

describe("反向验证：stripLineComments / topLevelFnBody 的截断点", () => {
  it("剥整行注释，但行内的 //（如 URL）保留", () => {
    const src = '// 整行注释：persistSettings()\nconst url = "https://x/";\ncode();\n';
    const stripped = stripLineComments(src);
    expect(stripped, "整行注释必须剥掉").not.toContain("整行注释");
    expect(stripped, "URL 里的 // 是行内内容，不得误剥").toContain("https://x/");
    expect(stripped, "代码行要留着").toContain("code();");
  });

  it("退化：不剥注释时，注释里复述的标识符会让源码断言假绿", () => {
    // B79 的真实坑：注释里原样写了 `persistSettings()`，挖掉真正的调用后
    // 比对整份文件照样通过 —— 断言的是注释，不是代码。
    const gutted = "// 记得调 persistSettings()\nfunction boot() {\n}\n";
    expect(gutted, "退化写法：整份文件里还能看到那个标识符").toContain("persistSettings()");
    expect(stripLineComments(gutted), "剥掉注释后就找不到了 —— 断言这才落在代码上").not.toContain(
      "persistSettings()",
    );
  });

  it("topLevelFnBody 不会在多行返回类型字面量的 `}` 处截断", () => {
    // ⚠️ 只找第一条 `\n}` 会在**签名**处就收尾（B71 ④ 踩过）。
    const src = ["function f(): {", "  a: number;", "} {", "  return { a: 1 };", "}", ""].join(
      "\n",
    );
    const body = topLevelFnBody(src, "function f()");
    expect(body, "函数体里的返回语句要取到").toContain("return { a: 1 }");
    expect(body, "不得在类型字面量处就收尾").not.toMatch(/^\s*a: number;\s*\}\s*$/);
  });
});

describe("反向验证：stripCssComments 不得被「删除说明」注释误伤", () => {
  it("基准：块注释剥掉，规则文本留着（注释里提过的选择器不再出现）", () => {
    const css = [".title-bar {", "  height: 34px;", "}", "", "/* 原来的 .tool-btn 已删 */"].join(
      "\n",
    );
    const stripped = stripCssComments(css);
    expect(stripped, "规则要留着").toContain(".title-bar {");
    expect(stripped, "注释里提到的旧类名必须随注释一起消失").not.toContain(".tool-btn");
  });

  it("退化：不剥注释时，「旧类名必须已删除」会被自己的说明注释判成假红", () => {
    // B97 的真实坑：删掉顶栏快捷按钮那套样式后，交付里**留了一行注释**交代去向
    // （「原先 .toolbar-actions / .tool-btn 一套规则只服务于那 8 颗按钮……直接删掉」）。
    // 规则确实删干净了（只剩这一处提及），但断言比对原文 → 报红，指向一行无害的注释。
    const css =
      "button { color: red; }\n/* 原先 .tool-btn 一套规则只服务于那 8 颗按钮，直接删掉 */\n";
    expect(css, "退化写法：原文里仍搜得到那个类名（其实只是注释）").toContain(".tool-btn");
    expect(stripCssComments(css), "过一层剥离后才如实反映「规则已删」").not.toContain(".tool-btn");
    expect(stripCssComments(css), "真规则不能一起剥掉").toContain("color: red");
  });

  it("退化对照：规则真的还在时，剥离后必须仍搜得到（否则 not.toContain 是恒真）", () => {
    const css = "/* 说明 */\n.tool-btn { width: 28px; }\n";
    expect(stripCssComments(css), "规则尚存时断言必须咬得住").toContain(".tool-btn");
  });
});
