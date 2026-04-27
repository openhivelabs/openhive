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

## Investor report — cover, charts, KPI tiles, callouts

```json
{
  "meta": {"title": "Q1 report", "theme": "report",
           "theme_overrides": {"palette": [[13,90,99],[217,119,6],[22,163,74],[220,38,38],[109,40,217],[37,99,235]]}},
  "blocks": [
    {"type": "cover",
     "eyebrow": "Investor brief",
     "title": "Loomtide\nQ1 2026 분기 보고서",
     "subtitle": "ARR $3.4M 돌파 — 엔터프라이즈 전환 가속",
     "date": "2026-04-28", "author": "IR", "org": "Loomtide, Inc.",
     "band_eyebrow": "이번 분기 한 줄",
     "band_text": "NRR 112% 달성, 시리즈 B 클로징을 준비합니다."},

    {"type": "heading", "level": 1, "text": "1. Executive summary"},
    {"type": "kpi_row", "stats": [
      {"value": "$3.4M", "label": "ARR",            "delta": "+23%"},
      {"value": "112%",  "label": "NRR",            "delta": "+8pp"},
      {"value": "186",   "label": "Enterprise logo","delta": "+34"},
      {"value": "6.5",   "label": "CAC payback (mo)","delta": "-0.7"}
    ]},

    {"type": "callout", "variant": "success",
     "title": "Series B 트랙 진입",
     "text": "선두 VC 두 곳과 텀시트 단계. 클로징 목표는 2026 Q3."},

    {"type": "heading", "level": 1, "text": "2. Growth"},
    {"type": "chart", "variant": "line",
     "title": "ARR 추이",
     "x": ["Q1 25", "Q2 25", "Q3 25", "Q4 25", "Q1 26"],
     "series": [
       {"name": "ARR ($M)", "values": [1.4, 1.7, 2.1, 2.6, 3.4]}
     ],
     "width_in": 6.0, "height_in": 3.0
    },

    {"type": "chart", "variant": "donut",
     "title": "TAM 구성",
     "slices": [
       {"label": "Mid-market", "value": 28},
       {"label": "Enterprise", "value": 22},
       {"label": "SMB",        "value": 10}
     ],
     "width_in": 4.0, "height_in": 3.0},

    {"type": "table", "style": "zebra",
     "headers": ["항목", "Q1 26", "Q4 25", "YoY"],
     "rows": [
       ["Revenue", "820", "732", "+41%"],
       ["Gross Profit", "492", "436", "+34%"],
       ["EBITDA", "132", "124", "+6%"]
     ]},

    {"type": "callout", "variant": "warning",
     "title": "유의 사항",
     "text": "수치는 비공인 잠정치입니다."}
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

## Chart variants quick-reference

```json
[
  {"type": "chart", "variant": "bar", "x": ["A","B","C"],
   "series": [{"name":"x","values":[1,2,3]},{"name":"y","values":[2,1,4]}], "show_values": true},

  {"type": "chart", "variant": "stacked_bar", "x": ["Q1","Q2","Q3","Q4"],
   "series": [{"name":"new","values":[10,12,18,22]},{"name":"renewal","values":[40,45,48,52]}]},

  {"type": "chart", "variant": "hbar", "x": ["seoul","tokyo","osaka","busan","kyoto"],
   "series": [{"name":"users","values":[820,640,310,210,180]}], "show_values": true},

  {"type": "chart", "variant": "area", "x": ["1","2","3","4","5","6"],
   "series": [{"name":"north","values":[10,14,16,22,30,38]},
              {"name":"south","values":[8,9,12,18,22,26]}]},

  {"type": "chart", "variant": "scatter",
   "series": [{"name":"sample","x":[1,2,3,4,5,6,7],"values":[1,1.4,1.7,2.6,2.4,3.1,3.6]}]},

  {"type": "chart", "variant": "sparkline",
   "values": [3,4,6,5,8,12,11,14], "width_in": 2.0, "height_in": 0.5}
]
```
