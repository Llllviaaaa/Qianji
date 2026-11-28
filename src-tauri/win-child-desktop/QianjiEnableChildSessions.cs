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
        [StructLayout(LayoutKind.Sequential)]
        private struct LUID
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_STATISTICS
        {
            public LUID TokenId;
            public LUID AuthenticationId;
            public long ExpirationTime;
            public int TokenType;
            public int ImpersonationLevel;
            public uint DynamicCharged;
            public uint DynamicAvailable;
            public uint GroupCount;
            public uint PrivilegeCount;
            public LUID ModifiedId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_LINKED_TOKEN
        {
            public IntPtr LinkedToken;
        }

        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenStatisticsClass = 10;
        private const int TokenLinkedTokenClass = 19;

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSEnableChildSessions([MarshalAs(UnmanagedType.Bool)] bool enable);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSIsChildSessionsEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle, int tokenInformationClass, out TOKEN_STATISTICS tokenInformation, int tokenInformationLength, out int returnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle, int tokenInformationClass, out TOKEN_LINKED_TOKEN tokenInformation, int tokenInformationLength, out int returnLength);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static string T(string zh, string en)
        {
            return CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? zh : en;
        }

        private static string QueryTokenAuthLuid(IntPtr token)
        {
            if (token == IntPtr.Zero) return null;
            TOKEN_STATISTICS stats;
            int retLen;
            if (!GetTokenInformation(token, TokenStatisticsClass, out stats, Marshal.SizeOf(typeof(TOKEN_STATISTICS)), out retLen))
                return null;
            return stats.AuthenticationId.HighPart.ToString("x8") + ":" + stats.AuthenticationId.LowPart.ToString("x8");
        }

        private static void RecordEnableMarkers()
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

                string markerPath = Path.Combine(dir, "child-session-marker.json");
                if (!File.Exists(markerPath))
                {
                    IntPtr token = IntPtr.Zero;
                    IntPtr linked = IntPtr.Zero;
                    try
                    {
                        if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token) && token != IntPtr.Zero)
                        {
                            string ownLuid = QueryTokenAuthLuid(token);
                            string linkedLuid = null;
                            TOKEN_LINKED_TOKEN lt;
                            int retLen;
                            if (GetTokenInformation(token, TokenLinkedTokenClass, out lt, Marshal.SizeOf(typeof(TOKEN_LINKED_TOKEN)), out retLen) && lt.LinkedToken != IntPtr.Zero)
                            {
                                linked = lt.LinkedToken;
                                linkedLuid = QueryTokenAuthLuid(linked);
                            }
                            if (!string.IsNullOrEmpty(ownLuid) || !string.IsNullOrEmpty(linkedLuid))
                            {
                                string primary = !string.IsNullOrEmpty(linkedLuid) ? linkedLuid : ownLuid;
                                string secondary = !string.IsNullOrEmpty(ownLuid) ? ownLuid : primary;
                                string json = "{\"authLuid\":\"" + primary + "\",\"linkedAuthLuid\":\"" + secondary + "\"}";
                                File.WriteAllText(markerPath, json, new UTF8Encoding(false));
                            }
                        }
                    }
                    finally
                    {
                        if (linked != IntPtr.Zero) CloseHandle(linked);
                        if (token != IntPtr.Zero) CloseHandle(token);
                    }
                }
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
                    RecordEnableMarkers();
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
