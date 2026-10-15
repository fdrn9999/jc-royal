# Cloudflare 배포 가이드

## 운영 주소

| 용도 | 주소 | Worker 이름(`env.production`) |
|---|---|---|
| 사용자 사이트 + API | https://jc-royal.site | `play` (`apps/api`) |
| 관리자 콘솔 | https://admin.jc-royal.site | `admin` (`apps/admin`) |
| 테이블 룸(Durable Object) | 공개 주소 없음(`workers_dev: false`) | `jc-royal-game-prod` (`apps/game-worker`) |

- 두 도메인은 Cloudflare 대시보드에서 각 Worker의 커스텀 도메인으로 붙였다(4절).
- workers.dev 주소(https://play.jcroyal.workers.dev, https://admin.jcroyal.workers.dev)는 개발·미리보기용으로 남아 있다. 계정의 workers.dev 서브도메인은 `jcroyal`이다(대시보드 Workers & Pages → Subdomain).
  - 사용자 사이트는 workers.dev에서도 동작한다. 다만 메일과 관리자 콘솔의 링크는 `APP_ORIGIN`(https://jc-royal.site)을 가리키고, 로그인 쿠키는 주소마다 따로다.
  - 관리자 콘솔은 workers.dev에서 화면만 열린다. 관리자 API는 `ADMIN_ORIGIN`(https://admin.jc-royal.site)에서 온 요청만 받으므로 로그인할 수 없다.

## 1. 리소스 만들기(최초 1회)

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create jc-royal-db-prod     # 출력된 database_id를 아래 두 파일의 env.production에 입력
#   apps/api/wrangler.jsonc        env.production.d1_databases[0].database_id
#   apps/game-worker/wrangler.jsonc env.production.d1_databases[0].database_id
```

주소를 바꾸면 `apps/api/wrangler.jsonc`의 `env.production.vars`에서 `ALLOWED_ORIGINS`, `ADMIN_ORIGIN`, `APP_ORIGIN`을 함께 바꾼다(지금은 각각 `https://jc-royal.site,https://admin.jc-royal.site`, `https://admin.jc-royal.site`, `https://jc-royal.site`). 개발 환경(최상위 `vars`)은 localhost 그대로다. `tests/integration/production-config.test.ts`가 두 환경의 값을 확인한다.

## 2. 시크릿

```bash
# 두 Worker에 같은 값(32바이트 이상 무작위)을 넣어야 API ↔ 게임 룸 내부 호출이 통과한다
openssl rand -base64 48 | pnpm exec wrangler secret put INTERNAL_SECRET --env production -c apps/api/wrangler.jsonc
#   (같은 값을) pnpm exec wrangler secret put INTERNAL_SECRET --env production -c apps/game-worker/wrangler.jsonc
pnpm exec wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env production -c apps/api/wrangler.jsonc   # 최초 관리자 생성 후 삭제
pnpm exec wrangler secret put RESEND_API_KEY --env production -c apps/api/wrangler.jsonc          # 가입 인증·재설정 메일
```

**메일(Resend): 가입 이메일 인증, 비밀번호 재설정**
- 발신 도메인: `jc-royal.site`(Resend에서 Verified). 발신 주소 `MAIL_FROM`은 `JC ROYAL <noreply@jc-royal.site>`이고 `apps/api/wrangler.jsonc`의 `env.production.vars`에 있다.
- 켜지는 조건: `RESEND_API_KEY` 시크릿, `MAIL_FROM`, `APP_ORIGIN`이 모두 있어야 한다. 이 변경을 배포하면 켜진다.
- 켜지면: 가입 화면에 이메일 인증번호 단계가 생기고(인증 없이는 가입 불가), 재설정 메일과 관리자 재설정 링크가 회원 계정 언어로 발송된다.
  - 메일의 재설정 링크와 로고는 `APP_ORIGIN`(https://jc-royal.site)을 쓴다: `https://jc-royal.site/reset?token=…`, `https://jc-royal.site/email/logo.png`.
  - 로그인에는 인증 여부를 묻지 않으므로, 메일이 꺼져 있던 동안 인증 없이 가입한 회원도 그대로 로그인한다.
- 꺼져 있을 때(`MAIL_FROM`이나 `RESEND_API_KEY`가 없을 때): 가입은 이메일 인증 없이 진행된다(`emailVerifiedAt` 비어 있음). 관리자가 콘솔에서 재설정 링크를 발급하고, 화면에 나오는 회원 언어 안내문을 복사해 전달한다.
- `onboarding@resend.dev`(Resend 테스트 발신자)는 Resend 계정 소유자 주소로만 보낼 수 있어 운영에 쓸 수 없다.
- 개발 환경(`wrangler.jsonc` 최상위 `vars`)에는 `MAIL_FROM`이 없어 메일을 보내지 않는다. 운영이 아니면 인증번호와 재설정 토큰을 응답의 `devCode`·`devToken`으로 받는다. 로컬에서 실제 메일을 시험하려면 `apps/api/.dev.vars`에 `RESEND_API_KEY`와 `MAIL_FROM`을 넣는다(`.dev.vars.example`).
- 템플릿: `apps/api/src/lib/mail.ts`. 로고는 `apps/web/public/email/logo.png`(사용자 사이트에서 제공)를 쓴다.

## 3. 배포 순서

```bash
pnpm install && pnpm build
pnpm exec wrangler d1 migrations apply jc-royal-db-prod --remote --env production -c apps/api/wrangler.jsonc
pnpm exec wrangler deploy --env production -c apps/game-worker/wrangler.jsonc   # ① DO 클래스(SQLite 저장소)
pnpm exec wrangler deploy --env production -c apps/api/wrangler.jsonc           # ② API + 사용자 사이트(play)
pnpm exec wrangler deploy --env production -c apps/admin/wrangler.jsonc         # ③ 관리자 콘솔(admin, 서비스 바인딩)
```

- **CI**: push와 PR마다 `CI` 워크플로가 실행된다. 타입 검사, 엔진·통합·E2E 테스트, 운영 번들 dry-run을 한다.
- **자동 배포**: `main`에 push하고 CI가 모두 통과하면, 같은 실행의 `deploy` 작업(`.github/workflows/deploy.yml`)이 위 순서대로 운영에 배포한다.
  - 순서: 빌드 → D1 마이그레이션 → game → play → admin → `/api/health` 확인.
  - 배포는 한 번에 하나만 돈다. 새 push는 앞선 배포를 취소하지 않고 기다린다. `main`의 CI 실행도 취소하지 않는다.
  - PR과 다른 브랜치는 테스트만 하고 배포하지 않는다.
- **수동 재배포**: GitHub → Actions → `Deploy` → Run workflow. 타입 검사와 단위 테스트를 먼저 돌린다.
- **Worker 시크릿**(`INTERNAL_SECRET`, `RESEND_API_KEY` 등)은 Cloudflare에 남아 있어 배포마다 다시 넣지 않는다.
- **승인 단계(선택)**: 배포 작업은 GitHub 환경 `production`을 쓴다. Settings → Environments → production에서 Required reviewers를 켜면 배포 전에 승인을 받는다.

### 저장소 시크릿(최초 1회)

| 이름 | 값 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `b78eee68e557f7e42b291d5b2c959885` |
| `CLOUDFLARE_API_TOKEN` | 아래 권한의 API 토큰 |

1. Cloudflare 대시보드 → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** 템플릿을 고른다.
2. 권한에 **Account · D1 · Edit**를 추가한다. Account Resources는 이 계정만, Zone Resources는 All zones(또는 비워 둠)로 둔다.
3. 만든 토큰을 GitHub 저장소 Settings → Secrets and variables → Actions → New repository secret에 넣는다. CLI로는 다음과 같다.

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --repo fdrn9999/jc-royal --body b78eee68e557f7e42b291d5b2c959885
gh secret set CLOUDFLARE_API_TOKEN --repo fdrn9999/jc-royal   # 프롬프트에 토큰 붙여넣기
```

시크릿이 없으면 `deploy` 작업은 첫 단계에서 이유를 남기고 실패한다.

## 4. 커스텀 도메인

`jc-royal.site`는 Cloudflare zone이고, 두 커스텀 도메인은 대시보드(Workers & Pages → 각 Worker → Settings → Domains & Routes)에서 붙였다.

| 도메인 | Worker |
|---|---|
| `jc-royal.site` | `play` |
| `admin.jc-royal.site` | `admin` |

- wrangler 설정에는 `routes`를 두지 않는다. `routes`가 없으면 `wrangler deploy`는 대시보드의 커스텀 도메인을 건드리지 않고, workers.dev 주소도 켜 둔다(wrangler 4.150 동작).
- 설정으로 옮기려면 각 Worker의 `env.production`에 아래를 넣는다. 이때 주의할 점:
  - `routes`를 넣으면 `workers_dev`의 기본값이 `false`가 되어 workers.dev 주소가 꺼진다. 미리보기 주소를 남기려면 `"workers_dev": true`를 함께 넣는다.
  - 커스텀 도메인은 배포할 때마다 설정 내용으로 통째로 바뀐다. CI 토큰에 zone 권한이 있어야 한다(3절 토큰의 Zone Resources).
  - `tests/integration/production-config.test.ts`가 지금의 방식(routes 없음, workers.dev 유지)을 확인하므로 함께 고친다.

```jsonc
// apps/api/wrangler.jsonc env.production
"routes": [{ "pattern": "jc-royal.site", "custom_domain": true }], "workers_dev": true
// apps/admin/wrangler.jsonc env.production
"routes": [{ "pattern": "admin.jc-royal.site", "custom_domain": true }], "workers_dev": true
```

- 도메인을 바꾸면 1절의 세 변수와 2절의 `MAIL_FROM`, `.github/workflows/deploy.yml`의 `PLAY_URL`·`ADMIN_URL`(배포 후 확인 주소)을 함께 바꾼다.
- zone에 Cloudflare Web Analytics 자동 삽입이 켜져 있다. 두 도메인의 HTML에 `static.cloudflareinsights.com` 스크립트가 붙지만, CSP(`script-src 'self'`)가 막아 실행되지 않는다(브라우저 콘솔에 CSP 경고). 쓰지 않으면 대시보드에서 자동 삽입을 끈다. 쓰려면 사용자 사이트의 CSP에 해당 출처를 넣어야 한다. 관리자 콘솔에는 넣지 않는 것을 권장한다.

- 게임 Worker에는 공개 경로가 없다(`workers_dev: false`). API가 DO 바인딩으로만 접근한다.
- 관리자 도메인에는 Cloudflare Access를 붙이는 것을 권장한다(`docs/ADMIN_SECURITY.md`).

## 5. 비용과 한도 검토

> 가격과 한도는 2026-10-15에 공식 페이지에서 확인했다. 바뀔 수 있으니 배포·증설 전에 다시 확인한다.
> - https://developers.cloudflare.com/workers/platform/pricing/
> - https://developers.cloudflare.com/durable-objects/platform/pricing/
> - https://developers.cloudflare.com/d1/platform/pricing/

### 가격과 한도

| 항목 | 무료 플랜 | Workers Paid(월 최소 $5) |
|---|---|---|
| Workers 요청 | 일 100,000 | 월 1,000만 포함, 초과 100만당 $0.30 |
| Workers CPU | 호출당 **10 ms** | 월 3,000만 CPU-ms 포함, 초과 100만 CPU-ms당 $0.02. 호출당 기본 30초(최대 5분) |
| DO 요청 | 일 100,000 | 월 100만 포함, 초과 100만당 $0.15. HTTP·RPC·WebSocket 메시지·알람 실행이 모두 요청이다. **WS 수신 메시지는 20개 = 1요청**, 송신 메시지와 수신 프로토콜 ping은 과금하지 않는다 |
| DO 실행 시간 | 일 13,000 GB-s | 월 40만 GB-s 포함, 초과 100만 GB-s당 $12.50. 깨어 있는 동안의 wall-clock × 128 MB. Hibernation 중에는 과금하지 않는다. `setWebSocketAutoResponse`가 답한 메시지는 DO를 깨우지 않고 실행 시간을 늘리지 않아 과금하지 않는다(요청 수에 들어가는지는 문서에 없어, 아래 환산에서는 들어간다고 본다) |
| DO SQLite 저장소 | 일 읽기 500만 행, 쓰기 10만 행, 총 5 GB | 월 읽기 250억 행(초과 100만당 $0.001), 쓰기 5,000만 행(초과 100만당 $1.00), 5 GB-월(초과 GB-월당 $0.20). **KV API(`get`·`put`·`delete`)도 숨은 SQLite 테이블의 행으로 과금하고, `setAlarm` 1회는 쓰기 1행이다** |
| D1 | 일 읽기 500만 행, 쓰기 10만 행, 5 GB | 월 읽기 250억 행(초과 100만당 $0.001), 쓰기 5,000만 행(초과 100만당 $1.00), 5 GB(초과 GB-월당 $0.75). 인덱스가 걸린 컬럼을 쓰면 인덱스마다 쓴 행이 1개 늘어난다 |

무료 플랜은 한도를 넘으면 해당 작업이 실패하고, 일일 한도는 00:00 UTC에 초기화된다.

### JC ROYAL이 쓰는 양

측정값은 로컬 부하 시나리오(`docs/LOAD_TEST.md`, 운영 측정 아님)에서, 나머지는 코드에서 셌다.

| 사건 | 쓰는 양 | 근거 |
|---|---|---|
| 핸드 1개(6인 + 관전 2) | 액션 약 33회(수신), 상태 메시지 약 280개(송신, 평균 약 2.2 KB) | 측정(지속 실행, 봇 15% 레이즈) |
| 액션·상태 변화 1회 | DO 저장소 `room`·`hand` 키 put 2행 + `setAlarm` 1행 → 약 3행 | 코드(`apps/game-worker/src/room.ts`의 `save()`·`schedule()`), 측정 아님 |
| 채팅 1줄 | DO 저장소 `chat` 키 1행 | 코드 |
| 핸드 종료 | D1 새 행: `hands` 1 + `hand_players` 참가자 수. UPDATE: `tables.hands_played` 1, 로비 현황 약 2. 인덱스 갱신 별도 | 새 행 수는 측정, UPDATE는 코드 |
| 핸드 통계 계산(핸드마다) | D1 읽기: 4인 핸드 1개에 약 200–260행. 저장된 핸드 수와 관계없다. 쓰기는 참가자 수만큼 | 로컬 D1 `meta.rows_read` 측정(`hand_players` 200행·2,000행 DB 두 벌). 예전 문장은 저장된 `hand_players` 1행마다 약 4행을 더 읽었다(200행일 때 1,035행, 2,000행일 때 8,235행). 아래 "핸드 통계 읽기" 참고 |
| 착석·일어서기 | 각각 원장 1 + `users` 1 + `table_sessions` 1(+ 인덱스) | 측정(원장 = 바이인 + 잔액 있는 환급) |
| WS 연결 1회 | D1 `rate_limits` upsert 1행 | 측정(연결 수와 정확히 같음). 재연결이 잦으면 그만큼 쓴다 |
| 로그인한 회원의 요청 | 세션 만료 갱신 최대 1분에 1행 | 코드(`apps/api/src/lib/session.ts`) |
| 로비 목록 1회 | Workers 요청 1 + D1 읽기: 열린·닫는 중 테이블 전부(`tables_status_idx` 검색, + 방장 조인) + 세션·회원 조회. 로비 화면은 보이는 동안만 다시 부른다. 쓰는 동안 5초마다, 1분 동안 입력(포인터·키·휠)이 없으면 30초마다. 숨긴 탭은 멈추고, 요청이 겹치지 않는다 | 코드(`apps/web/src/pages/Lobby.tsx`, `apps/web/src/lib/lobby.ts`), 횟수는 단위 테스트(`apps/web/test/lobby.test.ts`) |
| 앱 핑 | 웹 클라이언트는 서버 메시지가 25초 동안 하나도 없을 때만 `{t:'ping'}`을 보낸다(핸드 진행 중에는 상태가 계속 와서 0회, 조용한 테이블에서 소켓당 10분에 약 23회). 런타임 자동 응답이 `{t:'pong'}`으로 답하고 DO를 깨우지 않는다 | 코드(`apps/web/src/game/link.ts`, `room.ts`), 횟수는 단위 테스트(`apps/web/test/link.test.ts`), 자동 응답은 통합 테스트(`tests/integration/ws-reliability.test.ts`) |
| 관리자 대시보드 실시간 현황 1회 | Workers 요청 1 + D1 batch 1(문장 8개). 읽는 행: 열린·닫는 중 테이블 약 3번(`tables_status_idx`), **세션 전부**(접속자 수, 아래), 최근 1시간 `ops_metrics`(최대 60분 × 4종), 열린 신고, 미해결 정합성 이벤트, 착석 세션. 화면이 보이고 관리자가 5분 안에 조작했을 때만 30초마다 다시 부른다 → 관리자 1명이 시간당 최대 120회. 숨긴 탭·자리 비움은 0회 | 코드(`apps/api/src/lib/ops.ts`, `apps/admin/src/pages/Dashboard.tsx`). 응답의 `rowsRead`(D1 `meta.rows_read` 합)를 화면에 그대로 보인다. 로컬 측정은 아래 "관리자 대시보드" |
| 운영 카운터(`ops_metrics`) | 분·종류마다 1행을 upsert(`ON CONFLICT … n = n + excluded.n`). 룸은 기존 점유 현황 UPDATE와 같은 batch로 보내고, 그 밖에는 최대 10초에 한 번만 쓴다(새 Workers 요청·DO 요청 없음). API는 5xx 응답 1건마다 1행. 사건이 없으면 0행. 14일 지난 행은 매일 정리 | 코드(`packages/db/src/ops.ts`, `apps/game-worker/src/room.ts`의 `publishStats`, `apps/api/src/index.ts`) |

### 대략적인 환산

가정: 6인 테이블 1개가 쉬지 않고 시간당 60핸드, 관전 2명(소켓 8개). 사람이 하는 테이블의 액션 수는 봇과 다를 수 있다.

| 항목 | 시간당 | 30일 연속 | 포함량 기준 |
|---|---|---|---|
| DO 요청 | 액션 2,000/20 = 100 + 핑 0(핸드 진행 중에는 보내지 않음) + 알람 약 60 → **약 160** | 약 12만 | Paid 월 100만 → 상시 테이블 약 8개. 초과분은 테이블당 월 약 $0.02. 예전 클라이언트(25초마다 무조건 핑)는 핑만 시간당 1,152/20 ≈ 58을 더했다 |
| DO 실행 시간 | 3,600초 × 0.125 GB = **450 GB-s**(상한) | 약 32만 GB-s | 액션·알람이 몇 초마다 와서 사실상 잠들지 않는다고 본 상한. Paid 월 40만 → 상시 테이블 약 1.2개, 이후 테이블당 월 약 $4 |
| DO 저장소 쓰기 | 액션 약 33 × 3행 × 60 ≈ **6,000행**(추정) | 약 430만 행 | Paid 월 5,000만 → 상시 테이블 약 11개, 이후 테이블당 월 약 $4.3. 무료 일 10만 → 테이블 하루 약 16시간 |
| D1 쓰기 | 핸드당 약 20행(새 행 7 + UPDATE 약 3 + 인덱스, 추정) × 60 = **약 1,200행** | 약 86만 행 | Paid 월 5,000만 → 상시 테이블 약 58개. 무료 일 10만 → 테이블 하루 약 83시간 |
| 송신 데이터 | 280 × 2.2 KB × 60 ≈ 37 MB(소켓 1개당 약 4.6 MB) | 약 27 GB | DO 송신은 과금 없음. 모바일 사용자의 데이터 사용량에 영향 |

**로비 폴링**: 로비를 **화면에 띄워 두고 쓰는** 사람 1명이 시간당 최대 Workers 요청 720회와 D1 읽기 720 × (테이블 수 + 약 2)행을 쓴다. 1분 동안 입력이 없으면 30초 간격으로 늦춰, 띄워 두기만 한 로비는 시간당 130회다(예전 721회, 약 82% 감소. 가짜 시계로 한 시간을 돌린 단위 테스트의 수이고 운영 측정이 아니다). 다시 손대면 마지막 요청이 5초 넘게 지났을 때 바로 1회 부르고 5초 간격으로 돌아간다. 탭을 숨기거나 다른 앱으로 가 있는 동안은 0회이고, 돌아오면 1회 즉시 부른다.

| 100명이 테이블 50개짜리 로비를 띄워 둔 경우 | 시간당 요청 | 시간당 D1 읽기 | 30일 연속(Paid) |
|---|---|---|---|
| 모두 계속 조작(변경 전후 같음) | 7.2만 | 약 375만 행 | 요청 약 5,180만 → 포함 1,000만 초과분 월 약 $12.5 |
| 모두 띄워 두기만 함(변경 전) | 7.2만 | 약 375만 행 | 위와 같음 |
| 모두 띄워 두기만 함(변경 후) | 1.3만 | 약 68만 행 | 요청 약 936만 → 포함량 안 |

무료 플랜의 일 요청 10만은 계속 조작하는 100명이면 약 1.4시간, 띄워 두기만 한 100명이면 약 7.7시간이면 바닥난다. 실제 사용자는 두 경우 사이에 있고, 로비를 숨겨 둔 시간만큼 더 준다. 목록 응답을 isolate 메모리에 잠깐 캐시하는 방법도 검토했지만, 요청 수(과금 단위)는 줄지 않고 D1 읽기는 포함량(월 250억 행) 안이라 적용하지 않았다.

**핸드 통계 읽기**: 핸드가 끝날 때마다 통계 문장(`packages/db/src/handStats.ts`)이 돈다. 예전 문장은 SQLite가 `hand_players` 전체를 훑는 순서로 실행해, 로컬 D1 측정에서 읽은 행이 약 235 + 4 × (저장된 `hand_players` 행 수)였다. 지금은 남은 핸드부터 찾아 그 핸드의 행만 읽는다(같은 핸드에서 2,000행 DB 기준 8,235 → 255행, 결과 동일). 아래는 이 측정 기울기로 운영 규모를 **추정**한 것이다: 저장된 `hand_players`가 100만 행(약 18만 핸드)일 때 예전 문장은 핸드 1개에 약 400만 행을 읽고, 시간당 60핸드인 상시 테이블 1개가 월 약 1,730억 행을 읽는다(포함 250억 초과분 월 약 $148). 지금 문장은 같은 테이블이 월 약 1,100만 행이다. 운영 D1에서 측정하지 않았다.

**관리자 대시보드**: 실시간 현황은 서버가 D1 batch 1개로 집계한다. 읽는 행은 대략 3 × (열린·닫는 중 테이블) + 세션 행 수 + 최근 1시간 카운터 행(최대 240) + 열린 신고 + 착석 세션이다. 접속자 수(최근 5분 안에 요청한 회원)는 `sessions`를 모두 읽는다. `last_seen_at` 인덱스를 두면 세션이 갱신될 때마다(최대 1분에 1번) 인덱스 쓰기가 1행씩 늘어 쓰기 비용이 커지므로 두지 않았다. 세션은 만료되면 매일 지워져, 행 수는 살아 있는 로그인 수와 같다. 닫힌 테이블에 남은 착석 세션을 찾는 문장은 닫힌 테이블(계속 늘어남)이 아니라 착석 세션 부분 인덱스에서 시작하도록 `CROSS JOIN`으로 순서를 고정했다(`EXPLAIN QUERY PLAN`: `SCAN ts USING COVERING INDEX tsess_open_user_uq` → `SEARCH t USING sqlite_autoindex_tables_1`). 측정(로컬, 시각 확인용 E2E DB): 테이블 30개에 세션·카운터·신고·착석이 6·22·1·0행일 때 128행, 17·67·3·3행일 때 195행, 23·89·4·3행일 때 226행을 읽었고 D1 응답은 5~7 ms였다(위 식으로 계산하면 119·180·209행). 통합 테스트 DB에서는 455·547행, 7·8 ms였다. **추정**: 로그인 세션 1만 행, 테이블 50개, 착석 100명이면 1회 약 1만 500행이다. 관리자 1명이 하루 8시간 보고 조작하면 월 2만 8,800회, D1 읽기 약 3억 행(Paid 포함 월 250억의 약 1.2%), Workers 요청은 포함량(월 1,000만)의 0.3%다. 화면을 띄워 두기만 하면 5분 뒤 갱신이 멈춘다.

**정리**
- 운영은 Workers Paid를 쓴다. PBKDF2 10만 회 해싱이 무료 플랜의 호출당 CPU 10 ms를 넘을 수 있고, 무료 한도를 넘으면 요청이 실패한다.
- 상시 진행 테이블이 늘면 **DO 실행 시간과 DO 저장소 쓰기**가 먼저 포함량을 넘는다(위 추정 기준, 테이블당 월 약 $8). 대시보드의 Durable Objects 사용량으로 실제 값을 확인한다.
- **앱 핑 비용(적용됨)**: 예전 웹 클라이언트는 소켓마다 25초에 한 번 무조건 핑을 보냈고 DO가 직접 답했다. 사람이 앉아만 있는 조용한 테이블도 핑마다 깨어나 실행 시간이 과금됐다(소켓 8개면 약 3초에 한 번). 지금은 룸이 `setWebSocketAutoResponse`로 `{"t":"ping"}`에 `{"t":"pong"}`을 런타임이 답하게 하고(예전 클라이언트의 핑도 같은 문자열), 웹 클라이언트는 25초 동안 서버 메시지가 없을 때만 핑을 보낸다. 조용한 테이블이 핑 때문에 깨어나지 않으므로 Hibernation에 들어갈 수 있다. 실행 시간 절감 폭은 Cloudflare에서 측정하지 않았다(추정).
- **WS 연결마다 D1 쓰기 / Rate Limiting 바인딩 검토(2026-10-15, 유지)**: 연결 레이트 리밋이 D1 `rate_limits`에 연결 1회당 1행을 쓴다(부하 측정에서 연결 수와 같음). Workers Rate Limiting 바인딩(`[[ratelimits]]`, wrangler 4.36.0 이상, 기간 10초 또는 60초)으로 옮기는 것을 공식 문서(https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)로 검토했고 옮기지 않았다.
  - 카운터가 Cloudflare 위치(colo)마다 따로 있고, 문서가 "permissive, eventually consistent"하며 정확한 집계용이 아니라고 밝힌다. 로그인·가입·비밀번호 재설정처럼 정확해야 하는 제한은 D1에 남아야 하므로, 바꿀 수 있는 것은 WS 연결 제한 하나다.
  - 아낄 수 있는 것은 연결 1회당 D1 쓰기 1행이다. 사용자 1,000명이 하루 10번 연결해도 월 30만 행으로, Paid 포함량(월 5,000만 행)의 0.6%다(추정).
  - 문서에 바인딩 가격과 로컬 `wrangler dev` 동작이 나와 있지 않아, 비용이 줄어드는지와 지금 통합·부하 테스트가 그대로 도는지를 확인할 수 없었다. 비용이 늘지 않는다는 것을 확인할 수 없어 유지한다. 재연결이 실제로 많아지면 대시보드의 D1 쓰기량으로 다시 판단한다.
- **상태 메시지 크기**: 변화마다 화면 전체 상태(약 2 KB)를 보낸다. DO 과금은 없지만 모바일 데이터에 영향을 준다. 차분 전송은 별도 설계가 필요하다.
- **로비**: 숨긴 탭에서는 폴링을 멈추고, 1분 동안 입력이 없는 로비는 30초 간격으로 늦춘다(적용됨). 쓰고 있는 로비는 예전과 같이 5초다.
- **핸드 통계 읽기(적용됨)**: 저장된 핸드가 늘수록 핸드마다 읽는 행이 늘던 문장을 고쳤다(위 "핸드 통계 읽기").

**외부 유료 서비스**: 필요 없다.

- 가입 인증·비밀번호 재설정 메일: Resend(무료 요금제 월 3,000통·하루 100통). 한도를 넘으면 인증번호 메일 발송이 실패해(`mail_failed`) 그동안은 새로 가입할 수 없다. 가입이 하루 100명에 가까워지면 요금제를 올린다(요금제와 한도는 Resend 대시보드에서 확인).
- 선택 사항: Cloudflare Access(50명까지 무료). `admin.<domain>`에만 붙인다. 구성 순서는 `docs/ADMIN_SECURITY.md` "운영 권장 사항"

## 6. 운영 점검표

- [ ] D1 `database_id` 입력, 마이그레이션 적용(`0000_init`, `0001_community`, `0002_comment_replies`, `0003_academy`, `0004_signup_profile`, `0005_social`, `0006_social_safety`, `0007_social_play`, `0008_session_remember`, `0009_dm_seq`, `0010_hand_stats`, `0011_hand_shown`, `0012_ops_metrics`, `0013_tables_hands_paused`, `0014_users_admin_notes`, `0015_reconcile_resolution`, `0016_service_notices_maintenance`, `0017_report_workflow`, `0018_admin_audit_search`, `0019_daily_stats`). GitHub Actions 배포는 배포 전에 자동 적용한다. B9(관리자 콘솔 목록·확인 창 정리)는 마이그레이션이 없고 api → admin 순서로 배포한다(game-worker·web 변경 없음: 공용 모달의 닫기 이름은 기본값이 그대로라 회원 화면은 바뀌지 않는다). 새 admin은 원장·핸드·테이블·게시판·쪽지 이력을 `paged=1`로 요청하므로, 이전 api와 함께 있으면 이 목록 화면이 오류나 빈 목록을 보인다. 이전 admin은 새 api에서 그대로 동작한다(`paged` 없는 기존 응답 유지). 다만 이전 콘솔의 신고 처리는 확인 창 없이 기존처럼 바로 처리되고, 원장 화면을 열 때마다 감사 로그 1행(`ledger.view`)이 생긴다. `0019_daily_stats`는 새 테이블 두 개(`active_days(day, user_id)`: 회원이 활동한 날, `daily_stats(day, metric, n)`: 날짜·지표별 수치, 둘 다 `WITHOUT ROWID`)와 닫힌 좌석만 담는 부분 인덱스 `tsess_closed_idx(closed_at) WHERE closed_at IS NOT NULL`(`table_sessions`)을 만든다(기존 열 변경 없음). 새 api가 로그인·아카데미 이벤트·탈퇴·크론에서 이 테이블을 쓰므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 아카데미 이벤트 기록, 회원 탈퇴, 정리 크론 전체가 실패한다(활동 기록 실패는 로그만 남기고 요청은 성공한다). 새 admin이 이전 api와 함께 있으면 운영 통계 화면만 오류를 보인다. 배포 뒤 첫 크론(또는 관리자가 운영 통계를 처음 열 때, 한 번에 31일씩)이 첫 가입일(최대 366일 전)부터 끝난 날을 집계한다. 활동 회원 수와 아카데미 일별 카운터는 배포한 날부터 쌓이므로 그 전 날짜는 비어 있고(화면에 `*`·안내로 표시), 배포한 날 자체도 배포 전 시간의 활동이 빠진다. 인덱스 생성 시간은 `table_sessions` 행 수에 비례한다. `0018_admin_audit_search`는 `admin_audit_log`에 기본값 `ok`인 열 `outcome`(`ok`·`failed`)과 인덱스 세 개(`audit_actor_idx(actor_id, created_at)`, `audit_action_idx(action, created_at)`, 실패만 담는 부분 인덱스 `audit_failed_idx(created_at) WHERE outcome = 'failed'`)를 더하고, 이전에 쌓인 실패 기록(`admin.login.failed`, `admin.reauth.failed`, `user.chips_refused`)을 `failed`로 바꾼다. 새 api가 감사 행을 쓸 때마다 이 열을 채우므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 감사 행을 쓰는 관리자 요청(로그인 포함)이 대부분 실패한다(회원 기능은 영향 없음). 이전 api는 새 열을 모르지만 기본값 덕분에 그대로 동작한다. 새 api와 이전 admin이 함께 있는 동안 이전 콘솔은 미리보기 없이 기존처럼 바로 실행되고, 일반 관리자의 회원 정보 내보내기는 403으로 보이며, 관리 이력에는 자기 기록만 보인다. 인덱스 생성과 UPDATE 시간은 `admin_audit_log` 행 수에 비례하므로 운영 적용 전 `SELECT COUNT(*) FROM admin_audit_log`로 규모를 확인한다. `0017_report_workflow`는 `reports`에 null 허용 열 다섯 개(`severity`, `assignee_id`, `assigned_at`, `notice_reporter`, `notice_target`: 기존 신고는 모두 NULL = 미지정·미배정·안내 기록 없음), 처리 기록 테이블 `report_events`(신고 ID, 관리자 ID, 종류, 변경 전후, 메모)와 인덱스 네 개(`report_events(report_id, created_at)`, `reports(assignee_id, status)`, `reports(created_at)`, `users(role, status) WHERE role != 'user'` 부분 인덱스)를 더한다. 새 api가 신고 접수·목록·처리에서 이 열을 읽고 쓰므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 회원의 신고 접수와 관리자 신고 화면이 실패한다(회원 상세의 신고 건수는 기존 열만 읽어 영향 없음). 새 api와 이전 admin이 함께 있는 동안 이전 콘솔은 신고 목록의 첫 50건(이전 200건)만 보이고 처리는 안내 쪽지 없이 그대로 동작한다. 인덱스 생성 시간은 `reports` 행 수에 비례한다. `0016_service_notices_maintenance`는 새 테이블 두 개(`service_notices`: 한국어·영어 공지와 표시 시작·종료, `maintenance_windows`: 점검 시작·종료·로그인 제한·안내 문구·조기 종료·취소 시각)와 인덱스 두 개를 만든다(기존 테이블 변경 없음). 새 game-worker는 테이블 설정을 읽을 때와 점유 현황을 기록하는 batch에서 `maintenance_windows`를 함께 읽으므로 마이그레이션 → game-worker → api → web·admin 순서로 배포한다. 마이그레이션 없이 새 game-worker가 먼저 나가면 룸이 테이블 설정을 읽지 못해 열리지 않는다. 새 api가 이전 game-worker보다 먼저 나가면 점검 중에도 이전 룸은 착석을 받고 핸드를 계속 시작한다(빠른 참가·방 만들기·로그인 거절만 동작). 새 api와 이전 web이 함께 있는 동안에는 배너와 점검 안내 페이지가 없고, 점검 거절은 이전 web이 모르는 코드라 일반 오류 문구로 보인다. 운영에서 점검을 쓰기 전에 네 Worker가 모두 새 버전인지 확인한다. `0015_reconcile_resolution`은 `reconciliation_events`에 null 허용 열 `resolution`(note·record·revert, 예전 처리는 NULL = 메모만) 하나를 더한다. 새 api가 정합성 목록·검사·정정에서 이 열을 읽고 쓰므로 마이그레이션 → game-worker → api → admin 순서로 배포한다(web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 정합성 화면과 검사가 실패한다(다른 기능은 영향 없음). 새 game-worker는 환급 실패를 `ops_metrics`의 `cashout_fail`로 세는데, 이전 api는 모르는 지표를 무시하므로 game-worker를 먼저 내보내도 된다. 새 api와 이전 admin이 함께 있는 동안 이전 콘솔의 정합성 해결은 메모만 남기기로 처리되고, 일반 관리자의 100,000칩 이상 조정은 `large_adjustment` 코드 그대로 거절이 보인다. `0014_users_admin_notes`는 `users`에 null 허용 열 `last_login_at`(최근 로그인), 관리자 내부 메모 테이블 `admin_notes`, 인덱스 3개(`admin_audit_log(target_type, target_id, created_at)`, `admin_notes(user_id, created_at)`, `reports(reporter_id, created_at)`)를 더한다. 기존 회원의 `last_login_at`은 다음 로그인 전까지 비어 있다("기록 없음"으로 표시). 새 api가 로그인·탈퇴 때 이 열과 테이블을 쓰므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 `users` 전체 열을 읽는 요청(세션 확인, 로그인 등)이 없는 열 때문에 거의 모두 실패한다. 새 api와 이전 admin이 함께 있는 동안에는 이전 콘솔의 정지 해제·권한 변경이 사유 없이 보내져 400으로 거절된다(새 콘솔을 내보내면 해결, 데이터 변경 없음). 인덱스 생성 시간은 `admin_audit_log`·`reports` 행 수에 비례하므로 운영 적용 전 `SELECT COUNT(*)`로 규모를 확인한다. `0013_tables_hands_paused`는 `tables`에 기본값 0인 열 `hands_paused`(관리자의 새 핸드 중단) 하나를 더한다. 새 game-worker가 테이블을 읽을 때 이 열을 고르므로 마이그레이션 → game-worker → api → web·admin 순서로 배포한다. 마이그레이션 없이 새 game-worker가 먼저 나가면 룸이 테이블 설정을 읽지 못해 열리지 않는다. 새 api보다 이전 game-worker가 남아 있으면 강제 연결 종료(`kick`)와 긴급 제어 확인이 실패(룸 응답 없음으로 보고)하고, 이전 api는 핸드셰이크에 인증 시각을 넣지 않아 연결 종료 뒤 60초 동안 그 회원의 재연결이 거절된다. `0012_ops_metrics`는 관리자 대시보드의 분 단위 운영 카운터 테이블 `ops_metrics`를 새로 만든다(기존 테이블 변경 없음). 새 game-worker와 api가 이 테이블에 기록하므로 마이그레이션 → game-worker → api → web·admin 순서로 배포한다. 마이그레이션 없이 새 game-worker가 먼저 나가면 카운터가 들어간 룸의 통계 batch가 계속 실패해, 그 룸의 로비 점유 현황이 갱신되지 않고 10초마다 재시도한다(게임 진행과 칩에는 영향 없음). `0011_hand_shown`은 `hand_players`에 null 허용 열 `shown` 하나를 더한다(기존 행은 NULL = 쇼다운에 간 패를 공개로 봄). 새 game-worker는 이 열에 기록하므로 마이그레이션을 game-worker보다 먼저 적용해야 한다. `0010_hand_stats`는 `hand_players`에 통계 열 5개와 부분 인덱스를 더하고, 같은 파일 안에서 기존 핸드 전체의 통계를 한 번 채운다(이후는 게임 워커가 핸드 기록 직후 채움). 기록 수에 비례해 실행 시간이 늘어나므로 운영 적용 전 `SELECT COUNT(*) FROM hand_players`로 규모를 확인한다
- [ ] 두 Worker에 같은 `INTERNAL_SECRET`, 최초 관리자 생성 후 `ADMIN_BOOTSTRAP_TOKEN` 삭제
- [ ] `ALLOWED_ORIGINS`·`ADMIN_ORIGIN`·`APP_ORIGIN`이 실제 운영 주소(https://jc-royal.site, https://admin.jc-royal.site)와 일치
- [ ] 배포 후 가입 인증번호 메일과 비밀번호 재설정 메일이 `noreply@jc-royal.site`에서 오고, 재설정 링크가 https://jc-royal.site/reset 으로 열리는지 확인
- [ ] 관리자 콘솔에서 테이블 생성(운영 DB에는 개발용 시드 테이블을 넣지 않는다)
- [ ] 대시보드 서버 상태, 정합성 검사 실행으로 확인
