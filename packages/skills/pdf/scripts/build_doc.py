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

from _lib.output_path import is_scratch_target, resolve_out  # noqa: E402
from _lib.verify import EmitError, check_file, emit_error, emit_success  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", help="Path to JSON spec. If omitted, reads stdin.")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scratch", action="store_true",
                    help="Write to --out literally (skip OPENHIVE_OUTPUT_DIR). "
                         "Use for verification renders that should not appear "
                         "in the chat artifact panel.")
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
        from reportlab.pdfbase.pdfmetrics import registerFontFamily

        from lib.renderers import Ctx, RENDERERS, resolve_page_size
        from lib.spec import SpecError, validate
        from lib.themes import get_theme
        # Unified Noto font resolver lives in packages/skills/_lib — covers KR,
        # JP, SC/TC, Arabic, Devanagari, Thai, Hebrew. Built-in Helvetica
        # stays for pure-Latin docs to avoid any network round-trip.
        from _lib import fonts as _fonts
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
    # Scan every text field in the spec to decide which Noto variant we need.
    # reportlab can't do per-glyph fallback, so we pick one font for the whole
    # document — the Noto cut for the dominant non-Latin script also covers
    # Latin, so mixed-script output still looks coherent.
    script = _fonts.dominant_script(_gather_text(spec))
    if script != _fonts.SCRIPT_LATIN:
        font_name = _fonts.register_reportlab(script)
        if font_name:
            # Register the same TTF as the bold/italic faces so reportlab's
            # <b>/<i> inline tags resolve without a "font not found" error.
            # Visual weight is synthesised by the viewer — slightly lighter
            # than a hinted bold cut, but legible and zero-cost.
            registerFontFamily(
                font_name,
                normal=font_name, bold=font_name,
                italic=font_name, boldItalic=font_name,
            )
            theme = _dc_replace(theme, heading_font=font_name, body_font=font_name)
    size_name = meta.get("size", "A4")
    orient = meta.get("orientation", "portrait")
    page_w, page_h = resolve_page_size(size_name, orient)
    ctx = Ctx(theme, page_w, page_h)

    scratch_mode = is_scratch_target(args.out, scratch=args.scratch)
    out = resolve_out(args.out, scratch=args.scratch)
    out.parent.mkdir(parents=True, exist_ok=True)

    has_toc = any(b.get("type") == "toc" for b in spec["blocks"])

    # Heading texts that are obviously the *header for the TOC itself* —
    # don't let those re-enter the TOC as their own entry. Covers KR + EN +
    # CJK + JP common forms.
    import re as _re
    _TOC_HEADER_RE = _re.compile(
        r"^\s*(목차|차례|目次|目录|目錄|index|contents|table\s+of\s+contents)\s*$",
        _re.IGNORECASE,
    )

    class _Doc(SimpleDocTemplate):
        """Captures heading flowables for TableOfContents so the TOC block
        actually fills with real entries instead of the empty placeholder
        ReportLab produces by default."""

        def afterFlowable(self, flowable):  # noqa: D401
            level = getattr(flowable, "_toc_level", None)
            if level is None or level > 3:
                return
            # Explicit author-side or renderer-side opt-out.
            if getattr(flowable, "_toc_skip", False):
                return
            try:
                text = flowable.getPlainText()
            except Exception:
                return
            # The TOC's own header heading would otherwise list itself as the
            # first entry ("목차 ........ 2"). Filter the obvious cases.
            if _TOC_HEADER_RE.match(text or ""):
                return
            try:
                self.notify("TOCEntry", (level - 1, text, self.page))
            except Exception:
                pass

    doc = _Doc(
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
                "are malformed table rows or unsupported fields",
            ) from e

    try:
        builder = doc.multiBuild if has_toc else doc.build
        builder(story, onFirstPage=_make_page_decorator(theme),
                onLaterPages=_make_page_decorator(theme))
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        raise EmitError(
            "build_failed",
            f"build failed: {e}",
            "check that page size / margins leave room for the content; "
            "very tall blocks or oversized images can abort a build",
        ) from e

    # self-check: a valid PDF is comfortably over 1KB
    check_file(str(out), min_bytes=1000)

    # Auto-save the spec sidecar next to the PDF so edit_doc.py spec ops
    # can roundtrip without the agent having to write a .spec.json by
    # hand. The runner uses envelope-declared `files[]` (PDF only) and
    # ignores everything else in the output dir, so this sidecar lives
    # on disk for tooling but never appears in the chat artifact panel.
    sidecar = out.with_suffix(out.suffix + ".spec.json")
    try:
        sidecar.write_text(
            json.dumps(spec, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as e:
        # Sidecar is a nice-to-have. Failing the build because the user's
        # filesystem refused a sibling write would be hostile.
        sys.stderr.write(f"note: spec sidecar write failed: {e}\n")

    # Scratch builds (verification renders, agent probes) must NOT declare
    # the file to the runner — runner.ts registers any envelope-declared
    # path as a chat artifact regardless of where it lives. Sending an
    # empty `files` array makes filesFromEnvelope return undefined; the
    # runner then falls back to an OPENHIVE_OUTPUT_DIR snapshot diff,
    # which never sees a /tmp scratch file. Net: zero artifact registered.
    declared_files: list[dict[str, str]] = (
        []
        if scratch_mode
        else [{"name": out.name, "path": str(out), "mime": "application/pdf"}]
    )
    emit_success(
        files=declared_files,
        warnings=list(warnings) + list(ctx.warnings),
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


def _gather_text(obj) -> str:
    """Flatten every string value in a spec tree into one blob.

    Used by the font picker to detect non-Latin scripts. We recurse through
    dicts/lists and collect strings with a space separator — exact structure
    doesn't matter, only the set of Unicode code points present.
    """
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
        # int/float/bool/None contribute no glyphs — skip.

    _walk(obj)
    return " ".join(buf)


def _load_spec(path: str | None) -> dict:
    if path and path != "-":
        with open(pathlib.Path(path).expanduser(), "r", encoding="utf-8") as f:
            return json.load(f)
    return json.load(sys.stdin)


if __name__ == "__main__":
    raise SystemExit(main())
