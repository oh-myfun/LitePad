//! 多级别运行日志（B144）。
//!
//! ## 之前是什么样
//!
//! 只有一条 `log_event` 命令：`level` 是**打印出来的一串字符**、一点过滤都没有，
//! 追加写 `%TEMP%\litepad-app.log`（系统磁盘清理会删、用户也找不到），不滚动、
//! 只有秒级 epoch、后端自己几乎不记。于是定位问题时：
//!   · 想开详细日志得改代码重新打包；
//!   · 后端（会话/备份/原子写/文件监听）全是静默失败，前端只能看到结果看不到原因；
//!   · 日志无限增长，放久了几个 G。
//!
//! ## 现在
//!
//!   · 五档级别（`error` / `warn` / `info` / `debug` / `trace`），**发布版默认 info**，
//!     可运行时切到 debug/trace 复现问题，不用换包；
//!   · 落在配置目录下的 `logs/litepad.log`（尊重 `LITEPAD_CONFIG_DIR` 覆盖 —— 截图与
//!     测试隔离照旧生效），按大小滚动保留 3 份；
//!   · 写盘在**后台线程**：调用方只管往 channel 里丢一行，绝不阻塞 UI；
//!   · 级别过滤发生在**入队之前**，被挡掉的那一行连格式化都不做。
//!
//! ⚠️ 日志文件里可能出现用户文档路径。别把它当成可以随便发到网上的东西。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;

use crate::session;

/// 日志级别：**数值越小越重要**（见 `should_log`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
    Trace = 4,
}

impl Level {
    /// 同 `parse`，但空串走 [`default_level()`]（settings 里没配过就是这个值）。
    pub fn parse_or_default(s: &str) -> Level {
        if s.trim().is_empty() {
            default_level()
        } else {
            Level::parse(s)
        }
    }

    /// 从字符串解析（大小写不敏感）。
    ///
    /// ⚠️ 未知值**回落 Info** 而不是报错：前端老调用点传的就是自由字符串，
    /// 一个拼错的级别不该把这条日志弄丢（它多半是错误路径上最有价值的那条）。
    pub fn parse(s: &str) -> Level {
        match s.trim().to_ascii_lowercase().as_str() {
            "error" | "err" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "info" => Level::Info,
            "debug" => Level::Debug,
            "trace" => Level::Trace,
            _ => Level::Info,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
            Level::Trace => "TRACE",
        }
    }

    /// 写进 settings.json 的形状（小写，前端同款）。
    pub fn as_key(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
            Level::Trace => "trace",
        }
    }
}

/// 默认级别：`debug` 构建放低一档（开发期直接看得到细节），发布版 info。
pub fn default_level() -> Level {
    if cfg!(debug_assertions) {
        Level::Debug
    } else {
        Level::Info
    }
}

/// 单份日志的大小上限（超过就滚动）。
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 保留几份（含正本）。
pub const KEEP: usize = 3;

static SENDER: OnceLock<Sender<String>> = OnceLock::new();
static LEVEL: OnceLock<AtomicU8> = OnceLock::new();

fn level_slot() -> &'static AtomicU8 {
    LEVEL.get_or_init(|| AtomicU8::new(default_level() as u8))
}

/// 当前生效的级别。
pub fn level() -> Level {
    match level_slot().load(Ordering::Relaxed) {
        0 => Level::Error,
        1 => Level::Warn,
        2 => Level::Info,
        3 => Level::Debug,
        _ => Level::Trace,
    }
}

/// 运行时改级别（前端「临时开 debug 复现」用）。返回是否真的改了。
pub fn set_level(next: Level) {
    level_slot().store(next as u8, Ordering::Relaxed);
}

/// 这一级现在记不记（`级别 <= 当前级别`，因为数值越小越重要）。
///
/// ⚠️ 参数不能叫 `level`：那会遮蔽同名的 `level()` 函数（E0618）。
pub fn should_log(lvl: Level) -> bool {
    (lvl as u8) <= (level() as u8)
}

/// 日志目录：`<配置目录>/logs`。配置目录拿不到（没有 %APPDATA% 且没覆盖）就返回 None。
pub fn log_dir() -> Option<PathBuf> {
    session::config_dir().map(|d| d.join("logs"))
}

/// 启动日志系统。**只在 `main()` 里调一次**（channel 是全局单例）。
///
/// 目录建不出来（权限/路径异常）时降级为「只丢弃、不写盘」——日志是为定位问题服务的，
/// 它自己不许把应用搞崩。
pub fn init(level: Level) {
    init_with(log_dir(), level)
}

