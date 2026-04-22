# A3 — Artifact Rehydration (microcompact 후 on-demand 재접근)

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4.5 우선.**
> 1. **본 라운드 = Phase 1 + Phase 2 + Phase 4(테스트) 만.** Phase 3 (`recentArtifactRefs` LRU) 는 후속 auto-compact 와 묶음 — 코드 작성 안 함, RunState 필드 추가 안 함, dead code 회피.
> 2. **`enqueueEvent` 호출 시그니처 정정 (plan §4.3).** `enqueueEvent(sessionId, JSON.stringify(makeEvent(...)) + '\n')` 패턴. spec §Task 1.6 의 `enqueueEvent(makeEvent(...))` 는 오류, 본 SSoT 따를 것.
> 3. **`registerSkillArtifacts` 출력에 `uri` 필드 추가 (Option A 확정).** `session.ts:2127-2132` 의 out.push 결과에 `uri: buildArtifactUri(ctx.sessionId, f.path)` 한 줄 추가.
> 4. **S2 의 `COMPACTABLE_BUILTIN` set 에 `'read_artifact'` 추가** 를 본 PR 에서 처리 (S2 가 먼저 머지된 가정).
> 5. **`maybeMicrocompact(history, sessionId, now?)` 시그니처** 로 변경 — S2 ADDENDUM 의 결정과 일치.
> 6. **이벤트 등록**은 plan §5 의 일괄 PR (Phase D).

---


**Goal:** S2 microcompact 가 stale tool_result 본문을 비운 뒤에도, LLM 이 그때 산출됐던 artifact (PDF/CSV/PPTX 등) 를 이름·경로 단서만으로 다시 끌어올 수 있게 한다. 두 축으로 해결: ① microcompact 가 만들어내는 placeholder 안에 artifact 메타(이름 + `artifact://` URI)를 **구조화해서 보존**, ② 새 도구 `read_artifact` 로 메타·텍스트 본문을 **on-demand** 로 재수화.

**Why now:** S2 가 `web_fetch` / `mcp__*` / `run_skill_script` stdout 까지 비우면서, "방금 만든 report.pdf 다시 좀 봐줘" 같은 후속 턴에서 LLM 이 artifact 의 path 를 잃는다. S2 의 `run_skill_script` 특수 처리는 envelope 의 `files: [...]` 배열을 살리지만, **다른 도구가 produce 한 artifact 도 동일 이슈** — 그리고 LLM 이 path 를 갖고 있어도 현재는 그걸 다시 읽을 표준 도구가 없다 (read_skill_file 은 skill dir 안만 읽고, sql_query 는 DB 만, web_fetch 는 외부 URL 만).

**Reference:** Claude Code `services/compact/autoCompact.ts` Stage-2 compact 는 summary 가 history 를 갈아끼운 뒤 **top-5 referenced files 를 디스크에서 다시 읽어 50K char budget 으로 prompt 에 재주입** 한다 — "rehydration" 패턴. OpenHive 의 microcompact 는 더 가벼운 (요약 안 하고 stub 만 남기는) 압축이라, **사전 재주입은 안 한다.** 대신 stub 안에 충분한 단서를 박아두고, LLM 이 필요할 때 도구로 한 번 더 읽어가게 한다.

**Dependency:** **S2 (microcompact) 선행 필수.** 본 스펙은 S2 의 `COMPACTABLE` / `NEVER_COMPACT` 분류와 `run_skill_script` 특수 처리 분기를 전제로 한다. S2 미구현 상태에서 A3 만 머지하면 placeholder 가 생성되지 않아 메타 보존 로직이 dead code 가 됨.

**Scope:**
- `artifact://` URI scheme 정의 + resolver.
- `read_artifact` 도구 (Lead + sub-agent 공통).
- S2 microcompact 의 placeholder 포맷을 "tool name + artifact 목록" 구조로 강화.
- `recentArtifactRefs` LRU 를 `RunState` 에 추가 (Phase 3 — 향후 full auto-compact 시 top-N 재주입에 쓸 groundwork).

**Out of scope:**
- 자동 top-N 재주입 (full auto-compact 가 아직 없음 — A4/후속 plan 에서 본격화).
- 바이너리 artifact (PDF/PPTX/이미지) 본문 텍스트화 — `read_artifact` 는 텍스트 mime 만 본문 반환. 바이너리는 메타만.
- artifact 편집/삭제 도구.
- 다른 세션 artifact 접근 (cross-session URI 는 거부).

---

## 0. 사전 정리: OpenHive artifact 인프라 현황

기존 자산 (재사용):

