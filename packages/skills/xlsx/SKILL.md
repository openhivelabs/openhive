---
name: xlsx
description: Build, inspect, edit, and reverse-engineer Excel (.xlsx) workbooks. Three rails — JSON-spec generation for new workbooks, patch DSL for in-place cell/range/sheet edits, round-trip extract+rebuild for structural rewrites. Native styles, formulas, charts, conditional formatting, tables, and merge ranges.
triggers:
  keywords: [xlsx, excel, spreadsheet, workbook, sheet, csv, table, formula, pivot]
  patterns: ['\.xlsx\b', '\.csv\b']
---

# xlsx skill

## Decision tree — pick a rail

```
What is the request?
│
├─ Build a new workbook from scratch
│   → scripts/build_xlsx.py --spec <json> --out <xlsx>
│     Multi-sheet, formulas, named tables, charts, conditional formatting,
│     merge ranges, tab colours, freeze panes.
│     Spec syntax: reference/spec_schema.md, examples: reference/examples.md
│
├─ Edit cells / ranges / sheets in an existing workbook
│   → scripts/edit_xlsx.py --in <xlsx> --patch <json> --out <xlsx>
│     Patch DSL: reference/patch_dsl.md. Ops: set_cell, set_range,
│     set_formula, set_style, set_number_format, insert_rows, delete_rows,
│     add_sheet, delete_sheet, rename_sheet, update_chart_data.
│
├─ Restructure an existing workbook (rebuild sheets, replace theme)
│   → (1) scripts/extract_xlsx.py --in <xlsx> --out <spec.json>
│   → (2) edit spec.json however needed
│   → (3) scripts/build_xlsx.py --spec <spec.json> --out <xlsx>
│
├─ Inspect workbook shape (sheet/row/col/chart/table counts, formulas)
│   → scripts/inspect_xlsx.py --in <xlsx>
│
├─ Sanity-check structural integrity (post-raw-XML edit, before delivery)
│   → scripts/validate_xlsx.py --in <xlsx>
│     Walks every OOXML part: well-formedness, content-types coverage,
│     relationship targets resolvable.
│
└─ CSV / Markdown table → xlsx
    → scripts/csv_to_spec.py --in <csv> --out <spec.json> → build_xlsx.py
```

## At a glance

- **New workbook**: write JSON spec → build_xlsx. Multiple sheets, each with
  cells/rows, styles, merges, charts, conditional formats.
- **Edits**: JSON patch. set_cell / set_range / set_formula / set_style /
  set_number_format / insert_rows / delete_rows / add_sheet / delete_sheet /
  rename_sheet / update_chart_data.
- **Reverse-engineer**: extract_xlsx converts existing xlsx back to spec
  JSON; edit and rebuild.

## Script stdout

Every script prints **one JSON line on success**, or `{"ok": false, "error": ...}` on failure. AI should `json.loads()` stdout to verify the result.

- `build_xlsx.py`    → `{"ok": true, "path": ..., "sheets": N, "warnings": [...]}`
- `edit_xlsx.py`     → `{"ok": true, "path": ..., "sheets": N, "ops_applied": K, "warnings": [...]}`
- `inspect_xlsx.py`  → rich per-sheet structure (rows, cols, charts, tables, formula count)
- `extract_xlsx.py`  → `{"ok": true, "path": ..., "sheets": N, "spec_valid": bool, "warnings": [...]}`
- `validate_xlsx.py` → `{"ok": true, "parts": N, "sheets": M, "warnings": [...]}` or `{"ok": false, "error": ..., "details": [...]}`
- `csv_to_spec.py`   → `{"ok": true, "path": ..., "rows": N}`

## Edit rules (edit_xlsx)

- Cell refs are **A1 notation** (`A1`, `B2`, `C3`). Ranges use `A1:C5`.
- Sheet selectors: `sheet:Name` (case-sensitive name) or `sheet:0` (zero-based index).
- `update_chart_data` cannot change chart kind — recreate the sheet for type changes.
- `set_range` with a 2D array fills row-major; with a scalar broadcasts.
- `delete_sheet` requires at least one sheet remaining (Excel rejects empty workbooks).

## Limits & caveats

- Pivot tables: read/preserve only. No edit API.
- Embedded images in cells (Excel 365 IMAGE function): preserved, not edit-targeted.
- Macros (.xlsm): out of scope. This skill targets .xlsx only.
- Formula evaluation: cells with formulas are written as formulas; openpyxl does
  **not** compute their values — Excel/LibreOffice computes on open.

---

## File layout

```
xlsx/
├── lib/                          # rail A: new-workbook renderer
│   ├── themes.py, spec.py, renderers.py
├── helpers/                      # rail B: patch engine + utilities
│   ├── patch.py                  # patch DSL + selectors + all ops
│   └── ranges.py                 # A1 ↔ (row, col) helpers
├── scripts/                      # CLI entrypoints
│   ├── build_xlsx.py, inspect_xlsx.py, extract_xlsx.py,
│   ├── edit_xlsx.py, validate_xlsx.py, csv_to_spec.py
└── reference/                    # AI reference
    ├── spec_schema.md            # top-level spec (JSON)
    ├── patch_dsl.md              # edit DSL
    ├── fonts.md                  # multi-script font selection
    ├── examples.md, themes.md, troubleshooting.md
    └── snippets/                 # validated XML fragments (raw-XML fallback)
```
