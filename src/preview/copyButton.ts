// B462 · 代码 / 公式 / 图块右上角共用的复制键。
//
// 三块的右上角此前各走各的：代码块是一颗写着「复制」的文字键，公式与图块干脆没有。
// 收成同一颗图标键（`CODICONS.copy`）后，位置、尺寸与悬停时机只有一处口径。
//
// 复制的是**块内源码**（代码正文 / LaTeX / 图源码），不是渲染后的文本 —— 用户复制出去
// 要能再贴回 Markdown。反馈只换字形（copy → check），不弹提示条：块本身已经够窄，
// 再压一层浮层会把内容盖住。

import { CODICONS } from "../shell/codicons";
import { setTip } from "../shell/tooltip";

/** 反馈停留时长：够看清换了字形，又不至于下一次点击时还停在「已复制」。 */
const FEEDBACK_MS = 1200;

/**
 * 建一颗复制键。`getText` 每次点击现取 —— 块内源码可能在编辑中被改过，
 * 闭包建键那一刻的文本会复制到旧内容。
 */
export function createCopyButton(getText: () => string, extraClass = ""): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = extraClass ? `md-block-copy ${extraClass}` : "md-block-copy";
  btn.innerHTML = CODICONS.copy;
  setTip(btn, "复制");
  btn.setAttribute("aria-label", "复制");

  // 与块内其他交互键同一条：按下不许把焦点/光标从正在编辑的源码区带走。
  btn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  let timer = 0;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    void navigator.clipboard.writeText(getText());
    btn.innerHTML = CODICONS.check;
    setTip(btn, "已复制");
    btn.setAttribute("aria-label", "已复制");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      btn.innerHTML = CODICONS.copy;
      setTip(btn, "复制");
      btn.setAttribute("aria-label", "复制");
    }, FEEDBACK_MS);
  });

  return btn;
}
