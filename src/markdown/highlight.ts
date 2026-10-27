import { normalizeFamily } from "../theme/theme";
import { shikiThemeFor } from "./shiki-themes";

/**
 * 一段代码 + 语言 id ⇒ Shiki 产出的完整 `<pre class="shiki">` 标记；失败给 null。
 *
 * 从 `enhanceMarkdown` 里抽出来只有一个理由：**装饰面（CM6 块级 widget）要在不换掉
 * `<pre>` 节点的前提下上色**。enhance 那条路是 `el.replaceWith(新节点)`，对派生 DOM 无所谓，
 * 对一颗正在被打字的可编辑区等于把光标和事件一起拆了。两处共用这一颗取值函数，
 * 主题族口径（B377）与 `defaultColor:false`（B321 那条「内联浅色值盖掉深色主题」）
 * 就只有一份实现。
 *
 * ⚠️ Shiki 是**动态 import** 的（与 `enhanceMarkdown` 同口径）：首屏不为它付体积，
 * 改成静态 import 会把它拖进主 chunk。
 */
export async function highlightCodeHtml(code: string, lang: string): Promise<string | null> {
  try {
    const { codeToHtml } = await import("shiki");
    return await codeToHtml(code, {
      lang,
      themes: {
        light: shikiThemeFor(normalizeFamily(document.documentElement.dataset.themeFamily), false),
        dark: shikiThemeFor(normalizeFamily(document.documentElement.dataset.themeFamily), true),
      },
      // 默认的 `defaultColor: "light"` 会把浅色值写成**内联** `color` /
      // `background-color:#fff`，内联压过类规则 ⇒ 深色主题下代码块仍是白底浅字（B321）。
      // 关掉它，shiki 只留 `--shiki-light/--shiki-dark` 变量，切换交回 CSS。
      defaultColor: false,
    });
  } catch {
    return null; // 不支持的语言 / 加载失败 ⇒ 调用方停在纯文本
  }
}
