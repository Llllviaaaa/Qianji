//! Offscreen 32-bpp top-down GDI `DIBSection` surface, drawing primitives, and PNG encoder.

use core::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;

use base64::Engine;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, DrawTextW, SelectObject,
    SetBkMode, SetTextColor, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, TRANSPARENT,
};

pub struct DibSurface {
    pub dc: *mut c_void,
    bitmap: *mut c_void,
    old_obj: *mut c_void,
    bits: *mut u8,
    pub width: u32,
    pub height: u32,
}

impl DibSurface {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("Invalid offscreen DIB dimensions".to_string());
        }
        let dc = unsafe { CreateCompatibleDC(null_mut()) };
        if dc.is_null() {
            return Err("CreateCompatibleDC failed for offscreen compositor".to_string());
        }
        let mut bmi: BITMAPINFO = unsafe { zeroed() };
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        };
        let mut bits_ptr: *mut c_void = null_mut();
        let bitmap =
            unsafe { CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits_ptr, null_mut(), 0) };
        if bitmap.is_null() || bits_ptr.is_null() {
            unsafe {
                DeleteDC(dc);
            }
            return Err("CreateDIBSection failed for offscreen compositor".to_string());
        }
        let old_obj = unsafe { SelectObject(dc, bitmap) };
        Ok(Self {
            dc,
            bitmap,
            old_obj,
            bits: bits_ptr.cast::<u8>(),
            width,
            height,
        })
    }

    pub fn pixels_mut(&mut self) -> &mut [u8] {
        let len = self.width as usize * self.height as usize * 4;
        unsafe { std::slice::from_raw_parts_mut(self.bits, len) }
    }

    pub fn pixels(&self) -> &[u8] {
        let len = self.width as usize * self.height as usize * 4;
        unsafe { std::slice::from_raw_parts(self.bits, len) }
    }

    pub fn fill_rect_clamped(
        &mut self,
        max_h: u32,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
        rgba: (u8, u8, u8, u8),
    ) {
        let cw = self.width;
        let ch = max_h.min(self.height);
        let sx = x0.clamp(0, cw as i32) as usize;
        let ex = x1.clamp(0, cw as i32) as usize;
        let sy = y0.clamp(0, ch as i32) as usize;
        let ey = y1.clamp(0, ch as i32) as usize;
        if sx >= ex || sy >= ey {
            return;
        }
        let (r, g, b, a) = rgba;
        let alpha = u16::from(a);
        let inv = 255 - alpha;
        let buf = self.pixels_mut();
        for y in sy..ey {
            let row = y * cw as usize * 4;
            for x in sx..ex {
                let idx = row + x * 4;
                if a == 255 {
                    buf[idx] = b;
                    buf[idx + 1] = g;
                    buf[idx + 2] = r;
                    buf[idx + 3] = 255;
                } else {
                    buf[idx] = ((u16::from(b) * alpha + u16::from(buf[idx]) * inv) / 255) as u8;
                    buf[idx + 1] =
                        ((u16::from(g) * alpha + u16::from(buf[idx + 1]) * inv) / 255) as u8;
                    buf[idx + 2] =
                        ((u16::from(r) * alpha + u16::from(buf[idx + 2]) * inv) / 255) as u8;
                    buf[idx + 3] = 255;
                }
            }
        }
    }

    pub fn fill_rect(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, rgba: (u8, u8, u8, u8)) {
        let ch = self.height;
        self.fill_rect_clamped(ch, x0, y0, x1, y1, rgba);
    }

    pub fn draw_label(&self, text: &str, mut rect: RECT, color_rgb: (u8, u8, u8)) {
        let wide: Vec<u16> = text.encode_utf16().collect();
        if wide.is_empty() {
            return;
        }
        let color_ref = u32::from(color_rgb.0)
            | (u32::from(color_rgb.1) << 8)
            | (u32::from(color_rgb.2) << 16);
        unsafe {
            SetBkMode(self.dc, TRANSPARENT as i32);
            SetTextColor(self.dc, color_ref);
            DrawTextW(
                self.dc,
                wide.as_ptr(),
                wide.len() as i32,
                &mut rect,
                DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
            );
        }
    }

    pub fn encode_png_base64(&self) -> Result<(String, String), String> {
        let w = self.width;
        let h = self.height;
        let bgra = self.pixels();
        let mut rgb = vec![0_u8; w as usize * h as usize * 3];
        let mut hash = 0xcbf29ce484222325_u64;
        for (px_idx, src) in bgra.chunks_exact(4).enumerate() {
            let dst = px_idx * 3;
            rgb[dst] = src[2];
            rgb[dst + 1] = src[1];
            rgb[dst + 2] = src[0];
            hash ^= u64::from(rgb[dst]);
            hash = hash.wrapping_mul(0x100000001b3);
            hash ^= u64::from(rgb[dst + 1]);
            hash = hash.wrapping_mul(0x100000001b3);
            hash ^= u64::from(rgb[dst + 2]);
            hash = hash.wrapping_mul(0x100000001b3);
        }

        let mut png_bytes = Vec::with_capacity(64 * 1024);
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, w, h);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("PNG header encoding failed: {e}"))?;
            writer
                .write_image_data(&rgb)
                .map_err(|e| format!("PNG image encoding failed: {e}"))?;
        }
        Ok((
            base64::engine::general_purpose::STANDARD.encode(png_bytes),
            format!("{hash:016x}"),
        ))
    }
}

impl Drop for DibSurface {
    fn drop(&mut self) {
        unsafe {
            if !self.dc.is_null() {
                if !self.old_obj.is_null() {
                    SelectObject(self.dc, self.old_obj);
                }
                if !self.bitmap.is_null() {
                    DeleteObject(self.bitmap);
                }
                DeleteDC(self.dc);
            }
        }
    }
}
