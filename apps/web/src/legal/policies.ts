/**
 * Full privacy policy (/privacy) and terms of service (/terms). These are drafts: anything that needs a legal
 * decision is not settled here but listed in the section's `review` note (shown as "검토 필요" on the page and
 * collected in docs/PRIVACY_OPERATIONS.md). Every factual line describes what the code does today — keep them in
 * step with apps/api (routes/auth.ts /me/delete, lib/housekeeping.ts, routes/reports.ts, routes/admin.ts) and
 * with the signup notice in privacyNotice.ts.
 */
export interface PolicySection {
  heading: string;
  items: string[];
  /** Open question for legal review. Shown highlighted; never presented as a decided rule. */
  review?: string;
}

export interface PolicyDoc {
  title: string;
  intro: string;
  sections: PolicySection[];
  /** Draft date and the fact that the effective date is still open. */
  effective: string;
}

/** Date this draft was written. The effective date is set only after legal review. */
export const POLICY_DRAFT_DATE = '2026-10-15';
const [y, m, d] = POLICY_DRAFT_DATE.split('-').map(Number);

export const LEGAL_DRAFT: Record<'ko' | 'en', string> = {
  ko: '법무 검토 전 초안입니다. "검토 필요"로 표시한 부분은 아직 확정되지 않았고, 시행일은 검토를 마친 뒤 정합니다.',
  en: 'This is a draft pending legal review. Parts marked "Needs legal review" are not final, and the effective date will be set after the review.',
};

