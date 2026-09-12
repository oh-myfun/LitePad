//! 编码识别、解码与编码。
//!
//! 支持集：UTF-8 / UTF-8 with BOM / UTF-16LE / UTF-16BE / GB18030 / Big5 /
//! Shift-JIS / EUC-KR / Windows-1252。
//!
//! 识别顺序（对应方案 4.3）：
//!   ① BOM → ② 用户手动指定（由调用方传入，优先级高于本模块）→
//!   ③ UTF-16 无 BOM 启发式 → ④ 合法 UTF-8 → ⑤ chardetng 统计猜测 → ⑥ 兜底

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gb18030,
    Big5,
    ShiftJis,
    EucKr,
    Windows1252,
}

impl Encoding {
    /// 状态栏与配置中展示用的稳定标识，也是前后端传输的契约值。
    pub fn label(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 with BOM",
            Encoding::Utf16Le => "UTF-16LE",
            Encoding::Utf16Be => "UTF-16BE",
            Encoding::Gb18030 => "GB18030",
            Encoding::Big5 => "Big5",
            Encoding::ShiftJis => "Shift-JIS",
            Encoding::EucKr => "EUC-KR",
            Encoding::Windows1252 => "Windows-1252",
        }
    }

    /// 容错解析：忽略大小写与 `-` `_` 空格差异，未知值回落到 UTF-8（永不失败）。
    pub fn from_label(s: &str) -> Encoding {
        let normalized: String = s
            .trim()
            .to_ascii_lowercase()
            .chars()
            .filter(|c| !matches!(c, '-' | '_' | ' '))
            .collect();
        match normalized.as_str() {
            "utf8" | "utf8nobom" => Encoding::Utf8,
            "utf8bom" | "utf8withbom" | "utf8sig" => Encoding::Utf8Bom,
            "utf16le" | "utf16" | "unicode" => Encoding::Utf16Le,
            "utf16be" | "unicodefffe" => Encoding::Utf16Be,
            "gb18030" | "gbk" | "gb2312" | "ansi" | "cp936" => Encoding::Gb18030,
            "big5" | "cp950" => Encoding::Big5,
            "shiftjis" | "sjis" | "cp932" => Encoding::ShiftJis,
            "euckr" | "cp949" => Encoding::EucKr,
            "windows1252" | "iso88591" | "latin1" | "ascii" => Encoding::Windows1252,
            _ => Encoding::Utf8,
        }
    }

    pub fn all() -> &'static [Encoding] {
        &[
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
            Encoding::Gb18030,
            Encoding::Big5,
            Encoding::ShiftJis,
            Encoding::EucKr,
            Encoding::Windows1252,
        ]
    }

    fn rs(&self) -> &'static encoding_rs::Encoding {
        match self {
            Encoding::Utf8 | Encoding::Utf8Bom => encoding_rs::UTF_8,
            Encoding::Utf16Le => encoding_rs::UTF_16LE,
            Encoding::Utf16Be => encoding_rs::UTF_16BE,
            // encoding_rs 的 GBK 实现即 GB18030 全集
            Encoding::Gb18030 => encoding_rs::GBK,
            Encoding::Big5 => encoding_rs::BIG5,
            Encoding::ShiftJis => encoding_rs::SHIFT_JIS,
            Encoding::EucKr => encoding_rs::EUC_KR,
            Encoding::Windows1252 => encoding_rs::WINDOWS_1252,
        }
    }
}

pub struct Decoded {
    pub text: String,
    /// 出现无法映射的字节序列（意味着编码选错）。
    pub lossy: bool,
}

/// 解码。encoding_rs 的 `decode` 自带 BOM 嗅探，会正确吞掉 BOM。
/// （encoding_rs 只负责解码，编码见下方 `encode` 的说明。）
pub fn decode(bytes: &[u8], enc: Encoding) -> Decoded {
    let (cow, _actual, had_errors) = enc.rs().decode(bytes);
    Decoded {
        text: cow.into_owned(),
        lossy: had_errors,
    }
}

