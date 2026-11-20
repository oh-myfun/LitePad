// 打开 / 保存 / 文件拖入（从 main.ts 拆出，解耦第十三步 / #414）。
//
// 职责：打开（doOpen / openDroppedAt）、保存（doSave / doSaveAll / saveDocCore）、
// 保存冲突与有损确认（resolveSaveConflict / confirmLossy）、实例内容重建
// （rebuildDocInstances）、文件拖入（showFileDropPreview / fileDropTargetAt /
// dropPosOf / insertDroppedPath / landDroppedPaths）、面板文档形态判断（panelDocIsMarkdown）。
// 落点判定**不在本模块**：与标签拖拽共用 `shell/splitview` 那一份（见下面那两个函数）。
// 只依赖 core/* + ui + doc-model + tabs + session/session + ipc/api + editor/* + diff/surface，
// 对 main.ts 零反向依赖。
//
// reclaimRemoted 已随 #415 换直接 import——本模块无 DI。

import {
  activePanelId,
  docs,
  isDark,
  isWrap,
  loanedDocIds,
  showInvisibles,
  themeFamily,
  panels,
  remotedTabs,
  tabs,
  setSuppressDirty,
  windowKind,
  type Doc,
  type Panel,
  type Tab,
} from "../core/app-state";
import { claimVisibleHere } from "../sync-scroll/wire";
import {
  activePanel,
  activeTab,
  docOf,
  getPanel,
  instancesOfDoc,
  panelOfTab,
} from "../core/panels";
import { logViewport } from "../core/viewport";
import { logger } from "../core/logger";
import {
  attachTabToPanel,
  getInstanceOnUpdate,
  isMdDoc,
  isMdTab,
  languageOfDoc,
  makeDoc,
  makeInstance,
  makeMediaDoc,
  makeMediaInstance,
  markClean,
  markDiskVersion,
  registerDoc,
} from "../doc-model";
import { normalizeSizeClass, perfProfileForDoc } from "../editor/perf";
import { makeTabState } from "../editor/editor";
import { diffSurfaceOf, refreshDiffSurfaces } from "../diff/surface";
import { freezeDiffLeftDoc } from "../diff/model";
import { disposeMediaFace } from "../preview/mediaPreview";
import {
  checkEncodable,
  closeTab as ipcCloseTab,
  isUnicodeEncoding,
  listDir,
  openFile,
  openMedia,
  reloadFile,
  saveFile,
  type LossyChar,
  type OpenedFile,
  type SaveConflict,
} from "../ipc/api";
import { previewDropAt, spotAt, clearDropIndicators, type DropSpot } from "../shell/splitview";
import { needsChoice, showFileDropChoice } from "../shell/filedrop";
import { noteOpened } from "../recents/store";
import { showSaveConflictDialog } from "../shell/conflictdialog";
import {
  applyPanelMode,
  freshTextOfDoc,
  moveTabToStrip,
  pinPreviewTab,
  rebuildLayout,
  renderPanelTabs,
  splitPanelWithTab,
  switchTab,
} from "../tabs";
import { LOSSY_ABORT, broadcastDocPresence, markActivePanel, refreshAll, showMessage } from "../ui";
import { OPEN_FILTERS, TEXT_FILTERS } from "./filters";
import { mediaKindOf, parentDirOf, siblingImagePath } from "./media";
import { reclaimRemoted } from "../multiwindow/windows";
import {
  applyDiskContent,
  discardBackupFor,
  openDiskCopyForCompare,
  scheduleSessionSave,
} from "../session/session";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------- 打开 / 保存

/**
 * 重载 / 外部刷新 / 编码切换后重建文档全部实例的编辑器状态，并刷新挂载中的视图。
 *
 * `keepCursor`：尽量把光标留在原来的字符偏移上（外部刷新时内容可能变了，
 * 所以按新长度裁剪）。**默认 false** —— 换编码重载这类场景内容已经不是原来那份，
 * 保留一个「指到别处」的光标没有意义。
 */
