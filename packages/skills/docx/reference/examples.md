# docx spec examples

## Minimal — 4-block memo

```json
{
  "meta": {"title": "Meeting Note", "theme": "minimal"},
  "blocks": [
    {"type": "heading", "level": 1, "text": "Weekly meeting"},
    {"type": "paragraph", "text": "2026-04-20 (Mon) 14:00. Attendees: Jane, Eric, Mira."},
    {"type": "heading", "level": 2, "text": "Action Items"},
    {"type": "bullets", "items": ["A: MCP integration review", "B: Deployment script draft", "C: 3 user interviews"]}
  ]
}
```

## Report — table + KPI + two-column layout

```json
{
  "meta": {"title": "Q4 report", "author": "Research", "theme": "report"},
  "blocks": [
    {"type": "heading", "level": 1, "text": "Q4 2026 quarterly report"},
    {"type": "toc", "levels": 2},
    {"type": "page_break"},

    {"type": "heading", "level": 1, "text": "1. Summary"},
    {"type": "kpi_row", "stats": [
      {"value": "$2.1M", "label": "ARR", "delta": "+22%"},
      {"value": "312",   "label": "Customers", "delta": "+48"},
      {"value": "97%",   "label": "GRR", "delta": "+1pp"}
    ]},
    {"type": "paragraph", "text": "This quarter's key wins were shipping Frame export/import and early adoption of the AI dashboard builder.", "align": "justify"},

    {"type": "heading", "level": 1, "text": "2. Product"},
    {"type": "heading", "level": 2, "text": "Shipped"},
    {"type": "bullets", "items": [
      "Frame export/import",
      ["Template format standardization", "CLI + UI support"],
      "AI dashboard builder",
      "10+ panel templates"
    ]},

    {"type": "heading", "level": 2, "text": "Metric comparison"},
    {"type": "table",
     "headers": ["Metric", "Q3", "Q4", "Change"],
     "rows": [
       ["Monthly new users", "1,205", "1,840", "+53%"],
       ["Active teams", "421", "623", "+48%"],
       ["Daily avg queries", "12.4K", "31.2K", "+150%"]
     ],
     "style": "grid"
    },

    {"type": "heading", "level": 1, "text": "3. Next quarter"},
    {"type": "two_column",
     "left": [
       {"type": "heading", "level": 2, "text": "Product"},
       {"type": "bullets", "items": ["Webhook triggers", "Skill library expansion", "OAuth MCP"]}
     ],
     "right": [
       {"type": "heading", "level": 2, "text": "Operations"},
       {"type": "bullets", "items": ["Production build", "Install scripts", "Documentation"]}
     ]},

    {"type": "horizontal_rule"},
    {"type": "quote",
     "text": "Software moats eventually dissolve.",
     "attribution": "Internal memo"},
    {"type": "paragraph", "text": "Contact: research@openhive.dev", "align": "center"}
  ]
}
```

## Code document — explanation + code sample

```json
{
  "meta": {"title": "OPC package guide", "theme": "formal"},
  "blocks": [
    {"type": "heading", "level": 1, "text": "OPC (Open Packaging Convention)"},
    {"type": "paragraph", "text": "pptx / docx / xlsx files are ZIP-backed OPC packages."},
    {"type": "heading", "level": 2, "text": "File layout"},
    {"type": "code", "text": "myfile.docx (zip)\n├── [Content_Types].xml\n├── _rels/.rels\n├── word/document.xml\n└── word/_rels/document.xml.rels", "language": "text"},
    {"type": "heading", "level": 2, "text": "Usage example"},
    {"type": "code",
     "text": "from helpers.opc import Package\npkg = Package.open('doc.docx')\nmain = pkg.main_document()\nprint(len(main.blob))",
     "language": "python"}
  ]
}
```
