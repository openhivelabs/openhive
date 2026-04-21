#!/usr/bin/env python3
"""Reverse-engineer a PDF into a spec JSON.

Heavily lossy — PDFs don't preserve semantic structure (no "this is a
heading" metadata), so we heuristically split extracted text into blocks:
  - short line followed by blank-like = heading
  - consecutive non-empty lines = paragraph
  - lines starting with '- ' = bullets
  - lines with '|' separators = table (naive)

For PDFs produced by our build_doc.py, the paired .spec.json already
exists — use that directly instead of this script.

Usage:
    python extract_doc.py --in in.pdf --out spec.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--theme", default="default")
    args = ap.parse_args()

    try:
        from helpers.pdf_ops import extract_text_per_page, get_metadata
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    path = str(pathlib.Path(args.inp).expanduser())
    meta = get_metadata(path)
    pages = extract_text_per_page(path)

    blocks: list[dict] = []
    warnings: list[str] = []

    for page_idx, page_text in enumerate(pages):
        if page_idx > 0:
            blocks.append({"type": "page_break"})
        blocks.extend(_split_into_blocks(page_text))

    spec = {
        "meta": {
            "title": meta.get("title") or "",
            "author": meta.get("author") or "",
            "subject": meta.get("subject") or "",
            "theme": args.theme,
            "size": "A4",
        },
        "blocks": blocks or [{"type": "paragraph", "text": "(empty)"}],
    }

    warnings.append("PDF extraction is heuristic — layout, tables, and "
                    "images are lost. Verify the spec and hand-edit before "
                    "rebuilding if fidelity matters.")

    pathlib.Path(args.out).expanduser().write_text(
        json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps({
        "ok": True, "path": str(args.out), "blocks": len(blocks),
        "pages": len(pages), "warnings": warnings,
    }, ensure_ascii=False))
    return 0


def _split_into_blocks(text: str) -> list[dict]:
    lines = [l.rstrip() for l in text.splitlines()]
    blocks: list[dict] = []
    buf: list[str] = []

    def flush_paragraph():
        nonlocal buf
        if buf:
            joined = " ".join(buf).strip()
            if joined:
                blocks.append({"type": "paragraph", "text": joined})
            buf = []

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            i += 1
            continue

        # bullet?
        m = re.match(r"^\s*[\u2022\-\*]\s+(.+)$", line)
        if m:
            flush_paragraph()
            items = [m.group(1)]
            j = i + 1
            while j < len(lines):
                m2 = re.match(r"^\s*[\u2022\-\*]\s+(.+)$", lines[j])
                if not m2:
                    break
                items.append(m2.group(1))
                j += 1
            blocks.append({"type": "bullets", "items": items})
            i = j
            continue

        # short heading-ish line? (all caps, or first line with no surrounding punctuation)
        if (
            len(stripped) < 80
            and not stripped.endswith((".", ",", ":", ";", "?", "!"))
            and (i + 1 >= len(lines) or not lines[i + 1].strip())
            and not buf
        ):
            flush_paragraph()
            level = 1 if stripped.isupper() or len(stripped) < 40 else 2
            blocks.append({"type": "heading", "level": level, "text": stripped})
            i += 1
            continue

        buf.append(stripped)
        i += 1

    flush_paragraph()
    return blocks


if __name__ == "__main__":
    raise SystemExit(main())
