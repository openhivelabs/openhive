# Runtime Claude Patterns — OpenHive 이식 마스터 플랜

> **Status (2026-04-22):** 구현 직전(ready-to-implement). 모든 cross-cutting 결정·환경변수·이벤트 스키마·acceptance 검증을 본 문서에 lock-in. 각 spec 파일은 본 문서를 권위로 따른다.

**Goal:** Claude Code 의 검증된 런타임 패턴 8 개를 OpenHive 엔진에 이식해 (1) 긴 회사 실행에서 컨텍스트 안 죽고 (2) 병렬 델리게이션 캐시 효율 확보 (3) 회사 단위 업무 원장 누적 (4) 안전망/관측성 강화.

**Why:** 현재 OpenHive 엔진은 컨텍스트 압축 미구현 (`session.ts:568` `historyWindow = Infinity`, `session.ts:569` `summariseHistory` no-op), 서브에이전트 결과 무제한 cap (`session.ts:1112`/1310 의 `delegation_closed` 직전 cap 없음), parallel delegation 시 prompt cache 미활용, 회사 단위 업무 누적 메커니즘 부재.

---

## 0. Scope / Out-of-scope

**In:** S1–S4, A1–A4 (8 specs). 본 문서가 **단일 진실 공급 소스(SSoT)**.

**Out (변경 없음, context.md 참조):**
- memdir cross-session 메모리, Permission modes 6종, 24-event hook taxonomy, Worktree, CLAUDE.md hierarchy
- LLM-기반 요약 본 구현 (S1/S4 `'llm'` 전략은 stub)
- Auto-compact 본 구현 (A4 는 "트리거 산수 + circuit breaker 자리"만)
- Per-skill `concurrency_class` parser (A1 키만 reserve)
- A3 LRU `recentArtifactRefs` Phase 3 (auto-compact 가 들어올 때 같이 작업, 본 라운드에서 분리)

---

## 1. Pinned code facts (구현 시 grep 으로 재확인 권장)

`apps/web/lib/server/engine/session.ts` (2102 lines, 2026-04-22 기준):

| Symbol | Line | 비고 |
|---|---|---|
| `SERIAL_TOOL_NAMES` | 53 | A1 에서 `TRAJECTORY_TOOLS` 로 alias |
| `splitToolRuns` | 65 | A1 에서 `partitionRuns` 로 교체 |
| `inboxState` | 297 | Stop hook finally 위치 식별용 |
| `runTeam` | 328 | A2 SessionStart 진입 |
| `runTeamBody` | 371 | A2 Stop hook + finalizeSession 단일 호출 |
| `'run_started'` emit | 383 | A2 SessionStart hook fire 직전 |
| `runNode` 호출 (in runTeamBody) | 395 | `injectedSystemSuffix` 전달 |
| `'run_finished'` emit | 416 | A2 Stop 트리거 1 |
| `'run_error'` emit | 419 | A2 Stop 트리거 2 |
| `inboxState().queues.delete` (finally) | 421 | A2 Stop hook 호출 위치 |
| `runNode` | 465 | A3 `read_artifact` tool 등록 (depth 무관) |
| `historyWindow = Infinity` | 568 | A4 후속 auto-compact 진입점 |
| `summariseHistory` no-op | 569 | 동상 |
| `streamTurn` | 627 | S2 microcompact / S3 snapshot / A4 token 추정 진입 |
| char 카운팅 (`systemChars` etc) | 632–642 | A4 옆에 token 필드 추가, char 유지 |
| `recordUsage` 분기 | 666–688 | A4 새 필드 전달 |
| `splitToolRuns` 호출 | 719 | A1 교체 지점 |
| `'tool_called'` emit | 731 | A2 PreToolUse fire 직후 |
| `runDelegation` | 992 | S1 cap, S4 ledger write |
| `'delegation_closed'` (single, success) | 1112 | S1/S4 hook |
| `runParallelDelegation` | 1175 | S3 fork dispatch |
| `runOne` (parallel) | 1244 | S3 fork branch |
| `'delegation_closed'` (parallel) | 1310 | S4 hook 적용 (S1 단일 1:1 만, parallel 결과 cap 은 S3 fork 결과 merge 자리 — 본 라운드 후속) |
| `registerSkillArtifacts` 호출 | 1835, 2002 | A3 envelope 에 `uri` 추가 |
| `registerSkillArtifacts` 정의 | 2043 | A3 출력 shape 변경 |

