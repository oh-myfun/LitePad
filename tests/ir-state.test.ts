// B352-4 三态循环的纯状态机。
//
// 这颗悬浮键的**全部行为**就是这三条边：源码 → 渲染·锁 → 渲染·可写 → 源码。
// 顺序、只读退化、非法值回落都住在这个文件；Task 6（点击）、Task 8（字形）、Task 10（会话）
// 一律从这里取值，别处再写一份映射就是第二套口径（B304 那族「显示与行为两套口径」的病根）。
//
// 判据全是行为判据（表驱动 + 成对），没有静态正则：这里能测的就是枚举本身。
import { describe, expect, it } from "vitest";

import {
  IR_DEFAULT,
  IR_STATE_NAME,
  coerceIrState,
  irStateName,
  nextIrState,
  type IrState,
} from "../src/markdown/ir-state";

const A: IrState = { liveRender: "off", irLocked: true }; // 源码
const B: IrState = { liveRender: "ir", irLocked: true }; // 渲染·锁
const C: IrState = { liveRender: "ir", irLocked: false }; // 渲染·可写

describe("B352-4 nextIrState：只有三条边", () => {
  it("A→B→C→A：三发回到起点，且不许跳态", () => {
    expect(nextIrState(A, { readonly: false })).toEqual(B);
    expect(nextIrState(B, { readonly: false })).toEqual(C);
    expect(nextIrState(C, { readonly: false })).toEqual(A);
    // A 永远不可能一步到 C；C 的下一发不可能是 B
    expect(nextIrState(A, { readonly: false }).liveRender).toBe("ir");
    expect(nextIrState(C, { readonly: false }).irLocked).toBe(true);
  });

  it("只读时 C 不可达：B 的下一发是 A，不是 C", () => {
    expect(nextIrState(B, { readonly: true })).toEqual(A);
    for (const cur of [A, B, C]) {
      expect(
        nextIrState(cur, { readonly: true }),
        `readonly 下从 ${irStateName(cur)} 出发`,
      ).not.toEqual(C);
    }
  });

  it("只读循环是 A→B→A（两态来回，不会卡在一个渲染但可写的态）", () => {
    let s = nextIrState(A, { readonly: true });
    for (let i = 0; i < 3; i++) {
      s = nextIrState(s, { readonly: true });
      expect(irStateName(s)).toBe("source");
      s = nextIrState(s, { readonly: true });
    }
    expect(s).toEqual(B);
  });

  it("纯函数：不改入参（会话里那份状态被就地改过就再也对不上账）", () => {
    const cur: IrState = { liveRender: "ir", irLocked: true };
    expect(nextIrState(cur, { readonly: false })).toEqual(C);
    expect(cur).toEqual(B);
  });
});

describe("B352-4 名字表：三态各一个名字，且是唯一出口", () => {
  it("三个状态的名字互不相同，恰好覆盖三态", () => {
    const names = [A, B, C].map(irStateName);
    expect(new Set(names).size, `三态撞名：${names.join(", ")}`).toBe(3);
    expect(names.sort()).toEqual(["render-editable", "render-locked", "source"]);
  });

  it("名字表按 [liveRender, irLocked] 取，与 irStateName 同一份（不是两处硬编码）", () => {
    expect(Object.keys(IR_STATE_NAME).sort(), "表里恰好三个合法态").toEqual([
      "ir:false",
      "ir:true",
      "off:true",
    ]);
    for (const s of [A, B, C]) {
      expect(IR_STATE_NAME[`${s.liveRender}:${s.irLocked}`], `表里缺 ${irStateName(s)}`).toBe(
        irStateName(s),
      );
    }
  });

  it("默认锁着（产品拍板：默认进 B 而不是 C）", () => {
    expect(IR_DEFAULT).toEqual({ liveRender: "off", irLocked: true });
    expect(irStateName(IR_DEFAULT)).toBe("source");
  });
});

describe("B352-4 coerceIrState：非法值一律退回源码态 / 锁着", () => {
  it("liveRender 只认 off|ir，其余退回 off", () => {
    for (const bad of ["wysiwyg", "split", "preview", "", null, undefined]) {
      expect(coerceIrState({ liveRender: bad }).liveRender, `liveRender=${String(bad)}`).toBe(
        "off",
      );
    }
  });

  it("irLocked 没记过 = 锁着；显式 false 才解锁", () => {
    expect(coerceIrState({}).irLocked).toBe(true);
    expect(coerceIrState({ irLocked: null }).irLocked).toBe(true);
    expect(coerceIrState({ irLocked: undefined }).irLocked).toBe(true);
    expect(coerceIrState({ irLocked: false }).irLocked).toBe(false);
    expect(coerceIrState({ irLocked: true }).irLocked).toBe(true);
  });

  it("回落后的状态永远是「合法三态之一」，不会是第四种组合之外的东西", () => {
    const coerced = coerceIrState({ liveRender: "wysiwyg", irLocked: null });
    expect(Object.values(IR_STATE_NAME)).toContain(irStateName(coerced));
    expect(coerced).toEqual(IR_DEFAULT);
  });
});
