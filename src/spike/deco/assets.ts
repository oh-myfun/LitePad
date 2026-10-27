// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/lib/paths.ts:68-83（`resolveAssetPath`）
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-4c · 图片组件的「基准目录」。
//
// 装饰面里一张相对路径的图要变成能加载的地址，得知道**这份文档在哪**。文档路径不是
// 装饰集的一部分（装饰只认 state），所以按 InkNote 的老办法把它放进 state 的一个
// StateField：宿主（markdown.ts 的 applyDecoFace）在换标签/换档时发一发
// `setAssetBase`，装饰集跟着重建一次。
//
// ⚠️ 不能用模块级可变变量（宿主 set 一下就完事）：widget 的 `eq()` 会复用 DOM，
// 换文档时同一段 Markdown 被复用 ⇒ 图还停在上一份文档的目录（enhance.ts 那棵树
// 也踩过同一个坑，见 B394-4 的评审 I5）。

import { StateEffect, StateField } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";

/** 当前文档的路径（null = 还没保存过 / 不是本地文件）。 */
export const setAssetBase = StateEffect.define<string | null>();

export const assetBase = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAssetBase)) return effect.value;
    }
    return value;
  },
});

function dirOf(filePath: string): string {
  const norm = filePath.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return cut >= 0 ? norm.slice(0, cut) : norm;
}

/** Markdown 里的图片地址 → 绝对路径（相对路径按文档目录拼）。 */
export function resolveAssetPath(mdPath: string | null, src: string): string {
  if (!src || /^https?:\/\//i.test(src) || /^data:/i.test(src)) return src;
  if (!mdPath) return src;
  const sep = mdPath.includes("\\") ? "\\" : "/";
  if (src.startsWith("/") || /^[A-Za-z]:/.test(src)) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 坏掉的百分号编码就按原样用
  }
  // ⚠️ 与 InkNote 有一处有意的差异：它的 `dirOf` 拿 `/` 拼回目录，Windows 上会拼出
  // `C:/docs\pic.png` 这种混合分隔符；进 asset 协议之前统一成文档那一侧的分隔符。
  return `${dirOf(mdPath)}${sep}${decoded.replace(/[\\/]/g, sep)}`;
}

/**
 * 绝对路径 → 可加载地址。
 *
 * ⚠️ `convertFileSrc` 只在 Tauri 运行时里存在；jsdom / 单测里调用会抛，
 * 这层 try/catch 是照 InkNote `buildImage()` 抄的，不是兜底洁癖。
 */
export function assetUrl(path: string): string {
  if (!path || /^https?:\/\//i.test(path) || /^data:/i.test(path)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}
