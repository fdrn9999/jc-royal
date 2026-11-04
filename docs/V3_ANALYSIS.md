# JC ROYAL — 통합 고도화 기능 점검표 (v3 Phase 1)

작성일: 2026-11-03 · 기준: `main` `5dfd55100aca6ae13363fcd013ff8ff0b6095118` · 기준 지시서: "JC-ROYAL 통합 고도화 개발 지시서" PART 1

이 문서는 새 기능을 만들기 전에 이미 있는 것을 확인한 결과다. 각 기능마다 지시서가 요구한 항목(기존 구현 위치 · 관련 API · DB · 컴포넌트 · 테스트 · 현재 한계 · 필요한 변경 · 중복 구현 가능성)을 적고, 상태를 아래 여섯 가지 중 하나로 분류했다. 파일 위치는 분석 시점의 줄 번호이며, 코드를 직접 읽어 확인한 것만 적었다.

| 분류 | 뜻 |
|---|---|
| 완전 구현 | 지시서의 요구를 이미 충족한다. 손대지 않는다. |
| 일부 | 핵심은 있고 지시서가 요구한 일부가 빠졌다. 빠진 부분만 더한다. |
| 개선 필요 | 기능은 있으나 지시서가 지적한 결함이 있다. 원인을 고친다. |
| 미구현 | 해당 기능이 없다. 기존 구조 위에 새로 만든다. |
| 기존 기능으로 대체 | 지시서의 요구를 다른 기존 기능이 이미 맡고 있다. 새로 만들지 않는다. |
| 통합 필요 | 같은 일을 하는 구현이 둘 이상이라 하나로 모아야 한다. |

---

## 1. 요약

| # | 기능 | 분류 | Phase |
|---|---|---|---|
| 1 | 실시간 이벤트 전달(outbox) | 개선 필요 | P2 |
| 2 | 재접속·복구 표시 | 개선 필요 | P2 |
| 3 | 성능 측정 체계 | 일부 | P2 |
| 4 | 디자인 시스템(`packages/ui`) | 일부 | P3 |
| 5 | 마이페이지 | 개선 필요 | P3 |
| 6 | 공개 프로필 `/players/:id` | 완전 구현 | — |
| 7 | 관리자 콘솔 UI 일관성 | 통합 필요 | P3 |
| 8 | 관리자 Hard Delete | 미구현 | P4 |
| 9 | 통계 2.0 | 일부 | P5 |
| 10 | HUD | 미구현 | P5 |
| 11 | 핸드 분석·솔버 연결 | 일부 | P5 |
| 12 | 봇 연습 모드 | 통합 필요 | P5 |
| 13 | 봇 품질 | 개선 필요 | P5 |
| 14 | SNG 토너먼트 | 완전 구현 | — |
| 15 | MTT | 미구현 | P6 |
| 16 | 관전·파이널 테이블 | 일부 | P6 |
| 17 | 비공개 친구 SNG | 미구현 | P6 |
| 18 | 일일·주간 도전 | 미구현 | P7 |
| 19 | 업적 | 완전 구현 | — |
| 20 | 즐겨찾기·최근 테이블 | 일부 | P7 |
| 21 | 비공개 방·초대 | 완전 구현 | — |
| 22 | 관리자 권한·재인증 | 완전 구현 | — |
| 23 | 칩 원장 | 완전 구현 | — |
| 24 | 감사 로그 | 완전 구현 | — |
| 25 | 회원 탈퇴(자기 삭제) | 일부 | P4 |
| 26 | Soft Delete(게시판·공지·쪽지) | 완전 구현 | — |
| 27 | 마이그레이션 체계 | 완전 구현 | P17 원칙만 적용 |
| 28 | 테스트 인프라 | 일부 | P8 |

---

## 2. 안정성 (PART 2)

### 2.1 실시간 이벤트 전달(outbox) — 개선 필요

- **기존 구현 위치**
  - `apps/api/src/lib/realtime.ts`: `realtimeOutboxStatement(d1, row, guard?, fill?)`(변경과 같은 D1 batch에 들어가는 outbox 행), `realtimeOutboxSend`(커밋 뒤 즉시 발송), `outboxAfterCommit`/`realtimeOutboxAfter`(변경 뒤 별도로 쓰는 행).
  - `apps/game-worker/src/realtime.ts`(RealtimeHub DO), `realtime-publish.ts`, `realtime-rules.ts`: 사용자별 이벤트 전달과 재전송.
  - 클라이언트는 `apps/web/src/lib/realtime.ts`에서 eventId로 중복을 거르고 재접속 때 다시 맞춘다.
- **관련 API** 칩·VIP·계정 상태·친구·DM·대회·관리자 정책·공지·점검을 바꾸는 라우트 전부. 이벤트 목록은 `docs/REALTIME.md` §표.
- **DB** `realtime_outbox`(0038). 재시도와 유예는 `packages/db` `REALTIME_OUTBOX_MAX_ATTEMPTS`·`realtimeOutboxRetryAt`, 유예 `REALTIME_OUTBOX_GRACE_MS = 20_000`. 3일 뒤 housekeeping이 지운다.
- **컴포넌트** `apps/web/src/lib/realtime.ts`의 구독. 소비처는 지갑, 알림, 친구, 대회, 공지 배너.
- **테스트** `tests/integration/realtime.test.ts`, `realtime-public.test.ts`, `presence.test.ts`, `ws-reliability.test.ts`, `apps/api/src/lib/realtime-outbox.test.ts`, `tests/e2e/realtime-client.spec.ts`, `realtime-resync.spec.ts`, `realtime-account.spec.ts`.
- **현재 한계** 변경 뒤에야 내용이 정해지는 세 이벤트가 변경과 다른 batch에 있었다. 변경은 커밋됐는데 그 직후 worker가 죽으면 이벤트가 영영 나가지 않는다.
  - `member.vip.changed`: 보이는 색은 변경 뒤에 계산된다.
  - `tournament.changed`: 변경 뒤의 대회 행을 읽는다.
  - `service.changed`: 변경 뒤의 rev를 읽는다.
- **필요한 변경** 세 이벤트를 변경과 같은 batch에 넣는다. 내용은 batch 안에서 SQL로 채우고(fill), 실제로 바뀐 경우에만 쓴다(guard). 그 뒤 쓸모가 없어지는 `outboxAfterCommit`은 지운다.
- **중복 구현 가능성** 새 큐나 새 전달 경로를 만들면 RealtimeHub를 복제하게 된다. 기존 outbox 문장 함수 하나만 쓴다.

