// @vitest-environment jsdom
// B155 / B157：**卫星窗口的生命周期**（「关闭」到底意味着什么，口径逐条钉死）。
//
//   B155 三条：
//   ① 关掉子窗口 = 真关：不再把标签交还主窗口（交回去的那批可都没关）；
//   ② 关掉子窗口里的文件 = 真的关掉本窗口这一份（Rust 侧也跟着删）；
//   ③ 关掉子窗口里的最后一个文件 / 最后一个面板 = 关掉子窗口（没有「再来一个未命名」的兜底）。
//
//   B157 补正（用户逐条钉的口径，**覆盖了 B155 的「对端跟着摘」那条**）：
//   ④ 子窗口里关标签时，**主窗口中同一个文件的那份不许被关掉** —— 所以 B155 那套
//      「文档关掉了」广播整个作废（`doc-disposed` / `applyDocDisposed` 都不许再出现）；
//   ⑤ 但「关掉最后一个文件 / 面板 → 子窗口**自己**关」这一档不一样：手上**没关闭**的
//      标签照旧交回主窗口（窗口是它自己关空的，不是用户点的 X）。
//      两档的区别就是 `requestSatelliteClose(returnTabs)` 那个参数。
//
//   B161 补正（用户原话：「通过标签上的关闭按钮进行关闭，不管是主窗口还是子窗口，
//   应该都是真正关闭这个标签（不要把其他同文件的标签也都关闭，也不要子窗口关闭标签
//   被挪到主窗口）。子窗口支持关闭唯一的面板（此时关闭子窗口，并把其中打开的标签
//   合入主窗口）」）：
//   ⑥ Rust 侧的文档是**进程级**的一份，标签却是每个窗口各持一份 —— 本窗口关掉最后一个
//      实例就直接 `close_tab`，会把别人手上那份一起废掉（「同文件的标签也被关了」）。
//      所以关之前要广播问一下（`doc-close-query` / `doc-close-held`），有人拿着就只摘本地。
//   ⑦ 主窗口那份隐藏实例在人家关掉标签时必须作废旧账 —— 留着它，卫星窗口一关就会被
//      `reclaimFromVanished` 恢复成可见标签（「关掉的标签跑到主窗口来了」）。
//   ⑧ 卫星窗口关空一块面板：还有别的面板就只摘这一块（与主窗口同款），别整窗关掉再把
//      别人的标签一并交回主窗口。
//   ⑨ 卫星窗口**唯一的面板可以关** —— 关面板 = 关窗 + 标签交回主窗口（主窗口那块⨯仍禁用）。
//
// 外加一条：主窗口关掉时，在场的卫星窗口跟着收场（否则桌面上会留下孤儿窗口）。
//
// 这些语义**全部**落在跨窗口事件上，而跨窗口事件在 jsdom 里没法真跑（`@tauri-apps/api`
// 需要 Rust 侧的真实 webview），所以与 `multiwindow.test.ts` 一样走**静态契约**：断言
// 「某个函数体里有没有那句调用」。⚠️ 这类断言有两个经典的假绿陷阱，下面的用例都在绕：
//   · 命中**注释**里提到的函数/事件名（所以断言前一律先剥注释）；
//   · 正则太松，退化串一旦是它的**子串**就永远为真（所以关键处带括号/分号收口）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { topLevelFnBody } from "./static";

const src = readFileSync("src/main.ts", "utf-8");
const rust = readFileSync("src-tauri/src/main.rs", "utf-8");

/** 取某个顶层函数的源码体（见 tests/static.ts 的说明）。 */
function fnBody(name: string): string {
  const body = topLevelFnBody(src, name);
  expect(body, `必须能定位 ${name}`).not.toBe("");
  return body;
}

/** 先剥注释再断言：本文件的注释里大量提到函数与事件名，不剥就会假绿。 */
function bare(name: string): string {
  return bare2(src, name);
}

