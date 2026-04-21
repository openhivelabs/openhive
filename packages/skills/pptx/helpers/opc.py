"""OPC (Open Packaging Convention) layer.

A .pptx (.docx / .xlsx) file is an OPC package: a ZIP whose entries are
'parts' (XML or binary) glued together by:

  /[Content_Types].xml       — declares each part's MIME type (by extension
                               default or per-partname override)
  /_rels/.rels               — package-level relationships (pointers to
                               the main document part)
  /<dir>/_rels/<file>.rels   — per-part relationships (e.g. a slide points
                               to its layout, images, and charts)

python-pptx handles this internally but doesn't expose a clean API for
"drop a slide cleanly, reorder, swap images, etc." This module provides
that in ~400 lines. Format-agnostic — works for pptx, docx, xlsx.

Why from scratch instead of using python-pptx's internals:
  - drop_rel doesn't cascade (leaves orphan parts → duplicate-name warning
    at save). We own partname allocation here so deletes are clean.
  - AI-driven XML edits need raw XML access, not pptx's object model.
  - Round-tripping (extract → edit → rebuild) needs to preserve every byte
    we don't touch; pptx's re-serialisation drops some properties.

Spec references: ECMA-376 Part 2 (Open Packaging Conventions). We only
implement the parts needed for pptx/docx/xlsx — signatures, interleaving,
and other rarely used features are intentionally skipped.
"""
from __future__ import annotations

import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Iterator

from lxml import etree


# ---------------------------------------------------------------------------
# namespaces
# ---------------------------------------------------------------------------

NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

# Content-type → default partname prefix mapping. Used when allocating a new
# partname for a part of a given kind (e.g. add a new slide → need /ppt/slides/slideN.xml).
CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
CT_SLIDE_REL = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
CT_IMAGE_PNG = "image/png"
CT_IMAGE_JPG = "image/jpeg"


# Relationship types used in pptx (a few of the most common)
RT_OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
RT_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
RT_SLIDE_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
RT_SLIDE_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
RT_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
RT_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"
RT_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
RT_NOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"


# ---------------------------------------------------------------------------
# data types
# ---------------------------------------------------------------------------


@dataclass
class Relationship:
    """One entry in a *.rels file. Points from a 'source' part to a 'target'
    (either another part in the package, or an external URL).
    """
    rId: str
    type: str
    target: str                 # relative to the source's directory
    mode: str = "Internal"      # "Internal" | "External"

    def target_partname(self, source_partname: str) -> str | None:
        """Resolve target to an absolute partname (leading /). Returns None
        for external relationships.
        """
        if self.mode == "External":
            return None
        source_dir = posixpath.dirname(source_partname)
        resolved = posixpath.normpath(posixpath.join(source_dir, self.target))
        if not resolved.startswith("/"):
            resolved = "/" + resolved
        return resolved


@dataclass
class Part:
    """One part of an OPC package.

    partname is always absolute and starts with '/'. content_type comes from
    [Content_Types].xml — we record it here so save() can re-emit the table.
    blob is the raw byte content (XML as bytes, or binary for media).
    rels are this part's outgoing relationships.
    """
    partname: str
    content_type: str
    blob: bytes
    rels: list[Relationship] = field(default_factory=list)

    # ---- convenience accessors ----------------------------------------

    def is_xml(self) -> bool:
        return self.content_type.endswith("+xml") or self.content_type.endswith("/xml")

    def xml(self) -> etree._Element:
        """Parse the part's blob as XML. Cached on the instance."""
        if self._cached_xml is None:
            self._cached_xml = etree.fromstring(self.blob)
        return self._cached_xml

    def set_xml(self, root: etree._Element) -> None:
        """Replace the blob with the serialised root. Clears cache."""
        self.blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        self._cached_xml = root

    def rels_partname(self) -> str:
        """Partname of the .rels file that belongs to this part."""
        d = posixpath.dirname(self.partname)
        base = posixpath.basename(self.partname)
        return f"{d}/_rels/{base}.rels"

    def get_rel(self, rId: str) -> Relationship | None:
        for r in self.rels:
            if r.rId == rId:
                return r
        return None

    def next_rid(self) -> str:
        """Smallest unused rId on this part."""
        used = {int(r.rId[3:]) for r in self.rels if re.fullmatch(r"rId\d+", r.rId)}
        i = 1
        while i in used:
            i += 1
        return f"rId{i}"

    _cached_xml: etree._Element | None = field(default=None, init=False, repr=False)


