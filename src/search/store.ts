/**
 * B389 · 侧栏搜索视图的**模型层**：查询态、范围解析、在飞请求、结果分组、折叠态与文案。
 *
 * 一句话的职责：把「这一刻搜的是什么、搜到了什么、这句话该怎么念」算清楚，**不碰 DOM、
 * 不切标签、不写盘**。写盘与改内存都在 `src/search/replace.ts`（它才需要标签、保存链与
 * 视图派发），画与跳在 `src/search/panel.ts`。
 *
 * 三条必须在这里做对的判据：
 *
 * 1. **范围只有一处判定**（用户口径）：打开了文件夹就搜磁盘（递归，走 `search_in_folder`），
 *    没打开就搜**已打开的文档**并说明这一点。范围是搜索结果的一部分，不是界面的一层
 *    装饰 —— 它跟着结果走，所以 `scope` 必须与 `groups` 同时写、同时进快照。
 * 2. **在飞的那一发只认自己**（`seq`）：连打两个字各发一次搜索，旧回包后到会把上一次
 *    的结果画进这一次的屏里（口径同 `explorer/store.ts` 的 `generation`）。
 * 3. **正则的闸门与实际干活的引擎同一份**：JS `new RegExp` 就是 CM6 用的那台，所以
 *    「语法错 ⇒ 不搜并标红」按它判；盘上那一发由 Rust 的 `regex` crate 干活，它若不认
 *    （`\1` 这类两边语法不同处），**错误原话**贴到计数行 —— 宁可多念一句人话，也不要
 *    把「引擎不认」演成「这一份文件里没有」。
 *
 * ⚠️ 输入即搜（VS Code `searchOnType`）的去抖是 **300ms**，与那边同一个数值；回车走
 *    `runNow()` 不等这一截。
 */
import { docs } from "../core/app-state";
import { instancesOfDoc } from "../core/panels";
import { buildFindQuery, findMatches } from "../editor/find";
import { getRoot as explorerRoot } from "../explorer/store";
import {
  searchInFolder,
  type SearchFileRow,
  type SearchMatchRow,
  type SearchReport,
} from "../ipc/api";

/** VS Code `search.searchOnTypeDebouncePeriod` 的默认值（毫秒）。 */
const DEBOUNCE_MS = 300;
/** 一次搜索要多少条结果（与 Rust 侧 `MAX_MATCHES` 同一数值；撞上限 ⇒ 计数行加「不是全部」）。 */
const RESULT_CAP = 2000;

export interface SearchQueryState {
  /** 搜索框里的串（空串 = 不搜） */
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** 「使用正则表达式」那一档（与 VS Code `search` 的 `*` 同一语义） */
  regexp: boolean;
  /** 替换框里的串；改它**不**触发重搜 */
  replaceText: string;
  /** 「要包含的文件」/「要排除的文件」：逗号分隔 glob，空串 = 不管 */
  include: string;
  exclude: string;
  /** 「⋯」那一条展开没有（只影响界面，不影响搜索） */
  detailsOpen: boolean;
}

/** 结果树里的一层：一个文件 + 它的匹配行。 */
export interface FileGroup {
  path: string;
  /** 计数行右侧与文件行灰字用的次要路径（磁盘范围 = 相对根；打开文档范围 = 完整路径） */
  rel: string;
  name: string;
  /** 一行一条（与 Rust `SearchMatch` 同形，`start` / `length` 是 `preview` 里的字符下标） */
  rows: SearchMatchRow[];
  truncated: boolean;
  /** 这个路径此刻在编辑器里开着 ⇒ 替换走内存那一支；null = 只在盘上 */
  docId: number | null;
}

export type SearchScope = "folder" | "openDocs";

/** 一条替换计划：两组分开，因为写回的路子完全不同（内存 vs 盘）。 */
export interface ReplacePlan {
  openDocs: FileGroup[];
  diskFiles: FileGroup[];
  files: number;
  /** 匹配**行**数（一行里出现两次也只算一行 —— 与结果树同口径） */
  lines: number;
}

