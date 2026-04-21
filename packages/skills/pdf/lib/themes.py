"""PDF theme definitions (mirrors docx themes but with reportlab-friendly types)."""
from __future__ import annotations

from dataclasses import dataclass, replace


RGB = tuple[int, int, int]


@dataclass(frozen=True)
class Theme:
    name: str
    fg: RGB
    heading: RGB
    accent: RGB
    muted: RGB
    code_bg: RGB
    heading_font: str
    body_font: str
    mono_font: str
    size_title: int = 32
    size_h1: int = 22
    size_h2: int = 18
    size_h3: int = 15
    size_h4: int = 13
    size_h5: int = 12
    size_h6: int = 11
    size_body: int = 11
    size_small: int = 9
    size_code: int = 10
    size_kpi: int = 24
    margin_top: float = 54      # pt (0.75 in)
    margin_bottom: float = 54
    margin_left: float = 60
    margin_right: float = 60


_DEFAULT = Theme(
    name="default",
    fg=(32, 32, 32),
    heading=(20, 20, 20),
    accent=(249, 168, 37),
    muted=(120, 120, 120),
    code_bg=(245, 245, 245),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Courier",
)

_FORMAL = Theme(
    name="formal",
    fg=(20, 20, 20),
    heading=(10, 10, 10),
    accent=(29, 78, 216),
    muted=(100, 116, 139),
    code_bg=(246, 248, 252),
    heading_font="Times-Roman",
    body_font="Times-Roman",
    mono_font="Courier",
    size_h1=26, size_h2=20, size_h3=16,
)

_REPORT = Theme(
    name="report",
    fg=(30, 30, 30),
    heading=(15, 32, 62),
    accent=(180, 40, 40),
    muted=(110, 110, 110),
    code_bg=(250, 250, 245),
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
    muted=(140, 140, 140),
    code_bg=(248, 248, 248),
    heading_font="Helvetica",
    body_font="Helvetica",
    mono_font="Courier",
)

_THEMES: dict[str, Theme] = {
    "default": _DEFAULT, "formal": _FORMAL,
    "report": _REPORT, "minimal": _MINIMAL,
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
