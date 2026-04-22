# Panel Composer — Context

Last Updated: Lead - 초안 작성

## 이미 깔린 인프라 (재사용)
- `apps/web/lib/api/dashboards.ts` — PanelSpec/PanelSource/PanelMap/PanelBinding 타입
- `apps/web/lib/server/panels/sources.ts` — mcp/team_data/http/file/static 리졸버 (http 에 auth_ref 없음 — Stage 0 에서 추가)
- `apps/web/lib/server/panels/mapper.ts` — jsonpath + 필터 + aggregate
- `apps/web/lib/server/panels/cache.ts` — panel_id 단위 FS 캐시
- `apps/web/lib/server/panels/refresher.ts` — 스케줄러 refresh
- `apps/web/lib/server/panels/templates.ts` — panel-templates (레시피 전신)
- `apps/web/lib/server/crypto.ts` — fernet encrypt/decrypt (vault 재사용)
- `apps/web/lib/server/tokens.ts` — OAuth 토큰 store (vault 통합 대상)
- `apps/web/lib/server/mcp/manager.ts` — MCP 매니저, `callTool`
- `apps/web/lib/server/team-data.ts` — `runQuery` (SELECT)
- `apps/web/components/dashboard/BoundPanel.tsx` — 렌더러 (cell on_click 있음)
- `apps/web/components/dashboard/AiEditDrawer.tsx` — 이미 존재! AI 편집 UI 재사용 후보

## 신규 파일 (예정)
- `apps/web/lib/server/credentials.ts` — vault
- `apps/web/server/api/credentials.ts` — REST
- `apps/web/lib/server/panels/actions.ts` — action executor
- `apps/web/lib/server/composer/{tools,prompt}.ts` — AI composer
- `apps/web/server/api/composer.ts` — compose endpoint
- `apps/web/components/dashboard/ActionForm.tsx` — form renderer
- `apps/web/components/dashboard/DashboardAiDock.tsx` — 하단 AI dock
- `apps/web/components/dashboard/EditModeToolbar.tsx`
- `~/.openhive/mcp/registry.yaml` — 시드 7 개
- `~/.openhive/recipes/*.yaml` — 시드 10 개

## 규칙 (CLAUDE.md 파생)
- 엔진 상태는 FS-only. Dashboard write 는 team data.db (도메인) 에는 쓰되 시스템 상태 절대 안 섞음
- 모든 패널 액션 실행을 team events.jsonl 에 panel.action.* 이벤트로 append
- Python 재도입 금지 — 모든 엔진 TS
- i18n: 새 UI 문자열 `apps/web/lib/i18n.ts` 에 en + ko 둘 다
- Long-lived 싱글톤은 `globalThis` + `Symbol.for('openhive.*')`

## 작업 분배 (역할)
- **Lead**: 이 문서 + plan.md 유지, Stage 경계 감독, i18n 검수
- **Backend**: Stage 0 vault, Stage 1A–D 소스, Stage 2 executor, Stage 3 composer
- **Frontend**: Stage 4 UI, Stage 5B 레시피 UI
- **Infra**: Stage 5A MCP registry 시드 + 원클릭 설치 스크립트

## 결정 기록
- **Cell 수동 배치 X**: Panel 만 조립 단위. "kpi_strip" 같은 복합 타입으로 다중 KPI 표현
- **team_data 쓰기 = soft-delete 권장**: 스키마에 `deleted_at` 기본 컬럼 추가
- **mutation 구분**: tool 이름 휴리스틱 + `mutates` 명시 플래그. confirm 자동 on
- **auth_ref 는 AI 비노출**: API 응답에 value 영영 안 나옴
