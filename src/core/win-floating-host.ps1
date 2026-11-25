param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Width = 460,
  [int]$Height = 720,
  [int]$PosX = -99999,
  [int]$PosY = -99999,
  [int]$TopMost = 1,
  [string]$Theme = 'light',
  [string]$UserDataDir = '',
  [string]$Mode = 'console',
  [int]$OrbX = -99999,
  [int]$OrbY = -99999
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$csharp = @"
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ContextCacheHost {
    public enum WindowMode {
        Console = 0,
        MiniBar = 1,
        Orb = 2
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT_WIN32 {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MINMAXINFO {
        public POINT_WIN32 ptReserved;
        public POINT_WIN32 ptMaxSize;
        public POINT_WIN32 ptMaxPosition;
        public POINT_WIN32 ptMinTrackSize;
        public POINT_WIN32 ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS {
        public int cxLeftWidth;
        public int cxRightWidth;
        public int cyTopHeight;
        public int cyBottomHeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct COREWEBVIEW2_COLOR {
        public byte A;
        public byte R;
        public byte G;
        public byte B;
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

    [ComImport, Guid("c979903e-d4ca-4228-92eb-47ee3fa96eab"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICoreWebView2Controller2 {
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
        [PreserveSig] int get_DefaultBackgroundColor(out COREWEBVIEW2_COLOR backgroundColor);
        [PreserveSig] int put_DefaultBackgroundColor(COREWEBVIEW2_COLOR backgroundColor);
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

    internal sealed class OrbMenuColorTable : ProfessionalColorTable {
        private readonly bool _dark;
        public OrbMenuColorTable(bool dark) { _dark = dark; }
        public override Color ToolStripDropDownBackground { get { return _dark ? Color.FromArgb(24, 25, 27) : Color.FromArgb(252, 252, 253); } }
        public override Color MenuBorder { get { return _dark ? Color.FromArgb(54, 58, 63) : Color.FromArgb(217, 217, 224); } }
        public override Color MenuItemBorder { get { return _dark ? Color.FromArgb(54, 58, 63) : Color.FromArgb(217, 217, 224); } }
        public override Color MenuItemSelected { get { return _dark ? Color.FromArgb(39, 42, 45) : Color.FromArgb(240, 240, 243); } }
        public override Color MenuItemSelectedGradientBegin { get { return MenuItemSelected; } }
        public override Color MenuItemSelectedGradientEnd { get { return MenuItemSelected; } }
        public override Color ImageMarginGradientBegin { get { return ToolStripDropDownBackground; } }
        public override Color ImageMarginGradientMiddle { get { return ToolStripDropDownBackground; } }
        public override Color ImageMarginGradientEnd { get { return ToolStripDropDownBackground; } }
        public override Color SeparatorDark { get { return _dark ? Color.FromArgb(46, 49, 53) : Color.FromArgb(224, 225, 230); } }
        public override Color SeparatorLight { get { return ToolStripDropDownBackground; } }
    }

    internal sealed class OrbMenuRenderer : ToolStripProfessionalRenderer {
        private readonly bool _dark;
        public OrbMenuRenderer(bool dark) : base(new OrbMenuColorTable(dark)) {
            _dark = dark;
            RoundedEdges = false;
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
            e.TextColor = _dark ? Color.FromArgb(237, 238, 240) : Color.FromArgb(28, 32, 36);
            base.OnRenderItemText(e);
        }
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) {
            Rectangle r = e.ImageRectangle;
            using (var bg = new SolidBrush(_dark ? Color.FromArgb(13, 40, 71) : Color.FromArgb(230, 244, 254)))
            using (var pen = new Pen(_dark ? Color.FromArgb(112, 184, 255) : Color.FromArgb(13, 116, 206), 1.8f)) {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.FillRectangle(bg, r);
                e.Graphics.DrawLines(pen, new[] {
                    new Point(r.Left + 3, r.Top + r.Height / 2),
                    new Point(r.Left + r.Width / 2 - 1, r.Bottom - 4),
                    new Point(r.Right - 3, r.Top + 4)
                });
            }
        }
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
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        static extern IntPtr WindowFromPoint(Point p);
        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
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
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr hIcon);
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
        [DllImport("user32.dll")]
        static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateEllipticRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect);
        [DllImport("gdi32.dll")]
        static extern bool DeleteObject(IntPtr hObject);
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
        [DllImport("dwmapi.dll")]
        static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

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

        const int WM_CANCELMODE = 0x001F;
        const int WM_GETMINMAXINFO = 0x0024;
        const int WM_NCCALCSIZE = 0x0083;
        const int WM_NCLBUTTONDOWN = 0x00A1;
        const int WM_SYSCOMMAND = 0x0112;
        const int WM_ENTERSIZEMOVE = 0x0231;
        const int WM_EXITSIZEMOVE = 0x0232;
        const int WM_DPICHANGED = 0x02E0;
        const int SC_MINIMIZE = 0xF020;

        const int HTCAPTION = 2;
        const int HTLEFT = 10;
        const int HTRIGHT = 11;
        const int HTTOPLEFT = 13;
        const int HTTOPRIGHT = 14;
        const int HTBOTTOMLEFT = 16;
        const int HTBOTTOMRIGHT = 17;

        const int WS_THICKFRAME = 0x00040000;
        const int WS_MINIMIZEBOX = 0x00020000;
        const int WS_MAXIMIZEBOX = 0x00010000;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_APPWINDOW = 0x00040000;

        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOZORDER = 0x0004;
        const uint SWP_NOACTIVATE = 0x0010;
        const uint SWP_SHOWWINDOW = 0x0040;

        const int SM_CXSIZEFRAME = 32;
        const int SM_CYSIZEFRAME = 33;
        const int SM_CXPADDEDBORDER = 92;

        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        const int DWMWCP_DONOTROUND = 1;
        const int DWMWCP_ROUND = 2;

        const int MIN_SHARED_LOGICAL_WIDTH = 360;
        const int MAX_SHARED_LOGICAL_WIDTH = 1600;
        const int MIN_CONSOLE_LOGICAL_HEIGHT = 460;
        const int DEFAULT_MINIBAR_LOGICAL_HEIGHT = 40;
        const int ORB_LOGICAL_PX = 48;

        private readonly string _url;
        private readonly string _userDataDir;
        private bool _isDark;
        private readonly int _logicalW;
        private readonly int _logicalH;
        private readonly int _initPosX;
        private readonly int _initPosY;
        private readonly WindowMode _initialMode;

        private float _dpiScale = 1.0f;
        private WindowMode _windowMode = WindowMode.Console;
        private int _sharedWidth = 460;
        private int _expandedHeight = 720;
        private int _miniBarLogicalHeight = DEFAULT_MINIBAR_LOGICAL_HEIGHT;
        private Point _savedConsoleLocation;
        private bool _hasSavedConsoleLocation = false;
        private Point _orbLocation;
        private bool _hasOrbLocation = false;
        private bool _inModeTransition = false;
        private bool _inSizeMove = false;

        private RECT _lastSyncedRect;
        private bool _hasSyncedRect = false;
        private ICoreWebView2Controller _controller;
        private ICoreWebView2 _webview;
        private IntPtr _hIcon = IntPtr.Zero;
        private System.Threading.EventWaitHandle _focusEvent;
        private System.Threading.RegisteredWaitHandle _focusWaitHandle;
        private ContextMenuStrip _orbMenu;
        private ToolStripMenuItem _orbMenuPinItem;
        private ToolTip _orbToolTip;
        private string _orbTipText = "";
        private Timer _closeFallbackTimer;

        public static void EnableDpiAwareness() {
            try {
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
                    SetProcessDPIAware();
                }
            } catch {
                try { SetProcessDPIAware(); } catch {}
            }
        }

        public static void HideHostConsole() {
            try {
                IntPtr con = GetConsoleWindow();
                if (con != IntPtr.Zero) ShowWindow(con, 0);
            } catch {}
        }

        public FloatingForm(string url, int width, int height, int posX, int posY, bool topMost, bool isDark, string userDataDir)
            : this(url, width, height, posX, posY, topMost, isDark, userDataDir, "console", -99999, -99999) {
        }

        public FloatingForm(string url, int width, int height, int posX, int posY, bool topMost, bool isDark, string userDataDir, string initialMode, int orbX, int orbY) {
            _url = url;
            _isDark = isDark;
            _userDataDir = userDataDir;
            _logicalW = Math.Max(MIN_SHARED_LOGICAL_WIDTH, Math.Min(MAX_SHARED_LOGICAL_WIDTH, width));
            _logicalH = Math.Max(MIN_CONSOLE_LOGICAL_HEIGHT, Math.Min(1200, height));
            _initPosX = posX;
            _initPosY = posY;
            _initialMode = ParseWindowMode(initialMode);

            if (orbX > -90000 && orbY > -90000) {
                _orbLocation = new Point(orbX, orbY);
                _hasOrbLocation = true;
            }

            Text = "Context Cache & Telemetry";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            TopMost = topMost;
            ShowInTaskbar = false;
            MinimumSize = Size.Empty;
            BackColor = GetThemeBackColor(_isDark);
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

            int initW = (int)Math.Round(_logicalW * scale);
            int initH = (int)Math.Round(_logicalH * scale);

            Rectangle wa = ResolveInitialWorkingArea(posX, posY, initW, initH);
            if (initW > wa.Width - 32) initW = Math.Max(MinSharedWidthPx(), wa.Width - 32);
            if (initH > wa.Height - 48) initH = Math.Max(MinConsoleHeightPx(), wa.Height - 48);

            _sharedWidth = Math.Max(MinSharedWidthPx(), initW);
            _expandedHeight = Math.Max(MinConsoleHeightPx(), initH);

            Width = _sharedWidth;
            Height = _expandedHeight;

            if (_initPosX > -90000 && _initPosY > -90000) {
                Point clamped = ClampToWorkingArea(_initPosX, _initPosY, Width, Height);
                Location = clamped;
            } else {
                int minX = wa.Left + 24;
                int maxY = Math.Max(wa.Top + 24, wa.Bottom - Height - 24);
                Location = new Point(Math.Max(minX, wa.Right - Width - 48), Math.Min(maxY, wa.Top + 56));
            }
            _savedConsoleLocation = Location;
            _hasSavedConsoleLocation = true;

            _orbToolTip = new ToolTip {
                AutomaticDelay = 250,
                AutoPopDelay = 5000,
                InitialDelay = 250,
                ReshowDelay = 120,
                ShowAlways = true
            };
        }

        private static WindowMode ParseWindowMode(string mode) {
            if (string.IsNullOrEmpty(mode)) return WindowMode.Console;
            string m = mode.Trim().ToLowerInvariant();
            if (m == "minibar") return WindowMode.MiniBar;
            if (m == "orb") return WindowMode.Orb;
            return WindowMode.Console;
        }

        private static Color GetThemeBackColor(bool dark) {
            return dark ? Color.FromArgb(17, 17, 19) : Color.FromArgb(249, 249, 251);
        }

        private static COREWEBVIEW2_COLOR GetWebViewThemeColor(bool dark) {
            if (dark) {
                return new COREWEBVIEW2_COLOR { A = 255, R = 17, G = 17, B = 19 };
            }
            return new COREWEBVIEW2_COLOR { A = 255, R = 249, G = 249, B = 251 };
        }

        private int MinSharedWidthPx() {
            return Math.Max(240, (int)Math.Round(MIN_SHARED_LOGICAL_WIDTH * _dpiScale));
        }

        private int MinConsoleHeightPx() {
            return Math.Max(320, (int)Math.Round(MIN_CONSOLE_LOGICAL_HEIGHT * _dpiScale));
        }

        private int OrbPx() {
            return Math.Max(32, (int)Math.Round(ORB_LOGICAL_PX * _dpiScale));
        }

        private int MiniBarHeightPx() {
            return Math.Max(28, (int)Math.Round(_miniBarLogicalHeight * _dpiScale));
        }

        private static Rectangle ResolveInitialWorkingArea(int posX, int posY, int w, int h) {
            try {
                if (posX > -90000 && posY > -90000) {
                    Rectangle r = Screen.FromPoint(new Point(posX + w / 2, posY + h / 2)).WorkingArea;
                    if (r.Width > 0 && r.Height > 0) return r;
                }
            } catch {}
            return Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new Rectangle(0, 0, 1440, 900);
        }

        private Rectangle GetCurrentWorkingArea() {
            try {
                Screen s = IsHandleCreated ? Screen.FromHandle(Handle) : Screen.FromControl(this);
                if (s != null && s.WorkingArea.Width > 0 && s.WorkingArea.Height > 0) {
                    return s.WorkingArea;
                }
            } catch {}
            return Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new Rectangle(0, 0, 1440, 900);
        }

        private Point ClampToWorkingArea(int x, int y, int w, int h) {
            Rectangle wa;
            try {
                wa = Screen.FromPoint(new Point(x + w / 2, y + h / 2)).WorkingArea;
            } catch {
                wa = GetCurrentWorkingArea();
            }
            if (wa.Width <= 0 || wa.Height <= 0) {
                wa = new Rectangle(0, 0, 1440, 900);
            }
            int margin = _windowMode == WindowMode.Orb ? 8 : 12;
            int minX = wa.Left + margin;
            int maxX = Math.Max(minX, wa.Right - w - margin);
            int minY = wa.Top + margin;
            int maxY = Math.Max(minY, wa.Bottom - h - margin);
            int cx = Math.Max(minX, Math.Min(maxX, x));
            int cy = Math.Max(minY, Math.Min(maxY, y));
            return new Point(cx, cy);
        }

        private static IntPtr MakePointsLParam(Point pt) {
            int xy = unchecked((int)((pt.X & 0xFFFF) | ((pt.Y & 0xFFFF) << 16)));
            return new IntPtr(xy);
        }

        private void BeginNativeNcInteraction(int hitTest) {
            if (WindowState == FormWindowState.Maximized && hitTest != HTCAPTION) return;
            if (_windowMode == WindowMode.Orb && hitTest != HTCAPTION) return;
            if (_windowMode == WindowMode.MiniBar && hitTest != HTCAPTION) {
                if (hitTest == HTTOPLEFT || hitTest == HTBOTTOMLEFT) hitTest = HTLEFT;
                else if (hitTest == HTTOPRIGHT || hitTest == HTBOTTOMRIGHT) hitTest = HTRIGHT;
                else if (hitTest != HTLEFT && hitTest != HTRIGHT) return;
            }

            int finalHitTest = hitTest;
            BeginInvoke((MethodInvoker)delegate {
                if (IsDisposed || !IsHandleCreated) return;
                Point pt;
                if (!GetCursorPos(out pt)) return;
                IntPtr child = WindowFromPoint(pt);
                if (child != IntPtr.Zero && child != Handle) {
                    uint pid;
                    uint childTid = GetWindowThreadProcessId(child, out pid);
                    uint curTid = GetCurrentThreadId();
                    if (childTid != 0 && childTid != curTid) {
                        AttachThreadInput(curTid, childTid, true);
                        ReleaseCapture();
                        AttachThreadInput(curTid, childTid, false);
                    } else {
                        ReleaseCapture();
                    }
                    SendMessage(child, WM_CANCELMODE, IntPtr.Zero, IntPtr.Zero);
                } else {
                    ReleaseCapture();
                }
                PostMessage(Handle, WM_NCLBUTTONDOWN, new IntPtr(finalHitTest), MakePointsLParam(pt));
            });
        }

        private Icon CreateBrandIcon() {
            try {
                using (var bmp = new Bitmap(32, 32))
                using (var g = Graphics.FromImage(bmp)) {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.Clear(Color.Transparent);

                    // Antigravity Core Prism: crisp rounded blue tile + floating prism diamond + single upward energy wing
                    using (var bgBrush = new LinearGradientBrush(
                        new Rectangle(2, 2, 28, 28),
                        Color.FromArgb(0, 144, 255),
                        Color.FromArgb(13, 116, 206),
                        45f))
                    using (var borderPen = new Pen(Color.FromArgb(110, 172, 216, 252), 1.0f))
                    using (var path = new GraphicsPath()) {
                        int r = 7;
                        path.AddArc(2, 2, r * 2, r * 2, 180, 90);
                        path.AddArc(30 - r * 2, 2, r * 2, r * 2, 270, 90);
                        path.AddArc(30 - r * 2, 30 - r * 2, r * 2, r * 2, 0, 90);
                        path.AddArc(2, 30 - r * 2, r * 2, r * 2, 90, 90);
                        path.CloseFigure();
                        g.FillPath(bgBrush, path);
                        g.DrawPath(borderPen, path);
                    }

                    // Upper floating diamond core
                    PointF[] diamond = new[] {
                        new PointF(16f, 6.2f),
                        new PointF(22.6f, 12.6f),
                        new PointF(16f, 18.6f),
                        new PointF(9.4f, 12.6f)
                    };
                    using (var coreBrush = new SolidBrush(Color.White)) {
                        g.FillPolygon(coreBrush, diamond);
                    }

                    // Subtle lower prism facet for depth
                    PointF[] lowerFacet = new[] {
                        new PointF(9.4f, 12.6f),
                        new PointF(16f, 18.6f),
                        new PointF(22.6f, 12.6f),
                        new PointF(16f, 14.2f)
                    };
                    using (var facetBrush = new SolidBrush(Color.FromArgb(56, 13, 116, 206))) {
                        g.FillPolygon(facetBrush, lowerFacet);
                    }

                    // Single clean upward-cradling energy chevron wing
                    using (var wingPen = new Pen(Color.FromArgb(235, 244, 255), 2.7f)) {
                        wingPen.StartCap = LineCap.Round;
                        wingPen.EndCap = LineCap.Round;
                        wingPen.LineJoin = LineJoin.Round;
                        g.DrawLines(wingPen, new[] {
                            new PointF(7.2f, 18.4f),
                            new PointF(16f, 25.0f),
                            new PointF(24.8f, 18.4f)
                        });
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
                // Keep WS_THICKFRAME & WS_MAXIMIZEBOX; explicitly strip WS_MINIMIZEBOX so Windows never minimizes into bottom-left ghost titlebar
                cp.Style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
                cp.Style &= ~WS_MINIMIZEBOX;
                cp.ExStyle |= WS_EX_TOOLWINDOW;
                cp.ExStyle &= ~WS_EX_APPWINDOW;
                return cp;
            }
        }

        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_SYSCOMMAND) {
                int cmd = (int)(m.WParam.ToInt64() & 0xFFF0);
                if (cmd == SC_MINIMIZE) {
                    EnterOrbMode();
                    m.Result = IntPtr.Zero;
                    return;
                }
            }

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

            if (m.Msg == WM_GETMINMAXINFO) {
                base.WndProc(ref m);
                try {
                    var mmi = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO));
                    Rectangle wa = GetCurrentWorkingArea();
                    if (_windowMode == WindowMode.Orb) {
                        int orbPx = OrbPx();
                        mmi.ptMinTrackSize.X = orbPx;
                        mmi.ptMinTrackSize.Y = orbPx;
                        mmi.ptMaxTrackSize.X = orbPx;
                        mmi.ptMaxTrackSize.Y = orbPx;
                    } else if (_windowMode == WindowMode.MiniBar) {
                        int minW = MinSharedWidthPx();
                        int maxW = Math.Max(minW, wa.Width - 24);
                        int barH = MiniBarHeightPx();
                        mmi.ptMinTrackSize.X = minW;
                        mmi.ptMinTrackSize.Y = barH;
                        mmi.ptMaxTrackSize.X = maxW;
                        mmi.ptMaxTrackSize.Y = barH;
                    } else {
                        int minW = MinSharedWidthPx();
                        int minH = MinConsoleHeightPx();
                        mmi.ptMinTrackSize.X = minW;
                        mmi.ptMinTrackSize.Y = minH;
                        mmi.ptMaxTrackSize.X = Math.Max(minW, wa.Width);
                        mmi.ptMaxTrackSize.Y = Math.Max(minH, wa.Height);
                    }
                    Marshal.StructureToPtr(mmi, m.LParam, true);
                    m.Result = IntPtr.Zero;
                    return;
                } catch {}
            }

            if (m.Msg == WM_DPICHANGED) {
                try {
                    long wp = m.WParam.ToInt64();
                    int newDpi = (int)((wp >> 16) & 0xFFFF);
                    if (newDpi < 72) newDpi = (int)(wp & 0xFFFF);
                    if (newDpi >= 72) {
                        float oldScale = _dpiScale > 0.1f ? _dpiScale : 1.0f;
                        float newScale = newDpi / 96.0f;
                        float ratio = newScale / oldScale;
                        _dpiScale = newScale;

                        _sharedWidth = Math.Max(MinSharedWidthPx(), (int)Math.Round(_sharedWidth * ratio));
                        _expandedHeight = Math.Max(MinConsoleHeightPx(), (int)Math.Round(_expandedHeight * ratio));

                        var suggested = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
                        int targetW;
                        int targetH;
                        if (_windowMode == WindowMode.Orb) {
                            int orbPx = OrbPx();
                            targetW = orbPx;
                            targetH = orbPx;
                        } else if (_windowMode == WindowMode.MiniBar) {
                            targetW = Math.Max(MinSharedWidthPx(), suggested.Right - suggested.Left);
                            targetH = MiniBarHeightPx();
                            _sharedWidth = targetW;
                        } else {
                            targetW = Math.Max(MinSharedWidthPx(), suggested.Right - suggested.Left);
                            targetH = Math.Max(MinConsoleHeightPx(), suggested.Bottom - suggested.Top);
                            _sharedWidth = targetW;
                            _expandedHeight = targetH;
                        }

                        _inModeTransition = true;
                        SetWindowPos(Handle, IntPtr.Zero, suggested.Left, suggested.Top, targetW, targetH, SWP_NOZORDER | SWP_NOACTIVATE);
                        if (_windowMode == WindowMode.Orb) {
                            ApplyOrbRegion(targetW, targetH);
                        }
                        _inModeTransition = false;
                        SyncBounds();
                        PostJsonToWebView(string.Format(
                            CultureInfo.InvariantCulture,
                            "{{\"type\":\"host:dpi\",\"dpiScale\":{0:0.###}}}",
                            _dpiScale
                        ));
                        EmitHostState();
                    }
                    m.Result = IntPtr.Zero;
                    return;
                } catch {
                    _inModeTransition = false;
                }
            }

            if (m.Msg == WM_ENTERSIZEMOVE) {
                _inSizeMove = true;
                PostJsonToWebView("{\"type\":\"host:sizemove\",\"active\":true}");
                base.WndProc(ref m);
                return;
            }

            if (m.Msg == WM_EXITSIZEMOVE) {
                _inSizeMove = false;
                if (_windowMode == WindowMode.Orb) {
                    _orbLocation = Location;
                    _hasOrbLocation = true;
                } else if (_windowMode == WindowMode.MiniBar) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    _savedConsoleLocation = Location;
                    _hasSavedConsoleLocation = true;
                } else if (WindowState == FormWindowState.Normal) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    if (Height >= MinConsoleHeightPx()) _expandedHeight = Height;
                    _savedConsoleLocation = Location;
                    _hasSavedConsoleLocation = true;
                }
                SyncBounds();
                EmitSizeMoveEnd();
                base.WndProc(ref m);
                return;
            }

            base.WndProc(ref m);
        }

        private void ApplyDwmChrome() {
            try {
                int corner = _windowMode == WindowMode.Orb ? DWMWCP_DONOTROUND : DWMWCP_ROUND;
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
                int dark = _isDark ? 1 : 0;
                DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
                var margins = new MARGINS { cxLeftWidth = 0, cxRightWidth = 0, cyTopHeight = 0, cyBottomHeight = 1 };
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            } catch {}
        }

        private void ApplyWebViewBackgroundColor() {
            if (_controller == null) return;
            try {
                ICoreWebView2Controller2 ctrl2 = _controller as ICoreWebView2Controller2;
                if (ctrl2 != null) {
                    ctrl2.put_DefaultBackgroundColor(GetWebViewThemeColor(_isDark));
                }
            } catch {}
        }

        private void ApplyOrbRegion(int w, int h) {
            if (!IsHandleCreated) return;
            IntPtr rgn = CreateEllipticRgn(0, 0, w + 1, h + 1);
            if (rgn != IntPtr.Zero) {
                int res = SetWindowRgn(Handle, rgn, true);
                if (res == 0) {
                    DeleteObject(rgn);
                }
            }
        }

        private void ClearWindowRegion() {
            if (!IsHandleCreated) return;
            try { SetWindowRgn(Handle, IntPtr.Zero, true); } catch {}
        }

        private void SyncBounds() {
            if (_controller == null) return;
            int w = Math.Max(1, ClientSize.Width);
            int h = Math.Max(1, ClientSize.Height);
            if (_hasSyncedRect && _lastSyncedRect.Right == w && _lastSyncedRect.Bottom == h) {
                return;
            }
            try {
                var rect = new RECT {
                    Left = 0,
                    Top = 0,
                    Right = w,
                    Bottom = h
                };
                _controller.put_Bounds(rect);
                _lastSyncedRect = rect;
                _hasSyncedRect = true;
            } catch {}
        }

        private string ModeName() {
            if (_windowMode == WindowMode.Orb) return "orb";
            if (_windowMode == WindowMode.MiniBar) return "minibar";
            return "console";
        }

        private void PostJsonToWebView(string json) {
            if (_webview == null || IsDisposed) return;
            try {
                _webview.PostWebMessageAsJson(json);
            } catch {}
        }

        private void EmitHostState() {
            int logicalW = Math.Max(1, (int)Math.Round(Width / _dpiScale));
            int logicalH = Math.Max(1, (int)Math.Round(Height / _dpiScale));
            string json = string.Format(
                CultureInfo.InvariantCulture,
                "{{\"type\":\"host:state\",\"mode\":\"{0}\",\"pinned\":{1},\"maximized\":{2},\"dpiScale\":{3:0.###},\"logicalWidth\":{4},\"logicalHeight\":{5},\"x\":{6},\"y\":{7}}}",
                ModeName(),
                TopMost ? "true" : "false",
                WindowState == FormWindowState.Maximized ? "true" : "false",
                _dpiScale,
                logicalW,
                logicalH,
                Left,
                Top
            );
            PostJsonToWebView(json);
        }

        private void EmitSizeMoveEnd() {
            int logicalW = Math.Max(1, (int)Math.Round(Width / _dpiScale));
            int logicalH = Math.Max(1, (int)Math.Round(Height / _dpiScale));
            string orbXJson = _hasOrbLocation ? _orbLocation.X.ToString(CultureInfo.InvariantCulture) : "null";
            string orbYJson = _hasOrbLocation ? _orbLocation.Y.ToString(CultureInfo.InvariantCulture) : "null";
            string json = string.Format(
                CultureInfo.InvariantCulture,
                "{{\"type\":\"host:sizemove\",\"active\":false,\"mode\":\"{0}\",\"logicalWidth\":{1},\"logicalHeight\":{2},\"x\":{3},\"y\":{4},\"orbX\":{5},\"orbY\":{6}}}",
                ModeName(),
                logicalW,
                logicalH,
                Left,
                Top,
                orbXJson,
                orbYJson
            );
            PostJsonToWebView(json);
        }

        private void EnterOrbMode() {
            if (_windowMode == WindowMode.Orb) {
                EmitHostState();
                return;
            }
            _inModeTransition = true;
            try {
                if (_windowMode == WindowMode.Console && WindowState == FormWindowState.Normal) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    if (Height >= MinConsoleHeightPx()) _expandedHeight = Height;
                    _savedConsoleLocation = Location;
                    _hasSavedConsoleLocation = true;
                } else if (_windowMode == WindowMode.MiniBar) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    _savedConsoleLocation = Location;
                    _hasSavedConsoleLocation = true;
                }

                if (WindowState == FormWindowState.Maximized) {
                    WindowState = FormWindowState.Normal;
                }

                int orbPx = OrbPx();
                int targetX = _hasOrbLocation ? _orbLocation.X : (Right - orbPx - 8);
                int targetY = _hasOrbLocation ? _orbLocation.Y : (Top + 8);

                _windowMode = WindowMode.Orb;
                Point clamped = ClampToWorkingArea(targetX, targetY, orbPx, orbPx);

                int corner = DWMWCP_DONOTROUND;
                try { DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int)); } catch {}

                SetWindowPos(Handle, IntPtr.Zero, clamped.X, clamped.Y, orbPx, orbPx, SWP_NOZORDER | SWP_NOACTIVATE);
                ApplyOrbRegion(orbPx, orbPx);
                _orbLocation = clamped;
                _hasOrbLocation = true;
            } finally {
                _inModeTransition = false;
            }
            SyncBounds();
            EmitHostState();
        }

        private void EnterMiniBarMode(int logicalHeight) {
            if (logicalHeight > 0) {
                _miniBarLogicalHeight = Math.Max(36, Math.Min(120, logicalHeight));
            }
            _inModeTransition = true;
            try {
                bool leavingOrb = (_windowMode == WindowMode.Orb);
                if (leavingOrb) {
                    _orbLocation = Location;
                    _hasOrbLocation = true;
                } else if (_windowMode == WindowMode.Console && WindowState == FormWindowState.Normal) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    if (Height >= MinConsoleHeightPx()) _expandedHeight = Height;
                    _savedConsoleLocation = Location;
                    _hasSavedConsoleLocation = true;
                }

                if (WindowState == FormWindowState.Maximized) {
                    WindowState = FormWindowState.Normal;
                }

                _windowMode = WindowMode.MiniBar;
                if (leavingOrb) {
                    ClearWindowRegion();
                    int corner = DWMWCP_ROUND;
                    try { DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int)); } catch {}
                }

                Rectangle wa = GetCurrentWorkingArea();
                int minW = MinSharedWidthPx();
                int maxW = Math.Max(minW, wa.Width - 24);
                int targetW = Math.Max(minW, Math.Min(maxW, _sharedWidth));
                _sharedWidth = targetW;
                int targetH = MiniBarHeightPx();

                int baseX;
                int baseY;
                if (leavingOrb && _hasSavedConsoleLocation) {
                    baseX = _savedConsoleLocation.X;
                    baseY = _savedConsoleLocation.Y;
                } else if (leavingOrb) {
                    baseX = Left - targetW + Width;
                    baseY = Top;
                } else {
                    baseX = Left;
                    baseY = Top;
                }

                Point clamped = ClampToWorkingArea(baseX, baseY, targetW, targetH);
                SetWindowPos(Handle, IntPtr.Zero, clamped.X, clamped.Y, targetW, targetH, SWP_NOZORDER | SWP_NOACTIVATE);
            } finally {
                _inModeTransition = false;
            }
            SyncBounds();
            EmitHostState();
        }

        private void EnterConsoleMode() {
            _inModeTransition = true;
            try {
                bool leavingOrb = (_windowMode == WindowMode.Orb);
                if (leavingOrb) {
                    _orbLocation = Location;
                    _hasOrbLocation = true;
                } else if (_windowMode == WindowMode.MiniBar) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    _savedConsoleLocation = Location;
                    _hasSavedConsoleLocation = true;
                }

                _windowMode = WindowMode.Console;
                if (leavingOrb) {
                    ClearWindowRegion();
                    int corner = DWMWCP_ROUND;
                    try { DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int)); } catch {}
                }

                Rectangle wa = GetCurrentWorkingArea();
                int minW = MinSharedWidthPx();
                int minH = MinConsoleHeightPx();
                int maxW = Math.Max(minW, wa.Width - 16);
                int maxH = Math.Max(minH, wa.Height - 16);
                int targetW = Math.Max(minW, Math.Min(maxW, _sharedWidth));
                int targetH = Math.Max(minH, Math.Min(maxH, _expandedHeight));
                _sharedWidth = targetW;
                _expandedHeight = targetH;

                int baseX;
                int baseY;
                if (leavingOrb && _hasSavedConsoleLocation) {
                    baseX = _savedConsoleLocation.X;
                    baseY = _savedConsoleLocation.Y;
                } else if (leavingOrb) {
                    baseX = Left - targetW + Width;
                    baseY = Top;
                } else {
                    baseX = Left;
                    baseY = Top;
                }

                Point clamped = ClampToWorkingArea(baseX, baseY, targetW, targetH);
                SetWindowPos(Handle, IntPtr.Zero, clamped.X, clamped.Y, targetW, targetH, SWP_NOZORDER | SWP_NOACTIVATE);
            } finally {
                _inModeTransition = false;
            }
            SyncBounds();
            EmitHostState();
        }

        private void SetSharedLogicalWidth(int logicalW) {
            int clampedLogical = Math.Max(MIN_SHARED_LOGICAL_WIDTH, Math.Min(MAX_SHARED_LOGICAL_WIDTH, logicalW));
            Rectangle wa = GetCurrentWorkingArea();
            int minW = MinSharedWidthPx();
            int maxW = Math.Max(minW, wa.Width - 24);
            int targetW = Math.Max(minW, Math.Min(maxW, (int)Math.Round(clampedLogical * _dpiScale)));
            _sharedWidth = targetW;

            if (_windowMode == WindowMode.MiniBar || (_windowMode == WindowMode.Console && WindowState == FormWindowState.Normal)) {
                _inModeTransition = true;
                try {
                    Point clamped = ClampToWorkingArea(Left, Top, targetW, Height);
                    SetWindowPos(Handle, IntPtr.Zero, clamped.X, clamped.Y, targetW, Height, SWP_NOZORDER | SWP_NOACTIVATE);
                } finally {
                    _inModeTransition = false;
                }
                SyncBounds();
            }
            EmitHostState();
        }

        private void SetPinned(bool pinned) {
            TopMost = pinned;
            SetWindowPos(Handle, pinned ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
            EmitHostState();
        }

        private void ApplyTheme(bool dark) {
            _isDark = dark;
            BackColor = GetThemeBackColor(_isDark);
            int darkFlag = _isDark ? 1 : 0;
            try { DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref darkFlag, sizeof(int)); } catch {}
            ApplyWebViewBackgroundColor();
            UpdateOrbMenuTheme();
        }

        private void EnsureOrbMenu() {
            if (_orbMenu != null) return;
            _orbMenu = new ContextMenuStrip {
                ShowImageMargin = true,
                ShowCheckMargin = false
            };

            var itemConsole = new ToolStripMenuItem("展开完整控制台");
            itemConsole.Click += delegate { EnterConsoleMode(); };

            var itemMiniBar = new ToolStripMenuItem("展开迷你状态条");
            itemMiniBar.Click += delegate { EnterMiniBarMode(_miniBarLogicalHeight); };

            _orbMenuPinItem = new ToolStripMenuItem("置顶固定");
            _orbMenuPinItem.Click += delegate { SetPinned(!TopMost); };

            var itemClose = new ToolStripMenuItem("关闭悬浮窗");
            itemClose.Click += delegate { RequestGracefulClose(); };

            _orbMenu.Items.Add(itemConsole);
            _orbMenu.Items.Add(itemMiniBar);
            _orbMenu.Items.Add(_orbMenuPinItem);
            _orbMenu.Items.Add(new ToolStripSeparator());
            _orbMenu.Items.Add(itemClose);

            UpdateOrbMenuTheme();
        }

        private void UpdateOrbMenuTheme() {
            if (_orbMenu == null) return;
            _orbMenu.Renderer = new OrbMenuRenderer(_isDark);
            _orbMenu.BackColor = _isDark ? Color.FromArgb(24, 25, 27) : Color.FromArgb(252, 252, 253);
            _orbMenu.ForeColor = _isDark ? Color.FromArgb(237, 238, 240) : Color.FromArgb(28, 32, 36);
        }

        private void ShowOrbContextMenu() {
            BeginInvoke((MethodInvoker)delegate {
                if (IsDisposed || !IsHandleCreated) return;
                EnsureOrbMenu();
                UpdateOrbMenuTheme();
                if (_orbMenuPinItem != null) {
                    _orbMenuPinItem.Checked = TopMost;
                    _orbMenuPinItem.Text = TopMost ? "取消置顶固定" : "置顶固定";
                }
                SetForegroundWindow(Handle);
                Point pt = Cursor.Position;
                _orbMenu.Show(pt);
            });
        }

        private void UpdateOrbTip(string text) {
            string clean = (text ?? "").Replace('\u00b7', '|').Trim();
            _orbTipText = clean;
            if (_orbToolTip == null || IsDisposed || !IsHandleCreated) return;
            try {
                _orbToolTip.SetToolTip(this, _orbTipText);
                if (_windowMode == WindowMode.Orb && !_inSizeMove) {
                    Point pt;
                    if (string.IsNullOrEmpty(_orbTipText)) {
                        _orbToolTip.Hide(this);
                    } else if (GetCursorPos(out pt) && Bounds.Contains(pt)) {
                        Rectangle wa = GetCurrentWorkingArea();
                        int tipX = (Right + 220 <= wa.Right) ? (Width + 8) : -210;
                        _orbToolTip.Show(_orbTipText, this, tipX, 4, 4000);
                    }
                }
            } catch {}
        }

        private void RequestGracefulClose() {
            PostJsonToWebView("{\"type\":\"host:action\",\"action\":\"request_close\"}");
            if (_closeFallbackTimer != null) {
                try { _closeFallbackTimer.Stop(); _closeFallbackTimer.Dispose(); } catch {}
                _closeFallbackTimer = null;
            }
            _closeFallbackTimer = new Timer { Interval = 180 };
            _closeFallbackTimer.Tick += delegate {
                if (_closeFallbackTimer != null) {
                    try { _closeFallbackTimer.Stop(); _closeFallbackTimer.Dispose(); } catch {}
                    _closeFallbackTimer = null;
                }
                if (!IsDisposed) {
                    try { Close(); } catch {}
                }
            };
            _closeFallbackTimer.Start();
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
                SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
                Activate();
                BringToFront();
                SetForegroundWindow(Handle);
                if (!wantTop) {
                    TopMost = false;
                    SetWindowPos(Handle, new IntPtr(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
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
            if (_initialMode == WindowMode.MiniBar) {
                EnterMiniBarMode(DEFAULT_MINIBAR_LOGICAL_HEIGHT);
            } else if (_initialMode == WindowMode.Orb) {
                EnterOrbMode();
            }
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
            if (!_inModeTransition) {
                if (_windowMode == WindowMode.Console && WindowState == FormWindowState.Normal) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                    if (Height >= MinConsoleHeightPx()) _expandedHeight = Height;
                } else if (_windowMode == WindowMode.MiniBar) {
                    if (Width >= MinSharedWidthPx()) _sharedWidth = Width;
                }
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
            if (_closeFallbackTimer != null) {
                try { _closeFallbackTimer.Stop(); _closeFallbackTimer.Dispose(); } catch {}
                _closeFallbackTimer = null;
            }
            if (_focusWaitHandle != null) {
                try { _focusWaitHandle.Unregister(null); } catch {}
                _focusWaitHandle = null;
            }
            if (_focusEvent != null) {
                try { _focusEvent.Dispose(); } catch {}
                _focusEvent = null;
            }
            if (_orbMenu != null) {
                try { _orbMenu.Dispose(); } catch {}
                _orbMenu = null;
            }
            if (_orbToolTip != null) {
                try { _orbToolTip.Dispose(); } catch {}
                _orbToolTip = null;
            }
            if (_controller != null) {
                try { _controller.put_IsVisible(0); } catch {}
                try { _controller.Close(); } catch {}
            }
            if (_webview != null) {
                try { Marshal.FinalReleaseComObject(_webview); } catch {}
                _webview = null;
            }
            if (_controller != null) {
                try { Marshal.FinalReleaseComObject(_controller); } catch {}
                _controller = null;
            }
            if (_hIcon != IntPtr.Zero) {
                try { DestroyIcon(_hIcon); } catch {}
                _hIcon = IntPtr.Zero;
            }
            try {
                Console.Out.WriteLine("CLOSED");
                Console.Out.Flush();
            } catch {}
            base.OnFormClosed(e);
            try { Application.ExitThread(); } catch {}
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

                var createEnv = (CreateEnvInternalDel)Marshal.GetDelegateForFunctionPointer(proc, typeof(CreateEnvInternalDel));
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
            ApplyWebViewBackgroundColor();
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
                BeginNativeNcInteraction(HTCAPTION);
            } else if (msg.StartsWith("resize:")) {
                int ht;
                if (int.TryParse(msg.Substring(7), out ht) && ht >= 10 && ht <= 17) {
                    BeginNativeNcInteraction(ht);
                }
            } else if (msg == "mode:console" || msg == "collapse:0") {
                EnterConsoleMode();
            } else if (msg == "mode:minibar") {
                EnterMiniBarMode(DEFAULT_MINIBAR_LOGICAL_HEIGHT);
            } else if (msg.StartsWith("mode:minibar:")) {
                int hVal;
                if (int.TryParse(msg.Substring(13), out hVal) && hVal > 0) {
                    EnterMiniBarMode(hVal);
                } else {
                    EnterMiniBarMode(DEFAULT_MINIBAR_LOGICAL_HEIGHT);
                }
            } else if (msg == "mode:orb" || msg == "minimize") {
                EnterOrbMode();
            } else if (msg == "collapse:1" || msg.StartsWith("collapse:1:")) {
                // Backward-compatible route to MiniBar while strictly ignoring legacy targetW to preserve _sharedWidth
                int barLogicalH = DEFAULT_MINIBAR_LOGICAL_HEIGHT;
                if (msg.Length > 11) {
                    string[] parts = msg.Substring(11).Split(':');
                    int customH;
                    if (parts.Length >= 1 && int.TryParse(parts[0], out customH) && customH >= 36 && customH <= 120) {
                        barLogicalH = customH;
                    }
                }
                EnterMiniBarMode(barLogicalH);
            } else if (msg == "min" || msg == "collapse:toggle") {
                if (_windowMode == WindowMode.Console) {
                    EnterMiniBarMode(DEFAULT_MINIBAR_LOGICAL_HEIGHT);
                } else {
                    EnterConsoleMode();
                }
            } else if (msg.StartsWith("setwidth:")) {
                int logicalW;
                if (int.TryParse(msg.Substring(9), out logicalW) && logicalW > 0) {
                    SetSharedLogicalWidth(logicalW);
                }
            } else if (msg == "orb:menu") {
                ShowOrbContextMenu();
            } else if (msg.StartsWith("orb:tip:")) {
                UpdateOrbTip(msg.Substring(8));
            } else if (msg == "pin:1") {
                SetPinned(true);
            } else if (msg == "pin:0") {
                SetPinned(false);
            } else if (msg == "max") {
                if (_windowMode == WindowMode.MiniBar || _windowMode == WindowMode.Orb) {
                    EnterConsoleMode();
                } else {
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    SyncBounds();
                    EmitHostState();
                }
            } else if (msg == "theme:dark") {
                ApplyTheme(true);
            } else if (msg == "theme:light") {
                ApplyTheme(false);
            } else if (msg == "state:sync") {
                EmitHostState();
            } else if (msg == "close") {
                Close();
            }
            return 0;
        }
    }

    public static class HostProgram {
        private static bool IsFlag(string arg, string name) {
            if (string.IsNullOrEmpty(arg)) return false;
            string trimmed = arg.TrimStart('-');
            return string.Equals(trimmed, name, StringComparison.OrdinalIgnoreCase);
        }

        [STAThread]
        public static int Main(string[] args) {
            string url = "";
            int width = 460;
            int height = 720;
            int posX = -99999;
            int posY = -99999;
            int topMost = 1;
            string theme = "light";
            string userDataDir = "";
            string mode = "console";
            int orbX = -99999;
            int orbY = -99999;

            if (args != null) {
                for (int i = 0; i < args.Length; i++) {
                    string a = args[i];
                    string next = (i + 1 < args.Length) ? args[i + 1] : null;
                    int parsedInt;
                    if (IsFlag(a, "Url") && next != null) {
                        url = next; i++;
                    } else if (IsFlag(a, "Width") && next != null && int.TryParse(next, out parsedInt)) {
                        width = parsedInt; i++;
                    } else if (IsFlag(a, "Height") && next != null && int.TryParse(next, out parsedInt)) {
                        height = parsedInt; i++;
                    } else if (IsFlag(a, "PosX") && next != null && int.TryParse(next, out parsedInt)) {
                        posX = parsedInt; i++;
                    } else if (IsFlag(a, "PosY") && next != null && int.TryParse(next, out parsedInt)) {
                        posY = parsedInt; i++;
                    } else if (IsFlag(a, "TopMost") && next != null && int.TryParse(next, out parsedInt)) {
                        topMost = parsedInt; i++;
                    } else if (IsFlag(a, "Theme") && next != null) {
                        theme = next; i++;
                    } else if (IsFlag(a, "UserDataDir") && next != null) {
                        userDataDir = next; i++;
                    } else if (IsFlag(a, "Mode") && next != null) {
                        mode = next; i++;
                    } else if (IsFlag(a, "OrbX") && next != null && int.TryParse(next, out parsedInt)) {
                        orbX = parsedInt; i++;
                    } else if (IsFlag(a, "OrbY") && next != null && int.TryParse(next, out parsedInt)) {
                        orbY = parsedInt; i++;
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(url)) {
                try {
                    Console.Error.WriteLine("HOST_ERR:Missing required -Url parameter");
                    Console.Error.Flush();
                } catch {}
                return 1;
            }

            FloatingForm.HideHostConsole();
            FloatingForm.EnableDpiAwareness();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool isDark = string.Equals(theme, "dark", StringComparison.OrdinalIgnoreCase);
            bool isTopMost = (topMost != 0);
            FloatingForm form = null;
            try {
                form = new FloatingForm(url, width, height, posX, posY, isTopMost, isDark, userDataDir, mode, orbX, orbY);
                form.Show();
                Application.Run(form);
            } catch (Exception ex) {
                try {
                    Console.Error.WriteLine("HOST_ERR:Unhandled host exception: " + ex.Message);
                    Console.Error.Flush();
                } catch {}
                return 1;
            } finally {
                if (form != null && !form.IsDisposed) {
                    try { form.Dispose(); } catch {}
                }
                try { Console.Out.Flush(); } catch {}
                try { Console.Error.Flush(); } catch {}
            }
            return Environment.ExitCode;
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
$form = New-Object ContextCacheHost.FloatingForm($Url, $Width, $Height, $PosX, $PosY, $isTopMost, $isDark, $UserDataDir, $Mode, $OrbX, $OrbY)
$form.Show()
try {
  [System.Windows.Forms.Application]::Run($form)
} finally {
  if ($form -and -not $form.IsDisposed) {
    try { $form.Dispose() } catch {}
  }
  try { [Console]::Out.Flush() } catch {}
  try { [Console]::Error.Flush() } catch {}
}
exit ([Environment]::ExitCode)
