"""Inline rich-text parser for paragraph/heading/bullet/cell text.

Markdown-flavored micro-syntax:

  **bold**            bold
  *italic*            italic (also `_italic_`)
  `code`              monospace inline
  [text](url)         hyperlink (works inside body, headers, callouts)
  ~~strike~~          strikethrough
  ==highlight==       theme accent color highlight

The parser lays runs into an existing python-docx paragraph using a
single pass. Unmatched markers stay literal — author error, not a crash.

Use ``add_inline_runs(p, text, theme, **defaults)`` from any renderer
that wants paragraph-level rich text. ``defaults`` are forwarded to
``_style_run`` (font/size/color/bold/italic) so headings keep their
size while still getting bold/italic spans inside.
"""
from __future__ import annotations

import re
from typing import Any

from docx.oxml.ns import qn
from docx.shared import Pt
from lxml import etree


# Token order matters: code is locked first so its inner * and _ aren't
# parsed; links next so brackets aren't mistaken for emphasis; then bold
# (greedy **) before italic (single * / _).
_TOKENS: list[tuple[str, "re.Pattern[str]"]] = [
    ("code",      re.compile(r"`([^`\n]+)`")),
    ("footnote",  re.compile(r"\[\^([^\]\n]+)\]")),
    ("link",      re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")),
    ("bold",      re.compile(r"\*\*([^*\n]+)\*\*")),
    ("strike",    re.compile(r"~~([^~\n]+)~~")),
    ("highlight", re.compile(r"==([^=\n]+)==")),
    ("italic",    re.compile(r"(?<![*\w])\*([^*\n]+)\*(?!\w)")),
    ("italic_u",  re.compile(r"(?<![_\w])_([^_\n]+)_(?!\w)")),
]


def add_inline_runs(p, text: str, theme, **defaults) -> None:
    """Parse ``text`` for inline markdown and append runs to ``p``.

    Defaults are passed straight to ``_style_run`` for the plain-text
    portions; tokens override the relevant fields (bold→bold, code→mono
    font + bg, link→accent + underline).
    """
    spans = _parse(text)
    for kind, payload in spans:
        if kind == "text":
            _add_run(p, payload, theme, **defaults)
        elif kind == "bold":
            _add_run(p, payload, theme, **{**defaults, "bold": True})
        elif kind in ("italic", "italic_u"):
            _add_run(p, payload, theme, **{**defaults, "italic": True})
        elif kind == "code":
            _add_run(p, payload, theme,
                     **{**defaults,
                        "font": theme.mono_font,
                        "size": defaults.get("size", theme.size_body) - 1,
                        "color": theme.fg,
                        "shade": theme.code_bg})
        elif kind == "strike":
            _add_run(p, payload, theme,
                     **{**defaults, "strike": True, "color": theme.muted})
        elif kind == "highlight":
            _add_run(p, payload, theme,
                     **{**defaults, "color": (255, 255, 255),
                        "shade": theme.accent, "bold": True})
        elif kind == "link":
            text_part, url = payload
            _add_hyperlink(p, text_part, url, theme,
                           defaults.get("size", theme.size_body))
        elif kind == "footnote":
            _add_footnote_ref(p, payload, theme,
                              defaults.get("size", theme.size_body))


def _parse(text: str) -> list[tuple[str, Any]]:
    """Greedy single-pass tokenizer. Returns a flat span list."""
    spans: list[tuple[str, Any]] = []
    i = 0
    while i < len(text):
        # find earliest match across all token patterns at or after i
        best: tuple[int, str, "re.Match[str]"] | None = None
        for kind, pat in _TOKENS:
            m = pat.search(text, i)
            if m is None:
                continue
            if best is None or m.start() < best[0]:
                best = (m.start(), kind, m)
        if best is None:
            spans.append(("text", text[i:]))
            break
        start, kind, m = best
        if start > i:
            spans.append(("text", text[i:start]))
        if kind == "link":
            spans.append(("link", (m.group(1), m.group(2))))
        else:
            spans.append((kind, m.group(1)))
        i = m.end()
    return spans


def _add_run(p, text: str, theme, *,
             font: str | None = None,
             size: int | None = None,
             color=None,
             bold: bool = False,
             italic: bool = False,
             strike: bool = False,
             shade=None) -> None:
    if not text:
        return
    run = p.add_run(text)
    _style_run(run, theme,
               font=font or theme.body_font,
               size=size or theme.size_body,
               color=color if color is not None else theme.fg,
               bold=bold, italic=italic,
               strike=strike, shade=shade)


def _style_run(run, theme, *, font: str, size: int, color,
               bold: bool = False, italic: bool = False,
               strike: bool = False, shade=None) -> None:
    """Inline-renderer's mini _style_run. Avoids circular import with renderers."""
    from docx.shared import RGBColor

    run.font.name = font
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    if color is not None:
        run.font.color.rgb = RGBColor(*color)
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = etree.SubElement(rPr, qn("w:rFonts"))
    rFonts.set(qn("w:ascii"), font)
    rFonts.set(qn("w:hAnsi"), font)
    rFonts.set(qn("w:eastAsia"), font)
    rFonts.set(qn("w:cs"), font)
    if strike:
        s = rPr.find(qn("w:strike"))
        if s is None:
            s = etree.SubElement(rPr, qn("w:strike"))
        s.set(qn("w:val"), "true")
    if shade is not None:
        sh = rPr.find(qn("w:shd"))
        if sh is None:
            sh = etree.SubElement(rPr, qn("w:shd"))
        sh.set(qn("w:val"), "clear")
        sh.set(qn("w:color"), "auto")
        sh.set(qn("w:fill"), "{:02X}{:02X}{:02X}".format(*shade))


def _add_footnote_ref(p, body_text: str, theme, size: int) -> None:
    """Add a superscript footnote-reference run and stash the body on
    ``doc._footnotes``. The post-save injector turns each stash entry
    into an actual ``<w:footnote>`` in word/footnotes.xml.
    """
    doc_part = p.part
    doc = doc_part.document if hasattr(doc_part, "document") else None
    # walk up to Document — python-docx exposes part.document only sometimes;
    # easier: read/init the stash on the part itself.
    if not hasattr(doc_part, "_footnotes_stash"):
        doc_part._footnotes_stash = []
    doc_part._footnotes_stash.append({"text": body_text})
    fn_id = len(doc_part._footnotes_stash)  # 1-based to match the part

    run_el = etree.SubElement(p._p, qn("w:r"))
    rPr = etree.SubElement(run_el, qn("w:rPr"))
    rFonts = etree.SubElement(rPr, qn("w:rFonts"))
    for k in ("ascii", "hAnsi", "eastAsia", "cs"):
        rFonts.set(qn(f"w:{k}"), theme.body_font)
    sz = etree.SubElement(rPr, qn("w:sz"))
    sz.set(qn("w:val"), str(max(size - 2, 7) * 2))
    color = etree.SubElement(rPr, qn("w:color"))
    color.set(qn("w:val"), "{:02X}{:02X}{:02X}".format(*theme.accent))
    vert = etree.SubElement(rPr, qn("w:vertAlign"))
    vert.set(qn("w:val"), "superscript")
    fn_ref = etree.SubElement(run_el, qn("w:footnoteReference"))
    fn_ref.set(qn("w:id"), str(fn_id))


def _add_hyperlink(p, text: str, url: str, theme, size: int) -> None:
    """Append a hyperlink run. Adds a part-level relationship and an
    ``<w:hyperlink>`` element wrapping the styled run.
    """
    part = p.part
    r_id = part.relate_to(
        url,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True,
    )
    hlink = etree.SubElement(p._p, qn("w:hyperlink"))
    hlink.set(qn("r:id"), r_id)
    run_el = etree.SubElement(hlink, qn("w:r"))
    rPr = etree.SubElement(run_el, qn("w:rPr"))
    rFonts = etree.SubElement(rPr, qn("w:rFonts"))
    for k in ("ascii", "hAnsi", "eastAsia", "cs"):
        rFonts.set(qn(f"w:{k}"), theme.body_font)
    sz = etree.SubElement(rPr, qn("w:sz"))
    sz.set(qn("w:val"), str(size * 2))
    color = etree.SubElement(rPr, qn("w:color"))
    color.set(qn("w:val"), "{:02X}{:02X}{:02X}".format(*theme.accent))
    u = etree.SubElement(rPr, qn("w:u"))
    u.set(qn("w:val"), "single")
    t = etree.SubElement(run_el, qn("w:t"))
    t.text = text
    t.set(qn("xml:space"), "preserve")
