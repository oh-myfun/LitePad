/**
 * 极简 DOM 访问器 —— 纯函数，无依赖。
 *
 * 从 `ui.ts` 抽出：`el(id)` 按 id 取 DOM 节点，是窗口框架里所有句柄的共祖。
 * 让它有独立归属后，非 ui 模块（如 findbar）也能直接 import，不必绕道 ui 的服务桶。
 */

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点：#${id}`);
  return node as T;
}
