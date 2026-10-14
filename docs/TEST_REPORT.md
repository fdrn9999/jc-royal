# JC ROYAL — 테스트 보고서

실행일: 2026-10-15 · 환경: Windows 11, Node 24.15, wrangler 4.150 (로컬 workerd + D1 + Durable Objects), Chrome 156

이 보고서의 모든 결과는 아래 명령을 실제로 실행해 얻었다. 원본 로그는 `docs/test-logs/`에 있다.

| 계층 | 명령 | 결과 | 로그 |
|---|---|---|---|
| 엔진 규칙·속성·평가기 | `pnpm --filter @jc/poker-engine test` | **46 / 46 통과** | `test-logs/engine.txt` |
| 웹 단위 | `pnpm --filter @jc/web test` | **76 / 76 통과** | `test-logs/web-unit.txt` |
| API 단위 | `pnpm --filter @jc/api test` | **13 / 13 통과** | `test-logs/api-unit.txt` |
| 통합(실제 workerd) | `pnpm test:integration` | **105 / 105 통과**(14개 파일) | `test-logs/integration.txt` |
| E2E(Playwright, 실제 Chrome) | `PW_CHANNEL=chrome pnpm test:e2e` | **48 / 48 통과**(데스크톱 33, 모바일 15) | `test-logs/e2e.txt` |
| 부하(로컬) | `pnpm test:load` | 통과(기본 10테이블, 50핸드, 오류 0, 칩 보존 일치. 핸드 통계 추가 후 2회, 충전 멱등 수정 후 1회 재실행도 같음) | `test-logs/load-*.json` |
| 타입 검사 | `pnpm typecheck` | 오류 0 | — |
| 번들 가드 | `pnpm check:bundle` | 엔진은 지연 청크에만, 첫 화면에 받는 JS(진입 파일 + 미리 받는 공용 청크) 635KB(한도 650KB) | `test-logs/bundle.txt` |

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
- 부하 시나리오는 로컬 workerd에서만 수행했다(최대 30테이블·소켓 300개, 아래 "부하 시나리오"와 `docs/LOAD_TEST.md`). 로컬 workerd는 Cloudflare 엣지 성능을 대표하지 않으며, 엣지·운영 환경 부하 테스트는 하지 않았다.
- 로컬 `wrangler dev`에서는 서버가 닫은 소켓이 클라이언트에서 CLOSING 상태로 남는다(서버 쪽 동작은 정상, 테스트에 명시).

---

## 포커 아카데미 (2026-10-14 추가)

| 요구 | 테스트 | 결과 |
|---|---|---|
| 현재 패 평가기가 엔진과 일치 | `evaluate.test.ts` 속성 테스트: 무작위 2~3인 150건에서 족보·승자 모두 HandEngine 쇼다운과 동일 | ✅ |
| 카드 종류·숫자 판별, 퀴즈 판정 | `academy.test.ts` Lesson 1 (선택·정렬·문양 우열 없음) | ✅ |
| 족보 비교(킥커·스플릿·풀하우스 트리플 우선 등) | 비교 문제 11개의 설명 문구와 엔진 판정 일치 | ✅ |
| 포지션·액션 순서 | 2·3·6·9인 프리플랍/포스트플랍 순서를 실제 엔진 진행과 비교 | ✅ |
| 진행 상태 저장·마이그레이션·재시작·계정 분리 | `progress store` 3건 | ✅ |
| 연습 시나리오 완료 조건 | A~H 전부 스크립트대로 끝까지 진행, 승자·칩 보존·사이드 팟(300/400) 확인 | ✅ |
| 아카데미 진입, 오답 후 재시도, 진행 복원(다른 계정에는 미표시), 재시작 | `academy.spec.ts` | ✅ |
| 족보 비교, 포인터 드래그 정렬, 홀덤 단계, 베팅 액션 실습 | `academy.spec.ts` | ✅ |
| 연습 게임: WebSocket 미개설, 지갑·원장·핸드 기록 불변 | `academy.spec.ts` | ✅ |
| 실제 테이블 족보표(연결 유지), 초보자 모드 현재 패 | `academy.spec.ts` | ✅ |
| 모바일: 터치 탭 퀴즈·스왑 정렬, 가로 스크롤 없음, 카드 탭 시 스크롤 없음, 바텀시트, 액션바 화면 내 | `academy-mobile.spec.ts` | ✅ |
| 기존 멀티플레이 회귀 | 기존 E2E 6건 + 통합 42건 | ✅ |

