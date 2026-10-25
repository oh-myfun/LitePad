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
 * M1 语言注册表（B371 起对齐 VS Code 的关联顺序）。
 *
 * 检测顺序（照 `src/vs/editor/common/services/languagesAssociations.ts`）：
 *   1. 完整文件名（大小写不敏感）
 *   2. 文件名通配（最长的一条胜出；含 `/` 的按整条路径匹配）
 *   3. 扩展名后缀（最长的一条胜出，多段后缀如 `.js.map` / `.hpp.in` 也算一条）
 *   4. Shebang（首行 `#!` 推断解释器；对应 VS Code 的 firstLine 档）
 *   5. 首行魔数（`<?xml` / `<!DOCTYPE html` …）
 *
 * B371：扩展名不再用「最后一个点之后」推导 —— 那样 `.gitignore` / `.env` / `.bashrc`
 * 的点在下标 0，`dot > 0` 一挡就全落空。VS Code 是拿 `endsWith('.gitignore')` 这种
 * **后缀**比的，所以点开头的文件天然命中；这里改成同一口径。
 *
 * 高亮来源：Markdown 用 CM6 高阶包（增量解析），其余用 legacy-modes
 * StreamLanguage（行内流式解析，轻量、覆盖广）。PHP / Batch 等少数
 * legacy-modes 未覆盖的类型暂只显示标签名，后续按需补充。
 */
interface Entry {
  label: string;
  /** 扩展名后缀（小写、不带前导点；可含多段，如 "js.map"） */
  exts?: string[];
  /** 完整文件名（小写比较，如 "dockerfile"、"cmakelists.txt"） */
  names?: string[];
  /** 文件名通配（VS Code 的 filenamePatterns；含 "/" 的按整条路径匹配） */
  patterns?: FilePattern[];
  /** 首行 shebang 匹配（如 /python/） */
  shebang?: RegExp;
  /** 首行魔数匹配（如 /<\?xml/） */
  magic?: RegExp;
  parser?: Extension | null;
}

interface FilePattern {
  source: string;
  re: RegExp;
  onPath: boolean;
}

