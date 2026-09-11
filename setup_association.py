"""croco-editor を Windows に登録する。どの拡張子にも割り当てられるようにする。

    python setup_association.py                     推奨の内容で登録する
    python setup_association.py --check              いまの状態を見るだけ
    python setup_association.py --default .docx      指定した拡張子を既定にもする
    python setup_association.py --remove             登録を全部外す

書き込むのは **HKCU（このユーザーだけ）** で、管理者権限は要らない。
旧 Python 版（Twitter-like-char-counter/setup_association.py）からの移植。
違い：exe は `%1` を直接受け取るので `open_file.pyw` の中継が無い。ProgID と
アプリ登録キーは `crocoeditor.*` / `crocoeditor`（旧版の `croco.*` / `croco-editor`
とは別名前空間。両方入っていても衝突しない）。

**やっていること。**
1. `croco-editor.exe` を「プログラムから開く」の一覧と「既定のアプリ」画面に出す。
2. 外から安全に書ける拡張子（UserChoice が無いもの）だけ既定にする。

`.md` `.markdown` `.tasks` は UserChoice が付いていなければ書けば効く。
`.txt`（メモ帳）`.html`（VS Code）`.htm` `.zip` `.json` は画面から選ぶ必要がある
ことが多い（`--check` が判定を出す）。
"""

from __future__ import annotations

import ctypes
import os
import sys
import winreg
from pathlib import Path

APP_KEY = "crocoeditor"
APP_NAME = "croco-editor"
APP_DESCRIPTION = "字数を数える下書き用エディタ"
EXE_NAME = "croco-editor.exe"
CLASSES = r"Software\Classes"

# (拡張子, ProgID, エクスプローラに出る種類名, 既定にしてよいか)
KINDS = (
    (".md", "crocoeditor.markdown", "Markdown（croco-editor）", True),
    (".markdown", "crocoeditor.markdown", "Markdown（croco-editor）", True),
    (".tasks", "crocoeditor.tasks", "タスク（croco-editor）", True),
    (".txt", "crocoeditor.text", "テキスト（croco-editor）", False),
    (".json", "crocoeditor.json", "JSON（croco-editor）", False),
    (".html", "crocoeditor.html", "HTML（croco-editor）", False),
    (".htm", "crocoeditor.html", "HTML（croco-editor）", False),
    (".docx", "crocoeditor.docx", "Word 文書（croco-editor）", False),
    (".zip", "crocoeditor.zipdoc", "書き出しzip（croco-editor）", False),
)

SHCNE_ASSOCCHANGED = 0x08000000
SHCNF_IDLIST = 0x0000


def here() -> Path:
    return Path(__file__).resolve().parent


def exe_path() -> Path:
    return here() / "csharp" / "out" / EXE_NAME


def icon_path() -> Path:
    return here() / "csharp" / "out" / "editor.ico"


def open_command() -> str:
    return f'"{exe_path()}" "%1"'


def _read(path: str, name: str = "") -> str | None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def _write(path: str, value: str, name: str = "") -> None:
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, path) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)


def _delete_tree(path: str) -> None:
    """キーを中身ごと消す。winreg は空でないキーを消せないので下から辿る。"""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            children = []
            index = 0
            while True:
                try:
                    children.append(winreg.EnumKey(key, index))
                except OSError:
                    break
                index += 1
    except OSError:
        return
    for child in children:
        _delete_tree(f"{path}\\{child}")
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
    except OSError:
        pass


def _delete_value(path: str, name: str) -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, name)
    except OSError:
        pass


def _notify_shell() -> None:
    ctypes.windll.shell32.SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None)


def user_choice(extension: str) -> str | None:
    return _read(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer"
        rf"\FileExts\{extension}\UserChoice",
        "ProgId",
    )


def _pad(text: str, width: int) -> str:
    import unicodedata

    shown = sum(2 if unicodedata.east_asian_width(c) in "WFA" else 1 for c in text)
    return text + " " * max(1, width - shown)


def show() -> int:
    ready = exe_path().is_file()
    print(f"exe       : {exe_path()}"
          f"{'' if ready else '  ← まだありません（node csharp/build_host.mjs で作る）'}")
    print(f"コマンド  : {open_command()}")
    print(f"アプリ登録: {_read(rf'{CLASSES}\Applications\{EXE_NAME}', 'FriendlyAppName')!r}")
    print(f"一覧登録  : {_read(r'Software\RegisteredApplications', APP_KEY)!r}")
    print()
    print(_pad("拡張子", 12) + _pad("いまの既定", 38) + "状態")
    print("-" * 84)
    for extension, progid, _label, _safe in KINDS:
        choice = user_choice(extension)
        assigned = _read(rf"{CLASSES}\{extension}")
        listed = _read(rf"{CLASSES}\{extension}\OpenWithProgids", progid) is not None
        if choice == progid:
            current, state = choice, "このエディタ（画面で選択済み）"
        elif choice:
            current, state = choice, "画面で選ばれているので外から変えられない"
        elif assigned == progid:
            current, state = assigned, "このエディタ（既定）"
        elif assigned:
            current, state = assigned, "他のもの"
        else:
            current, state = "なし", "既定にできる（--default で設定）"
        note = "" if state.startswith("このエディタ") else ("／一覧には出る" if listed else "")
        print(_pad(extension, 12) + _pad(current, 38) + state + note)
    print()
    print("「外から変えられない」ものは、右クリック →「プログラムから開く」→")
    print(f"「別のプログラムを選択」→「{APP_NAME}」→「常にこのアプリを使う」で切り替えます。")
    return 0 if ready else 1


