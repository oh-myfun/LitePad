// @vitest-environment jsdom
// 媒体预览（图片 / 视频）：扩展名判定、图片视野数学、面的挂载与收档。
//
// 这一面不比其它预览面多风险，但有一条独有的判据要钉住：**同一张标签重复应用不许重建**。
// 视频重建 = 播放位置归零、暂停；而 `applyPanelMode` 会在换档、重排、聚焦等一串时机被调。
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyMediaFace, clampPan, fitZoom, zoomAround } from "../src/preview/mediaPreview";
import { mediaKindOf } from "../src/io/media";
import { makeMediaDoc, makeMediaInstance } from "../src/doc-model";
import { docs, panels, tabs, type Panel } from "../src/core/app-state";
import { sessionStore } from "../src/session/store";
import { stripLineComments, topLevelFnBody } from "./static";

let seq = 7700;

function newMediaTab(name: string, path: string, panelId = 1) {
  const kind = mediaKindOf(path);
  if (!kind) throw new Error(`不是媒体路径：${path}`);
  const doc = makeMediaDoc(seq++, name, path, kind);
  doc.diskSize = 2048;
  docs.set(doc.tabId, doc);
  const tab = makeMediaInstance(doc, panelId);
  tabs.set(tab.tabId, tab);
  return tab;
}

function newPanel(tabId: number): Panel & { bodyEl: HTMLElement } {
  const host = document.createElement("div");
  host.className = "panel-host";
  const editor = document.createElement("div");
  editor.className = "panel-editor";
  host.appendChild(editor);
  document.body.appendChild(host);
  const panel = {
    panelId: 1,
    bodyEl: host,
    activeTabId: tabId,
    viewTabId: tabId,
    tabs: [tabId],
  } as unknown as Panel & { bodyEl: HTMLElement };
  panels.set(1, panel);
  return panel;
}

beforeEach(() => {
  docs.clear();
  tabs.clear();
  panels.clear();
  document.body.innerHTML = "";
});

describe("媒体扩展名判定", () => {
  it("图片 / 视频按后缀认，大小写无关", () => {
    expect(mediaKindOf("C:\\pics\\a.PNG")).toBe("image");
    expect(mediaKindOf("C:\\pics\\b.jpeg")).toBe("image");
    expect(mediaKindOf("/home/u/c.webp")).toBe("image");
    expect(mediaKindOf("C:\\v\\clip.MP4")).toBe("video");
    expect(mediaKindOf("C:\\v\\b.webm")).toBe("video");
    expect(mediaKindOf("C:\\v\\c.mov")).toBe("video");
  });

  it("svg 仍按文本、tiff 解不了、无后缀与目录里的点都不算媒体", () => {
    expect(mediaKindOf("C:\\icons\\a.svg")).toBe(null);
    expect(mediaKindOf("C:\\pics\\a.tiff")).toBe(null);
    expect(mediaKindOf("C:\\docs\\notes.md")).toBe(null);
    expect(mediaKindOf("C:\\docs\\README")).toBe(null);
    // 目录名里的点不参与判定：最后一段没有后缀
    expect(mediaKindOf("C:\\a.b\\photo")).toBe(null);
    expect(mediaKindOf("")).toBe(null);
    expect(mediaKindOf(null)).toBe(null);
  });
});

describe("图片视野计算", () => {
  it("适应窗口只缩不放：大图按较短边缩，小图保持 1:1", () => {
    expect(fitZoom(2000, 1000, 800, 600)).toBeCloseTo(0.4);
    expect(fitZoom(100, 100, 800, 600)).toBe(1);
    // 尺寸还没量到（加载中 / 舞台折叠）时不做任何缩放
    expect(fitZoom(0, 0, 800, 600)).toBe(1);
    expect(fitZoom(2000, 1000, 0, 0)).toBe(1);
  });

  it("平移夹取：比舞台小的方向必须居中，大的方向拖到边缘对齐为止", () => {
    // 图 100×100 在 800×600 的舞台里：两个方向都居中
    expect(clampPan(30, -20, 100, 100, 800, 600)).toEqual({ x: 0, y: 0 });
    // 图 1000×800 在 800×600 的舞台里：可动范围 ±100 / ±100
    expect(clampPan(500, -500, 1000, 800, 800, 600)).toEqual({ x: 100, y: -100 });
    expect(clampPan(40, 40, 1000, 800, 800, 600)).toEqual({ x: 40, y: 40 });
  });

  it("以光标为锚缩放：光标底下的那个像素不漂", () => {
    const stage = { w: 800, h: 600 };
    const natural = { w: 2000, h: 1500 };
    const view = { zoom: 0.5, x: 0, y: 0, fit: false };
    const point = { x: 200, y: 150 };
    const imageX = (point.x - stage.w / 2 - view.x) / view.zoom;
    const imageY = (point.y - stage.h / 2 - view.y) / view.zoom;

    const next = zoomAround(view, point, stage, natural, 1);

    expect(next.zoom).toBe(1);
    expect(next.fit).toBe(false);
    expect((point.x - stage.w / 2 - next.x) / next.zoom).toBeCloseTo(imageX);
    expect((point.y - stage.h / 2 - next.y) / next.zoom).toBeCloseTo(imageY);
  });

  it("缩放倍数夹在 5%–1600% 之间", () => {
    const stage = { w: 800, h: 600 };
    const natural = { w: 2000, h: 1500 };
    const view = { zoom: 1, x: 0, y: 0, fit: false };
    expect(zoomAround(view, { x: 100, y: 100 }, stage, natural, 999).zoom).toBe(16);
    expect(zoomAround(view, { x: 100, y: 100 }, stage, natural, 0.0001).zoom).toBe(0.05);
  });
});

