// 媒体预览面：直接打开图片 / 视频时，盖在编辑器那一格上的原生 DOM 面。
//
// 与 HTML 预览同一范式（见 `htmlPreview.ts`）：`.panel-host` 上挂一张旁路面，
// CSS 把 `.panel-editor` 整格藏掉。区别只在内容 —— 这里用的是 WebView2 原生的
// `<img>` / `<video>`，容器与解码都交给浏览器，没有任何查看器 / 播放器依赖。
//
// 挂与拆的出口：`markdown.ts` 的 `applyPanelMode` 管挂与显示，`tabs/lifecycle.ts`
// 在标签关闭 / 面板销毁 / 整棵布局重建前调 `disposeMediaFace(s)` 拆。
//
// ⚠️ 切到别的标签时**只隐藏不拆**：`<video>` 一旦移出文档就停播，进度也没了。
// 面按标签缓存在 `.panel-host` 里（`data-tab-id`），同面板再切回来复用同一颗节点。
// 图片的视野记在 `tab.media` 上；视频的进度与播放态也记在那里，供布局重建后接上。

import { docs, type MediaViewState, type Panel, type Tab } from "../core/app-state";
import { mediaKindOf } from "../io/media";
import { CODICONS, type CodiconName } from "../shell/codicons";
import { setTip } from "../shell/tooltip";
import { assetUrl } from "./assets";

const FACE_CLASS = "media-preview";

export const IMAGE_MIN_ZOOM = 0.05;
export const IMAGE_MAX_ZOOM = 16;

/** 适应窗口的缩放倍数：小图不放大超过 1:1（16×16 的图标铺满整格只会糊）。 */
export function fitZoom(
  naturalW: number,
  naturalH: number,
  stageW: number,
  stageH: number,
): number {
  if (naturalW <= 0 || naturalH <= 0 || stageW <= 0 || stageH <= 0) return 1;
  return Math.min(1, stageW / naturalW, stageH / naturalH);
}

/**
 * 平移夹取：某一方向图比舞台小 ⇒ 该方向必须居中（偏移 0）；
 * 比舞台大 ⇒ 最多拖到图边与舞台边对齐。
 */
export function clampPan(
  x: number,
  y: number,
  scaledW: number,
  scaledH: number,
  stageW: number,
  stageH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, (scaledW - stageW) / 2);
  const maxY = Math.max(0, (scaledH - stageH) / 2);
  const nx = Math.min(maxX, Math.max(-maxX, x));
  const ny = Math.min(maxY, Math.max(-maxY, y));
  // `-0` 会原样写进 `tab.media`，读出来与 0 不等（`Object.is`）；归一到 0
  return { x: nx === 0 ? 0 : nx, y: ny === 0 ? 0 : ny };
}

/**
 * 以舞台内某一点为锚缩放：那一点底下的像素保持在原地（滚轮缩放的手感来源）。
 *
 * `point` 是相对舞台左上角的 CSS 像素；`view.x/y` 是相对居中的偏移，
 * 所以先换到「以舞台中心为原点」的坐标系再算。
 */
export function zoomAround(
  view: MediaViewState,
  point: { x: number; y: number },
  stage: { w: number; h: number },
  natural: { w: number; h: number },
  nextZoom: number,
): MediaViewState {
  const zoom = Math.max(IMAGE_MIN_ZOOM, Math.min(IMAGE_MAX_ZOOM, nextZoom));
  const ratio = zoom / view.zoom;
  const px = point.x - stage.w / 2 - view.x;
  const py = point.y - stage.h / 2 - view.y;
  const pan = clampPan(
    view.x - px * (ratio - 1),
    view.y - py * (ratio - 1),
    natural.w * zoom,
    natural.h * zoom,
    stage.w,
    stage.h,
  );
  return { zoom, x: pan.x, y: pan.y, fit: false };
}

function humanSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 每张面自己的拆除动作（视频要停播并清 src，图片只有 ResizeObserver）。 */
const disposers = new WeakMap<HTMLElement, () => void>();

function iconButton(icon: CodiconName, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "media-btn";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = CODICONS[icon];
  setTip(btn, label);
  btn.addEventListener("click", onClick);
  return btn;
}

function textButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "media-btn media-btn-text";
  btn.textContent = text;
  btn.setAttribute("aria-label", label);
  setTip(btn, label);
  btn.addEventListener("click", onClick);
  return btn;
}