/// 编码。返回 (字节, 被替换的无法映射字符数)。
///
/// **为什么不用 `Encoding::encode`**：encoding_rs 是面向 HTML 场景的库——
/// 对 UTF-16 目标 `output_encoding()` 直接返回 UTF-8，纯 ASCII 输入会原样透传；
/// 对 legacy 目标遇到无法映射的字符会输出 HTML 数字字符引用（`&#26085;`）。
/// 这两种行为对文本编辑器都是错的，所以这里自己实现：
///   · UTF-8 / UTF-16 手写转换（都很简单，且无损失）；
///   · legacy 编码走 `Encoder` API，无法映射的字符替换为 `?`（Notepad++ 行为），
///     替换前由前端调用 `check_encodable` 弹窗确认（见方案 4.3 不可逆保护）。
pub fn encode(text: &str, enc: Encoding) -> (Vec<u8>, usize) {
    match enc {
        Encoding::Utf8 => (text.as_bytes().to_vec(), 0),
        Encoding::Utf8Bom => {
            let mut out = Vec::with_capacity(text.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(text.as_bytes());
            (out, 0)
        }
        Encoding::Utf16Le => (encode_utf16(text, false), 0),
        Encoding::Utf16Be => (encode_utf16(text, true), 0),
        _ => encode_legacy(text, enc),
    }
}

/// UTF-16 编码（总是带 BOM，否则下次打开无法可靠识别）。
fn encode_utf16(text: &str, big_endian: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    out.extend_from_slice(if big_endian { &[0xFE, 0xFF] } else { &[0xFF, 0xFE] });
    for unit in text.encode_utf16() {
        let bytes = if big_endian {
            unit.to_be_bytes()
        } else {
            unit.to_le_bytes()
        };
        out.extend_from_slice(&bytes);
    }
    out
}

/// legacy 编码（GBK/Big5/Shift-JIS/EUC-KR/Windows-1252）。
/// 无法映射的字符替换为 `?`，返回替换数量。
fn encode_legacy(text: &str, enc: Encoding) -> (Vec<u8>, usize) {
    use encoding_rs::EncoderResult;

    let rs = enc.rs();
    let mut encoder = rs.new_encoder();
    let mut out = Vec::with_capacity(text.len());
    let mut buf = [0u8; 4096];
    let mut replacements = 0usize;
    let mut src = text;

    loop {
        let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(src, &mut buf, true);
        out.extend_from_slice(&buf[..written]);
        match result {
            EncoderResult::InputEmpty => break,
            EncoderResult::OutputFull => {
                // 缓冲写满：read 是已消费字节数，剩余部分原样重喂
                src = &src[read..];
            }
            EncoderResult::Unmappable(_) => {
                out.push(b'?');
                replacements += 1;
                // read 已越过无法映射的字符；防御 read==0 的极端情况避免死循环
                let advance = if read > 0 {
                    read
                } else {
                    src.chars().next().map(|c| c.len_utf8()).unwrap_or(0)
                };
                src = &src[advance..];
            }
        }
    }
    (out, replacements)
}

/// 无 BOM 场景下的 UTF-16 启发式：成对出现的 NUL 字节是强信号。
///
/// 必须在 UTF-8 校验之前调用 —— 纯 ASCII 的 UTF-16 文本（"H\0e\0l\0l\0o\0"）
/// 因为 NUL 是合法 UTF-8 字节，会被误判为 UTF-8。
fn sniff_utf16_without_bom(bytes: &[u8]) -> Option<Encoding> {
    if bytes.len() < 4 || bytes.len() % 2 != 0 {
        return None;
    }
    let pairs = bytes.len() / 2;
    let mut le_zeros = 0usize;
    let mut be_zeros = 0usize;
    for i in 0..pairs {
        if bytes[2 * i + 1] == 0 {
            le_zeros += 1;
        }
        if bytes[2 * i] == 0 {
            be_zeros += 1;
        }
    }
    let threshold = pairs / 2;
    if le_zeros > threshold && le_zeros > be_zeros {
        return Some(Encoding::Utf16Le);
    }
    if be_zeros > threshold && be_zeros > le_zeros {
        return Some(Encoding::Utf16Be);
    }
    None
}

fn from_rs_name(name: &str) -> Encoding {
    match name {
        "UTF-16LE" => Encoding::Utf16Le,
        "UTF-16BE" => Encoding::Utf16Be,
        "GBK" => Encoding::Gb18030,
        "Big5" => Encoding::Big5,
        "Shift_JIS" => Encoding::ShiftJis,
        "EUC-KR" => Encoding::EucKr,
        _ => Encoding::Windows1252,
    }
}

/// 自动识别编码（不含用户覆盖，覆盖逻辑在 commands 层）。
pub fn detect(bytes: &[u8]) -> Encoding {
    // ① BOM
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return Encoding::Utf8Bom;
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return Encoding::Utf16Le;
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return Encoding::Utf16Be;
    }
    // ② UTF-16 无 BOM
    if let Some(enc) = sniff_utf16_without_bom(bytes) {
        return enc;
    }
    // ③ 合法 UTF-8
    if std::str::from_utf8(bytes).is_ok() {
        return Encoding::Utf8;
    }
    // ④ chardetng 猜测 legacy 编码（allow_utf8 = false，UTF-8 已在上一步排除）
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    from_rs_name(detector.guess(None, false).name())
}

/// 无法用目标编码表示的字符及其位置（行/列从 1 开始）。
#[derive(Debug, Clone, Serialize)]
pub struct UnencodableChar {
    pub ch: String,
    pub line: usize,
    pub col: usize,
}

