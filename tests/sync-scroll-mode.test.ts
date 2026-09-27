// B152 · 「当前同一文件打开多份时，默认不关联光标和滚动位置，但当前打开文档如果存在
// 多个打开，则在标题栏文件名后面有一个按钮，点击切换为同步滚动模式，其他所有打开的
// 该文件的光标和滚动位置会自动随激活文档的值进行同步变化（切换激活文档时则根据新的
// 激活文档进行同步，且同步按钮状态不变，也就是一个文档有一个同步滚动状态）」
//
// B149 定的基线不变：**默认不关联**。联动是显式按下的结果，并且方向永远单向
// （激活文档 → 其它实例）—— 反向同步会让两份滚动互相拉扯，用户看到的就是抖。
//
// 全部盯在源码契约上（`src/main.ts` / `index.html` / `global.css`），与
// `tests/viewport-restore.test.ts` 同一路数：这套代码跑在 Tauri 里，jsdom 复现不了
// 「切标签 + 钉位置 + 兄弟实例」的真实时序，只有静态契约盯得住。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const main = readFileSync("src/main.ts", "utf-8");
const html = readFileSync("index.html", "utf-8");
const css = readFileSync("src/styles/global.css", "utf-8");

/** 抠出一段源码（按首尾标记切片）—— 段落格式会随排版变，标记要挑稳的。 */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i + from.length);
  expect(i, `找不到起点：${from}`).toBeGreaterThan(-1);
  expect(j, `找不到终点：${to}`).toBeGreaterThan(-1);
  return src.slice(i, j);
}

const SYNC_STATE = "const docSyncModes = new Map<number, boolean>();";
const PUSH_BODY = slice(main, "function pushSyncToSiblings(", "function showMessage(");
const BTN_BODY = slice(main, "function refreshSyncButton(", "function refreshStatus(");
const SRC_BODY = slice(main, "function isSyncSource(", "/** 这个实例此刻是否被某个面板");
const CLICK_BODY = slice(main, 'syncScrollBtn.addEventListener("click"', "sbLang.addEventListener");

