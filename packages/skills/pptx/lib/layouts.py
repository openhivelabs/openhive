"""Slide geometry & grid math.

Centralises every "where does this box go on the slide" decision. Renderers
ask the Grid for rectangles — they never hard-code inches.
"""
from __future__ import annotations

from dataclasses import dataclass

from pptx.util import Inches


# slide dimensions in inches, (width, height)
SIZES: dict[str, tuple[float, float]] = {
    "16:9": (13.333, 7.5),
    "4:3": (10.0, 7.5),
    "a4": (11.69, 8.27),
}


@dataclass(frozen=True)
class Rect:
    """Rectangle in inches. Converted to EMU with `.emu()` when placing shapes."""
    x: float
    y: float
    w: float
    h: float

    def emu(self):
        return Inches(self.x), Inches(self.y), Inches(self.w), Inches(self.h)

    def inset(self, dx: float, dy: float | None = None) -> "Rect":
        dy = dx if dy is None else dy
        return Rect(self.x + dx, self.y + dy, max(0, self.w - 2 * dx), max(0, self.h - 2 * dy))


class Grid:
    """Computes slide regions for a given slide size + margin.

    All sizes in inches. The content area is always the full slide minus the
    outer margin. Title bands, split columns, etc. are derived from that.
    """

    def __init__(self, size: str = "16:9", margin: float = 0.55):
        if size not in SIZES:
            size = "16:9"
        self.w, self.h = SIZES[size]
        self.size = size
        self.m = margin

    # -- primary regions -----------------------------------------------------

    def full(self) -> Rect:
        return Rect(0, 0, self.w, self.h)

    def full_content(self) -> Rect:
        return Rect(self.m, self.m, self.w - 2 * self.m, self.h - 2 * self.m)

    def title_band(self, height: float = 1.0) -> Rect:
        return Rect(self.m, self.m, self.w - 2 * self.m, height)

    def content_below_title(self, title_height: float = 1.0, top_gap: float = 0.25) -> Rect:
        top = self.m + title_height + top_gap
        return Rect(self.m, top, self.w - 2 * self.m, self.h - top - self.m)

    def footer_strip(self, height: float = 0.3) -> Rect:
        return Rect(self.m, self.h - self.m - height, self.w - 2 * self.m, height)

    # -- split layouts -------------------------------------------------------

    def columns(self, parent: Rect, n: int, gap: float = 0.3) -> list[Rect]:
        total_gap = gap * max(0, n - 1)
        col_w = (parent.w - total_gap) / n
        return [Rect(parent.x + i * (col_w + gap), parent.y, col_w, parent.h) for i in range(n)]

    def rows(self, parent: Rect, n: int, gap: float = 0.2) -> list[Rect]:
        total_gap = gap * max(0, n - 1)
        row_h = (parent.h - total_gap) / n
        return [Rect(parent.x, parent.y + i * (row_h + gap), parent.w, row_h) for i in range(n)]

    def split_horizontal(self, parent: Rect, ratio: float = 0.5, gap: float = 0.3) -> tuple[Rect, Rect]:
        left_w = (parent.w - gap) * ratio
        right_w = parent.w - gap - left_w
        left = Rect(parent.x, parent.y, left_w, parent.h)
        right = Rect(parent.x + left_w + gap, parent.y, right_w, parent.h)
        return left, right
