"""Per-slide-type renderers.

Each `render_<type>(slide_obj, spec_slide, theme, grid)` function places every
shape for one slide. They share primitives from this module (backdrop, textbox,
fill_rect, image placement). Renderers pull every visual choice from `theme` —
never hard-code colors or fonts.
"""
from __future__ import annotations

import io
import os
import pathlib
import tempfile
import urllib.request
from typing import Any

from pptx.chart.data import CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

from .layouts import Grid, Rect
from .themes import Theme


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------


def _rgb(c: tuple[int, int, int]) -> RGBColor:
    return RGBColor(c[0], c[1], c[2])


_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _set_run_font(run, name: str) -> None:
    """Set every typeface slot on a run so PowerPoint uses ``name`` for
    Latin, East-Asian, and Complex-Script characters alike.

    python-pptx's ``run.font.name = ...`` only writes ``<a:latin>``, which
    leaves Korean/Japanese/Chinese glyphs to whatever fallback PowerPoint
    picks from the system. We add ``<a:ea>`` (east-asian) and ``<a:cs>``
    (complex script, covers Arabic/Hebrew/Thai/Devanagari) so CJK docs
    render as the chosen Noto cut end-to-end.
    """
    run.font.name = name
    _ensure_ea_cs(run._r.get_or_add_rPr(), name)


def _ensure_ea_cs(rPr_el, name: str) -> None:
    """Add ``<a:ea>`` and ``<a:cs>`` typeface elements to any rPr-style node.

    Reused by chart legend / axis font setters where python-pptx's Font
    proxy only writes the latin slot.
    """
    from lxml import etree as _etree
    for tag in ("ea", "cs"):
        for existing in rPr_el.findall(f"{{{_A_NS}}}{tag}"):
            rPr_el.remove(existing)
        el = _etree.SubElement(rPr_el, f"{{{_A_NS}}}{tag}")
        el.set("typeface", name)


def _set_chart_font(font_proxy, name: str) -> None:
    """Apply a font name to a python-pptx chart Font (legend/axis/title).

    python-pptx's Font.name only writes ``<a:latin>``; we mirror the run
    behaviour and add ea/cs slots so chart text renders the chosen script.
    """
    font_proxy.name = name
    rPr = getattr(font_proxy, "_rPr", None)
    if rPr is None:
        # Some Font proxies expose the element via ._element instead.
        rPr = getattr(font_proxy, "_element", None)
    if rPr is not None:
        _ensure_ea_cs(rPr, name)


def fill_background(slide, theme: Theme) -> None:
    """Paint the full slide with theme.bg via a back rectangle."""
    left, top, width, height = Inches(0), Inches(0), Inches(20), Inches(12)
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = _rgb(theme.bg)
    shape.line.fill.background()
    shape.shadow.inherit = False
    # push to back
    spTree = shape._element.getparent()
    spTree.remove(shape._element)
    spTree.insert(2, shape._element)


def add_filled_rect(
    slide, rect: Rect, fill: tuple[int, int, int],
    line: tuple[int, int, int] | None = None,
):
    x, y, w, h = rect.emu()
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = _rgb(fill)
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = _rgb(line)
        shape.line.width = Pt(0.75)
    shape.shadow.inherit = False
    return shape


def add_textbox(
    slide, rect: Rect, text: str, *,
    font: str, size: int, color: tuple[int, int, int],
    bold: bool = False, italic: bool = False,
    align: str = "left",                # left|center|right
    anchor: str = "top",                # top|middle|bottom
    line_spacing: float = 1.15,
    auto_size: bool = False,
):
    x, y, w, h = rect.emu()
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Emu(0)
    tf.margin_right = Emu(0)
    tf.margin_top = Emu(0)
    tf.margin_bottom = Emu(0)
    if auto_size:
        from pptx.enum.text import MSO_AUTO_SIZE
        tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    tf.vertical_anchor = {
        "top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM,
    }[anchor]

    lines = text.split("\n") if text else [""]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}[align]
        p.line_spacing = line_spacing
        run = p.add_run()
        run.text = line
        _set_run_font(run, font)
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.italic = italic
        run.font.color.rgb = _rgb(color)
    return tb


