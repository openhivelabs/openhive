# pdf spec schema

```jsonc
{
  "meta": {
    "title": "...",
    "author": "...",
    "subject": "...",
    "theme": "default",      // default | formal | report | minimal | modern
    "theme_overrides": { "accent": [29, 78, 216], "accent_2": [13, 148, 136] },
    "size": "A4",            // A4 | Letter | Legal
    "orientation": "portrait"  // portrait | landscape
  },
  "blocks": [ ... ]
}
```

## Block types (same as docx + 2 PDF-only types)

### title (PDF-only)
```jsonc
{"type": "title", "text": "Large document title", "subtitle": "Optional subtitle"}
```
Large centered title with optional subtitle and a decorative accent rule.

### callout (PDF-only)
```jsonc
{"type": "callout", "variant": "warning", "title": "Risk",
 "text": "Body text supports **inline markdown**.",
 "bullets": ["bullet a", "bullet b"]}
```
Variants: `info | success | warning | danger | note | tip | neutral`.

### chart (PDF-only)
```jsonc
// bar / line
{"type": "chart", "variant": "bar", "title": "Q1 segments",
 "labels": ["Ent", "Mid", "SMB"],
 "series": [
   {"name": "Q4", "values": [6.1, 2.8, 1.5]},
   {"name": "Q1", "values": [7.6, 3.2, 1.6], "color": [13, 148, 136]}
 ],
 "height": 220, "caption": "USD millions"}
// pie
{"type": "chart", "variant": "pie", "slices": [
   {"label": "Direct", "value": 61},
   {"label": "Partners", "value": 27, "color": [217, 119, 6]}
]}
```

### progress (PDF-only)
```jsonc
{"type": "progress", "bars": [
  {"label": "Plan attainment", "value": 118, "max": 100,
   "tone": "success", "display": "118%"},
  {"label": "Pipeline cover", "value": 84, "max": 100, "tone": "info"}
]}
```
`tone`: `positive | negative | success | danger | warning | info | muted | accent | accent_2 | accent_3`. Or set `color: [r,g,b]` directly.

### kpi_row — per-stat tone

```jsonc
{"type": "kpi_row", "stats": [
  {"label": "Revenue", "value": "$12.4M", "delta": "+18%", "tone": "positive"},
  {"label": "Customers", "value": "1,284", "delta": "+96",  "tone": "accent_2"}
]}
```
Same `tone` vocabulary as `progress`. `delta` color follows its sign
(`+` → success, `-` → danger).

### spacer (PDF-only)
```jsonc
{"type": "spacer", "height": 40}
```
Vertical spacing (pt units).

### heading, paragraph, bullets, numbered, table, page_break, quote, code, horizontal_rule, toc, kpi_row, two_column

Same as docx spec. See `packages/skills/docx/reference/spec_schema.md`.

> **No `image` block.** PDF skill does not embed image files. Use
> `chart`, `kpi_row`, `callout`, or `progress` for visual impact.
> `md_to_spec.py` turns `![alt](url)` into a muted paragraph.

## Theme

Same theme names as docx: `default`, `formal`, `report`, `minimal`.
Fonts are ReportLab built-ins — `Helvetica`, `Times-Roman`, `Courier`.

## Theme overrides

Colors are `[R,G,B]` (0..255). Margins are **point units** (docx uses inch, PDF uses pt) — watch this.

| Field | Type | Default |
|---|---|---|
| `margin_top/bottom/left/right` | float (pt) | 54/54/60/60 |
| `size_*` | int (pt) | e.g. `size_body=11` |
| `*_font` | string | e.g. `Helvetica` (ReportLab built-in) |
