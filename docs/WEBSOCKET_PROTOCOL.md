# WebSocket 프로토콜

- **연결**: `wss://<site>/ws/tables/:tableId`. 주소에는 참가 코드를 넣지 않습니다(예전 `?code=`는 무시합니다).
  - 세션 쿠키가 필요합니다. 없으면 401입니다.
  - 허용된 Origin이어야 합니다. 아니면 403입니다.
  - 존재하는 테이블이어야 합니다. 아니면 404입니다.
- **비공개 테이블**: 먼저 `POST /api/tables/:id/access {code}`로 참가 티켓을 받습니다(`docs/API.md`).
  - 티켓은 `jc_room_<tableId>` 쿠키(HttpOnly, SameSite=Strict, Path=`/ws/tables/<tableId>`, 12시간)로, 테이블·회원·현재 참가 코드에 서명되어 있습니다. 코드가 바뀌면 이전 티켓은 모두 무효입니다.
  - 착석한 플레이어는 티켓 없이도 자기 자리로 돌아옵니다. 회원 방의 방장은 티켓이 필요 없습니다.
  - 티켓이 없으면: 관전이 허용된 테이블은 관전만 되고(`you.needsCode: true`, 착석·대기 등록은 `join_code_required`), 관전이 꺼진 테이블은 `error join_code_required`를 보낸 뒤 **4003**으로 닫습니다. 클라이언트는 4003에서 재연결하지 않고 코드를 묻습니다.
  - 방장이 코드나 공개 여부를 바꾸면 이미 열린 연결에도 적용됩니다: 이전 코드로 들어온 대기 명단은 빠지고, 관전이 꺼진 방에서는 코드 없는 미착석 연결을 4003으로 닫습니다. 착석한 플레이어는 그대로입니다.
- **메시지 형식**: JSON 텍스트, 최대 2,000바이트.
- **검증**: 모든 클라이언트 메시지는 zod `ClientMessageSchema`로 검증하고, 실패하면 `bad_request`를 보냅니다.
- **속도 제한**: 소켓당 토큰 버킷(용량 20, 초당 10)이고, 채팅은 1초에 1회입니다.
- **중복 접속**: 사용자당 연결 1개만 유지합니다. 새 탭이 연결되면 기존 연결에 `replaced`를 보내고 4001로 닫습니다. 4003으로 거절되는 연결은 다른 탭을 밀어내지 않습니다.

## 클라이언트 → 서버

| t | 필드 | 설명 |
|---|---|---|
| `sync` | — | 현재 상태 재전송 요청 |
| `sit` | `reqId, seatIndex, buyIn` | 착석과 바이인(지갑에서 차감). `reqId` 재전송은 멱등 처리 |
| `leave` | `reqId` | 일어서기. 핸드 중이면 폴드 후 정산 시 환급 |
| `topUp` | `reqId, amount` | 스택 충전(지갑에서 차감). 충전 후 스택이 테이블 바이인 범위 안이어야 함. 핸드에 참여 중이면 차감 없이 대기했다가 핸드가 끝난 뒤 적용(새 요청이 대기 중인 요청을 대체). `reqId` 재전송은 멱등 처리 |
| `cancelTopUp` | — | 대기 중인 충전 취소 |
| `autoRebuy` | `reqId, on, amount?, cap?, consent?` | 자동 리바이(기본 꺼짐). 켜려면 `consent: true`, 1회 금액 `amount`(바이인 범위), 총 한도 `cap`(`amount` 이상, `amount`×5 이하)이 모두 필요. 다시 켜면 사용액이 0부터 시작 |
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
| `ack` | `{reqId}`: sit·leave·topUp·autoRebuy 성공(대기열에 들어간 충전도 포함) |
| `error` | `{code, message, reqId?}` |
| `notice` | `{code, amount?}`: 핸드가 끝난 뒤 룸이 처리한 충전·자동 리바이 결과. 해당 플레이어에게만 보냄. `topup_applied`·`rebuy_applied`(`amount`=차감액), `topup_dropped`(범위를 벗어나 취소, 차감 없음), `topup_insufficient`, `rebuy_insufficient`·`rebuy_cap`(자동 리바이가 꺼짐) |
| `replaced` | 다른 탭에서 접속함 |
| `pong` | `{at}` |

