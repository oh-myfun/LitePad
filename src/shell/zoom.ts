/**
 * Ctrl + 滚轮缩放（字号）。
 *
 * 必须 `passive: false` 才能 preventDefault——否则 WebView2 会把它当成整页缩放。
 * 触控板双指捏合在 Windows 上也是 ctrlKey + wheel，deltaY 很小且事件密集，
 * 因此这里做累加阈值，避免一次捏合跳好几档。
 */

/** 累加到这个量才走一档（鼠标滚轮一格约 100，触控板单帧通常 < 20）。 */
const STEP_THRESHOLD = 30;

export function attachWheelZoom(onZoom: (dir: 1 | -1) => void): () => void {
  let acc = 0;
  const handler = (e: WheelEvent): void => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    acc += e.deltaY;
    if (Math.abs(acc) < STEP_THRESHOLD) return;
    const dir: 1 | -1 = acc < 0 ? 1 : -1;
    acc = 0;
    onZoom(dir);
  };
  window.addEventListener("wheel", handler, { passive: false });
  return () => window.removeEventListener("wheel", handler);
}
