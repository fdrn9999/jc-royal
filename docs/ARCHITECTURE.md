# 아키텍처

## 구성

```
                       ┌──────────────── Cloudflare ─────────────────────────────────────┐
 Player browser ──────►│ jc-royal-api (Worker)                                            │
  jcroyal.example      │  • Static assets: apps/web (React SPA, _headers CSP)            │
                       │  • /api/*  Hono REST  ── D1 (jc-royal-db)                        │
                       │  • /ws/tables/:id  session cookie check → TableRoom DO           │
                       │                                   │ (DO binding, script_name)   │
                       │ jc-royal-game (Worker, no public routes)                         │
                       │  • TableRoom Durable Object × N (1 per table, SQLite storage)    │
                       │      WebSocket Hibernation · alarms · poker-engine-ts · D1      │
                       │                                                                  │
 Admin browser ───────►│ jc-royal-admin (Worker)                                          │
  admin.jcroyal.example│  • Static assets: apps/admin   • /api/admin/* → API (service)    │
                       └──────────────────────────────────────────────────────────────────┘
```

| 패키지 | 역할 |
|---|---|
| `packages/poker-engine` | poker-engine-ts 어댑터(핸드 생성, 액션 매핑, 투영, 영속화, 정체 해소). 규칙 판단은 엔진만 한다 |
| `packages/types` | 공용 타입, zod 스키마(WebSocket 메시지, REST 입력) |
| `packages/db` | Drizzle D1 스키마, 마이그레이션, 원장 함수(`applyLedger`) |
| `packages/ui` | 디자인 토큰, 4개 테마, 공통 컴포넌트, 카드·칩 |
| `packages/audio` | Web Audio 합성 효과음 |
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

## 칩 경제

- **지갑**: `users.balance`. 반드시 `chip_ledger` 행과 같은 D1 batch(트랜잭션) 안에서만 바뀐다.
- **멱등 키**:

  | 거래 | 키 |
  |---|---|
  | 가입 지급 | `signup:<user>` |
  | 바이인 | `buyin:<tableSession>` |
  | 환급 | `cashout:<tableSession>` |
  | 관리자 조정 | `admin:<key>` |

- **테이블 칩**: 바이인 후에는 DO의 좌석 스택이 된다. 핸드 중에는 엔진 스냅샷이 기준이다.
- **검증 두 가지**:
  1. 게임 내 칩 보존: 매 액션마다 스택+팟 합계를 확인한다.
  2. 원장 검증: 관리자 정합성 검사에서 `balance = Σ ledger`인지, 열린 착석 세션 수와 룸 좌석 수가 맞는지 확인한다. 불일치는 `reconciliation_events`에 기록하고, 관리자가 명시적으로 해결 처리한다.
- 모든 금액은 정수다. 클라이언트가 보낸 금액은 엔진의 합법 범위를 통과해야만 반영된다.

## 데이터 모델 (D1)

`users`, `sessions`, `password_resets`, `chip_ledger`, `tables`, `table_sessions`, `hands`, `hand_players`, `admin_audit_log`, `reconciliation_events`, `rate_limits`, `posts`, `post_hands`, `comments`, `messages` — 정의는 `packages/db/src/schema.ts`, 마이그레이션은 `packages/db/migrations/`.

## 원본 저장소에서 가져온 것

| 출처 | 가져온 것 |
|---|---|
| Elite-Poker(MIT) | 카드·칩·좌석·타이머·액션바·테마·효과음 구조를 TypeScript로 재작성 |
| poker-engine-ts(MIT) | 의존성으로 사용(최소 패치 1건) |
| Ai-Poker | 라이선스가 불명확해 코드는 쓰지 않음. 구조만 참고 |

자세한 내용은 `THIRD_PARTY_NOTICES.md`와 `docs/INTEGRATION_ANALYSIS.md` 참고.
