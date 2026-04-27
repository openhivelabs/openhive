"""DOCX spec schema + validator.

A docx spec is a JSON object:

    {
      "meta": {
        "title": "...",          // document title (metadata + cover)
        "author": "...",
        "subject": "...",
        "theme": "default",      // default | formal | report | minimal
        "size": "A4",            // A4 | Letter | Legal
        "orientation": "portrait"  // portrait | landscape
      },
      "blocks": [ ... ]          // ordered list of blocks
    }

Block types: see BLOCK_TYPES below.
"""
from __future__ import annotations

from typing import Any


BLOCK_TYPES = {
    "heading", "paragraph", "bullets", "numbered", "table",
    "image", "page_break", "quote", "code", "horizontal_rule",
    "toc", "kpi_row", "two_column",
    # new visual blocks
    "cover", "chart", "callout", "sidebar", "spacer", "divider",
}

ALIGN_VALUES = {"left", "center", "right", "justify"}
TABLE_STYLES = {"grid", "light", "plain", "zebra", "minimal"}
CALLOUT_VARIANTS = {"info", "success", "warning", "danger", "note", "tip"}
CHART_VARIANTS = {"bar", "hbar", "line", "area", "donut", "pie",
                  "scatter", "stacked_bar", "sparkline"}


class SpecError(ValueError):
    pass


def validate(spec: dict) -> list[str]:
    """Raise SpecError on fatal problems. Return non-fatal warnings."""
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
    return warnings


def _validate_block(i: int, block: Any, warnings: list[str]) -> None:
    here = f"block[{i}]"
    if not isinstance(block, dict):
        raise SpecError(f"{here}: must be an object")
    t = block.get("type")
    if t not in BLOCK_TYPES:
        raise SpecError(f"{here}.type: must be one of {sorted(BLOCK_TYPES)}, got {t!r}")

    if t == "heading":
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
        for r in rows:
            if not isinstance(r, list):
                raise SpecError(f"{here}.rows: every row must be an array")
        style = block.get("style", "grid")
        if style not in TABLE_STYLES:
            raise SpecError(f"{here}.style: must be one of {sorted(TABLE_STYLES)}")
        if len(rows) > 50:
            warnings.append(f"{here}: {len(rows)} rows — consider splitting")
    elif t == "image":
        img = block.get("path")
        if not isinstance(img, str) or not img:
            raise SpecError(f"{here}.path: required non-empty string")
    elif t == "quote":
        _req_str(block, "text", here)
    elif t == "code":
        _req_str(block, "text", here)
    elif t == "toc":
        lvl = block.get("levels", 3)
        if not isinstance(lvl, int) or not (1 <= lvl <= 9):
            raise SpecError(f"{here}.levels: must be int 1..9")
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
    elif t == "cover":
        _req_str(block, "title", here)
    elif t == "chart":
        variant = block.get("variant", "bar")
        if variant not in CHART_VARIANTS:
            raise SpecError(f"{here}.variant: must be one of {sorted(CHART_VARIANTS)}")
        if variant in ("bar", "line", "area", "scatter", "stacked_bar", "hbar"):
            series = block.get("series")
            if not isinstance(series, list) or not series:
                raise SpecError(f"{here}.series: non-empty array required for {variant}")
            for j, s in enumerate(series):
                if not isinstance(s, dict) or not isinstance(s.get("values"), list):
                    raise SpecError(f"{here}.series[{j}].values: array required")
        elif variant in ("donut", "pie"):
            slices = block.get("slices")
            if not isinstance(slices, list) or not slices:
                raise SpecError(f"{here}.slices: non-empty array required for {variant}")
        elif variant == "sparkline":
            values = block.get("values")
            if not isinstance(values, list) or not values:
                raise SpecError(f"{here}.values: non-empty array required for sparkline")
    elif t == "callout":
        variant = block.get("variant", "info")
        if variant not in CALLOUT_VARIANTS:
            raise SpecError(f"{here}.variant: must be one of {sorted(CALLOUT_VARIANTS)}")
        if not (block.get("text") or block.get("title") or block.get("bullets")):
            raise SpecError(f"{here}: needs text, title, or bullets")
    elif t == "sidebar":
        if not (block.get("text") or block.get("title") or block.get("bullets")):
            raise SpecError(f"{here}: needs text, title, or bullets")
    elif t == "spacer":
        h = block.get("height", 12)
        if not isinstance(h, (int, float)) or h < 0:
            raise SpecError(f"{here}.height: must be a non-negative number (pt)")
    # page_break, horizontal_rule, divider: no extra fields required


def _req_str(obj: dict, key: str, here: str) -> None:
    v = obj.get(key)
    if not isinstance(v, str) or not v:
        raise SpecError(f"{here}.{key}: required non-empty string")
