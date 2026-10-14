/**
 * System messages sent automatically to a member, in the member's account language.
 * Admin-written messages are sent as typed; admins see each member's language in the console.
 */
type Locale = 'ko' | 'en';
type Notice = { title: string; body: string };

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
  },
} as const;

export function notices(locale: Locale | null | undefined) {
  return NOTICES[locale === 'en' ? 'en' : 'ko'];
}
