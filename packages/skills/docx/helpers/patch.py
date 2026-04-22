"""Patch DSL for editing an existing .docx.

We take a pragmatic two-track approach for editing:

1. **Block-level ops via python-docx** — set_text, update_table_cell,
   swap_image, set_style — operate on the live Document model and save.
2. **Structural ops via spec round-trip** — insert_block, delete_block,
   replace_block, move_block, replace_paragraph — edit the accompanying
   `.spec.json` and re-run `build_doc.py`. We don't try to splice new
   python-docx objects into arbitrary positions because the ordering
   inside `<w:body>` is fragile and python-docx's insertion API is awkward.

Selector grammar (blocks are zero-indexed in document order):

    heading:N              N-th heading in document order (level irrelevant)
    heading:N[level=2]     with level filter
    paragraph:N            N-th paragraph (excluding headings/table cells/...)
    table:N                N-th table
    table:N > cell[r=0,c=1]   specific cell of a table
    image:N                N-th picture
    block:N                N-th top-level block (for spec-level ops)

Operations:

    {"op": "set_text", "target": "<sel>", "value": "..."}
    {"op": "update_table_cell", "target": "table:0 > cell[r=1,c=2]", "value": "..."}
    {"op": "swap_image", "target": "image:0", "value": "path_or_url"}
    {"op": "set_style", "target": "<sel>", "font": "...", "size": N, "color": [r,g,b],
                                            "bold": true/false, "italic": true/false}
    # spec-level ops (need the paired .spec.json)
    {"op": "insert_block",  "position": N, "block": {...}}
    {"op": "delete_block",  "position": N}
    {"op": "replace_block", "position": N, "block": {...}}
    {"op": "move_block",    "from": N, "to": M}
"""
from __future__ import annotations

import hashlib
import mimetypes
import pathlib
import re
import urllib.request
from dataclasses import dataclass
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree


# ---------------------------------------------------------------------------
# selector
# ---------------------------------------------------------------------------


@dataclass
class Step:
    kind: str
    index: int | None = None
    attrs: dict | None = None       # e.g. {"level": 2} or {"r":0,"c":1}


_STEP_RE = re.compile(
    r"^\s*(?P<kind>[a-zA-Z_]+)\s*(?::\s*(?P<index>\d+|last)\s*)?"
    r"(?:\[(?P<attrs>[^\]]+)\])?\s*$"
)


def parse_selector(s: str) -> list[Step]:
    if not s or not isinstance(s, str):
        raise ValueError("selector must be a non-empty string")
    steps: list[Step] = []
    for raw in s.split(">"):
        m = _STEP_RE.match(raw)
        if not m:
            raise ValueError(f"invalid selector step: {raw!r}")
        kind = m.group("kind").lower()
        idx_raw = m.group("index")
        step = Step(kind=kind)
        if idx_raw is not None:
            step.index = None if idx_raw == "last" else int(idx_raw)
            if idx_raw == "last":
                step.attrs = {"_last": True}
        attrs_raw = m.group("attrs")
        if attrs_raw:
            step.attrs = (step.attrs or {}) | _parse_attrs(attrs_raw)
        steps.append(step)
    return steps


def _parse_attrs(s: str) -> dict:
    out: dict = {}
    for pair in s.split(","):
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        try:
            out[k] = int(v)
        except ValueError:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# document walkers
# ---------------------------------------------------------------------------


def iter_paragraphs(doc) -> list:
    """All <w:p> paragraphs in body (top-level only; excludes cells/headers/footers)."""
    return list(doc.paragraphs)


def iter_headings(doc) -> list:
    """Paragraphs that use a Heading style. Returns (paragraph, level) pairs."""
    out = []
    for p in doc.paragraphs:
        sty = p.style.name if p.style else ""
        m = re.fullmatch(r"Heading (\d)", sty)
        if m:
            out.append((p, int(m.group(1))))
    return out


def iter_regular_paragraphs(doc) -> list:
    """Paragraphs that are NOT headings."""
    out = []
    for p in doc.paragraphs:
        sty = p.style.name if p.style else ""
        if not re.fullmatch(r"Heading \d", sty):
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# operations
# ---------------------------------------------------------------------------


class OpError(ValueError):
    pass