function rebuildDocInstances(doc: Doc, text: string, keepCursor = false): void {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang = languageOfDoc(doc, firstLine);
  doc.langLabel = lang.label;
  // 档位必须跟着 doc 走：不传就回落 normal，大文件重载一次就把降级特性全开了
  // B398/B412：Markdown 哪一档都装语言扩展（装饰面的原料），与 makeInstance 同口径
  const perf = perfProfileForDoc(doc.sizeClass, isMdDoc(doc));
  for (const inst of instancesOfDoc(doc.tabId)) {
    const head = keepCursor ? inst.state.selection.main.head : 0;
    const made = makeTabState(
      text,
      lang.extension,
      // B458：与 makeInstance 同一个基线读取口（重载后 `doc.baseline` 由 markClean 换新，
      // 这一列下一次刷新就跟着清空）。
      // 差异实例（与 `makeDiffInstance` 同口径）不挂普通编辑器那层右缘标尺：
      // 那一格由 `.diff-overview` 自己画，否则新稿栏内部会多出一条盖住正文的列。
      {
        dark: isDark,
        family: themeFamily,
        wrap: isWrap,
        invisibles: showInvisibles,
        perf,
        baseline: () => doc.baseline,
        overview: inst.kind !== "diff",
      },
      getInstanceOnUpdate(),
    );
    inst.state = made.state;
    inst.comps = made.comps;
    if (keepCursor && head > 0) {
      const pos = Math.min(head, inst.state.doc.length);
      inst.state = inst.state.update({ selection: { anchor: pos } }).state;
    }
    const panel = panels.get(inst.panelId);
    if (panel?.view && panel.viewTabId === inst.tabId) {
      // 同步滚动 v1：重载把整份内容 setState 进去，CM6 会归零重排 —— 那几下不是用户滚的。
      // 不上锁：写完**同栈**把「它就停在这儿也是我造成的」登记进账本，迟到的那发 scroll
      // 会被认领吞掉而不是广播给同 docId 的其它视口。
      setSuppressDirty(true);
      panel.view.setState(inst.state);
      setSuppressDirty(false);
      panel.viewTabId = inst.tabId;
      // B397-1 · 换 state 之后必须把「这一格现在露哪一面、开哪一档」重新落一遍：
      // `makeTabState` 建出来的两份 compartment 都从**空**起步，重载不换面板、没人再走
      // `applyPanelMode`，装饰那一臂就悄悄退回源码档（预览格一片裸文本）。派生那一臂也顺带
      // 拿到重渲染（`setState` 不派发 update，预览原来要等下一次击键才跟上磁盘那份）。
      // 排在 `claimVisibleHere` **之前**：换档会改内容高度，认领的必须是换完之后的位置。
      applyPanelMode(panel);
      // 「它就停在这儿也是我造成的」⇒ 认领**看得见那一侧**（隐藏侧恒 0，按它认领会连带吞掉
      // 现形后被扶到的那一发）。顺带把这份标签的位置快照认账成现实：重载换过正文之后，
      // 旧 `scrollV` 指向的行已经不是那一处了，留着它下次切标签会硬灌回一个错位置。
      const here = claimVisibleHere(panel);
      if (here !== null) inst.scrollV = here;
    }
  }
}

/** 打开选项。`preview: true` = 资源管理器单击那一路：开成可被下一次单击替换的预览标签。 */
interface OpenOptions {
  preview?: boolean;
  /** 原位接替这张标签（图片预览翻页用）：位置与固定/预览态都跟着它。 */
  replaceTabId?: number;
}

/**
 * 让出一格给新的预览标签：把面板里现有那张预览标签摘掉，返回它原来的位置。
 *
 * VS Code 的 `EditorGroupModel.doOpenPreviewEditor` 就是这个动作：同一组至多一张预览，
 * 新的一张**原位**顶替旧的一张（不是排到末尾）。
 *
 * 为什么不用 `closeTabById`：那条链会为「面板被关空」补一张未命名标签，而这里紧接着
 * 就要在同一格开新文件，补出来的标签纯属闪一下；保存确认也不需要 —— 预览标签一旦被
 * 编辑就转正（`main.ts` 的 handleUpdate），留在这里的必定是干净的。
 */
function takePreviewSlot(panel: Panel): number {
  const old = panel.tabs.map((id) => tabs.get(id)).find((t): t is Tab => !!t?.preview);
  return old ? takeTabSlot(panel, old) : -1;
}

/**
 * 把面板里的一张标签摘掉，返回它原来的位置（`-1` = 没动）。
 *
 * 预览顶替与图片翻页共用这一份摘除口径：脏文档绝不能让位 —— 编辑即转正那条路漏了的
 * 话（搜索替换 / 资源管理器改名等别的置脏入口），这里再挡一次；代价只是这次不替换，
 * 换成未保存内容被顶掉就不可接受了。
 */
