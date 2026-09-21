import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cssDecls, topLevelFnBody } from "./static";
import {
  countLeaves,
  eachLeaf,
  hasPanel,
  leaf,
  maximizePanel,
  pathToPanel,
  removePanel,
  restoreRatios,
  siblingLeafOf,
  splitPanel,
  splitPanelAt,
  type LayoutNode,
  updateRatio,
} from "../src/shell/layout";

const tree: LayoutNode = {
  kind: "split",
  dir: "h",
  ratio: 0.5,
  a: leaf(1),
  b: {
    kind: "split",
    dir: "v",
    ratio: 0.6,
    a: leaf(2),
    b: leaf(3),
  },
};

describe("layout tree", () => {
  it("countLeaves", () => {
    expect(countLeaves(leaf(1))).toBe(1);
    expect(countLeaves(tree)).toBe(3);
  });

  it("hasPanel / eachLeaf", () => {
    expect(hasPanel(tree, 3)).toBe(true);
    expect(hasPanel(tree, 9)).toBe(false);
    const ids: number[] = [];
    eachLeaf(tree, (id) => ids.push(id));
    expect(ids).toEqual([1, 2, 3]);
  });

  it("splitPanel 在目标旁插入", () => {
    const t = splitPanel(leaf(1), 1, "v", 2);
    expect(countLeaves(t)).toBe(2);
    const ids: number[] = [];
    eachLeaf(t, (id) => ids.push(id));
    expect(ids).toEqual([1, 2]);
  });

  it("splitPanel 目标不存在时原样返回", () => {
    const t = splitPanel(leaf(1), 99, "v", 2);
    expect(countLeaves(t)).toBe(1);
  });

  it("removePanel 规约：叶子摘除后兄弟上提", () => {
    const t = removePanel(tree, 2);
    expect(t).not.toBeNull();
    if (t && t.kind === "split") {
      // 面板 2 的父 split 被规约，b 侧应为 leaf(3)
      expect(t.b).toEqual({ kind: "leaf", panelId: 3 });
    } else {
      throw new Error("expected split node");
    }
    expect(countLeaves(t)).toBe(2);
  });

  it("removePanel 比例补偿：关闭外侧面板时，存活子树的分隔线不得大幅跳动（回归：关闭面板影响其他分割位置）", () => {
    // [P1 40% | P2 35% | P3 25%]，关闭 P1：
    // 旧行为 → P2|P3 分隔线从 75% 跳到 53.8%（两个面板都翻倍）；
    // 补偿后 → 紧邻 P1 的 P2 吸收释放空间，P3 保持绝对尺寸（25% → 27.7%，微调）。
    const t: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.4,
      a: leaf(1),
      b: { kind: "split", dir: "h", ratio: 35 / 65, a: leaf(2), b: leaf(3) },
    };
    const after = removePanel(t, 1);
    expect(after).not.toBeNull();
    if (after && after.kind === "split") {
      const s = 35 / 65,
        r = 0.4;
      const expected = s + r - s * r; // ≈ 0.723：P2 保持相邻、P3 绝对尺寸近似不变
      expect(after.ratio).toBeCloseTo(expected, 6);
    } else {
      throw new Error("expected split node");
    }
  });

  it("removePanel 比例补偿：关闭内侧叶子时，兄弟子树首子区域保持绝对尺寸", () => {
    // [ [A 30% | B 30%] | P3 40% ]，关闭 P3：A 的绝对尺寸 30% 必须不变，
    // 释放空间流向紧邻 P3 的 B 侧（30% → 70%）。
    const t: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.6,
      a: { kind: "split", dir: "h", ratio: 0.5, a: leaf(1), b: leaf(2) },
      b: leaf(3),
    };
    const after = removePanel(t, 3);
    expect(after).not.toBeNull();
    if (after && after.kind === "split") {
      expect(after.ratio, "A 的绝对尺寸应保持 0.6 * 0.5 = 0.3").toBeCloseTo(0.3, 6);
    } else {
      throw new Error("expected split node");
    }
  });

  it("removePanel 跨方向子树不补偿：分割轴不同，子区域尺寸天然不变", () => {
    // 根 h-split，右子树是 v-split：关闭左叶，右子树 ratio（纵向）原样保留
    const t: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: leaf(1),
      b: { kind: "split", dir: "v", ratio: 0.6, a: leaf(2), b: leaf(3) },
    };
    const after = removePanel(t, 1);
    expect(after).not.toBeNull();
    if (after && after.kind === "split") {
      expect(after.ratio).toBe(0.6);
    } else {
      throw new Error("expected split node");
    }
  });

  it("removePanel 移除后树规约为单叶子", () => {
    const three = splitPanel(splitPanel(leaf(1), 1, "h", 2), 2, "v", 3);
    const t = removePanel(removePanel(three, 3), 2);
    expect(t).toEqual({ kind: "leaf", panelId: 1 });
  });

  it("removePanel 最后一个面板返回 null", () => {
    expect(removePanel(leaf(1), 1)).toBeNull();
  });

  it("siblingLeafOf 返回视觉相邻叶子", () => {
    // tree = h[ leaf(1), v[ leaf(2), leaf(3) ] ]
    expect(siblingLeafOf(tree, 1)).toBe(2); // 1 的兄弟是 b 侧第一个叶子
    expect(siblingLeafOf(tree, 2)).toBe(3); // v 内左右相邻
    expect(siblingLeafOf(tree, 3)).toBe(2); // v 内左右相邻
    expect(siblingLeafOf(leaf(1), 1)).toBeNull(); // 单面板无邻居
    expect(siblingLeafOf(tree, 9)).toBeNull(); // 不存在的面板
  });

  it("splitPanelAt 按 side 在目标旁插入新面板", () => {
    // 在面板 1 右侧（newFirst=false）分屏新面板 9
    const t1 = splitPanelAt(leaf(1), 1, "h", 9, false);
    expect(t1.kind).toBe("split");
    if (t1.kind === "split") {
      expect(t1.a).toEqual({ kind: "leaf", panelId: 1 });
      expect(t1.b).toEqual({ kind: "leaf", panelId: 9 });
    }
    // 在面板 1 左侧（newFirst=true）分屏新面板 9
    const t2 = splitPanelAt(leaf(1), 1, "v", 9, true);
    expect(t2.kind).toBe("split");
    if (t2.kind === "split") {
      expect(t2.a).toEqual({ kind: "leaf", panelId: 9 });
      expect(t2.b).toEqual({ kind: "leaf", panelId: 1 });
    }
    // 目标不存在时原样返回
    expect(splitPanelAt(leaf(1), 42, "h", 9, false)).toEqual({ kind: "leaf", panelId: 1 });
  });
});

