"""PDF spec schema + validator.

Same block vocabulary as the docx skill — ensures docx/pdf specs are
mostly interchangeable (a spec written for docx can be rendered as PDF
by swapping only the build script).

Block types: heading, paragraph, bullets, numbered, table, image,
page_break, quote, code, horizontal_rule, toc, kpi_row, two_column,
spacer, title.

Two PDF-only blocks:
  title   — big centered title (for cover pages)
  spacer  — vertical whitespace of N points
"""
from __future__ import annotations

from typing import Any


BLOCK_TYPES = {
    "heading", "paragraph", "bullets", "numbered", "table",
    "image", "page_break", "quote", "code", "horizontal_rule",
    "toc", "kpi_row", "two_column", "spacer", "title",
}

ALIGN_VALUES = {"left", "center", "right", "justify"}
TABLE_STYLES = {"grid", "light", "plain"}


class SpecError(ValueError):
    pass


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
    elif t == "image":
        img = block.get("path")
        if not isinstance(img, str) or not img:
            raise SpecError(f"{here}.path: required non-empty string")
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
    # page_break, horizontal_rule, toc: no extra fields


def _req_str(obj: dict, key: str, here: str) -> None:
    v = obj.get(key)
    if not isinstance(v, str) or not v:
        raise SpecError(f"{here}.{key}: required non-empty string")
