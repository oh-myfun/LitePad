// B358 任务清单勾选框点击切换：渲染面上的勾选框 → 源码行映射的纯函数。
//
// 用户拍板（推翻 spec「checkbox 是内容不是控件」那条）：渲染出来的勾选框要能直接点着
// 切换，锁着的渲染态（纯预览）最好也能点。两个面（IR widget / 只读预览岛）都要把
// 「块里第 N 个勾选框」换算回源码行，这份换算只住一处。
//
// 口径：`[lineStart, lineEnd]` 内按顺序数**任务行**（可有 `> ` 引用前缀、有序/无序皆可），
// 第 index 个就是它。块 DOM 里的勾选框个数由管线保证与任务行一致；对不上（换算不了）
// 一律返回 null，调用方就地不动 —— 宁可点不动，也不能改错行。
import { EditorState } from "@codemirror/state";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { taskLineAt } from "../src/markdown/tasks";
import { fnBody, stripLineComments } from "./static";

function doc(text: string) {
  return EditorState.create({ doc: text }).doc;
}

const md = stripLineComments(readFileSync("src/markdown.ts", "utf-8"));
const pv = stripLineComments(readFileSync("src/markdown/preview.ts", "utf-8"));

describe("B358 taskLineAt：块里第 N 个勾选框 ↔ 源码第 N 条任务行", () => {
  it("无序列表：两个勾选框各归各行，勾选态与方括号范围都对", () => {
    const d = doc("# T\n\n- [ ] 甲\n- [x] 乙\n\n尾巴\n");
    const first = taskLineAt(d, 3, 4, 0)!;
    expect(first.line).toBe(3);
    expect(first.checked).toBe(false);
    expect(d.sliceString(first.from, first.to)).toBe("[ ]");
    const second = taskLineAt(d, 3, 4, 1)!;
    expect(second.line).toBe(4);
    expect(second.checked).toBe(true);
  });

  it("有序列表与块引用前缀都认得", () => {
    const d = doc("1. [X] 甲\n> - [ ] 乙\n");
    const one = taskLineAt(d, 1, 2, 0)!;
    expect(one.checked).toBe(true);
    expect(d.sliceString(one.from, one.to)).toBe("[X]");
    const two = taskLineAt(d, 1, 2, 1)!;
    expect(two.line).toBe(2);
    expect(two.checked).toBe(false);
  });

  it("任务行之间的续行不打乱序号（映射按任务行数，不按行差）", () => {
    const d = doc("- [ ] 甲\n  续行也算列表项内容\n- [x] 乙\n");
    const second = taskLineAt(d, 1, 3, 1)!;
    expect(second.line).toBe(3);
  });

  it("index 越界 ⇒ null（点不动好过改错行）", () => {
    const d = doc("- [ ] 甲\n");
    expect(taskLineAt(d, 1, 1, 1)).toBeNull();
  });

  it("块里根本没有任务行 ⇒ null（点击落在非任务的渲染块上）", () => {
    const d = doc("普通段落\n");
    expect(taskLineAt(d, 1, 1, 0)).toBeNull();
  });
});

describe("B359 起：预览格是唯一渲染面，宿主入口只走预览一条路", () => {
  it("toggleTaskInTab 挡只读、没有别的写闸（用户拍板：纯预览也能勾）", () => {
    const body = fnBody(md, "toggleTaskInTab");
    expect(body, "取不到函数体说明出口没了").toBeTruthy();
    expect(body, "只读文档不许写").toMatch(/doc\.readonly/);
  });

  it("预览面只把序号交回宿主，自己不换算（换算只住 tasks.ts 一处）", () => {
    expect(pv, "预览侧用宿主入口").toMatch(/toggleTaskAt\(/);
    expect(pv, "预览面不许自己数任务行").not.toMatch(/taskLineAt\(/);
  });

  it("宿主入口落在 tasks.ts 的共享映射与翻转记号上", () => {
    const body = fnBody(md, "toggleTaskInTab");
    expect(body, "行换算走共享映射").toMatch(/taskLineAt\(/);
    expect(body, "翻转记号只住 tasks.ts").toMatch(/flippedTaskMark\(/);
  });
});
