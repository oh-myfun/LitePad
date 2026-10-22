/**
 * 指针落点分区几何 —— 纯函数，无依赖。
 *
 * 从 `shell/splitview.ts` 抽出：分屏落点判定（zoneOf）与分区类型（DropZone）是
 * 文件拖入（io/files）与标签拖拽（shell/tabdnd）共用的几何，与 splitview 的 DOM
 * 渲染解耦后，双方都能直接 import，不再经 splitview 中转。
 */

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/**
 * 指针在面板内的分区。
 * - 两轴都落在中心区内 = `center`（移入/排序，不分屏）。中心区的边界由 B346 定档：
 *   放在**「中心点到边缘距离的 2/3」处** ⇒ 边界离缘 = 半轴 × 1/3 = 全轴的 1/6，
 *   中心区因此占中间 2/3 宽。（上一档是「边缘 28% 带」，中心区只有 44% —— 用户要的
 *   是中心区更大：瞄着面板拖过去时，先想「并入这块」而不是先想「把它劈成两半」。）
 * - 落在边缘带时用 VS Code 的「1/3 方向优先」定方向：左右各占外侧 1/3 优先左右分屏，
 *   中 1/3 才按上/下半区给上/下 —— 角部归属因此可预期
 *   （对标 `workbench/.../editorDropTarget.ts:424-479` 的 splitWidthThreshold = 宽/3）。
 *   ⚠️ 这一档与上面那颗 `EDGE` 是两回事（一个定「算不算边缘」、一个定「边缘里归左右还是
 *   归上下」），别顺手一起改。
 * - 标签拖拽与文件拖入**共用这一个判定**（见 `tests/filedrop-strip.test.ts` 那条「不许自己
 *   再算一遍 zoneOf」的守卫）⇒ 改这里，两种拖法一起变，不会错开。
 * - jsdom 无布局（宽高为 0）时回 `center`，避免 NaN 判定落到意外分支。
 */
export function zoneOf(rect: DOMRect, x: number, y: number): DropZone {
  if (!(rect.width > 0) || !(rect.height > 0)) return "center";
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const EDGE = 1 / 6; // 中心到边缘距离的 2/3 ⇒ 距缘 1/6（B346）
  if (rx >= EDGE && rx <= 1 - EDGE && ry >= EDGE && ry <= 1 - EDGE) return "center";
  if (rx < 1 / 3) return "left";
  if (rx > 2 / 3) return "right";
  return ry < 0.5 ? "top" : "bottom";
}
