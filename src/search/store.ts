/**
 * B389 · 侧栏搜索视图的**模型层**：查询态、范围解析、在飞请求、结果分组、折叠态与文案。
 *
 * 一句话的职责：把「这一刻搜的是什么、搜到了什么、这句话该怎么念」算清楚，**不碰 DOM、
 * 不切标签、不写盘**。写盘与改内存都在 `src/search/replace.ts`（它才需要标签、保存链与
 * 视图派发），画与跳在 `src/search/panel.ts`。
 *
 * 三条必须在这里做对的判据：
 *
 * 1. **范围只有一处判定**（用户口径）：打开了文件夹就搜磁盘（**每根一发**递归，走
 *    `search_in_folder`），没打开就搜**已打开的文档**并说明这一点。范围是搜索结果的一部分，
 *    不是界面的一层装饰 —— 它跟着结果走，所以 `scope` 必须与 `groups` 同时写、同时进快照。
 *    B424 多根：每条结果自己带着它属于哪一根（`FileGroup.root`，不归任何一根 = null ⇒
 *    「单独打开的文件」那一节），分节只看这一格，视图不再拿路径猜。
 * 2. **在飞的那一发只认自己**（`seq`）：连打两个字各发一次搜索，旧回包后到会把上一次
 *    的结果画进这一次的屏里（口径同 `explorer/store.ts` 的作废判据）。
 * 3. **正则的闸门与实际干活的引擎同一份**：JS `new RegExp` 就是 CM6 用的那台，所以
 *    「语法错 ⇒ 不搜并标红」按它判；盘上那一发由 Rust 的 `regex` crate 干活，它若不认
 *    （`\1` 这类两边语法不同处），**错误原话**贴到计数行 —— 宁可多念一句人话，也不要
 *    把「引擎不认」演成「这一份文件里没有」。
 *
 * ⚠️ 输入即搜（VS Code `searchOnType`）的去抖是 **300ms**，与那边同一个数值；回车走
 *    `runNow()` 不等这一截。
 */
import { docs, settings } from "../core/app-state";
import { instancesOfDoc } from "../core/panels";
import { buildFindQuery, findMatches } from "../editor/find";
import { getRoots as explorerRoots, ownerOf } from "../explorer/store";
import {
  searchInFolder,
  type SearchArgs,
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
  /** 保留大小写（B417）：替换时把命中词的大小写迁移到替换串，改它不触发重搜 */
  preserveCase: boolean;
  /** 「要包含的文件」/「要排除的文件」：逗号分隔 glob，空串 = 不管 */
  include: string;
  exclude: string;
  /** B421：「使用排除设置与忽略文件」那颗键（VS Code 的 `useExcludesAndIgnoreFiles`，默认开）。
   *  关掉 = 不跳点文件/噪声目录、也不读 `.gitignore` / `.ignore`，只留用户显式写的 include/exclude。 */
  useExcludes: boolean;
  /** 只在已打开的编辑器里搜（B417，VS Code 的 `onlySearchInOpenEditors`）。
   *  打开时**不论有没有文件夹**都走内存快照那一支（未保存的改动也搜得到）。 */
  onlyOpenEditors: boolean;
  /** 「⋯」那一条展开没有（只影响界面，不影响搜索） */
  detailsOpen: boolean;
}

/** 结果树里的一层：一个文件 + 它的匹配行。 */
export interface FileGroup {
  path: string;
  /** 计数行右侧与文件行灰字用的次要路径（磁盘范围 = 相对**它自己那一根**；打开文档范围 = 完整路径） */
  rel: string;
  name: string;
  /** 一行一条（与 Rust `SearchMatch` 同形，`start` / `length` 是 `preview` 里的字符下标） */
  rows: SearchMatchRow[];
  truncated: boolean;
  /** 搜出这一屏那一刻它开在标签里 ⇒ 替换走内存那一支；null = 那一刻只在盘上。
   *  ⚠️ 这是**快照**，不是「此刻」—— 点一条命中会把那个文件开出来。要问此刻归哪一批，走 `planReplace()`。 */
  docId: number | null;
  /**
   * B424：这条结果属于**哪一根**（null = 不归任何打开的目录 ⇒ 「单独打开的文件」那一节）。
   * 搜索那一刻算好、跟着结果走 —— 之后用户加/移一根都不该把已经画出来的分节重新洗牌。
   */
  root: string | null;
}

