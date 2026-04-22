# Hooks MVP — Claude Code 스타일 lifecycle hook

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **finalizeSession 단일 호출 (택일 A 확정).** `runTeamBody` finally(`session.ts:421` 부근)에서 직접 `finalizeSession()` 호출 → Stop hook fire. `run-registry` 의 기존 호출은 `finalizeSession` 내부에 idempotent guard (`meta.finalized_at` 확인) 추가로 noop. 가드 구현 위치: `apps/web/lib/server/sessions.ts` 의 `finalizeSession` (line 231 부근).
> 2. **Hook fire 위치 (line 확정, plan §1):**
>    - SessionStart: `session.ts:383` `'run_started'` emit **직전** (resume 분기 통과 후, fresh 세션만).
>    - PreToolUse: `session.ts:731` `'tool_called'` emit **직후**, `tools.find` 직전.
>    - Stop: `session.ts:421` `inboxState().queues.delete` **직전 finally** (`finalizeSession` 호출 직후).
> 3. **`runHooks` outcome 에 `events: Event[]` 필드 포함** (caller 가 `for (const e of outcome.events) yield e`). Generator 안에서 spawn callback 으로 yield 못 하는 문제 회피 — spec §Patch 2 의 "어색함" 결정 확정.
> 4. **`OPENHIVE_HOOKS_DISABLED=1` env kill switch 추가** (spec 미포함이지만 plan SSoT 에 추가). config 파싱조차 skip → 0-overhead.
> 5. **`companyIdFromTeam` 헬퍼**: `teamSlugs` (`state().teamSlugs.get(sessionId)?.[0]`) 또는 SessionStart 시점 hook 호출 인자에 `companySlug` 를 명시 forward (이 시점에 `teamSlugs` 가 set 됐는지 확인 — `session-registry.start()` 가 inbox 등록 시 set 한다면 안전). 구현 시 grep 으로 set 시점 재확인.

---


**Goal:** OpenHive 엔진에 사용자-구성형 lifecycle hook 시스템을 도입한다. 외부 셸 스크립트가 세션의 핵심 시점에 끼어들어 (1) 위험한 tool call 을 차단하고 (2) 세션 결과를 외부 시스템(Slack/Notion 등) 에 푸시하고 (3) SessionStart 시점에 컨텍스트를 주입할 수 있게 한다.

**Why:** 현재 OpenHive 는 사용자가 엔진 동작에 끼어들 수 있는 공식 확장점이 0개다. MCP 서버는 "툴 추가" 만 가능하고, "이미 정의된 툴 호출을 가로채거나 차단하는" 면이 없다. 또 세션 종료 시 외부 통보를 하려면 코드 패치 외에 방법이 없다. Claude Code 가 검증한 hook 모델 (event 매칭 + stdin JSON payload + exit code 시맨틱 + stdout JSON 컨트롤) 을 그대로 차용해서, 한 번에 24개 이벤트를 다 펼치지 않고 **MVP 3개만 (SessionStart, PreToolUse, Stop)** 깔아 학습/안정화 단계를 가진다.

**Scope (MVP 한정):**
- 이벤트 3종: `SessionStart`, `PreToolUse`, `Stop`.
- 설정 파일: 기존 `~/.openhive/config.yaml` 확장.
- 실행 모델: `child_process.spawn`, stdin 으로 JSON payload, stdout/stderr 캡처, exit code 로 control flow.
- 관측: 모든 hook 호출은 `events.jsonl` 에 `hook.invoked` 이벤트로 기록.

**Out of scope (이번 plan 에선 절대 만들지 말 것):**
- 나머지 21개 Claude Code 이벤트 (`PostToolUse`, `UserPromptSubmit`, `SubagentStop`, `Notification`, `PreCompact`, `SessionEnd`, …) — Phase 4+ 로 미룸.
- Hook 설정 GUI. CLI 편집 only.
- Async hook (Claude Code 의 `async: true`) — MVP 는 동기 only.
- Hook script 의 sandboxing. 보안 모델은 "사용자가 직접 작성한 신뢰된 로컬 자동화" — 격리 안 함, README 에 명시.
- Per-team hook config. Global (`~/.openhive/config.yaml`) only — per-team 은 V2.

---

## Reference: Claude Code hook 시맨틱 (그대로 차용)

OpenHive 의 hook 동작은 Claude Code 의 공개된 hook 시스템 (출처: `codeaashu/claude-code` 유출본 + `seilk/claude-code-docs`) 을 따른다. 새로 발명하지 말 것 — 사용자가 이미 익숙한 모델이고, 우리가 깨야 할 이유가 없다.

### 설정 형태 (Claude Code)

```jsonc
{
  "hooks": {
    "EventName": [
      {
        "matcher": "tool_name|source|trigger|glob",
        "hooks": [
          { "type": "command", "command": "/path/to/script.sh", "timeout": 60 }
        ]
      }
    ]
  }
}
```

OpenHive 는 YAML 사용 (기존 `config.yaml` 과 동질) + 한 단계 평탄화 (`hooks` 배열 안에 또 `hooks` 배열을 두는 Claude Code 의 nested 구조는 MVP 에서 단순화).

### Exit code 컨트랙트

