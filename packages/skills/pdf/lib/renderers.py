"""Per-block renderers for the PDF skill, using reportlab Platypus.

Each `render_<type>(block, theme, ctx)` returns a list of Flowable objects
that the document builder appends to the story. Flowables handle their own
pagination — if a block doesn't fit, reportlab breaks it naturally.
"""
from __future__ import annotations

import html
import re
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
        # Renderers append non-fatal messages here. build_doc.py drains
        # and emits them as warnings so the caller knows what was skipped.
        self.warnings: list[str] = []

    def with_width(self, width: float) -> "Ctx":
        """Return a sibling context narrowed to ``width``. Used by
        layout containers (two_column, future grid blocks) so child
        blocks size to the cell — not the full page. Without this every
        callout / table / chart inside a two_column overflows past the
        cell into the neighbouring column. Warnings list is shared so
        nothing the child reports gets lost."""
        clone = Ctx.__new__(Ctx)
        clone.theme = self.theme
        clone.page_width = self.page_width
        clone.page_height = self.page_height
        clone.content_width = width
        clone.warnings = self.warnings
        return clone

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
            leading=leading or sz * 1.4,
            alignment=align_map.get(align, TA_LEFT),
            textColor=_rl_color(color if color is not None else t.fg),
            leftIndent=left_indent,
            rightIndent=right_indent,
            firstLineIndent=first_line_indent,
            spaceBefore=2,
            spaceAfter=4,
        )


# ---------------------------------------------------------------------------
# font weight resolution
# ---------------------------------------------------------------------------

# Built-in reportlab type 1 families. Anything outside this set is assumed
# to be a TTF registered through registerFontFamily — bold/italic resolution
# happens via reportlab's own family lookup, so we just return the base name.
_BUILTIN_BOLD = {
    "Helvetica": "Helvetica-Bold",
    "Times-Roman": "Times-Bold",
    "Courier": "Courier-Bold",
}
_BUILTIN_ITALIC = {
    "Helvetica": "Helvetica-Oblique",
    "Times-Roman": "Times-Italic",
    "Courier": "Courier-Oblique",
}
_BUILTIN_BOLD_ITALIC = {
    "Helvetica": "Helvetica-BoldOblique",
    "Times-Roman": "Times-BoldItalic",
    "Courier": "Courier-BoldOblique",
}


def _bold_of(font: str) -> str:
    if font in _BUILTIN_BOLD:
        return _BUILTIN_BOLD[font]
    # Noto-<script> may have a sibling Noto-<script>-Bold registered by
    # fonts.register_reportlab when the hinted Bold static is reachable.
    # Ask fonts.py for the actually-registered bold name so we don't return
    # a font that reportlab would 404 on at render time.
    try:
        from _lib.fonts import bold_variant
        return bold_variant(font)
    except ImportError:
        return font


def _italic_of(font: str) -> str:
    if font in _BUILTIN_ITALIC:
        return _BUILTIN_ITALIC[font]
    # Noto has no Italic cuts for Korean/CJK. Fall through to Regular —
    # readers see upright glyphs but the document still builds.
    return font


def _bold_italic_of(font: str) -> str:
    if font in _BUILTIN_BOLD_ITALIC:
        return _BUILTIN_BOLD_ITALIC[font]
    # No Bold-Italic for Noto either; degrade to Bold.
    return _bold_of(font)


def _rl_color(rgb) -> colors.Color:
    if isinstance(rgb, colors.Color):
        return rgb
    return colors.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)


def _tint(rgb, weight: float):
    """Mix rgb toward white. weight=0 → white, weight=1 → full color."""
    r, g, b = rgb
    return (
        int(255 - (255 - r) * weight),
        int(255 - (255 - g) * weight),
        int(255 - (255 - b) * weight),
    )


def _hex(rgb) -> str:
    r, g, b = rgb
    return f"#{r:02x}{g:02x}{b:02x}"


# ---------------------------------------------------------------------------
# inline markdown (used by every text-bearing block)
# ---------------------------------------------------------------------------


_MD_BOLD = re.compile(r"(?<!\\)\*\*(.+?)\*\*", re.DOTALL)
_MD_ITALIC = re.compile(r"(?<!\\)\*(?!\s)(.+?)(?<!\s)\*", re.DOTALL)
_MD_STRIKE = re.compile(r"(?<!\\)~~(.+?)~~", re.DOTALL)
_MD_CODE = re.compile(r"(?<!\\)`([^`\n]+)`")
_KPI_NUM_DELTA = re.compile(r"^[+\-]?\d+(\.\d+)?\s*(pp|%|p|점|건|명|원|\$|x)?$",
                            re.IGNORECASE)


