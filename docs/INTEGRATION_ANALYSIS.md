# JC ROYAL — 통합 분석 보고서 (Phase 1)

작성일: 2026-10-14 · 기준 지시서: `docs/DIRECTIVE.md`

분석 대상(모두 실제 clone 후 파일 단위로 확인):

| 저장소 | 커밋 | 파일 수 | 라이선스 |
|---|---|---|---|
| opadips/Elite-Poker | `4e38645` (2026-08-26) | 80 | MIT (LICENSE 파일 존재, © 2026 OpaDips) |
| Apoorv-16/Ai-Poker | `b18bd3c` (2026-02-01) | 98 | **불명확** — README에 "MIT" 한 줄, LICENSE 파일·package.json license 필드 없음 |
| Ge-limin/poker-engine-ts | `6aa64b8` (2026-07-05) / npm `0.1.3` | 146 | MIT (LICENSE 파일 존재, © 2026 Limin Ge) |

---

## 1. 저장소별 구조와 핵심 파일

### 1.1 poker-engine-ts — 게임 규칙의 단일 기준

- **형태**: 순수 TypeScript 라이브러리, ESM, 런타임 의존성 `@noble/hashes` 1개. npm에 `poker-engine-ts@0.1.3` 공개.
- **핵심 모듈**
  - `session/session-manager.ts` — `SessionManager.create / resume / applyIntent / advanceHand / rewindTo`. `applyIntent`는 내부 async mutex로 직렬화.
  - `session/lifecycle.ts` — `bootstrapSession`, `dealHoleCards`, `completeHand`, `transitionSeat`.
  - `core/intent/validate-intent.ts`, `legal-options.ts` — 합법 액션 판정, 최소 레이즈, 숏 올인 재오픈 제한.
  - `core/reducer/reduce.ts`, `pot-ledger.ts`, `reducer/settle-pots.ts` — 이벤트 리듀서, 사이드팟, 정산.
  - `evaluation/showdown-evaluator.ts` — 7카드 평가기(자체 구현).
  - `session/selectors.ts` — `selectDecisionContext`(현재 액터·합법 옵션), `selectTableView`.
- **상태 모델**: `Session { initialSnapshot, events[], activeSnapshot }`. `activeSnapshot = reduce(initialSnapshot, events)`. 이벤트는 `TurnEventEnvelope`로 버전 관리.
- **README ↔ 코드 일치 여부**: 대체로 일치. 단, README가 밝히듯 `SessionManager.create`는 **홀카드를 배분하지 않는다**. 플레이그라운드/`generateRandomState`는 `dealHoleCards` 후 `initialSnapshot.cards`를 패치하고 `SessionManager.resume`으로 다시 구성한다. 우리도 이 공개 API 조합을 그대로 쓴다.
- **제약**
  - `SessionConfig.maxSeats`가 타입으로 `2 | 6 | 9`만 허용(README: "tables of 2, 6, or 9 seats"). 지시서의 **10인 테이블은 엔진 공식 범위 밖** → §3.1 참조.
  - `advanceHand`(다음 핸드)는 `blindSchedule[0]`과 이전 덱 시드를 재사용하며, 좌석 변경은 세션 밖 함수(`transitionSeat`)로만 가능. → 우리는 **핸드마다 새 SessionManager를 생성**하고 좌석·버튼·덱은 어댑터가 결정(§4.2).
  - 덱 셔플은 엔진 책임이 아님(외부에서 `deck` 주입). → 서버에서 `crypto.getRandomValues` 기반 셔플.

#### 엔진 검증 spike (실제 실행 결과, `npx tsx spike.ts`)

| 검증 | 결과 |
|---|---|
| 3인(300/700/1000) 프리플랍 올인 | 메인 900(A, 트립스), 사이드1 800(B), 사이드2 300(C 단독 반환). 총합 2000 = 2000 ✅ |
| 핸드 도중 JSON 직렬화 → `SessionManager.resume` | `activeSnapshot` 완전 일치 ✅ |
| 같은 intent 재제출 | `rejected: version-mismatch` ✅ (추가로 어댑터에서 intent id 멱등 처리) |
| 헤즈업 블라인드 | 버튼=SB, 프리플랍 선행 액션=버튼 ✅ |
| `timeout` (fallback fold) | 수락, 상대에게 팟 15 지급 ✅ |
| Edge 호환성 | dist 번들에 `node:` import·`process`·`Buffer` 없음. `structuredClone`만 사용 ✅ (Workers 지원) |

