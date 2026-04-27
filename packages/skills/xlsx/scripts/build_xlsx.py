#!/usr/bin/env python3
"""Build an .xlsx workbook from a JSON spec.

Usage:
    python build_xlsx.py --spec spec.json --out out.xlsx
    cat spec.json | python build_xlsx.py --out out.xlsx

On success: {"ok": true, "path": "...", "sheets": N, "warnings": [...]}.
On failure: {"ok": false, "error": "..."} (exit 1).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import traceback

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.output_path import resolve_out  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", help="Path to JSON spec. If omitted, reads stdin.")
    ap.add_argument("--out", required=True, help="Output .xlsx path.")
    args = ap.parse_args()

    try:
        spec = _load_spec(args.spec)
    except Exception as e:
        return _fail(f"failed to load spec: {e}")

    try:
        from lib.renderers import render_workbook
        from lib.spec import SpecError, validate
        from lib.themes import get_theme
    except ImportError as e:
        return _fail(f"missing dependency: {e}. Run: pip install openpyxl")

    try:
        warnings = validate(spec)
    except SpecError as e:
        return _fail(str(e))

    meta = spec.get("meta") or {}
    theme = get_theme(meta.get("theme"), meta.get("theme_overrides"))
    # Pin the theme fonts to the dominant non-Latin script in the
    # workbook text so Excel/Numbers don't fall through to a system
    # default that lacks coverage. Mirrors the pptx/docx behaviour.
    try:
        from _lib import fonts as _fonts  # type: ignore
        from dataclasses import replace as _dc_replace
        _script = _fonts.dominant_script(_gather_text(spec))
        if _script != _fonts.SCRIPT_LATIN:
            _name = _fonts.display_name(_script)
            theme = _dc_replace(theme, body_font=_name, heading_font=_name)
    except Exception:
        pass

    try:
        wb = render_workbook(spec, theme)
    except Exception as e:
        return _fail(f"render failed: {e}\n{traceback.format_exc()}")

    out = resolve_out(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))

    print(json.dumps({
        "ok": True,
        "path": str(out),
        "sheets": len(spec["sheets"]),
        "theme": theme.name,
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


def _gather_text(obj) -> str:
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


def _fail(msg: str) -> int:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
