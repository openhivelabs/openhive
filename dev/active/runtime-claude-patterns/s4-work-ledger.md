# S4 — 회사 단위 업무 원장 (Work Ledger)

> **ADDENDUM (lock-in, 2026-04-22) — plan.md §2, §4 우선.**
> 1. **`TeamSpec.domain?` 추가 위치 확정.** `apps/web/lib/server/engine/team.ts:41` TeamSpec 끝 + `:90` toTeamSpec passthrough (plan §4.6).
> 2. **Hook 위치**: `session.ts:1112` (single 성공) + `session.ts:1098` (single error) + `session.ts:1310` (parallel). depth ≥ 1 가드는 자연스럽게 충족 (`runDelegation` 정의상 sub-agent 호출).
> 3. **LLM 요약 (`OPENHIVE_LEDGER_SUMMARY=llm`) 은 stub.** 인터페이스만 export, body throw `NotImplementedError`. 본 라운드 acceptance 에 미포함.
> 4. **Backfill script (Phase 4) 도 stub.** dry-run 출력만, 실제 INSERT 는 후속.
> 5. **A2 와 독립.** `OPENHIVE_LEDGER_SUMMARY=llm` 의 후속 구현이 A2 hook 과 묶이는 가능성은 있으나 본 라운드는 무관.

---


**Goal:** 같은 회사(company) 안에서 여러 차례 실행된 델리게이션의 결과물을 구조화·검색 가능한 원장에 누적해서, Lead LLM이 다음 런 시작 시 "전에 비슷한 Q3 보고서 만든 적 있나?" 같은 질의로 과거 작업을 빠르게 회상할 수 있게 한다.

**Why:** OpenHive는 보고서/R&D/문서 산출물 도메인이 타깃이라 "이전 런에서 했던 일"을 다시 끌어와 재활용하는 패턴이 잦다. 현재 엔진은 `events.jsonl` 에 모든 step을 적재하지만 — 이건 단일 세션 timeline용이고 cross-session 질의 인덱스가 없다. 회사 단위 ledger가 있어야 (1) Lead가 과거 산출물 path를 직접 끌어오고 (2) UI Run 탭에서 "이 회사가 한 일" 검색이 가능하다.

**Not memory.** Claude Code식 cross-session 자유서술 메모(`MEMORY.md` 인덱스 + 라자 로딩)는 OpenHive 도메인과 안 맞아서 명시적으로 채택 안 함 (`context.md` 참조). 우리가 만드는 건 cross-session **operational work history** — 정형 인덱스 + body 파일 패턴만 빌려온다.

**Inspiration (Claude Code memdir, 패턴만 차용):**
- 인덱스(가벼움) + per-entry 본문 파일(무거움) 분리 → 인덱스만 항상 검색 대상, 본문은 lazy-load.
- 우리 적용: 인덱스 = SQLite + FTS5 (`better-sqlite3` 이미 dep), 본문 = `.md` 파일.
- 결정적 차이: Claude Code는 LLM이 자기 grep으로 회상. OpenHive는 두 개의 명시적 tool(`search_history`, `read_history_entry`)로 회상 — 결정 그래프가 명확해야 보고서 도메인에 맞다.

**Scope:** 인덱스 스키마 + write hook + Lead-only read tool 두 개 + HTTP API + 백필 스크립트(stub).

**Out of scope:** UI 탭 (별도 plan), LLM 요약 모드 실제 구현 (스펙만), 멀티 컴패니 cross-search.

---

## 0. 핵심 결정 사항 (lock-in)

- **저장 위치:** `~/.openhive/companies/{companyId}/ledger/` — 회사 단위. **borderline 케이스 명시:** 디자인 데이터(`company.yaml`, `team.yaml`)와 운영 데이터(`data.db`, `chat.jsonl`) 가 한 디렉터리에 공존하는 것과 동일한 결정. ledger 자체는 운영 데이터지만 회사 스코프이므로 회사 디렉터리 하위에 둔다. `sessions/` 아래에는 두지 않음 (cross-session 인덱스라 세션 디렉터리 라이프사이클과 분리되어야 함).
- **Git ignore:** ledger 전체는 `.gitignore`. 회사 디자인을 공유해도 운영 ledger는 로컬에 남는다.
- **DB 엔진:** `better-sqlite3` + FTS5. 새 의존성 0개.
- **언어 처리:** `unicode61 remove_diacritics 1` tokenizer — 한국어/영어 혼용 보고서를 무난히 토큰화. CJK trigram이 더 좋지만 tokenizer 추가 빌드가 필요해서 MVP에선 unicode61로 시작 (FTS5 query가 뜻하는 바를 알면 한국어도 prefix 검색은 충분).
- **쓰기 시점:** `runDelegation` 의 `delegation_closed` 이벤트 emit 직후, **`depth ≥ 1`** 인 경우만. 즉 sub-agent의 결과만 ledger에 기록되고, Lead 자기 자신의 turn은 ledger에 안 남는다 (Lead는 회상 주체이지 회상 대상이 아니다).
- **회상 도구:** Lead(`depth === 0`)에게만 노출. Sub-agent 가 검색하면 순환·잡음 위험.
- **Globalthis singleton:** company 별 DB connection은 `globalThis[Symbol.for('openhive.ledger.dbCache')]` Map<companyId, Database>. HMR/tsx-watch 안전.

---

## 1. Storage layout

```
~/.openhive/companies/{companyId}/
  company.yaml
  teams/
    {teamId}.yaml
    {teamId}/
      data.db
      chat.jsonl
      ...
  ledger/                                # ← S4 신규
    index.db                             # SQLite + FTS5
    entries/
      {yyyy}/
        {mm}/
          {entry_ulid}.md                # body, lazy-load
```