| 위치 | 역할 |
|---|---|
| `apps/web/lib/server/artifacts.ts:62` `recordArtifact` | `~/.openhive/sessions/{id}/artifacts.json` 에 `ArtifactRecord` append. |
| `apps/web/lib/server/artifacts.ts:82` `listForSession` | 세션의 모든 artifact record 반환. |
| `apps/web/lib/server/sessions.ts:111` `sessionArtifactDir` | `~/.openhive/sessions/{id}/artifacts/` 절대 경로. |
| `apps/web/lib/server/sessions.ts:123` `sessionArtifactsIndexPath` | `artifacts.json` 경로. |
| `apps/web/lib/server/engine/session.ts:2102` `registerSkillArtifacts` | skill 산출물을 `recordArtifact` 로 영속화. envelope 의 `files: [...]` → `[{id, filename, mime, size}, ...]` 변환. |
| `apps/web/lib/server/engine/session.ts:1825` `outputDir = sessionsStore.artifactDirForSession(ctx.sessionId)` | `run_skill_script` 가 산출물을 떨어뜨리는 cwd. |
| `apps/web/lib/server/skills/runner.ts:33` `SkillResult.files: GeneratedFile[]` | `{name, path, mime, size}` 구조. envelope 또는 디렉터리 snapshot 출처. |

`ArtifactRecord` (artifacts.ts:12) 가 이미 `session_id`, `path`, `filename`, `mime`, `size`, `created_at` 을 다 들고 있으므로 **추가 영속화 작업 불필요** — A3 는 기존 record 위에 URI scheme + 읽기 도구만 얹는다.

현재 `run_skill_script` 응답 (`session.ts:1901-1908`):
```ts
JSON.stringify({
  ok, exit_code, timed_out, stdout, stderr,
  files: registered, // [{id, filename, mime, size}, ...]
})
```
→ `id` (artifact_id) 가 들어 있지만 `path` 는 없음. LLM 이 `id` 를 들고 다음 턴에 뭔가 하려면 결국 도구가 필요하다 — A3 의 `read_artifact` 가 그 도구.

---

## Phase 1 — `artifact://` URI + resolver + `read_artifact` 도구

### Task 1.1: 모듈 신설

**Files:**
- Create: `apps/web/lib/server/sessions/artifacts.ts`

> 주의: 같은 이름 `artifacts.ts` 가 `apps/web/lib/server/artifacts.ts` 에 이미 있다 (record store). 충돌 회피 위해 신설 모듈은 `sessions/artifacts.ts` 경로 — record store 는 데이터 모델, 신설 모듈은 URI/resolver/tool 책임 분리.

- [ ] Step 1: 모듈 헤더 docstring — "URI scheme + path resolver + read_artifact tool. Record store 는 `../artifacts.ts` 참조."
- [ ] Step 2: 환경 변수 파싱.

```ts
export const ARTIFACT_READ_MAX_CHARS = (() => {
  const raw = process.env.OPENHIVE_ARTIFACT_READ_MAX_CHARS
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 50_000
})()
```

- [ ] Step 3: 텍스트 mime 판정 헬퍼.

```ts
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml',
  'application/yaml', 'application/x-yaml', 'application/javascript',
  'application/x-sh', 'application/csv']
const TEXT_MIME_EXACT = new Set([
  'application/json', 'application/xml', 'application/yaml',
  'application/x-yaml', 'application/javascript', 'application/x-sh',
  'application/csv', 'application/sql',
])

export function isTextMime(mime: string | null): boolean {
  if (!mime) return false
  if (TEXT_MIME_EXACT.has(mime)) return true
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))
}
```

### Task 1.2: URI scheme

- [ ] Step 1: 포맷 정의.

```
artifact://session/{session_id}/artifacts/{relative_path}
```

- `{session_id}` — UUID. `recordArtifact` 의 `session_id` 와 1:1.
- `{relative_path}` — `sessionArtifactDir(session_id)` 기준 상대 경로. POSIX `/` 만 사용 (OS sep 변환은 resolver 가).
- 예: `artifact://session/abc123/artifacts/report.pdf`, `artifact://session/abc123/artifacts/sub/data.csv`.

- [ ] Step 2: builder.

```ts
import path from 'node:path'
import { sessionArtifactDir } from '../sessions'

export function buildArtifactUri(sessionId: string, absPath: string): string {
  const root = sessionArtifactDir(sessionId)
  const rel = path.relative(root, absPath).split(path.sep).join('/')
  return `artifact://session/${sessionId}/artifacts/${rel}`
}
```

- [ ] Step 3: parser.

```ts
export interface ParsedArtifactUri {
  sessionId: string
  relativePath: string // POSIX, never starts with '/'
}

export function parseArtifactUri(uri: string): ParsedArtifactUri | null {
  const m = uri.match(/^artifact:\/\/session\/([^/]+)\/artifacts\/(.+)$/)
  if (!m) return null
  const [, sessionId, relativePath] = m
  if (!sessionId || !relativePath) return null
  return { sessionId, relativePath }
}
```

### Task 1.3: Path resolver (보안 게이트)

- [ ] Step 1: 시그니처.

```ts
export interface ResolvedArtifact {
  absPath: string
  sessionId: string
  relativePath: string
}

