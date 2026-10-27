// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:851-898
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 装饰的总装；B397-1 一颗 view 两档；**B398 照 VS Code 把解析收进视口**。
//
// B398 改了两处（相对 InkNote 的写法）：
//   1. 语法树**只解析到「视口末端 + 前瞻」**（`previewSyntaxTree(state, to, 20)`）。
//      InkNote 的 `ensureSyntaxTree(state, doc.length, 100)` 是每键 100ms 的强制全文 parse：
//      3.2MB 夹具实测 110ms/键；收到视口后同一夹具 5–7ms（`.tmp/probe/big-md-bench.test.ts`）。
//      视口之外由 CM6 自己的 parseWorker 在空闲时推进，推进后它会 dispatch `Language.setState`
//      ⇒ 这里的 `tree !== value.tree` 那一条把新解析出来的装饰接上。
//   2. 重建时机只留这几种：文档变化 / 视口跑出已解析区（`setViewWindow`）/ 只读锁换 /
//      围栏 draft 或图片基准换 / 解析推进。**在已解析区里纯滚动不重建**
//      （整篇重建在 1MB 夹具上 ~10ms，不能挂在每帧上）。
//
// 为什么装饰还在 StateField 里、而不是照 VS Code 搬进 ViewPlugin：CM6 明文禁止
// **块级装饰**由插件提供（`Block decorations may not be specified via plugins`），
// 而表格 / 代码块 / mermaid 全是块级替换。所以状态里留字段、视口靠一个只管
// 「这一屏解析过没有」的小插件喂 effect —— 块级装饰照样是状态的产物。
//
// `provide` 里是**两条** `EditorView.decorations.from`，不是一条返回数组：
// `compute`/`from` 的取值函数必须给单个 DecorationSource，返回 `[a, b]` 会让 CM6
// 把整个数组当成一个源去读 `isEmpty` 直接抛（Task 1 实测，探针 .tmp/b391-probe.ts）。
//
// B397-1：这里不再有构造期的 `readOnly` 参数。所见即所得是**同一颗 view 的一档**，
// 只读是与之正交的另一把锁（`EditorState.readOnly` facet），所以「这一份许不许因光标
// 显形」只能在重建装饰时问 state —— 与 InkNote 的 `visiblePreview()`（editor.ts:861-866）
// 同一条语义：**只读时装饰反而更彻底**（不做 reveal 过滤，标记全程折好）。

import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { assetBase, setAssetBase } from "./assets";
import { applySelection, buildPreviewSets, type BlockRange, type PreviewSets } from "./previewSets";
import { previewSyntaxTree, setDraftFences } from "./codeFence";
import "./deco.css";

const ATOMIC_MARK = Decoration.mark({});

/** 视口之后再往下解析多少字符（≈ 一两屏）：滚到那儿时树已经在，不闪源码。 */
const PARSE_AHEAD = 20000;
/** 单次同步解析的预算（ms）：超了就先用已经解析到的部分，下一发再补。 */
const PARSE_BUDGET = 20;

interface LivePreviewState extends PreviewSets {
  /** statics 按当前选区过滤后的结果（只读面 = statics 本身）。 */
  visible: DecorationSet;
  /** 这一发建装饰用的树（与 `state` 里 parseWorker 的树比身份，判断解析有没有推进）。 */
  tree: Tree;
  /** 那棵树解析到哪个位置 —— 视口跑出这个数就要再解析一屏。 */
  parsedTo: number;
}

/** 视口末端（多段视口取最后一段；jsdom 下没有布局，读到 0 就只解析前瞻那一段）。 */
function viewportEnd(view: EditorView): number {
  const ranges = view.visibleRanges;
  return ranges.length ? ranges[ranges.length - 1].to : 0;
}

function atomicBlockRanges(sets: readonly BlockRange[]): DecorationSet {
  if (!sets.length) return Decoration.none;
  return Decoration.set(
    sets.map((b) => ATOMIC_MARK.range(b.from, b.to)),
    true,
  );
}

