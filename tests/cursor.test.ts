// @vitest-environment jsdom
// B111 光标约定：**有点击效果的元素一律是手型（hand）**。
//
// 起因（用户反馈）：设置页左栏的分类按钮 `cursor: default`，悬停有高亮、点得动，
// 指针却是箭头 —— 观感上像「不可点」。顺带查出一处同类：设置页右上角关闭键
// （`.settings-close`）也是 `default`，同样带 hover 高亮。
//
// 约定（写在这里是为了能被机器守住，不只是注释）：
//   · 全局已有 `button { cursor: pointer }`，所以**新增一个 button 天然是 hand**；
//     出问题的一定是某条规则**显式覆盖**成了别的指针。
//   · `cursor: default` **只允许**出现在「点了没反应」的元素上：置灰项（:disabled）、
//     明确不可点的变体（`.sb-lang:not(.sb-btn)`）、提示层（`.tooltip`，本身
//     `pointer-events: none`）。
//   · 分隔条 / 拖拽把手用 `ew-resize`、`ns-resize`、`all-scroll`，那是**语义光标**，
//     不属于本约定（改它们反而是错的）—— 见下面白名单之外的处理。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ruleBlock, cssDecls, stripCssComments } from "./static";

/**
 * 扫出所有写了 `cursor: default`、但**不属于**「不可点」的规则。
 *
 * ⚠️ 必须先 `stripCssComments` 再用 `[^}]*` 扫：块内注释里若出现 `}`，扫描会截断
 * （与 `tests/static.ts` 里 `themeBlock` 那条注释记的是同一个坑）。
 */
interface DefaultCursorScan {
  /** 所有写了 `cursor: default` 的选择器（含被判定为「允许」的）。 */
  all: string[];
  /** 其中**不属于**「点了没反应」的那些 —— 即违规项。 */
  offenders: string[];
}

function scanDefaultCursors(css: string): DefaultCursorScan {
  const code = stripCssComments(css);
  // 捕获「上一条规则结束 → 本条规则 `{`」之间的文本，即选择器（可能跨行、可能是列表）
  const re = /([^{}]+)\{[^}]*?cursor:\s*default/g;
  const all: string[] = [];
  const offenders: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    for (const raw of m[1].split(",")) {
      const sel = raw.trim().replace(/\s+/g, " ");
      if (!sel) continue;
      all.push(sel);
      // 允许的三种「点了没反应」：置灰、明确不可点的变体、提示层
      const ok =
        sel.includes(":disabled") ||
        sel.includes(".sb-lang:not(.sb-btn)") ||
        sel.includes(".tooltip");
      if (!ok) offenders.push(sel);
    }
  }
  return { all, offenders };
}

function offendersOf(css: string): string[] {
  return scanDefaultCursors(css).offenders;
}

describe("B111 设置页：可点击元素必须是手型", () => {
  it("左栏分类与关闭键都是 pointer", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(
      cssDecls(ruleBlock(css, ".settings-nav-item")),
      "左栏分类是按钮、有 hover 与选中态，指针必须是 hand",
    ).toContain("cursor: pointer");
    expect(
      cssDecls(ruleBlock(css, ".settings-close")),
      "关闭键有 hover 高亮，指针必须是 hand",
    ).toContain("cursor: pointer");
  });
});

describe("B111 全应用：cursor: default 只允许出现在不可点/置灰处", () => {
  it("基准：现存 5 处 default 全都是不可点或置灰的", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const code = stripCssComments(css);
    const scan = scanDefaultCursors(css);
    // 自证扫描器不是空转：必须真的扫到现存那几处，否则「offenders 为空」可能只是没扫到。
    // ⚠️ 只断言「扫到了 + 每条声明的选择器都进来了」，不锁死具体条数 —— 选择器列表
    //   （如 `.find-nav:disabled, .find-sel:disabled, …` 共用一条声明）会展开成多条，
    //   写死数字会让「新增一处合法的 default」变成假红。违规由 offenders 兜住。
    const decls = (code.match(/cursor:\s*default/g) ?? []).length;
    expect(decls, "应扫到 cursor: default 声明").toBeGreaterThan(0);
    expect(
      scan.all.length,
      "每条声明的选择器都应被扫到（选择器列表会展开成多条）",
    ).toBeGreaterThanOrEqual(decls);
    expect(scan.offenders, "现存 default 都应属于不可点/置灰").toEqual([]);
  });

  it("反向验证：给可点元素写回 default，守卫必须抓到（否则上面那条是恒真）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const broken = css + "\n.settings-nav-item { cursor: default; }\n";
    expect(offendersOf(broken), "退化写法必须被抓").toContain(".settings-nav-item");
    expect(offendersOf(broken).length, "退化只应额外报出违规的那一条（原 5 处仍判为允许）").toBe(
      offendersOf(css).length + 1,
    );
  });
});
