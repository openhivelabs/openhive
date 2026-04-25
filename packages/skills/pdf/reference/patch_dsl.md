# pdf Patch DSL

`edit_doc.py --in <pdf> --patch <patch.json> --out <out.pdf>`

Two op families: **page ops** (page manipulation) + **spec ops** (content changes, rebuild).

They can be mixed in one patch — spec ops apply first and regenerate the PDF, then page ops overlay onto that result.

## Page ops — pypdf-backed, content unchanged

```json
{"op": "merge", "append": ["cover.pdf", "appendix.pdf"]}
```
Append PDFs listed in `append` to the input PDF, in order.

```json
{"op": "extract_pages", "pages": [0, 2, 4]}
```
Extract only the given zero-indexed pages into a new PDF.

```json
{"op": "split", "ranges": [[0, 2], [3, 5]], "out_dir": "/tmp/splits"}
```
Save one new PDF per (start, end) range. This op creates multiple outputs, so **patch stops after execution** — `--out` is ignored.

```json
{"op": "rotate", "pages": [0, 1], "degrees": 90}
```
`degrees` must be a multiple of 90.

```json
{"op": "overlay_text",
 "text": "DRAFT",
 "pages": [0, 1, 2],
 "x": 150, "y": 400,
 "size": 80,
 "color": [0.85, 0.1, 0.1],
 "rotation": 45,
 "opacity": 0.18
}
```
Text stamp on all/selected pages. If `pages` is omitted, applies to all pages. Color is three 0..1 floats.

```json
{"op": "overlay_image",
 "image": "/path/to/logo.png",
 "pages": [0],
 "x": 36, "y": 36,
 "width": 120, "height": 40,
 "opacity": 1.0
}
```
Logo/seal image stamp.

## Spec ops — edit .spec.json, then rebuild

```json
{"op": "set_text", "position": 0, "value": "New title"}
```
Replace only block N's text field. Use for blocks with a text field, such as `title/heading/paragraph/quote/code`.

```json
{"op": "replace_block", "position": 3, "block": {
  "type": "kpi_row", "stats": [...]
}}
```
Replace the whole block.

```json
{"op": "insert_block", "position": 2, "block": {
  "type": "paragraph", "text": "..."
}}
```
Insert a block at the given position. If `position` equals array length, append to the end.

```json
{"op": "delete_block", "position": 5}
```

```json
{"op": "move_block", "from": 5, "to": 2}
```

```json
{"op": "update_table_cell",
 "position": 4,
 "r": 0, "c": 1,
 "value": "$2.3M"
}
```
Block `position` must be a table.

## Round-trip examples

**Report update + watermark:**
```json
{
  "operations": [
    {"op": "set_text", "position": 0, "value": "Q4 report (revised)"},
    {"op": "update_table_cell", "position": 10, "r": 1, "c": 2, "value": "$2.3M"},
    {"op": "overlay_text", "text": "CONFIDENTIAL", "opacity": 0.15,
     "rotation": 45, "x": 140, "y": 400, "size": 72}
  ]
}
```

**Reorder pages + extract subset:**
```json
{
  "operations": [
    {"op": "extract_pages", "pages": [2, 3, 1, 0]}
  ]
}
```