### 2.2 재접속·복구 표시 — 개선 필요

- **기존 구현 위치**
  - `apps/web/src/game/recovery.ts`: 복구 단계 `offline|reconnecting|syncing|restoring|restored|failed`. `restored`는 2.5초 뒤 사라진다.
  - `apps/web/src/game/useTableSocket.ts`: `synced`·`recovery`·`reconnect`를 노출한다.
  - `apps/web/src/pages/Table.tsx`: 표 위에 `table-banner`를 문서 흐름 안의 한 줄로 그린다.
- **관련 API** WS `/ws/tables/:id`. 재접속 때 서버가 첫 `state`를 보낸다.
- **DB** 없음(DO 상태).
- **컴포넌트** `Table.tsx`, `TimeBank.tsx`.
- **테스트** `tests/e2e/reconnect.spec.ts`, `table-stable.spec.ts`.
- **현재 한계** 배너가 뜨면 표가 아래로 밀리고, 사라지면 다시 올라온다. PR #48 CI의 E2E 실패 1건이 이 때문이었다(`docs/TEST_REPORT.md` 마지막 절). 휴대폰에서 겹쳐 그리면 맨 위 좌석이나 차례 띠를 가린다. 복구 중에도 타임뱅크 버튼은 눌린다.
- **필요한 변경** 안내를 표 밖의 헤더 제목 자리로 옮긴다(문서 흐름 밖, 게임 요소와 조작부를 가리지 않음). 복구 중에는 타임뱅크도 잠근다. 모든 표 크기와 화면에서 중심·좌석·조작부의 변화가 0인지 E2E로 잰다.
- **중복 구현 가능성** 없음. 기존 recovery 상태를 그대로 쓴다.

### 2.3 성능 측정 체계 — 일부

- **기존 구현 위치**
  - `tests/load/tables.load.ts`·`realtime.load.ts`·`monitor.load.ts`(`pnpm test:load`). `TEST_D1_STATS=1`이면 D1 행 수도 센다.
  - `tests/perf/table-perf.mjs`: 표 렌더 시간.
  - 결과는 `docs/LOAD_TEST.md`에 쌓는다(액션 RTT p50/p95/p99, WS 연결, 착석, 로비, 허브, D1 행).
- **관련 API** 테이블, 로비, 실시간 허브, 관제.
- **DB** `ops_metrics`(운영 지표).
- **컴포넌트** 없음.
- **테스트** 위의 부하·성능 스크립트.
- **현재 한계** 측정 도구는 있으나 이번 변경 뒤의 수치가 없다.
- **필요한 변경** 같은 도구로 다시 재서 비교하고 병목을 확인한다. 병목이 측정되지 않으면 최적화하지 않는다.
- **중복 구현 가능성** 새 부하 도구는 만들지 않는다.

---

## 3. UI/UX (PART 3·4·15)

### 3.1 디자인 시스템 `packages/ui` — 일부

- **기존 구현 위치** `packages/ui/src/index.ts`.
  - `components/primitives.tsx`: Logo, Button, Spinner, Field, Input, PasswordInput, Badge(neutral|gold|green|red|blue), Panel, Modal, Figure, Stat, Empty.
  - `poker/cards.tsx`: PlayingCard, Chip, ChipStack.
  - `util.ts`: cx, formatChips, formatBB, formatDate, createTranslator.
  - THEMES: 테마 4종과 색각 모드.
  - `icons.tsx`: Lucide 52개를 다시 내보내고 HandRanksIcon을 더해 53개. 앱이 쓰는 아이콘은 반드시 여기서 내보낸다.
- **관련 API** 없음.
- **DB** 없음.
- **컴포넌트** 웹과 관리자 앱 전체.
- **테스트** 각 앱의 단위 테스트와 E2E 시각 검사.
- **현재 한계** Tabs, Table, Select, Textarea, Checkbox, ConfirmDialog가 없다.
  - 탭은 각 페이지가 `role="tablist"`로 따로 만든다(admin `Ops.tsx:173`, `Reports.tsx:670`, `ControlCenter.tsx:951`).
  - 관리자 앱에는 직접 쓴 `<select>`·`<textarea>`·체크박스가 16개 파일에 86개 있다.
- **필요한 변경** 이번 작업이 실제로 쓰는 것만 `packages/ui`에 더한다. 마이페이지 탭에 쓸 Tabs, Hard Delete에 쓸 입력 확인 대화상자가 그것이다. 새 UI 라이브러리는 들이지 않는다. 기존 페이지를 한꺼번에 바꾸는 일은 이번 범위가 아니다.
- **중복 구현 가능성** 높음. 페이지마다 탭을 또 만들면 네 번째 구현이 된다.

### 3.2 마이페이지 `/me` — 개선 필요

- **기존 구현 위치** `apps/web/src/pages/Me.tsx`. 탭 없이 한 화면에 모든 패널이 위에서 아래로 쌓인다.
  - `MePage` :69, 데이터 읽기 :73-85, 머리말 :145-169.
  - 패널: 접속 상태 :172, 알림 :176, 리필 :180, 추천 :182, 통계 :184-230, 아카데미 배지 :232, 최근 핸드 :237, 원장 :247, 글 :268, 댓글 :282.
  - 프로필 편집(닉네임·아바타 URL) :297-308, 계정 :310-358, 핸드 상세 `HandDetailPage` :380-501.
- **관련 API**
  - `apps/api/src/routes/me.ts`: refill :27/:32, referral :45, ledger :50, stats :75-165, stats/trend :170, hands :197, hands/:id :211, note :255, settings :278/:299.
  - `auth.ts`: `/api/auth/me` :310/:314, password :349, sessions :366/:373, delete :381.
