// B152 · 「当前同一文件打开多份时，默认不关联光标和滚动位置，但当前打开文档如果存在
// 多个打开，则在标题栏文件名后面有一个按钮，点击切换为同步滚动模式，其他所有打开的
// 该文件的光标和滚动位置会自动随激活文档的值进行同步变化（切换激活文档时则根据新的
// 激活文档进行同步，且同步按钮状态不变，也就是一个文档有一个同步滚动状态）」
//
// B149 定的基线不变：**默认不关联**。联动是显式按下的结果。
//
// B154 起触发面又放宽了两处（用户原话：「窗口没有激活时鼠标放在一个视口中也能进行
// 滚动，这时同步滚动也要能生效」「就算一个预览一个源码，同步滚动也要生效」）：
//   · **位置**同步不再要求「源是激活面板的激活标签」—— 谁滚谁当源，鼠标没点过的
//     视口也能带着兄弟走；回环改由 scroll-guard 的 `isProgrammatic` 标记自限
//     （B170 那套，不赌时序、不靠还原窗口），不再靠「只有激活的那份能当源」。
//   · **光标**那一半仍是单源（`isSyncSource`）—— 选区互推会互相抢，而移动鼠标
//     并不改变激活面板。
//   · **跨视图模式**（一个源码 / 一个预览）也要联动：坐标按「源显示在哪一侧」取、
//     按「兄弟显示在哪一侧」落，中间那次顶行⇄行号换算是唯一允许的两种坐标系。
//
// 全部盯在源码契约上（`src/main.ts` / `index.html` / `global.css`），与
// `tests/viewport-restore.test.ts` 同一路数：这套代码跑在 Tauri 里，jsdom 复现不了
// 「切标签 + 钉位置 + 兄弟实例」的真实时序，只有静态契约盯得住。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tabsAll, sessionAll } from "./static";

// ⚠️ 归一换行：下面的契约字面量 / 正则都按 LF 写。仓库里存的是 LF，但**工作副本被翻成
// CRLF** 会一次性打掉一大片断言（`topLevelFnBody` 认 `\n}` 后的那个字符是 `\n`，CRLF 下
// 是 `\r`，函数体直接抠成空串）。这里先归一，是防那类「改一个字节红一大片」的复发。
const main = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");
// 标签/面板/布局簇（switchTab / 滚动监听 / closeTabById…）已拆到 src/tabs/ 四子模块（P3）。
// ⚠️ 只把「定义已迁走」的切片指到 tabsSrc，别整份拼进 main —— 跨文件的 indexOf 顺序比较
//    会全部失真（收口/换页/测量的先后闸全在函数体内部，必须同文件内才有意义）。
//    ⚠️ tabsAll = render+lifecycle+split+deps 拼接：indexOf 顺序闸只许比**同一子模块内**
//       的两个锚点（switchTab / rebuildLayout / closeTabById 的内部闸都在 lifecycle 里）。
const tabsSrc = tabsAll();
// Markdown 预览簇（toggleViewMode / openPreviewToSide / applyPanelMode…）已拆到 markdown.ts（解耦第九步）。
const mdSrc = readFileSync("src/markdown.ts", "utf-8").replace(/\r\n/g, "\n");
// 大纲 TOC / 侧栏簇（updateTocDrawer…）已拆到 toc.ts（解耦第十步）。
const tocSrc = readFileSync("src/toc.ts", "utf-8").replace(/\r\n/g, "\n");
// 会话 / 自动保存 / 热退出簇（refreshSession / restoreSession…）已拆到 src/session/ persist+rebuild（P3-b）。
const sessSrc = sessionAll();
// 多窗口 / 卫星 / 跨窗口同步簇（applySyncMode…）已拆到 multiwindow/windows.ts（解耦第十四步）。
const mwSrc = readFileSync("src/multiwindow/windows.ts", "utf-8").replace(/\r\n/g, "\n");
const main2 = readFileSync("src/sync-scroll.ts", "utf-8").replace(/\r\n/g, "\n");
const main3 = readFileSync("src/core/app-state.ts", "utf-8").replace(/\r\n/g, "\n");
// 命令层（编辑菜单/折叠/转到行/查看档位/标题栏+菜单栏装配…）已拆到 commands.ts（解耦第十七步 / #416-3）。
const commandsSrc = readFileSync("src/commands.ts", "utf-8").replace(/\r\n/g, "\n");
const main4 = readFileSync("src/core/viewport.ts", "utf-8").replace(/\r\n/g, "\n");
const main5 = readFileSync("src/core/events.ts", "utf-8").replace(/\r\n/g, "\n");
const main6 = readFileSync("src/core/panels.ts", "utf-8").replace(/\r\n/g, "\n");
const html = readFileSync("index.html", "utf-8").replace(/\r\n/g, "\n");
const css = readFileSync("src/styles/global.css", "utf-8").replace(/\r\n/g, "\n");
const PREVIEW_TS = readFileSync("src/markdown/preview.ts", "utf-8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/ui.ts", "utf-8").replace(/\r\n/g, "\n");

/** 编辑器滚动监听那条（含它前面那几行自限守卫）—— 与下面几条同一段切片。 */
function scrollBodyOf(src: string): string {
  return slice(src, 'shownView.scrollDOM.addEventListener("scroll"', "attachPasteHandler(p);");
}

/** 抠出一段源码（按首尾标记切片）—— 段落格式会随排版变，标记要挑稳的。 */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i + from.length);
  expect(i, `找不到起点：${from}`).toBeGreaterThan(-1);
  expect(j, `找不到终点：${to}`).toBeGreaterThan(-1);
  return src.slice(i, j);
}

