# Themes

A theme is a palette + a small set of named cell styles. Every renderer
decision pulls from the active theme, so swapping a theme should never
require touching renderer code.

## Built-in themes

| Name        | Accent     | Use when                                           |
|-------------|------------|----------------------------------------------------|
| `default`   | OpenHive amber `#F9A825` | Generic reports, brand-neutral.       |
| `corporate` | Royal blue `#1D4ED8`     | Finance, board decks, formal output.  |
| `minimal`   | Black `#282828`          | Print, B/W friendly, austere look.    |
| `dark`      | Amber on dark grey       | Screen reading, low-light dashboards. |

## Named cell styles

These ship with every theme and resolve via `{"style": "name"}` on cells,
rows, ranges, or patch ops:

| Name        | What it sets                                                |
|-------------|-------------------------------------------------------------|
| `header`    | white text on accent fill, bold, bordered, 11 pt            |
| `subheader` | dark text on accent_soft fill, bold, 11 pt                  |
| `total`     | bold, light grey fill, right-aligned, 11 pt                 |
| `muted`     | muted colour, italic, 10 pt                                 |
| `input`     | blue text on light blue fill (cells the user should fill)   |
| `output`    | bold body text (cells the formulas write to)                |
| `currency`  | only sets `number_format` to `"$#,##0.00"`                  |
| `percent`   | only sets `number_format` to `"0.0%"`                       |
| `integer`   | only sets `number_format` to `"#,##0"`                      |
| `date`      | only sets `number_format` to `"yyyy-mm-dd"`                 |

Combine: name a theme style, then layer overrides via inline dict on
the same op — the name supplies defaults, the dict patches them.
Example: `{"style": "header"}` then a separate
`{"style": {"fill": [29, 78, 216]}}` op for a different header colour
on the same row.

## Overrides

`meta.theme_overrides` patches any `Theme` field. Most useful:

```jsonc
"theme_overrides": {
  "accent": [29, 78, 216],
  "accent_soft": [219, 234, 254],
  "body_font": "Calibri",
  "chart_series": [[29, 78, 216], [80, 80, 80], [200, 140, 40]]
}
```

Note: theme overrides do **not** retroactively rewrite the named cell
styles — the styles dict was baked at theme construction time. Override
the per-cell style directly if you need a one-off.
