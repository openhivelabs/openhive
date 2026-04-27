"""PDF spec schema + validator.

Same block vocabulary as the docx skill — ensures docx/pdf specs are
mostly interchangeable (a spec written for docx can be rendered as PDF
by swapping only the build script).

Block types: heading, paragraph, bullets, numbered, table,
page_break, quote, code, horizontal_rule, toc, kpi_row, two_column,
spacer, title, callout, chart, progress.

Two PDF-only blocks:
  title   — big centered title (for cover pages)
  spacer  — vertical whitespace of N points
"""
from __future__ import annotations

from typing import Any


BLOCK_TYPES = {
    "heading", "paragraph", "bullets", "numbered", "table",
    "page_break", "quote", "code", "horizontal_rule",
    "toc", "kpi_row", "two_column", "spacer", "title",
    "callout", "chart", "progress",
}

ALIGN_VALUES = {"left", "center", "right", "justify"}
TABLE_STYLES = {"grid", "light", "plain"}
CALLOUT_VARIANTS = {"info", "success", "warning", "danger", "error",
                    "note", "tip", "neutral"}
CHART_VARIANTS = {"bar", "line", "pie"}


class SpecError(ValueError):
    pass


EXECUTIVE_AUDIENCES = {"executive", "board", "investor", "finance",
                       "임원", "이사회", "투자자"}

# Title-based auto-detection. When the document title contains any of these
# tokens, treat it as executive context even if meta.audience wasn't set —
# agents routinely forget the audience field, but the title nearly always
# signals the audience clearly. Match is case-insensitive substring.
import re as _re
_EXECUTIVE_TITLE_RE = _re.compile(
    r"임원|이사회|투자자|"  # KR
    r"executive|board|investor|finance|"  # EN
    r"分期報告|董事会",  # CJK
    _re.IGNORECASE,
)

# Free-text strikethrough used as rhetorical "X 가 아니라 Y" framing. Cheap
# detection: look for the literal `~~` markers in any text field. This will
# false-positive on mathematical or code text that legitimately uses `~~`,
# but those don't belong in business reports anyway.
_STRIKETHROUGH_RE = _re.compile(r"~~[^~\n]{1,60}~~")


def _is_executive_doc(meta: dict) -> bool:
    audience = str(meta.get("audience", "")).strip().lower()
    if audience in EXECUTIVE_AUDIENCES:
        return True
    title = str(meta.get("title", ""))
    if _EXECUTIVE_TITLE_RE.search(title):
        return True
    return False


def _has_strike(text: str) -> bool:
    if not isinstance(text, str):
        return False
    return bool(_STRIKETHROUGH_RE.search(text))


def validate(spec: dict) -> list[str]:
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    meta = spec.get("meta") or {}
    if not isinstance(meta, dict):
        raise SpecError("meta must be an object")

    blocks = spec.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        raise SpecError("spec.blocks must be a non-empty array")

    warnings: list[str] = []
    for i, block in enumerate(blocks):
        _validate_block(i, block, warnings)

    # Audience × block-type guardrail. Hard reject when the document is an
    # executive / board / investor report AND a `code` block is present.
    # Warning-only was insufficient — the agent kept emitting Python
    # source into board decks. The build fails so the agent must remove
    # the code block, not just see a warning. Same for rhetorical
    # strikethrough in body text.
    if _is_executive_doc(meta):
        for i, b in enumerate(blocks):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "code":
                raise SpecError(
                    f"block[{i}]: `code` block in an executive/board/investor "
                    f"document. Replace with a callout (variant 'note') or "
                    f"prose. Source code in a board report reads as a bug."
                )
            # Scan text fields for ~~rhetorical~~ strikethrough.
            for key in ("text", "body", "title"):
                if _has_strike(b.get(key) or ""):
                    warnings.append(
                        f"block[{i}].{key}: contains `~~strikethrough~~` "
                        f"in an executive document. Strikethrough means "
                        f"redline / removed-item — not 'X 가 아니라 Y' "
                        f"framing. Rewrite as plain prose."
                    )
    return warnings


