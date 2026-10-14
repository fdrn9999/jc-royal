# JC ROYAL — 테스트 보고서

실행일: 2026-10-14 · 환경: Windows 11, Node 24.15, wrangler 4.150 (로컬 workerd + D1 + Durable Objects), Chrome 156

이 보고서의 모든 결과는 아래 명령을 실제로 실행해 얻었다. 원본 로그는 `docs/test-logs/`에 있다.

| 계층 | 명령 | 결과 | 로그 |
|---|---|---|---|
| 엔진 규칙·속성 | `pnpm --filter @jc/poker-engine test` | **27 / 27 통과** | `test-logs/engine.txt` |
| 통합(실제 workerd) | `pnpm test:integration` | **42 / 42 통과** | `test-logs/integration.txt` |
| E2E(Playwright, 실제 Chrome) | `PW_CHANNEL=chrome pnpm test:e2e` | **5 / 5 통과** | `test-logs/e2e.txt` |
| 타입 검사 | `pnpm typecheck` | 오류 0 | — |

> 이 PC에서는 Playwright 전용 Chromium 다운로드가 네트워크 오류(ECONNRESET)로 실패해, 설치된 Chrome을 `channel: 'chrome'`으로 사용했다. CI(ubuntu)에서는 Playwright Chromium을 쓴다.

---

## 1. 게임 규칙 테스트 (`packages/poker-engine`)

엔진 `poker-engine-ts@0.1.3`과 JC ROYAL 어댑터를 고정 덱과 무작위 시나리오로 검증했다.

| 지시서 요구 | 테스트 | 결과 |
|---|---|---|
| 로열 플러시~하이 카드 핸드 평가 | `hand evaluation through showdown` 10건 | ✅ |
| 프리플랍~쇼다운 전체 핸드 | 위 10건 + 속성 테스트 | ✅ |
| 여러 플레이어 올인, 사이드팟 분배 | `multi-way all-in … side pots` (900/800/300) | ✅ |
| 무승부·홀수 칩 | `split pot … odd chip` (25 → 12/13) | ✅ |
| 최소 레이즈 | `minimum raise is one big blind …` | ✅ |
| 숏 올인 재오픈 제한 | `a short all-in does not reopen raising …` | ✅ |
| 헤즈업 규칙 | `heads-up: button posts SB and acts first preflop …` | ✅ |
| 턴 종료(타임아웃) | `turn timeout checks when free and folds when facing a bet` | ✅ |
| 정확한 칩 정산 | 모든 규칙 테스트 + 속성 테스트의 보존 검사 | ✅ |
| 블라인드 올인 | `a player who cannot cover the big blind posts all-in …` | ✅ |
| 이벤트 재생·상태 복원 | `restores from a JSON-serialised log mid-hand …` | ✅ |
| 속성 기반 테스트 | 무작위 2,000 + 2,000핸드(2·6·9석, 스택 1~3000) | ✅ |

**속성 테스트 불변식**(매 액션마다 검사):

- 칩 총량 보존, 음수 스택 없음
- 핸드가 항상 정산까지 진행
- 무작위 시점의 로그 복원 상태가 원본과 동일
- 다른 플레이어 홀카드 비노출
- 정산 합계 = 팟, 순손익 합계 = 0

폴드 회피 실행 기준 커버리지는 2,000핸드 전부 쇼다운 도달, 사이드팟 실지급 1,835건, 정체 해소 127건이다.

**테스트로 발견한 엔진 결함 3건**(상세는 `docs/ENGINE_NOTES.md`):

1. 블라인드 기여액 미기록(과다 청구)
2. BB 옵션 소실 — 패치로 수정. 패치를 되돌리면 테스트가 실패하는 것을 대조 실험으로 확인했다.
3. 블라인드 올인 시 핸드 정지

---

## 2. 멀티플레이 테스트 (`tests/integration`, 실제 workerd + Durable Objects)

| 지시서 요구 | 테스트 | 결과 |
|---|---|---|
| 두 브라우저 동시 입장 | `heads-up: buy-in debits the wallet, hand auto-starts …` + E2E `game.spec` | ✅ |
| 6인 테이블 플레이 | `6-handed: plays full hands, conserves table chips, records hands and stats` | ✅ |
| 재접속 | `reconnect restores the seat and own cards …` | ✅ |
| 관전자 입장 | 헤즈업 테스트의 관전자 검증 + `spectators disabled …` | ✅ |
| 중복 베팅 요청 | `server validates actions: wrong turn, stale seq, duplicate intent` | ✅ |
| 비공개 카드 접근 차단 | 헤즈업·6인 테스트의 모든 상태 메시지 검사 + 엔진 내부값(`remainingDeck`/`deckSeed`/`burnPile`) 비노출 | ✅ |
| 게임 도중 연결 종료 | 재접속 테스트(접속 끊김 표시 → 같은 핸드로 복귀) | ✅ |
| 서버 상태 복구 | `restart.test.ts`: workerd 프로세스를 핸드 도중 **강제 종료 후 재기동**, 같은 핸드·같은 seq·같은 카드로 이어서 진행, 지갑+테이블 칩 합 보존 | ✅ |
| 다른 탭 중복 접속 | 같은 테스트: 새 탭이 기존 탭을 교체(4001), 기존 탭은 더 이상 메시지를 받지 않음 | ✅ |
| 턴 타이머 | `turn timer: an idle player is checked/folded automatically` | ✅ |
| 비공개 테이블 | `private table: join code required to sit` | ✅ |
| 인증 없는 WS 거부 | `rejects unauthenticated sockets and cross-site origins` (401/403/404) | ✅ |
| 채팅 | `chat is broadcast … length/rate limited` | ✅ |