### 1.2 Elite-Poker — UI/UX 기준

- **Frontend** (`frontend/`, React 18 + Vite 4 + Tailwind 3, JSX)
  - `GameTable.jsx` — 테이블 화면 오케스트레이션, 칩 애니메이션 큐(`processQueue`, 동시 비행 칩 제한, 성능 모드).
  - `components/Card.jsx` — SVG 패턴 카드 뒷면 6종, 카드 앞면, `card-reveal-*` 애니메이션.
  - `components/PlayerSeat.jsx` — 좌석 카드, SB/BB/DEALER 배지, 마지막 액션 라벨, 올인/폴드/승자 표시, TimerRing.
  - `components/Table.jsx` — 타원 레일 + 펠트, 팟 칩스택, 커뮤니티 카드 순차 공개(`card-reveal-spin`).
  - `components/AnimatedChip.jsx`, `ChipStack.jsx` — 포탈 기반 포물선 칩 이동, 액면가별 칩 색상.
  - `components/TimerRing.jsx` — 좌석 테두리를 따라 줄어드는 SVG 타이머.
  - `components/ActionButtons.jsx` — 폴드/체크/콜/레이즈(슬라이더, 프리셋)/올인 바.
  - `hooks/useSound.js` — 단일 AudioContext + 오실레이터/노이즈 합성 효과음(카드, 칩, 승리, 타이머, 올인).
  - `hooks/usePlayerPositions.js` — 타원 둘레 좌석 좌표, 본인 좌석 하단 고정.
  - `styles/themes.css` — CSS 변수 기반 6테마, `animations.css`.
  - 기타: `Chat.jsx`, `GameOverlays.jsx`, `SettingsPanel.jsx`, `LobbyList.jsx`, `Leaderboard.jsx`, `BettingPanel.jsx`(사이드벳), `utils/equity.js`.
- **Backend** (`backend/`, Node + express + ws)
  - 자체 게임 엔진: `game/Game.js`, `BettingRound.js`, `PotManager.js`, `HandEvaluator.js`, `Deck.js`.
  - 인증 없음(닉네임만 입력), 상태 전부 프로세스 메모리.
- **문제점**
  - `Deck.js`: `Math.random` 셔플 — 암호학적으로 안전하지 않음.
  - `Game.getState()`가 **모든 플레이어의 `holeCards`를 그대로 직렬화**(`game/Game.js:377`) — 다른 플레이어의 비공개 카드가 클라이언트로 전송될 수 있는 구조.
  - `BettingPanel.jsx` 사이드벳(1.5배 지급) — 칩 경제 밖 베팅 기능, 지시서 범위 외.
  - 테마 중 `neon`, `aurora`는 지시서의 "네온 지양" 방향과 충돌.
  - 일부 주석이 페르시아어, UI 문자열 하드코딩(영어).

### 1.3 Ai-Poker — 회원/관리 기준 (구조 참고 전용)

- **구성**: Turborepo, `apps/backend`(Hono), `apps/websocket`(`ws` 패키지 + 자체 게임 로직), `apps/user-frontend`, `apps/admin-frontend`(React 18, Vite 5, Tailwind 3, zustand), `packages/db`(Drizzle + Postgres), `packages/types`, `packages/ui`(shadcn 스타일).
- **실제 DB 계층은 Drizzle**. `prisma/schema.prisma`는 모델 없는 잔재.
- **인증**: bcryptjs(cost 10) + 7일 JWT(HS256), `Authorization: Bearer`, 토큰을 localStorage에 저장. 역할은 `isAdmin` boolean 하나.
- **스키마**: `users`(balance 기본 50000), `rooms`, `table_players`, `transactions`(buy_in/cash_out/win/signup_bonus), `game_history`.
- **REST**: `/api/auth/{register,login}`, `/api/users/{me,transactions,add-chips}`, `/api/rooms`, `/api/rooms/:id/{join,leave}`, `/api/admin/{rooms,users}`.
- **WebSocket**: `{type,payload}` JSON. `auth` → `join_room` → `player_action` / `chat_message` / `spectate`.
- **확인된 결함** (서브에이전트가 파일 단위로 검토):
  - 하드코딩된 기본 JWT 시크릿, 토큰 폐기 불가, CORS `*` + credentials.
  - `/users/add-chips`가 `NODE_ENV`만으로 차단 → 비운영 환경에서 무제한 칩 발행.
  - 잔액 갱신이 read-then-write로 트랜잭션 없음 → 동시 요청 시 이중 사용.
  - 사이드팟 미구현(팟 전체를 최고 패에 분배), 평가기가 키커 무시, 홀수 칩 `Math.floor`로 소실.
  - REST `/leave`와 게임 서버 퇴장이 각각 잔액을 지급하는 **이중 지급** 경로.
  - 턴 타임아웃 시 폴드가 아니라 퇴장·정산 처리.
  - 테스트가 `bun:test`·`Bun.spawn`, 실행 중인 Postgres, 하드코딩된 macOS 경로에 의존.

