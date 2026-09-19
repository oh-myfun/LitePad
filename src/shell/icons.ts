/**
 * **仅剩的两颗手绘图标**：主题按钮的浅色 / 深色。
 *
 * 🚩 红线（docs/conventions.md「图标」节）：应用内所有按钮图标一律取 VS Code codicon
 * （`./codicons`，生成物），**不得手绘 SVG**；codicon 里确无合适字形时先与用户商量
 * 是否引入别的图标集。
 *
 * 这里之所以破例：官方 codicon 的 639 颗清单里**没有** sun / moon 字形（最接近的
 * `color-mode` 是半明半暗的圆，已用作「跟随系统」那一档）。经用户确认，这两颗豁免。
 * 于是主题三态 = sun（本文件）/ moon（本文件）/ color-mode（codicons，main.ts 里直接取）。
 *
 * ⚠️ 风格差异：codicon 是 fill 风格（16 网格），这两颗是 stroke 风格（24 视图框）。
 *    都是单色线条，18px 下并排看不出拼接感；真要统一得先有官方日/月字形。
 */

/** 描边图标构造器（24 视图框 + currentColor），只为上面那两颗服务，故不再导出。 */
function strokeIcon(paths: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const ICONS = {
  /** 浅色档：太阳。 */
  sun: strokeIcon(
    '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.2M12 20.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M1.5 12h2.2M20.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  ),
  /** 深色档：月亮。 */
  moon: strokeIcon('<path d="M20 13.5A8.5 8.5 0 0 1 10.5 4a8.5 8.5 0 1 0 9.5 9.5z"/>'),
} as const;

export type IconName = keyof typeof ICONS;
