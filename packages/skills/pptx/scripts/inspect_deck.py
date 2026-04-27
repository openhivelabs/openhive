#!/usr/bin/env python3
"""Rich structural summary of an existing .pptx.

Prints JSON:
    {
      "ok": true,
      "slide_count": N,
      "size": {"w_in": ..., "h_in": ...},
      "parts": {"charts": K, "images": M, "tables": T, "media_bytes": B},
      "slides": [
        {
          "index": 0,
          "shapes": 5,
          "title_guess": "...",
          "type_guess": "title|bullets|chart|table|image|...",
          "text_snippets": ["..."],
          "charts": [{"kind": "column", "series": 2, "categories": 4}],
          "tables": [{"rows": 5, "cols": 3}],
          "images": 0,
          "has_notes": true
        },
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
        from helpers.opc import Package, RT_NOTES
        from helpers.patch import (
            A, P, _charts, _pictures, _graphic_frames, _get_sp_text,
            list_slide_parts,
        )
        from helpers.chart_data import read_chart_data
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    try:
        pkg = Package.open(args.inp)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"open failed: {e}"}))
        return 1

    # presentation-level size
    main = pkg.main_document()
    main_root = main.xml()
    sld_size = main_root.find(f"{{{P}}}sldSz")
    w_emu = int(sld_size.get("cx", 0)) if sld_size is not None else 0
    h_emu = int(sld_size.get("cy", 0)) if sld_size is not None else 0

    # part-level aggregate stats
    n_charts = 0; n_images = 0; n_tables = 0; media_bytes = 0
    for p in pkg.iter_parts():
        if "chart" in p.content_type:
            n_charts += 1
        if p.content_type.startswith("image/"):
            n_images += 1
            media_bytes += len(p.blob)

    slides_out = []
    for i, sp in enumerate(list_slide_parts(pkg)):
        root = sp.xml()
        shapes = list(root.iter(f"{{{P}}}sp"))
        pics = _pictures(root)
        charts = _charts(root)
        tables = _graphic_frames(
            root, uri_filter="http://schemas.openxmlformats.org/drawingml/2006/table"
        )
        n_tables += len(tables)

        text_snippets = []
        title_guess = None
        for s in shapes:
            txt = _get_sp_text(s).strip()
            if not txt:
                continue
            text_snippets.append(txt[:120])
            if title_guess is None and "\n" not in txt and len(txt) < 100:
                title_guess = txt.split("\n")[0]

        # chart details
        chart_details = []
        for k in range(len(charts)):
            data = read_chart_data(pkg, sp, chart_idx=k)
            if data:
                chart_details.append({
                    "kind": data.get("kind"),
                    "series": len(data.get("series", [])),
                    "categories": len(data.get("categories", [])),
                })

        # table details
        table_details = []
        for frame in tables:
            tbl = frame.find(f".//{{{A}}}tbl")
            if tbl is None:
                continue
            trs = tbl.findall(f"{{{A}}}tr")
            tcs = trs[0].findall(f"{{{A}}}tc") if trs else []
            table_details.append({"rows": len(trs), "cols": len(tcs)})

        # type guess (lightweight heuristic)
        if charts:
            type_guess = "chart"
        elif tables:
            type_guess = "table"
        elif pics and not text_snippets:
            type_guess = "image"
        elif len(text_snippets) <= 2 and all("\n" not in t for t in text_snippets):
            type_guess = "title"
        else:
            type_guess = "bullets"

        has_notes = bool(pkg.related(sp, RT_NOTES))

        # Suggested patch DSL selectors for this slide. The LLM uses these
        # to write edit_deck.py patches without having to guess the grammar.
        selectors: dict[str, str] = {
            "title":    f"slide:{i} > title",
            "subtitle": f"slide:{i} > subtitle",
            "body":     f"slide:{i} > body",
            "notes":    f"slide:{i} > notes",
        }
        for k in range(len(charts)):
            key = "chart" if k == 0 else f"chart:{k}"
            selectors[key] = f"slide:{i} > {key}"
        for k in range(len(tables)):
            key = "table" if k == 0 else f"table:{k}"
            selectors[key] = f"slide:{i} > {key}"
            # also surface a sample cell selector for the LLM
            selectors[f"{key}_cell"] = f"slide:{i} > {key} > cell[r=0,c=0]"
        for k in range(len(pics)):
            key = "image" if k == 0 else f"image:{k}"
            selectors[key] = f"slide:{i} > {key}"

        slides_out.append({
            "index": i,
            "shapes": len(shapes),
            "title_guess": title_guess,
            "type_guess": type_guess,
            "text_snippets": text_snippets[:6],
            "charts": chart_details,
            "tables": table_details,
            "images": len(pics),
            "has_notes": has_notes,
            "selectors": selectors,
        })

    print(json.dumps({
        "ok": True,
        "slide_count": len(slides_out),
        "size": {
            "w_in": round(w_emu / 914400.0, 3),
            "h_in": round(h_emu / 914400.0, 3),
        },
        "parts": {
            "charts": n_charts,
            "images": n_images,
            "tables": n_tables,
            "media_bytes": media_bytes,
        },
        "slides": slides_out,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
