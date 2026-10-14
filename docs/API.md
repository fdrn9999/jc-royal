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
| POST | `/me/delete` | `{password}` → 탈퇴(착석 중이면 409 `seated`). 계정 정보 비식별화, 세션·친구·차단·1:1 메시지(양쪽)·쪽지·아카데미 진도·재설정 링크 삭제. 원장·핸드·게시글·신고는 회원 ID로 남는다(`docs/PRIVACY_OPERATIONS.md` 3절) |
| POST | `/password-reset/request` | `{email}` → 항상 200(IP당 5회, 이메일당 3회/시간 초과 시 429). 메일 설정 시 재설정 메일 발송. 개발 환경에서만 `devToken` 반환 |
| POST | `/password-reset/confirm` | `{token,newPassword}`(가입과 같은 비밀번호 규칙) → 1회용. 모든 세션 폐기 |

이메일 인증은 `MAIL_FROM`과 `RESEND_API_KEY`가 설정되면 켜집니다. 운영에서 메일이 꺼져 있으면 인증 단계 없이 가입되고 `emailVerifiedAt`은 비어 있습니다. 개발·테스트 환경에서는 항상 켜져 있고 인증번호는 `devCode`로 돌려줍니다.

## 내 정보 `/api/me`

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/ledger?limit&before` | 칩 변동 내역 |
| GET | `/stats` | 본인 것만. 카드를 받은 핸드만 세고 관전은 빠진다. 플레이 핸드, 승리 핸드(`pot_won > 0`: 팟 일부라도 획득, 스플릿 포함, 콜 안 된 베팅만 돌려받은 핸드 제외)와 승률, 총 획득(`pot_won` 합), 순손익, 참여한 최대·평균 팟(`largestPot`, `avgPot`: 내 칩이 들어간 핸드에서 실제로 다툰 팟, 콜 안 된 베팅 반환분 제외), 한 핸드 최대 순이익(`biggestWin`), 최고 핸드, `vpip`·`pfr`(분모: 행동 기록을 읽은 핸드), `raiseShare`(PFR ÷ VPIP 핸드), `wtsd`(쇼다운 ÷ 플랍을 본 핸드), `wsd`(팟 획득 ÷ 쇼다운), `positions`(EP·MP·CO·BTN·SB·BB 순서, 핸드·VPIP·PFR·손익). 비율은 `{ n, of }`이며 `of = 0`이면 화면에 —. 계산 정의는 `packages/db/src/handStats.ts` |
| GET | `/stats/trend?days=7\|30\|90&tz=<분>` | 기간별 일 순손익. `tz`는 UTC 기준 동쪽으로의 분(−720~840, 한국 540). 그 시간대 날짜로 나눈 `{ day: 'YYYY-MM-DD', hands, net }`를 오래된 순으로 주고, 핸드가 없는 날은 뺀다. 잘못된 값은 400 `bad_request` |
| GET | `/hands?limit&before` | 최근 핸드 |
| GET | `/hands/:id` | 핸드 상세(본인 카드와 쇼다운 카드만) |
| GET | `/posts` · `/comments` | 내가 쓴 글과 댓글 |

## 테이블 `/api/tables`, WebSocket

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/tables` | 로비(종료된 테이블 제외, 실시간 착석·진행·대기·관전 수, `beginner` 입문 테이블 여부) |
| GET | `/api/tables/:id` | 단일 테이블 |
| POST | `/api/tables/quick` | 빠른 참가 `{maxSeats?: 2\|6\|9, bigBlind?, exclude?: string[]}` → `{table, seatIndex}`. 칩은 쓰지 않음(바이인은 테이블에서 착석 요청으로) |
| GET(upgrade) | `/ws/tables/:id?code=` | WebSocket. 세션 쿠키와 Origin 필수. 비공개 테이블은 참가 코드가 있어야 착석 가능 → `docs/WEBSOCKET_PROTOCOL.md` |

로비 응답의 각 테이블에는 `roomType`(`official`/`member`)과 `host`(회원 방이면 `{id,nickname}`, 공식 테이블이면 `null`)가 있습니다. 공식 테이블이 먼저, 회원 방이 뒤에 나옵니다.

