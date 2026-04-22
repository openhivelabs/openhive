# S3 — Fork Pattern (Claude prompt-cache 보존형 parallel delegation)

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **Fork 게이트 (택일 B 확정).** `decideForkOrFresh` 가 다음 6 조건 모두 만족할 때만 `fork:true`. 하나라도 false → `fork.skipped` event(reason 명시) + fresh path:
>    - `OPENHIVE_FORK_DISABLE !== '1'`
>    - `child.provider_id === 'claude-code'`
>    - **`snapshot.providerId === child.provider_id`** ← §3.3 의 추가 가드, 본 라운드 필수.
>    - `snapshot.nodeId === parent.id && snapshot.depth === depth`
>    - `Date.now() - snapshot.builtAt <= 60_000`
>    - `!isInForkChild(snapshot.history)`
> 2. **`fork.skipped.reason` 에 `'provider_mismatch'` 추가** (위 3번째 가드 위반 시).
> 3. **history snapshot ref vs copy.** 본 라운드는 raw ref 채택 (cache byte-identical 우선). race 발견 시 후속에서 `history.slice()` shallow copy 로 후퇴. §6 edge cases 표 그대로.
> 4. **Phase F4.4 실측**은 본 라운드 acceptance 의 일부 (plan §6 의 "S3 measured"). 결과는 `dev/active/runtime-claude-patterns/fork-measurement.md` 에 기록.
> 5. **이벤트 등록**은 plan §5 의 일괄 PR (Phase D) 에서 처리. 본 spec 의 Phase F3.3 은 그 PR 의 일부로 합치거나 stub 으로 유지.

---


**Goal:** `delegate_parallel` 이 N 개의 자식을 띄울 때, 각 자식에게 부모 turn 의 시스템 프롬프트 + tool 정의 + 직전 conversation prefix 를 **byte-identical** 로 물려줘서 Anthropic prompt cache 가 N-1 회 hit 하도록 만든다. Claude Code 의 leaked `forkSubagent.ts` 패턴 (`buildForkedMessages`) 을 OpenHive 엔진의 `runDelegation` 경로에 이식한다.

**Why:** 현재 `runParallelDelegation` (session.ts:1175–) 은 자식마다 `runNode` 를 새로 호출 → 새 history `[]` + 새로 빌드한 system prompt + 새로 정렬한 tools 배열로 첫 turn 을 친다. Anthropic 은 prefix 가 byte 단위로 일치할 때만 cache hit 을 주므로, N=5 fan-out 이면 system+tools 약 8–15K 토큰 × 5 회 fresh write 비용을 그대로 문다. Fork 패턴으로 system+tools+history-prefix 를 부모에서 재사용하면 자식 4 명은 `cache_read_input_tokens ≈ prefix size`, 본인 task 분 (수십~수백 토큰) 만 fresh write 비용으로 바꿀 수 있다.

**Why now:** `apps/web/lib/server/providers/caching.ts:62–115` 가 이미 system + last tool + last message 에 `cache_control: { type: 'ephemeral' }` 3 개 breakpoint 를 박는다 — write 는 일어나고 있는데, parallel 자식 쪽에서 prefix 가 깨져서 read 가 0 인 게 문제. precondition 은 사실상 충족됐고 자식 message-array 만 prefix-aligned 로 바꿔주면 된다.

**비범위 (Out of scope):**
- `delegate_to` (single child) — 부모 turn assistant 가 tool_use 1 개만 발행하는 경로. 동일 mechanic 적용 가능하지만 본 phase 에서는 `delegate_parallel` 에 한정해서 검증한 뒤 follow-up 에서 단발 delegation 까지 확장.
- Codex / Copilot prompt-prefix cache — Codex 는 `previous_response_id` 체이닝 (별도 mechanic), Copilot 은 1024+ 토큰 안정 prefix 만 자동 캐시. 본 spec 은 `provider_id === 'claude-code'` 로 게이팅.
- 자식 노드의 MCP overlay / file-state / agentId 분리 — 현재 `runNode` isolation (session.ts:465–613) 그대로 보존. 본 spec 은 "첫 turn 의 message array 를 어떻게 구성하느냐" 만 바꾼다.
- Fork 결과 stream 안에서 부모 turn 의 history 를 mutate 하는 새 경로 — 자식이 본인의 reply 를 만들면, 결과는 여전히 부모의 `tool_result` 슬롯으로만 돌아간다 (현재 `runDelegation` 의 result merge 와 동일).

---

## 0. 사전 확인 — 현재 코드 위치

| 관심사 | 파일 / 라인 | 비고 |
| --- | --- | --- |
| `delegate_parallel` 도구 정의 | `apps/web/lib/server/engine/session.ts:1125–1173` | `delegateParallelTool()` |
| 병렬 dispatch 본체 | `apps/web/lib/server/engine/session.ts:1175–1300` (`runParallelDelegation`) | `runOne(i, taskText)` 가 `runNode` 호출 (1244) |
| 단일 dispatch (참조용) | `apps/web/lib/server/engine/session.ts:992–1121` (`runDelegation`) | 1076 에서 `runNode` 호출 |
| per-node 드라이버 | `apps/web/lib/server/engine/session.ts:465–613` (`runNode`) | system prompt 빌드 552–559, history seed 562–563 |
| streamTurn (provider 진입) | `apps/web/lib/server/engine/session.ts:627–` | `buildMessages(systemPrompt, history)` (629) |
| provider dispatch | `apps/web/lib/server/engine/providers.ts:21–42` | `stream(providerId, model, messages, tools)` |
| Claude provider | `apps/web/lib/server/providers/claude.ts:225–257` (`streamMessages`) | `splitSystem` (137–186), `cachingStrategy.applyToRequest` (235) |
| 캐시 marker | `apps/web/lib/server/providers/caching.ts:62–115` (`AnthropicCachingStrategy`) | system + last tool + last message 3 breakpoint |
| RunState (globalThis) | `apps/web/lib/server/engine/session.ts:84–132` | `Symbol` 안 쓰지만 `__openhive_engine_run` 키로 globalThis 에 상주. 새 캐시 필드 여기에 얹는다. |

---

## 1. 설계 개요

