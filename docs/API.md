# REST API 명세

공통 사항:

- **경로와 형식**: 모든 경로는 `/api` 아래에 있고, 요청·응답은 JSON입니다.
- **오류 응답**: `{ "error": { "code", "message", "details?" } }` 형식입니다.
- **인증**: 사용자 사이트는 `jc_sid` 쿠키, 관리자 콘솔은 `jc_asid` 쿠키를 씁니다. 둘 다 HttpOnly입니다.
- **CSRF 방어**: 상태를 바꾸는 요청은 허용된 `Origin`과 `Content-Type: application/json`이 있어야 합니다.
- **입력 검증**: zod 스키마는 `packages/types/src/api.ts`와 `community.ts`에 있습니다.
- **운영진 표시 `role`**: 다른 회원에게 보이는 회원 정보(친구·친구 요청·차단 목록, 1:1 대화 상대, 게시판 글·댓글 작성자, 로비의 방장 `host`, 핸드 기록·리뷰의 `players[]`)에는 서버가 `users.role`에서 읽은 `role`이 관리자에게만 붙습니다: `'super_admin'` 또는 `'admin'`. 일반 회원은 필드 자체가 없습니다. 요청 본문의 `role`은 어디서도 읽지 않습니다. 역할이 바뀌면 다음 응답부터 바뀐 값이 나가고, 핸드 기록도 기록 당시가 아니라 지금 역할을 보여 줍니다.

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
| POST | `/me/delete` | `{password}` → 탈퇴(착석 중이면 409 `seated`). 계정 정보 비식별화, 세션·친구·차단·1:1 메시지(양쪽)·쪽지·아카데미 진도·재설정 링크·활동한 날 기록 삭제. 원장·핸드·게시글·신고는 회원 ID로 남는다(`docs/PRIVACY_OPERATIONS.md` 3절) |
| POST | `/password-reset/request` | `{email}` → 항상 200(IP당 5회, 이메일당 3회/시간 초과 시 429). 메일 설정 시 재설정 메일 발송. 개발 환경에서만 `devToken` 반환 |
| POST | `/password-reset/confirm` | `{token,newPassword}`(가입과 같은 비밀번호 규칙) → 1회용. 모든 세션 폐기 |