def _re_match_num_delta(s: str) -> bool:
    return bool(_KPI_NUM_DELTA.match(s.strip()))


# " | " between two non-empty tokens — agents often use this as an inline
# "summary | detail" separator inside one bullet/paragraph. Without this
# sub it renders as a literal pipe character which looks like a fence.
# Code spans and tables don't reach _inline_md, so this is safe.
_INLINE_PIPE = re.compile(r"\s+\|\s+")


def _inline_md(s: str, theme: Theme | None = None) -> str:
    """Convert a small subset of inline markdown to reportlab Paragraph markup.

    Supported (works inside any Paragraph):
      **bold**         → <b>...</b>
      *italic*         → <i>...</i>
      ~~strike~~       → <strike>...</strike>
      `code`           → mono-spaced span with subtle background

    Backslash-escape any marker to keep it literal: \\*, \\**, \\`, \\~~.
    Newlines become <br/> so multi-line strings keep their breaks.
    """
    if not s:
        return ""
    mono = theme.mono_font if theme else "Courier"
    # When the document is using a registered Noto family for body
    # (i.e. a non-Latin doc), Courier has no Korean/CJK glyphs and inline
    # `code` spans render as ■■ tofu boxes. Fall back to the body font for
    # the code span — we lose the monospace look but the text is readable,
    # which the reader cares about more.
    if theme and theme.body_font.startswith("Noto-"):
        mono = theme.body_font
    code_bg = _hex(theme.code_bg) if theme else "#f1f5f9"
    code_fg = _hex(theme.heading) if theme else "#0f172a"

    out = html.escape(s, quote=False)
    out = out.replace("\n", "<br/>")
    out = _INLINE_PIPE.sub("<br/>", out)
    out = _MD_STRIKE.sub(r"<strike>\1</strike>", out)
    out = _MD_BOLD.sub(r"<b>\1</b>", out)
    out = _MD_ITALIC.sub(r"<i>\1</i>", out)
    out = _MD_CODE.sub(
        lambda m: f'<font face="{mono}" backColor="{code_bg}" color="{code_fg}">'
                  f'&#8202;{m.group(1)}&#8202;</font>',
        out,
    )
    # Unescape literal markers
    out = (out.replace(r"\**", "**")
              .replace(r"\*", "*")
              .replace(r"\`", "`")
              .replace(r"\~~", "~~"))
    return out


# Back-compat shim: keep the old escape helper available for blocks that
# explicitly want raw text without inline markup (currently only `code`).
def _escape_text(s: str) -> str:
    out = html.escape(s, quote=False)
    return out.replace("\n", "<br/>")


# ---------------------------------------------------------------------------
# per-type renderers
# ---------------------------------------------------------------------------


def render_title(block: dict, theme: Theme, ctx: Ctx) -> list:
    """Cover-page title. Block fields:
       - text (required)
       - subtitle (optional)
       - footer (optional) — text shown in a muted band near the bottom
         of the cover page; fills the otherwise blank lower half so the
         cover doesn't read as 'unfinished'.
       - tagline (optional) — short line above the bottom band.
    """
    from reportlab.platypus import HRFlowable
    style = ctx.style_body(
        size=theme.size_title, color=theme.heading, align="center", bold=True,
        leading=theme.size_title * 1.15, font=theme.heading_font,
    )
    style.spaceBefore = 24
    style.spaceAfter = 6
    out: list = [Paragraph(_inline_md(block["text"], theme), style)]

    subtitle = block.get("subtitle")
    if subtitle:
        sub_style = ctx.style_body(
            size=theme.size_h3, color=theme.muted, align="center", italic=True,
            font=theme.body_font,
        )
        sub_style.spaceAfter = 18
        out.append(Paragraph(_inline_md(subtitle, theme), sub_style))

    out.append(Spacer(1, 4))
    out.append(HRFlowable(
        width="40%", thickness=1.2, color=_rl_color(theme.accent),
        hAlign="CENTER",
    ))
    out.append(Spacer(1, 18))

    # Optional bottom band — fills the empty lower half of the cover page
    # so the document reads as designed-for-print rather than abandoned.
    footer = block.get("footer")
    tagline = block.get("tagline")
    if footer or tagline:
        # Push to the bottom-ish of the page.
        out.append(Spacer(1, 240))
        if tagline:
            tag_style = ctx.style_body(
                size=theme.size_body + 1, color=theme.fg, align="center",
                italic=True,
            )
            tag_style.spaceAfter = 14
            out.append(Paragraph(_inline_md(tagline, theme), tag_style))
        if footer:
            band = Table(
                [[Paragraph(_inline_md(footer, theme),
                            ctx.style_body(size=theme.size_small,
                                           color=theme.muted, align="center"))]],
                colWidths=[ctx.content_width],
            )
            band.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1),
                 _rl_color(_tint(theme.accent, 0.05))),
                ("LINEABOVE", (0, 0), (-1, 0), 1.2, _rl_color(theme.accent)),
                ("LEFTPADDING", (0, 0), (-1, -1), 18),
                ("RIGHTPADDING", (0, 0), (-1, -1), 18),
                ("TOPPADDING", (0, 0), (-1, -1), 12),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]))
            out.append(band)
    return out