def _register_application(extensions: tuple[str, ...]) -> None:
    app = rf"{CLASSES}\Applications\{EXE_NAME}"
    _write(app, APP_NAME, "FriendlyAppName")
    _write(rf"{app}\shell\open\command", open_command())
    if icon_path().is_file():
        _write(rf"{app}\DefaultIcon", f'"{icon_path()}",0')
    for extension in extensions:
        _write(rf"{app}\SupportedTypes", "", extension)

    capabilities = rf"Software\{APP_KEY}\Capabilities"
    _write(capabilities, APP_NAME, "ApplicationName")
    _write(capabilities, APP_DESCRIPTION, "ApplicationDescription")
    if icon_path().is_file():
        _write(capabilities, f'"{icon_path()}",0', "ApplicationIcon")
    for extension, progid, _label, _safe in KINDS:
        _write(rf"{capabilities}\FileAssociations", progid, extension)
    _write(r"Software\RegisteredApplications", capabilities, APP_KEY)


def install(force_default: list[str]) -> int:
    if not exe_path().is_file():
        print(f"{EXE_NAME} がありません。先に `node csharp/build_host.mjs` で作ってください。")
        return 1

    _register_application(tuple(dict.fromkeys(e for e, *_ in KINDS)))

    made_default: list[str] = []
    listed_only: list[str] = []
    blocked: list[tuple[str, str]] = []
    for extension, progid, label, safe in KINDS:
        _write(rf"{CLASSES}\{progid}", label)
        _write(rf"{CLASSES}\{progid}\shell\open\command", open_command())
        if icon_path().is_file():
            _write(rf"{CLASSES}\{progid}\DefaultIcon", f'"{icon_path()}",0')
        _write(rf"{CLASSES}\{extension}\OpenWithProgids", "", progid)

        if not (safe or extension in force_default):
            listed_only.append(extension)
            continue
        choice = user_choice(extension)
        if choice and choice != progid:
            blocked.append((extension, choice))
            continue
        previous = _read(rf"{CLASSES}\{extension}") or ""
        if previous != progid:
            _write(rf"{CLASSES}\{progid}", previous, f"PreviousProgId{extension}")
        _write(rf"{CLASSES}\{extension}", progid)
        made_default.append(extension)

    _notify_shell()

    print(f"「{APP_NAME}」をアプリとして登録しました。")
    print(f"  {open_command()}")
    print("  →「プログラムから開く」の一覧と、Windowsの「既定のアプリ」画面に出ます。")
    if made_default:
        print(f"既定にしました        : {' '.join(made_default)}")
    if listed_only:
        print(f"一覧に載せただけ      : {' '.join(listed_only)}")
        print("  （既定にもしたいものは --default .docx のように指定してください）")
    if blocked:
        print("既定にできませんでした:")
        for extension, choice in blocked:
            print(f"  {extension} … Windowsの画面で {choice} が選ばれています。外から書いても無視されます。")
        print("  右クリック →「プログラムから開く」→「別のプログラムを選択」→")
        print(f"  「{APP_NAME}」→「常にこのアプリを使う」で切り替えてください。")
    return 0


def remove() -> int:
    for extension, progid, _label, _safe in KINDS:
        if _read(rf"{CLASSES}\{extension}") == progid:
            previous = _read(rf"{CLASSES}\{progid}", f"PreviousProgId{extension}")
            _write(rf"{CLASSES}\{extension}", previous or "")
        _delete_value(rf"{CLASSES}\{extension}\OpenWithProgids", progid)
    for progid in dict.fromkeys(p for _e, p, *_ in KINDS):
        _delete_tree(rf"{CLASSES}\{progid}")
    _delete_tree(rf"{CLASSES}\Applications\{EXE_NAME}")
    _delete_tree(rf"Software\{APP_KEY}")
    _delete_value(r"Software\RegisteredApplications", APP_KEY)
    _notify_shell()
    print("登録を外しました。")
    print("Windowsの「既定のアプリ」画面で選んだ指定（UserChoice）は残ります。")
    print("その拡張子は同じ画面で別のアプリに戻してください。")
    return 0


def main(argv: list[str]) -> int:
    if os.name != "nt":
        print("Windows 専用です。")
        return 1
    if "--check" in argv:
        return show()
    if "--remove" in argv:
        return remove()
    force: list[str] = []
    known = {extension for extension, *_ in KINDS}
    if "--default" in argv:
        for value in argv[argv.index("--default") + 1:]:
            if value.startswith("--"):
                break
            value = (value if value.startswith(".") else "." + value).lower()
            if value not in known:
                print(f"扱えない拡張子です: {value}")
                print(f"扱えるのは: {' '.join(sorted(known))}")
                return 1
            force.append(value)
    return install(force)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
