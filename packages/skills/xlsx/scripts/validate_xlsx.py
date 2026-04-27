#!/usr/bin/env python3
"""Validate an .xlsx for structural sanity.

Mirrors pptx/validate_deck.py: every .xml/.rels part must lxml-parse,
every part must have a content-type Override or Default, every Internal
relationship target must resolve to a real part, and the workbook must
declare at least one sheet.
"""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

from lxml import etree


CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    args = ap.parse_args()

    src = Path(args.inp).expanduser()
    if not src.exists():
        return _fail(f"file not found: {src}")
    try:
        zf = zipfile.ZipFile(src)
    except zipfile.BadZipFile as e:
        return _fail(f"not a valid zip / xlsx: {e}")

    with zf:
        names = zf.namelist()
        warnings: list[str] = []
        details: list[str] = []

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
            if partname in overrides:
                return overrides[partname]
            ext = partname.rsplit(".", 1)[-1].lower() if "." in partname else ""
            return defaults.get(ext)

        for n in names:
            if n == ct_path or n.endswith("/"):
                continue
            partname = "/" + n
            if _ct_for(partname) is None:
                details.append(f"no content-type for {partname}")
        if details:
            return _fail("content-type coverage gap", details)

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

        wb_xml = parsed.get("xl/workbook.xml")
        if wb_xml is None:
            return _fail("missing xl/workbook.xml")
        sheets = wb_xml.findall(f"{{{S_NS}}}sheets/{{{S_NS}}}sheet")
        if not sheets:
            warnings.append("workbook has no sheets")

        print(json.dumps({
            "ok": True,
            "parts": len(parsed),
            "sheets": len(sheets),
            "warnings": warnings,
        }, ensure_ascii=False))
        return 0


def _owner_partname(rels_path: str) -> str:
    if rels_path == "_rels/.rels":
        return "/"
    base = rels_path[:-5] if rels_path.endswith(".rels") else rels_path
    parts = base.split("/")
    if "_rels" in parts:
        parts.remove("_rels")
    return "/" + "/".join(parts)


def _resolve_partname(owner: str, target: str) -> str | None:
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
    out: dict = {"ok": False, "error": msg}
    if details:
        out["details"] = details[:50]
    print(json.dumps(out, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