def render_heading(block: dict, theme: Theme, ctx: Ctx) -> list:
    level = int(block.get("level", 1))
    size = {1: theme.size_h1, 2: theme.size_h2, 3: theme.size_h3,
            4: theme.size_h4, 5: theme.size_h5, 6: theme.size_h6}[level]
    style = ctx.style_body(
        size=size, color=theme.heading, bold=True,
        font=theme.heading_font,
    )
    style.spaceBefore = size * 0.9
    style.spaceAfter = size * 0.35
    para = Paragraph(_inline_md(block["text"], theme), style)
    # Mark for TOC collection in BaseDocTemplate.afterFlowable.
    para._toc_level = level  # type: ignore[attr-defined]
    return [para]


def render_paragraph(block: dict, theme: Theme, ctx: Ctx) -> list:
    style = ctx.style_body(align=block.get("align", "left"))
    return [Paragraph(_inline_md(block["text"], theme), style)]


def render_bullets(block: dict, theme: Theme, ctx: Ctx) -> list:
    return [_list_flowable(block["items"], theme, ctx, ordered=False)]


def render_numbered(block: dict, theme: Theme, ctx: Ctx) -> list:
    return [_list_flowable(block["items"], theme, ctx, ordered=True)]


def _list_flowable(items: list, theme: Theme, ctx: Ctx, *, ordered: bool):
    """Render a (max 2-level) list. Items are strings; a list element directly
    after a string is treated as a nested sub-list under that string.

    Numbering is left to reportlab's auto-counter — never set ListItem.value
    manually, that's what produced the "1, 1, ., 3, 1" garbage before.
    """
    from reportlab.platypus import ListFlowable, ListItem
    body_style = ctx.style_body()
    sub_style = ctx.style_body(color=theme.fg)

    entries: list = []
    i = 0
    while i < len(items):
        it = items[i]
        if isinstance(it, list):
            # Stray sub-list with no parent above — render as standalone.
            i += 1
            continue
        if not isinstance(it, str):
            i += 1
            continue
        item_flow: list = [Paragraph(_inline_md(it, theme), body_style)]
        if i + 1 < len(items) and isinstance(items[i + 1], list):
            sub_items = [c for c in items[i + 1] if isinstance(c, str)]
            sub_entries = [
                ListItem(Paragraph(_inline_md(c, theme), sub_style))
                for c in sub_items
            ]
            sub_list = ListFlowable(
                sub_entries,
                bulletType="a" if ordered else "bullet",
                start="a" if ordered else "–",
                leftIndent=20,
                bulletFontName=theme.body_font,
                bulletFontSize=theme.size_body - 1,
                bulletColor=_rl_color(theme.muted),
                bulletDedent=14,
                spaceBefore=2,
                spaceAfter=2,
            )
            item_flow.append(sub_list)
            i += 2
        else:
            i += 1
        entries.append(ListItem(item_flow, leftIndent=4))

    return ListFlowable(
        entries,
        bulletType="1" if ordered else "bullet",
        start="1" if ordered else "•",
        leftIndent=22,
        bulletFontName=_bold_of(theme.heading_font) if ordered else theme.body_font,
        bulletFontSize=theme.size_body,
        bulletColor=_rl_color(theme.accent),
        bulletDedent=14,
        spaceBefore=2,
        spaceAfter=6,
    )


