# docx Patch DSL

`edit_doc.py --in <docx> --patch <patch.json> --out <out.docx>`

## Selector grammar

| Selector                          | Meaning                                      |
|-----------------------------------|----------------------------------------------|
| `heading:N`                       | N-th heading (document order)                |
| `heading:N[level=2]`              | level filter                                 |
| `paragraph:N`                     | N-th normal paragraph (excluding headings)   |
| `table:N`                         | N-th table                                   |
| `table:N > cell[r=R,c=C]`         | Specific cell                                |
| `image:N`                         | N-th image                                   |
| `block:N`                         | N-th spec-level block (spec patches only)    |

Indexes are zero-based. They match `index` from `inspect_doc.py` output.

## Live ops (direct python-docx edit)

```json
{"op": "set_text",          "target": "heading:2",              "value": "..."}
{"op": "update_table_cell", "target": "table:0 > cell[r=1,c=2]", "value": "..."}
{"op": "swap_image",        "target": "image:0",                "value": "path_or_url"}
{"op": "set_style",         "target": "heading:0",
                            "font": "Georgia", "size": 24,
                            "color": [200, 30, 30],
                            "bold": true,  "italic": false}
```

## Spec ops (structural edits — requires .spec.json)

`build_doc.py` automatically saves `.spec.json` next to the document. Spec ops edit this file and rebuild:

```json
{"op": "insert_block",  "position": 5,  "block": { "type": "paragraph", "text": "..." }}
{"op": "delete_block",  "position": 3}
{"op": "replace_block", "position": 7,  "block": { ... }}
{"op": "move_block",    "from": 2, "to": 6}
```

If spec.json is missing, generate it with `extract_doc.py` first.

## Mixed patches

live + spec can be mixed. Processing order:
1. Apply live ops to the original (python-docx edit)
2. Edit .spec.json with spec ops
3. If spec changed, generate a new docx with build_doc.py (live edits are overwritten during this step, so do not touch the same target from both sides)

Recommended: use **spec ops only** for structural changes, and **live ops only** for string tuning.

## Examples

**Replace heading + update table cell + insert block:**

```json
{
  "operations": [
    {"op": "set_text", "target": "heading:0", "value": "Q4 update"},
    {"op": "update_table_cell", "target": "table:0 > cell[r=1,c=1]", "value": "$2.3M"},
    {"op": "insert_block", "position": 4, "block": {
      "type": "quote", "text": "Goal achieved!", "attribution": "CEO"
    }}
  ]
}
```