- **`index.db`:** 회사 단위 단일 파일. WAL 모드. 동일 회사 안의 모든 팀·세션의 ledger entry가 한 DB에 모인다 (cross-team 검색 가능 — 동일 회사라면 같은 도메인일 확률이 높다).
- **`entries/{yyyy}/{mm}/{ulid}.md`:** body. ULID는 시간 정렬 가능하므로 디렉터리 트리만 봐도 시계열 순회 가능. 월 단위 디렉터리는 inode 폭주 방지 + ls 성능. body 파일에는 sub-agent의 raw output 전체 + delegation task prompt + 메타 frontmatter.

### Body file 포맷 (예시)

```markdown
---
id: 01HXXXXXXXXXXXXXXXX
ts: 1745366400
session_id: 9f3a-...
team_id: research-team
agent_id: 7c12-...
agent_role: Researcher
domain: research-team
task_excerpt: |
  Q3 매출 보고서 초안에 들어갈 경쟁사 가격 조사.
status: completed
artifact_paths:
  - ~/.openhive/sessions/9f3a-.../artifacts/competitors.csv
---

# Task

Q3 매출 보고서 초안에 들어갈 경쟁사 가격 조사. 아래 4개 회사 SKU 비교:
...

# Output

(sub-agent의 raw 응답 그대로)
```

Frontmatter는 인덱스에 들어가는 컬럼들의 mirror. body 파일 단독으로도 self-describing.

---

## 2. Schema (exact SQL)

`apps/web/lib/server/ledger/schema.ts` 에 상수로 박는다.

```sql
-- migration 001
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL UNIQUE,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,           -- ulid (26 chars)
  ts              INTEGER NOT NULL,           -- unix seconds
  session_id      TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  agent_role      TEXT NOT NULL,              -- denormalized (filter-friendly)
  domain          TEXT NOT NULL,              -- team.yaml `domain:` 필드 → fallback team_id
  task            TEXT NOT NULL,              -- 부모가 내려준 delegation prompt 원문
  summary         TEXT NOT NULL,              -- 1-2 문장 outcome (heuristic 또는 LLM)
  artifact_paths  TEXT NOT NULL,              -- JSON array of strings
  body_path       TEXT NOT NULL,              -- ledger/ 기준 상대 경로 (예: entries/2026/04/01HX...md)
  status          TEXT NOT NULL CHECK (status IN ('completed','errored','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_entries_ts        ON entries(ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_team_ts   ON entries(team_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_agent_ts  ON entries(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_domain_ts ON entries(domain, ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_session   ON entries(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  task,
  summary,
  domain,
  agent_role,
  content=entries,
  content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1'
);

-- FTS5 contentless mirror: triggers
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, task, summary, domain, agent_role)
  VALUES (new.rowid, new.task, new.summary, new.domain, new.agent_role);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, task, summary, domain, agent_role)
  VALUES ('delete', old.rowid, old.task, old.summary, old.domain, old.agent_role);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, task, summary, domain, agent_role)
  VALUES ('delete', old.rowid, old.task, old.summary, old.domain, old.agent_role);
  INSERT INTO entries_fts(rowid, task, summary, domain, agent_role)
  VALUES (new.rowid, new.task, new.summary, new.domain, new.agent_role);
END;
```

**참고 — `apps/web/lib/server/team-data.ts:19-27` 의 `BOOTSTRAP_SCHEMA` 패턴을 그대로 따른다.** `schema_migrations` 는 이미 검증된 형태가 있지만 ledger는 `version INTEGER UNIQUE` 를 추가해서 미래 ALTER를 멱등하게 만든다. version=1을 첫 마이그레이션으로 적재.

---

## 3. Write path

### 3.1 Hook 위치

기존 `runDelegation` (`apps/web/lib/server/engine/session.ts:992-1121`) 의 끝부분, `delegation_closed` 이벤트 emit (1111-1120 라인) 직후. 단, **에러/취소 분기에서도 ledger를 쓴다** — status 컬럼으로 구분.

라인 1111-1120 (정상 종료) 직전 또는 직후에 다음과 같은 호출 추가:

```ts
// after `yield makeEvent('delegation_closed', ...)` (line 1119)
await maybeWriteLedger({
  sessionId,
  team,
  fromNode,
  target,
  task,
  output: subOutput,
  status: 'completed',
  depth,                          // 부모 depth (target depth - 1)
})
```

`maybeWriteLedger` 는 내부에서 `depth + 1 >= 1` 체크 (즉 항상 true — `runDelegation` 은 정의상 sub-agent를 호출하므로 child depth가 1 이상). 그러나 정책 명시를 위해 가드는 둔다. **Root Lead 의 자기 turn에서는 `runDelegation` 이 안 불리므로 ledger write가 자연스럽게 발생하지 않는다.**

에러 분기 (1098-1108) 와 cancel 분기 (`delegation_closed` with `error: true`) 도 동일 헬퍼 호출, status 만 `'errored'` 또는 `'cancelled'`.

### 3.2 Domain 결정 우선순위

```
1. team.yaml 의 `domain:` 필드 (string)
2. fallback: team.id
```

`apps/web/lib/server/engine/team.ts:41-57` `TeamSpec` 에는 현재 `domain` 필드가 없다. 추가 작업:

- `TeamSpec` 인터페이스에 `domain?: string` 추가.
- `toTeamSpec` 정규화에 `domain: typeof raw.domain === 'string' ? raw.domain : undefined` 추가.
- YAML loader 쪽에서 `domain: research` 같은 표기를 그대로 통과시키게.

(이 작업은 ledger spec의 일부로 처리. 다른 spec과 충돌 없음.)

