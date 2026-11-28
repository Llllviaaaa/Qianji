// Adapted from Ray-Desktop (https://github.com/raydoomed/Ray-Desktop, MIT License, Copyright (c) 2026 raydoomed)
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace QianjiWinDesktop
{
    internal static class Program
    {
        private static readonly object LogLock = new object();
        private static Mutex singleInstance;

        internal static string ViewerEndpointPath
        {
            get { return Path.Combine(ChildSessionAgent.BotDesktopDirectory, "viewer-endpoint.json"); }
        }

        internal static string SignOutMarkerPath
        {
            get { return Path.Combine(ChildSessionAgent.BotDesktopDirectory, "child-session-marker.json"); }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e) { Log(e.Exception.ToString()); };
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) { Log(Convert.ToString(e.ExceptionObject)); };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string lang = null;
            bool childAgentMode = false;
            int agentPort = 0;
            string agentKey = null;
            uint parentSession = 0;
            bool dynamicMode = false;
            string controlCmd = null;

            for (int i = 0; args != null && i < args.Length; i++)
            {
                string a = args[i];
                if (string.Equals(a, "--lang", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) lang = args[++i];
                else if (a.StartsWith("--lang=", StringComparison.OrdinalIgnoreCase)) lang = a.Substring(7);
                else if (string.Equals(a, "--child-agent", StringComparison.OrdinalIgnoreCase)) childAgentMode = true;
                else if (string.Equals(a, "--port", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) int.TryParse(args[++i], out agentPort);
                else if (string.Equals(a, "--token", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) agentKey = args[++i];
                else if (string.Equals(a, "--parent-session", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) uint.TryParse(args[++i], out parentSession);
                else if (string.Equals(a, "--dynamic", StringComparison.OrdinalIgnoreCase)) dynamicMode = true;
                else if (string.Equals(a, "--focus", StringComparison.OrdinalIgnoreCase)) controlCmd = "focus";
                else if (string.Equals(a, "--minimize", StringComparison.OrdinalIgnoreCase)) controlCmd = "minimize";
                else if (string.Equals(a, "--close", StringComparison.OrdinalIgnoreCase)) controlCmd = "close";
            }
            Strings.SetLanguage(lang);

            if (childAgentMode)
            {
                if (!ChildSessionAgent.ShouldRunInCurrentSession(parentSession)) return 0;
                bool agentNew;
                using (var agentMutex = new Mutex(true, @"Local\QianjiChildAgent_SingleInstance", out agentNew))
                {
                    if (!agentNew) return 0;
                    Application.Run(new ChildSessionAgent(agentPort, agentKey, parentSession));
                }
                return 0;
            }

            if (controlCmd != null && TrySendViewerCommand(controlCmd))
                return 0;
            if (controlCmd == "close" || controlCmd == "minimize")
                return 0;

            bool createdNew;
            singleInstance = new Mutex(true, @"Local\QianjiWinDesktop_SingleInstance", out createdNew);
            if (!createdNew)
            {
                TrySendViewerCommand("focus");
                return 0;
            }

            Application.Run(new DesktopForm(dynamicMode));
            return 0;
        }

        internal static bool TrySendViewerCommand(string cmd)
        {
            try
            {
                if (!File.Exists(ViewerEndpointPath)) return false;
                var ep = MiniJson.ParseObject(File.ReadAllText(ViewerEndpointPath, Encoding.UTF8));
                int port = MiniJson.GetInt(ep, "port", 0);
                string key = MiniJson.GetString(ep, "key", string.Empty);
                if (port <= 0) return false;
                string body = MiniJson.Serialize(new Dictionary<string, object> { { "action", cmd } });
                var res = LoopbackHttpServer.SendJson(port, key, "POST", "/action", body, 2000);
                return MiniJson.GetBool(res, "ok", false);
            }
            catch
            {
                return false;
            }
        }

        internal static string LogDirectory
        {
            get
            {
                try
                {
                    string dir = Path.Combine(ChildSessionAgent.BotDesktopDirectory, "logs");
                    Directory.CreateDirectory(dir);
                    return dir;
                }
                catch { return AppDomain.CurrentDomain.BaseDirectory; }
            }
        }

        internal static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    string path = Path.Combine(LogDirectory, "child-session.log");
                    if (File.Exists(path) && new FileInfo(path).Length > 5 * 1024 * 1024)
                    {
                        string arch = path + ".1";
                        if (File.Exists(arch)) File.Delete(arch);
                        File.Move(path, arch);
                    }
                    string clean = (message ?? string.Empty).Replace("\0", string.Empty);
                    File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + clean + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }
    }

    internal sealed class DesktopForm : Form
    {
        private readonly ChildSessionControl rdp;
        private readonly Timer statusTimer;
        private readonly Timer displayResizeTimer;
        private readonly Timer reconnectTimer;
        private Timer readyTimer;
        private Timer lateResizeTimer;
        private LoopbackHttpServer controlServer;
        private readonly ReconnectPolicy reconnectPolicy = new ReconnectPolicy();

        private bool connecting;
        private bool closing;
        private bool programmaticClose;
        private int lastLoggedState = -1;
        private Size lastRequestedDisplaySize = Size.Empty;
        private Size lastFailedDisplaySize = Size.Empty;
        private DateTime connectionStarted;
        private DateTime connectionReadyAt = DateTime.MinValue;
        private DateTime nextResizeAttempt = DateTime.MinValue;
        private int resizeRetryCount;

        internal bool dynamicMode;
        private int _fixedSessW, _fixedSessH;
        private double aspect;
        private int currentSessW, currentSessH;
        private bool _resChangePending;
        private bool _lastMaximized;
        private bool fullscreen;
        private Rectangle prevBounds;
        private Rectangle _trackedScreen = Rectangle.Empty;
        private bool _followScreenRes = true;
        private int _maxSessW, _maxSessH;
        private Size _fixedMatchClient = Size.Empty;
        private FormBorderStyle prevBorder;
        private ToolbarForm toolBar;
        private Panel authGuidePanel;
        private Label authGuideStatusLabel;
        private ContextMenuStrip _displayMenu, _moreMenu, _resMenu;

        private const int WM_SIZING = 0x0214;
        private const int WM_EXITSIZEMOVE = 0x0232;
        private const int WM_HOTKEY = 0x0312;
        private const int WM_DISPLAYCHANGE = 0x007E;
        private const int SW_SHOWNORMAL = 1;
        private const uint VK_F11 = 0x7A;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_FRAMECHANGED = 0x0020;

        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct WINDOWPLACEMENT
        {
            public int length, flags, showCmd;
            public POINT ptMinPosition, ptMaxPosition;
            public RECT rcNormalPosition;
        }

        [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
        [DllImport("user32.dll")] private static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);

        internal DesktopForm(bool dynamicMode)
        {
            this.dynamicMode = dynamicMode;
            Text = Strings.T("app_title");
            BackColor = Color.Black;
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            int screenW = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.Bounds.Width : 1280;
            int screenH = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.Bounds.Height : 800;
            if (screenW <= 0 || screenH <= 0) { screenW = 1280; screenH = 800; }
            screenW &= ~1; screenH &= ~1;
            SetSessionResolution(screenW, screenH);
            if (!dynamicMode) { _fixedSessW = screenW; _fixedSessH = screenH; }
            int initialW = (int)(screenW * 0.88);
            int initialH = (int)(initialW / aspect + 0.5);
            ClientSize = new Size(initialW, initialH);
            if (!dynamicMode) _fixedMatchClient = new Size(initialW, initialH);
            MinimumSize = new Size(640, (int)(640 / aspect + 0.5));

            rdp = new ChildSessionControl { Dock = DockStyle.None, BackColor = Color.Black };
            rdp.RdpEvents.Connected = delegate { HideAuthGuide(); Program.Log("RDP OnConnected event received"); };
            rdp.RdpEvents.RemoteDesktopSizeChange = HandleRemoteResize;
            rdp.RdpEvents.Disconnected = HandleDisconnected;
            rdp.RdpEvents.FatalError = HandleFatalError;
            rdp.RdpEvents.LogonError = HandleLogonError;
            Controls.Add(rdp);
            InitAuthGuidePanel();

            statusTimer = new Timer { Interval = 750 };
            statusTimer.Tick += delegate { UpdateConnectionStatus(); };
            displayResizeTimer = new Timer { Interval = 300 };
            displayResizeTimer.Tick += delegate { displayResizeTimer.Stop(); ApplyDisplaySize(); };
            reconnectTimer = new Timer { Interval = 2000 };
            reconnectTimer.Tick += delegate { if (!closing && !IsDisposed) TryAutoReconnect(); };

            Shown += delegate
            {
                StartViewerControlServer();
                if (dynamicMode) SetDynamicLayout(); else ApplyLetterbox();
                ChildSessionAgent.RegisterChildAgentStartup();
                BeginInvoke((MethodInvoker)ConnectChildSession);
            };
            FormClosing += OnClosing;
        }

        private void StartViewerControlServer()
        {
            try
            {
                string key = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
                controlServer = new LoopbackHttpServer(0, key, HandleViewerControlRequest);
                long unixMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                LoopbackHttpServer.WriteEndpointFile(Program.ViewerEndpointPath, new Dictionary<string, object>
                {
                    { "pid", Process.GetCurrentProcess().Id },
                    { "port", controlServer.Port },
                    { "key", key },
                    { "startedAtMs", unixMs }
                });
            }
            catch (Exception ex)
            {
                Program.Log("Could not start viewer control server: " + ex.GetBaseException().Message);
            }
        }

        private Dictionary<string, object> HandleViewerControlRequest(string method, string path, Dictionary<string, object> req)
        {
            if (path == "/status")
            {
                int connState = 0;
                string winState = "normal";
                Invoke((MethodInvoker)delegate
                {
                    try { dynamic ocx = rdp.GetOcxObject(); if (ocx != null) connState = (int)ocx.Connected; } catch { }
                    if (WindowState == FormWindowState.Minimized) winState = "minimized";
                    else if (WindowState == FormWindowState.Maximized) winState = "maximized";
                });
                return new Dictionary<string, object>
                {
                    { "ok", true },
                    { "viewerOpen", true },
                    { "connectedState", connState },
                    { "sessionWidth", currentSessW },
                    { "sessionHeight", currentSessH },
                    { "windowState", winState },
                    { "fullscreen", fullscreen }
                };
            }
            if (path == "/preview")
            {
                string b64 = null;
                int pw = 1280, ph = 800;
                Invoke((MethodInvoker)delegate
                {
                    int w = Math.Max(320, rdp.Width), h = Math.Max(200, rdp.Height);
                    pw = w; ph = h;
                    using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                    {
                        using (Graphics g = Graphics.FromImage(bmp))
                        {
                            Point screenOrigin = rdp.PointToScreen(Point.Empty);
                            g.CopyFromScreen(screenOrigin, Point.Empty, new Size(w, h));
                        }
                        using (var ms = new MemoryStream())
                        {
                            bmp.Save(ms, ImageFormat.Png);
                            b64 = Convert.ToBase64String(ms.ToArray());
                        }
                    }
                });
                return new Dictionary<string, object>
                {
                    { "ok", b64 != null },
                    { "mimeType", "image/png" },
                    { "dataBase64", b64 ?? string.Empty },
                    { "width", pw },
                    { "height", ph }
                };
            }
            if (path == "/action")
            {
                string act = MiniJson.GetString(req, "action", "focus");
                BeginInvoke((MethodInvoker)delegate
                {
                    if (act == "focus" || act == "restore" || act == "open" || act == "connect")
                    {
                        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                        Show();
                        Activate();
                        SetForegroundWindow(Handle);
                        if (toolBar != null) toolBar.FollowHost(this);
                        if (act == "connect")
                        {
                            int curState = 0;
                            try { dynamic ocx = rdp.GetOcxObject(); if (ocx != null) curState = (int)ocx.Connected; } catch { }
                            if (curState == 0 && !connecting) Reconnect();
                        }
                    }
                    else if (act == "minimize") WindowState = FormWindowState.Minimized;
                    else if (act == "reconnect") Reconnect();
                    else if (act == "close") { programmaticClose = true; Close(); }
                });
                return new Dictionary<string, object> { { "ok", true }, { "action", act } };
            }
            return new Dictionary<string, object> { { "ok", false }, { "error", "Unknown viewer route" } };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!dynamicMode) RegisterHotKey(Handle, 1, 0, VK_F11);
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            if (!dynamicMode) UnregisterHotKey(Handle, 1);
            base.OnHandleDestroyed(e);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            bool max = (WindowState == FormWindowState.Maximized);
            if (max != _lastMaximized)
            {
                bool wasMax = _lastMaximized;
                _lastMaximized = max;
                if (max)
                {
                    _maxSessW = currentSessW; _maxSessH = currentSessH;
                    if (dynamicMode) QueueDisplayResize(true);
                }
                else if (wasMax && _maxSessW > 0)
                {
                    ApplySessionResolution(_maxSessW, _maxSessH, false);
                }
                if (toolBar != null) toolBar.ResetToTopCenter();
            }
            if (dynamicMode) SetDynamicLayout(); else ApplyLetterbox();
            LayoutAuthGuidePanel();
            if (toolBar != null) toolBar.FollowHost(this);
        }

        protected override void OnMove(EventArgs e)
        {
            base.OnMove(e);
            if (toolBar != null) toolBar.FollowHost(this);
            AutoFollowScreen();
        }

        private void AutoFollowScreen()
        {
            if (Handle == IntPtr.Zero || IsDisposed || fullscreen) return;
            var scr = Screen.FromControl(this).Bounds;
            if (scr.Width <= 0 || scr.Height <= 0) return;
            if (_trackedScreen == Rectangle.Empty) { _trackedScreen = scr; return; }
            if (scr != _trackedScreen)
            {
                _trackedScreen = scr;
                if (_followScreenRes && rdp != null)
                {
                    try
                    {
                        dynamic client = rdp.GetOcxObject();
                        if (client != null && (int)client.Connected == 1)
                            ApplySessionResolution(scr.Width & ~1, scr.Height, false);
                    }
                    catch { }
                }
                else if (!_followScreenRes && rdp != null)
                {
                    MatchWindowToSession(currentSessW, currentSessH);
                    HoldCurrentDisplaySize();
                }
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == 1) { ToggleFullscreen(); return; }
            if (m.Msg == WM_DISPLAYCHANGE) { AutoFollowScreen(); return; }
            if (m.Msg == WM_EXITSIZEMOVE)
            {
                SyncRestoreRect();
                if (dynamicMode) QueueDisplayResize(true);
            }
            if (!dynamicMode && m.Msg == WM_SIZING && aspect > 0)
            {
                RECT r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
                int bw = Width - ClientSize.Width, bh = Height - ClientSize.Height;
                Rect result;
                if (Geometry.LockAspectRect(
                    new Rect { Left = r.Left, Top = r.Top, Right = r.Right, Bottom = r.Bottom },
                    new Rect { Left = Left, Top = Top, Right = Right, Bottom = Bottom },
                    bw, bh, aspect, m.WParam.ToInt32(), out result))
                {
                    r.Left = result.Left; r.Top = result.Top; r.Right = result.Right; r.Bottom = result.Bottom;
                    Marshal.StructureToPtr(r, m.LParam, false);
                    m.Result = (IntPtr)1;
                    return;
                }
            }
            base.WndProc(ref m);
        }

        private void SyncRestoreRect()
        {
            try
            {
                if (Handle == IntPtr.Zero || IsDisposed) return;
                var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)) };
                if (!GetWindowPlacement(Handle, ref wp) || wp.showCmd != SW_SHOWNORMAL) return;
                wp.flags = 0;
                wp.rcNormalPosition = new RECT { Left = Left, Top = Top, Right = Right, Bottom = Bottom };
                SetWindowPlacement(Handle, ref wp);
            }
            catch { }
        }

        private void SetSessionResolution(int w, int h)
        {
            if (w <= 0 || h <= 0) return;
            currentSessW = w; currentSessH = h;
            aspect = (double)w / (double)h;
        }

        private void ApplyLetterbox()
        {
            if (rdp == null || rdp.IsDisposed) return;
            int cw = ClientSize.Width, ch = ClientSize.Height;
            if (cw <= 0 || ch <= 0) return;
            int dw, dh, dx, dy;
            Geometry.ComputeLetterbox(cw, ch, currentSessW > 0 ? currentSessW : 0, currentSessH > 0 ? currentSessH : 0, out dw, out dh, out dx, out dy);
            rdp.Location = new Point(dx, dy);
            rdp.Size = new Size(dw, dh);
        }

        private void SetDynamicLayout()
        {
            if (rdp == null || rdp.IsDisposed) return;
            rdp.SetBounds(0, 0, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height));
        }

        private void InitAuthGuidePanel()
        {
            authGuidePanel = new Panel
            {
                Size = new Size(500, 250),
                BackColor = Color.FromArgb(24, 26, 32),
                Visible = false
            };

            var titleLabel = new Label
            {
                Text = Strings.T("guide_auth_title"),
                ForeColor = Color.FromArgb(243, 244, 246),
                Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold),
                AutoSize = false,
                Location = new Point(24, 20),
                Size = new Size(452, 28)
            };

            var bodyLabel = new Label
            {
                Text = Strings.T("guide_auth_body"),
                ForeColor = Color.FromArgb(180, 188, 200),
                Font = new Font("Microsoft YaHei UI", 9.2f, FontStyle.Regular),
                AutoSize = false,
                Location = new Point(24, 56),
                Size = new Size(452, 112)
            };

            authGuideStatusLabel = new Label
            {
                Text = string.Empty,
                ForeColor = Color.FromArgb(251, 191, 36),
                Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular),
                AutoSize = false,
                Location = new Point(24, 170),
                Size = new Size(452, 22)
            };

            var retryBtn = new Button
            {
                Text = Strings.T("btn_retry_connect"),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 9.2f, FontStyle.Bold),
                Location = new Point(24, 200),
                Size = new Size(140, 32),
                Cursor = Cursors.Hand
            };
            retryBtn.FlatAppearance.BorderSize = 0;
            retryBtn.Click += delegate { Reconnect(); };

            var closeBtn = new Button
            {
                Text = Strings.T("btn_close_window"),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(42, 45, 54),
                ForeColor = Color.FromArgb(229, 231, 235),
                Font = new Font("Microsoft YaHei UI", 9.2f, FontStyle.Regular),
                Location = new Point(176, 200),
                Size = new Size(108, 32),
                Cursor = Cursors.Hand
            };
            closeBtn.FlatAppearance.BorderColor = Color.FromArgb(68, 74, 88);
            closeBtn.Click += delegate { programmaticClose = true; Close(); };

            authGuidePanel.Controls.Add(titleLabel);
            authGuidePanel.Controls.Add(bodyLabel);
            authGuidePanel.Controls.Add(authGuideStatusLabel);
            authGuidePanel.Controls.Add(retryBtn);
            authGuidePanel.Controls.Add(closeBtn);
            Controls.Add(authGuidePanel);
            LayoutAuthGuidePanel();
        }

        private void LayoutAuthGuidePanel()
        {
            if (authGuidePanel == null || authGuidePanel.IsDisposed) return;
            int x = Math.Max(12, (ClientSize.Width - authGuidePanel.Width) / 2);
            int y = Math.Max(12, (ClientSize.Height - authGuidePanel.Height) / 2);
            authGuidePanel.Location = new Point(x, y);
        }

        private void ShowAuthGuide(string detail)
        {
            if (authGuidePanel == null || authGuidePanel.IsDisposed) return;
            if (authGuideStatusLabel != null) authGuideStatusLabel.Text = detail ?? string.Empty;
            LayoutAuthGuidePanel();
            authGuidePanel.Visible = true;
            authGuidePanel.BringToFront();
        }

        private void HideAuthGuide()
        {
            if (authGuidePanel == null || authGuidePanel.IsDisposed) return;
            authGuidePanel.Visible = false;
        }

        private void ConnectChildSession()
        {
            if (connecting || closing || rdp.IsDisposed) return;
            HideAuthGuide();
            try
            {
                bool childSessionsEnabled;
                if (!NativeSessionApi.WTSIsChildSessionsEnabled(out childSessionsEnabled))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new InvalidOperationException(Strings.T("msg_check_fail", error));
                }
                if (!childSessionsEnabled)
                {
                    connecting = false;
                    RequestEnableChildSessions();
                    return;
                }

                object ocxObj = rdp.GetOcxObject();
                if (ocxObj == null) return;
                dynamic client = ocxObj;
                int state = (int)client.Connected;
                if (state == 1)
                {
                    connecting = false;
                    SetStatus(Strings.T("status_connected"));
                    statusTimer.Start();
                    if (dynamicMode) QueueDisplayResize(); else ApplyLetterbox();
                    return;
                }
                if (state == 2)
                {
                    connecting = true;
                    connectionStarted = DateTime.Now;
                    SetStatus(Strings.T("status_connecting"));
                    statusTimer.Start();
                    return;
                }

                connecting = true;
                connectionStarted = DateTime.Now;
                SetStatus(Strings.T("status_connecting_win"));
                client.Server = "localhost";
                if (!dynamicMode)
                {
                    int sw = (currentSessW > 0 && currentSessH > 0) ? currentSessW : Screen.PrimaryScreen.Bounds.Width;
                    int sh = (currentSessW > 0 && currentSessH > 0) ? currentSessH : Screen.PrimaryScreen.Bounds.Height;
                    if (sw <= 0 || sh <= 0) { sw = 1280; sh = 800; }
                    sw &= ~1; sh &= ~1;
                    client.DesktopWidth = sw;
                    client.DesktopHeight = sh;
                    SetSessionResolution(sw, sh);
                }

                var extended = (IMsRdpExtendedSettings)ocxObj;
                object connectToChild = true;
                extended.set_Property("ConnectToChildSession", ref connectToChild);

                dynamic adv = client.AdvancedSettings9;
                adv.EnableCredSspSupport = true;
                adv.SmartSizing = true;
                adv.RedirectClipboard = true;
                adv.RedirectDrives = true;
                EnableDriveRedirection(ocxObj);
                adv.EnableWindowsKey = 1;
                adv.AcceleratorPassthrough = 1;
                client.SecuredSettings3.KeyboardHookMode = 1;

                client.Connect();
                statusTimer.Start();
            }
            catch (Exception ex)
            {
                Program.Log("Connect setup failed: " + ex);
                connecting = false;
                SetStatus(Strings.T("msg_connect_fail") + ex.GetBaseException().Message);
            }
        }

        private static void EnableDriveRedirection(object ocx)
        {
            try
            {
                var drives = ((IMsRdpClientNonScriptable3)ocx).DriveCollection;
                drives.RescanDrives(true);
                uint count = drives.DriveCount;
                for (uint i = 0; i < count; i++)
                {
                    var drive = drives.get_DriveByIndex(i);
                    drive.RedirectionState = true;
                }
            }
            catch (Exception ex)
            {
                Program.Log("Drive redirection enum skipped: " + ex.GetBaseException().Message);
            }
        }

        private void RequestEnableChildSessions()
        {
            string helperPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qianji-enable-child-sessions.exe");
            if (!File.Exists(helperPath))
            {
                SetStatus(Strings.T("status_disabled_missing_helper"));
                return;
            }
            try
            {
                string authLuid = NativeSessionApi.GetCurrentAuthLuid();
                var startInfo = new ProcessStartInfo { FileName = helperPath, Arguments = "--quiet", UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
                using (Process helper = Process.Start(startInfo)) { }
                if (!string.IsNullOrEmpty(authLuid))
                {
                    LoopbackHttpServer.WriteEndpointFile(Program.SignOutMarkerPath, new Dictionary<string, object>
                    {
                        { "authLuid", authLuid }
                    });
                }
                SetStatus(Strings.T("status_requesting"));
            }
            catch (Win32Exception ex)
            {
                if (ex.NativeErrorCode == 1223) SetStatus(Strings.T("status_elevation_canceled"));
                else SetStatus(Strings.T("status_launch_helper_fail") + ex.Message);
            }
            catch (Exception ex)
            {
                SetStatus(Strings.T("status_launch_helper_fail") + ex.GetBaseException().Message);
            }
        }

        private void UpdateConnectionStatus()
        {
            try
            {
                dynamic client = rdp.GetOcxObject();
                if (client == null) return;
                int state = (int)client.Connected;
                if (state != lastLoggedState)
                {
                    lastLoggedState = state;
                    if (state == 1)
                    {
                        HideAuthGuide();
                        connectionReadyAt = DateTime.Now.AddSeconds(2);
                        resizeRetryCount = 0;
                        lastFailedDisplaySize = Size.Empty;
                        nextResizeAttempt = DateTime.MinValue;
                        if (readyTimer != null) { readyTimer.Stop(); readyTimer.Dispose(); }
                        readyTimer = new Timer { Interval = 1200 };
                        readyTimer.Tick += delegate { readyTimer.Stop(); readyTimer.Dispose(); CreateToolbar(); };
                        readyTimer.Start();
                    }
                    else if (state == 0) connectionReadyAt = DateTime.MinValue;
                }

                if (connecting && (state == 0 || state == 2) && DateTime.Now - connectionStarted > TimeSpan.FromSeconds(45))
                {
                    connecting = false;
                    statusTimer.Stop();
                    EnterReconnectState();
                    try { client.Disconnect(); } catch { }
                    SetStatus(Strings.T("status_timeout"));
                    return;
                }

                if (state == 0) SetStatus(connecting ? Strings.T("status_waiting") : Strings.T("status_not_connected"));
                else if (state == 1)
                {
                    connecting = false;
                    SetStatus(Strings.T("status_connected"));
                    if (!dynamicMode)
                    {
                        int dw = (int)client.DesktopWidth, dh = (int)client.DesktopHeight;
                        if (dw > 0 && dh > 0 && !_resChangePending && (dw != currentSessW || dh != currentSessH))
                        {
                            SetSessionResolution(dw, dh);
                            ApplyLetterbox();
                        }
                    }
                }
                else if (state == 2) SetStatus(Strings.T("status_connecting"));
                else SetStatus(Strings.T("status_state") + state);
            }
            catch (Exception ex)
            {
                SetStatus(Strings.T("status_read_fail") + ex.GetBaseException().Message);
                statusTimer.Stop();
                if (!closing) EnterReconnectState();
            }
        }

        private void HandleRemoteResize(int width, int height)
        {
            try
            {
                if (rdp == null || rdp.IsDisposed) return;
                if (InvokeRequired) { BeginInvoke((MethodInvoker)delegate { HandleRemoteResize(width, height); }); return; }
                if (rdp.Size.Width > 2 && rdp.Size.Height > 2)
                    rdp.Size = new Size(rdp.Size.Width - 1, rdp.Size.Height - 1);
                ApplyLetterbox();
                if (toolBar != null) toolBar.FollowHost(this);
            }
            catch { }
        }

        private void HandleDisconnected(int reason)
        {
            if (InvokeRequired) { BeginInvoke((MethodInvoker)delegate { HandleDisconnected(reason); }); return; }
            if (closing || IsDisposed || reconnectTimer.Enabled) return;
            connecting = false;
            statusTimer.Stop();
            string message = reason == 1 ? Strings.T("status_disconnected_local") : Strings.T("status_disconnected", reason);
            if (reason == 0xC07) message += Strings.T("status_disconnected_acct");
            SetStatus(message);
            if (ReconnectPolicy.ShouldAutoReconnect(reason)) EnterReconnectState();
            else ShowAuthGuide(message);
        }

        private void HandleFatalError(int errorCode)
        {
            if (InvokeRequired) { BeginInvoke((MethodInvoker)delegate { HandleFatalError(errorCode); }); return; }
            if (closing || IsDisposed) return;
            connecting = false;
            statusTimer.Stop();
            SetStatus(Strings.T("status_fatal", errorCode));
            EnterReconnectState();
        }

        private void HandleLogonError(int errorCode)
        {
            if (InvokeRequired) { BeginInvoke((MethodInvoker)delegate { HandleLogonError(errorCode); }); return; }
            if (closing || IsDisposed) return;
            if (errorCode == -2) { SetStatus(Strings.T("status_continuing")); return; }
            connecting = false;
            statusTimer.Stop();
            string message = Strings.T("status_logon_error", errorCode);
            SetStatus(message);
            ShowAuthGuide(message);
        }

        private void EnterReconnectState()
        {
            if (closing || IsDisposed || reconnectTimer == null) return;
            connecting = false;
            if (!reconnectTimer.Enabled)
            {
                reconnectPolicy.Enter();
                reconnectTimer.Interval = 2000;
                reconnectTimer.Start();
            }
        }

        private void Reconnect()
        {
            if (closing || rdp == null || rdp.IsDisposed || connecting) return;
            if (reconnectTimer != null && reconnectTimer.Enabled) reconnectTimer.Stop();
            reconnectPolicy.OnManualReconnect();
            ConnectChildSession();
        }

        private void TryAutoReconnect()
        {
            try
            {
                dynamic client = rdp.GetOcxObject();
                if (client != null && (int)client.Connected == 1)
                {
                    reconnectTimer.Stop();
                    connecting = false;
                    reconnectPolicy.OnReconnected();
                    statusTimer.Start();
                    SetStatus(Strings.T("status_connected"));
                    return;
                }
                reconnectPolicy.OnAttempt();
                if (reconnectPolicy.GaveUp)
                {
                    reconnectTimer.Stop();
                    SetStatus(Strings.T("status_reconnect_failed"));
                    return;
                }
                try { if (client != null) client.Disconnect(); } catch { }
                ConnectChildSession();
            }
            catch { }
        }

        private void CreateToolbar()
        {
            if (toolBar != null) return;
            toolBar = new ToolbarForm
            {
                ToggleFullscreen = ToggleFullscreen,
                ShowResMenu = ShowResMenuAt,
                ShowDisplayModeMenu = ShowDisplayModeMenuAt,
                ShowMoreMenu = ShowMoreMenuAt,
                IsDynamicMode = dynamicMode
            };
            toolBar.FollowHost(this);
            toolBar.Show();
        }

        private bool ToggleFullscreen()
        {
            fullscreen = !fullscreen;
            if (toolBar != null) toolBar.Fullscreen = fullscreen;
            if (fullscreen)
            {
                prevBounds = Bounds;
                prevBorder = FormBorderStyle;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                FormBorderStyle = prevBorder;
                if (toolBar != null) toolBar.ResetToTopCenter();
                Bounds = prevBounds;
            }
            if (dynamicMode) { SetDynamicLayout(); QueueDisplayResize(); } else ApplyLetterbox();
            if (toolBar != null) toolBar.UpdateState(fullscreen);
            return fullscreen;
        }

        private void SetStatus(string message)
        {
            string t = message + " — " + Strings.T("app_title");
            if (Text != t) Text = t;
        }

        private ContextMenuStrip MenuInstance(ref ContextMenuStrip field)
        {
            if (field == null || field.IsDisposed)
            {
                field = new ContextMenuStrip { ShowImageMargin = false, BackColor = Color.FromArgb(32, 32, 38), ForeColor = Color.White };
            }
            field.Items.Clear();
            return field;
        }

        private bool ShowDisplayModeMenuAt(Rectangle anchor)
        {
            var menu = MenuInstance(ref _displayMenu);
            menu.ShowCheckMargin = true;
            var itemFixed = new ToolStripMenuItem(Strings.T("menu_fixed")) { Checked = !dynamicMode };
            itemFixed.Click += delegate { SetDisplayMode(false); };
            var itemDyn = new ToolStripMenuItem(Strings.T("menu_dynamic")) { Checked = dynamicMode };
            itemDyn.Click += delegate { SetDisplayMode(true); };
            menu.Items.Add(itemFixed);
            menu.Items.Add(itemDyn);
            menu.Show(new Point(anchor.Left, anchor.Bottom));
            return true;
        }

        private bool ShowMoreMenuAt(Rectangle anchor)
        {
            var menu = MenuInstance(ref _moreMenu);
            menu.ShowCheckMargin = false;
            var itemRec = new ToolStripMenuItem(Strings.T("menu_reconnect"));
            itemRec.Click += delegate { Reconnect(); };
            var itemLog = new ToolStripMenuItem(Strings.T("menu_open_log"));
            itemLog.Click += delegate { try { Process.Start("explorer.exe", Program.LogDirectory); } catch { } };
            var itemAbout = new ToolStripMenuItem(Strings.T("menu_about"));
            itemAbout.Click += delegate { MessageBox.Show(this, Strings.T("about_body"), Strings.T("menu_about"), MessageBoxButtons.OK, MessageBoxIcon.Information); };
            menu.Items.Add(itemRec);
            menu.Items.Add(itemLog);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(itemAbout);
            menu.Show(new Point(anchor.Left, anchor.Bottom));
            return true;
        }

        private bool ShowResMenuAt(Rectangle anchor)
        {
            var menu = MenuInstance(ref _resMenu);
            menu.ShowCheckMargin = true;
            int sw = Screen.FromControl(this).Bounds.Width, sh = Screen.FromControl(this).Bounds.Height;
            var itemScr = new ToolStripMenuItem(Strings.T("res_your_screen", sw, sh)) { Checked = (currentSessW == (sw & ~1) && currentSessH == sh) };
            itemScr.Click += delegate { ApplyResolutionPick(0, 0); };
            menu.Items.Add(itemScr);
            int[,] presets = { { 2560, 1440 }, { 1920, 1080 }, { 1600, 1000 }, { 1280, 800 }, { 1280, 720 } };
            for (int i = 0; i < presets.GetLength(0); i++)
            {
                int w = presets[i, 0], h = presets[i, 1];
                if (w == sw && h == sh) continue;
                var item = new ToolStripMenuItem(w + " × " + h) { Checked = (currentSessW == w && currentSessH == h) };
                int cw = w, ch = h;
                item.Click += delegate { ApplyResolutionPick(cw, ch); };
                menu.Items.Add(item);
            }
            menu.Show(new Point(anchor.Left, anchor.Bottom));
            return true;
        }

        private void ApplyResolutionPick(int pickW, int pickH)
        {
            int sw = Screen.FromControl(this).Bounds.Width, sh = Screen.FromControl(this).Bounds.Height;
            int w = pickW == 0 ? sw : pickW, h = pickW == 0 ? sh : pickH;
            w &= ~1;
            _followScreenRes = (pickW == 0);
            ApplySessionResolution(w, h, true);
        }

        private void SetDisplayMode(bool mode)
        {
            if (dynamicMode == mode) return;
            if (mode) { _fixedSessW = currentSessW; _fixedSessH = currentSessH; }
            dynamicMode = mode;
            if (Handle != IntPtr.Zero)
            {
                if (mode) UnregisterHotKey(Handle, 1);
                else RegisterHotKey(Handle, 1, 0, VK_F11);
            }
            if (mode) { SetDynamicLayout(); QueueDisplayResize(true); }
            else
            {
                displayResizeTimer.Stop();
                int fw = (_fixedSessW > 0 ? _fixedSessW : 1280) & ~1;
                int fh = _fixedSessH > 0 ? _fixedSessH : 800;
                ApplySessionResolution(fw, fh, false);
            }
            if (toolBar != null) { toolBar.IsDynamicMode = mode; toolBar.Invalidate(); toolBar.FollowHost(this); }
        }

        private void HoldCurrentDisplaySize()
        {
            int w = Math.Max(200, Math.Min(8192, ClientSize.Width)) & ~1;
            int h = Math.Max(200, Math.Min(8192, ClientSize.Height));
            lastRequestedDisplaySize = new Size(w, h);
        }

        private void ApplySessionResolution(int w, int h, bool confirmUi)
        {
            try
            {
                dynamic client = rdp.GetOcxObject();
                if (client == null || (int)client.Connected != 1)
                {
                    if (confirmUi) MessageBox.Show(this, Strings.T("res_not_connected"), Strings.T("res_confirm_title"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                float dpi = 96f;
                try { using (var gr = rdp.CreateGraphics()) dpi = gr.DpiX; } catch { }
                client.UpdateSessionDisplaySettings((uint)w, (uint)h, Geometry.ToMillimeters(w, dpi), Geometry.ToMillimeters(h, dpi), 0u, 100u, 100u);
                _resChangePending = true;
                SetSessionResolution(w, h);
                if (toolBar != null) toolBar.ResetToTopCenter();
                MatchWindowToSession(w, h);
                if (dynamicMode) HoldCurrentDisplaySize();
                if (lateResizeTimer != null) { lateResizeTimer.Stop(); lateResizeTimer.Dispose(); }
                lateResizeTimer = new Timer { Interval = 900 };
                lateResizeTimer.Tick += delegate
                {
                    lateResizeTimer.Stop(); lateResizeTimer.Dispose();
                    try
                    {
                        dynamic c2 = rdp.GetOcxObject();
                        int dw = (int)c2.DesktopWidth, dh = (int)c2.DesktopHeight;
                        if (dw > 0 && dh > 0) SetSessionResolution(dw, dh);
                    }
                    catch { }
                    _resChangePending = false;
                    MatchWindowToSession(currentSessW, currentSessH);
                    if (dynamicMode) HoldCurrentDisplaySize();
                    if (toolBar != null) toolBar.FollowHost(this);
                };
                lateResizeTimer.Start();
            }
            catch (Exception ex)
            {
                _resChangePending = false;
                if (confirmUi) MessageBox.Show(this, Strings.T("res_fail") + ex.GetBaseException().Message, Strings.T("res_confirm_title"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void MatchWindowToSession(int sessW, int sessH)
        {
            if (Handle == IntPtr.Zero || IsDisposed || sessW <= 0 || sessH <= 0) return;
            if (fullscreen) { ApplyLetterbox(); return; }
            MinimumSize = new Size(320, (int)(320 / aspect + 0.5));
            var area = Screen.FromControl(this).WorkingArea;
            int bw = Width - ClientSize.Width, bh = Height - ClientSize.Height;
            int availW = Math.Max(320, area.Width - bw - 8), availH = Math.Max(240, area.Height - bh - 8);
            double s = Math.Min(1.0, Math.Min((double)availW / sessW, (double)availH / sessH));
            int cw = (int)(sessW * s + 0.5), ch = (int)(sessH * s + 0.5);
            if (!dynamicMode) _fixedMatchClient = new Size(cw, ch);
            int ww = cw + bw, wh = ch + bh;
            int L = Math.Max(area.Left, area.Left + (area.Width - ww) / 2);
            int T = Math.Max(area.Top, area.Top + (area.Height - wh) / 2);
            SetWindowPos(Handle, IntPtr.Zero, L, T, ww, wh, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            SyncRestoreRect();
            if (dynamicMode) SetDynamicLayout(); else ApplyLetterbox();
            LayoutAuthGuidePanel();
            if (toolBar != null) toolBar.FollowHost(this);
        }

        private void QueueDisplayResize(bool windowSizeChanged = false)
        {
            if (closing || displayResizeTimer == null || rdp.IsDisposed) return;
            if (windowSizeChanged)
            {
                resizeRetryCount = 0; lastFailedDisplaySize = Size.Empty; nextResizeAttempt = DateTime.MinValue;
                displayResizeTimer.Stop(); displayResizeTimer.Interval = 300;
            }
            else if (displayResizeTimer.Enabled) return;
            else if (nextResizeAttempt > DateTime.Now)
                displayResizeTimer.Interval = Math.Max(100, (int)Math.Ceiling((nextResizeAttempt - DateTime.Now).TotalMilliseconds));
            else displayResizeTimer.Interval = 300;
            displayResizeTimer.Start();
        }

        private void ApplyDisplaySize()
        {
            if (closing || !dynamicMode || rdp.IsDisposed || !rdp.IsHandleCreated) return;
            try
            {
                dynamic client = rdp.GetOcxObject();
                if (client == null || (int)client.Connected != 1) return;
                if (DateTime.Now < connectionReadyAt)
                {
                    displayResizeTimer.Interval = Math.Max(100, (int)Math.Ceiling((connectionReadyAt - DateTime.Now).TotalMilliseconds));
                    displayResizeTimer.Start();
                    return;
                }
                int width = Math.Max(200, Math.Min(8192, ClientSize.Width)) & ~1;
                int height = Math.Max(200, Math.Min(8192, ClientSize.Height));
                var requested = new Size(width, height);
                if (requested == lastRequestedDisplaySize) return;
                float dpiX = 96f, dpiY = 96f;
                using (Graphics g = rdp.CreateGraphics()) { dpiX = g.DpiX; dpiY = g.DpiY; }
                client.UpdateSessionDisplaySettings((uint)width, (uint)height, Geometry.ToMillimeters(width, dpiX), Geometry.ToMillimeters(height, dpiY), 0u, 100u, 100u);
                lastRequestedDisplaySize = requested;
                lastFailedDisplaySize = Size.Empty;
                resizeRetryCount = 0;
                SetSessionResolution(width, height);
            }
            catch
            {
                var req = new Size(Math.Max(200, Math.Min(8192, ClientSize.Width)) & ~1, Math.Max(200, Math.Min(8192, ClientSize.Height)));
                if (req != lastFailedDisplaySize) { lastFailedDisplaySize = req; resizeRetryCount = 0; }
                resizeRetryCount++;
                int delay = Math.Min(4000, 500 * (1 << Math.Min(resizeRetryCount - 1, 3)));
                nextResizeAttempt = DateTime.Now.AddMilliseconds(delay);
                displayResizeTimer.Interval = delay;
                displayResizeTimer.Start();
            }
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing && !programmaticClose)
            {
                bool connected = false;
                try { dynamic c = rdp.GetOcxObject(); connected = c != null && (int)c.Connected == 1; } catch { }
                if (connected)
                {
                    var r = MessageBox.Show(this, Strings.T("close_confirm_body"), Strings.T("close_confirm_title"), MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                    if (r != DialogResult.OK) { e.Cancel = true; return; }
                }
            }
            closing = true;
            _resChangePending = false;
            if (controlServer != null) { controlServer.Dispose(); controlServer = null; }
            try { if (File.Exists(Program.ViewerEndpointPath)) File.Delete(Program.ViewerEndpointPath); } catch { }
            if (toolBar != null) { toolBar.Close(); toolBar.Dispose(); toolBar = null; }
            statusTimer.Stop();
            displayResizeTimer.Stop();
            reconnectTimer.Stop();
            if (readyTimer != null) readyTimer.Stop();
            if (lateResizeTimer != null) lateResizeTimer.Stop();
            if (_displayMenu != null) _displayMenu.Dispose();
            if (_moreMenu != null) _moreMenu.Dispose();
            if (_resMenu != null) _resMenu.Dispose();
            try { dynamic c = rdp.GetOcxObject(); if (c != null) c.Disconnect(); } catch { }
            try
            {
                uint childSessionId;
                if (NativeSessionApi.WTSGetChildSessionId(out childSessionId) && childSessionId != uint.MaxValue)
                {
                    NativeSessionApi.WTSLogoffSession(IntPtr.Zero, childSessionId, false);
                }
            }
            catch { }
        }
    }
}
