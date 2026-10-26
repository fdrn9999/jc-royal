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
# 웹 푸시(선택): 키 한 쌍을 만들어 두 시크릿에 넣는다. 출력은 화면에만 나오고 파일로 저장하지 않는다
node tools/vapid-keys.mjs                                                                          # VAPID_PUBLIC_KEY=…, VAPID_PRIVATE_KEY=… 두 줄
pnpm exec wrangler secret put VAPID_PUBLIC_KEY --env production -c apps/api/wrangler.jsonc        # 첫 줄의 값
pnpm exec wrangler secret put VAPID_PRIVATE_KEY --env production -c apps/api/wrangler.jsonc       # 둘째 줄의 값
```

**웹 푸시(VAPID): DM·초대·친구 요청·수락·대회 알림**(`docs/PRESENCE.md`)
- 켜지는 조건: `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY` 시크릿과 `VAPID_SUBJECT`(`apps/api/wrangler.jsonc`의 `vars`, `https://jc-royal.site`)가 모두 있어야 한다. 운영 키는 2026-10-21에 오너의 요청으로 위 명령으로 한 쌍을 만들어 넣었다(`wrangler secret list`로 두 이름을 확인, 값은 파일·로그에 남기지 않았다). 다시 만들면 아래처럼 기존 구독이 끊기므로 오너의 결정 없이 바꾸지 않는다.
- 꺼져 있을 때: 회원은 계정 동의·종류·야간 설정을 저장할 수 있고("서버에서 푸시를 보낼 준비가 되지 않았다"는 안내), 이 기기에서 받기·등록은 503 `push_unavailable`이다. 큐에 넣지 않고, 매분 크론은 D1을 읽지 않고 끝난다.
- 개인 키는 Worker 시크릿에만 둔다. `wrangler.jsonc`, `.dev.vars.example`, 저장소, 로그에 넣지 않는다. 공개 키는 비밀이 아니다(모든 브라우저가 받는다).
- 키를 바꾸면 이전 키로 만든 브라우저 구독은 쓸 수 없게 된다. 브라우저는 다음에 사이트를 열 때 새 키로 다시 등록하고(`apps/web/src/lib/push.ts`), 이전 구독으로 보낸 푸시는 푸시 서비스가 거절해 3번 뒤 등록이 지워진다. 그 사이 사이트를 열지 않은 회원은 푸시를 받지 못한다.
- 로컬: `apps/api/.dev.vars`에 같은 두 줄을 넣는다(`.dev.vars.example`). 통합 테스트는 실행할 때 키를 새로 만들어 로컬 푸시 수신 서버로 보낸다(`PUSH_SINK_URL`, 운영이 아니고 `127.0.0.1`일 때만 쓰인다).

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

- **CI**: push와 PR마다 `CI` 워크플로가 실행된다. `test` 작업은 타입 검사, 엔진·통합 테스트, 운영 번들 dry-run을 하고, `e2e` 작업은 같은 때 다른 러너에서 E2E를 돌린다(각자 90분 제한).
- **자동 배포**: `main`에 push하고 CI가 모두 통과하면, 같은 실행의 `deploy` 작업(`.github/workflows/deploy.yml`)이 위 순서대로 운영에 배포한다.
  - 순서: 빌드 → D1 마이그레이션 → game → play → admin → `/api/health` 확인.
  - 확인 단계: 새 워커가 workers.dev 주소에서 `/api/health` `{"ok":true}`로, 사용자 화면 `/`와 관리자 화면 `/`는 정확히 200으로 답해야 한다(리디렉션 3xx도 실패다). 이어서 두 커스텀 도메인(`/api/health`, `/`, 관리자 `/`)이 200으로 답해야 하고, 커스텀 도메인의 `/api/health`도 본문이 `"ok":true`여야 한다. 커스텀 도메인은 영역(zone) 보안 설정 뒤에 있어, main 실행 39092482636·39128959502에서 GitHub 러너가 403을 받았다(배포는 끝났고, 같은 때 다른 곳에서는 200). 그래서 Cloudflare가 챌린지로 표시한 403(`cf-mitigated: challenge`)만 경고로 남기고, 그 밖의 응답은 헤더를 보여 주며 실패로 둔다. 러너가 받는 403이 챌린지가 아니면 이 단계는 계속 실패한다. 그때는 대시보드에서 `/api/health`를 보안 규칙에서 빼는 등 영역 설정을 운영자가 정한다(코드로 바꾸지 않는다).
  - 배포는 한 번에 하나만 돈다. 새 push는 앞선 배포를 취소하지 않고 기다린다. `main`의 CI 실행도 취소하지 않는다.
  - PR과 다른 브랜치는 테스트만 하고 배포하지 않는다.
