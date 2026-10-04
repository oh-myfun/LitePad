//! 系统字体枚举（B227）—— 设置页选字体用。
//!
//! 为什么不用「手抄一份候选清单」：字体是**装在用户机器上**的，清单在别人机器上
//! 必然对不上（装了什么、装了几个字重、是不是等宽，全都因人而异）。所以这里直接问
//! Windows 要一份真实清单，前端那份「未安装」标注（settingsdialog 的
//! `isFontInstalled` 像素比对）只保留给**内嵌字体之外**的手选历史值。
//!
//! # B234 四处修正（实测本机 280 条 → 132 条，等宽桶 244 条误判 → 22 条正确）
//!
//! ① **`is_monospace` 原判定失效**：只看 `TEXTMETRICW.tmPitchAndFamily` 的
//!    `TMPF_FIXED_PITCH` 位，对 **CJK 与很多 UI 字体不可靠** —— 实测 280 条里
//!    **244 条被判成等宽**，`Arial` / `Segoe UI` / `Times New Roman` / `微软雅黑`
//!    全中。结果「正文字体」那栏几乎列不出非等宽字体。
//!    ⇒ 改为**实测字宽**：把字体选进 DC，逐个量 ASCII 字符的宽度；只要存在
//!    **宽度不一致**的字符就判非等宽（等宽字体全角半角同宽，这正是编辑器要的）。
//! ② **字重变体按族名算不同名字**：`Cascadia Code` / `Cascadia Code Light` /
//!    `SemiBold` / `ExtraLight` 各占一行，`Segoe UI` 家族有十几行 —— 而应用内嵌的
//!    字体只有 Regular 一个字重，选变体没有对应资源。
//!    ⇒ 按**基础族名**去重（剥掉 `@` 前缀与 Light/Regular/Semibold… 后缀）。
//! ③ `@` 前缀重复：GDI 对同一字体同时给出 `@Noto Sans SC` 与 `Noto Sans SC`，
//!    `@` 那份是 GDI 的「字符集限定副本」，对用户是同一款字体。
//! ④ **设备/装饰字体漏网**：`TMPF_DEVICE` 只覆盖 Fixedsys / Terminal，
//!    而 `Apple ][`、Emoji 字体照样被枚举出来 ⇒ 加名字黑名单；
//!    另外 **CJK 宋体/黑体/楷体**（`宋体`、`仿宋`…）ASCII 部分实测也是等宽，
//!    但不是编辑器要的等宽字体 ⇒ 族名含 CJK 字符的一律不进等宽桶。
//!
//! 设备字体（终端、Fixedsys 那一类）仍直接剔掉：能被枚举到，但不能当正文字体选。
//!
//! ⚠️ 同一族名会按字重/斜体被枚举多次，去重后留第一条。
//!
//! ⚠️ 字宽实测那段是 `unsafe` 的 Win32 调用，只在 `cfg(windows)` 下编译；
//!    其它平台返回空列表，前端那一栏就只剩内嵌字体。

use serde::Serialize;

/// 一条字体候选。等宽那批由设置页单独一栏列。
#[derive(Clone, Debug, Serialize)]
pub struct FontItem {
    /// 族名，可直接当 CSS `font-family` 用（带空格的由前端加引号）。
    pub name: String,
    /// 是否等宽（实测 ASCII 字符宽度是否一致，见 `is_monospace_by_width`）。
    pub is_monospace: bool,
}

