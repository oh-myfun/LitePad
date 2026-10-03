//! 编码识别、解码与编码。
//!
//! 支持集（B215）：对齐 Notepad++ 的**全量编码列表** —— Unicode 六项（含两种
//! 不带 BOM 的 UTF-16）、西欧单字节、ISO-8859-1…16、Windows-1250…1258、KOI8-R/U、
//! macintosh、IBM866，以及东亚五套（GB18030 / Big5 / Shift-JIS / EUC-JP /
//! ISO-2022-JP / EUC-KR）。每一项都由 `encoding_rs` 原样支撑，本模块不自带任何
//! 自造码表。
//!
//! 识别顺序（对应方案 4.3）：
//!   ① BOM → ② 用户手动指定（由调用方传入，优先级高于本模块）→
//!   ③ UTF-16 无 BOM 启发式 → ④ 合法 UTF-8 → ⑤ chardetng 统计猜测 → ⑥ 兜底

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    // —— Unicode ——
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    /// UTF-16 LE 不带 BOM（B215）。
    /// ⚠️ 带 BOM 与不带 BOM 是**两套不同的落盘字节**，必须拆成两个条目：
    ///    否则「移除 BOM」只能靠启发式反推，而带/不带 BOM 的可读性差别正是
    ///    Notepad++ 把它们分成两条菜单项的原因。
    Utf16LeNoBom,
    Utf16BeNoBom,
    // —— 单字节：西欧 ——
    Windows1252,
    // —— 单字节：ISO-8859-2 … 8 / 10 / 13 … 16 ——
    // ⚠️ 这里**没有** ISO-8859-1 / -9 / -11 三个：它们都被 WHATWG 编码标准「吞掉」了，
    //    encoding_rs 因此也没有对应的常量 ——
    //    · 8859-1 的 label 直接映射到 windows-1252，所以菜单里只有 Windows-1252 一条；
    //    · 8859-9（土耳其）映射为 windows-1254，也就是下面那条 Windows1254；
    //    · 8859-11（泰文）连 WHATWG label 归属都没有，encoding_rs 无常量，不提供。
    //    Notepad++ 会把它们列成独立条目（背后是各自的 iconv 表）。这里宁可少一条，
    //    也不要给一个**静默映射错**的编码。
    Iso88592,
    Iso88593,
    Iso88594,
    Iso88595,
    Iso88596,
    Iso88597,
    Iso88598,
    Iso885910,
    Iso885913,
    Iso885914,
    Iso885915,
    Iso885916,
    // —— 单字节：Windows-1250 … 1258 ——
    Windows1250,
    Windows1251,
    Windows1253,
    Windows1254,
    Windows1255,
    Windows1256,
    Windows1257,
    Windows1258,
    // —— 单字节：其他 ——
    Koi8R,
    Koi8U,
    Macintosh,
    Ibm866,
    // —— 东亚 ——
    Gb18030,
    Big5,
    ShiftJis,
    EucJp,
    /// ISO-2022-JP：靠**转义序列**切换 ASCII / 日文片假名 / 漢字段，
    /// 是唯一带状态的编码（ encoder 必须跨字符保留 ESC $ B 这类模式），
    /// 所以它的往返测试不能只丢一句短文本。
    Iso2022Jp,
    EucKr,
}

