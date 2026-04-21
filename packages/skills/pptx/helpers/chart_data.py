"""Chart data replacement.

Given a chart part XML produced by python-pptx (or any ECMA-376-compliant
source), replace its categories + series values in place — preserving:
    - chart type (bar/column/line/pie/area/scatter)
    - series names (unless the op provides new names)
    - series colours and line styles
    - legend / axis settings

Does NOT touch the embedded XLSX workbook (if any) — that's used by
PowerPoint for "Edit Data" but isn't authoritative; the XML values win
at render time.
"""
from __future__ import annotations

import re

from lxml import etree

from .opc import Package, Part, RT_CHART
from .patch import A, C, P, R, OpError, _charts, parse_selector, resolve_slide


def op_update_chart(pkg: Package, target: str, *,
                    categories: list | None = None,
                    series: list[dict] | None = None) -> None:
    """Update categories and/or series of a chart referenced from a slide.

    target: 'slide:N > chart[:K]'
    categories: list of strings (or numbers for scatter)
    series: [{"name": "...", "values": [...]}, ...]
            series count must match existing series count; name is optional.
    """
    steps = parse_selector(target)
    if len(steps) < 2 or steps[1].kind != "chart":
        raise OpError("update_chart target must be 'slide:N > chart[:K]'")
    slide_part = resolve_slide(pkg, steps)
    chart_idx = steps[1].index or 0

    slide_root = slide_part.xml()
    frames = _charts(slide_root)
    if not (0 <= chart_idx < len(frames)):
        raise OpError(f"chart index {chart_idx} out of range (have {len(frames)})")
    frame = frames[chart_idx]

    # follow r:id → chart part
    chart_ref = frame.find(f".//{{{C}}}chart")
    if chart_ref is None:
        raise OpError("graphic frame has no c:chart reference")
    rid = chart_ref.get(f"{{{R}}}id")
    if rid is None:
        raise OpError("c:chart element has no r:id")
    chart_part = pkg.related_one(slide_part, rid)
    if chart_part is None:
        raise OpError(f"chart rId {rid} does not resolve")

    root = chart_part.xml()
    plot_area = root.find(f".//{{{C}}}plotArea")
    if plot_area is None:
        raise OpError("chart has no plotArea")

    ser_elements = plot_area.findall(f".//{{{C}}}ser")
    if not ser_elements:
        raise OpError("chart has no series")

    if series is not None and len(series) != len(ser_elements):
        raise OpError(
            f"series count mismatch: chart has {len(ser_elements)}, "
            f"patch provides {len(series)}"
        )

    for i, ser in enumerate(ser_elements):
        _update_series(ser, categories=categories,
                       new=series[i] if series else None)

    chart_part.set_xml(root)


