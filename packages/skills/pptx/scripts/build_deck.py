#!/usr/bin/env python3
"""Build a .pptx deck from a JSON spec.

Usage:
    python build_deck.py --spec spec.json --out deck.pptx
    cat spec.json | python build_deck.py --out deck.pptx

On success, writes the file and prints a JSON result to stdout:
    {"ok": true, "path": "...", "slides": 12, "warnings": [...]}

On failure prints {"ok": false, "error": "..."} and exits with code 1.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import traceback

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", help="Path to JSON spec. If omitted, reads stdin.")
    ap.add_argument("--out", required=True, help="Output .pptx path.")
    args = ap.parse_args()

    try:
        spec = _load_spec(args.spec)
    except Exception as e:
        _fail(f"failed to load spec: {e}")
        return 1

    try:
        from pptx import Presentation
        from pptx.util import Inches

        from lib.layouts import SIZES, Grid
        from lib.renderers import RENDERERS
        from lib.spec import SpecError, validate
        from lib.themes import get_theme
    except ImportError as e:
        _fail(f"missing dependency: {e}. Run: pip install python-pptx Pillow")
        return 1

    try:
        warnings = validate(spec)
    except SpecError as e:
        _fail(str(e))
        return 1

    meta = spec.get("meta") or {}
    size = meta.get("size", "16:9")
    theme = get_theme(meta.get("theme"), meta.get("theme_overrides"))
    grid = Grid(size=size)

    prs = Presentation()
    w, h = SIZES.get(size, SIZES["16:9"])
    prs.slide_width = Inches(w)
    prs.slide_height = Inches(h)
    blank_layout = prs.slide_layouts[6]  # blank

    for i, s in enumerate(spec["slides"]):
        slide = prs.slides.add_slide(blank_layout)
        renderer = RENDERERS[s["type"]]
        try:
            renderer(slide, s, theme, grid)
        except Exception as e:
            _fail(
                f"slide[{i}] ({s.get('type')}): render failed: {e}\n"
                + traceback.format_exc()
            )
            return 1

    out = pathlib.Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out))

    print(json.dumps({
        "ok": True,
        "path": str(out),
        "slides": len(spec["slides"]),
        "theme": theme.name,
        "size": size,
        "warnings": warnings,
    }))
    return 0


def _load_spec(path: str | None) -> dict:
    if path and path != "-":
        with open(pathlib.Path(path).expanduser(), "r", encoding="utf-8") as f:
            return json.load(f)
    return json.load(sys.stdin)


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}), file=sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