const query: SearchQueryState = {
  text: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replaceText: "",
  include: "",
  exclude: "",
  detailsOpen: false,
};

let groups: FileGroup[] = [];
let matches = 0;
let files = 0;
let limitHit = false;
let scope: SearchScope = "folder";
let running = false;
/** 正则语法错（按 JS 那台引擎判）：不搜，输入框标红 */
let invalid = false;
/** 后端报错的原话（与 `invalid` 分开：那条只说正则，这一格要说任何失败） */
let error = "";
/** 折着的文件（按路径记；换一次搜索结果就清空，与 VS Code 一致 —— 折叠态属于这一屏） */
const collapsed = new Set<string>();

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

export function onSearchChange(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// ---------------------------------------------------------------- 读侧（面板只读这些）

export function getQuery(): SearchQueryState {
  return query;
}

export function getGroups(): FileGroup[] {
  return groups;
}

export function isCollapsed(path: string): boolean {
  return collapsed.has(path);
}

export function isRunning(): boolean {
  return running;
}

export function isInvalid(): boolean {
  return invalid;
}

export function getScope(): SearchScope {
  return scope;
}

/**
 * 此刻搜的是哪儿。盘上那一条问资源管理器缓存（`getRoot`），不是问 `settings.folder_root`：
 * 设置里有值只说明「上次开过」，而缓存里的空串才说明「这一轮用户已经关掉了」。
 */
function searchRoot(): string {
  return explorerRoot();
}

// ---------------------------------------------------------------- 写侧

/**
 * 改查询。
 *
 * ⚠️ 只有**影响搜索结果**的那几格（text / 三开关 / include / exclude）才排重搜：
 *    替换串与「⋯」开合改了也重搜，就等于用户在打字框里按一个键，侧边栏整棵树闪一次。
 */
export function setQuery(patch: Partial<SearchQueryState>): void {
  const affectsSearch =
    patch.text !== undefined ||
    patch.caseSensitive !== undefined ||
    patch.wholeWord !== undefined ||
    patch.regexp !== undefined ||
    patch.include !== undefined ||
    patch.exclude !== undefined;
  Object.assign(query, patch);
  if (!affectsSearch) {
    notify();
    return;
  }
  schedule();
}

/** 输入即搜：清掉上一发还没起的定时器，按空/非法/正常三条路分流。 */
function schedule(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!query.text) {
    clearResults();
    // 上一次的失败原话跟着清掉：查询都空了还挂着「搜索任务崩了」，读起来像程序又坏了
    error = "";
    notify();
    return;
  }
  if (regexpBroken()) {
    // 语法错的串发出去只会得到「后端说它不认」，白跑一趟；这边直接标红不搜（VS Code 同款）
    clearResults();
    error = "";
    invalid = true;
    notify();
    return;
  }
  invalid = false;
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, DEBOUNCE_MS);
}

/** 回车 / 点搜索键：不等去抖，立刻发。在飞的定时器要一起取消，否则会跑出第二次。 */
export function runNow(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  void run();
}

/** 取消：作废在飞的那一发与没起的定时器（VS Code 搜索进行时输入框右边那颗「取消」）。 */
export function cancel(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  seq += 1;
  running = false;
  notify();
}

/**
 * 清空查询与结果（关抽屉、以及「清除搜索」那一条）。
 *
 * ⚠️ 连 `seq` 一起加一：清屏那一刻若还有回包在飞，它到达时按旧代号被丢弃，
 *    否则「清了又自己长回来」—— 与 `explorer/store.ts` 换根作废同一族症状。
 */
export function clearAll(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  seq += 1;
  running = false;
  invalid = false;
  error = "";
  Object.assign(query, {
    text: "",
    replaceText: "",
    include: "",
    exclude: "",
    detailsOpen: false,
  });
  clearResults();
  notify();
}

function clearResults(): void {
  groups = [];
  matches = 0;
  files = 0;
  limitHit = false;
  invalid = false;
  collapsed.clear();
}

