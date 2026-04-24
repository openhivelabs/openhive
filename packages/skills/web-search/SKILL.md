---
name: web-search
description: Search the web and return a ranked list of candidate URLs with titles and snippets. Use this BEFORE `web-fetch` when you don't already know the right URL — never guess domain names, just search. Free (no API key), powered by DuckDuckGo's static HTML endpoint. Default 10 results per call; prefer fewer searches + reformulated queries over many broad ones.
triggers:
  keywords: [검색, 찾아, search, find, look up, 조회, 알려줘]
runtime: python
entrypoint: scripts/run.py
parameters:
  type: object
  properties:
    query:
      type: string
      description: "Single natural-language query. Use specific nouns + year where relevant (e.g. 'Galaxy Buds3 Pro 2025 공식 스펙' beats 'buds pro')."
    count:
      type: integer
      description: "How many results to return. Default 10, max 20. Keep at 10 unless you have a reason — more ≠ better when the top 3 are usually the answer."
    region:
      type: string
      description: "DuckDuckGo region/locale code. Default 'wt-wt' (global). Use 'kr-kr' for Korea-biased results, 'us-en' for US English, etc."
  required: [query]
---

# web-search skill

Return the SERP (title + url + snippet + domain) for a single query — the cheapest step in any research workflow.

## Why this exists

Before this skill, the LLM had to guess URLs and try `web-fetch` against them, burning rounds on 404s. Search is much cheaper (tokens-per-dollar): a SERP is ~1k tokens of titles+snippets; a single web-fetch is ~2-10k tokens of page body. Always cheaper to search first, then fetch the 2-3 best matches.

## Decision tree

```
필요한 URL 을 이미 알고 있음?
├─ 예 → web-fetch 로 바로 가져오기
└─ 아니오 → 여기서 web-search → 결과 훑고 좋은 2~3개만 web-fetch
            ├─ 결과가 다 엉뚱 → 쿼리 재작성 (예: 더 구체적인 명사, 연도 추가) 후 재검색
            └─ 결과 부족 → count 올리거나 region 바꿔보기
```

## 쿼리 팁

- **구체적으로.** "iPhone 15 공식 가격" > "아이폰 가격".
- **연도 명시.** 최신 정보가 필요하면 쿼리에 "2025" / "최신" 포함.
- **언어 선택.** 한국어 소스 원하면 한국어 쿼리 + `region: 'kr-kr'`.
- **사이트 제한.** 필요시 `site:brand.com keyword` (DuckDuckGo 지원).

## 출력 형식

성공 시 stdout에 JSON 한 줄:

```json
{
  "ok": true,
  "query": "…",
  "count_requested": 10,
  "count_returned": 10,
  "source": "duckduckgo-html",
  "results": [
    { "rank": 1, "title": "…", "url": "https://…", "domain": "example.com", "snippet": "…" }
  ]
}
```

실패 시:

```json
{ "ok": false, "error": "…", "status": 429 }
```

## 경계·제약

- **DuckDuckGo HTML endpoint.** API key 불필요, 과금 없음. 무료 대가로 공격적인 사용 시 레이트 리밋 걸릴 수 있음.
- **정적 HTML 파싱.** JS 렌더링 안 함. DDG 측 마크업이 바뀌면 일시 고장 가능 — 감지되면 `ok: false, error: "no results parsed"` 로 반환.
- **엔진 캡.** 세션당 **5회/턴** (`team.limits.max_web_search_per_turn`). 초과 시 `{ok: false, error: "cap reached"}` — 그만 루프 돌고 가진 결과로 답하라는 신호.
- **캐시 없음.** 검색 결과는 fetch 결과보다 훨씬 빨리 상함. 재호출 시 매번 새로 받음.
- **한 쿼리 = 한 SERP.** 여러 키워드 병렬 필요하면 `web-search` 를 여러 번 호출 (캡 범위 내).

## 파일 구조

```
web-search/
├── scripts/
│   └── run.py         # 엔트리 — stdin JSON 받아 stdout JSON 반환
└── lib/
    ├── __init__.py
    └── ddg.py         # httpx + selectolax 로 DDG HTML 파싱
```
