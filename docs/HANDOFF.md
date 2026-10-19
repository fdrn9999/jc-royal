# 인수인계 (다음 세션용)

> 새 기기 또는 새 Claude 세션은 이 파일부터 읽는다. 마지막 갱신: 2026-10-19 (최종 품질 고도화·릴리스 안정화 브랜치 `feat/release-polish`). 그 전: 2026-10-18 (종합 완성도 고도화 브랜치 `feat/polish`), 2026-10-17 (플랫폼 고도화 브랜치), 2026-10-15 (운영 도메인 jc-royal.site, 메일 발신 주소)

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
- **최종 품질 고도화·릴리스 안정화 브랜치 `feat/release-polish`(배포 안 함, PR로 검토)**:
  - main(`7eeff6d`)에서 갈라졌다. 새 기능, 서버·엔진·원장·스키마·API·관리자 코드 변경, 마이그레이션은 없다.
  - 배포 확인 단계(`deploy.yml`)가 workers.dev 주소를 먼저 보고, 커스텀 도메인의 챌린지 403만 경고로 둔다. 테이블 페이지를 필요할 때 받아 첫 화면 JS가 580KB다(한도 650KB 그대로). 가로 휴대폰은 조작을 오른쪽 열로 옮겼다. 844×390에서는 9인도 계산상 겹침이 0이지만, 더 짧은 가로 화면(812×375 BB, 800×360 BB, 667×375)에서는 겹침이 조금 남는다. 레이즈 패널 대상은 40px 이상이다.
  - 검증과 한계는 `docs/TEST_REPORT.md` '최종 품질 고도화·릴리스 안정화'와 `docs/STATUS.md` 44번에 있다. 로컬 E2E는 일부만 돌렸고(나머지는 PR CI), 실기기와 운영 환경에서는 확인하지 않았다.

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
