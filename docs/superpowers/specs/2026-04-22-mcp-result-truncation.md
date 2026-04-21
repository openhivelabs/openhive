# Spec: MCP 결과 truncation

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#1)
작성일: 2026-04-22
상태: 🟡 승인 대기

## 배경

MCP 툴 결과가 LLM history 에 **원본 그대로** 쌓인다. Notion/웹/Supabase 등은 수십 KB~수백 KB 의 긴 텍스트를 흔히 반환하며, 한 번의 호출로 다음 턴 input 이 폭발한다.

- `apps/web/lib/server/mcp/manager.ts:152-179` — `callTool()` 은 content 블록을 `\n` 으로 join 한 string 을 그대로 반환 (길이 제한 없음).
- `apps/web/lib/server/engine/session.ts:627-658` — 엔진 툴 루프는 반환값을 `content` 에 담아 `tool_result` 이벤트로 persist 하고, **delegate_* 가 아닌 한 원본을 history 에 넣는다**. 즉 MCP 결과는 현재 어떤 cap 도 받지 않는다.
- 비교 대상: `summarizeLargeDelegationResult` (session.ts:159-166) 은 2000자 초과 시 head 600자 + 마커로 축약. MCP 에도 동일 패턴 필요.

부가: 대형 결과가 매 턴 history 를 키워 `read_skill_file` 처럼 elide 해도 MCP 결과가 그대로 있으면 효과가 반감. Phase G 측정(`2026-04-21-token-and-reliability-roadmap.md:50-63`)에서 history 가 58% 를 차지 — MCP truncation 은 이 58% 직공격.

## 원칙

1. **원본 손실 금지.** `tool_result` 이벤트는 축약 전 원본으로 persist. UI/디버거/아티팩트 링크에서 full text 복구 가능.
2. **LLM-친화 힌트.** 자르는 것으로 끝나지 않고 "왜 잘렸는지 + 어떻게 좁혀 재호출할지" 한 줄 덧붙인다. 무한 재호출 루프 방지.
3. **MCP 경계에서 자른다.** `mcp/manager.ts` 에서 자르면 콜사이트 하나로 끝. 엔진 툴 루프에는 MCP 감지 로직 넣지 않는다(tool name `${server}__${tool}` 규칙을 엔진이 해석하기 시작하면 추상화가 샌다).
4. **한 가지 수치, 한 군데 상수.** `MCP_RESULT_MAX_CHARS` = `20_000` (확정). `mcp/manager.ts` 상단에 선언. 나중에 `config.yaml` 로 뺄 수 있게 export 는 하지 않음 (YAGNI).

## 목표 / 비목표

**목표**
- MCP 반환 string 이 cap 을 넘으면 head N chars + 꼬리 힌트로 치환.
- 엔진 툴 루프는 변경 없음. 축약 전 원본은 `callTool` 내부에서 잃지만, **엔진이 받는 string = 이미 축약된 것**이고 `tool_result` 이벤트 역시 이 축약본을 저장한다 (아래 FAQ 참조).
- `tool_result` 이벤트 data 에 `truncated: boolean`, `original_chars: number` 필드 추가 → UI 디버거에서 "길이 N 에서 잘림" 배지 표기 가능.

**비목표**
- 요약 LLM 호출 (비용·latency 증가, 이번 단계에선 단순 cut).
- 스트리밍 / chunked 반환 (MCP SDK 가 완성본만 주는 구조).
- 사용자 설정 UI 노출 (내부 상수로 충분).

## FAQ

**Q. 원본이 정말 필요해지면?**
A. 이번 단계에선 "자른 것도 이벤트 저장". 원본을 run_events 에 온전히 남기고 싶으면 `callTool` 이 `{ body, truncated, originalChars }` 를 반환하고 엔진이 원본은 이벤트로, 축약본만 history 로 넣는 구조로 확장 가능. 초기 구현은 단순성 우선 — 유저가 원본을 원할 실 케이스 생기면 확장.

**Q. 20_000 은 근거?**
A. 단일 툴 결과가 한 턴 input 을 지배하지 않는 선에서 실사용 MCP (Notion 페이지 전문, 웹 페치 본문) 가 잘려도 의미 있는 본문이 남도록 넉넉히 잡음. 첫 구현 후 Phase 1 끝나고 숫자 재튜닝 여지.