/** 只读 = 不做光标显形过滤（标记永远折着），与 InkNote `visiblePreview` 同口径。 */
function visiblePreview(statics: DecorationSet, state: EditorState): DecorationSet {
  return state.facet(EditorState.readOnly) ? statics : applySelection(statics, state);
}

/**
 * 视口喂给字段的那一发（B398）。
 *
 * 字段里读不到视口，而「这一屏解析过没有」只有视图知道 ⇒ 视口跑出已解析区时，
 * 由下面的小插件发一发 effect，字段按新视口重建。
 */
const setViewWindow = StateEffect.define<number>();

const viewWindow = StateField.define<number>({
  create: () => PARSE_AHEAD,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setViewWindow)) return effect.value;
    return value;
  },
});

function buildLive(state: EditorState): LivePreviewState {
  const viewTo = state.field(viewWindow, false) ?? 0;
  const to = Math.min(state.doc.length, viewTo + PARSE_AHEAD);
  const tree = previewSyntaxTree(state, to, PARSE_BUDGET);
  const built = buildPreviewSets(state, tree);
  return {
    ...built,
    visible: visiblePreview(built.statics, state),
    tree,
    parsedTo: Math.min(tree.length, state.doc.length),
  };
}

const livePreviewField = StateField.define<LivePreviewState>({
  create: (state) => buildLive(state),
  update(value, tr) {
    const tree = syntaxTree(tr.state);
    const windowMoved = tr.effects.some((effect) => effect.is(setViewWindow));
    const draftOrAsset = tr.effects.some(
      (effect) => effect.is(setDraftFences) || effect.is(setAssetBase),
    );
    if (tr.docChanged || windowMoved || draftOrAsset || tree !== value.tree) {
      return buildLive(tr.state);
    }
    // 只读锁换了也要重建：`visible` 的过滤口径跟着 facet 走，不重建就把上一把锁的读数留下
    if (
      tr.startState.facet(EditorState.readOnly) !== tr.state.facet(EditorState.readOnly) ||
      !tr.startState.selection.eq(tr.state.selection)
    ) {
      return { ...value, visible: visiblePreview(value.statics, tr.state) };
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.lines),
    EditorView.decorations.from(f, (v) => v.visible),
    EditorView.atomicRanges.of((view) => atomicBlockRanges(view.state.field(f).atomicBlocks)),
    EditorView.editorAttributes.of({ class: "md-deco" }),
  ],
});

/**
 * 视口跑出已解析区 ⇒ 让字段再解析一屏。
 *
 * 只在这一种情况下开口，普通滚动（已经解析过）不发 effect。`askedTo` 防同一位置重复发：
 * 预算用完没解析到位时，剩下的交给 CM6 的 parseWorker（它推进后字段自己会重建）。
 */
const viewportSync = ViewPlugin.fromClass(
  class {
    askedTo = -1;

    update(update: ViewUpdate) {
      if (!update.viewportChanged && !update.docChanged) return;
      const to = viewportEnd(update.view);
      const parsed = update.view.state.field(livePreviewField, false)?.parsedTo ?? 0;
      if (to <= parsed) {
        this.askedTo = -1;
        return;
      }
      if (to === this.askedTo) return;
      this.askedTo = to;
      update.view.dispatch({ effects: setViewWindow.of(to) });
    }
  },
);

/** 所见即所得档的装饰扩展（进 `previewCompartment`，源码档换成了空）。 */
export function livePreview(): Extension {
  // `assetBase` 与本字段同生共死（只在这一档里存在）；重建由 `setAssetBase` 触发
  return [assetBase, viewWindow, livePreviewField, viewportSync];
}

/** 这一档装在这份 state 上吗（换档前问一句，避免无谓的 reconfigure 重 parse 全篇）。 */
export function wysiwygInstalled(state: EditorState): boolean {
  return state.field(livePreviewField, false) !== undefined;
}