/// 枚举本机字体。等宽的排在前面，同组内按名称字典序 —— 列表顺序稳定，
/// 设置页两次打开不会跳位。
pub fn list_fonts() -> Vec<FontItem> {
    #[cfg(windows)]
    {
        collect_windows()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// 字重/字形后缀表。**只列已知的**，不做正则猜测 —— 字体名里带空格的极多
/// （`Microsoft YaHei UI`、`Segoe UI Variable Small Semibold`），
/// 猜错会把两款不同字体合并掉；宁可多列一条，也不要错并。
const STYLE_SUFFIXES: &[&str] = &[
    " ExtraLight",
    " ExtraBold",
    " Extrabold",
    " ExtraCondensed",
    " SemiCondensed",
    " Condensed",
    " SemiBold",
    " Semibold",
    " Semilight",
    " SemiLight",
    " DemiLight",
    " DemiBold",
    " Black",
    " Bold",
    " Light",
    " Medium",
    " Regular",
    " Italic",
    " Oblique",
    " Thin",
    " Heavy",
];

/// 设备字体 / 装饰字体：能被 GDI 枚举到，但**不该作为编辑器字体**出现在候选里。
///
/// B234：GDI 的 `TMPF_DEVICE` 位只覆盖了 Fixedsys / Terminal 这一类，
/// 而字体**名字**本身就写着「不是正文」的（`Apple ][` 是彩苹果、Emoji 字体…）
/// 也照样会被枚举出来。列一份名字黑名单兜住后者。
const NOT_TEXT_FONTS: &[&str] = &[
    "Apple ][",
    "Fixedsys",
    "Terminal",
    "Segoe Fluent Icons",
    "Segoe MDL2 Assets",
    "Segoe UI Emoji",
    "Segoe UI Historic",
    "Segoe UI Symbol",
    "Microsoft Sans Serif",
    "MS Shell Dlg",
    "MS Shell Dlg 2",
    // B234：`TMPF_DEVICE` 没能拦掉的**扩展字库**（ExtA/ExtB/ExtG 那些）。
    // 它们是生僻字扩展字体、ASCII 部分恰好等宽，选上当代码字体很难看。
    "MingLiU-ExtB",
    "MingLiU_HKSCS-ExtB",
    "MingLiU_MSCS-ExtB",
    "SimSun-ExtB",
    "SimSun-ExtG",
    "PMingLiU-ExtB",
];

/// 是不是 CJK 统一表意文字（汉字 / 假名 / 谚文）。
///
/// B234：CJK 宋体黑体的 ASCII 部分实测也是等宽（见 `is_monospace_by_width` 的坑），
/// 但它们不该进等宽桶 —— 等宽栏要的是代码字体。用族名里有没有 CJK 字符来区分，
/// 比再抠字宽稳（不依赖具体字体是否恰好等宽）。
fn is_cjk_char(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // 日文假名
        | 0x4E00..=0x9FFF // CJK 统一表意文字（汉字）
        | 0xAC00..=0xD7AF // 谚文音节
        | 0x3400..=0x4DBF // CJK 扩展 A
    )
}

/// 剥掉字重/字形后缀与 `@` 前缀，还原成**基础族名**。
///
/// B234：GDI 会把同一个字体的每个字重都作为独立条目枚举出来（`Segoe UI` 家族
/// 十几行），而应用内嵌字体只有 Regular 一个字重，选变体没有对应资源。
/// 这里把 `Cascadia Code SemiBold` / `@Noto Sans SC Light` 都收敛成
/// `Cascadia Code` / `Noto Sans SC`。
fn base_family(name: &str) -> String {
    let mut n = name.trim();
    if let Some(rest) = n.strip_prefix('@') {
        n = rest.trim_start();
    }
    // ⚠️ 必须**反复剥、且优先剥最长后缀**，两个坑都在这里：
    //    ① 变体名是叠加的（`Segoe UI Variable Small Semibold`、
    //       `Bahnschrift Light SemiCondensed`），一层只剥掉最后一个后缀 ⇒ 要循环。
    //    ② 后缀表顺序不能想当然：`Semibold` 必须能被整体剥掉，而不是先剥掉
    //       `Bold` 剩下 `Segoe UI Variable Small Semi`。⇒ 每轮扫全表取**最长命中**。
    loop {
        let before = n;
        let mut hit: Option<&str> = None;
        for suf in STYLE_SUFFIXES {
            if n.ends_with(suf) {
                match hit {
                    Some(h) if h.len() >= suf.len() => {}
                    _ => hit = Some(suf),
                }
            }
        }
        if let Some(suf) = hit {
            let trimmed = n[..n.len() - suf.len()].trim_end();
            // 剥完不能是空串（否则 `Regular` 这种孤字会变成空族名）
            if !trimmed.is_empty() {
                n = trimmed;
            }
        }
        if n == before {
            break;
        }
    }
    n.to_string()
}

#[cfg(windows)]
fn collect_windows() -> Vec<FontItem> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, EnumFontFamiliesExW, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
        TMPF_DEVICE,
    };

    // 回调是裸函数指针（windows-rs 0.61 把它包在 Option 里），捕不到闭包 ——
    // 结果集用 LPARAM 把一个 `Box` 的地址递进去，枚举期间它始终活着。
    unsafe extern "system" fn probe(
        lplogfont: *const LOGFONTW,
        lptm: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        if lplogfont.is_null() || lptm.is_null() {
            return 1;
        }
        let lf = &*lplogfont;
        let tm = &*lptm;
        // 设备字体不能当正文字体选
        if tm.tmPitchAndFamily.0 & TMPF_DEVICE.0 != 0 {
            return 1;
        }
        let units: Vec<u16> = lf
            .lfFaceName
            .iter()
            .copied()
            .take_while(|&c| c != 0)
            .collect();
        let Ok(name) = String::from_utf16(&units) else {
            return 1;
        };
        let name = name.trim();
        if name.is_empty() {
            return 1;
        }
        // B234 ②③：按**基础族名**去重（去 `@`、剥字重后缀）——
        // 「同族名的粗体/斜体那几条」按原始名去重已经不够了，字重变体名字不同。
        let base = base_family(name);
        if base.is_empty() {
            return 1;
        }
        // B234 ④：设备/装饰字体按**名字**黑名单剔掉（GDI 的 `TMPF_DEVICE` 位
        // 只覆盖一部分，`Apple ][` 、Emoji 字体、扩展字库都漏网）。
        //
        // ⚠️ **必须比对 `base` 而不是原始 `name`** —— GDI 给的设备字体名带 `@`
        //    前缀（实测枚举到的是 `@Fixedsys` / `@Terminal`，不是 `Fixedsys`）。
        //    先判原始名的话，黑名单里的 `Fixedsys` 永远命中不了，
        //    而 `@` 随后被 `base_family` 剥掉、变成 `Fixedsys` 混进候选 ——
        //    这个 bug 由 `mono_bucket_has_no_device_or_decorative_fonts` 抓出来。
        if NOT_TEXT_FONTS
            .iter()
            .any(|bad| base.eq_ignore_ascii_case(bad))
        {
            return 1;
        }
        // B234 ④：CJK 宋体/黑体/楷体（`宋体`、`仿宋`、`黑体`、`楷体`、`隶书`、`幼圆`）
        // 的 **ASCII 部分实测也是等宽**，但它们不是编辑器要的等宽字体 ——
        // 等宽栏要的是代码字体（Consolas / Cascadia / Courier 这一类）。
        // ⇒ 族名里含 CJK 字符的一律不进等宽桶。
        if base.chars().any(is_cjk_char) {
            return 1;
        }
        // SAFETY: lparam 由下面那次 EnumFontFamiliesExW 传入，指向一个活着的
        // `Box<Vec<FontItem>>`，枚举全程不释放；回调只在这次调用里跑。
        let sink = unsafe { &mut *(lparam.0 as *mut Vec<FontItem>) };
        if sink.iter().any(|it| it.name == base) {
            return 1;
        }
        sink.push(FontItem {
            name: base,
            // ⚠️ 这里先不填 is_monospace：等宽判定要**选中字体后实测字宽**，
            // 那要 CreateFont + SelectObject，光在枚举回调里做不了（DC 还没建）。
            // 枚举结束后在 collect_windows 里统一补齐。
            is_monospace: false,
        });
        1 // 返回非 0 = 继续枚举
    }

    // 内存 DC 足够：只读字体元数据，一个位图都不用画
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.is_invalid() {
        return Vec::new();
    }
    // lfFaceName 全 0 + DEFAULT_CHARSET = 「所有字体、所有字符集」
    let logfont = LOGFONTW {
        lfCharSet: DEFAULT_CHARSET,
        ..Default::default()
    };
    let mut sink: Box<Vec<FontItem>> = Box::new(Vec::new());
    let param = LPARAM(&mut *sink as *mut Vec<FontItem> as isize);
    unsafe {
        EnumFontFamiliesExW(hdc, &logfont, Some(probe), param, 0);
        let _ = DeleteDC(hdc);
    }

    // B234 ①：枚举完成，逐条**实测 ASCII 字宽**判定等宽。
    // 判不出来的（DC 拿不到、字体选不中）一律 fail-open 判「非等宽」——
    // 宁可混进代码字体栏，也不要把正文字体那一栏清空。
    let mut out = *sink;
    for it in out.iter_mut() {
        it.is_monospace = is_monospace_by_width(&it.name);
    }
    out.sort_by(|a, b| {
        b.is_monospace
            .cmp(&a.is_monospace)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// 实测一款字体的 ASCII 字符是否**全等宽**。
///
/// B234：`TMPF_FIXED_PITCH` 对 CJK / UI 字体不可靠（实测把 Arial、Segoe UI、
/// Times New Roman 全判成等宽）。这里换一条路 —— 把字体真正选进 DC，逐个量
/// ASCII 可见字符的宽度；只要**存在宽度不一致**的字符，就判非等宽。
///
/// 量的字符刻意挑了宽窄差异大的（`i`/`W`/`M`/`@`/`#`）：比例字体这几个字符
/// 宽度必不相同，而真等宽字体（Consolas / Cascadia / Courier）逐字同宽。
/// ⚠️ **不能用中文去判**：全角字符在比例字体里也是等宽的，一判就会把
/// `微软雅黑` 这种黑体误判成等宽 —— 那正是 B234 要修的 bug。
fn is_monospace_by_width(family: &str) -> bool {
    // ⚠️ windows-rs 0.61 的位置约定（两处都踩过）：
    //    · `PCWSTR` 在 **`windows::core`**（与 B211 那条「`BOOL` 在 `windows::core`」同源）
    //    · `HGDIOBJ` 在 **`Win32::Graphics::Gdi`**（不是 Foundation、不是 core）
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::HGDIOBJ;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateFontW, DeleteDC, DeleteObject, GetTextExtentPoint32W,
        SelectObject, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_QUALITY, OUT_TT_PRECIS,
    };

    const SAMPLE: &[u16] = &[
        b'i' as u16,
        b'W' as u16,
        b'M' as u16,
        b'@' as u16,
        b'#' as u16,
    ];
    const SIZE_PX: i32 = 32;

    unsafe {
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            return false;
        }
        let mut name: Vec<u16> = family.encode_utf16().collect();
        name.push(0);
        // ⚠️ windows-rs 0.61 的坑（四处都踩过，逐个试出来的）：
        //    · 参数类型是**新类型**（`FONT_CHARSET` / `FONT_OUTPUT_PRECISION` /
        //      `FONT_CLIP_PRECISION` / `FONT_QUALITY`），直接传同名常量，
        //      **不要** `.0 as u32`（那样反而类型不匹配）。
        //    · `ipitchandfamily` 是**裸 u32** —— 传 `FF_DONTCARE`（`FONT_FAMILY`）会红。
        //    · `iclipprecision` 要 `DEFAULT_CLIP_PRECISION`，**不是** `DEFAULT_PITCH`
        //      （后者是 `FONT_PITCH`，用在别的参数上）。
        //    · `pszfacename` 收 `PCWSTR` 而非 `&[u16]`。
        //    · `SelectObject`/`DeleteObject` 收 `HGDIOBJ` 而非 `HFONT`。
        //    参数共 14 个（cheight…pszfacename），顺序照 `CreateFontW` 签名。
        let font = CreateFontW(
            SIZE_PX,               // cheight
            0,                     // cwidth
            0,                     // cescapement
            0,                     // corientation
            400,                   // cweight（常规）
            0,                     // bitalic
            0,                     // bunderline
            0,                     // bstrikeout
            DEFAULT_CHARSET,       // icharset
            OUT_TT_PRECIS,         // ioutprecision
            CLIP_DEFAULT_PRECIS,   // iclipprecision
            DEFAULT_QUALITY,       // iquality（顶层常量，不是 FONT_QUALITY::X）
            0,                     // ipitchandfamily（裸 u32；0 = 默认）
            PCWSTR(name.as_ptr()), // pszfacename
        );
        if font.is_invalid() {
            let _ = DeleteDC(hdc);
            return false;
        }
        let font_obj = HGDIOBJ(font.0);
        let old = SelectObject(hdc, font_obj);
        if old.is_invalid() {
            let _ = DeleteObject(font_obj);
            let _ = DeleteDC(hdc);
            return false;
        }

        let mut first: Option<i32> = None;
        let mut mono = true;
        for &ch in SAMPLE {
            let mut size = SIZE { cx: 0, cy: 0 };
            // ⚠️ 0.61 的 `GetTextExtentPoint32W` 收 `&[u16]`（整段字符串）并返回 `BOOL`
            let w = if GetTextExtentPoint32W(hdc, &[ch], &mut size).as_bool() {
                size.cx
            } else {
                0
            };
            match first {
                None => first = Some(w),
                Some(f) if f != w => {
                    mono = false;
                    break;
                }
                _ => {}
            }
        }

        // 还原 DC 再删字体 —— 顺序反了会删掉正在使用的对象。
        let _ = SelectObject(hdc, old);
        let _ = DeleteObject(font_obj);
        let _ = DeleteDC(hdc);
        mono
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_fonts_has_unique_names() {
        let list = list_fonts();
        let mut seen = std::collections::HashSet::new();
        for it in &list {
            assert!(!it.name.is_empty(), "空族名不该出现");
            assert!(seen.insert(it.name.clone()), "族名重复：{}", it.name);
        }
    }

    #[test]
    fn list_fonts_enumerates_a_meaningful_number() {
        if cfg!(windows) {
            let list = list_fonts();
            // 内嵌默认走 @font-face，不依赖系统安装；这里只保证「枚举本身能跑通且有内容」。
            // Windows 自带字体远不止这个数（保守取 30），枚举空/只剩设备字体都该红。
            assert!(
                list.len() >= 30,
                "枚举结果只有 {} 条，判定为没跑起来",
                list.len()
            );
            assert!(
                list.iter().any(|it| it.is_monospace),
                "系统一定有等宽字体（Consolas / Cascadia Code）"
            );
        }
    }

    #[test]
    fn monospace_items_come_first() {
        let list = list_fonts();
        let seen_non_mono = list.iter().position(|it| !it.is_monospace);
        if let Some(first_serif) = seen_non_mono {
            assert!(
                list[first_serif..].iter().all(|it| !it.is_monospace),
                "等宽项必须全排在非等宽项前面"
            );
        }
    }

    /// B234：等宽判定必须**两头都对**，不是「全都判等宽」也能过。
    ///
    /// 修之前的 bug 正是 280 条里 244 条被判等宽 —— 旧断言只查「有等宽的」，
    /// 那种 bug 自然照样绿。这里钉住具体字体：真等宽的必须在等宽桶里，
    /// 而比例字体（哪怕它也是 FIXED_PITCH 的误判受害者）必须在非等宽桶里。
    #[test]
    fn mono_classification_is_correct_on_known_fonts() {
        if !cfg!(windows) {
            return;
        }
        let list = list_fonts();
        let find = |n: &str| list.iter().find(|it| it.name == n);

        // 本机装着的真等宽字体
        for mono_name in ["Consolas", "Cascadia Mono", "Cascadia Code", "Courier New"] {
            if let Some(it) = find(mono_name) {
                assert!(
                    it.is_monospace,
                    "{} 是等宽字体，被判成了非等宽（B234 判定失效）",
                    mono_name
                );
            }
        }
        // 比例字体：曾经被 TMPF_FIXED_PITCH 误判成等宽的那批
        for prop_name in ["Arial", "Segoe UI", "Times New Roman", "Tahoma", "Verdana"] {
            if let Some(it) = find(prop_name) {
                assert!(
                    !it.is_monospace,
                    "{} 是比例字体，被判成了等宽（B234 判定失效）",
                    prop_name
                );
            }
        }
    }

    /// B234：非等宽的**比例字体必须真的有非等宽项**。
    ///
    /// 这是「正文字体」那一栏能不能用的前提 —— 之前 244/280 判等宽，
    /// 那一栏几乎列不出东西。
    #[test]
    fn there_are_enough_proportional_fonts() {
        if !cfg!(windows) {
            return;
        }
        let list = list_fonts();
        let prop = list.iter().filter(|it| !it.is_monospace).count();
        assert!(
            prop >= 10,
            "非等宽字体只有 {} 条，正文字体那一栏会列不出东西（B234 判定失效）",
            prop
        );
    }

    /// B234：等宽桶里**不该出现**这些 —— 设备字体、扩展字库、装饰字体。
    ///
    /// 这条是「等宽桶」的正向保障：修之前它装着 Fixedsys / Terminal /
    /// `Apple ][` / 一堆 `MingLiU-ExtB`，用户选到会得到一个纯 ASCII 的界面。
    #[test]
    fn mono_bucket_has_no_device_or_decorative_fonts() {
        if !cfg!(windows) {
            return;
        }
        for it in list_fonts() {
            assert!(
                !NOT_TEXT_FONTS
                    .iter()
                    .any(|bad| it.name.eq_ignore_ascii_case(bad)),
                "等宽桶混进了设备/装饰字体：{}",
                it.name
            );
        }
    }

    #[test]
    fn base_family_strips_at_prefix_and_style_suffixes() {
        assert_eq!(base_family("@Noto Sans SC Light"), "Noto Sans SC");
        assert_eq!(base_family("Cascadia Code SemiBold"), "Cascadia Code");
        assert_eq!(base_family("Consolas Bold"), "Consolas");
        assert_eq!(
            base_family("Segoe UI Variable Small Semibold"),
            "Segoe UI Variable Small"
        );
        // 不该被误伤的普通族名
        assert_eq!(base_family("Arial"), "Arial");
        assert_eq!(base_family("Microsoft YaHei UI"), "Microsoft YaHei UI");
        assert_eq!(base_family("Segoe UI"), "Segoe UI");
        // 剥空不许产出空串
        assert_eq!(base_family("Regular"), "Regular");
    }

    /// B234：枚举结果里不该再有字重变体与 `@` 副本。
    #[test]
    fn enumerated_names_have_no_style_variants() {
        if !cfg!(windows) {
            return;
        }
        for it in list_fonts() {
            assert!(
                !it.name.starts_with('@'),
                "枚举结果不该含 @ 前缀副本：{}",
                it.name
            );
            for suf in [" Light", " SemiBold", " Bold", " Black", " ExtraLight"] {
                assert!(
                    !it.name.ends_with(suf),
                    "枚举结果不该含字重变体：{}",
                    it.name
                );
            }
        }
    }
}