/** 真去搜一发。范围在这里分流，`scope` 与结果同时写。 */
async function run(): Promise<void> {
  if (!query.text || regexpBroken()) {
    schedule();
    return;
  }
  const id = seq + 1;
  seq = id;
  running = true;
  invalid = false;
  error = "";
  notify();
  try {
    const root = searchRoot();
    if (root) {
      const report = await searchInFolder({
        root,
        query: query.text,
        caseSensitive: query.caseSensitive,
        wholeWord: query.wholeWord,
        regex: query.regexp,
        include: query.include,
        exclude: query.exclude,
        maxResults: RESULT_CAP,
      });
      if (id !== seq) return;
      applyFolderReport(report);
    } else {
      // 没打开文件夹：搜已打开的文档。同步算出来的，但一样过 `id !== seq` 那道闸 ——
      // 「在飞只认自己」不该只在异步那一支成立（将来改异步不用再补）。
      const found = scanOpenDocs();
      if (id !== seq) return;
      scope = "openDocs";
      groups = found;
      matches = found.reduce((n, g) => n + g.rows.length, 0);
      files = found.length;
      limitHit = false;
    }
  } catch (e: unknown) {
    if (id !== seq) return;
    error = String(e);
    clearResults();
  } finally {
    // 只认自己这一发：旧回包不许把新一发的「正在搜索」熄掉（那会表现成转圈忽闪忽停）
    if (id === seq) {
      running = false;
      notify();
    }
  }
}

function applyFolderReport(report: SearchReport): void {
  scope = "folder";
  const byPath = openDocsByPath();
  groups = report.files.map((f: SearchFileRow) => ({
    path: f.path,
    rel: f.rel,
    name: f.name,
    rows: f.matches,
    truncated: f.truncated,
    docId: byPath.get(normPath(f.path)) ?? null,
  }));
  matches = report.matches;
  files = report.files.length;
  limitHit = report.limitHit;
  collapsed.clear();
}

/** 路径 → 正开着的文档 id。大小写与分隔符先折一道，否则盘上与标签里比不出来。 */
function openDocsByPath(): Map<string, number> {
  const map = new Map<string, number>();
  for (const doc of docs.values()) {
    if (doc.path) map.set(normPath(doc.path), doc.tabId);
  }
  return map;
}

/** 与 `explorer/panel.ts` 的 `normPath` 同一口径：分隔符折成 `\`、去尾、折叠大小写。 */
function normPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * 正则那台引擎（JS 的）认不认。
 *
 * ⚠️ 这里**不**复用 `buildFindQuery` 的 null：那一格还兼职「空串也算无效」，
 *    而空串在上游已经分流掉了，此处只想问语法。
 */
