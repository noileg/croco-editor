"""Registers croco-editor with Windows so it can be associated with any extension.

    python setup_association.py                     Register with the recommended settings
    python setup_association.py --check              Only show the current state
    python setup_association.py --default .docx      Also make the given extension default
    python setup_association.py --remove             Remove all registrations

Writes only to HKCU (this user), so no admin rights are needed. ProgIDs and the
application key are `crocoeditor.*` / `crocoeditor`.

What it does:
1. Lists `croco-editor.exe` under "Open with" and in the "Default apps" settings.
2. Makes it the default only for extensions that can safely be set from outside
   (those without a UserChoice).

`.md` `.markdown` `.tasks` take effect when written, unless a UserChoice exists.
`.txt` `.html` `.htm` `.zip` `.json` often have to be chosen in the Windows settings
(`--check` tells you which).

Messages follow the UI language stored in HKCU\\Software\\croco-editor\\Language
("ja" for Japanese; English otherwise).
"""

from __future__ import annotations

import ctypes
import os
import sys
import winreg
from pathlib import Path


def _language() -> str:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\croco-editor") as key:
            return "ja" if winreg.QueryValueEx(key, "Language")[0] == "ja" else "en"
    except OSError:
        return "en"


LANG = _language()


def tr(en: str, ja: str) -> str:
    return ja if LANG == "ja" else en


APP_KEY = "crocoeditor"
APP_NAME = "croco-editor"
APP_DESCRIPTION = tr("A drafting editor that counts characters", "字数を数える下書き用エディタ")
EXE_NAME = "croco-editor.exe"
CLASSES = r"Software\Classes"

# (extension, ProgID, type name shown in Explorer, OK to make default)
KINDS = (
    (".md", "crocoeditor.markdown", tr("Markdown (croco-editor)", "Markdown（croco-editor）"), True),
    (".markdown", "crocoeditor.markdown", tr("Markdown (croco-editor)", "Markdown（croco-editor）"), True),
    (".tasks", "crocoeditor.tasks", tr("Tasks (croco-editor)", "タスク（croco-editor）"), True),
    (".txt", "crocoeditor.text", tr("Text (croco-editor)", "テキスト（croco-editor）"), False),
    (".json", "crocoeditor.json", tr("JSON (croco-editor)", "JSON（croco-editor）"), False),
    (".html", "crocoeditor.html", tr("HTML (croco-editor)", "HTML（croco-editor）"), False),
    (".htm", "crocoeditor.html", tr("HTML (croco-editor)", "HTML（croco-editor）"), False),
    (".docx", "crocoeditor.docx", tr("Word document (croco-editor)", "Word 文書（croco-editor）"), False),
    (".zip", "crocoeditor.zipdoc", tr("Exported zip (croco-editor)", "書き出しzip（croco-editor）"), False),
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
    """Delete a key and everything under it. winreg can't delete non-empty keys, so walk down first."""
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
          f"{'' if ready else tr('  <- not built yet (run node csharp/build_host.mjs)', '  ← まだありません（node csharp/build_host.mjs で作る）')}")
    print(tr("command   : ", "コマンド  : ") + open_command())
    print(tr("app entry : ", "アプリ登録: ") + repr(_read(rf'{CLASSES}\Applications\{EXE_NAME}', 'FriendlyAppName')))
    print(tr("registered: ", "一覧登録  : ") + repr(_read(r'Software\RegisteredApplications', APP_KEY)))
    print()
    print(_pad(tr("Extension", "拡張子"), 12) + _pad(tr("Current default", "いまの既定"), 38) + tr("State", "状態"))
    print("-" * 84)
    this_editor = tr("this editor", "このエディタ")
    for extension, progid, _label, _safe in KINDS:
        choice = user_choice(extension)
        assigned = _read(rf"{CLASSES}\{extension}")
        listed = _read(rf"{CLASSES}\{extension}\OpenWithProgids", progid) is not None
        if choice == progid:
            current, state = choice, this_editor + tr(" (chosen in Settings)", "（画面で選択済み）")
        elif choice:
            current, state = choice, tr("chosen in Settings; can't be changed from outside", "画面で選ばれているので外から変えられない")
        elif assigned == progid:
            current, state = assigned, this_editor + tr(" (default)", "（既定）")
        elif assigned:
            current, state = assigned, tr("something else", "他のもの")
        else:
            current, state = tr("none", "なし"), tr("can be made default (--default)", "既定にできる（--default で設定）")
        note = "" if state.startswith(this_editor) else (tr(" / listed under Open with", "／一覧には出る") if listed else "")
        print(_pad(extension, 12) + _pad(current, 38) + state + note)
    print()
    print(tr("To switch the ones that can't be changed from outside: right-click -> Open with ->",
             "「外から変えられない」ものは、右クリック →「プログラムから開く」→"))
    print(tr(f"Choose another app -> {APP_NAME} -> Always use this app.",
             f"「別のプログラムを選択」→「{APP_NAME}」→「常にこのアプリを使う」で切り替えます。"))
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
        print(tr(f"{EXE_NAME} not found. Build it first with `node csharp/build_host.mjs`.",
                 f"{EXE_NAME} がありません。先に `node csharp/build_host.mjs` で作ってください。"))
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

    print(tr(f"Registered {APP_NAME} as an application.", f"「{APP_NAME}」をアプリとして登録しました。"))
    print(f"  {open_command()}")
    print(tr("  -> It now appears under Open with and in the Windows Default apps settings.",
             "  →「プログラムから開く」の一覧と、Windowsの「既定のアプリ」画面に出ます。"))
    if made_default:
        print(tr("Made default          : ", "既定にしました        : ") + " ".join(made_default))
    if listed_only:
        print(tr("Listed only           : ", "一覧に載せただけ      : ") + " ".join(listed_only))
        print(tr("  (to make one default too, pass it like --default .docx)",
                 "  （既定にもしたいものは --default .docx のように指定してください）"))
    if blocked:
        print(tr("Could not make default:", "既定にできませんでした:"))
        for extension, choice in blocked:
            print(tr(f"  {extension}: {choice} is chosen in the Windows settings; writing from outside is ignored.",
                     f"  {extension} … Windowsの画面で {choice} が選ばれています。外から書いても無視されます。"))
        print(tr("  Switch it with right-click -> Open with -> Choose another app ->",
                 "  右クリック →「プログラムから開く」→「別のプログラムを選択」→"))
        print(tr(f"  {APP_NAME} -> Always use this app.",
                 f"  「{APP_NAME}」→「常にこのアプリを使う」で切り替えてください。"))
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
    print(tr("Removed the registration.", "登録を外しました。"))
    print(tr("Choices made in the Windows Default apps settings (UserChoice) remain.",
             "Windowsの「既定のアプリ」画面で選んだ指定（UserChoice）は残ります。"))
    print(tr("Switch those extensions to another app in the same settings.",
             "その拡張子は同じ画面で別のアプリに戻してください。"))
    return 0


def main(argv: list[str]) -> int:
    if os.name != "nt":
        print(tr("Windows only.", "Windows 専用です。"))
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
                print(tr(f"Unsupported extension: {value}", f"扱えない拡張子です: {value}"))
                print(tr("Supported: ", "扱えるのは: ") + " ".join(sorted(known)))
                return 1
            force.append(value)
    return install(force)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
