"""PDF page-level operations via pypdf.

Scope is deliberately narrow — PDF edits that don't need a layout engine:
  - merge N PDFs into one
  - split 1 PDF into page ranges
  - extract selected pages
  - rotate pages
  - overlay text or image on every page (watermark style)
  - replace / insert a page from another PDF (useful with spec-rebuild flow)

Anything deeper (editing text inline, moving paragraphs, restyling) is out
of scope — that's the job of `edit_doc.py --via-spec` which regenerates
from the .spec.json.
"""
from __future__ import annotations

import io
import pathlib
from typing import Iterable

from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import RectangleObject


def merge(inputs: list[str], out_path: str) -> int:
    """Concatenate PDFs in given order. Returns the total page count."""
    writer = PdfWriter()
    total = 0
    for path in inputs:
        r = PdfReader(path)
        for page in r.pages:
            writer.add_page(page)
            total += 1
    with open(out_path, "wb") as f:
        writer.write(f)
    return total


def extract_pages(input_path: str, out_path: str, pages: list[int]) -> int:
    """Write a new PDF containing only the 0-indexed `pages` from input, in order."""
    r = PdfReader(input_path)
    writer = PdfWriter()
    for p in pages:
        if not (0 <= p < len(r.pages)):
            raise IndexError(f"page {p} out of range (have {len(r.pages)})")
        writer.add_page(r.pages[p])
    with open(out_path, "wb") as f:
        writer.write(f)
    return len(pages)


def split_by_ranges(input_path: str, out_dir: str, ranges: list[tuple[int, int]]) -> list[str]:
    """For each (start, end) inclusive 0-indexed range, write a separate PDF.
    Returns list of output paths."""
    r = PdfReader(input_path)
    paths: list[str] = []
    out_dir_p = pathlib.Path(out_dir)
    out_dir_p.mkdir(parents=True, exist_ok=True)
    for i, (start, end) in enumerate(ranges):
        writer = PdfWriter()
        for p in range(start, end + 1):
            if not (0 <= p < len(r.pages)):
                raise IndexError(f"page {p} out of range")
            writer.add_page(r.pages[p])
        out_path = out_dir_p / f"split_{i + 1}_{start + 1}-{end + 1}.pdf"
        with open(out_path, "wb") as f:
            writer.write(f)
        paths.append(str(out_path))
    return paths


def rotate(input_path: str, out_path: str, pages: list[int], degrees: int) -> None:
    """Rotate given 0-indexed pages by degrees (must be multiple of 90)."""
    if degrees % 90 != 0:
        raise ValueError("degrees must be a multiple of 90")
    r = PdfReader(input_path)
    writer = PdfWriter()
    target = set(pages)
    for i, page in enumerate(r.pages):
        if i in target:
            page.rotate(degrees)
        writer.add_page(page)
    with open(out_path, "wb") as f:
        writer.write(f)


def overlay_text(input_path: str, out_path: str, *, text: str,
                 pages: Iterable[int] | None = None,
                 x: float = 72, y: float = 72,
                 size: int = 48, color: tuple[float, float, float] = (0.85, 0.1, 0.1),
                 rotation: float = 0, opacity: float = 0.25) -> None:
    """Stamp `text` onto each selected page. Simple watermark helper.
    Uses reportlab to render the stamp, then overlays via pypdf.merge_page.
    """
    from reportlab.lib.colors import Color
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas

    r = PdfReader(input_path)
    target = set(pages) if pages is not None else set(range(len(r.pages)))

    writer = PdfWriter()
    for i, page in enumerate(r.pages):
        if i in target:
            # Build a one-page stamp that matches this page's size
            mediabox: RectangleObject = page.mediabox
            width = float(mediabox.width)
            height = float(mediabox.height)
            buf = io.BytesIO()
            c = rl_canvas.Canvas(buf, pagesize=(width, height))
            c.setFillColor(Color(color[0], color[1], color[2], alpha=opacity))
            c.setFont("Helvetica-Bold", size)
            c.saveState()
            c.translate(x, y)
            c.rotate(rotation)
            c.drawString(0, 0, text)
            c.restoreState()
            c.save()
            buf.seek(0)
            stamp_page = PdfReader(buf).pages[0]
            page.merge_page(stamp_page)
        writer.add_page(page)
    with open(out_path, "wb") as f:
        writer.write(f)


def overlay_image(input_path: str, out_path: str, *, image_path: str,
                  pages: Iterable[int] | None = None,
                  x: float = 36, y: float = 36,
                  width: float = 120, height: float = 40,
                  opacity: float = 1.0) -> None:
    """Stamp an image (logo, seal) onto each selected page."""
    from reportlab.pdfgen import canvas as rl_canvas

    r = PdfReader(input_path)
    target = set(pages) if pages is not None else set(range(len(r.pages)))

    writer = PdfWriter()
    for i, page in enumerate(r.pages):
        if i in target:
            mediabox: RectangleObject = page.mediabox
            w = float(mediabox.width); h = float(mediabox.height)
            buf = io.BytesIO()
            c = rl_canvas.Canvas(buf, pagesize=(w, h))
            if opacity < 1.0:
                c.setFillAlpha(opacity)
            c.drawImage(image_path, x, y, width=width, height=height,
                        mask="auto", preserveAspectRatio=True)
            c.save()
            buf.seek(0)
            stamp = PdfReader(buf).pages[0]
            page.merge_page(stamp)
        writer.add_page(page)
    with open(out_path, "wb") as f:
        writer.write(f)


def count_pages(path: str) -> int:
    return len(PdfReader(path).pages)


def get_metadata(path: str) -> dict:
    r = PdfReader(path)
    meta = r.metadata or {}
    return {
        "title": str(meta.get("/Title", "")) if "/Title" in meta else "",
        "author": str(meta.get("/Author", "")) if "/Author" in meta else "",
        "subject": str(meta.get("/Subject", "")) if "/Subject" in meta else "",
        "producer": str(meta.get("/Producer", "")) if "/Producer" in meta else "",
        "creator": str(meta.get("/Creator", "")) if "/Creator" in meta else "",
    }


def extract_text_per_page(path: str) -> list[str]:
    r = PdfReader(path)
    return [p.extract_text() or "" for p in r.pages]