/**
 * B424：结果树的一节 = 一个打开的目录（或「单独打开的文件」那一节）+ 它名下的文件组。
 * `root` 为 null 的那一节排在最后。
 */
export interface RootSection {
  root: string | null;
  groups: FileGroup[];
}

export type SearchScope = "folder" | "openDocs" | "openEditors";

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
  preserveCase: false,
  include: "",
  exclude: "",
  useExcludes: true,
  onlyOpenEditors: false,
  detailsOpen: false,
};

let groups: FileGroup[] = [];
let matches = 0;
let files = 0;
let limitHit = false;
let scope: SearchScope = "folder";
/** B424：搜出这一屏那一刻的那几根（**快照**，分节按它排，不跟当前的名单漂）。 */
let searchedRoots: string[] = [];
/** B424：某一根没搜成（权限、断掉的重组点…）。全失败才算 `error`，部分失败留着别的结果。 */
let rootErrors: { root: string; message: string }[] = [];
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
 * 此刻搜的是哪儿（B424：那**几**根）。盘上那一条问资源管理器缓存（`getRoots`），
 * 不是问 `settings.folder_roots`：设置里有值只说明「上次开过」，
 * 而缓存里的空表才说明「这一轮用户已经移除了」。
 */
function searchRoots(): string[] {
  return explorerRoots();
}

/** 分节判据（纯函数，给用例直接问）：按 `root` 归组，顺序 = 名单顺序，null 排最后。 */
export function sectionsOf(list: FileGroup[], roots: string[]): RootSection[] {
  const out: RootSection[] = roots.map((root) => ({
    root,
    groups: list.filter((g) => g.root === root),
  }));
  // 不归这一屏那几根的（单独打开的文件、未保存的文档）自成一节，排在最后。
  const lonely = list.filter((g) => !roots.includes(g.root ?? ""));
  if (lonely.length > 0) out.push({ root: null, groups: lonely });
  return out.filter((s) => s.groups.length > 0);
}

/** 这一屏的分节（视图只读这一份：节的顺序与归属都在模型里算好）。 */
export function sections(): RootSection[] {
  return sectionsOf(groups, searchedRoots);
}

/** 这一屏里有几根没搜成（0 = 全都搜了）。视图拿它决定要不要在说明行念一句。 */
export function rootErrorCount(): number {
  return rootErrors.length;
}

/**
 * 这一屏究竟搜过几根（视图拿它决定「要不要画节头」）。
 *
 * ⚠️ 问的是「搜过几根」而不是「剩下几节」：某一根没搜成时它那一节整个缺席，
 *    但剩下的结果仍然需要知道自己是谁家的 —— 三根并排、只有一节有货时不画头，
 *    用户看见的就是一堆不知道出自哪个文件夹的行。
 */
export function searchedRootCount(): number {
  return searchedRoots.length;
}

// ---------------------------------------------------------------- 写侧

/**
 * 改查询。
 *
 * ⚠️ 只有**影响搜索结果**的那几格（text / 三开关 / include / exclude / onlyOpenEditors）才排重搜：
 *    替换串、「保留大小写」与「⋯」开合改了也重搜，就等于用户在打字框里按一个键，侧边栏整棵树闪一次。
 */