# ---------------------------------------------------------------------------
# table
# ---------------------------------------------------------------------------


def render_table(block: dict, theme: Theme, ctx: Ctx) -> list:
    headers = block["headers"]
    rows = block["rows"]
    cell_style = ctx.style_body(size=theme.size_body - 1)
    hdr_style = ctx.style_body(size=theme.size_body, color=(255, 255, 255), bold=True)

    data = [[Paragraph(_inline_md(str(h), theme), hdr_style) for h in headers]]
    for row in rows:
        data.append([Paragraph(_inline_md(_fmt_cell(c), theme), cell_style)
                     for c in row] +
                    [Paragraph("", cell_style)] * max(0, len(headers) - len(row)))

    n_cols = len(headers)
    col_widths = [ctx.content_width / n_cols] * n_cols
    tbl = Table(data, colWidths=col_widths, repeatRows=1)

    style_name = block.get("style", "light")
    tbl.setStyle(_table_style(style_name, theme, len(rows)))
    return [tbl, Spacer(1, 8)]


def _table_style(style: str, theme: Theme, n_body_rows: int) -> TableStyle:
    accent = _rl_color(theme.accent)
    border = _rl_color(theme.border)
    alt = _rl_color(_tint(theme.accent, 0.06))
    base = [
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    if style == "grid":
        base += [("GRID", (0, 0), (-1, -1), 0.5, border)]
    elif style == "light":
        base += [
            ("LINEABOVE", (0, 0), (-1, 0), 1.4, accent),
            ("LINEBELOW", (0, 0), (-1, 0), 0.6, accent),
            ("LINEBELOW", (0, -1), (-1, -1), 0.6, border),
        ]
        for r in range(n_body_rows):
            if r % 2 == 1:
                base.append(("BACKGROUND", (0, r + 1), (-1, r + 1), alt))
    # "plain" → no extra styling
    return TableStyle(base)


# ---------------------------------------------------------------------------
# media
# ---------------------------------------------------------------------------


def render_page_break(block: dict, theme: Theme, ctx: Ctx) -> list:
    from reportlab.platypus import PageBreak
    return [PageBreak()]


def render_quote(block: dict, theme: Theme, ctx: Ctx) -> list:
    """Block quote with a tinted background and an accent rule on the left."""
    body_style = ctx.style_body(italic=True, size=theme.size_body + 1,
                                color=theme.heading)
    inner = [Paragraph(_inline_md(block["text"], theme), body_style)]
    attr = block.get("attribution")
    if attr:
        astyle = ctx.style_body(size=theme.size_small, color=theme.muted,
                                align="right")
        inner.append(Paragraph(f"— {_inline_md(attr, theme)}", astyle))

    bg = _rl_color(_tint(theme.accent, 0.06))
    tbl = Table([[inner]], colWidths=[ctx.content_width])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, _rl_color(theme.accent)),
        ("LEFTPADDING", (0, 0), (-1, -1), 16),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return [tbl, Spacer(1, 6)]


def render_code(block: dict, theme: Theme, ctx: Ctx) -> list:
    """Code block. Wrapped in a single-cell table so we can paint the
    background a touch deeper than ParagraphStyle.backColor allows AND drop
    a left accent rule — without those two things the block blends into
    body text and "is this even code?" was a real question on the previous
    review pass."""
    from reportlab.platypus import Preformatted
    # Same tofu-avoidance as _inline_md: if body is a registered Noto
    # face, code blocks containing Korean/CJK would otherwise render as
    # tofu when the theme's mono is plain Courier. Prefer Noto for those
    # docs.
    code_font = theme.mono_font
    if theme.body_font.startswith("Noto-"):
        code_font = theme.body_font
    style = ParagraphStyle(
        name="Code",
        fontName=code_font,
        fontSize=theme.size_code,
        leading=theme.size_code * 1.4,
        textColor=_rl_color(theme.heading),
        leftIndent=0, rightIndent=0,
        spaceBefore=0, spaceAfter=0,
    )
    inner = Preformatted(block["text"], style)
    tbl = Table([[inner]], colWidths=[ctx.content_width])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _rl_color(theme.code_bg)),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, _rl_color(theme.muted)),
        ("BOX", (0, 0), (-1, -1), 0.5, _rl_color(theme.border)),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return [Spacer(1, 4), tbl, Spacer(1, 8)]


