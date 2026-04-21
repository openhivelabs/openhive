#!/usr/bin/env python3
"""Rich structural summary of a .docx.

Prints JSON:
    {
      "ok": true,
      "meta": {"title": ..., "author": ..., "subject": ...},
      "page_count_est": N,
      "paragraph_count": N,
      "heading_count": K,
      "table_count": T,
      "image_count": I,
      "headings": [{"index": N, "level": L, "text": "..."}, ...],
      "tables":   [{"index": N, "rows": R, "cols": C}, ...],
      "images":   [{"index": N, "partname": "..."}, ...]
    }
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
    args = ap.parse_args()

    try:
        from docx import Document
        from docx.oxml.ns import qn
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    try:
        doc = Document(str(pathlib.Path(args.inp).expanduser()))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"open failed: {e}"}))
        return 1

    cp = doc.core_properties
    meta = {
        "title": cp.title or "",
        "author": cp.author or "",
        "subject": cp.subject or "",
    }

    paragraphs = doc.paragraphs
    headings: list[dict] = []
    for i, p in enumerate(paragraphs):
        sty = p.style.name if p.style else ""
        m = re.fullmatch(r"Heading (\d)", sty)
        if m:
            headings.append({"index": len(headings), "level": int(m.group(1)),
                             "text": p.text[:120]})

    tables = []
    for i, t in enumerate(doc.tables):
        rows = len(t.rows)
        cols = len(t.rows[0].cells) if rows else 0
        tables.append({"index": i, "rows": rows, "cols": cols})

    images = []
    for i, blip in enumerate(doc.element.body.iter(qn("a:blip"))):
        rid = blip.get(qn("r:embed"))
        rel = doc.part.rels.get(rid) if rid else None
        partname = rel.target_ref if rel else ""
        images.append({"index": i, "partname": partname})

    # crude page count: count page breaks + 1
    page_breaks = 0
    for br in doc.element.body.iter(qn("w:br")):
        if br.get(qn("w:type")) == "page":
            page_breaks += 1

    print(json.dumps({
        "ok": True,
        "meta": meta,
        "page_count_est": page_breaks + 1,
        "paragraph_count": len(paragraphs),
        "heading_count": len(headings),
        "table_count": len(tables),
        "image_count": len(images),
        "headings": headings,
        "tables": tables,
        "images": images,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
