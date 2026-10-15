/**
 * Display names for the codes the API returns (roles, statuses, ledger types, hand actions, audit actions …), so
 * the Korean console shows Korean words. A value with no name here (a code added later) is shown as it is.
 */
import { handLabelKey } from '@jc/types';
import type { Key } from './i18n';

export type Tr = (key: Key, vars?: Record<string, string | number>) => string;

function labeler(names: Record<string, Key>) {
  const m = new Map(Object.entries(names));
  return (t: Tr, v: string | null | undefined): string => {
    if (!v) return '';
    const k = m.get(v);
    return k ? t(k) : v;
  };
}

export const roleLabel = labeler({ user: 'roleUser', admin: 'roleAdmin', super_admin: 'roleSuperAdmin' });
export const userStatusLabel = labeler({ active: 'userActive', suspended: 'userSuspended', deleted: 'userDeleted' });
export const ledgerTypeLabel = labeler({
  signup_grant: 'ledgerSignupGrant',
  buy_in: 'ledgerBuyIn',
  top_up: 'ledgerTopUp',
  cash_out: 'ledgerCashOut',
  admin_adjust: 'ledgerAdminAdjust',
  reconcile: 'ledgerReconcile',
});
/** The memos the server writes itself (sign-up grant, buy-in seat, top-ups); a memo an admin typed is shown as it is. */
const SYSTEM_MEMOS: Record<string, Key> = { 'welcome chips': 'memoWelcome', 'top-up': 'memoTopUp', 'auto rebuy': 'memoAutoRebuy' };
export function memoLabel(t: Tr, memo: string | null | undefined): string {
  if (!memo) return '';
  const seat = /^seat (\d+)$/.exec(memo);
  if (seat) return t('memoSeat', { n: seat[1]! });
  return Object.hasOwn(SYSTEM_MEMOS, memo) ? t(SYSTEM_MEMOS[memo]!) : memo;
}
export const scopeLabel = labeler({ user_ledger: 'scopeUserLedger', table: 'scopeTable' });
export const contentStatusLabel = labeler({ visible: 'contentVisible', hidden: 'contentHidden', deleted: 'contentDeleted' });
export const categoryLabel = labeler({ system: 'catSystem', event: 'catEvent', sanction: 'catSanction', notice: 'catNotice', admin: 'catAdmin' });
export const academyKindLabel = labeler({ lesson: 'kindLesson', scenario: 'kindScenario', question: 'kindQuestion' });
export const actionLabel = labeler({
  fold: 'actFold',
  check: 'actCheck',
  call: 'actCall',
  bet: 'actBet',
  raise: 'actRaise',
  allin: 'actAllin',
  'post-sb': 'actPostSb',
  'post-bb': 'actPostBb',
  'timeout-fold': 'actTimeoutFold',
  'timeout-check': 'actTimeoutCheck',
});
export const stageLabel = labeler({ preflop: 'stagePreflop', flop: 'stageFlop', turn: 'stageTurn', river: 'stageRiver', showdown: 'stageShowdown', settled: 'stageSettled' });
export const auditActionLabel = labeler({
  'admin.bootstrap': 'auditAdminBootstrap',
  'admin.login': 'auditAdminLogin',
  'admin.login.failed': 'auditAdminLoginFailed',
  'admin.reauth': 'auditAdminReauth',
  'admin.reauth.failed': 'auditAdminReauthFailed',
  'board.comment.status': 'auditCommentStatus',
  'board.notice.create': 'auditNoticeCreate',
  'board.notice.update': 'auditNoticeUpdate',
  'board.post.status': 'auditPostStatus',
  'hand.view_sensitive': 'auditHandView',
  'message.send': 'auditMessageSend',
  'reconcile.resolve': 'auditReconcileResolve',
  'reconcile.run': 'auditReconcileRun',
  'report.view': 'auditReportView',
  'report.resolved': 'auditReportResolved',
  'report.dismissed': 'auditReportDismissed',
  'table.close': 'auditTableClose',
  'table.create': 'auditTableCreate',
  'table.update': 'auditTableUpdate',
  'user.chips': 'auditUserChips',
  'user.export': 'auditUserExport',
  'user.list': 'auditUserList',
  'user.reset_link': 'auditUserResetLink',
  'user.role': 'auditUserRole',
  'user.suspend': 'auditUserSuspend',
  'user.unsuspend': 'auditUserUnsuspend',
  'user.view': 'auditUserView',
});
export const targetTypeLabel = labeler({
  batch: 'targetBatch',
  comment: 'targetComment',
  hand: 'targetHand',
  post: 'targetPost',
  reconciliation: 'targetReconciliation',
  report: 'targetReport',
  table: 'targetTable',
  user: 'targetUser',
});

const HAND_NAMES: Record<string, Key> = {
  'high-card': 'handHighCard',
  pair: 'handPair',
  'two-pair': 'handTwoPair',
  'three-of-a-kind': 'handTrips',
  straight: 'handStraight',
  flush: 'handFlush',
  'full-house': 'handFullHouse',
  'four-of-a-kind': 'handQuads',
  'straight-flush': 'handStraightFlush',
  'royal-flush': 'handRoyalFlush',
};
/** The made hand's name; an ace-high straight flush is a royal flush (the engine has no class for it). */
export function handRankLabel(t: Tr, rankClass: string | null, bestFive: readonly string[] | null): string {
  if (!rankClass) return '';
  const k = HAND_NAMES[handLabelKey(rankClass, bestFive ?? [])];
  return k && rankClass in HAND_NAMES ? t(k) : rankClass;
}
