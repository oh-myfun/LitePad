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
//
// B406 · 真机量出来的三条路径病根（都在这里收口）：
//   1. **`..` 段会被 asset 协议整条拒掉**（`E:\docs\..\pics\a.png` 解码后一路 404）——
//      文档按下 `../images/a.png` 引图时全线不显示。拼完必须折叠 `.` / `..`。
//   2. `file:///C:/…` 是「本地路径」的另一种常见写法（从浏览器 / 其它工具复制来的），
//      以前会被当成相对路径拼在文档目录后面。先还原成本地路径再走同一条。
//   3. UNC（`\\server\share\…`、`\\?\C:\…`）是绝对路径，不许拿文档目录去拼。

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

function decodePath(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    // 坏掉的百分号编码就按原样用
  }
  return src;
}

/** `file:///C:/x` → `C:\x`；`file:///C:/x` 的 localhost 写法同理；`file://server/share/x` → `\\server\share\x`。 */
function fileUrlToPath(src: string): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(src);
  if (!match) return null;
  const host = match[1] ?? "";
  let path = match[2] ?? "";
  if (host && host.toLowerCase() !== "localhost") path = `//${host}${path}`;
  path = decodePath(path);
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path.replace(/\//g, "\\");
}

/** Windows 的扩展长度前缀（`\\?\C:\…` / `\\.\…`）：asset 协议认不得，还原成普通路径。 */
function stripDevicePrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\/.test(path) || /^\\\\.\\/.test(path)) return path.slice(4);
  return path;
}

/**
 * 折叠 `.` / `..` 段（B406 病根 1）。
 *
 * 分隔符跟随原路径：`C:/docs` 走 `/`，`C:\docs` 与 UNC 走 `\`。驱动器的 `..` 到底后
 * 直接丢掉（Windows 不会越过盘根）；无基准的相对路径保留前导 `..`。
 */
function normalizeSegments(path: string): string {
  const drive = /^[A-Za-z]:/.test(path) ? path.slice(0, 2) : "";
  const unc = !drive && /^[\\/]{2}/.test(path);
  const sep = unc || path.includes("\\") ? "\\" : "/";
  const rooted = !drive && !unc && path.startsWith(sep);
  const rest = drive ? path.slice(2) : unc ? path.replace(/^[\\/]{2}/, "") : path;
  const out: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      else if (!drive && !unc && !rooted) out.push("..");
    } else {
      out.push(part);
    }
  }
  const prefix = drive ? drive + sep : unc ? sep + sep : rooted ? sep : "";
  return prefix + out.join(sep);
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || /^[\\/]/.test(path);
}

/** Markdown 里的图片地址 → 绝对路径（相对路径按文档目录拼）。 */
export function resolveAssetPath(mdPath: string | null, src: string): string {
  if (!src) return src;
  if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return src;

  const fromFileUrl = fileUrlToPath(src);
  const raw = fromFileUrl ?? src;
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;

  const decoded = normalizeSegments(stripDevicePrefix(decodePath(raw)));
  if (isAbsolutePath(decoded)) return decoded;
  const docPath = mdPath ? stripDevicePrefix(mdPath) : null;
  if (!docPath) return decoded;

  const sep = docPath.includes("\\") ? "\\" : "/";
  const joined = `${normalizeSegments(dirOf(docPath))}${sep}${decoded.replace(/[\\/]/g, sep)}`;
  // ⚠️ 拼完再折一次：`dirOf` 自己可能带 `..`，图片段也可能再往上走。
  return normalizeSegments(joined);
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
