# pptx spec schema

The spec is a JSON object with two top-level keys: `meta` and `slides`.

```jsonc
{
  "meta": {
    "title": "Q4 Board Report",      // optional, used for file metadata
    "theme": "default",               // default | dark | minimal | corporate
    "theme_overrides": {              // optional. Override individual Theme fields.
      "accent": [29, 78, 216],        // RGB triplet as JSON array
      "heading_font": "Georgia"
    },
    "size": "16:9"                    // 16:9 | 4:3 | a4
  },
  "slides": [ /* one object per slide, in order */ ]
}
```

Every slide object has `type` (required, enum) and optional `notes` (speaker notes, plain text).

---

## title

```jsonc
{
  "type": "title",
  "title": "OpenHive",                          // required
  "subtitle": "Agent orchestration, local-first",
  "author": "Team OpenHive",
  "date": "2026-04-20"
}
```

## section

Divider between major parts of the deck. Accent stripe on the left.

```jsonc
{ "type": "section", "title": "1. Background", "subtitle": "Why now" }
```

## bullets

Top-aligned title + bullet list. Nesting: immediately follow a string with an array.

```jsonc
{
  "type": "bullets",
  "title": "Why now",
  "bullets": [
    "LLMs create schema and UI at runtime",
    "User = conversation",
    ["Subpoint 1", "Subpoint 2"],
    "Local-first"
  ]
}
```

## two_column

Two columns sharing a title. Each side has its own `kind`: `text` | `bullets` | `image`.

```jsonc
{
  "type": "two_column",
  "title": "Architecture at a glance",
  "left":  { "kind": "bullets", "content": ["engine", "tools", "skills"] },
  "right": { "kind": "image", "content": "/path/to/arch.png", "fit": "contain" }
}
```

## image

```jsonc
{
  "type": "image",
  "title": "Dashboard screenshot",      // optional
  "image": "https://example.com/shot.png",
  "fit": "contain",                     // contain | cover | full_bleed
  "align": "center",                    // optional. left | center | right
                                        // (only meaningful when fit=contain
                                        // and the image's aspect leaves slack)
  "caption": "The Run-mode canvas"      // optional
}
```

`align` also drives the caption's horizontal alignment so it sits under the
visible image, not floating across the empty side.

## table

```jsonc
{
  "type": "table",
  "title": "Skill roster",
  "headers": ["Skill", "Engine", "Status"],
  "rows": [
    ["text-file", "builtin", "done"],
    ["pptx",      "python-pptx", "done"]
  ],
  "col_widths": [3, 2, 1]               // optional. Relative weights —
                                        // normalised to fill the content
                                        // band. Length must equal headers.
                                        // Omit for equal columns.
}
```

## chart

```jsonc
{
  "type": "chart",
  "title": "Quarterly ARR",
  "kind": "column",                      // bar | column | line | pie | area | scatter
  "categories": ["Q1", "Q2", "Q3", "Q4"],
  "series": [
    { "name": "Base",    "values": [100, 140, 210, 320] },
    { "name": "Stretch", "values": [120, 180, 290, 450] }
  ]
}
```

- `pie`: put a single series whose `values.length == categories.length`.
- `scatter`: `categories` is the x-axis values (numeric recommended); each series provides y-values of the same length.

## comparison

```jsonc
{
  "type": "comparison",
  "title": "Option comparison",
  "columns": [
    { "header": "Option A", "points": ["Cheap", "Slow"] },
    { "header": "Option B", "points": ["Fast", "Expensive"] }
  ]
}
```

2–3 columns render best. 4 is possible but text becomes small.

## quote

```jsonc
{
  "type": "quote",
  "quote": "Software moats are schema and UI.",
  "attribution": "OpenHive team"
}
```

## steps

Numbered circles on a connecting line, 3–5 phases.

```jsonc
{
  "type": "steps",
  "title": "User journey",
  "steps": [
    { "title": "Install",  "description": "openhive serve" },
    { "title": "Design",   "description": "agents + reporting lines" },
    { "title": "Run",      "description": "chat/cron/webhook" }
  ]
}
```

## kpi

Hero stats arranged horizontally.

```jsonc
{
  "type": "kpi",
  "title": "Current metrics",              // optional
  "stats": [
    { "value": "42%",  "label": "conversion", "delta": "+3pp" },
    { "value": "$1.2M","label": "ARR",         "delta": "+18%" },
    { "value": "1,204","label": "active teams" }
  ]
}
```

`delta` that starts with `+` is rendered green, `-` is red, other values stay theme-muted.

## closing

Thank-you / Q&A slide. If `title` is omitted, uses "Thank you".

```jsonc
{ "type": "closing", "title": "Thank you", "subtitle": "github.com/openhivelabs/openhive" }
```

---

## Theme overrides (advanced)

`meta.theme_overrides` accepts any field of `lib.themes.Theme`. Most common:

| Field           | Type       | Example             |
|-----------------|------------|---------------------|
| `bg`            | RGB array  | `[250, 250, 250]`   |
| `fg`            | RGB array  | `[30, 30, 30]`      |
| `heading`       | RGB array  | `[20, 20, 20]`      |
| `accent`        | RGB array  | `[29, 78, 216]`     |
| `heading_font`  | string     | `"Georgia"`         |
| `body_font`     | string     | `"Helvetica"`       |
| `size_title`    | int (pt)   | `56`                |
| `size_body`     | int (pt)   | `20`                |

Unknown fields are silently ignored.
