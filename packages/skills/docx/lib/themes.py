"""DOCX theme definitions.

A theme controls fonts, sizes, accent colours, and a multi-color palette
used by charts, KPI rows, callouts, and zebra-striped tables. Each renderer
asks the theme for fonts/sizes/palette — nothing is hardcoded.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace


RGB = tuple[int, int, int]


@dataclass(frozen=True)
class Theme:
    name: str
    # colours
    fg: RGB                     # body text
    heading: RGB                # headings
    accent: RGB                 # links, rules, table header fill
    muted: RGB                  # captions, quote attribution
    code_bg: RGB                # code block background
    # multi-color palette (charts, KPIs, callouts). 6 stops min recommended.
    palette: tuple[RGB, ...] = ()
    # semantic status colors (callouts, deltas, progress fills)
    info: RGB = (37, 99, 235)
    success: RGB = (22, 163, 74)
    warning: RGB = (217, 119, 6)
    danger: RGB = (220, 38, 38)
    # cover-page band & subtle surface fills
    surface: RGB = (245, 247, 250)
    band: RGB = (15, 32, 62)
    # fonts
    heading_font: str = "Helvetica"
    body_font: str = "Helvetica"
    mono_font: str = "Menlo"
    # sizes in points
    size_title: int = 36
    size_subtitle: int = 16
    size_h1: int = 22
    size_h2: int = 18
    size_h3: int = 15
    size_h4: int = 13
    size_h5: int = 12
    size_h6: int = 11
    size_body: int = 11
    size_small: int = 9
    size_code: int = 10
    size_kpi: int = 26
    size_kpi_label: int = 9
    # margins (inches)
    margin_top: float = 1.0
    margin_bottom: float = 1.0
    margin_left: float = 1.0
    margin_right: float = 1.0


# Curated palettes — designed for distinct hues at small sizes (charts, KPI tiles).
_PALETTE_DEFAULT: tuple[RGB, ...] = (
    (37, 99, 235),    # blue
    (217, 119, 6),    # amber
    (22, 163, 74),    # green
    (220, 38, 38),    # red
    (139, 92, 246),   # violet
    (14, 165, 233),   # cyan
)

_PALETTE_FORMAL: tuple[RGB, ...] = (
    (29, 78, 216),
    (15, 118, 110),
    (180, 83, 9),
    (124, 58, 237),
    (4, 120, 87),
    (159, 18, 57),
)

_PALETTE_REPORT: tuple[RGB, ...] = (
    (13, 90, 99),     # deep teal (primary brand)
    (217, 119, 6),    # amber accent
    (220, 38, 38),    # red flag
    (5, 150, 105),    # emerald
    (109, 40, 217),   # purple
    (37, 99, 235),    # blue
)

_PALETTE_MINIMAL: tuple[RGB, ...] = (
    (17, 17, 17),
    (102, 102, 102),
    (153, 153, 153),
    (200, 200, 200),
    (37, 99, 235),
    (220, 38, 38),
)


_DEFAULT = Theme(
    name="default",
    fg=(32, 32, 32),
    heading=(20, 20, 20),
    accent=(37, 99, 235),
    muted=(120, 120, 120),
    code_bg=(245, 245, 245),
    palette=_PALETTE_DEFAULT,
    surface=(244, 246, 251),
    band=(20, 30, 60),
)

_FORMAL = Theme(
    name="formal",
    fg=(20, 20, 20),
    heading=(10, 10, 10),
    accent=(29, 78, 216),
    muted=(100, 116, 139),
    code_bg=(246, 248, 252),
    palette=_PALETTE_FORMAL,
    surface=(244, 247, 252),
    band=(15, 23, 42),
    heading_font="Georgia",
    body_font="Georgia",
    size_title=38, size_h1=26, size_h2=20, size_h3=16,
)

_REPORT = Theme(
    name="report",
    fg=(30, 30, 30),
    heading=(15, 32, 62),
    accent=(13, 90, 99),
    muted=(110, 110, 110),
    code_bg=(250, 250, 245),
    palette=_PALETTE_REPORT,
    surface=(240, 245, 246),
    band=(13, 90, 99),
    heading_font="Helvetica",
    body_font="Georgia",
    size_body=12, size_h1=24, size_h2=18,
)

_MINIMAL = Theme(
    name="minimal",
    fg=(20, 20, 20),
    heading=(0, 0, 0),
    accent=(0, 0, 0),
    muted=(140, 140, 140),
    code_bg=(248, 248, 248),
    palette=_PALETTE_MINIMAL,
    surface=(248, 248, 248),
    band=(17, 17, 17),
)


_THEMES: dict[str, Theme] = {
    "default": _DEFAULT,
    "formal": _FORMAL,
    "report": _REPORT,
    "minimal": _MINIMAL,
}


def get_theme(name: str | None, overrides: dict | None = None) -> Theme:
    base = _THEMES.get(name or "default", _DEFAULT)
    if not overrides:
        return base
    clean: dict = {}
    for k, v in overrides.items():
        if k not in base.__dataclass_fields__:
            continue
        if k == "palette" and isinstance(v, list):
            clean[k] = tuple(
                tuple(c) for c in v
                if isinstance(c, list) and len(c) == 3
            )
            continue
        if isinstance(v, list) and len(v) == 3 and all(isinstance(x, int) for x in v):
            clean[k] = tuple(v)
        else:
            clean[k] = v
    return replace(base, **clean)


def list_themes() -> list[str]:
    return list(_THEMES.keys())


def palette_color(theme: Theme, idx: int) -> RGB:
    """Cycle through the theme palette. Falls back to accent if empty."""
    if theme.palette:
        return theme.palette[idx % len(theme.palette)]
    return theme.accent