### 1.1 부모 turn 시점의 상태

`runParallelDelegation` 이 호출되는 시점을 그림으로:

```
[parent runNode round R]
  history = [
    { role: 'system'  ... }   ← buildMessages 가 매 turn 합성
    { role: 'user',     content: parentTask }
    ... 이전 round 의 assistant/tool 페어 ...
    { role: 'assistant', content: '...', tool_calls: [
        { id: 'call_a', function: { name: 'delegate_parallel',
                                    arguments: '{"assignee":"writer","tasks":[t0,t1,t2,t3]}' } }
    ]}
  ]
  ↑ 여기까지가 부모의 "lastAssistant 포함 prefix"
```

이 시점에 부모 LLM 은 이미 **단 하나의 `tool_use` 블록** (`delegate_parallel`) 을 어시스턴트 메시지에 발행했다. Claude Code 의 fork 는 부모가 **N 개의 tool_use 를 병렬 발행** 하는 시나리오를 다루는데, OpenHive 의 `delegate_parallel` 은 N 개의 task 를 1 개의 tool_use 안에 묶는다는 점이 다르다. Mechanic 은 그대로지만, "모든 tool_use_id 마다 placeholder tool_result 를 채운다" 가 OpenHive 에서는 "그 1 개 tool_use_id 한 개에 placeholder 하나" 로 단순화된다.

### 1.2 자식 message array (Fork)

자식 i 의 첫 turn 은 다음 모양으로 보낸다 (Anthropic shape):

```ts
const childMessages: ChatMessage[] = [
  // (a) byte-identical copy — 참조 공유, 재 stringify 금지
  ...parent.history.slice(0, lastAssistantIndex),
  parent.history[lastAssistantIndex],   // assistant + tool_use 'call_a'

  // (b) 합성된 user 한 통: tool_result + 자식의 specific task
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_a',
        content: FORK_PLACEHOLDER,        // 'Fork started — processing in background'
      },
      {
        type: 'text',
        text:
          `<OPENHIVE_FORK_BOILERPLATE>\n` +
          `You are sibling ${i}/${N} of a delegate_parallel fan-out from ` +
          `${parentRole} (#${parentId}). Your scope is below — do not duplicate ` +
          `siblings' work.\n` +
          `</OPENHIVE_FORK_BOILERPLATE>\n` +
          `\n${tasks[i]}`,
      },
    ],
  },
]
```

**핵심 invariant:**
1. (a) 의 모든 메시지는 부모 history 의 **참조** 를 그대로 push 한다. 새 객체로 복사하지 말 것 — string interning 은 V8 가 알아서 하지만, 객체 prop 순서가 reorder 되거나 빈 필드가 삽입되면 JSON.stringify 결과가 달라져 prefix 가 깨진다.
2. (b) 의 placeholder 문자열은 `'Fork started — processing in background'` 로 **Claude Code 와 verbatim 일치**. 이 문자열 자체가 Anthropic 측의 보일러플레이트로 토큰화 패턴이 안정화돼 있을 가능성이 있고, 무엇보다 우리 측에서 한 곳에 박아두면 자식 간에도 동일 prefix 가 확보된다 (자식 0..N-1 이 placeholder 영역까지 동일).
3. (b) 의 `text` 블록은 `<OPENHIVE_FORK_BOILERPLATE>` 센티넬을 반드시 포함. 자식이 또 `delegate_parallel` 을 호출했을 때 `isInForkChild()` 가 history 를 스캔해서 막는다.

### 1.3 system prompt 의 byte-identical 전달

`runNode` 는 매 round 마다 `buildSystemPrompt(rounds)` (session.ts:552–559) 로 시스템 프롬프트를 합성한다. 자식이 부모의 캐시를 hit 하려면 자식의 첫 turn 시스템 프롬프트가 **부모 round R 의 시스템 프롬프트 문자열** 과 byte-identical 이어야 한다.

문제: `buildSystemPrompt` 는 `node` 와 `depth`, `state().todos.get(sessionId)`, `hintsBlock`, persona body 에 의존한다. 자식 노드는 부모와 다른 agent (`AgentSpec`) 이므로 자식의 `persona` / `agentSkills` / `teamSection` 이 다르다 — 따라서 **자식의 시스템 프롬프트는 부모 것과 다른 게 정상**.

그렇다면 캐시 hit 의 단위는?

- **부모 시스템 프롬프트** 는 부모의 다음 round 에서 cache read 됨 (현재도 동작 중).
- **자식 시스템 프롬프트** 는 자식의 첫 turn 에서 처음 등장 → cache write. 다음 round 에서 cache read.
- **history prefix 의 cache hit** 은 자식 turn 의 입장에서 보면 "system → tools → history" 순서로 prefix 매칭. system 이 부모와 다르면 system 부터 매칭 실패 → history prefix 에서 hit 가 안 난다.

**따라서 본 spec 의 핵심 결정:** 자식 i 의 첫 turn 시스템 프롬프트는 **부모 round R 의 시스템 프롬프트와 동일 문자열** 을 사용한다. 자식의 persona / skills / team section 은 (b) 의 text block 안에 task 와 함께 inline 으로 넣는다 (또는 두 번째 round 부터 자식 본연의 시스템 프롬프트로 전환).

이 단순화의 트레이드오프:
- 장점: prefix 가 system 부터 history 끝까지 부모와 byte-identical → cache hit 률 최대화.
- 단점: 자식의 첫 turn 은 부모 시점의 도구 (delegate_to / delegate_parallel / 부모가 보던 MCP 풀) 가 시스템에 그대로 남아 있다. 자식이 손주 를 또 delegate 할 수 있는지는 부모 system 의 묘사에 달림. 보통 부모 == lead, 자식 == leaf 인 시나리오에서는 자식이 사용 안 함 → 무해. 자식이 손자를 또 delegate 하는 다층 트리에서는 (b) text 안에 "you are now operating as ${childRole}; ignore the orchestration tools above unless explicitly needed" 라는 directive 를 넣어 보정.

이 트레이드오프가 너무 비싼 케이스 (자식이 본인 MCP 만 보여야 함) 는 fork 를 비활성하고 fresh path 로 fall through (본 spec 의 1.6 "decision matrix" 참고).

### 1.4 tools 의 byte-identical 전달

`runNode` (session.ts:477–537) 는 자식 노드의 권한에 맞춰 tools 배열을 새로 빌드한다. fork path 에서는 **부모가 직전 turn 에 보냈던 tools 배열을 그대로 자식에게 재사용** 한다 (`useExactTools: true`). 이유는 system 과 같음 — Anthropic cache 는 tools serialize 결과 byte 비교.

부모 turn 의 tools 배열은 `streamTurn` 진입 시점에 알 수 있으므로, 부모의 round R 시작 시점에 `RunState` 로 stash 해둔다 (§2.3 의 `lastTurnSnapshot`).

### 1.5 결과 merge

자식이 첫 turn 을 끝내면 (혹은 자체적으로 더 round 를 돌고 끝내면) `node_finished.output` 이 나온다. `runOne` (session.ts:1242–) 의 기존 흐름과 동일하게 부모의 `tool_result` (tool_call_id = 부모 turn 의 `delegate_parallel` call id) 로 합쳐서 부모 history 에 push. 즉 fork 는 자식의 **input** 만 바꾸고, **output 경로** 는 그대로.

### 1.6 Decision matrix — fork vs fresh

자식별로 독립 결정. 다음 중 **하나라도** true 면 fork 비활성, fresh path:

| 조건 | 이유 |
| --- | --- |
| `target.provider_id !== 'claude-code'` | Codex/Copilot 은 메시지 prefix cache 가 다른 mechanic |
| `isInForkChild(parent.history)` 가 true (이미 fork child 안) | 무한 fork 재귀 방지 |
| 부모 turn 의 system+tools 가 자식 권한과 호환 안 됨 (자식이 보면 안 되는 sensitive tool 이 부모 system 에 노출) | 권한 격리 우선 |
| `OPENHIVE_FORK_DISABLE=1` env | kill switch |

조건 모두 false → fork. 한 fan-out 안에서 자식들이 mixed 일 수 있다 (claude 자식 4 명은 fork, codex 자식 1 명은 fresh).

---

## 2. 변경 대상

### 2.1 신규 파일

- `apps/web/lib/server/engine/fork.ts` — fork 전용 helper. 외부 의존 없음.

### 2.2 수정 파일

- `apps/web/lib/server/engine/session.ts`
  - `RunState` 에 `lastTurnSnapshot`, `forkSystemCache` 필드 추가
  - `streamTurn` 직전에 `lastTurnSnapshot` stash
  - `runParallelDelegation` 의 `runOne` 가 fork decision → `runNodeForked` 호출
  - 새 함수 `runNodeForked` — 자식 첫 turn 만 fork-prefix 로, 이후 round 는 자식 본연의 build 로 전환
  - 새 이벤트 `fork.spawned`, `fork.skipped` 발행 헬퍼
- `apps/web/lib/server/engine/providers.ts`
  - `stream(...)` 시그니처에 optional 4 번째 param `opts?: { useExactTools?: boolean; overrideSystem?: string }` 추가. claude 분기에만 전달.
- `apps/web/lib/server/providers/claude.ts`
  - `StreamOpts` 에 `useExactTools?: boolean`, `overrideSystem?: string` 추가
  - `splitSystem` 우회: `overrideSystem` 이 있으면 그 문자열을 그대로 system 으로 박고 messages 에서 system 을 제거
  - tools serialize 순서: 현재도 입력 배열 순서 그대로지만, `useExactTools` flag 는 명시적 계약. caching.ts 가 `req.tools.map((t,i) => ...)` 로 입력 순서 보존하므로 이미 OK — flag 는 미래의 reorder 방지 sentinel.
- `apps/web/lib/server/providers/caching.ts`
  - 변경 없음. 기존 3 breakpoint 가 fork 에도 동일 적용.

### 2.3 RunState 확장

`session.ts:84–96` 에:

```ts
interface TurnSnapshot {
  // 부모 turn 의 streamTurn 진입 직전 byte-identical references
  systemPrompt: string                    // buildSystemPrompt(rounds) 결과
  history: ChatMessage[]                  // history 배열 자체 (자식이 slice 로만 읽음, mutate 금지)
  tools: ToolSpec[]                       // toolsToOpenAI 결과 (이미 OpenAI shape)
  providerId: string
  model: string
  nodeId: string
  depth: number
  builtAt: number                         // Date.now() — TTL 검증용
}

