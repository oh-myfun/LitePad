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
    /// GB2312（B218）：**Windows 中文环境的默认旧码页**（CP936 的 GB2312 区）。
    /// ⚠️ `encoding_rs` 没有独立的 GB2312 编码器 —— `gb2312` 只是它的一个 **label**，
    ///     `for_label("gb2312")` 直接返回 GB18030。所以下面 `rs()` 复用 `GB18030`：
    ///     GB2312 的字符集是 GB18030 的真子集，字节层面完全兼容（能解出来的都一样，
    ///     能写回去的也一样），把它列成一条只影响**名字**，不影响正确性。
    ///     Notepad++ 也是 GB2312 / GBK / GB18030 三条并排，背后各自带字符集校验。
    Gb2312,
    /// GBK（B218）：CP936，Windows 简体中文的实际实现。
    /// ⚠️ 它与 GB18030 是 encoding_rs 的**两个不同常量**（不是别名）：GBK 的表里
    ///    有一批落在私有区、另外它不吃 GB18030 的四字节扩展区。所以「转换为 GBK」
    ///    真的会提示「这些字符 GBK 表示不了」（Notepad++ 也是这么分开的），
    ///    不是一句空话 —— 这条现在会被不可逆保护对话框抓到，别顺手改回 GB18030。
    Gbk,
    Gb18030,
    Big5,
    /// Big5-HKSCS（B218）：繁体中文 + 香港增补字符集（CP950 的 HKSCS 扩展区）。
    /// `encoding_rs` 的 `BIG5` 常量**本身就是「带 HKSCS 映射的 Big5」**（它的文档明说
    ///     「This is Big5 with HKSCS with mappings to more recent Unicode assignments」），
    ///     所以这一条也复用 `BIG5`：HKSCS 区本来就在表里，不是另起一套。
    Big5Hkscs,
    ShiftJis,
    EucJp,
    /// ISO-2022-JP：靠**转义序列**切换 ASCII / 日文片假名 / 漢字段，
    /// 是唯一带状态的编码（ encoder 必须跨字符保留 ESC $ B 这类模式），
    /// 所以它的往返测试不能只丢一句短文本。
    Iso2022Jp,
    EucKr,
}

