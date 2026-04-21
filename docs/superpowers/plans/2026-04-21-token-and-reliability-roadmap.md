# OpenHive — 토큰 절감 & 스킬 신뢰성 로드맵

생성일: 2026-04-21
현황 기준 세션: run_efc19360 (baseline) → run_bcfcec24 (1라운드 후)

## Baseline & 현재 수치

| 지표 | Baseline (run_efc19360) | 1라운드 후 (run_bcfcec24) | Python deps + PDF 성공 (run_51fbdc97) |
|---|---:|---:|---:|
| Input tokens | 98,837 | 83,332 (-15.7%) | 16,640 |
| Output tokens | 45,999 | 35,206 (-23.5%) | 9,156 |
| Cache read | 0 (측정 불가) | 46,720 (57% 히트) | 7,040 (42% 히트) |
| Wall time | 15m 17s | 11m 1s | 2m 12s |
| LLM 호출 수 | ? | ? | 7 |
| 모델 | copilot/gpt-5-mini | copilot/gpt-5-mini | copilot/gpt-5-mini |
| 결과물 | PDF 실패 | PDF 실패 (deps) | **PDF 성공 (4.3KB → CJK 폰트 수정 후 85KB)** |
| 비용 | — | — | ~22 cents |

> **주의**: run_51fbdc97 은 Lead → Writer 단순 경로만 탔음 (researcher/reviewer 미호출). 앞선 baseline 두 run은 researcher 까지 타서 더 복잡한 delegation tree. 같은 프롬프트여도 Lead 판단에 따라 경로가 달라져 단순 비교 위험. **Phase B 적용 시 같은 프롬프트로 다시 측정, delegation 경로(얕은/깊은)도 함께 기록할 것.**
>
> 단발 수치는 LLM 비결정성으로 분산 큼. 체감 어려운 미세 변경은 Phase A(벤치마크 하네스)로 3회 평균·표준편차 측정.

### 현재 기준선 (Phase B 시작 전) — run_51fbdc97
- Input **16,640** / Output **9,156** / Cache-read **7,040**
- Wall time **132초**
- LLM 호출 **7회** (Lead 3, Writer 4)
- 가장 큰 단일 호출: Writer 4차 (input 4,775 / output 1,828)
- 이것이 **Phase B 이후 비교 기준점**. 같은 "3개 코딩 어시스턴트 비교 PDF 1p" 프롬프트로 재측정.

### Phase B + C + E 적용 후 — run_2319b484 (2026-04-21 17:02)
- Input **30,041** / Output **8,273** / Cache-read **13,824 (46%)**
- Wall time **128초** (baseline 대비 -3%)
- LLM 호출 **9회** (+29%), 하지만 재현성 확보
- delegate_to 1회, read_skill_file 3회 (cap 내), run_skill_script 1회 단일 성공
- PDF 68KB 정상, Lead 최종 응답 1,351자

**적용된 변경사항 누적**:
- B1: `read_skill_file` elision (run_skill_script 성공 후)
- B2: delegation result 2KB 초과 시 요약 (이번 run에서는 미트리거)
- C1: 같은 (parent→child) delegation 2회 상한 — state().delegations
- C3: `read_skill_file` per-run 8회 상한 + 중복 파일 거부 — state().readSkillFileTotal/Seen
- E: Writer persona 강화 — 성공 후 재생성 금지, 가짜 base64 금지, 에러 2회 실패 시 중단
- 부가: binary 확장자 `read_skill_file` 거부, CJK 폰트 자동 등록

**관찰**:
- 9회 시도 중 기존 4회 성공 / 5회 실패(루프·가짜·중단) → C3 적용 run 1회 성공. 충분한 표본 아님.
- 같은 프롬프트에서도 Lead가 경로를 다양하게 잡음 (Lead→Writer 직결 vs Lead→Boss→researcher 우회). 경로 다양성 자체가 가장 큰 분산 원인. Phase F(provider/model 권장 조합)나 Lead 프롬프트 더 엄격화가 다음 후보.
- baseline 대비 input +80%는 주로 가드레일 rule이 system prompt에 들어간 영향. prompt caching 46% 덕분에 실제 비용 증분은 작음.

