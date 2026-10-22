// @vitest-environment node
// B337 · UI 字阶的契约。
//
// 这一族判据要守的不是「某个选择器是几号字」，而是**裸数值不再长出来**：盘点过一次
// （2026-10-22），chrome 的字号散在 8/10/11/12/12.5/13/14/15/20 九个档，只有
// `--font-size` 与 `--title-text-size` 两颗 token，于是 12 / 12.5 / 13 三档只差 0.5px，
// 肉眼看不出层级，代码里却是三套写法 ——「菜单栏 12.5、点开的列表 13」就是这么来的。
// 所以这里钉两件事：① 五颗字阶 token 存在且取值对；② 除白名单（图标谱 / 徽标 / token
// 定义处本身）以外，CSS 里不许再出现裸的 `font-size: Npx`。
//
// ⚠️ 扫描用的文本一律先剥注释（`stripCssComments`）：注释里的散文会喂给判据假数值 ——
// 这条坑在 B328/B329 那轮踩过（见 pitfalls/css-judges-and-pixel-probes）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripCssComments } from "./static";

const read = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

const FILES = ["src/styles/global.css", "src/styles/preview.css", "src/styles/fonts.css"];
const cssOf = (rel: string): string => stripCssComments(read(rel));

/** 白名单：这些选择器里允许出现裸数值。 */
const WHITELIST: readonly [string, string][] = [
  [":root", "token 的定义处（值必须写在这里，别处只准引用）"],
  [".codicon", "图标尺寸另有谱：codicon 用 `font:` 简写，字号由字形度量决定"],
  [".find-badge", "徽标档（挂在开关右上角的计数，11px 会撑破那颗小圆片）"],
];

/**
 * 每条**裸** `font-size: Npx` 的落点（选择器 + 值）。
 *
 * ⚠️ 「最近的 `{`」取的是**开括号之前**那段：从 `{` 往后切会把同块里前面的声明当成选择器
 * （第一版就是这么错的 —— 判据抓出一堆不存在的违规）。`@media` 里因此也能拿到自己那条规则，
 * 而不是外层 `@media`。注释已先抹平，注释里写的 `.foo {` 例子骗不到它。
 */
function bareSizes(css: string): { sel: string; value: string }[] {
  const out: { sel: string; value: string }[] = [];
  for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?px);/g)) {
    const openAt = css.lastIndexOf("{", m.index);
    if (openAt < 0) continue;
    const head = css.slice(0, openAt);
    const cut = Math.max(head.lastIndexOf("}"), head.lastIndexOf("{"), head.lastIndexOf(";"));
    const sel = (
      head
        .slice(cut + 1)
        .split("\n")
        .pop() ?? ""
    ).trim();
    out.push({ sel, value: m[1] });
  }
  return out;
}

const violations = (): { file: string; sel: string; value: string }[] =>
  FILES.flatMap((f) =>
    bareSizes(cssOf(f))
      .filter((v) => !WHITELIST.some(([sel]) => v.sel.includes(sel)))
      .map((v) => ({ file: f, ...v })),
  );

describe("B337 UI 字阶", () => {
  it("五颗 token 都在 :root 里定义（值只写这一处）", () => {
    const root = cssOf("src/styles/global.css");
    for (const [name, value] of [
      ["--fs-meta", "11px"],
      ["--fs-ui", "12.5px"],
      ["--fs-input", "14px"],
      ["--fs-title", "15px"],
      ["--fs-hero", "20px"],
    ]) {
      expect(root, `缺 token：${name}: ${value}`).toContain(`${name}: ${value};`);
    }
  });

  it("标题/标签那颗 `--title-text-size` 引用 --fs-ui，不再自带数值", () => {
    const root = cssOf("src/styles/global.css");
    expect(root, "两处各写一份 12.5px = 迟早分家").toContain("--title-text-size: var(--fs-ui)");
  });

  it("chrome 的 CSS 里不许有裸 font-size（白名单以外）", () => {
    expect(
      violations(),
      `这些声明还写着裸数值，归到 --fs-meta / --fs-ui / --fs-input / --fs-title / --fs-hero`,
    ).toEqual([]);
  });

  it("自证：把一条已归档的声明退化成裸 13px，扫描必须抓到（防恒绿）", () => {
    const base = cssOf("src/styles/global.css");
    const hit = /\.popup-menu\s*\{[^}]*font-size:\s*var\(--fs-ui\)/.test(base);
    expect(hit, "前置条件：弹层菜单现在引用的是 --fs-ui").toBe(true);
    const degraded = base.replace(/(\.popup-menu\s*\{[^}]*font-size:\s*)var\(--fs-ui\)/, "$113px");
    const found = bareSizes(degraded).filter((v) => v.sel.includes(".popup-menu"));
    expect(found, "退化对照必须被抓到").toEqual([{ sel: ".popup-menu", value: "13px" }]);
  });

  it("13px 与 12px 这两档已经从文字尺寸里消失（并进 --fs-ui 是唯一有视觉变化的一步）", () => {
    // 白名单以外才算违规；图标那一族本就有自己的谱（`.explorer-twisty .codicon` 12px 是图标宽，
    // 不是字），所以这里读 `violations()` 而不是自己再筛一遍 `:root`。
    const live = violations();
    for (const gone of ["13px", "12px"]) {
      expect(
        live.filter((v) => v.value === gone).map((v) => `${v.file} ${v.sel}`),
        `${gone} 还挂在这些选择器上`,
      ).toEqual([]);
    }
  });

  it("每一处 `var(--fs-*)` 引用都必须在 :root 有定义（写错一档是静默回退，不会有任何报错）", () => {
    // 这一条是 token 化**自己带来**的新失效面：`font-size: var(--fs-titel)` 拼错一个字母，
    // 浏览器当这条声明无效 ⇒ 字号悄悄退回继承值，界面只是"某处字变大了/变小了"，
    // 而上面那几条判据全绿（它们只看裸数值和 token 定义处）。
    const defined = new Set(
      [...cssOf("src/styles/global.css").matchAll(/(--fs-[\w-]+)\s*:/g)].map((m) => m[1]),
    );
    expect([...defined].sort(), ":root 里的字阶档位").toEqual([
      "--fs-hero",
      "--fs-input",
      "--fs-meta",
      "--fs-title",
      "--fs-ui",
    ]);
    const dangling = FILES.flatMap((f) =>
      // 允许带兜底值（`var(--fs-ui, 12px)`）：兜底正是「写错档位时静默生效」的另一半，
      // 只匹配 `var(--x)` 整串会把这种写法漏在闸外。
      [...cssOf(f).matchAll(/var\(\s*(--fs-[\w-]+)/g)].map((m) => m[1]),
    ).filter((name) => !defined.has(name));
    expect(dangling, "这些引用找不到定义").toEqual([]);
    // 自证：把一处引用改成拼错的档位，扫描必须抓到（防恒绿）
    const degraded = cssOf("src/styles/global.css").replace(
      /\.popup-menu(\s*\{[^}]*font-size:\s*)var\(--fs-ui\)/,
      ".popup-menu$1var(--fs-titel)",
    );
    expect(degraded, "退化串要先自证真的改到了").not.toBe(cssOf("src/styles/global.css"));
    expect(
      [...degraded.matchAll(/var\(\s*(--fs-[\w-]+)/g)]
        .map((m) => m[1])
        .filter((n) => !defined.has(n)),
      "拼错的档位必须被抓到",
    ).toEqual(["--fs-titel"]);
  });
});
