// 静态断言工具：配置 / 样式 / 源码文本那一类**无法在运行时断言**的守卫都靠它们。
//
// 从 `tests/regressions.test.ts` 抽出来（09-22 测试整理）：拆分到各模块测试文件后，这些
// 工具会被多处 import，不能各自复制一份 —— 尤其下面几条注释里记的坑，是踩过才写下来的。
//
// ⚠️ 本文件**不是测试文件**（无 `it`），只导出工具；放在 tests/ 下是因为只服务于测试。

import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import zlib from "node:zlib";

// 拼接多个源码模块为一段文本，供「拼接源码 + toContain/toMatch」类契约断言复用。
// 传相对路径（不含 `src/` 前缀、不含 `.ts` 后缀），例如 concatSrc(["main", "session/session", "ui"])。
// 早期这些清单在多个测试里手写重复，模块改名/增删时易漏改导致断言静默失真 —— 集中到此处。
export function concatSrc(relPaths: string[]): string {
  // 顺带归一 CRLF —— 源码约定一律 LF，Windows 上 readFileSync 可能读回 CRLF，
  // 多处调用点原本各自 .replace(/\r\n/g, "\n")，这里统一收口。
  return relPaths
    .map((p) => readFileSync(`src/${p}.ts`, "utf-8"))
    .join("\n")
    .replace(/\r\n/g, "\n");
}

// 常用模块集（避免同一组清单在多个测试里重复）。
export const MAIN_SESSION_UI = ["main", "session/session", "ui"];
export const MAIN_SESSION = ["main", "session/session"];
export const SYNC_BUNDLE = [
  "main",
  "multiwindow/windows",
  "tabs",
  "markdown",
  "sync-scroll",
  "core/viewport",
];

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
/**
 * 截 Python 顶层函数体（按**缩进**收尾，不是花括号）。
 *
 * ⚠️ 不能拿 topLevelFnBody 凑合：Python 函数靠缩退结束，源码里压根没有 `}`，
 *    那个工具在 TS 上找的第一个 `\n}` 恒为 -1，返回空串 —— 函数体里所有断言
 *    都会变成「找不到」，退化了也照样绿（B221 首次写这条时直接踩了）。
 *
 * ⚠️ 收尾判定必须**先判后 push**：下一个函数/顶层语句那一行（行首非空白）不属于
 *    本函数，带上它就是假绿 —— B221 的 d4 退化实测：挖掉 write_icons 里的
 *    `reorder_ico_first(...)` 调用后，紧跟其后的 `def reorder_ico_first(...)`
 *    被算进了函数体，于是「必须调用重排」这条照样命中，退化全绿。
 */
export function pyFnBody(src: string, name: string): string {
  const lines = src.split("\n");
  const re = new RegExp(`def\\s+${name}\\s*\\(`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // 回到行首 = 本函数已结束；这一行是**下一个**定义，不能算进来
    if (i > start && line !== "" && !line.startsWith(" ")) break;
    out.push(line);
  }
  return out.join("\n");
}

// ⚠️ 下面是 TS 版的同名工具：两条都要留 —— pyFnBody 服务 Python 脚本（scripts/*.py），
//    topLevelFnBody 服务 TS 源码（src/**）。混用会静默返回空串（见 pyFnBody 的注释）。
//
// ⚠️⚠️ `name` 是**裸子串**，`indexOf` 取**首次出现** —— 有两种踩法：
//    ① 源码注释里提了**别的函数名**，那条契约会截到「本函数的注释块」而不是函数体，
//       断言凭空失败。B231 实测：`applyFontFamily` 的注释里写了一句
//       「见 applyCodeFontFamily」，于是 `topLevelFnBody(src, "applyCodeFontFamily")`
//       起点落在前者的注释里。
//       ⇒ 被 `topLevelFnBody` 盯着的函数，其注释里**别写其它函数名**；要指路就写
//       「下面那个 XXX setter」这种不含标识符的说法。
//    ② **调用点排在声明之前**时更隐蔽：截到的是 `fn();\n}` 这种调用片段，
//       断言表现为「函数体里没有我预期的内容」，看着像代码写错了。
//       B233 实测：`refreshViewModeButton()` 有三处调用在 928/963/5105 行、声明在
//       5181 行 ⇒ 直接用下面的 **`fnBody`**（只认 `function <name>(`）。
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