function regexpBroken(): boolean {
  if (!query.regexp || !query.text) return false;
  try {
    new RegExp(query.text);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- 已打开文档那一支

/** 预览裁切：与 Rust `make_preview` 同一组数值（前面还有内容就补一个省略号）。 */
const PREVIEW_CHARS = 250;
const LEADING_CONTEXT = 26;

/** 一行 → 预览文本 + 命中在预览里的字符起点与长度（口径同 `commands/search.rs` 的 `make_preview`）。 */
export function makePreview(
  line: string,
  start: number,
  length: number,
): { preview: string; start: number; length: number } {
  const chars = [...line];
  const lead = Math.max(0, start - LEADING_CONTEXT);
  const ellipsis = lead > 0;
  const room = PREVIEW_CHARS - (ellipsis ? 1 : 0);
  const take = Math.min(chars.length - lead, room);
  const text = (ellipsis ? "…" : "") + chars.slice(lead, lead + take).join("");
  if (lead + take <= start) return { preview: text, start: 0, length: 0 };
  const shown = Math.min(start - lead + (ellipsis ? 1 : 0), [...text].length);
  const len = Math.min(length, lead + take - start);
  return { preview: text, start: shown, length: len };
}

/**
 * 扫**已打开的文档**（从 `find/findbar.ts` 的 `searchOpenDocs` 搬来，改成结果树的形状）。
 *
 * 与盘上那一支同一形：一行一条、只留首次命中的高亮区间、预览同样裁 250 字符。
 * 差别有两处 —— 这里读的是内存快照（不读盘，未保存的改动**要**搜得到），
 * 以及**不吃 include/exclude**：这一支是「没打开文件夹」时的兜底，筛它等于让用户对内存
 * 里的标签写 glob，而那两格本来就是为盘上那棵树一棵几百个文件准备的。
 */
function scanOpenDocs(): FileGroup[] {
  const q = buildFindQuery({
    search: query.text,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
  });
  if (!q) return [];
  const out: FileGroup[] = [];
  for (const doc of docs.values()) {
    const inst = instancesOfDoc(doc.tabId)[0];
    if (!inst) continue;
    const state = inst.state;
    const rows: SearchMatchRow[] = [];
    let lastLine = 0;
    for (const m of findMatches(state, q)) {
      const line = state.doc.lineAt(m.from);
      // 命中按位置升序回来，同一行只留第一条 ⇒ 与后端「一条命中 = 一行」同口径
      if (line.number === lastLine) continue;
      lastLine = line.number;
      const cut = makePreview(line.text, m.from - line.from, m.to - m.from);
      rows.push({ line: line.number, preview: cut.preview, start: cut.start, length: cut.length });
    }
    if (rows.length === 0) continue;
    out.push({
      path: doc.path ?? "",
      rel: doc.path ?? "",
      name: doc.name,
      rows,
      truncated: false,
      docId: doc.tabId,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 折叠

export function toggleFile(path: string): void {
  if (collapsed.delete(path)) {
    notify();
    return;
  }
  collapsed.add(path);
  notify();
}

export function collapseAll(): void {
  for (const g of groups) collapsed.add(g.path);
  notify();
}

export function expandAll(): void {
  collapsed.clear();
  notify();
}

// ---------------------------------------------------------------- 文案

/**
 * 计数行那一句话（VS Code `"{0} results in {1} files"` 的中文形）。
 *
 * ⚠️ 只说「搜到多少」，**不**掺范围说明 —— 那一句由 `scopeNote()` 自己占一行：
 *    两处都写就等于同一句话在屏上出现两遍（口径同 B304「显示与行为两套口径」）。
 */
export function summaryMessage(): string {
  if (running) return "正在搜索…";
  if (error) return error;
  if (invalid) return "正则表达式无效";
  if (!query.text) return "";
  if (matches === 0) return "未找到结果。";
  const where = scope === "folder" ? `${files} 个文件` : `${files} 个打开的文档`;
  const base = `在 ${where}中发现 ${matches} 个结果`;
  return limitHit ? `${base}（已达 ${RESULT_CAP} 条上限，这不是全部）` : base;
}

/** 范围说明那一截（盘上那一条不给额外话：根就在标题栏下面摆着）。 */
export function scopeNote(): string {
  return query.text && scope === "openDocs" ? "没有打开文件夹：只搜了已打开的文档。" : "";
}

/** 空态（结果区那一条）。
 *
 * ⚠️ 不复读「未找到结果。」：那一句已经写在计数行上了，两处各写一遍等于同一句话在屏上
 *    出现两次（B304 那一族「显示与行为两套口径」的界面版）。这里只补计数行**没有**的：
 *    还没输入时的引导，以及没打开文件夹那一截范围说明。
 */
export function emptyMessage(): string {
  if (!query.text) return "输入要搜索的内容。";
  return scopeNote();
}

// ---------------------------------------------------------------- 替换计划

/**
 * 把当前结果分成「内存里开着的」与「只在盘上的」。
 *
 * ⚠️ 分组的理由不是好看：一个文件同时有两支会写两遍（先在标签里改、再被后端整份覆盖），
 *    而覆盖之后那份标签会变成「磁盘被外部改了」—— 用户看到的是自己刚改的东西被冲掉。
 *    正开着的**只走内存**，落盘交给它各自的保存流程。
 */
export function planReplace(): ReplacePlan {
  const openDocs: FileGroup[] = [];
  const diskFiles: FileGroup[] = [];
  for (const g of groups) (g.docId === null ? diskFiles : openDocs).push(g);
  const lines = groups.reduce((n, g) => n + g.rows.length, 0);
  return { openDocs, diskFiles, files: groups.length, lines };
}
