// @vitest-environment jsdom
// B352-10 会话里的两个字段：落盘形状 · 恢复回落 · 以及「恢复的那一刻把扩展装上」。
//
// 三条线各自要有鉴别力：
// ① `sessionStore`（运行时）：`setIr` 是唯一写点，磁盘形状跟着记录走 —— 非 md 标签两字段
//    都写 `null`（与 `viewMode` 同口径：留 `"off"` 就是「这块真的处于源码态」的假证据）。
// ② 恢复（静态 + 运行时）：白名单只许走 `coerceIrState`。`viewMode` 那一段是手抄枚举
//    （`=== "source" || === "preview"`），照抄过来就等于第二份口径（B304 那一族）。
// ③ 装扩展（运行时）：会话里读到 `liveRender = "ir"` 却只写两个字段 = 键显示「渲染·锁」而
//    画面还是纯源码、预览又被闸门挡住 ⇒ 一片空白。所以恢复路径必须把装饰层与锁一起装进
//    `tab.state`，而且算法与 `applyIrState` 共用同一份。
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { sessionStore } from "../src/session/store";
import { coerceIrState, irStateName } from "../src/markdown/ir-state";
import { setIrBlocks, irBlocksOf } from "../src/markdown/live-render";
import { fnBody, stripLineComments } from "./static";
import { makeDoc, makeInstance, registerDoc } from "../src/doc-model";
import type { Tab } from "../src/core/app-state";

const store = stripLineComments(readFileSync("src/session/store.ts", "utf-8"));
const persist = stripLineComments(readFileSync("src/session/persist.ts", "utf-8"));
const rebuild = stripLineComments(readFileSync("src/session/rebuild.ts", "utf-8"));
const md = stripLineComments(readFileSync("src/markdown.ts", "utf-8"));
const filesSrc = stripLineComments(readFileSync("src/io/files.ts", "utf-8"));
const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

let restoreIrState: typeof import("../src/markdown").restoreIrState;

beforeAll(async () => {
  const body = (
    readFileSync("index.html", "utf-8").match(/<body>([\s\S]*)<\/body>/)?.[1] ?? ""
  ).replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;
  const mod = await import("../src/markdown");
  restoreIrState = mod.restoreIrState;
});

/** 类方法的方法体：`fnBody` 只认 `function name(` 声明，而 `sessionStore` 的方法是 `setIr(…) {`。 */
function methodBody(src: string, name: string): string {
  const at = src.indexOf(`  ${name}(`);
  if (at < 0) return "";
  const end = src.indexOf("\n  }", at);
  return end < 0 ? "" : src.slice(at, end + 4);
}

const DOC_TEXT = "# a\n\n- x\n";
let docSeq = 900;

/**
 * 真 md 文档 + 真实例（走生产那条 `makeDoc` / `makeInstance`，ir-lock-key 同款口径）。
 *
 * 自拼的 Tab 字面量在这一发上会各测到一半：`refreshIr` 先问 `isMdTab`（要 `docs` 里真有一份
 * md 文档），`irCompsEffects` 又问 `docOf`（查不到是直接抛的），而 `makeTabState` 给的
 * `comps.ir.of([])` 正是恢复要升级的那个初值 —— 三段都只在真实例上才是真判据。
 */
function fakeTab(readonly = false): Tab {
  const docId = ++docSeq;
  const doc = makeDoc(docId, DOC_TEXT, `note-${docId}.md`, null, "UTF-8", "CRLF", readonly);
  registerDoc(doc);
  return makeInstance(doc, 0, DOC_TEXT);
}