기타:
- `apps/web/lib/server/engine/team.ts:12` `AgentSpec`, `:41` `TeamSpec`, `:90` `toTeamSpec` — S1 `result_cap?`, S4 `domain?` 추가 위치.
- `apps/web/lib/server/engine/providers.ts:21` `stream(providerId, model, messages, tools)` — S3 가 5번째 `opts?` 추가.
- `apps/web/lib/server/providers/claude.ts:225` `streamMessages`, `:137` `splitSystem` — S3 `useExactTools` / `overrideSystem` + `mergeAdjacentUsers`.
- `apps/web/lib/server/providers/caching.ts:62` `AnthropicCachingStrategy` — 변경 없음, `useExactTools` 가드만.
- `apps/web/lib/server/sessions/event-writer.ts:82` `enqueueEvent(sessionId, rowJsonl: string)` — **주의: payload 가 raw JSONL 문자열.** A3 의 `emitArtifactRead` 헬퍼는 `makeEvent(...)` 한 뒤 `JSON.stringify(event) + '\n'` 으로 wrap 후 전달.
- `apps/web/lib/server/artifacts.ts:62` `recordArtifact`, `:82` `listForSession` — A3 record 출처.
- `apps/web/lib/server/sessions.ts:111` `sessionArtifactDir` — A3 path resolver root.

---

## 2. Spec dependency graph (lock-in)

```
A4 (token math)        ── 독립.   소비처는 후속 auto-compact. S2 트리거에는 v1에서 "옵션"
A1 (tool partition)    ── 독립.   session.ts:719 교체.
S1 (result cap)        ── 독립.   session.ts:1112 hook.
S3 (fork pattern)      ── 독립.   provider==claude-code 게이트.
S2 (microcompact)      ── 독립.   session.ts:627 streamTurn 진입.
S4 (work ledger)       ── team.yaml `domain?` 추가. S2/A2 와 충돌 없음.
A2 (hooks)             ── 독립.   session.ts:383/731/421 hook.
A3 (artifact rehydration) ── **S2 선행 필수**.  Phase 1+2 만 본 라운드, Phase 3 LRU 보류.
```

**의존 엣지 (확정):**
- `A3 → S2`: A3 의 envelope `uri` 보존 / placeholder 강화는 S2 의 microcompact 가 만든 placeholder 위에서만 의미가 있음. S2 가 머지된 뒤 A3.
- `S3 ↔ S2`: 독립. (이전 plan 의 "S3→S2" 는 잘못된 표기. snapshot 기록은 모든 streamTurn 에서 발생, S2 와 무관.)
- `A4 → S2`: **옵션.** v1 의 S2 는 시간축(`STALE_AFTER_MS`) only. A4 의 `shouldMicrocompact` 는 v2 에서 AND 조건으로 도입 — 본 라운드에선 v1 만. (S2 spec 의 "토큰 기반 강제 compact 는 out of scope" 와 일치.)

**Provider 게이트 (S3 만):** `decideForkOrFresh` 가드에 다음 조건 모두 만족할 때만 `fork: true` (택일 B 확정):
1. `OPENHIVE_FORK_DISABLE !== '1'`
2. `child.provider_id === 'claude-code'`
3. `snapshot.providerId === child.provider_id` ← **신규 가드 (s3 spec §3.3 에 추가됨)**
4. `snapshot.nodeId === parent.id && snapshot.depth === depth`
5. `Date.now() - snapshot.builtAt <= 60_000`
6. `!isInForkChild(snapshot.history)`

위 6 중 하나라도 false → `fork: false` + `fork.skipped` event 발행, fresh path.

---

## 3. 구현 순서 (직렬, 같은 파일 충돌 회피)

```
Phase A — 독립 기초 (병렬 OK, 다른 파일):
  ├─ A4 (apps/web/lib/server/usage/{contextWindow,tokens,circuitBreaker}.ts 신규)
  └─ S4 (apps/web/lib/server/ledger/* 신규 + team.ts:41 domain? 추가)

Phase B — session.ts 교체 (직렬 필수, 머지 충돌 회피):
  1. A1 (splitToolRuns → partitionRuns, line 65/719)
  2. S1 (runDelegation cap, line 1112)
  3. S3 (runParallelDelegation fork, line 1175/1244 + providers.ts/claude.ts)
  4. S2 (streamTurn microcompact, line 627)

Phase C — 외부 인터페이스 (병렬 OK):
  ├─ A2 (lib/server/hooks/* 신규 + session.ts:383/731/421 hook)
  └─ A3 (lib/server/sessions/artifacts.ts 신규 + microcompact.ts placeholder 강화 + registerSkillArtifacts uri)

Phase D — 통합 검증:
  - 이벤트 kind union 일괄 등록 (§5)
  - CLAUDE.md 일괄 업데이트 (§7 snippet)
  - acceptance 검증 통과 (§6)
```

