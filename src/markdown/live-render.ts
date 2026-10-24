// 即时渲染（IR）的 CM6 装配层（B352-6）。
//
// 三件事，各管一段：
//   · `irBlocks`（StateField）—— 块表的家。块表由**外部算好塞进来**（`setIrBlocks`），
//     这里不 parse Markdown：装饰层每键重解析整篇是这条路头号的反目标。
//   · 装饰（ViewPlugin）—— 「谁被渲染、谁露源码」由 Task 3 的纯函数现算，本层只把它
//     翻译成 CM6 的 RangeSet。光标进出块**不产生事务**，只重算装饰。
//   · widget —— 一块一个 `<div>`，内容走预览那套 `.md-rendered` 排版 + `enhanceMarkdown`。
//
// ⚠️ 块级标志打在**装饰 spec** 上（`block: true`），不是 `WidgetType` 上：CM6 没有
// ProseMirror 那种 `WidgetType.define({block:true})`，少了这个标志 widget 会掉进
// `.cm-line` 里变内联，行盒与软折行跟着乱（B352-5 的探针实测，见 spec「spike 1 + 2 结案」）。

import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { enhanceMarkdown, nextEnhanceSeq } from "./enhance";
import { irDecorationsFor, irFocusLines, shiftBlocks, type IrLineShift } from "./ir-decorations";
import { flippedTaskMark, taskLineAt } from "./tasks";
import type { MdBlock } from "./pipeline";

const NO_BLOCKS: readonly MdBlock[] = [];

/** 把整篇的块表灌进状态（由 `src/markdown.ts` 的防抖刷新派发；单块重画也走它）。 */
export const setIrBlocks = StateEffect.define<readonly MdBlock[]>();

const irBlocksField = StateField.define<readonly MdBlock[]>({
  create: () => NO_BLOCKS,
  update(value, tr: Transaction) {
    for (const e of tr.effects) if (e.is(setIrBlocks)) return e.value;
    // 打字时防抖一直被重置 ⇒ 块表停在**旧行号**上，装饰会盖到别的行去（B352-11 评审 I5）。
    // 当场按行数增减把它对齐：整篇重算是这条路明令禁止的（8.8ms @5,000 行 × 每一次按键）。
    return tr.docChanged ? shiftBlocks(value, lineShiftsOf(tr)) : value;
  },
});

/** 一次事务对各块**旧行号**的影响（`shiftBlocks` 要的口径）。 */
function lineShiftsOf(tr: Transaction): IrLineShift[] {
  const oldDoc = tr.startState.doc;
  const shifts: IrLineShift[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const count = (text: string): number => {
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      return n;
    };
    if (toA > fromA) {
      // 删/换：旧区间 = 被吃掉的那几行；新区间 = 插入文本占的行数
      const removed = count(oldDoc.sliceString(fromA, toA)) + 1;
      const added = inserted.length > 0 ? count(inserted.toString()) + 1 : 0;
      shifts.push({
        from: oldDoc.lineAt(fromA).number,
        to: oldDoc.lineAt(toA - 1).number,
        deltaLines: added - removed,
      });
    } else {
      // 纯插入：改点只占「落在哪一行」这一行；行数增减 = 插入文本里的换行数
      shifts.push({
        from: oldDoc.lineAt(fromA).number,
        to: oldDoc.lineAt(fromA).number,
        deltaLines: count(inserted.toString()),
      });
    }
  });
  return shifts;
}

/** 读块表。IR 关着（字段不在配置里）时给空表，不抛 —— 关态必须真的零参与。 */
export function irBlocksOf(state: EditorState): readonly MdBlock[] {
  // 第二条参数是 `false`（「不在配置里就给我 undefined」），不是兜底值：CM6 的
  // `state.field(f, x)` 里那个 `x` 是 `require` 开关，传值进去它照样抛。
  return state.field(irBlocksField, false) ?? NO_BLOCKS;
}

export interface IrWidgetSpec {
  lineStart: number;
  lineEnd: number;
  html: string;
  /** 可写态（C）才挂「点块进编辑」的手势；锁态（B）与源码态都不挂 */
  editable: boolean;
  /** 相对路径图片的基准目录（预览同款，交给 `enhanceMarkdown`） */
  baseDir: string | null;
  /** 文档只读 ⇒ 勾选框保持灰着（管线给的 disabled 不摘），点了也不会有事件 */
  readonly: boolean;
}

export class IrBlockWidget extends WidgetType {
  constructor(readonly spec: IrWidgetSpec) {
    super();
  }