- **DB** users, user_settings, hand_players, chip_ledger, posts, comments, user_badges.
- **컴포넌트** `apps/web/src/components/PlayStats.tsx`, `Refill.tsx`, `Referral.tsx`, `Social.tsx`.
- **테스트** `tests/e2e/me-numbers-mobile.spec.ts`, `account-mobile.spec.ts`, `stats.spec.ts`, `stats-mobile.spec.ts`, `tests/integration/stats.test.ts`, `auth.test.ts`.
- **현재 한계** 한 화면이 너무 길다. KPI 요약이 없다. 프로필 보기와 편집이 머리말에서 떨어져 있다. 지시서가 요구한 네 탭 구조가 없다.
- **필요한 변경**
  - 머리말(아바타·닉네임·VIP·배지·가입일·상태, [프로필 보기][프로필 편집])을 둔다.
  - KPI(보유 칩·플레이 핸드·승률·BB/100)를 둔다.
  - 네 탭(대시보드 / 전적·플레이 기록 / 활동 / 계정 및 설정)으로 기존 패널을 옮긴다.
  - 패널은 그대로 쓰고 자리만 옮긴다. URL `/me`와 `/me/hands/:id`는 유지하고, 탭은 `?tab=`으로 둔다. 탭을 바꿀 때 이미 읽은 데이터를 다시 읽지 않는다.
- **중복 구현 가능성** 높음. 통계나 원장 패널을 새로 짜면 중복이다. 기존 컴포넌트를 옮기기만 한다.

### 3.3 공개 프로필 `/players/:id` — 완전 구현

- **기존 구현 위치** `apps/api/src/routes/players.ts:52-107`. 공개 설정을 SQL에서 적용한다. 리더보드는 :110-169. 화면은 `apps/web/src/pages/Players.tsx`(`PlayerCardPage` :157).
- **관련 API** `GET /api/players/:id/card`.
- **DB** `user_settings`의 `show_stats`(기본 false), `show_achievements`, `share_table`, `show_ranking`(0042).
- **컴포넌트** `PlayerCardPage`, 표에서 좌석을 누르면 뜨는 `PlayerCard`(`apps/web/src/components/Social.tsx:201`).
- **테스트** `tests/integration/players.test.ts`, `privacy.test.ts`, `tests/e2e/players.spec.ts`.
- **현재 한계** 없음. 지시서가 요구한 "비공개 페이지와 공개 페이지의 분리, API에서의 공개 범위 적용"을 이미 지킨다.
- **필요한 변경** 없음. 마이페이지의 [프로필 보기]는 이 페이지로 연결한다.
- **중복 구현 가능성** 마이페이지 안에 공개 카드를 따로 그리면 중복이다.

### 3.4 관리자 콘솔 UI 일관성 — 통합 필요

- **기존 구현 위치** `apps/admin/src/pages/*`(24개 페이지).
  - 공용 조각: `apps/admin/src/ui.tsx`의 LoadError, ListState, PageState, JumpNav, Feedback, ChangedNotice, Pager. 표 컴포넌트는 `pages/Console.tsx:89`의 `Table`이고 15개 페이지가 가져다 쓴다.
  - 사유 템플릿: `adminTemplates.ts:158`, `templateFields.tsx:202`.
- **관련 API** `/api/admin/*`.
- **DB** 없음.
- **컴포넌트** 위와 같음.
- **테스트** `tests/e2e/admin-*.spec.ts`.
- **현재 한계**
  - 오류·빈 상태가 페이지마다 다르다. Security.tsx는 오류를 `<Empty>` 안에 넣고, Dashboard.tsx는 자기만의 배너를 쓴다. Audit·Stats·Brand·Economy·Integrity·Reports·Service·Member는 ListState를 쓰지 않는다.
  - VersionTable을 다섯 페이지가 각자 정의한다(Refill, Referrals, TimeBank, Social, Bots).
  - 서버의 `ReasonSchema`가 9개 라우트 파일에 복사돼 있다.
  - 입력 확인은 Tournaments.tsx(`confirmName`) 한 곳에만 있다.
- **필요한 변경** 이번에 새로 쓰는 화면(Hard Delete)은 기존 ListState·Feedback·Modal·사유 입력 규칙을 그대로 따른다. 이번 기능이 건드리는 페이지의 오류·빈 상태는 공용 조각으로 맞춘다. 관계없는 페이지를 한꺼번에 정리하는 일은 이 작업의 범위가 아니므로 남은 과제로 적는다.
- **중복 구현 가능성** 높음. Hard Delete 화면에 새 확인 방식을 만들면 세 번째 방식이 된다.

---

## 4. 관리자 삭제 (PART 14)

### 4.1 관리자 Hard Delete — 미구현

- **기존 구현 위치** 없음. `ROUTE_RULES`(`apps/api/src/lib/permissions.ts:251-408`)와 admin 라우트 파일에 회원을 지우는 경로가 없다. 지금 있는 삭제 비슷한 기능은 이것뿐이다.
  - 회원 정지: 세션을 지운다(`admin.ts:713`).
  - 연결 끊기: `admin.ts:751`.
  - 관리자 메모의 실제 삭제: 작성자이거나 `notes.delete_any`가 있어야 하며 감사 로그에 본문은 남기지 않는다(`admin.ts:659-668`).
  - 게시글·댓글의 상태 변경 visible|hidden|deleted(`admin-community.ts:61-77`).
  - 공지 soft delete(`admin-service.ts:264`).
  - 테이블 닫기(`admin.ts:1180`), 대회 취소·중단(`admin-tournaments.ts:462/505`), 템플릿 보관(:634).
- **관련 API** 새로 둔다. `/api/admin/hard-delete/preview`, `/api/admin/hard-delete`.
- **DB**
  - 모든 FK가 `ON DELETE no action`이다. 0000~0042 어디에도 CASCADE와 트리거가 없고, 운영 D1은 FK를 검사한다.
  - users를 참조하는 테이블: chip_ledger, hand_players, sessions, table_sessions, tables.created_by, comments, messages, posts, academy_progress, user_badges, direct_messages, friendships, reports, user_blocks, admin_notes, academy_gto_progress, bot_profiles.
  - tables를 참조: hands, table_sessions, direct_messages.table_id.
  - hands를 참조: hand_players, post_hands.
  - posts를 참조: comments, post_hands.
  - reports를 참조: report_events.