| Exit code | 의미 | stdout | stderr |
|---|---|---|---|
| `0` | OK | JSON 으로 파싱 시도, control field 적용 | (무시) |
| `2` | BLOCK | (무시) | LLM 에 system message 로 주입 |
| 기타 | non-fatal 에러 | (무시) | 사용자 로그에만 출력, 실행은 계속 |

### Sync hook stdout JSON 스키마 (`exit 0` 일 때만 파싱)

```ts
interface HookStdoutPayload {
  continue?: boolean              // false → 후속 hook 체인 중단
  decision?: 'approve' | 'block'  // PreToolUse 전용
  reason?: string                 // decision 사유
  systemMessage?: string          // synthetic system turn 으로 주입
  additionalContext?: string      // SessionStart 전용 — Lead system prompt 에 append
  suppressOutput?: boolean        // stdout 을 사용자 로그에서 숨김
  hookSpecificOutput?: Record<string, unknown>  // forward-compat, 무시 가능
}
```

stdout 이 비었거나 JSON 파싱 실패 시 → 빈 객체로 취급하고 정상 진행. **hook script 는 JSON 출력을 강제당하지 않는다** — 단순한 "통보용" hook 은 그냥 `exit 0` 만 하면 됨.

### 환경변수 (hook 프로세스에 전달)

`CLAUDE_PROJECT_DIR` 대신 `OPENHIVE_DATA_DIR` (≈ `~/.openhive`) 를 표준 변수로 export. 추가로:

- `OPENHIVE_SESSION_ID`
- `OPENHIVE_COMPANY_ID` / `OPENHIVE_TEAM_ID`
- `OPENHIVE_HOOK_EVENT` (`SessionStart` | `PreToolUse` | `Stop`)
- `OPENHIVE_TRANSCRIPT_PATH` (`~/.openhive/sessions/{id}/transcript.jsonl`)

stdin 으로 들어오는 JSON 안에도 같은 값들이 들어가지만, 짧은 셸 스크립트가 `jq` 없이 빠르게 분기하려면 env 가 더 편하다.

---

## OpenHive 통합 지점 (코드 위치 확정)

세 hook 의 호출 시점은 엔진의 다음 라인에 정확히 매핑된다.

### SessionStart

**파일:** `apps/web/lib/server/engine/session.ts`
- `runTeam` 진입: L328 `export async function* runTeam(...)`.
- 실제 첫 이벤트가 emit 되기 직전: L383 `yield makeEvent('run_started', sessionId, ...)` **바로 앞**.
- 단, `opts.resume?.sessionId` 가 있는 경우 (= follow-up turn) 는 **호출하지 않음**. SessionStart 는 새 세션 시작에만.
- payload 에 `goal` (= L330 인자), `team_snapshot` (= `team` 인자 그대로), `company_id` / `team_id` 추출.

**왜 L383 직전인가:** `run_started` 이벤트가 events.jsonl 에 기록되기 전이라야 hook 이 반환한 `additionalContext` 를 system prompt 에 합쳐 첫 LLM call 에 반영할 수 있다. L383 이후로 미루면 첫 turn 이 이미 시작된 뒤가 됨.

### PreToolUse

**파일:** `apps/web/lib/server/engine/session.ts`
- 위치: `executeOne` 클로저 (L721) 안, `tool_called` 이벤트 emit (L730–735) **바로 다음**, 실제 `tool.handler(parsedArgs)` 또는 delegation/skill 분기 (L746–815) **바로 앞**.
- payload 에 `tool_name` (= `tc.function.name`), `tool_input` (= `parsedArgs`), `agent_id` (= `node.id`), `depth`, `tool_call_id` (= `tc.id`) 추출.

**block 처리:** hook 이 `decision: 'block'` 또는 `exit 2` 를 반환하면, `executeOne` 은 실제 핸들러를 호출하지 않고 즉시:

```ts
const blockMsg = `[Tool ${tc.function.name} blocked by hook. Reason: ${reason ?? 'unspecified'}.${systemMessage ? ` ${systemMessage}` : ''}]`
yield makeEvent('tool_result', sessionId, { content: blockMsg, is_error: true },
  { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name })
return { content: blockMsg, isError: true }
```

이렇게 합성된 tool_result 가 history 에 들어가서 다음 LLM turn 이 자연스럽게 "내가 호출하려던 툴이 차단됐구나" 를 인지한다. 별도 채널로 알릴 필요 없음 — 엔진의 모든 control 은 events 와 history 를 거친다는 원칙 (CLAUDE.md "Architectural Rules") 을 그대로 지킨다.

### Stop

**파일:** `apps/web/lib/server/engine/session.ts` + `apps/web/lib/server/sessions.ts`

세션 종료에 두 경로가 있다:
1. **정상 종료** — `runTeamBody` 의 `inbox.pop()` 이 `null` 을 반환해서 while 루프 break → L416 `yield makeEvent('run_finished', sessionId, ...)`.
2. **에러 종료** — L419 `yield makeEvent('run_error', sessionId, { error: message })`.

Stop hook 은 두 경우 모두 호출. 호출 시점은 두 emit 직후, `finally` 블록 (L420 `inboxState().queues.delete`) **이전**. 이래야 hook 이 events.jsonl 의 마지막 seq 를 정확히 읽을 수 있다.

