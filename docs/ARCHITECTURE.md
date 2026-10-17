# 아키텍처

## 구성

```
                       ┌──────────────── Cloudflare ─────────────────────────────────────┐
 Player browser ──────►│ jc-royal-api (Worker)                                            │
  jc-royal.site        │  • Static assets: apps/web (React SPA, _headers CSP)            │
                       │  • /api/*  Hono REST  ── D1 (jc-royal-db)                        │
                       │  • /ws/tables/:id  session cookie check → TableRoom DO           │
                       │                                   │ (DO binding, script_name)   │
                       │ jc-royal-game (Worker, no public routes)                         │
                       │  • TableRoom Durable Object × N (1 per table, SQLite storage)    │
                       │      WebSocket Hibernation · alarms · poker-engine-ts · D1      │
                       │                                                                  │
 Admin browser ───────►│ jc-royal-admin (Worker)                                          │
  admin.jc-royal.site  │  • Static assets: apps/admin   • /api/admin/* → API (service)    │
                       └──────────────────────────────────────────────────────────────────┘
```

| 패키지 | 역할 |
|---|---|
| `packages/poker-engine` | poker-engine-ts 어댑터(핸드 생성, 액션 매핑, 투영, 영속화, 정체 해소). 규칙 판단은 엔진만 한다 |
| `packages/types` | 공용 타입, zod 스키마(WebSocket 메시지, REST 입력) |
| `packages/db` | Drizzle D1 스키마, 마이그레이션, 원장 함수(`applyLedger`) |
| `packages/ui` | 디자인 토큰, 4개 테마, 공통 컴포넌트, 카드·칩 |
| `packages/audio` | 카드·칩 녹음 효과음(Pixabay), 그 밖의 소리와 불러오기 전·실패 시에는 Web Audio 합성음 |
| `apps/api` | REST, 인증, WS 진입, 정적 사이트 |
| `apps/game-worker` | TableRoom DO |
| `apps/web` / `apps/admin` | 사용자 / 관리자 SPA |

## 게임 흐름

```
클릭 → WS {t:'action', intentId, handId, seq, type, amount}
  → API Worker: 세션 쿠키 검증, Origin 검사 → DO로 신원 헤더 전달 (업그레이드 시 1회)
  → TableRoom: zod 검증 · 소켓 레이트 리밋 · 직렬화 큐(run)
  → seq 확인(오래된 화면 거부) · intentId 멱등
  → HandEngine.act → poker-engine-ts SessionManager.applyIntent (유일한 규칙 판단)
  → 정체 해소(블라인드 올인 등) · 칩 보존 검사
  → DO storage 저장(room + hand 이벤트 로그)
  → 보는 사람별 TableView 투영 + 연출 cue 브로드캐스트
  → 핸드 종료: 스택 반영 → D1 기록(hands, hand_players) → 알람으로 다음 핸드
```

- **플레이어별 투영**: 본인 홀카드와 쇼다운에서 공개된 카드만 담는다. 덱, 시드, 다른 사람 카드는 서버 밖으로 나가지 않는다.
- **연출 cue**: 칩 이동이나 카드 공개 같은 cue는 표시용이다. 화면은 항상 같이 받은 상태(TableView)를 그대로 그린다. 오래된 cue는 버린다.
- **타이머**: DO 알람 하나로 처리한다. 턴 마감, 다음 핸드, 대기열 예약 만료, 장기 자리비움 일어서기 중 가장 빠른 시각에 알람을 건다.

## 상태와 복구

| 상태 | 저장소 | 복구 방법 |
|---|---|---|
| 좌석, 버튼, 대기열, 버전 | DO storage `room` | 생성자에서 로드 |
| 진행 중 핸드 | DO storage `hand`(초기 스냅샷 + 이벤트 로그) | `HandEngine.restore` → 엔진 재생. 강제 종료 테스트로 동일성 확인 |
| 바이인 진행 중 좌석 | `phase: 'pending'` | 재시작 시 D1 원장 키 존재 여부로 확정 또는 취소 |
| 환급 진행 중 좌석 | `phase: 'cashing'` | 재시작 시 멱등 환급 재시도 |
| 정산된 핸드 | `settledHandId` | 미반영 시 재정산, D1 기록은 `INSERT OR IGNORE` |
| 대기 중 충전 | 좌석 `topUp.state: 'queued'` | 그대로 유지, 다음 정산(또는 핸드 시작 직전)에 적용 |
| 차감 중 충전 | 좌석 `topUp.state: 'debiting'` | 재시작 시 D1 원장 키가 있으면 원장이 차감한 금액만큼 스택에 반영, 없으면 취소. 원장에 이미 있는 키로는 이 표시를 만들지 않음(한 번만 반영) |
| 시간 은행 | DO storage `room`(회원별 남은 시간·이번 차례 마감) | 생성자에서 로드. 일어난 뒤 6시간·100명까지 보관해 다시 앉아도 늘지 않음(D1에 없음) |
| 토너먼트 진행 | D1 `tournaments`·`tournament_entries` + DO storage `room`(대회 좌석·스택·레벨·다음 레벨 시각·순위) | 생성자에서 로드. 레벨 시계는 벽시계 시각이라 재시작 뒤 첫 핸드에서 지난 레벨까지 오름(`docs/TOURNAMENT.md` 서버 재시작·장애) |

## 칩 경제

