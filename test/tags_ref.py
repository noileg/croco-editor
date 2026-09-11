"""docformats の toggle_underline / toggle_underline_double / toggle_esc /
bulk_underline で tags_cases.json を評価し JSON を出す。JS 版 tags.js と突き合わせる。

    PYTHONUTF8=1 python tags_ref.py
"""
import json
import os
import sys
from pathlib import Path

_ref = os.environ.get("CROCO_PYREF")
if not _ref or not Path(_ref).is_dir():
    sys.exit(1)  # 参照実装が無い → 呼び出し側は SKIP 扱い
sys.path.insert(0, _ref)
import docformats  # noqa: E402

OPS = {
    "u": docformats.toggle_underline,
    "uu": docformats.toggle_underline_double,
    "esc": docformats.toggle_esc,
    "bulk": docformats.bulk_underline,
}

cases = json.loads((Path(__file__).parent / "tags_cases.json").read_text(encoding="utf-8"))
out = []
for c in cases:
    text, start, end = OPS[c["op"]](c["text"], c["start"], c["end"])
    out.append({"name": c["name"], "text": text, "start": start, "end": end})
print(json.dumps(out, ensure_ascii=False, indent=2))
