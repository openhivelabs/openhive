# Canonical specs per slide type

Minimal but realistic examples. Copy, adapt, combine.

## 3-slide intro deck

```json
{
  "meta": { "theme": "default", "size": "16:9" },
  "slides": [
    { "type": "title", "title": "Project Kickoff", "subtitle": "Sales automation Q2", "author": "Jane" },
    { "type": "bullets", "title": "Agenda", "bullets": [
      "오늘의 목표", "팀 소개", "첫 주 계획"
    ]},
    { "type": "closing", "title": "질문?" }
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
    { "type": "kpi", "title": "이번 분기", "stats": [
      {"value": "$2.1M", "label": "ARR", "delta": "+22%"},
      {"value": "312",   "label": "customers", "delta": "+48"},
      {"value": "97%",   "label": "GRR", "delta": "+1pp"}
    ]},
    { "type": "chart", "title": "월별 ARR", "kind": "line",
      "categories": ["Jan","Feb","Mar"],
      "series": [{"name":"ARR","values":[1.6,1.85,2.1]}]
    },
    { "type": "section", "title": "2. Product" },
    { "type": "bullets", "title": "이번 분기 출시", "bullets": [
      "Frame export/import",
      "AI 대시보드 빌더",
      ["10+ 패널 템플릿", "자연어 → SQL 바인딩"],
      "MCP 통합 (Notion, Supabase)"
    ]},
    { "type": "two_column", "title": "다음 분기",
      "left":  {"kind": "bullets", "content": ["Webhook 트리거","Skill 라이브러리 확장","OAuth MCP"]},
      "right": {"kind": "bullets", "content": ["프로덕션 빌드","설치 스크립트","문서화"]}
    },
    { "type": "section", "title": "3. GTM" },
    { "type": "comparison", "title": "경쟁 환경",
      "columns": [
        {"header": "Legacy SaaS", "points": ["고정 스키마", "월 구독", "벤더 락인"]},
        {"header": "OpenHive",    "points": ["런타임 스키마", "오픈소스", "로컬 데이터"]}
      ]
    },
    { "type": "steps", "title": "로드맵", "steps": [
      {"title": "v0.1", "description": "내부 테스트"},
      {"title": "v0.2", "description": "얼리 액세스"},
      {"title": "v1.0", "description": "공개 런칭"}
    ]},
    { "type": "quote", "quote": "소프트웨어의 해자는 결국 풀린다.", "attribution": "Internal memo" },
    { "type": "closing", "title": "Thank you", "subtitle": "Q&A" }
  ]
}
```

## Research brief with external images

```json
{
  "meta": { "theme": "minimal" },
  "slides": [
    { "type": "title", "title": "반도체 EUV 공정 현황" },
    { "type": "image",
      "title": "EUV 노광기 내부",
      "image": "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/ASML_logo.svg/1280px-ASML_logo.svg.png",
      "fit": "contain",
      "caption": "ASML NXE:3400C 기준"
    },
    { "type": "table",
      "title": "주요 파운드리 비교",
      "headers": ["업체", "EUV 라인", "2nm 양산"],
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

1. **Mixing up `bullets` vs `steps`** — bullets is a flat/nested list; steps is 3–5 titled phases with a description each. If the user says "단계" or "phases", use steps.
2. **Using `table` for numeric trends** — use `chart` kind=line/column.
3. **Passing a path as `image` that doesn't exist** — the script downloads URLs but does not fetch remote SaaS-gated resources. Prefer direct image URLs or local paths the team already has.
4. **Forgetting `categories` length == each `series.values` length** — the validator catches this but the error is easy to miss.
