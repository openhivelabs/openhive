# ECMA-376 schemas

These XSD files come from **ECMA-376 Part 1 (OOXML)** — the public
international standard for Office Open XML. You can download them from
https://ecma-international.org/publications-and-standards/standards/ecma-376/
(look for "Part 1: Fundamentals and Markup Language Reference", transitional
schemas).

## Why they're here

AI agents editing raw XML can read the XSDs on demand to understand:
- Which child elements a given element accepts
- Attribute names, types, default values
- Enumerations (e.g. what `chart type` values are legal)
- Required vs optional

This is the **fallback path** when the patch DSL doesn't cover a case.
For routine edits use the DSL.

## What's NOT bundled

Schemas for DOCX (`wml.xsd`), XLSX (`sml.xsd`), VML (legacy drawing), and
ISO revisions are intentionally excluded — this skill is pptx-only.

## Selected files (bundled on demand)

| File                             | Purpose                          |
|----------------------------------|----------------------------------|
| `pml.xsd`                        | Presentation, slide, slideMaster |
| `dml-main.xsd`                   | Shapes, text, paragraphs, fills  |
| `dml-chart.xsd`                  | All chart elements               |
| `dml-chartDrawing.xsd`           | Chart's own drawings             |
| `dml-diagram.xsd`                | SmartArt (rarely used)           |
| `dml-picture.xsd`                | Picture-specific definitions     |
| `shared-commonSimpleTypes.xsd`   | Types (ST_*) used across all     |
| `shared-relationshipReference.xsd` | r:id attribute type            |

## How to use

In the skill, call `scripts/validate_deck.py --in deck.pptx` — it loads
the right XSDs and validates each part. Or from Python:

```python
from lxml import etree
schema_doc = etree.parse("reference/schemas/pml.xsd")
schema = etree.XMLSchema(schema_doc)
slide_doc = etree.fromstring(slide_part.blob)
if not schema.validate(slide_doc):
    print(schema.error_log)
```

## Adding the schemas

The XSD files are not committed to the repo by default (they're bulky
and their license text is long). Run:

```
scripts/fetch_schemas.sh
```

to download and place them here. The script is idempotent; existing
files are preserved.
