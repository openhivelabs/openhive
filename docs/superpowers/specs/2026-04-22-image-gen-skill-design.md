# image-gen skill design

Date: 2026-04-22
Status: approved, ready for implementation plan

## 목표

자체 호스팅 환경에서 이미지 생성. 사용 중인 LLM 중 이미지 모델 (nano-banana 등) 이 없으므로 HTML → 헤드리스 Chromium 스크린샷으로 대체. 타깃 산출물: YouTube 썸네일, 보고서/발표 표지 카드, 지표 카드 같이 **텍스트가 주인공인 그래픽**. 사진 합성/편집 용도 아님.

## 비목표

- Photo-realistic 이미지 생성 (애초 LLM 이미지 모델 대안이 아니라 "그래픽 카드" 생성기).
- 애니메이션 / 비디오 캡쳐 / GIF.
- In-app 템플릿 에디터 UI — MVP 밖 (`packages/skills/agent-creator` 참고, skill creator 자체가 out-of-scope).
- 외부 이미지 CDN 업로드 — 출력은 로컬 파일만.

## 위치 & 이름

`packages/skills/image-gen/` — 기존 Python skill 규약 (`packages/skills/<name>/`, `SKILL.md` + `scripts/run.py` stdin/stdout JSON).

## 두 동작 모드

호출자가 `mode` 로 명시.

### A. template 모드 (기본)

```json
{
  "mode": "template",
  "template": "yt-bold-text",
  "vars": { "title": "...", "subtitle": "...", "accent": "#ff0044" },
  "out_path": "/abs/path/to/out.png"   // optional
}
```

- `templates/<name>/template.yaml` 에 JSON Schema (`inputs`) + `size: { width, height }` 선언.
- `templates/<name>/template.html.j2` 는 Jinja2 플레이스홀더 HTML.
- `run.py` 가 schema 로 vars 검증 → Jinja2 치환 → render.
- 토큰 소비: 호출당 수백 토큰 (vars 만 직렬화).

### B. freeform 모드 (escape hatch)

```json
{
  "mode": "freeform",
  "html": "<!doctype html>...",
  "width": 1200,
  "height": 630,
  "out_path": "..."
}
```

- LLM 이 HTML/CSS 직접 작성.
- `reference/freeform-guide.md` 가 LLM 지침 (사이즈 프리셋, 폰트 로딩, 접근 가능한 파일 경로 규칙).
- 템플릿 안 맞는 케이스 전용. `SKILL.md` 에 "먼저 template 모드 시도, 맞는 게 없을 때만" 명시.
- 토큰 소비: HTML 출력만큼. 수 kB.

## 초기 템플릿 세트 (5개)

| name | size (W×H) | 용도 | 핵심 vars |
| --- | --- | --- | --- |
| `yt-bold-text` | 1280×720 | 큰 제목 + 부제, 그라디언트/단색 배경 | title, subtitle, accent, bg_style (solid/gradient) |
| `yt-split` | 1280×720 | 좌 텍스트 / 우 이미지 슬롯 | title, subtitle, image_path, accent |
| `yt-quote` | 1280×720 | 인용구 + 저자 | quote, author, accent |
| `cover-minimal` | 1600×900 | 보고서 표지 — 제목 + 부제 + 메타 | title, subtitle, meta (날짜·저자 등), accent |
| `stat-card` | 1080×1080 | 큰 숫자 + 레이블 + 코멘트 | value, label, delta (optional), tone (pos/neg/neutral) |

확장은 `templates/<new-name>/` 폴더 드롭만으로 — 코드 변경 없음.

## 입력/출력 계약

### Input (stdin JSON)

```ts
type Input =
  | { mode: 'template'; template: string; vars: Record<string, unknown>; out_path?: string }
  | { mode: 'freeform'; html: string; width: number; height: number; out_path?: string }
```

### Output (stdout JSON)

```ts
type Output =
  | { ok: true; path: string; width: number; height: number; bytes: number }
  | { ok: false; error: string; details?: unknown }
```

- `out_path` 생략 시 엔진 기본값 (세션 `artifacts/image-gen-<ts>.png`). Skill 자체는 주어진 경로에 쓰기만 하고 경로 결정 로직은 엔진/caller 책임.

## 파일 구조

```
packages/skills/image-gen/
  SKILL.md
  scripts/
    run.py                    # entry (stdin → stdout JSON)
    render.py                 # Jinja2 치환 + Playwright 호출
    ensure_chromium.py        # Chromium 바이너리 lazy install
  templates/
    yt-bold-text/
      template.html.j2
      template.yaml
    yt-split/…
    yt-quote/…
    cover-minimal/…
    stat-card/…
  reference/
    freeform-guide.md
    examples.md
  tests/
    test_render.py
    fixtures/…
```

