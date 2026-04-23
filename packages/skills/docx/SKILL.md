---
name: docx
description: Build, inspect, edit, and reverse-engineer Word (.docx) documents. Two edit tracks — live ops (set_text/update_table_cell/swap_image/set_style) and spec round-trip for structural changes.
triggers:
  keywords: [docx, word, 워드, 문서, document]
  patterns: ['\.docx\b']
---

# docx skill

## Decision tree

```
요청이 무엇인가?
│
├─ 새 문서 만들기
│   → scripts/build_doc.py --spec <json> --out <docx>
│     13개 블록 타입: heading, paragraph, bullets, numbered, table, image,
│     page_break, quote, code, horizontal_rule, toc, kpi_row, two_column.
│     stderr/spec 스키마: reference/spec_schema.md, 예시: reference/examples.md
│
├─ 본문 일부 수정 (텍스트·표 셀·이미지·스타일)
│   → scripts/edit_doc.py --in <docx> --patch <json> --out <docx>
│     Live ops: set_text, update_table_cell, swap_image, set_style.
│     패치 DSL 문법: reference/patch_dsl.md.
│
├─ 구조 변경 (블록 삽입/삭제/이동/치환)
│   → 동일하게 edit_doc.py, 다만 Spec ops 사용.
│     Spec ops: insert_block, delete_block, replace_block, move_block.
│     이 경우 <입력>.spec.json 을 자동 로드해서 수정 → rebuild.
│     build_doc.py 가 생성 시 .spec.json 을 자동 저장하므로 왕복 가능.
│
├─ 문서 구조 확인
│   → scripts/inspect_doc.py --in <docx>
│     제목/문단 수, 목차, 표 차원, 이미지 목록.
│
├─ 기존 docx 를 스펙으로 역변환 (heavy edit 전 단계)
│   → scripts/extract_doc.py --in <docx> --out <spec.json>
│     복잡한 구조는 손실 있음 (kpi_row/two_column 은 paragraph 로 flatten).
│
└─ 마크다운 → docx
    → scripts/md_to_spec.py --in <md> --out <spec.json> → build_doc.py
```

## 두 가지 편집 트랙

**Live ops** — 문서를 python-docx 로 직접 수정.  
빠르고 스펙 파일이 필요 없음. 단점: 구조 변경(블록 삽입/삭제) 불가.

**Spec ops** — `<입력>.spec.json` 을 읽어 수정 후 rebuild.  
구조 변경 자유. 단점: 스펙이 있어야 함 (없으면 먼저 `extract_doc.py`).

두 종류 op 를 한 패치에 섞어도 됨 — live 먼저 적용 → 그 결과에 spec op 가 다시 rebuild.

## 블록 타입 요약

| Type              | 용도                                    |
|-------------------|-----------------------------------------|
| `heading`         | 제목 (level 1~6, TOC 연동)              |
| `paragraph`       | 본문 문단 (align 지원)                  |
| `bullets`         | 순서없는 목록 (2단 중첩)                |
| `numbered`        | 순서있는 목록                           |
| `table`           | 표 (headers + rows, style grid/light/plain) |
| `image`           | 이미지 (path/URL, caption, width_in)    |
| `page_break`      | 페이지 나눔                             |
| `quote`           | 인용 블록 (attribution 지원)            |
| `code`            | 코드 블록 (monospace + 배경)            |
| `horizontal_rule` | 가로 구분선                             |
| `toc`             | 목차 필드 (Word 에서 F9 로 갱신)        |
| `kpi_row`         | 수치 카드 일렬 (big number + label + delta) |
| `two_column`      | 2열 레이아웃 (각 열에 블록 배열)        |

## 제약

- 외부 폰트는 이름만 저장 — 뷰어에 해당 폰트 없으면 대체됨.
- `toc` 는 필드 코드만 삽입. 실제 목차 채우려면 Word 에서 F9.
- `image` 교체(`swap_image`) 는 바이트만 바꿈 — 기존 크기 유지.
- Spec 파일을 잃어버리면 구조 편집 불가. `extract_doc.py` 로 최선 복원.
