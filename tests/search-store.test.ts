// @vitest-environment node
// B389 · 侧栏搜索的**模型层**（`src/search/store.ts`）。
//
// 纯逻辑 + 假 IPC：这一层不碰 DOM，也不必骨架页（口径同 tests/explorer-store.test.ts）。
// `searchInFolder` 换成可控假实现，测试才能指定「哪一发先落地」「哪一发报错」——
// 而「旧回包后到不许盖新结果」这一条恰恰是只在**异步**下才露出来的症状。
//
// 判据盯四件容易悄悄回退的事：
//   ① 范围分流：有根走磁盘、没根走内存快照**且必须给提示**（用户拍定的第二条口径）；
//   ② 输入即搜的去抖 300ms 与「在飞只认自己」；
//   ③ 正则语法错 ⇒ 不搜并标红（不发那一发白跑的 IPC）；
//   ④ 文案与结果同源：计数、上限、失败原话都只有一处出口。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { docs } from "../src/core/app-state";

const h = vi.hoisted(() => ({
  /** 资源管理器缓存里的那个根（`getRoot` 的替身返回值）。 */
  root: "",
  /** `searchInFolder` 的每一发出参。 */
  calls: [] as Record<string, unknown>[],
  /** 这些查询串先不答，resolve 存 `release` —— 由用例决定那一发什么时候落地。 */
  gated: new Set<string>(),
  release: new Map<string, (report: unknown) => void>(),
  /** 下一次没被门住的搜索回什么。 */
  report: { files: [], matches: 0, limitHit: false, scanned: 0 } as unknown,
  /** 非空 ⇒ `searchInFolder` 按这个理由失败。 */
  fail: "",
  /** 文档 id → 实例（只需 `state` 这一格，替 `core/panels` 的 `instancesOfDoc`）。 */
  instances: new Map<number, unknown[]>(),
}));

vi.mock("../src/explorer/store", () => ({ getRoot: () => h.root }));
vi.mock("../src/core/panels", () => ({
  instancesOfDoc: (docId: number) => h.instances.get(docId) ?? [],
}));
vi.mock("../src/ipc/api", () => ({
  searchInFolder: (a: { query: string }) => {
    h.calls.push(a as unknown as Record<string, unknown>);
    if (h.fail) return Promise.reject(new Error(h.fail));
    if (h.gated.has(a.query)) {
      return new Promise((resolve) => {
        h.release.set(a.query, resolve);
      });
    }
    return Promise.resolve(h.report);
  },
}));

import * as store from "../src/search/store";

/** 盘上一条命中（Rust `SearchFileHit` 的线上形状）。 */
function hit(path: string, rel: string, name: string, line: number, preview: string) {
  return {
    path,
    rel,
    name,
    truncated: false,
    matches: [{ line, preview, start: 0, length: 2, column: 1 }],
  };
}

function report(files: unknown[], matches = 0, limitHit = false): unknown {
  return { files, matches: matches || files.length, limitHit, scanned: files.length };
}