또한 `apps/web/lib/server/sessions.ts` L231 `finalizeSession` 이 transcript.jsonl 을 쓴 뒤 L260–267 의 `writeMeta` 직전에도 fire 가능하지만 — **MVP 는 한 번만** 호출. `runTeamBody` 의 finally 진입 직전에 finalizeSession 을 명시 호출하고 그 직후 Stop hook 을 fire 하는 순서로 단일화 (= transcript / usage 가 다 정착된 시점).

payload 에 `status` (= `'completed' | 'error' | 'idle'`, finalizeSession 이 결정), `duration_ms` (= `Date.now() - meta.started_at`), `artifact_paths` (= `sessionArtifactDir` 의 listdir), `last_event_seq` (= events.jsonl 마지막 줄의 `seq`).

**Note: turn_finished (L409) 에는 hook 을 걸지 않는다.** Stop = 세션 자체의 종료. Claude Code 의 `Stop` 도 마찬가지로 turn 단위 아님.

---

## Config 위치 + 스키마

### 파일

`~/.openhive/config.yaml` — 이미 `globalConfigPath()` (`apps/web/lib/server/paths.ts:65-67`) 로 정의돼 있음. 현재 코드베이스에서 이 파일을 읽는 로더가 **없다** (grep 결과: 경로 문자열만 존재). 새로 만들어야 함.

### 스키마

```yaml
# ~/.openhive/config.yaml
hooks:
  SessionStart:
    - matcher: "*"                        # company_id glob
      command: "/Users/me/scripts/inject-context.sh"
      timeout: 30
  PreToolUse:
    - matcher: "sql_exec"                 # exact tool name
      command: "/Users/me/scripts/sql-guard.sh"
      timeout: 10
    - matcher: "mcp__*__write*"           # glob
      command: "/Users/me/scripts/mcp-write-guard.sh"
      timeout: 10
    - matcher: "*"                        # 모든 툴에 대한 audit log
      command: "/Users/me/scripts/audit.sh"
      timeout: 5
  Stop:
    - matcher: "acme"                     # company_id == 'acme' 일 때만
      command: "/Users/me/scripts/notify-slack.sh"
      timeout: 60
```

### Matcher 시맨틱

- **PreToolUse**: glob 은 tool name 대상. `*` = 모든 툴. `sql_*` = `sql_` 접두 툴. `mcp__brave__*` = brave MCP 서버의 모든 툴. `delegate_to` = exact.
  - 매칭 라이브러리: Node 내장 없음 → 직접 6줄 글로브 (escape regex + `*` → `.*` + `?` → `.`). 새 dep 금지 (CLAUDE.md).
- **SessionStart / Stop**: glob 은 `company_id` 대상. `*` = 모든 컴퍼니. 빈 company (= ad-hoc 세션) 는 `""` 로 매칭.
- 같은 이벤트에 여러 hook 이 매칭되면 **선언 순서대로 직렬 실행**. 한 hook 이 `continue: false` 를 반환하면 그 자리에서 체인 중단.

### Validation

config 로드 시:
- 알 수 없는 이벤트 이름 → 경고 로그, 스킵 (forward-compat).
- `command` 가 절대 경로 아니면 → 경고 + 스킵 (`$PATH` 의존하면 dev/prod 차이 버그 잦음).
- `command` 가 실행권한 없으면 → 경고 + 스킵 (`fs.accessSync(cmd, fs.constants.X_OK)`).
- `timeout` 누락 → 이벤트별 default 적용 (아래 표).

| Event | Default timeout |
|---|---|
| SessionStart | 30000 ms |
| PreToolUse | 10000 ms (latency 직격) |
| Stop | 60000 ms (네트워크 호출 가능) |

---

## Stdin payload 스키마 (hook script 가 받는 것)

모든 이벤트 공통 필드:

```ts
interface CommonHookPayload {
  hook_event_name: 'SessionStart' | 'PreToolUse' | 'Stop'
  session_id: string
  transcript_path: string         // ~/.openhive/sessions/{id}/transcript.jsonl
  cwd: string                     // process.cwd()
  company_id: string | null
  team_id: string
  data_dir: string                // ~/.openhive
}
```

### SessionStart

```ts
interface SessionStartPayload extends CommonHookPayload {
  hook_event_name: 'SessionStart'
  goal: string
  team_snapshot: TeamSpec         // L383 의 team 인자 그대로 (직렬화)
  source: 'fresh' | 'resume'      // resume 일 땐 호출 안 하지만 forward-compat
}
```

### PreToolUse

```ts
interface PreToolUsePayload extends CommonHookPayload {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  agent_id: string                // node.id
  depth: number
  tool_call_id: string
}
```

### Stop

```ts
interface StopPayload extends CommonHookPayload {
  hook_event_name: 'Stop'
  status: 'completed' | 'error' | 'idle'
  duration_ms: number
  artifact_paths: string[]        // 절대경로
  last_event_seq: number
  output: string | null           // 마지막 turn 의 final output
  error: string | null
}
```

---

## additionalContext 주입 (SessionStart 전용)

hook 이 stdout JSON 의 `additionalContext: "..."` 를 반환하면, 그 텍스트를 **Lead 의 system prompt 끝에 별도 system block 으로 append** 한다.

