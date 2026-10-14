# Cloudflare 배포 가이드

## 운영 주소

| 용도 | 주소 | Worker 이름(`env.production`) |
|---|---|---|
| 사용자 사이트 + API | https://play.jcroyal.workers.dev | `play` (`apps/api`) |
| 관리자 콘솔 | https://admin.jcroyal.workers.dev | `admin` (`apps/admin`) |
| 테이블 룸(Durable Object) | 공개 주소 없음(`workers_dev: false`) | `jc-royal-game-prod` (`apps/game-worker`) |

- 계정의 workers.dev 서브도메인은 `jcroyal`이다(대시보드 Workers & Pages → Subdomain).
- 도메인을 사면 4절대로 옮긴다.

## 1. 리소스 만들기(최초 1회)

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create jc-royal-db-prod     # 출력된 database_id를 아래 두 파일의 env.production에 입력
#   apps/api/wrangler.jsonc        env.production.d1_databases[0].database_id
#   apps/game-worker/wrangler.jsonc env.production.d1_databases[0].database_id
```

주소를 바꾸면 `apps/api/wrangler.jsonc`의 `env.production.vars`에서 `ALLOWED_ORIGINS`, `ADMIN_ORIGIN`, `APP_ORIGIN`을 함께 바꾼다.

## 2. 시크릿

```bash
# 두 Worker에 같은 값(32바이트 이상 무작위)을 넣어야 API ↔ 게임 룸 내부 호출이 통과한다
openssl rand -base64 48 | pnpm exec wrangler secret put INTERNAL_SECRET --env production -c apps/api/wrangler.jsonc
#   (같은 값을) pnpm exec wrangler secret put INTERNAL_SECRET --env production -c apps/game-worker/wrangler.jsonc
pnpm exec wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env production -c apps/api/wrangler.jsonc   # 최초 관리자 생성 후 삭제
pnpm exec wrangler secret put RESEND_API_KEY --env production -c apps/api/wrangler.jsonc          # 선택: 가입 인증·재설정 메일
```

**메일(Resend): 가입 이메일 인증, 비밀번호 재설정**
- 켜지는 조건: `RESEND_API_KEY` 시크릿과 `MAIL_FROM` 변수가 모두 있어야 한다.
- 켜지면: 가입 화면에 이메일 인증번호 단계가 생기고(인증 없이는 가입 불가), 재설정 메일과 관리자 재설정 링크가 회원 계정 언어로 발송된다.
- 켜지기 전: 가입은 이메일 인증 없이 진행된다(`emailVerifiedAt` 비어 있음). 관리자가 콘솔에서 재설정 링크를 발급하고, 화면에 나오는 회원 언어 안내문을 복사해 전달한다.
- `onboarding@resend.dev`(Resend 테스트 발신자)는 Resend 계정 소유자 주소로만 보낼 수 있어 운영에 쓸 수 없다.
- `MAIL_FROM` 형식: Resend에서 인증한 도메인의 주소(예: `JC ROYAL <no-reply@도메인>`).
- `MAIL_FROM` 위치: `apps/api/wrangler.jsonc`의 `env.production.vars`. 넣은 뒤 API를 다시 배포한다.
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

도메인을 Cloudflare에 등록(zone)하면, 각 Worker의 `env.production`에 아래 설정을 추가하고 다시 배포한다. `jcroyal.example`은 실제 도메인으로 바꾼다.

```jsonc
// apps/api/wrangler.jsonc
"routes": [{ "pattern": "jcroyal.example", "custom_domain": true }]
// apps/admin/wrangler.jsonc
"routes": [{ "pattern": "admin.jcroyal.example", "custom_domain": true }]
```

- 1절의 세 변수(`ALLOWED_ORIGINS`, `ADMIN_ORIGIN`, `APP_ORIGIN`)도 새 주소로 바꾼다.
- 옮긴 뒤 workers.dev 주소를 끄려면 `"workers_dev": false`를 추가한다.
- 같은 도메인을 Resend에서 인증하면 재설정 메일도 켤 수 있다(2절).

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
| DO 실행 시간 | 일 13,000 GB-s | 월 40만 GB-s 포함, 초과 100만 GB-s당 $12.50. 깨어 있는 동안의 wall-clock × 128 MB. Hibernation 중에는 과금하지 않는다 |
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
| 착석·일어서기 | 각각 원장 1 + `users` 1 + `table_sessions` 1(+ 인덱스) | 측정(원장 = 바이인 + 잔액 있는 환급) |
| WS 연결 1회 | D1 `rate_limits` upsert 1행 | 측정(연결 수와 정확히 같음). 재연결이 잦으면 그만큼 쓴다 |
| 로그인한 회원의 요청 | 세션 만료 갱신 최대 1분에 1행 | 코드(`apps/api/src/lib/session.ts`) |
| 로비 목록 1회 | Workers 요청 1 + D1 읽기: 닫히지 않은 테이블 전부(+ 방장 조인) + 세션·회원 조회. 로비 화면은 5초마다 다시 부른다 | 코드(`apps/web/src/pages/Lobby.tsx`) |
| 앱 핑 | 웹 클라이언트가 테이블 소켓마다 25초에 한 번 `{t:'ping'}`, DO가 `pong` 응답 | 코드(`apps/web/src/game/useTableSocket.ts`, `room.ts`) |

### 대략적인 환산

가정: 6인 테이블 1개가 쉬지 않고 시간당 60핸드, 관전 2명(소켓 8개). 사람이 하는 테이블의 액션 수는 봇과 다를 수 있다.

| 항목 | 시간당 | 30일 연속 | 포함량 기준 |
|---|---|---|---|
| DO 요청 | 액션 2,000/20 = 100 + 핑 1,152/20 ≈ 58 + 알람 약 60 → **약 220** | 약 16만 | Paid 월 100만 → 상시 테이블 약 6개. 초과분은 테이블당 월 약 $0.02 |
| DO 실행 시간 | 3,600초 × 0.125 GB = **450 GB-s**(상한) | 약 32만 GB-s | 액션·알람이 몇 초마다 와서 사실상 잠들지 않는다고 본 상한. Paid 월 40만 → 상시 테이블 약 1.2개, 이후 테이블당 월 약 $4 |
| DO 저장소 쓰기 | 액션 약 33 × 3행 × 60 ≈ **6,000행**(추정) | 약 430만 행 | Paid 월 5,000만 → 상시 테이블 약 11개, 이후 테이블당 월 약 $4.3. 무료 일 10만 → 테이블 하루 약 16시간 |
| D1 쓰기 | 핸드당 약 20행(새 행 7 + UPDATE 약 3 + 인덱스, 추정) × 60 = **약 1,200행** | 약 86만 행 | Paid 월 5,000만 → 상시 테이블 약 58개. 무료 일 10만 → 테이블 하루 약 83시간 |
| 송신 데이터 | 280 × 2.2 KB × 60 ≈ 37 MB(소켓 1개당 약 4.6 MB) | 약 27 GB | DO 송신은 과금 없음. 모바일 사용자의 데이터 사용량에 영향 |

**로비 폴링**: 로비를 연 사람 1명이 시간당 Workers 요청 720회와 D1 읽기 720 × (테이블 수 + 약 2)행을 쓴다. 100명이 테이블 50개짜리 로비를 열어 두면 시간당 요청 7.2만, D1 읽기 약 375만 행이다. 무료 플랜의 일 요청 10만은 약 1.4시간 만에 바닥난다. Paid에서는 월 1,000만 요청 포함분을 약 6일에 다 쓰고 이후 월 약 $13이 든다(읽기는 포함량 안).

**정리**
- 운영은 Workers Paid를 쓴다. PBKDF2 10만 회 해싱이 무료 플랜의 호출당 CPU 10 ms를 넘을 수 있고, 무료 한도를 넘으면 요청이 실패한다.
- 상시 진행 테이블이 늘면 **DO 실행 시간과 DO 저장소 쓰기**가 먼저 포함량을 넘는다(위 추정 기준, 테이블당 월 약 $8). 대시보드의 Durable Objects 사용량으로 실제 값을 확인한다.
- **앱 핑 비용(권고)**: 수신 메시지라 요청에 잡히고, 잠든 DO를 깨워 실행 시간이 과금된다. `state.setWebSocketAutoResponse`로 고정 ping/pong 문자열에 응답하게 하면 DO를 깨우지 않고 실행 시간도 과금되지 않는다(공식 문서). 클라이언트는 `pong`을 받아도 아무것도 하지 않으므로(`useTableSocket.ts`) 요청·응답 문자열만 맞추면 된다. 게임 Worker 동작을 바꾸는 일이라 이번 작업에서는 권고만 한다.
- **WS 연결마다 D1 쓰기**: 연결 레이트 리밋이 D1 `rate_limits`에 쓴다. 재연결이 많아지면 Workers Rate Limiting 바인딩으로 옮기는 것을 검토한다(`docs/STATUS.md` 알려진 문제 4).
- **상태 메시지 크기**: 변화마다 화면 전체 상태(약 2 KB)를 보낸다. DO 과금은 없지만 모바일 데이터에 영향을 준다. 차분 전송은 별도 설계가 필요하다.
- **로비**: 숨긴 탭에서 폴링을 멈추면 요청이 크게 준다.

**외부 유료 서비스**: 필요 없다.

- 선택 사항: 비밀번호 재설정 메일(예: Resend 무료 월 3,000통)
- 선택 사항: Cloudflare Access(50명까지 무료)

## 6. 운영 점검표

- [ ] D1 `database_id` 입력, 마이그레이션 적용(`0000_init`, `0001_community`, `0002_comment_replies`, `0003_academy`, `0004_signup_profile`, `0005_social`, `0006_social_safety`, `0007_social_play`, `0008_session_remember`, `0009_dm_seq`). GitHub Actions 배포는 배포 전에 자동 적용한다
- [ ] 두 Worker에 같은 `INTERNAL_SECRET`, 최초 관리자 생성 후 `ADMIN_BOOTSTRAP_TOKEN` 삭제
- [ ] `ALLOWED_ORIGINS`·`ADMIN_ORIGIN`·`APP_ORIGIN`이 실제 운영 주소와 일치
- [ ] 관리자 콘솔에서 테이블 생성(운영 DB에는 개발용 시드 테이블을 넣지 않는다)
- [ ] 대시보드 서버 상태, 정합성 검사 실행으로 확인
