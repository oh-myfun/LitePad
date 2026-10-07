import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import {
  highlightSelectionMatches,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { findHighlight } from "./find";
import { perfProfileFor, type PerfProfile } from "./perf";
import { CODICONS } from "../shell/codicons";

export interface EditorHandle {
  view: EditorView;
  getText(): string;
  /** 多标签核心：整态切换（撤销历史随 EditorState 保留） */
  setState(state: EditorState): void;
  focus(): void;
}

/**
 * 折叠标记：内联 SVG chevron。
 *
 * ⚠️ 图标红线（docs/conventions.md「图标」节）：一律取 VS Code codicon，不手绘。
 * 这里原先手写了两段 12px 视图框的 chevron path，现改取官方的 chevron-down /
 * chevron-right —— 16 网格，正好填满 `.cm-fold-marker` 的 16px 槽位（见 global.css）。
 * 颜色与悬停效果仍走 CSS 变量，随深浅色联动。
 */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-fold-marker";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = open ? CODICONS.chevronDown : CODICONS.chevronRight;
  return span;
}

/**
 * B265：底部留白（scroll past end）—— 让**最后一行**能滚到容器**顶**、下面留一屏空白。
 *
 * 病在哪先摆清楚：源码这一格的可滚余量是 `scrollHeight − clientHeight`，而内容高只到
 * 「最后一行底」。想让最后一行贴容器顶，需要
 *
 *     maxScroll === 最后一行.top
 *     ⇔ baseContent + bleed − clientH === lastLineTop
 *     ⇔ bleed === lastLineTop + clientH − baseContent
 *
 * （`baseContent` = 不含留白的内容高；`.cm-content` 带 `min-height:100%`，所以它永远
 *   ≥ clientHeight —— 短文档那一路自动成立，不必另开分支。）
 *
 * 不加这一条 ⇒ 源码永远只能把最后一行滚到**视口底**（B260 实测 24 行 / 视口 3 行 ⇒ 上限
 * 294，末行 top 是 322），而预览因为按块排版、块高与行高不是一个量，它的「最后一块在顶」
 * 落在别处 ⇒ 两侧**自然上限天生不对齐**，滚到底时游标各自被自己那侧裁一刀（B260 那句
 * 「预览能到 966、源码只到 294」）。留出这一屏之后，两侧都能滚到「最后的内容贴顶」，
 * 「到底 top 位置对不上」整类问题从根上消掉。
 *
 * ⚠️ 留白写在 **CSS 变量** 上、由主题规则消费（不是直接写死 inline padding）：
 *     - inline style 会盖掉 `body.print-mode` 的既有打印规则 ⇒ 打印多出一屏空白；
 *     - 变量让 print 那条规则只要把 `--cm-bleed-bottom: 0px` 置掉就能归零（见 preview.css 同款）。
 * ⚠️ 量不出（离屏 `display:none` ⇒ clientHeight=0，或大文件降级还没测出行高）一律写 **0**，
 *    绝不写负值 —— 把「看不见」当成「可滚」会把这一格钉死在开头（B257 同型教训）。
 */
const BOTTOM_BLEED_VAR = "--cm-bleed-bottom";

/**
 * 这一格该留多少底部空白（px，可为小数）。
 * 见上面 `BOTTOM_BLEED_VAR` 那段的推导 —— 它就是那个 `bleed === lastLineTop + clientH − baseContent`。
 */
export function sourceBottomBleedPx(view: EditorView): number {
  const clientH = view.scrollDOM.clientHeight;
  if (!(clientH > 0)) return 0;
  // ⚠️ CM6 的 `Text` **没有** `lastLine()`（只有 `lines` / `line(n)`），拿文档长当 height
  //    去问又会落进上一行 ⇒ 明确取最后一行再问它的块。
  const doc = view.state.doc;
  const block = view.lineBlockAt(doc.line(doc.lines).from);
  // ⚠️ 基准高取 CM6 自己的 `contentHeight`，**不能**取 `contentDOM.offsetHeight`：
  //    后者把我自己刚加的那截 padding 也算进去 ⇒ 每重算一次 `baseContent` 就涨一截、
  //    算出来的留白就缩一截 ⇒ 先给 28、下一帧给 0、第三帧又 28…（分屏拖一下就抖）。
  //    `contentHeight` 只量文档行高，永远不含我加的空白，两次重算落同一个值。
  const baseContent = view.contentHeight;
  if (!(block.height > 0) || !(baseContent > 0)) return 0;
  return Math.max(0, block.top + clientH - baseContent);
}

