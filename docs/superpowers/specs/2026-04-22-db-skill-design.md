# db-skill — AI 가 per-team SQLite DB 를 완전 제어하는 tool 번들

**Date**: 2026-04-22
**Status**: Design approved — pending implementation plan

## 배경

OpenHive 는 local-first, single-user. 각 team 은 `~/.openhive/companies/{c}/teams/{t}/data.db` 를 가지고 유저/AI 가 공유하는 도메인 데이터를 저장한다. 초기 상태에는 DB 파일·스키마가 없다 — AI 가 유저와 대화하며 처음부터 스키마를 설계하고 채워 넣는다.

`apps/web/lib/server/team-data.ts` 에 이미 `describeSchema` / `runQuery` / `runExec` / `installTemplate` 가 네이티브 TS 로 구현돼 있지만, 이것을 LLM 에게 노출하는 tool wrapper 는 없다. 또한 AI 가 SQLite·JSON1 을 잘 쓰도록 안내하는 프롬프트·레퍼런스도 없다.

이 스펙은 두 개를 합친 **"db-skill"** 번들을 정의한다: (a) LLM tool 6개 + (b) progressive-disclosure 프롬프트 번들.

## 비-목표

- `openhive.db` (엔진 시스템 상태) 접근 — 도메인 DB 와 섞지 않는다.
- 크로스팀 조인 — 팀별 파일이 격리 경계.
- Python 분석 skill — 필요 생기면 별도 스펙 (deferred).
- 쿼리 캐싱 / 리드 레플리카 / 스키마 린터 — YAGNI.

## 아키텍처 선택

**Native LLM tool + 프롬프트 번들** (Python subprocess skill 아님). 근거:
- DB 호출은 hot-path 이고 한 턴에 여러 번 체인됨 → subprocess cold-start 수백 ms 는 비현실적.
- `team-data.ts` 가 이미 TS 에 있음 — 중복 구현 회피.
- 기존 skill 프로토콜 (Python envelope) 은 artifact 생성용.

코드는 `apps/web/lib/server/tools/team-data-tool.ts` 에, 프롬프트는 `packages/skills/db/` 에 둔다 (사람이 읽는 레퍼런스 위치로서의 "skill" 이름 재사용; 런타임 서브프로세스 아님).

## Tool 표면

모든 tool 은 delegation frame 에서 (company, team) 을 읽는다. LLM 은 슬러그를 전달하지 않는다.

### `db.describe()`
- 반환: `{tables: TableInfo[], recent_migrations: MigrationRow[], size_bytes: number, empty: boolean, hint?: string}`
- `empty: true` (테이블 0개) 이면 `hint: "Design schema via db.exec(CREATE TABLE ...). Read hybrid-schema guide first if unfamiliar."` 동봉 — 부트스트랩 신호.
- `describeSchema` 래핑 + size/empty/hint 추가.

### `db.query(sql, params?, limit=500)`
- SELECT / WITH 만 허용. 다른 키워드는 `{error_code: "not_a_select"}`.
- `params`: `?` 바인딩 배열. 미사용 허용하되 description 이 강하게 권장.
- `limit` 하드 cap: `OPENHIVE_DB_QUERY_LIMIT` (기본 500, 최대 5000). 결과가 limit 에 닿으면 `truncated: true`.
- 단일 statement 강제 — `;` 이후 비공백+비주석 있으면 `{error_code: "multi_statement"}`.
- 타임아웃: `OPENHIVE_DB_QUERY_TIMEOUT_MS` 기본 10000. 초과 시 `conn.interrupt()` → `{error_code: "timeout"}`.
- 반환: `{columns, rows, truncated, elapsed_ms}`.

### `db.exec(sql, params?, note?, confirm_destructive?)`
- INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / RENAME / TRUNCATE.
- 단일 statement + 타임아웃: `db.query` 와 동일.
- **Destructive 감지**: `DROP TABLE`, `DROP INDEX`, `TRUNCATE`, `WHERE` 절 없는 `DELETE` / `UPDATE`. `confirm_destructive: true` 없으면 `{error_code: "destructive_unconfirmed", suggestion: "Re-invoke with confirm_destructive: true after explaining the blast radius to the user."}`.
- DDL 이면 트랜잭션 안에서 `schema_migrations` 에 auto-insert, 반환에 `migration_id` 포함.
- 반환: `{ok, rows_changed, ddl, migration_id?}`.

