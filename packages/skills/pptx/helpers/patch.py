"""Patch DSL — declarative edits for an OPC-loaded pptx.

Selector grammar (CSS-ish, slides are zero-indexed):

    slide:N                      → the N-th slide part
    slide:last                   → the last slide
    slide:N > title              → the title placeholder's text box on slide N
    slide:N > subtitle           → the subtitle placeholder
    slide:N > body               → the body placeholder (for bullets slides)
    slide:N > bullet:K           → the K-th paragraph of the body placeholder
    slide:N > notes              → speaker notes text
    slide:N > chart              → the (first) chart's target part
    slide:N > chart:K            → the K-th chart
    slide:N > image              → the (first) picture
    slide:N > image:K            → the K-th picture

Patch operations (each is a JSON object in the `operations` array):

    {"op": "set_text",        "target": "<sel>",     "value": "..."}
    {"op": "replace_bullets", "target": "slide:N",   "value": [...]}
    {"op": "set_notes",       "target": "slide:N",   "value": "..."}
    {"op": "delete_slide",    "target": "slide:N"}
    {"op": "move_slide",      "from": N, "to": M}
    {"op": "insert_slide",    "position": N, "slide": <spec>}
    {"op": "swap_image",      "target": "slide:N > image[:K]", "value": "path_or_url"}
    {"op": "update_chart",    "target": "slide:N > chart[:K]",
                              "categories": [...], "series": [{"name":..., "values":[...]}]}
    {"op": "set_style",       "target": "<sel>", "font":..., "size":..., "color":[r,g,b],
                              "bold":..., "italic":...}

Mutations happen in-memory on the Package; call pkg.save(out) when done.
A Transaction wraps a series of ops so a failure mid-way reverts cleanly.
"""
from __future__ import annotations

import copy
import hashlib
import mimetypes
import posixpath
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lxml import etree

from .opc import (
    CT_IMAGE_JPG,
    CT_IMAGE_PNG,
    CT_SLIDE,
    Package,
    Part,
    RT_IMAGE,
    RT_NOTES,
    RT_SLIDE,
)


# ---------------------------------------------------------------------------
# namespaces (commonly needed)
# ---------------------------------------------------------------------------

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"

NSMAP = {"a": A, "p": P, "r": R, "c": C}


# ---------------------------------------------------------------------------
# selector
# ---------------------------------------------------------------------------


@dataclass
class Step:
    kind: str                   # slide | title | subtitle | body | bullet | notes | chart | image | shape | table | cell
    index: int | None = None    # numeric index, or None
    special: str | None = None  # "last" for slide:last
    attrs: dict | None = None   # bracket-form attrs, e.g. cell[r=2,c=1] → {"r": 2, "c": 1}


