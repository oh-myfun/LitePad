// 静态断言工具：配置 / 样式 / 源码文本那一类**无法在运行时断言**的守卫都靠它们。
//
// 从 `tests/regressions.test.ts` 抽出来（09-22 测试整理）：拆分到各模块测试文件后，这些
// 工具会被多处 import，不能各自复制一份 —— 尤其下面几条注释里记的坑，是踩过才写下来的。
//
// ⚠️ 本文件**不是测试文件**（无 `it`），只导出工具；放在 tests/ 下是因为只服务于测试。

import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

// JSON 配置结构松散（tauri.conf/package.json 各异），此处刻意放宽：
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// 取 `:root[data-theme="X"] { ... }` 的**块体**（不含选择器）。
// ⚠️ 必须先剥注释、再按花括号配对计数，不能图省事写 `\{[^}]*\}`：
// 变量块里只要有一条注释含 `}`（例如注释里写 `inputOption.active{Foo,Bar}`），
// 那个 `[^}]*` 就会**从注释里的花括号处截断**，块内后面的变量全被判「缺失」。
// 结果是双向失真 —— 既会把「注释里写了个花括号」误报成「变量漏定义」（假红），
// 也可能在截断点之后恰好没有断言对象时**静默放行**（假绿）。
export function themeBlock(css: string, theme: "dark" | "light"): string {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{`).exec(code);
  if (!m) return "";
  const open = m.index + m[0].length - 1; // 指向 `{`
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return "";
}

// 剥掉整行 `//` 注释（保留行号不变，便于报错定位）。
// ⚠️ 源码断言必须落在**代码**上：本文件/源码里常有说明性注释，里面会原样复述被断言的
// 标识符（B79 就在注释里写了 `persistSettings()` 与 `themeMode = normalizeMode(...)`）。
// 反向验证实测：挖掉真正的调用后，只要比对整份文件，断言照样通过（**假绿**）。
// 只剥「整行都是注释」的行，行内的 `//`（如 URL `https://`）不受影响。
export function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
}

// 剥掉 CSS 的块注释，只留规则文本。
// ⚠️ 与 stripLineComments 是同一类陷阱在样式上的翻版：本项目在**删掉一套样式**时习惯留一行
// 注释交代去向（B97 删顶栏快捷按钮后就有「原先 .toolbar-actions / .tool-btn 一套规则只服务于
// 那 8 颗按钮……直接删掉」）。那是变更史，不是样式。断言「类名必须已删除」时若比对原文，
// 会被这行注释误伤报**假红**；反之，若断言写成 `toContain` 而规则已删、只剩注释提到它，
// 又会**假绿**。所以凡对整份样式做「有没有某类名/属性」的判断，都先过这一层。
// 顺带去掉 `@media` 之类嵌套里残留的空白行，断言里不会用到，无须关心。
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 取某条规则的**声明块体**（同样剥注释 + 数花括号）。selector 直接当字面量用。
// 支持三种写法：
//   · 单选择器 `.find-bar { }`
//   · 选择器列表里的一员 `.find-nav, ... .find-x { }`（会自动扫到列表末尾的那个 `{`）
//   · 同一选择器出现多次时用 filter 指定取哪一条：
//       - 数字 = 取第 n 处；
//       - 字符串 = 取**块体里含该声明**的那一处（推荐，比数序号稳）。
//     例：`.find-x` 先出现在扁平按钮列表里，自己还有一条定位规则 →
//     `ruleBlock(css, ".find-x", "position")`
// ⚠️ 新写的用例请用它，不要再用 `\.foo\s*\{[^}]*\}` —— 那个写法在块内注释含 `}` 时
// 会从注释处截断：断言 `toContain` 会误报「缺失」（假红），而断言 `not.toContain`
// 会**静默通过**（假绿），后者尤其危险。
// TODO(backlog): 仓库里还有 ~46 处旧写法待迁移，见 .workbuddy/memory/open-items/backlog.md。
export function ruleBlock(css: string, selector: string, filter?: number | string): string {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 选择器后必须是边界字符，免得 `.find-row` 命中 `.find-row-replace`
  const re = new RegExp(`${esc}(?=[\\s,{])`, "g");
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    seen++;
    const open = code.indexOf("{", m.index);
    if (open < 0) return "";
    // 选择器与该 `{` 之间只允许出现选择器列的字符（`.a, .b:hover > c[attr="x"]`）。
    // 判据：中间**不能出现 `;` / `}`** —— 那说明已经越过上一条声明或上一条规则，
    // 撞到的是别处的 `{`（例如 `.foo` 恰好在某个属性值里被提到）。
    const between = code.slice(m.index + m[0].length, open);
    if (/[;{}]/.test(between)) continue;
    let depth = 0;
    let body = "";
    for (let i = open; i < code.length; i++) {
      const ch = code.charAt(i);
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          body = code.slice(open + 1, i);
          break;
        }
      }
    }
    if (typeof filter === "string") {
      if (body.includes(filter)) return body;
      continue;
    }
    if (typeof filter === "number" && seen < filter) continue;
    return body;
  }
  return "";
}

