"""Per-block renderers for the DOCX skill.

Each `render_<type>(doc, block, theme)` function appends content to the
python-docx Document. They share primitives from this module (paragraph
creation, run styling, table building, image fetch).
"""
from __future__ import annotations

import hashlib
import pathlib
import tempfile
import urllib.request
from typing import Any

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Inches, Pt
from lxml import etree

from .themes import Theme, palette_color


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------


def _rgb(c: tuple[int, int, int]):
    from docx.shared import RGBColor

    return RGBColor(c[0], c[1], c[2])


def _align(s: str | None) -> int | None:
    return {
        "left": WD_ALIGN_PARAGRAPH.LEFT,
        "center": WD_ALIGN_PARAGRAPH.CENTER,
        "right": WD_ALIGN_PARAGRAPH.RIGHT,
        "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
    }.get(s or "")


def _style_run(run, *, font: str, size: int, color,
               bold: bool = False, italic: bool = False) -> None:
    run.font.name = font
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    if color is not None:
        run.font.color.rgb = _rgb(color)
    # Set every script slot in w:rFonts to the same family — Word picks the
    # slot by the script of each character (Latin → w:ascii, CJK → w:eastAsia,
    # Arabic/Hebrew/Thai/Devanagari → w:cs). Pointing all four at the chosen
    # Noto family means Korean/Japanese/Chinese renders correctly in Word's
    # east-asian pipeline *and* Arabic/Thai get the complex-script shaping,
    # instead of silently falling back to whatever the default Latin font
    # covers.
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = etree.SubElement(rPr, qn("w:rFonts"))
    rFonts.set(qn("w:ascii"), font)
    rFonts.set(qn("w:hAnsi"), font)
    rFonts.set(qn("w:eastAsia"), font)
    rFonts.set(qn("w:cs"), font)


def _add_paragraph(doc, text: str, theme: Theme, *, size: int | None = None,
                   bold: bool = False, italic: bool = False, color=None,
                   align: str | None = None, font: str | None = None):
    p = doc.add_paragraph()
    if align:
        aligned = _align(align)
        if aligned is not None:
            p.alignment = aligned
    run = p.add_run(text)
    _style_run(
        run,
        font=font or theme.body_font,
        size=size or theme.size_body,
        color=color if color is not None else theme.fg,
        bold=bold, italic=italic,
    )
    return p


# ---------------------------------------------------------------------------
# image helpers
# ---------------------------------------------------------------------------


def _resolve_image(ref: str) -> str:
    if ref.startswith("http://") or ref.startswith("https://"):
        h = hashlib.sha1(ref.encode("utf-8")).hexdigest()[:16]
        out = pathlib.Path(tempfile.gettempdir()) / f"docx_skill_{h}"
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


def render_heading(doc, block: dict, theme: Theme) -> None:
    level = int(block.get("level", 1))
    p = doc.add_paragraph()
    run = p.add_run(block["text"])
    size = {1: theme.size_h1, 2: theme.size_h2, 3: theme.size_h3,
            4: theme.size_h4, 5: theme.size_h5, 6: theme.size_h6}[level]
    _style_run(run, font=theme.heading_font, size=size, color=theme.heading, bold=True)
    # attach outline level (for TOC generation)
    pPr = p._p.get_or_add_pPr()
    outlineLvl = pPr.find(qn("w:outlineLvl"))
    if outlineLvl is None:
        outlineLvl = etree.SubElement(pPr, qn("w:outlineLvl"))
    outlineLvl.set(qn("w:val"), str(level - 1))
    # use docx built-in Heading N style so TOC works
    try:
        p.style = doc.styles[f"Heading {level}"]
        # re-apply our run styling since style reset may have overridden it.
        # Route through _style_run so every rFonts slot (ascii/hAnsi/eastAsia/cs)
        # gets re-populated — otherwise the built-in Heading style silently
        # reverts east-asian text to its own default.
        _style_run(
            run, font=theme.heading_font, size=size,
            color=theme.heading, bold=True,
        )
    except KeyError:
        pass


def render_paragraph(doc, block: dict, theme: Theme) -> None:
    from .inline import add_inline_runs

    p = doc.add_paragraph()
    if block.get("align"):
        a = _align(block.get("align"))
        if a is not None:
            p.alignment = a
    add_inline_runs(p, block["text"], theme,
                    font=theme.body_font, size=theme.size_body,
                    color=theme.fg)


def render_bullets(doc, block: dict, theme: Theme) -> None:
    _emit_list(doc, block["items"], theme, ordered=False, level=0)


def render_numbered(doc, block: dict, theme: Theme) -> None:
    _emit_list(doc, block["items"], theme, ordered=True, level=0)


def _emit_list(doc, items: list, theme: Theme, *, ordered: bool, level: int) -> None:
    from .inline import add_inline_runs

    style_name = "List Number" if ordered else "List Bullet"
    i = 0
    while i < len(items):
        it = items[i]
        if isinstance(it, str):
            p = doc.add_paragraph(style=style_name if level == 0 else None)
            text = it
            if level > 0:
                p.paragraph_format.left_indent = Inches(0.25 + 0.3 * level)
                p.clear()
                prefix = {1: "– ", 2: "· "}.get(level, "· ")
                text = prefix + it
            add_inline_runs(p, text, theme, font=theme.body_font,
                            size=theme.size_body, color=theme.fg)
            if i + 1 < len(items) and isinstance(items[i + 1], list):
                _emit_list(doc, items[i + 1], theme, ordered=ordered, level=level + 1)
                i += 2
                continue
        i += 1


