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
# _lib lives one level above packages/skills/pdf — at packages/skills/_lib.
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.verify import EmitError, check_file, emit_error, emit_success  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", help="Path to JSON spec. If omitted, reads stdin.")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        return _run(args)
    except EmitError as e:
        emit_error(e.code, e.message, e.suggestion)
        return 1  # unreachable; emit_error exits
    except Exception as e:  # last-resort structured failure
        emit_error(
            "unexpected_error",
            f"{type(e).__name__}: {e}",
            "see stderr for traceback; fix the underlying exception and retry",
        )
        return 1


def _run(args: argparse.Namespace) -> int:
    try:
        spec = _load_spec(args.spec)
    except Exception as e:
        raise EmitError(
            "bad_spec",
            f"failed to load spec: {e}",
            "check that --spec points to a valid JSON file or that stdin "
            "contains a well-formed JSON spec",
        ) from e

    try:
        from dataclasses import replace as _dc_replace

        from reportlab.platypus import SimpleDocTemplate

        from lib.fonts import ensure_cjk_font
        from lib.renderers import Ctx, RENDERERS, resolve_page_size
        from lib.spec import SpecError, validate
        from lib.themes import get_theme
    except ImportError as e:
        raise EmitError(
            "missing_dependency",
            f"missing dependency: {e}",
            "run: pip install reportlab pypdf Pillow",
        ) from e

    try:
        warnings = validate(spec)
    except SpecError as e:
        raise EmitError(
            "bad_spec",
            str(e),
            "fix the spec validation error described in the message and retry",
        ) from e

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
            sys.stderr.write(traceback.format_exc())
            raise EmitError(
                "render_failed",
                f"block[{i}] ({block['type']}): render failed: {e}",
                "inspect the indicated block in the spec; common causes "
                "are malformed table rows, bad image paths, or unsupported "
                "fields",
            ) from e

    try:
        doc.build(story, onFirstPage=_make_page_decorator(theme),
                  onLaterPages=_make_page_decorator(theme))
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        raise EmitError(
            "build_failed",
            f"build failed: {e}",
            "check that page size / margins leave room for the content; "
            "very tall blocks or oversized images can abort a build",
        ) from e

    # pair .spec.json for edit round-trip
    spec_out = out.with_suffix(out.suffix + ".spec.json")
    spec_out.write_text(json.dumps(spec, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    # self-check: a valid PDF is comfortably over 1KB
    check_file(str(out), min_bytes=1000)

    emit_success(
        files=[
            {
                "name": out.name,
                "path": str(out),
                "mime": "application/pdf",
            },
            {
                "name": spec_out.name,
                "path": str(spec_out),
                "mime": "application/json",
            },
        ],
        warnings=warnings,
    )
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


if __name__ == "__main__":
    raise SystemExit(main())
