//! Non-hijacking Offscreen Compositor (`win_desktop_capture`) for `QianjiBotDesktop`.
//!
//! Renders a `1280x800` virtual desktop frame in memory (dark gradient wallpaper,
//! `PrintWindow(PW_RENDERFULLCONTENT)` + `BitBlt` fallback per visible window,
//! bottom taskbar strip with window title pills, and optional virtual cursor),
//! then encodes to PNG base64 with zero physical screen flicker or cursor movement.

use std::ptr::null_mut;

use chrono::Local;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateFontW, DeleteObject, GdiFlush, GetWindowDC, ReleaseDC, SelectObject, SRCCOPY,
};

use super::dib::DibSurface;
use super::win32_ffi::{
    enumerate_bot_desktop_windows, to_wide_null, PrintWindow, RawBotWindow, PW_RENDERFULLCONTENT,
};
use super::{
    now_epoch_ms, update_desktop_state, WinDesktopCaptureRequest, WinDesktopCaptureResult,
    WinDesktopCursor, BOT_DESKTOP_NAME, DEFAULT_DESKTOP_HEIGHT, DEFAULT_DESKTOP_WIDTH,
    TASKBAR_HEIGHT,
};

fn render_wallpaper(surface: &mut DibSurface) {
    let w = surface.width;
    let h = surface.height;
    let buf = surface.pixels_mut();
    for y in 0..h {
        let vy = (y * 255 / h.max(1)) as u16;
        for x in 0..w {
            let vx = (x * 255 / w.max(1)) as u16;
            let r = (13 + (vy * 10 + vx * 6) / 255) as u8;
            let g = (19 + (vy * 14 + vx * 8) / 255) as u8;
            let b = (33 + (vy * 22 + vx * 12) / 255) as u8;
            let is_grid = (x % 40 == 0) && (y % 40 == 0);
            let idx = (y as usize * w as usize + x as usize) * 4;
            buf[idx] = b.saturating_add(if is_grid { 12 } else { 0 });
            buf[idx + 1] = g.saturating_add(if is_grid { 9 } else { 0 });
            buf[idx + 2] = r.saturating_add(if is_grid { 7 } else { 0 });
            buf[idx + 3] = 255;
        }
    }
}

fn has_visible_pixels(bgra: &[u8]) -> bool {
    bgra.chunks_exact(64)
        .any(|chunk| chunk[0] != 0 || chunk[1] != 0 || chunk[2] != 0)
}

fn capture_single_window(hwnd: HWND, width: u32, height: u32) -> Option<DibSurface> {
    let w = width.clamp(1, 2560);
    let h = height.clamp(1, 1600);
    let surface = DibSurface::new(w, h).ok()?;

    let mut ok = unsafe { PrintWindow(hwnd, surface.dc, PW_RENDERFULLCONTENT) != 0 };
    unsafe {
        GdiFlush();
    }
    if !ok || !has_visible_pixels(surface.pixels()) {
        ok = unsafe { PrintWindow(hwnd, surface.dc, 0) != 0 };
        unsafe {
            GdiFlush();
        }
    }
    if !ok || !has_visible_pixels(surface.pixels()) {
        let win_dc = unsafe { GetWindowDC(hwnd) };
        if !win_dc.is_null() {
            let copied =
                unsafe { BitBlt(surface.dc, 0, 0, w as i32, h as i32, win_dc, 0, 0, SRCCOPY) };
            unsafe {
                GdiFlush();
                ReleaseDC(hwnd, win_dc);
            }
            ok = copied != 0;
        }
    }
    ok.then_some(surface)
}