impl Encoding {
    /// 状态栏与配置中展示用的稳定标识，也是前后端传输的契约值。
    pub fn label(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 with BOM",
            Encoding::Utf16Le => "UTF-16LE",
            Encoding::Utf16Be => "UTF-16BE",
            Encoding::Utf16LeNoBom => "UTF-16LE without BOM",
            Encoding::Utf16BeNoBom => "UTF-16BE without BOM",
            Encoding::Windows1252 => "Windows-1252",
            Encoding::Iso88592 => "ISO-8859-2",
            Encoding::Iso88593 => "ISO-8859-3",
            Encoding::Iso88594 => "ISO-8859-4",
            Encoding::Iso88595 => "ISO-8859-5",
            Encoding::Iso88596 => "ISO-8859-6",
            Encoding::Iso88597 => "ISO-8859-7",
            Encoding::Iso88598 => "ISO-8859-8",
            Encoding::Iso885910 => "ISO-8859-10",
            Encoding::Iso885913 => "ISO-8859-13",
            Encoding::Iso885914 => "ISO-8859-14",
            Encoding::Iso885915 => "ISO-8859-15",
            Encoding::Iso885916 => "ISO-8859-16",
            Encoding::Windows1250 => "Windows-1250",
            Encoding::Windows1251 => "Windows-1251",
            Encoding::Windows1253 => "Windows-1253",
            Encoding::Windows1254 => "Windows-1254",
            Encoding::Windows1255 => "Windows-1255",
            Encoding::Windows1256 => "Windows-1256",
            Encoding::Windows1257 => "Windows-1257",
            Encoding::Windows1258 => "Windows-1258",
            Encoding::Koi8R => "KOI8-R",
            Encoding::Koi8U => "KOI8-U",
            Encoding::Macintosh => "macintosh",
            Encoding::Ibm866 => "IBM866",
            Encoding::Gb18030 => "GB18030",
            Encoding::Big5 => "Big5",
            Encoding::ShiftJis => "Shift-JIS",
            Encoding::EucJp => "EUC-JP",
            Encoding::Iso2022Jp => "ISO-2022-JP",
            Encoding::EucKr => "EUC-KR",
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
        // ⚠️ 别名互抢的坑：Shift-JIS 与 ISO-2022-JP 都常被顺手标成「japanese」，
        //    这里只给 Shift-JIS 那个别名，否则 ISO-2022-JP 会被静默写成 Shift-JIS。
        match normalized.as_str() {
            "utf8" => Encoding::Utf8,
            "utf8bom" | "utf8withbom" | "utf8sig" => Encoding::Utf8Bom,
            "utf16le" | "utf16" | "unicode" => Encoding::Utf16Le,
            "utf16be" | "unicodefffe" => Encoding::Utf16Be,
            "utf16lewithoutbom" | "utf16lenobom" => Encoding::Utf16LeNoBom,
            "utf16bewithoutbom" | "utf16benobom" => Encoding::Utf16BeNoBom,
            "gb18030" | "gbk" | "gb2312" | "cp936" | "chinese" | "ansigb2312" => Encoding::Gb18030,
            "big5" | "cp950" | "chinesetrad" => Encoding::Big5,
            "shiftjis" | "sjis" | "cp932" | "japanese" => Encoding::ShiftJis,
            "eucjp" => Encoding::EucJp,
            "iso2022jp" | "iso2022japanese" => Encoding::Iso2022Jp,
            "euckr" | "cp949" | "korean" => Encoding::EucKr,
            // —— 单字节：先收别名，再收「Windows-125x / ISO-8859-x」标准名 ——
            "macintosh" | "mac" | "cp10000" => Encoding::Macintosh,
            "ibm866" | "cp866" => Encoding::Ibm866,
            "koi8r" | "cp878" => Encoding::Koi8R,
            "koi8u" => Encoding::Koi8U,
            "windows1250" | "cp1250" => Encoding::Windows1250,
            "windows1251" | "cp1251" => Encoding::Windows1251,
            "windows1252" | "cp1252" | "ansi" | "ascii" => Encoding::Windows1252,
            "windows1253" | "cp1253" => Encoding::Windows1253,
            "windows1254" | "cp1254" | "turkish" => Encoding::Windows1254,
            "windows1255" | "cp1255" | "hebrew" => Encoding::Windows1255,
            "windows1256" | "cp1256" | "arabic" => Encoding::Windows1256,
            "windows1257" | "cp1257" | "baltic" => Encoding::Windows1257,
            "windows1258" | "cp1258" | "vietnamese" => Encoding::Windows1258,
            // ISO-8859-1 / -9 的 label 在 WHATWG 里分别就是 windows-1252 / windows-1254，
            // 所以这两个别名**落到已有条目上**，不是「缺一条就回落 UTF-8」。
            "iso88591" | "latin1" | "l1" => Encoding::Windows1252,
            "iso88592" | "latin2" => Encoding::Iso88592,
            "iso88593" | "latin3" => Encoding::Iso88593,
            "iso88594" | "latin4" => Encoding::Iso88594,
            "iso88595" | "cyrillic" => Encoding::Iso88595,
            "iso88596" | "arabic88596" => Encoding::Iso88596,
            "iso88597" | "greek" => Encoding::Iso88597,
            "iso88598" | "hebrew88598" => Encoding::Iso88598,
            "iso88599" | "latin5" => Encoding::Windows1254,
            "iso885910" | "latin6" => Encoding::Iso885910,
            "iso885913" | "latin7" => Encoding::Iso885913,
            "iso885914" | "latin8" => Encoding::Iso885914,
            "iso885915" | "latin9" => Encoding::Iso885915,
            "iso885916" | "latin10" => Encoding::Iso885916,
            _ => Encoding::Utf8,
        }
    }

