# 인수인계 (다음 세션용)

> 새 기기 또는 새 Claude 세션은 이 파일부터 읽는다. 마지막 갱신: 2026-10-14 (첫 운영 배포)

## 현재 상태

- `docs/DIRECTIVE.md` Phase 1~9와 포커 아카데미를 구현했다.
- 검증 결과는 `docs/TEST_REPORT.md`와 `docs/STATUS.md`에 있다.
- **운영 배포 완료**(2026-10-14, 로컬 wrangler, Workers Paid):
  - 사용자 사이트: https://play.jcroyal.workers.dev
  - 관리자 콘솔: https://admin.jcroyal.workers.dev
  - Worker: `jc-royal-game-prod` → `play` → `admin`
  - D1: `jc-royal-db-prod`(APAC), 마이그레이션 `0000`~`0003` 적용
  - 시크릿: 두 Worker에 `INTERNAL_SECRET`, `play`에 `RESEND_API_KEY`
- 최초 슈퍼관리자: ckato9173@gmail.com. 부트스트랩 후 `ADMIN_BOOTSTRAP_TOKEN`은 삭제한다.
- **배포 자동화**: `main`에 push하고 CI가 통과하면 GitHub Actions가 운영에 배포한다(`docs/DEPLOYMENT.md` 3절). 저장소 시크릿 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`가 있어야 동작한다.
- **가입·회원 정보 개편**(브랜치 `chore/production-deploy-prep`): 이메일 인증번호, 생년월일(만 14세), 필수 동의, 비밀번호 규칙, 계정 언어, 관리자 CSV 내보내기. 운영에 반영하려면 마이그레이션 `0004_signup_profile`이 필요하다(Actions 배포는 자동 적용).

## 꼭 알아야 할 결정 사항

- **기준 문서**: `docs/DIRECTIVE.md`가 유일한 기준이다. 예전 `PLAN.md`는 폐기했다.
- **로고**: `assets/branding/logo.png`만 쓴다.
- **관리자 인증**: 비밀번호만 쓴다. WebAuthn/FIDO는 오너가 제외했다(FIDO 장치 없음). 다시 넣지 말 것(DIRECTIVE §12).
- **엔진**: `poker-engine-ts@0.1.3`과 `patches/` 패치 1건, 어댑터 보정이 들어 있다(`docs/ENGINE_NOTES.md`). 테이블은 최대 9석이다.
- **Ai-Poker**: 코드를 쓰지 않았다(라이선스 불명확).

## 남은 일 (오너가 새 세션에서 진행 예정)

1. **메일 켜기(가입 이메일 인증 + 재설정 메일)**: 코드, 한/영 템플릿, `RESEND_API_KEY`는 준비되어 있다.
   - 남은 일: Resend에서 발신 도메인을 인증하고, `MAIL_FROM`을 넣은 뒤 다시 배포한다(`docs/DEPLOYMENT.md` 2절). 넣는 순간 가입에 이메일 인증이 필수가 된다.
   - 그 전까지 운영 가입은 이메일 인증 없이 진행되고, 비밀번호 재설정은 관리자가 링크를 발급한다.
   - 관련 코드: `apps/api/src/lib/mail.ts`, `apps/api/src/routes/auth.ts`의 `/email-verification/*`, `/password-reset/request`
2. **봇**(빈 테이블용). 제안 설계:
   - 서버 쪽 규칙형 봇. 엔진의 합법 액션과 자기 카드만 쓴다.
   - 좌석에 "BOT" 배지를 붙인다.
   - 원장이 있는 시스템 계정으로 바이인·정산한다.
   - 관리자가 테이블별로 켜고 끈다.
   - 사람이 1명만 앉아 있을 때만 채우고, 사람이 오면 핸드가 끝난 뒤 자리를 비킨다.
   - 관련 코드: `apps/game-worker/src/room.ts`
3. **커스텀 도메인**(선택): 도메인을 사면 `docs/DEPLOYMENT.md` 4절대로 옮긴다. Resend 발신 도메인도 같은 도메인으로 인증할 수 있다.

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
