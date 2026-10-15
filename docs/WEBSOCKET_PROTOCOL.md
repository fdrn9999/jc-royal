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
- **관리자의 연결 종료(4004)**: 관리자가 회원을 정지하거나 강제 연결 종료하면 룸은 그 회원의 연결마다 `reqId` 없는 `error suspended` 또는 `error disconnected`를 보내고 **4004**로 닫습니다. 클라이언트는 4004에서 재연결하지 않고, 남은 요청을 실패로 끝내며, 마지막 화면을 지우고 안내만 보입니다.
  - 룸은 종료 시각을 60초 동안 기억하고, api가 그 시각(시계 차이 2초 허용) 이전에 인증한 핸드셰이크를 같은 방식으로 거절합니다(api가 세션을 지우기 전에 인증된 연결이 늦게 도착하는 경우). 그래서 종료 직후 2초 안에 다시 로그인한 연결은 4004로 거절될 수 있고, 그 뒤에는 정상 연결됩니다. 정지된 계정은 로그인 자체가 막힙니다.
  - 정지된 회원이 아직 열린 소켓으로 보낸 착석·충전은 지갑(`users.status = 'active'` 조건)이 거절해 `suspended`로 끝나고 칩은 움직이지 않습니다. 핸드가 끝난 뒤 적용될 충전도 같은 조건으로 차감하지 않고 버립니다.
- **새 핸드 중단**: 관리자가 새 핸드를 멈추면(`tables.hands_paused`) 진행 중 핸드는 정상 종료하고, 그 뒤로 핸드를 시작하지 않습니다. `state.paused: true`, `nextHandAt: null`. 착석·일어서기·채팅은 그대로 됩니다.
- **서비스 점검**: 관리자가 정한 점검 시간(`maintenance_windows`) 동안 룸은 `sit`과 대기 등록(`waitlist join`)을 `error maintenance`로 거절하고 새 핸드를 시작하지 않습니다. 진행 중 핸드는 끝까지 진행하고, 일어서기(환급)·충전·채팅은 그대로 됩니다. 점검 중 빈 자리는 대기 명단에 넘기지 않고, 점검이 끝나면 넘깁니다. 룸은 테이블 설정을 읽을 때·점유 현황을 기록할 때·점검 시작과 종료 시각의 알람에서 D1을 읽어 점검을 알고, 관리자가 바꾸면 api가 사용 중인 룸(최대 60곳)에 바로 다시 읽게 합니다. `state.maintenance: {startsAt, endsAt, active}`(없으면 null, 이전 룸은 보내지 않음), 점검 중에는 `you.canSit: false`, `nextHandAt: null`.

## 클라이언트 → 서버

