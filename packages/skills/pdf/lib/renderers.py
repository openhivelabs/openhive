"""Per-block renderers for the PDF skill, using reportlab Platypus.

Each `render_<type>(block, theme, ctx)` returns a list of Flowable objects
that the document builder appends to the story. Flowables handle their own
pagination — if a block doesn't fit, reportlab breaks it naturally.
"""
from __future__ import annotations

import hashlib
import html
import pathlib
import tempfile
import urllib.request
from typing import Any

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    KeepTogether, Paragraph, Spacer, Table, TableStyle,
)

from .themes import Theme


# ---------------------------------------------------------------------------
# context (passed to every renderer)
# ---------------------------------------------------------------------------


class Ctx:
    def __init__(self, theme: Theme, page_width: float, page_height: float):
        self.theme = theme
        self.page_width = page_width
        self.page_height = page_height
        self.content_width = page_width - theme.margin_left - theme.margin_right

    def style_body(self, *, size: int | None = None, color=None,
                   align: str = "left", bold: bool = False,
                   italic: bool = False, left_indent: float = 0,
                   right_indent: float = 0, first_line_indent: float = 0,
                   leading: float | None = None, font: str | None = None) -> ParagraphStyle:
        from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
        t = self.theme
        sz = size or t.size_body
        align_map = {"left": TA_LEFT, "center": TA_CENTER,
                     "right": TA_RIGHT, "justify": TA_JUSTIFY}
        base_font = font or t.body_font
        if bold and italic:
            font_name = _bold_italic_of(base_font)
        elif bold:
            font_name = _bold_of(base_font)
        elif italic:
            font_name = _italic_of(base_font)
        else:
            font_name = base_font
        return ParagraphStyle(
            name="Body",
            fontName=font_name,
            fontSize=sz,
            leading=leading or sz * 1.35,
            alignment=align_map.get(align, TA_LEFT),
            textColor=_rl_color(color if color is not None else t.fg),
            leftIndent=left_indent,
            rightIndent=right_indent,
            firstLineIndent=first_line_indent,
            spaceBefore=2,
            spaceAfter=4,
        )


def _bold_of(font: str) -> str:
    return {
        "Helvetica": "Helvetica-Bold",
        "Times-Roman": "Times-Bold",
        "Courier": "Courier-Bold",
    }.get(font, font)


def _italic_of(font: str) -> str:
    return {
        "Helvetica": "Helvetica-Oblique",
        "Times-Roman": "Times-Italic",
        "Courier": "Courier-Oblique",
    }.get(font, font)


def _bold_italic_of(font: str) -> str:
    return {
        "Helvetica": "Helvetica-BoldOblique",
        "Times-Roman": "Times-BoldItalic",
        "Courier": "Courier-BoldOblique",
    }.get(font, font)


def _rl_color(rgb) -> colors.Color:
    return colors.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)


# ---------------------------------------------------------------------------
# image resolver (same as docx)
# ---------------------------------------------------------------------------


def _resolve_image(ref: str) -> str:
    if ref.startswith("http://") or ref.startswith("https://"):
        h = hashlib.sha1(ref.encode("utf-8")).hexdigest()[:16]
        out = pathlib.Path(tempfile.gettempdir()) / f"pdf_skill_{h}"
        if not out.exists():
            urllib.request.urlretrieve(ref, out)
        return str(out)
    p = pathlib.Path(ref).expanduser()
    if not p.exists():
        raise FileNotFoundError(f"image not found: {ref}")
    return str(p)


# ---------------------------------------------------------------------------
# per-type renderers
# ---------------------------------------------------------------------------


def render_title(block: dict, theme: Theme, ctx: Ctx) -> list:
    style = ctx.style_body(
        size=theme.size_title, color=theme.heading, align="center", bold=True,
        leading=theme.size_title * 1.15,
    )
    style.spaceBefore = 20; style.spaceAfter = 20
    return [Paragraph(html.escape(block["text"]), style)]


def render_heading(block: dict, theme: Theme, ctx: Ctx) -> list:
    level = int(block.get("level", 1))
    size = {1: theme.size_h1, 2: theme.size_h2, 3: theme.size_h3,
            4: theme.size_h4, 5: theme.size_h5, 6: theme.size_h6}[level]
    style = ctx.style_body(
        size=size, color=theme.heading, bold=True,
        font=theme.heading_font,
    )
    style.spaceBefore = size * 0.8
    style.spaceAfter = size * 0.3
    return [Paragraph(html.escape(block["text"]), style)]


def render_paragraph(block: dict, theme: Theme, ctx: Ctx) -> list:
    style = ctx.style_body(align=block.get("align", "left"))
    return [Paragraph(_escape_text(block["text"]), style)]


def render_bullets(block: dict, theme: Theme, ctx: Ctx) -> list:
    return [_list_flowable(block["items"], theme, ctx, ordered=False)]


def render_numbered(block: dict, theme: Theme, ctx: Ctx) -> list:
    return [_list_flowable(block["items"], theme, ctx, ordered=True)]


