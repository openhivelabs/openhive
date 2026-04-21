# Themes

Four built-ins. Set via `meta.theme` in the spec.

## default
OpenHive amber on white. Headings black, body dark-grey. Use for generic decks, internal updates, product pitches.

## dark
Near-black background (`#161616`), off-white body, amber accent preserved. Use for evening demos, product keynotes, anything where a white slide would glare.

## minimal
Pure B/W with grey accents. Headings black, accent black (no color pop). Use for academic / research / legal where color feels flashy.

## corporate
Royal blue (`#1D4EB8`) accent, Georgia serif headings, Helvetica body on white. Use for board reports, external pitches, finance.

## Overrides

Use `meta.theme_overrides` to tweak one thing without defining a full theme.

```json
{
  "meta": {
    "theme": "default",
    "theme_overrides": {
      "accent": [220, 38, 38],
      "heading_font": "Georgia"
    }
  }
}
```

RGB values are JSON arrays of 3 ints (0–255). Fields: `bg`, `fg`, `heading`, `accent`, `accent_soft`, `muted`, `subtle_bg`, `grid`, `heading_font`, `body_font`, `mono_font`, `size_title`, `size_section`, `size_slide_title`, `size_subtitle`, `size_body`, `size_body_small`, `size_caption`, `size_kpi_value`, `size_kpi_label`.

Unknown fields are ignored without warning — always double-check spelling.