  /**
   * 比 (lineStart, lineEnd, html) **加上这一发的装配口径**（editable / baseDir）：与预览的增量
   * patch 同一口径（B319 岛级复用的教训）。命中 ⇒ CM6 复用同一个 DOM 节点 ⇒ 打字时其它块不重画、
   * KaTeX/Mermaid 不重跑。
   *
   * ⚠️ 后两位不是保险，是承重（B352-11 评审 C1）：`mousedown`（「点块进编辑」那颗手势）只在
   * `toDOM` 里按 `editable` 挂。少了它，默认流程 A→B→按那颗键解锁 就是「画面按 eq 复用旧节点、
   * 而旧节点上没有监听」—— 解锁之后点任何一块都没反应；反方向（C→B）则把旧监听留在节点上，
   * 锁态点块仍然动选区。`baseDir` 同理：文档改名/移动之后相对路径图片要按新目录重算。
   */
  override eq(other: IrBlockWidget): boolean {
    return (
      other.spec.lineStart === this.spec.lineStart &&
      other.spec.lineEnd === this.spec.lineEnd &&
      other.spec.html === this.spec.html &&
      other.spec.editable === this.spec.editable &&
      other.spec.baseDir === this.spec.baseDir &&
      other.spec.readonly === this.spec.readonly
    );
  }

  /**
   * `true` = 编辑器**忽略**这个事件（默认全忽略，那是给纯展示 widget 的）。
   *
   * 只放行 `mousedown`：CM6 对块 widget 的默认处理会把「按下」当编辑区里的普通按下，
   * 而我们要自己在 DOM 上把点的位置换算成文档位置（见 `toDOM` 里那个监听）。
   * 其余一律 `false` 交回编辑器 —— `keydown` 必须回到编辑器，否则可写态里打字打不进去；
   * `click`/`mousemove` 交回编辑器也不会惹事。
   */
  override ignoreEvent(event: Event): boolean {
    return event.type === "mousedown";
  }

  override toDOM(view: EditorView): HTMLElement {
    const outer = document.createElement("div");
    outer.className = "md-rendered md-ir-block";
    const inner = document.createElement("div");
    inner.className = "md-block";
    inner.dataset.lineStart = String(this.spec.lineStart);
    inner.dataset.lineEnd = String(this.spec.lineEnd);
    inner.innerHTML = this.spec.html;
    outer.appendChild(inner);
    // 管线给的勾选框自带 `disabled`（只读文档安全的缺省）。可写的文档摘掉它 ——
    // B358：渲染面上的勾选框是内容控件，锁态（B）也要能点，只读文档保持灰着。
    if (!this.spec.readonly) {
      for (const box of inner.querySelectorAll<HTMLInputElement>("input.md-task")) {
        box.disabled = false;
      }
    }
    // B358：点勾选框 = 翻转源码里那一行的 [ ]/[x]。映射只住 tasks.ts 一处。
    outer.addEventListener("click", (e) => {
      const box = (e.target as HTMLElement | null)?.closest?.("input.md-task");
      if (!(box instanceof HTMLInputElement)) return;
      // 只读文档的框带着 disabled —— 真浏览器不会给灰掉的控件派发 click，这里再挡一道，
      // 不指望各引擎对「程序化派发给 disabled 控件」的行为一致（jsdom 就会派）。
      if (box.disabled) return;
      e.preventDefault();
      const boxes = Array.from(outer.querySelectorAll<HTMLInputElement>("input.md-task"));
      const info = taskLineAt(
        view.state.doc,
        this.spec.lineStart,
        this.spec.lineEnd,
        boxes.indexOf(box),
      );
      if (!info) return;
      // ⚠️ 有意不带 `Transaction.userEvent`：锁的 changeFilter 只拒「带 userEvent 的写」，
      // 这一发要能过闸 —— 用户拍板锁着的渲染态也允许点勾选框。四条命令层写入口的锁闸
      // （评审 I3）管的是键盘/菜单路径，不管这一条；只读文档在上面就没解锁，进不来。
      view.dispatch({
        changes: { from: info.from, to: info.to, insert: flippedTaskMark(info.checked) },
      });
    });
    // 岛级增强与预览共用一份出口（Task 2）；失败自己吞掉。取号按**这一块**的根节点：
    // 一块一发，别块不许把它取消掉（B352-11 评审 C2，见 enhance.ts 那段注释）。
    void enhanceMarkdown(outer, nextEnhanceSeq(outer), {
      bigDoc: false,
      baseDir: this.spec.baseDir,
    });

    if (this.spec.editable) {
      outer.addEventListener("mousedown", (e) => {
        // 锁态压根不挂这个监听（`editable` 为假），所以这里不必再问锁 —— 也不许靠
        // `changeFilter` 兜：那条只管「文档改不改得动」，光标移动它挡不住。
        // 点在勾选框上要让开：这一下的职责是「把光标落进块」，而那会当场把块拆回源码，
        // 勾选框跟着被销毁 ⇒ click 永远到不了，B358 的切换在可写态就哑了。
        if ((e.target as HTMLElement | null)?.closest?.("input.md-task")) return;
        const mouse = e as MouseEvent;
        mouse.preventDefault();
        const doc = view.state.doc;
        const from = doc.line(Math.min(this.spec.lineStart, doc.lines)).from;
        const to = doc.line(Math.min(this.spec.lineEnd, doc.lines)).to;
        // 手势落在这块的 DOM 上 ⇒ 光标必须落进这一块。`posAtCoords` 可能给块外的位置
        // （块与块之间的空隙、没有布局的环境），块外就退回块首 —— 落进隔壁块是「点哪儿
        // 不是哪儿」，比落回本块首更错。
        const found = view.posAtCoords({ x: mouse.clientX, y: mouse.clientY }, false);
        const anchor = found === null || found < from || found > to ? from : found;
        view.dispatch({ selection: { anchor }, scrollIntoView: true });
      });
    }
    return outer;
  }
}

