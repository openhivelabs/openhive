---
name: pptx
description: Build, inspect, edit, and reverse-engineer PowerPoint (.pptx) decks. Three rails — JSON-spec generation for new decks, patch DSL for in-place edits, round-trip extract+rebuild for heavy restructuring. Falls back to raw OOXML editing when needed.
---

# pptx skill

## Decision tree — pick a rail

```
요청이 무엇인가?
│
├─ 새 덱을 처음부터 만들기
│   → scripts/build_deck.py --spec <json> --out <pptx>
│     스펙 작성법: reference/spec_schema.md, 예시: reference/examples.md
│
├─ 기존 덱의 일부만 수정 (텍스트/차트수치/이미지/슬라이드 추가·삭제·이동)
│   → scripts/edit_deck.py --in <pptx> --patch <json> --out <pptx>
│     패치 DSL: reference/patch_dsl.md
│
├─ 기존 덱을 크게 뜯어고치기 (여러 슬라이드 재구성, 테마 교체 등)
│   → (1) scripts/extract_deck.py --in <pptx> --out <spec.json>
│   → (2) spec.json 을 에디터로 원하는 대로 수정
│   → (3) scripts/build_deck.py --spec <spec.json> --out <pptx>
│
├─ 덱이 어떻게 생겼는지 확인 (슬라이드/차트/표/이미지 수, 제목 요약 등)
│   → scripts/inspect_deck.py --in <pptx>
│
└─ 위 DSL 로 커버 안 되는 예외 (애니메이션/마스터/SmartArt 등)
    → reference/xml_edit_guide.md + reference/snippets/ + reference/schemas/
      참고해서 helpers/opc.py 로 원시 XML 직접 편집
```

## 한눈 요약

- **새 덱**: JSON 스펙 작성 → build_deck. 12가지 슬라이드 타입 지원 (title, section, bullets, two_column, image, table, chart, comparison, quote, steps, kpi, closing).
- **수정**: JSON 패치. set_text / replace_bullets / update_chart / swap_image / insert_slide / delete_slide / move_slide / set_notes / set_style.
- **역변환**: extract_deck 로 기존 pptx 를 스펙 JSON 으로 되돌려 받고, 그 JSON 을 고쳐서 재빌드.
- **원시 XML**: OPC 패키지 (`helpers/opc.py`), 스니펫 (`reference/snippets/`), XSD (`reference/schemas/`) 사용.

## 각 스크립트의 stdout

모든 스크립트는 **성공 시 한 줄 JSON**, 실패 시 `{"ok": false, "error": ...}` 를 찍습니다. AI 는 stdout 을 `json.loads()` 해서 결과를 확인하면 됩니다.

- `build_deck.py`  → `{"ok": true, "path": ..., "slides": N, "theme": ..., "warnings": [...]}`
- `edit_deck.py`   → `{"ok": true, "path": ..., "slides": N, "ops_applied": K, "warnings": [...]}`
- `inspect_deck.py` → 풍부한 슬라이드 구조 + 차트/표/이미지 메타데이터
- `extract_deck.py` → `{"ok": true, "path": ..., "slides": N, "warnings": [...]}` + 파일로 spec
- `md_to_spec.py`  → `{"ok": true, "path": ..., "slides": N}`

## 편집 규칙 (edit_deck)

- 슬라이드 인덱스는 **zero-based**. `inspect_deck.py` 가 돌려주는 `index` 를 그대로 쓰면 됩니다.
- 여러 슬라이드 삭제 시 **인덱스 큰 것부터**. 작은 인덱스 먼저 삭제하면 뒤의 인덱스가 밀려 꼬입니다.
- `update_chart` 는 기존 차트의 **시리즈 개수를 바꿀 수 없음**. 개수 바꾸려면 슬라이드를 `delete_slide` + `insert_slide` 로 재생성.
- `set_text` 가 "placeholder 를 못 찾음" 이라고 실패하면 그 슬라이드는 raw text box 로 그려진 것. `reference/patch_dsl.md` 의 fallback 규칙(Y 좌표 기준 상단=title) 을 참고.

## 제약

- 외부 링크/임베디드 미디어(영상, 음성) 는 보존만 되고 수정 API 없음
- SmartArt 는 읽기·보존만 가능 (텍스트 수정도 raw XML 로 해야 함)
- 3D 차트, 트리맵, 폭포 차트 등 일부 최신 차트 타입은 데이터 갱신은 되지만 타입별 세밀한 파라미터는 기본값으로 초기화됨

---

## 파일 구조

```
pptx/
├── lib/                          # 레일 A: 새 덱 렌더러
│   ├── themes.py, layouts.py, spec.py, renderers.py
├── helpers/                      # 레일 B: OPC 기반 수정 엔진
│   ├── opc.py                    # 패키지 추상 (zip/parts/rels)
│   ├── patch.py                  # patch DSL + selector + 모든 op
│   └── chart_data.py             # 차트 데이터 갱신·추출
├── scripts/                      # CLI 진입점
│   ├── build_deck.py, inspect_deck.py, extract_deck.py,
│   ├── edit_deck.py, md_to_spec.py
└── reference/                    # AI 참조 자료
    ├── spec_schema.md            # 상위 스펙 (JSON)
    ├── patch_dsl.md              # 편집 DSL
    ├── xml_edit_guide.md         # raw XML 직접 편집 시
    ├── examples.md, themes.md, troubleshooting.md
    ├── snippets/                 # 검증된 XML 조각 (복사해 쓰는 용)
    └── schemas/                  # ECMA-376 XSD (pptx 관련만)
```