describe("媒体面挂载", () => {
  it("图片标签挂出原生 img，换回文本标签整张收掉", () => {
    const tab = newMediaTab("a.png", "C:\\pics\\a.png");
    const panel = newPanel(tab.tabId);

    applyMediaFace(panel, tab);

    expect(panel.bodyEl.classList.contains("preview-kind-media")).toBe(true);
    const face = panel.bodyEl.querySelector(":scope > .media-preview");
    expect(face, "媒体面必须挂在 .panel-host 的直接子层（CSS 靠这一层藏编辑器）").toBeTruthy();
    const img = face!.querySelector("img.media-image") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("C:\\pics\\a.png");
    expect(face!.querySelector(".media-name")?.textContent).toBe("a.png");

    // 换到普通标签：面与类都要收掉
    panel.viewTabId = 424242;
    panel.activeTabId = 424242;
    applyMediaFace(panel, undefined);
    expect(panel.bodyEl.classList.contains("preview-kind-media")).toBe(false);
    expect(panel.bodyEl.querySelector(".media-preview")).toBe(null);
  });

  it("同一张标签重复应用不重建 DOM（视频不被打断）", () => {
    const tab = newMediaTab("clip.mp4", "C:\\v\\clip.mp4");
    const panel = newPanel(tab.tabId);

    applyMediaFace(panel, tab);
    const first = panel.bodyEl.querySelector(".media-preview");
    applyMediaFace(panel, tab);
    const second = panel.bodyEl.querySelector(".media-preview");

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("视频标签用原生 controls（播放/进度/音量/全屏都由它自带）", () => {
    const tab = newMediaTab("clip.webm", "C:\\v\\clip.webm");
    const panel = newPanel(tab.tabId);

    applyMediaFace(panel, tab);

    const face = panel.bodyEl.querySelector(":scope > .media-preview") as HTMLElement;
    expect(face.dataset.kind).toBe("video");
    const video = face.querySelector("video.media-video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.controls).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("src")).toBe("C:\\v\\clip.webm");
  });

  it("面板当前挂的不是这张媒体标签时不挂（接班在途的防护）", () => {
    const tab = newMediaTab("a.gif", "C:\\pics\\a.gif");
    const panel = newPanel(tab.tabId);
    panel.viewTabId = 999999;

    applyMediaFace(panel, tab);

    expect(panel.bodyEl.classList.contains("preview-kind-media")).toBe(false);
    expect(panel.bodyEl.querySelector(".media-preview")).toBe(null);
  });
});

describe("媒体标签的保存闸", () => {
  it("Ctrl+S / 另存被挡在写盘之前（空缓冲不能写回原图）", () => {
    const src = stripLineComments(readFileSync("src/io/files.ts", "utf-8"));
    const save = topLevelFnBody(
      src,
      "async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean)",
    );
    expect(save, "取不到 saveDocCore").toBeTruthy();
    const gate = save.indexOf('inst.kind === "media"');
    const write = save.indexOf("saveFile({");
    expect(gate, "保存入口必须认媒体标签").toBeGreaterThan(-1);
    expect(write, "取不到真正写盘的那一步").toBeGreaterThan(-1);
    expect(gate, "闸必须在写盘之前").toBeLessThan(write);
    expect(save.slice(gate, write), "必须告诉用户为什么没保存").toContain("不支持保存");
  });
});

describe("媒体标签进会话", () => {
  it("kind 落盘成 media；恢复预取走 openMedia，不读文本", () => {
    sessionStore.reset();
    sessionStore.register(11, 900);
    sessionStore.setPanel(0, [11], 11);
    sessionStore.setTabKind(11, "media", null);
    const rec = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(rec.kind).toBe("media");
    expect(rec.diffLeftPath).toBeNull();

    const src = stripLineComments(readFileSync("src/session/rebuild.ts", "utf-8"));
    const start = src.indexOf("if (p.media)");
    expect(start, "预取必须显式认 media（否则会走 openFile 读字节）").toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf("return;", start));
    expect(branch).toContain("openMedia(");
    expect(branch, "媒体不读字节").not.toContain("openFile(");
    expect(branch, "媒体不读热退出副本").not.toContain("restoreBackup(");
  });
});