export function setQuery(patch: Partial<SearchQueryState>): void {
  const affectsSearch =
    patch.text !== undefined ||
    patch.caseSensitive !== undefined ||
    patch.wholeWord !== undefined ||
    patch.regexp !== undefined ||
    patch.include !== undefined ||
    patch.exclude !== undefined ||
    patch.useExcludes !== undefined ||
    patch.onlyOpenEditors !== undefined;
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

/**
 * 回车 / 点搜索键：不等去抖，立刻发。在飞的定时器要一起取消，否则会跑出第二次。
 *
 * 回的是这一发的 promise：调用方里「替换完要重搜、然后把这一发的结果念出来」那一处
 * 必须等重绘跑完，否则它写进计数行的那句话会被重绘盖掉（同 tick 内没人看得见）。
 */
export function runNow(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  return run();
}

/**
 * B426：设置窗口改了「排除 / 忽略文件」之后补一发。
 *
 * 不用把新值搬进 `query`：`diskArgs` 每次都现读 `settings`，新值已经在路上了。这里
 * 只补「设置改了、结果屏还挂着旧排除集」那一格 —— 否则用户按 VS Code 的习惯以为
 * 改完立刻见效，实际要点一次搜索才变（B420 那一族「改了看不出」）。
 *
 * 没有查询文本时**不发**：`runNow()` 空文本那一路会顺手清屏 + notify，
 * 白清一次不如不叫。
 */
export function rerunAfterSettingsChange(): void {
  if (!query.text) return;
  void runNow();
}

/**
 * 清空查询与结果（关抽屉、以及「清除搜索结果」那一条）。
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
  searchedRoots = [];
  rootErrors = [];
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
    const roots = searchRoots();
    // B417：打开「仅在打开的编辑器中搜索」后，不论有没有文件夹都走内存快照那一支 ——
    // 与 VS Code 的 `onlySearchInOpenEditors` 同一口径：搜的是**编辑器里的内容**
    // （未保存的改动也算数），不是盘上那份旧字节。
    if (query.onlyOpenEditors || roots.length === 0) {
      // 同步算出来的，但一样过 `id !== seq` 那道闸 ——「在飞只认自己」不该只在异步那一支成立
      //（将来改异步不用再补）。
      const found = tag(scanOpenDocs(), roots);
      if (id !== seq) return;
      scope = query.onlyOpenEditors && roots.length > 0 ? "openEditors" : "openDocs";
      searchedRoots = roots.length > 0 ? roots : [];
      rootErrors = [];
      groups = found;
      matches = found.reduce((n, g) => n + g.rows.length, 0);
      files = found.length;
      limitHit = false;
    } else {
      // B424：**每根一发**并发扇出。Rust 那一发只认一个 `root`（它的越界守卫就按这一格算），
      // 而 include/exclude/上限每根各自生效 —— 所以 `limitHit` 是「其中某一根撞了上限」。
      const settled = await Promise.allSettled(roots.map((root) => searchInFolder(diskArgs(root))));
      if (id !== seq) return;
      applyDiskReports(roots, settled);
    }
  } catch (e: unknown) {
    if (id !== seq) return;
    // 原话进计数行 —— 但 `String(new Error("…"))` 前面挂着「Error: 」那层壳：
    // 那一层是 JS 的记账，不是给用户读的话。
    error = e instanceof Error ? e.message : String(e);
    clearResults();
  } finally {
    // 只认自己这一发：旧回包不许把新一发的「正在搜索」熄掉（那会表现成转圈忽闪忽停）
    if (id === seq) {
      running = false;
      notify();
    }
  }
}

/**
 * B426：两份 glob **叠加**成一份（设置里的先来，面板框后加；同一条只算一次）。
 * 分隔口径与 Rust `compile_globs` 一致（逗号），这里多认一个换行 —— 设置页那框是
 * 可以一行列一条的。比较大小写折叠，输出去的是用户写的那个样子。
 */
export function mergeGlobs(base: string, extra: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [base, extra]) {
    for (const part of src.split(/[,\n]/)) {
      const glob = part.trim();
      if (!glob) continue;
      const key = glob.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(glob);
    }
  }
  return out.join(", ");
}