function takeTabSlot(panel: Panel, old: Tab): number {
  const doc = docs.get(old.docId);
  if (doc?.dirty) return -1;
  const idx = panel.tabs.indexOf(old.tabId);
  if (idx < 0) return -1;
  if (old.kind === "media") disposeMediaFace(panel, old.tabId);
  panel.tabs = panel.tabs.filter((id) => id !== old.tabId);
  tabs.delete(old.tabId);
  if (panel.viewTabId === old.tabId) panel.viewTabId = null;
  if (panel.activeTabId === old.tabId) panel.activeTabId = panel.tabs[0] ?? -1;
  // 这份文档在本窗口不再可见 → 别的窗口据此收起同步键（与 closeTabById 同口径）。
  broadcastDocPresence();
  if (doc && instancesOfDoc(doc.tabId).length === 0) {
    // 与关闭标签同款：差异左栏若正显示这份文档，先冻成只读快照，别留一颗写不到
    // 任何地方的幽灵视图。
    if (freezeDiffLeftDoc(doc)) refreshDiffSurfaces();
    discardBackupFor(doc);
    docs.delete(doc.tabId);
    // B161 同款：Rust 文档是进程级的，这一份可能正挂在别的窗口上 —— 那种情况只摘本地，
    // 不替别人关。正常预览（单窗口）走下面那一支，不在 Rust 侧留下没人认领的文档。
    if (windowKind !== "satellite" && !loanedDocIds.has(doc.tabId)) {
      void ipcCloseTab(doc.tabId).catch((err) => {
        logger.warn("open", `关闭被替换的预览文档失败：${String(err)}`);
      });
    }
  }
  return idx;
}

/** 把刚 attach 的标签挪到预览标签留下的位置（`slot < 0` = 不挪，排到末尾）。 */
function placeTabAt(panel: Panel, tabId: number, slot: number): void {
  if (slot < 0) return;
  const at = panel.tabs.indexOf(tabId);
  if (at < 0) return;
  panel.tabs.splice(at, 1);
  panel.tabs.splice(Math.min(slot, panel.tabs.length), 0, tabId);
}