모바일 테스트는 Chrome 모바일 에뮬레이션(Pixel 7, 터치 활성)이다. iOS Safari·Android 실기기 검증은 하지 않았다.

### 아카데미 후속 (2026-10-14)

| 요구 | 테스트 | 결과 |
|---|---|---|
| 진도 서버 저장, 오래된 기기가 새 진도를 덮지 않음, 다른 계정 비공개 | `tests/integration/academy.test.ts` | ✅ |
| 배지 1회 부여, 지갑·원장 불변. 배지는 장식용이며 서버 타당성 검사(시각 범위, 레슨 마지막 단계, 복습 답변 수)를 통과한 진도로만 부여, 위조 진도는 저장되지만 배지 0 | 같은 파일 + `academy-followups.spec.ts`(localStorage 위조) | ✅ |
| 익명 통계(사용자 ID 없음), 관리자 전용 조회 | 같은 파일 | ✅ |
| 입문 테이블 플래그(관리자 설정 → 로비) | 같은 파일 + `academy-followups.spec.ts` | ✅ |
| v1 → v2 마이그레이션, 기기 간 병합, 재시작 우선 | `academy-followups.test.ts` | ✅ |
| 개념별 오답 기록·상환, 약점 가중 복습, 시드 재현성 | 같은 파일 | ✅ |
| 랜덤 비교 문제의 유형(킥커·스플릿·족보 차이)을 엔진이 확인 | 같은 파일 | ✅ |
| 오답 해설의 결정 카드(페어 숫자·킥커 등) | 같은 파일 | ✅ |
| 봇은 합법 액션만 선택, 자유 연습 1·2·5인 12핸드 연속 진행 | 같은 파일 | ✅ |
| 핸드 기록 → 레슨 링크, 첫 실전 코칭 조건 | 같은 파일 | ✅ |
| 다른 기기 로그인 시 진도·배지 복원 | `academy-followups.spec.ts` | ✅ |
| 오답 해설 표시, 약점 복습·랜덤 퀴즈 | 같은 파일 | ✅ |
| 자유 연습: 소켓 없음, 지갑 불변, 여러 핸드 | 같은 파일 | ✅ |
| 실전 코칭 표시·끄기(레슨 미이수자에게는 미표시) | 같은 파일 | ✅ |
| 모바일: 새 화면 가로 스크롤 없음, 자유 연습 액션바 화면 내 | `academy-mobile.spec.ts` | ✅ |

CI 실패 원인 수정: `board.spec.ts`가 글쓰기 화면 전환 전에 목록의 검색창(`제목·본문 검색`)에 제목을 입력하던 타이밍 문제(CI 스냅샷: 제목 빈칸·본문 입력됨). 편집기 URL을 기다리고 라벨을 정확히 일치시켜 해결.

---

## 소셜·회원 방·개인정보 (2026-10-15 추가)

### 우선 검증 조합