interface RunState {
  // ... 기존 필드 ...

  // sessionId → 가장 최근 streamTurn 의 snapshot. 부모 turn 안에서
  // delegate_parallel 가 호출될 때 자식이 참조한다.
  lastTurnSnapshot: Map<string, TurnSnapshot>

  // (sessionId, nodeId, depth) → 직전에 build 된 system prompt 문자열.
  // runNode 가 매 round 마다 새로 빌드하지만, 같은 (node, depth, todo state)
  // 면 재사용 가능. fork 자식이 부모 시스템을 inherit 할 때 이 캐시를 통해
  // 부모가 send 한 정확한 bytes 를 가져온다.
  forkSystemCache: Map<string, string>    // key: `${sessionId}:${nodeId}:${depth}:${todoVersion}`
}
```

`state()` 의 backfill 영역 (session.ts:127–130) 에 두 필드도 lazy init.

---

## 3. 알고리즘

### 3.1 부모 측 — TurnSnapshot 기록

`streamTurn` (session.ts:627–) 진입부, `messages = buildMessages(...)` 직후에:

```ts
state().lastTurnSnapshot.set(sessionId, {
  systemPrompt,
  history,                  // 참조만 — 호출자가 계속 push 하지만 fork 자식은
                            // tool_use 발행 직전의 length 까지만 slice
  tools: openaiTools ?? [],
  providerId: node.provider_id,
  model: node.model,
  nodeId: node.id,
  depth,
  builtAt: Date.now(),
})
```

**주의:** `history` 는 ChatMessage[] 라이브 참조다. 자식은 fork 시점에 `parentLastAssistantIdx = history.length - 1` (부모 LLM 이 assistant + tool_use 를 push 한 직후) 로 slice. 이후 부모가 같은 history 에 tool_result 를 push 해도 자식이 이미 slice 한 부분은 안전.

### 3.2 자식 측 — runOne 의 fork branch

`runParallelDelegation` 의 `runOne(i, taskText)` (session.ts:1242–) 를 다음으로 교체:

```ts
const runOne = async (i: number, taskText: string): Promise<void> => {
  try {
    const decision = decideForkOrFresh({
      sessionId,
      parent: fromNode,
      child: capturedTarget,
      depth,
    })

    const stream = decision.fork
      ? runNodeForked({
          sessionId,
          team,
          parentNode: fromNode,
          parentToolCallId: toolCallId,
          siblingIndex: i,
          siblingCount: tasks.length,
          node: capturedTarget,
          task: taskText,
          depth: depth + 1,
          snapshot: decision.snapshot,
        })
      : runNode({
          sessionId, team, node: capturedTarget,
          task: taskText, depth: depth + 1,
        })

    for await (const ev of stream) {
      // sibling 메타 부착 (기존 코드와 동일)
      if (ev.data.sibling_group_id === undefined) ev.data.sibling_group_id = siblingGroupId
      if (ev.data.sibling_index === undefined)    ev.data.sibling_index = i
      queue.push({ index: i, event: ev })
      if (ev.kind === 'node_finished' && ev.depth === depth + 1) {
        outputs[i] = (ev.data.output as string | undefined) ?? ''
      }
    }
  } catch (exc) {
    // 기존 에러 핸들링 그대로
  } finally {
    queue.push({ index: i, event: null })
  }
}
```

### 3.3 `decideForkOrFresh`

`fork.ts` 에:

```ts
export interface ForkDecision {
  fork: boolean
  reason?: 'non_claude' | 'recursive' | 'no_snapshot' | 'env_disabled'
  snapshot?: TurnSnapshot
}

