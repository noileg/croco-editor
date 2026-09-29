// croco-editor's C# shell. A WinForms window hosts one WebView2 control that
// shows the front end in dist/ (CodeMirror + preview). File I/O, dialogs and
// the window title live here; editing and character counting live in the webview.
//
// Build: node csharp/build_host.mjs (uses the csc.exe that ships with Windows;
// no .NET SDK needed).
//
// The string protocol between JS and the shell is documented at the top of bridge.js.
//
// Single instance: a second launch hands the path it was asked to open to the
// existing instance's main window (MainForm) via WM_COPYDATA and exits. The first
// instance opens it in a new tab and brings its window to the front. Windows
// started with `--new` do not take part and are always independent.
//
// MainForm marks itself (SetProp) as soon as its handle is created, early in
// Application.Run and well before WebView2 initializes (OnHandleCreated ->
// Program.MarkAsMainWindow). A later instance finds that mark with EnumWindows
// (FindMainWindow). If the mark is not there yet it keeps looking for a few
// seconds, and if it still finds nothing it opens its own window instead of
// dropping the path.

using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Log
{
    static readonly string Path_ =
        System.IO.Path.Combine(System.IO.Path.GetTempPath(), "croco-editor.log");
    public static void Reset() { try { File.WriteAllText(Path_, ""); } catch { } }
    public static void W(string s)
    {
        try { File.AppendAllText(Path_, DateTime.Now.ToString("HH:mm:ss.fff ") + s + "\r\n"); }
        catch { }
    }
}

// UI language. Stored as "en" or "ja" in HKCU\Software\croco-editor\Language,
// written by the installer or by the View > Language menu. Defaults to English.
static class L
{
    const string Key = @"Software\croco-editor";
    public static string Lang = "en";

    public static void Load()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key))
            {
                var v = k == null ? null : k.GetValue("Language") as string;
                Lang = v == "ja" ? "ja" : "en";
            }
        }
        catch { Lang = "en"; }
    }

    public static void Save(string lang)
    {
        Lang = lang == "ja" ? "ja" : "en";
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key))
                k.SetValue("Language", Lang);
        }
        catch (Exception ex) { Log.W("L.Save: " + ex.Message); }
    }

    public static string T(string en, string ja) { return Lang == "ja" ? ja : en; }
}

[StructLayout(LayoutKind.Sequential)]
struct COPYDATASTRUCT
{
    public IntPtr dwData;
    public int cbData;
    public IntPtr lpData;
}

static class Program
{
    const string MutexName = @"Local\croco-editor-singleton";
    const string MainWindowProp = "CrocoEditorMainWindow";
    internal const int WM_COPYDATA = 0x004A;
    // AppUserModelID: groups the taskbar buttons and ties the jump list to this app.
    internal const string AppId = "croco.editor";
    static Mutex mutex;

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetProp(IntPtr hWnd, string lpString, IntPtr hData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetProp(IntPtr hWnd, string lpString);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, ref COPYDATASTRUCT lParam);

