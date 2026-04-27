# Patch DSL

Declarative edits for an existing `.xlsx`. Used by `scripts/edit_xlsx.py`.

## Selector grammar

```
sheet:Name                       # sheet by name (case-sensitive)
sheet:0                          # sheet by zero-based index
sheet:Name > A1                  # one cell
sheet:Name > A1:C5               # a range
sheet:Name > chart:K             # the K-th chart on that sheet
```

Selectors are parsed left-to-right. The first step must always be `sheet:…`.

## Operations

### set_cell

```jsonc
// scalar value
{"op": "set_cell", "target": "sheet:Summary > B3", "value": 12500}

// formula (leading "=" optional)
{"op": "set_cell", "target": "sheet:Summary > B5", "formula": "SUM(B2:B4)"}

// with inline style
{"op": "set_cell", "target": "sheet:Summary > A1",
 "value": "Revenue", "style": "header"}
```

### set_range

```jsonc
// 2D fill
{"op": "set_range", "target": "sheet:Summary > A2:C4",
 "value": [["KR", 1200, 0.18], ["JP", 850, 0.24], ["CN", 640, -0.05]]}

// scalar broadcast
{"op": "set_range", "target": "sheet:Summary > D2:D10", "value": "TBD"}
```

The `style` field works the same as on `set_cell` — applied after value.

### set_style

```jsonc
{"op": "set_style", "target": "sheet:Summary > A1:C1", "style": "header"}
{"op": "set_style", "target": "sheet:Summary > B2",
 "style": {"bold": true, "fill": [219, 234, 254]}}
```

`style` is either a theme style name or an inline dict (same fields as in
the spec — see `spec_schema.md`).

### set_number_format

```jsonc
{"op": "set_number_format", "target": "sheet:Summary > B2:B10",
 "format": "$#,##0.00"}
```

Excel format codes — `"#,##0"`, `"0.0%"`, `"yyyy-mm-dd"`, etc.

### insert_rows / delete_rows

```jsonc
{"op": "insert_rows", "target": "sheet:Summary", "before": 5, "count": 2}
{"op": "delete_rows", "target": "sheet:Summary", "from": 5, "count": 2}
```

`before` is 1-based. Formulas anywhere in the sheet are auto-shifted by
openpyxl.

### add_sheet / delete_sheet / rename_sheet / set_tab_color

```jsonc
{"op": "add_sheet", "name": "Risks", "after": "Summary",
 "rows": [["Risk", "Severity"], ["FX volatility", 3]]}

{"op": "delete_sheet", "target": "sheet:Drafts"}

{"op": "rename_sheet", "target": "sheet:0", "to": "Q1"}

{"op": "set_tab_color", "target": "sheet:Summary", "color": "1D4ED8"}
```

`delete_sheet` refuses to drop the last remaining sheet — Excel rejects
empty workbooks. `add_sheet`'s optional `rows` field pre-populates the
new sheet without needing a follow-up `set_range`.

### update_chart_data

```jsonc
{"op": "update_chart_data",
 "target": "sheet:Summary > chart:0",
 "data_range": "A1:B10",
 "title": "Revenue (extended)"}
```

Re-points an existing chart at a new range. Cannot change the chart
**kind** — for that, delete and rebuild the sheet via the spec round-trip.

## Validation & warnings

`apply_patch` walks ops in order against an in-memory workbook. A failing
op raises a structured `OpError` with the offending op index + op name —
the source file on disk is **never** overwritten unless every op
succeeded and the workbook saved cleanly.

Non-fatal warnings surfaced in the JSON envelope:

- `set_style` matched 0 cells (selector resolved to nothing styleable).
- `delete_rows` count > 100 (destructive — double-check the range).

## Atomicity note

Ops are applied to an in-memory `Workbook`. If op N fails, ops 0..N-1
exist only in memory; the file on disk is untouched until `wb.save()`.
The script always opens a fresh workbook and saves to `--out`, so the
input file is safe.

## Common patterns

**Fix a number after the report was filed:**

```jsonc
{
  "operations": [
    {"op": "set_cell", "target": "sheet:Q1 > C5", "value": 1450000},
    {"op": "set_cell", "target": "sheet:Q1 > C6", "formula": "SUM(C2:C5)"}
  ]
}
```

**Style a header row + freeze it:**

```jsonc
{
  "operations": [
    {"op": "set_style", "target": "sheet:Sales > A1:F1", "style": "header"}
  ]
}
```

(Freeze panes are a sheet property — set them in the spec or via raw
openpyxl, no patch op for it currently.)

**Append a forecast row + extend the chart range:**

```jsonc
{
  "operations": [
    {"op": "set_cell", "target": "sheet:Q1 > A8", "value": "Forecast",
     "style": "subheader"},
    {"op": "set_cell", "target": "sheet:Q1 > B8", "formula": "B7 * 1.10"},
    {"op": "update_chart_data", "target": "sheet:Q1 > chart:0",
     "data_range": "A1:B8"}
  ]
}
```
