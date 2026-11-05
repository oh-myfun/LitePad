// @vitest-environment node
// B461 · Task 1 —— 差异标签的数据层（`src/diff/model.ts`）。
//
// 钉两件跨文件才成立的事：
//   1) **A 档的闸**：基线未知就不许开差异编辑器（设计稿 ⑩·3 / Review Focus 1）。
//      空字符串基线是「存过一个空文件」，那是**已知**原样 ⇒ 必须放行；把 `""` 当假值判成
//      「开不了」就是这条闸最可能的错法。
//   2) **块数通知只有一个槽**（预审 R6）：侧栏那块视图注册自己、收起时注销；
//      surface 不反向 import 面板模块，否则成环。
//
// `leftText` 为什么是函数不是字符串，见 `src/diff/model.ts` 的头注（B458 同口径：读取口，
// 不是快照）—— 那条不由单测判，由 Task 5 的「Ctrl+S 自己清空」用例判。
import { describe, expect, it } from "vitest";
import type { Doc } from "../src/core/app-state";
import {
  canOpenAgainstBaseline,
  notifyDiffBlocks,
  setDiffBlocksListener,
  type DiffSpec,
} from "../src/diff/model";

const docWith = (baseline: string | null): Doc => ({ tabId: 1, baseline }) as unknown as Doc;

const spec = (over: Partial<DiffSpec> = {}): DiffSpec => ({
  tier: "baseline",
  docId: 1,
  leftText: () => "",
  leftName: "a.md（上次保存）",
  rightName: "a.md",
  leftPath: null,
  ...over,
});

describe("B461 · canOpenAgainstBaseline（A 档那道闸）", () => {
  it("没有文档 / 基线未知 ⇒ 不许开", () => {
    expect(canOpenAgainstBaseline(null)).toBe(false);
    expect(canOpenAgainstBaseline(docWith(null))).toBe(false);
  });

  it("基线是空字符串 = 存过一个空文件，那是**已知**原样 ⇒ 要放行", () => {
    expect(canOpenAgainstBaseline(docWith(""))).toBe(true);
  });

  it("基线有正文 ⇒ 放行（与脏不脏无关：干净时打开是一张全同的差异）", () => {
    expect(canOpenAgainstBaseline(docWith("旧正文"))).toBe(true);
    expect(canOpenAgainstBaseline({ tabId: 1, baseline: "旧正文", dirty: false } as Doc)).toBe(
      true,
    );
  });
});

describe("B461 · 块数变化的通知槽", () => {
  it("注册后广播送到它，注销后广播是空转（不许抛）", () => {
    const seen: DiffSpec[] = [];
    setDiffBlocksListener((s) => seen.push(s));
    const s = spec();
    notifyDiffBlocks(s);
    expect(seen).toEqual([s]);

    setDiffBlocksListener(null);
    expect(() => notifyDiffBlocks(spec())).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("只有一个槽：后注册的顶掉前一个（多播是给还不存在的需求付账 —— 预审 R6）", () => {
    const a: number[] = [];
    const b: number[] = [];
    setDiffBlocksListener(() => a.push(1));
    setDiffBlocksListener(() => b.push(1));
    notifyDiffBlocks(spec());
    expect(a).toEqual([]);
    expect(b).toEqual([1]);
    setDiffBlocksListener(null);
  });
});