## 3. 플랫폼 테스트

| 지시서 요구 | 테스트 | 결과 |
|---|---|---|
| 회원가입·로그인 | `auth.test.ts` 10건 + E2E 전 시나리오 | ✅ |
| 가상 칩 지급 | 가입 지급 원장 기록, 관리자 지급(멱등·음수 방지) | ✅ |
| 바이인·퇴장·환불 | `validates sit requests …`, `leaving cashes the stack out … exactly once`, E2E `game.spec` | ✅ |
| 관리자 권한 | `admin.test.ts` 13건(일반 회원 거부, 출처 검사, 역할 변경 즉시 반영) | ✅ |
| 관리자 하드웨어 키 인증 | **해당 없음** — 프로젝트 오너 결정으로 제외(DIRECTIVE §12). 대체 통제(비밀번호 재확인)를 테스트함 | — |
| 관리 작업 감사 로그 | `records administrator actions in the audit log` | ✅ |
| 새로고침 후 상태 유지 | E2E `game.spec`(새로고침 후 좌석·스택 유지) | ✅ |
| 게시판·공지·답글·쪽지 | `community.test.ts` 7건 + E2E `board.spec` | ✅ |
| 정합성 검사 | `reconciliation detects a wallet that no longer matches its ledger`(DB 직접 변조 탐지) | ✅ |

## 4. 보안 점검 결과

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| 서버 권한형 판정 | 모든 액션은 DO → 엔진 `applyIntent`. 클라이언트 금액·순서·카드는 무시하거나 거부(불법 금액 테스트) | ✅ |
| CSPRNG 셔플 | `crypto.getRandomValues` + 거부 샘플링. 게임 룸은 고정 덱을 넘기지 않음(코드 검색) | ✅ |
| 비공개 카드 통제 | 보는 사람별 투영. 관리자 실시간 상태에도 홀카드 없음(테스트). 감사 열람은 종료 핸드만 + 재확인 + 감사 로그 | ✅ |
| XSS | React 이스케이프, `dangerouslySetInnerHTML`/`innerHTML`/`eval` 0건. 게시글은 평문(E2E로 `<b>` 문자열 그대로 표시 확인). CSP `script-src 'self'` | ✅ |
| CSRF | 상태 변경 요청은 Origin 허용 목록 + JSON 강제, SameSite 쿠키. WS 핸드셰이크 Origin 검사 | ✅ |
| 세션 | HttpOnly 쿠키, D1에는 토큰 SHA-256만 저장, 비밀번호 변경·재설정 시 세션 폐기 | ✅ |
| 레이트 리밋 | 가입·로그인·재설정·게시·댓글·WS 메시지(토큰 버킷)·채팅 1초 | ✅ |
| 관리자 API 보호 | 별도 세션 쿠키(Strict), 역할은 매 요청 D1에서 확인, 관리자 출처 검사 | ✅ |
| 액션 중복 처리 | intent id 멱등(재시작 후에도), seq 불일치 거부 | ✅ |
| 칩 원장 무결성 | 원장+잔액 단일 트랜잭션, 멱등 키, 정합성 검사 | ✅ |
| 비밀값 분리 | `.dev.vars`는 git 제외, 운영은 `wrangler secret` | ✅ |
| 로그 민감정보 | 에러 메시지만 기록(코드 검색) | ✅ |
| 보안 헤더 | 실제 응답에서 CSP, X-Frame-Options DENY, nosniff, Referrer-Policy 확인 | ✅ |

## 5. 시각 검증(실제 렌더링)

`tests/visual/capture*.mjs`로 Chrome에서 직접 캡처해 확인했다.

- **대상 화면**: 데스크톱·태블릿·모바일 테이블, 로비, 마이페이지, 관리자 콘솔, 게시판·핸드 리뷰·쪽지함, 회원가입.
- **발견하고 수정한 문제**:
  - 딜러 버튼이 카드를 가림, SB/BB 배지가 카드에 가려짐
  - 한글 제목 자간 깨짐, 모바일 상단 버튼 줄바꿈
  - 좌석이 화면 밖으로 잘림
  - 핸드 시작 때 보드 위치 이동(수정 후 실측 **0px**)
  - 관리자 "정지" 버튼 줄바꿈
- **E2E 판정**: 모바일 가로 넘침 없음을 매 실행 검사한다.

## 6. 알려진 한계

- 10인 테이블은 엔진 미지원이라 최대 9석이다.
- 비밀번호 재설정 메일은 발송되지 않는다(메일 서비스 미연동, 운영에서는 관리자가 링크를 발급).
- 부하·성능 테스트(수백 개 동시 테이블)는 수행하지 않았다. 로컬 workerd는 Cloudflare 엣지 성능을 대표하지 않는다.
- 로컬 `wrangler dev`에서는 서버가 닫은 소켓이 클라이언트에서 CLOSING 상태로 남는다(서버 쪽 동작은 정상, 테스트에 명시).