function applyBottomBleed(view: EditorView): void {
  // ⚠️ 量不出就**一个字节都不写**：`setState` 那一帧编辑器还是 `display:none`（CM6 也还没
  //    测出新文档的行高），此刻算出来是 0 —— 照写就等于把上一帧那个对的值抹成 0，这一格
  //    就永远少了一屏可滚（B257 同型：写「瞬态的 0」比不写更糟，真机靠 ResizeObserver 补，
  //    但补之前那一小段里位置是错的）。
  if (view.scrollDOM.clientHeight <= 0 || view.contentHeight <= 0) return;
  view.scrollDOM.style.setProperty(BOTTOM_BLEED_VAR, `${sourceBottomBleedPx(view)}px`);
}

/**
 * 底部留白扩展：随**视口尺寸 / 文档 / 几何**变化重算（分屏、拖分隔条、换字号、切标签
 * 换来另一份文档都要跟）。`ResizeObserver` 打在 scrollDOM 上 —— 分屏那一格宽度一变，
 * 折行行数与行高跟着变，`clientHeight` 也在同一帧里变，所以观察容器本身就够了。
 */
function bottomBleedExtension(): Extension {
  return [
    // 变量宿主挂 scrollDOM（.cm-content 是它的子元素，变量沿继承下来拿到）
    EditorView.theme({ ".cm-content": { paddingBottom: `var(${BOTTOM_BLEED_VAR}, 0px)` } }),
    ViewPlugin.define((view: EditorView) => {
      const sync = (): void => applyBottomBleed(view);
      sync();
      let ro: ResizeObserver | null = null;
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => sync());
        ro.observe(view.scrollDOM);
      }
      return {
        update(u: ViewUpdate): void {
          if (u.docChanged || u.geometryChanged) sync();
        },
        destroy(): void {
          ro?.disconnect();
        },
      };
    }),
  ];
}

/**
 * 基础扩展集（所有标签共享同一份配置）。
 * 语言与主题用 Compartment 注入，每个 EditorState 持有独立 compartment 实例，
 * 因此切换标签（setState）时语言/主题/换行随快照自动恢复。
 *
 * M4：`perf` 按文档体量裁剪昂贵特性（语法高亮 / 折叠 / 括号匹配 / 选中匹配高亮 /
 * 当前行高亮），见 `perf.ts`。行号与撤销历史始终保留——它们是导航与安全的底线。
 */
function baseExtensions(perf: PerfProfile): Extension[] {
  const ext: Extension[] = [
    lineNumbers(),
    history(),
    drawSelection(),
    dropCursor(),
    // 列编辑：Alt + 拖选
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    // 缩进：4 空格 + 输入时自动缩进
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    indentOnInput(),
    // 括号：匹配高亮 + 自动闭合
    closeBrackets(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      // 折叠键位（foldKeymap：Ctrl-Shift-[ / ] 折叠展开光标块、Ctrl-Alt-[ / ] 全部）
      // 不在这里注册——已收归 src/shell/keymap.ts 统一管理，这样设置里能改键，
      // 且菜单显示的键位提示与实际生效键位始终一致。折叠由 editor.ts 之外的
      // foldOperation / foldCodeOperation 驱动。
      // 选中区扩展：CM searchKeymap 里只保留这两条有用的。
      // 其余（Mod-f / F3 / Mod-g / Escape / Mod-Alt-g）会打开 CM6 自带搜索面板或抢键，
      // 与“悬浮查找栏统一入口”冲突——查找统一由 src/shell/findbar.ts 处理。
      { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
      { key: "Mod-Shift-l", run: selectSelectionMatches },
      indentWithTab,
    ]),
    // 查找命中高亮（由悬浮查找栏通过 setFindQuery 驱动）
    findHighlight(),
  ];

  if (perf.activeLine) {
    ext.push(highlightActiveLineGutter(), highlightActiveLine());
  }
  if (perf.folding) {
    ext.push(foldGutter({ markerDOM: foldMarkerDOM }));
  }
  if (perf.bracketMatching) {
    ext.push(bracketMatching());
  }
  if (perf.selectionMatches) {
    ext.push(highlightSelectionMatches());
  }
  // B265：底部留白（末行能滚到容器顶）—— 与上面几档一样按 perf 之外无条件注入：
  // 它是滚动几何的一部分，不是可裁剪的开销，关掉它「到底 top 对不齐」就直接回来。
  ext.push(bottomBleedExtension());
  return ext;
}

