// 概览标尺（VS Code 的 overview ruler）：编辑器右缘那一列标记。
//
// 上游的权威实现是 `decorationsOverviewRuler.ts` + `editorColors.ts` 里 `editorOverviewRuler.*`
// 那几颗注册值；本模块只搬它，不另立口径：
//   · 画布（canvas）而不是逐条 DOM —— 一次查找可能有几千个命中，逐条建节点会抖；
//     上游同样是整块 canvas 一次 `fillRect`。
//   · 色块按「颜色组」分桶、组内**按行区间合并**（`_renderOneGroup` 的 `y1 > prevY2 + 1` 那条），
//     相邻或重叠的同一颜色画成一条，而不是一格子一条。
//   · 最小标记高度 6 CSS px（上游 `MIN_DECORATION_HEIGHT`），光标那条是 2 CSS px
//     （上游 `cursorHeight = 2 * pixelRatio`），且**最后**画（`_render` 里光标在装饰组之后）。
//   · 三条泳道（左/中/右）的几何照上游 `_initLanes(1, width, 3)`：左边留 1px，
//     剩下三等分（中间的零头归中间）；`Full` 占 1px 之后的全宽。
//   · 标记是**直角矩形**（上游 `fillRect`，没有圆角）；高度只按行盒算，单行至少 6px。
//
// 不接的几类：`editorOverviewRuler.infoForeground / warningForeground / errorForeground`
// 对应的是「诊断」。本项目没有语言服务、也没有 lint 产出的诊断集合，没有语义可挂 ——
// 按「有就接、没有就跳过」的口径不造需求。
//
// 颜色一律走 `global.css` 的 `--overview-*` token（取值即上游注册默认色），这里不写死十六进制；
// 绘制时把 token 解析成具体颜色。标记一律**半透明**——上游注册注释的原话是
// `The color must not be opaque so as not to hide underlying decorations`，差异格里
// 它们还要压在删除/新增色条上仍然可辨（`diff.css` 那段层级注释）。
//
// 差异化：上游的「当前查找命中」在标尺上与其余命中同色同泳道（`findDecorations.ts` 两颗
// 装饰的 `overviewRuler` 完全一样，只差 zIndex 13 / 10）。本项目按产品要求要能区分，
// 取的是上游**另一条既有路径**：`findController.addDecorations` 给当前命中画的是
// `editorOverviewRuler.rangeHighlightForeground` + `OverviewRulerLane.Full`
// （`findController.ts` 的 rangeHighlight 装饰）。颜色、泳道、层级都在上游注册表里，没有自拟值。

import { SearchCursor } from "@codemirror/search";
import { EditorState, Facet, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findRulerRanges } from "./find";

/** 上游 `OverviewRulerLane` 的取值（`Left = 1 / Center = 2 / Right = 4 / Full = 7`）。 */
export type OverviewLane = 1 | 2 | 4 | 7;

/** 一条待画的标记（行区间 + 颜色 token + 泳道 + 组层级）。 */
export interface OverviewZone {
  /** 1-based 起始行（含） */
  fromLine: number;
  /** 1-based 结束行（含） */
  toLine: number;
  /** CSS 变量名（`--overview-find` 等），绘制时解析 */
  token: string;
  lane: OverviewLane;
  /**
   * 上游 `ModelDecorationOptions.zIndex`：同一像素上大的后画（压在上面）。
   * 上游的取值：普通查找命中 10、当前命中 13；其余几类不参与同色竞争，给 0。
   */
  zIndex: number;
  kind: "cursor" | "selection" | "word" | "find" | "find-current";
}

/**
 * 「同词出现」这一类的开关。
 *
 * 与 `highlightSelectionMatches()` 同一条闸：`editor.ts` 只在 `perf.selectionMatches` 那一支里
 * 把它和扩展一起挂上 ⇒ 大文件降档时正文不亮、标尺也不亮（否则会出现「正文没有、右缘有」的错位）。
 */
export const overviewWordMatches = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** 同词扫描的上限：照 CM6 `highlightSelectionMatches` 的两道限制（选区长度 200、命中 100 条）。 */
const WORD_MAX_LENGTH = 200;
const WORD_MAX_MATCHES = 100;

