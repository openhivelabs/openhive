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


def render_timeline(doc, block: dict, theme: Theme) -> None:
    """Vertical milestone timeline. Each item: {date, title, body?}.

    Renders as a 2-column borderless table — left column is date + colored
    dot, right column is title + body. The accent line ties them visually.
    """
    items = block["items"]
    table = doc.add_table(rows=len(items), cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    _set_table_borders(table, size=0)
    _set_col_widths(table, [Inches(1.4), Inches(5.0)])

    for i, it in enumerate(items):
        row = table.rows[i]
        # left — date + dot
        date_cell = row.cells[0]
        for pp in list(date_cell.paragraphs):
            date_cell._tc.remove(pp._p)
        dp = date_cell.add_paragraph()
        dp.paragraph_format.space_after = Pt(2)
        dp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        date_text = it.get("date", "")
        dr = dp.add_run(str(date_text))
        _stylize(dr, font=theme.body_font, size=theme.size_small,
                 color=theme.muted)

        # right — title + body, with left accent border (timeline rail)
        body_cell = row.cells[1]
        for pp in list(body_cell.paragraphs):
            body_cell._tc.remove(pp._p)
        # cell-level left border = timeline rail
        tcPr = body_cell._tc.get_or_add_tcPr()
        tcBorders = etree.SubElement(tcPr, qn("w:tcBorders"))
        left = etree.SubElement(tcBorders, qn("w:left"))
        left.set(qn("w:val"), "single")
        left.set(qn("w:sz"), "16")
        left.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*theme.accent))
        for side in ("top", "bottom", "right"):
            b = etree.SubElement(tcBorders, qn(f"w:{side}"))
            b.set(qn("w:val"), "nil")
        tcMar = etree.SubElement(tcPr, qn("w:tcMar"))
        for side, val in (("top", 60), ("bottom", 60), ("left", 200), ("right", 0)):
            el = etree.SubElement(tcMar, qn(f"w:{side}"))
            el.set(qn("w:w"), str(val)); el.set(qn("w:type"), "dxa")

        tp = body_cell.add_paragraph()
        tp.paragraph_format.space_after = Pt(2)
        tr = tp.add_run(str(it["title"]))
        _stylize(tr, font=theme.heading_font, size=theme.size_body,
                 color=theme.heading, bold=True)
        if it.get("body"):
            from .inline import add_inline_runs
            bp = body_cell.add_paragraph()
            bp.paragraph_format.space_after = Pt(0)
            add_inline_runs(bp, str(it["body"]), theme,
                            font=theme.body_font, size=theme.size_body,
                            color=theme.fg)


def render_progress(doc, block: dict, theme: Theme) -> None:
    """Progress bars — label / track / value. Each bar a 1-row 3-col table.

    bar item: {label, value, max?, color?, suffix?}
    value = 0..max (default 100). color overrides theme palette cycle.
    """
    from .themes import palette_color

    bars = block["bars"]
    for i, b in enumerate(bars):
        label = str(b["label"])
        value = float(b["value"])
        maximum = float(b.get("max", 100))
        suffix = b.get("suffix", "%")
        color = tuple(b["color"]) if b.get("color") else palette_color(theme, i)

        outer = doc.add_table(rows=1, cols=3)
        outer.alignment = WD_TABLE_ALIGNMENT.LEFT
        _set_table_borders(outer, size=0)
        _set_col_widths(outer, [Inches(1.6), Inches(3.6), Inches(0.8)])
        row = outer.rows[0]

        # label cell
        lc = row.cells[0]
        for pp in list(lc.paragraphs):
            lc._tc.remove(pp._p)
        lp = lc.add_paragraph()
        lr = lp.add_run(label)
        _stylize(lr, font=theme.body_font, size=theme.size_small,
                 color=theme.fg, bold=True)

        # track cell — nested 1-row 2-col table where col widths = filled vs empty
        tc = row.cells[1]
        for pp in list(tc.paragraphs):
            tc._tc.remove(pp._p)
        track = tc.add_table(rows=1, cols=2)
        ratio = max(0.0, min(1.0, value / maximum if maximum else 0))
        full_w = Inches(3.6 * ratio) if ratio > 0.001 else Inches(0.01)
        empty_w = Inches(3.6 * (1 - ratio)) if ratio < 0.999 else Inches(0.01)
        _set_col_widths(track, [full_w, empty_w])
        _set_table_borders(track, size=0)
        # filled
        fill_cell = track.rows[0].cells[0]
        _shade_fill(fill_cell, color)
        for pp in list(fill_cell.paragraphs):
            fill_cell._tc.remove(pp._p)
        fp = fill_cell.add_paragraph()
        fp.paragraph_format.space_after = Pt(0)
        fp.add_run(" ")
        # empty
        empty_cell = track.rows[0].cells[1]
        _shade_fill(empty_cell, _mix_color(theme.muted, (255, 255, 255), 0.85))
        for pp in list(empty_cell.paragraphs):
            empty_cell._tc.remove(pp._p)
        ep = empty_cell.add_paragraph()
        ep.paragraph_format.space_after = Pt(0)
        ep.add_run(" ")

        # value cell
        vc = row.cells[2]
        for pp in list(vc.paragraphs):
            vc._tc.remove(pp._p)
        vp = vc.add_paragraph()
        vp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        v_text = f"{int(value)}{suffix}" if value == int(value) else f"{value:.1f}{suffix}"
        vr = vp.add_run(v_text)
        _stylize(vr, font=theme.heading_font, size=theme.size_small,
                 color=color, bold=True)