_STEP_RE = re.compile(
    r"^\s*(?P<kind>[a-zA-Z_]+)"
    r"(?:\s*:\s*(?P<index>\d+|last))?"
    r"(?:\s*\[\s*(?P<attrs>[^\]]+)\s*\])?"
    r"\s*$"
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
        attrs_raw = m.group("attrs")
        step = Step(kind=kind)
        if idx_raw is not None:
            if idx_raw == "last":
                step.special = "last"
            else:
                step.index = int(idx_raw)
        if attrs_raw is not None:
            attrs: dict = {}
            for kv in attrs_raw.split(","):
                if "=" not in kv:
                    raise ValueError(f"invalid bracket attr {kv!r} in {raw!r}")
                k, v = kv.split("=", 1)
                k = k.strip(); v = v.strip()
                attrs[k] = int(v) if v.lstrip("-").isdigit() else v
            step.attrs = attrs
        steps.append(step)
    return steps


# ---------------------------------------------------------------------------
# slide resolution
# ---------------------------------------------------------------------------


def list_slide_parts(pkg: Package) -> list[Part]:
    """Return slide parts in presentation order (by <p:sldId> sequence)."""
    main = pkg.main_document()
    root = main.xml()
    sld_id_list = root.find(f"{{{P}}}sldIdLst")
    if sld_id_list is None:
        return []
    slides: list[Part] = []
    for sld_id in sld_id_list:
        rid = sld_id.get(f"{{{R}}}id")
        related = pkg.related_one(main, rid)
        if related is not None:
            slides.append(related)
    return slides


def resolve_slide(pkg: Package, steps: list[Step]) -> Part:
    if not steps or steps[0].kind != "slide":
        raise ValueError("selector must start with 'slide:...'")
    slides = list_slide_parts(pkg)
    if not slides:
        raise ValueError("presentation has no slides")
    head = steps[0]
    if head.special == "last":
        return slides[-1]
    if head.index is None:
        raise ValueError("slide step requires an index (e.g. slide:2)")
    if not (0 <= head.index < len(slides)):
        raise IndexError(f"slide index {head.index} out of range (have {len(slides)})")
    return slides[head.index]


# ---------------------------------------------------------------------------
# placeholder / shape discovery inside a slide
# ---------------------------------------------------------------------------


_PLACEHOLDER_TYPES = {
    "title":    {"title", "ctrTitle"},
    "subtitle": {"subTitle"},
    "body":     {"body", None},   # body has no explicit type attr in some cases
}


def _placeholder_shape(slide_root: etree._Element, kind: str) -> etree._Element | None:
    """Find the shape that best matches `kind` ('title', 'subtitle', 'body').

    Strategy:
      1. Proper placeholder: <p:ph type="title|ctrTitle|subTitle|body">.
      2. Fallback (for decks authored without placeholders — e.g. our own
         spec renderers which use raw text boxes): rank shapes by position
         and size. Title = topmost text-bearing shape. Body = shape with
         the most paragraphs after the title.
    """
    wanted = _PLACEHOLDER_TYPES.get(kind)
    if wanted is None:
        return None

    # 1. proper placeholder lookup
    for sp in slide_root.iter(f"{{{P}}}sp"):
        ph = sp.find(f".//{{{P}}}nvSpPr/{{{P}}}nvPr/{{{P}}}ph")
        if ph is None:
            continue
        ph_type = ph.get("type")
        if ph_type in wanted:
            return sp
    if kind == "body":
        for sp in slide_root.iter(f"{{{P}}}sp"):
            ph = sp.find(f".//{{{P}}}nvSpPr/{{{P}}}nvPr/{{{P}}}ph")
            if ph is not None and ph.get("idx") == "1":
                return sp

    # 2. fallback — ranked by geometry/content
    sps_with_text = [sp for sp in slide_root.iter(f"{{{P}}}sp") if _get_sp_text(sp).strip()]
    if not sps_with_text:
        return None

    # sort top-to-bottom by the shape's y offset (EMU)
    def _y(sp: etree._Element) -> int:
        off = sp.find(f".//{{{P}}}spPr/{{{A}}}xfrm/{{{A}}}off")
        if off is not None and off.get("y") is not None:
            try:
                return int(off.get("y"))
            except ValueError:
                return 0
        return 0

    sps_sorted = sorted(sps_with_text, key=_y)

    if kind == "title":
        return sps_sorted[0]
    if kind == "subtitle":
        # second-topmost with a single line or short text
        for sp in sps_sorted[1:]:
            txt = _get_sp_text(sp).strip()
            if txt and "\n" not in txt and len(txt) < 200:
                return sp
        return sps_sorted[1] if len(sps_sorted) > 1 else None
    if kind == "body":
        # the shape with the most paragraphs below the title
        candidates = sps_sorted[1:]
        if not candidates:
            return None
        def _para_count(sp):
            return len(sp.findall(f"{{{P}}}txBody/{{{A}}}p"))
        candidates.sort(key=_para_count, reverse=True)
        return candidates[0]
    return None


def _pictures(slide_root: etree._Element) -> list[etree._Element]:
    return list(slide_root.iter(f"{{{P}}}pic"))


def _graphic_frames(slide_root: etree._Element, uri_filter: str | None = None) -> list[etree._Element]:
    frames = list(slide_root.iter(f"{{{P}}}graphicFrame"))
    if uri_filter is None:
        return frames
    out = []
    for gf in frames:
        gd = gf.find(f".//{{{A}}}graphicData")
        if gd is not None and gd.get("uri") == uri_filter:
            out.append(gf)
    return out


def _charts(slide_root: etree._Element) -> list[etree._Element]:
    """Returns <p:graphicFrame> elements that wrap a chart."""
    return _graphic_frames(slide_root, uri_filter=C)


_TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table"


def _tables(slide_root: etree._Element) -> list[etree._Element]:
    """Returns <p:graphicFrame> elements that wrap an a:tbl."""
    return _graphic_frames(slide_root, uri_filter=_TABLE_URI)


# ---------------------------------------------------------------------------
# text helpers
# ---------------------------------------------------------------------------


def _set_sp_text(sp: etree._Element, value: str) -> None:
    """Replace the entire text content of a shape with `value` (single paragraph).
    Preserves the first run's formatting if one exists; drops extra runs/paragraphs.
    """
    tx_body = sp.find(f"{{{P}}}txBody")
    if tx_body is None:
        return

    # preserve the first run's rPr if any, so font/size/color stay
    first_rPr = None
    for p in tx_body.findall(f"{{{A}}}p"):
        r = p.find(f"{{{A}}}r")
        if r is not None:
            rPr = r.find(f"{{{A}}}rPr")
            if rPr is not None:
                first_rPr = copy.deepcopy(rPr)
                break

    # remove all existing paragraphs
    for p in tx_body.findall(f"{{{A}}}p"):
        tx_body.remove(p)

    p = etree.SubElement(tx_body, f"{{{A}}}p")
    r = etree.SubElement(p, f"{{{A}}}r")
    if first_rPr is not None:
        r.append(first_rPr)
    t = etree.SubElement(r, f"{{{A}}}t")
    t.text = value


def _get_sp_text(sp: etree._Element) -> str:
    tx = sp.find(f"{{{P}}}txBody")
    if tx is None:
        return ""
    parts: list[str] = []
    for p in tx.findall(f"{{{A}}}p"):
        run_texts = [t.text or "" for t in p.iter(f"{{{A}}}t")]
        parts.append("".join(run_texts))
    return "\n".join(parts)


def _replace_bullets(body_sp: etree._Element, bullets: list) -> None:
    """Replace paragraphs in a body placeholder with new bullets.
    Supports nested: ['parent', ['child1', 'child2']] — a list immediately after a string nests.
    """
    tx_body = body_sp.find(f"{{{P}}}txBody")
    if tx_body is None:
        return

    # preserve first rPr
    proto_rPr = None
    for p in tx_body.findall(f"{{{A}}}p"):
        r = p.find(f"{{{A}}}r")
        if r is not None:
            rPr = r.find(f"{{{A}}}rPr")
            if rPr is not None:
                proto_rPr = copy.deepcopy(rPr)
                break

    for p in tx_body.findall(f"{{{A}}}p"):
        tx_body.remove(p)

    _emit_bullets(tx_body, bullets, level=0, proto_rPr=proto_rPr)


def _emit_bullets(parent_tx: etree._Element, items: list, level: int,
                  proto_rPr: etree._Element | None) -> None:
    i = 0
    while i < len(items):
        it = items[i]
        if isinstance(it, str):
            p = etree.SubElement(parent_tx, f"{{{A}}}p")
            pPr = etree.SubElement(p, f"{{{A}}}pPr")
            pPr.set("lvl", str(level))
            r = etree.SubElement(p, f"{{{A}}}r")
            if proto_rPr is not None:
                r.append(copy.deepcopy(proto_rPr))
            t = etree.SubElement(r, f"{{{A}}}t")
            t.text = it
            if i + 1 < len(items) and isinstance(items[i + 1], list):
                _emit_bullets(parent_tx, items[i + 1], level + 1, proto_rPr)
                i += 2
                continue
        i += 1


# ---------------------------------------------------------------------------
# operations
# ---------------------------------------------------------------------------


class OpError(ValueError):
    """Raised when a patch op can't be carried out against the current document."""


def op_set_text(pkg: Package, target: str, value: str) -> None:
    steps = parse_selector(target)
    slide_part = resolve_slide(pkg, steps)
    if len(steps) < 2:
        raise OpError(f"set_text requires a second step (e.g. slide:N > title), got {target!r}")
    target_kind = steps[1].kind
    slide_root = slide_part.xml()

    if target_kind in _PLACEHOLDER_TYPES:
        sp = _placeholder_shape(slide_root, target_kind)
        if sp is None:
            raise OpError(f"no {target_kind} placeholder on {target}")
        _set_sp_text(sp, value)
    elif target_kind == "bullet":
        body = _placeholder_shape(slide_root, "body")
        if body is None:
            raise OpError(f"no body on {target}")
        idx = steps[1].index or 0
        tx = body.find(f"{{{P}}}txBody")
        paras = tx.findall(f"{{{A}}}p")
        if not (0 <= idx < len(paras)):
            raise OpError(f"bullet index {idx} out of range (have {len(paras)})")
        p = paras[idx]
        # remove all runs, keep pPr, add new run
        pPr = p.find(f"{{{A}}}pPr")
        proto_rPr = None
        r0 = p.find(f"{{{A}}}r")
        if r0 is not None:
            proto_rPr = copy.deepcopy(r0.find(f"{{{A}}}rPr"))
        for child in list(p):
            if child.tag != f"{{{A}}}pPr":
                p.remove(child)
        new_r = etree.SubElement(p, f"{{{A}}}r")
        if proto_rPr is not None:
            new_r.append(proto_rPr)
        t = etree.SubElement(new_r, f"{{{A}}}t")
        t.text = value
    else:
        raise OpError(f"set_text does not support target kind {target_kind!r}")

    slide_part.set_xml(slide_root)


def op_replace_bullets(pkg: Package, target: str, value: list) -> None:
    steps = parse_selector(target)
    slide_part = resolve_slide(pkg, steps)
    slide_root = slide_part.xml()
    body = _placeholder_shape(slide_root, "body")
    if body is None:
        raise OpError(f"no body placeholder on {target}")
    _replace_bullets(body, value)
    slide_part.set_xml(slide_root)


def op_set_notes(pkg: Package, target: str, value: str) -> None:
    steps = parse_selector(target)
    slide_part = resolve_slide(pkg, steps)
    notes_parts = pkg.related(slide_part, RT_NOTES)
    if not notes_parts:
        # create a notes part — rare; skip for now with a clear error
        raise OpError("slide has no notes part yet — set_notes on a slide without notes is not supported")
    notes_part = notes_parts[0]
    root = notes_part.xml()
    # find the notes body placeholder (idx="1" typically) or any txBody
    body = None
    for sp in root.iter(f"{{{P}}}sp"):
        ph = sp.find(f".//{{{P}}}nvSpPr/{{{P}}}nvPr/{{{P}}}ph")
        if ph is not None and ph.get("type") == "body":
            body = sp
            break
    if body is None:
        raise OpError("notes slide has no body placeholder")
    _set_sp_text(body, value)
    notes_part.set_xml(root)


def op_delete_slide(pkg: Package, target: str) -> None:
    steps = parse_selector(target)
    slide_part = resolve_slide(pkg, steps)

    # also drop the slide's notes part if any (cascade)
    notes_parts = pkg.related(slide_part, RT_NOTES)

    # remove from presentation's sldIdLst + its rel
    main = pkg.main_document()
    main_root = main.xml()
    sld_id_list = main_root.find(f"{{{P}}}sldIdLst")
    if sld_id_list is not None:
        for sld_id in list(sld_id_list):
            rid = sld_id.get(f"{{{R}}}id")
            related = pkg.related_one(main, rid)
            if related is slide_part:
                sld_id_list.remove(sld_id)
                main.rels = [r for r in main.rels if r.rId != rid]
                break
    main.set_xml(main_root)

    # now drop the part (cascades through Package.drop_part)
    pkg.drop_part(slide_part.partname, cascade_rels=True)
    for np in notes_parts:
        pkg.drop_part(np.partname, cascade_rels=True)


def op_move_slide(pkg: Package, from_idx: int, to_idx: int) -> None:
    main = pkg.main_document()
    root = main.xml()
    sld_id_list = root.find(f"{{{P}}}sldIdLst")
    if sld_id_list is None:
        raise OpError("presentation has no sldIdLst")
    children = list(sld_id_list)
    if not (0 <= from_idx < len(children)):
        raise OpError(f"from_idx {from_idx} out of range")
    if not (0 <= to_idx < len(children)):
        raise OpError(f"to_idx {to_idx} out of range")
    item = children[from_idx]
    sld_id_list.remove(item)
    # reinsert at new position (index shifts after removal, so insert as-is)
    siblings = list(sld_id_list)
    target = min(to_idx, len(siblings))
    sld_id_list.insert(target, item)
    main.set_xml(root)


def op_swap_image(pkg: Package, target: str, value: str) -> None:
    """Replace the binary blob of the image referenced by the target picture.

    Target form: 'slide:N > image' or 'slide:N > image:K'.
    `value` is a local path or http(s) URL; image is fetched and the existing
    media part is replaced in place (no rId juggling).
    """
    steps = parse_selector(target)
    if len(steps) < 2 or steps[1].kind != "image":
        raise OpError("swap_image target must be 'slide:N > image[:K]'")
    slide_part = resolve_slide(pkg, steps)
    slide_root = slide_part.xml()
    pics = _pictures(slide_root)
    idx = steps[1].index or 0
    if not (0 <= idx < len(pics)):
        raise OpError(f"image index {idx} out of range (have {len(pics)})")
    pic = pics[idx]
    blip = pic.find(f".//{{{A}}}blip")
    if blip is None:
        raise OpError("picture has no blip reference")
    rid = blip.get(f"{{{R}}}embed")
    if rid is None:
        raise OpError("picture blip has no r:embed rId")
    image_part = pkg.related_one(slide_part, rid)
    if image_part is None:
        raise OpError(f"image rId {rid} does not resolve to a part")

    new_blob, new_ct = _fetch_image(value)
    image_part.blob = new_blob
    image_part.content_type = new_ct
    # keep the partname — we only swap bytes. Content-type override may need updating:
    pkg.content_types.overrides[image_part.partname] = new_ct


def _fetch_image(ref: str) -> tuple[bytes, str]:
    if ref.startswith("http://") or ref.startswith("https://"):
        with urllib.request.urlopen(ref) as r:
            data = r.read()
            ct = r.headers.get_content_type() or "image/png"
    else:
        data = Path(ref).expanduser().read_bytes()
        guessed, _ = mimetypes.guess_type(ref)
        ct = guessed or CT_IMAGE_PNG
    if ct not in {CT_IMAGE_PNG, CT_IMAGE_JPG, "image/gif", "image/bmp", "image/tiff"}:
        ct = CT_IMAGE_PNG  # best-effort default
    return data, ct


def op_insert_slide(pkg: Package, position: int, slide_spec: dict) -> None:
    """Render `slide_spec` using the existing renderers (lib/), then copy the
    resulting slide + media parts into `pkg` at `position`.

    Strategy:
      1. Build a temp 1-slide .pptx via lib.build path.
      2. Open that as an OPC package.
      3. Copy the one slide part + any media/chart parts it references.
      4. Rename to non-colliding partnames inside `pkg`.
      5. Add a <p:sldId> at the desired position in the main presentation.
    """
    # Build the source (temp .pptx)
    import sys
    import tempfile
    import pathlib

    skill_root = pathlib.Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(skill_root))
    from pptx import Presentation
    from pptx.util import Inches

    from lib.layouts import SIZES, Grid  # noqa: E402
    from lib.renderers import RENDERERS  # noqa: E402
    from lib.spec import SpecError, validate  # noqa: E402
    from lib.themes import get_theme  # noqa: E402

    # Validate slide_spec before we go anywhere near the renderer — fail
    # early with a clear field path instead of a deep stack trace.
    try:
        validate({"slides": [slide_spec]})
    except SpecError as e:
        raise OpError(f"insert_slide: invalid slide spec: {e}") from None

    theme = get_theme("default")
    grid = Grid(size="16:9")

    prs = Presentation()
    w, h = SIZES["16:9"]
    prs.slide_width = Inches(w)
    prs.slide_height = Inches(h)
    blank_layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(blank_layout)
    renderer = RENDERERS.get(slide_spec.get("type"))
    if renderer is None:
        raise OpError(f"unknown slide type: {slide_spec.get('type')!r}")
    renderer(slide, slide_spec, theme, grid)

    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
        tmp_path = f.name
    prs.save(tmp_path)

    src = Package.open(tmp_path)
    src_main = src.main_document()
    src_slides = list_slide_parts(src)
    if not src_slides:
        raise OpError("built temp pptx has no slides")
    src_slide = src_slides[0]

    # Figure out which parts to copy: the slide + anything it references transitively
    # (images, charts), EXCLUDING layouts/masters/theme (those come from pkg's own).
    copy_set: dict[str, Part] = {src_slide.partname: src_slide}
    _collect_slide_media(src, src_slide, copy_set)

    # Allocate new partnames inside pkg and rename references
    rename_map: dict[str, str] = {}
    for old_partname in list(copy_set.keys()):
        part = copy_set[old_partname]
        if "slides/slide" in old_partname:
            new_pn = pkg.next_partname("/ppt/slides/slide%d.xml")
        elif "charts/chart" in old_partname:
            new_pn = pkg.next_partname("/ppt/charts/chart%d.xml")
        elif "embeddings/" in old_partname:
            ext = posixpath.splitext(old_partname)[1]
            new_pn = pkg.next_partname(f"/ppt/embeddings/Microsoft_Excel_Worksheet%d{ext}")
        elif old_partname.startswith("/ppt/media/"):
            ext = posixpath.splitext(old_partname)[1]
            new_pn = pkg.next_partname(f"/ppt/media/image%d{ext}")
        else:
            ext = posixpath.splitext(old_partname)[1]
            new_pn = pkg.next_partname(f"/ppt/misc/part%d{ext}")
        rename_map[old_partname] = new_pn

    # Deep-copy parts into pkg under new names
    for old_pn, part in copy_set.items():
        new_pn = rename_map[old_pn]
        cloned = Part(
            partname=new_pn,
            content_type=part.content_type,
            blob=bytes(part.blob),
            rels=[_clone_rel_rewriting(r, part.partname, new_pn, rename_map) for r in part.rels],
        )
        pkg.add_part(cloned)

    # Now link the new slide into the main presentation.
    # The new slide must also relate to an existing slide layout — we point it
    # at the first slideLayout in the target package to avoid bringing a new one over.
    new_slide_pn = rename_map[src_slide.partname]
    new_slide = pkg.part(new_slide_pn)
    _ensure_slide_layout_rel(pkg, new_slide)

    main = pkg.main_document()
    new_rid = pkg.add_relationship(main, RT_SLIDE, new_slide_pn)

    main_root = main.xml()
    sld_id_list = main_root.find(f"{{{P}}}sldIdLst")
    if sld_id_list is None:
        sld_id_list = etree.SubElement(main_root, f"{{{P}}}sldIdLst")
    next_sld_id = _next_sld_id(sld_id_list)
    new_sld_id = etree.Element(f"{{{P}}}sldId")
    new_sld_id.set("id", str(next_sld_id))
    new_sld_id.set(f"{{{R}}}id", new_rid)

    pos = max(0, min(position, len(sld_id_list)))
    sld_id_list.insert(pos, new_sld_id)
    main.set_xml(main_root)

    # clean temp
    Path(tmp_path).unlink(missing_ok=True)