def render_horizontal_rule(block: dict, theme: Theme, ctx: Ctx) -> list:
    from reportlab.platypus import HRFlowable
    return [
        Spacer(1, 6),
        HRFlowable(width="100%", thickness=0.6, color=_rl_color(theme.border)),
        Spacer(1, 6),
    ]


def render_toc(block: dict, theme: Theme, ctx: Ctx) -> list:
    """TOC block. Only emits the TableOfContents flowable — no internal
    header. The author writes their own heading above it (e.g. "목차" /
    "Contents"), and we tag that heading with `_toc_skip` so it doesn't
    register itself as a TOC entry. When `block.title` IS provided we
    still render it, but with `_toc_skip` set."""
    from reportlab.platypus.tableofcontents import TableOfContents
    toc = TableOfContents()
    toc.levelStyles = [
        ctx.style_body(size=theme.size_h3, bold=True, color=theme.heading),
        ctx.style_body(size=theme.size_body, color=theme.fg, left_indent=14),
        ctx.style_body(size=theme.size_small, color=theme.muted, left_indent=28),
    ]
    out: list = []
    title = block.get("title")
    if title:
        header_style = ctx.style_body(size=theme.size_h2, bold=True,
                                      color=theme.heading, font=theme.heading_font)
        p = Paragraph(_inline_md(title, theme), header_style)
        # Don't let our own header re-enter the TOC entry list.
        p._toc_skip = True  # type: ignore[attr-defined]
        out.append(p)
        out.append(Spacer(1, 6))
    out.append(toc)
    out.append(Spacer(1, 12))
    return out


# ---------------------------------------------------------------------------
# KPI cards
# ---------------------------------------------------------------------------


_TONE_MAP = {
    "positive": "success",
    "negative": "danger",
}


def _kpi_color(stat: dict, theme: Theme, idx: int):
    palette = [theme.accent, theme.accent_2, theme.accent_3,
               theme.info, theme.success, theme.warning]
    if "color" in stat and isinstance(stat["color"], (list, tuple)) \
            and len(stat["color"]) == 3:
        return tuple(stat["color"])
    tone = stat.get("tone")
    tone = _TONE_MAP.get(tone, tone)
    if tone == "success": return theme.success
    if tone == "danger": return theme.danger
    if tone == "warning": return theme.warning
    if tone == "info": return theme.info
    if tone == "muted": return theme.muted
    if tone in ("accent", "accent_1"): return theme.accent
    if tone == "accent_2": return theme.accent_2
    if tone == "accent_3": return theme.accent_3
    return palette[idx % len(palette)]


def render_kpi_row(block: dict, theme: Theme, ctx: Ctx) -> list:
    """KPI cards laid out as a single-row outer table — one inner card per
    stat with a colored top accent and a soft border. Per-stat color via
    `tone` (positive/negative/info/accent/accent_2/accent_3/...) or `color`.
    """
    stats = block["stats"]
    n = len(stats)
    gap = 8  # pt between cards
    col_w = ctx.content_width / n
    cards = []
    for i, s in enumerate(stats):
        c = _kpi_color(s, theme, i)
        value_text = str(s["value"])
        # Auto-shrink the KPI value when it would otherwise wrap. The card
        # is roughly `col_w - 2*pad` wide; we estimate average glyph width
        # at ~0.55× font size for Latin and ~1.0× for CJK. A wrapped
        # "$48.1M" or "1,284명" looks broken; shrinking by ~25% per overrun
        # keeps the value on one line. Floor the size so we never go below
        # readable.
        avail_pt = col_w - gap - 16
        cjk_chars = sum(
            1 for ch in value_text
            if ("　" <= ch <= "鿿") or ("가" <= ch <= "힯")
            or ("぀" <= ch <= "ヿ")
        )
        latin_chars = max(0, len(value_text) - cjk_chars)
        est_w = lambda sz: sz * (cjk_chars * 1.05 + latin_chars * 0.55)
        kpi_size = theme.size_kpi
        while est_w(kpi_size) > avail_pt and kpi_size > 14:
            kpi_size -= 1
        value_style = ctx.style_body(size=kpi_size, color=c, bold=True,
                                     align="center", font=theme.heading_font,
                                     leading=kpi_size * 1.05)
        label_style = ctx.style_body(size=theme.size_small, color=theme.muted,
                                     align="center")
        inner: list = [
            Spacer(1, 2),
            Paragraph(html.escape(value_text), value_style),
            Spacer(1, 4),
            Paragraph(_inline_md(str(s["label"]), theme), label_style),
        ]
        if s.get("delta") is not None:
            d = str(s["delta"])
            # Numeric delta (+/-) gets the semantic green/red. Free-text
            # delta ("관리 필요", "리스크" etc.) stays in the card's tone
            # color so the row reads as one consistent visual rhythm
            # instead of a mix of numbers + arbitrary Korean labels.
            looks_numeric = bool(_re_match_num_delta(d))
            if looks_numeric:
                dc = theme.success if d.startswith("+") else (
                    theme.danger if d.startswith("-") else theme.muted)
            else:
                dc = c  # match card accent
            d_style = ctx.style_body(size=theme.size_small, color=dc, bold=True,
                                     align="center")
            inner.append(Paragraph(html.escape(d), d_style))

        card = Table([[inner]], colWidths=[col_w - gap])
        card.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 14),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("BOX", (0, 0), (-1, -1), 0.6, _rl_color(theme.border)),
            ("LINEABOVE", (0, 0), (-1, 0), 2.4, _rl_color(c)),
        ]))
        cards.append(card)

    outer = Table([cards], colWidths=[col_w] * n)
    outer.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), gap),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [outer, Spacer(1, 12)]