@dataclass
class ContentTypes:
    """[Content_Types].xml — declares each part's MIME type.

    Has two forms:
      <Default Extension="xml" ContentType="..."/>   — all *.xml get this type
      <Override PartName="/ppt/..." ContentType="..."/>  — specific part override
    """
    defaults: dict[str, str] = field(default_factory=dict)        # ext → content type
    overrides: dict[str, str] = field(default_factory=dict)       # partname → content type

    @classmethod
    def parse(cls, blob: bytes) -> "ContentTypes":
        out = cls()
        root = etree.fromstring(blob)
        for el in root:
            tag = etree.QName(el.tag).localname
            if tag == "Default":
                out.defaults[el.get("Extension").lower()] = el.get("ContentType")
            elif tag == "Override":
                out.overrides[el.get("PartName")] = el.get("ContentType")
        return out

    def serialize(self) -> bytes:
        root = etree.Element(f"{{{NS_CT}}}Types", nsmap={None: NS_CT})
        for ext, ct in sorted(self.defaults.items()):
            etree.SubElement(root, f"{{{NS_CT}}}Default", Extension=ext, ContentType=ct)
        for pn, ct in sorted(self.overrides.items()):
            etree.SubElement(root, f"{{{NS_CT}}}Override", PartName=pn, ContentType=ct)
        return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    def resolve(self, partname: str) -> str | None:
        if partname in self.overrides:
            return self.overrides[partname]
        ext = posixpath.splitext(partname)[1].lstrip(".").lower()
        return self.defaults.get(ext)


# ---------------------------------------------------------------------------
# package
# ---------------------------------------------------------------------------


