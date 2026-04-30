# OpenAI API key

Direct OpenAI Responses API access (`api.openai.com/v1/responses`) via
project API key. Distinct from the `codex` OAuth provider — Codex
talks to `chatgpt.com/backend-api` with the `attach_item_ids`
reasoning-anchor workaround; this adapter uses the canonical
`previous_response_id + store: true` chain.

## Connect

1. Create a project key at
   <https://platform.openai.com/api-keys> (format: `sk-proj-…` or
   classic `sk-…`).
2. Ensure the project has billing enabled and credit ≥ $5; new
   accounts are sometimes Tier 1 only and reject `gpt-5.5` until a
   threshold of usage clears.
3. Settings → Providers → OpenAI → **Connect** → paste key → Save.

## Models

| ID              | Input $/1M | Output $/1M | Cached In | Context | Max Out |
| --------------- | ---------: | ----------: | --------: | ------: | ------: |
| `gpt-5.5`       | 5.00       | 30.00       | 0.50      | 1.05M   | 130K    |
| `gpt-5.4`       | 2.50       | 15.00       | 0.25      | 1.05M   | 130K    |
| `gpt-5.4-mini`  | 0.75       | 4.50        | 0.075     | 400K    | 130K    |
| `gpt-5-mini`    | 0.25       | 2.00        | 0.025     | 400K    | 128K    |

Default: `gpt-5.5`. Cheap-model fallback (auto-title, summary,
result-cap): `gpt-5-mini`.

### Long-context surcharge

GPT-5.5 and GPT-5.4 charge **2× input / 1.5× output for the entire
call** when the input exceeds 272K tokens. `usage/pricing.ts` carries
this surcharge automatically (see `long_context_*` fields on
`ModelRates`). You can verify a usage row by checking
`fresh_input_cost_cents` against the formula `tokens × rate ×
(input>272k ? 2 : 1) / 1e6`.

## Caching

Server-side via `previous_response_id + store: true`. The adapter
keeps a per-`chainKey` map of `lastResponseId` and chains turns
automatically. On a 400 from the server (typically a 30-day TTL
expiry on a stale response id) the chain entry is dropped and the
next call starts fresh. `store: true` means responses are retained on
OpenAI's side for 30 days — reflect in your data-handling policy.

For prefix-based caching with no chain (cold sessions), OpenAI's
auto-cache fires on any stable 1024+ token prefix; usage rows show
`input_tokens_details.cached_tokens > 0` when this triggers.

## Native web search

`{ type: 'web_search' }` builtin attached when `nativeWebSearch: true`
(default ON). The engine gates the combination
`(provider='openai', model='gpt-5', effort='minimal')` to OFF —
verified rejection on the platform docs as of 2026-04. Other
combinations are accepted by all currently catalogued models.

Hosted searches bill at $25 per 1k searches, separate from the token
metering.

## Reasoning

`reasoning: { effort, summary }` + `include: ['reasoning.encrypted_content']`.
The encrypted content rides through the chain via `previous_response_id`,
so we don't need Codex's `attach_item_ids` work-around.

## Gotchas

- **Tier wall on `gpt-5.5`**: new projects sometimes return
  `insufficient_quota` even with billing enabled until a usage
  threshold is crossed. Use `gpt-5.4` to seed.
- **`store: true` retention**: server keeps full request/response
  envelopes for 30 days; surface this in your privacy notice if
  customer-data flows through.
- **Long-context surcharge** (above) applies to the full call, not
  just the >272k portion — bills can spike when the cache is cold.
