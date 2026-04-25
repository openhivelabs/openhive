---
name: pdf
description: Build, inspect, edit, and extract PDF documents. Two edit tracks — page-level ops (merge/split/rotate/watermark) via pypdf, and content changes via spec round-trip (build_doc regenerates from .spec.json).
triggers:
  keywords: [pdf, report, document, generate, edit]
  patterns: ['\.pdf\b']
---

# pdf skill

## Important premise

PDF is a **rendered format**, so byte-level content editing is technically limited. This skill works around that in two rails:

1. **Page-level ops** (pypdf) — handle pages without touching content
2. **Content changes = spec rebuild** — edit `.spec.json`, generate a new PDF

Inline edits on external PDFs, like "change the 3rd word", are **not supported**. If source exists, edit that and rebuild.

## Decision tree

```
What is the request?
│
├─ Create a new PDF
│   → scripts/build_doc.py --spec <json> --out <pdf>
│     15 block types (shared with docx): title/heading/paragraph/bullets/numbered/
│     table/image/page_break/quote/code/horizontal_rule/toc/kpi_row/
│     two_column/spacer
│
├─ PDF page ops (merge/split/extract/rotate/watermark)
│   → scripts/edit_doc.py --in <pdf> --patch <json> --out <pdf>
│     Page ops: merge, split, extract_pages, rotate, overlay_text,
│     overlay_image
│
├─ PDF content changes (insert/delete/move text/blocks)
│   → same edit_doc.py, but use Spec ops
│     Spec ops: set_text, replace_block, insert_block, delete_block,
│     move_block, update_table_cell
│     Requires <input>.pdf.spec.json (build_doc saves it automatically)
│
├─ Inspect structure
│   → scripts/inspect_doc.py --in <pdf>
│     page count, dimensions, text preview, metadata
│
├─ PDF → spec extraction (lossy fallback)
│   → scripts/extract_doc.py --in <pdf> --out <spec.json>
│     Layout/tables/images are mostly lost. Use only when original spec.json is missing.
│
└─ Markdown → PDF
    → scripts/md_to_spec.py --in <md> --out <spec.json> → build_doc.py
```

## Page-level ops (pypdf-backed)

Treat pages as opaque units — safe and fast:

| op              | Description                                  |
|-----------------|----------------------------------------------|
| `merge`         | Concatenate multiple PDFs                    |
| `split`         | Split into page ranges                       |
| `extract_pages` | Extract selected pages into a new PDF        |
| `rotate`        | Rotate 90/180/270 degrees                    |
| `overlay_text`  | Watermark/stamp text                         |
| `overlay_image` | Logo/seal image                              |

## Content changes = spec rebuild

`build_doc.py` automatically saves `<file>.pdf.spec.json` next to the PDF. Edit this JSON and rebuild:

| op                   | Description                                  |
|----------------------|----------------------------------------------|
| `set_text`           | Replace a specific block's text field        |
| `replace_block`      | Replace the block at a position              |
| `insert_block`       | Insert a block at a position                 |
| `delete_block`       | Delete the block at a position               |
| `move_block`         | Move a block                                 |
| `update_table_cell`  | Update table cell (r, c)                     |

If `.spec.json` is missing, run `extract_doc.py` first or rebuild from source (docx, md).

## Block types

Shares almost the same vocabulary as docx — one spec can generate both formats.

| Type              | Purpose                                 |
|-------------------|-----------------------------------------|
| `title`           | Large centered title (cover page)       |
| `heading`         | Section heading (level 1-6)             |
| `paragraph`       | Body paragraph (supports align)         |
| `bullets`         | Unordered list (2-level nesting)        |
| `numbered`        | Ordered list                            |
| `table`           | Table (headers + rows, style)           |
| `image`           | Image (optional width_in)               |
| `page_break`      | Page break                              |
| `quote`           | Quote block                             |
| `code`            | Code block (monospace + background)     |
| `horizontal_rule` | Horizontal divider                      |
| `toc`             | TOC (ReportLab TableOfContents)         |
| `kpi_row`         | Row of metric cards                     |
| `two_column`      | Two-column layout                       |
| `spacer`          | Vertical spacing (pt)                   |

## Limits & caveats

- External fonts are stored by name only — if the viewer substitutes fonts, line widths change.
- `overlay_text` is for watermarks. It does not "change" body text.
- `extract_doc.py` is heuristic — tables/images/layout are lost. If `.spec.json` exists, do not extract.
- Editing a digitally signed PDF invalidates the signature.
- Encrypted PDFs cannot be edited while encrypted (decrypt first, edit, then re-encrypt).
