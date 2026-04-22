---
name: image-gen
description: Render PNG images from HTML. Two modes — `template` (pick a built-in preset + fill vars, ~hundreds of tokens) or `freeform` (provide full HTML, kB of tokens). Good for text-first graphics: YouTube thumbnails, report covers, stat cards. NOT a photo generator.
runtime: python
entrypoint: scripts/run.py
parameters:
  type: object
  required: [mode]
  properties:
    mode:
      type: string
      enum: [template, freeform]
      description: "`template` uses a built-in preset; `freeform` takes full HTML."
    template:
      type: string
      description: "template name (template mode only). See the catalog below."
    vars:
      type: object
      description: "template vars (template mode only). Keys match templates/<name>/template.yaml inputs."
    html:
      type: string
      description: "full HTML document (freeform mode only). Must self-size the body to width x height."
    width:
      type: integer
      description: "viewport width in px (freeform mode only). 100–4096."
    height:
      type: integer
      description: "viewport height in px (freeform mode only). 100–4096."
    filename:
      type: string
      description: "output filename (plain base name, no slashes). Default: image-gen-<timestamp>.png."
---

# image-gen skill

## Decision tree

```
무엇을 만들 건가?
│
├─ 유튜브 썸네일 / 표지 / 지표 카드 같이 정해진 레이아웃
│   → template 모드. 카탈로그에서 고르고 vars 채움.
│
└─ 카탈로그에 맞는 레이아웃이 없음 (독자적 디자인 필요)
    → freeform 모드. 직접 HTML/CSS 작성 + width/height 명시.
      reference/freeform-guide.md 먼저 읽기.
```

**기본은 template 모드.** freeform 은 토큰을 10배 이상 쓰니 템플릿이 안 맞을 때만.

## 템플릿 카탈로그

| name | size | 용도 | 필수 vars |
| --- | --- | --- | --- |
| `yt-bold-text` | 1280×720 | 큰 제목 + 부제, YouTube 썸네일 범용 | `title` |
| `yt-split` | 1280×720 | 좌 텍스트 / 우 이미지 슬롯 | `title`, `image_path` |
| `yt-quote` | 1280×720 | 인용구 + 저자 | `quote` |
| `cover-minimal` | 1600×900 | 보고서/프레젠테이션 표지 | `title` |
| `stat-card` | 1080×1080 | 큰 숫자 지표 카드 | `value`, `label` |

각 템플릿의 전체 입력 스키마는 `templates/<name>/template.yaml` 참조.

## Input 예시

### template 모드
```json
{
  "mode": "template",
  "template": "yt-bold-text",
  "vars": { "title": "...", "subtitle": "...", "accent": "#ff4d4d" },
  "filename": "thumbnail.png"
}
```

### freeform 모드
```json
{
  "mode": "freeform",
  "html": "<!doctype html><html>...",
  "width": 1280,
  "height": 720,
  "filename": "custom.png"
}
```

## Output envelope

성공:
```json
{"ok": true, "files": [{"name": "thumbnail.png", "path": "/abs/...", "mime": "image/png", "size": 73412}], "warnings": []}
```

실패 (`error_code` 값):
- `validation` — vars 가 스키마에 안 맞음. `message` 에 경로 + 사유.
- `template_not_found` — 존재하지 않는 템플릿.
- `invalid_mode` — mode 가 template/freeform 이 아님.
- `size_out_of_range` — 100~4096 벗어남.
- `output_sanity` — 렌더 결과 PNG 가 너무 작음 (보통 빈 HTML).
- `invalid_filename` — 파일명에 `/` 또는 `..` 포함.

## 주의사항

- 로컬 이미지 경로를 `image_path` 등에 넘길 땐 `file:///abs/path` 또는 http(s) URL.
- 외부 폰트/이미지 로딩 실패 시 10s 타임아웃 뒤 현 상태로 스크린샷 — 폰트 미로드 시 시스템 기본 폰트로 보일 수 있음.
- 최초 호출에서 Chromium 바이너리를 자동 다운로드 (~170MB, 한 번만). 이후는 즉시 실행.
- 이 skill 은 photo-realistic 이미지를 만들지 않는다. 인물/제품 사진이 필요하면 다른 수단.

## Python deps

`requirements.txt`: `jinja2`, `jsonschema`, `playwright`, `pyyaml`. 런타임이 해당 패키지를 import 가능한 python3 를 쓸 수 있어야 한다 (프로젝트 venv 또는 시스템 파이썬에 설치).
