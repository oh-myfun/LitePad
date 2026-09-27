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
//     视口也能带着兄弟走；回环改由 `viewportWriteDepth` + `restoringViewport`
//     的两帧窗口自限（B142 那套），不再靠「只有激活的那份能当源」。
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

const main = readFileSync("src/main.ts", "utf-8");
const html = readFileSync("index.html", "utf-8");
const css = readFileSync("src/styles/global.css", "utf-8");

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
    // 预览容器那条：挂在 `restoringViewports` 自检之后（兄弟被定位的两帧里不许回推）。
    const prev = slice(main, 'preview.root.addEventListener("scroll"', "applyPanelMode(p);");
    expect(prev, "预览里滚也要推兄弟").toMatch(/^\s*pushSyncToSiblings\(t, true\);/m);
    const atGuard = prev.indexOf("restoringViewports.has(t.tabId)");
    const atPush = prev.indexOf("pushSyncToSiblings(t, true);");
    expect(atGuard, "要能定位那道自限守卫").toBeGreaterThan(-1);
    expect(atPush, "要能定位推同步那句").toBeGreaterThan(-1);
    expect(atPush, "推同步要排在守卫之后（否则回环闸门形同虚设）").toBeGreaterThan(atGuard);
  });

  it("位置同步的回环闸门：自限守卫仍在两条监听的首段", () => {
    // 「谁滚谁当源」的代价是少了一道天然闸门，回环全靠这两条自限 —— 少一条就是抖动。
    expect(scrollBodyOf(main), "程序滚动期间不许推").toMatch(
      /if \(viewportWriteDepth > 0\) return;/,
    );
    const scroll = scrollBodyOf(main);
    expect(scroll, "还原窗口里不许推").toMatch(/if \(t && restoringViewports\.has/);
    // 两道守卫都要排在「推兄弟」之前，反了就挡不住下一帧才到的那发 scroll。
    const atDepth = scroll.indexOf("viewportWriteDepth > 0");
    const atRestore = scroll.indexOf("restoringViewports.has(t.tabId)");
    const atPush = scroll.indexOf("pushSyncToSiblings(t, true)");
    expect(atDepth, "要能定位抑制区间那行").toBeGreaterThan(-1);
    expect(atRestore, "要能定位还原窗口那行").toBeGreaterThan(-1);
    expect(atPush, "要能定位推同步那句").toBeGreaterThan(-1);
    expect(atPush, "推同步要排在两道守卫之后").toBeGreaterThan(atDepth);
    expect(atPush, "推同步也要排在还原窗口守卫之后").toBeGreaterThan(atRestore);
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
    // 回环是靠 `restoringViewport` 那两帧挡的（两条滚动监听首行都认它），所以接收端
    // 也必须走 `applySyncToSibling` —— 那条里钉位置是套在还原窗口里的。
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
    expect(HOST, "预览侧的行首对齐写法").toMatch(
      /v\.scrollDOM\.scrollTop = v\.lineBlockAt\(l\.from\)\.top;/,
    );
  });

  it("换算之后也要钉进还原窗口，并把落点补记一次", () => {
    // 与 px 那个分支同一条纪律 3：不套窗口，兄弟那一发 scroll 就会被记成「用户停过
    // 的位置」，再顺着它的滚动监听推回源 —— 两个面板互相拉。
    expect(PUSH_BODY, "换算那路也要套还原窗口").toMatch(
      /restoringViewport\(other\.tabId, \(\) => \{\s*\n\s*pinScrollTop\(shownView\.scrollDOM/,
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
    expect(PUSH_BODY, "程序定位之后要抹掉待重定位行号").toMatch(/preview\.clearPendingSync\(\);/);
    const atSync = PUSH_BODY.indexOf("preview.syncToLine(line)");
    const atClear = PUSH_BODY.indexOf("preview.clearPendingSync()");
    expect(atSync, "要能定位同步那句").toBeGreaterThan(-1);
    expect(atClear, "要能定位抹尾巴那句").toBeGreaterThan(-1);
    expect(atClear, "抹尾巴必须紧跟定位（中间不许插别的定位）").toBeGreaterThan(atSync);
  });

  it("预览的程序定位也要套进按标签的还原窗口", () => {
    expect(PUSH_BODY, "预览分支同样要套还原窗口").toMatch(
      /restoringViewport\(other\.tabId, \(\) => preview\.syncToLine\(line\)\);/,
    );
    // ⚠️ 补记那笔必须留在窗口**外**：窗口期内 `recordScroll` 是拒写的（B145 唯一闸口）。
    const atRestore = PUSH_BODY.indexOf(
      "restoringViewport(other.tabId, () => preview.syncToLine(line));",
    );
    const atRecord = PUSH_BODY.indexOf("recordScroll(other.tabId, shown.preview.root.scrollTop)");
    expect(atRestore, "要能定位还原窗口那句").toBeGreaterThan(-1);
    expect(atRecord, "要能定位补记那笔").toBeGreaterThan(-1);
    expect(atRecord, "补记要排在窗口关闭之后").toBeGreaterThan(atRestore);
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
    // 开启态仍走那条全局规则（特异度 0-2-0，盖得住 hover 的 color）—— 别另起一套。
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
describe("B154 字形：link（链条），常量，启动时给一次", () => {
  it("字形取 link —— 链条画的正是「这几份连在一起」，且不跟更新键那族撞形", () => {
    expect(main, "字形要取 link").toMatch(/syncScrollBtn\.innerHTML = CODICONS\.link;/);
    const cod = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(cod, "link 字形要在取用层登记").toMatch(/^\s*link: "link",/m);
    // 短名要真的能在 codicon 字体里取到字 —— 写个名字不存在的字形就是一枚空白方块。
    const codiconCss = readFileSync("node_modules/@vscode/codicons/dist/codicon.css", "utf-8");
    expect(codiconCss, "codicon 字体里要有 link 这一码位").toMatch(/\.codicon-link:before/);
  });

  it("refreshSyncButton 只管显隐，字形不跟着标题刷新重设", () => {
    // 图标是常量，每次刷新标题都重设 innerHTML 是白费功夫，还白打断一次重排。
    expect(BTN_BODY, "refreshSyncButton 不许碰 innerHTML").not.toContain("innerHTML");
    const setup = slice(main, "function setupTitleBar(", "\nfunction ");
    expect(setup, "字形要落在启动那批里").toContain("syncScrollBtn.innerHTML = CODICONS.link;");
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

  it("退回「钉兄弟的 DOM 不套还原窗口」→ 那条必须落空", () => {
    const ORIG = "restoringViewport(other.tabId, () => pinScrollTop(shownView.scrollDOM, px));";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "pinScrollTop(shownView.scrollDOM, px);");
    const body = slice(degraded, "function pushSyncToSiblings(", "function showMessage(");
    expect(body, "裸钉的写法要被抓到").not.toMatch(/restoringViewport\(other\.tabId/);
  });

  it("退回「用 sync 字形」→「链条」那条必须落空", () => {
    const ORIG = "syncScrollBtn.innerHTML = CODICONS.link;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "syncScrollBtn.innerHTML = CODICONS.sync;");
    expect(degraded, "退回 sync 就退回圆箭头、跟右上角更新键族撞形了").not.toMatch(
      /syncScrollBtn\.innerHTML = CODICONS\.link;/,
    );
  });

  it("把字形挪回 refreshSyncButton → 「只管显隐」那条必须落空", () => {
    const ORIG = "  syncScrollBtn.innerHTML = CODICONS.link;";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main
      .replace(ORIG, "")
      .replace(
        "function refreshSyncButton(tab: Tab | undefined): void {",
        "function refreshSyncButton(tab: Tab | undefined): void {\n  syncScrollBtn.innerHTML = CODICONS.link;",
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

  it("删掉抹尾巴那句 → 「不留待重定位尾巴」那条必须落空", () => {
    // 删了 `clearPendingSync`，`syncToLine` 留下的 `pendingSyncLine` 就留在预览里 ——
    // 等于给每次图片 / KaTeX / Shiki 增强留一个「把预览拽回某一行」的钩子。
    const ORIG = "    preview.clearPendingSync();";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    expect(body, "删掉后尾巴就留在预览里了").not.toContain(ORIG);
  });

  it("把预览的程序定位裸放出来 → 「套还原窗口」那条必须落空", () => {
    const ORIG = "restoringViewport(other.tabId, () => preview.syncToLine(line));";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "preview.syncToLine(line);");
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    expect(body, "裸放出来后预览的落点就不再受还原窗口保护了").not.toContain(ORIG);
  });

  it("把换算那笔的记录挪进窗口内 → 「补记留在外」那条必须落空", () => {
    // 窗口期内 `recordScroll` 是拒写的（B145 唯一闸口挪进还原窗口就永远写不进去），
    // 所以补记必须留在窗口外。挪进去 ⇒ 源码兄弟的位置永远记不上。
    const ORIG =
      "  restoringViewport(other.tabId, () => {\n    pinScrollTop(shownView.scrollDOM, shownView.lineBlockAt(target.from).top);\n  });\n  // 落点得记，否则兄弟这份的位置只活在 DOM 上：离屏前没人补记，重启就丢了。\n  recordScroll(other.tabId, shownView.scrollDOM.scrollTop);";
    expect(PUSH_BODY, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(
      ORIG,
      "  restoringViewport(other.tabId, () => {\n    pinScrollTop(shownView.scrollDOM, shownView.lineBlockAt(target.from).top);\n    recordScroll(other.tabId, shownView.scrollDOM.scrollTop);\n  });",
    );
    const body = slice(degraded, "function applySyncToSibling(", "function showMessage(");
    // ⚠️ 盯**缩进**：补记被挪进窗口后缩进从 2 格变 4 格，这里看的就是「它还站在窗口外」。
    //    只按短句判会让退化版照样命中（那句还躺在窗口里）。
    expect(body, "补记挪进还原窗口后就永远写不进去了（缩进该是 2 格）").not.toMatch(
      /^ {2}recordScroll\(other\.tabId, shownView\.scrollDOM\.scrollTop\);$/m,
    );
  });
});
