"""参照実装（Python 版 editor_app.analyze）で cases.json を評価して JSON を出す。
JS 側の出力と突き合わせて、字数カウントが一致しているかを確かめる用。

    PYTHONUTF8=1 python ref_python.py
"""

import json
import os
import sys
from pathlib import Path

# 旧 Python 版（editor_app.py）のあるフォルダ。環境変数 CROCO_PYREF で渡す。
_ref = os.environ.get("CROCO_PYREF")
if not _ref or not Path(_ref).is_dir():
    sys.exit(1)  # 参照実装が無い → check.mjs 側はゴールデン（py_out.json）に切替
sys.path.insert(0, _ref)

from editor_app import analyze  # noqa: E402

cases = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))
out = []
for c in cases:
    total, split_index = analyze(c["text"], c["limit"], c["strip"], c["ws"])
    out.append({"name": c["name"], "total": total, "splitIndex": split_index})
print(json.dumps(out, ensure_ascii=False, indent=2))
