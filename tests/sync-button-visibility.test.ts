// @vitest-environment jsdom
// 同步滚动键的显隐口径（B152/B173）。
//
// 差异标签与普通标签共享同一个 `docId`，但它不参与共享滚动坐标（`sharesDocScroll`
// 只认 `kind === "editor"`）⇒ 「开一份文档 + 它的差异编辑器」不是「开了两份」。
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  docSyncModes,
  panels,
  setActivePanelId,
  tabs,
  type Panel,
  type Tab,
} from "../src/core/app-state";
import { makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import type { DiffSpec } from "../src/diff/model";

let ui: typeof import("../src/ui");
let nextTabId = 1;

const DIFF_SPEC: DiffSpec = {
  tier: "baseline",
  docId: 100,
  leftDocId: null,
  leftText: () => "",
  leftName: "a.md",
  rightName: "a.md",
  leftPath: null,
};

function makeTab(kind: "editor" | "diff"): Tab {
  const { state, comps } = makeTabState(
    "x",
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  return {
    tabId: nextTabId++,
    docId: 100,
    panelId: 0,
    comps,
    state,
    viewMode: "source",
    kind,
    diff: kind === "diff" ? DIFF_SPEC : null,
    scrollV: 1,
  };
}

function panelOf(...list: Tab[]): Panel {
  return {
    panelId: 0,
    tabs: list.map((t) => t.tabId),
    activeTabId: list[0]!.tabId,
    view: null,
    viewTabId: list[0]!.tabId,
    bodyEl: null,
    diffSurface: null,
  };
}

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  ui = await import("../src/ui");
});

beforeEach(() => {
  tabs.clear();
  panels.clear();
  docSyncModes.clear();
  setActivePanelId(0);
});

describe("同步滚动键的显隐：差异标签不算另一份", () => {
  it("只开一份文档 + 同一份文档的差异编辑器 ⇒ 同步键不露脸", () => {
    const editor = makeTab("editor");
    const diff = makeTab("diff");
    tabs.set(editor.tabId, editor);
    tabs.set(diff.tabId, diff);
    panels.set(0, panelOf(editor, diff));

    ui.refreshSyncButton(editor);

    expect(ui.syncScrollBtn.hidden, "差异标签不参与共享滚动，不该凑成第二份").toBe(true);
  });

  it("同文档两张普通编辑器标签 ⇒ 同步键照常露脸", () => {
    const a = makeTab("editor");
    const b = makeTab("editor");
    tabs.set(a.tabId, a);
    tabs.set(b.tabId, b);
    panels.set(0, panelOf(a, b));

    ui.refreshSyncButton(a);

    expect(ui.syncScrollBtn.hidden).toBe(false);
  });
});
