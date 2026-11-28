//! Unit and loopback integration tests for `win_virtual_desktop` Child Session bridge.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::thread;

use serde_json::{json, Value};

use super::agent_client::{
    build_browser_isolation_args, build_win32_command_line, ensure_explorer_separate_args,
    is_chromium_executable_name, quote_win32_arg, set_test_agent_endpoint, EndpointInfo,
};
use super::input_model::{
    make_lparam_xy, normalize_input_request, parse_virtual_key_combo, MouseButtonKind,
    NormalizedInputOp, WinDesktopInputRequest,
};
use super::session::{
    classify_edition_pro_support, compute_sign_out_required, enable_child_session,
    locate_bundled_helper_exe, query_status, ENABLE_CHILD_SESSIONS_EXE_NAME, VER_NT_WORKSTATION,
    VER_SUITE_PERSONAL, WIN_DESKTOP_EXE_NAME,
};
use super::{
    dispatch_helper_action, is_win_desktop_action, WinDesktopStatusRequest, BOT_DESKTOP_NAME,
};

#[test]
fn classifies_windows_editions_and_sign_out_requirement() {
    assert!(!classify_edition_pro_support(
        Some("Core"),
        VER_SUITE_PERSONAL,
        VER_NT_WORKSTATION
    ));
    assert!(!classify_edition_pro_support(
        Some("CoreCountrySpecific"),
        VER_SUITE_PERSONAL,
        VER_NT_WORKSTATION
    ));
    assert!(classify_edition_pro_support(
        Some("Professional"),
        0x0100,
        VER_NT_WORKSTATION
    ));
    assert!(classify_edition_pro_support(
        Some("Enterprise"),
        0x0100,
        VER_NT_WORKSTATION
    ));
    assert!(classify_edition_pro_support(Some("ServerStandard"), 0, 3));

    assert!(!compute_sign_out_required(false, false, Some("0000:1234"), Some("0000:1234")));
    assert!(!compute_sign_out_required(true, true, Some("0000:1234"), Some("0000:1234")));
    assert!(compute_sign_out_required(true, false, Some("0000:1234"), Some("0000:1234")));
    assert!(!compute_sign_out_required(true, false, Some("0000:5678"), Some("0000:1234")));
}