export function decideForkOrFresh(args: {
  sessionId: string
  parent: AgentSpec
  child: AgentSpec
  depth: number
}): ForkDecision {
  if (process.env.OPENHIVE_FORK_DISABLE === '1') {
    return { fork: false, reason: 'env_disabled' }
  }
  if (child.provider_id !== 'claude-code') {
    return { fork: false, reason: 'non_claude' }
  }
  const snap = state().lastTurnSnapshot.get(args.sessionId)
  if (!snap || snap.nodeId !== args.parent.id || snap.depth !== args.depth) {
    return { fork: false, reason: 'no_snapshot' }
  }
  if (isInForkChild(snap.history)) {
    return { fork: false, reason: 'recursive' }
  }
  // 60s TTL — 그 이상 오래된 snapshot 은 다른 turn 잔여물일 수 있음
  if (Date.now() - snap.builtAt > 60_000) {
    return { fork: false, reason: 'no_snapshot' }
  }
  return { fork: true, snapshot: snap }
}

const FORK_BOILERPLATE_OPEN = '<OPENHIVE_FORK_BOILERPLATE>'

export function isInForkChild(history: ChatMessage[]): boolean {
  // 가장 최근 user message 의 text content 안에 센티넬이 있으면 fork child.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      if (m.content.includes(FORK_BOILERPLATE_OPEN)) return true
      return false
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ((block as any).type === 'text' && typeof (block as any).text === 'string') {
          if ((block as any).text.includes(FORK_BOILERPLATE_OPEN)) return true
        }
      }
      return false
    }
    return false
  }
  return false
}
```

### 3.4 `runNodeForked`

신규 generator. 첫 turn 만 fork-prefix 로 stream, 이후 round 는 normal `runNode` 로 위임 (자식이 본연의 system / tools 로 복귀). 단, "이후 round" 에 들어갈 일이 거의 없는 이유: 자식이 첫 turn 에 stop_reason='end_turn' (텍스트만) 을 내면 거기서 끝. tool_calls 가 있어 round 2 가 필요한 경우는 자식 본연의 turn loop 로 진입.

```ts
async function* runNodeForked(opts: {
  sessionId: string
  team: TeamSpec
  parentNode: AgentSpec
  parentToolCallId: string
  siblingIndex: number
  siblingCount: number
  node: AgentSpec               // 자식
  task: string
  depth: number
  snapshot: TurnSnapshot        // 부모 turn snapshot
}): AsyncGenerator<Event> {
  const { sessionId, team, parentNode, snapshot, node, task, depth } = opts

  yield makeEvent('node_started', sessionId,
    { role: node.role, task, fork: true },
    { depth, node_id: node.id })

  // 1. fork-prefix child message array 빌드
  const childHistory = buildForkedMessages({
    snapshot,
    parentToolCallId: opts.parentToolCallId,
    siblingIndex: opts.siblingIndex,
    siblingCount: opts.siblingCount,
    parentRole: parentNode.role,
    parentId: parentNode.id,
    childRole: node.role,
    task,
  })

  // 2. fork.spawned 이벤트 (관측용)
  const prefixChars =
    snapshot.systemPrompt.length +
    snapshot.history.reduce((n, m) => {
      if (typeof m.content === 'string') return n + m.content.length
      if (Array.isArray(m.content)) return n + JSON.stringify(m.content).length
      return n
    }, 0)
  yield makeEvent('fork.spawned', sessionId, {
    parent_node_id: parentNode.id,
    child_node_id: node.id,
    sibling_index: opts.siblingIndex,
    sibling_count: opts.siblingCount,
    system_prompt_chars: snapshot.systemPrompt.length,
    prefix_chars: prefixChars,
    tool_count: snapshot.tools.length,
  }, { depth, node_id: node.id })

  // 3. 첫 turn 만 fork mode 로 stream
  let firstTurnDone = false
  let firstTurnOutput = ''
  let stopReason: string | undefined
  for await (const ev of streamTurnFork({
    sessionId, team, node, depth,
    systemPromptOverride: snapshot.systemPrompt,
    toolsOverride: snapshot.tools,
    history: childHistory,
    providerId: snapshot.providerId,   // 'claude-code' 보장됨 (decideForkOrFresh)
    model: snapshot.model,
  })) {
    if (ev.kind === 'node_finished' && ev.data._turn_marker === true) {
      stopReason = ev.data.stop_reason as string | undefined
      firstTurnOutput = (ev.data.output as string | undefined) ?? ''
      firstTurnDone = true
      break
    }
    yield ev
  }

  // 4. 더 round 가 필요 없으면 (자식이 텍스트만 내고 끝) 여기서 종결
  if (!firstTurnDone || stopReason !== 'tool_calls') {
    yield makeEvent('node_finished', sessionId,
      { output: firstTurnOutput },
      { depth, node_id: node.id })
    return
  }

  // 5. 자식이 tool_call 을 또 발행 → 본연의 runNode loop 로 transition.
  //    이때 history 는 forked prefix 가 아니라 자식 자신의 system 으로
  //    rebuild 해야 한다 (cache 손해 보더라도 정합성 우선).
  //    구현: childHistory 의 마지막 user (fork directive) 만 task 로 추출하고,
  //    runNode 에 externalHistory 로 넘기지 말고 fresh 로 호출.
  //    → 첫 round 의 결과 텍스트는 잃지 않게 fresh runNode 의 user message 에
  //       "you previously wrote: ..." 로 carry-over.
  yield* runNode({
    sessionId, team, node,
    task: `${task}\n\n[PRIOR DRAFT]\n${firstTurnOutput}`,
    depth,
  })
}
```

### 3.5 `buildForkedMessages`

```ts
const FORK_PLACEHOLDER = 'Fork started — processing in background'

