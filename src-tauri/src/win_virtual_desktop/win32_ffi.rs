//! Minimal Win32 FFI bindings and safe RAII desktop wrappers for `QianjiBotDesktop`.
//!
//! Invariant: NEVER declare or invoke `SwitchDesktop`, `SetCursorPos`, or `SendInput`.

use core::ffi::c_void;
use std::mem::zeroed;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetWindowPos, GA_ROOT,
    GWL_EXSTYLE, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, WS_EX_TOOLWINDOW,
};

use super::{
    WinDesktopWindow, BOT_DESKTOP_NAME, DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH,
    TASKBAR_HEIGHT,
};

pub type HDESK = *mut c_void;
pub type HMODULE = *mut c_void;
pub type HANDLE = *mut c_void;

// Standard Win32 desktop access rights (explicitly omitting DESKTOP_SWITCHDESKTOP = 0x0100).
pub const DESKTOP_READOBJECTS: u32 = 0x0001;
pub const DESKTOP_CREATEWINDOW: u32 = 0x0002;
pub const DESKTOP_CREATEMENU: u32 = 0x0004;
pub const DESKTOP_HOOKCONTROL: u32 = 0x0008;
pub const DESKTOP_ENUMERATE: u32 = 0x0040;
pub const DESKTOP_WRITEOBJECTS: u32 = 0x0080;

pub const BOT_DESKTOP_ACCESS: u32 = DESKTOP_READOBJECTS
    | DESKTOP_CREATEWINDOW
    | DESKTOP_CREATEMENU
    | DESKTOP_HOOKCONTROL
    | DESKTOP_ENUMERATE
    | DESKTOP_WRITEOBJECTS;

pub const UOI_NAME: i32 = 2;
pub const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

pub const HKEY_CURRENT_USER: HANDLE = 0x8000_0001_usize as isize as HANDLE;
pub const HKEY_LOCAL_MACHINE: HANDLE = 0x8000_0002_usize as isize as HANDLE;
pub const RRF_RT_REG_SZ: u32 = 0x0000_0002;
pub const RRF_RT_REG_EXPAND_SZ: u32 = 0x0000_0004;

pub const TOKEN_QUERY: u32 = 0x0008;
pub const TOKEN_ELEVATION_CLASS: u32 = 20;

#[repr(C)]
pub struct TokenElevation {
    pub token_is_elevated: u32,
}

#[repr(C)]
pub struct OsVersionInfoExW {
    pub dw_os_version_info_size: u32,
    pub dw_major_version: u32,
    pub dw_minor_version: u32,
    pub dw_build_number: u32,
    pub dw_platform_id: u32,
    pub sz_csd_version: [u16; 128],
    pub w_service_pack_major: u16,
    pub w_service_pack_minor: u16,
    pub w_suite_mask: u16,
    pub w_product_type: u8,
    pub w_reserved: u8,
}

#[link(name = "user32")]
unsafe extern "system" {
    pub fn CreateDesktopW(
        lpsz_desktop: *const u16,
        lpsz_device: *const u16,
        p_devmode: *const c_void,
        dw_flags: u32,
        dw_desired_access: u32,
        lpsa: *const c_void,
    ) -> HDESK;

    pub fn OpenDesktopW(
        lpsz_desktop: *const u16,
        dw_flags: u32,
        f_inherit: i32,
        dw_desired_access: u32,
    ) -> HDESK;

    pub fn EnumDesktopWindows(
        h_desktop: HDESK,
        lpfn: Option<unsafe extern "system" fn(HWND, LPARAM) -> i32>,
        l_param: LPARAM,
    ) -> i32;

    pub fn GetThreadDesktop(dw_thread_id: u32) -> HDESK;

    pub fn GetUserObjectInformationW(
        h_obj: HANDLE,
        n_index: i32,
        pv_info: *mut c_void,
        n_length: u32,
        lpn_length_needed: *mut u32,
    ) -> i32;

    pub fn PrintWindow(hwnd: HWND, hdc_blt: *mut c_void, n_flags: u32) -> i32;

    pub fn WaitForInputIdle(h_process: HANDLE, dw_milliseconds: u32) -> u32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    pub fn GetModuleHandleW(lp_module_name: *const u16) -> HMODULE;
    pub fn LoadLibraryW(lp_lib_file_name: *const u16) -> HMODULE;
    pub fn GetProcAddress(h_module: HMODULE, lp_proc_name: *const u8) -> *const c_void;
    pub fn GetLastError() -> u32;
    pub fn SetLastError(dw_err_code: u32);
}

