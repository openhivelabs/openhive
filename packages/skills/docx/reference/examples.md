# docx spec examples

## 최소 — 4블록 메모

```json
{
  "meta": {"title": "Meeting Note", "theme": "minimal"},
  "blocks": [
    {"type": "heading", "level": 1, "text": "주간 회의"},
    {"type": "paragraph", "text": "2026-04-20 (월) 14:00. 참석: Jane, Eric, Mira."},
    {"type": "heading", "level": 2, "text": "Action Items"},
    {"type": "bullets", "items": ["A: MCP 통합 리뷰", "B: 배포 스크립트 초안", "C: 유저 인터뷰 3건"]}
  ]
}
```

## 보고서 — 표 + KPI + 두 단 레이아웃

```json
{
  "meta": {"title": "Q4 보고서", "author": "Research", "theme": "report"},
  "blocks": [
    {"type": "heading", "level": 1, "text": "Q4 2026 분기 보고서"},
    {"type": "toc", "levels": 2},
    {"type": "page_break"},

    {"type": "heading", "level": 1, "text": "1. 요약"},
    {"type": "kpi_row", "stats": [
      {"value": "$2.1M", "label": "ARR", "delta": "+22%"},
      {"value": "312",   "label": "고객수", "delta": "+48"},
      {"value": "97%",   "label": "GRR", "delta": "+1pp"}
    ]},
    {"type": "paragraph", "text": "이번 분기 핵심 성과는 Frame export/import 출시와 AI 대시보드 빌더의 조기 채택입니다.", "align": "justify"},

    {"type": "heading", "level": 1, "text": "2. 제품"},
    {"type": "heading", "level": 2, "text": "출시 항목"},
    {"type": "bullets", "items": [
      "Frame export/import",
      ["템플릿 포맷 표준화", "CLI + UI 지원"],
      "AI 대시보드 빌더",
      "10+ 패널 템플릿"
    ]},

    {"type": "heading", "level": 2, "text": "지표 비교"},
    {"type": "table",
     "headers": ["지표", "Q3", "Q4", "변화"],
     "rows": [
       ["월 신규 사용자", "1,205", "1,840", "+53%"],
       ["활성 팀 수", "421", "623", "+48%"],
       ["일 평균 쿼리", "12.4K", "31.2K", "+150%"]
     ],
     "style": "grid"
    },

    {"type": "heading", "level": 1, "text": "3. 다음 분기"},
    {"type": "two_column",
     "left": [
       {"type": "heading", "level": 2, "text": "제품"},
       {"type": "bullets", "items": ["Webhook 트리거", "Skill 라이브러리 확장", "OAuth MCP"]}
     ],
     "right": [
       {"type": "heading", "level": 2, "text": "운영"},
       {"type": "bullets", "items": ["프로덕션 빌드", "설치 스크립트", "문서화"]}
     ]},

    {"type": "horizontal_rule"},
    {"type": "quote",
     "text": "소프트웨어의 해자는 결국 풀린다.",
     "attribution": "Internal memo"},
    {"type": "paragraph", "text": "문의: research@openhive.dev", "align": "center"}
  ]
}
```

## 코드 문서 — 설명 + 코드 샘플

```json
{
  "meta": {"title": "OPC 패키지 가이드", "theme": "formal"},
  "blocks": [
    {"type": "heading", "level": 1, "text": "OPC (Open Packaging Convention)"},
    {"type": "paragraph", "text": "pptx / docx / xlsx 파일은 ZIP 기반 OPC 패키지입니다."},
    {"type": "heading", "level": 2, "text": "파일 구조"},
    {"type": "code", "text": "myfile.docx (zip)\n├── [Content_Types].xml\n├── _rels/.rels\n├── word/document.xml\n└── word/_rels/document.xml.rels", "language": "text"},
    {"type": "heading", "level": 2, "text": "사용 예"},
    {"type": "code",
     "text": "from helpers.opc import Package\npkg = Package.open('doc.docx')\nmain = pkg.main_document()\nprint(len(main.blob))",
     "language": "python"}
  ]
}
```
