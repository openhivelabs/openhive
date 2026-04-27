#!/usr/bin/env python3
"""Validate a .pptx for structural sanity.

Checks:
  1. Every .xml / .rels part is well-formed XML (lxml parse).
  2. [Content_Types].xml declares an Override or Default for every part.
  3. Every Internal relationship target resolves to a real part inside
     the package.
  4. The presentation has at least one slide and a sldIdLst.

This catches the failure modes that produce PowerPoint's "PowerPoint
found a problem with content" / Keynote's "recovered file" dialog —
malformed XML, dangling relationships, missing content-type overrides.

Usage:
    python validate_deck.py --in deck.pptx

On success prints {"ok": true, "parts": N, "warnings": [...]}.
On failure prints {"ok": false, "error": "...", "details": [...]} with
exit code 1.
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

from lxml import etree


CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="Path to .pptx")
    args = ap.parse_args()

    src = Path(args.inp).expanduser()
    if not src.exists():
        return _fail(f"file not found: {src}")
    if src.suffix.lower() != ".pptx":
        # Not fatal — some tools rename. Just a soft note via warnings.
        pass

    try:
        zf = zipfile.ZipFile(src)
    except zipfile.BadZipFile as e:
        return _fail(f"not a valid zip / pptx: {e}")

    with zf:
        names = zf.namelist()
        warnings: list[str] = []
        details: list[str] = []

        # 1. well-formedness pass
        parsed: dict[str, etree._Element] = {}
        bad: list[tuple[str, str]] = []
        for n in names:
            if not (n.endswith(".xml") or n.endswith(".rels")):
                continue
            try:
                parsed[n] = etree.fromstring(zf.read(n))
            except etree.XMLSyntaxError as e:
                bad.append((n, str(e)[:200]))
        if bad:
            for n, err in bad:
                details.append(f"malformed XML in {n}: {err}")
            return _fail("malformed XML parts", details)

        # 2. content types coverage
        ct_path = "[Content_Types].xml"
        if ct_path not in parsed:
            return _fail("missing [Content_Types].xml")
        ct_root = parsed[ct_path]
        defaults = {
            el.get("Extension").lower(): el.get("ContentType")
            for el in ct_root.findall(f"{{{CT_NS}}}Default")
            if el.get("Extension")
        }
        overrides = {
            el.get("PartName"): el.get("ContentType")
            for el in ct_root.findall(f"{{{CT_NS}}}Override")
            if el.get("PartName")
        }

        def _ct_for(partname: str) -> str | None:
            # Override wins; otherwise fall back to extension Default.
            if partname in overrides:
                return overrides[partname]
            ext = partname.rsplit(".", 1)[-1].lower() if "." in partname else ""
            return defaults.get(ext)

        # Every part inside the zip should be covered. Skip the content-types
        # part itself (it doesn't list itself).
        for n in names:
            if n == ct_path or n.endswith("/"):
                continue
            partname = "/" + n
            if _ct_for(partname) is None:
                details.append(f"no content-type for {partname}")
        if details:
            return _fail("content-type coverage gap", details)

        # 3. relationship target existence
        zip_set = {"/" + n for n in names}
        for n, root in parsed.items():
            if not n.endswith(".rels"):
                continue
            owner = _owner_partname(n)
            for rel in root.findall(f"{{{RELS_NS}}}Relationship"):
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target") or ""
                resolved = _resolve_partname(owner, target)
                if resolved is None:
                    details.append(f"{n}: cannot resolve target {target!r}")
                    continue
                if resolved not in zip_set:
                    details.append(
                        f"{n}: relationship {rel.get('Id')} -> {resolved} "
                        f"(part missing from package)"
                    )
        if details:
            return _fail("dangling relationship targets", details)

        # 4. presentation sanity
        pres = parsed.get("ppt/presentation.xml")
        if pres is None:
            return _fail("missing ppt/presentation.xml")
        sld_id_list = pres.find(f"{{{P_NS}}}sldIdLst")
        if sld_id_list is None or len(sld_id_list) == 0:
            warnings.append("presentation has no slides (sldIdLst empty)")

        # Done.
        print(json.dumps({
            "ok": True,
            "parts": len(parsed),
            "slides": len(sld_id_list) if sld_id_list is not None else 0,
            "warnings": warnings,
        }, ensure_ascii=False))
        return 0


def _owner_partname(rels_path: str) -> str:
    """`ppt/slides/_rels/slide1.xml.rels` → `/ppt/slides/slide1.xml`.
    `_rels/.rels` → `/` (package root).
    """
    if rels_path == "_rels/.rels":
        return "/"
    # strip trailing `.rels`
    base = rels_path[:-5] if rels_path.endswith(".rels") else rels_path
    # remove the `_rels/` segment immediately before the basename
    parts = base.split("/")
    if "_rels" in parts:
        parts.remove("_rels")
    return "/" + "/".join(parts)


def _resolve_partname(owner: str, target: str) -> str | None:
    """Resolve a relative `Target` against an owner partname (absolute)."""
    import posixpath
    if not target:
        return None
    if target.startswith("/"):
        return target
    base_dir = "/" if owner == "/" else posixpath.dirname(owner)
    joined = posixpath.normpath(posixpath.join(base_dir, target))
    if not joined.startswith("/"):
        joined = "/" + joined
    return joined


def _fail(msg: str, details: list[str] | None = None) -> int:
    out = {"ok": False, "error": msg}
    if details:
        out["details"] = details[:50]
    print(json.dumps(out, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