| 조합 | 테스트 | 결과 |
|---|---|---|
| 친구 요청과 차단이 동시에 발생 | `social.test.ts` `a block drops pending requests, and a request racing a block never gets through` | ✅ |
| 차단된 사용자에게 1:1 전송 | `social.test.ts` `a block ends the friendship, stops requests and messages both ways …` + E2E `social-safety.spec.ts`(상대에게는 대화 불가만 보임) | ✅ |
| 신고 대상이 테이블을 떠남 | `social.test.ts` `players: after leaving, a report is checked against seat history and carries no hidden cards` | ✅ |
| 참여 시간대가 겹치지 않는 사용자 간 신고 | 같은 테스트(겹치지 않으면 409 `not_at_table`) + `players: only someone at the same table …`(같은 테이블에 없던 사람) | ✅ |
| 이미 삭제된 메시지의 신고 | 작성자가 지운 댓글: 새 신고 404, 기존 신고는 증거 유지·`contentStatus: 'deleted'`(`posts and comments …`). 탈퇴한 회원의 1:1 메시지: 404(`1:1 messages: only someone in the conversation …`). 탈퇴 뒤에도 기존 신고 보존(`privacy.test.ts`) | ✅ |
| 관리자 두 명이 같은 신고를 동시에 처리 | `social.test.ts` `admins handling the same report at once: exactly one decision and one audit row` | ✅ |
| 초대 후 테이블이 만석 | E2E `social-play.spec.ts`(초대 카드가 만석을 알리고 관전을 제안, 만석 테이블 착석 안내) + `social.test.ts` 초대 테스트(2석 테이블 `seat_taken`) | ✅ |
| 회원 방 종료 시 칩 환급 | `rooms.test.ts` `the host closes the room …`, `a room nobody sits in closes by itself …` + E2E `rooms.spec.ts` | ✅ |
| 모바일에서 1:1·신고 모달 조작 | E2E `social-mobile.spec.ts` `mobile: report a 1:1 message and block by touch; dialogs fit the screen` | ✅ |
| 네트워크 단절 후 1:1 재연결 | E2E `social.spec.ts` `1:1 chat sync: … reconnecting catches up at once`(브라우저 오프라인 → 복귀 즉시 동기화) | ✅ |
| 네트워크 단절 후 게임 재연결 | **E2E `reconnect.spec.ts`(신규)**: 핸드 도중 테이블 소켓을 끊고, 재시도가 오프라인에 묶인 동안 끊김 배너와 상대 화면의 '오프라인' 표시를 확인. 복구 후 서버가 새 연결에서 보낸 첫 상태가 끊기기 전과 같은 핸드·좌석·스택·카드인지 확인하고(화면에 남은 이전 상태로 통과하지 않도록 소켓 메시지를 직접 검사), 화면도 같은 좌석·카드로 돌아온다. A가 새 연결로 액션을 보내 핸드가 끝까지 진행되며, 둘이 일어서면 지갑 합계 20,000 그대로. 통합 `multiplayer.test.ts` 재접속, `restart.test.ts`(프로세스 강제 종료 후 복구) | ✅ |

새 테스트가 실제 결함을 잡는지 일부러 코드를 망가뜨려 확인했다(확인 후 되돌림).
- 클라이언트 자동 재연결을 막은 빌드: `reconnect.spec.ts`가 재시도 소켓을 기다리다 실패(보강 전 버전으로 확인).
- 다시 접속한 착석자에게 첫 상태를 보내지 않는 서버(다른 사람에게는 접속 복귀를 알림): 보강 전 버전은 화면에 남은 이전 상태 때문에 통과했고, 지금 버전은 새 연결의 첫 상태를 기다리다 실패.
- 신고 API가 삭제된 댓글도 찾도록 바꾼 서버: 삭제된 댓글 신고 검증이 실패.

기존 포커 엔진 테스트(45)와 칩 보존 검사(엔진 속성 테스트, `multiplayer.test.ts` 6인 테스트, 부하 시나리오)는 그대로 유지한다.

### E2E 간헐 실패와 하네스 수정

전체 E2E에서 데스크톱 22번째 테스트 `social.spec.ts`(친구 요청·수락·1:1·읽음 표시)가 두 번 90초 시간 초과로 실패했다. 한 번은 페이지 스크린샷에서, 한 번은 두 번째 회원 가입의 `/register` 이동에서 멈췄다. 그 테스트만 돌리면 5/5 통과했다.