### `db.explain(sql)`
- `EXPLAIN QUERY PLAN <sql>` 실행 결과 반환. SELECT/WITH 만.
- 반환: `{plan: Array<{id, parent, detail}>}`.

### `db.install_template(template_name)`
- 기존 `installTemplate` 래핑. `tools.yaml` 의 `db.templates` whitelist 체크.
- 반환: `{ok, template, tables_created: string[]}` (설치 전후 스키마 diff 로 계산).

### `db.read_guide(topic)`
- `topic ∈ {"hybrid-schema", "json1", "indexes", "patterns", "perf"}` — 열거형 강제.
- 반환: `{topic, content: string}` (해당 `packages/skills/db/reference/<topic>.md` 의 원문).
- 모르는 topic: `{error_code: "unknown_topic", valid: [...]}`.

## 안전 게이트

### 권한 선언 (`tools.yaml` 확장)

```yaml
db:
  read: true       # false | true
  write: true      # false | true | "ask"
  ddl: true        # false | true | "ask"
  templates: ["crm", "inbox"]   # install_template 허용 목록, 생략 시 빈 배열
```

**기본값 (persona 에 `db:` 키 없음)**: `db.*` tool 자체가 비활성. persona 가 명시적으로 선언해야 활성.

**명시 선언 시 권장 기본값 (local-first, AI 완전 제어 원칙)**: `{read: true, write: true, ddl: true}`. 유저가 보수적 persona 를 원하면 `ddl: "ask"` 등으로 내릴 수 있다.

Persona 는 팀의 allow 리스트 범위 안에서만 제한 가능 — 확장 불가 (기존 규칙 준수).

### 권한 확인 순서
1. `db.*` 호출 시작 → `tools.yaml` 의 `db` 키 존재 확인, 없으면 tool 자체가 LLM 에 노출되지 않음 (엔진 registry 필터).
2. `db.query` → `read: true` 필요.
3. `db.exec` (non-DDL) → `write` 가 `true` 또는 `"ask"`. `"ask"` 면 `pending_approval` 이벤트 발행 + blocking.
4. `db.exec` (DDL) → `ddl` 가 `true` 또는 `"ask"`. `"ask"` 동일 처리.
5. Destructive → 권한 통과 + `confirm_destructive: true` 둘 다 필요.
6. `db.install_template` → 해당 이름이 `db.templates` whitelist 에 있어야 함.

### 거부 시 envelope
모든 거부는 동형: `{ok: false, error_code, message, suggestion}`. LLM 이 자가 교정하도록 `suggestion` 은 다음 행동을 구체적으로 지시.

| error_code | 트리거 |
|---|---|
| `read_denied` / `write_denied` / `ddl_denied` | 권한 부족 |
| `destructive_unconfirmed` | WHERE-없는 DELETE/UPDATE, DROP TABLE 등 |
| `not_a_select` | `db.query` 에 비-SELECT |
| `multi_statement` | 한 호출에 여러 statement |
| `timeout` | 쿼리 타임아웃 |
| `syntax` | better-sqlite3 파싱 에러 |
| `unknown_template` / `unknown_topic` | whitelist 미스 |
| `pending_approval` | `"ask"` 정책, 유저 승인 대기 |

## 프롬프트 로딩 전략 (2-tier)

토큰 효율 최우선. SKILL.md 를 persona 에 자동 주입하지 않는다.

### Tier 1 — tool description 내장 (항상, ~500 토큰, 캐시됨)
각 tool 의 JSON schema `description` 필드에 핵심 원칙을 압축해 박는다. 커버:
- 워크플로: `describe → explain → query/exec`.
- 하이브리드 스키마 한 줄: "Indexable/filterable fields → columns. Extensible tail metadata → `data` JSON."
- 파라미터 바인딩: `?` 강제 권장, 문자열 concat 금지.
- 안전 게이트 요약 (뭐가 거부되는지).
- **부트스트랩 모드**: "Empty DB is the normal starting state — your first job is often to design the schema with the user."
- Tier 2 진입: "For deeper patterns call `db.read_guide(topic)`."

### Tier 2 — `db.read_guide(topic)` on-demand
필요할 때만 개별 파일을 로드.

