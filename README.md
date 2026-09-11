# croco-editor

Windows 用の Markdown 下書きエディタ。ライブプレビューと字数カウント（記法を
除いた実字数）が主目的。C#（WinForms）＋ WebView2 の殻に、CodeMirror 6 と
markdown-it のフロントエンドを載せている。

以前の Python/tkinter 版（`editor_app.py` ＋ `docformats.py`）を、機能を落とさずに
作り直したもの。移植の一致は Python 参照実装との照合テストで確認している（下記）。

## 構成

- **殻＝C#（WinForms、Windows 同梱の csc.exe でビルド、.NET SDK 不要）。**
  `csharp/host.cs`。ウィンドウ＝メニューバー ＋ WebView2 コントロール1個。
  ファイル入出力・ダイアログ・ウィンドウタイトル・改行コード保持・単一
  インスタンス／ハンドオフ・セッション保存は殻側。
- **UI＝webview の中**（`src/`）。編集＝CodeMirror 6、プレビュー＝markdown-it →
  HTML/CSS、字数カウント＝`count.js`（Python 版からの逐語移植）、下線トグル＝
  `tags.js`／docx・html 変換＝`docformats.js`（いずれも `docformats.py` から移植）。
- 殻 ⇔ JS は素の文字列プロトコル（`src/bridge.js` 冒頭に一覧）。
- `csharp/vendor/*.dll` は Microsoft の WebView2 再頒布 DLL（NuGet の nupkg から
  抽出、バージョンは `csharp/vendor/VERSION.txt`）。NuGet も .NET SDK も不要に
  するため同梱している。

## ビルドと実行

```
npm install
node csharp/build_host.mjs          # フロントのバンドル → csc → csharp/out/croco-editor.exe
csharp/out/croco-editor.exe [ファイルパス]
csharp/out/croco-editor.exe --new  # 独立した窓（単一インスタンスに参加しない）
```

`dist/bundle.js` はリポジトリにコミットしてあるので、clone 直後に `npm install`
無しでも `node csharp/build_host.mjs` は通る（システムの `csc.exe` だけあればよい）。
`npm install` はフロントを編集してビルドし直すときに要る。
`csharp/out/` は生成物（git 管理外）。

Windows へのファイル関連付け（`.md`/`.tasks` を既定プログラムに）は
`python setup_association.py`（HKCU のみ、管理者権限不要。`--check` / `--default`
/ `--remove`）。

## 移植済み（.exe 単体で動作確認、多くは Python 実装と一致テストあり）

- 起動 → WebView2 初期化 → `dist/` を仮想ホスト `https://app.local/` で表示
- ファイル：開く（argv／ダイアログ、フィルタは Markdown/JSON/tasks/docx/html/zip を
  一覧に含む）、上書き保存、名前を付けて保存、自動保存（編集停止 600ms・パスの
  あるタブのみ）、BOM 判定＋cp932フォールバック（`utf-8-sig→utf-8→cp932` の順。
  Python 版 `read_file` と同じ規則。2026-09-11 に移植漏れとして発覚・修正）、
  CRLF を覚えて保存時に戻す。今出ているタブが空の無題タブなら使い回す
  （新規タブを増やさない。使い回すときは設定・メモ手動指定も含め丸ごと
  作り直す＝旧版が Doc を丸ごと差し替えるのと同じ。2026-09-11、レビューで
  「前のタブの設定を引き継いだまま」の抜けを発見・修正）。**新規に開く
  ファイルの「記法を数えない」既定値**は `.md`/`.markdown` 拡張子なら ON、
  取り込み（docx/html/zip）は常に ON（旧版 `open_path`/取り込み時の Doc と
  同じ規則）。2026-09-11、レビューで発覚：`addTab` の呼び出し側がどこも
  設定を渡しておらず既定で常にOFFだった（字数管理が主目的のアプリなので
  実害は小さくない）。実exeのスクリーンショットでチェック状態を確認
- **外部変更との競合検出**：保存の直前にディスクの mtime を確認し、最後に
  自分が読み書きした時点と違えば（＝別のエディタ等でも変更が入っている）
  MessageBox で「はい：自分の内容で上書き／いいえ：外部の内容を読み込む／
  キャンセル：保留」を選ばせる（VS Code の比較・上書き相当）。自動保存
  （idle timer）・明示保存（Ctrl+S 等）のどちらでも同じ扱い——保留を選ぶと
  そのタブの自動保存は止まる（以後の保存操作でまた選択肢が出る。同じ会話を
  毎回のidle tickで出し直しはしない）。Python 版 `_autosave_files` の
  「無条件の上書きはしない」を踏襲しつつ、実際にどちらを残すか選べるところ
  まで踏み込んだ（2026-09-11、実装漏れとして発覚・修正 → 本人指摘で
  「バックアップを残すだけでは委ねたことにならない、選ばせろ」→
  自動/手動を分けていた設計も「そもそも自動保存の話」との指摘で統合）。
  この基準（mtime）は
  `%APPDATA%\croco-editor\mtimes.dat` にセッションと同じ頻度で永続化し、
  次回起動時のタブ復元にも引き継ぐ（Python 版は `Doc.mtime` を session.json に
  同梱して同じことをしている）。**これが無いと**、アプリを閉じている間に
  外部でファイルが変わっても、復元されたタブは基準を持たないまま自動保存の
  チェックを素通りし、外部の変更を無条件に上書きして消しうる
  （2026-09-11、本人指摘で発覚・修正。実exeで基準の永続化・復元・外部変更との
  比較まで確認）