/** VS Code `filenamePatterns` 的最小实现：`*` 不跨目录、`**` 跨目录、`?` 单字符。 */
function glob(source: string): FilePattern {
  let re = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "*") {
      if (source[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return { source, re: new RegExp(`^${re}$`, "i"), onPath: source.includes("/") };
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

/**
 * B371：VS Code 的 ignore 语法全部内容就是「行首 `#` 算注释」
 * （`extensions/git-base/syntaxes/ignore.tmLanguage.json`），照抄这一条；
 * `!` 例外与 `/` 锚点保持文本色。
 */
const ignoreMode: Parameters<typeof StreamLanguage.define>[0] = {
  token(stream) {
    if (stream.sol() && stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    stream.skipToEnd();
    return null;
  },
};

const REGISTRY: Entry[] = [
  {
    label: "Markdown",
    exts: [
      "md",
      "markdown",
      "mdown",
      "mkd",
      "mkdn",
      "mdwn",
      "markdn",
      "mdtxt",
      "mdtext",
      "ronn",
      "workbook",
    ],
    parser: markdown(),
  },
  {
    label: "JSON",
    exts: [
      "json",
      "jsonc",
      "json5",
      // VS Code 把 JSONC 文件也记在 json 家族里；LitePad 原本就合并两档。
      "bowerrc",
      "jscsrc",
      "webmanifest",
      "js.map",
      "css.map",
      "ts.map",
      "har",
      "jslintrc",
      "jsonld",
      "geojson",
      "ipynb",
      "vuerc",
      "eslintrc",
      "jsfmtrc",
      "jshintrc",
      "swcrc",
      "hintrc",
      "babelrc",
      "prettierrc",
      "tsbuildinfo",
      "code-profile",
    ],
    names: ["composer.lock", ".watchmanconfig", "bun.lock"],
    parser: stream(json),
  },
  {
    label: "JavaScript",
    exts: ["js", "mjs", "cjs", "jsx", "es6", "pac"],
    names: ["jakefile"],
    parser: stream(javascript),
  },
  { label: "TypeScript", exts: ["ts", "mts", "cts", "tsx"], parser: stream(typescript) },
  {
    label: "Python",
    exts: ["py", "pyw", "pyi", "rpy", "cpy", "gyp", "gypi", "ipy", "pyt"],
    names: ["sconstruct", "sconscript"],
    shebang: /python/,
    parser: stream(python),
  },
  { label: "Rust", exts: ["rs"], parser: stream(rust) },
  { label: "Go", exts: ["go"], parser: stream(go) },
  { label: "C", exts: ["c", "i"], parser: stream(c) },
  {
    label: "C++",
    // VS Code 把 `.h` 归 cpp（c 只留 .c/.i），这里跟上游走。
    exts: [
      "cpp",
      "cc",
      "cxx",
      "c++",
      "hpp",
      "hh",
      "hxx",
      "h++",
      "h",
      "ipp",
      "tpp",
      "ii",
      "ino",
      "inl",
      "ixx",
      "mpp",
      "mxx",
      "txx",
      "cppm",
      "ccm",
      "cxxm",
      "c++m",
      "hpp.in",
      "h.in",
    ],
    parser: stream(cpp),
  },
  { label: "Java", exts: ["java", "jav"], parser: stream(java) },
  { label: "C#", exts: ["cs", "csx", "cake"], parser: stream(csharp) },
  { label: "Kotlin", exts: ["kt", "kts"], parser: stream(kotlin) },
  { label: "Scala", exts: ["scala", "sc"], parser: stream(scala) },
  { label: "Objective-C", exts: ["m", "mm"], parser: stream(objectiveC) },
  { label: "Swift", exts: ["swift"], parser: stream(swift) },
  { label: "Dart", exts: ["dart"], parser: stream(dart) },
  {
    label: "Ruby",
    exts: ["rb", "rbx", "rjs", "gemspec", "rake", "ru", "erb", "podspec", "rbi"],
    names: [
      "rakefile",
      "gemfile",
      "guardfile",
      "podfile",
      "capfile",
      "cheffile",
      "hobofile",
      "vagrantfile",
      "appraisals",
      "rantfile",
      "berksfile",
      "berksfile.lock",
      "thorfile",
      "puppetfile",
      "dangerfile",
      "brewfile",
      "fastfile",
      "appfile",
      "deliverfile",
      "matchfile",
      "scanfile",
      "snapfile",
      "gymfile",
    ],
    shebang: /ruby/,
    parser: stream(ruby),
  },
  {
    label: "Perl",
    exts: ["pl", "pm", "pod", "t", "psgi"],
    shebang: /perl/,
    parser: stream(perl),
  },
  { label: "Lua", exts: ["lua"], parser: stream(lua) },
  {
    label: "Shell",
    exts: [
      "sh",
      "bash",
      "bashrc",
      "bash_aliases",
      "bash_profile",
      "bash_login",
      "bash_logout",
      "profile",
      "ebuild",
      "eclass",
      "xprofile",
      "xsession",
      "xsessionrc",
      "zsh",
      "zshrc",
      "zprofile",
      "zlogin",
      "zlogout",
      "zshenv",
      "zsh-theme",
      "fish",
      "ksh",
      "csh",
      "cshrc",
      "tcshrc",
      "yashrc",
      "yash_profile",
    ],
    names: [
      "apkbuild",
      "pkgbuild",
      ".envrc",
      ".hushlogin",
      "zshrc",
      "zshenv",
      "zlogin",
      "zprofile",
      "zlogout",
      "bashrc_apple_terminal",
      "zshrc_apple_terminal",
    ],
    shebang: /\b(ba|z|k|dash)?sh\b/,
    parser: stream(shell),
  },
  {
    label: "PowerShell",
    exts: ["ps1", "psm1", "psd1", "pssc", "psrc"],
    shebang: /pwsh|powershell/i,
    parser: stream(powerShell),
  },
  { label: "SQL", exts: ["sql", "dsql"], parser: stream(standardSQL) },
  {
    label: "XML",
    exts: [
      "xml",
      "svg",
      "xsl",
      "xslt",
      "plist",
      "xsd",
      "dtd",
      "csproj",
      "fsproj",
      "vbproj",
      "vcxproj",
      "props",
      "targets",
      "xaml",
      "axaml",
      "nuspec",
      "csproj.user",
      "props.user",
      "targets.user",
    ],
    magic: /<\?xml/,
    parser: stream(xml),
  },
  {
    label: "HTML",
    exts: ["html", "htm", "xhtml", "xht", "shtml", "jsp", "asp", "aspx", "ejs"],
    magic: /<!doctype html|<html[\s>]/i,
    parser: stream(html),
  },
  { label: "CSS", exts: ["css"], parser: stream(css) },
  { label: "Sass", exts: ["sass", "scss"], parser: stream(sCSS) },
  { label: "LESS", exts: ["less"], parser: stream(less) },
  {
    label: "YAML",
    exts: ["yml", "yaml", "eyaml", "eyml", "cff", "winget"],
    parser: stream(yaml),
  },
  { label: "TOML", exts: ["toml"], parser: stream(toml) },
  { label: "INI", exts: ["ini"], parser: stream(properties) },
  {
    label: "Properties",
    exts: [
      "properties",
      "conf",
      "cfg",
      "directory",
      "gitattributes",
      "gitconfig",
      "gitmodules",
      "editorconfig",
      "repo",
      "npmrc",
    ],
    names: ["gitconfig"],
    patterns: [glob("**/.config/git/config"), glob("**/.git/config")],
    parser: stream(properties),
  },
  {
    label: "Ignore",
    // 核心覆盖 git / npm / vscode / copilot；docker / eslint / prettier 是各家扩展的
    // 常见关联（VS Code 装上对应扩展后同样识别），一并收纳。
    names: [
      ".gitignore",
      ".gitignore_global",
      ".git-blame-ignore-revs",
      ".npmignore",
      ".vscodeignore",
      ".copilotignore",
      ".dockerignore",
      ".eslintignore",
      ".prettierignore",
      ".stylelintignore",
      ".helmignore",
      ".gcloudignore",
    ],
    exts: ["gitignore", "gitignore_global", "git-blame-ignore-revs", "npmignore"],
    parser: stream(ignoreMode),
  },
  {
    label: "Dotenv",
    names: [".env", ".flaskenv", "user-dirs.dirs"],
    exts: ["env"],
    patterns: [glob(".env.*")],
    parser: stream(properties),
  },
  {
    label: "Dockerfile",
    names: ["dockerfile", "containerfile"],
    exts: ["dockerfile", "containerfile"],
    patterns: [glob("Dockerfile.*"), glob("Containerfile.*")],
    parser: stream(dockerFile),
  },
  { label: "CMake", names: ["cmakelists.txt"], exts: ["cmake"], parser: stream(cmake) },
  { label: "Nginx", names: ["nginx.conf"], exts: ["nginx"], parser: stream(nginx) },
  { label: "NSIS", exts: ["nsi", "nsh"], parser: stream(nsis) },
  { label: "Diff", exts: ["diff", "patch", "rej"], parser: stream(diff) },
  { label: "Haskell", exts: ["hs", "lhs"], parser: stream(haskell) },
  { label: "Pascal", exts: ["pas", "dpr", "dfm"], parser: stream(pascal) },
  { label: "Fortran", exts: ["f", "for", "f90", "f95", "f03", "f08"], parser: stream(fortran) },
  { label: "Julia", exts: ["jl"], shebang: /julia/, parser: stream(julia) },
  {
    label: "Clojure",
    exts: ["clj", "cljs", "cljc", "cljx", "clojure", "edn"],
    parser: stream(clojure),
  },
  {
    label: "Groovy",
    exts: ["groovy", "gvy", "gradle", "jenkinsfile", "nf"],
    names: ["jenkinsfile"],
    patterns: [glob("Jenkinsfile*")],
    parser: stream(groovy),
  },
  { label: "Erlang", exts: ["erl", "hrl"], parser: stream(erlang) },
  { label: "Tcl", exts: ["tcl"], parser: stream(tcl) },
  { label: "VB.NET", exts: ["vb"], parser: stream(vb) },
  { label: "VBScript", exts: ["vbs"], parser: stream(vbScript) },
  { label: "Scheme", exts: ["scm", "ss", "sld", "rkt"], parser: stream(scheme) },
  { label: "Common Lisp", exts: ["lisp", "cl", "lsp"], parser: stream(commonLisp) },
  { label: "CoffeeScript", exts: ["coffee", "cson", "iced"], parser: stream(coffeeScript) },
  { label: "Octave", exts: ["oct"], shebang: /octave/, parser: stream(octave) },
  {
    label: "R",
    exts: ["r", "rd", "rhistory", "rprofile", "rt"],
    shebang: /\brscript\b|\/r\b/,
    parser: stream(r),
  },
  { label: "Assembly", exts: ["s", "asm"], parser: stream(gas) },
  // 以下类型 legacy-modes 暂无高亮，状态栏仍显示正确标签
  {
    label: "PHP",
    exts: ["php", "phtml", "php3", "php4", "php5", "ctp"],
    shebang: /php/,
  },
  { label: "Batch", exts: ["bat", "cmd"] },
  {
    label: "Makefile",
    names: ["makefile", "gnumakefile", "bsdmakefile", "ocamlmakefile"],
    exts: ["mk", "mak"],
  },
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
    const path = fileName.replace(/\\/g, "/").toLowerCase();
    const base = path.split("/").pop() ?? "";

    // 1. 完整文件名
    const byName = REGISTRY.find((e) => e.names?.includes(base));
    if (byName) return toInfo(byName);

    // 2. 文件名通配（最长的一条胜出，与 VS Code 同口径）
    let byPattern: Entry | null = null;
    let patternLen = 0;
    for (const e of REGISTRY) {
      for (const p of e.patterns ?? []) {
        if (p.source.length <= patternLen) continue;
        if (p.re.test(p.onPath ? path : base)) {
          byPattern = e;
          patternLen = p.source.length;
        }
      }
    }
    if (byPattern) return toInfo(byPattern);

    // 3. 扩展名后缀（最长的一条胜出；`.gitignore` / `.js.map` 都走这一档）
    let byExt: Entry | null = null;
    let extLen = 0;
    for (const e of REGISTRY) {
      for (const ext of e.exts ?? []) {
        if (ext.length <= extLen) continue;
        if (base.endsWith(`.${ext}`)) {
          byExt = e;
          extLen = ext.length;
        }
      }
    }
    if (byExt) return toInfo(byExt);
  }

  const line = (firstLine ?? "").trim();

  // 4. Shebang
  if (line.startsWith("#!")) {
    const hit = REGISTRY.find((e) => e.shebang?.test(line));
    if (hit) return toInfo(hit);
  }

  // 5. 首行魔数
  if (line) {
    const hit = REGISTRY.find((e) => e.magic?.test(line));
    if (hit) return toInfo(hit);
  }

  return PLAIN;
}

function toInfo(e: Entry): LanguageInfo {
  return { label: e.label, extension: e.parser ?? null };
}

/**
 * B365：按注册表标签取语言（状态栏「文件类型」的手动覆盖用）。
 * 未知标签返回 null —— 调用方据此回退自动检测，不把旧值当死值。
 */
export function languageInfoByLabel(label: string): LanguageInfo | null {
  const hit = REGISTRY.find((e) => e.label === label);
  return hit ? toInfo(hit) : null;
}

/**
 * B365：状态栏浮层的语言清单；B386 照 VS Code 排序 —— 语言模式选择器在
 * `languagesRegistry.getSortedRegisteredLanguageNames()` 里按语言名忽略大小写
 * 字母序排（editorStatus.ts 的 picker 直接消费这份序），这里照抄同款比较。
 * 「自动检测」不在这里，由 languageChoices 置顶。
 */
export const LANGUAGE_LABELS: readonly string[] = REGISTRY.map((e) => e.label).sort((a, b) => {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : 0;
});

/** B365：「回到自动检测」那一项的名字（与语言标签同处一份清单，只有一个勾）。 */
export const AUTO_LANGUAGE = "自动检测";

export interface LanguageChoice {
  label: string;
  description?: string;
  checked: boolean;
}

/**
 * B365：状态栏「文件类型」浮层的条目。
 * `override = null` ⇒ 自动检测打勾；手动值 ⇒ 对应语言打勾，且只有一项打勾。
 * 未知覆盖值（旧会话/注册表删过标签）按自动显示 —— 与 languageOfDoc 的回退同口径。
 */
export function languageChoices(override: string | null): LanguageChoice[] {
  const known = override && languageInfoByLabel(override) ? override : null;
  return [
    { label: AUTO_LANGUAGE, description: "按文件名与后缀自动识别", checked: known === null },
    ...LANGUAGE_LABELS.map((label) => ({ label, checked: known === label })),
  ];
}