fn blit_window_onto_canvas(canvas: &mut DibSurface, win_surf: &DibSurface, dst_x: i32, dst_y: i32) {
    let work_h = (canvas.height as i32 - TASKBAR_HEIGHT).max(1) as u32;
    let cw = canvas.width as i32;
    let ww = win_surf.width as i32;
    let wh = win_surf.height as i32;

    canvas.fill_rect_clamped(
        work_h,
        dst_x + 4,
        dst_y + 6,
        dst_x + ww + 6,
        dst_y + wh + 8,
        (4, 7, 14, 110),
    );

    {
        let src = win_surf.pixels();
        let canvas_w = canvas.width as usize;
        let dst = canvas.pixels_mut();
        for sy in 0..wh {
            let cy = dst_y + sy;
            if cy < 0 || cy >= work_h as i32 {
                continue;
            }
            for sx in 0..ww {
                let cx = dst_x + sx;
                if cx < 0 || cx >= cw {
                    continue;
                }
                let s_idx = (sy as usize * win_surf.width as usize + sx as usize) * 4;
                let d_idx = (cy as usize * canvas_w + cx as usize) * 4;
                dst[d_idx] = src[s_idx];
                dst[d_idx + 1] = src[s_idx + 1];
                dst[d_idx + 2] = src[s_idx + 2];
                dst[d_idx + 3] = 255;
            }
        }
    }

    let x1 = dst_x + ww;
    let y1 = (dst_y + wh).min(work_h as i32);
    let border = (90, 112, 150, 140);
    canvas.fill_rect_clamped(work_h, dst_x, dst_y, x1, dst_y + 1, border);
    canvas.fill_rect_clamped(work_h, dst_x, y1 - 1, x1, y1, border);
    canvas.fill_rect_clamped(work_h, dst_x, dst_y, dst_x + 1, y1, border);
    canvas.fill_rect_clamped(work_h, x1 - 1, dst_y, x1, y1, border);
}

fn render_taskbar_and_empty_badge(canvas: &mut DibSurface, windows: &[RawBotWindow]) {
    let w = canvas.width as i32;
    let h = canvas.height as i32;
    let bar_top = h - TASKBAR_HEIGHT;

    canvas.fill_rect(0, bar_top, w, h, (10, 14, 24, 242));
    canvas.fill_rect(0, bar_top, w, bar_top + 1, (56, 74, 108, 255));
    canvas.fill_rect(10, bar_top + 6, 54, h - 6, (37, 99, 235, 255));

    let face = to_wide_null("Segoe UI");
    let font =
        unsafe { CreateFontW(-13, 0, 0, 0, 500, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr()) };
    let old_font = if !font.is_null() {
        unsafe { SelectObject(canvas.dc, font) }
    } else {
        null_mut()
    };

    if windows.is_empty() {
        canvas.fill_rect(
            w / 2 - 210,
            bar_top / 2 - 22,
            w / 2 + 210,
            bar_top / 2 + 22,
            (18, 25, 42, 210),
        );
        canvas.draw_label(
            "Qianji Virtual Desktop (WinSta0\\QianjiBotDesktop) · Ready",
            RECT {
                left: w / 2 - 194,
                top: bar_top / 2 - 18,
                right: w / 2 + 194,
                bottom: bar_top / 2 + 18,
            },
            (168, 185, 216),
        );
    }

    canvas.draw_label(
        "QJ",
        RECT {
            left: 22,
            top: bar_top + 6,
            right: 52,
            bottom: h - 6,
        },
        (255, 255, 255),
    );

    let max_pills = windows.len().min(6);
    let avail_w = (w - 150).max(160);
    let pill_w = if max_pills > 0 {
        (avail_w / max_pills as i32 - 6).clamp(90, 210)
    } else {
        160
    };
    for (idx, win) in windows.iter().take(max_pills).enumerate() {
        let px0 = 64 + idx as i32 * (pill_w + 6);
        let px1 = px0 + pill_w;
        let bg = if idx == 0 {
            (38, 52, 82, 255)
        } else {
            (22, 30, 48, 255)
        };
        canvas.fill_rect(px0, bar_top + 6, px1, h - 6, bg);
        if idx == 0 {
            canvas.fill_rect(px0 + 8, h - 8, px1 - 8, h - 6, (96, 165, 250, 255));
        }
        canvas.draw_label(
            &win.info.title,
            RECT {
                left: px0 + 10,
                top: bar_top + 6,
                right: px1 - 8,
                bottom: h - 8,
            },
            (228, 236, 248),
        );
    }

    let clock = Local::now().format("%H:%M").to_string();
    canvas.draw_label(
        &clock,
        RECT {
            left: w - 62,
            top: bar_top + 6,
            right: w - 10,
            bottom: h - 6,
        },
        (178, 192, 216),
    );

    unsafe {
        GdiFlush();
        if !font.is_null() {
            SelectObject(canvas.dc, old_font);
            DeleteObject(font);
        }
    }
}

