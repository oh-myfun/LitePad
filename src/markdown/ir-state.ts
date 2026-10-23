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
