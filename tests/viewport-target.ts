// B136 · 「恢复视口时按哪一行定位」在 jsdom 里怎么看？
//
// jsdom 不做布局，CM6 量到的 `editorHeight` 恒为 0 —— `@codemirror/view` 的 measure()
// 里 `if (this.viewState.editorHeight)` 那一支根本不进，`scrollIntoView` 效果**投递出去了
// 却永远不会被落到 `scrollDOM.scrollTop` 上**。所以「最终滚到多少 px」在 jsdom 里无从验证，
// 硬断言 px 只会写出一条自欺欺人的用例。
//
// 但效果本身是真实投递的。这里在 `EditorView.prototype.dispatch` 上挂一层记录，把每次
// `EditorView.scrollIntoView` 的**目标位置**收出来：恢复视口究竟按行还是按 px、落的
// 是不是上次那一行，看这个一针见血。
import { EditorView } from "@codemirror/view";
import type { Transaction } from "@codemirror/state";

/** 一次「滚动定位」的效果记录。 */
export interface ViewportTarget {
  /** 目标位置（文档偏移）。 */
  pos: number;
  /** 对齐方式：`start` / `center` / `nearest`。 */
  y: string;
}

interface RawTarget {
  range?: { head?: number };
  y?: string;
}

let log: ViewportTarget[] = [];
let installed = false;

/**
 * CM6 没把 `scrollIntoView` 的**效果类型**暴露出来 —— `EditorView.scrollIntoView()` 是
 * 「按这个效果造一个 ScrollTarget」的快捷方法，不是效果类型本身（`effect.is(...)` 恒假）。
 * 所以拿一个样本效果，按 `type` 比对。
 */
const SCROLL_INTO_VIEW_TYPE = (
  EditorView.scrollIntoView(0, { y: "start" }) as unknown as {
    type: unknown;
  }
).type;

function capture(tx: Transaction): void {
  for (const effect of tx.effects) {
    if ((effect as unknown as { type: unknown }).type !== SCROLL_INTO_VIEW_TYPE) continue;
    const raw = effect.value as unknown as RawTarget | null;
    const head = raw?.range?.head;
    if (typeof head !== "number") continue;
    log.push({ pos: head, y: raw?.y ?? "" });
  }
}

/** 装上记录器（每个测试文件装一次即可，重复装是幂等的）。 */
export function installViewportSpy(): void {
  if (installed) return;
  installed = true;
  const proto = EditorView.prototype as unknown as {
    dispatch: (this: EditorView, ...specs: readonly unknown[]) => void;
  };
  const original = proto.dispatch;
  proto.dispatch = function patchedDispatch(this: EditorView, ...specs: readonly unknown[]): void {
    const spec = specs[0];
    if (spec && typeof spec === "object" && "effects" in (spec as object)) {
      // 从 spec 造一个事务只为读 effects —— `state.update()` 是纯的，不会改到视图
      const tx = (this.state as unknown as { update: (s: unknown) => Transaction }).update(spec);
      capture(tx);
    }
    return original.apply(this, specs as never);
  };
}

/** 取出并清空记录。 */
export function takeViewportTargets(): ViewportTarget[] {
  const taken = log;
  log = [];
  return taken;
}

/** 最近一次定位目标（只读，不取走 —— 排程方与断言方都要看，谁先取走谁就作弊）。 */
export function lastViewportTarget(): ViewportTarget | null {
  return log.length ? log[log.length - 1] : null;
}

/**
 * 把「第 line 行」真正落进 `scrollDOM`（jsdom 专用的一步）。
 *
 * 真机上 CM6 的 measure 会把 `scrollIntoView` 的效果写到 `scrollDOM.scrollTop` 上，
 * 于是「切走时记顶行」记到的是用户实际看到的那一行。jsdom 里这步不会发生，视图的
 * scrollTop 恒为 0 —— `rememberViewScroll` 就会把位置记成第 1 行（看起来像「位置丢了」）。
 * 用例必须先补这一步，才谈得上测「每个标签各记各的位置 / 还原到原来那一行」。
 */
export function settleViewport(view: EditorView, line: number): void {
  view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(line).from).top;
}

/** 该视图下记录里落到指定行号的那几次定位（行号 1-based）。 */
export function targetsOnLine(view: EditorView, line: number): ViewportTarget[] {
  const max = view.state.doc.length;
  return takeViewportTargets().filter((t) => {
    const at = view.state.doc.lineAt(Math.min(Math.max(t.pos, 0), max)).number;
    return at === line;
  });
}