/**
 * 选中文本的**其余出现位置**。
 *
 * 直接复用 CM6 `highlightSelectionMatches` 的判定（单选区、非空、长度 ≤ 200、
 * 大小写敏感的逐字搜索、排除与选区自身重叠的那一条），只把扫描范围从「可见视口」
 * 换成「整篇」—— 上游的概览标尺本来就是把整份模型的装饰压进一列，只画屏幕内那几条
 * 会在滚动时忽隐忽现。
 */
function wordZones(state: EditorState): OverviewZone[] {
  const selection = state.selection;
  if (selection.ranges.length > 1) return [];
  const range = selection.main;
  if (range.empty) return [];
  const length = range.to - range.from;
  if (length < 1 || length > WORD_MAX_LENGTH) return [];
  const text = state.sliceDoc(range.from, range.to);
  if (!text) return [];
  const doc = state.doc;
  const zones: OverviewZone[] = [];
  const cursor = new SearchCursor(doc, text, 0, doc.length);
  while (zones.length < WORD_MAX_MATCHES) {
    const step = cursor.next();
    if (step.done) break;
    const { from, to } = step.value;
    if (from >= range.to || to <= range.from) {
      zones.push({
        fromLine: doc.lineAt(from).number,
        toLine: doc.lineAt(to).number,
        token: "--overview-word",
        lane: 2,
        zIndex: 0,
        kind: "word",
      });
    }
  }
  return zones;
}

/**
 * 从一份 `EditorState` 收集这一帧要画的全部标记。
 *
 * 行号一律走 `lineAt`：上游把这几个装饰交给概览标尺时也是按 `startLineNumber / endLineNumber`
 * 聚合（`getAllOverviewRulerDecorations`），**不**看列。
 */
export function overviewZones(state: EditorState): OverviewZone[] {
  const doc = state.doc;
  const zones: OverviewZone[] = [];

  // 光标（含空选区）：上游 `onCursorStateChanged` 把每条选区的位置都收进来，颜色 = 光标色 70%，
  // 泳道 Full、2px 高、最后画。
  for (const range of state.selection.ranges) {
    const line = doc.lineAt(range.head).number;
    zones.push({
      fromLine: line,
      toLine: line,
      token: "--overview-cursor",
      lane: 7,
      zIndex: 0,
      kind: "cursor",
    });
  }

  // 选区本身：`editorOverviewRuler.selectionHighlightForeground`（上游那颗注册值
  // 就是给「selection highlights」的；本项目没有语言服务的 DocumentHighlight，
  // 选区与同词出现是同一件事的两面，分两条来源只为各自可判）。
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    zones.push({
      fromLine: doc.lineAt(range.from).number,
      toLine: doc.lineAt(range.to).number,
      token: "--overview-selection",
      lane: 2,
      zIndex: 0,
      kind: "selection",
    });
  }

  // 同词出现：`editorOverviewRuler.wordHighlightForeground`。
  if (state.facet(overviewWordMatches)) zones.push(...wordZones(state));

  // 查找命中：普通命中 = `findMatchForeground` + Center；
  // 当前命中 = `rangeHighlightForeground` + Full + 上游那个更高的 zIndex（见文件头注）。
  for (const match of findRulerRanges(state)) {
    zones.push({
      fromLine: match.fromLine,
      toLine: match.toLine,
      token: match.active ? "--overview-range" : "--overview-find",
      lane: match.active ? 7 : 2,
      zIndex: match.active ? 13 : 10,
      kind: match.active ? "find-current" : "find",
    });
  }

  return zones;
}

export interface OverviewMapping {
  /** 这一栏文档总高（CM6 的 `view.contentHeight`） */
  height: number;
  /** 某一行的**行盒**顶边（文档像素；折行/块 widget 都已计入） */
  topOf(line: number): number;
  /** 某一行的行盒高度 */
  heightOf(line: number): number;
}

export interface OverviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 颜色 token（与 `OverviewZone.token` 同值） */
  token: string;
}

/** 上游 `Constants.MIN_DECORATION_HEIGHT`。 */
export const OVERVIEW_MIN_MARK = 6;
/** 上游光标标记高度（`cursorHeight = 2 * pixelRatio`，折回 CSS px 就是 2）。 */
export const OVERVIEW_CURSOR_MARK = 2;

/** 上游 `_initLanes(1, width, 3)` 的几何：左边留 1px，余下三等分（零头归中间）。 */
export function overviewLanes(width: number): Record<OverviewLane, { x: number; w: number }> {
  const offset = 1;
  const remaining = Math.max(0, width - offset);
  const left = Math.floor(remaining / 3);
  const right = Math.floor(remaining / 3);
  const center = remaining - left - right;
  return {
    1: { x: offset, w: left },
    2: { x: offset + left, w: center },
    4: { x: offset + left + center, w: right },
    7: { x: offset, w: remaining },
  };
}