빠른 참가는 열린 공개 테이블(비공개·입장 제한 제외, 이미 앉아 있는 테이블과 `exclude` 제외) 가운데 `maxSeats`·`bigBlind`가 일치하는 것만 봅니다. 순서는 로비 수치상 빈자리가 있어 보이는 테이블 → 입문자(완료 핸드 50 미만)에게는 입문 테이블 먼저, 그 밖의 플레이어에게는 입문 테이블을 나중에 → 착석 인원이 많은 순 → 낮은 블라인드 → 공식 테이블 → id 순입니다. 로비 수치는 늦을 수 있으므로 상위 5개 테이블에 차례로 테이블 룸(Durable Object)의 착석 검사(`sit`과 같은 검사, 지갑 제외)를 물어 처음 통과한 테이블을 돌려줍니다. 자리를 잡아 두지는 않으므로 실제 착석은 `sit`이 다시 검사합니다. 실패 코드는 `404 no_table`(조건에 맞는 테이블 없음), `409 insufficient_balance`(`details: {minBuyIn, balance}`, 맞는 테이블 중 가장 낮은 최소 바이인도 지갑보다 큼), `409 tables_full`(검사한 테이블이 모두 찼거나 대기 명단 우선)입니다.

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
| PUT | `/progress` | `{version, updatedAt, data(≤32KB)}`. `updatedAt`이 더 새로울 때만 덮어씀(클라이언트가 로컬·서버 진도를 병합한 뒤 전송). 진도 중 아래 타당성 검사를 통과한 부분으로만 배지를 계산해 1회만 부여(`INSERT OR IGNORE`, 지급 시각은 처음 지급될 때 고정). 검사에 걸린 진도도 그대로 저장되며 배지만 주지 않음. 분당 60회 |
| GET | `/badges` | 내 배지 |
| POST | `/events` | `{events: [{kind:'question', id, correct} \| {kind:'lesson'\|'scenario', id, phase:'start'\|'complete'}]}`(최대 50). 사용자 ID 없이 항목별 카운터만 증가. 분당 30회 |

**배지의 성격:** 배지는 본인 학습 기록으로 받는 **장식용 표시**이며 공식 수료 증명이 아니다. 레슨·퀴즈는 브라우저에서 진행되고 서버가 채점하지 않으므로, 서버는 공부했다는 사실을 증명할 수 없다. 배지는 본인 화면(아카데미·진행 현황·마이페이지)에만 보이고, 다른 사용자·관리자 화면이나 게임 로직, 칩·원장에는 쓰이지 않는다. 화면에도 이 점을 안내한다.

**타당성 검사(`plausibleBadges`, `packages/types/src/academy.ts`):** 실제 앱이 만들 수 없는 진도는 배지에 세지 않는다. 시계 오차는 24시간(`BADGE_CLOCK_SKEW_MS`)까지 허용한다.
- 레슨 완료: `startedAt`·`completedAt`이 정수 ms이고 가입 시각~서버 현재 시각 사이, 시작 ≤ 완료, `step`이 그 레슨의 마지막 단계(카드 3, 족보 4, 홀덤 4, 액션 3, 연습 0) 이상.
- 연습 시나리오: 완료 시각이 같은 범위의 정수 ms.
- 복습 세트(`review.sessions`): 한 세트는 8문제를 모두 맞혀야 끝나므로 `quiz.correct + quiz.wrong ≥ sessions × 8`일 때만 인정.
- 모든 규칙은 기기 간 병합(가장 이른 시각, 가장 큰 단계·카운터) 뒤에도 성립한다. 서버 시각보다 24시간 넘게 앞선 시각은 그 시각이 지난 뒤의 다음 동기화에서 인정된다.
- 이미 지급된 배지는 회수하지 않으며(검사 도입 전 지급분 포함) DB 스키마 변경은 없다.