- **원인:** `signUp`(그리고 `admin.spec`·`academy-followups.spec`)이 `browser.newContext()`로 연 컨텍스트를 닫지 않았다. 워커 하나가 브라우저 하나로 전체를 돌리므로, 22번째 테스트 시점에 앞선 21개 테스트의 페이지 33개가 살아 있었다(실패 트레이스 두 개 모두 페이지 35개, 실패 스크린샷 34장). 이 페이지들은 로비·1:1·안 읽음 폴링, 테이블 WebSocket과 25초 핑을 계속 보냈다(트레이스에 이전 테스트 `reconnect.spec.ts`의 핑 전달이 찍혀 있다).
- **근거:** 두 번째 실패에서 `/register` 문서는 서버가 11 ms 만에 200으로 응답했다. 그런데 같은 페이지의 CSS·JS 요청이 Chrome 안에서 `net::ERR_INSUFFICIENT_RESOURCES`로 실패해 load 이벤트가 오지 않았다. 서버가 아니라 브라우저 자원 고갈이다.
- **수정:** `tests/e2e/helpers.ts`의 `test`에 자동 픽스처를 두어, 테스트가 연 컨텍스트를 테스트가 끝날 때 닫는다. 컨텍스트를 직접 여는 spec 16개가 이 `test`를 쓴다(import만 변경). 단언과 시간 제한은 바꾸지 않았다.
- **확인:** 수정 후 전체 E2E를 돌리며 테스트마다 시작 시점에 열린 컨텍스트 수를 찍었다(임시 로그, 확인 후 제거). 이 `test`를 쓰는 31개 테스트 모두 0개였고, 34/34 통과(5.6분, 수정 전 실패한 실행은 7.3분). 로그를 뺀 최종 실행: 34/34 통과(5.7분).
- **배제한 가설:** 앱 메인 스레드 무한 루프(멈춘 페이지의 폴링은 계속 정상), S8 회귀(앱 코드 변경 없음, 단독 5/5 통과), 서버 지연(문서 응답 11 ms). 첫 실패 직후에는 "백그라운드 페이지의 캡처 정지"로 보았지만, 두 번째 실패의 자원 오류와 두 트레이스의 페이지 수를 보고 근본 원인을 누수로 고쳤다.

### 부하 시나리오 (로컬)

`pnpm test:load`(`tests/load/`). 자세한 절차·결과·한계는 `docs/LOAD_TEST.md`, 원본 보고서는 `test-logs/load-*.json`.

| 실행 | 소켓 | 핸드 | 액션 왕복 p50 / p95 / 최대(ms) | 오류 | 칩 보존 |
|---|---|---|---|---|---|
| 10테이블 × (4+2), 5핸드 | 60 | 50 | 41 / 76 / 106 | 0 | 일치 |
| 30테이블 × (6+4), 5핸드 | 300 | 150 | 120 / 235 / 472 | 0 | 일치 |
| 10테이블 × (6+2), 30핸드 | 80 | 300 | 18 / 62 / 1,217 | 0 | 일치 |
| 10테이블 × (4+2), 5핸드, 핸드 통계 추가 후 1회차 | 60 | 50 | 55 / 388 / 1,005 | 0 | 일치 |
| 같은 조건 2회차 | 60 | 50 | 50 / 84 / 125 | 0 | 일치 |
| 같은 조건, 충전 멱등 수정 후 | 60 | 50 | 38 / 82 / 118 | 0 | 일치 |

핸드 통계 추가 후 두 번 돌렸다(`test-logs/load-after-stats-1.json`, `-2.json`). 1회차는 액션 왕복 p95가 388 ms로 높았지만, 핸드 종료와 상관없는 로비 목록 조회 p95도 993 ms(이전 145 ms)로 함께 느려져 같은 PC의 다른 부하로 보았다. 2회차는 액션 왕복 84 ms, 로비 목록 107 ms로 이전 수준이었다. 핸드 종료 시 통계 계산은 `pot_won IS NULL` 부분 인덱스로 아직 계산하지 않은 행만 읽는다. 충전 멱등 수정 뒤 한 번 더 돌린 결과는 `test-logs/load-after-topup-fix.json`이다(이 시나리오는 충전을 쓰지 않으므로 게임 경로 회귀 확인용).

모두 개발 PC 한 대의 로컬 `wrangler dev`에서 측정했다. Cloudflare 엣지·운영 환경에서는 부하 테스트를 하지 않았고, 지속 실행의 꼬리 지연 원인은 확인하지 않았다.

---

## 플레이 UX·스택·통계 (2026-10-15 추가)

