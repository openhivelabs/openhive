# Troubleshooting

## Build fails with `slide[i].xxx: ...`

The validator is telling you exactly which slide and which field. Re-read the field's spec in `spec_schema.md`. Common culprits:

- Field named differently than expected (`items` vs `bullets`, `data` vs `rows`).
- Wrong type (a string where an array is required).
- Mismatched lengths (`chart.series.values.length != categories.length`).

## `image not found: ...`

`image` must resolve to either a local file that exists, or an `http://` / `https://` URL that returns image bytes. The script does not send cookies or auth headers, so gated resources won't work — download first, then pass a local path.

## Chart looks default grey instead of themed colors

Some chart types (notably `scatter` on certain Office versions) silently reject the series fill override. The fallback is the default Office palette, which is usable but ignores `theme.chart_series`. If this matters, switch to `column` / `line` / `bar`.

## `edit_deck.py` only supports append + reorder

Intentional. `python-pptx` has no public API to fully delete a slide part from the package — removed slides leave orphan XML parts that trigger a duplicate-name warning at save time. Files still open in PowerPoint/Keynote but grow over edits, and replace/move ops hit ordering bugs.

Path for destructive edits:
1. `inspect_deck.py` the original to see content.
2. Rebuild the JSON spec (either manually or from a known canonical version).
3. `build_deck.py` with the new spec → fresh deck.

## Fonts don't look like the theme intended

`python-pptx` doesn't embed fonts. The deck carries font *names* — rendering depends on what's installed on the viewer's machine. If Georgia (corporate theme) isn't installed, the viewer substitutes. For critical visuals, choose fonts that ship with macOS + Windows + LibreOffice (Helvetica, Arial, Calibri, Georgia, Times New Roman).

## Non-ASCII characters look like boxes

Same cause — the viewer's font doesn't have the glyph. Most built-in fonts cover Korean/Japanese. Avoid exotic fonts in `theme_overrides` for multilingual decks.

## Warnings printed but file is valid

The skill prints structured JSON on stdout. Any human-readable warnings from `python-pptx` (e.g. UserWarnings from its xml layer) go to stderr and don't affect the `{"ok": true, ...}` result. Pipe stderr to `/dev/null` if you need clean stdout.
