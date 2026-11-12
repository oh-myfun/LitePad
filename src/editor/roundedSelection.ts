// 圆角选区层：把 CM6 的直角选区换成 VS Code 的圆角轮廓。
//
// VS Code 的选区在 `selections.css` 里是 3px 圆角，`selections.ts` 再按「相邻两段
// 选区的左右缘是否对齐」给每颗角分三档：外转画圆角、对齐不画、内转反向补一小块
// 圆角（凹角）。CM6 的 `drawSelection` 只铺直角矩形，且一段选区在 DOM 里就是一串
// 没有首尾标记的 div —— 不知道「哪颗角是整段的外转角」就无从下笔。
//
// 所以这里另起一层：复用 CM6 公开的 `RectangleMarker.forRange` 量几何（与原生选区
// 层同一套，折行 / bidi / 块级 widget 的处理都不用重写），只按相邻矩形算出每颗角的
// 档位并落到 class 上。`drawSelection` 仍保留 —— 光标层、原生选区隐藏、iOS 手柄都
// 归它，它画的那层直角选区由 `global.css` 藏掉；不能删：`:has(.cm-selectionBackground)`
// 与 diff 的守卫都拿它当锚点。
//
// 量几何要**按文档行拆开**，不能把整段 range 交给 `forRange`：它把跨行选区的首段与
// 中段一路铺到内容区右缘，行尾之后那片没有字符的区域也会上色。VS Code 每行只画到
// 本行字符区，跨行时再为行尾换行符补半个字宽（`viewLines.ts` 的
// `linesVisibleRangesForRange(range, true)`）—— 换行符是空白字符，包含它；它后面
// 没有字符，就不该有底色。
//
// 凹角不能用 `border-radius`（那只会把补块自身切圆，方向反了），所以补块是一颗
// 3×3 子元素 + `radial-gradient` 画的「方块减去四分之一圆」。颜色走 `--lp-sel-bg`，
// 不写死背景色：底下是当前行还是差异行，都能照原样透出来。

import { EditorSelection, type Extension, type Text } from "@codemirror/state";
import {
  Direction,
  layer,
  RectangleMarker,
  type EditorView,
  type LayerMarker,
  type ViewUpdate,
} from "@codemirror/view";

const SELECTION_CLASS = "cm-selectionBackground";

/** 每颗角一档：外转角圆、对齐边平、内转角凹（往选区外补圆角）。 */
export type CornerMode = "round" | "flat" | "concave";

export interface RectCorners {
  tl: CornerMode;
  tr: CornerMode;
  bl: CornerMode;
  br: CornerMode;
}

/** 只关心量角要用的四个量；`RectangleMarker` 与测试夹具都满足。 */
export interface CornerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const SIDES = ["tl", "tr", "bl", "br"] as const;

/** 相邻两段是否同一列（上下缘贴合）：不同视觉行之间会有行距，贴合才谈得上「同一段选区」。 */
function stackedAbove(upper: CornerRect, lower: CornerRect): boolean {
  return Math.abs(upper.top + upper.height - lower.top) < 0.5;
}

/** 左右缘是否对齐：像素小数来自 `coordsAtPos`，留半像素容差，别让亚像素抖动多画一颗角。 */
function aligned(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.75;
}

/**
 * 按 VS Code `selections.ts` 的判法给一段选区的每颗角分档。
 *
 * 入参是**同一段选区**的矩形，已按自上而下排好（`RectangleMarker.forRange` 的输出即如此）。
 * 判断只看邻居的缘在哪：上面那段更靠左 ⇒ 本段左上角是内转（上方把左边包住了）；
 * 本段更靠左 ⇒ 是外转（自己凸出来）。底部同理看下一段。
 */