구현 위치: `apps/web/lib/server/engine/session.ts` L590 `buildSystemPrompt(rounds)` 호출부 — 현재는 텍스트 한 줄을 prompt 로 주지만, runTeam 단계에서 받은 additionalContext 를 클로저로 잡아서 buildSystemPrompt 결과 뒤에 `\n\n---\n\n[Injected by SessionStart hook]\n${additionalContext}` 를 합친다.

전달 경로: `runTeam` → `runTeamBody` → `runNode` → `streamTurn` 까지 옵션을 흘려야 하므로, opts 에 `injectedSystemSuffix?: string` 필드 추가. depth 0 의 첫 turn 에만 적용 (sub-agent 노드는 영향 없음 — Lead 컨텍스트만 주입).

### Cap

- `additionalContext.length > 8192` (8KB) 이면 **잘라내고 경고 로그**: `hook ${cmd} returned additionalContext > 8KB, truncated to 8192 chars`.
- 8KB 가 적정한 이유: 현재 시스템 프롬프트 평균 ~2-4KB. 8KB 추가 = LLM input 의 ~5-10% 증가 — 의미 있는 컨텍스트는 들어가지만 토큰 폭발은 막는다.
- truncate 는 byte 가 아닌 **char count**. UTF-8 boundary 깨질 일 없음.

여러 SessionStart hook 이 다 additionalContext 를 반환하면 **선언 순서대로 줄바꿈 두 번으로 join**. 합산 길이도 8KB cap.

---

## systemMessage 주입 (PreToolUse block 전용)

PreToolUse hook 이 `decision: 'block'` 또는 `exit 2` 를 반환할 때:
- `reason` (stdout JSON) 또는 stderr 텍스트 (`exit 2`) 를 cap 2KB 로 자르고
- `tool_result` 이벤트의 `content` 에 합성 메시지로 박는다 (위 PreToolUse 섹션의 `blockMsg` 코드 참조).

이 메시지가 LLM 의 다음 turn input 에 자연스럽게 들어가서 — 별도 system turn 추가 없이 — Lead 가 "어, 이 툴 못 쓰는구나, 다른 방법 찾아야겠다" 로 분기한다.

`exit 0 + decision: 'approve'` 는 명시적 통과 (= 다음 매칭 hook 도 실행하되, 한 hook 이 approve 하면 같은 tool 의 다른 PreToolUse hook 의 block 결정도 우선순위 동일하게 직렬로 본다 — 마지막 결정이 이김. Claude Code 와 동일).

---

## Module layout

신규 디렉터리: `apps/web/lib/server/hooks/`

```
apps/web/lib/server/hooks/
  index.ts          # public API: runHooks(event, payload) → Promise<HookOutcome>
  config.ts         # loadHookConfig() — yaml 파싱 + validation + mtime watch
  runner.ts         # spawn + stdin write + timeout + parse stdout
  matcher.ts        # globToRegex + matchHooks(event, target, hooks)
  types.ts          # HookConfig, HookOutcome, *Payload 타입
```

### `index.ts` 시그니처

```ts
export interface HookOutcome {
  invoked: number                  // 실제 실행된 hook 개수
  decision: 'approve' | 'block' | null
  reason: string | null
  systemMessage: string | null
  additionalContext: string | null
  continueChain: boolean
}

export async function runHooks(
  event: 'SessionStart' | 'PreToolUse' | 'Stop',
  matchTarget: string,             // PreToolUse: tool_name. Others: company_id
  payload: unknown,                // serialized to stdin as JSON
  emitEvent?: (name: string, data: Record<string, unknown>) => void,
): Promise<HookOutcome>
```

`emitEvent` 가 있으면 매 hook invocation 후 `hook.invoked` 이벤트 emit (관측성 섹션 참조).

### `config.ts`

```ts
interface HookEntry { matcher: string; command: string; timeout: number }
interface HookConfig {
  SessionStart: HookEntry[]
  PreToolUse: HookEntry[]
  Stop: HookEntry[]
}

export function getHookConfig(): HookConfig
```

내부:
- 첫 호출 시 `globalConfigPath()` (= `~/.openhive/config.yaml`) 를 `js-yaml` 로 파싱. **`js-yaml` 은 이미 `apps/web/package.json` deps 에 있음** (확인됨: `"js-yaml": "^4.1.1"`) — 새 dep 추가 없음.
- 파일 없거나 `hooks:` key 없으면 `{ SessionStart: [], PreToolUse: [], Stop: [] }` 반환 (zero-config 0 오버헤드 path).
- 파싱 후 validation (위 Validation 섹션) → invalid entry 는 drop + warn.
- mtime cache. 매 `getHookConfig()` 호출마다 `fs.statSync(path).mtimeMs` 비교, 바뀌었으면 reparse. fs.watch 안 씀 (Vite HMR / 다중 fork 환경에서 누수 위험 — `fs.statSync` 1회 호출은 µs 단위라 문제없음).

### Globalthis singleton

```ts
const KEY = Symbol.for('openhive.hooks.configCache')
interface Cache { mtimeMs: number; config: HookConfig }
const g = globalThis as { [k: symbol]: Cache | undefined }

function getCache(): Cache | null { return g[KEY] ?? null }
function setCache(c: Cache): void { g[KEY] = c }
```

