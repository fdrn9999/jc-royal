# 관리자 보안 구성

> 2026-10-14 프로젝트 오너 결정에 따라 지시서 §12의 WebAuthn/FIDO2 보안 키 인증은 **구현하지 않는다**(FIDO 장치 없음). 아래 통제로 대체한다.

## 인증과 세션

| 통제 | 구현 |
|---|---|
| 분리된 콘솔 | `admin.<domain>`에서 별도 Worker가 서빙한다. 플레이어 사이트에는 관리자 화면이 없다 |
| 별도 세션 | 쿠키 `jc_asid`(HttpOnly, Secure, **SameSite=Strict**). 플레이어 쿠키(`jc_sid`)로는 관리자 API에 접근할 수 없다 |
| 세션 수명 | 유휴 30분, 최대 8시간. 토큰은 D1에 SHA-256 해시로만 저장한다 |
| 권한 판정 | 매 요청마다 D1의 `users.role`을 다시 읽는다(클라이언트 값은 쓰지 않음). 강등되면 관리자 세션을 즉시 폐기한다 |
| 출처 검사 | `/api/admin/*` 요청의 Origin은 `ADMIN_ORIGIN`과 같아야 한다 |
| 시도 제한 | 로그인은 계정당 15분에 5회, IP당 15분에 20회. 재확인은 15분에 10회. 실패는 감사 로그에 남긴다 |
| 비밀번호 저장 | PBKDF2-SHA256 100,000회, 솔트 16바이트, 상수 시간 비교 |

## 민감 작업 재확인

다음 작업은 최근 5분 안에 비밀번호를 다시 입력해야 한다(`POST /api/admin/auth/reauth`). 콘솔이 자동으로 비밀번호 창을 띄운다.

- 회원 정지·해제, 권한 변경(슈퍼관리자만)
- 가상 칩 지급·차감(멱등 키, 음수 잔액 불가)
- 비밀번호 재설정 링크 발급
- 테이블 종료(진행 중 핸드가 끝난 뒤 전원 환급)
- 종료된 핸드의 전체 카드 열람(`hand.view_sensitive` 감사 기록)
- 정합성 이벤트 해결 처리

## 비공개 정보 원칙

- 진행 중인 핸드의 홀카드, 덱, 시드는 관리자 실시간 상태에도 포함하지 않는다. 테스트로 검증했다.
- 모든 카드 정보는 핸드가 끝나 D1에 기록된 뒤에만, 위 재확인을 거쳐 열람할 수 있다.

## 감사 로그

`admin_audit_log`에 행위자, 조치, 대상, 상세(JSON), IP, 시각을 남긴다. 기록하는 조치는 다음과 같다.

```
admin.bootstrap, admin.login, admin.login.failed, admin.reauth, admin.reauth.failed,
user.suspend, user.unsuspend, user.role, user.chips, user.reset_link,
table.create, table.update, table.close, hand.view_sensitive,
reconcile.run, reconcile.resolve, board.notice.create/update,
board.post.status, board.comment.status, message.send
```

## 최초 관리자 생성(부트스트랩)

1. 배포 시크릿을 설정한다: `wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env production -c apps/api/wrangler.jsonc` (16자 이상 무작위 값).
2. 플레이어 사이트에서 관리자로 쓸 계정을 가입한다.
3. `POST https://admin.<domain>/api/admin/auth/bootstrap {token, email}`을 호출한다. 슈퍼관리자가 하나도 없을 때만 성공한다.
4. 끝나면 시크릿을 삭제한다: `wrangler secret delete ADMIN_BOOTSTRAP_TOKEN ...`
5. 이후 관리자는 슈퍼관리자가 콘솔에서 권한을 부여한다.

## 비밀번호 분실

- **관리자**: 다른 슈퍼관리자가 "재설정 링크 발급"을 한다.
- **유일한 슈퍼관리자**: D1 콘솔에서 직접 조치해야 한다. 메일 서비스는 연동되어 있지 않다.

## 운영 권장 사항

- `admin.<domain>`에 **Cloudflare Access**(Zero Trust, 50명까지 무료)를 붙여 IP나 계정으로 2차 접근 통제를 추가하는 것을 권장한다. 코드 변경이 필요 없다.
- 관리자 비밀번호는 다른 서비스와 같이 쓰지 않는다. 감사 로그를 주기적으로 검토한다.