# ---------------------------------------------------------------------------
# two-column
# ---------------------------------------------------------------------------


def render_two_column(block: dict, theme: Theme, ctx: Ctx) -> list:
    left = block["left"]
    right = block["right"]
    # Cell padding consumes 14pt on the inside-edge of each column, so
    # children effectively render against `col_w - 14`. Pass that narrowed
    # width down via ctx.with_width — without this, callouts/tables/charts
    # inside a two_column compute their colWidths against the full page
    # width and bleed into the neighbouring column (see review feedback
    # on the 부문별 성과 / 채널 구조 page).
    col_w = ctx.content_width / 2
    inner_w = col_w - 14
    child_ctx = ctx.with_width(inner_w)
    left_flow = _render_column(left, theme, child_ctx)
    right_flow = _render_column(right, theme, child_ctx)
    tbl = Table([[left_flow, right_flow]],
                colWidths=[col_w, col_w])
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
    ]))
    return [tbl, Spacer(1, 6)]


def _render_column(content, theme: Theme, ctx: Ctx) -> list:
    items = content if isinstance(content, list) else [content]
    out: list = []
    for child in items:
        if isinstance(child, str):
            out.append(Paragraph(_inline_md(child, theme), ctx.style_body()))
        elif isinstance(child, dict):
            renderer = RENDERERS.get(child.get("type"))
            if renderer:
                out.extend(renderer(child, theme, ctx))
    return out


def render_spacer(block: dict, theme: Theme, ctx: Ctx) -> list:
    h = float(block.get("height", 12))
    return [Spacer(1, h)]


# ---------------------------------------------------------------------------
# NEW: callout (info/success/warning/danger box)
# ---------------------------------------------------------------------------


_CALLOUT_VARIANTS = {
    "info": "info",
    "success": "success",
    "warning": "warning",
    "danger": "danger",
    "error": "danger",
    "note": "info",
    "tip": "success",
    "neutral": "muted",
}


def render_callout(block: dict, theme: Theme, ctx: Ctx) -> list:
    variant = _CALLOUT_VARIANTS.get(block.get("variant", "info"), "info")
    color_map = {
        "info": theme.info,
        "success": theme.success,
        "warning": theme.warning,
        "danger": theme.danger,
        "muted": theme.muted,
    }
    accent = color_map[variant]
    bg = _tint(accent, 0.08)

    inner: list = []
    title = block.get("title")
    if title:
        title_style = ctx.style_body(
            size=theme.size_body + 1, bold=True, color=accent,
            font=theme.heading_font,
        )
        inner.append(Paragraph(_inline_md(title, theme), title_style))

    body = block.get("text") or block.get("body")
    if body:
        body_style = ctx.style_body(color=theme.fg)
        inner.append(Paragraph(_inline_md(body, theme), body_style))

    bullets = block.get("bullets")
    if bullets:
        inner.append(_list_flowable(bullets, theme, ctx, ordered=False))

    if not inner:
        inner = [Paragraph("", ctx.style_body())]

    tbl = Table([[inner]], colWidths=[ctx.content_width])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _rl_color(bg)),
        ("LINEBEFORE", (0, 0), (0, -1), 3.5, _rl_color(accent)),
        ("LEFTPADDING", (0, 0), (-1, -1), 16),
        ("RIGHTPADDING", (0, 0), (-1, -1), 16),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return [tbl, Spacer(1, 8)]


