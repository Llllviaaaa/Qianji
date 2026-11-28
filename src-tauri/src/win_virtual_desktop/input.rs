//! Non-Hijacking Background Input Dispatch (`win_desktop_input` & `win_desktop_close_window`).
//!
//! Resolves target top-level & child `HWND`s on `WinSta0\QianjiBotDesktop` via
//! `EnumDesktopWindows` + `ChildWindowFromPointEx` / `RealChildWindowFromPoint`
//! and posts `WM_*` messages via `PostMessageW` (never `SetCursorPos` or `SendInput`).

pub use super::input_model::{
    make_lparam_xy, normalize_input_request, parse_virtual_key_combo, MouseButtonKind,
    NormalizedInputOp, WinDesktopInputRequest, WinDesktopInputResult,
};
use super::{WinDesktopCloseWindowRequest, WinDesktopCloseWindowResult};

#[cfg(windows)]
mod imp {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::MapVirtualKeyW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, PostMessageW, RealChildWindowFromPoint, SetWindowPos,
        CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, WM_CHAR, WM_CLOSE, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
        WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
        WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    use super::*;
    use crate::win_virtual_desktop::win32_ffi::{
        enumerate_bot_desktop_windows, format_hwnd, is_hwnd_on_bot_desktop, parse_hwnd,
        RawBotWindow,
    };
    use crate::win_virtual_desktop::{
        load_desktop_state, now_epoch_ms, update_desktop_state, WinDesktopCursor,
        DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH, TASKBAR_HEIGHT,
    };

    const MK_LBUTTON: usize = 0x0001;
    const MK_RBUTTON: usize = 0x0002;
    const MK_MBUTTON: usize = 0x0010;
    const MAPVK_VK_TO_VSC: u32 = 0;

    fn deepest_child_at(top_hwnd: HWND, screen_pt: POINT) -> (HWND, POINT) {
        let mut current = top_hwnd;
        for _ in 0..16 {
            let mut client_pt = screen_pt;
            if unsafe { ScreenToClient(current, &mut client_pt) } == 0 {
                break;
            }
            let next = unsafe {
                let candidate = ChildWindowFromPointEx(
                    current,
                    client_pt,
                    CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
                );
                if candidate.is_null() || candidate == current {
                    null_mut()
                } else {
                    let refined = RealChildWindowFromPoint(current, client_pt);
                    if refined.is_null() {
                        candidate
                    } else {
                        refined
                    }
                }
            };
            if next.is_null() || next == current {
                return (current, client_pt);
            }
            current = next;
        }
        let mut final_pt = screen_pt;
        unsafe {
            let _ = ScreenToClient(current, &mut final_pt);
        }
        (current, final_pt)
    }

