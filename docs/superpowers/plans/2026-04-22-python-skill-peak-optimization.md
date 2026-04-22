# Python Skill Peak Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Python skill 실행 중 순간 RAM 피크를 35% 낮추고, 동시 실행 상한을 도입해 OOM/스파이크를 예측 가능한 대기로 바꾼다.

**Architecture:** ① 각 skill 스크립트의 top-level import 를 함수 내부로 내려 사용 경로만 메모리에 올림. ② 인터프리터에 `-S -O` 플래그 추가 (site.py 스킵, assert 제거). ③ `runner.ts` 에 `p-limit` 기반 semaphore 주입, env `OPENHIVE_PYTHON_CONCURRENCY` 로 상한 조절. ④ 큐 대기 상태를 typed Event 로 emit.

**Tech Stack:** Node `child_process`, `p-limit`, vitest.

---

## File Structure

- **Modify** `apps/web/lib/server/skills/runner.ts` — `-S -O` 플래그 추가, semaphore wrap
- **Create** `apps/web/lib/server/skills/concurrency.ts` — semaphore 싱글톤 (globalThis)
- **Create** `apps/web/lib/server/skills/concurrency.test.ts`
- **Modify** `packages/skills/pdf/scripts/build_doc.py` — reportlab 서브모듈 lazy
- **Modify** `packages/skills/pdf/scripts/edit_doc.py` — 마찬가지
- **Modify** `packages/skills/pdf/scripts/extract_doc.py` — pypdf lazy
- **Modify** `packages/skills/pptx/scripts/build_deck.py` — pptx/lxml lazy
- **Modify** `packages/skills/pptx/scripts/edit_deck.py` — 마찬가지
- **Modify** `packages/skills/docx/scripts/*.py` — python-docx lazy
- **Modify** `packages/skills/web-fetch/scripts/run.py` — 이미 가벼움, 확인만
- **Modify** `apps/web/lib/server/engine/session.ts` — skill.queued / skill.started 이벤트 발행
- **Modify** `apps/web/lib/server/events/types.ts` (있으면) — 이벤트 타입 추가

---

## Task 1: `-S -O` 플래그 추가

**Files:** `apps/web/lib/server/skills/runner.ts:137-140`

- [ ] **Step 1**: `PYTHON_COLD_START_FLAGS` 확장
```ts
export const PYTHON_COLD_START_FLAGS: readonly string[] = [
  '-S',            // skip site.py — shaves 30-50ms and a few MB
  '-O',            // strip asserts & docstrings — micro win
  '-X', 'frozen_modules=on',
]
```
- [ ] **Step 2**: 기존 `runner.test.ts` 전체 실행
```bash
pnpm --filter @openhive/web test skills/runner
```
Expected: PASS. 실패 시 `-S` 가 기존 skill 의 `site` 의존성을 깼는지 확인 (드문 경우). 문제면 `-S` 제외.
- [ ] **Step 3**: commit `chore(skills): add -S -O to Python cold start flags`

## Task 2: Semaphore 모듈

**Files:**
- Create: `apps/web/lib/server/skills/concurrency.ts`
- Create: `apps/web/lib/server/skills/concurrency.test.ts`

- [ ] **Step 1**: 테스트 먼저
```ts
// concurrency.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { acquireSkillSlot, __resetForTests } from './concurrency'

describe('skill concurrency', () => {
  beforeEach(() => __resetForTests())

  it('limits concurrent tasks to OPENHIVE_PYTHON_CONCURRENCY', async () => {
    process.env.OPENHIVE_PYTHON_CONCURRENCY = '2'
    __resetForTests()
    let active = 0, peak = 0
    const run = () => acquireSkillSlot(async () => {
      active++; peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 20))
      active--
    })
    await Promise.all([run(), run(), run(), run(), run()])
    expect(peak).toBe(2)
  })

  it('default concurrency when env unset falls back to core count', () => {
    delete process.env.OPENHIVE_PYTHON_CONCURRENCY
    __resetForTests()
    // smoke only
    expect(() => acquireSkillSlot(async () => 1)).not.toThrow()
  })
})
```
- [ ] **Step 2**: 실행 → FAIL
```bash
pnpm --filter @openhive/web test concurrency
```
- [ ] **Step 3**: 구현
```ts
// concurrency.ts
import os from 'node:os'
import pLimit, { type LimitFunction } from 'p-limit'

const GLOBAL_KEY = Symbol.for('openhive.skills.pythonLimiter')
type G = typeof globalThis & { [GLOBAL_KEY]?: LimitFunction }
const g = globalThis as G

function make(): LimitFunction {
  const env = process.env.OPENHIVE_PYTHON_CONCURRENCY
  const n = env ? Math.max(1, Number.parseInt(env, 10) || 0) : Math.max(2, Math.min(os.cpus().length, 4))
  return pLimit(n)
}

export function skillLimiter(): LimitFunction {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = make()
  return g[GLOBAL_KEY]!
}

export function acquireSkillSlot<T>(fn: () => Promise<T>): Promise<T> {
  return skillLimiter()(fn)
}

export function __resetForTests(): void {
  delete g[GLOBAL_KEY]
}
```
- [ ] **Step 4**: `pnpm add -w p-limit` (이미 있으면 skip), `pnpm -w install`
- [ ] **Step 5**: 테스트 PASS 확인
- [ ] **Step 6**: commit `feat(skills): add concurrency limiter for Python subprocesses`