#[link(name = "advapi32")]
unsafe extern "system" {
    pub fn RegGetValueW(
        hkey: HANDLE,
        lp_sub_key: *const u16,
        lp_value: *const u16,
        dw_flags: u32,
        pdw_type: *mut u32,
        pv_data: *mut c_void,
        pcb_data: *mut u32,
    ) -> i32;

    pub fn OpenProcessToken(
        process_handle: HANDLE,
        desired_access: u32,
        token_handle: *mut HANDLE,
    ) -> i32;

    pub fn GetTokenInformation(
        token_handle: HANDLE,
        token_information_class: u32,
        token_information: *mut c_void,
        token_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

pub fn to_wide_null(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Process-cached handle to `WinSta0\QianjiBotDesktop` (never closed during process
/// lifetime so concurrent in-process threads never put an empty desktop into `DELETE_PENDING`).
static PROCESS_BOT_DESKTOP: Mutex<usize> = Mutex::new(0);

pub struct ScopedDesktop(HDESK);

impl ScopedDesktop {
    pub fn as_raw(&self) -> HDESK {
        self.0
    }
}

/// Opens or creates `WinSta0\QianjiBotDesktop` under the current logged-in user
/// without ever switching the physical interactive desktop.
pub fn ensure_bot_desktop() -> Result<ScopedDesktop, String> {
    let mut guard = PROCESS_BOT_DESKTOP
        .lock()
        .map_err(|_| "QianjiBotDesktop handle mutex poisoned".to_string())?;
    if *guard != 0 {
        return Ok(ScopedDesktop(*guard as HDESK));
    }
    let wide_name = to_wide_null(BOT_DESKTOP_NAME);
    let mut last_code: u32 = 0;
    for attempt in 0..15 {
        let existing = unsafe { OpenDesktopW(wide_name.as_ptr(), 0, 0, BOT_DESKTOP_ACCESS) };
        if !existing.is_null() {
            *guard = existing as usize;
            return Ok(ScopedDesktop(existing));
        }
        let created = unsafe {
            CreateDesktopW(wide_name.as_ptr(), null(), null(), 0, BOT_DESKTOP_ACCESS, null())
        };
        if !created.is_null() {
            *guard = created as usize;
            return Ok(ScopedDesktop(created));
        }
        last_code = unsafe { GetLastError() };
        if last_code != 5 || attempt == 14 {
            break;
        }
        thread::sleep(Duration::from_millis(15));
    }
    Err(format!(
        "Could not create or open secondary desktop '{BOT_DESKTOP_NAME}' (Win32 error {last_code})"
    ))
}

pub fn format_hwnd(hwnd: HWND) -> String {
    format!("0x{:x}", hwnd as usize)
}

pub fn parse_hwnd(raw: &str) -> Result<HWND, String> {
    let trimmed = raw.trim();
    let value = if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        usize::from_str_radix(hex, 16)
    } else {
        trimmed.parse::<usize>()
    }
    .map_err(|_| format!("Invalid HWND identifier: '{raw}'"))?;
    if value == 0 {
        return Err("HWND cannot be null (0)".to_string());
    }
    Ok(value as HWND)
}

pub fn hwnd_process_info(hwnd: HWND) -> (u32, Option<String>) {
    if hwnd.is_null() {
        return (0, None);
    }
    let root = unsafe {
        let anc = GetAncestor(hwnd, GA_ROOT);
        if anc.is_null() {
            hwnd
        } else {
            anc
        }
    };
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(root, &mut pid);
    }
    if pid == 0 {
        return (0, None);
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return (pid, None);
    }
    let mut buffer = vec![0_u16; 1024];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe {
        CloseHandle(process);
    }
    if ok == 0 || size == 0 {
        return (pid, None);
    }
    let full = PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize]));
    let app = full
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string);
    (pid, app)
}

