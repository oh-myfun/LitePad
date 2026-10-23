// @vitest-environment jsdom
// B350 · 全应用 tooltip 归两档，且每档只有一处定义。
//
// 用户口径：「按钮功能使用带小尖尖的样式，文本类的使用不带小尖尖的，两类都是当前已经存在的，
// 是需要统一进行复用。」两档的机制早就有了（`src/shell/tooltip.ts`，取自 VS Code 的
// `placement: 'element'` / `'mouse'`），散在各处的是**取值**：文本类三处（标签 / 大纲 / 最近打开）
// 各抄一遍 `follow: true, compact: true`，资源管理器的树行干脆退回原生 `title`，
// 冲突框与保存确认框的按钮也各写各的 `title` ⇒ 深色界面里冒出系统浅色气泡。
//
// 交付物因此有两件：
//   ① `setTextTip()` —— 把「文本类」那一档的取值收进唯一一处（`follow` + `compact`）；
//   ② 全应用不再有原生 `title`（`document.title` 除外，那是窗口标题，不是提示）。
//
// `compact` 不进「一处定义」的闸：动作条那类按钮（标签上的 ×）在 VS Code 里同样是紧凑档
// （`actionbar.ts` 的 hover delegate 写死 `appearance.compact`），它带尖尖却不跟鼠标，
// 是「按钮档 + 紧凑」的组合，必须由调用方自己写 —— 收进 helper 反而会把按钮误升级成文本档。

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectTextFiles, stripLineComments } from "./static";
import { setTip, setTextTip, resetTooltipsForTest } from "../src/shell/tooltip";

/** src 下所有 .ts（判据要扫全仓，不能只盯我改过的那几个文件）。 */
const SRC_TS = collectTextFiles("src").filter((f) => f.endsWith(".ts"));

/** 去掉注释后再判：`follow: true` 这种字样在文件头的出处说明里出现过，散文会把闸喂假。 */
function codeOnly(src: string): string {
  return stripLineComments(src).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 原生 title 的扫描面：`document.title` 是窗口标题，不在这一族里。 */
function nativeTitleHits(src: string): string[] {
  const noDoc = codeOnly(src).replace(/document\.title/g, "");
  return [
    ...noDoc.matchAll(/\b[A-Za-z_$][\w$]*\.title\s*=[^=]/g),
    ...noDoc.matchAll(/setAttribute\(\s*["']title["']/g),
  ].map((m) => m[0].trim());
}

/** 某处 `setTextTip(<firstArg>, …)` 的完整调用（容 prettier 折行）。 */
function callOf(src: string, fn: string, firstArg: string): string {
  return new RegExp(`${fn}\\(${firstArg},[\\s\\S]{0,220}?\\);`).exec(src)?.[0] ?? "";
}

afterEach(() => resetTooltipsForTest());

describe("两档只差在选项上（真 DOM）", () => {
  it("setTip = 按钮档：不写 follow ⇒ 按元素定位、画小尖尖", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    setTip(btn, "关闭", { key: "Ctrl+W" });
    expect(btn.dataset.tip).toBe("关闭");
    expect(btn.dataset.tipFollow, "按钮档不许跟鼠标").toBeUndefined();
    btn.remove();
  });

  it("setTextTip = 文本档：follow + compact 自动带上，opts 只补差异", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    setTextTip(row, "D:\\笔记\\a.md", { group: "explorer", detail: "2 分钟前" });
    expect(row.dataset.tip).toBe("D:\\笔记\\a.md");
    expect(row.dataset.tipFollow, "跟鼠标 ⇒ 提示层 data-pointer=false ⇒ 不画尖尖").toBe("1");
    expect(row.dataset.tipCompact, "12px 紧凑档").toBe("1");
    expect(row.dataset.tipGroup, "group 由调用方给").toBe("explorer");
    expect(row.dataset.tipDetail).toBe("2 分钟前");
    row.remove();
  });

  it("两档是同一套机制的两个取值，不是两套实现", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);
    setTip(a, "x", { follow: true, compact: true });
    setTextTip(b, "x");
    expect(b.dataset.tipFollow).toBe(a.dataset.tipFollow);
    expect(b.dataset.tipCompact).toBe(a.dataset.tipCompact);
    a.remove();
    b.remove();
  });
});

