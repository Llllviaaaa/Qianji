//! Input request/response contracts, UCP & direct event normalization, and virtual-key parsing.

use serde::{Deserialize, Serialize};

use super::{WinDesktopCursor, WinDesktopWindow};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopInputRequest {
    #[serde(alias = "subAction", alias = "op", alias = "event", alias = "type")]
    pub input_action: Option<String>,
    pub kind: Option<String>,
    pub mouse_action: Option<String>,
    pub button: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub delta_x: Option<i32>,
    pub delta_y: Option<i32>,
    pub key: Option<String>,
    pub text: Option<String>,
    pub modifiers: Vec<String>,
    pub hwnd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinDesktopInputResult {
    pub ok: bool,
    pub dispatched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_hwnd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    pub cursor: WinDesktopCursor,
    pub open_windows: Vec<WinDesktopWindow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MouseButtonKind {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedInputOp {
    Move,
    Click(MouseButtonKind),
    DoubleClick(MouseButtonKind),
    ButtonDown(MouseButtonKind),
    ButtonUp(MouseButtonKind),
    Wheel { delta_x: i32, delta_y: i32 },
    Key { key: String, modifiers: Vec<String> },
    Text { text: String },
}

fn parse_button(raw: Option<&str>) -> Result<MouseButtonKind, String> {
    match raw.unwrap_or("left").trim().to_ascii_lowercase().as_str() {
        "" | "left" | "primary" => Ok(MouseButtonKind::Left),
        "right" | "secondary" => Ok(MouseButtonKind::Right),
        "middle" | "auxiliary" => Ok(MouseButtonKind::Middle),
        other => Err(format!("Unsupported mouse button: '{other}'")),
    }
}

pub fn normalize_input_request(req: &WinDesktopInputRequest) -> Result<NormalizedInputOp, String> {
    if let Some(direct) = req
        .input_action
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return match direct.to_ascii_lowercase().as_str() {
            "move" => Ok(NormalizedInputOp::Move),
            "click" => Ok(NormalizedInputOp::Click(parse_button(req.button.as_deref())?)),
            "double_click" | "double-click" | "dblclick" => {
                Ok(NormalizedInputOp::DoubleClick(parse_button(req.button.as_deref())?))
            }
            "right_click" | "right-click" => Ok(NormalizedInputOp::Click(MouseButtonKind::Right)),
            "middle_click" | "middle-click" => {
                Ok(NormalizedInputOp::Click(MouseButtonKind::Middle))
            }
            "down" | "mousedown" => {
                Ok(NormalizedInputOp::ButtonDown(parse_button(req.button.as_deref())?))
            }
            "up" | "mouseup" => {
                Ok(NormalizedInputOp::ButtonUp(parse_button(req.button.as_deref())?))
            }
            "wheel" | "scroll" => Ok(NormalizedInputOp::Wheel {
                delta_x: req.delta_x.unwrap_or(0),
                delta_y: req.delta_y.unwrap_or(0),
            }),
            "key" | "keypress" => Ok(NormalizedInputOp::Key {
                key: req
                    .key
                    .clone()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "key input requires 'key'".to_string())?,
                modifiers: req.modifiers.clone(),
            }),
            "text" | "type" | "paste" => Ok(NormalizedInputOp::Text {
                text: req
                    .text
                    .clone()
                    .ok_or_else(|| "text input requires 'text'".to_string())?,
            }),
            other => Err(format!("Unsupported win_desktop_input action: '{other}'")),
        };
    }

    let kind = req
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "win_desktop_input requires 'inputAction' or 'kind'".to_string())?;

    match kind.to_ascii_lowercase().as_str() {
        "mouse" => {
            let btn = parse_button(req.button.as_deref())?;
            match req
                .mouse_action
                .as_deref()
                .unwrap_or("click")
                .trim()
                .to_ascii_lowercase()
                .as_str()
            {
                "move" => Ok(NormalizedInputOp::Move),
                "down" => Ok(NormalizedInputOp::ButtonDown(btn)),
                "up" => Ok(NormalizedInputOp::ButtonUp(btn)),
                "click" => Ok(NormalizedInputOp::Click(btn)),
                "double-click" | "double_click" => Ok(NormalizedInputOp::DoubleClick(btn)),
                other => Err(format!("Unsupported mouseAction: '{other}'")),
            }
        }
        "move" => Ok(NormalizedInputOp::Move),
        "click" => Ok(NormalizedInputOp::Click(parse_button(req.button.as_deref())?)),
        "double_click" | "double-click" | "dblclick" => {
            Ok(NormalizedInputOp::DoubleClick(parse_button(req.button.as_deref())?))
        }
        "right_click" | "right-click" => Ok(NormalizedInputOp::Click(MouseButtonKind::Right)),
        "middle_click" | "middle-click" => Ok(NormalizedInputOp::Click(MouseButtonKind::Middle)),
        "down" | "mousedown" => Ok(NormalizedInputOp::ButtonDown(parse_button(req.button.as_deref())?)),
        "up" | "mouseup" => Ok(NormalizedInputOp::ButtonUp(parse_button(req.button.as_deref())?)),
        "wheel" | "scroll" => Ok(NormalizedInputOp::Wheel {
            delta_x: req.delta_x.unwrap_or(0),
            delta_y: req.delta_y.unwrap_or(0),
        }),
        "key" => Ok(NormalizedInputOp::Key {
            key: req
                .key
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "key input requires 'key'".to_string())?,
            modifiers: req.modifiers.clone(),
        }),
        "text" | "paste" => Ok(NormalizedInputOp::Text {
            text: req
                .text
                .clone()
                .ok_or_else(|| "text input requires 'text'".to_string())?,
        }),
        other => Err(format!("Unsupported win_desktop_input kind: '{other}'")),
    }
}