/** 一份开着的文档 + 它内存里的正文。 */
function openDoc(tabId: number, path: string | null, text: string): void {
  docs.set(tabId, {
    tabId,
    path,
    name: path ? path.slice(path.lastIndexOf("\\") + 1) : "未命名",
  } as never);
  h.instances.set(tabId, [
    { tabId: tabId * 10, docId: tabId, panelId: 1, state: EditorState.create({ doc: text }) },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.root = "";
  h.calls = [];
  h.gated = new Set();
  h.release = new Map();
  h.report = report([]);
  h.fail = "";
  h.instances = new Map();
  docs.clear();
  store.clearAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("B389 · 预览裁切与 Rust `make_preview` 同一口径", () => {
  it.each([
    // [原行, 命中起点, 命中长度, 期望预览, 期望高亮起点, 期望高亮长度]
    ["aa bb", 0, 2, "aa bb", 0, 2],
    ["标题：搜索测试", 3, 2, "标题：搜索测试", 3, 2],
    ["  缩进里的 x", 7, 1, "  缩进里的 x", 7, 1],
  ])("短行原样：%o", (line, start, length, preview, ps, pl) => {
    expect(store.makePreview(line, start, length)).toEqual({ preview, start: ps, length: pl });
  });

  it("命中前面还有 26 个字符以上 ⇒ 补省略号并把高亮挪到新位置", () => {
    const line = `${"x".repeat(60)}hit${"y".repeat(10)}`;
    const cut = store.makePreview(line, 60, 3);
    expect(cut.preview.startsWith("…"), "补一个前导省略号").toBe(true);
    expect(cut.preview).toContain("hit");
    // 省略号占一格，所以高亮起点 = (60 - lead) + 1
    expect(cut.length).toBe(3);
    expect([...cut.preview].slice(cut.start, cut.start + cut.length).join("")).toBe("hit");
  });

  it("整行超过 250 字符 ⇒ 从命中处往前留 26 个、往后裁到 250", () => {
    const line = `${"a".repeat(100)}hit${"b".repeat(400)}`;
    const cut = store.makePreview(line, 100, 3);
    expect([...cut.preview].length).toBeLessThanOrEqual(250);
    expect([...cut.preview].slice(cut.start, cut.start + cut.length).join("")).toBe("hit");
  });
});

describe("B389 · 范围分流", () => {
  it("打开了文件夹 ⇒ 走磁盘那一发，三档与 glob 原样带下去", async () => {
    h.root = "E:\\root";
    h.report = report([hit("E:\\root\\a.md", "a.md", "a.md", 3, "aa 在盘上")], 1);
    store.setQuery({
      text: "aa",
      caseSensitive: true,
      wholeWord: false,
      regexp: true,
      include: "*.md",
      exclude: "node_modules",
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.calls.length, "去抖之后只发一发").toBe(1);
    expect(h.calls[0]).toMatchObject({
      root: "E:\\root",
      query: "aa",
      caseSensitive: true,
      wholeWord: false,
      regex: true,
      include: "*.md",
      exclude: "node_modules",
      maxResults: 2000,
    });
    expect(store.getGroups().map((g) => g.name)).toEqual(["a.md"]);
    expect(store.getScope()).toBe("folder");
    expect(store.scopeNote(), "盘上那一条不额外说话：根就在标题栏下面摆着").toBe("");
    expect(store.summaryMessage()).toBe("在 1 个文件中发现 1 个结果");
  });

  it("正开着的那条要认出 docId：路径大小写与分隔符先折一道", async () => {
    h.root = "E:\\root";
    openDoc(7, "e:/ROOT/A.md", "什么也没有");
    h.report = report([hit("E:\\root\\a.md", "a.md", "a.md", 1, "aa")], 1);
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups()[0].docId, "同一份文件不该因为写法不同被当成两份").toBe(7);
    expect(store.getGroups()[0].path, "跳过去用的仍是盘上那条绝对路径").toBe("E:\\root\\a.md");
  });

  it("没打开文件夹 ⇒ 一次 IPC 都不发，改扫内存快照并说明范围", async () => {
    h.root = "";
    openDoc(1, "E:\\root\\a.md", "第一行\n这里 aa 没保存\n第三行");
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.calls, "兜底那一支读的是内存，不读盘").toEqual([]);
    expect(store.getScope()).toBe("openDocs");
    expect(store.getGroups()[0].rows.map((r) => r.line)).toEqual([2]);
    expect(store.summaryMessage()).toBe("在 1 个打开的文档中发现 1 个结果");
    expect(store.scopeNote()).toContain("没有打开文件夹");
  });

  it("同一行两次命中只占一行（与后端「一条命中 = 一行」同口径）", async () => {
    openDoc(1, "E:\\a.md", "aa 与 aa 同一行\naa 另一行");
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups()[0].rows.map((r) => r.line)).toEqual([1, 2]);
    expect(store.planReplace().lines, "计数说的是行，不是出现次数").toBe(2);
  });

  it("大小写与全词那一档真的作用到匹配上", async () => {
    openDoc(1, "E:\\a.md", "小写 aa 与 大写 AA 与 粘着的 aab");
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups()[0].rows.length, "不敏感 ⇒ 这一行算一条").toBe(1);

    store.clearAll();
    store.setQuery({ text: "aa", caseSensitive: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups()[0].rows[0].preview, "敏感 ⇒ 只留第一个命中，落在小写那一处").toContain(
      "小写 aa",
    );

    store.clearAll();
    docs.clear();
    h.instances.clear();
    openDoc(2, "E:\b.md", "粘着的 aab 不算");
    store.setQuery({ text: "aa", wholeWord: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups(), "全词 ⇒ 词字符连着的不算命中").toEqual([]);
  });

  it("没有实例的文档（已被关掉的账）不参与", async () => {
    docs.set(9, { tabId: 9, path: "E:\\ghost.md", name: "ghost.md" } as never);
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups()).toEqual([]);
  });
});

describe("B389 · 列号口径：字符列，不是 UTF-16 单元", () => {
  // 点一条命中要把光标摆到**真**位置。两支的起点不同：后端算的是字符，
  // CodeMirror 给的是 UTF-16 单元 ⇒ 只有内存那一支需要换算，而换算漏掉的话
  // 「一行里有 emoji」时列号会多算，高亮与选中一起往后偏。
  it("盘上那一支：后端给的三格原样透传，不做二次换算", async () => {
    h.root = "E:\\root";
    h.report = report(
      [
        {
          path: "E:\\root\\a.md",
          rel: "a.md",
          name: "a.md",
          truncated: false,
          matches: [{ line: 1, preview: "😀😀 needle", start: 3, length: 6, column: 4 }],
        },
      ],
      1,
    );
    store.setQuery({ text: "needle" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups()[0].rows[0]).toMatchObject({ start: 3, length: 6, column: 4 });
  });

  it("内存那一支：emoji 占两个单元也只算一列", async () => {
    openDoc(1, "E:\\a.md", "😀😀 needle 在后头\nneedle 在第一行");
    store.setQuery({ text: "needle" });
    await vi.advanceTimersByTimeAsync(300);
    const rows = store.getGroups()[0].rows;
    expect(rows.map((r) => r.column)).toEqual([4, 1]);
    for (const r of rows) {
      expect([...r.preview].slice(r.start, r.start + r.length).join("")).toBe("needle");
    }
  });
});

describe("B389 · 去抖与在飞只认自己", () => {
  it("299ms 不发、300ms 发；连打两字只发最后一发", async () => {
    h.root = "E:\\root";
    store.setQuery({ text: "a" });
    await vi.advanceTimersByTimeAsync(299);
    expect(h.calls, "还没到去抖数值").toEqual([]);
    store.setQuery({ text: "ab" });
    await vi.advanceTimersByTimeAsync(299);
    expect(h.calls, "第二字把第一发重新计时").toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]).toMatchObject({ query: "ab" });
  });

  it("回车不等去抖：在飞的定时器要一起取消，否则会跑出第二次", async () => {
    h.root = "E:\\root";
    store.setQuery({ text: "aa" });
    store.runNow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls.length, "runNow 之后那颗定时器不该再响一次").toBe(1);
  });

  it("旧回包后到不许盖掉新结果，也不许熄掉新一发的转圈", async () => {
    h.root = "E:\root";
    h.gated.add("aa");
    h.gated.add("bb");
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    store.setQuery({ text: "bb" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.calls.length, "两发都发出去了，第一发压在门里").toBe(2);
    expect(store.isRunning()).toBe(true);

    h.release.get("aa")?.(report([hit("E:\\a.md", "a.md", "a.md", 1, "aa 是旧的")], 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getGroups(), "旧回包被丢弃").toEqual([]);
    expect(store.isRunning(), "旧回包不许把新一发的转圈熄掉").toBe(true);

    h.release.get("bb")?.(report([hit("E:\b.md", "b.md", "b.md", 1, "bb 是新的")], 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getGroups().map((g) => g.name)).toEqual(["b.md"]);
    expect(store.isRunning()).toBe(false);
    expect(store.summaryMessage()).toBe("在 1 个文件中发现 1 个结果");
  });

  it("空串：不发 IPC、立刻清空结果与文案", async () => {
    h.root = "E:\\root";
    h.report = report([hit("E:\\a.md", "a.md", "a.md", 1, "aa")], 1);
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getGroups().length).toBe(1);
    store.setQuery({ text: "" });
    expect(store.getGroups()).toEqual([]);
    expect(store.summaryMessage()).toBe("");
    expect(store.emptyMessage()).toBe("输入要搜索的内容。");
    expect(h.calls.length, "清空不该再发一发").toBe(1);
  });
});

describe("B389 · 语法闸门与报错原话", () => {
  it("正则语法错 ⇒ 不发 IPC、标红、计数行说人话", async () => {
    h.root = "E:\\root";
    store.setQuery({ text: "((", regexp: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls, "两边引擎都不认的串不该白跑一趟").toEqual([]);
    expect(store.isInvalid()).toBe(true);
    expect(store.summaryMessage()).toBe("正则表达式无效");
    expect(store.emptyMessage(), "不复读「未找到结果」，也不重复那一句").toBe("");
  });

  it("改回合法 ⇒ 标红撤掉并真的搜", async () => {
    h.root = "E:\\root";
    store.setQuery({ text: "((", regexp: true });
    await vi.advanceTimersByTimeAsync(300);
    h.report = report([hit("E:\\a.md", "a.md", "a.md", 1, "aab")], 1);
    store.setQuery({ text: "a." });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.isInvalid()).toBe(false);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]).toMatchObject({ query: "a.", regex: true });
  });

  it("后端失败 ⇒ 原话进计数行、结果清空；查询被清掉时那句跟着消失", async () => {
    h.root = "E:\\root";
    h.fail = "正则无效：回溯失控";
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.summaryMessage()).toContain("正则无效");
    h.fail = "";
    store.setQuery({ text: "" });
    expect(store.summaryMessage(), "查询都空了还挂着旧那句，读起来像程序又坏了").toBe("");
  });

  it("撞上限 ⇒ 计数行加「这不是全部」", async () => {
    h.root = "E:\\root";
    h.report = report([hit("E:\\a.md", "a.md", "a.md", 1, "aa")], 2000, true);
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.summaryMessage()).toContain("已达 2000 条上限");
  });
});