interface Box {
  y: number;
  h: number;
}

function markBox(zone: OverviewZone, mapping: OverviewMapping, ratio: number, height: number): Box {
  const y1 = Math.floor(mapping.topOf(zone.fromLine) * ratio);
  const y2 = Math.floor((mapping.topOf(zone.toLine) + mapping.heightOf(zone.toLine)) * ratio);
  let y = y1;
  let h = y2 - y1;
  if (h < OVERVIEW_MIN_MARK) {
    const half = OVERVIEW_MIN_MARK / 2;
    let center = Math.floor((y1 + y2) / 2);
    if (center < half) center = half;
    else if (center + half > height) center = height - half;
    y = center - half;
    h = OVERVIEW_MIN_MARK;
  }
  return { y, h };
}

function cursorBox(
  zone: OverviewZone,
  mapping: OverviewMapping,
  ratio: number,
  height: number,
): Box {
  const half = OVERVIEW_CURSOR_MARK / 2;
  let center = Math.floor(mapping.topOf(zone.fromLine) * ratio);
  if (center < half) center = half;
  else if (center + half > height) center = height - half;
  return { y: center - half, h: OVERVIEW_CURSOR_MARK };
}

/**
 * 标记 → 像素矩形（纯函数，测试直接钉这一层）。
 *
 * 两件事都照上游：① 同一颜色组内按行区间**合并**（`y1 <= prevY2 + 1` 且同泳道），
 * ② 组按 `(zIndex, 颜色)` 排序后依次画 —— 后画的压先画的，于是「当前命中」能盖住
 * 普通命中、光标盖住一切装饰。
 */
export function layoutOverview(
  zones: OverviewZone[],
  mapping: OverviewMapping,
  width: number,
  height: number,
): OverviewRect[] {
  if (!(mapping.height > 0) || !(width > 0) || !(height > 0)) return [];
  const ratio = height / mapping.height;
  const lanes = overviewLanes(width);

  const rects: OverviewRect[] = [];

  const bucket = (
    list: OverviewZone[],
  ): Array<{ token: string; zIndex: number; items: OverviewZone[] }> => {
    const groups = new Map<string, { token: string; zIndex: number; items: OverviewZone[] }>();
    for (const zone of list) {
      const key = `${zone.zIndex}\u0000${zone.token}`;
      let group = groups.get(key);
      if (!group) {
        group = { token: zone.token, zIndex: zone.zIndex, items: [] };
        groups.set(key, group);
      }
      group.items.push(zone);
    }
    // 上游 `OverviewRulerDecorationsGroup.compareByRenderingProps`：先 zIndex 后颜色。
    return [...groups.values()].sort(
      (a, b) => a.zIndex - b.zIndex || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0),
    );
  };

  const paintGroup = (group: { token: string; items: OverviewZone[] }, cursor: boolean): void => {
    group.items.sort((a, b) => a.fromLine - b.fromLine);
    let current: OverviewRect | null = null;
    let lane: OverviewLane | 0 = 0;
    for (const zone of group.items) {
      const box = cursor
        ? cursorBox(zone, mapping, ratio, height)
        : markBox(zone, mapping, ratio, height);
      if (!(box.h > 0)) continue;
      if (current && lane === zone.lane && box.y <= current.y + current.h + 1) {
        // 合并：同一颜色、同一泳道、上下相接（或重叠）⇒ 一条（上游 `y1 > prevY2 + 1` 的反面）。
        current.h = Math.max(current.h, box.y + box.h - current.y);
      } else {
        if (current) rects.push(current);
        current = {
          x: lanes[zone.lane].x,
          y: box.y,
          w: lanes[zone.lane].w,
          h: box.h,
          token: group.token,
        };
        lane = zone.lane;
      }
    }
    if (current) rects.push(current);
  };

  // 上游分两轮：装饰组按 (zIndex, 颜色) 先画，光标**最后**画（所以光标压在所有装饰之上）。
  for (const group of bucket(zones.filter((z) => z.kind !== "cursor"))) paintGroup(group, false);
  for (const group of bucket(zones.filter((z) => z.kind === "cursor"))) paintGroup(group, true);
  return rects;
}

