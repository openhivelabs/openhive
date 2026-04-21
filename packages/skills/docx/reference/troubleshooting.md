# docx troubleshooting

## `set_text` 가 원하는 paragraph 를 못 찾음

docx 의 heading/paragraph 인덱스는 **문서 순서** 기반. `inspect_doc.py` 가 돌려주는 `index` 를 그대로 쓰면 됩니다. heading 과 paragraph 는 **다른 시퀀스** (heading:0, heading:1, … + paragraph:0, paragraph:1, …).

## Spec ops 가 "no .spec.json found" 로 실패

`build_doc.py` 가 생성한 docx 라면 자동으로 옆에 `<파일>.docx.spec.json` 이 있습니다. 다른 도구로 만든 문서는 먼저:

```
extract_doc.py --in foo.docx --out foo.docx.spec.json
edit_doc.py --in foo.docx --patch p.json --out out.docx
```

## TOC 가 본문에 안 나옴

`toc` 블록은 Word 필드 코드만 심습니다. Word/LibreOffice 에서 파일을 열고 F9 (새로고침) 를 눌러야 실제 항목이 채워집니다. python-docx 는 필드를 evaluate 하지 않음.

## 이미지 스왑 후 크기가 원본 그대로

`swap_image` 는 바이트만 교체. 원본 표시 크기 유지 — 새 이미지의 실제 해상도는 무시됨. 크기까지 바꾸려면 spec op 로 해당 image 블록을 `replace_block` 해서 새 width_in 적용.

## 코드 블록 폰트가 다른 monospace 로 바뀜

docx 는 폰트 이름만 저장. 뷰어에 Menlo/Consolas 등이 없으면 대체됨. 테마에서 `mono_font: "Courier New"` 처럼 보편 폰트로 지정 가능.

## 한글이 네모 박스로 보임

뷰어의 East-Asian 폰트가 없거나 테마가 ASCII 전용 폰트를 강제하는 경우. 테마에서 `body_font` 를 Apple SD Gothic Neo / Malgun Gothic 으로 override.

## 표 스타일이 원하는대로 안 나옴

`style: "grid"` 는 대부분의 뷰어에서 통일. `"light"`, `"plain"` 은 Word 의 내장 스타일 이름에 의존 — 없으면 기본 스타일로 fallback. docx 원본이 특정 스타일을 요구하면 custom style 을 docx template 에 심어두고 `theme_overrides` 로 연결해야 하지만, 이건 현재 범위 밖.
