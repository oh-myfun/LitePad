// @vitest-environment jsdom
// B461 · Task 4 —— 差异步进的**入口契约**：两条命令进表、键位没抢别人的、上下文闸与分发接上。
//
// 这一层判的是「一条命令从键到动作的那条线断没断」，跨 `keymap.ts` / `main.ts` 两个文件，
// 单测里没法只靠一颗纯函数钉住 ⇒ 用仓库既定的**结构判据**（`explorer-contract` /
// `gutter-diff-wiring` / `sync-scroll-sequence` 同形）配**真跑的注册表断言**：
//   1) 表里就是那两条（id / label / group / 键位字面量逐字钉死 —— 改一个字的文案都发红）；
//   2) 那两颗键位**在本应用无人占**：不靠眼看表，靠 `duplicateKeys({})` 为空 +
//      「谁家的键」扫一遍整张表 + `resolveCommand` 真按出这两条（裸 `F5` 仍是插入时间/日期）；
//   3) 上下文闸与分发：不成时**不抢键**（把 `Alt+F5` 还给系统），成时走 `step(±1)`；
//   4) 键位字面量只许出现在 `src/shell/keymap.ts` 这一处（B389 立下的纪律）。
//
// ⚠️ `Alt+F5` / `Shift+Alt+F5` 是 VS Code「Go to Next/Previous Change」的实拍键位，
// 这条来历记在代码注释里就够了 —— 用户可见文案一律不写「复刻」二字（本产品的既定口径）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { collectTextFiles, fnBody } from "./static";
import {
  COMMANDS,
  commandById,
  duplicateKeys,
  effectiveKeys,
  keyHint,
  normalizeSpec,
  parseKey,
  resolveCommand,
} from "../src/shell/keymap";

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

/** 现在真拿着这颗键位的命令 id（按**规范化后**比对，`Alt+Shift+F5` 与 `Shift+Alt+F5` 是一家）。 */
function owners(spec: string): string[] {
  return COMMANDS.filter((c) => c.keys.some((k) => normalizeSpec(k) === spec)).map((c) => c.id);
}