def render_table(doc, block: dict, theme: Theme) -> None:
    """Render a table.

    Extra options:
      column_widths: list of inches, e.g. [1.5, 1.0, 1.0, 0.8]
      cell_align: "left" | "center" | "right"  (per-table default)
      merge: list of {row, col, rowspan?, colspan?} for merged cells
      first_col_emphasis: bool — bold + accent color for first column
    """
    from .inline import add_inline_runs

    headers = block["headers"]
    rows = block["rows"]
    n_cols = len(headers)
    style_choice = block.get("style", "grid")
    table = doc.add_table(rows=1 + len(rows), cols=n_cols)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT

    base_style = {
        "grid": "Table Grid",
        "light": "Light Shading",
        "plain": "Normal Table",
        "zebra": "Table Grid",
        "minimal": "Normal Table",
    }.get(style_choice, "Table Grid")
    try:
        table.style = doc.styles[base_style]
    except KeyError:
        pass

    # minimal style: no internal borders, just header underline
    if style_choice == "minimal":
        _set_table_borders(table, size=0)

    # header row
    hdr_row = table.rows[0]
    for j, h in enumerate(headers):
        cell = hdr_row.cells[j]
        cell.text = ""
        p = cell.paragraphs[0]
        run = p.add_run(str(h))
        if style_choice == "minimal":
            _style_run(run, font=theme.heading_font, size=theme.size_body,
                       color=theme.heading, bold=True)
            _set_cell_bottom_border(cell, theme.accent, size=8)
        else:
            _style_run(run, font=theme.heading_font, size=theme.size_body,
                       color=(255, 255, 255), bold=True)
            _shade_cell(cell, theme.accent)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER

    zebra_fill = _mix(theme.surface, (255, 255, 255), 0.55)
    cell_align = block.get("cell_align")
    first_col_emp = bool(block.get("first_col_emphasis"))

    # body rows
    for ri, row in enumerate(rows):
        tr = table.rows[ri + 1]
        for j in range(n_cols):
            val = row[j] if j < len(row) else ""
            cell = tr.cells[j]
            cell.text = ""
            p = cell.paragraphs[0]
            if cell_align:
                aligned = _align(cell_align)
                if aligned is not None:
                    p.alignment = aligned
            # rich text + inline styles via inline parser
            font = theme.body_font
            color = theme.fg
            bold = False
            if first_col_emp and j == 0:
                color = theme.heading
                bold = True
            text = _fmt_cell(val)
            if any(ch in text for ch in ("*", "`", "[", "~", "=")):
                add_inline_runs(p, text, theme, font=font,
                                size=theme.size_body, color=color, bold=bold)
            else:
                run = p.add_run(text)
                _style_run(run, font=font, size=theme.size_body,
                           color=color, bold=bold)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            if style_choice == "zebra" and ri % 2 == 1:
                _shade_cell(cell, zebra_fill)
            if style_choice == "minimal" and ri < len(rows) - 1:
                _set_cell_bottom_border(cell, _mix(theme.muted, (255, 255, 255), 0.7), size=4)

    # Column widths (Inches list)
    cw = block.get("column_widths")
    if isinstance(cw, list):
        from docx.shared import Inches as _Inches
        widths = [_Inches(float(w)) for w in cw[:n_cols]]
        # pad with last value
        while len(widths) < n_cols:
            widths.append(widths[-1] if widths else _Inches(1.0))
        for row in table.rows:
            for cell, w in zip(row.cells, widths):
                cell.width = w

    # Caption — picked up by table_of_tables field if set
    if block.get("caption"):
        _emit_caption(doc, block, theme, label="Table")

    # Merged cells
    for m in block.get("merge", []) or []:
        try:
            r0, c0 = int(m["row"]), int(m["col"])
            rowspan = int(m.get("rowspan", 1))
            colspan = int(m.get("colspan", 1))
            top_left = table.rows[r0].cells[c0]
            bot_right = table.rows[r0 + rowspan - 1].cells[c0 + colspan - 1]
            top_left.merge(bot_right)
        except Exception:
            pass


def _shade_cell(cell, fill_rgb) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        shd = etree.SubElement(tcPr, qn("w:shd"))
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), "{:02X}{:02X}{:02X}".format(*fill_rgb))


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


def render_image(doc, block: dict, theme: Theme) -> None:
    path = _resolve_image(block["path"])
    width = block.get("width_in")
    float_side = block.get("float")  # "left" | "right" | None
    p = doc.add_paragraph()
    if block.get("align") and not float_side:
        a = _align(block.get("align"))
        if a is not None:
            p.alignment = a
    run = p.add_run()
    if width is not None:
        run.add_picture(path, width=Inches(float(width)))
    else:
        run.add_picture(path)
    if float_side in ("left", "right"):
        _convert_inline_to_anchor(run, float_side)
    caption = block.get("caption")
    if caption:
        cap_p = doc.add_paragraph()
        cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap_run = cap_p.add_run(caption)
        _style_run(cap_run, font=theme.body_font, size=theme.size_small,
                   color=theme.muted, italic=True)


