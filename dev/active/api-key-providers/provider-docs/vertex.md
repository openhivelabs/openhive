# Google Vertex AI

Same wire as Gemini api_key (`gemini-shared.ts` reused 100%) but with
Google Cloud auth: a **service-account JSON** is exchanged for a
1-hour OAuth access token via JWT(RS256). No external library — the
adapter signs the JWT with `node:crypto.createSign('RSA-SHA256')`.

## Connect

1. Enable the Vertex AI API on a GCP project.
2. Create a Service Account with role **Vertex AI User**:
   <https://console.cloud.google.com/iam-admin/serviceaccounts>
3. Add a key (JSON, not P12); download the JSON file.
4. Settings → Providers → Vertex AI → **Connect**:
   - **Service account JSON**: paste the JSON contents (NOT a file
     path — paste the actual key contents into the textarea).
   - **Region**: defaults to `global`. Use a specific region only if
     a data-residency policy requires it.
5. Save.

The JSON is encrypted at rest under the same Fernet vault as other
provider tokens. Project id is parsed automatically from the JSON.

## Region default

**`global`** — Gemini 3.x preview models (the only catalogued ones)
are NOT provisioned in `us-central1` / `us-west4` / others as of
2026-04-30 (probe-verified). The UI defaults the region field to
`global` and shows a warning hint about Gemini 3 availability.

To override per-deployment, set `VERTEX_LOCATION=us-east1` in env;
or store the override in the credential's `account_label` via the
UI's Region field.

## Models

Identical to Gemini api_key:

| ID                              | Label                  |
| ------------------------------- | ---------------------- |
| `gemini-3.1-pro-preview`        | Gemini 3.1 Pro         |
| `gemini-3-flash-preview`        | Gemini 3.0 Flash       |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite  |

## Concurrency cap

Vertex region quotas are tight enough (often 5-10 RPS for preview
models) that an unconstrained `delegate_parallel` fan-out trips 429
immediately. The adapter holds an in-process semaphore at **6**
concurrent calls by default; override via:

```bash
OPENHIVE_VERTEX_CONCURRENCY=10
```

Calls beyond the cap queue client-side rather than firing into a
429 wall. Inspection: `vertexConcurrencyStats()` returns
`{ inflight, queued, max }`.

## Native search / Reasoning / Caching

All identical to Gemini api_key — the wire shape is the same and the
shared `gemini-shared.ts` carries the logic. See `docs/providers/gemini.md`
for thoughtSignature round-trip, googleSearch lifecycle synthesis, and
implicit cache notes. Phase F (explicit `cachedContents`) will use
the Vertex-specific endpoint
`/vertex_ai/v1/projects/{p}/locations/{r}/cachedContents`
(distinct from Gemini's `/v1beta/cachedContents`).

## Token lifecycle

JWT(RS256) → `oauth2.googleapis.com/token` exchange → 1h access
token, cached in-process per provider id. Refresh fires
automatically when within 60s of expiry. On disconnect the cache is
flushed (see `auth/vertex.ts:clearVertexAuth`).

## Gotchas

- **Service-account JSON, not a path**: paste the JSON contents into
  the textarea. The adapter parses on first use.
- **`global` only for Gemini 3 preview**: pinning a real region will
  return 404 today.
- **Per-region quotas**: tighter than the Gemini AI Studio rate
  limits — keep concurrency cap in mind for parallel delegation.
- **No `google-auth-library` dependency**: JWT signing uses
  `node:crypto`; the entire auth stack is ~140 LOC in
  `lib/server/auth/vertex.ts`.