### 3.3 Summary 전략

기본은 **heuristic** — LLM 추가 호출 없음. 토큰/지연 0.

```ts
function heuristicSummary(output: string, artifactPaths: string[]): string {
  const trimmed = output.trim()
  if (trimmed.length <= 700) return trimmed
  const head = trimmed.slice(0, 500).trim()
  const tail = trimmed.slice(-200).trim()
  const fileNames = artifactPaths.map(p => p.split('/').pop()).filter(Boolean).join(', ')
  const filesNote = fileNames ? `\n[artifacts: ${fileNames}]` : ''
  return `${head}\n…\n${tail}${filesNote}`
}
```

**옵션:** `OPENHIVE_LEDGER_SUMMARY=llm` env 가 set되면 별도 LLM 호출로 1-2문장 요약을 만든다. **본 스펙은 인터페이스만 정의** — 구현은 후속 plan(아마도 A2 hooks 와 같이).

```ts
// 인터페이스 (실제 구현은 deferred)
async function llmSummary(opts: {
  output: string
  task: string
  team: TeamSpec
  fromNode: AgentSpec
}): Promise<string> {
  throw new Error('OPENHIVE_LEDGER_SUMMARY=llm not yet implemented')
}
```

### 3.4 Artifact paths 추출

`runDelegation` 시점에는 child 가 만든 artifact 정보를 직접 참조하기 까다롭다. 두 가지 source:

1. **`subOutput` 텍스트 내 path 패턴 추출** — child가 보고서에 "산출물: `~/.openhive/sessions/.../artifacts/foo.csv`" 라고 적은 경우. 정규식: `/(~?\/[\w./-]+\/artifacts\/[\w./-]+)/g`. 0~N 매칭.
2. **세션 artifact registry 조회** — `apps/web/lib/server/artifacts.ts` 의 `listArtifactsForSession(sessionId)` 가 있다면 사용. 단, child sub-agent 한 번에 만든 것만 골라내려면 timestamp 윈도우 필터가 필요 (delegation open ts ~ close ts 사이). 1차 구현은 (1)만, (2)는 enrichment.

### 3.5 Body 파일 작성

```ts
function bodyRelativePath(ulid: string, ts: number): string {
  const d = new Date(ts * 1000)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `entries/${yyyy}/${mm}/${ulid}.md`
}
```

쓰기는 동기 `fs.writeFileSync` (entry 단위가 작고, 백필 외에는 루프 안 도므로 OK). 디렉터리는 `fs.mkdirSync(..., { recursive: true })`.

### 3.6 ULID 생성

`better-sqlite3` 외 신규 deps 금지가 원칙이지만 ULID는 30줄짜리 자체 구현으로 충분. `apps/web/lib/server/ledger/ulid.ts` 신설:

```ts
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function ulid(ts = Date.now()): string {
  let time = ''
  let t = ts
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let rand = ''
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32]
  return time + rand
}
```

### 3.7 Concurrency / disabled

- `OPENHIVE_LEDGER_DISABLED=1` → `maybeWriteLedger` 가 즉시 return. DB 파일도 안 만든다.
- 동일 회사 동시 sub-agent 가 ledger에 동시 쓰기 → SQLite WAL + 단일 트랜잭션이면 안전. 우리 패턴: per-call `prepare(...).run(...)` 으로 짧은 트랜잭션.
- write 실패는 **runtime을 죽이지 않는다.** `try { ... } catch (e) { console.warn('ledger write failed', e) }` — 보고서 산출이 ledger 때문에 망하면 안 됨.

---

## 4. Read path

### 4.1 두 개 Lead-only tool

`apps/web/lib/server/engine/session.ts:484-487` 의 `if (depth === 0) { tools.push(askUserTool()); tools.push(...todoTools(sessionId)) }` 옆에 추가:

```ts
if (depth === 0 && teamSlugs) {
  const [companySlug] = teamSlugs
  tools.push(...ledgerTools(companySlug))
}
```

### 4.2 `search_history` tool

```ts
{
  name: 'search_history',
  description:
    'Search this company\'s past delegated work. Use this BEFORE starting a ' +
    'large new task to check if a similar piece of work already exists. ' +
    'Returns up to `limit` matching entries, most recent first.',
  parameters: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'FTS5 query. Supports phrase quoting and column filters: domain:research summary:매출.' },
      domain:     { type: 'string', description: 'Optional exact domain filter.' },
      team_id:    { type: 'string', description: 'Optional exact team_id filter.' },
      agent_role: { type: 'string', description: 'Optional exact agent_role filter.' },
      since:      { type: 'string', description: 'ISO date (YYYY-MM-DD). Only entries after this date.' },
      limit:      { type: 'integer', description: 'Default 10, max 50.' },
    },
    required: ['query'],
  },
  handler: async (args) => JSON.stringify(searchLedger(companySlug, args)),
  hint: 'Searching company history…',
}
```

리턴 shape:

```ts
{
  results: Array<{
    id: string
    ts: number
    agent_role: string
    team_id: string
    domain: string
    task: string           // 첫 200자 truncate
    summary: string
    artifact_paths: string[]
  }>,
  total_matched: number    // FTS5 총 매치 수, > limit 일 수도 있음
}
```

### 4.3 `read_history_entry` tool

```ts
{
  name: 'read_history_entry',
  description:
    'Read the full body of a ledger entry by its id. Use after `search_history` ' +
    'when a result looks promising and you need the actual prior output.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Entry id from search_history results.' } },
    required: ['id'],
  },
  handler: async (args) => JSON.stringify(readLedgerEntry(companySlug, String(args.id))),
  hint: 'Reading history entry…',
}
```

리턴:

```ts
{
  full_body: string                       // .md 파일 전체
  artifact_paths: string[]
  meta: {
    id: string
    ts: number
    session_id: string
    team_id: string
    agent_id: string
    agent_role: string
    domain: string
    task: string
    summary: string
    status: 'completed' | 'errored' | 'cancelled'
  }
}
```

### 4.4 SQL — search

```sql
-- 1) FTS match → rowid 후보
WITH matched AS (
  SELECT rowid, rank
  FROM entries_fts
  WHERE entries_fts MATCH @query
)
SELECT
  e.id, e.ts, e.agent_role, e.team_id, e.domain,
  substr(e.task, 1, 200) AS task,
  e.summary, e.artifact_paths
FROM entries e
JOIN matched m ON m.rowid = e.rowid
WHERE (@domain IS NULL OR e.domain = @domain)
  AND (@team_id IS NULL OR e.team_id = @team_id)
  AND (@agent_role IS NULL OR e.agent_role = @agent_role)
  AND (@since_ts IS NULL OR e.ts >= @since_ts)
ORDER BY e.ts DESC
LIMIT @limit;
```

`since` ISO date 는 서버에서 `Date.parse(since)/1000` 으로 변환. `limit` 클램프 1~50 (default 10).

쿼리 빌드 시 FTS5 special char 이스케이프: 사용자 입력 query 가 `:`/`-`/`(`/`)` 등 column-syntax 로 오인되지 않게 — **단, column filter 자체는 허용 의도라서** 일단은 raw pass + 에러 시 catch → "query syntax error" 메시지 리턴.

### 4.5 read entry

```ts
function readLedgerEntry(companySlug: string, id: string) {
  const row = withLedgerDb(companySlug, db => 
    db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as EntryRow | undefined,
  )
  if (!row) throw new Error(`ledger entry not found: ${id}`)
  const bodyAbs = path.join(ledgerDir(companySlug), row.body_path)
  const full_body = fs.readFileSync(bodyAbs, 'utf8')
  return {
    full_body,
    artifact_paths: JSON.parse(row.artifact_paths) as string[],
    meta: { ...row, artifact_paths: undefined, body_path: undefined },
  }
}
```

---

## 5. Globalthis singleton for DB connection

`apps/web/lib/server/ledger/db.ts`:

```ts
import Database from 'better-sqlite3'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { companyDir } from '../paths'
import { LEDGER_SCHEMA_V1 } from './schema'

const LEDGER_DB_KEY = Symbol.for('openhive.ledger.dbCache')

interface LedgerCache {
  conns: Map<string, BetterSqliteDatabase>
  shutdownRegistered: boolean
}

function cache(): LedgerCache {
  const g = globalThis as Record<symbol, unknown>
  let c = g[LEDGER_DB_KEY] as LedgerCache | undefined
  if (!c) {
    c = { conns: new Map(), shutdownRegistered: false }
    g[LEDGER_DB_KEY] = c
  }
  return c
}

export function ledgerDir(companySlug: string): string {
  return path.join(companyDir(companySlug), 'ledger')
}

function ledgerDbPath(companySlug: string): string {
  return path.join(ledgerDir(companySlug), 'index.db')
}

function ensureSchema(db: BetterSqliteDatabase) {
  db.exec(LEDGER_SCHEMA_V1)
  // version 기록 (idempotent)
  const existing = db.prepare(
    `SELECT 1 FROM schema_migrations WHERE version = 1`,
  ).get()
  if (!existing) {
    db.prepare(
      `INSERT INTO schema_migrations (applied_at, version, note) VALUES (?, 1, ?)`,
    ).run(Date.now(), 'initial')
  }
}

function open(companySlug: string): BetterSqliteDatabase {
  fs.mkdirSync(ledgerDir(companySlug), { recursive: true })
  const db = new Database(ledgerDbPath(companySlug))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  ensureSchema(db)
  return db
}

export function withLedgerDb<T>(
  companySlug: string,
  fn: (db: BetterSqliteDatabase) => T,
): T {
  if (process.env.OPENHIVE_LEDGER_DISABLED === '1') {
    throw new Error('ledger disabled')
  }
  const c = cache()
  let conn = c.conns.get(companySlug)
  if (!conn) {
    conn = open(companySlug)
    c.conns.set(companySlug, conn)
  }
  if (!c.shutdownRegistered) {
    c.shutdownRegistered = true
    const closeAll = () => {
      for (const db of c.conns.values()) {
        try { db.close() } catch { /* ignore */ }
      }
      c.conns.clear()
    }
    process.once('SIGTERM', closeAll)
    process.once('SIGINT', closeAll)
    process.once('beforeExit', closeAll)
  }
  return fn(conn)
}
```

**HMR 안전:** Vite dev / tsx watch 에서 모듈이 reload 되어도 `globalThis[Symbol.for(...)]` 는 process 단위 키라 connection cache 가 유지된다. 반대로 중복 open 도 안 일어난다.

**참고:** `team-data.ts:40-48` 는 per-call open/close 패턴인데 ledger는 (1) 회사 단위라 개수가 적고 (2) write hook이 sub-agent마다 호출돼서 빈도가 높다 → cache 유지가 더 효율적이다. 메모리 부담은 회사 수 × ~50KB.

---

## 6. Write API 본체

