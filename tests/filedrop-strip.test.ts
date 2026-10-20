// @vitest-environment jsdom
// B309-1：外部**文件**拖入也认标签条。
//
// 这之前的形状是「两套落点判定」：标签拖拽走 `previewDropAt`（先问标签条、再谈分屏），
// 文件拖入自己抄了一份只看分屏的 —— 于是把文件拖到标签条上画的是「向上分屏」，松手真的
// 分出一屏。修法是**把判定并成一份**（`spotAt` = 只判定，`previewDropAt` = 判定 + 画），
// 所以这里的断言全部对着「同一处指针，两种拖法给同一个答案」来写。
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { topLevelFnBody } from "./static";

vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));

import {
  clearDropIndicators,
  previewDropAt,
  renderSplitview,
  spotAt,
  type PanelRenderData,
  type SplitviewCallbacks,
} from "../src/shell/splitview";
import { leaf, type LayoutNode } from "../src/core/layout";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

/**
 * 左右两块面板（各 400x300），标签条各占顶部 30px；左面板两个标签（各 100 宽）。
 * 坐标都按桩出来的矩形来读，与生产同口径（`panelAt` / `stripUnder` / `stripInsertInfo`
 * 全靠 getBoundingClientRect）。
 */
function mount(): void {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.appendChild(root);
  const tree: LayoutNode = { kind: "split", dir: "h", ratio: 0.5, a: leaf(1), b: leaf(2) };
  const data = new Map<number, PanelRenderData>();
  data.set(1, {
    panelId: 1,
    active: true,
    canClose: true,
    tabs: [
      { tabId: 11, name: "a.md", dirty: false, readonly: false, active: true },
      { tabId: 12, name: "b.md", dirty: false, readonly: false, active: false },
    ],
  });
  data.set(2, { panelId: 2, active: false, canClose: true, tabs: [] });
  const cb = {
    onActivatePanel: () => {},
    onActivateTab: () => {},
    onCloseTab: () => {},
    onClosePanel: () => {},
    onRatioChange: () => {},
    onMoveTabToStrip: () => {},
    onDropTabToPanel: () => {},
    onMergeGroup: () => {},
    onMoveGroupToPanel: () => {},
    mountView: () => {},
  } as unknown as SplitviewCallbacks;
  renderSplitview(root, tree, data, cb);

  const panels = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
  const strips = Array.from(document.querySelectorAll<HTMLElement>(".panel-tabstrip"));
  panels[0].getBoundingClientRect = () => rect(0, 0, 400, 300);
  panels[1].getBoundingClientRect = () => rect(400, 0, 400, 300);
  strips[0].getBoundingClientRect = () => rect(0, 0, 400, 30);
  strips[1].getBoundingClientRect = () => rect(400, 0, 400, 30);
  strips[0].querySelectorAll<HTMLElement>(".tab").forEach((el, i) => {
    el.getBoundingClientRect = () => rect(i * 100, 3, 100, 24);
  });
}

describe("spotAt：落点判定（不画东西）", () => {
  it("指针在标签条里 ⇒ onStrip，并给出插到谁之前", () => {
    mount();
    // 标签条：两块标签各 100 宽（tab11 = 0..100，tab12 = 100..200）
    // x=130 落在 tab12 的**前半** ⇒ 插到 tab12 之前；x=260 越过最后一标签的中线 ⇒ 追加到末尾
    expect(spotAt(130, 15)).toEqual({
      panelId: 1,
      zone: "center",
      onStrip: true,
      beforeTabId: 12,
    });
    expect(spotAt(260, 15)).toEqual({
      panelId: 1,
      zone: "center",
      onStrip: true,
      beforeTabId: null,
    });
  });

  it("指针在面板内容区 ⇒ 不是 onStrip，仍按边缘/中央分档", () => {
    mount();
    // (150, 250)：纵向 250/300 落在下缘 ⇒ bottom 分屏
    const spot = spotAt(150, 250);
    expect(spot?.onStrip, "内容区不许被认成标签条").toBe(false);
    expect(spot?.zone).toBe("bottom");
    expect(spot?.beforeTabId, "不在标签条上就没有插入位置").toBeNull();
    // 中央 ⇒ center（落进该面板，不分屏）
    expect(spotAt(150, 150)?.zone).toBe("center");
  });

  it("面板之外为 null（回落到活动面板打开）", () => {
    mount();
    expect(spotAt(5, 999)).toBeNull();
  });
});