def _validate_block(i: int, block: Any, warnings: list[str]) -> None:
    here = f"block[{i}]"
    if not isinstance(block, dict):
        raise SpecError(f"{here}: must be an object")
    t = block.get("type")
    if t not in BLOCK_TYPES:
        raise SpecError(f"{here}.type: must be one of {sorted(BLOCK_TYPES)}, got {t!r}")

    if t == "title":
        _req_str(block, "text", here)
    elif t == "heading":
        _req_str(block, "text", here)
        level = block.get("level", 1)
        if not isinstance(level, int) or not (1 <= level <= 6):
            raise SpecError(f"{here}.level: must be int 1..6")
    elif t == "paragraph":
        _req_str(block, "text", here)
        align = block.get("align")
        if align is not None and align not in ALIGN_VALUES:
            raise SpecError(f"{here}.align: must be one of {sorted(ALIGN_VALUES)}")
    elif t in ("bullets", "numbered"):
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise SpecError(f"{here}.items: non-empty array required")
    elif t == "table":
        headers = block.get("headers")
        rows = block.get("rows")
        if not isinstance(headers, list) or not headers:
            raise SpecError(f"{here}.headers: non-empty array required")
        if not isinstance(rows, list) or not rows:
            raise SpecError(f"{here}.rows: non-empty array required")
        style = block.get("style", "grid")
        if style not in TABLE_STYLES:
            raise SpecError(f"{here}.style: must be one of {sorted(TABLE_STYLES)}")
    elif t == "quote":
        _req_str(block, "text", here)
    elif t == "code":
        _req_str(block, "text", here)
    elif t == "kpi_row":
        stats = block.get("stats")
        if not isinstance(stats, list) or not stats:
            raise SpecError(f"{here}.stats: non-empty array required")
        for j, s in enumerate(stats):
            if not isinstance(s, dict) or "value" not in s or "label" not in s:
                raise SpecError(f"{here}.stats[{j}]: requires value and label")
    elif t == "two_column":
        for side in ("left", "right"):
            col = block.get(side)
            if col is None:
                raise SpecError(f"{here}.{side}: required")
    elif t == "spacer":
        h = block.get("height", 12)
        if not isinstance(h, (int, float)) or h < 0:
            raise SpecError(f"{here}.height: must be a non-negative number (pt)")
    elif t == "callout":
        variant = block.get("variant", "info")
        if variant not in CALLOUT_VARIANTS:
            raise SpecError(f"{here}.variant: must be one of {sorted(CALLOUT_VARIANTS)}")
        if not (block.get("text") or block.get("body") or block.get("bullets")
                or block.get("title")):
            raise SpecError(f"{here}: needs at least one of text/body/bullets/title")
    elif t == "chart":
        variant = block.get("variant", "bar")
        if variant not in CHART_VARIANTS:
            raise SpecError(f"{here}.variant: must be one of {sorted(CHART_VARIANTS)}")
        if variant in ("bar", "line"):
            series = block.get("series")
            if not isinstance(series, list) or not series:
                raise SpecError(f"{here}.series: non-empty array required for {variant}")
            for j, s in enumerate(series):
                if not isinstance(s, dict) or not isinstance(s.get("values"), list):
                    raise SpecError(f"{here}.series[{j}].values: array required")
        elif variant == "pie":
            slices = block.get("slices")
            if not isinstance(slices, list) or not slices:
                raise SpecError(f"{here}.slices: non-empty array required for pie")
    elif t == "progress":
        bars = block.get("bars")
        if not isinstance(bars, list) or not bars:
            raise SpecError(f"{here}.bars: non-empty array required")
        for j, b in enumerate(bars):
            if not isinstance(b, dict) or "value" not in b or "label" not in b:
                raise SpecError(f"{here}.bars[{j}]: requires label and value")
    # page_break, horizontal_rule, toc: no extra fields


def _req_str(obj: dict, key: str, here: str) -> None:
    v = obj.get(key)
    if not isinstance(v, str) or not v:
        raise SpecError(f"{here}.{key}: required non-empty string")
