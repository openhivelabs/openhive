#!/usr/bin/env python3
"""Apply a patch to a .docx.

Two edit tracks:
  LIVE ops   — set_text, update_table_cell, swap_image, set_style
               mutate the document in place via python-docx
  SPEC ops   — insert_block, delete_block, replace_block, move_block
               rewrite the .spec.json and rebuild via build_doc.py

Usage:
    python edit_doc.py --in report.docx --patch patch.json --out out.docx
    # spec is auto-loaded from <in>.spec.json if present
    # or pass explicitly:  --spec report.docx.spec.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--patch", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--spec", default=None, help="Optional path to .spec.json. "
                    "Defaults to <input>.spec.json next to input.")
    args = ap.parse_args()

    try:
        from docx import Document
        from helpers.patch import OpError, apply_patch
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    inp = pathlib.Path(args.inp).expanduser()
    out = pathlib.Path(args.out).expanduser().resolve()

    try:
        patch = json.load(open(args.patch, "r", encoding="utf-8"))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"patch load failed: {e}"}))
        return 1

    # load paired spec if present
    spec_path = pathlib.Path(args.spec) if args.spec else pathlib.Path(str(inp) + ".spec.json")
    spec = None
    if spec_path.exists():
        try:
            spec = json.load(open(spec_path, "r", encoding="utf-8"))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"spec load failed: {e}"}))
            return 1

    # apply live ops against a freshly-opened Document
    try:
        doc = Document(str(inp))
        spec_changed, new_spec, warnings = apply_patch(doc, spec, patch)
    except OpError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)

    if spec_changed:
        # write updated spec, then run build_doc.py to regenerate
        out_spec = out.with_suffix(out.suffix + ".spec.json")
        out_spec.write_text(json.dumps(new_spec, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        build_path = pathlib.Path(__file__).resolve().parent / "build_doc.py"
        proc = subprocess.run(
            [sys.executable, str(build_path), "--spec", str(out_spec), "--out", str(out)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(json.dumps({
                "ok": False,
                "error": f"spec-level rebuild failed: {proc.stdout}{proc.stderr}",
            }))
            return 1
        print(json.dumps({
            "ok": True, "path": str(out), "spec_path": str(out_spec),
            "mode": "spec_rebuild", "warnings": warnings,
        }, ensure_ascii=False))
        return 0

    # live-only path: just save
    doc.save(str(out))
    # copy the spec if it was present (still consistent since no spec ops)
    if spec is not None:
        out_spec = out.with_suffix(out.suffix + ".spec.json")
        out_spec.write_text(json.dumps(spec, ensure_ascii=False, indent=2),
                            encoding="utf-8")
    print(json.dumps({
        "ok": True, "path": str(out), "mode": "live_patch",
        "ops_applied": len(patch.get("operations", [])),
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
