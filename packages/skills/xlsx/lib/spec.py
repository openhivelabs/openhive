"""Spec validation for xlsx workbooks.

Validates a JSON workbook spec before the renderer runs, surfacing errors
with the exact sheet name + field path. Catches LLM-generated specs that
are almost-but-not-right (wrong field names, missing required fields, bad
A1 ranges) so the renderer can trust the input.
"""
from __future__ import annotations

import re
from typing import Any


CHART_KINDS = {"bar", "column", "line", "pie", "scatter", "area"}
COND_KINDS = {"data_bar", "color_scale", "icon_set", "cell_value"}
ALIGN_H = {"left", "center", "right"}
ALIGN_V = {"top", "center", "bottom"}

A1_CELL_RE = re.compile(r"^[A-Z]+\d+$")
A1_RANGE_RE = re.compile(r"^[A-Z]+\d+:[A-Z]+\d+$")


class SpecError(ValueError):
    pass


def validate(spec: dict) -> list[str]:
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    meta = spec.get("meta") or {}
    if not isinstance(meta, dict):
        raise SpecError("meta must be an object")

    sheets = spec.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise SpecError("spec.sheets must be a non-empty array")

    seen_names: set[str] = set()
    warnings: list[str] = []
    for i, sh in enumerate(sheets):
        _validate_sheet(i, sh, seen_names, warnings)
    return warnings


def _validate_sheet(i: int, sh: Any, seen: set[str], warnings: list[str]) -> None:
    here = f"sheet[{i}]"
    if not isinstance(sh, dict):
        raise SpecError(f"{here}: must be an object")
    name = sh.get("name")
    if not isinstance(name, str) or not name:
        raise SpecError(f"{here}.name: required non-empty string")
    if len(name) > 31:
        raise SpecError(f"{here}.name: Excel rejects sheet names longer than 31 chars (got {len(name)})")
    bad_chars = set(name) & set("\\/?*[]:")
    if bad_chars:
        raise SpecError(f"{here}.name: contains chars Excel rejects: {sorted(bad_chars)}")
    if name in seen:
        raise SpecError(f"{here}.name: duplicate sheet name {name!r}")
    seen.add(name)

    here = f"sheet[{i}:{name}]"

    rows = sh.get("rows")
    cells = sh.get("cells")
    if rows is not None:
        if not isinstance(rows, list):
            raise SpecError(f"{here}.rows: must be a 2D array")
        for r, row in enumerate(rows):
            if not isinstance(row, list):
                raise SpecError(f"{here}.rows[{r}]: must be an array")
    if cells is not None:
        if not isinstance(cells, list):
            raise SpecError(f"{here}.cells: must be an array of {{ref, value, style?}}")
        for k, c in enumerate(cells):
            if not isinstance(c, dict):
                raise SpecError(f"{here}.cells[{k}]: must be an object")
            ref = c.get("ref")
            if not isinstance(ref, str) or not A1_CELL_RE.match(ref):
                raise SpecError(f"{here}.cells[{k}].ref: must be A1 notation (e.g. 'B3'), got {ref!r}")

    merge = sh.get("merge")
    if merge is not None:
        if not isinstance(merge, list):
            raise SpecError(f"{here}.merge: must be an array of A1 ranges")
        for m in merge:
            if not isinstance(m, str) or not A1_RANGE_RE.match(m):
                raise SpecError(f"{here}.merge: invalid range {m!r} — use 'A1:C1' form")

    columns = sh.get("columns")
    if columns is not None:
        if not isinstance(columns, list):
            raise SpecError(f"{here}.columns: must be an array of {{width}} dicts")
        for j, col in enumerate(columns):
            if not isinstance(col, dict):
                raise SpecError(f"{here}.columns[{j}]: must be an object")
            w = col.get("width")
            if w is not None and (not isinstance(w, (int, float)) or w <= 0):
                raise SpecError(f"{here}.columns[{j}].width: positive number")

    freeze = sh.get("freeze")
    if freeze is not None and (not isinstance(freeze, str) or not A1_CELL_RE.match(freeze)):
        raise SpecError(f"{here}.freeze: must be a single A1 cell (e.g. 'A2'), got {freeze!r}")

    tab_color = sh.get("tab_color")
    if tab_color is not None and not _is_color(tab_color):
        raise SpecError(f"{here}.tab_color: must be 'RRGGBB' hex or [r,g,b]")

    tables = sh.get("tables")
    if tables is not None:
        if not isinstance(tables, list):
            raise SpecError(f"{here}.tables: must be an array")
        for t, tb in enumerate(tables):
            if not isinstance(tb, dict):
                raise SpecError(f"{here}.tables[{t}]: object")
            r = tb.get("range")
            if not isinstance(r, str) or not A1_RANGE_RE.match(r):
                raise SpecError(f"{here}.tables[{t}].range: required A1 range like 'A1:C5'")
            n = tb.get("name")
            if not isinstance(n, str) or not n:
                raise SpecError(f"{here}.tables[{t}].name: required non-empty string")

    charts = sh.get("charts")
    if charts is not None:
        if not isinstance(charts, list):
            raise SpecError(f"{here}.charts: must be an array")
        for c, ch in enumerate(charts):
            _validate_chart(f"{here}.charts[{c}]", ch)

    cond = sh.get("conditional")
    if cond is not None:
        if not isinstance(cond, list):
            raise SpecError(f"{here}.conditional: must be an array")
        for k, cf in enumerate(cond):
            _validate_cond(f"{here}.conditional[{k}]", cf)

    nfmts = sh.get("number_formats")
    if nfmts is not None:
        if not isinstance(nfmts, list):
            raise SpecError(f"{here}.number_formats: must be an array")
        for j, nf in enumerate(nfmts):
            r = nf.get("range")
            if not isinstance(r, str) or not (A1_CELL_RE.match(r) or A1_RANGE_RE.match(r)):
                raise SpecError(f"{here}.number_formats[{j}].range: A1 cell or range")
            if not isinstance(nf.get("format"), str):
                raise SpecError(f"{here}.number_formats[{j}].format: required string")

    if rows and len(rows) > 5000:
        warnings.append(f"{here}: {len(rows)} rows — large sheet, build will be slow")