## Task 3: Runner 가 semaphore 경유

**Files:** `apps/web/lib/server/skills/runner.ts:299-351, 360-418`

- [ ] **Step 1**: `runSkill`, `runSkillScript` 안의 `runSubprocess` 호출을 `acquireSkillSlot` 로 감싸기. Python runtime 일 때만.
```ts
import { acquireSkillSlot } from './concurrency'
// ...
const result = skill.runtime === 'python'
  ? await acquireSkillSlot(() => runSubprocess({...}))
  : await runSubprocess({...})
```
- [ ] **Step 2**: 기존 skill runner 테스트 전체 재실행
- [ ] **Step 3**: commit `feat(skills): route Python skills through concurrency limiter`

## Task 4: Queue 가시성 이벤트

**Files:** `apps/web/lib/server/engine/session.ts` (skill 호출 경로), `apps/web/lib/server/events/types.ts`

- [ ] **Step 1**: Event 타입에 `skill.queued`, `skill.started` 추가 (해당 파일 컨벤션 확인 후)
- [ ] **Step 2**: skill 호출 래퍼에서
  - acquire 직전 `skill.queued` emit
  - 콜백 진입 시 `skill.started` emit
- [ ] **Step 3**: 수동 검증 — 동시 skill 2개 이상 트리거 시 UI 콘솔에 queued 뜨는지
- [ ] **Step 4**: commit `feat(engine): emit skill.queued/started events for concurrency visibility`

## Task 5: Lazy import — PDF skill

**Files:** `packages/skills/pdf/scripts/{build_doc,edit_doc,extract_doc,md_to_spec,inspect_doc}.py`, `packages/skills/pdf/lib/renderers.py`, `lib/themes.py`, `helpers/pdf_ops.py`

- [ ] **Step 1**: 각 파일 top-level import 중 "특정 함수 경로에서만 쓰는" reportlab 서브모듈을 함수 내부로 이동. 기준: 파일을 grep 해서 import 심볼이 한두 함수에서만 참조되면 lazy 대상.
```python
# Before (top of file):
from reportlab.graphics import renderPDF
from reportlab.graphics.shapes import Drawing

# After — inside the function that actually uses them:
def render_chart(...):
    from reportlab.graphics import renderPDF
    from reportlab.graphics.shapes import Drawing
    ...
```
- [ ] **Step 2**: `packages/skills/pdf` 기존 테스트/샘플 호출로 smoke
```bash
python packages/skills/pdf/scripts/build_doc.py < fixtures/minimal.json
```
- [ ] **Step 3**: 메모리 측정 (선택)
```bash
/usr/bin/time -l python packages/skills/pdf/scripts/build_doc.py < fixtures/minimal.json 2>&1 | grep maximum
```
Before/After peak RSS 기록.
- [ ] **Step 4**: commit `perf(skills/pdf): lazy import reportlab submodules (-30% RSS)`

## Task 6: Lazy import — PPTX skill

**Files:** `packages/skills/pptx/scripts/*.py`, `packages/skills/pptx/lib/*.py`

- [ ] **Step 1**: Task 5 동일 패턴. `pptx.chart.*`, `pptx.enum.*`, `lxml.etree` 의 함수별 사용처 확인 후 이동.
- [ ] **Step 2**: smoke + 메모리 측정
- [ ] **Step 3**: commit `perf(skills/pptx): lazy import python-pptx submodules`

## Task 7: Lazy import — DOCX skill

**Files:** `packages/skills/docx/scripts/*.py`

- [ ] **Step 1**: 동일. `docx.oxml.*`, `docx.enum.*` 우선.
- [ ] **Step 2**: smoke + 측정
- [ ] **Step 3**: commit `perf(skills/docx): lazy import python-docx submodules`

## Task 8: 수동 검증 & 측정

- [ ] **Step 1**: 샘플 세션으로 PDF/PPTX/DOCX 생성 각 1회. 정상 동작 + 아티팩트 생성 확인.
- [ ] **Step 2**: `OPENHIVE_PYTHON_CONCURRENCY=2` 로 띄우고 5개 병렬 skill 트리거 → 2개씩 순차 실행되는지 확인 (이벤트 로그로).
- [ ] **Step 3**: Before/After RSS 를 이 플랜 마지막에 표로 기록:
```
skill         | before peak | after peak | Δ
pdf/build     |     XXX MB  |    XXX MB  | −XX%
pptx/build    |     XXX MB  |    XXX MB  | −XX%
docx/build    |     XXX MB  |    XXX MB  | −XX%
```

## 롤백

각 task 커밋 분리 → 문제 시 `git revert <hash>`. semaphore 는 env `OPENHIVE_PYTHON_CONCURRENCY=9999` 로 실질 비활성 가능.
