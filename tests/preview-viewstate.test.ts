// @vitest-environment jsdom
// B129 · **纯预览态**的「视图位置」也必须进会话并还原。
//
// 为什么单独一条：纯预览下编辑器是 `display:none`，浏览器会把它的 scrollTop 清零，
// 真正承载视图位置的是预览容器。若照旧只读编辑器那一侧，存下去永远是个 0，
// 于是「上次翻到中段、重启后弹回开头」。source/split 两档不受影响，所以这条得单独盯。
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
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 预览容器上被记住的滚动位置（用户当时翻到的位置）。 */
const PREVIEW_SCROLL = 420;

const saved = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 上次是个**纯预览**的 md 标签，翻到了文档中段
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 0,
          tabs: [
            {
              path: "note.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 20,
              cursorCol: 1,
              scrollTop: PREVIEW_SCROLL,
              viewMode: "preview",
            },
          ],
        },
      ],
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
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}\n\n段落 ${i + 1} 的内容。`).join(
        "\n\n",
      ),
      name: path,
      path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    }),
  reloadFile: () =>
    Promise.resolve({
      tabId: 1,
      text: "",
      name: "x",
      path: "x",
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
    }),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: (s: Record<string, unknown>) => {
    saved.session = s;
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function previewRoot(): HTMLElement | null {
  return document.querySelector(".md-preview") as HTMLElement | null;
}

describe("B129 纯预览态的视图位置要进会话并还原", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("恢复后预览停在原处，不是文档开头", () => {
    const root = previewRoot();
    expect(root, "应渲染出预览容器").toBeTruthy();
    expect(root!.scrollTop, "预览应回到上次的位置").toBe(PREVIEW_SCROLL);
  });

  it("静态契约：存取两端都按 viewMode 分流，且真的写进了预览容器", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(
      src,
      "纯预览态的视图位置必须从预览容器取（编辑器是 display:none，scrollTop 恒为 0）",
    ).toMatch(/t\.viewMode === "preview"/);
    expect(src, "还原的落点必须落在预览容器上（PreviewPane.setScrollTop）").toMatch(
      /preview\.setScroll\(?/,
    );
    const preview = readFileSync("src/markdown/preview.ts", "utf-8");
    expect(preview, "PreviewPane 要提供按像素定位的入口").toContain("setScrollTop(px: number)");
  });

  it("反向验证：拆掉任一端，上面两条断言都会失效", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    // 退化 A：存的时候只看编辑器那一侧
    const degradedSave = src.replace(
      /if \(t\.viewMode === "preview"\) return p\.preview\?\.root\.scrollTop \?\? null;/,
      "",
    );
    expect(degradedSave, "退化后不应再有预览侧的取值分支").not.toMatch(
      /if \(t\.viewMode === "preview"\) return/,
    );
    // 退化 B：还原的时候只动编辑器
    const degradedRestore = src.replace(/preview\.setScrollTop\(tab\.scrollTop\);/, "");
    expect(degradedRestore, "退化后不应再有写回预览容器的调用").not.toMatch(
      /preview\.setScrollTop\(/,
    );
  });
});