`apps/web/lib/server/ledger/write.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { withLedgerDb, ledgerDir } from './db'
import { ulid } from './ulid'
import type { TeamSpec, AgentSpec } from '../engine/team'

interface WriteOpts {
  sessionId: string
  team: TeamSpec
  target: AgentSpec               // sub-agent (실제 작업자)
  task: string
  output: string
  status: 'completed' | 'errored' | 'cancelled'
  companySlug: string             // ctx.teamSlugs[0]
}

const ARTIFACT_RE = /(~?\/[\w./-]+\/artifacts\/[\w./-]+)/g

function extractArtifactPaths(output: string): string[] {
  const seen = new Set<string>()
  for (const m of output.matchAll(ARTIFACT_RE)) seen.add(m[1])
  return Array.from(seen)
}

function heuristicSummary(output: string, artifacts: string[]): string {
  const trimmed = output.trim()
  if (trimmed.length <= 700) return trimmed || '(empty output)'
  const head = trimmed.slice(0, 500).trim()
  const tail = trimmed.slice(-200).trim()
  const files = artifacts.map(p => p.split('/').pop()).filter(Boolean).join(', ')
  const note = files ? `\n[artifacts: ${files}]` : ''
  return `${head}\n…\n${tail}${note}`
}

export async function maybeWriteLedger(opts: WriteOpts): Promise<void> {
  if (process.env.OPENHIVE_LEDGER_DISABLED === '1') return
  try {
    const ts = Math.floor(Date.now() / 1000)
    const id = ulid()
    const artifacts = extractArtifactPaths(opts.output)
    const summary = heuristicSummary(opts.output, artifacts)
    const domain = (opts.team as TeamSpec & { domain?: string }).domain ?? opts.team.id
    const bodyRel = bodyRelativePath(id, ts)
    const bodyAbs = path.join(ledgerDir(opts.companySlug), bodyRel)
    fs.mkdirSync(path.dirname(bodyAbs), { recursive: true })
    fs.writeFileSync(bodyAbs, renderBody({
      id, ts, opts, artifacts, summary, domain,
    }))
    withLedgerDb(opts.companySlug, db => {
      db.prepare(`
        INSERT INTO entries (
          id, ts, session_id, team_id, agent_id, agent_role,
          domain, task, summary, artifact_paths, body_path, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, ts, opts.sessionId, opts.team.id, opts.target.id, opts.target.role,
        domain, opts.task, summary, JSON.stringify(artifacts), bodyRel, opts.status,
      )
    })
  } catch (e) {
    console.warn('[ledger] write failed', e)
  }
}

function bodyRelativePath(id: string, ts: number): string {
  const d = new Date(ts * 1000)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `entries/${yyyy}/${mm}/${id}.md`
}

function renderBody(args: {
  id: string; ts: number; opts: WriteOpts; artifacts: string[]; summary: string; domain: string
}): string {
  const { id, ts, opts, artifacts, summary, domain } = args
  const fm = [
    '---',
    `id: ${id}`,
    `ts: ${ts}`,
    `session_id: ${opts.sessionId}`,
    `team_id: ${opts.team.id}`,
    `agent_id: ${opts.target.id}`,
    `agent_role: ${opts.target.role}`,
    `domain: ${domain}`,
    `status: ${opts.status}`,
    'task_excerpt: |',
    ...opts.task.slice(0, 400).split('\n').map(l => '  ' + l),
    'artifact_paths:',
    ...(artifacts.length ? artifacts.map(p => `  - ${p}`) : ['  []']),
    '---',
    '',
    '# Task',
    '',
    opts.task,
    '',
    '# Summary',
    '',
    summary,
    '',
    '# Output',
    '',
    opts.output,
  ].join('\n')
  return fm
}
```

### 6.1 session.ts 통합 지점 (정확한 라인)

`apps/web/lib/server/engine/session.ts`:

- **1119 라인 직전 (정상 종료 `delegation_closed` emit 직전)** — `maybeWriteLedger({ status: 'completed', ... })`
- **1097-1107 (catch 분기)** — `delegation_closed` emit 직전에 `maybeWriteLedger({ status: 'errored', output: msg, ... })`. 단 errored entry 도 ledger에 남길지는 운영 결정. **본 스펙: 남긴다 (디버깅에 유용).** `OPENHIVE_LEDGER_ERRORS=0` 으로 끄는 escape hatch만 명시.
- **1029-1035 (delegation cap 초과)** — ledger write 안 함. 진짜 작업이 일어나지 않은 케이스.
- **1039-1059 (agent_excluded)** — ledger write 안 함. 동일 이유.

`maybeWriteLedger` 호출 시 `companySlug` 는 `state().teamSlugs.get(sessionId)?.[0]` 에서 끌어옴. null 이면 (단독 팀 외 컨텍스트) ledger skip.

---

## 7. Read API 본체

`apps/web/lib/server/ledger/read.ts`:

```ts
import { withLedgerDb, ledgerDir } from './db'
import fs from 'node:fs'
import path from 'node:path'

export interface SearchArgs {
  query: string
  domain?: string
  team_id?: string
  agent_role?: string
  since?: string                  // ISO date
  limit?: number
}

export interface SearchHit {
  id: string
  ts: number
  agent_role: string
  team_id: string
  domain: string
  task: string                    // 200자 truncate
  summary: string
  artifact_paths: string[]
}

export interface SearchResult {
  results: SearchHit[]
  total_matched: number
}

