# xlsx spec schema

The spec is a JSON object with `meta` and `sheets`.

```jsonc
{
  "meta": {
    "title": "Q1 Board Report",        // optional — written into workbook properties
    "theme": "corporate",               // default | corporate | minimal | dark
    "theme_overrides": {                // optional — override individual Theme fields
      "accent": [29, 78, 216],
      "body_font": "Calibri"
    }
  },
  "sheets": [ /* one object per sheet, in tab order */ ]
}
```

Each sheet object **requires** `name` and **at least one** of `rows` or
`cells`. Everything else is optional.

```jsonc
{
  "name": "Summary",                    // required, ≤31 chars, no \\/?*[]:
  "tab_color": "1D4ED8",                // optional — RRGGBB hex or [r,g,b]
  "freeze": "A2",                       // optional — single A1 cell
  "rows": [                             // row-major shorthand
    ["Region", "Revenue", "Growth"],
    ["KR", 1200000, 0.18],
    ["Total", "=SUM(B2:B4)", "=AVERAGE(C2:C4)"]
  ],
  "cells": [                            // explicit cell refs (override row data)
    {"ref": "D1", "value": "Notes", "style": "header"}
  ],
  "columns": [{"width": 18}, {"width": 14}, {"width": 12}],
  "row_heights": [{"row": 1, "height": 22}],
  "merge": ["A1:C1"],
  "style_rows": [                       // apply a named style to a whole row
    {"row": 1, "style": "header"},
    {"row": 4, "style": "total"}
  ],
  "style_ranges": [                     // apply a style to a range
    {"range": "A2:A3", "style": {"bold": true}}
  ],
  "number_formats": [
    {"range": "B2:B4", "format": "$#,##0"},
    {"range": "C2:C4", "format": "0.0%"}
  ],
  "tables": [
    {"name": "Sales", "range": "A1:C4", "style": "TableStyleMedium2",
     "row_stripes": true}
  ],
  "conditional": [
    {"range": "B2:B4", "kind": "data_bar", "color": "1D4ED8"},
    {"range": "C2:C4", "kind": "color_scale"},
    {"range": "D2:D4", "kind": "icon_set", "icon_style": "3TrafficLights1"},
    {"range": "B2:B4", "kind": "cell_value", "op": "lessThan",
     "formula": "1000", "fill": [255, 220, 220]}
  ],
  "charts": [
    {"kind": "column", "title": "Revenue by region",
     "data_range": "A1:C4", "anchor": "F2",
     "x_axis_title": "Region", "y_axis_title": "USD",
     "width": 16, "height": 9}
  ]
}
```

## Field reference

### Cells

A cell value can be:

- **scalar**: string / int / float / bool / null.
- **formula**: string starting with `=`, e.g. `"=SUM(B2:B4)"`.
- **formula object**: `{"f": "SUM(B2:B4)"}` — equivalent, slightly less typing.

`{"ref": "B3", "value": ..., "style": "header"|{...}}` overrides the same
ref pulled from `rows`. Use this for ad-hoc spot-formatting on top of the
bulk row data.

### Styles

A `style` is either a **name** (string) referencing a theme style, or an
**inline dict** with these fields (all optional):

| Field          | Type       | Notes                              |
|----------------|------------|------------------------------------|
| `font_name`    | string     | overrides theme.body_font          |
| `font_size`    | number     | points                             |
| `font_color`   | RGB array  | `[r, g, b]`                        |
| `bold`         | bool       |                                    |
| `italic`       | bool       |                                    |
| `fill`         | RGB array  | solid background                   |
| `align_h`      | enum       | left \| center \| right            |
| `align_v`      | enum       | top \| center \| bottom            |
| `number_format`| string     | Excel format code, e.g. `"$#,##0"` |
| `border`       | bool       | thin all-around when true          |
| `border_color` | RGB array  | defaults to theme.grid             |
| `wrap_text`    | bool       |                                    |

Built-in theme styles: `header`, `subheader`, `total`, `muted`, `input`,
`output`, `currency`, `percent`, `integer`, `date`. See `themes.md`.

### Charts

`data_range` is required and must be a contiguous A1 range. By default the
first row supplies series names and the first column supplies categories
(both can be turned off — `titles_from_data: false`,
`categories_in_first_column: false`). `anchor` is the top-left cell of the
chart frame; default `"F2"`. Pie charts auto-colour each slice from the
theme palette.

### Conditional formatting

`kind` is one of:

- `data_bar` — gradient bar inside the cell. Optional `color`, `show_value`.
- `color_scale` — 3-stop heatmap. Optional `low_color` / `mid_color` /
  `high_color`.
- `icon_set` — traffic lights / arrows. `icon_style` (default
  `"3TrafficLights1"`).
- `cell_value` — Excel's "Cell Value …" rule. Required: `op`
  (`greaterThan`, `lessThan`, `equal`, `between`, …) and `formula`
  (the comparison value). Optional: `font_color`, `fill`.

### Theme overrides

`meta.theme_overrides` accepts any field of `lib.themes.Theme`. Most useful:

| Field             | Type      | Example             |
|-------------------|-----------|---------------------|
| `bg`              | RGB       | `[250, 250, 250]`   |
| `fg`              | RGB       | `[30, 30, 30]`      |
| `accent`          | RGB       | `[29, 78, 216]`     |
| `accent_soft`     | RGB       | `[219, 234, 254]`   |
| `body_font`       | string    | `"Calibri"`         |
| `heading_font`    | string    | `"Cambria"`         |
| `chart_series`    | array     | `[[r,g,b], ...]`    |

Unknown fields are silently ignored.
