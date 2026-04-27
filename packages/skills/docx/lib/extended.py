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


def render_table_of_figures(doc, block: dict, theme: Theme) -> None:
    _emit_field_list(doc, block, theme, instr=' TOC \\h \\z \\c "Figure" ')


def render_table_of_charts(doc, block: dict, theme: Theme) -> None:
    _emit_field_list(doc, block, theme, instr=' TOC \\h \\z \\c "Chart" ')


def render_table_of_tables(doc, block: dict, theme: Theme) -> None:
    _emit_field_list(doc, block, theme, instr=' TOC \\h \\z \\c "Table" ')


def _emit_field_list(doc, block, theme, *, instr) -> None:
    title = block.get("title")
    if title:
        tp = doc.add_paragraph()
        tp.paragraph_format.space_after = Pt(4)
        tr = tp.add_run(title)
        _stylize(tr, font=theme.heading_font, size=theme.size_h2,
                 color=theme.heading, bold=True)
    p = doc.add_paragraph()
    run = p.add_run()
    fld = etree.SubElement(run._r, qn("w:fldChar"))
    fld.set(qn("w:fldCharType"), "begin"); fld.set(qn("w:dirty"), "true")
    instr_run = p.add_run()
    it = etree.SubElement(instr_run._r, qn("w:instrText"))
    it.text = instr; it.set(qn("xml:space"), "preserve")
    sep_run = p.add_run()
    sep = etree.SubElement(sep_run._r, qn("w:fldChar"))
    sep.set(qn("w:fldCharType"), "separate")
    placeholder_run = p.add_run("Updating list…")
    _stylize(placeholder_run, font=theme.body_font, size=theme.size_small,
             color=theme.muted, italic=True)
    end_run = p.add_run()
    end = etree.SubElement(end_run._r, qn("w:fldChar"))
    end.set(qn("w:fldCharType"), "end")


def render_gantt(doc, block: dict, theme: Theme) -> None:
    """Gantt-style task timeline. Each task: {label, start, end, color?}.

    Times are positioned by token order (not real dates) — i.e. ``start``
    and ``end`` are integer column indices into ``periods``. Renders as a
    table with the label column on the left and a band of cells, the
    occupied range filled with the task color.
    """
    from .themes import palette_color

    periods = block.get("periods") or []
    if not periods:
        # auto-derive from tasks' start/end max
        tasks = block["tasks"]
        max_end = max(int(t.get("end", t.get("start", 0))) for t in tasks)
        periods = [f"{i+1}" for i in range(max_end + 1)]

    tasks = block["tasks"]
    n_cols = 1 + len(periods)
    table = doc.add_table(rows=1 + len(tasks), cols=n_cols)
    _set_table_borders(table, size=2, color="DDDDDD")
    label_w = Inches(1.6)
    period_w = Inches(min(4.6, 4.6 / len(periods))) if periods else Inches(0.3)
    _set_col_widths(table, [label_w] + [period_w] * len(periods))

    # header
    hdr = table.rows[0]
    hcell = hdr.cells[0]
    for pp in list(hcell.paragraphs):
        hcell._tc.remove(pp._p)
    hp = hcell.add_paragraph()
    hr = hp.add_run("Task")
    _stylize(hr, font=theme.heading_font, size=theme.size_small,
             color=theme.heading, bold=True)
    for j, period in enumerate(periods):
        c = hdr.cells[1 + j]
        for pp in list(c.paragraphs):
            c._tc.remove(pp._p)
        hp = c.add_paragraph()
        hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        hr = hp.add_run(str(period))
        _stylize(hr, font=theme.heading_font, size=theme.size_small,
                 color=theme.muted, bold=True)

    for ti, task in enumerate(tasks):
        row = table.rows[1 + ti]
        # label
        lc = row.cells[0]
        for pp in list(lc.paragraphs):
            lc._tc.remove(pp._p)
        lp = lc.add_paragraph()
        lr = lp.add_run(str(task["label"]))
        _stylize(lr, font=theme.body_font, size=theme.size_body,
                 color=theme.fg, bold=False)
        start = int(task.get("start", 0))
        end = int(task.get("end", start))
        color = tuple(task["color"]) if task.get("color") else palette_color(theme, ti)
        for j in range(len(periods)):
            cc = row.cells[1 + j]
            for pp in list(cc.paragraphs):
                cc._tc.remove(pp._p)
            cp = cc.add_paragraph()
            cp.add_run(" ")
            if start <= j <= end:
                _shade_fill(cc, color)


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


