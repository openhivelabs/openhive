"""Native OOXML chart-part builder.

Produces the four artefacts a Word native chart needs:

1. ``word/charts/chartN.xml`` — the chart definition (dml-chart.xsd)
2. ``word/charts/_rels/chartN.xml.rels`` — links to the embedded xlsx
3. ``word/embeddings/Microsoft_Excel_WorksheetN.xlsx`` — the data store
   that backs Word's "Edit data" button
4. The drawing snippet to embed inline in document.xml

The drawing uses a placeholder ``r:id`` like ``rIdNATIVE0`` that the
post-processor (``native_inject``) resolves to a real relationship.

Phase 1 covers ``bar`` only. Other variants (line/pie/...) plug in as
new ``_emit_<variant>`` functions sharing the same chartSpace skeleton.
"""
from __future__ import annotations

import io
from typing import Any

from .themes import Theme, palette_color


# OOXML namespaces
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def build_chart_parts(block: dict, theme: Theme, idx: int) -> dict[str, bytes]:
    """Build one native chart's parts. ``idx`` is 0-based.

    Returns a dict of {zip_path_inside_docx: bytes_payload}. The caller
    injects these into the docx ZIP and patches ContentTypes / rels.
    """
    n = idx + 1  # 1-based for filenames
    variant = block.get("variant", "bar")
    cats, series_list = _normalize_data(block, variant)

    chart_xml = _build_chart_xml(block, theme, variant, cats, series_list)
    xlsx_bytes = _build_embedded_xlsx(cats, series_list, variant)
    chart_rels = _build_chart_rels(n)

    return {
        f"word/charts/chart{n}.xml": chart_xml,
        f"word/charts/_rels/chart{n}.xml.rels": chart_rels,
        f"word/embeddings/Microsoft_Excel_Worksheet{n}.xlsx": xlsx_bytes,
    }


def build_drawing_xml(block: dict, idx: int, placeholder_rid: str) -> str:
    """Inline drawing element to drop into document.xml."""
    width_in = float(block.get("width_in") or 6.0)
    height_in = float(block.get("height_in") or 3.2)
    cx = int(width_in * 914400)   # EMU
    cy = int(height_in * 914400)
    chart_id = idx + 1
    return (
        f'<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<wp:inline distT="0" distB="0" distL="0" distR="0" '
        f'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        f'<wp:extent cx="{cx}" cy="{cy}"/>'
        f'<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        f'<wp:docPr id="{1000 + chart_id}" name="Chart {chart_id}"/>'
        f'<wp:cNvGraphicFramePr/>'
        f'<a:graphic xmlns:a="{A_NS}">'
        f'<a:graphicData uri="{C_NS}">'
        f'<c:chart xmlns:c="{C_NS}" xmlns:r="{R_NS}" r:id="{placeholder_rid}"/>'
        f'</a:graphicData>'
        f'</a:graphic>'
        f'</wp:inline>'
        f'</w:drawing>'
    )


# ---------------------------------------------------------------------------
# data normalization
# ---------------------------------------------------------------------------


def _normalize_data(block: dict, variant: str) -> tuple[list[str], list[dict]]:
    """Coerce block data into (categories, series) tuples regardless of variant."""
    if variant in ("pie", "donut"):
        slices = block.get("slices") or []
        cats = [str(s.get("label", f"slice {i+1}")) for i, s in enumerate(slices)]
        series_list = [{
            "name": block.get("title", "Series 1"),
            "values": [float(s.get("value", 0)) for s in slices],
        }]
        return cats, series_list

    cats = [str(c) for c in (block.get("x") or [])]
    series_list = []
    for i, s in enumerate(block.get("series") or []):
        item = {
            "name": str(s.get("name", f"Series {i+1}")),
            "values": [float(v) for v in s.get("values", [])],
        }
        # passthrough fields used by variant-specific plotters
        if "axis" in s:
            item["axis"] = s["axis"]
        if "x" in s:
            item["x"] = s["x"]
        if "kind" in s:
            item["kind"] = s["kind"]
        if "sizes" in s:
            item["sizes"] = [float(v) for v in s.get("sizes", [])]
        series_list.append(item)
    if not cats and series_list:
        cats = [f"#{i+1}" for i in range(len(series_list[0]["values"]))]
    for s in series_list:
        s["_cats"] = cats
    return cats, series_list