- **컴포넌트** 없음. 기존 재인증 모달(`apps/admin/src/main.tsx:130-163`)과 `api()`의 `reauth_required` 처리(`lib.tsx:248`)를 쓴다.
- **테스트** 없음. 재인증 헬퍼는 테스트 파일마다 따로 있다(`members.test.ts:18`, `admin-permissions.test.ts:22`).
- **현재 한계** 운영자가 잘못 만든 데이터를 지울 길이 없다. 그렇다고 모든 것을 지울 수 있게 하면 원장 무결성과 감사 추적이 깨진다.
- **필요한 변경** 삭제 대상을 세 등급으로 나눈다.
  - A(허용): 다른 데이터가 참조하지 않는 운영 데이터. 예: 끝난 공지·점검, 보관된 대회 템플릿, 참가자 없이 취소된 대회.
  - B(조건부): 서버가 실제 참조를 확인해 0일 때만. 예: 핸드가 하나도 없는 닫힌 테이블, 숨김·삭제 상태이고 댓글이 없는 게시글.
  - C(금지): 칩 원장, 감사 로그, 핸드 기록, 회원 계정(탈퇴 절차로만), 진행 중인 테이블.

  절차는 미리보기(서버가 DB 기준으로 영향 범위 계산 + 대상 지문) → 사유 → 관리자 비밀번호 재인증 → 대상 이름 입력 → 서버 재검증(지문 비교, 권한 재확인) → 하나의 batch로 삭제 → 감사 로그다. super_admin만 하고, `ROUTE_RULES`에 등록해 기존 `requirePermission` 체계를 탄다. CASCADE는 추가하지 않는다.
- **중복 구현 가능성** 재인증과 권한 검사를 새로 만들면 기존 체계를 우회하게 된다. `requirePermission`과 `assertRecentReauth`를 그대로 쓴다.

### 4.2 회원 탈퇴(자기 삭제) — 일부

- **기존 구현 위치** `apps/api/src/routes/auth.ts:381-447`.
  - 비밀번호를 확인하고, 앉아 있으면 409를 준다.
  - 계정 행은 남기고 개인정보를 지운다(이메일·닉네임 대체, 아바타·생일 null).
  - 사적인 행은 실제로 지운다(세션, 친구, 차단, DM, 쪽지, 아카데미, 배지, 메모, 설정, 알림).
  - 원장, 핸드, 게시글, 신고, 감사 로그는 남긴다.
- **관련 API** `POST /api/auth/me/delete`.
- **DB** 위와 같음. 정책은 `docs/PRIVACY_OPERATIONS.md` §2~3.
- **컴포넌트** `Me.tsx` 계정 패널.
- **테스트** `tests/integration/auth.test.ts`, `privacy.test.ts` 외 탈퇴 뒤 상태를 보는 여러 파일.
- **현재 한계** 탈퇴 자체는 감사 로그를 남기지 않는다(사용자 동작이라 관리자 감사 대상이 아님).
- **필요한 변경** 없음. Hard Delete는 회원 계정을 C로 두고 이 절차를 대신하지 않는다.
- **중복 구현 가능성** 관리자용 "회원 Hard Delete"를 만들면 이 절차와 겹치고 원장 FK와 충돌한다.

### 4.3 Soft Delete(게시판·공지·쪽지) — 완전 구현

- **기존 구현 위치** `board.ts:186-193/226-234`, `admin-community.ts:61-77`, `admin-service.ts:264-276`, `messages.ts:76-85`.
- **관련 API** 각 라우트.
- **DB** `status='deleted'` 또는 `deleted_at`.
- **컴포넌트** 게시판, 관리자 커뮤니티, 서비스 페이지.
- **테스트** `tests/integration/community.test.ts`, `service.test.ts`, `inbox.test.ts`.
- **현재 한계** 없음.
- **필요한 변경** 없음. Soft Delete를 Hard Delete로 바꾸지 않는다(PART 20-19).
- **중복 구현 가능성** 없음.

---

## 5. 포커 기능 (PART 7·8·9·13)

### 5.1 통계 2.0 — 일부

- **기존 구현 위치**
  - `apps/api/src/routes/me.ts:75-165`(stats), :170(stats/trend). 읽을 때 SQL로 계산한다.
  - 카운터는 `apps/game-worker/src/detail-stats.ts`와 `packages/poker-engine/src/bot.ts`의 `handCounters`.
- **관련 API** `GET /api/me/stats`, `/api/me/stats/trend`, `GET /api/players/:id/card`(공개 허용 시).
- **DB** `hand_players`.
  - 0010: position, vpip, pfr, saw_flop, pot_won(과거 핸드까지 채움).
  - 0040: three_bet, fold_3bet, cbet, fold_cbet, post_bets, post_calls, big_blind(0040 이전 핸드는 NULL). NULL은 "기회 없음"이다.
- **컴포넌트** `apps/web/src/components/PlayStats.tsx`. `pct`는 분모가 0이면 '—'다. 그 밖에 RatioStat, PositionTable, MoreStats, StatsTrend, TrendChart.
- **테스트** `tests/integration/stats.test.ts`, `hand-stats.test.ts`, `tests/e2e/stats.spec.ts`.
- **현재 한계**
  - 메인 통계에 기간 필터(7/30/90/전체)가 없다. 추세에만 `TREND_DAYS [7,30,90]`가 있다.
  - 포지션이 EP/MP/CO/BTN/SB/BB(`packages/types/src/api.ts:436`)라서 UTG가 따로 없다.
  - 표본 수 표시가 일부 항목에만 있다.
- **필요한 변경**
  - stats API에 `days` 파라미터를 둔다(같은 SQL에 기간 조건만 더함).
  - 포지션은 저장된 값 그대로 보인다. UTG는 6인 이하 테이블에서 EP와 같은 자리이므로 이름만 UTG로 표시하고, 9인 테이블의 EP 묶음은 "EP(UTG~UTG+2)"로 밝힌다. 저장값을 다시 계산하지 않는다.
  - 모든 비율 옆에 표본 수를 표시한다.
- **중복 구현 가능성** 통계를 새 테이블이나 클라이언트에서 다시 계산하면 중복이다.

### 5.2 HUD — 미구현

- **기존 구현 위치** 없음(좌석 위 통계 표시 없음).
  - 봇이 쓰는 상대 통계: `apps/game-worker/src/opp-stats.ts`. DO 안에만 있고 클라이언트에 보내지 않는다(`room.ts:2770`).
  - 공개 카드: `players.ts:52-107`. 표에서 좌석을 누르면 `Table.tsx:561` `onSeatClick` → `PlayerCard`(`Social.tsx:201`)가 뜬다.
