# 0078 — 查找栏「两框同宽」量早了：setCount 之后查找框又变窄

- **日期**：2026-09-19（B78）
- **症状**：替换行展开后替换输入框比查找框宽 42px，右边缘错开。
- **根因**（两段叠加，第一段修完仍会复发）：
  1. `open()` 里 `syncWidths()` 在 `setCount` **之前**跑 —— 此时主行计数是空的，
     `.find-count:empty { min-width: 0 }` 让查找框比有计数时**宽 42px**，
     把这个值写死到替换框上，主程序随后 `setCount("3 / 12")` 把查找框挤窄，两框又错开。
  2. 更普遍地说：凡是「量一次写死」的布局，量完之后**任何**让源元素变宽窄的事
     （计数位数变化、占位符换文案、字体加载）都会让写死的值过期。
- **修法**：`ResizeObserver` 盯住查找框，宽窄一变就对齐替换框；`setCount` 里再显式补一次
  （jsdom 没有 ResizeObserver，测试环境靠显式调用兜住）。
- **判据（写进 B78 守卫的行为测试）**：jsdom 里给查找框打桩 `rect(260)` → 点开替换行 →
  断言 `replField.style.width === "260px"`；真实布局由 Chromium 量（#2 展开态两框都 252px）。
- **顺带的事实**：VS Code 的 codicon **只以字体发布**，`docs/vscode-reference` 里
  `codiconsLibrary.ts` 只有码位（`replace: 0xeb3d`、`replaceAll: 0xeb3c`），**拿不到轮廓**；
  沙箱也拉不了 raw.githubusercontent.com（curl exit 35 / WebFetch 失败）。
  要抄图标字形时别再去找源码 —— 要么自绘（本项目选这条），要么引字体文件。
- **教训**：凡「JS 量 A 写死给 B」的同步，先问一句「A 之后还会不会变」；会变就上
  `ResizeObserver`，别指望在正确的时机量一次。
