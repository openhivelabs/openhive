# Anthropic API key

Direct Anthropic Messages API access via API key. Same wire as the
`claude-code` OAuth provider — the only differences are the auth header
(`x-api-key`) and a leaner beta header list (no `claude-code-*` /
`oauth-*` flags).

## Connect

1. Generate a key at <https://console.anthropic.com/settings/keys>
   (format: `sk-ant-api03-…`). Project key with `messages` scope is fine.
2. Settings → Providers → Anthropic → **Connect** → paste the key →
   Save.

The key is encrypted at rest (Fernet, shared with the Python toolchain)
under `~/.openhive/oauth.enc.json`.

## Models

| ID                  | Label        | Context | Default |
| ------------------- | ------------ | ------- | :-----: |
| `claude-opus-4-7`   | Opus 4.7     | 200K    | ✅       |
| `claude-sonnet-4-6` | Sonnet 4.6   | 200K    |         |
| `claude-haiku-4-5`  | Haiku 4.5    | 200K    |         |

The 1M-context beta variants (`claude-opus-4-7[1m]` etc.) were retired
on 2026-04-30 and are no longer carried in the catalogue.

## Caching

Three ephemeral `cache_control` breakpoints — system block, last tool,
last conversation block. The default TTL is 5 minutes (Anthropic
quietly dropped the prior 1h default on 2026-03-06). For long-idle
agents, opt into the 1h variant:

```bash
# Operator-wide flip:
OPENHIVE_ANTHROPIC_CACHE_TTL=1h
```

Or per-call from the `claude.streamMessages` opts (`cacheTtl: '1h'`).
The 1h breakpoint costs 2× on writes vs 1.25× for 5m, so it only pays
back when the cache is actually re-used after the 5m mark.

## Native web search

`web_search_20250305` builtin is enabled when `nativeWebSearch: true`
(default ON in the engine). Anthropic enforces a per-account quota and
the engine caps `max_uses=5` per turn. Disable per-agent via the
NodeEditor "Web search" toggle for compliance / determinism runs — the
function-tool `web-search` skill remains available unless removed from
the agent's `skills`.

## Fork (delegate_parallel)

Anthropic api_key participates in the prompt-cache-preserving fork
pattern alongside `claude-code` (gate widened in `engine/fork.ts`).
Cross-provider forks (claude-code parent → anthropic child or vice
versa) are blocked by the workspace-isolation gate — Anthropic's
prompt cache is now keyed per workspace (since 2026-02-05).

## Pricing notes

Pricing tracks the published rate card in `usage/pricing.ts`:
- Opus: $5 / $25 / 1M (in / out), cache read $0.50, cache write $6.25
- Sonnet: $3 / $15 / 1M, cache read $0.30, cache write $3.75
- Haiku: $1 / $5 / 1M, cache read $0.10, cache write $1.25

Reasoning tokens roll into `output_tokens` on the wire.

## Gotchas

- **Beta header divergence**: The api_key path strips OAuth-only flags
  (`claude-code-20250219`, `oauth-2025-04-20`, `fast-mode-2026-02-01`)
  and never sends the retired `context-1m-2025-08-07`. Adding either
  back will 4xx; see `providers/claude.ts:ANTHROPIC_BETA_APIKEY`.
- **Workspace cache isolation**: same prompt prefix cached on the
  OAuth path is NOT served to the api_key path. Each is its own
  workspace from Anthropic's POV.
