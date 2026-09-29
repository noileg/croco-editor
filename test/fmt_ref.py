"""Converts fmt_cases.json with the Python reference docformats and prints the results
as JSON, for comparison with docformats.js (fmt.check.mjs).

For each case:
  md_to_html          : markdown_to_html(md)
  html_roundtrip      : html_to_markdown(markdown_to_html(md))
  docx_roundtrip      : docx_to_markdown(markdown_to_docx(md))
  docx_document_xml   : word/document.xml inside markdown_to_docx(md) (raw)

    PYTHONUTF8=1 python fmt_ref.py
"""
import io
import json
import os
import sys
import zipfile
from pathlib import Path

# Folder of the Python reference implementation, passed via an environment variable.
_ref = os.environ.get("CROCO_PYREF")
if not _ref or not Path(_ref).is_dir():
    sys.exit(1)  # No reference: the caller reports SKIP
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