export function buildForkedMessages(args: {
  snapshot: TurnSnapshot
  parentToolCallId: string
  siblingIndex: number
  siblingCount: number
  parentRole: string
  parentId: string
  childRole: string
  task: string
}): ChatMessage[] {
  // (a) 부모 history 의 byte-identical 참조 — slice 만, 복사 X
  const parentHistory = args.snapshot.history
  const lastIdx = parentHistory.length - 1
  // 마지막 메시지가 assistant + tool_use 인지 sanity check
  const last = parentHistory[lastIdx]
  if (!last || last.role !== 'assistant' || !Array.isArray(last.tool_calls) || last.tool_calls.length === 0) {
    throw new Error('fork: parent last message is not assistant+tool_use')
  }

  // (b) 합성된 user message
  const directive =
    `<OPENHIVE_FORK_BOILERPLATE>\n` +
    `You are sibling ${args.siblingIndex + 1}/${args.siblingCount} of a ` +
    `delegate_parallel fan-out from ${args.parentRole}#${args.parentId} to ` +
    `${args.childRole}. Your scope is below — do not duplicate siblings' work. ` +
    `Ignore orchestration tools above unless your task explicitly requires them.\n` +
    `</OPENHIVE_FORK_BOILERPLATE>\n\n` +
    args.task

  const synthUser: ChatMessage = {
    role: 'user',
    // OpenHive 내부 ChatMessage 는 OpenAI shape (string content + tool role).
    // claude provider 의 splitSystem 이 tool role 을 user+tool_result block 으로
    // 변환하므로, fork directive 는 별도 user(text) 로 두 개 메시지로 분리한다.
    content: directive,
  }

  // tool_result 는 OpenAI shape 에서 { role: 'tool', tool_call_id, content } 로 표현.
  // splitSystem (claude.ts:147–158) 이 이를 user+tool_result block 으로 변환.
  const toolResultMsg: ChatMessage = {
    role: 'tool',
    tool_call_id: args.parentToolCallId,
    content: FORK_PLACEHOLDER,
  }

  // 순서: [parent prefix...] [parent assistant+tool_use] [tool_result placeholder] [user directive+task]
  // claude provider 의 splitSystem 이 tool → user(tool_result block) 로,
  // user(text) → user(text block) 로 변환.
  // 같은 role 의 연속 user 메시지는 Anthropic 측에서 머지되거나 그대로 통과.
  // 안전하게는 toolResultMsg 와 synthUser 를 한 user message 의 두 block 으로
  // 합쳐서 보내고 싶지만, 그러려면 ChatMessage 가 multi-block content 를
  // 지원해야 함. 차선: 둘 다 보내고 splitSystem 이 인접 user 를 하나로 머지하도록
  // 별도 helper 추가 (mergeAdjacentUserBlocks) — §3.6.
  return [...parentHistory.slice(0, lastIdx + 1), toolResultMsg, synthUser]
}
```

### 3.6 `splitSystem` 보강 — 인접 user 머지

claude.ts:137–186 의 `splitSystem` 끝부분에 인접 user 머지 패스를 추가. 이유: Anthropic 은 동일 role 연속 메시지를 받으면 종종 거부하거나 (`messages: roles must alternate`) 자동 머지하는데, 캐시 byte 비교가 깨질 수 있음. 명시적으로 우리가 머지해서 보낸다.

```ts
function mergeAdjacentUsers(out: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = []
  for (const m of out) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === 'user' && m.role === 'user') {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content) }]
      const curBlocks  = Array.isArray(m.content)    ? m.content    : [{ type: 'text', text: String(m.content) }]
      prev.content = [...prevBlocks, ...curBlocks]
    } else {
      merged.push(m)
    }
  }
  return merged
}
```

`splitSystem` return 직전에 `out = mergeAdjacentUsers(out)` 적용. 기존 (non-fork) 흐름에서는 인접 user 가 발생하지 않으므로 무해.

### 3.7 `streamTurnFork`

`streamTurn` 의 가벼운 변형. 기존 `streamTurn` 을 두 단계로 split 하지 않고 wrapper 로 처리:

```ts
async function* streamTurnFork(opts: {
  sessionId: string
  team: TeamSpec
  node: AgentSpec
  depth: number
  systemPromptOverride: string
  toolsOverride: ToolSpec[]
  history: ChatMessage[]
  providerId: string
  model: string
}): AsyncGenerator<Event> {
  // 기존 streamTurn 의 핵심 루프 (provider stream → text/tool_call buffer → events)
  // 를 호출하되, providers.stream 호출 시 useExactTools/overrideSystem 옵션을
  // 전달한다. 자세한 구현은 streamTurn 과 분기 (조건부 옵션) 또는 별도 함수.
  //
  // 핵심:
  //   - buildMessages 호출하지 않고 history 를 그대로 전달
  //     (단, system 메시지를 history[0] 으로 inject 하지 않음)
  //   - providers.stream 에 { useExactTools: true, overrideSystem: systemPromptOverride }
  //   - 그 외 텍스트/툴콜 버퍼링, _turn_marker 발행은 streamTurn 과 동일
}
```

### 3.8 providers.ts 수정

```ts
export async function* stream(
  providerId: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  opts?: { useExactTools?: boolean; overrideSystem?: string },
): AsyncIterable<StreamDelta> {
  if (providerId === 'claude-code') {
    yield* streamClaude(model, messages, tools, opts)
    return
  }
  // 다른 provider 는 opts 무시 (fork 비활성)
  // ...
}

