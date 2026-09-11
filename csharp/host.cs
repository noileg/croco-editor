// croco-editor の C# 殻。WinForms のウィンドウが WebView2 コントロールを
// 1個持ち、dist/ のフロント（CodeMirror + プレビュー）を表示する。
// ファイル入出力・ダイアログ・タイトルはこちら、編集と字数計算は webview 側。
//
// ビルド: build.cmd（Windows 同梱の csc.exe。.NET SDK 不要）。
//
// JS ⇔ 殻 の文字列プロトコルは bridge.js の冒頭にまとめてある。
//
// 単一インスタンス：2枚目以降の起動は、開こうとしたファイルのパスを
// 既存インスタンスの「本物のウィンドウ」（MainForm）へ WM_COPYDATA で渡し、
// 自分は終了する。最初のインスタンスはそれを新しいタブとして開き、
// ウィンドウを前面に出す。`--new` を付けて起動した窓はこの仕組みに
// 参加しない（常に独立。現行 editor_app の「使い捨て窓」）。
//
// 名前付きパイプ＋別窓ではなくこの方式にした理由（2026-09-11、本人との検討）：
// Chromium/Electron・Notepad++ 等が実際に使っている定番（ウィンドウ宛の
// WM_COPYDATA。SendMessage は配送を同期確認できる）に、本人の指摘
// 「そもそも窓だけ最初に開いとけばいい」を足した形。受け渡し専用の別窓は
// 作らない。MainForm 自身のハンドルが生成された瞬間（Application.Run の
// 最初期＝WebView2初期化よりずっと前）に自分へ目印（SetProp）を立てる
// （MainForm.OnHandleCreated → Program.MarkAsMainWindow）。敗者側は
// EnumWindows でその目印を探す（FindMainWindow）。パイプサーバのスレッド
// 寿命・インスタンス数上限まわりで起きていた「渡したのに消える」不具合の
// 芽がそもそも無い。「勝者はいるが目印がまだ無い」隙間は数十ms程度に縮む。
// それでも間に合わなかった場合は敗者側が数秒だけ探しにいき（待ちは
// ここだけ）、見つからなければパスを捨てずに自分の窓を単独で開く
// （単一インスタンス不参加へフォールバック）。

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
    // editor_app.py APP_ID と同じ役割（タスクバーのアプリ識別・ジャンプリストの
    // 紐付け先）。旧版と同一文字列にする理由は無い（別アプリとして扱われて
    // よい）ので croco-editor 用に新規に決める。
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
        // editor_app.py _claim_app_identity と同じ理由・同じ位置（窓を作る前）。
        // 呼ばないとタスクバーのアイコン/グループ化が既定のものになり、
        // ジャンプリスト（タスクバー右クリックのタスク）も出ない。
        try { SetCurrentProcessExplicitAppUserModelID(AppId); } catch { }

        var args = Environment.GetCommandLineArgs();
        bool newWindow = args.Contains("--new");
        string path = null;
        foreach (var a in args.Skip(1))
        {
            if (a != "--new" && !string.IsNullOrWhiteSpace(a)) { path = a; break; }
        }

        // 参照物（.json / .tasks / README.md）はメイン窓のタブに混ぜず、独立した
        // 窓で開く（現行 editor_app.wants_own_window）。＝ --new 扱いにする。
        if (WantsOwnWindow(path)) newWindow = true;

        // タスクバー右クリックの「新しいウィンドウ」の登録要否（旧版 launcher.cs
        // と同じ条件＝ --new 自身では不要）。実際の登録は MainForm 生成後、
        // ウィンドウが動き出してから行う（下の Application.Run のコメント参照）。
        bool wantsJumpList = !args.Contains("--new");

        if (!newWindow)
        {
            bool isFirst;
            mutex = new Mutex(true, MutexName, out isFirst);
            if (!isFirst)
            {
                if (TryHandoff(path)) return; // 既存の窓へ渡せた。ここで終了。
                // 数秒探しても見つからなかった／勝者が消えていた。
                // パスは捨てず、このプロセスが単独で窓を開く（単一インスタンス不参加）。
                newWindow = true;
            }
        }

        Log.Reset();
        Log.W("Main start newWindow=" + newWindow + " path=" + (path ?? ""));

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // MainForm 自身が受け口を兼ねる（別窓は作らない）。ハンドル生成時に
        // 自分で目印を立てる（OnHandleCreated → MarkAsMainWindow）。生成は
        // Application.Run が最初にやることの一つで、WebView2 の初期化より
        // ずっと前に終わる。「勝者はいるが受け口がまだ無い」隙間はここに収まる。
        //
        // ジャンプリスト登録（COM、ショートカットのファイルI/O込みでミリ秒
        // オーダーかかる）はここより前段（Mutex判定やハンドオフ）でやると、
        // その隙間をまた広げてしまう（2026-09-11、レビューで発覚：単一インスタンス
        // 修正の趣旨と矛盾していた）。ウィンドウ生成後に MainForm 側で遅延実行する。
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

    // MainForm.OnHandleCreated から呼ばれる。自分のウィンドウに目印を立てる
    // だけ（SetProp はウィンドウのプロパティリストに1エントリ足すだけで、
    // 別ウィンドウを作るより軽い）。
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

    // 敗者側。勝者の窓を最大5秒探し、見つかり次第 WM_COPYDATA で渡す。
    // 通常系（既に窓がある）は1回目の EnumWindows で即見つかるので待たない。
    // 待つのは「Mutex は取られたが窓の目印がまだ無い」冷間バーストの隙間だけ。
    static bool TryHandoff(string path)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        IntPtr hwnd;
        while (true)
        {
            hwnd = FindMainWindow();
            if (hwnd != IntPtr.Zero) break;
            if (!WinnerAlive()) { Log.W("handoff 断念: 勝者が見当たらない"); return false; }
            if (DateTime.UtcNow > deadline) { Log.W("handoff 断念: 窓が見つからず"); return false; }
            Thread.Sleep(50);
        }

        string p = path ?? "";
        IntPtr buf = Marshal.StringToHGlobalUni(p);
        try
        {
            var cds = new COPYDATASTRUCT();
            cds.dwData = IntPtr.Zero;
            cds.cbData = (p.Length + 1) * 2; // UTF-16 + 終端null
            cds.lpData = buf;
            SendMessage(hwnd, WM_COPYDATA, IntPtr.Zero, ref cds);
            return true;
        }
        catch (Exception ex) { Log.W("handoff 送信失敗: " + ex.Message); return false; }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // Main 開始前（Log.Reset 前）に呼ばれ得るのでログに頼らず判定する。
    static bool WinnerAlive()
    {
        try { using (Mutex.OpenExisting(MutexName)) return true; }
        catch (WaitHandleCannotBeOpenedException) { return false; }
        catch (UnauthorizedAccessException) { return true; } // 存在はする
    }
}