def _emit_cover_background(doc, image_ref: str) -> None:
    """Drop a behindDoc anchor image at the top of the document so the
    cover content reads on top. Image is sized to A4 portrait by default.
    """
    path = _resolve_image(image_ref)
    p = doc.add_paragraph()
    run = p.add_run()
    run.add_picture(path, width=Inches(8.27))
    drawings = run._r.findall(qn("w:drawing"))
    if not drawings:
        return
    drawing = drawings[0]
    inline = drawing.find(qn("wp:inline"))
    if inline is None:
        return
    anchor = etree.SubElement(drawing, qn("wp:anchor"))
    for k, v in (("distT", "0"), ("distB", "0"), ("distL", "0"),
                 ("distR", "0"), ("simplePos", "0"),
                 ("relativeHeight", "1"),
                 ("behindDoc", "1"), ("locked", "0"),
                 ("layoutInCell", "1"), ("allowOverlap", "1")):
        anchor.set(k, v)
    sp = etree.SubElement(anchor, qn("wp:simplePos"))
    sp.set("x", "0"); sp.set("y", "0")
    posH = etree.SubElement(anchor, qn("wp:positionH"))
    posH.set("relativeFrom", "page")
    pH = etree.SubElement(posH, qn("wp:posOffset"))
    pH.text = "0"
    posV = etree.SubElement(anchor, qn("wp:positionV"))
    posV.set("relativeFrom", "page")
    pV = etree.SubElement(posV, qn("wp:posOffset"))
    pV.text = "0"
    for child in list(inline):
        anchor.append(child)
    wrap = etree.Element(qn("wp:wrapNone"))
    graphic = anchor.find(qn("a:graphic"))
    if graphic is not None:
        anchor.insert(list(anchor).index(graphic), wrap)
    else:
        anchor.append(wrap)
    drawing.remove(inline)


def _convert_inline_to_anchor(run, side: str) -> None:
    """Convert an inline image (<wp:inline>) into an anchored floating
    image with text wrap on the given side. Only the layout properties
    change — pic data stays put.
    """
    drawings = run._r.findall(qn("w:drawing"))
    if not drawings:
        return
    drawing = drawings[0]
    inline = drawing.find(qn("wp:inline"))
    if inline is None:
        return
    # Build the anchor element with key positioning attrs
    nsmap = {"wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"}
    anchor = etree.SubElement(drawing, qn("wp:anchor"))
    for k, v in (("distT", "0"), ("distB", "0"), ("distL", "114300"),
                 ("distR", "114300"), ("simplePos", "0"),
                 ("relativeHeight", "251658240"),
                 ("behindDoc", "0"), ("locked", "0"),
                 ("layoutInCell", "1"), ("allowOverlap", "1")):
        anchor.set(k, v)
    sp = etree.SubElement(anchor, qn("wp:simplePos"))
    sp.set("x", "0"); sp.set("y", "0")
    posH = etree.SubElement(anchor, qn("wp:positionH"))
    posH.set("relativeFrom", "margin")
    align_h = etree.SubElement(posH, qn("wp:align"))
    align_h.text = side
    posV = etree.SubElement(anchor, qn("wp:positionV"))
    posV.set("relativeFrom", "paragraph")
    posOffsetV = etree.SubElement(posV, qn("wp:posOffset"))
    posOffsetV.text = "0"
    # Move children of inline (extent, docPr, graphic, …) into anchor
    for child in list(inline):
        anchor.append(child)
    # Add wrapSquare BEFORE graphic so schema is satisfied
    wrap = etree.Element(qn("wp:wrapSquare"))
    wrap.set("wrapText", "bothSides")
    # find graphic to insert wrap before it
    graphic = anchor.find(qn("a:graphic"))
    if graphic is not None:
        anchor.insert(list(anchor).index(graphic), wrap)
    else:
        anchor.append(wrap)
    drawing.remove(inline)


def render_page_break(doc, block: dict, theme: Theme) -> None:
    from docx.enum.text import WD_BREAK

    p = doc.add_paragraph()
    p.add_run().add_break(WD_BREAK.PAGE)


def render_quote(doc, block: dict, theme: Theme) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.4)
    p.paragraph_format.right_indent = Inches(0.4)
    run = p.add_run(block["text"])
    _style_run(run, font=theme.body_font, size=theme.size_body + 1,
               color=theme.fg, italic=True)
    # left border as quote mark
    pPr = p._p.get_or_add_pPr()
    pBdr = pPr.find(qn("w:pBdr"))
    if pBdr is None:
        pBdr = etree.SubElement(pPr, qn("w:pBdr"))
    left = etree.SubElement(pBdr, qn("w:left"))
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "8")
    left.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*theme.accent))

    attr = block.get("attribution")
    if attr:
        ap = doc.add_paragraph()
        ap.paragraph_format.left_indent = Inches(0.4)
        ap.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        arun = ap.add_run(f"— {attr}")
        _style_run(arun, font=theme.body_font, size=theme.size_small, color=theme.muted)


def render_code(doc, block: dict, theme: Theme) -> None:
    """Code block with optional naive syntax highlighting per language.

    Highlighting is intentionally simple — keyword / string / comment /
    number coloring for python/javascript/sql/json. Anything else falls
    back to plain mono.
    """
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    cell = table.rows[0].cells[0]
    cell.text = ""
    _shade_cell(cell, theme.code_bg)
    tc_pr = cell._tc.get_or_add_tcPr()
    tcBorders = etree.SubElement(tc_pr, qn("w:tcBorders"))
    for side in ("top", "left", "bottom", "right"):
        b = etree.SubElement(tcBorders, qn(f"w:{side}"))
        b.set(qn("w:val"), "single"); b.set(qn("w:sz"), "2")
        b.set(qn("w:color"), "CCCCCC")
    _set_cell_left_border(cell, theme.accent, size=20)

    language = (block.get("language") or "").lower()
    show_line_numbers = bool(block.get("line_numbers"))
    lines = block["text"].split("\n")
    width = len(str(len(lines)))
    for pg in list(cell.paragraphs):
        cell._tc.remove(pg._p)
    for ln_no, line in enumerate(lines, start=1):
        p = cell.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        if show_line_numbers:
            ln_run = p.add_run(str(ln_no).rjust(width) + "  ")
            _style_run(ln_run, font=theme.mono_font, size=theme.size_code,
                       color=theme.muted)
        spans = _highlight(line or " ", language)
        for kind, text in spans:
            run = p.add_run(text)
            color = _code_color(kind, theme)
            italic = (kind == "comment")
            _style_run(run, font=theme.mono_font, size=theme.size_code,
                       color=color, italic=italic)