# ---------------------------------------------------------------------------
# chartN.xml
# ---------------------------------------------------------------------------


def _build_chart_xml(block: dict, theme: Theme, variant: str,
                     cats: list[str], series_list: list[dict]) -> bytes:
    title = block.get("title", "")
    title_xml = _title_xml(title, theme) if title else ""

    x_label = block.get("x_label", "")
    y_label = block.get("y_label", "")
    show_values = bool(block.get("show_values"))

    if variant == "combo":
        plot_xml = _plot_combo(cats, series_list, theme, x_label, y_label, show_values)
    elif variant in ("bar", "stacked_bar", "hbar"):
        plot_xml = _plot_bar(variant, cats, series_list, theme,
                             x_label, y_label, show_values)
    elif variant == "line":
        plot_xml = _plot_line(cats, series_list, theme, fill=False,
                              x_label=x_label, y_label=y_label,
                              show_values=show_values)
    elif variant == "area":
        plot_xml = _plot_area(cats, series_list, theme, x_label, y_label)
    elif variant in ("pie", "donut"):
        plot_xml = _plot_pie(cats, series_list, theme, donut=(variant == "donut"))
    elif variant == "scatter":
        plot_xml = _plot_scatter(cats, series_list, theme, x_label, y_label)
    elif variant == "radar":
        plot_xml = _plot_radar(cats, series_list, theme)
    elif variant == "bubble":
        plot_xml = _plot_bubble(cats, series_list, theme, x_label, y_label)
    else:
        plot_xml = _plot_bar("bar", cats, series_list, theme, "", "", False)

    # pie/donut: legend default ON (single series but multiple slices)
    if variant in ("pie", "donut"):
        default_legend = True
    else:
        default_legend = len(series_list) > 1
    legend_xml = _legend_xml() if block.get("show_legend", default_legend) else ""

    body_font = theme.body_font
    body_color = "{:02X}{:02X}{:02X}".format(*theme.fg)

    xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="{C_NS}" xmlns:a="{A_NS}" xmlns:r="{R_NS}">
  <c:roundedCorners val="0"/>
  <c:chart>
    {title_xml}
    <c:autoTitleDeleted val="{'1' if not title else '0'}"/>
    <c:plotArea>
      <c:layout/>
      {plot_xml}
    </c:plotArea>
    {legend_xml}
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
  <c:txPr>
    <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" wrap="square" anchor="ctr" anchorCtr="1"/>
    <a:lstStyle/>
    <a:p>
      <a:pPr>
        <a:defRPr sz="900" b="0" i="0" u="none" strike="noStrike" kern="1200" baseline="0">
          <a:solidFill><a:srgbClr val="{body_color}"/></a:solidFill>
          <a:latin typeface="{body_font}"/>
          <a:ea typeface="{body_font}"/>
          <a:cs typeface="{body_font}"/>
        </a:defRPr>
      </a:pPr>
      <a:endParaRPr lang="en-US"/>
    </a:p>
  </c:txPr>
  <c:externalData r:id="rId1">
    <c:autoUpdate val="0"/>
  </c:externalData>
