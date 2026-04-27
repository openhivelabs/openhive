# Fonts & multi-script decks

PowerPoint and Keynote pick fonts from the **viewer's machine**, not the
deck. The skill never embeds a font file. Choosing the right typeface
name is the difference between a deck that renders cleanly across
macOS/Windows/LibreOffice and one that shows tofu boxes for non-Latin
text.

## Auto-selection (default)

`build_deck.py` scans every string in the spec, picks the dominant
non-Latin script, and rewrites `theme.heading_font` /
`theme.body_font` to the matching Noto family before rendering:

| Script detected | Auto-selected family   |
|-----------------|------------------------|
| Hangul          | Noto Sans KR           |
| Hiragana/Katakana | Noto Sans JP         |
| CJK Unified (no kana/hangul) | Noto Sans SC |
| Arabic          | Noto Sans Arabic       |
| Devanagari      | Noto Sans Devanagari   |
| Thai            | Noto Sans Thai         |
| Hebrew          | Noto Sans Hebrew       |
| Latin only      | Theme default (Helvetica/Georgia/etc.) |

Mixed-script decks pick a single family by priority (Hangul > kana >
Han > Arabic > Devanagari > Thai > Hebrew). Reader software falls back
through its own substitution table for the slots that family doesn't
cover, which is acceptable since each Noto cut also contains full Latin
glyphs.

## Per-run typeface slots

OOXML stores three typeface slots on every text run:

| Slot     | Purpose                                                   |
|----------|-----------------------------------------------------------|
| `<a:latin>` | Latin / Cyrillic / Greek                                |
| `<a:ea>`    | East-Asian (Korean, Japanese, Chinese)                  |
| `<a:cs>`    | Complex script (Arabic, Hebrew, Thai, Devanagari)       |

`python-pptx`'s `run.font.name = "..."` only writes `<a:latin>`. The
skill's `_set_run_font` helper (renderers.py) and `set_style` patch op
both write all three slots in one go. If you raw-edit XML, do the same
or PowerPoint will use a different font for east-asian glyphs than for
Latin ones in the same run.

## Overriding fonts

Pin a family per deck via `meta.theme_overrides`:

```json
{
  "meta": {
    "theme": "default",
    "theme_overrides": {
      "heading_font": "Noto Sans KR",
      "body_font": "Noto Sans KR",
      "mono_font": "JetBrains Mono"
    }
  },
  "slides": [...]
}
```

This bypasses the auto-detect path entirely.

## Reader fallback table

What you'll likely see in the wild when the named family isn't
installed:

| Family declared        | macOS substitute       | Windows substitute     |
|------------------------|------------------------|------------------------|
| Noto Sans KR           | Apple SD Gothic Neo    | Malgun Gothic          |
| Noto Sans JP           | Hiragino Kaku Gothic   | Yu Gothic              |
| Noto Sans SC           | PingFang SC            | Microsoft YaHei        |
| Noto Sans TC           | PingFang TC            | Microsoft JhengHei     |
| Noto Sans Arabic       | Geeza Pro              | Arial / Tahoma         |
| Noto Sans Devanagari   | Kohinoor Devanagari    | Mangal / Nirmala UI    |
| Noto Sans Thai         | Thonburi               | Tahoma / Leelawadee    |
| Noto Sans Hebrew       | Arial Hebrew           | David / Arial          |
| Helvetica              | Helvetica              | Arial (substituted)    |
| Georgia                | Georgia                | Georgia                |

Both Office and Keynote ship these fallbacks; LibreOffice depends on
host fonts. Bundle the Noto family or stick to the platform fallbacks
above for predictable output.

## Troubleshooting

**Korean / CJK characters render as boxes** — the chosen family's
`<a:ea>` slot is missing. Verify with:

```bash
python scripts/validate_deck.py --in deck.pptx
```

then unzip and inspect a slide's `<a:rPr>` — every run should have
`<a:latin>`, `<a:ea>`, and `<a:cs>` typeface attributes set to the same
family name.

**Bold weight looks the same as regular for non-Latin text** — Noto
families ship a hinted Bold variable axis. Most readers handle this
correctly. If yours doesn't, override `theme.heading_font` to a static
Bold cut (e.g. `Noto Sans KR Bold`).

**Font is there on my Mac but not on the user's Windows machine** —
that's the whole reason the skill targets Noto. Noto is the only family
with full coverage that's free to redistribute, so users can install it
once and stop seeing tofu.
