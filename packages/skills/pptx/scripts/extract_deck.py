#!/usr/bin/env python3
"""Reverse-engineer an existing .pptx back into a spec JSON.

Best-effort — not every deck round-trips cleanly. Slides built from our
own `build_deck.py` round-trip at high fidelity. Decks built in PowerPoint
with complex masters / animations may lose formatting on rebuild (the text
and data survive; colours and exact positions may drift).

The extracted spec is compatible with `build_deck.py`, so the flow
    extract_deck → hand-edit JSON → build_deck
is a perfectly safe "edit" loop that doesn't touch raw XML at all.

Usage:
    python extract_deck.py --in deck.pptx --out spec.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))


# ---------------------------------------------------------------------------
# slide analyzer
# ---------------------------------------------------------------------------


def analyze_slide(pkg, slide_part) -> dict:
    """Return a slide spec guessed from the slide's XML content.

    Type inference order:
      - Has a chart?      → chart
      - Has a table?      → table
      - Has 2+ shapes and large text at top = short, body = multi-line? → bullets / two_column
      - First slide and title-looking? → title
      - Has 'thank you' / 'q&a' hint at end? → closing
      - Fallback: bullets
    """
    from lxml import etree
    from helpers.patch import (
        A, P, C, _charts, _pictures, _graphic_frames,
        _placeholder_shape, _get_sp_text,
    )
    from helpers.chart_data import read_chart_data

    root = slide_part.xml()

    # gather facts
    sps_with_text = [sp for sp in root.iter(f"{{{P}}}sp") if _get_sp_text(sp).strip()]
    charts = _charts(root)
    tables = _graphic_frames(root, uri_filter="http://schemas.openxmlformats.org/drawingml/2006/table")
    pictures = _pictures(root)

    # notes
    from helpers.opc import RT_NOTES
    notes_text = ""
    for np in pkg.related(slide_part, RT_NOTES):
        nroot = np.xml()
        for sp in nroot.iter(f"{{{P}}}sp"):
            ph = sp.find(f".//{{{P}}}nvSpPr/{{{P}}}nvPr/{{{P}}}ph")
            if ph is not None and ph.get("type") == "body":
                notes_text = _get_sp_text(sp).strip()
                break

    # ---- specific types ----

    if charts:
        data = read_chart_data(pkg, slide_part, chart_idx=0)
        if data:
            spec = {
                "type": "chart",
                "kind": data.get("kind", "column"),
                "categories": data.get("categories", []),
                "series": data.get("series", []),
            }
            # title guess = topmost text not in the chart frame
            title = _topmost_text(sps_with_text)
            if title:
                spec["title"] = title
            if notes_text:
                spec["notes"] = notes_text
            return spec

    if tables:
        tbl = tables[0].find(f".//{{{A}}}tbl")
        headers, rows = _extract_table(tbl)
        spec = {"type": "table", "headers": headers, "rows": rows}
        title = _topmost_text(sps_with_text)
        if title:
            spec["title"] = title
        if notes_text:
            spec["notes"] = notes_text
        return spec

    # image-only slide
    if pictures and not sps_with_text:
        # can't recover image data cleanly (only partname); mark as image slide
        return {"type": "image", "image": "(binary, preserved in place)",
                "notes": notes_text} if notes_text else {"type": "image", "image": "(binary)"}

    # ---- text-only slides ----

    texts = [(sp, _get_sp_text(sp)) for sp in sps_with_text]
    if not texts:
        return {"type": "bullets", "title": "(empty)", "bullets": ["(empty)"]}

    # sort by y offset
    def _y(sp):
        off = sp.find(f".//{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off")
        try:
            return int(off.get("y")) if off is not None and off.get("y") else 0
        except ValueError:
            return 0
    texts.sort(key=lambda pair: _y(pair[0]))

    # title = topmost; body = rest
    title = texts[0][1].strip()
    rest_shapes = [sp for sp, _ in texts[1:]]

    # single-line title-only slide → title or closing
    if len(texts) == 1 and "\n" not in title:
        if any(k in title.lower() for k in ["thank", "q&a", "\uac10\uc0ac", "\uace0\ub9d9", "\ub05d"]):
            return {"type": "closing", "title": title}
        return {"type": "title", "title": title}

    # 2 shapes, both short → title + subtitle
    if len(texts) == 2 and "\n" not in texts[1][1]:
        return {"type": "title" if _y(texts[0][0]) < 2000000 else "section",
                "title": title, "subtitle": texts[1][1].strip()}

    # multiple shapes with bullets → bullets
    if rest_shapes:
        # pick the shape with most paragraphs as the body
        body = max(rest_shapes, key=lambda sp: len(sp.findall(f"{{{P}}}txBody/{{{A}}}p")))
        bullets = _extract_bullets(body)
        spec = {"type": "bullets", "title": title, "bullets": bullets or ["(empty)"]}
        if notes_text:
            spec["notes"] = notes_text
        return spec

    # fallback
    return {"type": "bullets", "title": title, "bullets": ["(extracted content)"]}


def _extract_bullets(body_sp) -> list:
    """Turn a body placeholder's paragraphs into a (possibly nested) bullets list."""
    from lxml import etree
    from helpers.patch import A, P

    tx = body_sp.find(f"{{{P}}}txBody")
    if tx is None:
        return []
    out: list = []
    # track last level-0 bullet index so we can nest
    for p in tx.findall(f"{{{A}}}p"):
        pPr = p.find(f"{{{A}}}pPr")
        lvl = int(pPr.get("lvl", "0")) if pPr is not None else 0
        runs = [t.text or "" for t in p.iter(f"{{{A}}}t")]
        text = "".join(runs).strip()
        if not text:
            continue
        if lvl == 0:
            out.append(text)
        else:
            if out and isinstance(out[-1], str):
                out.append([text])
            elif out and isinstance(out[-1], list):
                out[-1].append(text)
            else:
                out.append(text)
    return out