</c:chartSpace>
"""
    return xml.encode("utf-8")


def _title_xml(title: str, theme: Theme) -> str:
    color = "{:02X}{:02X}{:02X}".format(*theme.heading)
    return f"""<c:title>
      <c:tx><c:rich>
        <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" wrap="square" anchor="ctr" anchorCtr="1"/>
        <a:lstStyle/>
        <a:p>
          <a:pPr><a:defRPr sz="1400" b="1">
            <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
            <a:latin typeface="{theme.heading_font}"/>
            <a:ea typeface="{theme.heading_font}"/>
            <a:cs typeface="{theme.heading_font}"/>
          </a:defRPr></a:pPr>
          <a:r>
            <a:rPr lang="en-US" sz="1400" b="1">
              <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
              <a:latin typeface="{theme.heading_font}"/>
              <a:ea typeface="{theme.heading_font}"/>
              <a:cs typeface="{theme.heading_font}"/>
            </a:rPr>
            <a:t>{_xml_escape(title)}</a:t>
          </a:r>
        </a:p>
      </c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>"""


def _legend_xml() -> str:
    return """<c:legend>
      <c:legendPos val="b"/>
      <c:overlay val="0"/>
    </c:legend>"""


# ---------------------------------------------------------------------------
# variant plotters
# ---------------------------------------------------------------------------


def _plot_bar(variant: str, cats: list[str], series: list[dict], theme: Theme,
              x_label: str = "", y_label: str = "", show_values: bool = False) -> str:
    bar_dir = "bar" if variant == "hbar" else "col"
    grouping = "stacked" if variant == "stacked_bar" else "clustered"
    overlap = "100" if variant == "stacked_bar" else "-20"
    series_xml = "".join(_series_xml_bar(s, i, theme, show_values=show_values)
                         for i, s in enumerate(series))
    cat_ax_id, val_ax_id = "111111111", "222222222"
    return f"""<c:barChart>
        <c:barDir val="{bar_dir}"/>
        <c:grouping val="{grouping}"/>
        <c:varyColors val="0"/>
        {series_xml}
        <c:gapWidth val="80"/>
        <c:overlap val="{overlap}"/>
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:barChart>
      {_cat_axis(cat_ax_id, val_ax_id,
                 position="b" if bar_dir == "col" else "l",
                 label=x_label if bar_dir == "col" else y_label)}
      {_val_axis(val_ax_id, cat_ax_id,
                 position="l" if bar_dir == "col" else "b",
                 label=y_label if bar_dir == "col" else x_label)}"""


def _plot_line(cats: list[str], series: list[dict], theme: Theme, fill: bool,
               x_label: str = "", y_label: str = "",
               show_values: bool = False) -> str:
    series_xml = "".join(_series_xml_line(s, i, theme, show_values=show_values)
                         for i, s in enumerate(series))
    cat_ax_id, val_ax_id = "111111111", "222222222"
    return f"""<c:lineChart>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        {series_xml}
        <c:marker val="1"/>
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:lineChart>
      {_cat_axis(cat_ax_id, val_ax_id, position="b", label=x_label)}
      {_val_axis(val_ax_id, cat_ax_id, position="l", label=y_label)}"""


def _plot_area(cats: list[str], series: list[dict], theme: Theme,
               x_label: str = "", y_label: str = "") -> str:
    series_xml = "".join(_series_xml_area(s, i, theme) for i, s in enumerate(series))
    cat_ax_id, val_ax_id = "111111111", "222222222"
    return f"""<c:areaChart>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        {series_xml}
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:areaChart>
      {_cat_axis(cat_ax_id, val_ax_id, position="b", label=x_label)}
      {_val_axis(val_ax_id, cat_ax_id, position="l", label=y_label)}"""


def _plot_combo(cats: list[str], series: list[dict], theme: Theme,
                x_label: str = "", y_label: str = "",
                show_values: bool = False) -> str:
    """Bar + line in one chart. Each series picks its own kind via
    ``"kind": "bar"|"line"`` (default bar). Both share one cat/val axis pair.
    """
    bar_series = [(i, s) for i, s in enumerate(series) if s.get("kind", "bar") == "bar"]
    line_series = [(i, s) for i, s in enumerate(series) if s.get("kind") == "line"]

    cat_ax_id, val_ax_id = "111111111", "222222222"
    out_parts: list[str] = []

    if bar_series:
        bar_xml = "".join(_series_xml_bar(s, i, theme, show_values=show_values)
                          for i, s in bar_series)
        out_parts.append(f"""<c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        {bar_xml}
        <c:gapWidth val="80"/>
        <c:overlap val="-20"/>
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:barChart>""")
    if line_series:
        line_xml = "".join(_series_xml_line(s, i, theme, show_values=show_values)
                           for i, s in line_series)
        out_parts.append(f"""<c:lineChart>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        {line_xml}
        <c:marker val="1"/>
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:lineChart>""")
    out_parts.append(_cat_axis(cat_ax_id, val_ax_id, position="b", label=x_label))
    out_parts.append(_val_axis(val_ax_id, cat_ax_id, position="l", label=y_label))
    return "\n".join(out_parts)


def _plot_pie(cats: list[str], series: list[dict], theme: Theme, donut: bool) -> str:
    s = series[0] if series else {"name": "Series 1", "values": []}
    series_xml = _series_xml_pie(s, cats, theme)
    if donut:
        return f"""<c:doughnutChart>
        <c:varyColors val="1"/>
        {series_xml}
        <c:firstSliceAng val="0"/>
        <c:holeSize val="50"/>
      </c:doughnutChart>"""
    return f"""<c:pieChart>
        <c:varyColors val="1"/>
        {series_xml}
      </c:pieChart>"""


def _plot_radar(cats: list[str], series: list[dict], theme: Theme) -> str:
    """Spider/radar chart. Uses c:radarChart with radarStyle="filled" so
    each series fills the polygon for visual punch.
    """
    series_xml = "".join(_series_xml_radar(s, i, theme) for i, s in enumerate(series))
    cat_ax_id, val_ax_id = "111111111", "222222222"
    return f"""<c:radarChart>
        <c:radarStyle val="filled"/>
        <c:varyColors val="0"/>
        {series_xml}
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:radarChart>
      <c:catAx>
        <c:axId val="{cat_ax_id}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:majorGridlines/>
        <c:crossAx val="{val_ax_id}"/>
        <c:auto val="1"/>
        <c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="{val_ax_id}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="1"/>
        <c:axPos val="l"/>
        <c:crossAx val="{cat_ax_id}"/>
        <c:crossBetween val="between"/>
      </c:valAx>"""


def _plot_bubble(cats: list[str], series: list[dict], theme: Theme,
                 x_label: str = "", y_label: str = "") -> str:
    """Bubble chart. Each series provides values + matching ``sizes`` for
    bubble radius (scaled by Word).
    """
    series_xml = "".join(_series_xml_bubble(s, i, theme)
                         for i, s in enumerate(series))
    cat_ax_id, val_ax_id = "111111111", "222222222"
    return f"""<c:bubbleChart>
        <c:varyColors val="0"/>
        {series_xml}
        <c:bubble3D val="0"/>
        <c:bubbleScale val="100"/>
        <c:showNegBubbles val="0"/>
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:bubbleChart>
      {_val_axis(cat_ax_id, val_ax_id, position="b", label=x_label)}
      {_val_axis(val_ax_id, cat_ax_id, position="l", label=y_label)}"""


def _plot_scatter(cats: list[str], series: list[dict], theme: Theme,
                  x_label: str = "", y_label: str = "") -> str:
    series_xml = "".join(_series_xml_scatter(s, i, theme) for i, s in enumerate(series))
    cat_ax_id, val_ax_id = "111111111", "222222222"
    return f"""<c:scatterChart>
        <c:scatterStyle val="lineMarker"/>
        <c:varyColors val="0"/>
        {series_xml}
        <c:axId val="{cat_ax_id}"/>
        <c:axId val="{val_ax_id}"/>
      </c:scatterChart>
      {_val_axis(cat_ax_id, val_ax_id, position="b", label=x_label)}
      {_val_axis(val_ax_id, cat_ax_id, position="l", label=y_label)}"""


# ---------------------------------------------------------------------------
# series builders
# ---------------------------------------------------------------------------


def _series_xml_bar(s: dict, idx: int, theme: Theme,
                    show_values: bool = False) -> str:
    color = "{:02X}{:02X}{:02X}".format(*palette_color(theme, idx))
    name = _xml_escape(s["name"])
    cat_col = chr(ord("A"))
    val_col = chr(ord("B") + idx)
    n = len(s["values"])
    cat_ref = f"Sheet1!$A$2:$A${1 + n}"
    val_ref = f"Sheet1!${val_col}$2:${val_col}${1 + n}"
    name_ref = f"Sheet1!${val_col}$1"
    cat_cache = "".join(f'<c:pt idx="{i}"><c:v>{_xml_escape(c)}</c:v></c:pt>'
                        for i, c in enumerate(_get_cats_for_series(s)))
    val_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                        for i, v in enumerate(s["values"]))
    return f"""<c:ser>
          <c:idx val="{idx}"/>
          <c:order val="{idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>{name_ref}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
            <a:ln><a:noFill/></a:ln>
          </c:spPr>
          <c:invertIfNegative val="0"/>
          {_dlbls_value() if show_values else ""}
          <c:cat>
            <c:strRef>
              <c:f>{cat_ref}</c:f>
              <c:strCache>
                <c:ptCount val="{n}"/>
                {cat_cache}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>{val_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {val_cache}
              </c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>"""


def _series_xml_line(s: dict, idx: int, theme: Theme,
                     show_values: bool = False) -> str:
    color = "{:02X}{:02X}{:02X}".format(*palette_color(theme, idx))
    name = _xml_escape(s["name"])
    val_col = chr(ord("B") + idx)
    n = len(s["values"])
    cat_ref = f"Sheet1!$A$2:$A${1 + n}"
    val_ref = f"Sheet1!${val_col}$2:${val_col}${1 + n}"
    name_ref = f"Sheet1!${val_col}$1"
    cat_cache = "".join(f'<c:pt idx="{i}"><c:v>{_xml_escape(c)}</c:v></c:pt>'
                        for i, c in enumerate(_get_cats_for_series(s)))
    val_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                        for i, v in enumerate(s["values"]))
    return f"""<c:ser>
          <c:idx val="{idx}"/>
          <c:order val="{idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>{name_ref}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:ln w="22225" cap="rnd"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:round/></a:ln>
          </c:spPr>
          <c:marker>
            <c:symbol val="circle"/>
            <c:size val="5"/>
            <c:spPr>
              <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
              <a:ln><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln>
            </c:spPr>
          </c:marker>
          {_dlbls_value() if show_values else ""}
          <c:cat>
            <c:strRef>
              <c:f>{cat_ref}</c:f>
              <c:strCache>
                <c:ptCount val="{n}"/>
                {cat_cache}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>{val_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {val_cache}
              </c:numCache>
            </c:numRef>
          </c:val>
          <c:smooth val="0"/>
        </c:ser>"""


def _series_xml_area(s: dict, idx: int, theme: Theme) -> str:
    color = "{:02X}{:02X}{:02X}".format(*palette_color(theme, idx))
    name = _xml_escape(s["name"])
    val_col = chr(ord("B") + idx)
    n = len(s["values"])
    cat_ref = f"Sheet1!$A$2:$A${1 + n}"
    val_ref = f"Sheet1!${val_col}$2:${val_col}${1 + n}"
    name_ref = f"Sheet1!${val_col}$1"
    cat_cache = "".join(f'<c:pt idx="{i}"><c:v>{_xml_escape(c)}</c:v></c:pt>'
                        for i, c in enumerate(_get_cats_for_series(s)))
    val_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                        for i, v in enumerate(s["values"]))
    return f"""<c:ser>
          <c:idx val="{idx}"/>
          <c:order val="{idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>{name_ref}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="{color}"><a:alpha val="60000"/></a:srgbClr></a:solidFill>
            <a:ln><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln>
          </c:spPr>
          <c:cat>
            <c:strRef>
              <c:f>{cat_ref}</c:f>
              <c:strCache>
                <c:ptCount val="{n}"/>
                {cat_cache}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>{val_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {val_cache}
              </c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>"""


def _series_xml_pie(s: dict, cats: list[str], theme: Theme) -> str:
    name = _xml_escape(s["name"])
    n = len(s["values"])
    cat_ref = f"Sheet1!$A$2:$A${1 + n}"
    val_ref = f"Sheet1!$B$2:$B${1 + n}"
    cat_cache = "".join(f'<c:pt idx="{i}"><c:v>{_xml_escape(c)}</c:v></c:pt>'
                        for i, c in enumerate(cats))
    val_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                        for i, v in enumerate(s["values"]))
    # per-slice colors via dPt
    dpts = "".join(
        f'<c:dPt><c:idx val="{i}"/><c:bubble3D val="0"/>'
        f'<c:spPr><a:solidFill><a:srgbClr val="{"{:02X}{:02X}{:02X}".format(*palette_color(theme, i))}"/></a:solidFill>'
        f'<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>'
        for i in range(n)
    )
    # Schema order inside c:ser for pie: idx, order, tx, spPr, dPt*, dLbls?, cat, val
    dlbls = """<c:dLbls>
            <c:txPr>
              <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" wrap="square" anchor="ctr" anchorCtr="1"/>
              <a:lstStyle/>
              <a:p>
                <a:pPr>
                  <a:defRPr sz="900" b="1">
                    <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
                  </a:defRPr>
                </a:pPr>
                <a:endParaRPr lang="en-US"/>
              </a:p>
            </c:txPr>
            <c:dLblPos val="ctr"/>
            <c:showLegendKey val="0"/>
            <c:showVal val="0"/>
            <c:showCatName val="0"/>
            <c:showSerName val="0"/>
            <c:showPercent val="1"/>
            <c:showBubbleSize val="0"/>
          </c:dLbls>"""
    return f"""<c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx>
            <c:strRef>
              <c:f>Sheet1!$B$1</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          {dpts}
          {dlbls}
          <c:cat>
            <c:strRef>
              <c:f>{cat_ref}</c:f>
              <c:strCache>
                <c:ptCount val="{n}"/>
                {cat_cache}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>{val_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {val_cache}
              </c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>"""


def _series_xml_radar(s: dict, idx: int, theme: Theme) -> str:
    color = "{:02X}{:02X}{:02X}".format(*palette_color(theme, idx))
    name = _xml_escape(s["name"])
    val_col = chr(ord("B") + idx)
    n = len(s["values"])
    cat_ref = f"Sheet1!$A$2:$A${1 + n}"
    val_ref = f"Sheet1!${val_col}$2:${val_col}${1 + n}"
    name_ref = f"Sheet1!${val_col}$1"
    cat_cache = "".join(f'<c:pt idx="{i}"><c:v>{_xml_escape(c)}</c:v></c:pt>'
                        for i, c in enumerate(_get_cats_for_series(s)))
    val_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                        for i, v in enumerate(s["values"]))
    return f"""<c:ser>
          <c:idx val="{idx}"/>
          <c:order val="{idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>{name_ref}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="{color}"><a:alpha val="40000"/></a:srgbClr></a:solidFill>
            <a:ln><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln>
          </c:spPr>
          <c:cat>
            <c:strRef>
              <c:f>{cat_ref}</c:f>
              <c:strCache>
                <c:ptCount val="{n}"/>
                {cat_cache}
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>{val_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {val_cache}
              </c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>"""


def _series_xml_bubble(s: dict, idx: int, theme: Theme) -> str:
    color = "{:02X}{:02X}{:02X}".format(*palette_color(theme, idx))
    name = _xml_escape(s["name"])
    n = len(s["values"])
    val_col = chr(ord("B") + idx)
    name_ref = f"Sheet1!${val_col}$1"
    x_ref = f"Sheet1!$A$2:$A${1 + n}"
    y_ref = f"Sheet1!${val_col}$2:${val_col}${1 + n}"
    sz_col = chr(ord("Z") - idx)
    sz_ref = f"Sheet1!${sz_col}$2:${sz_col}${1 + n}"
    xs = s.get("x") or list(range(1, n + 1))
    sizes = s.get("sizes") or [10.0] * n
    x_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                      for i, v in enumerate(xs))
    y_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                      for i, v in enumerate(s["values"]))
    sz_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                       for i, v in enumerate(sizes))
    return f"""<c:ser>
          <c:idx val="{idx}"/>
          <c:order val="{idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>{name_ref}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:solidFill><a:srgbClr val="{color}"><a:alpha val="65000"/></a:srgbClr></a:solidFill>
            <a:ln><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln>
          </c:spPr>
          <c:invertIfNegative val="0"/>
          <c:xVal>
            <c:numRef>
              <c:f>{x_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {x_cache}
              </c:numCache>
            </c:numRef>
          </c:xVal>
          <c:yVal>
            <c:numRef>
              <c:f>{y_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {y_cache}
              </c:numCache>
            </c:numRef>
          </c:yVal>
          <c:bubbleSize>
            <c:numRef>
              <c:f>{sz_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {sz_cache}
              </c:numCache>
            </c:numRef>
          </c:bubbleSize>
          <c:bubble3D val="0"/>
        </c:ser>"""


def _series_xml_scatter(s: dict, idx: int, theme: Theme) -> str:
    color = "{:02X}{:02X}{:02X}".format(*palette_color(theme, idx))
    name = _xml_escape(s["name"])
    n = len(s["values"])
    val_col = chr(ord("B") + idx)
    name_ref = f"Sheet1!${val_col}$1"
    x_ref = f"Sheet1!$A$2:$A${1 + n}"
    y_ref = f"Sheet1!${val_col}$2:${val_col}${1 + n}"
    xs = s.get("x") or list(range(1, n + 1))
    x_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                      for i, v in enumerate(xs))
    y_cache = "".join(f'<c:pt idx="{i}"><c:v>{_fmt(v)}</c:v></c:pt>'
                      for i, v in enumerate(s["values"]))
    return f"""<c:ser>
          <c:idx val="{idx}"/>
          <c:order val="{idx}"/>
          <c:tx>
            <c:strRef>
              <c:f>{name_ref}</c:f>
              <c:strCache>
                <c:ptCount val="1"/>
                <c:pt idx="0"><c:v>{name}</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:tx>
          <c:spPr>
            <a:ln w="19050"><a:noFill/></a:ln>
          </c:spPr>
          <c:marker>
            <c:symbol val="circle"/>
            <c:size val="6"/>
            <c:spPr>
              <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
              <a:ln><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln>
            </c:spPr>
          </c:marker>
          <c:xVal>
            <c:numRef>
              <c:f>{x_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {x_cache}
              </c:numCache>
            </c:numRef>
          </c:xVal>
          <c:yVal>
            <c:numRef>
              <c:f>{y_ref}</c:f>
              <c:numCache>
                <c:formatCode>General</c:formatCode>
                <c:ptCount val="{n}"/>
                {y_cache}
              </c:numCache>
            </c:numRef>
          </c:yVal>
          <c:smooth val="0"/>
        </c:ser>"""


# ---------------------------------------------------------------------------
# axes
# ---------------------------------------------------------------------------


def _cat_axis(ax_id: str, cross_ax: str, position: str = "b",
              deleted: bool = False, label: str = "") -> str:
    title = _axis_title(label) if label else ""
    return f"""<c:catAx>
        <c:axId val="{ax_id}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="{1 if deleted else 0}"/>
        <c:axPos val="{position}"/>
        {title}
        <c:crossAx val="{cross_ax}"/>
        <c:crosses val="autoZero"/>
        <c:auto val="1"/>
        <c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/>
        <c:noMultiLvlLbl val="0"/>
      </c:catAx>"""


def _val_axis(ax_id: str, cross_ax: str, position: str = "l",
              crosses: str = "autoZero", label: str = "") -> str:
    title = _axis_title(label) if label else ""
    return f"""<c:valAx>
        <c:axId val="{ax_id}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="{position}"/>
        {title}
        <c:crossAx val="{cross_ax}"/>
        <c:crosses val="{crosses}"/>
        <c:crossBetween val="between"/>
      </c:valAx>"""


def _dlbls_value() -> str:
    """Series-level data label that shows the bar/line value at each point."""
    return """<c:dLbls>
            <c:txPr>
              <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" wrap="square"/>
              <a:lstStyle/>
              <a:p><a:pPr><a:defRPr sz="800" b="0"/></a:pPr><a:endParaRPr lang="en-US"/></a:p>
            </c:txPr>
            <c:dLblPos val="outEnd"/>
            <c:showLegendKey val="0"/>
            <c:showVal val="1"/>
            <c:showCatName val="0"/>
            <c:showSerName val="0"/>
            <c:showPercent val="0"/>
            <c:showBubbleSize val="0"/>
          </c:dLbls>"""


def _axis_title(text: str) -> str:
    safe = _xml_escape(text)
    return f"""<c:title>
          <c:tx><c:rich>
            <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" wrap="square" anchor="ctr" anchorCtr="1"/>
            <a:lstStyle/>
            <a:p>
              <a:pPr><a:defRPr sz="900" b="0"/></a:pPr>
              <a:r><a:rPr lang="en-US" sz="900" b="0"/><a:t>{safe}</a:t></a:r>
            </a:p>
          </c:rich></c:tx>
          <c:overlay val="0"/>
        </c:title>"""


# ---------------------------------------------------------------------------
# embedded xlsx
# ---------------------------------------------------------------------------


def _build_embedded_xlsx(cats: list[str], series_list: list[dict],
                         variant: str) -> bytes:
    """Build a real xlsx that backs Word's 'Edit data' button."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    # row 1: header — A1 blank, B1..N1 = series names
    ws.cell(row=1, column=1, value="")
    for j, s in enumerate(series_list):
        ws.cell(row=1, column=2 + j, value=s["name"])
    # rows 2..: cats + values
    for i, cat in enumerate(cats):
        ws.cell(row=2 + i, column=1, value=cat)
        for j, s in enumerate(series_list):
            v = s["values"][i] if i < len(s["values"]) else None
            ws.cell(row=2 + i, column=2 + j, value=v)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# chart-level rels file
# ---------------------------------------------------------------------------


def _build_chart_rels(idx_one_based: int) -> bytes:
    target = f"../embeddings/Microsoft_Excel_Worksheet{idx_one_based}.xlsx"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        f'  <Relationship Id="rId1" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" '
        f'Target="{target}"/>\n'
        '</Relationships>\n'
    ).encode("utf-8")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _get_cats_for_series(s: dict) -> list[str]:
    # Categories are shared at the chart level — we stash them on each series
    # via the closure that called us, but for the cache portion we just need
    # whatever cats live in the spreadsheet column A. The caller passes them
    # separately; this function exists so future per-series cat support is
    # clean. For now, return whatever's on the series, falling back to a
    # generated index list.
    if "_cats" in s and isinstance(s["_cats"], list):
        return [str(c) for c in s["_cats"]]
    return [f"#{i+1}" for i in range(len(s.get("values", [])))]


def _xml_escape(s: Any) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _fmt(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return f"{v:.6g}"
    return str(v)
