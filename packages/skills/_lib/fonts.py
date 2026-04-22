"""Unified Noto font resolution for the PDF / DOCX / PPTX skills.

The built-in reportlab fonts cover only Latin — Korean/Japanese/Chinese/Arabic/
Thai/Devanagari/Hebrew all come out as empty boxes without registering a font
that has their glyphs. DOCX/PPTX at least delegate to the reader, but if we
write "Helvetica" into the XML the reader's CJK fallback depends on the host
machine.

Fix: unify every doc-generation skill on the Noto Sans family (SIL OFL, safe
to redistribute). Each target script has a single variable-font TTF that
covers Regular..Black weights in one file. We lazy-download only the scripts
actually present in the document text, cache under ~/.openhive/fonts/noto/,
and fall back to system-installed fonts if the download fails (offline,
corporate proxy, etc).

Keep this module self-contained — no skill imports it except via
``from skills._lib import fonts`` equivalent (each skill copies or shells out
to this file). No reportlab/python-docx imports at top-level; those live
behind functions so the module loads cheaply.
"""
from __future__ import annotations

import logging
import os
import pathlib
import threading
import urllib.error
import urllib.request

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# script keys + family names
# ---------------------------------------------------------------------------

SCRIPT_LATIN = "latin"
SCRIPT_KR = "kr"
SCRIPT_JP = "jp"
SCRIPT_SC = "sc"   # simplified chinese
SCRIPT_TC = "tc"   # traditional chinese
SCRIPT_ARABIC = "arabic"
SCRIPT_DEVANAGARI = "devanagari"
SCRIPT_THAI = "thai"
SCRIPT_HEBREW = "hebrew"

ALL_SCRIPTS = (
    SCRIPT_LATIN, SCRIPT_KR, SCRIPT_JP, SCRIPT_SC, SCRIPT_TC,
    SCRIPT_ARABIC, SCRIPT_DEVANAGARI, SCRIPT_THAI, SCRIPT_HEBREW,
)

# Family names we write into document metadata. When the reader (Word,
# Preview, LibreOffice) can't find this name on the host machine it falls back
# to its own script-appropriate font — vastly better than writing "Helvetica"
# and hoping.
DISPLAY_NAMES: dict[str, str] = {
    SCRIPT_LATIN: "Noto Sans",
    SCRIPT_KR: "Noto Sans KR",
    SCRIPT_JP: "Noto Sans JP",
    SCRIPT_SC: "Noto Sans SC",
    SCRIPT_TC: "Noto Sans TC",
    SCRIPT_ARABIC: "Noto Sans Arabic",
    SCRIPT_DEVANAGARI: "Noto Sans Devanagari",
    SCRIPT_THAI: "Noto Sans Thai",
    SCRIPT_HEBREW: "Noto Sans Hebrew",
}


# ---------------------------------------------------------------------------
# download sources
# ---------------------------------------------------------------------------

# One variable-font TTF per script. Picking VFs keeps the cache tiny
# (a single ~5-10MB file covers Regular..Black for CJK, ~0.5-1MB for smaller
# scripts) at the cost of reportlab synthesising bold rather than using a
# hinted Bold instance — acceptable for report output.
#
# Each entry is a tuple of (primary, fallback) URLs. jsDelivr serves from
# google/fonts with aggressive caching; raw.githubusercontent is the backup
# when jsDelivr has availability issues.
_CDN_PRIMARY = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl"
_CDN_FALLBACK = "https://raw.githubusercontent.com/google/fonts/main/ofl"

# google/fonts encodes axes in filenames like `NotoSans[wdth,wght].ttf`. The
# brackets and comma must be URL-encoded or HTTP servers choke.
def _vf(dir_: str, basename: str, axes: str) -> tuple[str, str]:
    name = f"{basename}%5B{axes}%5D.ttf"
    return (f"{_CDN_PRIMARY}/{dir_}/{name}", f"{_CDN_FALLBACK}/{dir_}/{name}")


