#!/usr/bin/env python3
"""Reverse-engineer an existing .docx into a spec JSON.

Best-effort. Works well for docx produced by build_doc.py (round-trip).
For docx authored in Word, falls back to: heading → heading, paragraph
→ paragraph, list → bullets/numbered, table → table. Images become
placeholder image blocks with the partname noted.

Usage:
    python extract_doc.py --in in.docx --out spec.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.output_path import resolve_out  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--theme", default="default")
    args = ap.parse_args()

    try:
        from docx import Document
        from docx.oxml.ns import qn
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    doc = Document(str(pathlib.Path(args.inp).expanduser()))
    cp = doc.core_properties

    blocks: list[dict] = []
    warnings: list[str] = []

    # iterate body elements in document order (paragraphs + tables)
    body = doc.element.body
    para_idx = 0
    table_idx = 0
    paragraphs = list(doc.paragraphs)
    tables = list(doc.tables)

    # map XML element → block
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            # is it a heading?
            p = paragraphs[para_idx] if para_idx < len(paragraphs) else None
            para_idx += 1
            if p is None:
                continue
            sty = p.style.name if p.style else ""
            m = re.fullmatch(r"Heading (\d)", sty)
            if m:
                blocks.append({"type": "heading", "level": int(m.group(1)),
                               "text": p.text})
                continue
            # list?
            numPr = child.find(f".//{qn('w:numPr')}")
            if numPr is not None:
                # collapse into bullets/numbered — we handle this as
                # consecutive list paragraphs below; for simplicity treat
                # each list paragraph as its own bullets block
                blocks.append({"type": "bullets", "items": [p.text]})
                continue
            # page break?
            brs = p.runs and any(
                r._r.find(qn("w:br")) is not None and
                r._r.find(qn("w:br")).get(qn("w:type")) == "page"
                for r in p.runs
            )
            if brs and not p.text.strip():
                blocks.append({"type": "page_break"})
                continue
            # horizontal rule (border-bottom)
            pPr = child.find(qn("w:pPr"))
            if pPr is not None and pPr.find(qn("w:pBdr")) is not None and not p.text.strip():
                blocks.append({"type": "horizontal_rule"})
                continue
            # plain paragraph
            if p.text.strip():
                blocks.append({"type": "paragraph", "text": p.text})
        elif tag == "tbl":
            t = tables[table_idx] if table_idx < len(tables) else None
            table_idx += 1
            if t is None:
                continue
            rows = [[cell.text for cell in row.cells] for row in t.rows]
            if not rows:
                continue
            headers = rows[0]
            body_rows = rows[1:]
            if not body_rows:
                # single-row table (our kpi_row / two_column / code blocks render
                # as 1- or 2-row borderless tables). Flatten to paragraphs so
                # the rebuild doesn't hit an empty-rows validator.
                for cell in headers:
                    if cell.strip():
                        blocks.append({
                            "type": "paragraph",
                            "text": cell.replace("\n", "  "),
                        })
                continue
            blocks.append({
                "type": "table", "headers": headers, "rows": body_rows,
                "style": "grid",
            })

    # coalesce consecutive bullets into a single bullets block
    coalesced: list[dict] = []
    for b in blocks:
        if b["type"] == "bullets" and coalesced and coalesced[-1]["type"] == "bullets":
            coalesced[-1]["items"].extend(b["items"])
        else:
            coalesced.append(b)

    spec = {
        "meta": {
            "title": cp.title or "",
            "author": cp.author or "",
            "subject": cp.subject or "",
            "theme": args.theme,
            "size": "A4",
        },
        "blocks": coalesced,
    }

    out = resolve_out(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps({
        "ok": True, "path": str(out), "blocks": len(coalesced),
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
