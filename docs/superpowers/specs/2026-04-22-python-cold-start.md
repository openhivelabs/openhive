# Spec: Python 스킬 cold start 최적화

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#10, 구 "Skill 워커 풀" 대체)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

스킬 호출당 Python subprocess cold start 가 200~800ms. 실제 작업 시간과 섞여 체감 지연. 상주 워커 풀은 CLAUDE.md "No long-lived Python process" 규칙 위반 + 복잡도 비용 큼 → **폐기**. 대신 **subprocess 기반 유지하면서 cold start 자체를 줄이는** 싼 최적화.

- `skills/runner.ts:115-179` spawn path.
- `skills/runner.ts:221-232` typed skill 호출, `:285-290` agent script.
- 번들 Python 스킬 (`packages/skills/{pdf,docx,pptx}/scripts/*.py`).

## 원칙

1. **Subprocess 모델 유지.** CLAUDE.md 규칙 준수.
2. **복잡도 0 증가.** 프로세스 생명주기·IPC 관리 추가하지 않음.
3. **측정 기반 수용.** 벤치 전/후 측정해서 의미 있을 때만 확정.

## 변경

### (a) `-X frozen_modules=on` + `-I` 플래그

`runner.ts:221` subprocess 실행 시 Python 인자 추가:
```ts
const pythonArgs = ['-X', 'frozen_modules=on', skill.entrypoint]
```
- `frozen_modules=on`: Python 3.11+ 의 stdlib pre-compiled 모듈 활성 — import 수십 ms 절감.
- `-I` 는 현재 OPENHIVE_OUTPUT_DIR env 를 죽일 수 있으므로 **생략** (env 전달 깨짐 위험).

### (b) 번들 스크립트 lazy import 리팩터

각 `packages/skills/*/scripts/*.py` 상단:
```python
# Before
import reportlab.pdfgen
import PIL.Image
import lxml.etree
def main(): ...

# After
def main():
    import reportlab.pdfgen  # move inside
    import PIL.Image
    ...
```
- 엔트리에서 argparse 만 먼저 처리. `--help` 같은 짧은 호출이 import 안 탐.
- 정상 실행 경로는 import 비용 동일(옮겼을 뿐)이지만 **self-check / argument-validation 에러 경로** 가 빨라짐.
- 읽기 쉬움 훼손이 있으니, **엔트리 함수 안쪽으로 이동만** 하고 중첩 함수에 다시 넣지는 않음.

### (c) `.pyc` 선컴파일

번들 스킬 설치 · 업데이트 파이프라인에서:
```bash
python3 -m compileall -q packages/skills/*/scripts
```
- 첫 호출 시 `.pyc` 생성 비용(~50-100ms) 제거.
- Git 에 `.pyc` 커밋 X (`.gitignore` 추가). 설치 스크립트 또는 `pnpm dev` 기동 시 1회 실행.

### (d) 인터프리터 경로 미리 resolve

`skills/which.ts` 가 매 호출 `which python3` 하는지 확인 — 하면 캐시. (조사 필요; 현재 module cache 레벨로 이미 되어 있을 수도.)

## 테스트

1. **벤치**: `hyperfine` 또는 간이 Node 스크립트로 `python3 pdf/scripts/build_doc.py --help` 100회 측정.
   - 목표: 현재(추정 ~500ms) → 250ms 이하.
2. **회귀**: 기존 PDF/DOCX/PPTX 생성 프롬프트 1회씩 → 산출물 동일.
3. **import 경로**: `python -X frozen_modules=on -c "import sys; print(sys.stdlib_module_names[:5])"` 정상 실행 확인.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| `python --help` 콜드스타트 평균 | | |
| PDF 생성 프롬프트 wall time | | |
| 5회 스킬 호출 세션 wall time | | |

## 롤백

Python 인자에서 `-X frozen_modules=on` 제거, lazy import 원복, `.pyc` precompile 스텝 제거. 전부 독립적.

## 열린 질문

- [ ] (a)(b)(c)(d) 중 의미 있는 것만 채택 — 벤치 결과에 따라 일부 드랍 OK.
- [ ] 사용자 설치 시 `compileall` 자동 실행 지점 — `instrumentation.ts` 부팅 시 1회? 혹은 install 스크립트? (초안: 부팅 시.)