// --- タスクバーのジャンプリスト（「新しいウィンドウ」タスク）-----------------
//
// 旧版 launcher.cs の JumpList をそのまま移植（COM=ICustomDestinationList
// 以外に方法が無い点も同じ）。croco-editor は launcher.csと違って本体exeが
// そのままショートカット先になる（別exeへ委譲しない）。2026-09-11、
// 実装漏れとして本人指摘。
static class JumpList
{
    const string LinkName = "croco-editor.lnk";

    // 通常起動のたびに呼ぶ。失敗しても黙って続ける。
    public static void TryRegister(string exePath)
    {
        try { EnsureShortcut(exePath); } catch { }
        try { CommitTasks(exePath); } catch { }
    }

    // ジャンプリストは AppUserModelID を持つショートカットがどこかに無いと
    // Windows が表示しない。スタートメニューに1つ置く。
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
        link.SetDescription("新しいウィンドウを開く");
        IPropertyStore store = (IPropertyStore)link;
        SetString(store, PkeyTitle, "新しいウィンドウ");
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
        if (hr < 0) throw new COMException(where + " が失敗 (HRESULT 0x"
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
    string currentPath;   // 起動時に argv で渡されたファイル（初期タイトル用）
    bool navigated;
    ToolStripMenuItem miPreview;   // 表示 › プレビュー（チェック）
    ToolStripMenuItem miWrap;      // 表示 › 右端で折り返す（チェック）
    ToolStripMenuItem miMemo;      // 表示 › メモ広場 › 表示する（チェック）
    ToolStripMenuItem miMemoEdit;  // 表示 › メモ広場 › 編集する（チェック）
    bool anyDirty;                 // どれかのタブが未保存か（JS から通知）
    bool closingConfirmed;         // 閉じる確認で「いいえ」を押した
    string lastSessionJson = "";   // JS から届く最新のセッション状態（殻は中身を見ない）
    string restoreJson;            // 起動時に読み込んだ前回のセッション（JS へ渡す）
    bool selfTest;
    readonly bool participatesSingleInstance; // 単一インスタンスの受け口を名乗るか（＝使い捨て窓でない）
    System.Windows.Forms.Timer sessionSaveTimer; // editor_app.py _schedule_save 相当（1500ms debounce）
    // 最後に自分が読み書きした時点の各ファイルの更新日時。外部変更の検知に使う
    // （editor_app.py Doc.mtime 相当）。キーは Path.GetFullPath 済みの絶対パス。
    readonly System.Collections.Generic.Dictionary<string, DateTime> knownMtime =
        new System.Collections.Generic.Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

    // --- メモ広場（claude_notes 連携） -----------------------------------
    // ノートの置き場所。外から書く CLI（claude_notes.mjs）と同じ場所を指す必要が
    // ある。既定は %APPDATA%\croco-editor\claude_notes、環境変数 CROCO_NOTE_DIR で
    // 上書き可。パスの計算（sha1 先頭16桁）は claude_notes.mjs の note_path と一致。
    static readonly string NoteDir =
        Environment.GetEnvironmentVariable("CROCO_NOTE_DIR")
        ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "croco-editor", "claude_notes");
    string memoDraftPath, memoOverride, memoNotePath;
    bool memoVisible, memoEditable;
    DateTime? memoMtime;
    System.Windows.Forms.Timer memoTimer;
    readonly System.Collections.Generic.List<string> pendingHandoff =
        new System.Collections.Generic.List<string>(); // webview 準備前に来た受け渡し