| t | 필드 | 설명 |
|---|---|---|
| `sync` | — | 현재 상태 재전송 요청 |
| `sit` | `reqId, seatIndex, buyIn` | 착석과 바이인(지갑에서 차감). `reqId` 재전송은 멱등 처리 |
| `leave` | `reqId` | 일어서기. 핸드 중이면 폴드 후 정산 시 환급 |
| `topUp` | `reqId, amount` | 스택 충전(지갑에서 차감). 충전 후 스택이 테이블 바이인 범위 안이어야 함. 핸드에 참여 중이면 차감 없이 대기했다가 핸드가 끝난 뒤 적용(새 요청이 대기 중인 요청을 대체). `reqId` 재전송은 멱등 처리 |
| `cancelTopUp` | `reqId?` | 대기 중인 충전 취소. 취소할 충전이 없어도(이미 취소됨) `ack` |
| `autoRebuy` | `reqId, on, amount?, cap?, consent?` | 자동 리바이(기본 꺼짐). 켜려면 `consent: true`, 1회 금액 `amount`(바이인 범위), 총 한도 `cap`(`amount` 이상, `amount`×5 이하)이 모두 필요. 다시 켜면 사용액이 0부터 시작 |
| `sitOut` / `sitIn` | `reqId?` | 자리 비움과 복귀. `reqId` 재전송은 멱등 처리 |
| `waitlist` | `join, reqId?` | 대기열 등록·취소. `reqId` 재전송은 멱등 처리 |
| `action` | `intentId, handId, seq, type, amount?` | `type`: fold/check/call/bet/raise/allin. bet·raise의 `amount`는 이번 스트리트 총액("to"). `seq`는 현재 `hand.seq`와 같아야 함. 적용되면 `intentId`로 `ack` |
| `preAction` | `reqId, handId, stage, toCall, kind` | 사전 액션: 다른 사람 차례 동안 이번 스트리트의 내 다음 액션을 예약. `kind`: `check`·`checkFold`·`fold`, `null`이면 취소. `handId`·`stage`·`toCall`은 고를 때 본 화면 값. 아래 '사전 액션' 참고 |
| `muck` | `reqId, on` | 패배한 쇼다운 핸드 자동 머크 켜기·끄기. 착석한 플레이어만(아니면 `forbidden`). 같은 값을 다시 보내도 결과가 같음. 아래 '쇼다운 머크' 참고 |
| `chat` | `text(1-200), reqId?` | 채팅. 같은 `reqId`로 다시 보내면 한 번만 게시 |
| `ping` | — | → `pong`. 정확히 `{"t":"ping"}`이면 런타임이 룸을 깨우지 않고 답함 |

`reqId`는 8~64자 문자열입니다. `?`가 붙은 `reqId`는 이전 클라이언트 호환을 위해 생략할 수 있고, 생략하면 `ack`가 오지 않습니다.

## 서버 → 클라이언트

| t | 내용 |
|---|---|
| `state` | `{ state: TableView, cues: TableCue[] }`. 이 화면을 보는 사람 기준으로 투영된 전체 상태 |
| `chatHistory` / `chat` | 최근 채팅 50개, 새 메시지 |
| `ack` | `{reqId}`: `reqId`를 단 명령의 성공(대기열에 들어간 충전 포함). 액션은 `reqId` 자리에 `intentId`. 이미 처리한 명령을 다시 받아도 `ack`만 다시 보냄 |
| `error` | `{code, message, reqId?}` |
| `notice` | `{code, amount?}`: 해당 플레이어에게만 보냄. 핸드가 끝난 뒤 룸이 처리한 충전·자동 리바이 결과: `topup_applied`·`rebuy_applied`(`amount`=차감액), `topup_dropped`(범위를 벗어나 취소, 차감 없음), `topup_insufficient`, `rebuy_insufficient`·`rebuy_cap`(자동 리바이가 꺼짐). 사전 액션을 지키지 못했을 때: `preaction_cancelled` |
| `replaced` | 다른 탭에서 접속함 |
| `pong` | 자동 응답은 `{"t":"pong"}` 그대로. 다른 모양의 `ping`을 룸이 직접 받으면 `{at}`이 붙음 |

### TableView (요약, 정의는 `packages/types/src/table.ts`)

- **최상위 필드**: `version`(룸 상태 버전, 증가만 함), `table`(설정, 회원 방이면 `roomType:'member'`와 방장 `hostId`), `status`(waiting/playing/closing/closed).
- **seats[]**: 각 좌석의 `state`(empty/waiting/active/folded/allin/sittingOut), `stack`, `streetBet`, `connected`, `lastAction`, `hasCards`, `holeCards`.
  - `holeCards`는 **본인 좌석이거나 쇼다운에서 공개된 경우에만** 들어갑니다. 자동 머크로 공개되지 않은 패는 `hasCards: true`에 `holeCards`가 없어 뒷면으로 그려지고, `hand.result.showdown`에도 빠집니다.
