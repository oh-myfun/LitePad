/**
 * 媒体文件判定 —— 纯数据，无依赖。
 *
 * 「哪些文件该交给原生 `<img>` / `<video>` / `<audio>` 面」只有这一份口径：
 * 打开对话框的过滤器、`doOpen` 的分叉、标签图标档位都问它。
 *
 * 只按扩展名判：内容识别（魔数）留给要读字节的那条链，而这里恰恰是**不读字节**的
 * 那一档 —— 媒体面由 WebView 自己按 URL 取流解码。
 *
 * 边界（都是有意为之）：
 *  · `svg` 不进：它是文本，LitePad 里仍按文本编辑（预览另有装饰面）。
 *  · `tiff` 不进：WebView2（Chromium）不解这个容器，进媒体面只会得到一张裂图。
 *  · `mkv` / `avi` / `wma` 等容器不进：能否解码取决于里面的编码，放进媒体面大概率
 *    报错，留在「所有文件」里由用户自行决定是否打开更诚实。
 */

import type { FsEntry } from "../ipc/api";

export type MediaKind = "image" | "video" | "audio";

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "apng",
];

const VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "ogv", "mov"];

/** Chromium 能直接解码的音频容器（wma 等不列，理由同文件头的 mkv / avi）。 */
const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "weba"];

/** 打开对话框「图片、视频与音频」那一档的扩展名清单（不含点）。 */
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

/** 路径的扩展名（含点两侧都不带）→ 媒体种类；不是媒体返回 `null`。 */
export function mediaKindOf(path: string | null | undefined): MediaKind | null {
  if (!path) return null;
  // 只取最后一段的最后一个点之后：目录名里的点不参与判定
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  return null;
}

/**
 * 路径所在的那一层目录（**保留末尾分隔符**），给 `list_dir` 用。
 *
 * 不能用 `markdown/links` 的 `dirOf`：它会去掉末尾的 `\`，而盘符根 `C:\` 去掉后成了
 * `C:` —— Windows 会把它当「C 盘的当前目录」，列的就不是根了。
 * 例：`C:\pics\a.png` → `C:\pics\`，`C:\a.png` → `C:\`。
 */
export function parentDirOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut + 1) : null;
}

/**
 * 同目录里的相邻图片（图片预览的「上一张 / 下一张」）。
 *
 * `entries` 直接用资源管理器那一份排序（Rust `list_dir` 已排好），这里不再重排；
 * 只在**图片**之间移动（视频 / 音频 / 目录跳过），到边返回 `null` —— 不绕回第一张。
 * 路径按 Windows 口径小写比对：打开时传进来的大小写未必与读目录给的一致。
 */
export function siblingImagePath(
  entries: readonly FsEntry[],
  currentPath: string,
  dir: 1 | -1,
): string | null {
  const images = entries.filter((e) => !e.isDir && mediaKindOf(e.path) === "image");
  const key = currentPath.toLowerCase();
  const at = images.findIndex((e) => e.path.toLowerCase() === key);
  return at < 0 ? null : (images[at + dir]?.path ?? null);
}