# ---------------------------------------------------------------------------
# NEW: chart (bar / line / pie via reportlab.graphics)
# ---------------------------------------------------------------------------


def render_chart(block: dict, theme: Theme, ctx: Ctx) -> list:
    """Render a chart. Variants: bar, line, pie.

    bar/line: { labels: [str], series: [{name?, values: [num], color?}] }
    pie:      { slices: [{label, value, color?}] }
    """
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.charts.linecharts import HorizontalLineChart
    from reportlab.graphics.charts.piecharts import Pie
    from reportlab.graphics.charts.legends import Legend

    variant = block.get("variant", "bar")
    title = block.get("title")
    width = ctx.content_width
    height = float(block.get("height", 220))
    palette = [_rl_color(c) for c in (theme.accent, theme.accent_2, theme.accent_3,
                                       theme.info, theme.success, theme.warning,
                                       theme.danger)]

    drawing = Drawing(width, height)
    title_h = 0
    if title:
        drawing.add(String(
            width / 2, height - 18, title,
            fontName=_bold_of(theme.heading_font),
            fontSize=theme.size_body + 2,
            fillColor=_rl_color(theme.heading),
            textAnchor="middle",
        ))
        title_h = 28

    if variant in ("bar", "line"):
        labels = [str(l) for l in (block.get("labels") or [])]
        series = block.get("series") or []
        chart_cls = VerticalBarChart if variant == "bar" else HorizontalLineChart
        chart = chart_cls()
        chart.x = 50
        chart.y = 48
        chart.width = max(60, width - 80)
        chart.height = max(60, height - 80 - title_h)
        chart.data = [list(s.get("values", [])) for s in series] or [[0]]
        chart.categoryAxis.categoryNames = labels
        chart.categoryAxis.labels.fontName = theme.body_font
        chart.categoryAxis.labels.fontSize = theme.size_small
        chart.valueAxis.labels.fontName = theme.body_font
        chart.valueAxis.labels.fontSize = theme.size_small
        chart.valueAxis.gridStrokeColor = _rl_color(theme.border)
        chart.valueAxis.gridStrokeWidth = 0.4
        chart.valueAxis.visibleGrid = True
        chart.categoryAxis.strokeColor = _rl_color(theme.border)
        chart.valueAxis.strokeColor = _rl_color(theme.border)

        for i, s in enumerate(series):
            color = s.get("color")
            c = _rl_color(color) if color else palette[i % len(palette)]
            if variant == "bar":
                chart.bars[i].fillColor = c
                # No stroke on bars — the stroke was being drawn at default
                # 1pt black on top of the fill in some reportlab versions,
                # which made the perceived color drift toward gray.
                chart.bars[i].strokeColor = None
                chart.bars[i].strokeWidth = 0
            else:
                chart.lines[i].strokeColor = c
                chart.lines[i].strokeWidth = 2.4
                chart.lines[i].symbol = None
        if variant == "bar":
            chart.barSpacing = 2
            chart.groupSpacing = 14
        drawing.add(chart)

        if any(s.get("name") for s in series):
            legend = Legend()
            legend.x = 50
            legend.y = 18
            legend.deltax = 90
            legend.fontName = theme.body_font
            legend.fontSize = theme.size_small
            legend.colorNamePairs = [
                ((_rl_color(s["color"]) if s.get("color")
                  else palette[i % len(palette)]),
                 s.get("name", f"series {i + 1}"))
                for i, s in enumerate(series)
            ]
            legend.alignment = "right"
            legend.columnMaximum = 1
            legend.dx = 8
            legend.dy = 4
            legend.dxTextSpace = 6
            legend.deltay = 12
            drawing.add(legend)
    elif variant == "pie":
        slices = block.get("slices") or []
        pie = Pie()
        pie_size = min(width - 200, height - 40 - title_h, 200)
        pie.x = 60
        pie.y = (height - title_h - pie_size) / 2
        pie.width = pie_size
        pie.height = pie_size
        pie.data = [float(s.get("value", 0)) for s in slices] or [1]
        pie.labels = [str(s.get("label", "")) for s in slices]
        pie.simpleLabels = 0
        pie.slices.strokeColor = colors.white
        pie.slices.strokeWidth = 1.2
        for i, s in enumerate(slices):
            color = s.get("color")
            c = _rl_color(color) if color else palette[i % len(palette)]
            pie.slices[i].fillColor = c
        pie.slices.fontName = theme.body_font
        pie.slices.fontSize = theme.size_small
        pie.slices.labelRadius = 1.25
        drawing.add(pie)

        legend = Legend()
        legend.x = pie.x + pie_size + 30
        legend.y = pie.y + pie_size - 10
        legend.fontName = theme.body_font
        legend.fontSize = theme.size_small
        legend.colorNamePairs = [
            ((_rl_color(s["color"]) if s.get("color")
              else palette[i % len(palette)]),
             f"{s.get('label', '')} ({s.get('value', 0)})")
            for i, s in enumerate(slices)
        ]
        legend.columnMaximum = 99
        legend.alignment = "right"
        legend.dx = 8
        legend.dy = 4
        legend.deltay = 14
        legend.dxTextSpace = 6
        drawing.add(legend)
    else:
        # unknown variant — draw a placeholder string
        drawing.add(String(width / 2, height / 2,
                           f"unsupported chart variant: {variant}",
                           fontName=theme.body_font,
                           fontSize=theme.size_small,
                           fillColor=_rl_color(theme.danger),
                           textAnchor="middle"))

    out = [drawing]
    caption = block.get("caption")
    if caption:
        cap_style = ctx.style_body(size=theme.size_small, color=theme.muted,
                                   italic=True, align="center")
        out.append(Paragraph(_inline_md(caption, theme), cap_style))
    out.append(Spacer(1, 10))
    return out