## 렌더 플로우

1. `run.py` — stdin JSON 파싱, 모드 분기. 검증 실패 시 즉시 error JSON.
2. template 모드: `template.yaml` 로드 → JSON Schema 로 vars 검증 → Jinja2 렌더 → HTML 문자열 + (w,h).
3. freeform 모드: `html`, `width`, `height` 그대로.
4. `ensure_chromium.py` — `~/.cache/ms-playwright/chromium*` 존재 확인, 없으면 `python -m playwright install chromium` 실행 (최초 1회).
5. `render.py` — Playwright sync API:
   - `browser = p.chromium.launch(headless=True)`
   - `context = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)` (retina 2x)
   - `page.set_content(html, wait_until='networkidle', timeout=10_000)`
   - `page.screenshot(path=out_path, omit_background=False, full_page=False)`
   - `browser.close()`
6. 파일 크기/존재 sanity (0 < bytes < 10MB) → success JSON.

## 인스턴스 & 리소스 전략

- **Per-call Chromium launch.** Skill subprocess 종료와 함께 Chromium 도 종료. Idle RAM 0. 콜드스타트 500ms–1s 수용.
- **Playwright install 은 최초 1회.** `ensure_chromium.py` 가 캐시 디렉토리 체크 후 skip.
- **동시성**: 엔진의 `acquireSkillSlot` (`OPENHIVE_PYTHON_CONCURRENCY`, 기본 clamp(cpus, 2, 4)) 로 자동 cap. 별도 skill-level 제한 없음.
- **Idle footprint 보호**: eager init 없음. Skill 호출 전엔 아무 프로세스도 안 뜸.

## 토큰 소비 가드

- `SKILL.md` decision tree 가 **template 모드 first** 를 명시 — LLM 이 기본적으로 preset 고르게.
- Freeform 호출은 허용하되, `SKILL.md` 에 "템플릿 리스트를 먼저 읽고 맞는 게 없을 때만" 명시.
- 각 `template.yaml` 의 `description` 이 짧고 명확하면 LLM 이 schema 읽기만으로 선택 가능 — preview 이미지는 UI 전용, LLM context 에 injection 안 함.

## 에러 처리

- JSON Schema 검증 실패 → `{ ok: false, error: 'validation', details: <ajv errors> }`.
- Template not found → `{ ok: false, error: 'template_not_found', details: { template, available: [...] } }`.
- Jinja2 치환 에러 → `error: 'template_render'`.
- Playwright 타임아웃 (networkidle 10s 초과, 주로 freeform 의 외부 리소스) → `error: 'render_timeout'`, 단 스크린샷은 그 시점에라도 시도.
- Chromium 다운로드 실패 → `error: 'chromium_install_failed'`, stderr 원문 포함.
- 출력 파일 0 바이트 / 10MB 초과 → `error: 'output_sanity'`.

## 테스트

- `tests/test_render.py` — 각 템플릿을 고정 vars 로 렌더, 결과 PNG 의 크기/해시/최소 바이트 체크.
- `tests/fixtures/` — 예상 스냅샷은 크기·해시 수준까지만 (픽셀 비교는 폰트 차이로 flaky).
- `packages/skills/_lib/verify.py` 패턴과 동일.

## 보안/격리 주의

- Freeform HTML 은 임의 JS 실행 가능 — 로컬 브라우저 샌드박스 안에서만 돌지만, 외부 네트워크 접근은 기본 허용 (템플릿이 Google Fonts 쓰는 것 허용 목적). 도메인 필터는 MVP 밖 (memory `project_sandbox_deferred`).
- `image_path` 같은 로컬 경로 vars 는 회사/세션 루트 밖 접근 차단 — `run.py` 에서 resolve 후 `~/.openhive/` 또는 세션 artifacts 하위인지 검증.
- 생성 PNG 는 호출자가 준 `out_path` 에만 쓰기.

## Caller 지원

- **Agent**: 엔진 skill 파이프라인 기본. Tool schema 는 `SKILL.md` 의 input 타입에서 파생.
- **UI**: 이번 skill 자체는 UI 코드 없음. 별도 plan 에서 "New thumbnail" 패널 추가 시 동일 subprocess 호출. `SKILL.md` 에 `caller: [agent, ui]` 메타만 선언.

## Out of scope (명시)

- `playwright-python` 이외 렌더러.
- 템플릿 내장 JS 실행 (애니메이션/차트 라이브러리 로딩) — 템플릿은 static HTML+CSS 만 권장, 렌더 전 `networkidle` 대기로 폰트/이미지만 커버.
- 이미지 포맷 JPG/WebP — PNG 만. 필요해지면 별도 요청.