- **수동 재배포**: GitHub → Actions → `Deploy` → Run workflow. 타입 검사와 단위 테스트를 먼저 돌린다.
- **Worker 시크릿**(`INTERNAL_SECRET`, `RESEND_API_KEY` 등)은 Cloudflare에 남아 있어 배포마다 다시 넣지 않는다.
- **마이그레이션 0027(관리자별 기능 권한)**: 그때 `role = 'admin'`인 계정마다 기능 스위치 23개를 모두 켠 행을 넣는다(`updated_by = 'migration'`). 위 순서(마이그레이션 → api → admin)를 지키면 배포 직후 관리자가 할 수 있는 일은 그대로이고, 최고관리자가 콘솔 보안 화면에서 줄인다. 마이그레이션 뒤 api 배포 전에 관리자가 된 계정은 행이 없어 모든 기능이 꺼진 채 시작한다(최고관리자가 켜면 된다). api를 되돌려도 이전 api는 `admin_permissions`를 읽지 않으므로 테이블을 지울 필요가 없다. 다만 되돌린 동안 역할이 바뀐 계정의 행은 지워지지 않으므로(역할 변경 때 행을 지우는 것은 새 api만 한다) 새 api를 다시 배포하면 그 계정에 이전 스위치가 다시 적용된다. 그 사이 관리자 역할을 바꿨다면 보안 화면에서 확인한다. 자세한 규칙은 `docs/ADMIN_SECURITY.md` "관리자별 기능 권한".
- **마이그레이션 0028(소셜 정책)**: 새 테이블 `social_policies`(버전 기본 키, 외래 키 없음)를 만들고 지금까지와 같은 버전 1(빠른 반응 켜짐, 2초 간격, 30초 5회, 최고 관리자·관리자 표시 모두 보임)을 넣는다(기존 테이블 변경 없음). 배포만으로는 회원 화면이 바뀌지 않는다. 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 새 game-worker는 테이블 설정을 읽을 때와 핸드를 기록할 때(같은 D1 batch) 이 테이블을 함께 읽으므로 마이그레이션 없이 먼저 나가면 룸이 열리지 않고, 새 api가 먼저 나가면 운영진이 들어 있는 응답(운영진이 만든 방이 있는 로비, 운영진의 글·댓글, 친구 목록, 핸드 기록)이 실패한다. 이전 game-worker와 새 api·admin이 함께 있는 동안에는 정책을 저장해도 룸 반영이 "답하지 않음"으로 남고(저장은 됨), 이전 룸은 고정값(켜짐·2초·30초 5회)과 모든 표시를 그대로 쓴다. 이전 web은 정책이 반응을 끈 동안에도 버튼을 보이고 누르면 일반 오류 문장을 보인다(새 web은 버튼을 감춘다). 새 web은 이전 룸이 `reactions`를 보내지 않으면 기본값을 쓴다. 되돌릴 때 이전 api·game-worker로 내려도 테이블은 남고, 이전 코드는 읽지 않으므로 숨겼던 표시는 다시 보이고 반응은 고정값으로 돌아간다. 자세한 규칙은 `docs/ADMIN_SECURITY.md` "소셜 운영", 프로토콜은 `docs/WEBSOCKET_PROTOCOL.md` "빠른 반응".
- **Codex 리뷰 수정(마이그레이션 없음)**: game-worker를 api보다 먼저 배포한다(위 순서와 같음). 새 룸은 자동 머크 내부 동작의 `rev`로 늦게 도착한 예전 값을 무시하고, `holdings`에 마지막 정산 핸드(`settled`)를 더해 답한다. 섞인 동안에도 깨지지 않는다. 이전 룸은 `rev`를 무시하고 값만 적용하며(이 변경 전 동작), `settled` 없이 답하면 새 api는 두 번의 답에서 세션·스택만 비교한다. 새 룸과 이전 api는 `rev` 없는 보내기를 예전처럼 적용한다. 테이블 수정의 `ifUpdatedAt`은 선택 필드라 이전 관리자 콘솔은 병합만 받고 409 `table_conflict`를 받지 않는다. 대회 시작과 추천 기록의 조건은 같은 D1 스키마에서 문장만 바뀐다.
- **마이그레이션 0029(접속 상태·웹 푸시)·0030(푸시 상한 인덱스)과 DO 마이그레이션 `v2`(`PresenceHub`)**: 새 테이블 네 개(`notification_settings`: 회원 기본 키 한 행, `notification_consents`: 동의 이력과 회원·시각 인덱스, `notification_events`: 발송 큐와 `dedupe_key` 고유·발송 대기·회원 인덱스, `push_subscriptions`: 주소 해시 고유·회원·세션 인덱스)를 만들고 `users`에 기본값 `auto`인 `presence_mode` 열을 더한다(기존 행은 `auto`, 다른 열 변경 없음). 0030은 `notification_events`에 인덱스 `notification_events_sent_idx (user_id, status, sent_at)` 하나만 더한다(시간당 상한·쿨다운 조회용, 새 테이블이라 운영 행이 없어 바로 끝남. 없어도 동작은 같고 조회만 그 회원의 기록을 다 읽는다). game-worker는 메모리만 쓰는 새 DO 클래스 `PresenceHub`를 만든다(저장소 없음). 배포만으로는 회원에게 보이는 푸시가 없다: 키가 없으면 푸시가 꺼져 있고, 키를 넣어도 계정 동의(기본 꺼짐)와 기기 등록이 있어야 보낸다. 접속 상태는 배포 직후부터 친구에게 보인다(모드 기본 `auto`). 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 마이그레이션 없이 새 api가 먼저 나가면 `users` 전체 열을 읽는 요청(세션 확인, 로그인 등)이 없는 열 때문에 거의 모두 실패한다(0014와 같다). 새 api가 이전 game-worker와 함께 있으면 api의 `PRESENCE` 바인딩이 가리키는 클래스가 없어, 하트비트는 503 `presence_unavailable`, 친구 상태는 모두 오프라인, 로그아웃의 허브 정리는 로그만 남긴다(다른 기능과 푸시는 그대로). 새 game-worker가 이전 api와 함께 있으면 허브는 아무도 부르지 않고, 대회 결과는 큐에 들어가지 않는다(구독이 없으므로). 이전 web은 하트비트를 보내지 않으므로 그 회원은 친구에게 오프라인으로 보인다. 되돌릴 때는 api(web 포함)만 이전 버전으로 내리는 것을 권장한다: 이전 api는 새 테이블과 열을 읽지 않으므로 지울 필요가 없고, 큐에 남은 행은 보내지지 않으며, 이미 설치된 서비스 워커는 fetch 처리기가 없어 다른 화면에 영향이 없고 로그인 확인 주소가 404라 푸시가 와도 보이지 않는다. game-worker를 `PresenceHub`가 없는 버전으로 되돌리는 것은 DO 마이그레이션 태그 때문에 거절되거나 `deleted_classes` 마이그레이션이 필요할 수 있다(확인하지 않았다). 허브는 저장한 것이 없어 클래스를 남겨 두어도 비용이 없다.
- **자동 머크 항상 적용·패 보이기 선택(feat/game-ux-vip-gto, 마이그레이션 없음)**: game-worker → api(web 포함) → admin. 이전 룸은 보일지 고르는 1.5초가 없고 이전 web 사용자의 자동 머크 설정을 따르므로 game-worker를 먼저 배포한다. 순서가 바뀌거나 game-worker만 되돌려도 새 web은 이전 룸이 알리는 내 좌석의 자동 머크(`you.autoMuck: false`)를 연결마다 한 번 켜고, '모두' 보이기를 이전 룸도 아는 장별 명령(`card` 0·1)으로 보내므로 진 패가 공개되거나 보이기가 `bad_request`로 거절되지 않는다(`docs/WEBSOCKET_PROTOCOL.md` '쇼다운 머크'·'패 보이기'). 새 룸과 이전 api가 함께 있는 동안 이전 api가 보내는 내부 `muck`은 `ok`만 받고 아무것도 바꾸지 않는다(관리자 초기화 결과의 반영 테이블 수는 의미가 없다). 이전 web은 새 룸이 `you.autoMuck`을 보내지 않아 설정을 보내지 않고, 설정 창의 자동 머크 칸은 눌러도 테이블에 효과가 없다. 회원이 카드를 받은 핸드는 다음 핸드가 1.5초 늦게 시작된다(정산 뒤 5.5초). 되돌릴 때는 game-worker를 이전 버전으로 내리면 이전 룸의 좌석별 자동 머크로 돌아간다. 새 web을 쓰는 사람은 위처럼 페이지가 켜서 계속 자동 머크가 적용되고, web까지 내리면 계정에 남은 `autoMuck` 값이 그대로 쓰인다(지울 것 없음).
- **마이그레이션 0031(VIP 회원 표시)·0032(고급 GTO 아카데미 진도)**: 0031은 `users`에 열 4개(`vip_color` NULL, `vip_version` 기본 0, `vip_changed_at`·`vip_changed_by` NULL)와 부분 인덱스 `users_vip_idx (status) WHERE vip_color IS NOT NULL`을 더한다(기존 행은 VIP 없음, 다른 열 변경 없음). 0032는 새 테이블 `academy_gto_progress`(회원 기본 키, `data`·`version`·`updated_at`, `users` 외래 키)만 만든다. 배포만으로는 아무도 VIP가 되지 않는다(최고 관리자나 `vip` 권한을 받은 관리자가 지정해야 함). 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 0031 없이 새 api가 먼저 나가면 `users` 전체 열을 읽는 요청(세션 확인, 로그인 등)이 거의 모두 실패하고(0029와 같다), 새 game-worker가 먼저 나가면 룸이 테이블 설정을 읽는 쿼리(`loadTable`, 토너먼트 참가자의 `vip_color`를 함께 읽음)가 캐시 테이블에서도 실패해 룸이 열리지 않는다(0028과 같다). 0032 없이 새 api가 나가면 고급 GTO 진도 읽기·저장과 회원 탈퇴(같은 batch에서 이 테이블의 행을 지움)가 실패한다(진도는 기기 안에 남고 다음 변경 때 다시 보냄). 새 api가 이전 game-worker와 함께 있으면 이전 룸은 VIP를 모르므로 테이블 좌석·채팅에 표시가 없고, 관리자의 VIP 변경 알림은 `reached`에서 빠진다(저장은 그대로). 되돌릴 때는 api(web 포함)·admin·game-worker를 이전 버전으로 내리면 된다. 이전 코드는 새 열과 테이블을 읽지 않으므로 지울 필요가 없다. 열까지 지우려면 `DROP INDEX users_vip_idx` 뒤 네 열을 지운다(`docs/ADMIN_SECURITY.md` 'VIP 회원 관리'). `DROP TABLE academy_gto_progress`는 서버에 저장된 고급 GTO 진도를 지운다(기기 안 사본은 남음). 원장·지갑·게임 테이블은 건드리지 않는다.
- **봇 AI 2.0(feat/bot-ai-2, 마이그레이션 없음)**: game-worker → api(web 포함) → admin. D1 스키마는 그대로다. `tables.bot_level`은 SQL 제약이 없는 text라 새 난이도 `expert`(전문가)가 그대로 들어가고, drizzle 스키마의 enum만 늘었다. 배포만으로는 봇이 새로 앉거나 정책이 바뀌지 않는다. 바뀌는 것은 앉은 봇의 결정(`docs/STATUS.md` '봇 AI 2.0')과 다음 두 가지다. (1) 새 game-worker는 봇이 친 핸드와 봇을 켠 테이블의 핸드를 정산할 때, 결과를 쓰는 같은 DO 저장소 put에 키 `oppStats`(그 테이블 회원들의 공개 행동 통계)를 하나 더 쓰고, 그 키를 쓴 테이블은 닫을 때 지운다. D1·다른 테이블에는 쓰지 않는다. (2) 관리자가 바꾼 테이블의 봇 난이도는 이미 앉아 있는 봇에게도 다음 핸드부터 적용된다(전에는 새로 앉는 봇만). 섞인 동안의 동작: 이전 api는 `expert`를 400으로 거절하므로 새 api가 나가기 전에는 고를 수 없다. 새 api와 이전 game-worker가 함께 있는 동안 `expert`로 저장한 테이블은 이전 룸이 모르는 난이도를 `normal`로 읽는다(`apps/game-worker/src/settlement.ts`). 배포 전에 열어 둔 이전 web은 `expert`의 난이도 글자(로비 배지·좌석·봇 카드)를 `undefined`로 보이고, 새로고침하면 바로잡힌다. 이전 admin은 `expert`를 값 그대로 보이고 고를 수 없다. 되돌릴 때는 먼저 관리자 콘솔에서 `expert` 테이블을 다른 난이도로 바꾼다(이전 api·admin으로 내린 뒤 그 테이블 설정을 저장하면 `expert`가 400으로 거절된다). 그다음 game-worker를 이전 버전으로 내리면 이전 봇으로 돌아간다. 남은 `oppStats` 키(테이블당 최대 약 17 KB)는 이전 코드가 읽지 않으며, 다시 새 버전을 올렸을 때 7일이 지난 회원의 통계는 버려진다.
- **통합 품질·리플레이(feat/quality-replay, 마이그레이션 없음)**: game-worker → api(web 포함) → admin. D1 스키마는 그대로다(drizzle 스키마는 주석만 바뀌었다). 대부분은 화면 쪽이다: 테이블 렌더링 비용 줄이기, 관리자 재확인 비밀번호의 보기 버튼, 승자가 보인 카드가 보드 옆으로 미끄러지는 연출, 리플레이의 집중 보기·캡처 모드, 공유 이미지(브라우저에서 그림, 서버 요청 없음). 서버에서 바뀌는 것은 다음과 같다. (1) 새 game-worker는 봇이 둔 수와 봇이 앉은 핸드를 난이도별로 룸 상태 `botStats`에 모아 20핸드마다 그 핸드 결과와 같은 D1 batch에서 `daily_stats`의 `bt_*` 행으로 더한다(봇 테이블마다 약 20핸드에 문장 1개. 지표 행은 난이도당 최대 15개). 자정을 넘긴 수는 새 날로 세고, 전날 몫은 다음 핸드 결과와 함께 쓴다. (2) 새 api의 일별 집계는 `bt_*`를 지우지 않고, 관리자 봇 화면 응답에 `play`를 더한다(SELECT 1개). (3) 리플레이·커뮤니티 핸드 리뷰의 플레이어에 지금 보이는 VIP 색 `vip`, 토너먼트 결과의 순위에 그때의 VIP 색이 실린다(룸 저장소에만, D1에는 쓰지 않음). (4) 푸시: 보내기 직전에 그 메시지·초대를 그새 읽었으면 `read`로 건너뛰고, 운영진이 된 친구에 대한 차단은 푸시를 막지 않으며(DM과 같게), 대화가 열린 기기는 5분 안에 조작이 있어야 보고 있는 것으로 친다(`docs/PRESENCE.md` '연결성 점검'). (5) 서비스 워커 `sw.js`: 알림 클릭이 게임 테이블 창을 이동시키지 않고, 읽은 대화의 알림을 닫는 `jc-read`를 받는다. 섞인 동안의 동작: 새 game-worker와 이전 api가 함께 있는 동안 이전 api가 이미 집계한 날을 다시 집계하면 그날의 `bt_*`를 지운다(통계만. 오늘 것은 아직 집계하지 않으므로 보통은 영향이 없다). 이전 admin은 `play`를 읽지 않고, 새 admin은 이전 api에서 '아직 기록된 봇 플레이가 없습니다'를 보인다. 배포 전부터 열려 있던 룸은 `botStats`가 없어 그 뒤의 수부터 센다. 이전 web은 `vip`를 읽지 않는다. 서비스 워커는 다음 페이지 로드 때 바뀌고, 이전 서비스 워커 + 새 페이지·새 서비스 워커 + 이전 페이지 모두 알림 클릭이 같은 화면으로 간다(`docs/PRESENCE.md`). 되돌릴 때는 api(web 포함)·admin·game-worker를 이전 버전으로 내리면 된다. 남은 `bt_*` 행은 이전 일별 집계가 그 날을 다시 집계할 때 지워지고, 이전 룸은 `botStats` 키와 순위의 `vip`를 읽지 않는다. 원장·지갑·게임 엔진·정산은 바뀌지 않았다.
- **베팅 라인 이미지·마지막 접속·자동 리바이/스택 보충(feat/betline-rebuy, 마이그레이션 0033)**: 0033은 `users`에 `last_online_at` 열 하나(NULL, 인덱스 없음)만 더한다(기존 행은 시각 없음, 다른 열 변경 없음). 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 0033 없이 새 api가 먼저 나가면 `users` 전체 열을 읽는 요청(세션 확인, 로그인 등)이 거의 모두 실패한다(0031과 같다). game-worker는 `users`의 정해진 열만 읽으므로 0033과 관계없다. 공유 이미지(베팅 라인 템플릿)는 브라우저에서 그리고 서버 요청이 없다. 서버에서 바뀌는 것은 다음과 같다. (1) 새 game-worker는 핸드 기록 `event_log`에 그 핸드의 블라인드 `blinds`를 더한다(핸드당 수십 바이트). 새 api의 리플레이·핸드 리뷰는 그것을 쓰고, 없는 이전 핸드는 포스트된 블라인드에서 읽거나 못 읽으면 칩으로만 보인다. 테이블의 지금 블라인드로 추정하지 않는다(핸드 리뷰가 `tables`의 블라인드를 더는 읽지 않는다). (2) 좌석의 자동 바이인 정책 `autoBuy`(끔·리바이·스택 보충)가 이전 `autoRebuy`를 대신한다. 배포 전부터 열려 있던 룸의 자동 리바이는 룸을 읽을 때 옮겨진다. WS는 `sit`의 `autoBuy`(선택)와 새 메시지 `autoBuy`를 받고 이전 `autoRebuy` 메시지도 그대로 받으며, TableView는 `you.autoBuy`를 더하고 리바이일 때 이전 `you.autoRebuy`도 그대로 보낸다(`docs/WEBSOCKET_PROTOCOL.md`). 자동 스택 보충은 기존 칩 추가와 같은 원장 경로(`top_up`, 키 `autotop:<좌석 세션>:<핸드>`, 메모 `auto top-up`)를 쓴다. (3) 운영 지표 `ops_metrics`에 `autobuy_stop`·`autobuy_dup`·`autobuy_invalid`가 생긴다(드문 일만, 기존 batch에 실림). (4) 접속 상태 허브는 회원마다 마지막 접속 시각 하나를 메모리에 두고, 새 api가 그것을 `users.last_online_at`에 저장한다(1행 UPDATE: 회원당 접속 중 최대 10분마다, 기기를 닫거나 로그아웃할 때 앞 저장 뒤 1분 이상 지났으면 한 번, `docs/PRESENCE.md` '마지막 접속 시각'). 허브와 api는 시각을 간격(`mark`·`age`·`stampAgo`·`seenAgo`)으로만 주고받는다. 섞인 동안의 동작: 새 game-worker와 이전 api가 함께 있는 동안 허브는 `mark`가 없는 박동을 표시하지 않는 박동으로 보아 시각을 움직이지 않고(쓰기 없음), 이전 api는 `auto top-up` 메모 행을 기간 집계에서 수동 칩 추가로 센다. 새 api와 이전 game-worker가 함께 있는 동안에는 이전 허브가 `stampAgo`·`seenAgo`를 답하지 않아 마지막 접속 시각이 새로 저장되지 않고 D1에 이미 저장된 시각만 보이며(잘못된 시각은 생기지 않음), 이전 룸이 쓴 핸드는 블라인드가 없어 위처럼 읽는다. 이전 룸에서는 새 web이 자동 바이인 선택지를 보이지 않는다(`you.autoBuy`가 없으면 고를 수 없음). 배포 전에 열어 둔 이전 web은 이전 `autoRebuy`만 보내고, 다른 탭에서 켠 스택 보충의 알림 문구가 없어 키 이름이 보일 수 있다(새로고침하면 바로잡힘). 이전 admin은 자동 바이인 지표와 `auto_topup` 행을 보이지 않고, 새 admin은 이전 api에서 그 지표 칸을 숨기고 `auto_topup` 행을 0으로 보인다. 되돌릴 때는 api(web 포함)·admin·game-worker를 이전 버전으로 내리면 된다. 이전 룸은 `autoBuy`를 읽지 않으므로 앉아 있던 좌석의 자동 리바이·스택 보충은 꺼진다(칩을 가져가지 않는 쪽). 진행 중이던 자동 충전은 좌석에 저장된 원장 키로 이전 룸도 마무리한다(`resolveTopUp`은 키 형식을 보지 않는다). `last_online_at` 열은 이전 코드가 읽지 않으므로 남겨 두어도 되고, 지우려면 `ALTER TABLE users DROP COLUMN last_online_at`(친구에게 보이던 마지막 접속 시각만 사라짐). 원장 잔액 계산·게임 엔진의 규칙·정산 순서는 바뀌지 않았다.
- **회원가입 인앱 브라우저 호환·봇 계정별 난이도/스타일(feat/signup-webview-bot-profiles, 마이그레이션 0034)**: 0034는 새 테이블 `bot_profiles`(봇 계정 기본 키·`users` 외래 키, `level`·`style` NULL = 테이블 설정 따르기, `updated_by`·`updated_at`)를 만들고 `tables`에 `bot_style` 열(기본 `'auto'`)을 더한다. 기존 봇 계정에는 행이 생기지 않아 지금처럼 테이블 난이도와 계정별 자동 스타일(`styleFor`, 계정 ID로 고정)로 둔다 — 모든 봇이 한 스타일로 바뀌지 않는다. 회원·봇의 이메일·비밀번호·지갑·원장·좌석은 건드리지 않는다. 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 0034 없이 새 game-worker가 먼저 나가면 룸이 테이블 설정을 읽는 쿼리(`bot_style`)와 봇 착석 쿼리(`bot_profiles` 조인)가 실패해 룸이 열리지 않고, 새 api가 먼저 나가면 `tables` 행 전체를 읽는 관리자 테이블 조회·수정이 실패한다. 섞인 동안의 동작: 새 api와 이전 game-worker가 함께 있으면 이전 룸은 개별 설정과 테이블 스타일을 읽지 않아 봇이 테이블 난이도·자동 스타일로 두고, 저장 응답의 `roomConfirmed`는 `false`다(저장은 그대로이며 새 룸이 뜨면 착석·딜 때 읽는다). 새 game-worker와 이전 api가 함께 있으면 행이 없고 `bot_style`이 `'auto'`라 배포 전과 같게 둔다. 이전 admin은 봇 계정 표와 테이블 스타일 선택을 보이지 않고, 새 admin이 이전 api를 만나면 봇 계정 표는 오류 문구를 보이며 테이블 수정의 `botStyle`은 이전 api가 버린다(400 없음). 회원가입 변경은 web 쪽이 대부분이고 api는 `resend_too_soon` 오류의 `details.codeExpiresInSeconds`만 더한다(이전 web은 무시, 새 web은 값이 없으면 재전송 대기만 보인다). 되돌릴 때는 api(web 포함)·admin·game-worker를 이전 버전으로 내리면 된다. 이전 코드는 새 테이블과 열을 읽지 않으므로 남겨 두어도 되고, 지우려면 `DROP TABLE bot_profiles`(관리자가 정한 봇별 설정만 사라짐)와 `ALTER TABLE tables DROP COLUMN bot_style`. 게임 엔진의 규칙·정산·원장 경로는 바뀌지 않았다(봇의 판단 함수만 스타일을 받는다).
- **턴·리버 공개 끊김·성능(feat/perf-reveal, 마이그레이션 없음)**: game-worker → api(web 포함) → admin. 새 지표 이름(`ops_metrics`의 `action_dup`·`recover_fail`·`web_error`, `daily_stats`의 `tb_timeout`)은 `metric` 열이 제약 없는 text라 스키마 변경 없이 들어간다. 섞인 동안: 이전 룸은 새 지표를 세지 않고 채팅 제한을 연결 단위로 둔다(이 변경 전 동작). 새 web이 이전 api에 보내는 `POST /api/me/web-error`는 404로 끝나고 화면은 무시한다(web과 api는 같은 워커라 함께 나간다). 새 관리자 화면은 값이 없는 지표를 0으로 보이고, 이전 관리자 화면은 새 값을 쓰지 않는다. 비용: `web_error`는 오류가 난 페이지에서만 요청 1회(페이지당 최대 3회, 회원당 시간당 10회)와 D1 쓰기 2회(요청 제한 1행, 지표 1행)이고, 나머지 지표는 룸이 이미 보내는 D1 묶음에 실린다. 정상 동작에서는 요청이 늘지 않는다.
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
| 봇 테이블의 핸드 종료(봇 AI 2.0) | 같은 put에 DO 저장소 `oppStats` 키 1행 더 쓰기(봇이 없고 봇을 끈 테이블은 0). 값 크기는 회원 1명 236 B, 8명 1.7 KB, 상한 64명 약 15–17 KB. 룸이 깨어난 뒤 봇 테이블이 처음 쓸 때 1행 읽기, 통계를 쓴 적이 있는 테이블만 닫을 때 1행 지우기. D1 변경 없음. 봇의 결정 1회는 로컬 시뮬레이션(Node, workerd 아님)에서 평균 0.33(쉬움)–0.79 ms(전문가), 최대 13.7 ms(전문가), 50 ms 넘은 결정 0건(747,057회 중)이고, 차례마다 기다리는 0.7–2.2초는 그대로라 알람·DO 요청 수는 바뀌지 않는다 | 코드(`apps/game-worker/src/opp-stats.ts`, `room.ts`의 정산). 크기는 같은 직렬화로 잰 값, 결정 시간은 `docs/TEST_REPORT.md` '봇 AI 2.0'. 운영 측정 아님 |
| 핸드 종료 | D1 새 행: `hands` 1 + `hand_players` 참가자 수. UPDATE: `tables.hands_played` 1, 로비 현황 약 2. 인덱스 갱신 별도 | 새 행 수는 측정, UPDATE는 코드 |
| 핸드 통계 계산(핸드마다) | D1 읽기: 4인 핸드 1개에 약 200–260행. 저장된 핸드 수와 관계없다. 쓰기는 참가자 수만큼 | 로컬 D1 `meta.rows_read` 측정(`hand_players` 200행·2,000행 DB 두 벌). 예전 문장은 저장된 `hand_players` 1행마다 약 4행을 더 읽었다(200행일 때 1,035행, 2,000행일 때 8,235행). 아래 "핸드 통계 읽기" 참고 |
| 착석·일어서기 | 각각 원장 1 + `users` 1 + `table_sessions` 1(+ 인덱스) | 측정(원장 = 바이인 + 잔액 있는 환급) |
| WS 연결 1회 | D1 `rate_limits` upsert 1행 | 측정(연결 수와 정확히 같음). 재연결이 잦으면 그만큼 쓴다 |
| 로그인한 회원의 요청 | 세션 만료 갱신 최대 1분에 1행 | 코드(`apps/api/src/lib/session.ts`) |
| 로비 목록 1회 | Workers 요청 1 + D1 읽기: 열린·닫는 중 테이블 전부(`tables_status_idx` 검색, + 방장 조인) + 세션·회원 조회. 로비 화면은 보이는 동안만 다시 부른다. 쓰는 동안 5초마다, 1분 동안 입력(포인터·키·휠)이 없으면 30초마다. 숨긴 탭은 멈추고, 요청이 겹치지 않는다 | 코드(`apps/web/src/pages/Lobby.tsx`, `apps/web/src/lib/lobby.ts`), 횟수는 단위 테스트(`apps/web/test/lobby.test.ts`) |
| 링크 미리보기 페이지 1회 | `/`·`/register`·`/table/*`·`/board/*`를 **주소창·새로고침·외부 링크로 처음 열 때** Workers 요청 1(앱 안에서 화면을 옮기는 것은 0회). D1 읽기는 테이블·게시글 주소만 기본 키로 1행(`/board/write` 같은 앱 경로도 1회 찾아보고 없으면 기본 미리보기). 세션 갱신·쓰기 없음 | 코드(`apps/api/src/index.ts`의 `sharePage`, `apps/api/src/lib/og.ts`). 예전에는 이 경로가 정적 자산으로 Workers 요청 없이 나갔다. 운영 측정 아님. 아래 7절 |
| 앱 핑 | 웹 클라이언트는 서버 메시지가 25초 동안 하나도 없을 때만 `{t:'ping'}`을 보낸다(핸드 진행 중에는 상태가 계속 와서 0회, 조용한 테이블에서 소켓당 10분에 약 23회). 런타임 자동 응답이 `{t:'pong'}`으로 답하고 DO를 깨우지 않는다 | 코드(`apps/web/src/game/link.ts`, `room.ts`), 횟수는 단위 테스트(`apps/web/test/link.test.ts`), 자동 응답은 통합 테스트(`tests/integration/ws-reliability.test.ts`) |
| 관리자 대시보드 실시간 현황 1회 | Workers 요청 1 + D1 batch 1(문장 8개). 읽는 행: 열린·닫는 중 테이블 약 3번(`tables_status_idx`), **세션 전부**(접속자 수, 아래), 최근 1시간 `ops_metrics`(최대 60분 × 4종), 열린 신고, 미해결 정합성 이벤트, 착석 세션. 화면이 보이고 관리자가 5분 안에 조작했을 때만 30초마다 다시 부른다 → 관리자 1명이 시간당 최대 120회. 숨긴 탭·자리 비움은 0회 | 코드(`apps/api/src/lib/ops.ts`, `apps/admin/src/pages/Dashboard.tsx`). 응답의 `rowsRead`(D1 `meta.rows_read` 합)를 화면에 그대로 보인다. 로컬 측정은 아래 "관리자 대시보드" |
| 접속 상태 하트비트 1회 | Workers 요청 1 + D1 읽기(세션 확인 1문장, 세션 연장 없음) + DO 요청 1(허브). D1 쓰기는 마지막 접속 시각 저장뿐이다: 보이는 상태의 회원당 10분에 한 번 이하, 닫을 때 1분에 한 번 이하, `users` 1행(응답 뒤). 허브가 다시 시작된 직후(배포)에는 접속 중인 회원마다 한 번. 로그인한 페이지마다 30초에 한 번, 탭을 숨기거나 보이거나 대화를 열 때와 5분 넘게 조용하다 다시 조작할 때 몇 초 안에 한 번 더. 30분 동안 조작이 없으면 멈춘다. 닫을 때 `leave` 1회 | 코드(`apps/web/src/lib/presence.ts`, `apps/api/src/routes/presence.ts`). 횟수는 단위 테스트(`apps/web/test/presence.test.ts`). 운영 측정 아님 |
| 친구 상태 1회 | Workers 요청 1 + D1 읽기(세션 + 수락된 친구 질의, 친구 수에 비례, 최대 친구 한도) + DO 요청 1. 친구 목록·대화 화면이 보이는 동안만 30초마다 | 코드(`apps/api/src/routes/social.ts`의 `friendPresenceRoutes`) |
| 매분 크론(푸시 큐) | 하루 1,440회 Workers 호출(CPU 몇 ms). 키가 없으면 D1을 읽지 않는다. 키가 있으면 매번 큐 UPDATE 1회(대기 인덱스 검색, 없으면 0행) | 코드(`apps/api/src/index.ts`의 `scheduled`, `apps/api/src/lib/notify.ts`) |
| 푸시 1건 | 큐 행 1개 쓰기(인덱스 3개 → 약 4행) + 보내기 직전 확인 읽기 몇 문장 + 상태 UPDATE 1 + 기기마다 푸시 서비스 하위 요청 1과 기기 행 UPDATE 1. 서비스 워커가 보일 때 로그인 확인 Workers 요청 1 + D1 읽기 1. 푸시를 켜지 않은 회원에게는 큐 넣기 문장 1개가 0행을 쓴다 | 코드. 운영 측정 아님 |
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

