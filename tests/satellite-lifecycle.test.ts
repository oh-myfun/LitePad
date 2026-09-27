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
  return fnBody(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
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
    const sat = branch.slice(0, branch.search(/return;\s*\n\s*\}/));
    expect(sat, "卫星窗口那段确实被切出来了").toMatch(/if \(windowKind === "satellite"\)/);
    expect(sat, "卫星窗口只许请求关窗，不许 newUntitled").not.toMatch(/newUntitled/);
    expect(sat, "卫星窗口只许请求关窗，不许 disposePanel").not.toMatch(/disposePanel/);
    // B157：这一档是「窗口自己关空」，手上没关的标签要先交回主窗口
    expect(sat, "落点必须带 returnTabs = true").toMatch(/requestSatelliteClose\(true\)/);
    expect(sat, "不能退化成不带参数的默认档（那等于不交还）").not.toMatch(
      /requestSatelliteClose\(\);/,
    );
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

  it("自动关窗那档要交还剩余标签，且排在 close() 之前", () => {
    // 用户原话：「关闭子窗口和最后一个面板后子窗口关闭，没有关闭的文件标签还是加回主窗口」
    const body = bare("function requestSatelliteClose");
    expect(body, "参数要存在（两档口径不一样）").toMatch(/returnTabs\s*=\s*false/);
    const at = (pat: RegExp): number => body.search(pat);
    const retAt = at(/returnTabs && windowKind === "satellite"[\s\S]{0,80}?returnTabsToMain/);
    const closeAt = at(/getCurrentWindow\(\)/);
    expect(retAt, "交还必须发生在关窗之前（窗口一销毁 emit 就没人收了）").toBeGreaterThanOrEqual(0);
    expect(closeAt, "close() 调用还在").toBeGreaterThanOrEqual(0);
    expect(retAt, "交还必须先于 close()").toBeLessThan(closeAt);
    // 交还是「剩余的全部」—— 此时刚关掉的那个已经从 tabs 里摘了，剩下的都是没关的
    expect(body, "交还手上剩余的标签").toMatch(/returnTabsToMain\(\[\.\.\.tabs\.keys\(\)\]\)/);
  });

  it("点 X 那档（默认）不许交还：默认参数必须是 false", () => {
    // `registerSatelliteClose` 走的就是默认档，默认 true 就等于「点 X 也交还」——
    // B153 的 bug 会原样复活。
    const body = bare("function requestSatelliteClose");
    expect(body, "默认档 = 不交还").toMatch(/returnTabs = false/);
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
