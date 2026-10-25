//! B389 · 侧栏搜索的 IPC 层：在**打开的文件夹**里递归找命中，以及「全部替换」的磁盘写回。
//!
//! 职责边界照 `explorer.rs` 那一刀：**判定归这里，状态归前端**。本模块不认识「当前查询」，
//! 每次调用都是完整的一问一答；去抖、单飞、结果树、折叠态全是 `src/search/` 的事。
//!
//! 这一条链路 B39（2026-09-13）整块删过 —— 用户当时要的是「悬浮查找栏不要有文件夹搜索」，
//! 于是 UI 撤掉、后端不可达、连 `regex` 依赖一起清（5.98MB → 5.5MB）。B389 把它按
//! VS Code 的**搜索视图**那一形重新做进侧栏，悬浮条仍然只管当前文档。
//!
//! ⚠️ 三个刻意的选择：
//!   · **按文件编码解码，不用 `from_utf8_lossy`**：GBK / Big5 的中文笔记是这个编辑器的
//!     主场景，lossy 解码会把命中的字变成 U+FFFD ⇒ 搜不到、替换还会把原文毁成问号。
//!   · **一次调用回整棵树**（不分片、不流式）：命中上限把载荷钉死在几千行 JSON，
//!     换来的是前端不必维护「翻页 + 增量合并」那套簿记（`list_dir` 同理，见 explorer.rs）。
//!   · **只读盘，不碰已打开的文档**：内存里那份没保存的编辑比磁盘新，从磁盘读它再写回去
//!     等于把用户的改动吃掉。所以「在标签里开着」的那些文件由前端走自己的改 + 保存链，
//!     这边只接磁盘上没人管的文件（分工见 `src/search/replace.ts`）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::core::{atomic_write, codec, doc, eol};

/// 单文件字节上限：超过就当它不是「能全文搜的文本」（导出产物、数据导出、日志转存）。
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 一次最多收集多少个文件（走目录时先撞上这个，再谈匹配）。
const MAX_FILES: usize = 20_000;
/// 回给前端的匹配行总数上限。VS Code 的 `search.maxResults` 默认 20000，那边是虚拟滚动的
/// 树；我们这边一次 IPC 就要把 JSON 全序列化出来，2000 行已经够「搜到东西」了 ——
/// 超了会带 `limitHit`，前端照 VS Code 那句提示「结果集只包含所有匹配项的一部分」。
const MAX_MATCHES: usize = 2_000;
/// 单个文件最多回多少行（一个文件里搜到 500 处时，那一截展开也没法看）。
const MAX_PER_FILE: usize = 200;
/// 预览总长与「命中前留多少字符」照 VS Code：`searchTreeModel/match.ts:22,65-81`
/// （`MAX_PREVIEW_CHARS = 250`、`before = lcut(fullBefore, 26, '…')`）。
const PREVIEW_CHARS: usize = 250;
const LEADING_CONTEXT: usize = 26;