def render_horizontal_rule(doc, block: dict, theme: Theme) -> None:
    p = doc.add_paragraph()
    pPr = p._p.get_or_add_pPr()
    pBdr = pPr.find(qn("w:pBdr"))
    if pBdr is None:
        pBdr = etree.SubElement(pPr, qn("w:pBdr"))
    bottom = etree.SubElement(pBdr, qn("w:bottom"))
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*theme.muted))


def render_toc(doc, block: dict, theme: Theme) -> None:
    """Insert a TOC field with dirty=true so Word auto-refreshes on open.

    Combined with the ``<w:updateFields w:val="true"/>`` setting (added in
    build_doc.py), the TOC populates the moment the reader opens the doc
    — no F9 needed.
    """
    levels = block.get("levels", 3)
    p = doc.add_paragraph()
    run = p.add_run()
    fldChar = etree.SubElement(run._r, qn("w:fldChar"))
    fldChar.set(qn("w:fldCharType"), "begin")
    fldChar.set(qn("w:dirty"), "true")
    instrText = etree.SubElement(run._r, qn("w:instrText"))
    instrText.text = f'TOC \\o "1-{levels}" \\h \\z \\u'
    fldChar2 = etree.SubElement(run._r, qn("w:fldChar"))
    fldChar2.set(qn("w:fldCharType"), "separate")
    # placeholder run text (replaced by Word on refresh)
    placeholder = p.add_run("Updating table of contents…")
    _style_run(placeholder, font=theme.body_font, size=theme.size_small,
               color=theme.muted, italic=True)
    end_run = p.add_run()
    fldChar3 = etree.SubElement(end_run._r, qn("w:fldChar"))
    fldChar3.set(qn("w:fldCharType"), "end")


def render_kpi_row(doc, block: dict, theme: Theme) -> None:
    """A single-row of N stat tiles (big number + label + delta).

    Each tile is its own 1-cell table — gives independent shading + borders
    per tile, with consistent gutters. Tiles sit inside an outer 1-row table
    that handles equal column widths.
    """
    stats = block["stats"]
    n = len(stats)
    use_palette = bool(block.get("colored", True))
    surface = block.get("variant", "tile")  # "tile" | "plain"

    outer = doc.add_table(rows=1, cols=n)
    outer.alignment = WD_TABLE_ALIGNMENT.CENTER
    outer.autofit = False
    _set_table_borders(outer, size=0)
    outer_row = outer.rows[0]

    for j, s in enumerate(stats):
        outer_cell = outer_row.cells[j]
        outer_cell.text = ""
        # remove the empty default paragraph the cell ships with
        for pg in list(outer_cell.paragraphs):
            outer_cell._tc.remove(pg._p)
        # gutter via cell margins
        _set_cell_margins(outer_cell, left=80, right=80, top=0, bottom=0)

        tile_color = palette_color(theme, j) if use_palette else theme.accent
        bg = _mix(tile_color, (255, 255, 255), 0.88)

        # value paragraph
        p_val = outer_cell.add_paragraph()
        p_val.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_val.paragraph_format.space_before = Pt(8)
        p_val.paragraph_format.space_after = Pt(2)
        r_val = p_val.add_run(str(s["value"]))
        _style_run(r_val, font=theme.heading_font, size=theme.size_kpi,
                   color=tile_color, bold=True)

        # label
        p_lab = outer_cell.add_paragraph()
        p_lab.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_lab.paragraph_format.space_before = Pt(0)
        p_lab.paragraph_format.space_after = Pt(2)
        r_lab = p_lab.add_run(str(s["label"]))
        _style_run(r_lab, font=theme.body_font, size=theme.size_kpi_label,
                   color=theme.fg, bold=False)

        # delta
        if s.get("delta"):
            d_str = str(s["delta"])
            d_color = theme.muted
            if d_str.startswith("+"): d_color = theme.success
            elif d_str.startswith("-"): d_color = theme.danger
            p_d = outer_cell.add_paragraph()
            p_d.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p_d.paragraph_format.space_before = Pt(0)
            p_d.paragraph_format.space_after = Pt(8)
            r_d = p_d.add_run(d_str)
            _style_run(r_d, font=theme.body_font, size=theme.size_small,
                       color=d_color, bold=True)

        if surface == "tile":
            _shade_cell(outer_cell, bg)
            _set_cell_top_border(outer_cell, tile_color, size=18)


def render_two_column(doc, block: dict, theme: Theme) -> None:
    """Render left/right columns as a 1-row 2-col borderless table."""
    table = doc.add_table(rows=1, cols=2)
    table.autofit = True
    for side_key, cell_idx in (("left", 0), ("right", 1)):
        cell = table.rows[0].cells[cell_idx]
        cell.text = ""
        content = block[side_key]
        items = content if isinstance(content, list) else [content]
        # clear default paragraph
        for pg in list(cell.paragraphs):
            cell._tc.remove(pg._p)
        for child in items:
            if isinstance(child, str):
                p = cell.add_paragraph()
                run = p.add_run(child)
                _style_run(run, font=theme.body_font, size=theme.size_body, color=theme.fg)
            elif isinstance(child, dict):
                # nested block — render into a temp buffer then copy paragraphs
                # simpler: recursive dispatch writing into cell directly
                _render_into_cell(cell, child, theme)
    # remove borders
    _set_table_borders(table, size=0)