/// 菜单里的一条编码（B218）：`label` 是**原样传回后端的标识**（`Encoding::from_label`
/// 认它），`group` 是它所属的语言组名（前端就按这个 `group` 切出「首组内联 +
/// 其余组子菜单」那几级，别再弄一套插在条目中间的小标题，见 `all()`）。
///
/// ⚠️ 前端拿这份扁平列表自己按 `group` 排两级菜单，**不要**再手抄一份编码清单
///    —— 两份迟早差一条，而差的那一条表现就是「菜单里有、功能没接上」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncodingItem {
    pub label: &'static str,
    pub group: &'static str,
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
            Encoding::Gb2312 => "GB2312",
            Encoding::Gbk => "GBK",
            Encoding::Gb18030 => "GB18030",
            Encoding::Big5 => "Big5",
            Encoding::Big5Hkscs => "Big5-HKSCS",
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
            // 中文（B218）：三条名字各自成条，但落到同一套字节上（见各变体说明）。
            //   别名按 WHATWG 的 label 表收录 —— `gb2312`/`gbk` 在 encoding_rs 里
            //   本来就是 gb18030 的 label，并列出来只是让「中文常用字符集」找得到。
            "gb2312" | "gb231280" | "csiso58gb231280" | "csgb2312" | "hzgb2312" | "chinese"
            | "ansigb2312" => Encoding::Gb2312,
            "gbk" | "xgbk" | "cp936" => Encoding::Gbk,
            "gb18030" => Encoding::Gb18030,
            "big5" | "csbig5" | "cp950" | "chinesetrad" => Encoding::Big5,
            "big5hkscs" => Encoding::Big5Hkscs,
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

    /// 菜单与下拉的展示顺序（B218 起按**语言分组**排列，同组必须连续）：
    ///   Unicode → 拉丁 → 西里尔 → 希腊 → 希伯来 → 阿拉伯 → 中文 → 日文 → 韩文。
    /// ⚠️ 顺序与分组都是**契约**：前端「编码」菜单、设置页「默认编码」下拉、
    ///    状态栏菜单全都按这个顺序渲染（B215），分组名由 `group()` 现取。
    ///    新增条目请插进它该属的那一组里，别追加到末尾（那会把它顶到别的组底下）。
    /// ⚠️ **label 必须唯一**：菜单里同一个编码出现两次就是「重复选项」（两个一模一样
    ///    的条目、各挂一个对勾）。重复项往往同组且相邻，分组连续性断言抓不住，
    ///    所以另有一条 `menu_entries_have_no_duplicate_labels` 盯着。
    pub fn all() -> &'static [Encoding] {
        &[
            // —— Unicode ——
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16LeNoBom,
            Encoding::Utf16Be,
            Encoding::Utf16BeNoBom,
            // —— 拉丁字母：西欧 / 中欧 / 北欧 / 土耳其 / 越南 + macintosh 旧罗马 ——
            Encoding::Windows1252,
            Encoding::Iso88592,
            Encoding::Iso88593,
            Encoding::Iso88594,
            Encoding::Iso885910,
            Encoding::Iso885913,
            Encoding::Iso885914,
            Encoding::Iso885915,
            Encoding::Iso885916,
            Encoding::Windows1250,
            Encoding::Windows1254,
            Encoding::Windows1257,
            Encoding::Windows1258,
            Encoding::Macintosh,
            // —— 西里尔字母（含 IBM866 那套 OEM 西里尔）——
            Encoding::Windows1251,
            Encoding::Iso88595,
            Encoding::Koi8R,
            Encoding::Koi8U,
            Encoding::Ibm866,
            // —— 希腊字母 ——
            Encoding::Windows1253,
            Encoding::Iso88597,
            // —— 希伯来字母 ——
            Encoding::Windows1255,
            Encoding::Iso88598,
            // —— 阿拉伯字母 ——
            Encoding::Windows1256,
            Encoding::Iso88596,
            // —— 中文：先简体（GB2312/GBK/GB18030），再繁体（Big5 / Big5-HKSCS）——
            Encoding::Gb2312,
            Encoding::Gbk,
            Encoding::Gb18030,
            Encoding::Big5,
            Encoding::Big5Hkscs,
            // —— 日文 ——
            Encoding::ShiftJis,
            Encoding::EucJp,
            Encoding::Iso2022Jp,
            // —— 韩文 ——
            Encoding::EucKr,
        ]
    }

    /// 所属语言 / 文字体系（B218）:菜单上的语言子菜单入口名就取这个值。
    ///
    /// ⚠️ 返回的是**直接能显示给用户的中文**，而不是 `Unicode`/`Chinese` 这种
    ///    内部标识：前端拿它只做「与上一条相不相同」的判断，不需要再维护一张
    ///    名字 → 标题的对照表（两张表迟早差一项）。
    pub fn group(&self) -> &'static str {
        match self {
            Encoding::Utf8
            | Encoding::Utf8Bom
            | Encoding::Utf16Le
            | Encoding::Utf16LeNoBom
            | Encoding::Utf16Be
            | Encoding::Utf16BeNoBom => "Unicode（统一码）",
            Encoding::Windows1252
            | Encoding::Iso88592
            | Encoding::Iso88593
            | Encoding::Iso88594
            | Encoding::Iso885910
            | Encoding::Iso885913
            | Encoding::Iso885914
            | Encoding::Iso885915
            | Encoding::Iso885916
            | Encoding::Windows1250
            | Encoding::Windows1254
            | Encoding::Windows1257
            | Encoding::Windows1258
            | Encoding::Macintosh => "拉丁字母",
            Encoding::Windows1251
            | Encoding::Iso88595
            | Encoding::Koi8R
            | Encoding::Koi8U
            | Encoding::Ibm866 => "西里尔字母",
            Encoding::Windows1253 | Encoding::Iso88597 => "希腊字母",
            Encoding::Windows1255 | Encoding::Iso88598 => "希伯来字母",
            Encoding::Windows1256 | Encoding::Iso88596 => "阿拉伯字母",
            Encoding::Gb2312
            | Encoding::Gbk
            | Encoding::Gb18030
            | Encoding::Big5
            | Encoding::Big5Hkscs => "中文（简体 / 繁体）",
            Encoding::ShiftJis | Encoding::EucJp | Encoding::Iso2022Jp => "日文",
            Encoding::EucKr => "韩文",
        }
    }

    /// 全部菜单条目（label + 分组），供 `list_encodings` 一次性下发。
    /// 顺序 == `all()`，所以前端只要按 `group` 变化插标题就行。
    pub fn items() -> Vec<EncodingItem> {
        Self::all()
            .iter()
            .map(|e| EncodingItem {
                label: e.label(),
                group: e.group(),
            })
            .collect()
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
            // B218：GB2312 没有独立常量（它是 GB18030 的 label），复用 GB18030 那张表；
            //       GBK 则是 encoding_rs 的**真常量**（见 `Gbk` 变体说明），两张表不同；
            //       Big5-HKSCS 走 BIG5（HKSCS 区本来就在它表里）。
            Encoding::Gb2312 => encoding_rs::GB18030,
            Encoding::Gbk => encoding_rs::GBK,
            Encoding::Gb18030 => encoding_rs::GB18030,
            Encoding::Big5 | Encoding::Big5Hkscs => encoding_rs::BIG5,
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

    /// 中文（B218）：Windows 中文环境真正常用的几条必须在菜单里 —— 用户点开
    ///    「编码 → 转换为…」第一件事就是找它，少一条就变成「菜单里没有」。
    #[test]
    fn chinese_group_lists_the_familiar_windows_charsets() {
        const NAMES: [&str; 5] = ["GB2312", "GBK", "GB18030", "Big5", "Big5-HKSCS"];
        let labels: Vec<&str> = Encoding::all().iter().map(|e| e.label()).collect();
        for want in NAMES {
            assert!(labels.contains(&want), "菜单缺少 {want}");
        }
        // 三条中文名字各有一条可点，且 from_label 认得它们（状态栏/会话都靠这条回来）
        assert_eq!(Encoding::from_label("GB2312"), Encoding::Gb2312);
        assert_eq!(Encoding::from_label("GBK"), Encoding::Gbk);
        assert_eq!(Encoding::from_label("Big5-HKSCS"), Encoding::Big5Hkscs);
        // 老别名不能因此掉队（系统 API / Notepad++ 回过来的名字）
        assert_eq!(Encoding::from_label("gb2312"), Encoding::Gb2312);
        assert_eq!(Encoding::from_label("cp936"), Encoding::Gbk);
        assert_eq!(Encoding::from_label("cp950"), Encoding::Big5);
        assert_eq!(Encoding::from_label("chinese"), Encoding::Gb2312);
    }

    /// 五条中文字符集必须**同组**，且组名认得出是中文 —— 菜单上那条中文子菜单
    ///    入口就取这个值，写歪了用户看到的就是一串没头没尾的字。
    #[test]
    fn the_chinese_charsets_share_one_group() {
        const NAMES: [&str; 5] = ["GB2312", "GBK", "GB18030", "Big5", "Big5-HKSCS"];
        let items = Encoding::items();
        let labels: Vec<&str> = items.iter().map(|i| i.label).collect();
        let groups: Vec<&str> = items.iter().map(|i| i.group).collect();

        let at = |name: &str| -> usize {
            labels
                .iter()
                .position(|l| *l == name)
                .unwrap_or_else(|| panic!("菜单缺少 {name}"))
        };
        let group = groups[at("GB2312")];
        // 简体三条在前、繁体两条在后，而且五条连成一截（不然菜单里的标题会插错位置）
        assert!(labels[..at("GB2312")].iter().all(|l| !NAMES.contains(l)));
        assert_eq!(labels[at("GB2312")..=at("Big5-HKSCS")], NAMES);
        for name in NAMES {
            assert_eq!(groups[at(name)], group, "{name} 必须与 GB2312 同组");
        }
        assert!(
            group.contains("中文"),
            "中文那几条的组标题得认得出是中文：{group}"
        );
    }

    /// 分组（B218）：菜单是按「上一条 group 变了就插一个标题」拼的，所以同一组
    ///    必须**连续**。一旦有人把新条目追加到 all() 末尾，这条会先炸。
    #[test]
    fn items_are_grouped_contiguously() {
        let items = Encoding::items();
        // started 记的是「已经开过头」的分组；换组时若新组在 started 里，
        // 说明它前面已经出现过一次 —— 也就是这一组被拆成了两截。
        let mut started: Vec<&str> = Vec::new();
        let mut prev: Option<&str> = None;
        for (i, item) in items.iter().enumerate() {
            let group = item.group;
            if let Some(p) = prev {
                if p != group {
                    assert!(
                        !started.contains(&group),
                        "分组「{group}」被拆成两截（第 {i} 条 {}）",
                        item.label
                    );
                }
            }
            if started.last() != Some(&group) {
                started.push(group);
            }
            prev = Some(group);
        }
        // 组数（B218 定的 9 个语言/文字体系）也一并锁住，别让分组悄悄合并掉
        assert_eq!(started.len(), 9, "语言分组数量变了：{started:?}");
    }

    /// 菜单里同一个编码绝不能出现两次 —— 上一次「解码 / 转换菜单出现重复选项」就是
    /// `all()` 开头残留了四条旧头、和下面的 Unicode 组重了一遍。
    /// ⚠️ 分组连续性断言抓不住这种重复：重复项**同组且相邻**，「每组连续」「正好 9 组」
    ///    两条全绿，可用户看到的就是两个一模一样的条目、各挂一个对勾。所以这里按
    ///    label 做唯一性硬断言（`sort` + `dedup` 后长度必须等于原长）。
    #[test]
    fn menu_entries_have_no_duplicate_labels() {
        let items = Encoding::items();
        assert!(!items.is_empty(), "菜单条目是空的，下面的断言没意义");
        let mut labels: Vec<&str> = items.iter().map(|i| i.label).collect();
        let original = labels.len();
        labels.sort_unstable();
        let mut seen: Vec<&str> = Vec::new();
        let mut duplicates: Vec<&str> = Vec::new();
        for label in labels.iter() {
            if seen.contains(label) && !duplicates.contains(label) {
                duplicates.push(label);
            }
            seen.push(label);
        }
        assert!(
            duplicates.is_empty(),
            "同一条编码在菜单里出现了多次：{duplicates:?}"
        );
        labels.dedup();
        assert_eq!(
            labels.len(),
            original,
            "菜单条数被改掉了：{original} -> {}",
            labels.len()
        );
    }

    /// 三条中文条目的落点必须是**各自那张表**：GB2312 与 GB18030 共用一张、GBK 独占、
    /// Big5-HKSCS 与 Big5 共用一张。判据取常量本身 —— 只断言「往返相等」的话，
    /// 把 GB2312 落到 BIG5 上照样绿（往返会一起变，假绿一块）。
    #[test]
    fn chinese_variants_maps_to_the_right_tables() {
        assert_eq!(Encoding::Gb2312.rs(), encoding_rs::GB18030);
        assert_eq!(Encoding::Gbk.rs(), encoding_rs::GBK);
        assert_eq!(Encoding::Gb18030.rs(), encoding_rs::GB18030);
        assert_eq!(Encoding::Big5.rs(), encoding_rs::BIG5);
        assert_eq!(Encoding::Big5Hkscs.rs(), encoding_rs::BIG5);
        // 光「是 encoding_rs 的某个常量」还不够：GBK 那条如果落回 GB18030，
        // 就无法真的报出「这字儿 GBK 写不了」，用户会以为编辑器在骗他。
        assert_ne!(Encoding::Gbk.rs(), Encoding::Gb18030.rs());
    }

    /// 往返：简体走三张简体表、繁体走 Big5 —— 顺带证明「复用同一张表」不是空话。
    #[test]
    fn chinese_charsets_roundtrip_on_their_own_tables() {
        let zh = "这是一段中文内容，用来证明中文条目各自都能原样回来。";
        for enc in [Encoding::Gb2312, Encoding::Gbk, Encoding::Gb18030] {
            let (bytes, replaced) = encode(zh, enc);
            assert_eq!(replaced, 0, "{} 不该替换字符", enc.label());
            assert_eq!(decode(&bytes, enc).text, zh);
        }
        // 繁体样本（「这」「内」这类简写体 Big5 根本没有，塞进去只会得到豆腐块，
        // 所以这条只能用繁体文本，否则测的就不是往返而是 Big5 的缺失）
        let tw = "繁體中文測試：證明 Big5 與 Big5-HKSCS 是同一套字節。";
        for enc in [Encoding::Big5, Encoding::Big5Hkscs] {
            let (bytes, replaced) = encode(tw, enc);
            assert_eq!(replaced, 0, "{} 不该替换字符", enc.label());
            assert_eq!(decode(&bytes, enc).text, tw);
            assert_eq!(decode(&bytes, Encoding::Big5Hkscs).text, tw);
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
        // 猜出来是 GBK 而不是 GB18030：chardetng 自己就是用 encoding_rs::GBK 给中文
        // 打分的（它的 EUC_KR 扣分基准直接取 GBK_PUA_PENALTY）。之前 "gbk" 这个
        // 别名被并进 GB18030，于是识别结果报 GB18030、实际解码器却是 GBK；现在
        // 两条分开，状态栏报的名字和真正用来解码的那张表对得上了。
        assert_eq!(detect(&bytes), Encoding::Gbk);
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
