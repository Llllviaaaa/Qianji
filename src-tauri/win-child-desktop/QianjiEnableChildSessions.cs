// Adapted from Ray-Desktop (https://github.com/raydoomed/Ray-Desktop, MIT License, Copyright (c) 2026 raydoomed)
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace QianjiChildSessionSetup
{
    internal static class Program
    {
        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSEnableChildSessions([MarshalAs(UnmanagedType.Bool)] bool enable);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSIsChildSessionsEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);

        private static string T(string zh, string en)
        {
            return CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? zh : en;
        }

        private static void RecordEnableTimestamp()
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "qianji",
                    "bot-desktop");
                Directory.CreateDirectory(dir);
                long unixMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                File.WriteAllText(
                    Path.Combine(dir, "child-session-enabled-ts.txt"),
                    unixMs.ToString(CultureInfo.InvariantCulture),
                    Encoding.UTF8);
            }
            catch
            {
                // Best-effort marker write; non-elevated caller also persists logon LUID.
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            bool quiet = args != null && Array.IndexOf(args, "--quiet") >= 0;
            try
            {
                bool wasEnabled = false;
                WTSIsChildSessionsEnabled(out wasEnabled);

                if (!WTSEnableChildSessions(true))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new InvalidOperationException(T(
                        "WTSEnableChildSessions 失败，Windows 错误码 " + error + "。",
                        "WTSEnableChildSessions failed, Windows error code " + error + "."));
                }

                bool enabled;
                if (!WTSIsChildSessionsEnabled(out enabled) || !enabled)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new InvalidOperationException(T(
                        "Windows 未确认 Child Sessions 已启用，错误码 " + error + "。",
                        "Windows did not confirm Child Sessions are enabled, error code " + error + "."));
                }

                if (!wasEnabled)
                {
                    RecordEnableTimestamp();
                }

                if (!quiet)
                {
                    MessageBox.Show(
                        T(
                            "Child Sessions 已启用。请保存工作并注销 Windows，然后重新登录一次再使用千机独立桌面。\r\n\r\n如果现在连接时出现 Windows 凭据提示，请取消提示，不要尝试输入空密码；注销并重新登录后，独立子会话会使用当前登录状态自动免密连接。",
                            "Child Sessions are enabled. Save your work, sign out of Windows, then sign back in once to use Qianji's isolated desktop.\r\n\r\nIf a Windows credential prompt appears when connecting now, cancel it and do not enter a blank password; after signing out and back in, the child session will connect automatically without a password using your current sign-in."),
                        T("千机 · 独立 Windows 桌面设置", "Qianji · Isolated Windows Desktop Setup"),
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
                return 0;
            }
            catch (Exception ex)
            {
                if (!quiet)
                {
                    MessageBox.Show(
                        ex.Message + Environment.NewLine + Environment.NewLine + T(
                            "请确认此 Windows 版本支持 Child Sessions（Windows 10/11 专业版、企业版或教育版），并允许管理员操作。",
                            "Verify this Windows edition supports Child Sessions (Windows 10/11 Pro, Enterprise, or Education) and that administrator action is allowed."),
                        T("无法启用 Child Sessions", "Could Not Enable Child Sessions"),
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                return 1;
            }
        }
    }
}
