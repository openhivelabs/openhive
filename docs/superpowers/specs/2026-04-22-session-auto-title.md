# Spec: 세션 자동 제목 생성

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#4)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

사이드바가 session id 또는 goal raw text 만 노출. 첫 user turn 직후 싼 모델로 6-10 단어 제목을 **비동기 생성**해 meta 에 저장.

- `sessions.ts:23-34` SessionMeta — `title?: string | null`.
- `sessions.ts:103-108` writeMeta, `:254-282` listSessions*.
- `app/api/sessions/route.ts:10-25` 사이드바 API.
- `engine/session-registry.ts:131-210` driveSession — hook 지점.
- `providers/models.ts:24-32` 싼 모델 (`copilot/gpt-5-mini`).

## 원칙

1. **UX > token.** 300 tokens 감수.
2. **비동기 fire-and-forget.** 세션 블로킹 금지.
3. **로케일 인식.** 현재 locale 로 생성.
4. **1회만.** 성공 후 재호출 없음.

## 변경

- `SessionMeta.title?: string | null`.
- `updateMeta(sessionId, patch)` helper 존재 확인, 없으면 추가.
- 신규 `lib/server/sessions/title.ts`:
  ```ts
  export async function generateTitle(goal: string, locale: 'en'|'ko'): Promise<string | null>
  ```
  프롬프트: `"Produce a 6-10 word session title in <locale>. Return only the title, no quotes. Goal: <goal>"`. 타임아웃 10s, 실패 시 null.
- `driveSession` 에서 첫 `node_finished` 직후 `generateTitle(...).then(t => updateMeta(id, { title: t }))` — await 안 함.
- UI fallback: title null 이면 goal slice(0, 60). i18n 키 `session.title.generating` 추가 (en/ko).

## 테스트

1. 단위: `generateTitle` mock provider → 적절 문자열.
2. 통합: 세션 시작 수초 내 meta.json 에 title.
3. 실패: provider 401 → title null, 세션 정상 완료.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| 제목 생성 latency | — | |
| 사이드바 식별 주관 점수 | — | |

## 롤백

driveSession 의 호출 한 줄 제거.

## 열린 질문

- [ ] 유저 수동 제목 편집 API 는 follow-up — OK?
- [ ] Provider 우선순위: copilot → anthropic haiku → fallback. OK?