/**
 * 同上，但**只认函数声明处**（`function <name>(`），跳过调用点与注释里的提及。
 *
 * ⚠️ 什么时候必须用这个：`topLevelFnBody` 的 `indexOf(name)` 取**首次出现**，
 *    所以只要**调用点排在声明之前**（`main.ts` 里 `refreshViewModeButton()` 有三处
 *    调用在 928/963/5105 行，声明在 5181 行），它就会截到
 *    `refreshViewModeButton();\n}` 这种调用片段 —— 断言不是凭空失败，而是
 *    **静默取到错的东西**。B233 实测栽在这里（第一次跑三条用例全红，报的是
 *    「取到的函数体里没有 langLabel」，很像代码写错了，其实是工具取歪）。
 *
 * ⇒ **默认用这个**；`topLevelFnBody` 只留给「首次出现确实是声明」的老契约。
 */
export function fnBody(fileText: string, name: string): string {
  const start = fileText.indexOf(`function ${name}(`);
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

// --------------------------------------------------------------------------- #
// PNG 像素（B220）
// --------------------------------------------------------------------------- #
/**
 * 读一张非隔行 8bit PNG 的 Alpha 通道 —— 用来静态判定「这张图有没有垫底色」。
 *
 * 为什么要在测试里解像素：jsdom 不做布局也不解码图片，光看 CSS / import 只能证明
 * 「挂了张图」，证明不了「图是透明底的」。而「标题栏要用不带背景的版本」这件事，
 * 全靠透明底才成立（垫了底就等于把那块石墨方底画进标题栏）。
 *
 * Pillow 出图固定是 8bit 非隔行；colorType 6 = RGBA、2 = RGB。
 */
export interface PngAlpha {
  width: number;
  height: number;
  /**
   * 每像素字节数（RGB=3 / RGBA=4）。判据要按它取通道，别写死 4。
   */
  bpp: number;
  /** 取某个像素的 alpha（0–255）。 */
  at: (x: number, y: number) => number;
  /** 取某个像素的 RGBA（alpha 通道在 RGB 时按 255 补）。 */
  px: (x: number, y: number) => [number, number, number, number];
  /** 全图是否存在不透明像素（= 图不是空的）。 */
  hasInk: boolean;
}

/**
 * 归一化网格上的 alpha 指纹（每格取块平均）。
 *
 * 用来判「两张图是否**同一张母版**缩出来的」：规格不同也能比（512 vs 256 都行），
 * 抗锯齿的抖动被块平均吃掉。B222 之后源图是无底的内缩图形（四周透明留白），
 * 靠单点采样（四边中点）判形态已经不成立 —— 形状指纹才是能跟着源图走的判据。
 */
export function alphaGrid(p: PngAlpha, n = 8): number[] {
  const out: number[] = [];
  for (let gy = 0; gy < n; gy += 1) {
    for (let gx = 0; gx < n; gx += 1) {
      const x0 = Math.floor((gx * p.width) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * p.width) / n));
      const y0 = Math.floor((gy * p.height) / n);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * p.height) / n));
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += p.at(x, y);
          cnt += 1;
        }
      }
      out.push(Math.round(sum / cnt));
    }
  }
  return out;
}

/** 两条指纹的最大逐格差值（同源直出应当很小）。 */
export function gridDiff(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("指纹长度不一致");
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
}