interface IrLayerOptions {
  locked: boolean;
  baseDir: string | null;
  readonly: boolean;
}

/**
 * 本层的配置住在状态里。
 *
 * 为什么不用闭包：装饰必须由 **StateField** 提供（见 `liveRenderExtensions` 那条注释），
 * 而字段实例是模块级单例（`irBlocksOf` 要能按它读块表）—— 构造装饰时读不到外面的闭包，
 * 只能读状态。锁态与基准目录就这样跟着 `comps.ir` 的 reconfigure 一起换。
 */
const irOptionsField = StateField.define<IrLayerOptions>({
  create: () => ({ locked: true, baseDir: null, readonly: false }),
  update: (v) => v,
});

/** 现算装饰：Task 3 的两个纯函数是唯一判据来源，本层不自己判相交。 */
function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const blocks = irBlocksOf(state);
  const opts = state.field(irOptionsField);
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decos: Range<Decoration>[] = [];
  for (const r of irDecorationsFor(blocks, selections, doc, opts.locked)) {
    decos.push(
      Decoration.replace({
        widget: new IrBlockWidget({
          lineStart: r.lineStart,
          lineEnd: r.lineEnd,
          html: r.html,
          editable: !opts.locked,
          baseDir: opts.baseDir,
          readonly: opts.readonly,
        }),
        block: true,
      }).range(r.from, r.to),
    );
  }
  for (const f of irFocusLines(blocks, selections, doc, opts.locked)) {
    if (f.line < 1 || f.line > doc.lines) continue;
    // B357：焦点行沿用那一块渲染后的字阶（标题块带 `md-ir-focus-hN`），点进标题
    // 不该让字从 25px 掉回 14px —— 那一下是「编辑态字体变小」的本体。
    const cls = f.heading > 0 ? `md-ir-focus-line md-ir-focus-h${f.heading}` : "md-ir-focus-line";
    decos.push(Decoration.line({ class: cls }).range(doc.line(f.line).from));
  }
  return Decoration.set(decos, true);
}

/**
 * 装饰字段：块表、文档、选区任一变了就重算，其余（含纯滚动）不动。
 *
 * ⚠️ 这条路是 CM6 唯一的合法路，不是风格选择：`EditorView.decorations` 的文档写明
 * 「以函数形式提供的装饰**不得**引入块 widget，也不得引入覆盖换行的替换装饰」
 * （`@codemirror/view/dist/index.d.ts:1311`，运行时是真抛 ——
 * `RangeError: Block decorations may not be specified via plugins`）。
 * ViewPlugin 的 `decorations: v => v.decor` 正是函数形式 ⇒ 用不了。
 * `EditorView.decorations.from(字段)` 走的是 FacetProvider，解析完是**直接的** DecorationSet
 * ⇒ 允许块装饰 —— CM6 自己的折叠就是这么挂的（`@codemirror/language/dist/index.js:1345`）。
 */
const irDecorField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(decor, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setIrBlocks)) ||
      tr.startState.field(irOptionsField, false) !== tr.state.field(irOptionsField)
    ) {
      return buildDecorations(tr.state);
    }
    return decor;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * IR 那一层的扩展。
 *
 * 关态（`ir: false`）**返回空数组**：三个字段都不进配置，源码面回到 B352 之前的行为，
 * 一分钱不花。开态由 `comps.ir` 切换（Task 7）—— 换锁态/换目录也是 reconfigure 这一份，
 * 字段值随之重建。
 */
export function liveRenderExtensions(opts: {
  ir: boolean;
  locked: boolean;
  baseDir: string | null;
  /** 文档只读（B358）：勾选框保持灰着 */
  readonly?: boolean;
}): Extension[] {
  if (!opts.ir) return [];
  const layer: IrLayerOptions = {
    locked: opts.locked,
    baseDir: opts.baseDir,
    readonly: opts.readonly ?? false,
  };
  return [irBlocksField, irOptionsField.init(() => layer), irDecorField];
}
