# 인수인계 (다음 세션용)

> 새 기기 또는 새 Claude 세션은 이 파일부터 읽는다. 마지막 갱신: 2026-10-22 (병합 뒤 E2E 타이밍 수정 브랜치 `fix/e2e-settle`). 그 전: 2026-10-22 (폴드 후 바로 일어서기·지갑/반응 겹침 브랜치 `feat/fold-leave`), 2026-10-21 (베팅 라인 이미지·마지막 접속·자동 리바이/스택 보충 브랜치 `feat/betline-rebuy`), 2026-10-19 (접속 상태·웹 푸시·알림 설정·색각 보조 브랜치 `feat/presence-push-a11y`), 2026-10-19 (최종 품질 고도화·릴리스 안정화 브랜치 `feat/release-polish`), 2026-10-18 (종합 완성도 고도화 브랜치 `feat/polish`), 2026-10-17 (플랫폼 고도화 브랜치), 2026-10-15 (운영 도메인 jc-royal.site, 메일 발신 주소)

## 현재 상태

- `docs/DIRECTIVE.md` Phase 1~9와 포커 아카데미를 구현했다.
- 검증 결과는 `docs/TEST_REPORT.md`와 `docs/STATUS.md`에 있다.
- **운영 배포 완료**(2026-10-14, Workers Paid. 첫 배포는 로컬 wrangler, 이후 GitHub Actions):
  - 사용자 사이트: https://jc-royal.site
  - 관리자 콘솔: https://admin.jc-royal.site
  - 두 도메인은 대시보드에서 커스텀 도메인으로 붙였다. workers.dev 주소(https://play.jcroyal.workers.dev, https://admin.jcroyal.workers.dev)는 개발·미리보기용으로 남겼고, 관리자 로그인은 새 도메인에서만 된다(`docs/DEPLOYMENT.md` 운영 주소, 4절).
  - Worker: `jc-royal-game-prod` → `play` → `admin`
  - D1: `jc-royal-db-prod`(APAC), 마이그레이션 `0000`~`0004` 적용
  - 시크릿: 두 Worker에 `INTERNAL_SECRET`, `play`에 `RESEND_API_KEY`
- 최초 슈퍼관리자: ckato9173@gmail.com(부트스트랩 완료, `ADMIN_BOOTSTRAP_TOKEN` 삭제함). 다른 관리자는 이 계정이 콘솔에서 권한을 준다.
- **배포 자동화**: `main`에 push하고 CI가 통과하면 GitHub Actions가 운영에 배포한다(`docs/DEPLOYMENT.md` 3절). 저장소 시크릿 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`가 있어야 동작한다.
- **가입·회원 정보 개편**(운영 반영됨): 이메일 인증번호(메일 설정 전까지 꺼짐), 생년월일(만 14세), 필수 동의, 비밀번호 규칙(8자 이상, 영문·숫자·특수문자), 이메일 도메인 직접 선택, 계정 언어, 관리자 CSV 내보내기.
- **플랫폼 고도화 브랜치 `feat/platform-upgrade`(main에 병합: PR #6, 뒤이은 CI 수정 PR #7)**:
  - origin/main(753e3a3)에서 갈라졌다.
  - 더한 기능: 링크 미리보기·공유, 폴드한 패 보이기, 운영진 표시, BB 단위, 빠른 반응, 무료 칩 보충, 서버 봇, 추천 보상, 리플레이 가림 수정·타임라인, 핸드 복기, PWA 설치 안내, 계정 설정 동기화, 시간 은행, 무료 6인 토너먼트, 관리자별 기능 스위치, 소셜 정책·브랜드 상태.
  - 마이그레이션 `0020`~`0028`을 더한다. 배포 순서는 `docs/DEPLOYMENT.md` 3절에 있다.
  - 로컬 검증 결과는 `docs/TEST_REPORT.md`의 '전체 검증(P12)'과 'Codex 브랜치 리뷰(G014)'에, 기능별 범위와 한계는 `docs/STATUS.md` 21–39번에 있다.
  - 마지막으로 브랜치 전체를 Codex로 검토해 받은 지적 5건(자동 머크 순서, 추천 동시 가입, 테이블 설정 동시 수정, 여러 테이블 보충 합계, 대회 시작 자격)을 고쳤다(`docs/STATUS.md` 39번).
  - 운영 환경과 실기기에서는 확인하지 않았다. 정책의 운영 값(무료 칩·봇·추천·시간 은행·토너먼트 기본값)도 정하지 않았다.
- **종합 완성도 고도화 브랜치 `feat/polish`(main에 병합: PR #8)**:
  - main(`66c7146`)에서 갈라졌다. 새 기능, 서버·엔진·스키마·API 변경, 마이그레이션은 없다.
  - 칩·팟·카드·쇼다운 연출을 서버 cue의 금액대로 순서 있게 보인다(`apps/web/src/game/staging.ts`). 끝값이 서버 상태와 다르면 연출을 버린다.
  - 사운드 겹침·동시 재생 제한(`packages/audio/src/mixer.ts`), 액션 처리 중 표시, 로비·핸드 목록·아카데미 사이의 돌아가기, 불러오기 실패의 다시 시도를 다듬었다.
  - Codex 리뷰(읽기 전용) 지적 5건과 직접 찾은 반올림 문제를 두 번째 커밋에서 고쳤다. 계획은 칩을 옮기는 좌석의 사람(`Plan.who`)이 바뀌면 끝나고, 끝난 핸드는 지급 cue가 있고 끝 팟이 0일 때만 연출한다. 믹서는 꽉 차면 가장 먼저 끝날 배경 소리를 멈춘다.
  - Codex 재리뷰 지적도 같은 커밋에 반영했다. 계획은 칩을 옮기는 좌석의 사람을 앞뒤 상태에서 비교한다. 소리를 멈출 때(`packages/audio`의 `silence`)는 지금 게인을 고정한 뒤 줄이고, 아직 시작하지 않은 부분은 바로 멈춘다. 실제 Chrome 측정은 `docs/test-logs/polish-audio-fade.json`.
  - 검증과 한계는 `docs/TEST_REPORT.md` '종합 완성도 고도화'와 `docs/STATUS.md` 40번에 있다. 실기기와 운영 환경에서는 확인하지 않았다.
- **그 뒤 병합된 PR과 main 배포**(GitHub Actions 기록으로 확인, 운영 화면·D1·로그는 보지 않음):
  - PR #8(`20e33b4`): main CI의 E2E가 실패해 배포 잡이 돌지 않았다. PR #9(`fix/lobby-url-race`, `cd3ed59`)가 고쳤다(`docs/STATUS.md` 41번).
  - PR #9: 배포 단계(마이그레이션, game·play·admin)는 끝났고, 마지막 확인 단계가 커스텀 도메인 health의 403으로 실패했다.
  - PR #10(`feat/followups`, `eb3435c`): main CI의 통합이 실패해 배포 잡이 돌지 않았다(`docs/STATUS.md` 42번).
  - PR #11(`fix/ci-followups`, `7eeff6d`): PR #9와 같이 배포 단계는 끝났고 확인 단계가 403으로 실패했다(`docs/STATUS.md` 43번).
  - 2026-10-19에 이 PC에서 공개 주소(커스텀 도메인 두 화면과 health, workers.dev 두 주소)를 GET으로만 열었고 모두 200이었다. 그 밖의 운영 확인은 하지 않았다.
- **최종 품질 고도화·릴리스 안정화 브랜치 `feat/release-polish`(main에 병합: PR #12, `810eb14`. 그 main CI 39178998245가 성공해 운영에 자동 배포됨, GitHub Actions 기록으로만 확인)**:
  - main(`7eeff6d`)에서 갈라졌다. 새 기능, 서버·엔진·원장·스키마·API·관리자 코드 변경, 마이그레이션은 없다.
  - 배포 확인 단계(`deploy.yml`)가 workers.dev 주소를 먼저 보고, 커스텀 도메인의 챌린지 403만 경고로 둔다. 테이블 페이지를 필요할 때 받아 첫 화면 JS가 580KB다(한도 650KB 그대로). 가로 휴대폰은 조작을 오른쪽 열로 옮겼다. 844×390에서는 9인도 계산상 겹침이 0이지만, 더 짧은 가로 화면(812×375 BB, 800×360 BB, 667×375)에서는 겹침이 조금 남는다. 레이즈 패널 대상은 40px 이상이다.
  - 검증과 한계는 `docs/TEST_REPORT.md` '최종 품질 고도화·릴리스 안정화'와 `docs/STATUS.md` 44번에 있다. 로컬 E2E는 일부만 돌렸고(나머지는 PR CI), 실기기와 운영 환경에서는 확인하지 않았다.
- **접속 상태·웹 푸시·알림 설정·색각 보조 브랜치 `feat/presence-push-a11y`(main에 병합: PR #13, `d817311`. 그 main CI는 실패했고, 뒤이은 PR #14 `fix/settings-e2e-pref-count`(`cf76b7f`)의 main CI 39222736280이 성공해 운영에 배포됨, GitHub Actions 기록으로만 확인)**:
  - main(`810eb14`)에서 갈라졌다. 마이그레이션 `0029_presence_push`·`0030_push_sent_idx`(인덱스 하나)와 game-worker의 DO 마이그레이션 `v2`(`PresenceHub`, 메모리만)를 더한다. 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin(`docs/DEPLOYMENT.md` 3절).
  - 친구에게만 보이는 온라인·자리 비움·오프라인, 계정의 표시 모드, DM·초대·친구 요청·수락·대회 시작·취소·결과의 웹 푸시(계정 동의·야간 동의·기기 권한 분리, 야간 21:00–08:00 KST 서버 판단), 발송 큐, 색각 모드 다섯 가지. 테이블 채팅 푸시는 만들지 않았다. 설계와 결정은 `docs/PRESENCE.md`.
  - **운영 VAPID 키는 2026-10-21에 오너의 요청으로 넣었다**(`node tools/vapid-keys.mjs`로 한 쌍을 만들어 운영 API Worker `play`의 시크릿 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY`에 등록, `wrangler secret list`로 확인. 개인 키는 파일·로그에 남기지 않았다). 그 전까지 운영에서 푸시는 꺼져 있었다. 실기기에서 받기·누르기·배지는 아직 확인하지 않았다. 키를 바꾸는 절차와 영향은 `docs/DEPLOYMENT.md` 2절.
  - 검증과 한계는 `docs/TEST_REPORT.md` '접속 상태·웹 푸시·알림 설정·색각 보조'와 `docs/STATUS.md` 45번에 있다. 실기기(푸시 수신·클릭·배지), 실제 색각 이상 사용자, 운영 환경에서는 확인하지 않았다. 야간 기준과 동의 문구는 법무 검토 전이다.
