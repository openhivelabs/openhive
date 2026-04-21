# Spec: 스킬·툴 Verification 내장

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#6)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

번들 스킬 스크립트가 실패해도 LLM 이 해석 가능한 구조화 에러가 아니라 raw stderr/traceback 만 돌려받아 자가 복구 못 함 (token roadmap E3). self-check 단계 + 표준 에러 스키마 도입.

- `skills/runner.ts:115-179` subprocess 실행, stdout 8KB truncate.
- `session.ts:1593-1600` 현재 에러 shape: `{ok, exit_code, timed_out, stdout, stderr, files}`.
- 번들 스크립트 예 `packages/skills/pdf/scripts/build_doc.py:1-80`.

## 원칙

1. **성공도 검증.** exit 0 = "끝났다"일 뿐, 결과 파일이 쓸만한지는 별개. 크기/포맷 체크.
2. **실패는 구조화.** `{ok:false, error_code, message, suggestion}` 로 LLM 이 retry guidance 얻게.
3. **Python 공용 helper.** 각 스크립트 말미에서 재사용.
4. **품질 우선.** 검증 추가로 호출 당 수십 ms 느려져도 OK.

## 변경

### Python helper (`packages/skills/_lib/verify.py` 신규)

```python
def emit_success(files: list[dict], warnings: list[str] = None) -> None: ...
def emit_error(code: str, message: str, suggestion: str = "") -> None: ...
def check_file(path: str, min_bytes: int = 100) -> None:
    # raises EmitError with suggestion if missing/too small
```

### 번들 스크립트 패턴

```python
from _lib.verify import check_file, emit_success, emit_error

try:
    build(...)  # existing
    check_file(args.out, min_bytes=1000)
    emit_success(files=[{"name": os.path.basename(args.out), "path": args.out, "mime": "application/pdf"}])
except EmitError as e:
    emit_error(e.code, e.message, e.suggestion)
```

### Runner 에러 매핑 (`runner.ts`)

stdout 마지막 JSON 라인이 `{ok:false, error_code, ...}` 이면 엔진이 `tool_result` 에 그대로 전달 (ERROR prefix X). LLM 시스템 프롬프트에 "tool_result 가 `{ok:false}` JSON 이면 `suggestion` 을 따라 retry" 규칙 추가.

### 번들 스킬 전수 업데이트

- pdf / docx / pptx — 각 주요 script 말미에 check + emit.
- 작성 가이드 신규 문서 `docs/skills/authoring.md` — self-check 프로토콜 명시.

## 테스트

1. 단위: `verify.py` helper (check_file empty, too small, OK).
2. 통합: pdf 스크립트 강제 에러(잘못된 spec) → LLM 가 suggestion 보고 retry.
3. 회귀: 기존 성공 케이스 동일 결과.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| 스킬 실패→성공 복구율 | | |
| 평균 retry 횟수 | | |

## 롤백

runner 의 JSON 감지를 끄고 에러 스키마 무시 → 구 동작.

## 열린 질문

- [ ] Node 스킬용 동등 helper (`_lib/verify.js`) 도 같이 — OK?
- [ ] token roadmap H4/H5 (artifact 등록 버그) 는 이 스펙 범위 밖. 별도 이슈로 분리.
