# docx spec schema

```jsonc
{
  "meta": {
    "title": "...",          // 문서 제목 (metadata)
    "author": "...",
    "subject": "...",
    "theme": "default",      // default | formal | report | minimal
    "theme_overrides": { "accent": [29, 78, 216], "body_font": "Georgia" },
    "size": "A4",            // A4 | Letter | Legal
    "orientation": "portrait"  // portrait | landscape
  },
  "blocks": [ ... ]
}
```

## Block types

### heading
```jsonc
{"type": "heading", "level": 1, "text": "제목"}
```

### paragraph
```jsonc
{"type": "paragraph", "text": "...", "align": "justify"}   // align 옵션
```

### bullets / numbered
```jsonc
{"type": "bullets", "items": [
  "첫 번째",
  "두 번째",
  ["자식 1", "자식 2"],
  "세 번째"
]}
```

### table
```jsonc
{"type": "table",
 "headers": ["col1", "col2"],
 "rows": [["a", 1], ["b", 2]],
 "style": "grid"    // grid | light | plain
}
```

### image
```jsonc
{"type": "image", "path": "/path/or/url", "caption": "...", "width_in": 4.5, "align": "center"}
```

### page_break
```jsonc
{"type": "page_break"}
```

### quote
```jsonc
{"type": "quote", "text": "...", "attribution": "..."}
```

### code
```jsonc
{"type": "code", "text": "print('hi')", "language": "python"}
```

### horizontal_rule
```jsonc
{"type": "horizontal_rule"}
```

### toc
```jsonc
{"type": "toc", "levels": 3}    // 표시 레벨 1..9
```

### kpi_row
```jsonc
{"type": "kpi_row", "stats": [
  {"value": "42%",  "label": "conversion", "delta": "+3pp"},
  {"value": "$1.2M","label": "ARR",         "delta": "+18%"}
]}
```

### two_column
```jsonc
{"type": "two_column",
 "left":  [{"type": "heading", "level": 2, "text": "..."}, {"type": "paragraph", "text": "..."}],
 "right": [{"type": "bullets", "items": [...]}]
}
```

## Theme overrides

`meta.theme_overrides` 에서 Theme 의 개별 필드 덮어쓰기 가능. 색은 `[R,G,B]` (0..255). 주요 필드:

| 필드 | 타입 | 예시 |
|---|---|---|
| `fg`, `heading`, `accent`, `muted`, `code_bg` | RGB | `[29, 78, 216]` |
| `heading_font`, `body_font`, `mono_font` | string | `"Georgia"` |
| `size_title`, `size_h1..h6`, `size_body`, `size_small`, `size_code`, `size_kpi` | int (pt) | `24` |
| `margin_top`, `margin_bottom`, `margin_left`, `margin_right` | float (inch) | `1.2` |

Unknown fields are silently ignored.
