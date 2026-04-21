# Spec: 히스토리 슬라이딩 윈도우

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#11)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

history 는 node 단위로 무한 성장 (`session.ts:405-406`, `providers.ts:45-53` buildMessages 는 trim 없음). 긴 session 에서 context blow-up. 단 **유저가 토큰 각오한 앱**이라 공격적 trimming 금지.

- `providers.ts:45-53` buildMessages.
- `session.ts:329,408-443` maxRounds loop (per-turn).
- `session.ts:405-406` history 초기화 per node.

## 원칙

1. **보수적으로.** 기본 임계 **40턴**(이전 초안 20 → 더 여유). 유저가 토큰 감수한 앱이라 섣부른 요약은 품질 손해.
2. **요약은 assistant role, 고정 label.** 라벨 `<session-earlier-summary>` 로 LLM 이 구분.
3. **Opt-in per-node.** AGENT.md frontmatter `history_window: 40 | 'unlimited'` (기본 40).
4. **캐싱 우선.** 요약보다 Anthropic prefix caching 덕을 보는 게 먼저. 이 기능은 context 상한 근접 시만 발동.

## 변경

- `providers.ts:45-53` buildMessages — 인자에 `windowTurns?: number`.
- 신규 `engine/history-window.ts`:
  ```ts
  export async function compactHistory(
    history: ChatMessage[],
    windowTurns: number,
    summarize: (msgs: ChatMessage[]) => Promise<string>,
  ): Promise<ChatMessage[]>
  ```
  - turn 수 = assistant message 수. threshold 초과 시 앞의 N-window 턴을 한 개 assistant message 로 치환.
  - summarize 는 cheap model (gpt-5-mini / haiku).
- `runNode` (:408-443) 매 turn 시작 시 `history = await compactHistory(...)`.

## 품질 보호

- **delegation 결과·tool_result 는 요약에서 보존 표시.** "이전 턴에 delegate_to(writer) 실행, 결과는 run_events 에" 같은 메타만.
- **첫 user turn 원문은 항상 유지.** 요약 대상에서 제외.
- 요약 실패 시 fallback = 원본 유지(cap 안 걸림).

## 테스트

1. 단위: 50턴 → window=40 적용 후 length=41 (요약 1 + 나머지 40).
2. 통합: 장기 세션 run, 요약 이후 품질 주관 확인.
3. 회귀: 짧은 세션(≤window) 은 no-op.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| 50턴 후 input tokens | | |
| 50턴 후 응답 품질 주관 | | |
| 요약 호출 비용 | — | |

## 롤백

`windowTurns = Infinity` 상수 한 줄.

## 열린 질문

- [ ] 40 vs 60 vs 100 — 초안 40, 실측으로 조정.
- [ ] persona 별 override 기본값 — 초안 "unlimited for Lead, 40 for others" ?
