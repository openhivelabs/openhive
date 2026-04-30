# Changelog

All notable changes to OpenHive land here. Versioning is loosely SemVer
on the public package (`apps/web`); minor bumps add provider/feature
parity, patches are bug fixes.

## [Unreleased] — Phase A–E: API-key providers

Adds direct API-key access for four providers alongside the existing
OAuth-only Claude Code / Codex / Copilot. Live testing deferred to
the user side; codepaths and unit + dispatch tests pass.

### Added — Providers
- **Anthropic API key** (`provider_id: 'anthropic'`) — direct
  Messages API via `x-api-key`. Reuses 100% of the `claude-code`
  caching strategy, fork pattern (gate widened in `engine/fork.ts`),
  and reasoning betas. New beta-header constant
  `ANTHROPIC_BETA_APIKEY` strips OAuth-only flags. Optional 1h cache
  TTL via `OPENHIVE_ANTHROPIC_CACHE_TTL=1h` or per-call
  `cacheTtl: '1h'`.
- **OpenAI API key** (`provider_id: 'openai'`) — direct
  `api.openai.com/v1/responses`. Uses canonical
  `previous_response_id + store: true` chain (per-`chainKey` map);
  no `attach_item_ids` workaround needed. 30-day TTL on chains, with
  automatic invalidation on 400.
- **Google Gemini API key** (`provider_id: 'gemini'`) —
  `generativelanguage.googleapis.com` via `x-goog-api-key`.
  Catalogue carries Gemini 3.x preview models only
  (`-preview` suffix verified 2026-04-30). Thought Signatures
  capture/echo for cross-turn reasoning continuity per `chainKey`.
  `googleSearch` builtin with synthesised final-only lifecycle.
- **Vertex AI** (`provider_id: 'vertex-ai'`) — Google Cloud Vertex
  AI Generative endpoint. Service-account JSON → JWT(RS256) →
  OAuth access token, all via `node:crypto` (zero external deps).
  Default region `global` (Gemini 3 preview models are not
  provisioned elsewhere yet). Per-process semaphore default 6
  concurrent calls (env-tunable).

### Added — Infrastructure
- `providers/errors.ts` — `ProviderError` class +
  `redactCredentials` (5 key patterns: `sk-ant-…`, `sk-proj-…`,
  `sk-…`, `AIza…`, `ya29.…`, plus PEM private key + auth header
  lines). Wired into every adapter's HTTP error throws.
- `providers/retry.ts` — generic `retryWithBackoff` with optional
  `Retry-After` honor. `claude.ts` migrated off its inline retry
  loop.
- `providers/cheap-model.ts` — `pickCheapModel(connected[])`
  walks a 7-provider preference order (codex → claude-code →
  copilot → anthropic → openai → gemini → vertex-ai) and returns
  the cheapest model on the first connected provider. Used by
  `sessions/title.ts` (auto-title) and
  `engine/result-cap.ts:pickSummaryModel` (delegation result
  summarisation).
- `providers/openai-response-shared.ts` — extracted SSE → StreamDelta
  normaliser shared between Codex and OpenAI api_key adapters
  (Phase B refactor; `engine/providers.ts:streamCodex` shrunk from
  ~250 LOC to a 19-line wrapper). Also exports
  `toResponsesInput` / `toolsToResponses` / `sseEvents` /
  `ResponseInputItem` so both adapters share the wire helpers.
- `providers/gemini-shared.ts` — Gemini wire builders
  (`toGeminiContents`, `toolsToGemini`, `thinkingConfigFor`,
  `DEFAULT_SAFETY_SETTINGS`), SSE parser (`sseEventsGemini`),
  normaliser (`normalizeGeminiStream`), and per-`chainKey`
  Thought Signatures chain state. Reused 100% by Vertex.
- `providers/semaphore.ts` — tiny FIFO semaphore for
  Vertex concurrency cap.
- `auth/vertex.ts` — service-account → JWT(RS256) → access token,
  cached per provider id with 60s refresh skew.
- `providers/cache-control.ts` — unified `clearProviderCache`
  hook called from the disconnect endpoint so re-connecting with
  a different credential doesn't get shadowed by a stale
  in-memory token.

### Added — Engine / observability
- `supportsNativeSearch(provider, model, effort?)` gate in
  `engine/providers.ts` — returns `false` for the verified
  rejection combo `(openai|codex, gpt-5, effort='minimal')`.
- `webSearchSkill` / `webSearchNative` counters split in
  `engine/session.ts:RunState`. Skill is enforced
  (`max_web_search_per_turn`); native is observability-only.
- `AgentSpec.native_search` + NodeEditor "Web search" toggle —
  per-agent opt-out for compliance / determinism / airgapped runs.
- `engine/errors.ts:classify()` extended to recognise the new
  adapter error formats (OpenAI / Gemini / Vertex / token-exchange
  failures, plus `insufficient_quota` / `credit balance` markers).

### Added — UI
- ProvidersSection: existing api_key form rendered automatically
  for all four new providers (PROVIDERS array entries
  pre-existing). Vertex AI gets a **two-field form**: textarea
  for service-account JSON content (NOT a path), input + datalist
  for region (default `global`).
- Region datalist covers 11 GCP regions.
- `OPENHIVE_PROVIDER_<UPPER>=0` env hides a provider from the UI
  list (defaults shown for everyone). Already-connected
  providers always stay visible so users can disconnect.

### Changed
- `engine/providers.ts:streamCodex` reduced to a 19-line wrapper
  over `normalizeResponsesStream` (Phase B refactor; behaviour is
  byte-identical to the previous inline implementation).
- `usage/contextWindow.ts` — added `anthropic`, `openai`,
  `gemini`, `vertex-ai` blocks. The retired Anthropic 1M-context
  variants (`claude-opus-4-7[1m]`) removed (beta retired
  2026-04-30).
- `usage/pricing.ts:ModelRates` extended with `long_context_*`
  fields. `gpt-5.5` and `gpt-5.4` carry the >272k 2× input /
  1.5× output bracket. `computeCost` applies the surcharge
  automatically when total input crosses the threshold.
- `providers/models.ts` — Gemini and Vertex catalogues now use
  the on-the-wire `-preview` suffix for the three Gemini 3
  preview models.
- `agent-frames.ts` / `frames.ts` — `defaultModelFor` extended to
  cover all six new branches.
- `auth/providers.ts` — anthropic / openai / gemini / vertex-ai
  entries already present from prior groundwork; no schema
  change needed.

### Deferred (out of scope for this release)
- **Phase F**: Gemini / Vertex explicit `cachedContents` REST
  resource. Implicit auto-cache works today.
- **Phase G**: multi-modal input (image / audio / video). Engine
  history is text-only.
- Test coverage for the new adapters beyond the dispatch matrix
  (per user request).

### Migration notes
- Users disconnecting and re-connecting an OAuth provider with a
  different credential: the in-memory auth cache is now flushed
  on disconnect (was previously stale for ~60s).
- Anthropic users on the OAuth (`claude-code`) path see no
  behaviour change; the api_key path is opt-in via Settings.
- The 1M-context Anthropic beta is gone; anyone whose team
  config pinned `claude-opus-4-7[1m]` will fall back to
  `SAFE_DEFAULT` (128K) sizing math — update the team's model id
  to `claude-opus-4-7` to recover the proper 200K window.