/// 一条命中 = **一行**（同一行里出现三次也只占一行，与 VS Code 的结果树同形：
/// 那边 `previewOptions.matchLines` 默认 1）。`start` / `length` 是**字符**下标
/// （不是字节），前端直接按它把预览切成「前 / 命中 / 后」三段画高亮。
///
/// ⚠️ `start` 是**预览里**的下标（预览可能被 `LEADING_CONTEXT` 裁过、补过省略号），
/// 所以它不能拿来摆光标 —— 跳过去要用 `column`：命中在**整行**里的字符列号（1 起）。
/// VS Code 那边也是两个数分开用的（渲染用裁过的预览，`rangeInFile` 用真区间）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    pub preview: String,
    pub start: u32,
    pub length: u32,
    /// 命中在原始行里的字符列号（1 起）—— 点开这一条时按它选中命中本身。
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileHit {
    /// 绝对路径：点开一条命中要拿它去开文件
    pub path: String,
    /// 相对 root 的 posix 路径（文件行右边那截灰字显示它，include/exclude 也按它匹配）
    pub rel: String,
    pub name: String,
    pub matches: Vec<SearchMatch>,
    /// 这个文件的行被 `MAX_PER_FILE` 裁过才算 true（前端在文件行挂「…」）
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReport {
    pub files: Vec<SearchFileHit>,
    /// 匹配行总数（裁过的那部分不算）
    pub matches: u32,
    /// 撞到 `MAX_MATCHES` / `MAX_FILES` 才算 true ⇒ 前端才许说「这只是子集」
    pub limit_hit: bool,
    /// 实际扫过多少个候选文件（二进制算在内 —— 它是读出来才发现是二进制的）
    pub scanned: u32,
}

// ---------------------------------------------------------------- 匹配器

/// 行匹配器：给一行文本，回**字符**下标的命中区间（空 = 未命中）。
type LineMatcher = Arc<dyn Fn(&str) -> Vec<(usize, usize)> + Send + Sync>;

/// 全词的「词字符」照 JS 的 `\w`（VS Code 那边是 ASCII `\b`）：CJK 不算词字符，
/// 所以「中文测试」里搜「测试」算命中 —— 这一点必须与 VS Code 一致，否则用户
/// 从那边带过来的习惯会失效。
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn char_at(chars: &[char], i: usize) -> Option<char> {
    chars.get(i).copied()
}

/// 全词判据：命中前后那一格不许是词字符（越界 = 行首/行尾，算边界）。
fn word_bounded(chars: &[char], start: usize, end: usize) -> bool {
    let before_ok = start == 0 || !char_at(chars, start - 1).is_some_and(is_word_char);
    let after_ok = !char_at(chars, end).is_some_and(is_word_char);
    before_ok && after_ok
}

/// 大小写折叠到单字符（只用于匹配，不回写）。`İ` 这类一字符折成两字符的
/// 边角不处理：折叠后长度变了也只影响那一格的比较，不影响下标（我们逐字符比）。
fn fold(c: char, case_sensitive: bool) -> char {
    if case_sensitive {
        return c;
    }
    c.to_lowercase().next().unwrap_or(c)
}

/// 字面量匹配（含大小写不敏感与全词），逐字符扫，直接给字符下标。
/// 不走 `regex` 转义那条路：转义写错就是把用户的查询当模式用，而字面量是默认档。
fn literal_matcher(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<LineMatcher, String> {
    let needle: Vec<char> = query.chars().map(|c| fold(c, case_sensitive)).collect();
    if needle.is_empty() {
        return Err("搜索内容为空".into());
    }
    Ok(Arc::new(move |line: &str| {
        let hay: Vec<char> = line.chars().map(|c| fold(c, case_sensitive)).collect();
        let mut out = Vec::new();
        if hay.len() < needle.len() {
            return out;
        }
        let mut i = 0usize;
        while i + needle.len() <= hay.len() {
            if hay[i..i + needle.len()] == needle[..] {
                let end = i + needle.len();
                if !whole_word || word_bounded(&hay, i, end) {
                    out.push((i, end - i));
                }
                i = end; // 不重叠：与 VS Code 的 `g` 标志同口径
            } else {
                i += 1;
            }
        }
        out
    }))
}

/// 字节区间 → 字符区间（起点 + 长度，都是**字符**）。
fn byte_to_char_range(s: &str, start: usize, len: usize) -> (usize, usize) {
    let cs = s[..start].chars().count();
    let clen = s[start..start + len].chars().count();
    (cs, clen)
}

fn regex_matcher(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<LineMatcher, String> {
    let re = Regex::new(&regex_pattern(query, case_sensitive, whole_word))
        .map_err(|e| format!("正则无效：{e}"))?;
    Ok(Arc::new(move |line: &str| {
        re.find_iter(line)
            .map(|m| byte_to_char_range(line, m.start(), m.len()))
            .collect()
    }))
}

fn build_matcher(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
) -> Result<LineMatcher, String> {
    if query.is_empty() {
        return Err("搜索内容为空".into());
    }
    if use_regex {
        regex_matcher(query, case_sensitive, whole_word)
    } else {
        literal_matcher(query, case_sensitive, whole_word)
    }
}

// ---------------------------------------------------------------- 预览

/// 把整行裁成 VS Code 那一格预览：命中前最多留 `LEADING_CONTEXT` 个字符，
/// 前面还有就补一个省略号；总长不超过 `PREVIEW_CHARS`。
/// 返回 (预览文本, 命中在预览里的字符起点, 长度)。
fn make_preview(line: &str, start: usize, length: usize) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    let lead = start.saturating_sub(LEADING_CONTEXT);
    let ellipsis = lead > 0;
    let room = PREVIEW_CHARS - usize::from(ellipsis);
    let take = chars.len().saturating_sub(lead).min(room);
    let mut text = String::with_capacity(take + 1);
    if ellipsis {
        text.push('…');
    }
    text.extend(chars[lead..lead + take].iter());
    // 命中被裁没了就别画高亮
    if lead + take <= start {
        return (text, 0, 0);
    }
    let shown = (start - lead + usize::from(ellipsis)).min(text.chars().count());
    let len = length.min(lead + take - start);
    (text, shown, len)
}

// ---------------------------------------------------------------- include / exclude

/// VS Code 的默认 `search.exclude` 那几坨 + Windows 的系统噪声（`is_system_noise`
/// 与 `explorer.rs` 同一份判据：两处各列一遍迟早错开）。
const NOISE_DIRS: [&str; 6] = [
    "node_modules",
    "target",
    "dist",
    "out",
    "bower_components",
    ".svn",
];

fn is_noise_dir(name: &str) -> bool {
    let low = name.to_lowercase();
    if NOISE_DIRS.contains(&low.as_str()) {
        return true;
    }
    // 这三坨是 Windows 的系统噪声，与 `explorer.rs` 的 `is_system_noise` 同一判据
    let up = name.to_uppercase();
    up.starts_with('$') || up.starts_with("SYSTEM VOLUME INFORMATION") || up == "SYSVOL"
}

/// 「要包含的文件 / 要排除的文件」那一格：**逗号分隔**，每段一条 glob。
/// 口径照 VS Code `queryBuilder.ts:644-673` 的可用子集：
///   · `*` 不跨 `/`，`**` 跨，`?` 单字符；
///   · 不含 `/` 的那条按**名字或任一层目录**匹配（`*.md` 命中任意层，`src` 命中 src 底下全部）；
///   · 含 `/` 的那条锚定在根上（`docs/a/**`）；结尾 `/` 视作 `/**`。
/// 不支持 `{a,b}` 花括号与 `[...]` 字符类（当作普通字面量），这是与 VS Code 的偏差。
fn split_patterns(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix("./").unwrap_or(&s).to_string())
        .collect()
}

/// glob 片段 → 正则片段（只认 `*` `**` `?`，其余全部转义）。
fn glob_body(g: &str) -> String {
    let mut out = String::new();
    let mut chars = g.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` 吃掉若干层目录；光一个 `**` 就是「任意字符（含 /）」
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        out.push_str("(?:[^/]+/)*");
                    } else {
                        out.push_str(".*");
                    }
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push_str("[^/]"),
            other => out.push_str(&regex::escape(&other.to_string())),
        }
    }
    out
}

/// 一条 glob → 一条完整正则（对 posix 相对路径与对名字各测一次，见下）。
fn compile_glob(pattern: &str) -> Result<Regex, String> {
    let p = pattern.trim_end_matches('/');
    let body = glob_body(p);
    let anchored = if p.contains('/') {
        format!("^{body}$")
    } else {
        // 名字整段命中，或它下面还有东西（`src` → `src/...`）
        format!("(?:^|.*/){body}(?:$|/.*)")
    };
    Regex::new(&anchored).map_err(|e| format!("通配无效（{pattern}）：{e}"))
}

fn compile_globs(raw: Option<&str>) -> Result<Vec<Regex>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    split_patterns(raw)
        .into_iter()
        .map(|pat| compile_glob(&pat))
        .collect()
}

/// 一条路径过 include / exclude。include 为空 = 全收；exclude 命中 = 不收。
#[derive(Debug, Default)]
struct WalkFilter {
    include: Vec<Regex>,
    exclude: Vec<Regex>,
}

impl WalkFilter {
    fn accepts(&self, rel: &str) -> bool {
        if !self.exclude.is_empty() && self.exclude.iter().any(|r| r.is_match(rel)) {
            return false;
        }
        if self.include.is_empty() {
            return true;
        }
        self.include.iter().any(|r| r.is_match(rel))
    }

    /// 目录能不能整个跳过：exclude 里凡是「`dir` 底下」的形式命中就跳。
    /// 写成 `rel + "/"` 再测一遍，`docs` 那条就能把 `docs/a/b.md` 在**进目录之前**截掉。
    fn prunes_dir(&self, rel: &str) -> bool {
        !self.exclude.is_empty()
            && (self.exclude.iter().any(|r| r.is_match(rel))
                || self.exclude.iter().any(|r| r.is_match(&format!("{rel}/"))))
    }
}

// ---------------------------------------------------------------- 走目录

fn rel_posix(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 递归收集候选文件。`budget` 是「还能收多少个文件」的余量，撞上限就停 ——
/// 与 `list_dir` 的 `MAX_ENTRIES` 同一口径：**宁可少给，不可卡住**（那边是单层，这边是整棵）。
fn collect_files(
    dir: &Path,
    root: &Path,
    filter: &WalkFilter,
    out: &mut Vec<(PathBuf, String)>,
    budget: &mut usize,
    hit_cap: &mut bool,
) {
    if *budget == 0 {
        *hit_cap = true;
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            *hit_cap = true;
            return;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() {
            if name.starts_with('.') || is_noise_dir(&name) {
                continue;
            }
            let rel = rel_posix(root, &path);
            if filter.prunes_dir(&rel) {
                continue;
            }
            collect_files(&path, root, filter, out, budget, hit_cap);
        } else if ft.is_file() {
            if name.starts_with('.') {
                // 点文件（`.gitignore` / `.env`）：资源管理器照实显示，搜索先跳过 ——
                // 那一类文件里搜「token」几乎每次都命中配置噪声。include 里点名要它才给。
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let rel = rel_posix(root, &path);
            if !filter.accepts(&rel) {
                continue;
            }
            out.push((path, rel));
            *budget -= 1;
        }
    }
}

/// 抢一个结果名额。⚠️ 不许写成 `if load()==0 {break}; fetch_sub(1)`：
/// 两个线程可以同时过 check 再各减一次，上限就被顶穿（这条在 4 线程机器上是偶发，
/// 单测跑三轮才撞上一次 —— 见 `search_honours_include_exclude_and_the_result_cap`）。
fn claim(left: &AtomicUsize) -> bool {
    let mut cur = left.load(Ordering::Relaxed);
    loop {
        if cur == 0 {
            return false;
        }
        match left.compare_exchange_weak(cur, cur - 1, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return true,
            Err(actual) => cur = actual,
        }
    }
}

/// 一个文件：解码 → 逐行匹配 → 攒出结果行。全局预算撞了就停止追加（`limit_hit` 由调用方记）。
fn search_one_file(
    path: &Path,
    rel: String,
    matcher: &LineMatcher,
    left: &AtomicUsize,
) -> Option<SearchFileHit> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() || doc::is_probably_binary(&bytes) {
        return None;
    }
    let enc = codec::detect(&bytes);
    let decoded = codec::decode(&bytes, enc);
    let text = eol::to_lf(&decoded.text);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut matches = Vec::new();
    let mut truncated = false;
    for (i, line) in text.lines().enumerate() {
        let spans = matcher(line);
        let Some((start, length)) = spans.first().copied() else {
            continue;
        };
        if matches.len() >= MAX_PER_FILE {
            truncated = true;
            break;
        }
        if !claim(left) {
            break;
        }
        let (preview, ps, pl) = make_preview(line, start, length);
        matches.push(SearchMatch {
            line: (i + 1) as u32,
            preview,
            start: ps as u32,
            length: pl as u32,
            column: (start + 1) as u32,
        });
    }
    if matches.is_empty() {
        return None;
    }
    Some(SearchFileHit {
        path: path.to_string_lossy().into_owned(),
        rel,
        name,
        matches,
        truncated,
    })
}

/// 一次搜索的完整入参（命令壳只负责把 Tauri 的散参收成一格，好让单测直接调 `search_folder`）。
#[derive(Debug, Clone)]
struct SearchRequest {
    root: PathBuf,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
    include: Option<String>,
    exclude: Option<String>,
    cap: usize,
}

/// 同步的搜索主体：校验 → 走目录 → 多线程匹配 → 按路径排序。
/// 拆出来只为可测：`spawn_blocking` 里那段没法在 `cargo test` 里直接跑。
fn search_folder(req: SearchRequest) -> Result<SearchReport, String> {
    if !req.root.is_dir() {
        return Err(format!("文件夹不存在：{:?}", req.root));
    }
    if req.query.trim().is_empty() {
        return Ok(SearchReport {
            files: Vec::new(),
            matches: 0,
            limit_hit: false,
            scanned: 0,
        });
    }
    let matcher = build_matcher(
        &req.query,
        req.case_sensitive,
        req.whole_word,
        req.use_regex,
    )?;
    let filter = WalkFilter {
        include: compile_globs(req.include.as_deref())?,
        exclude: compile_globs(req.exclude.as_deref())?,
    };
    let cap = req.cap;

    let mut budget = MAX_FILES;
    let mut file_cap_hit = false;
    let mut candidates = Vec::new();
    collect_files(
        &req.root,
        &req.root,
        &filter,
        &mut candidates,
        &mut budget,
        &mut file_cap_hit,
    );
    let scanned = candidates.len() as u32;

    let left = AtomicUsize::new(cap);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let chunk = (candidates.len() / threads).max(1);
    let hits = std::sync::Mutex::new(Vec::<SearchFileHit>::new());
    std::thread::scope(|scope| {
        for part in candidates.chunks(chunk) {
            let m = &matcher;
            let left = &left;
            let hits = &hits;
            scope.spawn(move || {
                for (path, rel) in part {
                    if let Some(hit) = search_one_file(path, rel.clone(), m, left) {
                        hits.lock().expect("搜索结果锁").push(hit);
                    }
                }
            });
        }
    });
    let mut files = hits.into_inner().unwrap_or_default();
    // 多线程回来的次序是散的，界面要稳定 ⇒ 按相对路径排（VS Code 按「命中排名」排，
    // 我们这边没有排名信号，路径序是最不意外的次序）。
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let matches: usize = files.iter().map(|f| f.matches.len()).sum();
    Ok(SearchReport {
        // 撞上就算：正好等于上限时也是「后面可能还有」，宁可让用户收紧查询
        limit_hit: matches >= cap || file_cap_hit,
        files,
        matches: matches as u32,
        scanned,
    })
}

/// 在打开的文件夹里递归搜索（VS Code 的搜索视图那一条：`Ctrl+Shift+F`）。
///
/// 返回按相对路径排过序的「文件 → 匹配行」两层树；匹配行 = 一行一条。
#[tauri::command]
pub async fn search_in_folder(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    regex: Option<bool>,
    include: Option<String>,
    exclude: Option<String>,
    max_results: Option<usize>,
) -> Result<SearchReport, String> {
    let req = SearchRequest {
        root: PathBuf::from(&root),
        cap: max_results.unwrap_or(MAX_MATCHES).clamp(1, 20_000),
        query,
        case_sensitive: case_sensitive.unwrap_or(false),
        whole_word: whole_word.unwrap_or(false),
        use_regex: regex.unwrap_or(false),
        include,
        exclude,
    };
    tauri::async_runtime::spawn_blocking(move || search_folder(req))
        .await
        .map_err(|e| format!("搜索任务崩了：{e}"))?
}

// ---------------------------------------------------------------- 全部替换

/// 一条磁盘替换请求。查询三档与搜索时**同一份**（前端把当前查询原样带下来，
/// 免得「搜到的」与「替换的」两套口径 —— B304 那类症状的源头）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceItem {
    pub path: String,
    pub query: String,
    pub replacement: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub files_changed: u32,
    pub occurrences: u32,
    /// 一个文件失败不影响别的：逐条报出来给前端念
    pub errors: Vec<String>,
}

/// 字面量替换（逐字符扫，保留未命中部分原样）。
fn replace_literal(
    text: &str,
    query: &str,
    to: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> (String, usize) {
    let hay: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().map(|c| fold(c, case_sensitive)).collect();
    if needle.is_empty() || needle.len() > hay.len() {
        return (text.to_string(), 0);
    }
    let folded: Vec<char> = hay.iter().map(|c| fold(*c, case_sensitive)).collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    let mut n = 0usize;
    while i < hay.len() {
        if i + needle.len() <= hay.len()
            && folded[i..i + needle.len()] == needle[..]
            && (!whole_word || word_bounded(&folded, i, i + needle.len()))
        {
            out.push_str(to);
            i += needle.len();
            n += 1;
        } else {
            out.push(hay[i]);
            i += 1;
        }
    }
    (out, n)
}

/// 正则那一档实际编译的模式串（匹配与替换共用一份，别长两套）。
///
/// 全词用 `(?-u:\b)`：Rust 的 `\b` 默认按 Unicode 词算（CJK 是词字符），加上 `-u`
/// 才回到 JS 的 ASCII 语义 —— 与上面 `is_word_char` 那段同一个理由。
fn regex_pattern(query: &str, case_sensitive: bool, whole_word: bool) -> String {
    let wrapped = if whole_word {
        format!(r"(?-u:\b)(?:{query})(?-u:\b)")
    } else {
        format!("(?:{query})")
    };
    if case_sensitive {
        wrapped
    } else {
        format!("(?i){wrapped}")
    }
}

/// 正则替换。**替换串按 Rust 的 `$1` / `${name}` 语义**（JS 里整段命中是 `$&`，
/// 分组是 `$1`）—— 与 VS Code 在替换框里那一格有一格之差，写在这里是为了
/// 将来别把它当 bug 修。次数按 `find_iter` 数，与 `replace_all` 同一套模式。
fn replace_regex(
    text: &str,
    query: &str,
    to: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<(String, usize), String> {
    let re = Regex::new(&regex_pattern(query, case_sensitive, whole_word))
        .map_err(|e| format!("正则无效：{e}"))?;
    let count = re.find_iter(text).count();
    Ok((re.replace_all(text, to).into_owned(), count))
}

/// 同步的替换主体（拆出来只为可测，理由同 `search_folder`）。
fn replace_files(items: Vec<ReplaceItem>) -> ReplaceReport {
    let mut files_changed = 0u32;
    let mut occurrences = 0u32;
    let mut errors = Vec::new();
    for item in items {
        let path = PathBuf::from(&item.path);
        if item.query.is_empty() {
            errors.push("搜索内容为空".to_string());
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                errors.push(format!("读不了 {}：{e}", item.path));
                continue;
            }
        };
        if doc::is_probably_binary(&bytes) {
            errors.push(format!("{} 不是文本文件，已跳过", item.path));
            continue;
        }
        if doc::is_readonly(&path) {
            errors.push(format!("{} 是只读文件，已跳过", item.path));
            continue;
        }
        let enc = codec::detect(&bytes);
        let decoded = codec::decode(&bytes, enc);
        // ⚠️ 行尾必须在**归一 LF 之前**问：`to_lf` 之后再看一眼，CRLF 的文件会被判成
        //    「本来就是 LF」，替换一次就把整份文件的行尾悄悄改掉。
        let dominant = eol::analyze(&decoded.text).dominant;
        let original = eol::to_lf(&decoded.text);
        let (replaced, n) = if item.regex {
            match replace_regex(
                &original,
                &item.query,
                &item.replacement,
                item.case_sensitive,
                item.whole_word,
            ) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(format!("{}：{e}", item.path));
                    continue;
                }
            }
        } else {
            replace_literal(
                &original,
                &item.query,
                &item.replacement,
                item.case_sensitive,
                item.whole_word,
            )
        };
        if n == 0 {
            continue; // 没命中就不许改文件的修改时间
        }
        let with_eol = eol::apply(&replaced, dominant);
        let (out, lost) = codec::encode(&with_eol, enc);
        if lost > 0 {
            errors.push(format!(
                "{}：替换后的内容里有 {} 个字符无法用原编码表示，已跳过",
                item.path, lost
            ));
            continue;
        }
        if let Err(e) = atomic_write::atomic_write(&path, &out) {
            errors.push(format!("写不了 {}：{e}", item.path));
            continue;
        }
        files_changed += 1;
        occurrences += n as u32;
    }
    ReplaceReport {
        files_changed,
        occurrences,
        errors,
    }
}

/// 把磁盘上没人管的文件批量替换掉。
///
/// 每步都保真：`codec::detect` → `decode` → 归一 LF → 替换 → `eol::apply(原来的行尾)`
/// → `codec::encode(原来的编码)` → `atomic_write`。编码与行尾**不许**在替换这一步被改掉
/// （与 `save_file` 同一串动作，只是没有用户确认那一环 —— 确认在搜索视图的对话框里做）。
#[tauri::command]
pub async fn replace_in_files(items: Vec<ReplaceItem>) -> Result<ReplaceReport, String> {
    tauri::async_runtime::spawn_blocking(move || replace_files(items))
        .await
        .map_err(|e| format!("替换任务崩了：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(line: &str, q: &str, cs: bool, ww: bool, re: bool) -> Vec<(usize, usize)> {
        build_matcher(q, cs, ww, re).expect("匹配器建不起来")(line)
    }

    /// 每个用例自己的临时目录（同一进程里并行跑，用测试名 + PID 分开）。
    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("litepad-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("临时目录建不起来");
        dir
    }

    fn put(dir: &Path, rel: &str, bytes: &[u8]) {
        let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::create_dir_all(path.parent().expect("有父目录")).unwrap();
        fs::write(&path, bytes).unwrap();
    }

    fn req(dir: &Path, query: &str) -> SearchRequest {
        SearchRequest {
            root: dir.to_path_buf(),
            query: query.into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include: None,
            exclude: None,
            cap: MAX_MATCHES,
        }
    }

    fn rels(rep: &SearchReport) -> Vec<String> {
        rep.files.iter().map(|f| f.rel.clone()).collect()
    }

    #[test]
    fn literal_offsets_are_chars_not_bytes() {
        assert_eq!(
            spans("中文 test 词", "test", false, false, false),
            vec![(3, 4)]
        );
        assert_eq!(
            spans("标题：搜索测试", "搜索", false, false, false),
            vec![(3, 2)],
            "全角冒号也只占一格"
        );
    }

    #[test]
    fn case_sensitivity_is_a_switch_not_a_surprise() {
        assert_eq!(
            spans("Foo BAR foo", "foo", false, false, false),
            vec![(0, 3), (8, 3)]
        );
        assert_eq!(
            spans("Foo BAR foo", "foo", true, false, false),
            vec![(8, 3)]
        );
    }

    #[test]
    fn whole_word_uses_ascii_boundaries_like_js() {
        assert!(
            spans("tester", "test", false, true, false).is_empty(),
            "词中间不算命中"
        );
        assert_eq!(spans("the cat.", "cat", false, true, false), vec![(4, 3)]);
        // CJK 不算词字符（JS `\b` 的语义）：中文夹着的英文单词照样全词命中
        assert_eq!(
            spans("中文test中文", "test", false, true, false),
            vec![(2, 4)]
        );
    }

    #[test]
    fn regex_group_offsets_and_invalid_pattern() {
        assert_eq!(
            spans("a1b2", r"(\d)", false, false, true),
            vec![(1, 1), (3, 1)]
        );
        assert_eq!(spans("FOO x", "foo", false, false, true), vec![(0, 3)]);
        let err = match build_matcher("(", false, false, true) {
            Ok(_) => panic!("不配对的括号不该编得过"),
            Err(e) => e,
        };
        assert!(err.contains("正则无效"), "坏模式要回人话：{err}");
    }

    #[test]
    fn preview_trims_leading_context_and_keeps_offsets() {
        let line = format!("{}needle{}", "x".repeat(100), "y".repeat(300));
        let (text, start, len) = make_preview(&line, 100, 6);
        assert!(text.starts_with('…'), "前面截掉了就要有省略号");
        assert_eq!(start, 27, "26 个上下文 + 省略号那一格");
        assert_eq!(len, 6);
        assert!(text.chars().count() <= PREVIEW_CHARS);
        let (short, s2, l2) = make_preview("hello 世界", 6, 2);
        assert_eq!((short.as_str(), s2, l2), ("hello 世界", 6, 2));
    }

    /// B389 · `column` 是**整行**里的字符列号（1 起）：预览被裁过（补了省略号、高亮起点
    /// 跟着挪）之后它仍要指着真实那一格。前端点一条命中要靠它把光标摆到命中上 ——
    /// 拿 `start` 去摆会偏掉一个「上下文长度」。
    #[test]
    fn column_is_the_real_line_position_even_after_a_cut_preview() {
        let dir = tmp("column");
        put(
            &dir,
            "a.txt",
            format!("{}needle{}", "x".repeat(100), "y".repeat(20)).as_bytes(),
        );
        let rep = search_folder(req(&dir, "needle")).expect("搜得到");
        let m = &rep.files[0].matches[0];
        assert!(m.preview.starts_with('…'), "预览确实被裁过");
        assert_ne!(m.start, 100, "预览里那个起点已经不是行内列号了");
        assert_eq!(m.column, 101, "整行里的字符列号，1 起");
        assert_eq!(m.length, 6, "长度两边同一口径（被裁时才是 min）");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 中文列号按**字符**算，不按字节：VS Code 那边也是码位/字符口径，字节数会把光标
    /// 推到后半格去。
    #[test]
    fn column_counts_characters_not_bytes() {
        let dir = tmp("column-cjk");
        put(&dir, "b.md", "第一章 needle 结尾\n".as_bytes());
        let rep = search_folder(req(&dir, "needle")).expect("搜得到");
        let m = &rep.files[0].matches[0];
        assert_eq!(
            m.column, 5,
            "「第一章 」= 4 个字符，命中在第 5 个字符上（不是 10 字节）"
        );
        assert_eq!(m.preview.chars().nth(m.start as usize), Some('n'));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn globs_cover_the_vscode_subset() {
        let md = compile_glob("*.md").unwrap();
        assert!(md.is_match("a/b.md") && md.is_match("b.md") && !md.is_match("b.txt"));
        let dir = compile_glob("src").unwrap();
        assert!(dir.is_match("src") && dir.is_match("src/a.ts"));
        assert!(!dir.is_match("mysrc/a.ts"), "整段才算一层目录");
        let anchored = compile_glob("docs/a/**").unwrap();
        assert!(anchored.is_match("docs/a/b/c.md"));
        assert!(!anchored.is_match("x/docs/a/c.md"), "含 / 的那条锚定在根上");
        // `./` 前缀在切分时剥掉（VS Code `queryBuilder.ts:666-673` 同口径）
        let list = compile_globs(Some("./notes/*.txt, src/**")).unwrap();
        assert!(list.iter().any(|r| r.is_match("notes/a.txt")));
        assert!(list.iter().any(|r| r.is_match("src/x/y.ts")));
        assert!(
            compile_globs(Some("[".to_string().as_str())).is_ok(),
            "不配对的括号当字面量"
        );
    }

    #[test]
    fn exclude_prunes_a_directory_before_entering_it() {
        let f = WalkFilter {
            include: Vec::new(),
            exclude: vec![compile_glob("archive").unwrap()],
        };
        assert!(f.prunes_dir("archive"), "整目录跳过");
        assert!(!f.prunes_dir("src"));
        assert!(!f.accepts("archive/a.md"));
        assert!(f.accepts("src/a.md"));
    }

    #[test]
    fn search_walks_groups_and_skips_noise_hidden_and_binary() {
        let dir = tmp("walk");
        put(&dir, "a.md", "# 标题甲\n正文\n".as_bytes());
        put(&dir, "notes/b.md", "## 标题乙\n".as_bytes());
        put(&dir, "c.txt", "标题丙\n".as_bytes());
        put(&dir, "node_modules/d.md", "标题丁\n".as_bytes());
        put(&dir, ".hidden.md", "标题戊\n".as_bytes());
        put(
            &dir,
            "bin.md",
            &[b"\x00\x02".as_slice(), "标题".as_bytes()].concat(),
        );
        let rep = search_folder(req(&dir, "标题")).expect("搜得到");
        assert_eq!(
            rels(&rep),
            vec!["a.md", "c.txt", "notes/b.md"],
            "路径序稳定"
        );
        assert_eq!(rep.matches, 3);
        assert_eq!(rep.files[2].name, "b.md");
        assert_eq!(rep.files[2].matches[0].line, 1);
        assert!(!rep.limit_hit);
        assert_eq!(rep.scanned, 4, "二进制要读出来才认得出，走目录时拦不住");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_honours_include_exclude_and_the_result_cap() {
        let dir = tmp("cap");
        put(&dir, "a.md", "标题一\n标题二\n".as_bytes());
        put(&dir, "b.md", "标题三\n".as_bytes());
        put(&dir, "c.txt", "标题四\n".as_bytes());
        let mut only_md = req(&dir, "标题");
        only_md.include = Some("*.md".into());
        let rep = search_folder(only_md).expect("include 生效");
        assert_eq!(rels(&rep), vec!["a.md", "b.md"]);
        let mut capped = req(&dir, "标题");
        capped.cap = 1;
        let rep = search_folder(capped).expect("撞上限不是错误");
        assert_eq!(rep.matches, 1);
        assert!(
            rep.limit_hit,
            "撞上限必须回 limit_hit，前端才许说「这只是子集」"
        );
        let mut no_md = req(&dir, "标题");
        no_md.exclude = Some("*.md".into());
        assert_eq!(rels(&search_folder(no_md).unwrap()), vec!["c.txt"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_decodes_legacy_chinese_instead_of_lossy_utf8() {
        // 中文笔记是这编辑器的主场景：GBK 的文件用 lossy UTF-8 解码就永远搜不到。
        let dir = tmp("gbk");
        let text = "第一章 测试标题\n这一段也是中文，用来让编码猜测站得住脚。\n";
        let (bytes, lost) = codec::encode(text, codec::Encoding::Gbk);
        assert_eq!(lost, 0);
        put(&dir, "gbk.md", &bytes);
        let rep = search_folder(req(&dir, "测试标题")).expect("GBK 也要搜得到");
        assert_eq!(rep.matches, 1, "命中数 {:?}", rep.files);
        assert_eq!(rep.files[0].matches[0].preview, "第一章 测试标题");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_keeps_encoding_and_line_endings_and_counts() {
        let dir = tmp("replace");
        let (gbk, _) = codec::encode("第一行 甲\r\n第二行 甲\r\n", codec::Encoding::Gbk);
        put(&dir, "keep.gbk", &gbk);
        put(&dir, "none.md", "没有要换的字\r\n".as_bytes());
        let before_none = fs::read(dir.join("none.md")).unwrap();
        let item = |path: PathBuf| ReplaceItem {
            path: path.to_string_lossy().into_owned(),
            query: "甲".into(),
            replacement: "乙".into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
        };
        let rep = replace_files(vec![item(dir.join("keep.gbk")), item(dir.join("none.md"))]);
        assert_eq!(
            (rep.files_changed, rep.occurrences),
            (1, 2),
            "{:?}",
            rep.errors
        );
        let after = fs::read(dir.join("keep.gbk")).unwrap();
        assert_ne!(after, gbk);
        assert_eq!(
            codec::decode(&after, codec::Encoding::Gbk).text,
            "第一行 乙\r\n第二行 乙\r\n",
            "编码与 CRLF 都不许在替换这一步被改掉"
        );
        assert_eq!(
            fs::read(dir.join("none.md")).unwrap(),
            before_none,
            "没命中就不许动文件（连修改时间都不该改）"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_regex_expands_groups_and_literal_treats_dots_literally() {
        assert_eq!(
            replace_regex("ab", "(a)(b)", "$2$1", false, false).unwrap(),
            ("ba".into(), 1)
        );
        assert_eq!(
            replace_literal("a.b axb", "a.b", "X", false, false),
            ("X axb".into(), 1)
        );
    }

    #[test]
    fn replace_reports_a_bad_file_without_dropping_the_rest() {
        let dir = tmp("partial");
        put(&dir, "ok.md", "甲\n".as_bytes());
        let item = |path: PathBuf| ReplaceItem {
            path: path.to_string_lossy().into_owned(),
            query: "甲".into(),
            replacement: "乙".into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
        };
        let rep = replace_files(vec![item(dir.join("missing.md")), item(dir.join("ok.md"))]);
        assert_eq!(rep.files_changed, 1, "坏一条不许连坐");
        assert_eq!(rep.errors.len(), 1, "{:?}", rep.errors);
        assert!(rep.errors[0].contains("读不了"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
