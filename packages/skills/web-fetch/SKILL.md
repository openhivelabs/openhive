---
name: web-fetch
description: Fetch ONE specific URL you ALREADY have and return clean markdown of its main content. Use AFTER `web-search` (which gives you real URLs). NEVER fetch search-engine result pages (duckduckgo.com, google.com/search, bing.com/search, etc.) — that is what `web-search` is for. NEVER guess domain names. If you don't have a URL and `web-search` isn't available, return control to your parent and ask for the skill, do not improvise.
triggers:
  keywords: [url, web, scrape, crawl, fetch, link, page, website]
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

Fetch a URL and hand the agent the **smallest possible useful text** — not raw HTML.

## DO NOT

- **Do NOT fetch search-engine result pages.** `https://duckduckgo.com/...`, `https://html.duckduckgo.com/...`, `https://www.google.com/search?...`, `https://www.bing.com/search?...`, `https://search.brave.com/...`, etc. all return JS-heavy markup with anti-scraping protections; you will get either a 202 challenge or a useless "enable JavaScript" page and you will burn your tool-round budget repeating the call. Use the `web-search` skill instead — that's what it exists for.
- **Do NOT guess URLs.** "It's probably at `apple.com/iphone-15-pro-specs`" → almost always wrong, almost always a 404, always wastes a round. Search first, fetch the real URL second.
- **Do NOT fetch the same URL repeatedly hoping for different content.** The cache + revalidation already handles "did this change?". If the page is JS-rendered (returns `warning: empty_content_likely_spa`), refetching won't fix it — escalate to your parent.
- **If `web-search` is not available to you and you don't have a URL,** stop. Return a structured note to your parent saying "I need web-search to research X; please grant the skill or pick a different agent." Do not improvise by fetching any homepage and hoping. Three ideas stacked for token efficiency:

1. **Main-content extraction** via `trafilatura` — strips nav, ads, cookie banners, footers, comment sections. Typical compression: original HTML → 10–20% in characters.
2. **Query-targeted chunking** — when the caller passes `query`, the page is split into paragraph-ish chunks, ranked with BM25, and only the top `top_k` are returned. Use this the moment you know what you're looking for on a page.
3. **Disk cache with revalidation** — every fetch stores `{body, etag, last_modified, fetched_at}` under `~/.openhive/cache/web/<sha1>/`. Subsequent fetches send `If-None-Match`/`If-Modified-Since`; 304 costs no bytes.

## Decision tree

```
What do you need?
│
├─ Skim the whole page (no query)
│   → url + max_chars. format=markdown (default). Lower max_chars if over token budget.
│
├─ Find a specific fact/answer on this page
│   → url + query="what to find". Use top_k to control chunk count.
│     Usually drops to 1/5-1/10 of full-page tokens.
│
├─ Need to parse HTML structure itself (tables, data scraping, etc.)
│   → format=raw. Expensive. Narrow with query first when possible.
│
└─ Likely revisiting a recently fetched URL
    → just call it. Cache automatically revalidates with ETag.
      Force a fresh fetch with no_cache=true.
```

## Output format

On success, one JSON line on stdout:

```json
{
  "ok": true,
  "url": "<final URL after redirects>",
  "status": 200,
  "from_cache": false,
  "title": "<document title, if any>",
  "content": "<extracted markdown/text>",
  "chars": 1834,
  "truncated": false,
  "chunks_returned": 4,      // only when query is set
  "total_chunks": 23,        // only when query is set
  "fetched_at": "2026-04-21T12:34:56Z"
}
```

On failure:

```json
{"ok": false, "error": "...", "status": 404}
```

## Limits & caveats

- **Static parsing only.** SPAs that need JS rendering may return empty content. Response JSON then includes `"warning": "empty_content_likely_spa"`. Playwright support is v2.
- **http(s) only.** file://, ftp://, etc. return 400.
- **Size limit.** Response body > 8 MB is rejected as `413`. Large files are not web-fetch's job.
- **Timeout.** Default 20s; unreachable targets fail.
- **robots.txt is not checked.** This runs in an agent user (= one human) context, treated like a browser. Not for crawler workloads.
- **Cache is 24h TTL.** After that, it revalidates automatically. Force bypass with `no_cache=true`.

## File layout

```
web-fetch/
├── scripts/
│   └── run.py         # entrypoint — reads stdin JSON, writes stdout JSON
├── lib/
│   ├── fetch.py       # httpx call + disk cache + ETag revalidation
│   ├── extract.py     # main-content extraction with trafilatura → markdown
│   └── rank.py        # BM25 chunk ranking (when query is set)
└── reference/
    └── examples.md    # call examples / token-savings comparison
```