export function selectionCorners(rects: readonly CornerRect[]): RectCorners[] {
  return rects.map((rect, index) => {
    const prev = index > 0 && stackedAbove(rects[index - 1], rect) ? rects[index - 1] : null;
    const next =
      index + 1 < rects.length && stackedAbove(rect, rects[index + 1]) ? rects[index + 1] : null;
    const right = rect.left + rect.width;
    const prevRight = prev ? prev.left + prev.width : 0;
    const nextRight = next ? next.left + next.width : 0;

    return {
      // 最上面那段没有「上邻」，两颗上角都是整段的外转角。
      tl: !prev
        ? "round"
        : aligned(rect.left, prev.left)
          ? "flat"
          : rect.left > prev.left && rect.left < prevRight
            ? "concave"
            : "round",
      tr: !prev
        ? "round"
        : aligned(right, prevRight)
          ? "flat"
          : right < prevRight && right > prev.left
            ? "concave"
            : "round",
      // 最下面那段同理，两颗下角收口。
      bl: !next
        ? "round"
        : aligned(rect.left, next.left)
          ? "flat"
          : next.left < rect.left && rect.left < nextRight
            ? "concave"
            : "round",
      br: !next
        ? "round"
        : aligned(right, nextRight)
          ? "flat"
          : right < nextRight && right > next.left
            ? "concave"
            : "round",
    };
  });
}

/** 一段选区落在某一行上的那一截。`from..to` 是本行的字符区，不含行尾换行符。 */
export interface SelectionSegment {
  from: number;
  to: number;
  /** 行尾换行符也被选中（选区在本行之后还有内容） */
  newline: boolean;
}

/**
 * 把一段选区按文档行拆开，只留视口内的行。
 *
 * `visibleFrom/visibleTo` 只是裁剪：选区可以铺满整篇文档，而层只画视口里那几行
 * （`RectangleMarker.forRange` 自己也会丢掉视口外的矩形）。
 */
export function selectionSegments(
  doc: Text,
  from: number,
  to: number,
  visibleFrom = 0,
  visibleTo = doc.length,
): SelectionSegment[] {
  if (from >= to || to <= visibleFrom || from >= visibleTo) return [];
  const first = doc.lineAt(Math.max(from, visibleFrom));
  const last = doc.lineAt(Math.min(to, visibleTo));
  const segments: SelectionSegment[] = [];
  for (let number = first.number; number <= last.number; number++) {
    const line = doc.line(number);
    // 终点落在本行行首：本行一个字符都没选中（上一行的换行符算在上一行）。
    if (to <= line.from) continue;
    segments.push({
      from: Math.max(from, line.from),
      to: Math.min(to, line.to),
      newline: to > line.to,
    });
  }
  return segments;
}

/**
 * 行尾换行符那半格：LTR 往右补，RTL 往左补（VS Code 在 `linesVisibleRangesForRange`
 * 里也是按行方向加/减 `typicalHalfwidthCharacterWidth`）。
 */
export function newlineRect(rect: CornerRect, charWidth: number, rtl: boolean): CornerRect {
  return {
    left: rtl ? rect.left - charWidth : rect.left,
    top: rect.top,
    width: rect.width + charWidth,
    height: rect.height,
  };
}

/**
 * 把上下相邻的视觉行接上：行距也该是选区色（VS Code 的选区是连续的一整块）。
 *
 * CM6 的矩形只盖字形盒，行距会露出底色；原生层靠一条贯穿首尾的「中间段」补掉它，
 * 按行拆开之后就只剩缺口，所以两条一对各让一半。缺口大于一行高时不接 —— 那中间
 * 隔着块级 widget，是真正的空白，不该铺色。
 */
export function stitchLines(rects: readonly CornerRect[], maxGap: number): CornerRect[] {
  const out = rects.map((rect) => ({ ...rect }));
  for (let i = 0; i + 1 < out.length; i++) {
    const upper = out[i];
    const lower = out[i + 1];
    const gap = lower.top - (upper.top + upper.height);
    if (gap <= 0 || gap >= maxGap) continue;
    const seam = upper.top + upper.height + gap / 2;
    out[i] = { ...upper, height: seam - upper.top };
    out[i + 1] = { ...lower, top: seam, height: lower.top + lower.height - seam };
  }
  return out;
}

/** 凸角的 class：交给 CSS 的 `border-*-radius`。 */
const ROUND_CLASS: Record<(typeof SIDES)[number], string> = {
  tl: "lp-sel-tl",
  tr: "lp-sel-tr",
  bl: "lp-sel-bl",
  br: "lp-sel-br",
};

