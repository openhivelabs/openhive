"""A1 ↔ (row, col) helpers. Both are 1-based to match openpyxl conventions."""
from __future__ import annotations

import re


_CELL_RE = re.compile(r"^([A-Z]+)(\d+)$")


def col_letter_to_index(letters: str) -> int:
    """A → 1, Z → 26, AA → 27, …"""
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n


def col_index_to_letter(idx: int) -> str:
    """1 → A, 26 → Z, 27 → AA, …"""
    s = ""
    while idx > 0:
        idx, r = divmod(idx - 1, 26)
        s = chr(ord("A") + r) + s
    return s


def parse_cell(ref: str) -> tuple[int, int]:
    """'B3' → (3, 2)  (row, col), both 1-based."""
    m = _CELL_RE.match(ref)
    if not m:
        raise ValueError(f"invalid A1 cell ref: {ref!r}")
    return int(m.group(2)), col_letter_to_index(m.group(1))


def parse_range(rng: str) -> tuple[int, int, int, int]:
    """'A1:C5' → (r1, c1, r2, c2), all 1-based."""
    if ":" not in rng:
        r, c = parse_cell(rng)
        return r, c, r, c
    a, b = rng.split(":", 1)
    r1, c1 = parse_cell(a)
    r2, c2 = parse_cell(b)
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def make_range(r1: int, c1: int, r2: int, c2: int) -> str:
    return f"{col_index_to_letter(c1)}{r1}:{col_index_to_letter(c2)}{r2}"