- **관련 API** 새로 두지 않는다. 기존 공개 카드 API(`/api/players/:id/card`)를 쓰고, `show_stats`를 따른다.
- **DB** hand_players, user_settings.show_stats.
- **컴포넌트** `apps/web/src/game/Seat.tsx`, `PlayerCard`. (`apps/web/test/hand-hud.test.ts`의 "hand HUD"는 초보자용 현재 패 이름 표시이며 플레이어 HUD가 아니다.)
- **테스트** 없음.
- **현재 한계** 좌석에서 상대의 성향을 볼 수 없다.
- **필요한 변경**
  - 좌석을 눌렀을 때 뜨는 기존 플레이어 카드 안에 HUD 줄(VPIP/PFR/3Bet/표본, 펼치면 F3B/CBet/FCB/AF)을 둔다. 공개 설정이 꺼져 있으면 "비공개"로 표시한다.
  - 봇은 봇 표시를 단다.
  - PC는 마우스를 올리거나 누르고, 모바일은 탭한다. 좌석 자체에 상시 표시를 겹쳐 그리지 않으므로 핵심 요소를 가리지 않는다.
- **중복 구현 가능성** DO의 opp-stats를 클라이언트에 보내면 봇용 내부 통계를 공개하게 된다. 공개 카드 API를 재사용한다.

### 5.3 핸드 분석·솔버 연결 — 일부

- **기존 구현 위치**
  - `apps/web/src/game/strategy.ts`: 결정마다 그때 보이던 정보만으로 계산한다.
  - `SOLVER_PROVIDERS = []`(:201). `solverFor`(:217)는 위치가 없으면 `noPosition`, 공급자가 없으면 `noData`인 unsupported를 돌려준다.
  - 화면: `StrategyPanel.tsx`, `HandReplay.tsx:133`, `potOdds.ts`, `HandReview.tsx`.
- **관련 API** `GET /api/me/hands/:id`(자기 핸드만, 남의 홀카드는 쇼다운에서 보인 것만).
- **DB** hands, hand_players.
- **컴포넌트** 위와 같음.
- **테스트** `apps/web/test/strategy.test.ts`, `hand-review.test.ts`, `tests/e2e/replay-strategy.spec.ts`, `hand-review.spec.ts`.
- **현재 한계** 지시서가 요구한 `SolverProvider`의 `analyze/getStatus/getResult` 비동기 형태가 아니다(동기 `lookup`).
- **필요한 변경** 기존 `StrategyProvider`를 비동기 `SolverProvider`(analyze → 작업 id, getStatus, getResult)로 넓힌다. 연결된 공급자가 없으면 지금처럼 "분석 불가"를 보이고, 가짜 GTO 결과는 만들지 않는다. 교육용 계산(팟 오즈, SPR, 오픈 레인지)은 그대로 둔다.
- **중복 구현 가능성** 분석 패널을 새로 만들면 StrategyPanel과 겹친다.

### 5.4 봇 연습 모드 — 통합 필요

- **기존 구현 위치**
  - 아카데미 자유 연습: `apps/web/src/academy/practice/free.ts:119` + `bots.ts:40`. 브라우저 안에서 따로 짠 봇이 돈다.
  - 서버 봇: `packages/poker-engine/src/bot.ts`(`decideBot` :252). 성향은 `packages/types/src/bots.ts:7`. 관리 API는 `admin-bots.ts`.
- **관련 API** 연습은 API 없음(클라이언트 전용).
- **DB** 없음. 연습 칩 테이블도 없다.
- **컴포넌트** 아카데미 practice 라우트(`main.tsx:269-270`).
- **테스트** `tests/e2e/academy.spec.ts`, `academy-mobile.spec.ts`, `packages/poker-engine/test/bot.test.ts`.
- **현재 한계**
  - 연습 봇이 서버 봇과 다른 규칙으로 판단한다. 연습해 본 상대와 실제 봇이 다르다.
  - 연습 옵션(인원, 블라인드, 봇 성향, 스택)이 적다.
- **필요한 변경** 연습 봇이 `@jc/poker-engine`의 `decideBot`을 그대로 쓰게 하고, 옵션을 늘린다. 연습은 지금처럼 브라우저 안에서만 돌아 지갑·원장·공식 전적과 완전히 떨어져 있다. 서버 쪽 연습 칩 경로는 만들지 않는다.
- **중복 구현 가능성** 이미 중복이 있다(봇 두 개). 이번에 하나로 모은다.

### 5.5 봇 품질(CBet 폴드율) — 개선 필요

- **기존 구현 위치** `packages/poker-engine/src/bot.ts`(BotView는 자기 카드와 공개 정보만 본다). 설계는 `docs/BOT_AI.md`.
- **관련 API** 없음.
- **DB** bot_events, bot_profiles.
- **컴포넌트** 없음.
- **테스트** `packages/poker-engine/test/bot.test.ts`, `apps/game-worker/src/bots.test.ts`, `opp-stats.test.ts`. 예전 봇과 비교하는 시뮬레이션 `packages/poker-engine/sim/`이 있다.
- **현재 한계** 지시서는 봇이 CBet에 너무 자주 폴드한다고 본다. 아직 측정된 근거가 없다.
- **필요한 변경** 먼저 시뮬레이션으로 봇의 fold-to-CBet을 잰다. 기준(사람 풀의 흔한 범위)을 벗어나면 원인이 되는 판단을 고치고, 다시 잰 수치를 남긴다. 측정 없이 수치를 바꾸지 않는다.
- **중복 구현 가능성** 없음.

---

## 6. 토너먼트 (PART 5·6·12)

### 6.1 SNG — 완전 구현

- **기존 구현 위치** `apps/api/src/routes/tournaments.ts`(register :150, unregister :220, invite :264), `apps/game-worker/src/tournament.ts`, `apps/api/src/lib/tournament.ts`.
- **관련 API** `/api/tournaments/*`, `/api/admin/tournaments/*`.
- **DB** tournaments, tournament_entries, tournament_templates(0026, FK 없음).
- **컴포넌트** `TournamentHud.tsx`, `TournamentResult`(상위 6명).
- **테스트** `tests/integration/tournaments.test.ts`, `tournament-invite.test.ts`, `tests/e2e/tournament-mobile.spec.ts`, `tournament-nav-mobile.spec.ts`.
- **현재 한계** 없음(지시서 범위 기준).
- **필요한 변경** MTT와 비공개 SNG가 이 흐름에 영향을 주지 않아야 한다.
- **중복 구현 가능성** 비공개 SNG를 별도 대회 엔진으로 만들면 중복이다.

### 6.2 MTT — 미구현

