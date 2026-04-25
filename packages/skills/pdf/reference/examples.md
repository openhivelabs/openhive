# pdf spec examples

## Mini — simple 4-block document

```json
{
  "meta": {"title": "Meeting Note", "theme": "minimal", "size": "A4"},
  "blocks": [
    {"type": "title", "text": "Weekly meeting"},
    {"type": "paragraph", "text": "2026-04-20 (Mon) 14:00. Attendees: Jane, Eric, Mira.",
     "align": "center"},
    {"type": "heading", "level": 2, "text": "Action Items"},
    {"type": "bullets", "items": ["A: MCP integration review", "B: Deployment script", "C: User interviews"]}
  ]
}
```

## Cover + report

```json
{
  "meta": {"title": "Q4 report", "author": "Research", "theme": "report"},
  "blocks": [
    {"type": "title", "text": "2026 Q4 report"},
    {"type": "spacer", "height": 30},
    {"type": "paragraph", "text": "OpenHive Research — April 20, 2026",
     "align": "center"},
    {"type": "page_break"},

    {"type": "heading", "level": 1, "text": "1. Summary"},
    {"type": "kpi_row", "stats": [
      {"value": "$2.1M", "label": "ARR", "delta": "+22%"},
      {"value": "312",   "label": "Customers", "delta": "+48"},
      {"value": "97%",   "label": "GRR"}
    ]},
    {"type": "paragraph", "text": "This quarter's key wins were shipping Frame export/import and early adoption of the AI dashboard builder.",
     "align": "justify"},

    {"type": "heading", "level": 1, "text": "2. Metrics"},
    {"type": "table",
     "headers": ["Metric", "Q3", "Q4", "Change"],
     "rows": [
       ["MAU", "12.4K", "31.2K", "+150%"],
       ["Teams", "421", "623", "+48%"]
     ],
     "style": "grid"
    },

    {"type": "heading", "level": 1, "text": "3. Next quarter"},
    {"type": "two_column",
     "left":  [{"type": "heading", "level": 2, "text": "Product"},
               {"type": "bullets", "items": ["Webhook", "Skill expansion", "OAuth MCP"]}],
     "right": [{"type": "heading", "level": 2, "text": "Operations"},
               {"type": "bullets", "items": ["Production build", "Install scripts"]}]},

    {"type": "horizontal_rule"},
    {"type": "quote",
     "text": "Software moats eventually dissolve.",
     "attribution": "Internal memo"}
  ]
}
```

## Page ops only — watermark + extraction

Watermark:
```json
{"operations": [
  {"op": "overlay_text", "text": "DRAFT", "size": 80,
   "color": [0.85, 0.1, 0.1], "rotation": 45,
   "opacity": 0.18, "x": 150, "y": 400}
]}
```

Extract only the first 3 pages:
```json
{"operations": [
  {"op": "extract_pages", "pages": [0, 1, 2]}
]}
```