const SYNC_STATE = "const docSyncModes = new Map<number, boolean>();";
// ⚠️ B159 起这段里有三个函数（`applySyncToSibling` / `broadcastSyncPos` /
//    `pushSyncToSiblings`）—— 位置落兄弟那几条纪律抽进了前两个，切片必须从最上面那个
//    起头，否则下面那些「预览分支要写在 px 直推之前」的判据会静默失配（切片为空）。
const PUSH_BODY = slice(main2, "function applySyncToSibling(", "function flushPendingSyncCursor(");
// ⚠️ B251：`PUSH_BODY`（落点函数 + 推兄弟 + 广播）与 `pushSyncToSiblings` 现在是**两段**，
//    契约要看的是各自的落点/取坐标那一处，全段扫会把「谁取坐标」和「往哪落」搅在一起，
//    于是下面几条判据要么找不到锚点、要么锚在对方身上（退化照样绿）。分开各切一份。
/** 「往兄弟身上落位置」那一段（`applySyncToSibling` 全函数）。 */
function applyBody(): string {
  return slice(main2, "function applySyncToSibling(", "function syncSourceSnapshot(");
}
/** 「从源身上取坐标再往兄弟落」那一段（`pushSyncToSiblings` 全函数）。 */
function pushBody(): string {
  return slice(main2, "function pushSyncToSiblings(", "function flushPendingSyncCursor(");
}
// ⚠️ B251 新增两份切片：统一游标之后，「游标→像素」与「像素→游标」各自只剩一个出口，
//    判据（尤其是退化串）得能盯到**那一个函数**身上 —— 全段扫会把「谁取坐标」与
//    「往哪落」搅在一起，退化掉哪一边都照样命中（B163 同型）。
/** 「游标 → 编辑器像素」的唯一换算出口（`sourceTopOfV`）。 */
const SOURCE_TOP = slice(main2, "function sourceTopOfV(", "function syncSourceV(");
/** 「同步坐标的唯一取值口」（`syncSourceV`）—— 跟随 / 收口 / 交接三条路都经它。 */
const SYNC_V = slice(main2, "function syncSourceV(", "function rememberViewScroll(");
const BTN_BODY = slice(ui, "function refreshSyncButton(", "function refreshStatus(");
const SRC_BODY = slice(main2, "function isSyncSource(", "function applySyncToSibling(");
// ⚠️ B233：终点原本是紧邻的 `sbLang.addEventListener`，而那句已随「状态栏语言项
//    纯展示化」删除 ⇒ 换成它后面那句 `sbEncoding.addEventListener`（仍是紧邻的下一句）。
//    锚点失效时 slice 会静默返回空串，判据全绿 —— 换锚点后务必回读确认非空。
const CLICK_BODY = slice(
  main,
  'syncScrollBtn.addEventListener("click"',
  'sbEncoding.addEventListener("click"',
);
const PIN_BODY = main4.slice(main4.indexOf("function pinScrollTop("));
// 大纲 onJump：跳转定位逻辑（受同步滚动状态约束的那一段）—— 与 B152 同路数，盯静态契约。
// updateTocDrawer 已拆到 toc.ts（解耦第十步）且是该文件最后一个函数，
// 终锚用文件尾的 export 块（main 里那个「导出」横幅已不在同一文件）。
const ONJUMP_BODY = slice(tocSrc, "onJump: (entry) => {", "\nexport {");

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

  it("显隐判据是「当前激活文档开着多份」—— 两个窗口同口径，只数本窗口**可见**实例（B171/B173）", () => {
    // 只看「有没有文档」⇒ 单开也露脸，用户点下去什么也不会发生。
    expect(BTN_BODY, "显隐要按可见实例个数判").toMatch(
      /visibleInstancesOfDoc\(tab\.docId\)\.length > 1/,
    );
    expect(BTN_BODY, "无文档时要藏").toMatch(/syncScrollBtn\.hidden = !multi;/);
    // B171：B164 曾给子窗口开后门（额外认「这份文档在别的窗口也有」），于是同文件
    // 只开一份时子窗口露脸、主窗口却藏着 —— 口径不一致。现在一律只数本窗口实例。
    expect(BTN_BODY, "显隐不许再掺跨窗口的共享集合").not.toMatch(/sharedDocIds/);
    // B173：连本窗口的隐藏实例（`panelId < 0`）也不许算一份。
    expect(main6, "隐藏实例要被滤掉").toMatch(
      /function visibleInstancesOfDoc\(docId: number\): Tab\[\] \{\s*\n\s*return instancesOfDoc\(docId\)\.filter\(\(t\) => t\.panelId >= 0\);/,
    );
  });

  it("开关状态按**文档**记，切换激活文档时不复位", () => {
    expect(main3, "状态容器要按文档（docId）记").toContain(SYNC_STATE);
    // 按 tab 记 ⇒ 切一下标签状态就没了，正是用户说的「同步按钮状态不变」要防的。
    expect(BTN_BODY, "亮灯要读那份文档自己的开关值").toMatch(
      /docSyncModes\.get\(tab\.docId\) === true/,
    );
    expect(BTN_BODY, "不得按 tabId 取").not.toMatch(/docSyncModes\.get\(tab\.tabId\)/);
    // 而且刷新按钮**不写**状态：写就得在切标签那几处手动补，漏一处就复位。
    expect(BTN_BODY, "刷新按钮只许读状态").not.toMatch(/docSyncModes\.set\(/);
  });

  it("光标那一半仍是单向的：只有激活面板里激活的那一份才是源", () => {
    // ⚠️ B154 只在**位置**那一半放宽了「谁当源」，光标这半边不动：选区互推会互相抢，
    //    而移动鼠标并不改变激活面板，非激活那份的光标本来就是被同步推过去的结果。
    expect(SRC_BODY, "必须先确认同步已开启").toMatch(/docSyncModes\.get\(tab\.docId\) === true/);
    // 少认一条就会「非激活的那份也当源」，兄弟之间开始互相拉扯。
    expect(SRC_BODY, "要认激活面板").toMatch(/panel\.panelId === activePanelId/);
    expect(SRC_BODY, "要认激活标签").toMatch(/panel\.activeTabId === tab\.tabId/);
    // 它只剩光标这一半的闸门：位置那两条滚动监听不许再挂这个前置。
    // ⚠️ 判据里带括号 —— 源码那段的注释里也提到这个名字，只认字面会连注释一起命中。
    const scroll = slice(
      tabsSrc,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(scroll, "编辑器滚动监听不许再要求源是激活的").not.toMatch(/isSyncSource\(/);
  });
});

// ------------------------------------------------------- B154：同步的触发面
describe("B154 同步滚动：跨视图模式与「谁滚谁当源」", () => {
  it("预览态兄弟按**行**定位，不把编辑器像素塞进预览槽", () => {
    const guard = '  if (other.viewMode === "preview") {';
    expect(PUSH_BODY, "预览态要走专门的分支").toContain(guard);
    // 换算出来的这一笔也必须走唯一闸口，且值取的是**预览容器自己的实际落点**
    // （B240 三轮：由 `applySyncToLine` 交回来；值仍是预览那一侧的像素，口径没变 ——
    //    「没落地就别记」是同一件事的另一种写法：写进去的必须是真落点，不是容器里的 0）。
    expect(PUSH_BODY, "预览兄弟的位置也要走记录闸口").toMatch(
      /if \(landed !== null\) recordScroll\(other\.tabId, landed\);/,
    );
    // ⚠️ 顺序：预览分支必须排在**统一落点**那条之前 —— 反了预览那一路就会把编辑器像素
    //    当成落点写进预览槽（B129 的语义 / B129 那条反向闸锁的正是这层）。
    //    ⚠️ B251：B240 那会儿的「px 直推」已经并进统一分支（落点一律由 `sourceTopOfV`
    //    换算出来 ⇒ 不再存在「编辑器 px 直通」这一格），顺序判据随之下移到那一处。
    const g = PUSH_BODY.indexOf(guard);
    const r = PUSH_BODY.indexOf("recordScroll(other.tabId, top);");
    expect(g).toBeGreaterThan(-1);
    expect(r, "统一落点那笔也要在（源码→源码那一格）").toBeGreaterThan(-1);
    expect(g, "预览分支要写在统一落点之前").toBeLessThan(r);
  });

  it("预览态的槽是预览像素，不能被当成编辑器像素拿去推源码兄弟", () => {
    // 这是「一个预览一个源码」原先不生效的根因之一：源在预览里时 `src.scrollTop`
    // 装的是预览像素，直接拿去 pin 兄弟的编辑器，落点必然是错的。
    //
    // ⚠️ B251：红线没动，只换了守的地方 —— 推兄弟那一侧现在**根本不取 px**
    //    （`pushSyncToSiblings` 只从 `syncSourceV` 拿规范游标 `v`），所以判据从
    //    「源是预览态 ⇒ px 恒 null」上移到**落点那一条**：预览态兄弟只认行、且 `v` 取不到
    //    或没有预览容器时不许写槽。
    expect(applyBody(), "预览态兄弟只认行，v 取不到 / 没容器就不落").toContain(
      "if (v === null || !shown?.preview) return;",
    );
    // ⚠️ 反向闸：不许再走「编辑器像素直通」那条死路（把预览像素当编辑器像素钉兄弟）。
    //    判据带调用形态，扫的是**应用函数体里的落点**，不是注释里复述的同一句。
    expect(applyBody(), "不许再把源那侧的像素当落点").not.toMatch(
      /recordScroll\(other\.tabId, (px|src\.scrollTop)\)/,
    );
    // 正向：源码侧那一支（现在统一在 `applySyncToSibling` 里）落点由 `sourceTopOfV` 换算，
    //    ⚠️ 反面判据：直接读 `src.scrollTop` 当主取值会让落点成了**上一次**的位置
    //    （B240 二轮实测：真实 260 时只推出 100，离屏兄弟的槽被写脏）。
    expect(applyBody(), "源码侧落点要按游标换算，不是拿源那侧的像素").toContain(
      "sourceTopOfV(view, v);",
    );
    // ⚠️ B251 换锚：这条 RD 现在挂在**唯一取值口** `syncSourceV` 上 —— 「源显示在哪一侧
    //    就取哪一侧」这个判断在全文件里**只此一处**（跟随 / 收口 / 交接都经它），旧写法
    //    是散在 `pushSyncToSiblings` 里的局部三元 ⇒ 判据从 `applyBody` 上移到取值口。
    // ⚠️ 判据带完整结构（预览分支整块 + 走预览那侧几何的 return 一整条）：只写
    //    `t.viewMode === "preview"` 会连 `syncSourceSnapshot` 里那句同形的判空一起命中，
    //    退化打不掉就变假绿。B288④ 后预览分支扩成块（先未测量守卫、再走预览几何），
    //    故判据要覆盖「`if (...) preview` 块内确实有 `return p?.preview?.topVisibleLine()`」。
    expect(SYNC_V, "源那侧要先认出预览容器（源是预览就走预览那侧）").toMatch(
      /if \(t\.viewMode === "preview"\) \{[\s\S]*?return p\?\.preview\?\.topVisibleLine\(\) \?\? null;/,
    );
    // ⚠️⚠️ B257 翻案：这两条以前是「跨侧只交整数块首 / 同侧才交完整 `v`」的**跨侧档**
    //    （B251 立的，本轮撤掉）。撤它的理由（自测台 `tests/sync-stability.test.ts` 实测）：
    //      源码停 287（走了一行的一半）⇒ 切模式一来一回变成 280（丢了半个行高）；
    //      预览停 847（走了一块 1/6）⇒ 切标签一轮变成 840（丢了 1/6 块高）。
    //    每跨一次侧吃掉一格比例，来回切就是「位置越来越歪」—— 用户报的「有些偏移的小问题」。
    //    ⚠️ 立论本来就站不住：`topVisibleLine()` 读是 `start + ratio × range`（×range 把
    //      块高折回**行**）、`applySyncToLine` 写是 `into / range`（除回去），**乘除抵消**
    //      ⇒ 两边小数是同一个「走了一格多少」的量，不是「块高比例 vs 行高比例」两回事。
    //    ⇒ 现在**只有一档**：一律交完整 `v`；下面三条反向闸就是防它再退回去。
    expect(SYNC_V, "源是预览 ⇒ 取预览那一行号（带块内比例的小数）").toContain(
      "return p?.preview?.topVisibleLine() ?? null;",
    );
    expect(SYNC_V, "不许退回 cross 档（跨侧丢小数 = 每切一次丢一格比例）").not.toMatch(
      /syncSourceV\(t: Tab \| undefined, cross/,
    );
    expect(SYNC_V, "预览侧不许退回整数块首（旧版跨侧那一档）").not.toMatch(
      /p\?\.preview\?\.topBlockStartLine\(\)/,
    );
    expect(SYNC_V, "源码侧不许退回 Math.floor 成整数顶行（旧版跨侧那一档）").not.toMatch(
      /Math\.floor\(topVisibleLineFrac/,
    );
    // ⚠️ B251 → B257：跟随里 `v` 是**逐个兄弟现取**的（每份兄弟自己问一次源停在哪一侧），
    //    不再是一个 `v` 推全场（旧的 `cross` 档按「源与目标是否分处两侧」现算要不要丢小数）。
    //    只写 `syncSourceV(` 会连收口 / 交接里那两处一起命中，退化打不掉 ⇒ 必须带调用形态。
    // ⚠️⚠️ 反向闸（本轮翻案，钉死「跨侧是相对关系」）：跨侧问的是**源与目标是否分处
    //    两侧**，所以判据必须拿**源**去比。历史错相是 `other.viewMode !== "preview"` ——
    //    那是「目标**是不是**预览」的绝对判断，冒充不了跨不跨侧，四格里错两格：
    //      · 源源码 + 兄弟预览 ⇒ 被判成同侧 ⇒ 交**行内比例**小数 ⇒ 预览按**块高**插值 ⇒
    //        恒偏下（用户复现：滚左分屏源码到底 → 切预览 → 切回源码，第二次切换右分屏
    //        预览向上偏移）；
    //      · 源预览 + 兄弟源码 ⇒ 被判成同侧 ⇒ 交**块内比例**小数 ⇒ 源码按**行高**插值 ⇒
    //        恒偏上（「切 tab 越切越靠顶」那一半病根，一直没修到这）；
    //      只有「源预览 + 兄弟预览」这格蒙对（目标恰好是预览）。
    //    退化方向：把这个 absolute 形式写回去 ⇒ 本闸红。
    expect(pushBody(), "跨侧判据不许退回「目标是不是预览」的绝对判断（跨侧得拿源比）").not.toMatch(
      /syncSourceV\(src, other\.viewMode !==/,
    );
    //    （收口那处不需要同型反向闸：那条正向断言钉的是**完整关系串**，退成绝对
    //    判断必然落空；再加一条只是恒真的冗余。）
    // ⚠️ B257：跟随逐兄弟现取，但**不再按跨侧丢小数** ⇒ 每个兄弟拿的都是同一个完整 `v`。
    //    只写 `syncSourceV(` 会连收口 / 交接里那两处一起命中，退化打不掉 ⇒ 必须带调用形态。
    expect(pushBody(), "跟随逐兄弟取值：每份兄弟都现取一次完整 `v`").toContain(
      "const v = syncSourceV(src);",
    );
    expect(pushBody(), "不许退回 cross 档（旧版按跨侧丢整数块首 / 整数顶行）").not.toMatch(
      /syncSourceV\(src, /,
    );
    expect(pushBody(), "源码侧坐标走带行内比例的小数（B174：取整会让跟随变阶梯）").toMatch(
      /topVisibleLineFrac/,
    );
  });

  it("唯一取值口只从源**当前显示的那一侧**取（不许拿双语义槽当游标）", () => {
    // ⚠️ B251 新增：跟随 / 切标签收口 / 切模式交接三条路都经 `syncSourceV` 取 `v`，于是
    //    「源显示在哪一侧」这个判断在本文件里**只剩这一处** —— 它错一处，三条路同时错。
    //    判据钉住两个分支各自走哪一侧的几何，并锁死「不许拿快照槽当游标」那一面
    //    （`t.scrollTop` 是双语义槽：源码侧存编辑器像素、预览侧存预览像素）。
    // ⚠️⚠️ B257：这里原本钉的是「跨侧 / 同侧两条分支」(`cross` 一档分出来)，本轮合回一条
    //    —— 跨侧**照交完整 `v`**（见上一处翻案：读 ×range / 写 /range 抵消，小数是同一个量，
    //    丢掉就是每切一次丢一格比例）。下面正向钉「两侧各走哪一份几何」，反向闸钉
    //    「不许再分这两档」。
    expect(SYNC_V, "源是预览 ⇒ 取预览那一行号（小数 = 走了一块多少）").toContain(
      "return p?.preview?.topVisibleLine() ?? null;",
    );
    expect(SYNC_V, "源是源码 ⇒ 交 `topVisibleLineFrac`（小数 = 走了一行多少）").toContain(
      "return topVisibleLineFrac(view, sourceCursorPx(t, view));",
    );
    expect(SYNC_V, "不许再分跨侧 / 同侧两档（cross 那一个对象已删）").not.toMatch(
      /return cross \?/,
    );
    // ⚠️ 反向闸排前面：直接读实时 DOM（`topVisibleLineFrac(view, view.scrollDOM.scrollTop)`
    //    —— 既不走 `sourceCursorPx` 也不看 cross）是漏修那一版：真机上还原刚写完、被浏览器
    //    裁小那一帧，补推拿到的是偏小的像素 ⇒ 同文档预览兄弟被往上拖（B256，真机 1421→1043）。
    expect(SYNC_V, "源码侧不许直接读实时 DOM（还原没立住那一帧会把游标带歪）").not.toMatch(
      /topVisibleLineFrac\(view, view\.scrollDOM\.scrollTop\)/,
    );
    expect(
      SYNC_V,
      "源码侧取像素必须走 sourceCursorPx（DOM 与这份标签自己的槽不一致时按槽算）",
    ).toContain("sourceCursorPx(t, view)");
    // ⚠️ 反向闸排在正向之后也有效：B240 二轮实测「读快照槽 ⇒ 真实 260 只推出 100」，
    //    离屏兄弟的槽被写脏 ⇒ 用户报「未激活标签切过去对不上」。
    expect(SYNC_V, "双语义槽不许当游标（那会推出上一次的位置）").not.toMatch(
      /return (t|src)\.scrollTop/,
    );
  });

  it("两条滚动监听都是「谁滚谁当源」，不再要求源是激活的那份", () => {
    const scroll = slice(
      tabsSrc,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(scroll, "编辑器里滚要推兄弟").toMatch(/\n\s*if \(t\) pushSyncToSiblings\(t, true\);\n/);
    // ⚠️ 判据里带括号：那段的注释也提到这个名字，只认字面会连注释一起命中（假绿）。
    expect(scroll, "这条不许再挂 isSyncSource 前置").not.toMatch(/isSyncSource\(/);
    // 预览容器那条：程序摆位的回执由 `isProgrammatic(preview.root)` 吞掉（不推兄弟），
    // 真用户滚动才到推兄弟那一句——守卫必须排在推同步之前。
    const prev = slice(tabsSrc, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    expect(prev, "预览里滚也要推兄弟").toMatch(/^\s*pushSyncToSiblings\(t, true\);/m);
    const atGuard = prev.indexOf("if (isProgrammatic(preview.root))");
    const atPush = prev.indexOf("pushSyncToSiblings(t, true)");
    expect(atGuard, "要能定位程序回执守卫").toBeGreaterThan(-1);
    expect(atPush, "要能定位推同步那句").toBeGreaterThan(-1);
    expect(atPush, "推同步要排在守卫之后（否则回环闸门形同虚设）").toBeGreaterThan(atGuard);
  });

  it("位置同步的回环闸门：程序回执守卫仍在编辑器监听首段，且排在推兄弟之前", () => {
    // 「谁滚谁当源」的代价是少了一道天然闸门，回环全靠 scroll-guard 的 `isProgrammatic`
    // 标记 —— 程序钉位置的回执在更前面就被吞掉，到不了推兄弟那一路。少这一道就是抖动。
    const scroll = scrollBodyOf(tabsSrc);
    expect(scroll, "程序滚动期间不许推").toMatch(
      /if \(isProgrammatic\(shownView\.scrollDOM\)\) return;/,
    );
    const atGuard = scroll.indexOf("if (isProgrammatic(shownView.scrollDOM)) return;");
    const atPush = scroll.indexOf("pushSyncToSiblings(t, true)");
    expect(atGuard, "要能定位程序回执守卫").toBeGreaterThan(-1);
    expect(atPush, "要能定位推同步那句").toBeGreaterThan(-1);
    expect(atPush, "推同步要排在守卫之后（否则回环闸门形同虚设）").toBeGreaterThan(atGuard);
  });
});

describe("B152 同步滚动模式：推进与触发点", () => {
  it("推给兄弟的是光标 + 滚动位置（在线派发、离线改快照）", () => {
    // ⚠️ B167 起这里多了 `scrollIntoView: false` —— CM6 的自动滚动会晚一帧落地，
    //    那发 scroll 落在还原窗口之外，会被当成用户滚动推回源（抖动根因）。
    expect(PUSH_BODY, "在线那份要派发选区（且不许自带滚动）").toMatch(
      /shownView\.dispatch\(\{ selection: \{ anchor: pos \}, scrollIntoView: false \}\)/,
    );
    expect(PUSH_BODY, "离线那份要改自己的快照").toMatch(
      /other\.state = other\.state\.update\(\{ selection: \{ anchor: pos \} \}\)\.state;/,
    );
    // 位置写进兄弟自己的记录必须走 recordScroll（B145 的唯一闸口）。
    // ⚠️ B251 换锚：落点现在是 `sourceTopOfV` 换算出来的 `top`，不再是 px 直通。
    expect(PUSH_BODY, "位置要走唯一闸口").toMatch(/recordScroll\(other\.tabId, top\);/);
  });

  it("离屏的预览实例不写任何位置（否则就是拿编辑器像素污染预览槽）", () => {
    const guard = "if (v === null || !shown?.preview) return;";
    expect(PUSH_BODY, "离屏预览兄弟要跳过").toContain(guard);
    // ⚠️ 顺序也要盯：这条跳过必须排在 recordScroll 之前 —— 反了就把编辑器侧的
    //    px 写进「预览那一侧」的槽（B129 的语义），切回源码时位置就错了。
    //    两个下标都要先自证存在，否则「找不到 = -1」会让顺序比较永远成立（假绿）。
    const g = PUSH_BODY.indexOf(guard);
    const r = PUSH_BODY.indexOf("recordScroll(other.tabId, top)");
    expect(g).toBeGreaterThan(-1);
    expect(r).toBeGreaterThan(-1);
    expect(g, "跳过要写在写记录之前").toBeLessThan(r);
  });

  it("钉兄弟的 DOM 要走 pinScrollTop（内部标程序来源，回执被吞）而非裸写 scrollTop", () => {
    // B170：程序钉位置若直接写 `scrollDOM.scrollTop` 而不经 `pinScrollTop`，那一下不会被
    // 标成程序来源，回执落到编辑器监听就被记成「用户停过的位置」再反推回源 —— 拉锯。
    // `pinScrollTop` 内部 `markProgrammatic` 把来源标好，回执由监听经 scroll-guard 吞掉，
    // 不再套 `restoringViewport` 还原窗口（B170 删了那套时间窗）。
    expect(PUSH_BODY, "统一分支要走 pinScrollTop").toMatch(
      /pinScrollTop\(shownView\.scrollDOM, top\);/,
    );
  });

  it("默认关闭：不按下就各归各的（B149 基线不变）", () => {
    expect(PUSH_BODY, "开关没开就别推").toMatch(
      /docSyncModes\.get\(src\.docId\) !== true\) return;/,
    );
  });

  it("四个触发点都在：光标/编辑、用户滚动、切激活文档、全局刷新", () => {
    expect(main, "光标与编辑之后要推（被同源光标同步触发的不反推）").toMatch(
      // ⚠️ B254 换锚：那句现在多了一道抑制标志，且 prettier 把 `pushSyncToSiblings`
      //    折到了下一行 —— 判据得认「条件 + 换行 + 调用」这一整块，别只认半句。
      /if \(!suppressSyncPush && isSyncSource\(tab, panel\) && syncingCursorDocId !== tab\.docId\)\n\s*pushSyncToSiblings\(tab\);/,
    );
    expect(tabsSrc, "用户滚动之后要推：谁滚谁当源").toMatch(
      /if \(t\) pushSyncToSiblings\(t, true\);/,
    );
    // 「切换激活文档时则根据新的激活文档进行同步」—— 这一句就落在 switchTab 末尾。
    // ⚠️ B241：这一趟带闸门 ——「没收口」才推全部兄弟（回推会把换算值刷回源那一格）。
    //    ⚠️⚠️ B260 换锚：调用点不再是裸 `pushSyncToSiblings(tab)` —— B259 把总闸
    //    `suppressSyncPush` 提到入口后第二参固定 `false`，B260 又让**交接游标**顶掉
    //    `syncSrc`（源那一格被自己一侧自然上限截小的那份不许再当交接值）。判据仍然只
    //    盯「这一趟存在、且用交接游标 `handV`」，闸门语义（!aligned 才推全部）一字未动。
    //    判据要认 prettier 折行后的「条件 + 换行 + 调用」整块，别只认半句。
    expect(tabsSrc, "切激活文档后要按新源推（没收口那一支）").toMatch(
      /if \(tab && !aligned\) \{\n\s*pushSyncToSiblings\(tab, false, \{ v: handV, atFloor: srcAtFloor \}\);/,
    );
    // ⚠️ B258 换锚（新增的一支）：收口**生效**时原本整趟跳过 ⇒ 兄弟那一格永远停在
    //    上一次被推到的值上（用户报：预览滚到底 → 切源码 → 切回预览，只有这一格跟着走）。
    //    现在改成照样补推，但只推**其余兄弟**（源与接班都已被收口写好），且沿用收口
    //    同一个游标 —— ⚠️ B260 跟着 `syncSrc` 一起换成 `handV`：两分支必须用同一个数，
    //    否则「接班」与「其余兄弟」会掉成两档（B258 要的就是同位）。
    expect(tabsSrc, "收口生效那一支也要补推兄弟（否则兄弟停在旧值）").toMatch(
      /\} else if \(tab && handV !== null && shownTab\) \{\n\s*pushSyncToSiblings\(tab, false, \{\n\s*v: handV,\n\s*atFloor: srcAtFloor,\n\s*skipTabIds: \[shownTab\.tabId, tab\.tabId\],/,
    );
    expect(tabsSrc, "补推要排在「不推」那一支后面（两条互斥分支）").toMatch(
      /\} else if \(tab && handV !== null && shownTab\) \{/,
    );
    expect(ui, "全局刷新兜底（新出现的那一份要对齐）").toMatch(/const act = activeTab\(\);/);
  });

  it("点开的那一刻就推一次，不用等用户再滚一下", () => {
    expect(CLICK_BODY, "点击要先改状态").toMatch(/docSyncModes\.set\(tab\.docId, on\);/);
    expect(CLICK_BODY, "开启后立刻推").toMatch(/if \(on\) pushSyncToSiblings\(tab, true\);/);
    expect(CLICK_BODY, "要顺手刷新按钮（点亮态 + 提示）").toMatch(/refreshSyncButton\(tab\);/);
  });
});

/**
 * B240 同步滚动：非激活的标签也要统一滚动位置。
 *
 * 一个 panel 只挂**一个** `EditorView`（`viewTabId` 决定它此刻显示哪份），所以同一
 * 文档的「其它标签」分两类：
 *   · **挂在别的面板上**（分屏 / 卫星窗口）—— 有容器，原路径 `pinScrollTop` 就钉到了；
 *   · **离屏**（同文档另一份标签排在标签栏里没被选中）—— **没有容器**，但它的快照槽
 *     `t.scrollTop` 是能写的，而 `restoreViewScroll` 切过去时正是拿这个槽钉位置。
 *
 * B240 之前 `applySyncToSibling` 对离屏兄弟**直接 return，位置一个字都没写**（注释说
 * 「离屏的只改它自己的快照（选区 + 位置）」，代码只写了选区）⇒ 用户报「非激活的标签
 * 也要统一滚动位置」。
 *
 * ⚠️ 判据盯的是**「写快照」排在「钉 DOM」之前**这个顺序：钉不钉得上取决于有没有容器，
 *   快照该写一定要写 —— 顺序反了就退回「离屏就不写」的原 bug，且从断言上看不出来。
 */
describe("B240 同步滚动：非激活（离屏）标签也要统一滚动位置", () => {
  /**
   * **统一分支**（源码态 / 预览态汇成的一条）的函数体 —— 从 `v` 判据切到函数收尾。
   *
   * ⚠️ B251 换锚：旧锚点是 `if (px !== null) {`（源码态那一路的 px 直推分支），它已经被
   *    并进「统一交 `v`」这一条 —— 判据从「px 分支里的顺序」改成「统一分支里的顺序」，
   *    要盯的东西一个没少（离屏兄弟照样写槽、钉 DOM 走 pinScrollTop、两行谁先谁后）。
   *    终点用**同函数内**的标记（下面那句「先记槽、再钉 DOM」的注释），不用函数名：
   *    `PUSH_BODY` 已切到 `showMessage` 之前，在里面找 `function showMessage(` 必然切空。
   */
  function unifiedBranch(): string {
    // ⚠️ 终点是统一分支的**收尾大括号之后**（`\n}\n\n`）—— 只停在「只有兄弟自己在屏时」
    //    那句注释头上，`if (shownView) pinScrollTop(shownView.scrollDOM, top);` 会落在
    //    切片外 ⇒「钉 DOM 走 pinScrollTop」那条判据永远全绿（连退化都绿）。
    return slice(PUSH_BODY, "  if (v === null) return;", "\n}\n\n");
  }

  it("离屏的源码兄弟也要写位置快照（recordScroll 不许被「在不在屏」挡住）", () => {
    const body = unifiedBranch();
    // ⚠️ 反向闸排在正向断言之前：B240 前那句 `if (!shownView) return;` 挡的就是「离屏
    //    就不写」—— 它现在**不许再出现**。判据只认调用形态（含实参 `top`），
    //    **不写函数名** —— 源码注释里复述过同类的句，写函数名容易误判。
    // ⚠️ B251 收紧：只盯 `!shownView` 会被 `if (v === null || !shown) return;` 绕过去
    //    （同一个「在不在屏就 return」的病，换个变量名就认不出来）⇒ 把两种写法一网打尽。
    //    它与下面那道「换不出几何 ⇒ 不许硬写」的 `if (!view) return;` 不是一回事，不冲突。
    expect(body, "不许再出现「没容器/离屏就不写槽」那道守卫").not.toMatch(
      /if \(!shown(?:View)?\) return;/,
    );
    const rec = body.indexOf("recordScroll(other.tabId, top);");
    expect(rec, "统一分支里应写位置快照（离屏标签的位置就靠它）").toBeGreaterThanOrEqual(0);
    // 守卫只留「换不出几何 ⇒ 不许硬写」这一道（真·没有 view 才算换不出）。
    const guard = body.indexOf("if (!view) return;");
    expect(guard, "换不出落点时要认得出（不许硬写）").toBeGreaterThanOrEqual(0);
    expect(
      guard,
      "「换不出」的守卫必须排在写槽之前（否则离屏兄弟拿旧值/0 值盖掉自己的位置）",
    ).toBeLessThan(rec);
  });

  it("钉 DOM 仍走 pinScrollTop（离屏那份跳过钉位，但快照已经写了）", () => {
    const body = unifiedBranch();
    // 正向：在屏的兄弟照旧钉 DOM，且走 pinScrollTop（B170 的来源标记）。
    expect(body, "在屏的兄弟要钉 DOM").toContain("pinScrollTop(shownView.scrollDOM, top);");
    // 快照在前、钉位在后 —— 两行的先后本身就是判据（上面那条已钉，这里钉住配套关系）。
    expect(body.indexOf("recordScroll(other.tabId, top);")).toBeLessThan(
      body.indexOf("pinScrollTop(shownView.scrollDOM, top);"),
    );
  });

  it("源是预览侧（只交 `v`）时，离屏源码兄弟不许写「源那侧的 px」—— 但换算得出来的像素它照样要写", () => {
    // 这一条是 B240 **刻意不覆盖**的格子：行号→编辑器像素要按它自己那份文档的
    // `lineBlockAt` 算，而离屏时它没有视图（view 归面板所有，正在显示别的标签）。
    // 硬写就是污染（B154 踩过：把预览像素当编辑器像素塞进源码槽，切回源码位置全错）。
    // ⚠️ B251 换锚：终点用**统一分支**末尾那句「先记槽、再钉 DOM」的注释当标记 ——
    //    跨侧的两条（px 直推 / 行号换算）已经并成一条，切「预览源那一路」这段没意义了。
    const body = unifiedBranch();
    expect(body.length, "要能切到统一分支").toBeGreaterThan(0);
    // ⚠️ B248：守卫是 `if (!view) return;`（换不出几何），**不是** `if (!shownView) …` ——
    //    离屏源码兄弟现在**拿同文档的另一个源码视图**换算也能写槽了（用户报：滚激活的
    //    预览时，未显示的那份代码标签位置纹丝不动）。判据仍是「换不出 ⇒ 不许硬写」。
    const guard = body.indexOf("if (!view) return;");
    expect(guard, "预览源那一路要有「换不出就返回」的守卫").toBeGreaterThanOrEqual(0);
    // ⚠️ 那一路上**不许**再出现「把源那侧的 px 当落点」的写法 —— 出现了就等于把编辑器
    //    像素硬塞进一个没有视图算不出位置的兄弟的槽。锚点带调用形态，扫整段注释的复述。
    expect(body, "不许再出现「px 直通」这条死路").not.toMatch(/recordScroll\(other\.tabId, px\)/);
    // 而换算得出来的那个 `top` 才是唯一允许写进槽的值。
    expect(body, "换算出来的像素照样写槽").toContain("recordScroll(other.tabId, top);");
  });

  it("预览态兄弟那一路保持原样：B129 的「别把编辑器像素当预览像素」不能被破坏", () => {
    // 反向闸：离屏的预览兄弟**依然**什么都不写（预览像素没有容器可换算）。
    // 这条是 B154 的既有判据，B240 不许为了「非激活也要统一」把它改松。
    // ⚠️ B251 换锚：跨侧统一交 `v` 之后，这道跳过守卫的判空条件从 `line` 变成 `v`
    //    （含义没变：**`v` 取不到或预览兄弟没容器 ⇒ 一样都不写**）。
    expect(PUSH_BODY, "离屏预览兄弟要跳过").toContain("if (v === null || !shown?.preview) return;");
  });

  it("离屏兄弟的位置有处可去：切标签时 restoreViewScroll 拿的正是这个快照槽", () => {
    // 写快照之所以有用，靠的是切过去时有人读它。判据钉住那个读取点。
    // ⚠️ 终点用 `applyPanelMode`（`pinScrollTop` 排在 `restoreViewScroll` **之前**，
    //    拿它当终点会切出空串 —— `slice` 会红，不是静默放行）。
    const restore = slice(main2, "function restoreViewScroll(", "function restorePreviewScroll(");
    expect(restore, "切标签时要把快照槽还给视图").toContain("t.scrollTop");
    // 位置闸（B273 翻案后的新口径）：快照槽 `t.scrollTop` 的**读取**必须排在自己被钉
    // （`pinScrollTop`）之前 —— 但 B273 在它**前面**多开了一条 `syncV` 派生分支（那条也钉、
    // 用的是换算后的像素而非槽），所以终点不能再取「第一个 `pinScrollTop(`」，否则会把
    // `syncV` 分支那次钉算成「槽还没读就钉」而假红。判据收紧到**兜底那一次钉**
    // （`restoreViewScroll` 里最后一个 `pinScrollTop(`）= 兜底分支先读 `t.scrollTop` 再钉它。
    expect(restore.indexOf("t.scrollTop")).toBeLessThan(restore.lastIndexOf("pinScrollTop("));
  });
});

// ------------------------------------------------- B240 三轮：切过来那份由**源**收口
describe("B240 三轮：切过来显示的那一份，由**源**收口（不可见也要算）", () => {
  // ⚠️ 锚点一律取**带调用形态的单句**：单写函数名会被上方注释拦下来（`indexOf` 撞到
  //   注释里那句复述就等于定位到注释，位置闸直接假绿）。这样退化掉哪一句都能对得上。
  const SNAP_BODY = slice(
    main2,
    "function syncSourceSnapshot(",
    "function alignShownToSyncSource(",
  );
  const ALIGN_BODY = slice(
    main2,
    "function alignShownToSyncSource(",
    "function pushSyncToSiblings(",
  );
  const SWITCH_BODY = slice(
    tabsSrc,
    "  rememberViewScroll(panel);",
    "measureAndKeepScroll(panel);",
  );
  // ⚠️ B251 换锚：终点从 `if (px !== null) {`（已被并掉的源码态 px 直推分支）换成统一
  //    分支里那道「`v` 取不到就返回」—— 预览态那一支仍从它自己的判据切起，跨侧两条
  //    汇成一条之后它们的交叠点就在这儿。
  const PREVIEW_BRANCH = slice(
    PUSH_BODY,
    'if (other.viewMode === "preview") {',
    "if (v === null) return;",
  );
  const LAND_BODY = slice(PREVIEW_TS, "  private applySyncToLine(", "  private blockAtLine(");
  const SYNC_BODY = slice(main2, "function applySyncToSibling(", "function syncSourceSnapshot(");
  // ⚠️ B257 换锚：终点从 `topVisibleLineOf`（那个取整版顶行函数已随「跨侧交完整 v」一起
  //    删掉）换成紧邻的 `editorLineTopPx` —— 锚点失效时 slice 静默返空串、判据全绿。
  const LINE_TOP = slice(main2, "function editorLineTopPx(", "function sourceTopOfV(");

  it("源那一格还没离屏就得把坐标采下来 —— 采点排在面板换页之前", () => {
    const sample = SWITCH_BODY.indexOf("syncSourceSnapshot(shownTab, tabId);");
    const swap = SWITCH_BODY.indexOf("applyPanelMode(panel);");
    expect(sample, "切标签时要就地采源坐标").toBeGreaterThanOrEqual(0);
    expect(swap, "面板换页那一句要切得到").toBeGreaterThanOrEqual(0);
    expect(
      sample,
      "采点必须排在换页之前：离屏后取到的是面板那一个视图，显示的是接班那份",
    ).toBeLessThan(swap);
  });

  it("还原必须排在换页之后 —— 预览态下编辑器是 display:none，隐藏期间钉不进 scrollTop", () => {
    // ⚠️ B243：`applyPanelMode` 给面板套上 `mode-preview` 时 CSS 直接把
    //    `.panel-host.mode-preview .panel-editor{display:none}`（`preview.css:635`）；
    //    jsdom 不做 CSS 级联 ⇒ 这条**只能**静态盯。顺序反了 ⇒ 源码侧切到预览态时先写了
    //    一个看不见的 scrollTop，等编辑器重新可见，位置并没落进去（切过去视觉上回顶）。
    const restore = SWITCH_BODY.indexOf("restoreViewScroll(panel);");
    const swap = SWITCH_BODY.indexOf("applyPanelMode(panel);");
    expect(restore, "还原那一句要切得到").toBeGreaterThanOrEqual(0);
    expect(swap, "换页那一句要切得到").toBeGreaterThanOrEqual(0);
    expect(restore, "还原排在换页之后（编辑器可见了才钉得进位置）").toBeGreaterThan(swap);
  });

  it("换完页再收口 —— 收口的对象是切过来显示的那一份，不是源", () => {
    const swap = SWITCH_BODY.indexOf("applyPanelMode(panel);");
    const align = SWITCH_BODY.indexOf("const aligned = tab ? alignShownToSyncSource(");
    expect(align, "切换末尾要收口").toBeGreaterThanOrEqual(0);
    expect(swap, "换页那一句要切得到").toBeGreaterThanOrEqual(0);
    expect(align, "收口排在换页之后（先换出要显示的那一份，再按源对齐它）").toBeGreaterThan(swap);
    expect(ALIGN_BODY, "收口落到切换后显示的那一份上").toContain("panel.viewTabId");
  });

  it("收口排在 CM6 测量补偿之前（位置先定死，再让测量去补偿）", () => {
    const align = tabsSrc.indexOf("const aligned = tab ? alignShownToSyncSource(");
    const measure = tabsSrc.indexOf("measureAndKeepScroll(panel);");
    expect(align, "收口调用要在源码里").toBeGreaterThanOrEqual(0);
    expect(measure, "测量调用要在源码里").toBeGreaterThanOrEqual(0);
    expect(align, "收口排在测量补偿之前").toBeLessThan(measure);
  });

  it("同步没开就谁也别替谁决定位置（B149 基线不变）", () => {
    expect(SNAP_BODY, "同步关 ⇒ 采都不采").toContain(
      "if (docSyncModes.get(src.docId) !== true) return null;",
    );
  });

  it("坐标口径与推兄弟那一路一致：源停在哪一侧就取哪一侧（都从唯一取值口取）", () => {
    // ⚠️ 取值口**还是那一个**（`syncSourceV`），本轮 B257 只是把 `cross` 那一档删了 ——
    //    源停在哪一侧照旧由取值口自己认，跟随 / 收口 / 交接都不许再各取各的，也不许再
    //    「按跨侧丢小数」（丢掉的就是切换时那一点偏移：源码 287 ⇒ 280、预览 847 ⇒ 840）。
    // ⚠️⚠️ B266 换锚（同语义，不是改松判据）：`syncSourceSnapshot` 的返回值从
    //    `{ v, atFloor }` 简化为 `number | null` —— B265 已让两侧末行/末块都能滚到视口顶，
    //    自然上限不再错配，`atFloor` 特判已无前提，故直接 `return syncSourceV(src);`
    //    （`v` 仍从唯一取值口出，单参、无 cross 档；不再同帧采 atFloor）。
    // ⚠️⚠️ B278 换锚（同语义）：`syncSourceV(src)` 先存进 `v`、打一条采源埋点后再返回
    //    —— 采源埋点要打「换算输入」（dom/slot/预览 scrollTop）才能定位「收口交整数 95」
    //    那条路。取值口仍是唯一的 `syncSourceV(src)`，语义未变。
    expect(SNAP_BODY, "收口走唯一取值口，交完整 `v`（B278 埋点在返回前）").toMatch(
      /const v = syncSourceV\(src\);[\s\S]*?return v;/,
    );
    // ⚠️ 反向闸：不许退回「按跨侧判据现算要不要丢小数」那一版（收口 / 跟随 / 切模式
    //    三处各传一个 cross 实参）—— 那正是每跨一次侧吃一格比例的入口。
    expect(SNAP_BODY, "收口不许退回 cross 档（跨侧丢了小数 ⇒ 切 tab 就偏）").not.toMatch(
      /syncSourceV\(src, /,
    );
    expect(pushBody(), "跟随也只经唯一取值口（逐兄弟现取，不按跨侧丢小数）").toContain(
      "const v = syncSourceV(src);",
    );
    expect(pushBody(), "跟随不许退回 cross 档").not.toMatch(/syncSourceV\(src, /);
    // ⚠️ 反向闸：不许退回「三处各取各的」（收口/跟随/切模式各一套）。
    expect(SYNC_BODY, "落点不许再手拼坐标").not.toMatch(/editorLineTopPx\(view, line\)/);
  });

  it("切标签收口直接用离屏前采下的源真实 v（B266：不再有 atFloor / handoverV 特判）", () => {
    // ⚠️⚠️ **B266**：B265 已让两侧末行/末块都能滚到视口顶，两侧 floor 游标都 = 文档末行
    //    `v`，自然上限不再错配，故「顶没顶上限」的 `atFloor` 与「取更靠后」的 `handoverV`
    //    已无前提。收口直接消费 `syncSourceSnapshot` 在离屏前采下的源真实 `v`（即 `syncSrc`），
    //    不再需要同帧采 atFloor、也不再在切标签这一帧当场问源上限。判据钉住新形态。
    expect(SWITCH_BODY, "收口消费离屏前采下的源真实 v（syncSrc），无 handoverV").toMatch(
      /const handV = tab \? syncSrc : null;/,
    );
    // ⚠️ 反向闸：B260 的 `handoverV` 整段特判必须彻底删除，切标签收口体里不许再出现。
    expect(SWITCH_BODY, "切标签收口体不得残留 handoverV 特判").not.toMatch(/handoverV\(/);
  });

  it("跨侧交完整 v：小数是「走了一格多少」，跨侧照带（丢了就是每切一次偏一格）", () => {
    // ⚠️⚠️ 本条是 B257 **把 B251 那条判据翻过来**的地方（自测台 `tests/sync-stability.test.ts`
    //    实测，不是纸上推演）：B251 立的是「跨侧只交整数块首 / 整数顶行（小数 0），因为两个
    //    小数归一在不同高度上（行高 vs 块高）」。
    //    · 事实层面：丢掉的小数正好是「这一格走了多少」—— 源码 287（半行）⇒ 切模式一轮
    //      变 280（整行顶）；预览 847（块内 1/6）⇒ 切标签一轮变 840。每跨一次侧吃一格比例。
    //    · 立论层面也不成立：`topVisibleLine()` 读是 `start + ratio × range`（×range 把块高
    //      折回**行**），`applySyncToLine` 写是 `into / range`（除回去），**乘除抵消** ⇒
    //      两侧小数是同一个量，不是「行高比例 vs 块高比例」两种东西。
    //    ⇒ 现在只有一档：跨侧照交完整 `v`。
    expect(SYNC_V, "跨侧（预览⇄源码）也走完整 v，整数块首那档已删").toContain(
      "return p?.preview?.topVisibleLine() ?? null;",
    );
    expect(pushBody(), "跟随逐兄弟现取，不按跨侧丢小数").toContain("const v = syncSourceV(src);");
    // 落点那一侧必须**真的按行高插值**，而不是把小数丢给 CM6 让它自己上取整。
    // ⚠️ B251 换锚：这句换算如今只在 `sourceTopOfV` 里出现一次 ⇒ 判据盯它自己的函数体。
    expect(SOURCE_TOP, "落点要按行高显式插值（不许把小数丢给 CM6 上取整）").toContain(
      "return h > 0 ? lineTop + (v - base) * h : lineTop;",
    );
  });

  it("切源码/预览那一路（toggleViewMode）与收口同一个出口（两条路径同一口径）", () => {
    const body = slice(mdSrc, "function toggleViewMode(", "function openPreviewToSide(");
    // ⚠️ B251 那会儿这里钉的是「跨侧交接 ⇒ 取值口带 `cross = true`」，本轮 B257 翻案删掉
    //    那一档：切模式是跨侧（预览 ⇄ 源码），但不许丢小数 —— 丢了就是每切一次模式丢半行
    //    （自测台：源码 287 ⇒ 一来一回变 280）。只写 `syncSourceV(tab` 会连收口那处一起
    //    命中，退化打不掉 ⇒ 把调用形态整条钉住；判空那句另钉（见下面两条反向闸）。
    expect(body, "切模式交接走唯一取值口，交完整 `v`").toContain("const v = syncSourceV(tab);");
    // ⚠️ 反向闸两条，退化方向都是「把 cross 档请回来」（跨侧只交整数块首 / 整数顶行）：
    //    只写 `, true` 会连收口 / 跟随那两处一起命中 ⇒ 退化打不掉就变假绿。
    expect(body, "切模式不许退回 cross 档（跨侧只交整数顶行 ⇒ 每切一次丢半行）").not.toMatch(
      /syncSourceV\(tab, /,
    );
    expect(SYNC_V, "取值口不许再分跨侧 / 同侧两档").not.toMatch(
      /syncSourceV\(t: Tab \| undefined, cross/,
    );
  });

  it("收口调的就是同一个落点函数，只交一个游标（不是 px + line 两个）", () => {
    expect(ALIGN_BODY, "收口要按源的位置落位").toContain(
      "applySyncToSibling(shown, snap, atFloor);",
    );
    expect(ALIGN_BODY.match(/applySyncToSibling\(/g)?.length, "落点调用只有这一处").toBe(1);
  });

  it("采样只交游标，与推兄弟那一路同一口径：源在预览侧也不交像素", () => {
    // ⚠️ `src.scrollTop` 是双语义槽（源码侧存编辑器像素、预览侧存预览像素）。
    //    过去这里交 px（源是源码时的编辑器像素），源是预览时交空 —— 那套「px + line 两
    //    个一起传」正是「一个预览一个源码」乱跳的成因之一。B251 只交一个 `v`。
    // ⚠️ B251 换锚：单游标那条判据锚 `alignShownToSyncSource` 的形参 `snap`（
    //    `syncSourceSnapshot` 的返回类型一直就是 `number | null`）。
    //    ⚠️ 判据**不写整行**（prettier 会把 `snap: number | null,` 折成两行，整行锚点
    //    会静默失配）：只在形参类型上判定，正反两面各一条。
    expect(ALIGN_BODY, "收口交的是单个游标（不是 {px, line} 那种两字段）").not.toMatch(
      /snap:\s*\{/,
    );
    expect(ALIGN_BODY, "收口那一份的类型就是游标本身").toMatch(/snap: number/);
    expect(SNAP_BODY, "不许再交 px 那一格").not.toMatch(/px:/);
  });

  it("跨侧（一个预览一个源码）也要收口 —— 因为跨侧落点与切源码/预览用的是同一套换算", () => {
    // B242：以前跨侧不收口（不重算、接班保留上次落点），因为那会儿跨侧走的是
    //   「搬行内比例」的换算，往返不等值 ⇒ 只能躲。B251 起跨侧与切模式、跟随同走一条
    //   `v` + `sourceTopOfV` ⇒ 同一个游标恒落到同一个像素，跨侧照收也不漂。
    expect(ALIGN_BODY, "不许再出现「跨侧交还不落位」那道守卫").not.toContain(
      "if (src.viewMode !== shown.viewMode) return false;",
    );
    expect(ALIGN_BODY, "收口对两侧一视同仁：都调同一个落点函数").toContain(
      "applySyncToSibling(shown, snap, atFloor);",
    );
    expect(ALIGN_BODY, "收口成功要交回 true（调用方据此跳过回推）").toContain("return true;");
  });

  it("B251 撤掉的 B247 守卫**以新语义请回来了**：源是预览、显示中是源码 ⇒ 收口不许推", () => {
    // ⚠️⚠️ 这条是 B251 那次「删守卫」的**翻案**：
    //   B251 撤守卫的理由是「退化里只有 1 条静态契约红、1289 全绿 ⇒ 拦不到真实路径」。
    //   那条退化验是**假绿** —— 补回去的是 `snap.px === null`，而 `snap` 早被 B251 改成
    //   `number` ⇒ `snap.px` 恒 `undefined` ⇒ 补的是一条**死守卫**，行为一点没变，全绿只
    //   证明「补了个寂寞」。于是 B247 那个「跨侧拿带比例的量覆盖 `restoreViewScroll` 的
    //   精确位置」（每切一轮往上掉一趟）原样复发 —— 用户报「切换 tab 往上偏移又出现」。
    //
    //   B251 还顺带把因果判反了：它写「跨侧只交整数块首是病根」。其实整数块首只是让病
    //   看起来像它的那层皮 —— 皮底下是「覆盖」，而守卫管的正是「不覆盖」。所以本轮连根
    //   修两件事：① 跨侧（预览⇄源码）只交整数块首（`syncSourceV` 的 `cross` 档）⇒ 零偏差；
    //   ② 守卫按**新语义**请回来 —— `snap` 现在是游标 `v`，「源是预览」只能从 `src.viewMode`
    //   认（旧写法靠 `snap.px === null` 那套双字段，改类型后自动失效，正是假绿的温床）。
    // ⚠️⚠️ **B276：B247 守卫已撤销**（用户拍板，金标准优先 —— 见 `alignShownToSyncSource`
    //    里那段 B276 注释）。反向闸必须留着且要能变红：守卫一旦被加回来，源码就不再被
    //    收口对齐 ⇒ 与两个预览差十几行（真机 04:34:44：源码 v79.6 / 预览 v95）。
    expect(ALIGN_BODY, "撤销的 B247 守卫不许长回来（源预览+显示源码 ⇒ 早退）").not.toContain(
      'if (src.viewMode === "preview" && shown.viewMode !== "preview") return false;',
    );
    // 反向闸（两条）：不许退回**旧写法** —— `snap` 是 `number`，`snap.px` 恒 undefined，
    // 那条守卫在 B251 之后根本命中不了任何路径，看着是守卫、其实是死代码。
    expect(ALIGN_BODY, "不许把旧那道「看双字段」的守卫加回来（改类型后它是死的）").not.toMatch(
      /snap\.px/,
    );
    // 早退只封这一格：源是预览、目标也是预览（同侧）照收，不许一刀切全退。
    // ⚠️ 正向取整条表达式（只判 `src.viewMode === "preview"` 会连同侧那一格一起命中，
    //    退化打不掉就变假绿）。
    // B276：撤销后不再有「只压源预览→目标源码」的短路 —— 收口对源码/预览一律生效。
    expect(ALIGN_BODY, "收口不许再按「源预览 → 目标源码」短路（B276 撤销）").not.toMatch(
      /if \(src\.viewMode === "preview" && shown\.viewMode !== "preview"\) return false;/,
    );
    expect(ALIGN_BODY, "跨侧收口靠落点函数落地（守卫只是短路这一格）").toContain(
      "applySyncToSibling(shown, snap, atFloor);",
    );
    expect(ALIGN_BODY.match(/applySyncToSibling\(/g)?.length, "收口只有这一处落点调用").toBe(1);
  });

  it("跨侧落点与切源码/预览同源：两边都走同一个换算出口，不许各插各的", () => {
    // 这条是本次诉求的**根判据**：同步滚动与代码/预览切换的位置计算必须是**同一个函数**。
    const shared = main2.indexOf("function sourceTopOfV(");
    expect(shared, "游标→像素的换算要抽成唯一一份，别两处各写一行").toBeGreaterThanOrEqual(0);
    // 调用方：切模式那一路的 handoff、以及跨侧落点（都在 main 里、都调它）
    const calls =
      (main.match(/sourceTopOfV\(/g) ?? []).length + (main2.match(/sourceTopOfV\(/g) ?? []).length;
    expect(calls, "sourceTopOfV 至少被切模式 + 跨侧落点两处用上").toBeGreaterThanOrEqual(3);
    // 反向闸：跨侧源码分支不许再出现「按行内比例手动插值」那串老写法
    expect(applyBody(), "跨侧不许搬 frac（编辑器行内比例搬到预览那边量纲就错）").not.toMatch(
      /block\.top \+ block\.height \* frac/,
    );
    // 换算函数本身：夹取行号 + 落点只由 `editorLineTopPx` 取行顶（行内比例走 `h`）
    expect(LINE_TOP, "行顶换算要夹住行号").toContain(
      "Math.min(Math.max(1, line), view.state.doc.lines)",
    );
    expect(LINE_TOP, "行顶换算只取这一行的顶").toContain(
      "lineBlockAt(view.state.doc.line(n).from).top",
    );
  });

  it("收口生效后不许回推源 —— 回推会把换算值刷回源那一格", () => {
    // ⚠️ B258 换锚：原判据盯 `if (tab && !aligned) pushSyncToSiblings(tab);`（prettier 已折成
    //    块，且现在多一支「收口生效 ⇒ 补推其余兄弟」）—— 换锚到同一处的**两半**语义：
    //    「没收口 ⇒ 推全部 / 收口生效 ⇒ 只推其余兄弟且跳过源与接班」。
    const NOT_ALIGNED = "if (tab && !aligned) {";
    expect(tabsSrc.indexOf(NOT_ALIGNED), "切完那趟回推要留给没收口的情形").toBeGreaterThanOrEqual(
      0,
    );
    expect(ALIGN_BODY, "收口路径要有交回 true 的那一瞬").toContain("return true;");
    // 位置闸：闸门必须紧跟着收口调用出现（顺序本身是判据：先判 aligned 再决定推不推）。
    const call = tabsSrc.indexOf("if (tab && !aligned) {");
    const src = tabsSrc.indexOf("const aligned = tab ? alignShownToSyncSource(");
    expect(src, "收口结果要接住，供下面的闸门用").toBeGreaterThanOrEqual(0);
    expect(src, "闸门排在收口调用之后（拿到结果才谈得上跳过）").toBeLessThan(call);
  });

  it("预览定位没落地 ⇒ 不许把容器里的 0 记成「它停在顶部」（B134 同型）", () => {
    expect(PREVIEW_BRANCH, "落点要按返回值判空再记").toContain(
      "if (landed !== null) recordScroll(other.tabId, landed);",
    );
    // ⚠️ B257 换锚：小数不再被 `Math.floor` 掐掉（跨侧也交完整 `v`，见 `syncSourceV` 翻案）。
    //    判据仍是「补记快照只认程序定位的返回值」，不是改松。
    expect(PREVIEW_BRANCH, "落点来自程序定位那一路的返回值").toContain(
      "preview.syncToLineProgrammatic(v);",
    );
    // ⚠️ 反向闸必须排在正向断言之后也有效 —— 这里盯的是「补记快照不许绕过判空」。
    expect(PREVIEW_BRANCH, "不能拿没落地的落点去补记快照").not.toMatch(
      /recordScroll\(other\.tabId,(?!\s*landed\))/,
    );
  });

  it("预览侧的常数平移也清干净了（ANCHOR = 0）：探测只问「压在哪一块」", () => {
    // B251 定案 ANCHOR = 0 时只清了源码侧（`main.ts` 的 `topVisibleLineFrac`），预览侧这
    // 对常数（`applySyncToLine` 写 `块顶 − 8` / `topVisibleLine` 读 `scrollTop + 8`）是
    // **连带项** —— 不清掉，预览侧每走一次往返就偏 8px（≈半行），「严格互逆」就只对了
    // 一半。而正是这一对常数撑起了 B245 那个「越切越靠顶」（真实 `scrollTop` 带小数，
    // 减 8 加回来仍是 `块顶 − 0.5` < 块顶 ⇒ 二分命中前一块），当时只能拿 EPS 兜。
    expect(PREVIEW_TS, "探测点是个常量，且只用在块边界上").toMatch(/const TOP_PROBE = 0\.5;/);
    expect(PREVIEW_TS, "取锚只问「视口顶压在哪一块」").toContain(
      "this.indexOfBlockAtOffset(this.root.scrollTop + TOP_PROBE)",
    );
    // ⚠️ 关键：比例**不许吃探测点**（与源码侧 `topVisibleLineFrac` 同构）。
    expect(PREVIEW_TS, "比例用真·scrollTop").toContain(
      "(this.root.scrollTop - top) / (nextTop - top)",
    );
    expect(PREVIEW_TS, "落点就是块顶本身").toContain("const nextTop = Math.max(0, top);");
    // 反向闸（两条）：那对常数一旦回来，这里必须立刻认出来 —— 只拦一条会漏掉另一半。
    expect(PREVIEW_TS, "不许再写回「块顶 − 8」").not.toMatch(/top - 8/);
    expect(PREVIEW_TS, "不许再写回「scrollTop + 8」").not.toMatch(/scrollTop \+ 8/);
  });

  it("预览交出去的是**实际落点**：找不到目标块就交 null", () => {
    expect(LAND_BODY, "块找不到 ⇒ 交空").toContain("if (!target) return null;");
    expect(LAND_BODY, "兜底交回算出来的落点").toContain("return nextTop;");
    expect(PREVIEW_TS, "程序定位那一路把落点透出去").toContain(
      "syncToLineProgrammatic(line: number): number | null",
    );
  });
});

// ------------------------------------------------- B159：跨窗口同步滚动
describe("B159 跨窗口同步滚动（用户报：子窗口文档没跟着动）", () => {
  const MSG_BODY = main5.slice(main5.indexOf("const EVT_DOC_CHANGE = "));
  const RECV_BODY = slice(mwSrc, "function applySyncMode(", "/** 注册跨窗口同步的监听");
  const POS_RCV = slice(mwSrc, "function applyRemoteSyncPos(", "/** 注册跨窗口同步的监听");
  // listenDocSync 已拆到 multiwindow/windows.ts 且是该簇最后一个函数 ——
  // 终锚「卫星窗口引导」横幅不在同一文件，改用簇尾（文件尾的 export 块）。
  const LISTEN = slice(mwSrc, "function listenDocSync(", "\nexport {");

  it("四条事件常量都要在，且从与文档同步那三兄弟里长出来", () => {
    expect(MSG_BODY, "同步滚动的两条要跟三兄弟放一起").toMatch(/const EVT_SYNC_MODE = /);
    expect(MSG_BODY, "位置那一条也要").toMatch(/const EVT_SYNC_POS = /);
    // ⚠️ 判据要收口到分号：注释里提到这两个名字不算数（本项目已经栽过一次「正则命中注释」）。
    expect(MSG_BODY, "开关状态那条要落地").toMatch(/const EVT_SYNC_MODE = "sync-scroll-mode";/);
    expect(MSG_BODY, "位置那条要落地").toMatch(/const EVT_SYNC_POS = "sync-scroll-pos";/);
  });

  it("只有「用户滚动」那几路往外广播，光标/输入那一路不播", () => {
    // `crossWindow` 的默认值必须是 false：光标那一半（`handleUpdate` 那条）走默认，
    // 只有编辑器滚动、预览滚动、按下开关三处显式打开 —— 否则在主窗口敲一个字
    // 就会把另一个窗口拉过来，那不是同步滚动，是打字干扰。
    expect(PUSH_BODY, "广播函数挂在推送末尾").toMatch(/if \(crossWindow\) broadcastSyncPos\(/);
    expect(PUSH_BODY, "默认不许播").toMatch(
      // ⚠️ B258 换锚：第三参 `{ … } = {}` 是收口后补推兄弟那一趟加的（传 `v` / `skipTabIds`
      //    两个可选字段），prettier 顺势把签名折成多行 —— 判据认「默认不播」这个实义：
      //    第二参 `crossWindow = false` 且 `broadcastSyncPos` 那道闸挂在它身上。
      //    ⚠️ B284 换锚：第三参多了一个可选字段 `atFloor`（到底锚点，见 `tabAtOwnFloor`）。
      /function pushSyncToSiblings\(\s*src: Tab,\s*crossWindow = false,\s*opts: \{ v\?: number \| null; skipTabIds\?: number\[\]; atFloor\?: boolean \} = \{\},\s*\): void/,
    );
    // 光标 / 输入那一路：不带第二个实参，走默认。
    expect(main, "光标那一半不许跨窗口（且不反推同步触发的那轮）").toMatch(
      // ⚠️ B254 换锚：那句现在多了一道抑制标志，且 prettier 把 `pushSyncToSiblings`
      //    折到了下一行 —— 判据得认「条件 + 换行 + 调用」这一整块，别只认半句。
      /if \(!suppressSyncPush && isSyncSource\(tab, panel\) && syncingCursorDocId !== tab\.docId\)\n\s*pushSyncToSiblings\(tab\);/,
    );
    // 切激活文档 / 全局刷新这两路也不播：那是「本地对齐」，不是用户滚动。
    // ⚠️ B258 换锚：签名已折成多行，旧锚 `/function pushSyncToSiblings\(src: Tab, crossWindow = false\)/`
    //    会静默失配 —— 这里认「默认第二参 false + 第三参省略」这两件事实质，不是放宽。
    // ⚠️ B260 二次换锚：B260 让这一支带上交接游标（没收口 ⇒ 整趟按交出的源推，交的值
    //    就是收口那一格的口径），判据跟着认「第二参显式 false + 第三参只带换游标」，
    //    仍然只盯「不播跨窗口」这一件事实质，没放宽成抹掉调用本身。
    expect(tabsSrc, "切激活文档那路不播").toMatch(
      /if \(tab && !aligned\) \{\n\s*pushSyncToSiblings\(tab, false, \{ v: handV, atFloor: srcAtFloor \}\);\n/,
    );
    // ⚠️ B251 换锚：单参 `v`（旧写法是 `px, line` 两个 —— 「跨侧只交整数块首」那两个
    //    补丁的产物，正是 B247「每切一轮往上掉」的病根）。
    // ⚠️ B286 再换锚：第三参 `atFloor`（「源顶没顶到自己的底」）必须一起交给广播 ——
    //    跨窗口那一侧原先只带 `{docId, srcTabId, v}`，对端永远不知道源已到底 ⇒ 只能按
    //    游标换算 ⇒ 落 828 而非自己那一侧的底 864（用户报：多窗口同步滚动对不齐）。
    expect(PUSH_BODY, "广播排在最后（本地先对齐，别人接手时落点一致）").toMatch(
      /broadcastSyncPos\(src, v, atFloor\);/,
    );
  });

  it("三个触发点都显式打开了 crossWindow", () => {
    const scroll = slice(
      tabsSrc,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(scroll, "编辑器里滚要往外播").toMatch(/if \(t\) pushSyncToSiblings\(t, true\);/);
    const preview = slice(tabsSrc, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    expect(preview, "预览里滚也要往外播").toMatch(/pushSyncToSiblings\(t, true\);/);
    expect(CLICK_BODY, "按下开关那一刻也要播（先播状态，再播位置）").toMatch(
      /emitCrossWindow\(EVT_SYNC_MODE, \{ docId: tab\.docId, on \}\)/,
    );
  });

  it("位置广播要带齐四样：谁发的、哪个文档、哪一份是源、坐标", () => {
    // `from` 是必填的自证字段（tauri 的广播本机也会收到自己的回声），缺了就分不清。
    expect(PUSH_BODY, "from 由 emitCrossWindow 注入（不再手写）").toMatch(
      /emitCrossWindow\(EVT_SYNC_POS, \{/,
    );
    expect(PUSH_BODY, "文档 ID 不能少").toMatch(/docId: src\.docId,/);
    expect(PUSH_BODY, "源那份的 tabId 不能少（对端要跳过它）").toMatch(/srcTabId: src\.tabId,/);
    // ⚠️ B251：坐标只有**一种东西** —— 规范游标 `v`。旧签名是 `px` + `line` 两个（源那侧
    //    是预览就只有 line、是源码就只有 px，对端按自己那一侧挑）；合成一个 `v` 之后
    //    对端也不必再按「自己哪一侧」挑坐标，少一层分支就是少一处失配。
    // ⚠️ 签名收口到 "); 免得只命中注释里那句「v 一起带」。
    // ⚠️ B286 换锚：第三参 `atFloor = false`（到底锚点，见 `tabAtOwnFloor`）——
    //    没有它，跨窗口广播就说不出「源已到底」，对端只能按游标 v 换算。
    expect(PUSH_BODY, "签名要收口").toMatch(
      /function broadcastSyncPos\(src: Tab, v: number \| null, atFloor = false\)/,
    );
    // ⚠️⚠️ B286：payload 里必须真的写出 `atFloor`。签名有形参 ≠ 载荷带字段 ——
    //    这条盯的是「字段真的进了 payload」，与上一行（签名）各管一半。
    expect(PUSH_BODY, "到底状态要真的进载荷（少了它，对端按 v 换算就会对不齐）").toMatch(
      /emitCrossWindow\(EVT_SYNC_POS, \{[\s\S]{0,120}?atFloor,/,
    );
  });

  it("接收端只认别的窗口：自己的回声一律丢", () => {
    // 与文档同步那三条同口径 —— 少了这条，自己滚一下会把自己再推一遍（抖动来源）。
    expect(POS_RCV, "from 必须与本窗口比对").toMatch(/from === windowLabel/);
    expect(POS_RCV, "srcTabId 也要跳过").toMatch(/other\.tabId === srcTabId/);
    expect(POS_RCV, "开关没开就别动").toMatch(/docSyncModes\.get\(docId\) !== true\) return;/);
    expect(POS_RCV, "要落在自己那份同源实例上").toMatch(/instancesOfDoc\(docId\)/);
  });

  it("接收端不许回推：跟本地兄弟用同一个落点函数", () => {
    // 回环是靠 scroll-guard 的 `isProgrammatic` 标记挡的（两条滚动监听首行都认它），
    // 所以接收端也必须走 `applySyncToSibling` —— 那条里钉位置由 `pinScrollTop` 标程序来源。
    // ⚠️ 判据放行号：`applySyncToSibling(other,` 被 prettier 折成了三行。
    expect(POS_RCV, "复用本地那一份落点逻辑").toMatch(/applySyncToSibling\(\s*other,/);
    expect(POS_RCV, "不许自己再钉一次").not.toMatch(/pinScrollTop\(/);
    expect(POS_RCV, "不许自己再开广播").not.toMatch(/broadcastSyncPos\(/);
  });

  it("开关状态要跨窗口对齐，并且两种窗口都装监听", () => {
    expect(RECV_BODY, "收到远端开关要写进本窗口的状态").toMatch(/docSyncModes\.set\(docId, on\);/);
    expect(RECV_BODY, "要顺手刷新按钮点亮态").toMatch(/refreshSyncButton\(activeTab\(\)\)/);
    expect(RECV_BODY, "自己的回声要丢").toMatch(/from === windowLabel/);
    // 装监听：主窗口与卫星窗口都要装，`listenDocSync()` 那句调用点就是这条契约。
    expect(LISTEN, "同步滚动那两条挂在 listenDocSync 里").toMatch(/EVT_SYNC_MODE/);
    expect(LISTEN, "位置那条也是").toMatch(/EVT_SYNC_POS/);
    expect(main, "两种窗口都要装同步监听（老契约不能破）").toMatch(/listenDocSync\(\);/);
  });

  it("位置那一路的落点纪律只有一份（抽出来的函数被两边共用）", () => {
    // 这是 B159 最容易写错的地方：把接收端另写一份「简化版」，于是跨视图模式那条
    // 纪律（B154）在网络这一侧悄悄丢掉 —— 表现为「一个预览一个源码时跨窗口不同步」。
    expect(PUSH_BODY, "抽取后的落点函数要留在推送段里").toContain("function applySyncToSibling(");
    // ⚠️ B251 换锚：单参 `v`（旧写法两个实参，是「跨侧只交整数块首」时期的遗骸）。
    expect(main2, "本地循环要调它").toMatch(/applySyncToSibling\(other, v\);/);
    // ⚠️ 判据放行号：`applySyncToSibling(other,` 被 prettier 折成了三行。
    expect(mwSrc, "接收端也调同一个").toMatch(/applySyncToSibling\(\s*other,/);
  });
});

// ------------------------------------------------- B160：双向同步的两个空洞
describe("B160 同步滚动双向打通（用户报：滚源码预览抖 / 滚预览源码不动）", () => {
  /** 预览侧的行首对齐写法 —— 用来对表源码分支换算出来的那套坐标。 */
  const HOST = slice(tabsSrc, "scrollToLine: (line: number) => {", "lineCount: () =>");

  it("源码兄弟要认行号：源是预览侧时 px 恒为 null，不能因此就不动", () => {
    // 用户报「滚动预览，源码文档没有同步滚动」。`pushSyncToSiblings` 对预览态的源
    // 只交得出 `line`（纪律 2：预览侧交不出编辑器像素），旧写法在 `px === null` 时
    // 直接 return ⇒ 源码兄弟一动不动，而那个行号早就算好了，只是没人用。
    expect(PUSH_BODY, "源码分支不许再只看 px 就 return").not.toMatch(
      /if \(px === null \|\| !shownView\) return;/,
    );
    // ⚠️ B248：第一参从 `shownView` 换成 `view` —— 离屏源码兄弟没视图时，拿同文档的
    //    **另一个源码态视图**量 `lineBlockAt`（排版一致 ⇒ 等价于量它自己）换算。
    //    ⚠️ B251 再换锚、本轮复验：落点出口现在叫 `sourceTopOfV`（`editorLineTopPx`
    //    退化成它的「取行顶」内部件），交的是**同侧**那一档 `v` 的小数（行内比例，由它
    //    自己按行高插值）；跨侧那一档小数恒 0。判据仍是「换算出来的像素要真的被用上」。
    expect(PUSH_BODY, "换算出来的行号要真的用上").toContain("const top = sourceTopOfV(view, v);");
    // ⚠️ B242：跨侧落点只给**行首**，不再按行内比例插值 —— 那串 frac 是**编辑器行内**
    //   的比例，从预览侧搬过来量的是「块内」，往返不等值 ⇒ 每切一轮吃掉一点（用户报
    //   「来回切位置会变化」的一路成因）。行首两边都有确定对应，来回切恒等。
    //   同一口径就是切源码/预览那一路（toggleViewMode 的 handoff 走同一个函数）。
    expect(PUSH_BODY, "跨侧落点走行首换算，不许自己搬 frac").toMatch(
      /pinScrollTop\(shownView\.scrollDOM, top\);/,
    );
    // ⚠️ 与预览那侧的 `SyncHost.scrollToLine` 必须是**同一套**坐标，否则两个方向
    //    各自算一套，来回同步一次就偏一次（B160 这次抖动的另一半原因）。
    expect(
      HOST,
      "预览侧落点走 sourceTopOfV（与跨侧同步同出口：支持小数、末行按整行高贴顶）",
    ).toMatch(/const top = sourceTopOfV\(v, Math\.min\(Math\.max\(line, 1\)/);
    expect(HOST, "预览侧把顶行像素落进编辑器滚动槽").toMatch(/v\.scrollDOM\.scrollTop = top;/);
  });

  it("换算之后也要钉进还原窗口，并把落点补记一次", () => {
    // 与 px 那个分支同一条纪律 3：不套窗口，兄弟那一发 scroll 就会被记成「用户停过
    // 的位置」，再顺着它的滚动监听推回源 —— 两个面板互相拉。
    expect(PUSH_BODY, "换算那路也要走 pinScrollTop（标程序来源、回执被吞）").toMatch(
      /pinScrollTop\(shownView\.scrollDOM, top\);/,
    );
    // ⚠️ 落点必须记：位置只活在 DOM 上，钉完不补记，这份实例的位置等于从没被记过。
    //    也不许把 `null` 倒进源码兄弟的槽 —— 那等于把它的位置抹成「从没显示过」。
    expect(PUSH_BODY, "换算后要补记落点").toMatch(/recordScroll\(other\.tabId, top\);/);
  });

  it("同步定位不留「待重定位」的尾巴（否则预览被异步重排反复拽回去）", () => {
    // 用户报「滚动源码，预览文档位置会抖动」。`syncToLine` 记 `pendingSyncLine` 是给
    // 大纲跳转这类**一次性**目标用的（增强 / 图片 load 后按目标行再定位一次）。同步
    // 滚动的目标行每帧都在变，把它记下来，等于给每一次重排留一个「把预览拽回某行」
    // 的钩子 ⇒ 图片 / KaTeX / Shiki 一增强完，预览就自己跳一下。
    // B162：纪律收进 `syncToLineProgrammatic`（程序定位入口自带「不留尾巴」+ 程序定位
    // 窗口），调用点换过去；入口自身「不留尾巴」在 preview-sync 那侧盯。
    // ⚠️ 本轮换锚：小数不再被 `Math.floor` 掐掉 ⇒ 直接交完整那份 `v`（预览侧按块内比例
    //    插值）。这条**正向**判据盯的是「不许退回 syncToLine」。
    expect(PUSH_BODY, "预览分支要走程序定位入口").toMatch(/preview\.syncToLineProgrammatic\(v\)/);
    expect(PUSH_BODY, "不许再走会留尾巴的 syncToLine").not.toMatch(/preview\.syncToLine\(line\)/);
  });

  it("预览的程序定位走 syncToLineProgrammatic（标来源、不留尾巴），且落点补记在其后", () => {
    // B170：预览跨面板同步走 `syncToLineProgrammatic` —— 它内部 `markProgrammatic` 标来源，
    // 回执由预览监听经 scroll-guard 吞掉；且不留 `pendingSyncLine` 尾巴（B162）。不再套
    // `restoringViewport` 还原窗口（B170 删了那套时间窗）。
    expect(PUSH_BODY, "预览分支要走程序定位入口").toMatch(/preview\.syncToLineProgrammatic\(v\);/);
    // 落点显式补记（程序定位不写快照）：必须排在 syncToLineProgrammatic 之后。
    // ⚠️ 本轮换锚：交的是**同侧**那份 `v`（旧写法 `Math.floor(line)` 会把块内比例掐掉）。
    const atSync = PUSH_BODY.indexOf("preview.syncToLineProgrammatic(v);");
    const atRecord = PUSH_BODY.indexOf("recordScroll(other.tabId, landed);");
    expect(atSync, "要能定位程序定位入口那句").toBeGreaterThan(-1);
    expect(atRecord, "要能定位补记那笔").toBeGreaterThan(-1);
    expect(atRecord, "补记要排在程序定位之后").toBeGreaterThan(atSync);
  });

  it("B170 预览滚动监听要把程序回执吞掉（否则回推源码成闭环）", () => {
    // 预览监听首行认 `isProgrammatic(preview.root)`：程序钉位的回执（跨面板同步钉位、
    // 会话恢复、setBlocks 恢复、异步二次定位）一律被吞（不写快照、不推兄弟），只排程落盘；
    // 真用户滚动时标记已被清，才会落到推兄弟那一路。
    const listener = slice(tabsSrc, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    expect(listener, "要能定位预览滚动监听体").not.toBe("");
    expect(listener, "守卫里必须有程序回执判据").toContain("if (isProgrammatic(preview.root))");
    expect(listener, "挡住之后仍要排程落盘").toContain("scheduleSessionSave();");
  });
});

describe("B154 / B157 样式：方形图标键，状态只靠图标颜色", () => {
  /**
   * 这一族的全体成员（B157 起同款，写在同一条规则里，不许各写一份）。
   * ⚠️ **要加就得加列这儿**：标题栏每添一颗同款键（B198 那颗 layout-btn 就是），
   *    成员少了这条「同款」判定就漏看一颗，新键会悄悄退回 46px 方键那一批。
   */
  const FAMILY = [".sync-btn", ".title-btn.pin-btn", ".title-btn.upd-btn", ".title-btn.layout-btn"];

  it("覆盖 .title-btn 那批的尺寸与铺底（写在它们之后才压得住）", () => {
    // 46px 满高 + 悬停淡底都是共用声明给的，这一族不要它们。
    const shared = css.indexOf(".win-btn,\n.title-btn,\n.menu-btn {");
    // ⚠️ 锚点取选择器列表的第一个成员 + 逗号：规则已扩成「同步滚动 / 始终在最前 /
    //    在线更新」一条（B157），再写死 `.sync-btn {` 就定位不到了。
    const btn = css.indexOf(".sync-btn,");
    expect(shared, "要能定位共用声明").toBeGreaterThan(-1);
    expect(btn, "要能定位方形图标键那族").toBeGreaterThan(-1);
    expect(btn, "必须写在共用声明之后").toBeGreaterThan(shared);
    // 方形：宽高都给死，别再吃 width:46px / height:100%。
    const block = slice(css, ".sync-btn,", "}");
    expect(block, "要给方形尺寸").toMatch(/width:\s*24px;/);
    expect(block, "要给方形尺寸").toMatch(/height:\s*24px;/);
    expect(block, "常态背景必须是透明的（没有按钮背景）").toMatch(/background:\s*transparent;/);
  });

  it("「始终在最前」与「在线更新」必须跟同步滚动同款（B157 用户原话）", () => {
    // 判据落在**同一条规则**上：拆成三条各自漂移，标题栏里就会出现「两种按钮」。
    const block = slice(css, ".sync-btn,", "}");
    for (const sel of FAMILY.slice(1)) {
      expect(block, `${sel} 必须在这条共享规则里`).toContain(sel);
    }
    expect(block, "三者同一个圆角/尺寸，不许各自再写一份").not.toMatch(/pin-btn \{/);
    // 反向自证：不是因为压根没写 pin/upd 才通过（这个断言查的是 index.html，不是 css）
    expect(html, "pin-btn 类确实用在 #win-pin 上").toMatch(/class="title-btn pin-btn"/);
    expect(readFileSync("src/shell/updater.ts", "utf-8"), "在线更新那颗键也走同一族").toMatch(
      /className = "title-btn upd-btn"/,
    );
  });

  it("更新键自己的尺寸要按 24px 重算（46px 方键那两个数值搬不过来）", () => {
    // 26px 的进度条塞進 24px 键会顶边；提示点贴角放。
    const bar = slice(css, ".title-btn.upd-btn .upd-bar {", "}");
    expect(bar, "要能定位进度条").toMatch(/width:\s*18px;/);
    const dot = slice(css, ".title-btn.upd-btn.has-update::after {", "}");
    expect(dot, "提示点要贴在 24px 键的角上").toMatch(/top:\s*2px;/);
    expect(dot, "提示点不许掉出键外").toMatch(/right:\s*2px;/);
  });

  it("hover 也不铺底：状态一律只落在图标颜色上", () => {
    const hover = slice(css, ".sync-btn:hover,", "}");
    expect(hover, "要能定位共享 hover 规则").toContain("color: var(--fg)");
    expect(hover, "hover 不许铺底").not.toMatch(/background:\s*var\(--bg-hover\)/);
    // `.sync-btn` 是这条列表的**头**，后面那几颗各自补 `:hover`
    for (const sel of FAMILY.slice(1)) {
      expect(hover, `这一族「${sel}:hover」都要覆盖到`).toContain(`${sel}:hover`);
    }
    // B166：字形改成 link / unlink 切换，但开态强调色**保留**（用户拍板）——
    // 仍走那条全局规则（特异度 0-2-0，盖得住 hover 的 color），别另起一套。
    expect(css, "点亮态只上色图标").toMatch(
      /\.title-btn\.is-on \.codicon \{[\s\S]*?color: var\(--accent\);/,
    );
  });
});

describe("B152 样式：hidden 必须显式生效", () => {
  it(".title-btn 那条共用声明压过 UA 的 [hidden]，所以得自己补一条", () => {
    expect(css, "必须有 .sync-btn[hidden]").toMatch(
      /\.sync-btn\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    );
    expect(css, "按钮不许被 .title-btn 的 inline-flex 撑开占位").toMatch(/\.sync-btn,/);
  });
});

// ------------------------------------------------------- 反向验证
// 把上面的实现退回两种错的写法，对应用例必须变红 —— 否则「改了等于没改」，
// 静态契约就会变成假绿（viewport-restore / session-scroll-integral 各自栽过一次）。
describe("B154 / B166 字形：link（链条），随开关在 link / unlink 间切换", () => {
  it("字形取 link —— 链条画的正是「这几份连在一起」，且不跟更新键那族撞形", () => {
    const cod = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(cod, "link 字形要在取用层登记").toMatch(/^\s*link: "link",/m);
    // 短名要真的能在 codicon 字体里取到字 —— 写个名字不存在的字形就是一枚空白方块。
    const codiconCss = readFileSync("node_modules/@vscode/codicons/dist/codicon.css", "utf-8");
    expect(codiconCss, "codicon 字体里要有 link 这一码位").toMatch(/\.codicon-link:before/);
  });

  it("B166：refreshSyncButton 要按开关切换字形（link / unlink）", () => {
    // B166 起状态落在**字形**上（开 = link 连着、关 = unlink 链环分开），
    // 与置顶键的 pinned / pin 同一口径；启动兜底给「未开启」那颗。
    expect(BTN_BODY, "字形要由开关值决定").toMatch(
      /syncScrollBtn\.innerHTML = on \? CODICONS\.link : CODICONS\.unlink;/,
    );
    const setup = slice(commandsSrc, "function setupTitleBar(", "\nfunction ");
    expect(setup, "启动兜底要给未开启态的字形").toContain(
      "syncScrollBtn.innerHTML = CODICONS.unlink;",
    );
  });
});

// ------------------------------------------------------- B164：子窗口的同步滚动
describe("B164 子窗口也要能同步滚动（跨窗口广播）", () => {
  it("显隐不按窗口身份分叉：子窗口与主窗口同口径，只数本窗口实例（B171）", () => {
    // B164 曾用 `sharedDocIds` 给子窗口开后门：卫星收下的文档主窗口还攥着（隐藏实例），
    // 于是子窗口里单开一份也露脸 —— 可主窗口数那份也只算 1 份、同场景是**藏**着的，
    // 两边对不上；何况同步到一个看不见的实例没有意义。现在一律只看 `instancesOfDoc`。
    expect(BTN_BODY, "判据里不许再有共享文档集合").not.toMatch(/sharedDocIds/);
    // B173：连本窗口的**隐藏**实例（`panelId < 0`，搬到别的窗口后留下的那份）也不算 ——
    // 它进不了任何面板，按它凑出「第 2 份」就会让「只开了一份」的窗口露出这颗键。
    expect(BTN_BODY, "判据 = 本窗口可见实例 > 1 或 远端窗口也开着这份（B178 跨窗口）").toMatch(
      /visibleInstancesOfDoc\(tab\.docId\)\.length > 1 \|\| remoteHasDoc\(tab\.docId\)/,
    );
    expect(BTN_BODY, "不许再把隐藏实例算进份数").not.toMatch(
      /const multi = !!tab && instancesOfDoc\(tab\.docId\)\.length > 1;/,
    );
    // 也不许拿窗口身份再给子窗口开口子（开了就绕回「子窗口单开也露脸」）
    expect(BTN_BODY, "显隐不许看窗口身份").not.toMatch(/windowKind/);
  });

  it("没有本地兄弟也要广播（否则子窗口滚动带不动主窗口）", () => {
    // 卫星窗口里同文档只有一份本地实例，旧写法 `if (sibs.length === 0) return;`
    // 会把末尾的 `broadcastSyncPos` 一并跳过 —— 位置广播根本出不了子窗口。
    expect(PUSH_BODY, "提前 return 必须给广播让路").toMatch(
      /if \(sibs\.length === 0 && !crossWindow\) return;/,
    );
    expect(PUSH_BODY, "不许退回无条件 return").not.toMatch(/if \(sibs\.length === 0\) return;/);
    expect(PUSH_BODY, "广播那半段还在函数末尾").toMatch(/if \(crossWindow\) broadcastSyncPos\(/);
  });

  it("反向验证：退回旧写法，上面两条必须落空", () => {
    // ① 显隐再掺进「别的窗口也有一份」（B164 的 `sharedDocIds`）⇒ 子窗口单开也露脸
    const i = ui.indexOf("const multi =");
    expect(i, "要能定位显隐判据").toBeGreaterThan(-1);
    const degradedBtn =
      ui.slice(0, i) +
      "const multi = !!tab && (instancesOfDoc(tab.docId).length > 1 || sharedDocIds.has(tab.docId));" +
      ui.slice(ui.indexOf(";", i) + 1);
    const btnBody = slice(degradedBtn, "function refreshSyncButton(", "function refreshStatus(");
    expect(btnBody, "退化后「不许有共享文档集合」必须命中").toMatch(/sharedDocIds/);
    // ①b B173：退回「把隐藏实例也算一份」⇒ 只开了一份的窗口照样露脸
    const degradedHidden =
      ui.slice(0, i) +
      "const multi = !!tab && instancesOfDoc(tab.docId).length > 1;" +
      ui.slice(ui.indexOf(";", i) + 1);
    const hiddenBody = slice(
      degradedHidden,
      "function refreshSyncButton(",
      "function refreshStatus(",
    );
    expect(hiddenBody, "退化后「隐藏实例不算数」必须落空").toMatch(
      /const multi = !!tab && instancesOfDoc\(tab\.docId\)\.length > 1;/,
    );
    expect(hiddenBody, "退化后就不认可见实例了").not.toMatch(/visibleInstancesOfDoc/);
    // ② 提前 return 不给广播让路
    const ORIG = "if (sibs.length === 0 && !crossWindow) return;";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degradedPush = main2.replace(ORIG, "if (sibs.length === 0) return;");
    const pushBody = slice(
      degradedPush,
      "function pushSyncToSiblings(",
      "function flushPendingSyncCursor(",
    );
    expect(pushBody, "退化后「不许无条件 return」必须命中").toMatch(
      /if \(sibs\.length === 0\) return;/,
    );
  });
});

// ------------------------------------------------------- B167：同步滚动抖动的根因
describe("B167 同步滚动抖动：选区派发不许自带滚动 + 回推要能被日志点名", () => {
  it("给兄弟派发选区必须带 scrollIntoView: false（CM6 的自动滚动会晚一帧落地）", () => {
    // CM6 为了让光标可见会自己滚一下，而它排的是**下一帧的 measure** —— 等它落地，
    // 包住这次同步的两帧还原窗口早关上了，那一发 scroll 就被当成「用户在滚」推回源，
    // 两边来回拉（用户反复报的抖动）。位置由 applySyncToSibling 统一钉，这下是多余的。
    expect(PUSH_BODY, "派发选区必须关掉自动滚动").toMatch(
      /shownView\.dispatch\(\{ selection: \{ anchor: pos \}, scrollIntoView: false \}\);/,
    );
  });

  it("两条滚动监听都要用 isProgrammatic 吞掉自家程序回执（否则回推成闭环）", () => {
    // B170：程序钉位的回执由 scroll-guard 标记认领、直接吞掉——这是抖动根除的关键，
    // 两条监听（编辑器 / 预览）都必须有这道守卫，且排在推兄弟之前。
    expect(scrollBodyOf(tabsSrc), "编辑器监听要吞程序回执").toContain(
      "if (isProgrammatic(shownView.scrollDOM)) return;",
    );
    const previewScroll = slice(
      tabsSrc,
      'preview.root.addEventListener("scroll"',
      "applyPanelMode(p);",
    );
    expect(previewScroll, "预览监听也要吞程序回执").toContain("if (isProgrammatic(preview.root))");
  });

  it("B167 反向验证：退回两处旧写法，上面两条必须落空", () => {
    const ORIG = "shownView.dispatch({ selection: { anchor: pos }, scrollIntoView: false });";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degradedPush = main2.replace(ORIG, "shownView.dispatch({ selection: { anchor: pos } });");
    const pushBody = slice(
      degradedPush,
      "function pushSyncToSiblings(",
      "function flushPendingSyncCursor(",
    );
    // ⚠️ 判据要盯**调用**（`dispatch({…scrollIntoView: false}`）：源码注释里也提到这个
    //    选项名，只判 `scrollIntoView: false` 会连注释一起命中 ⇒ 退化用例假绿。
    expect(pushBody, "退化后「必须关掉自动滚动」必须落空").not.toMatch(
      /dispatch\(\{[^}]*scrollIntoView: false/,
    );

    const GUARD = "if (isProgrammatic(shownView.scrollDOM)) return;";
    expect(tabsSrc, "退化串要先自证原句还在").toContain(GUARD);
    const degradedGuard = tabsSrc.replace(
      /if \(isProgrammatic\(shownView\.scrollDOM\)\) return;/,
      "// (B170 退化：摘掉程序回执判定)",
    );
    expect(scrollBodyOf(degradedGuard), "退化后编辑器监听不再吞程序回执").not.toContain(
      "if (isProgrammatic(shownView.scrollDOM)) return;",
    );
  });
});

// ------------------------------------------------------- B170：彻底屏蔽「自家滚动回执」
// 旧的拉锯根因：回环闸门靠 `viewportWriteDepth` / `restoringViewport` 的**两帧窗口**赌时序，
// 而图片异步加载 / 字体测量补偿 / 大文档重排会把那一发 scroll 拖到窗口之外 ⇒ A↔B 来回推。
// 新机制不赌时序、也不比位置：每次程序定位赋值前对目标 `markProgrammatic(el)`（合成 VS Code
// `scrollType`），目标自己的 scroll 监听见标记即吞（见 src/scroll-guard.ts）；标记靠用户
// 接管滚动的真实输入清除，**黏性**保留到那一刻，对几百 ms 后的迟到回执也免疫。
describe("B170 同步滚动抖动：彻底屏蔽「自家滚动回执」被当成用户滚动", () => {
  it("两条滚动监听在推兄弟之前认「程序来源标记」并直接吞掉（不赌时序、不比位置）", () => {
    const editor = scrollBodyOf(tabsSrc);
    expect(editor, "编辑器监听要认程序来源标记").toContain(
      "if (isProgrammatic(shownView.scrollDOM)) return;",
    );
    const previewScroll = slice(
      tabsSrc,
      'preview.root.addEventListener("scroll"',
      "applyPanelMode(p);",
    );
    expect(previewScroll, "预览监听也要认程序来源标记").toContain(
      "if (isProgrammatic(preview.root))",
    );
    // 两道都要排在「推兄弟」之前，否则回环闸门形同虚设（与 B154 那一条同口径）。
    const atSelf = editor.indexOf("if (isProgrammatic(shownView.scrollDOM)) return;");
    const atPush = editor.indexOf("pushSyncToSiblings(t, true)");
    expect(atSelf, "要能定位程序回执判定").toBeGreaterThan(-1);
    expect(atPush, "要能定位推同步那句").toBeGreaterThan(-1);
    expect(atPush, "推同步要排在程序回执判定之后").toBeGreaterThan(atSelf);
  });

  it("pinScrollTop 每次钉位前都标程序来源（黏性标记，回执被吞）", () => {
    // 只有标了来源，scroll 事件到达时滚动监听才能认出这是「我们刚摆的位置」的回执。
    expect(PIN_BODY, "逐帧补钉每次赋值前都要标").toContain("markProgrammatic(el);");
  });

  it("预览的程序定位回执判定认程序来源标记（不再靠 120ms 锁赌时序）", () => {
    const onScroll = slice(PREVIEW_TS, "private onPreviewScroll(", "private blockAtLine(");
    expect(onScroll, "回执判定要认程序来源标记").toContain(
      "if (isProgrammatic(this.root)) return;",
    );
  });

  it("B170 反向验证：摘掉程序回执判定 → 上面「两条监听认回执」必须落空", () => {
    // ⚠️ 退化串要连着缩进：那段的注释里也提到 isProgrammatic 这个名字，只按裸名 replace
    //   会把注释里那句也换掉，退化版「什么都没改」⇒ 反向验证静默失效。
    const ORIG = "          if (isProgrammatic(shownView.scrollDOM)) return;";
    expect(tabsSrc, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = tabsSrc.replace(ORIG, "          // (B170 退化：摘掉程序回执判定)");
    const editor = slice(
      degraded,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(editor, "退化后编辑器监听不再认程序回执").not.toContain(
      "if (isProgrammatic(shownView.scrollDOM)) return;",
    );
  });

  it("B170 反向验证：摘掉 pinScrollTop 的标记 → 上面「钉位前标来源」必须落空", () => {
    expect(PIN_BODY, "退化串要先自证原句还在").toContain("markProgrammatic(el);");
    const degraded = PIN_BODY.replace(/markProgrammatic\(el\);/, "");
    expect(degraded, "退化后钉位不再标来源").not.toContain("markProgrammatic(el)");
  });
});

// ------------------------------------------------------- B169：预览驱动编辑器滚动要被当成自家回执
// 预览的 onPreviewScroll 通过 host.scrollToLine 把编辑器滚到对应行；这一发编辑器滚动若不
// 标记成「程序摆位」，编辑器监听会把它当作用户滚动 → 反推预览 → 预览又被推回 → 拉锯 /
// 抖动（用户报的「非激活文档滚动抖」「预览跟随整文档重渲染」同源）。修法：scrollToLine
// 摆位时 `markProgrammatic(v.scrollDOM)`（B170 的 scroll-guard 合成来源标记）。
describe("B169 同步滚动抖动：预览驱动编辑器滚动要被当成自家回执吞掉", () => {
  const HOST = slice(tabsSrc, "scrollToLine: (line: number) => {", "lineCount: () =>");

  it("host.scrollToLine 摆位时要 markProgrammatic（预览驱动编辑器滚动标成程序回执）", () => {
    expect(HOST, "要能定位 scrollToLine 回调").toContain("scrollToLine: (line: number) => {");
    expect(HOST, "预览驱动编辑器滚动要标记成程序回执").toMatch(/markProgrammatic\(v\.scrollDOM\);/);
    expect(HOST, "算出的顶行要先收进局部变量 top（走 sourceTopOfV 换算）").toMatch(
      /const top = sourceTopOfV\(v, Math\.min\(Math\.max\(line, 1\)/,
    );
    expect(HOST, "要把 top 落进编辑器滚动槽").toMatch(/v\.scrollDOM\.scrollTop = top;/);
  });

  it("B169 反向验证：摘掉 markProgrammatic → 上面那条必须落空", () => {
    expect(HOST, "退化串要先自证原句还在").toContain("markProgrammatic(v.scrollDOM);");
    const degraded = HOST.replace(/markProgrammatic\(v\.scrollDOM\);/, "");
    expect(degraded, "退化后 scrollToLine 不再标记程序回执").not.toMatch(
      /markProgrammatic\(v\.scrollDOM\)/,
    );
  });
});

// ------------------------------------------------------- B169：卫星窗口采纳标签要带上同步滚动开关
// docSyncModes 按窗口记、不落盘；主窗口把文档拖进卫星窗口时，载荷（SatelliteTab）若不带上
// 同步滚动开关，子窗口那份就永远是 off，跟主窗口点亮态对不上（用户报「子窗口的同步按钮
// 状态和主窗口的要一致」）。修法：载荷加 syncMode 字段，子窗口采纳时接进本窗口状态。
describe("B169 卫星窗口同步键状态要与主窗口一致", () => {
  it("SatelliteTab 载荷要带 syncMode 字段", () => {
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "同步滚动开关要随标签一起走（可选字段）").toMatch(/\bsyncMode\??:\s*boolean/);
  });

  it("transferSnapshotOf 要把本窗口的开关值写进载荷", () => {
    const BODY = slice(mwSrc, "function transferSnapshotOf(", "function remoteTabLocally(");
    expect(BODY, "要能定位 transferSnapshotOf").toContain("function transferSnapshotOf(");
    expect(BODY, "载荷里要写 syncMode").toMatch(
      /syncMode:\s*docSyncModes\.get\(tab\.docId\) === true/,
    );
  });

  it("adoptTransferredTabs 要把收到的 syncMode 接进本窗口状态", () => {
    const BODY = slice(mwSrc, "function adoptTransferredTabs(", "function returnTabsToMain(");
    expect(BODY, "要能定位 adoptTransferredTabs").toContain("function adoptTransferredTabs(");
    expect(BODY, "收到 on 要把 docSyncModes 置真").toMatch(
      /if \(st\.syncMode\) docSyncModes\.set\(st\.docId, true\);/,
    );
  });

  it("B169 反向验证：摘掉采纳时接状态 → 上面那条必须落空", () => {
    const ORIG = "    if (st.syncMode) docSyncModes.set(st.docId, true);";
    expect(mwSrc, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = mwSrc.replace(ORIG, "");
    const BODY = slice(degraded, "function adoptTransferredTabs(", "function returnTabsToMain(");
    expect(BODY, "退化后不再接 syncMode 进本窗口状态").not.toMatch(
      /if \(st\.syncMode\) docSyncModes\.set\(st\.docId, true\);/,
    );
  });
});

// ------------------------------------------------------- B169：同步滚动开关落盘到会话并恢复
// 用户诉求：「同步滚动开关状态也保存到 session 文件中，应用重新打开时进行恢复」。
// 落盘链路：refreshSession 把 docSyncModes（按文档记）刷进会话记录 → toDisk 序列化 →
// Rust TabSession 落盘；恢复链路：restoreSession 读回 syncMode → 写回 docSyncModes。
describe("B169 同步滚动开关落入会话文件并恢复", () => {
  const STORE = readFileSync("src/session/store.ts", "utf-8").replace(/\r\n/g, "\n");
  const API = readFileSync("src/ipc/api.ts", "utf-8").replace(/\r\n/g, "\n");

  it("TabSession 落盘结构要带 syncMode 可选字段", () => {
    // 与 SatelliteTab 的 syncMode 同源（B169 跨窗口那一支），这里保证「落盘那份」也有。
    expect(API, "TabSession 要带 syncMode").toMatch(/syncMode\??:\s*boolean/);
  });

  it("toDisk 要把记录的 syncMode 写进落盘结构", () => {
    expect(STORE, "落盘要带 syncMode").toMatch(/syncMode: r\.syncMode,/);
  });

  it("refreshSession 退出前把 docSyncModes 的开关刷进会话记录", () => {
    expect(sessSrc, "刷新要把同步开关刷进记录").toMatch(
      /sessionStore\.setSyncMode\(t\.tabId, docSyncModes\.get\(t\.docId\) === true\)/,
    );
  });

  it("restoreSession 要把读到的 syncMode 写回 docSyncModes", () => {
    expect(sessSrc, "恢复要把 syncMode 写回 docSyncModes").toMatch(
      /if \(st\.syncMode\) docSyncModes\.set\(inst\.docId, true\);/,
    );
  });

  it("B169 反向验证：摘掉 toDisk 的 syncMode 写 → 上面那条必须落空", () => {
    const ORIG = "    syncMode: r.syncMode,";
    expect(STORE, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = STORE.replace(ORIG, "");
    expect(degraded, "退化后落盘不再带 syncMode").not.toMatch(/syncMode: r\.syncMode,/);
  });

  it("B169 反向验证：摘掉恢复写回 → 上面那条必须落空", () => {
    // ⚠️ 不写死缩进：这行住在 `buildInstance` 里，抽函数/改嵌套会改变它的缩进，
    // 写死的字面量会「找不着原句」而红（B193 抽 buildInstance 时就红过一次）。
    // 改成先按行匹配取出原句再删 —— 既是自证（取不到就红），也不受排版影响。
    const found = sessSrc.match(
      /^[ \t]*if \(st\.syncMode\) docSyncModes\.set\(inst\.docId, true\);$/m,
    );
    expect(found, "退化串要先自证原句还在").not.toBeNull();
    const degraded = main.replace(found![0], "");
    expect(degraded, "退化后不再把 syncMode 写回 docSyncModes").not.toMatch(
      /if \(st\.syncMode\) docSyncModes\.set\(inst\.docId, true\);/,
    );
  });
});

describe("B152 反向验证：退回旧写法，上面那几条必须变红", () => {
  it("退回「单开一份也露脸」→ 显隐那两条必须落空", () => {
    // ⚠️ 退化串按位置取，不按字面量 replace：判据的排版变过好几轮（B164 折成两行、
    //    B171 又回到单行），只认老单行字面量会静默空转（B163 踩过同一坑）。
    const i = ui.indexOf("const multi =");
    expect(i, "要能定位显隐判据").toBeGreaterThan(-1);
    const degraded = ui.slice(0, i) + "const multi = !!tab;" + ui.slice(ui.indexOf(";", i) + 1);
    expect(degraded, "退化后不该再有可见实例数判据").not.toMatch(
      /visibleInstancesOfDoc\(tab\.docId\)\.length > 1/,
    );
    expect(degraded, "「显隐要按可见实例个数判」此时必须落空").not.toMatch(
      /visibleInstancesOfDoc\(tab\.docId\)\.length > 1/,
    );
  });

  it("退回「按 tabId 记状态」→ 「切换激活文档不复位」必须落空", () => {
    const ORIG = "const on = docSyncModes.get(tab.docId) === true;";
    expect(BTN_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = ui.replace(ORIG, "const on = docSyncModes.get(tab.tabId) === true;");
    const body = slice(degraded, "function refreshSyncButton(", "function refreshStatus(");
    expect(body, "退化后亮灯按 tab 取 ⇒ 切一下就复位").not.toMatch(
      /docSyncModes\.get\(tab\.docId\) === true/,
    );
  });

  it("退回「直接写兄弟的 scrollTop，绕过唯一闸口」→ 位置那条必须落空", () => {
    // ⚠️ 退化串要连着那行的缩进：函数里有两笔 `recordScroll(other.tabId, …)`（预览分支
    //    记 `landed`、统一分支记 `top`），只按短句 replace 的话替换掉的未必是这笔，
    //    断言就会落在另一笔上（假绿）。
    // ⚠️ B251 换锚：落点现在是 `sourceTopOfV` 换算出来的 `top`（旧的「px 直通」那一格
    //    已经并进统一分支），退化串跟着换。
    const ORIG = "recordScroll(other.tabId, top);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "other.scrollTop = top;");
    const body = slice(
      degraded,
      "function pushSyncToSiblings(",
      "function flushPendingSyncCursor(",
    );
    expect(body, "绕过 recordScroll 的写法要被抓到").not.toMatch(
      /recordScroll\(other\.tabId, top\)/,
    );
  });

  it("删掉「离屏预览兄弟跳过位置」那句 → 顺序那条必须落空", () => {
    // ⚠️ B159 起这句挪进了 `applySyncToSibling`（缩进也跟着变了），ORIG 要按新排书写。
    // ⚠️ B251 换锚：判空条件从 `line` 改成 `v`（跨侧统一交游标之后 `line` 不再是形参）。
    const ORIG = "    if (v === null || !shown?.preview) return;";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "");
    const body = slice(degraded, "function applySyncToSibling(", "function landPreviewAtSource(");
    expect(body, "删掉后就不该再有这句子").not.toContain(ORIG);
  });

  it("退回「钉兄弟 DOM 不标程序来源（裸写 scrollTop）」→ px 分支那条必须落空", () => {
    // px 分支必须走 `pinScrollTop`（它内部 markProgrammatic 标来源、回执被吞）；
    // 退化成裸写 scrollTop 后，那条「走 pinScrollTop」的契约必须落空。
    // ⚠️ B251 换锚：钉的是统一分支换算出来的 `top`（旧的 `px` 那一格已并掉）。
    const ORIG = "pinScrollTop(shownView.scrollDOM, top);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "shownView.scrollDOM.scrollTop = top;");
    const body = slice(degraded, "function applySyncToSibling(", "function syncSourceSnapshot(");
    expect(body, "裸写 scrollTop 的写法要被抓到（没经 pinScrollTop 标来源）").not.toMatch(
      /pinScrollTop\(shownView\.scrollDOM, top\);/,
    );
  });

  it("退回「用 sync 字形」→「链条」那条必须落空", () => {
    const ORIG = "syncScrollBtn.innerHTML = on ? CODICONS.link : CODICONS.unlink;";
    expect(ui, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = ui.replace(ORIG, "syncScrollBtn.innerHTML = CODICONS.sync;");
    expect(degraded, "退回 sync 就退回圆箭头、跟右上角更新键族撞形了").not.toMatch(
      /syncScrollBtn\.innerHTML = on \? CODICONS\.link : CODICONS\.unlink;/,
    );
  });

  it("B166 反向验证：把字形切换从 refreshSyncButton 摘掉 → 上一条必须落空", () => {
    const ORIG = "  syncScrollBtn.innerHTML = on ? CODICONS.link : CODICONS.unlink;";
    expect(ui, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = ui.replace(ORIG, "");
    const body = slice(degraded, "function refreshSyncButton(", "function refreshStatus(");
    expect(body, "摘掉后「字形要由开关值决定」必须落空").not.toMatch(
      /syncScrollBtn\.innerHTML = on \? CODICONS\.link : CODICONS\.unlink;/,
    );
  });

  it("B166：codicons 要有 pin / unlink 两颗新字形（unpin 退场）", () => {
    const codicons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(codicons, "codicons 必须有 pin（未置顶态）").toMatch(/^\s*pin:\s*"pin"/m);
    expect(codicons, "codicons 必须有 unlink（自定义去杠字形）").toMatch(
      /^\s*unlink:\s*"link codicon-unlink"/m,
    );
    expect(codicons, "unpin 已无消费方，不许再留在 IDS 里").not.toMatch(/^\s*unpin:/m);
  });

  it("B166：unlink 的抹杠规则要用标题栏底色（官方 link 字形 + CSS 裁剪）", () => {
    expect(css, "抹杠规则要挂在 .codicon-unlink 上").toMatch(/\.codicon-unlink\s*\{/);
    const patch = slice(css, ".codicon-unlink::after {", "}");
    expect(patch, "要能定位抹杠补丁").not.toBe("");
    expect(patch, "补丁必须是标题栏底色（跟着主题走）").toContain("var(--bg-toolbar)");
    expect(patch, "补丁要盖住 y=7..8 的连接杆").toMatch(/top:\s*6(\.\d+)?px/);
  });

  it("B166 反向验证：把 unlink 退化成官方 link（不抹杠）→ 上一条必须落空", () => {
    const ORIG = 'unlink: "link codicon-unlink",';
    expect(readFileSync("src/shell/codicons.ts", "utf-8"), "退化串要先自证原句还在").toContain(
      ORIG,
    );
    // 退化后 codicons.ts 里不再有 codicon-unlink 修饰类 ⇒「抹杠规则」的判定落空
    const degraded = readFileSync("src/shell/codicons.ts", "utf-8").replace(
      ORIG,
      'unlink: "link",',
    );
    // ⚠️ 别用 `not.toContain("codicon-unlink")` 自证：IDS 那一段的**注释**里也写着
    //    codicon-unlink，整文件判 contains 永远为真 ⇒ 退化用例自己假绿。按行判。
    expect(degraded, "退化实现应真的换了写法（按行判）").toMatch(/^\s*unlink:\s*"link",/m);
    expect(degraded, "「必须有 unlink（自定义去杠字形）」此时必须落空").not.toMatch(
      /^\s*unlink:\s*"link codicon-unlink"/m,
    );
  });

  it("删掉 .sync-btn[hidden] → 样式那条必须落空", () => {
    const degraded = css.replace(/\.sync-btn\[hidden\]\s*\{\s*display:\s*none;\s*\}/, "");
    expect(degraded, "删掉后不该还有这条规则").not.toMatch(/\.sync-btn\[hidden\]/);
  });
});

// ------------------------------------------------------- B154 反向验证
describe("B154 反向验证：退回 B152 的旧口径，上面那几条必须变红", () => {
  it("把位置同步退回「只认激活的那份」→ 「谁滚谁当源」必须落空", () => {
    // ⚠️ B159 起这一笔带第二个实参（`crossWindow`），退化串要跟着写全，
    //    否则退化版「什么都没改」，整条反向验证静默失效（本文件栽过一次）。
    const ORIG = "if (t) pushSyncToSiblings(t, true);";
    expect(tabsSrc, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = tabsSrc.replace(ORIG, "if (t && isSyncSource(t, p)) pushSyncToSiblings(t);");
    // 退回后编辑器那一侧又要求「源是激活的」，鼠标没点过的视口就带不动兄弟了。
    expect(degraded, "退回后编辑器监听又挂回激活判定").toMatch(
      /if \(t && isSyncSource\(t, p\)\) pushSyncToSiblings\(t\);/,
    );
    const scroll = slice(
      degraded,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(scroll, "退回后编辑器监听就不再是「谁滚谁当源」了").not.toMatch(
      /\n\s*if \(t\) pushSyncToSiblings\(t, true\);\n/,
    );
  });

  it("从预览监听里删掉推兄弟那句 → 「两条滚动监听」那条必须落空", () => {
    const ORIG = "pushSyncToSiblings(t, true);";
    const at = tabsSrc.lastIndexOf(ORIG);
    expect(at, "退化串要先自证原句还在").toBeGreaterThan(-1);
    // ⚠️ 按位置切：编辑器那侧也有一笔同形，整串 replace 会删到错的那笔（假绿）。
    const degraded = tabsSrc.slice(0, at) + tabsSrc.slice(at + ORIG.length);
    const prev = slice(degraded, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    // ⚠️ 判据要认**调用**形态（`pushSyncToSiblings(t, true);`）—— 那段的注释里也提名了
    //    这个函数，只认字面会命中注释，退化看着「没生效」（跟 isSyncSource 那次同坑）。
    expect(prev, "预览监听退回后就不再推兄弟了").not.toMatch(/pushSyncToSiblings\(t, true\);/);
  });

  it("退回「源在预览里也拿 src.scrollTop 当编辑器像素」→ 坐标系那条必须落空", () => {
    // ⚠️ B251 彻底换锚：退化串原先锚 `const px = srcPreview ? null : `（推兄弟那一路的
    //    局部三元），而统一 `v` 之后「源在哪一侧就取哪一侧」这个纪律**整个搬进了唯一
    //    取值口 `syncSourceV`** —— 推兄弟那一路只剩一句 `const v = syncSourceV(src)`，
    //    锚点留在那儿等于退化做了个寂寞（B163 同型）。现在退化 `syncSourceV` 的**预览
    //    分支**：拿双语义槽 `t.scrollTop`（此刻装的是预览像素）当游标 ⇒ 推给源码兄弟的
    //    是预览像素，两个面板互相拉。（另一半「源码侧读快照槽」见下一条。）
    const ORIG = "return p?.preview?.topVisibleLine() ?? null;";
    expect(SYNC_V, "退化串要先自证原句还在").toContain(ORIG);
    // ⚠️ 退化成「`: return t.scrollTop;`」而不是「`: t.scrollTop;`」—— 退化后的串要能命中
    //    正向契约那条 `return (t|src).scrollTop`，少了 `return` 两道判据一起落空 ⇒ 假绿
    //    （这条退化验上一轮就栽在锚点写死的形态上，见 B163 同型）。
    const degraded = main2.replace(ORIG, ": return t.scrollTop;");
    const body = slice(degraded, "function syncSourceV(", "function rememberViewScroll(");
    // ⚠️ 退化真的落进去了（自证：双语义槽那句现在确实在 —— 正向契约里的
    //    「双语义槽不许当游标」也随之红掉，两道判据一起报）。
    expect(body, "退化串确实换了写法（预览侧改读槽）").toContain("return t.scrollTop;");
    // 关键判空：预览侧不再按自己那侧的几何取 v ⇒ 上面那条正向契约必须红。
    expect(body, "退回后源在预览里不再按预览几何取 v").not.toContain(
      "p?.preview?.topVisibleLine()",
    );
    // 退化落点自证（必须带 `return` —— 少了它「双语义槽不许当游标」那条也扫不中，两道
    //   判据一起落空 ⇒ 假绿。这条退化验上一轮就栽在锚点写死的形态上，B163 同型）。
    expect(body, "退化串里确实出现「读槽当游标」那一笔").toContain("return t.scrollTop;");
  });

  it("退回「px 读快照槽（滞后一帧）」→ 实时取值那条必须落空", () => {
    // ⚠️ 源码侧那一格旧的写法是 `srcView?.scrollDOM.scrollTop ?? src.scrollTop`
    //    （实测真实 260 时只推出 100）。统一 `v` 之后这一格在 `syncSourceV` 的源码分支上
    //    —— 退化串改锚到那一句，退回成读快照槽 `t.scrollTop` ⇒ 滞后一帧、且槽里存的
    //    还是上一次的编辑器像素。两条退化各打各的那半边。
    // ⚠️ 本轮换锚：源码分支现在整条是
    //    `return topVisibleLineFrac(view, sourceCursorPx(t, view));`
    //    而 `sourceCursorPx`（DOM 与槽不一致 ⇒ 用槽）是像素的实时出口。退化打**整条 return**：
    //    退回读槽 `t.scrollTop` 会把 `topVisibleLineFrac(view, …)` 一起抹掉 ⇒ 上面
    //    「不许直接读实时 DOM」等几条契约随之落空 ⇒ 不许靠它们兜（假绿），
    //    下面这条 `not.toContain("topVisibleLineFrac(view)")` 才是自证。
    // ⚠️ B257：这一档不再有 `cross` 分支，所以退化串**只退化这一条 return**，前后各分支都不动。
    const ORIG = "return topVisibleLineFrac(view, sourceCursorPx(t, view));";
    expect(SYNC_V, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "  return t.scrollTop;");
    const body = slice(degraded, "function syncSourceV(", "function rememberViewScroll(");
    // 「源码侧按实时几何取 v」这条纪律落空 ⇒ 上面那条正向契约必须红。
    expect(body, "退回后源码侧不再按实时几何取 v").not.toContain("topVisibleLineFrac(view)");
  });

  it("退回「预览侧先推后写快照」→ 顺序那条必须落空", () => {
    // B240 二轮：预览侧那条滚动监听曾是「先 pushSyncToSiblings 再 recordScroll」，
    // 而 px 读的是快照槽 ⇒ 推给兄弟的是上一次的位置。与编辑器侧口径不一致。
    // 判据：预览监听里 `recordScroll` 必须排在 `pushSyncToSiblings` **之前**。
    const previewScroll = slice(
      tabsSrc,
      'preview.root.addEventListener("scroll"',
      "applyPanelMode(p);",
    );
    const rec = previewScroll.indexOf("recordScroll(t.tabId, t.scrollTop);");
    const push = previewScroll.indexOf("pushSyncToSiblings(t, true);");
    expect(rec, "预览监听里应写快照").toBeGreaterThanOrEqual(0);
    expect(push, "预览监听里应推兄弟").toBeGreaterThanOrEqual(0);
    expect(rec, "先写快照、后推兄弟（否则推出去的是上一次的位置）").toBeLessThan(push);
  });

  it("退回「预览兄弟只跟光标、不跟位置」→ 行定位那条必须落空", () => {
    // ⚠️ 退化串是**单句结构**（带 `if` 判空那一整条），不是只写被扫的字面量 ——
    //    只写 `recordScroll(other.tabId, landed)` 的话，退化成判恒真照样命中，等于没退化。
    const ORIG = "if (landed !== null) recordScroll(other.tabId, landed);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "");
    const body = slice(
      degraded,
      "function pushSyncToSiblings(",
      "function flushPendingSyncCursor(",
    );
    // 源码分支那笔是 `…, px)`，盯着 `landed` 才只打预览这一格（盯 `shown` 那套前缀已作废）。
    expect(body, "删掉这笔记录后，预览兄弟就没位置可落了").not.toMatch(
      /recordScroll\(other\.tabId,\s*landed\)/,
    );
  });

  it("把状态颜色退回「整颗键铺底」→ 外观那条必须落空", () => {
    // 用户要的是「干脆没有按钮背景」，hover 与同步都靠图标颜色 —— 铺底等于退回 B152。
    // ⚠️ 退化**不能**写死整段选择器列表：这一族的成员会随标题栏加键而变（B198 那颗
    //    layout-btn 就是后来加的），写死成员数一到加键这条反向验证就整条失效。
    //    只盯「hover 那一条里的 background」这一件事本身，成员增减都不影响。
    const ORIG = ".title-btn.layout-btn:hover {\n  background: transparent;";
    expect(css, "退化串要先自证原句还在").toContain(ORIG);
    const BAD = ".title-btn.layout-btn:hover {\n  background: var(--bg-hover);";
    const degraded = css.replace(ORIG, BAD);
    expect(degraded, "退回铺底后就不是「没有按钮背景」了").toContain(BAD);
    expect(degraded, "方形尺寸那几条也还得在，别顺手一起删了").toMatch(
      /\.sync-btn,[\s\S]*?height: 24px;/,
    );
  });
});

// ------------------------------------------------------- B160 反向验证
describe("B160 反向验证：退回旧写法，上面那四条必须变红", () => {
  it("退回「源码兄弟只认 px，离屏/没容器就不动」→ 离屏写槽那条必须落空", () => {
    // 退回 B160 前状：在 `px === null`（源是预览侧）或换不出容器时直接 return，于是源码
    // 兄弟一动不动 —— 用户报的「滚动预览，源码文档没有同步滚动」。
    //
    // ⚠️ B251 换锚：统一 `v` 之后源码分支只剩**一道**判空（`if (v === null) return;`），
    //    `if (px !== null) {` 那个老守卫已经并掉；退化串改锚到**等价的那一道** ——
    //    把判空扩成 `if (v === null || !shown) return;`（= 老 B160 的「px 取不到 /
    //    没容器就 return ⇒ 源码兄弟一动不动」）。退化串是**单句结构**（判空 + return
    //    一整条），不是只写 `v === null` 那几个字符 —— 退化成判恒真照样命中，等于没退化。
    const ORIG = "  if (v === null) return;";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "  if (v === null || !shown) return;");
    const body = slice(degraded, "function applySyncToSibling(", "function syncSourceSnapshot(");
    // 退化后「在不在屏」又成了挡路门槛 ⇒ B240 那条「离屏源码兄弟也要写位置快照」的
    // 反向闸必须命中（它认的不是函数名，是「!shown / !shownView 就 return」这个形态）。
    expect(body, "退回后源码分支又被『在不在屏』挡住了").toMatch(
      /if \(v === null \|\| !shown\) return;/,
    );
    // 顺手自证：这一退只动了守卫，落点换算还在 ⇒ 被打红的确实是最上面那道反向闸。
    expect(body, "落点换算还在（被打破的是『不许被在屏挡住』那条）").toContain(
      "const top = sourceTopOfV(view, v);",
    );
  });

  it("退回「走 syncToLine（留尾巴、无程序定位窗口）」→ 两条必须落空", () => {
    // B162 前状：预览分支调 `syncToLine` —— 它会留 `pendingSyncLine` 尾巴（每次重排
    // 都把预览拽回某一行），也没有程序定位窗口（逃过守卫的 scroll 会被反推成用户滚动）。
    // ⚠️ 本轮换锚：交的是**同侧**那份 `v`（旧写法 `Math.floor(line)` 把块内比例掐掉），
    //    退化串跟着换。
    const ORIG = "preview.syncToLineProgrammatic(v);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main2.replace(ORIG, "preview.syncToLine(v);");
    const body = slice(degraded, "function applySyncToSibling(", "function syncSourceSnapshot(");
    expect(body, "退化后预览分支不再走程序定位入口").not.toContain(
      /preview\.syncToLineProgrammatic\(v\)/,
    );
    expect(body, "退化后尾巴又留下来了").toMatch(/preview\.syncToLine\(v\)/);
  });

  it("把换算那笔的补记删掉 → 「补记在钉位之后」那条必须落空", () => {
    // 行号换算分支：先 `pinScrollTop`（内部 markProgrammatic 标来源）钉稳，再 `recordScroll`
    // 把落点写进兄弟自己的记录（B145 唯一闸口）。删掉这一笔，兄弟这份的位置就只活在 DOM
    // 上，离屏前没人补记，重启就丢了 —— 那条「换算后要补记落点」的契约必须落空。
    // ⚠️ 锚点要连着缩进：跨侧源码分支现在钉的是**换算出来的行首像素**（B242，别退回
    //    `shownView.scrollDOM.scrollTop` —— 那个值此时还没被我们动过，补记它等于没补）。
    const ORIG_REC = "  recordScroll(other.tabId, top);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG_REC);
    const degraded = main2.replace(ORIG_REC, "");
    const body = slice(degraded, "function applySyncToSibling(", "function landPreviewAtSource(");
    expect(body, "删掉补记后「换算分支补记在钉位之后」就站不住了").not.toContain(ORIG_REC);
  });
});

// ------------------------------------------------------- B175：跟随坐标按整条逻辑行算行内比例
// isWrap=true 下一条逻辑行会被 CM6 拆成多个视觉块（每块一行高），这些块的
// `lineAt(block.from).number` 都是同一个逻辑行号、块 height 只是一条视觉行高。旧
// `topVisibleLineFrac` 只用「当前视觉块内比例」拼行号 ⇒ 滚过折行段落时行号卡在 N±1 上下
// 跳，推给预览的坐标跟着抖（用户反复报的「预览跟随整页重渲染 / 跳动」，而 TOC 一次性大跳
// 反而没问题 —— 一次性定位不走分数坐标）。修法：比例算在**整条逻辑行**的高度上。
describe("B175 同步跟随坐标按整条逻辑行算行内比例（折行段落不抖）", () => {
  // ⚠️ B257 换锚：终点 `topVisibleLineOf`（取整版顶行函数）已删 ⇒ 换成紧邻的
  //    `editorLineTopPx`（锚点失效 slice 会静默返空串、判据全绿，务必回读确认非空）。
  const FRAC = slice(main2, "function topVisibleLineFrac(", "function editorLineTopPx(");
  it("topVisibleLineFrac 取整条逻辑行的顶与下一行顶之差当总高，再算进入比例", () => {
    // 单行视觉块高度（block.height）当总高 ⇒ 折行段落里行号卡死。必须取这一行的首视觉块
    // 顶（lineTop）与下一行顶（nextTop）之差当整条逻辑行的高度。
    expect(FRAC, "要取这一行的顶（首视觉块 top）").toMatch(/view\.lineBlockAt\(line\.from\)\.top/);
    expect(FRAC, "要取下一行的顶").toMatch(/view\.lineBlockAt\(nextLine\.from\)\.top/);
    expect(FRAC, "总高 = 下一行顶 - 本行顶").toMatch(/nextTop - lineTop/);
    // 旧写法：const h = block.height || 1; ratio = (scrollTop+1 - block.top)/h
    expect(FRAC, "不许再用单视觉块高度当总高").not.toMatch(/const h = block\.height \|\| 1;/);
    expect(FRAC, "不许再拿单块内比例拼行号（折行段落会卡在 N±1 跳）").not.toMatch(
      /\(\s*scrollTop \+ 1 - block\.top\s*\)\s*\/\s*block\.height/,
    );
  });

  it("编辑器→预览跟随（syncFromEditor）用的顶行坐标也走带比例的小数", () => {
    // `host.topVisibleLine` 喂给 `syncFromEditor`；原来返回整数 `topVisibleLineOf` ⇒
    // 源面板自己的预览也跟着阶梯跳（同一份抖动症状）。必须走 `topVisibleLineFrac`。
    const host = slice(tabsSrc, "preview.setHost({", "lineCount: () =>");
    expect(host, "topVisibleLine 要返回带比例的小数").toMatch(/return topVisibleLineFrac\(v\);/);
    // ⚠️ B257：`topVisibleLineOf`（整数顶行）已随「切模式交完整 v」删掉 —— 原来这条反向闸
    //    扫的是它，现在恒真（假绿），改成扫**代码形态**：交出去之前不许先 `Math.floor`
    //    把小数掐了（切模式交接那一趟掐掉小数 ⇒ 每切一次丢半行，自测台 287 ⇒ 280）。
    expect(host, "不许把小数先掐成整数再交出去（切模式交接会丢半行）").not.toMatch(
      /Math\.floor\(topVisibleLineFrac/,
    );
    expect(main, "整数版顶行函数不许再长回来（切模式不许交整数行）").not.toMatch(
      /function topVisibleLineOf\(/,
    );
  });

  it("B175 反向验证：退回单视觉块比例 → 「整条逻辑行高度」那条必须落空", () => {
    const ORIG_LINE = "const lineHeight = nextTop - lineTop || block.height || 1;";
    expect(main2, "退化串要先自证原句还在").toContain(ORIG_LINE);
    const degradedMain = main2.replace(ORIG_LINE, "const h = block.height || 1;");
    const degradedFrac = slice(
      degradedMain,
      "function topVisibleLineFrac(",
      "function editorLineTopPx(",
    );
    expect(degradedFrac, "退化后不再按整条逻辑行算高").not.toMatch(/nextTop - lineTop/);
    expect(degradedFrac, "退化后单块高度又回来了").toMatch(/const h = block\.height \|\| 1;/);
  });
});

// ------------------------------------------------------- B176：非激活源滚动的 A↔B 拉锯
// B154「谁滚谁当源」让滚动监听直接调 `pushSyncToSiblings`，源可以是非激活面板；而
// `pushSyncToSiblings` 给兄弟 dispatch 光标会**同步**触发兄弟的 `handleUpdate`，若兄弟
// 正好是激活标签（`isSyncSource` 为真）就会把位置**反推回源** —— 源此刻还是上一帧旧值
// （用户还在连续滚），于是被拽回旧位置、下一帧又被用户推新、再被拽回…… 连续滚动下就是
// A↔B 拉锯（用户反复报的「非激活文档滚动抖」）。B167 那条注释仍写着「兄弟恰好是激活标签
// 的情况不存在（源才是）」，已被 B154 打破。修法：dispatch 光标期间打 `syncingCursorDocId`
// 标，`handleUpdate` 的 `isSyncSource` 分支见标跳过这一轮反推（光标仍落到兄弟，只是不再反推源）。
describe("B176 非激活源滚动不再被兄弟反推成 A↔B 拉锯", () => {
  const HANDLE_BODY = slice(main, "function handleUpdate(", "function syncDocInstances(");

  it("给兄弟 dispatch 光标的那一路要打「同源光标同步」标，并清在 finally 里", () => {
    // 标记要让兄弟那一轮 `handleUpdate` 看得见：必须在 dispatch **之前**设；且不论
    // dispatch 是否抛错都要清掉（否则标记黏在容器上，之后真用户滚动会被误判成同步回执）。
    expect(PUSH_BODY, "dispatch 前打标").toMatch(/syncingCursorDocId = src\.docId;/);
    expect(PUSH_BODY, "dispatch 后要清标").toMatch(/syncingCursorDocId = null;/);
    // 标 / dispatch / 清 三句必须按这个次序（清标不漏）。
    const atSet = PUSH_BODY.indexOf("syncingCursorDocId = src.docId;");
    const atDispatch = PUSH_BODY.indexOf(
      "shownView.dispatch({ selection: { anchor: pos }, scrollIntoView: false });",
    );
    const atClear = PUSH_BODY.indexOf("syncingCursorDocId = null;");
    expect(atSet, "要能定位打标那句").toBeGreaterThan(-1);
    expect(atDispatch, "要能定位光标 dispatch").toBeGreaterThan(-1);
    expect(atClear, "要能定位清标那句").toBeGreaterThan(-1);
    expect(atSet, "打标必须在 dispatch 之前").toBeLessThan(atDispatch);
    expect(atDispatch, "dispatch 必须在清标之前").toBeLessThan(atClear);
  });

  it("handleUpdate 的 isSyncSource 分支要跳过「被同源光标同步触发」的那一轮", () => {
    // 否则兄弟（激活标签）会反推回源，非激活源被拽回旧位置 → 拉锯 / 抖。
    expect(HANDLE_BODY, "光标同步触发的那轮不许反推").toMatch(
      // ⚠️ B254 换锚：那句现在多了一道抑制标志，且 prettier 把 `pushSyncToSiblings`
      //    折到了下一行 —— 判据得认「条件 + 换行 + 调用」这一整块，别只认半句。
      /if \(!suppressSyncPush && isSyncSource\(tab, panel\) && syncingCursorDocId !== tab\.docId\)\n\s*pushSyncToSiblings\(tab\);/,
    );
    // 反向自证：旧写法（无标检查）不该还在。
    expect(HANDLE_BODY, "不许再是无条件的 isSyncSource 推").not.toMatch(
      /if \(isSyncSource\(tab, panel\)\) pushSyncToSiblings\(tab\);/,
    );
  });

  it("B176 反向验证：退回无条件 isSyncSource 推 → 上面「跳过反推」必须落空", () => {
    // ⚠️ B254 换锚：那句多了一道「切标签不推」的抑制标志（锚点必须随改动同步换，
    //    否则退化串自证那一条就挂在这儿，红的是判据不是产品行为）。
    //    ⚠️ 调用被 prettier 折到下一行，`degraded` 那边按整块替换，别只换半句。
    const ORIG = "isSyncSource(tab, panel) && syncingCursorDocId !== tab.docId";
    const FULL = `if (!suppressSyncPush && ${ORIG})\n    pushSyncToSiblings(tab);`;
    expect(HANDLE_BODY, "退化串要先自证原句还在").toContain(FULL);
    const degraded = main.replace(FULL, `if (${ORIG}) pushSyncToSiblings(tab);`);
    const body = slice(degraded, "function handleUpdate(", "function syncDocInstances(");
    expect(body, "退回后不再跳过反推（抑制标志被摘掉了）").not.toMatch(/!suppressSyncPush/);
    expect(body, "退回后又退回无条件 isSyncSource 推").toMatch(
      /if \(isSyncSource\(tab, panel\) && syncingCursorDocId !== tab\.docId\) pushSyncToSiblings\(tab\);/,
    );
  });
});

// ------------------------------------------------------- B178：跨窗口多开检测
// 用户原话：「子窗口中的多开文件（只要主窗口和子窗口中同一个文件打开多次，就算多开）
// 也要有同步滚动按钮，且状态和主窗口中的一致」。状态已由 `EVT_SYNC_MODE`（B169）保一致，
// 这里只补**可见性**：`visibleInstancesOfDoc` 只数本窗口实例，于是同文件跨窗口各开一份时
// 两边各自只数到 1，同步键都不露脸。修法：各窗口广播自己「有可见实例的 docId 集合」，
// 对端按窗口标签记进 `remoteOpenByWindow`，按钮显隐的「多份」判据 = 本窗口可见实例数 +
// （任一远端窗口也开着就算 1）。窗口干净关掉就整条删掉。
describe("B178 跨窗口多开检测：主/子窗口同步键显隐一致", () => {
  it("要有存在性登记：按窗口标签记别的窗口开着哪些可见文档", () => {
    expect(main3, "要有跨窗口可见文档登记 Map").toMatch(
      /const remoteOpenByWindow = new Map<string, Set<number>>\(\);/,
    );
    // 广播出去的「本窗口可见 docId 集合」要留底以便算 diff，只在变化时发事件。
    expect(ui, "要有上次广播集合").toMatch(/let lastBroadcastDocIds = new Set<number>\(\);/);
    // 四个事件常量
    expect(main5, "open 事件要在").toMatch(/const EVT_DOC_OPEN = "doc-open";/);
    expect(main5, "close 事件要在").toMatch(/const EVT_DOC_CLOSE_NOTIFY = "doc-close-notify";/);
    expect(main5, "resync 请求事件要在").toMatch(/const EVT_DOC_OPEN_RESYNC = "doc-open-resync";/);
    expect(main5, "窗口关闭通知事件要在").toMatch(/const EVT_WINDOW_CLOSED = "window-closed";/);
  });

  it("broadcastDocPresence 按可见集合 diff，只在变化时广播 open/close", () => {
    const FN = slice(ui, "function broadcastDocPresence(", "function refreshAll(");
    expect(FN, "要能定位").toContain("function broadcastDocPresence(");
    // 可见实例才广播（panelId >= 0 滤掉隐藏实例，与 B173 同口径）
    expect(FN, "只数可见实例").toMatch(/t\.panelId >= 0/);
    // 新增 → 广播 open；消失 → 广播 close
    expect(FN, "新增广播 open").toMatch(/emitCrossWindow\(EVT_DOC_OPEN, \{ docId \}\)/);
    expect(FN, "消失广播 close").toMatch(/emitCrossWindow\(EVT_DOC_CLOSE_NOTIFY, \{ docId \}\)/);
    // 收口：把本次集合存为 lastBroadcast
    expect(FN, "diff 基准要更新").toMatch(/lastBroadcastDocIds = now;/);
  });

  it("refreshAll 与 closeTabById 都要触发存在性广播", () => {
    // refreshAll 已拆到 ui.ts（解耦第七步）⇒ 广播断言跟着读 ui
    expect(ui, "全局刷新要广播存在性").toMatch(/broadcastDocPresence\(\);/);
    // 关标签不进 refreshAll（closeTabById 自己收尾），所以这里也要单独广播。
    const CLOSE = slice(tabsSrc, "async function closeTabById(", "function disposePanel(");
    expect(CLOSE, "关标签要广播存在性").toMatch(/broadcastDocPresence\(\);/);
  });

  it("listenDocSync 要装齐四条存在性监听（open/close/resync/window-closed），且回声要丢", () => {
    // listenDocSync 已拆到 multiwindow/windows.ts（#415）⇒ 终锚改用文件尾 export 块
    const LISTEN = slice(mwSrc, "function listenDocSync(", "\nexport {");
    expect(LISTEN, "open 监听").toMatch(/listen<DocPresencePayload>\(EVT_DOC_OPEN/);
    expect(LISTEN, "close 监听").toMatch(/listen<DocPresencePayload>\(EVT_DOC_CLOSE_NOTIFY/);
    expect(LISTEN, "resync 监听").toMatch(/listen<\{ from\?: string \}>\(EVT_DOC_OPEN_RESYNC/);
    expect(LISTEN, "window-closed 监听").toMatch(/listen<\{ from\?: string \}>\(EVT_WINDOW_CLOSED/);
    // 自己的回声要丢（与上面几条同口径）
    expect(LISTEN, "回声要丢").toMatch(/p\.from === windowLabel/);
  });

  it("新窗口上线要问一圈重播（resync 请求），上线方据此补齐", () => {
    // setupShell 里 `listenDocSync();` 之后、本函数内 `installFileDropTarget({` 之前要发一次。
    const SHELL = slice(main, "async function setupShell(", "installFileDropTarget({");
    expect(SHELL, "引导里要发 resync 请求").toMatch(/emitCrossWindow\(EVT_DOC_OPEN_RESYNC, \{\}\)/);
  });

  it("卫星窗口干净关窗要通知对端清掉它那一条", () => {
    const FIN = slice(
      main,
      "async function finishSatelliteClose(",
      "async function finishAndDestroy(",
    );
    expect(FIN, "卫星关窗要通知对端").toMatch(/emitCrossWindow\(EVT_WINDOW_CLOSED, \{\}\)/);
  });

  it("刷新按钮的「多份」判据要包含跨窗口：本窗口可见 > 1 或 远端也开着这份", () => {
    expect(BTN_BODY, "多份判据含跨窗口").toMatch(
      /visibleInstancesOfDoc\(tab\.docId\)\.length > 1 \|\| remoteHasDoc\(tab\.docId\)/,
    );
    // B171/B173 口径保留：不掺共享集合、不看窗口身份。
    expect(BTN_BODY, "仍不掺 sharedDocIds").not.toMatch(/sharedDocIds/);
    expect(BTN_BODY, "仍不看窗口身份").not.toMatch(/windowKind/);
  });

  it("B178 反向验证：退回「只数本窗口」→ 跨窗口那条必须落空", () => {
    // 退化成 B178 前的口径：只数本窗口可见实例，跨窗口的那一半没了。
    const i = ui.indexOf("const multi =");
    expect(i, "要能定位显隐判据").toBeGreaterThan(-1);
    const degraded =
      ui.slice(0, i) +
      "const multi = !!tab && visibleInstancesOfDoc(tab.docId).length > 1;" +
      ui.slice(ui.indexOf(";", i) + 1);
    // 只查按钮函数体：模块级的 `remoteHasDoc` 定义本身留着（它仍是给其它判据用的工具
    // 函数），要落空的是「按钮显隐判据里跨窗口那一半」。
    const btn = slice(degraded, "function refreshSyncButton(", "function refreshStatus(");
    expect(btn, "退化后跨窗口判据必须落空").not.toMatch(/remoteHasDoc/);
  });
});

describe("B172 同一容器只认最新一条补钉链（连续同步不再互相拉锯）", () => {
  it("pinScrollTop 领令牌，作废的旧链不许再写 scrollTop", () => {
    // 同步滚动时源每派发一次 scroll 就调一次这里，而一条链要跑到 PIN_MAX_FRAMES 才收工。
    // 没有令牌 ⇒ 十几条链同时钉不同的 px ⇒ 目标那份来回抖（滚非激活文档时最明显）。
    expect(PIN_BODY, "每次调用都要领一个新令牌").toMatch(
      /const token = \(pinTokens\.get\(el\) \?\? 0\) \+ 1;/,
    );
    expect(PIN_BODY, "旧链见到令牌变了就退出").toMatch(
      /if \(pinTokens\.get\(el\) !== token\) return;/,
    );
    expect(PIN_BODY, "新链起来时容器仍在钉（pinInFlight 要拦中间值）").toMatch(
      /pinningContainers\.add\(el\)/,
    );
  });
});

describe("B172 反向验证：摘掉作废判定，上面那条必须落空", () => {
  it("退化：旧链不再退出", () => {
    const GUARD = "if (pinTokens.get(el) !== token) return;";
    expect(PIN_BODY, "退化串要先自证原句还在").toContain(GUARD);
    expect(PIN_BODY.replace(GUARD, ""), "摘掉后就没有『旧链作废』这回事了").not.toContain(GUARD);
  });
});

describe("B186 大纲跳转经统一入口同步（多开不同步则只动激活实例）", () => {
  it("onJump 把兄弟同步 + 跨窗口广播交给统一入口 syncJumpToLine（不再内联循环）", () => {
    // 用户诉求：文件多开且未关联同步滚动时，大纲只能影响激活文档的滚动位置。
    // 激活实例自身的定位（含预览 syncToLine）必须在守卫之外，永远生效；
    // 守卫（同步滚动开关）现已收口进 pushSyncToSiblings，不再内联在 onJump。
    const ACTIVE = "tab2.state = panel.view.view.state;";
    const DELEGATE = "syncJumpToLine(tab2";
    expect(ONJUMP_BODY, "onJump 必须先定位激活实例（不受同步状态约束，永远生效）").toContain(
      ACTIVE,
    );
    expect(ONJUMP_BODY, "onJump 必须把兄弟同步 + 跨窗口广播交给统一入口").toContain(DELEGATE);
    expect(
      ONJUMP_BODY,
      "守卫不应再内联在 onJump（统一由同步入口按 docSyncModes 裁决）",
    ).not.toContain("if (docSyncModes.get(tab2.docId) === true)");
    // 守卫现在落在 pushSyncToSiblings（sync-scroll.ts）—— 这才是「未开同步则只动激活实例」的裁决点。
    const PUSH = pushBody();
    expect(PUSH, "统一入口 pushSyncToSiblings 必须按 docSyncModes 守卫").toContain(
      "if (docSyncModes.get(src.docId) !== true) return;",
    );
  });

  it("反向验证：pushSyncToSiblings 摘掉守卫 ⇒ 同步状态失效（恢复无条件广播）", () => {
    const PUSH = pushBody();
    const GUARD = "if (docSyncModes.get(src.docId) !== true) return;";
    expect(PUSH, "退化串要先自证原句还在").toContain(GUARD);
    const degraded = PUSH.replace(GUARD, "");
    expect(degraded, "摘掉守卫后推送不再受同步滚动约束（恢复成无条件广播）").not.toContain(GUARD);
  });
});

// ---------------------------------------------------------------- B254 切标签那一刻
// 用户原话（第五轮）：「左分屏一个源码一个预览，右分屏一个预览，开启同步滚动，滚左分屏
// 源码到底部，切到左分屏预览标签、再切回左分屏源码标签，**第二次切换时右分屏的预览文件
// 滚动位置出现了向上偏移，且后续切换标签不再变化滚动位置**」。
//
// 两半症状是同一发推播造成的：
//   · **向上偏移** —— `switchTab` 里那句 `view.setState(tab.state)` 是**同步**派发
//     update 的，而 `setState` 按 CM6 的行为把编辑器 scrollTop 归零 ⇒ 那一轮
//     `handleUpdate` 读到的「源位置」是 0，且此刻 `activeTabId` 已改新标签、
//     `isSyncSource` 已为真 ⇒ 都会去 `pushSyncToSiblings`：同文档的**预览**兄弟被
//     `syncToLineProgrammatic(1)` 钉回文档开头，落点还被 `recordScroll` 写进它自己
//     的槽 ⇒ 位置记录与实际同步变成「都停在顶上」（向上偏移）。
//   · **之后不再变化** —— 收尾那句「收口已对齐就跳过推播」（B241）于是再没人把它
//     救回来，而**每次**切标签都会重推同一发 0 ⇒ 位置恒定不变（看着就是被钉死）。
//
// ⚠️ 这一条用静态契约盯：`switchTab` 的 `setState` 必须被抑制标志**裹住**，
//    `handleUpdate` 那句推送必须**读**这个标志。退化（删写 / 删读 / 挪到 setState
//    之后）三条都要红 —— 见下面那个反向验证块。
const SWITCH_BODY = slice(tabsSrc, "function switchTab(", "function newUntitled(");
const UPDATE_BODY = slice(main, "function handleUpdate(", "function syncDocInstances(");

describe("B254 切标签那一刻不许拿「刚被归零的位置」推兄弟", () => {
  it("抑制标志必须夹住 switchTab 里的 setState（不能挪前挪后、不能只写不读）", () => {
    const ON = "setSuppressSyncPush(true);";
    const OFF = "setSuppressSyncPush(false);";
    const SET = "view.setState(tab.state);";
    expect(SWITCH_BODY, "三条锚点都要能找到").toContain(ON);
    expect(SWITCH_BODY, "三条锚点都要能找到").toContain(OFF);
    expect(SWITCH_BODY, "三条锚点都要能找到").toContain(SET);
    // 位置闸（两个退化方向都红：删掉 ON ⇒ ON 找不到；挪到 setState 后 ⇒ ON 的下标变大）
    const onAt = SWITCH_BODY.indexOf(ON);
    const setAt = SWITCH_BODY.indexOf(SET);
    expect(onAt, "置位那句还在不在").toBeGreaterThanOrEqual(0);
    expect(setAt, "setState 那句还在不在").toBeGreaterThanOrEqual(0);
    expect(onAt, "置位必须在 setState **之前**（之后就拦不住那一发同步 update）").toBeLessThan(
      setAt,
    );
    // 单句结构锚：三行连在一起（挪走 / 删掉任意一半都不再命中）
    expect(SWITCH_BODY).toContain(`${ON}\n  ${SET}\n  ${OFF}`);
  });

  it("handleUpdate 那句推兄弟必须真的消费这个标志（不许只写不读）", () => {
    const READ = "!suppressSyncPush &&";
    expect(UPDATE_BODY, "读的那句还在不在").toContain(READ);
    // 消费闸：把标志摘掉之后，剩下的那半句还是同一句推兄弟 —— 说明红的就是「没读」
    const degraded = UPDATE_BODY.replace(READ, "");
    expect(degraded, "退化串要先自证原句还在").not.toContain(READ);
    expect(degraded, "退化的仍是同一句推兄弟（红因是没读标志，不是这句没了）").toContain(
      "isSyncSource(tab, panel) &&",
    );
  });
});

describe("B254 反向验证：退回旧写法，上面那几条必须变红", () => {
  it("退化：删掉置位 / 挪到 setState 之后 / 摘掉读取，三条判据都要落空", () => {
    const ON =
      "setSuppressSyncPush(true);\n  view.setState(tab.state);\n  setSuppressSyncPush(false);";
    expect(SWITCH_BODY, "退化串要先自证原句还在").toContain(ON);

    // ① 删掉抑制：源里再没有「夹住 setState 那一对」（但 `let suppressPush` 声明还在）
    const off = SWITCH_BODY.replace(ON, "  view.setState(tab.state);");
    expect(off, "退化①：抑制那一对被摘掉了").not.toContain("setSuppressSyncPush(true);");
    expect(off, "退化①：setState 本身还在（红因是没了抑制，不是这句消失）").toContain(
      "view.setState(tab.state);",
    );

    // ② 挪到 setState **之后**：标志还在，但那一发同步 update 已经推完了（拦不住）
    const moved = SWITCH_BODY.replace(
      ON,
      "  view.setState(tab.state);\n  setSuppressSyncPush(true);\n  setSuppressSyncPush(false);",
    );
    expect(moved.indexOf("setSuppressSyncPush(true);")).toBeGreaterThan(
      moved.indexOf("view.setState(tab.state);"),
    );

    // ③ 摘掉读取：`handleUpdate` 那句照推（这正是用户报的那个病）
    const noRead = UPDATE_BODY.replace("!suppressSyncPush && ", "");
    expect(noRead).not.toContain("!suppressSyncPush &&");
    expect(noRead, "退化③：推兄弟那句还在 ⇒ 红因就是没人拦它").toContain(
      "isSyncSource(tab, panel) &&",
    );
  });
});