export const PRIVACY_POLICY: Record<'ko' | 'en', PolicyDoc> = {
  ko: {
    title: '개인정보 처리방침',
    intro:
      'JC ROYAL(이하 "서비스")은 「개인정보 보호법」 등 관련 법령에 따라 회원의 개인정보를 처리합니다. 이 방침은 서비스가 어떤 정보를 왜 처리하고, 얼마나 보관하며, 어떻게 삭제하는지 설명합니다. 서비스의 칩은 현금 가치가 없는 가상 칩이며, 서비스는 실명·전화번호·결제 정보를 받지 않습니다.',
    sections: [
      {
        heading: '1. 처리하는 개인정보',
        items: [
          '회원가입: 이메일 주소, 비밀번호, 닉네임, 생년월일, 이용 언어, 개인정보 동의 버전과 일시',
          '이메일 인증과 비밀번호 재설정: 인증번호와 재설정 링크(원문은 저장하지 않고 일방향 암호화(해시) 값만 저장), 요청·만료 일시',
          '로그인: 로그인 세션(토큰의 해시 값, 접속 IP 주소, 브라우저·기기 정보(User-Agent), 생성·만료 일시)',
          '게임: 테이블 참여·좌석 기록, 핸드 기록(받은 카드, 베팅, 결과), 가상 칩 원장, 테이블 채팅',
          '커뮤니티: 게시글·댓글, 운영자가 보낸 쪽지와 읽음 여부, 친구와 친구 요청, 1:1 대화 내용과 보낸 시각, 차단 목록, 친구 요청·알림 설정',
          '신고: 신고한 회원, 신고 대상, 사유와 상세 내용, 신고 시점에 서버가 복사해 둔 증거(5항)',
          '아카데미: 학습 진도와 배지',
          '남용 방지: 요청 횟수를 세기 위한 기록(IP 주소, 이메일 주소 또는 회원 번호를 키로 사용)',
          '선택: 프로필 이미지 주소(URL)',
        ],
      },
      {
        heading: '2. 처리 목적',
        items: [
          '회원 식별, 가입 의사와 이메일 주소 소유 확인, 만 14세 이상 연령 확인',
          '게임 진행, 가상 칩 지급·정산과 기록 보존, 게임 무결성 확인과 분쟁 대응',
          '게시판·쪽지·친구·1:1 대화 등 커뮤니티 기능 제공',
          '부정 로그인·부정 이용·괴롭힘 방지, 신고 처리와 이용 제한',
          '비밀번호 재설정 등 서비스 메일 발송(이용 언어 기준)',
          '서비스 안정성 확보와 개선을 위한 이용 통계',
        ],
      },
      {
        heading: '3. 보유 기간과 파기',
        items: [
          '회원 정보: 탈퇴할 때까지 보관합니다. 탈퇴하면 이메일 주소·닉네임·생년월일·프로필 이미지·비밀번호를 즉시 지우거나 복구할 수 없는 값으로 바꿉니다.',
          '로그인 세션: 로그아웃하면 즉시 삭제합니다. 자동 로그인을 선택하면 마지막 이용 후 30일, 선택하지 않으면 1일이 지나 만료되며, 만료된 세션(IP 주소·브라우저 정보 포함)은 만료 1일 뒤 하루 한 번 실행하는 정리 작업에서 삭제합니다.',
          '인증번호, 비밀번호 재설정 링크, 요청 횟수 기록: 만료(또는 집계 기간이 끝난) 1일 뒤 같은 정리 작업에서 삭제합니다.',
          '1:1 대화: 따로 정한 보관 기한 없이 보관하며, 대화한 두 사람 중 한 명이라도 탈퇴하면 두 사람이 주고받은 메시지를 모두 삭제합니다.',
          '친구·친구 요청·차단: 해제하면 즉시 삭제하고, 탈퇴하면 회원이 맺거나 받은 관계를 모두 삭제합니다.',
          '운영자 쪽지와 아카데미 진도·배지: 탈퇴하면 삭제합니다.',
          '테이블 채팅: 게임 서버가 테이블마다 최근 50줄만 보관하고, 테이블이 닫힌 뒤 24시간(플레이어 신고 가능 기간)이 지나면 삭제합니다.',
          '게시글·댓글: 직접 삭제하면 바로 화면에서 숨기지만, 신고와 분쟁 대응을 위해 데이터베이스에는 남습니다.',
          '가상 칩 원장, 핸드·좌석 기록: 칩 총량 검증과 분쟁 대응을 위해 탈퇴 후에도 회원 번호(무작위 값)로 보관합니다.',
          '신고 기록과 증거, 운영자 감사 기록은 5항과 6항을 따릅니다. 관계 법령이 보존을 요구하는 정보는 그 법령이 정한 기간 동안 보관합니다.',
        ],
        review:
          '보관 기한을 정하지 않은 항목(1:1 대화, 직접 삭제한 게시글·댓글, 칩 원장·핸드 기록)의 기한과, 탈퇴 후 가명으로 남기는 기록의 보관 근거는 법무 검토 후 확정합니다.',
      },
      {
        heading: '4. 회원 탈퇴 시 처리',
        items: [
          '바로 삭제: 로그인 세션, 친구·친구 요청·차단, 보내거나 받은 1:1 대화 전부(상대방 화면에서도 사라집니다), 운영자 쪽지함, 아카데미 진도와 배지, 쓰지 않은 비밀번호 재설정 링크',
          '복구할 수 없게 바꾸는 정보: 이메일 주소, 닉네임, 생년월일, 프로필 이미지, 비밀번호',
          '남는 정보: 게시글·댓글(작성자를 "탈퇴한 회원"으로 표시), 가상 칩 원장, 핸드·좌석 기록, 회원이 했거나 받은 신고와 그 증거. 이 기록은 회원 번호(무작위 값)로만 남습니다. 다른 회원의 핸드 기록에는 탈퇴한 회원이 "deleted-…" 형태의 이름으로 보입니다.',
          '남은 가상 칩은 소멸하며 복구할 수 없습니다.',
        ],
        review: '탈퇴 후 게시글·댓글을 남길지(또는 일정 기간 뒤 삭제할지)와 남기는 기록의 범위는 법무 검토가 필요합니다.',
      },
      {
        heading: '5. 신고와 증거 보존',
        items: [
          '신고하면 서버가 신고 시점의 원본을 복사해 신고 기록에 저장합니다. 신고한 사람이 입력한 내용을 증거로 대신 쓰지 않습니다.',
          '복사하는 증거: 게시글(제목과 본문 앞 2,000자)·댓글 본문, 1:1 메시지는 신고한 메시지와 같은 사람이 그 직전에 보낸 메시지 최대 5개, 플레이어 신고는 테이블 이름, 함께한 핸드 번호, 게임 서버에 남아 있는 테이블 채팅 중 신고 대상이 쓴 최근 10줄(신고한 사람이 그 테이블에 있던 시간으로 한정)',
          '1:1 메시지는 대화한 두 사람만 신고할 수 있고, 플레이어는 마지막으로 같은 테이블에 앉았던 때부터 24시간 안에만 신고할 수 있습니다.',
          '신고 기록과 증거는 처리(조치 또는 기각)한 뒤에도 재발 확인과 이의 대응을 위해 보관하며, 원본 게시물이나 메시지가 삭제되어도 사본은 남습니다.',
        ],
        review: '신고 기록과 증거의 보관 기한(예: 처리 후 일정 기간이 지나면 삭제)은 아직 정하지 않았으며 법무 검토 후 확정합니다.',
      },
      {
        heading: '6. 운영자 접근 권한과 감사 기록',
        items: [
          '관리자 화면은 운영자 계정만 쓸 수 있습니다. 30분 동안 쓰지 않거나 로그인한 지 8시간이 지나면 다시 로그인해야 하고, 회원 정보 내보내기·칩 조정·이용 제한 같은 민감한 작업은 5분 안에 비밀번호를 다시 확인해야 합니다.',
          '운영자가 볼 수 있는 정보: 회원 목록과 상세(이메일 주소, 닉네임, 생년월일, 가입·인증 일시, 칩 내역, 이용 제한 상태 등), 게시글·댓글, 신고와 증거. 1:1 대화는 신고된 메시지와 5항의 증거만 볼 수 있고, 그 밖의 대화는 관리자 화면에서 볼 수 없습니다.',
          '감사 기록: 회원 목록 조회, 회원 상세 조회, 신고 조회, 파일 내보내기, 칩 조정, 이용 제한·해제, 게시물 숨김, 쪽지 발송, 신고 처리 등 운영자의 조회와 조치마다 운영자, 시각, 대상, 운영자의 IP 주소를 기록합니다.',
          '회원 정보 파일(CSV) 내보내기 항목: 회원 ID, 이메일 주소, 닉네임, 이용 언어, 회원 등급·상태, 가상 칩 잔액, 가입 일시, 생년월일, 이메일 인증 일시, 개인정보 동의 버전·일시, 이용 제한 사유. 내보낸 파일은 목적을 달성하면 지체 없이 파기합니다.',
          '서비스 인프라(Cloudflare) 계정 관리자는 기술적으로 데이터베이스에 직접 접근할 수 있고, 이 접근은 관리자 화면의 감사 기록에 남지 않습니다. 장애 대응과 법령상 의무 이행에 필요한 경우에만 접근합니다.',
        ],
        review:
          '감사 기록(접속 기록)의 보관 기간과 점검 주기, 인프라 직접 접근을 통제하는 방법은 「개인정보의 안전성 확보조치 기준」에 맞춰 법무 검토 후 확정합니다.',
      },
      {
        heading: '7. 처리 위탁과 국외 이전',
        items: [
          'Cloudflare, Inc.: 웹 서버, 데이터베이스, 게임 서버 운영(1항의 모든 정보). 정보는 국외에 있는 Cloudflare 데이터 센터에서 저장·처리될 수 있고, Cloudflare의 운영 로그에 요청 주소·시각 등이 Cloudflare가 정한 기간 동안 남을 수 있습니다.',
          'Resend: 인증번호·비밀번호 재설정 등 서비스 메일 발송(이메일 주소와 메일 내용). 서버가 국외에 있을 수 있습니다.',
          '서비스는 회원의 개인정보를 제3자에게 제공하지 않습니다. 제공이 필요해지면 사전에 별도 동의를 받습니다.',
        ],
        review:
          '국외 이전 고지 사항(이전되는 국가, 이전 일시와 방법, 업체 연락처, 보유 기간)과 법령에 따른 제공 예외 문구는 법무 검토 후 확정합니다.',
      },
      {
        heading: '8. 회원의 권리와 행사 방법',
        items: [
          '마이페이지에서 닉네임·프로필 이미지·이용 언어와 비밀번호를 바꾸고, 언제든 탈퇴할 수 있습니다.',
          '친구 설정에서 친구 요청을 받을 범위와 1:1 대화 알림을 정하고, 원하지 않는 회원을 차단할 수 있습니다. 1:1 대화는 친구끼리만 주고받을 수 있습니다.',
          '그 밖의 열람·정정·삭제·처리정지 요청은 12항의 문의 창구로 할 수 있습니다.',
        ],
        review: '열람 등 요청의 접수 창구, 처리 기한, 대리인을 통한 요청 절차는 법무 검토 후 확정합니다.',
      },
      {
        heading: '9. 최소 수집 원칙',
        items: [
          '실명, 전화번호, 주소, 결제 정보, 위치 정보는 수집하지 않습니다.',
          '생년월일은 만 14세 이상인지 확인하고 연령대별 이용 통계를 내는 데만 씁니다.',
          'IP 주소와 브라우저 정보는 로그인 세션 보안, 요청 횟수 제한, 운영자 조치 기록에만 씁니다.',
          '운영자가 1:1 대화를 볼 수 있는 범위는 신고된 메시지로 한정합니다.',
        ],
        review: '연령 확인에 생년월일 전체가 필요한지(출생 연도와 월만으로 충분한지)는 법무 검토가 필요합니다.',
      },
      {
        heading: '10. 안전성 확보 조치',
        items: [
          '비밀번호는 PBKDF2로, 인증번호·비밀번호 재설정 링크·로그인 세션 토큰은 SHA-256으로 일방향 암호화(해시)해 저장합니다.',
          '서비스와의 통신은 HTTPS로 암호화합니다.',
          '운영자 접근 제한과 감사 기록은 6항과 같습니다.',
        ],
      },
      {
        heading: '11. 쿠키와 브라우저 저장소',
        items: [
          '쿠키는 로그인을 유지하는 데에만 씁니다. 광고·분석용 쿠키나 외부 추적 도구는 쓰지 않습니다.',
          '브라우저 저장소에는 이용 언어, 화면·게임 표시 설정, 자동 로그인 선택 여부, 채팅 음소거 목록, 아카데미 진도를 저장합니다. 아카데미 진도는 로그인하면 계정과 동기화되고, 나머지는 기기에만 남습니다.',
        ],
      },
      {
        heading: '12. 개인정보 보호책임자와 문의',
        items: ['개인정보 보호책임자: 확정 전', '문의 창구: 확정 전'],
        review: '개인정보 보호책임자(성명·직책·연락처)와 문의 창구를 아직 정하지 않았습니다. 시행 전에 반드시 정해야 합니다.',
      },
      {
        heading: '13. 방침의 변경',
        items: ['이 방침을 바꾸면 시행 전에 서비스 화면에 알립니다. 회원가입 때 동의한 안내문의 버전과 일시는 회원 정보에 기록됩니다.'],
        review: '변경 사전 고지 기간과, 이전 버전 안내문에 동의한 기존 회원에게 다시 동의를 받을지는 법무 검토 후 정합니다.',
      },
    ],
    effective: `초안 작성일: ${y}년 ${m}월 ${d}일 · 시행일은 법무 검토 후 정합니다.`,
  },
  en: {
    title: 'Privacy Policy',
    intro:
      'JC ROYAL (the "Service") processes members\' personal information in accordance with the Personal Information Protection Act of Korea and related laws. This policy explains what we process and why, how long we keep it, and how we delete it. Chips in the Service are virtual chips with no cash value, and the Service does not collect real names, phone numbers or payment details.',
    sections: [
      {
        heading: '1. Information we process',
        items: [
          'Sign-up: email address, password, nickname, date of birth, preferred language, privacy consent version and time',
          'Email verification and password reset: codes and reset links (only a one-way hash is stored, never the original), request and expiry times',
          'Sign-in: sign-in sessions (a hash of the token, IP address, browser and device information (User-Agent), creation and expiry times)',
          'Games: table and seat records, hand records (cards dealt, bets, results), virtual chip ledger, table chat',
          'Community: posts and comments, operator messages and whether you read them, friends and friend requests, 1:1 message text and send time, block list, friend request and notification settings',
          'Reports: who reported, the target, reason and details, and evidence the server copied at the time of the report (section 5)',
          'Academy: learning progress and badges',
          'Abuse prevention: request counters keyed by IP address, email address or member ID',
          'Optional: profile image address (URL)',
        ],
      },
      {
        heading: '2. Why we process it',
        items: [
          'To identify members, confirm sign-up and email ownership, and confirm you are 14 or older',
          'To run the games, grant, settle and record virtual chips, check game integrity and resolve disputes',
          'To provide community features: board, messages, friends and 1:1 chat',
          'To prevent unauthorized sign-ins, abuse and harassment, and to handle reports and restrictions',
          'To send service mail such as password reset links, in your preferred language',
          'To keep usage statistics that keep the Service stable and improve it',
        ],
      },
      {
        heading: '3. Retention and deletion',
        items: [
          'Member information: kept until you delete your account. On deletion, your email address, nickname, date of birth, profile image and password are removed immediately or replaced with values that cannot be restored.',
          'Sign-in sessions: deleted immediately when you sign out. With "Stay signed in" a session expires 30 days after last use, otherwise after 1 day; expired sessions (including IP address and browser information) are deleted one day after expiry by a clean-up job that runs once a day.',
          'Verification codes, password reset links and request counters: deleted by the same job one day after they expire (or their counting window ends).',
          '1:1 messages: kept with no fixed retention period. When either person in a conversation deletes their account, every message between the two is deleted.',
          'Friends, friend requests and blocks: deleted immediately when removed, and all of them (made by or about you) are deleted when you delete your account.',
          'Operator messages and Academy progress and badges: deleted when you delete your account.',
          'Table chat: the game server keeps only the latest 50 lines per table and deletes them 24 hours after the table closes (the window for reporting a player).',
          'Posts and comments: when you delete one it is hidden at once, but it stays in the database for reports and disputes.',
          'Virtual chip ledger, hand and seat records: kept after account deletion under your member ID (a random value), to verify chip totals and resolve disputes.',
          'Reports, evidence and operator audit records follow sections 5 and 6. Information that a law requires us to keep is kept for the period that law sets.',
        ],
        review:
          'Retention periods for items with no fixed period (1:1 messages, deleted posts and comments, chip ledger and hand records) and the legal basis for keeping pseudonymous records after account deletion will be settled after legal review.',
      },
      {
        heading: '4. When you delete your account',
        items: [
          'Deleted at once: sign-in sessions, friends, friend requests and blocks, every 1:1 message you sent or received (it also disappears for the other person), your operator inbox, Academy progress and badges, and unused password reset links',
          'Replaced so it cannot be restored: email address, nickname, date of birth, profile image and password',
          'What remains: posts and comments (the author is shown as "Withdrawn member"), the virtual chip ledger, hand and seat records, and reports you made or received with their evidence. These remain only under your member ID (a random value). In other players\' hand history you appear under a name like "deleted-…".',
          'Remaining virtual chips are forfeited and cannot be restored.',
        ],
        review: 'Whether posts and comments should remain after account deletion (or be deleted after a period), and the scope of records kept, needs legal review.',
      },
      {
        heading: '5. Reports and evidence',
        items: [
          'When you report something, the server copies the original as it is at that moment into the report. What the reporter types is never used as the evidence itself.',
          'Evidence copied: the post (title and first 2,000 characters) or comment text; for a 1:1 message, the reported message and up to 5 earlier messages from the same sender; for a player, the table name, shared hand numbers and up to the last 10 lines the reported player wrote in the table chat still held by the game server (limited to the time the reporter was at the table)',
          'Only the two people in a conversation can report a 1:1 message, and a player can be reported only within 24 hours of the last time you sat at the same table.',
          'Reports and evidence are kept after they are handled (actioned or dismissed) to detect repeat behaviour and handle objections, and the copy remains even if the original post or message is deleted.',
        ],
        review: 'The retention period for reports and evidence (for example, deletion a set time after handling) has not been decided and will be settled after legal review.',
      },
      {
        heading: '6. Operator access and audit records',
        items: [
          'Only operator accounts can use the admin console. Operators must sign in again after 30 minutes of inactivity or 8 hours after sign-in, and must re-enter their password within 5 minutes before sensitive actions such as exporting member data, adjusting chips or restricting accounts.',
          'Operators can see: the member list and details (email address, nickname, date of birth, sign-up and verification dates, chip history, restriction status and so on), posts and comments, and reports with their evidence. For 1:1 messages they can see only reported messages and the evidence in section 5; other conversations are not visible in the admin console.',
          'Audit records: every operator view and action — member list views, member detail views, report views, file exports, chip adjustments, restrictions and their removal, hiding posts, sending messages, handling reports — is logged with the operator, time, target and the operator\'s IP address.',
          'Fields in a member file (CSV) export: member ID, email address, nickname, preferred language, role and status, virtual chip balance, sign-up date, date of birth, email verification date, privacy consent version and date, restriction reason. Exported files are destroyed without delay once their purpose is fulfilled.',
          'Administrators of the Service\'s infrastructure account (Cloudflare) can technically access the database directly, and that access is not recorded in the admin console\'s audit records. It is used only for incident response and legal obligations.',
        ],
        review:
          'How long audit (access) records are kept, how often they are reviewed, and how direct infrastructure access is controlled will be settled after legal review against Korea\'s standards for securing personal information.',
      },
      {
        heading: '7. Processors and transfers abroad',
        items: [
          'Cloudflare, Inc.: web servers, database and game servers (all information in section 1). Information may be stored and processed in Cloudflare data centers outside Korea, and Cloudflare\'s operational logs may hold request addresses and times for the period Cloudflare sets.',
          'Resend: delivery of service mail such as verification codes and password reset links (email address and message content). Its servers may be outside Korea.',
          'We do not provide your personal information to third parties. If that becomes necessary, we will ask for your separate consent first.',
        ],
        review:
          'The details required for transfers abroad (destination countries, when and how data is transferred, processor contacts, retention periods) and wording for disclosures required by law will be settled after legal review.',
      },
      {
        heading: '8. Your rights and how to use them',
        items: [
          'On My Page you can change your nickname, profile image, language and password, and delete your account at any time.',
          'In friend settings you can choose who may send you friend requests, turn 1:1 message notifications on or off, and block members. 1:1 messages can be exchanged only between friends.',
          'For other requests to access, correct, delete or stop processing your information, use the contact in section 12.',
        ],
        review: 'The contact point and deadline for such requests, and the procedure for requests made through a representative, will be settled after legal review.',
      },
      {
        heading: '9. Data minimization',
        items: [
          'We do not collect real names, phone numbers, postal addresses, payment details or location.',
          'Date of birth is used only to confirm you are 14 or older and for usage statistics by age group.',
          'IP addresses and browser information are used only for sign-in session security, request limits and records of operator actions.',
          'Operators can see 1:1 messages only when they have been reported.',
        ],
        review: 'Whether age checks need the full date of birth (or only the year and month) needs legal review.',
      },
      {
        heading: '10. Security measures',
        items: [
          'Passwords are stored with PBKDF2, and verification codes, password reset links and sign-in session tokens with SHA-256 one-way hashes.',
          'Traffic to the Service is encrypted with HTTPS.',
          'Operator access limits and audit records are as described in section 6.',
        ],
      },
      {
        heading: '11. Cookies and browser storage',
        items: [
          'Cookies are used only to keep you signed in. We use no advertising or analytics cookies and no third-party trackers.',
          'Browser storage holds your language, display and table settings, whether you chose to stay signed in, your chat mute list and Academy progress. Academy progress syncs with your account while you are signed in; the rest stays on your device.',
        ],
      },
      {
        heading: '12. Privacy officer and contact',
        items: ['Privacy officer: not yet appointed', 'Contact: not yet set'],
        review: 'The privacy officer (name, title, contact details) and the contact point have not been decided. They must be set before this policy takes effect.',
      },
      {
        heading: '13. Changes to this policy',
        items: ['We will announce changes in the Service before they take effect. The version and time of the notice you agreed to at sign-up are recorded with your account.'],
        review: 'How far in advance changes are announced, and whether members who agreed to an earlier notice must consent again, will be decided after legal review.',
      },
    ],
    effective: `Draft of ${POLICY_DRAFT_DATE} · The effective date will be set after legal review.`,
  },
};

