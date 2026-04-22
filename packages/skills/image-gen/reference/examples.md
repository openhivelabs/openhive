# image-gen examples

## 1. YouTube 썸네일 — bold text

```json
{
  "mode": "template",
  "template": "yt-bold-text",
  "vars": {
    "title": "AGI is not close. Here's why.",
    "subtitle": "A deep dive into scaling limits",
    "accent": "#ef4444",
    "bg_style": "gradient"
  },
  "filename": "agi-not-close.png"
}
```

## 2. 분기 실적 카드

```json
{
  "mode": "template",
  "template": "stat-card",
  "vars": {
    "value": "+42%",
    "label": "Q1 revenue",
    "delta": "YoY",
    "tone": "pos",
    "accent": "#22c55e"
  }
}
```

## 3. 보고서 커버

```json
{
  "mode": "template",
  "template": "cover-minimal",
  "vars": {
    "title": "2026 Agent Platform Review",
    "subtitle": "OpenHive · internal architecture retrospective",
    "meta": "2026-04-22 · prepared by Core"
  }
}
```

## 4. 인용구

```json
{
  "mode": "template",
  "template": "yt-quote",
  "vars": {
    "quote": "Simplicity is the ultimate sophistication.",
    "author": "Leonardo da Vinci",
    "accent": "#fbbf24"
  }
}
```

## 5. Freeform — 특이 레이아웃

```json
{
  "mode": "freeform",
  "width": 1200,
  "height": 630,
  "html": "<!doctype html><html><head><style>html,body{margin:0;width:1200px;height:630px;display:grid;place-items:center;background:radial-gradient(circle at 30% 30%,#6366f1,#0b1020);font-family:system-ui,sans-serif;color:#fff}.card{padding:64px 96px;background:#0b1020;border-radius:32px;box-shadow:0 40px 80px rgba(0,0,0,.4);text-align:center}h1{font-size:96px;margin:0;font-weight:900;letter-spacing:-.03em}p{font-size:28px;margin:16px 0 0;color:#a5b4fc}</style></head><body><div class='card'><h1>Hello OpenHive</h1><p>Freeform rendered via Chromium</p></div></body></html>"
}
```
