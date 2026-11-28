//! Loopback HTTP/1.1 JSON client for `qianji-win-desktop.exe` (Viewer Control
//! Server + `--child-agent` running inside the Windows Child Session).

use std::cell::RefCell;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::input_model::{
    normalize_input_request, parse_virtual_key_combo, MouseButtonKind, NormalizedInputOp,
    WinDesktopInputRequest, WinDesktopInputResult,
};
use super::session::{locate_bundled_helper_exe, query_status, WIN_DESKTOP_EXE_NAME};
use super::{
    bot_desktop_root_dir, default_fenced_roots, next_frame_seq, now_epoch_ms,
    WinDesktopCaptureRequest, WinDesktopCaptureResult, WinDesktopCloseWindowRequest,
    WinDesktopCloseWindowResult, WinDesktopCursor, WinDesktopLaunchRequest, WinDesktopLaunchResult,
    WinDesktopOpenViewerRequest, WinDesktopOpenViewerResult, WinDesktopStatusRequest,
    WinDesktopWindow, BOT_DESKTOP_NAME, DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInfo {
    pub port: u16,
    pub key: String,
    #[serde(default)]
    pub pid: u32,
}

pub(crate) struct ViewerProbe {
    pub width: u32,
    pub height: u32,
}

pub(crate) struct AgentProbe {
    pub width: u32,
    pub height: u32,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub open_windows: Vec<WinDesktopWindow>,
}

thread_local! {
    static TEST_AGENT_OVERRIDE: RefCell<Option<EndpointInfo>> = const { RefCell::new(None) };
}

fn get_test_agent_endpoint() -> Option<EndpointInfo> {
    TEST_AGENT_OVERRIDE.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
pub(crate) fn set_test_agent_endpoint(ep: Option<EndpointInfo>) {
    TEST_AGENT_OVERRIDE.with(|cell| {
        *cell.borrow_mut() = ep;
    });
}

fn viewer_endpoint_path() -> PathBuf {
    bot_desktop_root_dir().join("viewer-endpoint.json")
}

fn child_agent_endpoint_path() -> PathBuf {
    bot_desktop_root_dir().join("child-agent-endpoint.json")
}

fn read_endpoint(path: &Path) -> Option<EndpointInfo> {
    let raw = fs::read_to_string(path).ok()?;
    let ep: EndpointInfo = serde_json::from_str(&raw).ok()?;
    (ep.port > 0).then_some(ep)
}

pub fn send_loopback_json(
    ep: &EndpointInfo,
    method: &str,
    route: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, ep.port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("Loopback connect failed on 127.0.0.1:{}: {e}", ep.port))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let body_bytes = match body {
        Some(v) => serde_json::to_vec(v).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    let req_header = format!(
        "{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Qianji-Key: {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        ep.port,
        ep.key,
        body_bytes.len()
    );
    let mut packet = req_header.into_bytes();
    packet.extend_from_slice(&body_bytes);
    stream
        .write_all(&packet)
        .and_then(|()| stream.flush())
        .map_err(|e| format!("Loopback write failed: {e}"))?;

    let mut resp_bytes = Vec::new();
    stream
        .read_to_end(&mut resp_bytes)
        .map_err(|e| format!("Loopback read failed: {e}"))?;
    let resp_str = String::from_utf8_lossy(&resp_bytes);
    let json_slice = resp_str
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or(&resp_str);
    let val: Value = serde_json::from_str(json_slice.trim())
        .map_err(|e| format!("Invalid agent JSON response: {e}"))?;
    if val.get("ok") == Some(&Value::Bool(false)) {
        let msg = val
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Child Session agent request failed");
        return Err(msg.to_string());
    }
    Ok(val)
}

pub(crate) fn probe_viewer_status() -> Option<ViewerProbe> {
    let ep = read_endpoint(&viewer_endpoint_path())?;
    let val = send_loopback_json(&ep, "GET", "/status", None, Duration::from_millis(350)).ok()?;
    let width = val
        .get("sessionWidth")
        .and_then(Value::as_u64)
        .unwrap_or(1280) as u32;
    let height = val
        .get("sessionHeight")
        .and_then(Value::as_u64)
        .unwrap_or(800) as u32;
    Some(ViewerProbe { width, height })
}

pub(crate) fn probe_child_agent_status() -> Option<AgentProbe> {
    let ep = get_test_agent_endpoint().or_else(|| read_endpoint(&child_agent_endpoint_path()))?;
    let val = send_loopback_json(&ep, "GET", "/status", None, Duration::from_millis(350)).ok()?;
    let width = val.get("width").and_then(Value::as_u64).unwrap_or(1280) as u32;
    let height = val.get("height").and_then(Value::as_u64).unwrap_or(800) as u32;
    let cursor_x = val.get("cursorX").and_then(Value::as_i64).unwrap_or(640) as i32;
    let cursor_y = val.get("cursorY").and_then(Value::as_i64).unwrap_or(400) as i32;
    let open_windows = parse_windows_array(val.get("openWindows"));
    Some(AgentProbe {
        width,
        height,
        cursor_x,
        cursor_y,
        open_windows,
    })
}

fn parse_windows_array(raw: Option<&Value>) -> Vec<WinDesktopWindow> {
    raw.and_then(|v| serde_json::from_value::<Vec<WinDesktopWindow>>(v.clone()).ok())
        .unwrap_or_default()
}

pub fn open_viewer(req: WinDesktopOpenViewerRequest) -> Result<WinDesktopOpenViewerResult, String> {
    let action = req
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("open")
        .to_ascii_lowercase();
    let status_req = WinDesktopStatusRequest {
        isolated_profile_dir: req.isolated_profile_dir.clone(),
        workspace_dir: req.workspace_dir.clone(),
        prompt_uac: Some(false),
    };

    if matches!(action.as_str(), "close" | "minimize") {
        if let Some(ep) = read_endpoint(&viewer_endpoint_path()) {
            let _ = send_loopback_json(
                &ep,
                "POST",
                "/action",
                Some(&json!({ "action": action })),
                Duration::from_secs(2),
            );
            thread::sleep(Duration::from_millis(120));
        }
        let status = query_status(&status_req);
        return Ok(WinDesktopOpenViewerResult {
            ok: true,
            viewer_open: status.viewer_open,
            action,
            pid: None,
            message: None,
            status,
        });
    }

    let force_open = req.force_open == Some(true);
    let initial = query_status(&status_req);
    if !initial.pro_supported {
        return Err("Windows 家庭版不支持原生 Child Sessions 独立桌面。".to_string());
    }
    if !initial.child_session_enabled {
        return Err(
            "尚未开启 Windows Child Sessions，请先点击「开启 Windows 独立桌面」。".to_string(),
        );
    }
    if initial.sign_out_required && !force_open {
        return Err("已开启系统 Child Sessions，请先注销并重新登录一次 Windows 以激活免密独立桌面，或点击「免注销尝试连接」使用账号密码验证。".to_string());
    }

    if let Some(ep) = read_endpoint(&viewer_endpoint_path()) {
        let existing_action = if action == "open" {
            if force_open && !initial.child_session_active {
                "connect"
            } else {
                "focus"
            }
        } else {
            &action
        };
        if send_loopback_json(
            &ep,
            "POST",
            "/action",
            Some(&json!({ "action": existing_action })),
            Duration::from_secs(2),
        )
        .is_ok()
        {
            let status = query_status(&status_req);
            let msg = if status.sign_out_required && !status.child_session_active {
                "已唤起独立桌面窗口，请在 Windows 安全提示中输入账号密码完成连接"
            } else {
                "已聚焦千机独立桌面窗口"
            };
            return Ok(WinDesktopOpenViewerResult {
                ok: true,
                viewer_open: true,
                action,
                pid: Some(ep.pid),
                message: Some(msg.to_string()),
                status,
            });
        }
    }

    let viewer_exe = locate_bundled_helper_exe(WIN_DESKTOP_EXE_NAME)
        .ok_or_else(|| format!("Bundled viewer executable '{WIN_DESKTOP_EXE_NAME}' not found"))?;
    let mut cmd = Command::new(&viewer_exe);
    if req.dynamic != Some(false) {
        cmd.arg("--dynamic");
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch {WIN_DESKTOP_EXE_NAME}: {e}"))?;
    let spawned_pid = child.id();

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if probe_viewer_status().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let status = query_status(&status_req);
    let msg = if status.sign_out_required && !status.child_session_active {
        "已打开独立桌面窗口，请在 Windows 安全提示中输入账号密码完成连接"
    } else {
        "已打开千机独立 Windows 子会话桌面窗口"
    };
    Ok(WinDesktopOpenViewerResult {
        ok: true,
        viewer_open: status.viewer_open,
        action,
        pid: Some(spawned_pid),
        message: Some(msg.to_string()),
        status,
    })
}

fn ensure_child_agent() -> Result<EndpointInfo, String> {
    if let Some(ep) = get_test_agent_endpoint() {
        return Ok(ep);
    }
    if let Some(ep) = read_endpoint(&child_agent_endpoint_path()) {
        if send_loopback_json(&ep, "GET", "/status", None, Duration::from_millis(500)).is_ok() {
            return Ok(ep);
        }
    }

    let status = query_status(&WinDesktopStatusRequest {
        prompt_uac: Some(false),
        ..Default::default()
    });
    if !status.pro_supported {
        return Err("Windows Home edition does not support Child Sessions".to_string());
    }
    if !status.child_session_enabled {
        return Err("Windows Child Sessions are disabled; enable Child Sessions first".to_string());
    }
    if status.sign_out_required {
        return Err(
            "Sign out and sign back in to Windows once to activate Child Sessions".to_string(),
        );
    }

    if !status.viewer_open {
        let _ = open_viewer(WinDesktopOpenViewerRequest {
            mode: Some("open".to_string()),
            dynamic: Some(true),
            ..Default::default()
        })?;
    }

    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if let Some(ep) = read_endpoint(&child_agent_endpoint_path()) {
            if send_loopback_json(&ep, "GET", "/status", None, Duration::from_millis(500)).is_ok() {
                return Ok(ep);
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("Timed out waiting for Child Session loopback agent to come online".to_string())
}

pub fn capture_frame(req: WinDesktopCaptureRequest) -> Result<WinDesktopCaptureResult, String> {
    let width = req.width.unwrap_or(DEFAULT_DESKTOP_WIDTH).max(64);
    let height = req.height.unwrap_or(DEFAULT_DESKTOP_HEIGHT).max(64);
    let format = req.format.as_deref().unwrap_or("png");
    let quality = req.quality.unwrap_or(85);
    let draw_cursor = req.draw_cursor.unwrap_or(true);

    let val = match ensure_child_agent() {
        Ok(ep) => send_loopback_json(
            &ep,
            "POST",
            "/capture",
            Some(&json!({
                "width": width,
                "height": height,
                "format": format,
                "quality": quality,
                "drawCursor": draw_cursor,
            })),
            Duration::from_secs(6),
        )?,
        Err(agent_err) => {
            if let Some(vep) = read_endpoint(&viewer_endpoint_path()) {
                send_loopback_json(&vep, "GET", "/preview", None, Duration::from_secs(3))?
            } else {
                return Err(agent_err);
            }
        }
    };

    let b64 = val
        .get("dataBase64")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let out_w = val
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(width)) as u32;
    let out_h = val
        .get("height")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(height)) as u32;
    let mime = val
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/png")
        .to_string();
    let cx = val
        .get("cursorX")
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .or(req.cursor_x)
        .unwrap_or((out_w / 2) as i32);
    let cy = val
        .get("cursorY")
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .or(req.cursor_y)
        .unwrap_or((out_h / 2) as i32);
    let ts = now_epoch_ms();
    let seq = next_frame_seq();
    let open_windows = parse_windows_array(val.get("openWindows"));

    Ok(WinDesktopCaptureResult {
        ok: true,
        engine: "local-win-pip".to_string(),
        tab: "desktop".to_string(),
        mime_type: mime,
        data: b64.clone(),
        data_base64: b64,
        width: out_w,
        height: out_h,
        frame_id: format!("child-{seq}-{ts}"),
        seq,
        ts,
        desktop_name: BOT_DESKTOP_NAME.to_string(),
        title: Some("千机 · Windows 独立子会话桌面".to_string()),
        cursor: Some(WinDesktopCursor {
            x: cx,
            y: cy,
            viewport_width: out_w,
            viewport_height: out_h,
            action: "move".to_string(),
            ts,
        }),
        open_windows,
    })
}

pub fn dispatch_input(req: WinDesktopInputRequest) -> Result<WinDesktopInputResult, String> {
    let op = normalize_input_request(&req)?;
    let ep = ensure_child_agent()?;
    let btn_str = |b: &MouseButtonKind| match b {
        MouseButtonKind::Left => "left",
        MouseButtonKind::Right => "right",
        MouseButtonKind::Middle => "middle",
    };

    let (action_label, payload) = match &op {
        NormalizedInputOp::Move => ("move", json!({ "op": "move", "x": req.x, "y": req.y })),
        NormalizedInputOp::Click(b) => (
            "click",
            json!({ "op": "click", "button": btn_str(b), "x": req.x, "y": req.y }),
        ),
        NormalizedInputOp::DoubleClick(b) => (
            "double-click",
            json!({ "op": "double_click", "button": btn_str(b), "x": req.x, "y": req.y }),
        ),
        NormalizedInputOp::ButtonDown(b) => (
            "click",
            json!({ "op": "down", "button": btn_str(b), "x": req.x, "y": req.y }),
        ),
        NormalizedInputOp::ButtonUp(b) => (
            "click",
            json!({ "op": "up", "button": btn_str(b), "x": req.x, "y": req.y }),
        ),
        NormalizedInputOp::Wheel { delta_x, delta_y } => (
            "scroll",
            json!({ "op": "wheel", "x": req.x, "y": req.y, "deltaX": delta_x, "deltaY": delta_y }),
        ),
        NormalizedInputOp::Key { key, modifiers } => {
            let (mod_vks, vk) = parse_virtual_key_combo(key, modifiers)?;
            (
                "type",
                json!({ "op": "key", "vk": vk, "modifiers": mod_vks }),
            )
        }
        NormalizedInputOp::Text { text } => ("type", json!({ "op": "text", "text": text })),
    };

    let val = send_loopback_json(
        &ep,
        "POST",
        "/input",
        Some(&payload),
        Duration::from_secs(5),
    )?;
    let cx = val
        .get("cursorX")
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .or(req.x)
        .unwrap_or(640);
    let cy = val
        .get("cursorY")
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .or(req.y)
        .unwrap_or(400);
    let open_windows = parse_windows_array(val.get("openWindows"));

    Ok(WinDesktopInputResult {
        ok: true,
        dispatched: true,
        target_hwnd: open_windows.first().map(|w| w.hwnd.clone()),
        target_title: open_windows.first().map(|w| w.title.clone()),
        cursor: WinDesktopCursor {
            x: cx,
            y: cy,
            viewport_width: DEFAULT_DESKTOP_WIDTH,
            viewport_height: DEFAULT_DESKTOP_HEIGHT,
            action: action_label.to_string(),
            ts: now_epoch_ms(),
        },
        open_windows,
    })
}

pub fn is_chromium_executable_name(program: &str) -> bool {
    let lower = Path::new(program.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(program.trim())
        .to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "browser" | "msedge" | "edge" | "chrome" | "chromium" | "brave"
    )
}

pub fn ensure_explorer_separate_args(args: &[String]) -> Vec<String> {
    let has_sep = args
        .iter()
        .any(|a| a.eq_ignore_ascii_case("/separate") || a.starts_with("/separate,"));
    let mut out = Vec::with_capacity(args.len() + 1);
    if !has_sep {
        out.push("/separate".to_string());
    }
    out.extend(args.iter().cloned());
    out
}

pub fn quote_win32_arg(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '"'))
    {
        return arg.to_string();
    }
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0_usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else if ch == '"' {
            quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.extend(std::iter::repeat_n('\\', backslashes));
            quoted.push(ch);
            backslashes = 0;
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

pub fn build_win32_command_line(executable: &Path, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_win32_arg(&executable.to_string_lossy()));
    for arg in args {
        parts.push(quote_win32_arg(arg));
    }
    parts.join(" ")
}

pub fn build_browser_isolation_args(
    isolated_profile_dir: &Path,
    url: Option<&str>,
    extra_args: &[String],
) -> Vec<String> {
    let mut out = vec![
        format!("--user-data-dir={}", isolated_profile_dir.to_string_lossy()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--new-window".to_string(),
    ];
    for arg in extra_args {
        if !arg.starts_with("--user-data-dir=")
            && arg != "--no-first-run"
            && arg != "--no-default-browser-check"
            && arg != "--new-window"
        {
            out.push(arg.clone());
        }
    }
    out.push(
        url.map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("about:blank")
            .to_string(),
    );
    out
}

fn resolve_browser_path(hint: Option<&str>) -> String {
    if let Some(h) = hint
        .map(str::trim)
        .filter(|s| !s.is_empty() && Path::new(s).is_file())
    {
        return h.to_string();
    }
    for env_key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(env_key).map(PathBuf::from) {
            for rel in [
                "Microsoft\\Edge\\Application\\msedge.exe",
                "Google\\Chrome\\Application\\chrome.exe",
            ] {
                let cand = root.join(rel);
                if cand.is_file() {
                    return cand.to_string_lossy().into_owned();
                }
            }
        }
    }
    "msedge.exe".to_string()
}

pub fn launch_process(req: WinDesktopLaunchRequest) -> Result<WinDesktopLaunchResult, String> {
    let is_browser = req
        .kind
        .as_deref()
        .map(|k| k.eq_ignore_ascii_case("browser"))
        .unwrap_or_else(|| {
            req.app
                .as_deref()
                .map(is_chromium_executable_name)
                .unwrap_or(req.url.is_some())
        });

    let (profile_dir, _) =
        default_fenced_roots(req.isolated_profile_dir.as_deref(), req.cwd.as_deref());

    let (kind_str, exe_str, final_args, used_profile) = if is_browser {
        let exe = resolve_browser_path(req.app.as_deref());
        let args = build_browser_isolation_args(&profile_dir, req.url.as_deref(), &req.args);
        (
            "browser".to_string(),
            exe,
            args,
            Some(profile_dir.to_string_lossy().into_owned()),
        )
    } else {
        let app = req
            .app
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "win_desktop_launch requires 'app' or 'kind: \"browser\"'".to_string()
            })?;
        let args =
            if app.eq_ignore_ascii_case("explorer") || app.eq_ignore_ascii_case("explorer.exe") {
                ensure_explorer_separate_args(&req.args)
            } else {
                req.args.clone()
            };
        ("app".to_string(), app.to_string(), args, None)
    };

    let joined_args = final_args
        .iter()
        .map(|a| quote_win32_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    let command_line = build_win32_command_line(Path::new(&exe_str), &final_args);
    let ep = ensure_child_agent()?;
    let val = send_loopback_json(
        &ep,
        "POST",
        "/launch",
        Some(&json!({
            "executable": exe_str,
            "arguments": joined_args,
            "cwd": req.cwd,
        })),
        Duration::from_secs(6),
    )?;
    let pid = val.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
    let open_windows = parse_windows_array(val.get("openWindows"));

    Ok(WinDesktopLaunchResult {
        ok: true,
        pid,
        kind: kind_str,
        executable: exe_str,
        command_line,
        desktop_name: BOT_DESKTOP_NAME.to_string(),
        isolated_profile_dir: used_profile,
        open_windows,
    })
}

pub fn close_window(
    req: WinDesktopCloseWindowRequest,
) -> Result<WinDesktopCloseWindowResult, String> {
    let ep_opt = get_test_agent_endpoint().or_else(|| read_endpoint(&child_agent_endpoint_path()));
    let Some(ep) = ep_opt else {
        return Ok(WinDesktopCloseWindowResult {
            ok: true,
            closed_hwnds: Vec::new(),
            open_windows: Vec::new(),
        });
    };
    let val = send_loopback_json(
        &ep,
        "POST",
        "/close-window",
        Some(&json!({
            "hwnd": req.hwnd,
            "title": req.title,
            "closeAll": req.close_all.unwrap_or(false),
        })),
        Duration::from_secs(4),
    )?;
    let closed_hwnds = val
        .get("closedHwnds")
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default();
    let open_windows = parse_windows_array(val.get("openWindows"));
    Ok(WinDesktopCloseWindowResult {
        ok: true,
        closed_hwnds,
        open_windows,
    })
}