export const TERMS: Record<'ko' | 'en', PolicyDoc> = {
  ko: {
    title: '이용약관',
    intro: '이 약관은 JC ROYAL(이하 "서비스")을 이용하는 조건과 절차, 서비스와 회원의 권리와 의무를 정합니다.',
    sections: [
      {
        heading: '1. 서비스의 성격',
        items: [
          '서비스는 가상 칩으로 즐기는 웹 텍사스 홀덤 게임, 학습(아카데미), 커뮤니티 기능을 무료로 제공합니다.',
          '가상 칩은 게임 안에서만 쓰는 점수이며 금전적 가치가 없습니다. 현금, 상품, 다른 서비스의 포인트나 재화로 바꾸거나 환전·환불·출금할 수 없습니다.',
          '서비스에는 실제 돈을 거는 기능, 결제 기능, 가상 칩을 사고파는 기능이 없습니다.',
        ],
        review: '게임물 등급 분류가 필요한지와 이용 가능 연령(현재 만 14세 이상)은 법무 검토가 필요합니다.',
      },
      {
        heading: '2. 회원가입과 계정',
        items: [
          '만 14세 이상이면 본인의 이메일 주소로 가입할 수 있습니다.',
          '계정과 비밀번호는 본인이 관리해야 하며, 다른 사람에게 빌려주거나 양도·판매할 수 없습니다.',
          '가입 정보가 사실과 다르거나 다른 사람의 정보를 쓴 경우 이용을 제한할 수 있습니다.',
        ],
        review: '이 약관에 대한 동의를 가입 화면의 필수 체크 항목으로 받을지(현재 가입 화면은 만 14세 확인과 개인정보 수집·이용 동의만 받습니다)는 법무 검토 후 정합니다.',
      },
      {
        heading: '3. 가상 칩',
        items: [
          '서비스는 가입할 때와 운영 정책에 따라 가상 칩을 무상으로 지급할 수 있습니다. 테이블에 가져간 칩은 자리를 떠나면 계정 잔액으로 돌아옵니다.',
          '가상 칩은 게임 밖에서 회원끼리 주고받을 수 없고, 서비스 밖에서 거래해서는 안 됩니다.',
          '오류나 부정행위로 생긴 칩은 회수하거나 조정할 수 있으며, 모든 조정은 기록에 남습니다.',
          '탈퇴하면 남은 칩은 소멸하며 복구할 수 없습니다.',
        ],
      },
      {
        heading: '4. 금지 행위',
        items: [
          '다른 회원과 짜고 치기, 여러 계정 사용, 자동화 프로그램 사용, 오류 악용',
          '욕설·혐오 표현·성희롱·괴롭힘·스팸, 다른 사람의 개인정보 노출',
          '운영자나 다른 회원 사칭, 불법 정보 게시',
          '가상 칩이나 계정의 매매·현금 거래와 그 광고',
          '서비스 운영을 방해하거나 보안을 우회하려는 행위',
        ],
      },
      {
        heading: '5. 커뮤니티와 1:1 대화',
        items: [
          '게시글·댓글의 권리는 작성자에게 있으며, 서비스는 서비스 안에서 보여 주는 데 필요한 범위에서만 씁니다.',
          '1:1 대화는 친구끼리만 주고받을 수 있고, 친구 요청 설정과 차단으로 원하지 않는 연락을 막을 수 있습니다.',
          '신고하면 서버가 신고 대상의 원본을 증거로 복사하고 운영자가 검토합니다. 자세한 내용은 개인정보 처리방침을 따릅니다.',
          '탈퇴해도 게시글·댓글은 "탈퇴한 회원" 이름으로 남습니다. 화면에 남기고 싶지 않다면 탈퇴 전에 직접 삭제해 주세요.',
        ],
      },
      {
        heading: '6. 이용 제한',
        items: ['금지 행위를 하면 게시물 숨김, 이용 정지 등의 조치를 할 수 있으며, 조치와 사유는 기록에 남습니다.', '조치에 이의가 있으면 문의 창구로 알려 주세요.'],
        review: '제재 단계와 기간, 사전 통지, 이의 제기 절차와 처리 기한은 법무 검토 후 확정합니다.',
      },
      {
        heading: '7. 서비스 변경과 중단',
        items: ['서비스 내용은 운영상 필요에 따라 바뀌거나 중단될 수 있으며, 중요한 변경은 미리 서비스 화면에 알립니다.'],
      },
      {
        heading: '8. 탈퇴',
        items: [
          '마이페이지에서 비밀번호를 확인하고 언제든 탈퇴할 수 있습니다.',
          '탈퇴하면 계정과 가상 칩을 복구할 수 없습니다. 삭제되거나 남는 정보는 개인정보 처리방침의 "회원 탈퇴 시 처리"를 따릅니다.',
        ],
      },
      {
        heading: '9. 책임의 제한',
        items: ['서비스는 무료로 제공되며, 가상 칩이 늘거나 줄어도 실제 이익이나 손해가 생기지 않습니다.'],
        review: '서비스 장애, 데이터 손실, 회원 간 분쟁에 대한 책임 범위와 면책 조항은 아직 정하지 않았으며 법무 검토가 필요합니다.',
      },
      {
        heading: '10. 약관 변경과 준거법',
        items: ['약관을 바꾸면 시행 전에 서비스 화면에 알립니다.'],
        review: '변경 사전 고지 기간, 준거법, 관할 법원은 법무 검토 후 정합니다.',
      },
    ],
    effective: `초안 작성일: ${y}년 ${m}월 ${d}일 · 시행일은 법무 검토 후 정합니다.`,
  },
  en: {
    title: 'Terms of Service',
    intro: 'These terms set out the conditions and procedures for using JC ROYAL (the "Service") and the rights and obligations of the Service and its members.',
    sections: [
      {
        heading: '1. What the Service is',
        items: [
          'The Service offers web Texas Hold\'em played with virtual chips, learning (Academy) and community features, free of charge.',
          'Virtual chips are game points with no monetary value. They cannot be converted into cash, goods, or other services\' points or currency, exchanged, refunded or withdrawn.',
          'The Service has no real-money betting, no payments, and no way to buy or sell virtual chips.',
        ],
        review: 'Whether the game needs a rating classification, and the minimum age (currently 14), need legal review.',
      },
      {
        heading: '2. Sign-up and accounts',
        items: [
          'Anyone 14 or older may sign up with their own email address.',
          'You are responsible for your account and password, and may not lend, transfer or sell them.',
          'If sign-up details are false or belong to someone else, we may restrict the account.',
        ],
        review:
          'Whether agreement to these terms should be a required checkbox at sign-up (the sign-up form currently asks only for the age confirmation and consent to the collection and use of personal information) will be decided after legal review.',
      },
      {
        heading: '3. Virtual chips',
        items: [
          'The Service may grant virtual chips free of charge at sign-up and under its operating policy. Chips you bring to a table return to your balance when you leave the seat.',
          'Outside of play, virtual chips cannot be sent between members, and they must not be traded outside the Service.',
          'Chips gained through errors or abuse may be recovered or adjusted, and every adjustment is recorded.',
          'When you delete your account, remaining chips are forfeited and cannot be restored.',
        ],
      },
      {
        heading: '4. Prohibited conduct',
        items: [
          'Colluding with other players, using multiple accounts, using bots, or exploiting bugs',
          'Abuse, hate speech, sexual harassment, bullying or spam, and exposing other people\'s personal information',
          'Impersonating operators or other members, and posting illegal content',
          'Buying, selling or trading virtual chips or accounts for money, or advertising it',
          'Disrupting the Service or trying to get around its security',
        ],
      },
      {
        heading: '5. Community and 1:1 messages',
        items: [
          'You keep the rights to your posts and comments; the Service uses them only as needed to show them within the Service.',
          '1:1 messages can be exchanged only between friends, and friend request settings and blocking let you stop unwanted contact.',
          'When you report something, the server copies the original as evidence and an operator reviews it. Details are in the Privacy Policy.',
          'Your posts and comments remain under the name "Withdrawn member" after you delete your account. If you do not want them shown, delete them yourself first.',
        ],
      },
      {
        heading: '6. Restrictions',
        items: ['If you engage in prohibited conduct we may hide your posts or suspend your account, and the action and its reason are recorded.', 'If you disagree with an action, tell us through the contact point.'],
        review: 'Sanction levels and durations, advance notice, and the objection procedure and its deadline will be settled after legal review.',
      },
      {
        heading: '7. Changes to and suspension of the Service',
        items: ['The Service may change or stop as operations require, and we will announce important changes in the Service in advance.'],
      },
      {
        heading: '8. Deleting your account',
        items: [
          'You can delete your account at any time on My Page after confirming your password.',
          'A deleted account and its virtual chips cannot be restored. What is deleted and what remains is described under "When you delete your account" in the Privacy Policy.',
        ],
      },
      {
        heading: '9. Limitation of liability',
        items: ['The Service is free, and gaining or losing virtual chips involves no real gain or loss.'],
        review: 'Liability for outages, data loss and disputes between members, and any disclaimers, have not been decided and need legal review.',
      },
      {
        heading: '10. Changes to these terms and governing law',
        items: ['We will announce changes to these terms in the Service before they take effect.'],
        review: 'How far in advance changes are announced, the governing law and the competent court will be decided after legal review.',
      },
    ],
    effective: `Draft of ${POLICY_DRAFT_DATE} · The effective date will be set after legal review.`,
  },
};
