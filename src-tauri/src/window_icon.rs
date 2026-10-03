//! 任务栏 / Alt+Tab 的窗口图标：**按当前显示缩放挑档**（B221）。
//!
//! 为什么光靠 ICO 不够：Tauri 把窗口图标嵌进二进制时只取 ICO 的**第一档**
//! （tauri-codegen 的 `new_ico` 就一行 `&icon_dir.entries()[0]`），把它解码成一个
//! HICON 交给 `WM_SETICON`；Windows 只能缩放这一张图。单一尺寸没法在所有缩放下
//! 都清晰 —— 实测拿 64 当第一档，100% 缩放（任务栏要 32）锐度只剩 70%，
//! 拿 256 更只有 62%（倍数越大，GDI 的重采样把细节洗得越干净）。
//! 反过来拿 16 当第一档（改之前就是）更是直接被放大 2~3 倍。
//!
//! 所以运行时按 `scale_factor` 挑：explorer 在 100% 下向窗口要 32px 的大图标
//! （`SM_CXICON`），高 DPI 按倍率放大（125%→40、150%→48、200%→64）。
//! 取**不小于目标的最小档** ⇒ 系统只可能把图标**缩小**，绝不会放大。
//! 拖到不同缩放的显示器、或在系统设置里改缩放，`ScaleFactorChanged` 会重新挑档。
//!
//! 档位是裸 RGBA（`scripts/gen_icons.py` 出的 `icon-<n>.rgba`），`include_bytes!`
//! 直喂 `tauri::image::Image::new`，运行时**不做任何解码**。
//!
//! ⚠️ 这些档位与 ICO 里的同名档共用 `ico_frames()` 的画法（母版直出 + ≤64 锐化），
//!    换配色/换造型时两边会一起变，不需要各自维护。

/// 100% 缩放下 explorer 向窗口要的大图标边长（SM_CXICON）。
const BASE_ICON_PX: f64 = 32.0;

const ICON_32: &[u8] = include_bytes!("../icons/icon-32.rgba");
const ICON_48: &[u8] = include_bytes!("../icons/icon-48.rgba");
const ICON_64: &[u8] = include_bytes!("../icons/icon-64.rgba");
const ICON_128: &[u8] = include_bytes!("../icons/icon-128.rgba");

/// 按缩放倍率挑一档窗口图标。
///
/// 选档原则：**不小于目标的最小档** —— 宁可让系统把图标缩小，也绝不让它放大
/// （放大必然糊，缩小至多掉一点锐度）。倍率缺失/异常时按 1.0 处理，取 32 那档。
pub fn pick(scale_factor: f64) -> tauri::image::Image<'static> {
    // NaN / 负数会让下面的比较全走 else 分支，先夹回一个说得通的范围
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    // 300% 要 96px、400% 要 128px —— 128 那档就是为这两档准备的
    // （再往上没有更大档可选，只能让系统放大，但那已经超出常见缩放范围）。
    let target = BASE_ICON_PX * scale;
    let (rgba, size): (&[u8], u32) = if target <= 32.0 {
        (ICON_32, 32)
    } else if target <= 48.0 {
        (ICON_48, 48)
    } else if target <= 64.0 {
        (ICON_64, 64)
    } else {
        (ICON_128, 128)
    };
    tauri::image::Image::new(rgba, size, size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_never_returns_smaller_than_target() {
        // 100% / 125% / 150% / 175% / 200% / 300% / 400% → 目标 32/40/48/56/64/96/128
        for (scale, want) in [
            (1.0, 32),
            (1.25, 48),
            (1.5, 48),
            (1.75, 64),
            (2.0, 64),
            (3.0, 128),
            (4.0, 128),
        ] {
            let img = pick(scale);
            assert_eq!(img.width(), want, "scale={scale} 应取 {want} 那档");
            assert_eq!(img.height(), want, "scale={scale} 应取 {want} 那档");
            // 选出来的一档必须 >= 目标尺寸（系统只会缩小，不会放大）
            assert!(
                want as f64 >= BASE_ICON_PX * scale,
                "scale={scale} 取了 {want}，比目标 {} 小 ⇒ 会被放大",
                BASE_ICON_PX * scale
            );
        }
    }

    #[test]
    fn pick_handles_bogus_scale() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let img = pick(scale);
            assert_eq!(img.width(), 32, "异常倍率 {scale} 应回落到 32 那档");
        }
    }

    #[test]
    fn embedded_frames_are_raw_rgba() {
        // 裸 RGBA：字节数必须恰好是 边长×边长×4，include 错了尺寸会当场炸
        assert_eq!(ICON_32.len(), 32 * 32 * 4);
        assert_eq!(ICON_48.len(), 48 * 48 * 4);
        assert_eq!(ICON_64.len(), 64 * 64 * 4);
        assert_eq!(ICON_128.len(), 128 * 128 * 4);
    }
}