def add_bullet_paragraphs(
    tf, items: list, *, level: int, font: str, color: tuple[int, int, int],
    size_by_level: dict[int, int], line_spacing: float = 1.2,
    first_replace: bool = True,
):
    """Write a (possibly-nested) bullet list into an existing text_frame.
    `items` is a list where strings are bullets and a nested list immediately
    following a string is its children.
    """
    i = 0
    first_done = not first_replace
    while i < len(items):
        it = items[i]
        if isinstance(it, str):
            text = it
            children = None
            if i + 1 < len(items) and isinstance(items[i + 1], list):
                children = items[i + 1]
                i += 1
            if not first_done:
                p = tf.paragraphs[0]
                first_done = True
            else:
                p = tf.add_paragraph()
            p.level = level
            p.line_spacing = line_spacing
            p.alignment = PP_ALIGN.LEFT
            run = p.add_run()
            prefix = {0: "•  ", 1: "–  ", 2: "·  "}.get(level, "·  ")
            run.text = prefix + text
            _set_run_font(run, font)
            run.font.size = Pt(size_by_level.get(level, size_by_level[0]))
            run.font.color.rgb = _rgb(color)
            if children:
                add_bullet_paragraphs(
                    tf, children, level=level + 1, font=font, color=color,
                    size_by_level=size_by_level, line_spacing=line_spacing,
                    first_replace=False,
                )
        i += 1


def add_image(slide, rect: Rect, image_ref: str, fit: str = "contain",
              align: str = "center"):
    """Place an image at `rect`. `image_ref` may be a local path or http(s) URL.
    `fit` is contain|cover|full_bleed. `align` shifts the image inside `rect`
    horizontally when fit=='contain' leaves slack: left|center|right.
    """
    path = _resolve_image(image_ref)
    from PIL import Image  # python-pptx already depends on Pillow
    with Image.open(path) as im:
        img_w, img_h = im.size
    aspect_img = img_w / img_h if img_h else 1.0
    aspect_box = rect.w / rect.h if rect.h else 1.0

    if fit == "cover" or fit == "full_bleed":
        # scale to fill, may overflow; PPTX crops via picture.crop_* — we set
        # the picture to exactly the box and let PPT render (no real crop).
        slide.shapes.add_picture(path, Inches(rect.x), Inches(rect.y), Inches(rect.w), Inches(rect.h))
        return
    # contain
    if aspect_img > aspect_box:
        draw_w = rect.w
        draw_h = rect.w / aspect_img
    else:
        draw_h = rect.h
        draw_w = rect.h * aspect_img
    if align == "left":
        draw_x = rect.x
    elif align == "right":
        draw_x = rect.x + (rect.w - draw_w)
    else:
        draw_x = rect.x + (rect.w - draw_w) / 2
    draw_y = rect.y + (rect.h - draw_h) / 2
    slide.shapes.add_picture(path, Inches(draw_x), Inches(draw_y), Inches(draw_w), Inches(draw_h))


def _resolve_image(ref: str) -> str:
    if ref.startswith("http://") or ref.startswith("https://"):
        # cache under tmp; deterministic by URL
        import hashlib
        h = hashlib.sha1(ref.encode("utf-8")).hexdigest()[:16]
        out = pathlib.Path(tempfile.gettempdir()) / f"pptx_skill_{h}"
        if not out.exists():
            urllib.request.urlretrieve(ref, out)
        return str(out)
    p = pathlib.Path(ref).expanduser()
    if not p.exists():
        raise FileNotFoundError(f"image not found: {ref}")
    return str(p)


def set_notes(slide, notes: str | None) -> None:
    if not notes:
        return
    slide.notes_slide.notes_text_frame.text = notes


# ---------------------------------------------------------------------------
# per-type renderers
# ---------------------------------------------------------------------------


