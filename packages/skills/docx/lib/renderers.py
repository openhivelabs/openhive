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

from .themes import Theme


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------


def _rgb(c: tuple[int, int, int]) -> RGBColor:
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
    _add_paragraph(doc, block["text"], theme, align=block.get("align"))


def render_bullets(doc, block: dict, theme: Theme) -> None:
    _emit_list(doc, block["items"], theme, ordered=False, level=0)


def render_numbered(doc, block: dict, theme: Theme) -> None:
    _emit_list(doc, block["items"], theme, ordered=True, level=0)


def _emit_list(doc, items: list, theme: Theme, *, ordered: bool, level: int) -> None:
    style_name = "List Number" if ordered else "List Bullet"
    i = 0
    while i < len(items):
        it = items[i]
        if isinstance(it, str):
            p = doc.add_paragraph(style=style_name if level == 0 else None)
            run = p.add_run(it)
            _style_run(run, font=theme.body_font, size=theme.size_body, color=theme.fg)
            # indent for nested levels (List Bullet style only goes 1 level)
            if level > 0:
                p.paragraph_format.left_indent = Inches(0.25 + 0.3 * level)
                # prepend a visual marker since we're off the list style
                prefix = {1: "– ", 2: "· "}.get(level, "· ")
                # re-create run with prefix
                p.clear()
                run = p.add_run(prefix + it)
                _style_run(run, font=theme.body_font, size=theme.size_body, color=theme.fg)
            if i + 1 < len(items) and isinstance(items[i + 1], list):
                _emit_list(doc, items[i + 1], theme, ordered=ordered, level=level + 1)
                i += 2
                continue
        i += 1


def render_table(doc, block: dict, theme: Theme) -> None:
    headers = block["headers"]
    rows = block["rows"]
    n_cols = len(headers)
    table = doc.add_table(rows=1 + len(rows), cols=n_cols)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT

    style_name = {
        "grid": "Table Grid",
        "light": "Light Shading",
        "plain": "Normal Table",
    }.get(block.get("style", "grid"), "Table Grid")
    try:
        table.style = doc.styles[style_name]
    except KeyError:
        pass

    # header row
    hdr_row = table.rows[0]
    for j, h in enumerate(headers):
        cell = hdr_row.cells[j]
        cell.text = ""
        p = cell.paragraphs[0]
        run = p.add_run(str(h))
        _style_run(run, font=theme.heading_font, size=theme.size_body,
                   color=(255, 255, 255), bold=True)
        _shade_cell(cell, theme.accent)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER

    # body rows
    for ri, row in enumerate(rows):
        tr = table.rows[ri + 1]
        for j in range(n_cols):
            val = row[j] if j < len(row) else ""
            cell = tr.cells[j]
            cell.text = ""
            p = cell.paragraphs[0]
            run = p.add_run(_fmt_cell(val))
            _style_run(run, font=theme.body_font, size=theme.size_body, color=theme.fg)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


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
    p = doc.add_paragraph()
    if block.get("align"):
        a = _align(block.get("align"))
        if a is not None:
            p.alignment = a
    run = p.add_run()
    if width is not None:
        run.add_picture(path, width=Inches(float(width)))
    else:
        run.add_picture(path)
    caption = block.get("caption")
    if caption:
        cap_p = doc.add_paragraph()
        cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap_run = cap_p.add_run(caption)
        _style_run(cap_run, font=theme.body_font, size=theme.size_small,
                   color=theme.muted, italic=True)


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
    # one paragraph per line, monospace, light background via table trick
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
    # write lines
    lines = block["text"].split("\n")
    # clear the default paragraph, add one per line
    for pg in list(cell.paragraphs):
        cell._tc.remove(pg._p)
    for line in lines:
        p = cell.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        run = p.add_run(line or " ")
        _style_run(run, font=theme.mono_font, size=theme.size_code, color=theme.fg)


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
    """Insert a TOC field. User must press F9 in Word to populate."""
    levels = block.get("levels", 3)
    p = doc.add_paragraph()
    run = p.add_run()
    fldChar = etree.SubElement(run._r, qn("w:fldChar"))
    fldChar.set(qn("w:fldCharType"), "begin")
    instrText = etree.SubElement(run._r, qn("w:instrText"))
    instrText.text = f'TOC \\o "1-{levels}" \\h \\z \\u'
    fldChar2 = etree.SubElement(run._r, qn("w:fldChar"))
    fldChar2.set(qn("w:fldCharType"), "end")
    # placeholder paragraph shown until F9
    note_p = doc.add_paragraph()
    note_run = note_p.add_run("(목차는 Word 에서 F9 로 갱신)")
    _style_run(note_run, font=theme.body_font, size=theme.size_small,
               color=theme.muted, italic=True)


def render_kpi_row(doc, block: dict, theme: Theme) -> None:
    """A single-row table with N stat cells (big number + label)."""
    stats = block["stats"]
    n = len(stats)
    table = doc.add_table(rows=2, cols=n)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for j, s in enumerate(stats):
        # row 0: value (big)
        c0 = table.rows[0].cells[j]
        c0.text = ""
        p0 = c0.paragraphs[0]
        p0.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r0 = p0.add_run(str(s["value"]))
        _style_run(r0, font=theme.heading_font, size=theme.size_kpi,
                   color=theme.accent, bold=True)
        c0.vertical_alignment = WD_ALIGN_VERTICAL.CENTER

        # row 1: label + optional delta
        c1 = table.rows[1].cells[j]
        c1.text = ""
        p1 = c1.paragraphs[0]
        p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
        rl = p1.add_run(str(s["label"]))
        _style_run(rl, font=theme.body_font, size=theme.size_small, color=theme.muted)
        if s.get("delta"):
            d_str = str(s["delta"])
            d_color = theme.muted
            if d_str.startswith("+"): d_color = (34, 139, 34)
            elif d_str.startswith("-"): d_color = (178, 34, 34)
            pd = c1.add_paragraph()
            pd.alignment = WD_ALIGN_PARAGRAPH.CENTER
            rd = pd.add_run(d_str)
            _style_run(rd, font=theme.body_font, size=theme.size_small,
                       color=d_color, bold=True)


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
}