export interface ResolveOpts {
  /** Caller 의 현재 세션. URI 의 session_id 와 다르면 거부. */
  callerSessionId: string
}

export function resolveArtifactUri(
  uri: string,
  opts: ResolveOpts,
): { ok: true; resolved: ResolvedArtifact } | { ok: false; reason: string }
```

- [ ] Step 2: 검증 단계 (순서 중요).
  1. `parseArtifactUri` 실패 → `{ ok:false, reason: 'invalid_uri' }`.
  2. `parsed.sessionId !== opts.callerSessionId` → `{ ok:false, reason: 'session_mismatch' }`. (cross-session 차단.)
  3. `relativePath` 에 `..` 세그먼트 또는 절대경로 (`/...`, `C:\...`) 포함 → `{ ok:false, reason: 'traversal' }`. **포지티브 검증**: `path.posix.normalize(rel)` 결과가 원본 `rel` 과 다르거나 normalize 후에도 `..` 로 시작하면 거부.
  4. `root = sessionArtifactDir(parsed.sessionId)` 계산.
  5. `abs = path.join(root, ...rel.split('/'))` → `path.resolve(abs)`.
  6. `path.resolve(abs).startsWith(path.resolve(root) + path.sep)` 또는 `=== path.resolve(root)` 미만족 → `{ ok:false, reason: 'outside_root' }`. **반드시 `+ path.sep` 가드** (prefix-match 우회 방지: `/root/artifacts` vs `/root/artifacts2`).
  7. `fs.existsSync(abs) && fs.statSync(abs).isFile()` 미만족 → `{ ok:false, reason: 'not_found' }`.
  8. 통과 → `{ ok:true, resolved: { absPath: abs, sessionId, relativePath: parsed.relativePath } }`.

- [ ] Step 3: 단순 path 입력 (URI 가 아닌 그냥 `"report.pdf"` 또는 absolute path) 도 받기. `read_artifact({path})` 가 사용자 친화적이려면 두 가지 다 허용:

```ts
export function resolveArtifactPath(
  input: string,
  opts: ResolveOpts,
): { ok: true; resolved: ResolvedArtifact } | { ok: false; reason: string } {
  if (input.startsWith('artifact://')) return resolveArtifactUri(input, opts)
  // Bare path: treat as relative to caller session's artifact dir.
  // Reject absolute / traversal up-front.
  if (path.isAbsolute(input)) {
    // 단, `sessionArtifactDir(callerSessionId)` 하위라면 허용 (LLM 이 envelope path 를 그대로 넘기는 케이스).
    const root = sessionArtifactDir(opts.callerSessionId)
    const rAbs = path.resolve(input)
    const rRoot = path.resolve(root)
    if (rAbs !== rRoot && !rAbs.startsWith(rRoot + path.sep)) {
      return { ok: false, reason: 'outside_root' }
    }
    if (!fs.existsSync(rAbs) || !fs.statSync(rAbs).isFile()) {
      return { ok: false, reason: 'not_found' }
    }
    const rel = path.relative(rRoot, rAbs).split(path.sep).join('/')
    return { ok: true, resolved: { absPath: rAbs, sessionId: opts.callerSessionId, relativePath: rel } }
  }
  // Relative bare path → wrap into URI form.
  const synth = `artifact://session/${opts.callerSessionId}/artifacts/${input}`
  return resolveArtifactUri(synth, opts)
}
```

### Task 1.4: `read_artifact` 도구 정의

- [ ] Step 1: 도구 함수.

```ts
import * as artifactsStore from '../artifacts' // record store
import { sessionArtifactDir } from '../sessions'