- **기존 구현 위치** 설계만 있다(`docs/TOURNAMENT_MTT.md`). 코드와 `MTT_ENABLED`는 없다.
- **관련 API** 없음.
- **DB** 없음.
- **컴포넌트** 없음.
- **테스트** 없음.
- **현재 한계** 여러 테이블을 묶는 조정자(TournamentCoordinator)가 없다.
- **필요한 변경** 설계 문서의 TournamentCoordinator 방식으로 둔다. `MTT_ENABLED`(기본 꺼짐)가 꺼져 있으면 라우트와 화면이 존재하지 않는 것처럼 동작해 SNG에 영향이 없다.
- **중복 구현 가능성** 테이블 로직(TableRoom)을 복제하지 않는다. 조정자는 기존 TableRoom을 여러 개 다룬다.

### 6.3 관전·파이널 테이블 — 일부

- **기존 구현 위치** 관전자에게는 홀카드를 보내지 않는다(`apps/game-worker/src/room.ts:3276-3278`, `packages/poker-engine/src/hand.ts:669-670`). 비공개 방은 관전할 수 없다(`room.ts:544-547`).
- **관련 API** WS `/ws/tables/:id`(관전).
- **DB** 없음.
- **컴포넌트** `Table.tsx` 관전 모드.
- **테스트** `tests/integration/multiplayer.test.ts`, `private-access.test.ts`, `tournaments.test.ts`(관전 경우 포함).
- **현재 한계** 대회 테이블을 관전할 때 대회 정보(남은 인원, 블라인드 레벨, 파이널 테이블 여부)를 보여 주는 겹침 화면이 없다.
- **필요한 변경** 기존 TournamentHud를 관전에서도 쓰고, 파이널 테이블이면 표시를 단다. 홀카드 규칙은 바꾸지 않는다.
- **중복 구현 가능성** 관전 전용 상태 전송을 따로 만들면 중복이다.

### 6.4 비공개 친구 SNG — 미구현

- **기존 구현 위치** 없음. 대회 생성은 관리자만 할 수 있고(`admin-tournaments.ts:314`), 대회 테이블은 `is_private=0`(`lib/tournament.ts:385`)이다. 재사용할 것은 다음과 같다.
  - 비공개 방 참가 코드: `rooms.ts`, `joinCodeHash = sha256(id:code)`.
  - 접근 쿠키: `room-access.ts`(HMAC `jc_room_<id>`).
  - 친구 초대: `social.ts:340-355`.
- **관련 API** 없음.
- **DB** tournaments(비공개 여부와 참가 코드 해시 열이 필요).
- **컴포넌트** 없음.
- **테스트** 없음.
- **현재 한계** 친구끼리 대회를 열 수 없다.
- **필요한 변경** 회원이 SNG를 열고 코드·링크·친구 목록으로 초대한다. 링크에는 대회 id만 두고 코드는 따로 입력한다. 서버가 참가 권한을 검사하고, 공개 대회 목록에는 내보이지 않는다. 칩은 기존 buy_in/cash_out 원장 경로만 쓴다.
- **중복 구현 가능성** 초대 코드 체계를 새로 만들면 중복이다. 방의 해시·쿠키 방식을 재사용한다.

---

## 7. 편의 기능 (PART 10·11)

### 7.1 일일·주간 도전 — 미구현

- **기존 구현 위치** 없음.
  - 업적 8종은 칩 보상 없이 배지만 준다(`user_badges 'play:'`, `packages/db/src/achievementsSql.ts`). streak_7은 active_days와 housekeeping cron으로 판정한다.
  - 칩이 생기는 길은 리필과 추천뿐이다. `Refill.tsx:56`에 "로그인 연속 보상 없음"이 의도로 적혀 있다.
- **관련 API** 없음.
- **DB** 없음.
- **컴포넌트** 없음.
- **테스트** 없음.
- **현재 한계** 반복해서 할 목표가 없다.
- **필요한 변경** 도전 진행도는 서버가 hand_players 등 기존 기록으로 판정하고, 같은 기간에 한 번만 인정한다(멱등). 보상은 칩이 아닌 배지·표시로 한정한다. 칩 보상을 주면 지시서가 금지한 새 칩 생성 경로가 생기고 리필 정책과도 어긋나기 때문이다. 클라이언트의 완료 요청만으로는 아무것도 주지 않는다.
- **중복 구현 가능성** 업적 판정 SQL과 겹칠 수 있다. `achievementsSql.ts`의 판정 방식을 재사용한다.

### 7.2 업적 — 완전 구현

- **기존 구현 위치** `packages/db/src/achievements.ts`, `achievementsSql.ts`, `user_badges`, 공개 설정 `show_achievements`(0042).
- **관련 API** `/api/me`, `/api/players/:id`.
- **DB** user_badges, active_days.
- **컴포넌트** 배지 목록.
- **테스트** `tests/integration/achievements.test.ts`, `players.test.ts`.
- **현재 한계** 없음.
- **필요한 변경** 없음.
- **중복 구현 가능성** 없음.

### 7.3 즐겨찾기·최근 테이블 — 일부

- **기존 구현 위치**
  - 즐겨찾기: `user_settings.fav`로 서버에 동기화된다(`prefs.ts:184/202`).
  - 최근 테이블: localStorage(`lobby.ts:289-342`, `RECENT_MAX=8`). `Table.tsx:337`에서 기록한다.
- **관련 API** settings.
- **DB** user_settings.
- **컴포넌트** 로비.
- **테스트** `tests/e2e/lobby.spec.ts`, `lobby-mobile.spec.ts`, `tests/integration/settings-sync.test.ts`.
- **현재 한계** 최근 테이블이 기기마다 따로다.
- **필요한 변경** 최근 테이블만 기존 settings 동기화에 얹는다. 즐겨찾기는 그대로 둔다.
- **중복 구현 가능성** 새 테이블이나 새 API를 만들면 중복이다.

### 7.4 비공개 방·초대 — 완전 구현

- **기존 구현 위치** `rooms.ts`, `tables.ts:214-226`(`POST /:id/access`), `room-access.ts`, `social.ts:340-355`.
- **관련 API** 위와 같음.
- **DB** tables(join_code_hash).
- **컴포넌트** 방 만들기, 초대.
- **테스트** `tests/integration/rooms.test.ts`, `private-access.test.ts`, `tests/e2e/rooms.spec.ts`, `private-access.spec.ts`.
- **현재 한계** 없음. 링크 `/table/<id>`에 코드가 들어가지 않는다.
- **필요한 변경** 없음. 비공개 SNG가 이 방식을 재사용한다.
- **중복 구현 가능성** 없음.

