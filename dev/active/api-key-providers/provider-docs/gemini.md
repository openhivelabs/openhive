# Google Gemini API key

Direct Gemini API access (`generativelanguage.googleapis.com`) via
Google AI Studio API key.

## Connect

1. Create a key at <https://aistudio.google.com/apikey> (format:
   `AIza…`). Free tier covers light Gemini 3 usage.
2. Settings → Providers → Gemini → **Connect** → paste key → Save.

The key is sent in the `x-goog-api-key` header (never in the URL
query) so it doesn't leak through proxy access logs.

## Models

All catalogued models are Gemini 3.x preview (verified
2026-04-30 against the `/v1beta/models` listing):

| ID                              | Label                  | Default |
| ------------------------------- | ---------------------- | :-----: |
| `gemini-3.1-pro-preview`        | Gemini 3.1 Pro         | ✅       |
| `gemini-3-flash-preview`        | Gemini 3.0 Flash       |         |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite  |         |

Cheap-model fallback: `gemini-3-flash-preview`.

Gemini 2.5 (`gemini-2.5-pro` / `gemini-2.5-flash`) is **not** in the
catalogue — those models are deprecated 2026-06-17 and we drop them
ahead of retirement to avoid silent fail.

## Reasoning + Thought Signatures

Gemini 3.x uses `thinkingLevel` (`'low' | 'medium' | 'high'`) on the
`generationConfig.thinkingConfig` object. The legacy `thinkingBudget`
(integer) is preserved in the helper for any user-supplied
non-preview Gemini 2.5 model id, but the catalogue itself is 3.x
only.

**Thought Signatures** are opaque base64 reasoning anchors emitted
by the model on `parts[i].thoughtSignature`. The adapter captures
the full assistant `parts[]` array per turn into a per-`chainKey`
chain state map, then re-emits those parts verbatim on the next
request. This preserves cross-turn reasoning continuity for
`delegate_to` chains.

Limitation: history compaction (microcompact / summarise) renumbers
assistant turn ordinals and detaches captured signatures. The model
recovers by re-reasoning from scratch — quality dips, no crash.

## Native web search

`tools: [{ googleSearch: {} }]` enabled when `nativeWebSearch: true`.

Lifecycle synthesis: Gemini does NOT emit per-phase SSE events for
search (no equivalent of Codex's `response.web_search_call.searching`).
The first signal we see is `groundingMetadata` arriving alongside the
final candidate. The adapter therefore emits ONE `native_tool` delta
with `phase: 'completed'` and the full sources list when grounding
is observed; the UI shows a sources card at end-of-turn rather than
a lifecycle chip.

Search billing is $14 per 1k queries (Apr 2026 rate) — separate
from token metering.

## Caching

Implicit only for v1. Gemini's `cachedContents` REST resource
requires a 4096-32768 token minimum prefix and is gated by ROI
measurement; deferred to Phase F. When the same prefix repeats,
`usageMetadata.cachedContentTokenCount` will reflect server-side
auto-caching.

## Safety settings

`safetySettings: [{ category, threshold: 'BLOCK_ONLY_HIGH' }]` is
applied to all 4 categories by default. Without this, code-assistant
workloads hit `finishReason: SAFETY` on borderline content too often
(e.g. SQL with the word "drop", security-research prompts).

## Gotchas

- **Geo restriction**: Gemini api_key is sometimes blocked from KR
  IPs without explanation. The error surfaces as a 403 with a region
  hint — the engine's `provider_auth` classifier picks it up. Fall
  back to Vertex AI from the same project for resilience.
- **`thoughtSignature` + history compaction**: see Limitation above.
- **`gemini-2.5-*`**: NOT supported. Use 3.x only.
