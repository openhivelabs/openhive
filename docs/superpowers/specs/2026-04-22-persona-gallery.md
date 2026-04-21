# Spec: Bundled Persona Gallery

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#12)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

`packages/agents/` 에 현재 generic-writer / generic-reviewer / generic-lead / generic-researcher 4종. 실제 워크플로우에 자주 등장하는 역할 (code-reviewer, plan-reviewer, editor) 이 빠짐. 유저가 새 팀 만들 때 템플릿 선택만으로 바로 가동되게.

- `packages/agents/generic-writer/AGENT.md` + `tools.yaml` — 포맷 참조.
- `agents/loader.ts:52-65` ToolsManifest, `:261-268` listPersonas.
- `:128-161` parseToolsYaml.

## 원칙

1. **문서적 자료.** 코드 로직 변경 0. 파일만 추가.
2. **품질 > 양.** 5개만 잘 다듬기 (code-reviewer, plan-reviewer, researcher, writer, editor). researcher/writer 는 generic-* 재활용 또는 별도.
3. **i18n 주의.** AGENT.md 본문은 영문 권장 (LLM), 설명은 한글 병기 가능.

## 추가 파일

```
packages/agents/
├── code-reviewer/
│   ├── AGENT.md
│   └── tools.yaml
├── plan-reviewer/
│   ├── AGENT.md
│   └── tools.yaml
├── editor/
│   ├── AGENT.md
│   └── tools.yaml
```

각 AGENT.md:
- Frontmatter: name, description, model (기본 null), knowledge_exposure: summary|full.
- Body: 역할·결정 트리·금기 (generic-reviewer 스타일 참조).

각 tools.yaml 예 (code-reviewer):
```yaml
skills: []
mcp: []
team_data: { read: true, write: false }
knowledge_exposure: summary
notes: "Reviews code for bugs, security, conventions. Never modifies."
```

## UI 노출

`/api/agents` 류 리스팅 경로가 이미 personas 를 반환 — 파일 추가만으로 picker 에 뜬다 (확인 필요).

## 테스트

1. `listPersonas()` 호출 결과에 신규 3종 포함.
2. 노드 에디터에서 선택 가능.
3. 실제 team 에 code-reviewer 끼워 delegate → 정상 동작.

## 측정

측정 항목 없음. 단 "새 유저가 템플릿으로 5분 내 팀 조립 가능" 주관 지표.

## 롤백

디렉토리 3개 삭제.

## 열린 질문

- [ ] AGENT.md 는 영문/한글 혼용? (초안: 영문. LLM 이 읽는 파일.)
- [ ] researcher / writer 도 "generic-*" 외에 특화 버전 추가할지 — Phase 3 내 추가 스펙으로 분리.
