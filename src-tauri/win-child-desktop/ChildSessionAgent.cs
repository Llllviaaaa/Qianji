// Child-Session Loopback HTTP/JSON Agent (runs strictly INSIDE the Windows Child Session).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

namespace QianjiWinDesktop
{
    internal sealed class ChildSessionAgent : ApplicationContext
    {
        private const string RunValueName = "QianjiWinDesktopChildAgent";
        private readonly uint parentSessionId;
        private readonly uint childSessionId;
        private readonly LoopbackHttpServer server;
        private readonly Timer watchdogTimer;
        private readonly string endpointPath;

        internal static string BotDesktopDirectory
        {
            get
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "qianji",
                    "bot-desktop");
                Directory.CreateDirectory(dir);
                return dir;
            }
        }

        internal static string AgentConfigPath
        {
            get { return Path.Combine(BotDesktopDirectory, "child-agent-config.json"); }
        }

        internal static string AgentEndpointPath
        {
            get { return Path.Combine(BotDesktopDirectory, "child-agent-endpoint.json"); }
        }

        internal static void RegisterChildAgentStartup()
        {
            uint hostSessionId;
            if (!NativeSessionApi.ProcessIdToSessionId(NativeSessionApi.GetCurrentProcessId(), out hostSessionId))
            {
                Program.Log("Child agent not registered: could not determine host session ID");
                return;
            }

            int preferredPort = 0;
            string sharedKey = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            try
            {
                if (File.Exists(AgentConfigPath))
                {
                    var existing = MiniJson.ParseObject(File.ReadAllText(AgentConfigPath, Encoding.UTF8));
                    string existingKey = MiniJson.GetString(existing, "key", null);
                    if (!string.IsNullOrEmpty(existingKey)) sharedKey = existingKey;
                    preferredPort = MiniJson.GetInt(existing, "port", 0);
                }
            }
            catch { }

            var cfg = new Dictionary<string, object>
            {
                { "port", preferredPort },
                { "key", sharedKey },
                { "parentSessionId", (long)hostSessionId }
            };
            LoopbackHttpServer.WriteEndpointFile(AgentConfigPath, cfg);

            try
            {
                string executable = Application.ExecutablePath;
                string command = "\"" + executable + "\" --child-agent --port " + preferredPort +
                                 " --token " + sharedKey + " --parent-session " + hostSessionId;
                using (RegistryKey runKey = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    if (runKey != null)
                    {
                        runKey.SetValue(RunValueName, command, RegistryValueKind.String);
                    }
                }
                Program.Log("Registered child-session startup agent for parent session " + hostSessionId);
            }
            catch (Exception ex)
            {
                Program.Log("Could not register child-session startup agent: " + ex.GetBaseException().Message);
            }
        }

        internal static bool ShouldRunInCurrentSession(uint parentSid)
        {
            uint mySid;
            if (!NativeSessionApi.ProcessIdToSessionId(NativeSessionApi.GetCurrentProcessId(), out mySid))
                return false;
            uint consoleSid = NativeSessionApi.WTSGetActiveConsoleSessionId();
            if (mySid == consoleSid || (parentSid != 0 && mySid == parentSid))
                return false;
            if (parentSid != 0 && !NativeSessionApi.IsSessionLive(parentSid))
                return false;
            return true;
        }

        internal ChildSessionAgent(int requestedPort, string cliKey, uint cliParentSession)
        {
            NativeSessionApi.ProcessIdToSessionId(NativeSessionApi.GetCurrentProcessId(), out childSessionId);
            parentSessionId = cliParentSession;
            string activeKey = cliKey;
            int portToBind = requestedPort > 0 ? requestedPort : 0;

            try
            {
                if (File.Exists(AgentConfigPath))
                {
                    var cfg = MiniJson.ParseObject(File.ReadAllText(AgentConfigPath, Encoding.UTF8));
                    string cfgKey = MiniJson.GetString(cfg, "key", null);
                    if (!string.IsNullOrEmpty(cfgKey)) activeKey = cfgKey;
                    if (parentSessionId == 0)
                        parentSessionId = (uint)Math.Max(0, MiniJson.GetInt(cfg, "parentSessionId", 0));
                    if (portToBind == 0)
                        portToBind = Math.Max(0, MiniJson.GetInt(cfg, "port", 0));
                }
            }
            catch { }

            if (string.IsNullOrEmpty(activeKey))
                activeKey = Guid.NewGuid().ToString("N");

            try
            {
                server = new LoopbackHttpServer(portToBind, activeKey, HandleRequest);
            }
            catch
            {
                server = new LoopbackHttpServer(0, activeKey, HandleRequest);
            }

            endpointPath = AgentEndpointPath;
            WriteLiveEndpoint(activeKey);
            Program.Log("ChildSessionAgent listening on 127.0.0.1:" + server.Port + " in session " + childSessionId);

            watchdogTimer = new Timer { Interval = 2500 };
            watchdogTimer.Tick += delegate
            {
                if (parentSessionId != 0 && !NativeSessionApi.IsSessionLive(parentSessionId))
                {
                    Program.Log("Parent session " + parentSessionId + " ended; ChildSessionAgent exiting");
                    ExitThread();
                }
            };
            watchdogTimer.Start();
        }

        private void WriteLiveEndpoint(string activeKey)
        {
            long unixMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            var ep = new Dictionary<string, object>
            {
                { "pid", Process.GetCurrentProcess().Id },
                { "sessionId", (long)childSessionId },
                { "parentSessionId", (long)parentSessionId },
                { "port", server.Port },
                { "key", activeKey },
                { "updatedAtMs", unixMs }
            };
            LoopbackHttpServer.WriteEndpointFile(endpointPath, ep);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (watchdogTimer != null) { watchdogTimer.Stop(); watchdogTimer.Dispose(); }
                if (server != null) server.Dispose();
                try { if (File.Exists(endpointPath)) File.Delete(endpointPath); } catch { }
            }
            base.Dispose(disposing);
        }

        private Dictionary<string, object> HandleRequest(string method, string path, Dictionary<string, object> req)
        {
            if (path == "/status") return HandleStatus();
            if (path == "/capture") return HandleCapture(req);
            if (path == "/input") return HandleInput(req);
            if (path == "/launch") return HandleLaunch(req);
            if (path == "/close-window") return HandleCloseWindow(req);
            return new Dictionary<string, object> { { "ok", false }, { "error", "Unknown route: " + path } };
        }

        private Dictionary<string, object> HandleStatus()
        {
            Rectangle bounds = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.Bounds : new Rectangle(0, 0, 1280, 800);
            POINT pt;
            GetCursorPos(out pt);
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "sessionId", (long)childSessionId },
                { "width", bounds.Width },
                { "height", bounds.Height },
                { "cursorX", pt.X },
                { "cursorY", pt.Y },
                { "openWindows", EnumerateSessionWindows() }
            };
        }

        private Dictionary<string, object> HandleCapture(Dictionary<string, object> req)
        {
            Rectangle bounds = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.Bounds : new Rectangle(0, 0, 1280, 800);
            int srcW = Math.Max(1, bounds.Width);
            int srcH = Math.Max(1, bounds.Height);
            int targetW = MiniJson.GetInt(req, "width", srcW);
            int targetH = MiniJson.GetInt(req, "height", srcH);
            if (targetW <= 0) targetW = srcW;
            if (targetH <= 0) targetH = srcH;
            bool drawCursor = MiniJson.GetBool(req, "drawCursor", true);
            string format = MiniJson.GetString(req, "format", "png");
            int quality = Math.Max(30, Math.Min(98, MiniJson.GetInt(req, "quality", 85)));

            POINT cursorPt;
            GetCursorPos(out cursorPt);

            using (var rawBmp = new Bitmap(srcW, srcH, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(rawBmp))
                {
                    g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, new Size(srcW, srcH), CopyPixelOperation.SourceCopy);
                    if (drawCursor)
                    {
                        DrawSessionCursor(g, cursorPt.X - bounds.Left, cursorPt.Y - bounds.Top);
                    }
                }

                Bitmap outBmp = rawBmp;
                bool ownsOut = false;
                if (targetW != srcW || targetH != srcH)
                {
                    outBmp = new Bitmap(targetW, targetH, PixelFormat.Format24bppRgb);
                    ownsOut = true;
                    using (Graphics sg = Graphics.FromImage(outBmp))
                    {
                        sg.InterpolationMode = InterpolationMode.HighQualityBilinear;
                        sg.DrawImage(rawBmp, new Rectangle(0, 0, targetW, targetH), new Rectangle(0, 0, srcW, srcH), GraphicsUnit.Pixel);
                    }
                }

                try
                {
                    using (var ms = new MemoryStream())
                    {
                        string mimeType;
                        if (string.Equals(format, "jpeg", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(format, "jpg", StringComparison.OrdinalIgnoreCase))
                        {
                            ImageCodecInfo jpegCodec = FindEncoder(ImageFormat.Jpeg);
                            if (jpegCodec != null)
                            {
                                using (var encParams = new EncoderParameters(1))
                                {
                                    encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                                    outBmp.Save(ms, jpegCodec, encParams);
                                }
                            }
                            else outBmp.Save(ms, ImageFormat.Jpeg);
                            mimeType = "image/jpeg";
                        }
                        else
                        {
                            outBmp.Save(ms, ImageFormat.Png);
                            mimeType = "image/png";
                        }

                        byte[] encoded = ms.ToArray();
                        return new Dictionary<string, object>
                        {
                            { "ok", true },
                            { "mimeType", mimeType },
                            { "dataBase64", Convert.ToBase64String(encoded) },
                            { "width", targetW },
                            { "height", targetH },
                            { "screenWidth", srcW },
                            { "screenHeight", srcH },
                            { "cursorX", cursorPt.X },
                            { "cursorY", cursorPt.Y },
                            { "openWindows", EnumerateSessionWindows() }
                        };
                    }
                }
                finally
                {
                    if (ownsOut) outBmp.Dispose();
                }
            }
        }

        private static void DrawSessionCursor(Graphics g, int cx, int cy)
        {
            var ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (GetCursorInfo(ref ci) && (ci.flags & 1) != 0 && ci.hCursor != IntPtr.Zero)
            {
                IntPtr hdc = g.GetHdc();
                try { DrawIcon(hdc, cx, cy, ci.hCursor); return; }
                finally { g.ReleaseHdc(hdc); }
            }
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Point[] arrow = new[] { new Point(cx, cy), new Point(cx, cy + 16), new Point(cx + 5, cy + 12), new Point(cx + 11, cy + 12) };
            using (var fill = new SolidBrush(Color.White)) g.FillPolygon(fill, arrow);
            using (var border = new Pen(Color.Black, 1.5f)) g.DrawPolygon(border, arrow);
        }

        private static ImageCodecInfo FindEncoder(ImageFormat fmt)
        {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageDecoders();
            for (int i = 0; i < codecs.Length; i++)
                if (codecs[i].FormatID == fmt.Guid) return codecs[i];
            return null;
        }

        private Dictionary<string, object> HandleInput(Dictionary<string, object> req)
        {
            Rectangle bounds = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.Bounds : new Rectangle(0, 0, 1280, 800);
            int screenW = Math.Max(1, bounds.Width);
            int screenH = Math.Max(1, bounds.Height);
            string op = MiniJson.GetString(req, "op", "click");
            string button = MiniJson.GetString(req, "button", "left");
            int sourceW = MiniJson.GetInt(req, "sourceWidth", screenW);
            int sourceH = MiniJson.GetInt(req, "sourceHeight", screenH);
            if (sourceW <= 0) sourceW = screenW;
            if (sourceH <= 0) sourceH = screenH;

            POINT cur;
            GetCursorPos(out cur);
            int rawX = MiniJson.GetInt(req, "x", int.MinValue);
            int rawY = MiniJson.GetInt(req, "y", int.MinValue);
            int physX = rawX == int.MinValue ? cur.X : (bounds.Left + (int)Math.Round((double)rawX * screenW / sourceW));
            int physY = rawY == int.MinValue ? cur.Y : (bounds.Top + (int)Math.Round((double)rawY * screenH / sourceH));
            physX = Math.Max(bounds.Left, Math.Min(bounds.Right - 1, physX));
            physY = Math.Max(bounds.Top, Math.Min(bounds.Bottom - 1, physY));

            if (op == "move" || op == "click" || op == "double_click" || op == "down" || op == "up")
            {
                SendMouseAbsoluteMove(physX, physY, screenW, screenH);
                uint downFlag, upFlag;
                ResolveButtonFlags(button, out downFlag, out upFlag);
                if (op == "down") SendMouseFlags(downFlag, 0);
                else if (op == "up") SendMouseFlags(upFlag, 0);
                else if (op == "click") { SendMouseFlags(downFlag, 0); SendMouseFlags(upFlag, 0); }
                else if (op == "double_click")
                {
                    SendMouseFlags(downFlag, 0); SendMouseFlags(upFlag, 0);
                    Thread.Sleep(35);
                    SendMouseFlags(downFlag, 0); SendMouseFlags(upFlag, 0);
                }
            }
            else if (op == "wheel")
            {
                if (rawX != int.MinValue && rawY != int.MinValue)
                    SendMouseAbsoluteMove(physX, physY, screenW, screenH);
                int dy = MiniJson.GetInt(req, "deltaY", 0);
                int dx = MiniJson.GetInt(req, "deltaX", 0);
                if (dy != 0) SendMouseFlags(MOUSEEVENTF_WHEEL, -dy);
                if (dx != 0) SendMouseFlags(MOUSEEVENTF_HWHEEL, dx);
            }
            else if (op == "key")
            {
                int vk = MiniJson.GetInt(req, "vk", 0);
                List<int> mods = MiniJson.GetIntList(req, "modifiers");
                for (int i = 0; i < mods.Count; i++) SendVirtualKey((ushort)mods[i], false);
                if (vk > 0)
                {
                    SendVirtualKey((ushort)vk, false);
                    SendVirtualKey((ushort)vk, true);
                }
                for (int i = mods.Count - 1; i >= 0; i--) SendVirtualKey((ushort)mods[i], true);
            }
            else if (op == "text")
            {
                string txt = MiniJson.GetString(req, "text", string.Empty);
                SendUnicodeString(txt);
            }

            POINT after;
            GetCursorPos(out after);
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "dispatched", true },
                { "cursorX", after.X },
                { "cursorY", after.Y },
                { "openWindows", EnumerateSessionWindows() }
            };
        }

        private Dictionary<string, object> HandleLaunch(Dictionary<string, object> req)
        {
            string executable = MiniJson.GetString(req, "executable", null);
            string arguments = MiniJson.GetString(req, "arguments", string.Empty);
            string cwd = MiniJson.GetString(req, "cwd", null);
            if (string.IsNullOrEmpty(executable))
                throw new ArgumentException("launch requires executable");

            var psi = new ProcessStartInfo
            {
                FileName = executable,
                Arguments = arguments ?? string.Empty,
                UseShellExecute = false
            };
            if (!string.IsNullOrEmpty(cwd) && Directory.Exists(cwd))
                psi.WorkingDirectory = cwd;

            int pid = 0;
            using (Process p = Process.Start(psi))
            {
                if (p != null)
                {
                    pid = p.Id;
                    try { p.WaitForInputIdle(900); } catch { }
                }
            }
            Thread.Sleep(150);
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "pid", pid },
                { "openWindows", EnumerateSessionWindows() }
            };
        }

        private Dictionary<string, object> HandleCloseWindow(Dictionary<string, object> req)
        {
            string targetHwnd = MiniJson.GetString(req, "hwnd", null);
            string targetTitle = MiniJson.GetString(req, "title", null);
            bool closeAll = MiniJson.GetBool(req, "closeAll", false);
            var closed = new List<string>();
            var windows = EnumerateSessionWindows();
            for (int i = 0; i < windows.Count; i++)
            {
                var w = windows[i];
                string hwndStr = w["hwnd"].ToString();
                string titleStr = w["title"].ToString();
                string appStr = w.ContainsKey("app") && w["app"] != null ? w["app"].ToString() : "";
                bool match = false;
                if (closeAll)
                {
                    match = !string.Equals(appStr, "explorer.exe", StringComparison.OrdinalIgnoreCase) ||
                            !string.IsNullOrEmpty(titleStr);
                }
                else if (!string.IsNullOrEmpty(targetHwnd) && string.Equals(hwndStr, targetHwnd, StringComparison.OrdinalIgnoreCase))
                    match = true;
                else if (!string.IsNullOrEmpty(targetTitle) && titleStr.IndexOf(targetTitle, StringComparison.OrdinalIgnoreCase) >= 0)
                    match = true;

                if (match)
                {
                    long rawVal;
                    if (hwndStr.StartsWith("0x", StringComparison.OrdinalIgnoreCase) &&
                        long.TryParse(hwndStr.Substring(2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out rawVal))
                    {
                        PostMessage(new IntPtr(rawVal), 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero);
                        closed.Add(hwndStr);
                    }
                }
            }
            if (closed.Count > 0) Thread.Sleep(120);
            return new Dictionary<string, object>
            {
                { "ok", true },
                { "closedHwnds", closed },
                { "openWindows", EnumerateSessionWindows() }
            };
        }

        internal static List<Dictionary<string, object>> EnumerateSessionWindows()
        {
            var list = new List<Dictionary<string, object>>();
            int selfPid = Process.GetCurrentProcess().Id;
            EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hwnd)) return true;
                int exStyle = GetWindowLong(hwnd, -20);
                if ((exStyle & 0x00000080 /* WS_EX_TOOLWINDOW */) != 0) return true;
                int len = GetWindowTextLength(hwnd);
                if (len <= 0) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(hwnd, sb, sb.Capacity);
                string title = sb.ToString().Trim();
                if (title.Length == 0 || title == "Program Manager") return true;

                RECT r;
                if (!GetWindowRect(hwnd, out r)) return true;
                if (r.Right - r.Left <= 4 || r.Bottom - r.Top <= 4) return true;

                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if ((int)pid == selfPid) return true;

                string appName = null;
                try
                {
                    using (Process proc = Process.GetProcessById((int)pid))
                        appName = proc.ProcessName + ".exe";
                }
                catch { }

                var item = new Dictionary<string, object>
                {
                    { "hwnd", "0x" + hwnd.ToInt64().ToString("x") },
                    { "title", title },
                    { "pid", (long)pid },
                    { "x", r.Left },
                    { "y", r.Top },
                    { "width", r.Right - r.Left },
                    { "height", r.Bottom - r.Top }
                };
                if (!string.IsNullOrEmpty(appName)) item["app"] = appName;
                list.Add(item);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        private const int INPUT_MOUSE = 0;
        private const int INPUT_KEYBOARD = 1;
        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x1000;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        private static void ResolveButtonFlags(string button, out uint down, out uint up)
        {
            if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase))
            {
                down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP;
            }
            else if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase))
            {
                down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP;
            }
            else
            {
                down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP;
            }
        }

        private static void SendMouseAbsoluteMove(int x, int y, int screenW, int screenH)
        {
            int absX = (int)Math.Round((double)x * 65535.0 / Math.Max(1, screenW - 1));
            int absY = (int)Math.Round((double)y * 65535.0 / Math.Max(1, screenH - 1));
            var input = new INPUT { type = INPUT_MOUSE };
            input.U.mi.dx = absX;
            input.U.mi.dy = absY;
            input.U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
            INPUT[] arr = new[] { input };
            SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void SendMouseFlags(uint flags, int mouseData)
        {
            var input = new INPUT { type = INPUT_MOUSE };
            input.U.mi.dwFlags = flags;
            input.U.mi.mouseData = (uint)mouseData;
            INPUT[] arr = new[] { input };
            SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void SendVirtualKey(ushort vk, bool up)
        {
            var input = new INPUT { type = INPUT_KEYBOARD };
            input.U.ki.wVk = vk;
            input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
            INPUT[] arr = new[] { input };
            SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void SendUnicodeString(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            var inputs = new List<INPUT>(text.Length * 2);
            for (int i = 0; i < text.Length; i++)
            {
                ushort ch = text[i];
                var down = new INPUT { type = INPUT_KEYBOARD };
                down.U.ki.wScan = ch;
                down.U.ki.dwFlags = KEYEVENTF_UNICODE;
                var up = new INPUT { type = INPUT_KEYBOARD };
                up.U.ki.wScan = ch;
                up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                inputs.Add(down);
                inputs.Add(up);
            }
            INPUT[] arr = inputs.ToArray();
            SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        private struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public int type; public InputUnion U; }
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO pci);
        [DllImport("user32.dll")] private static extern bool DrawIcon(IntPtr hDC, int x, int y, IntPtr hIcon);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    }
}
