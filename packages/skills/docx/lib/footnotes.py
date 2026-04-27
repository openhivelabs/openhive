"""Footnote support for the DOCX skill.

Inline syntax inside any paragraph that goes through ``inline.add_inline_runs``:

    "이 수치는 [^감사 전 잠정치] 입니다."

The bracketed text becomes the footnote body. The skill auto-numbers
footnotes (1, 2, 3 ...) and writes them to ``word/footnotes.xml``.

Implementation:
- We need a footnotes part if any footnote exists. python-docx doesn't
  expose footnotes natively, so we patch the docx package post-save:
    1. Renderers stash footnotes on ``doc._footnotes`` during render
    2. After save, ``inject_footnotes`` adds:
       - ``word/footnotes.xml`` with one ``<w:footnote>`` per stash entry
       - ``[Content_Types].xml`` Override for footnotes part
       - ``word/_rels/document.xml.rels`` relationship
    3. The inline parser writes the footnote reference run with a
       placeholder ``id`` that matches the index. We resolve it during
       inject by leaving the id as-is (we control both sides).
"""
from __future__ import annotations

import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any


FOOTNOTES_REL_TYPE = ("http://schemas.openxmlformats.org/officeDocument/"
                      "2006/relationships/footnotes")
CT_FOOTNOTES = ("application/vnd.openxmlformats-officedocument."
                "wordprocessingml.footnotes+xml")


def inject(docx_path: str, footnotes: list[dict], theme) -> None:
    """Add a footnotes.xml part with one entry per ``footnotes`` stash item."""
    if not footnotes:
        return

    src = Path(docx_path)
    tmpdir = Path(tempfile.mkdtemp(prefix="docx_footnotes_"))
    try:
        with zipfile.ZipFile(src, "r") as zin:
            zin.extractall(tmpdir)

        # 1. Build word/footnotes.xml. The required "separator" and
        #    "continuationSeparator" entries (id=-1, 0) come first; user
        #    footnotes start at id=1.
        body = []
        for i, fn in enumerate(footnotes, start=1):
            body.append(_footnote_xml(i, fn["text"], theme))
        footnotes_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'
            '  <w:footnote w:type="separator" w:id="-1">'
            '<w:p><w:r><w:separator/></w:r></w:p></w:footnote>\n'
            '  <w:footnote w:type="continuationSeparator" w:id="0">'
            '<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>\n'
            + "".join(body)
            + '\n</w:footnotes>'
        )
        (tmpdir / "word" / "footnotes.xml").write_text(footnotes_xml, encoding="utf-8")

        # 2. document.xml.rels — add footnotes relationship
        rels_path = tmpdir / "word" / "_rels" / "document.xml.rels"
        rels_text = rels_path.read_text(encoding="utf-8")
        if 'Target="footnotes.xml"' not in rels_text:
            rid = _next_rid(rels_text)
            rels_text = rels_text.replace(
                "</Relationships>",
                f'<Relationship Id="{rid}" Type="{FOOTNOTES_REL_TYPE}" '
                f'Target="footnotes.xml"/></Relationships>',
            )
            rels_path.write_text(rels_text, encoding="utf-8")

        # 3. ContentTypes
        ct_path = tmpdir / "[Content_Types].xml"
        ct_text = ct_path.read_text(encoding="utf-8")
        if "/word/footnotes.xml" not in ct_text:
            ct_text = ct_text.replace(
                "</Types>",
                f'<Override PartName="/word/footnotes.xml" '
                f'ContentType="{CT_FOOTNOTES}"/></Types>',
            )
            ct_path.write_text(ct_text, encoding="utf-8")

        # 4. Repack
        out_tmp = src.with_suffix(src.suffix + ".tmp")
        with zipfile.ZipFile(out_tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for f in sorted(tmpdir.rglob("*")):
                if f.is_file():
                    arcname = str(f.relative_to(tmpdir))
                    zout.write(f, arcname)
        shutil.move(str(out_tmp), str(src))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _footnote_xml(idx: int, text: str, theme) -> str:
    body_color = "{:02X}{:02X}{:02X}".format(*theme.fg)
    safe = (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))
    return (
        f'  <w:footnote w:id="{idx}">'
        f'<w:p>'
        f'  <w:pPr><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr></w:pPr>'
        f'  <w:r><w:rPr><w:rStyle w:val="FootnoteReference"/>'
        f'    <w:rFonts w:ascii="{theme.body_font}" w:hAnsi="{theme.body_font}" '
        f'      w:eastAsia="{theme.body_font}" w:cs="{theme.body_font}"/>'
        f'    <w:vertAlign w:val="superscript"/>'
        f'    <w:sz w:val="{theme.size_small * 2}"/>'
        f'    <w:color w:val="{body_color}"/>'
        f'  </w:rPr><w:footnoteRef/></w:r>'
        f'  <w:r><w:rPr>'
        f'    <w:rFonts w:ascii="{theme.body_font}" w:hAnsi="{theme.body_font}" '
        f'      w:eastAsia="{theme.body_font}" w:cs="{theme.body_font}"/>'
        f'    <w:sz w:val="{theme.size_small * 2}"/>'
        f'    <w:color w:val="{body_color}"/>'
        f'  </w:rPr><w:t xml:space="preserve"> {safe}</w:t></w:r>'
        f'</w:p>'
        f'</w:footnote>'
    )


def _next_rid(rels_text: str) -> str:
    nums = [int(m.group(1)) for m in re.finditer(r'Id="rId(\d+)"', rels_text)]
    return f"rId{(max(nums) + 1) if nums else 1}"