def render_faq(doc, block: dict, theme: Theme) -> None:
    """Q/A list. Each item gets a bold question with accent prefix and an
    inline-rich answer paragraph below."""
    from .inline import add_inline_runs

    for i, item in enumerate(block["items"]):
        qp = doc.add_paragraph()
        qp.paragraph_format.space_before = Pt(6)
        qp.paragraph_format.space_after = Pt(2)
        qr = qp.add_run("Q. ")
        _stylize(qr, font=theme.heading_font, size=theme.size_body,
                 color=theme.accent, bold=True)
        qr2 = qp.add_run(str(item["q"]))
        _stylize(qr2, font=theme.heading_font, size=theme.size_body,
                 color=theme.heading, bold=True)

        ap = doc.add_paragraph()
        ap.paragraph_format.left_indent = Inches(0.25)
        ap.paragraph_format.space_after = Pt(4)
        ar = ap.add_run("A. ")
        _stylize(ar, font=theme.body_font, size=theme.size_body,
                 color=theme.muted, bold=True)
        # rest as inline rich text
        add_inline_runs(ap, str(item["a"]), theme,
                        font=theme.body_font, size=theme.size_body,
                        color=theme.fg)


def render_pricing_table(doc, block: dict, theme: Theme) -> None:
    """Side-by-side plan comparison. Each plan: {name, price, period?,
    features (list), cta?, highlight?}. Highlighted plan gets the accent
    color top band.
    """
    from .themes import palette_color

    plans = block["plans"]
    n = len(plans)
    table = doc.add_table(rows=1, cols=n)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _set_table_borders(table, size=4, color="DDDDDD")

    for j, plan in enumerate(plans):
        cell = table.rows[0].cells[j]
        accent = (palette_color(theme, j) if not plan.get("highlight")
                  else theme.accent)
        bg = _mix_color(accent, (255, 255, 255),
                        0.92 if not plan.get("highlight") else 0.75)
        _shade_fill(cell, bg)
        # cell padding + top band
        tcPr = cell._tc.get_or_add_tcPr()
        tcMar = etree.SubElement(tcPr, qn("w:tcMar"))
        for side, val in (("top", 200), ("bottom", 200),
                          ("left", 200), ("right", 200)):
            el = etree.SubElement(tcMar, qn(f"w:{side}"))
            el.set(qn("w:w"), str(val)); el.set(qn("w:type"), "dxa")
        tcBorders = etree.SubElement(tcPr, qn("w:tcBorders"))
        top = etree.SubElement(tcBorders, qn("w:top"))
        top.set(qn("w:val"), "single")
        top.set(qn("w:sz"), "32" if plan.get("highlight") else "16")
        top.set(qn("w:color"), "{:02X}{:02X}{:02X}".format(*accent))

        for pp in list(cell.paragraphs):
            cell._tc.remove(pp._p)

        np = cell.add_paragraph()
        np.alignment = WD_ALIGN_PARAGRAPH.CENTER
        np.paragraph_format.space_after = Pt(2)
        nr = np.add_run(str(plan["name"]).upper())
        _stylize(nr, font=theme.heading_font, size=theme.size_small,
                 color=theme.muted, bold=True)

        if plan.get("price"):
            pp = cell.add_paragraph()
            pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pp.paragraph_format.space_after = Pt(2)
            pr = pp.add_run(str(plan["price"]))
            _stylize(pr, font=theme.heading_font, size=theme.size_kpi,
                     color=accent, bold=True)
            if plan.get("period"):
                pr2 = pp.add_run(f" / {plan['period']}")
                _stylize(pr2, font=theme.body_font, size=theme.size_small,
                         color=theme.muted)

        for feat in plan.get("features", []) or []:
            fp = cell.add_paragraph()
            fp.paragraph_format.space_after = Pt(2)
            ic = fp.add_run("✓ ")
            _stylize(ic, font=theme.heading_font, size=theme.size_body,
                     color=accent, bold=True)
            from .inline import add_inline_runs
            add_inline_runs(fp, str(feat), theme,
                            font=theme.body_font, size=theme.size_small,
                            color=theme.fg)

        if plan.get("cta"):
            cp = cell.add_paragraph()
            cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cp.paragraph_format.space_before = Pt(8)
            cp.paragraph_format.space_after = Pt(0)
            cr = cp.add_run(f" {plan['cta']} ")
            _stylize(cr, font=theme.heading_font, size=theme.size_small,
                     color=(255, 255, 255), bold=True)
            # shaded run = button
            from .inline import _style_run as _sr
            _sr(cr, theme, font=theme.heading_font,
                size=theme.size_small, color=(255, 255, 255),
                bold=True, shade=accent)


