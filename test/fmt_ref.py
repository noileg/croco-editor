"""docformats.py で fmt_cases.json を変換し、参照結果を JSON で出す。
JS 版 docformats.js との突き合わせ用（fmt.check.mjs）。

各ケースについて：
  md_to_html          : markdown_to_html(md)
  html_roundtrip      : html_to_markdown(markdown_to_html(md))
  docx_roundtrip      : docx_to_markdown(markdown_to_docx(md))
  docx_document_xml   : markdown_to_docx(md) の中の word/document.xml（生）

    PYTHONUTF8=1 python fmt_ref.py
"""
import io
import json
import os
import sys
import zipfile
from pathlib import Path

# 旧 Python 版（editor_app.py / docformats.py）のあるフォルダ。環境変数で渡す。
_ref = os.environ.get("CROCO_PYREF")
if not _ref or not Path(_ref).is_dir():
    sys.exit(1)  # 参照実装が無い → 呼び出し側は SKIP 扱い
sys.path.insert(0, _ref)
import docformats  # noqa: E402

cases = json.loads((Path(__file__).parent / "fmt_cases.json").read_text(encoding="utf-8"))
out = []
for c in cases:
    md = c["md"]
    html = docformats.markdown_to_html(md, "")
    docx = docformats.markdown_to_docx(md)
    with zipfile.ZipFile(io.BytesIO(docx)) as z:
        document_xml = z.read("word/document.xml").decode("utf-8")
    out.append({
        "name": c["name"],
        "md_to_html": html,
        "html_roundtrip": docformats.html_to_markdown(html),
        "docx_roundtrip": docformats.docx_to_markdown(docx),
        "docx_document_xml": document_xml,
    })
print(json.dumps(out, ensure_ascii=False, indent=2))
