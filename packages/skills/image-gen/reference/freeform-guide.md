# freeform mode guide

Use freeform only when no `template` matches. It costs ~10× more tokens.

## 기본 원칙

1. **전체 HTML 문서를 보내라.** `<!doctype html><html>…</html>` 전부.
2. **body width/height 를 픽셀로 고정.** viewport 와 일치해야 한다:
   ```css
   html, body { margin:0; width:1280px; height:720px; overflow:hidden; }
   ```
3. **폰트는 system stack 을 우선 써라** — Google Fonts 는 networkidle 로딩에 의존하므로 느리고 가끔 실패한다.
   ```css
   font-family: 'Inter', 'Pretendard', system-ui, -apple-system, sans-serif;
   ```
4. **이미지는 `file://` 절대경로 또는 https URL.** 로컬 상대경로는 안 된다 (`about:blank` 기반 렌더이기 때문).

## 권장 사이즈 프리셋

| 용도 | W × H |
| --- | --- |
| YouTube 썸네일 | 1280 × 720 |
| OG Image / 트위터 카드 | 1200 × 630 |
| Instagram 정사각 | 1080 × 1080 |
| 보고서 커버 (16:9) | 1600 × 900 |
| Story 세로형 | 1080 × 1920 |

## 피할 것

- JS 기반 차트 라이브러리 (Chart.js 등) 로딩 — `wait_until=networkidle` 와 불안정. 차트가 필요하면 SVG 로 직접.
- 애니메이션 — 첫 프레임에 의미 있는 상태가 나오게.
- `position:fixed` + 스크롤 의존 레이아웃 — viewport 안에 모든 게 들어와야 함.
- 외부 CDN 의존 — 네트워크 실패 시 폰트/이미지 빠진 상태로 스샷이 찍힌다.
