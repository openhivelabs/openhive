# pdf spec examples

## 미니 — 4블록 간단 문서

```json
{
  "meta": {"title": "Meeting Note", "theme": "minimal", "size": "A4"},
  "blocks": [
    {"type": "title", "text": "주간 회의"},
    {"type": "paragraph", "text": "2026-04-20 (월) 14:00. 참석: Jane, Eric, Mira.",
     "align": "center"},
    {"type": "heading", "level": 2, "text": "Action Items"},
    {"type": "bullets", "items": ["A: MCP 통합 리뷰", "B: 배포 스크립트", "C: 유저 인터뷰"]}
  ]
}
```

## 커버 + 보고서

```json
{
  "meta": {"title": "Q4 보고서", "author": "Research", "theme": "report"},
  "blocks": [
    {"type": "title", "text": "2026 Q4 보고서"},
    {"type": "spacer", "height": 30},
    {"type": "paragraph", "text": "OpenHive Research — 2026년 4월 20일",
     "align": "center"},
    {"type": "page_break"},

    {"type": "heading", "level": 1, "text": "1. 요약"},
    {"type": "kpi_row", "stats": [
      {"value": "$2.1M", "label": "ARR", "delta": "+22%"},
      {"value": "312",   "label": "고객", "delta": "+48"},
      {"value": "97%",   "label": "GRR"}
    ]},
    {"type": "paragraph", "text": "이번 분기 핵심 성과는 Frame export/import 출시와 AI 대시보드 빌더의 조기 채택입니다.",
     "align": "justify"},

    {"type": "heading", "level": 1, "text": "2. 지표"},
    {"type": "table",
     "headers": ["지표", "Q3", "Q4", "변화"],
     "rows": [
       ["MAU", "12.4K", "31.2K", "+150%"],
       ["팀 수", "421", "623", "+48%"]
     ],
     "style": "grid"
    },

    {"type": "heading", "level": 1, "text": "3. 다음 분기"},
    {"type": "two_column",
     "left":  [{"type": "heading", "level": 2, "text": "제품"},
               {"type": "bullets", "items": ["Webhook", "Skill 확장", "OAuth MCP"]}],
     "right": [{"type": "heading", "level": 2, "text": "운영"},
               {"type": "bullets", "items": ["프로덕션 빌드", "설치 스크립트"]}]},

    {"type": "horizontal_rule"},
    {"type": "quote",
     "text": "소프트웨어의 해자는 결국 풀린다.",
     "attribution": "Internal memo"}
  ]
}
```

## 페이지 조작만 — 워터마크 + 추출

워터마크:
```json
{"operations": [
  {"op": "overlay_text", "text": "DRAFT", "size": 80,
   "color": [0.85, 0.1, 0.1], "rotation": 45,
   "opacity": 0.18, "x": 150, "y": 400}
]}
```

처음 3장만 뽑기:
```json
{"operations": [
  {"op": "extract_pages", "pages": [0, 1, 2]}
]}
```