| 요구 | 테스트 | 결과 |
|---|---|---|
| 마우스·터치·키보드에 같은 위험 액션 확인(큰 콜·올인·체크 가능할 때 폴드), 키보드 C로 큰 콜 즉시 실행 금지 | 웹 단위 `action-safety.test.ts` 13건 + E2E `action-keys.spec.ts` | ✅ |
| 키 반복·중복 제출 방지, 채팅·모달·입력창에서 단축키 무시, 한글 입력 상태에서도 물리 키 인식 | 같은 파일들 | ✅ |
| 서버가 내려준 합법 액션·금액 범위만 전송, 금액 변경 시 확인 해제 | `action-safety.test.ts` + E2E `action-mobile.spec.ts` | ✅ |
| 모바일 오조작 방지 유지(큰 콜 두 번 탭, 금액 이동 시 올인 확인 해제) | `action-mobile.spec.ts` | ✅ |
| 최대 팟 = 참여한 핸드의 전체 팟(돌려받은 미콜 칩 제외), 한 핸드 최대 획득을 별도 지표로 | 통합 `stats.test.ts`(폴드 승리·스플릿·사이드 팟·참여 전 폴드) | ✅ |
| 기존 핸드도 같은 기준으로 계산 | `hand-stats.test.ts`: 마이그레이션 0010의 백필이 게임 워커와 같은 SQL이고, 무작위 핸드에서 엔진 결과와 일치(마이그레이션 전후) | ✅ |
| 빠른 입장: 입문자 테이블 우선, 2·6·9인과 블라인드 조건, 빈 좌석 있는 공개 테이블만 | 통합 `quickplay.test.ts` 6건 | ✅ |
| 참가 가능 여부는 서버(테이블 룸)가 재검증, 비공개·입장 제한 테이블 제외, 바이인은 기존 지갑·원장 | 같은 파일 + E2E `quickplay.spec.ts`(좌석 선택 전 차감 없음, 좌석을 놓치면 다음 테이블 제안) | ✅ |
| 참가할 방이 없을 때 안내(잔액 부족 시 가장 낮은 최소 바이인 표시) | 같은 파일 + `quickplay-mobile.spec.ts` | ✅ |
| 핸드 사이 즉시 충전, 최소·최대 바이인 범위, 잔액 부족 안내, `reqId` 멱등 | 통합 `topup.test.ts` 6건 + E2E `topup.spec.ts` 2건, `topup-mobile.spec.ts` | ✅ |
| D1에 닿지 못하면 차감·가산 없음, 같은 `reqId` 재시도는 한 번만, 룸이 잊은 오래된 `reqId` 재전송은 D1 실패 중이든 아니든 칩을 늘리지 않음 | `topup.test.ts` `a top-up that cannot reach D1 takes nothing, …`(테스트 프로세스가 로컬 D1 파일의 쓰기 잠금을 잡으면 워커의 D1 호출이 읽기까지 실패한다) | ✅ |
| 핸드 중 요청은 차감 없이 대기, 정산 직후 반영(최대 바이인 초과 금지), 취소·교체 가능 | 같은 파일들 | ✅ |
| 서버 재시작 후 중복 차감 없음 | `restart.test.ts` `a top-up queued before a crash is applied once after the restart, and another restart does not repeat it`(프로세스 강제 종료 두 번) | ✅ |
| 자동 리바이: 기본 꺼짐, 명시 동의·1회 금액·총 한도 필수, 한도 도달·잔액 부족 시 꺼짐 | `topup.test.ts` 3건 + `topup.spec.ts` | ✅ |
| 칩 보존·원장 정합성 확장 | `topup.test.ts` 6건 모두 끝에 전원이 일어선 뒤 지갑 합계가 처음과 같고 각 지갑이 원장 합계와 같은지 확인 | ✅ |
| 로비: 만석·관전 불가 테이블은 대기열로, 입장·관전·대기열 상태 구분 | E2E `lobby.spec.ts`, `lobby-mobile.spec.ts` + 웹 단위 `lobby.test.ts` | ✅ |
| 빠른 입장과 필터 통합, 즐겨찾기·최근 방문 | `lobby.spec.ts`(새로고침 후 유지, 최신순) + `lobby.test.ts` | ✅ |
| 보이는 동안만 폴링, 요청 겹침 없음, 오래된 응답 무시, 화면 복귀 시 갱신 | `lobby.spec.ts` + `lobby.test.ts` 5건 | ✅ |
| 통계: VPIP·PFR·프리플랍 레이즈 비율·쇼다운 진입률·쇼다운 승률·평균 팟·포지션별 핸드 | 통합 `stats.test.ts`, `hand-stats.test.ts` + E2E `stats.spec.ts` | ✅ |
| 기간별 순손익(7·30·90일, 사용자 시간대 기준 일 단위) | `stats.test.ts`(자정 경계, 시간대 ±60·+540분, 잘못된 값 400) + E2E 차트 선택 | ✅ |
| 관전 기록 제외, 읽을 수 없는 행동 기록은 추정하지 않고 해당 지표에서 제외, 본인만 조회 | `stats.test.ts`(관전자 0, 손상된 로그, 비로그인 401) + `stats.spec.ts`(관전자는 '—') | ✅ |
| 한국어·영어, 모바일 | `stats-mobile.spec.ts`(설정에서 영어로 바꿔 확인, 가로 넘침 없음) 등 모바일 spec 5개 | ✅ |
| 기존 멀티플레이 회귀 | 기존 통합·E2E 전체 | ✅ |

