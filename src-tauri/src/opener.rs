//! 外部链接交给系统默认浏览器（B401）。
//!
//! 派生预览里的 `<a href>` 以前直接让 WebView 自己导航 —— 整窗被网页顶掉、没有后退
//! 入口。链接改成由前端分类：http(s)/mailto 走这里，本地文件走应用内打开，纯锚点就地滚。
//!
//! 只放三种协议：`ShellExecuteW` 拿到什么就执行什么，前端传来的串必须先在这里过闸，
//! 否则一个被注入的 `file:`/自定义 scheme 就绕过了「只开网页」这条口径。

use windows::core::PCWSTR;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// B401：只有这三种协议许交给系统。
pub fn is_allowed_external(target: &str) -> bool {
    let lower = target.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

#[tauri::command]
pub fn open_external(target: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("链接为空".into());
    }
    if !is_allowed_external(target) {
        return Err(format!("不支持的链接协议：{target}"));
    }
    let op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    // ShellExecuteW 的约定：返回值 > 32 才算打开成功。
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // 留一条日志：外链是「应用之外的动作」，真机验收与用户报障都靠它认这一发走没走。
    let ok = result.0 as isize > 32;
    crate::core::logging::log(
        crate::core::logging::Level::Info,
        "link",
        &format!(
            "open_external · {} · {target}",
            if ok { "ok" } else { "fail" }
        ),
    );
    if !ok {
        return Err(format!("系统没有打开这个链接：{target}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_allowed_external;

    #[test]
    fn allows_only_web_and_mailto() {
        assert!(is_allowed_external("https://example.com/a?b=1"));
        assert!(is_allowed_external("HTTP://example.com"));
        assert!(is_allowed_external("mailto:someone@example.com"));
        assert!(!is_allowed_external("javascript:alert(1)"));
        assert!(!is_allowed_external("file:///C:/Windows/System32/cmd.exe"));
        assert!(!is_allowed_external("C:\\Windows\\System32\\cmd.exe"));
        assert!(!is_allowed_external("vbscript:msgbox"));
        assert!(!is_allowed_external("   "));
    }
}
