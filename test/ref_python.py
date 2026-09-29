"""Evaluates cases.json with the Python reference implementation and prints JSON,
to check that character counting matches the JS version.

    PYTHONUTF8=1 python ref_python.py
"""

import json
import os
import sys
from pathlib import Path

# Folder of the Python reference implementation, passed via the CROCO_PYREF environment variable.
_ref = os.environ.get("CROCO_PYREF")
if not _ref or not Path(_ref).is_dir():
    sys.exit(1)  # No reference: check.mjs falls back to the golden py_out.json
sys.path.insert(0, _ref)

from editor_app import analyze  # noqa: E402

cases = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))
out = []
for c in cases:
    total, split_index = analyze(c["text"], c["limit"], c["strip"], c["ws"])
    out.append({"name": c["name"], "total": total, "splitIndex": split_index})
print(json.dumps(out, ensure_ascii=False, indent=2))
