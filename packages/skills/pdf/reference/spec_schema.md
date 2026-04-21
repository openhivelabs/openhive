# pdf spec schema

```jsonc
{
  "meta": {
    "title": "...",
    "author": "...",
    "subject": "...",
    "theme": "default",      // default | formal | report | minimal
    "theme_overrides": { "accent": [29, 78, 216] },
    "size": "A4",            // A4 | Letter | Legal
    "orientation": "portrait"  // portrait | landscape
  },
  "blocks": [ ... ]
}
```

## Block types (docx 와 동일 + 2개 PDF 전용)

### title (PDF 전용)
```jsonc
{"type": "title", "text": "문서 큰 제목"}
```
큰 중앙 정렬 제목. Cover page 용.

### spacer (PDF 전용)
```jsonc
{"type": "spacer", "height": 40}
```
수직 여백 (pt 단위).

### heading, paragraph, bullets, numbered, table, image, page_break, quote, code, horizontal_rule, toc, kpi_row, two_column

docx spec 과 동일. `packages/skills/docx/reference/spec_schema.md` 참조.

## Theme

docx 와 같은 테마 이름: `default`, `formal`, `report`, `minimal`.
폰트는 reportlab 내장 폰트 — `Helvetica`, `Times-Roman`, `Courier`.

## Theme overrides

색은 `[R,G,B]` (0..255). 마진은 **포인트 단위** (docx 는 inch, PDF 는 pt) — 주의.

| 필드 | 타입 | 기본값 |
|---|---|---|
| `margin_top/bottom/left/right` | float (pt) | 54/54/60/60 |
| `size_*` | int (pt) | `size_body=11` 등 |
| `*_font` | string | `Helvetica` 등 (reportlab 내장) |