export function searchLedger(companySlug: string, raw: SearchArgs): SearchResult {
  const limit = Math.min(Math.max(raw.limit ?? 10, 1), 50)
  const sinceTs = raw.since ? Math.floor(Date.parse(raw.since) / 1000) : null
  return withLedgerDb(companySlug, db => {
    const filterSql = `
      WITH matched AS (
        SELECT rowid FROM entries_fts WHERE entries_fts MATCH @query
      )
      SELECT
        e.id, e.ts, e.agent_role, e.team_id, e.domain,
        substr(e.task, 1, 200) AS task,
        e.summary, e.artifact_paths
      FROM entries e
      JOIN matched m ON m.rowid = e.rowid
      WHERE (@domain IS NULL OR e.domain = @domain)
        AND (@team_id IS NULL OR e.team_id = @team_id)
        AND (@agent_role IS NULL OR e.agent_role = @agent_role)
        AND (@since_ts IS NULL OR e.ts >= @since_ts)
      ORDER BY e.ts DESC
      LIMIT @limit
    `
    const countSql = `
      SELECT COUNT(*) AS n
      FROM entries e
      JOIN entries_fts f ON f.rowid = e.rowid
      WHERE entries_fts MATCH @query
        AND (@domain IS NULL OR e.domain = @domain)
        AND (@team_id IS NULL OR e.team_id = @team_id)
        AND (@agent_role IS NULL OR e.agent_role = @agent_role)
        AND (@since_ts IS NULL OR e.ts >= @since_ts)
    `
    const params = {
      query: raw.query,
      domain: raw.domain ?? null,
      team_id: raw.team_id ?? null,
      agent_role: raw.agent_role ?? null,
      since_ts: sinceTs,
      limit,
    }
    let rows: Record<string, unknown>[] = []
    let total = 0
    try {
      rows = db.prepare(filterSql).all(params) as Record<string, unknown>[]
      const c = db.prepare(countSql).get(params) as { n: number }
      total = c.n
    } catch (e) {
      throw new Error(`ledger search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return {
      results: rows.map(r => ({
        id: String(r.id),
        ts: Number(r.ts),
        agent_role: String(r.agent_role),
        team_id: String(r.team_id),
        domain: String(r.domain),
        task: String(r.task),
        summary: String(r.summary),
        artifact_paths: JSON.parse(String(r.artifact_paths)),
      })),
      total_matched: total,
    }
  })
}

export interface EntryRead {
  full_body: string
  artifact_paths: string[]
  meta: {
    id: string; ts: number; session_id: string; team_id: string
    agent_id: string; agent_role: string; domain: string
    task: string; summary: string; status: string
  }
}

export function readLedgerEntry(companySlug: string, id: string): EntryRead {
  return withLedgerDb(companySlug, db => {
    const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as
      | (EntryRead['meta'] & { artifact_paths: string; body_path: string })
      | undefined
    if (!row) throw new Error(`ledger entry not found: ${id}`)
    const bodyAbs = path.join(ledgerDir(companySlug), row.body_path)
    const full_body = fs.readFileSync(bodyAbs, 'utf8')
    const meta = { ...row }
    delete (meta as Record<string, unknown>).artifact_paths
    delete (meta as Record<string, unknown>).body_path
    return {
      full_body,
      artifact_paths: JSON.parse(row.artifact_paths),
      meta: meta as EntryRead['meta'],
    }
  })
}
```

---

## 8. Tool registration in `runNode`

`apps/web/lib/server/engine/session.ts`, `runNode` (~ line 484):

```ts
if (depth === 0) {
  tools.push(askUserTool())
  tools.push(...todoTools(sessionId))
  // ⬇ S4
  if (teamSlugs && process.env.OPENHIVE_LEDGER_DISABLED !== '1') {
    tools.push(...ledgerTools(teamSlugs[0]))
  }
}
```

`apps/web/lib/server/ledger/tools.ts`:

```ts
import type { Tool } from '../engine/...'   // 기존 Tool 타입 경로
import { searchLedger, readLedgerEntry } from './read'

export function ledgerTools(companySlug: string): Tool[] {
  return [
    {
      name: 'search_history',
      description:
        'Search this company past completed delegations (work history). ' +
        'Use BEFORE starting a similar task — past outputs and artifacts ' +
        'may be reusable. FTS5 syntax. Returns up to 50 entries, newest first.',
      parameters: {
        type: 'object',
        properties: {
          query:      { type: 'string' },
          domain:     { type: 'string' },
          team_id:    { type: 'string' },
          agent_role: { type: 'string' },
          since:      { type: 'string', description: 'ISO date YYYY-MM-DD' },
          limit:      { type: 'integer' },
        },
        required: ['query'],
      },
      handler: async (args) =>
        JSON.stringify(searchLedger(companySlug, args as never)),
      hint: 'Searching company history…',
    },
    {
      name: 'read_history_entry',
      description:
        'Read full body of a ledger entry by id (returned by search_history).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) =>
        JSON.stringify(readLedgerEntry(companySlug, String((args as { id: string }).id))),
      hint: 'Reading entry…',
    },
  ]
}
```

---

## 9. HTTP API

`apps/web/app/api/companies/[c]/ledger/route.ts` (Hono 라우터 형태로 — 본 프로젝트 Next 제거됨, Hono pattern):

- `GET /api/companies/:c/ledger?q=...&domain=...&team_id=...&agent_role=...&since=...&limit=...`
  → `searchLedger(c, args)` 결과 JSON.
- `GET /api/companies/:c/ledger/:entryId`
  → `readLedgerEntry(c, entryId)` 결과 JSON.

추가 컨벤션 (다른 회사 라우트 따라):
- 회사 존재 확인: `companyDir(c)` 가 실재해야 200, 아니면 404.
- ledger DB가 아직 없으면 (회사가 한 번도 sub-agent를 안 돌렸으면) `{ results: [], total_matched: 0 }` 반환 — 빈 검색이지 에러 아님.
- error: 400 (잘못된 FTS query), 404 (entry id 없음), 500 (그 외).

UI 통합은 별도 plan. 다만 API endpoint는 Phase 3에 포함.

---

## 10. Configuration (env vars)

| Env | Default | 의미 |
|---|---|---|
| `OPENHIVE_LEDGER_DISABLED` | unset | `1` 이면 write/read 모두 no-op. DB 파일도 안 만든다. |
| `OPENHIVE_LEDGER_SUMMARY` | `heuristic` | `heuristic` 또는 `llm` (`llm` 은 후속 구현). |
| `OPENHIVE_LEDGER_ERRORS` | `1` | `0` 이면 status='errored' entry 안 남김. |

`apps/web/lib/server/config.ts` 의 settings 인터페이스에 ledger 섹션 추가는 **하지 않는다** — config.yaml 설정으로 노출하기엔 운영 토글성 옵션이라 env로 충분. 사용자 visible 설정이 필요해지면 그 때 옮긴다.

---

## 11. Migration / backfill (deferred, stub)

기존 `~/.openhive/sessions/{id}/events.jsonl` 들을 walk 해서 모든 `delegation_closed` 이벤트(단, error 가 false 이고 depth ≥ 1) 를 ledger entry 로 backfill.

`apps/web/scripts/ledger-backfill.ts`:

```ts
// pnpm openhive:ledger:backfill [--company <slug>] [--dry-run]
// 1. sessions/ 디렉터리 순회
// 2. meta.json 에서 team_id, company_slug 끌어옴
// 3. events.jsonl 라인별 파싱
// 4. delegation_opened/closed pair 매칭으로 task + output 복원
// 5. 기존 ledger entries 와 (session_id, ts, agent_id) 중복 체크 후 INSERT
// 6. body 파일은 events.jsonl 에서 재구성
```

**본 스펙은 인터페이스만.** 실제 구현은 phase 4. dry-run 우선 확인 후 회사 단위로 점진 적용.

`package.json` script 추가: `"openhive:ledger:backfill": "tsx apps/web/scripts/ledger-backfill.ts"`.

---

## 12. Phases

### Phase 1 — Schema + DB + write hook (필수)

**Files:**
- Create: `apps/web/lib/server/ledger/schema.ts` — `LEDGER_SCHEMA_V1` constant.
- Create: `apps/web/lib/server/ledger/db.ts` — `withLedgerDb`, `ledgerDir`, globalthis cache.
- Create: `apps/web/lib/server/ledger/ulid.ts`.
- Create: `apps/web/lib/server/ledger/write.ts` — `maybeWriteLedger`, helpers.
- Modify: `apps/web/lib/server/engine/team.ts` — `TeamSpec.domain?: string`, `toTeamSpec` 정규화.
- Modify: `apps/web/lib/server/engine/session.ts` (~1097, ~1119) — write hook 3 분기.

- [ ] Step 1: schema.ts 작성, exec 한 번 돌려 빈 DB 생성 확인 (`sqlite3 ~/.openhive/companies/x/ledger/index.db ".schema"`).
- [ ] Step 2: db.ts globalthis cache + WAL pragma. 단위 테스트로 동시 open 시 동일 instance 반환 확인.
- [ ] Step 3: ulid.ts + 100k iter monotonic / unique 검증.
- [ ] Step 4: write.ts heuristic summary + artifact regex 단위 테스트.
- [ ] Step 5: session.ts hook 3 곳 (completed / errored / cancelled). `OPENHIVE_LEDGER_DISABLED=1` 시 no-op 확인.
- [ ] Step 6: 통합 — 더미 team 으로 1-step delegation 실행 → ledger entry 1개 생성 확인.

### Phase 2 — Lead-only read tools

**Files:**
- Create: `apps/web/lib/server/ledger/read.ts` — `searchLedger`, `readLedgerEntry`.
- Create: `apps/web/lib/server/ledger/tools.ts` — `ledgerTools` factory.
- Modify: `apps/web/lib/server/engine/session.ts` (~484) — `runNode` 의 `depth === 0` 분기에 `ledgerTools(...)` 추가.

- [ ] Step 1: read.ts FTS5 query + filter. 단위 테스트 (5개 entry seed → query 별 결과 확인).
- [ ] Step 2: tools.ts factory. 잘못된 FTS query 시 handler 가 string error 리턴 (LLM 이 다음 turn 에 보고 자가 수정).
- [ ] Step 3: session.ts depth=0 가드. 통합: Lead가 search_history 호출 → tool_result 에 검색 결과 도달.

### Phase 3 — HTTP API

**Files:**
- Create: `apps/web/app/api/companies/[c]/ledger/route.ts` (Hono).
- Create: `apps/web/app/api/companies/[c]/ledger/[entryId]/route.ts` (Hono).

- [ ] Step 1: GET search 엔드포인트 + query string parse.
- [ ] Step 2: GET entry 엔드포인트.
- [ ] Step 3: 회사 미존재 시 404, ledger 미존재 시 빈 결과.
- [ ] Step 4: integration test — curl 로 두 endpoint hit.

UI 통합 (Run 탭에 "회사 히스토리" 패널) 은 별도 plan.

### Phase 4 — Backfill stub

**Files:**
- Create: `apps/web/scripts/ledger-backfill.ts` (stub만, NotImplemented 던지고 dry-run 출력만).
- Modify: 루트 `package.json` — `openhive:ledger:backfill` script.

- [ ] Step 1: argv parse, sessions/ 순회 prototype.
- [ ] Step 2: dry-run 모드 — 만들어질 entry 수만 출력.
- [ ] Step 3: 실제 INSERT 는 후속 plan 에서.

---

## 13. Test plan

### 13.1 단위 테스트

`apps/web/lib/server/ledger/*.test.ts`:

- **db.test.ts**
  - 같은 companySlug 두 번 `withLedgerDb` → 같은 instance 객체.
  - `OPENHIVE_LEDGER_DISABLED=1` → throw.
  - 신규 회사 → `index.db` 파일 + `schema_migrations` v1 row 자동 생성.
- **ulid.test.ts**
  - 10k 호출 모두 unique.
  - timestamp 순으로 lexicographically sort.
- **write.test.ts**
  - heuristic summary 짧은 출력 (<=700) 그대로 / 긴 출력 head…tail 형식.
  - artifact regex 실제 path 추출.
  - body 파일 작성 위치 = `entries/{yyyy}/{mm}/{ulid}.md`.
- **read.test.ts**
  - 5개 entry seed (서로 다른 domain/team/role).
  - `searchLedger({ query: '매출' })` → 매칭만 반환.
  - `domain` filter 동작.
  - `since` filter (ts cutoff).
  - `limit` 클램프 (60 → 50).
  - 없는 id → throw.

### 13.2 통합 테스트

`apps/web/lib/server/engine/session.test.ts` 에 신규 케이스:

- **3-step delegation → 3 ledger entry**
  - Lead → A → (return), Lead → B → (return), Lead → C → (return)
  - ledger 에 정확히 3 entry, 각 agent_id 다름, domain = team.id (team.yaml domain 미지정 시).
- **`team.yaml` 의 `domain: research` 명시 → 모든 entry 의 domain = 'research'**
- **`search_history` tool call 라운드트립**
  - Lead 가 첫 turn 에 search_history({ query: 'foo' }) → tool_result 가 history 에 누적 → Lead 다음 turn 정상 진행.
- **`read_history_entry` body 일치**
  - 방금 작성한 entry id 로 read → full_body 안에 원본 output 문자열 포함.
- **depth === 0 만 ledger write 안 함**
  - Lead 1턴짜리 single-agent run (sub-agent 없음) → ledger entry 0.
- **`OPENHIVE_LEDGER_DISABLED=1`**
  - 위와 같은 시나리오 → DB 파일 미생성, ledgerTools registration 도 skip → tools 목록에 search_history 없음.
- **에러 분기**
  - sub-agent 가 throw → status='errored' entry 1 row + body 파일에 error message 기록.
  - `OPENHIVE_LEDGER_ERRORS=0` → entry 미생성.

### 13.3 성능 테스트

- 100 entry seed (heuristic summary 평균 600 chars) → `searchLedger({ query: 'foo' })` < 50ms (CLAUDE.md 글로벌 기준 #3).
- 10k entry seed → < 200ms (회귀 시그널).

### 13.4 HTTP smoke

```sh
curl -s 'http://localhost:4483/api/companies/acme/ledger?q=매출&limit=5' | jq
curl -s 'http://localhost:4483/api/companies/acme/ledger/01HX...' | jq
```

---

## 14. Risks / 주의

- **FTS5 query syntax 노출.** 사용자/LLM 이 raw query 를 넣으니 예약어(`AND`, `OR`, `NOT`, `:`, `*`, `^`, `"`) 가 의도와 다르게 동작 가능. 1차: 그대로 통과 + 에러 시 메시지. 2차(필요 시): tool description 에 syntax 가이드 + escape helper.
- **i18n.** `search_history` / `read_history_entry` tool 의 `description` 는 LLM-facing 영문 (다국어 X). UI 가 추가될 때 (별도 plan) `apps/web/lib/i18n.ts` 에 `ledger.searchTitle`, `ledger.empty`, `ledger.openEntry`, `ledger.filter.domain`, `ledger.filter.since` 등 키 추가 — `en` + `ko` 동시. 본 스펙엔 UI 없음.
- **CJK tokenizer 한계.** unicode61 은 한글 띄어쓰기 단위 토큰화. "매출보고서" 한 단어는 통째 토큰. 사용자가 검색어로 "보고서"만 치면 매칭 안 될 수 있음 → prefix(`보고서*`) 권장. 후속에 trigram tokenizer 도입 고려.
- **DB 잠금.** WAL + cached connection 라 단일 process 내 동시 write 안전. 다만 백필 스크립트가 별도 process 로 돌면 충돌 가능 → 백필은 서버 stop 권장 + 명시 README.
- **borderline 데이터 분류.** 디자인 데이터 (`company.yaml`) 와 ledger 가 같은 회사 디렉터리에 공존 — 회사 export/share 시 ledger 디렉터리 제외하는 책임은 export 도구에. README/CLAUDE.md 업데이트로 명시.
- **schema 진화.** v2 ALTER 가 필요해지면 `schema_migrations` 의 version 체크 후 conditional ALTER. 기존 entry rebuild 가 필요한 변경(컬럼 의미 변경 등) 은 백필 스크립트 재실행 정책으로.
- **artifact path 유실.** sub-agent 가 path 를 본문에 명시 안 하면 (e.g. summary table 형태) regex 가 못 잡는다. 2차 enrichment 로 sessions 의 artifact registry 와 timestamp 윈도우로 join 하는 작업 필요 — Phase 외 후속.

---

## 15. Acceptance criteria

1. 100 entry 누적 회사에서 `search_history({ query: 'foo' })` < 50ms.
2. 3-step delegation 후 ledger 에 정확히 3 entry, body file 3개 존재, frontmatter 메타 일치.
3. Lead 가 search_history → read_history_entry round-trip 으로 과거 output 전문 회수 가능.
4. `OPENHIVE_LEDGER_DISABLED=1` 시 DB/디렉터리 미생성, tool 미등록.
5. Vite dev HMR 로 `session.ts` 수정 시 ledger DB connection 누수 없음 (singleton).
6. 동일 회사에 sibling sub-agent 가 동시 종료되어도 두 entry 모두 INSERT (WAL).
7. HTTP API 두 endpoint 정상 응답 + 회사 미존재 시 404.
8. 기존 session 테스트 suite (`session.test.ts`) 회귀 0.