_SOURCES: dict[str, tuple[str, str]] = {
    SCRIPT_LATIN: _vf("notosans", "NotoSans", "wdth%2Cwght"),
    SCRIPT_KR: _vf("notosanskr", "NotoSansKR", "wght"),
    SCRIPT_JP: _vf("notosansjp", "NotoSansJP", "wght"),
    SCRIPT_SC: _vf("notosanssc", "NotoSansSC", "wght"),
    SCRIPT_TC: _vf("notosanstc", "NotoSansTC", "wght"),
    SCRIPT_ARABIC: _vf("notosansarabic", "NotoSansArabic", "wdth%2Cwght"),
    SCRIPT_DEVANAGARI: _vf("notosansdevanagari", "NotoSansDevanagari", "wdth%2Cwght"),
    SCRIPT_THAI: _vf("notosansthai", "NotoSansThai", "wdth%2Cwght"),
    SCRIPT_HEBREW: _vf("notosanshebrew", "NotoSansHebrew", "wdth%2Cwght"),
}


# Probe paths for system-installed fonts. Used as last resort if download
# fails — gives *something* usable on an offline box that at least has the OS
# defaults.
_SYSTEM_PATHS: dict[str, list[str]] = {
    SCRIPT_KR: [
        "/System/Library/Fonts/Supplemental/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
        "/Library/Fonts/NanumGothic.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/malgun.ttf",
    ],
    SCRIPT_JP: [
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/YuGothM.ttc",
        "C:/Windows/Fonts/msgothic.ttc",
    ],
    SCRIPT_SC: [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simsun.ttc",
    ],
    SCRIPT_TC: [
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/msjh.ttc",
        "C:/Windows/Fonts/mingliu.ttc",
    ],
    SCRIPT_ARABIC: [
        "/System/Library/Fonts/Supplemental/GeezaPro.ttc",
        "/System/Library/Fonts/GeezaPro.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/kacst/KacstArt.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/tahoma.ttf",
    ],
    SCRIPT_THAI: [
        "/System/Library/Fonts/Supplemental/Ayuthaya.ttf",
        "/System/Library/Fonts/Thonburi.ttc",
        "/usr/share/fonts/truetype/tlwg/Garuda.ttf",
        "C:/Windows/Fonts/tahoma.ttf",
        "C:/Windows/Fonts/leelawad.ttf",
    ],
    SCRIPT_DEVANAGARI: [
        "/System/Library/Fonts/Supplemental/Kohinoor.ttc",
        "/System/Library/Fonts/Kohinoor.ttc",
        "/usr/share/fonts/truetype/lohit-devanagari/Lohit-Devanagari.ttf",
        "C:/Windows/Fonts/mangal.ttf",
        "C:/Windows/Fonts/Nirmala.ttf",
    ],
    SCRIPT_HEBREW: [
        "/System/Library/Fonts/Supplemental/ArialHB.ttc",
        "/System/Library/Fonts/Supplemental/NewPeninimMT.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/david.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    # Latin: we don't even try — reportlab has Helvetica built-in and every
    # OS ships a Latin font. Only downloaded when the document wants a
    # consistent Noto look.
    SCRIPT_LATIN: [
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
}


# ---------------------------------------------------------------------------
# cache directory
# ---------------------------------------------------------------------------

def _cache_root() -> pathlib.Path:
    # Respect an override so tests can point at a scratch dir and CI pipelines
    # can pre-seed cold-start fonts. Defer expanduser to call-time in case the
    # env is mutated between module import and first use (eg via pytest).
    base = os.environ.get("OPENHIVE_FONTS_DIR")
    if base:
        return pathlib.Path(base).expanduser()
    return pathlib.Path.home() / ".openhive" / "fonts" / "noto"


# Negative-cache: once a script has failed to resolve in this process, don't
# keep retrying the network on every render. A fresh Python subprocess gets a
# clean slate so transient outages recover on the next skill call.
_FAILED: set[str] = set()
_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# script detection
# ---------------------------------------------------------------------------

def detect_scripts(text: str) -> set[str]:
    """Return every script that appears in ``text``.

    Order-independent — caller decides priority. Anything outside the mapped
    ranges falls into Latin, since Noto Sans already covers extended Latin,
    Cyrillic, and Greek in one file.
    """
    out: set[str] = set()
    for ch in text:
        cp = ord(ch)
        if cp < 0x80:
            out.add(SCRIPT_LATIN)
            continue
        if (
            0x1100 <= cp <= 0x11FF           # Hangul Jamo
            or 0x3130 <= cp <= 0x318F        # Hangul Compatibility Jamo
            or 0xA960 <= cp <= 0xA97F        # Hangul Jamo Extended-A
            or 0xAC00 <= cp <= 0xD7AF        # Hangul Syllables / Extended-B
        ):
            out.add(SCRIPT_KR)
        elif 0x3040 <= cp <= 0x30FF or 0x31F0 <= cp <= 0x31FF:
            out.add(SCRIPT_JP)               # Hiragana / Katakana
        elif 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF:
            # CJK Unified — ambiguous. Default to SC; `dominant_script` fixes
            # this up when kana/hangul also appear.
            out.add(SCRIPT_SC)
        elif (
            0x0600 <= cp <= 0x06FF
            or 0x0750 <= cp <= 0x077F
            or 0xFB50 <= cp <= 0xFDFF
            or 0xFE70 <= cp <= 0xFEFF
        ):
            out.add(SCRIPT_ARABIC)
        elif 0x0900 <= cp <= 0x097F:
            out.add(SCRIPT_DEVANAGARI)
        elif 0x0E00 <= cp <= 0x0E7F:
            out.add(SCRIPT_THAI)
        elif 0x0590 <= cp <= 0x05FF or 0xFB1D <= cp <= 0xFB4F:
            out.add(SCRIPT_HEBREW)
        else:
            out.add(SCRIPT_LATIN)
    return out


def dominant_script(text: str) -> str:
    """Pick the single script that should drive font selection for the whole
    document. reportlab doesn't do per-glyph fallback, so mixed-script docs
    get rendered in the script whose Noto variant *also* covers Latin — which
    is all of them. Callers who need real mixed-script routing (DOCX/PPTX
    east-asia slot) should iterate on ``detect_scripts`` instead.
    """
    scripts = detect_scripts(text)
    # Hangul/kana presence wins over ambiguous Han ideographs.
    if SCRIPT_KR in scripts:
        scripts.discard(SCRIPT_SC)
    if SCRIPT_JP in scripts:
        scripts.discard(SCRIPT_SC)
    # Complex scripts most likely to tofu-out come first.
    for s in (
        SCRIPT_KR, SCRIPT_JP, SCRIPT_TC, SCRIPT_SC,
        SCRIPT_ARABIC, SCRIPT_DEVANAGARI, SCRIPT_THAI, SCRIPT_HEBREW,
    ):
        if s in scripts:
            return s
    return SCRIPT_LATIN


# ---------------------------------------------------------------------------
# file resolution + reportlab registration
# ---------------------------------------------------------------------------

def ensure_font_file(script: str) -> pathlib.Path | None:
    """Return a TTF path for ``script``. Strategy:

    1. cached download under ~/.openhive/fonts/noto/
    2. fresh download from the CDN (cached on success)
    3. probe a list of system-install paths (Apple/Linux/Windows defaults)

    Returns None when every strategy fails. The caller degrades gracefully
    (usually by falling back to the theme's declared font name, which still
    lets the reader's OS pick a glyph-matching font in DOCX/PPTX — only PDF
    actually tofus).
    """
    if script in _FAILED:
        # Skip the network on repeated calls within a single process once
        # we've proven the download isn't going to succeed.
        return _probe_system(script)

    cached = _cache_root() / f"{script}.ttf"
    if cached.exists() and cached.stat().st_size > 0:
        return cached

    with _LOCK:
        # Re-check after acquiring the lock in case another thread just wrote
        # the file.
        if cached.exists() and cached.stat().st_size > 0:
            return cached
        try:
            cached.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            log.warning("noto cache dir create failed (%s): %s", cached.parent, e)
            _FAILED.add(script)
            return _probe_system(script)

        for url in _SOURCES.get(script, ()):
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": "openhive-skills-font-fetch"},
                )
                # 5s connect/read cap keeps an offline box from blocking a
                # skill call for tens of seconds on every run.
                with urllib.request.urlopen(req, timeout=5) as resp:
                    data = resp.read()
                if not data or len(data) < 1024:
                    continue
                # Atomic write — partial files would be cached forever and
                # fail reportlab validation on next load.
                tmp = cached.with_suffix(".ttf.part")
                tmp.write_bytes(data)
                tmp.replace(cached)
                return cached
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                log.warning("noto download failed %s: %s", url, e)
                continue

        _FAILED.add(script)

    return _probe_system(script)


def _probe_system(script: str) -> pathlib.Path | None:
    for path in _SYSTEM_PATHS.get(script, ()):
        p = pathlib.Path(path)
        if p.exists():
            return p
    return None


# Track what we've already handed to reportlab so repeat calls don't re-register
# (reportlab treats duplicate names as errors in some versions).
_REGISTERED: dict[str, str] = {}


def register_reportlab(script: str) -> str | None:
    """Register the Noto TTF for ``script`` with reportlab and return the
    registered font name, or None on failure.

    The returned name is what callers pass to ``ParagraphStyle(fontName=...)``.
    Bold/italic variants are synthesised by reportlab from the single VF —
    visually slightly lighter than a hinted Bold cut but perfectly legible
    and keeps the cache small.
    """
    if script in _REGISTERED:
        return _REGISTERED[script]
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont, TTFError
    except ImportError:
        return None

    path = ensure_font_file(script)
    if path is None:
        return None
    name = f"Noto-{script}"
    try:
        kwargs = {}
        if path.suffix.lower() == ".ttc":
            kwargs["subfontIndex"] = 0
        pdfmetrics.registerFont(TTFont(name, str(path), **kwargs))
    except TTFError as e:
        log.warning("reportlab font register failed for %s: %s", path, e)
        return None
    except Exception as e:  # defensive — reportlab surfaces various runtime errors
        log.warning("reportlab font register failed for %s: %s", path, e)
        return None
    _REGISTERED[script] = name
    return name


def display_name(script: str) -> str:
    """Human-readable family name to embed in DOCX/PPTX metadata."""
    return DISPLAY_NAMES.get(script, DISPLAY_NAMES[SCRIPT_LATIN])


# ---------------------------------------------------------------------------
# CLI — optional pre-seed for offline / air-gapped installs
# ---------------------------------------------------------------------------
#
# Usage:
#     python3 packages/skills/_lib/fonts.py             # seed Latin + KR
#     python3 packages/skills/_lib/fonts.py kr jp ar    # seed specific scripts
#     python3 packages/skills/_lib/fonts.py --all       # seed every script
#
# Exits 0 on success or partial success (whatever it managed to cache is
# useful); exits 1 only if nothing could be seeded, so CI/postinstall hooks
# can treat the step as best-effort.

def _cli(argv: list[str]) -> int:
    if "--all" in argv:
        targets = list(ALL_SCRIPTS)
    else:
        targets = [a for a in argv if a in ALL_SCRIPTS] or [SCRIPT_LATIN, SCRIPT_KR]
    ok = 0
    for s in targets:
        path = ensure_font_file(s)
        if path is None:
            print(f"[fonts] {s}: UNAVAILABLE (no CDN, no system font)")
            continue
        print(f"[fonts] {s}: {path}")
        ok += 1
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    import sys as _sys

    raise SystemExit(_cli(_sys.argv[1:]))