def _list_flowable(items: list, theme: Theme, ctx: Ctx, *, ordered: bool) -> ListFlowable:
    """Flatten (2-level max) nested items into reportlab ListFlowable."""
    from reportlab.platypus import ListFlowable, ListItem
    style = ctx.style_body()
    entries = []
    i = 0
    while i < len(items):
        it = items[i]
        if isinstance(it, str):
            entry = Paragraph(_escape_text(it), style)
            if i + 1 < len(items) and isinstance(items[i + 1], list):
                child_style = ctx.style_body()
                sub_entries = [ListItem(Paragraph(_escape_text(c), child_style),
                                        leftIndent=20)
                               for c in items[i + 1]]
                sub_list = ListFlowable(
                    sub_entries, bulletType="bullet" if not ordered else "1",
                    leftIndent=36, bulletFontName=theme.body_font, bulletFontSize=theme.size_body,
                )
                entries.append(ListItem(entry, value=str(len(entries) + 1)))
                entries.append(ListItem(sub_list, value=None, leftIndent=20))
                i += 2
                continue
            entries.append(ListItem(entry, value=str(len(entries) + 1)))
        i += 1
    return ListFlowable(
        entries,
        bulletType="1" if ordered else "bullet",
        leftIndent=18,
        bulletFontName=theme.body_font,
        bulletFontSize=theme.size_body,
        bulletColor=_rl_color(theme.accent),
    )


def render_table(block: dict, theme: Theme, ctx: Ctx) -> list:
    headers = block["headers"]
    rows = block["rows"]
    cell_style = ctx.style_body(size=theme.size_body - 1)
    hdr_style = ctx.style_body(size=theme.size_body, color=(255, 255, 255), bold=True)

    data = [[Paragraph(_escape_text(str(h)), hdr_style) for h in headers]]
    for row in rows:
        data.append([Paragraph(_escape_text(_fmt_cell(c)), cell_style)
                     for c in row] +
                    [Paragraph("", cell_style)] * max(0, len(headers) - len(row)))

    n_cols = len(headers)
    col_widths = [ctx.content_width / n_cols] * n_cols
    tbl = Table(data, colWidths=col_widths, repeatRows=1)

    style_name = block.get("style", "grid")
    tbl.setStyle(_table_style(style_name, theme, len(rows)))
    return [tbl, Spacer(1, 6)]


def _table_style(style: str, theme: Theme, n_body_rows: int) -> TableStyle:
    accent = _rl_color(theme.accent)
    grid = colors.Color(0.88, 0.88, 0.85)
    alt = colors.Color(0.97, 0.97, 0.96)
    base = [
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if style == "grid":
        base += [("GRID", (0, 0), (-1, -1), 0.5, grid)]
    elif style == "light":
        for r in range(n_body_rows):
            if r % 2 == 0:
                base.append(("BACKGROUND", (0, r + 1), (-1, r + 1), alt))
        base += [("LINEBELOW", (0, 0), (-1, 0), 1, accent)]
    # "plain" → no extra styling
    return TableStyle(base)


def render_image(block: dict, theme: Theme, ctx: Ctx) -> list:
    from reportlab.lib.units import inch
    from reportlab.platypus import Image as RLImage
    path = _resolve_image(block["path"])
    width = block.get("width_in", 4.0) * inch
    from PIL import Image as PILImage
    with PILImage.open(path) as im:
        w, h = im.size
    aspect = h / w if w else 1.0
    img = RLImage(path, width=width, height=width * aspect)
    out = [img]
    caption = block.get("caption")
    if caption:
        cap_style = ctx.style_body(size=theme.size_small, color=theme.muted,
                                   italic=True, align="center")
        out.append(Paragraph(_escape_text(caption), cap_style))
    out.append(Spacer(1, 6))
    return out


def render_page_break(block: dict, theme: Theme, ctx: Ctx) -> list:
    from reportlab.platypus import PageBreak
    return [PageBreak()]


def render_quote(block: dict, theme: Theme, ctx: Ctx) -> list:
    style = ctx.style_body(italic=True, size=theme.size_body + 1,
                           left_indent=24, right_indent=24)
    parts = [Paragraph(_escape_text(block["text"]), style)]
    attr = block.get("attribution")
    if attr:
        astyle = ctx.style_body(size=theme.size_small, color=theme.muted,
                                align="right", right_indent=24)
        parts.append(Paragraph(f"— {html.escape(attr)}", astyle))
    parts.append(Spacer(1, 4))
    return parts


def render_code(block: dict, theme: Theme, ctx: Ctx) -> list:
    from reportlab.platypus import Preformatted
    style = ParagraphStyle(
        name="Code",
        fontName=theme.mono_font,
        fontSize=theme.size_code,
        leading=theme.size_code * 1.35,
        textColor=_rl_color(theme.fg),
        backColor=_rl_color(theme.code_bg),
        borderColor=colors.Color(0.85, 0.85, 0.85),
        borderWidth=0.5,
        borderPadding=(8, 8, 8, 8),
        leftIndent=0, rightIndent=0,
        spaceBefore=4, spaceAfter=8,
    )
    return [Preformatted(block["text"], style)]


def render_horizontal_rule(block: dict, theme: Theme, ctx: Ctx) -> list:
    from reportlab.platypus import HRFlowable
    return [
        Spacer(1, 6),
        HRFlowable(width="100%", thickness=0.5, color=_rl_color(theme.muted)),
        Spacer(1, 6),
    ]


def render_toc(block: dict, theme: Theme, ctx: Ctx) -> list:
    # Simple placeholder. A real TOC requires doctemplate onDrawPage + AFTER build,
    # which is overkill for MVP. Emit a labelled placeholder.
    from reportlab.platypus.tableofcontents import TableOfContents
    toc = TableOfContents()
    toc.levelStyles = [
        ctx.style_body(size=theme.size_h3, bold=True, left_indent=0),
        ctx.style_body(size=theme.size_body, left_indent=16),
        ctx.style_body(size=theme.size_small, left_indent=32, color=theme.muted),
    ]
    header_style = ctx.style_body(size=theme.size_h2, bold=True, color=theme.heading)
    return [
        Paragraph("목차", header_style),
        Spacer(1, 6),
        toc,
        Spacer(1, 12),
    ]


def render_kpi_row(block: dict, theme: Theme, ctx: Ctx) -> list:
    """KPI cards as a single Table row."""
    stats = block["stats"]
    n = len(stats)
    value_style = ctx.style_body(size=theme.size_kpi, color=theme.accent,
                                 bold=True, align="center", font=theme.heading_font)
    label_style = ctx.style_body(size=theme.size_small, color=theme.muted, align="center")

    cells = []
    for s in stats:
        inner = [Paragraph(html.escape(str(s["value"])), value_style),
                 Spacer(1, 2),
                 Paragraph(html.escape(str(s["label"])), label_style)]
        if s.get("delta"):
            d = str(s["delta"])
            c = theme.muted
            if d.startswith("+"): c = (34, 139, 34)
            elif d.startswith("-"): c = (178, 34, 34)
            d_style = ctx.style_body(size=theme.size_small, color=c, bold=True, align="center")
            inner.append(Paragraph(html.escape(d), d_style))
        cells.append(inner)

    col_w = ctx.content_width / n
    tbl = Table([cells], colWidths=[col_w] * n)
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, -1), colors.Color(0.97, 0.97, 0.96)),
        ("LINEABOVE", (0, 0), (-1, 0), 1, _rl_color(theme.accent)),
        ("LINEBELOW", (0, -1), (-1, -1), 1, _rl_color(theme.accent)),
    ]))
    return [tbl, Spacer(1, 8)]


