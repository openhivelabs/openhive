"""Spec validation.

Validates a JSON deck spec before rendering, surfacing errors with the exact
slide index + field path. Catches LLM-generated specs that are almost-but-not
right (wrong field names, missing required fields, bad types) so renderers can
trust the input.
"""
from __future__ import annotations

from typing import Any


SLIDE_TYPES = {
    "title", "section", "bullets", "two_column", "image", "table",
    "chart", "comparison", "quote", "steps", "kpi", "closing",
}

CHART_KINDS = {"bar", "column", "line", "pie", "area", "scatter"}

COLUMN_KINDS = {"text", "bullets", "image"}


class SpecError(ValueError):
    pass


def validate(spec: dict) -> list[str]:
    """Raise SpecError on fatal problems. Return non-fatal warnings.

    Warnings cover e.g. too-many-bullets, huge tables — the renderer still
    produces output but the reader should know readability may suffer.
    """
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    meta = spec.get("meta") or {}
    if not isinstance(meta, dict):
        raise SpecError("meta must be an object")

    slides = spec.get("slides")
    if not isinstance(slides, list) or not slides:
        raise SpecError("spec.slides must be a non-empty array")

    warnings: list[str] = []
    for i, slide in enumerate(slides):
        _validate_slide(i, slide, warnings)
    return warnings


def _validate_slide(i: int, slide: Any, warnings: list[str]) -> None:
    here = f"slide[{i}]"
    if not isinstance(slide, dict):
        raise SpecError(f"{here}: must be an object")
    t = slide.get("type")
    if t not in SLIDE_TYPES:
        raise SpecError(f"{here}.type: must be one of {sorted(SLIDE_TYPES)}, got {t!r}")

    notes = slide.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise SpecError(f"{here}.notes: must be a string")

    if t == "title":
        _req_str(slide, "title", here)
        _opt_str(slide, "subtitle", here)
        _opt_str(slide, "author", here)
        _opt_str(slide, "date", here)
    elif t == "section":
        _req_str(slide, "title", here)
        _opt_str(slide, "subtitle", here)
    elif t == "bullets":
        _req_str(slide, "title", here)
        bullets = slide.get("bullets")
        if not isinstance(bullets, list) or not bullets:
            raise SpecError(f"{here}.bullets: must be a non-empty array")
        _count = _count_bullets(bullets)
        if _count > 9:
            warnings.append(f"{here}: {_count} bullets — consider splitting across slides")
    elif t == "two_column":
        _opt_str(slide, "title", here)
        for side in ("left", "right"):
            col = slide.get(side)
            if not isinstance(col, dict):
                raise SpecError(f"{here}.{side}: must be an object with kind + content")
            kind = col.get("kind")
            if kind not in COLUMN_KINDS:
                raise SpecError(f"{here}.{side}.kind: must be one of {sorted(COLUMN_KINDS)}")
    elif t == "image":
        _opt_str(slide, "title", here)
        img = slide.get("image")
        if not isinstance(img, str) or not img:
            raise SpecError(f"{here}.image: required non-empty string (path or http(s) URL)")
        fit = slide.get("fit", "contain")
        if fit not in {"contain", "cover", "full_bleed"}:
            raise SpecError(f"{here}.fit: must be contain|cover|full_bleed")
    elif t == "table":
        _opt_str(slide, "title", here)
        headers = slide.get("headers")
        rows = slide.get("rows")
        if not isinstance(headers, list) or not headers:
            raise SpecError(f"{here}.headers: required non-empty array")
        if not isinstance(rows, list) or not rows:
            raise SpecError(f"{here}.rows: required non-empty array")
        bad = [r for r in rows if not isinstance(r, list)]
        if bad:
            raise SpecError(f"{here}.rows: every row must be an array")
        if len(rows) > 15:
            warnings.append(f"{here}: {len(rows)} rows — table will be truncated to 12 for readability")
        if len(headers) > 8:
            warnings.append(f"{here}: {len(headers)} columns — consider splitting data")
    elif t == "chart":
        _opt_str(slide, "title", here)
        kind = slide.get("kind")
        if kind not in CHART_KINDS:
            raise SpecError(f"{here}.kind: must be one of {sorted(CHART_KINDS)}")
        categories = slide.get("categories")
        series = slide.get("series")
        if not isinstance(categories, list) or not categories:
            raise SpecError(f"{here}.categories: required non-empty array")
        if not isinstance(series, list) or not series:
            raise SpecError(f"{here}.series: required non-empty array")
        for j, s in enumerate(series):
            if not isinstance(s, dict) or "name" not in s or "values" not in s:
                raise SpecError(f"{here}.series[{j}]: requires 'name' and 'values'")
            if not isinstance(s["values"], list) or len(s["values"]) != len(categories):
                raise SpecError(
                    f"{here}.series[{j}].values: must be an array of length {len(categories)}"
                )
        if len(series) > 6:
            warnings.append(f"{here}: {len(series)} series — legend may overflow")
    elif t == "comparison":
        _opt_str(slide, "title", here)
        cols = slide.get("columns")
        if not isinstance(cols, list) or len(cols) < 2:
            raise SpecError(f"{here}.columns: requires at least 2 columns")
        if len(cols) > 4:
            warnings.append(f"{here}: {len(cols)} columns — text will be tiny, consider ≤ 3")
        for j, c in enumerate(cols):
            if not isinstance(c, dict) or "header" not in c or "points" not in c:
                raise SpecError(f"{here}.columns[{j}]: requires 'header' and 'points'")
    elif t == "quote":
        _req_str(slide, "quote", here)
        _opt_str(slide, "attribution", here)
    elif t == "steps":
        _opt_str(slide, "title", here)
        steps = slide.get("steps")
        if not isinstance(steps, list) or not steps:
            raise SpecError(f"{here}.steps: required non-empty array")
        if len(steps) > 6:
            warnings.append(f"{here}: {len(steps)} steps — consider ≤ 5 for clarity")
        for j, st in enumerate(steps):
            if not isinstance(st, dict) or "title" not in st:
                raise SpecError(f"{here}.steps[{j}]: requires 'title'")
    elif t == "kpi":
        _opt_str(slide, "title", here)
        stats = slide.get("stats")
        if not isinstance(stats, list) or not stats:
            raise SpecError(f"{here}.stats: required non-empty array")
        if len(stats) > 5:
            warnings.append(f"{here}: {len(stats)} stats — layout works best with ≤ 4")
        for j, s in enumerate(stats):
            if not isinstance(s, dict) or "value" not in s or "label" not in s:
                raise SpecError(f"{here}.stats[{j}]: requires 'value' and 'label'")
    elif t == "closing":
        _opt_str(slide, "title", here)
        _opt_str(slide, "subtitle", here)


def _req_str(obj: dict, key: str, here: str) -> None:
    v = obj.get(key)
    if not isinstance(v, str) or not v:
        raise SpecError(f"{here}.{key}: required non-empty string")


def _opt_str(obj: dict, key: str, here: str) -> None:
    v = obj.get(key)
    if v is not None and not isinstance(v, str):
        raise SpecError(f"{here}.{key}: must be a string if present")


def _count_bullets(items: list) -> int:
    """Count text bullets in possibly-nested structure."""
    n = 0
    for it in items:
        if isinstance(it, str):
            n += 1
        elif isinstance(it, list):
            n += _count_bullets(it)
    return n