## 게시판 `/api/board`

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/posts?page&q` | `{notices(1쪽만), posts, total, page, pageSize}` |
| GET | `/posts/:id` | 본문, 첨부 핸드 리뷰(작성자 시점), 댓글과 답글 |
| POST | `/posts` | `{title(2-100), body(≤10000), handIds(≤3, 본인이 플레이한 종료 핸드)}`, 시간당 10회 |
| PATCH / DELETE | `/posts/:id` | 작성자만 가능(공지는 회원이 수정 불가) |
| POST | `/posts/:id/comments` | `{body(≤1000), parentId?}`. 답글의 답글은 같은 묶음에 `@닉네임`으로 붙음 |
| PATCH / DELETE | `/comments/:id` | 작성자만 가능. 답글이 있는 댓글을 삭제하면 자리표시로 남음 |

탈퇴한 회원의 글·댓글은 작성자가 `{id, nickname: '', avatarUrl: null, isAdmin: false, withdrawn: true}`로 오고 화면은 "탈퇴한 회원"으로 표시한다. 탈퇴한 회원에게 단 답글의 `replyTo`는 `null`.

## 쪽지 `/api/messages` (수신 전용)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 받은 쪽지(최근 100개) |
| GET | `/unread-count` | `{unread, dmUnread, friendRequests}`(상단 배지 한 번에) |
| POST | `/:id/read` · `/read-all` | 읽음 처리 |
| DELETE | `/:id` | 삭제(본인 것만) |

## 1:1 대화 `/api/dm` (로그인 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/:userId` | ConversationDto `{user, isFriend, blocked, messages, hasMore, peerRead}`. 기본은 최신 50개(오래된 것부터). `?afterSeq=n`은 n보다 새 메시지(새 것 폴링, `hasMore`면 마지막 seq에서 다시 요청), `?beforeSeq=n`은 더 오래된 페이지(`hasMore`면 더 있음). `peerRead {seq, at}`은 상대가 내 메시지를 어디까지 읽었는지(새 메시지가 없는 폴링에도 실림). 예전 화면용 `?after=<ms>`, `?before=<ms>&beforeId=`도 계속 동작 |
| POST | `/:userId` | `{text(1–500자)}` → 201 DirectMessageDto(`seq` 포함). 친구만, 차단 관계면 403 `not_friends`. 분당 30회 |
| POST | `/:userId/read` | `{upToSeq?}` — 화면에 보인 마지막 seq까지 읽음 처리(그 뒤에 도착한 메시지는 안 읽음으로 남음). 본문이 없으면 전부 |

메시지 순서는 대화마다 1, 2, 3… 으로 매기는 `seq`입니다. 저장하는 문장 안에서 `MAX(seq)+1`로 정하고 `(pair_key, seq)` 고유 인덱스로 막아, 서버 시계(`at`)가 같은 밀리초이거나 거꾸로 가도 순서와 커서가 흔들리지 않습니다. 기존 메시지는 마이그레이션 0009가 (시간, id) 순으로 번호를 매깁니다. 웹은 탭이 보일 때만 4초마다 폴링하고, 탭이 다시 보이거나 네트워크가 돌아오면 바로 같은 seq부터 이어받습니다.

## 친구 `/api/friends` (로그인 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | `{friends, incoming, outgoing}`. 친구마다 안 읽은 1:1 수와 마지막 메시지(최근 대화 순). 탈퇴한 회원은 빠짐 |
| POST | `/requests` | `{nickname}` 또는 `{userId}` 중 하나 → 201 `{status:'pending', user}`. 상대가 이미 요청했으면 200 `{status:'accepted'}`로 바로 친구. 400 `friend_self`, 404 `user_not_found`, 409 `already_friends`·`already_requested`·`blocked_user`(내가 차단함)·`friend_limit`(200명), 403 `request_unavailable`(상대가 차단했거나 요청을 받지 않음: 둘을 구분하지 않음). 시간당 30회 |
| GET / PATCH | `/settings` | `{friendRequests:'everyone'\|'nobody', dmNotifications:boolean}` |
| GET | `/:userId/relation` | `{relation:'none'\|'friend'\|'incoming'\|'outgoing'\|'blocked'}` — 내 쪽에서 본 관계(나를 차단한 상대는 `none`) |
| POST | `/:userId/accept` | 받은 요청 수락. 없으면 404 |
| POST | `/:userId/invite` | `{tableId}` → 201 DirectMessageDto(`kind:'invite'`). 친구에게 열린 테이블 초대 카드를 1:1로 보냄. 참가 코드는 담지 않고 아무 권한도 주지 않음(좌석·코드·관전은 테이블이 똑같이 검사). 403 `not_friends`, 409 `table_unavailable`(닫힘·입장 차단). 10분당 20회 |
| DELETE | `/:userId` | 받은 요청 거절, 보낸 요청 취소, 친구 삭제 |