- **hand**: `id`, `number`, `seq`, `stage`, `buttonSeat`, `sbSeat`, `bbSeat`, `board`, `pots[]`, `potTotal`, `actorSeat`, `deadline`, `result`(winners, showdown).
- **you**: `seatIndex`, `legal[]`(내 차례일 때만), `sittingOut`, `leaving`, `inWaitlist`, `canSit`, `needsCode`(비공개 테이블에서 이 연결에 유효한 참가 티켓이 없고 착석하지 않음), `topUpQueued`(핸드 종료를 기다리는 충전 금액 또는 null), `autoRebuy`(`{amount, cap, spent}` 또는 null), `preAction`(룸이 지금 지키고 있는 내 사전 액션 또는 null), `autoMuck`(착석했으면 룸에 저장된 내 자동 머크 설정, 아니면 null. 이전 룸은 보내지 않음). 다른 사람의 설정은 어디에도 들어가지 않습니다.
- 핸드 진행 중 좌석의 `stack`은 이번 핸드에 건 칩을 뺀 남은 스택입니다. 충전 범위도 이 값으로 검사합니다.
- **대기 관련**: `spectatorCount`, `waitlist`, `reservation`, `nextHandAt`, `paused`(관리자가 새 핸드를 멈춤. 이전 룸은 보내지 않음), `maintenance`(서비스 점검 `{startsAt, endsAt, active}` 또는 null. 이전 룸은 보내지 않음).

### TableCue (연출 전용, 권한 없음)

`handStart`, `deal`, `action{seatIndex,type,amount}`, `street{stage,cards}`, `showdown`, `payout{seatIndex,amount}`, `handEnd`, `seat`, `leave`.

## 순서·중복 처리

- 클라이언트는 `version`이 줄어든 `state`를 무시합니다.
- 액션은 `intentId`로 멱등 처리됩니다. 같은 핸드에서 이미 적용된 id(최근 500개)를 다시 보내면 다시 적용하지 않고 `ack`만 오며, 이 기록은 서버 재시작 뒤에도 유지됩니다. 핸드가 바뀐 뒤에 온 사본은 `conflict`입니다.
- `sit`·`leave`·`topUp`·`autoRebuy`·`sitOut`·`sitIn`·`waitlist`는 룸이 최근 `reqId` 200개를 기억해, 다시 받으면 `ack`만 보냅니다. 늦게 도착한 이전 명령(예: `sitIn` 뒤의 `sitOut` 사본)이 나중 명령을 되돌리지 않습니다.
- 채팅 줄의 id는 `SHA-256(userId:reqId)`에서 만들어, 최근 채팅 50개 안에 같은 id가 있으면 게시하지 않고 `ack`만 보냅니다.
- 명령은 룸에서 한 번에 하나씩 처리되므로, 첫 사본이 D1 처리 중일 때 도착한 재전송은 첫 사본이 끝난 뒤 `ack`를 받습니다.
- `seq`가 맞지 않으면 `stale_version`이 옵니다. 클라이언트는 이때 `sync`를 보내 상태를 다시 받습니다.
- 재접속하면 서버가 즉시 `state`와 `chatHistory`를 보냅니다. 화면은 항상 서버 상태로 복구됩니다.
- 충전·자동 리바이는 원장 `idempotency_key`(`topup:<세션>:<reqId>`, `rebuy:<세션>:<handId>`)로 한 번만 차감됩니다. 룸은 D1 호출 전에 시도를 기록하고, 재시작하거나 호출이 실패하면 원장을 조회해 원장이 실제로 차감한 만큼만 한 번 반영합니다. 원장에 이미 있는 키는 기록하지도 다시 쓰지도 않으므로, 룸이 기억하는 최근 `reqId` 200개 밖의 오래된 요청을 다시 보내도 `ack`만 오고 칩은 늘지 않습니다. 응답을 받지 못한 클라이언트는 같은 `reqId`로 다시 보냅니다.
- 핸드 중에는 스택이 늘지 않습니다. 대기 중인 충전과 자동 리바이는 정산 직후(또는 다음 핸드 시작 직전)에 적용되며, 금액은 요청액과 `최대 바이인 − 스택` 중 작은 값입니다.