export function readArtifactTool(sessionId: string): Tool {
  return {
    name: 'read_artifact',
    description:
      'Re-read an artifact (file produced earlier in this session) by its ' +
      'artifact:// URI or its relative path under this session\'s artifacts/ ' +
      'directory. Default mode "meta" returns metadata only (cheap). Mode ' +
      '"text" returns the file contents up to a character limit; binary ' +
      'mimes (PDF, PPTX, images) are rejected — use a skill script to ' +
      'extract their content instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Either an artifact:// URI (e.g. ' +
            '"artifact://session/abc/artifacts/report.csv") or a path ' +
            'relative to this session\'s artifacts/ directory ' +
            '(e.g. "report.csv").',
        },
        mode: {
          type: 'string',
          enum: ['meta', 'text'],
          description: 'meta (default): metadata only. text: file contents.',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const inputPath = String(args.path ?? '')
      const mode = (args.mode === 'text' ? 'text' : 'meta') as 'meta' | 'text'
      const r = resolveArtifactPath(inputPath, { callerSessionId: sessionId })
      if (!r.ok) {
        // emit denial event (Task 1.5)
        emitArtifactReadDenied(sessionId, inputPath, r.reason)
        return JSON.stringify({ ok: false, error: `denied: ${r.reason}` })
      }
      const { absPath, relativePath } = r.resolved

      // record store 조회 (mime/size/created_at 의 권위 출처)
      const records = artifactsStore.listForSession(sessionId)
      const rec = records.find((x) => x.path === absPath) ?? null

      const stat = fs.statSync(absPath)
      const meta = {
        name: rec?.filename ?? path.basename(absPath),
        path: relativePath,
        uri: buildArtifactUri(sessionId, absPath),
        mime: rec?.mime ?? null,
        size_bytes: rec?.size ?? stat.size,
        created_at: rec?.created_at ?? Math.floor(stat.mtimeMs),
        session_id: sessionId,
      }

      if (mode === 'meta') {
        emitArtifactRead(sessionId, relativePath, 'meta', 0)
        return JSON.stringify({ ok: true, meta })
      }

      // mode === 'text'
      if (!isTextMime(meta.mime)) {
        emitArtifactReadDenied(sessionId, inputPath, 'binary_mime')
        return JSON.stringify({
          ok: false,
          meta,
          error: 'binary mime; use a skill script (extract_doc / inspect_doc) to read content.',
        })
      }
      const buf = fs.readFileSync(absPath)
      const full = buf.toString('utf8')
      const truncated = full.length > ARTIFACT_READ_MAX_CHARS
      const content = truncated ? full.slice(0, ARTIFACT_READ_MAX_CHARS) : full
      emitArtifactRead(sessionId, relativePath, 'text', content.length)
      return JSON.stringify({
        ok: true,
        meta,
        content,
        truncated,
        truncated_at_chars: truncated ? ARTIFACT_READ_MAX_CHARS : null,
      })
    },
    hint: 'Reading artifact…',
  }
}
```

- [ ] Step 2: `recentArtifactRefs` (Phase 3 의 LRU) 가 후에 들어오면 `read_artifact` 핸들러 끝에서 `state.recentArtifactRefs.touch(absPath)` 호출 — 본 Phase 에서는 stub 만, 실제 코드는 Phase 3.

### Task 1.5: 도구 등록

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (`runNode` 의 tool list 구성부)

- [ ] Step 1: `runNode` 가 tools 를 모으는 지점 (대략 `session.ts:1600±`, skill / delegation / askuser 등을 push 하는 동일 위치) 에서 `readArtifactTool(ctx.sessionId)` 를 항상 push. **Lead (depth=0) + sub-agent (depth>0) 모두에 등록** — sub-agent 도 자기 세션의 artifact 를 다시 읽어야 하는 경우가 있다 (parent 가 산출한 보고서를 검증 sub 가 읽는 패턴).
- [ ] Step 2: 도구가 NEVER_COMPACT 후보인지 결정 → **NEVER_COMPACT 에 추가 불필요.** `read_artifact` 결과는 텍스트 본문일 수 있고 compactable. 다음 호출 시 다시 읽으면 됨. (S2 의 `COMPACTABLE_BUILTIN` set 에 명시 추가하지 않아도 builtin 은 compactable 기본 — S2 가 whitelist 라 그대로 두면 빠진다. **추가 필요**: S2 의 `COMPACTABLE_BUILTIN` 에 `'read_artifact'` 도 포함해야 다음 microcompact 라운드에 비워진다.)

→ 결과적으로 **S2 의 `COMPACTABLE_BUILTIN` set 에 `read_artifact` 한 줄 추가** 가 본 Task 의 부산물. 본 스펙은 S2 가 머지된 뒤 작업하므로 이 한 줄 패치는 A3 PR 안에서 처리.

### Task 1.6: 이벤트 emitter 헬퍼

**Files:**
- Modify: `apps/web/lib/server/sessions/artifacts.ts`

- [ ] Step 1: `emitArtifactRead` / `emitArtifactReadDenied` 는 직접 events.jsonl 쓰기보다, 상위 caller (`runNode`) 가 도구 실행 후 받은 result 를 보고 wrap 하도록 한다. **단, 도구 핸들러는 sync result 만 반환하므로** event 채널이 필요 → globalThis 의 event-writer 큐 (event-writer.ts) 에 직접 enqueue.
- [ ] Step 2: 구현.

```ts
import { enqueueEvent } from './event-writer' // 가정 — 실제 export 명 확인
import { makeEvent } from '../engine/events'

export function emitArtifactRead(
  sessionId: string, relPath: string, mode: 'meta' | 'text', bytesReturned: number,
): void {
  enqueueEvent(makeEvent('artifact.read', sessionId, {
    path: relPath, mode, bytes_returned: bytesReturned,
  }, { depth: null, node_id: null, tool_call_id: null, tool_name: 'read_artifact' }))
}

