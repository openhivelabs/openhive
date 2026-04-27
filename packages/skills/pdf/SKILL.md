---
name: pdf
description: Build, inspect, edit, and extract PDF documents. Two edit tracks — page-level ops (merge/split/rotate/watermark) via pypdf, and content changes via spec round-trip (build_doc regenerates from .spec.json).
triggers:
  keywords: [pdf, report, document, generate, edit]
  patterns: ['\.pdf\b']
---

# pdf skill

## Quickstart

Pipe spec / patch JSON via stdin — never write a temporary `spec.json` /
`*_patch.json` to disk:

```
echo '{...}' | build_doc.py --out report.pdf
echo '{...}' | edit_doc.py  --in in.pdf  --out out.pdf
inspect_doc.py --in in.pdf
extract_doc.py --in in.pdf --out spec.json    (only when there's no sidecar)
md_to_spec.py  --in in.md  --out spec.json    (markdown → spec)
```

PDF is a rendered format; byte-level edits are limited. This skill works
in two rails:
1. **Page ops** (pypdf) — `merge / split / extract_pages / rotate /
   overlay_text / overlay_image`. Treats pages as opaque units.
2. **Content changes = spec rebuild** — `edit_doc.py` reads the sidecar
   `<pdf>.spec.json` that `build_doc.py` auto-saves next to every PDF it
   produces, applies your spec ops (`set_text / replace_block /
   insert_block / delete_block / move_block / update_table_cell`), and
   regenerates. **Don't write the sidecar by hand** — it's already there.
   The sidecar lives on disk but does NOT appear in the chat artifact
   panel (only the PDF does).

## Block types (17)

| Type              | Purpose                                              |
|-------------------|------------------------------------------------------|
| `title`           | Cover title (+ `subtitle` / `tagline` / `footer`)    |
| `heading`         | Section heading (level 1-6, auto-collected by `toc`) |
| `paragraph`       | Body paragraph (supports `align` + inline markdown)  |
| `bullets`         | Unordered list (2-level nesting)                     |
| `numbered`        | Ordered list (sub-list uses a/b/c)                   |
| `table`           | Table (`style: grid` \| `light` \| `plain`)          |
| `page_break`      | Page break                                           |
| `quote`           | Tinted quote block + accent rule                     |
| `code`            | Code block (rejected for executive/board audience)   |
| `horizontal_rule` | Horizontal divider                                   |
| `toc`             | Real TOC populated via `multiBuild`                  |
| `kpi_row`         | Card row, per-stat `tone` color                      |
| `two_column`      | Two-column layout                                    |
| `spacer`          | Vertical spacing (pt)                                |
| `callout`         | Colored info box (`info`/`success`/`warning`/`danger`/`note`/`tip`/`neutral`) |
| `chart`           | `bar` \| `line` \| `pie` (via reportlab.graphics)    |
| `progress`        | Labeled progress bars with semantic `tone`           |

Image embeds intentionally not supported. Use `chart` / `kpi_row` /
`callout` / `progress` for data visuals.

## Three rules you must follow

1. **One user-facing PDF per request.** Generic / verification names
   (`test.pdf`, `probe.pdf`, `out.pdf`, `tmp.pdf` …) auto-route to /tmp.
   Use semantic names (`report.pdf`, `q1-summary.pdf`) for deliverables.
   Pass `--scratch` for sanity-check builds. Pipe patch JSON through
   stdin, never `*_patch.json` on disk.
   Full rules: `reference/output-discipline.md`.

2. **Match the audience.** Set `meta.audience` to one of `executive`,
   `board`, `investor`, `finance`, `technical`, `briefing`, `internal`
   (or 임원/이사회/투자자). The validator hard-rejects `code` blocks in
   executive contexts and warns on rhetorical `~~strikethrough~~`. Auto-
   detected from `meta.title` keywords too. Full guide:
   `reference/audience-rules.md`.

3. **Write a spec, don't iterate the PDF.** For inline edits go through
   the spec, not the rendered PDF. `extract_doc.py` is lossy — only when
   `.spec.json` is missing.

## More

- `reference/spec_schema.md` — full spec JSON structure
- `reference/themes-and-styling.md` — themes, inline markdown, limits
- `reference/patch_dsl.md` — edit_doc.py patch operations
- `reference/examples.md` — worked examples
- `reference/troubleshooting.md` — common failures
