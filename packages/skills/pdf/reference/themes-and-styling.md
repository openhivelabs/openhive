# Themes, inline markdown, limits

## Themes

| name      | accent palette                      | fonts                                    |
|-----------|-------------------------------------|------------------------------------------|
| `default` | blue + teal + purple                | Helvetica                                |
| `formal`  | navy + slate + amber                | Times-Roman                              |
| `report`  | navy + amber + teal                 | Helvetica heading / Times-Roman body     |
| `minimal` | mono / black                        | Helvetica                                |
| `modern`  | indigo + pink + green               | Helvetica                                |

Each theme exposes `accent` / `accent_2` / `accent_3` for categorical visuals
and `success` / `warning` / `danger` / `info` / `muted` / `border` semantic
colors. Override any field via `meta.theme_overrides` (RGB triples).

Non-Latin (Korean / CJK / Arabic / Devanagari / Thai / Hebrew) docs trigger
auto-download of a Noto font for that script + a hinted Bold static so
`<b>` actually renders bold instead of falling back to Regular.

## Inline markdown (any text-bearing block)

| Markup            | Renders as              |
|-------------------|-------------------------|
| `**bold**`        | **bold**                |
| `*italic*`        | *italic* (no italic in CJK) |
| `~~strike~~`      | ~~strike~~              |
| `` `code` ``      | mono span on tinted bg  |
| `text \| text \| text` | auto-split into lines (single bullet → multi-line) |

Backslash-escape any marker to keep it literal: `\*`, `\**`, `` \` ``, `\~~`.

## No image embeds

The skill does not accept image files. Most "image" use-cases in reports
are actually data visuals → use `chart`, `kpi_row`, `callout`, or
`progress` instead. `md_to_spec.py` converts `![alt](url)` markdown into a
muted "_[image omitted]_" paragraph rather than failing.

Page-level `overlay_image` (logo stamp on existing PDF) is still
available — that's a separate workflow that takes an existing image
file path.

## Limits

- Viewer font substitution can shift line widths.
- `overlay_text` is for watermarks, NOT body text changes.
- `extract_doc.py` is heuristic — tables / layout are lost. Use only when
  `.spec.json` is missing.
- Editing a digitally signed PDF invalidates the signature.
- Encrypted PDFs must be decrypted before editing.