이유: Vite HMR / tsx watch 가 모듈을 재로딩할 때 module-local `let` 은 매번 리셋된다 → `globalThis` 에 박아야 한 번만 파싱됨. CLAUDE.md "Long-lived state … `globalThis` 에" 규칙 준수. 기존 패턴: `apps/web/lib/server/mcp/manager.ts:41 Symbol.for('openhive.mcp.manager')`, `apps/web/lib/server/scheduler/scheduler.ts:284 Symbol.for('openhive.scheduler')` 와 동일 컨벤션.

### `runner.ts`

```ts
import { spawn } from 'node:child_process'

export async function runOne(entry: HookEntry, payload: unknown):
  Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }>
```

핵심 흐름:
1. `const ac = new AbortController()`
2. `const child = spawn(entry.command, [], { stdio: ['pipe', 'pipe', 'pipe'], signal: ac.signal, env: { ...process.env, OPENHIVE_DATA_DIR: dataDir(), OPENHIVE_HOOK_EVENT: ..., ... } })`
3. `child.stdin.end(JSON.stringify(payload))`
4. `setTimeout(() => ac.abort(), entry.timeout)` — abort → SIGTERM. 추가로 abort 후 2초 안에 안 죽으면 `child.kill('SIGKILL')`.
5. stdout/stderr 를 chunk 누적 (각각 1MB cap — 그 이상은 truncate + warn).
6. `'exit'` 이벤트로 resolve.

### `index.ts` 의 `runHooks` 본체

```ts
export async function runHooks(event, matchTarget, payload, emitEvent?) {
  const cfg = getHookConfig()
  const entries = matchHooks(event, matchTarget, cfg[event])
  const outcome: HookOutcome = {
    invoked: 0, decision: null, reason: null,
    systemMessage: null, additionalContext: null, continueChain: true,
  }
  const additionalContextBuf: string[] = []

  for (const entry of entries) {
    const t0 = performance.now()
    const res = await runOne(entry, payload)
    outcome.invoked++

    let parsed: HookStdoutPayload = {}
    if (res.exitCode === 0 && res.stdout.trim()) {
      try { parsed = JSON.parse(res.stdout) } catch { /* swallow */ }
    }

    let decisionThisHook: 'approve' | 'block' | null = null
    if (res.exitCode === 2) {
      decisionThisHook = 'block'
      outcome.reason = res.stderr.slice(0, 2048).trim() || null
    } else if (res.exitCode === 0 && parsed.decision) {
      decisionThisHook = parsed.decision
      outcome.reason = parsed.reason ?? outcome.reason
    } else if (res.exitCode !== 0) {
      console.warn(`[hooks] ${entry.command} exit ${res.exitCode}: ${res.stderr.slice(0, 256)}`)
    }

    if (decisionThisHook) outcome.decision = decisionThisHook
    if (parsed.systemMessage) outcome.systemMessage = parsed.systemMessage
    if (parsed.additionalContext) additionalContextBuf.push(parsed.additionalContext)
    if (parsed.continue === false) outcome.continueChain = false

    emitEvent?.('hook.invoked', {
      event_name: event,
      matcher: entry.matcher,
      command: entry.command,
      exit_code: res.exitCode,
      duration_ms: Math.round(performance.now() - t0),
      timed_out: res.timedOut,
      decision: decisionThisHook,
    })

    if (!outcome.continueChain) break
  }

  if (additionalContextBuf.length > 0) {
    let merged = additionalContextBuf.join('\n\n')
    if (merged.length > 8192) {
      console.warn(`[hooks] additionalContext > 8KB, truncating`)
      merged = merged.slice(0, 8192)
    }
    outcome.additionalContext = merged
  }

  return outcome
}
```

---

## Engine 통합 — 정확한 패치 위치

### Patch 1: `apps/web/lib/server/engine/session.ts` SessionStart

L382 직전 (resume 분기 통과, fresh 세션 확정 후, run_started emit 직전):

```ts
} else {
  // [HOOK] SessionStart — only on fresh start, before any event hits jsonl.
  let injectedSuffix: string | undefined
  try {
    const outcome = await runHooks('SessionStart', companyIdFromTeam(team) ?? '', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      transcript_path: sessionTranscriptPath(sessionId),
      cwd: process.cwd(),
      company_id: companyIdFromTeam(team),
      team_id: team.id,
      data_dir: dataDir(),
      goal,
      team_snapshot: team,
      source: 'fresh',
    }, (name, data) => yield makeEvent(name, sessionId, data))
    injectedSuffix = outcome.additionalContext ?? undefined
  } catch (exc) {
    console.warn('[hooks] SessionStart failed:', exc)
  }
  yield makeEvent('run_started', sessionId, { team_id: team.id, goal })
  // injectedSuffix 를 runNode opts 로 흘려보냄 (아래 변경 참조)
}
```

`runNode` 호출부 (L395) 에 `injectedSystemSuffix: injectedSuffix` 추가. `runNode` → `streamTurn` 으로 한 번 더 forward. `streamTurn` 의 L590 `buildSystemPrompt(rounds)` 결과 뒤에 suffix concat.

### Patch 2: `apps/web/lib/server/engine/session.ts` PreToolUse

L735 (`tool_called` emit 직후) ~ L737 (`tools.find` 직전) 사이:

```ts
yield makeEvent('tool_called', sessionId, ...)

// [HOOK] PreToolUse
const hookOutcome = await runHooks('PreToolUse', tc.function.name, {
  hook_event_name: 'PreToolUse',
  session_id: sessionId,
  transcript_path: sessionTranscriptPath(sessionId),
  cwd: process.cwd(),
  company_id: state().teamSlugs.get(sessionId)?.[0] ?? null,
  team_id: team.id,
  data_dir: dataDir(),
  tool_name: tc.function.name,
  tool_input: parsedArgs,
  agent_id: node.id,
  depth,
  tool_call_id: tc.id,
}, (name, data) => { /* push hook.invoked event into outer stream — see note */ })

if (hookOutcome.decision === 'block') {
  const reason = hookOutcome.reason ?? 'unspecified'
  const sysMsg = hookOutcome.systemMessage ? ` ${hookOutcome.systemMessage}` : ''
  const blockMsg = `[Tool ${tc.function.name} blocked by hook. Reason: ${reason}.${sysMsg}]`
  yield makeEvent('tool_result', sessionId,
    { content: blockMsg, is_error: true },
    { depth, node_id: node.id, tool_call_id: tc.id, tool_name: tc.function.name })
  return { content: blockMsg, isError: true }
}

const tool = tools.find((t) => t.name === tc.function.name)
// ... 기존 로직 계속
```

**`emitEvent` 콜백의 yield 어색함:** `runHooks` 가 generator 가 아니라 Promise 라서 콜백으로 받은 `hook.invoked` 를 outer generator 로 yield 해야 한다. 가장 깔끔한 방법: `runHooks` 가 events 를 모은 배열을 outcome 에 같이 반환 (`outcome.events: Event[]`), 호출부에서 `for (const e of outcome.events) yield e`. → 이렇게 가자.

### Patch 3: `apps/web/lib/server/engine/session.ts` Stop

L416 직후 (`run_finished` emit 직후) 와 L419 직후 (`run_error` emit 직후) 두 군데. DRY 위해 try/finally 의 finally 에서 single-shot:

```ts
async function* runTeamBody(team, goal, sessionId, resumeHistory) {
  // ... 기존 로직 ...
  let stopStatus: 'completed' | 'error' | 'idle' = 'idle'
  let stopOutput: string | null = null
  let stopError: string | null = null
  try {
    while (true) { /* ... */ }
    yield makeEvent('run_finished', sessionId, { output: lastFinal })
    stopStatus = 'completed'
    stopOutput = lastFinal
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)
    yield makeEvent('run_error', sessionId, { error: message })
    stopStatus = 'error'
    stopError = message
  } finally {
    inboxState().queues.delete(sessionId)
    // [HOOK] Stop — fire after finalizeSession so transcript is on disk.
    try {
      await finalizeSession(sessionId, { output: stopOutput, error: stopError })
      const outcome = await runHooks('Stop', companyIdFromTeam(team) ?? '', buildStopPayload(...))
      for (const e of outcome.events) yield e
    } catch (exc) {
      console.warn('[hooks] Stop failed:', exc)
    }
  }
}
```

**중요:** `finalizeSession` 은 현재 `runTeamBody` 가 직접 부르지 않음 — `run-registry` 가 generator 종료 후 부른다. Stop hook 이 transcript 가 쓰인 후에 fire 되게 하려면 둘 중 하나:
1. (택일 A) `runTeamBody` 가 finalize 를 직접 호출 + registry 의 중복 호출 가드. **이 안 채택** — finalize 는 idempotent (`writeMeta(...)` 마지막 한 번 wins) 라 안전.
2. (택일 B) Stop hook 호출을 `run-registry` 의 generator 소비 루프 finally 로 옮김. Generator 깔끔성은 좋지만 "엔진은 events 만 흘린다" 원칙 깨짐.

**A 채택.** registry 는 finalizeSession 을 멱등적으로 한 번 더 부를 뿐, 같은 결과.

---

## Observability — `hook.invoked` event

매 hook 호출마다 events.jsonl 에 한 줄:

```jsonc
{
  "seq": 142,
  "ts": 1714000000000,
  "kind": "hook.invoked",
  "data": {
    "event_name": "PreToolUse",
    "matcher": "sql_*",
    "command": "/Users/me/scripts/sql-guard.sh",
    "exit_code": 2,
    "duration_ms": 87,
    "timed_out": false,
    "decision": "block"
  }
}
```

UI 통합 (이번 plan scope 아님, 후속): Run 캔버스의 timeline 탭에서 `hook.invoked` 를 별도 row 로 렌더 (작은 자물쇠 아이콘 + matcher 표시). MVP 는 events.jsonl 에 들어가는 것까지만 보장.

---

## Phases / 구현 순서

### Phase 1 — Config loader + runner + Stop (가장 안전)

**Why first:** Stop 은 LLM 흐름에 영향 없음. block 시맨틱도 없음. 실패해도 세션은 이미 끝나서 사용자 영향 0.