    fn raise_bot_window(top_hwnd: HWND) {
        unsafe {
            let _ = SetWindowPos(
                top_hwnd,
                null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    fn resolve_target_at(
        windows: &[RawBotWindow],
        x: i32,
        y: i32,
        explicit_hwnd: Option<&str>,
    ) -> Option<(HWND, HWND, String, POINT)> {
        if let Some(raw_h) = explicit_hwnd.map(str::trim).filter(|s| !s.is_empty()) {
            if let Ok(hwnd) = parse_hwnd(raw_h) {
                if is_hwnd_on_bot_desktop(hwnd) {
                    let title = windows
                        .iter()
                        .find(|w| w.hwnd == hwnd)
                        .map(|w| w.info.title.clone())
                        .unwrap_or_default();
                    let (leaf, client_pt) = deepest_child_at(hwnd, POINT { x, y });
                    return Some((hwnd, leaf, title, client_pt));
                }
            }
        }

        let bar_top = DEFAULT_DESKTOP_HEIGHT as i32 - TASKBAR_HEIGHT;
        if y >= bar_top {
            let max_pills = windows.len().min(6);
            if max_pills > 0 {
                let pill_w = ((DEFAULT_DESKTOP_WIDTH as i32 - 150) / max_pills as i32 - 6)
                    .clamp(90, 210);
                for (idx, win) in windows.iter().take(max_pills).enumerate() {
                    let px0 = 64 + idx as i32 * (pill_w + 6);
                    if x >= px0 && x <= px0 + pill_w {
                        raise_bot_window(win.hwnd);
                        return Some((
                            win.hwnd,
                            win.hwnd,
                            win.info.title.clone(),
                            POINT { x: 8, y: 8 },
                        ));
                    }
                }
            }
            return None;
        }

        let top = windows.iter().find(|w| {
            !w.iconic
                && x >= w.info.x
                && x < w.info.x + w.info.width
                && y >= w.info.y
                && y < w.info.y + w.info.height
        })?;
        let (leaf, client_pt) = deepest_child_at(top.hwnd, POINT { x, y });
        Some((top.hwnd, leaf, top.info.title.clone(), client_pt))
    }

    fn key_lparam(vk: u16, is_up: bool) -> isize {
        let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } & 0xff;
        let base = 1_u32 | (scan << 16);
        let flags = if is_up { base | 0xC000_0000 } else { base };
        flags as isize
    }

    fn wheel_delta_units(raw: i32, invert: bool) -> i16 {
        let signed = if invert { raw.saturating_neg() } else { raw };
        let scaled = if signed != 0 && signed.abs() < 15 {
            signed * 120
        } else {
            signed
        };
        scaled.clamp(-12_000, 12_000) as i16
    }

    pub fn dispatch_input(req: WinDesktopInputRequest) -> Result<WinDesktopInputResult, String> {
        let op = normalize_input_request(&req)?;
        let windows = enumerate_bot_desktop_windows(true)?;
        let prev = load_desktop_state();

        let cx = req
            .x
            .unwrap_or(prev.cursor_x)
            .clamp(0, DEFAULT_DESKTOP_WIDTH as i32 - 1);
        let cy = req
            .y
            .unwrap_or(prev.cursor_y)
            .clamp(0, DEFAULT_DESKTOP_HEIGHT as i32 - 1);

        let fallback_hwnd = if req.x.is_none() && req.y.is_none() && req.hwnd.is_none() {
            prev.last_hwnd.as_deref()
        } else {
            req.hwnd.as_deref()
        };

        let resolved = resolve_target_at(&windows, cx, cy, fallback_hwnd).or_else(|| {
            if matches!(op, NormalizedInputOp::Key { .. } | NormalizedInputOp::Text { .. }) {
                let first = windows.iter().find(|w| !w.iconic)?;
                let mid = POINT {
                    x: first.info.x + first.info.width / 2,
                    y: first.info.y + first.info.height / 2,
                };
                let (leaf, client_pt) = deepest_child_at(first.hwnd, mid);
                Some((first.hwnd, leaf, first.info.title.clone(), client_pt))
            } else {
                None
            }
        });

        let mut dispatched = false;
        let mut target_hwnd_str = None;
        let mut target_title = None;

        if let Some((top_hwnd, leaf_hwnd, title, client_pt)) = resolved {
            let lparam_client = make_lparam_xy(client_pt.x, client_pt.y);
            target_hwnd_str = Some(format_hwnd(leaf_hwnd));
            target_title = Some(title);
            unsafe {
                match &op {
                    NormalizedInputOp::Move => {
                        dispatched = PostMessageW(leaf_hwnd, WM_MOUSEMOVE, 0, lparam_client) != 0;
                    }
                    NormalizedInputOp::ButtonDown(btn) => {
                        raise_bot_window(top_hwnd);
                        let (msg, mk) = match btn {
                            MouseButtonKind::Left => (WM_LBUTTONDOWN, MK_LBUTTON),
                            MouseButtonKind::Right => (WM_RBUTTONDOWN, MK_RBUTTON),
                            MouseButtonKind::Middle => (WM_MBUTTONDOWN, MK_MBUTTON),
                        };
                        let _ = PostMessageW(leaf_hwnd, WM_MOUSEMOVE, 0, lparam_client);
                        dispatched = PostMessageW(leaf_hwnd, msg, mk, lparam_client) != 0;
                    }
                    NormalizedInputOp::ButtonUp(btn) => {
                        let msg = match btn {
                            MouseButtonKind::Left => WM_LBUTTONUP,
                            MouseButtonKind::Right => WM_RBUTTONUP,
                            MouseButtonKind::Middle => WM_MBUTTONUP,
                        };
                        dispatched = PostMessageW(leaf_hwnd, msg, 0, lparam_client) != 0;
                    }
                    NormalizedInputOp::Click(btn) => {
                        raise_bot_window(top_hwnd);
                        let (down, up, mk) = match btn {
                            MouseButtonKind::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
                            MouseButtonKind::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
                            MouseButtonKind::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
                        };
                        let _ = PostMessageW(leaf_hwnd, WM_MOUSEMOVE, 0, lparam_client);
                        let d = PostMessageW(leaf_hwnd, down, mk, lparam_client) != 0;
                        let u = PostMessageW(leaf_hwnd, up, 0, lparam_client) != 0;
                        dispatched = d || u;
                    }
                    NormalizedInputOp::DoubleClick(btn) => {
                        raise_bot_window(top_hwnd);
                        let (down, up, dbl, mk) = match btn {
                            MouseButtonKind::Left => {
                                (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON)
                            }
                            MouseButtonKind::Right => {
                                (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON)
                            }
                            MouseButtonKind::Middle => {
                                (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON)
                            }
                        };
                        let _ = PostMessageW(leaf_hwnd, WM_MOUSEMOVE, 0, lparam_client);
                        let _ = PostMessageW(leaf_hwnd, down, mk, lparam_client);
                        let _ = PostMessageW(leaf_hwnd, up, 0, lparam_client);
                        let d = PostMessageW(leaf_hwnd, dbl, mk, lparam_client) != 0;
                        let u = PostMessageW(leaf_hwnd, up, 0, lparam_client) != 0;
                        dispatched = d || u;
                    }
                    NormalizedInputOp::Wheel { delta_x, delta_y } => {
                        let screen_lp = make_lparam_xy(cx, cy);
                        if *delta_y != 0 {
                            let wd = wheel_delta_units(*delta_y, true);
                            let wp = (wd as u16 as usize) << 16;
                            dispatched |= PostMessageW(leaf_hwnd, WM_MOUSEWHEEL, wp, screen_lp) != 0;
                        }
                        if *delta_x != 0 {
                            let wd = wheel_delta_units(*delta_x, false);
                            let wp = (wd as u16 as usize) << 16;
                            dispatched |=
                                PostMessageW(leaf_hwnd, WM_MOUSEHWHEEL, wp, screen_lp) != 0;
                        }
                    }
                    NormalizedInputOp::Key { key, modifiers } => {
                        let (mods, vk) = parse_virtual_key_combo(key, modifiers)?;
                        for m in &mods {
                            let _ = PostMessageW(
                                leaf_hwnd,
                                WM_KEYDOWN,
                                usize::from(*m),
                                key_lparam(*m, false),
                            );
                        }
                        let d = PostMessageW(
                            leaf_hwnd,
                            WM_KEYDOWN,
                            usize::from(vk),
                            key_lparam(vk, false),
                        ) != 0;
                        let u = PostMessageW(
                            leaf_hwnd,
                            WM_KEYUP,
                            usize::from(vk),
                            key_lparam(vk, true),
                        ) != 0;
                        for m in mods.iter().rev() {
                            let _ = PostMessageW(
                                leaf_hwnd,
                                WM_KEYUP,
                                usize::from(*m),
                                key_lparam(*m, true),
                            );
                        }
                        dispatched = d || u;
                    }
                    NormalizedInputOp::Text { text } => {
                        let normalized = text.replace("\r\n", "\r");
                        for unit in normalized.encode_utf16() {
                            let ch = if unit == 0x0A { 0x0D } else { unit };
                            dispatched |= PostMessageW(leaf_hwnd, WM_CHAR, usize::from(ch), 1) != 0;
                        }
                    }
                }
            }
        }

        let action_label = match &op {
            NormalizedInputOp::Move => "move",
            NormalizedInputOp::Click(_)
            | NormalizedInputOp::ButtonDown(_)
            | NormalizedInputOp::ButtonUp(_) => "click",
            NormalizedInputOp::DoubleClick(_) => "double-click",
            NormalizedInputOp::Wheel { .. } => "scroll",
            NormalizedInputOp::Key { .. } | NormalizedInputOp::Text { .. } => "type",
        };
        let ts = now_epoch_ms();
        let saved = update_desktop_state(|st| {
            st.cursor_x = cx;
            st.cursor_y = cy;
            st.cursor_initialized = true;
            st.last_action = action_label.to_string();
            st.last_ts = ts;
            if target_hwnd_str.is_some() {
                st.last_hwnd.clone_from(&target_hwnd_str);
            }
        });

        Ok(WinDesktopInputResult {
            ok: true,
            dispatched,
            target_hwnd: target_hwnd_str,
            target_title,
            cursor: WinDesktopCursor {
                x: saved.cursor_x,
                y: saved.cursor_y,
                viewport_width: DEFAULT_DESKTOP_WIDTH,
                viewport_height: DEFAULT_DESKTOP_HEIGHT,
                action: saved.last_action,
                ts,
            },
            open_windows: windows.into_iter().map(|w| w.info).collect(),
        })
    }

    pub fn close_window(
        req: WinDesktopCloseWindowRequest,
    ) -> Result<WinDesktopCloseWindowResult, String> {
        let windows = enumerate_bot_desktop_windows(false)?;
        let mut closed = Vec::<String>::new();

        if req.close_all.unwrap_or(false) {
            for w in &windows {
                if is_hwnd_on_bot_desktop(w.hwnd)
                    && unsafe { PostMessageW(w.hwnd, WM_CLOSE, 0, 0) } != 0
                {
                    closed.push(w.info.hwnd.clone());
                }
            }
        } else if let Some(raw_hwnd) = req.hwnd.as_deref().filter(|s| !s.trim().is_empty()) {
            let hwnd = parse_hwnd(raw_hwnd)?;
            if !is_hwnd_on_bot_desktop(hwnd) {
                return Err(format!(
                    "Refusing to close HWND '{raw_hwnd}' because it does not belong to QianjiBotDesktop"
                ));
            }
            if unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } != 0 {
                closed.push(format_hwnd(hwnd));
            }
        } else if let Some(fragment) = req.title.as_deref().map(str::trim).filter(|s| !s.is_empty())
        {
            let needle = fragment.to_lowercase();
            for w in windows
                .iter()
                .filter(|w| w.info.title.to_lowercase().contains(&needle))
            {
                if unsafe { PostMessageW(w.hwnd, WM_CLOSE, 0, 0) } != 0 {
                    closed.push(w.info.hwnd.clone());
                    break;
                }
            }
        } else {
            return Err(
                "win_desktop_close_window requires 'hwnd', 'title', or 'closeAll: true'"
                    .to_string(),
            );
        }

        let remaining = enumerate_bot_desktop_windows(false)?
            .into_iter()
            .map(|w| w.info)
            .collect();
        Ok(WinDesktopCloseWindowResult {
            ok: true,
            closed_hwnds: closed,
            open_windows: remaining,
        })
    }
}

#[cfg(windows)]
pub use imp::{close_window, dispatch_input};

#[cfg(not(windows))]
pub fn dispatch_input(_req: WinDesktopInputRequest) -> Result<WinDesktopInputResult, String> {
    Err("win_desktop_input is only supported on Windows".to_string())
}

#[cfg(not(windows))]
pub fn close_window(
    _req: WinDesktopCloseWindowRequest,
) -> Result<WinDesktopCloseWindowResult, String> {
    Err("win_desktop_close_window is only supported on Windows".to_string())
}