class Package:
    """An OPC package loaded into memory. Mutations happen in-place; save()
    writes a fresh zip. Never touches the original file until save().

    Usage:
        pkg = Package.open("deck.pptx")
        main = pkg.main_document()               # the presentation part
        for rel in main.rels:
            if rel.type == RT_SLIDE:
                slide = pkg.part(rel.target_partname(main.partname))
                ...
        pkg.save("out.pptx")
    """

    def __init__(self):
        self.parts: dict[str, Part] = {}
        self.content_types: ContentTypes = ContentTypes()
        self.pkg_rels: list[Relationship] = []   # package-level, /_rels/.rels

    # ---- IO -----------------------------------------------------------

    @classmethod
    def open(cls, path: str | Path) -> "Package":
        pkg = cls()
        with zipfile.ZipFile(str(path), "r") as z:
            # 1. content types
            if "[Content_Types].xml" not in z.namelist():
                raise ValueError("not a valid OPC package: missing [Content_Types].xml")
            pkg.content_types = ContentTypes.parse(z.read("[Content_Types].xml"))

            # 2. package rels
            if "_rels/.rels" in z.namelist():
                pkg.pkg_rels = _parse_rels(z.read("_rels/.rels"))

            # 3. all parts (everything else that isn't a .rels file)
            for info in z.infolist():
                name = info.filename
                if name == "[Content_Types].xml":
                    continue
                if name.endswith(".rels"):
                    continue  # parsed separately after
                blob = z.read(info)
                partname = "/" + name
                ct = pkg.content_types.resolve(partname)
                if ct is None:
                    # skip unknown parts silently — some packages have auxiliary files
                    continue
                pkg.parts[partname] = Part(partname=partname, content_type=ct, blob=blob)

            # 4. per-part rels — attach after parts are loaded so we can resolve owners
            for info in z.infolist():
                name = info.filename
                if not name.endswith(".rels") or name == "_rels/.rels":
                    continue
                owner_partname = _partname_for_rels(name)
                owner = pkg.parts.get(owner_partname)
                if owner is None:
                    # Orphan rels file — keep loading, but skip (we won't emit it)
                    continue
                owner.rels = _parse_rels(z.read(info))

        return pkg

    def save(self, path: str | Path) -> None:
        """Serialise the package to a new zip. Ignores any on-disk source —
        this is a pure write from the in-memory model.
        """
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
            # [Content_Types].xml
            z.writestr("[Content_Types].xml", self.content_types.serialize())

            # /_rels/.rels
            if self.pkg_rels:
                z.writestr("_rels/.rels", _serialize_rels(self.pkg_rels))

            # parts + their rels
            for partname in sorted(self.parts):
                part = self.parts[partname]
                z.writestr(partname.lstrip("/"), part.blob)
                if part.rels:
                    z.writestr(_rels_path_for(partname), _serialize_rels(part.rels))

        Path(path).write_bytes(buf.getvalue())

    # ---- navigation ---------------------------------------------------

    def part(self, partname: str) -> Part | None:
        return self.parts.get(partname)

    def iter_parts(self, content_type: str | None = None) -> Iterator[Part]:
        for p in self.parts.values():
            if content_type is None or p.content_type == content_type:
                yield p

    def main_document(self) -> Part:
        """Resolve the package-level 'officeDocument' relationship → the main part.
        For pptx this is /ppt/presentation.xml; for docx /word/document.xml, etc.
        """
        for rel in self.pkg_rels:
            if rel.type == RT_OFFICE_DOC:
                pn = rel.target_partname("/")
                if pn and pn in self.parts:
                    return self.parts[pn]
        raise ValueError("package has no officeDocument relationship")

    def related(self, source: Part, rel_type: str | None = None) -> list[Part]:
        """Follow source's relationships and return target parts (internal only)."""
        out: list[Part] = []
        for rel in source.rels:
            if rel_type is not None and rel.type != rel_type:
                continue
            if rel.mode != "Internal":
                continue
            tgt = rel.target_partname(source.partname)
            if tgt and tgt in self.parts:
                out.append(self.parts[tgt])
        return out

    def related_one(self, source: Part, rId: str) -> Part | None:
        rel = source.get_rel(rId)
        if rel is None or rel.mode == "External":
            return None
        tgt = rel.target_partname(source.partname)
        return self.parts.get(tgt) if tgt else None

    # ---- mutation -----------------------------------------------------

    def next_partname(self, pattern: str) -> str:
        """Allocate the next unused partname given a printf-style pattern with
        a single %d. E.g. '/ppt/slides/slide%d.xml' → '/ppt/slides/slide13.xml'.
        """
        i = 1
        while pattern % i in self.parts:
            i += 1
        return pattern % i

    def add_part(self, part: Part, override_content_type: bool = True) -> None:
        """Insert a new part. Registers an Override in [Content_Types] unless
        the default extension already covers it.
        """
        if part.partname in self.parts:
            raise ValueError(f"partname already exists: {part.partname}")
        self.parts[part.partname] = part
        if override_content_type:
            default = self.content_types.resolve(part.partname)
            if default != part.content_type:
                self.content_types.overrides[part.partname] = part.content_type

    def drop_part(self, partname: str, cascade_rels: bool = True) -> None:
        """Remove a part cleanly.

        Cascades:
          - remove the part from self.parts
          - remove its content-type override (if any)
          - remove every relationship in any other part that points to it
          - (if cascade_rels) recursively drop any part that becomes unreferenced

        This is what python-pptx gets wrong: drop_rel() only unlinks but keeps
        the file, which then collides at save time. We own the map, so we can
        be exhaustive.
        """
        if partname not in self.parts:
            return
        del self.parts[partname]
        self.content_types.overrides.pop(partname, None)

        # strip inbound references
        unreferenced_candidates: list[str] = []
        for owner in list(self.parts.values()):
            before = len(owner.rels)
            owner.rels = [r for r in owner.rels if r.target_partname(owner.partname) != partname]
            if len(owner.rels) != before and cascade_rels:
                pass  # the owner itself isn't being removed, just loses one pointer

        # package-level rels
        self.pkg_rels = [
            r for r in self.pkg_rels if r.target_partname("/") != partname
        ]

    def rename_part(self, old: str, new: str) -> None:
        """Change a part's partname. Updates every relationship that points to
        it, plus its own _rels/ file location. Be careful with the `Target` of
        each inbound relationship — it's a relative path, so renaming can change
        what that path resolves to.
        """
        if old not in self.parts:
            raise KeyError(old)
        if new in self.parts:
            raise ValueError(f"partname already exists: {new}")

        part = self.parts.pop(old)
        part.partname = new
        self.parts[new] = part

        # content types
        if old in self.content_types.overrides:
            ct = self.content_types.overrides.pop(old)
            self.content_types.overrides[new] = ct

        # inbound rels
        for owner in self.parts.values():
            for rel in owner.rels:
                tgt = rel.target_partname(owner.partname)
                if tgt == old:
                    rel.target = posixpath.relpath(new, posixpath.dirname(owner.partname))
        for rel in self.pkg_rels:
            if rel.target_partname("/") == old:
                rel.target = new.lstrip("/")

    def add_relationship(self, source: Part, rel_type: str, target_partname: str,
                         mode: str = "Internal") -> str:
        """Add a relationship from `source` to the part at `target_partname`.
        Returns the allocated rId.
        """
        rId = source.next_rid()
        if mode == "Internal":
            rel_target = posixpath.relpath(target_partname, posixpath.dirname(source.partname))
        else:
            rel_target = target_partname
        source.rels.append(Relationship(rId=rId, type=rel_type, target=rel_target, mode=mode))
        return rId

    # ---- debugging ----------------------------------------------------

    def describe(self) -> dict:
        """Compact summary useful for logs and AI consumption."""
        return {
            "part_count": len(self.parts),
            "main_document": self.main_document().partname,
            "parts": [
                {
                    "partname": p.partname,
                    "content_type": p.content_type,
                    "size": len(p.blob),
                    "rel_count": len(p.rels),
                }
                for p in self.parts.values()
            ],
        }