def _collect_slide_media(pkg: Package, slide_part: Part, out: dict[str, Part]) -> None:
    """Collect slide's image/chart parts (and chart's embedded xlsx) into `out`.
    Does NOT follow layout/master/theme — those are shared infrastructure.
    """
    for rel in slide_part.rels:
        if rel.mode != "Internal":
            continue
        if rel.type not in {RT_IMAGE, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"}:
            continue
        tgt_pn = rel.target_partname(slide_part.partname)
        if tgt_pn is None:
            continue
        tgt = pkg.part(tgt_pn)
        if tgt is None or tgt.partname in out:
            continue
        out[tgt.partname] = tgt
        # charts have their own dependencies (embeddings)
        for subrel in tgt.rels:
            if subrel.mode != "Internal":
                continue
            sub_pn = subrel.target_partname(tgt.partname)
            sub = pkg.part(sub_pn) if sub_pn else None
            if sub is not None and sub.partname not in out:
                out[sub.partname] = sub


def _clone_rel_rewriting(rel, old_owner: str, new_owner: str, rename_map: dict[str, str]):
    """Clone a Relationship, re-resolving its target if the target is being
    renamed (i.e. inside rename_map).
    """
    from .opc import Relationship
    tgt_pn = rel.target_partname(old_owner)
    if rel.mode == "Internal" and tgt_pn and tgt_pn in rename_map:
        new_tgt = rename_map[tgt_pn]
        new_target = posixpath.relpath(new_tgt, posixpath.dirname(new_owner))
        return Relationship(rId=rel.rId, type=rel.type, target=new_target, mode=rel.mode)
    return Relationship(rId=rel.rId, type=rel.type, target=rel.target, mode=rel.mode)


def _ensure_slide_layout_rel(pkg: Package, slide_part: Part) -> None:
    """Make sure the new slide relates to some slideLayout in the target pkg.
    If its own rels already include a slideLayout rel, skip. Otherwise attach
    the first layout we find in pkg.
    """
    rt_layout = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
    if any(r.type == rt_layout for r in slide_part.rels):
        # the rel target was probably rewritten — but it may point into a temp
        # layout partname that doesn't exist in pkg. Fix that.
        for r in list(slide_part.rels):
            if r.type == rt_layout:
                tgt = r.target_partname(slide_part.partname)
                if tgt is None or tgt not in pkg.parts:
                    slide_part.rels.remove(r)
    # if we removed (or never had) a layout rel, add one
    if not any(r.type == rt_layout for r in slide_part.rels):
        # find first slideLayout in pkg
        for p in pkg.parts.values():
            if "slideLayouts/slideLayout" in p.partname and p.partname.endswith(".xml"):
                pkg.add_relationship(slide_part, rt_layout, p.partname)
                break


def _next_sld_id(sld_id_list: etree._Element) -> int:
    used = {int(el.get("id")) for el in sld_id_list if el.get("id") and el.get("id").isdigit()}
    # pptx convention: start at 256
    i = 256
    while i in used:
        i += 1
    return i


def op_update_table_cell(pkg: Package, target: str, value: str) -> None:
    """Replace the text of a single table cell.

    Selector: ``slide:N > table[:K] > cell[r=R,c=C]`` — zero-based row/col
    indexes including the header row. Preserves the cell's first run rPr
    (font/size/color) so styling survives the edit.
    """
    steps = parse_selector(target)
    slide_part = resolve_slide(pkg, steps)
    if len(steps) < 3:
        raise OpError(
            "update_table_cell needs three steps: 'slide:N > table[:K] > cell[r=R,c=C]'"
        )
    if steps[1].kind != "table":
        raise OpError(f"second step must be 'table' or 'table:K', got {steps[1].kind!r}")
    if steps[2].kind != "cell" or not steps[2].attrs:
        raise OpError("third step must be 'cell[r=R,c=C]'")
    r_idx = steps[2].attrs.get("r")
    c_idx = steps[2].attrs.get("c")
    if not isinstance(r_idx, int) or not isinstance(c_idx, int):
        raise OpError("cell selector requires integer r= and c= attributes")

    slide_root = slide_part.xml()
    tbls = _tables(slide_root)
    if not tbls:
        raise OpError(f"no tables on {target}")
    tbl_idx = steps[1].index or 0
    if not (0 <= tbl_idx < len(tbls)):
        raise OpError(f"table index {tbl_idx} out of range (have {len(tbls)})")
    tbl_frame = tbls[tbl_idx]
    tbl = tbl_frame.find(f".//{{{A}}}tbl")
    if tbl is None:
        raise OpError("graphicFrame has no <a:tbl>")
    rows = tbl.findall(f"{{{A}}}tr")
    if not (0 <= r_idx < len(rows)):
        raise OpError(f"row {r_idx} out of range (have {len(rows)})")
    cells = rows[r_idx].findall(f"{{{A}}}tc")
    if not (0 <= c_idx < len(cells)):
        raise OpError(f"col {c_idx} out of range (have {len(cells)})")
    tc = cells[c_idx]
    tx_body = tc.find(f"{{{A}}}txBody")
    if tx_body is None:
        # add empty body so we have somewhere to write
        tx_body = etree.SubElement(tc, f"{{{A}}}txBody")
        etree.SubElement(tx_body, f"{{{A}}}bodyPr")
        etree.SubElement(tx_body, f"{{{A}}}lstStyle")

    # preserve first rPr
    proto_rPr = None
    for p in tx_body.findall(f"{{{A}}}p"):
        r = p.find(f"{{{A}}}r")
        if r is not None:
            rPr = r.find(f"{{{A}}}rPr")
            if rPr is not None:
                proto_rPr = copy.deepcopy(rPr)
                break

    for p in tx_body.findall(f"{{{A}}}p"):
        tx_body.remove(p)

    p = etree.SubElement(tx_body, f"{{{A}}}p")
    r = etree.SubElement(p, f"{{{A}}}r")
    if proto_rPr is not None:
        r.append(proto_rPr)
    t = etree.SubElement(r, f"{{{A}}}t")
    t.text = value
    slide_part.set_xml(slide_root)


def op_set_style(pkg: Package, target: str, *, font: str | None = None,
                 size: int | None = None, color: tuple[int, int, int] | list | None = None,
                 bold: bool | None = None, italic: bool | None = None) -> None:
    """Set font-level style on a placeholder text target.

    Only affects text runs — other shape-level styling (fill, borders) is not
    changed. Target must resolve to a title/subtitle/body placeholder or to a
    specific bullet.
    """
    steps = parse_selector(target)
    slide_part = resolve_slide(pkg, steps)
    if len(steps) < 2:
        raise OpError("set_style requires a sub-selector (e.g. slide:N > title)")
    slide_root = slide_part.xml()
    target_kind = steps[1].kind

    if target_kind in _PLACEHOLDER_TYPES:
        sp = _placeholder_shape(slide_root, target_kind)
        if sp is None:
            raise OpError(f"no {target_kind} placeholder on {target}")
        paragraphs = sp.findall(f"{{{P}}}txBody/{{{A}}}p")
    elif target_kind == "bullet":
        body = _placeholder_shape(slide_root, "body")
        if body is None:
            raise OpError("no body placeholder")
        all_paras = body.findall(f"{{{P}}}txBody/{{{A}}}p")
        idx = steps[1].index or 0
        if not (0 <= idx < len(all_paras)):
            raise OpError(f"bullet index {idx} out of range")
        paragraphs = [all_paras[idx]]
    else:
        raise OpError(f"set_style cannot target kind {target_kind!r}")

    runs_touched = 0
    for p in paragraphs:
        for r in p.findall(f"{{{A}}}r"):
            runs_touched += 1
            rPr = r.find(f"{{{A}}}rPr")
            if rPr is None:
                rPr = etree.SubElement(r, f"{{{A}}}rPr")
                r.insert(0, rPr)
            if size is not None:
                rPr.set("sz", str(int(size * 100)))  # pptx size is in 1/100 pt
            if bold is not None:
                rPr.set("b", "1" if bold else "0")
            if italic is not None:
                rPr.set("i", "1" if italic else "0")
            if font is not None:
                # write all three typeface slots so non-Latin text survives
                for tag in ("latin", "ea", "cs"):
                    for child in rPr.findall(f"{{{A}}}{tag}"):
                        rPr.remove(child)
                    etree.SubElement(rPr, f"{{{A}}}{tag}", typeface=font)
            if color is not None:
                for child in rPr.findall(f"{{{A}}}solidFill"):
                    rPr.remove(child)
                fill = etree.SubElement(rPr, f"{{{A}}}solidFill")
                hex_ = "{:02X}{:02X}{:02X}".format(*[int(c) for c in color])
                etree.SubElement(fill, f"{{{A}}}srgbClr", val=hex_)

    slide_part.set_xml(slide_root)
    return runs_touched


# ---------------------------------------------------------------------------
# dispatcher
# ---------------------------------------------------------------------------


DISPATCH = {
    "set_text": lambda pkg, op: op_set_text(pkg, op["target"], op["value"]),
    "replace_bullets": lambda pkg, op: op_replace_bullets(pkg, op["target"], op["value"]),
    "set_notes": lambda pkg, op: op_set_notes(pkg, op["target"], op["value"]),
    "delete_slide": lambda pkg, op: op_delete_slide(pkg, op["target"]),
    "move_slide": lambda pkg, op: op_move_slide(pkg, op["from"], op["to"]),
    "insert_slide": lambda pkg, op: op_insert_slide(pkg, op["position"], op["slide"]),
    "swap_image": lambda pkg, op: op_swap_image(pkg, op["target"], op["value"]),
    "update_table_cell": lambda pkg, op: op_update_table_cell(pkg, op["target"], op["value"]),
    "set_style": lambda pkg, op: op_set_style(
        pkg, op["target"],
        font=op.get("font"), size=op.get("size"), color=op.get("color"),
        bold=op.get("bold"), italic=op.get("italic"),
    ),
    # update_chart handled via chart_data.py — see apply_patch below
}


def _patch_warnings(i: int, op: dict, result) -> list[str]:
    """Generate non-fatal warnings for an op that already executed.

    Mirrors lib.spec.validate's build-time warnings so the LLM hears about
    overflow risks during edits too — replace_bullets bombing 20 items into
    a slide, insert_slide adding a 30-row table, etc.
    """
    out: list[str] = []
    kind = op.get("op")
    here = f"op[{i}] ({kind})"
    if kind == "replace_bullets":
        n = _count_value_bullets(op.get("value"))
        if n > 9:
            out.append(f"{here}: {n} bullets — may overflow slide")
    elif kind == "insert_slide":
        spec = op.get("slide") or {}
        if spec.get("type") == "table":
            rows = spec.get("rows") or []
            if len(rows) > 12:
                out.append(
                    f"{here}: table has {len(rows)} rows — renderer truncates to 12"
                )
        if spec.get("type") == "bullets":
            n = _count_value_bullets(spec.get("bullets"))
            if n > 9:
                out.append(f"{here}: {n} bullets — may overflow")
        if spec.get("type") == "chart":
            ser = spec.get("series") or []
            if len(ser) > 6:
                out.append(f"{here}: {len(ser)} chart series — legend may overflow")
    elif kind == "set_style" and isinstance(result, int) and result == 0:
        out.append(f"{here}: matched 0 runs — selector may not have text yet")
    return out


def _count_value_bullets(items) -> int:
    if not isinstance(items, list):
        return 0
    n = 0
    for it in items:
        if isinstance(it, str):
            n += 1
        elif isinstance(it, list):
            n += _count_value_bullets(it)
    return n


def apply_patch(pkg: Package, patch: dict) -> list[str]:
    """Apply all ops in `patch['operations']` to `pkg` (in-place).
    Returns a list of human-readable warnings. Raises OpError on fatal errors.

    NOTE: This is not truly atomic — if op 5 fails, ops 1-4 are already applied.
    For full rollback, the caller should open a fresh Package and apply on it;
    that way the original file only gets overwritten if save() succeeds.
    """
    ops = patch.get("operations")
    if not isinstance(ops, list):
        raise OpError("patch.operations must be an array")
    warnings: list[str] = []
    for i, op in enumerate(ops):
        kind = op.get("op")
        result = None
        if kind == "update_chart":
            from .chart_data import op_update_chart
            op_update_chart(pkg, op["target"],
                            categories=op.get("categories"),
                            series=op.get("series"))
        elif kind in DISPATCH:
            try:
                result = DISPATCH[kind](pkg, op)
            except OpError as e:
                raise OpError(f"op[{i}] ({kind}): {e}") from None
        else:
            raise OpError(f"op[{i}]: unknown op {kind!r}")
        warnings.extend(_patch_warnings(i, op, result))
    return warnings
