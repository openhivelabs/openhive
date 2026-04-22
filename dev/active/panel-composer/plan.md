# Panel Composer — AI 로 조립하는 읽기/쓰기 대시보드

작성: 2026-04-22
범위: Dashboard 페이지에서 AI 가 패널을 생성/수정/삭제하고, 패널을 통해 데이터 **조회 + 입력 + 수정 + 삭제** 까지 가능하게.

---

## 0. 목표와 비-목표

### 목표
- 유저가 Dashboard 에서 자연어로 AI 에게 요청 → 패널 생성/수정/삭제
- 패널은 읽기 전용이 아님: 버튼/인라인 편집/드래그로 **데이터 쓰기**도 수행
- 데이터 소스: 로컬 DB, 로컬 파일, MCP (화이트리스트), http 레시피, http raw(고급)
- 코드 1 줄 몰라도 작동. API 키는 vault 에 저장, 패널 YAML 엔 `auth_ref` 만 저장 → AI 는 키 값을 영영 보지 못함
- 외부 변경(send_email, create_issue 등)은 irreversible 플래그로 extra-confirm

### 비-목표 (v1 밖)
- 커스텀 cell 레이아웃 (셀 수동 배치)
- 실시간 이벤트 푸시 (WS/SSE 팬아웃) — 폴링 + 온디맨드로 시작
- 멀티유저 권한
- 커스텀 MCP 서버 임의 추가 (고급 모드 뒤로 숨기고 v2)
- 패널 간 데이터 조인 (두 소스 합치기)

---

## 1. 아키텍처 개요

```
┌──────────────────── Dashboard 페이지 ──────────────────────┐
│  [Grid of Panels]  각 Panel = {type, binding, actions}      │
│  ↕ 편집 모드 토글                                            │
│  ⌨  하단 고정 AI dock ─ 자연어 요청                          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────── AI Composer (서버) ────────────────────────┐
│ 도구: list_catalog · describe_table · sample_source ·      │
│       propose_panel · commit_panel · edit_panel · delete   │
│ 그라운딩: MCP catalog + DB schema + files + creds + recipes│
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────── Source Resolver ──┬──── Action Executor ──────────┐
│  team_data (SELECT+LIMIT) │  team_data (INSERT/UPDATE/    │
│  team_file (sandbox)      │    soft-DELETE)               │
│  mcp (whitelist)          │  mcp (mutation tools)         │
│  http_recipe (+auth_ref)  │  http_recipe POST/PUT/DELETE  │
│  http_raw (advanced)      │  file (note panel write)      │
│  static                   │                                │
└───────────────────────────┴───────────────────────────────┘
                           │
                           ▼
┌──────────── Credential Vault (fernet) ─────────────────────┐
│  ~/.openhive/credentials.enc.json                          │
│  {ref_id → {kind: oauth|api_key, value, scopes}}           │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 데이터 모델

### PanelSpec (기존 + 확장)
```yaml
id: p-abc123
type: kpi | kpi_strip | table | list | chart | kanban | activity | note
title: "이번 달 딜"
subtitle: optional
colSpan: 1..4
rowSpan: 1..4
binding:
  source:
    kind: team_data | team_file | mcp | http_recipe | http_raw | static
    config: {...}               # kind 별 상이
    auth_ref?: "gmail"           # vault 엔트리 id, NEW
  map:
    rows: "$.items[*]"
    columns: [title, amount, status]
    filter: "amount > 10000"
    aggregate: count | sum | avg | min | max | first
    on_click: {kind: detail | open_url | ask_ai, ...}
  refresh_seconds: 0 | 60 | 300 | 900 | 3600
  actions:                       # NEW — 패널에서 가능한 쓰기 동작
    - id: add-deal
      kind: create
      label: "딜 추가"
      placement: toolbar         # toolbar | row | inline | drag
      form:
        fields:
          - name: title
            label: "딜명"
            type: text           # text|textarea|number|date|datetime|select|toggle
            required: true
          - name: amount
            label: "금액"
            type: number
            min: 0
          - name: status
            label: "단계"
            type: select
            options: [prospect, qualified, won, lost]
            default: prospect
      target:
        kind: team_data
        sql: "INSERT INTO deals (title, amount, status) VALUES (:title, :amount, :status)"
      confirm: false
      irreversible: false
    - id: delete-deal
      kind: delete
      placement: row
      target:
        kind: team_data
        sql: "UPDATE deals SET deleted_at = datetime('now') WHERE id = :id"  # soft-delete
      confirm: true
