"""Header / footer / page-number rendering.

Applied via meta:

  meta:
    header:
      left:   "..."           # any of left/center/right is optional
      center: "..."
      right:  "..."
    footer:
      left:   "..."
      center: "Page {page} of {total}"   # {page} and {total} are field codes
      right:  "..."
    different_first_page: true        # cover page no header/footer
    page_numbers: "footer-right"      # quick preset; see below

Quick presets for ``page_numbers``:
  - "footer-right" / "footer-center" / "footer-left"
  - "header-right" / "header-center" / "header-left"
  - "footer-right-of-total"  → "Page N of M" on footer-right
"""
from __future__ import annotations

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt
from lxml import etree


def apply_page_number_format(doc, meta: dict) -> None:
    """Set page-number format and start value for section 0.

    meta.page_numbers_format: "decimal" (1,2,3) | "lowerRoman" (i,ii) |
                               "upperRoman" (I,II) | "lowerLetter" (a,b) |
                               "upperLetter" (A,B)
    meta.page_numbers_start: int (e.g. 1 to restart count after cover)
    """
    fmt = meta.get("page_numbers_format")
    start = meta.get("page_numbers_start")
    if fmt is None and start is None:
        return
    section = doc.sections[0]
    sectPr = section._sectPr
    pgNumType = sectPr.find(qn("w:pgNumType"))
    if pgNumType is None:
        pgNumType = etree.SubElement(sectPr, qn("w:pgNumType"))
    if fmt is not None:
        pgNumType.set(qn("w:fmt"), str(fmt))
    if start is not None:
        pgNumType.set(qn("w:start"), str(int(start)))


def apply_header_footer(doc, meta: dict, theme) -> None:
    header = meta.get("header") or {}
    footer = meta.get("footer") or {}
    preset = meta.get("page_numbers")
    different_first = bool(meta.get("different_first_page"))

    if preset:
        _apply_page_number_preset(footer if preset.startswith("footer") else header,
                                  preset)

    if not header and not footer and not preset:
        return

    section = doc.sections[0]
    if different_first:
        section.different_first_page_header_footer = True
        # also flip the OOXML titlePg flag explicitly (python-docx may set it)
        sectPr = section._sectPr
        titlePg = sectPr.find(qn("w:titlePg"))
        if titlePg is None:
            etree.SubElement(sectPr, qn("w:titlePg"))

    if header:
        _populate(section.header, header, theme, is_footer=False)
    if footer:
        _populate(section.footer, footer, theme, is_footer=True)


def _apply_page_number_preset(target: dict, preset: str) -> None:
    """Mutate the footer/header dict in place to add a page-number slot."""
    if preset.endswith("of-total"):
        text = "Page {page} of {total}"
    else:
        text = "{page}"
    slot = preset.split("-", 1)[1] if "-" in preset else "right"
    if slot in ("left", "center", "right") and slot not in target:
        target[slot] = text


def _populate(part, slots: dict, theme, *, is_footer: bool) -> None:
    """Populate a header/footer part with up to 3 slots (left/center/right)
    using a 1-row 3-col borderless table so each slot gets its own column.
    """
    # remove default empty paragraph
    for p in list(part.paragraphs):
        p._p.getparent().remove(p._p)

    from docx.shared import Inches
    table = part.add_table(rows=1, cols=3, width=Inches(6.0))
    _no_borders(table)
    # set even widths via tblW pct
    tblPr = table._tbl.find(qn("w:tblPr"))
    if tblPr is None:
        tblPr = etree.SubElement(table._tbl, qn("w:tblPr"))
    tblW = tblPr.find(qn("w:tblW"))
    if tblW is None:
        tblW = etree.SubElement(tblPr, qn("w:tblW"))
    tblW.set(qn("w:w"), "5000"); tblW.set(qn("w:type"), "pct")

    cells = table.rows[0].cells
    for slot, idx, align in (("left", 0, WD_ALIGN_PARAGRAPH.LEFT),
                             ("center", 1, WD_ALIGN_PARAGRAPH.CENTER),
                             ("right", 2, WD_ALIGN_PARAGRAPH.RIGHT)):
        text = slots.get(slot)
        if not text:
            continue
        c = cells[idx]
        # clear default paragraph in cell
        for pp in list(c.paragraphs):
            c._tc.remove(pp._p)
        p = c.add_paragraph()
        p.alignment = align
        _emit_with_fields(p, text, theme)


def _emit_with_fields(p, text: str, theme) -> None:
    """Emit text into paragraph, swapping {page}/{total} for w:fldChar fields."""
    from .inline import _style_run as _stylize  # tiny helper

    # split by tokens, preserving order
    tokens = []
    i = 0
    while i < len(text):
        if text.startswith("{page}", i):
            tokens.append(("field", "PAGE"))
            i += len("{page}")
        elif text.startswith("{total}", i):
            tokens.append(("field", "NUMPAGES"))
            i += len("{total}")
        else:
            j = len(text)
            for marker in ("{page}", "{total}"):
                k = text.find(marker, i)
                if k != -1 and k < j:
                    j = k
            tokens.append(("text", text[i:j]))
            i = j

    for kind, payload in tokens:
        if kind == "text":
            run = p.add_run(payload)
            _stylize(run, theme,
                     font=theme.body_font, size=theme.size_small,
                     color=theme.muted)
        else:
            _add_field(p, payload, theme)


def _add_field(p, instr: str, theme) -> None:
    """Add a Word field (PAGE / NUMPAGES) as three runs: begin, instr, end."""
    color = "{:02X}{:02X}{:02X}".format(*theme.muted)
    run_el = etree.SubElement(p._p, qn("w:r"))
    rPr = etree.SubElement(run_el, qn("w:rPr"))
    rFonts = etree.SubElement(rPr, qn("w:rFonts"))
    for k in ("ascii", "hAnsi", "eastAsia", "cs"):
        rFonts.set(qn(f"w:{k}"), theme.body_font)
    sz = etree.SubElement(rPr, qn("w:sz"))
    sz.set(qn("w:val"), str(theme.size_small * 2))
    col = etree.SubElement(rPr, qn("w:color"))
    col.set(qn("w:val"), color)
    fld = etree.SubElement(run_el, qn("w:fldChar"))
    fld.set(qn("w:fldCharType"), "begin")

    instr_run = etree.SubElement(p._p, qn("w:r"))
    instr_text = etree.SubElement(instr_run, qn("w:instrText"))
    instr_text.text = f" {instr} "
    instr_text.set(qn("xml:space"), "preserve")

    end_run = etree.SubElement(p._p, qn("w:r"))
    fld_end = etree.SubElement(end_run, qn("w:fldChar"))
    fld_end.set(qn("w:fldCharType"), "end")


def _no_borders(table) -> None:
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
        b.set(qn("w:val"), "nil")
