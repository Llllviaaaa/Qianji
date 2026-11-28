// Adapted from Ray-Desktop (https://github.com/raydoomed/Ray-Desktop, MIT License, Copyright (c) 2026 raydoomed)
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace QianjiWinDesktop
{
    internal sealed class ToolbarForm : Form
    {
        internal Func<bool> ToggleFullscreen;
        internal Func<Rectangle, bool> ShowResMenu;
        internal Func<Rectangle, bool> ShowDisplayModeMenu;
        internal Func<Rectangle, bool> ShowMoreMenu;
        internal bool IsDynamicMode;

        private readonly string[] labels = {
            Strings.T("btn_fullscreen"), Strings.T("btn_display"), Strings.T("btn_resolution"),
            Strings.T("btn_exit"), Strings.T("btn_more"), Strings.T("btn_collapse"), Strings.T("btn_drag")
        };
        private const int DragBtnIndex = 6;
        private const int CollapseBtnIndex = 5;
        private int hoverIndex = -1;
        private int pressedIndex = -1;
        private int selectedIndex = -1;
        private float indicatorX = -1f;
        private bool dragging;
        private Point dragStart;
        private bool dragMoved;
        private bool _collapsed;
        private const double CollapsedOpacity = 0.42;
        private Form _host;
        private Point _hostOffset = new Point(int.MinValue, int.MinValue);
        private Rectangle[] buttonRects;
        private readonly Timer animTimer;
        private readonly TooltipForm tooltip;
        private const int BtnW = 30, BtnH = 26, Gap = 6, Pad = 6;
        private const int DotSize = 26;
        private float _scale = 1f;
        internal bool Fullscreen;

        internal ToolbarForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.None;
            using (var g = Graphics.FromHwnd(IntPtr.Zero))
                _scale = Math.Max(1f, g.DpiX / 96f);
            RebuildLayout();
            BackColor = Color.FromArgb(28, 28, 32);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer, true);
            animTimer = new Timer { Interval = 10 };
            animTimer.Tick += delegate { AnimateIndicator(); };
            animTimer.Start();
            tooltip = new TooltipForm();
            Disposed += delegate
            {
                animTimer.Stop();
                animTimer.Dispose();
                tooltip.Dispose();
                if (Region != null) { Region.Dispose(); Region = null; }
            };
        }

        private void RebuildLayout()
        {
            int bw = (int)Math.Round(BtnW * _scale), bh = (int)Math.Round(BtnH * _scale);
            int gap = (int)Math.Round(Gap * _scale), pad = (int)Math.Round(Pad * _scale);
            int n = labels.Length;
            if (buttonRects == null || buttonRects.Length != n) buttonRects = new Rectangle[n];
            int totalW = pad;
            for (int i = 0; i < n; i++)
            {
                buttonRects[i] = new Rectangle(totalW, pad, bw, bh);
                totalW += bw + gap;
            }
            if (_collapsed)
                Size = new Size((int)Math.Round(DotSize * _scale), (int)Math.Round(DotSize * _scale));
            else
                Size = new Size(totalW - gap + pad, pad + bh + pad);
            Invalidate();
        }

        private const int WM_DPICHANGED = 0x02E0;
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_DPICHANGED)
            {
                int newDpi = (ushort)((int)m.WParam & 0xFFFF);
                if (newDpi > 0)
                {
                    _scale = Math.Max(1f, newDpi / 96f);
                    RebuildLayout();
                    if (_host != null) FollowHost(_host);
                }
            }
            base.WndProc(ref m);
        }

        private void AnimateIndicator()
        {
            int targetIdx = (hoverIndex >= 0) ? hoverIndex : selectedIndex;
            if (targetIdx < 0)
            {
                if (indicatorX > -100f)
                {
                    indicatorX += (-100f - indicatorX) * 0.2f;
                    if (indicatorX < -99f) indicatorX = -100f;
                    Invalidate();
                }
                else animTimer.Stop();
                return;
            }
            float targetCenter = buttonRects[targetIdx].X + buttonRects[targetIdx].Width / 2f;
            if (indicatorX < 0 || indicatorX == -100f) indicatorX = targetCenter;
            else indicatorX += (targetCenter - indicatorX) * 0.15f;
            if (Math.Abs(indicatorX - targetCenter) < 0.5f) indicatorX = targetCenter;
            if (indicatorX == targetCenter) animTimer.Stop();
            else Invalidate();
        }

        internal void ResetToTopCenter()
        {
            _hostOffset = new Point(int.MinValue, int.MinValue);
        }

        private void Expand()
        {
            if (!_collapsed) return;
            _collapsed = false;
            Opacity = 1f;
            RebuildLayout();
            if (_host != null) FollowHost(_host);
            Invalidate();
        }

        private void Collapse()
        {
            if (_collapsed) return;
            _collapsed = true;
            Opacity = CollapsedOpacity;
            hoverIndex = -1; selectedIndex = -1; indicatorX = -100f;
            RebuildLayout();
            if (_host != null) FollowHost(_host);
            Invalidate();
        }

        internal void UpdateState(bool fs)
        {
            Fullscreen = fs;
            Invalidate();
        }

        internal void FollowHost(Form host)
        {
            _host = host;
            if (host == null || host.IsDisposed || !host.IsHandleCreated) return;
            if (host.WindowState == FormWindowState.Minimized)
            {
                if (Visible) Hide();
                return;
            }
            if (!Visible) Show();
            Rectangle clientScreen = host.RectangleToScreen(host.ClientRectangle);
            int x, y;
            if (Fullscreen || host.WindowState == FormWindowState.Maximized)
            {
                x = clientScreen.Left + (clientScreen.Width - Width) / 2;
                y = clientScreen.Top + 18;
            }
            else
            {
                if (_hostOffset.X == int.MinValue)
                    _hostOffset = new Point(Math.Max(0, (clientScreen.Width - Width) / 2), 18);
                x = clientScreen.Left + _hostOffset.X;
                y = clientScreen.Top + _hostOffset.Y;
                x = Math.Max(clientScreen.Left, Math.Min(x, clientScreen.Right - Width));
                y = Math.Max(clientScreen.Top, Math.Min(y, clientScreen.Bottom - Height));
            }
            if (Location != new Point(x, y)) Location = new Point(x, y);
            if (hoverIndex >= 0 && tooltip != null && tooltip.Visible)
                tooltip.Reposition(RectangleToScreen(buttonRects[hoverIndex]));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            if (_collapsed)
            {
                using (var bg = new SolidBrush(Color.FromArgb(235, 24, 24, 28)))
                    g.FillEllipse(bg, 0, 0, Width - 1, Height - 1);
                using (var pen = new Pen(Color.FromArgb(230, 205, 205, 215), Math.Max(1.5f, 1.8f * _scale)))
                    g.DrawEllipse(pen, 1f, 1f, Width - 3f, Height - 3f);
                // Minimal "Q" emblem for Qianji pill dot
                using (var p = new Pen(Color.FromArgb(245, 245, 248), Math.Max(1.8f, 2f * _scale)))
                {
                    p.StartCap = LineCap.Round;
                    p.EndCap = LineCap.Round;
                    float cx = Width / 2f, cy = Height / 2f;
                    float r = 5.5f * _scale;
                    g.DrawEllipse(p, cx - r, cy - r, r * 2f, r * 2f);
                    g.DrawLine(p, cx + 1.5f * _scale, cy + 1.5f * _scale, cx + 6.2f * _scale, cy + 6.2f * _scale);
                }
                return;
            }

            int radBg = (int)Math.Round(12 * _scale);
            using (var sh = new SolidBrush(Color.FromArgb(70, 0, 0, 0)))
                g.FillRectangle(sh, new Rectangle(0, Height - 2, Width, 2));
            var barRect = new Rectangle(0, 0, Width - 1, Height - 2);
            using (var p = RoundedRectPath(barRect, radBg))
            using (var bg = new SolidBrush(Color.FromArgb(228, 24, 24, 28)))
                g.FillPath(bg, p);

            int activeIdx = (hoverIndex >= 0) ? hoverIndex : selectedIndex;
            if (activeIdx >= 0 && indicatorX >= 0)
            {
                var ar = buttonRects[activeIdx];
                Rectangle ind = new Rectangle((int)(indicatorX - ar.Width / 2f), ar.Y, ar.Width, ar.Height);
                using (var ip = RoundedRectPath(ind, (int)Math.Round(7 * _scale)))
                using (var ib = new SolidBrush(Color.FromArgb(55, 255, 255, 255)))
                    g.FillPath(ib, ip);
            }

            for (int i = 0; i < buttonRects.Length; i++)
            {
                var r = buttonRects[i];
                if (pressedIndex == i)
                {
                    int d = Math.Min(r.Width, r.Height) - (int)Math.Round(4 * _scale);
                    Rectangle cir = new Rectangle(r.X + (r.Width - d) / 2, r.Y + (r.Height - d) / 2, d, d);
                    using (var hb = new SolidBrush(Color.FromArgb(90, 255, 255, 255)))
                        g.FillEllipse(hb, cir);
                }
                int cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2;
                if (pressedIndex == i) cy += (int)Math.Round(1 * _scale);
                var st = g.Save();
                g.ScaleTransform(_scale, _scale);
                DrawIcon(g, i, (int)(cx / _scale), (int)(cy / _scale));
                g.Restore(st);
            }

            using (var pen = new Pen(Color.FromArgb(130, 64, 64, 72)))
            using (var p = RoundedRectPath(barRect, radBg))
                g.DrawPath(pen, p);
        }

        private void DrawIcon(Graphics g, int index, int cx, int cy)
        {
            using (var pen = new Pen(Color.FromArgb(240, 240, 242), 2f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                switch (index)
                {
                    case 0:
                        if (Fullscreen)
                        {
                            g.DrawRectangle(pen, cx - 8, cy - 6, 13, 13);
                            g.DrawRectangle(pen, cx - 4, cy - 1, 13, 13);
                        }
                        else
                        {
                            g.DrawRectangle(pen, cx - 8, cy - 8, 16, 16);
                        }
                        break;
                    case 1:
                        g.DrawRectangle(pen, cx - 7, cy - 7, 14, 11);
                        g.DrawLine(pen, cx, cy + 4, cx, cy + 6);
                        g.DrawLine(pen, cx - 4, cy + 6, cx + 4, cy + 6);
                        break;
                    case 2:
                        g.DrawRectangle(pen, cx - 7, cy - 7, 14, 14);
                        g.DrawLine(pen, cx, cy - 7, cx, cy + 7);
                        g.DrawLine(pen, cx - 7, cy, cx + 7, cy);
                        break;
                    case 3:
                        g.DrawLine(pen, cx - 6, cy - 6, cx + 6, cy + 6);
                        g.DrawLine(pen, cx - 6, cy + 6, cx + 6, cy - 6);
                        break;
                    case 4:
                        using (var b = new SolidBrush(Color.FromArgb(240, 240, 242)))
                        {
                            g.FillEllipse(b, cx - 8, cy - 2, 4, 4);
                            g.FillEllipse(b, cx - 2, cy - 2, 4, 4);
                            g.FillEllipse(b, cx + 4, cy - 2, 4, 4);
                        }
                        break;
                    case 5:
                        g.DrawLine(pen, cx + 4, cy - 5, cx - 4, cy);
                        g.DrawLine(pen, cx - 4, cy, cx + 4, cy + 5);
                        break;
                    case 6:
                        using (var sq = new SolidBrush(Color.FromArgb(80, 80, 88)))
                        using (var dot = new SolidBrush(Color.FromArgb(150, 150, 158)))
                        {
                            using (var p = RoundedRectPath(new Rectangle(cx - 6, cy - 6, 12, 12), 3))
                                g.FillPath(sq, p);
                            for (int row = -1; row <= 1; row++)
                                for (int col = -1; col <= 1; col++)
                                    g.FillEllipse(dot, cx + col * 4 - 1.5f, cy + row * 4 - 1.5f, 3, 3);
                        }
                        break;
                }
            }
        }

        private static GraphicsPath RoundedRectPath(Rectangle r, int rad)
        {
            int d = Math.Max(2, Math.Min(rad * 2, Math.Min(r.Width, r.Height)));
            var p = new GraphicsPath();
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        internal string HoverText(int idx)
        {
            if (idx == 1) return Strings.T(IsDynamicMode ? "tip_display_dynamic" : "tip_display_fixed");
            if (idx == CollapseBtnIndex) return Strings.T(_collapsed ? "tip_expand" : "tip_collapse");
            return labels[idx];
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                dragMoved = false;
                if (_collapsed)
                {
                    dragging = true;
                    dragStart = e.Location;
                    if (tooltip != null) tooltip.HideAway();
                }
                else
                {
                    pressedIndex = HitTest(e.Location);
                    if (pressedIndex >= 0) Invalidate();
                    if (pressedIndex == DragBtnIndex)
                    {
                        dragging = true;
                        dragStart = e.Location;
                        if (tooltip != null) tooltip.HideAway();
                    }
                    else dragging = false;
                }
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (_collapsed)
            {
                if (dragging && (Math.Abs(e.X - dragStart.X) > 3 || Math.Abs(e.Y - dragStart.Y) > 3))
                {
                    dragMoved = true;
                    int nx = Location.X + e.X - dragStart.X;
                    int ny = Location.Y + e.Y - dragStart.Y;
                    if (_host != null)
                    {
                        Rectangle cs = _host.RectangleToScreen(_host.ClientRectangle);
                        nx = Math.Max(cs.Left, Math.Min(nx, cs.Right - Width));
                        ny = Math.Max(cs.Top, Math.Min(ny, cs.Bottom - Height));
                    }
                    Location = new Point(nx, ny);
                    if (tooltip != null) tooltip.HideAway();
                }
                base.OnMouseMove(e);
                return;
            }

            int idx = HitTest(e.Location);
            if (idx != hoverIndex)
            {
                hoverIndex = idx;
                Invalidate();
                animTimer.Start();
                if (idx >= 0) tooltip.ShowFor(RectangleToScreen(buttonRects[idx]), HoverText(idx));
                else tooltip.HideAway();
            }

            if (dragging && (Math.Abs(e.X - dragStart.X) > 3 || Math.Abs(e.Y - dragStart.Y) > 3))
            {
                dragMoved = true;
                if (pressedIndex >= 0) { pressedIndex = -1; Invalidate(); }
                int nx = Location.X + e.X - dragStart.X;
                int ny = Location.Y + e.Y - dragStart.Y;
                if (_host != null)
                {
                    Rectangle cs = _host.RectangleToScreen(_host.ClientRectangle);
                    nx = Math.Max(cs.Left, Math.Min(nx, cs.Right - Width));
                    ny = Math.Max(cs.Top, Math.Min(ny, cs.Bottom - Height));
                }
                Location = new Point(nx, ny);
                if (tooltip != null) tooltip.HideAway();
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            if (_collapsed) Opacity = 1f;
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hoverIndex = -1;
            selectedIndex = -1;
            Invalidate();
            animTimer.Start();
            tooltip.HideAway();
            if (_collapsed) Opacity = CollapsedOpacity;
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                dragging = false;
                if (dragMoved && _host != null)
                {
                    Rectangle cs = _host.RectangleToScreen(_host.ClientRectangle);
                    _hostOffset = new Point(Location.X - cs.Left, Location.Y - cs.Top);
                }
                if (!dragMoved)
                {
                    if (_collapsed) Expand();
                    else
                    {
                        int hit = HitTest(e.Location);
                        if (hit >= 0) ActivateButton(hit);
                    }
                }
                if (pressedIndex >= 0) { pressedIndex = -1; Invalidate(); }
            }
            base.OnMouseUp(e);
        }

        private void ActivateButton(int idx)
        {
            if (idx == 0 && ToggleFullscreen != null) ToggleFullscreen();
            else if (idx == 1 && ShowDisplayModeMenu != null)
            {
                ShowDisplayModeMenu(RectangleToScreen(buttonRects[1]));
                selectedIndex = idx; Invalidate(); animTimer.Start();
            }
            else if (idx == 2 && ShowResMenu != null)
            {
                ShowResMenu(RectangleToScreen(buttonRects[2]));
                selectedIndex = idx; Invalidate(); animTimer.Start();
            }
            else if (idx == 3 && _host != null) _host.Close();
            else if (idx == 4 && ShowMoreMenu != null)
            {
                ShowMoreMenu(RectangleToScreen(buttonRects[4]));
                selectedIndex = idx; Invalidate(); animTimer.Start();
            }
            else if (idx == CollapseBtnIndex) Collapse();
        }

        private int HitTest(Point p)
        {
            if (buttonRects == null) return -1;
            for (int i = 0; i < buttonRects.Length; i++)
                if (buttonRects[i].Contains(p)) return i;
            return -1;
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (Region != null) Region.Dispose();
            if (_collapsed)
            {
                using (var p = new GraphicsPath())
                {
                    p.AddEllipse(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
                    Region = new Region(p);
                }
            }
            else
            {
                using (var p = RoundedRectPath(new Rectangle(0, 0, Width, Height), (int)Math.Round(12 * _scale)))
                    Region = new Region(p);
            }
        }
    }
}
