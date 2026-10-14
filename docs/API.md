# REST API 명세

공통 사항:

- **경로와 형식**: 모든 경로는 `/api` 아래에 있고, 요청·응답은 JSON입니다.
- **오류 응답**: `{ "error": { "code", "message", "details?" } }` 형식입니다.
- **인증**: 사용자 사이트는 `jc_sid` 쿠키, 관리자 콘솔은 `jc_asid` 쿠키를 씁니다. 둘 다 HttpOnly입니다.
- **CSRF 방어**: 상태를 바꾸는 요청은 허용된 `Origin`과 `Content-Type: application/json`이 있어야 합니다.
- **입력 검증**: zod 스키마는 `packages/types/src/api.ts`와 `community.ts`에 있습니다.

## 인증 `/api/auth`

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/signup-options` | `{emailVerification, privacyNoticeVersion}` — 가입 화면이 이메일 인증 단계를 보일지 결정 |
| POST | `/email-verification/request` | `{email,locale?}` → `{ok, expiresInMinutes:10, resendAfterSeconds:60}`. 6자리 인증번호 메일(요청 `locale`, 기본 ko). 409 `email_taken`, 429 `resend_too_soon`(`details.retryAfterSeconds`)·IP당 20회/시간·이메일당 5회/시간, 502 `mail_failed`, 400 `verification_off`. 개발 환경에서만 `devCode` 반환 |
| POST | `/email-verification/confirm` | `{email,code}` → `{verificationToken, expiresInMinutes:30}`. 400 `invalid_code`(`details.attemptsLeft`), `too_many_attempts`(5회 오입력 시 새 인증번호 필요), `code_expired` |
| POST | `/register` | `{email,password,nickname,birthDate(YYYY-MM-DD),locale?,agreements:{age14:true,privacy:true},emailVerificationToken?}` → 201 MeDto + 세션. 비밀번호는 8자 이상 + 영문(대·소문자 무관)·숫자·특수문자. 만 14세 미만 400 `underage`. 이메일 인증이 켜져 있으면 해당 이메일의 유효한 `verificationToken` 필수(없거나 다르면 400 `email_not_verified`, 1회용). 생년월일·인증 시각·동의 버전/시각 저장, 가입 칩 지급(원장), 계정 언어로 환영 쪽지. 409 `email_taken`/`nickname_taken` |
| POST | `/login` | `{email,password,remember?}` → MeDto + 세션. `remember:true`(자동 로그인)면 30일 쿠키와 30일 슬라이딩 만료, 기본값 `false`면 브라우저 세션 쿠키와 1일 슬라이딩 만료. 401 `invalid_credentials`, 403 `suspended`, 429 |
| POST | `/logout` | 세션 폐기 |
| GET | `/me` | 현재 사용자(MeDto). 세션 만료를 연장하고 쿠키를 다시 발급 |
| PATCH | `/me` | `{nickname?, avatarUrl?(https), locale?}` |
| GET | `/nickname-available?nickname=` | `{available}` |
| POST | `/me/password` | `{currentPassword,newPassword}`(가입과 같은 비밀번호 규칙) → 다른 기기 세션 폐기 |
| GET | `/me/sessions` · DELETE `/me/sessions/:id` | 로그인 세션 목록과 폐기 |
| POST | `/me/delete` | `{password}` → 탈퇴(착석 중이면 409 `seated`) |
| POST | `/password-reset/request` | `{email}` → 항상 200(IP당 5회, 이메일당 3회/시간 초과 시 429). 메일 설정 시 재설정 메일 발송. 개발 환경에서만 `devToken` 반환 |
| POST | `/password-reset/confirm` | `{token,newPassword}`(가입과 같은 비밀번호 규칙) → 1회용. 모든 세션 폐기 |

이메일 인증은 `MAIL_FROM`과 `RESEND_API_KEY`가 설정되면 켜집니다. 운영에서 메일이 꺼져 있으면 인증 단계 없이 가입되고 `emailVerifiedAt`은 비어 있습니다. 개발·테스트 환경에서는 항상 켜져 있고 인증번호는 `devCode`로 돌려줍니다.

## 내 정보 `/api/me`

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/ledger?limit&before` | 칩 변동 내역 |
| GET | `/stats` | 플레이·승리 핸드, 승률, 총 획득, 순손익, 최대 팟, 최고 핸드 |
| GET | `/hands?limit&before` | 최근 핸드 |
| GET | `/hands/:id` | 핸드 상세(본인 카드와 쇼다운 카드만) |
| GET | `/posts` · `/comments` | 내가 쓴 글과 댓글 |

