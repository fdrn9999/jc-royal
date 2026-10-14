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
| POST | `/register` | `{email,password(8+),nickname}` → 201 MeDto + 세션. 가입 칩 지급(원장), 환영 쪽지. 409 `email_taken`/`nickname_taken` |
| POST | `/login` | `{email,password}` → MeDto + 세션. 401 `invalid_credentials`, 403 `suspended`, 429 |
| POST | `/logout` | 세션 폐기 |
| GET | `/me` | 현재 사용자(MeDto) |
| PATCH | `/me` | `{nickname?, avatarUrl?(https), locale?}` |
| GET | `/nickname-available?nickname=` | `{available}` |
| POST | `/me/password` | `{currentPassword,newPassword}` → 다른 기기 세션 폐기 |
| GET | `/me/sessions` · DELETE `/me/sessions/:id` | 로그인 세션 목록과 폐기 |
| POST | `/me/delete` | `{password}` → 탈퇴(착석 중이면 409 `seated`) |
| POST | `/password-reset/request` | `{email}` → 항상 200. 개발 환경에서만 `devToken` 반환 |
| POST | `/password-reset/confirm` | `{token,newPassword}` → 1회용. 모든 세션 폐기 |

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
| GET | `/users?q&status` · `/users/:id` | 검색과 상세(원장, 착석, 원장 정합성) |
| POST | `/users/:id/suspend` 🔒 · `/unsuspend` 🔒 | 정지·해제(세션 폐기, 제재 쪽지 자동 발송) |
| POST | `/users/:id/role` 🔒 | 슈퍼관리자만. 대상의 관리자 세션 즉시 폐기 |
| POST | `/users/:id/chips` 🔒 | `{amount(±), memo, idempotencyKey}` — 음수 잔액 불가, 쪽지 자동 발송 |
| POST | `/users/:id/reset-link` 🔒 | 1회용 재설정 경로 발급 |
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
