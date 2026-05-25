using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class EterXScreenStream {
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr d);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(out CURSORINFO pci);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);
    
    const uint CC = 0x00CC0020; // SRCCOPY
    const int CURSOR_SHOWING = 0x00000001;
    const int DI_NORMAL = 0x0003;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    static ImageCodecInfo GetJpegEncoder() {
        foreach (var c in ImageCodecInfo.GetImageEncoders()) {
            if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
        }
        return null;
    }

    public static void Main(string[] args) {
        // Set console to UTF8 to prevent formatting issues or output drops
        Console.OutputEncoding = Encoding.UTF8;
        
        string line;
        while ((line = Console.ReadLine()) != null) {
            line = line.Trim();
            if (string.IsNullOrEmpty(line)) continue;

            if (line.StartsWith("CAP", StringComparison.OrdinalIgnoreCase)) {
                try {
                    // Format:
                    //   CAP <quality> <maxWidth>
                    //   CAP_WINDOW_B64 <quality> <maxWidth> <utf8-base64-window-title-or-process>
                    string[] parts = line.Split(' ');
                    int quality = 80;
                    int maxWidth = 1280;
                    if (parts.Length > 1) int.TryParse(parts[1], out quality);
                    if (parts.Length > 2) int.TryParse(parts[2], out maxWidth);

                    IntPtr target = IntPtr.Zero;
                    if (line.StartsWith("CAP_WINDOW_B64", StringComparison.OrdinalIgnoreCase) && parts.Length > 3) {
                        string query = Encoding.UTF8.GetString(Convert.FromBase64String(parts[3]));
                        target = FindWindow(query);
                    }

                    CaptureAndWriteFrame(target, quality, maxWidth);
                } catch (Exception ex) {
                    Console.WriteLine("ERROR: " + ex.Message);
                    Console.WriteLine("[FRAME_END]");
                }
            } else if (line.StartsWith("TITLE", StringComparison.OrdinalIgnoreCase)) {
                try {
                    var h = GetForegroundWindow();
                    var sb = new StringBuilder(256);
                    GetWindowText(h, sb, 256);
                    Console.WriteLine("[TITLE]" + sb.ToString());
                } catch (Exception ex) {
                    Console.WriteLine("[TITLE]ERROR: " + ex.Message);
                }
            } else if (line.Equals("QUIT", StringComparison.OrdinalIgnoreCase)) {
                break;
            } else {
                Console.WriteLine("UNKNOWN_COMMAND");
            }
        }
    }

    static IntPtr FindWindow(string query) {
        if (String.IsNullOrWhiteSpace(query)) return IntPtr.Zero;
        string q = query.ToLowerInvariant();

        foreach (var p in Process.GetProcesses()) {
            try {
                if (p.MainWindowHandle == IntPtr.Zero) continue;
                string title = (p.MainWindowTitle ?? "").ToLowerInvariant();
                string name = (p.ProcessName ?? "").ToLowerInvariant();
                bool titleMatch = title.Length > 0 && (title.Contains(q) || q.Contains(title));
                bool nameMatch = name.Length > 0 && (name.Contains(q) || q.Contains(name));
                if (titleMatch || nameMatch) {
                    return p.MainWindowHandle;
                }
            } catch { }
        }

        return IntPtr.Zero;
    }

    static void CaptureAndWriteFrame(IntPtr hwnd, int quality, int maxWidth) {
        Rectangle sourceBounds;
        IntPtr dcSource;
        IntPtr releaseHandle;
        int sx = 0, sy = 0;
        int originX = 0, originY = 0;
        RECT r;

        if (hwnd != IntPtr.Zero && GetWindowRect(hwnd, out r)) {
            int ww = Math.Max(1, r.Right - r.Left);
            int wh = Math.Max(1, r.Bottom - r.Top);
            sourceBounds = new Rectangle(0, 0, ww, wh);
            dcSource = GetWindowDC(hwnd);
            releaseHandle = hwnd;
            originX = r.Left;
            originY = r.Top;
        } else {
            var sc = Screen.PrimaryScreen.Bounds;
            sourceBounds = new Rectangle(0, 0, sc.Width, sc.Height);
            var dw = GetDesktopWindow();
            dcSource = GetWindowDC(dw);
            releaseHandle = dw;
            originX = sc.Left;
            originY = sc.Top;
        }

        int w = sourceBounds.Width;
        int h = sourceBounds.Height;
        float scale = (maxWidth > 0 && w > maxWidth) ? (float)maxWidth / w : 1f;
        int tw = Math.Max(1, (int)(w * scale));
        int th = Math.Max(1, (int)(h * scale));

        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(bmp)) {
                var gdc = g.GetHdc();
                BitBlt(gdc, 0, 0, w, h, dcSource, sx, sy, CC);
                DrawCursor(gdc, originX, originY, w, h);
                g.ReleaseHdc(gdc);
            }
            ReleaseDC(releaseHandle, dcSource);

            Bitmap outBmp = bmp;
            if (scale != 1f) {
                outBmp = new Bitmap(bmp, tw, th);
            }

            var ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            using (var ms = new MemoryStream()) {
                outBmp.Save(ms, GetJpegEncoder(), ep);
                if (!Object.ReferenceEquals(outBmp, bmp)) outBmp.Dispose();
                Console.WriteLine(Convert.ToBase64String(ms.ToArray()));
                Console.WriteLine("[FRAME_END]");
            }
        }
    }

    static void DrawCursor(IntPtr targetDc, int originX, int originY, int width, int height) {
        try {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(out ci)) return;
            if ((ci.flags & CURSOR_SHOWING) == 0 || ci.hCursor == IntPtr.Zero) return;

            int x = ci.ptScreenPos.X - originX;
            int y = ci.ptScreenPos.Y - originY;
            if (x < -64 || y < -64 || x > width + 64 || y > height + 64) return;

            DrawIconEx(targetDc, x, y, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
        } catch { }
    }
}