describe("B461 · 差异步进两条命令进表（Task 4 Step 5/6）", () => {
  it("B461 · 表里就是那两条：id / label / group / 键位逐字", () => {
    expect(commandById("diff.nextChange")).toMatchObject({
      id: "diff.nextChange",
      label: "下一个差异",
      group: "差异",
      keys: ["Alt+F5"],
    });
    expect(commandById("diff.prevChange")).toMatchObject({
      id: "diff.prevChange",
      label: "上一个差异",
      group: "差异",
      keys: ["Shift+Alt+F5"],
    });
    // 本任务只加这两条（其余那一族归 Task 8）⇒ 表里 `diff.` 打头的命令到此为止。
    expect(COMMANDS.filter((c) => c.id.startsWith("diff.")).map((c) => c.id)).toEqual([
      "diff.nextChange",
      "diff.prevChange",
    ]);
  });

  it("B461 · effectiveKeys 交出那两颗键，且 duplicateKeys 仍为空（键位没撞车）", () => {
    expect(effectiveKeys("diff.nextChange", {})).toEqual(["Alt+F5"]);
    expect(effectiveKeys("diff.prevChange", {})).toEqual(["Shift+Alt+F5"]);
    // 提示语走的是**规范化**那一档：`formatBinding` 的修饰键次序是 Ctrl→Alt→Shift
    // （与 `keyHint("panel.splitV")` 交的 `Alt+Shift+↓` 同一口径），所以按出来的显示名是
    // `Alt+Shift+F5`。表里声明的仍是 VS Code 那串写法 —— 两处都是那颗键，只是拼法不同。
    expect(keyHint("diff.nextChange", {})).toBe("Alt+F5");
    expect(keyHint("diff.prevChange", {})).toBe("Alt+Shift+F5");
    // 整张表自我检查：加了这两条之后仍然一处重复都没有 ⇒ 这两颗键本来就是空的
    expect(duplicateKeys({})).toEqual([]);
  });

  it("B461 · F5 一族三家各占一档，互不越界（裸 F5 仍是插入时间/日期）", () => {
    expect(owners("Alt+F5")).toEqual(["diff.nextChange"]);
    expect(owners("Alt+Shift+F5")).toEqual(["diff.prevChange"]);
    expect(owners("F5")).toEqual(["edit.timeDate"]);
    // 用户可改键的那一档：这两条必须是**可编辑**的（非 `editable: false` 的内置项）
    for (const id of ["diff.nextChange", "diff.prevChange"]) {
      expect(commandById(id)?.editable, `${id} 是应用自己的命令`).not.toBe(false);
      expect(parseKey(commandById(id)!.keys[0]), "键位串必须可解析").toBeTruthy();
    }
  });

  it("B461 · 事件真按得出这两条（分发口），修饰键多一颗少一颗都不算", () => {
    expect(resolveCommand(key({ code: "F5", key: "F5", altKey: true }), {})).toBe(
      "diff.nextChange",
    );
    expect(resolveCommand(key({ code: "F5", key: "F5", altKey: true, shiftKey: true }), {})).toBe(
      "diff.prevChange",
    );
    // 反向闸：这一族的邻居不许被抢走 —— 裸 F5 还是「插入时间/日期」（且它 `force: true`）；
    // 少一颗 Alt 的那一发没人绑 ⇒ 谁都不命中，也**不许**命中 `diff.prevChange`。
    expect(resolveCommand(key({ code: "F5", key: "F5" }), {})).toBe("edit.timeDate");
    expect(
      resolveCommand(key({ code: "F5", key: "F5", shiftKey: true }), {}),
      "Shift+F5 没人绑 ⇒ 不许当成「上一个差异」",
    ).toBeNull();
    expect(
      resolveCommand(key({ code: "F5", key: "F5", altKey: true, ctrlKey: true }), {}),
      "Ctrl+Alt+F5 没人绑 ⇒ 不许命中任何命令",
    ).toBeNull();
    // 用户解绑之后彻底不抢（覆盖表按 id 存，与有无默认无关）
    expect(
      resolveCommand(key({ code: "F5", key: "F5", altKey: true }), { "diff.nextChange": "" }),
    ).toBeNull();
  });

  it("B461 · 上下文闸与分发接在 main.ts：不成时不抢键，成时走 surface 的 step(±1)", () => {
    const main = srcOf("src/main.ts");
    const gate = fnBody(main, "shortcutApplies");
    expect(gate, "两条命令共用同一个闸（写成两行 case  fallthrough）").toMatch(
      /case "diff\.nextChange":\s*\n\s*case "diff\.prevChange":/,
    );
    expect(gate).toMatch(/return diffTabActive\(\)/);
    // 闸的判据本身：活动面板**挂着旁路**且显示的那张标签是差异标签
    const helper = fnBody(main, "diffTabActive");
    expect(helper).toMatch(/diffSurfaceOf\(/);
    expect(helper).toMatch(/kind\s*===\s*"diff"/);
    // 分发：按的是当前活动面板的那颗 surface
    const run = fnBody(main, "runShortcut");
    expect(run).toMatch(/case "diff\.nextChange":/);
    expect(run).toMatch(/diffSurfaceOf\(activePanel\(\)\)\?\.step\(1\)/);
    expect(run).toMatch(/diffSurfaceOf\(activePanel\(\)\)\?\.step\(-1\)/);
  });

  it("B461 · 键位字面量只许出现在 keymap.ts 这一处（B389 的纪律）", () => {
    const hits = collectTextFiles("src")
      .filter((p) => p.endsWith(".ts"))
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const text = readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
        return /Alt\+F5|Shift\+Alt\+F5/.test(text);
      });
    expect(hits, "分发那处只按 id 走、菜单那处只按 keyHint(id) 取 ⇒ 改一颗键只用改这张表").toEqual([
      "src/shell/keymap.ts",
    ]);
  });
});
