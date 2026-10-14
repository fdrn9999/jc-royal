# WebSocket 프로토콜

- **연결**: `wss://<site>/ws/tables/:tableId[?code=<참가코드>]`.
  - 세션 쿠키가 필요합니다. 없으면 401입니다.
  - 허용된 Origin이어야 합니다. 아니면 403입니다.
  - 존재하는 테이블이어야 합니다. 아니면 404입니다.
- **메시지 형식**: JSON 텍스트, 최대 2,000바이트.
- **검증**: 모든 클라이언트 메시지는 zod `ClientMessageSchema`로 검증하고, 실패하면 `bad_request`를 보냅니다.
- **속도 제한**: 소켓당 토큰 버킷(용량 20, 초당 10)이고, 채팅은 1초에 1회입니다.
- **중복 접속**: 사용자당 연결 1개만 유지합니다. 새 탭이 연결되면 기존 연결에 `replaced`를 보내고 4001로 닫습니다.

## 클라이언트 → 서버

| t | 필드 | 설명 |
|---|---|---|
| `sync` | — | 현재 상태 재전송 요청 |
| `sit` | `reqId, seatIndex, buyIn` | 착석과 바이인(지갑에서 차감). `reqId` 재전송은 멱등 처리 |
| `leave` | `reqId` | 일어서기. 핸드 중이면 폴드 후 정산 시 환급 |
| `sitOut` / `sitIn` | — | 자리 비움과 복귀 |
| `waitlist` | `join` | 대기열 등록·취소 |
| `action` | `intentId, handId, seq, type, amount?` | `type`: fold/check/call/bet/raise/allin. bet·raise의 `amount`는 이번 스트리트 총액("to"). `seq`는 현재 `hand.seq`와 같아야 함 |
| `chat` | `text(1-200)` | 채팅 |
| `ping` | — | → `pong` |

## 서버 → 클라이언트

| t | 내용 |
|---|---|
| `state` | `{ state: TableView, cues: TableCue[] }`. 이 화면을 보는 사람 기준으로 투영된 전체 상태 |
| `chatHistory` / `chat` | 최근 채팅 50개, 새 메시지 |
| `ack` | `{reqId}`: sit·leave 성공 |
| `error` | `{code, message, reqId?}` |
| `replaced` | 다른 탭에서 접속함 |
| `pong` | `{at}` |

### TableView (요약, 정의는 `packages/types/src/table.ts`)

- **최상위 필드**: `version`(룸 상태 버전, 증가만 함), `table`(설정), `status`(waiting/playing/closing/closed).
- **seats[]**: 각 좌석의 `state`(empty/waiting/active/folded/allin/sittingOut), `stack`, `streetBet`, `connected`, `lastAction`, `hasCards`, `holeCards`.
  - `holeCards`는 **본인 좌석이거나 쇼다운에서 공개된 경우에만** 들어갑니다.
- **hand**: `id`, `number`, `seq`, `stage`, `buttonSeat`, `sbSeat`, `bbSeat`, `board`, `pots[]`, `potTotal`, `actorSeat`, `deadline`, `result`(winners, showdown).
- **you**: `seatIndex`, `legal[]`(내 차례일 때만), `sittingOut`, `leaving`, `inWaitlist`, `canSit`.
- **대기 관련**: `spectatorCount`, `waitlist`, `reservation`, `nextHandAt`.

### TableCue (연출 전용, 권한 없음)

`handStart`, `deal`, `action{seatIndex,type,amount}`, `street{stage,cards}`, `showdown`, `payout{seatIndex,amount}`, `handEnd`, `seat`, `leave`.

## 순서·중복 처리

- 클라이언트는 `version`이 줄어든 `state`를 무시합니다.
- 액션은 `intentId`로 멱등 처리됩니다. 같은 id를 다시 보내면 `duplicate`가 오고, 서버 재시작 뒤에도 유지됩니다.
- `seq`가 맞지 않으면 `stale_version`이 옵니다. 클라이언트는 이때 `sync`를 보내 상태를 다시 받습니다.
- 재접속하면 서버가 즉시 `state`와 `chatHistory`를 보냅니다. 화면은 항상 서버 상태로 복구됩니다.

## 오류 코드

`bad_request, unauthorized, forbidden, not_found, conflict, rate_limited, insufficient_balance, seat_taken, already_seated, buyin_out_of_range, table_closed, entry_blocked, not_your_turn, illegal_action, stale_version, duplicate, spectators_disabled, internal`
