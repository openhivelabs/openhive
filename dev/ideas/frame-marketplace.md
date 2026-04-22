# Frame / Panel Marketplace (deferred)

> 상태: **아이디어 단계**. 구현은 나중. 정식 설계는 착수 직전에 다시.
> 마지막 업데이트: 2026-04-22

## 문제

OpenHive 는 local-first / self-hosted OSS 프로젝트. 프레임(company + team + dashboard + skill 번들) 과 개별 패널이 종류가 많아질 예정이고, 유저가 "남이 만든 것" 을 쉽게 가져다 쓸 수단이 필요하다. 동시에:

- 우리는 서버를 운영하고 싶지 않다 (비용·가용성·개인정보·DDoS 책임 회피, OSS 정신).
- 유저 머신에 "남이 만든 코드" 가 실행될 수 있다는 게 진짜 리스크.
- Docker 기반 skill 샌드박싱은 MVP 범위 밖 — 마켓도 그 범위 밖이어야 안전.

## 접근: GitHub-backed 정적 레지스트리

서버 없이 GitHub 만으로 마켓 구성.

### 구조

- **`openhive-registry`** repo (공식 인덱스)
  - `index.json` 하나.
  - 엔트리 예시:
    ```json
    {
      "slug": "crm-starter",
      "kind": "frame",            // "frame" | "panel" | "template"
      "name": "CRM starter",
      "description": "…",
      "author": "github:foo",
      "repo": "foo/openhive-crm-starter",
      "ref": "v0.2.1",            // tag / commit sha
      "sha256": "…",              // 번들 tarball 체크섬
      "requires": { "openhive": ">=0.3" },
      "declarative_only": true    // 코드 실행 없음
    }
    ```
  - 기여 = PR. 머지 로그가 곧 감사 로그.

- **콘텐츠 본체**: 각 기여자 자기 repo. 태그된 릴리스의 tarball 을 raw 로 받거나 release asset 로 받음.
  - 대안: monorepo `contrib/` 디렉토리 하나로 통일 → 리뷰 강해짐, 기여 장벽 올라감. 초기엔 monorepo 가 관리 쉬울 수도.

- **클라이언트 플로우**
  1. "Browse marketplace" 누르면 `raw.githubusercontent.com/openhivelabs/openhive-registry/main/index.json` fetch.
  2. 리스트/검색/필터 (kind=panel / frame / template).
  3. 설치 누르면 해당 repo 에서 tarball 받아 sha256 검증.
  4. `~/.openhive/companies/...` 또는 `~/.openhive/templates/...` 에 풀어넣음.

### 장점

- 서버 0 대. CDN = GitHub.
- OSS 친화 — 포크해서 자기만의 레지스트리 쓸 수 있음 (클라이언트에서 URL 만 바꿈).
- 기여가 PR 이라 자동 감사 / 디스커션 가능.
- 인프라 걱정 없음 → 작은 팀이 유지 가능.

### 단점 / 한계

- "스토어" UX (설치 수, 리뷰, 별점) 없음.
- GitHub rate limit (익명 60/h) — ETag 캐싱 + 하루 1회 refresh 정도면 충분, 필요시 fetch 에 GH token 옵션 제공.
- 검색 UX 가 약함 — 나중에 "openhive.dev/registry" 같은 정적 페이지(Cloudflare Pages 류) 얹어서 JSON 예쁘게 보여주는 수준으로 해결 가능. 여전히 서버 없음.

## 보안 모델 (이게 진짜 포인트)

호스팅 주체가 아니라 **설치된 항목이 유저 프로세스에서 뭘 실행하느냐** 가 리스크.

### MVP 범위 (안전)

- **선언형만 허용**:
  - Frame = `company.yaml` + `teams/*.yaml` + `dashboard.yaml` + SQL 스키마 statement.
  - Panel = 기존 panel spec (type, props, binding, SQL / JSONPath).
  - 임의 JS / TS 코드 금지.
- 매니페스트에 `sha256` 필수. 클라이언트가 받으면 검증하고 안 맞으면 설치 거부.
- 매니페스트에 `declarative_only: true` 필드. 이게 false 인 건 MVP 에서 리스트업 안 함.

### 나중 (샌드박싱 들어온 뒤)

- Skill / 임의 코드 포함하는 항목 허용.
- Docker 기반 skill 샌드박싱 선행 필수.
- 작성자 allowlist 또는 서명 (minisign / sigstore) 기반 신뢰 체인.
- README 에 "use at your own risk" 명시 유지.

## 확장 여지 (전부 나중)

- 정적 카탈로그 사이트 (Cloudflare Pages) — 검색 / 태그 / 스크린샷.
- read-only 인덱서 — 매니페스트 스크레이핑해서 전문검색 API 얹기. 이것도 서버는 매우 얇음.
- 기여자 서명 키 등록.
- 유저 로컬에 "saved marketplace" — 오프라인에서도 브라우즈 가능하도록 index.json 캐시.

## 지금 할 일

**아무것도 안 함.** 스펙은 여기 정리만. 실제 설계 / 구현은 프레임 종류가 충분히 쌓이고, 선언형 panel spec 이 안정화된 뒤에 재개.

### 재개 시점 트리거

- 내장 프레임이 N개 이상이고, "남이 만든 거 쓰고 싶다" 니즈가 실제로 관찰될 때.
- Panel spec 의 declarative 경계가 확정되어서 "이것만 허용" 이라고 선언할 수 있을 때.
- 또는 유저(=프로젝트 오너)가 지금 OSS 확장 전략을 펼치기로 결정할 때.
