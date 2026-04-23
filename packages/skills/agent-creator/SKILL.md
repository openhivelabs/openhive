---
name: agent-creator
description: Scaffold an OpenHive agent persona as AGENT.md plus an optional flat reference/ directory. Use when the user asks to design a new reusable agent rather than wiring an inline prompt on the canvas.
---

# agent-creator

OpenHive 에이전트의 persona 를 **`AGENT.md` + 평면 `reference/`** 구조로 만드는 스킬. `/api/agents/generate` 의 3-pass 파이프라인이 이 포맷을 따른다.

> 네이밍: 스킬(capability)은 `SKILL.md`, 에이전트(persona)는 `AGENT.md` 로 분리한다. 이 스킬 파일(`packages/skills/agent-creator/SKILL.md`) 은 스킬이고, 산출물은 `AGENT.md` 번들이다.

## 폴더 레이아웃

```
<agent-name>/
├── AGENT.md              # 필수. 진입점 (frontmatter + Persona + Decision tree + Reference index + Escalation).
└── reference/            # 선택. 필요할 때만 생성. 평면 — 하위 폴더 없음.
    ├── <topic-a>.md
    └── <topic-b>.md
```

폐기된 예전 구조: `knowledge/`, `behaviors/`, `examples/` 3분할 → 사용하지 말 것. 전부 `reference/` 로 평면화.

## 언제 reference 파일을 만드나

- 유저가 description 에서 **구체적으로 이름 붙여 언급한** 조사 방법·산출물·상황·도메인이 있을 때만.
- 일반 역할 (예: "요약 에이전트", "번역 에이전트") 은 `AGENT.md` 하나로 충분. reference 만들지 말 것.
- 각 reference 는 **독립 주제 하나**. 두 주제가 겹치면 하나로 합친다.

## 생성 파이프라인 (3-pass)

서버(`apps/web/server/api/agents.ts`) 가 유저 description 한 줄을 받아 세 번의 LLM 호출로 번들을 완성한다. 세 호출 모두 유저의 **defaultModel** 로 실행.

1. **Planner** — description 에서 reference 토픽을 뽑는다. 각 토픽은 description 원문에서 그대로 인용한 `evidence` 필드를 가져야 하며, 서버가 substring 으로 검증한다. 구체 단서가 없으면 `references: []`.
2. **AGENT.md writer** — role / label / reference 파일명 목록을 컨텍스트로 받아 본문을 쓴다. reference 내용은 여기 **인라인하지 않는다**.
3. **Reference writer (병렬)** — Pass 1 이 뽑은 토픽마다 한 호출씩 `Promise.allSettled`. 하나 실패해도 AGENT.md + 나머지 파일은 살아남는다.

숫자 상한("5개까지") 은 **프롬프트에 절대 노출하지 않는다** — 모델이 상한을 타겟으로 취급하기 때문. 상한은 서버 단 JSON 검증에서만 적용.

## AGENT.md 표준 형식

```markdown
---
name: <slug>
description: <one-line purpose>
model: <provider:model>   # optional — 팀 기본 모델을 오버라이드
skills: [pptx, docx]      # optional — tools.yaml 이 우선
mcp: [notion, gmail]      # optional
---

# Persona
한 문단. 성격·책임·톤.

# Decision tree
if-then 규칙. 상위 80% 케이스만.

# Reference index          ← reference 가 없으면 이 섹션 자체 생략.
- reference/<file>.md — <한 줄 설명>

# Escalation
중단·사용자 확인·Lead 위임 조건.
```

- 전체 크기 ~2KB 이하.
- 명령형·구체 표현.
- Reference 를 인라인하지 말 것 — 파일명만 기록.

## Reference 파일 규칙

- 파일명: 소문자, 하이픈, `.md`. 예: `academic-paper-search.md`, `citation-style.md`.
- 본문: 200–600 단어. 체크리스트·절차·구체적 출처/도구 중심. 추상 설교 금지.
- YAML frontmatter 없음, level-1 heading 없음.
- 한 주제만 다룰 것 — AGENT.md 나 이웃 reference 와 중복 금지.

## 제약

- `tools.yaml` 은 persona 수준 권한 제한용으로만 선택적 — 대부분 불필요. 팀 allow list 가 상위에서 권한을 결정한다.
- 파일명은 `[a-z0-9][a-z0-9-]*\.md` 만 통과. 공백·대문자·특수문자 금지.
- persona `name` 은 팀 내 유일.