describe("B352-10 会话记录：setIr 是唯一写点", () => {
  it('新登记的记录两字段是 null（不是 "off"），落盘形状跟着走', () => {
    sessionStore.reset();
    sessionStore.register(1, 10);
    sessionStore.setPanel(0, [1], 1);
    const rec = sessionStore.get(1)!;
    expect(rec.liveRender, "没记过就是 null").toBeNull();
    expect(rec.irLocked, "没记过就是 null（false 是「用户明确解过锁」）").toBeNull();
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0]).toMatchObject({
      liveRender: null,
      irLocked: null,
    });
  });

  it("setIr 写进去之后，内存记录与磁盘形状两处一致", () => {
    sessionStore.reset();
    sessionStore.register(1, 10);
    sessionStore.setPanel(0, [1], 1);
    sessionStore.setIr(1, "ir", false);
    expect(sessionStore.get(1)!).toMatchObject({ liveRender: "ir", irLocked: false });
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0]).toMatchObject({
      liveRender: "ir",
      irLocked: false,
    });
    // 退回源码：两字段照写（`off` 是「这一格真的停在源码态」，与没记过是两件事）
    sessionStore.setIr(1, "off", true);
    expect(sessionStore.toSessionState(() => true).panels[0].tabs[0]).toMatchObject({
      liveRender: "off",
      irLocked: true,
    });
  });

  it("非 md 标签落盘写 null（与 viewMode 同口径），且这一发只在 refreshSession 里", () => {
    const body = fnBody(persist, "refreshSession");
    const calls = body.split("sessionStore.setIr(").length - 1;
    expect(calls, "每轮只写一次：两处写点就是 B304 那一族").toBe(1);
    expect(body, '非 md 必须给 null，不许留 "off"').toMatch(
      /setIr\(\s*t\.tabId,\s*isMdTab\(t\)\s*\?\s*t\.liveRender\s*:\s*null,\s*isMdTab\(t\)\s*\?\s*t\.irLocked\s*:\s*null\s*\)/,
    );
  });

  it("写点唯一：字段赋值只出现在 setIr 里，其它 setter 不许顺手改", () => {
    const writes = store.match(/\br\.liveRender\s*=/g)?.length ?? 0;
    const writes2 = store.match(/\br\.irLocked\s*=/g)?.length ?? 0;
    expect(writes, "r.liveRender 的赋值只许有一处").toBe(1);
    expect(writes2, "r.irLocked 的赋值只许有一处").toBe(1);
    const body = methodBody(store, "setIr");
    expect(body, "取到方法体了没？").toBeTruthy();
    expect(body, "那一处就在 setIr 里").toMatch(/r\.liveRender\s*=/);
    // 反向对照的自证：判据要是打在空串上就是空转
    expect(store, "store.ts 读到了吗").toContain("sessionStore");
  });
});

