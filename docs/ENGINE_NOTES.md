# poker-engine-ts 통합 노트

JC ROYAL은 `poker-engine-ts@0.1.3`(MIT)을 게임 규칙의 **유일한 판단 주체**로 사용한다. 합법 액션, 턴 순서, 스트리트 진행, 쇼다운 평가, 팟·사이드팟 정산은 모두 엔진의 `SessionManager.applyIntent`가 결정한다. 어댑터(`packages/poker-engine`)는 엔진이 호스트에게 맡기는 부분과, 통합 과정에서 발견한 엔진 결함의 보정만 담당한다.

## 어댑터의 책임

| 항목 | 내용 |
|---|---|
| 덱 | `crypto.getRandomValues` + 거부 샘플링 Fisher–Yates(`secureShuffledDeck`). 고정 덱은 테스트에서만 `deck` 인자로 주입 |
| 핸드 단위 세션 | 핸드마다 새 `SessionManager`를 만든다. 좌석·버튼(`nextButtonSeat`)·블라인드는 테이블 룸이 결정 |
| 홀카드 배분 | 버튼 왼쪽부터 시계방향으로 `dealHoleCards`. 결과를 `initialSnapshot`에 넣고 `SessionManager.resume` |
| 액션 매핑 | UI 액션(`fold/check/call/bet/raise/allin`, bet·raise는 "to" 총액)을 엔진 intent로 변환. intent id 멱등성(중복 제출 거부) |
| 투영 | 보는 사람별 좌석 정보. 본인 홀카드와 쇼다운 공개 카드만 포함(`partitionShowdownByVisibility`) |
| 공개 액션 | `publicActions()`: 지금까지의 액션(블라인드 포함, 좌석·스트리트·종류·넣은 칩). 비공개 정보가 없어 핸드 중에도 쓸 수 있고, 핸드 기록의 `actions`와 테이블 봇(`docs/BOT_AI.md`)이 같은 목록을 쓴다 |
| 영속화 | `persist()` → JSON(초기 스냅샷 + 이벤트 로그). `restore()`는 로그 재생으로 상태를 재구성 |
| 무결성 | 매 액션 후 칩 총량(스택+팟) 보존을 검사. 어긋나면 예외를 던져 해당 핸드는 정산되지 않음 |

## 발견한 엔진 결함과 보정

속성 기반 테스트와 고정 덱 규칙 테스트로 발견했다. 엔진 소스를 복제하지 않고, 공개 데이터 구조 보정 3건과 최소 패치 1건으로 해결했다.

### 1. 블라인드가 라운드 기여액에 기록되지 않음 (과다 청구)

- **증상**: 3인 5/10 테이블에서 SB가 콜하면 5가 아니라 10을 더 낸다. BB는 림프 팟에서 체크할 수 없고 10을 더 내야 한다.
- **원인**: `bootstrapSession`의 `applyBlinds`는 스택만 차감한다. 반면 베팅 계산(`deriveRoundComputation`)은 라운드의 `turns` 안에 있는 `post-blind` 이벤트로 기여액을 계산한다(엔진 자체 테스트 `short-all-in-reopen.test.ts`도 이렇게 구성한다).
- **보정(어댑터)**: 핸드 시작 시 실제로 포스팅된 금액(`pots.main.contributions`)으로 `post-blind` 턴을 `initialSnapshot`의 프리플랍 라운드에 기록한다.

### 2. 블라인드 포스팅을 "이미 행동함"으로 간주 (BB 옵션 소실) — **패치**

- **증상**: 1번을 보정하면 림프가 돌고 나서 BB에게 차례가 오지 않고 바로 플랍이 열린다.
- **원인**: `reduce`의 `determineNextActor`와 셀렉터의 `derivePlayersLeftToAct`가 `post-blind` 턴의 주인을 "이번 라운드에 행동한 사람"에 포함한다. 같은 엔진의 `round-context.ts` 주석("the big blind keeps its option even after a round of limps")과도 모순된다.
- **패치**: `patches/poker-engine-ts@0.1.3.patch`(pnpm `patchedDependencies`). 두 곳에서 `post-blind`/`post-ante` 턴을 행동 집합에서 제외한다(각 1줄).
- **검증**: 패치를 되돌리면 규칙 테스트가 실패하고(헤즈업 체크다운 10건 등), 복원하면 26건이 모두 통과한다.

