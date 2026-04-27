"""Inline comment / review annotation support.

A ``comment`` block places a colored review-style annotation in the body
that, on save, is hoisted into ``word/comments.xml`` so it shows up in
Word's review pane. The block is also rendered visibly inline as a
small italic note (so the document is still useful when comments are
hidden).

Block schema:

    {"type": "comment",
     "text": "이 수치는 감사 후 확정",
     "author": "이동윤",
     "initials": "DY",
     "anchor": "ARR $3.4M"}     // optional — text to wrap with comment range

If ``anchor`` is omitted the comment attaches to a tiny inline marker.
"""
from __future__ import annotations

import re
import shutil
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from docx.oxml.ns import qn
from lxml import etree


COMMENTS_REL = ("http://schemas.openxmlformats.org/officeDocument/2006/"
                "relationships/comments")
CT_COMMENTS = ("application/vnd.openxmlformats-officedocument."
               "wordprocessingml.comments+xml")


def render_comment(doc, block: dict, theme) -> None:
    """Place a comment range and visible inline pill. The post-save
    inject_comments() turns the stash into word/comments.xml.
    """
    if not hasattr(doc.part, "_comments_stash"):
        doc.part._comments_stash = []
    cid = len(doc.part._comments_stash)
    doc.part._comments_stash.append({
        "id": cid,
        "text": block["text"],
        "author": block["author"],
        "initials": block.get("initials", block["author"][:2].upper()),
    })

    anchor = block.get("anchor", "🗨")
    p = doc.add_paragraph()
    # rangeStart
    cr_start = etree.SubElement(p._p, qn("w:commentRangeStart"))
    cr_start.set(qn("w:id"), str(cid))
    # visible run
    run = p.add_run(anchor)
    from .renderers import _style_run
    _style_run(run, font=theme.body_font, size=theme.size_body,
               color=theme.fg)
    # rangeEnd
    cr_end = etree.SubElement(p._p, qn("w:commentRangeEnd"))
    cr_end.set(qn("w:id"), str(cid))
    # commentReference run
    ref_run = etree.SubElement(p._p, qn("w:r"))
    ref_rPr = etree.SubElement(ref_run, qn("w:rPr"))
    rstyle = etree.SubElement(ref_rPr, qn("w:rStyle"))
    rstyle.set(qn("w:val"), "CommentReference")
    ref_el = etree.SubElement(ref_run, qn("w:commentReference"))
    ref_el.set(qn("w:id"), str(cid))


def inject(docx_path: str, comments: list, theme) -> None:
    if not comments:
        return
    src = Path(docx_path)
    tmpdir = Path(tempfile.mkdtemp(prefix="docx_cm_"))
    try:
        with zipfile.ZipFile(src, "r") as zin:
            zin.extractall(tmpdir)

        body = "".join(_comment_xml(c, theme) for c in comments)
        comments_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<w:comments xmlns:w="http://schemas.openxmlformats.org/'
            'wordprocessingml/2006/main">\n'
            + body +
            '</w:comments>'
        )
        (tmpdir / "word" / "comments.xml").write_text(comments_xml,
                                                       encoding="utf-8")

        rels_path = tmpdir / "word" / "_rels" / "document.xml.rels"
        rels_text = rels_path.read_text(encoding="utf-8")
        if "comments.xml" not in rels_text:
            rid = _next_rid(rels_text)
            rels_text = rels_text.replace(
                "</Relationships>",
                f'<Relationship Id="{rid}" Type="{COMMENTS_REL}" '
                f'Target="comments.xml"/></Relationships>',
            )
            rels_path.write_text(rels_text, encoding="utf-8")

        ct_path = tmpdir / "[Content_Types].xml"
        ct_text = ct_path.read_text(encoding="utf-8")
        if "/word/comments.xml" not in ct_text:
            ct_text = ct_text.replace(
                "</Types>",
                f'<Override PartName="/word/comments.xml" '
                f'ContentType="{CT_COMMENTS}"/></Types>',
            )
            ct_path.write_text(ct_text, encoding="utf-8")

        out_tmp = src.with_suffix(src.suffix + ".tmp")
        with zipfile.ZipFile(out_tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for f in sorted(tmpdir.rglob("*")):
                if f.is_file():
                    zout.write(f, str(f.relative_to(tmpdir)))
        shutil.move(str(out_tmp), str(src))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _comment_xml(c: dict, theme) -> str:
    safe = (c["text"].replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))
    safe_author = (c["author"].replace("&", "&amp;").replace("<", "&lt;")
                   .replace(">", "&gt;"))
    safe_init = (c["initials"].replace("&", "&amp;").replace("<", "&lt;")
                 .replace(">", "&gt;"))
    when = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        f'  <w:comment w:id="{c["id"]}" w:author="{safe_author}" '
        f'w:date="{when}" w:initials="{safe_init}">'
        f'<w:p><w:r>'
        f'<w:rPr><w:rFonts w:ascii="{theme.body_font}" '
        f'w:hAnsi="{theme.body_font}" w:eastAsia="{theme.body_font}" '
        f'w:cs="{theme.body_font}"/></w:rPr>'
        f'<w:t xml:space="preserve">{safe}</w:t></w:r></w:p>'
        f'</w:comment>\n'
    )


def _next_rid(rels_text: str) -> str:
    nums = [int(m.group(1)) for m in re.finditer(r'Id="rId(\d+)"', rels_text)]
    return f"rId{(max(nums) + 1) if nums else 1}"