/** 打开文件。targetPanelId 指定落点面板（文件拖入分屏用）；返回新开/激活的 tabId。 */
async function doOpen(
  presetPath?: string,
  encoding?: string,
  targetPanelId?: number,
  opts?: OpenOptions,
): Promise<number | null> {
  let target = presetPath;
  if (!target) {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: OPEN_FILTERS,
    });
    if (!picked || Array.isArray(picked)) return null;
    target = picked;
  }

  // 图片 / 视频不走文本管线（`open_file` 会读全部字节并拒绝二进制）。
  // 判定只按扩展名，复用与路径归一化在 Rust 的 `open_media` 里做。
  if (mediaKindOf(target)) return openMediaTab(target, targetPanelId, opts);

  try {
    const file = await openFile(target, encoding ?? null);
    // B308：名单记的就是这一发「用户打开了这份文件」（LRU 顶到最前）。放在 `openFile`
    // 成功之后、各分支之前：取消对话框与读盘失败都不该留记录，而「复用已有标签」那一支
    // 同样是一次打开（用户明确又开了它一次）。会话恢复走 `session/rebuild` 的 `open_file`，
    // 不经这里 ⇒ 恢复不算打开（用户裁决）。
    noteOpened(file.path);
    const existingDoc = docs.get(file.tabId);

    if (file.reused && existingDoc) {
      // 已在标签中：默认切到其实例所在面板并激活（保留编辑状态）。
      //
      // ⚠️ 但**指定了落点面板、而这份文件原本并不开在那儿**时不能这么干（B131）：
      //    那样等于把用户拖到 B 区的文件硬拽回 A 区，看起来就是「拖了没反应」，
      //    而且原来那个标签会被顺手切走。这种情形改为在落点**另开一个同源实例**，
      //    原有的照旧留在原地（内容仍然实时同步，关掉一个也不影响另一个）。
      const all = instancesOfDoc(existingDoc.tabId);
      const inTarget =
        targetPanelId !== undefined ? all.find((t) => t.panelId === targetPanelId) : undefined;
      const inst = inTarget ?? all[0];
      const instPanel = inst ? panelOfTab(inst.tabId) : undefined;
      // 只有「本来就开在这个面板」或「压根没指定落点」才算复用成功
      if (inst && instPanel && (inTarget !== undefined || targetPanelId === undefined)) {
        // 双击 / 回车这类「永久打开」命中一张预览标签 ⇒ 转正，而不是另开一张
        // （VS Code 同口径：pin 已有的那个，不再多出一张同名标签）。
        if (opts?.preview !== true) pinPreviewTab(inst.tabId);
        // 只切前台标签，布局结构没变 —— 走 `switchTab` 就地换文档。以前这里还跟一发
        // `rebuildLayout()`：整棵面板树连编辑器 / 媒体面一起重建，打开一张图会把它自己
        // 的面拆了重挂（图片重新解码闪一下），别的面板里开着的图 / 播着的视频也陪着重来。
        markActivePanel(instPanel.panelId);
        switchTab(instPanel.panelId, inst.tabId);
        refreshAll();
        scheduleSessionSave();
        showMessage(`${file.name} 已在标签中打开`);
        return inst.tabId;
      }
      // B71 ④：这份文档正挂在**另一个窗口**上（本地只剩隐藏实例，panelId = -1）。
      // 直接往下走会为同一个 docId 再建一个实例 —— 隐藏那份的正文停在载荷时的样子，
      // 新建这份来自磁盘，两份共用一条 docs 记录却各说各话，正是「同源多实例」最怕的
      // 状态。所以先把它**取回**本窗口（隐藏实例在那边一直跟着远端编辑同步，内容是最新的）。
      const remoted = remotedTabs.get(existingDoc.tabId);
      if (inst && remoted !== undefined) {
        const host =
          (targetPanelId !== undefined ? getPanel(targetPanelId) : undefined)?.panelId ??
          activePanelId;
        reclaimRemoted(inst.tabId, host);
        rebuildLayout();
        refreshAll();
        scheduleSessionSave();
        showMessage(`${file.name} 已从另一个窗口取回`);
        return inst.tabId;
      }
    }

    const panel =
      (targetPanelId !== undefined ? getPanel(targetPanelId) : undefined) ??
      activePanel() ??
      [...panels.values()][0];
    if (!panel) return null;
    const doc = makeDoc(
      file.tabId,
      file.text,
      file.name,
      file.path,
      file.encoding,
      file.eol,
      file.readonly,
      normalizeSizeClass(file.sizeClass),
    );
    doc.mixedEol = file.mixedEol;
    markDiskVersion(doc, file.mtimeMs, file.size);
    registerDoc(doc);
    const tab = makeInstance(doc, panel.panelId, file.text);
    // 预览打开：同一面板至多一张预览标签，新的一张原位顶替旧的一张。
    const preview = opts?.preview === true;
    const slot = preview ? takePreviewSlot(panel) : -1;
    if (preview) tab.preview = true;
    attachTabToPanel(tab, panel);
    placeTabAt(panel, tab.tabId, slot);
    if (panel.panelId !== activePanelId) markActivePanel(panel.panelId);
    // 同上面「已在标签中」那条：加标签不改布局结构，`switchTab` 就地接班即可。
    // 新面板还没挂载时它会自己走一次全量重建（见 `switchTab` 的早退分支）。
    switchTab(panel.panelId, tab.tabId);
    refreshAll();
    getPanel(panel.panelId)?.view?.focus();
    renderPanelTabs(panel.panelId);

    showMessage(
      file.sizeHint ||
        (file.lossy
          ? `已打开 ${file.name}（部分字节无法用 ${file.encoding} 解码，建议在状态栏手动指定编码）`
          : `已打开 ${file.name}`),
      file.lossy,
    );
    logger.info(
      "open",
      `${file.name} ${file.size}B ${file.encoding}${file.lossy ? " lossy" : ""} size=${doc.sizeClass}`,
    );
    scheduleSessionSave();
    logViewport("加载 · 打开文件后", getPanel(panel.panelId) ?? undefined);
    return tab.tabId;
  } catch (err) {
    showMessage(String(err), true);
    return null;
  }
}

/**
 * 媒体文件（图片 / 视频 / 音频）的打开分支：只建元数据文档 + 旁路预览面，不读内容。
 *
 * 为什么单开这条支：`open_file` 会读全部字节并拒二进制，媒体文件过不去；
 * 而预览面用的是原生 `<img>` / `<video>` / `<audio>`，有路径就够了（见 `preview/mediaPreview`）。
 *
 * 复用口径与文本一致：同一路径已在标签中 ⇒ 激活它；指定了落点面板而它开在别处时，
 * 在落点再开一个同源实例（媒体没有正文，多实例不会分叉）。
 */
