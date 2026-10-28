//! B400 · 把标签拖出成**文件**：让 VS Code / 资源管理器 / 记事本这些外部应用收到
//! 这份文档对应的那个磁盘文件。
//!
//! ## 为什么不能沿用页面内那一套
//!
//! 页面里的标签拖拽是 HTML5 DnD（`src/shell/tabdnd.ts`）：数据只在这次拖拽会话里
//! 流通，格式是自定义 MIME + 一段 JSON。Windows 上的其他应用认的是**系统剪贴板格式**
//! `CF_HDROP` —— 一份 `DROPFILES` 结构（宽字符路径列表）。浏览器自己把
//! `<input type=file>` 里的真实文件拖出去时会填这份格式，但页面脚本造不出「有磁盘
//! 路径的 File」（安全模型），所以「把任意一个已知路径当文件拖出去」只能由原生侧
//! 起一次 OLE 拖拽：`IDataObject`（供 CF_HDROP）+ `IDropSource` + `DoDragDrop`。
//!
//! ## 与页面内拖拽的关系
//!
//! 两条手势**互斥**：一次拖拽要么是 HTML5（普通拖动：排序 / 跨格 / 跨窗口 / 拖出开
//! 新窗），要么是这里的 OLE 拖拽（Ctrl+拖动）。选哪条由前端在 `dragstart` 里决定
//! （`src/shell/tabstrip.ts`），这样既有行为一行不动，外部应用又拿得到「真文件」。
//!
//! ## 线程
//!
//! `DoDragDrop` 是**模态阻塞**的，且必须由拥有窗口的 UI 线程发起（经典写法：
//! `WM_LBUTTONDOWN` → `SetCapture` → `DoDragDrop`）。所以命令本身只做校验并把活
//! 投递到主线程（`run_on_main_thread`），真正的拖拽循环在那边跑到松手为止；OLE 的
//! 循环自己泵消息，WebView2 的绘制与 IPC 不会被冻住。
//!
//! ## 只给「复制」
//!
//! `DoDragDrop` 的允许效果只有 `DROPEFFECT_COPY`，并额外提供 `Preferred DropEffect`
//! 格式（资源管理器按它决定复制还是移动）⇒ 拖到桌面/资源管理器是**复制**，绝不会把
//! 用户的文件搬走。

use std::mem::ManuallyDrop;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use windows::core::{implement, Result as WinResult, BOOL, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_NOTIMPL,
    HGLOBAL, HWND, POINT, S_OK,
};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, DATADIR_GET,
    DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, CF_HDROP, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, ReleaseCapture, SetCapture, VK_LBUTTON,
};
use windows::Win32::UI::Shell::{SHCreateStdEnumFmtEtc, DROPFILES};

/// 「资源管理器按这个决定复制/移动」的私有剪贴板格式名（与浏览器、VS Code 用的同一形）。
const PREFERRED_DROP_EFFECT: &[u16] = &[
    b'P' as u16,
    b'r' as u16,
    b'e' as u16,
    b'f' as u16,
    b'e' as u16,
    b'r' as u16,
    b'r' as u16,
    b'e' as u16,
    b'd' as u16,
    b' ' as u16,
    b'D' as u16,
    b'r' as u16,
    b'o' as u16,
    b'p' as u16,
    b'E' as u16,
    b'f' as u16,
    b'f' as u16,
    b'e' as u16,
    b'c' as u16,
    b't' as u16,
    0,
];

fn preferred_drop_effect_format() -> u32 {
    unsafe { RegisterClipboardFormatW(PCWSTR(PREFERRED_DROP_EFFECT.as_ptr())) }
}