**Q. 힌트 문구 i18n?**
A. 이 힌트는 LLM 이 읽는 것이지 UI 노출 아님. 영문 고정 (모델은 영문 명령을 잘 이해). UI 가 `truncated` 뱃지를 보일 때만 i18n.ts 에 키 추가.

## 변경 파일

- `apps/web/lib/server/mcp/manager.ts`
  - 상단 `MCP_RESULT_MAX_CHARS` 상수 추가.
  - `callTool` 끝부분 (:174 근방) `body` 생성 직후 길이 체크 → 초과 시 head slice + 힌트 꼬리.
- `apps/web/lib/server/engine/session.ts`
  - `tool_result` 이벤트 payload (line 640) 에 `truncated?: boolean`, `original_chars?: number` 전달하려면 `callTool` 반환 타입 확장 필요 — 하지만 원칙 3 에 따라 엔진을 건드리지 않음. 대안: `callTool` 이 **문자열 그대로 반환**하고, 엔진은 "끝부분에 표준 truncation 마커 `\n\n[openhive:mcp-truncated:` 가 있는지" 감지해 이벤트에 플래그. 혹은 이벤트는 손대지 않고 UI 가 마커를 직접 감지 (가장 단순).
  - **결정: 이벤트 손대지 않는다.** 축약된 본문에 마커가 그대로 들어가므로 UI/디버거가 동일 마커를 인식. 엔진 변경 0.

- `apps/web/lib/i18n.ts` — UI 뱃지 노출 단계에 가서 추가. 이번 스펙 범위 밖.

## 구현 스케치

```ts
// mcp/manager.ts
const MCP_RESULT_MAX_CHARS = 20_000

// callTool 끝부분
const body = pieces.join('\n')
const final = body.length > MCP_RESULT_MAX_CHARS
  ? body.slice(0, MCP_RESULT_MAX_CHARS) +
    `\n\n[openhive:mcp-truncated] Response was ${body.length} chars; showing first ${MCP_RESULT_MAX_CHARS}. Narrow the query (pagination, filter, search term) and call again if more is needed.`
  : body

if ((result as { isError?: boolean }).isError) {
  return `ERROR from ${name}__${toolName}: ${final || 'unknown error'}`
}
return final
```

## 테스트

OpenHive 는 현재 `apps/web` 에 단위 테스트가 없다(`2026-04-21-token-and-reliability-roadmap.md:88` 의 벤치 하네스도 미구현). 이번 항목은:

1. **수동 smoke**: 큰 응답 내는 MCP(예: `notion__search` 또는 `web__fetch`) 1회 호출 → `tool_result` 이벤트 content 끝에 `[openhive:mcp-truncated]` 마커 확인.
2. **단위 테스트 최소 1개 신설** — `apps/web/lib/server/mcp/__tests__/manager.truncation.test.ts` (vitest):
   - `callTool` mock 으로 content 30_000 자 넣고 → 반환 string 길이 ≤ 20_000 + 마커 길이 확인.
   - 9_999 자 → 변경 없음 확인.
   - `isError: true` + 큰 body → ERROR prefix + truncation 마커 공존 확인.
3. **빌드**: `pnpm --filter @openhive/web build` 타입 통과.
4. **실제 세션 1회**: Notion 기반 기본 프롬프트로 run 1회, `~/.openhive/sessions/<id>/events.jsonl` grep `mcp-truncated`.

## 측정

같은 프롬프트(토큰 roadmap `run_51fbdc97` 과 동일 "3개 코딩 어시스턴트 비교 PDF 1p") 로는 MCP 를 거의 안 타므로 이 항목은 Notion/웹 포함 프롬프트가 필요. **새 벤치 프롬프트 정의**:

> "Notion 워크스페이스에서 최근 7일 내 수정된 페이지 5개 찾아서 각 요약을 PDF 1장으로 만들어줘."

3회 평균. 표 양식은 plan 문서의 벤치 표.

## 롤백

단일 함수 내부 변경. 롤백 = commit revert 1개. 상수를 `Infinity` 로 두면 실질적 비활성화도 가능.

## 열린 질문 (승인 시 확정)

- [ ] `MCP_RESULT_MAX_CHARS = 20_000` OK? 혹은 4_000 / 20_000?
- [ ] 힌트 문구 영문 고정 OK? 한국어 이중 표기 불필요?
- [ ] 벤치 프롬프트 "Notion 최근 페이지 요약 PDF" 로 고정 OK?
- [ ] 이 항목 끝내고 바로 #2 (병렬 tool dispatch) 로 넘어가는 순서 OK?
