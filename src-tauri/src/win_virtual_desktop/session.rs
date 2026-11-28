//! Dual-tier Windows Session / Desktop status probe & dynamic `wtsapi32.dll` loader.
//!
//! - Tier 1: Dynamically probes `wtsapi32.dll` (`WTSIsChildSessionsEnabled`,
//!   `WTSEnableChildSessions`, `WTSGetChildSessionId`) and detects Windows Pro /
//!   Enterprise / Education / Server edition support.
//! - Tier 2: Zero-UAC isolated `WinSta0\QianjiBotDesktop` secondary desktop.

use super::{
    default_fenced_roots, load_desktop_state, WinDesktopCursor, WinDesktopEnableChildSessionResult,
    WinDesktopStatus, WinDesktopStatusRequest, BOT_DESKTOP_NAME, BOT_DESKTOP_STATION_PATH,
    DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH,
};

pub const VER_SUITE_PERSONAL: u16 = 0x0200;
pub const VER_NT_WORKSTATION: u8 = 1;

/// Pure edition classifier so unit tests can verify Home vs Pro/Enterprise/Server logic.
pub fn classify_edition_pro_support(
    edition_id: Option<&str>,
    suite_mask: u16,
    product_type: u8,
) -> bool {
    if product_type != 0 && product_type != VER_NT_WORKSTATION {
        // Domain Controller (2) or Windows Server (3)
        return true;
    }
    if let Some(raw) = edition_id {
        let lower = raw.trim().to_ascii_lowercase();
        if !lower.is_empty() {
            if lower.starts_with("core") || lower.contains("home") || lower == "starter" {
                return false;
            }
            if lower.contains("professional")
                || lower.contains("enterprise")
                || lower.contains("education")
                || lower.contains("server")
                || lower.contains("iotenterprise")
                || lower.contains("cloudedition")
            {
                return true;
            }
        }
    }
    if (suite_mask & VER_SUITE_PERSONAL) != 0 {
        return false;
    }
    suite_mask != 0 || product_type == VER_NT_WORKSTATION
}

#[cfg(windows)]
mod imp {
    use std::mem::{size_of, transmute, zeroed};
    use std::ptr::null_mut;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    use super::*;
    use crate::win_virtual_desktop::win32_ffi::{
        ensure_bot_desktop, enumerate_bot_desktop_windows, read_registry_string, to_wide_null,
        GetLastError, GetModuleHandleW, GetProcAddress, GetTokenInformation, LoadLibraryW,
        OpenProcessToken, OsVersionInfoExW, TokenElevation, HKEY_LOCAL_MACHINE, HMODULE,
        TOKEN_ELEVATION_CLASS, TOKEN_QUERY,
    };

    type FnWtsIsChildSessionsEnabled = unsafe extern "system" fn(pb_enabled: *mut i32) -> i32;
    type FnWtsEnableChildSessions = unsafe extern "system" fn(b_enable: i32) -> i32;
    type FnWtsGetChildSessionId = unsafe extern "system" fn(p_session_id: *mut u32) -> i32;
    type FnRtlGetVersion = unsafe extern "system" fn(lp_version: *mut OsVersionInfoExW) -> i32;

    struct WtsChildSessionApi {
        is_enabled: Option<FnWtsIsChildSessionsEnabled>,
        enable: Option<FnWtsEnableChildSessions>,
        get_session_id: Option<FnWtsGetChildSessionId>,
    }

    impl WtsChildSessionApi {
        fn is_available(&self) -> bool {
            self.is_enabled.is_some() && self.enable.is_some()
        }
    }

