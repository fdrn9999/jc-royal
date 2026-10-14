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

> 아래 수치는 2026년 기준으로 알려진 Cloudflare 공시 가격이다. **배포 전에 https://developers.cloudflare.com/workers/platform/pricing/ 등 공식 페이지에서 다시 확인할 것.** 무료 한도는 무제한이 아니다.

| 항목 | 무료 플랜 | Workers Paid($5/월) | JC ROYAL 사용 패턴 |
|---|---|---|---|
| Workers 요청 | 일 100,000 | 월 1,000만 포함 | REST 호출, WS 업그레이드, 정적 자산(자산 요청은 무료) |
| Workers CPU | 호출당 **10ms** | 호출당 최대 30초(기본), 월 3,000만 CPU-ms 포함 | **PBKDF2 10만 회(가입·로그인)는 10ms를 넘을 수 있다 → 운영은 유료 플랜 권장** |
| Durable Objects | SQLite 백엔드 사용 가능. 요청·실행시간 일일 한도 | 요청 월 100만 포함, 실행시간 월 40만 GB-s 포함 | 테이블당 DO 1개. WS 수신 메시지는 20개를 요청 1회로 과금. Hibernation으로 유휴 연결 실행시간 최소화. 알람은 턴·다음 핸드마다 |
| DO 저장소 | SQLite 저장량·행 쓰기 한도 | 포함량 초과 시 과금 | 액션마다 `room`·`hand` 쓰기(핸드당 수십 회). 9인 장기 핸드 로그 약 101KiB(값 한도 2MiB 이내) |
| D1 | 일 읽기 500만 행, 쓰기 10만 행, 5GB | 월 읽기 250억 행, 쓰기 5,000만 행 포함 | 핸드 종료마다 batch 1회(hands + hand_players), 바이인·환급마다 원장 기록. 레이트 리밋 카운터도 D1에 기록(쓰기 발생) |

**대략적인 부하 예시**(가정: 6인 테이블 1개가 시간당 60핸드, 핸드당 액션 20회, 관전 2명)

- **DO 요청**: WS 메시지 약 1,200건/시간 → 요청 환산 약 60회/시간 + 알람 약 60회/시간
- **DO 저장소 쓰기**: 약 1,300회/시간
- **D1 쓰기**: 핸드당 약 8행 → 약 500행/시간

테이블 수십 개 수준에서는 유료 플랜 포함량 안에 들어갈 가능성이 높다. 정확한 값은 Cloudflare 대시보드의 사용량으로 확인해야 한다.

**외부 유료 서비스**: 필요 없다.

- 선택 사항: 비밀번호 재설정 메일(예: Resend 무료 월 3,000통)
- 선택 사항: Cloudflare Access(50명까지 무료)

## 6. 운영 점검표

- [ ] D1 `database_id` 입력, 마이그레이션 적용(`0000_init`, `0001_community`, `0002_comment_replies`, `0003_academy`, `0004_signup_profile`). GitHub Actions 배포는 배포 전에 자동 적용한다
- [ ] 두 Worker에 같은 `INTERNAL_SECRET`, 최초 관리자 생성 후 `ADMIN_BOOTSTRAP_TOKEN` 삭제
- [ ] `ALLOWED_ORIGINS`·`ADMIN_ORIGIN`·`APP_ORIGIN`이 실제 운영 주소와 일치
- [ ] 관리자 콘솔에서 테이블 생성(운영 DB에는 개발용 시드 테이블을 넣지 않는다)
- [ ] 대시보드 서버 상태, 정합성 검사 실행으로 확인
