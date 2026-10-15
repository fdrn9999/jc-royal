/**
 * System messages sent automatically to a member, in the member's account language.
 * Admin-written messages are sent as typed; admins see each member's language in the console.
 */
type Locale = 'ko' | 'en';
type Notice = { title: string; body: string };
type ReportTarget = 'post' | 'comment' | 'player' | 'dm';
type ReportReason = 'spam' | 'abuse' | 'inappropriate' | 'cheating' | 'other';

/** What was reported, from the reporter's side ("the post you reported") and the reported member's ("your post"). */
const KO_REPORTED = { post: '게시글을', comment: '댓글을', player: '플레이어를', dm: '1:1 메시지를' } as const;
const KO_YOUR = { post: '게시글', comment: '댓글', player: '테이블에서의 행동', dm: '1:1 메시지' } as const;
const KO_REASON = { spam: '스팸·광고', abuse: '욕설·괴롭힘', inappropriate: '부적절한 콘텐츠', cheating: '부정행위', other: '기타' } as const;
const EN_REPORTED = { post: 'post', comment: 'comment', player: 'player', dm: '1:1 message' } as const;
const EN_YOUR = { post: 'post', comment: 'comment', player: 'conduct at a table', dm: '1:1 message' } as const;
const EN_REASON = { spam: 'spam or advertising', abuse: 'abuse or harassment', inappropriate: 'inappropriate content', cheating: 'cheating', other: 'other' } as const;

const n = (v: number) => v.toLocaleString('en-US');

const NOTICES = {
  ko: {
    welcome: (grant: number): Notice => ({
      title: 'JC ROYAL에 오신 것을 환영합니다',
      body: `가입 축하 가상 칩 ${n(grant)}개가 지급되었습니다. 모든 칩은 현금 가치가 없는 플레이 전용 가상 칩입니다.`,
    }),
    suspended: (reason: string): Notice => ({ title: '계정 이용 제한 안내', body: `운영 정책에 따라 계정 이용이 제한되었습니다.\n사유: ${reason}` }),
    unsuspended: (): Notice => ({ title: '계정 이용 제한 해제 안내', body: '계정 이용 제한이 해제되었습니다. 다시 JC ROYAL을 이용하실 수 있습니다.' }),
    chips: (amount: number, memo: string, balance: number): Notice => ({
      title: amount > 0 ? '가상 칩 지급 안내' : '가상 칩 조정 안내',
      body: `${amount > 0 ? '+' : ''}${n(amount)} 가상 칩이 ${amount > 0 ? '지급' : '차감'}되었습니다.\n사유: ${memo}\n현재 잔액: ${n(balance)}`,
    }),
    reconcileReverted: (change: number, balance: number): Notice => ({
      title: '가상 칩 잔액 정정 안내',
      body: `가상 칩 잔액이 거래 기록과 맞지 않아 기록에 맞게 ${change > 0 ? '+' : ''}${n(change)} 정정했습니다.\n현재 잔액: ${n(balance)}`,
    }),
    /** To each member who filed a report, when staff closed it. Never names the reported member or the staff note. */
    reportOutcome: (target: ReportTarget, upheld: boolean): Notice => ({
      title: '신고 처리 결과 안내',
      body: upheld
        ? `회원님이 신고한 ${KO_REPORTED[target]} 검토해 운영 정책에 따라 조치했습니다. 신고해 주셔서 감사합니다.`
        : `회원님이 신고한 ${KO_REPORTED[target]} 검토했지만 운영 정책 위반으로 보지 않았습니다. 신고해 주셔서 감사합니다.`,
    }),
    /** To the reported member, when a report was upheld. Never names who reported it. */
    reportUpheld: (target: ReportTarget, reason: ReportReason, hidden: boolean): Notice => ({
      title: '운영 정책 위반 안내',
      body:
        `회원님의 ${KO_YOUR[target]}에 대한 신고를 검토한 결과 운영 정책 위반(${KO_REASON[reason]})으로 확인되었습니다.` +
        (hidden ? `\n해당 ${KO_YOUR[target]}은 숨김 처리되었습니다.` : ''),
    }),
  },
  en: {
    welcome: (grant: number): Notice => ({
      title: 'Welcome to JC ROYAL',
      body: `You received ${n(grant)} welcome chips. All chips are play-only virtual chips with no cash value.`,
    }),
    suspended: (reason: string): Notice => ({ title: 'Your account has been restricted', body: `Your account has been restricted under our operating policy.\nReason: ${reason}` }),
    unsuspended: (): Notice => ({ title: 'Your account restriction has been lifted', body: 'The restriction on your account has been lifted. You can use JC ROYAL again.' }),
    chips: (amount: number, memo: string, balance: number): Notice => ({
      title: amount > 0 ? 'Virtual chips added' : 'Virtual chips adjusted',
      body: `${amount > 0 ? '+' : ''}${n(amount)} virtual chips were ${amount > 0 ? 'added to' : 'deducted from'} your wallet.\nReason: ${memo}\nBalance: ${n(balance)}`,
    }),
    reconcileReverted: (change: number, balance: number): Notice => ({
      title: 'Virtual chip balance corrected',
      body: `Your virtual chip balance did not match your transaction history, so it was corrected by ${change > 0 ? '+' : ''}${n(change)} to match it.\nBalance: ${n(balance)}`,
    }),
    reportOutcome: (target: ReportTarget, upheld: boolean): Notice => ({
      title: 'Your report has been reviewed',
      body: upheld
        ? `We reviewed the ${EN_REPORTED[target]} you reported and took action under our operating policy. Thank you for reporting it.`
        : `We reviewed the ${EN_REPORTED[target]} you reported and found no breach of our operating policy. Thank you for reporting it.`,
    }),
    reportUpheld: (target: ReportTarget, reason: ReportReason, hidden: boolean): Notice => ({
      title: 'Operating policy notice',
      body:
        `We reviewed a report about your ${EN_YOUR[target]} and found that it breached our operating policy (${EN_REASON[reason]}).` +
        (hidden ? `\nThe ${EN_YOUR[target]} has been hidden.` : ''),
    }),
  },
} as const;

export function notices(locale: Locale | null | undefined) {
  return NOTICES[locale === 'en' ? 'en' : 'ko'];
}