### 3. 블라인드로 스택이 0이 된 플레이어를 탈락으로 처리 (핸드 정지)

- **증상**: 숏스택이 블라인드만으로 올인되면, 행동할 사람이 없는 상태로 프리플랍에서 핸드가 멈춘다. 또 스택 0인 플레이어에게 폴드/체크를 제시한다.
- **원인**:
  - `applyContributionToSeat`가 스택 0을 `status: 'leaving'` + `pendingEliminations`로 표시한다. 그러면 `resolveActivePlayers`에서 빠져 스트리트가 진행되지 않는다.
  - 자동 런아웃(`applyAutoRunout`)은 이벤트 처리 후에만 실행된다.
- **보정(어댑터)**:
  1. 초기 스냅샷에서 해당 좌석을 `occupied`로 되돌리고 `pendingEliminations`를 비운다. 액션으로 올인한 경우와 같은 표현이다.
  2. `isStalled()`는 다음 경우를 "정체"로 판단한다. 이때 클라이언트에는 선택지를 주지 않는다.
     - 행동할 사람이 없음
     - 액터의 스택이 0
     - 액터에게 가능한 액션이 없음
  3. `resolveStall()`은 칩 이동이 없는 엔진 표준 `timeout`(fallback: check) 이벤트를 제출해 엔진이 직접 런아웃·정산하게 한다. 규칙 판단은 계속 엔진이 한다.

### 4. 재생 시 시계 의존 필드

- **증상**: 로그로 복원한 스냅샷의 `clock.deadline`이 1ms 다르다.
- **원인**: 재생 중 스트리트 자동 진행이 현재 시각(`now()`)을 사용한다.
- **보정**: `restore()`는 시계를 마지막 이벤트 시각에 고정한 상태로 재생한다. 턴 타이머는 엔진의 `deadline`이 아니라 어댑터의 `turnStartedAt + turnMs`를 쓴다.

## 지원 범위와 제한

- 테이블 정원: 엔진 `maxSeats` 타입에 따라 **2·6·9석**. 지시서의 10인 테이블은 지원하지 않는다(`INTEGRATION_ANALYSIS.md` §3.1).
- 쇼다운 공개 정책:
  - 쇼다운에 참여한 핸드는 기본적으로 모두 공개한다.
  - 승자는 항상 공개한다. 패자의 자동 머크는 `autoMuck` 집합으로 선택할 수 있다(엔진 `partitionShowdownByVisibility`). 룸은 2026-10-19부터 그 핸드에 카드를 받은 모든 플레이어를 넘겨 항상 머크한다(엔진은 그대로, `docs/WEBSOCKET_PROTOCOL.md` '쇼다운 머크').
- 홀수 칩: 엔진 정산 규칙을 따른다(스플릿 25 → 12/13, 결정적).
- 숏 올인 재오픈 제한: 엔진 규칙 그대로 적용한다(이미 행동한 플레이어는 콜/폴드만 가능).

## 테스트 (`pnpm --filter @jc/poker-engine test`)

- `test/rules.test.ts` 24건:
  - 족보 10종의 쇼다운 판정(로열 플러시는 표시용으로 파생)
  - 블라인드와 BB 옵션, 헤즈업 순서, 최소 레이즈, 숏 올인 재오픈 금지
  - 3인 올인 사이드팟(900/800/300), 스플릿과 홀수 칩, 폴드 승리 시 카드 비공개, 블라인드 올인
  - 중복·차례 아님·불법 금액 거부, 타임아웃(체크/폴드)
  - 비공개 카드 차단, 직렬화 후 복원과 이어서 진행, 복원 후 중복 intent 거부, 버튼 이동, 핸드 기록
- `test/property.test.ts`(fast-check) 2,000 + 2,000 핸드:
  - 2·6·9석, 무작위 좌석·스택(1~3000)·버튼, 무작위 합법 액션과 주기적 타임아웃, 무작위 시점 복원
  - 불변식:
    - 매 액션 후 칩 총량 보존, 음수 스택 없음
    - 핸드가 항상 정산까지 진행됨
    - 복원 상태가 원본과 동일
    - 다른 플레이어의 홀카드 비노출
    - 정산 합계 = 팟, 순손익 합계 = 0
  - 폴드 회피 실행 기준 2,000핸드 전부 쇼다운 도달, 사이드팟 실지급 1,835건, 정체 해소 127건