    static string SessionPath
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "croco-editor", "session.dat");
        }
    }

    // knownMtime の永続化先。editor_app.py は Doc.mtime を session.json に
    // 一緒に持たせて越境させているが、殻は session の JSON を解釈しない設計
    // なので別ファイルに分けて自前管理する（形式もJSONにしない）。
    // 1行 = "<mtime を UTC ticks で>\t<絶対パス>"。
    //
    // **これが無いと**：タブを閉じずにアプリだけ再起動したとき、復元された
    // タブは knownMtime に基準が無いまま復活し、次の自動保存で外部変更の
    // 検知（DoSave の conflict チェック）が素通りしてしまう＝アプリを閉じて
    // いた間に外部で書き換わった内容を無条件に上書きして消しかねない。
    // 2026-09-11、本人指摘で発覚。
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
        Controls.Add(BuildMenu()); // web を先に足してからメニューを上に載せる
        InitAsync();
    }

    // ハンドル生成はここが最初（Application.Run の最初期。WebView2初期化より
    // ずっと前）。単一インスタンスの受け口として名乗るのはこの一瞬でいい。
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (participatesSingleInstance) Program.MarkAsMainWindow(Handle);

        // ジャンプリスト登録（COM＋ファイルI/O）はここでは呼ばない＝
        // BeginInvoke でメッセージループに1回回してから（＝ウィンドウが
        // 実際に表示され始めてから）動かす。単一インスタンスの受け口に
        // なる／敗者からの WM_COPYDATA を受けられるようになるタイミングを
        // 遅らせないため（2026-09-11、レビューで発覚）。
        if (wantsJumpList)
        {
            BeginInvoke((Action)(() =>
            {
                try { JumpList.TryRegister(Application.ExecutablePath); }
                catch (Exception ex) { Log.W("JumpList.TryRegister: " + ex.Message); }
            }));
        }
    }

    // 別インスタンスからの WM_COPYDATA。自分のメッセージループの中＝
    // 既に UI スレッドなので BeginInvoke は要らない。
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

    // session.dat = 1行目 "x,y,w,h,max"、2行目以降が JS の JSON（殻は解釈しない）。
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
                if (r.IntersectsWith(vs)) // 画面外に復元しない
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
        // mtime基準を先に永続化してからタブ構成を保存する。逆順だと、両方の
        // 書き込みの間に落ちた場合に「タブは復元されるが基準が無い」
        // （＝競合検知が素通りする、2026-09-11に見つけた欠陥と同じ状態）が
        // 一瞬でも起きうる。この順なら万一そこで落ちても「基準はあるがタブが
        // 復元されない」で止まるだけ＝データは消えない。
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

    // editor_app.py _schedule_save 相当。「閉じる時だけ保存だとクラッシュ／
    // PCの強制終了で丸ごと消える」ため、session メッセージが来るたびに
    // 1500ms後（旧版と同じ間隔）のディスク書き込みを予約し直す。使い捨て窓
    // （--new。editor_app.py の ephemeral）は前回の続きを上書きしないので対象外。
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

    // --- メモ広場 ---------------------------------------------------------
    // claude_notes.note_path_for と同じ計算：下書きの絶対パスを posix 表記に
    // 直し casefold（ここでは ToLowerInvariant）して SHA1、先頭16桁 + ".md"。
    static string NotePathFor(string draftPath)
    {
        string posix = Path.GetFullPath(draftPath).Replace('\\', '/');
        string key = posix.ToLowerInvariant();
        using (var sha = SHA1.Create())
        {
            byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(key));
            var sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2")); // 16 hex 桁
            return Path.Combine(NoteDir, sb.ToString() + ".md");
        }
    }

    // memo-watch\n<下書きパス>\n<手動指定パス>\n<表示 0|1>\n<編集 0|1>
    void ConfigureMemo(string[] p)
    {
        memoDraftPath = p.Length > 0 && p[0].Length > 0 ? p[0] : null;
        memoOverride = p.Length > 1 && p[1].Length > 0 ? p[1] : null;
        memoVisible = p.Length > 2 && p[2].Trim() == "1";
        memoEditable = p.Length > 3 && p[3].Trim() == "1";

        memoNotePath = memoOverride != null
            ? memoOverride
            : (memoDraftPath != null ? NotePathFor(memoDraftPath) : null);
        memoMtime = null;
        Log.W("ConfigureMemo draft=" + (memoDraftPath ?? "-") + " note=" + (memoNotePath ?? "-") +
              " vis=" + memoVisible + " edit=" + memoEditable);

        if (memoTimer == null)
        {
            memoTimer = new System.Windows.Forms.Timer();
            memoTimer.Interval = 1000; // 現行と同じ 1 秒ポーリング
            memoTimer.Tick += (s, e) => MemoTick();
        }
        memoTimer.Enabled = memoVisible && !memoEditable && memoNotePath != null;

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

    void SendMemo(bool force)
    {
        if (memoNotePath == null)
        {
            Post("memo\nnone\n（保存された下書きにのみメモ広場が使えます）");
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

    // メニュー「メモ広場 › ファイルを選択...」
    void PickMemoFile()
    {
        using (var dlg = new OpenFileDialog())
        {
            dlg.Filter = "Markdown / テキスト|*.md;*.txt|すべてのファイル|*.*";
            if (Directory.Exists(NoteDir)) dlg.InitialDirectory = NoteDir;
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            Post("menu\nmemo-file\n" + dlg.FileName); // JS が override として持ち再 watch
        }
    }

    // メニュー項目。**ショートカットキーは Form/menu に持たせない。**
    // すべて webview 側の window レベル keydown で拾う（編集欄・プレビュー欄・
    // メモ欄のどこにフォーカスがあっても効くように。本人指摘）。ここは表示だけ。
    ToolStripMenuItem MkMenu(string text, string keyHint, string cmd)
    {
        var it = new ToolStripMenuItem(text);
        if (keyHint != null) it.ShortcutKeyDisplayString = keyHint;
        it.Click += (s, e) => Post("menu\n" + cmd);
        return it;
    }

    // 殻側で処理する項目（開く・新しいウィンドウ・形式変換・終了など）。
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
        else if (cmd == "close-tab") Post("menu\nclose-tab"); // タブ操作は JS 側
        else if (cmd == "export") ExportDialog();
        else if (cmd.StartsWith("open-path\n")) OpenAsTab(cmd.Substring("open-path\n".Length));
        else if (cmd.StartsWith("import-failed\n"))
            MessageBox.Show(this, cmd.Substring("import-failed\n".Length), "変換に失敗");
        else Post("menu\n" + cmd);
    }

    // 外部 URL は既定ブラウザ。相対パス（同フォルダの .md 等）は開いているタブの
    // ファイルからの相対で解決して新タブで開く（現行 open_link 相当）。
    void OpenExternal(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        if (System.Text.RegularExpressions.Regex.IsMatch(url, @"^[a-z][a-z0-9+.\-]*://", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            try { System.Diagnostics.Process.Start(url); } catch (Exception ex) { Log.W("OpenExternal: " + ex.Message); }
        }
        else if (url.StartsWith("#"))
        {
            // 見出しリンクは対象外
        }
        else
        {
            Post("menu\nopen-relative\n" + url); // JS がアクティブタブのパスから解決して要求
        }
    }

    void NewWindow()
    {
        // --new を付けて独立した窓として起動（単一インスタンスに参加しない）。
        try { System.Diagnostics.Process.Start(Application.ExecutablePath, "--new"); }
        catch (Exception ex) { Log.W("NewWindow failed: " + ex.Message); }
    }

    void ExportDialog()
    {
        // 形式を変換して保存。変換（docformats）は JS 側。拡張子ごとに
        // JS が本文をバイト列にして返す（export-bytes）→ 殻が書く。
        using (var dlg = new SaveFileDialog())
        {
            dlg.Filter = "Markdown|*.md|テキスト|*.txt|Word|*.docx|HTML|*.html";
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            string ext = Path.GetExtension(dlg.FileName).ToLowerInvariant();
            Post("export-request\n" + dlg.FileName + "\n" + ext);
        }
    }

    MenuStrip BuildMenu()
    {
        var ms = new MenuStrip();

        var file = new ToolStripMenuItem("ファイル(&F)");
        file.DropDownItems.Add(MkMenu("新規タブ(&N)", "Ctrl+N", "new"));
        file.DropDownItems.Add(MkHost("新しいウィンドウ", "Ctrl+Shift+N", "new-window"));
        file.DropDownItems.Add(MkHost("開く(&O)...", "Ctrl+O", "open"));
        file.DropDownItems.Add(MkMenu("上書き保存(&S)", "Ctrl+S", "save"));
        file.DropDownItems.Add(MkMenu("名前を付けて保存...", "Ctrl+Shift+S", "save-as"));
        file.DropDownItems.Add(MkHost("形式を変換して保存...", null, "export"));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(MkMenu("印刷", "Ctrl+Shift+P", "print"));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(MkHost("タブを閉じる", "Ctrl+W", "close-tab"));
        file.DropDownItems.Add(MkHost("終了", null, "quit"));

        var edit = new ToolStripMenuItem("編集(&E)");
        edit.DropDownItems.Add(MkMenu("元に戻す", "Ctrl+Z", "undo"));
        edit.DropDownItems.Add(MkMenu("やり直し", "Ctrl+Y", "redo"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu("切り取り", "Ctrl+X", "cut"));
        edit.DropDownItems.Add(MkMenu("コピー", "Ctrl+C", "copy"));
        edit.DropDownItems.Add(MkMenu("貼り付け", "Ctrl+V", "paste"));
        edit.DropDownItems.Add(MkMenu("すべて選択", "Ctrl+A", "select-all"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu("下線", "Ctrl+U", "underline"));
        edit.DropDownItems.Add(MkMenu("下線（二重）", "Ctrl+Shift+U", "underline-double"));
        edit.DropDownItems.Add(MkMenu("選択範囲に一括で下線（引いてある部分は除く）", null, "bulk-underline"));
        edit.DropDownItems.Add(MkMenu("エスケープ（文字数から除外）", "Ctrl+E", "esc"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu("検索", "Ctrl+F", "find"));
        edit.DropDownItems.Add(MkMenu("次を検索", "F3", "find-next"));
        edit.DropDownItems.Add(MkMenu("前を検索", "Shift+F3", "find-prev"));
        edit.DropDownItems.Add(MkMenu("置換", "Ctrl+H", "replace"));
        edit.DropDownItems.Add(MkMenu("行へ移動", "Ctrl+G", "goto-line"));
        edit.DropDownItems.Add(new ToolStripSeparator());
        edit.DropDownItems.Add(MkMenu("日付と時刻", null, "date-time"));

        var view = new ToolStripMenuItem("表示(&V)");
        // チェックは JS 側の状態メッセージ（preview / wrap / memo）で合わせる。
        // ショートカットは表示のみ（実処理は webview の window keydown）。
        miPreview = new ToolStripMenuItem("プレビューを表示");
        miPreview.ShortcutKeyDisplayString = "Ctrl+P";
        miPreview.Checked = true;
        miPreview.Click += (s, e) => Post("menu\ntoggle-preview");
        view.DropDownItems.Add(miPreview);
        miWrap = new ToolStripMenuItem("右端で折り返す");
        miWrap.Checked = true;
        miWrap.Click += (s, e) => Post("menu\ntoggle-wrap");
        view.DropDownItems.Add(miWrap);

        var memoMenu = new ToolStripMenuItem("メモ広場");
        miMemo = new ToolStripMenuItem("表示する");
        miMemo.ShortcutKeyDisplayString = "Ctrl+M";
        miMemo.Click += (s, e) => Post("menu\ntoggle-memo");
        memoMenu.DropDownItems.Add(miMemo);
        miMemoEdit = new ToolStripMenuItem("編集する");
        miMemoEdit.Click += (s, e) => Post("menu\ntoggle-memo-edit");
        memoMenu.DropDownItems.Add(miMemoEdit);
        memoMenu.DropDownItems.Add(new ToolStripSeparator());
        var pickMemo = new ToolStripMenuItem("ファイルを選択...");
        pickMemo.Click += (s, e) => PickMemoFile();
        memoMenu.DropDownItems.Add(pickMemo);
        var resetMemo = new ToolStripMenuItem("自動対応に戻す");
        resetMemo.Click += (s, e) => Post("menu\nmemo-reset");
        memoMenu.DropDownItems.Add(resetMemo);
        view.DropDownItems.Add(memoMenu);

        view.DropDownItems.Add(new ToolStripSeparator());
        view.DropDownItems.Add(MkMenu("拡大", "Ctrl++", "zoom-in"));
        view.DropDownItems.Add(MkMenu("縮小", "Ctrl+-", "zoom-out"));
        view.DropDownItems.Add(MkMenu("既定の大きさに戻す", "Ctrl+0", "zoom-reset"));
        var famMenu = new ToolStripMenuItem("書体");
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
            MessageBox.Show(this, ex.ToString(), "WebView2 初期化に失敗");
        }
    }

    async Task InitCore()
    {
        Log.W("InitCore start");
        // %TEMP% 直下だとプロファイルが安定せず、起動のたびにコード
        // キャッシュ等がコールドになりがち（2026-09-11、体感の遅さの原因調査）。
        // %APPDATA% 配下の固定パスにして、2回目以降の起動を温める。
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
        s.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+P 等をブラウザに取られない

        web.CoreWebView2.WebMessageReceived += OnWebMessage;
        // プレビュー内リンク等で webview 自身が app.local の外へ遷移しようと
        // したら止めて、外部 URL は既定ブラウザで開く（アプリが飛ばないように）。
        web.CoreWebView2.NavigationStarting += (_, e) =>
        {
            var uri = e.Uri ?? "";
            if (uri.StartsWith("https://app.local/") || uri.StartsWith("about:")) return;
            e.Cancel = true;
            OpenExternal(uri);
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
                Post("restore\n" + restoreJson);   // 前回のタブを復元
                if (currentPath != null) OpenAsTab(currentPath); // argv のファイルは追加タブ
            }
            else
            {
                SendInitialLoad();
            }
            foreach (var p in pendingHandoff) OpenAsTab(p); // 準備前に来た受け渡しを流す
            pendingHandoff.Clear();
        };
        string url = "https://app.local/index.html";
        if (Environment.GetEnvironmentVariable("CROCO_SELFTEST") == "1") url += "?selftest=1";
        Log.W("navigate " + url);
        web.CoreWebView2.Navigate(url);
    }

    // editor_app.py read_file の移植。BOMを先に見て、無ければ
    // utf-8-sig→utf-8→cp932 の順に試す（日本語のテキストはutf-8とは限らない。
    // BOM無しのShift-JISをそのままUTF-8として読むと文字化けし、自動保存で
    // 化けた内容が元ファイルへ上書きされる。2026-09-11、実装漏れとして発覚）。
    // 保存は常に utf-8（write_file と同じ理由：読めた文字コードのまま書き戻すと
    // そのコードで表せない文字を打った瞬間に保存できなくなる）。
    static string ReadTextSmart(string path)
    {
        byte[] raw = File.ReadAllBytes(path);
        if (raw.Length >= 2 && raw[0] == 0xFF && raw[1] == 0xFE)
            return Encoding.Unicode.GetString(raw, 2, raw.Length - 2); // UTF-16 LE
        if (raw.Length >= 2 && raw[0] == 0xFE && raw[1] == 0xFF)
            return Encoding.BigEndianUnicode.GetString(raw, 2, raw.Length - 2); // UTF-16 BE

        try
        {
            // utf-8-sig 相当：BOMがあれば剥がしてから厳密UTF-8として解釈。
            // BOM無しなら通常のUTF-8と同じ判定になる（Pythonのutf-8-sig/utf-8の
            // 2候補が実質同じ結果になるのと同じ）。
            bool hasBom = raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF;
            var strictUtf8 = new UTF8Encoding(false, true); // throwOnInvalidBytes
            return hasBom ? strictUtf8.GetString(raw, 3, raw.Length - 3) : strictUtf8.GetString(raw);
        }
        catch (DecoderFallbackException) { }
        catch (ArgumentException) { } // 空/不正な範囲

        try
        {
            var strictSjis = Encoding.GetEncoding(
                932, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
            return strictSjis.GetString(raw);
        }
        catch (Exception) { } // cp932としても不正

        return Encoding.UTF8.GetString(raw); // 最後の砦。既定の置換文字で読める形にする
    }

    void RememberMtime(string path)
    {
        try { knownMtime[Path.GetFullPath(path)] = File.GetLastWriteTimeUtc(path); }
        catch (Exception ex) { Log.W("RememberMtime: " + ex.Message); }
    }

    // editor_app.py write_bytes（一時ファイルに書いてから差し替える。途中で落ちても
    // 元のファイルを壊さない）と同じ規則。ドキュメント保存・形式変換保存・
    // セッション保存に使う。2026-09-11、実装漏れとして発覚・修正。
    // （メモ広場の保存は旧版 claude_notes.write_note も直接書きで揃っているので
    // atomicにはしない。旧版に無い安全策を新規に足すのは今回のスコープ外）
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

    // 起動時の最初のタブ。フロント（main.js）がタブを持つので、殻は
    // ファイルを読んで渡すだけ。
    void SendInitialLoad()
    {
        string path = "", crlf = "0", text = "";
        string ext = currentPath != null ? Path.GetExtension(currentPath).ToLowerInvariant() : "";
        bool importFmt = ext == ".docx" || ext == ".html" || ext == ".htm" || ext == ".zip";
        if (currentPath != null && File.Exists(currentPath) && !importFmt)
        {
            string raw = ReadTextSmart(currentPath); // BOM 判定＋cp932フォールバック
            crlf = raw.Contains("\r\n") ? "1" : "0";
            text = raw.Replace("\r\n", "\n");
            path = currentPath;
            RememberMtime(currentPath);
        }
        else if (importFmt)
        {
            BeginInvoke((Action)(() => OpenAsTab(currentPath))); // 未対応メッセージを出す
        }
        Log.W("SendInitialLoad path=" + (path == "" ? "(new)" : path) + " textLen=" + text.Length);
        Post("load\n" + path + "\n" + crlf + "\n" + text);
    }

    // "\n" 区切りで先頭 n-1 個を割り、残りを最後に入れる（本文は改行を含む）。
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
        else if (head == "memowrap") { if (miMemo != null) miMemo.Checked = body.Trim() == "1"; }
        else if (head == "memoedit") { if (miMemoEdit != null) miMemoEdit.Checked = body.Trim() == "1"; }
        else if (head == "memo-watch") ConfigureMemo(SplitN(body, 4));
        else if (head == "memo-save") SaveMemo(body);
        else if (head == "export-bytes")
        {
            var p = SplitN(body, 2);
            try
            {
                WriteFileAtomic(p[0], Convert.FromBase64String(p[1]));
                Log.W("exported " + p[0]);
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "書き出しに失敗"); }
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
        string name = p.Length > 1 ? p[1] : "無題";
        var r = MessageBox.Show(this, "「" + name + "」は保存していません。保存しますか？",
            "croco-editor", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
        if (r == DialogResult.Cancel) return;
        Post("menu\nclose-decision\n" + id + "\n" + (r == DialogResult.Yes ? "save" : "discard"));
    }

    void SetTitleFromJs(string[] p)
    {
        string name = p.Length > 0 ? p[0] : "無題";
        bool d = p.Length > 1 && p[1].Trim() == "1";
        Text = (d ? "*" : "") + name + " - croco-editor";
    }

    void DoOpen()
    {
        using (var dlg = new OpenFileDialog())
        {
            // editor_app.py open_dialog のフィルタ一覧と揃える（docx/html/zipが
            // 既定の一覧に出ないと、開けること自体を知らないまま「すべてのファイル」
            // へ切り替えないと見つからない）。
            dlg.Filter = "開けるすべての形式|*.md;*.markdown;*.txt;*.json;*.tasks;*.docx;*.html;*.htm;*.zip|" +
                         "テキスト/Markdown|*.md;*.markdown;*.txt|" +
                         "JSON / タスク|*.json;*.tasks|" +
                         "Word (.docx)|*.docx|" +
                         "HTML（Docsのウェブページ書き出し）|*.html;*.htm;*.zip|" +
                         "すべてのファイル|*.*";
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            OpenAsTab(dlg.FileName);
        }
    }

    // 指定パスを読み込んで新しいタブとして開くよう JS に伝える。
    // 参照物（.json/.tasks/README.md）は独立した窓で開く。
    void OpenAsTab(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) { Log.W("OpenAsTab skip: " + path); return; }
        if (Program.WantsOwnWindow(path))
        {
            try { System.Diagnostics.Process.Start(Application.ExecutablePath, "--new \"" + path + "\""); }
            catch (Exception ex) { Log.W("own-window 起動失敗: " + ex.Message); }
            return;
        }
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".docx" || ext == ".html" || ext == ".htm" || ext == ".zip")
        {
            // 取り込み（docformats）は JS 側。バイトを base64 で渡す。
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

    // 別インスタンスからの受け渡し。新しいタブで開き、ウィンドウを前面へ。
    public void Handoff(string path)
    {
        Log.W("handoff: " + (path ?? ""));
        if (!navigated) { if (!string.IsNullOrWhiteSpace(path)) pendingHandoff.Add(path); }
        else OpenAsTab(path);

        // CLAUDE.md: 最小化を解く操作はスナップ/最大化も解くので、最小化時だけ戻す。
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        bool t = TopMost;
        TopMost = true;
        TopMost = t; // 一瞬 TopMost にして確実に前面へ
    }

    // save\n<reqId>\n<crlf>\n<path>\n<本文>
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
                dlg.Filter = "Markdown|*.md|テキスト|*.txt|すべてのファイル|*.*";
                dlg.FileName = string.IsNullOrEmpty(path) ? "無題.md" : Path.GetFileName(path);
                if (dlg.ShowDialog(this) != DialogResult.OK) return; // saved を返さない＝据え置き
                target = dlg.FileName;
            }
        }
        else
        {
            // ディスクの mtime が最後に自分が読み書きした時点と違えば、外部
            // （別のエディタ等）でも書き換わっているということ。ここで上書き
            // するとその変更を黙って消す。editor_app.py _autosave_files の
            // 「無条件の上書きはしない」を踏襲（2026-09-11、実装漏れとして発覚）。
            //
            // 自動保存（idle timer）・明示保存（Ctrl+S 等）を問わず、検知したら
            // その場でどちらを残すか選ばせる（VS Code の「比較／上書き」相当。
            // 本人指摘：バックアップを残すだけでは「委ねる」の名ばかり、選ばせる
            // 方が本質。「打っている最中に割り込む」問題は別の形で塞がっている
            // ——ダイアログで保留（キャンセル）を選ぶと conflict フラグが立ち、
            // JS 側 scheduleAutosave が以後この保留中タブの自動保存を止めるので、
            // 打ち続けても同じ会話が毎回のidle tickで出し直されはしない）。
            string full = Path.GetFullPath(target);
            DateTime known;
            if (File.Exists(full) && knownMtime.TryGetValue(full, out known))
            {
                DateTime disk = File.GetLastWriteTimeUtc(full);
                if (disk != known)
                {
                    Log.W("save 競合検出・選択を出す: " + full);
                    var r = MessageBox.Show(this,
                        "「" + Path.GetFileName(full) + "」は外部でも変更されています。\n\n" +
                        "はい：自分の内容で上書きする（外部の変更は消えます）\n" +
                        "いいえ：外部の内容を読み込む（このタブの未保存の変更は消えます）\n" +
                        "キャンセル：このまま保留する（あとでもう一度保存し直す）",
                        "croco-editor", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
                    if (r == DialogResult.Cancel)
                    {
                        // 保留：conflict を立てて JS 側の自動保存を止める
                        // （キャンセルするたびに毎回また聞かれるのを防ぐ）。
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
                    // はい：このまま下へ落ちて上書きする
                }
            }
        }

        if (crlf) body = body.Replace("\n", "\r\n"); // 元の改行を保つ
        WriteTextAtomic(target, body, new UTF8Encoding(false));
        RememberMtime(target); // 自分で書いた直後の mtime を覚え直す（次回の競合判定の基準）
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
        string name = currentPath != null ? Path.GetFileName(currentPath) : "無題";
        Text = name + " - croco-editor";
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (sessionSaveTimer != null) sessionSaveTimer.Stop();
        // 使い捨て窓（--new）は前回の続きを上書きしない（editor_app.py ephemeral）。
        // これを guard し忘れると、README.md/.tasks 等の独立窓を閉じるたびに
        // 本来のセッションが単一タブの内容で踏み潰されるバグになる。
        if (!selfTest && participatesSingleInstance) SaveSession(); // タブ構成・ウィンドウ位置を残す

        // 自動保存が効いているので通常ここで未保存はまず無い（新規の無題タブに
        // 書きかけがある場合のみ）。
        if (anyDirty && !closingConfirmed)
        {
            var r = MessageBox.Show(this, "保存していない変更があります。保存しますか？",
                "croco-editor", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
            if (r == DialogResult.Cancel) { e.Cancel = true; return; }
            if (r == DialogResult.Yes)
            {
                Post("flushSave");      // JS がアクティブなタブの save を投げ返す
                e.Cancel = true;
                return;
            }
            closingConfirmed = true;   // 「いいえ」= そのまま閉じる
        }
        base.OnFormClosing(e);
    }
}