// 断样式规则时先剥掉注释：注释里常写「旧值是什么」（如 flex: 0 1 auto），
// 不剥离的话 not.toMatch 会被自己的文档误伤。
export function cssDecls(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 截某个顶层函数的源码体（源文本里第一条「行首 } 后紧跟换行/EOF」，即顶层收尾花括号）。
// ⚠️ 不能只找第一条 `\n}`：多行返回类型字面量也会以 `} {` 出现在行首
//（如 `function f(): {\n  a: number;\n} {`），那样会在签名处就截断，
// 于是函数体内所有断言都变成「找不到」——B71 ④ 的 sessionTabRecordOf 就踩过这个坑。
export function topLevelFnBody(fileText: string, name: string): string {
  const start = fileText.indexOf(name);
  if (start < 0) return "";
  let end = fileText.indexOf("\n}", start);
  while (end > -1) {
    const after = fileText[end + 2];
    if (after === undefined || after === "\n") break;
    end = fileText.indexOf("\n}", end + 1);
  }
  return fileText.slice(start, end + 2);
}

/** B57 文件类型图标的 10 个家族（与 src/shell/fileicons.ts 的 FileFamily 一一对应）。 */
export const FILE_FAMILIES = [
  "md",
  "code",
  "brace",
  "hash",
  "tag",
  "brk",
  "db",
  "diff",
  "build",
  "txt",
] as const;

// 全仓库文本文件枚举（B36 改名残留检查用）：跳过构建产物 / 依赖 / 二进制。
// ⚠️ `.tmp` 与 `generated-images` 同理：都是**永不入库、可随时整目录删掉**的临时落点
//    （见 MEMORY.md「临时文件一律落在本项目内」），里面允许放历史副本 —— 历史副本里
//    提到旧名是「对过去的记录」，不是会泄漏到产品里的命名残留。少了这条，
//    往 .tmp/ 扔一个引用旧名的探针脚本就会把全仓改名守卫判红（09-18 B72 推送时实测）。
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  "gen",
  ".git",
  ".tmp",
  "generated-images",
  ".vite",
  // 内部智能体目录（skills/memory），不随产品发布，且体积庞大；
  // 全仓库文本扫描在此跳过以保 pre-push 门禁稳定（内存文件豁免也覆盖不到的慢路径）。
  ".workbuddy",
]);
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".ico",
  ".exe",
  ".woff",
  ".woff2",
  ".tt",
  ".pdf",
  ".zip",
]);

export function collectTextFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectTextFiles(p, acc);
    } else if (!BINARY_EXT.has(extname(e.name).toLowerCase())) {
      acc.push(p);
    }
  }
  return acc;
}

// ------------------------------------------------------------------ B98 构建脚本判据

/**
 * `scripts/build-all.sh` 是否在**打包前**点数 `dist/assets`，不足就 exit 1。
 *
 * 事故（09-23）：`tauri build` 的 vite 阶段被中断，`dist` 只剩一个 `index.html`、
 * `assets/` 全丢。后续打包**退出码 0、日志正常**，但产出的 exe 打开是一片空白 ——
 * 前端根本没被嵌进去。所以判据必须同时含「点数动作」和「不合格就阻断」两半：
 * 少了后者就只是打印一行日志，照样会带着空壳打下去。
 */
export function hasDistIntegrityGuard(src: string): boolean {
  return src.includes("find dist/assets -type f") && /dist 前端产物不完整[\s\S]*?exit 1/.test(src);
}

/**
 * `scripts/build-all.sh` 是否把第 3 步 `cargo build --release` 的产物标注成**不可交付**。
 *
 * 同一轮事故的另一半：把第 3 步的 exe 直接给了用户，打开显示「127.0.0.1 拒绝连接」。
 * 原因是 tauri 的 `dev = !custom-protocol`，而 `custom-protocol` 只在 `tauri build` 时注入 ——
 * 那一步的产物是 dev 模式，会去连 `build.devUrl`。判据同时要求「标注」与「失败指纹」
 * （`127.0.0.1`），保证后来人删掉这段说明时测试会红。
 */
export function hasStep3NotDeliverableWarning(src: string): boolean {
  return /\[3\/4\][^\n]*不可交付/.test(src) && src.includes("127.0.0.1");
}