---

## 8. 관리·데이터 기반

### 8.1 관리자 권한·재인증 — 완전 구현

- **기존 구현 위치**
  - `apps/api/src/lib/permissions.ts`: `CAPABILITIES` :30-61, `GRANTS` :116-142, `ROUTE_RULES` :251-408, `requirePermission` :449-458. 규칙이 없거나 권한이 꺼져 있으면 거부한다.
  - 미들웨어 순서 `requireAdminOrigin → auditFailures → requireAdmin → requirePermission`(`admin.ts:343-346`).
  - 재인증: `admin-auth.ts:96-108`(비밀번호, 15분에 10회), 유효 5분(`session.ts:20`).
  - 역할은 요청마다 다시 읽는다. 역할을 바꾸면 대상의 세션을 지운다(`admin.ts:825`).
- **관련 API** `/api/admin/auth/*`, `/api/admin/security/*`.
- **DB** users.role, sessions.reauth_at, admin_permissions.
- **컴포넌트** 재인증 모달(`apps/admin/src/main.tsx:130-163`).
- **테스트** `apps/api/src/lib/permissions.test.ts`, `tests/integration/admin-permissions.test.ts`, `staff-safety.test.ts`.
- **현재 한계** 없음.
- **필요한 변경** Hard Delete 라우트를 `ROUTE_RULES`에 super_admin + reauth로 등록한다.
- **중복 구현 가능성** 새 권한 검사를 만들면 우회가 된다.

### 8.2 칩 원장 — 완전 구현

- **기존 구현 위치** `packages/db/src/ledger.ts`(`applyLedger` :51-75, `LEDGER_GUARD` :78, `findLedgerMismatches` :87-96), 대사(`admin.ts:1360-1506`).
- **관련 API** 원장을 쓰는 모든 경로. 관리자 원장·대사 화면.
- **DB** `chip_ledger`(유일 멱등 키, 유형 9종).
- **컴포넌트** 원장 패널, 관리자 Integrity.
- **테스트** `tests/integration/economy.test.ts`, `admin.test.ts`, `admin-concurrency.test.ts`, `refill.test.ts`.
- **현재 한계** "고치거나 지우지 않는다"는 원칙이 코드 주석과 문서에만 있다. DB에서 막는 것은 users FK뿐이다.
- **필요한 변경** 없음. Hard Delete가 chip_ledger를 C(금지)로 두고 서버가 그 대상을 거부한다.
- **중복 구현 가능성** 도전 보상 같은 새 칩 경로를 만들면 이 원장의 원칙을 깬다.

### 8.3 감사 로그 — 완전 구현

- **기존 구현 위치** `apps/api/src/lib/audit.ts`(`audit` :14-38, `searchAudit` :83, `auditFailures` :164). 이 테이블을 지우는 코드는 어디에도 없다.
- **관련 API** `GET /api/admin/audit`(`audit.all`이 없으면 자기 것만).
- **DB** `admin_audit_log`.
- **컴포넌트** 관리자 Audit.
- **테스트** `tests/integration/admin.test.ts`, `admin-permissions.test.ts`, `admin-bulk.test.ts`.
- **현재 한계** 보존 기간이 정해지지 않았다(`PRIVACY_OPERATIONS.md:73`).
- **필요한 변경** 없음. Hard Delete는 감사 로그에 대상 종류, id, 영향 건수, 사유만 남기고 본문은 복사하지 않는다. 감사 로그 자체는 C(금지)다.
- **중복 구현 가능성** 없음.

### 8.4 마이그레이션 체계 — 완전 구현

- **기존 구현 위치** `packages/db/migrations/0000~0042`, wrangler D1 migrations. 배포 전에 원격에 적용한다(`docs/DEPLOYMENT.md:59-79`).
- **관련 API** 없음.
- **DB** 전체.
- **컴포넌트** 없음.
- **테스트** 실제 파일을 node:sqlite에 적용하는 패턴(`tests/integration/bot-profiles-migration.test.ts`).
- **현재 한계** 없음.
- **필요한 변경** 새 마이그레이션은 열 추가와 새 테이블만 하고, 기존 행을 바꾸지 않으며, 기본값으로 기존 동작을 유지한다(예: 비공개 SNG 열 기본 0). 각 마이그레이션의 배포·되돌리기 메모를 DEPLOYMENT.md에 적는다.
- **중복 구현 가능성** 없음.

### 8.5 테스트 인프라 — 일부

- **기존 구현 위치**
  - 통합 테스트: `tests/vitest.config.ts`, `tests/support/global-setup.ts`(포트 8799, super-admin 부트스트랩), `worker.ts`(TABLES 시드), `client.ts`, `d1.ts`, `grants.ts`.
  - E2E: `tests/e2e/server.mjs`(8798), `helpers.ts`, `analytics-helpers.ts`(`adminLogin`, `sql`).
- **관련 API** 없음.
- **DB** 로컬 D1 상태(`tests/.state`).
- **컴포넌트** 없음.
- **테스트** 해당 없음.
- **현재 한계** 재인증 헬퍼를 공유하지 않는다. 지시서의 9개 뷰포트 캡처를 한꺼번에 찍는 스크립트가 없다.
- **필요한 변경** Hard Delete 테스트에 쓸 재인증 헬퍼를 `tests/support`에 둔다. 기존 파일의 헬퍼는 그대로 둔다. 9개 뷰포트 캡처는 E2E로 찍는다.
- **중복 구현 가능성** 없음.

---

## 9. 진행 순서와 브랜치

| Phase | 브랜치 | 내용 |
|---|---|---|
| P1 | `feat/v3-p1-analysis` | 이 문서 |
| P2 | `feat/v3-p2-stability` | 2.1 outbox, 2.2 복구 표시, 2.3 측정 |
| P3 | `feat/v3-p3-ui` | Tabs, 마이페이지, 관리자 UI 일관성(이번에 건드리는 화면) |
| P4 | `feat/v3-p4-hard-delete` | Hard Delete와 14개 시험 |
| P5 | `feat/v3-p5-poker` | 통계 2.0, HUD, SolverProvider, 연습 모드, 봇 측정 |
| P6 | `feat/v3-p6-tournaments` | MTT(꺼짐), 관전 겹침, 비공개 SNG |
| P7 | `feat/v3-p7-convenience` | 도전, 최근 테이블 동기화 |
| P8 | `feat/v3-p8-verify` | 통합 검증, 9개 뷰포트, 문서 |