def _render_into_cell(cell, block: dict, theme: Theme) -> None:
    t = block.get("type")
    if t == "paragraph":
        p = cell.add_paragraph()
        run = p.add_run(block["text"])
        _style_run(run, font=theme.body_font, size=theme.size_body, color=theme.fg)
    elif t in ("bullets", "numbered"):
        for item in block.get("items", []):
            if isinstance(item, str):
                p = cell.add_paragraph()
                prefix = "• " if t == "bullets" else ""
                run = p.add_run(prefix + item)
                _style_run(run, font=theme.body_font, size=theme.size_body, color=theme.fg)
    elif t == "heading":
        p = cell.add_paragraph()
        run = p.add_run(block["text"])
        size = {1: theme.size_h2, 2: theme.size_h3}.get(block.get("level", 2), theme.size_h4)
        _style_run(run, font=theme.heading_font, size=size,
                   color=theme.heading, bold=True)


def _set_table_borders(table, size: int = 0, color: str = "FFFFFF") -> None:
    tbl = table._tbl
    tblPr = tbl.find(qn("w:tblPr"))
    if tblPr is None:
        tblPr = etree.SubElement(tbl, qn("w:tblPr"))
    tblBorders = tblPr.find(qn("w:tblBorders"))
    if tblBorders is None:
        tblBorders = etree.SubElement(tblPr, qn("w:tblBorders"))
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        b = tblBorders.find(qn(f"w:{side}"))
        if b is None:
            b = etree.SubElement(tblBorders, qn(f"w:{side}"))
        b.set(qn("w:val"), "nil" if size == 0 else "single")
        b.set(qn("w:sz"), str(max(0, size)))
        b.set(qn("w:color"), color)


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# new visual blocks
# ---------------------------------------------------------------------------


def render_cover(doc, block: dict, theme: Theme) -> None:
    """Full-page cover. title + subtitle + meta row + colored band.

    Optional ``background_image``: full-bleed image rendered behind the
    cover content via a wp:anchor floating shape. The other elements
    inherit a slightly muted color so they read on top.
    """
    from docx.enum.text import WD_BREAK

    bg = block.get("background_image")
    if bg:
        _emit_cover_background(doc, bg)

    # top spacer (push title down ~25% of page)
    for _ in range(4):
        sp = doc.add_paragraph()
        sp.paragraph_format.space_after = Pt(0)

    eyebrow = block.get("eyebrow")
    if eyebrow:
        ep = doc.add_paragraph()
        ep.alignment = WD_ALIGN_PARAGRAPH.LEFT
        er = ep.add_run(str(eyebrow).upper())
        _style_run(er, font=theme.heading_font, size=theme.size_small,
                   color=theme.accent, bold=True)
        ep.paragraph_format.space_after = Pt(6)

    # title
    tp = doc.add_paragraph()
    tp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    tp.paragraph_format.space_after = Pt(8)
    tr = tp.add_run(block["title"])
    _style_run(tr, font=theme.heading_font, size=theme.size_title,
               color=theme.heading, bold=True)

    # accent rule
    rp = doc.add_paragraph()
    rp.paragraph_format.space_before = Pt(2)
    rp.paragraph_format.space_after = Pt(14)
    pPr = rp._p.get_or_add_pPr()
    pBdr = etree.SubElement(pPr, qn("w:pBdr"))
    btm = etree.SubElement(pBdr, qn("w:bottom"))
    btm.set(qn("w:val"), "single")
    btm.set(qn("w:sz"), "24")
    btm.set(qn("w:space"), "1")
    btm.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*theme.accent))

    subtitle = block.get("subtitle")
    if subtitle:
        sp = doc.add_paragraph()
        sp.paragraph_format.space_after = Pt(20)
        sr = sp.add_run(subtitle)
        _style_run(sr, font=theme.body_font, size=theme.size_subtitle,
                   color=theme.fg)

    # meta row (date / author / org) — light gray
    meta_bits: list[str] = []
    if block.get("date"): meta_bits.append(str(block["date"]))
    if block.get("author"): meta_bits.append(str(block["author"]))
    if block.get("org"): meta_bits.append(str(block["org"]))
    if meta_bits:
        mp = doc.add_paragraph()
        mp.paragraph_format.space_after = Pt(0)
        mr = mp.add_run("  ·  ".join(meta_bits))
        _style_run(mr, font=theme.body_font, size=theme.size_small, color=theme.muted)

    # bottom band — colored panel filling the lower section
    band_color = block.get("band_color")
    if band_color and isinstance(band_color, list) and len(band_color) == 3:
        band_rgb = tuple(band_color)
    else:
        band_rgb = theme.band

    # spacer to push band toward bottom
    for _ in range(8):
        sp = doc.add_paragraph()
        sp.paragraph_format.space_after = Pt(0)

    # band as a 1-cell table with shading
    band_table = doc.add_table(rows=1, cols=1)
    band_table.alignment = WD_TABLE_ALIGNMENT.LEFT
    band_cell = band_table.rows[0].cells[0]
    _shade_cell(band_cell, band_rgb)
    _set_cell_margins(band_cell, left=200, right=200, top=180, bottom=180)
    _set_table_borders(band_table, size=0, color="{:02X}{:02X}{:02X}".format(*band_rgb))
    # full width
    _set_table_width_pct(band_table, 100)

    band_text = block.get("band_text")
    band_eyebrow = block.get("band_eyebrow")
    band_paras = list(band_cell.paragraphs)
    for pg in band_paras:
        band_cell._tc.remove(pg._p)
    if band_eyebrow:
        ep = band_cell.add_paragraph()
        er = ep.add_run(str(band_eyebrow).upper())
        _style_run(er, font=theme.heading_font, size=theme.size_small,
                   color=(255, 255, 255), bold=True)
    if band_text:
        bp = band_cell.add_paragraph()
        br = bp.add_run(band_text)
        _style_run(br, font=theme.heading_font,
                   size=theme.size_subtitle, color=(255, 255, 255), bold=True)
    if not band_eyebrow and not band_text:
        bp = band_cell.add_paragraph()
        br = bp.add_run(" ")
        _style_run(br, font=theme.body_font, size=theme.size_subtitle,
                   color=(255, 255, 255))

    # automatic page break after cover
    pb = doc.add_paragraph()
    pb.add_run().add_break(WD_BREAK.PAGE)