describe("updateRatio 路径约定（B26 回归：分割条位置随开/关文档跳变）", () => {
  // build() 传给 onRatioChange 的 path 是「分割节点自身」的树路径：
  // 根分割 = []，根的 a 子树里的分割 = [0]，b 子树里 = [1]……
  const nested = (): LayoutNode => ({
    kind: "split",
    dir: "h",
    ratio: 0.5,
    a: { kind: "split", dir: "v", ratio: 0.5, a: leaf(1), b: leaf(2) },
    b: { kind: "split", dir: "v", ratio: 0.5, a: leaf(3), b: leaf(4) },
  });

  it("根分割用空路径写入（旧实现永远写不进 → 开/关文档后跳位）", () => {
    const t = nested();
    updateRatio(t, [], 0.3);
    expect(t.ratio).toBe(0.3);
  });

  it("嵌套分割写到对应子节点，而不是父节点", () => {
    const t = nested();
    updateRatio(t, [0], 0.25);
    expect(t.a.kind === "split" && t.a.ratio).toBe(0.25);
    expect(t.ratio, "父节点比例不得被误改").toBe(0.5);
    updateRatio(t, [1], 0.8);
    expect(t.b.kind === "split" && t.b.ratio).toBe(0.8);
    // [1,0] 指向 b.a（叶子）→ 安全无操作，b 的比例不变
    updateRatio(t, [1, 0], 0.6);
    expect(t.b.kind === "split" && t.b.ratio).toBe(0.8);
  });

  it("叶子节点与非法下标安全无操作；比例收敛到合法区间", () => {
    const t = nested();
    updateRatio(t, [0, 1, 2], 0.7); // 指向叶子 → 无操作
    expect(t.ratio).toBe(0.5);
    updateRatio(t, [], 5); // 越界值收敛
    expect(t.ratio).toBeLessThanOrEqual(0.95);
    expect(t.ratio).toBeGreaterThanOrEqual(0.05);
  });
});

