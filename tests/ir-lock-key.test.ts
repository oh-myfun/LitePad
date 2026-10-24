// @vitest-environment jsdom
// B352-8 那颗三态悬浮锁键。
//
// 它是整条 IR 路线**唯一的入口**（用户拍板：默认锁着 + 一颗键同时 carrying「渲染」与「可写」），
// 所以判据的重点不是好不好看，而是三条口径：
//   · 三态三形，字形只由 `irStateName` 驱动（键自己不算后继 ⇒ 只读文档那一态不可能从这里漏出来）；
//   · 点一下走的是循环（一次 handler，不多不少）；
//   · 门槛不满足时**DOM 里没有这个节点**（不是 hidden、不是 disabled —— 灰着的键会被当成可点，
//     B346/B304 那一族「显示与行为两套口径」就是这么来的）。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  createIrLockKey,
  refreshIrLockKey,
  setIrCycleHandler,
  IR_LOCK_KEY_CLASS,
} from "../src/shell/irlock";
import { perfProfileFor } from "../src/editor/perf";
import { docs, tabs, setWindowKind, type Panel } from "../src/core/app-state";
import { makeDoc, makeInstance, registerDoc } from "../src/doc-model";
import { stripCssComments, stripLineComments } from "./static";

let host: HTMLElement;
let seq = 0;

/** 起一格真面板壳：`.panel-host` + 一份实例（走生产那条 `makeDoc`/`makeInstance`，不自拼 Tab 字面量）。 */
function mountPanel(name = "a.md", sizeClass: "normal" | "large" = "normal", readonly = false) {
  host = document.createElement("div");
  host.className = "panel-host mode-source";
  document.body.appendChild(host);
  const doc = makeDoc(++seq + 1000, "# T\n", name, null, "UTF-8", "LF", readonly, sizeClass);
  registerDoc(doc);
  const inst = makeInstance(doc, 0, "# T\n");
  tabs.set(inst.tabId, inst);
  const panel: Panel = {
    panelId: 0,
    tabs: [inst.tabId],
    activeTabId: inst.tabId,
    view: null,
    viewTabId: inst.tabId,
    preview: null,
    previewTimer: null,
    bodyEl: host,
  };
  return { panel, tab: inst };
}

const keyOf = (): HTMLElement | null => host.querySelector<HTMLElement>(`.${IR_LOCK_KEY_CLASS}`);