/// 可注入目录的版本（单测用）。
fn init_with(dir: Option<PathBuf>, level: Level) {
    set_level(level);
    let Some(dir) = dir else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (tx, rx) = channel::<String>();
    // 只认第一次：重复 init（多窗口/测试）不该再起一条线程。
    if SENDER.set(tx).is_err() {
        return;
    }
    thread::Builder::new()
        .name("litepad-log".into())
        .spawn(move || {
            let mut w = match Writer::open(&dir) {
                Some(w) => w,
                None => return,
            };
            // 线程活着就一直收；发送端（全局静态）永不 drop，所以靠 recv() 阻塞即可。
            while let Ok(line) = rx.recv() {
                w.write_line(&line);
            }
        })
        .ok();
}

/// 记一条。**不阻塞**：入队即返回，写盘在后台线程。
pub fn log(level: Level, target: &str, msg: &str) {
    if !should_log(level) {
        return;
    }
    let Some(tx) = SENDER.get() else { return };
    let _ = tx.send(format_line(&now_stamp(), level, target, msg));
}

/// 拼一行（时间戳由调用方给，便于单测断言格式）。
pub fn format_line(ts: &str, level: Level, target: &str, msg: &str) -> String {
    format!("{ts} [{:<5}] [{}] {}", level.as_str(), target, msg)
}

// ---------------------------------------------------------------- 写盘与滚动

/// 正本文件名。
const FILE: &str = "litepad.log";

struct Writer {
    dir: PathBuf,
    file: Option<File>,
    written: u64,
}

impl Writer {
    fn open(dir: &Path) -> Option<Self> {
        let mut w = Writer {
            dir: dir.to_path_buf(),
            file: None,
            written: 0,
        };
        w.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(FILE))
                .ok()?,
        );
        w.written = fs::metadata(dir.join(FILE)).map(|m| m.len()).unwrap_or(0);
        Some(w)
    }

    fn write_line(&mut self, line: &str) {
        let Some(f) = self.file.as_mut() else { return };
        // 一行一次 write + flush：日志量不大（一天几千行），换来「进程被强杀也不丢
        // 最后几条」。真到高频场景，级别过滤会先把大多数挡在门外。
        if f.write_all(line.as_bytes()).is_err() {
            return;
        }
        let _ = f.write_all(b"\n");
        let _ = f.flush();
        self.written += line.len() as u64 + 1;
        if self.written >= MAX_BYTES {
            self.rotate();
        }
    }

    /// 滚动：正本 → `.1` → `.2` … 最老的那份丢掉（共 `KEEP` 份）。
    fn rotate(&mut self) {
        self.file = None; // 先放手，Windows 上不关掉句柄没法改名
        rotate_files(&self.dir, KEEP);
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(FILE))
            .ok();
        self.written = 0;
    }
}

/// 纯文件层面的滚动（单测直接调它，不牵扯线程）。
fn rotate_files(dir: &Path, keep: usize) {
    if keep == 0 {
        return;
    }
    // 最老的一份删掉
    let oldest = dir.join(format!("{FILE}.{}", keep - 1));
    if oldest.exists() {
        let _ = fs::remove_file(oldest);
    }
    // 从老到新依次后移：`.1`→`.2`，`.2`→`.3`…
    for i in (1..keep - 1).rev() {
        let from = dir.join(format!("{FILE}.{i}"));
        if from.exists() {
            let _ = fs::rename(from, dir.join(format!("{FILE}.{}", i + 1)));
        }
    }
    let cur = dir.join(FILE);
    if cur.exists() {
        let _ = fs::rename(cur, dir.join(format!("{FILE}.1")));
    }
}

// ---------------------------------------------------------------- 时间戳

/// 本地时间 `YYYY-MM-DD HH:MM:SS.mmm`。
///
/// 不用 chrono（省一个依赖、省一份 tz 数据）：Windows 上直接问 `GetLocalTime`；
/// 拿不到（非 Windows / API 异常）就退化成 UTC 的 epoch 秒，宁可时区不准也不能没有时间。
pub fn now_stamp() -> String {
    match local_civil() {
        Some((y, m, d, hh, mm, ss, ms)) => format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            y, m, d, hh, mm, ss, ms
        ),
        None => {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("utc-{secs}")
        }
    }
}

type Civil = (u32, u32, u32, u32, u32, u32, u32);

#[cfg(windows)]
fn local_civil() -> Option<Civil> {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // windows 0.61 的签名是 `unsafe fn GetLocalTime() -> SYSTEMTIME`（不是出参版）
    let st = unsafe { GetLocalTime() };
    Some((
        st.wYear as u32,
        st.wMonth as u32,
        st.wDay as u32,
        st.wHour as u32,
        st.wMinute as u32,
        st.wSecond as u32,
        st.wMilliseconds as u32,
    ))
}

