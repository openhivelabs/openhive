# Canonical specs per slide type

Minimal but realistic examples. Copy, adapt, combine.

## 3-slide intro deck

```json
{
  "meta": { "theme": "default", "size": "16:9" },
  "slides": [
    { "type": "title", "title": "Project Kickoff", "subtitle": "Sales automation Q2", "author": "Jane" },
    { "type": "bullets", "title": "Agenda", "bullets": [
      "Today's goals", "Team intro", "First-week plan"
    ]},
    { "type": "closing", "title": "Questions?" }
  ]
}
```

## Board update (12 slides)

```json
{
  "meta": { "theme": "corporate", "size": "16:9" },
  "slides": [
    { "type": "title", "title": "Q4 Board Update", "subtitle": "2026-04-20", "author": "CEO" },
    { "type": "section", "title": "1. Highlights" },
    { "type": "kpi", "title": "This quarter", "stats": [
      {"value": "$2.1M", "label": "ARR", "delta": "+22%"},
      {"value": "312",   "label": "customers", "delta": "+48"},
      {"value": "97%",   "label": "GRR", "delta": "+1pp"}
    ]},
    { "type": "chart", "title": "Monthly ARR", "kind": "line",
      "categories": ["Jan","Feb","Mar"],
      "series": [{"name":"ARR","values":[1.6,1.85,2.1]}]
    },
    { "type": "section", "title": "2. Product" },
    { "type": "bullets", "title": "Shipped this quarter", "bullets": [
      "Frame export/import",
      "AI dashboard builder",
      ["10+ panel templates", "Natural language → SQL binding"],
      "MCP integrations (Notion, Supabase)"
    ]},
    { "type": "two_column", "title": "Next quarter",
      "left":  {"kind": "bullets", "content": ["Webhook triggers","Skill library expansion","OAuth MCP"]},
      "right": {"kind": "bullets", "content": ["Production build","Install scripts","Documentation"]}
    },
    { "type": "section", "title": "3. GTM" },
    { "type": "comparison", "title": "Competitive landscape",
      "columns": [
        {"header": "Legacy SaaS", "points": ["Fixed schema", "Monthly subscription", "Vendor lock-in"]},
        {"header": "OpenHive",    "points": ["Runtime schema", "Open source", "Local data"]}
      ]
    },
    { "type": "steps", "title": "Roadmap", "steps": [
      {"title": "v0.1", "description": "Internal testing"},
      {"title": "v0.2", "description": "Early access"},
      {"title": "v1.0", "description": "Public launch"}
    ]},
    { "type": "quote", "quote": "Software moats eventually dissolve.", "attribution": "Internal memo" },
    { "type": "closing", "title": "Thank you", "subtitle": "Q&A" }
  ]
}
```

## Research brief with external images

```json
{
  "meta": { "theme": "minimal" },
  "slides": [
    { "type": "title", "title": "Semiconductor EUV process status" },
    { "type": "image",
      "title": "Inside an EUV lithography machine",
      "image": "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/ASML_logo.svg/1280px-ASML_logo.svg.png",
      "fit": "contain",
      "caption": "Based on ASML NXE:3400C"
    },
    { "type": "table",
      "title": "Major foundry comparison",
      "headers": ["Company", "EUV lines", "2nm mass production"],
      "rows": [
        ["TSMC",    "12", "2025 Q4"],
        ["Samsung", "8",  "2025 Q2"],
        ["Intel",   "5",  "2026"]
      ]
    }
  ]
}
```

## Adapting on the fly

Most mistakes when writing a spec:

1. **Mixing up `bullets` vs `steps`** — bullets is a flat/nested list; steps is 3-5 titled phases with a description each. If the user says "steps" or "phases", use steps.
2. **Using `table` for numeric trends** — use `chart` kind=line/column.
3. **Passing a path as `image` that doesn't exist** — the script downloads URLs but does not fetch remote SaaS-gated resources. Prefer direct image URLs or local paths the team already has.
4. **Forgetting `categories` length == each `series.values` length** — the validator catches this but the error is easy to miss.
