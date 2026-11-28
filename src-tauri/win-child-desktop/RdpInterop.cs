// Adapted from Ray-Desktop (https://github.com/raydoomed/Ray-Desktop, MIT License, Copyright (c) 2026 raydoomed)
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace QianjiWinDesktop
{
    [ComImport, Guid("302D8188-0052-4807-806A-362B628F9AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMsRdpExtendedSettings
    {
        void set_Property(
            [In, MarshalAs(UnmanagedType.BStr)] string bstrPropertyName,
            [In, MarshalAs(UnmanagedType.Struct)] ref object pValue);

        [return: MarshalAs(UnmanagedType.Struct)]
        object get_Property([In, MarshalAs(UnmanagedType.BStr)] string bstrPropertyName);
    }

    [ComImport, Guid("D28B5458-F694-47A8-8E61-40356A767E46"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMsRdpDrive
    {
        string Name { [return: MarshalAs(UnmanagedType.BStr)] get; }
        bool RedirectionState { set; get; }
    }

    [ComImport, Guid("7FF17599-DA2C-4677-AD35-F60C04FE1585"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMsRdpDriveCollection
    {
        void RescanDrives(bool vboolDynRedir);
        IMsRdpDrive get_DriveByIndex(uint index);
        uint DriveCount { get; }
    }

    [ComImport, Guid("B3378D90-0728-45C7-8ED7-B6159FB92219"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMsRdpClientNonScriptable3
    {
        void set_ClearTextPassword([In, MarshalAs(UnmanagedType.BStr)] string password);
        void set_PortablePassword([In, MarshalAs(UnmanagedType.BStr)] string portablePass);
        [return: MarshalAs(UnmanagedType.BStr)] string get_PortablePassword();
        void set_PortableSalt([In, MarshalAs(UnmanagedType.BStr)] string portableSalt);
        [return: MarshalAs(UnmanagedType.BStr)] string get_PortableSalt();
        void set_BinaryPassword([In, MarshalAs(UnmanagedType.BStr)] string binaryPassword);
        [return: MarshalAs(UnmanagedType.BStr)] string get_BinaryPassword();
        void set_BinarySalt([In, MarshalAs(UnmanagedType.BStr)] string salt);
        [return: MarshalAs(UnmanagedType.BStr)] string get_BinarySalt();
        void ResetPassword();
        void NotifyRedirectDeviceChange(UIntPtr wParam, IntPtr lParam);
        void SendKeys(int numKeys, [In] ref bool pbArrayKeyUp, [In] ref int plKeyData);
        void set_UIParentWindowHandle(IntPtr hwnd);
        IntPtr get_UIParentWindowHandle();
        bool ShowRedirectionWarningDialog { set; get; }
        bool PromptForCredentials { set; get; }
        bool NegotiateSecurityLayer { set; get; }
        bool EnableCredSspSupport { set; get; }
        bool RedirectDynamicDrives { set; get; }
        bool RedirectDynamicDevices { set; get; }
        object DeviceCollection { [return: MarshalAs(UnmanagedType.Interface)] get; }
        IMsRdpDriveCollection DriveCollection { get; }
        bool WarnAboutSendingCredentials { set; get; }
        bool WarnAboutClipboardRedirection { set; get; }
        string ConnectionBarText { [param: MarshalAs(UnmanagedType.BStr)] set; [return: MarshalAs(UnmanagedType.BStr)] get; }
    }

    [ComImport, Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    internal interface IMsTscAxEvents
    {
        [DispId(2)] void OnConnected();
        [DispId(4)] void OnDisconnected(int discReason);
        [DispId(10)] void OnFatalError(int errorCode);
        [DispId(12)] void OnRemoteDesktopSizeChange(int width, int height);
        [DispId(22)] void OnLogonError(int lError);
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class RdpEventSink : IMsTscAxEvents
    {
        internal Action Connected;
        internal Action<int> Disconnected;
        internal Action<int> FatalError;
        internal Action<int, int> RemoteDesktopSizeChange;
        internal Action<int> LogonError;

        public void OnConnected() { var cb = Connected; if (cb != null) cb(); }
        public void OnDisconnected(int discReason) { var cb = Disconnected; if (cb != null) cb(discReason); }
        public void OnFatalError(int errorCode) { var cb = FatalError; if (cb != null) cb(errorCode); }
        public void OnRemoteDesktopSizeChange(int width, int height) { var cb = RemoteDesktopSizeChange; if (cb != null) cb(width, height); }
        public void OnLogonError(int lError) { var cb = LogonError; if (cb != null) cb(lError); }
    }

    internal sealed class ChildSessionControl : AxHost
    {
        private ConnectionPointCookie eventCookie;
        internal readonly RdpEventSink RdpEvents = new RdpEventSink();

        internal ChildSessionControl() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { }

        internal object GetOcxObject()
        {
            return GetOcx();
        }

        protected override void CreateSink()
        {
            base.CreateSink();
            try
            {
                object ocx = GetOcx();
                if (ocx != null)
                {
                    eventCookie = new ConnectionPointCookie(ocx, RdpEvents, typeof(IMsTscAxEvents));
                }
            }
            catch (Exception ex)
            {
                Program.Log("Could not attach IMsTscAxEvents sink: " + ex.GetBaseException().Message);
            }
        }

        protected override void DetachSink()
        {
            if (eventCookie != null)
            {
                try { eventCookie.Disconnect(); } catch { }
                eventCookie = null;
            }
            base.DetachSink();
        }
    }

    internal static class NativeSessionApi
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

        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenStatisticsClass = 10;

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSIsChildSessionsEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSGetChildSessionId(out uint sessionId);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSLogoffSession(IntPtr server, uint sessionId, [MarshalAs(UnmanagedType.Bool)] bool wait);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WTSQuerySessionInformation(
            IntPtr hServer, uint sessionId, int infoClass, out IntPtr ppBuffer, out uint pBytesReturned);

        [DllImport("wtsapi32.dll")]
        internal static extern void WTSFreeMemory(IntPtr pMemory);

        [DllImport("kernel32.dll")]
        internal static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle, int tokenInformationClass, out TOKEN_STATISTICS tokenInformation, int tokenInformationLength, out int returnLength);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        internal static string GetCurrentAuthLuid()
        {
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token) || token == IntPtr.Zero)
                    return null;
                TOKEN_STATISTICS stats;
                int retLen;
                if (!GetTokenInformation(token, TokenStatisticsClass, out stats, Marshal.SizeOf(typeof(TOKEN_STATISTICS)), out retLen))
                    return null;
                return stats.AuthenticationId.HighPart.ToString("x8") + ":" + stats.AuthenticationId.LowPart.ToString("x8");
            }
            catch
            {
                return null;
            }
            finally
            {
                if (token != IntPtr.Zero) CloseHandle(token);
            }
        }

        internal static bool IsSessionLive(uint sessionId)
        {
            IntPtr buffer = IntPtr.Zero;
            uint bytes = 0;
            try
            {
                // WTSConnectState == 8 in WTS_INFO_CLASS (0=Active, 1=Connected, 4=Disconnected)
                if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 8, out buffer, out bytes)) return false;
                if (buffer == IntPtr.Zero || bytes < 4) return false;
                int state = Marshal.ReadInt32(buffer);
                return state == 0 || state == 1 || state == 4;
            }
            finally
            {
                if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
            }
        }
    }
}