def render_two_column(block: dict, theme: Theme, ctx: Ctx) -> list:
    """Render two columns via a 1-row 2-col Table with nested flowables."""
    left = block["left"]
    right = block["right"]
    left_flow = _render_column(left, theme, ctx)
    right_flow = _render_column(right, theme, ctx)
    col_w = ctx.content_width / 2
    tbl = Table([[left_flow, right_flow]],
                colWidths=[col_w - 6, col_w - 6])
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
    ]))
    return [tbl, Spacer(1, 6)]


def _render_column(content, theme: Theme, ctx: Ctx) -> list:
    items = content if isinstance(content, list) else [content]
    out: list = []
    for child in items:
        if isinstance(child, str):
            out.append(Paragraph(_escape_text(child), ctx.style_body()))
        elif isinstance(child, dict):
            renderer = RENDERERS.get(child.get("type"))
            if renderer:
                out.extend(renderer(child, theme, ctx))
    return out


def render_spacer(block: dict, theme: Theme, ctx: Ctx) -> list:
    h = float(block.get("height", 12))
    return [Spacer(1, h)]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


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


def _escape_text(s: str) -> str:
    """Escape for reportlab Paragraph (supports limited HTML-ish markup).
    We escape &<> but leave newlines as <br/> so multi-line paragraphs work.
    """
    out = html.escape(s, quote=False)
    out = out.replace("\n", "<br/>")
    return out


# ---------------------------------------------------------------------------
# page size resolver
# ---------------------------------------------------------------------------


def resolve_page_size(size_name: str, orientation: str) -> tuple[float, float]:
    from reportlab.lib.pagesizes import A4, LETTER, legal
    sz = {"A4": A4, "Letter": LETTER, "Legal": legal}.get(size_name, A4)
    w, h = sz
    if orientation == "landscape":
        w, h = h, w
    return w, h


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------


RENDERERS = {
    "title": render_title,
    "heading": render_heading,
    "paragraph": render_paragraph,
    "bullets": render_bullets,
    "numbered": render_numbered,
    "table": render_table,
    "image": render_image,
    "page_break": render_page_break,
    "quote": render_quote,
    "code": render_code,
    "horizontal_rule": render_horizontal_rule,
    "toc": render_toc,
    "kpi_row": render_kpi_row,
    "two_column": render_two_column,
    "spacer": render_spacer,
}
