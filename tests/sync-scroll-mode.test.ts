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

// ⚠️ 归一换行：下面的契约字面量 / 正则都按 LF 写。仓库里存的是 LF，但**工作副本被翻成
// CRLF** 会一次性打掉一大片断言（`topLevelFnBody` 认 `\n}` 后的那个字符是 `\n`，CRLF 下
// 是 `\r`，函数体直接抠成空串）。这里先归一，是防那类「改一个字节红一大片」的复发。
const main = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");
const html = readFileSync("index.html", "utf-8").replace(/\r\n/g, "\n");
const css = readFileSync("src/styles/global.css", "utf-8").replace(/\r\n/g, "\n");
const PREVIEW_TS = readFileSync("src/markdown/preview.ts", "utf-8").replace(/\r\n/g, "\n");

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
const PUSH_BODY = slice(main, "function applySyncToSibling(", "function showMessage(");
const BTN_BODY = slice(main, "function refreshSyncButton(", "function refreshStatus(");
const SRC_BODY = slice(main, "function isSyncSource(", "/** 这个实例此刻是否被某个面板");
const CLICK_BODY = slice(main, 'syncScrollBtn.addEventListener("click"', "sbLang.addEventListener");
const PIN_BODY = slice(main, "function pinScrollTop(", "function restoreViewScroll(");

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

  it("显隐判据是「当前激活文档开着多份」—— 两个窗口同口径，只数本窗口实例（B171）", () => {
    // 只看「有没有文档」⇒ 单开也露脸，用户点下去什么也不会发生。
    expect(main, "显隐要按实例个数判").toMatch(/instancesOfDoc\(tab\.docId\)\.length > 1/);
    expect(main, "无文档时要藏").toMatch(/syncScrollBtn\.hidden = !multi;/);
    // B171：B164 曾给子窗口开后门（额外认「这份文档在别的窗口也有」），于是同文件
    // 只开一份时子窗口露脸、主窗口却藏着 —— 口径不一致。现在一律只数本窗口实例。
    expect(BTN_BODY, "显隐不许再掺跨窗口的共享集合").not.toMatch(/sharedDocIds/);
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
      main,
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
    // 换算出来的这一笔也必须走唯一闸口，且值取的是**预览容器**自己的像素。
    expect(PUSH_BODY, "预览兄弟的位置也要走记录闸口").toMatch(
      /recordScroll\(other\.tabId, shown\.preview\.root\.scrollTop\);/,
    );
    // ⚠️ 顺序：换算分支必须排在「px 直推」那条之前，否则编辑器 px 会先落到预览槽里。
    const g = PUSH_BODY.indexOf(guard);
    const r = PUSH_BODY.indexOf("recordScroll(other.tabId, px)");
    expect(g).toBeGreaterThan(-1);
    expect(r, "px 直推那笔也要在（源码→源码那条老路径）").toBeGreaterThan(-1);
    expect(g, "预览分支要写在 px 直推之前").toBeLessThan(r);
  });

  it("预览态的槽是预览像素，不能被当成编辑器像素拿去推源码兄弟", () => {
    // 这是「一个预览一个源码」原先不生效的根因之一：源在预览里时 `src.scrollTop`
    // 装的是预览像素，直接拿去 pin 兄弟的编辑器，落点必然是错的。
    expect(PUSH_BODY, "源是预览态时不许取 px").toMatch(
      /const px = srcPreview \? null : src\.scrollTop;/,
    );
    expect(PUSH_BODY, "源那侧要先认出预览容器").toMatch(
      /src\.viewMode === "preview" \? srcPanel\?\.preview/,
    );
    // 坐标从源显示的那一侧取：预览侧取顶行，源码侧取编辑器可视区顶行。
    expect(PUSH_BODY, "预览侧坐标走 topVisibleLine").toMatch(/srcPreview\.topVisibleLine\(\)/);
    expect(PUSH_BODY, "源码侧坐标走 topVisibleLineOf").toMatch(/topVisibleLineOf\(srcView\)/);
  });

  it("两条滚动监听都是「谁滚谁当源」，不再要求源是激活的那份", () => {
    const scroll = slice(
      main,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(scroll, "编辑器里滚要推兄弟").toMatch(/\n\s*if \(t\) pushSyncToSiblings\(t, true\);\n/);
    // ⚠️ 判据里带括号：那段的注释也提到这个名字，只认字面会连注释一起命中（假绿）。
    expect(scroll, "这条不许再挂 isSyncSource 前置").not.toMatch(/isSyncSource\(/);
    // 预览容器那条：程序摆位的回执由 `isProgrammatic(preview.root)` 吞掉（不推兄弟），
    // 真用户滚动才到推兄弟那一句——守卫必须排在推同步之前。
    const prev = slice(main, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
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
    const scroll = scrollBodyOf(main);
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
    expect(PUSH_BODY, "位置要走唯一闸口").toMatch(/recordScroll\(other\.tabId, px\);/);
  });

  it("离屏的预览实例不写任何位置（否则就是拿编辑器像素污染预览槽）", () => {
    const guard = "if (line === null || !shown?.preview) return;";
    expect(PUSH_BODY, "离屏预览兄弟要跳过").toContain(guard);
    // ⚠️ 顺序也要盯：这条跳过必须排在 recordScroll 之前 —— 反了就把编辑器侧的
    //    px 写进「预览那一侧」的槽（B129 的语义），切回源码时位置就错了。
    //    两个下标都要先自证存在，否则「找不到 = -1」会让顺序比较永远成立（假绿）。
    const g = PUSH_BODY.indexOf(guard);
    const r = PUSH_BODY.indexOf("recordScroll(other.tabId, px)");
    expect(g).toBeGreaterThan(-1);
    expect(r).toBeGreaterThan(-1);
    expect(g, "跳过要写在写记录之前").toBeLessThan(r);
  });

  it("钉兄弟的 DOM 要走 pinScrollTop（内部标程序来源，回执被吞）而非裸写 scrollTop", () => {
    // B170：程序钉位置若直接写 `scrollDOM.scrollTop` 而不经 `pinScrollTop`，那一下不会被
    // 标成程序来源，回执落到编辑器监听就被记成「用户停过的位置」再反推回源 —— 拉锯。
    // `pinScrollTop` 内部 `markProgrammatic` 把来源标好，回执由监听经 scroll-guard 吞掉，
    // 不再套 `restoringViewport` 还原窗口（B170 删了那套时间窗）。
    expect(PUSH_BODY, "px 分支要走 pinScrollTop").toMatch(
      /pinScrollTop\(shownView\.scrollDOM, px\);/,
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
    expect(main, "用户滚动之后要推：谁滚谁当源").toMatch(/if \(t\) pushSyncToSiblings\(t, true\);/);
    // 「切换激活文档时则根据新的激活文档进行同步」—— 这一句就落在 switchTab 末尾。
    expect(main, "切激活文档后要按新源推").toMatch(/if \(tab\) pushSyncToSiblings\(tab\);/);
    expect(main, "全局刷新兜底（新出现的那一份要对齐）").toMatch(/const act = activeTab\(\);/);
  });

  it("点开的那一刻就推一次，不用等用户再滚一下", () => {
    expect(CLICK_BODY, "点击要先改状态").toMatch(/docSyncModes\.set\(tab\.docId, on\);/);
    expect(CLICK_BODY, "开启后立刻推").toMatch(/if \(on\) pushSyncToSiblings\(tab, true\);/);
    expect(CLICK_BODY, "要顺手刷新按钮（点亮态 + 提示）").toMatch(/refreshSyncButton\(tab\);/);
  });
});

// ------------------------------------------------- B159：跨窗口同步滚动
describe("B159 跨窗口同步滚动（用户报：子窗口文档没跟着动）", () => {
  const MSG_BODY = slice(main, "const EVT_DOC_CHANGE = ", "/** 正在套用远端变更");
  const RECV_BODY = slice(main, "function applySyncMode(", "/** 注册跨窗口同步的监听");
  const POS_RCV = slice(main, "function applyRemoteSyncPos(", "/** 注册跨窗口同步的监听");
  const LISTEN = slice(
    main,
    "function listenDocSync(",
    "// ---------------------------------------------------------------- 卫星窗口引导",
  );

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
      /function pushSyncToSiblings\(src: Tab, crossWindow = false\)/,
    );
    // 光标 / 输入那一路：不带第二个实参，走默认。
    expect(main, "光标那一半不许跨窗口").toMatch(
      /if \(isSyncSource\(tab, panel\)\) pushSyncToSiblings\(tab\);/,
    );
    // 切激活文档 / 全局刷新这两路也不播：那是「本地对齐」，不是用户滚动。
    expect(main, "切激活文档那路不播").toMatch(/if \(tab\) pushSyncToSiblings\(tab\);\n/);
    expect(PUSH_BODY, "广播排在最后（本地先对齐，别人接手时落点一致）").toMatch(
      /broadcastSyncPos\(src, px, line\);/,
    );
  });

  it("三个触发点都显式打开了 crossWindow", () => {
    const scroll = slice(
      main,
      'shownView.scrollDOM.addEventListener("scroll"',
      "attachPasteHandler(p);",
    );
    expect(scroll, "编辑器里滚要往外播").toMatch(/if \(t\) pushSyncToSiblings\(t, true\);/);
    const preview = slice(main, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    expect(preview, "预览里滚也要往外播").toMatch(/pushSyncToSiblings\(t, true\);/);
    expect(CLICK_BODY, "按下开关那一刻也要播（先播状态，再播位置）").toMatch(
      /EVT_SYNC_MODE, \{ from: windowLabel, docId: tab\.docId, on \}/,
    );
  });

  it("位置广播要带齐四样：谁发的、哪个文档、哪一份是源、坐标", () => {
    // `from` 是必填的自证字段（tauri 的广播本机也会收到自己的回声），缺了就分不清。
    expect(PUSH_BODY, "from 不能少").toMatch(/from: windowLabel,/);
    expect(PUSH_BODY, "文档 ID 不能少").toMatch(/docId: src\.docId,/);
    expect(PUSH_BODY, "源那份的 tabId 不能少（对端要跳过它）").toMatch(/srcTabId: src\.tabId,/);
    // 坐标两个数一起带：源那侧是预览就只有 line、是源码就只有 px，对端按自己那一侧挑。
    // ⚠️ 签名收口到 "); 免得只命中注释里那句「px 与 line 一起带」。
    expect(PUSH_BODY, "签名要收口").toMatch(
      /function broadcastSyncPos\(src: Tab, px: number \| null, line: number \| null\)/,
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
    expect(main, "本地循环要调它").toMatch(/applySyncToSibling\(other, px, line\);/);
    // ⚠️ 判据放行号：`applySyncToSibling(other,` 被 prettier 折成了三行。
    expect(main, "接收端也调同一个").toMatch(/applySyncToSibling\(\s*other,/);
  });
});

// ------------------------------------------------- B160：双向同步的两个空洞
describe("B160 同步滚动双向打通（用户报：滚源码预览抖 / 滚预览源码不动）", () => {
  /** 预览侧的行首对齐写法 —— 用来对表源码分支换算出来的那套坐标。 */
  const HOST = slice(main, "scrollToLine: (line: number) => {", "lineCount: () =>");

  it("源码兄弟要认行号：源是预览侧时 px 恒为 null，不能因此就不动", () => {
    // 用户报「滚动预览，源码文档没有同步滚动」。`pushSyncToSiblings` 对预览态的源
    // 只交得出 `line`（纪律 2：预览侧交不出编辑器像素），旧写法在 `px === null` 时
    // 直接 return ⇒ 源码兄弟一动不动，而那个行号早就算好了，只是没人用。
    expect(PUSH_BODY, "源码分支不许再只看 px 就 return").not.toMatch(
      /if \(px === null \|\| !shownView\) return;/,
    );
    expect(PUSH_BODY, "换算出来的行号要真的用上").toMatch(
      /Math\.max\(1, line\), shownView\.state\.doc\.lines/,
    );
    expect(PUSH_BODY, "落点要按行首对齐的像素算").toMatch(
      /pinScrollTop\(shownView\.scrollDOM, shownView\.lineBlockAt\(target\.from\)\.top\)/,
    );
    // ⚠️ 与预览那侧的 `SyncHost.scrollToLine` 必须是**同一套**坐标，否则两个方向
    //    各自算一套，来回同步一次就偏一次（B160 这次抖动的另一半原因）。
    expect(HOST, "预览侧要先算出顶行像素").toMatch(/const top = v\.lineBlockAt\(l\.from\)\.top;/);
    expect(HOST, "预览侧把顶行像素落进编辑器滚动槽").toMatch(/v\.scrollDOM\.scrollTop = top;/);
  });

  it("换算之后也要钉进还原窗口，并把落点补记一次", () => {
    // 与 px 那个分支同一条纪律 3：不套窗口，兄弟那一发 scroll 就会被记成「用户停过
    // 的位置」，再顺着它的滚动监听推回源 —— 两个面板互相拉。
    expect(PUSH_BODY, "换算那路也要走 pinScrollTop（标程序来源、回执被吞）").toMatch(
      /pinScrollTop\(shownView\.scrollDOM, shownView\.lineBlockAt\(target\.from\)\.top\);/,
    );
    // ⚠️ 落点必须记：位置只活在 DOM 上，钉完不补记，这份实例的位置等于从没被记过。
    //    也不许把 `null` 倒进源码兄弟的槽 —— 那等于把它的位置抹成「从没显示过」。
    expect(PUSH_BODY, "换算后要补记落点").toMatch(
      /recordScroll\(other\.tabId, shownView\.scrollDOM\.scrollTop\);/,
    );
  });

  it("同步定位不留「待重定位」的尾巴（否则预览被异步重排反复拽回去）", () => {
    // 用户报「滚动源码，预览文档位置会抖动」。`syncToLine` 记 `pendingSyncLine` 是给
    // 大纲跳转这类**一次性**目标用的（增强 / 图片 load 后按目标行再定位一次）。同步
    // 滚动的目标行每帧都在变，把它记下来，等于给每一次重排留一个「把预览拽回某行」
    // 的钩子 ⇒ 图片 / KaTeX / Shiki 一增强完，预览就自己跳一下。
    // B162：纪律收进 `syncToLineProgrammatic`（程序定位入口自带「不留尾巴」+ 程序定位
    // 窗口），调用点换过去；入口自身「不留尾巴」在 preview-sync 那侧盯。
    expect(PUSH_BODY, "预览分支要走程序定位入口").toMatch(
      /preview\.syncToLineProgrammatic\(line\)/,
    );
    expect(PUSH_BODY, "不许再走会留尾巴的 syncToLine").not.toMatch(/preview\.syncToLine\(line\)/);
  });

  it("预览的程序定位走 syncToLineProgrammatic（标来源、不留尾巴），且落点补记在其后", () => {
    // B170：预览跨面板同步走 `syncToLineProgrammatic` —— 它内部 `markProgrammatic` 标来源，
    // 回执由预览监听经 scroll-guard 吞掉；且不留 `pendingSyncLine` 尾巴（B162）。不再套
    // `restoringViewport` 还原窗口（B170 删了那套时间窗）。
    expect(PUSH_BODY, "预览分支要走程序定位入口").toMatch(
      /preview\.syncToLineProgrammatic\(line\);/,
    );
    // 落点显式补记（程序定位不写快照）：必须排在 syncToLineProgrammatic 之后。
    const atSync = PUSH_BODY.indexOf("preview.syncToLineProgrammatic(line);");
    const atRecord = PUSH_BODY.indexOf("recordScroll(other.tabId, shown.preview.root.scrollTop)");
    expect(atSync, "要能定位程序定位入口那句").toBeGreaterThan(-1);
    expect(atRecord, "要能定位补记那笔").toBeGreaterThan(-1);
    expect(atRecord, "补记要排在程序定位之后").toBeGreaterThan(atSync);
  });

  it("B170 预览滚动监听要把程序回执吞掉（否则回推源码成闭环）", () => {
    // 预览监听首行认 `isProgrammatic(preview.root)`：程序钉位的回执（跨面板同步钉位、
    // 会话恢复、setBlocks 恢复、异步二次定位）一律被吞（不写快照、不推兄弟），只排程落盘；
    // 真用户滚动时标记已被清，才会落到推兄弟那一路。
    const listener = slice(main, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    expect(listener, "要能定位预览滚动监听体").not.toBe("");
    expect(listener, "守卫里必须有程序回执判据").toContain("if (isProgrammatic(preview.root))");
    expect(listener, "挡住之后仍要排程落盘").toContain("scheduleSessionSave();");
  });
});

describe("B154 / B157 样式：方形图标键，状态只靠图标颜色", () => {
  /** 这一族的三个成员（B157 起同款，写在同一条规则里，不许各写一份）。 */
  const FAMILY = [".sync-btn", ".title-btn.pin-btn", ".title-btn.upd-btn"];

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
    expect(hover, "这一族三个成员都要覆盖到").toContain(".title-btn.upd-btn:hover");
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
    const setup = slice(main, "function setupTitleBar(", "\nfunction ");
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
    expect(BTN_BODY, "只按本窗口实例数判").toMatch(
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
    const i = main.indexOf("const multi =");
    expect(i, "要能定位显隐判据").toBeGreaterThan(-1);
    const degradedBtn =
      main.slice(0, i) +
      "const multi = !!tab && (instancesOfDoc(tab.docId).length > 1 || sharedDocIds.has(tab.docId));" +
      main.slice(main.indexOf(";", i) + 1);
    const btnBody = slice(degradedBtn, "function refreshSyncButton(", "function refreshStatus(");
    expect(btnBody, "退化后「不许有共享文档集合」必须命中").toMatch(/sharedDocIds/);
    // ② 提前 return 不给广播让路
    const ORIG = "if (sibs.length === 0 && !crossWindow) return;";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degradedPush = main.replace(ORIG, "if (sibs.length === 0) return;");
    const pushBody = slice(degradedPush, "function pushSyncToSiblings(", "function showMessage(");
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
    expect(scrollBodyOf(main), "编辑器监听要吞程序回执").toContain(
      "if (isProgrammatic(shownView.scrollDOM)) return;",
    );
    const previewScroll = slice(
      main,
      'preview.root.addEventListener("scroll"',
      "applyPanelMode(p);",
    );
    expect(previewScroll, "预览监听也要吞程序回执").toContain("if (isProgrammatic(preview.root))");
  });

  it("B167 反向验证：退回两处旧写法，上面两条必须落空", () => {
    const ORIG = "shownView.dispatch({ selection: { anchor: pos }, scrollIntoView: false });";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degradedPush = main.replace(ORIG, "shownView.dispatch({ selection: { anchor: pos } });");
    const pushBody = slice(degradedPush, "function pushSyncToSiblings(", "function showMessage(");
    // ⚠️ 判据要盯**调用**（`dispatch({…scrollIntoView: false}`）：源码注释里也提到这个
    //    选项名，只判 `scrollIntoView: false` 会连注释一起命中 ⇒ 退化用例假绿。
    expect(pushBody, "退化后「必须关掉自动滚动」必须落空").not.toMatch(
      /dispatch\(\{[^}]*scrollIntoView: false/,
    );

    const GUARD = "if (isProgrammatic(shownView.scrollDOM)) return;";
    expect(main, "退化串要先自证原句还在").toContain(GUARD);
    const degradedGuard = main.replace(
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
    const editor = scrollBodyOf(main);
    expect(editor, "编辑器监听要认程序来源标记").toContain(
      "if (isProgrammatic(shownView.scrollDOM)) return;",
    );
    const previewScroll = slice(
      main,
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
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "          // (B170 退化：摘掉程序回执判定)");
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
  const HOST = slice(main, "scrollToLine: (line: number) => {", "lineCount: () =>");

  it("host.scrollToLine 摆位时要 markProgrammatic（预览驱动编辑器滚动标成程序回执）", () => {
    expect(HOST, "要能定位 scrollToLine 回调").toContain("scrollToLine: (line: number) => {");
    expect(HOST, "预览驱动编辑器滚动要标记成程序回执").toMatch(/markProgrammatic\(v\.scrollDOM\);/);
    expect(HOST, "算出的顶行要先收进局部变量 top").toMatch(
      /const top = v\.lineBlockAt\(l\.from\)\.top;/,
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
    const BODY = slice(main, "function transferSnapshotOf(", "function remoteTabLocally(");
    expect(BODY, "要能定位 transferSnapshotOf").toContain("function transferSnapshotOf(");
    expect(BODY, "载荷里要写 syncMode").toMatch(
      /syncMode:\s*docSyncModes\.get\(tab\.docId\) === true/,
    );
  });

  it("adoptTransferredTabs 要把收到的 syncMode 接进本窗口状态", () => {
    const BODY = slice(main, "function adoptTransferredTabs(", "function returnTabsToMain(");
    expect(BODY, "要能定位 adoptTransferredTabs").toContain("function adoptTransferredTabs(");
    expect(BODY, "收到 on 要把 docSyncModes 置真").toMatch(
      /if \(st\.syncMode\) docSyncModes\.set\(st\.docId, true\);/,
    );
  });

  it("B169 反向验证：摘掉采纳时接状态 → 上面那条必须落空", () => {
    const ORIG = "    if (st.syncMode) docSyncModes.set(st.docId, true);";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
    const BODY = slice(degraded, "function adoptTransferredTabs(", "function returnTabsToMain(");
    expect(BODY, "退化后不再接 syncMode 进本窗口状态").not.toMatch(
      /if \(st\.syncMode\) docSyncModes\.set\(st\.docId, true\);/,
    );
  });
});

describe("B152 反向验证：退回旧写法，上面那几条必须变红", () => {
  it("退回「单开一份也露脸」→ 显隐那两条必须落空", () => {
    // ⚠️ 退化串按位置取，不按字面量 replace：判据的排版变过好几轮（B164 折成两行、
    //    B171 又回到单行），只认老单行字面量会静默空转（B163 踩过同一坑）。
    const i = main.indexOf("const multi =");
    expect(i, "要能定位显隐判据").toBeGreaterThan(-1);
    const degraded =
      main.slice(0, i) + "const multi = !!tab;" + main.slice(main.indexOf(";", i) + 1);
    expect(degraded, "退化后不该再有实例数判据").not.toMatch(
      /instancesOfDoc\(tab\.docId\)\.length > 1/,
    );
    expect(degraded, "「显隐要按实例个数判」此时必须落空").not.toMatch(
      /instancesOfDoc\(tab\.docId\)\.length > 1/,
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
    // ⚠️ 退化串要连着那行的缩进：函数里有两笔 `recordScroll(other.tabId, …)`，只按
    //    短句 replace 的话替换掉的未必是这笔，断言就会落在另一笔上（假绿）。
    const ORIG = "recordScroll(other.tabId, px);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "other.scrollTop = px;");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "绕过 recordScroll 的写法要被抓到").not.toMatch(
      /recordScroll\(other\.tabId, px\)/,
    );
  });

  it("删掉「离屏预览兄弟跳过位置」那句 → 顺序那条必须落空", () => {
    // ⚠️ B159 起这句挪进了 `applySyncToSibling`（缩进也跟着变了），ORIG 要按新排书写。
    const ORIG = "    if (line === null || !shown?.preview) return;";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    expect(body, "删掉后就不该再有这句子").not.toContain(ORIG);
  });

  it("退回「钉兄弟 DOM 不标程序来源（裸写 scrollTop）」→ px 分支那条必须落空", () => {
    // px 分支必须走 `pinScrollTop`（它内部 markProgrammatic 标来源、回执被吞）；
    // 退化成裸写 scrollTop 后，那条「走 pinScrollTop」的契约必须落空。
    const ORIG = "pinScrollTop(shownView.scrollDOM, px);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "shownView.scrollDOM.scrollTop = px;");
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    expect(body, "裸写 scrollTop 的写法要被抓到（没经 pinScrollTop 标来源）").not.toMatch(
      /pinScrollTop\(shownView\.scrollDOM, px\);/,
    );
  });

  it("退回「用 sync 字形」→「链条」那条必须落空", () => {
    const ORIG = "syncScrollBtn.innerHTML = on ? CODICONS.link : CODICONS.unlink;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "syncScrollBtn.innerHTML = CODICONS.sync;");
    expect(degraded, "退回 sync 就退回圆箭头、跟右上角更新键族撞形了").not.toMatch(
      /syncScrollBtn\.innerHTML = on \? CODICONS\.link : CODICONS\.unlink;/,
    );
  });

  it("B166 反向验证：把字形切换从 refreshSyncButton 摘掉 → 上一条必须落空", () => {
    const ORIG = "  syncScrollBtn.innerHTML = on ? CODICONS.link : CODICONS.unlink;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
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
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "if (t && isSyncSource(t, p)) pushSyncToSiblings(t);");
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
    const at = main.lastIndexOf(ORIG);
    expect(at, "退化串要先自证原句还在").toBeGreaterThan(-1);
    // ⚠️ 按位置切：编辑器那侧也有一笔同形，整串 replace 会删到错的那笔（假绿）。
    const degraded = main.slice(0, at) + main.slice(at + ORIG.length);
    const prev = slice(degraded, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    // ⚠️ 判据要认**调用**形态（`pushSyncToSiblings(t, true);`）—— 那段的注释里也提名了
    //    这个函数，只认字面会命中注释，退化看着「没生效」（跟 isSyncSource 那次同坑）。
    expect(prev, "预览监听退回后就不再推兄弟了").not.toMatch(/pushSyncToSiblings\(t, true\);/);
  });

  it("退回「源在预览里也拿 src.scrollTop 当编辑器像素」→ 坐标系那条必须落空", () => {
    const ORIG = "const px = srcPreview ? null : src.scrollTop;";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "const px = src.scrollTop;");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "退回后就不认「预览那侧不产 px」这条纪律了").not.toMatch(ORIG);
  });

  it("退回「预览兄弟只跟光标、不跟位置」→ 行定位那条必须落空", () => {
    const ORIG = "recordScroll(other.tabId, shown.preview.root.scrollTop);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "删掉这笔记录后，预览兄弟就没位置可落了").not.toMatch(
      /recordScroll\(other\.tabId, shown/,
    );
  });

  it("把状态颜色退回「整颗键铺底」→ 外观那条必须落空", () => {
    // 用户要的是「干脆没有按钮背景」，hover 与同步都靠图标颜色 —— 铺底等于退回 B152。
    // ⚠️ ORIG 必须是**排版后的原样**（B157 起是三成员的选择器列表），写错就等于
    //    退化版「什么都没改」⇒ 这条反向验证静默失效（sync-scroll 那批栽过一次）。
    const ORIG =
      ".sync-btn:hover,\n.title-btn.pin-btn:hover,\n.title-btn.upd-btn:hover {\n  background: transparent;\n  color: var(--fg);\n}";
    expect(css, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = css.replace(
      ORIG,
      ".sync-btn:hover {\n  background: var(--bg-hover);\n  color: var(--fg);\n}",
    );
    expect(degraded, "退回铺底后就不是「没有按钮背景」了").not.toContain(ORIG);
    expect(degraded, "方形尺寸那几条也还得在，别顺手一起删了").toMatch(
      /\.sync-btn,[\s\S]*?height: 24px;/,
    );
  });
});

// ------------------------------------------------------- B160 反向验证
describe("B160 反向验证：退回旧写法，上面那四条必须变红", () => {
  it("退回「源码兄弟只认 px」→ 行号那条必须落空", () => {
    // 退回 B160 前状：在 `px === null`（源是预览侧）时直接 return，于是源码兄弟
    // 一动不动 —— 用户报的「滚动预览，源码文档没有同步滚动」。
    const ORIG = "  if (!shownView) return;\n  if (px !== null) {";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(
      ORIG,
      "  if (!shownView) return;\n  if (px === null || !shownView) return;\n  if (px !== null) {",
    );
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    // 退化后「只看 px 就 return」那句回来了 ⇒ 「源码兄弟要认行号」必须落空。
    expect(body, "退回后源码分支又只看 px 了").toMatch(
      /if \(px === null \|\| !shownView\) return;/,
    );
  });

  it("退回「走 syncToLine（留尾巴、无程序定位窗口）」→ 两条必须落空", () => {
    // B162 前状：预览分支调 `syncToLine` —— 它会留 `pendingSyncLine` 尾巴（每次重排
    // 都把预览拽回某一行），也没有程序定位窗口（逃过守卫的 scroll 会被反推成用户滚动）。
    const ORIG = "preview.syncToLineProgrammatic(line);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "preview.syncToLine(line);");
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    expect(body, "退化后预览分支不再走程序定位入口").not.toContain(
      /preview\.syncToLineProgrammatic\(line\)/,
    );
    expect(body, "退化后尾巴又留下来了").toMatch(/preview\.syncToLine\(line\)/);
  });

  it("把换算那笔的补记删掉 → 「补记在钉位之后」那条必须落空", () => {
    // 行号换算分支：先 `pinScrollTop`（内部 markProgrammatic 标来源）钉稳，再 `recordScroll`
    // 把落点写进兄弟自己的记录（B145 唯一闸口）。删掉这一笔，兄弟这份的位置就只活在 DOM
    // 上，离屏前没人补记，重启就丢了 —— 那条「换算后要补记落点」的契约必须落空。
    const ORIG_REC = "  recordScroll(other.tabId, shownView.scrollDOM.scrollTop);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG_REC);
    const degraded = main.replace(ORIG_REC, "");
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    expect(body, "删掉补记后「换算分支补记在钉位之后」就站不住了").not.toContain(ORIG_REC);
  });
});