def render_chart(doc, block: dict, theme: Theme) -> None:
    """Render chart. Two backends:

    - PNG (default): matplotlib → image. Fast, no editing in Word.
    - Native (``native: true``): emit a placeholder drawing tied to a
      native chart part. The placeholder rId is resolved post-save by
      ``lib/native_inject``. Editable in Word's chart editor.
    """
    if block.get("native"):
        _render_chart_native(doc, block, theme)
    else:
        _render_chart_png(doc, block, theme)


def _render_chart_png(doc, block: dict, theme: Theme) -> None:
    from .charts import render_chart_png

    path, w_in, _ = render_chart_png(block, theme)
    align = block.get("align", "center")
    p = doc.add_paragraph()
    a = _align(align)
    if a is not None:
        p.alignment = a
    run = p.add_run()
    run.add_picture(path, width=Inches(w_in))
    _emit_caption(doc, block, theme)


def _render_chart_native(doc, block: dict, theme: Theme) -> None:
    """Stash the spec on doc and emit a placeholder drawing.

    ``build_doc.py`` reads ``doc._native_charts`` after save and runs the
    injector. Placeholder ``rIdNATIVE{i}`` strings appear in document.xml;
    the injector swaps them for real rIds tied to the chart parts.
    """
    from .native_chart import build_drawing_xml

    if not hasattr(doc, "_native_charts"):
        doc._native_charts = []
    idx = len(doc._native_charts)
    placeholder = f"rIdNATIVE{idx}"
    doc._native_charts.append({"block": block, "placeholder_rid": placeholder})

    align = block.get("align", "center")
    p = doc.add_paragraph()
    a = _align(align)
    if a is not None:
        p.alignment = a
    run = p.add_run()
    drawing_xml = build_drawing_xml(block, idx, placeholder)
    run._r.append(etree.fromstring(drawing_xml))
    _emit_caption(doc, block, theme)


def _emit_caption(doc, block: dict, theme: Theme, label: str = "Chart") -> None:
    """Emit a caption paragraph styled as Word "Caption" so the appropriate
    TOC field (table_of_charts/figures/tables) can find it. Embeds a
    SEQ field for auto-numbering ("Chart 1", "Chart 2", ...).
    """
    caption = block.get("caption")
    if not caption:
        return
    cap_p = doc.add_paragraph()
    cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    # try to apply built-in Caption style; fall back silently
    try:
        cap_p.style = doc.styles["Caption"]
    except KeyError:
        pass
    # leading label run + SEQ field auto-number
    label_run = cap_p.add_run(f"{label} ")
    _style_run(label_run, font=theme.body_font, size=theme.size_small,
               color=theme.muted, italic=True)
    # SEQ field
    seq_run = cap_p.add_run()
    fld_b = etree.SubElement(seq_run._r, qn("w:fldChar"))
    fld_b.set(qn("w:fldCharType"), "begin")
    instr_run = cap_p.add_run()
    it = etree.SubElement(instr_run._r, qn("w:instrText"))
    it.text = f' SEQ {label} \\* ARABIC '
    it.set(qn("xml:space"), "preserve")
    sep_run = cap_p.add_run()
    fld_s = etree.SubElement(sep_run._r, qn("w:fldChar"))
    fld_s.set(qn("w:fldCharType"), "separate")
    num_run = cap_p.add_run("1")
    _style_run(num_run, font=theme.body_font, size=theme.size_small,
               color=theme.muted, italic=True)
    end_run = cap_p.add_run()
    fld_e = etree.SubElement(end_run._r, qn("w:fldChar"))
    fld_e.set(qn("w:fldCharType"), "end")
    # caption text after
    text_run = cap_p.add_run(f". {caption}")
    _style_run(text_run, font=theme.body_font, size=theme.size_small,
               color=theme.muted, italic=True)


def render_callout(doc, block: dict, theme: Theme) -> None:
    """Colored callout box. Variants: info / success / warning / danger / note / tip."""
    variant = block.get("variant", "info")
    palette_map = {
        "info":     theme.info,
        "success":  theme.success,
        "warning":  theme.warning,
        "danger":   theme.danger,
        "note":     theme.muted,
        "tip":      theme.accent,
        "action":   (139, 92, 246),
        "decision": (14, 165, 233),
        "question": (236, 72, 153),
        "mention":  (99, 102, 241),
        "key":      (217, 119, 6),
    }
    accent = palette_map.get(variant, theme.info)
    bg = _mix(accent, (255, 255, 255), 0.90)

    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    cell = table.rows[0].cells[0]
    _shade_cell(cell, bg)
    _set_cell_margins(cell, left=180, right=180, top=120, bottom=120)
    _set_cell_left_border(cell, accent, size=24)
    # remove other borders
    _clear_cell_borders_except_left(cell)
    _set_table_width_pct(table, 100)

    # clear default paragraph
    for pg in list(cell.paragraphs):
        cell._tc.remove(pg._p)

    title = block.get("title")
    if title:
        tp = cell.add_paragraph()
        tp.paragraph_format.space_after = Pt(2)
        prefix = {"warning": "⚠ ", "danger": "✕ ", "success": "✓ ",
                  "info": "ⓘ ", "note": "● ", "tip": "★ ",
                  "action": "▶ ", "decision": "◆ ",
                  "question": "? ", "mention": "@ ",
                  "key": "🔑 "}.get(variant, "")
        tr = tp.add_run(prefix + str(title))
        _style_run(tr, font=theme.heading_font, size=theme.size_body,
                   color=accent, bold=True)

    text = block.get("text")
    if text:
        bp = cell.add_paragraph()
        bp.paragraph_format.space_after = Pt(2)
        br = bp.add_run(text)
        _style_run(br, font=theme.body_font, size=theme.size_body, color=theme.fg)

    bullets = block.get("bullets")
    if isinstance(bullets, list):
        for item in bullets:
            bp = cell.add_paragraph()
            bp.paragraph_format.left_indent = Inches(0.15)
            bp.paragraph_format.space_after = Pt(0)
            br = bp.add_run("• " + str(item))
            _style_run(br, font=theme.body_font, size=theme.size_body, color=theme.fg)