**접속 상태**(추정, 측정 아님): 하트비트는 로그인한 페이지 1개가 조작하는 동안 시간당 약 120회(30초마다)이고, Workers 요청과 DO 요청이 같은 수만큼 생긴다. 친구 화면을 보는 동안 친구 상태가 시간당 120회 더 든다.

| 동시 접속 페이지 | 시간당(하트비트) | 30일 연속 | 포함량 기준(Paid) |
|---|---|---|---|
| 10 | Workers 1,200 · DO 1,200 | 각 약 86만 | DO 월 100만 안 |
| 100 | Workers 1.2만 · DO 1.2만 | 각 약 864만 | DO 포함 100만 초과분 월 약 $1.15, Workers는 다른 사용량과 합쳐 1,000만 |
| 1,000 | Workers 12만 · DO 12만 | 각 약 8,640만 | DO 초과분 월 약 $13, Workers 초과분 월 약 $23 |

- DO 실행 시간: 허브 하나가 30초 안에 박동을 계속 받으면 잠들지 않는다고 볼 때 상한 월 약 32만 GB-s(포함 40만 안, 허브 하나 기준). 동시 접속이 적으면 그보다 적다.
- D1: 하트비트는 쓰지 않는다. 읽기는 세션 1행(기본 키)이다. 모드 저장만 `users` 1행을 쓴다.
- 무료 플랜이면 하루 요청 10만이 동시 접속 약 35페이지가 하루 내내 있으면 하트비트만으로 바닥난다(운영은 Paid).
- 줄이는 방법(적용됨): 30분 동안 조작이 없으면 멈춘다. 숨긴 탭은 브라우저가 타이머를 늦춘다. 친구 상태는 화면이 보일 때만 묻는다. 웹소켓으로 바꾸는 것은 연결 수만큼 DO가 깨어 있어야 해 실행 시간이 늘 수 있어 쓰지 않았다(측정하지 않았다).

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

