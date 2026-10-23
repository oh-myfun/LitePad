export type IrRenderMode = "off" | "ir";
export type IrStateName = "source" | "render-locked" | "render-editable";

export interface IrState {
  liveRender: IrRenderMode;
  irLocked: boolean;
}

/** 产品拍板（B352）：默认锁着 —— 新开的文档落在 B（渲染·锁），不是 C（渲染·可写）。 */
export const IR_DEFAULT: IrState = { liveRender: "off", irLocked: true };

/**
 * 态的名字，键是 `${liveRender}:${irLocked}`。
 *
 * 只有一个消费者组：`irStateName()`。Task 6（点击）、Task 8（字形）、Task 10（会话回落）
 * 都经 `irStateName()` 取，不许自己再开一张表 —— 悬浮键的三态显示和它实际落在的状态
 * 一旦各算各的，就是 B304 那一族「显示与行为两套口径」。
 */
export const IR_STATE_NAME: Record<string, IrStateName> = {
  "off:true": "source",
  "ir:true": "render-locked",
  "ir:false": "render-editable",
};

/** 非法组合（会话里读到 `wysiwyg` 之类）退到 source：露源码永远比露一个错的渲染态安全。 */
export function irStateName(s: IrState): IrStateName {
  return IR_STATE_NAME[`${s.liveRender}:${s.irLocked}`] ?? "source";
}

/**
 * 悬浮键的那一条边：A 源码 → B 渲染·锁 → C 渲染·可写 → A。
 *
 * 写成显式三行分支而不是布尔算术 —— 循环顺序就是这颗键的全部行为，评审要一眼看出「只有三条边」。
 * `readonly` 的文档里 C 不可达（B 的下一发直接回 A）：可写态要求文档本身可写，
 * 不是要求用户没点上锁。
 */
export function nextIrState(cur: IrState, opts: { readonly: boolean }): IrState {
  switch (irStateName(cur)) {
    case "source":
      return { liveRender: "ir", irLocked: true };
    case "render-locked":
      return opts.readonly ? { ...IR_DEFAULT } : { liveRender: "ir", irLocked: false };
    case "render-editable":
      return { ...IR_DEFAULT };
  }
}

/** 会话里读回来的值先过这里：只认 off|ir，锁态没记过就当锁着。 */
export function coerceIrState(raw: {
  liveRender?: string | null;
  irLocked?: boolean | null;
}): IrState {
  return {
    liveRender: raw.liveRender === "ir" ? "ir" : "off",
    irLocked: raw.irLocked !== false,
  };
}

/**
 * 命令层的写入口闸：只有「渲染 + 锁」那一态改不了文本。
 *
 * 定义放在这个叶子模块而不是 `src/markdown.ts`：查找栏（`src/find/findbar.ts`）与
 * `src/commands.ts` 都要问锁，而 `markdown.ts` 反向 import 着 findbar —— 让它们经
 * `markdown.ts` 取这道闸就是一张新依赖环。叶子模块无 DOM、无副作用，谁都能取。
 *
 * ⚠️ 这道闸是承重的，不是重复保险：锁的 `changeFilter` 只拒「改文本且带
 * `Transaction.userEvent` 标注」那一类，而 F5 插入时间与查找栏替换都是**不带标注的
 * 程序化 `dispatch`** ⇒ 走编辑器那层拦不住（`tests/ir-apply.test.ts` 证的是「必须放行」）。
 */
export function irEditable(s: IrState): boolean {
  return s.liveRender === "off" || !s.irLocked;
}

/**
 * 直达命令 `view.liveRender`：进/出渲染，**锁态一位都不动**（spec §命令）。
 *
 * 与悬浮键的循环（`nextIrState`）刻意不同：循环 A→B 恒锁着（产品拍板「默认锁着」），
 * 这一发则尊重用户上一轮留下的锁值 —— 在渲染里解过锁、回源码、再进来，还是可写。
 * 只读文档除外：C 不可达，所以进渲染时把锁按回 true（与 `nextIrState` 同一条约束）。
 */
export function toggleIrRenderState(cur: IrState, opts: { readonly: boolean }): IrState {
  const liveRender: IrRenderMode = cur.liveRender === "off" ? "ir" : "off";
  return { liveRender, irLocked: opts.readonly ? true : cur.irLocked };
}

/**
 * 直达命令 `view.toggleLock`：只翻锁，渲染态不动。
 *
 * 源码态里点它 = 先进渲染、且恒锁着：锁只管渲染面，源码态翻一个没人看的布尔值就是死键
 * （B314-8 那一族：登记了但点下去什么都没发生）。恒锁而非沿用残值，是为了守住
 * 「A→渲染 恒为锁着」这一条 —— 想直接落在可写态，先 `view.liveRender` 再翻锁。
 */
export function toggleIrLockState(cur: IrState, opts: { readonly: boolean }): IrState {
  if (cur.liveRender === "off") return { liveRender: "ir", irLocked: true };
  // 只读文档的 C 不可达：翻不动就原地留着，别造出一个装模作样的「可写渲染态」
  if (opts.readonly) return cur;
  return { liveRender: "ir", irLocked: !cur.irLocked };
}
