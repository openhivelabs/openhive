"""Tiny helper to parse 'A1:C5' into (c1, r1, c2, r2) integer tuples
without round-tripping through openpyxl's Reference/regex."""
from __future__ import annotations

import re

_RANGE_RE = re.compile(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$")


def col_letter_to_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n


def parse_range_letters(rng: str) -> tuple[int, int, int, int]:
    m = _RANGE_RE.match(rng)
    if not m:
        raise ValueError(f"not an A1 range: {rng!r}")
    c1 = col_letter_to_index(m.group(1))
    r1 = int(m.group(2))
    c2 = col_letter_to_index(m.group(3))
    r2 = int(m.group(4))
    if c1 > c2:
        c1, c2 = c2, c1
    if r1 > r2:
        r1, r2 = r2, r1
    return c1, r1, c2, r2
