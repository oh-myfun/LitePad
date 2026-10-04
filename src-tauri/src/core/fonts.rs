//! 系统字体枚举（B227）—— 设置页选字体用。
//!
//! 为什么不用「手抄一份候选清单」：字体是**装在用户机器上**的，清单在别人机器上
//! 必然对不上（装了什么、装了几个字重、是不是等宽，全都因人而异）。所以这里直接问
//! Windows GDI 要一份真实清单，前端那份「未安装」标注（settingsdialog 的
//! `isFontInstalled` 像素比对）只保留给**内嵌字体之外**的手选历史值。
//!
//! 等宽判定用 `TEXTMETRICW.tmPitchAndFamily` 的 `TMPF_FIXED_PITCH` 位 —— 固定字距的
//! 字体全角/半角同宽，正是编辑器要的。设备字体（终端、打印机仿真那一类，`TMPF_DEVICE`）
//! 直接剔掉：它们能被枚举到，但不能当正文字体选。
//!
//! ⚠️ 同一个族名会按字重/斜体被枚举多次（微软雅黑 → 3 条），设置项按**族名**选，
//!    所以这里按名字去重，留第一条。
//!
//! ⚠️ 这一段是 `unsafe` 的 Win32 调用（回调跨 FFI 边界），只在 `cfg(windows)` 下编译；
//!    其它平台返回空列表，前端那一栏就只剩内嵌字体。

use serde::Serialize;

/// 一条字体候选。等宽那批由设置页单独一栏列。
#[derive(Clone, Debug, Serialize)]
pub struct FontItem {
    /// 族名，可直接当 CSS `font-family` 用（带空格的由前端加引号）。
    pub name: String,
    /// 是否等宽（`TMPF_FIXED_PITCH`）。
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

#[cfg(windows)]
fn collect_windows() -> Vec<FontItem> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, EnumFontFamiliesExW, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
        TMPF_DEVICE, TMPF_FIXED_PITCH,
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
        let flags = tm.tmPitchAndFamily.0;
        // 设备字体不能当正文字体选
        if flags & TMPF_DEVICE.0 != 0 {
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
        // SAFETY: lparam 由下面那次 EnumFontFamiliesExW 传入，指向一个活着的
        // `Box<Vec<FontItem>>`，枚举全程不释放；回调只在这次调用里跑。
        let sink = unsafe { &mut *(lparam.0 as *mut Vec<FontItem>) };
        if sink.iter().any(|it| it.name == name) {
            return 1; // 同族名的粗体/斜体那几条，族名去重
        }
        sink.push(FontItem {
            name: name.to_string(),
            is_monospace: flags & TMPF_FIXED_PITCH.0 != 0,
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

    let mut out = *sink;
    out.sort_by(|a, b| {
        b.is_monospace
            .cmp(&a.is_monospace)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
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
    fn list_fonts_finds_the_embedded_default_on_this_machine() {
        // 内嵌默认走 @font-face，不依赖系统安装；这里只保证「枚举本身能跑通且有内容」。
        if cfg!(windows) {
            let list = list_fonts();
            // Windows 自带的字体远不止这个数（保守取 10），枚举空/只剩设备字体都该红
            assert!(
                list.len() >= 10,
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
}
