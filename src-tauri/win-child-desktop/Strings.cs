// Adapted from Ray-Desktop (https://github.com/raydoomed/Ray-Desktop, MIT License, Copyright (c) 2026 raydoomed)
using System;
using System.Collections.Generic;
using System.Globalization;

namespace QianjiWinDesktop
{
    internal static class Strings
    {
        private static bool _en;

        public static void SetLanguage(string lang)
        {
            if (string.Equals(lang, "zh", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(lang, "zh-cn", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(lang, "zh-hans", StringComparison.OrdinalIgnoreCase))
                _en = false;
            else if (string.Equals(lang, "en", StringComparison.OrdinalIgnoreCase))
                _en = true;
            else
                _en = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName != "zh";
        }

        private static readonly Dictionary<string, string> zh = new Dictionary<string, string>
        {
            { "app_title", "千机独立桌面" },
            { "err_title", "千机独立桌面错误" },
            { "startup_fail_title", "千机独立桌面启动失败" },
            { "menu_fixed", "固定分辨率" },
            { "menu_dynamic", "动态分辨率" },
            { "menu_about", "关于千机独立桌面" },
            { "menu_open_log", "打开日志文件夹" },
            { "about_body", "千机（Qianji）独立子会话桌面：在当前 Windows 登录账号下开启原生 Win11 独立会话桌面，绝不抢占主桌面鼠标键盘。\n\n• 共享本地磁盘（读写），支持剪贴板互通\n• 基于 Ray-Desktop 架构（MIT License, Copyright © 2026 raydoomed）" },
            { "res_your_screen", "{0} × {1}（你的屏幕，推荐）" },
            { "res_confirm_title", "调整分辨率" },
            { "res_confirm_body", "立即将独立桌面调整为 {0} × {1} 吗？\n\n• 独立桌面里已打开的程序会保留，不会关闭" },
            { "close_confirm_title", "关闭独立桌面窗口" },
            { "close_confirm_body", "独立桌面仍已连接，关闭窗口将注销子会话中未保存的程序。确定关闭吗？" },
            { "res_not_connected", "尚未连接，无法修改分辨率。" },
            { "res_fail", "修改分辨率失败：" },
            { "status_connected", "已连接" },
            { "status_connecting", "正在连接本机子会话…" },
            { "status_connecting_win", "正在连接本机 Windows 独立子会话…" },
            { "status_waiting", "等待 Windows 建立子会话…" },
            { "status_not_connected", "尚未连接" },
            { "status_timeout", "连接超时。请确认已启用 Child Sessions，并在首次启用后注销并重新登录一次 Windows。" },
            { "status_disabled_missing_helper", "此电脑未启用 Windows 子会话；缺少管理员启用程序 qianji-enable-child-sessions.exe。" },
            { "status_requesting", "正在请求管理员启用子会话。启用后请注销并重新登录一次 Windows；若出现凭据提示请取消，不要输入空密码。" },
            { "status_elevation_canceled", "已取消管理员授权；Child Sessions 尚未启用。" },
            { "status_launch_helper_fail", "无法启动管理员启用程序：" },
            { "status_disconnected_local", "本地已断开独立子会话连接。" },
            { "menu_reconnect", "重新连接" },
            { "status_reconnect_failed", "自动重连多次失败，可在「更多」菜单点击「重新连接」重试。" },
            { "status_disconnected", "子会话已断开，状态码 0x{0:X8}" },
            { "status_disconnected_acct", "（需重新登录激活）。若刚启用 Child Sessions，请保存工作后注销并重新登录一次 Windows。" },
            { "status_fatal", "RDP 致命错误 0x{0:X8}" },
            { "status_logon_error", "子会话登录错误 0x{0:X8}" },
            { "status_continuing", "Windows 正在继续建立独立子会话…" },
            { "status_state", "RDP 控件状态：" },
            { "status_read_fail", "读取连接状态失败：" },
            { "msg_connect_fail", "连接失败：" },
            { "msg_check_fail", "无法检查 Windows 子会话状态，系统错误码 {0}。请确认此 Windows 版本支持远程桌面子会话。" },
            { "btn_fullscreen", "全屏" }, { "btn_display", "显示" }, { "btn_resolution", "分辨率" },
            { "btn_exit", "结束" }, { "btn_more", "更多" }, { "btn_collapse", "收起" }, { "btn_drag", "拖动" },
            { "tip_display_dynamic", "显示 · 动态" }, { "tip_display_fixed", "显示 · 固定" },
            { "tip_expand", "展开工具栏" }, { "tip_collapse", "收起工具栏" },
        };

        private static readonly Dictionary<string, string> en = new Dictionary<string, string>
        {
            { "app_title", "Qianji Desktop" },
            { "err_title", "Qianji Isolated Desktop Error" },
            { "startup_fail_title", "Qianji Isolated Desktop Failed to Start" },
            { "menu_fixed", "Fixed resolution" },
            { "menu_dynamic", "Dynamic resolution" },
            { "menu_about", "About Qianji Isolated Desktop" },
            { "menu_open_log", "Open log folder" },
            { "about_body", "Qianji Isolated Child Session Desktop: runs a real native Windows Child Session under your current account without touching your physical mouse or keyboard.\n\n• Adapted from Ray-Desktop (MIT License, Copyright © 2026 raydoomed)" },
            { "res_your_screen", "{0} × {1} (your screen, recommended)" },
            { "res_confirm_title", "Change resolution" },
            { "res_confirm_body", "Change the isolated desktop to {0} × {1} now?\n\n• Open applications inside the isolated desktop will stay running" },
            { "close_confirm_title", "Close isolated desktop" },
            { "close_confirm_body", "The isolated desktop is still connected and running apps may have unsaved work. Close anyway?" },
            { "res_not_connected", "Not connected yet; cannot change resolution." },
            { "res_fail", "Failed to change resolution: " },
            { "status_connected", "Connected" },
            { "status_connecting", "Connecting to local Child Session…" },
            { "status_connecting_win", "Connecting to local Windows Child Session…" },
            { "status_waiting", "Waiting for Windows to create the Child Session…" },
            { "status_not_connected", "Not connected" },
            { "status_timeout", "Connection timed out. Ensure Child Sessions are enabled, then sign out and back in once." },
            { "status_disabled_missing_helper", "Child Sessions are disabled; helper qianji-enable-child-sessions.exe is missing." },
            { "status_requesting", "Requesting administrator to enable Child Sessions. Sign out and back in once after enabling." },
            { "status_elevation_canceled", "Administrator authorization was canceled; Child Sessions are still disabled." },
            { "status_launch_helper_fail", "Could not launch the elevation helper: " },
            { "status_disconnected_local", "Disconnected from local Child Session." },
            { "menu_reconnect", "Reconnect" },
            { "status_reconnect_failed", "Auto-reconnect failed several times; click \"Reconnect\" in More menu to retry." },
            { "status_disconnected", "Child Session disconnected, code 0x{0:X8}" },
            { "status_disconnected_acct", " (re-login required). If you just enabled Child Sessions, sign out of Windows and sign back in once." },
            { "status_fatal", "Fatal RDP error 0x{0:X8}" },
            { "status_logon_error", "Child Session logon error 0x{0:X8}" },
            { "status_continuing", "Windows is continuing to build the Child Session…" },
            { "status_state", "RDP control state: " },
            { "status_read_fail", "Failed to read connection state: " },
            { "msg_connect_fail", "Connection failed: " },
            { "msg_check_fail", "Could not check Windows Child Session state, error {0}. Ensure this Windows edition supports Child Sessions." },
            { "btn_fullscreen", "Fullscreen" }, { "btn_display", "Display" }, { "btn_resolution", "Resolution" },
            { "btn_exit", "Exit" }, { "btn_more", "More" }, { "btn_collapse", "Collapse" }, { "btn_drag", "Drag" },
            { "tip_display_dynamic", "Display · Dynamic" }, { "tip_display_fixed", "Display · Fixed" },
            { "tip_expand", "Expand toolbar" }, { "tip_collapse", "Collapse toolbar" },
        };

        public static string T(string key)
        {
            var table = _en ? en : zh;
            string s;
            return table.TryGetValue(key, out s) ? s : key;
        }

        public static string T(string key, params object[] args)
        {
            return string.Format(T(key), args);
        }
    }
}