이메일 인증은 `MAIL_FROM`, `RESEND_API_KEY`, `APP_ORIGIN`이 모두 설정되면 켜집니다(운영 발신 주소 `JC ROYAL <noreply@jc-royal.site>`, 메일 속 링크는 https://jc-royal.site). 운영에서 메일이 꺼져 있으면 인증 단계 없이 가입되고 `emailVerifiedAt`은 비어 있습니다. 개발·테스트 환경에서는 항상 켜져 있고 인증번호는 `devCode`로 돌려줍니다.

## 내 정보 `/api/me`

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/ledger?limit&before` | 칩 변동 내역 |
| GET | `/stats` | 본인 것만. 카드를 받은 핸드만 세고 관전은 빠진다. 플레이 핸드, 승리 핸드(`pot_won > 0`: 팟 일부라도 획득, 스플릿 포함, 콜 안 된 베팅만 돌려받은 핸드 제외)와 승률, 총 획득(`pot_won` 합), 순손익, 참여한 최대·평균 팟(`largestPot`, `avgPot`: 내 칩이 들어간 핸드에서 실제로 다툰 팟, 콜 안 된 베팅 반환분 제외), 한 핸드 최대 순이익(`biggestWin`), 최고 핸드, `vpip`·`pfr`(분모: 행동 기록을 읽은 핸드), `raiseShare`(PFR ÷ VPIP 핸드), `wtsd`(쇼다운 ÷ 플랍을 본 핸드), `wsd`(팟 획득 ÷ 쇼다운), `positions`(EP·MP·CO·BTN·SB·BB 순서, 핸드·VPIP·PFR·손익). 비율은 `{ n, of }`이며 `of = 0`이면 화면에 —. 계산 정의는 `packages/db/src/handStats.ts` |
| GET | `/stats/trend?days=7\|30\|90&tz=<분>` | 기간별 일 순손익. `tz`는 UTC 기준 동쪽으로의 분(−720~840, 한국 540). 그 시간대 날짜로 나눈 `{ day: 'YYYY-MM-DD', hands, net }`를 오래된 순으로 주고, 핸드가 없는 날은 뺀다. 잘못된 값은 400 `bad_request` |
| GET | `/hands?limit&before` | 최근 핸드 |
| GET | `/hands/:id` | 핸드 상세(본인 카드와 쇼다운에서 공개된 카드만). 자동 머크로 공개되지 않은 다른 사람의 패는 `holeCards`·`rankClass`가 null(`hand_players.shown = 0`). `shown`이 없는 이전 기록은 쇼다운에 간 패를 공개된 것으로 봄. 커뮤니티 핸드 리뷰도 같은 규칙. 단계별 재생에 쓰는 필드는 아래 |
| GET | `/posts` · `/comments` | 내가 쓴 글과 댓글 |

**핸드 재생 필드(`HandReplayFields`, `packages/types/src/community.ts`):** `/hands/:id`와 게시판 첨부 핸드 리뷰가 같이 준다. 종료 핸드의 저장된 기록만 쓰고, 새 정보를 계산해 내지 않는다.
- `maxSeats`(테이블 좌석 수), `buttonSeat`(딜러 버튼), `smallBlind`·`bigBlind`, `board`, `potTotal`.
- `actions`: `{seatIndex, stage, type, amount}`. `amount`는 그 액션으로 **더 낸 칩**(레이즈 총액이 아님). 블라인드는 `post-sb`·`post-bb`.
- `pots`: 메인 팟부터 `{amount, eligibleSeats, winners: [{seatIndex, amount}], uncalled}`. `uncalled: true`는 콜 받지 못해 돌려준 베팅. 각 팟의 `winners` 합은 `amount`, 모든 팟의 합은 `potTotal`, 플레이어별 합은 `won`.
- 플레이어별 `stackStart`, `net`, `won`, `holeCards`, `rankClass`, `bestFive`. 카드 세 필드는 본인과 쇼다운에서 공개된 패만 값이 있고 나머지는 null(위 머크 규칙).
- 이 변경 전에 기록된 핸드는 `buttonSeat`·`pots`가 null이다. 화면은 플레이어별 `won`만 보여 주고, 이때 `won`에는 돌려받은 베팅이 섞일 수 있다.

## 테이블 `/api/tables`, WebSocket

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/tables` | 로비(종료된 테이블 제외, 실시간 착석·진행·대기·관전 수, `beginner` 입문 테이블 여부) |
| GET | `/api/tables/:id` | 단일 테이블 |
| POST | `/api/tables/quick` | 빠른 참가 `{maxSeats?: 2\|6\|9, bigBlind?, exclude?: string[]}` → `{table, seatIndex}`. 칩은 쓰지 않음(바이인은 테이블에서 착석 요청으로) |
| POST | `/api/tables/:id/access` | 비공개 테이블 참가 코드 확인 `{code(1–64자)}` → `{ok:true}`와 참가 티켓 쿠키 `jc_room_<id>`(HttpOnly, SameSite=Strict, Path=`/ws/tables/<id>`, 12시간). 공개 테이블과 회원 방의 방장은 쿠키 없이 `{ok:true}`. 틀린 코드 403 `bad_join_code`, 없거나 종료된 테이블 404. 맞든 틀리든 시도마다 회원당 10분에 10회, IP당 10분에 30회(429 `rate_limited`) |
| GET(upgrade) | `/ws/tables/:id` | WebSocket. 세션 쿠키와 Origin 필수. 비공개 테이블은 참가 티켓이 있어야 착석·대기 등록 가능(관전이 꺼진 방은 티켓 없으면 4003) → `docs/WEBSOCKET_PROTOCOL.md` |

로비 응답의 각 테이블에는 `roomType`(`official`/`member`)과 `host`(회원 방이면 `{id,nickname}`, 공식 테이블이면 `null`, 방장이 관리자면 `role`도)가 있습니다. 공식 테이블이 먼저, 회원 방이 뒤에 나옵니다.

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
| POST | `/events` | `{events: [{kind:'question', id, correct} \| {kind:'lesson'\|'scenario', id, phase:'start'\|'complete'}]}`(최대 50). 사용자 ID 없이 항목별 카운터와 그날의 일별 카운터(`daily_stats`의 `ac_*`, 운영 통계)만 증가. 분당 30회 |

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
| GET | `/posts/:id` | 본문, 첨부 핸드 리뷰(작성자 시점, 위 핸드 재생 필드 포함), 댓글과 답글 |
| POST | `/posts` | `{title(2-100), body(≤10000), handIds(≤3, 본인이 플레이한 종료 핸드)}`, 시간당 10회 |
| PATCH / DELETE | `/posts/:id` | 작성자만 가능(공지는 회원이 수정 불가) |
| POST | `/posts/:id/comments` | `{body(≤1000), parentId?}`. 답글의 답글은 같은 묶음에 `@닉네임`으로 붙음 |
| PATCH / DELETE | `/comments/:id` | 작성자만 가능. 답글이 있는 댓글을 삭제하면 자리표시로 남음 |

탈퇴한 회원의 글·댓글은 작성자가 `{id, nickname: '', avatarUrl: null, isAdmin: false, withdrawn: true}`로 오고(`role` 없음) 화면은 "탈퇴한 회원"으로 표시한다. 탈퇴한 회원에게 단 답글의 `replyTo`는 `null`.

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
| GET | `/` | 내가 차단한 회원 목록(지금 운영진인 회원은 빠짐) |
| PUT | `/:userId` | 차단. 같은 트랜잭션에서 두 사람의 친구 관계·대기 중인 요청을 지움. 이후 양쪽 모두 친구 요청과 1:1 메시지를 보낼 수 없음. 400 `block_self`, 403 `block_staff`(관리자·최고 관리자), 404 `user_not_found`, 409 `block_limit`(500명). 시간당 60회 |
| DELETE | `/:userId` | 차단 해제(친구 관계는 되살리지 않음) |

차단은 개인 설정이라 같은 테이블 착석을 막지 않습니다(제재는 관리자 정지). 테이블 채팅 뮤트는 서버가 아니라 기기에 저장합니다.

운영진(관리자·최고 관리자)은 차단할 수 없습니다. 회원이던 때 받은 차단이나 이 규칙 전에 저장된 차단은 지우지 않고 남겨 두되, 그 회원이 운영진인 동안에는 효과가 없습니다(친구 요청·1:1 메시지 검사, 관계 표시, 차단 목록, 1:1 안 읽음 수 모두 무시). 다시 일반 회원이 되면 그 차단이 다시 적용됩니다. 테이블 채팅 뮤트(기기 로컬)는 차단이 아니라 그대로 쓸 수 있습니다.

## 신고 `/api/reports` (로그인 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/` | `{targetType:'post'\|'comment'\|'dm'\|'player', targetId, tableId?(player만, 필수), reason:'spam'\|'abuse'\|'inappropriate'\|'cheating'\|'other', detail?(≤500)}` → 201 `{id}`. 시간당 20회 |

- **증거는 서버가 복사한다**: 글·댓글은 신고 시점 본문, 1:1 메시지는 서버에 저장된 그 메시지와 같은 보낸 사람의 직전 5개, 플레이어는 테이블 이름·핸드 번호·채팅. 신고자가 보낸 본문은 쓰지 않습니다. 숨긴 카드는 담지 않습니다.
- **대상이 없으면 404**: 공개 상태가 아닌(삭제·숨김) 글·댓글, 대화 당사자가 아닌 사람의 1:1 메시지, 탈퇴한 회원의 메시지·회원. 이미 낸 신고는 원래 증거와 함께 남고, 관리자 화면에 지금 콘텐츠 상태(`contentStatus`)가 함께 나옵니다.
- **플레이어 신고는 같은 테이블에 있었던 사람만**: 둘 다 지금 그 테이블에 있으면(앉아 있거나, 관전 중으로 접속해 있거나, 남아 있는 채팅에 글이 있으면) 바로 접수합니다. 한쪽이 떠났으면 착석 기록(`table_sessions`)에서 최근 24시간 안에 두 사람이 동시에 앉아 있던 구간을 찾고, 없으면 409 `not_at_table`. 그 구간의 공동 핸드와 그때 채팅만 증거로 남깁니다.
- 400 `report_self`, 403 `report_super_admin`(최고 관리자는 신고할 수 없음, 신고하는 사람이 운영진이어도 같음. 관리자는 일반 회원처럼 신고할 수 있음), 409 `already_reported`(같은 대상에 대한 내 신고가 아직 처리 중).

## 서비스 공지·점검 `/api/service` (로그인 불필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/status` | `ServiceStatusDto` `{now, rev, notices, refreshAt, maintenance}`(`packages/types/src/service.ts`, D1 batch 1회, `cache-control: no-store`). `notices`는 지금 보이거나 나중에 보일 공지 최대 20개(삭제·종료 제외, 한국어·영어 둘 다 담아 화면이 언어를 고름): 지금 보이는 공지가 먼저(긴급 → 점검 → 일반, 같은 종류는 최근 시작 순), 그다음 시작 전 공지(빨리 시작하는 순). 그래서 오래된 공지가 많아도 새 긴급 공지가 빠지지 않는다. `refreshAt`은 공지가 20개를 넘어 잘렸을 때만 다음으로 공지가 시작하거나 끝나는 시각(빠진 공지가 들어올 수 있는 때)이고, 화면은 그 시각이 지나면 다시 읽는다. 모두 담겼으면 null(화면이 스스로 시작·종료를 처리). `maintenance`는 끝나지 않은 점검 하나(`{id, startsAt, endsAt, blockLogin, messageKo, messageEn, active}`, 없으면 null). `now`는 서버 시각(기기 시계가 틀려도 제때 보이고 사라지게), `rev`는 관리자가 공지·점검을 바꿀 때마다 바뀌는 값 |

- 로그인한 화면은 `/api/messages/unread-count`의 `serviceRev`가 바뀔 때만 다시 읽는다(추가 폴링 없음). 로그인 전 화면(로그인·가입·점검 안내 `/maintenance`)은 페이지를 열 때 읽고, 점검 안내 페이지는 탭이 보이는 동안 30초마다 다시 읽는다. 어떤 요청이든 `maintenance` 코드로 거절되면 바로 다시 읽는다.
- **점검 중 거절(503 `maintenance`, `details.endsAt`)**: 점검이 진행 중이면 빠른 참가(`POST /api/tables/quick`)와 회원 방 만들기(`POST /api/rooms`)가 거절되고, 테이블 룸은 `sit`·대기 등록을 WebSocket 오류 `maintenance`로 거절한다. `blockLogin`이면 회원 로그인(비밀번호 확인 뒤)과 가입도 거절한다. 회원의 게시판 글·댓글 작성과 수정(`POST /api/board/posts`, `POST /api/board/posts/:id/comments`, `PATCH /api/board/posts/:id`, `PATCH /api/board/comments/:id`)도 거절하고, 관리자·슈퍼관리자는 허용한다. 게시판 읽기·삭제·신고는 그대로다. 관리자·슈퍼관리자 계정의 게임 로그인과 이미 열린 세션, 관리자 콘솔은 막지 않는다. 진행 중 핸드는 끝까지 진행하고, 점검 중에는 새 핸드를 시작하지 않는다. 자리에서 일어나 칩을 지갑으로 돌려받는 것, 테이블 닫기와 테이블별 일시 정지는 그대로 동작한다. `TableView.maintenance`(`{startsAt, endsAt, active}`)로 테이블 화면에도 알린다.

## 관리자 `/api/admin` (관리자 출처 + `jc_asid`)

인증:

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/auth/bootstrap` | `{token,email}` — 최초 슈퍼관리자 1회만(배포 시크릿 `ADMIN_BOOTSTRAP_TOKEN`) |
| POST | `/auth/login` · `/auth/logout` | 관리자 세션 |
| GET | `/auth/me` | `{user{id,email,nickname,role}, reauthValidUntil, sessionStartedAt, permissions}`. `permissions`는 이 역할이 가진 능력 목록(`members.export`·`roles.change`·`admins.manage`·`chips.large`·`ledger.correct`·`notes.delete_any`·`audit.all`·`sessions.all`, 지금은 모두 슈퍼관리자 전용) |
| POST | `/auth/reauth` | `{password}` → 5분간 민감 작업 허용 |

관리(🔒 = 재확인 필요, 👁 = `preview: true`로 미리보기):

- 모든 라우트는 `apps/api/src/lib/permissions.ts`의 권한 표에 규칙이 있어야 열린다. 규칙이 없으면 403 `no permission rule for this action`, 역할이 모자라면 403 `super admin only`, 재확인이 필요하면 401 `reauth_required`. 역할은 요청마다 D1에서 다시 읽는다(`docs/ADMIN_SECURITY.md` 권한 매트릭스).
- 👁 라우트에 본문 `preview: true`를 함께 보내면 검사(역할·대상·금액)만 하고 아무것도 쓰지 않은 채 `{preview: true, …}`로 바뀔 내용을 돌려준다. 미리보기는 재확인을 묻지 않는다. 성공한 미리보기는 감사 로그에 남지 않는다.
- 거절·실패한 요청은 감사 로그에 `<조치>.failed`(관리자 권한이 없으면 `admin.access_denied`), `outcome: 'failed'`, 상세 `{status, code, message, route, preview?}`로 남는다(요청 본문 없음). 401, 403이 아닌 조회 실패, 라우트가 자기 감사 행을 이미 쓴 요청은 빼고.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/dashboard` | 누적 현황: 회원 수, 접속자, 테이블·진행 게임, WS 연결, 핸드 수, 서버 상태, 문제 상황. 전체 핸드 수를 세므로 대시보드는 열 때와 수동 새로고침 때만 부른다 |
| GET | `/ops/live` | 실시간 운영 지표(D1 batch 1회, 쿼리 8개). `tables.{official,member}`(테이블 수·종료 중·입장 차단·사람 있는 테이블·진행 중 핸드·착석·대기·관전·WS 연결: 각 룸이 바뀔 때 기록한 마지막 값), `top`(연결·착석이 많은 테이블 12개와 종료 중 테이블, `liveUpdatedAt`·`lastIssue`), `onlineUsers`(5분 안에 API를 쓴 회원 세션 수), `ops`(`ops_metrics`: 5분 × 12칸 `trend`, `last5m`, `lastHour`의 `ws_retry`·`ws_drop`·`room_error`·`api_error`), `reports`(열린 신고 수·가장 오래된 시각·사유별), `warnings`(미해결 정합성 이상, 15분 넘게 종료 중인 테이블, 닫힌 테이블에 남은 착석), `rowsRead`(이 호출이 읽은 D1 행 수), `server.{d1LatencyMs,at}` |
| GET | `/stats?unit=day\|week\|month&n` | 운영 통계(`apps/api/src/lib/stats.ts`). `n`은 단위 수(일 기본 30·최대 90, 주 12·26, 월 12·12), 그 밖의 `unit`·`n`은 400 `invalid_input`. 하루는 한국 시간(UTC+9) 0시–24시이고 어제까지 보인다(오늘은 다음 날 집계). 주는 월요일부터, 마지막 주·달은 어제에서 잘린다. → `{unit, n, from, to, tz, utcOffsetMinutes, rolledFrom, rolledThrough, activitySince, retentionDays, periods[], total, hourly[24]{avg, max}, rolled, at, d1Ms}`. 기간 하나(`total`은 전체 범위): `{from, to, days(집계된 날 수), complete(끝났고 모든 날이 집계됨), members{signups, dauAvg, returningAvg, wau, mau(기간 마지막 활동 기록일 기준), partial{dau, wau, mau}(기록 시작 전 날짜가 섞임), activityDays}, activation{cohort, play1d, play7d, cohortDays}(가입 후 24시간·7일 안에 처음 앉은 회원, 가입 주가 지난 날만), play{hands, handsPerDay, tablesAvg, seats, avgSeatMs, peak, official{hands, tablesAvg, seats, seatMs}, member{…}}, reports{created, handled, avgHandleMs}, academy{ac_lesson_start, ac_lesson_done, ac_scenario_start, ac_scenario_done, ac_answer, ac_correct}}`. 끝난 날은 매일 크론이 `daily_stats`에 집계하고, 크론 전에 열면 빠진 날을 31일까지 먼저 집계한다(`rolled{days, behind}`, 실패하면 `{failed: true}`와 함께 이전 집계만 보여 줌, 집계할 날이 없으면 `null`). 회원을 가리키는 값 없이 합계만 돌려주며 열람은 감사 로그에 남기지 않는다 |
| GET | `/users?q&status&locale&role&online=1&sort&dir&limit(≤200)&offset&paged=1` · `/users/:id` | 검색(이메일·닉네임·ID)과 필터(`status` active·suspended·deleted, `locale` ko·en, `role` user·admin·super_admin, `online=1`이면 접속 중만; 모르는 값은 무시). `sort`는 `created`(기본)·`balance`·`nickname`(대소문자 무시)·`login`(최근 로그인, 기록 없는 회원은 방향과 상관없이 뒤), `dir` asc·desc(기본 desc), 같은 값은 최신 가입 순. 항목마다 `lastLoginAt`·`online`. `paged=1`이면 `{items, total, limit, offset}`, 아니면 배열(예전 형식). 상세: 언어, 생년월일, 이메일 인증 시각, 개인정보 동의 버전·시각, `lastLoginAt`, 원장, 착석, 원장 정합성, 만료 전 로그인 세션 `sessions[{kind,createdAt,lastSeenAt,expiresAt}]`(토큰·IP·브라우저 없음), `online`, 최근 참여 테이블 `recentTables`(10개: 테이블·방 종류·좌석·바이인·환급·상태·시각), 신고 `reports{filed, against}`(상태별 건수)와 최근 5건씩 `recentFiled`·`recentAgainst`(사유·상태·상대 닉네임·시각, 상세 내용·증거 없음). 접속 중 = 최근 5분 안에 API를 쓴 회원 세션(테이블 소켓만 쓰는 회원은 빠질 수 있음). 최근 로그인 = 회원 로그인 세션을 만든 시각(가입·로그인, 관리자 로그인은 제외). 조회마다 감사 로그 `user.list`(검색어·필터·정렬·건수)·`user.view` |
| GET | `/users/:id/activity?days=7\|30\|90&tz` | 기간별 게임 활동 → `{days, since, series[{date, hands, net, wins, showdowns}], totals{hands, net, wins, showdowns, activeDays, seatings, tables, buyIn}}`. `tz`는 UTC보다 앞선 분(한국 540, −840~840), 날은 그 시간대 자정으로 나눈다. 핸드 없는 날도 0으로 채운다. 그 밖의 `days`는 7 |
| GET | `/users/:id/timeline?kind=all\|sanction\|chips\|note&limit(1–100, 기본 30)&before&beforeId` | 관리 조치 이력, 최신 순 → `{items[{id, action, createdAt, actor{id,nickname}, detail, body}], nextBefore, nextBeforeId}`. 제재(`user.suspend`·`user.unsuspend`·`user.disconnect`와 이 회원에 대한 신고 결정 `report.*`), 권한·칩·재설정 링크, 메모(`note`, `body`에 본문)와 메모 삭제(`note.delete`, 본문 없음). 다음 쪽은 마지막 항목의 시각·ID를 `before`·`beforeId`로 보낸다(같은 ms 항목도 빠지거나 겹치지 않음). 더 없으면 `nextBefore` null |
| POST · DELETE | `/users/:id/notes` · `/users/:id/notes/:noteId` | 관리자 내부 메모(회원에게 보이지 않음) `{body(2–500자)}` → `{id, createdAt}`. 이메일·전화번호(국내·국제)·주민등록번호·카드 번호처럼 보이면 400 `note_pii`, 탈퇴·없는 회원 404. 삭제는 작성자나 슈퍼관리자만(403), 다른 회원의 메모 ID면 404. 감사 로그 `note.create`(`noteId`, 길이: 본문 없음)·`note.delete`(`noteId`, 작성자, 작성 시각) |
| POST | `/users/export` 🔒 | 슈퍼관리자만(그 밖은 403 `super admin only`). `{userIds(1-1000)}` → `{filename, count, csv}`. 열: id, email, nickname, language, role, status, balance, joined_at_utc, birth_date, email_verified_at_utc, privacy_notice_version, privacy_agreed_at_utc, suspended_reason. `=`·`+`·`-`·`@`로 시작하는 칸은 `'`를 붙여 수식 실행 방지. 감사 로그 `user.export`(대상 ID, 건수) |
| POST | `/users/:id/suspend` 🔒👁 · `/unsuspend` 🔒👁 | 미리보기: 정지 `{member{nickname,role,status}, sessions{user,admin}, seats[{tableId,tableName,seatIndex,buyIn}], buyIns}`, 해제 `{member{nickname,role}, from, to, suspendedReason}`. 정지 `{reason(2–200자), reportId?}` → `{ok, kick}`(`reportId`: 이 정지를 준 신고. 그 신고의 대상이 이 회원이 아니거나 없는 신고면 400 `the report is not about this member`. 신고 처리 기록에 `sanction`, 감사 로그에 `reportId`를 남긴다. 신고는 열린 채로 둔다): 세션 폐기, 열린 테이블 연결 종료와 자리 정리(아래 `kick`), 회원 계정 언어로 제재 쪽지 자동 발송. 감사 로그 `user.suspend`에 `{reason, from, to, previousReason, kick}`. 정지는 `active` 회원만 바꾼다: 이미 정지된 회원은 409 `already_suspended`(사유·쪽지·정지 기록은 그대로), 탈퇴한 계정은 404 `user not found`. 409여도 미리보기가 아니면 그 회원의 테이블에 한 번 더 연결 종료·자리 정리를 요청하고 결과를 `error.details.kick`으로 돌려준다(앞선 정지 요청이 상태만 바꾸고 테이블에 닿기 전에 끊겼을 때 다시 보내면 마무리된다). 이 거절은 감사 로그 `user.suspend.failed`에 `kick`과 함께 남는다. 상태 변경 직후 가장 먼저 테이블에 알리고, 신고 처리 기록·쪽지·감사는 그다음이다. 두 관리자가 동시에 정지해도 상태 변경·제재 쪽지·감사 기록은 하나이고 늦은 쪽은 409를 받는다. 해제도 `{reason(2–200자)}`가 필요(없으면 400)하고 상태만 되돌림. 감사 로그 `user.unsuspend`에 `{reason, from, to, suspendedReason}`(지워지는 정지 사유를 함께 남김) |
| POST | `/users/:id/disconnect` 🔒👁 | 미리보기 `{member, removeFromTable, sessions, seats, buyIns}`. 강제 연결 종료(정지 아님) `{reason(2–200자), removeFromTable?(기본 false)}` → `{ok, sessions, kick}`. 회원의 로그인 세션을 모두 지우고 열린 테이블 연결을 닫음(다시 로그인 가능). `removeFromTable`이면 자리·대기 명단에서도 빠짐. 자기 계정 400 `cannot disconnect yourself`, 관리자 대상은 슈퍼관리자만(403). 감사 로그 `user.disconnect`(사유, 세션 수, `kick`) |
| POST | `/users/:id/role` 🔒👁 | 슈퍼관리자만. `{role, reason(2–200자)}`(사유 없으면 400). 미리보기 `{member{nickname,status}, from, to, console{from,to}, adminSessions, capabilities{gained,lost}}`(콘솔 접속 가능 여부 전후, 지워질 관리자 세션 수). 대상의 관리자 세션 즉시 폐기. 저장 응답 `{ok, tables:{tables, reached}}`: 대상이 앉아 있는 테이블 수와 그중 바뀐 표시를 받은 룸 수. 답하지 않은 룸은 대상이 다시 연결할 때 맞춰지므로 변경은 실패하지 않는다. 감사 로그 `user.role`에 `{from, to, reason}` |
| POST | `/users/:id/chips` 🔒👁 | 미리보기 `{member, amount, balanceBefore, balanceAfter, large, duplicate}`(`duplicate`: 같은 키로 이미 처리됨). 미리보기에서도 거절 조건(관리자 대상·큰 금액·음수 잔액)은 같은 오류로 거절된다. `{amount(±), memo, idempotencyKey}` — 음수 잔액 불가(409 `insufficient_balance`), 회원 계정 언어로 쪽지 자동 발송. 절대값 100,000 이상은 슈퍼관리자만(그 밖은 403 `large_adjustment`). 같은 `idempotencyKey`를 다시 보내면 원장·잔액은 그대로 두고 처음 결과를 돌려준다. 거절은 감사 로그 `user.chips_refused`(`reason` forbidden·large_adjustment·insufficient_balance, 금액, 메모), 중복 요청은 `user.chips_duplicate`(금액, 메모, 원래 원장 ID)로 남는다 |
| POST | `/users/:id/reset-link` 🔒 | 30분 1회용 링크 → `{path, url, expiresInMinutes, locale, mailed, message:{subject,text}}`. 회원 계정 언어의 안내문을 만들고, 메일이 설정돼 있으면 발송(`mailed`). 자기 계정 400, 관리자 대상은 슈퍼관리자만(403) |
| GET / POST | `/tables?paged=1&q&status&roomType&issue=1&limit(≤200)&offset` | 목록과 생성(2·6·9석, 최소 바이인 ≥ 10BB). 목록은 만든 최신 순이고 참가 코드 해시 대신 `hasJoinCode`만 준다. `paged=1`이면 검색 `q`(이름 일부나 정확한 테이블 ID, 64자까지)와 필터(`status` open·closing·closed·`active`(닫히지 않은 테이블), `roomType` official·member, `issue=1`이면 룸이 문제를 보고한 테이블만; 모르는 값은 무시)를 받아 `{items, total, limit, offset}`, 아니면 전체 배열(예전 형식). 감사 로그 없음(카드·잔액이 없는 운영 정보) |
| GET / PATCH | `/tables/:id` | `{table, live, diagnosis}`. `live`는 룸의 실시간 상태(홀카드·덱 없음): 좌석별 단계(`pending`·`cashing`)·핸드 후 퇴장·시간 초과 수·대기 중 충전, `paused`, 진행 중 핸드(번호·단계·차례·마감), 다음 핸드 시각, 다음 알람, 기록 대기 핸드, 상태 버전. `diagnosis`는 `{issues[], sessionsOnlyInD1[], seatsOnlyInRoom[]}`: 룸이 보고한 문제(멈춘 핸드, 지난 마감, 늦은 다음 핸드, 착석 처리 중 좌석, 기록 대기 등)와 D1 `table_sessions`·테이블 설정 비교(`session_without_seat`, `seat_without_session`, `settings_not_applied`). 진단은 아무것도 바꾸지 않는다. 수정(블라인드는 다음 핸드부터). 수정 본문에 `entryBlocked`가 있으면 `/control`의 `block`·`unblock`처럼 🔒 재확인이 필요하다(없으면 401 `reauth_required`). 다른 설정만 바꿀 때는 묻지 않는다 |
| POST | `/tables/:id/control` 🔒 | 긴급 제어 `{action:'pause'\|'resume'\|'block'\|'unblock', reason(2–200자)}` → `{ok, paused, handInProgress}`. `pause`는 진행 중 핸드를 정상 종료한 뒤 새 핸드를 시작하지 않음(`tables.hands_paused`), `block`은 새 착석·대기 등록만 막음(앉은 플레이어는 유지). D1에 저장한 뒤 룸에 반영을 확인하고, 룸이 답하지 않으면 503 `room_unavailable`(저장은 됨, 다시 보내도 안전). 감사 로그 `table.control`(사유, `roomConfirmed`, `handInProgress`) |
| POST | `/tables/:id/close` 🔒👁 | 진행 중 핸드가 끝나면 전원 환급 후 종료. 미리보기 `{table{id,name,status,roomType}, seats[{userId,nickname,seatIndex,buyIn,stack,inHand}], chipsOnTable, handInProgress, waitlist, roomAnswered}`(룸이 답하지 않으면 `stack`·`inHand`·`chipsOnTable`·`handInProgress`·`waitlist`가 null이고 D1 착석만). 이미 닫힌 테이블은 404. 감사 로그 `table.close` |

`kick`(정지·강제 연결 종료 응답): `{tables, reached, unreached[], truncated, sockets, seats[{tableId, seat}]}`. 회원이 앉은 테이블 전부와 연결이 있는 열린 테이블(연결 많은 순, 최대 60곳)의 룸에 물어 그 회원의 소켓을 `error suspended|disconnected` 후 4004로 닫는다. `seat`: `left`(바로 정산), `after_hand`(진행 중 핸드에서 차례에 폴드, 핸드 정산 뒤 정산), `kept`(자리 유지), `retrying`(정산 재시도 중). 답하지 않은 룸은 `unreached`로 알린다(재시도하지 않음). 카드·결과를 바꾸는 조치는 없다.
| GET | `/hands?paged=1&tableId&member&cursor&limit(≤200, 기본 50)` | 종료된 핸드 목록(카드 없음). `paged=1`이면 최신 순 `{items[{seq, id, tableId, tableName, handNumber, startedAt, endedAt, board[], potTotal}], next, member{id,nickname}\|null}`. `member`(또는 `userId`)는 회원 ID·이메일·닉네임(대소문자 무시)이 정확히 맞는 한 명이고, 맞는 회원이 없으면 빈 쪽과 `member: null`. 다음 쪽은 `next`를 `cursor`로 보낸다: 회원·테이블로 좁힌 목록은 `<종료 ms>.<seq>`, 전체 목록은 `<seq>`(기록된 순서). 모양이 다른 커서는 400 `invalid cursor`. 전체 수는 세지 않는다. 회원으로 좁힌 조회는 감사 로그 `hand.list`(`{q, found, tableId, page: first\|next, count}`, 찾으면 대상 회원)에 남고, 테이블만·전체 조회는 남지 않는다. `paged=1`이 없으면 예전 배열(`tableId`·`userId`·`limit`·`offset`) |
| GET | `/hands/:id` 🔒 | 종료 핸드 전체(모든 홀카드, gzip 엔진 로그), 열람은 감사 로그에 기록 |
| GET | `/ledger?paged=1&member&type&from&to&cursor&limit(≤200, 기본 50)` | 원장. `paged=1`이면 최신 순 `{items[{seq, id, userId, nickname, type, amount, balanceAfter, tableId, refId, actorId, memo, createdAt}], next, member}`. `member`(또는 `userId`)는 핸드 목록과 같은 방식으로 한 명을 찾고, 없으면 빈 쪽. `type`은 원장 종류(모르는 값 400), `from`·`to`는 ms(`to` 미포함). 다음 쪽 `cursor`: 회원이면 `<시각 ms>.<seq>`(회원 원장 인덱스), 아니면 `<seq>`(기록된 순서); 모양이 다르면 400. 전체 수는 세지 않는다(조회마다 맞는 행을 모두 읽게 되므로). 회원 없이 드문 종류나 오래된 기간만 고르면 한 쪽을 채우기까지 원장의 많은 부분을 읽을 수 있다. 쪽마다 감사 로그 `ledger.view`(`{q, found, type, from, to, page, count}`, 찾으면 대상 회원). `paged=1`이 없으면 예전 배열(`userId`·`type`·`limit`·`offset`, 감사 로그 `{q, type, offset, count}`) |
| GET | `/audit?paged=1&actor&action&outcome&targetType&targetId&from&to&q&before&beforeId&limit` | 관리 이력 검색(최신 순). `action`은 정확한 이름이나 `user.*` 같은 묶음, `outcome` `ok`·`failed`, `from`·`to`는 ms(`to` 미포함), `q`(2–50자)는 상세 JSON 안의 글자나 대상 ID, `limit` 1–100(기본 50). → `{items[{id, action, outcome, createdAt, actor{id,nickname,role}, target{type,id,label}, detail, ip}], nextBefore, nextBeforeId, total?, totalCapped?, scope, countCap}`. 다음 쪽은 `before`·`beforeId`. `total`은 첫 쪽에만, 10,000건에서 멈춘다(`totalCapped`). 슈퍼관리자는 모든 관리자(`scope: 'all'`), 일반 관리자는 자기 기록만(`scope: 'own'`, `actor`는 무시). `paged=1`이 없으면 예전 배열 형식(`limit`·`offset`, 같은 범위) |
| GET | `/security/sessions` | 열린 관리자 콘솔 세션(최근 사용 순, 200개) `{scope, items[{id, user{id,nickname,role}, createdAt, lastSeenAt, idleExpiresAt, absoluteExpiresAt, ip, userAgent, reauthValidUntil, current}]}`. 일반 관리자는 자기 세션만 |
| DELETE | `/security/sessions/:id` | 세션 하나 종료 → `{ok, current}`(`current`: 이 브라우저였음). 다른 관리자의 세션은 슈퍼관리자만(403), 없는 세션 404. 재확인 없음. 감사 로그 `admin.session.end` |
| POST | `/security/sessions/end-others` | 이 브라우저를 뺀 내 콘솔 세션 모두 종료 → `{ok, ended}`. 감사 로그 `admin.session.end_others` |
| GET | `/security/permissions` | 권한 표(읽기 전용) `{role, capabilities, capabilityRoles, features[{feature, admin:'all'\|'some'\|'none', reauth, actions[{route, action, role, reauth}]}]}` |
| GET | `/economy?days=7\|30\|90&tz` | 가상 칩 경제 현황(D1 batch 1회, 읽기만) → `{days, since, wallets{members, accounts, balance, deleted, suspended, staff}(뒤의 셋은 탈퇴·정지·관리자 계정이 가진 칩 합계), tables{chips, openSessions, seatedBuyIn}, issued{signup, admin, reconcile, total}, ledger{total, byType}, gap, period{counts, moved, series[{date, n, moved, in, out}]}, reconciliation{created, open, lastRun}, failures{from, cashout, room, api, cashoutDays, tables}, anomalies{rapidGrants, largeAdjustments, refused, staleSessions, adminRowsCapped}, thresholds, rowsRead, at, d1Ms}`. `wallets.balance + tables.chips = issued.total + gap`(테이블 칩 = 바이인·충전 중 아직 환급되지 않은 칩, `gap` = 원장과 다른 지갑의 차이 합). `period.counts`는 기간 안 원장 종류별 건수·합계와 자동 리바이 건수. `failures`의 환급 실패(`cashout_fail`)·룸 오류·API 오류는 `ops_metrics`라 최근 14일만 있다(`from`). 특이 거래: 하루 안에 같은 회원에게 3회 이상 지급(`rapidGrants`), 절대값 100,000 이상 조정, 거절·중복된 칩 조정 요청(최근 50건), 12시간 넘게 정리되지 않은 착석과 닫힌·종료 중 테이블에 남은 착석(`staleSessions`, 50건). 관리자 조정은 기간 안 2,000행까지 읽고 넘으면 `adminRowsCapped`. `tz`는 −840~840분, 그 밖의 `days`는 7. 모든 관리자 |
| POST | `/reconcile/run` | 지갑(원장 합계)과 테이블(D1 착석·룸 좌석) 검사 → `{mismatches, created, acknowledged, tables}`. 같은 대상·같은 차이로 열려 있는 이상은 다시 만들지 않고, 지갑 이상은 메모만 남기고 닫은 것도 다시 만들지 않는다(`acknowledged`). 잔액은 바꾸지 않는다. 감사 로그 `reconcile.run`(건수) |
| GET | `/reconcile` · `/reconcile/:id` | 최신 200건(`resolution` note·record·revert, 예전 처리는 null). 상세: 테이블 이상은 `{event, table, diagnosis}`, 지갑 이상은 `{event, member, ledger{count, sum, checked, truncated}, difference{event, current}, breaks[≤50], breakCount, afterLast{amount, since}, recorded, recent[20], openSessions, corrections}` — 원장 행마다 직전 잔액 + 금액 = 기록된 잔액인지(최근 1,000행), 마지막 원장 기록 뒤 원장 밖에서 바뀐 금액, 열린 착석, 이 이상에 대한 정정 행 |
| POST | `/reconcile/:id/resolve` 🔒 | `{note(2–300자), action:'note'\|'record'\|'revert'}` → `{ok, action, ledgerIds, balanceAfter}`. `note`는 메모만 남기고 닫음(열린 이상만, 아니면 404). `record`·`revert`는 슈퍼관리자만(403 `forbidden`), 지갑 이상만(테이블 400): `record`는 잔액은 두고 차이를 원장 `reconcile` 행으로 남겨 원장을 지갑에 맞추고, `revert`는 원장에 없는 변화를 되돌려 지갑을 원장에 맞춘다(원장 `reconcile` 행 두 개, 회원 계정 언어로 쪽지 '가상 칩 잔액 정정 안내', 내부 메모는 보내지 않음). 원장 키 `reconcile:<id>:record|revert`로 한 번만 반영. 이미 정정됨 409 `already_resolved`, 검사 뒤 잔액·원장이 바뀜 409 `reconcile_stale`(다시 검사), 되돌리면 음수 409 `insufficient_balance`. 감사 로그는 `note`가 `reconcile.resolve`(메모), `record`·`revert`가 `user.reconcile`(`eventId, action, difference, note, ledgerIds, balanceBefore, balanceAfter`) |
| GET / POST | `/board/posts?status&paged=1&q&limit&offset` · `/board/posts/:id` · `/board/notices` · PATCH `/board/notices/:id` | 게시판 관리와 공지. 글 목록은 최신 순이고 `status` visible·hidden·deleted로 거른다. `paged=1`이면 제목 일부 `q`(100자까지), `limit` 1–100(기본 50)·`offset`과 `{items, limit, offset, more}`(전체 수 대신 한 행 더 읽어 다음 쪽 여부), 아니면 최신 100개 배열(예전 형식) |
| POST | `/board/posts/:id/status` · `/board/comments/:id/status` | `visible`/`hidden`/`deleted` |
| POST / GET | `/messages?paged=1&limit&offset` | `{userIds(1-500), category, title, body}` 발송(201 `{batchId, sent}`)과 발송 이력(최신 순). 이력은 `paged=1`이면 `limit` 1–100(기본 20)·`offset`과 `{items, limit, offset, more}`, 아니면 최신 100개 배열 |
| GET | `/service/notices?status&limit(≤200)&offset` | 서비스 공지 목록(시작 최신 순) `{now, items[{…, author, state}]}`. `state`·`status`: `live`·`scheduled`·`ended`·`deleted`(기본은 삭제 제외 전체) |
| POST | `/service/notices` | `{kind:'general'\|'urgent'\|'maintenance', titleKo, titleEn(2–100자), bodyKo?, bodyEn?(≤2000자), startsAt?(기본 지금, 과거면 지금), endsAt?(null = 직접 내릴 때까지), postToBoard?, sendInbox?}` → 201 `{id, postId, batchId, sent}`. `postToBoard`면 게시판 고정 공지 글(한국어 본문 아래 `[English]` 영어 본문), `sendInbox`면 활성 회원 모두에게 계정 언어로 쪽지(한 문장, 쪽지 발송 이력에 한 건). 글과 쪽지는 표시 시작 시각과 상관없이 바로 나간다. 감사 로그 `service.notice.create` |
| PATCH | `/service/notices/:id` | 위 필드 일부(게시판 글도 함께 고침, 이미 보낸 쪽지는 그대로). 종료가 시작보다 앞서거나 이미 지났으면 400. 감사 로그 `service.notice.update`(변경 전후) |
| POST · DELETE | `/service/notices/:id/end` · `/service/notices/:id` | 지금 내리기(이미 끝났으면 409)와 삭제(목록에서만 빠지고 감사 기록은 남음, 게시판 글은 게시판 관리에서 처리). 감사 로그 `service.notice.end`·`service.notice.delete` |
| GET | `/service/maintenance?limit&offset` | 점검 이력(만든 최신 순) `{now, tables{playing, withSeats, players}, items[{…, author, state}]}`. `state`: `scheduled`·`active`·`finished`·`ended_early`·`cancelled`. `tables`는 지금 핸드 진행 중·착석자가 있는 테이블 수와 착석 인원(룸이 마지막으로 기록한 값) |
| POST | `/service/maintenance` 🔒 | `{startsAt, endsAt, blockLogin?, messageKo?, messageEn?, reason(2–200자)}` → 201 `{id, startsAt, rooms}`. 과거 시작은 지금으로 당김. 최대 48시간, 최대 90일 뒤까지 예약(400). 끝나지 않은 점검이 있으면 409 `conflict`(한 문장으로 확인해 동시 예약도 하나만 성공). 감사 로그 `maintenance.schedule`(사유, `rooms`) |
| PATCH | `/service/maintenance/:id` 🔒 | `{startsAt?, endsAt?, blockLogin?, messageKo?, messageEn?, reason}` → `{ok, rooms}`. 예약된 점검은 옮기고, 진행 중 점검은 시작을 그대로 두고 종료만 늘이거나 줄인다(시작 변경 400). 이미 끝났거나 취소됐으면 409. 감사 로그 `maintenance.update`(변경 전후, 사유) |
| POST | `/service/maintenance/:id/stop` 🔒 | `{reason}` → `{ok, ended, rooms}`. 진행 중이면 지금 끝내고(`maintenance.end`), 예약이면 취소한다(`maintenance.cancel`). 이미 끝났으면 409 |
| GET | `/reports?status&userId&reporterId&severity&reason&targetType&assignee&sort&page&limit` | `{items, total, page, limit, openCount}`. `status`는 `open`(기본)·`resolved`·`dismissed`·`all`, `userId`는 신고당한 회원, `reporterId`는 신고한 회원, `severity`는 `low`·`medium`·`high`·`critical`·`none`(미지정), `reason`·`targetType`은 신고 사유·대상 종류, `assignee`는 `me`·`none`·관리자 ID, `sort`는 `newest`(기본)·`oldest`(오래 기다린 순)·`severity`(심각도 높은 순, 미지정은 뒤, 같으면 오래된 순). `page`는 1부터, `limit` 기본 50·최대 100. 모르는 `severity`·`reason`·`targetType`·`sort`·`status`는 400. 항목마다 신고 시점 증거, 지금 콘텐츠 상태, 같은 회원의 다른 신고 수 `priorReports{total, resolved, reporters}`, `severity`, `assignee{id,nickname}`·`assignedAt`, 닫힌 신고의 결과 안내 여부 `notice{reporter,target}`(열린 신고는 null), 대상 회원의 최근 제재 5건 `sanctions[{action(user.suspend·user.unsuspend·user.disconnect), at, reason, reportId, actor}]`(어느 신고로 준 조치인지 `reportId`). 조회마다 감사 로그 `report.view`(필터·쪽·건수, 1:1 메시지 신고 ID 포함) |
| GET | `/reports/stats?days=7\|30\|90` | 참고 통계(아무 조치도 하지 않음, D1 batch 1회) → `{days, since, byReason[{reason, total, open, resolved, dismissed, avgHandleMs}], byTarget[{targetType, …}], backlog{open, unassigned, over24h, over72h, oldestOpenAt, bySeverity{none,low,medium,high,critical}}, handled{count, avgMs, maxMs}, repeated[{user{id,nickname,status}, reports, reporters, open, resolved, dismissed, lastAt, suspensions}]}`. `byReason`·`byTarget`·`repeated`는 기간 안에 접수된 신고, `backlog`는 접수 시기와 상관없이 지금 열린 신고, `handled`는 기간 안에 처리된 신고(처리 시각 − 접수 시각). `repeated`는 기간 안에 2건 이상 신고된 회원 상위 20명(신고 많은 순)과 그 회원이 받은 정지 횟수(전체 기간). 그 밖의 `days`는 400 `days must be 7, 30 or 90`. 감사 로그 없음(증거·본문을 담지 않음) |
| GET | `/reports/assignees` | 담당자로 지정할 수 있는 활성 관리자(`role != 'user'`, `status = 'active'`) `{items[{id, nickname, role}]}`(닉네임 순) |
| GET | `/reports/:id/events` | 신고 처리 기록(오래된 순) `{items[{id, kind, from, to, fromName, toName, body, actor{id,nickname}, createdAt}]}`. `kind`: `note`(내부 메모, `body`), `severity`(`from`→`to`, null = 미지정), `assign`(관리자 ID와 닉네임 `fromName`·`toName`, null = 미배정), `status`(`open`→`resolved`·`dismissed`, `body` = 처리 내용), `sanction`(이 신고로 준 정지, `to` = `user.suspend`, `body` = 사유). 없는 신고 404 |
| POST | `/reports/:id/notes` | 내부 처리 메모 `{body(2–500자)}` → 201 `{id, createdAt}`. 회원에게 보이지 않고, 닫힌 신고에도 남길 수 있다. 이메일·전화번호·주민등록번호·카드 번호처럼 보이면 400 `note_pii`, 없는 신고 404. 감사 로그 `report.note`(`eventId`, 길이: 본문 없음) |
| PATCH | `/reports/:id` | 열린 신고 하나를 바꾼다. 키는 정확히 하나: `{severity: 'low'\|'medium'\|'high'\|'critical'\|null}`, `{assigneeId: 관리자 ID\|null}`(null = 담당 해제), `{take: true}`(아무도 맡지 않았을 때 내가 맡기) → `{ok, changed}`(같은 값이면 `changed:false`, 기록 없음). 감사 행(변경 전후)을 먼저 쓰고 그 행이 있을 때만 처리 기록과 변경을 반영하는 한 batch라, 두 관리자가 동시에 맡아도 담당자·기록·감사 행은 하나뿐이고 늦은 쪽은 409 `report_taken`. 닫힌 신고 409 `report_closed`, 없는 신고 404, 활성 관리자가 아닌 담당자 400 `assignee must be an active administrator`, 키가 없거나 둘 이상이면 400. 감사 로그 `report.severity`·`report.assign` |
| POST | `/reports/:id` 👁 | `{status:'resolved'\|'dismissed', note?, hideContent?, notifyReporter?, notifyTarget?}` → `{ok, closed, notified{reporters, target}}`. 미리보기(D1 읽기 batch 1회, 문장 3개) `{preview, status, closes, notify{reporters, target}, hides}`: 함께 닫힐 열린 신고 수(이 신고 포함), 쪽지를 받을 신고자 수(탈퇴 제외, 안내를 고른 경우만), 대상 회원 안내 여부, 실제로 숨겨질 공개 글·댓글이 있는지. 본문 검사와 이미 처리된 신고(409)는 미리보기에서도 같다. 같은 대상의 열린 신고를 함께 닫고, `hideContent`면 글·댓글을 숨김(그 밖의 대상은 400). `notifyReporter`면 이번에 닫힌 신고의 신고자마다 한 번씩, `notifyTarget`(해결 처리일 때만, 기각이면 400)이면 대상 회원에게 회원 계정 언어로 쪽지를 보낸다(탈퇴 회원 제외). 쪽지에는 신고자·관리자 이름과 처리 내용·내부 메모를 담지 않는다. 닫힌 신고마다 처리 기록 `status`와 안내 여부(`notice`)를 남긴다. 감사 행 기록·숨김·상태 변경·쪽지를 한 batch로 처리해, 두 관리자가 동시에 처리해도 결정·숨김·쪽지·감사 행은 하나뿐이고 늦은 쪽은 409 `report_closed`. 감사 로그 `report.resolved`·`report.dismissed`(`closed`, `hidden`, `note`, `notify{reporter,target}`) |

신고 처리 원칙: 신고 횟수·통계·자동 탐지는 참고 정보이며 어떤 경로도 신고 수만으로 회원을 정지하지 않는다. 정지는 관리자가 기록된 증거를 보고 `/users/:id/suspend`에 `reportId`를 함께 보내 그 신고에 연결한다.

`rooms`(점검 예약·변경·종료 응답): `{tables, reached, unreached[], truncated}`. 접속자나 착석자가 있는 열린·종료 중 테이블(연결 많은 순, 최대 60곳)의 룸에 테이블 설정을 다시 읽게 해(한 번 더 시도) 점검 표시와 핸드 중단·재개를 바로 반영한다. 답하지 않았거나 60곳 밖의 룸은 다음 점유 기록 때나 핸드를 기록할 때(같은 batch에서 점검을 읽음) 알게 되고, 알고 난 뒤에는 점검 시작·종료 시각의 알람에서 D1을 다시 읽는다. 사람이 그대로인 채 핸드를 이어 가던 룸도 그 핸드를 기록하면서 점검을 알아 다음 핸드를 시작하지 않는다. 설정·좌석·칩은 바꾸지 않는다.

아카데미 지표(관리자): `GET /api/admin/academy/stats` → `[{kind, itemId, starts, completes, correct, wrong}]`(익명 집계). 테이블 생성·수정 본문에 `beginner`(입문 테이블) 추가.
