// @vitest-environment node
// B251 / P1：统一同步游标的**纯结构换算**（源码行号 ⇄ 预览块+比例）互逆性。
// 这是整套「唯一规范值 v」计划的地基判据：**公式必须严格互逆、量化后往返恒等**。
// ⚠️ 这里刻意不 import `../src/main`、不碰 DOM：换算一旦需要几何，编号就不再稳定，
//    折行 / 图片重排会把位置顶偏 —— 编号与几何必须解耦（见模块头注释）。
import { describe, it, expect } from "vitest";
import {
  buildRowMap,
  blockOfV,
  vOfBlock,
  quantize,
  clampCursor,
  CURSOR_QUANT,
  type RowMap,
} from "../src/sync/cursor";

/** 确定性伪随机（别用 Math.random ⇒ 失败不可复现）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("统一游标：行号 ⇄ 块+比例 互逆", () => {
  it("① 随机 v 往返 2000 次，量化后恒等（一次都不许漂）", () => {
    const map = buildRowMap([1, 5, 9, 14, 20], 30);
    const next = rng(20261006);
    for (let i = 0; i < 2000; i++) {
      const v = 1 + next() * 29;
      const { k, t } = blockOfV(map, v);
      // ⚠️ 取整条表达式断言：只比 `k` 或只比 `t` 在边界块上会假绿。
      //    ⚠️ 两侧不许都套 `quantize` —— 量化退化成恒等时两边同步退化，判据假绿（实测踩过）。
      expect(quantize(vOfBlock(map, k, t))).toBe(quantize(v));
    }
  });

  it("② 块内位置往返：k 不变、t 回到原值（t ∈ [0,1) 开区间）", () => {
    const map = buildRowMap([1, 4, 11, 12, 25], 30);
    const next = rng(7);
    for (let i = 0; i < 1000; i++) {
      const k = Math.floor(next() * 4);
      const t = next() * 0.9999; // ⚠️ 不含 1：t === 1 时 v 正好落在下一块首，语义上属于下一块
      const back = blockOfV(map, vOfBlock(map, k, t));
      expect(back.k).toBe(k);
      expect(Math.abs(back.t - t)).toBeLessThanOrEqual(2 / CURSOR_QUANT + 1e-9);
    }
  });

  it("③ 块表覆盖 [1, lines] 且无空洞：每个整数行都归到某块，且落在 [start, end)", () => {
    // ⚠️ 这个块表刻意带三种脏数据，覆盖 B244 伪块 + 空行缝隙 + 跨 3 行段落：
    //    · 首项 1 重复两次（旧 B244 的伪块就是 lineStart 恒为 1）
    //    · 第 11 块跨 3 行源码（块首 ≠ 行首，判据才有鉴别力）
    //    · 空隙里留一个不单调的 9（应被丢弃）
    const map = buildRowMap([1, 1, 5, 8, 9, 12, 15, 15, 22], 24);
    expect(map.starts[0]).toBe(1);
    expect(map.lines).toBe(24);
    for (let line = 1; line <= map.lines; line++) {
      const { k, t } = blockOfV(map, line);
      const span = map.spans[k];
      // ⚠️ 位置闸两方向都要红：只判 `starts[k] <= line` 缺 `t` 约束 ⇒ 越界行也会假绿。
      expect(map.starts[k], `行 ${line} 落到块 ${k}`).toBeLessThanOrEqual(line);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(span).toBeGreaterThan(0);
      expect(map.starts[k] + t * span).toBeCloseTo(line, 6);
    }
    // ⚠️ 反向闸：**块首必须归它自己**。只写上面那组（「starts[k] <= line」+「落在块内」）
    //    是假绿 —— 二分把 `<=` 退化成 `<` 时块首会掉到上一块（此时 t === 1、starts[k] 也
    //    <= line、starts[k]+t·span 照样等于 line）⇒ 退化后整组仍绿、判据零鉴别力。
    for (let k = 0; k < map.spans.length - 1; k++) {
      expect(blockOfV(map, map.starts[k]).k, `块首 ${map.starts[k]} 必须归块 ${k}`).toBe(k);
    }
  });

  it("④ spans 恒 >= 1、starts 严格递增（半开区间无重叠）", () => {
    for (const raw of [[1, 5, 9], [1, 2, 3], [1], [1, 1, 1], []] as number[][]) {
      const map = buildRowMap(raw, 8);
      for (let k = 0; k < map.spans.length; k++) {
        expect(map.spans[k]).toBeGreaterThanOrEqual(1);
        if (k > 0) expect(map.starts[k]).toBeGreaterThan(map.starts[k - 1]);
      }
      expect(map.starts[map.starts.length - 1]).toBe(map.lines + 1);
    }
  });

  it("⑤ 越界 / NaN 一律 clamp 到 [1, lines]，绝不放行", () => {
    const map = buildRowMap([1, 6, 13], 20);
    expect(blockOfV(map, 0).k).toBe(blockOfV(map, 1).k);
    expect(blockOfV(map, -99).t).toBe(0);
    expect(blockOfV(map, 1e9).k).toBe(blockOfV(map, 20).k);
    expect(blockOfV(map, 1e9).t).toBeLessThanOrEqual(1);
    expect(blockOfV(map, Number.NaN).k).toBe(blockOfV(map, 1).k);
    expect(clampCursor(20, Number.NaN)).toBe(1);
    expect(clampCursor(20, -5)).toBe(1);
    expect(clampCursor(20, 999)).toBe(20);
  });

  it("⑥ 退化入参：空表 / 全伪块也能出一块（不许返回空或越界）", () => {
    for (const raw of [[], [1, 1, 1, 1], [-3, -1, 0], [99, 100]] as number[][]) {
      const map: RowMap = buildRowMap(raw, 6);
      const pos = blockOfV(map, 3);
      expect(pos.k).toBeGreaterThanOrEqual(0);
      expect(pos.k).toBeLessThanOrEqual(map.spans.length - 1);
      expect(pos.t).toBeGreaterThanOrEqual(0);
      expect(pos.t).toBeLessThanOrEqual(1);
      expect(quantize(vOfBlock(map, pos.k, pos.t))).toBe(quantize(3));
    }
  });

  it("⑦ 量化确实挡住浮点累积：连续 500 次往返只掉 1e-4 量级", () => {
    const map = buildRowMap([1, 4, 7, 10, 13, 16, 19, 22], 24);
    let v = 12.3456789;
    // ⚠️ 目标值**硬编码**，不用 `quantize(12.3456789)` 现算 —— 后者在量化被退化成恒等时
    //    两边同步退化 ⇒ 判据假绿（实测踩过）。这里就是要盯住「裸累积必须被量化截断」。
    const target = 12.3457;
    for (let i = 0; i < 500; i++) {
      const { k, t } = blockOfV(map, v);
      // ⚠️ 不套 quantize：循环里跑裸值，累积误差才长得出来。
      v = vOfBlock(map, k, t);
    }
    expect(quantize(v)).toBe(target);
  });
});