// ---------------------------------------------------------------- 绘制

/**
 * CSS 变量 → 具体颜色。
 *
 * 画布 `fillStyle` 只吃具体色值，而 `--overview-cursor` 是 `color-mix(...)` 这类函数式写法
 * （`getComputedStyle` 对自定义属性给的是**未计算**的 token 串）。用一颗隐藏探针把 token
 * 塞进 `color`，浏览器会给回算好的 `rgb()/rgba()` —— 五套主题各自的取值自然跟上。
 */
let probe: HTMLElement | null = null;

function resolveToken(token: string): string {
  if (typeof document === "undefined") return "transparent";
  if (!probe || !probe.isConnected) {
    probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
  }
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color || "transparent";
}

/** 把矩形画进画布（尺寸按 devicePixelRatio 放大，坐标仍按 CSS px 给）。 */
export function paintOverview(canvas: HTMLCanvasElement, rects: OverviewRect[]): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!(width > 0) || !(height > 0)) return;
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const deviceWidth = Math.round(width * ratio);
  const deviceHeight = Math.round(height * ratio);
  if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
  if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  for (const rect of rects) {
    ctx.fillStyle = resolveToken(rect.token);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
}

/**
 * 普通编辑器右缘那一列标尺。
 *
 * 几何照上游：标尺与纵向滚动条**同一列**（`layoutInfo.overviewRuler = { right: 0, width:
 * verticalScrollbarWidth }`）。本项目滚动条宽 8px（`global.css` 的自绘宽度），画布也就 8px
 * 贴右缘。与上游的差别只有层叠：上游的滚动条是自己画的 DOM，能压在标尺画布上；这里那条是
 * 浏览器自绘的，压不下去 ⇒ 画布给 `z-index: 2`。代价可控：标记全是半透明，滑块仍能从颜色里
 * 认出来，而画布 `pointer-events: none`，拖滑块一点不受影响。
 *
 * 挂载点选 `view.dom`（`.cm-editor`，CM6 base theme 给了 `position: relative`）：
 * 不进 `.cm-scroller`（那里面会跟着内容滚），也不改任何既有布局。
 */
export function overviewRuler(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly canvas: HTMLCanvasElement;
      private zones: OverviewZone[];
      private frame = 0;
      private readonly onScroll = () => this.schedule();
      private readonly onResize = () => this.schedule();
      private readonly observer: ResizeObserver | null;

      constructor(private readonly view: EditorView) {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "cm-overview-ruler";
        this.canvas.setAttribute("aria-hidden", "true");
        view.dom.appendChild(this.canvas);
        this.zones = overviewZones(view.state);
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        this.observer =
          typeof ResizeObserver === "function" ? new ResizeObserver(this.onResize) : null;
        this.observer?.observe(view.dom);
        this.paint();
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.transactions.some((tr) => tr.effects.length > 0)
        ) {
          this.zones = overviewZones(update.state);
        }
        // 主题/尺寸/几何变化不换 zone，但仍要重画（颜色与行盒都可能刚变）。
        this.paint();
      }

      destroy(): void {
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        this.observer?.disconnect();
        if (this.frame && typeof cancelAnimationFrame === "function")
          cancelAnimationFrame(this.frame);
        this.canvas.remove();
      }

      private schedule(): void {
        if (typeof requestAnimationFrame !== "function") {
          this.paint();
          return;
        }
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.paint();
        });
      }

      private paint(): void {
        const view = this.view;
        const contentHeight = view.contentHeight;
        // 横向滚动条占掉的那几像素不算在标尺高度里（上游 `domHeight` 是 `outerHeight - 横向条`）。
        const hScroll = Math.max(0, view.scrollDOM.offsetHeight - view.scrollDOM.clientHeight);
        const height = view.dom.clientHeight - hScroll;
        if (!(contentHeight > 0) || !(height > 0)) return;
        this.canvas.style.height = `${height}px`;
        const width = this.canvas.clientWidth;
        if (!(width > 0)) return;
        const doc = view.state.doc;
        const rects = layoutOverview(
          this.zones,
          {
            height: contentHeight,
            topOf: (line) => view.lineBlockAt(doc.line(line).from).top,
            heightOf: (line) => view.lineBlockAt(doc.line(line).from).height,
          },
          width,
          height,
        );
        paintOverview(this.canvas, rects);
      }
    },
  );
}
