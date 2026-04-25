# pdf spec schema

```jsonc
{
  "meta": {
    "title": "...",
    "author": "...",
    "subject": "...",
    "theme": "default",      // default | formal | report | minimal
    "theme_overrides": { "accent": [29, 78, 216] },
    "size": "A4",            // A4 | Letter | Legal
    "orientation": "portrait"  // portrait | landscape
  },
  "blocks": [ ... ]
}
```

## Block types (same as docx + 2 PDF-only types)

### title (PDF-only)
```jsonc
{"type": "title", "text": "Large document title"}
```
Large centered title. For cover pages.

### spacer (PDF-only)
```jsonc
{"type": "spacer", "height": 40}
```
Vertical spacing (pt units).

### heading, paragraph, bullets, numbered, table, image, page_break, quote, code, horizontal_rule, toc, kpi_row, two_column

Same as docx spec. See `packages/skills/docx/reference/spec_schema.md`.

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
