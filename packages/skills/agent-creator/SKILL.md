---
name: agent-creator
description: Scaffold and validate agent persona directories (AGENT.md + tools.yaml + knowledge/examples/behaviors). Use when the user wants to create a new reusable agent persona rather than just writing an inline prompt on the org chart.
---

# agent-creator

OpenHive 에이전트의 persona 를 **디렉토리 형태** 로 만드는 스킬. 복잡한 agent (도메인 지식 많음, 참고 자료 여러 개, 역할 반복 사용) 에 적합. 간단한 agent 는 Canvas 에서 inline prompt 쓰면 됩니다.

## Decision tree

```
요청이 무엇인가?
│
├─ 새 agent persona 디렉토리 만들기
│   → scripts/scaffold_agent.py --name <name> --template <tmpl> --out <dir>
│     4개 템플릿 제공: lead, researcher, reviewer, writer
│     결과: AGENT.md + tools.yaml + knowledge/ + examples/ + behaviors/
│
├─ 기존 persona 디렉토리 확인
│   → scripts/inspect_agent.py --in <dir_or_md>
│     구조 요약 (파일 목록, tools.yaml 요약, 본문 길이)
│
├─ persona 가 유효한지 검증
│   → scripts/validate_agent.py --in <dir>
│     AGENT.md 필수 필드, tools.yaml 스키마, 참조된 knowledge 파일 존재 여부 체크
│
└─ 단일 파일 persona 만들기 (가벼운 agent)
    → scripts/scaffold_agent.py --name <name> --single-file --out <file.md>
      AGENT.md 1개만 생성 (frontmatter + 본문).
      디렉토리 구조 없이 빠르게.
```

## Persona 구조

```
<name>/
├── AGENT.md              # 필수. 페르소나 진입점.
├── tools.yaml            # 스킬 / MCP / team_data 권한 선언
├── knowledge/            # on-demand 참고 자료
│   ├── <topic>.md
│   └── …
├── examples/             # few-shot 예시 대화
│   └── <scenario>.md
└── behaviors/            # 행동 규칙 (말투, 에스컬레이션 기준 등)
    └── <rule>.md
```

## 단일 파일 대 디렉토리 선택 기준

| 조건 | 사용 |
|---|---|
| 페르소나 설명이 10줄 이하 | 단일 .md |
| 참고 자료 없음 | 단일 .md |
| 여러 팀/회사에서 재사용 | 디렉토리 (Frame 으로 공유) |
| 도메인 지식 10KB 이상 | 디렉토리 (progressive disclosure) |
| Few-shot 예시 필요 | 디렉토리 |

## AGENT.md 표준 형식

```markdown
---
name: sales-lead
description: 영업팀 리드. 신규 기회 분류 + 전략 수립 + 팀원 업무 배분.
model: claude-opus-4-7       # optional — 팀 기본을 오버라이드
skills: [pptx, docx]         # optional — tools.yaml 이 우선이지만 간단한 경우 여기만
mcp: [notion, gmail]         # optional
---

# Persona

한 문단으로 성격과 책임 설명. 존댓말/반말, 형식성, 우선순위 등.

# Decision tree

어떤 종류의 요청이 오면 어떤 스킬/지식을 불러올지 구체적으로.

# Knowledge index

- knowledge/pricing.md — 가격·할인 정책
- knowledge/objections.md — 주요 반론 대응
- examples/discovery-call.md — 첫 미팅 예시

# Escalation

X 조건에 해당하면 CEO 에이전트에 delegate.
```

## 산출물

모든 스크립트는 **stdout 에 JSON 한 줄** 로 결과 보고:

- `scaffold_agent.py` → `{"ok": true, "path": ..., "files": [...]}`
- `inspect_agent.py` → `{"ok": true, "name": ..., "kind": ..., "files": [...]}`
- `validate_agent.py` → `{"ok": true, "warnings": [...]}` 또는 `{"ok": false, "errors": [...]}`

## 제약

- 파일명은 소문자 영문/숫자/하이픈만. 공백 금지.
- persona `name` 은 팀 내에서 유일해야 함 (중복 시 마지막 등록만 유효).
- `tools.yaml` 에 적힌 스킬/MCP 는 팀의 allow 리스트에 포함돼야 실제로 활성됨 (persona 가 권한을 "확장" 할 수는 없음, "제한" 만 가능).
