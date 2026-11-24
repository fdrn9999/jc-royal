# JC-ROYAL V4 플랫폼 감사 (Phase 1)

- 기준 커밋: `e319d264312533f19f31d164c5df153d12bec317` (main, PR #59 병합). 2026-11-24에 `origin/main`과 같은 것을 확인했다.
- 방법: 문서가 아니라 코드를 읽었다. 여섯 영역(D1 쿼리, 엔진·봇·시험, 보안, MTT 신뢰성, 번들, 기능 대조)을 나눠 읽고, 이 문서에 올린 것 가운데 **[확인]** 은 이 작업에서 파일을 직접 열거나 실행해 본 것, **[보고]** 는 코드 읽기에서 나온 결론으로 실행해 재현하지는 않은 것, **[추정]** 은 일어날 수 있다고 본 것일 뿐인 것이다.
- JC-ROYAL은 가상 칩 전용이다. 이 감사와 V4의 어떤 항목도 현금 입출금·환전·현금성 보상·칩 양도를 더하지 않는다.

## 1. 요약

| 우선 | 항목 | 분류 | 상태 |
|---|---|---|---|
| **P0** | 대회 핸드가 기록되지 않아 대회 HUD 통계가 언제나 0 | Partially Implemented | **재현, 이 Phase에서 고침**(기본 꺼짐 플래그) |
| P1 | 운영자 복구 화면이 MTT 테이블을 보지 못한다 | Partially Implemented | 보고, Phase 4 |
| P1 | 대회 칩 보존을 실행 중에 확인하지 않는다 | Missing | 보고, Phase 4 |
| P1 | MTT 조정자 재구성 뒤 손 수 중복·타임뱅크 소실 | Technical Debt | 보고(일부 추정), Phase 4 |
| P1 | main에 push하면 바로 운영 배포(스테이징·되돌리기 없음) | Technical Debt | 확인, 오너 결정 필요 |
| P1 | 첫 화면 JS 647 KB(한도 650 KB) | Performance Risk | 확인(측정), Phase 3 |
| P2 | 관리자 콘솔에 2단계 인증이 없다 | Security Risk | 보고, Phase 2 후속 |
| P2 | 전체 기간 집계 쿼리(프로필 카드·내 통계·관리자) | Performance Risk | 보고, Phase 3 |
| P2 | `room.ts` 한 파일에 룸의 거의 모든 책임 | Technical Debt | 확인, Phase 3부터 순수 함수만 |
| P2 | 낡은 문서(`STATUS.md`, `V3_ANALYSIS.md`)가 코드와 어긋난다 | Technical Debt | 확인 |
| P3 | 보안 소소한 것 7건(아래 5절) | Security Risk | 보고 |

P0는 하나뿐이다. 보안에서 P0·P1은 나오지 않았다.

## 2. P0 — 대회 핸드 기록과 대회 통계

### 재현 [확인]

`tests/integration/tournament-hands.test.ts`의 첫 시험이 그대로 재현이다. 두 사람이 SNG를 끝까지 친 뒤:

- `tournaments.hands`는 1 이상인데 `hands`·`hand_players`에는 그 테이블의 줄이 하나도 없다.
- `GET /api/players/:id/hud?scope=tournament`의 `stats.hands`는 0이다.

main에도 같은 사실을 단언하는 시험이 이미 있었다(`tests/integration/tournaments.test.ts`의 `SELECT id FROM hands WHERE table_id = …` → `[]`). 대회 범위 HUD를 다룬 기존 시험(`tests/integration/players.test.ts`)은 `hands` 줄을 SQL로 직접 넣어서만 통과했다.

### 원인 가설과 판정

| 가설 | 판정 | 근거 |
|---|---|---|
| 룸이 대회 핸드를 D1에 쓰지 않는다 | **확인** | `apps/game-worker/src/room.ts` `settle()`의 대회 갈래는 `recordHand`를 부르지 않았다. `docs/TOURNAMENT.md`도 "제외"로 적었다 |
| HUD의 대회 범위 조건이 틀렸다 | 기각 | `apps/api/src/routes/players.ts`의 `COALESCE(t.room_type,'') = 'tournament'` 조건은 줄을 넣어 주면 맞게 센다(기존 시험, 새 시험) |
| 통계 SQL(`HAND_STATS_SQL`)이 대회 줄을 채우지 못한다 | 기각 | 기록을 켠 대회에서 `vpip.of > 0`으로 채워진다(새 시험) |
| 대회 테이블의 `room_type`이 달라 조인이 빠진다 | 기각 | 같은 시험에서 대회 범위가 기록한 핸드 수와 같게 센다 |

즉 "쓰는 쪽 없이 읽는 쪽만 나중에 생긴" 것이다. 처음(커밋 `ff5cce7`)에는 일부러 뺀 설계였고, 뒤에 HUD의 대회 범위가 더해지면서 빈 통계가 되었다.

### 고친 것

`docs/TOURNAMENT.md` "대회 핸드 기록"에 계약을 적었다. 요점:

- API 환경 변수 `TOURNAMENT_HANDS_ENABLED=1`일 때 **그 뒤에 여는** 대회만 `tournaments.record_hands = 1`을 받는다. 기본은 꺼짐이고, 이미 있는 대회와 지난 대회 핸드는 바뀌지 않는다(지난 핸드를 지어내지 않는다).
- 룸은 대회 핸드를 캐시 핸드와 같은 길(결과와 함께 룸 저장소에 두었다가 D1에 들어갈 때까지 다시 시도)로 기록한다. `INSERT OR IGNORE`와 기존 가드로 한 번만 들어간다.
- 지갑·칩 원장은 쓰지 않는다. 캐시 전용 집계(내 통계, 프로필 카드, 관리자 손익, 추천 조건, 신규 판정, 대회 참가 조건, 업적, 챌린지)는 `tournament_id IS NULL`로 대회 핸드를 뺀다.
- 핸드 기록 목록은 대회 핸드에 `tournament` 표시와 그 레벨의 빅 블라인드를 준다.

## 3. 기능 대조 (10개 분류)

| 영역 | 분류 | 근거 / 메모 |
|---|---|---|
| NLHE 엔진(`poker-engine-ts` 어댑터), 사이드팟, 최소 레이즈 ×2 | Fully Implemented | 엔진 시험 134건 통과 [확인]. 빠진 시험: 홀수 칩 받는 자리, 헤즈업 짧은 블라인드 올인 [보고] |
| 선택형 규칙 세트(JC Royal Custom / Standard NLHE) | Missing | `minRaisePolicy: 'double-highest-bet'`가 `packages/poker-engine/src/hand.ts`에 고정 [확인]. 핸드별 스냅샷 자리는 있다 [보고] |
| 앤티, BB 앤티 | Missing | `antePolicy: { type: 'none' }` [확인] |
| 캐시 테이블, 바이인·캐시아웃, 원장 | Fully Implemented | 통합 시험이 덮는다 |
| SNG, 비공개 대회 | Fully Implemented | |
| MTT | Implemented but Disabled | `MTT_ENABLED` 뒤. 60명 상한, 휴식·핸드 포 핸드·예약 시작 없음 [보고] |
| 대회 핸드 기록·통계 | Partially Implemented → 이 Phase에서 기본 꺼짐으로 구현 | 2절 |
| 핸드 히스토리·리플레이·메모·태그 | Fully Implemented | 내보내기는 Missing |
| HUD(막대 포함), 래빗헌팅 | Fully Implemented | PR #58, #59. 손대지 않는다 |
| 내 통계·포지션별 | Fully Implemented | 세션 리포트, 헤즈업/멀티웨이 분리는 Missing |
| 플레이어 메모 | Missing | |
| 포커 랩(학습) | Partially Implemented | 솔버 연결 자리만 있다: `apps/web/src/game/strategy.ts` `SOLVER_PROVIDERS = []` [확인]. 핸드 트레이너 Missing |
| 봇 AI | Fully Implemented | 자기 홀카드와 공개 정보만 쓴다 [보고]. 약점: 멀티웨이 스퀴즈 셔브, 턴 배럴 방어 [보고]. 시뮬 하네스는 CI에 없다 |
| 관전 | Partially Implemented | 방송·OBS·지연 관전 Missing. 비공개 테이블이 `allowSpectators` 기본값으로 코드 없이 보이는지 확인 필요 [추정] |
| 페어플레이 신호 | Partially Implemented | 신호만, 자동 제재 없음(유지) |
| 소셜(친구·초대·반응) | Fully Implemented | 아바타 업로드 Missing |
| 관리자 콘솔 | Fully Implemented | 분당 핸드 수, 기록 못 한 핸드 탐지, 상태 페이지, 문의 티켓 Missing |
| PWA | Partially Implemented | 서비스 워커는 푸시 전용 |
| 스테이징 환경 | Missing | 4절 |

중복(Duplicated)·폐기(Deprecated)로 분류할 기능은 찾지 못했다. Implemented but Unverified: 실기기 PWA 설치, 운영 규모 부하(운영에 부하 시험을 걸지 않는다).

## 4. 배포·시험 [확인]

- `.github/workflows/ci.yml`은 main에 push될 때 돌고, 초록이면 `deploy.yml`을 부른다. `deploy.yml`은 운영 D1에 마이그레이션을 적용한 뒤 game-worker → api → admin 순으로 올린다. 스테이징도 자동 되돌리기도 없다.
- 따라서 **main 병합이 곧 운영 배포다.** V4의 모든 PR은 오너가 병합한다.
- CI 한 벌은 90분 제한 안에서 62–85분이 걸린다 [보고]. 통합 시험이 그 대부분이다.

## 5. 보안 [보고]

P0·P1 없음. 실행해 재현한 것은 없다.

| 우선 | 항목 | 위치 |
|---|---|---|
| P2 | 관리자 콘솔 2단계 인증 없음 | `docs/ADMIN_SECURITY.md` |
| P3 | 특정 계정 로그인 잠금 유도 | 인증 라우트 |
| P3 | 비밀번호 재확인에 요청 제한 없음 | `apps/api/src/routes/auth.ts` |
| P3 | 비밀번호를 바꿔도 재설정 토큰이 남는다 | 같은 파일 |
| P3 | 시험용 조절값이 `ENVIRONMENT`로 막히지 않는다 | env |
| P3 | 푸시 구독 해지가 호출자로 한정되지 않는다 | `apps/api/src/routes/notifications.ts` |
| P3 | 부트스트랩 토큰 비교가 상수 시간이 아니다 | 관리자 부트스트랩 |
| P3 | CSP·HSTS 헤더 없음 | 웹·관리자 응답 |

숨은 카드: 룸은 진행 중인 핸드의 덱을 내보내지 않고(PR #59에서 다시 확인), 리플레이는 쇼다운에서 보인 카드만 준다. 대회 핸드도 같은 리플레이 길을 쓴다.

## 6. 성능

- 첫 화면 JS: 647.4 KB / 650 KB [확인, `pnpm check:bundle`]. 측정으로 확인한 줄이는 길 [보고, 실험 빌드]: `SettingsModal` 지연 로드 → 603.8, `Arrivals` → 600.7, `InstallOffer` → 597.7, 학습 동기화 동적 import → 596.7. 한도를 올리지 않고 600 KB 아래로 갈 수 있다. Phase 3.
- D1 [보고]: 프로필 카드와 `/api/me/stats`의 전체 기간 집계, 관리자 목록의 스캔+정렬+OFFSET, 리더보드가 끝난 대회를 모두 읽는 것(`tournaments(status, finished_at)` 색인 제안), 핸드 하나에 D1 왕복 5번. 플레이어별 누적 카운터가 없다.
- 이 Phase의 변경: 대회 핸드를 기록하는 대회에서만 핸드당 D1 쓰기가 캐시 핸드와 같은 만큼 생긴다(업적·챌린지 두 묶음은 뺀다). 꺼져 있으면 달라지는 것이 없다. 따로 재지는 않았다.

## 7. MTT 신뢰성 [보고]

- A. 복구 화면: `apps/api/src/routes/admin-tournaments.ts`의 `ROW_FROM`이 `tn.table_id`로만 테이블을 붙인다 [확인]. MTT는 `table_id`가 비어 있어 "끝났는데 테이블이 안 닫힘" 조건에 걸리지 않는다.
- B. 칩 보존: 우승자의 스택을 `참가자 수 × 시작 스택`으로 덮어쓴다. 실행 중 합계 확인이 없다.
- C. 조정자 재구성(`apps/game-worker/src/mtt.ts`): 순번이 처음으로 돌아가 손 수를 두 번 셀 수 있고, 타임뱅크가 사라진다. 떨어져 있던 자리의 재배치에서 같은 자리가 겹칠 수 있다는 것은 **추정**이다.
- 장애 주입 시험이 없다.

`MTT_ENABLED`는 운영에서 임의로 켜지 않는다.

## 8. 낡은 문서 [확인]

`docs/STATUS.md`, `docs/V3_ANALYSIS.md`, `docs/ENGINE_NOTES.md`의 일부 줄과 `packages/poker-engine/src/deck.ts`의 주석이 지금 코드와 다르다. 이 Phase에서는 고치지 않고(범위 밖), V4 문서를 기준으로 삼는다. `docs/TOURNAMENT.md`는 이번 변경에 맞춰 고쳤다.

## 9. 오너 승인이 필요한 것

1. 이 PR들의 main 병합(= 운영 배포, 마이그레이션 `0045_tournament_hands` 적용 포함).
2. 운영에서 `TOURNAMENT_HANDS_ENABLED=1`을 켜는 것.
3. `MTT_ENABLED`.
4. 스테이징 환경을 만들지, 배포를 수동 승인으로 바꿀지.