## 테이블 `/api/tables`, WebSocket

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/tables` | 로비(종료된 테이블 제외, 실시간 착석·진행·대기·관전 수, `beginner` 입문 테이블 여부) |
| GET | `/api/tables/:id` | 단일 테이블 |
| GET(upgrade) | `/ws/tables/:id?code=` | WebSocket. 세션 쿠키와 Origin 필수. 비공개 테이블은 참가 코드가 있어야 착석 가능 → `docs/WEBSOCKET_PROTOCOL.md` |

로비 응답의 각 테이블에는 `roomType`(`official`/`member`)과 `host`(회원 방이면 `{id,nickname}`, 공식 테이블이면 `null`)가 있습니다. 공식 테이블이 먼저, 회원 방이 뒤에 나옵니다.

## 회원 방 `/api/rooms` (로그인 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/rooms` | `{name(2–30자), maxSeats(2/6/9), bigBlind(10/20/50/100/200), minBuyIn, maxBuyIn, allowSpectators?, isPrivate?, joinCode?(4–32자)}` → 201 `{id}`. 스몰 블라인드는 BB의 절반, 바이인은 10–200 BB 범위(`minBuyIn ≤ maxBuyIn`), 비공개면 참가 코드 필수(400). 열린 방은 회원당 2개까지(409 `room_limit`, 개수 확인과 생성이 한 문장), 생성은 회원당 시간당 5회(429) |
| PATCH | `/api/rooms/:id` | 방장만. `{name?, allowSpectators?, isPrivate?, joinCode?}` — 블라인드·바이인 필드는 무시됩니다. 빈 `joinCode`는 코드 삭제(비공개면 400). 다른 회원 403, 공식·종료·없는 방 404 |
| POST | `/api/rooms/:id/close` | 방장만. 관리자 종료와 같은 절차: 새 핸드 금지 → 진행 중 핸드 종료 → 착석자 전원 원장 `cash_out` → 종료. `{ok, closed}`(`closed:false`면 핸드가 끝난 뒤 닫힘) |

방장 권한은 이름·관전 허용·참가 코드 변경, 초대 링크 공유, 방 종료뿐입니다. 칩 지급, 카드·결과 조작, 다른 사람의 카드 보기는 없습니다. 방장이 나가도 방은 유지되고(방장 위임 없음), 아무도 앉아 있지 않은 채 10분이 지나면 저절로 닫힙니다(`MEMBER_IDLE_CLOSE_MS`). 공식 테이블은 지금처럼 관리자만 만듭니다. 관리자 테이블 목록에는 방 유형과 방장 닉네임(`hostNickname`)이 함께 나옵니다.

## 아카데미 `/api/academy`

학습 진도·배지·익명 통계. 지갑·원장·핸드 기록에는 접근하지 않는다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/progress` | `{data, version, updatedAt, badges}`. 저장된 진도가 없으면 `data: null` |
| PUT | `/progress` | `{version, updatedAt, data(≤32KB)}`. `updatedAt`이 더 새로울 때만 덮어씀(클라이언트가 로컬·서버 진도를 병합한 뒤 전송). 진도에서 계산한 배지를 1회만 부여(`INSERT OR IGNORE`). 분당 60회 |
| GET | `/badges` | 내 배지 |
| POST | `/events` | `{events: [{kind:'question', id, correct} \| {kind:'lesson'\|'scenario', id, phase:'start'\|'complete'}]}`(최대 50). 사용자 ID 없이 항목별 카운터만 증가. 분당 30회 |

## 게시판 `/api/board`

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/posts?page&q` | `{notices(1쪽만), posts, total, page, pageSize}` |
| GET | `/posts/:id` | 본문, 첨부 핸드 리뷰(작성자 시점), 댓글과 답글 |
| POST | `/posts` | `{title(2-100), body(≤10000), handIds(≤3, 본인이 플레이한 종료 핸드)}`, 시간당 10회 |
| PATCH / DELETE | `/posts/:id` | 작성자만 가능(공지는 회원이 수정 불가) |
| POST | `/posts/:id/comments` | `{body(≤1000), parentId?}`. 답글의 답글은 같은 묶음에 `@닉네임`으로 붙음 |
| PATCH / DELETE | `/comments/:id` | 작성자만 가능. 답글이 있는 댓글을 삭제하면 자리표시로 남음 |

