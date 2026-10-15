# 인수인계 (다음 세션용)

> 새 기기 또는 새 Claude 세션은 이 파일부터 읽는다. 마지막 갱신: 2026-10-15 (운영 도메인 jc-royal.site, 메일 발신 주소)

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
2. **봇**(빈 테이블용). 제안 설계:
   - 서버 쪽 규칙형 봇. 엔진의 합법 액션과 자기 카드만 쓴다.
   - 좌석에 "BOT" 배지를 붙인다.
   - 원장이 있는 시스템 계정으로 바이인·정산한다.
   - 관리자가 테이블별로 켜고 끈다.
   - 사람이 1명만 앉아 있을 때만 채우고, 사람이 오면 핸드가 끝난 뒤 자리를 비킨다.
   - 관련 코드: `apps/game-worker/src/room.ts`
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
