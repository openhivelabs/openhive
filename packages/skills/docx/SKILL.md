---
name: docx
description: Build, inspect, edit, and reverse-engineer Word (.docx) documents with native OOXML charts, KPI tiles, callouts, cover pages, footnotes/comments/watermarks, equations, and 50+ block types. Two edit tracks — live ops (set_text/update_table_cell/swap_image/set_style) and spec round-trip for structural changes.
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
│     50+ block types — cover, chart (PNG or native), tables, KPI tiles,
│     callouts, sidebar, pull_quote, definition_list, gantt, timeline,
│     progress, card_grid, pricing_table, faq, code (with syntax),
│     equation, footnote/comment/bookmark/xref, watermark, etc.
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
│     Complex structures are lossy (charts/kpi_row/two_column flatten).
│
└─ Markdown → docx
    → scripts/md_to_spec.py --in <md> --out <spec.json> → build_doc.py
```

## Two edit tracks

**Live ops** — edit the document directly with python-docx.
Fast and no spec file required. Trade-off: no structural edits.

**Spec ops** — read `<input>.spec.json`, edit it, then rebuild.
Structural edits are free-form. Trade-off: requires a spec.

You may mix both op types in one patch — live applies first, then spec ops rebuild.

## Block types — full catalog

### Text & structure
| Type | Purpose |
|---|---|
| `heading` | Heading (level 1–6, TOC-linked). Auto-numbered if `meta.auto_number_headings`. |
| `paragraph` | Body paragraph (align, inline rich text) |
| `bullets` / `numbered` | Lists (2-level nesting, inline rich text) |
| `quote` | Quote block (text, attribution) |
| `pull_quote` | Centered emphatic quote with top/bottom borders |
| `code` | Code block (syntax highlight: python/js/ts/sql; optional line_numbers) |
| `code_diff` | Diff with `+`/`-`/`~` line tints |
| `equation` | LaTeX → mathtext PNG |
| `drop_cap` | Magazine-style first-letter big paragraph |
| `definition_list` | Term/definition glossary |
| `bibliography` | Numbered reference list with hyperlinks |

### Layout
| Type | Purpose |
|---|---|
| `cover` | Full-page cover (eyebrow/title/subtitle/meta + colored band; optional `background_image`) |
| `page_break` | Page break |
| `section_break` | New section, optionally `orientation: landscape` or new `size` |
| `horizontal_rule` / `divider` | Hairline / theme-colored thicker rule |
| `spacer` | Vertical gap (pt) |
| `two_column` | Equal split |
| `split_layout` | Asymmetric split with widths + per-side fill |
| `columns` | Newspaper-style N-column wrap of child blocks |
| `sidebar` | Subtle gray surface box |
| `margin_note` | Right-margin floating note (frame anchor) |
| `page_border` | Section page border |

### Visual blocks
| Type | Purpose |
|---|---|
| `kpi_row` | Colored metric tiles (palette cycle, top border, surface tint) |
| `card_grid` | N×M cards (icon/value/title/body) |
| `image` | Single image (URL or path; supports `float: left/right` text wrap) |
| `image_gallery` | N×M image grid |
| `image_card` | Image + body card with badge |
| `callout` | info/success/warning/danger/note/tip/action/decision/question/mention/key |
| `summary_box` | TL;DR highlight box |
| `metric_compare` | Before/after rows w/ auto delta color |
| `color_swatch` | Brand color row with hex labels |
| `stat_list` | Inline horizontal stat row |
| `qr_code` | QR PNG for any payload |
| `author` | Avatar + name + title + bio |

### Tables
| Type | Purpose |
|---|---|
| `table` | Styles: grid / light / plain / zebra / minimal. Options: column_widths, merge, cell_align, first_col_emphasis, caption. Inline rich text in cells. |
| `pricing_table` | Side-by-side plan comparison (price, features ✓, CTA, highlight) |
| `gantt` | Task-on-period grid with colored bars |
| `timeline` | Vertical milestone rail |
| `progress` | Horizontal progress bars |

### Process / interactive-feel
| Type | Purpose |
|---|---|
| `step_list` | Circled-number process steps |
| `checklist` | ☑/☐ items |
| `faq` | Q/A pairs |

### Charts
- `chart` (PNG, default) — matplotlib backend with the theme palette.
- `chart` with `native: true` — native OOXML chart parts (Word's "Edit data" works).

Variants: `bar`, `hbar`, `stacked_bar`, `line`, `area`, `scatter`, `donut`, `pie`, `sparkline` (PNG only), `combo` (bar+line), `radar` (native), `bubble` (native).

### Fields, refs, special
| Type | Purpose |
|---|---|
| `toc` | TOC field (auto-refresh on open) |
| `table_of_figures` / `table_of_charts` / `table_of_tables` | Field-based caption lists |
| `bookmark` / `xref` | Internal anchors and cross-references |
| `comment` | Review-pane annotation (hoisted into word/comments.xml) |
| `index` | INDEX field placeholder |

## Inline rich-text micro-syntax

Inside any paragraph/heading/bullet/cell text:

| Syntax | Output |
|---|---|
| `**bold**` | bold |
| `*italic*`, `_italic_` | italic |
| `` `code` `` | mono + code_bg shade |
| `~~strike~~` | strikethrough (muted) |
| `==hl==` | accent highlight |
| `[text](url)` | hyperlink |
| `[^body]` | footnote (auto-numbered) |
| `{{label}}` | status badge — DONE/WIP/TODO/BLOCKED/FAIL/NEW/BETA/GA/DEPRECATED/WARN/OK |
| `{{label|#RRGGBB}}` | custom-color badge |

## meta options

```jsonc
{
  "meta": {
    "title": "...", "author": "...", "subject": "...",
    "theme": "default | formal | report | minimal",
    "theme_overrides": { "accent": [...], "palette": [[...], ...], "body_font": "..." },
    "size": "A4 | Letter | Legal",
    "orientation": "portrait | landscape",
    "header": { "left": "...", "center": "...", "right": "..." },
    "footer": { "center": "Page {page} of {total}" },
    "different_first_page": true,
    "page_numbers": "footer-right-of-total",
    "page_numbers_format": "decimal | lowerRoman | upperRoman | upperLetter",
    "page_numbers_start": 1,
    "auto_number_headings": true,
    "watermark": "DRAFT" | { "text": "...", "color": [..], "size": .., "rotation": .., "opacity": .. }
  }
}
```

## Theme palette

Each theme exposes a 6-color `palette` plus semantic `info/success/warning/danger`
and `surface/band` colors. Charts auto-cycle the palette across series, KPI tiles
cycle per stat, callouts pick by variant. Override per-document via
`meta.theme_overrides`.

## Limits & caveats

- PNG charts render via matplotlib — not editable in Word's chart editor.
  Use `native: true` for "Edit data" button support (real OOXML chart parts +
  embedded xlsx).
- External fonts stored by name only — viewers substitute if missing.
  CJK text uses the Noto Sans family auto-resolved by `_lib/fonts`.
- TOC auto-populates on open via `dirty=true` + settings.xml updateFields,
  but page numbers may need one F9 refresh on first open if Word's pagination
  hasn't fully settled.
- `image swap_image` changes bytes only — existing dimensions stay.
- If the spec file is lost, structural edits unavailable. Use `extract_doc.py`
  for best-effort recovery.
