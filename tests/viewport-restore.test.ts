// @vitest-environment jsdom
// B145 · 用户报的两个真机症状：
//   ①「窗口打开恢复滚动位置时，还是会触发位置刷新并落盘成 0」；
//   ②「切换标签会导致位置变化」。
//
// 两条其实是同一个根：**还原出来的位置没立住就当成过去了**。
//   · 修复前 `pinScrollTop` 只补钉一帧。窗口刚打开时布局可能连着好几帧都没稳
//     （窗口还没显示、大文件刚把内容撑开），差一帧位置就永久停在被裁掉的 0 上，
//     接着被 `rememberViewScroll` / `refreshSession` 从容器里读走、落盘。
//   · 修完补钉，还得让**所有**写路径都过同一个闸口，否则漏掉的那几条旁路照样
//     能把还原期的中间值写进记录（`sessionStore.setScroll` 直连 store 就是一条）。
//   · 切标签那条：`focus()` 会把光标滚进视野，排在钉位置**之后**等于白钉。
//
// jsdom 不做布局，所以 scroller 仍然装「会裁剪的 scrollTop」（复刻浏览器行为），
// 差别只在这里把「布局就绪」推迟到**第 3 帧之后**，让「只补一帧」的旧写法露馅。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    isAlwaysOnTop: () => Promise.resolve(false),
    setAlwaysOnTop: () => Promise.resolve(),
    onCloseRequested: () => Promise.resolve({ catch: () => {} }),
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

const docText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 两个标签各记一份**互不相同**的视口：共享一个值的话，测不出「谁钉住了谁」
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 1,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: 500,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 2,
              cursorCol: 1,
              scrollTop: 120,
            },
          ],
        },
      ],
      layout: { kind: "leaf", panelId: 0 },
    }),
  loadSettings: () =>
    Promise.resolve({
      theme: "system",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: false,
      hot_exit: false,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 9, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: docText,
      name: path,
      path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    }),
  reloadFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 复刻「赋值那一刻还没布局」：布局就绪之前的赋值会被裁成 0，并派发一发 scroll。 */
const geom = vi.hoisted(() => ({ ready: false }));

function installClampingScroll(): void {
  const sc = document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null;
  if (!sc) throw new Error("找不到 .cm-scroller");
  let real = 0;
  Object.defineProperty(sc, "scrollTop", {
    configurable: true,
    get: () => real,
    set: (v: number) => {
      if (!geom.ready) {
        real = 0;
        sc.dispatchEvent(new Event("scroll"));
      } else {
        real = Math.max(0, v);
      }
    },
  });
}

/**
 * 安排「布局在第 `frames + 1` 帧才就绪」。
 *
 * 窗口刚打开时经常是这样：窗口还没显示、内容还没撑开，得等好几帧。
 * 「只补一帧」的旧实现就栽在只差这一帧上。
 */
function arrangeLayoutReadyInFrames(frames: number): void {
  const flip = (left: number): void => {
    if (left <= 0) {
      geom.ready = true;
      return;
    }
    requestAnimationFrame(() => flip(left - 1));
  };
  flip(frames);
}

function clickTab(i: number): void {
  const el = (document.querySelectorAll(".layout-panel .tab") as NodeListOf<HTMLElement>)[i];
  const m = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    clientX: 5,
    clientY: 5,
  });
  el.dispatchEvent(m);
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

function scrollTopNow(): number {
  return (
    (document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null)?.scrollTop ?? -1
  );
}

describe("B145 恢复位置：布局晚几帧稳定时也必须钉回（而不是落在 0）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("布局稳定前连续好几帧都被裁：位置最终仍要钉住 500，而不是停在顶部", async () => {
    installClampingScroll();
    arrangeLayoutReadyInFrames(2); // 第 3 帧才布局就绪
    expect(geom.ready, "用例应已安排好布局就绪的那一帧").toBe(false);

    clickTab(0); // a.md（视口 500）
    expect(scrollTopNow(), "赋值当帧应已被浏览器裁掉").toBe(0);

    await wait(120); // 越过补钉的那些帧
    expect(scrollTopNow(), "布局稳定后位置应钉回 500，而不是停在被裁的 0").toBe(500);
  });
});

