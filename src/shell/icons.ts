/**
 * 工具栏内联 SVG 图标（24×24 stroke 风格，currentColor 继承文字色）。
 * 不引入图标库，保持零依赖。
 */

function svg(paths: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const ICONS = {
  new: svg(
    '<path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z"/><path d="M13 3v6h6"/><path d="M12 12v6M9 15h6"/>',
  ),
  open: svg(
    '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 10h18"/>',
  ),
  save: svg(
    '<path d="M5 3h11l5 5v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3"/><path d="M7 21v-7h10v7"/>',
  ),
  saveAs: svg(
    '<path d="M5 3h11l5 5v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M7 21v-7h10v7"/><path d="M14 3l4 4"/>',
  ),
  find: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
  findInFiles: svg(
    '<circle cx="10" cy="10" r="5.5"/><path d="M14 14l6 6"/><path d="M8 10h4M10 8v4"/>',
  ),
  preview: svg(
    '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ),
  code: svg('<path d="M8 6l-6 6 6 6"/><path d="M16 6l6 6-6 6"/>'),
  outline: svg(
    '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  ),
  /**
   * 导出：文档 + 指向右侧的出向箭头（「把这份文档输出成别的格式」）。
   * 原先用的是「箭头落入托盘」（下载语义），与菜单里的导出 HTML/PDF 不符。
   */
  export: svg(
    '<path d="M6 3h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13 3v5h5"/><path d="M9 14.5h5.6"/><path d="M12.6 12l2.5 2.5-2.5 2.5"/>',
  ),
  moon: svg('<path d="M20 13.5A8.5 8.5 0 0 1 10.5 4a8.5 8.5 0 1 0 9.5 9.5z"/>'),
  sun: svg(
    '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.2M12 20.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M1.5 12h2.2M20.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  ),
  /**
   * 跟随系统：半明半暗的圆（左半实心）——明暗交给系统决定。
   * 与 sun / moon 组成主题按钮的三态图标，18px 下仍可一眼区分。
   */
  followSystem: svg(
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>',
  ),
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.83l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.83-.34 1.7 1.7 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.83.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.83l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.83-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  ),
  splitH: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16"/>'),
  splitV: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 12h18"/>'),
  /** 折叠标签列表入口（标签栏右侧，14px 小尺寸） */
  more: svg('<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="2.6"/>', 14),
  closePanel: svg(
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/>',
  ),
} as const;

export type IconName = keyof typeof ICONS;