/** 从**指定源码串**里取函数体并剥注释（退化版专用：退化串是改过的内容）。 */
function bare2(source: string, name: string): string {
  const body = topLevelFnBody(source, name);
  expect(body, `必须能定位 ${name}`).not.toBe("");
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("B155 卫星窗口：关闭 = 真关闭（不再把标签交还主窗口）", () => {
  it("卫星窗口的关窗处理器里不许再有「交还主窗口」（B153 那套已经作废）", () => {
    const body = bare("function registerSatelliteClose");
    expect(body, "关窗处理器确实存在").toMatch(/onCloseRequested/);
    // ⚠️ 判据带括号收口：只写 /returnTabsToMain/ 会连注释里提到它的那句一起命中
    //    （本文件注释大量提函数名，所以走的是剥过注释的 `bare()`，这里加括号是为了
    //     挡住「换个写法又交回去」）。
    expect(body, "交还是「关掉的文档又冒回来」的直接原因").not.toMatch(/returnTabsToMain\(/);
    // 「交给主窗口」这张通路本身还在（标签右键「移回主窗口」要用、`requestSatelliteClose`
    // 的 `returnTabs` 也用它），只是关窗这条路上不再走它。
    expect(fnBody("function returnTabsToMain"), "定向交还的入口必须保留").toBeTruthy();
  });

  it("关窗处理器里不许再广播「这些文档我关掉了」（B155 那套，B157 作废）", () => {
    const body = bare("function registerSatelliteClose");
    expect(body, "关窗处理器确实存在").toMatch(/onCloseRequested/);
    expect(body, "B155 那条「广播 + 让对端自己摘」已经废了").not.toMatch(
      /broadcastDocDisposed|doc-disposed/,
    );
    // 事件常量 / 广播函数 / 接收侧三样都不许再存在（留着就是「发出去没人接」的死代码）
    expect(src, "EVT_DOC_DISPOSED 必须整个删掉").not.toMatch(/EVT_DOC_DISPOSED|doc-disposed/);
    expect(src, "广播函数必须删掉").not.toMatch(/function broadcastDocDisposed/);
    expect(src, "接收侧必须删掉").not.toMatch(/function applyDocDisposed/);
    expect(
      src.slice(src.indexOf("function bindEvents")),
      "监听也要拆掉（留着就是空转）",
    ).not.toMatch(/applyDocDisposed/);
  });

  it("关标签只关自己这一份：Rust 侧照删，但不碰主窗口那份", () => {
    const body = bare("function closeTabById");
    expect(body, "删 Rust 文档这步还在（关标签是真关闭）").toMatch(/ipcCloseTab\(doc\.tabId\)/);
    expect(body, "不许再广播给别的窗口让它跟着摘").not.toMatch(/broadcastDocDisposed/);
    // B155 加的「先广播再删」那条顺序契约也随广播一起作废
    expect(body, "closeTabById 里不该再有广播").not.toMatch(/broadcastDocDisposed\(doc\.tabId\)/);
  });
});

describe("B157 子窗口关标签：主窗口那份不许跟着关", () => {
  it("全仓不许再有「对端跟着摘同文档实例」的通道", () => {
    // 用户原话：「子窗口中关闭文件标签时，主窗口中同一个文件的打开标签不能被关闭」
    for (const dead of ["broadcastDocDisposed", "applyDocDisposed"]) {
      expect(src, `${dead} 必须彻底消失`).not.toContain(dead);
    }
    // 接收侧（监听挂载）也要一并拆掉：只删函数不拆监听 = 空转的 `e.payload` 解构。
    // ⚠️ 判据查 `bindEvents` 体而不是 `listen<{ from?: string; docId?` —— 那个形状
    //    `doc-resync-full` / `tabs-return` 两条监听也在用，全局查会误伤（本文件已踩过）。
    expect(bare("function bindEvents"), "监听不能留在 bindEvents 里").not.toMatch(/doc-disposed/);
    expect(src, "EVT_APP_QUIT 那条还在用，别误删").toMatch(/EVT_APP_QUIT/);
  });
});

describe("B155 / B157 卫星窗口：关掉最后一个文件 / 面板 = 关掉窗口", () => {
  it("关空面板的分支里，卫星窗口不许再开一个未命名文档兜底", () => {
    const body = bare("function closeTabById");
    const branch = body.slice(body.indexOf("if (panel.tabs.length === 0)"));
    expect(branch, "空面板分支存在").toMatch(/if \(panel\.tabs\.length === 0\)/);
    // ⚠️ 判据只许落在**卫星窗口**那一段：`newUntitled` / `disposePanel` 在主窗口分支里
    //    本来就有，拿整段做 `not.toMatch` 一定命中 —— 那是本文件最典型的假绿形状。
    //    B161 起卫星窗口那段自己也会出现 `disposePanel`（还有别的面板时只摘这一块），
    //    所以切片不能再用「到第一个 return 为止」那种写法（会把关窗那档切在外面）。
    const atSat = branch.indexOf('if (windowKind === "satellite") {');
    const atMainGuard = branch.indexOf("    if (countLeaves(layout) <= 1) {");
    expect(atSat, "要能定位卫星窗口那段").toBeGreaterThan(-1);
    expect(atMainGuard, "要能定位主窗口那段（且在卫星那段的后面）").toBeGreaterThan(atSat);
    const sat = branch.slice(atSat, atMainGuard);
    expect(sat, "卫星窗口那段确实被切出来了").toMatch(/if \(windowKind === "satellite"\)/);
    expect(sat, "卫星窗口不许 newUntitled（它没有「再开一个」这条退路）").not.toMatch(
      /newUntitled/,
    );
    // B161：**还有别的面板**时，关空一块只摘这一块 —— 原来整窗关掉、把其它面板的标签
    // 一并交回主窗口，用户关的是一个标签，看到的却是别的标签跑去了主窗口。
    expect(sat, "多面板卫星窗口要认「还有别的面板」").toMatch(/countLeaves\(layout\) > 1/);
    expect(sat, "多面板分支只摘这一块（与主窗口同款）").toMatch(/disposePanel\(panel\.panelId\)/);
    // B188：唯一面板被关空 = 「窗口自己关空」那一档，关窗即真关，不交还标签
    expect(sat, "落点不许交还（returnTabs = true 已废）").not.toMatch(
      /requestSatelliteClose\(true\)/,
    );
    expect(sat, "落点走不交还的默认档").toMatch(/requestSatelliteClose\(\)/);
    // 反向自证：主窗口那两条兜底还都在（上面的 not.toMatch 不是因为压根没写）
    expect(branch, "主窗口仍要能新建未命名文档").toMatch(/void newUntitled\(\)/);
    expect(branch, "主窗口仍要能移除空分屏区域").toMatch(/disposePanel\(panel\.panelId\)/);
  });

  it("关窗请求必须走 close() 而不是 destroy()（否则热退出副本收尾会被跳过）", () => {
    const body = bare("function requestSatelliteClose");
    expect(body, "走 close：与点 X 同一条 CloseRequested 链").toMatch(
      /getCurrentWindow\(\)\s*\n?\s*\.close\(\)/,
    );
    expect(body, "直接 destroy 会漏掉 cancelPendingBackup / flushBackups").not.toMatch(
      /\.destroy\(\)/,
    );
  });

  it("自动关窗那档也不交还标签（B188：关窗即真关）", () => {
    const body = bare("function requestSatelliteClose");
    expect(body, "走 close：与点 X 同一条 CloseRequested 链").toMatch(
      /getCurrentWindow\(\)\s*\n?\s*\.close\(\)/,
    );
    // B188：不再有「先交还再关」那一套 —— returnTabs 参数与 returnTabsToMain 分支一并移除
    expect(body, "没有交还分支").not.toMatch(/returnTabsToMain/);
    expect(body, "直接 destroy 会漏掉 cancelPendingBackup / flushBackups").not.toMatch(
      /\.destroy\(\)/,
    );
  });

  it("点 X 那档（默认）不许交还：函数不再带 returnTabs 参数", () => {
    // B188 之前靠 `returnTabs = false` 默认参数保证点 X 不交还；现在参数整个删掉，
    // 函数里再没有「交还」这回事 —— 点 X 默认档（`requestSatelliteClose()`）必然不交还。
    const body = bare("function requestSatelliteClose");
    expect(body, "函数不带 returnTabs 参数（默认即不交还）").not.toMatch(/returnTabs/);
    const reg = bare("function registerSatelliteClose");
    expect(reg, "关窗回调里不许出现交还").not.toMatch(/returnTabsToMain\(/);
  });

  it("主窗口的兜底（分屏时移除面板）必须原样保留", () => {
    const body = bare("function closeTabById");
    const tail = body.slice(body.indexOf("if (panel.tabs.length === 0)"));
    // 卫星窗口那条分支 return 掉之后，主窗口那两行才跑得到。
    expect(tail, "主窗口仍要能新建未命名文档").toMatch(/void newUntitled\(\)/);
    expect(tail, "主窗口仍要能移除空分屏区域").toMatch(/disposePanel\(panel\.panelId\)/);
  });
});

// -------------------------------------------------------------------- B161
// 用户原话：「通过标签上的关闭按钮进行关闭，不管是主窗口还是子窗口，应该都是真正关闭
// 这个标签（不要把其他同文件的标签也都关闭，也不要子窗口关闭标签被挪到主窗口）。
// 子窗口支持关闭唯一的面板（此时关闭子窗口，并把其中打开的标签合入主窗口）」。
//
// 两条症状的共同根因：Rust 侧的文档是**进程级**的一份，而标签每个窗口各持一份 ——
// 本窗口关掉最后一个实例就直接 `close_tab`，会把别人手上那份一起废掉；主窗口留着的
// 隐藏实例又不摘，卫星窗口一关它就恢复成可见标签（「关掉的标签跑到主窗口来了」）。
describe("B161 关标签只关自己这一份：先问一圈，再决定动不动 Rust 那一侧", () => {
  const query = bare("function docHeldElsewhere");
  const answer = bare("function handleDocCloseQuery");

  it("关标签的落点要问「还有没有人拿着」，有人应答就不删 Rust 文档", () => {
    const body = bare("function closeTabById");
    expect(body, "要先问一圈").toMatch(/docHeldElsewhere\(doc\.tabId\)/);
    // 判据要能区分「只摘本地」与「连 Rust 一起删」：后者是有条件的
    expect(body, "有人拿着时不许 close_tab").toMatch(/if \(!held\)/);
    expect(body, "该删的时候还是得删（关标签是真关闭）").toMatch(/ipcCloseTab\(doc\.tabId\)/);
    // ⚠️ 顺序：问必须在删之前（等不到应答就删，问了等于没问）
    const atAsk = body.search(/docHeldElsewhere\(doc\.tabId\)/);
    const atClose = body.search(/ipcCloseTab\(doc\.tabId\)/);
    expect(atAsk, "要能定位问那一句").toBeGreaterThan(-1);
    expect(atClose, "要能定位删那一句").toBeGreaterThan(-1);
    expect(atAsk, "问要排在删之前").toBeLessThan(atClose);
  });

  it("单窗口（没外借过、自己也不是卫星）不必问 —— 省掉那 150ms", () => {
    const body = bare("function closeTabById");
    expect(body, "要不要问是有判据的，不是每次都问").toMatch(/const maybeShared =/);
    // 卫星窗口不知道别人有没有，一律问；主窗口只在「这份文档借出去过」时问。
    expect(body, "卫星窗口一律问").toMatch(/windowKind === "satellite"/);
    // ⚠️ 必须是「曾经借出去过」那份记录（`loanedDocIds`），不能是 `remotedTabs` ——
    //    隐藏实例被「在本窗口重开同一文件」回收后就从 remotedTabs 里消失了，
    //    可别的窗口手上那份还在，只认 remotedTabs 会漏问（又变成一起关掉）。
    expect(body, "主窗口认「借出去过」那份记录").toMatch(/loanedDocIds\.has\(doc\.tabId\)/);
    const remote = bare("function remoteTabLocally");
    expect(remote, "借出去的时候要记一笔").toMatch(/loanedDocIds\.add\(tab\.docId\)/);
  });

  it("应答那一侧：看得见就说一声，只剩隐藏副本就把它作废旧账", () => {
    expect(answer, "还开着可见标签 → 回告「仍持有」").toMatch(
      /emitTo<DocClosePayload>\(from, EVT_DOC_CLOSE_HELD/,
    );
    expect(answer, "没有可见标签 → 主窗口摘掉那份隐藏实例").toMatch(/dropRemotedDoc\(docId\)/);
    // ⚠️ 隐藏实例**不算**「有人拿着」：留着它才是「关了又冒回来」的根。
    const helper = bare("function hasVisibleInstanceOf");
    expect(helper, "可见性判据要排除隐藏实例（panelId === -1）").toMatch(/t\.panelId !== -1/);
    const drop = bare("function dropRemotedDoc");
    expect(drop, "摘的是 remotedTabs 里那份").toMatch(/remotedTabs\.delete\(docId\)/);
    expect(drop, "标签也一起摘（否则它会随下次回收复活）").toMatch(/tabs\.delete\(v\.tabId\)/);
    expect(drop, "摘完要排程落盘（会话里不该再挂着它）").toMatch(/scheduleSessionSave\(\)/);
  });

  it("问的那一刻：先装监听再广播，且认自己的回声", () => {
    // ⚠️ 顺序反了会**假绿**：回得快的一方在监听就位之前就把应答发了，发起方一条都
    //    收不到 ⇒ 判定成「没人拿着」⇒ 又把别人的那份一起关掉。
    const atListen = query.search(/listen<DocClosePayload>\(EVT_DOC_CLOSE_HELD/);
    const atEmit = query.search(/emit<DocClosePayload>\(EVT_DOC_CLOSE_QUERY/);
    expect(atListen, "要能定位装监听那句").toBeGreaterThan(-1);
    expect(atEmit, "要能定位广播那句").toBeGreaterThan(-1);
    expect(atListen, "监听必须先于广播（否则漏收应答）").toBeLessThan(atEmit);
    expect(query, "广播本机也收得到自己的回声，要丢掉").toMatch(/p\.from !== windowLabel/);
    // 没人应答也要有出口，否则关标签就永远卡住
    expect(query, "要有超时兜底").toMatch(/setTimeout\(\(\) => finish\(false\)/);
  });

  it("两种窗口都要接这条问询（监听挂在 listenDocSync 里）", () => {
    const listen = bare("function listenDocSync");
    expect(listen, "监听要挂上").toMatch(/EVT_DOC_CLOSE_QUERY/);
    expect(listen, "自己的回声要丢").toMatch(/p\.from === windowLabel/);
    expect(listen, "受理函数要真的被调用").toMatch(/handleDocCloseQuery\(p\.docId, p\.from\)/);
  });
});

describe("B161 子窗口可以关掉唯一的面板（= 关窗，不交回主窗口）", () => {
  it("closePanelById：卫星窗口唯一的面板走「关窗」而不是「什么都不做」", () => {
    const body = bare("function closePanelById");
    expect(body, "卫星窗口那一段要有专门的分支").toMatch(
      /windowKind === "satellite" && countLeaves\(layout\) <= 1/,
    );
    // B188：落点是「真关窗、不交还」——点 X 与关空时的语义统一了，卫星关窗就是关窗
    expect(body, "落点不许交还（returnTabs = true 已废）").not.toMatch(
      /requestSatelliteClose\(true\)/,
    );
    expect(body, "落点走不交还的默认档").toMatch(/requestSatelliteClose\(\)/);
    // ⚠️ 顺序：卫星那一档必须排在「唯一面板 → 直接 return」之前，反了就永远够不到
    const atSat = body.search(/windowKind === "satellite"/);
    const atBail = body.search(/if \(countLeaves\(layout\) <= 1\) return;/);
    expect(atSat, "要能定位卫星那一档").toBeGreaterThan(-1);
    expect(atBail, "要能定位「唯一面板不做任何事」那句").toBeGreaterThan(-1);
    expect(atSat, "卫星那一档要排在放行判据之前").toBeLessThan(atBail);
  });

  it("⨯ 的显隐：主窗口唯一面板仍禁用，卫星窗口可关；副标题要说清后果", () => {
    const at = src.indexOf("const data = new Map<number, PanelRenderData>();");
    expect(at, "要能定位面板渲染数据的组装处").toBeGreaterThan(-1);
    const block = src.slice(at, at + 700);
    expect(block, "卫星窗口唯一的面板也能关").toMatch(
      /canClose: countLeaves\(layout\) > 1 \|\| windowKind === "satellite"/,
    );
    expect(block, "卫星唯一面板要换个副标题（不是「并入相邻面板」）").toMatch(
      /closeDetail:\s*\n\s*windowKind === "satellite"/,
    );
    expect(block, "副标题要说清是关窗、不交回主窗口").toMatch(
      /关闭该子窗口（其中的文件不会交回主窗口）/,
    );
    // 渲染侧真要用上这个字段，否则只是摆设
    const view = readFileSync("src/shell/splitview.ts", "utf-8");
    expect(view, "渲染侧要认 closeDetail").toMatch(/data\.closeDetail \?\?/);
  });
});

describe("B155 主窗口关窗时，卫星窗口跟随关闭", () => {
  it("主窗口收尾要先广播 app-quit，再销毁自己", () => {
    const body = bare("async function finishAndDestroy");
    // ⚠️ 判据取**最后一次** emit 的位置：只看第一处会被「原来那处还在，又在销毁后
    //    补发一次」骗过去 —— 那样 emit 倒是有了，顺序照样是错的（曾在此假绿）。
    const emits = [...body.matchAll(/emit\(EVT_APP_QUIT/g)].map((m) => m.index ?? 0);
    expect(emits.length, "退出广播必须发").toBeGreaterThan(0);
    const lastEmit = Math.max(...emits);
    const destroys = [...body.matchAll(/await destroySelf\(\)/g)].map((m) => m.index ?? 0);
    expect(destroys.length, "销毁确实在 finishAndDestroy 里").toBeGreaterThan(0);
    expect(lastEmit, "广播必须排在销毁之前（晚了子窗口收不到）").toBeLessThan(
      Math.min(...destroys),
    );
  });

  it("只有卫星窗口装 app-quit 监听（发广播的是主窗口，收的是别人）", () => {
    const init = bare("async function initSatelliteWindow");
    expect(init, "卫星窗口必须监听退出广播").toMatch(/listen\(EVT_APP_QUIT/);
    expect(init, "收到就销毁自己").toMatch(/destroySelf\(\)/);
    expect(
      bare("async function finishAndDestroy"),
      "主窗口不收这条广播（否则会自己关自己）",
    ).not.toMatch(/listen\(EVT_APP_QUIT/);
  });

  it("Rust 侧留一道进程级兜底：主窗口 Destroyed 也广播 app-quit", () => {
    // 前端那条只在「主窗口被正常关闭」时成立；任务管理器结束 / 崩溃 / 装完更新重启
    // 都走不到那串 await，这条广播是唯一还能跨过死亡边界的东西（同 satellite-closed）。
    const handler = rust.slice(rust.indexOf(".on_window_event("));
    expect(handler, "on_window_event 存在").toContain("WindowEvent::Destroyed");
    expect(handler, "主窗口分支要跳过 satellite-closed 的兜底").toContain("MAIN_LABEL");
    expect(handler, "主窗口销毁时要广播 app-quit").toMatch(/MAIN_LABEL[\s\S]{0,400}?"app-quit"/);
  });
});

describe("B188 干净关窗：隐藏实例作废旧账，不接回主窗口", () => {
  it("finishSatelliteClose 发 satellite-clean-close（在 destroySelf 之前）", () => {
    const body = bare("async function finishSatelliteClose");
    // 必须先发 clean-close，主窗口的「作废旧账」才能排在 Rust 的 `satellite-closed`
    // (Destroyed) 之前 —— 否则崩溃兜底 reclaimFromVanished 会把刚关的子窗口标签又接回。
    const atClean = body.search(/emit\("satellite-clean-close"/);
    const atDestroy = body.search(/await destroySelf\(\)/);
    expect(atClean, "要能定位 clean-close 广播").toBeGreaterThan(-1);
    expect(atDestroy, "要能定位 destroySelf").toBeGreaterThan(-1);
    expect(atClean, "clean-close 必须排在销毁之前").toBeLessThan(atDestroy);
    // ⚠️ 顺序：EVT_WINDOW_CLOSED 与 clean-close 都在 destroy 前即可，二者先后不敏感，
    //     但 clean-close 一定在 destroy 前（主窗口才有机会先清空 remotedTabs）。
    expect(body, "clean-close 携带本窗口 label").toMatch(
      /satellite-clean-close",\s*\{\s*label:\s*windowLabel\s*\}/,
    );
  });

  it("主窗口引导装 satellite-clean-close 监听，且调用 dropRemotedForOwner（不是 reclaim）", () => {
    const boot = bare("async function bootstrap");
    const at = boot.indexOf('void listen<{ label?: string }>("satellite-clean-close"');
    expect(at, "必须装 satellite-clean-close 监听").toBeGreaterThan(-1);
    const seg = boot.slice(at, at + 260);
    expect(seg, "监听里要调 dropRemotedForOwner").toMatch(/dropRemotedForOwner\(/);
    expect(seg, "干净关窗不许走崩溃兜底 reclaim").not.toMatch(/reclaimFromVanished\(/);
  });

  it("dropRemotedForOwner：按 owner 批量摘掉隐藏实例", () => {
    const body = bare("function dropRemotedForOwner");
    expect(body, "只主窗口处理").toMatch(/windowKind !== "main"\) return;/);
    // 按 owner 过滤 remotedTabs 后逐条 dropRemotedDoc
    expect(body, "按 owner 过滤").toMatch(/remotedTabs\.entries\(\)\]/);
    expect(body, "过滤条件看 owner").toMatch(/v\.owner === label/);
    expect(body, "逐条作废旧账").toMatch(/dropRemotedDoc\(docId\)/);
  });

  it("崩溃兜底 reclaimFromVanished 仍只在 satellite-closed 上触发（未被 clean-close 替代）", () => {
    // 这条是异常路径的保险：卫星崩溃 / 被杀时够不到前端收尾，clean-close 发不出，
    // remotedTabs 仍有条目 → satellite-closed → reclaimFromVanished 把它们恢复回来。
    const boot = bare("async function bootstrap");
    expect(boot, "satellite-closed 监听仍在（崩溃兜底）").toMatch(
      /listen<\{ label\?:\s*string \}>\("satellite-closed"/,
    );
    const reg = bare("function reclaimFromVanished");
    expect(reg, "崩溃兜底仍调 reclaimRemoted").toMatch(/reclaimRemoted\(/);
  });
});

describe("B161 反向验证：退回旧写法，上面那几条必须变红", () => {
  it("退回「不管有没有人拿着都 close_tab」→「有人应答就不删」那条必须落空", () => {
    const ORIG = "if (!held) {";
    expect(bare("function closeTabById"), "退化串要先自证原句还在").toMatch(/if \(!held\) \{/);
    // 无条件删：把条件收起来，Rust 那一侧照删不误
    const degraded = src.replace(ORIG, "if (false || true) {");
    expect(bare2(degraded, "function closeTabById"), "退化了就认不出「有条件才删」").not.toMatch(
      /if \(!held\)/,
    );
  });

  it("退回「只看 remotedTabs 判断借出」→「认借出去过那份记录」那条必须落空", () => {
    // ⚠️ 隐藏实例被「在本窗口重开同一文件」回收后就从 remotedTabs 里消失了，可别的
    //    窗口手上那份还在 —— 只认 remotedTabs 会漏问，又变成一起关掉。
    const ORIG = "loanedDocIds.has(doc.tabId)";
    expect(bare("function closeTabById"), "退化串要先自证原句还在").toContain(ORIG);
    const degraded = src.replace(ORIG, "remotedTabs.has(doc.tabId)");
    expect(bare2(degraded, "function closeTabById"), "退化后就不认 loanedDocIds 了").not.toMatch(
      /loanedDocIds\.has\(doc\.tabId\)/,
    );
  });

  it("把「先装监听再广播」倒过来 → 顺序那条必须落空", () => {
    const AT =
      "        void emit<DocClosePayload>(EVT_DOC_CLOSE_QUERY, { from: windowLabel, docId }).catch(\n          () => {},\n        );";
    expect(src, "退化串要先自证原句还在").toContain(AT);
    // 挪到函数体最前面：监听还没就位就广播，应答收不到 ⇒ 判定「没人拿着」⇒ 一起关掉
    const degraded = src
      .replace(AT, "")
      .replace(
        "function docHeldElsewhere(docId: number, waitMs = 150): Promise<boolean> {\n  return new Promise((resolve) => {",
        "function docHeldElsewhere(docId: number, waitMs = 150): Promise<boolean> {\n  void emit<DocClosePayload>(EVT_DOC_CLOSE_QUERY, { from: windowLabel, docId }).catch(() => {});\n  return new Promise((resolve) => {",
      );
    const body = bare2(degraded, "function docHeldElsewhere");
    const atListen = body.search(/listen<DocClosePayload>\(EVT_DOC_CLOSE_HELD/);
    const atEmit = body.search(/emit<DocClosePayload>\(EVT_DOC_CLOSE_QUERY/);
    expect(atEmit, "广播那句还在（只是挪了位置）").toBeGreaterThan(-1);
    expect(atEmit, "退化后广播跑到了监听前面").toBeLessThan(atListen);
  });

  it("把隐藏实例也算「有人拿着」→ 排除 panelId===-1 那条必须落空", () => {
    const ORIG = "if (t.docId === docId && t.panelId !== -1) return true;";
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = src.replace(ORIG, "if (t.docId === docId) return true;");
    expect(
      bare2(degraded, "function hasVisibleInstanceOf"),
      "退化后隐藏实例也被当成可见标签",
    ).not.toMatch(/t\.panelId !== -1/);
  });

  it("退回「唯一面板一律不可关」→ 卫星关面板那条必须落空", () => {
    const ORIG = 'if (windowKind === "satellite" && countLeaves(layout) <= 1) {';
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = src.replace(ORIG, "if (false) {");
    expect(bare2(degraded, "function closePanelById"), "退化后卫星唯一面板就关不掉了").not.toMatch(
      /windowKind === "satellite" && countLeaves\(layout\) <= 1/,
    );
  });

  it("退回「卫星窗口关空一块就关整窗」→ 多面板只摘这一块那条必须落空", () => {
    const ORIG =
      "      if (countLeaves(layout) > 1) {\n        // B161：还有别的面板，就只摘这一块（与主窗口同款）—— 原来这里会整窗关掉、\n        // 顺手把其它面板的标签一并交回主窗口 ⇒ 用户关的明明是一个标签，看到的却是\n        // 别的标签跑去了主窗口。\n        disposePanel(panel.panelId);\n        return;\n      }\n";
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    // 退化：直接关整窗（B161 前状）
    const degraded = src.replace(ORIG, "");
    const body = bare2(degraded, "function closeTabById");
    const atSat = body.indexOf('if (windowKind === "satellite") {');
    const atMainGuard = body.indexOf("    if (countLeaves(layout) <= 1) {");
    const sat = body.slice(atSat, atMainGuard);
    expect(sat, "退化后卫星那段不再有「只摘这一块」那条路").not.toMatch(
      /disposePanel\(panel\.panelId\)/,
    );
  });
});
