# pdf Patch DSL

`edit_doc.py --in <pdf> --patch <patch.json> --out <out.pdf>`

두 가지 op 계열: **page ops** (페이지 조작) + **spec ops** (내용 변경, 재빌드).

한 패치에 섞어도 됨 — spec ops 가 먼저 적용되어 PDF 가 재생성된 뒤, 그 결과에 page ops 가 덧씌워짐.

## Page ops — pypdf 기반, 내용 불변

```json
{"op": "merge", "append": ["cover.pdf", "appendix.pdf"]}
```
입력 PDF 뒤에 `append` 에 나열된 PDF 들을 순서대로 이어붙임.

```json
{"op": "extract_pages", "pages": [0, 2, 4]}
```
주어진 0-인덱스 페이지만 뽑아 새 PDF.

```json
{"op": "split", "ranges": [[0, 2], [3, 5]], "out_dir": "/tmp/splits"}
```
(start, end) 범위별로 각각 새 PDF 저장. 이 op 는 다수의 출력을 만들기 때문에 **실행 후 patch 종료** — `--out` 은 무시됨.

```json
{"op": "rotate", "pages": [0, 1], "degrees": 90}
```
`degrees` 는 90 의 배수.

```json
{"op": "overlay_text",
 "text": "DRAFT",
 "pages": [0, 1, 2],
 "x": 150, "y": 400,
 "size": 80,
 "color": [0.85, 0.1, 0.1],
 "rotation": 45,
 "opacity": 0.18
}
```
모든/선택 페이지에 텍스트 스탬프. `pages` 생략 시 전 페이지. 색은 0..1 float 3개.

```json
{"op": "overlay_image",
 "image": "/path/to/logo.png",
 "pages": [0],
 "x": 36, "y": 36,
 "width": 120, "height": 40,
 "opacity": 1.0
}
```
로고·도장 이미지 스탬프.

## Spec ops — .spec.json 수정 후 재빌드

```json
{"op": "set_text", "position": 0, "value": "새 제목"}
```
블록 N 의 text 필드만 교체. `title/heading/paragraph/quote/code` 등 text 필드를 가진 블록에 사용.

```json
{"op": "replace_block", "position": 3, "block": {
  "type": "kpi_row", "stats": [...]
}}
```
블록 전체 교체.

```json
{"op": "insert_block", "position": 2, "block": {
  "type": "paragraph", "text": "..."
}}
```
주어진 위치에 블록 삽입. `position` 이 배열 길이면 끝에 추가.

```json
{"op": "delete_block", "position": 5}
```

```json
{"op": "move_block", "from": 5, "to": 2}
```

```json
{"op": "update_table_cell",
 "position": 4,
 "r": 0, "c": 1,
 "value": "$2.3M"
}
```
블록 `position` 이 table 이어야 함.

## 왕복 예시

**보고서 업데이트 + 워터마크:**
```json
{
  "operations": [
    {"op": "set_text", "position": 0, "value": "Q4 보고서 (수정판)"},
    {"op": "update_table_cell", "position": 10, "r": 1, "c": 2, "value": "$2.3M"},
    {"op": "overlay_text", "text": "CONFIDENTIAL", "opacity": 0.15,
     "rotation": 45, "x": 140, "y": 400, "size": 72}
  ]
}
```

**페이지 순서 재배열 + 일부만 뽑기:**
```json
{
  "operations": [
    {"op": "extract_pages", "pages": [2, 3, 1, 0]}
  ]
}
```
