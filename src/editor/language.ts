import type { Extension } from "@codemirror/state";
import { foldService, StreamLanguage } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import {
  c,
  cpp,
  csharp,
  java,
  kotlin,
  scala,
  objectiveC,
  dart,
} from "@codemirror/legacy-modes/mode/clike";
import { javascript, json, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { go } from "@codemirror/legacy-modes/mode/go";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { xml, html } from "@codemirror/legacy-modes/mode/xml";
import { css, sCSS, less } from "@codemirror/legacy-modes/mode/css";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { nsis } from "@codemirror/legacy-modes/mode/nsis";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { r } from "@codemirror/legacy-modes/mode/r";
import { gas } from "@codemirror/legacy-modes/mode/gas";

/**
 * M1 语言注册表。
 *
 * 检测顺序（Notepad++ 风格）：
 *   1. 完整文件名（Dockerfile / Makefile / CMakeLists.txt …）
 *   2. 扩展名
 *   3. Shebang（首行 `#!` 推断解释器）
 *   4. 首行魔数（`<?xml` / `<!DOCTYPE html` …）
 *
 * 高亮来源：Markdown 用 CM6 高阶包（增量解析），其余用 legacy-modes
 * StreamLanguage（行内流式解析，轻量、覆盖广）。PHP / Batch 等少数
 * legacy-modes 未覆盖的类型暂只显示标签名，后续按需补充。
 */
interface Entry {
  label: string;
  exts?: string[];
  /** 完整文件名（小写比较，如 "dockerfile"、"cmakelists.txt"） */
  names?: string[];
  /** 首行 shebang 匹配（如 /python/） */
  shebang?: RegExp;
  /** 首行魔数匹配（如 /<\?xml/） */
  magic?: RegExp;
  parser?: Extension | null;
}

const stream = (p: Parameters<typeof StreamLanguage.define>[0]): Extension => [
  StreamLanguage.define(p),
  indentFoldService,
];

/**
 * 缩进折叠服务（流式语言通用折叠）。
 *
 * StreamLanguage（legacy-modes）没有 Lezer 语法树，CM6 的 codeFolding
 * 无 foldable 节点 → JSON/JS/Python 等全部不可折叠，只有 Markdown（Lezer）
 * 能折。这里按缩进规则给出折叠范围：下一非空行缩进比本行深 → 本行行尾
 * 到缩进回退处可折叠。一个服务覆盖注册表里全部流式语言。
 * Markdown 保持 Lezer 自带折叠（标题/代码块），不叠加本服务。
 */
function lineIndent(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

const indentFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  if (!line.text.trim()) return null;
  const base = lineIndent(line.text);
  let end = line.to;
  let found = false;
  for (let pos = line.to; pos < state.doc.length;) {
    const next = state.doc.lineAt(pos + 1);
    if (!next.text.trim()) {
      pos = next.to; // 跳过空行继续找（折叠范围不含尾部空行）
      continue;
    }
    if (lineIndent(next.text) > base) {
      end = next.to;
      found = true;
      pos = next.to;
    } else {
      break;
    }
  }
  return found ? { from: line.to, to: end } : null;
});

