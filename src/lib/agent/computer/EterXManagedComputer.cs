using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public class EterXManagedComputer
{
  private const uint GENERIC_ALL = 0x10000000;
  private const uint SRCCOPY = 0x00CC0020;
  private const int SM_CXSCREEN = 0;
  private const int SM_CYSCREEN = 1;
  private const int WM_MOUSEMOVE = 0x0200;
  private const int WM_LBUTTONDOWN = 0x0201;
  private const int WM_LBUTTONUP = 0x0202;
  private const int WM_RBUTTONDOWN = 0x0204;
  private const int WM_RBUTTONUP = 0x0205;
  private const int WM_MOUSEWHEEL = 0x020A;
  private const int WM_CHAR = 0x0102;
  private const int WM_KEYDOWN = 0x0100;
  private const int WM_KEYUP = 0x0101;
  private const int MK_LBUTTON = 0x0001;
  private const int CWP_SKIPINVISIBLE = 0x0001;
  private const int CWP_SKIPDISABLED = 0x0002;

  private static IntPtr _desktop = IntPtr.Zero;
  private static string _desktopName = "EterXComputer";
  private static IntPtr _lastTarget = IntPtr.Zero;
  private static int _cursorX = 640;
  private static int _cursorY = 360;

  private delegate bool EnumDesktopWindowsDelegate(IntPtr hwnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int X; public int Y; }

  private class WindowCaptureInfo
  {
    public IntPtr Hwnd;
    public RECT Rect;
    public string Title;
    public int Area;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO
  {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION
  {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateDesktop(string desktop, IntPtr device, IntPtr devmode, int flags, uint desiredAccess, IntPtr securityAttributes);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool SetThreadDesktop(IntPtr desktop);

  [DllImport("user32.dll")]
  private static extern bool EnumDesktopWindows(IntPtr desktop, EnumDesktopWindowsDelegate callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern IntPtr ChildWindowFromPointEx(IntPtr hwndParent, POINT point, uint flags);

  [DllImport("user32.dll")]
  private static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

  [DllImport("user32.dll")]
  private static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern IntPtr GetDC(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetWindowDC(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

  [DllImport("user32.dll")]
  private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int index);

  [DllImport("gdi32.dll")]
  private static extern bool BitBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, uint op);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CreateProcess(
    string applicationName,
    string commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static int Main(string[] args)
  {
    if (args.Length > 0 && !String.IsNullOrWhiteSpace(args[0]))
      _desktopName = args[0];

    _desktop = CreateDesktop(_desktopName, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (_desktop == IntPtr.Zero)
    {
      WriteLine("ERROR create_desktop " + Marshal.GetLastWin32Error());
      return 2;
    }

    if (!SetThreadDesktop(_desktop))
    {
      WriteLine("ERROR set_thread_desktop " + Marshal.GetLastWin32Error());
      return 3;
    }

    WriteLine("READY " + _desktopName);

    string line;
    while ((line = Console.ReadLine()) != null)
    {
      try
      {
        HandleCommand(line.Trim());
      }
      catch (Exception ex)
      {
        WriteLine("ERROR " + ex.Message.Replace("\r", " ").Replace("\n", " "));
      }
    }

    return 0;
  }

  private static void HandleCommand(string line)
  {
    if (line.Length == 0) return;
    string[] parts = line.Split(new char[] { ' ' }, 4);
    string cmd = parts[0].ToUpperInvariant();

    if (cmd == "QUIT")
    {
      WriteLine("OK quit");
      Environment.Exit(0);
    }
    else if (cmd == "STATUS")
    {
      WriteLine("OK " + _desktopName);
    }
    else if (cmd == "CAP")
    {
      int quality = parts.Length > 1 ? SafeInt(parts[1], 80) : 80;
      int maxWidth = parts.Length > 2 ? SafeInt(parts[2], 1280) : 1280;
      Console.WriteLine(Capture(quality, maxWidth));
      Console.WriteLine("[FRAME_END]");
      Console.Out.Flush();
    }
    else if (cmd == "LAUNCH_B64" && parts.Length > 1)
    {
      string command = Decode(parts[1]);
      WriteLine(Launch(command));
    }
    else if (cmd == "FOCUS_B64" && parts.Length > 1)
    {
      string query = Decode(parts[1]);
      IntPtr hwnd = FindWindow(query);
      if (hwnd == IntPtr.Zero) WriteLine("NOTFOUND " + query);
      else
      {
        _lastTarget = hwnd;
        SetForegroundWindow(hwnd);
        WriteLine("OK focus " + GetTitle(hwnd));
      }
    }
    else if (cmd == "LIST")
    {
      WriteLine(ListWindows());
    }
    else if (cmd == "CLICK" && parts.Length > 2)
    {
      int x = SafeInt(parts[1], 0);
      int y = SafeInt(parts[2], 0);
      ClickAt(x, y, false);
      WriteLine("OK click " + x + " " + y);
    }
    else if (cmd == "RIGHT_CLICK" && parts.Length > 2)
    {
      int x = SafeInt(parts[1], 0);
      int y = SafeInt(parts[2], 0);
      ClickAt(x, y, true);
      WriteLine("OK right_click " + x + " " + y);
    }
    else if (cmd == "DOUBLE_CLICK" && parts.Length > 2)
    {
      int x = SafeInt(parts[1], 0);
      int y = SafeInt(parts[2], 0);
      ClickAt(x, y, false);
      Thread.Sleep(80);
      ClickAt(x, y, false);
      WriteLine("OK double_click " + x + " " + y);
    }
    else if (cmd == "MOVE" && parts.Length > 2)
    {
      _cursorX = SafeInt(parts[1], _cursorX);
      _cursorY = SafeInt(parts[2], _cursorY);
      WriteLine("OK move " + _cursorX + " " + _cursorY);
    }
    else if (cmd == "DRAG" && parts.Length > 3)
    {
      int x1 = SafeInt(parts[1], 0);
      int y1 = SafeInt(parts[2], 0);
      string[] tail = parts[3].Split(' ');
      int x2 = tail.Length > 0 ? SafeInt(tail[0], x1) : x1;
      int y2 = tail.Length > 1 ? SafeInt(tail[1], y1) : y1;
      Drag(x1, y1, x2, y2);
      WriteLine("OK drag");
    }
    else if (cmd == "SCROLL" && parts.Length > 3)
    {
      int x = SafeInt(parts[1], 0);
      int y = SafeInt(parts[2], 0);
      int delta = SafeInt(parts[3], -3);
      ScrollAt(x, y, delta);
      WriteLine("OK scroll");
    }
    else if (cmd == "TYPE_B64" && parts.Length > 1)
    {
      TypeText(Decode(parts[1]));
      WriteLine("OK type");
    }
    else if (cmd == "KEY_B64" && parts.Length > 1)
    {
      SendKey(Decode(parts[1]));
      WriteLine("OK key");
    }
    else if (cmd == "CURSOR")
    {
      WriteLine("OK " + _cursorX + "," + _cursorY);
    }
    else
    {
      WriteLine("ERROR unknown_command " + cmd);
    }
  }

  private static string Launch(string command)
  {
    if (String.IsNullOrWhiteSpace(command)) return "ERROR empty_command";

    string commandLine = NormalizeCommand(command);
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = _desktopName;
    PROCESS_INFORMATION pi;
    bool ok = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    if (!ok)
      return "ERROR launch_failed " + Marshal.GetLastWin32Error() + " " + commandLine;

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    IntPtr hwnd = WaitForWindow((uint)pi.dwProcessId, 5000);
    if (hwnd != IntPtr.Zero)
    {
      _lastTarget = hwnd;
      SetForegroundWindow(hwnd);
      return "OK launch " + pi.dwProcessId + " " + GetTitle(hwnd);
    }

    return "OK launch " + pi.dwProcessId;
  }

  private static string NormalizeCommand(string command)
  {
    string trimmed = command.Trim();
    string lower = trimmed.ToLowerInvariant();
    string mapped = null;
    if (lower == "notepad") mapped = "notepad.exe";
    else if (lower == "calc" || lower == "calculator") mapped = "calc.exe";
    else if (lower == "paint" || lower == "mspaint") mapped = "mspaint.exe";
    else if (lower == "cmd" || lower == "terminal") mapped = "cmd.exe";
    else if (lower == "powershell") mapped = "powershell.exe";
    else if (lower == "chrome" || lower == "google chrome") mapped = "chrome.exe";
    else if (lower == "edge" || lower == "microsoft edge") mapped = "msedge.exe";
    else if (lower == "vscode" || lower == "vs code" || lower == "code") mapped = "Code.exe";
    else if (lower == "explorer" || lower == "file explorer") mapped = "explorer.exe";

    if (mapped != null) return QuoteIfNeeded(ResolveExecutable(mapped) ?? mapped);

    string first = FirstCommandToken(trimmed);
    if (!String.IsNullOrWhiteSpace(first))
    {
      string exeName = first.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? first : first + ".exe";
      string resolved = ResolveExecutable(exeName);
      if (!String.IsNullOrWhiteSpace(resolved))
      {
        string rest = trimmed.Length > first.Length ? trimmed.Substring(first.Length).TrimStart() : "";
        return QuoteIfNeeded(resolved) + (rest.Length > 0 ? " " + rest : "");
      }
    }

    return trimmed;
  }

  private static string FirstCommandToken(string command)
  {
    string trimmed = command.Trim();
    if (trimmed.StartsWith("\""))
    {
      int end = trimmed.IndexOf('"', 1);
      return end > 1 ? trimmed.Substring(1, end - 1) : trimmed.Trim('"');
    }
    int space = trimmed.IndexOf(' ');
    return space > 0 ? trimmed.Substring(0, space) : trimmed;
  }

  private static string QuoteIfNeeded(string value)
  {
    if (String.IsNullOrWhiteSpace(value)) return value;
    if (value.StartsWith("\"") && value.EndsWith("\"")) return value;
    return value.IndexOf(' ') >= 0 ? "\"" + value + "\"" : value;
  }

  private static string ResolveExecutable(string exeName)
  {
    if (File.Exists(exeName)) return Path.GetFullPath(exeName);

    string appPath = ResolveAppPath(Registry.CurrentUser, exeName);
    if (String.IsNullOrWhiteSpace(appPath)) appPath = ResolveAppPath(Registry.LocalMachine, exeName);
    if (!String.IsNullOrWhiteSpace(appPath) && File.Exists(appPath)) return appPath;

    string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
    string[] dirs = pathEnv.Split(Path.PathSeparator);
    foreach (string dir in dirs)
    {
      try
      {
        if (String.IsNullOrWhiteSpace(dir)) continue;
        string candidate = Path.Combine(dir.Trim(), exeName);
        if (File.Exists(candidate)) return candidate;
      }
      catch {}
    }

    string[] roots = new string[] {
      Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
      Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
      Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs")
    };
    foreach (string root in roots)
    {
      string found = FindExecutableBelow(root, exeName, 4);
      if (!String.IsNullOrWhiteSpace(found)) return found;
    }

    return null;
  }

  private static string ResolveAppPath(RegistryKey hive, string exeName)
  {
    try
    {
      using (RegistryKey key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exeName))
      {
        object value = key == null ? null : key.GetValue("");
        return value == null ? null : Convert.ToString(value);
      }
    }
    catch { return null; }
  }

  private static string FindExecutableBelow(string root, string exeName, int maxDepth)
  {
    try
    {
      if (String.IsNullOrWhiteSpace(root) || !Directory.Exists(root) || maxDepth < 0) return null;
      foreach (string file in Directory.EnumerateFiles(root, exeName, SearchOption.TopDirectoryOnly))
        return file;
      if (maxDepth == 0) return null;
      foreach (string dir in Directory.EnumerateDirectories(root))
      {
        string found = FindExecutableBelow(dir, exeName, maxDepth - 1);
        if (!String.IsNullOrWhiteSpace(found)) return found;
      }
    }
    catch {}
    return null;
  }

  private static IntPtr WaitForWindow(uint pid, int timeoutMs)
  {
    long end = Environment.TickCount + timeoutMs;
    while (Environment.TickCount < end)
    {
      IntPtr found = FindWindowByPid(pid);
      if (found != IntPtr.Zero) return found;
      Thread.Sleep(120);
    }
    return IntPtr.Zero;
  }

  private static string Capture(int quality, int maxWidth)
  {
    List<WindowCaptureInfo> windows = GetWindowsForCapture();
    if (windows.Count == 0) return "ERROR no_windows";

    int width = Math.Max(1, GetSystemMetrics(SM_CXSCREEN));
    int height = Math.Max(1, GetSystemMetrics(SM_CYSCREEN));
    float scale = (maxWidth > 0 && width > maxWidth) ? ((float)maxWidth / (float)width) : 1f;
    int targetWidth = Math.Max(1, (int)(width * scale));
    int targetHeight = Math.Max(1, (int)(height * scale));

    Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    using (Graphics graphics = Graphics.FromImage(bitmap))
    {
      graphics.Clear(Color.Black);
      foreach (WindowCaptureInfo window in windows)
      {
        CaptureWindowInto(graphics, window);
      }
    }

    DrawVirtualCursor(bitmap);

    Bitmap output = bitmap;
    if (scale != 1f)
    {
      output = new Bitmap(bitmap, targetWidth, targetHeight);
      bitmap.Dispose();
    }

    ImageCodecInfo encoder = GetJpegEncoder();
    EncoderParameters encoderParams = new EncoderParameters(1);
    encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(95, quality)));
    using (MemoryStream ms = new MemoryStream())
    {
      output.Save(ms, encoder, encoderParams);
      output.Dispose();
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  private static List<WindowCaptureInfo> GetWindowsForCapture()
  {
    List<WindowCaptureInfo> windows = new List<WindowCaptureInfo>();
    EnumDesktopWindows(_desktop, delegate(IntPtr hwnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hwnd)) return true;
      RECT r;
      if (!GetWindowRect(hwnd, out r)) return true;
      int w = r.Right - r.Left;
      int h = r.Bottom - r.Top;
      if (w < 60 || h < 40) return true;
      string title = GetTitle(hwnd);
      if (String.IsNullOrWhiteSpace(title) && hwnd != _lastTarget) return true;
      WindowCaptureInfo info = new WindowCaptureInfo();
      info.Hwnd = hwnd;
      info.Rect = r;
      info.Title = title;
      info.Area = w * h;
      windows.Add(info);
      return true;
    }, IntPtr.Zero);

    windows.Sort(delegate(WindowCaptureInfo a, WindowCaptureInfo b) {
      return b.Area.CompareTo(a.Area);
    });
    return windows;
  }

  private static void CaptureWindowInto(Graphics targetGraphics, WindowCaptureInfo window)
  {
    int x = Math.Max(0, window.Rect.Left);
    int y = Math.Max(0, window.Rect.Top);
    int w = Math.Max(1, window.Rect.Right - window.Rect.Left);
    int h = Math.Max(1, window.Rect.Bottom - window.Rect.Top);

    using (Bitmap windowBitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb))
    using (Graphics windowGraphics = Graphics.FromImage(windowBitmap))
    {
      IntPtr hdc = windowGraphics.GetHdc();
      bool printed = false;
      try
      {
        printed = PrintWindow(window.Hwnd, hdc, 2);
      }
      finally
      {
        windowGraphics.ReleaseHdc(hdc);
      }

      if (!printed)
      {
        IntPtr src = GetWindowDC(window.Hwnd);
        if (src != IntPtr.Zero)
        {
          hdc = windowGraphics.GetHdc();
          try { BitBlt(hdc, 0, 0, w, h, src, 0, 0, SRCCOPY); }
          finally
          {
            windowGraphics.ReleaseHdc(hdc);
            ReleaseDC(window.Hwnd, src);
          }
        }
      }

      targetGraphics.DrawImage(windowBitmap, x, y, w, h);
    }
  }

  private static void DrawVirtualCursor(Bitmap bitmap)
  {
    using (Graphics g = Graphics.FromImage(bitmap))
    {
      int x = Math.Max(0, Math.Min(bitmap.Width - 1, _cursorX));
      int y = Math.Max(0, Math.Min(bitmap.Height - 1, _cursorY));
      Point[] pointer = new Point[] {
        new Point(x, y),
        new Point(x, y + 22),
        new Point(x + 6, y + 17),
        new Point(x + 11, y + 29),
        new Point(x + 17, y + 26),
        new Point(x + 12, y + 15),
        new Point(x + 21, y + 15)
      };
      g.FillPolygon(Brushes.White, pointer);
      g.DrawPolygon(Pens.Black, pointer);
    }
  }

  private static void ClickAt(int x, int y, bool right)
  {
    _cursorX = x;
    _cursorY = y;
    IntPtr hwnd = DeepWindowFromPoint(x, y);
    if (hwnd == IntPtr.Zero) hwnd = LargestWindow();
    if (hwnd == IntPtr.Zero) return;
    _lastTarget = hwnd;
    SetForegroundWindow(hwnd);
    POINT pt = new POINT();
    pt.X = x;
    pt.Y = y;
    ScreenToClient(hwnd, ref pt);
    IntPtr lp = MakeLParam(pt.X, pt.Y);
    PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, lp);
    Thread.Sleep(20);
    if (right)
    {
      PostMessage(hwnd, WM_RBUTTONDOWN, IntPtr.Zero, lp);
      Thread.Sleep(55);
      PostMessage(hwnd, WM_RBUTTONUP, IntPtr.Zero, lp);
    }
    else
    {
      PostMessage(hwnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lp);
      Thread.Sleep(55);
      PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, lp);
    }
  }

  private static void Drag(int x1, int y1, int x2, int y2)
  {
    IntPtr hwnd = DeepWindowFromPoint(x1, y1);
    if (hwnd == IntPtr.Zero) return;
    _lastTarget = hwnd;
    POINT p1 = new POINT();
    p1.X = x1;
    p1.Y = y1;
    ScreenToClient(hwnd, ref p1);
    PostMessage(hwnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, MakeLParam(p1.X, p1.Y));
    for (int i = 1; i <= 12; i++)
    {
      int x = x1 + ((x2 - x1) * i / 12);
      int y = y1 + ((y2 - y1) * i / 12);
      _cursorX = x;
      _cursorY = y;
      POINT p = new POINT();
      p.X = x;
      p.Y = y;
      ScreenToClient(hwnd, ref p);
      PostMessage(hwnd, WM_MOUSEMOVE, (IntPtr)MK_LBUTTON, MakeLParam(p.X, p.Y));
      Thread.Sleep(18);
    }
    POINT p2 = new POINT();
    p2.X = x2;
    p2.Y = y2;
    ScreenToClient(hwnd, ref p2);
    PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, MakeLParam(p2.X, p2.Y));
  }

  private static void ScrollAt(int x, int y, int amount)
  {
    _cursorX = x;
    _cursorY = y;
    IntPtr hwnd = DeepWindowFromPoint(x, y);
    if (hwnd == IntPtr.Zero) hwnd = _lastTarget;
    if (hwnd == IntPtr.Zero) return;
    POINT pt = new POINT();
    pt.X = x;
    pt.Y = y;
    ScreenToClient(hwnd, ref pt);
    int delta = amount * 120;
    IntPtr wp = (IntPtr)(delta << 16);
    PostMessage(hwnd, WM_MOUSEWHEEL, wp, MakeLParam(pt.X, pt.Y));
  }

  private static void TypeText(string text)
  {
    IntPtr hwnd = _lastTarget;
    if (hwnd == IntPtr.Zero) hwnd = LargestWindow();
    if (hwnd == IntPtr.Zero) return;
    SetForegroundWindow(hwnd);

    foreach (char ch in text)
    {
      if (ch == '\n')
      {
        SendVirtualKey(hwnd, 0x0D);
      }
      else
      {
        PostMessage(hwnd, WM_CHAR, (IntPtr)ch, IntPtr.Zero);
      }
      Thread.Sleep(8);
    }
  }

  private static void SendKey(string key)
  {
    IntPtr hwnd = _lastTarget;
    if (hwnd == IntPtr.Zero) hwnd = LargestWindow();
    if (hwnd == IntPtr.Zero) return;

    string k = (key ?? "").Trim().ToLowerInvariant();
    if (k == "enter" || k == "return") SendVirtualKey(hwnd, 0x0D);
    else if (k == "tab") SendVirtualKey(hwnd, 0x09);
    else if (k == "escape" || k == "esc") SendVirtualKey(hwnd, 0x1B);
    else if (k == "backspace") SendVirtualKey(hwnd, 0x08);
    else if (k == "delete") SendVirtualKey(hwnd, 0x2E);
    else if (k == "ctrl+a" || k == "^a") SendVirtualKeyWithModifier(hwnd, 0x11, 0x41);
    else if (k == "ctrl+c" || k == "^c") SendVirtualKeyWithModifier(hwnd, 0x11, 0x43);
    else if (k == "ctrl+v" || k == "^v") SendVirtualKeyWithModifier(hwnd, 0x11, 0x56);
    else if (k == "ctrl+s" || k == "^s") SendVirtualKeyWithModifier(hwnd, 0x11, 0x53);
    else if (k == "ctrl+z" || k == "^z") SendVirtualKeyWithModifier(hwnd, 0x11, 0x5A);
    else if (k == "alt+f4" || k == "%{f4}") SendVirtualKeyWithModifier(hwnd, 0x12, 0x73);
    else if (k.Length == 1) PostMessage(hwnd, WM_CHAR, (IntPtr)k[0], IntPtr.Zero);
  }

  private static void SendVirtualKey(IntPtr hwnd, int vk)
  {
    PostMessage(hwnd, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
    Thread.Sleep(25);
    PostMessage(hwnd, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
  }

  private static void SendVirtualKeyWithModifier(IntPtr hwnd, int modifierVk, int vk)
  {
    PostMessage(hwnd, WM_KEYDOWN, (IntPtr)modifierVk, IntPtr.Zero);
    Thread.Sleep(18);
    PostMessage(hwnd, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
    Thread.Sleep(28);
    PostMessage(hwnd, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
    Thread.Sleep(18);
    PostMessage(hwnd, WM_KEYUP, (IntPtr)modifierVk, IntPtr.Zero);
  }

  private static string ListWindows()
  {
    List<string> lines = new List<string>();
    EnumDesktopWindows(_desktop, delegate(IntPtr hwnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hwnd)) return true;
      RECT r;
      if (!GetWindowRect(hwnd, out r)) return true;
      string title = GetTitle(hwnd);
      if (String.IsNullOrWhiteSpace(title)) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      lines.Add(pid + "|" + title + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top));
      return true;
    }, IntPtr.Zero);
    return lines.Count == 0 ? "EMPTY" : "OK_LIST " + String.Join("||", lines.ToArray());
  }

  private static IntPtr FindWindow(string query)
  {
    string q = (query ?? "").ToLowerInvariant();
    IntPtr found = IntPtr.Zero;
    EnumDesktopWindows(_desktop, delegate(IntPtr hwnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hwnd)) return true;
      string title = GetTitle(hwnd).ToLowerInvariant();
      if (title.Contains(q))
      {
        found = hwnd;
        return false;
      }
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      try
      {
        Process p = Process.GetProcessById((int)pid);
        if (p.ProcessName.ToLowerInvariant().Contains(q))
        {
          found = hwnd;
          return false;
        }
      }
      catch { }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static IntPtr FindWindowByPid(uint targetPid)
  {
    IntPtr found = IntPtr.Zero;
    EnumDesktopWindows(_desktop, delegate(IntPtr hwnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hwnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == targetPid)
      {
        found = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static IntPtr LargestWindow()
  {
    IntPtr best = IntPtr.Zero;
    int bestArea = 0;
    EnumDesktopWindows(_desktop, delegate(IntPtr hwnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hwnd)) return true;
      RECT r;
      if (!GetWindowRect(hwnd, out r)) return true;
      int area = Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
      if (area > bestArea)
      {
        bestArea = area;
        best = hwnd;
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  private static IntPtr DeepWindowFromPoint(int x, int y)
  {
    IntPtr top = IntPtr.Zero;
    EnumDesktopWindows(_desktop, delegate(IntPtr hwnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hwnd)) return true;
      RECT r;
      if (!GetWindowRect(hwnd, out r)) return true;
      if (x >= r.Left && x <= r.Right && y >= r.Top && y <= r.Bottom)
      {
        top = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);

    if (top == IntPtr.Zero) return IntPtr.Zero;

    IntPtr current = top;
    for (int i = 0; i < 8; i++)
    {
      POINT pt = new POINT();
      pt.X = x;
      pt.Y = y;
      ScreenToClient(current, ref pt);
      IntPtr child = ChildWindowFromPointEx(current, pt, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED);
      if (child == IntPtr.Zero || child == current) break;
      current = child;
    }
    return current;
  }

  private static string GetTitle(IntPtr hwnd)
  {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  private static IntPtr MakeLParam(int lo, int hi)
  {
    return (IntPtr)((hi << 16) | (lo & 0xffff));
  }

  private static int SafeInt(string value, int fallback)
  {
    int parsed;
    return Int32.TryParse(value, out parsed) ? parsed : fallback;
  }

  private static string Decode(string b64)
  {
    return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
  }

  private static ImageCodecInfo GetJpegEncoder()
  {
    ImageCodecInfo[] encoders = ImageCodecInfo.GetImageEncoders();
    for (int i = 0; i < encoders.Length; i++)
    {
      if (encoders[i].MimeType == "image/jpeg") return encoders[i];
    }
    return encoders[0];
  }

  private static void WriteLine(string text)
  {
    Console.WriteLine(text);
    Console.Out.Flush();
  }
}