#[test]
fn builds_isolated_chromium_profile_flags_without_collision() {
    let profile = Path::new(r"C:\Users\demo\AppData\Local\qianji\bot-desktop\browser-profile");
    let extra = vec![
        "--lang=zh-CN".to_string(),
        "--user-data-dir=C:\\should-be-ignored".to_string(),
    ];
    let args = build_browser_isolation_args(profile, Some("https://example.com/path?a=1"), &extra);

    assert_eq!(
        args.iter().filter(|a| a.starts_with("--user-data-dir=")).count(),
        1
    );
    assert!(args.contains(&"--no-first-run".to_string()));
    assert!(args.contains(&"--new-window".to_string()));
    assert_eq!(args.last().map(String::as_str), Some("https://example.com/path?a=1"));

    let cmd = build_win32_command_line(
        Path::new(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        &args,
    );
    assert!(cmd.starts_with(r#""C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe""#));
    assert_eq!(quote_win32_arg(r#"C:\dir with space\"#), r#""C:\dir with space\\""#);
    assert!(is_chromium_executable_name("msedge.exe"));
    assert!(!is_chromium_executable_name("notepad.exe"));
    assert_eq!(
        ensure_explorer_separate_args(&[r"C:\Work".to_string()]),
        vec!["/separate".to_string(), r"C:\Work".to_string()]
    );
}

#[test]
fn normalizes_both_direct_and_ucp_input_payloads() {
    let direct_right: WinDesktopInputRequest = serde_json::from_value(json!({
        "inputAction": "right_click",
        "x": 320,
        "y": 240
    }))
    .expect("deserialize direct_right");
    assert_eq!(
        normalize_input_request(&direct_right).expect("normalize direct_right"),
        NormalizedInputOp::Click(MouseButtonKind::Right)
    );

    let ucp_dbl: WinDesktopInputRequest = serde_json::from_value(json!({
        "kind": "mouse",
        "mouseAction": "double-click",
        "button": "left",
        "x": 100,
        "y": 150
    }))
    .expect("deserialize ucp_dbl");
    assert_eq!(
        normalize_input_request(&ucp_dbl).expect("normalize ucp_dbl"),
        NormalizedInputOp::DoubleClick(MouseButtonKind::Left)
    );

    let (mods, vk) = parse_virtual_key_combo("Ctrl+Shift+A", &[]).expect("combo");
    assert_eq!(mods, vec![0x11, 0x10]);
    assert_eq!(vk, b'A' as u16);

    let packed = make_lparam_xy(-5, 200);
    assert_eq!((packed as u32 & 0xffff) as u16 as i16, -5);
    assert_eq!(((packed as u32 >> 16) & 0xffff) as u16 as i16, 200);
}

#[test]
fn status_and_bundled_child_session_binaries_probe_cleanly() {
    assert!(is_win_desktop_action("win_desktop_status"));
    assert!(is_win_desktop_action("win_desktop_enable_child_session"));
    assert!(is_win_desktop_action("win_desktop_open_viewer"));
    assert!(is_win_desktop_action("win_desktop_capture"));
    assert!(!is_win_desktop_action("screenshot"));

    let req = WinDesktopStatusRequest {
        prompt_uac: Some(false),
        ..Default::default()
    };
    let status = query_status(&req);
    assert!(status.ok);
    assert_eq!(status.account_mode, "current-user");
    assert_eq!(status.desktop_name, BOT_DESKTOP_NAME);
    assert!(!status.fenced_roots.is_empty());

    let enable_res = enable_child_session(&req);
    assert!(enable_res.status.ok);

    #[cfg(windows)]
    {
        if locate_bundled_helper_exe(WIN_DESKTOP_EXE_NAME).is_some() {
            assert!(locate_bundled_helper_exe(ENABLE_CHILD_SESSIONS_EXE_NAME).is_some());
        }
    }
}

#[test]
fn proxies_capture_input_launch_and_close_over_loopback_without_moving_host_cursor() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock child agent");
    let port = listener.local_addr().expect("local addr").port();
    let test_key = "placeholder-agent-key";

    let server_handle = thread::spawn(move || {
        for _ in 0..4 {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut raw = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let n = stream.read(&mut chunk).expect("read");
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
                if let Some(hdr_end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let hdr_str = String::from_utf8_lossy(&raw[..hdr_end]);
                    let content_len = hdr_str
                        .lines()
                        .find_map(|line| {
                            let (k, v) = line.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if raw.len() >= hdr_end + 4 + content_len {
                        break;
                    }
                }
            }
            let req_text = String::from_utf8_lossy(&raw);
            assert!(req_text.contains("X-Qianji-Key: placeholder-agent-key"));
            let first_line = req_text.lines().next().unwrap_or_default();
            let body_json = if first_line.contains(" /capture ") {
                json!({
                    "ok": true,
                    "mimeType": "image/png",
                    "dataBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    "width": 1280,
                    "height": 800,
                    "cursorX": 512,
                    "cursorY": 333,
                    "openWindows": [{
                        "hwnd": "0x2001",
                        "title": "Child Session Explorer",
                        "app": "explorer.exe",
                        "pid": 4242,
                        "x": 20,
                        "y": 20,
                        "width": 900,
                        "height": 600
                    }]
                })
            } else if first_line.contains(" /input ") {
                json!({
                    "ok": true,
                    "dispatched": true,
                    "cursorX": 412,
                    "cursorY": 288,
                    "openWindows": []
                })
            } else if first_line.contains(" /launch ") {
                json!({
                    "ok": true,
                    "pid": 7788,
                    "openWindows": [{
                        "hwnd": "0x3002",
                        "title": "Notepad",
                        "app": "notepad.exe",
                        "pid": 7788,
                        "x": 40,
                        "y": 40,
                        "width": 800,
                        "height": 500
                    }]
                })
            } else {
                json!({
                    "ok": true,
                    "closedHwnds": ["0x3002"],
                    "openWindows": []
                })
            };
            let payload = serde_json::to_vec(&body_json).expect("serialize");
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            stream.write_all(header.as_bytes()).expect("write header");
            stream.write_all(&payload).expect("write body");
        }
    });

    set_test_agent_endpoint(Some(EndpointInfo {
        port,
        key: test_key.to_string(),
        pid: 9999,
    }));

    #[cfg(windows)]
    let before_cursor = {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        let ok = unsafe { GetCursorPos(&mut pt) != 0 };
        (ok, pt.x, pt.y)
    };

    let cap: Value = dispatch_helper_action(
        "win_desktop_capture",
        json!({ "action": "win_desktop_capture", "width": 1280, "height": 800 }),
    )
    .expect("capture");
    assert_eq!(cap["ok"], true);
    assert_eq!(cap["width"], 1280);
    assert_eq!(cap["openWindows"][0]["hwnd"], "0x2001");

    let inp: Value = dispatch_helper_action(
        "win_desktop_input",
        json!({ "action": "win_desktop_input", "inputAction": "click", "x": 412, "y": 288 }),
    )
    .expect("input");
    assert_eq!(inp["ok"], true);
    assert_eq!(inp["cursor"]["x"], 412);

    let launched: Value = dispatch_helper_action(
        "win_desktop_launch",
        json!({ "action": "win_desktop_launch", "kind": "app", "app": "notepad.exe" }),
    )
    .expect("launch");
    assert_eq!(launched["pid"], 7788);

    let closed: Value = dispatch_helper_action(
        "win_desktop_close_window",
        json!({ "action": "win_desktop_close_window", "hwnd": "0x3002" }),
    )
    .expect("close");
    assert_eq!(closed["closedHwnds"][0], "0x3002");

    set_test_agent_endpoint(None);
    server_handle.join().expect("mock server thread");

    #[cfg(windows)]
    if before_cursor.0 {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) != 0 } {
            assert_eq!((before_cursor.1, before_cursor.2), (pt.x, pt.y));
        }
    }
}
