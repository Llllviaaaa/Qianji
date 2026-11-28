//! Windows Child Session Virtual Desktop bridge (`local-win-pip`).
//!
//! Connects to `qianji-win-desktop.exe` (`MsRdpClient` `ConnectToChildSession`
//! viewer + `--child-agent` loopback HTTP/JSON server running inside the Child
//! Session) and `qianji-enable-child-sessions.exe` (`WTSEnableChildSessions`).

pub mod agent_client;
pub mod input_model;
pub mod session;

#[cfg(test)]
mod tests;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BOT_DESKTOP_NAME: &str = "QianjiChildSession";
pub const BOT_DESKTOP_STATION_PATH: &str = "localhost\\ChildSession";
pub const DEFAULT_DESKTOP_WIDTH: u32 = 1280;
pub const DEFAULT_DESKTOP_HEIGHT: u32 = 800;

static FRAME_SEQ: AtomicU64 = AtomicU64::new(0);

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
    pub child_session_active: bool,
    pub sign_out_required: bool,
    pub viewer_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<u32>,
    pub desktop_name: String,
    pub desktop_station_path: String,
    pub desktop_ready: bool,
    pub resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolated_profile_dir: Option<String>,
    pub fenced_roots: Vec<String>,
    pub open_windows: Vec<WinDesktopWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<WinDesktopCursor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elevation_hint: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopStatusRequest {
    pub isolated_profile_dir: Option<String>,
    pub workspace_dir: Option<String>,
    pub prompt_uac: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopEnableChildSessionResult {
    pub enabled: bool,
    pub requires_elevation: bool,
    pub sign_out_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elevation_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<u32>,
    #[serde(flatten)]
    pub status: WinDesktopStatus,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopOpenViewerRequest {
    pub mode: Option<String>,
    pub dynamic: Option<bool>,
    pub force_open: Option<bool>,
    pub isolated_profile_dir: Option<String>,
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopOpenViewerResult {
    pub ok: bool,
    pub viewer_open: bool,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(flatten)]
    pub status: WinDesktopStatus,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopCaptureRequest {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
    pub quality: Option<u8>,
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
pub struct WinDesktopLaunchRequest {
    pub kind: Option<String>,
    #[serde(
        alias = "executable",
        alias = "command",
        alias = "program",
        alias = "target"
    )]
    pub app: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub cwd: Option<String>,
    pub isolated_profile_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopLaunchResult {
    pub ok: bool,
    pub pid: u32,
    pub kind: String,
    pub executable: String,
    pub command_line: String,
    pub desktop_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolated_profile_dir: Option<String>,
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

pub(crate) fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn next_frame_seq() -> u64 {
    FRAME_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

pub(crate) fn bot_desktop_root_dir() -> PathBuf {
    let base = dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(std::env::temp_dir);
    base.join("qianji").join("bot-desktop")
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

pub fn is_win_desktop_action(action: &str) -> bool {
    matches!(
        action,
        "win_desktop_status"
            | "win_desktop_enable_child_session"
            | "win_desktop_open_viewer"
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
        "win_desktop_open_viewer" => {
            let req: WinDesktopOpenViewerRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_open_viewer request: {e}"))?;
            let result = agent_client::open_viewer(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_open_viewer: {e}"))
        }
        "win_desktop_launch" => {
            let req: WinDesktopLaunchRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_launch request: {e}"))?;
            let result = agent_client::launch_process(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_launch: {e}"))
        }
        "win_desktop_capture" => {
            let req: WinDesktopCaptureRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_capture request: {e}"))?;
            let result = agent_client::capture_frame(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_capture: {e}"))
        }
        "win_desktop_input" => {
            let req: input_model::WinDesktopInputRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_input request: {e}"))?;
            let result = agent_client::dispatch_input(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_input: {e}"))
        }
        "win_desktop_close_window" => {
            let req: WinDesktopCloseWindowRequest = serde_json::from_value(payload)
                .map_err(|e| format!("Invalid win_desktop_close_window request: {e}"))?;
            let result = agent_client::close_window(req)?;
            serde_json::to_value(result)
                .map_err(|e| format!("Could not serialize win_desktop_close_window: {e}"))
        }
        _ => Err(format!("Unsupported win_desktop action: {action}")),
    }
}

#[cfg(not(windows))]
pub fn run_non_windows_helper_fallback() -> i32 {
    use std::io::Read;
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_ok() {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if value.get("action").and_then(Value::as_str) == Some("win_desktop_status") {
                let req: WinDesktopStatusRequest =
                    serde_json::from_value(value).unwrap_or_default();
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