각 Phase 내 작업은 별도 PR. Phase B 내부는 직렬 PR. Phase A, C 는 병렬 PR 가능.

---

## 4. Cross-cutting 결정 (모든 spec 이 따름)

### 4.1 단위 (char vs token) — 책임 분리

| 영역 | 단위 | 임계값 위치 |
|---|---|---|
| S1 sub-agent output cap | **char** | `MAX_CHILD_RESULT_CHARS = 100_000` (s1 spec §상수) |
| S1 LLM 요약 본문 | **char** | `SUMMARY_MAX_CHARS = 4_000` |
| S2 microcompact trigger (v1) | **time only** | `STALE_AFTER_MS = 5min` |
| S2 microcompact min payload | **char** | `OPENHIVE_MICROCOMPACT_MIN_CHARS = 200` |
| S4 heuristic summary | **char** | head 500 + tail 200 |
| A4 effective window / blocking | **token (estimated)** | `effectiveWindow(provider, model)` |

**S2 → A4 token-based 전환**은 v2 (별도 plan). v1 은 char + 시간만.

### 4.2 Globalthis singleton 키 (CLAUDE.md 규칙)

신규 키 (모두 `Symbol.for('openhive.*')` 형식):
- `Symbol.for('openhive.ledger.dbCache')` — S4
- `Symbol.for('openhive.hooks.configCache')` — A2

S3 의 `lastTurnSnapshot` / `forkSystemCache` 는 기존 `RunState` (이미 globalThis 에 상주) 안에 필드 추가 — 새 키 없음.

### 4.3 `enqueueEvent` 호출 컨벤션 (A3 영향)

`event-writer.ts:82` 시그니처는 `enqueueEvent(sessionId: string, rowJsonl: string): void`. 즉 caller 가 직접 jsonl 문자열로 직렬화한다. 헬퍼 패턴:

```ts
import { enqueueEvent } from '../sessions/event-writer'
import { makeEvent } from '../engine/events'

enqueueEvent(sessionId, JSON.stringify(makeEvent(kind, sessionId, data, opts)) + '\n')
```

A3 의 `emitArtifactRead` / `emitArtifactReadDenied` 는 위 패턴 그대로 사용. (이전 spec 초안의 "`enqueueEvent(makeEvent(...))`" 는 오류 — 본 SSoT 가 우선.)

### 4.4 finalizeSession 단일 호출 가드 (A2)

**택일 A 확정.** `runTeamBody` finally 블록(line 421 부근)에서 직접 `finalizeSession(...)` 호출 → Stop hook fire. `run-registry` 의 기존 `finalizeSession` 호출은 **idempotent guard** 추가 (이미 finalize 됐으면 noop).

가드 구현: `finalizeSession` 내부에서 `meta.finalized_at` 필드 확인. 이미 set 되어 있으면 즉시 return. 첫 호출 시 `meta.finalized_at = Date.now()` 기록 + transcript/usage write. 위치: `apps/web/lib/server/sessions.ts` 의 `finalizeSession` (line 231 부근, A2 spec §통합지점 참조).

### 4.5 A3 Phase 분리 (본 라운드 = Phase 1+2 만)

| Phase | 본 라운드 포함? | 비고 |
|---|---|---|
| A3 Phase 1: URI scheme + resolver + `read_artifact` tool | ✅ | |
| A3 Phase 2: microcompact placeholder 강화 + envelope `uri` | ✅ | S2 머지 후 |
| A3 Phase 3: `recentArtifactRefs` LRU | ❌ 보류 | 후속 auto-compact 와 묶음 |
| A3 Phase 4: 관찰성/테스트 | ✅ (Phase 3 제외 항목만) | |

A3 spec 의 Phase 3 섹션은 "deferred" 마크 추가, 코드 작성 안 함.

### 4.6 S4 `team.yaml` `domain?` 추가 위치

`apps/web/lib/server/engine/team.ts:41` `TeamSpec` 인터페이스 끝에 `domain?: string` 추가. `toTeamSpec` (line 90) 의 raw 정규화에서:

```ts
domain: typeof raw.domain === 'string' ? raw.domain : undefined,
```

