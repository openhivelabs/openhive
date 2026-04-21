# Spec: 스킬 Auto-Hint

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#5)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

유저가 "PDF 보고서 만들어줘" 해도 Lead 가 `pdf` 스킬 존재를 놓침. 키워드/패턴 매칭으로 첫 turn 시스템 프롬프트 상단에 매칭 스킬 힌트 주입.

- `skills/loader.ts:26-68` SKILL.md frontmatter parser.
- `session.ts:1336-1364` composeSystemPrompt — 힌트 주입 지점.
- `session.ts:406` user task 진입점.
- 번들 스킬 현 frontmatter: name, description. `triggers` 없음.

## 원칙

1. **발견성 우선.** 수십 tokens 감수.
2. **결정론적.** LLM 재호출 없이 정규식/키워드.
3. **Over-match 허용.** "존재" 알림일 뿐, 강제 X.
4. **첫 turn 만.** 이후 turn 재주입 X.

## 변경

### Frontmatter 확장 (`loader.ts:26-39`)

```ts
triggers?: { keywords?: string[], patterns?: string[] }
```

### 매칭 (신규 `skills/auto-hint.ts`)

```ts
export function matchSkillHints(text: string, skills: SkillDef[]): SkillDef[]
```
keywords: 대소문자 무시 includes. patterns: `new RegExp(p, 'i').test`.

### 프롬프트 주입 (`composeSystemPrompt`)

매칭 스킬 있을 때만:
```
You have matching skills for this request:
  - `pdf` — Build PDFs. Consider read_skill_file(skill="pdf") first.
  - `docx` — Build Word documents.
```

### 번들 스킬 업데이트

- `packages/skills/pdf/SKILL.md` — triggers 추가 (en+ko 키워드).
- `docx`, `pptx` 동.
- 번들 전수 audit.

## 테스트

1. 단위: "PDF 보고서" → [pdf], "슬라이드" → [pptx], "hello" → [].
2. 통합: 프롬프트 → 첫 turn system 에 힌트 섹션.
3. 회귀: triggers 없는 custom 스킬 혼재 무사.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| "PDF" 프롬프트 스킬 사용 성공률 | | |
| 잘못된 스킬 호출 | | |

## 롤백

매칭 결과 강제 `[]`.

## 열린 질문

- [ ] triggers 는 en+ko 양쪽 키워드 필수로 — OK?