describe("B152 同步滚动模式：按钮与状态", () => {
  it("按钮挂在标题栏的文档名后面，默认收起", () => {
    // 「在标题栏文件名后面有一个按钮」—— 位置就被钉死在这儿：#title-center 里、
    // #title-text 之后。挪进右侧工具键组就不叫「文件名后面」了。
    const center = slice(html, 'id="title-center"', 'class="title-actions"');
    expect(center, "按钮必须在 #title-center 内").toContain('id="sync-scroll"');
    expect(center.indexOf('id="title-text"'), "按钮要排在文档名之后").toBeLessThan(
      center.indexOf('id="sync-scroll"'),
    );
    // 默认收起：只开一份时标题栏干干净净，不该挂一颗点不动的键。
    expect(html, "初值必须 hidden").toMatch(/id="sync-scroll"[\s\S]{0,140}?\bhidden\b/);
    // 开关型控件：状态要报给读屏器，光靠配色等于没报。
    expect(html, "必须有 aria-pressed").toMatch(/id="sync-scroll"[\s\S]{0,300}?aria-pressed/);
  });

  it("显隐判据是「当前激活文档开着多份」", () => {
    // 只看「有没有文档」⇒ 单开也露脸，用户点下去什么也不会发生。
    expect(main, "显隐要按实例个数判").toMatch(
      /const multi = !!tab && instancesOfDoc\(tab\.docId\)\.length > 1;/,
    );
    expect(main, "无文档时要藏").toMatch(/syncScrollBtn\.hidden = !multi;/);
  });

  it("开关状态按**文档**记，切换激活文档时不复位", () => {
    expect(main, "状态容器要按文档（docId）记").toContain(SYNC_STATE);
    // 按 tab 记 ⇒ 切一下标签状态就没了，正是用户说的「同步按钮状态不变」要防的。
    expect(BTN_BODY, "亮灯要读那份文档自己的开关值").toMatch(
      /docSyncModes\.get\(tab\.docId\) === true/,
    );
    expect(BTN_BODY, "不得按 tabId 取").not.toMatch(/docSyncModes\.get\(tab\.tabId\)/);
    // 而且刷新按钮**不写**状态：写就得在切标签那几处手动补，漏一处就复位。
    expect(BTN_BODY, "刷新按钮只许读状态").not.toMatch(/docSyncModes\.set\(/);
  });

  it("方向是单向的：只有激活面板里激活的那一份才是源", () => {
    expect(SRC_BODY, "必须先确认同步已开启").toMatch(/docSyncModes\.get\(tab\.docId\) === true/);
    // 少认一条就会「非激活的那份也当源」，兄弟之间开始互相拉扯。
    expect(SRC_BODY, "要认激活面板").toMatch(/panel\.panelId === activePanelId/);
    expect(SRC_BODY, "要认激活标签").toMatch(/panel\.activeTabId === tab\.tabId/);
  });
});

describe("B152 同步滚动模式：推进与触发点", () => {
  it("推给兄弟的是光标 + 滚动位置（在线派发、离线改快照）", () => {
    expect(PUSH_BODY, "在线那份要派发选区").toMatch(
      /shownView\.dispatch\(\{ selection: \{ anchor: pos \} \}\)/,
    );
    expect(PUSH_BODY, "离线那份要改自己的快照").toMatch(
      /other\.state = other\.state\.update\(\{ selection: \{ anchor: pos \} \}\)\.state;/,
    );
    // 位置写进兄弟自己的记录必须走 recordScroll（B145 的唯一闸口）。
    expect(PUSH_BODY, "位置要走唯一闸口").toMatch(/recordScroll\(other\.tabId, px\);/);
  });

  it("纯预览实例只跟光标，不把编辑器像素塞进预览槽", () => {
    const guard = `if (px === null || other.viewMode === "preview") continue;`;
    expect(PUSH_BODY, "预览态要跳过位置同步").toContain(guard);
    // ⚠️ 顺序也要盯：这条 continue 必须排在 recordScroll 之前 —— 反了就把编辑器侧的
    //    px 写进「预览那一侧」的槽（B129 的语义），切回源码时位置就错了。
    //    两个下标都要先自证存在，否则「找不到 = -1」会让顺序比较永远成立（假绿）。
    const g = PUSH_BODY.indexOf(guard);
    const r = PUSH_BODY.indexOf("recordScroll(other.tabId");
    expect(g).toBeGreaterThan(-1);
    expect(r).toBeGreaterThan(-1);
    expect(g, "跳过要写在写记录之前").toBeLessThan(r);
  });

  it("钉兄弟的 DOM 要套还原窗口（否则那发 scroll 会被记成用户停过的位置）", () => {
    expect(PUSH_BODY, "要套 restoringViewport").toMatch(
      /restoringViewport\(other\.tabId, \(\) => pinScrollTop\(/,
    );
  });

  it("默认关闭：不按下就各归各的（B149 基线不变）", () => {
    expect(PUSH_BODY, "开关没开就别推").toMatch(
      /docSyncModes\.get\(src\.docId\) !== true\) return;/,
    );
  });

  it("四个触发点都在：光标/编辑、用户滚动、切激活文档、全局刷新", () => {
    expect(main, "光标与编辑之后要推").toMatch(
      /if \(isSyncSource\(tab, panel\)\) pushSyncToSiblings\(tab\);/,
    );
    expect(main, "用户滚动之后要推").toMatch(
      /if \(t && isSyncSource\(t, p\)\) pushSyncToSiblings\(t\);/,
    );
    // 「切换激活文档时则根据新的激活文档进行同步」—— 这一句就落在 switchTab 末尾。
    expect(main, "切激活文档后要按新源推").toMatch(/if \(tab\) pushSyncToSiblings\(tab\);/);
    expect(main, "全局刷新兜底（新出现的那一份要对齐）").toMatch(/const act = activeTab\(\);/);
  });

  it("点开的那一刻就推一次，不用等用户再滚一下", () => {
    expect(CLICK_BODY, "点击要先改状态").toMatch(/docSyncModes\.set\(tab\.docId, on\);/);
    expect(CLICK_BODY, "开启后立刻推").toMatch(/if \(on\) pushSyncToSiblings\(tab\);/);
    expect(CLICK_BODY, "要顺手刷新按钮（点亮态 + 提示）").toMatch(/refreshSyncButton\(tab\);/);
  });
});

describe("B152 样式：hidden 必须显式生效", () => {
  it(".title-btn 那条共用声明压过 UA 的 [hidden]，所以得自己补一条", () => {
    expect(css, "必须有 .sync-btn[hidden]").toMatch(
      /\.sync-btn\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    );
    expect(css, "按钮不许被 .title-btn 的 inline-flex 撑开占位").toMatch(/\.sync-btn \{/);
  });
});

// ------------------------------------------------------- 反向验证
// 把上面的实现退回两种错的写法，对应用例必须变红 —— 否则「改了等于没改」，
// 静态契约就会变成假绿（viewport-restore / session-scroll-integral 各自栽过一次）。
describe("B152 字形：常量，启动时给一次", () => {
  it("字形取 sync，别跟右上角更新键的 refresh 撞形", () => {
    // 标题栏里两颗一样的圆箭头，用户分不清哪个管滚动、哪个管升级。
    expect(main, "字形要取 sync").toMatch(/syncScrollBtn\.innerHTML = CODICONS\.sync;/);
    const cod = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(cod, "sync 字形要在取用层登记").toMatch(/^\s*sync: "sync",/m);
  });

  it("refreshSyncButton 只管显隐，字形不跟着标题刷新重设", () => {
    // 图标是常量，每次刷新标题都重设 innerHTML 是白费功夫，还白打断一次重排。
    expect(BTN_BODY, "refreshSyncButton 不许碰 innerHTML").not.toContain("innerHTML");
    const setup = slice(main, "function setupTitleBar(", "\nfunction ");
    expect(setup, "字形要落在启动那批里").toContain("syncScrollBtn.innerHTML = CODICONS.sync;");
  });
});

describe("B152 反向验证：退回旧写法，上面那几条必须变红", () => {
  it("退回「单开一份也露脸」→ 显隐那两条必须落空", () => {
    const ORIG = "const multi = !!tab && instancesOfDoc(tab.docId).length > 1;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    // 只留「有没有文档」这一半 —— 判据里那个实例数比较被删掉了。
    const degraded = main.replace(ORIG, "const multi = !!tab;");
    expect(degraded, "退化后不该再有实例数判据").not.toContain(ORIG);
    expect(degraded, "「显隐要按实例个数判」此时必须落空").not.toMatch(
      /const multi = !!tab && instancesOfDoc\(tab\.docId\)\.length > 1;/,
    );
  });

  it("退回「按 tabId 记状态」→ 「切换激活文档不复位」必须落空", () => {
    const ORIG = "const on = docSyncModes.get(tab.docId) === true;";
    expect(BTN_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "const on = docSyncModes.get(tab.tabId) === true;");
    const body = slice(degraded, "function refreshSyncButton(", "function refreshStatus(");
    expect(body, "退化后亮灯按 tab 取 ⇒ 切一下就复位").not.toMatch(
      /docSyncModes\.get\(tab\.docId\) === true/,
    );
  });

  it("退回「直接写兄弟的 scrollTop，绕过唯一闸口」→ 位置那条必须落空", () => {
    const ORIG = "recordScroll(other.tabId, px);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "other.scrollTop = px;");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "绕过 recordScroll 的写法要被抓到").not.toMatch(/recordScroll\(other\.tabId/);
  });

  it("删掉「预览态跳过位置」那句 → 顺序那条必须落空", () => {
    const ORIG = `if (px === null || other.viewMode === "preview") continue;`;
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "删掉后就不该再有这句子").not.toContain(ORIG);
  });

  it("退回「钉兄弟的 DOM 不套还原窗口」→ 那条必须落空", () => {
    const ORIG = "restoringViewport(other.tabId, () => pinScrollTop(shownView.scrollDOM, px));";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "pinScrollTop(shownView.scrollDOM, px);");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "裸钉的写法要被抓到").not.toMatch(/restoringViewport\(other\.tabId/);
  });

  it("退回「用 refresh 字形」→ 撞形那条必须落空", () => {
    const ORIG = "syncScrollBtn.innerHTML = CODICONS.sync;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "syncScrollBtn.innerHTML = CODICONS.refresh;");
    expect(degraded, "退回 refresh 就跟更新键撞形了").not.toMatch(
      /syncScrollBtn\.innerHTML = CODICONS\.sync;/,
    );
  });

  it("把字形挪回 refreshSyncButton → 「只管显隐」那条必须落空", () => {
    const ORIG = "  syncScrollBtn.innerHTML = CODICONS.sync;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main
      .replace(ORIG, "")
      .replace(
        "function refreshSyncButton(tab: Tab | undefined): void {",
        "function refreshSyncButton(tab: Tab | undefined): void {\n  syncScrollBtn.innerHTML = CODICONS.sync;",
      );
    const body = slice(degraded, "function refreshSyncButton(", "function refreshStatus(");
    expect(body, "挪过去后它就碰 innerHTML 了").toContain("innerHTML");
    expect(
      slice(degraded, "function setupTitleBar(", "\nfunction "),
      "启动那批里就没这条了",
    ).not.toContain(ORIG.trim());
  });

  it("删掉 .sync-btn[hidden] → 样式那条必须落空", () => {
    const degraded = css.replace(/\.sync-btn\[hidden\]\s*\{\s*display:\s*none;\s*\}/, "");
    expect(degraded, "删掉后不该还有这条规则").not.toMatch(/\.sync-btn\[hidden\]/);
  });
});
