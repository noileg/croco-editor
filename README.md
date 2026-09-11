# croco-editor

Windows 用の Markdown 下書きエディタ。ライブプレビューと字数カウント（記法を
除いた実字数）が主目的。C#（WinForms）＋ WebView2 の殻に、CodeMirror 6 と
markdown-it のフロントエンドを載せている。

## 構成

```
csharp/    C# 殻（host.cs）。Windows 同梱の csc.exe でビルド、.NET SDK 不要
csharp/vendor/  WebView2 の再頒布 DLL（同梱、NuGet 不要）
src/       webview 側 UI（編集＝CodeMirror 6、プレビュー＝markdown-it、
           字数カウント・下線トグル・docx/html 変換など）
dist/      フロントのビルド成果物（コミット済み。npm install 無しでも動く）
test/      回帰テスト
```

## ビルドと実行

```
npm install
node csharp/build_host.mjs
csharp/out/croco-editor.exe [ファイルパス]
```

`npm install` を省いても `node csharp/build_host.mjs` は通る（コミット済みの
`dist/` をそのまま使う）。フロントを編集したときだけ `npm install` が要る。

## 使い方

- 開く：Ctrl+O、または引数でファイルパスを渡す
- 保存：Ctrl+S（自動保存も有効）。名前を付けて保存：Ctrl+Shift+S
- 下線：Ctrl+U　二重下線：Ctrl+Shift+U　エスケープ（字数除外）：Ctrl+E
- プレビュー表示切替：Ctrl+P
- メモ広場：Ctrl+M
- 新しいウィンドウ：Ctrl+Shift+N
- `--new` 付きで起動すると単一インスタンスに参加しない独立ウィンドウになる

ファイル関連付け（`.md`/`.tasks` を既定プログラムに）：

```
python setup_association.py           # 登録
python setup_association.py --check   # 現状確認
python setup_association.py --remove  # 解除
```

## テスト

```
node test/check.mjs        # 字数カウント
node test/tags.check.mjs   # 下線トグル
node test/fmt.check.mjs    # docx/html 変換
```