describe("B71 最大化 / 还原面板（只改比例，不动结构）", () => {
  // 用户：VS Code 的面板还能最大化/还原，LitePad 没有。
  // 取舍：不新增「隐藏面板」的渲染分支 —— 最大化只是把「根 → 该叶子」路径上
  // 每一层的比例推到 0/1，面板、标签、编辑器实例全都留着（另一侧渲染成 0 宽）。
  // 这样拖分隔条、保存会话、序列化都仍然只认识 ratio 一种状态。
  const sample = (): LayoutNode => ({
    kind: "split",
    dir: "h",
    ratio: 0.4,
    a: leaf(1),
    b: { kind: "split", dir: "v", ratio: 0.7, a: leaf(2), b: leaf(3) },
  });

  const shape = (n: LayoutNode): string =>
    n.kind === "leaf"
      ? "leaf:" + n.panelId
      : "split:" + n.dir + "(" + shape(n.a) + "," + shape(n.b) + ")";

  it("pathToPanel 给出根到叶子的下标序列；不存在时为 null", () => {
    expect(pathToPanel(leaf(1), 1)).toEqual([]);
    expect(pathToPanel(sample(), 1)).toEqual([0]);
    expect(pathToPanel(sample(), 2)).toEqual([1, 0]);
    expect(pathToPanel(sample(), 3)).toEqual([1, 1]);
    expect(pathToPanel(sample(), 99)).toBeNull();
  });

  it("最大化 = 沿路径把比例推到 0/1（A 侧占 1，B 侧占 0）", () => {
    const t = sample();
    const snap = maximizePanel(t, 3);
    expect(snap).not.toBeNull();
    if (t.kind !== "split" || !snap) return;
    // 3 在 b 侧 → 根比例推到 0；它又在 b 的 b 侧 → 内层也推到 0
    expect(t.ratio, "根：目标在 b → 0").toBe(0);
    expect(t.b.kind === "split" && t.b.ratio, "内层：目标在 b → 0").toBe(0);
    expect(snap.path).toEqual([1, 1]);
    expect(snap.ratios, "快照记的是**原**比例").toEqual([0.4, 0.7]);
  });

  it("最大化最左侧面板时根比例推到 1", () => {
    const t = sample();
    maximizePanel(t, 1);
    expect(t.kind === "split" && t.ratio).toBe(1);
  });

  it("还原把各层比例原样写回", () => {
    const t = sample();
    const snap = maximizePanel(t, 2);
    expect(snap).not.toBeNull();
    // 2 在 b.a → 根 0、内层 1
    expect(t.kind === "split" && t.ratio).toBe(0);
    expect(t.b.kind === "split" && t.b.ratio).toBe(1);
    if (!snap) return;
    restoreRatios(t, snap);
    expect(t.kind === "split" && t.ratio).toBe(0.4);
    expect(t.b.kind === "split" && t.b.ratio).toBe(0.7);
  });

  it("唯一面板 / 不存在的面板：返回 null（调用方据此什么都不做）", () => {
    // 单叶子时路径是 []，最大化没有意义 —— 若返回非 null，UI 会进入「最大化态」
    // 却看不出任何变化，还原按钮也变得莫名其妙。
    expect(maximizePanel(leaf(1), 1)).toBeNull();
    expect(maximizePanel(sample(), 42)).toBeNull();
  });

  it("树结构在最大化前后完全一致（只有 ratio 变了）", () => {
    const t = sample();
    const before = shape(t);
    maximizePanel(t, 2);
    expect(shape(t), "面板与分割方向都不许变").toBe(before);
    expect(countLeaves(t)).toBe(3);
  });

  it("还原快照对已变化的树是容错的（路径走不通就停在原地，不写坏比例）", () => {
    const t = sample();
    const snap = maximizePanel(t, 3); // path = [1,1]
    if (!snap) return;
    // 最大化期间内层面板被关掉 → [1] 那一层塌成叶子
    const shrunk = removePanel(t, 2);
    expect(shrunk).not.toBeNull();
    if (!shrunk) return;
    expect(shrunk.kind === "split" && shrunk.ratio, "前置：仍是最大化态的 0").toBe(0);
    restoreRatios(shrunk, snap);
    expect(shrunk.kind === "split" && shrunk.ratio, "根比例仍被还原").toBe(0.4);
  });
});

