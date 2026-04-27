"""Extended block renderers — pull quote, definition list, image gallery,
equation (OMath), bookmark, xref. Kept separate from renderers.py to keep
the core file focused on the original 13 block types.
"""
from __future__ import annotations

from typing import Any

from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Inches, Pt
from lxml import etree

from .themes import Theme


def render_pull_quote(doc, block: dict, theme: Theme) -> None:
    """Large, centered, accent-colored quote with em-dashes around it.

    Used for breaking up dense body copy with a visually loud quote.
    Differs from ``quote``: bigger, centered, no left bar — pull quotes
    are about visual punch, not citation.
    """
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(8)
    pPr = p._p.get_or_add_pPr()
    # Top + bottom borders for emphasis
    pBdr = etree.SubElement(pPr, qn("w:pBdr"))
    color_hex = "{:02X}{:02X}{:02X}".format(*theme.accent)
    for side in ("top", "bottom"):
        b = etree.SubElement(pBdr, qn(f"w:{side}"))
        b.set(qn("w:val"), "single")
        b.set(qn("w:sz"), "8")
        b.set(qn("w:space"), "8")
        b.set(qn("w:color"), color_hex)
    run = p.add_run(f"“{block['text']}”")
    _stylize(run, font=theme.heading_font, size=theme.size_h2,
             color=theme.accent, italic=True, bold=False)
    attribution = block.get("attribution")
    if attribution:
        ap = doc.add_paragraph()
        ap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        ap.paragraph_format.space_after = Pt(8)
        ar = ap.add_run(f"— {attribution}")
        _stylize(ar, font=theme.body_font, size=theme.size_small,
                 color=theme.muted)


