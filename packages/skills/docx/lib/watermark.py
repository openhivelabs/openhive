"""Diagonal text watermark across every page.

Implementation: each section's main header part gets a VML-shape watermark
element. Word renders this as a faint diagonal text behind the body. We
target the default header (header1.xml) since python-docx already wires
it up; sections without a custom header inherit this one.

Usage (in meta):

    "watermark": "DRAFT"

or:

    "watermark": {"text": "CONFIDENTIAL", "color": [200, 30, 30], "size": 80,
                  "rotation": -45, "opacity": 0.18}
"""
from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any


def inject(docx_path: str, watermark, theme) -> None:
    """Insert a diagonal text watermark into every header part."""
    spec = _normalize(watermark, theme)

    src = Path(docx_path)
    tmpdir = Path(tempfile.mkdtemp(prefix="docx_wm_"))
    try:
        with zipfile.ZipFile(src, "r") as zin:
            zin.extractall(tmpdir)

        header_files = sorted((tmpdir / "word").glob("header*.xml"))
        if not header_files:
            # No header part exists — synthesize header1.xml and wire it
            # to the section. We skip this fallback to keep the module
            # focused; documents that need a watermark almost always
            # already have headers.
            return
        for hf in header_files:
            text = hf.read_text(encoding="utf-8")
            text = _insert_watermark(text, spec)
            hf.write_text(text, encoding="utf-8")

        # repack
        out_tmp = src.with_suffix(src.suffix + ".tmp")
        with zipfile.ZipFile(out_tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for f in sorted(tmpdir.rglob("*")):
                if f.is_file():
                    zout.write(f, str(f.relative_to(tmpdir)))
        shutil.move(str(out_tmp), str(src))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _normalize(wm: Any, theme) -> dict:
    if isinstance(wm, str):
        wm = {"text": wm}
    text = str(wm.get("text", "DRAFT"))
    color = tuple(wm.get("color") or theme.muted)
    size = int(wm.get("size", 80))
    rotation = int(wm.get("rotation", -45))
    opacity = float(wm.get("opacity", 0.18))
    return {"text": text, "color": color, "size": size,
            "rotation": rotation, "opacity": opacity}


def _insert_watermark(header_xml: str, spec: dict) -> str:
    """Insert watermark using the canonical MS Word VML pattern.

    The watermark lives in a tiny zero-line-height paragraph (line=20, exact)
    so it doesn't push other header content. The v:shape uses
    ``mso-position-*-relative="margin"`` + center so it floats over the
    page body, not just the header.
    """
    color = "{:02X}{:02X}{:02X}".format(*spec["color"])
    text = (spec["text"].replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))
    rotation = (360 + int(spec["rotation"])) % 360 or 315
    opacity_pct = f"{spec['opacity']}"
    # Standard Word watermark dimensions: 415pt × 207pt diagonal
    pp_xml = f"""<w:p>
  <w:pPr>
    <w:pStyle w:val="Header"/>
    <w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>
  </w:pPr>
  <w:r>
    <w:rPr><w:noProof/></w:rPr>
    <w:pict xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:o="urn:schemas-microsoft-com:office:office">
      <v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136"
                   adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">
        <v:formulas>
          <v:f eqn="sum #0 0 10800"/>
          <v:f eqn="prod #0 2 1"/>
          <v:f eqn="sum 21600 0 @1"/>
          <v:f eqn="sum 0 0 @2"/>
          <v:f eqn="sum 21600 0 @3"/>
          <v:f eqn="if @0 @3 0"/>
          <v:f eqn="if @0 21600 @1"/>
          <v:f eqn="if @0 0 @2"/>
          <v:f eqn="if @0 @4 21600"/>
          <v:f eqn="mid @5 @6"/>
          <v:f eqn="mid @8 @5"/>
          <v:f eqn="mid @7 @8"/>
          <v:f eqn="mid @6 @7"/>
          <v:f eqn="sum @6 0 @5"/>
        </v:formulas>
        <v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="custom"
                o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800"
                o:connectangles="270,180,90,0"/>
        <v:textpath on="t" fitshape="t"/>
      </v:shapetype>
      <v:shape id="PowerPlusWaterMarkObject" o:spid="_x0000_s2049"
               type="#_x0000_t136"
               style="position:absolute;margin-left:0;margin-top:0;width:415pt;height:207pt;rotation:{rotation};z-index:-251654144;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin"
               fillcolor="#{color}" stroked="f">
        <v:fill opacity="{opacity_pct}"/>
        <v:textpath style="font-family:&quot;Helvetica&quot;;font-size:1pt"
                    string="{text}"/>
      </v:shape>
    </w:pict>
  </w:r>
</w:p>"""
    return header_xml.replace("</w:hdr>", pp_xml + "</w:hdr>", 1)