친구 요청은 두 사람 사이에 차단이 없을 때만 저장하는 한 문장으로 기록합니다. 그래서 요청과 차단이 동시에 와도 차단이 이깁니다(차단이 먼저 쓴 요청도 지움).

## 차단 `/api/blocks` (로그인 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 내가 차단한 회원 목록 |
| PUT | `/:userId` | 차단. 같은 트랜잭션에서 두 사람의 친구 관계·대기 중인 요청을 지움. 이후 양쪽 모두 친구 요청과 1:1 메시지를 보낼 수 없음. 400 `block_self`, 404 `user_not_found`, 409 `block_limit`(500명). 시간당 60회 |
| DELETE | `/:userId` | 차단 해제(친구 관계는 되살리지 않음) |

차단은 개인 설정이라 같은 테이블 착석을 막지 않습니다(제재는 관리자 정지). 테이블 채팅 뮤트는 서버가 아니라 기기에 저장합니다.

## 신고 `/api/reports` (로그인 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/` | `{targetType:'post'\|'comment'\|'dm'\|'player', targetId, tableId?(player만, 필수), reason:'spam'\|'abuse'\|'inappropriate'\|'cheating'\|'other', detail?(≤500)}` → 201 `{id}`. 시간당 20회 |

- **증거는 서버가 복사한다**: 글·댓글은 신고 시점 본문, 1:1 메시지는 서버에 저장된 그 메시지와 같은 보낸 사람의 직전 5개, 플레이어는 테이블 이름·핸드 번호·채팅. 신고자가 보낸 본문은 쓰지 않습니다. 숨긴 카드는 담지 않습니다.
- **대상이 없으면 404**: 공개 상태가 아닌(삭제·숨김) 글·댓글, 대화 당사자가 아닌 사람의 1:1 메시지, 탈퇴한 회원의 메시지·회원. 이미 낸 신고는 원래 증거와 함께 남고, 관리자 화면에 지금 콘텐츠 상태(`contentStatus`)가 함께 나옵니다.
- **플레이어 신고는 같은 테이블에 있었던 사람만**: 둘 다 지금 그 테이블에 있으면(앉아 있거나, 관전 중으로 접속해 있거나, 남아 있는 채팅에 글이 있으면) 바로 접수합니다. 한쪽이 떠났으면 착석 기록(`table_sessions`)에서 최근 24시간 안에 두 사람이 동시에 앉아 있던 구간을 찾고, 없으면 409 `not_at_table`. 그 구간의 공동 핸드와 그때 채팅만 증거로 남깁니다.
- 400 `report_self`, 409 `already_reported`(같은 대상에 대한 내 신고가 아직 처리 중).

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
| GET | `/users?q&status&locale&limit(≤200)` · `/users/:id` | 검색(계정 언어 `locale` 포함·필터)과 상세(언어, 생년월일, 이메일 인증 시각, 개인정보 동의 버전·시각, 원장, 착석, 원장 정합성). 조회마다 감사 로그 `user.list`·`user.view` |
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
| GET | `/reports?status&userId` | `{items, openCount}`. `status`는 `open`(기본)·`resolved`·`dismissed`·`all`, `userId`는 신고당한 회원. 항목마다 신고 시점 증거, 지금 콘텐츠 상태, 같은 회원의 다른 신고 수(전체·인정). 조회마다 감사 로그 `report.view`(1:1 메시지 신고 ID 포함). 최근 200건 |
| POST | `/reports/:id` | `{status:'resolved'\|'dismissed', note?, hideContent?}` → `{ok, closed}`. 같은 대상의 열린 신고를 함께 닫고, `hideContent`면 글·댓글을 숨김(그 밖의 대상은 400). 감사 행 기록·숨김·상태 변경을 한 batch로 처리해, 두 관리자가 동시에 처리해도 결정·숨김·감사 행은 하나뿐이고 늦은 쪽은 409 `report_closed` |

아카데미 지표(관리자): `GET /api/admin/academy/stats` → `[{kind, itemId, starts, completes, correct, wrong}]`(익명 집계). 테이블 생성·수정 본문에 `beginner`(입문 테이블) 추가.
