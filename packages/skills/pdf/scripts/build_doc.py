#!/usr/bin/env python3
"""Build a .pdf from a JSON spec (reportlab Platypus).

Usage:
    python build_doc.py --spec spec.json --out report.pdf
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
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        spec = _load_spec(args.spec)
    except Exception as e:
        _fail(f"failed to load spec: {e}")
        return 1

    try:
        from dataclasses import replace as _dc_replace

        from reportlab.platypus import SimpleDocTemplate

        from lib.fonts import ensure_cjk_font
        from lib.renderers import Ctx, RENDERERS, resolve_page_size
        from lib.spec import SpecError, validate
        from lib.themes import get_theme
    except ImportError as e:
        _fail(f"missing dependency: {e}. Run: pip install reportlab pypdf Pillow")
        return 1

    try:
        warnings = validate(spec)
    except SpecError as e:
        _fail(str(e))
        return 1

    meta = spec.get("meta") or {}
    theme = get_theme(meta.get("theme"), meta.get("theme_overrides"))
    cjk = ensure_cjk_font()
    if cjk:
        theme = _dc_replace(theme, heading_font=cjk, body_font=cjk)
    size_name = meta.get("size", "A4")
    orient = meta.get("orientation", "portrait")
    page_w, page_h = resolve_page_size(size_name, orient)
    ctx = Ctx(theme, page_w, page_h)

    out = pathlib.Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(out),
        pagesize=(page_w, page_h),
        leftMargin=theme.margin_left,
        rightMargin=theme.margin_right,
        topMargin=theme.margin_top,
        bottomMargin=theme.margin_bottom,
        title=meta.get("title", ""),
        author=meta.get("author", ""),
        subject=meta.get("subject", ""),
    )

    story = []
    for i, block in enumerate(spec["blocks"]):
        renderer = RENDERERS[block["type"]]
        try:
            story.extend(renderer(block, theme, ctx))
        except Exception as e:
            _fail(f"block[{i}] ({block['type']}): render failed: {e}\n"
                  + traceback.format_exc())
            return 1

    try:
        doc.build(story, onFirstPage=_make_page_decorator(theme),
                  onLaterPages=_make_page_decorator(theme))
    except Exception as e:
        _fail(f"build failed: {e}\n{traceback.format_exc()}")
        return 1

    # pair .spec.json for edit round-trip
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


def _make_page_decorator(theme):
    """Closure that draws a page number in the bottom-right."""
    from reportlab.lib.colors import Color

    def _draw(canvas, doc):
        canvas.saveState()
        canvas.setFont(theme.body_font, theme.size_small)
        canvas.setFillColor(Color(theme.muted[0] / 255, theme.muted[1] / 255,
                                  theme.muted[2] / 255))
        text = f"{doc.page}"
        canvas.drawRightString(doc.pagesize[0] - theme.margin_right,
                               theme.margin_bottom / 2, text)
        canvas.restoreState()
    return _draw


def _load_spec(path: str | None) -> dict:
    if path and path != "-":
        with open(pathlib.Path(path).expanduser(), "r", encoding="utf-8") as f:
            return json.load(f)
    return json.load(sys.stdin)


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}), file=sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
