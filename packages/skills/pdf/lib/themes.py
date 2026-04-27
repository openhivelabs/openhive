"""PDF theme definitions (mirrors docx themes but with reportlab-friendly types).

The palette intentionally exposes more than a single accent — `accent_2`,
`accent_3` feed multi-series charts, KPI cards, and any block that needs
distinct categorical colors. `success`/`warning`/`danger`/`info` are
semantic and used by callouts, KPI delta tones, and progress bars.
"""
from __future__ import annotations

from dataclasses import dataclass, replace


RGB = tuple[int, int, int]


@dataclass(frozen=True)
class Theme:
    name: str
    fg: RGB
    heading: RGB
    accent: RGB
    accent_2: RGB
    accent_3: RGB
    muted: RGB
    border: RGB
    code_bg: RGB
    success: RGB
    warning: RGB
    danger: RGB
    info: RGB
    heading_font: str
    body_font: str
    mono_font: str
    size_title: int = 30
    size_h1: int = 22
    size_h2: int = 17
    size_h3: int = 14
    size_h4: int = 12
    size_h5: int = 11
    size_h6: int = 11
    size_body: int = 11
    size_small: int = 9
    size_code: int = 10
    size_kpi: int = 24
    margin_top: float = 54
    margin_bottom: float = 54
    margin_left: float = 60
    margin_right: float = 60


_DEFAULT = Theme(
    name="default",
    fg=(33, 41, 55),
    heading=(15, 23, 42),
    accent=(37, 99, 235),
    accent_2=(13, 148, 136),
    accent_3=(168, 85, 247),
    muted=(100, 116, 139),
    border=(226, 232, 240),
    code_bg=(241, 245, 249),
    success=(22, 163, 74),
    warning=(217, 119, 6),
    danger=(220, 38, 38),
    info=(37, 99, 235),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Courier",
)

_FORMAL = Theme(
    name="formal",
    fg=(20, 20, 20),
    heading=(10, 10, 10),
    accent=(29, 78, 216),
    accent_2=(15, 76, 117),
    accent_3=(120, 53, 15),
    muted=(100, 116, 139),
    border=(214, 222, 235),
    code_bg=(246, 248, 252),
    success=(21, 128, 61),
    warning=(180, 83, 9),
    danger=(153, 27, 27),
    info=(29, 78, 216),
    heading_font="Times-Roman",
    body_font="Times-Roman",
    mono_font="Courier",
    size_h1=26, size_h2=20, size_h3=16,
)

_REPORT = Theme(
    name="report",
    fg=(30, 30, 30),
    heading=(15, 32, 62),
    accent=(15, 82, 186),
    accent_2=(217, 119, 6),
    accent_3=(13, 148, 136),
    muted=(110, 116, 130),
    border=(220, 226, 236),
    code_bg=(250, 250, 245),
    success=(21, 128, 61),
    warning=(180, 83, 9),
    danger=(180, 40, 40),
    info=(15, 82, 186),
    heading_font="Helvetica",
    body_font="Times-Roman",
    mono_font="Courier",
    size_body=12, size_h1=24, size_h2=18,
)

_MINIMAL = Theme(
    name="minimal",
    fg=(20, 20, 20),
    heading=(0, 0, 0),
    accent=(0, 0, 0),
    accent_2=(70, 70, 70),
    accent_3=(120, 120, 120),
    muted=(140, 140, 140),
    border=(225, 225, 225),
    code_bg=(248, 248, 248),
    success=(60, 60, 60),
    warning=(60, 60, 60),
    danger=(60, 60, 60),
    info=(60, 60, 60),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Courier",
)

_MODERN = Theme(
    name="modern",
    fg=(28, 33, 45),
    heading=(17, 24, 39),
    accent=(99, 102, 241),
    accent_2=(236, 72, 153),
    accent_3=(34, 197, 94),
    muted=(107, 114, 128),
    border=(229, 231, 235),
    code_bg=(238, 240, 244),
    success=(34, 197, 94),
    warning=(245, 158, 11),
    danger=(239, 68, 68),
    info=(59, 130, 246),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Courier",
)

_THEMES: dict[str, Theme] = {
    "default": _DEFAULT, "formal": _FORMAL,
    "report": _REPORT, "minimal": _MINIMAL,
    "modern": _MODERN,
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