---

## 2. 재사용할 코드와 제거할 코드

| 출처 | 재사용 | 방식 |
|---|---|---|
| poker-engine-ts | 전체(공개 API) | npm 의존성 `poker-engine-ts@0.1.3`. 소스 복제·수정 없음 |
| Elite-Poker | Card, PlayerSeat, Table, AnimatedChip, ChipStack, TimerRing, ActionButtons, Chat, 좌석 배치 훅, 효과음 합성, 테마 CSS 변수 체계, 애니메이션 CSS | TypeScript로 이식 후 JC ROYAL 브랜드로 리디자인. MIT 고지 유지(`THIRD_PARTY_NOTICES.md`) |
| Ai-Poker | 없음(코드) | 테이블 구성, REST 경로 체계, 관리자 화면 기능 목록만 **참고하여 독자 구현** |

**제거(통합 대상에서 제외)**

- Elite-Poker `backend/` 전체(자체 엔진·로비·WS 서버), `BettingPanel`(사이드벳), `Leaderboard`의 점수 시스템, `BeginnerTips`, `utils/equity.js`의 서버 판정 대체 용도, `neon`/`aurora` 테마, 업데이트 스크립트(.bat/.sh).
- Ai-Poker `apps/websocket/src/poker/*`(중복 엔진), JWT/bcrypt 인증, `add-chips` 엔드포인트, Prisma 잔재, Bun 전용 테스트.

---

## 3. 충돌·호환성 문제와 해결

| # | 문제 | 해결 |
|---|---|---|
| 3.1 | 엔진 `maxSeats`가 2/6/9만 허용, 지시서는 2~10인 | 엔진 타입을 우회(캐스팅)하면 "단일 규칙 기준" 원칙을 깨고 검증되지 않은 영역을 쓰게 됨. **테이블 정원 2·6·9석, 참여 2~9인**으로 구현하고 10인은 미지원으로 문서화 |
| 3.2 | 세 프로젝트의 카드 표기가 다름(`'10'`+`'♠'` / `'Ts'`) | 서버·타입은 엔진 표기(`Ts`)로 통일, UI에서만 변환 |
| 3.3 | Elite-Poker는 서버가 전체 상태를 브로드캐스트 | 플레이어별 뷰 생성(`packages/poker-engine`의 `projectView(viewer)`): 본인 홀카드, 쇼다운에 공개된 카드만 포함 |
| 3.4 | Node `ws`·express, Bun 서버 | Cloudflare Workers + Durable Objects WebSocket Hibernation API로 교체 |
| 3.5 | bcrypt는 Workers CPU 제한에 불리 | WebCrypto PBKDF2-SHA256(Workers 최대 100,000회) 사용. 무료 플랜 CPU 10ms 초과 가능성 → §6 비용 참조 |
| 3.6 | Ai-Poker는 Postgres | D1(SQLite) + Drizzle `sqlite-core`로 재설계 |
| 3.7 | JWT in localStorage | HttpOnly·Secure·SameSite 쿠키 + D1 세션 테이블(토큰 해시 저장, 서버측 폐기 가능) |
| 3.8 | 다중 핸드 진행 시 엔진 `advanceHand`가 좌석 변경·블라인드 변경 반영 불가 | 핸드마다 새 `SessionManager` 생성. 좌석·버튼 이동·블라인드는 어댑터가 결정 |
| 3.9 | Elite-Poker JSX, 서로 다른 Tailwind 버전 | TypeScript + Tailwind v4로 통일 |

---

## 4. 최종 아키텍처

