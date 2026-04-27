# docx spec schema

```jsonc
{
  "meta": {
    "title": "...",          // document title (metadata)
    "author": "...",
    "subject": "...",
    "theme": "default",      // default | formal | report | minimal
    "theme_overrides": {
      "accent": [29, 78, 216],
      "palette": [[29,78,216], [217,119,6], [22,163,74], [220,38,38]],
      "body_font": "Georgia"
    },
    "size": "A4",            // A4 | Letter | Legal
    "orientation": "portrait"  // portrait | landscape
  },
  "blocks": [ ... ]
}
```

## Block types

### heading
```jsonc
{"type": "heading", "level": 1, "text": "Heading"}
```

### paragraph
```jsonc
{"type": "paragraph", "text": "...", "align": "justify"}
```

### bullets / numbered
```jsonc
{"type": "bullets", "items": ["First", "Second", ["Child 1", "Child 2"], "Third"]}
```

### table
```jsonc
{"type": "table",
 "headers": ["col1", "col2"],
 "rows": [["a", 1], ["b", 2]],
 "style": "zebra"     // grid | light | plain | zebra | minimal
}
```
- `zebra` → alternating row tint using theme `surface`.
- `minimal` → no internal borders, accent underline under header, faint row dividers.

### image
```jsonc
{"type": "image", "path": "/path/or/url", "caption": "...", "width_in": 4.5, "align": "center"}
```

### page_break / horizontal_rule / divider / spacer
```jsonc
{"type": "page_break"}
{"type": "horizontal_rule"}
{"type": "divider", "thickness": 12, "color": [13,90,99]}   // thicker, colored
{"type": "spacer", "height": 24}                              // pt
```

### quote
```jsonc
{"type": "quote", "text": "...", "attribution": "..."}
```

### code
```jsonc
{"type": "code", "text": "print('hi')", "language": "python"}
```

### toc
```jsonc
{"type": "toc", "levels": 3}
```

### kpi_row
```jsonc
{"type": "kpi_row",
 "colored": true,           // cycle palette per tile (default)
 "variant": "tile",         // "tile" | "plain"
 "stats": [
   {"value": "$3.4M", "label": "ARR", "delta": "+23%"},
   {"value": "112%",  "label": "NRR", "delta": "+8pp"}
 ]}
```

### two_column
```jsonc
{"type": "two_column",
 "left":  [{"type": "heading", "level": 2, "text": "..."}, {"type": "paragraph", "text": "..."}],
 "right": [{"type": "bullets", "items": [...]}]}
```

### cover
```jsonc
{"type": "cover",
 "eyebrow": "Investor brief",
 "title": "Loomtide\nQ1 2026 분기 보고서",
 "subtitle": "ARR $3.4M 돌파",
 "date": "2026년 4월 28일",
 "author": "IR",
 "org": "Loomtide, Inc.",
 "band_eyebrow": "이번 분기 한 줄",
 "band_text": "...",
 "band_color": [13, 90, 99]   // optional override (defaults to theme.band)
}
```
Cover automatically inserts a page break after itself.

### chart
```jsonc
{"type": "chart",
 "variant": "bar",            // bar|hbar|stacked_bar|line|area|scatter|donut|pie|sparkline
 "title": "...",
 "x": ["Q1", "Q2", "Q3"],
 "series": [
   {"name": "Revenue", "values": [120, 140, 180]},
   {"name": "Cost",    "values": [80, 90, 110]}
 ],
 "x_label": "...", "y_label": "...",
 "show_values": true,         // bar/hbar: annotate value on each bar
 "show_legend": true,
 "width_in": 6.0, "height_in": 3.2,
 "caption": "..."
}
```
For `donut`/`pie`:
```jsonc
{"type": "chart", "variant": "donut",
 "slices": [{"label": "A", "value": 42}, {"label": "B", "value": 28}]}
```
For `sparkline` (compact inline trend):
```jsonc
{"type": "chart", "variant": "sparkline",
 "values": [3,4,6,5,8,12,11,14],
 "width_in": 2.5, "height_in": 0.6}
```
Charts are rendered as PNG via matplotlib using the theme palette. Not
editable in Word's chart editor — re-render by editing the spec.

### callout
```jsonc
{"type": "callout",
 "variant": "info",     // info|success|warning|danger|note|tip
 "title": "...",
 "text": "...",
 "bullets": ["a", "b"]}
```

### sidebar
```jsonc
{"type": "sidebar",
 "title": "...",
 "text": "...",
 "bullets": [...]}
```

## Theme overrides

`meta.theme_overrides` can override individual Theme fields. Colors are
`[R,G,B]` (0..255). Common fields:

| Field                                                 | Type         | Example                          |
|-------------------------------------------------------|--------------|----------------------------------|
| `fg`, `heading`, `accent`, `muted`, `code_bg`         | RGB          | `[29, 78, 216]`                  |
| `info`, `success`, `warning`, `danger`                | RGB          | `[22, 163, 74]`                  |
| `surface`, `band`                                     | RGB          | `[245, 247, 250]`                |
| `palette`                                             | list of RGB  | `[[29,78,216],[217,119,6],...]`  |
| `heading_font`, `body_font`, `mono_font`              | string       | `"Georgia"`                      |
| `size_title`, `size_subtitle`, `size_h1..h6`,         | int (pt)     | `24`                             |
| `size_body`, `size_small`, `size_code`,               |              |                                  |
| `size_kpi`, `size_kpi_label`                          |              |                                  |
| `margin_top`, `margin_bottom`, `margin_left`, `margin_right` | float (inch) | `1.2`                  |

Unknown fields are silently ignored.