async function openMediaTab(
  path: string,
  targetPanelId?: number,
  opts?: OpenOptions,
): Promise<number | null> {
  try {
    const file = await openMedia(path);
    noteOpened(file.path);
    const existingDoc = docs.get(file.tabId);

    // 翻页（replaceTabId）要求**原位接替当前标签**：跳到已经在别处打开的同一张图，
    // 会把被翻走的那张留在原地，看起来不像换图。这种情况一律新挂一份实例（媒体多实例不分叉）。
    if (file.reused && existingDoc && opts?.replaceTabId === undefined) {
      const all = instancesOfDoc(existingDoc.tabId);
      const inTarget =
        targetPanelId !== undefined ? all.find((t) => t.panelId === targetPanelId) : undefined;
      const inst = inTarget ?? all[0];
      const instPanel = inst ? panelOfTab(inst.tabId) : undefined;
      if (inst && instPanel && (inTarget !== undefined || targetPanelId === undefined)) {
        if (opts?.preview !== true) pinPreviewTab(inst.tabId);
        // 同上：媒体标签已在面板里，只切前台 —— 别再整树重建把媒体面拆了重挂。
        markActivePanel(instPanel.panelId);
        switchTab(instPanel.panelId, inst.tabId);
        refreshAll();
        scheduleSessionSave();
        showMessage(`${file.name} 已在标签中打开`);
        return inst.tabId;
      }
    }

    const panel =
      (targetPanelId !== undefined ? getPanel(targetPanelId) : undefined) ??
      activePanel() ??
      [...panels.values()][0];
    if (!panel) return null;

    const kind = mediaKindOf(file.path) ?? "image";
    const doc = existingDoc ?? makeMediaDoc(file.tabId, file.name, file.path, kind);
    if (!existingDoc) {
      // 媒体不挂监视 ⇒ 没有回声要抑制，`diskMtimeMs` 留 0（未知）；大小给工具条显示
      doc.diskSize = file.size;
      registerDoc(doc);
    }
    const tab = makeMediaInstance(doc, panel.panelId);
    // 预览打开：与文本同一口径 —— 同一面板至多一张预览，原位顶替。
    // 翻页（replaceTabId）则原位接替**被翻走的那一张**，固定 / 预览态跟着它走。
    const replaced = opts?.replaceTabId !== undefined ? tabs.get(opts.replaceTabId) : undefined;
    const replacing = replaced && replaced.panelId === panel.panelId ? replaced : undefined;
    let preview = opts?.preview === true;
    let slot = -1;
    if (replacing) {
      preview = replacing.preview === true;
      slot = takeTabSlot(panel, replacing);
    } else if (preview) {
      slot = takePreviewSlot(panel);
    }
    if (preview) tab.preview = true;
    attachTabToPanel(tab, panel);
    placeTabAt(panel, tab.tabId, slot);
    if (panel.panelId !== activePanelId) markActivePanel(panel.panelId);
    // 加标签不改布局结构：`switchTab` 就地接管（媒体面由它里的 applyPanelMode 挂上）。
    // 以前这里 `rebuildLayout()` 会把整棵面板树重建 —— 媒体面拆掉重挂 = 图片闪一下。
    switchTab(panel.panelId, tab.tabId);
    refreshAll();
    showMessage(
      `已打开 ${file.name}（${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}预览）`,
    );
    scheduleSessionSave();
    return tab.tabId;
  } catch (err) {
    showMessage(String(err), true);
    return null;
  }
}

/**
 * 图片预览的同目录翻页：按资源管理器同一份排序找上一张 / 下一张，把当前标签**原位**
 * 换成它 —— 不新增标签，固定态 / 预览态跟着原来的标签。
 *
 * 只在图片之间走（视频 / 音频 / 目录不参与）；到边、读目录失败或当前不是图片时返回
 * `false`，调用方据此让翻页键保持禁用。
 */
