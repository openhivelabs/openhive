---
name: pdf
description: Build, inspect, edit, and extract PDF documents. Two edit tracks — page-level ops (merge/split/rotate/watermark) via pypdf, and content changes via spec round-trip (build_doc regenerates from .spec.json).
---

# pdf skill

## 중요한 전제

PDF 는 **렌더링된 포맷** 이라 문서 내용을 바이트 레벨에서 편집하는 것은 기술적으로 제한적입니다. 이 스킬은 두 갈래로 그 한계를 우회합니다:

1. **페이지 레벨 조작** (pypdf) — 내용은 안 건드리고 페이지만 다룸
2. **내용 변경 = spec 재빌드** — `.spec.json` 을 수정해서 새 PDF 생성

외부에서 받은 PDF 의 "3번째 단어를 바꿔줘" 같은 인라인 편집은 **지원하지 않습니다.** 원본 소스가 있다면 그걸 고쳐서 다시 빌드하는 게 정답.

## Decision tree

```
요청이 무엇인가?
│
├─ 새 PDF 만들기
│   → scripts/build_doc.py --spec <json> --out <pdf>
│     블록 15종 (docx 와 공유): title/heading/paragraph/bullets/numbered/
│     table/image/page_break/quote/code/horizontal_rule/toc/kpi_row/
│     two_column/spacer
│
├─ PDF 페이지 조작 (merge/split/extract/rotate/watermark)
│   → scripts/edit_doc.py --in <pdf> --patch <json> --out <pdf>
│     Page ops: merge, split, extract_pages, rotate, overlay_text,
│     overlay_image
│
├─ PDF 내용 변경 (텍스트/블록 삽입·삭제·이동)
│   → 동일하게 edit_doc.py, 다만 Spec ops 사용
│     Spec ops: set_text, replace_block, insert_block, delete_block,
│     move_block, update_table_cell
│     이 경우 <입력>.pdf.spec.json 이 필요 (build_doc 이 자동 저장)
│
├─ 구조 확인
│   → scripts/inspect_doc.py --in <pdf>
│     페이지 수, 크기, 텍스트 미리보기, 메타데이터
│
├─ PDF → 스펙 역변환 (lossy, fallback)
│   → scripts/extract_doc.py --in <pdf> --out <spec.json>
│     레이아웃·표·이미지는 거의 소실됨. 원본 spec.json 이 없을 때만 사용.
│
└─ 마크다운 → PDF
    → scripts/md_to_spec.py --in <md> --out <spec.json> → build_doc.py
```

## 페이지 레벨 op (pypdf 기반)

페이지를 불투명 단위로 다뤄서 안전하고 빠름:

| op              | 설명                                         |
|-----------------|----------------------------------------------|
| `merge`         | 여러 PDF 이어붙이기                          |
| `split`         | 페이지 범위별로 나누기                       |
| `extract_pages` | 특정 페이지만 뽑아 새 PDF                    |
| `rotate`        | 90/180/270 도 회전                           |
| `overlay_text`  | 워터마크/스탬프 텍스트                       |
| `overlay_image` | 로고/인장 이미지                             |

## 내용 변경 = spec 재빌드

`build_doc.py` 가 PDF 만들 때 옆에 `<파일>.pdf.spec.json` 을 자동 저장. 수정은 이 JSON 을 고쳐서 재빌드하는 방식:

| op                   | 설명                                         |
|----------------------|----------------------------------------------|
| `set_text`           | 특정 블록의 text 필드 교체                   |
| `replace_block`      | 특정 위치 블록을 새 블록으로 대체            |
| `insert_block`       | 위치에 블록 삽입                             |
| `delete_block`       | 위치의 블록 삭제                             |
| `move_block`         | 블록 이동                                    |
| `update_table_cell`  | 표 블록의 (r, c) 셀 갱신                     |

`.spec.json` 이 없으면 먼저 `extract_doc.py` 를 돌리거나, 원본 소스(docx, md) 에서 새로 빌드할 것.

## 블록 타입

docx 와 거의 동일한 vocabulary 를 공유 — 스펙 하나로 양쪽 포맷 생성 가능.

| Type              | 용도                                    |
|-------------------|-----------------------------------------|
| `title`           | 큰 중앙 제목 (cover page)               |
| `heading`         | 섹션 제목 (level 1~6)                   |
| `paragraph`       | 본문 문단 (align 지원)                  |
| `bullets`         | 순서없는 목록 (2단 중첩)                |
| `numbered`        | 순서있는 목록                           |
| `table`           | 표 (headers + rows, style)              |
| `image`           | 이미지 (width_in 지정 가능)             |
| `page_break`      | 페이지 나눔                             |
| `quote`           | 인용 블록                               |
| `code`            | 코드 블록 (monospace + 배경)            |
| `horizontal_rule` | 가로 구분선                             |
| `toc`             | 목차 (레포트랩 TableOfContents)         |
| `kpi_row`         | 수치 카드 일렬                          |
| `two_column`      | 2열 레이아웃                            |
| `spacer`          | 수직 여백 (pt)                          |

## 제약

- 외부 폰트는 이름만 저장 — 뷰어 폰트가 바뀌면 줄 폭이 달라짐
- `overlay_text` 는 워터마크 용도. 본문 일부를 "바꾸는" 용이 아님
- `extract_doc.py` 는 heuristic — 표·이미지·레이아웃 소실. `.spec.json` 이 있으면 extract 를 쓰지 말 것
- 전자서명된 PDF 를 수정하면 서명이 무효화됨
- 암호화된 PDF 는 해독되지 않은 상태로는 조작 불가 (복호 후 편집 후 재암호화 필요)