- **지갑**: `users.balance`. 반드시 `chip_ledger` 행과 같은 D1 batch(트랜잭션) 안에서만 바뀐다.
- **멱등 키**:

  | 거래 | 키 |
  |---|---|
  | 가입 지급 | `signup:<user>` |
  | 바이인 | `buyin:<tableSession>` |
  | 환급 | `cashout:<tableSession>` |
  | 스택 충전 | `topup:<tableSession>:<reqId>` |
  | 자동 리바이 | `rebuy:<tableSession>:<handId>` |
  | 관리자 조정 | `admin:<key>` |
  | 무료 칩 보충 | `refill:<user>:<seq>` |
  | 추천 보상 | `referral:<referral>:invitee`, `referral:<referral>:referrer` |
  | 봇 기금 지급 | `botfund:<tableSession>`(봇 지갑을 바이인 금액까지 채우고, 같은 batch에서 `bot_fund.issued`를 정책 한도 안에서 올림) |

- **테이블 칩**: 바이인 후에는 DO의 좌석 스택이 된다. 핸드 중에는 엔진 스냅샷이 기준이다. 봇도 같은 바이인·환급 원장을 쓰고, 이기거나 져도 원장 밖에서 칩을 만들거나 없애지 않는다.
- **토너먼트 칩**: 그 대회 안에서만 쓰는 숫자다. 지갑·`chip_ledger`·`table_sessions`와 이어지지 않고, 룸은 대회 좌석에 원장을 부르는 경로(바이인·충전·자동 리바이·캐시아웃)를 막는다(`docs/TOURNAMENT.md`).
- **스택 충전(`top_up`)**: 핸드 사이에만 스택에 더한다. 핸드에 참여 중인 요청은 차감 없이 대기했다가 정산 직후 적용한다. 충전 후 스택은 테이블 바이인 범위 안이어야 하고, 같은 착석 세션 안에서 원장 키로 한 번만 차감된다. 자동 리바이는 기본 꺼짐이며, 켤 때 명시적 동의·1회 금액·총 한도가 필요하다(한도를 다 쓰거나 지갑이 부족하면 꺼진다).
- **검증 두 가지**:
  1. 게임 내 칩 보존: 매 액션마다 스택+팟 합계를 확인한다.
  2. 원장 검증: 관리자 정합성 검사에서 `balance = Σ ledger`인지, 열린 착석 세션 수와 룸 좌석 수가 맞는지 확인한다. 불일치는 `reconciliation_events`에 기록하고, 관리자가 명시적으로 해결 처리한다.
- 모든 금액은 정수다. 클라이언트가 보낸 금액은 엔진의 합법 범위를 통과해야만 반영된다.

## 데이터 모델 (D1)

정의는 `packages/db/src/schema.ts`, 마이그레이션은 `packages/db/migrations/`(`0000`–`0028`, 배포 순서는 `docs/DEPLOYMENT.md` 3절).

| 영역 | 테이블 |
|---|---|
| 계정 | `users`, `sessions`, `password_resets`, `email_verifications`, `user_settings` |
| 칩·게임 | `chip_ledger`, `tables`, `table_sessions`, `hands`, `hand_players`, `hand_notes`, `reconciliation_events` |
| 정책(버전으로 쌓고 최신 행이 현재 정책) | `refill_policies`, `bot_policies`, `time_bank_policies`, `social_policies`, `referral_policies` |
| 무료 칩·봇·추천 | `refill_claims`, `bot_fund`, `bot_events`, `referral_codes`, `referrals` |
| 토너먼트 | `tournament_templates`, `tournaments`, `tournament_entries` |
| 커뮤니티·소셜 | `posts`, `post_hands`, `comments`, `messages`, `friendships`, `user_blocks`, `direct_messages`, `reports`, `report_events` |
| 아카데미 | `academy_progress`, `user_badges`, `academy_stats` |
| 운영 | `admin_audit_log`, `admin_permissions`, `admin_notes`, `service_notices`, `maintenance_windows`, `ops_metrics`, `active_days`, `daily_stats`, `rate_limits` |

**관리자 권한**: 요청마다 역할 권한 표와 그 관리자의 기능 스위치(`admin_permissions`, 기본 거부)를 함께 검사한다. 최고관리자는 스위치를 읽지 않는다. 경제 정책·대회 구조처럼 위임하지 않는 작업은 최고관리자 전용이다(`docs/ADMIN_SECURITY.md`).

**플레이 통계**: `hand_players`의 `position`·`vpip`·`pfr`·`saw_flop`·`pot_won`은 핸드 이벤트 로그(`hands.event_log`)에서 계산한 값이다. 계산은 `packages/db/src/handStats.ts`의 SQL 하나(`HAND_STATS_SQL`)뿐이며, 게임 워커가 핸드 기록 직후 실행하고 마이그레이션 `0010`이 같은 SQL로 기존 핸드를 채운다. `pot_won`이 비어 있는 행만 처리하므로 몇 번을 돌려도 결과가 같고, 실행이 실패해도 다음 핸드 기록 때 다시 채운다. 로그에서 행동을 읽을 수 없는 핸드는 `vpip`·`pfr`·`saw_flop`을 NULL로 두어 해당 지표의 분모에서 뺀다(추정하지 않음). 마이페이지 통계 API는 이 열을 모아 본인 것만 돌려준다.

## 원본 저장소에서 가져온 것

| 출처 | 가져온 것 |
|---|---|
| Elite-Poker(MIT) | 카드·칩·좌석·타이머·액션바·테마·효과음 구조를 TypeScript로 재작성 |
| poker-engine-ts(MIT) | 의존성으로 사용(최소 패치 1건) |
| Ai-Poker | 라이선스가 불명확해 코드는 쓰지 않음. 구조만 참고 |

자세한 내용은 `THIRD_PARTY_NOTICES.md`와 `docs/INTEGRATION_ANALYSIS.md` 참고.
