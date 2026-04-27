---
name: docx
description: Build, inspect, edit, and reverse-engineer Word (.docx) documents with charts, KPI tiles, callouts, cover pages, and theme palettes. Two edit tracks — live ops (set_text/update_table_cell/swap_image/set_style) and spec round-trip for structural changes.
triggers:
  keywords: [docx, word, document, report, write]
  patterns: ['\.docx\b']
---

# docx skill

## Decision tree

```
What is the request?
│
├─ Create a new document
│   → scripts/build_doc.py --spec <json> --out <docx>
│     19 block types: heading, paragraph, bullets, numbered, table, image,
│     page_break, quote, code, horizontal_rule, toc, kpi_row, two_column,
│     cover, chart, callout, sidebar, spacer, divider.
│     spec schema: reference/spec_schema.md, examples: reference/examples.md
│
├─ Edit part of the body (text/table cell/image/style)
│   → scripts/edit_doc.py --in <docx> --patch <json> --out <docx>
│     Live ops: set_text, update_table_cell, swap_image, set_style.
│     Patch DSL syntax: reference/patch_dsl.md.
│
├─ Structural changes (insert/delete/move/replace blocks)
│   → same edit_doc.py, but use Spec ops.
│     Spec ops: insert_block, delete_block, replace_block, move_block.
│     Auto-load <input>.spec.json, edit it → rebuild.
│     build_doc.py saves .spec.json automatically, so round-trip works.
│
├─ Inspect document structure
│   → scripts/inspect_doc.py --in <docx>
│     heading/paragraph counts, TOC, table dimensions, image list.
│
├─ Extract existing docx to spec (before heavy edits)
│   → scripts/extract_doc.py --in <docx> --out <spec.json>
│     Complex structures are lossy (kpi_row/two_column flatten to paragraphs).
│
└─ Markdown → docx
    → scripts/md_to_spec.py --in <md> --out <spec.json> → build_doc.py
```

## Two edit tracks

**Live ops** — edit the document directly with python-docx.  
Fast and no spec file required. Trade-off: no structural edits (insert/delete blocks).

**Spec ops** — read `<input>.spec.json`, edit it, then rebuild.  
Structural edits are free-form. Trade-off: requires a spec (run `extract_doc.py` first if missing).

You may mix both op types in one patch — live applies first, then spec ops rebuild from that result.

## Block types

| Type              | Purpose                                                            |
|-------------------|--------------------------------------------------------------------|
| `heading`         | Heading (level 1-6, TOC-linked)                                    |
| `paragraph`       | Body paragraph (supports align)                                    |
| `bullets`         | Unordered list (2-level nesting)                                   |
| `numbered`        | Ordered list                                                       |
| `table`           | Table — `style: grid|light|plain|zebra|minimal`                    |
| `image`           | Image (path/URL, caption, width_in)                                |
| `page_break`      | Page break                                                         |
| `quote`           | Quote block (supports attribution)                                 |
| `code`            | Code block (monospace + background)                                |
| `horizontal_rule` | Horizontal divider                                                 |
| `toc`             | TOC field (refresh with F9 in Word)                                |
| `kpi_row`         | Colored metric tiles (big number + label + delta)                  |
| `two_column`      | Two-column layout (block array per column)                         |
| `cover`           | Full-page cover (eyebrow / title / subtitle / meta + bottom band)  |
| `chart`           | Chart via matplotlib — `variant: bar|hbar|stacked_bar|line|area|scatter|donut|pie|sparkline` |
| `callout`         | Colored info box — `variant: info|success|warning|danger|note|tip` |
| `sidebar`         | Subtle gray surface box for tangential content                     |
| `spacer`          | Vertical gap (`height` in pt)                                      |
| `divider`         | Theme-colored thicker rule                                         |

## Theme palette

Each theme exposes a 6-color `palette` plus semantic `info/success/warning/danger`
and `surface/band` colors. Charts auto-cycle the palette across series, KPI tiles
cycle per stat, callouts pick by variant. Override per-document via
`meta.theme_overrides` (e.g. `{"palette": [[13,90,99], [217,119,6], ...]}`).

## Limits & caveats

- Charts are PNG (matplotlib) — not editable in Word's chart editor. This is
  intentional: native chart parts require dml-chart XSD authoring, not worth
  the complexity. Re-render by editing the spec and rebuilding.
- External fonts are stored by name only — viewers substitute if missing.
  CJK text uses the Noto Sans family auto-resolved by `_lib/fonts`.
- `toc` inserts only field code. Press F9 in Word to populate the actual TOC.
- `image` replacement (`swap_image`) changes bytes only — existing dimensions stay.
- If the spec file is lost, structural edits are unavailable. Use `extract_doc.py` for best-effort recovery.