describe("B389 · 折叠态与替换计划", () => {
  const two = (): void => {
    h.root = "E:\\root";
    h.report = report(
      [hit("E:\\a.md", "a.md", "a.md", 1, "aa"), hit("E:\\dir\\b.md", "dir/b.md", "b.md", 2, "aa")],
      2,
    );
  };

  it("toggleFile / collapseAll / expandAll 各通知一次并改判据", async () => {
    two();
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    const notified = vi.fn();
    const off = store.onSearchChange(notified);
    store.toggleFile("E:\\a.md");
    expect(store.isCollapsed("E:\\a.md")).toBe(true);
    store.toggleFile("E:\\a.md");
    expect(store.isCollapsed("E:\\a.md"), "再点一次是展开").toBe(false);
    store.collapseAll();
    expect(store.isCollapsed("E:\\dir\\b.md")).toBe(true);
    store.expandAll();
    expect(store.isCollapsed("E:\\a.md")).toBe(false);
    expect(notified, "四次改态各通知一次").toHaveBeenCalledTimes(4);
    off();
  });

  it("新一轮搜索把折叠态清掉（折叠属于这一屏，不该跨结果攒着）", async () => {
    two();
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    store.collapseAll();
    store.setQuery({ text: "bb" });
    await vi.advanceTimersByTimeAsync(300);
    expect(store.isCollapsed("E:\\a.md")).toBe(false);
  });

  it("planReplace：正开着的走内存、只在盘上的走 IPC，行数与文件数对上", async () => {
    two();
    openDoc(3, "E:\\a.md", "aa");
    store.setQuery({ text: "aa" });
    await vi.advanceTimersByTimeAsync(300);
    const plan = store.planReplace();
    expect(plan.files).toBe(2);
    expect(plan.lines).toBe(2);
    expect(plan.openDocs.map((g) => g.docId)).toEqual([3]);
    expect(plan.diskFiles.map((g) => g.path)).toEqual(["E:\\dir\\b.md"]);
  });
});
