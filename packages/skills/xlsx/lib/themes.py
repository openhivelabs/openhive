"""Theme definitions for the xlsx skill.

A theme controls colors, fonts, and named cell styles. Renderers pull every
visual decision from the active theme — changing theme should only require
swapping one object, not touching renderer code.

Excel's theme model is its own beast (clr scheme + fontScheme + format
scheme), but for skill output we work in a higher-level abstraction:
a small palette + a set of named cell styles (header / total / muted /
input / output) that the renderer maps onto openpyxl Font/PatternFill/Border.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace


RGB = tuple[int, int, int]


def rgb_hex(c: RGB) -> str:
    return "{:02X}{:02X}{:02X}".format(*c)


@dataclass(frozen=True)
class CellStyle:
    """A named, theme-aware cell style. All fields optional — None means
    'inherit / leave alone'. Renderer composes openpyxl Font/Fill/Alignment
    from these.
    """
    font_name: str | None = None
    font_size: float | None = None
    font_color: RGB | None = None
    bold: bool | None = None
    italic: bool | None = None
    fill: RGB | None = None              # solid background
    align_h: str | None = None           # left | center | right
    align_v: str | None = None           # top | center | bottom
    number_format: str | None = None
    border: bool = False                 # thin all-around when True
    border_color: RGB | None = None
    wrap_text: bool | None = None


@dataclass(frozen=True)
class Theme:
    name: str
    bg: RGB
    fg: RGB
    accent: RGB                # hero colour — chart series 1, header fill
    accent_soft: RGB
    muted: RGB
    grid: RGB
    body_font: str
    heading_font: str
    mono_font: str
    # Default chart palette — used when a chart doesn't pin colours.
    chart_series: tuple[RGB, ...] = field(default_factory=tuple)
    # Named cell styles. Renderer + patch DSL look these up by name so the
    # spec can say {"style": "header"} instead of repeating the formatting.
    styles: dict[str, CellStyle] = field(default_factory=dict)


def _default_chart_palette(accent: RGB) -> tuple[RGB, ...]:
    return (
        accent,
        (80, 80, 80),
        (200, 140, 40),
        (60, 120, 170),
        (90, 160, 90),
        (170, 90, 130),
    )


def _build_styles(accent: RGB, accent_soft: RGB, fg: RGB, muted: RGB,
                  body_font: str) -> dict[str, CellStyle]:
    return {
        "header": CellStyle(
            font_name=body_font, font_size=11, font_color=(255, 255, 255),
            bold=True, fill=accent, align_h="left", align_v="center",
            border=True, border_color=accent,
        ),
        "subheader": CellStyle(
            font_name=body_font, font_size=11, font_color=fg,
            bold=True, fill=accent_soft, align_h="left", align_v="center",
        ),
        "total": CellStyle(
            font_name=body_font, font_size=11, font_color=fg,
            bold=True, fill=(245, 245, 245), align_h="right",
            border=True, border_color=(180, 180, 180),
        ),
        "muted": CellStyle(
            font_name=body_font, font_size=10, font_color=muted, italic=True,
        ),
        "input": CellStyle(
            font_name=body_font, font_size=10, font_color=(0, 80, 200),
            fill=(240, 246, 255),
        ),
        "output": CellStyle(
            font_name=body_font, font_size=10, font_color=fg, bold=True,
        ),
        "currency": CellStyle(number_format='"$"#,##0.00'),
        "percent":  CellStyle(number_format="0.0%"),
        "integer":  CellStyle(number_format="#,##0"),
        "date":     CellStyle(number_format="yyyy-mm-dd"),
    }


def _make(name: str, *, bg, fg, accent, accent_soft, muted, grid,
          body_font="Calibri", heading_font="Calibri",
          mono_font="Consolas") -> Theme:
    return Theme(
        name=name, bg=bg, fg=fg, accent=accent, accent_soft=accent_soft,
        muted=muted, grid=grid,
        body_font=body_font, heading_font=heading_font, mono_font=mono_font,
        chart_series=_default_chart_palette(accent),
        styles=_build_styles(accent, accent_soft, fg, muted, body_font),
    )


_DEFAULT = _make(
    "default",
    bg=(255, 255, 255), fg=(32, 32, 32),
    accent=(249, 168, 37), accent_soft=(254, 232, 173),
    muted=(120, 120, 120), grid=(225, 225, 220),
)

_CORPORATE = _make(
    "corporate",
    bg=(255, 255, 255), fg=(30, 40, 55),
    accent=(29, 78, 216), accent_soft=(219, 234, 254),
    muted=(100, 116, 139), grid=(210, 220, 235),
)

_MINIMAL = _make(
    "minimal",
    bg=(255, 255, 255), fg=(20, 20, 20),
    accent=(40, 40, 40), accent_soft=(230, 230, 230),
    muted=(140, 140, 140), grid=(220, 220, 220),
)

_DARK = _make(
    "dark",
    bg=(28, 28, 28), fg=(235, 235, 235),
    accent=(249, 168, 37), accent_soft=(92, 66, 22),
    muted=(160, 160, 160), grid=(60, 60, 60),
)


_THEMES: dict[str, Theme] = {
    "default": _DEFAULT,
    "corporate": _CORPORATE,
    "minimal": _MINIMAL,
    "dark": _DARK,
}


def get_theme(name: str | None, overrides: dict | None = None) -> Theme:
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