fn draw_virtual_cursor(canvas: &mut DibSurface, cx: i32, cy: i32) {
    let w = canvas.width as i32;
    let h = canvas.height as i32;
    for dy in -9_i32..=9 {
        for dx in -9_i32..=9 {
            let d2 = dx * dx + dy * dy;
            if (49..=81).contains(&d2) {
                canvas.fill_rect(cx + dx, cy + dy, cx + dx + 1, cy + dy + 1, (59, 130, 246, 150));
            }
        }
    }
    for row in 0..15_i32 {
        let span = if row < 11 { row + 1 } else { (15 - row) + 2 };
        for col in 0..=span {
            let px = cx + col;
            let py = cy + row;
            if px < 0 || px >= w || py < 0 || py >= h {
                continue;
            }
            let border = col == 0 || col == span || row == 14;
            let color = if border {
                (15, 23, 42, 255)
            } else {
                (255, 255, 255, 255)
            };
            canvas.fill_rect(px, py, px + 1, py + 1, color);
        }
    }
}

pub fn capture_frame(req: WinDesktopCaptureRequest) -> Result<WinDesktopCaptureResult, String> {
    let width = req.width.unwrap_or(DEFAULT_DESKTOP_WIDTH).clamp(320, 2560);
    let height = req.height.unwrap_or(DEFAULT_DESKTOP_HEIGHT).clamp(240, 1600);

    let raw_windows = enumerate_bot_desktop_windows(true)?;
    let mut canvas = DibSurface::new(width, height)?;
    render_wallpaper(&mut canvas);

    for win in raw_windows.iter().rev() {
        if win.iconic || win.info.width <= 0 || win.info.height <= 0 {
            continue;
        }
        if let Some(win_surf) =
            capture_single_window(win.hwnd, win.info.width as u32, win.info.height as u32)
        {
            blit_window_onto_canvas(&mut canvas, &win_surf, win.info.x, win.info.y);
        }
    }

    render_taskbar_and_empty_badge(&mut canvas, &raw_windows);

    let ts = now_epoch_ms();
    let state = update_desktop_state(|st| {
        st.frame_seq = st.frame_seq.saturating_add(1);
        if let (Some(cx), Some(cy)) = (req.cursor_x, req.cursor_y) {
            st.cursor_x = cx.clamp(0, width as i32 - 1);
            st.cursor_y = cy.clamp(0, height as i32 - 1);
            st.cursor_initialized = true;
            st.last_ts = ts;
        }
    });

    let draw_cursor = req.draw_cursor.unwrap_or(true);
    let cursor = if draw_cursor && (state.cursor_initialized || req.cursor_x.is_some()) {
        draw_virtual_cursor(&mut canvas, state.cursor_x, state.cursor_y);
        Some(WinDesktopCursor {
            x: state.cursor_x,
            y: state.cursor_y,
            viewport_width: width,
            viewport_height: height,
            action: state.last_action,
            ts: if state.last_ts > 0 { state.last_ts } else { ts },
        })
    } else {
        None
    };

    let (b64, frame_id) = canvas.encode_png_base64()?;
    let open_windows: Vec<_> = raw_windows.into_iter().map(|w| w.info).collect();
    let top_title = open_windows.first().map(|w| w.title.clone());

    Ok(WinDesktopCaptureResult {
        ok: true,
        engine: "local-win-pip".to_string(),
        tab: "desktop".to_string(),
        mime_type: "image/png".to_string(),
        data_base64: b64.clone(),
        data: b64,
        width,
        height,
        frame_id,
        seq: state.frame_seq,
        ts,
        desktop_name: BOT_DESKTOP_NAME.to_string(),
        title: top_title,
        cursor,
        open_windows,
    })
}