- **タブ（複数文書）**：CodeMirror の EditorState をタブ別に丸ごと保持
  （Undo 履歴・スクロール・選択もタブ別）、タブ別の字数設定、タブバー、
  中クリック／× で閉じる、Ctrl+W、Ctrl+Tab／Ctrl+PageUp/PageDown、未保存クローズ
  確認は殻の MessageBox（はい／いいえ／キャンセル）
- **単一インスタンス＋ハンドオフ**：2枚目の起動は Mutex で検出し、1枚目の
  ウィンドウ（本物の MainForm。受け渡し専用の別窓は作らない）へ WM_COPYDATA
  でパスを渡して終了。1枚目が新しいタブで開き前面化。`--new` の窓は不参加
  （使い捨て窓）。2026-09-11以前は名前付きパイプだったが、冷間起動で複数
  ファイルをほぼ同時に開くとパスが消える／窓が割れる不具合があり置き換えた
  （詳細は`host.cs`冒頭コメント）
- **セッション復元**：開いていたタブ（本文込み）・アクティブタブ・
  ウィンドウ位置・仕切り比率を `%APPDATA%\croco-editor\session.dat` に保存し次回復元。
  閉じる時だけでなく編集の都度 1500ms 後にも書く（Python 版 `_schedule_save` と
  同じ間隔。クラッシュ/PC強制終了対策。2026-09-11 に移植漏れとして発覚・修正）。
  `--new` の使い捨て窓はこの保存に参加しない（参加させると閉じるたびに
  本来のセッションを単一タブの内容で踏み潰す）
- 字数カウント（記法除外・空白トグル・上限）＋上限超過の背景ハイライト。
  `node test/check.mjs` で Python 参照と 22 ケース一致
- ライブ Markdown プレビュー（`<u>`/`<uu>`/`<ublock>`/`<qblock>`/`<esc>`、
  表は普通の `<table>`）
- **編集画面上でも下線・二重下線・`<qblock>`・`<esc>` の装飾範囲を直接表示**
  （下線＝下線、二重下線＝下線＋薄青背景、qblock＝灰文字＋灰背景、esc＝黄背景。
  Python 版 `_update_status` のタグ表示と同じ色。プレビューを開かなくても
  書いている最中に分かる。タグ文字自体のグレー表示=`utag`は本人指摘で対象外の
  まま。2026-09-11 に移植漏れとして発覚・修正）
- 下線トグル `<u>`／二重下線 `<uu>`（Ctrl+U／Ctrl+Shift+U）、エスケープ
  `<esc>`（Ctrl+E）、選択範囲に一括で下線。`node test/tags.check.mjs` で
  Python 参照と 13 ケース一致
- 検索（Ctrl+F）／次・前（F3・Shift+F3）／置換（Ctrl+H）／行へ移動（Ctrl+G）
- 日付と時刻（メニューのみ。F5 は割り当てない＝旧版で IME 誤発火バグがあったため）
- 拡大・縮小・等倍（Ctrl+ +/-/0、Ctrl+ホイール）、書体8種、右端で折り返す（いずれも保持）
- 印刷（Ctrl+Shift+P、プレビュー欄だけ）、プレビュー表示切替（Ctrl+P）
- メニューバー（ファイル／編集／表示）を旧版の構成に一致
- 中クリックドラッグでスクロール（方向反転・移動量比例・既定 7 倍、`src/pan.js` の `PAN_GAIN`）
- 新しいウィンドウ（Ctrl+Shift+N）
- **メモ広場**（Ctrl+M）：`claude_notes.mjs` と同じ計算（下書き絶対パスを posix
  表記 → 小文字 → SHA1 先頭16桁）で対応づいたノートを表示。読み取り専用
  （Markdown 描画）／編集モード（textarea、離脱時保存）、1秒ポーリングで外部
  更新を反映、`ファイルを選択` / `自動対応に戻す`、タブ別の手動指定、セッション
  保存。ノート置き場は `%APPDATA%\croco-editor\claude_notes`（環境変数
  `CROCO_NOTE_DIR` で上書き可）