def render_card_grid(doc, block: dict, theme: Theme) -> None:
    """N×M card grid. Each card: {title?, body?, icon?, value?, color?}.

    cols defaults to len(cards) (single row) capped at 4. Cards are
    rounded panels with a tinted surface and accent top border.
    """
    from .themes import palette_color

    cards = block["cards"]
    cols = int(block.get("cols", min(len(cards), 3)))
    rows = (len(cards) + cols - 1) // cols
    table = doc.add_table(rows=rows, cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _set_table_borders(table, size=0)

    for idx, card in enumerate(cards):
        r, c = divmod(idx, cols)
        cell = table.rows[r].cells[c]
        accent = tuple(card["color"]) if card.get("color") else palette_color(theme, idx)
        bg = _mix_color(accent, (255, 255, 255), 0.92)
        _shade_fill(cell, bg)
        # cell margins + top border
        tcPr = cell._tc.get_or_add_tcPr()
        tcMar = etree.SubElement(tcPr, qn("w:tcMar"))
        for side, val in (("top", 160), ("bottom", 160), ("left", 200), ("right", 200)):
            el = etree.SubElement(tcMar, qn(f"w:{side}"))
            el.set(qn("w:w"), str(val)); el.set(qn("w:type"), "dxa")
        tcBorders = etree.SubElement(tcPr, qn("w:tcBorders"))
        top = etree.SubElement(tcBorders, qn("w:top"))
        top.set(qn("w:val"), "single"); top.set(qn("w:sz"), "20")
        top.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*accent))
        for side in ("left", "bottom", "right"):
            b = etree.SubElement(tcBorders, qn(f"w:{side}"))
            b.set(qn("w:val"), "nil")

        for pp in list(cell.paragraphs):
            cell._tc.remove(pp._p)

        if card.get("icon"):
            ip = cell.add_paragraph()
            ir = ip.add_run(str(card["icon"]))
            _stylize(ir, font=theme.heading_font, size=theme.size_h2,
                     color=accent, bold=True)
        if card.get("value"):
            vp = cell.add_paragraph()
            vr = vp.add_run(str(card["value"]))
            _stylize(vr, font=theme.heading_font, size=theme.size_kpi,
                     color=accent, bold=True)
        if card.get("title"):
            tp = cell.add_paragraph()
            tp.paragraph_format.space_after = Pt(2)
            tr = tp.add_run(str(card["title"]))
            _stylize(tr, font=theme.heading_font, size=theme.size_body,
                     color=theme.heading, bold=True)
        if card.get("body"):
            from .inline import add_inline_runs
            bp = cell.add_paragraph()
            bp.paragraph_format.space_after = Pt(0)
            add_inline_runs(bp, str(card["body"]), theme,
                            font=theme.body_font, size=theme.size_small,
                            color=theme.fg)


def render_drop_cap(doc, block: dict, theme: Theme) -> None:
    """Magazine-style first-letter big paragraph.

    First character gets size_h1 *2, rest of paragraph size_body. Drop
    cap is achieved with ``<w:framePr>`` so subsequent text wraps around
    it, just like Word's UI version.
    """
    text = block["text"]
    if not text:
        return
    first, rest = text[0], text[1:]
    p = doc.add_paragraph()
    pPr = p._p.get_or_add_pPr()
    framePr = etree.SubElement(pPr, qn("w:framePr"))
    framePr.set(qn("w:dropCap"), "drop")
    framePr.set(qn("w:lines"), "3")
    framePr.set(qn("w:wrap"), "around")
    framePr.set(qn("w:vAnchor"), "text")
    framePr.set(qn("w:hAnchor"), "text")
    fr = p.add_run(first)
    _stylize(fr, font=theme.heading_font, size=theme.size_h1 * 2,
             color=theme.accent, bold=True)
    p2 = doc.add_paragraph()
    from .inline import add_inline_runs
    add_inline_runs(p2, rest, theme, font=theme.body_font,
                    size=theme.size_body, color=theme.fg)


# ---------------------------------------------------------------------------
# helpers (cont.)
# ---------------------------------------------------------------------------


def _shade_fill(cell, rgb: tuple[int, int, int]) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        shd = etree.SubElement(tcPr, qn("w:shd"))
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), "{:02X}{:02X}{:02X}".format(*rgb))


def _mix_color(a, b, t: float):
    return (int(a[0] * (1 - t) + b[0] * t),
            int(a[1] * (1 - t) + b[1] * t),
            int(a[2] * (1 - t) + b[2] * t))


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
