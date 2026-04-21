# pdf troubleshooting

## "spec-level op requested but no .spec.json"

이 PDF 는 `build_doc.py` 로 생성된 것이 아님. 옵션:
1. **원본 소스 이용** — docx 나 md 에서 다시 빌드
2. **extract 후 편집** — `extract_doc.py --in X.pdf --out X.spec.json` 으로 베스트에포트 스펙 만든 뒤 hand-edit 하고 build_doc 로 다시 생성. 레이아웃은 단순해짐 (표/이미지 소실)

## 워터마크 가 어디 있는지 안 보임

`overlay_text` 의 x/y 는 **페이지 좌하단 기준 포인트**. A4 는 595×842 pt. 페이지 중앙 근처를 원하면 `x=150, y=400` 쯤. 스탬프가 페이지 밖으로 나가면 안 보임.

## 한글이 네모로 나옴

reportlab 내장 폰트 (Helvetica / Times-Roman / Courier) 는 라틴계. 한글 PDF 를 제대로 뽑으려면 CID/TTF 폰트 임베딩이 필요한데 이건 현재 범위 밖. 한글 문서는 일단 docx 로 생성하고 Word/LibreOffice 로 Export to PDF 하는 게 품질이 더 좋을 수 있음.

(추후 확장: reportlab `TTFont` 로 Noto Sans KR 등 임베딩 가능. 테마 override 로 `body_font` 를 임베드된 폰트로 바꾸는 기능 추가 예정.)

## 페이지 번호가 잘림

`margin_bottom` 이 너무 작으면 페이지 번호가 컨텐츠에 가려짐. 기본 54pt 에서 더 줄이지 말 것.

## 추출 텍스트가 엉뚱함

PDF 는 렌더 시점의 글자 배치만 남아서 **읽는 순서가 보존 안 됨**. 특히 다단 레이아웃 / 표 / PDF 뷰어별 텍스트 레이어 품질 차이로 순서가 엉킬 수 있음. 인스펙트용으로만 신뢰, 라운드트립용으로는 항상 `.spec.json` 을 우선.

## 전자서명된 PDF 를 편집하면

서명이 무효화됨. `edit_doc.py` 로 페이지 op 든 spec op 든 어떤 조작이라도 서명 해시를 깨뜨림. 서명된 PDF 는 보존용으로 두고 수정은 원본 소스에서 할 것.

## 암호화된 PDF

현재 스킬은 pypdf 에 비밀번호를 전달하지 않음. 암호화된 입력은 실패. 필요하면 먼저 `qpdf --decrypt` 등으로 해제 후 편집, 편집 후 재암호화.
