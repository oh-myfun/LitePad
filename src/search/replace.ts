/**
 * B389 · 搜索视图的**写回层**：一次「全部替换」落到两批地方。
 *
 * 为什么分两批（用户口径第三条拍定的功能）：
 *   · **正在编辑器里开着**的那份 ⇒ 只改内存快照，落盘交给它各自的保存流程。
 *     直接写盘会把用户没保存的改动整份盖掉，而且写完那一刻标签会撞上「磁盘被外部改了」
 *     ⇒ 弹冲突框。这条路径从 `find/findbar.ts` 的 allDocs 那一支搬来（悬浮条 B389 起
 *     不再读盘，也就不再需要它），**只此一份实现**。
 *   · **只在盘上**的那些 ⇒ `replace_in_files`（后端保编码、保行尾、原子写）。
 *
 * ⚠️ 查询三档必须与搜索时**同一份**（`SearchQueryState` 原样带下去）：搜到的是一套口径、
 *    替换的是另一套，用户看见的就是「明明列出来了却没换掉」。这条纪律与 Rust 侧
 *    `ReplaceItem` 带着 query + 三档同一个理由（B304 那一族「两套口径」）。
 */
import type { EditorState } from "@codemirror/state";
import { docs, panels, type Doc, type Tab } from "../core/app-state";
import { instancesOfDoc } from "../core/panels";
import { buildFindQuery, findMatches, preserveCase } from "../editor/find";
import { isDirtyVsBaseline } from "../doc-model";
import { freshTextOfDoc, renderPanelTabs } from "../tabs";
import { replaceInFiles, type ReplaceItem } from "../ipc/api";
import { refreshTitle } from "../ui";
import { openDocIdFor, type FileGroup, type ReplacePlan, type SearchQueryState } from "./store";

export interface ReplaceOutcome {
  /** 改动过的文件数（内存 + 盘两批一起算） */
  files: number;
  /** 实际替换的**处**数（一行里换两次算两处 —— 与结果树的「行」不是同一个数） */
  occurrences: number;
  /** 逐条的失败原因；一条失败不连坐别的 */
  errors: string[];
}

/** 一次替换的完整入参：查询 + 替换串（三档与搜索同源）。 */
function queryOf(q: SearchQueryState) {
  return {
    search: q.text,
    caseSensitive: q.caseSensitive,
    wholeWord: q.wholeWord,
    regexp: q.regexp,
  };
}

/**
 * 把一组改动落到某份**内存里的**文档上（全部替换与单处替换共用）。
 *
 * 优先派发给正挂在视图上的实例 —— 由 `syncDocInstances` 广播到兄弟实例并置脏；
 * 全部离屏时才直接改快照，并手动按基线判脏（B112：替换词与被替换词恰好相同时
 * 内容一字未变，不该挂上 ●）。
 */
function applyChangesToDoc(
  doc: Doc,
  insts: Tab[],
  changes: { from: number; to: number; insert: string }[],
): void {
  const visible = insts.find((t) => {
    const p = panels.get(t.panelId);
    return !!p?.view && p.viewTabId === t.tabId;
  });
  if (visible) {
    const p = panels.get(visible.panelId)!;
    p.view!.view.dispatch({ changes });
    visible.state = p.view!.view.state;
    return;
  }
  for (const t of insts) t.state = t.state.update({ changes }).state;
  if (!doc.dirty && isDirtyVsBaseline(doc, freshTextOfDoc(doc))) {
    doc.dirty = true;
    refreshTitle();
    renderPanelTabs();
  }
}

/**
 * 改**内存里开着**的那些文档。
 */
function replaceInOpenDocs(groups: FileGroup[], q: SearchQueryState): ReplaceOutcome {
  const query = buildFindQuery(queryOf(q));
  if (!query) {
    return { files: 0, occurrences: 0, errors: ["搜索内容无效（正则语法错误？）"] };
  }
  let files = 0;
  let occurrences = 0;
  const errors: string[] = [];
  for (const group of groups) {
    const doc = group.docId === null ? undefined : docs.get(group.docId);
    if (!doc) continue;
    if (doc.readonly) {
      errors.push(`${doc.name}：只读，没动`);
      continue;
    }
    const insts = instancesOfDoc(doc.tabId);
    if (insts.length === 0) continue;
    const matches = findMatches(insts[0].state, query);
    if (matches.length === 0) continue;
    // B417：「保留大小写」逐条按**命中原文**迁移（与悬浮查找栏同一个纯函数），
    // 不能整批用同一个替换串 —— 同一份文档里 "Foo" 和 "FOO" 的替换结果本就不同。
    const changes = matches.map((m) => ({
      from: m.from,
      to: m.to,
      insert: q.preserveCase
        ? preserveCase(insts[0].state.sliceDoc(m.from, m.to), q.replaceText)
        : q.replaceText,
    }));
    applyChangesToDoc(doc, insts, changes);
    files++;
    occurrences += matches.length;
  }
  return { files, occurrences, errors };
}

