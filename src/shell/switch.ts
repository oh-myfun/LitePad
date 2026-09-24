/**
 * 开关组件（B111：设置页的布尔项改用 switch，不再用原生 `<input type="checkbox">`）。
 *
 * 为什么自己画：
 *   · 原生 checkbox 的勾选框由系统绘制，`accent-color` 只能改一个色，圆角/轨道/
 *     滑块都改不了，与自绘的下拉（`.dropdown-trigger`）、按键、搜索框不是一套观感。
 *   · 项目其余控件（下拉、查找栏开关）都已经是自绘按钮，开关跟着自绘才能「一致」。
 *
 * 设计要点：
 *   · 语义用 `role="switch"` + `aria-checked`（不是 checkbox），读屏与测试都靠它读状态；
 *     外壳仍是 `<button>`，于是键盘（Tab 聚焦 / Space / Enter）与焦点环
 *     （全局 `button:focus-visible`）全部白拿，不必另写一套。
 *   · 轨道 + 滑块两件套；开启态直接由 `[aria-checked="true"]` 选中，**状态只有一处真相**，
 *     不会出现「DOM 状态与样式类不同步」的漂移。
 *   · 滑块位移用 `transform: translateX()`（合成层，不触发重排），不动画 `left`。
 */

export interface SwitchOptions {
  checked: boolean;
  onToggle: (on: boolean) => void;
  /** 读屏标签（开关本身没有可见文字）。 */
  ariaLabel?: string;
}

export interface SwitchHandle {
  root: HTMLButtonElement;
  /** 外部状态变化时同步显示（不回调 onToggle）。 */
  setChecked(on: boolean): void;
}

export function createSwitch(opts: SwitchOptions): SwitchHandle {
  const root = document.createElement("button");
  root.type = "button";
  root.className = "switch";
  root.setAttribute("role", "switch");
  if (opts.ariaLabel) root.setAttribute("aria-label", opts.ariaLabel);

  const knob = document.createElement("span");
  knob.className = "switch-knob";
  knob.setAttribute("aria-hidden", "true");
  root.appendChild(knob);

  let checked = opts.checked;

  function paint(): void {
    root.setAttribute("aria-checked", checked ? "true" : "false");
  }

  root.addEventListener("click", () => {
    checked = !checked;
    paint();
    opts.onToggle(checked);
  });

  paint();

  return {
    root,
    setChecked: (on) => {
      checked = on;
      paint();
    },
  };
}
