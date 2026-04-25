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
# _lib/ lives at packages/skills/_lib — one level above this skill.
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.output_path import resolve_out  # noqa: E402


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
    # Swap the theme fonts to a Noto cut matching the dominant script of the
    # deck text. PowerPoint picks a system fallback if the user doesn't have
    # Noto installed, which is still far better than the default Helvetica
    # (no CJK/Arabic/Thai coverage at all).
    from _lib import fonts as _fonts
    from dataclasses import replace as _dc_replace
    _script = _fonts.dominant_script(_gather_text(spec))
    if _script != _fonts.SCRIPT_LATIN:
        _name = _fonts.display_name(_script)
        theme = _dc_replace(theme, heading_font=_name, body_font=_name)
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

    out = resolve_out(args.out)
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


def _gather_text(obj) -> str:
    """Collect every string in the spec into one blob for script detection."""
    buf: list[str] = []

    def _walk(v) -> None:
        if isinstance(v, str):
            buf.append(v)
        elif isinstance(v, dict):
            for item in v.values():
                _walk(item)
        elif isinstance(v, list):
            for item in v:
                _walk(item)

    _walk(obj)
    return " ".join(buf)


def _load_spec(path: str | None) -> dict:
    if path and path != "-":
        with open(pathlib.Path(path).expanduser(), "r", encoding="utf-8") as f:
            return json.load(f)
    return json.load(sys.stdin)


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}), file=sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