    /// 菜单与下拉的展示顺序：Unicode → 西欧 ISO → Windows-125x → 其他单字节 → 东亚。
    /// ⚠️ 顺序是**契约**：前端「编码」菜单、设置页「默认编码」下拉、状态栏菜单
    ///    全都按这个顺序渲染（B215）。新增条目请就近插入，别追加到末尾。
    pub fn all() -> &'static [Encoding] {
        &[
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16LeNoBom,
            Encoding::Utf16Be,
            Encoding::Utf16BeNoBom,
            // 西欧：Windows-1252（= WHATWG 语义下的 ISO-8859-1）打头，紧接 ISO-8859-2 起
            Encoding::Windows1252,
            Encoding::Iso88592,
            Encoding::Iso88593,
            Encoding::Iso88594,
            Encoding::Iso88595,
            Encoding::Iso88596,
            Encoding::Iso88597,
            Encoding::Iso88598,
            Encoding::Iso885910,
            Encoding::Iso885913,
            Encoding::Iso885914,
            Encoding::Iso885915,
            Encoding::Iso885916,
            // Windows-125x
            Encoding::Windows1250,
            Encoding::Windows1251,
            Encoding::Windows1253,
            Encoding::Windows1254,
            Encoding::Windows1255,
            Encoding::Windows1256,
            Encoding::Windows1257,
            Encoding::Windows1258,
            // 其他单字节
            Encoding::Koi8R,
            Encoding::Koi8U,
            Encoding::Macintosh,
            Encoding::Ibm866,
            // 东亚
            Encoding::Gb18030,
            Encoding::Big5,
            Encoding::ShiftJis,
            Encoding::EucJp,
            Encoding::Iso2022Jp,
            Encoding::EucKr,
        ]
    }

    fn rs(&self) -> &'static encoding_rs::Encoding {
        match self {
            Encoding::Utf8 | Encoding::Utf8Bom => encoding_rs::UTF_8,
            Encoding::Utf16Le | Encoding::Utf16LeNoBom => encoding_rs::UTF_16LE,
            Encoding::Utf16Be | Encoding::Utf16BeNoBom => encoding_rs::UTF_16BE,
            // ISO-8859-1 在 WHATWG 里就是 windows-1252， encoding_rs 没有前者的常量
            Encoding::Windows1252 => encoding_rs::WINDOWS_1252,
            Encoding::Iso88592 => encoding_rs::ISO_8859_2,
            Encoding::Iso88593 => encoding_rs::ISO_8859_3,
            Encoding::Iso88594 => encoding_rs::ISO_8859_4,
            Encoding::Iso88595 => encoding_rs::ISO_8859_5,
            Encoding::Iso88596 => encoding_rs::ISO_8859_6,
            Encoding::Iso88597 => encoding_rs::ISO_8859_7,
            Encoding::Iso88598 => encoding_rs::ISO_8859_8,
            Encoding::Iso885910 => encoding_rs::ISO_8859_10,
            Encoding::Iso885913 => encoding_rs::ISO_8859_13,
            Encoding::Iso885914 => encoding_rs::ISO_8859_14,
            Encoding::Iso885915 => encoding_rs::ISO_8859_15,
            Encoding::Iso885916 => encoding_rs::ISO_8859_16,
            Encoding::Windows1250 => encoding_rs::WINDOWS_1250,
            Encoding::Windows1251 => encoding_rs::WINDOWS_1251,
            Encoding::Windows1253 => encoding_rs::WINDOWS_1253,
            Encoding::Windows1254 => encoding_rs::WINDOWS_1254,
            Encoding::Windows1255 => encoding_rs::WINDOWS_1255,
            Encoding::Windows1256 => encoding_rs::WINDOWS_1256,
            Encoding::Windows1257 => encoding_rs::WINDOWS_1257,
            Encoding::Windows1258 => encoding_rs::WINDOWS_1258,
            Encoding::Koi8R => encoding_rs::KOI8_R,
            Encoding::Koi8U => encoding_rs::KOI8_U,
            Encoding::Macintosh => encoding_rs::MACINTOSH,
            Encoding::Ibm866 => encoding_rs::IBM866,
            Encoding::Gb18030 => encoding_rs::GB18030,
            Encoding::Big5 => encoding_rs::BIG5,
            Encoding::ShiftJis => encoding_rs::SHIFT_JIS,
            Encoding::EucJp => encoding_rs::EUC_JP,
            Encoding::Iso2022Jp => encoding_rs::ISO_2022_JP,
            Encoding::EucKr => encoding_rs::EUC_KR,
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
        Encoding::Utf16Le => (encode_utf16(text, false, true), 0),
        Encoding::Utf16Be => (encode_utf16(text, true, true), 0),
        Encoding::Utf16LeNoBom => (encode_utf16(text, false, false), 0),
        Encoding::Utf16BeNoBom => (encode_utf16(text, true, false), 0),
        _ => encode_legacy(text, enc),
    }
}

