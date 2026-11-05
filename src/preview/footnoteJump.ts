// B450 · 点脚注上标 ⇒ 滚到那条定义 + 给它闪一下。
//
// 监听必须挂在**上标自己的 DOM** 上，不能走 `EditorView.domEventHandlers`：那颗 `<sup>`
// 是 `InlinePreviewWidget` 的 widget，而它的 `ignoreEvent()` 返回 true ⇒ CM6 在
// `eventBelongsToEditor` 阶段（@codemirror/view/dist/index.js:4867-4877）就把整发事件丢了，
// view 级的闸根本收不到 —— 与 `tableWidget.ts` 头部那条注释同一道命门（也是 B401 链接那颗
// 从来不在 widget 里的原因：链接画在 `.cm-line` 的普通 span 上，事件能冒到 contentDOM）。
//
// 两档的闸与链接同一条口径（不新造规则）：预览档（锁着）普通点击就跳，编辑档按 Ctrl ——
// 不按的那一下仍归「放光标 / 把 `[^1]` 源码显形」，由 `bindBlockClickEdit` 接走。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 落点卡片上的闪一下类（CSS 侧 `@keyframes md-metadata-jump`）。 */
export const JUMP_FLASH = "md-metadata--jump";

/**
 * 滚过去 + 给落点那张卡片闪一下（告诉用户「跳到了这儿」，不然长文档里只会看见画面动了）。
 *
 * ⚠️ 目标卡片可能**还没进视口**：CM6 只挂视口内的块 widget ⇒ 第一发按估算高度滚，
 * 渲染出来以后才找得到那颗 DOM。找不到就隔一帧再找几发（滚动本身可重复派发，落点会随
 * 真实高度收敛）。闪完要摘掉：常挂着就成了「这张卡片被选中」的假信号。
 */
export function jumpToFootnote(view: EditorView, target: number, tries = 6): void {
  if (!Number.isFinite(target)) return;
  view.dispatch({ effects: EditorView.scrollIntoView(target, { y: "start", x: "center" }) });
  const el = view.dom.querySelector<HTMLElement>(`[data-block-from="${target}"]`);
  if (!el) {
    if (tries > 0) setTimeout(() => jumpToFootnote(view, target, tries - 1), 30);
    return;
  }
  el.classList.remove(JUMP_FLASH);
  void el.offsetWidth; // 重排一次才重放得动同名动画（连点两颗上标时第二次也要看得见）
  el.classList.add(JUMP_FLASH);
  setTimeout(() => el.classList.remove(JUMP_FLASH), 900);
}

/**
 * 给一颗脚注上标挂上跳转。`target` 为 null（那条 `[^x]` 没有定义）就什么都不做 ——
 * 没有落点的键点了没反应比不挂更难解释，所以 CSS 侧的 pointer 也靠 `[data-fn-jump]` 筛。
 */
export function bindFootnoteJump(el: HTMLElement, target: number | null): void {
  if (target === null) return;
  el.addEventListener("mousedown", (event) => {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return;
    const view = EditorView.findFromDOM(el);
    if (!view) return;
    const locked = view.state.facet(EditorState.readOnly);
    if (!locked && !mouse.ctrlKey && !mouse.metaKey) return;
    mouse.preventDefault();
    mouse.stopPropagation();
    jumpToFootnote(view, target);
  });
}