def render_sidebar(doc, block: dict, theme: Theme) -> None:
    """Subtle gray surface box for tangential context."""
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    cell = table.rows[0].cells[0]
    _shade_cell(cell, theme.surface)
    _set_cell_margins(cell, left=200, right=200, top=160, bottom=160)
    _set_table_borders(table, size=0)
    _set_table_width_pct(table, 100)
    for pg in list(cell.paragraphs):
        cell._tc.remove(pg._p)
    title = block.get("title")
    if title:
        tp = cell.add_paragraph()
        tp.paragraph_format.space_after = Pt(4)
        tr = tp.add_run(title)
        _style_run(tr, font=theme.heading_font, size=theme.size_body + 1,
                   color=theme.heading, bold=True)
    text = block.get("text")
    if text:
        bp = cell.add_paragraph()
        bp.paragraph_format.space_after = Pt(0)
        br = bp.add_run(text)
        _style_run(br, font=theme.body_font, size=theme.size_body, color=theme.fg)
    bullets = block.get("bullets")
    if isinstance(bullets, list):
        for item in bullets:
            bp = cell.add_paragraph()
            bp.paragraph_format.left_indent = Inches(0.15)
            bp.paragraph_format.space_after = Pt(0)
            br = bp.add_run("• " + str(item))
            _style_run(br, font=theme.body_font, size=theme.size_body, color=theme.fg)


def render_spacer(doc, block: dict, theme: Theme) -> None:
    h_pt = float(block.get("height", 12))
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(h_pt)


def render_section_break(doc, block: dict, theme: Theme) -> None:
    """Insert a new section so subsequent content can switch orientation
    or page size. Optional ``orientation: "portrait"|"landscape"`` and
    ``size: "A4"|"Letter"|"Legal"``.
    """
    from docx.enum.section import WD_SECTION, WD_ORIENT
    from docx.shared import Inches as _Inches

    new_section = doc.add_section(WD_SECTION.NEW_PAGE)
    sizes = {"A4": (8.27, 11.69), "Letter": (8.5, 11.0), "Legal": (8.5, 14.0)}
    sw, sh = sizes.get(block.get("size", "A4"), sizes["A4"])
    if block.get("orientation", "portrait") == "landscape":
        sw, sh = sh, sw
        new_section.orientation = WD_ORIENT.LANDSCAPE
    else:
        new_section.orientation = WD_ORIENT.PORTRAIT
    new_section.page_width = _Inches(sw)
    new_section.page_height = _Inches(sh)
    new_section.left_margin = _Inches(theme.margin_left)
    new_section.right_margin = _Inches(theme.margin_right)
    new_section.top_margin = _Inches(theme.margin_top)
    new_section.bottom_margin = _Inches(theme.margin_bottom)


