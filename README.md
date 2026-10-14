<p align="center"><img src="assets/branding/logo.png" width="140" alt="JC ROYAL"></p>

# JC ROYAL

프리미엄 온라인 텍사스 홀덤 라운지. 실시간 멀티플레이 NLHE(2~9인), 회원·가상 칩 원장, 게시판·쪽지, 관리자 콘솔을 Cloudflare Workers, Durable Objects, D1 위에서 운영한다.

> **모든 칩은 현금 가치가 없는 플레이 전용 가상 칩이다.** 입금·출금·환전·양도 기능은 없다.

## 특징

- **단일 규칙 기준**: 게임 판정은 [poker-engine-ts](https://github.com/Ge-limin/poker-engine-ts)만 한다. 서버 권한형이며, 플레이어마다 볼 수 있는 정보만 투영한다.
- **테이블 = Durable Object**: 상태 변경을 직렬화하고, 이벤트 로그로 복구하며, WebSocket Hibernation을 쓴다.
- **칩 무결성**: 멱등 원장, 매 액션 칩 보존 검사, 정합성 검사를 한다.
- **포커 아카데미**: 카드 기초부터 족보, 홀덤 규칙, 베팅 액션, 실제 테이블 화면의 연습 게임(브라우저 내 엔진, 칩·기록 미사용)까지. 게임 중 족보표와 초보자 모드를 제공한다.
- **UI**: [Elite-Poker](https://github.com/opadips/Elite-Poker) UI를 JC ROYAL 브랜드로 재작성했다. 테마 4종, 애니메이션, Web Audio, 한국어/영어, 모바일을 지원한다.

## 빠른 시작

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/game-worker/.dev.vars.example apps/game-worker/.dev.vars
pnpm db:migrate:local && pnpm db:seed:local
pnpm dev:workers     # http://localhost:8787
pnpm dev:web         # http://localhost:5173
pnpm dev:admin       # http://localhost:5174
```

## 구조

```
apps/web            사용자 사이트 (React + Vite + Tailwind)
  src/academy       포커 아카데미 (레슨, 퀴즈, 연습 시나리오 · 지연 로딩)
apps/admin          관리자 콘솔 + 호스트 Worker
apps/api            Hono REST · 인증 · WS 진입 (Worker)
apps/game-worker    TableRoom Durable Object (Worker)
packages/poker-engine  poker-engine-ts 어댑터 (+ patches/)
packages/types      공용 타입 · zod 프로토콜
packages/db         Drizzle D1 스키마 · 마이그레이션 · 원장
packages/ui         디자인 시스템 · 카드/칩
packages/audio      Web Audio 효과음
tests/              통합(workerd) · E2E(Playwright) · 시각 캡처
docs/               문서
```

## 문서

| 문서 | 내용 |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | **인수인계 · 남은 일 (새 세션은 여기부터)** |
| [docs/DIRECTIVE.md](docs/DIRECTIVE.md) | 개발 지시서(기준) |
| [docs/INTEGRATION_ANALYSIS.md](docs/INTEGRATION_ANALYSIS.md) | 원본 저장소 3개 분석 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 아키텍처 · 상태 · 칩 경제 · DB 모델 |
| [docs/API.md](docs/API.md) | REST API 명세 |
| [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) | WebSocket 이벤트 명세 |
| [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md) | 엔진 통합 · 발견 결함과 보정 |
| [docs/ADMIN_SECURITY.md](docs/ADMIN_SECURITY.md) | 관리자 보안 구성 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 로컬 개발 · 테스트 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Cloudflare 배포 · 비용 |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | 테스트 결과(실행 로그 포함) |
| [docs/STATUS.md](docs/STATUS.md) | 구현 · 미구현 · 알려진 문제 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 오픈소스 라이선스 고지 |