// 归一换行：字面量按 LF 写；工作副本若被翻成 CRLF，`;\r\n` 中间的 `\r` 会坑掉带 `\n` 的判据。
const src = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

/** 取出某个函数 / 回调的**函数体**（从 header 处起做花括号配平）。 */
function bodyOf(header: string, from: string = src): string {
  const at = from.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}`);
  const open = from.indexOf("{", at + header.length - 1);
  let depth = 0;
  for (let i = open; i < from.length; i += 1) {
    if (from[i] === "{") depth += 1;
    else if (from[i] === "}") {
      depth -= 1;
      if (depth === 0) return from.slice(open, i + 1);
    }
  }
  throw new Error(`${header} 的花括号没配平`);
}

describe("B145 静态契约：还原写路径只有一个出口，焦点要让位", () => {
  it("滚动位置写入只准走 recordScroll 这一个闸口", () => {
    const gate = bodyOf("function recordScroll(");
    expect(gate, "被挡时要留一条 trace，方便看日志定位").toMatch(/logger\.trace\("viewport"/);
    // 整份源码里直连 store 写视口的那几行，只可能落在闸口内部
    const stray =
      (src.match(/sessionStore\.setScroll\(/g) ?? []).length -
      (gate.match(/sessionStore\.setScroll\(/g) ?? []).length;
    expect(stray, "store.setScroll 只允许出现在 recordScroll 里").toBe(0);
    // 「消失前看最后一眼」也不能绕过闸口（它读容器，正是最需要挡的那一类）
    expect(bodyOf("function rememberViewScroll(")).toMatch(/recordScroll\(/);
  });

  it("读容器的那一路要认「钉位置还在半路」", () => {
    const body = bodyOf("function rememberViewScroll(");
    expect(body, "钉位置还没立住时不许采容器里的值").toMatch(/pinInFlight\(/);
    // 反向验证：把守卫摘掉，上一条必须抓住（替换用字面量，别用正则猜）
    const degraded = body
      .replace("if (pinInFlight(panel.view.view.scrollDOM)) return;", "return;")
      .replace("!pinInFlight(root)", "false");
    expect(degraded, "退化后应认不出守卫").not.toMatch(/pinInFlight\(/);
  });

  it("焦点必须排在还原位置**之前**（focus 会把光标滚进视野）", () => {
    // 先把注释剥掉：`focus()` 是说明文字里的词，不参与顺序判定
    const code = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [site, header] of [
      ["切标签", "function switchTab("],
      ["挂载", "mountView: (panelId, hostEl) => {"],
    ] as const) {
      const body = code(bodyOf(header));
      const focus = body.indexOf("focus()");
      const restore = body.indexOf("restoreViewScroll(p");
      expect(focus, `${site} 处应能看到 focus()`).toBeGreaterThan(-1);
      expect(restore, `${site} 处应能看到还原滚动`).toBeGreaterThan(-1);
      expect(focus, `${site} 的 focus() 必须排在还原之前`).toBeLessThan(restore);
    }
  });
});

describe("B146 静态契约：换文档前要先标程序来源（监听见标记即吞）", () => {
  const code = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("切标签 / 关闭后接班：程序来源标记与 viewTabId 都要先于 setState", () => {
    // CM6 的 setState 末尾是 `if (hadFocus) this.focus(); this.requestMeasure();` ——
    // 换完文档它会**自己再滚一次**，加上浏览器按新内容裁剪 scrollTop。这些滚动派发
    // 的那一刻要是没被程序来源标记覆盖，就会被当成「用户停过的位置」写进记录。
    for (const [site, header, setState] of [
      ["切标签", "function switchTab(", "setState(tab.state)"],
      ["关闭后接班", "async function closeTabById(", "setState(nextTab.state)"],
      ["分屏搬出后原位接班", "function splitActivePanel(", "setState(prev.state)"],
    ] as const) {
      const body = code(bodyOf(header));
      const at = body.indexOf(setState);
      expect(at, `${site} 处应能看到换文档那一行`).toBeGreaterThan(-1);
      // 程序来源标记要**罩住** setState：起点在它之前（换文档那几下自动滚动被监听认领吞掉）
      const win = body.indexOf("markProgrammatic(");
      expect(win, `${site} 应有程序来源标记`).toBeGreaterThan(-1);
      expect(win, `${site} 的程序来源标记必须罩住 setState（先于换文档）`).toBeLessThan(at);
      // 而 `viewTabId` 也得先改：滚动监听靠它寻址，晚一步就会算到旧标签头上
      const vid = body.indexOf("viewTabId = ");
      expect(vid, `${site} 应能找到 viewTabId 赋值`).toBeGreaterThan(-1);
      expect(vid, `${site} 的 viewTabId 必须先于 setState 改掉`).toBeLessThan(at);
    }
  });
});

describe("B145 反向验证：退回旧写法，上面那几条必须变红", () => {
  it("退回「只补钉一帧」后，逐帧补钉的契约必须抓住", () => {
    // ⚠️ 用**字面量**替换（老规矩）：正则一改排版就失配，退化就会变成「什么都没改」。
    // ⚠️ 这段格局会随排版变（B151 把落点改成 `fmtPx(landed)` 后 prettier 又合并回单行）：
    // 换任何写法都得回来改这一串，否则「退化」会变成「什么都没改」⇒ 这条用例假绿。
    const OLD_RETRY =
      '    logger.trace("viewport", `pin ${px} 被裁（第 ${frame + 1} 帧，scrollTop=${fmtPx(landed)}）`);\n    requestAnimationFrame(() => retry(frame + 1));';
    expect(src, "退化用的原句必须还在").toContain(OLD_RETRY);
    const degraded = src.replace(OLD_RETRY, "    void frame;");
    expect(degraded, "退化后应不再有补钉").not.toContain(
      "requestAnimationFrame(() => retry(frame + 1));",
    );
  });

  it("退回「focus 排在还原之后」后，顺序契约必须抓住", () => {
    // 把 switchTab 里 focus 那一行搬到 `restoreViewScroll` 之后 —— 正是修复前的顺序
    // ⚠️ 锚点要在 switchTab **这一段里**找：整份源码里 focus 那一行有好几处
    // ⚠️ 不匹配前导缩进：focus / restore 位置不同，带上缩进就一个都找不到了
    // ⚠️ 也不带 `panel.` 前缀：还原段用的是局部变量 `view.focus()`（收窄能过编译）
    const FOCUS = "view.focus();\n";
    const RESTORE = "restoreViewScroll(panel);";
    const at = src.indexOf(FOCUS, src.indexOf("function switchTab("));
    expect(at, "退化用的原句必须还在").toBeGreaterThan(-1);
    const restoreAt = src.indexOf(RESTORE, at);
    expect(restoreAt, "退化用的还原行必须还在").toBeGreaterThan(at);
    // 真的**搬**过去（只插不移的话，focus 会同时出现在两边，判不出顺序）
    const head = src.slice(0, at);
    const tail = src.slice(at + FOCUS.length);
    const inTail = tail.indexOf(RESTORE);
    const degraded =
      head + tail.slice(0, inTail) + RESTORE + "\n" + FOCUS + tail.slice(inTail + RESTORE.length);
    // 搬过去时不带缩进（原句前面是 4 空格的闭包体，插回来时缩进没跟着走）
    expect(degraded, "退化后 focus 应排在还原之后").toContain(
      `restoreViewScroll(panel);\n${FOCUS}`,
    );

    const body = degraded
      .slice(degraded.indexOf("function switchTab("))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const focus = body.indexOf("focus()");
    const restore = body.indexOf("restoreViewScroll(p");
    expect(focus, "退化版里 focus 仍在").toBeGreaterThan(-1);
    expect(focus, "退化版里 focus 应排在还原之后（顺序反了）").toBeGreaterThan(restore);
  });
});