function buildToolbar(
  name: string,
  meta: string,
): { bar: HTMLElement; meta: HTMLElement; actions: HTMLElement } {
  const bar = document.createElement("div");
  bar.className = "media-toolbar";
  const title = document.createElement("span");
  title.className = "media-name";
  title.textContent = name;
  setTip(title, name);
  const metaEl = document.createElement("span");
  metaEl.className = "media-meta";
  metaEl.textContent = meta;
  const actions = document.createElement("div");
  actions.className = "media-actions";
  bar.append(title, metaEl, actions);
  return { bar, meta: metaEl, actions };
}

function showError(face: HTMLElement, name: string): void {
  const stage = face.querySelector<HTMLElement>(".media-stage");
  if (!stage || stage.querySelector(".media-error")) return;
  const box = document.createElement("div");
  box.className = "media-error";
  box.textContent = `无法预览 ${name}：当前格式或编码不受支持`;
  stage.appendChild(box);
}

function buildImageFace(tab: Tab, path: string, name: string, size: number): HTMLElement {
  const face = document.createElement("div");
  face.className = FACE_CLASS;
  face.dataset.tabId = String(tab.tabId);
  face.dataset.kind = "image";

  const sizeText = humanSize(size);
  const { bar, meta, actions } = buildToolbar(name, sizeText);
  const stage = document.createElement("div");
  stage.className = "media-stage";
  const img = document.createElement("img");
  img.className = "media-image";
  img.draggable = false;
  img.alt = name;
  stage.appendChild(img);
  face.append(bar, stage);

  let natural = { w: 0, h: 0 };
  let view: MediaViewState = tab.media ? { ...tab.media } : { zoom: 1, x: 0, y: 0, fit: true };

  const stageSize = (): { w: number; h: number } => ({
    w: stage.clientWidth,
    h: stage.clientHeight,
  });

  const apply = (): void => {
    if (!natural.w || !natural.h) return;
    const { w: sw, h: sh } = stageSize();
    if (view.fit) {
      view.zoom = fitZoom(natural.w, natural.h, sw, sh);
      view.x = 0;
      view.y = 0;
    } else {
      const pan = clampPan(view.x, view.y, natural.w * view.zoom, natural.h * view.zoom, sw, sh);
      view.x = pan.x;
      view.y = pan.y;
    }
    const tx = (sw - natural.w * view.zoom) / 2 + view.x;
    const ty = (sh - natural.h * view.zoom) / 2 + view.y;
    img.style.width = `${natural.w}px`;
    img.style.height = `${natural.h}px`;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${view.zoom})`;
    meta.textContent = [sizeText, `${natural.w} × ${natural.h}`, `${Math.round(view.zoom * 100)}%`]
      .filter(Boolean)
      .join(" · ");
    // 视野记在实例上：这张面重建时（切标签、重排分屏）原样恢复
    tab.media = { ...view };
  };

  const setZoom = (next: number): void => {
    const { w, h } = stageSize();
    view = zoomAround(view, { x: w / 2, y: h / 2 }, { w, h }, natural, next);
    apply();
  };

  const toFit = (): void => {
    view = { ...view, x: 0, y: 0, fit: true };
    apply();
  };

  actions.append(
    iconButton("zoomOut", "缩小", () => setZoom(view.zoom / 1.25)),
    iconButton("zoomIn", "放大", () => setZoom(view.zoom * 1.25)),
    iconButton("screenFull", "适应窗口", toFit),
    textButton("1:1", "实际大小", () => {
      view = { ...view, fit: false };
      setZoom(1);
    }),
  );

  // 滚轮缩放（不带 Ctrl：Ctrl+滚轮是全应用的字号缩放，见 shell/zoom.ts）
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!natural.w) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      view = zoomAround(
        view,
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        stageSize(),
        natural,
        view.zoom * factor,
      );
      apply();
    },
    { passive: false },
  );

  let drag: { id: number; x: number; y: number; ox: number; oy: number } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !natural.w) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("is-panning");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const { w, h } = stageSize();
    const pan = clampPan(
      drag.ox + (e.clientX - drag.x),
      drag.oy + (e.clientY - drag.y),
      natural.w * view.zoom,
      natural.h * view.zoom,
      w,
      h,
    );
    view = { ...view, x: pan.x, y: pan.y };
    apply();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null;
    stage.classList.remove("is-panning");
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("dblclick", () => {
    if (view.fit) {
      view = { ...view, fit: false };
      setZoom(1);
    } else {
      toFit();
    }
  });

  img.addEventListener("load", () => {
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    apply();
  });
  img.addEventListener("error", () => showError(face, name));
  img.src = assetUrl(path);

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => apply());
    observer.observe(stage);
    disposers.set(face, () => observer.disconnect());
  }
  return face;
}

function buildVideoFace(tab: Tab, path: string, name: string, size: number): HTMLElement {
  const face = document.createElement("div");
  face.className = FACE_CLASS;
  face.dataset.tabId = String(tab.tabId);
  face.dataset.kind = "video";

  const { bar } = buildToolbar(name, humanSize(size));
  const stage = document.createElement("div");
  stage.className = "media-stage media-stage-video";
  const video = document.createElement("video");
  video.className = "media-video";
  video.controls = true;
  video.preload = "metadata";
  video.addEventListener("error", () => showError(face, name));

  // 进度与播放态写回实例：布局重建（分屏 / 拖标签）会把面拆掉重挂，
  // 没有这份快照就只能从头播。切标签不走路重建（面不拆），原生进度不受影响。
  const saved = tab.media;
  let released = false;
  const remember = (): void => {
    if (released) return;
    tab.media = {
      zoom: 1,
      x: 0,
      y: 0,
      fit: true,
      time: video.currentTime,
      playing: !video.paused && !video.ended,
    };
  };
  video.addEventListener("timeupdate", remember);
  video.addEventListener("play", remember);
  video.addEventListener("pause", remember);
  video.addEventListener("loadedmetadata", () => {
    const time = saved?.time ?? 0;
    if (time > 0 && (!Number.isFinite(video.duration) || time < video.duration)) {
      video.currentTime = time;
    }
    if (saved?.playing) void video.play().catch(() => {});
  });

  stage.appendChild(video);
  face.append(bar, stage);
  video.src = assetUrl(path);

  disposers.set(face, () => {
    remember(); // 先抄进度：下一发 pause / load 会把状态改掉
    released = true;
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  return face;
}

function buildFace(tab: Tab): HTMLElement | null {
  const doc = docs.get(tab.docId);
  const path = doc?.path ?? null;
  const kind = mediaKindOf(path ?? doc?.name);
  if (!doc || !path || !kind) return null;
  return kind === "image"
    ? buildImageFace(tab, path, doc.name, doc.diskSize)
    : buildVideoFace(tab, path, doc.name, doc.diskSize);
}

function disposeFace(face: HTMLElement): void {
  const stop = disposers.get(face);
  if (stop) {
    stop();
    disposers.delete(face);
  }
  face.remove();
}

/**
 * 档位出口（`markdown.applyPanelMode` 调用）：媒体标签挂出原生面并把其余面收档。
 *
 * 判据与 HTML 面同形：`panel.viewTabId === tab.tabId` —— 接班在途时挂别人的面
 * 等于把上一份文档的图钉在这一格上。
 *
 * ⚠️ 不在显示 ≠ 销毁：这里只切 `.is-active`。切到文本标签时视频面留在 DOM 里继续播，
 * 再切回来进度原样；真正拆面的只有关闭标签 / 面板销毁 / 布局重建（见下方 dispose）。
 */
export function applyMediaFace(panel: Panel, tab: Tab | undefined): void {
  const host = panel.bodyEl;
  if (!host) return;
  const on = !!tab && tab.kind === "media" && panel.viewTabId === tab.tabId;
  host.classList.toggle("preview-kind-media", on);
  const activeId = on && tab ? String(tab.tabId) : null;
  for (const face of host.querySelectorAll<HTMLElement>(`:scope > .${FACE_CLASS}`)) {
    face.classList.toggle("is-active", face.dataset.tabId === activeId);
  }
  if (!activeId || !tab) return;
  if (host.querySelector(`:scope > .${FACE_CLASS}[data-tab-id="${activeId}"]`)) return;
  // 同文档在别的标签上也有一张面时各自独立（同图多开互不影响）
  const face = buildFace(tab);
  if (face) {
    face.classList.add("is-active");
    host.appendChild(face);
  }
}

/** 一张媒体标签离开这个面板（关闭标签）：拆掉它的面，视频停播并释放解码器。 */
export function disposeMediaFace(panel: Panel, tabId: number): void {
  const host = panel.bodyEl;
  if (!host) return;
  const face = host.querySelector<HTMLElement>(
    `:scope > .${FACE_CLASS}[data-tab-id="${String(tabId)}"]`,
  );
  if (face) disposeFace(face);
}

/** 面板销毁 / 整棵布局重建前：拆掉这一格的全部媒体面（视频不停播就会留在后台响）。 */
export function disposeMediaFaces(panel: Panel): void {
  const host = panel.bodyEl;
  if (!host) return;
  for (const face of [...host.querySelectorAll<HTMLElement>(`:scope > .${FACE_CLASS}`)]) {
    disposeFace(face);
  }
}
