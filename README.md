# croco-editor

日本語: [README.ja.md](README.ja.md)

A Markdown drafting editor for Windows, built around a live preview and a character
count that leaves out markup. A C# (WinForms) + WebView2 shell hosts a CodeMirror 6 and
markdown-it front end.

## Installation

To just use it, download `croco-editor-setup-*.exe` from the top of this repository
and run it (no admin rights needed; installs per user). The language you pick first
(English / 日本語) is used both by the installer and by the app. File associations
are an installer checkbox. To build from source, see below.

### Claude Code integration (optional)

If you use Claude Code and want to know when a file open in croco-editor is changed
behind your back by another process, download `hooks_setup.exe` together with
`file_watch_track.exe`, `file_watch_mark_edit.exe` and `file_watch_check.exe` from the
top of this repository into one folder and run `hooks_setup.exe` (separate from
croco-editor itself; no admin rights; double-click to install,
`hooks_setup.exe -uninstall` to remove). It asks which language (English / 日本語) the
notices should use. On a machine without Claude Code it changes nothing and says so.
Source: [claude-file-watch-hooks](https://gist.github.com/noileg/0b5e85b6628907d1f2c79d4920d05303).

## Layout

```
csharp/         C# shell (host.cs). Built with the csc.exe that ships with Windows; no .NET SDK
csharp/vendor/  WebView2 redistributable DLLs (bundled; no NuGet)
src/            Webview UI (editing = CodeMirror 6, preview = markdown-it, character
                count, underline toggles, docx/html conversion, ...)
dist/           Built front end (committed, so it works without npm install)
test/           Regression tests
```

## Build and run

```
npm install
node csharp/build_host.mjs
csharp/out/croco-editor.exe [file path]
```

`node csharp/build_host.mjs` also works without `npm install` (it uses the committed
`dist/`). `npm install` is only needed when you change the front end.

## Usage

### Files

- Open: Ctrl+O, or pass a file path on the command line. If the file is already open in a tab, that tab is selected; if the tab has no unsaved edits, it is refreshed with the latest content from disk
- Save: Ctrl+S. Tabs with a path are also saved automatically 600 ms after you stop typing
- Save as: Ctrl+Shift+S
- `.html` / `.htm`: open as HTML in a tab of the same window as Markdown files and are edited as-is. The editor pane colors HTML syntax and the preview pane shows the rendered page (Markdown tabs are still rendered as Markdown). Scripts don't run in the preview. Relative images and CSS load from the HTML file's folder. Links in the preview open external URLs in the default browser and relative paths in a new tab. In-page links (`#heading`) don't work
- `.docx` / `.zip` (a zipped HTML export): converted to Markdown and imported into a new tab. You are asked where to save it when you save
- Export as: from the menu. Converts between Markdown and `.docx` / `.html` (no shortcut). From an HTML tab, `.html` is written as-is and other formats go through Markdown
- Print: Ctrl+Shift+P. Only the preview pane is printed
- Close tab: Ctrl+W
- Exit: from the menu
- New window: Ctrl+Shift+N. Same as starting with `--new`: an independent window that doesn't take part in the single-instance handoff
- External changes: a tab without unsaved edits is updated automatically when its file changes on disk. If you have unsaved edits and the file was also changed elsewhere, every save asks whether to overwrite it with your version, load the external version, or leave it for now

### Tabs

- Open several files at once and switch between them with tabs. Undo history, scroll position and the character limit are per tab; nothing in one tab affects another
- Switch: Ctrl+Tab (next), Ctrl+Shift+Tab (previous). Ctrl+PageDown / Ctrl+PageUp work too
- Close: click the tab's ×, or middle-click the tab
- `.json`, `.tasks` and `README.md` don't use tabs; each opens in its own window

### Editing

- Undo / redo: Ctrl+Z / Ctrl+Y
- Cut / copy / paste / select all: Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+A
- Find: Ctrl+F. F3 / Shift+F3 go to the next / previous match
- Replace: Ctrl+H
- Go to line: Ctrl+G
- Insert date and time: from the menu, as `YYYY-MM-DD HH:MM`
- Context menu: right-click the editor for the same commands
- Middle-button scrolling: hold the middle button and drag anywhere in the editor, preview or notes panel

### Underline and escape tags

- Underline: Ctrl+U. Toggles on the selection, so selecting underlined text and pressing it again removes the underline
- Double underline: Ctrl+Shift+U. Toggles like underline
- Underline selection: from the menu. Underlines the whole selection, leaving parts that are already underlined as they are
- Escape: Ctrl+E. Text inside `<esc>` is left out of both the preview and the character count, for notes and comments you want to keep inside the draft

### Character count

- Limit: type a number in the toolbar or pick a preset (400, 600, 800, 1000, 1200, 1600, 2000)
- What counts: switch with the "Count spaces" and "Ignore markup" checkboxes
- Text past the limit gets a colored background in the editor
- The status bar always shows the current count, the cursor line and column (plus the selection length), the font size and the path of the open file

### Preview

- Show / hide: Ctrl+P
- Show / hide the editor pane: Ctrl+Shift+E (View > Show editor). Per tab: shown by default for Markdown tabs, hidden for HTML tabs (rendering only). Restored at the next launch
- Follows the editor's scrolling
- Understands `<u>`, `<uu>`, `<ublock>`, `<qblock>` and `<esc>`. Tables render as ordinary Markdown tables
- Links: external URLs open in the default browser; relative paths are resolved as files in the same folder and opened in a new tab

### View

- Zoom in / out / reset: Ctrl++ / Ctrl+- / Ctrl+0. Ctrl+wheel works too
- Word wrap: toggled by a menu check mark
- Font: pick one of eight from the menu (Yu Gothic UI, Meiryo UI, Meiryo, MS Gothic, Yu Mincho, MS Mincho, BIZ UDPGothic, BIZ UDPMincho)
- Pane order and widths: the editor, preview and notes panel can each be shown or hidden on their own. They line up left to right in the order they were shown, and View > Pane order rearranges them. Drag a border between panes to resize them; widths are remembered for each combination of visible panes (and each pane keeps its width when reordered). With every pane hidden, the area is blank apart from a hint in the middle

### Language

- The UI is in English or Japanese. It starts in the language chosen in the installer and can be switched at any time from View > Language / 言語
- The setting is stored as `Language` (`en` / `ja`) under `HKCU\Software\croco-editor`. Without it, the app uses English

### Notes panel (Ctrl+M)

A panel that shows an external note tied to the open draft. Ctrl+M shows or hides it.

- Location: under `%APPDATA%\croco-editor\claude_notes\`, with a file name computed from the draft's full path (the first 16 hex digits of its SHA-1 plus `.md`)
- Live updates: when another process (a script, Claude Code, ...) writes to that file, the panel updates within a second while croco-editor stays open
- Edit: switch from the menu. The panel becomes a text area you can edit directly; it saves when you leave it
- Choose file...: pick any note file manually, for this tab only
- Use the automatic file: drop the manual choice and go back to the file computed from the draft path

### File associations

With the installer, use its checkbox. When running from source, register `.md` / `.tasks`:

```
python setup_association.py           # register
python setup_association.py --check   # show the current state
python setup_association.py --remove  # unregister
```

## Tests

```
npm test                   # runs everything below
node test/check.mjs        # character count
node test/tags.check.mjs   # underline toggles
node test/fmt.check.mjs    # docx/html conversion
node test/pan.check.mjs    # middle-button drag scrolling
```

`tags.check.mjs` and `fmt.check.mjs` compare against a Python reference implementation
(not included in this repository) only when its location is given in the `CROCO_PYREF`
environment variable; otherwise they report SKIP.