pub fn is_hwnd_on_bot_desktop(hwnd: HWND) -> bool {
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let tid = unsafe { GetWindowThreadProcessId(hwnd, null_mut()) };
    if tid == 0 {
        return false;
    }
    // Note per MSDN: handle returned by GetThreadDesktop must NOT be passed to CloseDesktop.
    let thread_desk = unsafe { GetThreadDesktop(tid) };
    if thread_desk.is_null() {
        return false;
    }
    let mut buf = [0_u16; 128];
    let mut needed: u32 = 0;
    let ok = unsafe {
        GetUserObjectInformationW(
            thread_desk,
            UOI_NAME,
            buf.as_mut_ptr().cast(),
            (buf.len() * 2) as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return false;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let name = String::from_utf16_lossy(&buf[..len]);
    name.eq_ignore_ascii_case(BOT_DESKTOP_NAME)
}

#[derive(Clone)]
pub struct RawBotWindow {
    pub hwnd: HWND,
    pub info: WinDesktopWindow,
    pub iconic: bool,
}

unsafe extern "system" fn enum_bot_desktop_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let title_len = GetWindowTextLengthW(hwnd);
    if (ex_style & WS_EX_TOOLWINDOW) != 0 && title_len <= 0 {
        return 1;
    }
    let mut title = String::new();
    if title_len > 0 {
        let mut buf = vec![0_u16; title_len as usize + 1];
        let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if copied > 0 {
            title = String::from_utf16_lossy(&buf[..copied as usize]);
        }
    }
    let mut rect: RECT = zeroed();
    if GetWindowRect(hwnd, &mut rect) == 0 {
        return 1;
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let iconic = IsIconic(hwnd) != 0;
    if !iconic && (width <= 4 || height <= 4) {
        return 1;
    }
    let (pid, app) = hwnd_process_info(hwnd);
    if title.trim().is_empty() {
        if let Some(app_name) = &app {
            title = app_name.clone();
        } else {
            return 1;
        }
    }
    let list = &mut *(lparam as *mut Vec<RawBotWindow>);
    list.push(RawBotWindow {
        hwnd,
        iconic,
        info: WinDesktopWindow {
            hwnd: format_hwnd(hwnd),
            title,
            app,
            pid,
            x: rect.left,
            y: rect.top,
            width,
            height,
        },
    });
    1
}

pub fn enumerate_bot_desktop_windows(clamp_to_canvas: bool) -> Result<Vec<RawBotWindow>, String> {
    let desktop = ensure_bot_desktop()?;
    let mut list = Vec::<RawBotWindow>::new();
    let ok = unsafe {
        SetLastError(0);
        EnumDesktopWindows(
            desktop.as_raw(),
            Some(enum_bot_desktop_proc),
            (&mut list as *mut Vec<RawBotWindow>) as LPARAM,
        )
    };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        // On a freshly created Win32 secondary desktop with zero GUI threads/windows yet,
        // win32k NtUserBuildHwndList reports 0 / ERROR_FILE_NOT_FOUND (2) / ERROR_NO_MORE_FILES (18).
        if !matches!(err, 0 | 2 | 18) {
            return Err(format!(
                "EnumDesktopWindows failed on '{BOT_DESKTOP_NAME}' (Win32 error {err})"
            ));
        }
    }
    if clamp_to_canvas {
        let max_w = DEFAULT_DESKTOP_WIDTH as i32;
        let max_h = DEFAULT_DESKTOP_HEIGHT as i32 - TASKBAR_HEIGHT;
        for item in &mut list {
            if item.iconic {
                continue;
            }
            let clamped_w = item.info.width.clamp(160, max_w);
            let clamped_h = item.info.height.clamp(100, max_h);
            let clamped_x = item.info.x.clamp(0, (max_w - clamped_w).max(0));
            let clamped_y = item.info.y.clamp(0, (max_h - clamped_h).max(0));
            if clamped_x != item.info.x
                || clamped_y != item.info.y
                || clamped_w != item.info.width
                || clamped_h != item.info.height
            {
                unsafe {
                    let _ = SetWindowPos(
                        item.hwnd,
                        null_mut(),
                        clamped_x,
                        clamped_y,
                        clamped_w,
                        clamped_h,
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                    );
                }
                item.info.x = clamped_x;
                item.info.y = clamped_y;
                item.info.width = clamped_w;
                item.info.height = clamped_h;
            }
        }
    }
    Ok(list)
}

pub fn read_registry_string(hive: HANDLE, subkey: &str, value_name: Option<&str>) -> Option<String> {
    let subkey_w = to_wide_null(subkey);
    let value_w = value_name.map(to_wide_null);
    let value_ptr = value_w.as_ref().map_or(null(), |v| v.as_ptr());
    let mut buf = [0_u16; 512];
    let mut byte_len = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            hive,
            subkey_w.as_ptr(),
            value_ptr,
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            null_mut(),
            buf.as_mut_ptr().cast(),
            &mut byte_len,
        )
    };
    if status != 0 || byte_len < 2 {
        return None;
    }
    let u16_len = (byte_len as usize / 2).min(buf.len());
    let end = buf[..u16_len].iter().position(|&c| c == 0).unwrap_or(u16_len);
    let text = String::from_utf16_lossy(&buf[..end]).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