---

## 이미 완료 ✅

1. Copilot usage 파싱에 `prompt_tokens_details.cached_tokens` 추가 — 캐시 가시화
2. Anthropic Messages API에 `cache_control: ephemeral` 삽입 (system + 마지막 tool + 마지막 message)
3. 시스템 프롬프트 다이어트 (`buildRelaySection`, `describeTeamForAgent` 축약) — call당 ~300 tokens ↓
4. Python 스킬 의존성 설치 (reportlab / python-docx / python-pptx / pypdf / Pillow / lxml / httpx)

---

## 다음 작업 (우선순위 순)

### Phase A — 벤치마크 하네스 + 성공 baseline
목적: 주관적 비교 대신 **수치 기반 A/B**. 이후 모든 Phase는 같은 하네스로 측정.

- [ ] **A1**. 고정 테스트 프롬프트 3개 정의 (짧음/중간/긴). 각 프롬프트는 성공 판정 가능한 아티팩트 목표 명시 (PDF 1p / DOCX 보고서 / PPTX 10장).
- [ ] **A2**. `scripts/bench.mjs` — run 자동 기동, ask_user 자동 응답(기본 옵션1), 완료까지 대기, 결과 수집.
- [ ] **A3**. 자동 성공 판정:
  - 아티팩트 파일 존재 ✓
  - 파일 크기 > 최소 임계치 (PDF 5KB, DOCX 10KB 등) ✓
  - 파일 내용 기본 grep (기대 섹션 헤더/표 키워드 포함) ✓
- [ ] **A4**. 측정 필드: **토큰(in/out/cache), wall time(초), 성공 0/1, LLM 호출 수, 최대 델리게이션 깊이, 에이전트별 분포**.
- [ ] **A5**. 결과를 `bench_results.jsonl`에 append — 시계열로 쌓아서 Phase별 추이 볼 수 있게.
- [ ] **A6**. 의존성 설치된 현 상태에서 성공하는 **baseline run 3회 평균** 확보. 이게 이후 모든 비교의 기준.

### 성공 기준 (각 Phase 이후 공통 체크)
한 Phase 적용 → A의 하네스로 각 테스트 프롬프트 3회 → 다음 모두 기록:
1. 토큰 (input / output / cache_read)
2. **Wall time** (run.started_at → run.finished_at)
3. 성공률 (3회 중 몇 회 아티팩트 정상 생성)
4. LLM 호출 수 (usage_logs 행 수)
5. 최대 델리게이션 깊이 (run_events.depth 최대값)

### Phase B — 큰 절감 (Writer/Lead)
- [ ] **B1**. `read_skill_file` 결과 elision — `run_skill_script` 성공 후 이전 read_skill_file tool_result를 `<elided>`로 치환. Writer input 추가 -30% 기대.
- [ ] **B2**. 델리게이션 결과 요약 치환 — sub-agent의 full output이 parent history에 누적되는 패턴. 2KB 이상이면 요약 + "전문은 artifacts에" 로 치환, 전문은 `run_events`에 보존. Lead/Boss input 급증 억제.

### Phase C — 루프 제어
- [ ] **C1**. Boss의 "REVISED TASK" 재위임 스팸 방지 — 중간관리자가 delegate 결과를 받고 같은 delegate에게 재위임하는 패턴에 count 제한 또는 system prompt에 명시적 금지.
- [ ] **C2**. `max_tool_rounds_per_turn` 기본값 재검토 (현 8 → 5?), `max_delegation_depth` (현 4 → 3?)

### Phase D — 병렬 + 속도
- [ ] **D1**. `delegate_parallel` 확장 — 현재 same-role only. cross-role 동시 위임(예: Writer + Reviewer 병행) 지원.
- [ ] **D2**. 스트리밍 응답 end-of-turn 신호 빨라지도록 stop_reason 처리 점검.

