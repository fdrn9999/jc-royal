# 개인정보 처리 운영 문서

회원이 보는 문서와 코드가 실제로 하는 일을 한곳에 맞춰 둔 운영자용 문서다. 세 문서가 서로 어긋나면 안 된다.

| 문서 | 위치 | 상태 |
|---|---|---|
| 가입 동의 안내(개인정보 수집·이용) | `apps/web/src/legal/privacyNotice.ts`, 버전 `PRIVACY_NOTICE_VERSION` = `2026-10-15` | 가입 때 동의를 받고 버전·시각을 `users`에 기록 |
| 개인정보 처리방침 `/privacy` | `apps/web/src/legal/policies.ts` (`PRIVACY_POLICY`) | **법무 검토 전 초안**. 화면 상단에 초안 표시 |
| 이용약관 `/terms` | `apps/web/src/legal/policies.ts` (`TERMS`) | **법무 검토 전 초안**. 가입 때 동의는 받지 않는다(9절) |

정해지지 않은 사항은 문서에 "검토 필요"로 표시만 하고 개발자가 확정하지 않았다. 목록은 [9절](#9-법무-검토-필요-항목)에 모았다. `main`에 병합하면 운영에 자동 배포되므로, 초안 상태로 공개해도 되는지 먼저 정해야 한다.

## 1. 저장하는 개인정보

| 저장 위치 | 개인정보 | 비고 |
|---|---|---|
| `users` | 이메일, 비밀번호 해시(PBKDF2), 닉네임, 생년월일, 이용 언어, 프로필 이미지 URL, 권한·상태·정지 사유, 이메일 인증 시각, 개인정보 동의 버전·시각, 최근 로그인 시각(`last_login_at`), 친구 요청 설정, 1:1 대화 알림 설정, 잔액 | 실명·전화번호·주소·결제 정보는 받지 않는다 |
| `sessions` | 토큰 SHA-256 해시, IP(`cf-connecting-ip`), User-Agent(300자), 생성·마지막 사용·만료 시각, 자동 로그인 여부 | 회원·관리자 세션 공용 |
| `email_verifications` | 이메일, 인증번호 해시(`sha256(email:code)`), 만료 시각 | 가입 전 단계 |
| `password_resets` | 토큰 해시, 회원 ID, 만료 시각(30분) | |
| `rate_limits` | 키에 IP·이메일·회원 ID가 들어간다(`login-acct:<email>`, `verify-ip:<ip>` 등), 집계 시작 시각, 횟수 | 가장 긴 집계 창은 1시간 |
| `chip_ledger`, `hands`, `hand_players`, `table_sessions` | 회원 ID, 칩 증감, 핸드 기록, 좌석 기록 | 칩 보존 검증의 근거 |
| `posts`, `comments`, `post_hands` | 작성자 ID, 본문 | 회원이 지우면 `status='deleted'`로 숨김(행은 남음) |
| `messages` | 운영자 쪽지 수신자 ID, 제목·본문, 읽음·삭제 시각 | |
| `friendships`, `user_blocks` | 두 회원 ID, 요청자, 시각 | 해제하면 행 삭제 |
| `direct_messages` | 보낸·받은 회원 ID, 본문(500자), 초대한 테이블, 읽음 시각, 순번 | 친구끼리만 보낼 수 있다 |
| `reports` | 신고자·대상 회원 ID, 사유, 상세, **증거(`context` JSON)**, 처리자·처리 메모 | 4절 |
| `academy_progress`, `user_badges` | 회원 ID, 진도, 배지 | `academy_stats`에는 회원 ID가 없다(익명 집계) |
| `admin_audit_log` | 운영자 ID, 조치, 대상, 상세, **운영자 IP** | 5절 |
| `admin_notes` | 대상 회원 ID, 작성한 운영자 ID, 본문(500자), 작성 시각 | 운영자 인수인계용 내부 메모, 회원에게 보이지 않음. 이메일·전화번호·주민등록번호·카드 번호처럼 보이는 본문은 거절(5절) |
| `ops_metrics` | 없음. 1분 단위 시각, 지표 이름(`ws_retry`·`ws_drop`·`room_error`·`api_error`), 횟수만 | 관리자 대시보드의 오류·연결 추이. 회원 ID·IP·테이블 ID를 넣지 않는다 |
| `tables.last_issue` | 없음. 테이블 룸의 최근 오류(시각, 작업 이름, 오류 메시지 300자) | 관리자 대시보드·테이블 상세에 표시 |
| 게임 서버(Durable Object 저장소) | 테이블 채팅 최근 50줄(작성자 ID·닉네임·본문), 좌석·핸드 진행 상태, 관리자가 연결을 끝낸 회원 ID와 시각(60초 동안 재연결 검사에 쓰고, 그 방의 다음 연결 종료 때 지난 항목을 지움) | 닫힌 뒤 24시간에 채팅 삭제 |
| 브라우저 `localStorage` | `jc.locale`, `jc.prefs`(화면·게임 표시 설정), 자동 로그인 선택, `jc.mute:<id>`(채팅 음소거), `jc.academy:<id>`(아카데미 진도) | 아카데미 진도만 서버와 동기화 |
| Cloudflare Workers 로그 | `observability.enabled`. 요청 메타데이터와 `console.log` 출력 | 보관 기간은 Cloudflare 요금제가 정한다 |

쿠키는 `jc_sid`(회원), `jc_asid`(관리자) 두 개뿐이며 광고·분석 도구는 없다. `jc-royal.site` zone에 Cloudflare Web Analytics 자동 삽입이 켜져 있어 HTML에 그 스크립트가 붙지만, CSP(`script-src 'self'`)가 막아 실행되지 않는다(2026-10-15 확인). 켜서 쓰려면 CSP와 함께 처리방침의 분석 도구 문구를 고쳐야 한다(`docs/DEPLOYMENT.md` 4절).

## 2. 보존과 삭제

| 데이터 | 보관 | 삭제 방법 | 구현 |
|---|---|---|---|
| 회원 정보 | 탈퇴까지 | 탈퇴 즉시 이메일·닉네임을 무작위 값으로 바꾸고 생년월일·프로필·비밀번호 해시를 지움 | `routes/auth.ts` `/me/delete` |
| 로그인 세션 | 로그아웃 즉시 삭제. 자동 로그인 30일, 아니면 1일 미사용 시 만료 | 만료 1일 뒤 정리 크론이 삭제 | `lib/housekeeping.ts` |
| 인증번호, 재설정 링크, 요청 횟수 기록 | 만료(집계 창 종료)까지 | 만료 1일 뒤 정리 크론이 삭제. 인증번호는 새 요청 때도 지운다 | `lib/housekeeping.ts`, `routes/auth.ts` |
| 1:1 대화 | **기한 없음**(검토 필요) | 두 사람 중 한 명이 탈퇴하면 양쪽 메시지 전부 삭제 | `/me/delete` |
| 친구·요청·차단 | 해제할 때까지 | 해제·탈퇴 시 삭제 | `routes/social.ts`, `/me/delete` |
| 운영자 쪽지, 아카데미 진도·배지 | 탈퇴까지 | 탈퇴 시 삭제 | `/me/delete` |
| 관리자 내부 메모 | 탈퇴까지(작성자나 슈퍼관리자가 먼저 지울 수 있음) | 탈퇴 시 그 회원에 대한 메모 삭제. 삭제 감사 기록에는 본문이 없음 | `/me/delete`, `routes/admin.ts` |
| 테이블 채팅 | 테이블별 최근 50줄 | 테이블이 닫히고 24시간(`PLAYER_REPORT_WINDOW_MS`) 뒤 삭제 | `apps/game-worker/src/room.ts` 알람 |
| 게시글·댓글 | **기한 없음**(검토 필요) | 회원 삭제는 숨김만. 탈퇴 후 남은 글은 "탈퇴한 회원"으로 표시 | `routes/board.ts` |
| 칩 원장·핸드·좌석 기록 | **기한 없음**(검토 필요) | 탈퇴 후에도 회원 ID로 보관 | — |
| 신고·증거 | **기한 없음**(검토 필요) | 4절 | — |
| 관리자 감사 기록 | **기한 없음**(검토 필요) | 5절 | — |
| 운영 지표(`ops_metrics`, 개인정보 없음) | 14일 | 정리 크론이 14일 지난 분 단위 행을 삭제 | `lib/housekeeping.ts` |

### 정리 크론

- `apps/api/wrangler.jsonc`의 `triggers.crons = ["30 18 * * *"]`(매일 18:30 UTC = 03:30 KST). 최상위 설정이라 `env.production`에도 그대로 적용된다.
- `scheduled` 핸들러(`apps/api/src/index.ts`)가 `housekeeping()`을 한 번의 D1 batch로 실행하고, 지운 행 수를 로그(`housekeeping {...}`)로 남긴다.
- 모든 삭제 조건은 "만료(집계 시작)가 지금보다 24시간 이상 지난 행"이다. 살아 있는 세션, 아직 쓸 수 있는 인증번호·링크, 진행 중인 집계 창은 지우지 않는다. 그래서 실제 삭제 시점은 만료 후 1~2일 사이다.
- **배포하면 운영 D1에서 바로 동작한다.** 첫 실행 때 그동안 쌓인 만료 세션(IP·User-Agent 포함)과 인증·재설정·레이트 리밋 행이 한꺼번에 지워진다. 멈추려면 `triggers`를 지우고 다시 배포한다.
- 로컬 `wrangler dev`는 크론을 스스로 실행하지 않는다. `GET http://localhost:8787/cdn-cgi/local/scheduled`로 한 번 실행할 수 있다(통합 테스트가 이 경로를 쓴다).

## 3. 회원 탈퇴

`POST /api/auth/me/delete`(비밀번호 확인, 착석 중이면 409)는 한 번의 D1 batch로 다음을 처리한다.

- **바꾸거나 지움**: 이메일 → `deleted-<id>@deleted.invalid`, 닉네임 → `deleted-<id>`(24자), 프로필 이미지·생년월일·최근 로그인 시각 → `NULL`, 비밀번호 해시 → `disabled`, 상태 → `deleted`.
- **삭제**: 세션, 친구·요청(양방향), 차단(양방향), 보내거나 받은 1:1 메시지 전부, 운영자 쪽지함, 아카데미 진도·배지, 비밀번호 재설정 링크, 그 회원에 대한 관리자 내부 메모.
- **보관**(회원 ID만 남음): 칩 원장, 핸드·좌석 기록, 게시글·댓글, 회원이 했거나 받은 신고와 증거, 관리자 감사 기록.

남기는 이유와 그에 따른 화면 처리:

- 칩 원장·핸드: 전체 칩 보존 검증(정합성 검사)과 다른 회원의 분쟁 대응에 필요하다. 다른 회원의 핸드 기록에는 `deleted-…` 이름이 그대로 보인다(바꾸지 않음).
- 게시글·댓글: 다른 회원의 댓글·답글 흐름이 끊기지 않게 남긴다. API가 작성자를 `{withdrawn: true, nickname: ''}`로 내려보내고, 사용자 화면은 "탈퇴한 회원", 관리자 화면은 "탈퇴한 회원 (ID 앞 8자)"로 표시한다. 답글 대상 이름도 비운다.
- 신고: 1:1 메시지를 지워도 신고 증거에는 복사본이 남는다(`reports.context`). 관리자 신고 목록은 `direct_messages`를 조회하지 않으므로 메시지 삭제와 무관하게 동작한다. 탈퇴한 회원이 보낸 메시지는 새로 신고할 수 없다(404).

탈퇴 확인 문구(`me.deleteConfirm`)는 삭제되는 것과 남는 것을 알린다.

## 4. 신고 증거

- 증거는 신고 시점에 **서버가** 원본에서 복사한다. 신고자가 보낸 본문은 증거로 쓰지 않는다(`routes/reports.ts`).
  - 게시글: 제목, 본문 앞 2,000자 / 댓글: 본문
  - 1:1 메시지: 신고한 메시지와 같은 보낸 사람의 직전 메시지 최대 5개. 대화 당사자만 신고할 수 있다.
  - 플레이어: 테이블 이름, 함께한 핸드 번호, 게임 서버에 남은 채팅 중 대상의 최근 10줄(신고자가 함께 있던 시간대로 한정). 마지막으로 함께 앉은 뒤 24시간 안에만 신고할 수 있다.
- 처리(`resolved`/`dismissed`) 후에도 지우지 않는다. 재발 판단(관리자 화면의 "이전 신고 수")과 이의 대응에 쓰인다.
- **보관 기한은 정하지 않았다(법무 검토 필요).** 기한이 정해지면 `lib/housekeeping.ts`에 처리 후 N일이 지난 신고의 `context`·`detail`을 비우는 문장을 추가하는 방식이 가장 작다(`UPDATE reports SET context = NULL, detail = NULL WHERE status != 'open' AND handled_at < ?`). 신고 행 자체는 이전 신고 수 계산에 쓰이므로 남기는 편이 낫다.

## 5. 운영자 접근과 감사 기록

- 관리자 화면은 `admin`·`super_admin`만 쓸 수 있다. 관리자 세션은 30분 미사용 또는 8시간 경과 시 만료, 민감 작업은 5분 안의 비밀번호 재확인이 필요하다(`docs/ADMIN_SECURITY.md`).
- 1:1 대화를 보는 관리자 API는 없다. 관리자가 볼 수 있는 1:1 메시지는 신고 증거뿐이다.
- 조회도 기록한다. 이번 작업에서 추가한 감사 조치:

| 조치 | 언제 | 상세 |
|---|---|---|
| `user.list` | 회원 목록·검색 | `{q, status, locale, role, online, sort, offset, count}` |
| `user.view` | 회원 상세(생년월일·동의 기록 포함) | 대상 회원 |
| `report.view` | 신고 목록(증거 포함) | `{status, userId, reporterId, count, dm: [1:1 메시지 신고 ID]}` |
| `note.create`·`note.delete` | 관리자 메모 작성·삭제 | 메모 ID와 길이, 삭제는 작성자·작성 시각. 본문은 넣지 않음 |

  기존에 기록하던 조치(내보내기, 칩 조정, 정지, 핸드 전체 열람, 신고 처리 등)는 `docs/ADMIN_SECURITY.md`에 있다. 조회 기록 때문에 감사 로그 양이 늘어난다(관리자 화면을 열 때마다 1행).
- Cloudflare 계정 관리자는 D1에 직접 접근할 수 있고, 이 접근은 감사 로그에 남지 않는다. 처리방침 6항에 그대로 적었다. 계정 접근 통제(2단계 인증, 토큰 범위·교체)는 운영자가 관리한다.
- 감사 로그 보관 기간과 점검 주기는 정하지 않았다(검토 필요).
- 관리자 내부 메모: 조치 근거와 주의할 점을 운영자끼리 넘겨주는 용도로만 쓴다. 모든 관리자가 읽을 수 있으므로 연락처·실명·계좌 같은 개인정보를 적지 않는다. 서버가 이메일, 전화번호(`0`으로 시작하는 국내 번호, `+82` 같은 국가번호 형식), 주민등록번호, 카드 번호 형태를 400 `note_pii`로 거절하지만 패턴 검사라 다른 형태(주소, 실명 등)는 막지 못한다. 메모를 지울 수 있는 사람은 작성자와 슈퍼관리자다.
- 최근 로그인 시각(`users.last_login_at`): 회원 로그인 세션을 만들 때(가입·로그인) 세션 저장과 같은 batch에서 갱신한다. 관리자 콘솔 로그인은 바꾸지 않는다. 회원 목록·상세의 마지막 로그인 표시와 정렬에 쓴다. 이미 수집하던 `sessions` 생성 시각과 같은 정보이며, 세션은 만료 후 지워지지만 이 값은 탈퇴 때까지 남는다.

## 6. 최소 수집

- 생년월일: 만 14세 확인과 연령대 통계에만 쓴다. 생년월일 전체가 필요한지는 검토 필요.
- IP·User-Agent: 세션 보안, 요청 횟수 제한, 감사 기록에만 쓰고 만료 후 정리한다. 감사 로그의 IP는 남는다.
- 1:1 대화: 친구끼리만, 본문 500자. 운영자는 신고된 것만 본다.
- 아카데미 지표(`academy_stats`)는 회원 ID 없이 집계한다. 아카데미 이벤트의 레이트 리밋 키에만 회원 ID가 잠시 남고 정리 크론이 지운다.

## 7. 운영 메일(Resend)

- 발신 도메인 `jc-royal.site`가 Resend에서 인증되어, 운영 `MAIL_FROM`을 `JC ROYAL <noreply@jc-royal.site>`로 넣었다(`apps/api/wrangler.jsonc` `env.production.vars`). 이 설정을 배포하면 운영 메일이 켜진다.
- 켜지면 가입에 이메일 인증번호가 필요하고(`/api/auth/signup-options`의 `emailVerification: true`), 비밀번호 재설정 메일이 회원 이메일로 간다(`docs/DEPLOYMENT.md` 2절). 메일에는 이메일 주소, 인증번호 또는 재설정 링크, 닉네임(재설정 메일)이 담겨 Resend로 전달된다.
- 처리방침의 위탁 항목에는 Resend가 이미 있다. 이 배포부터 위탁이 실제로 일어나므로, 공개 전에 처리방침의 위탁·국외 이전 문구(9절 4번)를 다시 확인한다.
- 배포 전까지(그리고 `MAIL_FROM`이나 `RESEND_API_KEY`가 빠지면) 운영 가입은 이메일 인증 없이 진행되고, 비밀번호 재설정은 관리자가 링크를 발급한다.

## 8. 운영자가 승인 후 실행할 일(아직 실행하지 않음)

이번 변경 전에 탈퇴한 회원의 1:1 메시지·쪽지·아카데미 기록은 운영 DB에 남아 있을 수 있다. 새 탈퇴 처리와 맞추려면 아래 SQL을 실행한다. **운영 데이터 삭제이므로 오너 승인 후, 백업을 먼저 만든 뒤 실행한다.** 이 작업에서는 실행하지 않았다.

```sh
# 1) 백업(또는 D1 Time Travel 북마크 확인: wrangler d1 time-travel info jc-royal-db-prod)
pnpm exec wrangler d1 export jc-royal-db-prod --remote --env production -c apps/api/wrangler.jsonc --output backup.sql
# 2) 미리보기
pnpm exec wrangler d1 execute jc-royal-db-prod --remote --env production -c apps/api/wrangler.jsonc --command \
  "SELECT (SELECT COUNT(*) FROM direct_messages WHERE sender_id IN (SELECT id FROM users WHERE status='deleted') OR recipient_id IN (SELECT id FROM users WHERE status='deleted')) AS dms,
          (SELECT COUNT(*) FROM messages WHERE user_id IN (SELECT id FROM users WHERE status='deleted')) AS inbox"
```

```sql
-- 3) 삭제
DELETE FROM direct_messages WHERE sender_id IN (SELECT id FROM users WHERE status = 'deleted') OR recipient_id IN (SELECT id FROM users WHERE status = 'deleted');
DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE status = 'deleted');
DELETE FROM academy_progress WHERE user_id IN (SELECT id FROM users WHERE status = 'deleted');
DELETE FROM user_badges WHERE user_id IN (SELECT id FROM users WHERE status = 'deleted');
DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE status = 'deleted');
```

알아 둘 부작용:

- 관리자 "쪽지 발송 이력"의 수신자 수는 `messages` 행을 묶어 세므로, 탈퇴 회원의 쪽지를 지우면 그만큼 줄어든다. 발송 당시 수신자 수는 감사 로그 `message.send`의 `recipients`에 남아 있다.
- 기존 회원의 동의 버전은 `2026-10-14`로 남는다. 다시 동의를 받을지는 검토 필요(9절).

## 9. 법무 검토 필요 항목

개발자가 정하지 않고 남겨 둔 항목이다. 화면에는 "검토 필요"로 표시된다.

1. **보관 기한**: 1:1 대화, 회원이 지운 게시글·댓글, 칩 원장·핸드 기록, 신고 기록·증거, 관리자 감사 기록(「개인정보의 안전성 확보조치 기준」의 접속기록 보관 기간 1년/2년 해당 여부 포함).
2. **탈퇴 후 가명 기록**: 게시글·댓글을 남길지 일정 기간 뒤 지울지, 원장·핸드·신고를 회원 ID로 남기는 근거와 범위.
3. **개인정보 보호책임자**와 열람·정정·삭제 요청 창구, 처리 기한, 대리인 요청 절차.
4. **국외 이전 고지**: Cloudflare·Resend의 이전 국가, 일시·방법, 연락처, 보유 기간. 법령에 따른 제공(수사기관 요청 등) 예외 문구.
5. **동의 구조**: 서비스 제공에 꼭 필요한 처리를 동의로 받을지 계약 이행 근거(개인정보 보호법 제15조 제1항 제4호)로 고지할지, 이전 버전에 동의한 기존 회원에게 다시 동의를 받을지.
6. **이용약관 동의 방식**: 가입 화면에 약관 필수 체크를 추가할지. 현재는 만 14세 확인과 개인정보 동의만 받는다(이번 작업에서 바꾸지 않음).
7. **게임물 등급과 이용 연령**: 포커형 게임(현금 가치 없는 가상 칩)의 등급 분류 필요 여부와 최소 연령(현재 `MIN_SIGNUP_AGE` 14세).
8. **통신비밀보호법** 등 접속 기록 보관 의무가 적용되는지.
9. **생년월일 전체 수집**이 필요한지(출생 연도·월만으로 충분한지).
10. **이용약관**: 책임 제한·면책, 제재 단계와 이의 절차, 약관·방침 변경 고지 기간, 준거법·관할 법원, 시행일.
11. **인프라 직접 접근 통제**: Cloudflare 계정 관리자의 D1 직접 접근을 어떻게 통제·기록할지.
12. **관리자 내부 메모 고지**: 운영자가 회원에 대해 남기는 메모(탈퇴 시 삭제)를 처리방침에 적을지. 지금 처리방침은 "로그인·접속 기록"만 적고 있고 메모는 언급하지 않는다(이번 작업에서 처리방침 문구와 버전은 바꾸지 않음).
