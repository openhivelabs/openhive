#!/usr/bin/env python3
"""Rich structural summary of a .pdf.

Prints JSON:
    {
      "ok": true,
      "meta": {...},
      "page_count": N,
      "pages": [
        {"index": 0, "width_pt": 595.3, "height_pt": 841.9,
         "char_count": 1234, "text_preview": "...", "orientation": "portrait"},
        ...
      ]
    }
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    args = ap.parse_args()

    try:
        from helpers.pdf_ops import count_pages, get_metadata, extract_text_per_page
        from pypdf import PdfReader
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    path = str(pathlib.Path(args.inp).expanduser())
    try:
        r = PdfReader(path)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"open failed: {e}"}))
        return 1

    pages_out = []
    texts = extract_text_per_page(path)
    for i, page in enumerate(r.pages):
        mb = page.mediabox
        w = float(mb.width); h = float(mb.height)
        text = texts[i]
        pages_out.append({
            "index": i,
            "width_pt": round(w, 1),
            "height_pt": round(h, 1),
            "orientation": "landscape" if w > h else "portrait",
            "char_count": len(text),
            "text_preview": (text or "")[:200].replace("\n", " "),
        })

    print(json.dumps({
        "ok": True,
        "meta": get_metadata(path),
        "page_count": len(r.pages),
        "pages": pages_out,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
