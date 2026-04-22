# Runtime Optimization — Overview

> 단일 워크트리 `worktree-runtime-optimize` 에서 4개 작업을 순차 진행.

**목표**: OpenHive 서버의 유휴 RAM 400MB → 80MB, Python skill 피크 −35%, 디스크 I/O 감소, 상시 프로세스 최소화.

## 작업 순서 (한 워크트리 안)

1. **Plan 1 — Python skill 피크** (`2026-04-22-python-skill-peak-optimization.md`)
   - Lazy import, `-S -O`, semaphore. `packages/skills/**` + `apps/web/lib/server/skills/runner.ts`.
2. **Plan 5 — events.jsonl 튜닝** (`2026-04-22-events-jsonl-tuning.md`)
   - 기존 배치 구조는 있음 → env 설정화, fsync 모드, 크래시 리커버리 테스트.
3. **Plan 4 — Lazy init** (`2026-04-22-lazy-runtime-init.md`)
   - MCP manager, scheduler 게으른 기동.
4. **Plan 3 — Next.js → Hono/Vite** (`2026-04-22-next-to-hono-vite.md`)
   - 마지막. 가장 큰 변경. 1·4·5 가 안정된 엔진을 이식.

## 브랜치/워크트리

```bash
git worktree add ../openhive-runtime-optimize -b runtime-optimize main
cd ../openhive-runtime-optimize
```

각 플랜 완료마다 `git commit` + `git push origin runtime-optimize`. PR 은 플랜별로 나눠도 되고 한 번에 묶어도 됨.

## 공통 수용 기준

- `pnpm --filter @openhive/web test` 통과
- `biome check` 통과
- 유저 플로우 (로그인 → company 생성 → 세션 실행 → skill 호출 → 아티팩트 다운로드) 수동 smoke
- 성능 측정 지표는 각 플랜 말미 기록
