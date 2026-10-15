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

- 회원 정지·해제, 권한 변경(슈퍼관리자만). 해제와 권한 변경도 사유(2–200자)가 필요하다. 콘솔은 실행 전에 변경 전 → 후(상태·권한)와 현재 정지 사유를 보여 주고, 감사 기록에 사유와 변경 전후를 남긴다(`user.suspend` `{reason, from, to, previousReason}`, `user.unsuspend` `{reason, from, to, suspendedReason}`, `user.role` `{from, to, reason}`)
- 회원 강제 연결 종료(로그인 세션 삭제와 테이블 연결 종료, `user.disconnect` 감사 기록에 사유·결과)
- 가상 칩 지급·차감(멱등 키, 음수 잔액 불가)
- 비밀번호 재설정 링크 발급(자기 계정은 불가, 비밀번호 변경 사용)
- 회원 정보 CSV 내보내기(`user.export` 감사 기록)

대상이 관리자(ADMIN·SUPER_ADMIN)일 때 정지·해제, 강제 연결 종료, 칩 조정, 재설정 링크 발급은 슈퍼관리자만 할 수 있다. 재설정 링크는 계정을 넘겨받을 수 있는 토큰이기 때문이다.
- 테이블 종료(진행 중 핸드가 끝난 뒤 전원 환급)
- 테이블 긴급 제어: 새 핸드 중단·재개, 신규 입장 차단·해제(사유 필수, `table.control` 감사 기록에 사유와 룸 반영 여부)
- 종료된 핸드의 전체 카드 열람(`hand.view_sensitive` 감사 기록)
- 정합성 이벤트 해결 처리

## 비공개 정보 원칙

- 진행 중인 핸드의 홀카드, 덱, 시드는 관리자 실시간 상태에도 포함하지 않는다. 테스트로 검증했다.
- 모든 카드 정보는 핸드가 끝나 D1에 기록된 뒤에만, 위 재확인을 거쳐 열람할 수 있다.
- 테이블 상태 진단(`GET /api/admin/tables/:id`의 `diagnosis`)는 카드 없이 좌석·스택·단계·차례·마감·대기 중 충전 같은 운영 정보와 D1 기록 비교만 담는다. 긴급 조치는 카드나 결과를 바꾸지 않고, 퇴장도 엔진의 폴드와 정상 정산을 쓴다.

## 관리자 내부 메모

- 목적: 운영자끼리 조치 근거와 주의할 점을 넘겨주는 인수인계용이다. 회원에게는 보이지 않고, 모든 관리자(ADMIN·SUPER_ADMIN)가 회원 상세에서 읽는다. 새 역할은 만들지 않았다.
- 개인정보를 받지 않는다: 이메일, 전화번호(국내·국제), 주민등록번호, 카드 번호처럼 보이는 본문은 400 `note_pii`로 거절한다. 패턴 검사라 모든 개인정보를 잡지는 못하므로 콘솔 안내문에도 적지 말라고 쓴다. 길이는 2–500자.
- 삭제: 작성자나 슈퍼관리자만. 본문은 바로 지우고, 감사 기록(`note.delete`)에는 누가 누구의 메모를 언제 지웠는지만 남는다. 작성 기록(`note.create`)에도 본문은 없다(메모 ID와 길이).
- 회원이 탈퇴하면 그 회원에 대한 메모를 함께 지운다(`docs/PRIVACY_OPERATIONS.md`).

## 회원 정보 내보내기