    fn load_wts_api() -> &'static WtsChildSessionApi {
        static API: OnceLock<WtsChildSessionApi> = OnceLock::new();
        API.get_or_init(|| {
            let dll_w = to_wide_null("wtsapi32.dll");
            let mut module: HMODULE = unsafe { GetModuleHandleW(dll_w.as_ptr()) };
            if module.is_null() {
                module = unsafe { LoadLibraryW(dll_w.as_ptr()) };
            }
            if module.is_null() {
                return WtsChildSessionApi {
                    is_enabled: None,
                    enable: None,
                    get_session_id: None,
                };
            }
            unsafe {
                let p_is = GetProcAddress(module, b"WTSIsChildSessionsEnabled\0".as_ptr());
                let p_en = GetProcAddress(module, b"WTSEnableChildSessions\0".as_ptr());
                let p_id = GetProcAddress(module, b"WTSGetChildSessionId\0".as_ptr());
                WtsChildSessionApi {
                    is_enabled: if p_is.is_null() {
                        None
                    } else {
                        Some(transmute::<*const core::ffi::c_void, FnWtsIsChildSessionsEnabled>(p_is))
                    },
                    enable: if p_en.is_null() {
                        None
                    } else {
                        Some(transmute::<*const core::ffi::c_void, FnWtsEnableChildSessions>(p_en))
                    },
                    get_session_id: if p_id.is_null() {
                        None
                    } else {
                        Some(transmute::<*const core::ffi::c_void, FnWtsGetChildSessionId>(p_id))
                    },
                }
            }
        })
    }

    pub fn detect_os_edition() -> (Option<String>, u32, bool) {
        let edition_id = read_registry_string(
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
            Some("EditionID"),
        );
        let mut info: OsVersionInfoExW = unsafe { zeroed() };
        info.dw_os_version_info_size = size_of::<OsVersionInfoExW>() as u32;
        let ntdll_w = to_wide_null("ntdll.dll");
        let ntdll = unsafe { GetModuleHandleW(ntdll_w.as_ptr()) };
        if !ntdll.is_null() {
            let proc_addr = unsafe { GetProcAddress(ntdll, b"RtlGetVersion\0".as_ptr()) };
            if !proc_addr.is_null() {
                let rtl_get_version: FnRtlGetVersion = unsafe { transmute(proc_addr) };
                let _ = unsafe { rtl_get_version(&mut info) };
            }
        }
        let pro_supported = classify_edition_pro_support(
            edition_id.as_deref(),
            info.w_suite_mask,
            info.w_product_type,
        );
        (edition_id, info.dw_build_number, pro_supported)
    }

    pub fn is_process_elevated() -> bool {
        let mut token = null_mut();
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
        if opened == 0 || token.is_null() {
            return false;
        }
        let mut elevation = TokenElevation {
            token_is_elevated: 0,
        };
        let mut ret_len: u32 = 0;
        let ok = unsafe {
            GetTokenInformation(
                token,
                TOKEN_ELEVATION_CLASS,
                (&mut elevation as *mut TokenElevation).cast(),
                size_of::<TokenElevation>() as u32,
                &mut ret_len,
            )
        };
        unsafe {
            CloseHandle(token);
        }
        ok != 0 && elevation.token_is_elevated != 0
    }

    fn probe_child_session_state(api: &WtsChildSessionApi) -> (bool, Option<u32>) {
        let mut enabled_flag: i32 = 0;
        let enabled = api
            .is_enabled
            .map(|f| unsafe { f(&mut enabled_flag) != 0 && enabled_flag != 0 })
            .unwrap_or(false);
        let mut session_id: u32 = 0;
        let active_id = api.get_session_id.and_then(|f| {
            if unsafe { f(&mut session_id) } != 0 {
                Some(session_id)
            } else {
                None
            }
        });
        (enabled, active_id)
    }

    pub fn query_status(req: &WinDesktopStatusRequest) -> WinDesktopStatus {
        let (edition_id, os_build, pro_supported) = detect_os_edition();
        let elevated = is_process_elevated();
        let api = load_wts_api();
        let (child_session_enabled, child_session_id) = probe_child_session_state(api);

        let desktop_ready = ensure_bot_desktop().is_ok();
        let open_windows = enumerate_bot_desktop_windows(false)
            .unwrap_or_default()
            .into_iter()
            .map(|w| w.info)
            .collect::<Vec<_>>();

        let (profile_dir, fenced_roots) = default_fenced_roots(
            req.isolated_profile_dir.as_deref(),
            req.workspace_dir.as_deref(),
        );

        let backend = if child_session_enabled && child_session_id.is_some() {
            "rdp-child-session"
        } else if desktop_ready {
            "win32-secondary-desktop"
        } else {
            "unavailable"
        };

        let persisted = load_desktop_state();
        let cursor = persisted.cursor_initialized.then(|| WinDesktopCursor {
            x: persisted.cursor_x,
            y: persisted.cursor_y,
            viewport_width: DEFAULT_DESKTOP_WIDTH,
            viewport_height: DEFAULT_DESKTOP_HEIGHT,
            action: persisted.last_action,
            ts: persisted.last_ts,
        });

        WinDesktopStatus {
            ok: true,
            account_mode: "current-user".to_string(),
            backend: backend.to_string(),
            pro_supported,
            edition_id,
            os_build,
            elevated,
            wts_api_available: api.is_available(),
            child_session_enabled,
            child_session_id,
            desktop_name: BOT_DESKTOP_NAME.to_string(),
            desktop_station_path: BOT_DESKTOP_STATION_PATH.to_string(),
            desktop_ready,
            isolated_profile_dir: Some(profile_dir.to_string_lossy().into_owned()),
            fenced_roots,
            open_windows,
            cursor,
        }
    }

    pub fn enable_child_session(
        req: &WinDesktopStatusRequest,
    ) -> WinDesktopEnableChildSessionResult {
        let api = load_wts_api();
        let (_, _, pro_supported) = detect_os_edition();
        let elevated = is_process_elevated();

        if !pro_supported {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: status.child_session_enabled,
                requires_elevation: false,
                elevation_hint: Some(
                    "Windows Home edition does not support RDP Child Sessions; using zero-UAC Win32 Secondary Desktop (QianjiBotDesktop)."
                        .to_string(),
                ),
                last_error_code: None,
                status,
            };
        }

        let Some(enable_fn) = api.enable else {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: false,
                requires_elevation: false,
                elevation_hint: Some(
                    "wtsapi32.dll does not export WTSEnableChildSessions on this Windows build; using Win32 Secondary Desktop (QianjiBotDesktop)."
                        .to_string(),
                ),
                last_error_code: None,
                status,
            };
        };

        let (already_enabled, _) = probe_child_session_state(api);
        if already_enabled {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: true,
                requires_elevation: false,
                elevation_hint: None,
                last_error_code: None,
                status,
            };
        }

        if !elevated {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: false,
                requires_elevation: true,
                elevation_hint: Some(
                    "Administrator elevation is required to call WTSEnableChildSessions(TRUE). Run Qianji as Administrator once to enable RDP Child Sessions, or continue with zero-UAC Win32 Secondary Desktop (QianjiBotDesktop)."
                        .to_string(),
                ),
                last_error_code: Some(5),
                status,
            };
        }

        let ok = unsafe { enable_fn(1) };
        let err_code = if ok == 0 {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        let status = query_status(req);
        let access_denied = matches!(err_code, Some(5 | 1314));
        let hint = if ok != 0 {
            None
        } else if access_denied {
            Some(
                "Access denied while calling WTSEnableChildSessions(TRUE); run elevated as Administrator or continue with Win32 Secondary Desktop (QianjiBotDesktop)."
                    .to_string(),
            )
        } else {
            Some(format!(
                "WTSEnableChildSessions(TRUE) returned Win32 error {}; falling back to Win32 Secondary Desktop (QianjiBotDesktop).",
                err_code.unwrap_or(0)
            ))
        };

        WinDesktopEnableChildSessionResult {
            enabled: ok != 0 || status.child_session_enabled,
            requires_elevation: access_denied,
            elevation_hint: hint,
            last_error_code: err_code,
            status,
        }
    }
}