```
packages/skills/db/
├── README.md                  # 사람용 설계 노트 (자동 주입 안 됨)
└── reference/
    ├── hybrid-schema.md       # 템플릿 컬럼 + JSON1 data 언제 뭐 쓰나
    ├── json1.md               # json_extract / json_set / json_each 레시피
    ├── indexes.md             # expr 인덱스·partial·covering
    ├── patterns.md            # upsert, soft-delete, FTS5, 시계열 롤업
    └── perf.md                # EXPLAIN QUERY PLAN 읽는 법, N+1 회피
```

### 토큰 프로파일 기대값

| 시점 | 토큰 |
|---|---|
| persona 로드 (`db:` 선언 있음) | ~500 (tool description, 캐시) |
| `db.describe` 첫 호출 응답 | ~100 (스키마 + hint) |
| `read_guide('hybrid-schema')` 1회 | ~800 (이후 캐시) |
| 이후 수백 번 query/exec | I/O 만 |

빈 DB 부트스트랩 세션 총 고정비 ~1500 토큰 예산 안에서 스키마 설계 가능.

## 엔진 통합

- Tool registry (`apps/web/lib/server/tools/base.ts` 패턴) 에 등록. persona 의 `tools.yaml` 파싱 단계에서 `db:` 키 유무로 tool 목록에 include/exclude.
- (company, team) 은 엔진이 delegation frame 에 이미 들고 있는 값. tool handler 의 `ctx` 에서 꺼내 사용.
- 각 호출이 typed Event 를 `events.jsonl` 에 append:
  - `db.query.started { sql_preview, params_count }`
  - `db.query.completed { rows, truncated, elapsed_ms }`
  - `db.exec.applied { rows_changed, ddl, migration_id? }`
  - `db.denied { error_code, sql_preview }`
  - `db.pending_approval { sql_preview, kind }`
- Run 캔버스 Timeline 은 이 이벤트들을 다른 step 처럼 자동 렌더. Side channel 만들지 않는다 (아키텍처 규칙).
- `sql_preview` 는 앞 200자 + `...`. 전체 SQL 은 필요 시 별도 inspector 에서 (보안상 이벤트 스트림을 가볍게).

## `team-data.ts` 확장 필요 사항

1. `runQuery(sql, params?)`, `runExec(sql, params?, opts)` — params 바인딩 추가.
2. 단일 statement 가드: `;` 이후 비공백·비주석 감지.
3. Destructive 감지 헬퍼: 정규식 + AST-lite (WHERE 없는 DELETE/UPDATE, DROP/TRUNCATE).
4. 타임아웃 래퍼: `setTimeout(() => conn.interrupt(), ms)` + promise race (better-sqlite3 는 sync 이므로 `conn.interrupt()` 를 시그널 스레드에서 호출).
5. `installTemplate` 에 before/after 스키마 diff 반환 추가.

## 테스트

- **Unit** (table-driven): guard 로직 — SELECT-only, multi-statement, destructive 판정, 권한 매트릭스.
- **Integration**: tmp team → `describe` (empty) → `exec(CREATE TABLE)` → `exec(INSERT)` → `query` → `exec(DROP TABLE)` (confirm 없이 거부, 있으면 통과) → `schema_migrations` 검증.
- **Template**: `install_template("crm")` → `tables_created` 정확성.
- **LLM smoke (수동, 1회)**: 빈 DB + "받은 편지함 분류용 스키마 하나 짜줘. 우선순위·태그·확인 여부 저장" 과제로 tool-call 궤적 검사.

## 구현 순서 (플랜 단계에서 상세화)

1. `team-data.ts` 확장 — params / single-stmt / destructive / timeout / diff. + unit 테스트.
2. `tools/team-data-tool.ts` — 6개 tool + 권한 gate + event emit.
3. `tools.yaml` 스키마 확장 (validator).
4. `packages/skills/db/reference/*.md` 작성.
5. Tool description 에 Tier 1 프롬프트 삽입.
6. 엔진 registry 필터 (persona 의 `db:` 키 유무로 tool include).
7. 통합 테스트 + LLM smoke.

## Open questions (구현 중 결정)

- Destructive 판정을 정규식으로만 가나, 아니면 `sqlite-parser` 같은 경량 파서 붙이나? (정규식은 `DELETE FROM t /* WHERE x */` 같은 주석에 속을 수 있음.) → 1차는 정규식 + 주석 스트립. 파서는 실제 사고 발생 시 도입.
- `"ask"` 승인 UI 는 Run 캔버스의 기존 pending-event 위젯 재사용? → 스케줄러 pause 와 같은 패턴 따라감 (플랜 단계에서 확정).
