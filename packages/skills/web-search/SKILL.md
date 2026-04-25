---
name: web-search
description: FALLBACK web search via free SERP scraping. If your provider exposes a native server-side `web_search` tool (Codex / Claude do), PREFER THAT — it has no captcha, no IP-block risk, and integrates results into the assistant turn directly. Call this `web-search` skill only when (a) your provider has no native web_search (Copilot), or (b) the native one just errored / hit a rate limit. If this tool returns `ok:false` with `error_code:'search_rate_limited'` or `'search_unavailable'`, follow the `guidance` field — DO NOT continue research from training data alone. Use BEFORE `web-fetch` when you don't know the URL. Anchor year tokens to `# Today`, not your training cutoff. Yahoo primary backend, Mojeek + DuckDuckGo fallbacks; no API key; default 10 results.
triggers:
  keywords: [search, find, look up, look for, query, lookup]
runtime: python
entrypoint: scripts/run.py
parameters:
  type: object
  properties:
    query:
      type: string
      description: "Short keyword query, 4–8 words. Specific nouns + a year if recency matters. Do NOT stuff synonyms, quotes, OR operators, or site: filters — those make matching WORSE on DDG. Need a different angle? Make a SEPARATE web-search call. Good: 'Gemma 4 27B VRAM requirements 2025'. Bad: '\"Gemma 4\" 27B OR 26B \"VRAM\" site:ai.google.dev hardware specs 2026 official'. ALSO: do NOT hard-code product/model version numbers you 'remember' (e.g. 'Gemini 2.5 Pro') into a 'latest version' query — your memory is stale. First search the product family + 'latest' + the year from `# Today` with NO version number, read the actual results, then narrow."
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
Already know the exact URL?
├─ Yes → go straight to web-fetch
└─ No  → web-search here → skim results → web-fetch the best 2–3
         ├─ All results off-topic → reformulate (more specific nouns, add year) and search again
         └─ Too few results       → raise `count` or change `region`
```

## Query tips — short and clean

A good query is **4–8 words a human would actually type in the search box**. Do NOT cram synonym groups, quotes, `OR`, or `site:` into one query — DDG (and most engines) match stuffed queries WORSE, and the request looks more bot-like, raising the chance of a 202 anti-scraping block. Need a different angle? Make a **separate** `web-search` call instead of stuffing both into one.

**Good (Claude-style):**
- `Gemma 4 27B VRAM requirements 2025`
- `Anthropic Claude Opus 4.7 release date`
- `iPhone 15 Pro Max battery capacity mAh`
- `Tesla Model 3 2024 EPA range`

**Bad (stuffed):**
- `"Gemma 4" 27B OR 26B "VRAM" site:ai.google.dev hardware specs 2026 official` ← quotes + OR + site mixed
- `Anthropic Claude models list "Claude" model names site:anthropic.com OR "Anthropic" Claude models` ← synonym dump
- `"financials" "2023" "audit report" "official" company-name` ← quote bombing

**Principles:**
- **Specific nouns + numbers.** Keep model names, years, product codes; drop filler adverbs like "official" or "latest" — DDG already biases to fresh results. **Exception:** when you're asking *which* version is current, see the version-number rule below.
- **Don't anchor product version numbers to memory.** When the question is "what's the latest X", do NOT bake the last version you remember into the query — it's stale by definition. Search the product family name + the year from `# Today`, with NO version number (e.g. `Google Gemini latest model 2026`, not `Google Gemini 2.5 Pro 2026`). Read the SERP titles/snippets to learn the *actual* current version, then issue a follow-up query that narrows on that real version. Same rule for app releases, libraries, hardware revisions — any "latest version" question. Treat remembered version numbers as guesses to verify, never as facts to filter on.
- **Year only once.** No "2025 latest newest 2025"-style duplication.
- **One angle per query.** If you need two angles, make two calls. The 5-per-turn cap is plenty.
- **Match language to source.** Want Korean sources? Korean query + `region: 'kr-kr'`. Don't mix English and Korean tokens in one query.
- **`site:` solo.** `site:anthropic.com claude opus` is fine; `site:anthropic.com` plus a synonym dump breaks matching.

## Output format

On success, one JSON line on stdout:

```json
{
  "ok": true,
  "query": "…",
  "count_requested": 10,
  "count_returned": 10,
  "source": "yahoo",
  "results": [
    { "rank": 1, "title": "…", "url": "https://…", "domain": "example.com", "snippet": "…" }
  ]
}
```

On failure:

```json
{
  "ok": false,
  "error_code": "search_rate_limited",
  "error": "DuckDuckGo is rate-limiting our requests (HTTP 202 captcha). Search is TEMPORARILY unavailable.",
  "guidance": "Do NOT fabricate results from training data. Either (1) wait and retry web-search after 60s, (2) report 'web search currently unavailable' to your parent and let them decide, or (3) ask the user if they can supply specific URLs to web-fetch directly. Never invent URLs or release dates.",
  "status": 202
}
```

`error_code` is one of `search_rate_limited` (DDG 202 captcha) or `search_unavailable` (network/transport/5xx/unexpected). Always honor `guidance` — never fall back to training-data answers.

## Limits & caveats

- **Yahoo primary, Mojeek + DuckDuckGo fallbacks.** No API key, no billing. The chain runs Yahoo → Mojeek → DDG `lite` → DDG `/html/`, stopping on the first success. Yahoo is primary because (as of 2026-04-26) it serves SERP HTML to plain HTTP clients without a captcha gate from IPs that DDG (anomaly.js) and Mojeek (HTTP 403) actively block. Diversifying upstreams is cheap insurance against any one provider flipping the switch — when Yahoo eventually gates us too, the next backend in the chain takes over silently. The `source` field on success tells you which one answered.
- **Index coverage varies by backend.** Yahoo (Bing-backed) covers the major English-language web well, including breaking news. Mojeek and DDG have smaller, independent indexes that may miss long-tail or niche regional content. If a query returns `count_returned: 0`, reformulate (drop year, broaden nouns, change region) rather than assuming the topic doesn't exist.
- **Static HTML parsing.** No JS rendering. If Mojeek (or the DDG fallback) changes their markup the parser may briefly miss results — surfaced as `{ok: true, count_returned: 0, warning: "no results parsed — try a different query or region"}`.
- **Per-turn cap.** Engine caps `web-search` at **5 calls per turn** (`team.limits.max_web_search_per_turn`). On the 6th the skill returns `{ok: false, error: "cap reached"}` — stop looping and answer with what you have.
- **No cache.** Each call re-fetches; SERPs go stale faster than page bodies, so we don't cache them.
- **One query per call.** Need parallel angles? Call `web-search` multiple times (within the cap) instead of stuffing operators into one query.

## File layout

```
web-search/
├── scripts/
│   └── run.py         # entrypoint — reads stdin JSON, writes stdout JSON
└── lib/
    ├── __init__.py
    └── ddg.py         # DDG HTML parsing via httpx + stdlib html.parser
```
