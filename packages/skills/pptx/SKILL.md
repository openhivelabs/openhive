---
name: pptx
description: Build, inspect, edit, and reverse-engineer PowerPoint (.pptx) decks. Three rails — JSON-spec generation for new decks, patch DSL for in-place edits, round-trip extract+rebuild for heavy restructuring. Falls back to raw OOXML editing when needed.
triggers:
  keywords: [pptx, powerpoint, ppt, slide, deck, presentation, pitch, talk]
  patterns: ['\.pptx?\b']
---

# pptx skill

## Decision tree — pick a rail

```
What is the request?
│
├─ Build a new deck from scratch
│   → scripts/build_deck.py --spec <json> --out <pptx>
│     Spec syntax: reference/spec_schema.md, examples: reference/examples.md
│
├─ Edit part of an existing deck (text/chart data/images/add-delete-move slides)
│   → scripts/edit_deck.py --in <pptx> --patch <json> --out <pptx>
│     Patch DSL: reference/patch_dsl.md
│
├─ Heavily restructure an existing deck (rebuild slides, replace theme, etc.)
│   → (1) scripts/extract_deck.py --in <pptx> --out <spec.json>
│   → (2) edit spec.json however needed
│   → (3) scripts/build_deck.py --spec <spec.json> --out <pptx>
│
├─ Inspect deck shape (slide/chart/table/image counts, title summary, etc.)
│   → scripts/inspect_deck.py --in <pptx>
│
├─ Sanity-check structural integrity (post-raw-XML edit, before delivery)
│   → scripts/validate_deck.py --in <pptx>
│     Walks every OOXML part: well-formedness, content-types coverage,
│     relationship targets resolvable. Catches "PowerPoint found a problem"
│     and Keynote "recovered file" before the user sees the dialog.
│
└─ Exceptions not covered by the DSL (animations/masters/SmartArt, etc.)
    → reference/xml_edit_guide.md + reference/snippets/ + reference/schemas/
      then edit raw XML directly with helpers/opc.py
```

## At a glance

- **New deck**: write JSON spec → build_deck. Supports 12 slide types (title, section, bullets, two_column, image, table, chart, comparison, quote, steps, kpi, closing).
- **Edits**: JSON patch. set_text / replace_bullets / update_chart / swap_image / insert_slide / delete_slide / move_slide / set_notes / set_style.
- **Reverse-engineer**: extract_deck converts existing pptx back to spec JSON; edit that JSON and rebuild.
- **Raw XML**: use OPC package (`helpers/opc.py`), snippets (`reference/snippets/`), XSD (`reference/schemas/`).

## Script stdout

Every script prints **one JSON line on success**, or `{"ok": false, "error": ...}` on failure. AI should `json.loads()` stdout to verify the result.

- `build_deck.py`  → `{"ok": true, "path": ..., "slides": N, "theme": ..., "warnings": [...]}`
- `edit_deck.py`   → `{"ok": true, "path": ..., "slides": N, "ops_applied": K, "warnings": [...]}`
- `inspect_deck.py` → rich slide structure + chart/table/image metadata
- `extract_deck.py` → `{"ok": true, "path": ..., "slides": N, "warnings": [...]}` + spec file
- `md_to_spec.py`  → `{"ok": true, "path": ..., "slides": N}`
- `validate_deck.py` → `{"ok": true, "parts": N, "slides": M, "warnings": [...]}` or `{"ok": false, "error": ..., "details": [...]}`

## Edit rules (edit_deck)

- Slide indexes are **zero-based**. Use the `index` returned by `inspect_deck.py`.
- When deleting multiple slides, delete from the **highest index first**. Deleting low indexes first shifts later indexes.
- `update_chart` **cannot change series count**. To change count, recreate the slide with `delete_slide` + `insert_slide`.
- If `set_text` fails with "placeholder not found", that slide uses raw text boxes. See fallback rules in `reference/patch_dsl.md` (top by Y coordinate = title).

## Limits & caveats

- External links/embedded media (video, audio) are preserved only; no edit API.
- SmartArt is read/preserve only (even text edits require raw XML).
- Some modern chart types (3D, treemap, waterfall) update data, but type-specific detailed parameters reset to defaults.

---

## File layout

```
pptx/
├── lib/                          # rail A: new-deck renderer
│   ├── themes.py, layouts.py, spec.py, renderers.py
├── helpers/                      # rail B: OPC-backed edit engine
│   ├── opc.py                    # package abstraction (zip/parts/rels)
│   ├── patch.py                  # patch DSL + selector + all ops
│   └── chart_data.py             # chart data update/extract
├── scripts/                      # CLI entrypoints
│   ├── build_deck.py, inspect_deck.py, extract_deck.py,
│   ├── edit_deck.py, md_to_spec.py, validate_deck.py
└── reference/                    # AI reference
    ├── spec_schema.md            # top-level spec (JSON)
    ├── patch_dsl.md              # edit DSL
    ├── xml_edit_guide.md         # direct raw XML editing
    ├── fonts.md                  # multi-script font selection
    ├── examples.md, themes.md, troubleshooting.md
    ├── snippets/                 # validated XML fragments (copyable)
    └── schemas/                  # ECMA-376 XSD (pptx subset)
```