## 사전 액션 (`preAction`)

- **고를 수 있는 것**: 낼 칩이 없으면 `checkFold`(체크, 그 사이 누가 베팅하면 폴드)와 `check`, 낼 칩이 있으면 `fold`만. 콜·벳·레이즈·올인은 예약할 수 없습니다. 낼 칩이 있는데 `check`, 없는데 `fold`를 보내면 `bad_request`입니다.
- **룸이 지키는 조건**: 착석한 플레이어만 보낼 수 있고(아니면 `forbidden`), 핸드·스트리트가 같고, 내 차례가 아니고, 룸이 계산한 내 `toCall`이 보낸 값과 같을 때만 지킵니다. 하나라도 다르면 아무것도 지키지 않고 `ack`와 함께 `preaction_cancelled`를 보냅니다.
- **실행**: 내 차례가 오면 룸이 엔진의 합법 액션을 다시 보고 실행합니다. 체크할 수 있으면 `check`·`checkFold`는 체크하고 `fold`는 실행하지 않습니다(공짜 체크를 폴드하지 않음). 체크할 수 없으면 `checkFold`·`fold`만 폴드합니다. 실행하지 못하면 `preaction_cancelled`를 보내고 차례는 그대로 플레이어에게 남습니다. 실행된 액션도 다른 액션과 같이 엔진을 거쳐 기록됩니다.
- **취소**: 예약은 그 스트리트에서만 유효합니다. 스트리트나 핸드가 바뀌면 조용히 지웁니다. 고른 뒤 베팅이 들어와 `check`가 맞지 않게 되면 지우고 `preaction_cancelled`를 보냅니다(`checkFold`·`fold`는 더 큰 베팅에도 그대로 둠). 폴드·올인으로 핸드에서 빠져도 지웁니다.
- 같은 `reqId`를 다시 받으면(좌석당 최근 16개) 다시 적용하지 않고 `ack`만 보냅니다. 나중 선택이 늦게 온 이전 사본으로 되돌아가지 않습니다.
- **배포 순서**: game-worker를 먼저 배포합니다. 이전 룸은 `preAction`을 모르는 메시지로 보고 `bad_request`(`reqId` 없음)를 보내므로, 새 웹이 먼저 나가면 사전 액션을 누를 때 오류가 뜨고 아무것도 예약되지 않습니다(자동 액션은 일어나지 않음).

## 쇼다운 머크 (`muck`)

- **공개 규칙** (`packages/poker-engine/src/hand.ts` `revealedHands`): 폴드한 패와 쇼다운 없이 이긴 패는 누구에게도 공개하지 않습니다. 패를 비교한 쇼다운(2명 이상)에서는
  - 팟을 하나라도 받은 패(나눈 팟 포함)와 핸드 중 시작 스택 전부를 건(올인한) 패는 항상 공개합니다.
  - 칩이 남은 쇼다운 참가자가 둘 미만이면(올인으로 베팅이 끝남) 설정과 관계없이 모두 공개합니다.
  - 그 밖에 진 패는 주인이 자동 머크를 켰으면 다른 사람에게 공개하지 않고, 아니면 공개합니다.
  - 주인은 언제나 자기 패를 봅니다.
