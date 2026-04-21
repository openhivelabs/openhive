# Spec: MCP listTools 글로벌 캐시

상위 계획: `docs/superpowers/plans/2026-04-22-perf-and-efficiency-direction.md` (#8)
작성일: 2026-04-22
상태: ⬜ 승인 대기

## 배경

`mcp/manager.ts:129-143` 의 `toolsCache` 는 proc-per-server 수준으로 이미 캐시. 하지만 엔진이 runNode 마다 `getTools(serverName)` 호출(`session.ts:375`), 여러 agent 가 같은 서버 목록을 다시 가져온다. 프로세스 레벨 캐시라 재사용은 되지만, team 단위로 `allowed_mcp_servers` 필터 적용된 합본 캐시는 없음 → 매 노드마다 병합 작업 반복.

- `session.ts:368-375` effectiveMcpServers + getTools 루프.
- `mcp/manager.ts:129-143,145-149` listCachedTools + getTools.
- `engine/team.ts:55,117-121` allowed_mcp_servers.

## 원칙

1. **결과 동일 보장.** 캐시 정확성 우선.
2. **서버 재시작 시 무효화.** `mcp/manager.restart(name)` 호출 시 해당 키 삭제.
3. **Team 설정 변경 시 무효화.** team yaml 수정이 로드되면 키 버전 bump.

## 변경

- `session.ts` 또는 신규 `engine/mcp-tools-cache.ts`:
  ```ts
  const cache = new Map<string, ToolInfo[]>()  // key = teamId|version|sortedServers
  export async function getTeamMcpTools(team: TeamSpec, allowed: string[]): Promise<ToolInfo[]>
  ```
- `mcp/manager.restart(name)` 와 team reload 훅에서 해당 키 삭제.

## 테스트

1. 단위: 같은 (team, servers) 2회 → 두 번째 listTools 실제 호출 X (spy).
2. 통합: team yaml 수정 후 reload → 캐시 miss 재계산.

## 측정

| 지표 | Before | After |
|---|---:|---:|
| runNode 시작 latency (MCP 3서버) | | |
| MCP listTools 호출 수 per run | | |

## 롤백

`getTeamMcpTools` 가 항상 miss 하도록 cache Map 참조 제거.

## 열린 질문

- [ ] 캐시 TTL 필요한지? (초안: TTL 없음, 이벤트 기반 무효화).