describe("B71 面板操作补齐（移动标签 / 切焦点 / 右键分屏 / 最大化还原）", () => {
  // 用户：VS Code 面板支持拖拽，可能还有其他实用特性，参考下给出改进方案。
  // 落地四件事（用户勾选）：
  //   ① Move Editor into Next/Previous Group（Ctrl+Alt+←/→）
  //   ② 面板间切焦点（F6 / Shift+F6，Windows「下一窗格」的通行键位）
  //   ③ 标签右键的「左右分屏 / 上下分屏」（同时补上 splitview 首次构建时的接线）
  //   ④ 最大化 / 还原面板（Alt+Shift+↑、双击标签、面板上的还原按钮）
  const src = readFileSync("src/main.ts", "utf-8");
  const km = readFileSync("src/shell/keymap.ts", "utf-8");
  const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
  const sv = readFileSync("src/shell/splitview.ts", "utf-8");
  const css = readFileSync("src/styles/global.css", "utf-8");
  // 根因是**能力缺失**不是 bug，故这里守护的是「接线别断」——这几处一旦漏接，
  // 命令面板里看得见、按下去没反应，属于最难自查的回归。

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("五条命令必须登记进命令表（否则首选项里改不了键）", () => {
    for (const id of [
      "panel.moveTabNext",
      "panel.moveTabPrev",
      "panel.focusNext",
      "panel.focusPrev",
      "panel.toggleMaximize",
    ]) {
      expect(km, `命令表缺 ${id}`).toContain(`id: "${id}"`);
      expect(src, `runShortcut 未接线 ${id}`).toMatch(
        new RegExp(`case "${id.replace(".", "\\.")}":`),
      );
    }
    expect(km, "移动到下一面板 = Ctrl+Alt+→").toMatch(
      /id: "panel\.moveTabNext"[\s\S]{0,200}Ctrl\+Alt\+ArrowRight/,
    );
    expect(km, "切焦点 = F6 / Shift+F6").toMatch(
      /id: "panel\.focusNext"[\s\S]{0,200}keys: \["F6"\]/,
    );
    expect(km, "最大化/还原 = Alt+Shift+↑").toMatch(
      /id: "panel\.toggleMaximize"[\s\S]{0,200}Alt\+Shift\+ArrowUp/,
    );
  });

  it("只有一个面板时不得抢键（把事件还给编辑器）", () => {
    // ⚠️ 反向约束：这四条若不加 countLeaves 闸门，单面板时 F6 / Ctrl+Alt+← 会被
    // 静默吞掉。F6 在编辑器里是「跳到下一个错误/光标位置」的常见用途，吞了很难查。
    const body = fnBody("function shortcutApplies");
    expect(body, "四条命令共用一道 countLeaves > 1 闸门").toMatch(
      /case "panel\.moveTabNext":[\s\S]{0,200}countLeaves\(layout\) > 1/,
    );
  });

  it("移动 / 切焦点按叶子顺序环状取模（几何相邻在网格里没有唯一答案）", () => {
    const order = fnBody("function panelIdsInOrder");
    expect(order, "顺序必须来自分屏树的深度优先遍历").toMatch(/eachLeaf\(layout/);
    for (const fn of ["function moveActiveTabByDelta", "function focusPanelByDelta"]) {
      const body = fnBody(fn);
      // + delta + length 保证负向也回绕到末尾（两处的收尾括号不同，只取核心表达式）
      expect(body, `${fn} 必须环状取模`).toMatch(/\+ delta \+ ids\.length\) % ids\.length/);
      expect(body, `${fn} 必须少于两个面板时直接返回`).toMatch(/if \(ids\.length < 2\) return;/);
    }
  });

  it("切焦点必须走整套收尾（少一个就残留上一份文档）", () => {
    // onActivatePanel 的收尾有五项：标题 / 状态栏 / 大纲 / 查找栏目标 / 焦点。
    // 只 markActivePanel 会让标题栏、大纲、查找栏还指向上一个面板的文档。
    const body = fnBody("function focusPanelByDelta");
    for (const call of [
      "markActivePanel(next);",
      "refreshTitle();",
      "refreshStatus();",
      "updateTocDrawer();",
      "retargetFindBar();",
    ]) {
      expect(body, `focusPanelByDelta 缺 ${call}`).toContain(call);
    }
    expect(body, "焦点也要跟着过去").toMatch(/panels\.get\(next\)\?\.view\?\.focus\(\)/);
  });

  it("右键分屏是**复制**不是移动（VS Code 的 Split 是同一文档开两份）", () => {
    expect(ts, "tabstrip 回调要有 onSplitH/onSplitV").toMatch(
      /onSplitH\?: \(tabId: number\) => void;[\s\S]{0,120}onSplitV\?: \(tabId: number\) => void;/,
    );
    expect(ts, "右键菜单要挂出两个方向").toMatch(/label: "左右分屏"[\s\S]{0,200}label: "上下分屏"/);
    // 末位 copy=true：源面板只剩这一个标签时不会留下空面板
    expect(src, "左右分屏 = 水平 + copy").toMatch(
      /onSplitH: \(tabId\) => splitPanelWithTab\(p\.panelId, "h", tabId, false, true\)/,
    );
    expect(src, "上下分屏 = 垂直 + copy").toMatch(
      /onSplitV: \(tabId\) => splitPanelWithTab\(p\.panelId, "v", tabId, false, true\)/,
    );
    // splitview 首次构建标签栏时也要有这两个入口，否则「分屏后右键菜单少两项」
    expect(sv, "splitview 也要转发 onSplitTab").toMatch(
      /onSplitH: \(tabId\) => cb\.onSplitTab\?\.\(panelId, tabId, "h"\)/,
    );
  });

  it("改布局的操作必须先退出最大化（否则会留下 0 宽的怪布局）", () => {
    // 最大化时路径上全是 0/1。在这个状态下分屏/关面板/挪标签/拖分隔条，
    // 得到的都是「一半看不见」的布局，而且还原快照的路径也同时失效。
    for (const fn of [
      "function splitPanelWithTab",
      "function splitActivePanel",
      "function closePanelById",
      "function moveTabToPanel",
      "function moveTabToStrip",
    ]) {
      expect(fnBody(fn), `${fn} 缺 exitMaximize()`).toContain("exitMaximize();");
    }
    expect(src, "拖分隔条也要退出最大化").toMatch(/onRatioChange:[\s\S]{0,200}exitMaximize\(\);/);
  });

  it("最大化不进会话：0/1 的比例存下来会让下次启动只剩一块面板", () => {
    expect(src, "snapshotSession 要用未最大化的布局").toContain(
      "convertLayoutForSession(layoutForSession(), panelIndex)",
    );
    const body = fnBody("function layoutForSession");
    expect(body, "有快照时才还原副本，不能直接改当前布局").toMatch(
      /const c = cloneTree\(layout\);[\s\S]{0,80}restoreRatios\(c, maximizeSnapshot\);/,
    );
    expect(body, "没最大化时原样返回").toMatch(/return layout;/);
  });

  it("被挤掉的一侧必须真的收成 0（.layout-panel 有 min-width: 120px）", () => {
    const block = css.slice(css.indexOf(".layout-panel-collapsed"));
    const decls = cssDecls(block.slice(0, block.indexOf("}")));
    expect(decls, "min-width/min-height 必须归零").toMatch(/min-width:\s*0/);
    expect(decls, "min-height 也要归零").toMatch(/min-height:\s*0/);
    expect(decls, "不许再伸展").toMatch(/flex-grow:\s*0/);
    expect(src, "main 要标记 collapsed").toMatch(
      /collapsed: maximizedPanelId !== null && maximizedPanelId !== p\.panelId/,
    );
    expect(sv, "splitview 要挂上折叠类").toMatch(/data\.collapsed \? " layout-panel-collapsed"/);
  });

  it("最大化态必须有看得见的退路：还原按钮 + 双击标签", () => {
    // 另一侧被挤成 0，只给快捷键的话用户会以为面板丢了。
    expect(sv, "仅最大化时追加还原按钮（未最大化不占位）").toMatch(
      /if \(data\.maximized\)[\s\S]{0,300}CODICONS\.chromeRestore/,
    );
    expect(sv, "按钮文案要说明恢复比例").toContain("还原面板");
    // 双击标签：只有传了回调（多面板）才接管 —— 单面板时双击必须保持无行为
    expect(ts, "tabstrip 双击受回调门控").toMatch(
      /if \(cb\.onToggleMaximize\)[\s\S]{0,200}addEventListener\("dblclick"/,
    );
    expect(src, "仅多面板时才给双击回调").toMatch(
      /onToggleMaximize:\s*\n?\s*countLeaves\(layout\) > 1 \? \(\) => toggleMaximizePanel\(p\.panelId\) : undefined/,
    );
  });

  it("拖标签栏空白处 = 拖整组：起手判据与落点语义都锁在 splitview", () => {
    // VS Code `editorTabsControl.ts:455`：只有 `e.target === tabsContainer` 才算整组。
    // 写成「点在 strip 上就算」（用 closest 之类）会连点标签都变成整组拖拽。
    // B91-2 起起手事件是 HTML5 的 `dragstart`（.tab 是更近的 draggable，浏览器自己
    // 就把 dragstart 派给了它，不会冒泡到 strip）。
    expect(sv, "起手必须是事件目标就是容器本身").toMatch(
      /strip\.addEventListener\("dragstart"[\s\S]{0,220}?if \(e\.target !== strip\) return;/,
    );
    // 空标签栏没什么可拖的：挡掉，免得弹出一颗「0 个标签」的药丸
    expect(sv, "标签栏必须可拖（HTML5 DnD 的入口）").toMatch(/strip\.draggable = true;/);
    expect(sv, "空栏不起拖").toMatch(/if \(n === 0\) \{[\s\S]{0,90}?preventDefault\(\)/);
    // 落点提交统一走 commitTabDrop（传输层不认识 drop 语义，只把载荷与坐标交进来）
    expect(sv, "整组落点优先于单标签分支").toMatch(
      /if \(groupPanelId !== null\)[\s\S]{0,900}?onMergeGroup\?\.\(groupPanelId, panelId\)/,
    );
    expect(sv, "拖回自己 = 无操作").toMatch(/if \(groupPanelId === panelId\) return false;/);
    expect(src, "并入 = 关掉这个分屏但指定并入目标").toMatch(
      /onMergeGroup: \(srcId, targetId\) => closePanelById\(srcId, targetId\)/,
    );
    expect(src, "搬到边缘 = moveGroupToPanel").toMatch(
      /onMoveGroupToPanel: \(srcId, targetId, dir, newFirst\) =>\s*\n\s*moveGroupToPanel\(srcId, targetId, dir, newFirst\)/,
    );
    // 整组搬走后源面板必须消失（否则留下一个空面板，等于分屏数莫名 +1）
    const body = fnBody("function moveGroupToPanel");
    expect(body, "源面板清空后要摘除").toMatch(
      /src\.tabs = \[\];[\s\S]{0,400}disposePanel\(srcId\)/,
    );
    expect(body, "标签要改挂到新面板").toMatch(/t\.panelId = newId/);
  });
});

describe("焦点面板：非活动分屏降亮度（class 实时同步）", () => {
  it("焦点面板：非活动分屏的活动标签降亮度；class 必须实时同步且不重建 DOM", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, "非活动面板的活动标签要降亮度").toMatch(
      /\.layout-panel:not\(\.layout-panel-active\)\s+\.tab-active/,
    );

    const main = readFileSync("src/main.ts", "utf-8");
    const fn = main.match(/function markActivePanel\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "必须有 markActivePanel 同步 class").toBeTruthy();
    // 切面板绝不能重绘标签条：会销毁光标下的 .tab → 点标签要点两下（B33 的坑）
    expect(fn, "只切 class，不得重建标签条").not.toContain("renderTabstrip");
    expect(fn, "只切 class，不得重建布局").not.toContain("renderSplitview");
    expect(main, "onActivatePanel 必须走 markActivePanel 而不是裸赋值").toMatch(
      /markActivePanel\(panelId\);\s*\n\s*if \(!changed\)/,
    );
  });
});