    [DllImport("shell32.dll")]
    static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);

    [STAThread]
    static void Main()
    {
        // Must be set before any window is created. Without it the taskbar uses the
        // default icon and grouping, and the jump list does not appear.
        try { SetCurrentProcessExplicitAppUserModelID(AppId); } catch { }
        L.Load();

        var args = Environment.GetCommandLineArgs();
        bool newWindow = args.Contains("--new");
        string path = null;
        foreach (var a in args.Skip(1))
        {
            if (a != "--new" && !string.IsNullOrWhiteSpace(a)) { path = a; break; }
        }

        // Reference files (.json / .tasks / README.md) open in their own window
        // rather than as a tab in the main window, i.e. as if --new were given.
        if (WantsOwnWindow(path)) newWindow = true;

        // Register the taskbar "New window" task unless this is a --new window. The
        // actual registration happens once the window is up (see below).
        bool wantsJumpList = !args.Contains("--new");

        if (!newWindow)
        {
            bool isFirst;
            mutex = new Mutex(true, MutexName, out isFirst);
            if (!isFirst)
            {
                if (TryHandoff(path)) return; // Handed off to the existing window.
                // No window found within a few seconds, or the first instance is gone.
                // Keep the path and open a standalone window instead.
                newWindow = true;
            }
        }

        Log.Reset();
        Log.W("Main start newWindow=" + newWindow + " path=" + (path ?? ""));

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // MainForm doubles as the handoff target (no separate window). It marks
        // itself when its handle is created (OnHandleCreated -> MarkAsMainWindow),
        // one of the first things Application.Run does, long before WebView2
        // initializes.
        //
        // Jump list registration (COM plus shortcut file I/O, a few ms) is deferred
        // until the window exists so it does not delay that mark.
        var form = new MainForm(path, participateSession: !newWindow, wantsJumpList: wantsJumpList);
        Application.Run(form);
        GC.KeepAlive(mutex);
    }

    internal static bool WantsOwnWindow(string p)
    {
        if (string.IsNullOrWhiteSpace(p)) return false;
        string ext = Path.GetExtension(p).ToLowerInvariant();
        if (ext == ".json" || ext == ".tasks") return true;
        if ((ext == ".md" || ext == ".markdown") &&
            Path.GetFileNameWithoutExtension(p).ToLowerInvariant() == "readme") return true;
        return false;
    }

    // Called from MainForm.OnHandleCreated. Just marks our window (SetProp adds
    // one entry to the window's property list).
    internal static void MarkAsMainWindow(IntPtr hwnd)
    {
        SetProp(hwnd, MainWindowProp, new IntPtr(1));
    }

    static IntPtr FindMainWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr lp)
        {
            if (GetProp(hwnd, MainWindowProp) != IntPtr.Zero) { found = hwnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Later instance: look for the main window for up to 5 seconds and send the
    // path with WM_COPYDATA. Normally the window already exists and is found on
    // the first try; the wait only covers a cold start where the mutex is taken
    // but the window is not marked yet.
    static bool TryHandoff(string path)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        IntPtr hwnd;
        while (true)
        {
            hwnd = FindMainWindow();
            if (hwnd != IntPtr.Zero) break;
            if (!WinnerAlive()) { Log.W("handoff aborted: first instance is gone"); return false; }
            if (DateTime.UtcNow > deadline) { Log.W("handoff aborted: window not found"); return false; }
            Thread.Sleep(50);
        }

        string p = path ?? "";
        IntPtr buf = Marshal.StringToHGlobalUni(p);
        try
        {
            var cds = new COPYDATASTRUCT();
            cds.dwData = IntPtr.Zero;
            cds.cbData = (p.Length + 1) * 2; // UTF-16 + terminating null
            cds.lpData = buf;
            SendMessage(hwnd, WM_COPYDATA, IntPtr.Zero, ref cds);
            return true;
        }
        catch (Exception ex) { Log.W("handoff send failed: " + ex.Message); return false; }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // May be called before Log.Reset in Main, so it does not rely on the log.
    static bool WinnerAlive()
    {
        try { using (Mutex.OpenExisting(MutexName)) return true; }
        catch (WaitHandleCannotBeOpenedException) { return false; }
        catch (UnauthorizedAccessException) { return true; } // It exists.
    }
}

// --- Taskbar jump list ("New window" task) -----------------------------------
//
// Uses ICustomDestinationList (COM); there is no managed API for this. The
// shortcut points directly at croco-editor.exe.
static class JumpList
{
    const string LinkName = "croco-editor.lnk";

    // Called on every normal launch. Failures are ignored.
    public static void TryRegister(string exePath)
    {
        try { EnsureShortcut(exePath); } catch { }
        try { CommitTasks(exePath); } catch { }
    }

    // Windows only shows a jump list if a shortcut with the AppUserModelID exists
    // somewhere, so put one in the Start menu.
    static void EnsureShortcut(string exePath, bool force = false)
    {
        string dir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        string lnk = Path.Combine(dir, LinkName);
        if (File.Exists(lnk) && !force) return;

        IShellLinkW link = (IShellLinkW)new CShellLink();
        link.SetPath(exePath);
        link.SetIconLocation(exePath, 0);
        link.SetDescription("croco-editor");

        IPropertyStore store = (IPropertyStore)link;
        SetString(store, PkeyAppUserModelId, Program.AppId);
        store.Commit();

        ((IPersistFile)link).Save(lnk, true);
    }

    static void CommitTasks(string exePath)
    {
        ICustomDestinationList list = (ICustomDestinationList)new CDestinationList();
        list.SetAppID(Program.AppId);

        uint slots;
        Guid oa = typeof(IObjectArray).GUID;
        object removed;
        Check(list.BeginList(out slots, ref oa, out removed), "BeginList");

        IShellLinkW link = (IShellLinkW)new CShellLink();
        link.SetPath(exePath);
        link.SetArguments("--new");
        link.SetIconLocation(exePath, 0);
        link.SetDescription(L.T("Open a new window", "新しいウィンドウを開く"));
        IPropertyStore store = (IPropertyStore)link;
        SetString(store, PkeyTitle, L.T("New window", "新しいウィンドウ"));
        store.Commit();

        IObjectCollection tasks = (IObjectCollection)new CEnumerableObjectCollection();
        tasks.AddObject(link);
        Check(list.AddUserTasks((IObjectArray)tasks), "AddUserTasks");
        Check(list.CommitList(), "CommitList");
    }

    static void SetString(IPropertyStore store, PropertyKey key, string value)
    {
        PropVariant pv = new PropVariant();
        pv.vt = 31; // VT_LPWSTR
        pv.p = Marshal.StringToCoTaskMemUni(value);
        try { store.SetValue(ref key, ref pv); }
        finally { Marshal.FreeCoTaskMem(pv.p); }
    }

    static void Check(int hr, string where)
    {
        if (hr < 0) throw new COMException(where + " failed (HRESULT 0x"
                                           + hr.ToString("x8") + ")", hr);
    }

    static PropertyKey PkeyTitle
    {
        get
        {
            PropertyKey k;
            k.fmtid = new Guid("f29f85e0-4ff9-1068-ab91-08002b27b3d9");
            k.pid = 2;
            return k;
        }
    }

    static PropertyKey PkeyAppUserModelId
    {
        get
        {
            PropertyKey k;
            k.fmtid = new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3");
            k.pid = 5;
            return k;
        }
    }
}

[ComImport, Guid("77f10cf0-3db5-4966-b520-b7c54fd35ed6")]
class CDestinationList { }

[ComImport, Guid("2d3468c1-36a7-43b6-ac24-d3f02fd9607a")]
class CEnumerableObjectCollection { }

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class CShellLink { }

[ComImport, Guid("6332debf-87b5-4670-90c0-5e57b408a49e"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICustomDestinationList
{
    void SetAppID([MarshalAs(UnmanagedType.LPWStr)] string pszAppID);
    [PreserveSig] int BeginList(out uint pcMaxSlots, ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    [PreserveSig] int AppendCategory([MarshalAs(UnmanagedType.LPWStr)] string pszCategory,
        [MarshalAs(UnmanagedType.Interface)] IObjectArray poa);
    [PreserveSig] int AppendKnownCategory(int category);
    [PreserveSig] int AddUserTasks([MarshalAs(UnmanagedType.Interface)] IObjectArray poa);
    [PreserveSig] int CommitList();
    [PreserveSig] int GetRemovedDestinations(ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    [PreserveSig] int DeleteList([MarshalAs(UnmanagedType.LPWStr)] string pszAppID);
    [PreserveSig] int AbortList();
}

[ComImport, Guid("92CA9DCD-5622-4bba-A805-5E9F541BD8C9"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IObjectArray
{
    void GetCount(out uint pcObjects);
    void GetAt(uint uiIndex, ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[ComImport, Guid("5632b1a4-e38a-400a-928a-d4cd63230295"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IObjectCollection
{
    void GetCount(out uint pcObjects);
    void GetAt(uint uiIndex, ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    void AddObject([MarshalAs(UnmanagedType.IUnknown)] object pvObject);
    void AddFromArray([MarshalAs(UnmanagedType.Interface)] IObjectArray poaSource);
    void RemoveObjectAt(uint uiIndex);
    void Clear();
}

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile,
        int cchMaxPath, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName,
        int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir,
        int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs,
        int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath,
        int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore
{
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PropertyKey pkey);
    void GetValue(ref PropertyKey key, out PropVariant pv);
    void SetValue(ref PropertyKey key, ref PropVariant pv);
    void Commit();
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPersistFile
{
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName,
        [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

[StructLayout(LayoutKind.Sequential)]
struct PropertyKey
{
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
struct PropVariant
{
    public ushort vt;
    public ushort r1;
    public ushort r2;
    public ushort r3;
    public IntPtr p;
    public int p2;
}

sealed class MainForm : Form
{
    readonly WebView2 web = new WebView2();
    string currentPath;   // File given on the command line (used for the initial title)
    // Folder that the virtual host doc.local points to, so the HTML preview (iframe)
    // can load relative images and CSS. JS updates it when the active HTML tab changes.
    string docBaseDir;
    bool navigated;
    ToolStripMenuItem miPreview;   // View > Show preview (checked)
    ToolStripMenuItem miEditor;    // View > Show editor (checked; per tab, reported by JS)
    ToolStripMenuItem miWrap;      // View > Word wrap (checked)
    ToolStripMenuItem miMemo;      // View > Notes > Show (checked)
    ToolStripMenuItem miMemoEdit;  // View > Notes > Edit (checked)
    bool anyDirty;                 // Whether any tab has unsaved changes (reported by JS)
    bool closingConfirmed;         // "No" was chosen in the close confirmation
    string lastSessionJson = "";   // Latest session state from JS (opaque to the shell)
    string restoreJson;            // Previous session read at startup (passed to JS)
    bool selfTest;
    readonly bool participatesSingleInstance; // Accepts handoffs (i.e. not a --new window)
    System.Windows.Forms.Timer sessionSaveTimer; // Debounces session saves (1500 ms)
    // Last-modified time of each file as of our last read or write, used to detect
    // external changes. Keys are full paths (Path.GetFullPath).
    readonly System.Collections.Generic.Dictionary<string, DateTime> knownMtime =
        new System.Collections.Generic.Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

    // --- Notes panel (claude_notes) ------------------------------------------
    // Where notes live. Must match the CLI that writes them (claude_notes.mjs).
    // Defaults to %APPDATA%\croco-editor\claude_notes; override with CROCO_NOTE_DIR.
    // File names (first 16 hex digits of SHA-1) match note_path in claude_notes.mjs.
    static readonly string NoteDir =
        Environment.GetEnvironmentVariable("CROCO_NOTE_DIR")
        ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "croco-editor", "claude_notes");
    string memoDraftPath, memoOverride, memoNotePath;
    bool memoVisible, memoEditable;
    bool activeDirty; // Whether the active tab's draft (memoDraftPath) has unsaved edits
    DateTime? memoMtime;
    System.Windows.Forms.Timer memoTimer;
    System.Windows.Forms.Timer docWatchTimer; // Watches the active draft for external changes
    readonly System.Collections.Generic.List<string> pendingHandoff =
        new System.Collections.Generic.List<string>(); // Handoffs that arrived before the webview was ready

    static string SessionPath
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "croco-editor", "session.dat");
        }
    }

    // Where knownMtime is persisted. The shell does not parse the session JSON, so
    // this is a separate file with one line per file: "<mtime as UTC ticks>\t<full path>".
    //
    // Without it, tabs restored after a restart would have no baseline, and the
    // next autosave would skip the external-change check and could overwrite
    // changes made while the app was closed.
    static string MtimeCachePath
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "croco-editor", "mtimes.dat");
        }
    }

    void LoadKnownMtime()
    {
        try
        {
            if (!File.Exists(MtimeCachePath)) return;
            foreach (string line in File.ReadAllLines(MtimeCachePath, new UTF8Encoding(false)))
            {
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                long ticks;
                if (!long.TryParse(line.Substring(0, tab), out ticks)) continue;
                string p = line.Substring(tab + 1);
                if (p.Length == 0) continue;
                knownMtime[p] = new DateTime(ticks, DateTimeKind.Utc);
            }
        }
        catch (Exception ex) { Log.W("LoadKnownMtime: " + ex.Message); }
    }

    void SaveKnownMtime()
    {
        try
        {
            var sb = new StringBuilder();
            foreach (var kv in knownMtime)
                sb.Append(kv.Value.Ticks).Append('\t').Append(kv.Key).Append('\n');
            Directory.CreateDirectory(Path.GetDirectoryName(MtimeCachePath));
            WriteTextAtomic(MtimeCachePath, sb.ToString(), new UTF8Encoding(false));
        }
        catch (Exception ex) { Log.W("SaveKnownMtime: " + ex.Message); }
    }

    readonly bool wantsJumpList;

    public MainForm(string path, bool participateSession, bool wantsJumpList)
    {
        currentPath = string.IsNullOrEmpty(path) ? null : Path.GetFullPath(path);
        participatesSingleInstance = participateSession;
        this.wantsJumpList = wantsJumpList;
        selfTest = Environment.GetEnvironmentVariable("CROCO_SELFTEST") == "1";
        Width = 960;
        Height = 700;
        StartPosition = FormStartPosition.CenterScreen;
        try
        {
            string ico = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "editor.ico");
            if (File.Exists(ico)) Icon = new System.Drawing.Icon(ico);
        }
        catch { }
        UpdateTitle();

        if (participateSession && !selfTest) { LoadSession(); LoadKnownMtime(); }

        web.Dock = DockStyle.Fill;
        Controls.Add(web);
        Controls.Add(BuildMenu()); // Add web first, then the menu so it docks on top
        InitAsync();
    }

    // The handle is created here, early in Application.Run and well before WebView2
    // initializes. This is where we mark ourselves as the handoff target.
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (participatesSingleInstance) Program.MarkAsMainWindow(Handle);

        // Jump list registration (COM + file I/O) is deferred with BeginInvoke until
        // the message loop runs, so it does not delay accepting handoffs.
        if (wantsJumpList)
        {
            BeginInvoke((Action)(() =>
            {
                try { JumpList.TryRegister(Application.ExecutablePath); }
                catch (Exception ex) { Log.W("JumpList.TryRegister: " + ex.Message); }
            }));
        }
    }

    // WM_COPYDATA from another instance. We are already on the UI thread (our own
    // message loop), so no BeginInvoke is needed.
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Program.WM_COPYDATA)
        {
            var cds = (COPYDATASTRUCT)Marshal.PtrToStructure(m.LParam, typeof(COPYDATASTRUCT));
            string path = cds.lpData != IntPtr.Zero ? Marshal.PtrToStringUni(cds.lpData) : "";
            Handoff(path);
            m.Result = new IntPtr(1);
            return;
        }
        base.WndProc(ref m);
    }

    // session.dat: first line "x,y,w,h,max", the rest is JSON from JS (opaque to the shell).
    void LoadSession()
    {
        try
        {
            if (!File.Exists(SessionPath)) return;
            string all = File.ReadAllText(SessionPath);
            int nl = all.IndexOf('\n');
            string first = nl < 0 ? all : all.Substring(0, nl);
            restoreJson = nl < 0 ? "" : all.Substring(nl + 1);

            var p = first.Split(',');
            if (p.Length >= 4)
            {
                int x = int.Parse(p[0]), y = int.Parse(p[1]), w = int.Parse(p[2]), h = int.Parse(p[3]);
                var vs = SystemInformation.VirtualScreen;
                var r = new System.Drawing.Rectangle(x, y, Math.Max(400, w), Math.Max(300, h));
                if (r.IntersectsWith(vs)) // Don't restore off-screen
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = r;
                    if (p.Length >= 5 && p[4] == "1") WindowState = FormWindowState.Maximized;
                }
            }
        }
        catch (Exception ex) { Log.W("LoadSession: " + ex.Message); }
    }

    void SaveSession()
    {
        // Save the mtime baselines before the tab layout. If we crash between the two
        // writes, the worst case is baselines without restored tabs, never restored
        // tabs without baselines (which would skip the external-change check).
        SaveKnownMtime();
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            string first = b.X + "," + b.Y + "," + b.Width + "," + b.Height + "," +
                           (WindowState == FormWindowState.Maximized ? "1" : "0");
            Directory.CreateDirectory(Path.GetDirectoryName(SessionPath));
            WriteTextAtomic(SessionPath, first + "\n" + lastSessionJson, new UTF8Encoding(false));
        }
        catch (Exception ex) { Log.W("SaveSession: " + ex.Message); }
    }

    // Saving only on close would lose everything on a crash or forced shutdown, so
    // every session message reschedules a disk write 1500 ms later. --new windows
    // are skipped so they don't overwrite the main session.
    void ScheduleSessionSave()
    {
        if (!participatesSingleInstance || selfTest) return;
        if (sessionSaveTimer == null)
        {
            sessionSaveTimer = new System.Windows.Forms.Timer();
            sessionSaveTimer.Interval = 1500;
            sessionSaveTimer.Tick += (s, e) => { sessionSaveTimer.Stop(); SaveSession(); };
        }
        sessionSaveTimer.Stop();
        sessionSaveTimer.Start();
    }

    // --- Notes panel ---------------------------------------------------------
    // Same as claude_notes' note_path_for: the draft's full path with forward
    // slashes, lowercased, SHA-1, first 16 hex digits + ".md".
    static string NotePathFor(string draftPath)
    {
        string posix = Path.GetFullPath(draftPath).Replace('\\', '/');
        string key = posix.ToLowerInvariant();
        using (var sha = SHA1.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(key));
            var sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2")); // 16 hex digits
            return Path.Combine(NoteDir, sb.ToString() + ".md");
        }
    }

    // memo-watch\n<draft path>\n<manual note path>\n<visible 0|1>\n<editable 0|1>\n<dirty 0|1>
    // <dirty> refers to the draft itself (the active tab), not the note's edit mode.
    // DocWatchTick uses it.
    void ConfigureMemo(string[] p)
    {
        memoDraftPath = p.Length > 0 && p[0].Length > 0 ? p[0] : null;
        memoOverride = p.Length > 1 && p[1].Length > 0 ? p[1] : null;
        memoVisible = p.Length > 2 && p[2].Trim() == "1";
        memoEditable = p.Length > 3 && p[3].Trim() == "1";
        activeDirty = p.Length > 4 && p[4].Trim() == "1";

        memoNotePath = memoOverride != null
            ? memoOverride
            : (memoDraftPath != null ? NotePathFor(memoDraftPath) : null);
        memoMtime = null;
        Log.W("ConfigureMemo draft=" + (memoDraftPath ?? "-") + " note=" + (memoNotePath ?? "-") +
              " vis=" + memoVisible + " edit=" + memoEditable + " dirty=" + activeDirty);

        if (memoTimer == null)
        {
            memoTimer = new System.Windows.Forms.Timer();
            memoTimer.Interval = 1000; // Poll once a second
            memoTimer.Tick += (s, e) => MemoTick();
        }
        memoTimer.Enabled = memoVisible && !memoEditable && memoNotePath != null;

        // Watch the active draft for external changes whether or not the notes panel
        // is shown. While the tab has no unsaved edits, it is reloaded silently when
        // the file changes on disk.
        if (docWatchTimer == null)
        {
            docWatchTimer = new System.Windows.Forms.Timer();
            docWatchTimer.Interval = 1000;
            docWatchTimer.Tick += (s, e) => DocWatchTick();
        }
        docWatchTimer.Enabled = memoDraftPath != null;

        SendMemo(force: true);
    }

    void MemoTick()
    {
        if (!memoVisible || memoEditable || memoNotePath == null) return;
        DateTime? m = null;
        try { if (File.Exists(memoNotePath)) m = File.GetLastWriteTimeUtc(memoNotePath); }
        catch { }
        if (m != memoMtime) SendMemo(force: false);
    }

    void DocWatchTick()
    {
        if (activeDirty || memoDraftPath == null || !File.Exists(memoDraftPath)) return;
        string full;
        try { full = Path.GetFullPath(memoDraftPath); }
        catch (Exception ex) { Log.W("DocWatchTick: " + ex.Message); return; }

        DateTime disk;
        try { disk = File.GetLastWriteTimeUtc(full); }
        catch (Exception ex) { Log.W("DocWatchTick: " + ex.Message); return; }

        DateTime known;
        if (!knownMtime.TryGetValue(full, out known))
        {
            // No baseline yet: just record one (we can't tell whether it changed).
            RememberMtime(full);
            return;
        }
        if (disk == known) return;

        string fresh;
        try { fresh = ReadTextSmart(full); }
        catch (Exception ex) { Log.W("DocWatchTick read: " + ex.Message); return; }
        RememberMtime(full);
        string crlf = fresh.Contains("\r\n") ? "1" : "0";
        Log.W("external change detected, reloading: " + full);
        Post("externalUpdate\n" + full + "\n" + crlf + "\n" + fresh.Replace("\r\n", "\n"));
    }

    void SendMemo(bool force)
    {
        if (memoNotePath == null)
        {
            Post("memo\nnone\n" + L.T("(The notes panel is available only for saved drafts)", "（保存された下書きにのみメモ広場が使えます）"));
            return;
        }
        string content = "";
        try
        {
            if (File.Exists(memoNotePath))
            {
                content = File.ReadAllText(memoNotePath);
                memoMtime = File.GetLastWriteTimeUtc(memoNotePath);
            }
            else memoMtime = null;
        }
        catch (Exception ex) { Log.W("SendMemo: " + ex.Message); }
        Log.W("SendMemo force=" + force + " len=" + content.Length);
        Post("memo\n" + (content.Length == 0 ? "empty" : "ok") + "\n" + content);
    }

    void SaveMemo(string content)
    {
        if (memoNotePath == null) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(memoNotePath));
            File.WriteAllText(memoNotePath, content, new UTF8Encoding(false));
            memoMtime = File.GetLastWriteTimeUtc(memoNotePath);
        }
        catch (Exception ex) { Log.W("SaveMemo: " + ex.Message); }
    }

    // Menu: Notes > Choose file...
    void PickMemoFile()
    {
        using (var dlg = new OpenFileDialog())
        {
            dlg.Filter = L.T("Markdown / Text|*.md;*.txt|All files|*.*", "Markdown / テキスト|*.md;*.txt|すべてのファイル|*.*");
            if (Directory.Exists(NoteDir)) dlg.InitialDirectory = NoteDir;
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            Post("menu\nmemo-file\n" + dlg.FileName); // JS keeps it as an override and re-watches
        }
    }

    // Menu item. Shortcut keys are not bound on the form or the menu; the webview
    // handles them at window level so they work wherever focus is (editor,
    // preview or notes panel). The key text here is display only.
    ToolStripMenuItem MkMenu(string text, string keyHint, string cmd)
    {
        var it = new ToolStripMenuItem(text);
        if (keyHint != null) it.ShortcutKeyDisplayString = keyHint;
        it.Click += (s, e) => Post("menu\n" + cmd);
        return it;
    }

    // Items handled by the shell (open, new window, export, exit, ...).
    ToolStripMenuItem MkHost(string text, string keyHint, string cmd)
    {
        var it = new ToolStripMenuItem(text);
        if (keyHint != null) it.ShortcutKeyDisplayString = keyHint;
        it.Click += (s, e) => DoHostCmd(cmd);
        return it;
    }

    void DoHostCmd(string cmd)
    {
        if (cmd == "open") DoOpen();
        else if (cmd == "quit") Close();
        else if (cmd == "new-window") NewWindow();
        else if (cmd == "close-window") Close();
        else if (cmd == "close-tab") Post("menu\nclose-tab"); // Tab operations live in JS
        else if (cmd == "export") ExportDialog();
        else if (cmd.StartsWith("open-path\n")) OpenAsTab(cmd.Substring("open-path\n".Length));
        else if (cmd.StartsWith("import-failed\n"))
            MessageBox.Show(this, cmd.Substring("import-failed\n".Length), L.T("Conversion failed", "変換に失敗"));
        else Post("menu\n" + cmd);
    }

    // External URLs open in the default browser. Relative paths (e.g. a .md in the
    // same folder) are resolved against the active tab's file and opened in a new tab.
    void OpenExternal(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        if (System.Text.RegularExpressions.Regex.IsMatch(url, @"^[a-z][a-z0-9+.\-]*://", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            try { System.Diagnostics.Process.Start(url); } catch (Exception ex) { Log.W("OpenExternal: " + ex.Message); }
        }
        else if (url.StartsWith("#"))
        {
            // Links to headings are not handled
        }
        else
        {
            Post("menu\nopen-relative\n" + url); // JS resolves it against the active tab's path
        }
    }

    // Point doc.local at the folder of the open HTML file (for relative images and
    // CSS). An empty value removes the mapping.
    void SetDocBase(string dir)
    {
        if (web.CoreWebView2 == null) return;
        try
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            {
                web.CoreWebView2.ClearVirtualHostNameToFolderMapping("doc.local");
                docBaseDir = null;
                return;
            }
            web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "doc.local", dir, CoreWebView2HostResourceAccessKind.Allow);
            docBaseDir = dir;
        }
        catch (Exception ex) { Log.W("SetDocBase: " + ex.Message); }
    }

    void OpenFromPreviewFrame(string uri)
    {
        const string host = "https://doc.local/";
        if (!uri.StartsWith(host))
        {
            OpenExternal(uri);
            return;
        }
        // Because of <base>, in-page links (#heading) also become doc.local/#...; with
        // an empty path there is nothing to open (in-page jumps don't work).
        string rel = uri.Substring(host.Length);
        int cut = rel.IndexOfAny(new[] { '#', '?' });
        if (cut >= 0) rel = rel.Substring(0, cut);
        if (rel.Length == 0 || docBaseDir == null) return;
        string full = Path.GetFullPath(Path.Combine(docBaseDir, Uri.UnescapeDataString(rel).Replace('/', '\\')));
        OpenAsTab(full);
    }

    void NewWindow()
    {
        // Start an independent window with --new (not part of the single instance).
        try { System.Diagnostics.Process.Start(Application.ExecutablePath, "--new"); }
        catch (Exception ex) { Log.W("NewWindow failed: " + ex.Message); }
    }

    void ExportDialog()
    {
        // Export in another format. JS converts the text to bytes for the chosen
        // extension (export-bytes) and the shell writes them.
        using (var dlg = new SaveFileDialog())
        {
            dlg.Filter = L.T("Markdown|*.md|Text|*.txt|Word|*.docx|HTML|*.html",
                             "Markdown|*.md|テキスト|*.txt|Word|*.docx|HTML|*.html");
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            string ext = Path.GetExtension(dlg.FileName).ToLowerInvariant();
            Post("export-request\n" + dlg.FileName + "\n" + ext);
        }
    }

    // Switch the UI language: save it, rebuild the menu and tell JS, which
    // re-renders its labels and re-sends the states behind the menu check marks.
    void SetLanguage(string lang)
    {
        L.Save(lang);
        var old = MainMenuStrip;
        var ms = BuildMenu();
        SuspendLayout();
        if (old != null) { Controls.Remove(old); old.Dispose(); }
        Controls.Add(ms);
        ResumeLayout();
        if (wantsJumpList) JumpList.TryRegister(Application.ExecutablePath);
        Post("lang\n" + L.Lang);
    }

    MenuStrip BuildMenu()
    {
        var ms = new MenuStrip();

        var file = new ToolStripMenuItem(L.T("&File", "ファイル(&F)"));
        file.DropDownItems.Add(MkMenu(L.T("&New tab", "新規タブ(&N)"), "Ctrl+N", "new"));
        file.DropDownItems.Add(MkHost(L.T("New window", "新しいウィンドウ"), "Ctrl+Shift+N", "new-window"));
        file.DropDownItems.Add(MkHost(L.T("&Open...", "開く(&O)..."), "Ctrl+O", "open"));
        file.DropDownItems.Add(MkMenu(L.T("&Save", "上書き保存(&S)"), "Ctrl+S", "save"));
        file.DropDownItems.Add(MkMenu(L.T("Save as...", "名前を付けて保存..."), "Ctrl+Shift+S", "save-as"));
        file.DropDownItems.Add(MkHost(L.T("Export as...", "形式を変換して保存..."), null, "export"));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(MkMenu(L.T("Print", "印刷"), "Ctrl+Shift+P", "print"));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(MkHost(L.T("Close tab", "タブを閉じる"), "Ctrl+W", "close-tab"));
        file.DropDownItems.Add(MkHost(L.T("Exit", "終了"), null, "quit"));

        var edit = new ToolStripMenuItem(L.T("&Edit", "編集(&E)"));
        edit.DropDownItems.Add(MkMenu(L.T("Undo", "元に戻す"), "Ctrl+Z", "undo"));
        edit.DropDownItems.Add(MkMenu(L.T("Redo", "やり直し"), "Ctrl+Y", "redo"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu(L.T("Cut", "切り取り"), "Ctrl+X", "cut"));
        edit.DropDownItems.Add(MkMenu(L.T("Copy", "コピー"), "Ctrl+C", "copy"));
        edit.DropDownItems.Add(MkMenu(L.T("Paste", "貼り付け"), "Ctrl+V", "paste"));
        edit.DropDownItems.Add(MkMenu(L.T("Select all", "すべて選択"), "Ctrl+A", "select-all"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu(L.T("Underline", "下線"), "Ctrl+U", "underline"));
        edit.DropDownItems.Add(MkMenu(L.T("Double underline", "下線（二重）"), "Ctrl+Shift+U", "underline-double"));
        edit.DropDownItems.Add(MkMenu(L.T("Underline selection (skip already underlined parts)", "選択範囲に一括で下線（引いてある部分は除く）"), null, "bulk-underline"));
        edit.DropDownItems.Add(MkMenu(L.T("Escape (exclude from the count)", "エスケープ（文字数から除外）"), "Ctrl+E", "esc"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu(L.T("Find", "検索"), "Ctrl+F", "find"));
        edit.DropDownItems.Add(MkMenu(L.T("Find next", "次を検索"), "F3", "find-next"));
        edit.DropDownItems.Add(MkMenu(L.T("Find previous", "前を検索"), "Shift+F3", "find-prev"));
        edit.DropDownItems.Add(MkMenu(L.T("Replace", "置換"), "Ctrl+H", "replace"));
        edit.DropDownItems.Add(MkMenu(L.T("Go to line", "行へ移動"), "Ctrl+G", "goto-line"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu(L.T("Date and time", "日付と時刻"), null, "date-time"));

        var view = new ToolStripMenuItem(L.T("&View", "表示(&V)"));
        // Check marks follow state messages from JS (editor / preview / wrap / memo).
        // Shortcut text is display only (the keys are handled in the webview).
        miEditor = new ToolStripMenuItem(L.T("Show editor", "エディタを表示"));
        miEditor.ShortcutKeyDisplayString = "Ctrl+Shift+E";
        miEditor.Checked = true;
        miEditor.Click += (s, e) => Post("menu\ntoggle-editor");
        view.DropDownItems.Add(miEditor);
        miPreview = new ToolStripMenuItem(L.T("Show preview", "プレビューを表示"));
        miPreview.ShortcutKeyDisplayString = "Ctrl+P";
        miPreview.Checked = true;
        miPreview.Click += (s, e) => Post("menu\ntoggle-preview");
        view.DropDownItems.Add(miPreview);
        miWrap = new ToolStripMenuItem(L.T("Word wrap", "右端で折り返す"));
        miWrap.Checked = true;
        miWrap.Click += (s, e) => Post("menu\ntoggle-wrap");
        view.DropDownItems.Add(miWrap);

        // Panes are laid out left to right in the order they were shown; JS (movePane) reorders them.
        var order = new ToolStripMenuItem(L.T("Pane order", "欄の並び"));
        order.DropDownItems.Add(MkMenu(L.T("Move editor left", "エディタを左へ"), null, "pane-move:editor:-1"));
        order.DropDownItems.Add(MkMenu(L.T("Move editor right", "エディタを右へ"), null, "pane-move:editor:1"));
        order.DropDownItems.Add(new ToolStripSeparator());
        order.DropDownItems.Add(MkMenu(L.T("Move preview left", "プレビューを左へ"), null, "pane-move:preview:-1"));
        order.DropDownItems.Add(MkMenu(L.T("Move preview right", "プレビューを右へ"), null, "pane-move:preview:1"));
        order.DropDownItems.Add(new ToolStripSeparator());
        order.DropDownItems.Add(MkMenu(L.T("Move notes left", "メモ広場を左へ"), null, "pane-move:memo:-1"));
        order.DropDownItems.Add(MkMenu(L.T("Move notes right", "メモ広場を右へ"), null, "pane-move:memo:1"));
        view.DropDownItems.Add(order);

        var memoMenu = new ToolStripMenuItem(L.T("Notes", "メモ広場"));
        miMemo = new ToolStripMenuItem(L.T("Show", "表示する"));
        miMemo.ShortcutKeyDisplayString = "Ctrl+M";
        miMemo.Click += (s, e) => Post("menu\ntoggle-memo");
        memoMenu.DropDownItems.Add(miMemo);
        miMemoEdit = new ToolStripMenuItem(L.T("Edit", "編集する"));
        miMemoEdit.Click += (s, e) => Post("menu\ntoggle-memo-edit");
        memoMenu.DropDownItems.Add(miMemoEdit);
        memoMenu.DropDownItems.Add(new ToolStripSeparator());
        var pickMemo = new ToolStripMenuItem(L.T("Choose file...", "ファイルを選択..."));
        pickMemo.Click += (s, e) => PickMemoFile();
        memoMenu.DropDownItems.Add(pickMemo);
        var resetMemo = new ToolStripMenuItem(L.T("Use the automatic file", "自動対応に戻す"));
        resetMemo.Click += (s, e) => Post("menu\nmemo-reset");
        memoMenu.DropDownItems.Add(resetMemo);
        view.DropDownItems.Add(memoMenu);

        view.DropDownItems.Add(new ToolStripSeparator());
        view.DropDownItems.Add(MkMenu(L.T("Zoom in", "拡大"), "Ctrl++", "zoom-in"));
        view.DropDownItems.Add(MkMenu(L.T("Zoom out", "縮小"), "Ctrl+-", "zoom-out"));
        view.DropDownItems.Add(MkMenu(L.T("Reset zoom", "既定の大きさに戻す"), "Ctrl+0", "zoom-reset"));
        var famMenu = new ToolStripMenuItem(L.T("Font", "書体"));
        foreach (var fam in new[] {
            "Yu Gothic UI", "Meiryo UI", "Meiryo", "ＭＳ ゴシック",
            "Yu Mincho", "ＭＳ 明朝", "BIZ UDPGothic", "BIZ UDPMincho" })
        {
            var f = fam;
            var fi = new ToolStripMenuItem(f);
            fi.Click += (s, e) => Post("menu\nfamily:" + f);
            famMenu.DropDownItems.Add(fi);
        }
        view.DropDownItems.Add(famMenu);

        // Each language is labeled in its own language so it can be found either way.
        // The switch runs after the click finishes, because it replaces this menu.
        var langMenu = new ToolStripMenuItem("Language / 言語");
        foreach (var pair in new[] { new[] { "en", "English" }, new[] { "ja", "日本語" } })
        {
            string code = pair[0];
            var li = new ToolStripMenuItem(pair[1]);
            li.Checked = L.Lang == code;
            li.Click += (s, e) => BeginInvoke((Action)(() => SetLanguage(code)));
            langMenu.DropDownItems.Add(li);
        }
        view.DropDownItems.Add(new ToolStripSeparator());
        view.DropDownItems.Add(langMenu);

        ms.Items.Add(file);
        ms.Items.Add(edit);
        ms.Items.Add(view);
        MainMenuStrip = ms;
        return ms;
    }

    async void InitAsync()
    {
        try
        {
            await InitCore();
        }
        catch (Exception ex)
        {
            Log.W("InitAsync EXCEPTION: " + ex);
            MessageBox.Show(this, ex.ToString(), L.T("WebView2 failed to initialize", "WebView2 初期化に失敗"));
        }
    }

    async Task InitCore()
    {
        Log.W("InitCore start");
        // Keep the WebView2 profile in a fixed folder under %APPDATA% (not %TEMP%) so
        // its caches stay warm between launches.
        string userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "croco-editor", "wv2");
        var env = await CoreWebView2Environment.CreateAsync(null, userData, null);
        await web.EnsureCoreWebView2Async(env);
        Log.W("CoreWebView2 ready, runtime=" + web.CoreWebView2.Environment.BrowserVersionString);

        string distDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dist");
        Log.W("distDir=" + distDir + " exists=" + Directory.Exists(distDir));
        web.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.local", distDir, CoreWebView2HostResourceAccessKind.Allow);

        var s = web.CoreWebView2.Settings;
        s.AreDefaultContextMenusEnabled = false;
        s.IsStatusBarEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false; // Keep Ctrl+P etc. from going to the browser

        web.CoreWebView2.WebMessageReceived += OnWebMessage;
        // If the webview itself tries to navigate away from app.local (e.g. a link in
        // the preview), cancel it and open external URLs in the default browser.
        web.CoreWebView2.NavigationStarting += (_, e) =>
        {
            var uri = e.Uri ?? "";
            if (uri.StartsWith("https://app.local/") || uri.StartsWith("about:")) return;
            e.Cancel = true;
            OpenExternal(uri);
        };
        // Links inside the HTML preview (iframe): never navigate the iframe itself.
        // External URLs go to the default browser, files on doc.local (the open HTML
        // file's folder) open in a tab. Only the initial srcdoc load (about:) passes.
        web.CoreWebView2.FrameNavigationStarting += (_, e) =>
        {
            var uri = e.Uri ?? "";
            if (uri.StartsWith("about:") || uri.StartsWith("data:")) return;
            e.Cancel = true;
            OpenFromPreviewFrame(uri);
        };
        web.CoreWebView2.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri ?? "");
        };
        web.CoreWebView2.NavigationCompleted += (_, e) =>
        {
            Log.W("NavigationCompleted success=" + e.IsSuccess + " err=" + e.WebErrorStatus);
            if (navigated) return;
            navigated = true;
            if (!string.IsNullOrEmpty(restoreJson) && restoreJson.Trim().Length > 0)
            {
                Post("restore\n" + restoreJson);   // Restore the previous tabs
                if (currentPath != null) OpenAsTab(currentPath); // A file given on the command line opens as an extra tab
            }
            else
            {
                SendInitialLoad();
            }
            foreach (var p in pendingHandoff) OpenAsTab(p); // Replay handoffs that arrived before the page was ready
            pendingHandoff.Clear();
        };
        string url = "https://app.local/index.html?lang=" + L.Lang;
        if (Environment.GetEnvironmentVariable("CROCO_SELFTEST") == "1") url += "&selftest=1";
        Log.W("navigate " + url);
        web.CoreWebView2.Navigate(url);
    }

    // Check for a BOM first; otherwise try strict UTF-8, then cp932. Japanese text is
    // not always UTF-8, and reading BOM-less Shift-JIS as UTF-8 would garble it and
    // autosave would write the garbage back.
    // Saving always uses UTF-8, so characters the original encoding can't represent
    // can still be saved.
    static string ReadTextSmart(string path)
    {
        byte[] raw = File.ReadAllBytes(path);
        if (raw.Length >= 2 && raw[0] == 0xFF && raw[1] == 0xFE)
            return Encoding.Unicode.GetString(raw, 2, raw.Length - 2); // UTF-16 LE
        if (raw.Length >= 2 && raw[0] == 0xFE && raw[1] == 0xFF)
            return Encoding.BigEndianUnicode.GetString(raw, 2, raw.Length - 2); // UTF-16 BE

        try
        {
            // Strip a BOM if present and decode as strict UTF-8.
            bool hasBom = raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF;
            var strictUtf8 = new UTF8Encoding(false, true); // throwOnInvalidBytes
            return hasBom ? strictUtf8.GetString(raw, 3, raw.Length - 3) : strictUtf8.GetString(raw);
        }
        catch (DecoderFallbackException) { }
        catch (ArgumentException) { } // empty / invalid range

        try
        {
            var strictSjis = Encoding.GetEncoding(
                932, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
            return strictSjis.GetString(raw);
        }
        catch (Exception) { } // not valid cp932 either

        return Encoding.UTF8.GetString(raw); // Last resort: decode with replacement characters
    }

    void RememberMtime(string path)
    {
        try { knownMtime[Path.GetFullPath(path)] = File.GetLastWriteTimeUtc(path); }
        catch (Exception ex) { Log.W("RememberMtime: " + ex.Message); }
    }

    // Write to a temp file, then replace, so a crash mid-write never corrupts the
    // original. Used for documents, exports and the session (notes are written directly).
    static void WriteFileAtomic(string path, byte[] data)
    {
        string temp = path + ".croco-tmp";
        File.WriteAllBytes(temp, data);
        try
        {
            if (File.Exists(path)) File.Replace(temp, path, null);
            else File.Move(temp, path);
        }
        catch
        {
            try { if (File.Exists(temp)) File.Delete(temp); } catch { }
            throw;
        }
    }

    static void WriteTextAtomic(string path, string text, Encoding enc)
    {
        WriteFileAtomic(path, enc.GetBytes(text));
    }

    // First tab at startup. The front end (main.js) owns the tabs; the shell just
    // reads the file and passes it on.
    void SendInitialLoad()
    {
        string path = "", crlf = "0", text = "";
        string ext = currentPath != null ? Path.GetExtension(currentPath).ToLowerInvariant() : "";
        bool importFmt = ext == ".docx" || ext == ".zip"; // .html/.htm are opened as-is, not imported
        if (currentPath != null && File.Exists(currentPath) && !importFmt)
        {
            string raw = ReadTextSmart(currentPath); // BOM detection + cp932 fallback
            crlf = raw.Contains("\r\n") ? "1" : "0";
            text = raw.Replace("\r\n", "\n");
            path = currentPath;
            RememberMtime(currentPath);
        }
        else if (importFmt)
        {
            BeginInvoke((Action)(() => OpenAsTab(currentPath))); // Import it into a new tab
        }
        Log.W("SendInitialLoad path=" + (path == "" ? "(new)" : path) + " textLen=" + text.Length);
        Post("load\n" + path + "\n" + crlf + "\n" + text);
    }

    // Split on "\n" into n-1 fields plus the rest (which may contain newlines).
    static string[] SplitN(string s, int n)
    {
        var parts = new System.Collections.Generic.List<string>();
        string rest = s;
        for (int i = 0; i < n - 1; i++)
        {
            int k = rest.IndexOf('\n');
            if (k < 0) { parts.Add(rest); rest = ""; }
            else { parts.Add(rest.Substring(0, k)); rest = rest.Substring(k + 1); }
        }
        parts.Add(rest);
        return parts.ToArray();
    }

    void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); }
        catch { return; }
        if (msg == null) return;
        Log.W("recv: " + (msg.Length > 48 ? msg.Substring(0, 48).Replace("\n", "\\n") + "..." : msg.Replace("\n", "\\n")));

        if (msg == "open") { DoOpen(); return; }

        int nl = msg.IndexOf('\n');
        string head = nl < 0 ? msg : msg.Substring(0, nl);
        string body = nl < 0 ? "" : msg.Substring(nl + 1);

        if (head == "diag") Log.W("JS " + body);
        else if (head == "title") SetTitleFromJs(SplitN(body, 2));
        else if (head == "session") { lastSessionJson = body; ScheduleSessionSave(); }
        else if (head == "anydirty") anyDirty = body.Trim() == "1";
        else if (head == "wrap") { if (miWrap != null) miWrap.Checked = body.Trim() == "1"; }
        else if (head == "preview") { if (miPreview != null) miPreview.Checked = body.Trim() == "1"; }
        else if (head == "editor") { if (miEditor != null) miEditor.Checked = body.Trim() == "1"; }
        else if (head == "memowrap") { if (miMemo != null) miMemo.Checked = body.Trim() == "1"; }
        else if (head == "memoedit") { if (miMemoEdit != null) miMemoEdit.Checked = body.Trim() == "1"; }
        else if (head == "memo-watch") ConfigureMemo(SplitN(body, 5));
        else if (head == "memo-save") SaveMemo(body);
        else if (head == "docbase") SetDocBase(body.Trim());
        else if (head == "export-bytes")
        {
            var p = SplitN(body, 2);
            try
            {
                WriteFileAtomic(p[0], Convert.FromBase64String(p[1]));
                Log.W("exported " + p[0]);
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, L.T("Export failed", "書き出しに失敗")); }
        }
        else if (head == "host")
        {
            if (body.StartsWith("ask-close\n")) AskCloseTab(SplitN(body.Substring("ask-close\n".Length), 2));
            else DoHostCmd(body.Trim());
        }
        else if (head == "save") DoSave(SplitN(body, 4), alwaysAsk: false);
        else if (head == "saveas") DoSave(SplitN(body, 4), alwaysAsk: true);
    }

    void AskCloseTab(string[] p)
    {
        string id = p.Length > 0 ? p[0] : "";
        string name = p.Length > 1 ? p[1] : L.T("Untitled", "無題");
        var r = MessageBox.Show(this, L.T("\"" + name + "\" has not been saved. Save it?", "「" + name + "」は保存していません。保存しますか？"),
            "croco-editor", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
        if (r == DialogResult.Cancel) return;
        Post("menu\nclose-decision\n" + id + "\n" + (r == DialogResult.Yes ? "save" : "discard"));
    }

    void SetTitleFromJs(string[] p)
    {
        string name = p.Length > 0 ? p[0] : L.T("Untitled", "無題");
        bool d = p.Length > 1 && p[1].Trim() == "1";
        Text = (d ? "*" : "") + name + " - croco-editor";
    }

    void DoOpen()
    {
        using (var dlg = new OpenFileDialog())
        {
            // List every supported format up front so people can see what opens.
            dlg.Filter = L.T(
                "All supported files|*.md;*.markdown;*.txt;*.json;*.tasks;*.docx;*.html;*.htm;*.zip|" +
                "Text / Markdown|*.md;*.markdown;*.txt|" +
                "JSON / Tasks|*.json;*.tasks|" +
                "Word (.docx)|*.docx|" +
                "HTML|*.html;*.htm|" +
                "Zipped HTML export (imported as Markdown)|*.zip|" +
                "All files|*.*",
                "開けるすべての形式|*.md;*.markdown;*.txt;*.json;*.tasks;*.docx;*.html;*.htm;*.zip|" +
                "テキスト/Markdown|*.md;*.markdown;*.txt|" +
                "JSON / タスク|*.json;*.tasks|" +
                "Word (.docx)|*.docx|" +
                "HTML|*.html;*.htm|" +
                "HTML書き出しのzip（Markdownに取り込む）|*.zip|" +
                "すべてのファイル|*.*");
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            OpenAsTab(dlg.FileName);
        }
    }

    // Ask JS to open the file in a new tab. Reference files (.json/.tasks/README.md)
    // open in their own window.
    void OpenAsTab(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) { Log.W("OpenAsTab skip: " + path); return; }
        if (Program.WantsOwnWindow(path))
        {
            try { System.Diagnostics.Process.Start(Application.ExecutablePath, "--new \"" + path + "\""); }
            catch (Exception ex) { Log.W("own-window launch failed: " + ex.Message); }
            return;
        }
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".docx" || ext == ".zip")
        {
            // Importing (docformats) happens in JS; pass the bytes as base64.
            // .html/.htm don't come here (they are opened as text below).
            byte[] bytes = File.ReadAllBytes(path);
            Log.W("import -> " + path + " bytes=" + bytes.Length);
            Post("import\n" + path + "\n" + ext + "\n" + Convert.ToBase64String(bytes));
            return;
        }
        string raw = ReadTextSmart(path);
        string crlf = raw.Contains("\r\n") ? "1" : "0";
        RememberMtime(path);
        Log.W("OpenAsTab -> " + path + " chars=" + raw.Length);
        Post("opened\n" + path + "\n" + crlf + "\n" + raw.Replace("\r\n", "\n"));
    }

    // Handoff from another instance: open in a new tab and bring the window to the front.
    public void Handoff(string path)
    {
        Log.W("handoff: " + (path ?? ""));
        if (!navigated) { if (!string.IsNullOrWhiteSpace(path)) pendingHandoff.Add(path); }
        else OpenAsTab(path);

        // Restoring from minimized also undoes snap/maximize, so only restore when minimized.
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        bool t = TopMost;
        TopMost = true;
        TopMost = t; // Briefly set TopMost to make sure it comes to the front
    }

    // save\n<reqId>\n<crlf>\n<path>\n<text>
    void DoSave(string[] p, bool alwaysAsk)
    {
        string reqId = p.Length > 0 ? p[0] : "0";
        bool crlf = p.Length > 1 && p[1] == "1";
        string path = p.Length > 2 ? p[2] : "";
        string text = p.Length > 3 ? p[3] : "";
        string body = text.Replace("\r\n", "\n");

        string target = path;
        if (alwaysAsk || string.IsNullOrEmpty(target))
        {
            using (var dlg = new SaveFileDialog())
            {
                dlg.Filter = L.T("Markdown|*.md|HTML|*.html;*.htm|Text|*.txt|All files|*.*",
                                 "Markdown|*.md|HTML|*.html;*.htm|テキスト|*.txt|すべてのファイル|*.*");
                dlg.FileName = string.IsNullOrEmpty(path) ? L.T("Untitled.md", "無題.md") : Path.GetFileName(path);
                if (dlg.ShowDialog(this) != DialogResult.OK) return; // No "saved" reply: the tab stays as it is
                target = dlg.FileName;
            }
        }
        else
        {
            // If the file's mtime differs from our last read or write, something else
            // changed it, and overwriting would silently discard that change. Whether
            // this is an autosave or an explicit save, ask which version to keep.
            // Choosing Cancel sets the tab's conflict flag and JS stops autosaving
            // that tab, so the question isn't repeated while typing.
            string full = Path.GetFullPath(target);
            DateTime known;
            if (File.Exists(full) && knownMtime.TryGetValue(full, out known))
            {
                DateTime disk = File.GetLastWriteTimeUtc(full);
                if (disk != known)
                {
                    Log.W("save conflict detected, asking: " + full);
                    var r = MessageBox.Show(this,
                        L.T("\"" + Path.GetFileName(full) + "\" has also been changed outside croco-editor.\n\n" +
                            "Yes: overwrite it with your version (the external changes are lost)\n" +
                            "No: load the external version (this tab's unsaved changes are lost)\n" +
                            "Cancel: leave it for now (save again later)",
                            "「" + Path.GetFileName(full) + "」は外部でも変更されています。\n\n" +
                            "はい：自分の内容で上書きする（外部の変更は消えます）\n" +
                            "いいえ：外部の内容を読み込む（このタブの未保存の変更は消えます）\n" +
                            "キャンセル：このまま保留する（あとでもう一度保存し直す）"),
                        "croco-editor", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
                    if (r == DialogResult.Cancel)
                    {
                        // Leave it pending: flag the conflict so JS stops autosaving this
                        // tab (otherwise every idle tick would ask again).
                        Post("conflict\n" + reqId + "\n" + full);
                        return;
                    }
                    if (r == DialogResult.No)
                    {
                        string fresh = ReadTextSmart(full);
                        RememberMtime(full);
                        string freshCrlf = fresh.Contains("\r\n") ? "1" : "0";
                        Post("reloaded\n" + reqId + "\n" + freshCrlf + "\n" + fresh.Replace("\r\n", "\n"));
                        return;
                    }
                    // Yes: fall through and overwrite
                }
            }
        }

        if (crlf) body = body.Replace("\n", "\r\n"); // Keep the original line endings
        WriteTextAtomic(target, body, new UTF8Encoding(false));
        RememberMtime(target); // Record the mtime we just wrote (baseline for the next conflict check)
        Log.W("wrote " + target + " chars=" + body.Length);
        Post("saved\n" + reqId + "\n" + target);
    }

    void Post(string message)
    {
        if (web.CoreWebView2 == null) return;
        if (InvokeRequired) { BeginInvoke((Action)(() => Post(message))); return; }
        web.CoreWebView2.PostWebMessageAsString(message);
    }

    void UpdateTitle()
    {
        string name = currentPath != null ? Path.GetFileName(currentPath) : L.T("Untitled", "無題");
        Text = name + " - croco-editor";
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (sessionSaveTimer != null) sessionSaveTimer.Stop();
        // --new windows must not overwrite the main session; otherwise closing a
        // README.md/.tasks window would replace it with that single tab.
        if (!selfTest && participatesSingleInstance) SaveSession(); // Keep tabs and window position

        // With autosave, unsaved changes here are rare (only new untitled tabs).
        if (anyDirty && !closingConfirmed)
        {
            var r = MessageBox.Show(this, L.T("You have unsaved changes. Save them?", "保存していない変更があります。保存しますか？"),
                "croco-editor", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
            if (r == DialogResult.Cancel) { e.Cancel = true; return; }
            if (r == DialogResult.Yes)
            {
                Post("flushSave");      // JS sends back a save for the active tab
                e.Cancel = true;
                return;
            }
            closingConfirmed = true;   // "No": close without saving
        }
        base.OnFormClosing(e);
    }
}