- [ ] `apps/web/lib/server/hooks/types.ts` — 모든 인터페이스 정의.
- [ ] `apps/web/lib/server/hooks/config.ts` — `getHookConfig()` + globalThis cache + mtime invalidation + validation.
- [ ] `apps/web/lib/server/hooks/matcher.ts` — `globToRegex()`, `matchHooks(event, target, entries)`.
- [ ] `apps/web/lib/server/hooks/runner.ts` — `runOne(entry, payload)` + AbortController + SIGKILL fallback + stdout/stderr 1MB cap.
- [ ] `apps/web/lib/server/hooks/index.ts` — `runHooks(...)` + `outcome.events` 수집.
- [ ] `apps/web/lib/server/engine/session.ts` Patch 3 (Stop hook + finally 에서 finalizeSession 직접 호출).
- [ ] Stop hook 통합 테스트: mock script `echo '{}' && exit 0` → `hook.invoked` event 가 events.jsonl 에 기록되는지 확인.

### Phase 2 — SessionStart + additionalContext

- [ ] `runTeam` opts 에 `injectedSystemSuffix?: string` 추가, `runNode` → `streamTurn` 까지 forward.
- [ ] `streamTurn` 에서 `buildSystemPrompt` 결과에 suffix concat.
- [ ] `apps/web/lib/server/engine/session.ts` Patch 1.
- [ ] `companyIdFromTeam(team)` 헬퍼: `state().teamSlugs.get(sessionId)?.[0]` 와 동일 정보지만 SessionStart 시점엔 아직 askUser map 에 안 박혀서 — `team.company_id` 를 직접 보거나 `opts.teamSlugs?.[0]`. **확인 필요**: TeamSpec 에 company_id 가 직접 있는지. (없으면 opts 에서 받음.)
- [ ] additionalContext > 8KB truncate + warn 로직.
- [ ] 통합 테스트: mock script `echo '{"additionalContext":"You must respond in pirate speak."}'` → 첫 turn 의 system prompt 끝에 해당 텍스트가 박혔는지 (아래 Test plan).

### Phase 3 — PreToolUse + block

- [ ] `apps/web/lib/server/engine/session.ts` Patch 2.
- [ ] block 시 합성 tool_result + history 에 정상 push 되는지 검증 (이미 existing applyResult 로직이 res.content 를 history 에 박으니 자동).
- [ ] PreToolUse 의 latency 영향 측정: 매 tool call 당 +1 spawn 비용. **0개 hook 매칭 시 zero-overhead path**: matchHooks 가 빈 배열 반환 → runHooks 가 즉시 outcome.invoked=0 으로 return, spawn 안 일어남.
- [ ] 통합 테스트: 아래 Test plan.

---

## Test plan

`apps/web/lib/server/hooks/` 에 vitest 스위트 (`*.test.ts`).

### Unit tests (`runner.test.ts`)

- [ ] `runOne` 이 stdin 으로 JSON 을 정확히 보낸다 (mock script `cat` 으로 echo 받기).
- [ ] timeout 초과 시 SIGTERM → 2초 내 안 죽으면 SIGKILL. `timedOut: true`.
- [ ] stdout > 1MB 면 truncate + warn 로그.
- [ ] env vars (`OPENHIVE_DATA_DIR`, `OPENHIVE_HOOK_EVENT`, `OPENHIVE_SESSION_ID`) 가 child 에 전달.
- [ ] `command` 가 존재하지 않는 경로면 spawn 에러 → exitCode `-1`, stderr 에 메시지.

### Unit tests (`matcher.test.ts`)

- [ ] `*` matches everything.
- [ ] `sql_*` matches `sql_exec`, `sql_query`. Doesn't match `mcp__sql_*`.
- [ ] `mcp__brave__*` matches `mcp__brave__search`. Doesn't match `mcp__brave_search` (double underscore boundary).
- [ ] Regex special char (`.`, `+`, `(`) 가 matcher 에 있어도 escape 됨.

### Unit tests (`config.test.ts`)

- [ ] config 파일 없으면 빈 config.
- [ ] mtime 안 바뀌면 cache hit (파싱 1번만).
- [ ] mtime 바뀌면 reparse.
- [ ] 절대경로 아닌 command → 경고 + drop.
- [ ] 알 수 없는 event 이름 → 경고 + drop, 다른 event 는 정상.

### Integration tests (`hooks-integration.test.ts`)

- [ ] **Block 경로:** mock PreToolUse hook script `printf '{"decision":"block","reason":"no sql allowed"}\n'` → 임의 SQL 툴 호출 시도 → tool_result event 의 content 가 `[Tool sql_exec blocked by hook. Reason: no sql allowed.]` → 다음 turn 의 history 에 동일 메시지 → LLM 이 본다 (mock provider 로 검증).
- [ ] **Exit 2 경로:** mock script `echo "blocked"; exit 2` (stderr 로) → `outcome.decision === 'block'`, `reason === 'blocked'`.
- [ ] **Timeout 경로:** mock script `sleep 30; exit 0`, timeout 100ms → `timedOut: true`, default 동작 (continue) 적용. 경고 로그.
- [ ] **SessionStart additionalContext:** mock script returns `{"additionalContext": "X".repeat(10000)}` → truncate to 8192 + warn → 첫 turn 의 system prompt 끝 8192 chars 포함.
- [ ] **Zero-config zero-overhead:** config 파일 없는 상태에서 100회 tool call → spawn 호출 0회 (`spawn` 을 spy 로 감싸 검증).
- [ ] **Stop fires once:** 정상 종료 / 에러 종료 각각 hook script 호출 정확히 1회.
- [ ] **Continue chain:** 두 SessionStart hook 등록, 첫 hook 이 `{"continue": false}` → 두 번째 hook 은 spawn 안 됨.

