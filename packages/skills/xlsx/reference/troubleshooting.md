# Troubleshooting

## Build fails with `sheet[...]: ...`

The validator names the offending sheet and field. Read `spec_schema.md`
for the exact contract. Frequent culprits:

- Sheet name longer than 31 chars or containing `\\ / ? * [ ] :`.
- Two sheets with the same `name`.
- Bad A1 ref in `cells[].ref`, `merge[]`, `tables[].range`,
  `charts[].data_range`, or `conditional[].range`.
- `chart.kind` not in `bar | column | line | pie | area | scatter`.
- `conditional.kind` not in `data_bar | color_scale | icon_set | cell_value`.

## Patch fails with `op[i] (kind): ...`

The op index + name pinpoints the op. Common cases:

- `sheet:Foo` doesn't exist — sheet names are case-sensitive. Use
  `inspect_xlsx.py` to list `sheetnames`.
- `set_range` with a 2D `value` whose row/col counts don't fit the
  selector range — extra cells stay untouched, missing cells stay at
  whatever they were. No error, but the result may not be what you
  expected.
- `update_chart_data` with a target that resolves to a non-existent
  chart — `chart:0` on a sheet with no charts.

## Formula shows as text instead of computed value

Two possible causes:

1. **Missing `=`** — `set_cell` with `value: "SUM(B2:B4)"` writes a
   string. Use `formula: "SUM(B2:B4)"` (or value with leading `=`).
2. **Excel hasn't computed yet** — openpyxl writes formulas but does
   not compute them. Open the file in Excel/Numbers/LibreOffice and the
   formula evaluates on first paint. If you need pre-computed values,
   compute them in your spec construction step.

## Chart looks empty after rebuild from extracted spec

`extract_xlsx.py` cannot recover the chart's original `data_range`
reference (openpyxl doesn't expose it). Extract leaves `"A1:B2"` as a
placeholder and emits a warning. Edit the extracted spec's
`charts[].data_range` to point at the right block before re-building.

## Excel says "Excel found a problem with some content"

Usually means a part is malformed or a relationship target is missing.
Run:

```bash
python scripts/validate_xlsx.py --in book.xlsx
```

It walks every part, confirms well-formedness + content-type coverage +
relationship resolution. The first failure points at the offending
part path.

## Non-ASCII characters look like boxes

The viewer's default font doesn't have glyphs for those scripts.
`build_xlsx.py` auto-pins the theme fonts to Noto Sans KR / JP / SC /
Arabic / etc. when the spec contains those scripts (via the same
multi-script detection used by the docx and pptx skills). If you
override `theme.body_font` manually, make sure that family has full
coverage — or stick with platform defaults like Calibri (Windows) /
Helvetica + Apple SD Gothic Neo (macOS).

## Conditional formatting doesn't appear

Most readers ignore conditional formatting at first paint. Re-open the
file or scroll the affected range and the rule kicks in. If the rule
**still** doesn't show, the most common cause is a `range` that
includes the header row — the rule applies but every cell in the
header is non-numeric and no bar/scale renders. Restrict the range to
data rows only (`B2:B5`, not `B1:B5`).

## Tables conflict with other styling

Native xlsx tables (`tables[]`) apply their own striped formatting.
Per-cell `style_ranges` on the same range will be **overlaid** — the
table style wins for borders, the per-cell wins for font colour. If
you want full control, drop the `tables` entry and apply your own
borders + alt-row fills via `style_ranges`.

## Pivot tables / macros / embedded images

Out of scope. Pivot tables are read-and-preserved (a workbook with a
pivot survives extract → build, but you can't add or edit one). Macros
mean `.xlsm` and that's a different file format. Embedded images
(Excel 365 IMAGE function) survive a round-trip but aren't editable.