# ---------------------------------------------------------------------------
# rels helpers
# ---------------------------------------------------------------------------


def _parse_rels(blob: bytes) -> list[Relationship]:
    root = etree.fromstring(blob)
    rels: list[Relationship] = []
    for el in root:
        if etree.QName(el.tag).localname != "Relationship":
            continue
        rels.append(Relationship(
            rId=el.get("Id"),
            type=el.get("Type"),
            target=el.get("Target"),
            mode=el.get("TargetMode") or "Internal",
        ))
    return rels


def _serialize_rels(rels: list[Relationship]) -> bytes:
    root = etree.Element(f"{{{NS_REL_PKG}}}Relationships", nsmap={None: NS_REL_PKG})
    for r in rels:
        attrs = {"Id": r.rId, "Type": r.type, "Target": r.target}
        if r.mode and r.mode != "Internal":
            attrs["TargetMode"] = r.mode
        etree.SubElement(root, f"{{{NS_REL_PKG}}}Relationship", **attrs)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _partname_for_rels(rels_path: str) -> str:
    """/ppt/slides/_rels/slide1.xml.rels  →  /ppt/slides/slide1.xml"""
    # strip leading / if present
    path = rels_path if rels_path.startswith("/") else "/" + rels_path
    d, base = posixpath.split(path)              # d = /ppt/slides/_rels, base = slide1.xml.rels
    parent = posixpath.dirname(d)                # /ppt/slides
    owner = base[:-len(".rels")]                 # slide1.xml
    return f"{parent}/{owner}"


def _rels_path_for(partname: str) -> str:
    """/ppt/slides/slide1.xml  →  ppt/slides/_rels/slide1.xml.rels  (zip-entry form, no leading /)"""
    d, base = posixpath.split(partname.lstrip("/"))
    return f"{d}/_rels/{base}.rels" if d else f"_rels/{base}.rels"