export async function openSiblingImage(currentTabId: number, dir: 1 | -1): Promise<boolean> {
  const tab = tabs.get(currentTabId);
  const panel = tab ? panels.get(tab.panelId) : undefined;
  const doc = tab ? docs.get(tab.docId) : undefined;
  if (!tab || !panel || !doc?.path || tab.kind !== "media") return false;
  if (mediaKindOf(doc.path) !== "image") return false;
  const dirPath = parentDirOf(doc.path);
  if (!dirPath) return false;
  try {
    const { entries } = await listDir(dirPath);
    const next = siblingImagePath(entries, doc.path, dir);
    if (!next) return false;
    const opened = await openMediaTab(next, panel.panelId, {
      preview: tab.preview === true,
      replaceTabId: tab.tabId,
    });
    return opened !== null;
  } catch (err) {
    logger.warn("open", `切换同目录图片失败：${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------- 文件拖入（B24）

/** Tauri 拖放事件坐标是物理像素，DOM 布局用逻辑像素，按缩放比例换算。 */
function dropPosOf(p: { x: number; y: number }): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1;
  return { x: p.x / scale, y: p.y / scale };
}

/**
 * 悬停高亮：与标签拖拽**同一份落点判定**（`previewDropAt`）。
 *
 * 以前这里自己只画分屏预览，于是「文件拖到标签条上」显示的是「向上分屏」——而标签
 * 拖到同一处画的是插入竖线。两套判定迟早跟彼此错开，所以直接交出去。
 */
function showFileDropPreview(x: number, y: number): void {
  previewDropAt(x, y);
}

/** 指针位置 → 落点（面板 + 分区；落在标签条上时连带插入位置）。 */
function fileDropTargetAt(x: number, y: number): DropSpot | null {
  return spotAt(x, y);
}

/**
 * 落点面板的**活动文档**是不是 Markdown（拖放选择菜单的判据，见 `needsChoice`）。
 *
 * 拖到面板外（target 为 null）时不问：那时用户没瞄准任何文档，谈不上「插到哪儿」，
 * 直接按原来的兜底行为打开即可。
 */
function panelDocIsMarkdown(panelId: number): boolean {
  const p = panels.get(panelId);
  const t = p ? tabs.get(p.activeTabId) : undefined;
  return !!t && isMdTab(t);
}

/**
 * 按落点打开：标签条 = 在竖线那一格插新标签；中央 = 落进该面板；边缘 = 在该面板旁分屏。
 *
 * ⚠️ 标签条那一支**不改已有标签的位置**：拖进来的文件如果本来就开着，`doOpen` 只会激活
 * 它（`reused` 分支），这时按竖线去挪就等于「拖个文件把别处的标签搬走了」。判据用
 * 「开之前有没有这个实例」，不重算一遍路径归一化（那套在 Rust）。
 */
async function openDroppedAt(path: string, target: DropSpot | null): Promise<void> {
  const before = target?.onStrip ? new Set(tabs.keys()) : null;
  const tabId = await doOpen(path, undefined, target?.panelId);
  if (tabId === null || !target) return;
  if (target.onStrip) {
    if (before?.has(tabId)) return;
    moveTabToStrip(target.panelId, tabId, target.beforeTabId);
    return;
  }
  if (target.zone === "center") return;
  const dir = target.zone === "left" || target.zone === "right" ? "h" : "v";
  const newFirst = target.zone === "left" || target.zone === "top";
  splitPanelWithTab(target.panelId, dir, tabId, newFirst, false);
}

/** 「插入文件路径」：把路径文本插到当前活动编辑器光标处（无编辑器则回落为打开）。 */
function insertDroppedPath(path: string): void {
  const panel = activePanel();
  if (!panel?.view) {
    void doOpen(path);
    return;
  }
  // 「没有视图」那一支上面已经退回「直接打开文件」，这里只管正看着的这份实例。
  const view = panel.view.view;
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: path },
    selection: { anchor: pos + path.length },
    scrollIntoView: true,
  });
  panel.view.focus();
  showMessage(`已插入路径 ${path}`);
}

/**
 * 拿到路径与屏幕点之后怎么办 —— **外部拖入**（经宿主桥换回路径）与**树里拖出**（路径就在
 * `dataTransfer` 里）两条都汇到这一扇漏斗：落点、要不要问一句「打开 / 插入路径」、打开 /
 * 分屏 / 插标签，全是同一份（口径同 `showFileDropPreview`：两套迟早跟彼此错开）。
 *
 * B70 B 档：问「打开 / 插入路径」的前提是**落点是一份 Markdown**，而不是「拖进来的文件是
 * Markdown」。落在标签条上不问：那一条「插入文件路径」只对文档成立，而瞄着标签条的意图
 * 本来就是「在这儿开一个标签」，问一句只是挡路。
 */
function landDroppedPaths(paths: string[], x: number, y: number): void {
  const target = fileDropTargetAt(x, y);
  clearDropIndicators();
  const asksForPath = target !== null && !target.onStrip && panelDocIsMarkdown(target.panelId);
  if (needsChoice(paths, asksForPath)) {
    const path = paths[0];
    const name = path.split(/[\\/]/).pop() ?? path;
    showFileDropChoice(
      name,
      { x, y },
      {
        onOpen: () => void openDroppedAt(path, target),
        onInsert: () => insertDroppedPath(path),
      },
    );
    return;
  }
  for (const path of paths) void openDroppedAt(path, target);
}

async function confirmLossy(chars: LossyChar[], encoding: string): Promise<void> {
  const preview = chars
    .slice(0, 5)
    .map((c) => `第 ${c.line} 行 ${c.col} 列的 “${c.ch}”`)
    .join("、");
  const more = chars.length > 5 ? " 等 " + chars.length + " 处" : "";
  const ok = await ask(
    `有 ${chars.length} 个字符无法用 ${encoding} 表示（${preview}${more}）。\n` +
      `保存后它们会被替换为数字字符引用，且不可逆。\n\n` +
      `建议改用「UTF-8」保存。仍要继续吗？`,
    { title: "编码转换不可逆", kind: "warning" },
  );
  if (!ok) throw LOSSY_ABORT;
}

/** 保存活动标签。返回 true 表示已写入磁盘。 */
async function doSave(forceDialog: boolean): Promise<boolean> {
  const panel = activePanel();
  const tab = activeTab();
  if (!panel || !tab) return false;
  // 差异标签：焦点在左栏（B 档两侧都可编辑）时，Ctrl+S 存的是**左栏那份文档**，不是右栏。
  // A 档左栏是基线快照（`leftDocId === null`），焦点在那儿也不会改文档 ⇒ 照旧存右栏。
  const surface = diffSurfaceOf(panel);
  if (tab.kind === "diff" && surface?.focusedSide() === "original") {
    const leftDocId = surface.spec().leftDocId;
    const leftDoc = leftDocId != null ? docs.get(leftDocId) : undefined;
    const inst = leftDoc ? instancesOfDoc(leftDoc.tabId)[0] : undefined;
    if (leftDoc && inst) return saveDocCore(leftDoc, inst, forceDialog);
  }
  return saveDocCore(docOf(tab), tab, forceDialog);
}

/**
 * 保存指定文档（供菜单「全部保存」复用）。
 * 文本取该实例快照；若实例正显示在所属面板上则先从视图写回。
 */
async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean): Promise<boolean> {
  // 媒体标签没有可写正文：拦在写盘之前，否则 Ctrl+S / 另存会把空缓冲写回原图
  if (inst.kind === "media") {
    showMessage(`${doc.name} 是媒体预览，不支持保存`, true);
    return false;
  }
  const panel = panels.get(inst.panelId);
  if (panel?.view && panel.viewTabId === inst.tabId) inst.state = panel.view.view.state;

  let target = doc.path;
  if (forceDialog || !target) {
    const picked = await saveDialog({
      defaultPath: target ?? doc.name,
      filters: TEXT_FILTERS,
    });
    if (!picked) return false;
    target = picked;
  }

  const text = inst.state.doc.toString();
  try {
    if (!isUnicodeEncoding(doc.encoding)) {
      const bad = await checkEncodable(text, doc.encoding);
      if (bad.length > 0) await confirmLossy(bad, doc.encoding);
    }

    // 「已知磁盘版本」只在**原地保存**时才有意义：另存为的目标可能是另一个文件，
    // 拿旧文件的版本号去比对会凭空报冲突。
    const inPlace = !forceDialog && !!doc.path && target === doc.path;
    const hasBaseline = inPlace && doc.diskMtimeMs > 0;

    let outcome = await saveFile({
      tabId: doc.tabId,
      text,
      encoding: doc.encoding,
      eol: doc.eol,
      path: target,
      // 带基线 = 让 Rust 在写盘前比对磁盘版本，不一致就一个字节都不写
      // （VS Code 的 FILE_MODIFIED_SINCE）。没有基线（未命名 / 另存 / 备份恢复）时传 null。
      expectMtimeMs: hasBaseline ? doc.diskMtimeMs : null,
      expectSize: hasBaseline ? doc.diskSize : null,
    });

    if (outcome.kind === "conflict") {
      // 磁盘上的版本比我们知道的新 —— 此时**还没写盘**，把选择权交回用户
      if ((await resolveSaveConflict(doc, outcome.value)) !== "overwrite") return false;
      // 用户明确选了「覆盖保存」→ 跳过版本检查重存一次
      outcome = await saveFile({
        tabId: doc.tabId,
        text,
        encoding: doc.encoding,
        eol: doc.eol,
        path: target,
        force: true,
      });
    }
    if (outcome.kind !== "saved") {
      showMessage(`保存 ${doc.name} 失败`, true);
      return false;
    }
    const saved = outcome.value;

    doc.path = saved.path;
    doc.name = saved.name;
    doc.encoding = saved.encoding;
    doc.mixedEol = false;
    // 已落盘 → 这份正文（连同当前编码/行尾）就是新的基线
    markClean(doc, text);
    doc.external = false;
    // 写盘之后磁盘版本变了：记下来，否则这次保存自己激起的 file-changed 会被当成外部修改
    markDiskVersion(doc, saved.mtimeMs, saved.size);
    // 已落盘 → 副本失去意义，删掉它（否则下次启动会拿旧快照顶掉刚保存的内容）
    discardBackupFor(doc);
    scheduleSessionSave();

    const lang = languageOfDoc(doc, text.split("\n", 1)[0]);
    if (lang.label !== doc.langLabel) {
      doc.langLabel = lang.label;
      // 语言变化广播到该文档的全部实例
      for (const inst of instancesOfDoc(doc.tabId)) {
        const effect = inst.comps.lang.reconfigure(lang.extension ?? []);
        const p = panels.get(inst.panelId);
        if (p?.view && p.activeTabId === inst.tabId) {
          p.view.view.dispatch({ effects: effect });
          inst.state = p.view.view.state;
        } else {
          inst.state = inst.state.update({ effects: effect }).state;
        }
      }
    }

    refreshAll();
    showMessage(`已保存 ${saved.name}（${saved.size} 字节）`);
    logger.info("save", `${saved.name} ${saved.size}B ${saved.encoding}/${saved.eol}`);
    return true;
  } catch (err) {
    if (err === LOSSY_ABORT) {
      showMessage("已取消保存，未写入磁盘");
      return false;
    }
    showMessage(String(err), true);
    return false;
  }
}

/**
 * 保存时撞上「磁盘版本更新」：把选择权交回用户（VS Code 的 FILE_MODIFIED_SINCE）。
 *
 * ⚠️ 只在**手动保存**时调用。自动保存遇到冲突是静默跳过的（见 `scheduleAutosave`）：
 *    用户正打字时弹个模态框出来，体验上是灾难；而替他盖掉外部的新版本，数据上是灾难。
 *
 * @returns `"overwrite"` 让调用方用 force 重存一次；`"abort"` 这次不写盘。
 */
async function resolveSaveConflict(
  doc: Doc,
  conflict: SaveConflict,
): Promise<"overwrite" | "abort"> {
  // 磁盘当前内容要么给弹框显示两边字数，要么 revert / 对照时直接要用，先读一次
  let file: OpenedFile;
  try {
    file = await reloadFile(doc.tabId, doc.encoding);
  } catch {
    // 读不出来（被别的进程独占 / 刚被删）→ 不替用户决定，这次不写
    showMessage(`${doc.name} 的磁盘版本读不出来，已取消本次保存`, true);
    return "abort";
  }
  const mine = freshTextOfDoc(doc);
  if (mine === null) return "abort";

  const choice = await showSaveConflictDialog({
    name: doc.name,
    diskChars: file.text.length,
    mineChars: mine.length,
  });

  if (choice === "overwrite") return "overwrite";

  if (choice === "revert") {
    applyDiskContent(
      doc,
      file,
      file.mtimeMs || conflict.diskMtimeMs,
      file.size || conflict.diskSize,
    );
    showMessage(`已放弃你的修改，载入 ${doc.name} 的磁盘版本`);
    return "abort";
  }
  if (choice === "compare") {
    // 已知版本刷新成磁盘这份：用户已经看过对照，之后再保存就是「看过之后的有意覆盖」，
    // 不该再弹一次框（与监听器那条路径的 compare 行为保持一致）。
    markDiskVersion(doc, file.mtimeMs || conflict.diskMtimeMs, file.size || conflict.diskSize);
    await openDiskCopyForCompare(doc, file);
    return "abort";
  }
  // cancel：既没写盘也没丢改动，文档仍然脏，下次保存会再问一次
  showMessage(`已取消保存 ${doc.name}（磁盘上的新版本未被覆盖）`);
  return "abort";
}

/** 全部保存（Ctrl+Alt+S）：有路径的脏文档直接写盘；未命名文档保留，汇总提示。 */
async function doSaveAll(): Promise<void> {
  const dirty = [...docs.values()].filter((d) => d.dirty);
  if (dirty.length === 0) {
    showMessage("没有需要保存的修改");
    return;
  }
  const named = dirty.filter((d) => d.path);
  const untitled = dirty.filter((d) => !d.path);
  let ok = 0;
  const failed: string[] = [];
  for (const doc of named) {
    const inst = instancesOfDoc(doc.tabId)[0];
    if (!inst) continue;
    try {
      if (await saveDocCore(doc, inst, false)) ok++;
      else failed.push(doc.name);
    } catch (err) {
      if (err !== LOSSY_ABORT) logger.error("save-all", `fail ${doc.name}: ${String(err)}`);
      failed.push(doc.name);
    }
  }
  const parts: string[] = [];
  if (ok > 0) parts.push(`已保存 ${ok} 个文档`);
  if (untitled.length > 0) {
    parts.push(
      `${untitled.length} 个未命名文档需手动保存（${untitled.map((d) => d.name).join("、")}）`,
    );
  }
  if (failed.length > 0) parts.push(`${failed.length} 个保存失败（${failed.join("、")}）`);
  showMessage(parts.length > 0 ? parts.join("；") : "没有需要保存的修改");
}

export {
  confirmLossy,
  doOpen,
  doSave,
  doSaveAll,
  dropPosOf,
  fileDropTargetAt,
  insertDroppedPath,
  landDroppedPaths,
  openDroppedAt,
  panelDocIsMarkdown,
  rebuildDocInstances,
  resolveSaveConflict,
  saveDocCore,
  showFileDropPreview,
};