pub fn make_lparam_xy(x: i32, y: i32) -> isize {
    let lx = (x as i16 as u16) as u32;
    let ly = (y as i16 as u16) as u32;
    ((ly << 16) | lx) as isize
}

pub fn parse_virtual_key_combo(
    key_spec: &str,
    extra_modifiers: &[String],
) -> Result<(Vec<u16>, u16), String> {
    let mut mod_vks = Vec::<u16>::new();
    let mut push_mod = |m: &str| -> Result<(), String> {
        let vk = match m.trim().to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => 0x11,
            "SHIFT" => 0x10,
            "ALT" => 0x12,
            "META" | "WIN" | "SUPER" | "COMMAND" => 0x5B,
            other => return Err(format!("Unsupported modifier: '{other}'")),
        };
        if !mod_vks.contains(&vk) {
            mod_vks.push(vk);
        }
        Ok(())
    };
    for m in extra_modifiers {
        push_mod(m)?;
    }
    let key_part = if key_spec == "+" {
        "+"
    } else if key_spec.contains('+') && key_spec.len() > 1 {
        let tokens: Vec<&str> = key_spec.split('+').filter(|t| !t.is_empty()).collect();
        let (last, prefixes) = tokens
            .split_last()
            .ok_or_else(|| "Empty key combo".to_string())?;
        for p in prefixes {
            push_mod(p)?;
        }
        *last
    } else {
        key_spec
    };

    let upper = if key_part == " " {
        "SPACE".to_string()
    } else {
        key_part.trim().to_ascii_uppercase()
    };
    let named = match upper.as_str() {
        "ENTER" | "RETURN" => Some(0x0D),
        "TAB" => Some(0x09),
        "ESC" | "ESCAPE" => Some(0x1B),
        "SPACE" | "SPACEBAR" => Some(0x20),
        "BACKSPACE" => Some(0x08),
        "DELETE" | "DEL" => Some(0x2E),
        "INSERT" | "INS" => Some(0x2D),
        "UP" | "ARROWUP" => Some(0x26),
        "DOWN" | "ARROWDOWN" => Some(0x28),
        "LEFT" | "ARROWLEFT" => Some(0x25),
        "RIGHT" | "ARROWRIGHT" => Some(0x27),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" => Some(0x21),
        "PAGEDOWN" => Some(0x22),
        "F1" => Some(0x70),
        "F2" => Some(0x71),
        "F3" => Some(0x72),
        "F4" => Some(0x73),
        "F5" => Some(0x74),
        "F6" => Some(0x75),
        "F7" => Some(0x76),
        "F8" => Some(0x77),
        "F9" => Some(0x78),
        "F10" => Some(0x79),
        "F11" => Some(0x7A),
        "F12" => Some(0x7B),
        _ => None,
    };
    if let Some(vk) = named {
        return Ok((mod_vks, vk));
    }
    let mut chars = upper.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        if ch.is_ascii_alphanumeric() {
            return Ok((mod_vks, ch as u16));
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::VkKeyScanW;
            let mapped = unsafe { VkKeyScanW(ch as u16) };
            if mapped != -1 {
                return Ok((mod_vks, (mapped as u16) & 0xff));
            }
        }
    }
    Err(format!("Unsupported virtual key: '{key_spec}'"))
}