/// `CF_HDROP` 的载荷：`DROPFILES` 头 + 宽字符路径（NUL 分隔、整串再补一个 NUL）。
///
/// 纯函数（不碰 Win32）⇒ 单测可以逐字节验头与路径列表。
pub fn dropfiles_blob(paths: &[PathBuf]) -> Vec<u8> {
    let mut tail: Vec<u8> = Vec::new();
    for p in paths {
        for unit in p.as_os_str().encode_wide() {
            tail.extend_from_slice(&unit.to_le_bytes());
        }
        tail.extend_from_slice(&[0, 0]);
    }
    tail.extend_from_slice(&[0, 0]);

    let header = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: BOOL(0),
        fWide: BOOL(1),
    };
    let mut out = vec![0u8; std::mem::size_of::<DROPFILES>()];
    unsafe {
        std::ptr::copy_nonoverlapping(
            &header as *const DROPFILES as *const u8,
            out.as_mut_ptr(),
            out.len(),
        );
    }
    out.extend_from_slice(&tail);
    out
}

fn hglobal_medium(bytes: &[u8]) -> WinResult<STGMEDIUM> {
    unsafe {
        let h: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
        let p = GlobalLock(h);
        if p.is_null() {
            return Err(windows::core::Error::from_win32());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
        // 归零时返回 FALSE（GetLastError == NO_ERROR），不是失败
        let _ = GlobalUnlock(h);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: h },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
}

fn hdrop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn drop_effect_format() -> FORMATETC {
    FORMATETC {
        cfFormat: preferred_drop_effect_format() as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn format_is(fmt: &FORMATETC, cf: u16) -> bool {
    fmt.cfFormat == cf && fmt.tymed & (TYMED_HGLOBAL.0 as u32) != 0
}

/// 「本线程已做过 OleInitialize」——只在主线程上置位（命令一律 `run_on_main_thread`）。
static OLE_READY: AtomicBool = AtomicBool::new(false);

/// 一次文件拖拽的数据对象 + 拖源（两个接口可以由同一个结构实现，各自一份实例）。
#[implement(IDataObject, IDropSource)]
struct TabFileDrag {
    blob: Vec<u8>,
}

impl IDataObject_Impl for TabFileDrag_Impl {
    fn GetData(&self, pformatetc: *const FORMATETC) -> WinResult<STGMEDIUM> {
        if pformatetc.is_null() {
            return Err(DV_E_FORMATETC.into());
        }
        let fmt = unsafe { &*pformatetc };
        if format_is(fmt, CF_HDROP.0) {
            return hglobal_medium(&self.blob);
        }
        if format_is(fmt, preferred_drop_effect_format() as u16) {
            // 4 字节 DROPEFFECT：只允许复制 —— 拖到资源管理器/桌面不会把原文件搬走
            return hglobal_medium(&DROPEFFECT_COPY.0.to_le_bytes());
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        if pformatetc.is_null() {
            return DV_E_FORMATETC;
        }
        let fmt = unsafe { &*pformatetc };
        if format_is(fmt, CF_HDROP.0) || format_is(fmt, preferred_drop_effect_format() as u16) {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatetcin: *const FORMATETC,
        _pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        E_NOTIMPL
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe { SHCreateStdEnumFmtEtc(&[hdrop_format(), drop_effect_format()]) }
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: windows::core::Ref<'_, IAdviseSink>,
    ) -> WinResult<u32> {
        Err(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _dwconnection: u32) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

impl IDropSource_Impl for TabFileDrag_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        // 左键松了 ⇒ 落子（真正落给谁由指针下面的 drop target 决定）
        if grfkeystate.0 & MK_LBUTTON.0 == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// 主线程侧：起一次 OLE 拖拽，跑到松手（或 Esc）为止。
///
/// `hwnd` 只用来在拖拽期间抓住鼠标（OLE 的循环以「拖源抓着自己的窗口」为前提）；
/// 传 0 也能跑，只是拖拽途中的鼠标事件归属更依赖系统的默认行为。
pub fn run(hwnd: usize, paths: &[PathBuf]) -> Result<(), String> {
    let blob = dropfiles_blob(paths);
    unsafe {
        // OLE 拖放要求线程做过 OLE 初始化。这里是**主线程**（命令走 `run_on_main_thread`），
        // 进程内只做一次、也**不**反初始化：
        //   · windows 0.61 把这颗 API 包成 `Result`，S_FALSE（= 本来就已经初始化过，
        //     Tauri/WebView2 常年初始化着主线程）同样算 Ok ⇒ 分不出「是不是我初始化的」，
        //     按 `is_ok()` 去配对 `OleUninitialize` 会白减一次引用计数、把别人还要用的
        //     OLE 拆掉；
        //   · 主线程是常驻的，初始化一次的开销与「进程级 Win32 状态」本来是同一惯例。
        // 失败时把标记放回去，下一次还能重试。
        if !OLE_READY.swap(true, Ordering::SeqCst) {
            let init = OleInitialize(None);
            if init.is_err() {
                OLE_READY.store(false, Ordering::SeqCst);
                return Err(format!("OleInitialize: {init:?}"));
            }
        }
        if hwnd != 0 {
            SetCapture(HWND(hwnd as *mut std::ffi::c_void));
        }
        let data: IDataObject = TabFileDrag { blob: blob.clone() }.into();
        let src: IDropSource = TabFileDrag { blob }.into();
        let mut effect = DROPEFFECT_NONE;
        let hr = DoDragDrop(&data, &src, DROPEFFECT_COPY, &mut effect);
        // effect 是**落点窗口**最终接受的那一项：NONE = 没落到任何接受方（或对方拒收），
        // COPY = 真正被接住。出问题（比如拖到别的应用没反应）时先看这一行。
        crate::core::logging::log(
            crate::core::logging::Level::Info,
            "filedrag",
            &format!("拖出结束：hr={hr:?} effect={}", effect.0),
        );
        if hwnd != 0 {
            let _ = ReleaseCapture();
        }
        // DRAGDROP_S_DROP / DRAGDROP_S_CANCEL 都是成功码；真失败才往上抛
        if hr.is_ok() {
            Ok(())
        } else {
            Err(format!("DoDragDrop: {hr:?}"))
        }
    }
}

/// 鼠标左键此刻是否真的按着。
///
/// 前端是「先存盘再起拖」：存盘可能弹冲突框、也可能慢；等它回来时用户早松手了。
/// 这时若照常起拖，OLE 的第一发 `QueryContinueDrag` 就会判「键已松」⇒ 就地落子，
/// 等于把文件盲投在指针当前所在的位置。所以起拖前问一次全局键态。
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16) & 0x8000 != 0 }
}

/// 前端入口：Ctrl+拖动标签时调用（`src/io/filedrag.ts`）。
///
/// 命令本身只做校验与投递 —— 真正的拖拽循环在 UI 线程上跑（`run_on_main_thread`），
/// 这里立刻返回，页面不会因为一次长拖拽被卡住。
#[tauri::command]
pub fn start_file_drag(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let normalized = normalize_paths(&paths)?;
    if !left_button_down() {
        // 正常路径不会走到（Ctrl+拖动时键一定按着）；走到这儿就是「存盘期间用户松手了」
        return Err("鼠标已松开，未起拖".into());
    }
    crate::core::logging::log(
        crate::core::logging::Level::Info,
        "filedrag",
        &format!(
            "拖出 {} 个文件：{}",
            normalized.len(),
            normalized[0].display()
        ),
    );
    let hwnd = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        if let Err(err) = run(hwnd, &normalized) {
            crate::core::logging::log(
                crate::core::logging::Level::Warn,
                "filedrag",
                &format!("拖出失败：{err}"),
            );
        }
    })
    .map_err(|err| err.to_string())
}

/// 可拖出的路径：必须是绝对路径、存在、且是文件（目录/不存在的路径拖出去只会落空）。
pub fn normalize_paths(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("没有可拖出的文件".into());
    }
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let p = Path::new(raw);
        if !p.is_absolute() {
            return Err(format!("不是绝对路径：{raw}"));
        }
        if !p.is_file() {
            return Err(format!("文件不存在：{raw}"));
        }
        out.push(p.to_path_buf());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide_names(blob: &[u8]) -> (u32, bool, Vec<String>) {
        assert!(blob.len() >= std::mem::size_of::<DROPFILES>());
        let header = unsafe { std::ptr::read_unaligned(blob.as_ptr() as *const DROPFILES) };
        let units: Vec<u16> = blob[header.pFiles as usize..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let mut names = Vec::new();
        let mut cur = Vec::new();
        for u in units {
            if u == 0 {
                if cur.is_empty() {
                    break; // 双 NUL 收尾
                }
                names.push(String::from_utf16(&cur).unwrap());
                cur.clear();
            } else {
                cur.push(u);
            }
        }
        (header.pFiles, header.fWide.as_bool(), names)
    }

    #[test]
    fn blob_has_wide_dropfiles_header_and_nul_separated_paths() {
        let paths = vec![PathBuf::from(r"C:\项目\a.md"), PathBuf::from(r"D:\b c.txt")];
        let blob = dropfiles_blob(&paths);
        let (offset, wide, names) = wide_names(&blob);
        assert_eq!(offset, std::mem::size_of::<DROPFILES>() as u32);
        assert!(wide, "fWide 必须为真：路径是宽字符");
        assert_eq!(
            names,
            vec![r"C:\项目\a.md".to_string(), r"D:\b c.txt".to_string()]
        );
        // 双 NUL 收尾
        assert_eq!(&blob[blob.len() - 4..], &[0, 0, 0, 0]);
    }

    #[test]
    fn data_object_serves_cf_hdrop_and_refuses_other_formats() {
        let blob = dropfiles_blob(&[PathBuf::from(r"E:\tmp\one.md")]);
        let data: IDataObject = TabFileDrag { blob: blob.clone() }.into();
        unsafe {
            assert_eq!(data.QueryGetData(&hdrop_format()), S_OK);
            let mut fmt = hdrop_format();
            fmt.cfFormat = windows::Win32::System::Ole::CF_UNICODETEXT.0;
            assert_eq!(data.QueryGetData(&fmt), DV_E_FORMATETC);

            let medium = data
                .GetData(&hdrop_format())
                .expect("CF_HDROP 必须给得出来");
            assert_eq!(medium.tymed, TYMED_HGLOBAL.0 as u32);
            let p = GlobalLock(medium.u.hGlobal);
            assert!(!p.is_null());
            let served = std::slice::from_raw_parts(p as *const u8, blob.len());
            assert_eq!(served, blob.as_slice(), "给出去的字节应与构造时一致");
            let _ = GlobalUnlock(medium.u.hGlobal);
            windows::Win32::System::Ole::ReleaseStgMedium(&medium as *const _ as *mut _);
        }
    }

    #[test]
    fn preferred_drop_effect_is_copy_only() {
        let data: IDataObject = TabFileDrag {
            blob: dropfiles_blob(&[PathBuf::from(r"E:\a.md")]),
        }
        .into();
        unsafe {
            let medium = data
                .GetData(&drop_effect_format())
                .expect("drop effect 也要给");
            let p = GlobalLock(medium.u.hGlobal);
            let effect = std::ptr::read_unaligned(p as *const u32);
            assert_eq!(effect, DROPEFFECT_COPY.0);
            let _ = GlobalUnlock(medium.u.hGlobal);
            windows::Win32::System::Ole::ReleaseStgMedium(&medium as *const _ as *mut _);
        }
    }

    #[test]
    fn normalize_rejects_relative_and_missing() {
        assert!(normalize_paths(&[]).is_err());
        assert!(normalize_paths(&["a.md".to_string()]).is_err());
        assert!(normalize_paths(&[r"E:\definitely\missing\file.md".to_string()]).is_err());
    }
}
