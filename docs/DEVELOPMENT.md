# 로컬 개발 가이드

## 준비

- Node.js 22 이상, pnpm 10(`npm i -g pnpm@10`)
- 추가 계정은 필요 없다. wrangler가 로컬 workerd, D1, Durable Objects를 실행한다.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars          # INTERNAL_SECRET (두 파일 값이 같아야 함)
cp apps/game-worker/.dev.vars.example apps/game-worker/.dev.vars
# 선택: apps/api/.dev.vars 에 ADMIN_BOOTSTRAP_TOKEN=<16자 이상> 추가 → 최초 관리자 생성
pnpm db:migrate:local
pnpm db:seed:local            # 개발용 샘플 테이블 4개
```

## 실행

| 터미널 | 명령 | 주소 |
|---|---|---|
| 1 | `pnpm dev:workers` | API + 게임 룸 http://localhost:8787 (빌드된 사용자 사이트도 서빙) |
| 2 | `pnpm dev:web` | 사용자 사이트(HMR) http://localhost:5173 → /api, /ws 프록시 |
| 3 | `pnpm dev:admin` | 관리자 콘솔 http://localhost:5174 |

**최초 관리자 생성**: 5173에서 가입한 뒤 아래 명령을 실행한다.

```bash
curl -X POST http://localhost:5174/api/admin/auth/bootstrap -H "Origin: http://localhost:5174" -H "Content-Type: application/json" \
  -d '{"token":"<ADMIN_BOOTSTRAP_TOKEN>","email":"<가입 이메일>"}'
```

**두 사람이 같이 플레이해 보기**: 일반 창과 시크릿 창(또는 다른 브라우저)에서 각각 가입하고 같은 테이블에 앉는다.

## 테스트

| 명령 | 내용 |
|---|---|
| `pnpm typecheck` | 전체 타입 검사 |
| `pnpm test` | 엔진 규칙 24 + 속성 2(4,000핸드) + 저장 크기 1 |
| `pnpm test:integration` | 실제 workerd를 포트 8799에 띄워 REST·WS·DO·관리자·커뮤니티 42건 실행(재시작 테스트는 8811) |
| `pnpm test:e2e` | Playwright(포트 8798, 관리자 5174). Playwright Chromium이 없으면 `PW_CHANNEL=chrome` |
| `node tests/visual/capture.mjs` | 실행 중인 개발 서버를 실제 Chrome으로 캡처(`tests/visual/out`) |

## DB 변경

1. `packages/db/src/schema.ts` 수정
2. `pnpm db:generate` → `packages/db/migrations/000N_*.sql`(파일명을 의미 있게 바꿀 것)
3. `pnpm db:migrate:local`

## 엔진 패치

`patches/poker-engine-ts@0.1.3.patch`는 `pnpm install` 때 자동 적용된다. 엔진 버전을 올리면 패치 필요 여부를 `docs/ENGINE_NOTES.md`의 대조 실험(패치를 되돌린 뒤 테스트)으로 다시 확인한다.

## 문제 해결

- **포트 충돌**: 이전에 띄운 `wrangler dev`나 workerd가 남아 있는지 확인한다.
- **로컬 상태 초기화**: `.wrangler/state`를 지운 뒤 migrate와 seed를 다시 한다.
