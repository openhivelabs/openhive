"""Theme definitions for the pptx skill.

A theme controls colors, fonts, and sizing. Slide renderers pull every visual
decision from the active theme — changing theme should only require swapping
one object, not touching renderer code.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace


RGB = tuple[int, int, int]


@dataclass(frozen=True)
class Theme:
    name: str
    bg: RGB
    fg: RGB               # main body text
    heading: RGB          # headings / titles
    accent: RGB           # hero color (first chart series, title underline, etc)
    accent_soft: RGB      # lighter accent for fills / card headers
    muted: RGB            # captions, muted labels
    subtle_bg: RGB        # card / alt-row backgrounds
    grid: RGB             # thin rules, table lines
    heading_font: str
    body_font: str
    mono_font: str
    # Font sizes in points — the grid assumes 16:9 at 13.33" × 7.5".
    size_title: int = 48
    size_subtitle: int = 22
    size_section: int = 40
    size_slide_title: int = 30
    size_body: int = 18
    size_body_small: int = 14
    size_caption: int = 12
    size_kpi_value: int = 54
    size_kpi_label: int = 14
    # Chart palette — extended with accent variants, used in order.
    chart_series: tuple[RGB, ...] = field(default_factory=tuple)


def _default_chart_palette(accent: RGB) -> tuple[RGB, ...]:
    return (
        accent,
        (80, 80, 80),
        (150, 150, 150),
        (200, 140, 40),
        (60, 120, 170),
        (90, 160, 90),
    )


_DEFAULT = Theme(
    name="default",
    bg=(255, 255, 255),
    fg=(32, 32, 32),
    heading=(20, 20, 20),
    accent=(249, 168, 37),      # OpenHive amber
    accent_soft=(254, 232, 173),
    muted=(120, 120, 120),
    subtle_bg=(248, 248, 246),
    grid=(225, 225, 220),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Menlo",
    chart_series=_default_chart_palette((249, 168, 37)),
)


_DARK = Theme(
    name="dark",
    bg=(22, 22, 22),
    fg=(235, 235, 235),
    heading=(255, 255, 255),
    accent=(249, 168, 37),
    accent_soft=(92, 66, 22),
    muted=(160, 160, 160),
    subtle_bg=(34, 34, 34),
    grid=(60, 60, 60),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Menlo",
    chart_series=_default_chart_palette((249, 168, 37)),
)


_MINIMAL = Theme(
    name="minimal",
    bg=(255, 255, 255),
    fg=(20, 20, 20),
    heading=(0, 0, 0),
    accent=(0, 0, 0),
    accent_soft=(230, 230, 230),
    muted=(140, 140, 140),
    subtle_bg=(250, 250, 250),
    grid=(220, 220, 220),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Menlo",
    chart_series=(
        (0, 0, 0), (100, 100, 100), (170, 170, 170),
        (60, 60, 60), (200, 200, 200), (30, 30, 30),
    ),
)


_CORPORATE = Theme(
    name="corporate",
    bg=(255, 255, 255),
    fg=(30, 40, 55),
    heading=(15, 32, 62),
    accent=(29, 78, 216),       # royal blue
    accent_soft=(219, 234, 254),
    muted=(100, 116, 139),
    subtle_bg=(246, 248, 252),
    grid=(210, 220, 235),
    heading_font="Georgia",
    body_font="Helvetica",
    mono_font="Menlo",
    chart_series=_default_chart_palette((29, 78, 216)),
)


_THEMES: dict[str, Theme] = {
    "default": _DEFAULT,
    "dark": _DARK,
    "minimal": _MINIMAL,
    "corporate": _CORPORATE,
}


def get_theme(name: str | None, overrides: dict | None = None) -> Theme:
    """Resolve a theme by name. Unknown names fall back to 'default'.

    `overrides` is an optional dict whose keys match Theme fields — it lets
    the spec tweak a single color or font without forking a full theme.
    Tuples are coerced from JSON lists to satisfy the frozen-dataclass.
    """
    base = _THEMES.get(name or "default", _DEFAULT)
    if not overrides:
        return base
    clean: dict = {}
    for k, v in overrides.items():
        if k not in base.__dataclass_fields__:
            continue
        if isinstance(v, list) and len(v) == 3 and all(isinstance(x, int) for x in v):
            clean[k] = tuple(v)
        else:
            clean[k] = v
    return replace(base, **clean)


def list_themes() -> list[str]:
    return list(_THEMES.keys())