- **`.json` / `.tasks` / `README.md`**：メイン窓のタブに混ぜず独立した窓で開く
- **docx / html / zip の取り込み・書き出し**（`docformats.py` 全体を
  `src/docformats.js` へ移植。ZIP は fflate、HTML/XML は webview の DOMParser）。
  `node test/fmt.check.mjs` で **Python 実装と 19 ケース一致**（`markdown_to_html`
  は HTML バイト一致、`markdown_to_docx` は `word/document.xml` バイト一致、
  docx/html 往復一致、Python の OOXML リーダが JS 生成 docx を読み戻せること）。
  段落／リストをまたぐ下線の繋ぎ直しも一致。取り込みは新しいタブ（パス無し・
  未保存）へ。「形式を変換して保存」は .md/.txt/.docx/.html。
- プレビュー/メモ内のリンク：外部 URL は既定ブラウザ、同フォルダの相対パスは
  アクティブタブから解決して新タブ。WebView2 の `NavigationStarting` /
  `NewWindowRequested` を止めてアプリが飛ばないように
- 編集欄の右クリック文脈メニュー（元に戻す/やり直し・切取コピー貼付・
  下線/二重/一括/エスケープ・すべて選択）
- 仕切り（エディタ↔プレビュー）のドラッグ。比率は session に保持
- ステータスバーの行・列・pt・パス・`（選択 N 字）`
- プレビューの画像は `[画像: alt]` プレースホルダ（画像は持たない）
- アイコン（`csharp/editor.ico` を exe に埋め込み＋ウィンドウに設定）
- IME：webview（Chromium）が未確定文字を本文と同じフォントでインライン描画する
  ので、旧版の `ImmSetCompositionFontW` P/Invoke は不要。ウィンドウレベルの
  ショートカット捕捉（`window keydown`）が変換中のキーを横取りしないよう
  `e.isComposing` を見て素通しさせている（KEYMAP は全項目 Ctrl 併用＝変換中に
  押す組合せとは重ならないため実害は無いはずだが念のため。2026-09-11）。
  **ただし実際のIME入力での確認はまだ本人の手を要する**（自動化できない）
- **書き込みのアトミック性**：本文の保存・形式変換保存・セッション保存は
  一時ファイル（`.croco-tmp`）に書いてから差し替える（`os.replace` 相当、
  `File.Replace`/`File.Move`）。旧版 `write_bytes` と同じ規則。途中で落ちても
  元のファイルを壊さない。メモ広場の保存は旧版 `claude_notes.write_note` も
  直接書きなので揃えて対象外（2026-09-11、実装漏れとして発覚・修正）
- **タスクバー右クリックの「新しいウィンドウ」**（旧版 `launcher.cs` の COM
  ジャンプリストをそのまま移植。`ICustomDestinationList`。AppUserModelID は
  旧版と別に `croco.editor` を新規に割り当て）。スタートメニューに
  `croco-editor.lnk` を作る（ジャンプリストはショートカットが無いと
  Windowsが出さないため）。実exeでショートカット作成とジャンプリストDB
  （`%APPDATA%\Microsoft\Windows\Recent\CustomDestinations\`）への書き込みを
  確認（2026-09-11、実装漏れとして発覚・修正）。**登録処理そのもの（COM＋
  ファイルI/O）は Mutex 判定／ハンドオフより後、ウィンドウ表示後に遅延実行
  する**（`MainForm.OnHandleCreated` → `BeginInvoke`）。単一インスタンスの
  受け口を最速で立てる、という直前の修正の趣旨と最初は矛盾しており
  （登録処理をここより前に置くと「受け口がまだ無い」隙間を逆に広げてしまう）、
  レビューで発覚して直した

## 未対応（旧 Python 版にあった機能）

- **ターミナルと同じモニタに窓を出す**（旧版 `screen.py`）—— 対象外（割り切り、本人判断）

## 検証

```
npm install
node build.mjs                # フロント再バンドル（dist/ が変われば新しい正）
node csharp/build_host.mjs    # → csharp/out/croco-editor.exe
node test/check.mjs           # 字数カウント（Python 参照と 22 ケース。参照が無ければゴールデンと比較）
node test/tags.check.mjs      # 下線トグル（Python 参照と 13 ケース。無ければ SKIP）
node test/fmt.check.mjs       # docx/html 変換（Python 参照と 19 ケース。無ければ SKIP）
```

`test/*.check.mjs` の Python 照合は、旧 Python 版のフォルダを環境変数
`CROCO_PYREF` で渡したときだけ走る（未設定なら `check.mjs` はコミット済みの
`test/py_out.json` と比較、他の2つは SKIP）。

無人スモーク：`CROCO_SELFTEST=1 csharp/out/croco-editor.exe <ファイル>` で
読み込み→編集→自動保存→タブ操作を走らせ、`%TEMP%\croco-editor.log` に記録。