각 브랜치는 앞 브랜치 위에 쌓는다. `main`에는 직접 올리지 않으며(자동 배포), 병합과 운영 배포는 사용자의 승인을 받는다.

---

## 10. 8단계 뒤 결과 (2026-11-04)

1절의 28개 항목을 P2–P7을 마친 뒤 다시 분류했다. 분류는 지시서 PART 21 B의 여섯 가지다(신규 구현 완료, 기존 기능 확장, 기존 기능 재사용, 중복 방지로 구현 생략, 일부 완료, 미구현). 근거와 시험은 `docs/TEST_REPORT.md`의 'V3 n단계' 절과 `docs/STATUS.md` 67–74번이다. 모두 작업 브랜치에만 있고 운영에는 배포하지 않았다.

| # | 기능 | 1단계 분류 | 결과 | 단계 | 남은 것 |
|---|---|---|---|---|---|
| 1 | 실시간 이벤트 전달(outbox) | 개선 필요 | 기존 기능 확장 | P2 | 룸이 직접 보내는 대회 탈락·종료 이벤트는 아웃박스 밖(60초 폴링) |
| 2 | 재접속·복구 표시 | 개선 필요 | 기존 기능 확장 | P2 | — |
| 3 | 성능 측정 체계 | 일부 | 기존 기능 재사용 | P2·P8 | 같은 부하·렌더링 시험으로 main과 비교(LOAD_TEST 8·9절). 운영 측정 없음 |
| 4 | 디자인 시스템 | 일부 | 기존 기능 확장 | P3·P8 | `Tabs`, `buttonClass`, 모달 닫기·입력·머리글 단추의 40 px 터치 영역 |
| 5 | 마이페이지 | 개선 필요 | 기존 기능 확장 | P3 | 320–390 px에서 탭 줄은 옆으로 스크롤(설계), 고른 탭은 줄 안에 보이게 스크롤(P8) |
| 6 | 공개 프로필 | 완전 구현 | 기존 기능 재사용 | P3 | 마이페이지 '프로필 보기'가 이 페이지로 간다 |
| 7 | 관리자 콘솔 UI 일관성 | 통합 필요 | 일부 완료 | P4 | 새 화면(영구 삭제)만 공용 조각을 따른다. 다섯 벌의 VersionTable, 아홉 벌의 `ReasonSchema`, ListState를 쓰지 않는 페이지는 그대로 |
| 8 | 관리자 Hard Delete | 미구현 | 신규 구현 완료 | P4 | 조건부(B) 셋만. 2인 승인 없음, 방 검사 시험 없음, 방 저장소는 지우지 않음 |
| 9 | 통계 2.0 | 일부 | 기존 기능 확장 | P5 | — |
| 10 | HUD | 미구현 | 신규 구현 완료 | P5 | 마우스 올림 없음(누름·터치로만) |
| 11 | 핸드 분석·솔버 연결 | 일부 | 일부 완료 | P5 | 솔버를 연결하지 않아 솔버 분석은 모두 "분석 불가". 아웃·승률 없음 |
| 12 | 봇 연습 모드 | 통합 필요 | 기존 기능 확장 | P5 | 연습 결과에 드로 이름 없음 |
| 13 | 봇 품질(C벳 폴드) | 개선 필요 | 기존 기능 확장 | P5 | 공격적 상대는 덜 넓게 읽음, 턴 배럴·멀티웨이는 맞추지 않음 |
| 14 | SNG | 완전 구현 | 기존 기능 재사용 | — | MTT 테이블이 같은 룸 코드를 쓴다 |
| 15 | MTT | 미구현 | 일부 완료 | P6·P8 | 플래그 뒤(기본 꺼짐, 정원 60). 버블 핸드 포 핸드·파이널 테이블 버튼 뽑기·장애 주입 통합 시험·100명 부하 없음. 이동 중 닫힌 테이블은 페이지가 대회 기록을 물어 따라감(P8), 조정자가 다음 목적지를 따로 기록하지는 않음 |
| 16 | 관전·파이널 테이블 | 일부 | 기존 기능 확장 | P6 | `FINAL TABLE`은 MTT에만 |
| 17 | 비공개 친구 SNG | 미구현 | 신규 구현 완료 | P6 | 비공개 MTT·자동 만료 없음 |
| 18 | 일일·주간 도전 | 미구현 | 신규 구현 완료 | P7 | 아카데미 과제·완료 알림 없음 |
| 19 | 업적 | 완전 구현 | 기존 기능 재사용 | P7 | `challenges_10` 한 줄을 기존 목록에 |
| 20 | 즐겨찾기·최근 테이블 | 일부 | 기존 기능 확장 | P7 | 최근 방문은 기기별 그대로, 로비 '관전 중' 표시 없음 |
| 21 | 비공개 방·초대 | 완전 구현 | 중복 방지로 구현 생략 | — | 비공개 대회 초대는 기존 알림함·친구 확인을 쓴다 |
| 22 | 관리자 권한·재인증 | 완전 구현 | 기존 기능 재사용 | P4 | 능력 `data.purge` 하나를 기존 체계에 더함 |
| 23 | 칩 원장 | 완전 구현 | 기존 기능 재사용 | — | 바꾸지 않음. 새 보상 원장·칩 경로 없음 |
| 24 | 감사 로그 | 완전 구현 | 기존 기능 재사용 | P4 | 영구 삭제가 같은 감사 로그에 쓴다. 감사 로그는 삭제 대상 아님 |
| 25 | 회원 탈퇴 | 일부 | 중복 방지로 구현 생략 | — | 관리자 회원 영구 삭제를 만들지 않고 기존 탈퇴 절차를 그대로 둠 |
| 26 | Soft Delete | 완전 구현 | 기존 기능 재사용 | — | 일반 삭제를 영구 삭제로 바꾸지 않음 |
| 27 | 마이그레이션 체계 | 완전 구현 | 기존 기능 재사용 | P6·P7 | 0043(열·인덱스 추가), 0044(새 테이블) |
| 28 | 테스트 인프라 | 일부 | 기존 기능 확장 | P8 | 9개 화면 크기 시각 점검(`tests/e2e/viewports.spec.ts`), CI E2E 두 조각. 실기기 확인 없음 |
