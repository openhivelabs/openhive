# web-fetch call examples

## 1. Skim the whole page

```json
{"url": "https://example.com/blog/post-1"}
```

Default `max_chars=8000`, markdown extraction. If over the cap, truncated=true.

## 2. Extract only the answer to a specific question (max token savings)

```json
{
  "url": "https://docs.python.org/3/library/asyncio.html",
  "query": "asyncio.gather vs asyncio.TaskGroup",
  "top_k": 4
}
```

→ Usually drops to 1/8-1/15 of full-page tokens. Especially effective when the answer is concentrated in one section.

## 3. Raw HTML (rare case)

```json
{"url": "https://example.com", "format": "raw", "max_chars": 20000}
```

Use only when structure is needed, such as table parsing. Expensive.

## 4. Repeated fetches of the same URL

On cache hit, `from_cache: true`, zero network cost. After TTL (24h), automatically revalidates with `If-None-Match` — if unchanged, 304 and still minimal network.

## Token comparison (rough measured values)

| Mode | Avg chars | Purpose |
|---|---|---|
| `format=raw` | 80,000-300,000 | HTML parsing |
| `format=markdown` (default) | 4,000-15,000 | Whole page content |
| `format=markdown` + `query` | 800-3,000 | Specific-question answer |

## Failure handling

- `{"ok": false, "error": "HTTP 404", "status": 404}`  — page missing
- `{"ok": false, "error": "body too large (…)", "status": 413}` — over 8MB
- Success with `content: ""` + `warning: "empty_content_likely_spa"` — JS-rendered page. Agent should treat it as "body unreadable" and try another source.
