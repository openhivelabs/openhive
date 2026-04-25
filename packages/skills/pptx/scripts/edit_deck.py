#!/usr/bin/env python3
"""Apply a patch to an existing .pptx.

Patch DSL (see reference/patch_dsl.md for full grammar):

    {
      "operations": [
        {"op": "set_text",        "target": "slide:2 > title",  "value": "new title"},
        {"op": "replace_bullets", "target": "slide:3",          "value": ["a", "b", ["b1", "b2"]]},
        {"op": "update_chart",    "target": "slide:5 > chart",
                                  "categories": ["Q1","Q2","Q3","Q4"],
                                  "series": [{"name": "revenue", "values": [10,20,30,40]}]},
        {"op": "swap_image",      "target": "slide:4 > image",  "value": "/path/to/new.png"},
        {"op": "delete_slide",    "target": "slide:7"},
        {"op": "insert_slide",    "position": 3, "slide": {"type": "bullets", ...}},
        {"op": "move_slide",      "from": 5, "to": 2},
        {"op": "set_notes",       "target": "slide:2",          "value": "speaker notes"},
        {"op": "set_style",       "target": "slide:2 > title",
                                  "font": "Georgia", "size": 48, "bold": true}
      ]
    }

Usage:
    python edit_deck.py --in deck.pptx --patch patch.json --out out.pptx
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.output_path import resolve_out  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--patch", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        from helpers.opc import Package
        from helpers.patch import OpError, apply_patch
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    try:
        patch = json.load(open(args.patch, "r", encoding="utf-8"))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"patch load failed: {e}"}))
        return 1

    try:
        pkg = Package.open(args.inp)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"open failed: {e}"}))
        return 1

    try:
        warnings = apply_patch(pkg, patch)
    except OpError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1
    except Exception as e:
        import traceback
        print(json.dumps({"ok": False, "error": f"unexpected: {e}\n{traceback.format_exc()}"}))
        return 1

    out = resolve_out(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pkg.save(str(out))

    # count slides after
    from helpers.patch import list_slide_parts
    slides = len(list_slide_parts(pkg))

    print(json.dumps({
        "ok": True,
        "path": str(out),
        "slides": slides,
        "ops_applied": len(patch.get("operations", [])),
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
