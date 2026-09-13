import { extractToc, type TocEntry } from "./pipeline";

/**
 * 多格式大纲提取（B33）：
 * 之前只有 Markdown 有大纲（# 标题）。现在按扩展名分派到各格式的
 * 结构化提取器，让 TOML / INI / YAML / JSON / Python 等文件也有大纲。
 *
 * 返回 null 表示「该格式不支持大纲」（调用方据此显示不同空态文案）；
 * 返回 [] 表示「格式支持但当前文档没有可显示的节点」。
 */

export type OutlineResult = TocEntry[] | null;

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;
const TOML_EXT = /\.toml$/i;
const INI_EXT = /\.(ini|cfg|conf|inf|properties)$/i;
const YAML_EXT = /\.(ya?ml)$/i;
const JSON_EXT = /\.jsonc?$/i;
const PY_EXT = /\.py$/i;

export function outlineSupported(name: string): boolean {
  return (
    MD_EXT.test(name) ||
    TOML_EXT.test(name) ||
    INI_EXT.test(name) ||
    YAML_EXT.test(name) ||
    JSON_EXT.test(name) ||
    PY_EXT.test(name)
  );
}

export function extractOutline(name: string, text: string): OutlineResult {
  if (MD_EXT.test(name)) return extractToc(text);
  if (TOML_EXT.test(name)) return extractTomlToc(text);
  if (INI_EXT.test(name)) return extractIniToc(text);
  if (YAML_EXT.test(name)) return extractYamlToc(text);
  if (JSON_EXT.test(name)) return extractJsonToc(text);
  if (PY_EXT.test(name)) return extractPythonToc(text);
  return null;
}

// ---------------------------------------------------------------- TOML

/** [section] / [a.b.c]：level = 点分段数，嵌套表自然分层。 */
function extractTomlToc(text: string): TocEntry[] {
  const out: TocEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*\[\[?([^\]]+?)\]?\]\s*(#.*)?$/);
    if (!m) continue;
    const raw = m[1].trim().replace(/^["']|["']$/g, "");
    if (!raw) continue;
    const level = Math.min(6, raw.split(".").length);
    out.push({ level, text: raw, line: i + 1, id: slugOf(raw) });
  }
  return out;
}

// ---------------------------------------------------------------- INI

/** [section]：只有一级（INI 没有嵌套语义）。 */
function extractIniToc(text: string): TocEntry[] {
  const out: TocEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*[;#]/.test(line)) continue;
    const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    out.push({ level: 1, text: name, line: i + 1, id: slugOf(name) });
  }
  return out;
}

// ---------------------------------------------------------------- YAML

/**
 * 缩进驱动的映射键：`key:` 行（列表项 `-`、注释、文档分隔符跳过）。
 * level = floor(缩进/2) + 1（YAML 约定 2 空格一层）。
 */
function extractYamlToc(text: string): TocEntry[] {
  const out: TocEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*---\s*$/.test(line) || /^\s*-/.test(line)) continue;
    const m = line.match(/^(\s*)([^\s#][^:]*?)\s*:(\s|$)/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent % 1 !== 0) continue;
    const key = m[2].trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    const level = Math.min(6, Math.floor(indent / 2) + 1);
    out.push({ level, text: key, line: i + 1, id: slugOf(key) });
  }
  return out;
}

// ---------------------------------------------------------------- JSON

/**
 * 逐行扫描 `"key":`（容错 JSONC 注释与尾逗号）：level = 该行所在花括号深度。
 * 比 JSON.parse 好——保留行号，且解析失败（半截文件）也能出大纲。
 */
function extractJsonToc(text: string): TocEntry[] {
  const out: TocEntry[] = [];
  const lines = text.split("\n");
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const comment = line.indexOf("//");
    if (comment >= 0 && !inString(line, comment)) line = line.slice(0, comment);
    const m = line.match(/^\s*"?([^":]+?)"?\s*:\s*(.*)$/);
    if (m && m[2] !== undefined) {
      const key = m[1].trim();
      if (key && m[2].trim() !== "") {
        // depth = 该行之前打开的容器数，即 key 所在层级
        const level = Math.min(6, Math.max(1, depth));
        out.push({ level, text: key, line: i + 1, id: slugOf(key) });
      }
    }
    // 行内净括号变化（忽略字符串内的括号——简化处理：整行成对引号外的括号）
    depth += netBraces(line);
    if (depth < 0) depth = 0;
  }
  return out;
}

function inString(line: string, idx: number): boolean {
  let quotes = 0;
  for (let i = 0; i < idx; i++) if (line[i] === '"') quotes++;
  return quotes % 2 === 1;
}

function netBraces(line: string): number {
  let n = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{" || c === "[") n++;
    else if (c === "}" || c === "]") n--;
  }
  return n;
}

// ---------------------------------------------------------------- Python

/** class Xxx / def foo / async def bar：level = floor(缩进/4) + 1。 */
function extractPythonToc(text: string): TocEntry[] {
  const out: TocEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)\s*([(:])/);
    if (!m) continue;
    const level = Math.min(6, Math.floor(m[1].length / 4) + 1);
    const suffix = m[4] === "(" ? "()" : "";
    const text2 = `${m[2]} ${m[3]}${suffix}`;
    out.push({ level, text: text2, line: i + 1, id: slugOf(text2) });
  }
  return out;
}

function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "") || "n"
  );
}