---

## 보안 / 책임 한계

**Hook script 는 사용자 셸 권한으로 그대로 실행된다.** Sandboxing 안 함. 이유:
- OpenHive 는 single-user, local-first, `127.0.0.1` 바인딩 (CLAUDE.md "인증 / 토폴로지"). Hook script 도 사용자 본인이 작성.
- Claude Code 도 동일 stance — README 에 "you are responsible for what your hooks do" 명시.

`README.md` 의 OAuth provider 섹션 옆에 한 줄 추가:

> **Hooks:** `~/.openhive/config.yaml` 의 `hooks` 항목은 임의 셸 명령을 OpenHive 프로세스 권한으로 실행한다. 직접 작성한 스크립트만 등록할 것. Untrusted 코드 등록 금지.

config 로드 시 추가 안전장치:
- command 가 `~/.openhive/` **밖** 인지 확인 (안에 있으면 OAuth 토큰 / encryption.key 와 같은 디렉터리 — 실수로 다운로드 받은 임의 스크립트가 거기 들어있으면 리스크). 단순 경고만 하고 실행은 허용 — false positive 가 더 짜증나는 시나리오 (예: 사용자가 `~/.openhive/scripts/` 를 의도적으로 만들 수 있음).

---

## i18n

이번 plan 은 백엔드 only. UI 변경 없음 — 그래서 i18n key 추가 0개. 후속 hook 설정 GUI 가 생기면 그때 `apps/web/lib/i18n.ts` 의 `en` + `ko` 양쪽에 키 추가 (CLAUDE.md i18n 규칙).

다만 **에러 로그 메시지** 는 영어 유지 (개발자가 보는 콘솔). 사용자 노출 면이 아님.

---

## 의존성 영향

- 새 npm 패키지: **0개**.
  - YAML 파싱: `js-yaml@^4.1.1` (이미 deps).
  - Glob → regex: 6줄 자체구현.
  - Spawn: `node:child_process`.
  - Timeout: `AbortController` (Node 20+ 내장).
- 새 globalThis singleton: 1개 (`Symbol.for('openhive.hooks.configCache')`).
- events.jsonl 신규 kind: `hook.invoked`. 기존 timeline 렌더러는 모르는 kind 를 그냥 pass-through 하니 UI 깨짐 없음 (확인 필요: `apps/web/components/run/Timeline.tsx` 의 default case).

---

## 리스크 / 주의

- **PreToolUse 매 tool call latency:** zero-config 일 때만 zero-overhead. 매칭되는 hook 이 1개라도 있으면 spawn fork 비용 (~5-30ms macOS, ~1-5ms Linux). 사용자가 `*` matcher 를 등록하면 모든 툴이 느려진다 — 문서에 "audit 용 `*` matcher 는 spawn 비용 인지하고 사용" 명시.
- **finalizeSession 두 번 호출:** runTeamBody finally + run-registry 둘 다 부르게 됨. 현재 finalize 는 멱등 (마지막 writeMeta 가 wins) 이라 기능적 문제 없지만, transcript.jsonl 이 두 번 작성됨 → 두 번째가 파일 truncate 후 같은 내용 재작성. **확인 필요:** 두 번째 호출 사이에 events.jsonl 에 `hook.invoked` 이벤트가 추가됐다면 두 번째 transcript 에는 그게 포함됨 — 의도된 동작. 무해.
- **SIGKILL 잔존 자식:** AbortController abort 후 SIGKILL fallback 까지 2초. 그 사이 OpenHive 프로세스가 죽으면 zombie 가능. Node default reap 으로 해소. 모니터링 필요.
- **company_id 추출:** SessionStart 시점에 `state().teamSlugs.get(sessionId)` 는 L350 에서 set 되니까 hook fire 시점 (L382 직전) 엔 이미 set 됨. 안전. 다만 ad-hoc 세션 (companies/ 밖에서 실행) 은 `teamSlugs` 가 빈 배열일 수 있음 → `null` 로 흘림.
- **stdout JSON 파싱 실패:** stderr 로 전체 stdout 일부를 echo 해주는 디버그 보조 로그 추가 검토. MVP 는 silent swallow — 사용자가 셸에서 직접 hook script 디버깅하라.

---

## 완료 정의 (DoD)

- [ ] Phase 1-3 모든 task 체크.
- [ ] Vitest suite 그린.
- [ ] `~/.openhive/config.yaml` 비어있어도 모든 기존 테스트 통과 (regression).
- [ ] 매뉴얼 시나리오: `sql-guard.sh` 등록 → SQL 툴 호출 → block 메시지가 LLM history 에 들어가서 다음 turn 이 다른 접근 시도. 스크린샷 첨부.
- [ ] 매뉴얼 시나리오: `notify-slack.sh` 등록 → 세션 끝 → Slack DM 도착. 캡쳐 첨부.
- [ ] CLAUDE.md 의 "Persistence Layout" 섹션 아래 "Hooks" 항목 한 줄 추가: `~/.openhive/config.yaml#hooks → user-defined shell hooks. See dev/active/runtime-claude-patterns/a2-hooks.md`.
- [ ] README 에 보안 한 줄 (위 보안 섹션) 추가.
