# Troubleshooting

## Build fails with `slide[i].xxx: ...`

The validator is telling you exactly which slide and which field. Re-read the field's spec in `spec_schema.md`. Common culprits:

- Field named differently than expected (`items` vs `bullets`, `data` vs `rows`).
- Wrong type (a string where an array is required).
- Mismatched lengths (`chart.series.values.length != categories.length`).

## Patch fails with `op[i] (kind): ...`

`edit_deck.py` reports which op index and which selector failed. The error is structured (`OpError`) so the LLM can correct the offending field instead of guessing. Most common:

- Selector points at a slide that doesn't have that placeholder type — the slide was built with raw text boxes, so `set_text` falls back to position-ranking. If that still misses, switch to `set_style`/`set_text` on `slide:N > body` or use a more specific shape selector.
- `update_chart` series count mismatch — you cannot grow/shrink series in place. Delete and re-insert the slide instead.
- `insert_slide` validation error — the embedded slide spec is rejected by the same validator `build_deck.py` uses. Fix the field path and re-run.

## `image not found: ...`

`image` must resolve to either a local file that exists, or an `http://` / `https://` URL that returns image bytes. The script does not send cookies or auth headers, so gated resources won't work — download first, then pass a local path.

## Chart looks default grey instead of themed colors

Some chart types (notably `scatter` on certain Office versions) silently reject the series fill override. The fallback is the default Office palette, which is usable but ignores `theme.chart_series`. If this matters, switch to `column` / `line` / `bar`.

## Non-ASCII characters look like boxes

The deck is naming a font that the viewer's machine doesn't have a glyph for. The build pipeline auto-rewrites `heading_font` / `body_font` to the right Noto family for the dominant non-Latin script in the deck (see `reference/fonts.md` for the full table). If you override `theme_overrides.heading_font` manually, make sure the named family has glyphs for every script you write — or bundle Noto.

For raw-XML edits, every `<a:rPr>` needs `<a:latin>`, `<a:ea>`, and `<a:cs>` typeface attributes, otherwise PowerPoint picks different fonts for different scripts in the same run. The patch DSL's `set_style` and the renderer's `_set_run_font` write all three slots automatically.

## Fonts don't look like the theme intended

`python-pptx` doesn't embed fonts. The deck carries font *names* — rendering depends on what's installed on the viewer's machine. If Georgia (corporate theme) isn't installed, the viewer substitutes. For critical visuals, choose fonts that ship with macOS + Windows + LibreOffice (Helvetica, Arial, Calibri, Georgia, Times New Roman) or commit to the Noto family and tell users to install it once.

## File opens with "PowerPoint found a problem" / Keynote "recovered file"

Run `scripts/validate_deck.py --in deck.pptx` — it walks every part, checks well-formedness, content-type coverage, and dangling relationships. The first failure points at the offending part:

- `malformed XML in ppt/slides/slideN.xml` — a manual XML edit produced bad markup; re-render or re-patch.
- `no content-type for /ppt/foo.xml` — added a part via raw OPC without registering it in `[Content_Types].xml`.
- `relationship rId7 -> /ppt/.../bar.xml (part missing)` — added a rel pointing at a part name that isn't in the package, or renamed/dropped a part without updating its referrers.

If the validator passes but the reader still complains, the problem is usually XSD-level (invalid attribute values) — consult `reference/schemas/` and the matching snippet under `reference/snippets/`.

## Round-trip fidelity (extract → edit spec → build)

`extract_deck.py` is best-effort. Slide types that survive a round-trip cleanly: `title`, `section`, `bullets`, `image`, `table`, `chart`, `quote`, `closing`. Slide types that flatten on extraction: `two_column`, `comparison`, `steps`, `kpi` — these get extracted as plain `bullets` with the structural hints lost. If you care about preserving them, edit via `edit_deck.py` patches instead of the round-trip path.

## Warnings printed but file is valid

The skill prints structured JSON on stdout. Any human-readable warnings from `python-pptx` (e.g. UserWarnings from its xml layer) go to stderr and don't affect the `{"ok": true, ...}` result. Pipe stderr to `/dev/null` if you need clean stdout. The `warnings` array in stdout is non-fatal — the file still saves; the warning is a hint that readability may suffer (overflow, big tables, too many series, etc.).