describe("一处定义：跟鼠标那一档的开关不许再抄第二遍", () => {
  it("follow: true 只许出现在 tooltip.ts 内部", () => {
    const offenders = SRC_TS.filter(
      (f) =>
        !f.endsWith(join("shell", "tooltip.ts")) &&
        /follow:\s*true/.test(codeOnly(readFileSync(f, "utf-8"))),
    ).map((f) => f.replace(/\\/g, "/"));
    expect(offenders, "这些文件还在内联档位开关 ⇒ 改一处会漏一片").toEqual([]);

    // 反向替身：把最近打开那处退回迁移前的内联写法，判据必须抓到它。
    const before = readFileSync("src/recents/panel.ts", "utf-8");
    const regressed = before.replace(
      "setTextTip(row, e.path, {",
      "setTip(row, e.path, {\n    follow: true,",
    );
    expect(regressed, "替身必须真的替换过（否则反向验证空转）").not.toBe(before);
    expect(/follow:\s*true/.test(codeOnly(regressed)), "退化替身应被抓到").toBe(true);
  });
});

describe("文本类逐个经 setTextTip", () => {
  // [文件, 第一个参数, 文案里必须留下的东西] —— 文案不许在迁移中被改丢：
  // 文本类给的就是「眼前被截断的那个东西的全称」。
  const TEXT_SITES: [string, string, string][] = [
    ["src/shell/tabstrip.ts", "el", "tip"], // 标签：全路径（只读时尾巴上 [只读]）
    ["src/markdown/toc.ts", "item", "第 ${node.entry.line} 行"], // 大纲：行号
    ["src/recents/panel.ts", "row", "e.path"], // 最近打开：全路径
    ["src/explorer/panel.ts", "row", "e.path"], // 资源管理器树行（B350 前是原生 title）
    ["src/explorer/panel.ts", "rootRow", "root"], // 树根那一行
    ["src/shell/commandpalette.ts", "row", "item.note"], // 命令面板行的说明
    ["src/shell/keymapdialog.ts", "name", "cmd.note"], // 键位表那列命令说明
  ];

  for (const [file, arg, text] of TEXT_SITES) {
    it(`${file} 的 ${arg} 走文本档，文案仍是 ${text}`, () => {
      const src = readFileSync(file, "utf-8");
      const c = callOf(src, "setTextTip", arg);
      expect(c, `没找到 setTextTip(${arg}, …)`).not.toBe("");
      expect(c, "文案被改动了").toContain(text);
    });
  }

  it("反向：退回 setTip 的替身必须抠不到", () => {
    const src = readFileSync("src/explorer/panel.ts", "utf-8");
    const regressed = src.replace("setTextTip(row, e.path", 'setTip(row, e.path, { group: "x" ');
    expect(regressed, "替身必须真的替换过").not.toBe(src);
    expect(callOf(regressed, "setTextTip", "row")).toBe("");
  });
});

describe("全应用不再有原生 title", () => {
  it("src 下每个 .ts 都不许再写 title 属性（document.title 除外）", () => {
    const offenders = SRC_TS.map(
      (f) => [f.replace(/\\/g, "/"), nativeTitleHits(readFileSync(f, "utf-8"))] as const,
    )
      .filter(([, hits]) => hits.length > 0)
      .map(([f, hits]) => `${f}: ${hits.join(", ")}`);
    expect(offenders, "原生 title 由系统绘制：不吃主题、没有延迟口径").toEqual([]);

    // 反向替身：把冲突框那一句原样塞进一个干净文件，判据必须抓到。
    const clean = readFileSync("src/shell/updater.ts", "utf-8");
    expect(nativeTitleHits(clean), "替身基底必须是干净的").toEqual([]);
    expect(nativeTitleHits(`${clean}\n  keep.title = "编辑器内容不动";\n`)).toEqual([
      "keep.title =",
    ]);
    // 同一段里 document.title 不算命中（那是窗口标题，与提示无关）。
    expect(nativeTitleHits("document.title = name;")).toEqual([]);
  });

  it("对话框按钮走按钮档（带尖尖），不许顺手升成文本档", () => {
    for (const f of ["src/shell/conflictdialog.ts", "src/shell/saveconfirm.ts"]) {
      const src = codeOnly(readFileSync(f, "utf-8"));
      expect(src, `${f} 应引用 setTip`).toMatch(/import\s*\{[^}]*\bsetTip\b[^}]*\}\s*from/);
      expect(src, `${f} 是按钮，不该用文本档`).not.toMatch(/setTextTip\(/);
    }
  });
});