Loader / writer 변경 없음 — passthrough.

### 4.7 S1 `result_cap?` 추가 위치

`apps/web/lib/server/engine/team.ts:12` `AgentSpec` 인터페이스 끝에 추가:

```ts
result_cap?: { strategy?: 'heuristic' | 'llm' | 'off'; max_chars?: number }
```

`toAgentSpec` (line 67) raw passthrough:
```ts
result_cap: typeof raw.result_cap === 'object' && raw.result_cap !== null
  ? raw.result_cap as AgentSpec['result_cap']
  : undefined,
```

---

## 5. 이벤트 kind union (일괄 등록)

본 라운드에서 `apps/web/lib/server/engine/events.ts` (또는 `apps/web/lib/server/events/schema.ts` — 어느 쪽이든 union 위치 grep 으로 확정) 의 Event union 에 다음 kind 를 모두 추가. 한 PR (Phase D) 에서 일괄 처리:

| Kind | Spec | data shape |
|---|---|---|
| `microcompact.applied` | S2 | `{ tool_name: string; tool_call_id: string; original_chars: number }` |
| `fork.spawned` | S3 | `{ parent_node_id; child_node_id; sibling_index; sibling_count; system_prompt_chars; prefix_chars; tool_count: number }` |
| `fork.skipped` | S3 | `{ parent_node_id; child_node_id; reason: 'non_claude'\|'recursive'\|'no_snapshot'\|'env_disabled'\|'provider_mismatch' }` |
| `tool_run.partitioned` | A1 | `{ total; parallel_groups; serial_count; max_parallel_in_group: number }` |
| `hook.invoked` | A2 | `{ event_name; matcher; command; exit_code; duration_ms; timed_out: boolean; decision: 'approve'\|'block'\|null }` |
| `artifact.read` | A3 | `{ path; mode: 'meta'\|'text'; bytes_returned: number }` |
| `artifact.read.denied` | A3 | `{ path; reason: 'invalid_uri'\|'session_mismatch'\|'traversal'\|'outside_root'\|'not_found'\|'binary_mime' }` |
| `token.estimate.drift` | A4 | `{ provider_id; model; estimated; actual; drift_ratio; pad_factor: number }` |
| `turn.blocked` | A4 (Phase 3, env-gated) | `{ reason; estimated_tokens; blocking_limit; provider_id; model }` |
| `autocompact.disabled` | A4 (helper only, 호출처 후속) | `{ reason; failures; last_error }` |

**`delegation_closed.data` 확장 (S1, kind 변경 없음):** `truncated?`, `original_chars?`, `summary_strategy?`, `artifact_paths?` 모두 optional. forward-compatible.

UI 측 timeline 은 unknown kind 를 무시. 시각화는 후속 작업.

---

## 6. Acceptance verification (testable form)

각 spec 의 acceptance 기준을 실행 가능한 명령으로. 본 라운드 DoD = 모두 통과.