def render_author(doc, block: dict, theme: Theme) -> None:
    """Author bio block: avatar (optional) + name / title / bio."""
    from .renderers import _resolve_image

    avatar = block.get("avatar")
    if avatar:
        table = doc.add_table(rows=1, cols=2)
        _set_table_borders(table, size=0)
        _set_col_widths(table, [Inches(1.2), Inches(5.0)])
        avatar_cell = table.rows[0].cells[0]
        for pp in list(avatar_cell.paragraphs):
            avatar_cell._tc.remove(pp._p)
        ap = avatar_cell.add_paragraph()
        run = ap.add_run()
        run.add_picture(_resolve_image(avatar), width=Inches(1.0))
        text_cell = table.rows[0].cells[1]
        for pp in list(text_cell.paragraphs):
            text_cell._tc.remove(pp._p)
        target = text_cell
    else:
        target = doc

    name_p = target.add_paragraph()
    name_p.paragraph_format.space_after = Pt(2)
    nr = name_p.add_run(str(block["name"]))
    _stylize(nr, font=theme.heading_font, size=theme.size_h3,
             color=theme.heading, bold=True)
    if block.get("title"):
        tp = target.add_paragraph()
        tp.paragraph_format.space_after = Pt(4)
        tr = tp.add_run(str(block["title"]))
        _stylize(tr, font=theme.body_font, size=theme.size_small,
                 color=theme.muted, italic=True)
    if block.get("bio"):
        from .inline import add_inline_runs
        bp = target.add_paragraph()
        add_inline_runs(bp, str(block["bio"]), theme,
                        font=theme.body_font, size=theme.size_body,
                        color=theme.fg)


def render_step_list(doc, block: dict, theme: Theme) -> None:
    """Numbered process steps with circled numbers + arrow connectors."""
    from .themes import palette_color

    steps = block["steps"]
    for i, step in enumerate(steps):
        outer = doc.add_table(rows=1, cols=2)
        outer.alignment = WD_TABLE_ALIGNMENT.LEFT
        _set_table_borders(outer, size=0)
        _set_col_widths(outer, [Inches(0.6), Inches(5.7)])

        # numbered badge
        nc = outer.rows[0].cells[0]
        for pp in list(nc.paragraphs):
            nc._tc.remove(pp._p)
        accent = palette_color(theme, i)
        np = nc.add_paragraph()
        np.alignment = WD_ALIGN_PARAGRAPH.CENTER
        nr = np.add_run(f" {i + 1} ")
        from .inline import _style_run as _sr
        _sr(nr, theme, font=theme.heading_font,
            size=theme.size_h3, color=(255, 255, 255),
            bold=True, shade=accent)

        # content
        tc = outer.rows[0].cells[1]
        for pp in list(tc.paragraphs):
            tc._tc.remove(pp._p)
        if isinstance(step, str):
            title, body = step, None
        else:
            title = step.get("title", "")
            body = step.get("body")
        tp = tc.add_paragraph()
        tp.paragraph_format.space_after = Pt(2)
        tr = tp.add_run(str(title))
        _stylize(tr, font=theme.heading_font, size=theme.size_body,
                 color=theme.heading, bold=True)
        if body:
            from .inline import add_inline_runs
            bp = tc.add_paragraph()
            bp.paragraph_format.space_after = Pt(2)
            add_inline_runs(bp, str(body), theme,
                            font=theme.body_font, size=theme.size_body,
                            color=theme.fg)


def render_code_diff(doc, block: dict, theme: Theme) -> None:
    """Diff-aware code block. Lines starting with ``+`` get a green tint,
    ``-`` red tint, ``~`` a yellow tint. Other lines plain.
    """
    table = doc.add_table(rows=1, cols=1)
    cell = table.rows[0].cells[0]
    _shade_fill(cell, theme.code_bg)
    tc_pr = cell._tc.get_or_add_tcPr()
    tcBorders = etree.SubElement(tc_pr, qn("w:tcBorders"))
    for side in ("top", "left", "bottom", "right"):
        b = etree.SubElement(tcBorders, qn(f"w:{side}"))
        b.set(qn("w:val"), "single"); b.set(qn("w:sz"), "2")
        b.set(qn("w:color"), "CCCCCC")

    for pg in list(cell.paragraphs):
        cell._tc.remove(pg._p)
    lines = block["text"].split("\n")
    for line in lines:
        p = cell.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        if line.startswith("+"):
            tint = (220, 252, 231); fg = (5, 150, 105)
        elif line.startswith("-"):
            tint = (254, 226, 226); fg = (220, 38, 38)
        elif line.startswith("~"):
            tint = (254, 249, 195); fg = (180, 83, 9)
        else:
            tint = None; fg = theme.fg
        run = p.add_run(line or " ")
        from .inline import _style_run as _sr
        _sr(run, theme, font=theme.mono_font, size=theme.size_code,
            color=fg, bold=False, shade=tint)