describe("previewDropAt：两种痕迹互斥", () => {
  it("标签条上画插入竖线，不画分屏预览", () => {
    mount();
    previewDropAt(130, 15);
    expect(document.querySelector(".tab-insert"), "竖线该画在标签条里").toBeTruthy();
    expect(
      document.querySelector(".split-preview.show"),
      "标签条上不该同时亮分屏预览（那是「要分屏」的假信号）",
    ).toBeNull();
  });

  it("内容区画分屏预览，并收掉上一帧的竖线", () => {
    mount();
    previewDropAt(130, 15); // 先在标签条画一条
    previewDropAt(150, 250); // 再移到内容区
    expect(
      document.querySelector(".tab-insert"),
      "拖拽过程中残留的竖线必须清掉，否则两处同时在响",
    ).toBeNull();
    const shown = document.querySelector(".split-preview.show");
    expect(shown, "内容区该亮分屏预览").toBeTruthy();
    expect(shown!.className, "预览的方位要与落点一致").toContain("zone-bottom");
  });

  it("clearDropIndicators 两种一起清（文件拖放的 drop 收尾就靠它）", () => {
    mount();
    previewDropAt(130, 15);
    previewDropAt(150, 250);
    previewDropAt(130, 15);
    clearDropIndicators();
    expect(document.querySelector(".tab-insert")).toBeNull();
    expect(document.querySelector(".split-preview.show")).toBeNull();
  });
});

describe("接线：文件拖入用的是同一份判定", () => {
  const files = readFileSync("src/io/files.ts", "utf-8");
  const main = readFileSync("src/main.ts", "utf-8");

  it("预览与落点都转调 splitview，本地不再抄第二份 zoneOf 推导", () => {
    expect(files).toMatch(/function showFileDropPreview[\s\S]{0,160}previewDropAt\(x, y\)/);
    expect(files).toMatch(/function fileDropTargetAt[\s\S]{0,160}spotAt\(x, y\)/);
    expect(
      files,
      "自己再算一遍 zoneOf 就是两套口径 —— 迟早跟标签拖拽错开（这次的症状正是它漏了标签条）",
    ).not.toContain("zoneOf");
  });

  it("落在标签条 ⇒ 插标签，且绝不分屏", () => {
    const body = files.slice(files.indexOf("async function openDroppedAt"));
    expect(
      body.indexOf("onStrip"),
      "先判标签条再判分屏：顺序倒了就走到 splitPanelWithTab 那一支",
    ).toBeLessThan(body.indexOf("splitPanelWithTab"));
    expect(body).toMatch(/if \(target\.onStrip\)[\s\S]{0,200}moveTabToStrip\(/);
  });

  it("落在标签条时不弹「插入文件路径」菜单", () => {
    // 判据本体在 `io/files.ts` 的 `landDroppedPaths` 里（B316-3 把两条拖入通道汇到同一扇门，
    // main.ts 因此只剩「取坐标 + 转调」）。两头都守：搬走了判据这一侧要红，漏了接线另一侧要红。
    const body = topLevelFnBody(files, "function landDroppedPaths");
    expect(body, "取不到 landDroppedPaths 的函数体").toBeTruthy();
    expect(body, "瞄着标签条的意图就是「在这儿开一个标签」，问一句只是挡路").toMatch(
      /!target\.onStrip[\s\S]{0,80}panelDocIsMarkdown\(target\.panelId\)/,
    );
    expect(main, "外部拖入必须转调这一扇门（自己再写一遍就是两套口径）").toContain(
      "landDroppedPaths(",
    );
  });

  it("悬停收接的清理走 clearDropIndicators（只清分屏预览会留竖线残影）", () => {
    expect(main).toMatch(
      /installFileDropTarget\(\{[\s\S]{0,240}clear:[\s\S]{0,60}clearDropIndicators\(\)/,
    );
  });
});