/** 盘上那一发的参数（每根一份，只有 `root` 不同 ⇒ 各根的 glob、排除与上限都自己算一遍）。 */
function diskArgs(root: string): SearchArgs {
  return {
    root,
    query: query.text,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regex: query.regexp,
    include: query.include,
    // 面板那颗总闸关掉的正是「持久排除 + 忽略文件」（VS Code `searchView.ts:1671-1672` 的
    // `disregardIgnoreFiles` / `disregardExcludeSettings` 同一发）⇒ 关着时只剩框里的。
    exclude: mergeGlobs(query.useExcludes ? (settings?.search_exclude ?? "") : "", query.exclude),
    useExcludes: query.useExcludes,
    // 缺格（老配置）读成**开**：口径同 B392「没记过 ≠ 关着」。
    useIgnoreFiles: query.useExcludes && (settings?.search_use_ignore_files ?? true),
    maxResults: RESULT_CAP,
  };
}

/** 给每条结果标上它属于哪一根（不归任何一根 ⇒ null）。判据与资源管理器同一把尺子。 */
function tag(list: FileGroup[], roots: string[]): FileGroup[] {
  return list.map((g) => ({ ...g, root: ownerOf(g.path, roots) }));
}

function groupOf(f: SearchFileRow, root: string | null, byPath: Map<string, number>): FileGroup {
  return {
    path: f.path,
    rel: f.rel,
    name: f.name,
    rows: f.matches,
    truncated: f.truncated,
    docId: byPath.get(normPath(f.path)) ?? null,
    root,
  };
}

/** 一发的失败原因（`Promise.allSettled` 给的是 `unknown`，与 `catch` 那一支同一层剥法）。 */
function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 把**几根**的扇出结果并成一屏。
 *
 * · 某一根报错（权限挡着、断掉的重组点）⇒ 它那一节缺席，其余照旧，原因记在 `rootErrors`
 *   里由说明行念出来（「这一根没搜成」不该被演成「这里头什么都没有」）；
 * · **全都**没搜成 ⇒ 这才算一次失败，原话进计数行（与单根时代同一行为）；
 * · B424（用户「独立打开的文件单独列」）⇒ 开在标签里、又不在这几根内的那些（含没存过盘的
 *   那一份）单独成一节：盘上那几发永远搜不到它们。
 */
