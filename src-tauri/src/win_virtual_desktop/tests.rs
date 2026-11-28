//! Unit and integration tests for `win_virtual_desktop`.

use std::path::Path;

use base64::Engine;
use serde_json::json;

use super::input::{
    make_lparam_xy, normalize_input_request, parse_virtual_key_combo, MouseButtonKind,
    NormalizedInputOp, WinDesktopInputRequest,
};
use super::launcher::{
    build_browser_isolation_args, build_win32_command_line, ensure_explorer_separate_args,
    is_chromium_executable_name, quote_win32_arg,
};
use super::session::{
    classify_edition_pro_support, enable_child_session, query_status, VER_NT_WORKSTATION,
    VER_SUITE_PERSONAL,
};
use super::{
    dispatch_helper_action, is_win_desktop_action, WinDesktopStatusRequest, BOT_DESKTOP_NAME,
    DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH,
};

#[test]
fn classifies_windows_editions_for_pro_child_session_support() {
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
    assert!(!classify_edition_pro_support(
        Some("CoreSingleLanguage"),
        0,
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
    assert!(classify_edition_pro_support(
        Some("Education"),
        0x0100,
        VER_NT_WORKSTATION
    ));
    // Windows Server product_type == 3
    assert!(classify_edition_pro_support(Some("ServerStandard"), 0, 3));
}

#[test]
fn builds_isolated_chromium_profile_flags_without_profile_collision() {
    let profile = Path::new(r"C:\Users\demo\AppData\Local\qianji\bot-desktop\browser-profile");
    let extra = vec![
        "--lang=zh-CN".to_string(),
        "--user-data-dir=C:\\should-be-ignored".to_string(),
    ];
    let args = build_browser_isolation_args(profile, Some("https://example.com/path?a=1"), &extra);

    assert!(args
        .iter()
        .any(|a| a == r"--user-data-dir=C:\Users\demo\AppData\Local\qianji\bot-desktop\browser-profile"));
    assert_eq!(
        args.iter()
            .filter(|a| a.starts_with("--user-data-dir="))
            .count(),
        1,
        "must inject exactly one isolated --user-data-dir"
    );
    assert!(args.contains(&"--no-first-run".to_string()));
    assert!(args.contains(&"--no-default-browser-check".to_string()));
    assert!(args.contains(&"--new-window".to_string()));
    assert!(args.contains(&"--lang=zh-CN".to_string()));
    assert_eq!(
        args.last().map(String::as_str),
        Some("https://example.com/path?a=1")
    );

    let cmd = build_win32_command_line(
        Path::new(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        &args,
    );
    assert!(cmd.starts_with(r#""C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe""#));
    assert_eq!(quote_win32_arg(r#"C:\dir with space\"#), r#""C:\dir with space\\""#);
    assert!(is_chromium_executable_name("msedge.exe"));
    assert!(is_chromium_executable_name("chrome"));
    assert!(!is_chromium_executable_name("notepad.exe"));

    let exp_args = ensure_explorer_separate_args(&[r"C:\Work".to_string()]);
    assert_eq!(exp_args, vec!["/separate".to_string(), r"C:\Work".to_string()]);
}

#[test]
fn normalizes_both_direct_and_ucp_input_payloads() {
    let direct_right: WinDesktopInputRequest = serde_json::from_value(json!({
        "inputAction": "right_click",
        "x": 320,
        "y": 240
    }))
    .unwrap();
    assert_eq!(
        normalize_input_request(&direct_right).unwrap(),
        NormalizedInputOp::Click(MouseButtonKind::Right)
    );

    let ucp_dbl: WinDesktopInputRequest = serde_json::from_value(json!({
        "kind": "mouse",
        "mouseAction": "double-click",
        "button": "left",
        "x": 100,
        "y": 150
    }))
    .unwrap();
    assert_eq!(
        normalize_input_request(&ucp_dbl).unwrap(),
        NormalizedInputOp::DoubleClick(MouseButtonKind::Left)
    );

    let (mods, vk) = parse_virtual_key_combo("Ctrl+Shift+A", &[]).unwrap();
    assert_eq!(mods, vec![0x11, 0x10]);
    assert_eq!(vk, b'A' as u16);

    let (mods2, vk2) = parse_virtual_key_combo("ArrowDown", &["alt".to_string()]).unwrap();
    assert_eq!(mods2, vec![0x12]);
    assert_eq!(vk2, 0x28);

    // Negative client coordinates preserve signed 16-bit packing
    let packed = make_lparam_xy(-5, 200);
    assert_eq!((packed as u32 & 0xffff) as u16 as i16, -5);
    assert_eq!(((packed as u32 >> 16) & 0xffff) as u16 as i16, 200);
}

#[test]
fn status_and_child_session_probe_return_structured_contract() {
    assert!(is_win_desktop_action("win_desktop_status"));
    assert!(is_win_desktop_action("win_desktop_capture"));
    assert!(!is_win_desktop_action("screenshot"));

    let status = query_status(&WinDesktopStatusRequest::default());
    assert!(status.ok);
    assert_eq!(status.account_mode, "current-user");
    assert_eq!(status.desktop_name, BOT_DESKTOP_NAME);
    assert!(!status.fenced_roots.is_empty());

    #[cfg(windows)]
    {
        assert!(status.desktop_ready);
        assert!(matches!(
            status.backend.as_str(),
            "win32-secondary-desktop" | "rdp-child-session"
        ));
    }

    let enable_res = enable_child_session(&WinDesktopStatusRequest::default());
    assert!(enable_res.status.ok);
    if !enable_res.status.elevated && enable_res.status.pro_supported && !enable_res.enabled {
        assert!(enable_res.requires_elevation);
        assert!(enable_res.elevation_hint.is_some());
    }
}

#[cfg(windows)]
#[test]
fn creates_offscreen_bot_desktop_captures_1280x800_png_and_never_moves_cursor() {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut before_cursor = POINT { x: 0, y: 0 };
    let cursor_readable = unsafe { GetCursorPos(&mut before_cursor) != 0 };

    // 1. Dispatch background move & click onto QianjiBotDesktop
    let input_val = dispatch_helper_action(
        "win_desktop_input",
        json!({
            "action": "win_desktop_input",
            "inputAction": "move",
            "x": 412,
            "y": 288
        }),
    )
    .expect("background move should succeed");
    assert_eq!(input_val["ok"], true);
    assert_eq!(input_val["cursor"]["x"], 412);
    assert_eq!(input_val["cursor"]["y"], 288);

    // 2. Capture 1280x800 offscreen frame WITH cursor vs WITHOUT cursor
    let frame_with_cursor = dispatch_helper_action(
        "win_desktop_capture",
        json!({
            "action": "win_desktop_capture",
            "drawCursor": true
        }),
    )
    .expect("offscreen capture should succeed");

    assert_eq!(frame_with_cursor["ok"], true);
    assert_eq!(frame_with_cursor["mimeType"], "image/png");
    assert_eq!(frame_with_cursor["width"], DEFAULT_DESKTOP_WIDTH);
    assert_eq!(frame_with_cursor["height"], DEFAULT_DESKTOP_HEIGHT);
    assert_eq!(frame_with_cursor["desktopName"], BOT_DESKTOP_NAME);

    let b64 = frame_with_cursor["dataBase64"]
        .as_str()
        .expect("dataBase64 string");
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64 PNG");
    // Verify PNG magic signature + IHDR width/height = 1280x800
    assert!(png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let ihdr_w = u32::from_be_bytes([png_bytes[16], png_bytes[17], png_bytes[18], png_bytes[19]]);
    let ihdr_h = u32::from_be_bytes([png_bytes[20], png_bytes[21], png_bytes[22], png_bytes[23]]);
    assert_eq!(ihdr_w, DEFAULT_DESKTOP_WIDTH);
    assert_eq!(ihdr_h, DEFAULT_DESKTOP_HEIGHT);

    let frame_no_cursor = dispatch_helper_action(
        "win_desktop_capture",
        json!({
            "action": "win_desktop_capture",
            "drawCursor": false
        }),
    )
    .expect("offscreen capture without cursor should succeed");
    assert_ne!(
        frame_with_cursor["frameId"], frame_no_cursor["frameId"],
        "virtual cursor marker should visibly render into the offscreen frame"
    );

    if cursor_readable {
        let mut after_cursor = POINT { x: 0, y: 0 };
        let ok = unsafe { GetCursorPos(&mut after_cursor) != 0 };
        if ok {
            assert_eq!(
                (before_cursor.x, before_cursor.y),
                (after_cursor.x, after_cursor.y),
                "physical user mouse cursor must NEVER be moved by win_virtual_desktop"
            );
        }
    }
}
