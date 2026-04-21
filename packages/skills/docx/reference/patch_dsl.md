# docx Patch DSL

`edit_doc.py --in <docx> --patch <patch.json> --out <out.docx>`

## Selector grammar

| Selector                          | 의미                                         |
|-----------------------------------|----------------------------------------------|
| `heading:N`                       | N번째 heading (문서 내 순서)                |
| `heading:N[level=2]`              | level 필터링                                 |
| `paragraph:N`                     | N번째 일반 문단 (heading 제외)              |
| `table:N`                         | N번째 표                                     |
| `table:N > cell[r=R,c=C]`         | 특정 셀                                      |
| `image:N`                         | N번째 그림                                   |
| `block:N`                         | spec 레벨 N번째 블록 (spec 패치 전용)        |

인덱스는 zero-based. `inspect_doc.py` 출력의 `index` 와 일치.

## Live ops (python-docx 로 직접 편집)

```json
{"op": "set_text",          "target": "heading:2",              "value": "..."}
{"op": "update_table_cell", "target": "table:0 > cell[r=1,c=2]", "value": "..."}
{"op": "swap_image",        "target": "image:0",                "value": "path_or_url"}
{"op": "set_style",         "target": "heading:0",
                            "font": "Georgia", "size": 24,
                            "color": [200, 30, 30],
                            "bold": true,  "italic": false}
```

## Spec ops (구조 변경 — .spec.json 필요)

`build_doc.py` 가 문서 옆에 `.spec.json` 을 자동 저장합니다. spec ops 는 이 파일을 수정한 뒤 재빌드:

```json
{"op": "insert_block",  "position": 5,  "block": { "type": "paragraph", "text": "..." }}
{"op": "delete_block",  "position": 3}
{"op": "replace_block", "position": 7,  "block": { ... }}
{"op": "move_block",    "from": 2, "to": 6}
```

spec.json 이 없으면 먼저 `extract_doc.py` 로 생성.

## 혼합 패치

live + spec 섞어도 됨. 처리 순서:
1. live ops 를 원본에 적용 (python-docx 수정)
2. spec ops 로 .spec.json 수정
3. spec 변경이 있으면 build_doc.py 로 새 docx 생성 (live 수정은 이 과정에서 덮어씌워지므로, 같은 대상을 양쪽에서 건드리지 말 것)

권장: 구조 변경이 있으면 **spec ops 만** 쓰고, 문자열 튜닝은 **live ops 만** 쓰기.

## 예시

**제목 교체 + 표 셀 갱신 + 블록 삽입:**

```json
{
  "operations": [
    {"op": "set_text", "target": "heading:0", "value": "Q4 업데이트"},
    {"op": "update_table_cell", "target": "table:0 > cell[r=1,c=1]", "value": "$2.3M"},
    {"op": "insert_block", "position": 4, "block": {
      "type": "quote", "text": "목표 달성!", "attribution": "CEO"
    }}
  ]
}
```