def render_bibliography(doc, block: dict, theme: Theme) -> None:
    """Numbered bibliography. Each item is a string or dict with
    {author, title, source, year, url}.
    """
    title = block.get("title")
    if title:
        tp = doc.add_paragraph()
        tp.paragraph_format.space_after = Pt(4)
        tr = tp.add_run(title)
        _stylize(tr, font=theme.heading_font, size=theme.size_h2,
                 color=theme.heading, bold=True)
    for i, item in enumerate(block["items"], start=1):
        ip = doc.add_paragraph()
        ip.paragraph_format.left_indent = Inches(0.3)
        ip.paragraph_format.first_line_indent = Inches(-0.3)
        ip.paragraph_format.space_after = Pt(4)
        nr = ip.add_run(f"[{i}] ")
        _stylize(nr, font=theme.body_font, size=theme.size_body,
                 color=theme.accent, bold=True)
        if isinstance(item, str):
            tr = ip.add_run(item)
            _stylize(tr, font=theme.body_font, size=theme.size_body,
                     color=theme.fg)
        else:
            if item.get("author"):
                tr = ip.add_run(f"{item['author']}. ")
                _stylize(tr, font=theme.body_font, size=theme.size_body,
                         color=theme.fg)
            if item.get("title"):
                tr = ip.add_run(f"{item['title']}. ")
                _stylize(tr, font=theme.body_font, size=theme.size_body,
                         color=theme.fg, italic=True)
            if item.get("source"):
                tr = ip.add_run(f"{item['source']}")
                _stylize(tr, font=theme.body_font, size=theme.size_body,
                         color=theme.fg)
            if item.get("year"):
                tr = ip.add_run(f" ({item['year']})")
                _stylize(tr, font=theme.body_font, size=theme.size_body,
                         color=theme.muted)
            if item.get("url"):
                ip.add_run(". ")
                from .inline import _add_hyperlink
                _add_hyperlink(ip, item["url"], item["url"], theme,
                               theme.size_small)


def render_qr_code(doc, block: dict, theme: Theme) -> None:
    """Generate a QR PNG and embed it. ``data`` = URL or text payload."""
    import hashlib
    import pathlib
    import tempfile
    try:
        import qrcode
    except ImportError:
        # silently skip if lib missing
        return

    data = str(block["data"])
    h = hashlib.sha1(data.encode()).hexdigest()[:16]
    out = pathlib.Path(tempfile.gettempdir()) / f"docx_qr_{h}.png"
    if not out.exists():
        img = qrcode.make(data)
        img.save(str(out))
    p = doc.add_paragraph()
    align = block.get("align", "center")
    if align == "center":
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif align == "right":
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = p.add_run()
    width = float(block.get("width_in", 1.5))
    run.add_picture(str(out), width=Inches(width))
    if block.get("caption"):
        cp = doc.add_paragraph()
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cr = cp.add_run(block["caption"])
        _stylize(cr, font=theme.body_font, size=theme.size_small,
                 color=theme.muted, italic=True)


def render_stat_list(doc, block: dict, theme: Theme) -> None:
    """Inline horizontal stat row — "$3.4M ARR · 112% NRR · 186 logos".
    Smaller / denser than kpi_row, intended for body context.
    """
    from .themes import palette_color

    stats = block["stats"]
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER if block.get("center") else WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(6)
    for i, s in enumerate(stats):
        if i > 0:
            sep = p.add_run("   ·   ")
            _stylize(sep, font=theme.body_font, size=theme.size_body,
                     color=theme.muted)
        accent = palette_color(theme, i)
        vr = p.add_run(str(s.get("value", "")))
        _stylize(vr, font=theme.heading_font, size=theme.size_h3,
                 color=accent, bold=True)
        if s.get("label"):
            lr = p.add_run(f" {s['label']}")
            _stylize(lr, font=theme.body_font, size=theme.size_body,
                     color=theme.muted)


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
