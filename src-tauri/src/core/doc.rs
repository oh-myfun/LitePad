//! 文档元数据与文件级别的守卫。

use std::path::Path;

use super::codec::Encoding;
use super::eol::Eol;

// ---------------------------------------------------------------- 大文件分级（M4）
//
// CM6 的开销随文档体量非线性上升：语法高亮要增量解析全篇、折叠与括号匹配
// 依赖语法树、选中匹配高亮会全文档扫描。20 MB 以上如果不做任何降级，
// 打开后界面会长时间无响应，看起来就是「卡死」。
//
// 分级的意义是**明确关掉什么**，而不是拒绝打开：宁可少几个锦上添花的特性，
// 也要保证「打开得了、打得开、能编辑」。

/// 全功能上限：≤ 2 MB 一律完整特性，绝大多数源码与文档都在这个区间。
pub const SIZE_NORMAL_MAX: u64 = 2 * 1024 * 1024;
/// 一级降级上限：≤ 20 MB 关闭语法高亮 / 折叠 / 括号匹配 / 选中匹配高亮。
pub const SIZE_LARGE_MAX: u64 = 20 * 1024 * 1024;
/// 硬上限：≤ 64 MB 再关掉当前行高亮与 Markdown 自动预览；超过则拒绝打开。
pub const SIZE_HUGE_MAX: u64 = 64 * 1024 * 1024;

/// 文档体量档位。前端据此裁剪编辑器扩展（见 `src/editor/perf.ts`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeClass {
    Normal,
    Large,
    Huge,
}

impl SizeClass {
    /// 线上字符串形式（前端 `SizeClass` 联合类型与之对应）。
    pub fn as_str(self) -> &'static str {
        match self {
            SizeClass::Normal => "normal",
            SizeClass::Large => "large",
            SizeClass::Huge => "huge",
        }
    }
}

/// 按字节数定档；超过硬上限返回 None（调用方据此拒绝打开）。
pub fn size_class(len: u64) -> Option<SizeClass> {
    if len <= SIZE_NORMAL_MAX {
        Some(SizeClass::Normal)
    } else if len <= SIZE_LARGE_MAX {
        Some(SizeClass::Large)
    } else if len <= SIZE_HUGE_MAX {
        Some(SizeClass::Huge)
    } else {
        None
    }
}

/// 打开文档在 Rust 侧的「真实状态」。
/// 前端只持有文本 buffer 与视图状态，避免双份真相（见方案 3 设计原则 1）。
///
/// `id` 是标签唯一标识（应用生命周期内自增），前端按 id 寻址文档，
/// 避免 Vec 索引在关闭标签后漂移。未关联磁盘路径时 `path` 为空。
///
/// M2 的会话恢复、自动保存、外部修改检测将直接读取这些字段。
#[derive(Debug, Clone)]
pub struct Doc {
    pub id: u64,
    pub path: std::path::PathBuf,
    pub encoding: Encoding,
    pub eol: Eol,
    pub readonly: bool,
}

/// 分级提示：告诉用户当前关掉了哪些特性，避免「功能不见了」被当成 bug。
pub fn size_class_hint(class: SizeClass) -> &'static str {
    match class {
        SizeClass::Large => "文件较大（>2 MB）：已关闭语法高亮、代码折叠与括号匹配以保证流畅",
        SizeClass::Huge => "文件很大（>20 MB）：已关闭语法高亮、折叠、括号匹配与 Markdown 自动预览",
        SizeClass::Normal => "",
    }
}

/// 前 8 KB 内出现 NUL 基本可以判定为二进制。
pub fn is_probably_binary(bytes: &[u8]) -> bool {
    let end = bytes.len().min(8192);
    bytes[..end].contains(&0u8)
}

/// 只读检测（NTFS 只读属性）。
pub fn is_readonly(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => meta.permissions().readonly(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M4：阈值边界必须精确——差一个字节就换档，容易写出 off-by-one。
    #[test]
    fn size_class_boundaries() {
        let mb = 1024 * 1024;
        assert_eq!(size_class(0), Some(SizeClass::Normal));
        assert_eq!(
            size_class(SIZE_NORMAL_MAX),
            Some(SizeClass::Normal),
            "上限应为闭区间"
        );
        assert_eq!(size_class(SIZE_NORMAL_MAX + 1), Some(SizeClass::Large));
        assert_eq!(size_class(SIZE_LARGE_MAX), Some(SizeClass::Large));
        assert_eq!(size_class(SIZE_LARGE_MAX + 1), Some(SizeClass::Huge));
        assert_eq!(size_class(SIZE_HUGE_MAX), Some(SizeClass::Huge));
        assert_eq!(size_class(SIZE_HUGE_MAX + 1), None, "超硬上限必须拒绝");
        assert_eq!(size_class(200 * mb), None);
    }

    /// M0 时代 20 MB 就直接拒绝打开；M4 起要降级放行。
    #[test]
    fn large_files_are_degraded_not_rejected() {
        let mb = 1024 * 1024;
        assert_eq!(
            size_class(25 * mb),
            Some(SizeClass::Huge),
            "25 MB 应降级而非拒绝"
        );
        assert!(size_class(20 * mb).is_some(), "20 MB 必须还能打开");
    }

    #[test]
    fn size_class_serde_and_hint() {
        assert_eq!(SizeClass::Normal.as_str(), "normal");
        assert_eq!(SizeClass::Large.as_str(), "large");
        assert_eq!(SizeClass::Huge.as_str(), "huge");
        // 线上必须是 camelCase 的三态字符串（前端 SizeClass 联合类型）
        let json = serde_json::to_string(&SizeClass::Large).unwrap();
        assert_eq!(json, "\"large\"");
        // normal 不给提示，避免每次打开都刷屏
        assert_eq!(size_class_hint(SizeClass::Normal), "");
        assert!(size_class_hint(SizeClass::Large).contains("语法高亮"));
        assert!(size_class_hint(SizeClass::Huge).contains("自动预览"));
    }
}
