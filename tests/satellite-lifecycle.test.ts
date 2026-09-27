// @vitest-environment jsdom
// B155：**卫星窗口的生命周期**（「关闭」到底意味着什么，三条口径一次钉死）。
//
//   ① 关掉子窗口 = 真关：关掉的文档不许再回到主窗口；
//   ② 关掉子窗口里的文件 = 真关：本窗口摘掉的那一份，别的窗口那份也要跟着摘；
//   ③ 关掉子窗口里的最后一个文件 / 最后一个面板 = 关掉子窗口（没有「再来一个未命名」的兜底）。
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
    expect(body, "交还是「关掉的文档又冒回来」的直接原因").not.toMatch(/returnTabsToMain\(/);
    // 「交给主窗口」这张通路本身还在（标签右键「移回主窗口」要用），只是关窗不再走它。
    expect(fnBody("function returnTabsToMain"), "定向交还的入口必须保留").not.toBe("");
  });

  it("关窗前必须广播「这些文档我关掉了」，让别的窗口自己摘", () => {
    const body = bare("function registerSatelliteClose");
    expect(body, "关窗时要把手上的文档逐个广播").toMatch(
      /for \(const docId of new Set\(ids\)\) broadcastDocDisposed\(docId\)/,
    );
    // 事件名三处必须一致：常量 / 广播 / 接收侧监听（对不上就是「发出去没人接」）。
    for (const evt of ["doc-disposed", "app-quit"]) {
      expect(src, `事件名 ${evt} 必须同时出现在常量、广播与监听里`).toContain(`"${evt}"`);
    }
    expect(fnBody("function broadcastDocDisposed"), "广播函数必须存在").not.toBe("");
    expect(fnBody("function applyDocDisposed"), "接收侧必须存在").not.toBe("");
  });

  it("接收侧要认 from：自己发的那份必须被跳过", () => {
    const body = bare("function applyDocDisposed");
    expect(body, "全局 emit 连自己一起收，不自滤就会把刚摘掉的又摘一遍").toMatch(
      /from === windowLabel/,
    );
    expect(body, "只对同 docId 的实例动手").toMatch(/t\.docId === docId/);
    // 删除由发起窗口负责（只有它知道自己是不是最后一个），这里只摘不删。
    expect(body, "接收侧不许碰 Rust 侧文档").not.toMatch(/ipcCloseTab\(/);
  });

  it("关标签走真关闭：删 Rust 文档之前先广播（顺序反了就是对端变空壳）", () => {
    const body = bare("function closeTabById");
    const at = (pat: RegExp): number => body.search(pat);
    const emitAt = at(/broadcastDocDisposed\(doc\.tabId\)/);
    const delAt = at(/ipcCloseTab\(doc\.tabId\)/);
    expect(emitAt, "删除前必须先广播").toBeGreaterThanOrEqual(0);
    expect(delAt, "删除确实在 closeTabById 里").toBeGreaterThanOrEqual(0);
    expect(emitAt, "广播必须排在删文档之前").toBeLessThan(delAt);
  });
});

describe("B155 卫星窗口：关掉最后一个文件 / 面板 = 关掉窗口", () => {
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
    expect(sat, "落点必须是关窗请求").toMatch(/requestSatelliteClose\(\);/);
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