# ---------------------------------------------------------------------------
# NEW: progress bars
# ---------------------------------------------------------------------------


def render_progress(block: dict, theme: Theme, ctx: Ctx) -> list:
    """A row of labeled progress bars. Each bar:
        { label, value, max?=100, color?|tone?, display? }
    """
    from reportlab.graphics.shapes import Drawing, Rect

    bars = block.get("bars") or []
    if not bars:
        return []

    palette = [theme.accent, theme.accent_2, theme.accent_3,
               theme.info, theme.success, theme.warning]

    label_w = ctx.content_width * 0.28
    value_w = ctx.content_width * 0.12
    bar_w = ctx.content_width - label_w - value_w - 12
    bar_h = 10

    rows = []
    for i, b in enumerate(bars):
        value = float(b.get("value", 0))
        max_v = float(b.get("max", 100)) or 1.0
        pct = max(0.0, min(1.0, value / max_v))
        color = b.get("color")
        if color:
            c = color
        else:
            tone = b.get("tone")
            tone = _TONE_MAP.get(tone, tone)
            tone_map = {
                "success": theme.success, "danger": theme.danger,
                "warning": theme.warning, "info": theme.info,
                "muted": theme.muted, "accent": theme.accent,
                "accent_2": theme.accent_2, "accent_3": theme.accent_3,
            }
            c = tone_map.get(tone, palette[i % len(palette)])

        d = Drawing(bar_w, bar_h)
        d.add(Rect(0, 0, bar_w, bar_h, fillColor=_rl_color(theme.border),
                   strokeColor=None, rx=4, ry=4))
        if pct > 0:
            d.add(Rect(0, 0, max(2.0, bar_w * pct), bar_h,
                       fillColor=_rl_color(c), strokeColor=None, rx=4, ry=4))

        label_style = ctx.style_body(size=theme.size_body, bold=True)
        value_style = ctx.style_body(size=theme.size_small, color=theme.muted,
                                     align="right")
        display = b.get("display") or f"{int(round(pct * 100))}%"
        rows.append([
            Paragraph(_inline_md(b.get("label", ""), theme), label_style),
            d,
            Paragraph(html.escape(str(display)), value_style),
        ])

    tbl = Table(rows, colWidths=[label_w, bar_w, value_w])
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return [tbl, Spacer(1, 8)]


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
    "page_break": render_page_break,
    "quote": render_quote,
    "code": render_code,
    "horizontal_rule": render_horizontal_rule,
    "toc": render_toc,
    "kpi_row": render_kpi_row,
    "two_column": render_two_column,
    "spacer": render_spacer,
    "callout": render_callout,
    "chart": render_chart,
    "progress": render_progress,
}