/// 找出目标编码无法表示的字符，用于保存前的不可逆提示。
///
/// 只在 `encode` 报告 had_errors 时调用，避免对正常文件做逐字符开销。
pub fn unencodable_chars(text: &str, enc: Encoding, limit: usize) -> Vec<UnencodableChar> {
    use encoding_rs::EncoderResult;

    let rs = enc.rs();
    let mut encoder = rs.new_encoder();
    let mut sink = [0u8; 8];
    let mut found = Vec::new();
    let mut line = 1usize;
    let mut col = 1usize;

    for c in text.chars() {
        if c == '\n' {
            line += 1;
            col = 1;
            continue;
        }
        let mut buf = [0u8; 4];
        let s = c.encode_utf8(&mut buf);
        // 返回 (EncoderResult, 已读字节, 已写字节)；无法映射的字符由
        // EncoderResult::Unmappable 表达，因此不需要额外的 bool。
        let (result, _read, _written) =
            encoder.encode_from_utf8_without_replacement(s, &mut sink, true);
        // 不用 PartialEq：匹配分支对 enum 定义没有任何额外要求
        let unencodable = !matches!(result, EncoderResult::InputEmpty);
        if unencodable {
            if found.len() < limit {
                found.push(UnencodableChar {
                    ch: c.to_string(),
                    line,
                    col,
                });
            }
            // 编码器进入错误态，重置后继续统计
            encoder = rs.new_encoder();
        }
        col += 1;
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_roundtrip() {
        let (bytes, replaced) = encode("Hello 世界", Encoding::Utf8);
        assert_eq!(replaced, 0);
        let d = decode(&bytes, Encoding::Utf8);
        assert_eq!(d.text, "Hello 世界");
    }

    #[test]
    fn utf16_roundtrip() {
        for enc in [Encoding::Utf16Le, Encoding::Utf16Be] {
            let (bytes, replaced) = encode("Hello 世界 🚀", enc);
            assert_eq!(replaced, 0);
            // BOM 必须在解码时被吞掉
            assert_eq!(decode(&bytes, enc).text, "Hello 世界 🚀");
        }
    }

    #[test]
    fn unmappable_becomes_question_mark() {
        // あ 无法用 Windows-1252 表示 → 替换为 ?，且不得产生 HTML 数字字符引用
        let (bytes, replaced) = encode("abcあ", Encoding::Windows1252);
        assert_eq!(replaced, 1);
        assert_eq!(bytes, b"abc?");
        assert!(
            !bytes.windows(2).any(|w| w == b"&#"),
            "不得出现 HTML 数字字符引用"
        );
    }

    #[test]
    fn utf8_bom_is_emitted() {
        let (bytes, _) = encode("abc", Encoding::Utf8Bom);
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        // BOM 应在解码时被吞掉
        assert_eq!(decode(&bytes, Encoding::Utf8Bom).text, "abc");
    }

    #[test]
    fn detect_bom() {
        let (bytes, _) = encode("中文内容", Encoding::Utf8Bom);
        assert_eq!(detect(&bytes), Encoding::Utf8Bom);

        let (bytes, _) = encode("中文内容", Encoding::Utf16Le);
        assert_eq!(detect(&bytes), Encoding::Utf16Le);
    }

    #[test]
    fn detect_utf16_without_bom() {
        let (bytes, _) = encode("Hello World", Encoding::Utf16Le);
        let stripped = &bytes[2..]; // 去掉 BOM
        assert_eq!(detect(stripped), Encoding::Utf16Le);
    }

    #[test]
    fn gbk_roundtrip() {
        let (bytes, replaced) = encode("中文测试", Encoding::Gb18030);
        assert_eq!(replaced, 0);
        assert_eq!(decode(&bytes, Encoding::Gb18030).text, "中文测试");
    }

    #[test]
    fn detect_gbk_bytes() {
        // 用足够长的中文让 chardetng 有统计依据；4 字节样本猜测不稳定
        let (bytes, replaced) = encode(
            "这是一段用于编码检测的中文内容，长度需要足够让统计式识别器做出判断。",
            Encoding::Gb18030,
        );
        assert_eq!(replaced, 0);
        assert_eq!(detect(&bytes), Encoding::Gb18030);
        // 内容必须能原样还原
        assert_eq!(decode(&bytes, Encoding::Gb18030).text, "这是一段用于编码检测的中文内容，长度需要足够让统计式识别器做出判断。");
    }

    #[test]
    fn unencodable_reported() {
        // 日文假名无法用 GB18030 之外的西文编码表示
        let found = unencodable_chars("abcあ", Encoding::Windows1252, 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 1);
        assert_eq!(found[0].col, 4);
    }

    #[test]
    fn label_roundtrip() {
        for e in Encoding::all() {
            assert_eq!(Encoding::from_label(e.label()), *e);
        }
    }
}
