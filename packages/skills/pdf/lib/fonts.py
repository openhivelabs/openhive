"""CJK font discovery for reportlab.

Default reportlab built-ins (Helvetica, Times-Roman, Courier) have no CJK
glyphs, so Korean/Chinese/Japanese text renders as tofu boxes. This module
registers a system-installed TTF at first use and returns its name so the
caller can swap it into the active theme.
"""
from __future__ import annotations

import pathlib

_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    "/System/Library/Fonts/Supplemental/AppleSDGothicNeo.ttc",
    "/Library/Fonts/NanumGothic.ttf",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/malgun.ttf",
]

_CJK_FONT_NAME: str | None = None
_REGISTERED = False


def ensure_cjk_font() -> str | None:
    """Register a CJK-capable TTF with reportlab. Returns the font name on
    success, None if no candidate is available."""
    global _CJK_FONT_NAME, _REGISTERED
    if _REGISTERED:
        return _CJK_FONT_NAME
    _REGISTERED = True

    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except ImportError:
        return None

    for path in _CANDIDATES:
        p = pathlib.Path(path)
        if not p.exists():
            continue
        name = "CJKSans"
        try:
            if p.suffix.lower() == ".ttc":
                pdfmetrics.registerFont(TTFont(name, str(p), subfontIndex=0))
            else:
                pdfmetrics.registerFont(TTFont(name, str(p)))
        except Exception:
            continue
        _CJK_FONT_NAME = name
        return name
    return None
