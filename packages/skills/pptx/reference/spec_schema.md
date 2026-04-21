# pptx spec schema

The spec is a JSON object with two top-level keys: `meta` and `slides`.

```jsonc
{
  "meta": {
    "title": "Q4 Board Report",      // optional, used for file metadata
    "theme": "default",               // default | dark | minimal | corporate
    "theme_overrides": {              // optional. Override individual Theme fields.
      "accent": [29, 78, 216],        // RGB triplet as JSON array
      "heading_font": "Georgia"
    },
    "size": "16:9"                    // 16:9 | 4:3 | a4
  },
  "slides": [ /* one object per slide, in order */ ]
}
```

Every slide object has `type` (required, enum) and optional `notes` (speaker notes, plain text).

---

## title

```jsonc
{
  "type": "title",
  "title": "OpenHive",                          // required
  "subtitle": "Agent orchestration, local-first",
  "author": "Team OpenHive",
  "date": "2026-04-20"
}
```

## section

Divider between major parts of the deck. Accent stripe on the left.

```jsonc
{ "type": "section", "title": "1. 배경", "subtitle": "왜 지금인가" }
```

## bullets

Top-aligned title + bullet list. Nesting: immediately follow a string with an array.

```jsonc
{
  "type": "bullets",
  "title": "왜 지금인가",
  "bullets": [
    "LLM 이 스키마와 UI 를 런타임에 만든다",
    "사용자 = 대화",
    ["하위 포인트 1", "하위 포인트 2"],
    "로컬 퍼스트"
  ]
}
```

## two_column

Two columns sharing a title. Each side has its own `kind`: `text` | `bullets` | `image`.

```jsonc
{
  "type": "two_column",
  "title": "아키텍처 한눈에",
  "left":  { "kind": "bullets", "content": ["engine", "tools", "skills"] },
  "right": { "kind": "image", "content": "/path/to/arch.png", "fit": "contain" }
}
```

## image

```jsonc
{
  "type": "image",
  "title": "Dashboard screenshot",      // optional
  "image": "https://example.com/shot.png",
  "fit": "contain",                     // contain | cover | full_bleed
  "caption": "The Run-mode canvas"      // optional
}
```

## table

```jsonc
{
  "type": "table",
  "title": "스킬 로스터",
  "headers": ["Skill", "Engine", "Status"],
  "rows": [
    ["text-file", "builtin", "done"],
    ["pptx",      "python-pptx", "done"]
  ]
}
```

## chart

```jsonc
{
  "type": "chart",
  "title": "분기별 ARR",
  "kind": "column",                      // bar | column | line | pie | area | scatter
  "categories": ["Q1", "Q2", "Q3", "Q4"],
  "series": [
    { "name": "Base",    "values": [100, 140, 210, 320] },
    { "name": "Stretch", "values": [120, 180, 290, 450] }
  ]
}
```

- `pie`: put a single series whose `values.length == categories.length`.
- `scatter`: `categories` is the x-axis values (numeric recommended); each series provides y-values of the same length.

## comparison

```jsonc
{
  "type": "comparison",
  "title": "옵션 비교",
  "columns": [
    { "header": "Option A", "points": ["싸다", "느리다"] },
    { "header": "Option B", "points": ["빠르다", "비싸다"] }
  ]
}
```

2–3 columns render best. 4 is possible but text becomes small.

## quote

```jsonc
{
  "type": "quote",
  "quote": "소프트웨어의 해자는 스키마와 UI.",
  "attribution": "OpenHive 팀"
}
```

## steps

Numbered circles on a connecting line, 3–5 phases.

```jsonc
{
  "type": "steps",
  "title": "유저 여정",
  "steps": [
    { "title": "설치",     "description": "openhive serve" },
    { "title": "설계",     "description": "에이전트 + 보고 라인" },
    { "title": "실행",     "description": "챗/크론/웹훅" }
  ]
}
```

## kpi

Hero stats arranged horizontally.

```jsonc
{
  "type": "kpi",
  "title": "현재 지표",                    // optional
  "stats": [
    { "value": "42%",  "label": "conversion", "delta": "+3pp" },
    { "value": "$1.2M","label": "ARR",         "delta": "+18%" },
    { "value": "1,204","label": "active teams" }
  ]
}
```

`delta` that starts with `+` is rendered green, `-` is red, other values stay theme-muted.

## closing

Thank-you / Q&A slide. If `title` is omitted, uses "Thank you".

```jsonc
{ "type": "closing", "title": "고맙습니다", "subtitle": "github.com/openhive" }
```

---

## Theme overrides (advanced)

`meta.theme_overrides` accepts any field of `lib.themes.Theme`. Most common:

| Field           | Type       | Example             |
|-----------------|------------|---------------------|
| `bg`            | RGB array  | `[250, 250, 250]`   |
| `fg`            | RGB array  | `[30, 30, 30]`      |
| `heading`       | RGB array  | `[20, 20, 20]`      |
| `accent`        | RGB array  | `[29, 78, 216]`     |
| `heading_font`  | string     | `"Georgia"`         |
| `body_font`     | string     | `"Helvetica"`       |
| `size_title`    | int (pt)   | `56`                |
| `size_body`     | int (pt)   | `20`                |

Unknown fields are silently ignored.
