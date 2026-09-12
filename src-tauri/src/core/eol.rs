//! 行尾识别与转换。
//!
//! 约定：**内存中的文本一律使用 `\n`（LF）**。磁盘行尾在读取时归一化、
//! 在保存时还原。这样编辑器内部所有偏移/行号计算都不必关心 `\r`。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Eol {
    Crlf,
    Lf,
    Cr,
}

impl Eol {
    pub fn label(&self) -> &'static str {
        match self {
            Eol::Crlf => "CRLF",
            Eol::Lf => "LF",
            Eol::Cr => "CR",
        }
    }

    /// 容错解析，未知值回落到 CRLF（本构建仅面向 Windows）。
    pub fn from_label(s: &str) -> Eol {
        match s.trim().to_ascii_uppercase().as_str() {
            "LF" | "UNIX" => Eol::Lf,
            "CR" | "MAC" => Eol::Cr,
            _ => Eol::Crlf,
        }
    }

    pub fn all() -> &'static [Eol] {
        &[Eol::Crlf, Eol::Lf, Eol::Cr]
    }
}

pub struct EolInfo {
    /// 出现次数最多的行尾，作为该文件的默认行尾。
    pub dominant: Eol,
    /// 文件中混用了两种以上行尾，状态栏应显示 Mixed。
    pub mixed: bool,
}

fn counts(bytes: &[u8]) -> (u64, u64, u64) {
    let mut crlf = 0u64;
    let mut lf = 0u64;
    let mut cr = 0u64;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                } else {
                    cr += 1;
                    i += 1;
                }
            }
            b'\n' => {
                lf += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    (crlf, lf, cr)
}

/// 统计原始文本的行尾分布。
pub fn analyze(text: &str) -> EolInfo {
    let (crlf, lf, cr) = counts(text.as_bytes());
    let dominant = if crlf >= lf && crlf >= cr {
        Eol::Crlf
    } else if lf >= cr {
        Eol::Lf
    } else {
        Eol::Cr
    };
    let kinds = (crlf > 0) as u8 + (lf > 0) as u8 + (cr > 0) as u8;
    EolInfo {
        dominant,
        mixed: kinds > 1,
    }
}

/// 归一化到 LF。无 `\r` 时零拷贝直接返回。
pub fn to_lf(text: &str) -> String {
    if !text.as_bytes().contains(&b'\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// 按目标行尾还原（输入必须是已归一化到 LF 的文本）。
pub fn apply(text: &str, eol: Eol) -> String {
    match eol {
        Eol::Lf => text.to_string(),
        Eol::Crlf => text.replace('\n', "\r\n"),
        Eol::Cr => text.replace('\n', "\r"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyze_crlf() {
        let info = analyze("a\r\nb\r\nc");
        assert_eq!(info.dominant, Eol::Crlf);
        assert!(!info.mixed);
    }

    #[test]
    fn analyze_mixed() {
        let info = analyze("a\r\nb\nc");
        assert!(info.mixed);
    }

    #[test]
    fn normalize_then_restore() {
        let raw = "a\r\nb\rc\nd";
        let lf = to_lf(raw);
        assert_eq!(lf, "a\nb\nc\nd");
        assert_eq!(apply(&lf, Eol::Crlf), "a\r\nb\r\nc\r\nd");
        assert_eq!(apply(&lf, Eol::Cr), "a\rb\rc\rd");
    }

    #[test]
    fn label_roundtrip() {
        for e in Eol::all() {
            assert_eq!(Eol::from_label(e.label()), *e);
        }
    }
}
