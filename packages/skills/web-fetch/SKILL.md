---
name: web-fetch
description: Fetch a web page and return clean markdown of its main content. Strips nav/ads/scripts, caches with ETag, and (if a query is given) returns only the most relevant chunks via BM25 — designed for maximum signal per token. Use whenever an agent needs to read a URL.
triggers:
  keywords: [url, 웹, 크롤, 크롤링, 스크랩, scrape, crawl, fetch, 링크]
  patterns: ['https?://']
runtime: python
entrypoint: scripts/run.py
parameters:
  type: object
  properties:
    url:
      type: string
      description: "Absolute http(s) URL to fetch."
    query:
      type: string
      description: "Optional. If set, split the page into chunks and return only the top-ranked chunks (BM25) matching this query. Biggest token saver when you know what you're looking for."
    max_chars:
      type: integer
      description: "Hard cap on returned content characters. Default 8000. Content past the cap is replaced with '[… truncated N chars]'."
    top_k:
      type: integer
      description: "When query is set, how many top chunks to return. Default 6."
    format:
      type: string
      enum: [markdown, text, raw]
      description: "markdown (default) = cleaned main content as markdown. text = plain text. raw = raw HTML, no extraction (use only for parsing, very expensive)."
    no_cache:
      type: boolean
      description: "Skip the disk cache. Default false. The cache honors ETag / Last-Modified when revalidating."
  required: [url]
---

# web-fetch skill

Fetch a URL and hand the agent the **smallest possible useful text** — not raw HTML. Three ideas stacked for token efficiency:

1. **Main-content extraction** via `trafilatura` — strips nav, ads, cookie banners, footers, comment sections. Typical compression: original HTML → 10–20% in characters.
2. **Query-targeted chunking** — when the caller passes `query`, the page is split into paragraph-ish chunks, ranked with BM25, and only the top `top_k` are returned. Use this the moment you know what you're looking for on a page.
3. **Disk cache with revalidation** — every fetch stores `{body, etag, last_modified, fetched_at}` under `~/.openhive/cache/web/<sha1>/`. Subsequent fetches send `If-None-Match`/`If-Modified-Since`; 304 costs no bytes.

## Decision tree

```
무엇이 필요해?
│
├─ 페이지를 훑어보고 싶다 (검색어 없음)
│   → url + max_chars. format=markdown (default). 토큰 초과면 max_chars 낮추기.
│
├─ 이 페이지에서 특정 사실/답을 찾고 싶다
│   → url + query="무엇을 찾는지". top_k로 몇 chunk 받을지 조절.
│     전체 페이지 토큰의 1/5 ~ 1/10 수준으로 떨어짐.
│
├─ HTML 구조 자체를 파싱해야 함 (표, 데이터 스크래핑 등)
│   → format=raw. 비쌈. 가능하면 query 로 먼저 좁혀서 쓰기.
│
└─ 최근에 이미 받은 URL 다시 볼 것 같다
    → 그냥 호출해. 캐시가 자동으로 ETag 재검증.
      강제로 새로 받으려면 no_cache=true.
```

## 출력 형식

성공 시 stdout에 JSON 한 줄:

```json
{
  "ok": true,
  "url": "<최종 URL (리다이렉트 반영)>",
  "status": 200,
  "from_cache": false,
  "title": "<문서 제목 (있으면)>",
  "content": "<extracted markdown/text>",
  "chars": 1834,
  "truncated": false,
  "chunks_returned": 4,      // query 썼을 때만
  "total_chunks": 23,        // query 썼을 때만
  "fetched_at": "2026-04-21T12:34:56Z"
}
```

실패 시:

```json
{"ok": false, "error": "...", "status": 404}
```

## 경계·제약

- **정적 파싱만.** JS 렌더링 필요한 SPA는 본문 비어 올 수 있음. 그럴 때는 응답 JSON이 `"warning": "empty_content_likely_spa"` 를 달아 돌려줍니다. Playwright 지원은 v2.
- **http(s) 만.** file://, ftp:// 등은 400.
- **사이즈 제한.** 응답 본문 > 8 MB 면 `413` 취급하고 거부. 큰 파일은 web-fetch 의 몫이 아님.
- **타임아웃.** 기본 20초, 도달 불가하면 실패.
- **robots.txt 는 확인하지 않음.** 에이전트 사용자(= 사람 한 명) 컨텍스트라서 브라우저와 동급으로 취급. 크롤러용도 아님.
- **캐시는 24h TTL.** 이후는 자동으로 재검증. `no_cache=true` 로 강제 우회.

## 파일 구조

```
web-fetch/
├── scripts/
│   └── run.py         # 엔트리포인트 — stdin JSON 받아 stdout JSON 반환
├── lib/
│   ├── fetch.py       # httpx 호출 + 디스크 캐시 + ETag 재검증
│   ├── extract.py     # trafilatura 로 본문 추출 → markdown
│   └── rank.py        # BM25 청크 랭킹 (query 있을 때)
└── reference/
    └── examples.md    # 호출 예시 / 토큰 절약 비교
```
