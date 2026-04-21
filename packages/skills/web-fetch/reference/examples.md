# web-fetch 호출 예시

## 1. 페이지 전체 훑어보기

```json
{"url": "https://example.com/blog/post-1"}
```

기본 `max_chars=8000`, markdown 추출. 넘치면 truncated=true.

## 2. 특정 질문에 대한 답만 뽑기 (토큰 절약 max)

```json
{
  "url": "https://docs.python.org/3/library/asyncio.html",
  "query": "asyncio.gather vs asyncio.TaskGroup",
  "top_k": 4
}
```

→ 보통 전체 페이지 토큰의 1/8–1/15 수준으로 떨어짐. 답이 특정 섹션에 몰려
있을 때 특히 효과적.

## 3. 원시 HTML (드문 케이스)

```json
{"url": "https://example.com", "format": "raw", "max_chars": 20000}
```

테이블 파싱 등 구조가 필요할 때만. 비용 큼.

## 4. 같은 URL 반복 조회

캐시 히트면 `from_cache: true`, 네트워크 비용 0. TTL(24h) 지나면 자동으로
`If-None-Match` 재검증 — 변경 없으면 304, 여전히 네트워크 최소.

## 토큰 비교 (대략적 실측)

| 모드 | 평균 chars | 용도 |
|---|---|---|
| `format=raw` | 80,000–300,000 | HTML 파싱 |
| `format=markdown` (기본) | 4,000–15,000 | 페이지 내용 전체 |
| `format=markdown` + `query` | 800–3,000 | 특정 질문 답 |

## 실패 처리

- `{"ok": false, "error": "HTTP 404", "status": 404}`  — 페이지 없음
- `{"ok": false, "error": "body too large (…)", "status": 413}` — 8MB 초과
- 성공했는데 `content: ""` + `warning: "empty_content_likely_spa"` — JS 렌더링
  페이지. 에이전트는 "본문을 못 읽음" 으로 처리하고 다른 소스 시도할 것.