def render_title(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    # accent bar on bottom left
    add_filled_rect(slide, Rect(grid.m, grid.h - grid.m - 0.08, 2.5, 0.08), theme.accent)

    mid_y = grid.h * 0.38
    add_textbox(
        slide, Rect(grid.m, mid_y, grid.w - 2 * grid.m, 1.4), s["title"],
        font=theme.heading_font, size=theme.size_title, color=theme.heading,
        bold=True, align="left", anchor="middle",
    )
    sub = s.get("subtitle")
    if sub:
        add_textbox(
            slide, Rect(grid.m, mid_y + 1.4, grid.w - 2 * grid.m, 0.7), sub,
            font=theme.body_font, size=theme.size_subtitle, color=theme.muted,
            align="left", anchor="top",
        )
    footer_parts = [p for p in (s.get("author"), s.get("date")) if p]
    if footer_parts:
        add_textbox(
            slide, grid.footer_strip(), " · ".join(footer_parts),
            font=theme.body_font, size=theme.size_caption, color=theme.muted,
            align="left", anchor="middle",
        )
    set_notes(slide, s.get("notes"))


def render_section(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    # left accent stripe
    add_filled_rect(slide, Rect(0, 0, 0.6, grid.h), theme.accent)

    add_textbox(
        slide, Rect(grid.m + 0.4, grid.h * 0.32, grid.w - 2 * grid.m - 0.4, 1.2),
        s["title"],
        font=theme.heading_font, size=theme.size_section, color=theme.heading,
        bold=True, anchor="middle",
    )
    sub = s.get("subtitle")
    if sub:
        add_textbox(
            slide, Rect(grid.m + 0.4, grid.h * 0.32 + 1.3, grid.w - 2 * grid.m - 0.4, 0.6),
            sub,
            font=theme.body_font, size=theme.size_subtitle, color=theme.muted,
            anchor="top",
        )
    set_notes(slide, s.get("notes"))


def render_bullets(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    _draw_slide_title(slide, s["title"], theme, grid)
    content = grid.content_below_title()

    x, y, w, h = content.emu()
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Emu(0); tf.margin_right = Emu(0)
    tf.margin_top = Emu(0); tf.margin_bottom = Emu(0)

    size_by_level = {0: theme.size_body, 1: theme.size_body - 2, 2: theme.size_body - 4}
    add_bullet_paragraphs(
        tf, s["bullets"], level=0, font=theme.body_font, color=theme.fg,
        size_by_level=size_by_level, first_replace=True,
    )
    set_notes(slide, s.get("notes"))


def render_two_column(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title")
    if title:
        _draw_slide_title(slide, title, theme, grid)
        content = grid.content_below_title()
    else:
        content = grid.full_content()

    left_rect, right_rect = grid.split_horizontal(content, 0.5, gap=0.35)
    _render_column(slide, s["left"], left_rect, theme)
    _render_column(slide, s["right"], right_rect, theme)
    set_notes(slide, s.get("notes"))


def _render_column(slide, col: dict, rect: Rect, theme: Theme) -> None:
    kind = col["kind"]
    if kind == "text":
        add_textbox(
            slide, rect, str(col.get("content", "")),
            font=theme.body_font, size=theme.size_body, color=theme.fg, anchor="top",
        )
    elif kind == "bullets":
        items = col.get("content", [])
        x, y, w, h = rect.emu()
        tb = slide.shapes.add_textbox(x, y, w, h)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = Emu(0); tf.margin_right = Emu(0)
        tf.margin_top = Emu(0); tf.margin_bottom = Emu(0)
        add_bullet_paragraphs(
            tf, items, level=0, font=theme.body_font, color=theme.fg,
            size_by_level={0: theme.size_body, 1: theme.size_body - 2, 2: theme.size_body - 4},
        )
    elif kind == "image":
        add_image(slide, rect, str(col["content"]), fit=col.get("fit", "contain"))


def render_image(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    fit = s.get("fit", "contain")
    align = s.get("align", "center")
    title = s.get("title")
    caption = s.get("caption")

    if fit == "full_bleed":
        add_image(slide, grid.full(), s["image"], fit="cover")
    else:
        if title:
            _draw_slide_title(slide, title, theme, grid)
            content = grid.content_below_title()
        else:
            content = grid.full_content()
        if caption:
            cap_h = 0.4
            img_rect = Rect(content.x, content.y, content.w, content.h - cap_h - 0.15)
            cap_rect = Rect(content.x, content.y + content.h - cap_h, content.w, cap_h)
            add_image(slide, img_rect, s["image"], fit=fit, align=align)
            add_textbox(
                slide, cap_rect, caption,
                font=theme.body_font, size=theme.size_caption, color=theme.muted,
                italic=True, align=align, anchor="middle",
            )
        else:
            add_image(slide, content, s["image"], fit=fit, align=align)
    set_notes(slide, s.get("notes"))


def render_table(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title")
    if title:
        _draw_slide_title(slide, title, theme, grid)
        content = grid.content_below_title()
    else:
        content = grid.full_content()

    headers = s["headers"]
    rows = s["rows"]
    MAX_ROWS = 12
    truncated = len(rows) > MAX_ROWS
    display_rows = rows[:MAX_ROWS] if truncated else rows

    n_rows = len(display_rows) + 1 + (1 if truncated else 0)
    n_cols = len(headers)

    # height: header row larger than body
    header_h = 0.45
    body_h = min(0.42, (content.h - header_h) / max(1, n_rows - 1))
    total_h = header_h + body_h * (n_rows - 1)
    # centre vertically
    y = content.y + max(0, (content.h - total_h) / 2)

    x_emu = Inches(content.x)
    y_emu = Inches(y)
    w_emu = Inches(content.w)
    h_emu = Inches(total_h)

    tbl_shape = slide.shapes.add_table(n_rows, n_cols, x_emu, y_emu, w_emu, h_emu)
    tbl = tbl_shape.table

    # apply user-specified relative column widths if present
    col_widths = s.get("col_widths")
    if isinstance(col_widths, list) and len(col_widths) == n_cols:
        total = float(sum(col_widths))
        if total > 0:
            for j, w in enumerate(col_widths):
                tbl.columns[j].width = Inches(content.w * (w / total))

    # header row
    for j, h in enumerate(headers):
        cell = tbl.cell(0, j)
        cell.fill.solid()
        cell.fill.fore_color.rgb = _rgb(theme.accent)
        _set_cell_text(cell, str(h), theme, color=(255, 255, 255), bold=True, size=theme.size_body_small)

    # body rows
    for i, row in enumerate(display_rows, start=1):
        bg = theme.subtle_bg if i % 2 == 0 else theme.bg
        for j in range(n_cols):
            cell = tbl.cell(i, j)
            cell.fill.solid()
            cell.fill.fore_color.rgb = _rgb(bg)
            val = row[j] if j < len(row) else ""
            _set_cell_text(cell, _fmt_cell(val), theme, color=theme.fg, size=theme.size_body_small)

    if truncated:
        i = len(display_rows) + 1
        for j in range(n_cols):
            cell = tbl.cell(i, j)
            cell.fill.solid()
            cell.fill.fore_color.rgb = _rgb(theme.subtle_bg)
            text = f"… +{len(rows) - MAX_ROWS} more" if j == 0 else ""
            _set_cell_text(cell, text, theme, color=theme.muted, size=theme.size_caption, italic=True)

    set_notes(slide, s.get("notes"))


def _set_cell_text(cell, text: str, theme: Theme, *, color, size: int,
                   bold: bool = False, italic: bool = False):
    tf = cell.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.margin_left = Inches(0.1); tf.margin_right = Inches(0.1)
    tf.margin_top = Inches(0.05); tf.margin_bottom = Inches(0.05)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    run = p.add_run()
    run.text = text
    _set_run_font(run, theme.body_font)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = _rgb(color)


def _fmt_cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return f"{v:,.2f}"
    if isinstance(v, int):
        return f"{v:,}"
    return str(v)


def render_chart(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title")
    if title:
        _draw_slide_title(slide, title, theme, grid)
        content = grid.content_below_title()
    else:
        content = grid.full_content()

    kind = s["kind"]
    categories = s["categories"]
    series = s["series"]

    chart_type = {
        "bar": XL_CHART_TYPE.BAR_CLUSTERED,
        "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
        "line": XL_CHART_TYPE.LINE,
        "pie": XL_CHART_TYPE.PIE,
        "area": XL_CHART_TYPE.AREA,
        "scatter": XL_CHART_TYPE.XY_SCATTER_LINES_NO_MARKERS,
    }[kind]

    if kind == "scatter":
        data = XyChartData()
        for ser in series:
            s_ = data.add_series(ser["name"])
            for i, v in enumerate(ser["values"]):
                x_val = categories[i] if isinstance(categories[i], (int, float)) else i + 1
                s_.add_data_point(x_val, v)
    else:
        data = CategoryChartData()
        data.categories = [str(c) for c in categories]
        for ser in series:
            data.add_series(ser["name"], [float(v) if v is not None else 0 for v in ser["values"]])

    x, y, w, h = content.emu()
    chart_shape = slide.shapes.add_chart(chart_type, x, y, w, h, data)
    chart = chart_shape.chart
    chart.has_legend = len(series) > 1 or kind == "pie"
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.RIGHT if kind != "pie" else XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
        _set_chart_font(chart.legend.font, theme.body_font)
        chart.legend.font.size = Pt(theme.size_caption)
        chart.legend.font.color.rgb = _rgb(theme.fg)

    # colour series from theme palette
    palette = theme.chart_series or (theme.accent,)
    try:
        plot = chart.plots[0]
        for i, ser in enumerate(plot.series):
            fill = ser.format.fill
            fill.solid()
            color = palette[i % len(palette)]
            fill.fore_color.rgb = _rgb(color)
            if kind in ("line", "scatter", "area"):
                ser.format.line.color.rgb = _rgb(color)
    except Exception:
        # pptx chart internals occasionally refuse style overrides on certain
        # chart types; falling back to default palette is non-fatal.
        pass

    set_notes(slide, s.get("notes"))


def render_comparison(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title")
    if title:
        _draw_slide_title(slide, title, theme, grid)
        content = grid.content_below_title()
    else:
        content = grid.full_content()

    cols = s["columns"]
    n = len(cols)
    col_rects = grid.columns(content, n, gap=0.35)
    for rect, col in zip(col_rects, cols):
        # card background
        add_filled_rect(slide, rect, theme.subtle_bg, line=theme.grid)
        # header strip
        header_rect = Rect(rect.x, rect.y, rect.w, 0.55)
        add_filled_rect(slide, header_rect, theme.accent)
        add_textbox(
            slide, header_rect.inset(0.2, 0.1), str(col["header"]),
            font=theme.heading_font, size=theme.size_body, color=(255, 255, 255),
            bold=True, anchor="middle",
        )
        # points
        body_rect = Rect(rect.x + 0.25, rect.y + 0.8, rect.w - 0.5, rect.h - 1.0)
        x, y, w, h = body_rect.emu()
        tb = slide.shapes.add_textbox(x, y, w, h)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = Emu(0); tf.margin_right = Emu(0)
        tf.margin_top = Emu(0); tf.margin_bottom = Emu(0)
        items = col["points"] if isinstance(col["points"], list) else [str(col["points"])]
        add_bullet_paragraphs(
            tf, list(items), level=0, font=theme.body_font, color=theme.fg,
            size_by_level={0: theme.size_body - 2, 1: theme.size_body - 4, 2: theme.size_body - 6},
            line_spacing=1.3,
        )
    set_notes(slide, s.get("notes"))


def render_quote(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    content = grid.full_content()
    # decorative big quote mark
    add_textbox(
        slide, Rect(grid.m, grid.m - 0.1, 2, 2), "\u201C",
        font=theme.heading_font, size=120, color=theme.accent_soft,
        bold=True, anchor="top",
    )
    quote = s["quote"]
    add_textbox(
        slide, Rect(grid.m + 0.5, content.y + content.h * 0.15, content.w - 1.0, content.h * 0.6),
        quote,
        font=theme.heading_font, size=theme.size_subtitle + 8, color=theme.heading,
        italic=True, align="left", anchor="middle", line_spacing=1.3,
    )
    attr = s.get("attribution")
    if attr:
        add_textbox(
            slide, Rect(grid.m + 0.5, content.y + content.h * 0.8, content.w - 1.0, 0.5),
            f"— {attr}",
            font=theme.body_font, size=theme.size_body, color=theme.muted,
            align="right",
        )
    set_notes(slide, s.get("notes"))


def render_steps(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title")
    if title:
        _draw_slide_title(slide, title, theme, grid)
        content = grid.content_below_title()
    else:
        content = grid.full_content()

    steps = s["steps"]
    n = len(steps)
    col_rects = grid.columns(content, n, gap=0.2)

    # connecting line
    line_y = content.y + 0.5
    if n > 1:
        first = col_rects[0]
        last = col_rects[-1]
        line_rect = Rect(first.x + first.w / 2, line_y - 0.02, (last.x + last.w / 2) - (first.x + first.w / 2), 0.04)
        add_filled_rect(slide, line_rect, theme.accent_soft)

    for i, (rect, st) in enumerate(zip(col_rects, steps)):
        # number circle
        circle_d = 0.85
        circle_rect = Rect(rect.x + (rect.w - circle_d) / 2, line_y - circle_d / 2, circle_d, circle_d)
        cx, cy, cw, ch = circle_rect.emu()
        circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, cx, cy, cw, ch)
        circle.fill.solid()
        circle.fill.fore_color.rgb = _rgb(theme.accent)
        circle.line.fill.background()
        circle.shadow.inherit = False
        cf = circle.text_frame
        cf.margin_left = Emu(0); cf.margin_right = Emu(0)
        cf.margin_top = Emu(0); cf.margin_bottom = Emu(0)
        cf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = cf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        run = p.add_run()
        run.text = str(i + 1)
        _set_run_font(run, theme.heading_font)
        run.font.size = Pt(theme.size_body + 4)
        run.font.bold = True
        run.font.color.rgb = _rgb((255, 255, 255))

        # step title + description
        text_top = line_y + circle_d / 2 + 0.25
        add_textbox(
            slide, Rect(rect.x, text_top, rect.w, 0.6), str(st["title"]),
            font=theme.heading_font, size=theme.size_body, color=theme.heading,
            bold=True, align="center", anchor="top",
        )
        desc = st.get("description")
        if desc:
            add_textbox(
                slide, Rect(rect.x + 0.15, text_top + 0.65, rect.w - 0.3, rect.h - (text_top - rect.y) - 0.6),
                str(desc),
                font=theme.body_font, size=theme.size_body_small, color=theme.muted,
                align="center", anchor="top", line_spacing=1.3,
            )
    set_notes(slide, s.get("notes"))


def render_kpi(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title")
    if title:
        _draw_slide_title(slide, title, theme, grid)
        content = grid.content_below_title()
    else:
        content = grid.full_content()

    stats = s["stats"]
    n = len(stats)
    col_rects = grid.columns(content, n, gap=0.3)
    for rect, stat in zip(col_rects, stats):
        # card
        add_filled_rect(slide, rect, theme.subtle_bg, line=theme.grid)
        # value
        add_textbox(
            slide, Rect(rect.x, rect.y + rect.h * 0.2, rect.w, rect.h * 0.45), str(stat["value"]),
            font=theme.heading_font, size=theme.size_kpi_value, color=theme.accent,
            bold=True, align="center", anchor="middle",
        )
        # label
        add_textbox(
            slide, Rect(rect.x, rect.y + rect.h * 0.68, rect.w, 0.4), str(stat["label"]),
            font=theme.body_font, size=theme.size_kpi_label, color=theme.muted,
            align="center", anchor="middle",
        )
        # delta
        delta = stat.get("delta")
        if delta:
            d_str = str(delta)
            c = theme.accent
            if d_str.startswith("+"): c = (34, 139, 34)
            elif d_str.startswith("-"): c = (178, 34, 34)
            add_textbox(
                slide, Rect(rect.x, rect.y + rect.h * 0.82, rect.w, 0.3), d_str,
                font=theme.body_font, size=theme.size_caption, color=c,
                bold=True, align="center", anchor="middle",
            )
    set_notes(slide, s.get("notes"))


def render_closing(slide, s: dict, theme: Theme, grid: Grid) -> None:
    fill_background(slide, theme)
    title = s.get("title") or "Thank you"
    add_textbox(
        slide, Rect(grid.m, grid.h * 0.38, grid.w - 2 * grid.m, 1.4), title,
        font=theme.heading_font, size=theme.size_title, color=theme.heading,
        bold=True, align="center", anchor="middle",
    )
    sub = s.get("subtitle")
    if sub:
        add_textbox(
            slide, Rect(grid.m, grid.h * 0.38 + 1.4, grid.w - 2 * grid.m, 0.7), sub,
            font=theme.body_font, size=theme.size_subtitle, color=theme.muted,
            align="center", anchor="top",
        )
    add_filled_rect(slide, Rect(grid.w / 2 - 1.25, grid.h * 0.7, 2.5, 0.08), theme.accent)
    set_notes(slide, s.get("notes"))


# ---------------------------------------------------------------------------
# helper
# ---------------------------------------------------------------------------


def _draw_slide_title(slide, title: str, theme: Theme, grid: Grid) -> None:
    add_textbox(
        slide, grid.title_band(1.0), title,
        font=theme.heading_font, size=theme.size_slide_title, color=theme.heading,
        bold=True, anchor="middle",
    )
    # thin underline accent
    add_filled_rect(
        slide,
        Rect(grid.m, grid.m + 1.0 - 0.02, 1.2, 0.04),
        theme.accent,
    )


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

RENDERERS = {
    "title": render_title,
    "section": render_section,
    "bullets": render_bullets,
    "two_column": render_two_column,
    "image": render_image,
    "table": render_table,
    "chart": render_chart,
    "comparison": render_comparison,
    "quote": render_quote,
    "steps": render_steps,
    "kpi": render_kpi,
    "closing": render_closing,
}