/** 把只在盘上的那一批交给后端（一个文件失败不影响别的）。 */
async function replaceOnDisk(groups: FileGroup[], q: SearchQueryState): Promise<ReplaceOutcome> {
  if (groups.length === 0) return { files: 0, occurrences: 0, errors: [] };
  const items: ReplaceItem[] = groups.map((g) => ({
    path: g.path,
    query: q.text,
    replacement: q.replaceText,
    caseSensitive: q.caseSensitive,
    wholeWord: q.wholeWord,
    regex: q.regexp,
    // B417：盘上那一条由 Rust 侧按同一套「迁移大小写」规则做（见 `commands/search.rs`）。
    preserveCase: q.preserveCase,
  }));
  const rep = await replaceInFiles(items);
  return { files: rep.filesChanged, occurrences: rep.occurrences, errors: rep.errors };
}

/**
 * 两批一起做完，并把结果合成一条能念的话。
 *
 * ⚠️ 分组的活儿在 `planReplace()` 那一处（确认框念的也是它）—— 这里只按那一份写，
 *    两处各分一遍就会各写各的（正开着的那一份被当成「只在盘上」整份覆盖，B389 真机照出来过）。
 * ⚠️ 盘的那一批发完**不**刷新结果树由调用方决定（要重跑一次搜索才知道现在还剩什么），
 *    这里只负责写与报 —— 视图与模型各管一层，别在这里回头改 DOM。
 */
export async function applyReplaceAll(
  plan: ReplacePlan,
  q: SearchQueryState,
): Promise<ReplaceOutcome> {
  const open = replaceInOpenDocs(plan.openDocs, q);
  const disk = await replaceOnDisk(plan.diskFiles, q);
  return {
    files: open.files + disk.files,
    occurrences: open.occurrences + disk.occurrences,
    errors: [...open.errors, ...disk.errors],
  };
}

/** 结果树里的一处命中（1 起算的字符行列，与 `SearchMatch.line/column` 同口径）。 */
export interface MatchTarget {
  line: number;
  column: number;
}

/** 行内字符列（1 起算）—— 与搜索报告 `column` 同一套算法（字符，不是 UTF-16 单元）。 */
function charColumnAt(lineText: string, offset: number): number {
  return Array.from(lineText.slice(0, offset)).length + 1;
}

/** 在状态里按行列认准那一处命中（同一行的第二处靠列号区分）。 */
function matchAtRow(
  state: EditorState,
  query: NonNullable<ReturnType<typeof buildFindQuery>>,
  target: MatchTarget,
): { from: number; to: number } | null {
  for (const m of findMatches(state, query)) {
    const info = state.doc.lineAt(m.from);
    if (info.number !== target.line) continue;
    if (charColumnAt(info.text, m.from - info.from) !== target.column) continue;
    return { from: m.from, to: m.to };
  }
  return null;
}

/**
 * B419 · 结果行那颗「替换」（VS Code `ReplaceAction`）：只换**这一处**。
 *
 * 两条路与全部替换同源：开在标签里的改内存（落盘仍走各自的保存流程）；
 * 只在盘上的交给 `replace_in_files`（带上 line/column，后端只动那一处、保编码保行尾）。
 */
export async function replaceSingleMatch(
  group: FileGroup,
  target: MatchTarget,
  q: SearchQueryState,
): Promise<ReplaceOutcome> {
  const query = buildFindQuery(queryOf(q));
  if (!query) {
    return { files: 0, occurrences: 0, errors: ["搜索内容无效（正则语法错误？）"] };
  }
  const docId = openDocIdFor(group.path);
  const doc = docId === null ? undefined : docs.get(docId);
  const insts = doc ? instancesOfDoc(doc.tabId) : [];
  if (doc && insts.length > 0) {
    if (doc.readonly) return { files: 0, occurrences: 0, errors: [`${doc.name}：只读，没动`] };
    const state = insts[0].state;
    const hit = matchAtRow(state, query, target);
    if (!hit) {
      return {
        files: 0,
        occurrences: 0,
        errors: ["那一处匹配已经不在了（文件可能刚被改过）"],
      };
    }
    const insert = q.preserveCase
      ? preserveCase(state.sliceDoc(hit.from, hit.to), q.replaceText)
      : q.replaceText;
    applyChangesToDoc(doc, insts, [{ ...hit, insert }]);
    return { files: 1, occurrences: 1, errors: [] };
  }
  const rep = await replaceInFiles([
    {
      path: group.path,
      query: q.text,
      replacement: q.replaceText,
      caseSensitive: q.caseSensitive,
      wholeWord: q.wholeWord,
      regex: q.regexp,
      preserveCase: q.preserveCase,
      line: target.line,
      column: target.column,
    },
  ]);
  return { files: rep.filesChanged, occurrences: rep.occurrences, errors: rep.errors };
}

/** 「已替换 N 处，改动 M 个文件」+ 失败那几条原样念出来（不折叠成人话，原话更可查）。 */
export function replaceOutcomeText(o: ReplaceOutcome): string {
  const head =
    o.occurrences === 0 ? "没有可替换的匹配" : `已替换 ${o.occurrences} 处，改动 ${o.files} 个文件`;
  return o.errors.length === 0
    ? head
    : `${head}；${o.errors.length} 条失败：${o.errors.join("；")}`;
}