### 이번 작업에서 찾아 고친 문제

- 최대 팟(`MAX(won)`)과 승리 수·총 획득이 돌려받은 미콜 칩까지 셌다. 한 핸드에서 진 사람도 자기 칩을 돌려받으면 '승리'로 집계됐다.
- 로비 카드의 이동 버튼이 만석·관전 불가 테이블에서도 관전으로 보냈다.
- 로비 목록 쿼리가 `status <> 'closed'`로 전체를 훑었다. `IN`과 인덱스로 바꿨다.
- 숨긴 탭에서도 로비를 폴링했고, 겹친 요청의 오래된 응답이 나중 응답을 덮을 수 있었다.
- 모바일 로비에 방 만들기 버튼이 두 개였다.
- 원장 처리 결과가 'duplicate'일 때 칩을 다시 더하던 문제, 차감 중 멈춘 좌석이 충전을 막던 문제.
- 통계 추이 차트가 순손익 0인 날을 표시하지 않았고, 모든 값이 0이면 기준선이 위 끝에 붙었다.
- 진입 번들이 675KB로 한도(650KB)를 넘었다. 마이페이지·게시판을 지연 로딩으로 분리했고, 번들 가드가 진입 파일과 함께 미리 받는 공용 청크까지 합산하도록 고쳤다.
- 통합 테스트의 DB 직접 실행 도우미(`tests/support/d1.ts`)가 워커의 쓰기와 겹치면 `SQLITE_BUSY`로 실패했다(전체 실행 중 1회). 쓰기 부하를 걸어 25회 중 15–16회 실패로 재현했고, 실패한 배치는 행을 남기지 않음을 확인한 뒤 `SQLITE_BUSY`일 때만 재시도하게 했다. 수정 후 같은 부하에서 25/25 성공, 중복 행 없음.
- (Codex 적대적 리뷰 지적) 충전 복구가 이미 반영된 충전을 다시 더할 수 있었다. 룸은 최근 `reqId` 200개만 기억한다. 그보다 오래된 충전 요청이 다시 오면 원장에 이미 있는 키로 '차감 중' 표시를 저장했고, 그 D1 호출이 실패하거나 룸이 재시작하면 복구가 "원장에 있음 = 아직 안 더함"으로 보고 칩을 한 번 더 더했다. 테스트 프로세스가 D1 쓰기 잠금을 잡은 상태로 재전송해 재현했다(일어선 뒤 지갑 10,200, 기대 10,000, 원장 차감은 200 한 번). 원장에 이미 있는 키는 '차감 중'으로 표시하지 않고(이미 반영된 요청으로 보고 `ack`만), 복구는 원장이 실제로 차감한 금액만 더하도록 고쳤다. 원장 확인이 표시보다 먼저라 D1이 실패하면 아무것도 남기지 않는다. 최종 테스트는 수정 전 코드에서 D1 복구 뒤 재전송 시 스택 700(기대 500)으로 실패하고, 수정 후 통과한다.