#[cfg(windows)]
pub use imp::{enable_child_session, query_status};

#[cfg(not(windows))]
pub fn query_status(req: &WinDesktopStatusRequest) -> WinDesktopStatus {
    let (profile_dir, fenced_roots) = default_fenced_roots(
        req.isolated_profile_dir.as_deref(),
        req.workspace_dir.as_deref(),
    );
    WinDesktopStatus {
        ok: true,
        account_mode: "current-user".to_string(),
        backend: "unavailable".to_string(),
        pro_supported: false,
        edition_id: None,
        os_build: 0,
        elevated: false,
        wts_api_available: false,
        child_session_enabled: false,
        child_session_id: None,
        desktop_name: BOT_DESKTOP_NAME.to_string(),
        desktop_station_path: BOT_DESKTOP_STATION_PATH.to_string(),
        desktop_ready: false,
        isolated_profile_dir: Some(profile_dir.to_string_lossy().into_owned()),
        fenced_roots,
        open_windows: Vec::new(),
        cursor: None,
    }
}

#[cfg(not(windows))]
pub fn enable_child_session(req: &WinDesktopStatusRequest) -> WinDesktopEnableChildSessionResult {
    WinDesktopEnableChildSessionResult {
        enabled: false,
        requires_elevation: false,
        elevation_hint: Some("Windows Virtual Desktop requires Windows OS.".to_string()),
        last_error_code: None,
        status: query_status(req),
    }
}
