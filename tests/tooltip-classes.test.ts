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
  it("setTip 按钮档 / setTextTip 文本档：同一套机制的两个取值", () => {
    const btn = document.createElement("button");
    const row = document.createElement("div");
    const same = document.createElement("div");
    document.body.append(btn, row, same);
    setTip(btn, "关闭", { key: "Ctrl+W" });
    expect(btn.dataset.tip).toBe("关闭");
    expect(btn.dataset.tipFollow, "按钮档不许跟鼠标").toBeUndefined();

    setTextTip(row, "D:\\笔记\\a.md", { group: "explorer", detail: "2 分钟前" });
    expect(row.dataset.tip).toBe("D:\\笔记\\a.md");
    expect(row.dataset.tipFollow, "跟鼠标 ⇒ 提示层 data-pointer=false ⇒ 不画尖尖").toBe("1");
    expect(row.dataset.tipCompact, "12px 紧凑档").toBe("1");
    expect(row.dataset.tipGroup, "group 由调用方给").toBe("explorer");
    expect(row.dataset.tipDetail).toBe("2 分钟前");

    // 文本档不是另写一套：手写同等选项必须落到同一组 data 上。
    setTip(same, "x", { follow: true, compact: true });
    expect(same.dataset.tipFollow).toBe(row.dataset.tipFollow);
    expect(same.dataset.tipCompact).toBe(row.dataset.tipCompact);
    btn.remove();
    row.remove();
    same.remove();
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
    // 资源管理器树行（B350 前是原生 title）。B427 起常规树与过滤结果共用 `rowOf()` 画行，
    // 文案那一位换成了它的形参 `path`（同样是**全路径**，不是名字）。
    ["src/explorer/panel.ts", "row", 'path, { group: "explorer" }'],
    ["src/explorer/panel.ts", "el", "root"], // 树根那一行（B424：每根一行，元素局部名是 el）
    ["src/shell/commandpalette.ts", "row", "item.note"], // 命令面板行的说明
    ["src/shell/keymapdialog.ts", "name", "cmd.note"], // 键位表那列命令说明
  ];

  it("每一处文本类都走 setTextTip，文案仍是全称；退回 setTip 的替身必须抠不到", () => {
    for (const [file, arg, text] of TEXT_SITES) {
      const src = readFileSync(file, "utf-8");
      const c = callOf(src, "setTextTip", arg);
      // 逐处断言仍带文件名：合并成一条用例后，红的时候照样能指认是哪一处漏了。
      expect(c, `${file}：没找到 setTextTip(${arg}, …)`).not.toBe("");
      expect(c, `${file}：文案被改动了`).toContain(text);
    }

    // 反向替身：把资源管理器树行的文本档退回按钮档，上面的判据必须抠不到。
    const src = readFileSync("src/explorer/panel.ts", "utf-8");
    const regressed = src.replace("setTextTip(row, path", 'setTip(row, path, { group: "x" ');
    expect(regressed, "替身必须真的替换过").not.toBe(src);
    expect(callOf(regressed, "setTextTip", "row")).toBe("");
  });
});

describe("全应用不再有原生 title", () => {
  it("src 下每个 .ts 都不许再写 title 属性；对话框按钮走按钮档而非文本档", () => {
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

    // 对话框按钮是「按钮档」：复用 setTip，不许顺手升成文本档（否则带尖尖的样式丢了）。
    for (const f of ["src/shell/conflictdialog.ts", "src/shell/saveconfirm.ts"]) {
      const src = codeOnly(readFileSync(f, "utf-8"));
      expect(src, `${f} 应引用 setTip`).toMatch(/import\s*\{[^}]*\bsetTip\b[^}]*\}\s*from/);
      expect(src, `${f} 是按钮，不该用文本档`).not.toMatch(/setTextTip\(/);
    }
  });
});

// B427 · 用户报：「搜索边栏中，搜索输入框中的三个小按钮缺失tooltip。」
// 同族缺口其实五颗（替换框的「保留大小写」、展开区的「仅在打开的编辑器中搜索」与
// 「使用排除设置与忽略文件」也一样没写）。判据按**形状**判、不写名单：侧栏里每一颗
// `.find-toggle` 都必须带非空 `data-tip` —— 以后加一颗新的忘了写也会被咬住（B353/B356 的教训）。
describe("B427 · 侧栏搜索里每一颗 .find-toggle 都自带提示", () => {
  const html = readFileSync("index.html", "utf-8").replace(/\r\n/g, "\n");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const toggles = [...doc.querySelectorAll<HTMLElement>(".find-toggle")];
  const tipsOf = (root: Document): string[] =>
    [...root.querySelectorAll<HTMLElement>(".find-toggle")]
      .filter((b) => !(b.getAttribute("data-tip") ?? "").trim())
      .map((b) => b.id || "(无 id)");
  const tipOf = (id: string): string => doc.getElementById(id)?.getAttribute("data-tip") ?? "";

  it("每一颗都有提示、三颗与悬浮栏同字；抠掉一颗必须被抓到", () => {
    // 先数一遍夹具，免得对着空集放行。
    expect(toggles.length, "侧栏搜索至少五颗 .find-toggle").toBeGreaterThanOrEqual(5);
    expect(tipsOf(doc), "这几颗没有提示（悬停什么也不会出现）").toEqual([]);

    // 悬浮查找栏那三颗在 `findbar.ts` 里是 `toggle(图标, aria 名, 提示)`；按**图标**配对，
    // 不按顺序也不按 aria 名 —— 那边正则那颗的 aria 名叫「正则」，这边叫「使用正则表达式」。
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    const barTips = new Map(
      [...bar.matchAll(/toggle\("(\w+)", "[^"]*", "([^"]*)"\)/g)].map((m) => [m[1], m[2]]),
    );
    const pairs: [string, string][] = [
      ["search-case", "caseSensitive"],
      ["search-word", "wholeWord"],
      ["search-regex", "regex"],
    ];
    for (const [id, icon] of pairs) {
      const fromBar = barTips.get(icon);
      expect(fromBar, `findbar.ts 里找不到图标 ${icon} 那颗`).toBeTruthy();
      expect(tipOf(id), `${id} 的提示要与悬浮查找栏那颗 ${icon} 同字`).toBe(fromBar);
    }

    // 反向：把一颗的 data-tip 抠掉，判据必须抓到（证明它真有鉴别力）。
    // B427 之后「使用正则表达式」这句提示在 index.html 里有两处（侧栏搜索 + 资源管理器过滤框），
    // 所以替身要**锚在那颗 id 上**抠，按文案裸替换会抠错行、把判据验成另一颗。
    const broken = html.replace(/(id="search-regex"[\s\S]*?)data-tip="使用正则表达式"/, "$1");
    expect(broken, "替身必须真的改动了原文").not.toBe(html);
    const doc2 = new DOMParser().parseFromString(broken, "text/html");
    expect(tipsOf(doc2)).toEqual(["search-regex"]);
  });
});