function applyDiskReports(roots: string[], settled: PromiseSettledResult<SearchReport>[]): void {
  scope = "folder";
  searchedRoots = [...roots];
  const byPath = openDocsByPath();
  const errs: { root: string; message: string }[] = [];
  /** 路径 → 那一节里的文件行。**嵌套的两根会把同一份文件各报一次**（父根那一发递归进子根），
   *  照单全收就是「同一份文件在结果里出现两遍、计数也跟着翻一倍」。归属一律现算 `ownerOf`
   *  ⇒ 两条算出的是**同一个** root，于是天然并成一行。 */
  const found = new Map<string, FileGroup>();
  let hit = false;
  settled.forEach((one, i) => {
    const root = roots[i];
    if (one.status === "rejected") {
      errs.push({ root, message: reasonText(one.reason) });
      return;
    }
    hit = hit || one.value.limitHit;
    for (const f of one.value.files) {
      const key = normPath(f.path);
      if (found.has(key)) continue;
      found.set(key, groupOf(f, ownerOf(f.path, roots) ?? root, byPath));
    }
  });
  rootErrors = errs;
  if (errs.length === roots.length) {
    error = errs[0]?.message ?? "搜索失败";
    clearResults();
    return;
  }
  // B424（用户「独立打开的文件单独列」）：**开着的文档**要单独成一节，但它只收
  // 「不归任何一根」的那些 —— 已在盘上那几发里出现过的路径不重复列（同一份文件在
  // 两节里各冒一次，用户读作「搜索结果里有一份假的」）。未存过盘的新文档没有路径，
  // 永远归不进任何一根 ⇒ 它正是那一节要说的东西。
  const outside = tag(scanOpenDocs(), roots).filter(
    (g) => g.root === null && !found.has(normPath(g.path)),
  );
  const list = [...found.values(), ...outside];
  groups = list;
  // 计数按**去过重之后**的这一屏算（与 `dismissFile` 同一口径）：后端那格的 `matches`
  // 是单发的账，扇出之后直接相加会把嵌套的重复算进去。
  matches = list.reduce((n, g) => n + g.rows.length, 0);
  files = list.length;
  limitHit = hit;
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

/**
 * B419：这条路径**此刻**开在哪个文档上（现场问标签表）。
 * 单处替换要用它 —— 结果树里的 `docId` 是搜索那一刻的快照，之后用户可能才把文件开出来。
 */
export function openDocIdFor(path: string): number | null {
  return openDocsByPath().get(normPath(path)) ?? null;
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
 * 两条入口都走这里：**没打开文件夹**时的兜底，以及 B417 的「仅在打开的编辑器中搜索」。
 *
 * 与盘上那一支同一形：一行一条、只留首次命中的高亮区间、预览同样裁 250 字符。
 * 差别有两处 —— 这里读的是内存快照（不读盘，未保存的改动**要**搜得到），
 * 以及**不吃 include/exclude**：这一支读的是标签列表，两行 glob 本来就是为盘上那棵树
 * 一棵几百个文件准备的；筛它等于让用户对 handful 个标签写 glob（VS Code 在
 * 仅打开编辑器那一档仍过 include/exclude，这里有意从简，别当遗漏）。
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
      // CM 的位置是 **UTF-16 单元**，后端给的 `column` / `start` / `length` 是**字符**。
      // 这里必须换算：不换算的话，一行里有 emoji 时列号会多算一格，
      // 高亮与「点过去选中」都往后偏（emoji 之后每格都差一个单元）。
      const unitStart = m.from - line.from;
      const charStart = charLen(line.text.slice(0, unitStart));
      const charSpan = charLen(line.text.slice(unitStart, m.to - line.from));
      const cut = makePreview(line.text, charStart, charSpan);
      rows.push({
        line: line.number,
        preview: cut.preview,
        start: cut.start,
        length: cut.length,
        // 与后端同一口径：整行里的字符列号（1 起），跳过去按它摆光标
        column: charStart + 1,
      });
    }
    if (rows.length === 0) continue;
    out.push({
      path: doc.path ?? "",
      rel: doc.path ?? "",
      name: doc.name,
      rows,
      truncated: false,
      docId: doc.tabId,
      // 归属由调用那一侧的 `tag()` 现算（没打开文件夹时全是 null = 「单独打开的文件」那一节）
      root: null,
    });
  }
  return out;
}

