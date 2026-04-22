#!/usr/bin/env python3
"""Build a .docx from a JSON spec.

Usage:
    python build_doc.py --spec spec.json --out report.docx
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import traceback

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))
# _lib/fonts.py lives at packages/skills/_lib — one level above this skill.
sys.path.insert(0, str(SKILL_ROOT.parent))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", help="Path to JSON spec. If omitted, reads stdin.")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        spec = _load_spec(args.spec)
    except Exception as e:
        _fail(f"failed to load spec: {e}")
        return 1

    try:
        from docx import Document
        from docx.shared import Inches

        from lib.renderers import RENDERERS
        from lib.spec import SpecError, validate
        from lib.themes import get_theme
    except ImportError as e:
        _fail(f"missing dependency: {e}. Run: pip install python-docx")
        return 1

    try:
        warnings = validate(spec)
    except SpecError as e:
        _fail(str(e))
        return 1

    meta = spec.get("meta") or {}
    theme = get_theme(meta.get("theme"), meta.get("theme_overrides"))
    # Pin the document to one Noto cut so CJK/Arabic/Thai/Devanagari text
    # doesn't fall through to whatever random font the reader happens to
    # have. Pure-Latin docs keep the theme's default (Helvetica/Georgia).
    from _lib import fonts as _fonts
    from dataclasses import replace as _dc_replace
    _script = _fonts.dominant_script(_gather_text(spec))
    if _script != _fonts.SCRIPT_LATIN:
        _name = _fonts.display_name(_script)
        theme = _dc_replace(theme, heading_font=_name, body_font=_name)

    doc = Document()

    # metadata
    cp = doc.core_properties
    if meta.get("title"):    cp.title = meta["title"]
    if meta.get("author"):   cp.author = meta["author"]
    if meta.get("subject"):  cp.subject = meta["subject"]

    # page setup
    size_name = meta.get("size", "A4")
    orient = meta.get("orientation", "portrait")
    _apply_page_setup(doc, size_name, orient, theme)

    # render blocks
    for i, block in enumerate(spec["blocks"]):
        renderer = RENDERERS[block["type"]]
        try:
            renderer(doc, block, theme)
        except Exception as e:
            _fail(f"block[{i}] ({block['type']}): render failed: {e}\n"
                  + traceback.format_exc())
            return 1

    out = pathlib.Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))

    # also save the spec alongside (for edit-via-rebuild flow)
    spec_out = out.with_suffix(out.suffix + ".spec.json")
    spec_out.write_text(json.dumps(spec, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "path": str(out),
        "spec_path": str(spec_out),
        "blocks": len(spec["blocks"]),
        "theme": theme.name,
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


def _apply_page_setup(doc, size_name: str, orient: str, theme) -> None:
    from docx.shared import Inches
    from docx.enum.section import WD_ORIENT
    section = doc.sections[0]
    # page size (inches)
    sizes = {
        "A4": (8.27, 11.69),
        "Letter": (8.5, 11.0),
        "Legal": (8.5, 14.0),
    }
    w, h = sizes.get(size_name, sizes["A4"])
    if orient == "landscape":
        w, h = h, w
        section.orientation = WD_ORIENT.LANDSCAPE
    section.page_width = Inches(w)
    section.page_height = Inches(h)
    section.left_margin = Inches(theme.margin_left)
    section.right_margin = Inches(theme.margin_right)
    section.top_margin = Inches(theme.margin_top)
    section.bottom_margin = Inches(theme.margin_bottom)


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
