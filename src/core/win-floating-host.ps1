param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Width = 460,
  [int]$Height = 720,
  [int]$PosX = -99999,
  [int]$PosY = -99999,
  [int]$TopMost = 1,
  [string]$Theme = 'light',
  [string]$UserDataDir = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$csharp = @"
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ContextCacheHost {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS {
        public int cxLeftWidth;
        public int cxRightWidth;
        public int cyTopHeight;
        public int cyBottomHeight;
    }

    [ComImport, Guid("4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
        [PreserveSig] int Invoke(int errorCode, [MarshalAs(UnmanagedType.Interface)] ICoreWebView2Environment createdEnvironment);
    }

    [ComImport, Guid("6c4819f3-c9b7-4260-8127-c9f5bde7f68c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
        [PreserveSig] int Invoke(int errorCode, [MarshalAs(UnmanagedType.Interface)] ICoreWebView2Controller createdController);
    }

    [ComImport, Guid("57213f19-00e6-49fa-8e07-898ea01ecbd2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2WebMessageReceivedEventHandler {
        [PreserveSig] int Invoke([MarshalAs(UnmanagedType.Interface)] ICoreWebView2 sender, [MarshalAs(UnmanagedType.Interface)] ICoreWebView2WebMessageReceivedEventArgs args);
    }

    [ComImport, Guid("0f99a40c-e962-4207-9e92-e3d542eff849"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2WebMessageReceivedEventArgs {
        [PreserveSig] int get_Source([MarshalAs(UnmanagedType.LPWStr)] out string source);
        [PreserveSig] int get_WebMessageAsJson([MarshalAs(UnmanagedType.LPWStr)] out string webMessageAsJson);
        [PreserveSig] int TryGetWebMessageAsString([MarshalAs(UnmanagedType.LPWStr)] out string resultAsString);
    }

    [ComImport, Guid("b96d755e-0319-4e92-a296-23436f46a1fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2Environment {
        [PreserveSig] int CreateCoreWebView2Controller(IntPtr parentWindow, [MarshalAs(UnmanagedType.Interface)] ICoreWebView2CreateCoreWebView2ControllerCompletedHandler handler);
    }

    [ComImport, Guid("4d00c0d1-9434-4eb6-8078-8697a560334f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2Controller {
        [PreserveSig] int get_IsVisible(out int isVisible);
        [PreserveSig] int put_IsVisible(int isVisible);
        [PreserveSig] int get_Bounds(out RECT bounds);
        [PreserveSig] int put_Bounds(RECT bounds);
        [PreserveSig] int get_ZoomFactor(out double zoomFactor);
        [PreserveSig] int put_ZoomFactor(double zoomFactor);
        [PreserveSig] int add_ZoomFactorChanged(IntPtr handler, out long token);
        [PreserveSig] int remove_ZoomFactorChanged(long token);
        [PreserveSig] int SetBoundsAndZoomFactor(RECT bounds, double zoomFactor);
        [PreserveSig] int MoveFocus(int reason);
        [PreserveSig] int add_MoveFocusRequested(IntPtr handler, out long token);
        [PreserveSig] int remove_MoveFocusRequested(long token);
        [PreserveSig] int add_GotFocus(IntPtr handler, out long token);
        [PreserveSig] int remove_GotFocus(long token);
        [PreserveSig] int add_LostFocus(IntPtr handler, out long token);
        [PreserveSig] int remove_LostFocus(long token);
        [PreserveSig] int add_AcceleratorKeyPressed(IntPtr handler, out long token);
        [PreserveSig] int remove_AcceleratorKeyPressed(long token);
        [PreserveSig] int get_ParentWindow(out IntPtr parentWindow);
        [PreserveSig] int put_ParentWindow(IntPtr parentWindow);
        [PreserveSig] int NotifyParentWindowPositionChanged();
        [PreserveSig] int Close();
        [PreserveSig] int get_CoreWebView2([MarshalAs(UnmanagedType.Interface)] out ICoreWebView2 coreWebView2);
    }

    [ComImport, Guid("76eceacb-0462-4d94-ac83-423a6793775e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2 {
        [PreserveSig] int get_Settings(out IntPtr settings);
        [PreserveSig] int get_Source([MarshalAs(UnmanagedType.LPWStr)] out string uri);
        [PreserveSig] int Navigate([MarshalAs(UnmanagedType.LPWStr)] string uri);
        [PreserveSig] int NavigateToString([MarshalAs(UnmanagedType.LPWStr)] string htmlContent);
        [PreserveSig] int add_NavigationStarting(IntPtr h, out long t);
        [PreserveSig] int remove_NavigationStarting(long t);
        [PreserveSig] int add_ContentLoading(IntPtr h, out long t);
        [PreserveSig] int remove_ContentLoading(long t);
        [PreserveSig] int add_SourceChanged(IntPtr h, out long t);
        [PreserveSig] int remove_SourceChanged(long t);
        [PreserveSig] int add_HistoryChanged(IntPtr h, out long t);
        [PreserveSig] int remove_HistoryChanged(long t);
        [PreserveSig] int add_NavigationCompleted(IntPtr h, out long t);
        [PreserveSig] int remove_NavigationCompleted(long t);
        [PreserveSig] int add_FrameNavigationStarting(IntPtr h, out long t);
        [PreserveSig] int remove_FrameNavigationStarting(long t);
        [PreserveSig] int add_FrameNavigationCompleted(IntPtr h, out long t);
        [PreserveSig] int remove_FrameNavigationCompleted(long t);
        [PreserveSig] int add_ScriptDialogOpening(IntPtr h, out long t);
        [PreserveSig] int remove_ScriptDialogOpening(long t);
        [PreserveSig] int add_PermissionRequested(IntPtr h, out long t);
        [PreserveSig] int remove_PermissionRequested(long t);
        [PreserveSig] int add_ProcessFailed(IntPtr h, out long t);
        [PreserveSig] int remove_ProcessFailed(long t);
        [PreserveSig] int AddScriptToExecuteOnDocumentCreated([MarshalAs(UnmanagedType.LPWStr)] string js, IntPtr handler);
        [PreserveSig] int RemoveScriptToExecuteOnDocumentCreated([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int ExecuteScript([MarshalAs(UnmanagedType.LPWStr)] string js, IntPtr handler);
        [PreserveSig] int CapturePreview(int fmt, IntPtr stream, IntPtr handler);
        [PreserveSig] int Reload();
        [PreserveSig] int PostWebMessageAsJson([MarshalAs(UnmanagedType.LPWStr)] string json);
        [PreserveSig] int PostWebMessageAsString([MarshalAs(UnmanagedType.LPWStr)] string msg);
        [PreserveSig] int add_WebMessageReceived([MarshalAs(UnmanagedType.Interface)] ICoreWebView2WebMessageReceivedEventHandler handler, out long token);
    }

    public class FloatingForm : Form,
        ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
        ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
        ICoreWebView2WebMessageReceivedEventHandler {

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr LoadLibrary(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        static extern IntPtr GetProcAddress(IntPtr hModule, string procName);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        static extern IntPtr PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out Point lpPoint);
        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
        [DllImport("dwmapi.dll")]
        static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);
        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")]
        static extern uint GetDpiForSystem();
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")]
        static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();

        [StructLayout(LayoutKind.Sequential)]
        public struct NCCALCSIZE_PARAMS {
            public RECT rgrc0;
            public RECT rgrc1;
            public RECT rgrc2;
            public IntPtr lppos;
        }

        [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode)]
        delegate int CreateEnvInternalDel(
            bool checkRunning,
            int runtimeType,
            string userDataFolder,
            IntPtr options,
            [MarshalAs(UnmanagedType.Interface)] ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler handler
        );

        const int WM_NCCALCSIZE = 0x0083;
        const int WM_NCLBUTTONDOWN = 0x00A1;
        const int HTCAPTION = 2;
        const int WS_THICKFRAME = 0x00040000;
        const int WS_MINIMIZEBOX = 0x00020000;
        const int WS_MAXIMIZEBOX = 0x00010000;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_APPWINDOW = 0x00040000;
        const int SM_CXSIZEFRAME = 32;
        const int SM_CYSIZEFRAME = 33;
        const int SM_CXPADDEDBORDER = 92;
        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        const int DWMWCP_ROUND = 2;

        private readonly string _url;
        private readonly string _userDataDir;
        private readonly bool _isDark;
        private readonly int _logicalW;
        private readonly int _logicalH;
        private readonly int _initPosX;
        private readonly int _initPosY;
        private float _dpiScale = 1.0f;
        private int _expandedHeight = 720;
        private bool _collapsed = false;
        private Timer _interactTimer;
        private int _interactMode = 0; // 0=none, 1=drag, 10..17=resize hitTest
        private Point _startCursor;
        private Rectangle _startBounds;
        private ICoreWebView2Controller _controller;
        private ICoreWebView2 _webview;
        private IntPtr _hIcon = IntPtr.Zero;
        private System.Threading.EventWaitHandle _focusEvent;
        private System.Threading.RegisteredWaitHandle _focusWaitHandle;

        public static void EnableDpiAwareness() {
            try {
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
                    SetProcessDPIAware();
                }
            } catch {
                try { SetProcessDPIAware(); } catch {}
            }
        }

        public FloatingForm(string url, int width, int height, int posX, int posY, bool topMost, bool isDark, string userDataDir) {
            _url = url;
            _isDark = isDark;
            _userDataDir = userDataDir;
            _logicalW = Math.Max(360, Math.Min(1600, width));
            _logicalH = Math.Max(460, Math.Min(1200, height));
            _initPosX = posX;
            _initPosY = posY;

            Text = "Context Cache & Telemetry";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            TopMost = topMost;
            ShowInTaskbar = false;
            BackColor = isDark ? Color.FromArgb(19, 21, 25) : Color.FromArgb(247, 248, 250);
            Icon = CreateBrandIcon();

            float scale = 1.0f;
            try {
                uint sysDpi = GetDpiForSystem();
                if (sysDpi >= 96) scale = sysDpi / 96.0f;
            } catch {}
            if (scale <= 1.01f) {
                try {
                    using (var g = Graphics.FromHwnd(IntPtr.Zero)) {
                        scale = Math.Max(1.0f, g.DpiX / 96.0f);
                    }
                } catch {}
            }
            _dpiScale = scale;
            MinimumSize = new Size((int)Math.Round(340 * scale), (int)Math.Round(38 * scale));
            Width = (int)Math.Round(_logicalW * scale);
            Height = (int)Math.Round(_logicalH * scale);
            _expandedHeight = Height;

            // Strictly guarantee 100% of the window starts inside the visible working area
            var wa = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new Rectangle(0, 0, 1440, 900);
            if (Width > wa.Width - 32) Width = Math.Max(360, wa.Width - 32);
            if (Height > wa.Height - 48) Height = Math.Max(460, wa.Height - 48);
            _expandedHeight = Height;

            int minX = wa.Left + 24;
            int maxX = Math.Max(minX, wa.Right - Width - 24);
            int minY = wa.Top + 24;
            int maxY = Math.Max(minY, wa.Bottom - Height - 24);

            if (_initPosX >= minX && _initPosX <= maxX && _initPosY >= minY && _initPosY <= maxY) {
                Location = new Point(_initPosX, _initPosY);
            } else {
                // Default clean top-right inside screen (48px margin from right edge, 56px from top)
                Location = new Point(Math.Max(minX, wa.Right - Width - 48), Math.Min(maxY, wa.Top + 56));
            }

            _interactTimer = new Timer { Interval = 8 };
            _interactTimer.Tick += OnInteractTick;
        }

        private void StartInteraction(int mode) {
            if (WindowState == FormWindowState.Maximized) return;
            Point pt;
            if (!GetCursorPos(out pt)) return;
            _interactMode = mode;
            _startCursor = pt;
            _startBounds = Bounds;
            _interactTimer.Start();
        }

        private void OnInteractTick(object sender, EventArgs e) {
            // Stop immediately as soon as physical left mouse button is released
            if ((GetAsyncKeyState(0x01) & 0x8000) == 0) {
                _interactTimer.Stop();
                _interactMode = 0;
                SyncBounds();
                return;
            }
            Point pt;
            if (!GetCursorPos(out pt)) return;
            int dx = pt.X - _startCursor.X;
            int dy = pt.Y - _startCursor.Y;

            if (_interactMode == 1) {
                var wa = Screen.FromControl(this).WorkingArea;
                int nx = Math.Max(wa.Left + 8, Math.Min(wa.Right - Width - 8, _startBounds.X + dx));
                int ny = Math.Max(wa.Top + 8, Math.Min(wa.Bottom - Math.Min(Height, 80) - 8, _startBounds.Y + dy));
                SetWindowPos(Handle, IntPtr.Zero, nx, ny, 0, 0, 0x0001 | 0x0004 | 0x0010); // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                return;
            }

            if (_interactMode >= 10 && _interactMode <= 17) {
                int minW = MinimumSize.Width;
                int left = _startBounds.Left;
                int top = _startBounds.Top;
                int right = _startBounds.Right;
                int bottom = _startBounds.Bottom;

                // Left edge (10=W, 13=NW, 16=SW)
                if (_interactMode == 10 || _interactMode == 13 || _interactMode == 16) {
                    left = Math.Min(right - minW, left + dx);
                }
                // Right edge (11=E, 14=NE, 17=SE)
                if (_interactMode == 11 || _interactMode == 14 || _interactMode == 17) {
                    right = Math.Max(left + minW, right + dx);
                }

                if (_collapsed) {
                    // Collapsed mini-bar: allow horizontal resize only, keep bar height & _expandedHeight intact
                    if (_interactMode == 12 || _interactMode == 15) return;
                    int nw = Math.Max(minW, right - left);
                    int nh = _startBounds.Height;
                    SetWindowPos(Handle, IntPtr.Zero, left, top, nw, nh, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
                    SyncBounds();
                    return;
                }

                int minH = (int)Math.Round(420 * _dpiScale);
                // Top edge (12=N, 13=NW, 14=NE)
                if (_interactMode == 12 || _interactMode == 13 || _interactMode == 14) {
                    top = Math.Min(bottom - minH, top + dy);
                }
                // Bottom edge (15=S, 16=SW, 17=SE)
                if (_interactMode == 15 || _interactMode == 16 || _interactMode == 17) {
                    bottom = Math.Max(top + minH, bottom + dy);
                }

                int fullW = Math.Max(minW, right - left);
                int fullH = Math.Max(minH, bottom - top);
                _expandedHeight = fullH;
                SetWindowPos(Handle, IntPtr.Zero, left, top, fullW, fullH, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
                SyncBounds();
            }
        }

        private Icon CreateBrandIcon() {
            try {
                using (var bmp = new Bitmap(32, 32))
                using (var g = Graphics.FromImage(bmp)) {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (var bg = new SolidBrush(Color.FromArgb(29, 78, 216)))
                    using (var path = new GraphicsPath()) {
                        int r = 7;
                        path.AddArc(2, 2, r * 2, r * 2, 180, 90);
                        path.AddArc(30 - r * 2, 2, r * 2, r * 2, 270, 90);
                        path.AddArc(30 - r * 2, 30 - r * 2, r * 2, r * 2, 0, 90);
                        path.AddArc(2, 30 - r * 2, r * 2, r * 2, 90, 90);
                        path.CloseFigure();
                        g.FillPath(bg, path);
                    }
                    using (var topBrush = new SolidBrush(Color.White)) {
                        g.FillPolygon(topBrush, new[] { new Point(16, 8), new Point(24, 12), new Point(16, 16), new Point(8, 12) });
                    }
                    using (var midPen = new Pen(Color.FromArgb(147, 197, 253), 2.2f)) {
                        midPen.StartCap = LineCap.Round;
                        midPen.EndCap = LineCap.Round;
                        g.DrawLines(midPen, new[] { new Point(8, 17), new Point(16, 21), new Point(24, 17) });
                    }
                    using (var botPen = new Pen(Color.FromArgb(52, 211, 153), 2.2f)) {
                        botPen.StartCap = LineCap.Round;
                        botPen.EndCap = LineCap.Round;
                        g.DrawLines(botPen, new[] { new Point(8, 22), new Point(16, 26), new Point(24, 22) });
                    }
                    _hIcon = bmp.GetHicon();
                    return Icon.FromHandle(_hIcon);
                }
            } catch {
                return null;
            }
        }

        protected override CreateParams CreateParams {
            get {
                var cp = base.CreateParams;
                // Keep WS_THICKFRAME for native 8-edge resize; use WS_EX_TOOLWINDOW so no PowerShell icon appears in bottom taskbar
                cp.Style |= WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX;
                cp.ExStyle |= WS_EX_TOOLWINDOW;
                cp.ExStyle &= ~WS_EX_APPWINDOW;
                return cp;
            }
        }

        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero) {
                if (WindowState == FormWindowState.Maximized) {
                    var p = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
                    int pad = GetSystemMetrics(SM_CXPADDEDBORDER);
                    int fx = GetSystemMetrics(SM_CXSIZEFRAME) + pad;
                    int fy = GetSystemMetrics(SM_CYSIZEFRAME) + pad;
                    p.rgrc0.Left += fx;
                    p.rgrc0.Top += fy;
                    p.rgrc0.Right -= fx;
                    p.rgrc0.Bottom -= fy;
                    Marshal.StructureToPtr(p, m.LParam, false);
                }
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        private void ApplyDwmChrome() {
            try {
                int corner = DWMWCP_ROUND;
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
                int dark = _isDark ? 1 : 0;
                DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
                var margins = new MARGINS { cxLeftWidth = 0, cxRightWidth = 0, cyTopHeight = 0, cyBottomHeight = 1 };
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            } catch {}
        }

        private void SyncBounds() {
            if (_controller == null) return;
            try {
                _controller.put_Bounds(new RECT {
                    Left = 0,
                    Top = 0,
                    Right = Math.Max(1, ClientSize.Width),
                    Bottom = Math.Max(1, ClientSize.Height)
                });
            } catch {}
        }

        public static void HideHostConsole() {
            try {
                IntPtr con = GetConsoleWindow();
                if (con != IntPtr.Zero) ShowWindow(con, 0);
            } catch {}
        }

        private void EnsureVisibleAndPinned() {
            try {
                ForceBringToFront();
            } catch {}
        }

        private void ForceBringToFront() {
            IntPtr fg = IntPtr.Zero;
            uint fgThread = 0;
            uint curThread = 0;
            bool attached = false;
            try {
                if (WindowState == FormWindowState.Minimized) {
                    WindowState = FormWindowState.Normal;
                    ShowWindow(Handle, 9); // SW_RESTORE
                }
                fg = GetForegroundWindow();
                if (fg != IntPtr.Zero && fg != Handle) {
                    uint pid;
                    fgThread = GetWindowThreadProcessId(fg, out pid);
                    curThread = GetCurrentThreadId();
                    if (fgThread != 0 && fgThread != curThread) {
                        attached = AttachThreadInput(fgThread, curThread, true);
                    }
                }
                bool wantTop = TopMost;
                ShowWindow(Handle, 5); // SW_SHOW (overrides inherited STARTUPINFO SW_HIDE from windowsHide:true)
                TopMost = false;
                TopMost = true;
                SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
                Activate();
                BringToFront();
                SetForegroundWindow(Handle);
                if (!wantTop) {
                    TopMost = false;
                    SetWindowPos(Handle, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
                }
            } catch {}
            finally {
                if (attached && fgThread != 0 && curThread != 0) {
                    try { AttachThreadInput(fgThread, curThread, false); } catch {}
                }
            }
        }

        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            ApplyDwmChrome();
            if (_focusEvent == null) {
                try {
                    string evName = @"Local\ContextCacheFocus_" + Process.GetCurrentProcess().Id;
                    _focusEvent = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, evName);
                    _focusWaitHandle = System.Threading.ThreadPool.RegisterWaitForSingleObject(_focusEvent, (state, timedOut) => {
                        if (!IsDisposed && IsHandleCreated) {
                            try { BeginInvoke((MethodInvoker)delegate { ForceBringToFront(); }); } catch {}
                        }
                    }, null, -1, false);
                } catch {}
            }
        }

        protected override void OnLoad(EventArgs e) {
            base.OnLoad(e);
            ApplyDwmChrome();
            InitWebView();
        }

        private bool _readyEmitted = false;

        protected override void OnShown(EventArgs e) {
            base.OnShown(e);
            EnsureVisibleAndPinned();
            SyncBounds();
            if (!_readyEmitted) {
                _readyEmitted = true;
                try {
                    Console.Out.WriteLine("READY:" + Handle.ToInt64());
                    Console.Out.Flush();
                } catch {}
            }
        }

        protected override void OnResize(EventArgs e) {
            base.OnResize(e);
            int collapsedPx = (int)Math.Round(44 * _dpiScale);
            if (!_collapsed && WindowState == FormWindowState.Normal && Height > collapsedPx) {
                _expandedHeight = Height;
            }
            SyncBounds();
        }

        protected override void OnLocationChanged(EventArgs e) {
            base.OnLocationChanged(e);
            if (_controller != null) {
                try { _controller.NotifyParentWindowPositionChanged(); } catch {}
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e) {
            if (_focusWaitHandle != null) {
                try { _focusWaitHandle.Unregister(null); } catch {}
                _focusWaitHandle = null;
            }
            if (_focusEvent != null) {
                try { _focusEvent.Dispose(); } catch {}
                _focusEvent = null;
            }
            if (_interactTimer != null) {
                try { _interactTimer.Stop(); _interactTimer.Dispose(); } catch {}
                _interactTimer = null;
            }
            if (_controller != null) {
                try { _controller.Close(); } catch {}
                _controller = null;
            }
            if (_hIcon != IntPtr.Zero) {
                try { DestroyIcon(_hIcon); } catch {}
                _hIcon = IntPtr.Zero;
            }
            base.OnFormClosed(e);
        }

        private static string FindEmbeddedWebViewDll() {
            string[] roots = new[] {
                @"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
                @"C:\Program Files\Microsoft\EdgeWebView\Application"
            };
            string arch = Environment.Is64BitProcess ? "x64" : "x86";
            foreach (var root in roots) {
                if (!Directory.Exists(root)) continue;
                var dirs = Directory.GetDirectories(root)
                    .Select(Path.GetFileName)
                    .Where(n => !string.IsNullOrEmpty(n) && char.IsDigit(n[0]))
                    .OrderByDescending(n => n)
                    .ToArray();
                foreach (var ver in dirs) {
                    string dll = Path.Combine(root, ver, "EBWebView", arch, "EmbeddedBrowserWebView.dll");
                    if (File.Exists(dll)) return dll;
                }
            }
            return null;
        }

        private void FailAndClose(string reason) {
            try {
                Console.Error.WriteLine("HOST_ERR:" + reason);
                Console.Error.Flush();
            } catch {}
            Environment.ExitCode = 1;
            if (!IsDisposed) {
                if (IsHandleCreated) {
                    try { BeginInvoke((MethodInvoker)delegate { if (!IsDisposed) Close(); }); } catch {}
                } else {
                    try { Close(); } catch {}
                }
            }
        }

        private void InitWebView() {
            try {
                string dllPath = FindEmbeddedWebViewDll();
                if (string.IsNullOrEmpty(dllPath)) {
                    FailAndClose("EmbeddedBrowserWebView.dll not found");
                    return;
                }
                IntPtr hMod = LoadLibrary(dllPath);
                if (hMod == IntPtr.Zero) { FailAndClose("LoadLibrary failed"); return; }
                IntPtr proc = GetProcAddress(hMod, "CreateWebViewEnvironmentWithOptionsInternal");
                if (proc == IntPtr.Zero) { FailAndClose("CreateWebViewEnvironmentWithOptionsInternal missing"); return; }

                var createEnv = Marshal.GetDelegateForFunctionPointer<CreateEnvInternalDel>(proc);
                string udf = string.IsNullOrWhiteSpace(_userDataDir)
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".context-cache", "runtime", "webview2")
                    : _userDataDir;
                Directory.CreateDirectory(udf);
                int hr = createEnv(true, 0, udf, IntPtr.Zero, this);
                if (hr != 0) FailAndClose("createEnv hr=0x" + hr.ToString("X8"));
            } catch (Exception ex) {
                FailAndClose("InitWebView exception: " + ex.Message);
            }
        }

        public int Invoke(int errorCode, ICoreWebView2Environment env) {
            if (errorCode != 0 || env == null || IsDisposed) {
                if (!IsDisposed) FailAndClose("env error=0x" + errorCode.ToString("X8"));
                return 0;
            }
            env.CreateCoreWebView2Controller(Handle, this);
            return 0;
        }

        public int Invoke(int errorCode, ICoreWebView2Controller controller) {
            if (errorCode != 0 || controller == null || IsDisposed) {
                if (!IsDisposed) FailAndClose("controller error=0x" + errorCode.ToString("X8"));
                return 0;
            }
            _controller = controller;
            SyncBounds();
            _controller.put_IsVisible(1);
            _controller.get_CoreWebView2(out _webview);
            if (_webview != null) {
                long token;
                _webview.add_WebMessageReceived(this, out token);
                _webview.Navigate(_url);
            }
            EnsureVisibleAndPinned();
            return 0;
        }

        public int Invoke(ICoreWebView2 sender, ICoreWebView2WebMessageReceivedEventArgs args) {
            if (IsDisposed) return 0;
            string msg = null;
            try { args.TryGetWebMessageAsString(out msg); } catch {}
            if (string.IsNullOrEmpty(msg)) return 0;

            if (msg == "drag") {
                StartInteraction(1);
            } else if (msg.StartsWith("resize:")) {
                int ht;
                if (int.TryParse(msg.Substring(7), out ht) && ht >= 10 && ht <= 17) {
                    StartInteraction(ht);
                }
            } else if (msg == "pin:1") {
                TopMost = true;
                SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002);
            } else if (msg == "pin:0") {
                TopMost = false;
                SetWindowPos(Handle, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002);
            } else if (msg == "min" || msg == "collapse:toggle") {
                if (WindowState == FormWindowState.Maximized) {
                    WindowState = FormWindowState.Normal;
                }
                int barH = (int)Math.Round(40 * _dpiScale);
                if (!_collapsed) {
                    if (Height > barH + 20) _expandedHeight = Height;
                    _collapsed = true;
                    Height = barH;
                } else {
                    _collapsed = false;
                    Height = Math.Max((int)Math.Round(460 * _dpiScale), _expandedHeight);
                }
                SyncBounds();
            } else if (msg == "collapse:1" || msg.StartsWith("collapse:1:")) {
                int defaultBarH = (int)Math.Round(40 * _dpiScale);
                int barH = defaultBarH;
                if (msg.Length > 11) {
                    int customH;
                    if (int.TryParse(msg.Substring(11), out customH)) {
                        barH = Math.Max(defaultBarH, Math.Min((int)Math.Round(120 * _dpiScale), customH));
                    }
                }
                if (!_collapsed) {
                    if (Height > barH + 20) _expandedHeight = Height;
                    _collapsed = true;
                    Height = barH;
                    SyncBounds();
                } else if (Height != barH) {
                    Height = barH;
                    SyncBounds();
                }
            } else if (msg == "collapse:0") {
                if (_collapsed) {
                    _collapsed = false;
                    Height = Math.Max((int)Math.Round(460 * _dpiScale), _expandedHeight);
                    SyncBounds();
                }
            } else if (msg == "minimize") {
                WindowState = FormWindowState.Minimized;
            } else if (msg == "max") {
                if (_collapsed) {
                    _collapsed = false;
                    Height = Math.Max((int)Math.Round(460 * _dpiScale), _expandedHeight);
                } else {
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                }
                SyncBounds();
            } else if (msg == "close") {
                Close();
            } else if (msg == "theme:dark") {
                BackColor = Color.FromArgb(19, 21, 25);
                int dark = 1;
                try { DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int)); } catch {}
            } else if (msg == "theme:light") {
                BackColor = Color.FromArgb(247, 248, 250);
                int dark = 0;
                try { DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int)); } catch {}
            }
            return 0;
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Core
[ContextCacheHost.FloatingForm]::HideHostConsole()
[ContextCacheHost.FloatingForm]::EnableDpiAwareness()
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$isDark = ($Theme -eq 'dark')
$isTopMost = ($TopMost -ne 0)
$form = New-Object ContextCacheHost.FloatingForm($Url, $Width, $Height, $PosX, $PosY, $isTopMost, $isDark, $UserDataDir)
$form.Show()
[System.Windows.Forms.Application]::Run($form)
