#!/usr/bin/env python3
"""image-gen skill entrypoint.

stdin JSON:
  template mode: {"mode": "template", "template": "<name>", "vars": {...}, "filename": "out.png"}
  freeform mode: {"mode": "freeform", "html": "...", "width": int, "height": int, "filename": "out.png"}

stdout envelope (last line):
  success: {"ok": true, "files": [{"name", "path", "mime", "size"}], "warnings": []}
  failure: {"ok": false, "error_code": "...", "message": "...", "suggestion": "..."}
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))
sys.path.insert(0, str(SKILL_DIR.parent))  # so `_lib.verify` imports

from lib.templates import (  # noqa: E402
    TemplateNotFound,
    ValidationError,
    list_templates,
    load_template,
)
from scripts.render import render_png, render_template  # noqa: E402
from scripts.ensure_chromium import ensure as ensure_chromium  # noqa: E402
from _lib.verify import check_file, emit_error, emit_success  # noqa: E402


OUTPUT_DIR = Path(os.environ.get("OPENHIVE_OUTPUT_DIR") or ".").resolve()
TEMPLATES_DIR = SKILL_DIR / "templates"


def _default_filename() -> str:
    return f"image-gen-{int(time.time() * 1000)}.png"


def main() -> None:
    try:
        params = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        emit_error(
            "invalid_input",
            f"stdin is not valid JSON: {exc}",
            "the runner must pipe a JSON object on stdin",
        )
        return

    filename = params.get("filename") or _default_filename()
    if "/" in filename or ".." in filename or "\\" in filename:
        emit_error(
            "invalid_filename",
            f"filename must be a plain name, got {filename!r}",
            "pass only the base filename; the skill writes into OPENHIVE_OUTPUT_DIR",
        )
        return
    if not filename.lower().endswith(".png"):
        filename = f"{filename}.png"
    out_path = OUTPUT_DIR / filename

    mode = params.get("mode")
    html: str
    width: int
    height: int

    try:
        if mode == "template":
            name = params.get("template")
            if not isinstance(name, str):
                emit_error(
                    "missing_template",
                    "`template` must be a string",
                    f"known templates: {list_templates(TEMPLATES_DIR)}",
                )
                return
            try:
                tpl = load_template(TEMPLATES_DIR, name)
            except TemplateNotFound:
                emit_error(
                    "template_not_found",
                    f"template {name!r} does not exist",
                    f"pick one of: {list_templates(TEMPLATES_DIR)}",
                )
                return
            vars_in = params.get("vars") or {}
            if not isinstance(vars_in, dict):
                emit_error(
                    "invalid_vars",
                    "`vars` must be an object",
                    "pass vars as a JSON object matching the template schema",
                )
                return
            try:
                vars_filled = tpl.validate(vars_in)
            except ValidationError as exc:
                emit_error(
                    "validation",
                    str(exc),
                    f"see templates/{name}/template.yaml for the input schema",
                )
                return
            html = render_template(tpl.html_path, vars_filled)
            width, height = tpl.size

        elif mode == "freeform":
            html_in = params.get("html")
            width_in = params.get("width")
            height_in = params.get("height")
            if not isinstance(html_in, str) or not html_in.strip():
                emit_error(
                    "missing_html",
                    "`html` must be a non-empty string",
                    "provide a full HTML document for freeform mode",
                )
                return
            if not isinstance(width_in, int) or not isinstance(height_in, int):
                emit_error(
                    "missing_size",
                    "`width` and `height` must be integers",
                    "supply target pixel dimensions (e.g. 1280 x 720)",
                )
                return
            if not (100 <= width_in <= 4096 and 100 <= height_in <= 4096):
                emit_error(
                    "size_out_of_range",
                    f"size {width_in}x{height_in} out of [100, 4096]",
                    "pick a reasonable pixel size; giant images will OOM Chromium",
                )
                return
            html = html_in
            width = width_in
            height = height_in

        else:
            emit_error(
                "invalid_mode",
                f"mode must be 'template' or 'freeform', got {mode!r}",
                "see SKILL.md for supported modes",
            )
            return

        ensure_chromium()
        bytes_written = render_png(html, width, height, out_path)

        try:
            check_file(str(out_path), min_bytes=200)
        except Exception as exc:
            emit_error(
                "output_sanity",
                f"rendered PNG looks malformed: {exc}",
                "inspect stderr for Playwright warnings; template HTML may be empty",
            )
            return

        emit_success(
            files=[
                {
                    "name": out_path.name,
                    "path": str(out_path),
                    "mime": "image/png",
                    "size": bytes_written,
                }
            ],
            warnings=[],
        )

    except SystemExit:
        raise
    except Exception as exc:
        import traceback

        traceback.print_exc(file=sys.stderr)
        emit_error(
            "unexpected",
            f"{type(exc).__name__}: {exc}",
            "report this as a skill bug; stderr has the traceback",
        )


if __name__ == "__main__":
    main()
