# Fonts & multi-script workbooks

Excel/Numbers/LibreOffice pick fonts from the **viewer's machine** — the
xlsx file carries font *names*, not glyph data. Choosing the right
typeface is the difference between a workbook that renders cleanly
across macOS/Windows/LibreOffice and one that shows tofu boxes for
non-Latin text.

## Auto-selection

`build_xlsx.py` scans every string in the spec, picks the dominant
non-Latin script, and rewrites `theme.body_font` /
`theme.heading_font` to the matching Noto family before rendering:

| Script detected              | Auto-selected family   |
|------------------------------|------------------------|
| Hangul                       | Noto Sans KR           |
| Hiragana / Katakana          | Noto Sans JP           |
| CJK Unified (no kana/hangul) | Noto Sans SC           |
| Arabic                       | Noto Sans Arabic       |
| Devanagari                   | Noto Sans Devanagari   |
| Thai                         | Noto Sans Thai         |
| Hebrew                       | Noto Sans Hebrew       |
| Latin only                   | Theme default (Calibri / Cambria / etc.) |

Mixed-script workbooks pick a single family by priority (Hangul > kana
> Han > Arabic > Devanagari > Thai > Hebrew). Reader software falls
through to its own substitution table for the slots that family
doesn't cover, which is fine since each Noto cut also contains full
Latin glyphs.

## Reader fallback table

What you'll likely see in the wild when the named family isn't
installed:

| Family declared        | macOS substitute       | Windows substitute     |
|------------------------|------------------------|------------------------|
| Calibri                | Calibri (bundled)      | Calibri (bundled)      |
| Noto Sans KR           | Apple SD Gothic Neo    | Malgun Gothic          |
| Noto Sans JP           | Hiragino Kaku Gothic   | Yu Gothic              |
| Noto Sans SC           | PingFang SC            | Microsoft YaHei        |
| Noto Sans Arabic       | Geeza Pro              | Arial / Tahoma         |

LibreOffice depends on host fonts with no built-in Office fallbacks —
bundle the Noto family or stick to the platform defaults above for
predictable cross-platform output.

## Overriding fonts

Pin a family per workbook via `meta.theme_overrides`:

```jsonc
{
  "meta": {
    "theme": "corporate",
    "theme_overrides": {
      "body_font": "Noto Sans KR",
      "heading_font": "Noto Sans KR",
      "mono_font": "JetBrains Mono"
    }
  },
  "sheets": [...]
}
```

This bypasses the auto-detect path entirely.

## Troubleshooting

**Korean / CJK characters render as boxes** — the chosen family is
missing on the viewer's machine. Check what you wrote vs. the table
above and make sure the family name exists locally. Bundle Noto if
you can't rely on the host machine.

**Bold weight looks the same as regular for non-Latin text** — Noto
families ship a hinted Bold variable axis. Most readers handle this
correctly. If yours doesn't, override `theme.heading_font` to a
specific static cut (e.g. `"Noto Sans KR Bold"`).

**Mixed Korean + Arabic in one cell** — Excel renders both correctly
when the named font has glyphs for both, which Noto families do (each
script's Noto cut contains Latin + that script). For other fonts
behaviour is reader-dependent.
