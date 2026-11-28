//! Windows Child Session status probe (`wtsapi32.dll`), sign-out detection,
//! and elevated `qianji-enable-child-sessions.exe` launcher.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{
    agent_client, bot_desktop_root_dir, default_fenced_roots, now_epoch_ms, WinDesktopCursor,
    WinDesktopEnableChildSessionResult, WinDesktopStatus, WinDesktopStatusRequest,
    BOT_DESKTOP_NAME, BOT_DESKTOP_STATION_PATH, DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH,
};

pub const VER_SUITE_PERSONAL: u16 = 0x0200;
pub const VER_NT_WORKSTATION: u8 = 1;
pub const WIN_DESKTOP_EXE_NAME: &str = "qianji-win-desktop.exe";
pub const ENABLE_CHILD_SESSIONS_EXE_NAME: &str = "qianji-enable-child-sessions.exe";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SignOutMarker {
    auth_luid: Option<String>,
}

/// Pure edition classifier so unit tests can verify Home vs Pro/Enterprise/Server logic.
pub fn classify_edition_pro_support(
    edition_id: Option<&str>,
    suite_mask: u16,
    product_type: u8,
) -> bool {
    if product_type != 0 && product_type != VER_NT_WORKSTATION {
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

/// Pure sign-out requirement detector: `WTSEnableChildSessions(TRUE)` requires signing out
/// and signing back in once so LSA caches passwordless loopback credentials for the session.
pub fn compute_sign_out_required(
    child_session_enabled: bool,
    child_session_active: bool,
    current_auth_luid: Option<&str>,
    recorded_enable_luid: Option<&str>,
) -> bool {
    if !child_session_enabled || child_session_active {
        return false;
    }
    match (current_auth_luid, recorded_enable_luid) {
        (Some(cur), Some(rec)) => !cur.trim().is_empty() && cur.trim() == rec.trim(),
        _ => false,
    }
}

pub fn locate_bundled_helper_exe(file_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(dir) = executable.parent() {
            candidates.push(dir.join("harness").join(file_name));
            candidates.push(dir.join("resources").join("harness").join(file_name));
            candidates.push(dir.join(file_name));
        }
    }
    #[cfg(any(debug_assertions, test))]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("harness")
            .join(file_name),
    );
    candidates.into_iter().find(|p| p.is_file())
}

fn marker_file_path() -> PathBuf {
    bot_desktop_root_dir().join("child-session-marker.json")
}

pub(crate) fn read_recorded_enable_luid() -> Option<String> {
    let raw = fs::read_to_string(marker_file_path()).ok()?;
    let parsed: SignOutMarker = serde_json::from_str(&raw).ok()?;
    parsed.auth_luid.filter(|s| !s.trim().is_empty())
}

pub(crate) fn record_enable_luid(luid: Option<&str>) {
    let Some(luid_str) = luid.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    let path = marker_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let marker = SignOutMarker {
        auth_luid: Some(luid_str.to_string()),
    };
    if let Ok(raw) = serde_json::to_string(&marker) {
        let _ = fs::write(path, raw);
    }
}

