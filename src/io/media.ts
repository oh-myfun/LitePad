/**
 * 媒体文件判定 —— 纯数据，无依赖。
 *
 * 「哪些文件该交给原生 `<img>` / `<video>` 面」只有这一份口径：
 * 打开对话框的过滤器、`doOpen` 的分叉、标签图标档位都问它。
 *
 * 只按扩展名判：内容识别（魔数）留给要读字节的那条链，而这里恰恰是**不读字节**的
 * 那一档 —— 媒体面由 WebView 自己按 URL 取流解码。
 *
 * 边界（都是有意为之）：
 *  · `svg` 不进：它是文本，LitePad 里仍按文本编辑（预览另有装饰面）。
 *  · `tiff` 不进：WebView2（Chromium）不解这个容器，进媒体面只会得到一张裂图。
 *  · `mkv` / `avi` 等容器不进：能否解码取决于里面的编码，放进媒体面大概率报错，
 *    留在「所有文件」里由用户自行决定是否打开更诚实。
 */

export type MediaKind = "image" | "video";

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

/** 打开对话框「图片与视频」那一档的扩展名清单（不含点）。 */
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

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
  return null;
}
