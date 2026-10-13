<p align="center">
  <img src="assets/branding/logo.png" alt="JC ROYAL" width="180" />
</p>

<h1 align="center">JC ROYAL</h1>

<p align="center">프리미엄 온라인 소셜 카지노 · 제이씨 로얄</p>

---

JC ROYAL은 현금 가치가 없는 무료 가상 칩으로 즐기는 웹 기반 소셜 카지노다. 오락 및 개발 포트폴리오 목적의 프로젝트이며, 실제 현금 입출금·환전·현금성 경품·칩의 외부 거래 기능은 없다.

## 현재 상태

**계획 단계.** 저장소에는 계획서와 브랜드 로고만 있으며 애플리케이션 코드는 아직 없다.

- [개발 계획서](docs/PLAN.md) — 범위, 기술 스택 결정, 아키텍처, 로드맵, 위험 요소

## 계획된 구성

| 영역 | 내용 |
| --- | --- |
| 게임 | 텍사스 홀덤 포커룸(실시간 멀티플레이), 블랙잭, 바카라, 룰렛, 카지노 홀덤, 쓰리카드 포커, 슬롯머신 |
| 프론트엔드 | React, TypeScript, React Router v7, Tailwind CSS, GSAP, Howler.js |
| 백엔드 | Cloudflare Workers, Hono, Durable Objects(WebSocket), D1, Drizzle ORM |
| 보안 | 서버 결정 게임 결과, Provably Fair 검증, 최고관리자 FIDO2 보안 키 인증 |
| 언어 | 한국어(기본), 영어 |

## 브랜치

- `main` — 운영
- `develop` — 통합
- `feature/*` — 기능 개발