def _validate_chart(here: str, ch: Any) -> None:
    if not isinstance(ch, dict):
        raise SpecError(f"{here}: must be an object")
    kind = ch.get("kind")
    if kind not in CHART_KINDS:
        raise SpecError(f"{here}.kind: must be one of {sorted(CHART_KINDS)}")
    dr = ch.get("data_range")
    if not isinstance(dr, str) or not A1_RANGE_RE.match(dr):
        raise SpecError(f"{here}.data_range: required A1 range like 'A1:C5'")
    anchor = ch.get("anchor")
    if anchor is not None and (not isinstance(anchor, str) or not A1_CELL_RE.match(anchor)):
        raise SpecError(f"{here}.anchor: A1 cell (top-left of chart frame)")


def _validate_cond(here: str, cf: Any) -> None:
    if not isinstance(cf, dict):
        raise SpecError(f"{here}: must be an object")
    r = cf.get("range")
    if not isinstance(r, str) or not (A1_CELL_RE.match(r) or A1_RANGE_RE.match(r)):
        raise SpecError(f"{here}.range: A1 cell or range")
    k = cf.get("kind")
    if k not in COND_KINDS:
        raise SpecError(f"{here}.kind: must be one of {sorted(COND_KINDS)}")


def _is_color(v) -> bool:
    if isinstance(v, str) and re.fullmatch(r"[0-9A-Fa-f]{6}", v):
        return True
    if (isinstance(v, list) and len(v) == 3
            and all(isinstance(x, int) and 0 <= x <= 255 for x in v)):
        return True
    return False
