// 「显示不可见字符」（查看菜单）的装饰面：与 VS Code 的 `editor.renderWhitespace = all` 同口径，
// 只认空格与 Tab 两种 —— 上游 whitespace.ts 的判断也只有 charCode 32 / 9，NBSP、全角空格不算。
//
// 画法是「底色点阵 + 伪元素」，**不往正文里插字符**：插进去的 · / → 会被复制、被查找命中、
// 被抓去当折行宽度，三样都是改坏原文。空格按「连续 run」挂一段 mark，CSS 以 1ch 平铺，
// 一个字符格一个中点；Tab 要一个字符一个箭头，而 CM6 会把相邻且 spec 相等的 mark 并成
// 同一个 span（`MarkDecoration.eq` 只比 tagName / attrs，`ensureMarks` 见 openStart > 0 就
// 续用上一颗）⇒ 每颗 Tab 的装饰带一个随位置变化的属性，判等为假，箭头才数得清
// （Tab 在视口里本来就少，多出来的这点 DOM 不值得再去省）。
//
// 预览档不画：那里空格已经被渲染成排版（列表缩进、代码块），再点点是噪声。判据用
// `wysiwygInstalled` —— 与 appearance.ts 里「这份 state 是不是装饰面」同一颗问法。

import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { wysiwygInstalled } from "../preview/livePreview";

const SPACE = 32;
const TAB = 9;

const spaceMark = Decoration.mark({ class: "cm-ws-space" });

/** 每颗 Tab 单独一段：属性值只为挡住合并（见文件头），视觉不读它。 */
const tabMark = (pos: number): Decoration =>
  Decoration.mark({ class: "cm-ws-tab", attributes: { "data-lp-tab": String(pos) } });

/** 把 [from, to) 里的空白字符按序放进 builder（区间可能从行中间切进来，所以按行夹取）。 */
function addInvisibles(
  builder: RangeSetBuilder<Decoration>,
  state: EditorState,
  from: number,
  to: number,
): void {
  let pos = from;
  while (pos < to) {
    const line = state.doc.lineAt(pos);
    const end = Math.min(line.to, to) - line.from;
    let i = pos - line.from;
    while (i < end) {
      const code = line.text.charCodeAt(i);
      if (code === SPACE) {
        const runFrom = line.from + i;
        do i++;
        while (i < end && line.text.charCodeAt(i) === SPACE);
        builder.add(runFrom, line.from + i, spaceMark);
      } else {
        if (code === TAB) builder.add(line.from + i, line.from + i + 1, tabMark(line.from + i));
        i++;
      }
    }
    if (line.to >= to) break;
    pos = line.to + 1;
  }
}

/** 一段区间里的不可见字符装饰（测试入口：不依赖视口）。 */
export function invisiblesIn(state: EditorState, from: number, to: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  addInvisibles(builder, state, from, to);
  return builder.finish();
}

function visibleInvisibles(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) addInvisibles(builder, view.state, from, to);
  return builder.finish();
}

class InvisibleCharsPlugin {
  decorations: DecorationSet;
  private preview: boolean;

  constructor(view: EditorView) {
    this.preview = wysiwygInstalled(view.state);
    this.decorations = this.preview ? Decoration.none : visibleInvisibles(view);
  }

  update(update: ViewUpdate): void {
    const preview = wysiwygInstalled(update.state);
    if (preview === this.preview && !update.docChanged && !update.viewportChanged) return;
    this.preview = preview;
    this.decorations = preview ? Decoration.none : visibleInvisibles(update.view);
  }
}

const plugin = ViewPlugin.fromClass(InvisibleCharsPlugin, {
  decorations: (v) => v.decorations,
});

/**
 * 这一档的扩展面（关着 = 空数组）。共享同一份实例：差异格的左栏靠 `===` 它来判断
 * 「现在这一档开着没」，每次现造一份就判不出来了。
 */
const face: Extension = plugin;

export function invisibleChars(): Extension {
  return face;
}