### TableView (요약, 정의는 `packages/types/src/table.ts`)

- **최상위 필드**: `version`(룸 상태 버전, 증가만 함), `table`(설정, 회원 방이면 `roomType:'member'`와 방장 `hostId`), `status`(waiting/playing/closing/closed).
- **seats[]**: 각 좌석의 `state`(empty/waiting/active/folded/allin/sittingOut), `stack`, `streetBet`, `connected`, `lastAction`, `hasCards`, `holeCards`.
  - `holeCards`는 **본인 좌석이거나 쇼다운에서 공개된 경우에만** 들어갑니다.
- **hand**: `id`, `number`, `seq`, `stage`, `buttonSeat`, `sbSeat`, `bbSeat`, `board`, `pots[]`, `potTotal`, `actorSeat`, `deadline`, `result`(winners, showdown).
- **you**: `seatIndex`, `legal[]`(내 차례일 때만), `sittingOut`, `leaving`, `inWaitlist`, `canSit`, `needsCode`(비공개 테이블에서 이 연결에 유효한 참가 티켓이 없고 착석하지 않음), `topUpQueued`(핸드 종료를 기다리는 충전 금액 또는 null), `autoRebuy`(`{amount, cap, spent}` 또는 null).
- 핸드 진행 중 좌석의 `stack`은 이번 핸드에 건 칩을 뺀 남은 스택입니다. 충전 범위도 이 값으로 검사합니다.
- **대기 관련**: `spectatorCount`, `waitlist`, `reservation`, `nextHandAt`.

### TableCue (연출 전용, 권한 없음)

`handStart`, `deal`, `action{seatIndex,type,amount}`, `street{stage,cards}`, `showdown`, `payout{seatIndex,amount}`, `handEnd`, `seat`, `leave`.

## 순서·중복 처리

- 클라이언트는 `version`이 줄어든 `state`를 무시합니다.
- 액션은 `intentId`로 멱등 처리됩니다. 같은 id를 다시 보내면 `duplicate`가 오고, 서버 재시작 뒤에도 유지됩니다.
- `seq`가 맞지 않으면 `stale_version`이 옵니다. 클라이언트는 이때 `sync`를 보내 상태를 다시 받습니다.
- 재접속하면 서버가 즉시 `state`와 `chatHistory`를 보냅니다. 화면은 항상 서버 상태로 복구됩니다.
- 충전·자동 리바이는 원장 `idempotency_key`(`topup:<세션>:<reqId>`, `rebuy:<세션>:<handId>`)로 한 번만 차감됩니다. 룸은 D1 호출 전에 시도를 기록하고, 재시작하거나 호출이 실패하면 원장을 조회해 원장이 실제로 차감한 만큼만 한 번 반영합니다. 원장에 이미 있는 키는 기록하지도 다시 쓰지도 않으므로, 룸이 기억하는 최근 `reqId` 200개 밖의 오래된 요청을 다시 보내도 `ack`만 오고 칩은 늘지 않습니다. 응답을 받지 못한 클라이언트는 같은 `reqId`로 다시 보냅니다.
- 핸드 중에는 스택이 늘지 않습니다. 대기 중인 충전과 자동 리바이는 정산 직후(또는 다음 핸드 시작 직전)에 적용되며, 금액은 요청액과 `최대 바이인 − 스택` 중 작은 값입니다.

## 오류 코드

`bad_request, unauthorized, forbidden, not_found, conflict, rate_limited, insufficient_balance, seat_taken, already_seated, buyin_out_of_range, table_closed, entry_blocked, not_your_turn, illegal_action, stale_version, duplicate, spectators_disabled, join_code_required, internal`
