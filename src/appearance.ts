// 外观 / 主题 / 字号 / 字体 / 预览宽度的 setter 集合。
//
// 这些函数**只**消费 core/app-state 的状态、以及 DOM / CSS 变量，
// 不调用 main.ts 里任何编排逻辑 —— 因此被抽成独立模块，main.ts 只负责在启动时调用它们。
// 抽离后 main.ts 的「外观」职责归零，便于独立单测（见 tests/appearance.test.ts 规划）。

import { EditorView } from "@codemirror/view";
import { vscodeEditorTheme } from "./editor/theme";
import type { PreviewWidth } from "./ipc/api";
import type { ThemeFamily } from "./theme/theme";
import { tabs, panels, setIsWrap } from "./core/app-state";

/**
 * 主题翻了 ⇒ 让每一格的预览把「只在渲染那一刻取色」的东西重画一次（mermaid）。
 *
 * 正文 / 公式 / 代码配色都跟着 CSS 变量走，样式自己换就够了，不必惊动 DOM；
 * mermaid 的 `theme:` 是渲染时读 `dataset.theme` 定死的，而岛级增量会复用那块
 * （它的 html 没变）⇒ 不显式重画，切主题后图永远停在旧配色（B321 用户报的那条）。
 */
export function rethemePreviews(): void {
  for (const panel of panels.values()) panel.preview?.retheme();
}

export function applyDarkToTabs(dark: boolean, family: ThemeFamily): void {
  for (const tab of tabs.values()) {
    const effect = tab.comps.theme.reconfigure(vscodeEditorTheme(dark, family));
    const panel = panels.get(tab.panelId);
    if (panel?.view && panel.viewTabId === tab.tabId) {
      panel.view.view.dispatch({ effects: effect });
      tab.state = panel.view.view.state;
    } else {
      tab.state = tab.state.update({ effects: effect }).state;
    }
  }
}

export function applyWrapToTabs(wrap: boolean): void {
  setIsWrap(wrap);
  for (const tab of tabs.values()) {
    const effect = tab.comps.wrap.reconfigure(wrap ? EditorView.lineWrapping : []);
    const panel = panels.get(tab.panelId);
    if (panel?.view && panel.viewTabId === tab.tabId) {
      panel.view.view.dispatch({ effects: effect });
      tab.state = panel.view.view.state;
    } else {
      tab.state = tab.state.update({ effects: effect }).state;
    }
  }
}

export function applyFontSize(px: number): void {
  document.documentElement.style.setProperty("--font-size", `${px}px`);
}

export function applyPreviewLineHeight(value: number): void {
  const v = Math.min(2.5, Math.max(1, Number(value) || 1.7));
  document.documentElement.style.setProperty("--md-line-height", String(v));
}

/** B235：预览**正文内容区**的宽度档 → 具体 px 值。
 *
 * ⚠️ 这一档管的是「正文居中宽度」（原先硬编码在 `preview.css` 的 860px），
 *    **不是**源码与预览两栏的分屏比例 —— 那个由拖拽分隔条管，是另一件事。
 * ⚠️ 存**档位名**而不是 px：同一档在不同分辨率/缩放下观感才稳定，以后调值
 *    也只改这张表，不动用户的设置文件。
 * ⚠️ 全宽档给 `none`（不限宽）而不是一个很大的数字 —— 写上限的话超过就还是被截住。
 */
export const PREVIEW_WIDTH_PX: Record<PreviewWidth, string> = {
  standard: "860px",
  wide: "1100px",
  full: "none",
};

export function normalizePreviewWidth(v: unknown): PreviewWidth {
  return v === "standard" || v === "wide" ? v : "full";
}

export function applyPreviewWidth(value: unknown): void {
  const kind = normalizePreviewWidth(value);
  document.documentElement.style.setProperty("--md-content-max", PREVIEW_WIDTH_PX[kind]);
}

/**
 * 正文字体：写 :root 上的 --font-body，**只**消费在预览正文（`.md-preview`）。
 * 空串（默认）则移除内联变量，回落到 :root 里那份内嵌思源黑体。
 *
 * ⚠️ B231 口径：源码区已划归**代码字体**（见下面的代码字体 setter），所以这一项
 *    **不再影响编辑器**。改名「正文字体」；B227 时的临时中转变量已删除。
 *
 *    这里**不重测编辑器**是刻意的：--font-body 没有任何 CM6 消费方，重测纯属空转。
 *    真正要重测的是下面那个代码字体 setter。
 *
 *    ⚠️ 注释里**别写别的 setter 名**：`tests/static.ts` 的 `topLevelFnBody` 按
 *    `indexOf(name)` 取首次出现定位函数体，注释里提一句别人的名字就会让那条
 *    契约截到本函数的注释里、断言凭空失败。
 */
export function applyFontFamily(family: string): void {
  const root = document.documentElement.style;
  const f = family.trim();
  if (!f) {
    root.removeProperty("--font-body");
  } else {
    // 族名带空格时必须加引号，否则 CSS 解析会当成多个族名
    root.setProperty("--font-body", f.includes(" ") ? `"${f}"` : f);
  }
}

export function applyEditorLineHeight(value: number): void {
  const v = Math.min(2.5, Math.max(1, Number(value) || 1.5));
  document.documentElement.style.setProperty("--editor-line-height", String(v));
}

/**
 * B231：代码字体 —— 写 :root 上的 --font-code。消费方两处：
 * ①编辑器源码区（CM6 那条 `.cm-editor, .cm-scroller` 规则）；
 * ②预览里的 `code` / `pre` / 数学占位。**凡是代码一律等宽**。
 *
 * 与上面那个正文字体 setter 不同的是这一项会影响源码区：源码区吃这个值，
 * 换字体会改行宽，进而影响折行。（B227 时它只落在预览、不碰 CM6。）
 */
export function applyCodeFontFamily(family: string): void {
  const root = document.documentElement.style;
  const f = family.trim();
  if (!f) {
    root.removeProperty("--font-code");
  } else {
    root.setProperty("--font-code", f.includes(" ") ? `"${f}"` : f);
  }
}

/**
 * B347：界面字体 —— 写 :root 上的 --font-ui，消费方**只有窗口外壳**（标题栏 / 菜单 /
 * 标签条 / 左栏三块 / 设置页）。空串 = 移除内联变量，回落到 :root 里那份默认栈，
 * 其首选是内嵌思源的**度量别名**那颗 face（见 fonts.css 的推导）。
 *
 * ⚠️ 预览正文与代码**不吃这一项**（用户裁决：这一栏只管外壳）：那两处各有自己的
 *    设置项，这里多写一颗就是在别处埋一条「改了没反应」。
 * ⚠️ 与另两条一样**不重测编辑器**：--font-ui 没有任何 CM6 消费方。
 */
export function applyUiFontFamily(family: string): void {
  const root = document.documentElement.style;
  const f = family.trim();
  if (!f) {
    root.removeProperty("--font-ui");
  } else {
    root.setProperty("--font-ui", f.includes(" ") ? `"${f}"` : f);
  }
}

export function applyTabStyle(style: string): void {
  // 写进 <html data-tab-style>；未知值一律按 "connected" 处理（与 Rust 回落一致）。
  document.documentElement.dataset.tabStyle = style === "pill" ? "pill" : "connected";
}

export function applyTabActionReserve(on: boolean): void {
  document.documentElement.dataset.tabReserve = on ? "on" : "off";
}