### 4.1 배포 단위

```
브라우저 ──(jc-royal.site)──────────► apps/api  Worker
             /            정적 자산(apps/web 빌드, Workers Static Assets)
             /api/*       Hono REST (D1)
             /ws/tables/:id  세션 쿠키 검증 → TableRoom DO로 업그레이드 전달
관리자 ──(admin.jc-royal.site)─────► apps/admin Worker
             /            정적 자산(apps/admin 빌드)
             /api/*       Service Binding → apps/api (관리자 라우트)
apps/game-worker Worker ── TableRoom Durable Object (SQLite 저장소)
             · 테이블 1개 = DO 인스턴스 1개 (idFromName(tableId))
             · WebSocket Hibernation, 알람으로 턴 타이머·다음 핸드
             · D1 바인딩: 바이인/정산/핸드 기록 기록
```

- 같은 출처에서 정적 자산과 API를 함께 제공 → 쿠키를 SameSite=Lax로 유지, CORS 불필요.
- WebSocket 인증: 업그레이드 요청의 세션 쿠키를 API Worker가 검증하고, 검증된 `userId`·닉네임을 내부 헤더로 DO에 전달. DO는 외부에서 직접 접근 불가(공개 라우트 없음).

### 4.2 게임 흐름 (서버 권한형)

```
클라이언트 action{seq, intentId, type, amount}
  → DO: 인증된 소켓의 userId 확인 · zod 스키마 검증 · intentId 멱등 확인
  → 어댑터: 엔진 intent 생성 (expectedSnapshotVersion 포함)
  → poker-engine-ts SessionManager.applyIntent  (유일한 규칙 판단)
  → DO storage에 이벤트 로그 저장 (핸드 initialSnapshot + events)
  → 플레이어별 뷰 투영(projectView) → 각 소켓에 전송 (version 증가)
  → 핸드 종료: D1에 핸드 기록·플레이어 결과 기록 → 알람으로 다음 핸드
```

- 핸드 시작: 착석·스택>0·sit-in 플레이어로 좌석 구성 → 버튼을 다음 점유 좌석으로 이동 → `crypto.getRandomValues` 셔플 → `SessionManager.create` → `dealHoleCards` → `resume`.
- 재시작 복구: DO 생성자에서 storage의 `initialSnapshot`+`events`로 `SessionManager.resume`(spike에서 동일성 확인).
- 타이머: 엔진 `timeout` 액션(fallback: 체크 가능하면 check, 아니면 fold)을 DO 알람으로 제출.

### 4.3 칩 경제

- **지갑**(`users.balance`, D1)과 **테이블 스택**(DO, 엔진 좌석 stack)을 분리.
- 바이인: D1 batch(트랜잭션) — `UPDATE users SET balance = balance - :amt WHERE id = :u AND balance >= :amt` + `chip_ledger` insert(고유 `idempotency_key`) + `table_sessions` insert. 성공 후에만 DO가 착석 처리.
- 퇴장/테이블 종료: D1 batch — 잔액 가산 + ledger(`cash_out`, key=`table_session_id`) + session close. 고유 키로 **이중 지급 차단**.
- 검증 2종: ① 핸드 단위 칩 보존(엔진 스택+팟 합계 불변, DO에서 매 액션 검사) ② 원장 검증(`users.balance == Σ chip_ledger.amount`, 관리자 대조 API + 불일치 시 `reconciliation_events` 기록).
- 모든 금액은 정수(INTEGER). 클라이언트가 보낸 금액은 엔진 합법 범위 검증을 통과해야만 반영.

### 4.4 DB 모델 (D1 / Drizzle)

