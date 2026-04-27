# Patch DSL

Declarative edits for an existing `.pptx`. Used by `scripts/edit_deck.py`.

## Selector grammar

```
slide:N                      # N-th slide (zero-indexed)
slide:last                   # last slide
slide:N > title              # title placeholder (or topmost text box fallback)
slide:N > subtitle           # subtitle placeholder
slide:N > body               # body placeholder (the bullet list)
slide:N > bullet:K           # K-th paragraph inside the body
slide:N > notes              # speaker notes
slide:N > chart              # first chart
slide:N > chart:K            # K-th chart
slide:N > image              # first picture
slide:N > image:K            # K-th picture
slide:N > table              # first table
slide:N > table:K            # K-th table
slide:N > table[:K] > cell[r=R,c=C]   # one cell of a table (zero-indexed
                                      # rows include the header row)
```

Selectors are parsed left-to-right. The first step must always be `slide:…`.
Steps support an optional `[k=v,…]` bracket suffix; today only `cell[r=…,c=…]`
uses it.

## Operations

Each entry of `operations` is one op:

### set_text

```json
{"op": "set_text", "target": "slide:2 > title", "value": "New title"}
```
Replaces the full text of the targeted shape (or bullet paragraph). Preserves the first run's font/size/colour when possible.

### replace_bullets

```json
{"op": "replace_bullets", "target": "slide:3", "value": [
  "parent bullet",
  ["child 1", "child 2"],
  "another parent"
]}
```
Rebuilds the entire body of a bullets slide. A list immediately after a string becomes children of that string (2 levels supported).

### set_notes

```json
{"op": "set_notes", "target": "slide:2", "value": "Speaker notes..."}
```
Updates speaker notes. Fails if the slide has no notes part yet.

### delete_slide

```json
{"op": "delete_slide", "target": "slide:7"}
```
Removes the slide cleanly (slide part + its rels + any notes part + the `<p:sldId>` entry + the package relationship).

### move_slide

```json
{"op": "move_slide", "from": 5, "to": 2}
```
Reorders slides by modifying `<p:sldIdLst>` only (no parts move).

### insert_slide

```json
{"op": "insert_slide", "position": 3, "slide": {
  "type": "bullets", "title": "...", "bullets": [...]
}}
```
Builds a new slide from a slide spec (same schema as `build_deck.py`) and inserts it at `position`. All 12 slide types (title, section, bullets, two_column, image, table, chart, comparison, quote, steps, kpi, closing) supported.

### swap_image

```json
{"op": "swap_image", "target": "slide:4 > image", "value": "/path/to/new.png"}
```
Replaces the binary bytes of the targeted picture — same partname, new content. Path can be local file or `http(s)://` URL. JPG/PNG/GIF/BMP/TIFF supported.

### update_chart

```json
{"op": "update_chart", "target": "slide:5 > chart",
 "categories": ["Q1", "Q2", "Q3", "Q4"],
 "series": [
   {"name": "Revenue", "values": [100, 120, 140, 160]},
   {"name": "Target",  "values": [110, 130, 150, 180]}
 ]}
```
Updates chart data in place. Series **count** must match existing chart. Categories length must match each series' values length. Colours and chart type are preserved.

### update_table_cell

```json
{"op": "update_table_cell",
 "target": "slide:4 > table > cell[r=2,c=1]",
 "value": "new cell text"}
```
Replaces the text of one table cell. Rows and columns are zero-indexed and
the header row is row 0. Preserves the cell's first run formatting
(font/size/colour). Use `table:K` when a slide has multiple tables.

### set_style

```json
{"op": "set_style", "target": "slide:2 > title",
 "font": "Georgia", "size": 48, "color": [20, 20, 20],
 "bold": true, "italic": false}
```
All fields optional. Applies to every text run in the targeted shape/bullet.
`font` writes the latin/east-asian/complex-script slots together so non-Latin
text keeps the new typeface. If the selector matches text but no runs end up
modified (e.g. shape contains only paragraphs without runs yet), the op
emits a `matched 0 runs` warning rather than failing.

## Validation & warnings

`insert_slide` runs the spec validator on its `slide` payload before any
rendering. Bad specs come back as a structured `OpError` with the field
path (e.g. `slide[0].kind: must be one of [...]`) so the LLM can correct
without trial-and-error.

The script's `warnings` array surfaces non-fatal flags after a successful
patch:

- `replace_bullets`: >9 bullets — may overflow.
- `insert_slide` of a `table`: >12 rows — renderer truncates.
- `insert_slide` of a `bullets`: >9 items — may overflow.
- `insert_slide` of a `chart`: >6 series — legend may overflow.
- `set_style`: matched 0 runs (no text to style).

Treat warnings as suggestions, not errors. The output file still saves.

## Atomicity note

Ops are applied in sequence to an in-memory Package. If op N fails, ops 0..N-1 are already applied in memory but the source file is untouched — nothing is saved. To retry safely, just fix the patch and re-run against the original input.

## Common patterns

**Update a board report's KPI numbers + chart:**

```json
{
  "operations": [
    {"op": "set_text", "target": "slide:0 > subtitle", "value": "2026 Q2"},
    {"op": "update_chart", "target": "slide:3 > chart",
     "categories": ["Jan", "Feb", "Mar"],
     "series": [{"name": "ARR", "values": [1.85, 2.05, 2.31]}]}
  ]
}
```

**Drop old slides and append a conclusion:**

```json
{
  "operations": [
    {"op": "delete_slide", "target": "slide:7"},
    {"op": "delete_slide", "target": "slide:6"},
    {"op": "insert_slide", "position": 6, "slide": {
      "type": "closing", "title": "Summary",
      "subtitle": "Move to Q&A"
    }}
  ]
}
```

Note: when deleting multiple slides, **delete from the highest index first** so the indices of the remaining slides don't shift mid-patch.