```

### DashboardLayout
```yaml
blocks: [PanelSpec, ...]
sections?: [{id, title, order, blockIds: [...]}]   # 선택 구분
```

### CredentialEntry
```yaml
ref_id: "gmail"
kind: oauth | api_key
provider?: "google"               # oauth 전용
value_enc: "gAAAAA..."            # fernet 암호화
scopes?: ["gmail.readonly", ...]
added_at: unix-ts
```

---

## 3. 단계별 Spec

### Stage 0 — 기반 (직렬, 선행)
**목표**: 스키마 확장 + vault + 타입 정비. 이후 모든 stage 가 의존.

**구현 사항**
1. `apps/web/lib/api/dashboards.ts`
   - `PanelAction`, `ActionTarget`, `FormField`, `FormSchema` 타입 추가
   - `PanelSource` 에 `auth_ref?: string` 추가
   - `PanelBinding.actions?: PanelAction[]` 추가

2. `apps/web/lib/server/credentials.ts` (신규)
   - `listCredentials(): {ref_id, kind, provider?, scopes?, added_at}[]` (value 빼고)
   - `getCredentialValue(ref_id): string | null` (서버 내부용, API 미노출)
   - `addCredential(entry)` · `updateCredential` · `deleteCredential`
   - 저장: `~/.openhive/credentials.enc.json` (fernet 로 value 암호화)
   - 기존 `oauth.enc.json` 은 유지하되 vault 가 oauth 도 wrapping (향후 통합)

3. `apps/web/server/api/credentials.ts` (신규)
   - `GET /api/credentials` — 리스트 (value 없이)
   - `POST /api/credentials` — 새 API 키 추가 `{ref_id, kind:'api_key', value}`
   - `DELETE /api/credentials/:ref_id`
   - OAuth 경로는 기존 유지, 추후 단일화

4. `apps/web/lib/server/panels/sources.ts`
   - http source 에 `auth_ref` 지원 — resolver 가 vault 에서 읽어 header 주입

**검증**: `pnpm --filter @openhive/web test` 기존 panel tests 안 깨짐. `curl -X POST /api/credentials -d '{ref_id:"test",kind:"api_key",value:"xxx"}'` 후 GET 에서 value 비노출 확인.

---

### Stage 1 — 소스 보강 (Stage 0 후, 내부 A–D 병렬)

**Stage 1A — team_data 개선**
- `describe_table(name)` 서버 함수: PRAGMA table_info + row count + 3 샘플
- `runQuery` — 이미 존재, SELECT-only 검증 + `LIMIT 1000` 하드 캡 재확인
- Source resolver: `:param` 바인딩 지원 (read 도 params 받게)

**Stage 1B — team_file 확장**
- `team_file` source config: `{path, format?: json|csv|md|text}`
- 샌드박스: `~/.openhive/companies/{c}/teams/{t}/files/` 하위만 허용
- CSV → 배열 파싱, MD → {title, body, frontmatter}, JSON → 그대로

**Stage 1C — MCP 카탈로그**
- `listMcpCatalog(): {server_id, label, tools: [{name, description, input_schema, mutates?}]}`
- tools 중 "이름에 create/send/update/delete 포함" 또는 serverside annotation 으로 `mutates: true` 마킹
- mcp manager 에 heartbeat 캐시 — 빠른 응답

**Stage 1D — http recipe 엔진**
- `~/.openhive/recipes/*.yaml` 로더
- Recipe 스키마: `{id, label, panel_type_suggestion, source_template, auth_required, min_refresh_seconds, sample_response?}`
- 레시피 바인딩 시 `config` 에 유저 파라미터 (예: 도시명) 치환 지원

**검증**: 각 A–D 단독 vitest. `GET /api/dashboards/catalog` 에 모두 노출.

---

### Stage 2 — Action Executor (쓰기) (Stage 0·1 후, 내부 병렬)

**Stage 2A — Action schema 검증**
- `apps/web/lib/server/panels/actions.ts` 신규
- `validateAction(spec, values)`: form fields 타입 검사, required, min/max, enum
- `executeAction(panelSpec, actionId, values, ctx)` 디스패처

**Stage 2B — team_data 쓰기**
- SQL 템플릿 허용 키워드: INSERT, UPDATE, DELETE (soft-delete 강제 권장)
- 파라미터 바인딩: `:name` → better-sqlite3 `stmt.run({name: ...})`
- Hard-deny: PRAGMA, ATTACH, DROP, ALTER, multi-statement, comments
- 실행 후 해당 panel 의 source 캐시 무효화 → 자동 refetch

**Stage 2C — MCP 쓰기**
- MCP mutation tool 호출 (Stage 1C 에서 마킹된 tools 중 선택)
- `mutates:true` 인 경우 `confirm:true` 강제

**Stage 2D — file 쓰기 (제한적)**
- v1 엔 note 패널의 markdown 저장만 — `PUT /api/teams/:t/panels/:id/note`
- 테이블/CSV 쓰기는 v2

**Stage 2E — http 쓰기 (recipe 만)**
- POST/PUT/DELETE with `auth_ref` header 주입
- 응답 JSON 파싱 — 실패 시 status code + body 리턴

**Action API 엔드포인트 (공통)**
```
POST /api/teams/:teamId/panels/:panelId/actions/:actionId
  body: { values: Record<string, unknown> }
  → { ok: true, result?: unknown } | { ok: false, error: string }
```

**검증**: 각 B–E 테이블/tool fixture 로 vitest 통합 테스트. 실패 시 캐시 상태 원복.

---

### Stage 3 — AI Composer (Stage 1·2 후, 직렬)

**구현 사항**
1. `apps/web/lib/server/composer/tools.ts` — 아래 도구들 스키마 + 구현
   - `list_catalog()` → `{mcp_servers, recipes, team_tables, team_files, credentials}`
   - `describe_table(name)` → schema + samples
   - `sample_source(source_spec)` → 실제 fetch 1 회, 응답 (+ 2KB 상한) 리턴
   - `propose_panel(spec)` → 서버 검증, preview render 용 payload 리턴 (커밋 안 함)
   - `commit_panel(spec, panelId?)` → dashboard.yaml 에 upsert + 이전 버전 백업
   - `edit_panel(panelId, patch)` — 부분 업데이트
   - `delete_panel(panelId)`

2. `apps/web/lib/server/composer/prompt.ts` — 시스템 프롬프트 + few-shot
   - 하드 규칙: 카탈로그 외 소스 금지 / `map` 작성 전 `sample_source` 필수 / mutation action 엔 confirm 또는 irreversible 마킹 / auth_ref 없이 http 쓰지 말 것

3. `apps/web/server/api/composer.ts` — POST `/api/teams/:teamId/dashboard/compose`
   - 기존 agent engine 재사용하되 도구 세트 제한 + 시스템 프롬프트 주입
   - 스트리밍 (SSE) — 각 도구 호출 상태 실시간 표시

**검증**: "이번 달 매출 KPI 추가해" 시나리오 E2E. AI 가 describe_table → sample_source → propose_panel → commit_panel 순서 타는지 로그 확인.

---

### Stage 4 — Dashboard UI (Stage 0·1·2 병행 가능, 점진 통합)

**Stage 4A — Bound renderers (기존 확장)**
- `BoundPanel.tsx`: 우상단에 `X 분 전` + `🔄` + `⋯` 메뉴 추가
- `⋯` → [AI 로 수정, 직접 편집, 삭제]
- 에러 상태: 마지막 성공값 유지 + "오류: …, 재시도" 링크
- 셀 `on_click.kind === 'ask_ai'` 핸들러: 하단 chat dock 에 행 컨텍스트 주입

**Stage 4B — 편집 모드**
- 페이지 헤더 `[✎ 편집]` 토글
- 편집 모드 시: 드래그 리사이즈 (colSpan 1..4), 드래그 재배치, `+ 패널`, `+ 섹션`
- 저장: 토글 끄면 auto-commit

**Stage 4C — 하단 AI dock**
- 항상 노출된 input + 접히는 chat 영역
- 전송 시 `/api/teams/:teamId/dashboard/compose` 스트리밍, 도구 콜 시각화
- AI 가 `propose_panel` 하면 dashboard 위에 dashed-border preview + "적용 / 취소"

**Stage 4D — 쓰기 UI**
- **Toolbar action**: 패널 제목 옆 `+ 추가` 버튼 → 모달 `<ActionForm />`
- **Row action**: 테이블 행/리스트 아이템 hover 시 `✎` `🗑` 아이콘 또는 kebab
- **Inline**: 더블클릭 셀 → 타입 인풋으로 swap → blur/Enter 저장
- **Drag (Kanban)**: 카드 칼럼 이동 시 `update` 액션 호출 (status 필드)
- **Confirm modal**: `confirm:true` 또는 `irreversible:true` 면 "실행할까요?" + 외부 소스면 "→ [서비스명] 에 전송됨" 힌트

**Stage 4E — 되돌리기**
- 헤더 `⟲ 히스토리` → 최근 10 `dashboard.yaml.v{n}` 리스트 + 프리뷰 + "복원"

---

### Stage 5 — MCP 화이트리스트 + 레시피 라이브러리 (Stage 1 후 병렬)

**Stage 5A — MCP Registry**
- `~/.openhive/mcp/registry.yaml` (앱이 동봉 + 유저 설치 시 merge)
- 7 개 시드: Gmail, Google Calendar, Slack, Notion, GitHub, Linear, HubSpot
- 설정 페이지 → "통합" 섹션: 리스트 + [연결] 버튼 → OAuth flow + MCP 서버 spawn
- 각 서버당 tool 리스트와 `mutates` 플래그 마킹

**Stage 5B — Recipe 라이브러리**
- `~/.openhive/recipes/*.yaml` (앱이 동봉)
- 최소 10 개:
  1. `gmail-unread-count` (kpi)
  2. `gcal-this-week` (list)
  3. `slack-recent-general` (activity)
  4. `notion-today-pages` (list)
  5. `github-my-open-prs` (table)
  6. `linear-my-issues` (table)
  7. `hubspot-open-deals` (kanban, mutates: status 업데이트 포함)
  8. `team-data-deals` (table, v1 의 "쓰기 포함" 쇼케이스)
  9. `weather-city` (kpi, http_recipe + openweather key)
  10. `fx-krw-usd` (kpi, http_recipe, 무인증)
- 각 레시피는 `PanelSpec` 완성본. AI 가 `list_catalog` 로 보고 `commit_panel({...recipeSpec, title:"내 제목"})` 형식으로 씀

---

### Stage 6 — 폴리시/안전망 (Stage 2·5 후)

- **감사 로그**: 모든 action 실행을 team `events.jsonl` 에 `panel.action.*` 이벤트로 append
- **Rate guard**: recipe 당 `min_refresh_seconds` 하한, 유저가 더 짧게 설정 못하게 UI 에서 disable
- **Shape hash**: 소스 응답 `shape_hash` (키 셋 + 배열 여부 요약) 저장. 다음 fetch 시 달라지면 해당 패널 ⚠ 배지
- **Irreversible 모달**: send_email 등 취소 불가 액션은 "실행 전 한 번 더 읽어주세요" 2 단계 confirm
- **Soft-delete**: team_data 스키마에 `deleted_at` 컬럼 추가. `SELECT` 는 자동으로 `WHERE deleted_at IS NULL` 주입하는 옵션. "휴지통" 탭에서 복원 (v2 여도 좋음, v1 은 컬럼만)

---

## 4. 구현 순서 & 병렬화

```
Stage 0 (직렬, ~0.5 일)
   ↓
┌─ Stage 1A  ┐
├─ Stage 1B  ┤  병렬 (~1 일)
├─ Stage 1C  ┤
└─ Stage 1D  ┘
   ↓
┌─ Stage 2A  ┐
├─ Stage 2B  ┤  병렬 (~1 일)
├─ Stage 2C  ┤
└─ Stage 2D  ┘
   ↓
Stage 3 (직렬, ~1 일) ── Stage 5A·5B (병렬, ~0.5 일)
   ↓
┌─ Stage 4A  ┐
├─ Stage 4B  ┤  병렬 (~1.5 일)
├─ Stage 4C  ┤
├─ Stage 4D  ┤
└─ Stage 4E  ┘
   ↓
Stage 6 (~0.5 일)
```

총 ~5–6 영업일 감각. 단독 세션으로 다 못 끝내니 Stage 0, Stage 1A–B, Stage 2A–B, Stage 4A–C 를 오늘 우선 끌어올릴 목표.

---

## 5. 위험 & 미리 박는 안전핀

| 위험 | 방어 |
|---|---|
| AI 가 없는 소스 지어냄 | 시스템 프롬프트 + `list_catalog` 결과만 허용, propose_panel 에서 서버 검증 |
| Shape 바뀌어 매퍼 깨짐 | shape_hash 저장, 변경 시 경고 배지 |
| 실수 삭제 | team_data soft-delete + dashboard.yaml.v{n} 백업 |
| 외부 쓰기 취소 불가 | `irreversible:true` → 2 단계 confirm + 감사 로그 |
| API 키 유출 | vault → 값은 서버 메모리/디스크에만, API 응답에서 영영 빠짐 |
| Rate limit 폭발 | recipe 당 `min_refresh_seconds` 하한, UI disable |
| SQL injection | SQL 템플릿 파라미터만 허용, AI 가 값 concat 금지 프롬프트 |
| AI 환각 매퍼 | `sample_source` 강제, 샘플로 map 만들고 응답 저장 |

---

## 6. 측정할 것
- 첫 패널 생성까지 유저 클릭/타이핑 수 (<= 3)
- AI 가 `sample_source` 를 쓰지 않고 `propose_panel` 하는 비율 (0% 목표)
- 패널 refetch 실패율 (에러 대응 품질)
- 유저가 "되돌리기" 누르는 빈도 (높으면 AI 품질 저조 시그널)
