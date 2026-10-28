// 链接的落地口径（B401）：预览/编辑两条臂共用。
//
// 用户在派生预览里点 http(s) 链接时，WebView 默认会**就地导航** —— 整个应用被那个网页
// 顶掉，且没有后退入口（B394-1 记过，B401 用户再次点名）。所以链接一律先在这里分类：
//   · http(s) / mailto → 系统默认浏览器（Rust `open_external`：ShellExecuteW，只放这三种协议）
//   · 本地文件（相对路径 / 绝对路径 / file://） → LitePad 里开一个标签（走宿主的 doOpen）
//   · 纯锚点 → 调用方就地处理（派生预览滚动到标题，装饰面不动）
// 任何情况下都不许把 WebView 导航走。

import { invoke } from "@tauri-apps/api/core";
import { logger } from "../core/logger";

export type LinkTarget =
  | { kind: "none" }
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "local"; path: string };

export interface FollowOptions {
  /** 当前文档所在目录（未保存的文档为 null） */
  baseDir: string | null;
  /** 本地链接的落点：宿主把它开进一个标签 */
  openLocal?: (path: string) => void;
}

const EXTERNAL_RE = /^(?:https?|mailto):/i;
const BLOCKED_RE = /^(?:javascript|vbscript|data):/i;
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const UNC_RE = /^\\\\/;

function splitHash(href: string): { path: string; hash: string } {
  const cut = href.indexOf("#");
  if (cut < 0) return { path: href, hash: "" };
  return { path: href.slice(0, cut), hash: href.slice(cut + 1) };
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 以 `..` / `.` 段归一（保留盘符与 UNC 前缀；分隔符跟输入那一侧走）。 */
export function normalizePath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const unified = path.replace(/[\\/]/g, sep);
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? "";
  const root = drive
    ? drive + (/^[\\/]/.test(unified.slice(2)) ? sep : "")
    : unified.startsWith("\\\\")
      ? "\\\\"
      : unified.startsWith(sep)
        ? sep
        : "";
  const rest = unified.slice(root.length).split(sep);
  const stack: string[] = [];
  for (const segment of rest) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return root + stack.join(sep);
}

export function dirOf(filePath: string): string {
  const norm = filePath.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return cut >= 0 ? norm.slice(0, cut) : norm;
}

function fileUrlToPath(href: string): string {
  const local = /^file:\/\/\//i.test(href);
  let rest = href.replace(/^file:\/\//i, "");
  if (local) {
    if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
  } else {
    // file://server/share 是 authority 形式 ⇒ UNC
    rest = "\\\\" + rest;
  }
  return decodePath(rest).replace(/\//g, "\\");
}

export function classifyHref(href: string, baseDir: string | null): LinkTarget {
  const raw = href.trim();
  if (!raw) return { kind: "none" };
  // 协议判定先剥掉 ≤ U+0020 的字符：`java\nscript:` 这种混淆不能因为换行就漏过去
  const compact = Array.from(raw)
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join("");
  if (EXTERNAL_RE.test(compact)) return { kind: "external", url: raw };
  if (BLOCKED_RE.test(compact)) return { kind: "none" };

  const { path: filePart, hash } = splitHash(raw);
  if (!filePart) {
    return hash ? { kind: "anchor", id: decodePath(hash) } : { kind: "none" };
  }
  if (/^file:/i.test(filePart)) {
    return { kind: "local", path: normalizePath(fileUrlToPath(filePart)) };
  }
  if (WINDOWS_ABS_RE.test(filePart) || UNC_RE.test(filePart)) {
    return { kind: "local", path: normalizePath(decodePath(filePart)) };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(filePart)) {
    // 其余协议（ftp / 自定义 scheme）不归本应用管，也不许漏给 WebView
    return { kind: "none" };
  }
  if (!baseDir) return { kind: "none" };
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const rel = decodePath(filePart).replace(/[\\/]/g, sep);
  return { kind: "local", path: normalizePath(`${baseDir.replace(/[\\/]+$/, "")}${sep}${rel}`) };
}

/**
 * 锚点能命中的 id 候选。
 *
 * 两个口径都要认：`href="#文末章节"` 在 DOM 里可能是百分号编码过的；标题 id 带
 * `h-` 前缀（slugify 生成），而手写链接通常不写前缀。
 */
export function anchorCandidates(id: string): string[] {
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    // 不是合法转义就按原样用
  }
  return Array.from(new Set([id, decoded, `h-${id}`, `h-${decoded}`]));
}

export async function openExternalUrl(url: string): Promise<void> {
  try {
    await invoke("open_external", { target: url });
  } catch (err) {
    logger.warn("link", `打开外部链接失败：${String(err)}`);
  }
}

/** 按分类落地，并把结果交回调用方（纯锚点由调用方自己滚）。 */
export function followLink(href: string, opts: FollowOptions): LinkTarget {
  const target = classifyHref(href, opts.baseDir);
  if (target.kind === "external") {
    void openExternalUrl(target.url);
  } else if (target.kind === "local") {
    opts.openLocal?.(target.path);
  }
  return target;
}