| 테이블 | 주요 컬럼 |
|---|---|
| `users` | id, email(UNIQUE), nickname(UNIQUE, NOCASE), password_hash, role(`user`/`admin`/`super_admin`), status(`active`/`suspended`/`deleted`), balance, avatar_url, locale, created_at |
| `sessions` | id, user_id, token_hash(UNIQUE), kind(`user`/`admin`), mfa_verified_at, expires_at, ip, user_agent |
| `password_resets` | token_hash, user_id, expires_at, used_at |
| `chip_ledger` | id, user_id, type(`signup_grant`/`buy_in`/`cash_out`/`admin_adjust`/`reconcile`), amount(±), balance_after, table_id, ref_id, idempotency_key(UNIQUE), actor_id, memo |
| `tables` | id, name, max_seats(2/6/9), small_blind, big_blind, min_buy_in, max_buy_in, is_private, join_code_hash, allow_spectators, status(`open`/`closed`), entry_blocked, created_by |
| `table_sessions` | id, table_id, user_id, seat_index, buy_in, cash_out, status(`seated`/`closed`) |
| `hands` | id, table_id, hand_number, started_at, ended_at, board, pot_total, event_log(JSON, 감사용), engine_version |
| `hand_players` | hand_id, user_id, seat_index, hole_cards, net, won_amount, rank_class, rank_value, went_to_showdown |
| `webauthn_credentials` | id(credential id), user_id, public_key, counter, transports, nickname, created_at, last_used_at |
| `admin_recovery_codes` | user_id, code_hash, used_at |
| `admin_audit_log` | id, actor_id, action, target_type, target_id, detail(JSON), ip, created_at |
| `reconciliation_events` | id, user_id, expected, actual, resolved_by, created_at |

### 4.5 모노레포

`apps/web`, `apps/admin`, `apps/api`, `apps/game-worker`, `packages/{poker-engine,types,db,ui,audio,config}`, `tests/`, `docs/` — pnpm workspaces, TypeScript 5, Vitest, Playwright.

---

## 5. 단계별 구현 계획

| Phase | 산출물 | 완료 기준(실행 증거) |
|---|---|---|
| 2 | 모노레포·공통 tsconfig, `packages/db` 스키마·마이그레이션, `apps/api` Hono(회원가입·로그인·세션·프로필), PBKDF2 해싱 | `wrangler dev`에서 가입→로그인→`/api/me` 통합 테스트 통과 |
| 3 | `packages/poker-engine` 어댑터(핸드 시작·intent 변환·뷰 투영·타임아웃·재개), 룰 테스트(핸드 평가 전 족보, 사이드팟, 숏 올인, 헤즈업, 홀수 칩, 속성 기반 칩 보존, 재생) | Vitest 통과 로그 |
| 4 | `apps/game-worker` TableRoom DO, WS 프로토콜(`packages/types` zod 스키마), 재접속·중복 탭·관전자 | 다중 WS 클라이언트 통합 테스트(6인 핸드, 재접속, 비공개 카드 차단, 중복 액션) |
| 5 | `apps/web` 로비·테이블 UI(Elite-Poker 이식), 애니메이션 큐, `packages/audio`, 테마 4종, ko/en | 실제 브라우저 렌더링 확인 + 스크린샷 |
| 6 | 마이페이지·통계·핸드 히스토리·칩 내역 | API 테스트 + 화면 확인 |
| 7 | `apps/admin` 대시보드·회원·테이블·감사, WebAuthn 등록/인증/재인증, 복구 코드 | 가상 인증기(Playwright CDP WebAuthn)로 E2E |
| 8 | Playwright E2E, 보안 점검 | 실행 로그 `docs/TEST_REPORT.md` |
| 9 | wrangler 환경 분리, GitHub Actions, 배포·운영 문서 | `wrangler deploy --dry-run` 성공 |

---

## 6. Cloudflare 제약·비용 메모 (초기 판단, Phase 9에서 갱신)

- **Workers 무료 플랜**: 요청당 CPU 10ms. PBKDF2 100k회는 수십 ms가 걸릴 수 있어 로그인/가입이 무료 플랜에서 CPU 초과로 실패할 위험 → 운영은 **Workers Paid($5/월)** 권장. 개발 환경에서는 반복 횟수를 환경변수로 조정 가능하게 구현.
- **Durable Objects**: SQLite 저장소 DO는 무료 플랜에서도 사용 가능하나 일일 요청·실행시간 한도가 있음. WebSocket Hibernation으로 유휴 연결의 실행시간 과금을 줄이고, 턴 타이머는 `setTimeout` 대신 storage alarm 사용.
- **D1**: 무료 플랜 일일 읽기/쓰기 행 한도 존재. 핸드 기록은 핸드 종료 시 batch 1회로 묶어 쓰기 횟수 최소화.
- 외부 유료 서비스는 필요 없음. 비밀번호 재설정 메일 발송에는 메일 제공자가 필요 → 초기에는 개발용 콘솔 출력/관리자 발급, 운영 시 이메일 서비스 연동을 선택 사항으로 문서화.