def _update_series(ser: etree._Element, *, categories: list | None,
                   new: dict | None) -> None:
    """Rewrite the categories and values of one <c:ser>.

    Handles:
      - category (c:cat → c:strRef or c:strCache directly → c:strCache/c:pt)
      - values   (c:val → c:numRef or c:numCache → c:numCache/c:pt)
    """
    # series name
    if new and "name" in new and new["name"] is not None:
        tx = ser.find(f"{{{C}}}tx")
        if tx is not None:
            for child in list(tx):
                tx.remove(child)
            strRef = etree.SubElement(tx, f"{{{C}}}strRef")
            f = etree.SubElement(strRef, f"{{{C}}}f")
            f.text = "Sheet1!$A$1"
            cache = etree.SubElement(strRef, f"{{{C}}}strCache")
            ptCount = etree.SubElement(cache, f"{{{C}}}ptCount"); ptCount.set("val", "1")
            pt = etree.SubElement(cache, f"{{{C}}}pt"); pt.set("idx", "0")
            v = etree.SubElement(pt, f"{{{C}}}v"); v.text = str(new["name"])

    # categories
    if categories is not None:
        cat = ser.find(f"{{{C}}}cat")
        if cat is None:
            cat = etree.SubElement(ser, f"{{{C}}}cat")
        for child in list(cat):
            cat.remove(child)
        strRef = etree.SubElement(cat, f"{{{C}}}strRef")
        f = etree.SubElement(strRef, f"{{{C}}}f")
        f.text = "Sheet1!$A$2:$A$" + str(len(categories) + 1)
        cache = etree.SubElement(strRef, f"{{{C}}}strCache")
        ptCount = etree.SubElement(cache, f"{{{C}}}ptCount"); ptCount.set("val", str(len(categories)))
        for idx, c in enumerate(categories):
            pt = etree.SubElement(cache, f"{{{C}}}pt"); pt.set("idx", str(idx))
            v = etree.SubElement(pt, f"{{{C}}}v"); v.text = str(c)

    # values
    if new and "values" in new and new["values"] is not None:
        values = new["values"]
        val = ser.find(f"{{{C}}}val")
        if val is None:
            val = etree.SubElement(ser, f"{{{C}}}val")
        for child in list(val):
            val.remove(child)
        numRef = etree.SubElement(val, f"{{{C}}}numRef")
        f = etree.SubElement(numRef, f"{{{C}}}f")
        f.text = "Sheet1!$B$2:$B$" + str(len(values) + 1)
        cache = etree.SubElement(numRef, f"{{{C}}}numCache")
        fmt = etree.SubElement(cache, f"{{{C}}}formatCode"); fmt.text = "General"
        ptCount = etree.SubElement(cache, f"{{{C}}}ptCount"); ptCount.set("val", str(len(values)))
        for idx, vv in enumerate(values):
            pt = etree.SubElement(cache, f"{{{C}}}pt"); pt.set("idx", str(idx))
            vnode = etree.SubElement(pt, f"{{{C}}}v")
            try:
                vnode.text = str(float(vv))
            except (TypeError, ValueError):
                vnode.text = str(vv)


def read_chart_data(pkg: Package, slide_part: Part, chart_idx: int = 0) -> dict | None:
    """Extract {categories, series: [{name, values}]} from an existing chart.
    Used by extract_deck to reverse-engineer chart slides back into specs.
    """
    slide_root = slide_part.xml()
    frames = _charts(slide_root)
    if not (0 <= chart_idx < len(frames)):
        return None
    chart_ref = frames[chart_idx].find(f".//{{{C}}}chart")
    rid = chart_ref.get(f"{{{R}}}id") if chart_ref is not None else None
    chart_part = pkg.related_one(slide_part, rid) if rid else None
    if chart_part is None:
        return None
    root = chart_part.xml()

    kind = _detect_chart_kind(root)
    sers = root.findall(f".//{{{C}}}ser")
    if not sers:
        return None

    categories: list = []
    # take categories from the first series' c:cat
    cat = sers[0].find(f"{{{C}}}cat")
    if cat is not None:
        for pt in cat.findall(f".//{{{C}}}pt"):
            v = pt.find(f"{{{C}}}v")
            categories.append(v.text if v is not None else "")

    series_out = []
    for s in sers:
        name = ""
        tx = s.find(f"{{{C}}}tx")
        if tx is not None:
            v = tx.find(f".//{{{C}}}v")
            if v is not None:
                name = v.text or ""
        values: list[float] = []
        val = s.find(f"{{{C}}}val")
        if val is not None:
            for pt in val.findall(f".//{{{C}}}pt"):
                v = pt.find(f"{{{C}}}v")
                try:
                    values.append(float(v.text) if v is not None and v.text else 0.0)
                except ValueError:
                    values.append(0.0)
        series_out.append({"name": name, "values": values})
    return {"kind": kind, "categories": categories, "series": series_out}


_CHART_TAG_TO_KIND = {
    "barChart": None,  # decide via barDir
    "lineChart": "line",
    "pieChart": "pie",
    "areaChart": "area",
    "scatterChart": "scatter",
}


def _detect_chart_kind(root: etree._Element) -> str:
    plot = root.find(f".//{{{C}}}plotArea")
    if plot is None:
        return "column"
    for child in plot:
        tag = etree.QName(child.tag).localname
        if tag == "barChart":
            barDir = child.find(f"{{{C}}}barDir")
            direction = barDir.get("val") if barDir is not None else "col"
            return "bar" if direction == "bar" else "column"
        if tag in _CHART_TAG_TO_KIND and _CHART_TAG_TO_KIND[tag]:
            return _CHART_TAG_TO_KIND[tag]
    return "column"  # default guess