def op_set_text(doc, target: str, value: str) -> None:
    steps = parse_selector(target)
    if len(steps) != 1:
        raise OpError("set_text selector must be a single step (e.g. 'heading:2')")
    s = steps[0]
    if s.kind == "heading":
        hs = iter_headings(doc)
        if s.attrs and "level" in s.attrs:
            hs = [(p, lvl) for p, lvl in hs if lvl == s.attrs["level"]]
        if not hs:
            raise OpError("no heading matches selector")
        idx = 0 if s.index is None else s.index
        if not (0 <= idx < len(hs)):
            raise OpError(f"heading index {idx} out of range (have {len(hs)})")
        p, _ = hs[idx]
        _replace_paragraph_text(p, value)
    elif s.kind == "paragraph":
        ps = iter_regular_paragraphs(doc)
        idx = 0 if s.index is None else s.index
        if not (0 <= idx < len(ps)):
            raise OpError(f"paragraph index {idx} out of range (have {len(ps)})")
        _replace_paragraph_text(ps[idx], value)
    else:
        raise OpError(f"set_text does not support selector kind {s.kind!r}")


def _replace_paragraph_text(p, value: str) -> None:
    """Replace all runs with a single run containing `value`, preserving the
    first run's font properties if any.
    """
    proto = None
    runs = p.runs
    if runs:
        proto_element = runs[0]._r.find(qn("w:rPr"))
        if proto_element is not None:
            proto = etree.tostring(proto_element)
    # remove all runs
    for r in list(runs):
        r._r.getparent().remove(r._r)
    # add new run with old rPr
    new_run = p.add_run(value)
    if proto is not None:
        new_rPr = etree.fromstring(proto)
        new_run._r.insert(0, new_rPr)


def op_update_table_cell(doc, target: str, value: str) -> None:
    steps = parse_selector(target)
    if len(steps) != 2 or steps[0].kind != "table" or steps[1].kind != "cell":
        raise OpError("update_table_cell target must be 'table:N > cell[r=X,c=Y]'")
    t_idx = steps[0].index or 0
    tables = doc.tables
    if not (0 <= t_idx < len(tables)):
        raise OpError(f"table index {t_idx} out of range (have {len(tables)})")
    tbl = tables[t_idx]
    attrs = steps[1].attrs or {}
    r = attrs.get("r"); c = attrs.get("c")
    if r is None or c is None:
        raise OpError("cell selector needs r= and c= attributes")
    if not (0 <= r < len(tbl.rows)):
        raise OpError(f"cell row {r} out of range (have {len(tbl.rows)})")
    row = tbl.rows[r]
    if not (0 <= c < len(row.cells)):
        raise OpError(f"cell col {c} out of range (have {len(row.cells)})")
    cell = row.cells[c]
    # clear + add single paragraph/run
    paragraphs = list(cell.paragraphs)
    first_p = paragraphs[0] if paragraphs else cell.add_paragraph()
    _replace_paragraph_text(first_p, str(value))
    # drop any extra paragraphs
    for p in paragraphs[1:]:
        p._p.getparent().remove(p._p)


def op_swap_image(doc, target: str, value: str) -> None:
    """Replace the binary content of the target picture, keeping the image
    in place (same dimensions). Uses the underlying package to find the
    related image part.
    """
    steps = parse_selector(target)
    if len(steps) != 1 or steps[0].kind != "image":
        raise OpError("swap_image target must be 'image:N'")
    # find all <w:drawing><a:blip> references in body
    blips = []
    for el in doc.element.body.iter(qn("a:blip")):
        blips.append(el)
    idx = steps[0].index or 0
    if not (0 <= idx < len(blips)):
        raise OpError(f"image index {idx} out of range (have {len(blips)})")
    blip = blips[idx]
    rid = blip.get(qn("r:embed"))
    if not rid:
        raise OpError("blip has no r:embed")
    part = doc.part
    rel = part.rels.get(rid)
    if rel is None:
        raise OpError(f"rId {rid} does not resolve")
    target_part = rel.target_part
    data, ct = _fetch_image(value)
    target_part._blob = data
    # update content_type if different
    try:
        target_part.content_type = ct
    except Exception:
        pass


def _fetch_image(ref: str) -> tuple[bytes, str]:
    if ref.startswith("http://") or ref.startswith("https://"):
        with urllib.request.urlopen(ref) as r:
            data = r.read()
            ct = r.headers.get_content_type() or "image/png"
    else:
        data = pathlib.Path(ref).expanduser().read_bytes()
        guessed, _ = mimetypes.guess_type(ref)
        ct = guessed or "image/png"
    return data, ct