export function pngAlpha(file: Buffer): PngAlpha {
  const buf = Buffer.from(file);
  let width = 0;
  let height = 0;
  let bpp = 4;
  const chunks: Buffer[] = [];
  for (let off = 8; off + 8 <= buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // 第 9 字节 = colorType；调色板/灰阶那几档本项目用不到，直接钉死两种
      const color = data[9];
      bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
    } else if (type === "IDAT") {
      chunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !bpp) throw new Error("PNG 不是 8bit RGB/RGBA，解不了 Alpha");

  // inflate 之后逐行反演 filter（None/Sub/Up/Average/Paeth），拼出原始像素
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let cur = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const ft = raw[row];
    for (let i = 0; i < stride; i++) {
      const x = raw[row + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      cur[i] =
        (ft === 0
          ? x
          : ft === 1
            ? x + a
            : ft === 2
              ? x + b
              : ft === 3
                ? x + ((a + b) >> 1)
                : x + paeth(a, b, c)) & 0xff;
    }
    const t = prev;
    prev = cur;
    cur = t; // 反转后 prev = 刚算完的这一行
    prev.copy(out, y * stride);
  }
  let hasInk = false;
  for (let i = 3; i < out.length; i += bpp) {
    if (out[i] > 0) {
      hasInk = true;
      break;
    }
  }
  const at = (x: number, y: number) => (bpp === 4 ? out[y * stride + x * bpp + 3] : 255);
  return {
    width,
    height,
    bpp,
    at,
    px: (x: number, y: number) => {
      const i = y * stride + x * bpp;
      const a = at(x, y);
      return bpp === 4 ? [out[i], out[i + 1], out[i + 2], a] : [out[i], out[i + 1], out[i + 2], a];
    },
    hasInk,
  };
}

// --------------------------------------------------------------------------- #
// ICO / 锐度（B221 任务栏图标发糊）
// --------------------------------------------------------------------------- #

/**
 * 解析一份 ICO 的目录，返回每档的 { 边长, bpp, PNG 载荷 }。
 *
 * 任务栏 / 资源管理器图标取的是**这个 ICO**：`src-tauri/build.rs` 里 `tauri_build::build()`
 * 生成的 resource.rc 写着 `32512 ICON "...icons\icon.ico"`，exe 把这份嵌进去，
 * 外壳按需要的尺寸选档。所以「任务栏上那颗糊不糊」只能从这份文件判 ——
 * 光看 `bundle.icon` 判不到，那三张 png 是给 installer / 快捷方式 / 商店用的。
 *
 * 载荷只解 PNG（本项目 Pillow 出的恒是 PNG 载荷；换 DIB 载荷这条会直接抛错，
 * 宁可抛也不给一个恒 0 的假绿）。
 *
 * ⚠️ 目录首字节 bWidth 对 256 记 0，读尺寸时 `|| 256` 补回。
 */
export interface IcoEntry {
  size: number;
  bpp: number;
  bytesInRes: number;
  payload: Buffer;
}

export function icoEntries(file: Buffer): IcoEntry[] {
  const buf = Buffer.from(file);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (type !== 1) throw new Error(`不是 ICO（type=${type}）`);
  const out: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o];
    const bpp = buf.readUInt16LE(o + 6);
    const bytes = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    // bWidth/bHeight 记 0 表示 256（ICO 规范），别当成「空档」抛错
    out.push({
      size: w || 256,
      bpp,
      bytesInRes: bytes,
      payload: buf.subarray(off, off + bytes),
    });
  }
  return out;
}

/**
 * 相邻像素梯度均值（只看不透明区）—— 量化「图标糊不糊」的锐度指标。
 *
 * 为什么不用 Pillow 那边的数：这是给测试用的独立实现，图一旦回炉重生成，
 * 指标必须能跟着产物走（在测试里现算），不能拿外部脚本的一次性测量当判据。
 * 归一化到 0–255 量纲，方便直接写阈值。
 */
export function edgeEnergy(png: PngAlpha): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x + 1 < png.width; x++) {
      const a = png.px(x, y);
      const b = png.px(x + 1, y);
      if (a[3] < 200 && b[3] < 200) continue; // 两个都透明 → 不算边
      sum += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