async function* streamClaude(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  opts?: { useExactTools?: boolean; overrideSystem?: string },
) {
  for await (const ev of claude.streamMessages({
    model, messages, tools,
    useExactTools: opts?.useExactTools,
    overrideSystem: opts?.overrideSystem,
  })) {
    // 기존 normalize 로직 그대로
  }
}
```

### 3.9 claude.ts 수정

`StreamOpts` 에 두 필드 추가, `streamMessages` 안:

```ts
const messagesForSplit = opts.overrideSystem
  ? opts.messages.filter((m) => m.role !== 'system')
  : opts.messages
const split = splitSystem(messagesForSplit)
const finalSystem = opts.overrideSystem ?? split.system

const payload = cachingStrategy.applyToRequest({
  system: finalSystem,
  messages: split.out,
  tools: opts.tools && opts.tools.length > 0 ? opts.tools : null,
  model: opts.model,
  maxTokens: opts.maxTokens ?? 4096,
})
```

`useExactTools` 는 현재 caching.ts 가 입력 순서를 그대로 보존하므로 별도 동작 변경 없음. 다만 향후 reorder optimization 이 들어왔을 때 fork 가 깨지지 않도록, caching.ts 의 `applyToRequest` 에 `if (req.useExactTools) skip-reorder` 가드를 미리 추가해 두는 게 안전 (현재는 reorder 로직이 없어 no-op).

---

## 4. 이벤트 / 관측

### 4.1 신규 이벤트 종류

- `fork.spawned` — fork 결정 + 자식 stream 시작 직전. payload:
  ```ts
  {
    parent_node_id: string
    child_node_id: string
    sibling_index: number
    sibling_count: number
    system_prompt_chars: number
    prefix_chars: number       // system + history serialize size 합
    tool_count: number
  }
  ```
- `fork.skipped` — decideForkOrFresh 가 fork 거부. payload:
  ```ts
  { parent_node_id: string, child_node_id: string, reason: ForkDecision['reason'] }
  ```

events.jsonl 에 그대로 append (기존 batched flush 경로 사용).

### 4.2 cache 메트릭 검증

Claude provider 는 이미 `cache_read_input_tokens` / `cache_creation_input_tokens` 를 `usage` delta 로 emit (providers.ts:124–125, 165–166). 자식 노드의 `usage` 이벤트에서 다음을 만족해야 fork 가 동작 중:

- 첫 turn 의 `cache_read_tokens / input_tokens > 0.7`
- 사이즈 비교: `cache_read_tokens ≈ snapshot.systemPrompt + snapshot.tools serialize + snapshot.history serialize` (토큰 단위, 약 1 char ≈ 0.25 tok)

이 두 값을 `fork.spawned.prefix_chars` 와 후속 자식 `usage.cache_read_tokens` 로 cross-check.

---

## 5. 페이즈 / 태스크

### Phase F1 — 인프라 (snapshot + fork helper)

#### Task F1.1: RunState 확장

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (84–132)

- [ ] Step 1: `TurnSnapshot` interface 정의 (`systemPrompt`, `history`, `tools`, `providerId`, `model`, `nodeId`, `depth`, `builtAt`).
- [ ] Step 2: `RunState` 에 `lastTurnSnapshot: Map<string, TurnSnapshot>`, `forkSystemCache: Map<string, string>` 추가.
- [ ] Step 3: `state()` 의 backfill 영역에 두 필드 lazy init.
- [ ] Step 4: 세션 종료 시 (`markSessionDone` / `markSessionInterrupted` 등 기존 hook) 두 Map 의 해당 sessionId 키 삭제.

#### Task F1.2: fork.ts 신규 모듈

**Files:**
- Create: `apps/web/lib/server/engine/fork.ts`

- [ ] Step 1: `FORK_PLACEHOLDER` 상수 (`'Fork started — processing in background'`).
- [ ] Step 2: `FORK_BOILERPLATE_OPEN` 상수 + `isInForkChild(history)` 구현.
- [ ] Step 3: `decideForkOrFresh(args)` 구현 — env / provider / snapshot freshness / recursion 검사.
- [ ] Step 4: `buildForkedMessages(args)` 구현 — parent history slice + tool_result placeholder + directive user message.
- [ ] Step 5: `ForkDecision` 타입 export, `TurnSnapshot` 타입은 session.ts 에서 import.

#### Task F1.3: TurnSnapshot 기록 hook

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (`streamTurn`, 627–)

- [ ] Step 1: `streamTurn` 진입 직후 `state().lastTurnSnapshot.set(sessionId, { systemPrompt, history, tools: openaiTools ?? [], providerId: node.provider_id, model: node.model, nodeId: node.id, depth, builtAt: Date.now() })`.
- [ ] Step 2: 같은 turn 안에서 두 번 호출되지 않도록 (재시도 path 등) idempotent 확인.

---

### Phase F2 — provider 옵션 통로

#### Task F2.1: `stream()` 시그니처 확장

**Files:**
- Modify: `apps/web/lib/server/engine/providers.ts` (21–42, 105–187)

- [ ] Step 1: `stream(...)` 5 번째 param `opts?: { useExactTools?: boolean; overrideSystem?: string }` 추가.
- [ ] Step 2: claude 분기에만 `opts` 전달, 다른 provider 는 무시.
- [ ] Step 3: `streamClaude(model, messages, tools, opts)` 가 `claude.streamMessages` 에 `useExactTools` / `overrideSystem` 전달.

#### Task F2.2: claude.ts 의 override 처리

**Files:**
- Modify: `apps/web/lib/server/providers/claude.ts` (217–257, splitSystem 137–186)

- [ ] Step 1: `StreamOpts` 에 `useExactTools?: boolean`, `overrideSystem?: string` 추가.
- [ ] Step 2: `streamMessages` 안 — `opts.overrideSystem` 이 있으면 messages 의 system role 제거 후 splitSystem 호출, 결과 system 을 override 로 덮어쓰기.
- [ ] Step 3: `splitSystem` 끝부분에 `mergeAdjacentUsers(out)` 패스 추가 (§3.6).
- [ ] Step 4: `mergeAdjacentUsers` 헬퍼 신설 — 동일 role(user) 인접 메시지를 content blocks 로 머지.

#### Task F2.3: caching.ts 의 reorder 가드 (방어적)

**Files:**
- Modify: `apps/web/lib/server/providers/caching.ts` (62–115)

- [ ] Step 1: `AnthropicRequest` 에 optional `useExactTools?: boolean` 추가 (현재는 동작 변경 없음, 향후 reorder optimization 가드용).
- [ ] Step 2: caching.test.ts 의 snapshot 케이스가 깨지지 않는지 확인 (no behavior change).

---

### Phase F3 — runParallelDelegation 의 fork 분기

#### Task F3.1: `runNodeForked` 신설

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (runParallelDelegation 1175– 근처)

- [ ] Step 1: `runNodeForked(opts)` generator 함수 추가 (§3.4 의 코드).
- [ ] Step 2: 첫 turn 만 fork mode, stop_reason !== 'tool_calls' 면 종결.
- [ ] Step 3: 자식이 추가 round 필요시 `runNode(...)` 로 fall-through, prior draft 를 task 에 carry-over.
- [ ] Step 4: `streamTurnFork` 헬퍼 추가 (or `streamTurn` 에 fork param 추가) — providers.stream 에 `useExactTools: true, overrideSystem` 옵션 전달.

#### Task F3.2: `runOne` rewire

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (1242– `runOne`)

- [ ] Step 1: `runOne` 시작부에서 `decideForkOrFresh(...)` 호출.
- [ ] Step 2: `decision.fork` 분기로 `runNodeForked` vs `runNode` 선택.
- [ ] Step 3: `decision.fork === false` 면 `fork.skipped` 이벤트 발행 (`reason` 포함).
- [ ] Step 4: 기존 sibling_group_id / sibling_index 부착 로직 보존.

#### Task F3.3: 이벤트 타입 등록

**Files:**
- Modify: `apps/web/lib/server/engine/events.ts` (또는 event kind union 정의 위치)

- [ ] Step 1: `fork.spawned`, `fork.skipped` kind 추가.
- [ ] Step 2: payload 타입 정의.
- [ ] Step 3: events.jsonl serialize / replay 경로가 unknown kind 를 graceful 처리하는지 확인 (이미 그러하면 no-op).

---

### Phase F4 — 테스트 + 검증

#### Task F4.1: 단위 테스트 — `buildForkedMessages` / `isInForkChild`

**Files:**
- Create: `apps/web/lib/server/engine/fork.test.ts`

- [ ] Step 1: `isInForkChild` — 센티넬 있는 user message 만 true, assistant text 안의 센티넬은 false.
- [ ] Step 2: `buildForkedMessages` — parent history slice 가 참조 동일 (`output[0] === parentHistory[0]`).
- [ ] Step 3: 마지막 두 메시지 — tool_result (FORK_PLACEHOLDER) + user (directive 포함, task suffix).
- [ ] Step 4: parent last message 가 assistant+tool_use 가 아니면 throw.

#### Task F4.2: 통합 — `splitSystem` + `mergeAdjacentUsers`

**Files:**
- Modify: `apps/web/lib/server/providers/caching.test.ts` (또는 신규 claude.test.ts)

- [ ] Step 1: 인접 user 두 개 (string + tool 변환된 것) 가 한 user message 의 두 block 으로 머지되는지 snapshot.
- [ ] Step 2: non-fork 시나리오 (user → assistant → user → tool → ...) 에서 머지가 발생하지 않는지 (no-op) 확인.
- [ ] Step 3: `overrideSystem` 적용 시 payload.system 이 override bytes 와 일치, messages 에 system role 잔존 없음.

#### Task F4.3: e2e — `delegate_parallel` cache 메트릭

**Files:**
- Create: `apps/web/lib/server/engine/__tests__/fork-e2e.test.ts` (또는 기존 e2e harness 확장)

- [ ] Step 1: mock `claude.streamMessages` — payload 받아서 `messages` / `system` / `tools` 의 SHA256 을 기록하고 stub usage 반환.
- [ ] Step 2: lead → writer × 5 fan-out 시나리오 구성. lead 가 1 round 진행 후 `delegate_parallel` 호출하도록 mock LLM response.
- [ ] Step 3: 5 자식 호출 페이로드의 `system` SHA256 가 모두 동일 (=lead 의 system), `tools` SHA256 가 모두 동일.
- [ ] Step 4: 각 자식의 messages 배열 prefix (마지막 두 메시지 이전까지) SHA256 가 모두 동일.
- [ ] Step 5: 자식 5 명의 마지막 user message 의 directive text 가 각자 다른 task suffix 포함.
- [ ] Step 6: `fork.spawned` 이벤트 5 회 발행, `fork.skipped` 0 회.

#### Task F4.4: 실측 cache hit 검증 (수동 / staging)

**Files:**
- Create: `dev/active/runtime-claude-patterns/fork-measurement.md` (결과 기록)

- [ ] Step 1: lead (claude opus) → writer × 5 (claude sonnet) 팀 구성, `OPENHIVE_FORK_DISABLE=1` 로 baseline 측정 (5 자식의 `cache_read_input_tokens` 합).
- [ ] Step 2: env 풀고 동일 시나리오 재실행, fork on baseline 비교.
- [ ] Step 3: 자식별 `cache_read_input_tokens / input_tokens >= 0.70` 검증.
- [ ] Step 4: writer 가 codex 로 섞인 mixed pool 도 테스트 — codex 자식은 `fork.skipped` 이벤트 + cache hit 0%, claude 자식만 hit.
- [ ] Step 5: 결과를 `fork-measurement.md` 에 토큰 수치 + 비용 차이 기록.

---

### Phase F5 — 정리 / 가드

#### Task F5.1: kill switch + 기본값

**Files:**
- Modify: `apps/web/lib/server/engine/fork.ts`
- Modify: `CLAUDE.md` (env 섹션)

- [ ] Step 1: `OPENHIVE_FORK_DISABLE=1` 으로 즉시 비활성 가능.
- [ ] Step 2: 기본 ON. `decideForkOrFresh` 의 default path = fork (조건 만족 시).
- [ ] Step 3: CLAUDE.md 의 env 목록에 추가 — "Claude provider parallel fork. Off 하면 자식마다 fresh context 로 fall-through."

#### Task F5.2: 메모리 / leak 가드

**Files:**
- Modify: `apps/web/lib/server/engine/session.ts` (세션 종료 hook)

- [ ] Step 1: `markSessionDone` / `markSessionInterrupted` / orphan cleanup 에서 `state().lastTurnSnapshot.delete(sessionId)` 호출.
- [ ] Step 2: `forkSystemCache` 키 패턴 확인 — sessionId prefix 로 일괄 삭제.
- [ ] Step 3: snapshot 의 `history` 가 ref 라서 GC 가 부모 history 전체를 hold — 세션 종료 시 명시적 null 화.

#### Task F5.3: docs / runbook

**Files:**
- Modify: `docs/superpowers/specs/2026-04-19-openhive-mvp-design.md` (caching 관련 섹션이 있다면)
- Modify: `dev/active/runtime-claude-patterns/plan.md` (S3 완료 마크)

- [ ] Step 1: "Claude fan-out fork pattern" 한 단락 추가 — 동기 + 한계 (자식 첫 turn 만, 자식 system 은 부모 inherit).
- [ ] Step 2: 알려진 trade-off 명시 — 자식이 첫 turn 에 자기 persona 를 못 보는 점, mitigated by directive text.

---

## 6. Edge cases (확정 결정)

| 케이스 | 결정 |
| --- | --- |
| `delegate_parallel` 의 `tasks.length === 1` (실제로는 minItems=2 라 발생 안 함, 방어용) | fork path 그대로 — N=1 도 cache hit 가치 있음. 단 `delegate_parallel` schema 가 minItems=2 이므로 정상 흐름에서는 도달 안 함. |
| TurnSnapshot 부재 (첫 turn 인데 부모가 아직 streamTurn 거치지 않음) | `decideForkOrFresh` 가 `no_snapshot` 반환 → fresh. `fork.skipped` 발행. |
| Mixed provider fan-out (writer × 5 중 3 명 claude, 2 명 codex) | 자식별 독립 결정. claude 3 명 fork, codex 2 명 fresh. snapshot 은 claude 자식들끼리 공유. |
| 부모가 non-claude (lead = codex) → 자식 = claude | snapshot.providerId === 'codex' 라서 claude 자식이 inherit 하면 시스템 프롬프트 포맷이 안 맞음. `decideForkOrFresh` 에 `snapshot.providerId === child.provider_id` 도 가드 추가 (§3.3 의 조건에 포함되도록 수정). |
| 자식이 첫 turn 에 또 `delegate_parallel` 호출 | 첫 turn 자체는 fork prefix 였지만, 자식이 round 2 로 넘어가면서 `runNode` 로 transition. round 2 의 `streamTurn` 이 새 snapshot 을 set → 손주가 그 snapshot 으로 fork 가능 (재귀 fork). 단 `isInForkChild` 가 true 라면 `decideForkOrFresh` 가 막음 — 즉 fork 자식의 손주는 fresh path. |
| snapshot 의 history 가 자식 stream 진행 중 부모에 의해 mutate | parent history 는 `delegate_parallel` 결과를 대기 중이므로 자식이 끝날 때까지 mutate 안 됨 (직렬 흐름). 하지만 race 방어 차원에서 snapshot 보관 시 `history.slice()` 한 shallow copy 를 보관하는 옵션도 있음 — 본 spec 은 raw ref 채택 (cache byte-identical 확보 우선, 실측 race 발견되면 shallow copy 로 후퇴). |
| Anthropic 측에서 인접 user 메시지 거부 | `mergeAdjacentUsers` 패스로 사전 머지. 그래도 거부되면 fork.spawned 이벤트로 fail-soft → fresh path 재시도 (별도 phase). |

---

## 7. Test plan (요약)

목표: claude provider 5-자식 fan-out 에서 자식 4 명 (or 5 명) 의 `cache_read_input_tokens / input_tokens >= 0.70`.

1. **단위:** `fork.test.ts` — buildForkedMessages 의 byte-identity, isInForkChild 센티넬 매칭. `caching.test.ts` 확장 — `mergeAdjacentUsers` snapshot.
2. **통합:** `fork-e2e.test.ts` — mock claude.streamMessages 로 5 자식 페이로드 hash 비교 (system / tools / prefix 모두 일치).
3. **수동 실측:** staging 에서 lead (claude) → writer×5 (claude) 팀, baseline (fork off) vs fork on 의 누적 input_tokens 비교. 목표: fork on 의 총 input_tokens 가 baseline 대비 ≥ 60% 감소.
4. **회귀:** 기존 `delegate_to` 단발 / non-claude provider / 단일 노드 chat 모드 시나리오 — 동작 변화 없음 (fork.spawned 이벤트 0 회).

---

## 8. 제약 (CLAUDE.md 준수)

- LangChain / LangGraph 미사용 — fork 는 순수 message-array 변형, graph 도입 없음.
- 신규 dep 0 개.
- per-node provider+model 보존 — 자식의 `provider_id`, `model` 은 그대로 사용 (snapshot 은 부모 provider_id 가 자식과 일치할 때만 적용).
- 엔진 상태 FS-only — TurnSnapshot 은 in-memory only, events.jsonl 에는 `fork.spawned/skipped` event 만 (snapshot 본문은 persist 안 함).
- globalThis 싱글톤 — `__openhive_engine_run` 에 합류 (이미 그 위치에 RunState 가 있음). 새 globalThis 키 추가 없음.
