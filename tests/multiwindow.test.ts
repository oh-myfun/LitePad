// @vitest-environment jsdom
// B71 ④：**拖出到新窗口** = 同一批文档的第二扇窗（不是复制一份）。
//
// 语义要点：拖出去的是「视图」，不是副本 —— 两个窗口共享同一份文档状态，
// 所以落点窗口拿到的必须是**同一批 docId**，而不是新建一组。
// 从 `tests/regressions.test.ts` 按模块拆出（09-22）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readJson, topLevelFnBody } from "./static";

describe("B71 ④ 拖出到新窗口 = 同一批文档的第二扇窗（不是复制一份）", () => {
  const src = readFileSync("src/main.ts", "utf-8");
  const rust = readFileSync("src-tauri/src/windows.rs", "utf-8");
  const api = readFileSync("src/ipc/api.ts", "utf-8");
  const caps = readJson("src-tauri/capabilities/default.json");

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("卫星窗口 label 前缀必须被 ACL 通配覆盖（漏了 = 界面能画但 emit/listen 全废）", () => {
    expect(caps.windows, "windows 必须用通配覆盖 sat-*").toContain("sat-*");
    expect(caps.windows, "主窗口也要留在授权名单里").toContain("main");
    expect(rust, "Rust 侧前缀常量必须与 capabilities 一致").toMatch(/SAT_PREFIX: &str = "sat-"/);
    expect(caps.permissions, "core:default 必须在授权里（它内含 core:window:default）").toContain(
      "core:default",
    );

    // B91-2 起跨窗口落点**不再读窗口几何**：`dragend` 直接带回屏幕坐标，源窗口不需要
    // `outerPosition/outerSize/innerSize/scaleFactor` 这套（B89 的 `dropSpotOf` 因此被删）。
    // 这条守卫把「不依赖窗口几何」钉住 —— 一旦有人重新引入，就得同时补 ACL，
    // 否则在卫星窗口上会被 ACL 静默拒掉（catch 咽成 null，落点悄悄退回系统摆放）。
    const spotFn = fnBody("function desktopSpotOf");
    expect(spotFn, "落点只由屏幕坐标算出，不读窗口几何").not.toMatch(
      /outerPosition|outerSize|innerSize|scaleFactor/,
    );

    // 窗口 API 使用面必须落在已授权清单内：源码一旦用上需要额外授权的窗口接口，就在
    // **这里**红掉，而不是等到卫星窗口静默失灵。当前窗口调用只有标题/关闭/销毁三条。
    for (const p of ["core:window:allow-set-title", "core:window:allow-close"]) {
      expect(caps.permissions, `窗口接口 ${p} 必须显式授权`).toContain(p);
    }
    for (const f of [
      "src/main.ts",
      "src/shell/splitview.ts",
      "src/shell/tabstrip.ts",
      "src/shell/tabdnd.ts",
      "src/shell/filedrop.ts",
    ]) {
      const code = readFileSync(f, "utf-8");
      expect(code, `${f} 不得使用需要额外授权的窗口接口`).not.toMatch(
        /setPosition|setSize|setFullscreen|setAlwaysOnTop|outerPosition|outerSize|innerSize|scaleFactor/,
      );
    }
  });

  it("跨窗口同步只传变更集，且必须带基准长度（基准是防分叉的唯一凭据）", () => {
    // 基准长度是「两边说的是同一份文本」的证据：位置增量套在错的基准上会在错的地方
    // 插入文本，属于静默改坏用户内容，比不同步严重得多。
    const body = fnBody("function broadcastDocChange");
    expect(body, "基准长度必须真的写进广播载荷（只出现在参数表里等于没传）").toMatch(
      /baseLen,\s*\n\s*changes: changes\.toJSON\(\),/,
    );
    expect(body, "发的是变更集而不是全文").toMatch(/changes: changes\.toJSON\(\)/);
    expect(body, "正在套用远端变更时不得再广播（否则无限弹）").toMatch(/applyingRemote/);
    const upd = fnBody("function handleUpdate");
    expect(upd, "编辑后要广播，且只有文本真变才广播").toMatch(
      /if \(textChanged\) broadcastDocChange\(tab\.docId, update\.changes, update\.startState\.doc\.length\)/,
    );
    expect(src, "两种窗口都要装同步监听").toMatch(/listenDocSync\(\);/);
  });

  it("基准不符 = 分叉：不许硬套增量，必须转为要一份全文", () => {
    const body = fnBody("function applyRemoteDocChange");
    expect(body, "基准校验失败 → 走重同步").toMatch(
      /t\.state\.doc\.length !== baseLen[\s\S]{0,200}requestDocResync\(docId\)/,
    );
    expect(body, "变更集解析失败也要走重同步（不能吞掉）").toMatch(
      /catch \{[\s\S]{0,120}requestDocResync\(docId\)/,
    );
    expect(body, "远端变更要按同源多实例落到每个实例").toMatch(/instances/);
    expect(body, "远端改了内容 → 本窗口这份也要变脏").toMatch(/doc\.dirty = true/);
    // 接收侧不得自己排自动保存/副本：同一个文件两边写会互相触发 file-changed
    expect(body, "接收侧不许排自动保存").not.toContain("scheduleAutosave()");
    expect(body, "接收侧不许排热退出副本").not.toContain("scheduleBackup()");
    const req = fnBody("function requestDocResync");
    expect(req, "重同步请求要防抖（同一个文档不连发）").toMatch(/resyncPending/);
    expect(req, "广播要带窗口身份，供对端定向应答").toMatch(/from: windowLabel/);
    // 三个事件名必须一致（对不上就是「发出去了没人接」）
    for (const evt of ["doc-change", "doc-resync-request", "doc-resync-full"]) {
      expect(src, `事件名 ${evt} 必须同时出现在常量与监听里`).toContain(`"${evt}"`);
    }
  });

  it("全文纠错不得覆盖本窗口未保存的修改（分叉时谁更新无从判断）", () => {
    const body = fnBody("function applyDocResyncFull");
    expect(body, "本地是脏的就不动手，只提示").toMatch(/if \(doc\?\.dirty\)[\s\S]{0,200}return;/);
    // 全文替换必须整态重建，否则视图与 tab.state 会不同步（后续切标签立刻串档）
    expect(body, "整段替换要经过 setState").toMatch(/setState\(whole\)/);
  });

  it("拖拽途中只预览、松手才提交；正文只在有人认领时定向发出（B89/B91-2）", () => {
    // B89 定下的语义一字未改，B91-2 只把「谁被指着」的判据从**广播指针坐标**换成
    // **系统拖放事件**：
    //   · dragover 阶段只画落点（`preview`），源窗口零副作用；
    //   · drop 才提交（本窗口直接消化，跨窗口先定向认领）。
    const dnd = readFileSync("src/shell/tabdnd.ts", "utf-8");
    const dndCode = dnd.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    /** 截取某个处理器（`from` 起点到 `to` 起点之间），避免跨处理器误判。 */
    const seg = (from: string, to: string): string => {
      const a = dndCode.indexOf(from);
      const b = dndCode.indexOf(to);
      return a >= 0 && b > a ? dndCode.slice(a, b) : "";
    };

    // ① dragover 只预览，绝不提交（也绝不碰源窗口的标签）
    const overBody = seg("const onOver", "const onLeave");
    expect(overBody, "dragover 画落点预览").toMatch(
      /cfg\.preview\(e\.clientX, e\.clientY, e\.altKey\)/,
    );
    expect(overBody, "dragover 阶段绝不提交").not.toMatch(/commitLocal|relinquish|onFallback/);
    // ⚠️ 必须拦住默认动作：不拦的话光标是禁止态，drop 根本不触发。
    //    B91-2 收尾把「拦」集中到 claim() 一处做（preventDefault + stopPropagation），
    //    dragover 先认领即可 —— 顺带解决「标签拖拽事件漏进编辑器、把文件名插进正文」
    //    那个 bug（见 ③″）。
    expect(overBody, "dragover 先认领（认领里拦默认动作）").toMatch(/if \(!claim\(e\)\) return;/);
    expect(dndCode, "认领要真的拦住默认动作").toMatch(
      /const claim = \(e: DragEvent\): boolean => \{[\s\S]{0,200}?e\.preventDefault\(\)/,
    );

    // ② drop 才提交：本窗口直接消化；别的窗口先认领
    const dropBody = seg("const onDrop", "const onDragEnd");
    expect(dropBody, "drop 才 commitLocal").toMatch(/cfg\.commitLocal\(\{/);
    expect(dropBody, "跨窗口先定向认领（emitTo 源窗口）").toMatch(
      /emitTo\(payload\.from, EVT_TAB_CLAIM, \{[\s\S]{0,140}?dragId: payload\.dragId/,
    );
    // ⚠️ 本窗口落点必须**就地收尾，不等 dragend**：落点常会重建面板 DOM，源标签元素
    // 随之脱离文档，而 dragend 是派发到源元素上的（脱离文档就不再冒泡到 document）——
    // 等它的后果是 `body.tab-drag-active` 一直挂着。这是实现里踩出来的真 bug。
    expect(dropBody, "本窗口落点就地清拖拽态").toMatch(
      /payload\.from === cfg\.selfLabel[\s\S]{0,600}?classList\.remove\(TAB_DRAG_CLASS\)/,
    );

    // ③ 整组拖出 = 该面板的全部标签（以松手那一刻的实际状态为准，不随拖拽携带 id 表）
    const ids = fnBody("function dragTabIds");
    expect(ids, "整组取该面板全部标签").toMatch(
      /groupPanelId === null[\s\S]{0,90}?return \[payload\.tabId\];[\s\S]{0,130}?panels\.get\(payload\.groupPanelId\)\?\.tabs/,
    );

    // ④ 正文只在有人认领时定向发（绝不广播）
    const snap = fnBody("function snapshotDrag");
    expect(snap, "快照按这次拖拽涉及的标签摊平（正文一起带走）").toMatch(/dragTabIds\(payload\)/);
    const claimBody = seg("const onClaim", "const onPayload");
    expect(claimBody, "认领要配对 dragId（防跨拖拽串台）").toMatch(/takeForClaim\(dragId\)/);
    expect(claimBody, "正文定向投递（emitTo 认领方）").toMatch(
      /emitTo\(from, EVT_TAB_PAYLOAD, \{[\s\S]{0,180}?tabs: snapshots/,
    );
    expect(claimBody, "交出去后本地立刻收尾").toMatch(/cfg\.relinquish\(payload, from\)/);

    // ⑤ 没人认领才回落：卫星窗口交回主窗口；主窗口在落点开新窗
    const body = fnBody("async function dropOnDesktop");
    expect(body, "卫星窗口交回主窗口").toMatch(
      /windowKind === "satellite"[\s\S]{0,180}?returnTabsToMain\(ids\)/,
    );
    expect(body, "主窗口在落点开新窗").toMatch(
      /openTabsInNewWindow\(ids, desktopSpotOf\(screenX, screenY\)\)/,
    );
    // ⚠️ 回落只在「过了宽限期还没人认领」时触发 —— 认领是 IPC 往返，必然晚于 dragend。
    // 没有这段宽限，每一次成功的跨窗口拖拽都会同时被当成「扔在桌面上」→ 标签被复制成两份。
    const endBody = seg("const onDragEnd", "const onClaim");
    expect(endBody, "回落要等认领宽限").toMatch(
      /setTimeout\([\s\S]{0,240}?if \(s\.taken\) return;[\s\S]{0,90}?onFallback/,
    );
  });

  it("跨窗口拖拽协议：正文绝不广播，只在认领时定向投递（B91-2）", () => {
    // hover/release 只带坐标、正文走定向投递（B89）的规矩没变，只是事件从
    // 「广播坐标 + 200ms 抢单」换成「目标窗口定向 claim → 源窗口定向 payload」：
    // 广播一次 = 每个窗口都收到一份，正文跟着广播就是「几十 MB × 窗口数」。
    const dnd = readFileSync("src/shell/tabdnd.ts", "utf-8");
    const dndCode = dnd.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    expect(dndCode, "claim 定向投递").toMatch(/emitTo\(payload\.from, EVT_TAB_CLAIM/);
    expect(dndCode, "payload 定向投递").toMatch(/emitTo\(from, EVT_TAB_PAYLOAD/);
    expect(dndCode, "正文绝不广播（不得出现 emit(EVT_TAB_PAYLOAD）").not.toMatch(
      /emit\(EVT_TAB_PAYLOAD/,
    );
    expect(dndCode, "claim 也不得广播").not.toMatch(/emit\(EVT_TAB_CLAIM/);
    // 两个窗口都要装接收侧（谁都可能成为落点）
    expect(src, "两个窗口都装接收侧").toMatch(
      /void installTabDnd\(\{\s*\n\s*selfLabel: windowLabel,/,
    );
    expect(src, "落点用**本窗口**算出来的那块（预览在哪就落哪）").toMatch(
      /preview: \(x, y, altKey\) => previewDropAt\(x, y, altKey\)/,
    );
    // ⚠️ 上游接线：「函数写对了但没人这么调」是最常见的漏网形态 —— 每个回调都得真的
    //    接到宿主的实现上，漏一个就是「某条路径静默不工作」。
    expect(src, "落点提交接到 commitTabDrop").toMatch(
      /commitLocal: \(req\) => commitTabDrop\(req\)/,
    );
    expect(src, "快照取本地标签").toMatch(/snapshot: \(payload\) => snapshotDrag\(payload\)/);
    expect(src, "交出去之后本地收尾").toMatch(
      /relinquish: \(payload, toLabel\) => relinquishDrag\(payload, toLabel\)/,
    );
    expect(src, "接住别的窗口送来的标签").toMatch(
      /adopt: \(tabs, spot\) => acceptDroppedTabs\(tabs, spot as DropSpot \| null\)/,
    );
    expect(src, "没人接手才回落").toMatch(
      /onFallback: \(payload, sx, sy\) => void dropOnDesktop\(payload, sx, sy\)/,
    );
    expect(src, "载荷读不出来要留一行日志（否则静默无效排不动）").toMatch(
      /onWarn: \(what\) => logEvent\("drop", what\)/,
    );
  });

  it("拖拽收尾：源窗口只清自己的痕迹，目标窗口的落点要留到正文到达（B90/B91-2）", () => {
    // B90 的病根：发起窗口的收尾**早于**落点提交，目标窗口若跟着清掉落点，正文到达时
    // 就不知道放哪儿了（表现为「预览在这、落下在那」）。B91-2 起落点根本不经过 IPC：
    // 目标窗口把 drop 时算好的 spot 攒着，只由它的 `adopt` 消费。
    const dnd = readFileSync("src/shell/tabdnd.ts", "utf-8");
    const dndCode = dnd.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const seg = (from: string, to: string): string => {
      const a = dndCode.indexOf(from);
      const b = dndCode.indexOf(to);
      return a >= 0 && b > a ? dndCode.slice(a, b) : "";
    };

    // ① 源窗口的收尾只清本窗口的痕迹（拖拽态类 + 落点预览）
    const endBody = seg("const onDragEnd", "const onClaim");
    expect(endBody, "收尾清掉拖拽态类").toMatch(/classList\.remove\(TAB_DRAG_CLASS\)/);
    expect(endBody, "收尾清掉本窗口的落点痕迹").toMatch(/config\?\.clear\(\)/);

    // ② 目标窗口必须**留住落点**：drop 时攒下来，等正文（payload）到达才落地
    const dropBody = seg("const onDrop", "const onDragEnd");
    expect(dropBody, "drop 时把落点攒下来等正文").toMatch(
      /pendingForeign = \{ dragId: payload\.dragId, spot \}/,
    );
    const payloadBody = seg("const onPayload", "document.addEventListener");
    expect(payloadBody, "正文到达才用掉落点").toMatch(/cfg\.adopt\(p\.tabs, pend\.spot\)/);
    // 同一次拖拽只落地一次（避免重复 adopt 把标签插两遍）
    expect(payloadBody, "消费后立即作废落点").toMatch(/pendingForeign = null;/);
  });

  it("移空的面板要摘掉，不留空框（B90）", () => {
    const prune = fnBody("function pruneEmptyPanels");
    expect(prune, "唯一面板不摘（摘了就没地方放标签）").toMatch(/countLeaves\(layout\) <= 1/);
    expect(prune, "摘之前先还原最大化").toMatch(/exitMaximize\(\)/);
    // 标签被别的窗口要走后必须清理空面板：两条路径都在 relinquishDrag 里 ——
    // 主窗口侧走 remoteTabLocally（留隐藏实例），卫星侧走 detachLocally（直接摘）。
    const rel = fnBody("function relinquishDrag");
    expect(rel, "卫星侧：摘本地视图后清空面板").toMatch(
      /detachLocally\(ids\);[\s\S]{0,160}?pruneEmptyPanels\(\)/,
    );
    expect(rel, "主窗口侧：登记隐藏实例后清空面板").toMatch(
      /remoteTabLocally\(id, toLabel\);[\s\S]{0,200}?pruneEmptyPanels\(\)/,
    );
    // 交回主窗口（窗口外松手的回落路径）同样不留空面板
    const back = fnBody("async function dropOnDesktop");
    expect(back, "交回主窗口后也清空面板").toMatch(
      /detachLocally\(ids\);[\s\S]{0,160}?pruneEmptyPanels\(\)/,
    );
    const split = fnBody("function splitPanelWithTab");
    expect(split, "同面板分屏挪走唯一标签后也要摘（以前这里留空框）").toMatch(
      /pruneEmptyPanels\(\)/,
    );
  });

  it("新窗口落点：拿得到就落在松手处，拿不到退回系统摆放", () => {
    // B91-2 起落点直接用 `dragend` 的 screenX/screenY（整段拖拽手势交给了系统拖放循环，
    // 期间页面收不到任何指针事件，dragend 是唯一还带最后位置的时机），不再读窗口几何。
    const body = fnBody("function desktopSpotOf");
    expect(body, "非有限值挡掉").toMatch(/!Number\.isFinite\(screenX\)[\s\S]{0,60}?return null;/);
    expect(body, "（0,0）视为不可用（多显示器折算偏了会落到角落）").toMatch(
      /screenX === 0 && screenY === 0/,
    );
    expect(body, "落点就是屏幕坐标本身").toMatch(/return \{ x: screenX, y: screenY \};/);
    expect(api, "落点随建窗命令一起交给 Rust").toMatch(/x: spot\?\.x \?\? null/);
    expect(rust, "Rust 侧只接受「两个都合法」的落点").toMatch(/fn spot_of/);
    expect(rust, "建窗时应用落点").toMatch(/builder = builder\.position\(x, y\)/);
  });

  it("被搬到别的窗口的文档再被打开：必须取回，不能变成两份互不同步的实例", () => {
    // 同源多实例的前提是同一窗口内共用一条 docs 记录。隐藏实例的正文停在载荷时的
    // 样子，而重新打开拿到的是磁盘内容 —— 两份各说各话，正是最怕的状态。
    const body = fnBody("async function doOpen");
    expect(body, "隐藏实例（在别的窗口）要先取回").toMatch(
      /const remoted = remotedTabs\.get\(existingDoc\.tabId\);\s*\n\s*if \(inst && remoted !== undefined\) \{[\s\S]{0,240}reclaimRemoted\(inst\.tabId, host\)/,
    );
    expect(body, "取回要走既有的激活收尾（重建/刷新/存会话）").toMatch(
      /reclaimRemoted\(inst\.tabId, host\);[\s\S]{0,240}scheduleSessionSave\(\);/,
    );
  });

  it("交出去之后本地只摘视图，绝不删 Rust 侧的文档", () => {
    // 走 closeTabById 会连文档一起删掉，接手方拿到空壳（首次保存报「文档不存在」）。
    const body = fnBody("function detachLocally");
    expect(body, "只动内存视图").toMatch(/tabs\.delete\(tabId\)/);
    expect(body).not.toContain("ipcCloseTab");
    expect(body).not.toContain("closeTabById");
    // 卫星窗口被交空 → 自己关掉，别留一个空窗口
    expect(body, "交空后自动关窗").toMatch(
      /tabs\.size === 0[\s\S]{0,120}getCurrentWindow\(\)\.close\(\)/,
    );
    // 摘标签会改变面板构成 → 最大化态必须先还原（与分屏/关面板同一不变量）
    const open = fnBody("async function openTabsInNewWindow");
    expect(open, "摘标签前先退出最大化").toMatch(
      /exitMaximize\(\);[\s\S]{0,200}remoteTabLocally\(id, label\)/,
    );
  });
});
