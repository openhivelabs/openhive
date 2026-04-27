# Examples

End-to-end specs you can pipe into `build_xlsx.py`.

## 1. Quarterly financial report (single sheet)

```jsonc
{
  "meta": {"theme": "corporate"},
  "sheets": [{
    "name": "Q1",
    "tab_color": "1D4ED8",
    "freeze": "A2",
    "columns": [{"width": 18}, {"width": 14}, {"width": 14}, {"width": 14}],
    "rows": [
      ["Region", "Revenue", "Cost", "Margin"],
      ["KR",   1200000, 720000, "=B2-C2"],
      ["JP",    850000, 520000, "=B3-C3"],
      ["CN",    640000, 410000, "=B4-C4"],
      ["ME",    320000, 180000, "=B5-C5"],
      ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)"]
    ],
    "style_rows": [
      {"row": 1, "style": "header"},
      {"row": 6, "style": "total"}
    ],
    "number_formats": [
      {"range": "B2:D6", "format": "$#,##0"}
    ],
    "tables": [{"name": "Sales", "range": "A1:D6",
                "style": "TableStyleMedium9"}],
    "conditional": [
      {"range": "D2:D5", "kind": "data_bar", "color": "1D4ED8"}
    ],
    "charts": [
      {"kind": "column", "title": "Revenue by region",
       "data_range": "A1:B5", "anchor": "F2",
       "x_axis_title": "Region", "y_axis_title": "USD"}
    ]
  }]
}
```

## 2. KPI dashboard (multi-sheet with cross-references)

```jsonc
{
  "meta": {"theme": "default"},
  "sheets": [
    {
      "name": "Inputs",
      "rows": [
        ["Metric", "Value"],
        ["Active users", 1204],
        ["Conversion rate", 0.124],
        ["ARR (USD)", 3400000]
      ],
      "style_rows": [{"row": 1, "style": "header"}],
      "number_formats": [
        {"range": "B3", "format": "0.0%"},
        {"range": "B4", "format": "$#,##0"}
      ]
    },
    {
      "name": "Dashboard",
      "tab_color": "F9A825",
      "freeze": "A2",
      "rows": [
        ["KPI", "Current", "Target", "Status"],
        ["Active users", "=Inputs!B2", 1500,
         "=IF(B2>=C2,\"on track\",\"behind\")"],
        ["Conversion", "=Inputs!B3", 0.15,
         "=IF(B3>=C3,\"on track\",\"behind\")"],
        ["ARR", "=Inputs!B4", 4000000,
         "=IF(B4>=C4,\"on track\",\"behind\")"]
      ],
      "style_rows": [{"row": 1, "style": "header"}],
      "number_formats": [
        {"range": "B3:C3", "format": "0.0%"},
        {"range": "B4:C4", "format": "$#,##0"}
      ],
      "conditional": [
        {"range": "D2:D4", "kind": "cell_value",
         "op": "equal", "formula": "\"on track\"",
         "fill": [220, 252, 220]},
        {"range": "D2:D4", "kind": "cell_value",
         "op": "equal", "formula": "\"behind\"",
         "fill": [254, 226, 226]}
      ]
    }
  ]
}
```

## 3. Raw data export with chart (round-trip-ready)

```jsonc
{
  "meta": {"theme": "minimal"},
  "sheets": [{
    "name": "Logins by day",
    "freeze": "A2",
    "rows": [
      ["Date", "Web", "Mobile"],
      ["2026-01-01", 1240, 880],
      ["2026-01-02", 1310, 920],
      ["2026-01-03", 1180, 950]
    ],
    "style_rows": [{"row": 1, "style": "header"}],
    "number_formats": [{"range": "A2:A4", "format": "yyyy-mm-dd"}],
    "charts": [
      {"kind": "line", "title": "Daily logins",
       "data_range": "A1:C4", "anchor": "E2"}
    ]
  }]
}
```

## 4. Adapting on the fly — common LLM pitfalls

- **Sheet names with `/` or `:`** — Excel rejects them. Validator catches
  this; rename or strip before re-running.
- **Mismatched header / data widths** — `rows[0]` of length 3 with
  subsequent rows of length 5 builds fine but the table range you set
  in `tables[].range` should cover the *widest* row.
- **Formulas referencing another sheet** — use `'Sheet Name'!A1` (note
  single quotes around names with spaces). The build path passes the
  formula string straight through; openpyxl writes it; Excel evaluates
  on open.
- **Chart `data_range` outside the sheet** — silent — chart renders
  empty. Always sanity-check by running `inspect_xlsx.py` on the output.
- **Pie chart with multiple series** — only the first series is plotted
  (Excel's pie type is single-series). Use `column` or `bar` instead.

## 5. Edit-only flow (no spec rebuild)

When the spec doesn't exist (the workbook came in from outside), use
`edit_xlsx.py` exclusively:

```jsonc
// patch.json
{
  "operations": [
    {"op": "set_cell",  "target": "sheet:Summary > C5",  "value": 1450000},
    {"op": "set_cell",  "target": "sheet:Summary > C6",  "formula": "SUM(C2:C5)"},
    {"op": "set_style", "target": "sheet:Summary > A1:F1", "style": "header"},
    {"op": "set_tab_color", "target": "sheet:Summary", "color": "1D4ED8"}
  ]
}
```

Then:

```bash
python scripts/edit_xlsx.py --in input.xlsx --patch patch.json --out output.xlsx
```