const REGISTRY: Entry[] = [
  { label: "Markdown", exts: ["md", "markdown", "mdown", "mkd"], parser: markdown() },
  { label: "JSON", exts: ["json", "jsonc", "json5"], parser: stream(json) },
  { label: "JavaScript", exts: ["js", "mjs", "cjs", "jsx"], parser: stream(javascript) },
  { label: "TypeScript", exts: ["ts", "mts", "cts", "tsx"], parser: stream(typescript) },
  {
    label: "Python",
    exts: ["py", "pyw", "pyi"],
    shebang: /python/,
    parser: stream(python),
  },
  { label: "Rust", exts: ["rs"], parser: stream(rust) },
  { label: "Go", exts: ["go"], parser: stream(go) },
  { label: "C", exts: ["c", "h"], parser: stream(c) },
  {
    label: "C++",
    exts: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "tpp", "ipp"],
    parser: stream(cpp),
  },
  { label: "Java", exts: ["java"], parser: stream(java) },
  { label: "C#", exts: ["cs"], parser: stream(csharp) },
  { label: "Kotlin", exts: ["kt", "kts"], parser: stream(kotlin) },
  { label: "Scala", exts: ["scala", "sc"], parser: stream(scala) },
  { label: "Objective-C", exts: ["m", "mm"], parser: stream(objectiveC) },
  { label: "Swift", exts: ["swift"], parser: stream(swift) },
  { label: "Dart", exts: ["dart"], parser: stream(dart) },
  { label: "Ruby", exts: ["rb", "erb"], shebang: /ruby/, parser: stream(ruby) },
  { label: "Perl", exts: ["pl", "pm"], shebang: /perl/, parser: stream(perl) },
  { label: "Lua", exts: ["lua"], parser: stream(lua) },
  {
    label: "Shell",
    exts: ["sh", "bash", "zsh", "ksh"],
    shebang: /\b(ba|z|k|dash)?sh\b/,
    parser: stream(shell),
  },
  {
    label: "PowerShell",
    exts: ["ps1", "psm1", "psd1"],
    shebang: /pwsh|powershell/i,
    parser: stream(powerShell),
  },
  { label: "SQL", exts: ["sql"], parser: stream(standardSQL) },
  {
    label: "XML",
    exts: ["xml", "svg", "xsl", "xslt", "plist"],
    magic: /<\?xml/,
    parser: stream(xml),
  },
  {
    label: "HTML",
    exts: ["html", "htm", "xhtml"],
    magic: /<!doctype html|<html[\s>]/i,
    parser: stream(html),
  },
  { label: "CSS", exts: ["css"], parser: stream(css) },
  { label: "Sass", exts: ["sass", "scss"], parser: stream(sCSS) },
  { label: "LESS", exts: ["less"], parser: stream(less) },
  { label: "YAML", exts: ["yml", "yaml"], parser: stream(yaml) },
  { label: "TOML", exts: ["toml"], parser: stream(toml) },
  {
    label: "INI",
    exts: ["ini", "cfg", "conf", "env", "gitconfig", "editorconfig"],
    parser: stream(properties),
  },
  { label: "Properties", exts: ["properties"], parser: stream(properties) },
  { label: "Dockerfile", names: ["dockerfile"], exts: ["dockerfile"], parser: stream(dockerFile) },
  { label: "CMake", names: ["cmakelists.txt"], exts: ["cmake"], parser: stream(cmake) },
  { label: "Nginx", names: ["nginx.conf"], exts: ["nginx"], parser: stream(nginx) },
  { label: "NSIS", exts: ["nsi", "nsh"], parser: stream(nsis) },
  { label: "Diff", exts: ["diff", "patch"], parser: stream(diff) },
  { label: "Haskell", exts: ["hs", "lhs"], parser: stream(haskell) },
  { label: "Pascal", exts: ["pas", "dpr", "dfm"], parser: stream(pascal) },
  { label: "Fortran", exts: ["f", "for", "f90", "f95", "f03", "f08"], parser: stream(fortran) },
  { label: "Julia", exts: ["jl"], shebang: /julia/, parser: stream(julia) },
  { label: "Clojure", exts: ["clj", "cljs", "cljc", "edn"], parser: stream(clojure) },
  {
    label: "Groovy",
    exts: ["groovy", "gradle", "jenkinsfile"],
    names: ["jenkinsfile"],
    parser: stream(groovy),
  },
  { label: "Erlang", exts: ["erl", "hrl"], parser: stream(erlang) },
  { label: "Tcl", exts: ["tcl"], parser: stream(tcl) },
  { label: "VB.NET", exts: ["vb"], parser: stream(vb) },
  { label: "VBScript", exts: ["vbs"], parser: stream(vbScript) },
  { label: "Scheme", exts: ["scm", "ss", "sld", "rkt"], parser: stream(scheme) },
  { label: "Common Lisp", exts: ["lisp", "cl", "lsp"], parser: stream(commonLisp) },
  { label: "CoffeeScript", exts: ["coffee"], parser: stream(coffeeScript) },
  { label: "Octave", exts: ["oct"], shebang: /octave/, parser: stream(octave) },
  { label: "R", exts: ["r", "rd"], shebang: /\brscript\b|\/r\b/, parser: stream(r) },
  { label: "Assembly", exts: ["s", "asm"], parser: stream(gas) },
  // 以下类型 legacy-modes 暂无高亮，状态栏仍显示正确标签
  { label: "PHP", exts: ["php", "phtml", "php3"], shebang: /php/ },
  { label: "Batch", exts: ["bat", "cmd"] },
  { label: "Makefile", names: ["makefile", "gnumakefile", "bsdmakefile"], exts: ["mk", "mak"] },
  { label: "Vue", exts: ["vue"] },
  { label: "Plain Text", exts: ["txt", "text", "log", "nfo"] },
];

export interface LanguageInfo {
  label: string;
  /** null 表示暂无高亮，仍保留行号/折叠/软换行/编码等基础能力 */
  extension: Extension | null;
}

const PLAIN: LanguageInfo = { label: "Plain Text", extension: null };

export function detectLanguage(fileName: string | null, firstLine?: string): LanguageInfo {
  if (fileName) {
    const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? "";

    // 1. 完整文件名
    const byName = REGISTRY.find((e) => e.names?.includes(base));
    if (byName) return toInfo(byName);

    // 2. 扩展名
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1) : "";
    if (ext) {
      const byExt = REGISTRY.find((e) => e.exts?.includes(ext));
      if (byExt) return toInfo(byExt);
    }
  }

  const line = (firstLine ?? "").trim();

  // 3. Shebang
  if (line.startsWith("#!")) {
    const hit = REGISTRY.find((e) => e.shebang?.test(line));
    if (hit) return toInfo(hit);
  }

  // 4. 首行魔数
  if (line) {
    const hit = REGISTRY.find((e) => e.magic?.test(line));
    if (hit) return toInfo(hit);
  }

  return PLAIN;
}

function toInfo(e: Entry): LanguageInfo {
  return { label: e.label, extension: e.parser ?? null };
}