### Phase E — 스킬 신뢰성
- [ ] **E1**. `run_skill_script` 실패 시 Writer retry 가이드 강화 — JSON 검증 먼저 하라는 지침 추가.
- [ ] **E2**. 스킬별 의존성 선언 — `packages/skills/<name>/requirements.txt` 또는 SKILL.md frontmatter에 명시. 설치 자동화 도구 또는 README 문서.
- [ ] **E3**. 스킬 실행 전 import check — 첫 호출 시 dependency 누락을 LLM-친화적 에러로 보고 (지금은 stdout JSON으로 나오지만 에이전트가 해석 못함).

### Phase F — Provider 라우팅 최적화
- [ ] **F1**. 에이전트별 provider/model 가이드라인 문서화 — Lead=Claude Code (쿼터 캐시 혜택↑), researcher=Copilot (양 많음), Writer=Claude Code (스킬 능숙도↑) 같은 권장 조합.
- [ ] **F2**. 노드 에디터 UI에 provider 추천 힌트.

### Phase G — 측정/관측 강화
- [ ] **G1**. `usage_logs`에 system/tools/history 토큰 분리 기록 (현재는 합계만) → 어느 프롬프트 파트가 비효율인지 세밀히 추적.
- [ ] **G2**. 런 비교 대시보드 — 여러 run의 토큰/시간 추이 시각화.

### Phase H — 기타 수정 잔여
- [ ] **H1**. 동시 run 좀비 정리 UX — 여러 run 중 active 선별 로직은 OK. "stop all running" 같은 일괄 작업 있으면 편함.
- [ ] **H2**. Reviewer가 실제로 호출되는 플로우 보장 — 최근 run에서 Reviewer 스킵되는 경우 있음. Lead 프롬프트에 "writer 뒤 reviewer 필수" 명시할지 검토.
- [ ] **H3**. 아키텍처 다이어그램(`docs/architecture/03-agent-flow.excalidraw`) — 시스템 프롬프트 자동 주입(Your team + relay) 반영 (구현 안정화된 뒤 유저 동의 받고 업데이트).
- [ ] **H4**. 스킬 `--out` 상대경로 → artifact 디렉토리 밖에 파일 생성되는 버그. 현재 `OPENHIVE_OUTPUT_DIR` env는 세팅되는데 Python 스킬 스크립트가 CWD 기준으로 경로를 해석해서 `packages/skills/pdf/` 에 떨어짐. 결과: `~/.openhive/artifacts/{company}/{team}/{run_id}/` 에 등록 안 되고 UI도 산출물 인식 못 함. 해결안: (a) runner가 subprocess CWD를 OUTPUT_DIR로 설정, (b) 스킬 스크립트가 상대경로를 OUTPUT_DIR 기준으로 resolve, 또는 (c) AGENT.md 에 "절대경로 사용 필수" 명시. (a)+(c) 조합 추천.
- [ ] **H5**. 스킬이 생성한 산출물 자동 artifact 등록 — runner가 OUTPUT_DIR 스냅샷을 찍고 새 파일을 `artifacts` 테이블에 insert + `artifact_created` 이벤트 발행. 현재는 이벤트 자체가 없어 UI가 파일을 모름. (H4와 함께 고쳐야 의미 있음.)
- [ ] **H6**. 벤치/디버깅용 이벤트 이름 문서화 — `/tmp/bench_run.mjs` 작성 시 `llm_usage` / `artifact_created` 가 없는 걸 몰라서 토큰 집계 0으로 나왔음. Phase A 하네스 짜기 전에 `runs-store.ts` 의 실제 kind 목록(token, tool_called, tool_result, delegation_opened, node_started/finished, run_started/finished…) 을 한 곳에 모아둘 것.

---

## 진행 원칙

- 한 Phase 적용 후 **동일 프롬프트 run 한 번 더 돌려 수치 기록**. 주관적 느낌 대신 숫자로 비교.
- 토큰뿐 아니라 **실제 아티팩트 생성 성공 여부 + 총 실행 시간**도 같이 봄.
- 큰 변경은 하나씩. 여러 개 번들로 넣으면 어느 게 효과 냈는지 구분 불가.