def op_set_style(doc, target: str, *, font: str | None = None,
                 size: int | None = None, color=None,
                 bold: bool | None = None, italic: bool | None = None) -> None:
    from docx.shared import Pt, RGBColor

    steps = parse_selector(target)
    if len(steps) != 1 or steps[0].kind not in {"heading", "paragraph"}:
        raise OpError("set_style target must be 'heading:N' or 'paragraph:N'")
    s = steps[0]
    if s.kind == "heading":
        hs = iter_headings(doc)
        idx = 0 if s.index is None else s.index
        if not (0 <= idx < len(hs)):
            raise OpError(f"heading index {idx} out of range")
        p = hs[idx][0]
    else:
        ps = iter_regular_paragraphs(doc)
        idx = 0 if s.index is None else s.index
        if not (0 <= idx < len(ps)):
            raise OpError(f"paragraph index {idx} out of range")
        p = ps[idx]

    for run in p.runs:
        if font is not None:
            run.font.name = font
        if size is not None:
            run.font.size = Pt(size)
        if bold is not None:
            run.font.bold = bold
        if italic is not None:
            run.font.italic = italic
        if color is not None:
            run.font.color.rgb = RGBColor(*[int(c) for c in color])


# ---------------------------------------------------------------------------
# spec-level ops
# ---------------------------------------------------------------------------


def apply_spec_ops(spec: dict, ops: list[dict]) -> dict:
    """Apply structural ops to a spec dict. Returns the new spec.
    Pure function — caller decides when to rebuild from the spec.
    """
    blocks = list(spec.get("blocks", []))
    for i, op in enumerate(ops):
        kind = op.get("op")
        if kind == "insert_block":
            pos = int(op["position"])
            pos = max(0, min(pos, len(blocks)))
            blocks.insert(pos, op["block"])
        elif kind == "delete_block":
            pos = int(op["position"])
            if not (0 <= pos < len(blocks)):
                raise OpError(f"op[{i}].position: out of range")
            blocks.pop(pos)
        elif kind == "replace_block":
            pos = int(op["position"])
            if not (0 <= pos < len(blocks)):
                raise OpError(f"op[{i}].position: out of range")
            blocks[pos] = op["block"]
        elif kind == "move_block":
            fr = int(op["from"]); to = int(op["to"])
            if not (0 <= fr < len(blocks)):
                raise OpError(f"op[{i}].from: out of range")
            block = blocks.pop(fr)
            to = max(0, min(to, len(blocks)))
            blocks.insert(to, block)
        else:
            raise OpError(f"op[{i}]: unknown spec-level op {kind!r}")
    return {**spec, "blocks": blocks}


# ---------------------------------------------------------------------------
# dispatcher
# ---------------------------------------------------------------------------


LIVE_OPS = {"set_text", "update_table_cell", "swap_image", "set_style"}
SPEC_OPS = {"insert_block", "delete_block", "replace_block", "move_block"}


def apply_patch(doc, spec: dict | None, patch: dict) -> tuple[bool, dict | None, list[str]]:
    """Apply the patch. Returns (spec_changed, new_spec_or_none, warnings).

    Live ops mutate `doc` in place. Spec ops rewrite `spec` and signal the
    caller to rebuild the docx from scratch. If both kinds are mixed, we
    apply live ops first, then return spec ops for the caller to rebuild.
    """
    ops = patch.get("operations")
    if not isinstance(ops, list):
        raise OpError("patch.operations must be an array")
    warnings: list[str] = []

    live_ops = [op for op in ops if op.get("op") in LIVE_OPS]
    spec_ops = [op for op in ops if op.get("op") in SPEC_OPS]
    unknown = [op for op in ops if op.get("op") not in (LIVE_OPS | SPEC_OPS)]
    if unknown:
        raise OpError(f"unknown op(s): {[o.get('op') for o in unknown]}")

    for i, op in enumerate(live_ops):
        kind = op["op"]
        try:
            if kind == "set_text":
                op_set_text(doc, op["target"], op["value"])
            elif kind == "update_table_cell":
                op_update_table_cell(doc, op["target"], op["value"])
            elif kind == "swap_image":
                op_swap_image(doc, op["target"], op["value"])
            elif kind == "set_style":
                op_set_style(
                    doc, op["target"],
                    font=op.get("font"), size=op.get("size"), color=op.get("color"),
                    bold=op.get("bold"), italic=op.get("italic"),
                )
        except OpError as e:
            raise OpError(f"op[{i}] ({kind}): {e}") from None

    new_spec = None
    spec_changed = False
    if spec_ops:
        if spec is None:
            raise OpError(
                "spec-level op(s) used but no .spec.json was found. "
                "Either provide --spec, or use only live ops "
                "(set_text / update_table_cell / swap_image / set_style)."
            )
        new_spec = apply_spec_ops(spec, spec_ops)
        spec_changed = True

    return spec_changed, new_spec, warnings