/** 一段 UTF-16 文本里有几个字符（码位）：emoji 这类代理对算一个。 */
function charLen(text: string): number {
  return Array.from(text).length;
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

/**
 * 把**一个文件**的结果从这一屏里清掉（B417，VS Code 结果树文件行的 Dismiss）。
 *
 * ⚠️ 只动这一屏：盘上一个字节不碰，也不影响下一次搜索 —— 换一次查询就是一屏新的
 *    （与折叠态同口径，`collapsed` 也一起清掉那条路径的账）。
 * ⚠️ `matches` 的口径是「匹配**行**数」（`SearchReport.matches` 同一句话），
 *    所以按 `rows.length` 重算与原来那一个数同义，不会把「一行里两次命中」算丢。
 */
export function dismissFile(path: string): void {
  const before = groups.length;
  groups = groups.filter((g) => g.path !== path);
  if (groups.length === before) return;
  collapsed.delete(path);
  matches = groups.reduce((n, g) => n + g.rows.length, 0);
  files = groups.length;
  notify();
}

/**
 * B419（用户）：清掉**一条**命中（VS Code 的 Dismiss 作用在匹配行上时同口径）。
 * 一行一条（搜索报告每行只给首个命中），所以 `line + column` 足以认准。
 * 最后一条被清掉时整个文件行跟着消失 —— 空壳文件行没有意义（VS Code 同样如此）。
 */
export function dismissMatch(path: string, line: number, column: number): void {
  let changed = false;
  groups = groups.flatMap((g) => {
    if (g.path !== path) return [g];
    const rows = g.rows.filter((r) => !(r.line === line && r.column === column));
    if (rows.length === g.rows.length) return [g];
    changed = true;
    return rows.length === 0 ? [] : [{ ...g, rows }];
  });
  if (!changed) return;
  matches = groups.reduce((n, g) => n + g.rows.length, 0);
  files = groups.length;
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
  // B419（用户）：文案统一成 VS Code 那一句（`"{0} results in {1} files"` 的中文形），
  // 不再按范围换三种说法 ——「个打开的编辑器 / 个打开的文档」那两截把一行字撑成了一句
  // 解释，而范围本来就在那颗开关和范围说明行上写着。
  const base = `在 ${files} 个文件中找到 ${matches} 个结果`;
  return limitHit ? `${base}（已达 ${RESULT_CAP} 条上限，这不是全部）` : base;
}

/**
 * 计数行此刻说的是**坏消息**吗（非法 / 后端报错 / 一条没搜着）。
 * 界面要靠它决定那一行染不染红 —— 判据留在这里，视图不拿文案再猜一遍
 * （「这句话里没有『发现』两个字」那种写法，改一次文案就悄悄失效）。
 */
export function isBadNews(): boolean {
  if (query.text && running) return false;
  return invalid || error !== "" || (!!query.text && matches === 0);
}

/** 范围说明那一截（盘上那一条不给额外话：根就在标题栏下面摆着；「仅在打开的编辑器」由那颗开关自己表达，这里只在没打开文件夹时补一句）。 */
export function scopeNote(): string {
  const notes: string[] = [];
  if (query.text && scope === "openDocs") notes.push("没有打开文件夹：只搜了已打开的文档。");
  // B421：照 VS Code 的 `useIgnoresAndExcludesDisabled` —— 关掉那颗键时计数行旁边要说一声，
  // 否则「node_modules 里的结果怎么冒出来了」会被当成 bug。
  if (query.text && scope === "folder" && !query.useExcludes) {
    notes.push("排除设置与忽略文件已关闭。");
  }
  // B424：某一根没搜成（其余照旧）⇒ 点名说哪一根、为什么。不说就是「这里头什么都没有」。
  for (const one of rootErrors) {
    notes.push(`「${baseName(one.root)}」没搜成：${one.message}`);
  }
  return notes.join(" ");
}

/** 路径最后一段（只用于把那一根念成人话；比来比去不靠它）。 */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
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
 *
 * ⚠️ 分这一刀时**现场问一遍标签表**，不信 `groups[i].docId` 那份快照：点一条命中就把那个
 *    文件开出来了（真机照出来过一次 —— 状态栏「c.ts 已在外部被修改，已自动载入最新内容」），
 *    快照还挂着 null ⇒ 它会被当成「只在盘上」那一批整份写回去，脏的那份直接撞上冲突框。
 */
export function planReplace(): ReplacePlan {
  return planOf(groups);
}

/**
 * 只给**一个文件**算替换计划（B417 结果行那颗「在文件中全部替换」）。
 * 分组口径与 `planReplace()` 共用 `planOf` —— 两份各分一遍就会各写各的（B389 那次教训）。
 */
export function planReplaceFor(path: string): ReplacePlan | null {
  const group = groups.find((g) => g.path === path);
  return group ? planOf([group]) : null;
}

function planOf(list: FileGroup[]): ReplacePlan {
  const byPath = openDocsByPath();
  const openDocs: FileGroup[] = [];
  const diskFiles: FileGroup[] = [];
  for (const g of list) {
    const id = byPath.get(normPath(g.path)) ?? null;
    if (id === null) diskFiles.push(g);
    else openDocs.push(g.docId === id ? g : { ...g, docId: id });
  }
  const lines = list.reduce((n, g) => n + g.rows.length, 0);
  return { openDocs, diskFiles, files: list.length, lines };
}
