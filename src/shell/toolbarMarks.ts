/**
 * 工具条上「codicon 真没有」的那几枚标记（B446 起，B448 定笔形）。
 *
 * 这里是 `src/shell/codicons.ts` 那条红线（「不得手绘 SVG」）的**唯一例外出口**，
 * 例外范围由用户逐轮拍板：公式 Σ、下划线 U、上标 x²、下标 x₂（B446「按同笔补画」）
 * 与 Mermaid 流程图（B448「调整 Mermaid 图表按钮图标」—— `type-hierarchy` 画的是圆节点
 * 的组织图，不是 mermaid 那种方框 + 折线箭头）。B450 再加三颗：增加 / 减少缩进
 * （用户点名「用文本编辑器中常用的那种图标」—— codicon 那颗 `indent` 不是那形状，
 * 而减少缩进此前是拿它水平镜像凑的）与脚注（册里连就近替身都没有）。
 * 其余一律走 `CODICONS.<name>`。
 *
 * 画法与口径（B448，用户报了「线过粗 / 内容粘连 / 小数字畸形被裁」三件之后定下）：
 *   · 16 网格（与 codicon 同格），`fill="none"` + `stroke="currentColor"` ⇒ 颜色跟着按钮字色走；
 *   · **一支笔**：根元素 `stroke-width="1.4"`。第一版 Σ 用实心填充（横条等效 2.2 厚），
 *     在同排 codicon 旁边明显粗一档 —— 描边才有办法与字体字形的笔画对上；
 *   · 小笔画（下划线底下那道、上标的小「2」）允许在**元素上**再给一档（1.3 / 1.5），
 *     但整枚标记的视觉重量要与同排齐平；
 *   · 留白：墨迹不许贴 16 边框（会被切），相邻两笔之间要留出可辨识的缝 ——
 *     第一版 U 的弧底与底线只剩 0.8 单位，16px 下直接糊成一坨；
 *   · 只画形状，不带尺寸/边距 —— 尺寸由消费方 CSS 给（见 `preview.css` 的
 *     `.md-preview-tool svg`）；
 *   · ⚠️ 与 codicons.ts 同一条纪律：**只收有调用点的标记**，删掉动作就一起删掉。
 *   · 改完要目视结案：`.tmp/b448-ink.py`（把任意一组 SVG 在真机里按 16px 与 96px 画出来）。
 */

/** 标记短名 → inline SVG。 */
export const TOOLBAR_MARKS = {
  // Σ：上横、两道斜、下横（数学公式的通用记号）
  math:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M12.4 3.6H3.8l3.6 4.4-3.6 4.4h8.6" /></svg>',
  // U + 底下一道：下划线（codicon 只有 `whole-word`，那颗在查找栏当「全词」用）
  //   弧底 10.8 与底线 13.6 之间留 2.8 单位（笔宽各占一半后仍剩 1.4 的空隙）。
  underline:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M4.0 2.4v4.4a4.0 4.0 0 0 0 8.0 0V2.4" />' +
    '<path d="M3.0 13.6h10.0" stroke-width="1.5" /></svg>',
  // x + 右上角的 2：上标。
  // B460（用户：「小数字太大且不够标准」）：第一版那颗「2」的墨迹高 5.3、而 x 只有 4.6 ⇒ 数字
  // 比正文还大，读起来是「x 2」并排、不是上标。这一版收到 x 高的 65%（3.0 / 4.6，标准排版里
  // 上标 ≈ 正文的 58–65%），整颗抬到 x 的顶边之上（下标那颗同形、落到基线之下）。
  // ⚠️ 两支 path 只用绝对坐标 M/L/Q：判据（tests/preview-format-toolbar.test.ts 的 inkBoxes）
  //    直接对坐标取包络，`A` 的凸出量与 `h`/`v` 的相对位移都得再算一遍 —— 那判据就成重抄画法了。
  superscript:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.4 7.9L7.0 12.5M7.0 7.9L2.4 12.5" />' +
    '<path d="M9.9 4.4Q9.9 3.5 11.1 3.5Q12.3 3.5 12.3 4.4Q12.3 5.1 10.8 5.7L9.9 6.5L12.3 6.5" ' +
    'stroke-width="1.2" /></svg>',
  // x + 右下角的 2：下标（同一支笔、同一个「2」，只是挪到基线下面 —— 两颗天然成对）
  subscript:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.4 3.5L7.0 8.1M7.0 3.5L2.4 8.1" />' +
    '<path d="M9.9 10.4Q9.9 9.5 11.1 9.5Q12.3 9.5 12.3 10.4Q12.3 11.1 10.8 11.7L9.9 12.5L12.3 12.5" ' +
    'stroke-width="1.2" /></svg>',
  // 两个方框 + 向下的箭头：Mermaid 的 `graph TD`（按钮插的就是这一段）
  flowchart:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="3.4" y="1.6" width="9.2" height="3.4" rx="0.7" />' +
    '<rect x="3.4" y="11.0" width="9.2" height="3.4" rx="0.7" />' +
    '<path d="M8.0 5.0v4.4" /><path d="M6.3 7.9l1.7 1.7 1.7-1.7" stroke-width="1.3" /></svg>',
  // B450 · 文本编辑器里那对缩进键的通用形状：四行字 + 一支箭头。上下两行通栏、
  // 中间两行缩进（缩进去的那一截正是「这一层」），箭头指的方向就是移动方向。
  //   箭头用**绝对坐标**画（M/L/L/Z 三点对）⇒ 判据能直接量出尖在左还是在右。
  //   尖 5.8 与中间那两行的起点 8.6 之间留 2.8（与下划线那道同一条口径）。
  indent:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M2.2 2.6H13.8M8.6 6.2H13.8M8.6 9.8H13.8M2.2 13.4H13.8" />' +
    '<path d="M2.6 5.4L2.6 10.6L5.8 8.0Z" stroke-width="1.3" /></svg>',
  // 减少缩进：同一套四行字，箭头翻向左（底边 5.8、尖 2.6）—— 两颗成对，只差方向
  outdent:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M2.2 2.6H13.8M8.6 6.2H13.8M8.6 9.8H13.8M2.2 13.4H13.8" />' +
    '<path d="M5.8 5.4L5.8 10.6L2.6 8.0Z" stroke-width="1.3" /></svg>',
  // B450 · 脚注：正文两行 + 行末抬高的那个小「1」，下面一根分隔线，线下一条定义行。
  //   就是 Word「插入脚注」那颗的骨架（AB¹ / ─── / ¹…）—— 小「1」与上标那颗的「2」
  //   同一档尺寸（1.3 的笔），别拿它当正文笔画。
  footnote:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M2.2 3.4H7.8M2.2 6.4H13.8" />' +
    '<path d="M11.0 1.8v3.0M10.3 2.6l0.7-0.8" stroke-width="1.3" />' +
    '<path d="M2.2 10.2H13.8" /><path d="M2.2 13.2H11.6" /></svg>',
} as const;

export type ToolbarMarkName = keyof typeof TOOLBAR_MARKS;
