# 인수인계 (다음 세션용)

> 새 기기 또는 새 Claude 세션은 이 파일부터 읽는다. 마지막 갱신: 2026-10-14 (commit 7791e59 이후)

## 현재 상태

- `docs/DIRECTIVE.md` Phase 1~9를 구현했고 `main`에 push했다.
- 검증 결과:
  - 엔진 테스트 27, 통합 테스트 42, E2E 5 모두 통과(`docs/TEST_REPORT.md`)
  - 운영 번들 dry-run 성공
- 실제 Cloudflare 배포는 **하지 않았다**.

## 꼭 알아야 할 결정 사항

- **기준 문서**: `docs/DIRECTIVE.md`가 유일한 기준이다. 예전 `PLAN.md`는 폐기했다.
- **로고**: `assets/branding/logo.png`만 쓴다.
- **관리자 인증**: 비밀번호만 쓴다. WebAuthn/FIDO는 오너가 제외했다(FIDO 장치 없음). 다시 넣지 말 것(DIRECTIVE §12).
- **엔진**: `poker-engine-ts@0.1.3`과 `patches/` 패치 1건, 어댑터 보정이 들어 있다(`docs/ENGINE_NOTES.md`). 테이블은 최대 9석이다.
- **Ai-Poker**: 코드를 쓰지 않았다(라이선스 불명확).

## 남은 일 (오너가 새 세션에서 진행 예정)

1. **Resend 메일 연동**(비밀번호 재설정)
   - 필요한 것: 오너의 Resend API 키, Resend에서 인증한 발신 도메인
   - 계획: `RESEND_API_KEY` 시크릿이 있으면 메일을 발송하고, 없으면 지금처럼 관리자가 재설정 링크를 발급한다.
   - 관련 코드: `apps/api/src/routes/auth.ts`의 `/password-reset/request`
2. **봇**(빈 테이블용). 제안 설계:
   - 서버 쪽 규칙형 봇. 엔진의 합법 액션과 자기 카드만 쓴다.
   - 좌석에 "BOT" 배지를 붙인다.
   - 원장이 있는 시스템 계정으로 바이인·정산한다.
   - 관리자가 테이블별로 켜고 끈다.
   - 사람이 1명만 앉아 있을 때만 채우고, 사람이 오면 핸드가 끝난 뒤 자리를 비킨다.
   - 관련 코드: `apps/game-worker/src/room.ts`
3. **Cloudflare 실제 배포**: `docs/DEPLOYMENT.md` 순서대로 진행한다.
   - D1을 만들고 `database_id`를 입력한다.
   - 두 Worker에 같은 `INTERNAL_SECRET`을 넣는다.
   - `ADMIN_BOOTSTRAP_TOKEN`으로 최초 관리자를 만들고, 끝나면 이 시크릿을 삭제한다.
   - 배포 순서는 game → api → admin이다. 외부에 공개되는 작업이므로 오너 확인 후 진행한다.

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