function className(corners: RectCorners): string {
  const classes = [SELECTION_CLASS];
  for (const side of SIDES) {
    if (corners[side] === "round") classes.push(ROUND_CLASS[side]);
  }
  return classes.join(" ");
}

function sameCorners(a: RectCorners, b: RectCorners): boolean {
  return SIDES.every((side) => a[side] === b[side]);
}

/**
 * 一段选区的一块矩形。`RectangleMarker` 只能带一个 class（且它自己就按 class 判等），
 * 所以凸角的 class 塞进它的 className；凹角要挂子元素，只能包一层。
 */
class RoundedSelectionMarker implements LayerMarker {
  constructor(
    private readonly rect: RectangleMarker,
    private readonly corners: RectCorners,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof RoundedSelectionMarker &&
      this.rect.eq(other.rect) &&
      sameCorners(this.corners, other.corners)
    );
  }

  draw(): HTMLElement {
    const element = this.rect.draw();
    for (const side of SIDES) {
      if (this.corners[side] !== "concave") continue;
      const fillet = document.createElement("div");
      fillet.className = `lp-sel-fillet lp-sel-fillet-${side}`;
      element.append(fillet);
    }
    return element;
  }

  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (
      !(previous instanceof RoundedSelectionMarker) ||
      !sameCorners(this.corners, previous.corners)
    ) {
      return false;
    }
    return this.rect.update(element, previous.rect);
  }
}

/** `RectangleMarker.width` 对非空 range 恒有值；量角只认这四个量。 */
function rectOf(marker: RectangleMarker): CornerRect {
  return { left: marker.left, top: marker.top, width: marker.width ?? 0, height: marker.height };
}

function markersFor(view: EditorView): LayerMarker[] {
  const out: LayerMarker[] = [];
  const charWidth = view.defaultCharacterWidth;
  for (const range of view.state.selection.ranges) {
    // 空选区只有光标，归 drawSelection 的光标层。
    if (range.empty) continue;
    const markers: RectangleMarker[] = [];
    for (const segment of selectionSegments(
      view.state.doc,
      range.from,
      range.to,
      view.viewport.from,
      view.viewport.to,
    )) {
      const own = [
        ...RectangleMarker.forRange(
          view,
          SELECTION_CLASS,
          EditorSelection.range(segment.from, segment.to),
        ),
      ];
      if (!own.length) continue;
      const rtl = segment.newline && view.textDirectionAt(segment.to) === Direction.RTL;
      if (segment.from === segment.to) {
        // 这一行只选中了换行符（空行、或选区从行尾起跳）：只补换行符那半格。
        if (segment.newline) {
          const sliver = newlineRect({ ...rectOf(own[0]), width: 0 }, charWidth, rtl);
          markers.push(
            new RectangleMarker(
              SELECTION_CLASS,
              sliver.left,
              sliver.top,
              sliver.width,
              sliver.height,
            ),
          );
        }
      } else {
        if (segment.newline) {
          // 行尾换行符也选中：给最后一个视觉行补半格。
          const last = own.length - 1;
          const extended = newlineRect(rectOf(own[last]), charWidth, rtl);
          own[last] = new RectangleMarker(
            SELECTION_CLASS,
            extended.left,
            extended.top,
            extended.width,
            extended.height,
          );
        }
        markers.push(...own);
      }
    }
    if (!markers.length) continue;
    const rects = stitchLines(markers.map(rectOf), view.defaultLineHeight);
    const corners = selectionCorners(rects);
    rects.forEach((rect, index) => {
      const c = corners[index];
      out.push(
        new RoundedSelectionMarker(
          new RectangleMarker(className(c), rect.left, rect.top, rect.width, rect.height),
          c,
        ),
      );
    });
  }
  return out;
}

/**
 * 圆角选区层。挂在 `drawSelection()` 之后（与 `EditorView` 的层序无关，只影响测量先后）。
 */
export function roundedSelection(): Extension {
  return layer({
    above: false,
    class: "lp-selectionLayer",
    markers: markersFor,
    update(update: ViewUpdate): boolean {
      return update.docChanged || update.selectionSet || update.viewportChanged;
    },
  });
}