/// UTF-16 编码。`bom = true`（默认）时前置 BOM —— 下次打开时能*确定*认出编码；
/// `bom = false` 是用户显式要求「without BOM」，此时靠 `detect` 的 NUL 对启发式认。
fn encode_utf16(text: &str, big_endian: bool, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    if bom {
        out.extend_from_slice(if big_endian {
            &[0xFE, 0xFF]
        } else {
            &[0xFF, 0xFE]
        });
    }
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
///
/// 返回的是**不带 BOM 的变体**（B215）：字节里本来就没有 BOM，返回的编码必须
/// 与磁盘字节对得上，否则「刚写出去的文件，重新打开就换了个编码名」。
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
        return Some(Encoding::Utf16LeNoBom);
    }
    if be_zeros > threshold && be_zeros > le_zeros {
        return Some(Encoding::Utf16BeNoBom);
    }
    None
}

/// chardetng 的猜测结果（`encoding_rs::Encoding::name()`）→ 内部编码。
///
/// ⚠️ **别手写一张「WHATWG 名 → 枚举」的对照表**（B215 的教训）：chardetng 返回
///    的名字大小写与分隔符都不统一（`Shift_JIS` / `EUC-JP` / `windows-1252`），
///    手工抄表就会漏掉新编码 —— 漏掉的那一条会静默落到默认分支，用户于是看到
///    一个完全错误的编码，而且**不会有任何报错**。
///    `from_label` 本来就是「忽略 `-`/`_`/空格 + 大小写」的容错解析，直接复用它：
///    新编码只要进了 `from_label`，就自动被 `detect` 认出来。
fn from_rs_name(name: &str) -> Encoding {
    Encoding::from_label(name)
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
    // ② UTF-16 无 BOM → 判据是**不带 BOM 的变体**（B215）：这样状态栏显示的编码
    //    与磁盘上真实的字节一致；若这里返回带 BOM 的变体，用户下次打开同一个文件
    //    会看到「UTF-16LE → UTF-16LE without BOM 反复跳」。
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
        // 带 BOM 写出来 → 去掉 BOM 之后必须认成「without BOM」那一档：
        // 若这里返回带 BOM 的变体，同一个文件每打开一次编码名就跳一次。
        let (bytes, _) = encode("Hello World", Encoding::Utf16Le);
        let stripped = &bytes[2..]; // 去掉 BOM
        assert_eq!(detect(stripped), Encoding::Utf16LeNoBom);

        let (bytes, _) = encode("Hello World", Encoding::Utf16LeNoBom);
        assert_eq!(detect(&bytes), Encoding::Utf16LeNoBom);
        assert_ne!(bytes[..2], [0xFF, 0xFE], "without BOM 不得写 BOM");
    }

    #[test]
    fn no_bom_utf16_starts_without_bom_marker() {
        for enc in [Encoding::Utf16LeNoBom, Encoding::Utf16BeNoBom] {
            let (bytes, replaced) = encode("日本語abc", enc);
            assert_eq!(replaced, 0);
            assert!(!bytes.starts_with(&[0xFF, 0xFE]) && !bytes.starts_with(&[0xFE, 0xFF]));
            assert_eq!(decode(&bytes, enc).text, "日本語abc");
        }
    }

    /// ASCII 在**全部**编码里都是单字节可映射的，所以它可以作为一遍全量往返的判据。
    /// （含中文的样本过不了 ISO-8859-x，那样测的就不是「每个编码都能用」了。）
    #[test]
    fn ascii_roundtrip_for_every_encoding() {
        const ASCII: &str = "Hello, World! 0123456789 ~";
        for enc in Encoding::all() {
            let (bytes, replaced) = encode(ASCII, *enc);
            assert_eq!(replaced, 0, "{} 不得替换 ASCII", enc.label());
            assert_eq!(decode(&bytes, *enc).text, ASCII, "{} 往返失真", enc.label());
        }
    }

    /// 状态编码最容易在「跨字符保留转义态」上翻车，短样本（纯 ASCII）根本测不出来。
    #[test]
    fn iso2022jp_is_stateful_and_roundtrips() {
        let text = "日本語のテキスト\n2行目";
        let (bytes, replaced) = encode(text, Encoding::Iso2022Jp);
        assert_eq!(replaced, 0);
        // 7-bit 编码：字节流里不该出现 NUL（顺带证明它和 UTF-16 走的是两条路）
        assert!(!bytes.contains(&0), "ISO-2022-JP 是 7-bit 编码，不该有 NUL");
        assert_eq!(decode(&bytes, Encoding::Iso2022Jp).text, text);
        // ⚠️ 下面两条是判据本身，不是凑数：只做「往返相等」的话，把 ISO-2022-JP
        //    在 `rs()` 里退化成 UTF-8 照样绿 —— 因为 encode/decode 会一起变成 UTF-8，
        //    纯 ASCII 往返永远成立（这条测试就变成一块假绿）。
        //    只有断言「字节确实不是 UTF-8 的字节」，才真的绑住了那张映射表。
        let (sjis, _) = encode(text, Encoding::ShiftJis);
        assert_ne!(bytes, sjis, "ISO-2022-JP 不得写出和 Shift-JIS 一样的字节");
        let (utf8, _) = encode(text, Encoding::Utf8);
        assert_ne!(bytes, utf8, "ISO-2022-JP 不得退化成 UTF-8 的字节");
    }

    /// 别名互抢回归（B215）：Shift-JIS 与 ISO-2022-JP 都常被顺手标成 "japanese"。
    #[test]
    fn iso2022jp_alias_is_not_swallowed_by_shiftjis() {
        assert_eq!(Encoding::from_label("ISO-2022-JP"), Encoding::Iso2022Jp);
        assert_eq!(
            Encoding::from_label("iso-2022-japanese"),
            Encoding::Iso2022Jp
        );
        assert_eq!(Encoding::from_label("Shift-JIS"), Encoding::ShiftJis);
        assert_eq!(Encoding::from_label("japanese"), Encoding::ShiftJis);
        // chardetng 给回来的名字照原样（大小写、下划线都不规整）也要能认
        assert_eq!(Encoding::from_label("Shift_JIS"), Encoding::ShiftJis);
        assert_eq!(Encoding::from_label("windows-1252"), Encoding::Windows1252);
        assert_eq!(Encoding::from_label("KOI8-R"), Encoding::Koi8R);
        assert_eq!(Encoding::from_label("macintosh"), Encoding::Macintosh);
        assert_eq!(Encoding::from_label("IBM866"), Encoding::Ibm866);
    }

    /// 全量菜单里必须有 Notepad++ 用户会去找的那几条（漏一条就是「菜单里没有它」）。
    #[test]
    fn full_menu_contains_the_expected_encodings() {
        let labels: Vec<&str> = Encoding::all().iter().map(|e| e.label()).collect();
        for want in [
            "UTF-8",
            "UTF-8 with BOM",
            "UTF-16LE",
            "UTF-16LE without BOM",
            "UTF-16BE",
            "UTF-16BE without BOM",
            "Windows-1252",
            "ISO-8859-2",
            "ISO-8859-7",
            "ISO-8859-16",
            "Windows-1250",
            "Windows-1251",
            "Windows-1254",
            "Windows-1256",
            "KOI8-R",
            "KOI8-U",
            "macintosh",
            "IBM866",
            "GB18030",
            "Big5",
            "Shift-JIS",
            "EUC-JP",
            "ISO-2022-JP",
            "EUC-KR",
        ] {
            assert!(labels.contains(&want), "菜单缺少 {want}");
        }
        // 反向守住「该少的别加进来」：8859-1 在 WHATWG 里就是 windows-1252、8859-9 是
        // windows-1254，把它们列成独立条目只会骗用户「点一条、写出另一种字节」，
        // 而且这两条压根没有 encoding_rs 常量可映射（-11 同理，连归属都没有）。
        for banned in ["ISO-8859-1", "ISO-8859-9", "ISO-8859-11", "ISO-8859-12"] {
            assert!(!labels.contains(&banned), "菜单不该出现 {banned}");
        }
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
        assert_eq!(
            decode(&bytes, Encoding::Gb18030).text,
            "这是一段用于编码检测的中文内容，长度需要足够让统计式识别器做出判断。"
        );
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