- 회원 목록에서 체크한 회원(한 번에 최대 1,000명)만 CSV로 내려받는다. 표시된 회원 전체 선택을 지원한다.
- 담기는 항목: ID, 이메일, 닉네임, 계정 언어, 권한, 상태, 잔액, 가입 시각, 생년월일, 이메일 인증 시각, 개인정보 동의 버전·시각, 정지 사유. 비밀번호 해시와 세션 정보는 담지 않는다.
- 근거: 가입 때 받는 개인정보 수집·이용 동의(`apps/web/src/legal/privacyNotice.ts`)의 "3. 관리자 조회와 파일 내보내기" 항목에 근거를 적었다. 문구를 바꾸면 `PRIVACY_NOTICE_VERSION`을 올린다.
- 스프레드시트 수식 실행을 막기 위해 `=`·`+`·`-`·`@`로 시작하는 칸 앞에 `'`를 붙인다. 파일은 UTF-8(BOM)이라 Excel에서 한글이 깨지지 않는다.
- 내보낸 파일은 목적을 달성하면 바로 삭제한다. 모든 내보내기는 행위자, 대상 회원 ID, 건수와 함께 감사 로그에 남는다.

## 감사 로그

`admin_audit_log`에 행위자, 조치, 대상, 상세(JSON), IP, 시각을 남긴다. 기록하는 조치는 다음과 같다.

```
admin.bootstrap, admin.login, admin.login.failed, admin.reauth, admin.reauth.failed,
user.list, user.view, user.suspend, user.unsuspend, user.disconnect, user.role, user.chips, user.reset_link, user.export,
note.create, note.delete,
table.create, table.update, table.control, table.close, hand.view_sensitive,
reconcile.run, reconcile.resolve, board.notice.create/update,
board.post.status, board.comment.status, message.send,
report.view, report.resolved, report.dismissed
```

조회도 남긴다. `user.list`(회원 목록·검색: 검색어, 필터, 정렬, 건수), `user.view`(회원 상세: 생년월일·동의 기록 포함), `report.view`(신고 목록: 1:1 메시지 신고 ID 포함)는 화면을 열 때마다 1행씩 쌓인다. 1:1 대화를 읽는 관리자 API는 없고, 관리자가 보는 1:1 메시지는 신고 증거뿐이다. 보관 기간은 정하지 않았다(`docs/PRIVACY_OPERATIONS.md` 5·9절). 회원 상세의 "관리 이력·메모"는 이 감사 로그(그 회원 대상의 제재·권한·칩·재설정 링크·메모 삭제와 그 회원에 대한 신고 결정)와 메모를 시간순으로 보여 준다. 최근 참여 테이블과 신고 건수는 상세 조회(`user.view`)에 함께 담기고, 기간별 활동(`/activity`)과 이력(`/timeline`) 조회는 따로 기록하지 않는다(콘솔은 상세를 연 뒤에만 부른다).

## 최초 관리자 생성(부트스트랩)

1. 배포 시크릿을 설정한다: `wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env production -c apps/api/wrangler.jsonc` (16자 이상 무작위 값).
2. 플레이어 사이트에서 관리자로 쓸 계정을 가입한다.
3. `POST https://admin.<domain>/api/admin/auth/bootstrap {token, email}`을 호출한다. 슈퍼관리자가 하나도 없을 때만 성공한다.
4. 끝나면 시크릿을 삭제한다: `wrangler secret delete ADMIN_BOOTSTRAP_TOKEN ...`
5. 이후 관리자는 슈퍼관리자가 콘솔에서 권한을 부여한다.

## 비밀번호 분실

- **관리자**: 다른 슈퍼관리자가 "재설정 링크 발급"을 한다.
- **유일한 슈퍼관리자**: 재설정 메일이 켜져 있으면 사용자 사이트의 비밀번호 찾기를 쓴다(`docs/DEPLOYMENT.md` 2절). 꺼져 있으면 D1 콘솔에서 직접 조치해야 한다.

## 운영 권장 사항

- `admin.<domain>`에 **Cloudflare Access**(Zero Trust, 50명까지 무료)를 붙여 IP나 계정으로 2차 접근 통제를 추가하는 것을 권장한다. 코드 변경이 필요 없다.
- 관리자 비밀번호는 다른 서비스와 같이 쓰지 않는다. 감사 로그를 주기적으로 검토한다.