def _extract_table(tbl) -> tuple[list[str], list[list]]:
    """Extract headers (first row) + remaining rows from an <a:tbl>."""
    from helpers.patch import A

    if tbl is None:
        return [], []
    rows_out: list[list[str]] = []
    for tr in tbl.findall(f"{{{A}}}tr"):
        cells = []
        for tc in tr.findall(f"{{{A}}}tc"):
            run_texts = [t.text or "" for t in tc.iter(f"{{{A}}}t")]
            cells.append("".join(run_texts).strip())
        rows_out.append(cells)
    if not rows_out:
        return [], []
    return rows_out[0], rows_out[1:]


def _topmost_text(shapes) -> str:
    from helpers.patch import A, P, _get_sp_text
    if not shapes:
        return ""
    def _y(sp):
        off = sp.find(f".//{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off")
        try:
            return int(off.get("y")) if off is not None and off.get("y") else 0
        except ValueError:
            return 0
    sps = sorted(shapes, key=_y)
    for sp in sps:
        t = _get_sp_text(sp).strip()
        if t and "\n" not in t and len(t) < 200:
            return t
    return _get_sp_text(sps[0]).strip().split("\n")[0]


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--theme", default="default")
    ap.add_argument("--size", default="16:9")
    args = ap.parse_args()

    from helpers.opc import Package
    from helpers.patch import list_slide_parts

    pkg = Package.open(args.inp)
    slides = list_slide_parts(pkg)
    warnings: list[str] = []
    slide_specs: list[dict] = []

    for i, sp in enumerate(slides):
        try:
            spec = analyze_slide(pkg, sp)
        except Exception as e:
            warnings.append(f"slide[{i}]: extract failed: {e}")
            spec = {"type": "bullets", "title": f"(slide {i})",
                    "bullets": ["(extract failed)"]}
        slide_specs.append(spec)

    deck = {
        "meta": {"theme": args.theme, "size": args.size,
                 "title": slide_specs[0].get("title", "")},
        "slides": slide_specs,
    }

    pathlib.Path(args.out).expanduser().write_text(
        json.dumps(deck, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps({
        "ok": True,
        "path": str(args.out),
        "slides": len(slide_specs),
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