interface EditorStateEnv {
  dark: boolean;
  wrap: boolean;
  /** M4 大文件分级档位；缺省 normal（新建/未命名文档） */
  perf?: PerfProfile;
}

export interface TabCompartments {
  theme: Compartment;
  wrap: Compartment;
  lang: Compartment;
}

export interface TabState {
  state: EditorState;
  comps: TabCompartments;
}

/**
 * 构造一个标签的 EditorState：文档内容 + 语言 + 主题/换行。
 * 返回 compartment 引用，供离线更新非活动标签（如切换主题时
 * `tab.state.update({ effects: comps.theme.reconfigure(...) })`）。
 *
 * M4：`env.perf.syntax === false` 时不注入语言扩展（语法高亮是最大的一项开销）。
 * 语言 compartment 仍然建着——用户后续手动改回时无需重建状态。
 */
export function makeTabState(
  doc: string,
  language: Extension | null,
  env: EditorStateEnv,
  onUpdate: (view: EditorView, update: ViewUpdate) => void,
): TabState {
  const perf = env.perf ?? perfProfileFor("normal");
  const comps: TabCompartments = {
    theme: new Compartment(),
    wrap: new Compartment(),
    lang: new Compartment(),
  };
  const state = EditorState.create({
    doc,
    extensions: [
      ...baseExtensions(perf),
      comps.wrap.of(env.wrap ? EditorView.lineWrapping : []),
      comps.theme.of(env.dark ? oneDark : []),
      comps.lang.of(perf.syntax ? (language ?? []) : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) {
          onUpdate(update.view, update);
        }
      }),
    ],
  });
  return { state, comps };
}

/**
 * CodeMirror 6 封装（M1 多标签）：
 * 单一 EditorView 承载多个标签，切换 = view.setState(标签快照)。
 */
export function createEditor(parent: HTMLElement, initialState: EditorState): EditorHandle {
  const view = new EditorView({ state: initialState, parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setState: (state) => view.setState(state),
    // B182：程序化聚焦的唯一出口（切标签 / 切面板 / 挂载 / 关浮层…都走这里）。
    //
    // ⚠️ 光 `focus()` 还不够 —— 它只做 `focusPreventScroll(contentDOM)` +
    //    `docView.updateSelection()`，**不刷新 `cm-focused` 类**；那个类只在
    //    `updateAttrs()` 里按实时 `hasFocus` 重算（`"cm-editor" + (hasFocus?"
    //    cm-focused ":" ")`），而 `updateAttrs()` 只在构造 / 整态切换 / 事务更新时跑。
    //    切标签恰好把这几件事串成一漏拍：点标签 → 编辑器失焦 → 换文档（整态切换的
    //    `updateAttrs()` 是在**还没聚焦**时跑的 ⇒ 类被剥掉）→ 立刻重新聚焦（焦点
    //    回来了却不重算类）。唯一会补类的兜底是 CM6 那个 10ms 的
    //    `updateForFocusChange`，可它判的是 `hasFocus != notifiedFocused` ——
    //    焦点早在它跑之前就回来了，两边都真 ⇒ 判定「焦点没变」直接跳过 ⇒ 类永久缺失。
    //    而 `.cm-cursor` 默认 `display:none`，只有 `&.cm-focused` 才 `display:block`
    //    并挂上闪烁动画 ⇒ 焦点其实在编辑器里（能输入、方向键有反应），光标却不显示
    //    也不闪 —— 就是「切完标签看不到跳动的光标，得点一下编辑区才出来」。
    //    这里补一次**空更新**：它正是 CM6 自己那条兜底路径（`view.update([])`）
    //    会做的事，同步把 `updateAttrs()` 跑一遍 —— 类的权威判据仍是 `hasFocus`，
    //    我们只是把「等 10ms 才补」提前到现在。类本来就对时它是个空操作。
    focus: () => {
      view.focus();
      view.update([]);
    },
  };
}
