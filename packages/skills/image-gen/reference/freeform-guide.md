# freeform mode guide

Use freeform only when no `template` matches. It costs ~10× more tokens.

## Principles

1. **Send a full HTML document.** Include all of `<!doctype html><html>…</html>`.
2. **Fix body width/height in pixels.** Must match the viewport:
   ```css
   html, body { margin:0; width:1280px; height:720px; overflow:hidden; }
   ```
3. **Prefer a system font stack** — Google Fonts depends on networkidle loading, so it is slow and sometimes fails.
   ```css
   font-family: 'Inter', 'Pretendard', system-ui, -apple-system, sans-serif;
   ```
4. **Images must be `file://` absolute paths or https URLs.** Local relative paths do not work (rendering is based on `about:blank`).

## Recommended size presets

| Purpose | W × H |
| --- | --- |
| YouTube thumbnail | 1280 × 720 |
| OG Image / Twitter card | 1200 × 630 |
| Instagram square | 1080 × 1080 |
| Report cover (16:9) | 1600 × 900 |
| Story portrait | 1080 × 1920 |

## Avoid

- Loading JS chart libraries (Chart.js, etc.) — unstable with `wait_until=networkidle`. If you need a chart, draw SVG directly.
- Animations — make the first frame meaningful.
- `position:fixed` + scroll-dependent layouts — everything must fit inside the viewport.
- External CDN dependency — on network failure, screenshot captures missing fonts/images.