def render_divider(doc, block: dict, theme: Theme) -> None:
    """Thicker divider with theme accent color (richer than horizontal_rule)."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(8)
    pPr = p._p.get_or_add_pPr()
    pBdr = etree.SubElement(pPr, qn("w:pBdr"))
    bottom = etree.SubElement(pBdr, qn("w:bottom"))
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(int(block.get("thickness", 12))))
    bottom.set(qn("w:space"), "1")
    color_rgb = block.get("color") or theme.accent
    if isinstance(color_rgb, list):
        color_rgb = tuple(color_rgb)
    bottom.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*color_rgb))


# ---------------------------------------------------------------------------
# extra helpers
# ---------------------------------------------------------------------------


_KEYWORDS = {
    "python": {"def", "class", "return", "if", "elif", "else", "for", "while",
               "in", "not", "and", "or", "is", "from", "import", "as", "with",
               "try", "except", "finally", "raise", "lambda", "yield", "pass",
               "break", "continue", "True", "False", "None", "self", "async",
               "await"},
    "javascript": {"function", "const", "let", "var", "return", "if", "else",
                   "for", "while", "do", "switch", "case", "break", "continue",
                   "new", "this", "class", "extends", "import", "from", "export",
                   "default", "async", "await", "try", "catch", "throw", "true",
                   "false", "null", "undefined"},
    "ts": {"interface", "type", "extends", "implements", "as", "enum", "public",
           "private", "protected", "readonly"},
    "sql": {"SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "JOIN",
            "INNER", "LEFT", "RIGHT", "OUTER", "ON", "AS", "INSERT", "INTO",
            "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP",
            "ALTER", "INDEX", "WITH", "UNION", "ALL", "DISTINCT", "AND", "OR",
            "NOT", "IN", "LIKE", "BETWEEN", "IS", "NULL", "LIMIT", "OFFSET"},
}


def _highlight(line: str, language: str) -> list[tuple[str, str]]:
    """Return list of (kind, text) spans where kind ∈ {plain, keyword, string,
    comment, number}. Pure stdlib, single-pass. Falls back to plain for
    unknown languages.
    """
    import re

    if language not in {"python", "javascript", "js", "ts", "typescript", "sql"}:
        return [("plain", line)]
    lang_key = {"javascript": "javascript", "js": "javascript",
                "ts": "javascript", "typescript": "javascript"}.get(language, language)
    keywords = _KEYWORDS.get(lang_key, set())
    if lang_key == "javascript":
        keywords = keywords | _KEYWORDS.get("ts", set())

    # Comment first — strip end-of-line comment from further parsing
    comment_marker = "#" if language == "python" else (
        "--" if language == "sql" else "//")
    pre, _, comment = line.partition(comment_marker)
    spans: list[tuple[str, str]] = []
    # Now tokenize `pre`
    pat = re.compile(
        r"""(?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|"""
        r"""(?P<num>\b\d[\d_]*(?:\.\d+)?\b)|"""
        r"""(?P<word>\b[A-Za-z_][A-Za-z0-9_]*\b)|"""
        r"""(?P<other>[^"'\w]+|.)""",
        re.VERBOSE,
    )
    for m in pat.finditer(pre):
        if m.lastgroup == "str":
            spans.append(("string", m.group(0)))
        elif m.lastgroup == "num":
            spans.append(("number", m.group(0)))
        elif m.lastgroup == "word":
            tok = m.group(0)
            if tok in keywords or tok.upper() in keywords:
                spans.append(("keyword", tok))
            else:
                spans.append(("plain", tok))
        else:
            spans.append(("plain", m.group(0)))
    if comment:
        spans.append(("comment", comment_marker + comment))
    return spans


def _code_color(kind: str, theme: Theme) -> tuple[int, int, int]:
    if kind == "keyword":
        return (109, 40, 217)         # violet
    if kind == "string":
        return (22, 101, 52)          # dark green
    if kind == "comment":
        return theme.muted
    if kind == "number":
        return (180, 83, 9)           # orange
    return theme.fg


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    """Blend a→b by t∈[0,1]. t=0 returns a, t=1 returns b."""
    return (
        int(a[0] * (1 - t) + b[0] * t),
        int(a[1] * (1 - t) + b[1] * t),
        int(a[2] * (1 - t) + b[2] * t),
    )


def _set_cell_margins(cell, *, left: int = 100, right: int = 100,
                      top: int = 0, bottom: int = 0) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = tcPr.find(qn("w:tcMar"))
    if tcMar is None:
        tcMar = etree.SubElement(tcPr, qn("w:tcMar"))
    for side, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = tcMar.find(qn(f"w:{side}"))
        if el is None:
            el = etree.SubElement(tcMar, qn(f"w:{side}"))
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")


def _set_cell_top_border(cell, color, size: int = 12) -> None:
    _set_cell_side_border(cell, "top", color, size)


def _set_cell_bottom_border(cell, color, size: int = 4) -> None:
    _set_cell_side_border(cell, "bottom", color, size)


def _set_cell_left_border(cell, color, size: int = 24) -> None:
    _set_cell_side_border(cell, "left", color, size)


def _set_cell_side_border(cell, side: str, color, size: int) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    tcBorders = tcPr.find(qn("w:tcBorders"))
    if tcBorders is None:
        tcBorders = etree.SubElement(tcPr, qn("w:tcBorders"))
    el = tcBorders.find(qn(f"w:{side}"))
    if el is None:
        el = etree.SubElement(tcBorders, qn(f"w:{side}"))
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(size))
    el.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*color))


def _clear_cell_borders_except_left(cell) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    tcBorders = tcPr.find(qn("w:tcBorders"))
    if tcBorders is None:
        tcBorders = etree.SubElement(tcPr, qn("w:tcBorders"))
    for side in ("top", "bottom", "right"):
        el = tcBorders.find(qn(f"w:{side}"))
        if el is None:
            el = etree.SubElement(tcBorders, qn(f"w:{side}"))
        el.set(qn("w:val"), "nil")


def _set_table_width_pct(table, pct: int) -> None:
    tbl = table._tbl
    tblPr = tbl.find(qn("w:tblPr"))
    if tblPr is None:
        tblPr = etree.SubElement(tbl, qn("w:tblPr"))
    tblW = tblPr.find(qn("w:tblW"))
    if tblW is None:
        tblW = etree.SubElement(tblPr, qn("w:tblW"))
    tblW.set(qn("w:w"), str(pct * 50))  # 50ths of a percent
    tblW.set(qn("w:type"), "pct")


RENDERERS = {
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
    # new
    "cover": render_cover,
    "chart": render_chart,
    "callout": render_callout,
    "sidebar": render_sidebar,
    "spacer": render_spacer,
    "divider": render_divider,
    "section_break": render_section_break,
}


def _register_extended() -> None:
    from . import extended as _ext
    RENDERERS.update({
        "pull_quote": _ext.render_pull_quote,
        "definition_list": _ext.render_definition_list,
        "image_gallery": _ext.render_image_gallery,
        "equation": _ext.render_equation,
        "bookmark": _ext.render_bookmark,
        "xref": _ext.render_xref,
        "timeline": _ext.render_timeline,
        "progress": _ext.render_progress,
        "card_grid": _ext.render_card_grid,
        "drop_cap": _ext.render_drop_cap,
        "table_of_figures": _ext.render_table_of_figures,
        "table_of_charts": _ext.render_table_of_charts,
        "table_of_tables": _ext.render_table_of_tables,
        "gantt": _ext.render_gantt,
    })
    RENDERERS.update({
        "faq": _ext.render_faq,
        "pricing_table": _ext.render_pricing_table,
        "author": _ext.render_author,
        "step_list": _ext.render_step_list,
        "code_diff": _ext.render_code_diff,
        "bibliography": _ext.render_bibliography,
        "qr_code": _ext.render_qr_code,
        "stat_list": _ext.render_stat_list,
    })
    from . import comments as _cmt
    RENDERERS["comment"] = _cmt.render_comment


_register_extended()
