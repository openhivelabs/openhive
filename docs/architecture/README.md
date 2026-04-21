# OpenHive 아키텍처 다이어그램

코드와 함께 살아있는 시각 문서. 구현이 바뀌면 이 다이어그램도 업데이트.

## 보는 법

1. **공유 링크 클릭** — 아래 표의 링크 → excalidraw.com 에서 열림. 팬·줌·편집 가능. 계정 필요 없음.
2. **로컬 파일** — `.excalidraw` 파일을 https://excalidraw.com 에 드래그. 오프라인에서도 작동.

## 다이어그램 (중요도 순)

| # | 파일 | 열기 | 내용 |
|---|---|---|---|
| **03** ⭐ | [`03-agent-flow.excalidraw`](./03-agent-flow.excalidraw) | [열기](https://excalidraw.com/#json=s3GY0eAMSKLWiPmXUckSY,qz9ZCTibfHsKMxh_itPFdg) | **AI 에이전트 동작 과정** — 한 요청이 들어오면 CEO가 어떻게 계획 세우고, 프롬프트 다듬어서 subordinate에게 위임하고, 결과를 합성해서 스트리밍으로 돌려주는지. 턴 내부의 LLM 입력/출력 구조까지 포함. **여기가 메인.** |
| 01 | [`01-system-architecture.excalidraw`](./01-system-architecture.excalidraw) | [열기](https://excalidraw.com/#json=AxwD9iKKHvLI0C_py_RMr,hSplyi_jkUaRdX7lO1mLSA) | 전체 계층 (참고용) — 브라우저·FastAPI·스토리지 배치도 |
| 02 | [`02-delegation-sequence.excalidraw`](./02-delegation-sequence.excalidraw) | [열기](https://excalidraw.com/#json=YxEorp2_B8CMIrtpLYTLg,HtcjXuTBVMaIpqpb7QtiHA) | UML 시퀀스 (참고용) — 이벤트 메시지 흐름 |

## 업데이트 워크플로우

아키텍처가 바뀔 때:

1. `.excalidraw` 파일 수정 (excalidraw.com에 드래그 → 수정 → Save as... 로 덮어쓰기) **또는** Claude에게 재생성 요청 (Excalidraw MCP 사용)
2. `export_to_excalidraw` 툴로 새 공유 링크 생성
3. 이 README의 링크 교체
4. `.excalidraw` 파일 + README 같이 커밋

## 그릴 예정 (상세가 필요해질 때)

- `04-turn-cycle.excalidraw` — 한 에이전트의 턴이 LLM ↔ 툴 호출을 어떻게 반복하는지 (루프 상세)
- `05-parallel-execution.excalidraw` — 병렬 fan-out 구현 시 모습 (현재 diff)
- `06-skill-tool-flow.excalidraw` — 스킬이 툴로 노출되어 PPTX 생성하는 흐름 (Phase 1 구현 시)

## Excalidraw 선택 이유

- 파일이 순수 JSON → diff 가능, Git 친화적
- 손그림 느낌이 "진짜 회사" 바이브에 잘 맞음
- 영원히 무료 (유료 플랜 안 씀)
- PNG/SVG로 내보내기 가능 — 나중에 슬라이드·블로그에 필요하면
