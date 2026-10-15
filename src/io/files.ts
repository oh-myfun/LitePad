// 打开 / 保存 / 文件拖入（从 main.ts 拆出，解耦第十三步 / #414）。
//
// 职责：打开（doOpen / openDroppedAt）、保存（doSave / doSaveAll / saveDocCore）、
// 保存冲突与有损确认（resolveSaveConflict / confirmLossy）、实例内容重建
// （rebuildDocInstances）、文件拖入（showFileDropPreview / fileDropTargetAt /
// dropPosOf / insertDroppedPath）、面板文档形态判断（panelDocIsMarkdown）。
// 只依赖 core/* + ui + doc-model + tabs + session/session + ipc/api + editor/*，
// 对 main.ts 零反向依赖。
//
// reclaimRemoted 已随 #415 换直接 import——本模块无 DI。

import {
  activePanelId,
  docs,
  isDark,
  isWrap,
  panels,
  remotedTabs,
  tabs,
  setActivePanelId,
  setSuppressDirty,
  type Doc,
  type Tab,
} from "../core/app-state";
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
  isMdTab,
  makeDoc,
  makeInstance,
  markClean,
  markDiskVersion,
  registerDoc,
} from "../doc-model";
import { detectLanguage } from "../editor/language";
import { normalizeSizeClass, perfProfileFor } from "../editor/perf";
import { makeTabState } from "../editor/editor";
import {
  checkEncodable,
  isUnicodeEncoding,
  openFile,
  reloadFile,
  saveFile,
  type LossyChar,
  type OpenedFile,
  type SaveConflict,
} from "../ipc/api";
import type { FileDropTarget } from "../shell/filedrop";
import { clearAllDropPreviews, panelAt } from "../shell/splitview";
import { zoneOf } from "../dnd/geometry";
import { showSaveConflictDialog } from "../shell/conflictdialog";
import {
  freshTextOfDoc,
  rebuildLayout,
  renderPanelTabs,
  splitPanelWithTab,
  switchTab,
} from "../tabs";
import { LOSSY_ABORT, refreshAll, showMessage } from "../ui";
import { TEXT_FILTERS } from "./filters";
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
  const lang = detectLanguage(doc.name === "未命名" ? null : doc.name, firstLine);
  doc.langLabel = lang.label;
  // 档位必须跟着 doc 走：不传就回落 normal，大文件重载一次就把降级特性全开了
  const perf = perfProfileFor(doc.sizeClass);
  for (const inst of instancesOfDoc(doc.tabId)) {
    const head = keepCursor ? inst.state.selection.main.head : 0;
    const made = makeTabState(
      text,
      lang.extension,
      { dark: isDark, wrap: isWrap, perf },
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
      setSuppressDirty(true);
      panel.view.setState(inst.state);
      setSuppressDirty(false);
      panel.viewTabId = inst.tabId;
    }
  }
}

/** 打开文件。targetPanelId 指定落点面板（文件拖入分屏用）；返回新开/激活的 tabId。 */
async function doOpen(
  presetPath?: string,
  encoding?: string,
  targetPanelId?: number,
): Promise<number | null> {
  let target = presetPath;
  if (!target) {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: TEXT_FILTERS,
    });
    if (!picked || Array.isArray(picked)) return null;
    target = picked;
  }

  try {
    const file = await openFile(target, encoding ?? null);
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
        setActivePanelId(instPanel.panelId);
        switchTab(instPanel.panelId, inst.tabId);
        rebuildLayout();
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
    attachTabToPanel(tab, panel);
    if (panel.panelId !== activePanelId) setActivePanelId(panel.panelId);
    // 重建挂载（应用 md 视图模式 + 预览）并聚焦
    rebuildLayout();
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

// ---------------------------------------------------------------- 文件拖入（B24）

/** Tauri 拖放事件坐标是物理像素，DOM 布局用逻辑像素，按缩放比例换算。 */
function dropPosOf(p: { x: number; y: number }): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1;
  return { x: p.x / scale, y: p.y / scale };
}

/** 悬停高亮：复用标签拖拽的落点预览层，指明会落到哪个面板的哪个分区。 */
function showFileDropPreview(x: number, y: number): void {
  clearAllDropPreviews();
  const el = panelAt(x, y);
  if (!el) return;
  const preview = el.querySelector(".split-preview");
  if (preview)
    preview.className = `split-preview show zone-${zoneOf(el.getBoundingClientRect(), x, y)}`;
}

/** 指针位置 → 落点面板与分区（不在任何面板内为 null，回落到活动面板打开）。 */
function fileDropTargetAt(x: number, y: number): FileDropTarget | null {
  const el = panelAt(x, y);
  if (!el) return null;
  const id = Number(el.dataset.panelId);
  if (!Number.isFinite(id)) return null;
  return { panelId: id, zone: zoneOf(el.getBoundingClientRect(), x, y) };
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

/** 按落点打开：中央 = 落进该面板；边缘 = 在该面板旁分屏打开。 */
async function openDroppedAt(path: string, target: FileDropTarget | null): Promise<void> {
  const tabId = await doOpen(path, undefined, target?.panelId);
  if (tabId === null || !target || target.zone === "center") return;
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
  return saveDocCore(docOf(tab), tab, forceDialog);
}

/**
 * 保存指定文档（供菜单「全部保存」复用）。
 * 文本取该实例快照；若实例正显示在所属面板上则先从视图写回。
 */
async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean): Promise<boolean> {
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

    const lang = detectLanguage(saved.name, text.split("\n", 1)[0]);
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
  openDroppedAt,
  panelDocIsMarkdown,
  rebuildDocInstances,
  resolveSaveConflict,
  saveDocCore,
  showFileDropPreview,
};