#[cfg(not(windows))]
fn local_civil() -> Option<Civil> {
    None // 本项目只面向 Windows；这里退化为 epoch 秒
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_parses_and_falls_back_to_info() {
        assert_eq!(Level::parse("error"), Level::Error);
        assert_eq!(Level::parse("WARN"), Level::Warn);
        assert_eq!(Level::parse("warning"), Level::Warn);
        assert_eq!(Level::parse("debug"), Level::Debug);
        assert_eq!(Level::parse("trace"), Level::Trace);
        // 未知值不许把这条日志弄丢：错误路径上那几条最有价值
        assert_eq!(Level::parse("verbose"), Level::Info);
        assert_eq!(Level::parse(""), Level::Info);
    }

    #[test]
    fn level_filter_keeps_the_more_severe_ones() {
        set_level(Level::Info);
        assert!(should_log(Level::Error));
        assert!(should_log(Level::Warn));
        assert!(should_log(Level::Info));
        assert!(!should_log(Level::Debug), "发布版默认不该记 debug");
        assert!(!should_log(Level::Trace));

        set_level(Level::Trace);
        assert!(should_log(Level::Debug));
        assert!(should_log(Level::Trace));

        set_level(Level::Error);
        assert!(!should_log(Level::Warn));
        assert!(should_log(Level::Error));
        set_level(default_level());
    }

    #[test]
    fn parse_or_default_keeps_the_builtin_level_when_unset() {
        // 空串 = settings 里没配过（旧的配置文件就是这样），别把它当成「显式 info」。
        assert_eq!(Level::parse_or_default(""), default_level());
        assert_eq!(Level::parse_or_default("   "), default_level());
        // 认得的值照旧生效
        assert_eq!(Level::parse_or_default("trace"), Level::Trace);
    }

    /// `init()` 之前（埋点常加在启动早期，那会儿 channel 还没起来）调 `log()`
    /// 必须**什么都不做而不是 panic**：`SENDER` 没初始化时取不到 sender，直接返回。
    /// 这条用例本身就是「不 panic」的证据 —— 一旦 `log()` 里解了未初始化的全局量，
    /// 直接测试失败。
    #[test]
    fn logging_before_init_is_a_silent_noop() {
        log(Level::Error, "test", "before init");
    }

    #[test]
    fn line_has_timestamp_level_and_target() {
        let line = format_line(
            "2026-09-27 02:10:22.314",
            Level::Warn,
            "session",
            "save failed",
        );
        assert_eq!(
            line,
            "2026-09-27 02:10:22.314 [WARN ] [session] save failed"
        );
    }

    #[test]
    fn stamp_uses_local_wall_clock() {
        let s = now_stamp();
        // 形如 `2026-09-27 02:10:22.314`；退化路径是 `utc-<epoch>`
        assert!(
            s.len() == 23 && s.chars().nth(4) == Some('-') || s.starts_with("utc-"),
            "时间戳格式不对：{s}"
        );
    }

    /// 滚动：正本被改名、历史依次后移、超量的那份丢掉。
    #[test]
    fn rotation_keeps_only_the_last_few_files() {
        let dir = std::env::temp_dir().join(format!("litepad-logtest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let name = |n: &str| dir.join(n);

        fs::write(name(FILE), "newest").unwrap();
        fs::write(name("litepad.log.1"), "older").unwrap();
        fs::write(name("litepad.log.2"), "oldest").unwrap();

        rotate_files(&dir, KEEP);

        assert_eq!(fs::read_to_string(name("litepad.log.1")).unwrap(), "newest");
        assert_eq!(fs::read_to_string(name("litepad.log.2")).unwrap(), "older");
        // oldest 那份被挤掉了（KEEP=3：正本 + .1 + .2）
        assert!(!name("litepad.log.3").exists(), "不该留下第 4 份");
        assert!(!name(FILE).exists(), "滚动后正本还没重建时应当不存在");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 写盘顺序：先写、再判滚动。
    ///
    /// ⚠️ 顺序是有意的 —— 把「最后一行」丢掉就等于日志会静默缺一段，而缺的恰恰是
    /// 故障当时那条。所以触发滚动的那一行**已经落在正本里**，滚动只是把这份正本
    /// 改名成 `.1`，随后再开一个空正本接着写。
    #[test]
    fn writer_appends_and_rotates_when_it_grows() {
        let dir = std::env::temp_dir().join(format!("litepad-logtest-w-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let mut w = Writer::open(&dir).expect("应能打开日志文件");
        w.write_line("first line");
        w.written = MAX_BYTES; // 假装已经写满，逼出一次滚动
        w.write_line("second line");

        // 越线的那一条不丢：它随正本一起进了 .1
        assert_eq!(
            fs::read_to_string(dir.join("litepad.log.1"))
                .unwrap()
                .trim(),
            "first line\nsecond line"
        );
        // 滚动后的正本是空的 —— 之后的行才落在这里
        assert_eq!(fs::read_to_string(dir.join(FILE)).unwrap(), "");

        // 接着写要回到正本，别堆进历史文件里
        w.write_line("third line");
        assert_eq!(
            fs::read_to_string(dir.join(FILE)).unwrap().trim(),
            "third line"
        );
        assert_eq!(
            fs::read_to_string(dir.join("litepad.log.1"))
                .unwrap()
                .trim(),
            "first line\nsecond line",
            "历史文件不该被回写"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