beforeEach(() => {
  setWindowKind("main");
  tabs.clear();
  docs.clear();
  setIrCycleHandler(() => {});
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("B352-8 三态三形", () => {
  it("字形与状态一一对应：source→code / render-locked→lock / render-editable→unlock", () => {
    const { panel, tab } = mountPanel();
    const expectGlyph: Record<string, string> = {
      source: "codicon-code",
      "render-locked": "codicon-lock",
      "render-editable": "codicon-unlock",
    };
    for (const [state, liveRender, irLocked] of [
      ["source", "off", true],
      ["render-locked", "ir", true],
      ["render-editable", "ir", false],
    ] as const) {
      tab.liveRender = liveRender;
      tab.irLocked = irLocked;
      refreshIrLockKey(panel);
      const btn = keyOf();
      expect(btn, `状态 ${state} 该有键`).toBeTruthy();
      expect(btn!.dataset.irState, `状态 ${state} 要写进 dataset`).toBe(state);
      expect(btn!.querySelector(".codicon")?.className, `状态 ${state} 的字形`).toContain(
        expectGlyph[state],
      );
    }
  });

  it("按钮里不塞文字（B348：删掉的「装饰」可能在撑布局）", () => {
    const { panel } = mountPanel();
    refreshIrLockKey(panel);
    expect(keyOf()?.textContent?.trim(), "只有字形，没有文案节点").toBe("");
  });

  it("提示走按钮档：有 data-tip，且不跟鼠标（B350 两档）", () => {
    const { panel } = mountPanel();
    refreshIrLockKey(panel);
    const btn = keyOf()!;
    expect(btn.dataset.tip, "三态各有一句提示").toBeTruthy();
    expect(btn.dataset.tipFollow, "按钮档不跟鼠标").not.toBe("1");
    expect(btn.getAttribute("aria-label"), "读屏要有可访问名").toBeTruthy();
  });

  it("createIrLockKey 只造节点：不带呈现、也不决定挂不挂（呈现全归 refresh）", () => {
    const { panel } = mountPanel();
    const btn = createIrLockKey(panel);
    expect(btn.classList.contains(IR_LOCK_KEY_CLASS), "类名要带上（refresh 按它找节点）").toBe(
      true,
    );
    expect(btn.parentElement, "造出来时还没挂上任何容器").toBeNull();
    expect(btn.dataset.irState, "构造阶段不做呈现").toBeUndefined();
  });
});

describe("B352-8 点一下走的是循环", () => {
  it("一次点击 ⇒ 注册的换态函数被调一次、参数就是这一格的活动标签", () => {
    const { panel, tab } = mountPanel();
    const cycle = vi.fn();
    setIrCycleHandler(cycle);
    refreshIrLockKey(panel);
    keyOf()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cycle, "一次点击恰好一发").toHaveBeenCalledTimes(1);
    expect(cycle.mock.calls[0][0].tabId, "递给状态机的是这一格的活动标签").toBe(tab.tabId);
  });

  it("键自己不算后继：irlock.ts 里不许出现状态字面量或状态机调用（可达性只有 nextIrState 一个来源）", () => {
    const src = stripLineComments(readFileSync("src/shell/irlock.ts", "utf-8"));
    expect(src, "不许在这里拼三态").not.toMatch(/liveRender:\s*"(ir|off)"/);
    expect(src, "不许在这里算后继态").not.toMatch(/nextIrState\s*\(/);
    expect(src, "只读退化不许在这里另算一遍").not.toMatch(/\birLocked:\s*(true|false)/);
  });

  it("活动标签已被关掉之后再点：不炸，也不递一个不存在的标签过去", () => {
    const { panel, tab } = mountPanel();
    const cycle = vi.fn();
    setIrCycleHandler(cycle);
    refreshIrLockKey(panel);
    tabs.delete(tab.tabId);
    expect(() => keyOf()!.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
    expect(cycle, "标签没了就不该再走循环").not.toHaveBeenCalled();
  });
});

describe("B352-8 门槛：不满足时 DOM 里没有这颗键", () => {
  it("非 md 面板 ⇒ 容器里没有 .ir-lock-key 节点（不是 hidden、不是 disabled）", () => {
    const { panel } = mountPanel("a.json");
    refreshIrLockKey(panel);
    expect(keyOf(), "节点必须不存在").toBeNull();
    expect(host.innerHTML, "也没有 hidden/disabled 的残影").not.toMatch(/ir-lock-key/);
  });

  it("autoPreview 关档（>2 MB）⇒ 同样没有节点", () => {
    expect(perfProfileFor("large").autoPreview, "先确认 large 档真的关着自动预览").toBe(false);
    const { panel } = mountPanel("big.md", "large");
    refreshIrLockKey(panel);
    expect(keyOf()).toBeNull();
  });

  it("门槛从「不满足」翻回「满足」时节点要回来，且重挂两次也只有一颗", () => {
    const { panel } = mountPanel("a.json");
    refreshIrLockKey(panel);
    expect(keyOf()).toBeNull();
    // 同一格换成 md 文档（生产里由打开动作 / switchTab 改 activeTabId）
    const doc = makeDoc(7777, "# T\n", "b.md", null, "UTF-8", "LF", false);
    registerDoc(doc);
    const mdTab = makeInstance(doc, 0, "# T\n");
    tabs.set(mdTab.tabId, mdTab);
    panel.activeTabId = mdTab.tabId;
    panel.tabs = [mdTab.tabId];
    refreshIrLockKey(panel);
    refreshIrLockKey(panel);
    expect(host.querySelectorAll(`.${IR_LOCK_KEY_CLASS}`).length, "只能有一颗").toBe(1);
    expect(keyOf()?.dataset.irState).toBe("source");
  });

  it("只读文档进了 B 态：提示不许承诺「解锁」—— 那一按实际是回源码（真机台抓到）", () => {
    const { panel, tab } = mountPanel("ro-tip.md", "normal", true);
    tab.liveRender = "ir";
    tab.irLocked = true;
    refreshIrLockKey(panel);
    const tip = keyOf()?.dataset.tip ?? "";
    expect(tip, "只读 ⇒ C 不可达，说「解锁」是骗人").not.toContain("解锁");
    expect(tip, "提示写的是点下去会怎样").toBe("回到源码");
  });

  it("只读文档照旧给键（阅读态 B 正是它要的），但态名由状态机决定 —— 这里钉「节点在、画的是 source」", () => {
    const { panel } = mountPanel("ro.md", "normal", true);
    refreshIrLockKey(panel);
    expect(keyOf(), "只读文档也允许进渲染态（锁着看）").toBeTruthy();
    expect(keyOf()?.dataset.irState).toBe("source");
  });
});

describe("B352-8 样式判据", () => {
  const css = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
  const rule = css.match(/\.ir-lock-key\s*\{[^}]*\}/)?.[0] ?? "";

  it("定位上下文是面板壳：绝对定位，绝不许 fixed（多面板会叠）", () => {
    expect(rule, "要有 .ir-lock-key 规则").toBeTruthy();
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule, "不许出现 fixed").not.toMatch(/position:\s*fixed/);
  });

  it("圆角跟 --radius，颜色一律走 token（本功能那颗键的块里不许写死 hex）", () => {
    expect(rule, "圆角跟共用 --radius").toMatch(/var\(--radius/);
    const blocks = css.match(/\.ir-lock-key[^{]*\{[^}]*\}/g) ?? [];
    expect(blocks.length, "至少一条 .ir-lock-key 规则").toBeGreaterThan(0);
    for (const b of blocks) expect(b, `写死颜色：${b}`).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