- **그 뒤 병합된 PR과 main 배포**(GitHub Actions 기록으로만 확인, 운영 화면·D1·로그는 보지 않음):
  - PR #15 `feat/game-ux-vip-gto`(`aaa59ab`): main CI가 실패했고, PR #16 `fix/e2e-after-pr15`(`b0f5d15`)의 main CI 39277263962가 성공해 배포됐다(`docs/STATUS.md` 46번).
  - PR #17 `feat/bot-ai-2`(`3c4ef90`): main CI 39350714707이 성공해 배포됐다(`docs/STATUS.md` 47번).
  - PR #18 `feat/quality-replay`(`677a487`): main CI의 E2E가 실패했고, PR #19 `fix/e2e-after-pr18`(`ee379c0`)의 main CI 39462692675가 성공해 배포됐다(`docs/STATUS.md` 48번).
- **베팅 라인 이미지·마지막 접속·자동 리바이/스택 보충 브랜치 `feat/betline-rebuy`(main에 병합: PR #20, `f5ee1ec`. 그 main CI와 PR #21 `fix/e2e-after-pr20`(`bb16adf`)의 main CI는 실패했고, PR #22 `fix/bots-test-bust`(`e985f1e`)의 main CI 39532997483이 성공해 마이그레이션 0033과 함께 배포됨, GitHub Actions 기록으로만 확인)**:
  - main(`677a487`)에서 갈라졌고 `ee379c0`를 병합했다. 마이그레이션 `0033_presence_last_online`(`users.last_online_at` 열 하나)을 더한다. 배포 순서는 마이그레이션 → game-worker → api(web 포함) → admin(`docs/DEPLOYMENT.md` 3절, 이전 버전과 섞인 동안의 동작도 거기에).
  - 공유 이미지의 기본 템플릿이 베팅 라인(스트리트별 액션·금액·보드, 결과는 보조)이 됐다. 친구가 오프라인일 때 마지막 접속 시각('N분 전 접속')을 보인다(`docs/PRESENCE.md` '마지막 접속 시각'). 첫 바이인 창에서 자동 칩 정책(사용 안 함·자동 리바이·자동 스택 보충) 하나를 고른다. 기존 수동 칩 추가의 원장 경로와 멱등 키 방식을 그대로 쓴다.
  - 검증과 한계는 `docs/TEST_REPORT.md` '베팅 라인 이미지·마지막 접속·자동 리바이/스택 보충'과 `docs/STATUS.md` 49번에 있다. 휴대폰은 에뮬레이션에서만, 운영 환경과 실기기에서는 확인하지 않았다. 개인정보 처리방침 버전(`PRIVACY_NOTICE_VERSION`)을 올릴지는 운영 전에 정해야 한다.
- **그 뒤 병합된 PR과 main 배포**(GitHub Actions 기록으로만 확인, 운영 화면·D1·로그는 보지 않음):
  - PR #23 `feat/perf-reveal`(`7f47deb`, `docs/STATUS.md` 51번): main CI가 E2E(언어 선택의 이름이 둘)로 실패했고, PR #24 `fix/lang-toggle-label`(`105b735`)의 main CI는 리플레이 E2E 하나로 실패했다. PR #25 `fix/replay-capture-settle`(`bd98776`)의 main CI 39590814896이 성공해 배포됐다.
- **폴드 후 바로 일어서기·지갑/반응 겹침 브랜치 `feat/fold-leave`(main에 병합: PR #26, `543e7f6`. 운영에는 아직 배포되지 않음)**:
  - PR #26과 PR #27 `fix/ci-e2e-job`(`388f5d1`, E2E를 별도 CI 작업으로 나눔)의 main CI는 E2E 테스트 타이밍으로 실패해 배포 잡이 돌지 않았다. 운영은 `bd98776`이다. `fix/e2e-settle`이 테스트를 고친다(`docs/STATUS.md` 53번). 그 PR을 병합하면 PR #26·#27과 함께 운영에 배포된다.
  - main(`7f47deb`)에서 갈라졌고 `bd98776`을 병합한다. 마이그레이션은 없다. game-worker·api(web 포함)·admin을 모두 바꾸므로 배포 순서는 기존과 같다(`docs/DEPLOYMENT.md` 3절). 이전 버전의 화면은 `held` 좌석을 모르고 빈 자리로 보인다(앉기는 서버가 `seat_taken`으로 막는다).
  - 폴드한 회원은 핸드 중이라도 바로 일어나 남은 스택을 지갑으로 받는다. 차례가 아니면 차례가 올 때 룸이 폴드하고 그 직후 일어나며, 올인은 정산 뒤 일어난다. 반응 버튼은 내 좌석 판에서 테이블 아래 상태 줄로 옮겼다. 보드를 펠트 가운데에 맞췄고, 브라우저 글자 125%에서 좌석이 커지던 것을 고쳤다.
  - 검증과 한계는 `docs/TEST_REPORT.md` '폴드 후 바로 일어서기·지갑/반응 겹침'과 `docs/STATUS.md` 52번에 있다. 휴대폰은 Chrome 에뮬레이션에서만 쟀고 실기기·운영에서는 확인하지 않았다.

## 꼭 알아야 할 결정 사항

- **기준 문서**: `docs/DIRECTIVE.md`가 유일한 기준이다. 예전 `PLAN.md`는 폐기했다.
- **로고**: `assets/branding/logo.png`만 쓴다.
- **관리자 인증**: 비밀번호만 쓴다. WebAuthn/FIDO는 오너가 제외했다(FIDO 장치 없음). 다시 넣지 말 것(DIRECTIVE §12).
- **엔진**: `poker-engine-ts@0.1.3`과 `patches/` 패치 1건, 어댑터 보정이 들어 있다(`docs/ENGINE_NOTES.md`). 테이블은 최대 9석이다.
- **Ai-Poker**: 코드를 쓰지 않았다(라이선스 불명확).

## 남은 일 (오너가 새 세션에서 진행 예정)

1. **메일 켜기(가입 이메일 인증 + 재설정 메일)**: 코드, 한/영 템플릿, `RESEND_API_KEY`가 준비되어 있고, Resend에서 `jc-royal.site`를 인증했다.
   - `MAIL_FROM`(`JC ROYAL <noreply@jc-royal.site>`)과 `APP_ORIGIN`(https://jc-royal.site)을 운영 설정에 넣었다. 남은 일은 배포다(`docs/DEPLOYMENT.md` 2절). 배포하는 순간 가입에 이메일 인증이 필수가 된다.
   - 배포 뒤 가입 인증번호 메일과 재설정 메일이 실제로 오는지, 재설정 링크가 https://jc-royal.site/reset 으로 열리는지 확인한다.
   - 그 전까지 운영 가입은 이메일 인증 없이 진행되고, 비밀번호 재설정은 관리자가 링크를 발급한다.
   - 관련 코드: `apps/api/src/lib/mail.ts`, `apps/api/src/routes/auth.ts`의 `/email-verification/*`, `/password-reset/request`
2. **봇**(빈 테이블용): `feat/platform-upgrade`에 서버 봇으로 구현했다. 공식 테이블에 앉고, 원장이 있는 봇 계정과 봇 기금으로 바이인·정산하며, 관리자가 정책·긴급 중지·기금을 관리한다. 남은 일은 운영 값과 운영 확인이다(`docs/STATUS.md` 27번, 관련 코드 `apps/game-worker/src/bots.ts`).
3. **커스텀 도메인**: `jc-royal.site`, `admin.jc-royal.site`를 붙였고 운영 설정도 옮겼다(2026-10-15). 대시보드에서 관리하며, wrangler 설정으로 옮길 때의 주의점은 `docs/DEPLOYMENT.md` 4절에 있다.

## 새 기기에서 시작하기

```bash
git clone https://github.com/fdrn9999/jc-royal.git && cd jc-royal
npm i -g pnpm@10 && pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/game-worker/.dev.vars.example apps/game-worker/.dev.vars
pnpm db:migrate:local && pnpm db:seed:local
pnpm dev:workers   # 8787   |   pnpm dev:web  # 5173   |   pnpm dev:admin  # 5174
pnpm typecheck && pnpm test && pnpm test:integration   # 동작 확인
```

E2E는 `pnpm exec playwright install chromium` 후 `pnpm test:e2e`. Chromium 다운로드가 안 되면 `PW_CHANNEL=chrome pnpm test:e2e`. 자세한 내용은 `docs/DEVELOPMENT.md`.