| Spec | Verify command / measurement | 합격 기준 |
|---|---|---|
| **A1** | `pnpm --filter @openhive/web test -- tool-partition` | unit test 11 cases all green; `partitionRuns` 15× mcp → `parallel_groups === 2` |
| **A1 integration** | dev 서버 + mock turn (12 stub mcp) → `events.jsonl \| grep tool_run.partitioned` | `max_parallel_in_group <= 10` |
| **S1** | `pnpm --filter @openhive/web test -- result-cap` | 8 cases (A–H) green |
| **S1 integration** | 200KB sub-agent output → `events.jsonl` 의 `delegation_closed.data` | `truncated: true`, `original_chars: 200000`, `summary_strategy: 'heuristic'`, `artifact_paths` 비어있지 않음 |
| **S2** | `pnpm --filter @openhive/web test -- microcompact` | 9 cases (A–I) green |
| **S2 integration** | `OPENHIVE_MICROCOMPACT_STALE_MS=1000` + MCP fetch + 2초 wait + 후속 turn → `events.jsonl \| grep microcompact.applied` | mcp tool_result 1건 비워짐, `delegate_to`/`ask_user` 무변화 |
| **S3** | `pnpm --filter @openhive/web test -- fork` | unit (buildForkedMessages, isInForkChild, mergeAdjacentUsers) green |
| **S3 e2e** | mock claude.streamMessages, lead → writer×5 fanout | 5 자식의 system/tools/prefix SHA256 동일 (단 마지막 user message 제외) |
| **S3 measured** (수동) | `OPENHIVE_FORK_DISABLE=0` vs `=1` baseline | 자식 4명 이상 `cache_read_input_tokens / input_tokens >= 0.70` |
| **S4** | `pnpm --filter @openhive/web test -- ledger` | unit (db, ulid, write, read) green |
| **S4 perf** | 100 entry seed + `searchLedger({query: 'foo'})` | < 50ms |
| **S4 integration** | 3-step delegation → DB row count | 정확히 3, body file 3 개 존재 |
| **A2** | `pnpm --filter @openhive/web test -- hooks` | unit (runner, matcher, config) + integration (block path) green |
| **A2 zero-overhead** | config 없는 상태 100 tool calls | `spawn` spy 호출 0회 |
| **A2 manual** | mock `sql-guard.sh` exit 2 → SQL tool 호출 | LLM 다음 turn history 에 `[Tool sql_exec blocked by hook. Reason: ...]` 메시지 포함 |
| **A3** | `pnpm --filter @openhive/web test -- artifacts` | 11 cases (A–K) green; traversal/outside_root/cross-session/binary 모두 denied |
| **A3 integration** | `read_artifact({path: "../../oauth.enc.json"})` | `{ok:false, error:'denied: traversal'}` + `artifact.read.denied` event |
| **A4** | `pnpm --filter @openhive/web test -- contextWindow tokens` | unit cases all green; `effectiveWindow('claude-code', 'claude-opus-4-7[1m]').window === 980_000` |
| **A4 drift** | manual smoke (Claude Opus 1000-token msg) | `\|actual - estimated\| / actual < 0.25` |
| **글로벌** | `pnpm --filter @openhive/web test` | 기존 suite regression 0 |
| **글로벌** | `biome check` | clean |
| **글로벌** | dev 서버 `--host 127.0.0.1` 정상 기동, 30분 idle 후 `/api/health` 200 | 메모리 leak 없음 (sessions GC 작동) |

---

## 7. 환경 변수 SSoT

본 라운드에서 추가되는 모든 env 변수 (CLAUDE.md "Tech Stack" 섹션에 일괄 등재):

| Env | Default | Spec | 의미 |
|---|---|---|---|
| `OPENHIVE_RESULT_SUMMARY_STRATEGY` | `heuristic` | S1 | `heuristic` \| `llm` \| `off` |
| `OPENHIVE_RESULT_MAX_CHARS` | `100000` | S1 | child output cap (chars) |
| `OPENHIVE_RESULT_SUMMARY_MODEL` | (unset) | S1 | `provider:model` for `llm` strategy |
| `OPENHIVE_MICROCOMPACT_STALE_MS` | `300000` (5분) | S2 | stale 판정 임계 |
| `OPENHIVE_MICROCOMPACT_DISABLED` | `0` | S2 | `1` = 완전 비활성 |
| `OPENHIVE_MICROCOMPACT_MIN_CHARS` | `200` | S2 | 이 미만 content 는 skip |
| `OPENHIVE_FORK_DISABLE` | `0` | S3 | `1` = parallel fork 비활성 |
| `OPENHIVE_LEDGER_DISABLED` | `0` | S4 | `1` = ledger write/read no-op |
| `OPENHIVE_LEDGER_SUMMARY` | `heuristic` | S4 | `heuristic` only (llm stub) |
| `OPENHIVE_LEDGER_ERRORS` | `1` | S4 | `0` = errored entry skip |
| `OPENHIVE_TOOL_PARALLEL_MAX` | `10` | A1 | safe_parallel bucket cap |
| `OPENHIVE_TOOL_PARTITION_V2` | `1` | A1 | Phase 1 에선 `1` 활성, Phase 2 에서 제거 |
| `OPENHIVE_TOKEN_PAD_FACTOR` | `1.333` | A4 | char→token pad |
| `OPENHIVE_AUTOCOMPACT_BUFFER` | `13000` | A4 | effective window 버퍼 |
| `OPENHIVE_BLOCKING_BUFFER` | `3000` | A4 | turn 차단 버퍼 |
| `OPENHIVE_WARNING_BUFFER` | `20000` | A4 | UI 경고 버퍼 |
| `OPENHIVE_BLOCK_ON_OVERFLOW` | `0` | A4 | `1` = `shouldBlockTurn` true 시 throw |
| `OPENHIVE_ARTIFACT_READ_MAX_CHARS` | `50000` | A3 | text-mode read cap |
| `OPENHIVE_DEBUG_RESULT_CAP` | `0` | S1 | `1` = console.log per cap |

---