def render_definition_list(doc, block: dict, theme: Theme) -> None:
    """Term/definition pairs styled as a glossary. Uses a 2-column borderless
    table so terms align cleanly without a manual tab stop.
    """
    items = block["items"]
    table = doc.add_table(rows=len(items), cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    _set_table_borders(table, size=0)
    _set_col_widths(table, [Inches(1.7), Inches(4.6)])
    for i, it in enumerate(items):
        row = table.rows[i]
        # term
        term_cell = row.cells[0]
        for pp in list(term_cell.paragraphs):
            term_cell._tc.remove(pp._p)
        tp = term_cell.add_paragraph()
        tp.paragraph_format.space_after = Pt(4)
        tr = tp.add_run(str(it["term"]))
        _stylize(tr, font=theme.heading_font, size=theme.size_body,
                 color=theme.heading, bold=True)
        # definition (rich text)
        def_cell = row.cells[1]
        for pp in list(def_cell.paragraphs):
            def_cell._tc.remove(pp._p)
        dp = def_cell.add_paragraph()
        dp.paragraph_format.space_after = Pt(4)
        from .inline import add_inline_runs
        add_inline_runs(dp, str(it["definition"]), theme,
                        font=theme.body_font, size=theme.size_body,
                        color=theme.fg)


def render_image_gallery(doc, block: dict, theme: Theme) -> None:
    """Grid of images. Auto-fits ``cols`` columns (default 2). Each image
    is a {path, caption?, width_in?} dict or a bare path string.
    """
    from .renderers import _resolve_image  # reuse the URL/path resolver
    raw = block["images"]
    imgs: list[dict] = []
    for it in raw:
        imgs.append({"path": it} if isinstance(it, str) else dict(it))
    cols = int(block.get("cols", 2))
    rows_n = (len(imgs) + cols - 1) // cols
    table = doc.add_table(rows=rows_n, cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _set_table_borders(table, size=0)

    # default width per cell
    default_w = block.get("width_in") or (6.2 / cols)
    for idx, img in enumerate(imgs):
        r, c = divmod(idx, cols)
        cell = table.rows[r].cells[c]
        for pp in list(cell.paragraphs):
            cell._tc.remove(pp._p)
        p = cell.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run()
        path = _resolve_image(img["path"])
        run.add_picture(path, width=Inches(float(img.get("width_in", default_w))))
        if img.get("caption"):
            cp = cell.add_paragraph()
            cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cr = cp.add_run(img["caption"])
            _stylize(cr, font=theme.body_font, size=theme.size_small,
                     color=theme.muted, italic=True)


def render_equation(doc, block: dict, theme: Theme) -> None:
    """Render a math equation. Accepts ``latex`` (rendered via matplotlib
    mathtext → PNG → embedded) — keeps it portable without forcing OMath
    XSD authoring. ``inline: false`` (default) centers it on its own line.
    """
    from .charts import _ensure_font_for  # font registration
    import hashlib
    import pathlib
    import tempfile

    latex = block["latex"]
    # use matplotlib's mathtext to render LaTeX-flavored math to PNG
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(4.0, 0.8), dpi=240)
    fig.text(0.5, 0.5, f"${latex}$",
             ha="center", va="center",
             fontsize=int(block.get("font_size", theme.size_h3)),
             color="#{:02X}{:02X}{:02X}".format(*theme.fg))
    h = hashlib.sha1(latex.encode()).hexdigest()[:16]
    out = pathlib.Path(tempfile.gettempdir()) / f"docx_eq_{h}.png"
    fig.savefig(str(out), bbox_inches="tight", pad_inches=0.05,
                facecolor="white", dpi=240)
    plt.close(fig)

    p = doc.add_paragraph()
    if not block.get("inline"):
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run()
    width = float(block.get("width_in", 3.0))
    run.add_picture(str(out), width=Inches(width))
    label = block.get("label")
    if label:
        cp = doc.add_paragraph()
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cr = cp.add_run(label)
        _stylize(cr, font=theme.body_font, size=theme.size_small,
                 color=theme.muted, italic=True)


def render_bookmark(doc, block: dict, theme: Theme) -> None:
    """Anchor for cross-references. Invisible — just emits a bookmarkStart/End
    pair around an empty run so ``xref`` and ``[...](#name)`` links can
    target it.
    """
    name = block["name"]
    p = doc.add_paragraph()
    bm_id = block.get("_id", abs(hash(name)) % (10 ** 9))
    bs = etree.SubElement(p._p, qn("w:bookmarkStart"))
    bs.set(qn("w:id"), str(bm_id))
    bs.set(qn("w:name"), name)
    be = etree.SubElement(p._p, qn("w:bookmarkEnd"))
    be.set(qn("w:id"), str(bm_id))


def render_xref(doc, block: dict, theme: Theme) -> None:
    """Render a cross-reference field that resolves to a bookmark's text or
    page number. ``target`` = bookmark name. ``kind`` = "text" (default) /
    "page" / "number". Word fills it in on field refresh.
    """
    target = block["target"]
    kind = block.get("kind", "text")
    instr = {
        "text":   f' REF {target} \\h ',
        "page":   f' PAGEREF {target} \\h ',
        "number": f' REF {target} \\n \\h ',
    }.get(kind, f' REF {target} \\h ')

    p = doc.add_paragraph()
    run = p.add_run()
    fld = etree.SubElement(run._r, qn("w:fldChar"))
    fld.set(qn("w:fldCharType"), "begin"); fld.set(qn("w:dirty"), "true")
    instr_run = p.add_run()
    it = etree.SubElement(instr_run._r, qn("w:instrText"))
    it.text = instr
    it.set(qn("xml:space"), "preserve")
    sep_run = p.add_run()
    sep = etree.SubElement(sep_run._r, qn("w:fldChar"))
    sep.set(qn("w:fldCharType"), "separate")
    placeholder_run = p.add_run(block.get("placeholder", "↗ link"))
    _stylize(placeholder_run, font=theme.body_font, size=theme.size_body,
             color=theme.accent)
    end_run = p.add_run()
    end = etree.SubElement(end_run._r, qn("w:fldChar"))
    end.set(qn("w:fldCharType"), "end")


# ---------------------------------------------------------------------------
# helpers (lightweight copies to avoid circular imports with renderers.py)
# ---------------------------------------------------------------------------


def _stylize(run, *, font: str, size: int, color: tuple[int, int, int],
             bold: bool = False, italic: bool = False) -> None:
    from docx.shared import RGBColor

    run.font.name = font
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = RGBColor(*color)
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = etree.SubElement(rPr, qn("w:rFonts"))
    for k in ("ascii", "hAnsi", "eastAsia", "cs"):
        rFonts.set(qn(f"w:{k}"), font)


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


def _set_col_widths(table, widths) -> None:
    tbl = table._tbl
    grid = tbl.find(qn("w:tblGrid"))
    if grid is None:
        grid = etree.SubElement(tbl, qn("w:tblGrid"))
    for w in widths:
        gc = etree.SubElement(grid, qn("w:gridCol"))
        gc.set(qn("w:w"), str(int(w.emu / 635)))   # dxa
    for row in table.rows:
        for cell, w in zip(row.cells, widths):
            cell.width = w