## 쪽지 `/api/messages` (수신 전용)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 받은 쪽지(최근 100개) |
| GET | `/unread-count` | `{unread}` |
| POST | `/:id/read` · `/read-all` | 읽음 처리 |
| DELETE | `/:id` | 삭제(본인 것만) |

## 관리자 `/api/admin` (관리자 출처 + `jc_asid`)

인증:

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/auth/bootstrap` | `{token,email}` — 최초 슈퍼관리자 1회만(배포 시크릿 `ADMIN_BOOTSTRAP_TOKEN`) |
| POST | `/auth/login` · `/auth/logout` | 관리자 세션 |
| GET | `/auth/me` | 관리자 정보, 재확인 유효 시각 |
| POST | `/auth/reauth` | `{password}` → 5분간 민감 작업 허용 |

관리(🔒 = 재확인 필요):

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/dashboard` | 회원 수, 접속자, 테이블·진행 게임, WS 연결, 핸드 수, 서버 상태, 문제 상황 |
| GET | `/users?q&status&locale&limit(≤200)` · `/users/:id` | 검색(계정 언어 `locale` 포함·필터)과 상세(언어, 생년월일, 이메일 인증 시각, 개인정보 동의 버전·시각, 원장, 착석, 원장 정합성) |
| POST | `/users/export` 🔒 | `{userIds(1-1000)}` → `{filename, count, csv}`. 열: id, email, nickname, language, role, status, balance, joined_at_utc, birth_date, email_verified_at_utc, privacy_notice_version, privacy_agreed_at_utc, suspended_reason. `=`·`+`·`-`·`@`로 시작하는 칸은 `'`를 붙여 수식 실행 방지. 감사 로그 `user.export`(대상 ID, 건수) |
| POST | `/users/:id/suspend` 🔒 · `/unsuspend` 🔒 | 정지·해제(세션 폐기, 회원 계정 언어로 제재 쪽지 자동 발송) |
| POST | `/users/:id/role` 🔒 | 슈퍼관리자만. 대상의 관리자 세션 즉시 폐기 |
| POST | `/users/:id/chips` 🔒 | `{amount(±), memo, idempotencyKey}` — 음수 잔액 불가, 회원 계정 언어로 쪽지 자동 발송 |
| POST | `/users/:id/reset-link` 🔒 | 30분 1회용 링크 → `{path, url, expiresInMinutes, locale, mailed, message:{subject,text}}`. 회원 계정 언어의 안내문을 만들고, 메일이 설정돼 있으면 발송(`mailed`). 자기 계정 400, 관리자 대상은 슈퍼관리자만(403) |
| GET / POST | `/tables` | 목록과 생성(2·6·9석, 최소 바이인 ≥ 10BB) |
| GET / PATCH | `/tables/:id` | 실시간 상태(홀카드 없음), 수정(블라인드는 다음 핸드부터) |
| POST | `/tables/:id/close` 🔒 | 진행 중 핸드가 끝나면 전원 환급 후 종료 |
| GET | `/hands?tableId&userId` | 종료된 핸드 목록 |
| GET | `/hands/:id` 🔒 | 종료 핸드 전체(모든 홀카드, gzip 엔진 로그), 열람은 감사 로그에 기록 |
| GET | `/ledger?userId&type` · `/audit` | 원장과 관리 이력 |
| POST | `/reconcile/run` · GET `/reconcile` · POST `/reconcile/:id/resolve` 🔒 | 정합성 검사, 목록, 해결 처리 |
| GET / POST | `/board/posts` · `/board/posts/:id` · `/board/notices` · PATCH `/board/notices/:id` | 게시판 관리와 공지 |
| POST | `/board/posts/:id/status` · `/board/comments/:id/status` | `visible`/`hidden`/`deleted` |
| POST / GET | `/messages` | `{userIds(1-500), category, title, body}` 발송과 발송 이력 |

아카데미 지표(관리자): `GET /api/admin/academy/stats` → `[{kind, itemId, starts, completes, correct, wrong}]`(익명 집계). 테이블 생성·수정 본문에 `beginner`(입문 테이블) 추가.
