import { PRIVACY_NOTICE_VERSION } from '@jc/types';

/**
 * Signup privacy notice (개인정보 수집·이용 동의). When the text changes, bump
 * PRIVACY_NOTICE_VERSION in @jc/types so each signup records which text it accepted.
 * Keep it accurate: the "on deletion" and "admin export" sections describe what
 * apps/api actually does (routes/auth.ts /me/delete and /email-verification, routes/admin.ts /users/export).
 */
export interface NoticeSection {
  heading: string;
  items: string[];
}

export interface PrivacyNotice {
  title: string;
  intro: string;
  sections: NoticeSection[];
  effective: string;
}

const [y, m, d] = PRIVACY_NOTICE_VERSION.split('-').map(Number);

export const PRIVACY_NOTICE: Record<'ko' | 'en', PrivacyNotice> = {
  ko: {
    title: '개인정보 수집·이용 동의',
    intro:
      'JC ROYAL(이하 "서비스")은 「개인정보 보호법」에 따라 회원가입과 서비스 제공에 필요한 최소한의 개인정보를 아래와 같이 수집·이용합니다. 내용을 확인하신 뒤 동의 여부를 결정해 주세요.',
    sections: [
      {
        heading: '1. 수집 항목',
        items: [
          '필수: 이메일 주소, 비밀번호(복원할 수 없는 방식으로 암호화해 저장), 닉네임, 생년월일, 이용 언어',
          '이메일 인증 과정에서 생성: 인증번호(암호화해 저장), 인증 일시',
          '서비스 이용 중 자동 생성·수집: 접속 IP 주소, 브라우저·기기 정보(User-Agent), 로그인·접속 기록, 게임 참여와 핸드 기록, 가상 칩 내역, 게시글·댓글, 아카데미 학습 진도',
          '선택: 프로필 이미지 주소(URL)',
        ],
      },
      {
        heading: '2. 수집·이용 목적',
        items: [
          '회원 식별, 가입 의사 확인, 이메일 주소 소유 확인, 계정 보안(부정 로그인·부정 이용 방지)',
          '생년월일: 만 14세 이상 가입 연령 확인, 연령대별 이용 통계',
          '게임 서비스 제공, 가상 칩 지급·정산과 기록 관리',
          '게시판·쪽지 등 커뮤니티 운영, 공지 전달, 문의 응대, 비밀번호 재설정 안내',
          '이용 언어에 맞춘 메일·쪽지 발송',
          '서비스 안정성 확보와 개선을 위한 통계 분석',
        ],
      },
      {
        heading: '3. 관리자 조회와 파일 내보내기',
        items: [
          '서비스 운영자는 위 목적 범위 안에서 관리자 화면으로 회원 정보를 조회하고, 회원 관리·고객 지원·통계·법령상 의무 이행을 위해 회원 정보를 파일(CSV)로 내보내 처리할 수 있습니다.',
          '내보내는 항목: 회원 ID, 이메일 주소, 닉네임, 이용 언어, 회원 등급·상태, 가상 칩 잔액, 가입 일시, 생년월일, 이메일 인증 일시, 개인정보 동의 버전·일시, 이용 제한 사유',
          '내보내기는 비밀번호를 다시 확인한 관리자만 할 수 있고, 내보낼 때마다 기록이 남습니다. 내보낸 파일은 목적을 달성하면 지체 없이 파기합니다.',
        ],
      },
      {
        heading: '4. 처리 위탁과 제3자 제공',
        items: [
          '서비스 운영을 위해 Cloudflare, Inc.(서버·데이터베이스 운영)와 Resend(이메일 발송)에 개인정보 처리를 위탁합니다. 이 업체들의 서버는 국외에 있을 수 있습니다.',
          '서비스는 회원의 개인정보를 제3자에게 제공하지 않습니다. 제공이 필요해지면 사전에 별도 동의를 받습니다.',
        ],
      },
      {
        heading: '5. 보유·이용 기간',
        items: [
          '회원 탈퇴 시까지 보유·이용합니다.',
          '탈퇴하면 이메일 주소, 닉네임, 생년월일, 프로필 이미지, 비밀번호를 즉시 삭제(복구할 수 없게 비식별 처리)하고 로그인 세션을 삭제합니다.',
          '가입을 마치지 않은 이메일 인증 요청 정보(이메일 주소, 인증번호)는 인증번호가 만료된 뒤 1일 안에 삭제합니다.',
          '가상 칩 원장, 게임 기록, 게시글은 게임 무결성과 분쟁 대응을 위해 회원을 알아볼 수 없는 상태로 남을 수 있습니다.',
          '관계 법령에 따라 보존해야 하는 정보는 해당 법령이 정한 기간 동안 보관합니다.',
        ],
      },
      {
        heading: '6. 동의를 거부할 권리',
        items: ['개인정보 수집·이용에 동의하지 않을 수 있습니다. 다만 필수 항목이므로 동의하지 않으면 회원가입을 할 수 없습니다.'],
      },
    ],
    effective: `시행일: ${y}년 ${m}월 ${d}일`,
  },
  en: {
    title: 'Consent to the Collection and Use of Personal Information',
    intro:
      'In accordance with the Personal Information Protection Act of Korea, JC ROYAL (the "Service") collects and uses only the personal information needed to create your account and provide the Service, as described below. Please review it before you decide whether to agree.',
    sections: [
      {
        heading: '1. Information we collect',
        items: [
          'Required: email address, password (stored with one-way encryption), nickname, date of birth, preferred language',
          'Created during email verification: verification code (stored encrypted), verification time',
          'Generated while you use the Service: IP address, browser and device information (User-Agent), sign-in and access records, game participation and hand records, virtual chip history, posts and comments, Academy progress',
          'Optional: profile image address (URL)',
        ],
      },
      {
        heading: '2. Why we use it',
        items: [
          'To identify members, confirm sign-up, confirm that you own the email address, and keep accounts secure (preventing unauthorized sign-ins and abuse)',
          'Date of birth: to confirm you are 14 or older, and for usage statistics by age group',
          'To run the games and to grant, settle and record virtual chips',
          'To run the community (board, messages), send notices, answer inquiries, and send password reset guidance',
          'To send mail and messages in your preferred language',
          'To analyze statistics that keep the Service stable and improve it',
        ],
      },
      {
        heading: '3. Admin access and file export',
        items: [
          'Within the purposes above, Service operators may view member information in the admin console and export it to a file (CSV) for member management, support, statistics and legal compliance.',
          'Exported fields: member ID, email address, nickname, preferred language, role and status, virtual chip balance, sign-up date, date of birth, email verification date, privacy consent version and date, restriction reason',
          'Only an admin who has re-entered their password can export, and every export is logged. Exported files are destroyed without delay once their purpose is fulfilled.',
        ],
      },
      {
        heading: '4. Processors and third parties',
        items: [
          'We entrust processing to Cloudflare, Inc. (servers and database) and Resend (email delivery). Their servers may be located outside Korea.',
          'We do not provide your personal information to third parties. If that becomes necessary, we will ask for your separate consent first.',
        ],
      },
      {
        heading: '5. How long we keep it',
        items: [
          'Until you delete your account.',
          'When you delete your account, your email address, nickname, date of birth, profile image and password are removed immediately (irreversibly de-identified) and your sign-in sessions are deleted.',
          'Email verification requests that never became an account (email address, code) are deleted within one day after the code expires.',
          'Virtual chip ledgers, game records and posts may remain in a form that no longer identifies you, to protect game integrity and resolve disputes.',
          'Information that a law requires us to keep is kept for the period that law sets.',
        ],
      },
      {
        heading: '6. Your right to refuse',
        items: ['You may refuse this consent. Because it is required, however, you cannot create an account without it.'],
      },
    ],
    effective: `Effective ${PRIVACY_NOTICE_VERSION}`,
  },
};
