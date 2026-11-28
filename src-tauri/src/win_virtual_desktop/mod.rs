//! Windows Multi-Instance Virtual Desktop backend (`local-win-pip`).
//!
//! Operates strictly under the current logged-in Windows user account without
//! ever calling `SwitchDesktop`, `SetCursorPos`, or `SendInput`.

pub mod input;
pub mod input_model;
pub mod launcher;
pub mod session;

#[cfg(windows)]
pub(crate) mod compositor;
#[cfg(windows)]
pub(crate) mod dib;
#[cfg(windows)]
pub(crate) mod win32_ffi;

#[cfg(test)]
mod tests;

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BOT_DESKTOP_NAME: &str = "QianjiBotDesktop";
pub const BOT_DESKTOP_STATION_PATH: &str = "winsta0\\QianjiBotDesktop";
pub const DEFAULT_DESKTOP_WIDTH: u32 = 1280;
pub const DEFAULT_DESKTOP_HEIGHT: u32 = 800;
pub const TASKBAR_HEIGHT: i32 = 40;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopWindow {
    pub hwnd: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopCursor {
    pub x: i32,
    pub y: i32,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub action: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopStatus {
    pub ok: bool,
    pub account_mode: String,
    pub backend: String,
    pub pro_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edition_id: Option<String>,
    pub os_build: u32,
    pub elevated: bool,
    pub wts_api_available: bool,
    pub child_session_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<u32>,
    pub desktop_name: String,
    pub desktop_station_path: String,
    pub desktop_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolated_profile_dir: Option<String>,
    pub fenced_roots: Vec<String>,
    pub open_windows: Vec<WinDesktopWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<WinDesktopCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopEnableChildSessionResult {
    pub enabled: bool,
    pub requires_elevation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elevation_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<u32>,
    #[serde(flatten)]
    pub status: WinDesktopStatus,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopStatusRequest {
    pub isolated_profile_dir: Option<String>,
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopCaptureRequest {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub draw_cursor: Option<bool>,
    pub cursor_x: Option<i32>,
    pub cursor_y: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopCaptureResult {
    pub ok: bool,
    pub engine: String,
    pub tab: String,
    pub mime_type: String,
    pub data_base64: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub frame_id: String,
    pub seq: u64,
    pub ts: u64,
    pub desktop_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<WinDesktopCursor>,
    pub open_windows: Vec<WinDesktopWindow>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopCloseWindowRequest {
    pub hwnd: Option<String>,
    pub title: Option<String>,
    pub close_all: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopCloseWindowResult {
    pub ok: bool,
    pub closed_hwnds: Vec<String>,
    pub open_windows: Vec<WinDesktopWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct PersistedDesktopState {
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub cursor_initialized: bool,
    pub last_action: String,
    pub last_ts: u64,
    pub last_hwnd: Option<String>,
    pub frame_seq: u64,
}

impl Default for PersistedDesktopState {
    fn default() -> Self {
        Self {
            cursor_x: (DEFAULT_DESKTOP_WIDTH / 2) as i32,
            cursor_y: (DEFAULT_DESKTOP_HEIGHT / 2) as i32,
            cursor_initialized: false,
            last_action: "move".to_string(),
            last_ts: 0,
            last_hwnd: None,
            frame_seq: 0,
        }
    }
}

pub(crate) fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn bot_desktop_root_dir() -> PathBuf {
    let base = dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(std::env::temp_dir);
    base.join("qianji").join("bot-desktop")
}

pub fn default_isolated_profile_dir() -> PathBuf {
    bot_desktop_root_dir().join("browser-profile")
}

pub fn default_fenced_roots(
    profile_override: Option<&str>,
    workspace_override: Option<&str>,
) -> (PathBuf, Vec<String>) {
    let root = bot_desktop_root_dir();
    let profile_dir = profile_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("browser-profile"));
    let workspace_dir = workspace_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("workspace"));
    let _ = fs::create_dir_all(&profile_dir);
    let _ = fs::create_dir_all(&workspace_dir);
    let roots = vec![
        workspace_dir.to_string_lossy().into_owned(),
        profile_dir.to_string_lossy().into_owned(),
    ];
    (profile_dir, roots)
}

fn state_file_path() -> PathBuf {
    bot_desktop_root_dir().join("virtual-desktop-state.json")
}

fn state_mutex() -> &'static Mutex<Option<PersistedDesktopState>> {
    static STATE: OnceLock<Mutex<Option<PersistedDesktopState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn load_desktop_state() -> PersistedDesktopState {
    if let Ok(mut guard) = state_mutex().lock() {
        if let Some(disk_raw) = fs::read_to_string(state_file_path()).ok() {
            if let Ok(parsed) = serde_json::from_str::<PersistedDesktopState>(&disk_raw) {
                *guard = Some(parsed.clone());
                return parsed;
            }
        }
        if let Some(mem) = guard.clone() {
            return mem;
        }
    }
    PersistedDesktopState::default()
}

pub(crate) fn update_desktop_state<F>(mutate: F) -> PersistedDesktopState
where
    F: FnOnce(&mut PersistedDesktopState),
{
    let mut state = load_desktop_state();
    mutate(&mut state);
    if let Ok(mut guard) = state_mutex().lock() {
        *guard = Some(state.clone());
    }
    let path = state_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string(&state) {
        let _ = fs::write(path, raw);
    }
    state
}

pub fn is_win_desktop_action(action: &str) -> bool {
    matches!(
        action,
        "win_desktop_status"
            | "win_desktop_enable_child_session"
            | "win_desktop_launch"
            | "win_desktop_capture"
            | "win_desktop_input"
            | "win_desktop_close_window"
    )
}

pub fn dispatch_helper_action(action: &str, payload: Value) -> Result<Value, String> {
    match action {
        "win_desktop_status" => {
            let req: WinDesktopStatusRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_status request: {e}"))?;
            serde_json::to_value(session::query_status(&req))
                .map_err(|e| format!("Could not serialize win_desktop_status: {e}"))
        }
        "win_desktop_enable_child_session" => {
            let req: WinDesktopStatusRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_enable_child_session request: {e}"))?;
            serde_json::to_value(session::enable_child_session(&req))
                .map_err(|e| format!("Could not serialize win_desktop_enable_child_session: {e}"))
        }
        "win_desktop_launch" => {
            let req: launcher::WinDesktopLaunchRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_launch request: {e}"))?;
            let result = launcher::launch_process(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_launch: {e}"))
        }
        "win_desktop_capture" => {
            let req: WinDesktopCaptureRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_capture request: {e}"))?;
            let result = capture_virtual_desktop(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_capture: {e}"))
        }
        "win_desktop_input" => {
            let req: input::WinDesktopInputRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_input request: {e}"))?;
            let result = input::dispatch_input(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_input: {e}"))
        }
        "win_desktop_close_window" => {
            let req: WinDesktopCloseWindowRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_close_window request: {e}"))?;
            let result = input::close_window(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_close_window: {e}"))
        }
        _ => Err(format!("Unsupported win_desktop action: {action}")),
    }
}

#[cfg(windows)]
pub fn capture_virtual_desktop(
    req: WinDesktopCaptureRequest,
) -> Result<WinDesktopCaptureResult, String> {
    compositor::capture_frame(req)
}

#[cfg(not(windows))]
pub fn capture_virtual_desktop(
    _req: WinDesktopCaptureRequest,
) -> Result<WinDesktopCaptureResult, String> {
    Err("Windows virtual desktop capture is only supported on Windows".to_string())
}

#[cfg(not(windows))]
pub fn run_non_windows_helper_fallback() -> i32 {
    use std::io::Read;
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_ok() {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if value.get("action").and_then(Value::as_str) == Some("win_desktop_status") {
                let req: WinDesktopStatusRequest = serde_json::from_value(value).unwrap_or_default();
                if let Ok(out) = serde_json::to_string(&session::query_status(&req)) {
                    println!("{out}");
                    return 0;
                }
            }
        }
    }
    println!(r#"{{"ok":false,"error":"Computer Use currently supports Windows only"}}"#);
    1
}