export function emitArtifactReadDenied(
  sessionId: string, attemptedPath: string, reason: string,
): void {
  enqueueEvent(makeEvent('artifact.read.denied', sessionId, {
    path: attemptedPath, reason,
  }, { depth: null, node_id: null, tool_call_id: null, tool_name: 'read_artifact' }))
}
```

→ `enqueueEvent` 의 정확한 시그니처는 `apps/web/lib/server/sessions/event-writer.ts` 확인 후 맞춤. 만약 직접 enqueue 가 깨지면 fallback: 도구 핸들러 결과 envelope 의 별도 필드 (`_event`) 로 신호를 흘려보내 caller 가 yield. Phase 1 PR 에서 결정.

---

## Phase 2 — S2 microcompact placeholder 강화

### Task 2.1: artifact 메타 추출 헬퍼

**Files:**
- Modify: `apps/web/lib/server/engine/microcompact.ts` (S2 가 만든 모듈)

- [ ] Step 1: `extractArtifactRefs(content: string, sessionId: string): ArtifactRef[]` 헬퍼.

```ts
interface ArtifactRef {
  name: string
  uri: string
}

function extractArtifactRefs(content: string, sessionId: string): ArtifactRef[] {
  if (typeof content !== 'string') return []
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return []
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return [] }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>
  // run_skill_script envelope: registered = [{id, filename, mime, size}, ...]
  // generated envelope (raw): files = [{name, path, mime}, ...]
  const candidates: Array<{ name?: unknown; filename?: unknown; path?: unknown }> = []
  if (Array.isArray(obj.files)) candidates.push(...(obj.files as any[]))
  const refs: ArtifactRef[] = []
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const name = (typeof c.filename === 'string' && c.filename) ||
                 (typeof c.name === 'string' && c.name) || null
    const absPath = typeof c.path === 'string' ? c.path : null
    if (!name) continue
    // URI 우선 — path 가 있으면 빌드, 없으면 name 으로 합성 (best-effort).
    const uri = absPath
      ? buildArtifactUri(sessionId, absPath)
      : `artifact://session/${sessionId}/artifacts/${name}`
    refs.push({ name, uri })
  }
  return refs
}
```

→ `run_skill_script` 의 `registered` 출력은 `path` 가 빠진 형태 (`session.ts:2127`) 이므로, S2 의 `run_skill_script` 특수 처리에서 `files` 보존할 때 **path 도 같이 살려두는 보강**이 필요. 두 옵션:

**Option A (선호):** `registerSkillArtifacts` 출력에 `path` 를 한 필드 추가 (`session.ts:2127-2132`):

```ts
out.push({
  id: rec.id, filename: f.name, mime: f.mime, size: f.size,
  uri: `artifact://session/${ctx.sessionId}/artifacts/${path.relative(sessionArtifactDir(ctx.sessionId), f.path).split(path.sep).join('/')}`,
})
```

→ envelope 응답 자체에 `uri` 가 박혀 LLM 이 처음 받는 순간부터 URI 를 들고 다님. microcompact 가 별도로 추출할 필요 줄어듦. **A 채택.**

**Option B:** record store (`artifactsStore.listForSession`) 를 microcompact 시점에 재조회해서 `path` 를 역참조. Side effect 적지만 microcompact 마다 disk I/O 추가 — 비추.

### Task 2.2: placeholder 포맷 변경

**Files:**
- Modify: `apps/web/lib/server/engine/microcompact.ts`

S2 Phase 1 Task 1.3 Step 4-6 의 일반 케이스 placeholder 를 다음으로 교체:

```ts
const refs = extractArtifactRefs(content, sessionId)
let stub: string
if (refs.length === 0) {
  stub = `[Old tool result cleared. Tool: ${toolName}. Re-call if needed.]`
} else {
  const lines = refs.map((r) => `  - ${r.name} (${r.uri})`).join('\n')
  stub = [
    `[Old tool result cleared. Tool: ${toolName}.`,
    `Artifacts:`,
    lines,
    `Re-read via read_artifact({path: "..."}).]`,
  ].join('\n')
}
m.content = stub
```

`maybeMicrocompact` 시그니처에 `sessionId: string` 추가 필요. caller (`session.ts` `streamTurn`) 가 `sessionId` 를 이미 들고 있어서 한 줄 통과만 시키면 됨.

### Task 2.3: `run_skill_script` 특수 분기 강화

S2 의 특수 처리 (`{ ok, files, _cleared }` 재구성) 에서 `files` 항목이 이미 `uri` 를 들고 있으면 그대로 유지. 추가로 placeholder 도 동일 포맷으로 사용 — JSON envelope 안에 `_artifacts` 메타 한 줄 추가:

```ts
JSON.stringify({
  ok: parsed.ok,
  files: parsed.files, // uri 포함
  _cleared: `stdout/stderr cleared (${original.length} chars). Use read_artifact to re-read individual files; re-run script if you need fresh output.`,
})
```

LLM 입장에서는 `files[i].uri` 를 보고 `read_artifact({path: uri})` 호출 가능.

### Task 2.4: 멱등성 가드

S2 의 "이미 cleared 면 skip" 가드 (`[Old tool result cleared` prefix 체크) 가 새 multi-line 포맷에서도 동작해야 한다. 새 stub 도 `[Old tool result cleared` 로 시작하므로 OK. test 추가 (Phase 4).

---

## Phase 3 — `recentArtifactRefs` LRU (groundwork)

### Task 3.1: RunState 확장

**Files:**
- Modify: `apps/web/lib/server/engine/session-registry.ts` (또는 `RunState` 정의 위치)

- [ ] Step 1: `RunState` 타입에 `recentArtifactRefs?: LRUSet<string>` 추가. value = artifact 절대경로 (또는 URI — 일관성 위해 URI 추천).
- [ ] Step 2: 간단 LRU 자체구현 (deps 추가 금지). 16 슬롯 고정.

```ts
class LRUSet<T> {
  private order: T[] = []
  constructor(private capacity: number) {}
  touch(v: T): void {
    const i = this.order.indexOf(v)
    if (i >= 0) this.order.splice(i, 1)
    this.order.push(v)
    if (this.order.length > this.capacity) this.order.shift()
  }
  topN(n: number): T[] { return this.order.slice(-n).reverse() }
  get size(): number { return this.order.length }
}
```

- [ ] Step 3: `RunState` 생성자에서 `recentArtifactRefs = new LRUSet<string>(16)`.
- [ ] Step 4: in-memory only — `events.jsonl` / FS persistence 없음. reattach 시 빈 상태로 시작 (boot 시 events 를 replay 하면서 `artifact.read` event 보고 채워넣는 옵션은 Phase 4 후속 — 본 Phase 는 fresh 만).

### Task 3.2: touch 지점

- `read_artifact` 핸들러 성공 시 → state 가 caller 에 노출돼 있다면 `state.recentArtifactRefs.touch(uri)`.
- `registerSkillArtifacts` 호출 직후 → 새로 만든 artifact 도 "최근 참조" 로 간주, touch.

도구 핸들러에서 state 접근하려면 `runNode` 가 tool list 만들 때 closure 로 잡아 넘기면 됨 — `readArtifactTool(sessionId, state)` 시그니처로 확장.

### Task 3.3: 사용처 (placeholder 만)

**현 Phase 에서는 LRU 만 채우고 소비처는 안 만든다.** 사용 시점: 후속 full auto-compact 가 들어올 때, summary 직후 `state.recentArtifactRefs.topN(5)` 를 돌며 텍스트 mime 만 50K char budget 으로 prompt 에 재주입. 본 스펙은 그 hook 의 자료구조만 깔아둠. 코드 주석에 "placeholder for full auto-compact rehydration; see A3 spec" 명시.

---

## Phase 4 — 관찰성 + 테스트

### Task 4.1: 이벤트 타입 등록

**Files:**
- Modify: `apps/web/lib/server/engine/events.ts`

- [ ] Step 1: Event union 에 `'artifact.read'`, `'artifact.read.denied'` 추가.
- [ ] Step 2: data shape:
  - `artifact.read`: `{ path: string, mode: 'meta' | 'text', bytes_returned: number }`
  - `artifact.read.denied`: `{ path: string, reason: 'invalid_uri' | 'session_mismatch' | 'traversal' | 'outside_root' | 'not_found' | 'binary_mime' }`
- [ ] Step 3: events.jsonl writer whitelist 갱신 (있다면).

### Task 4.2: 단위 테스트

**Files:**
- Create: `apps/web/lib/server/sessions/artifacts.test.ts`

- [ ] Step 1: 케이스 A — `parseArtifactUri` round-trip (`buildArtifactUri` 결과를 다시 parse → 동일 sessionId / relativePath).
- [ ] Step 2: 케이스 B — `resolveArtifactUri` 정상: tmp 세션 디렉터리에 더미 파일 만들고 URI 빌드 → resolve → `absPath` 일치, `ok: true`.
- [ ] Step 3: 케이스 C — traversal: `read_artifact({path: "../../../etc/passwd"})` → `denied`, reason `traversal` 또는 `outside_root`.
- [ ] Step 4: 케이스 D — absolute outside root: `read_artifact({path: "/etc/passwd"})` → `denied`, reason `outside_root`.
- [ ] Step 5: 케이스 E — cross-session: 세션 A 의 URI 를 caller=세션 B 로 resolve → `denied`, reason `session_mismatch`.
- [ ] Step 6: 케이스 F — not_found: 존재 안 하는 파일명 → `denied`, reason `not_found`.
- [ ] Step 7: 케이스 G — text mode 정상: txt 파일 (text/plain mime record) 생성 → `mode: 'text'` → `content` 반환, `truncated: false`.
- [ ] Step 8: 케이스 H — text mode 트렁케이션: `OPENHIVE_ARTIFACT_READ_MAX_CHARS=100`, 200 char 파일 → `content.length === 100`, `truncated: true`.
- [ ] Step 9: 케이스 I — binary mime: `application/pdf` record → `mode: 'text'` → `ok: false`, error 에 `binary mime`. `mode: 'meta'` 는 정상.
- [ ] Step 10: 케이스 J — meta mode 는 record store 가 없는 파일도 stat 으로 메타 채움 (filename = basename, mime = null).
- [ ] Step 11: 케이스 K — prefix-match 우회 시도: `sessionArtifactDir = /tmp/sess1/artifacts`, 입력 `/tmp/sess1/artifacts2/leak` → `outside_root` (path.sep 가드 검증).

### Task 4.3: microcompact placeholder 테스트

**Files:**
- Modify: `apps/web/lib/server/engine/microcompact.test.ts` (S2 가 만든 파일)

- [ ] Step 1: 케이스 L — `web_fetch` 결과 + envelope 안에 `files: [{name, path}]` → microcompact 후 placeholder 가 `Artifacts:` 블록 + 정확한 `artifact://` URI 포함.
- [ ] Step 2: 케이스 M — artifact 없는 일반 `web_fetch` 결과 → 기존 짧은 placeholder (`Artifacts:` 블록 없음).
- [ ] Step 3: 케이스 N — `run_skill_script` 결과의 `files` 가 microcompact 후에도 envelope 안에 `uri` 와 함께 살아남음.
- [ ] Step 4: 케이스 O — 멱등성: 새 multi-line placeholder 가 두 번째 microcompact 라운드에서 skip (이미 `[Old tool result cleared` prefix).

### Task 4.4: 통합 / 수동 검증

- [ ] Step 1: dev 기동, Lead 가 `run_skill_script` 로 보고서 PDF + CSV 생성하는 시나리오 실행.
- [ ] Step 2: 6 분 idle 후 후속 턴 — Lead 의 다음 prompt 안에 `[Old tool result cleared. Tool: run_skill_script. ...]` 가 아닌, envelope 안 `files[].uri` 가 살아있는지 확인 (S2 의 특수 분기).
- [ ] Step 3: Lead 가 `read_artifact({path: "report.csv", mode: "text"})` 호출 → CSV 본문 반환.
- [ ] Step 4: Lead 가 `read_artifact({path: "report.pdf", mode: "text"})` → `binary_mime` 에러.
- [ ] Step 5: `read_artifact({path: "../../oauth.enc.json"})` 직접 prompt 주입 → `traversal` denied + `artifact.read.denied` 이벤트.
- [ ] Step 6: 다른 세션 UUID 박은 URI 시도 → `session_mismatch` denied.
- [ ] Step 7: events.jsonl 에 `artifact.read` / `artifact.read.denied` 라인 확인.

---

## Phase 5 — 문서

### Task 5.1: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] Step 1: "Architectural Rules" 부근에 한 줄 — "Artifact 재접근은 `read_artifact` 도구 + `artifact://session/{id}/artifacts/{rel}` URI scheme. Path traversal / cross-session 접근은 resolver 가 차단. 바이너리 mime 은 메타만, 텍스트는 `OPENHIVE_ARTIFACT_READ_MAX_CHARS` (기본 50_000) 까지."
- [ ] Step 2: env 변수 표에 `OPENHIVE_ARTIFACT_READ_MAX_CHARS` 추가.

### Task 5.2: i18n

`read_artifact` 자체는 LLM 노출 도구라 description 은 영어 그대로 (provider 프롬프트 — 번역 대상 아님). UI surface 가 새로 생기지 않음 (기존 artifact 다운로드 UI 그대로). → **i18n 사전 수정 없음.** 만약 향후 Run 캔버스에 "artifact.read" 이벤트를 시각화한다면 그때 `en` + `ko` 키 둘 다 추가.

### Task 5.3: 다이어그램

해당 없음. 엔진 플로우 / 델리게이션 / 이벤트 구조 큰 변경 아님 (이벤트 두 종 추가는 minor). 저장 레이아웃 변경 없음 — 기존 `artifacts.json` + `artifacts/` 그대로. CLAUDE.md 다이어그램 규칙에 따라 skip.

---

## 모듈 / 파일 요약

신설:
- `apps/web/lib/server/sessions/artifacts.ts` — URI builder/parser, resolver, `read_artifact` tool, event emitter helpers.
- `apps/web/lib/server/sessions/artifacts.test.ts` — Phase 4 unit test.

수정:
- `apps/web/lib/server/engine/session.ts` — `runNode` 의 tool list 에 `readArtifactTool` 등록 (Lead + sub-agent 둘 다). `registerSkillArtifacts` 출력에 `uri` 필드 추가.
- `apps/web/lib/server/engine/microcompact.ts` (S2) — `maybeMicrocompact` 시그니처에 `sessionId` 추가, `extractArtifactRefs` + 강화된 placeholder, `run_skill_script` 특수 분기에 `_cleared` 메시지 + `read_artifact` 안내. `COMPACTABLE_BUILTIN` 에 `'read_artifact'` 추가.
- `apps/web/lib/server/engine/microcompact.test.ts` (S2) — 케이스 L–O 추가.
- `apps/web/lib/server/engine/session-registry.ts` (또는 RunState 정의 위치) — `recentArtifactRefs: LRUSet<string>` (Phase 3).
- `apps/web/lib/server/engine/events.ts` — `'artifact.read'`, `'artifact.read.denied'` event kind 추가.
- `CLAUDE.md` — Architectural Rules 한 줄 + env 변수 표.

---

## 리스크 / 주의

- **Path resolver 가 보안 critical.** `..` 검사를 단계 3 에서 한 번, prefix-match 가드를 단계 6 에서 한 번 — **두 단계 모두 통과해야** outside_root 차단. test K (prefix 우회) 가 가드. 코드 리뷰 시 `+ path.sep` 빠지면 reject.
- **`registerSkillArtifacts` shape 변경의 파급.** envelope 출력에 `uri` 한 필드 추가 — UI 가 이 envelope 을 직접 파싱하는지 확인. `apps/web/components/...` 에서 `files[].id` / `files[].filename` 만 쓰고 있다면 무해. grep 으로 검증.
- **mime null 인 record.** `recordArtifact` 의 `mime` 은 `string | null`. text 모드에서 null 이면 `isTextMime(null) = false` → 거부. 이게 너무 보수적이면 fallback: `null` 일 때 `path.extname` + 화이트리스트 확장자 (`.txt`, `.csv`, `.json`, `.md`, `.yaml`, `.yml`, `.log`) → text 로 간주하는 second-chance 분기. 1차에는 단순화, 운영 중 false-negative 보고 들어오면 추가.
- **cross-session URI 차단의 부작용.** Lead 가 sub-agent 를 띄울 때 sub 도 동일 sessionId 로 도는지 확인 (engine 의 단일 세션 모델 — 통상 동일). 만약 sub-agent 가 별도 sessionId 를 갖는다면 본 가드가 sub 의 정상적 parent artifact 접근을 막을 수 있음 → engine 코드 확인 필요. `runNode` 의 `ctx.sessionId` 가 depth 와 무관하게 root session 인지 검증 (Phase 1 Task 1.5 의 prerequisite).
- **LRU groundwork 가 dead code 로 남을 위험.** Phase 3 는 실제 소비처가 없는 기록 전용. 후속 full auto-compact 가 안 나오면 영영 unused. 1차 PR 에서 Phase 3 를 분리 머지 가능 — Phase 1+2 가 본질, Phase 3 는 옵션. PR 스플릿 권장.
- **읽기 큰 파일 메모리.** `fs.readFileSync` → 50K char (≈50KB ASCII / 200KB UTF-8 한글 worst case) 이내. 안전. `OPENHIVE_ARTIFACT_READ_MAX_CHARS` 를 너무 크게 잡으면 `Buffer.toString('utf8')` 가 전체 파일을 메모리에 올리는 점 주의 — slice 는 toString 이후. **개선 여지**: `fs.createReadStream` + chunk 수집, char count 도달 시 stop. 1차에는 단순.
- **events emitter 가 동기 fire-and-forget.** `enqueueEvent` 가 비동기 flush (event-writer batch) 라 도구 핸들러가 결과 반환 직후 process 가 죽으면 이벤트 누락. event-writer 의 SIGTERM drain 훅 (CLAUDE.md 참조) 이 커버 — 신뢰.

---

## Definition of Done

- [ ] `apps/web/lib/server/sessions/artifacts.ts` 신설 + Phase 4 unit test (A–K) 전부 통과.
- [ ] `read_artifact` 도구가 Lead + sub-agent 양쪽 `runNode` tool list 에 등록.
- [ ] microcompact placeholder 가 artifact list (multi-line `Artifacts:` 블록 + `artifact://` URI) 를 보존; 멱등성 유지.
- [ ] `registerSkillArtifacts` 출력에 `uri` 필드 추가, envelope 재구성 시 살아남음.
- [ ] traversal / cross-session / binary-mime / not-found 시도가 `artifact.read.denied` 이벤트 발생 + `{ok: false}` 반환.
- [ ] `OPENHIVE_ARTIFACT_READ_MAX_CHARS` 로 본문 길이 cap 조정 가능.
- [ ] `RunState.recentArtifactRefs: LRUSet<string>` 추가, `read_artifact` 성공 + `registerSkillArtifacts` 직후 touch (소비처는 Phase 3 에서 미배선 — 의도된 hook).
- [ ] `biome check` clean, `pnpm --filter @openhive/web test` 통과.
- [ ] 새 deps 0 개. FS persistence 추가 0 개 (기존 `artifacts.json` + `artifacts/` 재사용). LangChain/LangGraph 재도입 0 건.