#[cfg(windows)]
mod imp {
    use core::ffi::c_void;
    use std::mem::{size_of, transmute, zeroed};
    use std::ptr::{null, null_mut};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, WaitForSingleObject};

    use super::*;

    type Handle = *mut c_void;
    type HModule = *mut c_void;
    type FnWtsIsChildSessionsEnabled = unsafe extern "system" fn(pb_enabled: *mut i32) -> i32;
    type FnWtsEnableChildSessions = unsafe extern "system" fn(b_enable: i32) -> i32;
    type FnWtsGetChildSessionId = unsafe extern "system" fn(p_session_id: *mut u32) -> i32;
    type FnRtlGetVersion = unsafe extern "system" fn(lp_version: *mut OsVersionInfoExW) -> i32;

    const HKEY_LOCAL_MACHINE: Handle = 0x8000_0002_usize as isize as Handle;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    const RRF_RT_REG_EXPAND_SZ: u32 = 0x0000_0004;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_STATISTICS_CLASS: u32 = 10;
    const TOKEN_ELEVATION_CLASS: u32 = 20;
    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
    const SW_SHOWNORMAL: i32 = 1;

    #[repr(C)]
    struct TokenElevation {
        token_is_elevated: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Luid {
        low_part: u32,
        high_part: i32,
    }

    #[repr(C)]
    struct TokenStatistics {
        token_id: Luid,
        authentication_id: Luid,
        expiration_time: i64,
        token_type: i32,
        impersonation_level: i32,
        dynamic_charged: u32,
        dynamic_available: u32,
        group_count: u32,
        privilege_count: u32,
        modified_id: Luid,
    }

    #[repr(C)]
    struct OsVersionInfoExW {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
        w_service_pack_major: u16,
        w_service_pack_minor: u16,
        w_suite_mask: u16,
        w_product_type: u8,
        w_reserved: u8,
    }

    #[repr(C)]
    struct ShellExecuteInfoW {
        cb_size: u32,
        f_mask: u32,
        hwnd: Handle,
        lp_verb: *const u16,
        lp_file: *const u16,
        lp_parameters: *const u16,
        lp_directory: *const u16,
        n_show: i32,
        h_inst_app: Handle,
        lp_id_list: *mut c_void,
        lp_class: *const u16,
        hkey_class: Handle,
        dw_hot_key: u32,
        h_icon_or_monitor: Handle,
        h_process: Handle,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(lp_module_name: *const u16) -> HModule;
        fn LoadLibraryW(lp_lib_file_name: *const u16) -> HModule;
        fn GetProcAddress(h_module: HModule, lp_proc_name: *const u8) -> *const c_void;
        fn GetLastError() -> u32;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            hkey: Handle,
            lp_sub_key: *const u16,
            lp_value: *const u16,
            dw_flags: u32,
            pdw_type: *mut u32,
            pv_data: *mut c_void,
            pcb_data: *mut u32,
        ) -> i32;
        fn OpenProcessToken(process_handle: Handle, desired_access: u32, token_handle: *mut Handle) -> i32;
        fn GetTokenInformation(
            token_handle: Handle,
            token_information_class: u32,
            token_information: *mut c_void,
            token_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteExW(p_exec_info: *mut ShellExecuteInfoW) -> i32;
    }

    pub(crate) fn to_wide_null(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct WtsChildSessionApi {
        is_enabled: Option<FnWtsIsChildSessionsEnabled>,
        enable: Option<FnWtsEnableChildSessions>,
        get_session_id: Option<FnWtsGetChildSessionId>,
    }

    fn load_wts_api() -> &'static WtsChildSessionApi {
        static API: OnceLock<WtsChildSessionApi> = OnceLock::new();
        API.get_or_init(|| {
            let dll_w = to_wide_null("wtsapi32.dll");
            let mut module = unsafe { GetModuleHandleW(dll_w.as_ptr()) };
            if module.is_null() {
                module = unsafe { LoadLibraryW(dll_w.as_ptr()) };
            }
            if module.is_null() {
                return WtsChildSessionApi { is_enabled: None, enable: None, get_session_id: None };
            }
            unsafe {
                let p_is = GetProcAddress(module, b"WTSIsChildSessionsEnabled\0".as_ptr());
                let p_en = GetProcAddress(module, b"WTSEnableChildSessions\0".as_ptr());
                let p_id = GetProcAddress(module, b"WTSGetChildSessionId\0".as_ptr());
                WtsChildSessionApi {
                    is_enabled: (!p_is.is_null()).then(|| transmute(p_is)),
                    enable: (!p_en.is_null()).then(|| transmute(p_en)),
                    get_session_id: (!p_id.is_null()).then(|| transmute(p_id)),
                }
            }
        })
    }

    pub(crate) fn read_reg_string(hive: Handle, subkey: &str, value_name: Option<&str>) -> Option<String> {
        let subkey_w = to_wide_null(subkey);
        let value_w = value_name.map(to_wide_null);
        let mut buf = [0_u16; 512];
        let mut byte_len = (buf.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                hive,
                subkey_w.as_ptr(),
                value_w.as_ref().map_or(null(), |v| v.as_ptr()),
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
        (!text.is_empty()).then_some(text)
    }

    pub fn detect_os_edition() -> (Option<String>, u32, bool) {
        let edition_id = read_reg_string(
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

    fn query_token_info() -> (bool, Option<String>) {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 || token.is_null() {
            return (false, None);
        }
        let mut elev = TokenElevation { token_is_elevated: 0 };
        let mut ret_len = 0_u32;
        let ok_elev = unsafe {
            GetTokenInformation(
                token,
                TOKEN_ELEVATION_CLASS,
                (&mut elev as *mut TokenElevation).cast(),
                size_of::<TokenElevation>() as u32,
                &mut ret_len,
            )
        };
        let mut stats: TokenStatistics = unsafe { zeroed() };
        let ok_stats = unsafe {
            GetTokenInformation(
                token,
                TOKEN_STATISTICS_CLASS,
                (&mut stats as *mut TokenStatistics).cast(),
                size_of::<TokenStatistics>() as u32,
                &mut ret_len,
            )
        };
        unsafe { CloseHandle(token) };
        let luid = (ok_stats != 0).then(|| {
            format!("{:08x}:{:08x}", stats.authentication_id.high_part, stats.authentication_id.low_part)
        });
        (ok_elev != 0 && elev.token_is_elevated != 0, luid)
    }

    fn probe_wts_state(api: &WtsChildSessionApi) -> (bool, Option<u32>) {
        let mut enabled_flag = 0_i32;
        let enabled = api
            .is_enabled
            .map(|f| unsafe { f(&mut enabled_flag) != 0 && enabled_flag != 0 })
            .unwrap_or(false);
        let mut sid = u32::MAX;
        let active_id = api.get_session_id.and_then(|f| {
            if unsafe { f(&mut sid) } != 0 && sid != u32::MAX {
                Some(sid)
            } else {
                None
            }
        });
        (enabled, active_id)
    }

    pub fn query_status(req: &WinDesktopStatusRequest) -> WinDesktopStatus {
        let (edition_id, os_build, pro_supported) = detect_os_edition();
        let (elevated, auth_luid) = query_token_info();
        let api = load_wts_api();
        let wts_available = api.is_enabled.is_some() && api.enable.is_some();
        let (child_session_enabled, child_session_id) = probe_wts_state(api);
        let viewer_probe = agent_client::probe_viewer_status();
        let agent_probe = agent_client::probe_child_agent_status();
        let child_session_active = child_session_id.is_some() || agent_probe.is_some();
        let recorded_luid = read_recorded_enable_luid();
        let sign_out_required = compute_sign_out_required(
            child_session_enabled,
            child_session_active,
            auth_luid.as_deref(),
            recorded_luid.as_deref(),
        );

        let (profile_dir, fenced_roots) = default_fenced_roots(
            req.isolated_profile_dir.as_deref(),
            req.workspace_dir.as_deref(),
        );

        let (width, height, open_windows, cursor) = if let Some(ag) = agent_probe {
            let cur = Some(WinDesktopCursor {
                x: ag.cursor_x,
                y: ag.cursor_y,
                viewport_width: ag.width,
                viewport_height: ag.height,
                action: "move".to_string(),
                ts: now_epoch_ms(),
            });
            (ag.width, ag.height, ag.open_windows, cur)
        } else if let Some(vp) = &viewer_probe {
            (vp.width, vp.height, Vec::new(), None)
        } else {
            (DEFAULT_DESKTOP_WIDTH, DEFAULT_DESKTOP_HEIGHT, Vec::new(), None)
        };

        let hint = if !pro_supported {
            Some("Windows 家庭版不支持原生 Child Sessions 独立子会话，请切换至本地 Linux 桌面 (WSL2)。".to_string())
        } else if !child_session_enabled {
            Some("首次使用需管理员开启系统 Child Sessions（开启后注销并重新登录一次 Windows 即可免密直连原生 Win11 桌面）。".to_string())
        } else if sign_out_required {
            Some("已开启系统 Child Sessions，请保存工作并注销重新登录一次 Windows 以激活免密独立桌面。".to_string())
        } else {
            None
        };

        WinDesktopStatus {
            ok: true,
            account_mode: "current-user".to_string(),
            backend: if pro_supported && wts_available { "rdp-child-session" } else { "unavailable" }.to_string(),
            pro_supported,
            edition_id,
            os_build,
            elevated,
            wts_api_available: wts_available,
            child_session_enabled,
            child_session_active,
            sign_out_required,
            viewer_open: viewer_probe.is_some(),
            child_session_id,
            desktop_name: BOT_DESKTOP_NAME.to_string(),
            desktop_station_path: BOT_DESKTOP_STATION_PATH.to_string(),
            desktop_ready: pro_supported && child_session_enabled && !sign_out_required,
            resolution: format!("{width}x{height}"),
            isolated_profile_dir: Some(profile_dir.to_string_lossy().into_owned()),
            fenced_roots,
            open_windows,
            cursor,
            elevation_hint: hint,
        }
    }

    pub fn enable_child_session(req: &WinDesktopStatusRequest) -> WinDesktopEnableChildSessionResult {
        let api = load_wts_api();
        let (_, _, pro_supported) = detect_os_edition();
        let (elevated, auth_luid) = query_token_info();

        if !pro_supported || api.enable.is_none() {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: false,
                requires_elevation: false,
                sign_out_required: false,
                elevation_hint: status.elevation_hint.clone(),
                last_error_code: None,
                status,
            };
        }

        let (already_enabled, _) = probe_wts_state(api);
        if already_enabled {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: true,
                requires_elevation: false,
                sign_out_required: status.sign_out_required,
                elevation_hint: status.elevation_hint.clone(),
                last_error_code: None,
                status,
            };
        }

        if elevated {
            if let Some(enable_fn) = api.enable {
                let ok = unsafe { enable_fn(1) };
                let err = (ok == 0).then(|| unsafe { GetLastError() });
                if ok != 0 {
                    record_enable_luid(auth_luid.as_deref());
                }
                let status = query_status(req);
                return WinDesktopEnableChildSessionResult {
                    enabled: status.child_session_enabled,
                    requires_elevation: false,
                    sign_out_required: status.sign_out_required,
                    elevation_hint: status.elevation_hint.clone(),
                    last_error_code: err,
                    status,
                };
            }
        }

        if req.prompt_uac == Some(false) {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: false,
                requires_elevation: true,
                sign_out_required: false,
                elevation_hint: status.elevation_hint.clone(),
                last_error_code: Some(5),
                status,
            };
        }

        let Some(helper_exe) = locate_bundled_helper_exe(ENABLE_CHILD_SESSIONS_EXE_NAME) else {
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: false,
                requires_elevation: true,
                sign_out_required: false,
                elevation_hint: Some(format!("Missing setup helper {ENABLE_CHILD_SESSIONS_EXE_NAME}")),
                last_error_code: Some(2),
                status,
            };
        };

        let verb_w = to_wide_null("runas");
        let file_w = to_wide_null(&helper_exe.to_string_lossy());
        let mut sei: ShellExecuteInfoW = unsafe { zeroed() };
        sei.cb_size = size_of::<ShellExecuteInfoW>() as u32;
        sei.f_mask = SEE_MASK_NOCLOSEPROCESS;
        sei.lp_verb = verb_w.as_ptr();
        sei.lp_file = file_w.as_ptr();
        sei.n_show = SW_SHOWNORMAL;

        let launched = unsafe { ShellExecuteExW(&mut sei) };
        if launched == 0 {
            let err = unsafe { GetLastError() };
            let status = query_status(req);
            return WinDesktopEnableChildSessionResult {
                enabled: false,
                requires_elevation: true,
                sign_out_required: false,
                elevation_hint: Some(if err == 1223 {
                    "已取消管理员授权，尚未启用 Windows Child Sessions。".to_string()
                } else {
                    format!("无法启动管理员设置助手 (Win32 error {err})。")
                }),
                last_error_code: Some(err),
                status,
            };
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let (now_enabled, _) = probe_wts_state(api);
            if now_enabled {
                record_enable_luid(auth_luid.as_deref());
                break;
            }
            if !sei.h_process.is_null() && unsafe { WaitForSingleObject(sei.h_process, 150) } == 0 {
                let (after_exit, _) = probe_wts_state(api);
                if after_exit {
                    record_enable_luid(auth_luid.as_deref());
                }
                break;
            }
        }
        if !sei.h_process.is_null() {
            unsafe { CloseHandle(sei.h_process) };
        }

        let status = query_status(req);
        WinDesktopEnableChildSessionResult {
            enabled: status.child_session_enabled,
            requires_elevation: !status.child_session_enabled,
            sign_out_required: status.sign_out_required,
            elevation_hint: status.elevation_hint.clone(),
            last_error_code: None,
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
        child_session_active: false,
        sign_out_required: false,
        viewer_open: false,
        child_session_id: None,
        desktop_name: BOT_DESKTOP_NAME.to_string(),
        desktop_station_path: BOT_DESKTOP_STATION_PATH.to_string(),
        desktop_ready: false,
        resolution: format!("{DEFAULT_DESKTOP_WIDTH}x{DEFAULT_DESKTOP_HEIGHT}"),
        isolated_profile_dir: Some(profile_dir.to_string_lossy().into_owned()),
        fenced_roots,
        open_windows: Vec::new(),
        cursor: None,
        elevation_hint: Some("Windows Child Session requires Windows OS.".to_string()),
    }
}

#[cfg(not(windows))]
pub fn enable_child_session(req: &WinDesktopStatusRequest) -> WinDesktopEnableChildSessionResult {
    let status = query_status(req);
    WinDesktopEnableChildSessionResult {
        enabled: false,
        requires_elevation: false,
        sign_out_required: false,
        elevation_hint: status.elevation_hint.clone(),
        last_error_code: None,
        status,
    }
}
