//! Isolated Process & Browser Launcher (`win_desktop_launch`) targeting
//! `winsta0\QianjiBotDesktop` via `CreateProcessW` (`STARTUPINFOW.lpDesktop`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    default_fenced_roots, WinDesktopWindow, BOT_DESKTOP_NAME, DEFAULT_DESKTOP_HEIGHT,
    DEFAULT_DESKTOP_WIDTH, TASKBAR_HEIGHT,
};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WinDesktopLaunchRequest {
    pub kind: Option<String>,
    #[serde(alias = "executable", alias = "command", alias = "program", alias = "target")]
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

pub fn is_explorer_executable_name(program: &str) -> bool {
    let lower = Path::new(program.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(program.trim())
        .to_ascii_lowercase();
    lower == "explorer"
}

/// Builds Chromium/Edge/Chrome launch flags with an isolated `--user-data-dir`
/// so single-instance browser profile locks under the current Windows account
/// never collide with the user's primary desktop browser.
pub fn build_browser_isolation_args(
    isolated_profile_dir: &Path,
    url: Option<&str>,
    extra_args: &[String],
) -> Vec<String> {
    let max_h = DEFAULT_DESKTOP_HEIGHT.saturating_sub(TASKBAR_HEIGHT as u32 + 28);
    let max_w = DEFAULT_DESKTOP_WIDTH.saturating_sub(32);
    let mut out = vec![
        format!("--user-data-dir={}", isolated_profile_dir.to_string_lossy()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-gpu".to_string(),
        "--window-position=16,14".to_string(),
        format!("--window-size={max_w},{max_h}"),
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
    let target_url = url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("about:blank");
    out.push(target_url.to_string());
    out
}

pub fn ensure_explorer_separate_args(args: &[String]) -> Vec<String> {
    let has_separate = args
        .iter()
        .any(|a| a.eq_ignore_ascii_case("/separate") || a.starts_with("/separate,"));
    let mut out = Vec::with_capacity(args.len() + 1);
    if !has_separate {
        out.push("/separate".to_string());
    }
    out.extend(args.iter().cloned());
    out
}

/// Quotes a single Windows command-line argument following `CommandLineToArgvW` rules.
pub fn quote_win32_arg(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| c == ' ' || c == '\t' || c == '\n' || c == '\x0b' || c == '"')
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

#[cfg(windows)]
mod imp {
    use std::fs;
    use std::mem::{size_of, zeroed};
    use std::ptr::null;
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTF_USEPOSITION, STARTF_USESIZE,
        STARTF_USESHOWWINDOW, STARTUPINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::*;
    use crate::win_virtual_desktop::win32_ffi::{
        ensure_bot_desktop, enumerate_bot_desktop_windows, read_registry_string, to_wide_null,
        GetLastError, WaitForInputIdle, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    };
    use crate::win_virtual_desktop::BOT_DESKTOP_STATION_PATH;

    fn locate_app_paths_exe(exe_name: &str) -> Option<PathBuf> {
        let with_ext = if Path::new(exe_name).extension().is_some() {
            exe_name.to_string()
        } else {
            format!("{exe_name}.exe")
        };
        let subkey = format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{with_ext}");
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Some(raw) = read_registry_string(hive, &subkey, None) {
                let cleaned = raw.trim().trim_matches('"');
                let candidate = PathBuf::from(cleaned);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    pub fn locate_browser_executable(hint: Option<&str>) -> Result<PathBuf, String> {
        if let Some(h) = hint.map(str::trim).filter(|s| !s.is_empty()) {
            let direct = PathBuf::from(h);
            if direct.is_file() {
                return Ok(direct);
            }
        }
        let prefer_chrome = hint
            .map(|h| h.to_ascii_lowercase().contains("chrome"))
            .unwrap_or(false);

        let mut candidates = Vec::<PathBuf>::new();
        let edge_rel = Path::new("Microsoft\\Edge\\Application\\msedge.exe");
        let chrome_rel = Path::new("Google\\Chrome\\Application\\chrome.exe");
        let roots = [
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        ];

        let order: [&Path; 2] = if prefer_chrome {
            [chrome_rel, edge_rel]
        } else {
            [edge_rel, chrome_rel]
        };
        for rel in order {
            for root in roots.iter().flatten() {
                candidates.push(root.join(rel));
            }
        }
        for candidate in candidates {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        for name in if prefer_chrome {
            ["chrome.exe", "msedge.exe"]
        } else {
            ["msedge.exe", "chrome.exe"]
        } {
            if let Some(found) = locate_app_paths_exe(name)
                .or_else(|| crate::platform::resolve_windows_executable(name))
            {
                return Ok(found);
            }
        }
        Err("Could not locate Microsoft Edge (msedge.exe) or Google Chrome (chrome.exe)".to_string())
    }

    pub fn locate_general_executable(program: &str) -> Result<PathBuf, String> {
        let trimmed = program.trim().trim_matches('"');
        if trimmed.is_empty() {
            return Err("win_desktop_launch requires 'app' (executable name or path)".to_string());
        }
        let direct = PathBuf::from(trimmed);
        if direct.is_file() {
            return Ok(direct);
        }
        let with_exe = if direct.extension().is_some() {
            trimmed.to_string()
        } else {
            format!("{trimmed}.exe")
        };
        if let Some(sys_root) = std::env::var_os("SystemRoot").map(PathBuf::from) {
            for dir in [sys_root.join("System32"), sys_root] {
                let candidate = dir.join(&with_exe);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        if let Some(found) = locate_app_paths_exe(&with_exe)
            .or_else(|| crate::platform::resolve_windows_executable(trimmed))
        {
            return Ok(found);
        }
        Err(format!("Could not locate Windows executable: '{trimmed}'"))
    }

    pub fn launch_process(req: WinDesktopLaunchRequest) -> Result<WinDesktopLaunchResult, String> {
        let inferred_browser = req
            .kind
            .as_deref()
            .map(|k| k.eq_ignore_ascii_case("browser"))
            .unwrap_or_else(|| {
                req.app
                    .as_deref()
                    .map(is_chromium_executable_name)
                    .unwrap_or(req.url.is_some())
            });

        let (profile_dir, _) = default_fenced_roots(
            req.isolated_profile_dir.as_deref(),
            req.cwd.as_deref(),
        );

        let (kind_str, exe_path, final_args, used_profile_dir) = if inferred_browser {
            let _ = fs::create_dir_all(&profile_dir);
            let exe = locate_browser_executable(req.app.as_deref())?;
            let args = build_browser_isolation_args(&profile_dir, req.url.as_deref(), &req.args);
            (
                "browser".to_string(),
                exe,
                args,
                Some(profile_dir.to_string_lossy().into_owned()),
            )
        } else {
            let raw_app = req
                .app
                .as_deref()
                .ok_or_else(|| "win_desktop_launch requires 'app' or 'kind: \"browser\"'".to_string())?;
            let exe = locate_general_executable(raw_app)?;
            let args = if is_explorer_executable_name(raw_app)
                || exe
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("explorer"))
                    .unwrap_or(false)
            {
                ensure_explorer_separate_args(&req.args)
            } else {
                req.args.clone()
            };
            ("app".to_string(), exe, args, None)
        };

        // Keep HDESK alive across CreateProcessW + child user32 desktop attach.
        let _desktop = ensure_bot_desktop()?;
        let cmd_line = build_win32_command_line(&exe_path, &final_args);
        let mut cmd_wide = to_wide_null(&cmd_line);
        let exe_wide = to_wide_null(&exe_path.to_string_lossy());
        let mut desktop_wide = to_wide_null(BOT_DESKTOP_STATION_PATH);

        let cwd_wide = req
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && Path::new(s).is_dir())
            .map(to_wide_null);

        let mut startup: STARTUPINFOW = unsafe { zeroed() };
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        startup.lpDesktop = desktop_wide.as_mut_ptr();
        startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USEPOSITION | STARTF_USESIZE;
        startup.wShowWindow = SW_SHOWNORMAL as u16;
        startup.dwX = 32;
        startup.dwY = 24;
        startup.dwXSize = DEFAULT_DESKTOP_WIDTH.saturating_sub(64);
        startup.dwYSize = DEFAULT_DESKTOP_HEIGHT.saturating_sub(TASKBAR_HEIGHT as u32 + 40);

        let mut proc_info: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                exe_wide.as_ptr(),
                cmd_wide.as_mut_ptr(),
                null(),
                null(),
                0,
                0,
                null(),
                cwd_wide.as_ref().map_or(null(), |v| v.as_ptr()),
                &startup,
                &mut proc_info,
            )
        };
        if created == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!(
                "CreateProcessW onto '{BOT_DESKTOP_STATION_PATH}' failed for '{}' (Win32 error {err})",
                exe_path.display()
            ));
        }

        let pid = proc_info.dwProcessId;
        unsafe {
            let _ = WaitForInputIdle(proc_info.hProcess, 1_200);
            CloseHandle(proc_info.hThread);
            CloseHandle(proc_info.hProcess);
        }

        // Poll briefly so newly created top-level windows appear in openWindows immediately.
        let deadline = Instant::now() + Duration::from_millis(650);
        let mut open_windows = Vec::new();
        while Instant::now() < deadline {
            let current = enumerate_bot_desktop_windows(true).unwrap_or_default();
            let has_new = current.iter().any(|w| w.info.pid == pid);
            open_windows = current.into_iter().map(|w| w.info).collect();
            if has_new {
                break;
            }
            thread::sleep(Duration::from_millis(60));
        }

        Ok(WinDesktopLaunchResult {
            ok: true,
            pid,
            kind: kind_str,
            executable: exe_path.to_string_lossy().into_owned(),
            command_line: cmd_line,
            desktop_name: BOT_DESKTOP_NAME.to_string(),
            isolated_profile_dir: used_profile_dir,
            open_windows,
        })
    }
}

#[cfg(windows)]
pub use imp::launch_process;

#[cfg(not(windows))]
pub fn launch_process(_req: WinDesktopLaunchRequest) -> Result<WinDesktopLaunchResult, String> {
    Err("win_desktop_launch is only supported on Windows".to_string())
}