- **설정 시점**: 룸은 정산 순간의 좌석 설정으로 그 핸드의 머크 대상을 정해 상태에 저장합니다. 정산 뒤에 설정을 바꿔도 이미 끝난 핸드의 공개 여부는 바뀌지 않습니다.
- **기록**: 같은 결정이 `hand_players.shown`(1 공개, 0 머크)에 들어가고, `/api/me/hands/:id`와 커뮤니티 핸드 리뷰는 본인이 아닌 머크된 패의 `holeCards`·`rankClass`를 null로 줍니다. 이 열이 NULL인 이전 기록은 `went_to_showdown`을 따릅니다. 관리자 감사 화면(종료 핸드 전체)은 그대로 모든 카드를 봅니다.
- **웹 클라이언트**: 설정은 기기에 저장되고(`jc.prefs`), 착석해 있고 연결이 열려 있을 때 룸의 `you.autoMuck`이 다르면 한 번 보냅니다. 연결이 끊긴 동안 보낸 명령은 남지 않으므로 재연결 뒤에 다시 맞춥니다. 머크된 본인의 패는 결과의 `showdown`에 없어 자리 아래에 족보 이름이 나오지 않습니다(카드는 보임).
- **배포 순서**: 마이그레이션 `0011_hand_shown` → game-worker → api → web. 열이 없으면 새 game-worker의 핸드 기록 INSERT가 실패합니다. 이전 룸은 `autoMuck`을 보내지 않으므로 새 웹은 아무것도 보내지 않습니다.

## 웹 클라이언트의 전달 규칙 (`apps/web/src/game/link.ts`, `useTableSocket.ts`)

- `sync`를 뺀 모든 명령에 id(`reqId`, 액션은 `intentId`)를 붙여 답을 받을 때까지 보관합니다.
- **답이 늦을 때**: 보낸 지 5초가 지나도 답이 없으면 `ping`으로 연결이 살아 있는지 확인합니다. 20초 안에 답이 없으면 요청은 `internal`(no answer)로 실패하고 `sync`로 상태를 다시 받습니다. 같은 `reqId`로 다시 시도해도 안전합니다.
- **연결이 끊겼을 때**: 일시적인 끊김(4001·4002·4003이 아닌 종료)이면 보관한 명령을 다음 연결에서 **같은 id로** 다시 보냅니다. 룸은 각 명령을 한 번만 적용합니다. 다시 보낸 명령이 `stale_version`·`conflict`·`duplicate`·`not_your_turn`으로 거절되면 첫 사본이 이미 처리됐거나 차례가 지난 것이므로 오류를 띄우지 않습니다. 새 `state`에서 차례가 넘어간 액션은 보관 목록에서 지웁니다.
- 다른 탭이 연결을 가져가거나(4001) 인증이 끝나거나(4002) 참가 코드가 필요하거나(4003) 관리자가 연결을 끝내면(4004) 보관한 요청은 모두 실패로 끝냅니다. 탭을 닫거나 테이블을 떠날 때도 같습니다.
- **하트비트**: 서버 메시지는 무엇이든 살아 있다는 신호입니다. 25초 동안 아무 메시지도 없을 때만 `ping`을 보내고, 그 뒤 10초 안에 아무것도 오지 않으면 브라우저의 종료 감지를 기다리지 않고 바로 재연결합니다. 핸드가 진행 중이면 `state`가 몇 초마다 오므로 `ping`을 보내지 않습니다. 탭이 다시 보이면 `sync`를 보내고 같은 방식으로 답을 기다립니다.
- **배포 순서**: game-worker를 먼저, 웹을 나중에 배포합니다. 이전 서버는 새 명령(`sitOut` 등)에 `ack`를 보내지 않으므로, 새 웹이 먼저 나가면 그 명령들은 20초 뒤 조용히 만료되고 `sync`로 화면을 맞춥니다(동작에는 영향 없음).

## 오류 코드

`bad_request, unauthorized, forbidden, not_found, conflict, rate_limited, insufficient_balance, seat_taken, already_seated, buyin_out_of_range, table_closed, entry_blocked, maintenance, not_your_turn, illegal_action, stale_version, duplicate, spectators_disabled, join_code_required, suspended, disconnected, internal`

`suspended`·`disconnected`가 `reqId` 없이 오면 관리자가 연결을 끝낸 것이고 4004 종료가 뒤따릅니다. `reqId`가 붙은 `suspended`는 정지된 계정의 착석·충전을 지갑이 거절한 것입니다.
