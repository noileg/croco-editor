; croco-editor インストーラ（Inno Setup）。
;
; ビルド：
;   iscc installer\croco-editor.iss
; （Inno Setup 6。GitHub Actions の windows-latest ランナーには標準で入っている。
;   ローカルでビルドするだけなら https://jrsoftware.org/isdl.php から無料で入る。
;   croco-editor 本体のビルド・実行には一切不要——開発機に何も追加しない方針は保つ）
;
; 前提：先に `node csharp\build_host.mjs` を実行して csharp\out\ を作っておくこと。
;
; 管理者権限は要らない（PrivilegesRequired=lowest）。インストール先はユーザー
; ごとの %LocalAppData%\Programs\croco-editor。ファイル関連付けも HKCU のみ
; （setup_association.py と同じ方針）。
;
; 拡張の余地：[Types]/[Components] を最初から使っている。今は "app"
; （croco-editor 本体、常時インストール）の1個だけだが、将来 croco-editor と
; 無関係な別パッケージ（例：Claude Code 用フックなど）を追加したくなったら、
; ここに [Components] のエントリを足すだけで「カスタムインストール」の選択肢に
; 追加できる。croco-editor 側のロジックには触れずに済む設計。

#define AppVersion "0.1.0"

[Setup]
AppId={{6C6F6A9C-9B49-4C1E-8B0E-9C8B2C1B9F31}
AppName=croco-editor
AppVersion={#AppVersion}
AppPublisher=noileg
AppPublisherURL=https://github.com/noileg/croco-editor
DefaultDirName={localappdata}\Programs\croco-editor
DefaultGroupName=croco-editor
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist-installer
OutputBaseFilename=croco-editor-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\csharp\editor.ico
UninstallDisplayIcon={app}\croco-editor.exe
; 本体はビルド成果物なので毎回変わる。バージョンごとに固定の GUID は保つ。

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "標準インストール"
Name: "custom"; Description: "カスタム"; Flags: iscustom

[Components]
Name: "app"; Description: "croco-editor 本体"; Types: full custom; Flags: fixed

[Tasks]
Name: "desktopicon"; Description: "デスクトップにアイコンを作成する"; GroupDescription: "追加のショートカット:"; Flags: unchecked
Name: "fileassoc"; Description: ".md / .markdown / .tasks を croco-editor で開くようにする（他の形式も「プログラムから開く」の一覧に追加）"; GroupDescription: "ファイルの関連付け:"; Components: app

[Files]
Source: "..\csharp\out\croco-editor.exe"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "..\csharp\out\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "..\csharp\out\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "..\csharp\out\WebView2Loader.dll"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "..\csharp\out\editor.ico"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "..\csharp\out\dist\*"; DestDir: "{app}\dist"; Components: app; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\croco-editor"; Filename: "{app}\croco-editor.exe"; Components: app
Name: "{group}\{cm:UninstallProgram,croco-editor}"; Filename: "{uninstallexe}"; Components: app
Name: "{autodesktop}\croco-editor"; Filename: "{app}\croco-editor.exe"; Tasks: desktopicon; Components: app

[Run]
Filename: "{app}\croco-editor.exe"; Description: "{cm:LaunchProgram,croco-editor}"; Flags: nowait postinstall skipifsilent; Components: app

; ---------------------------------------------------------------------------
; ファイル関連付け。setup_association.py（HKCU のみ、管理者権限不要）と
; 同じレジストリ構造を Inno Setup が直接書く。インストーラを使う一般利用者に
; Python を要求しないための選択——croco-editor 本体は元々 Python 非依存
; （csc.exe のみでビルド）なので、配布物もそれに揃える。
;
; setup_association.py の UserChoice 衝突チェック・PreviousProgId 退避は
; ここでは簡略化している（アンインストール時に外すだけで、外した後の
; 「元の既定へ戻す」は行わない）。より丁寧に保ちたくなったら
; setup_association.py 側の挙動を見て合わせること。
; ---------------------------------------------------------------------------
[Registry]
; --- アプリ自体の登録（「プログラムから開く」一覧・既定のアプリ画面）---
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe"; ValueType: string; ValueName: ""; ValueData: "croco-editor"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".markdown"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".tasks"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".txt"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".json"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".html"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".htm"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".docx"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\Applications\croco-editor.exe\SupportedTypes"; ValueType: string; ValueName: ".zip"; ValueData: ""; Tasks: fileassoc

; --- Windows の「既定のアプリ」画面用（Capabilities） ---
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "croco-editor"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "字数を数える下書き用エディタ"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".md"; ValueData: "crocoeditor.markdown"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".markdown"; ValueData: "crocoeditor.markdown"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".tasks"; ValueData: "crocoeditor.tasks"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".txt"; ValueData: "crocoeditor.text"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".json"; ValueData: "crocoeditor.json"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".html"; ValueData: "crocoeditor.html"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".htm"; ValueData: "crocoeditor.html"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".docx"; ValueData: "crocoeditor.docx"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\crocoeditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".zip"; ValueData: "crocoeditor.zipdoc"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "crocoeditor"; ValueData: "Software\crocoeditor\Capabilities"; Tasks: fileassoc; Flags: uninsdeletevalue

; --- ProgID ごとの定義（アイコン・開くコマンド） ---
Root: HKCU; Subkey: "Software\Classes\crocoeditor.markdown"; ValueType: string; ValueName: ""; ValueData: "Markdown（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.markdown\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.markdown\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

Root: HKCU; Subkey: "Software\Classes\crocoeditor.tasks"; ValueType: string; ValueName: ""; ValueData: "タスク（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.tasks\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.tasks\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

Root: HKCU; Subkey: "Software\Classes\crocoeditor.text"; ValueType: string; ValueName: ""; ValueData: "テキスト（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.text\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.text\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

Root: HKCU; Subkey: "Software\Classes\crocoeditor.json"; ValueType: string; ValueName: ""; ValueData: "JSON（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.json\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.json\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

Root: HKCU; Subkey: "Software\Classes\crocoeditor.html"; ValueType: string; ValueName: ""; ValueData: "HTML（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.html\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.html\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

Root: HKCU; Subkey: "Software\Classes\crocoeditor.docx"; ValueType: string; ValueName: ""; ValueData: "Word 文書（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.docx\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.docx\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

Root: HKCU; Subkey: "Software\Classes\crocoeditor.zipdoc"; ValueType: string; ValueName: ""; ValueData: "書き出しzip（croco-editor）"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\crocoeditor.zipdoc\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\croco-editor.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\crocoeditor.zipdoc\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\editor.ico"",0"; Tasks: fileassoc

; --- 「プログラムから開く」の一覧に載せる（既定にはしない拡張子も含め全部）---
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.markdown"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.markdown"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.tasks\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.tasks"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.txt\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.text"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.json\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.json"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.html"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.html"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.docx\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.docx"; ValueData: ""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.zip\OpenWithProgids"; ValueType: string; ValueName: "crocoeditor.zipdoc"; ValueData: ""; Tasks: fileassoc

; --- 既定にする（setup_association.py の "safe" 3つだけ。他は一覧登録のみ）---
; UserChoice が既に付いている場合はここで上書きしても Windows 側に無視される
; （setup_association.py --check と同じ理屈）。
Root: HKCU; Subkey: "Software\Classes\.md"; ValueType: string; ValueName: ""; ValueData: "crocoeditor.markdown"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.markdown"; ValueType: string; ValueName: ""; ValueData: "crocoeditor.markdown"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.tasks"; ValueType: string; ValueName: ""; ValueData: "crocoeditor.tasks"; Tasks: fileassoc

[Code]
procedure SHChangeNotify(wEventId: Longint; uFlags: Longint; dwItem1: Longint; dwItem2: Longint);
  external 'SHChangeNotify@shell32.dll stdcall';

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    { エクスプローラへ関連付けの変更を通知（setup_association.py の
      SHChangeNotify(SHCNE_ASSOCCHANGED) と同じ）。ファイル関連付けタスクを
      選ばなかった場合も無害なので毎回呼んでよい。 }
    SHChangeNotify($08000000, $0000, 0, 0);
  end;
end;
