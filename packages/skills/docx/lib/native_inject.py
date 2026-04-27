"""Post-process a saved .docx zip to inject native chart parts.

Workflow:
1. ``render_chart`` (when ``native: true``) writes a placeholder
   ``<c:chart r:id="rIdNATIVE{i}"/>`` into document.xml and stashes the
   chart's spec on ``doc._native_charts``.
2. ``build_doc.py`` calls ``inject(out_path, native_charts)`` after save.
3. This module:
     - generates chart{n}.xml + xlsx + chart-level rels for each chart
     - adds them to the zip
     - allocates real rIds in word/_rels/document.xml.rels
     - replaces every ``rIdNATIVE{i}`` token in word/document.xml with
       the real rId
     - inserts ContentTypes Override entries
"""
from __future__ import annotations

import re
import shutil
import tempfile
import zipfile
from pathlib import Path

from .native_chart import build_chart_parts


CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CHART_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"

CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
CT_XLSX = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)


def inject(docx_path: str, native_charts: list, theme) -> None:
    """Inject native chart parts into the docx at ``docx_path``.

    ``native_charts`` is a list of {"block": dict, "placeholder_rid": str}
    accumulated by render_chart in document order.
    """
    if not native_charts:
        return

    src = Path(docx_path)
    tmpdir = Path(tempfile.mkdtemp(prefix="docx_native_"))
    try:
        with zipfile.ZipFile(src, "r") as zin:
            zin.extractall(tmpdir)

        # 1. Build all chart parts in memory
        chart_files: dict[str, bytes] = {}
        rid_map: dict[str, str] = {}  # placeholder → real rId
        existing_rids = _existing_rids(tmpdir)
        next_rid = max(existing_rids, default=0) + 1

        for idx, entry in enumerate(native_charts):
            block = entry["block"]
            placeholder = entry["placeholder_rid"]
            parts = build_chart_parts(block, theme, idx)
            chart_files.update(parts)
            real_rid = f"rId{next_rid}"
            next_rid += 1
            rid_map[placeholder] = real_rid

        # 2. Write parts onto disk
        for zip_path, payload in chart_files.items():
            target = tmpdir / zip_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)

        # 3. Patch document.xml — placeholder rIds → real rIds
        doc_xml_path = tmpdir / "word" / "document.xml"
        text = doc_xml_path.read_text(encoding="utf-8")
        for placeholder, real in rid_map.items():
            text = text.replace(f'r:id="{placeholder}"', f'r:id="{real}"')
        doc_xml_path.write_text(text, encoding="utf-8")

        # 4. Patch document.xml.rels — add chart relationships
        rels_path = tmpdir / "word" / "_rels" / "document.xml.rels"
        rels_text = rels_path.read_text(encoding="utf-8")
        new_rels = []
        for idx, entry in enumerate(native_charts):
            placeholder = entry["placeholder_rid"]
            real_rid = rid_map[placeholder]
            target = f"charts/chart{idx + 1}.xml"
            new_rels.append(
                f'<Relationship Id="{real_rid}" Type="{CHART_REL_TYPE}" '
                f'Target="{target}"/>'
            )
        rels_text = rels_text.replace(
            "</Relationships>",
            "".join(new_rels) + "</Relationships>",
        )
        rels_path.write_text(rels_text, encoding="utf-8")

        # 5. Patch [Content_Types].xml
        ct_path = tmpdir / "[Content_Types].xml"
        ct_text = ct_path.read_text(encoding="utf-8")
        new_overrides = []
        for idx in range(len(native_charts)):
            n = idx + 1
            chart_part = f"/word/charts/chart{n}.xml"
            xlsx_part = f"/word/embeddings/Microsoft_Excel_Worksheet{n}.xlsx"
            if chart_part not in ct_text:
                new_overrides.append(
                    f'<Override PartName="{chart_part}" ContentType="{CT_CHART}"/>'
                )
            if xlsx_part not in ct_text:
                new_overrides.append(
                    f'<Override PartName="{xlsx_part}" ContentType="{CT_XLSX}"/>'
                )
        if new_overrides:
            ct_text = ct_text.replace(
                "</Types>",
                "".join(new_overrides) + "</Types>",
            )
            ct_path.write_text(ct_text, encoding="utf-8")

        # 6. Repack zip
        out_tmp = src.with_suffix(src.suffix + ".tmp")
        with zipfile.ZipFile(out_tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for f in sorted(tmpdir.rglob("*")):
                if f.is_file():
                    arcname = str(f.relative_to(tmpdir))
                    zout.write(f, arcname)
        shutil.move(str(out_tmp), str(src))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _existing_rids(extracted: Path) -> list[int]:
    rels_path = extracted / "word" / "_rels" / "document.xml.rels"
    if not rels_path.exists():
        return []
    text = rels_path.read_text(encoding="utf-8")
    return [int(m) for m in re.findall(r'Id="rId(\d+)"', text)]