## 8. i18n 키 (en + ko 동시 추가)

`apps/web/lib/i18n.ts` 의 `en` + `ko` 사전에 본 라운드 일괄 추가. 한국어는 직역체 금지.

| 키 | en | ko |
|---|---|---|
| `timeline.delegation.truncated` | `Output capped ({original} chars → summary)` | `출력 잘림 ({original}자 → 요약)` |
| `timeline.delegation.summaryStrategy` | `Summary: {strategy}` | `요약 방식: {strategy}` |
| `timeline.delegation.artifactCount` | `{count} artifact(s) preserved` | `아티팩트 {count}개 보존됨` |

S2/S3/S4/A1/A2/A3/A4 는 본 라운드에서 사용자 노출 UI 변경 없음 → 새 키 없음. (LLM-facing 도구 description 은 영어 유지, 번역 대상 아님.)

후속 UI 작업 (Run 캔버스의 fork 배지, ledger 검색 패널, hook 설정 GUI) 시점에 그쪽 plan 에서 키 추가.

---

## 9. CLAUDE.md 업데이트 snippet (Phase D 일괄 적용)

기존 "Architectural Rules" 섹션 끝에 다음 8 줄 추가:

```
- **Sub-agent 결과 cap**: `delegation_closed.data.result` 는 `OPENHIVE_RESULT_MAX_CHARS` (기본 100_000자) 로 잘림. 초과 시 heuristic / llm 전략으로 요약 + `artifact_paths` 별도 보존. (S1)
- **Microcompact**: Lead 의 `externalHistory` 에서 마지막 assistant 후 `OPENHIVE_MICROCOMPACT_STALE_MS` (기본 5분) 경과 시 read-only tool_result 본문을 in-place 비움. trajectory 도구 (delegate / ask_user / todo / sql_exec / activate_skill) 는 절대 보존. (S2)
- **Parallel fork (Claude only)**: `delegate_parallel` 자식들은 부모 turn 의 system+tools+history-prefix 를 byte-identical 로 inherit, Anthropic prompt cache 재사용. provider 가 다르면 자동으로 fresh path. (S3)
- **Work ledger**: `~/.openhive/companies/{c}/ledger/index.db` (FTS5) + `entries/{yyyy}/{mm}/{ulid}.md`. depth ≥ 1 의 모든 `delegation_closed` 가 entry 적재. Lead 만 `search_history`/`read_history_entry` 도구. (S4)
- **Tool partition v2**: 한 turn 의 tool_calls 를 trajectory / serial_write / safe_parallel 3-class. safe_parallel 은 `OPENHIVE_TOOL_PARALLEL_MAX` (기본 10) 로 cap, 초과 시 sequential bucket 분할. (A1)
- **Hooks**: `~/.openhive/config.yaml#hooks` 에 SessionStart/PreToolUse/Stop 셸 hook 등록 가능. exit 2 또는 stdout `{decision:'block'}` 로 tool 차단. spawn 비용 인지하고 `*` matcher 사용. (A2)
- **Artifact rehydration**: 산출물은 `artifact://session/{id}/artifacts/{rel}` URI. `read_artifact` 도구로 텍스트 본문 (`OPENHIVE_ARTIFACT_READ_MAX_CHARS` 기본 50_000자) 또는 메타 회수. path traversal / cross-session 거부. (A3)
- **Token math**: `effectiveWindow(provider, model)` 가 모든 압축/차단 임계값의 SSoT. char 기반 추정 + 권위 input_tokens 결합. drift > 25% 면 `token.estimate.drift` 이벤트. (A4)
```

env 표 추가는 §7 그대로.

---

## 10. 일정 (러프)

- Phase A (병렬): 2-3일 — A4 + S4 동시
- Phase B (직렬): 4-6일 — A1 → S1 → S3 → S2
- Phase C (병렬): 3-5일 — A2 + A3 동시
- Phase D (통합 + 검증): 1-2일 — 이벤트 union 등록 + CLAUDE.md + acceptance suite

총 10–16일 (1 sprint).

---

## 11. 참조

- 각 spec 파일 상단 "ADDENDUM (lock-in, 2026-04-22)" 섹션이 본 문서의 결정을 반영.
- `context.md` 는 배경/디제스트, 본 문서가 권위.
- Claude Code 출처: `docs/reference/claude-code/` 의 `agents.md`, `tools/AgentTool/`, `services/compact/microCompact.ts`, `utils/tokens.ts`, `services/compact/autoCompact.ts`.
