/**
 * 程序滚动来源标记 —— VS Code `scrollType` 范式的等价合成。
 *
 * WebView2 / CM6 的 DOM `scroll` 事件**不携带来源标记**，无法区分「程序摆的」还是
 * 「用户滚的」。VS Code 的 `onDidScrollChange` 自带 `scrollType` 位标志、随事件携带，
 * 接收方见 `Programmatic` 即早退、绝不靠时间窗猜 —— 这里把那个标志**合成**出来：
 *
 *   每次我们程序定位赋值 `el.scrollTop = X` 之前，对目标 `markProgrammatic(el)`；目标
 *   自己的 scroll 监听一见标记就吞掉这发回执（不写快照、不推兄弟）。
 *
 * 标记**靠用户接管滚动的真实输入清除**，不靠任何时间窗：wheel / 滚动键 / 触摸 / 拖滚动条
 * 都会清掉对应容器的标记，随后那发 scroll 才是真用户。这样彻底消除「渲染过程里 actual
 * 偏离 expect（setBlocks 归零再拉回、图片加载 / 重排位移）被误判成用户滚动反推」那类抖动，
 * 而且对几百 ms 后才到的迟到回执也免疫（VS Code 的 flag 随事件走，本方案用落点无关的
 * 状态等价之）。
 */

const programmaticMarks = new WeakMap<HTMLElement, boolean>();
const clearAttached = new WeakSet<HTMLElement>();

/** 记「这个容器即将被我们程序定位」—— 后面那一发 scroll 会被认作自家回执。 */
export function markProgrammatic(el: HTMLElement): void {
  programmaticMarks.set(el, true);
}

/** 用户接管了滚动：清掉该容器的程序标记，随后的 scroll 才算真用户。 */
export function clearProgrammatic(el: HTMLElement): void {
  programmaticMarks.delete(el);
}

/** 这一发 scroll 是不是我们刚程序定位的回执。 */
export function isProgrammatic(el: HTMLElement): boolean {
  return programmaticMarks.get(el) === true;
}

/** 给滚动容器挂「用户接管即清标记」的监听（幂等，重复调用无副作用）。 */
export function attachUserScrollClear(el: HTMLElement): void {
  if (clearAttached.has(el)) return;
  clearAttached.add(el);
  // wheel / 触摸：用户滚动的最常见入口，事件先于 scroll 派发，先清后吞。
  el.addEventListener("wheel", () => clearProgrammatic(el), { passive: true });
  el.addEventListener("touchstart", () => clearProgrammatic(el), { passive: true });
  // 键盘：方向键 / PageUp·Down / Home·End / 空格都会滚动编辑器，keydown 先于 scroll。
  el.addEventListener("keydown", () => clearProgrammatic(el));
  // 拖滚动条：命中外层滚动条槽位才算接管（点正文 / 选区不是滚动意图，不动标记）。
  el.addEventListener("pointerdown", (e: PointerEvent) => {
    const rect = el.getBoundingClientRect();
    const sbW = el.offsetWidth - el.clientWidth;
    const sbH = el.offsetHeight - el.clientHeight;
    const inV = sbW > 0 && e.clientX >= rect.right - sbW;
    const inH = sbH > 0 && e.clientY >= rect.bottom - sbH;
    if (inV || inH) clearProgrammatic(el);
  });
}
