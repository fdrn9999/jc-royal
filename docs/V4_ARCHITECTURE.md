# JC-ROYAL V4 아키텍처 메모

지금 구조에서 V4가 지키는 것과 바꾸려는 것을 적는다. 전체 그림은 `docs/ARCHITECTURE.md`가 기준이고, 여기는 V4에서 달라지는 곳만 다룬다.

## 1. 지금의 구조 (바꾸지 않는다)

- `apps/web`, `apps/admin`: 화면. `apps/api`: Cloudflare Worker(Hono) + D1. `apps/game-worker`: 테이블마다 Durable Object `TableRoom`(`room.ts`), MTT 조정자(`coordinator.ts`, `mtt.ts`).
- `packages/poker-engine`: `poker-engine-ts` 어댑터. 교체하지 않는다.
- 돈의 길은 하나다: 지갑(`users.balance`)과 `chip_ledger`는 바이인·캐시아웃·지급에서만 바뀐다. **대회 칩은 지갑 칩이 아니고 원장에 닿지 않는다.**

## 2. 핸드 기록의 길 (V4 Phase 2에서 대회로 넓힘)

```
settle()
  ├─ 캐시:  정산(원장) + UnrecordedHand 를 룸 저장소에 함께 저장
  └─ 대회:  순위(bustOut / mttReport) + [record_hands 인 대회만] UnrecordedHand{tournament} 저장
        ↓  (브로드캐스트 뒤)
retryUnrecorded() → recordHand()  ── INSERT OR IGNORE hands / hand_players (+ tournament_id, tournament JSON)
        ↑ 실패하면 저장소에 남고 알람(finishWorkSafely)이 다시 시도. 룸이 다시 떠도 남아 있다.
```

- 한 번만: `hands.id`가 기본 키이고 `INSERT OR IGNORE`, 카운터는 "그 핸드가 아직 없을 때만" 가드를 쓴다. 대회 핸드도 같은 문장을 쓴다.
- 대회 진행은 기다리지 않는다: 순위·레벨·테이블 이동은 `syncTourney`/`mttSync`가 먼저 하고, 핸드 기록은 그 뒤에 따로 시도한다.
- 켜고 끄기: `TOURNAMENT_HANDS_ENABLED`(API) → 대회를 열 때 `tournaments.record_hands`에 적음 → 룸이 대회를 읽을 때 `TourneyState.record`. 대회 하나는 통째로 기록되거나 통째로 안 된다.
- 메타데이터(`hands.tournament`, JSON): `format`, `level`, `sb`, `bb`, `hand`(SNG의 대회 손 번호, MTT 테이블은 null), `left`(그때 남은 사람, MTT 테이블은 null), `startStack`. 자리별 시작·끝 스택과 포지션은 `hand_players`에 캐시 핸드와 같은 칸으로 있다.

### 범위 나누기

| 읽는 곳 | 범위 |
|---|---|
| HUD `scope=cash` / `scope=tournament` | `tables.room_type` |
| 내 통계, 프로필 카드, 관리자 손익, 추천·신규·대회 참가 조건, 업적, 챌린지 | 캐시만 (`hand_players.tournament_id IS NULL`) |
| 핸드 기록 목록·리플레이·메모·신고 | 모두(대회 핸드에는 `tournament` 표시) |

SNG/MTT를 따로 보는 통계 화면은 Phase 5다. 저장은 지금부터 `format`을 가진다.

## 3. 규칙 세트 (설계만, Phase 2 후속)

- 이름: "JC Royal Custom"(지금 규칙: 최소 레이즈 = 가장 높은 벳의 두 배), "Standard NLHE"(직전 레이즈 폭).
- 테이블 설정에 두고 **핸드를 시작할 때 스냅샷**한다. 진행 중인 핸드와 지난 핸드는 바뀌지 않는다(소급 금지). 리플레이는 스냅샷으로 다시 돌린다.
- 엔진에는 이미 핸드별 규칙을 넘기는 자리가 있다(`hand.ts`의 `ruleSet`). 어댑터는 그대로 두고 `minRaisePolicy`만 고르게 한다.
- 기본값은 지금 규칙이다.

## 4. `room.ts` 나누기 (Phase 3부터)

- 순서: 상태를 건드리지 않는 순수 함수부터 옮긴다(이미 `rabbit.ts`, `tournament.ts`, `settlement.ts`가 그 꼴이다). 클래스의 메서드 순서나 저장 형식은 건드리지 않는다.
- 기능 PR과 섞지 않는다. 옮기는 PR은 동작을 바꾸지 않고, 시험은 그대로 통과해야 한다.
- PR #59의 래빗헌팅 상태 기계와 창은 다시 쓰지 않는다.

## 5. 배포

- 지금: main push → CI → 운영 D1 마이그레이션 → game-worker → api → admin. 스테이징 없음.
- 그래서 V4의 스키마 변경은 모두 **더하기만** 한다(새 칸은 NULL 허용이거나 기본값). 앞 버전 워커가 새 스키마에서, 새 워커가 서로 다른 순서로 올라가도 돌아야 한다.
- `0045_tournament_hands`: `hands.tournament_id`, `hands.tournament`, `hand_players.tournament_id`(모두 NULL 허용), `tournaments.record_hands`(기본 0). 기존 줄은 바뀌지 않는다.
- 제안(오너 결정): 스테이징 환경, 또는 배포 작업에 수동 승인.

## 6. 플래그

| 플래그 | 곳 | 기본 | 뜻 |
|---|---|---|---|
| `MTT_ENABLED` | API | 꺼짐 | MTT 열기 |
| `TOURNAMENT_HANDS_ENABLED` | API | 꺼짐 | 그 뒤에 여는 대회의 핸드 기록 |