describe("B352-10 恢复：白名单只走 coerceIrState", () => {
  it("旧会话缺字段 ⇒ 源码 + 锁着；wysiwyg 这类没实现的模式退成源码", () => {
    expect(coerceIrState({})).toEqual({ liveRender: "off", irLocked: true });
    expect(coerceIrState({ liveRender: null, irLocked: null })).toEqual({
      liveRender: "off",
      irLocked: true,
    });
    // 两列各回各的（`ir-state.test.ts` 钉过的口径）：模式非法只把模式退回 off，
    // 用户明确记下的「解过锁」不因此作废 —— 源码态里这一位本来就不生效。
    expect(coerceIrState({ liveRender: "wysiwyg", irLocked: false })).toEqual({
      liveRender: "off",
      irLocked: false,
    });
    expect(irStateName(coerceIrState({ liveRender: "wysiwyg", irLocked: false }))).toBe("source");
    // 「明确解过锁」与「没记过」是两件事
    expect(coerceIrState({ liveRender: "ir", irLocked: false })).toEqual({
      liveRender: "ir",
      irLocked: false,
    });
    expect(coerceIrState({ liveRender: "ir", irLocked: null })).toEqual({
      liveRender: "ir",
      irLocked: true,
    });
  });

  it("rebuild 走唯一回落出口，不手抄枚举白名单", () => {
    expect(rebuild, "恢复走 coerceIrState").toMatch(/coerceIrState\(/);
    expect(rebuild, "不许像 viewMode 那样把枚举抄第二份（两份口径迟早分裂）").not.toMatch(
      /liveRender === "ir"[^;]*liveRender === "off"/,
    );
    expect(rebuild, "也不许在恢复里直接写实例的两个字段").not.toMatch(/inst\.liveRender\s*=/);
    expect(rebuild, "装扩展与写状态走 markdown 的同一个出口").toMatch(/restoreIrState\(/);
  });
});

describe("B352-10 恢复的那一刻就把扩展装上（不然画面与键各说一套）", () => {
  it("读到 ir：装饰层真的上线，编辑面也真的关掉", () => {
    const tab = fakeTab();
    restoreIrState(tab, { liveRender: "ir", irLocked: true });
    expect(tab.liveRender, "字段落进实例").toBe("ir");
    expect(tab.irLocked, "锁着").toBe(true);
    expect(tab.state.facet(EditorView.editable), "锁态关掉编辑面").toBe(false);
    const next = tab.state.update({
      effects: setIrBlocks.of([{ lineStart: 1, lineEnd: 1, html: "<h1>a</h1>" }]),
    });
    expect(irBlocksOf(next.state).length, "块表进得来 = 装饰层真的在配置里").toBe(1);
  });

  it("恢复自己就把块表喂上：不许留一个「等防抖到货」的空窗（锁态下用户没有自救手段）", () => {
    const tab = fakeTab();
    restoreIrState(tab, { liveRender: "ir", irLocked: true });
    // 上一条例是自己手动 dispatch 了 `setIrBlocks` 才绿的 —— 那等于测试替生产补了缺的那一发。
    // 生产里块表只有两个来源：`applyIrState` 末尾与 120ms 防抖（只由 textChanged 排程）。
    // 恢复既不换态也不改文本 ⇒ 两条都不走：画面是一篇纯源码，而键画着锁、打不进字。
    expect(irBlocksOf(tab.state).length, "装完扩展之后块表就得有东西").toBeGreaterThan(0);
    expect(fnBody(md, "restoreIrState"), "那一发是 `refreshIr(tab)`（与换态同一出口）").toMatch(
      /refreshIr\(tab\)/,
    );
  });

  it("只读钳制必须连扩展一起钳：不许「键显示锁、编辑面可写」", () => {
    const tab = fakeTab(true);
    restoreIrState(tab, { liveRender: "ir", irLocked: false });
    expect(tab.irLocked, "字段按回锁着").toBe(true);
    // 同一个出口写的字段与装的扩展是两件事：只钳字段 = B304 那一族「显示与行为两套口径」
    expect(tab.state.facet(EditorView.editable), "编辑面也得跟着关掉").toBe(false);
    const tr = tab.state.update({
      changes: { from: 0, insert: "Z" },
      annotations: Transaction.userEvent.of("input"),
    });
    expect(tr.changes.empty, "changeFilter 同样要装上").toBe(true);
  });

  it("读到 off（或非法值）：装饰层与锁一起下线，块表发了也不留", () => {
    const tab = fakeTab();
    restoreIrState(tab, coerceIrState({ liveRender: "wysiwyg", irLocked: null }));
    expect(tab.state.facet(EditorView.editable), "源码面可写").toBe(true);
    const next = tab.state.update({
      effects: setIrBlocks.of([{ lineStart: 1, lineEnd: 1, html: "<h1>a</h1>" }]),
    });
    expect(irBlocksOf(next.state).length, "层没上线，块表无处可存").toBe(0);
  });
});

describe("B352-11 评审 C3：整态重建不许把 IR 层静默拆掉", () => {
  it("`rebuildDocInstances` 换掉 comps 之后必须补装 IR（外部重载 / 改编码 / 副本还原）", () => {
    const body = fnBody(filesSrc, "rebuildDocInstances");
    const swap = body.indexOf("inst.comps = made.comps");
    const reapply = body.indexOf("restoreIrState(");
    expect(swap, "取到那段了没？").toBeGreaterThan(-1);
    expect(reapply, "重建之后要按实例自己的 IR 字段补一发").toBeGreaterThan(swap);
    expect(
      body.slice(reapply, reapply + 200),
      "补的是这份实例当前的状态，不是硬套一个默认值",
    ).toMatch(/liveRender:\s*inst\.liveRender/);
  });
});

describe("B352-10 Rust 侧：字段 + alias + Default 三处齐", () => {
  it("两个新字段都是 Option（`false` 与「没记过」是两件事）", () => {
    expect(rust).toMatch(/pub live_render: Option<String>/);
    expect(rust, "camelCase 线上格式靠 alias 兜（B49 那一坑）").toMatch(
      /#\[serde\(alias = "live_render"\)\]/,
    );
    expect(rust).toMatch(/pub ir_locked: Option<bool>/);
    expect(rust).toMatch(/#\[serde\(alias = "ir_locked"\)\]/);
    expect(rust, "Default 里也得是 None，不然旧会话反序列化会拿 Some 当缺省").toMatch(
      /live_render:\s*None/,
    );
    expect(rust).toMatch(/ir_locked:\s*None/);
  });

  it("线上形状：反序列化 camelCase、序列化也写 camelCase", () => {
    // 这一发只判「结构体上挂着 rename_all + alias」这个组合，真正的往返由 cargo test 跑
    expect(rust).toMatch(/#\[serde\(default,\s*rename_all = "camelCase"\)\]/);
  });
});