- [ ] D1 `database_id` 입력, 마이그레이션 적용(`0000_init`, `0001_community`, `0002_comment_replies`, `0003_academy`, `0004_signup_profile`, `0005_social`, `0006_social_safety`, `0007_social_play`, `0008_session_remember`, `0009_dm_seq`, `0010_hand_stats`, `0011_hand_shown`, `0012_ops_metrics`, `0013_tables_hands_paused`, `0014_users_admin_notes`, `0015_reconcile_resolution`, `0016_service_notices_maintenance`, `0017_report_workflow`, `0018_admin_audit_search`, `0019_daily_stats`, `0020_refill`, `0021_bots`, `0022_referrals`, `0023_hand_notes`, `0024_user_settings`, `0025_time_bank`, `0026_tournaments`, `0027_admin_permissions`, `0028_social_policies`, `0029_presence_push`, `0030_push_sent_idx`). GitHub Actions 배포는 배포 전에 자동 적용한다. `0027`·`0028`·`0029`·`0030`의 배포 순서와 되돌리기는 위 "3. 배포 순서"의 각 항목을 따른다. `0026_tournaments`는 6인 SNG를 위한 새 테이블 세 개(`tournament_templates`, `tournaments`: 테이블 id 고유 인덱스, `tournament_entries`: 회원 인덱스)를 만들고 기본 템플릿 하나를 넣는다(기존 테이블 변경 없음: `tables.room_type`은 SQL 제약이 없어 `tournament`가 그대로 들어간다). 대회 칩은 이 테이블에만 있고 원장·지갑·`table_sessions`에 닿지 않는다. 배포만으로는 대회가 열리지 않는다. 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin이며, game-worker가 새 버전이 되기 전에는 대회를 만들거나 시작하지 않는다(이전 룸은 대회 좌석·레벨을 모른다. 이 혼합 상태는 확인하지 않았다). 마이그레이션 없이 새 api가 먼저 나가면 대회 화면·관리자 대회 화면이 실패한다(다른 기능은 이 테이블을 읽지 않으나, 관리자 테이블 상세는 대회 조회가 같은 요청에 있어 실패한다). 되돌릴 때는 진행 중인 대회를 먼저 운영 중단한 뒤 내린다. 자세한 내용은 `docs/TOURNAMENT.md` "배포 순서". `0025_time_bank`는 시간 은행 정책 버전 테이블 `time_bank_policies`(버전 기본 키, 외래 키 없음)를 만들고 버전 1(켜짐, 공식·회원 방 모두, 처음 30초·최대 60초·한 번 10초·10핸드마다 5초 보충)을 넣는다(기존 테이블 변경 없음). **배포 직후 모든 테이블에서 시간 은행이 켜진다**: 각 테이블의 다음 핸드부터 회원이 처음 받을 때 30초를 받는다. 처음부터 끄고 시작하려면 배포 뒤 최고 관리자가 "테이블 → 시간 은행"에서 끄면 다음 핸드부터 적용된다. 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 새 game-worker는 테이블 설정을 읽을 때와 핸드를 기록할 때(같은 D1 batch) 이 테이블을 함께 읽으므로, 마이그레이션 없이 먼저 나가면 룸이 테이블 설정을 읽지 못해 열리지 않는다. 이전 game-worker와 새 api가 함께 있는 동안에는 정책 저장 뒤 룸 반영이 "답하지 않음"으로 남고(저장은 됨), 타이머 복구는 503 `room_unavailable`, 테이블 진단의 턴 타이머·시간 은행 패널은 비어 보인다. 새 web은 룸이 상태에 `timeBank`를 보낼 때만 버튼을 보이므로 이전 룸에서는 버튼이 나오지 않는다(보내더라도 이전 룸은 `bad_request`로 답한다). 회원의 남은 시간은 룸의 Durable Object 상태(`room`)에 있고 D1에는 없다. 되돌릴 때 이전 game-worker로 내리면 시간 은행 없이 기본 턴 시간만 쓴다. 그 사이 이전 룸이 좌석을 새로 만들면 그 회원의 남은 시간이 사라져, 다시 올린 뒤 처음 지급량을 다시 받을 수 있다(되돌린 동안의 남은 시간은 보장하지 않는다). 이전 api로 내리면 관리자 시간 은행 화면만 실패한다. 테이블은 남겨 둔다. `0024_user_settings`는 회원의 계정 설정(테마·4색 덱·위험 액션 확인·초보자 모드·자동 머크·금액 표시 단위·빠른 반응)과 즐겨찾는 테이블을 위한 새 테이블 `user_settings`(회원 기본 키 한 행, 외래 키 없음)를 만든다(기존 테이블 변경 없음). 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 새 api는 계정의 자동 머크가 바뀌면 회원이 앉은 룸에 내부 요청 `muck`을 보내는데, 이전 game-worker는 이 요청에 404로 답해 그 룸은 테이블 화면이 다음에 연결될 때 맞춘다(실패는 저장을 막지 않는다). 마이그레이션 없이 새 api가 먼저 나가면 설정 불러오기·저장, 회원 탈퇴(같은 batch에서 이 테이블을 지운다), 관리자 회원 상세의 계정 설정 패널이 실패한다. 설정 저장 실패는 이 기기에 적용된 채로 다시 시도하므로 화면 설정은 그대로 쓸 수 있다. 새 web이 처음 로그인하는 기기는 기존 기기 설정(`jc.prefs`)을 계정에 값이 없는 칸에만 올리고 지운다. 새 admin이 이전 api와 함께 있으면 계정 설정 패널과 운영 통계의 설정 동기화 패널만 오류를 보인다. 되돌릴 때 이전 api·web으로 내려도 테이블은 남고 다른 기능에 영향이 없지만, 이전 web은 기기 설정을 다시 `jc.prefs`에서만 읽으므로 새 web이 이미 계정으로 옮긴 기기에서는 기본값으로 보인다(다시 새 web을 올리면 계정 설정이 돌아온다). `0023_hand_notes`는 회원 본인의 핸드 북마크·태그·메모를 위한 새 테이블 `hand_notes`(회원·핸드 기본 키, `user_id`·`ended_at` 인덱스)를 만든다(기존 테이블 변경 없음). 배포 순서는 마이그레이션 → api(web 포함) → admin(game-worker 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 이 테이블을 함께 읽는 마이페이지 핸드 목록·핸드 상세·노트 저장, 회원 탈퇴, 관리자 운영 통계가 실패한다. 되돌릴 때 이전 api로 내려도 테이블은 남고 다른 기능에 영향이 없다(이전 api는 읽지 않는다). `0022_referrals`는 추천 보상을 위한 새 테이블 세 개(`referral_codes`: 회원별 추천 코드 한 개, 코드 고유 인덱스, `referral_policies`: 추천 정책의 버전별 기록, `referrals`: 추천 한 건씩, 가입자 고유 인덱스와 추천인·상태·이메일 HMAC 인덱스)를 만든다(기존 테이블 변경 없음: `chip_ledger.type`은 SQL 제약이 없어 새 종류 `referral`도 그대로 들어간다). 정책 1판은 **꺼짐**(양쪽 보상 0, 하루 5명·누적 50명, 필요 핸드 1, 검토 기준 3)으로 넣으므로 배포만으로는 아무에게도 지급하지 않는다. 꺼진 동안 코드로 가입한 추천은 `unpaid`(`off`)로 기록만 되고 나중에 켜도 지급되지 않으므로, 추천 링크를 알리기 전에 최고 관리자가 관리자 콘솔(추천인 운영)에서 운영 보상액·한도·필요 핸드 수를 정해 켠다(예시 값은 개발 시드일 뿐 운영 지급액이 아니다). 회원 화면의 추천 링크는 `APP_ORIGIN`(없으면 요청 주소)으로 만든다. 배포 순서는 마이그레이션 → api(web 포함) → admin(game-worker 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 추천 코드를 넣은 가입, 회원 탈퇴(추천 코드 삭제가 같은 batch에 있다), 내 정보의 추천 카드, 관리자 추천인 화면이 실패하고, 매일 크론의 추천 정산 단계가 실패로 기록된다(같은 크론의 통계·정리·룸 점검은 그대로 돈다). 코드 없는 가입·경제 화면·다른 기능은 영향 없다. 새 admin이 이전 api와 함께 있으면 추천인 화면과 회원 상세의 추천 칸만 오류를 보인다. 이전 admin은 새 api에서 그대로 동작하되 원장 종류 `referral`을 이름 없이 값 그대로 보인다. 되돌릴 때 이전 api로 내려도 세 테이블과 `referral` 원장 행은 남고 잔액은 맞는다(지급은 원장으로만 했다). 이전 api는 가입 요청의 `referralCode`를 무시한다. `0021_bots`는 테이블 봇을 위한 새 테이블 세 개(`bot_policies`: 봇 정책의 버전별 기록, `bot_fund`: 봇 기금이 발행한 칩 합계 한 행, `bot_events`: 봇 착석·퇴장·실패 기록과 시각·테이블 인덱스)를 만들고, `users.is_bot`(부분 인덱스 `users_bot_idx`), `hands.bots`(그 핸드의 봇 수), `tables`의 `live_bots`와 테이블별 봇 설정 6열(`bots_enabled` 기본 꺼짐, `bot_level` normal, `bot_min_humans` 1, `bot_max` 1, `bot_fill_to` 2, `bot_yield` 켜짐)을 더한다. 정책 1판은 **꺼짐**(기금 0, 최대 봇 0)으로 넣고 모든 테이블의 `bots_enabled`도 0이므로, 배포만으로는 봇이 앉지 않는다. 운영에서 쓰려면 배포 뒤 최고 관리자가 관리자 콘솔(봇 운영)에서 기금 한도·최대 봇 수와 함께 정책을 켜고, 공식 테이블마다 봇 설정을 켠다. 기존 행은 바뀌지 않는다(`chip_ledger.type`은 SQL 제약이 없어 새 종류 `bot_fund`도 그대로 들어간다). 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin. 마이그레이션 없이 새 game-worker가 먼저 나가면 룸이 테이블 설정(`bots_enabled` 등)을 읽지 못해 열리지 않고, 새 api가 먼저 나가면 로비(`live_bots`)와 관리자 봇 화면이 실패한다. 이전 game-worker가 새 api와 함께 있는 동안에는 정책을 켜도 봇이 앉지 않을 뿐이다(정책 변경의 룸 다시 읽기는 기존 `reload`). 새 game-worker가 이전 api·web과 함께 있어도 정책이 꺼져 있어 봇은 생기지 않는다. 봇 계정의 `password_hash`는 해시 형식이 아닌 표시값이라 이전 api에서도 로그인할 수 없다. `0020_refill`은 새 테이블 두 개(`refill_policies`: 무료 칩 보충 정책의 버전별 기록, `refill_claims`: 지급한 보충 한 건씩, 회원·회차 고유 인덱스와 시각 인덱스)를 만들고 정책 1판(켜짐, 지갑+테이블 합계 1,000칩 미만, 2,000칩, 대기 6시간)을 넣는다(기존 테이블 변경 없음: `chip_ledger.type`은 SQL 제약이 없어 새 종류 `free_refill`도 그대로 들어간다). **새 api가 나가는 순간 회원이 보충을 받을 수 있으므로**, 이 값은 개발용 기본값일 뿐이고 운영 금액·기준·대기 시간은 배포 직후 최고 관리자가 관리자 콘솔(경제 → 무료 칩 보충)에서 정하거나 끈다(정책 변경은 다음 청구부터, 이미 시작된 대기 시간은 그대로). 바로 쓰지 않으려면 배포 전에 운영자가 정한 값으로 이 파일의 `INSERT` 값을 바꾸거나 `enabled`를 0으로 둔다. 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin(GitHub Actions 배포 순서와 같다). 새 api는 앉은 테이블의 칩을 룸에 묻는데(`holdings`), 이전 game-worker는 이 요청을 몰라 보충이 "확인할 수 없음"으로 보류되므로 game-worker가 api보다 먼저 나가야 한다. 마이그레이션 없이 새 api가 먼저 나가면 보충 조회·받기와 관리자 보충 화면·회원 상세의 보충 칸이 실패한다(경제 화면은 원장만 읽어 영향 없음, 다른 기능도 영향 없음). 새 admin이 이전 api와 함께 있으면 보충 화면과 회원 상세의 보충 칸만 오류를 보인다. 이전 admin은 새 api에서 그대로 동작하되 원장 종류 `free_refill`을 이름 없이 값 그대로 보인다. 되돌릴 때 이전 api로 내려도 두 테이블과 `free_refill` 원장 행은 남고 잔액은 맞는다(지급은 원장으로만 했다). B9(관리자 콘솔 목록·확인 창 정리)는 마이그레이션이 없고 api → admin 순서로 배포한다(game-worker·web 변경 없음: 공용 모달의 닫기 이름은 기본값이 그대로라 회원 화면은 바뀌지 않는다). 새 admin은 원장·핸드·테이블·게시판·쪽지 이력을 `paged=1`로 요청하므로, 이전 api와 함께 있으면 이 목록 화면이 오류나 빈 목록을 보인다. 이전 admin은 새 api에서 그대로 동작한다(`paged` 없는 기존 응답 유지). 다만 이전 콘솔의 신고 처리는 확인 창 없이 기존처럼 바로 처리되고, 원장 화면을 열 때마다 감사 로그 1행(`ledger.view`)이 생긴다. `0019_daily_stats`는 새 테이블 두 개(`active_days(day, user_id)`: 회원이 활동한 날, `daily_stats(day, metric, n)`: 날짜·지표별 수치, 둘 다 `WITHOUT ROWID`)와 닫힌 좌석만 담는 부분 인덱스 `tsess_closed_idx(closed_at) WHERE closed_at IS NOT NULL`(`table_sessions`)을 만든다(기존 열 변경 없음). 새 api가 로그인·아카데미 이벤트·탈퇴·크론에서 이 테이블을 쓰므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 아카데미 이벤트 기록, 회원 탈퇴, 정리 크론 전체가 실패한다(활동 기록 실패는 로그만 남기고 요청은 성공한다). 새 admin이 이전 api와 함께 있으면 운영 통계 화면만 오류를 보인다. 배포 뒤 첫 크론(또는 관리자가 운영 통계를 처음 열 때, 한 번에 31일씩)이 첫 가입일(최대 366일 전)부터 끝난 날을 집계한다. 활동 회원 수와 아카데미 일별 카운터는 배포한 날부터 쌓이므로 그 전 날짜는 비어 있고(화면에 `*`·안내로 표시), 배포한 날 자체도 배포 전 시간의 활동이 빠진다. 인덱스 생성 시간은 `table_sessions` 행 수에 비례한다. `0018_admin_audit_search`는 `admin_audit_log`에 기본값 `ok`인 열 `outcome`(`ok`·`failed`)과 인덱스 세 개(`audit_actor_idx(actor_id, created_at)`, `audit_action_idx(action, created_at)`, 실패만 담는 부분 인덱스 `audit_failed_idx(created_at) WHERE outcome = 'failed'`)를 더하고, 이전에 쌓인 실패 기록(`admin.login.failed`, `admin.reauth.failed`, `user.chips_refused`)을 `failed`로 바꾼다. 새 api가 감사 행을 쓸 때마다 이 열을 채우므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 감사 행을 쓰는 관리자 요청(로그인 포함)이 대부분 실패한다(회원 기능은 영향 없음). 이전 api는 새 열을 모르지만 기본값 덕분에 그대로 동작한다. 새 api와 이전 admin이 함께 있는 동안 이전 콘솔은 미리보기 없이 기존처럼 바로 실행되고, 일반 관리자의 회원 정보 내보내기는 403으로 보이며, 관리 이력에는 자기 기록만 보인다. 인덱스 생성과 UPDATE 시간은 `admin_audit_log` 행 수에 비례하므로 운영 적용 전 `SELECT COUNT(*) FROM admin_audit_log`로 규모를 확인한다. `0017_report_workflow`는 `reports`에 null 허용 열 다섯 개(`severity`, `assignee_id`, `assigned_at`, `notice_reporter`, `notice_target`: 기존 신고는 모두 NULL = 미지정·미배정·안내 기록 없음), 처리 기록 테이블 `report_events`(신고 ID, 관리자 ID, 종류, 변경 전후, 메모)와 인덱스 네 개(`report_events(report_id, created_at)`, `reports(assignee_id, status)`, `reports(created_at)`, `users(role, status) WHERE role != 'user'` 부분 인덱스)를 더한다. 새 api가 신고 접수·목록·처리에서 이 열을 읽고 쓰므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 회원의 신고 접수와 관리자 신고 화면이 실패한다(회원 상세의 신고 건수는 기존 열만 읽어 영향 없음). 새 api와 이전 admin이 함께 있는 동안 이전 콘솔은 신고 목록의 첫 50건(이전 200건)만 보이고 처리는 안내 쪽지 없이 그대로 동작한다. 인덱스 생성 시간은 `reports` 행 수에 비례한다. `0016_service_notices_maintenance`는 새 테이블 두 개(`service_notices`: 한국어·영어 공지와 표시 시작·종료, `maintenance_windows`: 점검 시작·종료·로그인 제한·안내 문구·조기 종료·취소 시각)와 인덱스 두 개를 만든다(기존 테이블 변경 없음). 새 game-worker는 테이블 설정을 읽을 때와 점유 현황을 기록하는 batch에서 `maintenance_windows`를 함께 읽으므로 마이그레이션 → game-worker → api → web·admin 순서로 배포한다. 마이그레이션 없이 새 game-worker가 먼저 나가면 룸이 테이블 설정을 읽지 못해 열리지 않는다. 새 api가 이전 game-worker보다 먼저 나가면 점검 중에도 이전 룸은 착석을 받고 핸드를 계속 시작한다(빠른 참가·방 만들기·로그인 거절만 동작). 새 api와 이전 web이 함께 있는 동안에는 배너와 점검 안내 페이지가 없고, 점검 거절은 이전 web이 모르는 코드라 일반 오류 문구로 보인다. 운영에서 점검을 쓰기 전에 네 Worker가 모두 새 버전인지 확인한다. `0015_reconcile_resolution`은 `reconciliation_events`에 null 허용 열 `resolution`(note·record·revert, 예전 처리는 NULL = 메모만) 하나를 더한다. 새 api가 정합성 목록·검사·정정에서 이 열을 읽고 쓰므로 마이그레이션 → game-worker → api → admin 순서로 배포한다(web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 정합성 화면과 검사가 실패한다(다른 기능은 영향 없음). 새 game-worker는 환급 실패를 `ops_metrics`의 `cashout_fail`로 세는데, 이전 api는 모르는 지표를 무시하므로 game-worker를 먼저 내보내도 된다. 새 api와 이전 admin이 함께 있는 동안 이전 콘솔의 정합성 해결은 메모만 남기기로 처리되고, 일반 관리자의 100,000칩 이상 조정은 `large_adjustment` 코드 그대로 거절이 보인다. `0014_users_admin_notes`는 `users`에 null 허용 열 `last_login_at`(최근 로그인), 관리자 내부 메모 테이블 `admin_notes`, 인덱스 3개(`admin_audit_log(target_type, target_id, created_at)`, `admin_notes(user_id, created_at)`, `reports(reporter_id, created_at)`)를 더한다. 기존 회원의 `last_login_at`은 다음 로그인 전까지 비어 있다("기록 없음"으로 표시). 새 api가 로그인·탈퇴 때 이 열과 테이블을 쓰므로 마이그레이션 → api → admin 순서로 배포한다(game-worker·web 변경 없음). 마이그레이션 없이 새 api가 먼저 나가면 `users` 전체 열을 읽는 요청(세션 확인, 로그인 등)이 없는 열 때문에 거의 모두 실패한다. 새 api와 이전 admin이 함께 있는 동안에는 이전 콘솔의 정지 해제·권한 변경이 사유 없이 보내져 400으로 거절된다(새 콘솔을 내보내면 해결, 데이터 변경 없음). 인덱스 생성 시간은 `admin_audit_log`·`reports` 행 수에 비례하므로 운영 적용 전 `SELECT COUNT(*)`로 규모를 확인한다. `0013_tables_hands_paused`는 `tables`에 기본값 0인 열 `hands_paused`(관리자의 새 핸드 중단) 하나를 더한다. 새 game-worker가 테이블을 읽을 때 이 열을 고르므로 마이그레이션 → game-worker → api → web·admin 순서로 배포한다. 마이그레이션 없이 새 game-worker가 먼저 나가면 룸이 테이블 설정을 읽지 못해 열리지 않는다. 새 api보다 이전 game-worker가 남아 있으면 강제 연결 종료(`kick`)와 긴급 제어 확인이 실패(룸 응답 없음으로 보고)하고, 이전 api는 핸드셰이크에 인증 시각을 넣지 않아 연결 종료 뒤 60초 동안 그 회원의 재연결이 거절된다. `0012_ops_metrics`는 관리자 대시보드의 분 단위 운영 카운터 테이블 `ops_metrics`를 새로 만든다(기존 테이블 변경 없음). 새 game-worker와 api가 이 테이블에 기록하므로 마이그레이션 → game-worker → api → web·admin 순서로 배포한다. 마이그레이션 없이 새 game-worker가 먼저 나가면 카운터가 들어간 룸의 통계 batch가 계속 실패해, 그 룸의 로비 점유 현황이 갱신되지 않고 10초마다 재시도한다(게임 진행과 칩에는 영향 없음). `0011_hand_shown`은 `hand_players`에 null 허용 열 `shown` 하나를 더한다(기존 행은 NULL = 쇼다운에 간 패를 공개로 봄). 새 game-worker는 이 열에 기록하므로 마이그레이션을 game-worker보다 먼저 적용해야 한다. `0010_hand_stats`는 `hand_players`에 통계 열 5개와 부분 인덱스를 더하고, 같은 파일 안에서 기존 핸드 전체의 통계를 한 번 채운다(이후는 게임 워커가 핸드 기록 직후 채움). 기록 수에 비례해 실행 시간이 늘어나므로 운영 적용 전 `SELECT COUNT(*) FROM hand_players`로 규모를 확인한다
- [ ] 두 Worker에 같은 `INTERNAL_SECRET`, 최초 관리자 생성 후 `ADMIN_BOOTSTRAP_TOKEN` 삭제
- [x] 웹 푸시의 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY`(2절, 2026-10-21 운영 등록)
- [ ] 마이페이지 알림 설정에서 계정 동의 → 이 기기에서 받기 → 친구의 DM으로 실제 수신을 확인한다(실기기는 아직 확인하지 않았다)
- [ ] `ALLOWED_ORIGINS`·`ADMIN_ORIGIN`·`APP_ORIGIN`이 실제 운영 주소(https://jc-royal.site, https://admin.jc-royal.site)와 일치
- [ ] 배포 후 가입 인증번호 메일과 비밀번호 재설정 메일이 `noreply@jc-royal.site`에서 오고, 재설정 링크가 https://jc-royal.site/reset 으로 열리는지 확인
- [ ] 관리자 콘솔에서 테이블 생성(운영 DB에는 개발용 시드 테이블을 넣지 않는다)
- [ ] 대시보드 서버 상태, 정합성 검사 실행으로 확인
- [ ] 링크 미리보기: 7절의 `curl` 두 줄로 태그와 이미지(200, `image/png`)를 확인하고, 카카오 공유 디버거에서 `https://jc-royal.site/`를 한 번 초기화

## 7. 링크 미리보기(OG)와 공유

카카오톡·페이스북·X 같은 미리보기 크롤러는 스크립트를 실행하지 않고 첫 HTML만 읽는다. 그래서 태그는 `apps/web/index.html`의 `<!-- og:begin -->`·`<!-- og:end -->` 사이에 있고, 링크마다 내용이 다른 네 경로(`apps/api/wrangler.jsonc`의 `run_worker_first`: `/`, `/register`, `/table/*`, `/board/*`)만 `play` Worker가 그 블록을 바꿔 보낸다(`apps/api/src/lib/og.ts`). 나머지 화면은 정적 자산 그대로이며 같은 기본 태그를 갖는다.

| 링크 | 미리보기 |
|---|---|
| 홈, 그 밖의 앱 화면 | 기본: "JC ROYAL \| No.1 마인드 스포츠" + 소개 문구 + `https://jc-royal.site/og-image.png` |
| `?lang=en` | 영어 제목·설명, `og:locale=en_US`, `<html lang="en">`. 언어를 저장하지 않은 방문자의 앱도 영어로 연다 |
| 공개 테이블 `/table/<id>` | 테이블 이름(40자)과 블라인드·인원만. 비공개·닫힌·없는 테이블은 기본 미리보기(이름·참가 코드 없음) |
| 게시글 `/board/<id>` | 공개(`visible`) 글의 제목(60자)과 본문 앞부분(110자, 줄바꿈·제어 문자 정리). 숨김·삭제·없는 글은 기본 미리보기 |
| 추천 링크 `/register?ref=JC…` | 기본 미리보기. `og:url`에는 형식에 맞는 코드(`JC` + 영문 대문자·숫자 5–10자)만 남기고 그 밖의 쿼리는 버린다 |

- 쿼리 문자열(참가 코드·토큰 등)은 미리보기에 옮기지 않는다. 텍스트는 모두 HTML 이스케이프한다. 회원 앱의 공유·초대 버튼도 `/table/<id>`처럼 주소만 공유한다(비공개 방의 참가 코드는 따로 전한다).
- 공유 버튼은 브라우저의 공유 시트(Web Share API)가 있으면 그것을 열고, 없거나 막히면 링크를 복사한다(클립보드 API가 없으면 선택 복사). 위치: 로비 검색창 옆, 테이블 설정 맨 위 "테이블 초대 링크".
- 미리보기를 만드는 응답은 `cache-control: no-cache`이고 정적 페이지와 같은 보안 헤더(CSP 등)를 갖는다. D1 읽기가 실패하면 기본 미리보기로 답한다(페이지는 그대로 열림).

**이미지**
- `apps/web/public/og-image.png`는 전달받은 배너 원본이다(1200×630 PNG, 1,054,620바이트, SHA-256 `68DEED47…E68B`). 다시 만들거나 압축하지 않았고, `tests/integration/og.test.ts`가 바이트 단위로 같은지 확인한다.
- 파일이 1 MB를 조금 넘는다. 큰 이미지를 미리보기에서 빼는 메신저가 있다고 알려져 있으나 이 저장소에서 확인하지 않았다. 문제가 보이면 같은 디자인을 압축한 새 파일로 바꾼다(아래 교체 순서).
- **교체 순서**: 새 파일을 **새 이름**(`og-image-2.png`)으로 넣고 `og.ts`의 `OG_IMAGE`, `index.html`의 블록(`og.test.ts` 단위 테스트가 두 곳이 같은지 확인), `tests/integration/og.test.ts`의 크기·해시를 함께 바꾼다. 같은 이름을 덮어쓰면 메신저가 저장해 둔 이전 이미지가 계속 보일 수 있다.

**미리보기가 바뀌지 않을 때(배포 후)**
- 카카오톡: [카카오 공유 디버거](https://developers.kakao.com/tool/debugger/sharing)에 **https까지 포함한 정확한 주소**를 넣고 캐시를 초기화한다. 주소 단위로만 초기화되고(경로 일괄 불가), 메타데이터만 지워지므로 이미지가 그대로면 이미지 주소를 바꿔야 한다. 카카오 개발자 포럼 답변 기준으로 같은 주소는 기본 1시간 캐시된다(서버의 `Cache-Control`과 무관).
- 페이스북·메신저: [Sharing Debugger](https://developers.facebook.com/tools/debug/)에서 "다시 스크랩". 이미 게시된 글의 미리보기는 바뀌지 않는다.
- 확인: `curl -s -A 'facebookexternalhit/1.1' https://jc-royal.site/ | grep -E 'og:|twitter:'`, `curl -sI https://jc-royal.site/og-image.png`(200, `image/png`).

**비용**: 위 네 경로를 처음 열 때마다 Workers 요청이 1회 늘고(앱 안 이동은 0회), 테이블·게시글 주소는 D1 1행을 읽는다(5절 표). 같은 사람이 테이블 화면을 열면 바로 WebSocket 연결(요청 1 + D1 쓰기 1행)과 API 호출이 뒤따르므로 그보다 작다. 운영에서 측정하지 않았다.

**배포**: `play` Worker(api + web 자산)만 바뀐다. 마이그레이션·game-worker·admin 변경은 없다.
